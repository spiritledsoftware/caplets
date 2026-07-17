import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { stableJsonStringify } from "../src/stable-json";
import { createArtifactProviderIdentity } from "../src/control-plane/artifacts/provider";
import { createControlPlaneRepository } from "../src/control-plane/caplets/repository";
import {
  attachVerifiedPostgresPools,
  type PostgresControlPlaneDialect,
  type PostgresPool,
} from "../src/control-plane/dialect/postgres";
import {
  loadMigrationRegistry,
  type MigrationEnvironment,
} from "../src/control-plane/dialect/migrations";
import { openSqliteControlPlaneDialect } from "../src/control-plane/dialect/sqlite";
import {
  createControlPlaneMigrationPersistence,
  type ControlPlaneMigrationPersistence,
} from "../src/control-plane/migration/persistence";
import { runFreshControlPlaneInitialization } from "../src/control-plane/migration/legacy";
import {
  recoveryEnvelopeBindingDigest,
  type RecoveryEnvelopeBinding,
} from "../src/control-plane/migration/manifest";
import type {
  BackupDestructionIntent,
  BackupInventoryRecord,
} from "../src/control-plane/migration/backup";
import type {
  AuthenticatedRecoveryCheckpoint,
  RestoredSqlMarker,
} from "../src/control-plane/migration/catastrophic-recovery";
import type {
  NormalRestoreConfirmation,
  RestorableControlPlaneState,
  RestoreOperationRecoveryEvidence,
} from "../src/control-plane/migration/restore";
import { createInternalControlPlaneStorageMigrationService } from "../src/control-plane/service";
import { quoteSafeSqlIdentifier } from "../src/control-plane/schema/model-codec";
import type {
  ResolvedPostgresStorage,
  ResolvedSqliteStorage,
} from "../src/control-plane/storage-config";
import type {
  ControlPlaneSqlTransaction,
  ControlPlaneTable,
  ControlPlaneTransactionalDialect,
} from "../src/control-plane/store";
import type { ControlPlaneStoreIdentity } from "../src/control-plane/types";

const require = createRequire(import.meta.url);
const sourceAssetRoot = resolve(import.meta.dirname, "..", "drizzle");
const postgresAdminUrl = process.env.CAPLETS_TEST_POSTGRES_URL;
const identity: ControlPlaneStoreIdentity = {
  logicalHostId: "host_01J00000000000000000000000",
  storeId: "store_01J00000000000000000000000",
  operationNamespace: "namespace_01J00000000000000000000",
};
const roots: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function migrationEnvironment(): MigrationEnvironment {
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
    now: new Date("2026-07-15T00:00:00.000Z"),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("control-plane U7 typed-Drizzle persistence", () => {
  it("survives a SQLite fault/restart with exact ledgers, one authority, supersession, destruction, and checkpoint state", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-u7-persistence-"));
    roots.push(root);
    await chmod(root, 0o700);
    expect((await stat(root)).mode & 0o077).toBe(0);
    const databasePath = join(root, "control-plane.sqlite3");
    const storage: ResolvedSqliteStorage = {
      backend: "sqlite",
      ...identity,
      stateRoot: root,
      databasePath,
      keyProviderManifest: join(root, "key-provider.json"),
      artifacts: { kind: "filesystem", root: join(root, "artifacts") },
    };
    let dialect = await openSqliteControlPlaneDialect({
      storage,
      environment: migrationEnvironment(),
      assetRoot: sourceAssetRoot,
    });
    expect(dialect.migrate()).toEqual([
      "0000_orange_tusk",
      "0001_conscious_wilson_fisk",
      "0002_colorful_maverick",
      "0003_lazy_terrax",
      "0004_condemned_cardiac",
      "0005_great_matthew_murdock",
      "0006_mature_bill_hollister",
      "0007_cuddly_cerebro",
      "0008_giant_shard",
      "0009_harsh_gideon",
    ]);
    await createControlPlaneRepository({ identity, dialect }).initialize();
    let persistence = createControlPlaneMigrationPersistence({
      identity,
      dialect,
      nodeId: "sqlite-a",
    });

    const elected = await persistence.election.tryElect();
    expect(elected?.fencingToken).toBe(1);
    if (!elected) throw new Error("SQLite migration election was not acquired");
    const loser = createControlPlaneMigrationPersistence({ identity, dialect, nodeId: "sqlite-b" });
    expect(await loser.election.tryElect()).toBeUndefined();

    const manifestSha256 = hash("legacy-manifest");
    const metadata = {
      kind: "legacy" as const,
      migrationId: "legacy-persistence",
      manifestSha256,
      protectedBundleId: "protected-bundle-1",
      exclusionCleanupId: "exclusion-cleanup-1",
      activationId: "activation-legacy-persistence",
    };
    const canonicalClient = {
      modelVersion: 1 as const,
      kind: "client" as const,
      identity: { clientId: "client-legacy-1" },
      fields: {
        role: "access",
        status: "active",
        hostUrl: "https://legacy.invalid",
        clientLabel: "Legacy client",
      },
    };
    const protectedRecord = {
      domain: "remote-server-state" as const,
      sourcePath: "auth/remote-state.json",
      recordIndex: 0,
      canonical: canonicalClient,
      protection: { verifiedBy: "u6" as const, commitment: hash("protected-client") },
    };
    const trackedCapletPath = join(root, "tracked-caplet-1");
    await mkdir(trackedCapletPath);
    await writeFile(
      join(trackedCapletPath, "CAPLET.md"),
      [
        "---",
        "name: Tracked migration fixture",
        "description: A complete legacy Caplet migration fixture.",
        "mcpServer:",
        "  command: node",
        "  args:",
        '    - "-e"',
        '    - ""',
        "---",
        "# Tracked migration fixture",
        "",
      ].join("\n"),
      "utf8",
    );
    const trackedCaplet = {
      entry: {
        id: "tracked-caplet-1",
        destination: "tracked-caplet-1",
        kind: "directory" as const,
        source: {
          type: "git" as const,
          repository: "https://example.invalid/caplets.git",
          path: "tracked-caplet-1",
          resolvedRevision: "abc123",
          portability: "portable" as const,
        },
        installedHash: hash("tracked-caplet"),
        installedAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:01:00.000Z",
        risk: {
          backendFamilies: [],
          safety: "standard" as const,
          projectBindingRequired: false,
          mutating: false,
          destructive: false,
        },
      },
      sourcePath: trackedCapletPath,
      installedHash: hash("tracked-caplet"),
    };
    const jsonProtectedRecord = {
      domain: "vault-grant" as const,
      sourcePath: "vault/grants.json",
      recordIndex: 0,
      canonical: {
        modelVersion: 1 as const,
        kind: "vault-grant" as const,
        identity: {
          referenceName: "legacy-secret",
          capletId: trackedCaplet.entry.id,
        },
        fields: {
          createdAt: "2025-01-02T03:04:05.000Z",
          aggregateVersion: 7,
          origin: { source: "legacy", nested: { preserved: true } },
          storedKey: "legacy-secret-key",
        },
      },
      protection: { verifiedBy: "u6" as const, commitment: hash("protected-vault-grant") },
    };
    const quarantine = {
      domain: "operator-activity" as const,
      sourcePath: "activity/history.json",
      recordIndex: 1,
      sourceBytes: Buffer.from("{malformed"),
      rawDigest: hash("{malformed"),
      reason: "malformed-record" as const,
      fields: ["timestamp"],
      auditProvenance: {
        reader: "strict-legacy-v1" as const,
        disposition: "preserved-in-protected-recovery" as const,
      },
    };
    const verifiedSource = {
      trackedCaplets: [trackedCaplet],
      records: [
        {
          domain: protectedRecord.domain,
          sourcePath: protectedRecord.sourcePath,
          recordIndex: protectedRecord.recordIndex,
          canonical: canonicalClient,
        },
        {
          domain: jsonProtectedRecord.domain,
          sourcePath: jsonProtectedRecord.sourcePath,
          recordIndex: jsonProtectedRecord.recordIndex,
          canonical: jsonProtectedRecord.canonical,
        },
      ],
      quarantines: [quarantine],
      manifestSha256,
    };
    const operation = { migrationId: metadata.migrationId, fencingToken: elected.fencingToken };
    await persistence.legacyDestination.assertCanInitialize({ operation, metadata });
    await persistence.legacyDestination.beginInactive({ operation, metadata });
    await persistence.legacyDestination.stageEntity({
      operation,
      entity: { kind: "tracked-caplet", value: trackedCaplet },
    });
    await persistence.legacyDestination.stageEntity({
      operation,
      entity: { kind: "legacy-record", value: protectedRecord },
    });
    await persistence.legacyDestination.stageEntity({
      operation,
      entity: { kind: "legacy-record", value: jsonProtectedRecord },
    });
    await persistence.legacyDestination.stageEntity({
      operation,
      entity: { kind: "quarantine", value: quarantine },
    });
    await persistence.legacyDestination.commitInactive(operation);
    await persistence.legacyDestination.invalidateAuthority(operation);
    await persistence.legacyDestination.verifyInactive({
      operation,
      source: verifiedSource,
      protectedRecords: [protectedRecord, jsonProtectedRecord],
    });
    const activation = await persistence.legacyDestination.activateAuthority({
      operation,
      metadata,
    });
    expect(activation.authorityToken).toBe("1:0");
    await persistence.legacyDestination.finalize({ operation, metadata });
    expect(await persistence.legacyDestination.inspect(operation)).toEqual({
      state: "finalized",
      metadata,
    });
    let originalJournalDocument = "";
    await dialect.maintenanceTransaction(async (transaction) => {
      const [journal] = await transaction.select("migrations", {
        equals: { logicalHostId: identity.logicalHostId, migrationId: metadata.migrationId },
      });
      if (!journal || typeof journal.stateDocument !== "string")
        throw new Error("SQLite migration journal missing");
      originalJournalDocument = journal.stateDocument;
      await transaction.update(
        "migrations",
        {
          stateDocument: stableJsonStringify({
            ...JSON.parse(journal.stateDocument),
            activation: { activationId: "corrupted-but-valid-json", authorityToken: "1:0" },
          }),
        },
        { equals: { logicalHostId: identity.logicalHostId, migrationId: metadata.migrationId } },
      );
    });
    await expect(persistence.legacyDestination.inspect(operation)).rejects.toThrow(/checksum/u);
    await dialect.maintenanceTransaction(async (transaction) => {
      await transaction.update(
        "migrations",
        {
          stateDocument: originalJournalDocument,
        },
        { equals: { logicalHostId: identity.logicalHostId, migrationId: metadata.migrationId } },
      );
    });
    await dialect.maintenanceTransaction(async (transaction) => {
      expect(
        await transaction.select("clients", {
          equals: { logicalHostId: identity.logicalHostId, clientId: "client-legacy-1" },
        }),
      ).toHaveLength(1);
      expect(
        await transaction.select("quarantines", {
          equals: { logicalHostId: identity.logicalHostId },
        }),
      ).toHaveLength(1);
      expect(
        await transaction.select("caplets", {
          equals: { logicalHostId: identity.logicalHostId, id: trackedCaplet.entry.id },
        }),
      ).toHaveLength(1);
      expect(
        await transaction.select("capletProvenance", {
          equals: { logicalHostId: identity.logicalHostId, capletId: trackedCaplet.entry.id },
        }),
      ).toHaveLength(1);
      const [grant] = await transaction.select("vaultGrants", {
        equals: { logicalHostId: identity.logicalHostId, referenceName: "legacy-secret" },
      });
      expect(grant?.origin).toBe(stableJsonStringify(jsonProtectedRecord.canonical.fields.origin));
      expect(grant).toMatchObject({
        createdAt: "2025-01-02T03:04:05.000Z",
        aggregateVersion: 7,
      });
    });

    const envelopeBinding = recoveryBinding();
    const record = backupRecord(envelopeBinding);
    await persistence.recoveryBackupLifecycle.transaction(async (transaction) => {
      await transaction.writeBackupIntent({
        version: 1,
        backupId: record.backupId,
        bindingDigest: record.bindingDigest,
        providerIdentity: record.providerIdentity,
        envelopeBytesReference: record.envelopeBytesReference,
        wrappedKeyReference: record.wrappedKeyReference,
        recoveryKeyReference: record.recoveryKeyReference,
        createdAt: record.createdAt,
        phase: "finalized",
        wrappedKeyDigest: record.wrappedKeyDigest,
        headerDigest: record.headerDigest,
        terminalManifestDigest: record.terminalManifestDigest,
        chunkCount: 1,
        plaintextLength: 12,
        finalizedAt: record.finalizedAt,
      });
    });
    await persistence.backupLifecycle.transaction(async (transaction) => {
      expect(await transaction.readAuthorityToken()).toEqual({
        authorityGeneration: 1,
        effectiveGeneration: 0,
      });
      await transaction.writeInventory({ version: 1, purgeWatermark: 7, records: [record] });
    });

    await seedConfirmation(dialect, "destruction-confirmation");
    const intent = destructionIntent(record);
    await persistence.backupLifecycle.transaction(async (transaction) => {
      await transaction.writeDestructionIntent(intent);
    });
    await dialect.maintenanceTransaction(async (transaction) => {
      const now = await transaction.databaseTime();
      await transaction.insert("effectiveVersions", {
        modelVersion: 1,
        id: "u7-effective:60",
        logicalHostId: identity.logicalHostId,
        storeId: identity.storeId,
        createdAt: now,
        updatedAt: now,
        aggregateVersion: 0,
        authorityVersion: 1,
        effectiveVersion: 60,
        securityVersion: 1,
        generation: 60,
        snapshotHash: hash("effective-60"),
        appliedToken: "1:60",
        publishedAt: now,
      });
      await transaction.update(
        "authorityVersions",
        {
          effectiveVersion: 60,
          authorityToken: "1:60",
          updatedAt: now,
        },
        { equals: { logicalHostId: identity.logicalHostId, generation: 1 } },
      );
    });
    const operationRecovery = restoreOperationRecovery();
    const candidate = { ...restoreCandidate(record, operationRecovery), effectiveGeneration: 40 };
    await persistence.restore.beginRestore({
      restoreId: "restore-1",
      backupId: record.backupId,
      fenceToken: "fence-restore-1",
    });
    await persistence.restore.writeInactiveCandidate({
      restoreId: "restore-1",
      fenceToken: "fence-restore-1",
      candidate,
      expectedAuthorityGeneration: 1,
      operationRecovery,
    });
    const durableCandidate = await persistence.restore.readInactiveCandidate(
      "restore-1",
      "fence-restore-1",
    );
    expect(durableCandidate?.operationRecovery.terminalOutcomes[0]?.disposition).toBe("superseded");
    if (!durableCandidate) throw new Error("Durable restore candidate is unavailable");

    // Fault/restart boundary: no in-memory adapter state participates in recovery.
    await dialect.close();
    dialect = await openSqliteControlPlaneDialect({
      storage,
      environment: migrationEnvironment(),
      assetRoot: sourceAssetRoot,
    });
    expect(dialect.migrate()).toEqual([]);
    persistence = createControlPlaneMigrationPersistence({
      identity,
      dialect,
      nodeId: "sqlite-restarted",
    });
    await persistence.restore.verifyInactiveCandidate(
      "restore-1",
      "fence-restore-1",
      durableCandidate,
    );
    const restoreActivation = {
      restoreId: "restore-1",
      fenceToken: "fence-restore-1",
      candidate: durableCandidate,
      confirmation: {
        token: "restore-confirmation",
        restoreId: "restore-1",
        target: identity,
        expectedAuthorityGeneration: 1,
        expectedSecurityEpoch: 1,
        selectedBackup: record,
        completeBackupInventory: [record],
        envelopeBinding,
        consequencesCommitment: hash("restore-consequences"),
      },
    };
    await seedRestoreConfirmation(dialect, restoreActivation.confirmation, "1:60");
    await expect(
      persistence.restore.activateInactiveCandidate({
        ...restoreActivation,
        confirmation: { ...restoreActivation.confirmation, restoreId: "restore-other" },
      }),
    ).resolves.toBe("confirmation-invalid");
    const activated = await persistence.restore.activateInactiveCandidate(restoreActivation);
    expect(activated).toBe("activated");
    expect(await persistence.restore.activateInactiveCandidate(restoreActivation)).toBe("conflict");
    expect(await persistence.restore.readRestoreJournal("restore-1")).toEqual({
      status: "activated",
      candidate,
    });
    await dialect.close();
    dialect = await openSqliteControlPlaneDialect({
      storage,
      environment: migrationEnvironment(),
      assetRoot: sourceAssetRoot,
    });
    expect(dialect.migrate()).toEqual([]);
    persistence = createControlPlaneMigrationPersistence({
      identity,
      dialect,
      nodeId: "sqlite-activated-restart",
    });
    const restoredStore = createControlPlaneRepository({ identity, dialect });
    await restoredStore.initialize();
    await expect(
      restoredStore.lookupOrReserveNotCommitted(operationRecovery.consumedBindings[0]!),
    ).resolves.toMatchObject({ status: "not_committed" });
    await persistence.backupLifecycle.transaction(async (transaction) => {
      expect(await transaction.readAuthorityToken()).toEqual({
        authorityGeneration: 2,
        effectiveGeneration: 40,
      });
    });

    const completedIntent: BackupDestructionIntent = {
      ...intent,
      phase: "completed",
      receipt: {
        version: 1,
        destructionId: intent.destructionId,
        backupId: record.backupId,
        confirmationId: intent.confirmationId,
        inventoryHash: intent.inventoryHash,
        targetDigest: intent.targetDigest,
        completedAt: "2026-07-15T02:00:00.000Z",
        bytesAbsent: true,
        wrappedKeyAbsent: true,
        receiptDigest: hash("destruction-receipt"),
      },
    };
    await persistence.backupLifecycle.transaction(async (transaction) =>
      transaction.writeDestructionIntent(completedIntent),
    );
    await persistence.backupLifecycle.transaction(async (transaction) => {
      expect(await transaction.readDestructionIntent(intent.destructionId)).toEqual(
        completedIntent,
      );
      await expect(
        transaction.writeInventory({ version: 0, purgeWatermark: 6, records: [record] }),
      ).rejects.toThrow(/cannot regress/u);
      await expect(
        transaction.writeInventory({ version: 2, purgeWatermark: 7, records: [] }),
      ).rejects.toThrow(/cannot drop/u);
    });

    const checkpoint = selectedCheckpoint(record);
    await persistence.catastrophic.writeSelectedCheckpoint({
      checkpoint,
      descriptor: {
        generation: 1,
        checkpointDigest: checkpoint.digest,
        logicalHostId: identity.logicalHostId,
      },
    });
    expect(await persistence.catastrophic.readSelectedCheckpoint(1)).toEqual({
      checkpoint,
      descriptor: {
        generation: 1,
        checkpointDigest: checkpoint.digest,
        logicalHostId: identity.logicalHostId,
      },
    });
    const marker: RestoredSqlMarker = {
      recoveryId: "catastrophic-1",
      descriptorGeneration: 1,
      descriptorDigest: checkpoint.digest,
      oldIdentity: { ...identity, storeId: "store_old_01J000000000000000000" },
      newIdentity: identity,
      securityEpoch: 3,
    };
    await persistence.catastrophic.writeRestoredSqlMarker(marker);
    expect(await persistence.catastrophic.readRestoredSqlMarker(marker.recoveryId)).toEqual(marker);
    const checkpoint2: AuthenticatedRecoveryCheckpoint = {
      ...checkpoint,
      payload: {
        ...checkpoint.payload,
        generation: 2,
        priorRecordDigest: checkpoint.digest,
      },
      digest: hash("checkpoint-2"),
      authentication: hash("checkpoint-authentication-2"),
    };
    await persistence.catastrophic.writeSelectedCheckpoint({
      checkpoint: checkpoint2,
      descriptor: {
        generation: 2,
        checkpointDigest: checkpoint2.digest,
        logicalHostId: identity.logicalHostId,
      },
    });
    expect(await persistence.catastrophic.readSelectedCheckpoint(2)).toEqual({
      checkpoint: checkpoint2,
      descriptor: {
        generation: 2,
        checkpointDigest: checkpoint2.digest,
        logicalHostId: identity.logicalHostId,
      },
    });

    await dialect.maintenanceTransaction(async (transaction) => {
      const [recovery] = await transaction.select("recoveries", {
        equals: {
          logicalHostId: identity.logicalHostId,
          recoveryId: "restore-1",
        },
      });
      if (!recovery || typeof recovery.stateDocument !== "string")
        throw new Error("SQLite restore journal missing");
      await transaction.update(
        "recoveries",
        {
          stateDocument: stableJsonStringify({
            ...JSON.parse(recovery.stateDocument),
            backupId: "corrupted-but-valid-json",
          }),
        },
        { equals: { logicalHostId: identity.logicalHostId, recoveryId: "restore-1" } },
      );
    });
    await expect(persistence.restore.readRestoreJournal("restore-1")).rejects.toThrow(/checksum/u);

    let injected: ControlPlaneMigrationPersistence | undefined;
    const service = createInternalControlPlaneStorageMigrationService({
      persistence: { identity, dialect, nodeId: "service-seam" },
      async initialize(_request, value) {
        injected = value;
        return { status: "already-migrated", backend: "sqlite" };
      },
    });
    await service.migrate({ target: "global", mode: "offline" });
    expect(injected?.backupLifecycle).toBeDefined();
    await dialect.close();
  });

  it("runs the dialect-parity readback contract on owner-private SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-u7-parity-"));
    roots.push(root);
    await chmod(root, 0o700);
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
      environment: migrationEnvironment(),
      assetRoot: sourceAssetRoot,
    });
    dialect.migrate();
    await createControlPlaneRepository({ identity, dialect }).initialize();
    await runDialectParityContract(dialect);
    await dialect.close();
  });
  it("proves a fresh Postgres destination without direct maintenance reads of application tables", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-u7-postgres-proof-"));
    roots.push(root);
    await chmod(root, 0o700);
    const storage: ResolvedSqliteStorage = {
      backend: "sqlite",
      ...identity,
      stateRoot: root,
      databasePath: join(root, "control-plane.sqlite3"),
      keyProviderManifest: join(root, "key-provider.json"),
      artifacts: { kind: "filesystem", root: join(root, "artifacts") },
    };
    const sqlite = await openSqliteControlPlaneDialect({
      storage,
      environment: migrationEnvironment(),
      assetRoot: sourceAssetRoot,
    });
    sqlite.migrate();
    await createControlPlaneRepository({ identity, dialect: sqlite }).initialize();
    const directApplicationReads: ControlPlaneTable[] = [];
    let proofCalls = 0;
    const metadataTables: Partial<Record<ControlPlaneTable, true>> = {
      migrations: true,
      operationNamespaces: true,
      authorityVersions: true,
      effectiveVersions: true,
      securityVersions: true,
      backups: true,
    };
    const postgresBoundary = {
      ...sqlite,
      backend: "postgres",
      maintenanceTransaction<T>(
        work: (transaction: ControlPlaneSqlTransaction) => Promise<T>,
      ): Promise<T> {
        return sqlite.maintenanceTransaction((transaction) => {
          const restricted: ControlPlaneSqlTransaction = {
            ...transaction,
            async select(table, filter, order, limit) {
              if (!metadataTables[table]) directApplicationReads.push(table);
              return transaction.select(table, filter, order, limit);
            },
            async migrationDestinationContainsAuthoritativeRows() {
              proofCalls += 1;
              return false;
            },
          };
          return work(restricted);
        });
      },
    } satisfies ControlPlaneTransactionalDialect;
    const persistence = createControlPlaneMigrationPersistence({
      identity,
      dialect: postgresBoundary,
      nodeId: "postgres-proof",
    });

    await expect(
      runFreshControlPlaneInitialization({
        backend: "postgres",
        destination: persistence.legacyDestination,
        election: persistence.election,
        mutex: {
          async acquire() {
            return { async release() {} };
          },
        },
      }),
    ).resolves.toMatchObject({ status: "migrated", backend: "postgres" });
    expect(proofCalls).toBe(1);
    expect(directApplicationReads).toEqual([]);
    await sqlite.close();
  });

  it("runs the real SQLite fresh coordinator with its zero fence and rejects non-bootstrap rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-u7-fresh-coordinator-"));
    roots.push(root);
    await chmod(root, 0o700);
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
      environment: migrationEnvironment(),
      assetRoot: sourceAssetRoot,
    });
    dialect.migrate();
    await createControlPlaneRepository({ identity, dialect }).initialize();
    const persistence = createControlPlaneMigrationPersistence({ identity, dialect });
    await dialect.maintenanceTransaction(async (transaction) => {
      const now = await transaction.databaseTime();
      await transaction.insert("clients", {
        modelVersion: 1,
        id: "preexisting-client",
        logicalHostId: identity.logicalHostId,
        storeId: identity.storeId,
        createdAt: now,
        updatedAt: now,
        aggregateVersion: 0,
        authorityVersion: 0,
        effectiveVersion: 0,
        securityVersion: 0,
        clientId: "preexisting-client",
        role: "access",
        status: "active",
        hostUrl: "https://preexisting.invalid",
        clientLabel: "Preexisting",
      });
    });
    const options = {
      backend: "sqlite" as const,
      destination: persistence.legacyDestination,
      election: persistence.election,
      mutex: {
        async acquire() {
          return { async release() {} };
        },
      },
    };
    await expect(runFreshControlPlaneInitialization(options)).rejects.toThrow(
      /authoritative clients/u,
    );
    await dialect.maintenanceTransaction(async (transaction) => {
      await transaction.delete("clients", {
        equals: {
          logicalHostId: identity.logicalHostId,
          storeId: identity.storeId,
          id: "preexisting-client",
        },
      });
    });
    const abortMetadata = {
      kind: "fresh" as const,
      migrationId: "sqlite-abort-cleanup",
      manifestSha256: hash("sqlite-abort-cleanup"),
      activationId: "activation-sqlite-abort-cleanup",
    };
    const abortOperation = { migrationId: abortMetadata.migrationId, fencingToken: 0 };
    await persistence.legacyDestination.beginInactive({
      operation: abortOperation,
      metadata: abortMetadata,
    });
    await persistence.legacyDestination.stageEntity({
      operation: abortOperation,
      entity: {
        kind: "legacy-record",
        value: {
          domain: "remote-server-state",
          sourcePath: "abort/client.json",
          recordIndex: 0,
          canonical: {
            modelVersion: 1,
            kind: "client",
            identity: { clientId: "abort-client" },
            fields: {
              role: "access",
              status: "active",
              hostUrl: "https://abort.invalid",
              clientLabel: "Abort cleanup",
            },
          },
          protection: { verifiedBy: "u6", commitment: hash("abort-client") },
        },
      },
    });
    await persistence.legacyDestination.commitInactive(abortOperation);
    await persistence.legacyDestination.invalidateAuthority(abortOperation);
    await persistence.legacyDestination.abortInactive(abortOperation);
    await dialect.maintenanceTransaction(async (transaction) => {
      expect(
        await transaction.select("clients", {
          equals: {
            logicalHostId: identity.logicalHostId,
            clientId: "abort-client",
          },
        }),
      ).toEqual([]);
      expect(
        await transaction.select("authorityVersions", {
          equals: {
            logicalHostId: identity.logicalHostId,
            generation: 1,
          },
        }),
      ).toEqual([]);
      expect(
        await transaction.select("securityVersions", {
          equals: {
            logicalHostId: identity.logicalHostId,
            epoch: 1,
          },
        }),
      ).toEqual([]);
    });
    await expect(runFreshControlPlaneInitialization(options)).resolves.toMatchObject({
      status: "migrated",
      backend: "sqlite",
    });
    await expect(runFreshControlPlaneInitialization(options)).resolves.toMatchObject({
      status: "already-migrated",
      backend: "sqlite",
    });
    await expect(persistence.inspectInitializationJournal()).resolves.toEqual({
      kind: "fresh",
      migrationId: "fresh-v1",
      state: "finalized",
    });
    await dialect.close();
  });
  it("routes initialization journal reads through the process metadata credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "caplets-u7-metadata-read-"));
    roots.push(root);
    await chmod(root, 0o700);
    const dialect = await openSqliteControlPlaneDialect({
      storage: {
        backend: "sqlite",
        ...identity,
        stateRoot: root,
        databasePath: join(root, "control-plane.sqlite3"),
        keyProviderManifest: join(root, "key-provider.json"),
        artifacts: { kind: "filesystem", root: join(root, "artifacts") },
      },
      environment: migrationEnvironment(),
      assetRoot: sourceAssetRoot,
    });
    dialect.migrate();
    let metadataReads = 0;
    const persistence = createControlPlaneMigrationPersistence({
      identity,
      dialect: {
        ...dialect,
        async metadataReadTransaction(work) {
          metadataReads += 1;
          return dialect.runtimeTransaction(work);
        },
        async maintenanceTransaction() {
          throw new Error("maintenance credential must not be used");
        },
      },
      nodeId: "metadata-reader",
    });
    await expect(persistence.inspectInitializationJournal()).resolves.toBeUndefined();
    expect(metadataReads).toBe(1);
    await dialect.close();
  });
});

describe.skipIf(!postgresAdminUrl)("control-plane U7 persistence on real Postgres", () => {
  it("uses database-time election so one node owns migration and peers remain not-ready", async () => {
    if (!postgresAdminUrl) throw new Error("Postgres fixture URL is unavailable");
    const fixture = await postgresFixture(postgresAdminUrl);
    let dialect: PostgresControlPlaneDialect | undefined;
    try {
      dialect = fixture.dialect;
      await runDialectParityContract(dialect);
      const first = createControlPlaneMigrationPersistence({
        identity,
        dialect,
        nodeId: "postgres-a",
        migrationLeaseMs: 60_000,
      });
      const second = createControlPlaneMigrationPersistence({
        identity,
        dialect,
        nodeId: "postgres-b",
        migrationLeaseMs: 60_000,
      });
      const [winner, blocked] = await Promise.all([
        first.election.tryElect(),
        second.election.tryElect(),
      ]);
      expect([winner, blocked].filter(Boolean)).toHaveLength(1);
      expect([winner, blocked].filter((lease) => lease === undefined)).toHaveLength(1);
      const lease = winner ?? blocked;
      if (!lease) throw new Error("Postgres persistence election had no winner");
      expect(await lease.renew()).toBe(true);
      await lease.release();
      const nextLease = await second.election.tryElect();
      if (!nextLease) throw new Error("Postgres resumable lease was not acquired");
      const resumableMetadata = {
        kind: "fresh" as const,
        migrationId: "postgres-resumable",
        manifestSha256: hash("postgres-resumable"),
        activationId: "activation-postgres-resumable",
      };
      await second.legacyDestination.beginInactive({
        operation: {
          migrationId: resumableMetadata.migrationId,
          fencingToken: nextLease.fencingToken,
        },
        metadata: resumableMetadata,
      });
      await nextLease.release();
      const adoptedLease = await first.election.tryElect();
      if (!adoptedLease) throw new Error("Postgres adoption lease was not acquired");
      const adoptedOperation = {
        migrationId: resumableMetadata.migrationId,
        fencingToken: adoptedLease.fencingToken,
      };
      await expect(first.legacyDestination.inspect(adoptedOperation)).resolves.toMatchObject({
        state: "inactive",
      });
      await first.legacyDestination.commitInactive(adoptedOperation);
      await first.legacyDestination.invalidateAuthority(adoptedOperation);
      await first.legacyDestination.verifyInactive({
        operation: adoptedOperation,
        source: {
          trackedCaplets: [],
          records: [],
          quarantines: [],
          manifestSha256: resumableMetadata.manifestSha256,
        },
        protectedRecords: [],
      });
      await first.legacyDestination.activateAuthority({
        operation: adoptedOperation,
        metadata: resumableMetadata,
      });
      await first.legacyDestination.finalize({
        operation: adoptedOperation,
        metadata: resumableMetadata,
      });
      await adoptedLease.release();
      const finalizedLease = await first.election.tryElect();
      if (!finalizedLease) throw new Error("Postgres finalized inspection lease was not acquired");
      await expect(
        first.legacyDestination.inspect({
          migrationId: resumableMetadata.migrationId,
          fencingToken: finalizedLease.fencingToken,
        }),
      ).resolves.toMatchObject({ state: "finalized" });
      await finalizedLease.release();
    } finally {
      await dialect?.close();
      await fixture.cleanup();
    }
  });
});
async function runDialectParityContract(dialect: ControlPlaneTransactionalDialect): Promise<void> {
  const persistence = createControlPlaneMigrationPersistence({
    identity,
    dialect,
    nodeId: `parity-${dialect.backend}`,
  });
  const binding = recoveryBinding(dialect.backend);
  const record = backupRecord(binding);
  const legacyDigest = hash(`legacy-u6-backup-${dialect.backend}`);
  const legacyCreatedAt = "2026-07-14T23:00:00.000Z";
  await dialect.maintenanceTransaction(async (transaction) => {
    await transaction.insert("backups", {
      modelVersion: 1,
      id: "backup:legacy-u6-backup",
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      createdAt: legacyCreatedAt,
      updatedAt: legacyCreatedAt,
      aggregateVersion: 0,
      authorityVersion: 0,
      effectiveVersion: 0,
      securityVersion: 0,
      backupId: "legacy-u6-backup",
      providerIdentity: "fixture-provider-identity",
      sourceIdentity: "source-u6",
      sourceProfile: "offline-recovery",
      manifestHash: legacyDigest,
      keyVersion: 1,
      keyPurpose: "vault-record",
      keyAlgorithm: "AES-256-GCM",
      unwrapIdentity: "recovery-u6",
      retentionUntil: "2026-08-14T23:00:00.000Z",
      state: "finalized",
    });
  });
  const legacyRecord: BackupInventoryRecord = {
    backupId: "legacy-u6-backup",
    bindingDigest: legacyDigest,
    headerDigest: legacyDigest,
    terminalManifestDigest: legacyDigest,
    wrappedKeyDigest: legacyDigest,
    providerIdentity: "fixture-provider-identity",
    envelopeBytesReference: "legacy-sql://legacy-u6-backup/envelope",
    wrappedKeyReference: "legacy-sql://legacy-u6-backup/wrapped-key",
    recoveryKeyReference: {
      provider: "legacy-u6",
      providerIdentity: "fixture-provider-identity",
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      profile: "offline-recovery",
      purpose: "backup-recovery",
      keyId: hash(stableJsonStringify({ purpose: "vault-record", unwrapIdentity: "recovery-u6" })),
      keyVersion: 1,
    },
    createdAt: legacyCreatedAt,
    retentionUntil: "2026-08-14T23:00:00.000Z",
    state: "finalized",
    finalizedAt: legacyCreatedAt,
  };
  await persistence.backupLifecycle.transaction(async (transaction) => {
    expect(await transaction.readInventory()).toEqual({
      version: 1,
      purgeWatermark: 0,
      records: [legacyRecord],
    });
  });
  await dialect.maintenanceTransaction(async (transaction) => {
    const rows = await transaction.select("backups", {
      equals: {
        logicalHostId: identity.logicalHostId,
        storeId: identity.storeId,
        id: "backup:legacy-u6-backup",
        backupId: "legacy-u6-backup",
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceIdentity: "source-u6",
      keyPurpose: "vault-record",
      keyAlgorithm: "AES-256-GCM",
      unwrapIdentity: "recovery-u6",
      state: "finalized",
      stateDocument: expect.any(String),
    });
  });
  await persistence.recoveryBackupLifecycle.transaction(async (transaction) => {
    await transaction.writeBackupIntent({
      version: 1,
      backupId: record.backupId,
      bindingDigest: record.bindingDigest,
      providerIdentity: record.providerIdentity,
      envelopeBytesReference: record.envelopeBytesReference,
      wrappedKeyReference: record.wrappedKeyReference,
      recoveryKeyReference: record.recoveryKeyReference,
      createdAt: record.createdAt,
      phase: "finalized",
      wrappedKeyDigest: record.wrappedKeyDigest,
      headerDigest: record.headerDigest,
      terminalManifestDigest: record.terminalManifestDigest,
      chunkCount: 1,
      plaintextLength: 12,
      finalizedAt: record.finalizedAt,
    });
  });
  await persistence.backupLifecycle.transaction(async (transaction) => {
    await transaction.writeInventory({
      version: 2,
      purgeWatermark: 7,
      records: [legacyRecord, record],
    });
    expect(await transaction.readInventory()).toEqual({
      version: 2,
      purgeWatermark: 7,
      records: [legacyRecord, record],
    });
  });
  await seedConfirmation(dialect, "destruction-confirmation");
  const intent = destructionIntent(record);
  await persistence.backupLifecycle.transaction(async (transaction) => {
    await transaction.writeDestructionIntent(intent);
    expect(await transaction.readDestructionIntent(intent.destructionId)).toEqual(intent);
  });
  const operationRecovery = restoreOperationRecovery();
  const candidate = {
    ...restoreCandidate(record, operationRecovery),
    authorityGeneration: 1,
    securityEpoch: 1,
  };
  await persistence.restore.beginRestore({
    restoreId: "restore-parity",
    backupId: record.backupId,
    fenceToken: "fence-parity",
  });
  await persistence.restore.writeInactiveCandidate({
    restoreId: "restore-parity",
    fenceToken: "fence-parity",
    candidate,
    expectedAuthorityGeneration: 0,
    operationRecovery,
  });
  const durable = await persistence.restore.readInactiveCandidate("restore-parity", "fence-parity");
  expect(durable?.state).toEqual(candidate);
  if (!durable) throw new Error("Parity restore candidate is unavailable");
  await persistence.restore.verifyInactiveCandidate("restore-parity", "fence-parity", durable);
  const checkpoint = selectedCheckpoint(record);
  const descriptor = {
    generation: 1,
    checkpointDigest: checkpoint.digest,
    logicalHostId: identity.logicalHostId,
  };
  await persistence.catastrophic.writeSelectedCheckpoint({ checkpoint, descriptor });
  expect(await persistence.catastrophic.readSelectedCheckpoint(1)).toEqual({
    checkpoint,
    descriptor,
  });
}

function recoveryBinding(sourceBackend: "sqlite" | "postgres" = "sqlite"): RecoveryEnvelopeBinding {
  return {
    logicalHostId: identity.logicalHostId,
    storeId: identity.storeId,
    sourceBackend,
    requiredSchemaNames: ["cp_backup"],
    schemaChecksums: [{ name: "cp_backup", sha256: hash("cp_backup-schema") }],
    authorityToken: "1:0",
    effectiveToken: "0",
    securityToken: "1",
    requiredEntityNames: ["caplet"],
    entityManifest: [{ entity: "caplet", count: 1, sha256: hash("caplet-manifest") }],
    recoveryKeyReference: {
      provider: "fixture-provider",
      providerIdentity: "fixture-provider-identity",
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      profile: "offline-recovery",
      purpose: "backup-recovery",
      keyId: "recovery-key-1",
      keyVersion: 1,
    },
  };
}

function backupRecord(binding: RecoveryEnvelopeBinding): BackupInventoryRecord {
  return {
    backupId: "backup-1",
    bindingDigest: recoveryEnvelopeBindingDigest(binding),
    headerDigest: hash("header"),
    terminalManifestDigest: hash("terminal"),
    wrappedKeyDigest: hash("wrapped-key"),
    providerIdentity: binding.recoveryKeyReference.providerIdentity,
    envelopeBytesReference: "fixture://backup-1/envelope",
    wrappedKeyReference: "fixture://backup-1/wrapped-key",
    recoveryKeyReference: binding.recoveryKeyReference,
    createdAt: "2026-07-15T01:00:00.000Z",
    retentionUntil: "2026-08-15T01:00:00.000Z",
    state: "finalized",
    finalizedAt: "2026-07-15T01:01:00.000Z",
  };
}

function destructionIntent(record: BackupInventoryRecord): BackupDestructionIntent {
  return {
    version: 1,
    destructionId: "destruction-1",
    confirmationId: "destruction-confirmation",
    inventoryHash: hash("inventory-v1"),
    targetDigest: hash("destruction-target"),
    target: {
      backupId: record.backupId,
      providerIdentity: record.providerIdentity,
      envelopeBytesReference: record.envelopeBytesReference,
      wrappedKeyReference: record.wrappedKeyReference,
      recoveryKeyReference: record.recoveryKeyReference,
    },
    phase: "confirmed",
    createdAt: "2026-07-15T01:30:00.000Z",
  };
}

function restoreOperationRecovery(): RestoreOperationRecoveryEvidence {
  const binding = {
    operationId: "operation-ack-lost",
    target: "global" as const,
    logicalHostId: identity.logicalHostId,
    storeId: identity.storeId,
    operationNamespace: identity.operationNamespace,
    actorId: "operator-1",
    requestIdentity: hash("request-identity"),
    operationClass: "logical-state" as const,
  };
  return {
    consumedBindings: [binding],
    terminalOutcomes: [
      { binding, disposition: "superseded", receipt: { status: "committed", value: 1 } },
    ],
  };
}

function restoreCandidate(
  record: BackupInventoryRecord,
  evidence: RestoreOperationRecoveryEvidence,
): RestorableControlPlaneState {
  return {
    identity,
    authorityGeneration: 2,
    effectiveGeneration: 0,
    securityEpoch: 2,
    domain: [],
    lifecycle: {
      backups: [record],
      finalizations: [],
      destructions: [],
      keyRetirements: [],
      externalDestructionIntents: [],
      nonRestorableLedgers: [],
      consumedOperationIds: evidence.consumedBindings,
      retentionCutoff: 7,
      purgeWatermark: 7,
    },
    operationOutcomes: evidence.terminalOutcomes.map((outcome) => ({
      binding: outcome.binding,
      status: "superseded_by_restore" as const,
      receipt: outcome.receipt,
      effectCommitments: [],
    })),
    security: {
      sessions: [],
      tokenFamilies: [],
      approvals: [],
      roles: [],
      credentials: [],
      projectBindingLeases: [],
      vaultGrants: [],
    },
  };
}

function selectedCheckpoint(record: BackupInventoryRecord): AuthenticatedRecoveryCheckpoint {
  return {
    format: "caplets-recovery-checkpoint-v1",
    state: "selected",
    payload: {
      generation: 1,
      priorRecordDigest: null,
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      operationNamespace: identity.operationNamespace,
      securityEpoch: 2,
      providerCommitment: hash("provider-commitment"),
      keyCommitment: hash("key-commitment"),
      backupInventory: [],
      pendingDestructionIntents: [],
      immutableReceipts: [],
      backupId: record.backupId,
    },
    digest: hash("checkpoint-1"),
    authentication: hash("checkpoint-authentication"),
  };
}

async function seedRestoreConfirmation(
  dialect: ControlPlaneTransactionalDialect,
  confirmation: NormalRestoreConfirmation,
  authorityToken: string,
): Promise<void> {
  await dialect.maintenanceTransaction(async (transaction) => {
    const now = await transaction.databaseTime();
    const affectedInventory = {
      version: 1,
      kind: "normal-restore-confirmation",
      confirmation,
    };
    await transaction.insert("confirmations", {
      modelVersion: 1,
      id: confirmation.token,
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      createdAt: now,
      updatedAt: now,
      aggregateVersion: 0,
      authorityVersion: confirmation.expectedAuthorityGeneration,
      effectiveVersion: 0,
      securityVersion: confirmation.expectedSecurityEpoch,
      confirmationId: confirmation.token,
      action: "normal-restore",
      authorityToken,
      inventoryHash: createHash("sha256")
        .update(stableJsonStringify(confirmation.completeBackupInventory))
        .digest("hex"),
      affectedInventory:
        transaction.backend === "sqlite"
          ? stableJsonStringify(affectedInventory)
          : affectedInventory,
      expiresAt: "2099-01-01T00:00:00.000Z",
      consequences: confirmation.consequencesCommitment,
      state: "previewed",
    });
  });
}

async function seedConfirmation(
  dialect: ControlPlaneTransactionalDialect,
  confirmationId: string,
): Promise<void> {
  await dialect.maintenanceTransaction(async (transaction) => {
    const now = await transaction.databaseTime();
    await transaction.insert("confirmations", {
      modelVersion: 1,
      id: confirmationId,
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      createdAt: now,
      updatedAt: now,
      aggregateVersion: 0,
      authorityVersion: 1,
      effectiveVersion: 0,
      securityVersion: 1,
      confirmationId,
      action: "backup-destruction",
      authorityToken: "1:0",
      inventoryHash: hash("inventory-v1"),
      affectedInventory: '["backup-1"]',
      expiresAt: "2099-01-01T00:00:00.000Z",
      consequences: "destroy backup",
      state: "previewed",
    });
  });
}

async function postgresFixture(adminUrl: string): Promise<{
  dialect: PostgresControlPlaneDialect;
  cleanup(): Promise<void>;
}> {
  const Pool = require("pg").Pool as new (options: {
    connectionString: string;
    max: number;
  }) => PostgresPool;
  const admin = new Pool({ connectionString: adminUrl, max: 2 });
  const suffix = process.pid.toString(36);
  const roles = {
    runtime: `caplets_u7_runtime_${suffix}`,
    migrator: `caplets_u7_migrator_${suffix}`,
    maintenance: `caplets_u7_maintenance_${suffix}`,
  };
  const passwords = {
    runtime: "runtime-fixture-password",
    migrator: "migrator-fixture-password",
    maintenance: "maintenance-fixture-password",
  };
  const databaseName = new URL(adminUrl).pathname.slice(1);
  await admin.query(`
    DROP SCHEMA IF EXISTS caplets CASCADE;
    DROP ROLE IF EXISTS ${quoteSafeSqlIdentifier(roles.runtime)};
    DROP ROLE IF EXISTS ${quoteSafeSqlIdentifier(roles.migrator)};
    DROP ROLE IF EXISTS ${quoteSafeSqlIdentifier(roles.maintenance)};
    CREATE ROLE ${quoteSafeSqlIdentifier(roles.runtime)} LOGIN NOINHERIT PASSWORD '${passwords.runtime}';
    CREATE ROLE ${quoteSafeSqlIdentifier(roles.migrator)} LOGIN NOINHERIT PASSWORD '${passwords.migrator}';
    CREATE ROLE ${quoteSafeSqlIdentifier(roles.maintenance)} LOGIN NOINHERIT PASSWORD '${passwords.maintenance}';
    GRANT CREATE ON DATABASE ${quoteSafeSqlIdentifier(databaseName)} TO ${quoteSafeSqlIdentifier(roles.migrator)};
  `);
  const roleUrl = (role: keyof typeof roles) => {
    const url = new URL(adminUrl);
    url.username = roles[role];
    url.password = passwords[role];
    return url.href;
  };
  const pools = {
    runtime: new Pool({ connectionString: roleUrl("runtime"), max: 2 }),
    migrator: new Pool({ connectionString: roleUrl("migrator"), max: 2 }),
    maintenance: new Pool({ connectionString: roleUrl("maintenance"), max: 2 }),
  };
  const storage: ResolvedPostgresStorage = {
    backend: "postgres",
    ...identity,
    stateRoot: "/tmp/caplets-u7-postgres",
    keyProviderManifest: "/tmp/caplets-u7-postgres/key-provider.json",
    artifacts: {
      kind: "s3",
      identity: createArtifactProviderIdentity({
        kind: "s3",
        provider: "https://objects.invalid/caplets-u7",
        namespace: "persistence-test",
        logicalHostId: identity.logicalHostId,
        storeId: identity.storeId,
      }),
    },
  };
  const registry = await loadMigrationRegistry({ dialect: "postgres", assetRoot: sourceAssetRoot });
  const dialect = await attachVerifiedPostgresPools({
    storage,
    pools,
    roles,
    registry,
    environment: migrationEnvironment(),
  });
  await dialect.migrate();
  await admin.query(`
    GRANT USAGE ON SCHEMA caplets TO ${quoteSafeSqlIdentifier(roles.runtime)}, ${quoteSafeSqlIdentifier(roles.maintenance)};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA caplets TO ${quoteSafeSqlIdentifier(roles.runtime)}, ${quoteSafeSqlIdentifier(roles.maintenance)};
  `);
  await createControlPlaneRepository({ identity, dialect }).initialize();
  return {
    dialect,
    async cleanup() {
      await Promise.allSettled([
        pools.runtime.end(),
        pools.migrator.end(),
        pools.maintenance.end(),
      ]);
      await admin.query(`DROP SCHEMA IF EXISTS caplets CASCADE;`);
      await admin.query(`
        DROP OWNED BY ${quoteSafeSqlIdentifier(roles.runtime)} CASCADE;
        DROP OWNED BY ${quoteSafeSqlIdentifier(roles.migrator)} CASCADE;
        DROP OWNED BY ${quoteSafeSqlIdentifier(roles.maintenance)} CASCADE;
      `);
      await admin.query(`
        DROP ROLE IF EXISTS ${quoteSafeSqlIdentifier(roles.runtime)};
        DROP ROLE IF EXISTS ${quoteSafeSqlIdentifier(roles.migrator)};
        DROP ROLE IF EXISTS ${quoteSafeSqlIdentifier(roles.maintenance)};
      `);
      await admin.end();
    },
  };
}
