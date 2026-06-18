import { randomUUID } from "node:crypto";
import {
  QuickJsCodeModeSandbox,
  type CodeModeReplSession,
  type CodeModeSandboxResult,
  type CodeModeSandboxInput,
} from "./sandbox";
import { CodeModeDiagnosticsSession } from "./diagnostics";
import type { CodeModeSessionStatus } from "./types";

export const CODE_MODE_SESSION_COMPATIBILITY_VERSION = 1;
export const DEFAULT_CODE_MODE_SESSION_TTL_MS = 30 * 60 * 1_000;
export const DEFAULT_CODE_MODE_SESSION_LIMIT = 32;

export type CodeModeSessionCompatibility = {
  declarationHash: string;
  platformRuntimeHash: string;
  runtimeScope: string;
  version?: number;
};

export type CodeModeSessionRunInput = CodeModeSandboxInput & {
  sessionId?: string;
  compatibility: CodeModeSessionCompatibility;
  onSuccessfulCell?: (sessionId: string, code: string) => void;
};

export type CodeModeSessionRunResult =
  | {
      ok: true;
      sessionId: string;
      sessionStatus: CodeModeSessionStatus;
      sessionDisposedAfterRun: boolean;
      compatibilityKey: string;
      result: CodeModeSandboxResult;
    }
  | {
      ok: false;
      sessionId: string;
      sessionStatus: null;
      error: "not_found" | "busy" | "closed";
    };

export type CodeModeSessionManagerOptions = {
  idGenerator?: () => string;
  now?: () => number;
  ttlMs?: number;
  maxSessions?: number;
  sandboxFactory?: () => CodeModeReplSessionFactory;
};

export type CodeModeReplSessionFactory = {
  createSession(): Promise<CodeModeReplSession>;
};

type SessionRecord = {
  id: string;
  session: CodeModeReplSession;
  diagnosticsSession: CodeModeDiagnosticsSession;
  compatibilityKey: string;
  lastUsedAt: number;
  busy: boolean;
};

export class CodeModeSessionManager {
  readonly ttlMs: number;
  readonly maxSessions: number;
  #sessions = new Map<string, SessionRecord>();
  #idGenerator: () => string;
  #now: () => number;
  #sandboxFactory: () => CodeModeReplSessionFactory;
  #closed = false;

  constructor(options: CodeModeSessionManagerOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CODE_MODE_SESSION_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_CODE_MODE_SESSION_LIMIT;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#now = options.now ?? Date.now;
    this.#sandboxFactory = options.sandboxFactory ?? (() => new QuickJsCodeModeSandbox());
  }

  async run(input: CodeModeSessionRunInput): Promise<CodeModeSessionRunResult> {
    if (this.#closed) {
      return {
        ok: false,
        sessionId: input.sessionId ?? "",
        sessionStatus: null,
        error: "closed",
      };
    }
    this.#evictExpired();
    const compatibilityKey = compatibilityKeyFor(input.compatibility);
    const requestedSessionId = input.sessionId;
    let record: SessionRecord | undefined;
    let sessionStatus: CodeModeSessionStatus;

    if (requestedSessionId) {
      record = this.#sessions.get(requestedSessionId);
      if (!record) {
        return {
          ok: false,
          sessionId: requestedSessionId,
          sessionStatus: null,
          error: "not_found",
        };
      }
      if (record.busy) {
        return {
          ok: false,
          sessionId: requestedSessionId,
          sessionStatus: null,
          error: "busy",
        };
      }
      if (record.compatibilityKey !== compatibilityKey) {
        this.#disposeRecord(record.id);
        return {
          ok: false,
          sessionId: requestedSessionId,
          sessionStatus: null,
          error: "not_found",
        };
      } else {
        sessionStatus = "reused";
      }
    } else {
      const sessionId = this.#nextSessionId();
      record = await this.#createRecord(sessionId, compatibilityKey);
      if (!record) return this.#closedResult(sessionId);
      sessionStatus = "created";
    }

    this.#evictToLimit(record.id);
    record.busy = true;
    try {
      const result = await record.session.run({
        ...input,
        invoke: async (invokeInput) => {
          if (this.#closed) {
            throw new Error("Code Mode session manager is closed.");
          }
          return await input.invoke(invokeInput);
        },
      });
      record.lastUsedAt = this.#now();
      const sessionDisposedAfterRun = record.session.isDisposed();
      if (sessionDisposedAfterRun) {
        this.#sessions.delete(record.id);
      } else if (result.ok) {
        input.onSuccessfulCell?.(record.id, input.code);
      }
      return {
        ok: true,
        sessionId: record.id,
        sessionStatus,
        sessionDisposedAfterRun,
        compatibilityKey: record.compatibilityKey,
        result,
      };
    } finally {
      record.busy = false;
      this.#evictToLimit(record.id);
    }
  }

  close(): void {
    this.#closed = true;
    for (const record of this.#sessions.values()) {
      record.session.dispose();
    }
    this.#sessions.clear();
  }

  has(sessionId: string): boolean {
    this.#evictExpired();
    return this.#sessions.has(sessionId);
  }

  compatibilityKey(sessionId: string): string | undefined {
    this.#evictExpired();
    return this.#sessions.get(sessionId)?.compatibilityKey;
  }

  diagnosticsSession(
    sessionId: string,
    compatibility: CodeModeSessionCompatibility,
  ): CodeModeDiagnosticsSession | undefined {
    this.#evictExpired();
    const record = this.#sessions.get(sessionId);
    if (!record) return undefined;
    const compatibilityKey = compatibilityKeyFor(compatibility);
    if (record.compatibilityKey !== compatibilityKey) {
      this.#disposeRecord(sessionId);
      return undefined;
    }
    return record.diagnosticsSession;
  }

  isBusy(sessionId: string, compatibility: CodeModeSessionCompatibility): boolean {
    this.#evictExpired();
    const record = this.#sessions.get(sessionId);
    if (!record) return false;
    const compatibilityKey = compatibilityKeyFor(compatibility);
    if (record.compatibilityKey !== compatibilityKey) return false;
    return record.busy;
  }

  recordSuccessfulCell(sessionId: string, code: string, declaration = ""): void {
    this.#sessions.get(sessionId)?.diagnosticsSession.recordSuccessfulCell(code, declaration);
  }

  async #createRecord(id: string, compatibilityKey: string): Promise<SessionRecord | undefined> {
    if (this.#closed) {
      return undefined;
    }
    const session = await this.#sandboxFactory().createSession();
    if (this.#closed) {
      session.dispose();
      return undefined;
    }
    const record: SessionRecord = {
      id,
      session,
      diagnosticsSession: new CodeModeDiagnosticsSession(),
      compatibilityKey,
      lastUsedAt: this.#now(),
      busy: false,
    };
    this.#sessions.set(id, record);
    return record;
  }

  #nextSessionId(): string {
    let id = this.#idGenerator();
    while (this.#sessions.has(id)) {
      id = this.#idGenerator();
    }
    return id;
  }

  #evictExpired(): void {
    const now = this.#now();
    for (const record of this.#sessions.values()) {
      if (!record.busy && now - record.lastUsedAt > this.ttlMs) {
        this.#disposeRecord(record.id);
      }
    }
  }

  #evictToLimit(protectedId: string): void {
    while (this.#sessions.size > this.maxSessions) {
      const candidate = [...this.#sessions.values()]
        .filter((record) => !record.busy && record.id !== protectedId)
        .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
      if (!candidate) return;
      this.#disposeRecord(candidate.id);
    }
  }

  #disposeRecord(id: string): void {
    const record = this.#sessions.get(id);
    if (!record) return;
    record.session.dispose();
    this.#sessions.delete(id);
  }

  #closedResult(sessionId: string): CodeModeSessionRunResult {
    return {
      ok: false,
      sessionId,
      sessionStatus: null,
      error: "closed",
    };
  }
}

function compatibilityKeyFor(input: CodeModeSessionCompatibility): string {
  return JSON.stringify({
    declarationHash: input.declarationHash,
    platformRuntimeHash: input.platformRuntimeHash,
    runtimeScope: input.runtimeScope,
    version: input.version ?? CODE_MODE_SESSION_COMPATIBILITY_VERSION,
  });
}
