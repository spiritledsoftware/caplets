import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CurrentHostAuthorityToken } from "../../current-host/operations";
import { CapletsError } from "../../errors";
import { stableJsonStringify } from "../../stable-json";
import type {
  ControlPlaneDatabaseRow,
  ControlPlaneSqlTransaction,
  ControlPlaneTable,
  ControlPlaneTransactionalDialect,
} from "../store";
import type { ControlPlaneStoreIdentity } from "../types";
import type {
  BackupDestructionIntent,
  BackupDestructionPreviewRecord,
  BackupInventoryRecord,
  BackupInventorySnapshot,
  BackupLifecycleLedgerPort,
  BackupLifecycleTransaction,
  RecoveryBackupIntent,
  RecoveryBackupLifecyclePort,
  RecoveryBackupLifecycleTransaction,
} from "./backup";
import type {
  AuthenticatedRecoveryCheckpoint,
  RecoveryDescriptor,
  RestoredSqlMarker,
} from "./catastrophic-recovery";
import type {
  LegacyDestinationOperation,
  LegacyInitializationDestination,
  LegacyInitializationEntity,
  LegacyMigrationMetadata,
  LegacyMigrationElectionLease,
  U6ProtectedLegacyRecord,
  VerifiedLegacyMigrationSource,
} from "./legacy";
import {
  canonicalFields,
  type CanonicalFieldDefinition,
  type ControlPlaneEntityKind,
  validateCanonicalEntityShape,
} from "../model";
import {
  encodeCanonicalBytes,
  encodeCanonicalJson,
  encodeCanonicalTimestamp,
  encodeCanonicalVersion,
} from "../schema/model-codec";
import type {
  DurableInactiveRestoreCandidate,
  NormalRestoreAbortPhase,
  NormalRestoreConfirmation,
  NormalRestoreJournal,
  RestoreOperationRecoveryEvidence,
  RestorableControlPlaneState,
} from "./restore";

const ZERO_HASH = "0".repeat(64);
const INVENTORY_ROW_ID = "u7:backup-inventory";
const ELECTION_ROW_ID = "u7:migration-election";
const CHECKPOINT_MARKER_PREFIX = "u7:restored-sql:";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type ControlPlaneMigrationPersistenceOptions = Readonly<{
  identity: ControlPlaneStoreIdentity;
  dialect: ControlPlaneTransactionalDialect;
  nodeId?: string | undefined;
  migrationLeaseMs?: number | undefined;
}>;

export type ControlPlaneMigrationElection = Readonly<{
  tryElect(): Promise<LegacyMigrationElectionLease | undefined>;
}>;

export type ControlPlaneRestorePersistence = Readonly<{
  readRestoreJournal(restoreId: string): Promise<NormalRestoreJournal>;
  beginRestore(
    input: Readonly<{
      restoreId: string;
      backupId: string;
      fenceToken: string;
    }>,
  ): Promise<void>;
  writeInactiveCandidate(
    input: Readonly<{
      restoreId: string;
      fenceToken: string;
      candidate: RestorableControlPlaneState;
      expectedAuthorityGeneration: number;
      operationRecovery: RestoreOperationRecoveryEvidence;
    }>,
  ): Promise<void>;
  readInactiveCandidate(
    restoreId: string,
    fenceToken: string,
  ): Promise<DurableInactiveRestoreCandidate | undefined>;
  verifyInactiveCandidate(
    restoreId: string,
    fenceToken: string,
    candidate: DurableInactiveRestoreCandidate,
  ): Promise<void>;
  activateInactiveCandidate(
    input: Readonly<{
      restoreId: string;
      fenceToken: string;
      confirmation: NormalRestoreConfirmation;
      candidate: DurableInactiveRestoreCandidate;
    }>,
  ): Promise<"activated" | "confirmation-invalid" | "conflict">;
  journalAbortPhase(
    restoreId: string,
    fenceToken: string,
    phase: NormalRestoreAbortPhase | "completed",
  ): Promise<void>;
  discardInactiveStage(restoreId: string, fenceToken: string): Promise<void>;
}>;

export type ControlPlaneCatastrophicPersistence = Readonly<{
  writeSelectedCheckpoint(
    input: Readonly<{
      checkpoint: AuthenticatedRecoveryCheckpoint;
      descriptor: RecoveryDescriptor;
    }>,
  ): Promise<void>;
  readSelectedCheckpoint(generation: number): Promise<
    | Readonly<{
        checkpoint: AuthenticatedRecoveryCheckpoint;
        descriptor: RecoveryDescriptor;
      }>
    | undefined
  >;
  writeRestoredSqlMarker(marker: RestoredSqlMarker): Promise<void>;
  readRestoredSqlMarker(recoveryId: string): Promise<RestoredSqlMarker | undefined>;
}>;

export type ControlPlaneMigrationPersistence = Readonly<{
  legacyDestination: LegacyInitializationDestination;
  election: ControlPlaneMigrationElection;
  recoveryBackupLifecycle: RecoveryBackupLifecyclePort;
  backupLifecycle: BackupLifecycleLedgerPort;
  restore: ControlPlaneRestorePersistence;
  catastrophic: ControlPlaneCatastrophicPersistence;
}>;

type VersionState = Readonly<{
  authorityGeneration: number;
  effectiveGeneration: number;
  securityEpoch: number;
}>;

type MigrationStateDocument = Readonly<{
  version: 1;
  kind: "legacy-initialization";
  migrationId: string;
  fencingToken: number;
  metadata: LegacyMigrationMetadata;
  step: "begun" | "staged" | "invalidated" | "verified" | "activated" | "finalized";
  entities: readonly unknown[];
  baseline: VersionState;
  invalidated?: VersionState | undefined;
  verification?: Readonly<{
    manifestSha256: string;
    protectedRecordCommitments: readonly string[];
    protectedBundleId?: string | undefined;
    exclusionCleanupId?: string | undefined;
  }>;
  activation?: Readonly<{ activationId: string; authorityToken: string }>;
}>;

type ElectionStateDocument = Readonly<{
  version: 1;
  kind: "migration-election";
  fencingToken: number;
  ownerNodeId: string;
  expiresAt: string;
  releasedAt?: string | undefined;
}>;

type BackupStateDocument = Readonly<{
  version: 1;
  kind: "backup-state";
  intent?: RecoveryBackupIntent | undefined;
  inventory?: BackupInventoryRecord | undefined;
}>;

type BackupInventoryDocument = Readonly<{
  version: 1;
  kind: "backup-inventory";
  snapshot: BackupInventorySnapshot;
}>;

type DestructionDocument =
  | Readonly<{ version: 1; kind: "destruction-preview"; preview: BackupDestructionPreviewRecord }>
  | Readonly<{ version: 1; kind: "destruction-intent"; intent: BackupDestructionIntent }>;

type RestoreDocument = Readonly<{
  version: 1;
  kind: "normal-restore";
  restoreId: string;
  backupId: string;
  fenceToken: string;
  journal: NormalRestoreJournal;
  baseline: VersionState;
}>;

type CheckpointDocument = Readonly<{
  version: 1;
  kind: "selected-checkpoint";
  checkpoint: AuthenticatedRecoveryCheckpoint;
  descriptor: RecoveryDescriptor;
}>;

type MarkerDocument = Readonly<{
  version: 1;
  kind: "restored-sql-marker";
  marker: RestoredSqlMarker;
}>;

type MigrationRow = ControlPlaneDatabaseRow & {
  id: string;
  migrationId: string;
  phase: "discovered" | "staged" | "verified" | "activated" | "finalized" | "rolled-back";
  checksum: string;
  stateDocument?: unknown;
  createdAt: string;
};
type BackupRow = ControlPlaneDatabaseRow & {
  id: string;
  backupId: string;
  providerIdentity: string;
  sourceIdentity: string;
  sourceProfile: string;
  manifestHash: string;
  keyVersion: number;
  keyPurpose: string;
  keyAlgorithm: string;
  unwrapIdentity: string;
  retentionUntil: string;
  state: string;
  destroyedAt?: string;
  destructionId?: string;
  stateDocument?: unknown;
  createdAt: string;
};
type DestructionRow = ControlPlaneDatabaseRow & {
  id: string;
  destructionId: string;
  phase: string;
  receipt?: unknown;
  createdAt: string;
};
type RecoveryRow = ControlPlaneDatabaseRow & {
  id: string;
  recoveryId: string;
  validationHash?: string;
  stateDocument?: unknown;
  createdAt: string;
};
type ConfirmationRow = ControlPlaneDatabaseRow & {
  id: string;
  confirmationId: string;
  action: string;
  authorityToken: string;
  inventoryHash: string;
  affectedInventory: unknown;
  expiresAt: string;
  consequences: string;
  state: string;
};
type CheckpointRow = ControlPlaneDatabaseRow & {
  id: string;
  checkpointId: string;
  authorityGeneration: number;
  stateDocument?: unknown;
  createdAt: string;
};
type GenerationRow = ControlPlaneDatabaseRow & {
  generation: number;
  effectiveVersion: number;
  bindingState?: string;
};
type SecurityGenerationRow = ControlPlaneDatabaseRow & { epoch: number };

const ENTITY_TABLES: Readonly<Record<ControlPlaneEntityKind, ControlPlaneTable>> = {
  "host-setting": "hostSettings",
  caplet: "caplets",
  "caplet-provenance": "capletProvenance",
  "operation-namespace": "operationNamespaces",
  "operation-reservation": "operationReservations",
  "operation-outcome": "operationOutcomes",
  "operation-tombstone": "operationTombstones",
  confirmation: "confirmations",
  "oauth-token": "oauthTokens",
  client: "clients",
  credential: "credentials",
  "pending-approval": "pendingApprovals",
  "dashboard-session": "dashboardSessions",
  "project-binding-workspace": "projectBindingWorkspaces",
  "project-binding-lease": "projectBindingLeases",
  "project-binding-receipt": "projectBindingReceipts",
  "vault-value": "vaultValues",
  "vault-grant": "vaultGrants",
  "operator-activity": "operatorActivities",
  "authority-version": "authorityVersions",
  "effective-version": "effectiveVersions",
  "security-version": "securityVersions",
  "key-inventory": "keyInventory",
  "key-canary": "keyCanaries",
  "cluster-node-lease": "clusterNodeLeases",
  "writer-fence": "writerFences",
  migration: "migrations",
  backup: "backups",
  recovery: "recoveries",
  retention: "retentions",
  "external-destruction": "externalDestructions",
  "recovery-checkpoint": "recoveryCheckpoints",
  quarantine: "quarantines",
};

export function createControlPlaneMigrationPersistence(
  options: ControlPlaneMigrationPersistenceOptions,
): ControlPlaneMigrationPersistence {
  const identity = options.identity;
  const dialect = options.dialect;
  const nodeId = options.nodeId ?? `${identity.logicalHostId}:${process.pid}`;
  const leaseMs = options.migrationLeaseMs ?? 30_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw persistenceError("Migration lease duration is invalid.");
  }

  const recoveryBackupLifecycle: RecoveryBackupLifecyclePort = {
    transaction<T>(work: (transaction: RecoveryBackupLifecycleTransaction) => Promise<T>) {
      return dialect.maintenanceTransaction(async (transaction) => {
        await transaction.lock(serialKey(identity, "backup-intents"));
        return work({
          async readBackupIntent(backupId) {
            const row = await readBackupRow(transaction, identity, backupId);
            if (!row) return undefined;
            const document = requireBackupDocument(row.stateDocument);
            return clone(document.intent);
          },
          async writeBackupIntent(intent) {
            assertBackupIntentIdentity(identity, intent);
            const existing = await readBackupRow(transaction, identity, intent.backupId);
            const document = existing
              ? requireBackupDocument(existing.stateDocument)
              : ({ version: 1, kind: "backup-state" } as const);
            if (document.intent) assertIntentAdvance(document.intent, intent);
            const now = await transaction.databaseTime();
            await writeBackupRow(transaction, identity, now, intent.backupId, {
              ...document,
              intent: canonical(intent),
            });
          },
        });
      });
    },
  };

  const backupLifecycle: BackupLifecycleLedgerPort = {
    transaction<T>(work: (transaction: BackupLifecycleTransaction) => Promise<T>) {
      return dialect.maintenanceTransaction(async (transaction) => {
        await transaction.lock(serialKey(identity, "backup-ledger"));
        return work({
          async readAuthorityToken() {
            const versions = await readVersions(transaction, identity);
            return {
              authorityGeneration: versions.authorityGeneration,
              effectiveGeneration: versions.effectiveGeneration,
            };
          },
          async readInventory() {
            return readInventory(transaction, identity);
          },
          async writeInventory(snapshot) {
            assertInventoryIdentity(identity, snapshot);
            const prior = await readInventory(transaction, identity);
            if (
              snapshot.version < prior.version ||
              snapshot.purgeWatermark < prior.purgeWatermark
            ) {
              throw persistenceError("Backup inventory cannot regress.");
            }
            if (snapshot.version === prior.version && !isDeepStrictEqual(snapshot, prior)) {
              throw persistenceError("Backup inventory version conflicts.");
            }
            const priorById = new Map(prior.records.map((record) => [record.backupId, record]));
            const nextById = new Map(snapshot.records.map((record) => [record.backupId, record]));
            if (nextById.size !== snapshot.records.length) {
              throw persistenceError("Backup inventory contains duplicate records.");
            }
            for (const [backupId, priorRecord] of priorById) {
              const nextRecord = nextById.get(backupId);
              if (!nextRecord)
                throw persistenceError("Backup inventory cannot drop physical records.");
              assertInventoryRecordAdvance(priorRecord, nextRecord);
            }
            const now = await transaction.databaseTime();
            await writeInventoryRow(transaction, identity, now, snapshot);
            for (const record of snapshot.records) {
              const existing = await readBackupRow(transaction, identity, record.backupId);
              const document = existing?.stateDocument
                ? requireBackupDocument(existing.stateDocument)
                : ({ version: 1, kind: "backup-state" } as const);
              if (document.inventory) assertInventoryRecordAdvance(document.inventory, record);
              await writeBackupRow(transaction, identity, now, record.backupId, {
                ...document,
                inventory: canonical(record),
              });
            }
          },
          async readDestructionPreview(tokenId) {
            const row = await readDestructionRow(transaction, identity, `preview:${tokenId}`);
            if (!row) return undefined;
            const document = requireDestructionDocument(row.receipt);
            if (document.kind !== "destruction-preview")
              throw persistenceError("Destruction preview row is malformed.");
            return clone(document.preview);
          },
          async writeDestructionPreview(preview) {
            assertPreviewIdentity(identity, preview);
            const now = await transaction.databaseTime();
            const id = `preview:${preview.token.tokenId}`;
            const existing = await readDestructionRow(transaction, identity, id);
            if (existing) {
              const document = requireDestructionDocument(existing.receipt);
              if (document.kind !== "destruction-preview")
                throw persistenceError("Destruction preview row conflicts.");
              if (document.preview.consumedAt && !preview.consumedAt) {
                throw persistenceError("Consumed destruction preview cannot regress.");
              }
            }
            await writeDestructionRow(transaction, identity, now, id, "intended", {
              version: 1,
              kind: "destruction-preview",
              preview: canonical(preview),
            });
          },
          async readDestructionIntent(destructionId) {
            const row = await readDestructionRow(transaction, identity, destructionId);
            if (!row) return undefined;
            const document = requireDestructionDocument(row.receipt);
            if (document.kind !== "destruction-intent")
              throw persistenceError("Destruction intent row is malformed.");
            return clone(document.intent);
          },
          async writeDestructionIntent(intent) {
            assertDestructionIntentIdentity(identity, intent);
            const existing = await readDestructionRow(transaction, identity, intent.destructionId);
            if (existing) {
              const document = requireDestructionDocument(existing.receipt);
              if (document.kind !== "destruction-intent")
                throw persistenceError("Destruction intent row conflicts.");
              assertDestructionAdvance(document.intent, intent);
            }
            const now = await transaction.databaseTime();
            await writeDestructionRow(
              transaction,
              identity,
              now,
              intent.destructionId,
              intent.phase === "completed"
                ? "completed"
                : intent.phase === "confirmed"
                  ? "confirmed"
                  : "in-progress",
              { version: 1, kind: "destruction-intent", intent: canonical(intent) },
            );
          },
        });
      });
    },
  };

  const legacyDestination = createLegacyDestination(options);
  const election = createMigrationElection(options, nodeId, leaseMs);
  const restore = createRestorePersistence(options);
  const catastrophic = createCatastrophicPersistence(options);
  return {
    legacyDestination,
    election,
    recoveryBackupLifecycle,
    backupLifecycle,
    restore,
    catastrophic,
  };
}

function createMigrationElection(
  options: ControlPlaneMigrationPersistenceOptions,
  nodeId: string,
  leaseMs: number,
): ControlPlaneMigrationElection {
  const { identity, dialect } = options;
  return {
    async tryElect() {
      const elected = await dialect.maintenanceTransaction(async (transaction) => {
        await transaction.lock(serialKey(identity, "migration-election"));
        const now = await transaction.databaseTime();
        const row = await readMigrationRow(transaction, identity, ELECTION_ROW_ID);
        const prior = row ? requireElectionDocument(row.stateDocument) : undefined;
        if (prior && !prior.releasedAt && Date.parse(prior.expiresAt) > Date.parse(now))
          return undefined;
        const fencingToken = (prior?.fencingToken ?? 0) + 1;
        if (!Number.isSafeInteger(fencingToken))
          throw persistenceError("Migration fencing token exhausted.");
        const document: ElectionStateDocument = {
          version: 1,
          kind: "migration-election",
          fencingToken,
          ownerNodeId: nodeId,
          expiresAt: addMilliseconds(now, leaseMs),
        };
        await writeMigrationRow(
          transaction,
          identity,
          now,
          ELECTION_ROW_ID,
          "discovered",
          ZERO_HASH,
          document,
        );
        return document;
      });
      if (!elected) return undefined;
      return {
        fencingToken: elected.fencingToken,
        async renew() {
          return options.dialect.maintenanceTransaction(async (transaction) => {
            await transaction.lock(serialKey(identity, "migration-election"));
            const now = await transaction.databaseTime();
            const row = await readMigrationRow(transaction, identity, ELECTION_ROW_ID);
            if (!row) return false;
            const current = requireElectionDocument(row.stateDocument);
            if (
              current.fencingToken !== elected.fencingToken ||
              current.ownerNodeId !== nodeId ||
              current.releasedAt ||
              Date.parse(current.expiresAt) <= Date.parse(now)
            )
              return false;
            await writeMigrationRow(
              transaction,
              identity,
              now,
              ELECTION_ROW_ID,
              "discovered",
              ZERO_HASH,
              {
                ...current,
                expiresAt: addMilliseconds(now, leaseMs),
              },
            );
            return true;
          });
        },
        async release() {
          await options.dialect.maintenanceTransaction(async (transaction) => {
            await transaction.lock(serialKey(identity, "migration-election"));
            const now = await transaction.databaseTime();
            const row = await readMigrationRow(transaction, identity, ELECTION_ROW_ID);
            if (!row) return;
            const current = requireElectionDocument(row.stateDocument);
            if (current.fencingToken !== elected.fencingToken || current.ownerNodeId !== nodeId)
              return;
            await writeMigrationRow(
              transaction,
              identity,
              now,
              ELECTION_ROW_ID,
              "rolled-back",
              ZERO_HASH,
              {
                ...current,
                expiresAt: now,
                releasedAt: now,
              },
            );
          });
        },
      };
    },
  };
}

function createLegacyDestination(
  options: ControlPlaneMigrationPersistenceOptions,
): LegacyInitializationDestination {
  const { identity, dialect } = options;
  const withState = async <T>(
    operation: LegacyDestinationOperation,
    work: (
      transaction: ControlPlaneSqlTransaction,
      row: MigrationRow,
      state: MigrationStateDocument,
      now: string,
    ) => Promise<T>,
  ): Promise<T> =>
    dialect.maintenanceTransaction(async (transaction) => {
      await transaction.lock(serialKey(identity, `migration:${operation.migrationId}`));
      await assertElectionFence(transaction, identity, operation);
      const now = await transaction.databaseTime();
      const row = await readMigrationRow(transaction, identity, operation.migrationId);
      if (!row) throw persistenceError("Migration journal is missing.");
      const state = requireMigrationDocument(row.stateDocument);
      assertOperation(state, operation);
      return work(transaction, row, state, now);
    });
  return {
    backend: dialect.backend,
    async inspect(operation) {
      return dialect.maintenanceTransaction(async (transaction) => {
        await transaction.lock(serialKey(identity, `migration:${operation.migrationId}`));
        await assertElectionFence(transaction, identity, operation);
        const row = await readMigrationRow(transaction, identity, operation.migrationId);
        if (!row) return { state: "empty" } as const;
        let document = requireMigrationDocument(row.stateDocument);
        if (document.step !== "finalized" && document.fencingToken !== operation.fencingToken) {
          const now = await transaction.databaseTime();
          document = { ...document, fencingToken: operation.fencingToken };
          await writeMigrationRow(
            transaction,
            identity,
            now,
            operation.migrationId,
            row.phase,
            document.metadata.manifestSha256,
            document,
            row.phase === "activated" ? now : undefined,
          );
        }
        if (document.step !== "finalized") assertOperation(document, operation);
        return {
          state:
            document.step === "finalized"
              ? "finalized"
              : document.step === "activated"
                ? "active"
                : "inactive",
          metadata: clone(document.metadata),
        } as const;
      });
    },
    async assertCanInitialize({ operation, metadata }) {
      await dialect.maintenanceTransaction(async (transaction) => {
        await transaction.lock(serialKey(identity, "migration-destination"));
        await assertElectionFence(transaction, identity, operation);
        const rows = await transaction.select<MigrationRow>("migrations", scope(identity));
        const competing = rows.find(
          (row) =>
            row.migrationId !== ELECTION_ROW_ID &&
            row.migrationId !== operation.migrationId &&
            row.phase !== "rolled-back",
        );
        if (competing) throw persistenceError("Migration destination is not empty.");
        const existing = rows.find((row) => row.migrationId === operation.migrationId);
        if (existing) {
          const document = requireMigrationDocument(existing.stateDocument);
          if (!isDeepStrictEqual(document.metadata, canonical(metadata))) {
            throw persistenceError("Migration metadata conflicts with durable journal.");
          }
          return;
        }
        await assertDestinationBootstrapOnly(transaction, identity);
      });
    },
    async beginInactive({ operation, metadata }) {
      await dialect.maintenanceTransaction(async (transaction) => {
        await transaction.lock(serialKey(identity, "migration-destination"));
        await assertElectionFence(transaction, identity, operation);
        const now = await transaction.databaseTime();
        const existing = await readMigrationRow(transaction, identity, operation.migrationId);
        if (existing) throw persistenceError("Migration journal already exists.");
        const baseline = await readVersions(transaction, identity);
        const document: MigrationStateDocument = {
          version: 1,
          kind: "legacy-initialization",
          migrationId: operation.migrationId,
          fencingToken: operation.fencingToken,
          metadata: canonical(metadata),
          step: "begun",
          entities: [],
          baseline,
        };
        await writeMigrationRow(
          transaction,
          identity,
          now,
          operation.migrationId,
          "staged",
          metadata.manifestSha256,
          document,
        );
      });
    },
    async stageEntity({ operation, entity }) {
      await withState(operation, async (transaction, _row, state, now) => {
        if (state.step !== "begun")
          throw persistenceError("Migration is not accepting staged entities.");
        await stageLegacyEntity(transaction, identity, operation, entity, now);
        await writeMigrationRow(
          transaction,
          identity,
          now,
          operation.migrationId,
          "staged",
          state.metadata.manifestSha256,
          {
            ...state,
            entities: [...state.entities, canonical(entity)],
          },
        );
      });
    },
    async commitInactive(operation) {
      await withState(operation, async (transaction, _row, state, now) => {
        if (state.step !== "begun")
          throw persistenceError("Migration inactive commit is out of order.");
        await writeMigrationRow(
          transaction,
          identity,
          now,
          operation.migrationId,
          "staged",
          state.metadata.manifestSha256,
          { ...state, step: "staged" },
        );
      });
    },
    async invalidateAuthority(operation) {
      await withState(operation, async (transaction, _row, state, now) => {
        if (state.step !== "staged")
          throw persistenceError("Migration invalidation is out of order.");
        const current = await readVersions(transaction, identity);
        if (!isDeepStrictEqual(current, state.baseline))
          throw persistenceError("Migration authority fence changed before invalidation.");
        const invalidated = {
          authorityGeneration: nextGeneration(current.authorityGeneration),
          effectiveGeneration: current.effectiveGeneration,
          securityEpoch: nextGeneration(current.securityEpoch),
        };
        await insertAuthorityVersion(transaction, identity, now, invalidated, "inactive");
        await insertSecurityVersion(transaction, identity, now, invalidated);
        await writeMigrationRow(
          transaction,
          identity,
          now,
          operation.migrationId,
          "staged",
          state.metadata.manifestSha256,
          { ...state, step: "invalidated", invalidated },
        );
      });
    },
    async verifyInactive({ operation, source, protectedRecords }) {
      await withState(operation, async (transaction, _row, state, now) => {
        if (state.step !== "invalidated" || !state.invalidated)
          throw persistenceError("Migration verification is out of order.");
        assertLegacyReadback(state, source, protectedRecords);
        const current = await readVersions(transaction, identity);
        if (!isDeepStrictEqual(current, state.invalidated))
          throw persistenceError("Migration authority fence changed before verification.");
        const verification = {
          manifestSha256: source.manifestSha256,
          protectedRecordCommitments: protectedRecords.map(
            (record) => record.protection.commitment,
          ),
          ...(state.metadata.kind === "legacy"
            ? {
                protectedBundleId: state.metadata.protectedBundleId,
                exclusionCleanupId: state.metadata.exclusionCleanupId,
              }
            : {}),
        };
        await writeMigrationRow(
          transaction,
          identity,
          now,
          operation.migrationId,
          "verified",
          state.metadata.manifestSha256,
          { ...state, step: "verified", verification },
        );
      });
    },
    async activateAuthority({ operation, metadata }) {
      return withState(operation, async (transaction, _row, state, now) => {
        if (
          state.step !== "verified" ||
          !state.invalidated ||
          !isDeepStrictEqual(state.metadata, canonical(metadata))
        ) {
          throw persistenceError("Migration activation does not match the verified journal.");
        }
        const current = await readVersions(transaction, identity);
        if (!isDeepStrictEqual(current, state.invalidated))
          throw persistenceError("Migration authority fence changed before activation.");
        const authorityToken = authorityTokenText(current);
        await updateAuthorityBinding(
          transaction,
          identity,
          current.authorityGeneration,
          now,
          "active",
          authorityToken,
        );
        await writeMigrationRow(
          transaction,
          identity,
          now,
          operation.migrationId,
          "activated",
          metadata.manifestSha256,
          {
            ...state,
            step: "activated",
            activation: { activationId: metadata.activationId, authorityToken },
          },
          now,
        );
        return { authorityToken };
      });
    },
    async resolveActivation({ operation, activationId }) {
      return withState(operation, async (_transaction, _row, state) => {
        if (state.step !== "activated" && state.step !== "finalized")
          return { status: "not-activated" } as const;
        if (!state.activation || state.activation.activationId !== activationId)
          return { status: "not-activated" } as const;
        return { status: "activated", authorityToken: state.activation.authorityToken } as const;
      });
    },
    async finalize({ operation, metadata }) {
      await withState(operation, async (transaction, _row, state, now) => {
        if (
          state.step !== "activated" ||
          !state.activation ||
          !isDeepStrictEqual(state.metadata, canonical(metadata))
        ) {
          throw persistenceError("Migration finalization does not match activation.");
        }
        await writeMigrationRow(
          transaction,
          identity,
          now,
          operation.migrationId,
          "finalized",
          metadata.manifestSha256,
          { ...state, step: "finalized" },
          now,
        );
      });
    },
    async abortInactive(operation) {
      await withState(operation, async (transaction, _row, state) => {
        if (state.step === "activated" || state.step === "finalized")
          throw persistenceError("Activated migration cannot be aborted.");
        const current = await readVersions(transaction, identity);
        if (state.invalidated && !isDeepStrictEqual(current, state.invalidated))
          throw persistenceError("Migration authority fence changed before abort.");
        for (const staged of [...state.entities].reverse()) {
          await deleteStagedLegacyEntity(transaction, identity, operation, staged);
        }
        if (state.invalidated) {
          await transaction.delete(
            "authorityVersions",
            scope(identity, {
              generation: state.invalidated.authorityGeneration,
              bindingState: "inactive",
            }),
          );
          await transaction.delete(
            "securityVersions",
            scope(identity, {
              epoch: state.invalidated.securityEpoch,
            }),
          );
        }
        await transaction.delete("migrations", scope(identity, { id: operation.migrationId }));
      });
    },
  };
}

function createRestorePersistence(
  options: ControlPlaneMigrationPersistenceOptions,
): ControlPlaneRestorePersistence {
  const { identity, dialect } = options;
  return {
    async readRestoreJournal(restoreId) {
      return dialect.maintenanceTransaction(async (transaction) => {
        const row = await readRecoveryRow(transaction, identity, restoreId);
        return row
          ? clone(requireRestoreDocument(row.stateDocument).journal)
          : { status: "absent" };
      });
    },
    async beginRestore({ restoreId, backupId, fenceToken }) {
      await dialect.maintenanceTransaction(async (transaction) => {
        await transaction.lock(serialKey(identity, `restore:${restoreId}`));
        await transaction.lock(serialKey(identity, "backup-ledger"));
        const now = await transaction.databaseTime();
        if (await readRecoveryRow(transaction, identity, restoreId))
          throw persistenceError("Restore journal already exists.");
        const inventory = await readInventory(transaction, identity);
        if (!inventory.records.some((record) => record.backupId === backupId)) {
          throw persistenceError("Restore backup is not inventoried.");
        }
        const baseline = await readVersions(transaction, identity);
        await writeRecoveryRow(
          transaction,
          identity,
          now,
          restoreId,
          backupId,
          "staged",
          baseline.authorityGeneration,
          {
            version: 1,
            kind: "normal-restore",
            restoreId,
            backupId,
            fenceToken,
            journal: { status: "staged" },
            baseline,
          },
        );
      });
    },
    async writeInactiveCandidate(input) {
      await dialect.maintenanceTransaction(async (transaction) => {
        await transaction.lock(serialKey(identity, `restore:${input.restoreId}`));
        const now = await transaction.databaseTime();
        const row = await requireRecoveryRow(transaction, identity, input.restoreId);
        const document = requireRestoreDocument(row.stateDocument);
        assertRestoreFence(document, input.fenceToken);
        if (document.journal.status !== "staged")
          throw persistenceError("Restore candidate is out of order.");
        assertRestoreIdentity(identity, input.candidate);
        const current = await readVersions(transaction, identity);
        if (
          current.authorityGeneration !== input.expectedAuthorityGeneration ||
          !isDeepStrictEqual(current, document.baseline)
        ) {
          throw persistenceError("Restore authority fence is stale.");
        }
        assertOperationRecoveryIdentity(identity, input.operationRecovery);
        const persistenceToken = hashCanonical({
          restoreId: input.restoreId,
          fenceToken: input.fenceToken,
          candidate: input.candidate,
          expectedAuthorityGeneration: input.expectedAuthorityGeneration,
          operationRecovery: input.operationRecovery,
          baseline: document.baseline,
        });
        const candidate: DurableInactiveRestoreCandidate = {
          state: canonical(input.candidate),
          expectedAuthorityGeneration: input.expectedAuthorityGeneration,
          operationRecovery: canonical(input.operationRecovery),
          persistenceToken,
        };
        await writeRecoveryRow(
          transaction,
          identity,
          now,
          input.restoreId,
          document.backupId,
          "candidate-durable",
          input.expectedAuthorityGeneration,
          {
            ...document,
            journal: { status: "candidate-durable", candidate },
          },
        );
      });
    },
    async readInactiveCandidate(restoreId, fenceToken) {
      return dialect.maintenanceTransaction(async (transaction) => {
        const row = await readRecoveryRow(transaction, identity, restoreId);
        if (!row) return undefined;
        const document = requireRestoreDocument(row.stateDocument);
        assertRestoreFence(document, fenceToken);
        return document.journal.status === "candidate-durable"
          ? clone(document.journal.candidate)
          : undefined;
      });
    },
    async verifyInactiveCandidate(restoreId, fenceToken, candidate) {
      await dialect.maintenanceTransaction(async (transaction) => {
        await transaction.lock(serialKey(identity, `restore:${restoreId}`));
        const row = await requireRecoveryRow(transaction, identity, restoreId);
        const document = requireRestoreDocument(row.stateDocument);
        assertRestoreFence(document, fenceToken);
        if (
          document.journal.status !== "candidate-durable" ||
          !isDeepStrictEqual(document.journal.candidate, canonical(candidate))
        ) {
          throw persistenceError("Restore candidate does not match durable readback.");
        }
        assertCandidateToken(restoreId, fenceToken, document, candidate);
        assertRestoreIdentity(identity, candidate.state);
        assertOperationRecoveryIdentity(identity, candidate.operationRecovery);
        await assertBackupReadback(transaction, identity, candidate.state.lifecycle.backups);
      });
    },
    async activateInactiveCandidate(input) {
      return dialect.maintenanceTransaction(async (transaction) => {
        await transaction.lock(serialKey(identity, "authority-generation"));
        await transaction.lock(serialKey(identity, `restore:${input.restoreId}`));
        await transaction.lock(serialKey(identity, `confirmation:${input.confirmation.token}`));
        const now = await transaction.databaseTime();
        const row = await requireRecoveryRow(transaction, identity, input.restoreId);
        const document = requireRestoreDocument(row.stateDocument);
        assertRestoreFence(document, input.fenceToken);
        if (document.journal.status !== "candidate-durable") return "conflict";
        if (!isDeepStrictEqual(document.journal.candidate, canonical(input.candidate)))
          return "conflict";
        const confirmationRow = await readConfirmationRow(
          transaction,
          identity,
          input.confirmation.token,
        );
        try {
          assertCandidateToken(input.restoreId, input.fenceToken, document, input.candidate);
          assertRestoreConfirmation(
            identity,
            input.restoreId,
            document.backupId,
            input.confirmation,
            input.candidate,
          );
          assertDurableRestoreConfirmation(document, input.confirmation, confirmationRow, now);
          await assertBackupReadback(
            transaction,
            identity,
            input.confirmation.completeBackupInventory,
          );
        } catch {
          return "confirmation-invalid";
        }
        const current = await readVersions(transaction, identity);
        const candidateState = input.candidate.state;
        if (
          current.authorityGeneration !== input.candidate.expectedAuthorityGeneration ||
          candidateState.authorityGeneration <= current.authorityGeneration ||
          candidateState.securityEpoch <= current.securityEpoch
        )
          return "conflict";
        const consumed = await transaction.update(
          "confirmations",
          { state: "consumed", consumedAt: now, updatedAt: now },
          scope(identity, {
            id: input.confirmation.token,
            confirmationId: input.confirmation.token,
            state: "previewed",
          }),
        );
        if (consumed !== 1) return "confirmation-invalid";
        const activatedVersions = {
          authorityGeneration: candidateState.authorityGeneration,
          effectiveGeneration: candidateState.effectiveGeneration,
          securityEpoch: candidateState.securityEpoch,
        };
        await stageRestoreOperationEvidence(
          transaction,
          identity,
          now,
          activatedVersions,
          input.candidate.operationRecovery,
        );
        await verifyRestoreOperationEvidence(
          transaction,
          identity,
          input.candidate.operationRecovery,
        );
        await insertAuthorityVersion(transaction, identity, now, activatedVersions, "active");
        await insertSecurityVersion(transaction, identity, now, activatedVersions);
        await writeRecoveryRow(
          transaction,
          identity,
          now,
          input.restoreId,
          document.backupId,
          "activated",
          candidateState.authorityGeneration,
          {
            ...document,
            journal: { status: "activated", candidate: canonical(candidateState) },
          },
          now,
        );
        return "activated";
      });
    },
    async journalAbortPhase(restoreId, fenceToken, phase) {
      await dialect.maintenanceTransaction(async (transaction) => {
        await transaction.lock(serialKey(identity, `restore:${restoreId}`));
        const now = await transaction.databaseTime();
        const row = await requireRecoveryRow(transaction, identity, restoreId);
        const document = requireRestoreDocument(row.stateDocument);
        assertRestoreFence(document, fenceToken);
        const journal: NormalRestoreJournal =
          phase === "completed"
            ? document.journal.status === "activated"
              ? { status: "completed", candidate: document.journal.candidate }
              : { status: "aborting", phase: "fence-release-pending" }
            : { status: "aborting", phase };
        await writeRecoveryRow(
          transaction,
          identity,
          now,
          restoreId,
          document.backupId,
          phase === "completed" ? "completed" : "aborting",
          document.baseline.authorityGeneration,
          { ...document, journal },
        );
      });
    },
    async discardInactiveStage(restoreId, fenceToken) {
      await dialect.maintenanceTransaction(async (transaction) => {
        await transaction.lock(serialKey(identity, `restore:${restoreId}`));
        const row = await requireRecoveryRow(transaction, identity, restoreId);
        const document = requireRestoreDocument(row.stateDocument);
        assertRestoreFence(document, fenceToken);
        if (document.journal.status === "activated" || document.journal.status === "completed") {
          throw persistenceError("Activated restore candidate cannot be discarded.");
        }
        await transaction.delete("recoveries", scope(identity, { id: restoreId }));
      });
    },
  };
}

function createCatastrophicPersistence(
  options: ControlPlaneMigrationPersistenceOptions,
): ControlPlaneCatastrophicPersistence {
  const { identity, dialect } = options;
  return {
    async writeSelectedCheckpoint({ checkpoint, descriptor }) {
      await dialect.maintenanceTransaction(async (transaction) => {
        await transaction.lock(serialKey(identity, "recovery-checkpoint"));
        const now = await transaction.databaseTime();
        assertSelectedCheckpoint(identity, checkpoint, descriptor);
        const [latest] = await transaction.select<CheckpointRow>(
          "recoveryCheckpoints",
          scope(identity, { replacementReason: "selected" }),
          [{ column: "authorityGeneration", direction: "desc" }],
          1,
        );
        if (latest) {
          const prior = requireCheckpointDocument(latest.stateDocument);
          if (prior.descriptor.generation > descriptor.generation)
            throw persistenceError("Recovery checkpoint generation cannot regress.");
          if (prior.descriptor.generation === descriptor.generation) {
            if (
              !isDeepStrictEqual(
                prior,
                canonical({ version: 1, kind: "selected-checkpoint", checkpoint, descriptor }),
              )
            ) {
              throw persistenceError("Recovery checkpoint generation conflicts.");
            }
            return;
          }
          if (checkpoint.payload.priorRecordDigest !== prior.checkpoint.digest) {
            throw persistenceError("Recovery checkpoint chain is discontinuous.");
          }
        } else if (checkpoint.payload.priorRecordDigest !== null) {
          throw persistenceError("First persisted recovery checkpoint must begin a chain.");
        }
        const document: CheckpointDocument = {
          version: 1,
          kind: "selected-checkpoint",
          checkpoint: canonical(checkpoint),
          descriptor: canonical(descriptor),
        };
        await writeCheckpointRow(
          transaction,
          identity,
          now,
          String(descriptor.generation),
          descriptor.generation,
          descriptor.checkpointDigest,
          "selected",
          document,
        );
      });
    },
    async readSelectedCheckpoint(generation) {
      return dialect.maintenanceTransaction(async (transaction) => {
        const row = await readCheckpointRow(transaction, identity, String(generation));
        if (!row) return undefined;
        const document = requireCheckpointDocument(row.stateDocument);
        assertSelectedCheckpoint(identity, document.checkpoint, document.descriptor);
        return { checkpoint: clone(document.checkpoint), descriptor: clone(document.descriptor) };
      });
    },
    async writeRestoredSqlMarker(marker) {
      await dialect.maintenanceTransaction(async (transaction) => {
        await transaction.lock(serialKey(identity, `restored-sql:${marker.recoveryId}`));
        const now = await transaction.databaseTime();
        assertMarkerIdentity(identity, marker);
        const checkpointId = `${CHECKPOINT_MARKER_PREFIX}${marker.recoveryId}`;
        const existing = await readCheckpointRow(transaction, identity, checkpointId);
        const document: MarkerDocument = {
          version: 1,
          kind: "restored-sql-marker",
          marker: canonical(marker),
        };
        if (
          existing &&
          !isDeepStrictEqual(requireMarkerDocument(existing.stateDocument), document)
        ) {
          throw persistenceError("Restored SQL marker conflicts with durable state.");
        }
        await writeCheckpointRow(
          transaction,
          identity,
          now,
          checkpointId,
          marker.descriptorGeneration,
          marker.descriptorDigest,
          "restored-sql-marker",
          document,
        );
      });
    },
    async readRestoredSqlMarker(recoveryId) {
      return dialect.maintenanceTransaction(async (transaction) => {
        const row = await readCheckpointRow(
          transaction,
          identity,
          `${CHECKPOINT_MARKER_PREFIX}${recoveryId}`,
        );
        if (!row) return undefined;
        const marker = requireMarkerDocument(row.stateDocument).marker;
        assertMarkerIdentity(identity, marker);
        return clone(marker);
      });
    },
  };
}

async function stageLegacyEntity(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  operation: LegacyDestinationOperation,
  entity: LegacyInitializationEntity,
  now: string,
): Promise<void> {
  if (entity.kind === "quarantine") {
    const value = entity.value;
    await transaction.insert("quarantines", {
      ...baseRow(
        identity,
        `quarantine:${operation.migrationId}:${value.recordIndex}`,
        now,
        await readVersions(transaction, identity),
      ),
      quarantineId: `quarantine:${operation.migrationId}:${value.recordIndex}`,
      sourceDomain: value.domain,
      sourcePath: value.sourcePath,
      rawDigest: value.rawDigest,
      reason: value.reason,
      observedAt: now,
      disposition: value.auditProvenance.disposition,
    });
    return;
  }
  const versions = await readVersions(transaction, identity);
  if (entity.kind === "tracked-caplet") {
    const { entry, installedHash } = entity.value;
    const provenanceId = `legacy-provenance:${entry.id}`;
    const common = baseRow(identity, entry.id, now, versions, entry.installedAt);
    const caplet = {
      ...common,
      updatedAt: entry.updatedAt,
      name: entry.id,
      description: `Migrated global Caplet at ${entry.destination}`,
      ownership: "global",
      activation: "active",
      effective: true,
      updateState: "current",
      portableAggregateId: entry.id,
      installationProvenanceId: provenanceId,
    };
    const provenance = {
      ...baseRow(identity, provenanceId, now, versions, entry.installedAt),
      updatedAt: entry.updatedAt,
      capletId: entry.id,
      sourceKind: entry.source.type,
      source: entry.source,
      contentHash: installedHash,
      ...(entry.runtimeFingerprint
        ? { runtimeFingerprint: entry.runtimeFingerprint.artifactFingerprint }
        : {}),
      installedAt: entry.installedAt,
      ...("resolvedRevision" in entry.source && entry.source.resolvedRevision
        ? { resolvedRevision: entry.source.resolvedRevision }
        : {}),
      riskSummary: entry.risk,
    };
    validateCanonicalEntityShape("caplet", caplet);
    validateCanonicalEntityShape("caplet-provenance", provenance);
    await transaction.insert("caplets", encodeCanonicalRow(transaction, "caplet", caplet));
    await transaction.insert(
      "capletProvenance",
      encodeCanonicalRow(transaction, "caplet-provenance", provenance),
    );
    return;
  }
  const canonicalRecord = entity.value.canonical;
  const table = ENTITY_TABLES[canonicalRecord.kind];
  const values = canonical({ ...canonicalRecord.identity, ...canonicalRecord.fields }) as Record<
    string,
    unknown
  >;
  for (const key of ["logicalHostId", "storeId"] as const) {
    if (typeof values[key] === "string" && values[key] !== identity[key]) {
      throw persistenceError("Legacy entity targets another store.");
    }
  }
  const semanticIdentity = stableJsonStringify(canonicalRecord.identity);
  const id =
    typeof values.id === "string" && values.id.length > 0
      ? values.id
      : `legacy:${canonicalRecord.kind}:${hashCanonical(semanticIdentity)}`;
  const row = {
    ...baseRow(identity, id, now, versions),
    ...values,
    modelVersion: canonicalRecord.modelVersion,
  };
  validateCanonicalEntityShape(canonicalRecord.kind, row);
  await transaction.insert(table, encodeCanonicalRow(transaction, canonicalRecord.kind, row));
}

async function readInventory(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
): Promise<BackupInventorySnapshot> {
  const row = await readBackupRow(transaction, identity, INVENTORY_ROW_ID);
  const prior = row
    ? requireInventoryDocument(row.stateDocument).snapshot
    : ({ version: 0, purgeWatermark: 0, records: [] } as const);
  assertInventoryIdentity(identity, prior);
  const physical = await transaction.select<BackupRow>("backups", scope(identity), [
    { column: "createdAt", direction: "asc" },
  ]);
  const records = [...prior.records];
  const known = new Set(records.map((record) => record.backupId));
  for (const backup of physical) {
    if (backup.backupId === INVENTORY_ROW_ID || known.has(backup.backupId)) continue;
    const imported = backup.stateDocument
      ? requireBackupDocument(backup.stateDocument).inventory
      : legacyBackupInventoryRecord(identity, backup);
    if (!imported) continue;
    records.push(imported);
    known.add(imported.backupId);
  }
  if (records.length === prior.records.length) return clone(prior);
  records.sort((left, right) => left.backupId.localeCompare(right.backupId));
  const snapshot: BackupInventorySnapshot = {
    version: nextGeneration(prior.version),
    purgeWatermark: prior.purgeWatermark,
    records,
  };
  assertInventoryIdentity(identity, snapshot);
  const now = await transaction.databaseTime();
  await writeInventoryRow(transaction, identity, now, snapshot);
  for (const record of records) {
    const backup = physical.find((candidate) => candidate.backupId === record.backupId);
    if (!backup || backup.stateDocument) continue;
    await writeBackupRow(transaction, identity, now, record.backupId, {
      version: 1,
      kind: "backup-state",
      inventory: record,
    });
  }
  return clone(snapshot);
}

async function writeInventoryRow(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  now: string,
  snapshot: BackupInventorySnapshot,
): Promise<void> {
  const versions = await readVersions(transaction, identity);
  const existing = await readBackupRow(transaction, identity, INVENTORY_ROW_ID);
  await upsert(transaction, "backups", identity, INVENTORY_ROW_ID, {
    ...baseRow(identity, INVENTORY_ROW_ID, now, versions, existing?.createdAt),
    backupId: INVENTORY_ROW_ID,
    providerIdentity: "internal-u7",
    sourceIdentity: `${identity.logicalHostId}:${identity.storeId}`,
    sourceProfile: "backup-inventory",
    manifestHash: hashCanonical(snapshot),
    keyVersion: 0,
    keyPurpose: "backup-recovery",
    keyAlgorithm: "inventory-only",
    unwrapIdentity: "none",
    retentionUntil: now,
    state: "inventory",
    stateDocument: databaseJson(transaction, {
      version: 1,
      kind: "backup-inventory",
      snapshot,
    } satisfies BackupInventoryDocument),
  });
}

async function writeBackupRow(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  now: string,
  backupId: string,
  document: BackupStateDocument,
): Promise<void> {
  const existing = await readBackupRow(transaction, identity, backupId);
  const rowId = existing?.id ?? backupId;
  const reference =
    document.inventory?.recoveryKeyReference ?? document.intent?.recoveryKeyReference;
  if (!reference) throw persistenceError("Backup durable state lacks a recovery-key reference.");
  const inventory = document.inventory;
  if (existing && inventory?.recoveryKeyReference.provider === "legacy-u6") {
    const legacyUpdate: Record<string, unknown> = {
      updatedAt: now,
      stateDocument: databaseJson(transaction, document),
    };
    if (inventory.state === "destroyed") {
      legacyUpdate.state = "destroyed";
      legacyUpdate.destroyedAt = inventory.destroyedAt;
      legacyUpdate.destructionId = inventory.destructionId;
    }
    const count = await transaction.update(
      "backups",
      legacyUpdate,
      scope(identity, { id: existing.id }),
    );
    if (count !== 1) throw persistenceError("Unexpected legacy backup import write count.");
    return;
  }
  const versions = await readVersions(transaction, identity);
  const intent = document.intent;
  await upsert(transaction, "backups", identity, rowId, {
    ...baseRow(identity, rowId, now, versions, existing?.createdAt),
    backupId,
    providerIdentity:
      inventory?.providerIdentity ?? intent?.providerIdentity ?? reference.providerIdentity,
    sourceIdentity: `${reference.logicalHostId}:${reference.storeId}`,
    sourceProfile: reference.profile,
    manifestHash: inventory?.bindingDigest ?? intent?.bindingDigest ?? ZERO_HASH,
    keyVersion: reference.keyVersion,
    keyPurpose: reference.purpose,
    keyAlgorithm: "provider-wrapped",
    unwrapIdentity: `${reference.provider}:${reference.keyId}`,
    retentionUntil: inventory?.retentionUntil ?? intent?.createdAt ?? now,
    state: inventory?.state ?? intent?.phase ?? "staged",
    ...(inventory?.destroyedAt ? { destroyedAt: inventory.destroyedAt } : {}),
    ...(inventory?.destructionId ? { destructionId: inventory.destructionId } : {}),
    stateDocument: databaseJson(transaction, document),
  });
}

async function writeDestructionRow(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  now: string,
  destructionId: string,
  phase: "intended" | "confirmed" | "in-progress" | "completed",
  document: DestructionDocument,
): Promise<void> {
  const existing = await readDestructionRow(transaction, identity, destructionId);
  const versions = await readVersions(transaction, identity);
  const preview = document.kind === "destruction-preview" ? document.preview : undefined;
  const intent = document.kind === "destruction-intent" ? document.intent : undefined;
  const target = preview?.target ?? intent?.target;
  const confirmationId = preview?.token.tokenId ?? intent?.confirmationId;
  if (!target || !confirmationId)
    throw persistenceError("Destruction durable state is incomplete.");
  await upsert(transaction, "externalDestructions", identity, destructionId, {
    ...baseRow(identity, destructionId, now, versions, existing?.createdAt),
    destructionId,
    providerIdentity: target.providerIdentity,
    phase,
    inventoryHash: preview?.inventoryHash ?? intent?.inventoryHash ?? ZERO_HASH,
    confirmationId,
    intent: stableJsonStringify(target),
    receipt: databaseJson(transaction, document),
    ...(intent?.receipt ? { completedAt: intent.receipt.completedAt } : {}),
  });
}

async function writeMigrationRow(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  now: string,
  migrationId: string,
  phase: "discovered" | "staged" | "verified" | "activated" | "finalized" | "rolled-back",
  manifestHash: string,
  stateDocument: MigrationStateDocument | ElectionStateDocument,
  activatedAt?: string,
): Promise<void> {
  const existing = await readMigrationRow(transaction, identity, migrationId);
  const versions = await readVersions(transaction, identity);
  await upsert(transaction, "migrations", identity, migrationId, {
    ...baseRow(identity, migrationId, now, versions, existing?.createdAt),
    migrationId,
    source:
      stateDocument.kind === "migration-election"
        ? "database-time-lease"
        : stateDocument.metadata.kind,
    destination: transaction.backend,
    phase,
    manifestHash,
    checksum: hashCanonical(stateDocument),
    compatibility: databaseJson(transaction, { schemaVersion: 3, backend: transaction.backend }),
    stateDocument: databaseJson(transaction, stateDocument),
    ...(activatedAt ? { activatedAt } : {}),
  });
}

async function writeRecoveryRow(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  now: string,
  recoveryId: string,
  backupId: string,
  phase: string,
  invalidatedAuthorityGeneration: number,
  stateDocument: RestoreDocument,
  activatedAt?: string,
): Promise<void> {
  const existing = await readRecoveryRow(transaction, identity, recoveryId);
  const versions = await readVersions(transaction, identity);
  await upsert(transaction, "recoveries", identity, recoveryId, {
    ...baseRow(identity, recoveryId, now, versions, existing?.createdAt),
    recoveryId,
    backupId,
    phase,
    invalidatedAuthorityGeneration,
    validationHash: hashCanonical(stateDocument),
    stateDocument: databaseJson(transaction, stateDocument),
    ...(activatedAt ? { activatedAt } : {}),
  });
}

async function writeCheckpointRow(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  now: string,
  checkpointId: string,
  generation: number,
  manifestHash: string,
  reason: string,
  stateDocument: CheckpointDocument | MarkerDocument,
): Promise<void> {
  const existing = await readCheckpointRow(transaction, identity, checkpointId);
  const versions = await readVersions(transaction, identity);
  await upsert(transaction, "recoveryCheckpoints", identity, checkpointId, {
    ...baseRow(identity, checkpointId, now, versions, existing?.createdAt),
    checkpointId,
    namespaceId: identity.operationNamespace,
    authorityGeneration: generation,
    manifestHash,
    replacementReason: reason,
    checkpointedAt: now,
    stateDocument: databaseJson(transaction, stateDocument),
  });
}

async function readMigrationRow(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  migrationId: string,
) {
  const [row] = await transaction.select<MigrationRow>(
    "migrations",
    scope(identity, { migrationId }),
    [],
    1,
  );
  if (row) requireCheckedMigrationDocument(row);
  return row;
}
async function readBackupRow(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  backupId: string,
) {
  const [row] = await transaction.select<BackupRow>(
    "backups",
    scope(identity, { backupId }),
    [],
    1,
  );
  return row;
}
async function readDestructionRow(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  destructionId: string,
) {
  const [row] = await transaction.select<DestructionRow>(
    "externalDestructions",
    scope(identity, { destructionId }),
    [],
    1,
  );
  return row;
}
async function readConfirmationRow(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  confirmationId: string,
): Promise<ConfirmationRow | undefined> {
  const [row] = await transaction.select<ConfirmationRow>(
    "confirmations",
    scope(identity, { confirmationId }),
    [],
    1,
  );
  return row;
}

function encodeCanonicalRow(
  transaction: ControlPlaneSqlTransaction,
  kind: ControlPlaneEntityKind,
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    canonicalFields(kind).flatMap((definition) => {
      const value = row[definition.name];
      if (value === undefined) return [];
      return [[definition.name, encodeCanonicalField(transaction, definition, value)]];
    }),
  );
}

function encodeCanonicalField(
  transaction: ControlPlaneSqlTransaction,
  definition: CanonicalFieldDefinition,
  value: unknown,
): unknown {
  if (definition.repeating || definition.type === "json") {
    const encoded = canonical(value);
    return transaction.backend === "sqlite" ? encodeCanonicalJson(encoded) : encoded;
  }
  if (definition.type === "bytes") return encodeCanonicalBytes(value as Uint8Array);
  if (definition.type === "timestamp") return encodeCanonicalTimestamp(value as string);
  if (definition.type === "version") return encodeCanonicalVersion(value as number);
  if (definition.type === "boolean" && transaction.backend === "sqlite") {
    return value ? 1 : 0;
  }
  return value;
}

function legacyBackupInventoryRecord(
  identity: ControlPlaneStoreIdentity,
  row: BackupRow,
): BackupInventoryRecord | undefined {
  if (
    !SHA256_PATTERN.test(row.manifestHash) ||
    !Number.isSafeInteger(row.keyVersion) ||
    row.keyVersion < 1 ||
    row.keyPurpose.length === 0 ||
    row.unwrapIdentity.length === 0
  ) {
    return undefined;
  }
  const provider = "legacy-u6";
  const keyId = hashCanonical({
    purpose: row.keyPurpose,
    unwrapIdentity: row.unwrapIdentity,
  });
  const state = row.destroyedAt ? "destroyed" : "finalized";
  return canonical({
    backupId: row.backupId,
    bindingDigest: row.manifestHash,
    headerDigest: row.manifestHash,
    terminalManifestDigest: row.manifestHash,
    wrappedKeyDigest: row.manifestHash,
    providerIdentity: row.providerIdentity,
    envelopeBytesReference: `legacy-sql://${row.backupId}/envelope`,
    wrappedKeyReference: `legacy-sql://${row.backupId}/wrapped-key`,
    recoveryKeyReference: {
      provider,
      providerIdentity: row.providerIdentity,
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      profile: row.sourceProfile,
      purpose: "backup-recovery",
      keyId,
      keyVersion: row.keyVersion,
    },
    createdAt: row.createdAt,
    retentionUntil: row.retentionUntil,
    state,
    finalizedAt: row.createdAt,
    ...(row.destroyedAt ? { destroyedAt: row.destroyedAt } : {}),
    ...(row.destructionId ? { destructionId: row.destructionId } : {}),
  }) as BackupInventoryRecord;
}

async function assertDestinationBootstrapOnly(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
): Promise<void> {
  const allowed = new Set<ControlPlaneTable>([
    "migrations",
    "operationNamespaces",
    "authorityVersions",
    "effectiveVersions",
    "securityVersions",
  ]);
  for (const table of new Set(Object.values(ENTITY_TABLES))) {
    if (allowed.has(table)) continue;
    if ((await transaction.select(table, scope(identity), [], 1)).length > 0) {
      throw persistenceError(`Migration destination contains authoritative ${table} rows.`);
    }
  }
  const bootstrapChecks: readonly [ControlPlaneTable, (row: ControlPlaneDatabaseRow) => boolean][] =
    [
      [
        "operationNamespaces",
        (row) =>
          row.id === "initial" &&
          row.namespaceId === identity.operationNamespace &&
          row.generation === 0 &&
          row.state === "active",
      ],
      [
        "authorityVersions",
        (row) =>
          row.id === "initial" &&
          row.generation === 0 &&
          row.effectiveVersion === 0 &&
          row.bindingState === "active",
      ],
      ["effectiveVersions", (row) => row.id === "initial" && row.generation === 0],
      ["securityVersions", (row) => row.id === "initial" && row.epoch === 0],
    ];
  for (const [table, valid] of bootstrapChecks) {
    const rows = await transaction.select(table, scope(identity));
    if (rows.length > 1 || (rows[0] && !valid(rows[0]))) {
      throw persistenceError(`Migration destination contains non-bootstrap ${table} rows.`);
    }
  }
}

async function deleteStagedLegacyEntity(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  operation: LegacyDestinationOperation,
  staged: unknown,
): Promise<void> {
  const entity = documentRecord(staged);
  if (entity.kind === "quarantine") {
    const value = documentRecord(entity.value);
    await transaction.delete(
      "quarantines",
      scope(identity, {
        id: `quarantine:${operation.migrationId}:${String(value.recordIndex)}`,
      }),
    );
    return;
  }
  if (entity.kind === "tracked-caplet") {
    const value = documentRecord(entity.value);
    const entry = documentRecord(value.entry);
    if (typeof entry.id !== "string") throw persistenceError("Staged tracked Caplet is malformed.");
    await transaction.delete(
      "capletProvenance",
      scope(identity, {
        id: `legacy-provenance:${entry.id}`,
      }),
    );
    await transaction.delete("caplets", scope(identity, { id: entry.id }));
    return;
  }
  if (entity.kind !== "legacy-record")
    throw persistenceError("Staged migration entity is malformed.");
  const value = documentRecord(entity.value);
  const canonicalRecord = documentRecord(value.canonical);
  if (typeof canonicalRecord.kind !== "string" || !(canonicalRecord.kind in ENTITY_TABLES)) {
    throw persistenceError("Staged canonical entity is malformed.");
  }
  const canonicalIdentity = documentRecord(canonicalRecord.identity);
  const fields = documentRecord(canonicalRecord.fields);
  const id =
    typeof fields.id === "string" && fields.id.length > 0
      ? fields.id
      : typeof canonicalIdentity.id === "string" && canonicalIdentity.id.length > 0
        ? canonicalIdentity.id
        : `legacy:${canonicalRecord.kind}:${hashCanonical(stableJsonStringify(canonicalIdentity))}`;
  await transaction.delete(
    ENTITY_TABLES[canonicalRecord.kind as ControlPlaneEntityKind],
    scope(identity, { id }),
  );
}

function assertDurableRestoreConfirmation(
  document: RestoreDocument,
  confirmation: NormalRestoreConfirmation,
  row: ConfirmationRow | undefined,
  now: string,
): void {
  if (
    !row ||
    row.id !== confirmation.token ||
    row.confirmationId !== confirmation.token ||
    row.action !== "normal-restore" ||
    row.state !== "previewed" ||
    row.authorityToken !== authorityTokenText(document.baseline) ||
    row.inventoryHash !== hashCanonical(confirmation.completeBackupInventory) ||
    row.consequences !== confirmation.consequencesCommitment ||
    Date.parse(row.expiresAt) <= Date.parse(now)
  ) {
    throw persistenceError("Restore confirmation is absent, stale, expired, or consumed.");
  }
  const stored = documentRecord(row.affectedInventory);
  if (
    stored.version !== 1 ||
    stored.kind !== "normal-restore-confirmation" ||
    !isDeepStrictEqual(stored.confirmation, canonical(confirmation))
  ) {
    throw persistenceError("Restore confirmation binding is invalid.");
  }
}

async function stageRestoreOperationEvidence(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  now: string,
  versions: VersionState,
  evidence: RestoreOperationRecoveryEvidence,
): Promise<void> {
  for (const binding of evidence.consumedBindings) {
    const terminal = evidence.terminalOutcomes.find((outcome) =>
      isDeepStrictEqual(outcome.binding, binding),
    );
    const outcomeRows = await transaction.select(
      "operationOutcomes",
      scope(identity, { operationId: binding.operationId }),
      [],
      1,
    );
    const tombstoneRows = await transaction.select(
      "operationTombstones",
      scope(identity, { operationId: binding.operationId }),
      [],
      1,
    );
    if (outcomeRows.length > 0 || tombstoneRows.length > 0) continue;
    const id = `operation:${binding.operationId}`;
    if (terminal?.disposition === "committed" && terminal.receipt) {
      await transaction.insert("operationOutcomes", {
        ...baseRow(identity, id, now, versions),
        operationId: binding.operationId,
        operationClass: binding.operationClass,
        requestHash: binding.requestIdentity,
        receiptHash: hashCanonical(terminal.receipt),
        receipt: databaseJson(transaction, terminal.receipt),
        resultAggregateVersion: 0,
        resultAuthorityVersion: versions.authorityGeneration,
        resultEffectiveVersion: versions.effectiveGeneration,
        convergenceClass: "restored-committed",
      });
    } else {
      await transaction.insert("operationTombstones", {
        ...baseRow(identity, id, now, versions),
        operationId: binding.operationId,
        namespaceId: binding.operationNamespace,
        target: databaseJson(transaction, { binding }),
        requestHash: binding.requestIdentity,
        reason:
          terminal?.disposition === "superseded" ? "superseded-by-restore" : "consumed-by-restore",
        consumedAt: now,
      });
    }
  }
}

async function verifyRestoreOperationEvidence(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  evidence: RestoreOperationRecoveryEvidence,
): Promise<void> {
  for (const binding of evidence.consumedBindings) {
    const terminal = evidence.terminalOutcomes.find((outcome) =>
      isDeepStrictEqual(outcome.binding, binding),
    );
    if (terminal?.disposition === "committed" && terminal.receipt) {
      const [row] = await transaction.select<ControlPlaneDatabaseRow>(
        "operationOutcomes",
        scope(identity, {
          operationId: binding.operationId,
          requestHash: binding.requestIdentity,
        }),
        [],
        1,
      );
      if (!row || !isDeepStrictEqual(documentRecord(row.receipt), canonical(terminal.receipt))) {
        throw persistenceError("Restored committed operation evidence is divergent.");
      }
    } else {
      const [row] = await transaction.select<ControlPlaneDatabaseRow>(
        "operationTombstones",
        scope(identity, {
          operationId: binding.operationId,
          namespaceId: binding.operationNamespace,
          requestHash: binding.requestIdentity,
        }),
        [],
        1,
      );
      if (!row) throw persistenceError("Restored consumed operation evidence is missing.");
      const target = documentRecord(row.target);
      if (!isDeepStrictEqual(target.binding, canonical(binding))) {
        throw persistenceError("Restored consumed operation binding is divergent.");
      }
    }
  }
}
async function readRecoveryRow(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  recoveryId: string,
) {
  const [row] = await transaction.select<RecoveryRow>(
    "recoveries",
    scope(identity, { recoveryId }),
    [],
    1,
  );
  if (row) requireCheckedRestoreDocument(row);
  return row;
}
async function requireRecoveryRow(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  recoveryId: string,
) {
  const row = await readRecoveryRow(transaction, identity, recoveryId);
  if (!row) throw persistenceError("Restore journal is missing.");
  return row;
}
async function readCheckpointRow(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  checkpointId: string,
) {
  const [row] = await transaction.select<CheckpointRow>(
    "recoveryCheckpoints",
    scope(identity, { checkpointId }),
    [],
    1,
  );
  return row;
}

async function upsert(
  transaction: ControlPlaneSqlTransaction,
  table: ControlPlaneTable,
  identity: ControlPlaneStoreIdentity,
  id: string,
  values: Readonly<Record<string, unknown>>,
): Promise<void> {
  const [existing] = await transaction.select(table, scope(identity, { id }), [], 1);
  let count: number;
  if (existing) {
    const update = { ...values };
    delete update.createdAt;
    count = await transaction.update(table, update, scope(identity, { id }));
  } else {
    count = await transaction.insert(table, values);
  }
  if (count !== 1) throw persistenceError(`Unexpected ${table} write count.`);
  const [readback] = await transaction.select(table, scope(identity, { id }), [], 1);
  if (!readback) throw persistenceError(`${table} durable readback is missing.`);
}

async function readVersions(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
): Promise<VersionState> {
  const [authority] = await transaction.select<GenerationRow>(
    "authorityVersions",
    scope(identity),
    [{ column: "generation", direction: "desc" }],
    1,
  );
  const [effective] = await transaction.select<GenerationRow>(
    "effectiveVersions",
    scope(identity),
    [{ column: "generation", direction: "desc" }],
    1,
  );
  const [security] = await transaction.select<SecurityGenerationRow>(
    "securityVersions",
    scope(identity),
    [{ column: "epoch", direction: "desc" }],
    1,
  );
  return {
    authorityGeneration: authority?.generation ?? 0,
    effectiveGeneration: authority?.effectiveVersion ?? effective?.generation ?? 0,
    securityEpoch: security?.epoch ?? 0,
  };
}

async function insertAuthorityVersion(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  now: string,
  versions: VersionState,
  bindingState: "inactive" | "active",
): Promise<void> {
  const id = `u7-authority:${versions.authorityGeneration}`;
  await transaction.insert("authorityVersions", {
    ...baseRow(identity, id, now, versions),
    generation: versions.authorityGeneration,
    bindingState,
    authorityToken: authorityTokenText(versions),
    operationNamespace: identity.operationNamespace,
  });
}

async function updateAuthorityBinding(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  generation: number,
  now: string,
  bindingState: "active",
  authorityToken: string,
): Promise<void> {
  const count = await transaction.update(
    "authorityVersions",
    { bindingState, authorityToken, updatedAt: now },
    scope(identity, { generation }),
  );
  if (count !== 1) throw persistenceError("Migration authority row was not uniquely updated.");
}

async function insertSecurityVersion(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  now: string,
  versions: VersionState,
): Promise<void> {
  const id = `u7-security:${versions.securityEpoch}`;
  await transaction.insert("securityVersions", {
    ...baseRow(identity, id, now, versions),
    epoch: versions.securityEpoch,
    minimumKeyVersion: 0,
    revocationWatermark: versions.securityEpoch,
    advancedAt: now,
  });
}

function baseRow(
  identity: ControlPlaneStoreIdentity,
  id: string,
  now: string,
  versions: VersionState,
  createdAt = now,
) {
  return {
    modelVersion: 1,
    id,
    logicalHostId: identity.logicalHostId,
    storeId: identity.storeId,
    createdAt,
    updatedAt: now,
    aggregateVersion: 0,
    authorityVersion: versions.authorityGeneration,
    effectiveVersion: versions.effectiveGeneration,
    securityVersion: versions.securityEpoch,
  } as const;
}

function scope(
  identity: ControlPlaneStoreIdentity,
  equals: Readonly<Record<string, unknown>> = {},
) {
  return {
    equals: { logicalHostId: identity.logicalHostId, storeId: identity.storeId, ...equals },
  } as const;
}
function serialKey(identity: ControlPlaneStoreIdentity, suffix: string) {
  return `u7:${identity.logicalHostId}:${identity.storeId}:${suffix}`;
}
function authorityTokenText(versions: VersionState | CurrentHostAuthorityToken) {
  return `${versions.authorityGeneration}:${versions.effectiveGeneration}`;
}
function nextGeneration(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER)
    throw persistenceError("Control-plane generation is invalid.");
  return value + 1;
}
function addMilliseconds(timestamp: string, milliseconds: number) {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) throw persistenceError("Database time is invalid.");
  return new Date(value + milliseconds).toISOString();
}
function canonical<T>(value: T): T {
  return JSON.parse(stableJsonStringify(value)) as T;
}
function databaseJson(transaction: ControlPlaneSqlTransaction, value: unknown): unknown {
  const encoded = canonical(value);
  return transaction.backend === "sqlite" ? encodeCanonicalJson(encoded) : encoded;
}
function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
function hashCanonical(value: unknown) {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}
function persistenceError(message: string) {
  return new CapletsError("CONFIG_INVALID", message);
}
function documentRecord(value: unknown): Record<string, unknown> {
  let decoded = value;
  if (typeof value === "string") {
    try {
      decoded = JSON.parse(value);
    } catch {
      throw persistenceError("Durable U7 state document is malformed.");
    }
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
    throw persistenceError("Durable U7 state document is malformed.");
  return decoded as Record<string, unknown>;
}
function requireCheckedMigrationDocument(
  row: Pick<MigrationRow, "checksum" | "stateDocument">,
): MigrationStateDocument | ElectionStateDocument {
  const document = documentRecord(row.stateDocument);
  if (!SHA256_PATTERN.test(row.checksum) || hashCanonical(document) !== row.checksum) {
    throw persistenceError("Migration journal checksum is invalid.");
  }
  return document.kind === "migration-election"
    ? requireElectionDocument(document)
    : requireMigrationDocument(document);
}
function requireCheckedRestoreDocument(
  row: Pick<RecoveryRow, "validationHash" | "stateDocument">,
): RestoreDocument {
  const document = documentRecord(row.stateDocument);
  if (!row.validationHash || hashCanonical(document) !== row.validationHash) {
    throw persistenceError("Restore journal checksum is invalid.");
  }
  return requireRestoreDocument(document);
}
function requireMigrationDocument(value: unknown): MigrationStateDocument {
  const document = documentRecord(value);
  if (
    document.version !== 1 ||
    document.kind !== "legacy-initialization" ||
    typeof document.migrationId !== "string" ||
    typeof document.fencingToken !== "number" ||
    !Array.isArray(document.entities)
  )
    throw persistenceError("Migration journal is malformed.");
  return document as MigrationStateDocument;
}
function requireElectionDocument(value: unknown): ElectionStateDocument {
  const document = documentRecord(value);
  if (
    document.version !== 1 ||
    document.kind !== "migration-election" ||
    typeof document.fencingToken !== "number" ||
    typeof document.ownerNodeId !== "string" ||
    typeof document.expiresAt !== "string"
  )
    throw persistenceError("Migration election journal is malformed.");
  return document as ElectionStateDocument;
}
function requireBackupDocument(value: unknown): BackupStateDocument {
  const document = documentRecord(value);
  if (document.version !== 1 || document.kind !== "backup-state")
    throw persistenceError("Backup durable state is malformed.");
  return document as BackupStateDocument;
}
function requireInventoryDocument(value: unknown): BackupInventoryDocument {
  const document = documentRecord(value);
  if (document.version !== 1 || document.kind !== "backup-inventory")
    throw persistenceError("Backup inventory state is malformed.");
  return document as BackupInventoryDocument;
}
function requireDestructionDocument(value: unknown): DestructionDocument {
  const document = documentRecord(value);
  if (
    document.version !== 1 ||
    !["destruction-preview", "destruction-intent"].includes(String(document.kind))
  )
    throw persistenceError("Backup destruction state is malformed.");
  return document as DestructionDocument;
}
function requireRestoreDocument(value: unknown): RestoreDocument {
  const document = documentRecord(value);
  if (
    document.version !== 1 ||
    document.kind !== "normal-restore" ||
    typeof document.restoreId !== "string" ||
    typeof document.backupId !== "string" ||
    typeof document.fenceToken !== "string"
  )
    throw persistenceError("Restore journal is malformed.");
  return document as RestoreDocument;
}
function requireCheckpointDocument(value: unknown): CheckpointDocument {
  const document = documentRecord(value);
  if (document.version !== 1 || document.kind !== "selected-checkpoint")
    throw persistenceError("Recovery checkpoint state is malformed.");
  return document as CheckpointDocument;
}
function requireMarkerDocument(value: unknown): MarkerDocument {
  const document = documentRecord(value);
  if (document.version !== 1 || document.kind !== "restored-sql-marker")
    throw persistenceError("Restored SQL marker is malformed.");
  return document as MarkerDocument;
}

async function assertElectionFence(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  operation: LegacyDestinationOperation,
) {
  await transaction.lock(serialKey(identity, "migration-election"));
  if (!Number.isSafeInteger(operation.fencingToken) || operation.fencingToken < 0) {
    throw persistenceError("Migration fencing token is invalid.");
  }
  if (transaction.backend === "sqlite") return;
  if (operation.fencingToken === 0)
    throw persistenceError("Postgres migration fencing token is invalid.");
  const row = await readMigrationRow(transaction, identity, ELECTION_ROW_ID);
  if (!row) throw persistenceError("Postgres migration election is missing.");
  const election = requireElectionDocument(row.stateDocument);
  const now = await transaction.databaseTime();
  if (
    election.fencingToken !== operation.fencingToken ||
    election.releasedAt ||
    Date.parse(election.expiresAt) <= Date.parse(now)
  ) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Postgres migration election is stale.");
  }
}
function assertOperation(state: MigrationStateDocument, operation: LegacyDestinationOperation) {
  if (state.migrationId !== operation.migrationId || state.fencingToken !== operation.fencingToken)
    throw persistenceError("Migration operation fence does not match durable journal.");
}
function assertLegacyReadback(
  state: MigrationStateDocument,
  source: VerifiedLegacyMigrationSource,
  protectedRecords: readonly U6ProtectedLegacyRecord[],
) {
  if (source.manifestSha256 !== state.metadata.manifestSha256)
    throw persistenceError("Legacy manifest readback does not match migration metadata.");
  const expected = [
    ...source.trackedCaplets.map((value) => canonical({ kind: "tracked-caplet", value })),
    ...protectedRecords.map((value) => canonical({ kind: "legacy-record", value })),
    ...source.quarantines.map((value) => canonical({ kind: "quarantine", value })),
  ];
  if (!isDeepStrictEqual(state.entities, expected))
    throw persistenceError("Legacy staged entity readback is incomplete or divergent.");
  if (
    state.metadata.kind === "legacy" &&
    (!state.metadata.protectedBundleId || !state.metadata.exclusionCleanupId)
  ) {
    throw persistenceError("Legacy protected bundle or exclusion cleanup evidence is missing.");
  }
  for (const record of protectedRecords) {
    if (record.protection.verifiedBy !== "u6" || !SHA256_PATTERN.test(record.protection.commitment))
      throw persistenceError("Legacy protected-record evidence is malformed.");
  }
}
function assertBackupIntentIdentity(
  identity: ControlPlaneStoreIdentity,
  intent: RecoveryBackupIntent,
) {
  const reference = intent.recoveryKeyReference;
  if (
    reference.logicalHostId !== identity.logicalHostId ||
    reference.storeId !== identity.storeId ||
    reference.providerIdentity !== intent.providerIdentity ||
    !SHA256_PATTERN.test(intent.bindingDigest)
  ) {
    throw persistenceError("Backup intent targets another authority or has an invalid binding.");
  }
}
function assertIntentAdvance(prior: RecoveryBackupIntent, next: RecoveryBackupIntent) {
  const phases = ["staged", "wrapped-key-written", "envelope-written", "finalized"];
  if (next.backupId !== prior.backupId || phases.indexOf(next.phase) < phases.indexOf(prior.phase))
    throw persistenceError("Backup intent phase cannot regress.");
  const immutable = (value: RecoveryBackupIntent) => ({
    ...value,
    phase: undefined,
    wrappedKeyDigest: undefined,
    headerDigest: undefined,
    terminalManifestDigest: undefined,
    chunkCount: undefined,
    plaintextLength: undefined,
    finalizedAt: undefined,
  });
  if (!isDeepStrictEqual(canonical(immutable(prior)), canonical(immutable(next))))
    throw persistenceError("Backup intent immutable binding changed.");
}
function assertInventoryIdentity(
  identity: ControlPlaneStoreIdentity,
  snapshot: BackupInventorySnapshot,
) {
  if (
    !Number.isSafeInteger(snapshot.version) ||
    snapshot.version < 0 ||
    !Number.isSafeInteger(snapshot.purgeWatermark) ||
    snapshot.purgeWatermark < 0 ||
    !Array.isArray(snapshot.records)
  )
    throw persistenceError("Backup inventory is malformed.");
  for (const record of snapshot.records) {
    if (
      record.recoveryKeyReference.logicalHostId !== identity.logicalHostId ||
      record.recoveryKeyReference.storeId !== identity.storeId ||
      record.providerIdentity !== record.recoveryKeyReference.providerIdentity
    )
      throw persistenceError("Backup inventory targets another authority.");
    for (const digest of [
      record.bindingDigest,
      record.headerDigest,
      record.terminalManifestDigest,
      record.wrappedKeyDigest,
    ])
      if (!SHA256_PATTERN.test(digest))
        throw persistenceError("Backup inventory digest is malformed.");
  }
}
function assertInventoryRecordAdvance(prior: BackupInventoryRecord, next: BackupInventoryRecord) {
  const phases = ["staged", "finalized", "destruction-intended", "destroyed"];
  if (phases.indexOf(next.state) < phases.indexOf(prior.state))
    throw persistenceError("Backup inventory state cannot regress.");
  const immutable = (record: BackupInventoryRecord) => ({
    ...record,
    state: undefined,
    finalizedAt: undefined,
    destructionId: undefined,
    destroyedAt: undefined,
    retentionUntil: undefined,
  });
  if (!isDeepStrictEqual(canonical(immutable(prior)), canonical(immutable(next))))
    throw persistenceError("Backup inventory immutable binding changed.");
}
function assertPreviewIdentity(
  identity: ControlPlaneStoreIdentity,
  preview: BackupDestructionPreviewRecord,
) {
  if (
    preview.token.logicalHostId !== identity.logicalHostId ||
    preview.token.storeId !== identity.storeId ||
    preview.target.providerIdentity.length === 0
  )
    throw persistenceError("Backup destruction preview targets another authority.");
}
function assertDestructionIntentIdentity(
  identity: ControlPlaneStoreIdentity,
  intent: BackupDestructionIntent,
) {
  if (
    !intent.destructionId ||
    !intent.confirmationId ||
    intent.target.recoveryKeyReference.logicalHostId !== identity.logicalHostId ||
    intent.target.recoveryKeyReference.storeId !== identity.storeId ||
    intent.target.providerIdentity !== intent.target.recoveryKeyReference.providerIdentity
  )
    throw persistenceError("Backup destruction intent targets another authority.");
}
function assertDestructionAdvance(prior: BackupDestructionIntent, next: BackupDestructionIntent) {
  const phases = [
    "confirmed",
    "bytes-deleting",
    "bytes-deleted",
    "key-deleting",
    "key-deleted",
    "completed",
  ];
  if (phases.indexOf(next.phase) < phases.indexOf(prior.phase))
    throw persistenceError("Backup destruction phase cannot regress.");
  const immutable = (intent: BackupDestructionIntent) => ({
    ...intent,
    phase: undefined,
    receipt: undefined,
  });
  if (!isDeepStrictEqual(canonical(immutable(prior)), canonical(immutable(next))))
    throw persistenceError("Backup destruction target changed.");
}
function assertRestoreFence(document: RestoreDocument, fenceToken: string) {
  if (document.fenceToken !== fenceToken) throw persistenceError("Restore fence token is stale.");
}
function assertRestoreIdentity(
  identity: ControlPlaneStoreIdentity,
  state: RestorableControlPlaneState,
) {
  if (!isDeepStrictEqual(state.identity, identity))
    throw persistenceError("Restore candidate targets another authority.");
}
function assertOperationRecoveryIdentity(
  identity: ControlPlaneStoreIdentity,
  evidence: RestoreOperationRecoveryEvidence,
) {
  const bindings = [
    ...evidence.consumedBindings,
    ...evidence.terminalOutcomes.map((outcome) => outcome.binding),
  ];
  for (const binding of bindings) {
    if (
      binding.logicalHostId !== identity.logicalHostId ||
      binding.storeId !== identity.storeId ||
      binding.operationNamespace !== identity.operationNamespace
    )
      throw persistenceError("Restore operation evidence targets another authority.");
  }
  for (const outcome of evidence.terminalOutcomes) {
    if (!evidence.consumedBindings.some((binding) => isDeepStrictEqual(binding, outcome.binding)))
      throw persistenceError("Terminal restore outcome lacks a consumed operation binding.");
  }
}
function assertCandidateToken(
  restoreId: string,
  fenceToken: string,
  document: RestoreDocument,
  candidate: DurableInactiveRestoreCandidate,
) {
  const expected = hashCanonical({
    restoreId,
    fenceToken,
    candidate: candidate.state,
    expectedAuthorityGeneration: candidate.expectedAuthorityGeneration,
    operationRecovery: candidate.operationRecovery,
    baseline: document.baseline,
  });
  if (candidate.persistenceToken !== expected)
    throw persistenceError("Restore candidate persistence token is invalid.");
}
async function assertBackupReadback(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  records: readonly BackupInventoryRecord[],
) {
  const snapshot = await readInventory(transaction, identity);
  for (const record of records) {
    const durable = snapshot.records.find((candidate) => candidate.backupId === record.backupId);
    if (!durable || !isDeepStrictEqual(durable, canonical(record)))
      throw persistenceError("Restore backup inventory readback is incomplete or divergent.");
    const row = await readBackupRow(transaction, identity, record.backupId);
    if (
      !row ||
      !isDeepStrictEqual(requireBackupDocument(row.stateDocument).inventory, canonical(record))
    )
      throw persistenceError("Restore backup envelope binding readback is divergent.");
  }
}
function assertRestoreConfirmation(
  identity: ControlPlaneStoreIdentity,
  restoreId: string,
  backupId: string,
  confirmation: NormalRestoreConfirmation,
  candidate: DurableInactiveRestoreCandidate,
) {
  if (
    !isDeepStrictEqual(confirmation.target, identity) ||
    confirmation.restoreId !== restoreId ||
    confirmation.selectedBackup.backupId !== backupId ||
    confirmation.expectedAuthorityGeneration !== candidate.expectedAuthorityGeneration ||
    confirmation.expectedSecurityEpoch >= candidate.state.securityEpoch
  )
    throw persistenceError("Restore confirmation is stale or mismatched.");
  const selected = confirmation.completeBackupInventory.find(
    (record) => record.backupId === backupId,
  );
  if (!selected || !isDeepStrictEqual(selected, confirmation.selectedBackup))
    throw persistenceError("Restore confirmation inventory is incomplete.");
  const reference = confirmation.envelopeBinding.recoveryKeyReference;
  if (
    confirmation.envelopeBinding.logicalHostId !== identity.logicalHostId ||
    confirmation.envelopeBinding.storeId !== identity.storeId ||
    reference.logicalHostId !== identity.logicalHostId ||
    reference.storeId !== identity.storeId
  )
    throw persistenceError("Restore envelope binding targets another authority.");
  if (hashCanonical(confirmation.envelopeBinding) !== confirmation.selectedBackup.bindingDigest)
    throw persistenceError("Restore envelope binding digest does not match inventory.");
}
function assertSelectedCheckpoint(
  identity: ControlPlaneStoreIdentity,
  checkpoint: AuthenticatedRecoveryCheckpoint,
  descriptor: RecoveryDescriptor,
) {
  if (
    checkpoint.format !== "caplets-recovery-checkpoint-v1" ||
    checkpoint.state !== "selected" ||
    checkpoint.payload.logicalHostId !== identity.logicalHostId ||
    checkpoint.payload.storeId !== identity.storeId ||
    checkpoint.payload.operationNamespace !== identity.operationNamespace ||
    descriptor.logicalHostId !== identity.logicalHostId ||
    descriptor.generation !== checkpoint.payload.generation ||
    descriptor.checkpointDigest !== checkpoint.digest ||
    !SHA256_PATTERN.test(checkpoint.digest)
  )
    throw persistenceError("Selected recovery checkpoint is not bound to this authority.");
}
function assertMarkerIdentity(identity: ControlPlaneStoreIdentity, marker: RestoredSqlMarker) {
  if (
    !isDeepStrictEqual(marker.newIdentity, identity) ||
    marker.securityEpoch < 0 ||
    !Number.isSafeInteger(marker.descriptorGeneration) ||
    marker.descriptorGeneration < 0 ||
    !SHA256_PATTERN.test(marker.descriptorDigest)
  )
    throw persistenceError("Restored SQL marker targets another authority.");
}
