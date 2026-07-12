import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createPostgresAuthority, type PostgresAuthority } from "../src/storage/sql/authority";
import { migratePostgresDatabase } from "../src/storage/sql/migrate";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import { stableJsonStringify } from "../src/stable-json";

const require = createRequire(import.meta.url);
const loadPostgres = require("postgres") as typeof postgres;
const connectionString = process.env.TEST_POSTGRES_URL;

describe.skipIf(!connectionString)("PostgreSQL SQL authority", () => {
  let authority: PostgresAuthority<{ value: number }, { snapshot: { value: number } }>;

  it("locks the singleton head first and commits through one transaction", async () => {
    await migratePostgresDatabase({
      connectionString: connectionString!,
      authorityId: "authority-pg",
      namespace: "test",
    });
    authority = await createPostgresAuthority<{ value: number }, { snapshot: { value: number } }>({
      connectionString: connectionString!,
      authorityId: "authority-pg",
      namespace: "test",
      initialSnapshot: { value: 0 },
      statementTimeoutMs: 2_000,
      lockTimeoutMs: 500,
      applyCommand: ({ command }) => ({ snapshot: command.snapshot, result: { ok: true } }),
    });
    const envelope = {
      authorityId: "authority-pg",
      currentHostId: "host",
      principalId: "operator",
      expectedGeneration: null,
      idempotencyKey: "first",
      requestDigest: "digest-1",
      command: { snapshot: { value: 1 } },
    };
    const result = await authority.commit(envelope);
    expect(result.kind).toBe("committed");
    const replay = await authority.commit(envelope);
    expect(replay.kind).toBe("replayed");
    await authority.close();
  });

  it("rejects an existing namespace mismatch without overwriting PostgreSQL metadata", async () => {
    const authorityId = `authority-pg-namespace-${randomUUID()}`;
    await migratePostgresDatabase({
      connectionString: connectionString!,
      authorityId,
      namespace: "stable",
    });
    await expect(
      migratePostgresDatabase({
        connectionString: connectionString!,
        authorityId,
        namespace: "wrong",
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      migratePostgresDatabase({
        connectionString: connectionString!,
        authorityId,
        namespace: "stable",
      }),
    ).resolves.toMatchObject({ applied: 0, logicalSchemaVersion: 3 });
  });
  it("returns pooled connections after conflict and shuts down both pools", async () => {
    const first = await createPostgresAuthority({
      connectionString: connectionString!,
      authorityId: "authority-pg-pool",
      namespace: "test",
    });
    const second = await createPostgresAuthority({
      connectionString: connectionString!,
      authorityId: "authority-pg-pool",
      namespace: "test",
    });
    try {
      const envelope = {
        authorityId: "authority-pg-pool",
        currentHostId: "host",
        principalId: "operator",
        expectedGeneration: null,
        requestDigest: "digest",
        command: { snapshot: { value: 1 } },
      };
      const results = await Promise.all([
        first.commit({ ...envelope, idempotencyKey: "one" }),
        second.commit({ ...envelope, idempotencyKey: "two" }),
      ]);
      expect(results.map((result) => result.kind).sort()).toEqual(["committed", "conflict"]);
      expect((await first.health()).connectivity).toBe("healthy");
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("bounds ordinary and startup reads while returning timed-out connections to the pool", async () => {
    const authorityId = `authority-pg-timeout-${randomUUID()}`;
    await migratePostgresDatabase({
      connectionString: connectionString!,
      authorityId,
      namespace: "test",
    });
    const authority = await createPostgresAuthority({
      connectionString: connectionString!,
      authorityId,
      namespace: "test",
      statementTimeoutMs: 50,
    });
    const blocker = loadPostgres(connectionString!, { max: 1, prepare: false });
    try {
      await blocker.begin(async (tx) => {
        await tx`LOCK TABLE authority_heads IN ACCESS EXCLUSIVE MODE`;
        await expect(authority.readHead()).rejects.toMatchObject({
          code: "SERVER_UNAVAILABLE",
        });
        await expect(
          createPostgresAuthority({
            connectionString: connectionString!,
            authorityId,
            namespace: "test",
            statementTimeoutMs: 50,
          }),
        ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
      });
      await expect(authority.readHead()).resolves.toBeNull();
    } finally {
      await authority.close();
      await blocker.end({ timeout: 2 });
    }
  });

  it("closes after a blocked maintenance release and preserves closed state", async () => {
    const authorityId = `authority-pg-close-${randomUUID()}`;
    await migratePostgresDatabase({
      connectionString: connectionString!,
      authorityId,
      namespace: "test",
    });
    const authority = await createPostgresAuthority({
      connectionString: connectionString!,
      authorityId,
      namespace: "test",
      lockTimeoutMs: 100,
      statementTimeoutMs: 500,
    });
    const fence = authority.maintenanceFence();
    if (!fence) throw new Error("expected PostgreSQL maintenance fence");
    const context = {
      operation: "migration" as const,
      role: "destination" as const,
      authorityId,
      namespace: "test",
      owner: "close-owner",
    };
    const lease = await fence.acquire(context);
    const blocker = loadPostgres(connectionString!, { max: 1, prepare: false });
    try {
      await blocker.begin(async (tx) => {
        await tx`LOCK TABLE authority_heads IN ACCESS EXCLUSIVE MODE`;
        await expect(authority.close()).rejects.toMatchObject({
          code: "SERVER_UNAVAILABLE",
        });
      });
      await expect(authority.close()).resolves.toBeUndefined();
    } finally {
      if (fence.release)
        await Promise.resolve(fence.release(lease, context)).catch(() => undefined);
      await blocker.end({ timeout: 2 }).catch(() => undefined);
    }
  });

  it("exports canonical receipts and auxiliary state under one transaction", async () => {
    const authorityId = `authority-pg-export-${randomUUID()}`;
    await migratePostgresDatabase({
      connectionString: connectionString!,
      authorityId,
      namespace: "test",
    });
    const authority = await createPostgresAuthority<
      { dashboardSessions: Array<{ sessionId: string }> },
      { snapshot: { dashboardSessions: Array<{ sessionId: string }> }; result?: unknown }
    >({
      connectionString: connectionString!,
      authorityId,
      namespace: "test",
      initialSnapshot: { dashboardSessions: [{ sessionId: "session-1" }] },
      applyCommand: ({ command }) => ({ snapshot: command.snapshot, result: command.result }),
    });
    try {
      const envelope = {
        authorityId,
        currentHostId: "host",
        principalId: "operator",
        expectedGeneration: null,
        idempotencyKey: "first",
        requestDigest: "digest-first",
        command: {
          snapshot: { dashboardSessions: [{ sessionId: "session-1" }] },
          result: { ok: true },
        },
      };
      const committed = await authority.commit(envelope);
      expect(committed.kind).toBe("committed");
      if (committed.kind !== "committed") throw new Error("expected PostgreSQL commit");
      expect(
        await authority.commitAuxiliary({
          kind: "session_touch",
          sessionId: "session-1",
          expectedRevision: "",
          expectedGeneration: committed.generation,
          lastUsedAt: "2026-01-01T00:00:00.000Z",
        }),
      ).toMatchObject({ kind: "applied", watermark: "1" });
      expect(
        await authority.commitAuxiliary({
          kind: "security_event",
          event: { kind: "conflicted", occurredAt: "2026-01-01T00:00:01.000Z", code: "CONFLICTED" },
        }),
      ).toMatchObject({ kind: "applied", watermark: "2" });
      const exported = await authority.exportState();
      const unchanged = await authority.exportState();
      expect(stableJsonStringify(unchanged)).toBe(stableJsonStringify(exported));
      expect(exported.receipts?.map((receipt) => receipt.idempotencyKey)).toEqual(["first"]);
      expect(exported.auxiliary?.sessions?.["session-1"]).toEqual({
        revision: "1",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
        revoked: false,
      });
      expect(exported.auxiliary?.securityEvents).toEqual([
        { kind: "conflicted", occurredAt: "2026-01-01T00:00:01.000Z", code: "CONFLICTED" },
      ]);
      expect(exported.auxiliary?.securityEventWatermarks).toEqual(["2"]);
      expect((await authority.commit(envelope)).kind).toBe("replayed");
    } finally {
      await authority.close();
    }
  });
});
