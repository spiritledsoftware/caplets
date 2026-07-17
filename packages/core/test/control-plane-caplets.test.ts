import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  STORAGE_BENCHMARK_ENVELOPE,
  nearestRank,
} from "../src/control-plane/storage-benchmark-envelope";
import { createArtifactProviderIdentity } from "../src/control-plane/artifacts/provider";
import type { CurrentHostOperationBinding } from "../src/current-host/operations";
import type {
  CanonicalCapletAggregate,
  CanonicalCapletRelationalProjection,
} from "../src/control-plane/caplets/model";
import { encodePortableCaplet } from "../src/control-plane/caplets/portable-codec";
import {
  createControlPlaneRepository,
  writeCanonicalCapletRows,
} from "../src/control-plane/caplets/repository";
import {
  bootstrapSqliteFileV1,
  loadFileV1KeyProvider,
} from "../src/control-plane/key-provider/file-v1";
import {
  createControlPlaneActivityMaintenanceRepository,
  createControlPlaneSecurityRepository,
} from "../src/control-plane/security/repository";
import {
  attachVerifiedPostgresPools,
  type PostgresControlPlaneDialect,
  type PostgresPool,
} from "../src/control-plane/dialect/postgres";
import {
  openSqliteControlPlaneDialect,
  type SqliteControlPlaneDialect,
} from "../src/control-plane/dialect/sqlite";
import {
  assertMigrationEnvironment,
  loadMigrationRegistry,
  type MigrationEnvironment,
} from "../src/control-plane/dialect/migrations";
import { parseCanonicalHostSetting } from "../src/control-plane/model";
import { quoteSafeSqlIdentifier } from "../src/control-plane/schema/model-codec";
import type {
  ResolvedPostgresStorage,
  ResolvedSqliteStorage,
} from "../src/control-plane/storage-config";
import type { ControlPlaneFailurePoint, ControlPlaneStore } from "../src/control-plane/store";

const logicalHostId = "host_01J00000000000000000000000";
const storeId = "store_01J00000000000000000000000";
const operationNamespace = "namespace_01J00000000000000000000";
const assetRoot = resolve(import.meta.dirname, "..", "drizzle");
const require = createRequire(import.meta.url);
const postgresAdminUrl = process.env.CAPLETS_TEST_POSTGRES_URL;
const POSTGRES_DISTRIBUTED_COMPATIBILITY = Object.freeze({
  providerCommitment: "1".repeat(64),
  keyCanaryCommitment: "2".repeat(64),
  capabilities: ["ordered-tuple-polling", "writer-fence-v1", "complete-snapshot-v1"] as const,
});
const roots: string[] = [];
const openDialects: SqliteControlPlaneDialect[] = [];

const migrationEnvironment: MigrationEnvironment = {
  binaryVersion: "0.34.1",
  supportedSchemaVersion: 1,
  keyVersion: 1,
  manifestVersion: 1,
  verifiedSchemaAwareBackup: true,
  oldNodesDrained: true,
  retainedKeyVersions: [1],
  hostAdministrator: true,
  now: new Date("2026-07-14T00:00:00.000Z"),
  activationEvidence: { kind: "empty-bootstrap" },
};

const identity = { logicalHostId, storeId, operationNamespace } as const;

const assetBytes = Uint8Array.from([0, 127, 255]);
const assetHash = createHash("sha256").update(assetBytes).digest("hex");
const documentBytes = new TextEncoder().encode('{"openapi":"3.1.0"}');
const documentHash = createHash("sha256").update(documentBytes).digest("hex");

const aggregate: CanonicalCapletAggregate = {
  modelVersion: 1,
  id: "caplet-corpus-1",
  aggregateVersion: 1,
  installationProvenanceId: "provenance-caplet",
  ownership: "sql",
  activation: "active",
  effective: true,
  portable: {
    portableVersion: 1,
    canonicalModelVersion: 1,
    id: "caplet-corpus-1",
    name: "Canonical corpus Caplet",
    description: "Exercises the U3 portable relational boundaries.",
    sourcePath: "CAPLET.md",
    frontmatter: {
      source: { catalog: "fixture", revision: 3 },
      backend: { kind: "mixed", config: { ordered: true } },
      catalog: {
        displayName: "Corpus",
        summary: "Portable metadata",
        tags: ["portable", "storage"],
        icon: { type: "local", path: "assets/icon.png" },
      },
      declaredInputs: [
        { name: "document", reference: { type: "local", path: "docs/openapi.json" } },
        { name: "token", reference: { type: "unresolved-setup", name: "API_TOKEN" } },
        { name: "upstream", reference: { type: "external", url: "https://example.invalid/api" } },
      ],
    },
    body: "# Canonical corpus\n\n[document](docs/openapi.json)\n",
    assets: [
      {
        path: "assets/icon.png",
        role: "icon",
        mediaType: "image/png",
        encoding: "base64",
        content: Buffer.from(assetBytes).toString("base64"),
        contentHash: assetHash,
        byteLength: assetBytes.byteLength,
      },
      {
        path: "docs/openapi.json",
        role: "openapi",
        mediaType: "application/json",
        encoding: "base64",
        content: Buffer.from(documentBytes).toString("base64"),
        contentHash: documentHash,
        byteLength: documentBytes.byteLength,
      },
    ],
    references: [
      { type: "unresolved-setup", owner: "caplet-corpus-1", name: "API_TOKEN" },
      { type: "local", owner: "caplet-corpus-1", path: "docs/openapi.json" },
      { type: "external", owner: "caplet-corpus-1", url: "https://example.invalid/api" },
    ],
  },
  updateState: "current",
};

const projection: CanonicalCapletRelationalProjection = {
  capletId: aggregate.id,
  sourceFrontmatter: { catalog: "fixture", revision: 3 },
  body: aggregate.portable.body,
  backends: [
    { capletId: aggregate.id, ordinal: 0, kind: "mcp", config: {} },
    {
      capletId: aggregate.id,
      ordinal: 1,
      kind: "openapi",
      config: { document: "docs/openapi.json" },
    },
  ],
  assets: [
    {
      capletId: aggregate.id,
      ordinal: 0,
      path: "assets/icon.png",
      role: "icon",
      mediaType: "image/png",
      content: assetBytes,
      contentHash: assetHash,
    },
    {
      capletId: aggregate.id,
      ordinal: 1,
      path: "docs/openapi.json",
      role: "openapi",
      mediaType: "application/json",
      content: documentBytes,
      contentHash: documentHash,
    },
  ],
  references: aggregate.portable.references.map((reference, ordinal) => ({
    capletId: aggregate.id,
    ordinal,
    reference,
  })),
  activationHistory: [
    {
      capletId: aggregate.id,
      sequence: 1,
      from: "absent",
      to: "active",
      reason: "imported",
      actorId: "operator-1",
      aggregateVersion: 1,
      authorityVersion: 1,
      effectiveVersion: 1,
      occurredAt: "2026-07-14T00:00:00.000Z",
    },
  ],
};

const hostSetting = parseCanonicalHostSetting({
  version: 1,
  key: "native.daemon-url",
  value: { source: "setup", url: "http://127.0.0.1:7777" },
  updatedAt: "2026-07-14T00:00:00.000Z",
});

afterEach(async () => {
  await Promise.all(openDialects.splice(0).map((dialect) => dialect.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("transactional Caplet and host-setting repository", () => {
  it("accepts the next 0.36.0 binary across both paired migration registries", async () => {
    for (const dialect of ["sqlite", "postgres"] as const) {
      const registry = await loadMigrationRegistry({ dialect, assetRoot });
      expect(() =>
        assertMigrationEnvironment(registry, {
          ...migrationEnvironment,
          binaryVersion: "0.36.0",
        }),
      ).not.toThrow();
    }
  });

  it("reports key compatibility from live node advertisements", async () => {
    const fixture = await createSqliteFixture();
    const opened = await openRepository(fixture.storage);
    const initial = await opened.store.initialize();
    const registration = await opened.store.registerNode({
      nodeId: "diagnostics-node",
      bootstrapFingerprint: "diagnostics-fingerprint",
      effectiveRuntimeFingerprint: "diagnostics-fingerprint",
      compatibility: {
        binaryVersion: "0.34.1",
        schemaVersion: 3,
        keyVersion: 1,
        manifestVersion: 1,
        providerCommitment: "1".repeat(64),
        keyCanaryCommitment: "2".repeat(64),
        capabilities: ["ordered-tuple-polling", "writer-fence-v1", "complete-snapshot-v1"],
      },
      appliedToken: { authorityGeneration: 0, effectiveGeneration: 0, securityEpoch: 0 },
      ttlMs: 60_000,
    });
    expect(registration.status).toBe("ready");
    if (registration.status !== "ready") throw new Error("fixture node did not register");
    await expect(
      opened.store.acknowledgeNode({
        nodeId: "diagnostics-node",
        bootstrapFingerprint: "diagnostics-fingerprint",
        effectiveRuntimeFingerprint: "diagnostics-fingerprint",
        appliedToken: initial,
        writerFence: registration.writerFence,
      }),
    ).resolves.toEqual({ status: "applied", appliedNodes: 1 });

    await expect(opened.store.detailedDiagnostics()).resolves.toMatchObject({
      keyCompatibility: {
        status: "compatible",
        activeVersion: 1,
        providerCommitmentPresent: true,
        canaryCommitmentPresent: true,
      },
      readyNodes: 1,
    });
  });

  it("persists and rehydrates canonical aggregates with an equal portable projection", async () => {
    const fixture = await createSqliteFixture();
    const first = await openRepository(fixture.storage);
    const initial = await first.store.initialize();
    const node = await first.store.registerNode({
      nodeId: "node-1",
      bootstrapFingerprint: "fingerprint-1",
      effectiveRuntimeFingerprint: "fingerprint-1",
      compatibility: {
        binaryVersion: "0.34.1",
        schemaVersion: 3,
        keyVersion: 1,
        manifestVersion: 1,
      },
      appliedToken: { authorityGeneration: 0, effectiveGeneration: 0, securityEpoch: 0 },
      ttlMs: 60_000,
    });
    expect(node.status).toBe("ready");
    if (node.status !== "ready") throw new Error("fixture node did not become ready");
    await expect(
      first.store.acknowledgeNode({
        nodeId: "node-1",
        bootstrapFingerprint: "fingerprint-1",
        effectiveRuntimeFingerprint: "fingerprint-1",
        appliedToken: initial,
        writerFence: { ...node.writerFence, leaseId: "writer:node-other" },
      }),
    ).resolves.toEqual({ status: "rejected", reason: "lease-revoked" });
    await expect(
      first.store.acknowledgeNode({
        nodeId: "node-1",
        bootstrapFingerprint: "fingerprint-1",
        effectiveRuntimeFingerprint: "fingerprint-1",
        appliedToken: initial,
        writerFence: node.writerFence,
      }),
    ).resolves.toEqual({ status: "applied", appliedNodes: 1 });

    const capletInput = {
      binding: binding("operation-caplet", "caplet-corpus-v1"),
      aggregateId: aggregate.id,
      expectedAggregateVersion: 0,
      expectedAuthorityGeneration: initial.authorityGeneration,
      expectedSecurityEpoch: initial.securityEpoch,
      writerFence: node.writerFence,
      activity: {
        id: "activity-caplet",
        action: "caplet.install",
        target: { capletId: aggregate.id },
      },
      aggregate,
      projection,
      provenance: provenance("provenance-caplet", assetHash),
    } as const;
    await first.store.reserveOperation(capletInput.binding, capletInput.aggregateId);
    const capletResult = await first.store.mutateCaplet(capletInput);
    expect(capletResult.status).toBe("committed");

    const afterCaplet = await first.store.initialize();
    const settingInput = {
      binding: binding("operation-setting", "native-daemon-url-v1"),
      aggregateId: hostSetting.key,
      expectedAggregateVersion: 0,
      expectedAuthorityGeneration: afterCaplet.authorityGeneration,
      expectedSecurityEpoch: afterCaplet.securityEpoch,
      writerFence: {
        ...node.writerFence,
        authorityGeneration: afterCaplet.authorityGeneration,
      },
      activity: {
        id: "activity-setting",
        action: "host-setting.update",
        target: { key: hostSetting.key },
      },
      setting: hostSetting,
      provenance: provenance("provenance-setting", "b".repeat(64)),
    } as const;
    await first.store.reserveOperation(settingInput.binding, settingInput.aggregateId);
    const settingResult = await first.store.mutateHostSetting(settingInput);
    expect(settingResult.status).toBe("committed");

    const beforeRestart = await first.store.loadSnapshot();
    expect(beforeRestart.versions.effectiveGeneration).toBe(2);
    await first.dialect.close();
    openDialects.splice(openDialects.indexOf(first.dialect), 1);

    const reopened = await openRepository(fixture.storage);
    await reopened.store.initialize();
    const afterRestart = await reopened.store.loadSnapshot();

    expect(afterRestart).toEqual(beforeRestart);
    expect(afterRestart.caplets).toEqual([{ aggregate, projection }]);
    expect(afterRestart.caplets[0]?.aggregate.portable).toEqual(aggregate.portable);
    expect(afterRestart.caplets[0]?.projection).toEqual(projection);
    expect(afterRestart.hostSettings).toEqual([hostSetting]);
  });

  it("serializes runtime fingerprint activation by logical host and store", async () => {
    const fixture = await createSqliteFixture();
    const opened = await openRepository(fixture.storage);
    const locks: string[] = [];
    const dialect = new Proxy(opened.dialect, {
      get(target, property, receiver) {
        if (property !== "runtimeTransaction") return Reflect.get(target, property, receiver);
        return async (work: Parameters<typeof target.runtimeTransaction>[0]) =>
          target.runtimeTransaction((transaction) =>
            work({
              ...transaction,
              async lock(serialKey) {
                locks.push(serialKey);
                await transaction.lock(serialKey);
              },
            }),
          );
      },
    });
    const store = createControlPlaneRepository({
      identity: {
        logicalHostId,
        storeId,
        operationNamespace,
      },
      dialect,
    });

    await store.initialize();
    await store.initializeActivationFingerprint("f".repeat(64));

    expect(locks).toContain(`runtime-activation:${logicalHostId}:${storeId}`);
  });

  it("purges and drains historical fingerprint cohorts with bounded set-based writes", async () => {
    const fixture = await createSqliteFixture();
    const opened = await openRepository(fixture.storage);
    const token = await opened.store.initialize();
    const currentFingerprint = "a".repeat(64);
    const nextFingerprint = "b".repeat(64);
    const compatibility = {
      binaryVersion: "0.34.1",
      schemaVersion: 3,
      keyVersion: 1,
      manifestVersion: 1,
    } as const;
    await opened.store.initializeActivationFingerprint(currentFingerprint);
    await opened.store.stageNextFingerprint(nextFingerprint);
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        opened.store.registerNode({
          nodeId: `purged-next-${index}`,
          bootstrapFingerprint: nextFingerprint,
          effectiveRuntimeFingerprint: nextFingerprint,
          compatibility,
          appliedToken: token,
          ttlMs: 60_000,
        }),
      ),
    );

    let nodeDeletes = 0;
    let nodeUpdates = 0;
    const boundedDialect = new Proxy(opened.dialect, {
      get(target, property, receiver) {
        if (property !== "runtimeTransaction") return Reflect.get(target, property, receiver);
        return async (work: Parameters<typeof target.runtimeTransaction>[0]) =>
          target.runtimeTransaction((transaction) =>
            work({
              ...transaction,
              async delete(table, filter) {
                if (table === "clusterNodeLeases") nodeDeletes += 1;
                return transaction.delete(table, filter);
              },
              async update(table, values, filter) {
                if (table === "clusterNodeLeases") nodeUpdates += 1;
                return transaction.update(table, values, filter);
              },
            }),
          );
      },
    });
    const boundedStore = createControlPlaneRepository({ identity, dialect: boundedDialect });
    await boundedStore.abortNextFingerprint(nextFingerprint);
    expect(nodeDeletes).toBe(1);
    expect(
      opened.dialect.query<{ count: number }>(
        "SELECT count(*) AS count FROM cp_cluster_node_lease WHERE bootstrap_fingerprint = ?",
        [nextFingerprint],
      ),
    ).toEqual([{ count: 0 }]);

    await opened.store.stageNextFingerprint(nextFingerprint);
    await Promise.all([
      ...Array.from({ length: 8 }, (_, index) =>
        opened.store.registerNode({
          nodeId: `drained-current-${index}`,
          bootstrapFingerprint: currentFingerprint,
          effectiveRuntimeFingerprint: currentFingerprint,
          compatibility,
          appliedToken: token,
          ttlMs: 60_000,
        }),
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        opened.store.registerNode({
          nodeId: `admitted-next-${index}`,
          bootstrapFingerprint: nextFingerprint,
          effectiveRuntimeFingerprint: nextFingerprint,
          compatibility,
          appliedToken: token,
          ttlMs: 60_000,
        }),
      ),
    ]);
    nodeUpdates = 0;
    await boundedStore.activateNextFingerprint(nextFingerprint);
    expect(nodeUpdates).toBe(2);
    expect(
      opened.dialect.query<{ state: string; count: number }>(
        "SELECT state, count(*) AS count FROM cp_cluster_node_lease GROUP BY state ORDER BY state",
      ),
    ).toEqual([
      { state: "activation-drained", count: 8 },
      { state: "catching-up", count: 8 },
    ]);
  });

  it("rolls back fingerprint activation when its final DB-time fence expires while paused", async () => {
    const fixture = await createSqliteFixture();
    const opened = await openRepository(fixture.storage);
    const token = await opened.store.initialize();
    const currentFingerprint = "c".repeat(64);
    const nextFingerprint = "d".repeat(64);
    await opened.store.initializeActivationFingerprint(currentFingerprint);
    const registration = await opened.store.registerNode({
      nodeId: "activation-fence-node",
      bootstrapFingerprint: currentFingerprint,
      effectiveRuntimeFingerprint: currentFingerprint,
      compatibility: {
        binaryVersion: "0.34.1",
        schemaVersion: 3,
        keyVersion: 1,
        manifestVersion: 1,
      },
      appliedToken: token,
      ttlMs: 60_000,
    });
    if (registration.status !== "ready") {
      throw new Error(`activation fence node was ${registration.status}`);
    }
    await opened.store.acknowledgeNode({
      nodeId: "activation-fence-node",
      bootstrapFingerprint: currentFingerprint,
      effectiveRuntimeFingerprint: currentFingerprint,
      appliedToken: token,
      writerFence: registration.writerFence,
    });
    await opened.store.stageNextFingerprint(nextFingerprint);

    const guardEntered = Promise.withResolvers<void>();
    const releaseGuard = Promise.withResolvers<void>();
    const postgresFenceDialect = new Proxy(opened.dialect, {
      get(target, property, receiver) {
        if (property !== "runtimeTransaction") return Reflect.get(target, property, receiver);
        return async (work: Parameters<typeof target.runtimeTransaction>[0]) =>
          target.runtimeTransaction((transaction) =>
            work({
              ...transaction,
              backend: "postgres" as const,
              async finalWriterFenceGuard() {
                guardEntered.resolve();
                await releaseGuard.promise;
                return 0;
              },
            }),
          );
      },
    });
    const fencedStore = createControlPlaneRepository({
      identity,
      dialect: postgresFenceDialect,
    });
    const activation = fencedStore.activateNextFingerprint(nextFingerprint, {
      securityEpoch: token.securityEpoch,
      writerFence: registration.writerFence,
    });
    await guardEntered.promise;
    releaseGuard.resolve();
    await expect(activation).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
    await expect(opened.store.activationState()).resolves.toEqual({
      generation: 0,
      currentFingerprint,
      nextFingerprint,
    });
    expect(
      opened.dialect.query<{ nodeState: string; fenceState: string }>(
        `SELECT node.state AS nodeState, fence.state AS fenceState
         FROM cp_cluster_node_lease AS node
         JOIN cp_writer_fence AS fence ON fence.lease_id = ?
         WHERE node.node_id = ?`,
        [registration.writerFence.leaseId, "activation-fence-node"],
      ),
    ).toEqual([{ nodeState: "ready", fenceState: "active" }]);
    await expect(opened.store.convergenceToken()).resolves.toEqual(token);
  });

  it("atomically adopts an unset SQLite fingerprint and rejects a stale convergence fence", async () => {
    const fixture = await createSqliteFixture();
    const { store } = await openRepository(fixture.storage);
    const versions = await store.initialize();
    const firstFingerprint = "a".repeat(64);
    const secondFingerprint = "b".repeat(64);
    const request = {
      nextFingerprint: firstFingerprint,
      expectedEffectiveRuntimeFingerprint: "c".repeat(64),
      expectedAuthorityGeneration: versions.authorityGeneration,
      expectedEffectiveGeneration: versions.effectiveGeneration,
      expectedSecurityEpoch: versions.securityEpoch,
    };

    await expect(store.adoptSqliteActivationFingerprint!(request)).resolves.toEqual({
      generation: 0,
      currentFingerprint: firstFingerprint,
    });
    await expect(
      store.adoptSqliteActivationFingerprint!({
        ...request,
        previousFingerprint: firstFingerprint,
        nextFingerprint: secondFingerprint,
        expectedEffectiveGeneration: versions.effectiveGeneration + 1,
      }),
    ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
    await expect(store.activationState()).resolves.toEqual({
      generation: 0,
      currentFingerprint: firstFingerprint,
    });
  });

  it("keeps confirmation previews side-effect free and consume-plus-action atomic", async () => {
    const fixture = await createSqliteFixture();
    let injected = false;
    const { store, dialect } = await openRepository(fixture.storage);
    const versions = await store.initialize();
    const request = {
      tokenId: "confirmation-1",
      action: "caplet.destroy",
      authorityToken: {
        authorityGeneration: versions.authorityGeneration,
        effectiveGeneration: versions.effectiveGeneration,
      },
      affectedVersions: ["caplet-corpus-1@1"],
      expiresInMs: 60_000,
      consequences: ["Deletes the selected portable aggregate."],
    } as const;
    const beforePreview = await store.loadSnapshot();
    const token = await store.createConfirmationPreview(request);
    expect(await store.loadSnapshot()).toEqual(beforePreview);

    let forgedActionRan = false;
    await expect(
      store.consumeConfirmation(
        {
          token: {
            ...token,
            authorityToken: {
              ...token.authorityToken,
              authorityGeneration: token.authorityToken.authorityGeneration + 1,
            },
          },
          action: request.action,
          authorityToken: request.authorityToken,
          affectedVersions: request.affectedVersions,
        },
        async () => {
          forgedActionRan = true;
        },
      ),
    ).resolves.toEqual({ status: "rejected", reason: "stale-authority" });
    expect(forgedActionRan).toBe(false);

    let rejectedActionRuns = 0;
    const rejectWithoutAction = async (
      consumption: Parameters<typeof store.consumeConfirmation>[0],
      reason: "absent" | "mismatched-action" | "changed-inventory" | "stale-authority" | "expired",
    ) => {
      await expect(
        store.consumeConfirmation(consumption, async () => {
          rejectedActionRuns += 1;
        }),
      ).resolves.toEqual({ status: "rejected", reason });
    };
    await rejectWithoutAction(
      {
        token: { ...token, tokenId: "confirmation-absent" },
        action: request.action,
        authorityToken: request.authorityToken,
        affectedVersions: request.affectedVersions,
      },
      "absent",
    );
    await rejectWithoutAction(
      {
        token,
        action: "caplet.destroy-other",
        authorityToken: request.authorityToken,
        affectedVersions: request.affectedVersions,
      },
      "mismatched-action",
    );
    await rejectWithoutAction(
      {
        token,
        action: request.action,
        authorityToken: request.authorityToken,
        affectedVersions: ["caplet-corpus-1@2"],
      },
      "changed-inventory",
    );
    await rejectWithoutAction(
      {
        token: { ...token, storeId: "store-other" },
        action: request.action,
        authorityToken: request.authorityToken,
        affectedVersions: request.affectedVersions,
      },
      "stale-authority",
    );
    const expiringToken = await store.createConfirmationPreview({
      ...request,
      tokenId: "confirmation-expired",
    });
    dialect.execute("UPDATE cp_confirmation SET expires_at = ? WHERE confirmation_id = ?", [
      "2000-01-01T00:00:00.000Z",
      expiringToken.tokenId,
    ]);
    await rejectWithoutAction(
      {
        token: expiringToken,
        action: request.action,
        authorityToken: request.authorityToken,
        affectedVersions: request.affectedVersions,
      },
      "expired",
    );
    expect(rejectedActionRuns).toBe(0);

    await expect(
      store.consumeConfirmation(
        {
          token,
          action: request.action,
          authorityToken: request.authorityToken,
          affectedVersions: request.affectedVersions,
        },
        async (transaction) => {
          await transaction.insert("retentions", protectedMarker("must-roll-back"));
          injected = true;
          throw new Error("injected protected action failure");
        },
      ),
    ).rejects.toThrow(/injected protected action failure/u);
    expect(injected).toBe(true);
    expect(dialect.query("SELECT retention_id AS marker FROM cp_retention")).toEqual([]);
    expect(await store.loadSnapshot()).toEqual(beforePreview);

    const consumed = await store.consumeConfirmation(
      {
        token,
        action: request.action,
        authorityToken: request.authorityToken,
        affectedVersions: request.affectedVersions,
      },
      async (transaction) => {
        await transaction.insert("retentions", protectedMarker("committed"));
        return "destroyed" as const;
      },
    );
    expect(consumed).toEqual({ status: "committed", value: "destroyed" });
    expect(dialect.query("SELECT retention_id AS marker FROM cp_retention")).toEqual([
      { marker: "committed" },
    ]);
    await expect(
      store.consumeConfirmation(
        {
          token,
          action: request.action,
          authorityToken: request.authorityToken,
          affectedVersions: request.affectedVersions,
        },
        async () => "must-not-run",
      ),
    ).resolves.toEqual({ status: "rejected", reason: "replayed" });
  });

  it("resumes external deletion monotonically after a durable mid-phase failure", async () => {
    const fixture = await createSqliteFixture();
    let failAfterFirstRemoval = true;
    const { store } = await openRepository(fixture.storage, async (point) => {
      if (point === "after-external-remove" && failAfterFirstRemoval) {
        failAfterFirstRemoval = false;
        throw new Error("injected deletion interruption");
      }
    });
    await store.initialize();
    const material = [
      { kind: "bytes" as const, id: "artifact-1" },
      { kind: "key" as const, id: "key-1" },
    ];
    const affectedVersions = [
      "provider:provider-1",
      ...material.map((item) => `${item.kind}:${item.id}`),
    ];
    const inventoryHash = createHash("sha256")
      .update(JSON.stringify([...affectedVersions].sort()))
      .digest("hex");
    const versions = await store.initialize();
    const preview = await store.createConfirmationPreview({
      tokenId: "confirmation-1",
      action: "external-destruction",
      authorityToken: {
        authorityGeneration: versions.authorityGeneration,
        effectiveGeneration: versions.effectiveGeneration,
      },
      affectedVersions,
      expiresInMs: 60_000,
      consequences: ["Removes the selected external material."],
    });
    const confirmed = await store.confirmExternalDestruction(
      {
        token: preview,
        action: preview.action,
        authorityToken: preview.authorityToken,
        affectedVersions: preview.affectedVersions,
      },
      {
        destructionId: "destruction-1",
        providerIdentity: "provider-1",
        confirmationId: "confirmation-1",
        inventoryHash,
        material,
      },
    );
    expect(confirmed).toEqual({
      status: "committed",
      value: { destructionId: "destruction-1", phase: "intended" },
    });

    const present = new Set(["bytes:artifact-1", "key:key-1", "bytes:unrelated"]);
    const removed: string[] = [];
    const external = {
      providerIdentity: "provider-1",
      async remove(item: (typeof material)[number]) {
        const key = `${item.kind}:${item.id}`;
        removed.push(key);
        present.delete(key);
      },
      async isAbsent(item: (typeof material)[number]) {
        return !present.has(`${item.kind}:${item.id}`);
      },
    };

    await expect(
      store.resumeExternalDestruction("destruction-1", {
        ...external,
        providerIdentity: "provider-other",
      }),
    ).rejects.toThrow(/provider identity/u);
    expect(removed).toEqual([]);

    await expect(store.resumeExternalDestruction("destruction-1", external)).rejects.toThrow(
      /injected deletion interruption/u,
    );
    expect(present.has("bytes:unrelated")).toBe(true);

    const completed = await store.resumeExternalDestruction("destruction-1", external);
    expect(completed).toMatchObject({ destructionId: "destruction-1", phase: "completed" });
    expect(await store.resumeExternalDestruction("destruction-1", external)).toEqual(completed);
    expect(removed.toSorted()).toEqual(["bytes:artifact-1", "key:key-1"]);
    expect(present).toEqual(new Set(["bytes:unrelated"]));
  });

  it.skipIf(!postgresAdminUrl)(
    "serializes a real Postgres migration drain against old-node reentry",
    async () => {
      if (!postgresAdminUrl) throw new Error("Postgres fixture URL is unavailable");
      const fixture = await openPostgresRepository(postgresAdminUrl);
      const fingerprint = "migration-drain-race";
      const gateId = "migration-drain-race-gate";
      try {
        const token = await fixture.store.initialize();
        const [registrationResult, drainResult] = await Promise.allSettled([
          fixture.store.registerNode({
            nodeId: "old-node-racing-drain",
            bootstrapFingerprint: fingerprint,
            effectiveRuntimeFingerprint: fingerprint,
            compatibility: {
              binaryVersion: "0.34.1",
              schemaVersion: 3,
              keyVersion: 1,
              manifestVersion: 1,
              ...POSTGRES_DISTRIBUTED_COMPATIBILITY,
            },
            appliedToken: token,
            ttlMs: 60_000,
          }),
          fixture.dialect.beginMigrationDrain(gateId),
        ]);
        const registrationSucceeded =
          registrationResult.status === "fulfilled" && registrationResult.value.status === "ready";
        const drainSucceeded =
          drainResult.status === "fulfilled" && drainResult.value.status === "active";
        expect(Number(registrationSucceeded) + Number(drainSucceeded)).toBe(1);

        if (drainSucceeded) {
          await fixture.dialect.releaseMigrationDrain(gateId, "rolled-back");
          await expect(
            fixture.store.registerNode({
              nodeId: "node-after-exact-drain-rollback",
              bootstrapFingerprint: fingerprint,
              effectiveRuntimeFingerprint: fingerprint,
              compatibility: {
                binaryVersion: "0.34.1",
                schemaVersion: 3,
                keyVersion: 1,
                manifestVersion: 1,
                ...POSTGRES_DISTRIBUTED_COMPATIBILITY,
              },
              appliedToken: token,
              ttlMs: 60_000,
            }),
          ).resolves.toMatchObject({ status: "ready" });
        }
      } finally {
        await fixture.close();
      }
    },
  );

  it.skipIf(!postgresAdminUrl)(
    "persists the canonical corpus through the real Postgres dialect",
    async () => {
      if (!postgresAdminUrl) throw new Error("Postgres fixture URL is unavailable");
      const fixture = await openPostgresRepository(postgresAdminUrl);
      const postgresFingerprint = "postgres-fingerprint";
      try {
        const initial = await fixture.store.initialize();
        const node = await fixture.store.registerNode({
          nodeId: "postgres-node-1",
          bootstrapFingerprint: postgresFingerprint,
          effectiveRuntimeFingerprint: postgresFingerprint,
          compatibility: {
            binaryVersion: "0.34.1",
            schemaVersion: 3,
            keyVersion: 1,
            manifestVersion: 1,
            ...POSTGRES_DISTRIBUTED_COMPATIBILITY,
          },
          appliedToken: { authorityGeneration: 0, effectiveGeneration: 0, securityEpoch: 0 },
          ttlMs: 60_000,
        });
        expect(node.status).toBe("ready");
        if (node.status !== "ready") throw new Error("Postgres fixture node did not become ready");
        await expect(
          fixture.store.acknowledgeNode({
            nodeId: "postgres-node-1",
            bootstrapFingerprint: postgresFingerprint,
            effectiveRuntimeFingerprint: postgresFingerprint,
            appliedToken: initial,
            writerFence: node.writerFence,
          }),
        ).resolves.toEqual({ status: "applied", appliedNodes: 1 });
        const input = {
          binding: binding("operation-postgres-caplet", "postgres-caplet-corpus-v1"),
          aggregateId: aggregate.id,
          expectedAggregateVersion: 0,
          expectedAuthorityGeneration: initial.authorityGeneration,
          expectedSecurityEpoch: initial.securityEpoch,
          writerFence: node.writerFence,
          activity: {
            id: "activity-postgres-caplet",
            action: "caplet.install",
            target: { capletId: aggregate.id },
          },
          aggregate,
          projection,
          provenance: provenance("provenance-caplet", assetHash),
        } as const;
        await fixture.store.reserveOperation(input.binding, input.aggregateId);
        await expect(fixture.store.mutateCaplet(input)).resolves.toMatchObject({
          status: "committed",
        });
        const snapshot = await fixture.store.loadSnapshot();
        expect(snapshot.caplets).toHaveLength(1);
        await expect(
          fixture.store.acknowledgeNode({
            nodeId: "postgres-node-1",
            bootstrapFingerprint: postgresFingerprint,
            effectiveRuntimeFingerprint: postgresFingerprint,
            appliedToken: initial,
            writerFence: node.writerFence,
          }),
        ).resolves.toEqual({ status: "rejected", reason: "token-behind" });
        expect(snapshot.caplets[0]?.aggregate).toEqual(aggregate);
        const replacements = ["a", "b"].map((suffix) => ({
          ...input,
          binding: binding(
            `operation-postgres-conflict-${suffix}`,
            `postgres-caplet-corpus-v2-${suffix}`,
          ),
          expectedAggregateVersion: 1,
          aggregate: {
            ...aggregate,
            aggregateVersion: 2,
            installationProvenanceId: `provenance-postgres-conflict-${suffix}`,
            portable: {
              ...aggregate.portable,
              name: `Canonical corpus Caplet ${suffix}`,
            },
          },
          projection: {
            ...projection,
            activationHistory: projection.activationHistory.map((entry) => ({
              ...entry,
              aggregateVersion: 2,
            })),
          },
          activity: {
            ...input.activity,
            id: `activity-postgres-conflict-${suffix}`,
          },
          provenance: provenance(
            `provenance-postgres-conflict-${suffix}`,
            createHash("sha256").update(`replacement-${suffix}`).digest("hex"),
          ),
        }));
        await Promise.all(
          replacements.map((replacement) =>
            fixture.store.reserveOperation(replacement.binding, replacement.aggregateId),
          ),
        );
        let snapshotEntered!: () => void;
        let releaseSnapshot!: () => void;
        const entered = new Promise<void>((resolve) => {
          snapshotEntered = resolve;
        });
        const released = new Promise<void>((resolve) => {
          releaseSnapshot = resolve;
        });
        const repeatableRead = fixture.dialect.snapshotTransaction(async (transaction) => {
          const filter = {
            equals: {
              logicalHostId,
              storeId,
              id: aggregate.id,
            },
          };
          const before = await transaction.select<{ aggregateVersion: number | bigint }>(
            "caplets",
            filter,
          );
          snapshotEntered();
          await released;
          const after = await transaction.select<{ aggregateVersion: number | bigint }>(
            "caplets",
            filter,
          );
          return [Number(before[0]?.aggregateVersion), Number(after[0]?.aggregateVersion)];
        });
        await entered;
        let conflictResults;
        try {
          conflictResults = await Promise.all(
            replacements.map((replacement) => fixture.store.mutateCaplet(replacement)),
          );
        } finally {
          releaseSnapshot();
        }
        expect(await repeatableRead).toEqual([1, 1]);
        expect(conflictResults.map((result) => result.status).toSorted()).toEqual([
          "committed",
          "conflict",
        ]);
        const capacityToken = await fixture.store.convergenceToken();
        for (let index = 1; index < 16; index += 1) {
          const registration = await fixture.store.registerNode({
            nodeId: `postgres-node-${index + 1}`,
            bootstrapFingerprint: postgresFingerprint,
            effectiveRuntimeFingerprint: postgresFingerprint,
            compatibility: {
              binaryVersion: "0.34.1",
              schemaVersion: 3,
              keyVersion: 1,
              manifestVersion: 1,
              ...POSTGRES_DISTRIBUTED_COMPATIBILITY,
            },
            appliedToken: capacityToken,
            ttlMs: 60_000,
          });
          expect(registration).toMatchObject({ status: "ready", readyNodes: index + 1 });
          if (registration.status !== "ready") throw new Error("capacity node was not ready");
          await expect(
            fixture.store.acknowledgeNode({
              nodeId: `postgres-node-${index + 1}`,
              bootstrapFingerprint: postgresFingerprint,
              effectiveRuntimeFingerprint: postgresFingerprint,
              appliedToken: capacityToken,
              writerFence: registration.writerFence,
            }),
          ).resolves.toEqual({ status: "applied", appliedNodes: index });
        }
        await expect(
          fixture.store.registerNode({
            nodeId: "postgres-node-17",
            bootstrapFingerprint: postgresFingerprint,
            effectiveRuntimeFingerprint: postgresFingerprint,
            compatibility: {
              binaryVersion: "0.34.1",
              schemaVersion: 3,
              keyVersion: 1,
              manifestVersion: 1,
              ...POSTGRES_DISTRIBUTED_COMPATIBILITY,
            },
            appliedToken: capacityToken,
            ttlMs: 60_000,
          }),
        ).resolves.toEqual({ status: "capacity-rejected", readyNodes: 16 });
        expect(snapshot.caplets[0]?.projection).toEqual(projection);
      } finally {
        await fixture.close();
      }
    },
  );

  it.skipIf(!postgresAdminUrl)(
    "admits only one of two concurrent acknowledgements at the 16-node capacity fence",
    async () => {
      if (!postgresAdminUrl) throw new Error("Postgres fixture URL is unavailable");
      const fixture = await openPostgresRepository(postgresAdminUrl);
      const fingerprint = "postgres-capacity-race";
      const compatibility = {
        binaryVersion: "0.34.1",
        schemaVersion: 3,
        keyVersion: 1,
        manifestVersion: 1,
        ...POSTGRES_DISTRIBUTED_COMPATIBILITY,
      } as const;
      try {
        const token = await fixture.store.initialize();
        for (let index = 0; index < 15; index += 1) {
          const nodeId = `capacity-ready-${index}`;
          const registration = await fixture.store.registerNode({
            nodeId,
            bootstrapFingerprint: fingerprint,
            effectiveRuntimeFingerprint: fingerprint,
            compatibility,
            appliedToken: token,
            ttlMs: 60_000,
          });
          if (registration.status !== "ready") {
            throw new Error(`${nodeId} was ${registration.status}`);
          }
          await expect(
            fixture.store.acknowledgeNode({
              nodeId,
              bootstrapFingerprint: fingerprint,
              effectiveRuntimeFingerprint: fingerprint,
              appliedToken: token,
              writerFence: registration.writerFence,
            }),
          ).resolves.toMatchObject({ status: "applied" });
        }
        const pendingNodeIds = ["capacity-race-a", "capacity-race-b"] as const;
        const pending = await Promise.all(
          pendingNodeIds.map((nodeId) =>
            fixture.store.registerNode({
              nodeId,
              bootstrapFingerprint: fingerprint,
              effectiveRuntimeFingerprint: fingerprint,
              compatibility,
              appliedToken: token,
              ttlMs: 60_000,
            }),
          ),
        );
        expect(pending.every((registration) => registration.status === "ready")).toBe(true);
        const acknowledgements = await Promise.all(
          pending.map((registration, index) => {
            if (registration.status !== "ready") {
              throw new Error(`${pendingNodeIds[index]} was ${registration.status}`);
            }
            return fixture.store.acknowledgeNode({
              nodeId: pendingNodeIds[index]!,
              bootstrapFingerprint: fingerprint,
              effectiveRuntimeFingerprint: fingerprint,
              appliedToken: token,
              writerFence: registration.writerFence,
            });
          }),
        );
        expect(acknowledgements.filter((result) => result.status === "applied")).toHaveLength(1);
        expect(acknowledgements.filter((result) => result.status === "rejected")).toHaveLength(1);
        expect(
          await fixture.adminQuery<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM caplets.cp_cluster_node_lease
             WHERE logical_host_id = $1 AND store_id = $2
               AND state = 'ready' AND expires_at::timestamptz > clock_timestamp()`,
            [logicalHostId, storeId],
          ),
        ).toEqual([{ count: "16" }]);

        const rejectedIndex = acknowledgements.findIndex((result) => result.status === "rejected");
        await expect(
          fixture.store.registerNode({
            nodeId: pendingNodeIds[rejectedIndex]!,
            bootstrapFingerprint: fingerprint,
            effectiveRuntimeFingerprint: fingerprint,
            compatibility,
            appliedToken: token,
            ttlMs: 60_000,
          }),
        ).resolves.toEqual({ status: "capacity-rejected", readyNodes: 16 });
        expect(
          await fixture.adminQuery<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM caplets.cp_cluster_node_lease
             WHERE logical_host_id = $1 AND store_id = $2 AND state = 'capacity-rejected'`,
            [logicalHostId, storeId],
          ),
        ).toEqual([{ count: "1" }]);
      } finally {
        await fixture.close();
      }
    },
  );

  it.skipIf(!postgresAdminUrl)(
    "serializes concurrent Postgres tuple-fingerprint binding as one idempotent row",
    async () => {
      if (!postgresAdminUrl) throw new Error("Postgres fixture URL is unavailable");
      const fixture = await openPostgresRepository(postgresAdminUrl);
      const fingerprint = "postgres-concurrent-tuple";
      try {
        const token = await fixture.store.initialize();
        const registrations = [];
        for (let index = 0; index < 16; index += 1) {
          const registration = await fixture.store.registerNode({
            nodeId: `postgres-concurrent-node-${index + 1}`,
            bootstrapFingerprint: fingerprint,
            effectiveRuntimeFingerprint: fingerprint,
            compatibility: {
              binaryVersion: "0.34.1",
              schemaVersion: 3,
              keyVersion: 1,
              manifestVersion: 1,
              ...POSTGRES_DISTRIBUTED_COMPATIBILITY,
            },
            appliedToken: token,
            ttlMs: 60_000,
          });
          expect(registration.status).toBe("ready");
          if (registration.status !== "ready") {
            throw new Error("Concurrent Postgres fixture node did not become ready");
          }
          registrations.push(registration);
        }

        const acknowledgements = await Promise.all(
          registrations.map((registration, index) =>
            fixture.store.acknowledgeNode({
              nodeId: `postgres-concurrent-node-${index + 1}`,
              bootstrapFingerprint: fingerprint,
              effectiveRuntimeFingerprint: fingerprint,
              appliedToken: token,
              writerFence: registration.writerFence,
            }),
          ),
        );
        expect(acknowledgements.every((result) => result.status === "applied")).toBe(true);
        await expect(
          fixture.adminQuery<{ count: string }>(
            `SELECT COUNT(*)::text AS count
               FROM caplets.cp_migration
              WHERE logical_host_id = $1
                AND store_id = $2
                AND migration_id = $3`,
            [
              logicalHostId,
              storeId,
              `u10-runtime-tuple:${token.authorityGeneration}:${token.effectiveGeneration}:${token.securityEpoch}`,
            ],
          ),
        ).resolves.toEqual([{ count: "1" }]);
      } finally {
        await fixture.close();
      }
    },
  );

  it.skipIf(!postgresAdminUrl)(
    "rolls back domain, activity, provenance, generation, and receipt rows when the final Postgres fence is revoked",
    async () => {
      const paused = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const fixture = await openPostgresRepository(postgresAdminUrl!, async (point) => {
        if (point !== "before-fence-guard") return;
        paused.resolve();
        await release.promise;
      });
      try {
        const versions = await fixture.store.initialize();
        const registration = await fixture.store.registerNode({
          nodeId: "postgres-final-fence",
          bootstrapFingerprint: "postgres-final-fence",
          effectiveRuntimeFingerprint: "postgres-final-fence",
          compatibility: {
            binaryVersion: "0.34.1",
            schemaVersion: 3,
            keyVersion: 1,
            manifestVersion: 1,
            ...POSTGRES_DISTRIBUTED_COMPATIBILITY,
          },
          appliedToken: versions,
          ttlMs: 60_000,
        });
        if (registration.status !== "ready")
          throw new Error("Postgres final-fence node was not ready");
        await expect(
          fixture.store.acknowledgeNode({
            nodeId: "postgres-final-fence",
            bootstrapFingerprint: "postgres-final-fence",
            effectiveRuntimeFingerprint: "postgres-final-fence",
            appliedToken: versions,
            writerFence: registration.writerFence,
          }),
        ).resolves.toEqual({ status: "applied", appliedNodes: 1 });
        const input = {
          binding: binding("operation-postgres-final-fence", "postgres-final-fence"),
          aggregateId: aggregate.id,
          expectedAggregateVersion: 0,
          expectedAuthorityGeneration: versions.authorityGeneration,
          expectedSecurityEpoch: versions.securityEpoch,
          writerFence: registration.writerFence,
          activity: {
            id: "activity-postgres-final-fence",
            action: "caplet.install",
            target: { capletId: aggregate.id },
          },
          aggregate,
          projection,
          provenance: provenance("provenance-caplet", assetHash),
        } as const;
        await fixture.store.reserveOperation(input.binding, input.aggregateId);
        const mutation = fixture.store.mutateCaplet(input);
        await paused.promise;
        await fixture.store.revokeNode("postgres-final-fence");
        release.resolve();

        await expect(mutation).resolves.toEqual({ status: "conflict", reason: "writer-fence" });
        expect((await fixture.store.loadSnapshot()).caplets).toEqual([]);
        const residue = await fixture.adminQuery<{
          caplets: string;
          provenance: string;
          activity: string;
          receipts: string;
        }>(`
          SELECT
            (SELECT count(*) FROM caplets.cp_caplet)::text AS caplets,
            (SELECT count(*) FROM caplets.cp_caplet_provenance)::text AS provenance,
            (SELECT count(*) FROM caplets.cp_operator_activity)::text AS activity,
            (SELECT count(*) FROM caplets.cp_operation_outcome)::text AS receipts
        `);
        expect(residue).toEqual([{ caplets: "0", provenance: "0", activity: "0", receipts: "0" }]);
        const replacement = await fixture.store.registerNode({
          nodeId: "postgres-final-fence",
          bootstrapFingerprint: "postgres-final-fence",
          effectiveRuntimeFingerprint: "postgres-final-fence",
          compatibility: {
            binaryVersion: "0.34.1",
            schemaVersion: 3,
            keyVersion: 1,
            manifestVersion: 1,
            ...POSTGRES_DISTRIBUTED_COMPATIBILITY,
          },
          appliedToken: versions,
          ttlMs: 60_000,
        });
        expect(replacement).toMatchObject({
          status: "ready",
          writerFence: {
            leaseId: registration.writerFence.leaseId,
            writerEpoch: registration.writerFence.writerEpoch + 1,
          },
        });
      } finally {
        release.resolve();
        await fixture.close();
      }
    },
  );

  it.skipIf(!postgresAdminUrl)(
    "enforces the real Postgres 16-ready-node ceiling without displacing existing leases",
    async () => {
      const fixture = await openPostgresRepository(postgresAdminUrl!);
      try {
        const versions = await fixture.store.initialize();
        const registrations = [];
        for (let index = 0; index < 16; index += 1) {
          const registration = await fixture.store.registerNode({
            nodeId: `postgres-capacity-${index}`,
            bootstrapFingerprint: "postgres-capacity",
            effectiveRuntimeFingerprint: "postgres-capacity",
            compatibility: {
              ...fixture.dialect.compatibility,
              ...POSTGRES_DISTRIBUTED_COMPATIBILITY,
            },
            appliedToken: versions,
            ttlMs: 60_000,
          });
          expect(registration).toMatchObject({ status: "ready", readyNodes: index + 1 });
          if (registration.status !== "ready") throw new Error("capacity node was not ready");
          await expect(
            fixture.store.acknowledgeNode({
              nodeId: `postgres-capacity-${index}`,
              bootstrapFingerprint: "postgres-capacity",
              effectiveRuntimeFingerprint: "postgres-capacity",
              appliedToken: versions,
              writerFence: registration.writerFence,
            }),
          ).resolves.toEqual({ status: "applied", appliedNodes: index + 1 });
          registrations.push(registration);
        }

        await expect(
          fixture.store.registerNode({
            nodeId: "postgres-capacity-17",
            bootstrapFingerprint: "postgres-capacity",
            effectiveRuntimeFingerprint: "postgres-capacity",
            compatibility: {
              ...fixture.dialect.compatibility,
              ...POSTGRES_DISTRIBUTED_COMPATIBILITY,
            },
            appliedToken: versions,
            ttlMs: 60_000,
          }),
        ).resolves.toEqual({ status: "capacity-rejected", readyNodes: 16 });
        await expect(
          fixture.store.acknowledgeNode({
            nodeId: "postgres-capacity-0",
            bootstrapFingerprint: "postgres-capacity",
            effectiveRuntimeFingerprint: "postgres-capacity",
            appliedToken: versions,
            writerFence: registrations[0]!.writerFence,
          }),
        ).resolves.toMatchObject({ status: "applied", appliedNodes: 16 });
      } finally {
        await fixture.close();
      }
    },
  );

  it.skipIf(!postgresAdminUrl)(
    "runs the U6 verifier, refresh replay, session, and encrypted OAuth seams on real Postgres",
    async () => {
      const fixture = await openPostgresRepository(postgresAdminUrl!);
      const keyParent = await mkdtemp(join(tmpdir(), "caplets-u6-postgres-keys-"));
      roots.push(keyParent);
      const keyRoot = join(keyParent, "state");
      try {
        await fixture.store.initialize();
        const bootstrap = await bootstrapSqliteFileV1({
          root: keyRoot,
          logicalHostId,
          storeId,
        });
        const keyProvider = await loadFileV1KeyProvider({
          manifestPath: bootstrap.profileManifestPaths.online,
          expectedLogicalHostId: logicalHostId,
          expectedStoreId: storeId,
          expectedProfile: "online",
        });
        const repository = createControlPlaneSecurityRepository({
          identity,
          dialect: fixture.dialect,
          keyProvider,
        });
        const client = await repository.issueClient({
          hostUrl: "https://u6-postgres.example",
          clientLabel: "postgres-u6",
          role: "operator",
        });
        const session = await repository.create({ operatorClientId: client.clientId });
        await expect(
          repository.validate({
            cookieValue: session.cookieValue,
            requireCsrf: true,
            csrfToken: session.session.csrfToken,
          }),
        ).resolves.toMatchObject({ operatorClientId: client.clientId });
        const rotated = await repository.refreshClientCredentials({
          hostUrl: client.hostUrl,
          refreshToken: client.refreshToken,
        });
        await expect(
          repository.refreshClientCredentials({
            hostUrl: client.hostUrl,
            refreshToken: client.refreshToken,
          }),
        ).rejects.toMatchObject({ code: "AUTH_FAILED" });
        await repository.writeTokenBundle({
          server: "u6-postgres",
          accessToken: "u6-postgres-encrypted-sentinel",
        });
        await expect(repository.readTokenBundle("u6-postgres")).resolves.toEqual({
          server: "u6-postgres",
          accessToken: "u6-postgres-encrypted-sentinel",
        });
        await expect(
          repository.validateAccessToken({
            hostUrl: rotated.hostUrl,
            accessToken: rotated.accessToken,
          }),
        ).rejects.toMatchObject({ code: "AUTH_FAILED" });
        const expiredActivity = await repository.append({
          actorClientId: client.clientId,
          action: "dashboard_login_completed",
          target: { type: "dashboard_session", id: "postgres-expired" },
        });
        const retainedActivity = await repository.append({
          actorClientId: client.clientId,
          action: "dashboard_logout",
          target: { type: "dashboard_session", id: "postgres-retained" },
        });
        await fixture.adminQuery(
          "ALTER TABLE caplets.cp_operator_activity DISABLE TRIGGER cp_operator_activity_no_update",
        );
        await fixture.adminQuery(
          "UPDATE caplets.cp_operator_activity SET expires_at = $1 WHERE activity_id = $2",
          ["1970-01-01T00:00:00.000Z", expiredActivity.id],
        );
        await fixture.adminQuery(
          "ALTER TABLE caplets.cp_operator_activity ENABLE TRIGGER cp_operator_activity_no_update",
        );
        await expect(
          fixture.dialect.query("DELETE FROM caplets.cp_operator_activity WHERE activity_id = $1", [
            retainedActivity.id,
          ]),
        ).rejects.toThrow();
        await expect(
          fixture.dialect.query(
            "UPDATE caplets.cp_operator_activity SET outcome = 'failure' WHERE activity_id = $1",
            [retainedActivity.id],
          ),
        ).rejects.toThrow();
        await expect(
          fixture.dialect.maintenanceQuery("SELECT ciphertext FROM caplets.cp_vault_value LIMIT 1"),
        ).rejects.toThrow();
        const maintenance = createControlPlaneActivityMaintenanceRepository({
          identity,
          dialect: fixture.dialect,
        });
        await expect(maintenance.purgeExpired({ watermark: 7, limit: 10 })).resolves.toMatchObject({
          deleted: 1,
          watermark: 7,
        });
        await expect(maintenance.purgeExpired({ watermark: 6, limit: 10 })).rejects.toThrow();
        await expect(
          fixture.dialect.query<{ activityId: string }>(
            'SELECT activity_id AS "activityId" FROM caplets.cp_operator_activity ORDER BY activity_id',
          ),
        ).resolves.toEqual([{ activityId: retainedActivity.id }]);
        await expect(
          fixture.dialect.maintenanceQuery<{ policy: string; purgeWatermark: string | number }>(
            'SELECT policy, purge_watermark AS "purgeWatermark" FROM caplets.cp_retention ' +
              "WHERE resource_kind = 'operator-activity'",
          ),
        ).resolves.toEqual([{ policy: "bounded-expired-only", purgeWatermark: "7" }]);
      } finally {
        await fixture.close();
      }
    },
  );

  it.skipIf(!postgresAdminUrl || process.env.CAPLETS_FULL_ENVELOPE_BENCHMARK !== "1")(
    "qualifies generation-indexed snapshot materialization at the full Postgres envelope",
    async () => {
      const fixture = await openPostgresRepository(postgresAdminUrl!);
      try {
        const benchmarkFingerprint = "benchmark-fingerprint";
        const initial = await fixture.store.initialize();
        const node = await fixture.store.registerNode({
          nodeId: "benchmark-node-00",
          bootstrapFingerprint: benchmarkFingerprint,
          effectiveRuntimeFingerprint: benchmarkFingerprint,
          compatibility: {
            binaryVersion: "0.34.1",
            schemaVersion: 3,
            keyVersion: 1,
            manifestVersion: 1,
            ...POSTGRES_DISTRIBUTED_COMPATIBILITY,
          },
          appliedToken: { authorityGeneration: 0, effectiveGeneration: 0, securityEpoch: 0 },
          ttlMs: 3_600_000,
        });
        if (node.status !== "ready") throw new Error("benchmark writer did not become ready");
        await expect(
          fixture.store.acknowledgeNode({
            nodeId: "benchmark-node-00",
            bootstrapFingerprint: benchmarkFingerprint,
            effectiveRuntimeFingerprint: benchmarkFingerprint,
            appliedToken: initial,
            writerFence: node.writerFence,
          }),
        ).resolves.toEqual({ status: "applied", appliedNodes: 1 });
        for (let index = 1; index < STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes; index += 1) {
          const registration = await fixture.store.registerNode({
            nodeId: `benchmark-node-${index.toString().padStart(2, "0")}`,
            bootstrapFingerprint: benchmarkFingerprint,
            effectiveRuntimeFingerprint: benchmarkFingerprint,
            compatibility: {
              binaryVersion: "0.34.1",
              schemaVersion: 3,
              keyVersion: 1,
              manifestVersion: 1,
              ...POSTGRES_DISTRIBUTED_COMPATIBILITY,
            },
            appliedToken: initial,
            ttlMs: 3_600_000,
          });
          if (registration.status !== "ready") throw new Error("benchmark reader was not admitted");
          await fixture.store.acknowledgeNode({
            nodeId: `benchmark-node-${index.toString().padStart(2, "0")}`,
            bootstrapFingerprint: benchmarkFingerprint,
            effectiveRuntimeFingerprint: benchmarkFingerprint,
            appliedToken: initial,
            writerFence: registration.writerFence,
          });
        }

        const baseBytes = Array.from(
          { length: STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets },
          (_, index) =>
            encodePortableCaplet(
              maxEnvelopeCaplet(index, "", 1, "initial", 1, 1).aggregate.portable,
            ).byteLength,
        ).reduce((total, bytes) => total + bytes, 0);
        const remainingBytes = STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes - baseBytes;
        if (remainingBytes < 0) throw new Error("full-envelope fixture metadata exceeds byte cap");
        const bodyBytes = Math.floor(
          remainingBytes / STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets,
        );
        const bodyRemainder = remainingBytes % STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets;

        let authorityGeneration = initial.authorityGeneration;
        let effectiveGeneration = initial.effectiveGeneration;
        await fixture.dialect.runtimeTransaction(async (transaction) => {
          for (let index = 0; index < STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets; index += 1) {
            const item = maxEnvelopeCaplet(
              index,
              "x".repeat(bodyBytes + (index < bodyRemainder ? 1 : 0)),
              1,
              `benchmark-provenance-${index}`,
              authorityGeneration,
              effectiveGeneration,
            );
            await writeCanonicalCapletRows(transaction, {
              identity,
              ...item,
              now: "2026-07-14T00:00:00.000Z",
              authorityGeneration,
              effectiveGeneration,
              securityEpoch: initial.securityEpoch,
            });
          }
        });
        await expect(
          fixture.adminQuery<{
            capletCount: string | number;
            normalizedRowCount: string | number;
            encodedByteCount: string | number;
          }>(
            `UPDATE caplets.cp_snapshot_envelope
             SET caplet_count = $1,
                 normalized_row_count = $2,
                 encoded_byte_count = $3
             WHERE logical_host_id = $4
               AND store_id = $5
               AND envelope_id = 'control-plane'
             RETURNING caplet_count AS "capletCount",
                       normalized_row_count AS "normalizedRowCount",
                       encoded_byte_count AS "encodedByteCount"`,
            [
              STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets,
              STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows,
              STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes,
              logicalHostId,
              storeId,
            ],
          ),
        ).resolves.toEqual([
          {
            capletCount: String(STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets),
            normalizedRowCount: String(STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows),
            encodedByteCount: String(STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes),
          },
        ]);

        const seededSnapshot = await fixture.store.loadSnapshot();
        expect(seededSnapshot.caplets).toHaveLength(STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets);
        expect(seededSnapshot.normalizedRows).toBe(STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows);
        expect(seededSnapshot.encodedBytes).toBe(
          STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes,
        );

        const measuredItem = seededSnapshot.caplets.at(-1);
        if (!measuredItem) throw new Error("full-envelope measurement Caplet is unavailable");
        let measuredAggregate: CanonicalCapletAggregate = measuredItem.aggregate;
        let measuredProjection: CanonicalCapletRelationalProjection = measuredItem.projection;
        let materializedGenerationChanges = 0;
        let materializationQueries = 0;
        const publicationLatencies: number[] = [];
        let publishedSnapshotGeneration = effectiveGeneration;
        const advanceAuthoritativeSnapshot = async (): Promise<number> => {
          const sampleIndex = materializedGenerationChanges;
          const aggregateVersion = measuredAggregate.aggregateVersion + 1;
          const provenanceId = `benchmark-sample-provenance-${sampleIndex
            .toString()
            .padStart(4, "0")}`;
          const operationId = `benchmark-sample-${sampleIndex.toString().padStart(4, "0")}`;
          const operationBinding = binding(operationId, `${operationId}-request`);
          const aggregate: CanonicalCapletAggregate = {
            ...measuredAggregate,
            aggregateVersion,
            installationProvenanceId: provenanceId,
          };
          const projection: CanonicalCapletRelationalProjection = {
            ...measuredProjection,
            activationHistory: measuredProjection.activationHistory.map((event) => ({
              ...event,
              aggregateVersion,
            })),
          };
          await fixture.store.reserveOperation(operationBinding, aggregate.id);
          const result = await fixture.store.mutateCaplet({
            binding: operationBinding,
            aggregateId: aggregate.id,
            expectedAggregateVersion: measuredAggregate.aggregateVersion,
            expectedAuthorityGeneration: authorityGeneration,
            expectedSecurityEpoch: initial.securityEpoch,
            writerFence: { ...node.writerFence, authorityGeneration },
            activity: {
              id: `benchmark-sample-activity-${sampleIndex.toString().padStart(4, "0")}`,
              action: "caplet.update",
              target: { capletId: aggregate.id },
            },
            aggregate,
            projection,
            provenance: provenance(
              provenanceId,
              createHash("sha256").update(operationId).digest("hex"),
            ),
          });
          if (result.status !== "committed") {
            throw new Error(`full-envelope measured mutation ${sampleIndex} did not commit`);
          }
          measuredAggregate = aggregate;
          measuredProjection = projection;
          authorityGeneration = result.receipt.authorityToken.authorityGeneration;
          effectiveGeneration = result.receipt.authorityToken.effectiveGeneration;
          materializedGenerationChanges += 1;
          return effectiveGeneration;
        };
        const materializers = Array.from({ length: STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes }, () =>
          createControlPlaneRepository({
            identity: { logicalHostId, storeId, operationNamespace },
            dialect: fixture.dialect,
          }),
        );
        await Promise.all(materializers.map((materializer) => materializer.initialize()));
        const loadChangedSnapshots = async (): Promise<readonly number[]> => {
          const previousGeneration = publishedSnapshotGeneration;
          const expectedGeneration = await advanceAuthoritativeSnapshot();
          const publicationStartedAt = performance.now();
          const samples = await Promise.all(
            materializers.map(async (materializer) => {
              const startedAt = performance.now();
              const snapshot = await materializer.loadSnapshot();
              const elapsedMs = performance.now() - startedAt;
              if (
                snapshot.caplets.length !== STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets ||
                snapshot.normalizedRows !== STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows ||
                snapshot.encodedBytes !== STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes
              ) {
                throw new Error("full-envelope snapshot changed shape during measurement");
              }
              if (
                snapshot.versions.effectiveGeneration !== expectedGeneration ||
                snapshot.versions.effectiveGeneration <= previousGeneration
              ) {
                throw new Error("full-envelope measurement did not materialize a changed snapshot");
              }
              publicationLatencies.push(performance.now() - publicationStartedAt);
              return elapsedMs;
            }),
          );
          publishedSnapshotGeneration = expectedGeneration;
          materializationQueries += samples.length;
          return samples;
        };
        const runP99Ms: number[] = [];
        const measuredSamplesPerRun: number[] = [];
        for (
          let runIndex = 0;
          runIndex < STORAGE_BENCHMARK_ENVELOPE.independentRuns;
          runIndex += 1
        ) {
          for (
            let warmupIndex = 0;
            warmupIndex < STORAGE_BENCHMARK_ENVELOPE.warmupSamples;
            warmupIndex += 1
          ) {
            await loadChangedSnapshots();
          }
          const runSamples: number[] = [];
          for (
            let sampleIndex = 0;
            sampleIndex < STORAGE_BENCHMARK_ENVELOPE.measuredSamplesPerRun;
            sampleIndex += 1
          ) {
            runSamples.push(...(await loadChangedSnapshots()));
          }
          measuredSamplesPerRun.push(runSamples.length);
          runP99Ms.push(nearestRank(runSamples, 0.99));
        }
        const generationChangesPerRun =
          STORAGE_BENCHMARK_ENVELOPE.warmupSamples +
          STORAGE_BENCHMARK_ENVELOPE.measuredSamplesPerRun;
        const expectedGenerationChanges =
          generationChangesPerRun * STORAGE_BENCHMARK_ENVELOPE.independentRuns;
        const expectedQueries =
          expectedGenerationChanges * STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes;
        expect(materializedGenerationChanges).toBe(expectedGenerationChanges);
        expect(materializationQueries).toBe(expectedQueries);
        expect(publicationLatencies).toHaveLength(expectedQueries);
        expect(measuredSamplesPerRun).toEqual(
          Array.from(
            { length: STORAGE_BENCHMARK_ENVELOPE.independentRuns },
            () =>
              STORAGE_BENCHMARK_ENVELOPE.measuredSamplesPerRun *
              STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes,
          ),
        );
        const publicationP99Ms = nearestRank(publicationLatencies, 0.99);
        expect(
          runP99Ms.every((value) => value <= STORAGE_BENCHMARK_ENVELOPE.maxSnapshotLoadP99Ms),
        ).toBe(true);
        expect(publicationP99Ms).toBeLessThanOrEqual(
          STORAGE_BENCHMARK_ENVELOPE.maxConvergenceP99Ms,
        );
        if (process.env.CAPLETS_BENCHMARK_REPORT === "1") {
          process.stdout.write(
            `${JSON.stringify({
              profile: "full-envelope",
              backend: "postgres",
              architecture: "generation-indexed-materialization",
              evidence: "full-envelope",
              notificationMode: "suppressed",
              passRule: "every-independent-run",
              effectiveCaplets: STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets,
              normalizedRows: STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows,
              encodedBytes: STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes,
              concurrentRefreshers: STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes,
              warmupSamplesPerRun: STORAGE_BENCHMARK_ENVELOPE.warmupSamples,
              measuredSamplesPerRun: STORAGE_BENCHMARK_ENVELOPE.measuredSamplesPerRun,
              independentRuns: STORAGE_BENCHMARK_ENVELOPE.independentRuns,
              measuredRefresherSamplesPerRun: measuredSamplesPerRun,
              authoritativeGenerationChanges: materializedGenerationChanges,
              percentile: 0.99,
              percentileMethod: "nearest-rank",
              runP99Ms,
              publicationP99Ms,
              maxP99Ms: STORAGE_BENCHMARK_ENVELOPE.maxSnapshotLoadP99Ms,
              passed: true,
            })}\n`,
          );
        }
      } finally {
        await fixture.close();
      }
    },
    7_200_000,
  );

  it.skipIf(!postgresAdminUrl || process.env.CAPLETS_FULL_ENVELOPE_BENCHMARK !== "1")(
    "qualifies changed 32 MiB Postgres snapshot materialization and publication p99",
    async () => {
      const fixture = await openPostgresRepository(postgresAdminUrl!);
      try {
        const capletCount = 256;
        const encodedByteTarget = 32 * 1024 * 1024;
        const normalizedRowTarget = capletCount * 50;
        const fingerprint = "representative-benchmark-fingerprint";
        const initial = await fixture.store.initialize();
        const node = await fixture.store.registerNode({
          nodeId: "representative-benchmark-node",
          bootstrapFingerprint: fingerprint,
          effectiveRuntimeFingerprint: fingerprint,
          compatibility: {
            binaryVersion: "0.34.1",
            schemaVersion: 3,
            keyVersion: 1,
            manifestVersion: 1,
            ...POSTGRES_DISTRIBUTED_COMPATIBILITY,
          },
          appliedToken: initial,
          ttlMs: 3_600_000,
        });
        if (node.status !== "ready") throw new Error("representative writer did not become ready");
        await fixture.store.acknowledgeNode({
          nodeId: "representative-benchmark-node",
          bootstrapFingerprint: fingerprint,
          effectiveRuntimeFingerprint: fingerprint,
          appliedToken: initial,
          writerFence: node.writerFence,
        });
        const baseBytes = Array.from(
          { length: capletCount },
          (_, index) =>
            encodePortableCaplet(
              maxEnvelopeCaplet(index, "", 1, "representative-initial", 0, 0).aggregate.portable,
            ).byteLength,
        ).reduce((total, bytes) => total + bytes, 0);
        const remainingBytes = encodedByteTarget - baseBytes;
        if (remainingBytes < 0) throw new Error("representative fixture exceeds byte target");
        const bodyBytes = Math.floor(remainingBytes / capletCount);
        const bodyRemainder = remainingBytes % capletCount;
        await fixture.dialect.runtimeTransaction(async (transaction) => {
          for (let index = 0; index < capletCount; index += 1) {
            await writeCanonicalCapletRows(transaction, {
              identity,
              ...maxEnvelopeCaplet(
                index,
                "r".repeat(bodyBytes + (index < bodyRemainder ? 1 : 0)),
                1,
                `representative-provenance-${index}`,
                initial.authorityGeneration,
                initial.effectiveGeneration,
              ),
              now: "2026-07-14T00:00:00.000Z",
              authorityGeneration: initial.authorityGeneration,
              effectiveGeneration: initial.effectiveGeneration,
              securityEpoch: initial.securityEpoch,
            });
          }
        });
        await fixture.adminQuery(
          `UPDATE caplets.cp_snapshot_envelope
           SET caplet_count = $1,
               normalized_row_count = $2,
               encoded_byte_count = $3
           WHERE logical_host_id = $4
             AND store_id = $5
             AND envelope_id = 'control-plane'`,
          [capletCount, normalizedRowTarget, encodedByteTarget, logicalHostId, storeId],
        );
        const seeded = await fixture.store.loadSnapshot();
        expect(seeded).toMatchObject({
          normalizedRows: normalizedRowTarget,
          encodedBytes: encodedByteTarget,
        });
        let aggregate: CanonicalCapletAggregate = seeded.caplets.at(-1)!.aggregate;
        let projection: CanonicalCapletRelationalProjection = seeded.caplets.at(-1)!.projection;
        let authorityGeneration = initial.authorityGeneration;
        let publishedGeneration = initial.effectiveGeneration;
        let sampleIndex = 0;
        const publicationLatencies: number[] = [];
        const loadChanged = async (): Promise<number> => {
          const aggregateVersion = aggregate.aggregateVersion + 1;
          const provenanceId = `representative-sample-provenance-${sampleIndex
            .toString()
            .padStart(4, "0")}`;
          const operationId = `representative-sample-${sampleIndex.toString().padStart(4, "0")}`;
          const operationBinding = binding(operationId, `${operationId}-request`);
          const nextAggregate = {
            ...aggregate,
            aggregateVersion,
            installationProvenanceId: provenanceId,
          };
          const nextProjection = {
            ...projection,
            activationHistory: projection.activationHistory.map((event) => ({
              ...event,
              aggregateVersion,
            })),
          };
          await fixture.store.reserveOperation(operationBinding, aggregate.id);
          const result = await fixture.store.mutateCaplet({
            binding: operationBinding,
            aggregateId: aggregate.id,
            expectedAggregateVersion: aggregate.aggregateVersion,
            expectedAuthorityGeneration: authorityGeneration,
            expectedSecurityEpoch: initial.securityEpoch,
            writerFence: { ...node.writerFence, authorityGeneration },
            activity: {
              id: `representative-sample-activity-${sampleIndex.toString().padStart(4, "0")}`,
              action: "caplet.update",
              target: { capletId: aggregate.id },
            },
            aggregate: nextAggregate,
            projection: nextProjection,
            provenance: provenance(
              provenanceId,
              createHash("sha256").update(operationId).digest("hex"),
            ),
          });
          if (result.status !== "committed") {
            throw new Error(`representative mutation ${sampleIndex} did not commit`);
          }
          aggregate = nextAggregate;
          projection = nextProjection;
          authorityGeneration = result.receipt.authorityToken.authorityGeneration;
          const materializer = createControlPlaneRepository({ identity, dialect: fixture.dialect });
          await materializer.initialize();
          const startedAt = performance.now();
          const snapshot = await materializer.loadSnapshot();
          const elapsedMs = performance.now() - startedAt;
          expect(snapshot).toMatchObject({
            normalizedRows: normalizedRowTarget,
            encodedBytes: encodedByteTarget,
          });
          expect(snapshot.versions.effectiveGeneration).toBeGreaterThan(publishedGeneration);
          const publicationStartedAt = performance.now();
          publishedGeneration = snapshot.versions.effectiveGeneration;
          publicationLatencies.push(performance.now() - publicationStartedAt);
          sampleIndex += 1;
          return elapsedMs;
        };
        for (let index = 0; index < STORAGE_BENCHMARK_ENVELOPE.warmupSamples; index += 1) {
          await loadChanged();
        }
        const runP99Ms: number[] = [];
        for (
          let runIndex = 0;
          runIndex < STORAGE_BENCHMARK_ENVELOPE.independentRuns;
          runIndex += 1
        ) {
          const samples: number[] = [];
          for (
            let index = 0;
            index < STORAGE_BENCHMARK_ENVELOPE.measuredSamplesPerRun;
            index += 1
          ) {
            samples.push(await loadChanged());
          }
          runP99Ms.push(nearestRank(samples, 0.99));
        }
        const publicationP99Ms = nearestRank(publicationLatencies, 0.99);
        expect(
          runP99Ms.every((value) => value <= STORAGE_BENCHMARK_ENVELOPE.maxSnapshotLoadP99Ms),
        ).toBe(true);
        expect(publicationP99Ms).toBeLessThanOrEqual(
          STORAGE_BENCHMARK_ENVELOPE.maxConvergenceP99Ms,
        );
        if (process.env.CAPLETS_BENCHMARK_REPORT === "1") {
          process.stdout.write(
            `${JSON.stringify({
              profile: "representative-changed-snapshot",
              encodedBytes: encodedByteTarget,
              effectiveCaplets: capletCount,
              normalizedRows: normalizedRowTarget,
              samples: sampleIndex,
              runP99Ms,
              publicationP99Ms,
            })}\n`,
          );
        }
      } finally {
        await fixture.close();
      }
    },
    180_000,
  );
});

function binding(operationId: string, requestIdentity: string): CurrentHostOperationBinding {
  return {
    operationId,
    target: "global",
    logicalHostId,
    storeId,
    operationNamespace,
    actorId: "operator-1",
    requestIdentity,
    operationClass: "logical-state",
  };
}

function maxEnvelopeCaplet(
  index: number,
  body: string,
  aggregateVersion: number,
  provenanceId: string,
  authorityVersion: number,
  effectiveVersion: number,
): Readonly<{
  aggregate: CanonicalCapletAggregate;
  projection: CanonicalCapletRelationalProjection;
}> {
  const suffix = index.toString().padStart(4, "0");
  const capletId = `benchmark-caplet-${suffix}`;
  const sourceFrontmatter = { fixture: "full-envelope", index } as const;
  const tags = Array.from(
    { length: 45 },
    (_, tagIndex) => `tag-${tagIndex.toString().padStart(2, "0")}`,
  );
  const aggregate: CanonicalCapletAggregate = {
    modelVersion: 1,
    id: capletId,
    aggregateVersion,
    installationProvenanceId: provenanceId,
    ownership: "sql",
    activation: "active",
    effective: true,
    portable: {
      portableVersion: 1,
      canonicalModelVersion: 1,
      id: capletId,
      name: `Full envelope Caplet ${suffix}`,
      description: "Deterministic full-envelope benchmark fixture.",
      sourcePath: "CAPLET.md",
      frontmatter: {
        source: sourceFrontmatter,
        backend: { kind: "mcp", config: { index } },
        catalog: {
          displayName: `Benchmark ${suffix}`,
          summary: "Full-envelope fixture.",
          tags,
        },
        declaredInputs: [],
      },
      body,
      assets: [],
      references: [],
    },
    updateState: "current",
  };
  return {
    aggregate,
    projection: {
      capletId,
      sourceFrontmatter,
      body,
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
          aggregateVersion,
          authorityVersion,
          effectiveVersion,
          occurredAt: "2026-07-14T00:00:00.000Z",
        },
      ],
    },
  };
}

function provenance(id: string, contentHash: string) {
  return {
    id,
    sourceKind: "test-corpus",
    source: { fixture: "U3" },
    contentHash,
    installedAt: "2026-07-14T00:00:00.000Z",
    ownerId: "operator-1",
  } as const;
}

async function createSqliteFixture() {
  const root = await mkdtemp(join(tmpdir(), "caplets-control-plane-caplets-"));
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
  return { root, storage };
}

async function openRepository(
  storage: ResolvedSqliteStorage,
  failureInjector?: (point: ControlPlaneFailurePoint) => void | Promise<void>,
): Promise<{ store: ControlPlaneStore; dialect: SqliteControlPlaneDialect }> {
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
      dialect,
      failureInjector,
    }),
  };
}

function protectedMarker(id: string) {
  return {
    modelVersion: 1,
    id: `marker:${id}`,
    logicalHostId,
    storeId,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    aggregateVersion: 0,
    authorityVersion: 0,
    effectiveVersion: 0,
    securityVersion: 0,
    retentionId: id,
    resourceKind: "test-marker",
    resourceId: id,
    policy: "test",
    purgeWatermark: 0,
    retainUntil: "2026-07-14T00:00:00.000Z",
    destroyedAt: null,
  };
}

type TestPostgresPoolConstructor = new (
  configuration: Readonly<Record<string, unknown>>,
) => PostgresPool;

async function openPostgresRepository(
  adminUrl: string,
  failureInjector?: (point: ControlPlaneFailurePoint) => void | Promise<void>,
): Promise<
  Readonly<{
    store: ControlPlaneStore;
    dialect: PostgresControlPlaneDialect;
    close(): Promise<void>;
    adminQuery<T>(sql: string, parameters?: readonly unknown[]): Promise<readonly T[]>;
  }>
> {
  const moduleValue: unknown = require("pg");
  if (!moduleValue || typeof moduleValue !== "object" || !("Pool" in moduleValue)) {
    throw new Error("Postgres test driver does not expose Pool");
  }
  const Pool = moduleValue.Pool as TestPostgresPoolConstructor;
  const admin = new Pool({ connectionString: adminUrl, max: 2 });
  const runtimeRole = "caplets_u5_runtime";
  const migratorRole = "caplets_u5_migrator";
  const maintenanceRole = "caplets_u5_maintenance";
  const runtimePassword = "runtime-u5-fixture-password";
  const migratorPassword = "migrator-u5-fixture-password";
  const maintenancePassword = "maintenance-u5-fixture-password";
  const databaseName = new URL(adminUrl).pathname.slice(1);
  let dialect: PostgresControlPlaneDialect | undefined;
  try {
    await admin.query(`
      DROP SCHEMA IF EXISTS caplets CASCADE;
      DROP ROLE IF EXISTS ${quoteSafeSqlIdentifier(runtimeRole)};
      DROP ROLE IF EXISTS ${quoteSafeSqlIdentifier(migratorRole)};
      DROP ROLE IF EXISTS ${quoteSafeSqlIdentifier(maintenanceRole)};
      CREATE ROLE ${quoteSafeSqlIdentifier(runtimeRole)}
        LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
        PASSWORD '${runtimePassword}';
      CREATE ROLE ${quoteSafeSqlIdentifier(migratorRole)}
        LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
        PASSWORD '${migratorPassword}';
      CREATE ROLE ${quoteSafeSqlIdentifier(maintenanceRole)}
        LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
        PASSWORD '${maintenancePassword}';
      GRANT CREATE ON DATABASE ${quoteSafeSqlIdentifier(databaseName)}
        TO ${quoteSafeSqlIdentifier(migratorRole)};
    `);
    const pools = postgresPools(Pool, adminUrl, [
      [runtimeRole, runtimePassword],
      [migratorRole, migratorPassword],
      [maintenanceRole, maintenancePassword],
    ]);
    dialect = await attachVerifiedPostgresPools({
      storage: postgresFixtureStorage(),
      pools,
      roles: {
        runtime: runtimeRole,
        migrator: migratorRole,
        maintenance: maintenanceRole,
      },
      registry: await loadMigrationRegistry({ dialect: "postgres", assetRoot }),
      environment: { ...migrationEnvironment },
    });
    await dialect.migrate();
    await admin.query(`
      GRANT USAGE ON SCHEMA caplets TO
        ${quoteSafeSqlIdentifier(runtimeRole)}, ${quoteSafeSqlIdentifier(maintenanceRole)};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA caplets
        TO ${quoteSafeSqlIdentifier(runtimeRole)};
      REVOKE UPDATE, DELETE ON caplets.cp_operator_activity
        FROM ${quoteSafeSqlIdentifier(runtimeRole)};
      REVOKE ALL ON ALL TABLES IN SCHEMA caplets
        FROM ${quoteSafeSqlIdentifier(maintenanceRole)};
      GRANT SELECT ON caplets.cp_retention
        TO ${quoteSafeSqlIdentifier(maintenanceRole)};
    `);
    const openDialect = dialect;
    return {
      dialect: openDialect,
      store: createControlPlaneRepository({ identity, dialect: openDialect, failureInjector }),
      async adminQuery<T>(sql: string, parameters: readonly unknown[] = []) {
        const result = await admin.query(sql, parameters);
        return result.rows as readonly T[];
      },
      async close() {
        await openDialect.close();
        await dropPostgresFixture(admin, runtimeRole, migratorRole, maintenanceRole);
      },
    };
  } catch (error) {
    await dialect?.close();
    await dropPostgresFixture(admin, runtimeRole, migratorRole, maintenanceRole);
    throw error;
  }
}

function postgresPools(
  Pool: TestPostgresPoolConstructor,
  adminUrl: string,
  credentials: readonly (readonly [string, string])[],
) {
  const [runtime, migrator, maintenance] = credentials.map(([role, password]) => {
    const url = new URL(adminUrl);
    url.username = role;
    url.password = password;
    return new Pool({ connectionString: url.href, max: 2 });
  });
  if (!runtime || !migrator || !maintenance)
    throw new Error("Postgres fixture roles are incomplete");
  return { runtime, migrator, maintenance };
}

function postgresFixtureStorage(): ResolvedPostgresStorage {
  return {
    backend: "postgres",
    logicalHostId,
    storeId,
    operationNamespace,
    stateRoot: "/tmp/caplets-u5-postgres",
    keyProviderManifest: "/tmp/caplets-u5-postgres/key-provider.json",
    artifacts: {
      kind: "s3",
      identity: createArtifactProviderIdentity({
        kind: "s3",
        provider: "https://objects.invalid/caplets",
        namespace: "u5-conformance",
        logicalHostId,
        storeId,
      }),
    },
  };
}

async function dropPostgresFixture(
  admin: PostgresPool,
  runtimeRole: string,
  migratorRole: string,
  maintenanceRole: string,
): Promise<void> {
  await admin.query("DROP SCHEMA IF EXISTS caplets CASCADE");
  for (const role of [runtimeRole, migratorRole, maintenanceRole]) {
    const result = await admin.query(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
      [role],
    );
    const row = result.rows[0] as { exists?: unknown } | undefined;
    if (row?.exists !== true) continue;
    const identifier = quoteSafeSqlIdentifier(role);
    await admin.query(`DROP OWNED BY ${identifier} CASCADE`);
    await admin.query(`DROP ROLE ${identifier}`);
  }
  await admin.end();
}
