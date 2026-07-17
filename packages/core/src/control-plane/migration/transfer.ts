import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CapletsError } from "../../errors";
import { stableJsonStringify } from "../../stable-json";
import { decodeCanonicalJson, encodeCanonicalJson } from "../schema/model-codec";
import type {
  ControlPlaneDatabaseRow,
  ControlPlaneSqlTransaction,
  ControlPlaneTransactionalDialect,
} from "../store";
import type { ControlPlaneStoreIdentity } from "../types";
import {
  MAX_SQL_TRANSFER_CHUNK_BYTES,
  assertSqlTransferSemanticManifest,
  sameSqlTransferSemanticManifest,
  sqlTransferManifestDigest,
  type SqlTransferIdentity,
  type SqlTransferSemanticManifest,
} from "./manifest";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_TRANSFER_ID = /^[\x21-\x7e]{1,256}$/u;
const EMPTY_MANIFEST_DIGEST = "0".repeat(64);
const JOURNAL_KIND = "sqlite-postgres-transfer-journal" as const;

export const SQL_TRANSFER_JOURNAL_VERSION = 1 as const;

export const SQL_TRANSFER_PHASES = [
  "validated",
  "source-quiesced",
  "source-checkpointed",
  "source-integrity-verified",
  "manifest-recorded",
  "backup-durable",
  "destination-staging",
  "destination-verified",
  "seal-fence-acquired",
  "source-sealed",
  "descriptor-pending",
  "destination-pending",
  "destination-ready",
  "destination-activated",
  "descriptor-rebound",
  "destination-hydrated",
  "destruction-intents-durable",
  "completed",
  "rollback-pending",
  "rollback-staging-discarded",
  "rollback-descriptor-restored",
  "rollback-invalidations-preserved",
  "rolled-back",
] as const;

export type SqlTransferPhase = (typeof SQL_TRANSFER_PHASES)[number];

export const SQL_TRANSFER_FAILURE_POINTS = SQL_TRANSFER_PHASES.map(
  (phase) => `after-${phase}` as const,
);
export type SqlTransferFailurePoint = (typeof SQL_TRANSFER_FAILURE_POINTS)[number];

export type SqlTransferErrorCode =
  | "invalid_request"
  | "invalid_phase"
  | "journal_conflict"
  | "journal_corrupt"
  | "journal_desynchronized"
  | "manifest_mismatch"
  | "capacity_exceeded"
  | "chunk_invalid"
  | "confirmation_required"
  | "confirmation_invalid"
  | "confirmation_stale"
  | "confirmation_reused"
  | "source_seal_invalid"
  | "destination_not_ready"
  | "activation_conflict"
  | "rollback_forbidden"
  | "one_authority_violation"
  | "transfer_interrupted";

/** Secret-safe error: callers may report only `code`. */
export class SqlTransferError extends Error {
  readonly name = "SqlTransferError";

  constructor(readonly code: SqlTransferErrorCode) {
    super(code);
  }
}

export type SqlTransferStartRequest = Readonly<{
  transferId: string;
  identity: SqlTransferIdentity;
  sourceDescriptorDigest: string;
  destinationDescriptorDigest: string;
  sourceKeyProviderIdentity: string;
  destinationKeyProviderIdentity: string;
  maxChunkBytes: number;
}>;

export type SqlTransferConfirmationAction = "cutover" | "finalize";

export type SqlTransferConfirmation = Readonly<{
  action: SqlTransferConfirmationAction;
  transferId: string;
  token: string;
  manifestDigest: string;
  authorityGeneration: number;
  expiresAt: string;
  consequencesDigest: string;
}>;

export type SqlTransferSourceFence = Readonly<{
  fenceId: string;
  writerEpoch: number;
  authorityGeneration: number;
  securityEpoch: number;
}>;

export type SqlTransferBackupEvidence = Readonly<{
  backupId: string;
  manifestDigest: string;
  recoveryAuthorityDigest: string;
}>;

export type SqlTransferChunkReceipt = Readonly<{
  ordinal: number;
  byteLength: number;
  sha256: string;
}>;

export type SqlTransferDestinationVerification = Readonly<{
  manifestDigest: string;
  semanticDigest: string;
  consumedOperationsDigest: string;
}>;

export type SqlTransferSourceSeal = Readonly<{
  manifestDigest: string;
  sealedSourceDigest: string;
  invalidationDigest: string;
  authorityGeneration: number;
  securityEpoch: number;
  writerEpoch: number;
}>;

export type SqlTransferActivationPlan = Readonly<{
  authorityGeneration: number;
  authorityTokenDigest: string;
  keyCanaryDigest: string;
  writerEpoch: number;
  requiredNodeIds: readonly string[];
}>;

export type SqlTransferNodeReadiness = Readonly<{
  nodeId: string;
  authorityGeneration: number;
  authorityTokenDigest: string;
  keyCanaryDigest: string;
  writerEpoch: number;
}>;

export type SqlTransferActivationEvidence = Readonly<{
  markerDigest: string;
  authorityGeneration: number;
  authorityTokenDigest: string;
  keyCanaryDigest: string;
  writerEpoch: number;
}>;

export type SqlTransferDestructionIntentEvidence = Readonly<{
  intentDigest: string;
  intentCount: number;
}>;

export type SqlTransferJournalState = Readonly<{
  transferId: string;
  phase: SqlTransferPhase;
  request: SqlTransferStartRequest;
  destinationCapacityBytes: number;
  sourceFence?: SqlTransferSourceFence | undefined;
  manifest?: SqlTransferSemanticManifest | undefined;
  manifestDigest?: string | undefined;
  backup?: SqlTransferBackupEvidence | undefined;
  chunks?: readonly SqlTransferChunkReceipt[] | undefined;
  destinationVerification?: SqlTransferDestinationVerification | undefined;
  sealFence?: SqlTransferSourceFence | undefined;
  sourceSeal?: SqlTransferSourceSeal | undefined;
  activationPlan?: SqlTransferActivationPlan | undefined;
  activation?: SqlTransferActivationEvidence | undefined;
  destructionIntents?: SqlTransferDestructionIntentEvidence | undefined;
  rollbackFromPhase?: SqlTransferPhase | undefined;
}>;

export type SqlTransferJournalSnapshot =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "present"; revision: number; state: SqlTransferJournalState }>;

export interface SqlTransferJournalPort {
  read(transferId: string): Promise<SqlTransferJournalSnapshot>;
  compareAndSet(
    transferId: string,
    expectedRevision: number | undefined,
    next: SqlTransferJournalState,
  ): Promise<SqlTransferJournalSnapshot | "conflict">;
}

export type SqlTransferDestinationPreflight = Readonly<{
  capacityBytes: number;
}>;

export interface SqliteToPostgresTransferPort {
  journal: SqlTransferJournalPort;
  preflightDestination(request: SqlTransferStartRequest): Promise<SqlTransferDestinationPreflight>;
  quiesceSource(request: SqlTransferStartRequest): Promise<SqlTransferSourceFence>;
  checkpointSourceWal(transferId: string, fence: SqlTransferSourceFence): Promise<void>;
  verifySourceIntegrity(transferId: string, fence: SqlTransferSourceFence): Promise<void>;
  createSemanticManifest(
    request: SqlTransferStartRequest,
    fence: SqlTransferSourceFence,
  ): Promise<SqlTransferSemanticManifest>;
  createRecoveryBackup(
    manifest: SqlTransferSemanticManifest,
    manifestDigest: string,
  ): Promise<SqlTransferBackupEvidence>;
  readTransferChunk(
    manifest: SqlTransferSemanticManifest,
    ordinal: number,
  ): Promise<Uint8Array | undefined>;
  stageDestinationChunk(
    transferId: string,
    manifestDigest: string,
    chunk: SqlTransferChunkReceipt,
    bytes: Uint8Array,
  ): Promise<void>;
  readDestinationChunk(
    transferId: string,
    manifestDigest: string,
    ordinal: number,
  ): Promise<Uint8Array | undefined>;
  verifyDestinationStage(
    manifest: SqlTransferSemanticManifest,
    chunks: readonly SqlTransferChunkReceipt[],
  ): Promise<SqlTransferDestinationVerification>;
  previewConfirmation(
    action: SqlTransferConfirmationAction,
    state: SqlTransferJournalState,
  ): Promise<SqlTransferConfirmation>;
  validateConfirmationWithoutSideEffects(
    confirmation: SqlTransferConfirmation,
    state: SqlTransferJournalState,
  ): Promise<"valid" | "invalid" | "stale" | "reused">;
  acquireFreshSourceFence(
    transferId: string,
    prior: SqlTransferSourceFence,
  ): Promise<SqlTransferSourceFence>;
  sealSourceAtomically(
    manifest: SqlTransferSemanticManifest,
    fence: SqlTransferSourceFence,
  ): Promise<SqlTransferSourceSeal>;
  revalidateSourceSeal(
    manifest: SqlTransferSemanticManifest,
    seal: SqlTransferSourceSeal,
  ): Promise<boolean>;
  beginDescriptorRebind(
    manifest: SqlTransferSemanticManifest,
    seal: SqlTransferSourceSeal,
  ): Promise<void>;
  enterDestinationCutoverPending(
    manifest: SqlTransferSemanticManifest,
    seal: SqlTransferSourceSeal,
  ): Promise<void>;
  prepareDestinationActivation(
    manifest: SqlTransferSemanticManifest,
    seal: SqlTransferSourceSeal,
  ): Promise<SqlTransferActivationPlan>;
  readDestinationNodeReadiness(
    transferId: string,
    plan: SqlTransferActivationPlan,
  ): Promise<readonly SqlTransferNodeReadiness[]>;
  revalidateBeforeActivation(state: SqlTransferJournalState): Promise<boolean>;
  destinationActivationStatus(
    transferId: string,
  ): Promise<"inactive" | SqlTransferActivationEvidence>;
  activateDestinationAtomically(
    state: SqlTransferJournalState,
    plan: SqlTransferActivationPlan,
  ): Promise<SqlTransferActivationEvidence>;
  activateDescriptorBinding(
    manifest: SqlTransferSemanticManifest,
    activation: SqlTransferActivationEvidence,
  ): Promise<void>;
  forceHydrateDestinationNodes(
    manifest: SqlTransferSemanticManifest,
    activation: SqlTransferActivationEvidence,
  ): Promise<void>;
  writeFinalizeDestructionIntents(
    state: SqlTransferJournalState,
  ): Promise<SqlTransferDestructionIntentEvidence>;
  finishTransferLedgers(state: SqlTransferJournalState): Promise<void>;
  discardDestinationStage(state: SqlTransferJournalState): Promise<void>;
  restoreSourceDescriptor(state: SqlTransferJournalState): Promise<void>;
  preserveSecurityInvalidationsOnRollback(state: SqlTransferJournalState): Promise<void>;
  unsealSourceAfterRollback(state: SqlTransferJournalState): Promise<void>;
  finishRollbackLedgers(state: SqlTransferJournalState): Promise<void>;
}

export type SqliteToPostgresTransferCoordinatorOptions = Readonly<{
  port: SqliteToPostgresTransferPort;
  failureInjector?: ((point: SqlTransferFailurePoint) => void | Promise<void>) | undefined;
}>;

export interface SqliteToPostgresTransferCoordinator {
  start(request: SqlTransferStartRequest): Promise<SqlTransferJournalState>;
  previewCutover(transferId: string): Promise<SqlTransferConfirmation>;
  cutover(
    transferId: string,
    confirmation: SqlTransferConfirmation | undefined,
  ): Promise<SqlTransferJournalState>;
  previewFinalize(transferId: string): Promise<SqlTransferConfirmation>;
  finalize(
    transferId: string,
    confirmation: SqlTransferConfirmation | undefined,
  ): Promise<SqlTransferJournalState>;
  rollback(transferId: string): Promise<SqlTransferJournalState>;
}

export function createSqliteToPostgresTransferCoordinator(
  options: SqliteToPostgresTransferCoordinatorOptions,
): SqliteToPostgresTransferCoordinator {
  const checkpoint = async (state: SqlTransferJournalState): Promise<void> => {
    assertOneWritableAuthority(state);
    try {
      await options.failureInjector?.(`after-${state.phase}` as SqlTransferFailurePoint);
    } catch (error) {
      if (error instanceof SqlTransferError) throw error;
      throw new SqlTransferError("transfer_interrupted");
    }
  };

  const persist = async (
    current: SqlTransferJournalSnapshot,
    next: SqlTransferJournalState,
  ): Promise<Extract<SqlTransferJournalSnapshot, { status: "present" }>> => {
    assertJournalState(next);
    if (current.status === "present") {
      assertAllowedJournalTransition(current.state.phase, next.phase);
    } else if (next.phase !== "validated") {
      throw new SqlTransferError("journal_corrupt");
    }
    const written = await callTransferPort(() =>
      options.port.journal.compareAndSet(
        next.transferId,
        current.status === "present" ? current.revision : undefined,
        next,
      ),
    );
    if (written === "conflict" || written.status !== "present") {
      throw new SqlTransferError("journal_conflict");
    }
    await checkpoint(written.state);
    return written;
  };

  const load = async (
    transferId: string,
  ): Promise<Extract<SqlTransferJournalSnapshot, { status: "present" }>> => {
    assertTransferId(transferId);
    const journal = await callTransferPort(() => options.port.journal.read(transferId));
    if (journal.status === "absent") throw new SqlTransferError("invalid_phase");
    assertJournalState(journal.state);
    assertOneWritableAuthority(journal.state);
    return journal;
  };

  const validateConfirmation = async (
    action: SqlTransferConfirmationAction,
    current: Extract<SqlTransferJournalSnapshot, { status: "present" }>,
    confirmation: SqlTransferConfirmation | undefined,
  ): Promise<void> => {
    if (!confirmation) throw new SqlTransferError("confirmation_required");
    if (
      confirmation.action !== action ||
      confirmation.transferId !== current.state.transferId ||
      confirmation.manifestDigest !== current.state.manifestDigest
    ) {
      throw new SqlTransferError("confirmation_invalid");
    }
    const validation = await callTransferPort(() =>
      options.port.validateConfirmationWithoutSideEffects(confirmation, current.state),
    );
    if (validation !== "valid") {
      throw new SqlTransferError(
        validation === "stale"
          ? "confirmation_stale"
          : validation === "reused"
            ? "confirmation_reused"
            : "confirmation_invalid",
      );
    }
  };

  return Object.freeze({
    async start(request: SqlTransferStartRequest): Promise<SqlTransferJournalState> {
      assertStartRequest(request);
      let current = await callTransferPort(() => options.port.journal.read(request.transferId));
      if (current.status === "present") {
        assertJournalState(current.state);
        if (!isDeepStrictEqual(current.state.request, request)) {
          throw new SqlTransferError("journal_conflict");
        }
      } else {
        const preflight = await callTransferPort(() => options.port.preflightDestination(request));
        if (!Number.isSafeInteger(preflight.capacityBytes) || preflight.capacityBytes < 0) {
          throw new SqlTransferError("capacity_exceeded");
        }
        current = await persist(current, {
          transferId: request.transferId,
          phase: "validated",
          request: canonicalClone(request),
          destinationCapacityBytes: preflight.capacityBytes,
        });
      }

      for (;;) {
        const state = current.state;
        switch (state.phase) {
          case "validated": {
            const sourceFence = await callTransferPort(() => options.port.quiesceSource(request));
            assertSourceFence(sourceFence);
            current = await persist(current, { ...state, phase: "source-quiesced", sourceFence });
            break;
          }
          case "source-quiesced": {
            const sourceFence = requireSourceFence(state);
            await callTransferPort(() =>
              options.port.checkpointSourceWal(state.transferId, sourceFence),
            );
            current = await persist(current, { ...state, phase: "source-checkpointed" });
            break;
          }
          case "source-checkpointed": {
            const sourceFence = requireSourceFence(state);
            await callTransferPort(() =>
              options.port.verifySourceIntegrity(state.transferId, sourceFence),
            );
            current = await persist(current, { ...state, phase: "source-integrity-verified" });
            break;
          }
          case "source-integrity-verified": {
            const manifest = await callTransferPort(() =>
              options.port.createSemanticManifest(request, requireSourceFence(state)),
            );
            assertManifestMatchesRequest(manifest, request, requireSourceFence(state));
            if (manifest.totalBytes > state.destinationCapacityBytes) {
              throw new SqlTransferError("capacity_exceeded");
            }
            current = await persist(current, {
              ...state,
              phase: "manifest-recorded",
              manifest: canonicalClone(manifest),
              manifestDigest: sqlTransferManifestDigest(manifest),
            });
            break;
          }
          case "manifest-recorded": {
            const manifest = requireManifest(state);
            const manifestDigest = requireManifestDigest(state);
            const backup = await callTransferPort(() =>
              options.port.createRecoveryBackup(manifest, manifestDigest),
            );
            assertBackupEvidence(backup, manifestDigest);
            current = await persist(current, {
              ...state,
              phase: "backup-durable",
              backup: canonicalClone(backup),
            });
            break;
          }
          case "backup-durable": {
            current = await persist(current, {
              ...state,
              phase: "destination-staging",
              chunks: [],
            });
            break;
          }
          case "destination-staging": {
            const manifest = requireManifest(state);
            const chunks = state.chunks ?? [];
            if (chunks.length < manifest.chunkCount) {
              const ordinal = chunks.length;
              const bytes = await callTransferPort(() =>
                options.port.readTransferChunk(manifest, ordinal),
              );
              if (
                !bytes ||
                !(bytes instanceof Uint8Array) ||
                bytes.byteLength === 0 ||
                bytes.byteLength > manifest.maxChunkBytes
              ) {
                throw new SqlTransferError("chunk_invalid");
              }
              const receipt: SqlTransferChunkReceipt = {
                ordinal,
                byteLength: bytes.byteLength,
                sha256: sha256(bytes),
              };
              await callTransferPort(() =>
                options.port.stageDestinationChunk(
                  state.transferId,
                  requireManifestDigest(state),
                  receipt,
                  bytes,
                ),
              );
              const readback = await callTransferPort(() =>
                options.port.readDestinationChunk(
                  state.transferId,
                  requireManifestDigest(state),
                  ordinal,
                ),
              );
              if (
                !readback ||
                readback.byteLength !== receipt.byteLength ||
                sha256(readback) !== receipt.sha256
              ) {
                throw new SqlTransferError("chunk_invalid");
              }
              current = await persist(current, {
                ...state,
                chunks: [...chunks, receipt],
              });
              break;
            }
            const totalBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
            if (totalBytes !== manifest.totalBytes) throw new SqlTransferError("chunk_invalid");
            const verification = await callTransferPort(() =>
              options.port.verifyDestinationStage(manifest, chunks),
            );
            assertDestinationVerification(manifest, verification);
            current = await persist(current, {
              ...state,
              phase: "destination-verified",
              destinationVerification: canonicalClone(verification),
            });
            break;
          }
          case "destination-verified":
          case "seal-fence-acquired":
          case "source-sealed":
          case "descriptor-pending":
          case "destination-pending":
          case "destination-ready":
          case "destination-activated":
          case "descriptor-rebound":
          case "destination-hydrated":
          case "destruction-intents-durable":
          case "completed":
            return state;
          case "rollback-pending":
          case "rollback-staging-discarded":
          case "rollback-descriptor-restored":
          case "rollback-invalidations-preserved":
          case "rolled-back":
            throw new SqlTransferError("invalid_phase");
        }
      }
    },

    async previewCutover(transferId: string): Promise<SqlTransferConfirmation> {
      const current = await load(transferId);
      if (current.state.phase !== "destination-verified") {
        throw new SqlTransferError("invalid_phase");
      }
      return callTransferPort(() => options.port.previewConfirmation("cutover", current.state));
    },

    async cutover(
      transferId: string,
      confirmation: SqlTransferConfirmation | undefined,
    ): Promise<SqlTransferJournalState> {
      if (!confirmation) throw new SqlTransferError("confirmation_required");
      let current = await load(transferId);
      await validateConfirmation("cutover", current, confirmation);
      for (;;) {
        const state = current.state;
        switch (state.phase) {
          case "destination-verified": {
            const freshFence = await callTransferPort(() =>
              options.port.acquireFreshSourceFence(state.transferId, requireSourceFence(state)),
            );
            assertFreshSourceFence(requireSourceFence(state), freshFence);
            current = await persist(current, {
              ...state,
              phase: "seal-fence-acquired",
              sealFence: freshFence,
            });
            break;
          }
          case "seal-fence-acquired": {
            const manifest = requireManifest(state);
            const seal = await callTransferPort(() =>
              options.port.sealSourceAtomically(manifest, requireSealFence(state)),
            );
            assertSourceSeal(manifest, requireSealFence(state), seal);
            current = await persist(current, {
              ...state,
              phase: "source-sealed",
              sourceSeal: canonicalClone(seal),
            });
            break;
          }
          case "source-sealed":
            await callTransferPort(() =>
              options.port.beginDescriptorRebind(requireManifest(state), requireSourceSeal(state)),
            );
            current = await persist(current, { ...state, phase: "descriptor-pending" });
            break;
          case "descriptor-pending":
            await callTransferPort(() =>
              options.port.enterDestinationCutoverPending(
                requireManifest(state),
                requireSourceSeal(state),
              ),
            );
            current = await persist(current, { ...state, phase: "destination-pending" });
            break;
          case "destination-pending": {
            const plan = await callTransferPort(() =>
              options.port.prepareDestinationActivation(
                requireManifest(state),
                requireSourceSeal(state),
              ),
            );
            assertActivationPlan(requireManifest(state), plan);
            current = await persist(current, {
              ...state,
              phase: "destination-ready",
              activationPlan: canonicalClone(plan),
            });
            break;
          }
          case "destination-ready": {
            const readiness = await callTransferPort(() =>
              options.port.readDestinationNodeReadiness(
                state.transferId,
                requireActivationPlan(state),
              ),
            );
            assertDestinationReadiness(requireActivationPlan(state), readiness);
            return state;
          }
          case "destination-activated":
          case "descriptor-rebound":
          case "destination-hydrated":
          case "destruction-intents-durable":
          case "completed":
            return state;
          default:
            throw new SqlTransferError("invalid_phase");
        }
      }
    },

    async previewFinalize(transferId: string): Promise<SqlTransferConfirmation> {
      const current = await load(transferId);
      if (current.state.phase !== "destination-ready") {
        throw new SqlTransferError("invalid_phase");
      }
      const readiness = await callTransferPort(() =>
        options.port.readDestinationNodeReadiness(
          current.state.transferId,
          requireActivationPlan(current.state),
        ),
      );
      assertDestinationReadiness(requireActivationPlan(current.state), readiness);
      return callTransferPort(() => options.port.previewConfirmation("finalize", current.state));
    },

    async finalize(
      transferId: string,
      confirmation: SqlTransferConfirmation | undefined,
    ): Promise<SqlTransferJournalState> {
      if (!confirmation) throw new SqlTransferError("confirmation_required");
      let current = await load(transferId);
      await validateConfirmation("finalize", current, confirmation);
      for (;;) {
        const state = current.state;
        switch (state.phase) {
          case "destination-ready": {
            if (
              !(await callTransferPort(() =>
                options.port.revalidateSourceSeal(requireManifest(state), requireSourceSeal(state)),
              )) ||
              !(await callTransferPort(() => options.port.revalidateBeforeActivation(state)))
            ) {
              throw new SqlTransferError("source_seal_invalid");
            }
            const plan = requireActivationPlan(state);
            const readiness = await callTransferPort(() =>
              options.port.readDestinationNodeReadiness(state.transferId, plan),
            );
            assertDestinationReadiness(plan, readiness);
            const status = await callTransferPort(() =>
              options.port.destinationActivationStatus(state.transferId),
            );
            const activation =
              status === "inactive"
                ? await callTransferPort(() =>
                    options.port.activateDestinationAtomically(state, plan),
                  )
                : status;
            assertActivationEvidence(plan, activation);
            current = await persist(current, {
              ...state,
              phase: "destination-activated",
              activation: canonicalClone(activation),
            });
            break;
          }
          case "destination-activated":
            await callTransferPort(() =>
              options.port.activateDescriptorBinding(
                requireManifest(state),
                requireActivation(state),
              ),
            );
            current = await persist(current, { ...state, phase: "descriptor-rebound" });
            break;
          case "descriptor-rebound":
            await callTransferPort(() =>
              options.port.forceHydrateDestinationNodes(
                requireManifest(state),
                requireActivation(state),
              ),
            );
            current = await persist(current, { ...state, phase: "destination-hydrated" });
            break;
          case "destination-hydrated": {
            const intents = await callTransferPort(() =>
              options.port.writeFinalizeDestructionIntents(state),
            );
            if (
              !Number.isSafeInteger(intents.intentCount) ||
              intents.intentCount < 1 ||
              !SHA256_PATTERN.test(intents.intentDigest)
            ) {
              throw new SqlTransferError("transfer_interrupted");
            }
            current = await persist(current, {
              ...state,
              phase: "destruction-intents-durable",
              destructionIntents: canonicalClone(intents),
            });
            break;
          }
          case "destruction-intents-durable":
            await callTransferPort(() => options.port.finishTransferLedgers(state));
            current = await persist(current, { ...state, phase: "completed" });
            break;
          case "completed":
            return state;
          default:
            throw new SqlTransferError(
              phaseHasDurableActivation(state.phase) ? "invalid_phase" : "activation_conflict",
            );
        }
      }
    },

    async rollback(transferId: string): Promise<SqlTransferJournalState> {
      let current = await load(transferId);
      const activation = await callTransferPort(() =>
        options.port.destinationActivationStatus(transferId),
      );
      if (activation !== "inactive" || phaseHasDurableActivation(current.state.phase)) {
        throw new SqlTransferError("rollback_forbidden");
      }
      if (current.state.phase === "rolled-back") return current.state;
      if (!current.state.phase.startsWith("rollback-")) {
        current = await persist(current, {
          ...current.state,
          phase: "rollback-pending",
          rollbackFromPhase: current.state.phase,
        });
      }
      for (;;) {
        const state = current.state;
        switch (state.phase) {
          case "rollback-pending":
            await callTransferPort(() => options.port.discardDestinationStage(state));
            current = await persist(current, {
              ...state,
              phase: "rollback-staging-discarded",
            });
            break;
          case "rollback-staging-discarded":
            await callTransferPort(() => options.port.restoreSourceDescriptor(state));
            current = await persist(current, {
              ...state,
              phase: "rollback-descriptor-restored",
            });
            break;
          case "rollback-descriptor-restored":
            await callTransferPort(() =>
              options.port.preserveSecurityInvalidationsOnRollback(state),
            );
            current = await persist(current, {
              ...state,
              phase: "rollback-invalidations-preserved",
            });
            break;
          case "rollback-invalidations-preserved":
            await callTransferPort(() => options.port.unsealSourceAfterRollback(state));
            await callTransferPort(() => options.port.finishRollbackLedgers(state));
            current = await persist(current, { ...state, phase: "rolled-back" });
            break;
          case "rolled-back":
            return state;
          default:
            throw new SqlTransferError("journal_corrupt");
        }
      }
    },
  });
}

export type SqlTransferJournalRepositoryOptions = Readonly<{
  identity: ControlPlaneStoreIdentity;
  source: ControlPlaneTransactionalDialect;
  destination: ControlPlaneTransactionalDialect;
}>;

/**
 * Durable paired-ledger repository. Source is the serialization authority; a crash between writes
 * leaves it exactly one revision ahead, which the next read repairs into Postgres before resuming.
 */
export function createSqlTransferJournalRepository(
  options: SqlTransferJournalRepositoryOptions,
): SqlTransferJournalPort {
  if (options.source.backend !== "sqlite" || options.destination.backend !== "postgres") {
    throw new SqlTransferError("invalid_request");
  }
  assertIdentity(options.identity);

  return Object.freeze({
    async read(transferId: string): Promise<SqlTransferJournalSnapshot> {
      assertTransferId(transferId);
      const [source, destination] = await Promise.all([
        readLedger(options.source, options.identity, transferId),
        readLedger(options.destination, options.identity, transferId),
      ]);
      if (!source && !destination) return { status: "absent" };
      if (!source || !destination) {
        if (!source) throw new SqlTransferError("journal_desynchronized");
        await writeLedger(options.destination, options.identity, transferId, undefined, source);
        return source;
      }
      if (source.revision === destination.revision) {
        if (!isDeepStrictEqual(source.state, destination.state)) {
          throw new SqlTransferError("journal_desynchronized");
        }
        return source;
      }
      if (source.revision !== destination.revision + 1) {
        throw new SqlTransferError("journal_desynchronized");
      }
      assertAllowedJournalTransition(destination.state.phase, source.state.phase);
      await writeLedger(
        options.destination,
        options.identity,
        transferId,
        destination.revision,
        source,
      );
      return source;
    },

    async compareAndSet(
      transferId: string,
      expectedRevision: number | undefined,
      next: SqlTransferJournalState,
    ): Promise<SqlTransferJournalSnapshot | "conflict"> {
      assertTransferId(transferId);
      assertJournalState(next);
      if (
        next.transferId !== transferId ||
        !isDeepStrictEqual(next.request.identity, options.identity)
      ) {
        throw new SqlTransferError("journal_conflict");
      }
      const snapshot = {
        status: "present" as const,
        revision: expectedRevision === undefined ? 0 : expectedRevision + 1,
        state: canonicalClone(next),
      };
      const sourceWrite = await writeLedger(
        options.source,
        options.identity,
        transferId,
        expectedRevision,
        snapshot,
      );
      if (sourceWrite === "conflict") return "conflict";
      const destinationWrite = await writeLedger(
        options.destination,
        options.identity,
        transferId,
        expectedRevision,
        snapshot,
      );
      if (destinationWrite === "conflict") {
        throw new SqlTransferError("journal_desynchronized");
      }
      return snapshot;
    },
  });
}

export function sqlTransferAuthorityState(state: SqlTransferJournalState): Readonly<{
  sourceWritable: boolean;
  destinationWritable: boolean;
}> {
  const destinationWritable = phaseHasDurableActivation(state.phase);
  const sourceWritable =
    state.phase === "rolled-back" || (!state.sourceSeal && !destinationWritable);
  return { sourceWritable, destinationWritable };
}

type TransferJournalDocument = Readonly<{
  version: typeof SQL_TRANSFER_JOURNAL_VERSION;
  kind: typeof JOURNAL_KIND;
  revision: number;
  state: SqlTransferJournalState;
}>;

type TransferMigrationRow = ControlPlaneDatabaseRow & {
  migrationId: string;
  source: string;
  destination: string;
  phase: string;
  manifestHash: string;
  checksum: string;
  stateDocument: unknown;
  createdAt: string;
  activatedAt?: string | undefined;
};

async function readLedger(
  dialect: ControlPlaneTransactionalDialect,
  identity: ControlPlaneStoreIdentity,
  transferId: string,
): Promise<Extract<SqlTransferJournalSnapshot, { status: "present" }> | undefined> {
  return dialect.maintenanceTransaction(async (transaction) => {
    await transaction.lock(transferJournalLock(identity, transferId));
    const row = await readTransferRow(transaction, identity, transferId);
    return row ? decodeTransferRow(row, identity, transferId) : undefined;
  });
}

async function writeLedger(
  dialect: ControlPlaneTransactionalDialect,
  identity: ControlPlaneStoreIdentity,
  transferId: string,
  expectedRevision: number | undefined,
  next: Extract<SqlTransferJournalSnapshot, { status: "present" }>,
): Promise<"written" | "conflict"> {
  return dialect.maintenanceTransaction(async (transaction) => {
    await transaction.lock(transferJournalLock(identity, transferId));
    const existing = await readTransferRow(transaction, identity, transferId);
    if (existing) {
      const current = decodeTransferRow(existing, identity, transferId);
      if (current.revision === next.revision && isDeepStrictEqual(current.state, next.state)) {
        return "written";
      }
      if (current.revision !== expectedRevision) return "conflict";
      assertAllowedJournalTransition(current.state.phase, next.state.phase);
    } else if (expectedRevision !== undefined) {
      return "conflict";
    }

    const now = await transaction.databaseTime();
    const document: TransferJournalDocument = {
      version: SQL_TRANSFER_JOURNAL_VERSION,
      kind: JOURNAL_KIND,
      revision: next.revision,
      state: canonicalClone(next.state),
    };
    const checksum = hashCanonical(document);
    const values = {
      ...(existing
        ? {}
        : await migrationBaseRow(transaction, identity, `u12-transfer:${transferId}`, now)),
      updatedAt: now,
      phase: databaseMigrationPhase(next.state.phase),
      manifestHash: next.state.manifestDigest ?? EMPTY_MANIFEST_DIGEST,
      checksum,
      compatibility: databaseJson(transaction, {
        protocol: JOURNAL_KIND,
        revision: next.revision,
      }),
      stateDocument: databaseJson(transaction, document),
      ...(phaseHasDurableActivation(next.state.phase)
        ? { activatedAt: existing?.activatedAt ?? now }
        : {}),
    };
    const count = existing
      ? await transaction.update(
          "migrations",
          values,
          transferScope(identity, { migrationId: transferId, checksum: existing.checksum }),
        )
      : await transaction.insert("migrations", {
          ...values,
          migrationId: transferId,
          source: "sqlite",
          destination: "postgres",
        });
    if (count !== 1) return "conflict";
    const readback = await readTransferRow(transaction, identity, transferId);
    if (!readback || !isDeepStrictEqual(decodeTransferRow(readback, identity, transferId), next)) {
      throw new SqlTransferError("journal_corrupt");
    }
    return "written";
  });
}

async function readTransferRow(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  transferId: string,
): Promise<TransferMigrationRow | undefined> {
  const [row] = await transaction.select<TransferMigrationRow>(
    "migrations",
    transferScope(identity, { migrationId: transferId }),
    [],
    1,
  );
  return row;
}

function decodeTransferRow(
  row: TransferMigrationRow,
  identity: ControlPlaneStoreIdentity,
  transferId: string,
): Extract<SqlTransferJournalSnapshot, { status: "present" }> {
  try {
    if (
      row.migrationId !== transferId ||
      row.source !== "sqlite" ||
      row.destination !== "postgres" ||
      !SHA256_PATTERN.test(row.checksum)
    ) {
      throw new Error("invalid transfer row");
    }
    const decoded =
      typeof row.stateDocument === "string"
        ? decodeCanonicalJson(row.stateDocument)
        : row.stateDocument;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("invalid transfer document");
    }
    const document = decoded as unknown as TransferJournalDocument;
    if (
      document.version !== SQL_TRANSFER_JOURNAL_VERSION ||
      document.kind !== JOURNAL_KIND ||
      !Number.isSafeInteger(document.revision) ||
      document.revision < 0 ||
      hashCanonical(document) !== row.checksum
    ) {
      throw new Error("invalid transfer checksum");
    }
    assertJournalState(document.state);
    if (
      document.state.transferId !== transferId ||
      !isDeepStrictEqual(document.state.request.identity, identity) ||
      row.manifestHash !== (document.state.manifestDigest ?? EMPTY_MANIFEST_DIGEST) ||
      row.phase !== databaseMigrationPhase(document.state.phase)
    ) {
      throw new Error("invalid transfer binding");
    }
    return { status: "present", revision: document.revision, state: document.state };
  } catch (error) {
    if (error instanceof SqlTransferError) throw error;
    throw new SqlTransferError("journal_corrupt");
  }
}

async function migrationBaseRow(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  id: string,
  now: string,
): Promise<Readonly<Record<string, unknown>>> {
  const [authority] = await transaction.select<ControlPlaneDatabaseRow>(
    "authorityVersions",
    transferScope(identity),
    [{ column: "generation", direction: "desc" }],
    1,
  );
  const [effective] = await transaction.select<ControlPlaneDatabaseRow>(
    "effectiveVersions",
    transferScope(identity),
    [{ column: "generation", direction: "desc" }],
    1,
  );
  const [security] = await transaction.select<ControlPlaneDatabaseRow>(
    "securityVersions",
    transferScope(identity),
    [{ column: "epoch", direction: "desc" }],
    1,
  );
  return {
    modelVersion: 1,
    id,
    logicalHostId: identity.logicalHostId,
    storeId: identity.storeId,
    createdAt: now,
    aggregateVersion: 0,
    authorityVersion: numericRowValue(authority?.generation),
    effectiveVersion: numericRowValue(effective?.generation),
    securityVersion: numericRowValue(security?.epoch),
  };
}

function assertJournalState(state: SqlTransferJournalState): void {
  try {
    if (
      !state ||
      typeof state !== "object" ||
      !SQL_TRANSFER_PHASES.includes(state.phase) ||
      state.transferId !== state.request.transferId ||
      !Number.isSafeInteger(state.destinationCapacityBytes) ||
      state.destinationCapacityBytes < 0
    ) {
      throw new Error("invalid journal state");
    }
    assertStartRequest(state.request);
    if (state.sourceFence) assertSourceFence(state.sourceFence);
    if (state.manifest) {
      assertSqlTransferSemanticManifest(state.manifest);
      if (
        !state.manifestDigest ||
        sqlTransferManifestDigest(state.manifest) !== state.manifestDigest
      ) {
        throw new Error("invalid journal manifest");
      }
      assertManifestMatchesRequest(state.manifest, state.request, requireSourceFence(state));
    } else if (state.manifestDigest) {
      throw new Error("orphan journal manifest digest");
    }
    if (state.chunks) {
      for (const [ordinal, chunk] of state.chunks.entries()) {
        if (
          chunk.ordinal !== ordinal ||
          !Number.isSafeInteger(chunk.byteLength) ||
          chunk.byteLength < 1 ||
          chunk.byteLength > state.request.maxChunkBytes ||
          !SHA256_PATTERN.test(chunk.sha256)
        ) {
          throw new Error("invalid chunk journal");
        }
      }
      if (state.manifest && state.chunks.length > state.manifest.chunkCount) {
        throw new Error("excess chunk journal");
      }
    }
    if (
      phaseRequiresManifest(state.phase) &&
      !state.manifest &&
      !state.phase.startsWith("rollback-") &&
      state.phase !== "rolled-back"
    ) {
      throw new Error("missing journal manifest");
    }
    if (phaseRequiresSeal(state.phase) && !state.sourceSeal) {
      throw new Error("missing source seal");
    }
    if (phaseHasDurableActivation(state.phase) && !state.activation) {
      throw new Error("missing activation evidence");
    }
    if (state.activation && !state.sourceSeal) {
      throw new Error("activation lacks source seal");
    }
    if (state.phase === "rolled-back" && state.activation) {
      throw new Error("activated transfer rolled back");
    }
    assertOneWritableAuthority(state);
  } catch (error) {
    if (error instanceof SqlTransferError) throw error;
    throw new SqlTransferError("journal_corrupt");
  }
}

function assertStartRequest(request: SqlTransferStartRequest): void {
  try {
    assertTransferId(request.transferId);
    assertIdentity(request.identity);
    if (
      !SHA256_PATTERN.test(request.sourceDescriptorDigest) ||
      !SHA256_PATTERN.test(request.destinationDescriptorDigest) ||
      !SAFE_TRANSFER_ID.test(request.sourceKeyProviderIdentity) ||
      !SAFE_TRANSFER_ID.test(request.destinationKeyProviderIdentity) ||
      request.sourceKeyProviderIdentity === request.destinationKeyProviderIdentity ||
      !Number.isSafeInteger(request.maxChunkBytes) ||
      request.maxChunkBytes < 1 ||
      request.maxChunkBytes > MAX_SQL_TRANSFER_CHUNK_BYTES
    ) {
      throw new Error("invalid transfer request");
    }
  } catch (error) {
    if (error instanceof SqlTransferError) throw error;
    throw new SqlTransferError("invalid_request");
  }
}

function assertIdentity(identity: SqlTransferIdentity): void {
  if (
    !identity ||
    typeof identity !== "object" ||
    !SAFE_TRANSFER_ID.test(identity.logicalHostId) ||
    !SAFE_TRANSFER_ID.test(identity.storeId) ||
    !SAFE_TRANSFER_ID.test(identity.operationNamespace)
  ) {
    throw new SqlTransferError("invalid_request");
  }
}

function assertManifestMatchesRequest(
  manifest: SqlTransferSemanticManifest,
  request: SqlTransferStartRequest,
  fence: SqlTransferSourceFence,
): void {
  try {
    assertSqlTransferSemanticManifest(manifest);
  } catch {
    throw new SqlTransferError("manifest_mismatch");
  }
  if (
    manifest.transferId !== request.transferId ||
    !isDeepStrictEqual(manifest.identity, request.identity) ||
    manifest.source.descriptorDigest !== request.sourceDescriptorDigest ||
    manifest.destination.descriptorDigest !== request.destinationDescriptorDigest ||
    manifest.source.keyProviderIdentity !== request.sourceKeyProviderIdentity ||
    manifest.destination.keyProviderIdentity !== request.destinationKeyProviderIdentity ||
    manifest.maxChunkBytes !== request.maxChunkBytes ||
    manifest.sourceAuthorityGeneration !== fence.authorityGeneration ||
    manifest.sourceSecurityEpoch !== fence.securityEpoch ||
    manifest.sourceWriterEpoch !== fence.writerEpoch
  ) {
    throw new SqlTransferError("manifest_mismatch");
  }
}

function assertDestinationVerification(
  manifest: SqlTransferSemanticManifest,
  verification: SqlTransferDestinationVerification,
): void {
  const semanticDigest = hashCanonical(manifest.semanticDomains);
  const consumedOperations = manifest.semanticDomains.find(
    (domain) => domain.name === "consumed-operations",
  );
  if (
    verification.manifestDigest !== sqlTransferManifestDigest(manifest) ||
    verification.semanticDigest !== semanticDigest ||
    verification.consumedOperationsDigest !== consumedOperations?.sha256
  ) {
    throw new SqlTransferError("manifest_mismatch");
  }
}

function assertBackupEvidence(evidence: SqlTransferBackupEvidence, manifestDigest: string): void {
  if (
    !SAFE_TRANSFER_ID.test(evidence.backupId) ||
    evidence.manifestDigest !== manifestDigest ||
    !SHA256_PATTERN.test(evidence.recoveryAuthorityDigest)
  ) {
    throw new SqlTransferError("manifest_mismatch");
  }
}

function assertSourceFence(fence: SqlTransferSourceFence): void {
  if (
    !SAFE_TRANSFER_ID.test(fence.fenceId) ||
    !Number.isSafeInteger(fence.writerEpoch) ||
    fence.writerEpoch < 0 ||
    !Number.isSafeInteger(fence.authorityGeneration) ||
    fence.authorityGeneration < 0 ||
    !Number.isSafeInteger(fence.securityEpoch) ||
    fence.securityEpoch < 0
  ) {
    throw new SqlTransferError("transfer_interrupted");
  }
}

function assertFreshSourceFence(
  prior: SqlTransferSourceFence,
  fresh: SqlTransferSourceFence,
): void {
  assertSourceFence(fresh);
  if (
    fresh.fenceId === prior.fenceId ||
    fresh.writerEpoch <= prior.writerEpoch ||
    fresh.authorityGeneration !== prior.authorityGeneration ||
    fresh.securityEpoch !== prior.securityEpoch
  ) {
    throw new SqlTransferError("source_seal_invalid");
  }
}

function assertSourceSeal(
  manifest: SqlTransferSemanticManifest,
  fence: SqlTransferSourceFence,
  seal: SqlTransferSourceSeal,
): void {
  if (
    seal.manifestDigest !== sqlTransferManifestDigest(manifest) ||
    seal.sealedSourceDigest !== manifest.expectedSealedSourceDigest ||
    seal.invalidationDigest !== manifest.invalidationDigest ||
    seal.authorityGeneration !== manifest.sourceAuthorityGeneration ||
    seal.securityEpoch !== manifest.projectedSecurityEpoch ||
    seal.writerEpoch !== fence.writerEpoch
  ) {
    throw new SqlTransferError("source_seal_invalid");
  }
}

function assertActivationPlan(
  manifest: SqlTransferSemanticManifest,
  plan: SqlTransferActivationPlan,
): void {
  if (
    plan.authorityGeneration !== manifest.destinationAuthorityGeneration ||
    !SHA256_PATTERN.test(plan.authorityTokenDigest) ||
    !SHA256_PATTERN.test(plan.keyCanaryDigest) ||
    !Number.isSafeInteger(plan.writerEpoch) ||
    plan.writerEpoch < 0 ||
    !isDeepStrictEqual(plan.requiredNodeIds, manifest.requiredDestinationNodeIds)
  ) {
    throw new SqlTransferError("destination_not_ready");
  }
}

function assertDestinationReadiness(
  plan: SqlTransferActivationPlan,
  readiness: readonly SqlTransferNodeReadiness[],
): void {
  if (readiness.length !== plan.requiredNodeIds.length) {
    throw new SqlTransferError("destination_not_ready");
  }
  for (const [index, node] of readiness.entries()) {
    if (
      node.nodeId !== plan.requiredNodeIds[index] ||
      node.authorityGeneration !== plan.authorityGeneration ||
      node.authorityTokenDigest !== plan.authorityTokenDigest ||
      node.keyCanaryDigest !== plan.keyCanaryDigest ||
      node.writerEpoch !== plan.writerEpoch
    ) {
      throw new SqlTransferError("destination_not_ready");
    }
  }
}

function assertActivationEvidence(
  plan: SqlTransferActivationPlan,
  activation: SqlTransferActivationEvidence,
): void {
  if (
    !SHA256_PATTERN.test(activation.markerDigest) ||
    activation.authorityGeneration !== plan.authorityGeneration ||
    activation.authorityTokenDigest !== plan.authorityTokenDigest ||
    activation.keyCanaryDigest !== plan.keyCanaryDigest ||
    activation.writerEpoch !== plan.writerEpoch
  ) {
    throw new SqlTransferError("activation_conflict");
  }
}

function assertOneWritableAuthority(state: SqlTransferJournalState): void {
  const authority = sqlTransferAuthorityState(state);
  if (authority.sourceWritable && authority.destinationWritable) {
    throw new SqlTransferError("one_authority_violation");
  }
}

function assertAllowedJournalTransition(from: SqlTransferPhase, to: SqlTransferPhase): void {
  const linear: Partial<Record<SqlTransferPhase, SqlTransferPhase>> = {
    validated: "source-quiesced",
    "source-quiesced": "source-checkpointed",
    "source-checkpointed": "source-integrity-verified",
    "source-integrity-verified": "manifest-recorded",
    "manifest-recorded": "backup-durable",
    "backup-durable": "destination-staging",
    "destination-staging": "destination-verified",
    "destination-verified": "seal-fence-acquired",
    "seal-fence-acquired": "source-sealed",
    "source-sealed": "descriptor-pending",
    "descriptor-pending": "destination-pending",
    "destination-pending": "destination-ready",
    "destination-ready": "destination-activated",
    "destination-activated": "descriptor-rebound",
    "descriptor-rebound": "destination-hydrated",
    "destination-hydrated": "destruction-intents-durable",
    "destruction-intents-durable": "completed",
    "rollback-pending": "rollback-staging-discarded",
    "rollback-staging-discarded": "rollback-descriptor-restored",
    "rollback-descriptor-restored": "rollback-invalidations-preserved",
    "rollback-invalidations-preserved": "rolled-back",
  };
  if (linear[from] === to) return;
  if (to === "destination-staging" && from === "destination-staging") return;
  if (to === "rollback-pending" && !phaseHasDurableActivation(from) && from !== "rolled-back")
    return;
  throw new SqlTransferError("journal_corrupt");
}

function phaseRequiresManifest(phase: SqlTransferPhase): boolean {
  return ![
    "validated",
    "source-quiesced",
    "source-checkpointed",
    "source-integrity-verified",
  ].includes(phase);
}

function phaseRequiresSeal(phase: SqlTransferPhase): boolean {
  return [
    "source-sealed",
    "descriptor-pending",
    "destination-pending",
    "destination-ready",
    "destination-activated",
    "descriptor-rebound",
    "destination-hydrated",
    "destruction-intents-durable",
    "completed",
  ].includes(phase);
}

function phaseHasDurableActivation(phase: SqlTransferPhase): boolean {
  return [
    "destination-activated",
    "descriptor-rebound",
    "destination-hydrated",
    "destruction-intents-durable",
    "completed",
  ].includes(phase);
}

function databaseMigrationPhase(
  phase: SqlTransferPhase,
): "discovered" | "staged" | "verified" | "activated" | "finalized" | "rolled-back" {
  if (phase === "rolled-back") return "rolled-back";
  if (phase === "completed") return "finalized";
  if (phaseHasDurableActivation(phase)) return "activated";
  if (
    [
      "destination-verified",
      "seal-fence-acquired",
      "source-sealed",
      "descriptor-pending",
      "destination-pending",
      "destination-ready",
    ].includes(phase)
  ) {
    return "verified";
  }
  if (["backup-durable", "destination-staging"].includes(phase)) return "staged";
  return "discovered";
}

function requireSourceFence(state: SqlTransferJournalState): SqlTransferSourceFence {
  if (!state.sourceFence) throw new SqlTransferError("journal_corrupt");
  return state.sourceFence;
}

function requireSealFence(state: SqlTransferJournalState): SqlTransferSourceFence {
  if (!state.sealFence) throw new SqlTransferError("journal_corrupt");
  return state.sealFence;
}

function requireManifest(state: SqlTransferJournalState): SqlTransferSemanticManifest {
  if (!state.manifest) throw new SqlTransferError("journal_corrupt");
  return state.manifest;
}

function requireManifestDigest(state: SqlTransferJournalState): string {
  if (!state.manifestDigest) throw new SqlTransferError("journal_corrupt");
  return state.manifestDigest;
}

function requireSourceSeal(state: SqlTransferJournalState): SqlTransferSourceSeal {
  if (!state.sourceSeal) throw new SqlTransferError("journal_corrupt");
  return state.sourceSeal;
}

function requireActivationPlan(state: SqlTransferJournalState): SqlTransferActivationPlan {
  if (!state.activationPlan) throw new SqlTransferError("journal_corrupt");
  return state.activationPlan;
}

function requireActivation(state: SqlTransferJournalState): SqlTransferActivationEvidence {
  if (!state.activation) throw new SqlTransferError("journal_corrupt");
  return state.activation;
}

async function callTransferPort<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SqlTransferError) throw error;
    throw new SqlTransferError("transfer_interrupted");
  }
}

function transferScope(
  identity: SqlTransferIdentity,
  equals: Readonly<Record<string, unknown>> = {},
) {
  return {
    equals: {
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      ...equals,
    },
  } as const;
}

function transferJournalLock(identity: SqlTransferIdentity, transferId: string): string {
  return `u12:${identity.logicalHostId}:${identity.storeId}:${transferId}`;
}

function databaseJson(transaction: ControlPlaneSqlTransaction, value: unknown): unknown {
  const canonical = canonicalClone(value);
  return transaction.backend === "sqlite" ? encodeCanonicalJson(canonical) : canonical;
}

function numericRowValue(value: unknown): number {
  const decoded = typeof value === "bigint" ? Number(value) : value;
  return Number.isSafeInteger(decoded) && (decoded as number) >= 0 ? (decoded as number) : 0;
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(stableJsonStringify(value)) as T;
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertTransferId(transferId: string): void {
  if (typeof transferId !== "string" || !SAFE_TRANSFER_ID.test(transferId)) {
    throw new SqlTransferError("invalid_request");
  }
}

export function sameSqlTransferJournalState(
  left: SqlTransferJournalState,
  right: SqlTransferJournalState,
): boolean {
  assertJournalState(left);
  assertJournalState(right);
  if (
    left.manifest &&
    right.manifest &&
    !sameSqlTransferSemanticManifest(left.manifest, right.manifest)
  ) {
    return false;
  }
  return isDeepStrictEqual(left, right);
}

export function sqlTransferSemanticDomainDigest(manifest: SqlTransferSemanticManifest): string {
  assertSqlTransferSemanticManifest(manifest);
  return hashCanonical(manifest.semanticDomains);
}

export function isSqlTransferError(error: unknown, code?: SqlTransferErrorCode): boolean {
  return error instanceof SqlTransferError && (code === undefined || error.code === code);
}

export function sqlTransferPersistenceError(message: string): CapletsError {
  return new CapletsError("CONFIG_INVALID", message);
}
