import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STORAGE_BENCHMARK_ENVELOPE, nearestRank } from "../src/control-plane/benchmarks/fixture";
import type {
  CanonicalCapletAggregate,
  CanonicalCapletRelationalProjection,
} from "../src/control-plane/caplets/model";
import { createControlPlaneRepository } from "../src/control-plane/caplets/repository";
import type { MigrationEnvironment } from "../src/control-plane/dialect/migrations";
import {
  openSqliteControlPlaneDialect,
  type SqliteControlPlaneDialect,
} from "../src/control-plane/dialect/sqlite";
import type { ResolvedSqliteStorage } from "../src/control-plane/storage-config";
import type { ControlPlaneSnapshot, ControlPlaneStoreIdentity } from "../src/control-plane/types";
import type {
  ControlPlaneSqlTransaction,
  ControlPlaneStore,
  ControlPlaneTransactionalDialect,
} from "../src/control-plane/store";

const logicalHostId = "host_01J00000000000000000000000";
const storeId = "store_01J00000000000000000000000";
const operationNamespace = "namespace_01J00000000000000000000";
const assetRoot = resolve(import.meta.dirname, "..", "drizzle");
const identity: ControlPlaneStoreIdentity = { logicalHostId, storeId, operationNamespace };
const roots: string[] = [];
const openDialects: SqliteControlPlaneDialect[] = [];
const scaledCapletCount = 8;

const migrationEnvironment: MigrationEnvironment = {
  binaryVersion: "0.34.1",
  supportedSchemaVersion: 1,
  keyVersion: 1,
  manifestVersion: 1,
  verifiedSchemaAwareBackup: true,
  oldNodesDrained: true,
  retainedKeyVersions: [1],
  hostAdministrator: false,
  now: new Date("2026-07-14T00:00:00.000Z"),
};

afterEach(async () => {
  await Promise.all(openDialects.splice(0).map((dialect) => dialect.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("supported control-plane snapshot envelope", () => {
  it("loads a bounded deterministic CI fixture through 16 notification-suppressed readers", async () => {
    const { store } = await openRepository("sqlite");
    const initial = await store.initialize();
    const registered = await store.registerNode({
      nodeId: "snapshot-writer",
      bootstrapFingerprint: "snapshot-writer-fingerprint",
      compatibility: {
        binaryVersion: "0.34.1",
        schemaVersion: 2,
        keyVersion: 1,
        manifestVersion: 1,
      },
      ttlMs: 60_000,
    });
    if (registered.status !== "ready") throw new Error("snapshot writer did not become ready");

    let authorityGeneration = initial.authorityGeneration;
    let effectiveGeneration = initial.effectiveGeneration;
    for (let index = 0; index < scaledCapletCount; index += 1) {
      const { aggregate, projection } = scaledCapletFixture(
        index,
        authorityGeneration + 1,
        effectiveGeneration + 1,
      );
      const operationBinding = {
        operationId: `snapshot-operation-${index}`,
        target: "global" as const,
        logicalHostId,
        storeId,
        operationNamespace,
        actorId: "operator-1",
        requestIdentity: `snapshot-caplet-${index}-v1`,
        operationClass: "logical-state" as const,
      };
      await store.reserveOperation(operationBinding, aggregate.id);
      const result = await store.mutateCaplet({
        binding: operationBinding,
        aggregateId: aggregate.id,
        expectedAggregateVersion: 0,
        expectedAuthorityGeneration: authorityGeneration,
        expectedSecurityEpoch: initial.securityEpoch,
        writerFence: { ...registered.writerFence, authorityGeneration },
        activity: {
          id: `snapshot-activity-${index}`,
          action: "caplet.install",
          target: { capletId: aggregate.id },
        },
        aggregate,
        projection,
        provenance: {
          id: `snapshot-provenance-${index}`,
          sourceKind: "scaled-ci-fixture",
          source: { index },
          contentHash: index.toString(16).padStart(64, "0"),
          installedAt: "2026-07-14T00:00:00.000Z",
          ownerId: "operator-1",
        },
      });
      expect(result.status).toBe("committed");
      if (result.status !== "committed") throw new Error(`scaled Caplet ${index} did not commit`);
      authorityGeneration = result.receipt.authorityToken.authorityGeneration;
      effectiveGeneration = result.receipt.authorityToken.effectiveGeneration;
    }

    const measured = await Promise.all(
      Array.from({ length: STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes }, async () => {
        const startedAt = performance.now();
        const snapshot = await store.loadSnapshot();
        return { snapshot, elapsedMs: performance.now() - startedAt };
      }),
    );
    const snapshots = measured.map(({ snapshot }) => snapshot);
    expect(snapshots.every((snapshot) => snapshot.caplets.length === scaledCapletCount)).toBe(true);
    expect(snapshots.slice(1)).toEqual(Array.from({ length: 15 }, () => snapshots[0]));

    const result = assertSnapshotThreshold(
      snapshots[0]!,
      measured.map(({ elapsedMs }) => elapsedMs),
      "scaled-ci",
    );
    expect(result).toMatchObject({
      fixture: "scaled-ci",
      effectiveCaplets: scaledCapletCount,
      readers: 16,
      dedicatedEnvelopeQualified: false,
    });
    if (process.env.CAPLETS_BENCHMARK_REPORT === "1") {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
    expect(result.p99Ms).toBeLessThanOrEqual(STORAGE_BENCHMARK_ENVELOPE.maxSnapshotLoadP99Ms);
  });

  it("applies the immutable U2 snapshot limits and nearest-rank threshold without extrapolation", () => {
    const snapshot: ControlPlaneSnapshot = {
      identity,
      versions: { authorityGeneration: 1, effectiveGeneration: 1, securityEpoch: 0 },
      caplets: [],
      hostSettings: [],
      encodedBytes: STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes,
      normalizedRows: STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows,
    };
    const passing = assertSnapshotThreshold(
      snapshot,
      [1, 20, STORAGE_BENCHMARK_ENVELOPE.maxSnapshotLoadP99Ms],
      "scaled-ci",
    );
    expect(passing.p99Ms).toBe(STORAGE_BENCHMARK_ENVELOPE.maxSnapshotLoadP99Ms);
    expect(passing.dedicatedEnvelopeQualified).toBe(false);

    expect(() =>
      assertSnapshotThreshold(
        snapshot,
        [1, 20, STORAGE_BENCHMARK_ENVELOPE.maxSnapshotLoadP99Ms + 0.001],
        "scaled-ci",
      ),
    ).toThrow(/snapshot load p99 exceeded/i);
    expect(() =>
      assertSnapshotThreshold(
        { ...snapshot, encodedBytes: STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes + 1 },
        [1],
        "scaled-ci",
      ),
    ).toThrow(/encoded byte envelope/i);
    expect(() =>
      assertSnapshotThreshold(
        { ...snapshot, normalizedRows: STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows + 1 },
        [1],
        "scaled-ci",
      ),
    ).toThrow(/normalized row envelope/i);
  });

  it("admits 16 ready Postgres nodes and rejects a non-perturbing seventeenth", async () => {
    const { store } = await openRepository("postgres");
    await store.initialize();
    const incompatible = await store.registerNode({
      nodeId: "node-incompatible",
      bootstrapFingerprint: "fingerprint-incompatible",
      compatibility: {
        binaryVersion: "0.34.1",
        schemaVersion: 1,
        keyVersion: 1,
        manifestVersion: 1,
      },
      ttlMs: 60_000,
    });
    expect(incompatible).toEqual({ status: "compatibility-rejected" });
    expect("writerFence" in incompatible).toBe(false);
    const ready = [];
    for (let index = 0; index < STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes; index += 1) {
      const registration = await store.registerNode({
        nodeId: `node-${index.toString().padStart(2, "0")}`,
        bootstrapFingerprint: `fingerprint-${index.toString().padStart(2, "0")}`,
        compatibility: {
          binaryVersion: "0.34.1",
          schemaVersion: 2,
          keyVersion: 1,
          manifestVersion: 1,
        },
        ttlMs: 60_000,
      });
      expect(registration.status).toBe("ready");
      if (registration.status !== "ready") throw new Error(`node ${index} was not ready`);
      expect(registration.readyNodes).toBe(index + 1);
      ready.push(registration);
    }

    const collision = await store.registerNode({
      nodeId: "node-00",
      bootstrapFingerprint: "different-fingerprint",
      compatibility: {
        binaryVersion: "0.34.1",
        schemaVersion: 2,
        keyVersion: 1,
        manifestVersion: 1,
      },
      ttlMs: 60_000,
    });
    expect(collision).toEqual({ status: "identity-conflict" });
    expect("writerFence" in collision).toBe(false);

    const snapshotBefore = await store.loadSnapshot();
    const healthBefore = await store.health();
    const rejected = await store.registerNode({
      nodeId: "node-16",
      bootstrapFingerprint: "fingerprint-16",
      compatibility: {
        binaryVersion: "0.34.1",
        schemaVersion: 2,
        keyVersion: 1,
        manifestVersion: 1,
      },
      ttlMs: 60_000,
    });
    expect(rejected).toEqual({ status: "capacity-rejected", readyNodes: 16 });
    expect("writerFence" in rejected).toBe(false);
    expect(await store.loadSnapshot()).toEqual(snapshotBefore);
    expect(await store.health()).toEqual(healthBefore);

    for (let index = 0; index < ready.length; index += 1) {
      const existing = await store.registerNode({
        nodeId: `node-${index.toString().padStart(2, "0")}`,
        bootstrapFingerprint: `fingerprint-${index.toString().padStart(2, "0")}`,
        compatibility: {
          binaryVersion: "0.34.1",
          schemaVersion: 2,
          keyVersion: 1,
          manifestVersion: 1,
        },
        ttlMs: 60_000,
      });
      expect(existing).toEqual({
        status: "ready",
        readyNodes: 16,
        writerFence: ready[index]!.writerFence,
      });
    }

    const drained = await store.registerNode({
      nodeId: "node-00",
      bootstrapFingerprint: "fingerprint-00",
      compatibility: {
        binaryVersion: "0.34.1",
        schemaVersion: 1,
        keyVersion: 1,
        manifestVersion: 1,
      },
      ttlMs: 60_000,
    });
    expect(drained).toEqual({ status: "compatibility-rejected" });
    await expect(
      store.registerNode({
        nodeId: "node-16",
        bootstrapFingerprint: "fingerprint-16",
        compatibility: {
          binaryVersion: "0.34.1",
          schemaVersion: 2,
          keyVersion: 1,
          manifestVersion: 1,
        },
        ttlMs: 60_000,
      }),
    ).resolves.toMatchObject({ status: "ready", readyNodes: 16 });
  });
});

function assertSnapshotThreshold(
  snapshot: ControlPlaneSnapshot,
  elapsedSamplesMs: readonly number[],
  fixture: "scaled-ci" | "dedicated-envelope",
) {
  if (snapshot.caplets.length > STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets) {
    throw new Error("Snapshot exceeded the effective Caplet envelope.");
  }
  if (snapshot.normalizedRows > STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows) {
    throw new Error("Snapshot exceeded the normalized row envelope.");
  }
  if (snapshot.encodedBytes > STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes) {
    throw new Error("Snapshot exceeded the encoded byte envelope.");
  }
  const p99Ms = nearestRank(elapsedSamplesMs, 0.99);
  if (p99Ms > STORAGE_BENCHMARK_ENVELOPE.maxSnapshotLoadP99Ms) {
    throw new Error("Snapshot load p99 exceeded the immutable U2 threshold.");
  }
  const dedicatedEnvelopeQualified =
    fixture === "dedicated-envelope" &&
    snapshot.caplets.length === STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets &&
    snapshot.normalizedRows === STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows &&
    snapshot.encodedBytes === STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes &&
    elapsedSamplesMs.length ===
      STORAGE_BENCHMARK_ENVELOPE.independentRuns *
        STORAGE_BENCHMARK_ENVELOPE.measuredSamplesPerRun *
        STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes;
  return {
    fixture,
    effectiveCaplets: snapshot.caplets.length,
    normalizedRows: snapshot.normalizedRows,
    encodedBytes: snapshot.encodedBytes,
    readers: elapsedSamplesMs.length,
    p99Ms,
    dedicatedEnvelopeQualified,
  } as const;
}

function scaledCapletFixture(
  index: number,
  authorityVersion: number,
  effectiveVersion: number,
): {
  aggregate: CanonicalCapletAggregate;
  projection: CanonicalCapletRelationalProjection;
} {
  const capletId = `scaled-caplet-${index.toString().padStart(3, "0")}`;
  const aggregate: CanonicalCapletAggregate = {
    modelVersion: 1,
    id: capletId,
    aggregateVersion: 1,
    ownership: "sql",
    activation: "active",
    effective: true,
    portable: {
      portableVersion: 1,
      canonicalModelVersion: 1,
      id: capletId,
      name: `Scaled Caplet ${index}`,
      description: "Bounded deterministic CI snapshot fixture.",
      sourcePath: "CAPLET.md",
      frontmatter: {
        source: { fixture: "scaled-ci", index },
        backend: { kind: "mcp", config: { index } },
        declaredInputs: [],
      },
      body: `# Scaled Caplet ${index}\n`,
      assets: [],
      references: [],
    },
    updateState: "current",
  };
  return {
    aggregate,
    projection: {
      capletId,
      sourceFrontmatter: { fixture: "scaled-ci", index },
      body: aggregate.portable.body,
      backends: [{ capletId, ordinal: 0, kind: "mcp", config: { index } }],
      assets: [],
      references: [],
      activationHistory: [
        {
          capletId,
          sequence: 1,
          from: "absent",
          to: "active",
          reason: "imported",
          actorId: "operator-1",
          aggregateVersion: 1,
          authorityVersion,
          effectiveVersion,
          occurredAt: "2026-07-14T00:00:00.000Z",
        },
      ],
    },
  };
}

async function openRepository(
  backend: "sqlite" | "postgres",
): Promise<{ store: ControlPlaneStore; dialect: SqliteControlPlaneDialect }> {
  const root = await mkdtemp(join(tmpdir(), "caplets-control-plane-snapshot-"));
  roots.push(root);
  const storage: ResolvedSqliteStorage = {
    backend: "sqlite",
    logicalHostId,
    storeId,
    operationNamespace,
    stateRoot: root,
    databasePath: join(root, "control-plane.sqlite3"),
    keyProviderManifest: join(root, "key-provider.json"),
    artifacts: { kind: "filesystem", root: join(root, "artifacts") },
  };
  const dialect = await openSqliteControlPlaneDialect({
    storage,
    environment: migrationEnvironment,
    assetRoot,
  });
  openDialects.push(dialect);
  dialect.migrate();
  return {
    dialect,
    store: createControlPlaneRepository({
      identity,
      dialect: transactionalSqlite(dialect, backend),
    }),
  };
}

function transactionalSqlite(
  dialect: SqliteControlPlaneDialect,
  backend: "sqlite" | "postgres",
): ControlPlaneTransactionalDialect {
  return {
    backend,
    compatibility: dialect.compatibility,
    get ready() {
      return dialect.ready;
    },
    runtimeTransaction<T>(work: (transaction: ControlPlaneSqlTransaction) => Promise<T>) {
      return dialect.runtimeTransaction(work);
    },
    snapshotTransaction<T>(work: (transaction: ControlPlaneSqlTransaction) => Promise<T>) {
      return dialect.snapshotTransaction(work);
    },
    maintenanceTransaction<T>(work: (transaction: ControlPlaneSqlTransaction) => Promise<T>) {
      return dialect.maintenanceTransaction(work);
    },
  };
}
