import { createHash, randomBytes } from "node:crypto";
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openSqliteControlPlaneDialect,
  type SqliteControlPlaneDialect,
} from "../src/control-plane/dialect/sqlite";
import type { MigrationEnvironment } from "../src/control-plane/dialect/migrations";
import {
  bootstrapSqliteFileV1,
  loadFileV1KeyProvider,
} from "../src/control-plane/key-provider/file-v1";
import {
  FILE_V1_PURPOSE_SPECS,
  fileV1CompatibilityManifestCommitment,
  type FileV1CompatibilityKey,
} from "../src/control-plane/key-provider/manifest";
import {
  createControlPlaneKeyRotationManager,
  type ControlPlaneKeyRotationManager,
} from "../src/control-plane/security/key-rotation";
import {
  createControlPlaneMaintenanceCoordinator,
  type ActivatedControlPlane,
} from "../src/control-plane/service";
import { createControlPlaneSecurityRepository } from "../src/control-plane/security/repository";
import { createControlPlaneRepository } from "../src/control-plane/caplets/repository";
import { encodeCanonicalJson } from "../src/control-plane/schema/model-codec";
import type { ResolvedSqliteStorage } from "../src/control-plane/storage-config";
import type {
  ControlPlaneDatabaseRow,
  ControlPlaneFilter,
  ControlPlaneOrder,
  ControlPlaneSqlTransaction,
  ControlPlaneTable,
  ControlPlaneTransactionalDialect,
} from "../src/control-plane/store";
import type {
  ControlPlaneStoreIdentity,
  ControlPlaneWriterFence,
  HostSettingManagementMutation,
} from "../src/control-plane/types";
import type { CurrentHostOperationBinding } from "../src/current-host/operations";

const TEST_NOW = "2026-07-15T00:00:00.000Z";
const identity: ControlPlaneStoreIdentity = {
  logicalHostId: "host_01J00000000000000000000000",
  storeId: "store_01J00000000000000000000000",
  operationNamespace: "namespace_01J00000000000000000000",
};
const migrationEnvironment: MigrationEnvironment = {
  binaryVersion: "0.34.1",
  supportedSchemaVersion: 1,
  keyVersion: 1,
  manifestVersion: 1,
  verifiedSchemaAwareBackup: true,
  oldNodesDrained: true,
  retainedKeyVersions: [1],
  hostAdministrator: true,
  now: new Date(TEST_NOW),
};
const assetRoot = resolve(import.meta.dirname, "..", "drizzle");
const roots: string[] = [];
const dialects: SqliteControlPlaneDialect[] = [];

afterEach(async () => {
  await Promise.all(dialects.splice(0).map((dialect) => dialect.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "caplets-u6-rotation-"));
  roots.push(parent);
  const root = join(parent, "state");
  const bootstrap = await bootstrapSqliteFileV1({
    root,
    logicalHostId: identity.logicalHostId,
    storeId: identity.storeId,
  });
  const storage: ResolvedSqliteStorage = {
    backend: "sqlite",
    ...identity,
    stateRoot: root,
    databasePath: join(root, "control-plane.sqlite3"),
    keyProviderManifest: bootstrap.profileManifestPaths.online,
    artifacts: { kind: "filesystem", root: join(root, "artifacts") },
  };
  const dialect = await openSqliteControlPlaneDialect({
    storage,
    environment: migrationEnvironment,
    assetRoot,
  });
  dialects.push(dialect);
  dialect.migrate();
  await createControlPlaneRepository({ identity, dialect }).initialize();
  const provider = await loadFileV1KeyProvider({
    manifestPath: bootstrap.profileManifestPaths.online,
    expectedLogicalHostId: identity.logicalHostId,
    expectedStoreId: identity.storeId,
    expectedProfile: "online",
  });
  return {
    parent,
    root,
    storage,
    dialect,
    provider,
    onlineManifestPath: bootstrap.profileManifestPaths.online,
    manager: createControlPlaneKeyRotationManager({ identity, dialect }),
  };
}

type MutableManifestEntry = {
  keyId: string;
  keyVersion: number;
  purpose: string;
  file: string;
  operations: string[];
};
type MutableManifest = {
  entries: MutableManifestEntry[];
  compatibilityKeys: FileV1CompatibilityKey[];
  compatibilityCommitment: string;
};

function keyCommitment(entry: MutableManifestEntry, material: Buffer): string {
  const operations =
    FILE_V1_PURPOSE_SPECS[entry.purpose as keyof typeof FILE_V1_PURPOSE_SPECS].operations;
  return createHash("sha256")
    .update(
      JSON.stringify([
        entry.keyId,
        entry.keyVersion,
        entry.purpose,
        operations,
        material.byteLength,
      ]),
    )
    .update("\0")
    .update(material)
    .digest("hex");
}

async function createNextVersionProvider(manifestPath: string, currentVersion: number) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MutableManifest;
  const previous = manifest.entries.find(
    (entry) => entry.purpose === "vault-record" && entry.keyVersion === currentVersion,
  );
  const previousCompatibility = manifest.compatibilityKeys.find(
    (entry) => entry.purpose === "vault-record" && entry.keyVersion === currentVersion,
  );
  if (!previous || !previousCompatibility) {
    throw new Error(`vault-record v${currentVersion} is missing`);
  }
  previous.operations = previous.operations.filter((operation) => operation === "decrypt");
  const nextVersion = currentVersion + 1;
  const material = randomBytes(32);
  const next: MutableManifestEntry = {
    ...previous,
    keyId: `${previous.keyId.slice(0, -2)}${String(nextVersion).padStart(2, "0")}`,
    keyVersion: nextVersion,
    file: `keys/vault-record-v${nextVersion}.key`,
    operations: ["encrypt", "decrypt"],
  };
  const nextCompatibility: FileV1CompatibilityKey = {
    ...previousCompatibility,
    keyId: next.keyId,
    keyVersion: next.keyVersion,
    commitment: keyCommitment(next, material),
  };
  manifest.entries.push(next);
  manifest.compatibilityKeys.push(nextCompatibility);
  manifest.compatibilityCommitment = fileV1CompatibilityManifestCommitment(
    manifest.compatibilityKeys,
  );
  const keyPath = resolve(dirname(manifestPath), next.file);
  await writeFile(keyPath, material, { mode: 0o600 });
  await chmod(keyPath, 0o600);
  const nextManifestPath = join(dirname(manifestPath), `online-v${nextVersion}.json`);
  await writeFile(nextManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(nextManifestPath, 0o600);
  return {
    material,
    manifestPath: nextManifestPath,
    provider: await loadFileV1KeyProvider({
      manifestPath: nextManifestPath,
      expectedLogicalHostId: identity.logicalHostId,
      expectedStoreId: identity.storeId,
      expectedProfile: "online",
    }),
  };
}

async function createVersionTwoProvider(manifestPath: string) {
  return createNextVersionProvider(manifestPath, 1);
}

async function createDivergentProvider(root: string, manifestPath: string, keyVersion = 1) {
  const divergentRoot = join(dirname(root), "divergent");
  await cp(root, divergentRoot, { recursive: true });
  const divergentManifestPath = join(divergentRoot, relative(root, manifestPath));
  const manifest = JSON.parse(await readFile(divergentManifestPath, "utf8")) as MutableManifest;
  const entry = manifest.entries.find(
    (candidate) => candidate.purpose === "vault-record" && candidate.keyVersion === keyVersion,
  );
  const compatibility = manifest.compatibilityKeys.find(
    (candidate) => candidate.purpose === "vault-record" && candidate.keyVersion === keyVersion,
  );
  if (!entry || !compatibility) throw new Error("divergent vault-record key is missing");
  const material = randomBytes(32);
  await writeFile(resolve(dirname(divergentManifestPath), entry.file), material, { mode: 0o600 });
  compatibility.commitment = keyCommitment(entry, material);
  manifest.compatibilityCommitment = fileV1CompatibilityManifestCommitment(
    manifest.compatibilityKeys,
  );
  await writeFile(divergentManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return loadFileV1KeyProvider({
    manifestPath: divergentManifestPath,
    expectedLogicalHostId: identity.logicalHostId,
    expectedStoreId: identity.storeId,
    expectedProfile: "online",
  });
}

async function recordCompletedDestruction(
  dialect: SqliteControlPlaneDialect,
  input: Readonly<{
    destructionId: string;
    kind: "bytes" | "key";
    id: string;
    phase?: "intended" | "completed";
  }>,
): Promise<void> {
  await dialect.runtimeTransaction(async (transaction) => {
    const now = await transaction.databaseTime();
    const phase = input.phase ?? "completed";
    const inventoryHash = createHash("sha256").update(`${input.kind}:${input.id}`).digest("hex");
    const confirmationId = `confirmation:${input.destructionId}`;
    await transaction.insert("confirmations", {
      modelVersion: 1,
      id: confirmationId,
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      createdAt: now,
      updatedAt: now,
      aggregateVersion: 0,
      authorityVersion: 0,
      effectiveVersion: 0,
      securityVersion: 0,
      confirmationId,
      action: "external-destruction",
      authorityToken: "authority-u6",
      inventoryHash,
      affectedInventory: encodeCanonicalJson([`${input.kind}:${input.id}`]),
      expiresAt: "9999-12-31T23:59:59.999Z",
      consequences: "External material is permanently removed.",
      state: "consumed",
      consumedAt: now,
    });
    await transaction.insert("externalDestructions", {
      modelVersion: 1,
      id: `external-destruction:${input.destructionId}`,
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      createdAt: now,
      updatedAt: now,
      aggregateVersion: 0,
      authorityVersion: 0,
      effectiveVersion: 0,
      securityVersion: 0,
      destructionId: input.destructionId,
      providerIdentity: "file-v1-fixture",
      phase,
      inventoryHash,
      confirmationId,
      intent: encodeCanonicalJson([{ kind: input.kind, id: input.id }]),
      receipt: phase === "completed" ? encodeCanonicalJson({ absent: true }) : null,
      completedAt: phase === "completed" ? now : null,
    });
  });
}

async function addTombstone(
  dialect: SqliteControlPlaneDialect,
  purpose: string,
  keyVersion: number,
): Promise<string> {
  const retentionId = `tombstone-${purpose}-${keyVersion}`;
  await dialect.runtimeTransaction(async (transaction) => {
    const now = await transaction.databaseTime();
    await transaction.insert("retentions", {
      modelVersion: 1,
      id: `retention:${retentionId}`,
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      createdAt: now,
      updatedAt: now,
      aggregateVersion: 0,
      authorityVersion: 0,
      effectiveVersion: 0,
      securityVersion: 0,
      retentionId,
      resourceKind: "key-tombstone",
      resourceId: `${purpose}:${keyVersion}`,
      policy: "rotation-proof",
      purgeWatermark: 0,
      retainUntil: "9999-12-31T23:59:59.999Z",
      destroyedAt: null,
    });
  });
  return retentionId;
}

async function preview(manager: ControlPlaneKeyRotationManager, minimumPurgeWatermark: number) {
  return manager.previewRetirement({
    purpose: "vault-record",
    keyVersion: 1,
    authorityToken: "0:0",
    minimumPurgeWatermark,
  });
}

describe("control-plane key rotation", () => {
  it("enforces canaries, overlap, re-encryption, retention, watermarks, and receipted destruction", async () => {
    const test = await fixture();
    const divergent = await createDivergentProvider(test.root, test.onlineManifestPath);
    const v1 = await test.manager.registerActiveVersion({
      provider: test.provider,
      purpose: "vault-record",
    });
    expect(v1).toMatchObject({ keyVersion: 1, state: "active", provider: "file-v1" });
    await expect(
      test.manager.verifyNodeCanary({
        nodeId: "node-divergent",
        purpose: "vault-record",
        keyVersion: 1,
        provider: divergent,
      }),
    ).resolves.toEqual({
      verified: false,
      readiness: "denied",
      writerLease: "revoked",
    });

    await expect(
      test.manager.activationStatus({
        purpose: "vault-record",
        keyVersion: 1,
        requiredNodeIds: ["node-divergent"],
      }),
    ).resolves.toEqual({
      ready: false,
      missingNodeIds: ["node-divergent"],
      clusterActivation: "active",
    });

    const securityV1 = createControlPlaneSecurityRepository({
      identity,
      dialect: test.dialect,
      keyProvider: test.provider,
    });
    await securityV1.setWithGrant({ key: "ROTATION_SECRET", value: "u6-rotation-sentinel" });
    const versionTwo = await createVersionTwoProvider(test.onlineManifestPath);
    await expect(
      test.manager.registerActiveVersion({
        provider: versionTwo.provider,
        purpose: "vault-record",
      }),
    ).resolves.toMatchObject({ keyVersion: 2, state: "active" });
    const splitVersionProvider = await createDivergentProvider(
      test.root,
      join(dirname(test.onlineManifestPath), "online-v2.json"),
    );
    await expect(
      test.manager.registerActiveVersion({
        provider: splitVersionProvider,
        purpose: "vault-record",
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(
      test.manager.verifyNodeCanary({
        nodeId: "node-a",
        purpose: "vault-record",
        keyVersion: 2,
        provider: versionTwo.provider,
      }),
    ).resolves.toMatchObject({ verified: true, writerLease: "active" });
    await expect(
      test.manager.activationStatus({
        purpose: "vault-record",
        keyVersion: 2,
        requiredNodeIds: ["node-a", "node-b"],
      }),
    ).resolves.toMatchObject({ ready: false, missingNodeIds: ["node-b"] });
    await test.manager.verifyNodeCanary({
      nodeId: "node-b",
      purpose: "vault-record",
      keyVersion: 2,
      provider: versionTwo.provider,
    });
    await expect(
      test.manager.activationStatus({
        purpose: "vault-record",
        keyVersion: 2,
        requiredNodeIds: ["node-a", "node-b"],
      }),
    ).resolves.toEqual({
      ready: true,
      missingNodeIds: [],
      clusterActivation: "active",
    });
    const divergentVersionTwo = await createDivergentProvider(
      test.root,
      join(dirname(test.onlineManifestPath), "online-v2.json"),
      2,
    );
    await expect(
      test.manager.verifyNodeCanary({
        nodeId: "node-a",
        purpose: "vault-record",
        keyVersion: 2,
        provider: divergentVersionTwo,
      }),
    ).resolves.toMatchObject({ verified: false, readiness: "denied" });
    await expect(
      test.manager.activationStatus({
        purpose: "vault-record",
        keyVersion: 2,
        requiredNodeIds: ["node-a", "node-b"],
      }),
    ).resolves.toMatchObject({ ready: false, missingNodeIds: ["node-a"] });
    await test.manager.verifyNodeCanary({
      nodeId: "node-a",
      purpose: "vault-record",
      keyVersion: 2,
      provider: versionTwo.provider,
    });

    await expect(
      test.manager.retireVersion({
        preview: await preview(test.manager, 5),
        authorityToken: "0:0",
      }),
    ).resolves.toMatchObject({ status: "refused", reason: "watermark" });
    await expect(
      test.manager.advancePurgeWatermark({ purpose: "vault-record", keyVersion: 1, watermark: 5 }),
    ).resolves.toBe(5);
    await expect(
      test.manager.advancePurgeWatermark({ purpose: "vault-record", keyVersion: 1, watermark: 4 }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(
      test.manager.retireVersion({
        preview: await preview(test.manager, 5),
        authorityToken: "0:0",
      }),
    ).resolves.toMatchObject({ status: "refused", reason: "live-records" });

    const securityV2 = createControlPlaneSecurityRepository({
      identity,
      dialect: test.dialect,
      keyProvider: versionTwo.provider,
    });
    await expect(securityV2.reencryptVaultValues()).resolves.toBe(1);
    await expect(securityV2.revealValue("ROTATION_SECRET")).resolves.toBe("u6-rotation-sentinel");
    expect(test.dialect.query("SELECT id FROM cp_vault_value WHERE key_version = ?", [1])).toEqual(
      [],
    );

    await test.manager.recordRetainedBackup({
      backupId: "backup-u6",
      providerIdentity: "file-v1-fixture",
      sourceIdentity: "source-u6",
      sourceProfile: "offline-recovery",
      manifestHash: createHash("sha256").update("backup-u6").digest("hex"),
      purpose: "vault-record",
      algorithm: "AES-256-GCM",
      keyVersion: 1,
      unwrapIdentity: "recovery-u6",
      retentionUntil: "9999-12-31T23:59:59.999Z",
    });
    await expect(
      test.manager.retireVersion({
        preview: await preview(test.manager, 5),
        authorityToken: "0:0",
      }),
    ).resolves.toMatchObject({ status: "refused", reason: "retained-backups" });
    await recordCompletedDestruction(test.dialect, {
      destructionId: "destroy-backup-u6",
      kind: "bytes",
      id: "backup-u6",
    });
    await test.manager.recordBackupDestruction({
      backupId: "backup-u6",
      destructionId: "destroy-backup-u6",
    });

    const tombstoneId = await addTombstone(test.dialect, "vault-record", 1);
    await expect(
      test.manager.retireVersion({
        preview: await preview(test.manager, 5),
        authorityToken: "0:0",
      }),
    ).resolves.toMatchObject({ status: "refused", reason: "tombstones" });
    await test.dialect.runtimeTransaction(async (transaction) => {
      await transaction.update(
        "retentions",
        { destroyedAt: await transaction.databaseTime() },
        { equals: { logicalHostId: identity.logicalHostId, retentionId: tombstoneId } },
      );
    });
    const [protectedValue] = test.dialect.query<{ authTag: Buffer }>(
      "SELECT auth_tag AS authTag FROM cp_vault_value WHERE reference_name = ?",
      ["ROTATION_SECRET"],
    );
    if (!protectedValue) throw new Error("rotated Vault value is missing");
    test.dialect.execute("UPDATE cp_vault_value SET auth_tag = ? WHERE reference_name = ?", [
      Buffer.alloc(16),
      "ROTATION_SECRET",
    ]);
    await expect(
      test.manager.retireVersion({
        preview: await preview(test.manager, 5),
        authorityToken: "0:0",
      }),
    ).resolves.toMatchObject({ status: "refused", reason: "undecryptable-records" });
    test.dialect.execute("UPDATE cp_vault_value SET auth_tag = ? WHERE reference_name = ?", [
      protectedValue.authTag,
      "ROTATION_SECRET",
    ]);
    const finalPreview = await preview(test.manager, 5);
    expect(
      test.dialect.query<{ authorityToken: string; state: string }>(
        "SELECT authority_token AS authorityToken, state FROM cp_confirmation WHERE confirmation_id = ?",
        [finalPreview.previewId],
      ),
    ).toEqual([
      {
        authorityToken: createHash("sha256")
          .update("caplets/key-retirement-authority/v1")
          .update("\0")
          .update(identity.logicalHostId)
          .update("\0")
          .update(identity.storeId)
          .update("\0")
          .update("0:0")
          .digest("hex"),
        state: "previewed",
      },
    ]);
    await expect(
      test.manager.retireVersion({ preview: finalPreview, authorityToken: "0:0" }),
    ).resolves.toMatchObject({ status: "retired", inventory: { state: "retired" } });
    await expect(
      test.manager.retireVersion({ preview: finalPreview, authorityToken: "0:0" }),
    ).resolves.toMatchObject({ status: "refused", reason: "stale-preview" });

    await recordCompletedDestruction(test.dialect, {
      destructionId: "destroy-key-u6",
      kind: "key",
      id: v1.keyId,
      phase: "intended",
    });
    await expect(
      test.manager.markDestructionIntended({
        purpose: "vault-record",
        keyVersion: 1,
        destructionId: "destroy-key-u6",
      }),
    ).resolves.toMatchObject({ state: "destruction-intended" });
    await expect(
      test.manager.markDestroyed({
        purpose: "vault-record",
        keyVersion: 1,
        destructionId: "destroy-key-u6",
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await test.dialect.runtimeTransaction(async (transaction) => {
      const now = await transaction.databaseTime();
      await transaction.update(
        "externalDestructions",
        {
          phase: "completed",
          receipt: encodeCanonicalJson({ absent: true }),
          completedAt: now,
          updatedAt: now,
        },
        { equals: { logicalHostId: identity.logicalHostId, destructionId: "destroy-key-u6" } },
      );
    });
    await expect(
      test.manager.markDestroyed({
        purpose: "vault-record",
        keyVersion: 1,
        destructionId: "destroy-key-u6",
      }),
    ).resolves.toMatchObject({ state: "destroyed", destructionId: "destroy-key-u6" });

    const files = await Promise.all(
      [test.storage.databasePath, `${test.storage.databasePath}-wal`].map((path) =>
        readFile(path).catch(() => Buffer.alloc(0)),
      ),
    );
    expect(Buffer.concat(files).includes(versionTwo.material)).toBe(false);
    expect(JSON.stringify(await test.manager.listInventory())).not.toContain(
      "u6-rotation-sentinel",
    );
  });

  it("rechecks the full live ready-node cohort inside staged Postgres key activation", async () => {
    const test = await fixture();
    const fingerprint = "a".repeat(64);
    const store = createControlPlaneRepository({ identity, dialect: test.dialect });
    await store.stageNextFingerprint(fingerprint);
    const token = await store.convergenceToken();
    const register = async (nodeId: string) => {
      const registration = await store.registerNode({
        nodeId,
        bootstrapFingerprint: fingerprint,
        effectiveRuntimeFingerprint: fingerprint,
        appliedToken: token,
        compatibility: test.dialect.compatibility,
        ttlMs: 5_000,
      });
      if (registration.status === "ready") {
        await store.acknowledgeNode({
          nodeId,
          bootstrapFingerprint: fingerprint,
          effectiveRuntimeFingerprint: fingerprint,
          appliedToken: token,
          writerFence: registration.writerFence,
        });
      }
      return registration;
    };
    const nodeA = await register("node-a");
    if (nodeA.status !== "ready") throw new Error(`node-a was ${nodeA.status}`);
    const postgresDialect = new Proxy(test.dialect, {
      get(target, property, receiver) {
        return property === "backend" ? "postgres" : Reflect.get(target, property, receiver);
      },
    });
    const manager = createControlPlaneKeyRotationManager({ identity, dialect: postgresDialect });
    await manager.registerActiveVersion({ provider: test.provider, purpose: "vault-record" });
    const versionTwo = await createVersionTwoProvider(test.onlineManifestPath);
    await expect(
      manager.registerActiveVersion({ provider: versionTwo.provider, purpose: "vault-record" }),
    ).resolves.toMatchObject({ state: "staged", keyVersion: 2 });
    expect(
      versionTwo.provider.encrypt("vault-record", Buffer.from("staged"), randomBytes(12))
        .keyVersion,
    ).toBe(2);
    const sqlActiveProvider = versionTwo.provider.withActiveVersions({ "vault-record": 1 });
    expect(
      sqlActiveProvider.encrypt("vault-record", Buffer.from("active"), randomBytes(12)).keyVersion,
    ).toBe(1);
    await expect(
      manager.verifyNodeCanary({
        nodeId: "node-a",
        purpose: "vault-record",
        keyVersion: 2,
        provider: versionTwo.provider,
        writerFence: nodeA.writerFence,
      }),
    ).resolves.toMatchObject({ verified: true });

    let readyScans = 0;
    const activationLocks: string[] = [];
    const racingDialect = new Proxy(postgresDialect, {
      get(target, property, receiver) {
        if (property !== "runtimeTransaction") return Reflect.get(target, property, receiver);
        return async (work: Parameters<typeof target.runtimeTransaction>[0]) =>
          target.runtimeTransaction((transaction) =>
            work({
              ...transaction,
              async lock(serialKey) {
                activationLocks.push(serialKey);
                await transaction.lock(serialKey);
              },
              async select<Row extends ControlPlaneDatabaseRow>(
                table: ControlPlaneTable,
                filter?: ControlPlaneFilter,
                order?: readonly ControlPlaneOrder[],
                limit?: number,
              ): Promise<readonly Row[]> {
                const rows = await transaction.select<Row>(table, filter, order, limit);
                if (
                  table !== "clusterNodeLeases" ||
                  filter?.equals?.state !== "ready" ||
                  filter.equals.nodeId !== undefined ||
                  ++readyScans < 2 ||
                  !rows[0]
                ) {
                  return rows;
                }
                return [
                  ...rows,
                  {
                    ...rows[0],
                    id: "node:node-admitted-during-activation",
                    nodeId: "node-admitted-during-activation",
                  } as Row,
                ];
              },
            }),
          );
      },
    });
    const racingManager = createControlPlaneKeyRotationManager({
      identity,
      dialect: racingDialect,
    });
    await expect(
      racingManager.activateVersion({
        purpose: "vault-record",
        keyVersion: 2,
        securityEpoch: 0,
        writerFence: nodeA.writerFence,
      }),
    ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
    expect(readyScans).toBeGreaterThanOrEqual(2);
    expect(activationLocks).toContain(
      `node-admission:${identity.logicalHostId}:${identity.storeId}`,
    );
    await expect(
      manager.activationStatus({ purpose: "vault-record", keyVersion: 2 }),
    ).resolves.toMatchObject({ clusterActivation: "pending" });

    const nodeB = await register("node-b");
    if (nodeB.status !== "ready") throw new Error(`node-b was ${nodeB.status}`);
    await expect(
      manager.activateVersion({
        purpose: "vault-record",
        keyVersion: 2,
        securityEpoch: 0,
        writerFence: nodeA.writerFence,
      }),
    ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
    await manager.verifyNodeCanary({
      nodeId: "node-b",
      purpose: "vault-record",
      keyVersion: 2,
      provider: versionTwo.provider,
      writerFence: nodeB.writerFence,
    });
    await expect(
      manager.activateVersion({
        purpose: "vault-record",
        keyVersion: 2,
        securityEpoch: 0,
        writerFence: nodeB.writerFence,
      }),
    ).resolves.toMatchObject({ state: "active", keyVersion: 2 });
  });

  it("rejects a same-node canary proof after its writer lease restarts", async () => {
    const test = await fixture();
    const fingerprint = "b".repeat(64);
    const store = createControlPlaneRepository({ identity, dialect: test.dialect });
    await store.stageNextFingerprint(fingerprint);
    const token = await store.convergenceToken();
    const register = () =>
      store.registerNode({
        nodeId: "node-restarted",
        bootstrapFingerprint: fingerprint,
        effectiveRuntimeFingerprint: fingerprint,
        appliedToken: token,
        compatibility: test.dialect.compatibility,
        ttlMs: 60_000,
      });
    const firstRegistration = await register();
    if (firstRegistration.status !== "ready") {
      throw new Error(`first node registration was ${firstRegistration.status}`);
    }
    await store.acknowledgeNode({
      nodeId: "node-restarted",
      bootstrapFingerprint: fingerprint,
      effectiveRuntimeFingerprint: fingerprint,
      appliedToken: token,
      writerFence: firstRegistration.writerFence,
    });
    const postgresDialect = new Proxy(test.dialect, {
      get(target, property, receiver) {
        return property === "backend" ? "postgres" : Reflect.get(target, property, receiver);
      },
    });
    const manager = createControlPlaneKeyRotationManager({ identity, dialect: postgresDialect });
    await manager.registerActiveVersion({ provider: test.provider, purpose: "vault-record" });
    const versionTwo = await createVersionTwoProvider(test.onlineManifestPath);
    await manager.registerActiveVersion({ provider: versionTwo.provider, purpose: "vault-record" });
    await manager.verifyNodeCanary({
      nodeId: "node-restarted",
      purpose: "vault-record",
      keyVersion: 2,
      provider: versionTwo.provider,
      writerFence: firstRegistration.writerFence,
    });

    await store.revokeNode("node-restarted");
    const restarted = await register();
    if (restarted.status !== "ready") {
      throw new Error(`restarted node registration was ${restarted.status}`);
    }
    await store.acknowledgeNode({
      nodeId: "node-restarted",
      bootstrapFingerprint: fingerprint,
      effectiveRuntimeFingerprint: fingerprint,
      appliedToken: token,
      writerFence: restarted.writerFence,
    });
    expect(restarted.writerFence.writerEpoch).toBeGreaterThan(
      firstRegistration.writerFence.writerEpoch,
    );
    await expect(
      manager.activationStatus({ purpose: "vault-record", keyVersion: 2 }),
    ).resolves.toMatchObject({ ready: false, missingNodeIds: ["node-restarted"] });
    await expect(
      manager.activateVersion({
        purpose: "vault-record",
        keyVersion: 2,
        securityEpoch: 0,
        writerFence: restarted.writerFence,
      }),
    ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });

    await manager.verifyNodeCanary({
      nodeId: "node-restarted",
      purpose: "vault-record",
      keyVersion: 2,
      provider: versionTwo.provider,
      writerFence: restarted.writerFence,
    });
    await expect(
      manager.activateVersion({
        purpose: "vault-record",
        keyVersion: 2,
        securityEpoch: 0,
        writerFence: restarted.writerFence,
      }),
    ).resolves.toMatchObject({ state: "active" });
  });

  it("requires a fresh canary proof before an expired same-token lease epoch becomes ready", async () => {
    const test = await fixture();
    const postgresDialect = new Proxy(test.dialect, {
      get(target, property, receiver) {
        return property === "backend" ? "postgres" : Reflect.get(target, property, receiver);
      },
    });
    const store = createControlPlaneRepository({ identity, dialect: postgresDialect });
    const manager = createControlPlaneKeyRotationManager({ identity, dialect: postgresDialect });
    const fingerprint = "e".repeat(64);
    await store.initializeActivationFingerprint(fingerprint);
    await manager.registerActiveVersion({ provider: test.provider, purpose: "vault-record" });
    const token = await store.convergenceToken();
    const compatibility = {
      ...test.dialect.compatibility,
      providerCommitment: "1".repeat(64),
      keyCanaryCommitment: "2".repeat(64),
      capabilities: ["ordered-tuple-polling", "writer-fence-v1", "complete-snapshot-v1"],
    } as const;
    const register = (ttlMs: number) =>
      store.registerNode({
        nodeId: "node-expired-epoch",
        bootstrapFingerprint: fingerprint,
        effectiveRuntimeFingerprint: fingerprint,
        appliedToken: token,
        compatibility,
        ttlMs,
      });

    const first = await register(60_000);
    if (first.status !== "ready") throw new Error(`first registration was ${first.status}`);
    await manager.verifyNodeCanary({
      nodeId: "node-expired-epoch",
      purpose: "vault-record",
      keyVersion: 1,
      provider: test.provider,
      writerFence: first.writerFence,
    });
    await expect(
      store.acknowledgeNode({
        nodeId: "node-expired-epoch",
        bootstrapFingerprint: fingerprint,
        effectiveRuntimeFingerprint: fingerprint,
        appliedToken: token,
        writerFence: first.writerFence,
      }),
    ).resolves.toMatchObject({ status: "applied" });

    const expiredAt = new Date(0).toISOString();
    test.dialect.execute("UPDATE cp_cluster_node_lease SET expires_at = ? WHERE node_id = ?", [
      expiredAt,
      "node-expired-epoch",
    ]);
    test.dialect.execute("UPDATE cp_writer_fence SET expires_at = ? WHERE lease_id = ?", [
      expiredAt,
      first.writerFence.leaseId,
    ]);
    const second = await register(60_000);
    if (second.status !== "ready") throw new Error(`second registration was ${second.status}`);
    expect(second.writerFence.writerEpoch).toBe(first.writerFence.writerEpoch + 1);
    await expect(
      store.acknowledgeNode({
        nodeId: "node-expired-epoch",
        bootstrapFingerprint: fingerprint,
        effectiveRuntimeFingerprint: fingerprint,
        appliedToken: token,
        writerFence: second.writerFence,
      }),
    ).resolves.toEqual({ status: "rejected", reason: "lease-revoked" });
    expect(
      test.dialect.query<{ state: string }>(
        "SELECT state FROM cp_cluster_node_lease WHERE node_id = ?",
        ["node-expired-epoch"],
      ),
    ).toEqual([{ state: "catching-up" }]);

    await manager.verifyNodeCanary({
      nodeId: "node-expired-epoch",
      purpose: "vault-record",
      keyVersion: 1,
      provider: test.provider,
      writerFence: second.writerFence,
    });
    await expect(
      store.acknowledgeNode({
        nodeId: "node-expired-epoch",
        bootstrapFingerprint: fingerprint,
        effectiveRuntimeFingerprint: fingerprint,
        appliedToken: token,
        writerFence: second.writerFence,
      }),
    ).resolves.toMatchObject({ status: "applied" });

    const divergent = await createDivergentProvider(test.root, test.onlineManifestPath, 1);
    await expect(
      manager.verifyNodeCanary({
        nodeId: "node-expired-epoch",
        purpose: "vault-record",
        keyVersion: 1,
        provider: divergent,
        writerFence: first.writerFence,
      }),
    ).resolves.toMatchObject({ verified: false, writerLease: "revoked" });
    expect(
      test.dialect.query<{ state: string }>(
        "SELECT state FROM cp_cluster_node_lease WHERE node_id = ?",
        ["node-expired-epoch"],
      ),
    ).toEqual([{ state: "ready" }]);
    expect(
      test.dialect.query<{ state: string; writer_epoch: number }>(
        "SELECT state, writer_epoch FROM cp_writer_fence WHERE lease_id = ?",
        [second.writerFence.leaseId],
      ),
    ).toEqual([{ state: "active", writer_epoch: second.writerFence.writerEpoch }]);
  });

  it("persistently revokes the node and writer fence when its canary fails", async () => {
    const test = await fixture();
    const fingerprint = "c".repeat(64);
    const store = createControlPlaneRepository({ identity, dialect: test.dialect });
    await store.stageNextFingerprint(fingerprint);
    const token = await store.convergenceToken();
    const registration = await store.registerNode({
      nodeId: "node-bad-canary",
      bootstrapFingerprint: fingerprint,
      effectiveRuntimeFingerprint: fingerprint,
      appliedToken: token,
      compatibility: test.dialect.compatibility,
      ttlMs: 60_000,
    });
    if (registration.status !== "ready") {
      throw new Error(`bad-canary node registration was ${registration.status}`);
    }
    await store.acknowledgeNode({
      nodeId: "node-bad-canary",
      bootstrapFingerprint: fingerprint,
      effectiveRuntimeFingerprint: fingerprint,
      appliedToken: token,
      writerFence: registration.writerFence,
    });
    const postgresDialect = new Proxy(test.dialect, {
      get(target, property, receiver) {
        return property === "backend" ? "postgres" : Reflect.get(target, property, receiver);
      },
    });
    const manager = createControlPlaneKeyRotationManager({ identity, dialect: postgresDialect });
    await manager.registerActiveVersion({ provider: test.provider, purpose: "vault-record" });
    const versionTwo = await createVersionTwoProvider(test.onlineManifestPath);
    await manager.registerActiveVersion({ provider: versionTwo.provider, purpose: "vault-record" });
    const divergent = await createDivergentProvider(test.root, versionTwo.manifestPath, 2);

    await expect(
      manager.verifyNodeCanary({
        nodeId: "node-bad-canary",
        purpose: "vault-record",
        keyVersion: 2,
        provider: divergent,
        writerFence: registration.writerFence,
      }),
    ).resolves.toEqual({
      verified: false,
      readiness: "denied",
      writerLease: "revoked",
    });
    expect(
      test.dialect.query<{ state: string }>(
        "SELECT state FROM cp_cluster_node_lease WHERE node_id = ?",
        ["node-bad-canary"],
      ),
    ).toEqual([{ state: "revoked" }]);
    expect(
      test.dialect.query<{ state: string }>(
        "SELECT state FROM cp_writer_fence WHERE lease_id = ?",
        [registration.writerFence.leaseId],
      ),
    ).toEqual([{ state: "revoked" }]);
    await expect(
      store.acknowledgeNode({
        nodeId: "node-bad-canary",
        bootstrapFingerprint: fingerprint,
        effectiveRuntimeFingerprint: fingerprint,
        appliedToken: token,
        writerFence: registration.writerFence,
      }),
    ).resolves.toEqual({ status: "rejected", reason: "lease-revoked" });
  });

  it("keeps decrypt-only canaries discoverable through a third overlapping rotation", async () => {
    const test = await fixture();
    const fingerprint = "d".repeat(64);
    const store = createControlPlaneRepository({ identity, dialect: test.dialect });
    await store.stageNextFingerprint(fingerprint);
    const token = await store.convergenceToken();
    const registration = await store.registerNode({
      nodeId: "node-three-rotations",
      bootstrapFingerprint: fingerprint,
      effectiveRuntimeFingerprint: fingerprint,
      appliedToken: token,
      compatibility: test.dialect.compatibility,
      ttlMs: 60_000,
    });
    if (registration.status !== "ready") {
      throw new Error(`three-rotation node registration was ${registration.status}`);
    }
    await store.acknowledgeNode({
      nodeId: "node-three-rotations",
      bootstrapFingerprint: fingerprint,
      effectiveRuntimeFingerprint: fingerprint,
      appliedToken: token,
      writerFence: registration.writerFence,
    });
    const postgresDialect = new Proxy(test.dialect, {
      get(target, property, receiver) {
        return property === "backend" ? "postgres" : Reflect.get(target, property, receiver);
      },
    });
    const manager = createControlPlaneKeyRotationManager({ identity, dialect: postgresDialect });
    await manager.registerActiveVersion({ provider: test.provider, purpose: "vault-record" });
    const versionTwo = await createVersionTwoProvider(test.onlineManifestPath);
    await manager.registerActiveVersion({ provider: versionTwo.provider, purpose: "vault-record" });
    await manager.verifyNodeCanary({
      nodeId: "node-three-rotations",
      purpose: "vault-record",
      keyVersion: 2,
      provider: versionTwo.provider,
      writerFence: registration.writerFence,
    });
    await manager.activateVersion({
      purpose: "vault-record",
      keyVersion: 2,
      securityEpoch: 0,
      writerFence: registration.writerFence,
    });

    const versionThree = await createNextVersionProvider(versionTwo.manifestPath, 2);
    await expect(
      manager.registerActiveVersion({ provider: versionThree.provider, purpose: "vault-record" }),
    ).resolves.toMatchObject({ state: "staged", keyVersion: 3 });
    await manager.verifyNodeCanary({
      nodeId: "node-three-rotations",
      purpose: "vault-record",
      keyVersion: 3,
      provider: versionThree.provider,
      writerFence: registration.writerFence,
    });
    await expect(
      manager.activateVersion({
        purpose: "vault-record",
        keyVersion: 3,
        securityEpoch: 1,
        writerFence: registration.writerFence,
      }),
    ).resolves.toMatchObject({ state: "active", keyVersion: 3 });
    await expect(manager.listInventory()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyVersion: 1, state: "decrypt-only" }),
        expect.objectContaining({ keyVersion: 2, state: "decrypt-only" }),
        expect.objectContaining({ keyVersion: 3, state: "active" }),
      ]),
    );
  });

  it("fences a concurrent old-security management mutation behind key activation", async () => {
    const test = await fixture();
    const fingerprint = "e".repeat(64);
    const store = createControlPlaneRepository({ identity, dialect: test.dialect });
    await store.stageNextFingerprint(fingerprint);
    const token = await store.convergenceToken();
    const registration = await store.registerNode({
      nodeId: "node-activation-fence",
      bootstrapFingerprint: fingerprint,
      effectiveRuntimeFingerprint: fingerprint,
      appliedToken: token,
      compatibility: test.dialect.compatibility,
      ttlMs: 60_000,
    });
    if (registration.status !== "ready") {
      throw new Error(`activation-fence node registration was ${registration.status}`);
    }
    const writerFence: ControlPlaneWriterFence = registration.writerFence;
    await store.acknowledgeNode({
      nodeId: "node-activation-fence",
      bootstrapFingerprint: fingerprint,
      effectiveRuntimeFingerprint: fingerprint,
      appliedToken: token,
      writerFence,
    });
    const securityLock = `security-epoch:${identity.logicalHostId}:${identity.storeId}`;
    const activationEnteredFence = Promise.withResolvers<void>();
    const releaseActivation = Promise.withResolvers<void>();
    const postgresDialect = new Proxy(test.dialect, {
      get(target, property, receiver) {
        if (property === "backend") return "postgres";
        if (property !== "runtimeTransaction") return Reflect.get(target, property, receiver);
        return <T>(work: (transaction: ControlPlaneSqlTransaction) => Promise<T>) =>
          target.runtimeTransaction((transaction) =>
            work(
              new Proxy(transaction, {
                get(transactionTarget, transactionProperty, transactionReceiver) {
                  if (transactionProperty !== "lock") {
                    return Reflect.get(transactionTarget, transactionProperty, transactionReceiver);
                  }
                  return async (key: string) => {
                    await transactionTarget.lock(key);
                    if (key !== securityLock) return;
                    activationEnteredFence.resolve();
                    await releaseActivation.promise;
                  };
                },
              }),
            ),
          );
      },
    }) as ControlPlaneTransactionalDialect;
    const manager = createControlPlaneKeyRotationManager({ identity, dialect: postgresDialect });
    await manager.registerActiveVersion({ provider: test.provider, purpose: "vault-record" });
    const versionTwo = await createVersionTwoProvider(test.onlineManifestPath);
    await manager.registerActiveVersion({ provider: versionTwo.provider, purpose: "vault-record" });
    await manager.verifyNodeCanary({
      nodeId: "node-activation-fence",
      purpose: "vault-record",
      keyVersion: 2,
      provider: versionTwo.provider,
      writerFence,
    });
    const binding = {
      operationId: "operation-activation-fence",
      target: "global",
      ...identity,
      actorId: "operator-activation-fence",
      requestIdentity: "request:operation-activation-fence",
      operationClass: "logical-state",
    } satisfies CurrentHostOperationBinding;
    const mutation = {
      binding,
      aggregateId: "native.daemon-url",
      expectedAggregateVersion: 0,
      expectedAuthorityGeneration: token.authorityGeneration,
      expectedSecurityEpoch: token.securityEpoch,
      writerFence,
      setting: {
        version: 1,
        key: "native.daemon-url",
        value: { source: "setup", url: "http://127.0.0.1:3100/" },
        updatedAt: TEST_NOW,
      },
      provenance: {
        id: "provenance:operation-activation-fence",
        sourceKind: "setup",
        source: { command: "setup" },
        contentHash: "f".repeat(64),
        installedAt: TEST_NOW,
      },
      activity: {
        id: "activity:operation-activation-fence",
        action: "host-setting.update",
        target: { type: "host-setting", id: "native.daemon-url" },
      },
    } satisfies HostSettingManagementMutation;
    await store.reserveOperation(binding, mutation.aggregateId);

    const activation = manager.activateVersion({
      purpose: "vault-record",
      keyVersion: 2,
      securityEpoch: 0,
      writerFence,
    });
    await activationEnteredFence.promise;
    const oldSecurityMutation = store.mutateHostSetting(mutation);
    releaseActivation.resolve();

    await expect(activation).resolves.toMatchObject({ state: "active", keyVersion: 2 });
    await expect(oldSecurityMutation).resolves.toEqual({
      status: "conflict",
      reason: "security-epoch",
    });
  });

  it("rolls back key activation when the final writer-fence check expires", async () => {
    const test = await fixture();
    const fingerprint = "9".repeat(64);
    const store = createControlPlaneRepository({ identity, dialect: test.dialect });
    await store.stageNextFingerprint(fingerprint);
    const token = await store.convergenceToken();
    const registration = await store.registerNode({
      nodeId: "node-final-fence",
      bootstrapFingerprint: fingerprint,
      effectiveRuntimeFingerprint: fingerprint,
      appliedToken: token,
      compatibility: test.dialect.compatibility,
      ttlMs: 60_000,
    });
    if (registration.status !== "ready") {
      throw new Error(`final-fence node registration was ${registration.status}`);
    }
    const writerFence = registration.writerFence;
    await store.acknowledgeNode({
      nodeId: "node-final-fence",
      bootstrapFingerprint: fingerprint,
      effectiveRuntimeFingerprint: fingerprint,
      appliedToken: token,
      writerFence,
    });
    let expireFinalGuard = false;
    const postgresDialect = new Proxy(test.dialect, {
      get(target, property, receiver) {
        if (property === "backend") return "postgres";
        if (property !== "runtimeTransaction") return Reflect.get(target, property, receiver);
        return <T>(work: (transaction: ControlPlaneSqlTransaction) => Promise<T>) =>
          target.runtimeTransaction((transaction) =>
            work(
              new Proxy(transaction, {
                get(transactionTarget, transactionProperty, transactionReceiver) {
                  if (transactionProperty === "advanceSnapshotEnvelope") {
                    return async (
                      input: Parameters<ControlPlaneSqlTransaction["advanceSnapshotEnvelope"]>[0],
                    ) => {
                      if (expireFinalGuard) {
                        await transactionTarget.update(
                          "writerFences",
                          { expiresAt: "2000-01-01T00:00:00.000Z" },
                          {
                            equals: {
                              logicalHostId: identity.logicalHostId,
                              storeId: identity.storeId,
                              leaseId: writerFence.leaseId,
                            },
                          },
                        );
                      }
                      return transactionTarget.advanceSnapshotEnvelope(input);
                    };
                  }
                  return Reflect.get(transactionTarget, transactionProperty, transactionReceiver);
                },
              }),
            ),
          );
      },
    }) as ControlPlaneTransactionalDialect;
    const manager = createControlPlaneKeyRotationManager({ identity, dialect: postgresDialect });
    await manager.registerActiveVersion({ provider: test.provider, purpose: "vault-record" });
    const versionTwo = await createVersionTwoProvider(test.onlineManifestPath);
    await manager.registerActiveVersion({ provider: versionTwo.provider, purpose: "vault-record" });
    await manager.verifyNodeCanary({
      nodeId: "node-final-fence",
      purpose: "vault-record",
      keyVersion: 2,
      provider: versionTwo.provider,
      writerFence,
    });

    expireFinalGuard = true;
    await expect(
      manager.activateVersion({
        purpose: "vault-record",
        keyVersion: 2,
        securityEpoch: 0,
        writerFence,
      }),
    ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
    await expect(manager.listInventory()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyVersion: 1, state: "active" }),
        expect.objectContaining({ keyVersion: 2, state: "staged" }),
      ]),
    );
    await expect(store.convergenceToken()).resolves.toEqual(token);
  });

  it("invalidates a persisted retirement confirmation when live authority advances", async () => {
    const test = await fixture();
    await test.manager.registerActiveVersion({ provider: test.provider, purpose: "vault-record" });
    const versionTwo = await createVersionTwoProvider(test.onlineManifestPath);
    await test.manager.registerActiveVersion({
      provider: versionTwo.provider,
      purpose: "vault-record",
    });
    const retirement = await preview(test.manager, 0);
    await test.dialect.runtimeTransaction(async (transaction) => {
      const now = await transaction.databaseTime();
      await transaction.insert("authorityVersions", {
        modelVersion: 1,
        id: "authority-version:1",
        logicalHostId: identity.logicalHostId,
        storeId: identity.storeId,
        createdAt: now,
        updatedAt: now,
        aggregateVersion: 1,
        authorityVersion: 1,
        effectiveVersion: 0,
        securityVersion: 0,
        generation: 1,
        bindingState: "active",
        authorityToken: "1:0",
        operationNamespace: identity.operationNamespace,
        transferId: null,
      });
    });
    await expect(
      test.manager.retireVersion({ preview: retirement, authorityToken: "0:0" }),
    ).resolves.toMatchObject({ status: "refused", reason: "stale-authority" });
    expect(
      test.dialect.query<{ state: string; consumedAt: string | null }>(
        "SELECT state, consumed_at AS consumedAt FROM cp_confirmation WHERE confirmation_id = ?",
        [retirement.previewId],
      ),
    ).toEqual([{ state: "invalidated", consumedAt: expect.any(String) }]);
    await expect(
      test.manager.retireVersion({ preview: retirement, authorityToken: "1:0" }),
    ).resolves.toMatchObject({ status: "refused", reason: "stale-preview" });
  });

  it("runs fingerprint and key maintenance through the production coordinator seam", async () => {
    const test = await fixture();
    const store = createControlPlaneRepository({ identity, dialect: test.dialect });
    const currentFingerprint = "a".repeat(64);
    const nextFingerprint = "b".repeat(64);
    await store.initializeActivationFingerprint(currentFingerprint);
    const token = await store.convergenceToken();
    const registration = await store.registerNode({
      nodeId: "maintenance-node",
      bootstrapFingerprint: currentFingerprint,
      effectiveRuntimeFingerprint: currentFingerprint,
      appliedToken: token,
      compatibility: test.dialect.compatibility,
      ttlMs: 60_000,
    });
    if (registration.status !== "ready") {
      throw new Error(`maintenance node registration was ${registration.status}`);
    }
    await store.acknowledgeNode({
      nodeId: "maintenance-node",
      bootstrapFingerprint: currentFingerprint,
      effectiveRuntimeFingerprint: currentFingerprint,
      appliedToken: token,
      writerFence: registration.writerFence,
    });
    let authorityGeneration = 0;
    let securityEpoch = 0;
    let provider = test.provider;
    const writerFence = registration.writerFence;
    const activated = {
      current: () => ({ authorityGeneration, securityEpoch }),
      requireLive: async () => ({ ...writerFence, authorityGeneration }),
      refresh: async () => {
        const snapshot = await store.loadSnapshot();
        authorityGeneration = snapshot.versions.authorityGeneration;
        securityEpoch = snapshot.versions.securityEpoch;
        return { authorityGeneration, securityEpoch };
      },
    } as unknown as ActivatedControlPlane;
    const security = createControlPlaneSecurityRepository({
      identity,
      dialect: test.dialect,
      keyProvider: test.provider,
    });
    const maintenance = createControlPlaneMaintenanceCoordinator({
      store,
      activated,
      keyRotation: test.manager,
      security,
      nodeId: "maintenance-node",
      loadKeyProvider: async () => provider,
      rememberKeyProvider(next) {
        provider = next;
      },
      activateKeyProvider(next) {
        provider = next;
        security.updateActiveKeyProvider(next);
      },
    });

    await expect(maintenance.stageKeyVersion("vault-record")).resolves.toMatchObject({
      keyVersion: 1,
      state: "active",
    });
    await security.setWithGrant({
      key: "MAINTENANCE_SECRET",
      value: "maintenance-sentinel",
    });
    const versionTwo = await createVersionTwoProvider(test.onlineManifestPath);
    provider = versionTwo.provider;
    await expect(maintenance.stageKeyVersion("vault-record")).resolves.toMatchObject({
      keyVersion: 2,
      state: "active",
    });
    await expect(maintenance.activateKeyVersion("vault-record", 2)).resolves.toMatchObject({
      keyVersion: 2,
      state: "active",
    });
    const divergent = await createDivergentProvider(test.root, versionTwo.manifestPath, 2);
    provider = divergent;
    await expect(maintenance.stageKeyVersion("vault-record")).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
    provider = versionTwo.provider;
    await expect(maintenance.reencryptVaultValues()).resolves.toBe(1);
    await expect(security.revealValue("MAINTENANCE_SECRET")).resolves.toBe("maintenance-sentinel");
    const retirement = await maintenance.rescanKeyRetirement({
      purpose: "vault-record",
      keyVersion: 1,
      authorityToken: "0:0",
      minimumPurgeWatermark: 0,
    });
    await expect(
      maintenance.retireKeyVersion({ preview: retirement, authorityToken: "0:0" }),
    ).resolves.toMatchObject({ status: "retired", inventory: { state: "retired" } });

    await expect(maintenance.rollCompatibleFingerprint(currentFingerprint)).resolves.toMatchObject({
      currentFingerprint,
    });
    await expect(maintenance.stageNextFingerprint(nextFingerprint)).resolves.toMatchObject({
      currentFingerprint,
      nextFingerprint,
    });
    await expect(maintenance.stageNextFingerprint("c".repeat(64))).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
    const aborted = await maintenance.abortNextFingerprint(nextFingerprint);
    expect(aborted).toMatchObject({ currentFingerprint });
    expect(aborted).not.toHaveProperty("nextFingerprint");
    await maintenance.stageNextFingerprint(nextFingerprint);
    await expect(maintenance.activateNextFingerprint(nextFingerprint)).resolves.toMatchObject({
      currentFingerprint: nextFingerprint,
    });
    await expect(
      store.acknowledgeNode({
        nodeId: "maintenance-node",
        bootstrapFingerprint: nextFingerprint,
        effectiveRuntimeFingerprint: nextFingerprint,
        appliedToken: await store.convergenceToken(),
        writerFence,
      }),
    ).resolves.toEqual({ status: "rejected", reason: "lease-revoked" });
    await expect(maintenance.reverseFingerprint(currentFingerprint)).resolves.toMatchObject({
      currentFingerprint,
    });
  });

  it("stages canaries and rolls back stale production key activation fences", async () => {
    const test = await fixture();
    const fingerprint = "d".repeat(64);
    const store = createControlPlaneRepository({ identity, dialect: test.dialect });
    await store.initializeActivationFingerprint(fingerprint);
    const token = await store.convergenceToken();
    const registration = await store.registerNode({
      nodeId: "maintenance-node",
      bootstrapFingerprint: fingerprint,
      effectiveRuntimeFingerprint: fingerprint,
      appliedToken: token,
      compatibility: test.dialect.compatibility,
      ttlMs: 60_000,
    });
    if (registration.status !== "ready") {
      throw new Error(`maintenance node registration was ${registration.status}`);
    }
    await store.acknowledgeNode({
      nodeId: "maintenance-node",
      bootstrapFingerprint: fingerprint,
      effectiveRuntimeFingerprint: fingerprint,
      appliedToken: token,
      writerFence: registration.writerFence,
    });
    const postgresDialect = new Proxy(test.dialect, {
      get(target, property, receiver) {
        if (property === "backend") return "postgres";
        if (property !== "runtimeTransaction") return Reflect.get(target, property, receiver);
        return <T>(work: (transaction: ControlPlaneSqlTransaction) => Promise<T>) =>
          target.runtimeTransaction((transaction) =>
            work(
              new Proxy(transaction, {
                get(transactionTarget, transactionProperty, transactionReceiver) {
                  if (transactionProperty === "backend") return "postgres";
                  return Reflect.get(transactionTarget, transactionProperty, transactionReceiver);
                },
              }),
            ),
          );
      },
    }) as ControlPlaneTransactionalDialect;
    const maintenanceStore = createControlPlaneRepository({ identity, dialect: postgresDialect });
    await maintenanceStore.initialize();
    const manager = createControlPlaneKeyRotationManager({
      identity,
      dialect: postgresDialect,
    });
    const security = createControlPlaneSecurityRepository({
      identity,
      dialect: test.dialect,
      keyProvider: test.provider,
    });
    let provider = test.provider;
    let authorityGeneration = 0;
    let securityEpoch = 0;
    let liveWriterFence = registration.writerFence;
    const activated = {
      current: () => ({ authorityGeneration, securityEpoch }),
      requireLive: async () => liveWriterFence,
      refresh: async () => {
        const snapshot = await store.loadSnapshot();
        authorityGeneration = snapshot.versions.authorityGeneration;
        securityEpoch = snapshot.versions.securityEpoch;
        return { authorityGeneration, securityEpoch };
      },
    } as unknown as ActivatedControlPlane;
    const maintenance = createControlPlaneMaintenanceCoordinator({
      store: maintenanceStore,
      activated,
      keyRotation: manager,
      security,
      nodeId: "maintenance-node",
      loadKeyProvider: async () => provider,
      rememberKeyProvider(next) {
        provider = next;
      },
      activateKeyProvider(next) {
        provider = next;
        security.updateActiveKeyProvider(next);
      },
    });

    await maintenance.stageKeyVersion("vault-record");
    const versionTwo = await createVersionTwoProvider(test.onlineManifestPath);
    provider = versionTwo.provider;
    await expect(maintenance.stageKeyVersion("vault-record")).resolves.toMatchObject({
      keyVersion: 2,
      state: "staged",
      verifiedNodeIds: ["maintenance-node"],
    });
    await expect(maintenance.activateKeyVersion("vault-record", 2)).resolves.toMatchObject({
      keyVersion: 2,
      state: "active",
    });
    expect(securityEpoch).toBe(1);

    const versionThree = await createNextVersionProvider(versionTwo.manifestPath, 2);
    provider = versionThree.provider;
    await expect(maintenance.stageKeyVersion("vault-record")).resolves.toMatchObject({
      keyVersion: 3,
      state: "staged",
    });
    securityEpoch = 0;
    await expect(maintenance.activateKeyVersion("vault-record", 3)).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
    expect((await store.loadSnapshot()).versions.securityEpoch).toBe(1);
    await expect(manager.listInventory()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ keyVersion: 2, state: "active" }),
        expect.objectContaining({ keyVersion: 3, state: "staged" }),
      ]),
    );

    securityEpoch = 1;
    liveWriterFence = {
      ...registration.writerFence,
      writerEpoch: registration.writerFence.writerEpoch + 1,
    };
    await expect(maintenance.activateKeyVersion("vault-record", 3)).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
    expect((await store.loadSnapshot()).versions.securityEpoch).toBe(1);

    liveWriterFence = registration.writerFence;
    securityEpoch = 0;
    const nextFingerprint = "e".repeat(64);
    await expect(maintenance.stageNextFingerprint(nextFingerprint)).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
    expect(await maintenanceStore.activationState()).not.toHaveProperty("nextFingerprint");
    securityEpoch = 1;
    await expect(maintenance.stageNextFingerprint(nextFingerprint)).resolves.toMatchObject({
      nextFingerprint,
    });
    liveWriterFence = {
      ...registration.writerFence,
      writerEpoch: registration.writerFence.writerEpoch + 1,
    };
    await expect(maintenance.abortNextFingerprint(nextFingerprint)).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
    await expect(maintenanceStore.activationState()).resolves.toMatchObject({
      currentFingerprint: fingerprint,
      nextFingerprint,
    });
  });
});
