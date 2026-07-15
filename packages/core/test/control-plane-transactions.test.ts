import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createControlPlaneRepository } from "../src/control-plane/caplets/repository";
import { openSqliteControlPlaneDialect } from "../src/control-plane/dialect/sqlite";
import type { MigrationEnvironment } from "../src/control-plane/dialect/migrations";
import type { ResolvedSqliteStorage } from "../src/control-plane/storage-config";
import type {
  CapletManagementMutation,
  ControlPlaneStoreIdentity,
  ControlPlaneWriterFence,
} from "../src/control-plane/types";
import type { CurrentHostOperationBinding } from "../src/current-host/operations";
import type { ControlPlaneFailurePoint } from "../src/control-plane/store";

const NOW = "2026-07-14T00:00:00.000Z";
const identity: ControlPlaneStoreIdentity = {
  logicalHostId: "host_01J00000000000000000000000",
  storeId: "store_01J00000000000000000000000",
  operationNamespace: "namespace_01J00000000000000000000",
};
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
    hostAdministrator: false,
    now: new Date(NOW),
  };
}

async function fixture() {
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
    compatibility: { binaryVersion: "0.34.1", schemaVersion: 2, keyVersion: 1, manifestVersion: 1 },
    ttlMs: 60_000,
  });
  if (registration.status !== "ready") throw new Error("test node was not ready");
  return {
    dialect,
    store,
    versions,
    fence: registration.writerFence,
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

describe("control-plane management transaction atomicity", () => {
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

  it("commits one same-version writer, reports one explicit conflict, and leaves unrelated aggregates independent", async () => {
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
