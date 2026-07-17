import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapletsError } from "../src/errors";
import {
  createControlPlaneRepository,
  type TransactionBoundCapletMutation,
} from "../src/control-plane/caplets/repository";
import { openSqliteControlPlaneDialect } from "../src/control-plane/dialect/sqlite";
import type { MigrationEnvironment } from "../src/control-plane/dialect/migrations";
import type { ResolvedSqliteStorage } from "../src/control-plane/storage-config";
import { encodeCanonicalJson } from "../src/control-plane/schema/model-codec";
import { STORAGE_BENCHMARK_ENVELOPE } from "../src/control-plane/storage-benchmark-envelope";
import type {
  CapletManagementMutation,
  ControlPlaneStoreIdentity,
  ControlPlaneWriterFence,
} from "../src/control-plane/types";
import type { CurrentHostOperationBinding } from "../src/current-host/operations";
import type {
  ControlPlaneFailurePoint,
  ControlPlaneSqlTransaction,
} from "../src/control-plane/store";

const NOW = "2026-07-14T00:00:00.000Z";
const identity: ControlPlaneStoreIdentity = {
  logicalHostId: "host_01J00000000000000000000000",
  storeId: "store_01J00000000000000000000000",
  operationNamespace: "namespace_01J00000000000000000000",
};
const runtimeCompatibility = {
  binaryVersion: "0.34.1",
  schemaVersion: 3,
  keyVersion: 1,
  manifestVersion: 1,
  providerCommitment: "1".repeat(64),
  keyCanaryCommitment: "2".repeat(64),
  capabilities: ["ordered-tuple-polling", "writer-fence-v1", "complete-snapshot-v1"],
} as const;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function environment(): MigrationEnvironment {
  return {
    binaryVersion: "0.34.1",
    supportedSchemaVersion: 1,
    keyVersion: 1,
    manifestVersion: 1,
    verifiedSchemaAwareBackup: true,
    oldNodesDrained: true,
    retainedKeyVersions: [1],
    activationEvidence: { kind: "empty-bootstrap" },
    hostAdministrator: true,
    now: new Date(NOW),
  };
}

async function fixture(acknowledge = true) {
  const root = await mkdtemp(join(tmpdir(), "caplets-store-transactions-"));
  roots.push(root);
  const storage: ResolvedSqliteStorage = {
    backend: "sqlite",
    ...identity,
    stateRoot: root,
    databasePath: join(root, "control-plane.sqlite3"),
    keyProviderManifest: join(root, "key-provider.json"),
    artifacts: { kind: "filesystem", root: join(root, "artifacts") },
  };
  const dialect = await openSqliteControlPlaneDialect({
    storage,
    environment: environment(),
    assetRoot: resolve(import.meta.dirname, "..", "drizzle"),
  });
  dialect.migrate();
  let injectedPoint: ControlPlaneFailurePoint | undefined;
  let pause:
    | { point: ControlPlaneFailurePoint; entered: () => void; release: Promise<void> }
    | undefined;
  const store = createControlPlaneRepository({
    identity,
    dialect,
    failureInjector: async (point) => {
      if (pause?.point === point) {
        pause.entered();
        await pause.release;
      }
      if (point === injectedPoint) throw new Error(`injected:${point}`);
    },
  });
  const versions = await store.initialize();
  const registration = await store.registerNode({
    nodeId: "node-1",
    bootstrapFingerprint: "a".repeat(64),
    effectiveRuntimeFingerprint: "a".repeat(64),
    compatibility: runtimeCompatibility,
    appliedToken: { authorityGeneration: 0, effectiveGeneration: 0, securityEpoch: 0 },
    ttlMs: 60_000,
  });
  if (registration.status !== "ready") throw new Error("test node was not ready");
  if (acknowledge) {
    const acknowledgement = await store.acknowledgeNode({
      nodeId: "node-1",
      bootstrapFingerprint: "a".repeat(64),
      effectiveRuntimeFingerprint: "a".repeat(64),
      appliedToken: versions,
      writerFence: registration.writerFence,
    });
    if (acknowledgement.status !== "applied") throw new Error("test node was not acknowledged");
  }
  return {
    dialect,
    store,
    versions,
    fence: registration.writerFence,
    registration,
    inject(point: ControlPlaneFailurePoint | undefined) {
      injectedPoint = point;
    },
    pauseAt(point: ControlPlaneFailurePoint) {
      let entered!: () => void;
      let release!: () => void;
      const enteredPromise = new Promise<void>((resolveEntered) => {
        entered = resolveEntered;
      });
      const releasePromise = new Promise<void>((resolveRelease) => {
        release = resolveRelease;
      });
      pause = { point, entered, release: releasePromise };
      return { entered: enteredPromise, release };
    },
  };
}

function binding(operationId: string, overrides: Partial<CurrentHostOperationBinding> = {}) {
  return {
    operationId,
    target: "global",
    ...identity,
    actorId: "operator-1",
    requestIdentity: `request:${operationId}`,
    operationClass: "logical-state",
    ...overrides,
  } satisfies CurrentHostOperationBinding;
}

function mutation(
  aggregateId: string,
  operationId: string,
  fence: ControlPlaneWriterFence,
  overrides: Partial<CapletManagementMutation> = {},
): CapletManagementMutation {
  const aggregateVersion = 1;
  return {
    binding: binding(operationId),
    aggregateId,
    expectedAggregateVersion: 0,
    expectedAuthorityGeneration: fence.authorityGeneration,
    expectedSecurityEpoch: 0,
    writerFence: fence,
    aggregate: {
      modelVersion: 1,
      id: aggregateId,
      aggregateVersion,
      ownership: "sql",
      activation: "active",
      effective: true,
      portable: {
        portableVersion: 1,
        canonicalModelVersion: 1,
        id: aggregateId,
        name: aggregateId,
        description: "transaction fixture",
        sourcePath: `${aggregateId}/CAPLET.md`,
        frontmatter: {
          source: { kind: "test" },
          backend: { kind: "http", config: { baseUrl: "https://example.invalid" } },
          declaredInputs: [],
        },
        body: "# Transaction fixture\n",
        assets: [],
        references: [],
      },
      installationProvenanceId: `provenance:${aggregateId}`,
      updateState: "current",
    },
    projection: {
      capletId: aggregateId,
      sourceFrontmatter: { kind: "test" },
      body: "# Transaction fixture\n",
      backends: [
        {
          capletId: aggregateId,
          ordinal: 0,
          kind: "http",
          config: { baseUrl: "https://example.invalid" },
        },
      ],
      assets: [],
      references: [],
      activationHistory: [
        {
          capletId: aggregateId,
          sequence: 1,
          from: "absent",
          to: "active",
          reason: "imported",
          actorId: "operator-1",
          aggregateVersion,
          authorityVersion: fence.authorityGeneration,
          effectiveVersion: 1,
          occurredAt: NOW,
        },
      ],
    },
    provenance: {
      id: `provenance:${aggregateId}`,
      sourceKind: "test",
      source: { fixture: aggregateId },
      contentHash: "b".repeat(64),
      installedAt: NOW,
    },
    activity: {
      id: `activity:${operationId}`,
      action: "caplet.install",
      target: { type: "caplet", id: aggregateId },
    },
    ...overrides,
  };
}

async function tableCounts(dialect: {
  query<T>(sql: string, parameters?: readonly unknown[]): readonly T[];
}) {
  const tables = [
    "cp_caplet",
    "cp_caplet_provenance",
    "cp_operator_activity",
    "cp_operation_outcome",
    "cp_effective_version",
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = dialect.query<{ count: number }>(
      `SELECT count(*) AS count FROM ${table}`,
    )[0]!.count;
  }
  return counts;
}

function insertPendingReceipt(
  dialect: {
    execute(sql: string, parameters?: readonly unknown[]): void;
  },
  operationId: string,
  options: Readonly<{
    authorityGeneration?: number;
    effectiveGeneration?: number;
    securityEpoch?: number;
    deadline?: string;
    requiredNodes?: number;
  }> = {},
): void {
  const authorityGeneration = options.authorityGeneration ?? 0;
  const effectiveGeneration = options.effectiveGeneration ?? 0;
  const securityEpoch = options.securityEpoch ?? 0;
  const receipt = encodeCanonicalJson({
    status: "committed",
    binding: binding(operationId),
    aggregateVersion: 0,
    authorityToken: { authorityGeneration, effectiveGeneration },
    localApplication: "applied",
    convergence: {
      kind: "pending",
      deadline: options.deadline ?? "9999-12-31T23:59:59.999Z",
      requiredNodes: options.requiredNodes ?? 1,
    },
  });
  dialect.execute(
    "INSERT INTO cp_operation_outcome (" +
      "model_version, id, logical_host_id, store_id, created_at, updated_at, " +
      "aggregate_version, authority_version, effective_version, security_version, " +
      "operation_id, operation_class, request_hash, receipt_hash, receipt, " +
      "result_aggregate_version, result_authority_version, result_effective_version, " +
      "convergence_class) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      1,
      `outcome:${operationId}`,
      identity.logicalHostId,
      identity.storeId,
      NOW,
      NOW,
      0,
      authorityGeneration,
      effectiveGeneration,
      securityEpoch,
      operationId,
      "logical-state",
      "c".repeat(64),
      "d".repeat(64),
      receipt,
      0,
      authorityGeneration,
      effectiveGeneration,
      "pending",
    ],
  );
}

describe("control-plane management transaction atomicity", () => {
  it("reads uninitialized health without executing initialization DML", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "caplets-store-health-"));
    roots.push(stateRoot);
    const dialect = await openSqliteControlPlaneDialect({
      storage: {
        backend: "sqlite",
        ...identity,
        stateRoot,
        databasePath: join(stateRoot, "control-plane.sqlite3"),
        keyProviderManifest: join(stateRoot, "key-provider.json"),
        artifacts: { kind: "filesystem", root: join(stateRoot, "artifacts") },
      },
      environment: environment(),
      assetRoot: resolve(import.meta.dirname, "..", "drizzle"),
    });
    dialect.migrate();
    const store = createControlPlaneRepository({ identity, dialect });
    const before = dialect.query<{ count: number }>(
      "SELECT count(*) AS count FROM cp_authority_version",
    );

    await expect(store.health()).resolves.toEqual({
      backend: "sqlite",
      readiness: "not-ready",
      connectivity: "unavailable",
      migration: "current",
      authorityToken: { authorityGeneration: 0, effectiveGeneration: 0 },
      bootstrapCompatibility: "current",
      convergence: "single-node",
      guidanceCode: "storage-unavailable",
    });
    expect(
      dialect.query<{ count: number }>("SELECT count(*) AS count FROM cp_authority_version"),
    ).toEqual(before);
    expect(
      dialect.query<{ count: number }>("SELECT count(*) AS count FROM cp_effective_version"),
    ).toEqual([{ count: 0 }]);
    expect(
      dialect.query<{ count: number }>("SELECT count(*) AS count FROM cp_security_version"),
    ).toEqual([{ count: 0 }]);
    expect(
      dialect.query<{ count: number }>("SELECT count(*) AS count FROM cp_operation_namespace"),
    ).toEqual([{ count: 0 }]);
  });
  it("keeps registration non-writable until acknowledgement atomically activates its fence", async () => {
    const test = await fixture(false);
    expect(
      test.dialect.query<{ state: string }>(
        "SELECT state FROM cp_cluster_node_lease WHERE node_id = 'node-1'",
      ),
    ).toEqual([{ state: "catching-up" }]);
    expect(
      test.dialect.query<{ state: string }>(
        "SELECT state FROM cp_writer_fence WHERE lease_id = 'writer:node-1'",
      ),
    ).toEqual([{ state: "pending" }]);

    const input = mutation("caplet-registering", "operation-registering", test.fence);
    await test.store.reserveOperation(input.binding, input.aggregateId);
    await expect(test.store.mutateCaplet(input)).resolves.toEqual({
      status: "conflict",
      reason: "writer-fence",
    });

    await expect(
      test.store.acknowledgeNode({
        nodeId: "node-1",
        bootstrapFingerprint: "a".repeat(64),
        effectiveRuntimeFingerprint: "a".repeat(64),
        appliedToken: test.versions,
        writerFence: test.fence,
      }),
    ).resolves.toEqual({ status: "applied", appliedNodes: 1 });
    expect(
      test.dialect.query<{ nodeState: string; fenceState: string }>(
        "SELECT n.state AS nodeState, f.state AS fenceState " +
          "FROM cp_cluster_node_lease n JOIN cp_writer_fence f ON f.lease_id = 'writer:node-1' " +
          "WHERE n.node_id = 'node-1'",
      ),
    ).toEqual([{ nodeState: "ready", fenceState: "active" }]);
    await expect(test.store.mutateCaplet(input)).resolves.toMatchObject({ status: "committed" });
  });

  it("renews a live ready node without rotating its active writer epoch", async () => {
    const test = await fixture();
    const renewed = await test.store.registerNode({
      nodeId: "node-1",
      bootstrapFingerprint: "a".repeat(64),
      effectiveRuntimeFingerprint: "a".repeat(64),
      compatibility: runtimeCompatibility,
      appliedToken: test.versions,
      ttlMs: 120_000,
    });

    expect(renewed).toEqual({
      status: "ready",
      readyNodes: 1,
      writerFence: test.fence,
    });
    expect(
      test.dialect.query<{ nodeState: string; fenceState: string; writerEpoch: number }>(
        "SELECT n.state AS nodeState, f.state AS fenceState, f.writer_epoch AS writerEpoch " +
          "FROM cp_cluster_node_lease n JOIN cp_writer_fence f ON f.lease_id = 'writer:node-1' " +
          "WHERE n.node_id = 'node-1'",
      ),
    ).toEqual([{ nodeState: "ready", fenceState: "active", writerEpoch: test.fence.writerEpoch }]);
  });

  it("does not serialize independent node heartbeats behind a host-wide lock", async () => {
    const test = await fixture();
    const second = await test.store.registerNode({
      nodeId: "node-2",
      bootstrapFingerprint: "a".repeat(64),
      effectiveRuntimeFingerprint: "a".repeat(64),
      compatibility: runtimeCompatibility,
      appliedToken: test.versions,
      ttlMs: 60_000,
    });
    if (second.status !== "ready") throw new Error(`node-2 was ${second.status}`);
    await test.store.acknowledgeNode({
      nodeId: "node-2",
      bootstrapFingerprint: "a".repeat(64),
      effectiveRuntimeFingerprint: "a".repeat(64),
      appliedToken: test.versions,
      writerFence: second.writerFence,
    });
    const locks: string[] = [];
    const dialect = {
      ...test.dialect,
      runtimeTransaction<T>(work: (transaction: ControlPlaneSqlTransaction) => Promise<T>) {
        return test.dialect.runtimeTransaction((transaction) =>
          work({
            ...transaction,
            async lock(serialKey: string) {
              locks.push(serialKey);
              await transaction.lock(serialKey);
            },
          }),
        );
      },
    };
    const store = createControlPlaneRepository({ identity, dialect });
    await store.initialize();
    locks.length = 0;

    const renewed = await Promise.all([
      store.registerNode({
        nodeId: "node-1",
        bootstrapFingerprint: "a".repeat(64),
        effectiveRuntimeFingerprint: "a".repeat(64),
        compatibility: runtimeCompatibility,
        appliedToken: test.versions,
        ttlMs: 120_000,
      }),
      store.registerNode({
        nodeId: "node-2",
        bootstrapFingerprint: "a".repeat(64),
        effectiveRuntimeFingerprint: "a".repeat(64),
        compatibility: runtimeCompatibility,
        appliedToken: test.versions,
        ttlMs: 120_000,
      }),
    ]);

    expect([...locks].sort()).toEqual([
      `node-lease:${identity.logicalHostId}:${identity.storeId}:node-1`,
      `node-lease:${identity.logicalHostId}:${identity.storeId}:node-2`,
    ]);
    locks.length = 0;
    await Promise.all(
      renewed.map(async (registration, index) => {
        if (registration.status !== "ready") throw new Error("node heartbeat was rejected");
        await store.acknowledgeNode({
          nodeId: `node-${index + 1}`,
          bootstrapFingerprint: "a".repeat(64),
          effectiveRuntimeFingerprint: "a".repeat(64),
          appliedToken: test.versions,
          writerFence: registration.writerFence,
        });
      }),
    );
    expect([...locks].sort()).toEqual([
      `node-lease:${identity.logicalHostId}:${identity.storeId}:node-1`,
      `node-lease:${identity.logicalHostId}:${identity.storeId}:node-2`,
    ]);
  });

  it("accepts the release-target binary at the compatibility boundary", async () => {
    const test = await fixture();
    await expect(
      test.store.registerNode({
        nodeId: "node-release-target",
        bootstrapFingerprint: "a".repeat(64),
        effectiveRuntimeFingerprint: "a".repeat(64),
        compatibility: { ...runtimeCompatibility, binaryVersion: "0.36.0" },
        appliedToken: test.versions,
        ttlMs: 60_000,
      }),
    ).resolves.toMatchObject({ status: "ready" });
  });

  it.each([
    ["binary range", { binaryVersion: "0.37.0" }],
    ["provider commitment", { providerCommitment: "" }],
    ["key canary commitment", { keyCanaryCommitment: "" }],
    ["mandatory capabilities", { capabilities: ["ordered-tuple-polling", "writer-fence-v1"] }],
  ] as const)("rejects nodes missing the %s readiness commitment", async (_name, override) => {
    const test = await fixture();
    const store = createControlPlaneRepository({
      identity,
      dialect: { ...test.dialect, backend: "postgres" },
    });
    await expect(
      store.registerNode({
        nodeId: `incompatible-${_name.replaceAll(" ", "-")}`,
        bootstrapFingerprint: "a".repeat(64),
        effectiveRuntimeFingerprint: "a".repeat(64),
        compatibility: { ...runtimeCompatibility, ...override },
        appliedToken: test.versions,
        ttlMs: 60_000,
      }),
    ).resolves.toEqual({ status: "compatibility-rejected" });
  });

  it("keeps activation committed when its best-effort notification fails", async () => {
    const test = await fixture();
    const store = createControlPlaneRepository({
      identity,
      dialect: {
        ...test.dialect,
        async publishChange() {
          throw new Error("notification unavailable");
        },
      },
    });
    await store.stageNextFingerprint("b".repeat(64));
    await expect(store.activateNextFingerprint("b".repeat(64))).resolves.toMatchObject({
      currentFingerprint: "b".repeat(64),
    });
    await expect(store.activationState()).resolves.toMatchObject({
      currentFingerprint: "b".repeat(64),
    });
    const token = await store.convergenceToken();
    await expect(
      store.registerNode({
        nodeId: "node-1",
        bootstrapFingerprint: "b".repeat(64),
        effectiveRuntimeFingerprint: "b".repeat(64),
        compatibility: runtimeCompatibility,
        appliedToken: token,
        ttlMs: 60_000,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      writerFence: {
        leaseId: test.fence.leaseId,
        writerEpoch: test.fence.writerEpoch + 1,
        authorityGeneration: token.authorityGeneration,
      },
    });
  });

  it("rejects divergent effective runtime material for an already-bound numeric tuple", async () => {
    const test = await fixture();
    await expect(
      test.store.registerNode({
        nodeId: "node-2",
        bootstrapFingerprint: "a".repeat(64),
        effectiveRuntimeFingerprint: "b".repeat(64),
        compatibility: runtimeCompatibility,
        appliedToken: test.versions,
        ttlMs: 60_000,
      }),
    ).resolves.toEqual({ status: "compatibility-rejected" });
    expect(
      test.dialect.query<{ count: number }>(
        "SELECT count(*) AS count FROM cp_writer_fence WHERE lease_id = 'writer:node-2'",
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("finalizes a full sustained write burst in one capacity-bounded batch", async () => {
    const test = await fixture();
    const burstReceiptCount =
      STORAGE_BENCHMARK_ENVELOPE.managementWritesPerSecond *
      STORAGE_BENCHMARK_ENVELOPE.writeBurstSeconds;
    for (let index = 0; index < burstReceiptCount; index += 1) {
      const operationId = `bounded-receipt-${index.toString().padStart(4, "0")}`;
      const receipt = encodeCanonicalJson({
        binding: binding(operationId),
        aggregateVersion: 0,
        authorityToken: { authorityGeneration: 0, effectiveGeneration: 0 },
        localApplication: "applied",
        convergence: {
          kind: "pending",
          deadline: "9999-12-31T23:59:59.999Z",
          requiredNodes: 1,
        },
      });
      test.dialect.execute(
        "INSERT INTO cp_operation_outcome (" +
          "model_version, id, logical_host_id, store_id, created_at, updated_at, " +
          "aggregate_version, authority_version, effective_version, security_version, " +
          "operation_id, operation_class, request_hash, receipt_hash, receipt, " +
          "result_aggregate_version, result_authority_version, result_effective_version, " +
          "convergence_class) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          1,
          `outcome:${operationId}`,
          identity.logicalHostId,
          identity.storeId,
          NOW,
          NOW,
          0,
          0,
          0,
          0,
          operationId,
          "logical-state",
          "c".repeat(64),
          "d".repeat(64),
          receipt,
          0,
          0,
          0,
          "pending",
        ],
      );
    }

    const acknowledge = () =>
      test.store.acknowledgeNode({
        nodeId: "node-1",
        bootstrapFingerprint: "a".repeat(64),
        effectiveRuntimeFingerprint: "a".repeat(64),
        appliedToken: test.versions,
        writerFence: test.fence,
      });
    await expect(acknowledge()).resolves.toEqual({ status: "applied", appliedNodes: 1 });
    expect(
      test.dialect.query<{ convergenceClass: string; count: number }>(
        "SELECT convergence_class AS convergenceClass, count(*) AS count " +
          "FROM cp_operation_outcome GROUP BY convergence_class ORDER BY convergence_class",
      ),
    ).toEqual([{ convergenceClass: "converged", count: burstReceiptCount }]);
    await expect(acknowledge()).resolves.toEqual({ status: "applied", appliedNodes: 1 });
    expect(
      test.dialect.query<{ count: number }>(
        "SELECT count(*) AS count FROM cp_operation_outcome WHERE convergence_class = 'pending'",
      ),
    ).toEqual([{ count: 0 }]);
  }, 30_000);

  it("rejects the first management write above the per-second capacity without residue", async () => {
    const test = await fixture();
    const now = await test.dialect.runtimeTransaction((transaction) => transaction.databaseTime());
    await test.dialect.runtimeTransaction(async (transaction) => {
      for (
        let index = 0;
        index < STORAGE_BENCHMARK_ENVELOPE.managementWritesPerSecond;
        index += 1
      ) {
        await transaction.insert("operatorActivities", {
          modelVersion: 1,
          id: `rate-capacity-${index}`,
          logicalHostId: identity.logicalHostId,
          storeId: identity.storeId,
          createdAt: now,
          updatedAt: now,
          aggregateVersion: 0,
          authorityVersion: 0,
          effectiveVersion: 0,
          securityVersion: 0,
          activityId: `rate-capacity-${index}`,
          actorId: "operator-1",
          action: "capacity.probe",
          outcome: "committed",
          target: '{"type":"capacity"}',
          redactedDetail: null,
          occurredAt: now,
          expiresAt: "9999-12-31T23:59:59.999Z",
        });
      }
    });
    const operationId = "rate-capacity-rejected";
    await test.store.reserveOperation(binding(operationId), "rate-caplet");
    const before = await tableCounts(test.dialect);

    await expect(
      test.store.mutateCaplet(mutation("rate-caplet", operationId, test.fence)),
    ).resolves.toEqual({ status: "unavailable" });

    expect(await tableCounts(test.dialect)).toEqual(before);
    expect(
      test.dialect.query<{ count: number }>(
        "SELECT count(*) AS count FROM cp_operation_outcome WHERE operation_id = ?",
        [operationId],
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("serializes management-rate admission before committing a Caplet mutation", async () => {
    const test = await fixture();
    const locks: string[] = [];
    const dialect = {
      ...test.dialect,
      runtimeTransaction<T>(work: (transaction: ControlPlaneSqlTransaction) => Promise<T>) {
        return test.dialect.runtimeTransaction((transaction) =>
          work({
            ...transaction,
            async lock(serialKey: string) {
              locks.push(serialKey);
              await transaction.lock(serialKey);
            },
          }),
        );
      },
    };
    const store = createControlPlaneRepository({ identity, dialect });
    await store.initialize();
    const input = mutation("rate-serialized-caplet", "rate-serialized-operation", test.fence);
    await store.reserveOperation(input.binding, input.aggregateId);
    locks.length = 0;

    await expect(store.mutateCaplet(input)).resolves.toMatchObject({ status: "committed" });

    expect(locks).toContain(`management-rate:${identity.logicalHostId}:${identity.storeId}`);
  });

  it("rolls back a transaction-bound Caplet mutation with its outer action", async () => {
    const test = await fixture();
    let transactions = 0;
    const dialect = {
      ...test.dialect,
      runtimeTransaction<T>(work: (transaction: ControlPlaneSqlTransaction) => Promise<T>) {
        transactions += 1;
        return test.dialect.runtimeTransaction(work);
      },
    };
    const store = createControlPlaneRepository({ identity, dialect });
    const input = mutation(
      "transaction-bound-rollback",
      "transaction-bound-rollback-op",
      test.fence,
    );
    await store.reserveOperation(input.binding, input.aggregateId);
    transactions = 0;

    await expect(
      dialect.runtimeTransaction(async (transaction) => {
        await store.mutateCapletInTransaction(transaction, input);
        throw new Error("abort outer action");
      }),
    ).rejects.toThrow("abort outer action");
    expect(transactions).toBe(1);
    expect(
      test.dialect.query<{ count: number }>(
        "SELECT count(*) AS count FROM cp_caplet WHERE id = ?",
        [input.aggregateId],
      ),
    ).toEqual([{ count: 0 }]);
    expect(
      test.dialect.query<{ count: number }>(
        "SELECT count(*) AS count FROM cp_operation_outcome WHERE operation_id = ?",
        [input.binding.operationId],
      ),
    ).toEqual([{ count: 0 }]);
  });

  it("defers publication until a transaction-bound mutation has committed", async () => {
    const test = await fixture();
    let publications = 0;
    const dialect = {
      ...test.dialect,
      async publishChange(): Promise<void> {
        publications += 1;
      },
    };
    const store = createControlPlaneRepository({ identity, dialect });
    const reader = createControlPlaneRepository({ identity, dialect: test.dialect });
    const input = mutation("transaction-bound-commit", "transaction-bound-commit-op", test.fence);
    const dormantInput = {
      ...input,
      aggregate: { ...input.aggregate, activation: "disabled" as const, effective: false },
      projection: {
        ...input.projection,
        activationHistory: input.projection.activationHistory.map((event) => ({
          ...event,
          to: "disabled" as const,
          reason: "disabled" as const,
        })),
      },
    };
    await reader.loadSnapshot();
    await store.reserveOperation(dormantInput.binding, dormantInput.aggregateId);
    let committed: TransactionBoundCapletMutation | undefined;

    await dialect.runtimeTransaction(async (transaction) => {
      committed = await store.mutateCapletInTransaction(transaction, dormantInput);
      expect(publications).toBe(0);
    });
    expect(publications).toBe(0);
    if (!committed) throw new Error("transaction-bound mutation did not commit");
    await expect(committed.afterCommit()).resolves.toMatchObject({ status: "committed" });
    expect(publications).toBe(1);
    await expect(committed.afterCommit()).resolves.toMatchObject({ status: "committed" });
    expect(publications).toBe(1);
    await expect(reader.loadSnapshot()).resolves.toMatchObject({
      caplets: [{ aggregate: { id: dormantInput.aggregateId, effective: false } }],
    });
  });

  it("reuses immutable installation provenance when setup becomes active", async () => {
    const test = await fixture();
    const initial = mutation("setup-provenance-caplet", "setup-provenance-import", test.fence);
    const setupRequired = {
      ...initial,
      aggregate: {
        ...initial.aggregate,
        activation: "setup-required" as const,
        effective: false,
      },
      projection: {
        ...initial.projection,
        activationHistory: initial.projection.activationHistory.map((event) => ({
          ...event,
          to: "setup-required" as const,
          reason: "setup-required" as const,
        })),
      },
    };
    await test.store.reserveOperation(setupRequired.binding, setupRequired.aggregateId);
    await expect(test.store.mutateCaplet(setupRequired)).resolves.toMatchObject({
      status: "committed",
    });
    const activated = {
      ...setupRequired,
      binding: binding("setup-provenance-activate"),
      expectedAggregateVersion: 1,
      aggregate: {
        ...setupRequired.aggregate,
        aggregateVersion: 2,
        activation: "active" as const,
        effective: true,
      },
      projection: {
        ...setupRequired.projection,
        activationHistory: [
          ...setupRequired.projection.activationHistory,
          {
            ...setupRequired.projection.activationHistory[0]!,
            sequence: 2,
            from: "setup-required" as const,
            to: "active" as const,
            reason: "setup-remediated" as const,
            aggregateVersion: 2,
          },
        ],
      },
      activity: {
        ...setupRequired.activity,
        id: "activity:setup-provenance-activate",
      },
    };
    const mismatched = {
      ...activated,
      binding: binding("setup-provenance-mismatch"),
      provenance: { ...activated.provenance, contentHash: "e".repeat(64) },
    };
    await test.store.reserveOperation(mismatched.binding, mismatched.aggregateId);
    await expect(test.store.mutateCaplet(mismatched)).resolves.toEqual({
      status: "conflict",
      reason: "aggregate-version",
    });

    await test.store.reserveOperation(activated.binding, activated.aggregateId);
    await expect(test.store.mutateCaplet(activated)).resolves.toMatchObject({
      status: "committed",
      receipt: { aggregateVersion: 2 },
    });
    expect(
      test.dialect.query<{ count: number }>(
        "SELECT count(*) AS count FROM cp_caplet_provenance WHERE id = ?",
        [activated.provenance.id],
      ),
    ).toEqual([{ count: 1 }]);
  });

  it.each([
    ["dormant", "disabled", "disabled"],
    ["shadowed", "dormant-shadowed", "filesystem-shadowed"],
  ] as const)(
    "does not advance the effective generation for a %s Caplet mutation",
    async (kind, activation, reason) => {
      const test = await fixture();
      const reader = createControlPlaneRepository({ identity, dialect: test.dialect });
      const input = mutation(`${kind}-token-caplet`, `${kind}-token-operation`, test.fence);
      const ineffectiveInput = {
        ...input,
        aggregate: {
          ...input.aggregate,
          activation,
          effective: false,
        },
        projection: {
          ...input.projection,
          activationHistory: input.projection.activationHistory.map((event) => ({
            ...event,
            to: activation,
            reason,
          })),
        },
      };
      await expect(reader.loadSnapshot()).resolves.toMatchObject({ caplets: [] });
      await test.store.reserveOperation(ineffectiveInput.binding, ineffectiveInput.aggregateId);

      await expect(test.store.mutateCaplet(ineffectiveInput)).resolves.toMatchObject({
        status: "committed",
        receipt: {
          authorityToken: {
            authorityGeneration: test.versions.authorityGeneration,
            effectiveGeneration: test.versions.effectiveGeneration,
          },
        },
      });
      await expect(test.store.convergenceToken()).resolves.toMatchObject({
        authorityGeneration: test.versions.authorityGeneration,
        effectiveGeneration: test.versions.effectiveGeneration,
      });
      await expect(reader.loadSnapshot()).resolves.toMatchObject({
        caplets: [{ aggregate: { id: ineffectiveInput.aggregateId, effective: false } }],
      });
    },
  );

  it("requires operation lookup after an indeterminate commit acknowledgement", async () => {
    const test = await fixture();
    let loseCommitAcknowledgement = false;
    const dialect = {
      ...test.dialect,
      backend: "postgres" as const,
      async runtimeTransaction<T>(
        work: (transaction: ControlPlaneSqlTransaction) => Promise<T>,
      ): Promise<T> {
        const result = await test.dialect.runtimeTransaction(work);
        if (loseCommitAcknowledgement) {
          loseCommitAcknowledgement = false;
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            "Postgres commit acknowledgement was lost.",
            { transactionOutcome: "indeterminate", recovery: "operation-lookup" },
          );
        }
        return result;
      },
    };
    const store = createControlPlaneRepository({ identity, dialect });
    await store.initialize();
    const input = mutation("commit-ack-caplet", "commit-ack-operation", test.fence);
    await store.reserveOperation(input.binding, input.aggregateId);

    loseCommitAcknowledgement = true;
    await expect(store.mutateCaplet(input)).resolves.toEqual({
      status: "indeterminate",
      binding: input.binding,
    });
    await expect(store.lookupOrReserveNotCommitted(input.binding)).resolves.toMatchObject({
      status: "committed",
      receipt: { binding: input.binding },
    });
  });

  it("settles an old receipt overdue while newer writes keep convergence fresh", async () => {
    const test = await fixture();
    insertPendingReceipt(test.dialect, "sustained-write-overdue", {
      deadline: "1970-01-01T00:00:00.000Z",
    });
    for (let index = 0; index < 3; index += 1) {
      const input = mutation(
        `sustained-write-caplet-${index}`,
        `sustained-write-operation-${index}`,
        test.fence,
      );
      await test.store.reserveOperation(input.binding, input.aggregateId);
      await expect(test.store.mutateCaplet(input)).resolves.toMatchObject({ status: "committed" });
    }

    await expect(
      test.store.sweepOverdueNodes(STORAGE_BENCHMARK_ENVELOPE.maxConvergenceP99Ms),
    ).resolves.toBe(0);
    expect(
      test.dialect.query<{ convergenceClass: string }>(
        "SELECT convergence_class AS convergenceClass FROM cp_operation_outcome " +
          "WHERE operation_id = 'sustained-write-overdue'",
      ),
    ).toEqual([{ convergenceClass: "overdue" }]);
  });

  it("keeps an applied local node ready while a peer is still converging", async () => {
    const test = await fixture();
    const dialect = { ...test.dialect, backend: "postgres" as const };
    const store = createControlPlaneRepository({ identity, dialect });
    const peerStore = createControlPlaneRepository({ identity, dialect });
    const local = await store.registerNode({
      nodeId: "node-1",
      bootstrapFingerprint: "a".repeat(64),
      effectiveRuntimeFingerprint: "a".repeat(64),
      compatibility: runtimeCompatibility,
      appliedToken: test.versions,
      ttlMs: 60_000,
    });
    if (local.status !== "ready") throw new Error(`node-1 was ${local.status}`);
    const peer = await peerStore.registerNode({
      nodeId: "node-2",
      bootstrapFingerprint: "a".repeat(64),
      effectiveRuntimeFingerprint: "a".repeat(64),
      compatibility: runtimeCompatibility,
      appliedToken: test.versions,
      ttlMs: 60_000,
    });
    if (peer.status !== "ready") throw new Error(`node-2 was ${peer.status}`);
    await peerStore.acknowledgeNode({
      nodeId: "node-2",
      bootstrapFingerprint: "a".repeat(64),
      effectiveRuntimeFingerprint: "a".repeat(64),
      appliedToken: test.versions,
      writerFence: peer.writerFence,
    });
    const input = mutation("local-ready-caplet", "local-ready-operation", local.writerFence);
    await store.reserveOperation(input.binding, input.aggregateId);
    await expect(store.mutateCaplet(input)).resolves.toMatchObject({ status: "committed" });
    const advanced = await store.convergenceToken();
    await expect(
      store.acknowledgeNode({
        nodeId: "node-1",
        bootstrapFingerprint: "a".repeat(64),
        effectiveRuntimeFingerprint: "a".repeat(64),
        appliedToken: advanced,
        writerFence: local.writerFence,
      }),
    ).resolves.toEqual({ status: "applied", appliedNodes: 1 });

    await expect(store.health()).resolves.toMatchObject({
      backend: "postgres",
      readiness: "ready",
      connectivity: "connected",
      convergence: "pending",
      guidanceCode: "convergence-pending",
    });
    test.dialect.execute("UPDATE cp_authority_version SET updated_at = ?", [
      "1970-01-01T00:00:00.000Z",
    ]);
    test.dialect.execute("UPDATE cp_effective_version SET published_at = ?", [
      "1970-01-01T00:00:00.000Z",
    ]);
    test.dialect.execute("UPDATE cp_security_version SET advanced_at = ?", [
      "1970-01-01T00:00:00.000Z",
    ]);
    await expect(store.health()).resolves.toMatchObject({
      readiness: "ready",
      convergence: "overdue",
      guidanceCode: "convergence-overdue",
    });
  });

  it("does not let more than one batch of ineligible receipts starve an eligible receipt", async () => {
    const test = await fixture();
    for (let index = 0; index < 70; index += 1) {
      insertPendingReceipt(
        test.dialect,
        `ineligible-receipt-${index.toString().padStart(2, "0")}`,
        { authorityGeneration: 99 },
      );
    }
    insertPendingReceipt(test.dialect, "eligible-receipt");

    await expect(
      test.store.acknowledgeNode({
        nodeId: "node-1",
        bootstrapFingerprint: "a".repeat(64),
        effectiveRuntimeFingerprint: "a".repeat(64),
        appliedToken: test.versions,
        writerFence: test.fence,
      }),
    ).resolves.toEqual({ status: "applied", appliedNodes: 1 });
    expect(
      test.dialect.query<{ convergenceClass: string }>(
        "SELECT convergence_class AS convergenceClass FROM cp_operation_outcome " +
          "WHERE operation_id = 'eligible-receipt'",
      ),
    ).toEqual([{ convergenceClass: "converged" }]);
  });

  it("turns an expired convergence receipt overdue instead of converging it", async () => {
    const test = await fixture();
    insertPendingReceipt(test.dialect, "expired-receipt", {
      deadline: "1970-01-01T00:00:00.000Z",
    });

    await test.store.acknowledgeNode({
      nodeId: "node-1",
      bootstrapFingerprint: "a".repeat(64),
      effectiveRuntimeFingerprint: "a".repeat(64),
      appliedToken: test.versions,
      writerFence: test.fence,
    });
    const [row] = test.dialect.query<{ convergenceClass: string; receipt: string }>(
      "SELECT convergence_class AS convergenceClass, receipt FROM cp_operation_outcome " +
        "WHERE operation_id = 'expired-receipt'",
    );
    expect(row?.convergenceClass).toBe("overdue");
    expect(JSON.parse(row!.receipt)).toMatchObject({
      convergence: { kind: "pending", requiredNodes: 1 },
    });
    await expect(
      test.store.lookupOrReserveNotCommitted(binding("expired-receipt")),
    ).resolves.toMatchObject({
      status: "committed",
      receipt: { convergence: { kind: "overdue", requiredNodes: 1 } },
    });
  });

  it("keeps convergence bound to the ready cohort captured by the durable receipt", async () => {
    const test = await fixture();
    const store = createControlPlaneRepository({
      identity,
      dialect: { ...test.dialect, backend: "postgres" },
    });
    const second = await store.registerNode({
      nodeId: "node-2",
      bootstrapFingerprint: "a".repeat(64),
      effectiveRuntimeFingerprint: "a".repeat(64),
      compatibility: runtimeCompatibility,
      appliedToken: test.versions,
      ttlMs: 60_000,
    });
    if (second.status !== "ready") throw new Error(`node-2 was ${second.status}`);
    await store.acknowledgeNode({
      nodeId: "node-2",
      bootstrapFingerprint: "a".repeat(64),
      effectiveRuntimeFingerprint: "a".repeat(64),
      appliedToken: test.versions,
      writerFence: second.writerFence,
    });
    const input = mutation("cohort-bound-caplet", "cohort-bound-operation", test.fence);
    await store.reserveOperation(input.binding, input.aggregateId);
    const committed = await store.mutateCaplet(input);
    expect(committed).toMatchObject({
      status: "committed",
      receipt: { convergence: { kind: "pending", requiredNodes: 2 } },
    });

    test.dialect.execute(
      "UPDATE cp_cluster_node_lease SET expires_at = ? WHERE node_id = 'node-2'",
      ["1970-01-01T00:00:00.000Z"],
    );
    test.dialect.execute("UPDATE cp_writer_fence SET expires_at = ? WHERE lease_id = ?", [
      "1970-01-01T00:00:00.000Z",
      second.writerFence.leaseId,
    ]);
    const advanced = await store.convergenceToken();
    await expect(
      store.acknowledgeNode({
        nodeId: "node-1",
        bootstrapFingerprint: "a".repeat(64),
        effectiveRuntimeFingerprint: "a".repeat(64),
        appliedToken: advanced,
        writerFence: test.fence,
      }),
    ).resolves.toEqual({ status: "applied", appliedNodes: 1 });
    expect(
      test.dialect.query<{ convergenceClass: string }>(
        "SELECT convergence_class AS convergenceClass FROM cp_operation_outcome " +
          "WHERE operation_id = 'cohort-bound-operation'",
      ),
    ).toEqual([{ convergenceClass: "pending" }]);
  });

  it("starts a fresh convergence deadline when only the security epoch advances", async () => {
    const test = await fixture();
    test.dialect.execute("UPDATE cp_effective_version SET published_at = ?", [
      "2020-01-01T00:00:00.000Z",
    ]);
    test.dialect.execute("UPDATE cp_authority_version SET updated_at = ?", [
      "2020-01-01T00:00:00.000Z",
    ]);
    test.dialect.execute("UPDATE cp_security_version SET epoch = 1, advanced_at = ?", [
      new Date().toISOString(),
    ]);
    await expect(test.store.sweepOverdueNodes(60_000)).resolves.toBe(0);
    test.dialect.execute("UPDATE cp_security_version SET advanced_at = ?", [
      "2020-01-01T00:00:00.000Z",
    ]);
    await expect(test.store.sweepOverdueNodes(60_000)).resolves.toBe(1);
  });

  it("updates the envelope from the changed aggregate without materializing unrelated snapshot rows", async () => {
    const test = await fixture();
    const first = mutation("caplet-envelope-a", "operation-envelope-a", test.fence);
    await test.store.reserveOperation(first.binding, first.aggregateId);
    await expect(test.store.mutateCaplet(first)).resolves.toMatchObject({ status: "committed" });
    test.dialect.execute(
      "UPDATE cp_caplet_document SET source_frontmatter = ? WHERE caplet_id = ?",
      ["{}", first.aggregateId],
    );

    const second = mutation("caplet-envelope-b", "operation-envelope-b", test.fence);
    await test.store.reserveOperation(second.binding, second.aggregateId);
    await expect(test.store.mutateCaplet(second)).resolves.toMatchObject({ status: "committed" });
  });

  it.each([
    "after-operation-lock",
    "after-domain-write",
    "after-provenance",
    "after-activity",
    "after-generation",
    "before-fence-guard",
  ] satisfies readonly ControlPlaneFailurePoint[])(
    "rolls back domain, provenance, activity, receipt, aggregate version, and generation at %s",
    async (failurePoint) => {
      const test = await fixture();
      const input = mutation("caplet-atomic", `operation-${failurePoint}`, test.fence);
      await expect(
        test.store.reserveOperation(input.binding, input.aggregateId),
      ).resolves.toMatchObject({
        status: "reserved",
      });
      const before = await tableCounts(test.dialect);
      test.inject(failurePoint);

      await expect(test.store.mutateCaplet(input)).rejects.toThrow(`injected:${failurePoint}`);

      expect(await tableCounts(test.dialect)).toEqual(before);
      expect(await test.store.loadSnapshot()).toMatchObject({
        versions: { effectiveGeneration: test.versions.effectiveGeneration },
        caplets: [],
      });
    },
  );

  it("commits mixed aggregates without deadlock, bounds the shared envelope, and serializes one same-version writer", async () => {
    const test = await fixture();
    const sameA = mutation("caplet-same", "operation-same-a", test.fence);
    const sameB = mutation("caplet-same", "operation-same-b", test.fence);
    const unrelated = mutation("caplet-other", "operation-other", test.fence);
    await Promise.all([
      test.store.reserveOperation(sameA.binding, sameA.aggregateId),
      test.store.reserveOperation(sameB.binding, sameB.aggregateId),
      test.store.reserveOperation(unrelated.binding, unrelated.aggregateId),
    ]);

    const results = await Promise.all([
      test.store.mutateCaplet(sameA),
      test.store.mutateCaplet(sameB),
      test.store.mutateCaplet(unrelated),
    ]);

    expect(results.filter((result) => result.status === "committed")).toHaveLength(2);
    expect(results.filter((result) => result.status === "conflict")).toEqual([
      { status: "conflict", reason: "aggregate-version" },
    ]);
    expect(
      (await test.store.loadSnapshot()).caplets.map(({ aggregate }) => aggregate.id).sort(),
    ).toEqual(["caplet-other", "caplet-same"]);
    expect(
      test.dialect.query<{ capletCount: number }>(
        "SELECT caplet_count AS capletCount FROM cp_snapshot_envelope WHERE envelope_id = ?",
        ["control-plane"],
      ),
    ).toEqual([{ capletCount: 2 }]);
  });

  it("atomically rejects a concurrent envelope delta beyond the exact bound", async () => {
    const test = await fixture();
    const advance = (capletDelta: number) =>
      test.dialect.runtimeTransaction((transaction) =>
        transaction.advanceSnapshotEnvelope({
          logicalHostId: identity.logicalHostId,
          storeId: identity.storeId,
          envelopeId: "control-plane",
          capletDelta,
          normalizedRowDelta: 0,
          encodedByteDelta: 0,
          maxCaplets: STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets,
          maxNormalizedRows: STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows,
          maxEncodedBytes: STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes,
          expectedAuthorityGeneration: test.versions.authorityGeneration,
          expectedSecurityEpoch: test.versions.securityEpoch,
          leaseId: test.fence.leaseId,
          writerEpoch: test.fence.writerEpoch,
          fenceAuthorityGeneration: test.fence.authorityGeneration,
          fenceState: "active",
        }),
      );

    const results = await Promise.all([
      advance(STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets),
      advance(1),
    ]);
    expect([...results].sort()).toEqual([0, 1]);
    expect(
      test.dialect.query<{ capletCount: number }>(
        "SELECT caplet_count AS capletCount FROM cp_snapshot_envelope WHERE envelope_id = ?",
        ["control-plane"],
      ),
    ).toEqual([{ capletCount: STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets }]);
  });

  it("rejects at the final fence after a paused transaction loses its writer lease", async () => {
    const test = await fixture();
    const input = mutation("caplet-fenced", "operation-fenced", test.fence);
    await test.store.reserveOperation(input.binding, input.aggregateId);
    const paused = test.pauseAt("before-fence-guard");
    const pending = test.store.mutateCaplet(input);
    await paused.entered;
    test.dialect.execute("UPDATE cp_writer_fence SET state = ? WHERE lease_id = ?", [
      "revoked",
      test.fence.leaseId,
    ]);
    paused.release();

    await expect(pending).resolves.toEqual({ status: "conflict", reason: "writer-fence" });
    expect(await tableCounts(test.dialect)).toMatchObject({
      cp_caplet: 0,
      cp_caplet_provenance: 0,
      cp_operator_activity: 0,
      cp_operation_outcome: 0,
    });
  });

  it.each([
    {
      label: "authority generation",
      update: "UPDATE cp_authority_version SET generation = 1",
      reason: "authority-generation",
    },
    {
      label: "security epoch",
      update: "UPDATE cp_security_version SET epoch = 1",
      reason: "security-epoch",
    },
  ] as const)(
    "rolls back a transaction paused before its final guard when the $label advances",
    async ({ update, reason }) => {
      const test = await fixture();
      const input = mutation(`caplet-${reason}`, `operation-${reason}`, test.fence);
      await test.store.reserveOperation(input.binding, input.aggregateId);
      const paused = test.pauseAt("before-fence-guard");
      const pending = test.store.mutateCaplet(input);
      await paused.entered;
      test.dialect.execute(update);
      paused.release();

      await expect(pending).resolves.toEqual({ status: "conflict", reason });
      expect(await tableCounts(test.dialect)).toMatchObject({
        cp_caplet: 0,
        cp_caplet_provenance: 0,
        cp_operator_activity: 0,
        cp_operation_outcome: 0,
      });
    },
  );

  it("rolls back a transaction paused before its final guard when the actor is revoked", async () => {
    const test = await fixture();
    let revoked = false;
    const input = mutation("caplet-role-revocation", "operation-role-revocation", test.fence, {
      finalAuthorization: async () =>
        revoked
          ? { status: "denied", reason: "revoked-role" }
          : { status: "authorized", securityEpoch: 0, writerFence: test.fence },
    });
    await test.store.reserveOperation(input.binding, input.aggregateId);
    const paused = test.pauseAt("before-fence-guard");
    const pending = test.store.mutateCaplet(input);
    await paused.entered;
    revoked = true;
    paused.release();

    await expect(pending).resolves.toEqual({ status: "denied", reason: "revoked-role" });
    expect(await tableCounts(test.dialect)).toMatchObject({
      cp_caplet: 0,
      cp_caplet_provenance: 0,
      cp_operator_activity: 0,
      cp_operation_outcome: 0,
    });
  });
  it("serializes lookup reservation with dispatch so the original effect cannot commit twice", async () => {
    const test = await fixture();
    const input = mutation("caplet-race", "operation-race", test.fence);
    await test.store.reserveOperation(input.binding, input.aggregateId);
    const paused = test.pauseAt("after-operation-lock");
    const dispatch = test.store.mutateCaplet(input);
    await paused.entered;
    const lookup = test.store.lookupOrReserveNotCommitted(input.binding, input.aggregateId);
    paused.release();

    const [dispatchResult, lookupResult] = await Promise.all([dispatch, lookup]);
    expect(dispatchResult).toMatchObject({ status: "committed" });
    if (dispatchResult.status !== "committed") throw new Error("dispatch did not commit");
    expect(lookupResult).toEqual({ status: "committed", receipt: dispatchResult.receipt });

    const reservedFirst = binding("operation-reserved-first");
    const reservation = await test.store.lookupOrReserveNotCommitted(reservedFirst, "caplet-race");
    expect(reservation).toMatchObject({ status: "not_committed", binding: reservedFirst });
    expect(await test.store.reserveOperation(reservedFirst, "caplet-race")).toEqual({
      status: "conflict",
      reason: "operation-consumed",
    });
    expect((await test.store.loadSnapshot()).caplets).toHaveLength(1);
  });
});
