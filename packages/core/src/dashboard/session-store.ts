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
import {
  AuthorityDomainCodec,
  hashAuthoritySecret,
  safeAuthorityHashEqual,
  type AuthorityDomainCodecOptions,
} from "../remote/authority-codec";
import type { AuthorityGenerationIdentity } from "../storage/types";
import type { VaultEncryptedRecord } from "../vault/crypto";
import { createDashboardActivityEntry, type DashboardActivityEntry } from "./activity-log";
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
/** Hard upper bound for active dashboard sessions retained in an authority snapshot. */
export const MAX_DASHBOARD_SESSIONS = 128;
/** Persist dashboard last-used timestamps at most once per bounded window. */
export const DASHBOARD_SESSION_TOUCH_THROTTLE_MS = 60_000;

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
      if (state.sessions.length >= MAX_DASHBOARD_SESSIONS) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "Dashboard session capacity has been reached.",
          { limit: MAX_DASHBOARD_SESSIONS },
        );
      }
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

  revokeClient(clientId: string): number {
    return this.withStateLock(() => {
      const state = this.loadState();
      const before = state.sessions.length;
      state.sessions = state.sessions.filter((session) => session.operatorClientId !== clientId);
      if (state.sessions.length !== before) this.saveState(state);
      return before - state.sessions.length;
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

type AuthorityDashboardSessionRecord = {
  sessionId: string;
  secretHash: string;
  operatorClientId: string;
  role: "operator";
  csrfTokenEncrypted: VaultEncryptedRecord;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
};

type AuthorityDashboardSessionState = {
  version: 1;
  sessions: AuthorityDashboardSessionRecord[];
};

export type AuthorityDashboardSessionStoreOptions = AuthorityDomainCodecOptions;

type AuthoritySessionMutationOptions = {
  idempotencyKey?: string | undefined;
  principalId?: string | undefined;
};

export class AuthorityDashboardSessionStore {
  private readonly codec: AuthorityDomainCodec;

  constructor(options: AuthorityDashboardSessionStoreOptions) {
    this.codec = new AuthorityDomainCodec(options);
  }

  async create(
    input: { operatorClientId: string; now?: Date | undefined } & AuthoritySessionMutationOptions,
  ): Promise<{ cookieValue: string; session: DashboardSessionView }> {
    const now = input.now ?? new Date();
    const read = await this.codec.read();
    const root: Record<string, unknown> = { ...read.snapshot };
    assertAuthorityOperator(root, input.operatorClientId);
    const state = parseAuthorityDashboardSessionState(root.dashboardSessions);
    const prunedSessionIds: string[] = [];
    state.sessions = (
      await Promise.all(
        state.sessions.map(async (candidate) => {
          const auxiliary = await this.codec.readAuxiliary({
            kind: "session_touch",
            sessionId: candidate.sessionId,
          });
          const touch = parseAuthoritySessionTouch(auxiliary);
          const lastUsedAt = touch?.lastUsedAt ?? candidate.lastUsedAt;
          const expired = Date.parse(candidate.expiresAt) <= now.getTime();
          const idleExpired = now.getTime() - Date.parse(lastUsedAt) > IDLE_TIMEOUT_MS;
          if (touch?.revoked === true || expired || idleExpired) {
            prunedSessionIds.push(candidate.sessionId);
            return undefined;
          }
          return candidate;
        }),
      )
    ).filter((candidate): candidate is AuthorityDashboardSessionRecord => candidate !== undefined);
    if (state.sessions.length >= MAX_DASHBOARD_SESSIONS) {
      throw new CapletsError("SERVER_UNAVAILABLE", "Dashboard session capacity has been reached.", {
        limit: MAX_DASHBOARD_SESSIONS,
      });
    }
    const secret = `dash_secret_${randomToken(32)}`;
    const csrfToken = `csrf_${randomToken(32)}`;
    const record: AuthorityDashboardSessionRecord = {
      sessionId: `dash_${randomToken(12)}`,
      secretHash: hashAuthoritySecret(secret),
      operatorClientId: input.operatorClientId,
      role: "operator",
      csrfTokenEncrypted: this.codec.encrypt(csrfToken, now),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ABSOLUTE_TIMEOUT_MS).toISOString(),
      lastUsedAt: now.toISOString(),
    };
    state.sessions.push(record);
    const view = authoritySessionView(record, csrfToken);
    const activity = createDashboardActivityEntry({
      actorClientId: input.operatorClientId,
      action: "dashboard_login_completed",
      target: { type: "dashboard_session", id: record.sessionId },
      now,
    });
    root.dashboardSessions = state;
    root.dashboardActivity = appendAuthorityActivity(root.dashboardActivity, activity);
    const committed = await this.codec.commit({
      read,
      domain: "dashboardSessions",
      command: { kind: "create_dashboard_session" },
      snapshot: root,
      result: { cookieValue: `${record.sessionId}.${secret}`, session: view },
      payload: { operatorClientId: input.operatorClientId },
      idempotencyKey: input.idempotencyKey,
      principalId: input.principalId,
      now,
    });
    await Promise.all(prunedSessionIds.map((sessionId) => this.removeTouch(sessionId)));
    await this.seedTouch(record.sessionId, record.lastUsedAt, committed.generation);
    return committed.result;
  }

  async validate(input: {
    cookieHeader?: string | undefined;
    csrfToken?: string | undefined;
    requireCsrf?: boolean | undefined;
    now?: Date | undefined;
  }): Promise<DashboardSessionView> {
    const now = input.now ?? new Date();
    const read = await this.codec.read();
    const parsed = parseDashboardCookie(input.cookieHeader);
    if (!parsed) throw new CapletsError("AUTH_FAILED", "Dashboard session is required.");
    const state = parseAuthorityDashboardSessionState(read.snapshot.dashboardSessions);
    const session = state.sessions.find((candidate) => candidate.sessionId === parsed.sessionId);
    if (
      !session ||
      !safeAuthorityHashEqual(hashAuthoritySecret(parsed.secret), session.secretHash)
    ) {
      throw new CapletsError("AUTH_FAILED", "Dashboard session is invalid.");
    }
    const auxiliary = await this.codec.readAuxiliary({
      kind: "session_touch",
      sessionId: session.sessionId,
    });
    const auxiliaryRecord = parseAuthoritySessionTouch(auxiliary);
    if (auxiliaryRecord?.revoked === true) {
      await this.removeSession(session.sessionId, input.now, "dashboard_session_revoked");
      throw new CapletsError("AUTH_FAILED", "Dashboard session has expired.");
    }
    const persistedLastUsedAt = auxiliaryRecord?.lastUsedAt ?? session.lastUsedAt;
    const expired = Date.parse(session.expiresAt) <= now.getTime();
    const idleExpired = now.getTime() - Date.parse(persistedLastUsedAt) > IDLE_TIMEOUT_MS;
    if (expired || idleExpired) {
      await this.removeSession(session.sessionId, input.now, "dashboard_session_expired");
      throw new CapletsError("AUTH_FAILED", "Dashboard session has expired.");
    }
    try {
      assertAuthorityOperator(read.snapshot, session.operatorClientId);
    } catch (error) {
      await this.removeSession(session.sessionId, input.now, "dashboard_session_revoked");
      throw error;
    }
    const csrfToken = this.codec.decrypt<string>(session.csrfTokenEncrypted);
    if (input.requireCsrf && input.csrfToken !== csrfToken) {
      throw new CapletsError("REQUEST_INVALID", "Dashboard CSRF token is invalid.");
    }
    const persistedAt = Date.parse(persistedLastUsedAt);
    const shouldPersistTouch =
      !auxiliaryRecord ||
      !Number.isFinite(persistedAt) ||
      now.getTime() - persistedAt >= DASHBOARD_SESSION_TOUCH_THROTTLE_MS;
    if (!shouldPersistTouch) {
      return authoritySessionView(session, csrfToken, persistedLastUsedAt);
    }
    const touched = await this.codec.commitAuxiliary({
      kind: "session_touch",
      sessionId: session.sessionId,
      lastUsedAt: now.toISOString(),
      expectedRevision: auxiliaryRecord?.revision ?? "",
      expectedGeneration: read.head,
    });
    if (touched.kind === "revoked" || touched.kind === "missing" || touched.kind === "conflict") {
      throw new CapletsError("AUTH_FAILED", "Dashboard session is no longer active.");
    }
    return authoritySessionView(
      session,
      csrfToken,
      touched.kind === "applied" ? now.toISOString() : persistedLastUsedAt,
    );
  }

  async delete(
    cookieHeader?: string | undefined,
    options: AuthoritySessionMutationOptions & { now?: Date | undefined } = {},
  ): Promise<boolean> {
    const parsed = parseDashboardCookie(cookieHeader);
    if (!parsed) return false;
    const read = await this.codec.read();
    const state = parseAuthorityDashboardSessionState(
      this.codec.domainSnapshot(read, "dashboardSessions"),
    );
    const session = state.sessions.find((candidate) => candidate.sessionId === parsed.sessionId);
    if (!session) {
      await this.removeTouch(parsed.sessionId);
      return false;
    }
    const nextState = {
      version: 1 as const,
      sessions: state.sessions.filter((candidate) => candidate.sessionId !== parsed.sessionId),
    };
    const root: Record<string, unknown> = { ...read.snapshot, dashboardSessions: nextState };
    const now = options.now ?? new Date();
    const activity = createDashboardActivityEntry({
      actorClientId: session.operatorClientId,
      action: "dashboard_logout",
      target: { type: "dashboard_session", id: session.sessionId },
      now,
    });
    root.dashboardActivity = appendAuthorityActivity(root.dashboardActivity, activity);
    const committed = await this.codec.commit({
      read,
      domain: "dashboardSessions",
      command: { kind: "delete_dashboard_session" },
      snapshot: root,
      result: true,
      payload: { sessionId: session.sessionId },
      idempotencyKey: options.idempotencyKey,
      principalId: options.principalId,
      now,
    });
    await this.removeTouch(session.sessionId);
    return committed.result;
  }

  async revokeClient(
    clientId: string,
    options: AuthoritySessionMutationOptions & { now?: Date | undefined } = {},
  ): Promise<number> {
    const read = await this.codec.read();
    const state = parseAuthorityDashboardSessionState(read.snapshot.dashboardSessions);
    const removedSessionIds = state.sessions
      .filter((session) => session.operatorClientId === clientId)
      .map((session) => session.sessionId);
    if (removedSessionIds.length === 0) return 0;
    const retained = state.sessions.filter((session) => session.operatorClientId !== clientId);
    const now = options.now ?? new Date();
    await this.codec.commit({
      read,
      domain: "dashboardSessions",
      command: { kind: "revoke_dashboard_client_sessions" },
      snapshot: { ...read.snapshot, dashboardSessions: { version: 1, sessions: retained } },
      result: removedSessionIds.length,
      payload: { clientId },
      idempotencyKey: options.idempotencyKey,
      principalId: options.principalId,
      now,
    });
    await Promise.all(removedSessionIds.map((sessionId) => this.removeTouch(sessionId)));
    return removedSessionIds.length;
  }

  async touch(
    sessionId: string,
    input: {
      lastUsedAt: string;
      expectedGeneration?: AuthorityGenerationIdentity | null;
      expectedRevision?: string;
    },
  ): Promise<unknown> {
    const read = await this.codec.read();
    return await this.codec.commitAuxiliary({
      kind: "session_touch",
      sessionId,
      lastUsedAt: input.lastUsedAt,
      expectedGeneration:
        input.expectedGeneration === undefined ? read.head : input.expectedGeneration,
      expectedRevision: input.expectedRevision ?? "",
    });
  }

  async dumpForTest(): Promise<AuthorityDashboardSessionState> {
    const read = await this.codec.read();
    return parseAuthorityDashboardSessionState(read.snapshot.dashboardSessions);
  }

  private async seedTouch(
    sessionId: string,
    lastUsedAt: string,
    expectedGeneration: AuthorityGenerationIdentity | null,
  ): Promise<void> {
    await this.codec.commitAuxiliary({
      kind: "session_touch",
      sessionId,
      lastUsedAt,
      expectedRevision: "",
      expectedGeneration,
    });
  }

  private async removeTouch(sessionId: string): Promise<void> {
    await this.codec.commitAuxiliary({
      kind: "remove_session_touch",
      sessionId,
    });
  }

  private async removeSession(
    sessionId: string,
    nowInput: Date | undefined,
    kind: string,
  ): Promise<void> {
    const read = await this.codec.read();
    const state = parseAuthorityDashboardSessionState(read.snapshot.dashboardSessions);
    const session = state.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (session) {
      const now = nowInput ?? new Date();
      await this.codec.commit({
        read,
        domain: "dashboardSessions",
        command: { kind },
        snapshot: {
          ...read.snapshot,
          dashboardSessions: {
            version: 1,
            sessions: state.sessions.filter((candidate) => candidate.sessionId !== sessionId),
          },
        },
        result: true,
        payload: { sessionId },
        now,
      });
    }
    await this.removeTouch(sessionId);
  }
}

function parseAuthorityDashboardSessionState(value: unknown): AuthorityDashboardSessionState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { version: 1, sessions: [] };
  const record = value as Partial<AuthorityDashboardSessionState>;
  return {
    version: 1,
    sessions: Array.isArray(record.sessions)
      ? record.sessions.filter((session): session is AuthorityDashboardSessionRecord =>
          isAuthorityDashboardSessionRecord(session),
        )
      : [],
  };
}

type AuthoritySessionTouch = {
  revision?: string;
  lastUsedAt?: string;
  revoked?: boolean;
};

function parseAuthoritySessionTouch(value: unknown): AuthoritySessionTouch | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.revision === "string" ? { revision: record.revision } : {}),
    ...(typeof record.lastUsedAt === "string" ? { lastUsedAt: record.lastUsedAt } : {}),
    ...(typeof record.revoked === "boolean" ? { revoked: record.revoked } : {}),
  };
}

function isAuthorityDashboardSessionRecord(
  value: unknown,
): value is AuthorityDashboardSessionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<AuthorityDashboardSessionRecord>;
  return (
    typeof record.sessionId === "string" &&
    typeof record.secretHash === "string" &&
    typeof record.operatorClientId === "string" &&
    record.role === "operator" &&
    typeof record.csrfTokenEncrypted === "object" &&
    typeof record.createdAt === "string" &&
    typeof record.expiresAt === "string" &&
    typeof record.lastUsedAt === "string"
  );
}

function authoritySessionView(
  session: AuthorityDashboardSessionRecord,
  csrfToken: string,
  lastUsedAt = session.lastUsedAt,
): DashboardSessionView {
  return {
    sessionId: session.sessionId,
    operatorClientId: session.operatorClientId,
    role: "operator",
    csrfToken,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    lastUsedAt,
  };
}

function assertAuthorityOperator(root: Record<string, unknown>, clientId: string): void {
  const remote = root.remoteCredentials;
  if (!remote || typeof remote !== "object" || Array.isArray(remote)) return;
  const clients = (remote as { clients?: unknown }).clients;
  if (!Array.isArray(clients)) return;
  const client = clients.find(
    (candidate) =>
      candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).clientId === clientId,
  );
  if (
    !client ||
    (client as Record<string, unknown>).role !== "operator" ||
    (client as Record<string, unknown>).revokedAt
  ) {
    throw new CapletsError("AUTH_FAILED", "Dashboard operator client is no longer authorized.");
  }
}

function appendAuthorityActivity(
  value: unknown,
  entry: DashboardActivityEntry,
): DashboardActivityEntry[] {
  const entries = Array.isArray(value)
    ? value.filter((candidate): candidate is DashboardActivityEntry =>
        Boolean(candidate && typeof candidate === "object"),
      )
    : [];
  return [...entries, entry].slice(-10_000);
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
