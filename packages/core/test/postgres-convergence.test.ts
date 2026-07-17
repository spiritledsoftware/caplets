import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlPlaneRepository } from "../src/control-plane/caplets/repository";
import type { MigrationEnvironment } from "../src/control-plane/dialect/migrations";
import { parseCanonicalHostSetting } from "../src/control-plane/model";
import {
  nearestRank,
  STORAGE_BENCHMARK_ENVELOPE,
} from "../src/control-plane/storage-benchmark-envelope";
import type {
  ControlPlaneRuntimeSnapshot,
  ControlPlaneRuntimeSnapshotLoader,
} from "../src/control-plane/snapshot";
import type { ControlPlaneStore } from "../src/control-plane/store";
import type { CurrentHostOperationBinding } from "../src/current-host/operations";
import type { ActivatedControlPlane } from "../src/control-plane/service";
import type { ControlPlaneWriterFence } from "../src/control-plane/types";
import { createActivatedControlPlane } from "../src/control-plane/service";
import {
  ACTIVATION_FINGERPRINT,
  ACTIVATION_IDENTITY,
  activationSnapshot,
  createActivationFixture,
} from "./helpers/control-plane-activation";
import {
  inspectPostgresControlPlaneFixtureCleanup,
  openPostgresControlPlaneFixture,
  type PostgresRuntimeNodeFixture,
} from "./fixtures/postgres-control-plane";

const DEADLINES = Object.freeze({ detectionMs: 100, compositionMs: 200, publicationMs: 100 });
const POSTGRES_URL = process.env.CAPLETS_TEST_POSTGRES_URL;
const POSTGRES_ASSET_ROOT = resolve(import.meta.dirname, "..", "drizzle");
const POSTGRES_ROLE_PREFIX = "caplets_u10_convergence";
const POSTGRES_NODE_COUNT = STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes;
const CONVERGENCE_SAMPLE_COUNT = POSTGRES_NODE_COUNT * STORAGE_BENCHMARK_ENVELOPE.writeBurstSeconds;
const WRITE_BURST_TOTAL =
  STORAGE_BENCHMARK_ENVELOPE.managementWritesPerSecond *
  STORAGE_BENCHMARK_ENVELOPE.writeBurstSeconds;
const POSTGRES_MANAGEMENT_SETTING_KEYS = [
  "native.daemon-url",
  "telemetry",
  "options.defaultSearchLimit",
  "options.maxSearchLimit",
  "options.exposureDiscoveryTimeoutMs",
  "options.exposureDiscoveryConcurrency",
  "options.completion.discoveryTimeoutMs",
  "options.completion.overallTimeoutMs",
  "options.completion.cacheTtlMs",
  "options.completion.negativeCacheTtlMs",
] as const;
const REAL_POSTGRES_POLLING_MS = 1_000;
const REAL_POSTGRES_DEADLINES = Object.freeze({
  detectionMs: 500,
  compositionMs: 1_000,
  publicationMs: 500,
});
const POSTGRES_MIGRATION_ENVIRONMENT: MigrationEnvironment = Object.freeze({
  binaryVersion: "0.34.1",
  supportedSchemaVersion: 1,
  keyVersion: 1,
  manifestVersion: 1,
  verifiedSchemaAwareBackup: true,
  oldNodesDrained: true,
  retainedKeyVersions: [1],
  activationEvidence: { kind: "empty-bootstrap" as const },
  hostAdministrator: true,
  now: new Date("2026-07-16T00:00:00.000Z"),
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Postgres control-plane convergence", () => {
  it("converges by ordered tuple polling when notifications are suppressed", async () => {
    vi.useFakeTimers();
    const fixture = createActivationFixture();
    const activated = await createActivatedControlPlane({
      store: fixture.store,
      loader: fixture.loader,
      node: fixture.node,
      pollingIntervalMs: 25,
      deadlines: DEADLINES,
    });

    fixture.setToken({ authorityGeneration: 0, effectiveGeneration: 1, securityEpoch: 0 });
    await vi.advanceTimersByTimeAsync(25);

    expect(activated.current()).toMatchObject({
      authorityGeneration: 0,
      effectiveGeneration: 1,
      securityEpoch: 0,
    });
    expect(fixture.stats()).toEqual({ reloadCount: 1, commitCount: 1 });
    await activated.close();
  });

  it("ignores out-of-order notification payloads and never regresses the authoritative tuple", async () => {
    const fixture = createActivationFixture();
    const activated = await createActivatedControlPlane({
      store: fixture.store,
      loader: fixture.loader,
      node: fixture.node,
      pollingIntervalMs: 4_000,
      deadlines: DEADLINES,
    });

    fixture.setToken({ authorityGeneration: 2, effectiveGeneration: 4, securityEpoch: 1 });
    fixture.notify({ authorityGeneration: 1, effectiveGeneration: 9, securityEpoch: 0 });
    await activated.refresh();

    expect(activated.current()).toMatchObject({
      authorityGeneration: 2,
      effectiveGeneration: 4,
      securityEpoch: 1,
    });
    await activated.close();
  });

  it("coalesces a burst to one queued refresh without starving a newer complete generation", async () => {
    const fixture = createActivationFixture();
    const activated = await createActivatedControlPlane({
      store: fixture.store,
      loader: fixture.loader,
      node: fixture.node,
      pollingIntervalMs: 4_000,
      deadlines: DEADLINES,
    });
    const gate = Promise.withResolvers<void>();
    fixture.setReloadGate(gate.promise);
    fixture.setToken({ authorityGeneration: 0, effectiveGeneration: 1, securityEpoch: 0 }, "first");
    const first = activated.refresh();
    await fixture.waitForFirstReload();
    fixture.setToken(
      { authorityGeneration: 0, effectiveGeneration: 2, securityEpoch: 0 },
      "second",
    );
    const second = activated.refresh();
    const coalesced = activated.refresh();
    expect(coalesced).toBe(second);
    gate.resolve();

    await expect(first).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
    await expect(Promise.all([second, coalesced])).resolves.toHaveLength(2);
    expect(activated.current()).toMatchObject({ effectiveGeneration: 2 });
    expect(fixture.stats()).toEqual({ reloadCount: 2, commitCount: 1 });
    await activated.close();
  });

  it("restores the active publication before converging a queued superseding generation", async () => {
    const fixture = createActivationFixture();
    const revokeNode = vi.spyOn(fixture.store, "revokeNode");
    vi.spyOn(fixture.store, "acknowledgeNode").mockImplementation(async (input) => {
      const observed = await fixture.store.convergenceToken();
      if (input.appliedToken.effectiveGeneration < observed.effectiveGeneration) {
        return { status: "rejected", reason: "token-behind" };
      }
      return { status: "applied", appliedNodes: 1 };
    });
    const published: number[] = [];
    let newestRefresh: Promise<ControlPlaneRuntimeSnapshot> | undefined;
    const activated = await createActivatedControlPlane({
      store: fixture.store,
      loader: fixture.loader,
      node: fixture.node,
      pollingIntervalMs: 4_000,
      deadlines: DEADLINES,
      async publish(snapshot) {
        published.push(snapshot.effectiveGeneration);
        if (snapshot.effectiveGeneration !== 1) return;
        fixture.setToken(
          { authorityGeneration: 0, effectiveGeneration: 2, securityEpoch: 0 },
          "newest",
        );
        newestRefresh = activated.refresh();
      },
    });
    fixture.setToken(
      { authorityGeneration: 0, effectiveGeneration: 1, securityEpoch: 0 },
      "superseded",
    );

    await expect(activated.refresh()).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
      message: expect.stringContaining("superseded"),
    });
    await expect(newestRefresh).resolves.toMatchObject({ effectiveGeneration: 2 });
    expect(published).toEqual([1, 0, 2]);
    expect(revokeNode).not.toHaveBeenCalled();
    expect(activated.current()).toMatchObject({ effectiveGeneration: 2 });
    await activated.close();
  });

  it("converges intermediate tokens during a sustained 100 writes per second stream", async () => {
    vi.useFakeTimers();
    const fixture = createActivationFixture();
    const registerNode = vi.spyOn(fixture.store, "registerNode");
    const committedAt = new Map<number, number>();
    const latencies: number[] = [];
    const detectionLatencies: number[] = [];
    const compositionLatencies: number[] = [];
    const publicationLatencies: number[] = [];
    const measuredStore: ControlPlaneStore = {
      ...fixture.store,
      async convergenceToken() {
        const startedAt = Date.now();
        try {
          return await fixture.store.convergenceToken();
        } finally {
          detectionLatencies.push(Date.now() - startedAt);
        }
      },
    };
    const measuredLoader: ControlPlaneRuntimeSnapshotLoader = {
      ...fixture.loader,
      async reload(context) {
        const startedAt = Date.now();
        try {
          return await fixture.loader.reload(context);
        } finally {
          compositionLatencies.push(Date.now() - startedAt);
        }
      },
    };
    let nextUnmeasuredGeneration = 1;
    const activated = await createActivatedControlPlane({
      store: measuredStore,
      loader: measuredLoader,
      node: fixture.node,
      pollingIntervalMs: 4_000,
      deadlines: DEADLINES,
      async publish(snapshot) {
        const publicationStartedAt = Date.now();
        while (nextUnmeasuredGeneration <= snapshot.effectiveGeneration) {
          const startedAt = committedAt.get(nextUnmeasuredGeneration);
          if (startedAt !== undefined) latencies.push(Date.now() - startedAt);
          nextUnmeasuredGeneration += 1;
        }
        publicationLatencies.push(Date.now() - publicationStartedAt);
      },
    });

    for (let generation = 1; generation <= 100; generation += 1) {
      const token = { authorityGeneration: 0, effectiveGeneration: generation, securityEpoch: 0 };
      committedAt.set(generation, Date.now());
      fixture.setToken(token, `continuous-${generation}`);
      fixture.notify(token);
      await vi.advanceTimersByTimeAsync(10);
      if (generation === 50) {
        expect(activated.current().effectiveGeneration).toBeGreaterThan(0);
        expect(activated.current().effectiveGeneration).toBeLessThanOrEqual(50);
      }
    }
    await activated.refresh();

    expect(activated.current().effectiveGeneration).toBe(100);
    expect(latencies).toHaveLength(100);
    expect(nearestRank(latencies, 0.99)).toBeLessThanOrEqual(
      STORAGE_BENCHMARK_ENVELOPE.maxConvergenceP99Ms,
    );
    for (const samples of [detectionLatencies, compositionLatencies, publicationLatencies]) {
      expect(samples.length).toBeGreaterThan(0);
      expect(nearestRank(samples, 0.99)).toBeLessThanOrEqual(
        STORAGE_BENCHMARK_ENVELOPE.maxConvergenceP99Ms,
      );
    }
    expect(registerNode).toHaveBeenCalledTimes(1);
    await activated.close();
  });

  it("fails a stage at its hard deadline rather than publishing nominal readiness", async () => {
    vi.useFakeTimers();
    const fixture = createActivationFixture();
    fixture.setReloadGate(Promise.withResolvers<void>().promise);
    const activated = await createActivatedControlPlane({
      store: fixture.store,
      loader: fixture.loader,
      node: fixture.node,
      pollingIntervalMs: 4_000,
      deadlines: { detectionMs: 20, compositionMs: 30, publicationMs: 20 },
    });
    fixture.setToken({ authorityGeneration: 0, effectiveGeneration: 1, securityEpoch: 0 });

    const pending = activated.refresh();
    await vi.advanceTimersByTimeAsync(30);
    await expect(pending).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
    expect(activated.current()).toMatchObject({ effectiveGeneration: 0 });
    await expect(activated.requireLive("mutation")).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
    await activated.close();
  });
  it("rejects an unapproved fingerprint without occupying the staged rollout slot", async () => {
    const fixture = createActivationFixture();
    fixture.setCurrentFingerprint("b".repeat(64));

    await expect(
      createActivatedControlPlane({
        store: fixture.store,
        loader: fixture.loader,
        node: fixture.node,
        pollingIntervalMs: 4_000,
        deadlines: DEADLINES,
      }),
    ).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
      message: expect.stringContaining("not compatible"),
    });
    expect(fixture.node.bootstrapFingerprint).toBe(ACTIVATION_FINGERPRINT);
    expect(fixture.stageCount()).toBe(0);
  });

  it("bounds persisted lease cleanup when the database remains unavailable", async () => {
    vi.useFakeTimers();
    const fixture = createActivationFixture();
    const activated = await createActivatedControlPlane({
      store: fixture.store,
      loader: fixture.loader,
      node: fixture.node,
      pollingIntervalMs: 4_000,
      deadlines: { detectionMs: 20, compositionMs: 30, publicationMs: 20 },
    });
    fixture.setConnectivityFailure(true);
    fixture.setRevokeGate(Promise.withResolvers<void>().promise);

    const denied = expect(activated.requireLive("mutation")).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
    await vi.advanceTimersByTimeAsync(20);
    await denied;
    const closed = activated.close();
    await vi.advanceTimersByTimeAsync(20);
    await closed;
  });
});

type NotificationSuppressionStats = {
  subscriptionAttempts: number;
  deliveredNotifications: number;
  unsubscriptions: number;
};

// Opt in with:
// CAPLETS_TEST_POSTGRES_URL=postgres://... pnpm --filter @caplets/core exec vitest run test/postgres-convergence.test.ts
describe.sequential("real Postgres convergence and capacity", () => {
  it.skipIf(!POSTGRES_URL)(
    "sustains management-grade writes while 16 independent nodes converge by polling within p99",
    async () => {
      if (!POSTGRES_URL) throw new Error("Postgres fixture URL is unavailable");
      const fixture = await openPostgresControlPlaneFixture({
        adminUrl: POSTGRES_URL,
        assetRoot: POSTGRES_ASSET_ROOT,
        identity: ACTIVATION_IDENTITY,
        environment: POSTGRES_MIGRATION_ENVIRONMENT,
        rolePrefix: POSTGRES_ROLE_PREFIX,
        keyProviderManifest: "/tmp/caplets-u10-postgres-key-provider.json",
      });
      const runtimeNodes: PostgresRuntimeNodeFixture[] = [];
      const servicesByNode: Array<ActivatedControlPlane | undefined> = Array.from({
        length: POSTGRES_NODE_COUNT,
      });
      const storesByNode: Array<ControlPlaneStore | undefined> = Array.from({
        length: POSTGRES_NODE_COUNT,
      });
      const notificationStats: NotificationSuppressionStats = {
        subscriptionAttempts: 0,
        deliveredNotifications: 0,
        unsubscriptions: 0,
      };
      let writerPollingHeld = false;
      let fixtureClosed = false;
      let finalP99Ms = Number.NaN;
      let measuredLatencies: readonly number[] = [];
      let publicationP99Ms = Number.NaN;
      const publicationLatencies: number[] = [];
      const publishedByNode: Array<ControlPlaneRuntimeSnapshot | undefined> = Array.from({
        length: POSTGRES_NODE_COUNT,
      });
      let writesPerSecond = Number.NaN;

      try {
        const coordinator = createControlPlaneRepository({
          identity: ACTIVATION_IDENTITY,
          dialect: fixture.dialect,
        });
        const initialToken = await coordinator.initialize();
        await coordinator.stageNextFingerprint(ACTIVATION_FINGERPRINT);

        for (let index = 0; index < POSTGRES_NODE_COUNT; index += 1) {
          runtimeNodes.push(await fixture.openRuntimeNode());
        }
        const backendPids = await Promise.all(
          runtimeNodes.map(async ({ dialect }) => {
            const [row] = await dialect.query<{ backendPid: number }>(
              `SELECT pg_backend_pid()::integer AS "backendPid"`,
            );
            if (!row) throw new Error("Postgres runtime pool probe returned no row");
            return row.backendPid;
          }),
        );
        expect(new Set(runtimeNodes.map(({ dialect }) => dialect)).size).toBe(POSTGRES_NODE_COUNT);
        expect(new Set(backendPids).size).toBe(POSTGRES_NODE_COUNT);

        const startNode = async (nodeIndex: number) => {
          const runtimeNode = runtimeNodes[nodeIndex];
          if (!runtimeNode) throw new Error(`Postgres runtime node ${nodeIndex} is unavailable`);
          const sourceStore = createControlPlaneRepository({
            identity: ACTIVATION_IDENTITY,
            dialect: runtimeNode.dialect,
          });
          storesByNode[nodeIndex] = sourceStore;
          const pollingStore = suppressPostgresNotifications(
            sourceStore,
            notificationStats,
            nodeIndex === 0
              ? async () =>
                  writerPollingHeld ? initialToken : await sourceStore.convergenceToken()
              : undefined,
          );
          const loader = createPostgresPollingLoader(pollingStore);
          const activated = await createActivatedControlPlane({
            store: pollingStore,
            loader,
            node: {
              nodeId: `postgres-convergence-${nodeIndex + 1}`,
              bootstrapFingerprint: ACTIVATION_FINGERPRINT,
              compatibility: {
                ...runtimeNode.dialect.compatibility,
                providerCommitment: "1".repeat(64),
                keyCanaryCommitment: "2".repeat(64),
                capabilities: ["ordered-tuple-polling", "writer-fence-v1", "complete-snapshot-v1"],
              },
              ttlMs: 120_000,
            },
            pollingIntervalMs: REAL_POSTGRES_POLLING_MS,
            deadlines: REAL_POSTGRES_DEADLINES,
            publish(snapshot, publication) {
              if (publication.signal.aborted) return;
              const startedAt = performance.now();
              publishedByNode[nodeIndex] = snapshot;
              publicationLatencies.push(performance.now() - startedAt);
            },
          });
          servicesByNode[nodeIndex] = activated;
        };

        for (let nodeIndex = 1; nodeIndex < POSTGRES_NODE_COUNT; nodeIndex += 1) {
          await startNode(nodeIndex);
        }
        await startNode(0);

        const services = servicesByNode.filter(
          (service): service is ActivatedControlPlane => service !== undefined,
        );
        expect(services).toHaveLength(POSTGRES_NODE_COUNT);
        expect(new Set(services).size).toBe(POSTGRES_NODE_COUNT);
        expect(new Set(storesByNode).size).toBe(POSTGRES_NODE_COUNT);
        expect(notificationStats).toMatchObject({
          subscriptionAttempts: POSTGRES_NODE_COUNT,
          deliveredNotifications: 0,
        });
        await expectReadyNodeCount(fixture, POSTGRES_NODE_COUNT);
        publicationLatencies.length = 0;
        const managementNodes = await Promise.all(
          POSTGRES_MANAGEMENT_SETTING_KEYS.map(() => fixture.openRuntimeNode()),
        );
        runtimeNodes.push(...managementNodes);
        const managementStores = managementNodes.map(({ dialect }) =>
          createControlPlaneRepository({ identity: ACTIVATION_IDENTITY, dialect }),
        );
        await Promise.all(managementStores.map((store) => store.initialize()));

        const latencyPromises: Promise<readonly number[]>[] = [];
        const phaseMs = { requireLive: 0, reserve: 0, mutate: 0, token: 0, refresh: 0 };
        const writeBurstStartedAt = performance.now();
        for (let second = 0; second < STORAGE_BENCHMARK_ENVELOPE.writeBurstSeconds; second += 1) {
          const scheduledAt = writeBurstStartedAt + second * 1_000;
          const scheduleDelayMs = scheduledAt - performance.now();
          // This is a real Postgres pacing proof; fake timers cannot schedule external DB work.
          if (scheduleDelayMs > 0) await delay(scheduleDelayMs);
          const batchOffset = second * STORAGE_BENCHMARK_ENVELOPE.managementWritesPerSecond;
          let phaseStartedAt = performance.now();
          const writerService = servicesByNode[1];
          if (!writerService) throw new Error("Postgres management writer is unavailable");
          const writerFence = await waitForLiveFence(writerService);
          const writerContexts = managementStores.map((store) => ({
            store,
            service: writerService,
            writerFence,
          }));
          phaseMs.requireLive += performance.now() - phaseStartedAt;
          const writes = Array.from(
            { length: STORAGE_BENCHMARK_ENVELOPE.managementWritesPerSecond },
            (_, writeIndex) => {
              const effectiveIndex = batchOffset + writeIndex;
              const settingIndex = effectiveIndex % POSTGRES_MANAGEMENT_SETTING_KEYS.length;
              const writer = writerContexts[settingIndex];
              if (!writer) throw new Error(`Postgres writer ${settingIndex} is unavailable`);
              const operationId = `postgres-convergence-write-${effectiveIndex}`;
              const setting = postgresManagementSetting(effectiveIndex);
              const binding = postgresBinding(operationId, `write-${effectiveIndex}`);
              return {
                effectiveIndex,
                settingIndex,
                store: writer.store,
                service: writer.service,
                input: {
                  binding,
                  aggregateId: setting.key,
                  expectedAggregateVersion: Math.floor(
                    effectiveIndex / POSTGRES_MANAGEMENT_SETTING_KEYS.length,
                  ),
                  expectedAuthorityGeneration: initialToken.authorityGeneration,
                  expectedSecurityEpoch: initialToken.securityEpoch,
                  writerFence: writer.writerFence,
                  activity: {
                    id: `postgres-convergence-activity-${effectiveIndex}`,
                    action: "host-setting.update",
                    target: { key: setting.key },
                  },
                  setting,
                  provenance: {
                    id: `postgres-convergence-provenance-${effectiveIndex}`,
                    sourceKind: "postgres-convergence-test",
                    source: { fixture: "u10-real-postgres", effectiveIndex },
                    contentHash: effectiveIndex.toString(16).padStart(64, "0"),
                    installedAt: "2026-07-16T00:00:00.000Z",
                    ownerId: "operator-1",
                  },
                },
              } as const;
            },
          );
          phaseStartedAt = performance.now();
          await Promise.all(
            writerContexts.map(async (writer, settingIndex) => {
              for (const write of writes) {
                if (write.settingIndex !== settingIndex) continue;
                await writer.store.reserveOperation(write.input.binding, write.input.aggregateId);
              }
            }),
          );
          phaseMs.reserve += performance.now() - phaseStartedAt;
          phaseStartedAt = performance.now();
          const aggregateVersions = [
            ...new Set(writes.map((write) => write.input.expectedAggregateVersion)),
          ].toSorted((left, right) => left - right);
          for (const aggregateVersion of aggregateVersions) {
            await Promise.all(
              writes
                .filter((write) => write.input.expectedAggregateVersion === aggregateVersion)
                .map(async (write) => {
                  let input = write.input;
                  const deadlineAt =
                    performance.now() + STORAGE_BENCHMARK_ENVELOPE.maxConvergenceP99Ms;
                  while (true) {
                    const result = await write.store.mutateHostSetting(input);
                    if (result.status === "committed") return;
                    if (
                      result.status === "conflict" &&
                      result.reason === "writer-fence" &&
                      performance.now() < deadlineAt
                    ) {
                      input = {
                        ...input,
                        writerFence: await waitForLiveFence(write.service),
                      };
                      continue;
                    }
                    if (result.status !== "unavailable" || performance.now() >= deadlineAt) {
                      throw new Error(
                        `Management write ${write.effectiveIndex} did not commit: ${JSON.stringify(result)}`,
                      );
                    }
                    await delay(10);
                  }
                }),
            );
          }
          phaseMs.mutate += performance.now() - phaseStartedAt;
          const commitBoundaryMs = performance.now();
          const primaryWriter = writerContexts[0];
          if (!primaryWriter) throw new Error("Postgres primary writer is unavailable");
          phaseStartedAt = performance.now();
          const committedToken = await primaryWriter.store.convergenceToken();
          phaseMs.token += performance.now() - phaseStartedAt;
          const targetGeneration =
            initialToken.effectiveGeneration +
            batchOffset +
            STORAGE_BENCHMARK_ENVELOPE.managementWritesPerSecond;
          expect(committedToken.effectiveGeneration).toBe(targetGeneration);
          latencyPromises.push(
            waitForAllPublications(publishedByNode, targetGeneration, commitBoundaryMs),
          );
          phaseStartedAt = performance.now();
          void primaryWriter.service.refresh().catch(() => undefined);
          phaseMs.refresh += performance.now() - phaseStartedAt;
        }
        writesPerSecond = (WRITE_BURST_TOTAL * 1_000) / (performance.now() - writeBurstStartedAt);

        writerPollingHeld = false;
        await Promise.all(services.map((service) => service.refresh()));
        measuredLatencies = (await Promise.all(latencyPromises)).flat();
        finalP99Ms = nearestRank(measuredLatencies, 0.99);
        publicationP99Ms = nearestRank(publicationLatencies, 0.99);
        if (process.env.CAPLETS_BENCHMARK_REPORT === "1") {
          process.stdout.write(
            `real Postgres management-grade phases: ${JSON.stringify(phaseMs)} ` +
              `rate=${writesPerSecond.toFixed(1)}/s convergenceP99=${finalP99Ms.toFixed(1)}ms ` +
              `publicationP99=${publicationP99Ms.toFixed(1)}ms\n`,
          );
        }
        expect(measuredLatencies).toHaveLength(CONVERGENCE_SAMPLE_COUNT);
        expect(finalP99Ms).toBeLessThanOrEqual(STORAGE_BENCHMARK_ENVELOPE.maxConvergenceP99Ms);
        expect(publicationP99Ms).toBeLessThanOrEqual(REAL_POSTGRES_DEADLINES.publicationMs);
        expect(publicationLatencies.length).toBeGreaterThanOrEqual(POSTGRES_NODE_COUNT);
        expect(writesPerSecond).toBeGreaterThanOrEqual(
          STORAGE_BENCHMARK_ENVELOPE.minimumMeasuredManagementWritesPerSecond,
        );
        const finalGeneration = initialToken.effectiveGeneration + WRITE_BURST_TOTAL;
        await waitForAllCurrentSnapshots(services, finalGeneration);
        expect(
          services.every((service) => service.current().effectiveGeneration === finalGeneration),
        ).toBe(true);

        const rejectedNode = await fixture.openRuntimeNode();
        runtimeNodes.push(rejectedNode);
        const rejectedStore = createControlPlaneRepository({
          identity: ACTIVATION_IDENTITY,
          dialect: rejectedNode.dialect,
        });
        const rejectedLoader = createPostgresPollingLoader(rejectedStore);
        await expect(
          createActivatedControlPlane({
            store: suppressPostgresNotifications(rejectedStore, notificationStats),
            loader: rejectedLoader,
            node: {
              nodeId: "postgres-convergence-17",
              bootstrapFingerprint: ACTIVATION_FINGERPRINT,
              compatibility: {
                ...rejectedNode.dialect.compatibility,
                providerCommitment: "1".repeat(64),
                keyCanaryCommitment: "2".repeat(64),
                capabilities: ["ordered-tuple-polling", "writer-fence-v1", "complete-snapshot-v1"],
              },
              ttlMs: 60_000,
            },
            pollingIntervalMs: REAL_POSTGRES_POLLING_MS,
            deadlines: REAL_POSTGRES_DEADLINES,
          }),
        ).rejects.toMatchObject({
          code: "SERVER_UNAVAILABLE",
          message: expect.stringContaining("capacity-rejected"),
        });
        await expectReadyNodeCount(fixture, POSTGRES_NODE_COUNT);
        await expect(
          fixture.adminQuery<{ state: string; fenceState: string | null }>(
            `SELECT n.state, f.state AS "fenceState"
             FROM caplets.cp_cluster_node_lease n
             LEFT JOIN caplets.cp_writer_fence f
               ON f.logical_host_id = n.logical_host_id
              AND f.store_id = n.store_id
              AND f.lease_id = 'writer:postgres-convergence-17'
             WHERE n.node_id = $1`,
            ["postgres-convergence-17"],
          ),
        ).resolves.toEqual([{ state: "capacity-rejected", fenceState: null }]);

        process.stdout.write(
          `real Postgres convergence: nodes=${POSTGRES_NODE_COUNT} ` +
            `writes=${WRITE_BURST_TOTAL} rate=${writesPerSecond.toFixed(1)}/s ` +
            `convergenceP99=${finalP99Ms.toFixed(1)}ms ` +
            `publicationP99=${publicationP99Ms.toFixed(1)}ms notifications=0 ` +
            `node17=capacity-rejected fence=none\n`,
        );
      } finally {
        writerPollingHeld = false;
        await Promise.all(
          servicesByNode
            .filter((service): service is ActivatedControlPlane => service !== undefined)
            .map((service) => service.close().catch(() => undefined)),
        );
        await Promise.all(runtimeNodes.map((node) => node.close().catch(() => undefined)));
        await fixture.close();
        fixtureClosed = true;
      }

      expect(fixtureClosed).toBe(true);
      expect(notificationStats.unsubscriptions).toBe(POSTGRES_NODE_COUNT);
      expect(Number.isFinite(finalP99Ms)).toBe(true);
      expect(measuredLatencies).toHaveLength(CONVERGENCE_SAMPLE_COUNT);
      expect(Number.isFinite(writesPerSecond)).toBe(true);
      expect(Number.isFinite(publicationP99Ms)).toBe(true);
      await expect(
        inspectPostgresControlPlaneFixtureCleanup(POSTGRES_URL, POSTGRES_ROLE_PREFIX),
      ).resolves.toEqual({ schemaPresent: false, roles: [] });
    },
    120_000,
  );
});

function suppressPostgresNotifications(
  store: ControlPlaneStore,
  stats: NotificationSuppressionStats,
  convergenceToken?: ControlPlaneStore["convergenceToken"],
): ControlPlaneStore {
  return Object.freeze({
    ...store,
    ...(convergenceToken ? { convergenceToken } : {}),
    async subscribeToChanges() {
      stats.subscriptionAttempts += 1;
      return async () => {
        stats.unsubscriptions += 1;
      };
    },
  });
}

function createPostgresPollingLoader(
  store: ControlPlaneStore,
  onCommit?: (effectiveGeneration: number) => void,
): ControlPlaneRuntimeSnapshotLoader {
  let current: ControlPlaneRuntimeSnapshot | undefined;
  const compose = async () => {
    const token = await store.convergenceToken();
    return activationSnapshot(token, token.effectiveGeneration.toString());
  };
  return Object.freeze({
    async initialize() {
      current ??= await compose();
      return current;
    },
    reload: compose,
    commit(candidate) {
      if (current && compareSnapshotTuple(current, candidate) > 0) return false;
      current = candidate;
      onCommit?.(candidate.effectiveGeneration);
      return true;
    },
    current() {
      if (!current) throw new Error("Postgres polling loader is not initialized");
      return current;
    },
  });
}

function compareSnapshotTuple(
  left: Readonly<{
    authorityGeneration: number;
    effectiveGeneration: number;
    securityEpoch: number;
  }>,
  right: Readonly<{
    authorityGeneration: number;
    effectiveGeneration: number;
    securityEpoch: number;
  }>,
): number {
  return (
    left.authorityGeneration - right.authorityGeneration ||
    left.effectiveGeneration - right.effectiveGeneration ||
    left.securityEpoch - right.securityEpoch
  );
}
async function waitForLiveFence(service: ActivatedControlPlane): Promise<ControlPlaneWriterFence> {
  const deadlineAt = performance.now() + STORAGE_BENCHMARK_ENVELOPE.maxConvergenceP99Ms;
  let lastError: unknown;
  while (performance.now() < deadlineAt) {
    try {
      return await service.requireLive("mutation");
    } catch (error) {
      lastError = error;
      try {
        await service.refresh();
      } catch (refreshError) {
        lastError = refreshError;
      }
      await delay(25);
    }
  }
  throw lastError;
}

function postgresManagementSetting(effectiveIndex: number) {
  const key =
    POSTGRES_MANAGEMENT_SETTING_KEYS[effectiveIndex % POSTGRES_MANAGEMENT_SETTING_KEYS.length];
  if (!key) throw new Error(`Postgres management setting ${effectiveIndex} is unavailable`);
  let value: unknown;
  switch (key) {
    case "native.daemon-url":
      value = { source: "setup", url: `http://127.0.0.1:${7_000 + effectiveIndex}` };
      break;
    case "telemetry":
      value = effectiveIndex % 2 === 0;
      break;
    case "options.maxSearchLimit":
      value = (effectiveIndex % 50) + 1;
      break;
    case "options.exposureDiscoveryConcurrency":
      value = (effectiveIndex % 32) + 1;
      break;
    case "options.completion.cacheTtlMs":
    case "options.completion.negativeCacheTtlMs":
      value = effectiveIndex;
      break;
    default:
      value = effectiveIndex + 1;
  }
  return parseCanonicalHostSetting({
    version: 1,
    key,
    value,
    updatedAt: new Date(Date.UTC(2026, 6, 16, 0, 0, 0, effectiveIndex)).toISOString(),
  });
}

function postgresBinding(
  operationId: string,
  requestIdentity: string,
): CurrentHostOperationBinding {
  return {
    operationId,
    target: "global",
    logicalHostId: ACTIVATION_IDENTITY.logicalHostId,
    storeId: ACTIVATION_IDENTITY.storeId,
    operationNamespace: ACTIVATION_IDENTITY.operationNamespace,
    actorId: "operator-1",
    requestIdentity,
    operationClass: "logical-state",
  };
}

async function waitForAllCurrentSnapshots(
  services: readonly ActivatedControlPlane[],
  generation: number,
): Promise<void> {
  const deadline = performance.now() + STORAGE_BENCHMARK_ENVELOPE.maxConvergenceP99Ms;
  while (services.some((service) => service.current().effectiveGeneration < generation)) {
    if (performance.now() >= deadline) {
      throw new Error(`Postgres nodes did not commit effective generation ${generation}`);
    }
    await delay(10);
  }
}

async function waitForAllPublications(
  publishedByNode: readonly (ControlPlaneRuntimeSnapshot | undefined)[],
  generation: number,
  commitBoundaryMs: number,
): Promise<readonly number[]> {
  const deadline = performance.now() + STORAGE_BENCHMARK_ENVELOPE.maxConvergenceP99Ms;
  const observedLatencies: Array<number | undefined> = Array.from({
    length: publishedByNode.length,
  });
  while (observedLatencies.some((latency) => latency === undefined)) {
    const observedAt = performance.now();
    for (const [index, snapshot] of publishedByNode.entries()) {
      if (
        observedLatencies[index] === undefined &&
        snapshot !== undefined &&
        snapshot.effectiveGeneration >= generation
      ) {
        observedLatencies[index] = observedAt - commitBoundaryMs;
      }
    }
    if (observedLatencies.every((latency) => latency !== undefined)) break;
    if (performance.now() >= deadline) {
      throw new Error(`Postgres nodes did not publish effective generation ${generation}`);
    }
    await delay(10);
  }
  return observedLatencies.map((latency) => {
    if (latency === undefined) throw new Error("Postgres convergence sample is unavailable");
    return latency;
  });
}
function delay(ms: number): Promise<void> {
  const { promise, resolve: resolveDelay } = Promise.withResolvers<void>();
  setTimeout(resolveDelay, ms);
  return promise;
}

async function expectReadyNodeCount(
  fixture: Readonly<{
    adminQuery<T>(sql: string, parameters?: readonly unknown[]): Promise<readonly T[]>;
  }>,
  count: number,
): Promise<void> {
  await expect(
    fixture.adminQuery<{ readyNodes: number }>(
      `SELECT count(*)::integer AS "readyNodes"
       FROM caplets.cp_cluster_node_lease
       WHERE state = 'ready' AND expires_at::timestamptz > clock_timestamp()`,
    ),
  ).resolves.toEqual([{ readyNodes: count }]);
}
