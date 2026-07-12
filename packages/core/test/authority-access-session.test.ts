import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AuthorityDashboardActivityLog } from "../src/dashboard/activity-log";
import { AuthorityDashboardSessionStore } from "../src/dashboard/session-store";
import { CapletsError } from "../src/errors";
import { AuthorityRemoteServerCredentialStore } from "../src/remote/server-credential-store";
import type {
  AuthorityCommitResult,
  AuthorityExport,
  AuthorityGeneration,
  AuthorityGenerationIdentity,
  AuthorityHead,
  AuthorityHealth,
  AuxiliaryCommit,
  AuxiliaryCommitResult,
  AuxiliaryRead,
  SemanticCommandEnvelope,
  WritableAuthority,
} from "../src/storage/types";

type Snapshot = Record<string, unknown>;

const authorities: MemoryAuthority[] = [];

afterEach(async () => {
  await Promise.all(authorities.splice(0).map((authority) => authority.close()));
});

describe("authority-backed access/session/activity codecs", () => {
  it("preserves pending/replay/role/revocation semantics across replicas without raw secrets", async () => {
    const authority = new MemoryAuthority();
    authorities.push(authority);
    const key = Buffer.alloc(32, 7);
    const first = new AuthorityRemoteServerCredentialStore({ authority, encryptionKey: key });
    const second = new AuthorityRemoteServerCredentialStore({ authority, encryptionKey: key });

    const pending = await first.createPendingLogin({
      hostUrl: "https://caplets.example.com/caplets",
      requestedRole: "operator",
      clientLabel: "Browser",
      idempotencyKey: "pending-1",
    });
    expect(JSON.stringify(authority.rawState())).not.toContain(pending.pendingCompletionSecret);
    expect(JSON.stringify(authority.rawState())).not.toContain(pending.pendingRefreshSecret);

    await first.approvePendingLogin({
      operatorCode: pending.operatorCode,
      idempotencyKey: "approve-1",
    });
    const credentials = await first.completePendingLogin({
      hostUrl: "https://caplets.example.com/caplets",
      flowId: pending.flowId,
      pendingCompletionSecret: pending.pendingCompletionSecret,
      requiredRole: "operator",
      idempotencyKey: "complete-1",
    });
    await expect(
      second.validateAccessToken({
        hostUrl: "https://caplets.example.com/caplets",
        accessToken: credentials.accessToken,
      }),
    ).resolves.toMatchObject({ clientId: credentials.clientId, role: "operator" });

    const replay = await second.completePendingLogin({
      hostUrl: "https://caplets.example.com/caplets",
      flowId: pending.flowId,
      pendingCompletionSecret: pending.pendingCompletionSecret,
      requiredRole: "operator",
      idempotencyKey: "complete-replay",
    });
    expect(replay.accessToken).toBe(credentials.accessToken);

    await first.changeClientRole(credentials.clientId, "access", new Date(), {
      idempotencyKey: "role-1",
    });
    await expect(
      second.validateAccessToken({
        hostUrl: "https://caplets.example.com/caplets",
        accessToken: credentials.accessToken,
      }),
    ).resolves.toMatchObject({ clientId: credentials.clientId, role: "access" });
    await first.revokeClient(credentials.clientId, new Date(), { idempotencyKey: "revoke-1" });
    await expect(
      second.validateAccessToken({
        hostUrl: "https://caplets.example.com/caplets",
        accessToken: credentials.accessToken,
      }),
    ).rejects.toMatchObject({ code: "REMOTE_CREDENTIALS_REVOKED" });
  });

  it("atomically commits dashboard session success activity and fences touches after revoke", async () => {
    const authority = new MemoryAuthority();
    authorities.push(authority);
    const key = Buffer.alloc(32, 8);
    const remote = new AuthorityRemoteServerCredentialStore({ authority, encryptionKey: key });
    const pending = await remote.createPendingLogin({
      hostUrl: "https://caplets.example.com/caplets",
      requestedRole: "operator",
      idempotencyKey: "p",
    });
    await remote.approvePendingLogin({ operatorCode: pending.operatorCode, idempotencyKey: "a" });
    const credentials = await remote.completePendingLogin({
      hostUrl: "https://caplets.example.com/caplets",
      flowId: pending.flowId,
      pendingCompletionSecret: pending.pendingCompletionSecret,
      requiredRole: "operator",
      idempotencyKey: "c",
    });
    const sessionsA = new AuthorityDashboardSessionStore({ authority, encryptionKey: key });
    const sessionsB = new AuthorityDashboardSessionStore({ authority, encryptionKey: key });
    const created = await sessionsA.create({
      operatorClientId: credentials.clientId,
      idempotencyKey: "session-create",
    });
    const activeBefore = await authority.readHead();
    await expect(
      sessionsB.validate({ cookieHeader: `caplets_dashboard_session=${created.cookieValue}` }),
    ).resolves.toMatchObject({
      sessionId: created.session.sessionId,
      csrfToken: created.session.csrfToken,
    });
    const activity = new AuthorityDashboardActivityLog({ authority, encryptionKey: key });
    await expect(activity.list()).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ action: "dashboard_login_completed" }),
      ]),
    });

    await remote.revokeClient(credentials.clientId, new Date(), {
      idempotencyKey: "session-revoke",
    });
    await expect(
      sessionsB.validate({ cookieHeader: `caplets_dashboard_session=${created.cookieValue}` }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    if (!activeBefore) throw new Error("expected active session generation");
    await expect(
      sessionsB.touch(created.session.sessionId, {
        lastUsedAt: new Date(Date.now() + 10_000).toISOString(),
        expectedGeneration: activeBefore,
        expectedRevision: "",
      }),
    ).resolves.toMatchObject({ kind: "conflict" });

    const failed = await activity.recordFailure({
      kind: "rejected",
      code: "DENIED",
      idempotencyKey: "secret-request",
    });
    expect(failed.kind).toBe("applied");
    expect(JSON.stringify(authority.rawState())).not.toContain("secret-request");
  });
});

class MemoryAuthority implements WritableAuthority<Snapshot, Record<string, unknown>> {
  readonly authorityId = "memory-authority";
  readonly namespace = "test";
  private sequence = 0;
  private head: AuthorityHead | null = null;
  private generation: AuthorityGeneration<Snapshot> | null = null;
  private snapshot: Snapshot = {};
  private readonly receipts = new Map<
    string,
    AuthorityExport["generation"] extends never
      ? never
      : {
          digest: string;
          result: unknown;
          generation: AuthorityGenerationIdentity;
          expiresAt: string;
        }
  >();
  private readonly sessions = new Map<
    string,
    { revision: string; lastUsedAt: string; revoked: boolean }
  >();
  private watermark = 0;
  private readonly events: Array<{ watermark: string; event: unknown }> = [];

  async readHead(): Promise<AuthorityHead | null> {
    return this.head;
  }

  async readGeneration(id: string): Promise<AuthorityGeneration<Snapshot>> {
    if (!this.generation || this.generation.id !== id)
      throw new CapletsError("CONFIG_NOT_FOUND", "generation missing");
    return structuredClone(this.generation);
  }

  async commit<TResult = unknown>(
    envelope: SemanticCommandEnvelope<Record<string, unknown>>,
  ): Promise<AuthorityCommitResult<TResult>> {
    const receiptKey = `${envelope.currentHostId}\0${envelope.principalId}\0${envelope.idempotencyKey}`;
    const prior = this.receipts.get(receiptKey);
    if (prior) {
      if (prior.digest !== envelope.requestDigest)
        throw new CapletsError("REQUEST_INVALID", "idempotency payload changed");
      return {
        kind: "replayed",
        generation: prior.generation,
        receipt: {
          ...envelope,
          generation: prior.generation,
          result: prior.result as TResult,
          expiresAt: prior.expiresAt,
        },
      };
    }
    if (!sameIdentity(this.head, envelope.expectedGeneration))
      return { kind: "conflict", active: this.head };
    const command = envelope.command;
    const candidate = command.snapshot;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new CapletsError("REQUEST_INVALID", "snapshot missing");
    this.sequence += 1;
    const id = randomUUID();
    const predecessorId = this.head?.id ?? null;
    const identity = { authorityId: this.authorityId, id, sequence: this.sequence, predecessorId };
    this.snapshot = structuredClone(candidate) as Snapshot;
    this.generation = {
      ...identity,
      schemaVersion: 1,
      digest: `memory:${this.sequence}`,
      committedAt: new Date().toISOString(),
      provenance: { provider: "sqlite", namespace: this.namespace },
      snapshot: structuredClone(this.snapshot),
    };
    this.head = { ...identity, digest: this.generation.digest };
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    this.receipts.set(receiptKey, {
      digest: envelope.requestDigest,
      result: command.result,
      generation: identity,
      expiresAt,
    });
    return {
      kind: "committed",
      generation: identity,
      receipt: {
        currentHostId: envelope.currentHostId,
        principalId: envelope.principalId,
        idempotencyKey: envelope.idempotencyKey,
        requestDigest: envelope.requestDigest,
        generation: identity,
        result: command.result as TResult,
        expiresAt,
      },
    };
  }

  async readAuxiliary(request: AuxiliaryRead): Promise<unknown> {
    if (request.kind === "session_touch")
      return this.sessions.has(request.sessionId)
        ? { sessionId: request.sessionId, ...this.sessions.get(request.sessionId) }
        : null;
    return {
      watermark: String(this.watermark),
      events: this.events
        .filter((entry) => !request.afterWatermark || entry.watermark > request.afterWatermark)
        .slice(0, request.limit)
        .map((entry) => entry.event),
    };
  }

  async commitAuxiliary(command: AuxiliaryCommit): Promise<AuxiliaryCommitResult> {
    if (command.kind === "security_event") {
      this.watermark += 1;
      this.events.push({ watermark: String(this.watermark), event: command.event });
      return { kind: "applied", watermark: String(this.watermark) };
    }
    if (!sameIdentity(this.head, command.expectedGeneration)) return { kind: "conflict" };
    const existing = this.sessions.get(command.sessionId);
    if (!existing) {
      if (command.expectedRevision !== "" || !sessionExists(this.snapshot, command.sessionId))
        return { kind: "missing" };
      this.watermark += 1;
      this.sessions.set(command.sessionId, {
        revision: String(this.watermark),
        lastUsedAt: command.lastUsedAt,
        revoked: false,
      });
      return { kind: "applied", watermark: String(this.watermark) };
    }
    if (existing.revoked) return { kind: "revoked" };
    if (existing.revision !== command.expectedRevision) return { kind: "conflict" };
    if (command.lastUsedAt <= existing.lastUsedAt)
      return { kind: "unchanged", watermark: String(this.watermark) };
    this.watermark += 1;
    existing.revision = String(this.watermark);
    existing.lastUsedAt = command.lastUsedAt;
    return { kind: "applied", watermark: String(this.watermark) };
  }

  async health(): Promise<AuthorityHealth> {
    return {
      provider: "sqlite",
      authorityId: this.authorityId,
      connectivity: "healthy",
      writable: true,
      activeGeneration: this.head,
      refresh: "current",
    };
  }

  async exportState(): Promise<AuthorityExport> {
    if (!this.generation) throw new CapletsError("CONFIG_NOT_FOUND", "generation missing");
    return {
      generation: structuredClone(this.generation),
      auxiliaryWatermark: String(this.watermark),
    };
  }

  async restoreState(
    state: AuthorityExport,
  ): Promise<{ generation: AuthorityGenerationIdentity; auxiliaryWatermark: string }> {
    this.generation = structuredClone(state.generation) as AuthorityGeneration<Snapshot>;
    this.snapshot = structuredClone(state.generation.snapshot) as Snapshot;
    this.head = {
      authorityId: state.generation.authorityId,
      id: state.generation.id,
      sequence: state.generation.sequence,
      predecessorId: state.generation.predecessorId,
      digest: state.generation.digest,
    };
    this.sequence = state.generation.sequence;
    return { generation: state.generation, auxiliaryWatermark: state.auxiliaryWatermark };
  }

  async close(): Promise<void> {}

  rawState(): unknown {
    return {
      snapshot: this.snapshot,
      receipts: this.receipts,
      sessions: this.sessions,
      events: this.events,
    };
  }
}

function sameIdentity(
  head: AuthorityHead | null,
  expected: AuthorityGenerationIdentity | null,
): boolean {
  return head === null
    ? expected === null
    : Boolean(
        expected &&
        head.authorityId === expected.authorityId &&
        head.id === expected.id &&
        head.sequence === expected.sequence &&
        head.predecessorId === expected.predecessorId,
      );
}

function sessionExists(snapshot: Snapshot, sessionId: string): boolean {
  const sessions = snapshot.dashboardSessions;
  if (
    !sessions ||
    typeof sessions !== "object" ||
    Array.isArray(sessions) ||
    !("sessions" in sessions)
  )
    return false;
  const entries = sessions.sessions;
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !("sessionId" in entry))
      return false;
    return entry.sessionId === sessionId;
  });
}
