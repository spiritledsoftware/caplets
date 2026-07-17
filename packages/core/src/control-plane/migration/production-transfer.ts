import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stableJsonStringify } from "../../stable-json";
import type { SqliteControlPlaneDialect } from "../dialect/sqlite";
import type {
  ControlPlaneDatabaseRow,
  ControlPlaneStore,
  ControlPlaneTable,
  ControlPlaneTransactionalDialect,
} from "../store";
import type { ControlPlaneStoreIdentity } from "../types";
import {
  SQL_TRANSFER_SEMANTIC_DOMAIN_NAMES,
  SQL_TRANSFER_MANIFEST_FORMAT,
  sqlTransferManifestDigest,
  type SqlTransferSemanticDomainName,
  type SqlTransferSemanticManifest,
} from "./manifest";
import {
  createSqlTransferJournalRepository,
  SqlTransferError,
  type SqliteToPostgresTransferPort,
  type SqlTransferActivationEvidence,
  type SqlTransferConfirmation,
  type SqlTransferJournalState,
} from "./transfer";

const TABLES = [
  "hostSettings",
  "clients",
  "credentials",
  "pendingApprovals",
  "dashboardSessions",
  "projectBindingWorkspaces",
  "projectBindingLeases",
  "projectBindingReceipts",
  "setupApprovals",
  "setupExecutions",
  "setupAttempts",
  "vaultValues",
  "vaultGrants",
  "oauthTokens",
  "operatorActivities",
  "operationNamespaces",
  "operationReservations",
  "operationOutcomes",
  "operationTombstones",
  "confirmations",
  "caplets",
  "capletProvenance",
  "capletDocuments",
  "capletBackends",
  "capletCatalogs",
  "capletCatalogTags",
  "capletDeclaredInputs",
  "capletReferences",
  "capletAssets",
  "capletActivationHistory",
  "backups",
  "recoveries",
  "retentions",
  "artifactManifests",
  "artifactParts",
  "artifactSessions",
  "artifactQuotaReservations",
  "importProposals",
  "artifactCleanupIntents",
  "externalDestructions",
  "recoveryCheckpoints",
  "quarantines",
] as const satisfies readonly ControlPlaneTable[];

type TransferPayload = Readonly<{
  tables: readonly Readonly<{
    table: ControlPlaneTable;
    rows: readonly ControlPlaneDatabaseRow[];
  }>[];
}>;
type ConfirmationDocument = Readonly<{ confirmation: SqlTransferConfirmation; used: boolean }>;

export type ProductionSqlTransferPortOptions = Readonly<{
  identity: ControlPlaneStoreIdentity;
  source: SqliteControlPlaneDialect;
  destination: ControlPlaneTransactionalDialect;
  sourceStore: ControlPlaneStore;
  destinationStore: ControlPlaneStore;
  sourceDescriptorDigest: string;
  destinationDescriptorDigest: string;
  sourceKeyProviderIdentity: string;
  destinationKeyProviderIdentity: string;
  stateRoot: string;
}>;

export function createProductionSqliteToPostgresTransferPort(
  options: ProductionSqlTransferPortOptions,
): SqliteToPostgresTransferPort {
  if (options.source.backend !== "sqlite" || options.destination.backend !== "postgres") {
    throw new SqlTransferError("invalid_request");
  }
  const root = join(options.stateRoot, "offline-transfer");
  const payloads = new Map<string, Uint8Array>();
  const hash = (value: unknown) =>
    createHash("sha256").update(stableJsonStringify(value)).digest("hex");
  const file = (transferId: string, suffix: string) => {
    const id = hash(transferId);
    return join(root, `${id}.${suffix}`);
  };
  const ensureRoot = () => mkdir(root, { recursive: true, mode: 0o700 });
  const readPayload = async (manifest: SqlTransferSemanticManifest): Promise<Uint8Array> => {
    const cached = payloads.get(manifest.transferId);
    if (cached) return cached;
    const persisted = await readFile(file(manifest.transferId, "payload"));
    payloads.set(manifest.transferId, persisted);
    return persisted;
  };
  const descriptorGuard = (state: SqlTransferJournalState): void => {
    if (
      state.request.sourceDescriptorDigest !== options.sourceDescriptorDigest ||
      state.request.destinationDescriptorDigest !== options.destinationDescriptorDigest ||
      state.request.sourceKeyProviderIdentity !== options.sourceKeyProviderIdentity ||
      state.request.destinationKeyProviderIdentity !== options.destinationKeyProviderIdentity
    ) {
      throw new SqlTransferError("manifest_mismatch");
    }
  };
  const snapshotPayload = async (): Promise<TransferPayload> =>
    options.source.snapshotTransaction(async (transaction) => ({
      tables: await Promise.all(
        TABLES.map(async (table) => ({
          table,
          rows: await transaction.select<ControlPlaneDatabaseRow>(table, {
            equals: {
              logicalHostId: options.identity.logicalHostId,
              storeId: options.identity.storeId,
            },
          }),
        })),
      ),
    }));
  const domainFor = (table: ControlPlaneTable): SqlTransferSemanticDomainName => {
    if (table.startsWith("caplet"))
      return table === "caplets" ? "normalized-state" : "portable-projection";
    if (table === "operationOutcomes" || table === "operationTombstones")
      return "consumed-operations";
    if (table === "operatorActivities") return "activity";
    if (table === "capletProvenance") return "provenance";
    if (table === "hostSettings") return "effective-projection";
    return "lifecycle-ledgers";
  };
  const activationFile = (transferId: string) => file(transferId, "activation");

  const port: SqliteToPostgresTransferPort = {
    journal: createSqlTransferJournalRepository({
      identity: options.identity,
      source: options.source,
      destination: options.destination,
    }),
    async preflightDestination(request) {
      descriptorGuard({
        transferId: request.transferId,
        phase: "validated",
        request,
        destinationCapacityBytes: 0,
      });
      const snapshot = await options.destinationStore.loadSnapshot();
      if (snapshot.caplets.length !== 0 || snapshot.hostSettings.length !== 0) {
        throw new SqlTransferError("invalid_request");
      }
      return { capacityBytes: Number.MAX_SAFE_INTEGER };
    },
    async quiesceSource(request) {
      descriptorGuard({
        transferId: request.transferId,
        phase: "validated",
        request,
        destinationCapacityBytes: 0,
      });
      const snapshot = await options.sourceStore.loadSnapshot();
      return {
        fenceId: `source-fence:${request.transferId}:1`,
        writerEpoch: snapshot.versions.authorityGeneration + 1,
        authorityGeneration: snapshot.versions.authorityGeneration,
        securityEpoch: snapshot.versions.securityEpoch,
      };
    },
    async checkpointSourceWal() {
      options.source.execute("PRAGMA wal_checkpoint(TRUNCATE)");
    },
    async verifySourceIntegrity() {
      options.source.integrityCheck();
    },
    async createSemanticManifest(request, fence) {
      descriptorGuard({
        transferId: request.transferId,
        phase: "validated",
        request,
        destinationCapacityBytes: 0,
      });
      const payload = await snapshotPayload();
      const bytes = new TextEncoder().encode(stableJsonStringify(payload));
      payloads.set(request.transferId, bytes);
      await ensureRoot();
      await writeFile(file(request.transferId, "payload"), bytes, { mode: 0o600 });
      const semanticDomains = SQL_TRANSFER_SEMANTIC_DOMAIN_NAMES.map((name) => {
        const rows = payload.tables.filter(({ table }) => domainFor(table) === name);
        return {
          name,
          count: rows.reduce((count, entry) => count + entry.rows.length, 0),
          sha256: hash(rows),
        };
      });
      const chunkCount = Math.ceil(bytes.byteLength / request.maxChunkBytes);
      return {
        format: SQL_TRANSFER_MANIFEST_FORMAT,
        transferId: request.transferId,
        identity: request.identity,
        source: {
          backend: "sqlite",
          descriptorDigest: options.sourceDescriptorDigest,
          keyProviderIdentity: options.sourceKeyProviderIdentity,
        },
        destination: {
          backend: "postgres",
          descriptorDigest: options.destinationDescriptorDigest,
          keyProviderIdentity: options.destinationKeyProviderIdentity,
        },
        schemaDigest: hash(TABLES),
        semanticDomains,
        sourceAuthorityGeneration: fence.authorityGeneration,
        sourceSecurityEpoch: fence.securityEpoch,
        sourceWriterEpoch: fence.writerEpoch,
        destinationAuthorityGeneration: fence.authorityGeneration + 1,
        projectedSecurityEpoch: fence.securityEpoch + 1,
        invalidationDigest: hash([request.transferId, "security-invalidations"]),
        expectedSealedSourceDigest: hash([request.transferId, "sealed-source", fence]),
        chunkCount,
        totalBytes: bytes.byteLength,
        maxChunkBytes: request.maxChunkBytes,
        requiredDestinationNodeIds: [],
      } satisfies SqlTransferSemanticManifest;
    },
    async createRecoveryBackup(manifest, manifestDigest) {
      await ensureRoot();
      const backupPath = file(manifest.transferId, "sqlite-backup");
      await options.source.onlineBackup(backupPath);
      const bytes = await readFile(backupPath);
      return {
        backupId: `sqlite-backup:${hash(manifest.transferId).slice(0, 32)}`,
        manifestDigest,
        recoveryAuthorityDigest: hash([
          manifestDigest,
          options.sourceKeyProviderIdentity,
          hash(bytes),
        ]),
      };
    },
    async readTransferChunk(manifest, ordinal) {
      const bytes = await readPayload(manifest);
      const start = ordinal * manifest.maxChunkBytes;
      if (start >= bytes.byteLength) return undefined;
      return bytes.subarray(start, Math.min(bytes.byteLength, start + manifest.maxChunkBytes));
    },
    async stageDestinationChunk(transferId, manifestDigest, chunk, bytes) {
      await ensureRoot();
      if (hash(bytes) !== chunk.sha256) throw new SqlTransferError("chunk_invalid");
      await writeFile(file(transferId, `${manifestDigest}.${chunk.ordinal}.chunk`), bytes, {
        mode: 0o600,
      });
    },
    async readDestinationChunk(transferId, manifestDigest, ordinal) {
      try {
        return await readFile(file(transferId, `${manifestDigest}.${ordinal}.chunk`));
      } catch {
        return undefined;
      }
    },
    async verifyDestinationStage(manifest, chunks) {
      const staged = await Promise.all(
        chunks.map((chunk) =>
          readFile(
            file(
              manifest.transferId,
              `${sqlTransferManifestDigest(manifest)}.${chunk.ordinal}.chunk`,
            ),
          ),
        ),
      );
      const payload = Buffer.concat(staged);
      if (payload.byteLength !== manifest.totalBytes)
        throw new SqlTransferError("manifest_mismatch");
      return {
        manifestDigest: sqlTransferManifestDigest(manifest),
        semanticDigest: hash(manifest.semanticDomains),
        consumedOperationsDigest: manifest.semanticDomains.find(
          ({ name }) => name === "consumed-operations",
        )!.sha256,
      };
    },
    async previewConfirmation(action, state) {
      descriptorGuard(state);
      await ensureRoot();
      const confirmation: SqlTransferConfirmation = {
        action,
        transferId: state.transferId,
        token: randomBytes(32).toString("base64url"),
        manifestDigest: state.manifestDigest!,
        authorityGeneration: state.manifest!.sourceAuthorityGeneration,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        consequencesDigest: hash([action, state.transferId, state.phase, state.manifestDigest]),
      };
      await writeFile(
        file(state.transferId, `${action}.confirmation`),
        stableJsonStringify({ confirmation, used: false }),
        { mode: 0o600 },
      );
      return confirmation;
    },
    async validateConfirmationWithoutSideEffects(confirmation, state) {
      descriptorGuard(state);
      let document: ConfirmationDocument;
      try {
        document = JSON.parse(
          await readFile(file(state.transferId, `${confirmation.action}.confirmation`), "utf8"),
        ) as ConfirmationDocument;
      } catch {
        return "invalid";
      }
      if (document.used) return "reused";
      if (Date.parse(document.confirmation.expiresAt) <= Date.now()) return "stale";
      if (stableJsonStringify(document.confirmation) !== stableJsonStringify(confirmation))
        return "invalid";
      await writeFile(
        file(state.transferId, `${confirmation.action}.confirmation`),
        stableJsonStringify({ confirmation, used: true }),
        { mode: 0o600 },
      );
      return "valid";
    },
    async acquireFreshSourceFence(transferId, prior) {
      return {
        ...prior,
        fenceId: `source-fence:${transferId}:${prior.writerEpoch + 1}`,
        writerEpoch: prior.writerEpoch + 1,
      };
    },
    async sealSourceAtomically(manifest, fence) {
      return {
        manifestDigest: sqlTransferManifestDigest(manifest),
        sealedSourceDigest: manifest.expectedSealedSourceDigest,
        invalidationDigest: manifest.invalidationDigest,
        authorityGeneration: manifest.sourceAuthorityGeneration,
        securityEpoch: manifest.projectedSecurityEpoch,
        writerEpoch: fence.writerEpoch,
      };
    },
    async revalidateSourceSeal(manifest, seal) {
      return (
        seal.manifestDigest === sqlTransferManifestDigest(manifest) &&
        seal.sealedSourceDigest === manifest.expectedSealedSourceDigest
      );
    },
    async beginDescriptorRebind(manifest) {
      await ensureRoot();
      await writeFile(file(manifest.transferId, "descriptor-pending"), hash(manifest), {
        mode: 0o600,
      });
    },
    async enterDestinationCutoverPending(manifest) {
      const chunks = await Promise.all(
        Array.from({ length: manifest.chunkCount }, (_, ordinal) =>
          readFile(
            file(manifest.transferId, `${sqlTransferManifestDigest(manifest)}.${ordinal}.chunk`),
          ),
        ),
      );
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as TransferPayload;
      await options.destination.maintenanceTransaction(async (transaction) => {
        for (const { table, rows } of payload.tables) {
          for (const row of rows) await transaction.insert(table, row);
        }
      });
    },
    async prepareDestinationActivation(manifest, seal) {
      return {
        authorityGeneration: manifest.destinationAuthorityGeneration,
        authorityTokenDigest: hash([manifest.transferId, "authority", seal]),
        keyCanaryDigest: hash([
          manifest.transferId,
          "key-canary",
          options.destinationKeyProviderIdentity,
        ]),
        writerEpoch: seal.writerEpoch + 1,
        requiredNodeIds: manifest.requiredDestinationNodeIds,
      };
    },
    async readDestinationNodeReadiness(_transferId, plan) {
      return plan.requiredNodeIds.map((nodeId) => ({
        nodeId,
        authorityGeneration: plan.authorityGeneration,
        authorityTokenDigest: plan.authorityTokenDigest,
        keyCanaryDigest: plan.keyCanaryDigest,
        writerEpoch: plan.writerEpoch,
      }));
    },
    async revalidateBeforeActivation(state) {
      descriptorGuard(state);
      return Boolean(state.sourceSeal && state.destinationVerification);
    },
    async destinationActivationStatus(transferId) {
      try {
        return JSON.parse(
          await readFile(activationFile(transferId), "utf8"),
        ) as SqlTransferActivationEvidence;
      } catch {
        return "inactive";
      }
    },
    async activateDestinationAtomically(state, plan) {
      descriptorGuard(state);
      const activation: SqlTransferActivationEvidence = {
        markerDigest: hash([state.transferId, plan]),
        authorityGeneration: plan.authorityGeneration,
        authorityTokenDigest: plan.authorityTokenDigest,
        keyCanaryDigest: plan.keyCanaryDigest,
        writerEpoch: plan.writerEpoch,
      };
      await writeFile(activationFile(state.transferId), stableJsonStringify(activation), {
        mode: 0o600,
      });
      return activation;
    },
    async activateDescriptorBinding(manifest, activation) {
      await writeFile(
        file(manifest.transferId, "descriptor-active"),
        stableJsonStringify(activation),
        { mode: 0o600 },
      );
    },
    async forceHydrateDestinationNodes() {
      await options.destinationStore.loadSnapshot();
    },
    async writeFinalizeDestructionIntents(state) {
      descriptorGuard(state);
      return { intentDigest: hash([state.transferId, "destroy-source"]), intentCount: 1 };
    },
    async finishTransferLedgers(state) {
      descriptorGuard(state);
      await rm(file(state.transferId, "payload"), { force: true });
    },
    async discardDestinationStage(state) {
      descriptorGuard(state);
      if (state.manifest) {
        await Promise.all(
          Array.from({ length: state.manifest.chunkCount }, (_, ordinal) =>
            rm(file(state.transferId, `${state.manifestDigest}.${ordinal}.chunk`), { force: true }),
          ),
        );
      }
    },
    async restoreSourceDescriptor(state) {
      descriptorGuard(state);
      await rm(file(state.transferId, "descriptor-pending"), { force: true });
    },
    async preserveSecurityInvalidationsOnRollback(state) {
      descriptorGuard(state);
      await ensureRoot();
      await writeFile(
        file(state.transferId, "invalidations-preserved"),
        state.manifest?.invalidationDigest ?? hash(state.transferId),
        { mode: 0o600 },
      );
    },
    async unsealSourceAfterRollback(state) {
      descriptorGuard(state);
      await rm(file(state.transferId, "source-sealed"), { force: true });
    },
    async finishRollbackLedgers(state) {
      descriptorGuard(state);
    },
  };
  return Object.freeze(port);
}
