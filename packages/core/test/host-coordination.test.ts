import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostStorage, HostCoordinationStore, HostStorage } from "../src/storage";
import type { HostDatabase } from "../src/storage/types";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("host coordination", () => {
  it("rejects node parity drift and fences concurrent maintenance", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-coordination-"));
    directories.push(root);
    const path = join(root, "caplets.sqlite3");
    const first = await createHostStorage({ type: "sqlite", path });
    const second = await createHostStorage({ type: "sqlite", path });
    const now = new Date("2026-07-18T12:00:00.000Z");
    try {
      const nodeA = await first.coordination.registerNode({
        nodeId: "node-a",
        globalFileManifest: "manifest-a",
        runtimeFingerprint: "runtime-a",
        now,
      });
      const nodeB = await second.coordination.registerNode({
        nodeId: "node-b",
        globalFileManifest: "manifest-a",
        runtimeFingerprint: "runtime-a",
        now,
      });
      expect(nodeB).toMatchObject({ hostId: nodeA.hostId, ready: true, conflict: null });

      await expect(
        second.coordination.heartbeat({
          nodeId: "node-b",
          globalFileManifest: "manifest-b",
          runtimeFingerprint: "runtime-a",
          now,
        }),
      ).resolves.toMatchObject({ ready: false, conflict: "global_file_manifest" });
      await expect(
        second.coordination.heartbeat({
          nodeId: "node-b",
          globalFileManifest: "manifest-a",
          runtimeFingerprint: "runtime-a",
          now,
        }),
      ).resolves.toMatchObject({ ready: true, conflict: null });

      await expect(first.coordination.publishConfigGeneration("config-a", "node-a")).resolves.toBe(
        1,
      );
      await expect(second.coordination.currentConfigGeneration()).resolves.toBe(1);
      await expect(second.coordination.publishConfigGeneration("config-b", "node-b")).resolves.toBe(
        2,
      );
      await expect(first.coordination.currentConfigGeneration()).resolves.toBe(2);

      const leaseA = await first.coordination.acquireLease({
        leaseName: "asset-gc",
        ownerNodeId: "node-a",
        ttlMs: 5_000,
        now,
      });
      expect(leaseA).toMatchObject({ ownerNodeId: "node-a", fencingToken: 1 });
      await expect(
        second.coordination.acquireLease({
          leaseName: "asset-gc",
          ownerNodeId: "node-b",
          ttlMs: 5_000,
          now,
        }),
      ).resolves.toBeUndefined();

      const afterExpiry = new Date(now.getTime() + 6_000);
      const leaseB = await second.coordination.acquireLease({
        leaseName: "asset-gc",
        ownerNodeId: "node-b",
        ttlMs: 5_000,
        now: afterExpiry,
      });
      expect(leaseB).toMatchObject({ ownerNodeId: "node-b", fencingToken: 2 });
      await expect(
        first.coordination.checkpointLease({
          leaseName: "asset-gc",
          ownerNodeId: "node-a",
          fencingToken: 1,
          cursor: "obsolete",
          now: afterExpiry,
        }),
      ).rejects.toMatchObject({ details: { kind: "stale_lease" } });
      await expect(
        second.coordination.checkpointLease({
          leaseName: "asset-gc",
          ownerNodeId: "node-b",
          fencingToken: 2,
          cursor: "batch-1",
          now: afterExpiry,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("establishes LISTEN before reading the authoritative generation and wakes on notification", async () => {
    const fixture = fakePostgresCoordination();
    const wait = fixture.store.waitForConfigGeneration(0);
    await fixture.firstSelect.promise;
    expect(fixture.events.slice(0, 2)).toEqual([
      "LISTEN caplets_config_generation",
      "SELECT generation",
    ]);

    fixture.setGeneration(1);
    fixture.client.notify("caplets_config_generation");

    await expect(wait).resolves.toBe(1);
    expect(fixture.events).toContain("UNLISTEN caplets_config_generation");
    expect(fixture.client.released).toBe(true);
    await fixture.store.close();
  });

  it("polls after five seconds when a PostgreSQL notification is missed", async () => {
    vi.useFakeTimers();
    try {
      const fixture = fakePostgresCoordination();
      const wait = fixture.store.waitForConfigGeneration(0);
      let settled = false;
      void wait.then(() => {
        settled = true;
      });
      await fixture.firstSelect.promise;
      await Promise.resolve();
      fixture.setGeneration(2);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(wait).resolves.toBe(2);
      expect(fixture.client.released).toBe(true);
      await fixture.store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("unlistens and releases the pinned PostgreSQL client when storage closes", async () => {
    const fixture = fakePostgresCoordination();
    const closeDatabase = vi.fn(async () => {
      fixture.events.push("CLOSE database");
    });
    const storage = new HostStorage(
      fixture.database,
      closeDatabase,
      { type: "postgres", connectionString: "postgres://unused" },
      {},
      fixture.pool as never,
    );
    const wait = storage.coordination.waitForConfigGeneration(0);
    const rejected = expect(wait).rejects.toMatchObject({ name: "AbortError" });
    await fixture.firstSelect.promise;

    await storage.close();

    await rejected;
    expect(fixture.events).toContain("UNLISTEN caplets_config_generation");
    expect(fixture.events.indexOf("UNLISTEN caplets_config_generation")).toBeLessThan(
      fixture.events.indexOf("CLOSE database"),
    );
    expect(fixture.client.listenerCount).toBe(0);
    expect(fixture.client.released).toBe(true);
    expect(closeDatabase).toHaveBeenCalledOnce();
  });
});

class FakePostgresListenerClient {
  readonly queries: string[];
  released = false;
  private readonly listeners = new Set<(notification: { channel: string }) => void>();

  constructor(queries: string[]) {
    this.queries = queries;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  async query(queryText: string): Promise<void> {
    this.queries.push(queryText);
  }

  on(_event: "notification", listener: (notification: { channel: string }) => void): void {
    this.listeners.add(listener);
  }

  removeListener(
    _event: "notification",
    listener: (notification: { channel: string }) => void,
  ): void {
    this.listeners.delete(listener);
  }

  notify(channel: string): void {
    for (const listener of this.listeners) listener({ channel });
  }

  release(): void {
    this.released = true;
  }
}

function fakePostgresCoordination(): {
  store: HostCoordinationStore;
  database: HostDatabase;
  pool: { connect: () => Promise<FakePostgresListenerClient> };
  client: FakePostgresListenerClient;
  events: string[];
  firstSelect: PromiseWithResolvers<void>;
  setGeneration: (generation: number) => void;
} {
  let generation = 0;
  const events: string[] = [];
  const firstSelect = Promise.withResolvers<void>();
  const client = new FakePostgresListenerClient(events);
  const database = {
    dialect: "postgres",
    schema: "caplets",
    db: {
      select: () => ({
        from: () => ({
          orderBy: () => ({
            limit: async () => {
              events.push("SELECT generation");
              firstSelect.resolve();
              return [{ generation }];
            },
          }),
        }),
      }),
    },
  } as unknown as HostDatabase;
  const pool = {
    connect: async () => client,
  };
  return {
    store: new HostCoordinationStore(database, pool),
    database,
    pool,
    client,
    events,
    firstSelect,
    setGeneration: (nextGeneration) => {
      generation = nextGeneration;
    },
  };
}
