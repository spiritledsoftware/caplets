import { isDeepStrictEqual } from "node:util";
import { stableJsonStringify } from "../../stable-json";
import type { CurrentHostOperationBinding } from "../../current-host/operations";
import {
  mergeBackupInventorySnapshots,
  type BackupInventoryRecord,
  type RecoveryEnvelopeBinding,
  type RecoveryEnvelopeReadResult,
} from "./backup";

export type RestoreIdentity = Readonly<{
  logicalHostId: string;
  storeId: string;
  operationNamespace: string;
}>;

export type RestoreDomainRow = Readonly<{
  entityId: string;
  value: Readonly<Record<string, unknown>>;
  /** Rows at or below the current cutoff were already purged and cannot be resurrected. */
  retentionOrdinal?: number | undefined;
}>;

export type RestoreMonotonicEntry = Readonly<{
  id: string;
  generation: number;
  state: string;
  detail?: Readonly<Record<string, unknown>> | undefined;
}>;

/** Restore inventory always uses the canonical protected-backup inventory record. */
export type RestoreBackupInventoryEntry = BackupInventoryRecord;
export type RestoreOperationBinding = CurrentHostOperationBinding;

export type RestoreEffectCommitment = Readonly<{
  entityId: string;
  after:
    | Readonly<{ kind: "present"; value: Readonly<Record<string, unknown>> }>
    | Readonly<{ kind: "absent" }>;
}>;

export type RestoreOperationOutcome = Readonly<{
  binding: RestoreOperationBinding;
  status: "reserved" | "committed" | "not_committed" | "superseded_by_restore";
  receipt?: Readonly<Record<string, unknown>> | undefined;
  /** Exact post-operation commitments; absence represents a committed delete. */
  effectCommitments: readonly RestoreEffectCommitment[];
}>;

export type RestoreSecurityState = Readonly<{
  sessions: readonly string[];
  tokenFamilies: readonly string[];
  approvals: readonly string[];
  roles: readonly string[];
  credentials: readonly string[];
  projectBindingLeases: readonly string[];
  vaultGrants: readonly string[];
}>;

export type RestoreLifecycleState = Readonly<{
  backups: readonly BackupInventoryRecord[];
  finalizations: readonly RestoreMonotonicEntry[];
  destructions: readonly RestoreMonotonicEntry[];
  keyRetirements: readonly RestoreMonotonicEntry[];
  externalDestructionIntents: readonly RestoreMonotonicEntry[];
  nonRestorableLedgers: readonly RestoreMonotonicEntry[];
  consumedOperationIds: readonly RestoreOperationBinding[];
  retentionCutoff: number;
  purgeWatermark: number;
}>;

export type RestorableControlPlaneState = Readonly<{
  identity: RestoreIdentity;
  authorityGeneration: number;
  effectiveGeneration: number;
  securityEpoch: number;
  domain: readonly RestoreDomainRow[];
  lifecycle: RestoreLifecycleState;
  operationOutcomes: readonly RestoreOperationOutcome[];
  security: RestoreSecurityState;
}>;

export type NormalRestoreFailurePoint =
  | "after-fence"
  | "after-current-ledger-preserved"
  | "after-verify-decrypt"
  | "after-inactive-stage"
  | "after-lifecycle-merge"
  | "after-storage-rescan"
  | "after-current-cutoffs"
  | "after-operation-supersession"
  | "after-security-invalidation"
  | "after-candidate-persist"
  | "after-candidate-readback"
  | "after-candidate-verification"
  | "before-authority-switch"
  | "after-authority-switch"
  | "after-authority-notify"
  | "after-force-hydrate";

export const NORMAL_RESTORE_FAILURE_POINTS: readonly NormalRestoreFailurePoint[] = [
  "after-fence",
  "after-current-ledger-preserved",
  "after-verify-decrypt",
  "after-inactive-stage",
  "after-lifecycle-merge",
  "after-storage-rescan",
  "after-current-cutoffs",
  "after-operation-supersession",
  "after-security-invalidation",
  "after-candidate-persist",
  "after-candidate-readback",
  "after-candidate-verification",
  "before-authority-switch",
  "after-authority-switch",
  "after-authority-notify",
  "after-force-hydrate",
];

export type NormalRestoreErrorCode =
  | "confirmation_required"
  | "confirmation_invalid"
  | "confirmation_stale"
  | "confirmation_reused"
  | "restore_target_mismatch"
  | "restore_auth_fence_failed"
  | "restore_conflict"
  | "restore_interrupted";

/** Deliberately carries only a stable application code; sensitive identifiers stay out of diagnostics. */
export class NormalRestoreError extends Error {
  readonly name = "NormalRestoreError";

  constructor(readonly code: NormalRestoreErrorCode) {
    super(code);
  }
}

export type NormalRestoreConfirmation = Readonly<{
  token: string;
  restoreId: string;
  target: RestoreIdentity;
  expectedAuthorityGeneration: number;
  expectedSecurityEpoch: number;
  selectedBackup: BackupInventoryRecord;
  completeBackupInventory: readonly BackupInventoryRecord[];
  envelopeBinding: RecoveryEnvelopeBinding;
  consequencesCommitment: string;
}>;

export type AuthenticatedRestoreMaterial = Readonly<{
  state: RestorableControlPlaneState;
  binding: RecoveryEnvelopeBinding;
  authenticatedTerminal: RecoveryEnvelopeReadResult;
}>;

export type RestoreTerminalOutcomeRecord = Readonly<{
  binding: RestoreOperationBinding;
  /**
   * `superseded` is a terminal lookup result: adapters retain the original receipt and must deny
   * reservation, redispatch, and cross-binding disclosure for this consumed operation identity.
   */
  disposition: "committed" | "not_committed" | "superseded";
  receipt: Readonly<Record<string, unknown>> | undefined;
}>;

export type RestoreOperationRecoveryEvidence = Readonly<{
  consumedBindings: readonly RestoreOperationBinding[];
  terminalOutcomes: readonly RestoreTerminalOutcomeRecord[];
}>;

/** Opaque adapter evidence that this exact inactive candidate was durably reread. */
export type DurableInactiveRestoreCandidate = Readonly<{
  state: RestorableControlPlaneState;
  expectedAuthorityGeneration: number;
  /** Durable proof that the existing operation lookup path cannot redispatch consumed IDs. */
  operationRecovery: RestoreOperationRecoveryEvidence;
  persistenceToken: string;
}>;

export type NormalRestoreAbortPhase = "discard-pending" | "fence-release-pending";

export type NormalRestoreJournal =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "staged" }>
  | Readonly<{ status: "candidate-durable"; candidate: DurableInactiveRestoreCandidate }>
  | Readonly<{ status: "activated"; candidate: RestorableControlPlaneState }>
  | Readonly<{ status: "aborting"; phase: NormalRestoreAbortPhase }>
  | Readonly<{ status: "completed"; candidate: RestorableControlPlaneState }>;

export interface NormalRestorePort {
  readRestoreJournal(restoreId: string): Promise<NormalRestoreJournal>;
  validateConfirmationWithoutSideEffects(
    confirmation: NormalRestoreConfirmation,
  ): Promise<"valid" | "invalid" | "stale" | "reused">;
  fenceAllNodes(restoreId: string): Promise<string>;
  assertAuthenticationFailsClosed(fenceToken: string): Promise<boolean>;
  readCurrentState(fenceToken: string): Promise<RestorableControlPlaneState>;
  /** The adapter must authenticate the exact selected canonical record, inventory, and envelope binding. */
  verifyAndDecryptBackup(
    input: Readonly<{
      selectedBackup: BackupInventoryRecord;
      completeBackupInventory: readonly BackupInventoryRecord[];
      expectedBinding: RecoveryEnvelopeBinding;
      target: RestoreIdentity;
    }>,
  ): Promise<AuthenticatedRestoreMaterial>;
  stageHistoricalDomainInactive(
    restoreId: string,
    fenceToken: string,
    restored: RestorableControlPlaneState,
  ): Promise<void>;
  rescanManagedBackupStorage(fenceToken: string): Promise<readonly BackupInventoryRecord[]>;
  /**
   * Persist candidate state and operation lookup evidence in one inactive durable unit. Activation
   * receives only the exact proof-bearing readback returned by `readInactiveCandidate`.
   */
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
  verifyCandidate(
    restoreId: string,
    fenceToken: string,
    candidate: DurableInactiveRestoreCandidate,
  ): Promise<void>;
  activateCandidateAtomically(
    input: Readonly<{
      restoreId: string;
      fenceToken: string;
      confirmation: NormalRestoreConfirmation;
      candidate: DurableInactiveRestoreCandidate;
    }>,
  ): Promise<"activated" | "confirmation-invalid" | "conflict">;
  notifyAuthorityChanged(candidate: RestorableControlPlaneState): Promise<void>;
  forceHydrateAllNodes(candidate: RestorableControlPlaneState): Promise<void>;
  journalAbortPhase(
    restoreId: string,
    fenceToken: string,
    phase: NormalRestoreAbortPhase | "completed",
  ): Promise<void>;
  discardInactiveStage(restoreId: string, fenceToken: string): Promise<void>;
  releaseFence(fenceToken: string, outcome: "aborted" | "completed"): Promise<void>;
}

export type NormalRestoreCoordinatorOptions = Readonly<{
  port: NormalRestorePort;
  failureInjector?: ((point: NormalRestoreFailurePoint) => void | Promise<void>) | undefined;
}>;

function identityEquals(left: RestoreIdentity, right: RestoreIdentity): boolean {
  return (
    left.logicalHostId === right.logicalHostId &&
    left.storeId === right.storeId &&
    left.operationNamespace === right.operationNamespace
  );
}

function operationIdentityKey(binding: RestoreOperationBinding): string {
  return [
    binding.logicalHostId,
    binding.storeId,
    binding.operationNamespace,
    binding.operationId,
  ].join("\u0000");
}

function compareBindings(left: RestoreOperationBinding, right: RestoreOperationBinding): number {
  return stableJsonStringify(left).localeCompare(stableJsonStringify(right));
}

function mergeMonotonic<T extends RestoreMonotonicEntry>(
  restored: readonly T[],
  current: readonly T[],
  discovered: readonly T[] = [],
): readonly T[] {
  const entries = new Map<string, T>();
  for (const entry of [...restored, ...current, ...discovered]) {
    const prior = entries.get(entry.id);
    if (!prior || entry.generation > prior.generation) {
      entries.set(entry.id, entry);
      continue;
    }
    if (
      entry.generation === prior.generation &&
      stableJsonStringify(entry) !== stableJsonStringify(prior)
    ) {
      throw new NormalRestoreError("restore_conflict");
    }
  }
  return [...entries.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function mergeBackupRecords(
  restored: readonly BackupInventoryRecord[],
  current: readonly BackupInventoryRecord[],
  discovered: readonly BackupInventoryRecord[],
  purgeWatermark: number,
): readonly BackupInventoryRecord[] {
  try {
    const currentAndRestored = mergeBackupInventorySnapshots(
      { version: 0, purgeWatermark, records: current },
      { version: 0, purgeWatermark, records: restored },
    );
    return mergeBackupInventorySnapshots(currentAndRestored, {
      version: 0,
      purgeWatermark,
      records: discovered,
    }).records;
  } catch {
    throw new NormalRestoreError("restore_conflict");
  }
}

function mergeConsumedIds(
  restored: readonly RestoreOperationBinding[],
  current: readonly RestoreOperationBinding[],
  terminalOutcomes: readonly RestoreOperationOutcome[],
): readonly RestoreOperationBinding[] {
  const entries = new Map<string, RestoreOperationBinding>();
  for (const binding of [
    ...restored,
    ...current,
    ...terminalOutcomes
      .filter((outcome) => outcome.status !== "reserved")
      .map((outcome) => outcome.binding),
  ]) {
    const key = operationIdentityKey(binding);
    const prior = entries.get(key);
    if (prior && !isDeepStrictEqual(prior, binding)) {
      throw new NormalRestoreError("restore_conflict");
    }
    entries.set(key, binding);
  }
  return [...entries.values()].sort(compareBindings);
}

function commitmentMatchesDomain(
  commitment: RestoreEffectCommitment,
  rows: ReadonlyMap<string, RestoreDomainRow>,
): boolean {
  const row = rows.get(commitment.entityId);
  if (commitment.after.kind === "absent") return row === undefined;
  return row !== undefined && isDeepStrictEqual(row.value, commitment.after.value);
}

function mergeOperationOutcomes(
  restored: readonly RestoreOperationOutcome[],
  current: readonly RestoreOperationOutcome[],
  domain: readonly RestoreDomainRow[],
): readonly RestoreOperationOutcome[] {
  const outcomes = new Map<string, RestoreOperationOutcome>();
  for (const outcome of [...restored, ...current]) {
    const key = operationIdentityKey(outcome.binding);
    const prior = outcomes.get(key);
    if (prior && !isDeepStrictEqual(prior.binding, outcome.binding)) {
      throw new NormalRestoreError("restore_conflict");
    }
    outcomes.set(key, outcome);
  }
  const rows = new Map(domain.map((row) => [row.entityId, row]));
  return [...outcomes.values()]
    .map((outcome): RestoreOperationOutcome => {
      const superseded =
        outcome.status === "committed" &&
        outcome.effectCommitments.length > 0 &&
        outcome.effectCommitments.some((commitment) => !commitmentMatchesDomain(commitment, rows));
      return superseded ? { ...outcome, status: "superseded_by_restore" } : outcome;
    })
    .sort((left, right) => compareBindings(left.binding, right.binding));
}

function operationRecoveryEvidence(
  state: RestorableControlPlaneState,
): RestoreOperationRecoveryEvidence {
  const terminalOutcomes: RestoreTerminalOutcomeRecord[] = [];
  for (const outcome of state.operationOutcomes) {
    if (outcome.status === "reserved") continue;
    terminalOutcomes.push({
      binding: outcome.binding,
      disposition: outcome.status === "superseded_by_restore" ? "superseded" : outcome.status,
      receipt: outcome.receipt,
    });
  }
  return {
    consumedBindings: state.lifecycle.consumedOperationIds,
    terminalOutcomes,
  };
}

const INVALIDATED_SECURITY_STATE: RestoreSecurityState = {
  sessions: [],
  tokenFamilies: [],
  approvals: [],
  roles: [],
  credentials: [],
  projectBindingLeases: [],
  vaultGrants: [],
};

function assertGeneration(value: number, incremented: boolean): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (incremented && value >= Number.MAX_SAFE_INTEGER)
  ) {
    throw new NormalRestoreError("restore_conflict");
  }
}

export function mergeRestoreState(
  input: Readonly<{
    current: RestorableControlPlaneState;
    restored: RestorableControlPlaneState;
    rescannedBackups: readonly BackupInventoryRecord[];
  }>,
): RestorableControlPlaneState {
  if (!identityEquals(input.current.identity, input.restored.identity)) {
    throw new NormalRestoreError("restore_target_mismatch");
  }
  for (const state of [input.current, input.restored]) {
    assertGeneration(state.authorityGeneration, true);
    assertGeneration(state.effectiveGeneration, false);
    assertGeneration(state.securityEpoch, true);
  }

  const authorityGeneration = Math.max(
    input.current.authorityGeneration,
    input.restored.authorityGeneration,
  );
  const securityEpoch = Math.max(input.current.securityEpoch, input.restored.securityEpoch);
  const domain = input.restored.domain.filter(
    (row) =>
      row.retentionOrdinal === undefined ||
      row.retentionOrdinal > input.current.lifecycle.retentionCutoff,
  );
  const operationOutcomes = mergeOperationOutcomes(
    input.restored.operationOutcomes,
    input.current.operationOutcomes,
    domain,
  );
  const lifecycle: RestoreLifecycleState = {
    backups: mergeBackupRecords(
      input.restored.lifecycle.backups,
      input.current.lifecycle.backups,
      input.rescannedBackups,
      input.current.lifecycle.purgeWatermark,
    ),
    finalizations: mergeMonotonic(
      input.restored.lifecycle.finalizations,
      input.current.lifecycle.finalizations,
    ),
    destructions: mergeMonotonic(
      input.restored.lifecycle.destructions,
      input.current.lifecycle.destructions,
    ),
    keyRetirements: mergeMonotonic(
      input.restored.lifecycle.keyRetirements,
      input.current.lifecycle.keyRetirements,
    ),
    externalDestructionIntents: mergeMonotonic(
      input.restored.lifecycle.externalDestructionIntents,
      input.current.lifecycle.externalDestructionIntents,
    ),
    nonRestorableLedgers: mergeMonotonic(
      input.restored.lifecycle.nonRestorableLedgers,
      input.current.lifecycle.nonRestorableLedgers,
    ),
    consumedOperationIds: mergeConsumedIds(
      input.restored.lifecycle.consumedOperationIds,
      input.current.lifecycle.consumedOperationIds,
      operationOutcomes,
    ),
    retentionCutoff: input.current.lifecycle.retentionCutoff,
    purgeWatermark: input.current.lifecycle.purgeWatermark,
  };

  return {
    identity: input.current.identity,
    authorityGeneration: authorityGeneration + 1,
    effectiveGeneration: input.restored.effectiveGeneration,
    securityEpoch: securityEpoch + 1,
    domain,
    lifecycle,
    operationOutcomes,
    security: INVALIDATED_SECURITY_STATE,
  };
}

function assertConfirmationInventory(confirmation: NormalRestoreConfirmation): void {
  const selected = confirmation.completeBackupInventory.find(
    (record) => record.backupId === confirmation.selectedBackup.backupId,
  );
  if (!selected || !isDeepStrictEqual(selected, confirmation.selectedBackup)) {
    throw new NormalRestoreError("confirmation_invalid");
  }
  if (
    confirmation.envelopeBinding.logicalHostId !== confirmation.target.logicalHostId ||
    confirmation.envelopeBinding.storeId !== confirmation.target.storeId
  ) {
    throw new NormalRestoreError("restore_target_mismatch");
  }
}

function assertAuthenticatedMaterial(
  confirmation: NormalRestoreConfirmation,
  material: AuthenticatedRestoreMaterial,
): void {
  const inventory = confirmation.selectedBackup;
  if (
    !isDeepStrictEqual(material.binding, confirmation.envelopeBinding) ||
    material.authenticatedTerminal.bindingDigest !== inventory.bindingDigest ||
    material.authenticatedTerminal.headerDigest !== inventory.headerDigest ||
    material.authenticatedTerminal.terminalManifestDigest !== inventory.terminalManifestDigest ||
    material.authenticatedTerminal.wrappedKeyDigest !== inventory.wrappedKeyDigest
  ) {
    throw new NormalRestoreError("restore_conflict");
  }
}

export function createNormalRestoreCoordinator(options: NormalRestoreCoordinatorOptions) {
  const checkpoint = async (point: NormalRestoreFailurePoint, fenceToken: string) => {
    if (!(await options.port.assertAuthenticationFailsClosed(fenceToken))) {
      throw new NormalRestoreError("restore_auth_fence_failed");
    }
    await options.failureInjector?.(point);
  };

  const finishActivatedRestore = async (
    fenceToken: string,
    candidate: RestorableControlPlaneState,
  ) => {
    await checkpoint("after-authority-switch", fenceToken);
    await options.port.notifyAuthorityChanged(candidate);
    await checkpoint("after-authority-notify", fenceToken);
    await options.port.forceHydrateAllNodes(candidate);
    await checkpoint("after-force-hydrate", fenceToken);
    await options.port.releaseFence(fenceToken, "completed");
    return candidate;
  };

  const resumeAbort = async (
    restoreId: string,
    fenceToken: string,
    phase: NormalRestoreAbortPhase = "discard-pending",
  ) => {
    if (phase === "discard-pending") {
      await options.port.journalAbortPhase(restoreId, fenceToken, "discard-pending");
      await options.port.discardInactiveStage(restoreId, fenceToken);
      await options.port.journalAbortPhase(restoreId, fenceToken, "fence-release-pending");
    }
    await options.port.releaseFence(fenceToken, "aborted");
    await options.port.journalAbortPhase(restoreId, fenceToken, "completed");
  };

  const callPort = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof NormalRestoreError) throw error;
      throw new NormalRestoreError("restore_interrupted");
    }
  };

  return Object.freeze({
    async restore(
      confirmation: NormalRestoreConfirmation | undefined,
    ): Promise<RestorableControlPlaneState> {
      if (!confirmation) throw new NormalRestoreError("confirmation_required");

      const journal = await callPort(() => options.port.readRestoreJournal(confirmation.restoreId));
      if (journal.status === "completed") throw new NormalRestoreError("confirmation_reused");
      if (journal.status === "aborting") {
        try {
          const fenceToken = await options.port.fenceAllNodes(confirmation.restoreId);
          await resumeAbort(confirmation.restoreId, fenceToken, journal.phase);
        } catch {
          // The durable abort journal remains the source of truth for the next retry.
        }
        throw new NormalRestoreError("restore_interrupted");
      }

      assertConfirmationInventory(confirmation);
      const validation = await callPort(() =>
        options.port.validateConfirmationWithoutSideEffects(confirmation),
      );
      if (validation !== "valid") {
        throw new NormalRestoreError(
          validation === "stale"
            ? "confirmation_stale"
            : validation === "reused"
              ? "confirmation_reused"
              : "confirmation_invalid",
        );
      }

      const fenceToken = await callPort(() => options.port.fenceAllNodes(confirmation.restoreId));
      let activated = false;
      try {
        if (journal.status === "activated") {
          activated = true;
          return await finishActivatedRestore(fenceToken, journal.candidate);
        }

        await checkpoint("after-fence", fenceToken);
        const current = await options.port.readCurrentState(fenceToken);
        await checkpoint("after-current-ledger-preserved", fenceToken);
        if (
          !identityEquals(current.identity, confirmation.target) ||
          current.authorityGeneration !== confirmation.expectedAuthorityGeneration ||
          current.securityEpoch !== confirmation.expectedSecurityEpoch
        ) {
          throw new NormalRestoreError("confirmation_stale");
        }

        let durableCandidate: DurableInactiveRestoreCandidate;
        if (journal.status === "candidate-durable") {
          durableCandidate = journal.candidate;
        } else {
          const material = await options.port.verifyAndDecryptBackup({
            selectedBackup: confirmation.selectedBackup,
            completeBackupInventory: confirmation.completeBackupInventory,
            expectedBinding: confirmation.envelopeBinding,
            target: confirmation.target,
          });
          assertAuthenticatedMaterial(confirmation, material);
          if (!identityEquals(material.state.identity, current.identity)) {
            throw new NormalRestoreError("restore_target_mismatch");
          }
          await checkpoint("after-verify-decrypt", fenceToken);

          await options.port.stageHistoricalDomainInactive(
            confirmation.restoreId,
            fenceToken,
            material.state,
          );
          await checkpoint("after-inactive-stage", fenceToken);
          await checkpoint("after-lifecycle-merge", fenceToken);
          const rescannedBackups = await options.port.rescanManagedBackupStorage(fenceToken);
          await checkpoint("after-storage-rescan", fenceToken);
          const candidate = mergeRestoreState({
            current,
            restored: material.state,
            rescannedBackups,
          });
          await checkpoint("after-current-cutoffs", fenceToken);
          await checkpoint("after-operation-supersession", fenceToken);
          await checkpoint("after-security-invalidation", fenceToken);
          const operationRecovery = operationRecoveryEvidence(candidate);
          await options.port.writeInactiveCandidate({
            restoreId: confirmation.restoreId,
            fenceToken,
            candidate,
            expectedAuthorityGeneration: current.authorityGeneration,
            operationRecovery,
          });
          await checkpoint("after-candidate-persist", fenceToken);
          const readback = await options.port.readInactiveCandidate(
            confirmation.restoreId,
            fenceToken,
          );
          if (
            !readback ||
            readback.expectedAuthorityGeneration !== current.authorityGeneration ||
            !isDeepStrictEqual(readback.state, candidate) ||
            !isDeepStrictEqual(readback.operationRecovery, operationRecovery)
          ) {
            throw new NormalRestoreError("restore_conflict");
          }
          durableCandidate = readback;
          await checkpoint("after-candidate-readback", fenceToken);
        }

        if (
          durableCandidate.expectedAuthorityGeneration !== current.authorityGeneration ||
          !isDeepStrictEqual(
            durableCandidate.operationRecovery,
            operationRecoveryEvidence(durableCandidate.state),
          ) ||
          durableCandidate.state.authorityGeneration <= current.authorityGeneration ||
          durableCandidate.state.securityEpoch <= current.securityEpoch ||
          durableCandidate.state.security.sessions.length !== 0 ||
          durableCandidate.state.security.tokenFamilies.length !== 0 ||
          durableCandidate.state.security.approvals.length !== 0 ||
          durableCandidate.state.security.roles.length !== 0 ||
          durableCandidate.state.security.credentials.length !== 0 ||
          durableCandidate.state.security.projectBindingLeases.length !== 0 ||
          durableCandidate.state.security.vaultGrants.length !== 0
        ) {
          throw new NormalRestoreError("restore_conflict");
        }
        await options.port.verifyCandidate(confirmation.restoreId, fenceToken, durableCandidate);
        await checkpoint("after-candidate-verification", fenceToken);
        await checkpoint("before-authority-switch", fenceToken);
        const activation = await options.port.activateCandidateAtomically({
          restoreId: confirmation.restoreId,
          fenceToken,
          confirmation,
          candidate: durableCandidate,
        });
        if (activation === "confirmation-invalid") {
          throw new NormalRestoreError("confirmation_stale");
        }
        if (activation === "conflict") throw new NormalRestoreError("restore_conflict");
        activated = true;
        return await finishActivatedRestore(fenceToken, durableCandidate.state);
      } catch (error) {
        if (!activated) {
          try {
            await resumeAbort(confirmation.restoreId, fenceToken);
          } catch {
            throw new NormalRestoreError("restore_interrupted");
          }
        }
        if (error instanceof NormalRestoreError) throw error;
        throw new NormalRestoreError("restore_interrupted");
      }
    },
  });
}
