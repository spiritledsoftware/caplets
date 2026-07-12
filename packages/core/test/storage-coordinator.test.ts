import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { CapletsEngine } from "../src/engine";
import { CapletsError } from "../src/errors";
import { RuntimeEpochCoordinator, assembleCapletsHost } from "../src/storage/coordinator";
import { createAsyncCapletsRuntime } from "../src/runtime";
import { createAsyncNativeCapletsService } from "../src/native/service";
import type {
  AuthorityGeneration,
  AuthorityGenerationIdentity,
  AuthorityHead,
  AuthorityHealth,
  WritableAuthority,
} from "../src/storage/types";
import type {
  ContentAddressedBundleCache,
  MaterializedAuthorityBundle,
} from "../src/storage/bundle-cache";
import type { AuthoritySnapshot } from "../src/storage/composition";
import type { CapletsConfig } from "../src/config";
import type { ExposureProjection } from "../src/exposure/projection";

const projection: ExposureProjection = {
  availability: { state: "ready" },
  entries: [],
  hiddenCaplets: [],
  routes: new Map(),
};

function generation(
  sequence: number,
  id: string,
  predecessorId: string | null,
): AuthorityGeneration<AuthoritySnapshot> {
  return {
    authorityId: "test-authority",
    id,
    sequence,
    predecessorId,
    schemaVersion: 1,
    digest: `digest-${id}`,
    committedAt: new Date(sequence).toISOString(),
    provenance: { provider: "filesystem", namespace: "default" },
    snapshot: {
      config: {
        version: 1,
        mcpServers: {
          [`caplet-${id}`]: {
            name: `Caplet ${id}`,
            description: "A valid test Caplet description.",
            command: process.execPath,
          },
        },
      },
    },
  };
}

function identity(generation: AuthorityGeneration<unknown>): AuthorityGenerationIdentity {
  return {
    authorityId: generation.authorityId,
    id: generation.id,
    sequence: generation.sequence,
    predecessorId: generation.predecessorId,
  };
}
function fakeAuthority(initial: AuthorityGeneration<AuthoritySnapshot>): {
  authority: WritableAuthority<AuthoritySnapshot, unknown>;
  setGeneration(generation: AuthorityGeneration<AuthoritySnapshot>): void;
  close: ReturnType<typeof vi.fn>;
} {
  let current = initial;
  const closed = vi.fn(async () => undefined);
  const authority: WritableAuthority<AuthoritySnapshot, unknown> = {
    readHead: vi.fn(
      async () =>
        ({
          authorityId: current.authorityId,
          id: current.id,
          sequence: current.sequence,
          predecessorId: current.predecessorId,
          digest: current.digest,
        }) satisfies AuthorityHead,
    ),
    readGeneration: vi.fn(async () => current),
    commit: vi.fn(),
    readAuxiliary: vi.fn(),
    commitAuxiliary: vi.fn(),
    health: vi.fn(
      async () =>
        ({
          provider: "filesystem",
          authorityId: "test-authority",
          connectivity: "healthy",
          writable: true,
          activeGeneration: {
            authorityId: current.authorityId,
            id: current.id,
            sequence: current.sequence,
            predecessorId: current.predecessorId,
          },
          refresh: "current",
        }) satisfies AuthorityHealth,
    ),
    exportState: vi.fn(),
    restoreState: vi.fn(),
    close: closed,
  };
  return { authority, setGeneration: (next) => (current = next), close: closed };
}

function testEngineFactory(closes: () => unknown) {
  return (config: CapletsConfig): CapletsEngine => {
    const engine = {
      currentConfig: () => config,
      exposureProjection: async () => ({ generation: 0, projection }),
      close: vi.fn(async () => closes()),
    } as unknown as CapletsEngine;
    return engine;
  };
}

describe("RuntimeEpochCoordinator", () => {
  it("fails closed before exposing a host when no committed generation exists", async () => {
    const fake = fakeAuthority(generation(1, "g1", null));
    fake.authority.readHead = vi.fn(async () => null);
    const coordinator = new RuntimeEpochCoordinator({
      authority: fake.authority,
      configPath: join(tmpdir(), "missing-u5-config.json"),
      engineFactory: testEngineFactory(vi.fn()),
      projectionFactory: async () => ({ generation: 1, projection }),
      autoRefresh: false,
    });

    await expect(coordinator.start()).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
      message: expect.stringContaining("fail-closed"),
    } satisfies Partial<CapletsError>);
    expect(coordinator.current).toBeUndefined();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("keeps one immutable epoch through a lease and retires it after activation", async () => {
    const first = generation(1, "g1", null);
    const second = generation(2, "g2", "g1");
    const fake = fakeAuthority(first);
    const closes = vi.fn();
    const coordinator = new RuntimeEpochCoordinator({
      authority: fake.authority,
      configPath: join(tmpdir(), "missing-u5-config.json"),
      engineFactory: testEngineFactory(closes),
      projectionFactory: async () => ({ generation: 1, projection }),
      autoRefresh: false,
    });

    const firstView = await coordinator.start();
    const lease = firstView.retain();
    expect(firstView.authorityGenerationId).toBe("g1");
    expect(firstView.inFlight).toBe(1);

    fake.setGeneration(second);
    await expect(coordinator.refresh()).resolves.toBe(true);
    const secondView = coordinator.requireCurrent();
    expect(secondView).not.toBe(firstView);
    expect(secondView.authorityGenerationId).toBe("g2");
    expect(firstView.isRetired).toBe(true);
    expect(firstView.isClosed).toBe(false);
    expect(closes).toHaveBeenCalledTimes(0);

    lease.release();
    await vi.waitFor(() => expect(firstView.isClosed).toBe(true));
    expect(closes).toHaveBeenCalledTimes(1);
    await coordinator.close();
  });

  it("accepts a valid authoritative head after skipped intermediate generations", async () => {
    const first = generation(1, "g1", null);
    const latest = generation(3, "g3", "g2");
    const fake = fakeAuthority(first);
    const coordinator = new RuntimeEpochCoordinator({
      authority: fake.authority,
      configPath: join(tmpdir(), "missing-u5-config.json"),
      engineFactory: testEngineFactory(vi.fn()),
      projectionFactory: async () => ({ generation: 1, projection }),
      autoRefresh: false,
    });

    await coordinator.start();
    fake.setGeneration(latest);

    await expect(coordinator.refresh()).resolves.toBe(true);
    expect(coordinator.requireCurrent().authorityGenerationId).toBe("g3");
    expect(coordinator.requireCurrent().authoritySequence).toBe(3);
    await coordinator.close();
  });

  it("acknowledges an active successor when refreshing at least an older generation", async () => {
    const first = generation(1, "g1", null);
    const successor = generation(2, "g2", "g1");
    const fake = fakeAuthority(first);
    const coordinator = new RuntimeEpochCoordinator({
      authority: fake.authority,
      configPath: join(tmpdir(), "missing-u5-config.json"),
      engineFactory: testEngineFactory(vi.fn()),
      projectionFactory: async () => ({ generation: 1, projection }),
      autoRefresh: false,
    });

    await coordinator.start();
    fake.setGeneration(successor);
    await expect(coordinator.refresh()).resolves.toBe(true);

    await expect(coordinator.refreshAtLeast(identity(first))).resolves.toMatchObject({
      status: "active",
      activeGeneration: { id: "g2", sequence: 2 },
    });
    await coordinator.close();
  });

  it("paces refreshAtLeast retries and bounds the retry window", async () => {
    vi.useFakeTimers();
    try {
      const first = generation(1, "g1", null);
      const requested = generation(2, "g2", "g1");
      const fake = fakeAuthority(first);
      const readTimes: number[] = [];
      const originalReadHead = fake.authority.readHead;
      fake.authority.readHead = vi.fn(async () => {
        readTimes.push(Date.now());
        return await originalReadHead();
      });
      const coordinator = new RuntimeEpochCoordinator({
        authority: fake.authority,
        configPath: join(tmpdir(), "missing-u5-config.json"),
        engineFactory: testEngineFactory(vi.fn()),
        projectionFactory: async () => ({ generation: 1, projection }),
        pollIntervalMs: 20,
        activationDeadlineMs: 50,
        readDeadlineMs: 50,
        autoRefresh: false,
      });

      await coordinator.start();
      const pending = coordinator.refreshAtLeast(identity(requested));
      await vi.advanceTimersByTimeAsync(0);
      const attemptsBeforeDelay = readTimes.length;
      expect(attemptsBeforeDelay).toBeGreaterThanOrEqual(2);

      await vi.advanceTimersByTimeAsync(19);
      expect(readTimes).toHaveLength(attemptsBeforeDelay);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(readTimes.length).toBeGreaterThan(attemptsBeforeDelay);

      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toMatchObject({ status: "pending" });
      for (let index = 2; index < readTimes.length; index += 1) {
        expect(readTimes[index]! - readTimes[index - 1]!).toBeGreaterThanOrEqual(20);
      }
      expect(readTimes.length).toBeLessThan(8);
      await coordinator.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases bundles when composition resolves after its deadline", async () => {
    vi.useFakeTimers();
    try {
      const first = generation(1, "g1", null);
      first.snapshot = {
        caplets: [
          {
            id: "late-bundle",
            bundle: {
              entryPath: "app/CAPLET.md",
              files: [
                {
                  path: "app/CAPLET.md",
                  content: "---\nname: App\nmcpServer:\n  command: ./tool.sh\n---\n",
                },
              ],
            },
          },
        ],
      };
      const fake = fakeAuthority(first);
      const materializing = Promise.withResolvers<MaterializedAuthorityBundle>();
      const release = vi.fn(async () => undefined);
      const root = join(tmpdir(), "late-bundle");
      const bytes = new TextEncoder().encode(
        "---\nname: App\nmcpServer:\n  command: ./tool.sh\n---\n",
      );
      const materialized: MaterializedAuthorityBundle = {
        root,
        entryPath: join(root, "app", "CAPLET.md"),
        fingerprint: "sha256:late-bundle",
        files: [
          {
            path: "app/CAPLET.md",
            bytes,
            length: bytes.byteLength,
            digest: "sha256:late-file",
          },
        ],
        release,
      };
      const bundleCache = {
        materialize: vi.fn(async () => await materializing.promise),
      } as unknown as ContentAddressedBundleCache;
      const coordinator = new RuntimeEpochCoordinator({
        authority: fake.authority,
        staged: [],
        stagedFingerprint: "sha256:empty",
        bundleCache,
        configPath: join(tmpdir(), "missing-u5-config.json"),
        activationDeadlineMs: 10,
        readDeadlineMs: 10,
        engineFactory: testEngineFactory(vi.fn()),
        projectionFactory: async () => ({ generation: 1, projection }),
        autoRefresh: false,
      });

      const starting = coordinator.start();
      void starting.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(bundleCache.materialize).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10);
      await expect(starting).rejects.toMatchObject({ code: "SERVER_START_TIMEOUT" });

      materializing.resolve(materialized);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes an engine that resolves after its activation deadline", async () => {
    vi.useFakeTimers();
    try {
      const first = generation(1, "g1", null);
      const fake = fakeAuthority(first);
      const activating = Promise.withResolvers<CapletsEngine>();
      const close = vi.fn(async () => undefined);
      const lateEngine = {
        currentConfig: () => first.snapshot.config,
        exposureProjection: async () => ({ generation: 1, projection }),
        close,
      } as unknown as CapletsEngine;
      const engineFactory = vi.fn(async () => await activating.promise);
      const coordinator = new RuntimeEpochCoordinator({
        authority: fake.authority,
        staged: [],
        stagedFingerprint: "sha256:empty",
        configPath: join(tmpdir(), "missing-u5-config.json"),
        activationDeadlineMs: 10,
        readDeadlineMs: 10,
        engineFactory,
        projectionFactory: async () => ({ generation: 1, projection }),
        autoRefresh: false,
      });

      const starting = coordinator.start();
      void starting.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(engineFactory).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10);
      await expect(starting).rejects.toMatchObject({ code: "SERVER_START_TIMEOUT" });

      activating.resolve(lateEngine);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces same-head refreshes and retains the last-known-good epoch on regression", async () => {
    const first = generation(4, "g4", null);
    const older = generation(3, "g3", null);
    const fake = fakeAuthority(first);
    const factory = vi.fn(testEngineFactory(vi.fn()));
    const coordinator = new RuntimeEpochCoordinator({
      authority: fake.authority,
      configPath: join(tmpdir(), "missing-u5-config.json"),
      engineFactory: factory,
      projectionFactory: async () => ({ generation: 1, projection }),
      autoRefresh: false,
    });

    const firstView = await coordinator.start();
    await expect(Promise.all([coordinator.refresh(), coordinator.refresh()])).resolves.toEqual([
      false,
      false,
    ]);
    expect(coordinator.requireCurrent()).toBe(firstView);
    expect(factory).toHaveBeenCalledOnce();

    fake.setGeneration(older);
    await expect(coordinator.refresh()).resolves.toBe(false);
    expect(coordinator.requireCurrent()).toBe(firstView);
    await expect(coordinator.health()).resolves.toMatchObject({
      readiness: "ready",
      connectivity: "degraded",
      writable: false,
      refresh: "failed",
      activeGeneration: { id: "g4", sequence: 4 },
    });
    await coordinator.close();
  });
});

describe("synchronous authority compatibility", () => {
  it("rejects shared authority bootstrap from synchronous config and engine APIs", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-u5-sync-"));
    const configPath = join(root, "config.json");
    const projectPath = join(root, "project", ".caplets", "config.json");
    await mkdir(join(root, "project", ".caplets"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        version: 1,
        authority: {
          provider: "sqlite",
          authorityId: "shared",
          namespace: "default",
          databasePath: join(root, "authority.sqlite"),
        },
        mcpServers: {
          alpha: {
            name: "Alpha",
            description: "A valid test Caplet description.",
            command: process.execPath,
          },
        },
      }),
    );
    await expect(() => loadConfig(configPath, projectPath)).toThrowError(
      expect.objectContaining({ code: "ASYNC_AUTHORITY_REQUIRED" }),
    );
    expect(
      () => new CapletsEngine({ configPath, projectConfigPath: projectPath, watch: false }),
    ).toThrowError(expect.objectContaining({ code: "ASYNC_AUTHORITY_REQUIRED" }));
  });

  it("assembles only after the first epoch and exposes a lease seam", async () => {
    const fake = fakeAuthority(generation(1, "g1", null));
    const host = await assembleCapletsHost({
      authority: fake.authority,
      configPath: join(tmpdir(), "missing-u5-config.json"),
      engineFactory: testEngineFactory(vi.fn()),
      projectionFactory: async () => ({ generation: 1, projection }),
      autoRefresh: false,
    });
    expect(host.view).toBe(host.coordinator.requireCurrent());
    const lease = host.retain();
    expect(lease.view).toBe(host.view);
    lease.release();
    await host.close();
  });
  it("builds runtime and native surfaces only after epoch preparation", async () => {
    const fake = fakeAuthority(generation(1, "g1", null));
    const runtimeHost = await createAsyncCapletsRuntime({
      authority: fake.authority,
      configPath: join(tmpdir(), "missing-u5-runtime-config.json"),
      autoRefresh: false,
    });
    expect(runtimeHost.runtime.currentConfig().mcpServers).toHaveProperty("caplet-g1");
    await runtimeHost.close();

    const nativeHost = await createAsyncNativeCapletsService({
      authority: fake.authority,
      configPath: join(tmpdir(), "missing-u5-native-config.json"),
      autoRefresh: false,
    });
    expect(nativeHost.service).toBeDefined();
    await nativeHost.close();
  });
});
