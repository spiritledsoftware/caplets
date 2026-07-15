import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STORAGE_BENCHMARK_ENVELOPE, nearestRank } from "../src/control-plane/benchmarks/fixture";
import { createArtifactProviderIdentity } from "../src/control-plane/artifacts/provider";
import type { CurrentHostOperationBinding } from "../src/current-host/operations";
import type {
  CanonicalCapletAggregate,
  CanonicalCapletRelationalProjection,
} from "../src/control-plane/caplets/model";
import { encodePortableCaplet } from "../src/control-plane/caplets/portable-codec";
import { createControlPlaneRepository } from "../src/control-plane/caplets/repository";
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
  hostAdministrator: false,
  now: new Date("2026-07-14T00:00:00.000Z"),
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
  it("persists and rehydrates canonical aggregates with an equal portable projection", async () => {
    const fixture = await createSqliteFixture();
    const first = await openRepository(fixture.storage);
    const initial = await first.store.initialize();
    const node = await first.store.registerNode({
      nodeId: "node-1",
      bootstrapFingerprint: "fingerprint-1",
      compatibility: {
        binaryVersion: "0.34.1",
        schemaVersion: 2,
        keyVersion: 1,
        manifestVersion: 1,
      },
      ttlMs: 60_000,
    });
    expect(node.status).toBe("ready");
    if (node.status !== "ready") throw new Error("fixture node did not become ready");

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
    "persists the canonical corpus through the real Postgres dialect",
    async () => {
      if (!postgresAdminUrl) throw new Error("Postgres fixture URL is unavailable");
      const fixture = await openPostgresRepository(postgresAdminUrl);
      try {
        const initial = await fixture.store.initialize();
        const node = await fixture.store.registerNode({
          nodeId: "postgres-node-1",
          bootstrapFingerprint: "postgres-fingerprint-1",
          compatibility: {
            binaryVersion: "0.34.1",
            schemaVersion: 2,
            keyVersion: 1,
            manifestVersion: 1,
          },
          ttlMs: 60_000,
        });
        expect(node.status).toBe("ready");
        if (node.status !== "ready") throw new Error("Postgres fixture node did not become ready");
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
        for (let index = 1; index < 16; index += 1) {
          await expect(
            fixture.store.registerNode({
              nodeId: `postgres-node-${index + 1}`,
              bootstrapFingerprint: `postgres-fingerprint-${index + 1}`,
              compatibility: {
                binaryVersion: "0.34.1",
                schemaVersion: 2,
                keyVersion: 1,
                manifestVersion: 1,
              },
              ttlMs: 60_000,
            }),
          ).resolves.toMatchObject({ status: "ready", readyNodes: index + 1 });
        }
        await expect(
          fixture.store.registerNode({
            nodeId: "postgres-node-17",
            bootstrapFingerprint: "postgres-fingerprint-17",
            compatibility: {
              binaryVersion: "0.34.1",
              schemaVersion: 2,
              keyVersion: 1,
              manifestVersion: 1,
            },
            ttlMs: 60_000,
          }),
        ).resolves.toEqual({ status: "capacity-rejected", readyNodes: 16 });
        expect(snapshot.caplets[0]?.projection).toEqual(projection);
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
        const initial = await fixture.store.initialize();
        const node = await fixture.store.registerNode({
          nodeId: "benchmark-node-00",
          bootstrapFingerprint: "benchmark-fingerprint-00",
          compatibility: {
            binaryVersion: "0.34.1",
            schemaVersion: 2,
            keyVersion: 1,
            manifestVersion: 1,
          },
          ttlMs: 3_600_000,
        });
        if (node.status !== "ready") throw new Error("benchmark writer did not become ready");
        for (let index = 1; index < STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes; index += 1) {
          await fixture.store.registerNode({
            nodeId: `benchmark-node-${index.toString().padStart(2, "0")}`,
            bootstrapFingerprint: `benchmark-fingerprint-${index.toString().padStart(2, "0")}`,
            compatibility: {
              binaryVersion: "0.34.1",
              schemaVersion: 2,
              keyVersion: 1,
              manifestVersion: 1,
            },
            ttlMs: 3_600_000,
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
        for (let index = 0; index < STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets; index += 1) {
          const item = maxEnvelopeCaplet(
            index,
            "x".repeat(bodyBytes + (index < bodyRemainder ? 1 : 0)),
            1,
            `benchmark-provenance-${index}`,
            authorityGeneration + 1,
            effectiveGeneration + 1,
          );
          const operationId = `benchmark-seed-${index}`;
          const operationBinding = binding(operationId, `${operationId}-request`);
          await fixture.store.reserveOperation(operationBinding, item.aggregate.id);
          const result = await fixture.store.mutateCaplet({
            binding: operationBinding,
            aggregateId: item.aggregate.id,
            expectedAggregateVersion: 0,
            expectedAuthorityGeneration: authorityGeneration,
            expectedSecurityEpoch: initial.securityEpoch,
            writerFence: { ...node.writerFence, authorityGeneration },
            activity: {
              id: `benchmark-seed-activity-${index}`,
              action: "caplet.install",
              target: { capletId: item.aggregate.id },
            },
            ...item,
            provenance: provenance(
              `benchmark-provenance-${index}`,
              index.toString(16).padStart(64, "0"),
            ),
          });
          if (result.status !== "committed") {
            throw new Error(`full-envelope seed ${index} did not commit`);
          }
          authorityGeneration = result.receipt.authorityToken.authorityGeneration;
          effectiveGeneration = result.receipt.authorityToken.effectiveGeneration;
        }

        const seededSnapshot = await fixture.store.loadSnapshot();
        expect(seededSnapshot.caplets).toHaveLength(STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets);
        expect(seededSnapshot.normalizedRows).toBe(STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows);
        expect(seededSnapshot.encodedBytes).toBe(
          STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes,
        );

        for (
          let index = 0;
          index <
          STORAGE_BENCHMARK_ENVELOPE.managementWritesPerSecond *
            STORAGE_BENCHMARK_ENVELOPE.writeBurstSeconds;
          index += 1
        ) {
          const current = seededSnapshot.caplets[index]!;
          const provenanceId = `benchmark-burst-provenance-${index}`;
          const operationId = `benchmark-burst-${index}`;
          const operationBinding = binding(operationId, `${operationId}-request`);
          await fixture.store.reserveOperation(operationBinding, current.aggregate.id);
          const result = await fixture.store.mutateCaplet({
            binding: operationBinding,
            aggregateId: current.aggregate.id,
            expectedAggregateVersion: 1,
            expectedAuthorityGeneration: authorityGeneration,
            expectedSecurityEpoch: initial.securityEpoch,
            writerFence: { ...node.writerFence, authorityGeneration },
            activity: {
              id: `benchmark-burst-activity-${index}`,
              action: "caplet.update",
              target: { capletId: current.aggregate.id },
            },
            aggregate: {
              ...current.aggregate,
              aggregateVersion: 2,
              installationProvenanceId: provenanceId,
            },
            projection: {
              ...current.projection,
              activationHistory: current.projection.activationHistory.map((event) => ({
                ...event,
                aggregateVersion: 2,
              })),
            },
            provenance: provenance(
              provenanceId,
              createHash("sha256").update(operationId).digest("hex"),
            ),
          });
          if (result.status !== "committed") {
            throw new Error(`full-envelope write burst ${index} did not commit`);
          }
          authorityGeneration = result.receipt.authorityToken.authorityGeneration;
          effectiveGeneration = result.receipt.authorityToken.effectiveGeneration;
        }

        const loadFanout = async (): Promise<number[]> =>
          Promise.all(
            Array.from({ length: STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes }, async () => {
              const startedAt = performance.now();
              const snapshot = await fixture.store.loadSnapshot();
              if (
                snapshot.normalizedRows !== STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows ||
                snapshot.encodedBytes !== STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes
              ) {
                throw new Error("full-envelope snapshot changed during measurement");
              }
              return performance.now() - startedAt;
            }),
          );
        for (let index = 0; index < STORAGE_BENCHMARK_ENVELOPE.warmupSamples; index += 1) {
          await loadFanout();
        }
        const runs: number[][] = [];
        for (
          let runIndex = 0;
          runIndex < STORAGE_BENCHMARK_ENVELOPE.independentRuns;
          runIndex += 1
        ) {
          const samples: number[] = [];
          for (
            let sampleIndex = 0;
            sampleIndex < STORAGE_BENCHMARK_ENVELOPE.measuredSamplesPerRun;
            sampleIndex += 1
          ) {
            samples.push(...(await loadFanout()));
          }
          runs.push(samples);
        }
        const p99Ms = runs.map((samples) => nearestRank(samples, 0.99));
        expect(
          p99Ms.every((value) => value <= STORAGE_BENCHMARK_ENVELOPE.maxSnapshotLoadP99Ms),
        ).toBe(true);
        if (process.env.CAPLETS_BENCHMARK_REPORT === "1") {
          process.stdout.write(
            `${JSON.stringify({
              profile: "full-envelope",
              backend: "postgres",
              architecture: "generation-indexed-materialization",
              effectiveCaplets: STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets,
              normalizedRows: STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows,
              encodedBytes: STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes,
              writeBurstMutations:
                STORAGE_BENCHMARK_ENVELOPE.managementWritesPerSecond *
                STORAGE_BENCHMARK_ENVELOPE.writeBurstSeconds,
              refreshers: STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes,
              warmups: STORAGE_BENCHMARK_ENVELOPE.warmupSamples,
              measuredSamplesPerRun: STORAGE_BENCHMARK_ENVELOPE.measuredSamplesPerRun,
              independentRuns: STORAGE_BENCHMARK_ENVELOPE.independentRuns,
              percentile: 0.99,
              percentileMethod: "nearest-rank",
              notificationMode: "suppressed",
              p99Ms,
              maxP99Ms: STORAGE_BENCHMARK_ENVELOPE.maxSnapshotLoadP99Ms,
              passed: true,
            })}\n`,
          );
        }
      } finally {
        await fixture.close();
      }
    },
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

async function openPostgresRepository(adminUrl: string): Promise<
  Readonly<{
    store: ControlPlaneStore;
    dialect: PostgresControlPlaneDialect;
    close(): Promise<void>;
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
      GRANT SELECT, INSERT, UPDATE, DELETE ON caplets.cp_retention
        TO ${quoteSafeSqlIdentifier(maintenanceRole)};
    `);
    const openDialect = dialect;
    return {
      dialect: openDialect,
      store: createControlPlaneRepository({ identity, dialect: openDialect }),
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
