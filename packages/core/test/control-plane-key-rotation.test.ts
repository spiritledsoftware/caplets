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
import { createControlPlaneSecurityRepository } from "../src/control-plane/security/repository";
import { createControlPlaneRepository } from "../src/control-plane/caplets/repository";
import { encodeCanonicalJson } from "../src/control-plane/schema/model-codec";
import type { ResolvedSqliteStorage } from "../src/control-plane/storage-config";
import type { ControlPlaneStoreIdentity } from "../src/control-plane/types";

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
  now: new Date("2026-07-15T00:00:00.000Z"),
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

async function createVersionTwoProvider(manifestPath: string) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MutableManifest;
  const previous = manifest.entries.find(
    (entry) => entry.purpose === "vault-record" && entry.keyVersion === 1,
  );
  const previousCompatibility = manifest.compatibilityKeys.find(
    (entry) => entry.purpose === "vault-record" && entry.keyVersion === 1,
  );
  if (!previous || !previousCompatibility) throw new Error("vault-record v1 is missing");
  previous.operations = previous.operations.filter((operation) => operation === "decrypt");
  const material = randomBytes(32);
  const next: MutableManifestEntry = {
    ...previous,
    keyId: "key_01J00000000000000000000002",
    keyVersion: 2,
    file: "keys/vault-record-v2.key",
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
  const nextManifestPath = join(dirname(manifestPath), "online-v2.json");
  await writeFile(nextManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(nextManifestPath, 0o600);
  return {
    material,
    provider: await loadFileV1KeyProvider({
      manifestPath: nextManifestPath,
      expectedLogicalHostId: identity.logicalHostId,
      expectedStoreId: identity.storeId,
      expectedProfile: "online",
    }),
  };
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
      writerLease: "unavailable-until-u10",
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
      clusterActivation: "unavailable-until-u10",
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
    ).resolves.toMatchObject({ verified: true, writerLease: "unavailable-until-u10" });
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
      clusterActivation: "unavailable-until-u10",
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
});
