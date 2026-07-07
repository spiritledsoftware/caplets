import { Buffer } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CapletsError } from "../errors";
import type { RemoteServerCredentialStore } from "../remote/server-credential-store";
import {
  DASHBOARD_SESSION_COOKIE,
  type DashboardSessionRecord,
  type DashboardSessionView,
} from "./types";

export type DashboardSessionStoreOptions = {
  dir: string;
};

type DashboardSessionState = {
  version: 1;
  sessions: DashboardSessionRecord[];
};

const STATE_FILE = "dashboard-sessions.json";
const LOCK_DIR = "dashboard-sessions.lock";
const LOCK_TIMEOUT_MS = 100;
const LOCK_STALE_MS = 30_000;
const ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60_000;
const IDLE_TIMEOUT_MS = 60 * 60_000;

export class DashboardSessionStore {
  readonly dir: string;

  constructor(options: DashboardSessionStoreOptions) {
    this.dir = options.dir;
  }

  create(input: { operatorClientId: string; now?: Date | undefined }): {
    cookieValue: string;
    session: DashboardSessionView;
  } {
    return this.withStateLock(() => {
      const now = input.now ?? new Date();
      const secret = `dash_secret_${randomToken(32)}`;
      const session: DashboardSessionRecord = {
        sessionId: `dash_${randomToken(12)}`,
        secretHash: hashSecret(secret),
        operatorClientId: input.operatorClientId,
        role: "operator",
        csrfToken: `csrf_${randomToken(32)}`,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ABSOLUTE_TIMEOUT_MS).toISOString(),
        lastUsedAt: now.toISOString(),
      };
      const state = this.loadState();
      cleanupSessions(state, now);
      state.sessions.push(session);
      this.saveState(state);
      return { cookieValue: `${session.sessionId}.${secret}`, session: sessionView(session) };
    });
  }

  validate(input: {
    cookieHeader?: string | undefined;
    credentialStore: RemoteServerCredentialStore;
    csrfToken?: string | undefined;
    requireCsrf?: boolean | undefined;
    now?: Date | undefined;
  }): DashboardSessionView {
    return this.withStateLock(() => {
      const now = input.now ?? new Date();
      const state = this.loadState();
      cleanupSessions(state, now);
      const parsed = parseDashboardCookie(input.cookieHeader);
      if (!parsed) {
        this.saveState(state);
        throw new CapletsError("AUTH_FAILED", "Dashboard session is required.");
      }
      const session = state.sessions.find((candidate) => candidate.sessionId === parsed.sessionId);
      if (!session || !safeHashEqual(hashSecret(parsed.secret), session.secretHash)) {
        this.saveState(state);
        throw new CapletsError("AUTH_FAILED", "Dashboard session is invalid.");
      }
      const expired = Date.parse(session.expiresAt) <= now.getTime();
      const idleExpired = now.getTime() - Date.parse(session.lastUsedAt) > IDLE_TIMEOUT_MS;
      if (expired || idleExpired) {
        state.sessions = state.sessions.filter(
          (candidate) => candidate.sessionId !== session.sessionId,
        );
        this.saveState(state);
        throw new CapletsError("AUTH_FAILED", "Dashboard session has expired.");
      }
      const operator = input.credentialStore
        .listClients()
        .find((client) => client.clientId === session.operatorClientId);
      if (!operator || operator.revokedAt || operator.role !== "operator") {
        state.sessions = state.sessions.filter(
          (candidate) => candidate.sessionId !== session.sessionId,
        );
        this.saveState(state);
        throw new CapletsError("AUTH_FAILED", "Dashboard operator client is no longer authorized.");
      }
      if (input.requireCsrf && input.csrfToken !== session.csrfToken) {
        this.saveState(state);
        throw new CapletsError("REQUEST_INVALID", "Dashboard CSRF token is invalid.");
      }
      session.lastUsedAt = now.toISOString();
      this.saveState(state);
      return sessionView(session);
    });
  }

  delete(cookieHeader?: string | undefined): boolean {
    return this.withStateLock(() => {
      const parsed = parseDashboardCookie(cookieHeader);
      if (!parsed) return false;
      const state = this.loadState();
      const before = state.sessions.length;
      state.sessions = state.sessions.filter((session) => session.sessionId !== parsed.sessionId);
      this.saveState(state);
      return state.sessions.length !== before;
    });
  }

  private loadState(): DashboardSessionState {
    const path = this.statePath();
    if (!existsSync(path)) return { version: 1, sessions: [] };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DashboardSessionState>;
    return {
      version: 1,
      sessions: (parsed.sessions ?? []).flatMap((session) => parseSessionRecord(session)),
    };
  }

  private saveState(state: DashboardSessionState): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
    const path = this.statePath();
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(tempPath, 0o600);
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
    renameSync(tempPath, path);
  }

  private statePath(): string {
    return join(this.dir, STATE_FILE);
  }

  private lockPath(): string {
    return join(this.dir, LOCK_DIR);
  }

  private withStateLock<T>(operation: () => T): T {
    this.acquireLock();
    try {
      return operation();
    } finally {
      this.releaseLock();
    }
  }

  private acquireLock(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const started = Date.now();
    while (true) {
      try {
        mkdirSync(this.lockPath(), { mode: 0o700 });
        return;
      } catch (error) {
        if (isFileExistsError(error) && this.clearStaleLock()) continue;
        if (!isFileExistsError(error) || Date.now() - started >= LOCK_TIMEOUT_MS) {
          throw new CapletsError("SERVER_UNAVAILABLE", "Dashboard session state is locked.");
        }
        sleepSync(10);
      }
    }
  }

  private releaseLock(): void {
    rmSync(this.lockPath(), { recursive: true, force: true });
  }

  private clearStaleLock(): boolean {
    try {
      if (Date.now() - statSync(this.lockPath()).mtimeMs < LOCK_STALE_MS) return false;
      rmSync(this.lockPath(), { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

function parseSessionRecord(value: unknown): DashboardSessionRecord[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Partial<DashboardSessionRecord>;
  if (
    typeof record.sessionId !== "string" ||
    typeof record.secretHash !== "string" ||
    typeof record.operatorClientId !== "string" ||
    typeof record.csrfToken !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.expiresAt !== "string" ||
    typeof record.lastUsedAt !== "string"
  ) {
    return [];
  }
  return [
    {
      sessionId: record.sessionId,
      secretHash: record.secretHash,
      operatorClientId: record.operatorClientId,
      role: "operator",
      csrfToken: record.csrfToken,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      lastUsedAt: record.lastUsedAt,
    },
  ];
}

function cleanupSessions(state: DashboardSessionState, now: Date): void {
  state.sessions = state.sessions.filter((session) => {
    if (Date.parse(session.expiresAt) <= now.getTime()) return false;
    return now.getTime() - Date.parse(session.lastUsedAt) <= IDLE_TIMEOUT_MS;
  });
}

function sessionView(session: DashboardSessionRecord): DashboardSessionView {
  return {
    sessionId: session.sessionId,
    operatorClientId: session.operatorClientId,
    role: "operator",
    csrfToken: session.csrfToken,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    lastUsedAt: session.lastUsedAt,
  };
}

export function parseDashboardCookie(
  cookieHeader: string | undefined,
): { sessionId: string; secret: string } | undefined {
  const value = (cookieHeader ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${DASHBOARD_SESSION_COOKIE}=`))
    ?.slice(DASHBOARD_SESSION_COOKIE.length + 1);
  if (!value) return undefined;
  const [sessionId, secret] = value.split(".", 2);
  if (!sessionId || !secret) return undefined;
  return { sessionId, secret };
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isFileExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "EEXIST";
}
