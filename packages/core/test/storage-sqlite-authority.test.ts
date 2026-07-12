import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteAuthority, type SqliteAuthority } from "../src/storage/sql/authority";
import { migrateSqliteDatabase } from "../src/storage/sql/migrate";
import { stableJsonStringify } from "../src/stable-json";

async function withSqlite(
  run: (
    authority: SqliteAuthority<
      { value: number },
      { snapshot: { value: number }; result?: unknown }
    >,
    path: string,
  ) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "caplets-sqlite-"));
  const path = join(directory, "authority.sqlite");
  await migrateSqliteDatabase({
    databasePath: path,
    authorityId: "authority-test",
    namespace: "test",
  });
  const authority = await createSqliteAuthority<
    { value: number },
    { snapshot: { value: number }; result?: unknown }
  >({
    databasePath: path,
    authorityId: "authority-test",
    namespace: "test",
    initialSnapshot: { value: 0 },
    applyCommand: ({ command }) => ({ snapshot: command.snapshot, result: command.result }),
  });
  try {
    await run(authority, path);
  } finally {
    await authority.close();
  }
}

describe("SQLite SQL authority", () => {
  it("publishes one generation and replays an idempotent command before stale checks", async () => {
    await withSqlite(async (authority) => {
      const envelope = {
        authorityId: "authority-test",
        currentHostId: "host",
        principalId: "operator",
        expectedGeneration: null,
        idempotencyKey: "first",
        requestDigest: "digest-1",
        command: { snapshot: { value: 1 }, result: { accepted: true } },
      };
      const committed = await authority.commit(envelope);
      expect(committed.kind).toBe("committed");
      if (committed.kind !== "committed") throw new Error("expected commit");
      expect(committed.generation.sequence).toBe(1);
      const replay = await authority.commit({
        ...envelope,
        expectedGeneration: {
          authorityId: "authority-test",
          id: "stale",
          sequence: 99,
          predecessorId: null,
        },
      });
      expect(replay.kind).toBe("replayed");
      const generation = await authority.readGeneration(committed.generation.id);
      expect(generation.snapshot).toEqual({ value: 1 });
    });
  });

  it("keeps staged migration candidates unreachable, invalidates them, and retries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caplets-sqlite-stage-"));
    const sourcePath = join(directory, "source.sqlite");
    const targetPath = join(directory, "target.sqlite");
    await migrateSqliteDatabase({
      databasePath: sourcePath,
      authorityId: "authority-stage",
      namespace: "test",
    });
    await migrateSqliteDatabase({
      databasePath: targetPath,
      authorityId: "authority-stage",
      namespace: "test",
    });
    const source = await createSqliteAuthority<
      { value: number },
      { snapshot: { value: number }; result?: unknown }
    >({
      databasePath: sourcePath,
      authorityId: "authority-stage",
      namespace: "test",
      initialSnapshot: { value: 0 },
      applyCommand: ({ command }) => ({ snapshot: command.snapshot, result: command.result }),
    });
    const target = await createSqliteAuthority<
      { value: number },
      { snapshot: { value: number }; result?: unknown }
    >({
      databasePath: targetPath,
      authorityId: "authority-stage",
      namespace: "test",
      initialSnapshot: { value: 0 },
      applyCommand: ({ command }) => ({ snapshot: command.snapshot, result: command.result }),
    });
    const context = {
      operation: "migration" as const,
      role: "destination" as const,
      authorityId: "authority-stage",
      namespace: "test",
      owner: "stage-owner",
    };
    const fence = target.maintenanceFence();
    const lease = await fence.acquire(context);
    try {
      const committed = await source.commit({
        authorityId: "authority-stage",
        currentHostId: "host",
        principalId: "operator",
        expectedGeneration: null,
        idempotencyKey: "stage-source",
        requestDigest: "stage-source",
        command: { snapshot: { value: 1 }, result: { ok: true } },
      });
      expect(committed.kind).toBe("committed");
      const state = await source.exportState();
      const stage = await target.stageMigration(state, { owner: context.owner });
      expect(await target.readHead()).toBeNull();
      expect(await target.readMigrationStage(stage, { owner: context.owner })).toMatchObject({
        generation: state.generation,
        auxiliaryWatermark: state.auxiliaryWatermark,
      });
      await target.invalidateMigrationStage(stage, { owner: context.owner });
      expect(await target.readHead()).toBeNull();
      const retry = await target.stageMigration(state, { owner: context.owner });
      await target.publishMigrationStage(retry, { owner: context.owner });
      const head = await target.readHead();
      expect(head).toMatchObject({
        id: state.generation.id,
        sequence: state.generation.sequence,
        digest: state.generation.digest,
      });
    } finally {
      if (fence.release) await fence.release(lease, context);
      await source.close();
      await target.close();
    }
  });

  it("serializes independent writers and rejects the loser", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caplets-sqlite-race-"));
    const path = join(directory, "authority.sqlite");
    await migrateSqliteDatabase({
      databasePath: path,
      authorityId: "authority-race",
      namespace: "test",
    });
    const options = {
      databasePath: path,
      authorityId: "authority-race",
      namespace: "test",
      initialSnapshot: { value: 0 },
      applyCommand: ({ command }: { command: { snapshot: unknown } }) => ({
        snapshot: command.snapshot,
      }),
    };
    const first = await createSqliteAuthority(options);
    const second = await createSqliteAuthority(options);
    try {
      const envelope = {
        authorityId: "authority-race",
        currentHostId: "host",
        principalId: "operator",
        expectedGeneration: null,
        requestDigest: "digest",
        command: { snapshot: { value: 1 } },
      };
      const results = await Promise.all([
        first.commit({ ...envelope, idempotencyKey: "a" }),
        second.commit({ ...envelope, idempotencyKey: "b" }),
      ]);
      expect(results.map((result) => result.kind).sort()).toEqual(["committed", "conflict"]);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("persists a maintenance lease across authority instances and allows only the owner to write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caplets-sqlite-fence-"));
    const path = join(directory, "authority.sqlite");
    await migrateSqliteDatabase({
      databasePath: path,
      authorityId: "authority-fence",
      namespace: "test",
    });
    const options = {
      databasePath: path,
      authorityId: "authority-fence",
      namespace: "test",
      initialSnapshot: { value: 0 },
      applyCommand: ({ command }: { command: { snapshot: { value: number } } }) => ({
        snapshot: command.snapshot,
      }),
      maintenanceLeaseMs: 100,
      maintenanceRenewIntervalMs: 20,
    };
    const first = await createSqliteAuthority(options);
    const second = await createSqliteAuthority(options);
    const context = {
      operation: "migration" as const,
      role: "source" as const,
      authorityId: "authority-fence",
      namespace: "test",
      owner: "owner-a",
    };
    const lease = await first.maintenanceFence().acquire(context);
    if (!lease) throw new Error("expected maintenance lease");
    try {
      const firstCommit = await first.commit({
        authorityId: "authority-fence",
        currentHostId: "host",
        principalId: "operator",
        expectedGeneration: null,
        idempotencyKey: "fence-first",
        requestDigest: "fence-first",
        command: { snapshot: { value: 1 } },
      });
      expect(firstCommit.kind).toBe("committed");
      if (firstCommit.kind !== "committed") throw new Error("expected first commit");
      await expect(
        second.commit({
          authorityId: "authority-fence",
          currentHostId: "host",
          principalId: "operator",
          expectedGeneration: null,
          idempotencyKey: "fence-foreign",
          requestDigest: "fence-foreign",
          command: { snapshot: { value: 2 } },
        }),
      ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
      await second.maintenanceFence().release?.(lease, { ...context, owner: "owner-b" });
      await expect(
        second.commit({
          authorityId: "authority-fence",
          currentHostId: "host",
          principalId: "operator",
          expectedGeneration: null,
          idempotencyKey: "fence-still-foreign",
          requestDigest: "fence-still-foreign",
          command: { snapshot: { value: 3 } },
        }),
      ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
      await lease.release?.();
      await expect(
        second.commit({
          authorityId: "authority-fence",
          currentHostId: "host",
          principalId: "operator",
          expectedGeneration: firstCommit.generation,
          idempotencyKey: "fence-after-release",
          requestDigest: "fence-after-release",
          command: { snapshot: { value: 4 } },
        }),
      ).resolves.toMatchObject({ kind: "committed" });
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("uses safe local SQLite pragmas and the native backup API", async () => {
    await withSqlite(async (authority, path) => {
      const pragmas = authority.sqlitePragmas();
      expect(pragmas.foreignKeys).toBe(1);
      expect(pragmas.journalMode.toLowerCase()).toBe("wal");
      expect(pragmas.synchronous).toBe(2);
      expect(pragmas.busyTimeout).toBeGreaterThan(0);
      const backupPath = `${path}.backup`;
      await authority.backup(backupPath);
      expect(await readFile(backupPath)).toBeInstanceOf(Buffer);
      expect(authority.sqliteRuntimeVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });
  it("exports canonical lifecycle state and restores receipts plus auxiliary records", async () => {
    type Snapshot = { dashboardSessions: Array<{ sessionId: string }> };
    type Command = { snapshot: Snapshot; result?: unknown };
    const root = await mkdtemp(join(tmpdir(), "caplets-sqlite-export-"));
    const sourcePath = join(root, "source.sqlite");
    const targetPath = join(root, "target.sqlite");
    const malformedPath = join(root, "malformed.sqlite");
    const options = {
      authorityId: "authority-export",
      namespace: "test",
      initialSnapshot: { dashboardSessions: [{ sessionId: "session-1" }] } satisfies Snapshot,
      applyCommand: ({ command }: { command: Command }) => ({
        snapshot: command.snapshot,
        result: command.result,
      }),
    };
    await Promise.all(
      [sourcePath, targetPath, malformedPath].map((databasePath) =>
        migrateSqliteDatabase({ databasePath, authorityId: "authority-export", namespace: "test" }),
      ),
    );
    const source = await createSqliteAuthority<Snapshot, Command>({
      ...options,
      databasePath: sourcePath,
    });
    const target = await createSqliteAuthority<Snapshot, Command>({
      ...options,
      databasePath: targetPath,
    });
    const malformedTarget = await createSqliteAuthority<Snapshot, Command>({
      ...options,
      databasePath: malformedPath,
    });
    try {
      const firstEnvelope = {
        authorityId: "authority-export",
        currentHostId: "host-a",
        principalId: "operator",
        expectedGeneration: null,
        idempotencyKey: "first",
        requestDigest: "request-first",
        command: {
          snapshot: { dashboardSessions: [{ sessionId: "session-1" }] },
          result: { step: 1 },
        },
      };
      const first = await source.commit(firstEnvelope);
      expect(first.kind).toBe("committed");
      if (first.kind !== "committed") throw new Error("expected first commit");
      const second = await source.commit({
        ...firstEnvelope,
        expectedGeneration: first.generation,
        idempotencyKey: "second",
        requestDigest: "request-second",
        command: {
          snapshot: { dashboardSessions: [{ sessionId: "session-1" }] },
          result: { step: 2 },
        },
      });
      expect(second.kind).toBe("committed");
      if (second.kind !== "committed") throw new Error("expected second commit");
      expect(
        await source.commitAuxiliary({
          kind: "session_touch",
          sessionId: "session-1",
          expectedRevision: "",
          expectedGeneration: second.generation,
          lastUsedAt: "2026-01-01T00:00:00.000Z",
        }),
      ).toMatchObject({ kind: "applied", watermark: "1" });
      const beforeEvent = await source.exportState();
      expect(
        await source.commitAuxiliary({
          kind: "security_event",
          event: { kind: "rejected", occurredAt: "2026-01-01T00:00:01.000Z", code: "DENIED" },
        }),
      ).toMatchObject({ kind: "applied", watermark: "2" });

      const exported = await source.exportState();
      const unchanged = await source.exportState();
      expect(stableJsonStringify(unchanged)).toBe(stableJsonStringify(exported));
      expect(exported.generation.digest).toBe(beforeEvent.generation.digest);
      expect(stableJsonStringify(exported)).not.toBe(stableJsonStringify(beforeEvent));
      expect(exported.receipts?.map((receipt) => receipt.idempotencyKey)).toEqual([
        "first",
        "second",
      ]);
      expect(exported.auxiliary).toEqual({
        watermark: "2",
        sessions: {
          "session-1": { revision: "1", lastUsedAt: "2026-01-01T00:00:00.000Z", revoked: false },
        },
        securityEvents: [
          { kind: "rejected", occurredAt: "2026-01-01T00:00:01.000Z", code: "DENIED" },
        ],
        securityEventWatermarks: ["2"],
      });
      await target.restoreState(exported);
      const restored = await target.exportState();
      expect(restored.generation).toEqual(exported.generation);
      expect(restored.auxiliary).toEqual(exported.auxiliary);
      expect(restored.receipts).toHaveLength(2);
      expect(
        restored.receipts?.every((receipt) => receipt.generation.id === restored.generation.id),
      ).toBe(true);
      const replayed = await target.commit(firstEnvelope);
      expect(replayed.kind).toBe("replayed");
      if (replayed.kind !== "replayed") throw new Error("expected receipt replay");
      expect(replayed.receipt.generation.id).toBe(restored.generation.id);
      expect(await target.readAuxiliary({ kind: "session_touch", sessionId: "session-1" })).toEqual(
        {
          sessionId: "session-1",
          revision: "1",
          lastUsedAt: "2026-01-01T00:00:00.000Z",
          revoked: false,
        },
      );
      expect(
        await target.commitAuxiliary({ kind: "remove_session_touch", sessionId: "session-1" }),
      ).toMatchObject({ kind: "applied", watermark: "3" });
      expect(
        await target.readAuxiliary({ kind: "session_touch", sessionId: "session-1" }),
      ).toBeNull();
      expect(
        await target.commitAuxiliary({ kind: "remove_session_touch", sessionId: "session-1" }),
      ).toMatchObject({ kind: "unchanged", watermark: "3" });
      await expect(target.restoreState(exported)).rejects.toMatchObject({ code: "CONFIG_EXISTS" });

      const duplicate = structuredClone(exported);
      duplicate.receipts = [
        ...(duplicate.receipts ?? []),
        ...(duplicate.receipts ?? []).slice(0, 1),
      ];
      await expect(malformedTarget.restoreState(duplicate)).rejects.toMatchObject({
        code: "CONFIG_INVALID",
      });
      expect(await malformedTarget.readHead()).toBeNull();
    } finally {
      await source.close();
      await target.close();
      await malformedTarget.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
