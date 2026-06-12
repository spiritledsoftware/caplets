import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { defaultStateBaseDir } from "../config/paths";
import type { CodeModeLogEntry, ReadLogsInput, ReadLogsResult } from "./types";

const DEFAULT_LOG_REF_TTL_MS = 60 * 60 * 1000;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;

const SECRET_KEY_VALUE_PATTERN =
  /\b(?:authorization|cookie|set-cookie|password|passphrase|secret|token|api[-_]?key|clientsecret|client_secret|privatekey|private_key|credential|refreshToken|accessToken)\b\s*[:=]\s*([^\s,;]+)/giu;
const BEARER_PATTERN = /\bbearer\s+([a-z0-9._~+/=-]{8,})/giu;
const BASIC_PATTERN = /\bbasic\s+([a-z0-9._~+/=-]{8,})/giu;
const SIGNED_URL_PARAM_PATTERN =
  /([?&](?:access_token|refresh_token|token|code|signature|sig|x-amz-signature)=)[^&\s]+/giu;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/gu;
const CREDIT_CARD_PATTERN = /\b(?:\d[ -]?){13,19}\b/gu;
const PHONE_PATTERN = /\+?\b(?:\d[\s().-]?){10,15}\b/gu;
const HIGH_ENTROPY_PATTERN = /\b[A-Za-z0-9_./+=-]{40,}\b/gu;

type StoredLogsFile = {
  createdAt: string;
  expiresAt: string;
  entries: CodeModeLogEntry[];
};

export type CodeModeLogStoreOptions = {
  stateDir?: string;
  now?: () => Date;
  logRefTtlMs?: number;
};

export type StoreCodeModeLogsResult = {
  logRef: string;
  expiresAt: string;
};

export class CodeModeLogStore {
  private readonly stateDir: string;
  private readonly now: () => Date;
  private readonly logRefTtlMs: number;

  constructor(options: CodeModeLogStoreOptions = {}) {
    this.stateDir = options.stateDir ?? join(defaultStateBaseDir(), "caplets");
    this.now = options.now ?? (() => new Date());
    this.logRefTtlMs = options.logRefTtlMs ?? DEFAULT_LOG_REF_TTL_MS;
  }

  async store(entries: CodeModeLogEntry[]): Promise<StoreCodeModeLogsResult> {
    mkdirSync(this.logsDir(), { recursive: true });
    const logRef = randomBytes(24).toString("hex");
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.logRefTtlMs).toISOString();
    const stored: StoredLogsFile = {
      createdAt: now.toISOString(),
      expiresAt,
      entries: entries.map(redactEntry),
    };
    writeFileSync(this.logPath(logRef), `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    return { logRef, expiresAt };
  }

  async read(input: ReadLogsInput): Promise<ReadLogsResult> {
    if (!/^[a-f0-9]{48}$/u.test(input.logRef)) {
      return { entries: [] };
    }
    const path = this.logPath(input.logRef);
    if (!existsSync(path)) {
      return { entries: [] };
    }
    const parsed = parseStoredLogs(readFileSync(path, "utf8"));
    if (!parsed || new Date(parsed.expiresAt).getTime() <= this.now().getTime()) {
      return { entries: [] };
    }
    const offset = parseCursor(input.cursor);
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_PAGE_LIMIT, 0), MAX_PAGE_LIMIT);
    const entries = parsed.entries.slice(offset, offset + limit).map(redactEntry);
    const nextOffset = offset + entries.length;
    return nextOffset < parsed.entries.length
      ? { entries, nextCursor: String(nextOffset) }
      : { entries };
  }

  private logsDir(): string {
    return join(this.stateDir, "code-mode", "logs");
  }

  private logPath(logRef: string): string {
    return join(this.logsDir(), `${logRef}.json`);
  }
}

export function redactCodeModeLogText(text: string): string {
  return text
    .replace(BEARER_PATTERN, (match, value: string) => match.replace(value, "[REDACTED:token]"))
    .replace(BASIC_PATTERN, (match, value: string) => match.replace(value, "[REDACTED:token]"))
    .replace(SECRET_KEY_VALUE_PATTERN, (match, value: string) =>
      match.replace(value, "[REDACTED:credential]"),
    )
    .replace(SIGNED_URL_PARAM_PATTERN, "$1[REDACTED:token]")
    .replace(EMAIL_PATTERN, "[REDACTED:email]")
    .replace(SSN_PATTERN, "[REDACTED:ssn]")
    .replace(CREDIT_CARD_PATTERN, (match) =>
      match.replace(/\D/gu, "").length >= 13 ? "[REDACTED:credit-card]" : match,
    )
    .replace(PHONE_PATTERN, (match) =>
      match.replace(/\D/gu, "").length >= 10 ? "[REDACTED:phone]" : match,
    )
    .replace(HIGH_ENTROPY_PATTERN, "[REDACTED:credential]");
}

function redactEntry(entry: CodeModeLogEntry): CodeModeLogEntry {
  return { ...entry, message: redactCodeModeLogText(entry.message) };
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseStoredLogs(raw: string): StoredLogsFile | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredLogsFile>;
    if (
      typeof parsed.createdAt !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      !Array.isArray(parsed.entries)
    ) {
      return undefined;
    }
    return {
      createdAt: parsed.createdAt,
      expiresAt: parsed.expiresAt,
      entries: parsed.entries.filter(isLogEntry).map(redactEntry),
    };
  } catch {
    return undefined;
  }
}

function isLogEntry(value: unknown): value is CodeModeLogEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Partial<CodeModeLogEntry>;
  return (
    (entry.level === "log" ||
      entry.level === "info" ||
      entry.level === "warn" ||
      entry.level === "error" ||
      entry.level === "debug") &&
    typeof entry.message === "string" &&
    typeof entry.timestamp === "string"
  );
}
