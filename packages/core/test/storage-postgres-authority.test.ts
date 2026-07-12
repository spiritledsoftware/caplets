import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createPostgresAuthority, type PostgresAuthority } from "../src/storage/sql/authority";
import { migratePostgresDatabase } from "../src/storage/sql/migrate";
import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { stableJsonStringify } from "../src/stable-json";

const require = createRequire(import.meta.url);
const loadPostgres = require("postgres") as typeof postgres;
const connectionString = process.env.TEST_POSTGRES_URL;

type PostgresCommitWindow = "before" | "after";

type PostgresFaultState = {
  window: PostgresCommitWindow;
  armed: boolean;
  triggered: boolean;
};

function createFaultPostgresClient(state: PostgresFaultState): postgres.Sql {
  const client = loadPostgres(connectionString!, {
    max: 1,
    prepare: false,
    backoff: () => 0,
  });
  const intercepted = client as unknown as {
    begin(...args: unknown[]): Promise<unknown>;
  };
  const originalBegin = intercepted.begin.bind(client);
  intercepted.begin = async (...args: unknown[]) => {
    const callback =
      typeof args[0] === "function"
        ? (args[0] as (transaction: unknown) => unknown)
        : (args[1] as (transaction: unknown) => unknown);
    if (typeof callback !== "function")
      return Reflect.apply(originalBegin, client, args) as Promise<unknown>;
    const wrappedCallback = async (transaction: unknown) => {
      const result = await callback(transaction);
      if (state.armed && state.window === "before") {
        state.armed = false;
        state.triggered = true;
        throw new Error("socket closed immediately before PostgreSQL COMMIT");
      }
      return result;
    };
    const beginArgs =
      typeof args[0] === "function" ? [wrappedCallback] : [args[0], wrappedCallback];
    const result = await Reflect.apply(originalBegin, client, beginArgs);
    if (state.armed && state.window === "after") {
      state.armed = false;
      state.triggered = true;
      throw new Error("socket closed immediately after PostgreSQL COMMIT");
    }
    return result;
  };
  return client;
}

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
        await tx`LOCK TABLE caplets.authority_heads IN ACCESS EXCLUSIVE MODE`;
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
        await tx`LOCK TABLE caplets.authority_heads IN ACCESS EXCLUSIVE MODE`;
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

  it.each(["before", "after"] as const)(
    "recovers one PostgreSQL generation, receipt, and activity when the socket is lost %s COMMIT",
    async (window) => {
      const authorityId = `authority-pg-ambiguous-${window}-${randomUUID()}`;
      await migratePostgresDatabase({
        connectionString: connectionString!,
        authorityId,
        namespace: "test",
      });
      const faultState: PostgresFaultState = {
        window,
        armed: false,
        triggered: false,
      };
      const client = createFaultPostgresClient(faultState);
      const applyCommand = vi.fn(
        ({ command }: { command: { snapshot: { value: number }; result?: unknown } }) => ({
          snapshot: command.snapshot,
          result: command.result,
        }),
      );
      let authority:
        | PostgresAuthority<{ value: number }, { snapshot: { value: number }; result?: unknown }>
        | undefined;
      try {
        authority = await createPostgresAuthority<
          { value: number },
          { snapshot: { value: number }; result?: unknown }
        >({
          client,
          authorityId,
          namespace: "test",
          initialSnapshot: { value: 0 },
          applyCommand,
        });
        faultState.armed = true;
        const envelope = {
          authorityId,
          currentHostId: "host",
          principalId: "operator",
          expectedGeneration: null,
          idempotencyKey: "ambiguous-commit",
          requestDigest: "ambiguous-commit-digest",
          command: { snapshot: { value: 1 }, result: { accepted: true } },
        };

        if (window === "before") {
          await expect(authority.commit(envelope)).rejects.toMatchObject({
            code: "SERVER_UNAVAILABLE",
          });
        } else {
          await expect(authority.commit(envelope)).resolves.toMatchObject({ kind: "replayed" });
        }
        expect(faultState.triggered).toBe(true);

        const recovered = await authority.commit(envelope);
        expect(recovered.kind).toBe(window === "before" ? "committed" : "replayed");
        const replay = await authority.commit(envelope);
        expect(replay.kind).toBe("replayed");
        if (recovered.kind !== "committed" && recovered.kind !== "replayed")
          throw new Error("expected a recovered generation");

        await expect(
          authority.commitAuxiliary({
            kind: "security_event",
            event: {
              kind: "conflicted",
              occurredAt: "2026-01-01T00:00:01.000Z",
              code: "AMBIGUOUS_COMMIT",
            },
          }),
        ).resolves.toMatchObject({ kind: "applied" });
        const exported = await authority.exportState();
        expect(exported.generation.sequence).toBe(1);
        expect(exported.generation.id).toBe(recovered.generation.id);
        expect(exported.receipts).toHaveLength(1);
        expect(exported.receipts?.[0]).toMatchObject({
          idempotencyKey: "ambiguous-commit",
          generation: recovered.generation,
        });
        expect(exported.auxiliary?.securityEvents).toEqual([
          {
            kind: "conflicted",
            occurredAt: "2026-01-01T00:00:01.000Z",
            code: "AMBIGUOUS_COMMIT",
          },
        ]);
        expect(applyCommand).toHaveBeenCalledTimes(window === "before" ? 2 : 1);
      } finally {
        await authority?.close().catch(() => undefined);
        await client.end({ timeout: 2 }).catch(() => undefined);
      }
    },
  );

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
