import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { defaultStateBaseDir } from "../config/paths";
import type { CodeModeDiagnostic } from "./types";
import { redactCodeModeLogText } from "./logs";

const DEFAULT_JOURNAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 100;
const DEFAULT_MAX_CODE_BYTES = 64 * 1024;
const DEFAULT_MAX_SUMMARY_BYTES = 16 * 1024;
const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 100;
const JOURNAL_VERSION = 1;

export type CodeModeRecoveryClassification = "setup_like" | "side_effecting" | "unknown";

export type CodeModeJournalOutcome = { ok: true } | { ok: false; code: string; message: string };

export type CodeModeJournalEntry = {
  timestamp: string;
  code: string;
  declarationHash: string;
  outcome: CodeModeJournalOutcome;
  diagnostics: Array<Pick<CodeModeDiagnostic, "code" | "severity" | "message">>;
  recoveryClassification: CodeModeRecoveryClassification;
  logsStored?: boolean;
  summary?: string;
};

export type StoreCodeModeJournalEntryInput = {
  sessionId: string;
  journalScope?: string;
  code: string;
  declarationHash: string;
  outcome: CodeModeJournalOutcome;
  diagnostics: CodeModeDiagnostic[];
  recoveryClassification: CodeModeRecoveryClassification;
  logRef?: string;
  summary?: string;
};

export type StoreCodeModeJournalEntryResult = {
  recoveryRef: string;
  expiresAt: string;
  journalKey: string;
};

export type ReadCodeModeRecoveryInput = {
  recoveryRef: string;
  cursor?: string;
  limit?: number;
};

export type ReadCodeModeRecoveryResult = {
  entries: CodeModeJournalEntry[];
  nextCursor?: string;
};

export type CodeModeJournalLookupResult = {
  expiresAt: string;
  recoveryRef?: string;
};

export type CodeModeJournalStoreOptions = {
  stateDir?: string;
  now?: () => Date;
  retentionMs?: number;
  maxEntries?: number;
  maxCodeBytes?: number;
  maxSummaryBytes?: number;
  secret?: string;
};

type StoredJournalFile = {
  version: typeof JOURNAL_VERSION;
  journalKey: string;
  sessionIdHash?: string;
  recoveryRefHashes: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  entries: CodeModeJournalEntry[];
};

export class CodeModeJournalStore {
  private readonly stateDir: string;
  private readonly now: () => Date;
  private readonly retentionMs: number;
  private readonly maxEntries: number;
  private readonly maxCodeBytes: number;
  private readonly maxSummaryBytes: number;
  private readonly configuredSecret: string | undefined;
  private secret: string | undefined;
  private recoveryRefs = new Map<string, string>();
  private sessionRecoveryRefs = new Map<string, { recoveryRef: string; expiresAt: string }>();

  constructor(options: CodeModeJournalStoreOptions = {}) {
    this.stateDir = options.stateDir ?? join(defaultStateBaseDir(), "caplets");
    this.now = options.now ?? (() => new Date());
    this.retentionMs = options.retentionMs ?? DEFAULT_JOURNAL_RETENTION_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxCodeBytes = options.maxCodeBytes ?? DEFAULT_MAX_CODE_BYTES;
    this.maxSummaryBytes = options.maxSummaryBytes ?? DEFAULT_MAX_SUMMARY_BYTES;
    this.configuredSecret = options.secret;
  }

  async store(input: StoreCodeModeJournalEntryInput): Promise<StoreCodeModeJournalEntryResult> {
    this.ensureJournalDir();
    this.pruneExpired();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.retentionMs).toISOString();
    const journalKey = this.journalKey(input.sessionId, input.journalScope);
    const recoveryRef =
      this.recoveryRefs.get(journalKey) ?? this.recoveryRefForJournalKey(journalKey);
    this.recoveryRefs.set(journalKey, recoveryRef);
    this.sessionRecoveryRefs.set(input.sessionId, { recoveryRef, expiresAt });
    const recoveryRefHash = this.recoveryRefHash(recoveryRef);
    const path = this.journalPath(journalKey);
    const existing = this.readJournalPath(path);
    const entry = this.entryFromInput(input, now, recoveryRef);
    const stored: StoredJournalFile = {
      version: JOURNAL_VERSION,
      journalKey,
      sessionIdHash: this.sessionIdHash(input.sessionId),
      recoveryRefHashes: [...new Set([...(existing?.recoveryRefHashes ?? []), recoveryRefHash])],
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt,
      entries: [...(existing?.entries ?? []), entry].slice(-this.maxEntries),
    };
    this.writeJournal(path, stored);
    return { recoveryRef, expiresAt, journalKey };
  }

  async lookupSession(sessionId: string): Promise<CodeModeJournalLookupResult | undefined> {
    this.ensureJournalDir();
    this.pruneExpired();
    const retained = this.sessionRecoveryRefs.get(sessionId);
    if (retained && new Date(retained.expiresAt).getTime() > this.now().getTime()) {
      return retained;
    }
    const scopedJournal = this.findBySessionIdHash(this.sessionIdHash(sessionId));
    if (scopedJournal && !this.isExpired(scopedJournal)) {
      return {
        expiresAt: scopedJournal.expiresAt,
        recoveryRef: this.recoveryRefForJournalKey(scopedJournal.journalKey),
      };
    }
    const journal = this.readJournalPath(this.journalPath(this.journalKey(sessionId)));
    if (!journal || this.isExpired(journal)) return undefined;
    return {
      expiresAt: journal.expiresAt,
    };
  }

  async lookupRecoveryRef(recoveryRef: string): Promise<CodeModeJournalLookupResult | undefined> {
    if (!isRecoveryRef(recoveryRef)) return undefined;
    this.ensureJournalDir();
    this.pruneExpired();
    const journal = this.findByRecoveryRefHash(this.recoveryRefHash(recoveryRef));
    if (!journal || this.isExpired(journal)) return undefined;
    return { expiresAt: journal.expiresAt };
  }

  async readRecovery(input: ReadCodeModeRecoveryInput): Promise<ReadCodeModeRecoveryResult> {
    if (!isRecoveryRef(input.recoveryRef)) {
      return { entries: [] };
    }
    this.ensureJournalDir();
    this.pruneExpired();
    const recoveryRefHash = this.recoveryRefHash(input.recoveryRef);
    const journal = this.findByRecoveryRefHash(recoveryRefHash);
    if (!journal || this.isExpired(journal)) return { entries: [] };
    const offset = parseCursor(input.cursor);
    if (input.limit !== undefined && input.limit <= 0) {
      return { entries: [] };
    }
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_PAGE_LIMIT, 0), MAX_PAGE_LIMIT);
    const entries = journal.entries.slice(offset, offset + limit);
    const nextOffset = offset + entries.length;
    return nextOffset < journal.entries.length
      ? { entries, nextCursor: String(nextOffset) }
      : { entries };
  }

  private entryFromInput(
    input: StoreCodeModeJournalEntryInput,
    now: Date,
    recoveryRef: string,
  ): CodeModeJournalEntry {
    const exactSecrets = [input.sessionId, recoveryRef, input.logRef].filter(
      (value): value is string => Boolean(value),
    );
    return {
      timestamp: now.toISOString(),
      code: truncateUtf8(redactJournalText(input.code, exactSecrets), this.maxCodeBytes),
      declarationHash: input.declarationHash,
      outcome:
        input.outcome.ok === true
          ? { ok: true }
          : {
              ok: false,
              code: input.outcome.code,
              message: truncateUtf8(redactJournalText(input.outcome.message, exactSecrets), 2_000),
            },
      diagnostics: input.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        severity: diagnostic.severity,
        message: truncateUtf8(redactJournalText(diagnostic.message, exactSecrets), 2_000),
      })),
      recoveryClassification: input.recoveryClassification,
      ...(input.logRef ? { logsStored: true } : {}),
      ...(input.summary
        ? {
            summary: truncateUtf8(
              redactJournalText(input.summary, exactSecrets),
              this.maxSummaryBytes,
            ),
          }
        : {}),
    };
  }

  private findByRecoveryRefHash(recoveryRefHash: string): StoredJournalFile | undefined {
    for (const filename of readdirSync(this.journalDir())) {
      if (!filename.endsWith(".json")) continue;
      const journal = this.readJournalPath(join(this.journalDir(), filename));
      if (journal?.recoveryRefHashes.includes(recoveryRefHash)) return journal;
    }
    return undefined;
  }

  private findBySessionIdHash(sessionIdHash: string): StoredJournalFile | undefined {
    const journals: StoredJournalFile[] = [];
    for (const filename of readdirSync(this.journalDir())) {
      if (!filename.endsWith(".json")) continue;
      const journal = this.readJournalPath(join(this.journalDir(), filename));
      if (journal?.sessionIdHash === sessionIdHash) journals.push(journal);
    }
    return journals.sort(
      (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    )[0];
  }

  private readJournalPath(path: string): StoredJournalFile | undefined {
    try {
      rejectSymlinkPathComponents(this.journalDir(), path, true);
      if (!existsSync(path)) return undefined;
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredJournalFile>;
      if (
        parsed.version !== JOURNAL_VERSION ||
        typeof parsed.journalKey !== "string" ||
        !Array.isArray(parsed.recoveryRefHashes) ||
        typeof parsed.createdAt !== "string" ||
        typeof parsed.updatedAt !== "string" ||
        typeof parsed.expiresAt !== "string" ||
        !Array.isArray(parsed.entries)
      ) {
        return undefined;
      }
      return {
        version: JOURNAL_VERSION,
        journalKey: parsed.journalKey,
        ...(typeof parsed.sessionIdHash === "string"
          ? { sessionIdHash: parsed.sessionIdHash }
          : {}),
        recoveryRefHashes: parsed.recoveryRefHashes.filter(
          (hash): hash is string => typeof hash === "string",
        ),
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        expiresAt: parsed.expiresAt,
        entries: parsed.entries.filter(isJournalEntry),
      };
    } catch {
      return undefined;
    }
  }

  private writeJournal(path: string, journal: StoredJournalFile): void {
    rejectSymlinkPathComponents(this.journalDir(), path, true);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    const tempPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
  }

  private pruneExpired(): void {
    const dir = this.journalDir();
    if (!existsSync(dir)) return;
    for (const filename of readdirSync(dir)) {
      if (!filename.endsWith(".json")) continue;
      const path = join(dir, filename);
      const journal = this.readJournalPath(path);
      if (!journal || this.isExpired(journal)) {
        rmSync(path, { force: true });
      }
    }
  }

  private isExpired(journal: StoredJournalFile): boolean {
    return new Date(journal.expiresAt).getTime() <= this.now().getTime();
  }

  private journalKey(sessionId: string, journalScope = "default"): string {
    return this.hmac(`journal:${sessionId}:${journalScope}`);
  }

  private recoveryRefHash(recoveryRef: string): string {
    return this.hmac(`recovery-ref:${recoveryRef}`);
  }

  private recoveryRefForJournalKey(journalKey: string): string {
    return this.hmac(`recovery-ref-material:${journalKey}`).slice(0, 48);
  }

  private sessionIdHash(sessionId: string): string {
    return this.hmac(`session-id:${sessionId}`);
  }

  private hmac(value: string): string {
    return createHmac("sha256", this.loadSecret()).update(value).digest("hex");
  }

  private loadSecret(): string {
    if (this.configuredSecret) return this.configuredSecret;
    if (this.secret) return this.secret;
    this.ensureJournalDir();
    const path = this.secretPath();
    rejectSymlinkPathComponents(this.journalDir(), path, true);
    if (existsSync(path)) {
      this.secret = readFileSync(path, "utf8").trim();
      return this.secret;
    }
    this.secret = randomBytes(32).toString("hex");
    writeFileSync(path, `${this.secret}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return this.secret;
  }

  private ensureJournalDir(): void {
    const dir = this.journalDir();
    rejectSymlinkRoot(resolve(this.stateDir));
    rejectSymlinkPathComponents(resolve(this.stateDir), dir, true);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    rejectSymlinkPathComponents(resolve(this.stateDir), dir, true);
    chmodSync(dir, 0o700);
  }

  private journalDir(): string {
    return join(this.stateDir, "code-mode", "journal");
  }

  private journalPath(journalKey: string): string {
    return join(this.journalDir(), `${journalKey}.json`);
  }

  private secretPath(): string {
    return join(this.journalDir(), "secret.key");
  }
}

export function classifyCodeModeRecovery(input: {
  code: string;
  invokedCaplet: boolean;
  sessionDisposedAfterRun?: boolean;
}): CodeModeRecoveryClassification {
  if (input.invokedCaplet) return "side_effecting";
  if (input.sessionDisposedAfterRun) return "unknown";
  return /\b(?:function|var|let|const|class)\b/u.test(input.code) ? "setup_like" : "unknown";
}

function isRecoveryRef(value: string): boolean {
  return /^[a-f0-9]{48}$/u.test(value);
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let output = "";
  for (const char of value) {
    const next = Buffer.byteLength(char, "utf8");
    if (bytes + next > maxBytes) break;
    output += char;
    bytes += next;
  }
  return output;
}

function redactJournalText(text: string, exactSecrets: string[]): string {
  let redacted = redactCodeModeLogText(text);
  for (const secret of exactSecrets) {
    if (!secret) continue;
    redacted = redacted.replaceAll(secret, "[REDACTED:capability]");
  }
  return redacted.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu,
    "[REDACTED:capability]",
  );
}

function isJournalEntry(value: unknown): value is CodeModeJournalEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<CodeModeJournalEntry>;
  return (
    typeof entry.timestamp === "string" &&
    typeof entry.code === "string" &&
    typeof entry.declarationHash === "string" &&
    isJournalOutcome(entry.outcome) &&
    Array.isArray(entry.diagnostics) &&
    entry.diagnostics.every(isJournalDiagnostic) &&
    (entry.recoveryClassification === "setup_like" ||
      entry.recoveryClassification === "side_effecting" ||
      entry.recoveryClassification === "unknown") &&
    (entry.logsStored === undefined || typeof entry.logsStored === "boolean") &&
    (entry.summary === undefined || typeof entry.summary === "string")
  );
}

function isJournalOutcome(value: unknown): value is CodeModeJournalOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const outcome = value as Partial<CodeModeJournalOutcome>;
  return outcome.ok === true || (outcome.ok === false && typeof outcome.code === "string");
}

function isJournalDiagnostic(
  value: unknown,
): value is Pick<CodeModeDiagnostic, "code" | "severity" | "message"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const diagnostic = value as Partial<CodeModeDiagnostic>;
  return (
    typeof diagnostic.code === "string" &&
    typeof diagnostic.message === "string" &&
    (diagnostic.severity === "error" ||
      diagnostic.severity === "warning" ||
      diagnostic.severity === "info")
  );
}

function rejectSymlinkPathComponents(
  rootDir: string,
  target: string,
  includeTarget: boolean,
): void {
  const resolvedRoot = resolve(rootDir);
  rejectSymlinkRoot(resolvedRoot);
  const rel = relative(resolvedRoot, resolve(target));
  if (rel.startsWith("..") || rel === "") return;
  const parts = rel.split(/[\\/]+/u).filter(Boolean);
  let current = resolvedRoot;
  const limit = includeTarget ? parts.length : Math.max(0, parts.length - 1);
  for (let index = 0; index < limit; index += 1) {
    current = resolve(current, parts[index]!);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error("Code Mode journal path must not contain symlinks.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function rejectSymlinkRoot(rootDir: string): void {
  try {
    if (lstatSync(rootDir).isSymbolicLink()) {
      throw new Error("Code Mode journal root must not be a symlink.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
