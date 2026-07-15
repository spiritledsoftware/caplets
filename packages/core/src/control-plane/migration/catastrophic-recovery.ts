import { createHash } from "node:crypto";
import { stableJsonStringify } from "../../stable-json";
import type { BackupInventoryRecord } from "./backup";
import type {
  RestorableControlPlaneState,
  RestoreIdentity,
  RestoreMonotonicEntry,
  RestoreOperationBinding,
} from "./restore";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CANONICAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ASCII_TARGET_PATTERN = /^[\x21-\x7e]{1,1024}$/u;

export type RecoveryCheckpointInventoryEntry = Readonly<{
  backupId: string;
  generation: number;
  keyVersion: number;
  state: "available" | "destroyed";
  providerDigest: string;
  materialDigest: string;
  headerDigest: string;
  terminalDigest: string;
  wrappedKeyDigest: string;
  keyReferenceDigest: string;
}>;

export type RecoveryCheckpointDestructionIntent = Readonly<{
  intentId: string;
  backupId: string;
  generation: number;
  providerId: string;
  bytesTarget: string;
  keyTarget: string;
  targetDigest: string;
  phase: "pending" | "bytes-absent" | "key-absent";
}>;

export type RecoveryCheckpointReceipt =
  | Readonly<{
      receiptId: string;
      generation: number;
      kind: "purge";
    }>
  | Readonly<{
      receiptId: string;
      generation: number;
      kind: "destruction";
      recoveryId: string;
      confirmationDigest: string;
      targetIntentId: string;
      backupId: string;
      providerId: string;
      bytesTarget: string;
      keyTarget: string;
      targetDigest: string;
    }>
  | Readonly<{
      receiptId: string;
      generation: number;
      kind: "old-authority-isolation";
      recoveryId: string;
      confirmationDigest: string;
      oldStoreId: string;
      oldOperationNamespace: string;
      newStoreId: string;
      newOperationNamespace: string;
      disposition: "destroyed" | "isolated";
      oldJoinCredentialsRejected: true;
    }>
  | Readonly<{
      receiptId: string;
      generation: number;
      kind: "stale-namespace";
      recoveryId: string;
      confirmationDigest: string;
      staleNamespace: string;
      oldStoreId: string;
      newStoreId: string;
    }>;

export type RecoveryCheckpointPayload = Readonly<{
  generation: number;
  priorRecordDigest: string | null;
  logicalHostId: string;
  storeId: string;
  operationNamespace: string;
  securityEpoch: number;
  providerCommitment: string;
  keyCommitment: string;
  backupInventory: readonly RecoveryCheckpointInventoryEntry[];
  pendingDestructionIntents: readonly RecoveryCheckpointDestructionIntent[];
  immutableReceipts: readonly RecoveryCheckpointReceipt[];
  backupId: string;
}>;

export type AuthenticatedRecoveryCheckpoint = Readonly<{
  format: "caplets-recovery-checkpoint-v1";
  state: "prepared" | "selected";
  payload: RecoveryCheckpointPayload;
  digest: string;
  authentication: string;
}>;

export type RecoveryDescriptor = Readonly<{
  generation: number;
  checkpointDigest: string;
  logicalHostId: string;
}>;

export interface RecoveryCheckpointHmacPort {
  readonly capability: "recovery-checkpoint";
  authenticate(bytes: Uint8Array): Promise<string>;
  verify(bytes: Uint8Array, authentication: string): Promise<boolean>;
}

export interface RecoveryCheckpointReplicaPort {
  readonly replicaId: string;
  readonly ownerPrivate: boolean;
  /** True only when the replica is outside both SQL and managed backup storage. */
  readonly outsideSqlAndManagedBackup: boolean;
  readChain(): Promise<readonly AuthenticatedRecoveryCheckpoint[]>;
  writePrepared(checkpoint: AuthenticatedRecoveryCheckpoint): Promise<void>;
  fsyncPrepared(generation: number): Promise<void>;
  rereadPrepared(generation: number): Promise<AuthenticatedRecoveryCheckpoint | undefined>;
  promoteSelected(generation: number, digest: string): Promise<void>;
  /**
   * Atomically replaces the chain only while `expectedDescriptor` is still live. The adapter must
   * return `newer-selected-generation` rather than truncate any later selected generation.
   */
  repairSelectedChainAtomically(
    input: Readonly<{
      expectedDescriptor: RecoveryDescriptor;
      chain: readonly AuthenticatedRecoveryCheckpoint[];
    }>,
  ): Promise<"repaired" | "stale-descriptor" | "newer-selected-generation">;
  fsyncSelectedChain(generation: number): Promise<void>;
  rereadSelectedChain(
    generation: number,
  ): Promise<readonly AuthenticatedRecoveryCheckpoint[] | undefined>;
  discardUnselected(generation: number, digest: string): Promise<void>;
}

export interface RecoveryDescriptorPort {
  read(): Promise<RecoveryDescriptor | undefined>;
  compareAndSwap(
    expected: RecoveryDescriptor | undefined,
    replacement: RecoveryDescriptor,
  ): Promise<boolean>;
}

export type CheckpointAdvanceFailurePoint =
  | "before-replica-a-write"
  | "after-replica-a-write"
  | "before-replica-a-fsync"
  | "after-replica-a-fsync"
  | "before-replica-a-verify"
  | "after-replica-a-verify"
  | "before-replica-b-write"
  | "after-replica-b-write"
  | "before-replica-b-fsync"
  | "after-replica-b-fsync"
  | "before-replica-b-verify"
  | "after-replica-b-verify"
  | "before-descriptor-cas"
  | "after-descriptor-cas"
  | "before-replica-a-promotion"
  | "after-replica-a-promotion"
  | "before-replica-b-promotion"
  | "after-replica-b-promotion";

export const CHECKPOINT_ADVANCE_FAILURE_POINTS: readonly CheckpointAdvanceFailurePoint[] = [
  "before-replica-a-write",
  "after-replica-a-write",
  "before-replica-a-fsync",
  "after-replica-a-fsync",
  "before-replica-a-verify",
  "after-replica-a-verify",
  "before-replica-b-write",
  "after-replica-b-write",
  "before-replica-b-fsync",
  "after-replica-b-fsync",
  "before-replica-b-verify",
  "after-replica-b-verify",
  "before-descriptor-cas",
  "after-descriptor-cas",
  "before-replica-a-promotion",
  "after-replica-a-promotion",
  "before-replica-b-promotion",
  "after-replica-b-promotion",
];

export type CatastrophicRecoveryFailurePoint =
  | "before-external-deletion"
  | "after-external-deletion"
  | "before-terminal-receipt"
  | "after-terminal-receipt"
  | "before-old-authority-isolation"
  | "after-old-authority-isolation"
  | "before-new-authority-checkpoint"
  | "after-new-authority-checkpoint"
  | "before-restored-sql-marker"
  | "after-restored-sql-marker";

export const CATASTROPHIC_RECOVERY_FAILURE_POINTS: readonly CatastrophicRecoveryFailurePoint[] = [
  "before-external-deletion",
  "after-external-deletion",
  "before-terminal-receipt",
  "after-terminal-receipt",
  "before-old-authority-isolation",
  "after-old-authority-isolation",
  "before-new-authority-checkpoint",
  "after-new-authority-checkpoint",
  "before-restored-sql-marker",
  "after-restored-sql-marker",
];

export type CatastrophicRecoveryErrorCode =
  | "confirmation_required"
  | "confirmation_invalid"
  | "confirmation_stale"
  | "confirmation_reused"
  | "checkpoint_location_insecure"
  | "checkpoint_missing"
  | "checkpoint_stale"
  | "checkpoint_mismatch"
  | "checkpoint_authentication_failed"
  | "checkpoint_conflict"
  | "backup_inventory_incomplete"
  | "backup_binding_mismatch"
  | "old_authority_reachable"
  | "old_authority_unproven"
  | "old_join_credentials_accepted"
  | "external_destruction_incomplete"
  | "restored_state_invalid"
  | "generation_overflow"
  | "restored_sql_marker_mismatch"
  | "recovery_interrupted";

/** Secret-safe application error. Callers may report `code`, never checkpoint contents. */
export class CatastrophicRecoveryError extends Error {
  readonly name = "CatastrophicRecoveryError";

  constructor(readonly code: CatastrophicRecoveryErrorCode) {
    super(code);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort(codeUnitCompare);
  const expected = [...keys].sort(codeUnitCompare);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCanonicalId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_ID_PATTERN.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function destructionTargetDigest(
  input: Readonly<{
    providerId: string;
    bytesTarget: string;
    keyTarget: string;
  }>,
): string {
  return sha256(
    stableJsonStringify({
      domain: "caplets/recovery-destruction-target/v1",
      providerId: input.providerId,
      bytesTarget: input.bytesTarget,
      keyTarget: input.keyTarget,
    }),
  );
}

function inventoryEntryIsValid(value: unknown): value is RecoveryCheckpointInventoryEntry {
  if (
    !hasExactKeys(value, [
      "backupId",
      "generation",
      "keyVersion",
      "state",
      "providerDigest",
      "materialDigest",
      "headerDigest",
      "terminalDigest",
      "wrappedKeyDigest",
      "keyReferenceDigest",
    ])
  ) {
    return false;
  }
  return (
    isCanonicalId(value.backupId) &&
    isSafePositiveInteger(value.generation) &&
    isSafePositiveInteger(value.keyVersion) &&
    (value.state === "available" || value.state === "destroyed") &&
    isSha256(value.providerDigest) &&
    isSha256(value.materialDigest) &&
    isSha256(value.headerDigest) &&
    isSha256(value.terminalDigest) &&
    isSha256(value.wrappedKeyDigest) &&
    isSha256(value.keyReferenceDigest)
  );
}

function intentIsValid(value: unknown): value is RecoveryCheckpointDestructionIntent {
  if (
    !hasExactKeys(value, [
      "intentId",
      "backupId",
      "generation",
      "providerId",
      "bytesTarget",
      "keyTarget",
      "targetDigest",
      "phase",
    ])
  ) {
    return false;
  }
  return (
    isCanonicalId(value.intentId) &&
    isCanonicalId(value.backupId) &&
    isSafePositiveInteger(value.generation) &&
    isCanonicalId(value.providerId) &&
    typeof value.bytesTarget === "string" &&
    ASCII_TARGET_PATTERN.test(value.bytesTarget) &&
    typeof value.keyTarget === "string" &&
    ASCII_TARGET_PATTERN.test(value.keyTarget) &&
    isSha256(value.targetDigest) &&
    value.targetDigest ===
      destructionTargetDigest({
        providerId: value.providerId,
        bytesTarget: value.bytesTarget,
        keyTarget: value.keyTarget,
      }) &&
    (value.phase === "pending" || value.phase === "bytes-absent" || value.phase === "key-absent")
  );
}

function receiptIsValid(value: unknown): value is RecoveryCheckpointReceipt {
  if (
    !isRecord(value) ||
    !isCanonicalId(value.receiptId) ||
    !isSafePositiveInteger(value.generation)
  ) {
    return false;
  }
  if (value.kind === "purge") {
    return hasExactKeys(value, ["receiptId", "generation", "kind"]);
  }
  if (value.kind === "destruction") {
    if (
      !hasExactKeys(value, [
        "receiptId",
        "generation",
        "kind",
        "recoveryId",
        "confirmationDigest",
        "targetIntentId",
        "backupId",
        "providerId",
        "bytesTarget",
        "keyTarget",
        "targetDigest",
      ])
    ) {
      return false;
    }
    return (
      isCanonicalId(value.recoveryId) &&
      isSha256(value.confirmationDigest) &&
      isCanonicalId(value.targetIntentId) &&
      isCanonicalId(value.backupId) &&
      isCanonicalId(value.providerId) &&
      typeof value.bytesTarget === "string" &&
      ASCII_TARGET_PATTERN.test(value.bytesTarget) &&
      typeof value.keyTarget === "string" &&
      ASCII_TARGET_PATTERN.test(value.keyTarget) &&
      isSha256(value.targetDigest) &&
      value.targetDigest ===
        destructionTargetDigest({
          providerId: value.providerId,
          bytesTarget: value.bytesTarget,
          keyTarget: value.keyTarget,
        })
    );
  }
  if (value.kind === "old-authority-isolation") {
    if (
      !hasExactKeys(value, [
        "receiptId",
        "generation",
        "kind",
        "recoveryId",
        "confirmationDigest",
        "oldStoreId",
        "oldOperationNamespace",
        "newStoreId",
        "newOperationNamespace",
        "disposition",
        "oldJoinCredentialsRejected",
      ])
    ) {
      return false;
    }
    return (
      isCanonicalId(value.recoveryId) &&
      isSha256(value.confirmationDigest) &&
      isCanonicalId(value.oldStoreId) &&
      isCanonicalId(value.oldOperationNamespace) &&
      isCanonicalId(value.newStoreId) &&
      isCanonicalId(value.newOperationNamespace) &&
      value.newStoreId !== value.oldStoreId &&
      value.newOperationNamespace !== value.oldOperationNamespace &&
      (value.disposition === "destroyed" || value.disposition === "isolated") &&
      value.oldJoinCredentialsRejected === true
    );
  }
  if (value.kind === "stale-namespace") {
    if (
      !hasExactKeys(value, [
        "receiptId",
        "generation",
        "kind",
        "recoveryId",
        "confirmationDigest",
        "staleNamespace",
        "oldStoreId",
        "newStoreId",
      ])
    ) {
      return false;
    }
    return (
      isCanonicalId(value.recoveryId) &&
      isSha256(value.confirmationDigest) &&
      isCanonicalId(value.staleNamespace) &&
      isCanonicalId(value.oldStoreId) &&
      isCanonicalId(value.newStoreId) &&
      value.oldStoreId !== value.newStoreId
    );
  }
  return false;
}

function canonicalPayload(payload: RecoveryCheckpointPayload): RecoveryCheckpointPayload {
  return {
    ...payload,
    backupInventory: [...payload.backupInventory].sort((left, right) =>
      codeUnitCompare(left.backupId, right.backupId),
    ),
    pendingDestructionIntents: [...payload.pendingDestructionIntents].sort((left, right) =>
      codeUnitCompare(left.intentId, right.intentId),
    ),
    immutableReceipts: [...payload.immutableReceipts].sort((left, right) =>
      codeUnitCompare(left.receiptId, right.receiptId),
    ),
  };
}

function checkpointPayloadIsValid(payload: unknown): payload is RecoveryCheckpointPayload {
  if (
    !hasExactKeys(payload, [
      "generation",
      "priorRecordDigest",
      "logicalHostId",
      "storeId",
      "operationNamespace",
      "securityEpoch",
      "providerCommitment",
      "keyCommitment",
      "backupInventory",
      "pendingDestructionIntents",
      "immutableReceipts",
      "backupId",
    ]) ||
    !isSafePositiveInteger(payload.generation) ||
    (payload.generation === 1
      ? payload.priorRecordDigest !== null
      : !isSha256(payload.priorRecordDigest)) ||
    !isCanonicalId(payload.logicalHostId) ||
    !isCanonicalId(payload.storeId) ||
    !isCanonicalId(payload.operationNamespace) ||
    !isSafeNonnegativeInteger(payload.securityEpoch) ||
    !isSha256(payload.providerCommitment) ||
    !isSha256(payload.keyCommitment) ||
    !Array.isArray(payload.backupInventory) ||
    payload.backupInventory.length === 0 ||
    !payload.backupInventory.every(inventoryEntryIsValid) ||
    !Array.isArray(payload.pendingDestructionIntents) ||
    !payload.pendingDestructionIntents.every(intentIsValid) ||
    !Array.isArray(payload.immutableReceipts) ||
    !payload.immutableReceipts.every(receiptIsValid) ||
    !isCanonicalId(payload.backupId)
  ) {
    return false;
  }

  const backupIds = payload.backupInventory.map((entry) => entry.backupId);
  const intentIds = payload.pendingDestructionIntents.map((entry) => entry.intentId);
  const receiptIds = payload.immutableReceipts.map((entry) => entry.receiptId);
  if (
    new Set(backupIds).size !== backupIds.length ||
    new Set(intentIds).size !== intentIds.length ||
    new Set(receiptIds).size !== receiptIds.length
  ) {
    return false;
  }
  if (
    !payload.backupInventory.some(
      (entry) => entry.backupId === payload.backupId && entry.state === "available",
    )
  ) {
    return false;
  }
  for (const intent of payload.pendingDestructionIntents) {
    const inventory = payload.backupInventory.find((entry) => entry.backupId === intent.backupId);
    if (!inventory || inventory.state !== "available" || intent.backupId === payload.backupId) {
      return false;
    }
  }
  for (const receipt of payload.immutableReceipts) {
    if (receipt.kind !== "destruction") continue;
    const inventory = payload.backupInventory.find((entry) => entry.backupId === receipt.backupId);
    if (!inventory || inventory.state !== "destroyed") return false;
    if (
      payload.pendingDestructionIntents.some((intent) => intent.intentId === receipt.targetIntentId)
    ) {
      return false;
    }
  }
  return true;
}

export function checkpointCanonicalBytes(payload: RecoveryCheckpointPayload): Uint8Array {
  return new TextEncoder().encode(
    stableJsonStringify({
      domain: "caplets/recovery-checkpoint/v1",
      payload: canonicalPayload(payload),
    }),
  );
}

function checkpointAuthenticationBytes(payloadBytes: Uint8Array, digest: string): Uint8Array {
  return new TextEncoder().encode(
    stableJsonStringify({
      domain: "caplets/recovery-checkpoint-authentication/v1",
      digest,
      payload: new TextDecoder().decode(payloadBytes),
    }),
  );
}

export async function createAuthenticatedRecoveryCheckpoint(
  payload: RecoveryCheckpointPayload,
  hmac: RecoveryCheckpointHmacPort,
): Promise<AuthenticatedRecoveryCheckpoint> {
  if (hmac.capability !== "recovery-checkpoint" || !checkpointPayloadIsValid(payload)) {
    throw new CatastrophicRecoveryError("checkpoint_authentication_failed");
  }
  const normalized = canonicalPayload(payload);
  const payloadBytes = checkpointCanonicalBytes(normalized);
  const digest = sha256(payloadBytes);
  return {
    format: "caplets-recovery-checkpoint-v1",
    state: "prepared",
    payload: normalized,
    digest,
    authentication: await hmac.authenticate(checkpointAuthenticationBytes(payloadBytes, digest)),
  };
}

export async function verifyAuthenticatedRecoveryCheckpoint(
  checkpoint: AuthenticatedRecoveryCheckpoint,
  hmac: RecoveryCheckpointHmacPort,
): Promise<boolean> {
  if (
    !hasExactKeys(checkpoint, ["format", "state", "payload", "digest", "authentication"]) ||
    checkpoint.format !== "caplets-recovery-checkpoint-v1" ||
    (checkpoint.state !== "prepared" && checkpoint.state !== "selected") ||
    hmac.capability !== "recovery-checkpoint" ||
    !checkpointPayloadIsValid(checkpoint.payload) ||
    !isSha256(checkpoint.digest) ||
    !isSha256(checkpoint.authentication)
  ) {
    return false;
  }
  const payloadBytes = checkpointCanonicalBytes(checkpoint.payload);
  const digest = sha256(payloadBytes);
  return (
    digest === checkpoint.digest &&
    hmac.verify(checkpointAuthenticationBytes(payloadBytes, digest), checkpoint.authentication)
  );
}

function descriptorEquals(
  left: RecoveryDescriptor | undefined,
  right: RecoveryDescriptor | undefined,
): boolean {
  return (
    left?.generation === right?.generation &&
    left?.checkpointDigest === right?.checkpointDigest &&
    left?.logicalHostId === right?.logicalHostId
  );
}

function descriptorIsValid(value: unknown): value is RecoveryDescriptor {
  return (
    hasExactKeys(value, ["generation", "checkpointDigest", "logicalHostId"]) &&
    isSafePositiveInteger(value.generation) &&
    isSha256(value.checkpointDigest) &&
    isCanonicalId(value.logicalHostId)
  );
}

function assertReplicaLocations(
  replicas: readonly [RecoveryCheckpointReplicaPort, RecoveryCheckpointReplicaPort],
): void {
  if (
    !isCanonicalId(replicas[0].replicaId) ||
    !isCanonicalId(replicas[1].replicaId) ||
    replicas[0].replicaId === replicas[1].replicaId ||
    !replicas[0].ownerPrivate ||
    !replicas[1].ownerPrivate ||
    (!replicas[0].outsideSqlAndManagedBackup && !replicas[1].outsideSqlAndManagedBackup)
  ) {
    throw new CatastrophicRecoveryError("checkpoint_location_insecure");
  }
}

function intentPhaseOrdinal(phase: RecoveryCheckpointDestructionIntent["phase"]): number {
  return phase === "pending" ? 0 : phase === "bytes-absent" ? 1 : 2;
}

function sameInventoryIdentity(
  left: RecoveryCheckpointInventoryEntry,
  right: RecoveryCheckpointInventoryEntry,
): boolean {
  return (
    left.backupId === right.backupId &&
    left.generation === right.generation &&
    left.keyVersion === right.keyVersion &&
    left.providerDigest === right.providerDigest &&
    left.materialDigest === right.materialDigest &&
    left.headerDigest === right.headerDigest &&
    left.terminalDigest === right.terminalDigest &&
    left.wrappedKeyDigest === right.wrappedKeyDigest &&
    left.keyReferenceDigest === right.keyReferenceDigest
  );
}

function sameIntentTarget(
  left: RecoveryCheckpointDestructionIntent,
  right: RecoveryCheckpointDestructionIntent,
): boolean {
  return (
    left.intentId === right.intentId &&
    left.backupId === right.backupId &&
    left.generation === right.generation &&
    left.providerId === right.providerId &&
    left.bytesTarget === right.bytesTarget &&
    left.keyTarget === right.keyTarget &&
    left.targetDigest === right.targetDigest
  );
}

function chainTransitionIsValid(
  prior: RecoveryCheckpointPayload,
  current: RecoveryCheckpointPayload,
): boolean {
  if (
    current.logicalHostId !== prior.logicalHostId ||
    current.providerCommitment !== prior.providerCommitment ||
    current.keyCommitment !== prior.keyCommitment ||
    current.securityEpoch < prior.securityEpoch
  ) {
    return false;
  }
  for (const priorInventory of prior.backupInventory) {
    const currentInventory = current.backupInventory.find(
      (entry) => entry.backupId === priorInventory.backupId,
    );
    if (!currentInventory || !sameInventoryIdentity(priorInventory, currentInventory)) return false;
    if (priorInventory.state === "destroyed" && currentInventory.state !== "destroyed")
      return false;
    if (priorInventory.state === "available" && currentInventory.state === "destroyed") {
      const terminal = current.immutableReceipts.find(
        (receipt) => receipt.kind === "destruction" && receipt.backupId === priorInventory.backupId,
      );
      if (!terminal || terminal.generation !== current.generation) return false;
    }
  }
  for (const priorReceipt of prior.immutableReceipts) {
    const currentReceipt = current.immutableReceipts.find(
      (entry) => entry.receiptId === priorReceipt.receiptId,
    );
    if (
      !currentReceipt ||
      stableJsonStringify(currentReceipt) !== stableJsonStringify(priorReceipt)
    ) {
      return false;
    }
  }
  for (const priorIntent of prior.pendingDestructionIntents) {
    const currentIntent = current.pendingDestructionIntents.find(
      (entry) => entry.intentId === priorIntent.intentId,
    );
    if (currentIntent) {
      if (
        !sameIntentTarget(priorIntent, currentIntent) ||
        intentPhaseOrdinal(currentIntent.phase) < intentPhaseOrdinal(priorIntent.phase)
      ) {
        return false;
      }
      continue;
    }
    const terminal = current.immutableReceipts.find(
      (receipt) =>
        receipt.kind === "destruction" &&
        receipt.targetIntentId === priorIntent.intentId &&
        receipt.backupId === priorIntent.backupId &&
        receipt.providerId === priorIntent.providerId &&
        receipt.bytesTarget === priorIntent.bytesTarget &&
        receipt.keyTarget === priorIntent.keyTarget &&
        receipt.targetDigest === priorIntent.targetDigest &&
        receipt.generation === current.generation,
    );
    if (!terminal) return false;
  }

  const identityChanged =
    current.storeId !== prior.storeId || current.operationNamespace !== prior.operationNamespace;
  if (!identityChanged) return true;
  if (
    current.storeId === prior.storeId ||
    current.operationNamespace === prior.operationNamespace ||
    current.securityEpoch <= prior.securityEpoch
  ) {
    return false;
  }
  const isolation = current.immutableReceipts.find(
    (receipt): receipt is Extract<RecoveryCheckpointReceipt, { kind: "old-authority-isolation" }> =>
      receipt.kind === "old-authority-isolation" &&
      receipt.generation === current.generation &&
      receipt.oldStoreId === prior.storeId &&
      receipt.oldOperationNamespace === prior.operationNamespace &&
      receipt.newStoreId === current.storeId &&
      receipt.newOperationNamespace === current.operationNamespace &&
      receipt.oldJoinCredentialsRejected,
  );
  const tombstone = current.immutableReceipts.find(
    (receipt): receipt is Extract<RecoveryCheckpointReceipt, { kind: "stale-namespace" }> =>
      receipt.kind === "stale-namespace" &&
      receipt.generation === current.generation &&
      receipt.staleNamespace === prior.operationNamespace &&
      receipt.oldStoreId === prior.storeId &&
      receipt.newStoreId === current.storeId,
  );
  return Boolean(
    isolation &&
    tombstone &&
    isolation.recoveryId === tombstone.recoveryId &&
    isolation.confirmationDigest === tombstone.confirmationDigest,
  );
}

async function validateChain(
  chain: readonly AuthenticatedRecoveryCheckpoint[],
  descriptor: RecoveryDescriptor,
  hmac: RecoveryCheckpointHmacPort,
): Promise<boolean> {
  if (!descriptorIsValid(descriptor) || chain.length < descriptor.generation) return false;
  let priorDigest: string | null = null;
  let priorCheckpoint: AuthenticatedRecoveryCheckpoint | undefined;
  for (let index = 0; index < descriptor.generation; index += 1) {
    const checkpoint = chain[index];
    if (
      checkpoint === undefined ||
      checkpoint.payload.generation !== index + 1 ||
      checkpoint.payload.priorRecordDigest !== priorDigest ||
      checkpoint.payload.logicalHostId !== descriptor.logicalHostId ||
      !(await verifyAuthenticatedRecoveryCheckpoint(checkpoint, hmac)) ||
      (priorCheckpoint && !chainTransitionIsValid(priorCheckpoint.payload, checkpoint.payload))
    ) {
      return false;
    }
    priorDigest = checkpoint.digest;
    priorCheckpoint = checkpoint;
  }
  return priorDigest === descriptor.checkpointDigest;
}

async function reconcileSelectedReplicas(
  input: Readonly<{
    descriptor: RecoveryDescriptor;
    descriptorPort: RecoveryDescriptorPort;
    replicas: readonly [RecoveryCheckpointReplicaPort, RecoveryCheckpointReplicaPort];
    hmac: RecoveryCheckpointHmacPort;
  }>,
): Promise<readonly AuthenticatedRecoveryCheckpoint[]> {
  if (!descriptorEquals(await input.descriptorPort.read(), input.descriptor)) {
    throw new CatastrophicRecoveryError("checkpoint_stale");
  }
  const [chainA, chainB] = await Promise.all([
    input.replicas[0].readChain(),
    input.replicas[1].readChain(),
  ] as const);
  const chains = [chainA, chainB] as const;
  for (const chain of chains) {
    if (
      chain.some(
        (checkpoint) =>
          checkpoint.state === "selected" &&
          checkpoint.payload.generation > input.descriptor.generation,
      )
    ) {
      throw new CatastrophicRecoveryError("checkpoint_stale");
    }
  }
  const valid = await Promise.all([
    validateChain(chainA, input.descriptor, input.hmac),
    validateChain(chainB, input.descriptor, input.hmac),
  ] as const);
  if (!valid[0] && !valid[1]) {
    throw new CatastrophicRecoveryError(
      chains[0].length === 0 && chains[1].length === 0 ? "checkpoint_missing" : "checkpoint_stale",
    );
  }
  const selectedChain = (valid[0] ? chainA : chainB).slice(0, input.descriptor.generation);

  for (let index = 0; index < input.replicas.length; index += 1) {
    const replica = input.replicas[index]!;
    if (!valid[index] || chains[index]!.length !== input.descriptor.generation) {
      const repair = await replica.repairSelectedChainAtomically({
        expectedDescriptor: input.descriptor,
        chain: selectedChain,
      });
      if (repair !== "repaired") throw new CatastrophicRecoveryError("checkpoint_stale");
      await replica.fsyncSelectedChain(input.descriptor.generation);
      const reread = await replica.rereadSelectedChain(input.descriptor.generation);
      if (!reread || !(await validateChain(reread, input.descriptor, input.hmac))) {
        throw new CatastrophicRecoveryError("checkpoint_mismatch");
      }
    }
    if (!descriptorEquals(await input.descriptorPort.read(), input.descriptor)) {
      throw new CatastrophicRecoveryError("checkpoint_stale");
    }
    await replica.promoteSelected(input.descriptor.generation, input.descriptor.checkpointDigest);
  }

  const [repairedA, repairedB] = await Promise.all([
    input.replicas[0].readChain(),
    input.replicas[1].readChain(),
  ] as const);
  if (
    !descriptorEquals(await input.descriptorPort.read(), input.descriptor) ||
    !(await validateChain(repairedA, input.descriptor, input.hmac)) ||
    !(await validateChain(repairedB, input.descriptor, input.hmac))
  ) {
    throw new CatastrophicRecoveryError("checkpoint_mismatch");
  }
  return selectedChain;
}

export async function advanceRecoveryCheckpoint(
  input: Readonly<{
    payload: RecoveryCheckpointPayload;
    replicas: readonly [RecoveryCheckpointReplicaPort, RecoveryCheckpointReplicaPort];
    descriptor: RecoveryDescriptorPort;
    hmac: RecoveryCheckpointHmacPort;
    failureInjector?: ((point: CheckpointAdvanceFailurePoint) => void | Promise<void>) | undefined;
  }>,
): Promise<RecoveryDescriptor> {
  assertReplicaLocations(input.replicas);
  const selected = await input.descriptor.read();
  if (selected !== undefined && !descriptorIsValid(selected)) {
    throw new CatastrophicRecoveryError("checkpoint_stale");
  }
  if (selected?.generation === Number.MAX_SAFE_INTEGER) {
    throw new CatastrophicRecoveryError("generation_overflow");
  }
  const expectedGeneration = (selected?.generation ?? 0) + 1;
  const expectedPriorDigest = selected?.checkpointDigest ?? null;
  if (
    input.payload.generation !== expectedGeneration ||
    input.payload.priorRecordDigest !== expectedPriorDigest ||
    (selected !== undefined && selected.logicalHostId !== input.payload.logicalHostId)
  ) {
    throw new CatastrophicRecoveryError("checkpoint_stale");
  }
  const selectedChain = selected
    ? await reconcileSelectedReplicas({
        descriptor: selected,
        descriptorPort: input.descriptor,
        replicas: input.replicas,
        hmac: input.hmac,
      })
    : [];
  const checkpoint = await createAuthenticatedRecoveryCheckpoint(input.payload, input.hmac);
  const next: RecoveryDescriptor = {
    generation: checkpoint.payload.generation,
    checkpointDigest: checkpoint.digest,
    logicalHostId: checkpoint.payload.logicalHostId,
  };
  if (!(await validateChain([...selectedChain, checkpoint], next, input.hmac))) {
    throw new CatastrophicRecoveryError("checkpoint_mismatch");
  }

  const [replicaA, replicaB] = input.replicas;
  const fault = async (point: CheckpointAdvanceFailurePoint) => input.failureInjector?.(point);
  const prepare = async (replica: RecoveryCheckpointReplicaPort, label: "a" | "b") => {
    await fault(`before-replica-${label}-write`);
    await replica.writePrepared(checkpoint);
    await fault(`after-replica-${label}-write`);
    await fault(`before-replica-${label}-fsync`);
    await replica.fsyncPrepared(checkpoint.payload.generation);
    await fault(`after-replica-${label}-fsync`);
    await fault(`before-replica-${label}-verify`);
    const reread = await replica.rereadPrepared(checkpoint.payload.generation);
    if (
      !reread ||
      reread.digest !== checkpoint.digest ||
      !(await verifyAuthenticatedRecoveryCheckpoint(reread, input.hmac))
    ) {
      throw new CatastrophicRecoveryError("checkpoint_authentication_failed");
    }
    await fault(`after-replica-${label}-verify`);
  };

  await prepare(replicaA, "a");
  await prepare(replicaB, "b");
  await fault("before-descriptor-cas");
  if (!(await input.descriptor.compareAndSwap(selected, next))) {
    await Promise.allSettled([
      replicaA.discardUnselected(next.generation, next.checkpointDigest),
      replicaB.discardUnselected(next.generation, next.checkpointDigest),
    ]);
    throw new CatastrophicRecoveryError("checkpoint_conflict");
  }
  await fault("after-descriptor-cas");
  await fault("before-replica-a-promotion");
  await replicaA.promoteSelected(next.generation, next.checkpointDigest);
  await fault("after-replica-a-promotion");
  await fault("before-replica-b-promotion");
  await replicaB.promoteSelected(next.generation, next.checkpointDigest);
  await fault("after-replica-b-promotion");
  return next;
}

export type CatastrophicRecoveryConfirmation = Readonly<{
  token: string;
  recoveryId: string;
  descriptorGeneration: number;
  descriptorDigest: string;
  oldIdentity: RestoreIdentity;
  consequencesCommitment: string;
}>;

export type RecoveryBackupMaterial = Readonly<{
  restored: RestorableControlPlaneState;
  providerCommitment: string;
  keyCommitment: string;
  completeBackupInventory: readonly RecoveryCheckpointInventoryEntry[];
  canonicalBackupInventory: readonly BackupInventoryRecord[];
}>;

export type RestoredSqlMarker = Readonly<{
  recoveryId: string;
  descriptorGeneration: number;
  descriptorDigest: string;
  oldIdentity: RestoreIdentity;
  newIdentity: RestoreIdentity;
  securityEpoch: number;
}>;

export type OldAuthorityIsolationEvidence = Readonly<{
  receiptId: string;
  disposition: "destroyed" | "isolated";
}>;

export type ExternalDestructionEvidence = Readonly<{
  receiptId: string;
  providerId: string;
  bytesTarget: string;
  keyTarget: string;
  targetDigest: string;
  destroyedInventoryRecord: BackupInventoryRecord;
}>;

export interface CatastrophicRecoveryPort {
  validateConfirmationWithoutSideEffects(
    confirmation: CatastrophicRecoveryConfirmation,
    descriptor: RecoveryDescriptor,
  ): Promise<"valid" | "invalid" | "stale" | "reused">;
  claimConfirmation(
    confirmation: CatastrophicRecoveryConfirmation,
  ): Promise<"claimed" | "resume" | "stale" | "reused">;
  loadAndDecryptRecoveryBackup(
    checkpoint: RecoveryCheckpointPayload,
  ): Promise<RecoveryBackupMaterial>;
  allocateNewIdentity(recoveryId: string, oldIdentity: RestoreIdentity): Promise<RestoreIdentity>;
  stageNewStore(
    input: Readonly<{
      recoveryId: string;
      oldIdentity: RestoreIdentity;
      newIdentity: RestoreIdentity;
      state: RestorableControlPlaneState;
    }>,
  ): Promise<void>;
  establishOldAuthorityIsolation(
    input: Readonly<{
      confirmation: CatastrophicRecoveryConfirmation;
      descriptor: RecoveryDescriptor;
      oldIdentity: RestoreIdentity;
      newIdentity: RestoreIdentity;
    }>,
  ): Promise<OldAuthorityIsolationEvidence | "reachable" | "unproven">;
  verifyOldJoinCredentialsRejected(
    input: Readonly<{
      confirmation: CatastrophicRecoveryConfirmation;
      evidence: OldAuthorityIsolationEvidence;
      oldIdentity: RestoreIdentity;
      newIdentity: RestoreIdentity;
    }>,
  ): Promise<boolean>;
  reconcileExternalDestruction(
    input: Readonly<{
      recoveryId: string;
      oldIdentity: RestoreIdentity;
      intent: RecoveryCheckpointDestructionIntent;
    }>,
  ): Promise<ExternalDestructionEvidence | "incomplete">;
  writeRestoredSqlMarkerAtomically(marker: RestoredSqlMarker): Promise<void>;
  readRestoredSqlMarker(recoveryId: string): Promise<RestoredSqlMarker | undefined>;
  enableReadiness(
    input: Readonly<{
      marker: RestoredSqlMarker;
      descriptor: RecoveryDescriptor;
      replicaCheckpointDigests: readonly [string, string];
      state: RestorableControlPlaneState;
      staleNamespaces: readonly string[];
      isolatedStoreIds: readonly string[];
    }>,
  ): Promise<void>;
}

function identityIsValid(value: unknown): value is RestoreIdentity {
  return (
    hasExactKeys(value, ["logicalHostId", "storeId", "operationNamespace"]) &&
    isCanonicalId(value.logicalHostId) &&
    isCanonicalId(value.storeId) &&
    isCanonicalId(value.operationNamespace)
  );
}

function confirmationIsValid(value: unknown): value is CatastrophicRecoveryConfirmation {
  return (
    hasExactKeys(value, [
      "token",
      "recoveryId",
      "descriptorGeneration",
      "descriptorDigest",
      "oldIdentity",
      "consequencesCommitment",
    ]) &&
    isCanonicalId(value.token) &&
    isCanonicalId(value.recoveryId) &&
    isSafePositiveInteger(value.descriptorGeneration) &&
    isSha256(value.descriptorDigest) &&
    identityIsValid(value.oldIdentity) &&
    isSha256(value.consequencesCommitment)
  );
}

function confirmationDigest(confirmation: CatastrophicRecoveryConfirmation): string {
  return sha256(
    stableJsonStringify({
      domain: "caplets/catastrophic-recovery-confirmation/v1",
      recoveryId: confirmation.recoveryId,
      descriptorGeneration: confirmation.descriptorGeneration,
      descriptorDigest: confirmation.descriptorDigest,
      oldIdentity: confirmation.oldIdentity,
      consequencesCommitment: confirmation.consequencesCommitment,
    }),
  );
}

function inventoryEquals(
  left: readonly RecoveryCheckpointInventoryEntry[],
  right: readonly RecoveryCheckpointInventoryEntry[],
): boolean {
  const canonical = (entries: readonly RecoveryCheckpointInventoryEntry[]) =>
    stableJsonStringify(
      [...entries].sort((first, second) => codeUnitCompare(first.backupId, second.backupId)),
    );
  return canonical(left) === canonical(right);
}
function backupRecordMaterialDigest(record: BackupInventoryRecord): string {
  return sha256(
    stableJsonStringify({
      backupId: record.backupId,
      bindingDigest: record.bindingDigest,
      headerDigest: record.headerDigest,
      terminalManifestDigest: record.terminalManifestDigest,
      wrappedKeyDigest: record.wrappedKeyDigest,
      providerIdentity: record.providerIdentity,
      envelopeBytesReference: record.envelopeBytesReference,
      wrappedKeyReference: record.wrappedKeyReference,
      recoveryKeyReference: record.recoveryKeyReference,
      createdAt: record.createdAt,
    }),
  );
}

export function checkpointInventoryEntryForBackupRecord(
  record: BackupInventoryRecord,
  generation: number,
): RecoveryCheckpointInventoryEntry {
  return {
    backupId: record.backupId,
    generation,
    keyVersion: record.recoveryKeyReference.keyVersion,
    state: record.state === "destroyed" ? "destroyed" : "available",
    providerDigest: sha256(record.providerIdentity),
    materialDigest: backupRecordMaterialDigest(record),
    headerDigest: record.headerDigest,
    terminalDigest: record.terminalManifestDigest,
    wrappedKeyDigest: record.wrappedKeyDigest,
    keyReferenceDigest: sha256(stableJsonStringify(record.recoveryKeyReference)),
  };
}

function recoveryKeyReferenceIsValid(value: unknown): boolean {
  return (
    hasExactKeys(value, [
      "provider",
      "providerIdentity",
      "logicalHostId",
      "storeId",
      "profile",
      "purpose",
      "keyId",
      "keyVersion",
    ]) &&
    isCanonicalId(value.provider) &&
    typeof value.providerIdentity === "string" &&
    ASCII_TARGET_PATTERN.test(value.providerIdentity) &&
    isCanonicalId(value.logicalHostId) &&
    isCanonicalId(value.storeId) &&
    isCanonicalId(value.profile) &&
    value.purpose === "backup-recovery" &&
    isCanonicalId(value.keyId) &&
    isSafePositiveInteger(value.keyVersion)
  );
}

function backupRecordIsValid(value: unknown): value is BackupInventoryRecord {
  if (!isRecord(value)) return false;
  const keys = [
    "backupId",
    "bindingDigest",
    "headerDigest",
    "terminalManifestDigest",
    "wrappedKeyDigest",
    "providerIdentity",
    "envelopeBytesReference",
    "wrappedKeyReference",
    "recoveryKeyReference",
    "createdAt",
    "retentionUntil",
    "state",
    ...(Object.hasOwn(value, "finalizedAt") ? ["finalizedAt"] : []),
    ...(Object.hasOwn(value, "destructionId") ? ["destructionId"] : []),
    ...(Object.hasOwn(value, "destroyedAt") ? ["destroyedAt"] : []),
  ];
  if (
    !hasExactKeys(value, keys) ||
    !isCanonicalId(value.backupId) ||
    !isSha256(value.bindingDigest) ||
    !isSha256(value.headerDigest) ||
    !isSha256(value.terminalManifestDigest) ||
    !isSha256(value.wrappedKeyDigest) ||
    typeof value.providerIdentity !== "string" ||
    !ASCII_TARGET_PATTERN.test(value.providerIdentity) ||
    typeof value.envelopeBytesReference !== "string" ||
    !ASCII_TARGET_PATTERN.test(value.envelopeBytesReference) ||
    typeof value.wrappedKeyReference !== "string" ||
    !ASCII_TARGET_PATTERN.test(value.wrappedKeyReference) ||
    !recoveryKeyReferenceIsValid(value.recoveryKeyReference) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.retentionUntil !== "string" ||
    !Number.isFinite(Date.parse(value.retentionUntil)) ||
    !["staged", "finalized", "destruction-intended", "destroyed"].includes(value.state as string)
  ) {
    return false;
  }
  if (
    ("finalizedAt" in value &&
      (typeof value.finalizedAt !== "string" || !Number.isFinite(Date.parse(value.finalizedAt)))) ||
    ("destructionId" in value && !isCanonicalId(value.destructionId)) ||
    ("destroyedAt" in value &&
      (typeof value.destroyedAt !== "string" || !Number.isFinite(Date.parse(value.destroyedAt))))
  ) {
    return false;
  }
  return (
    (value.state === "staged" &&
      !("finalizedAt" in value) &&
      !("destructionId" in value) &&
      !("destroyedAt" in value)) ||
    (value.state === "finalized" &&
      "finalizedAt" in value &&
      !("destructionId" in value) &&
      !("destroyedAt" in value)) ||
    (value.state === "destruction-intended" &&
      "finalizedAt" in value &&
      "destructionId" in value &&
      !("destroyedAt" in value)) ||
    (value.state === "destroyed" &&
      "finalizedAt" in value &&
      "destructionId" in value &&
      "destroyedAt" in value)
  );
}

function canonicalInventoryMatchesCheckpoint(
  records: readonly BackupInventoryRecord[],
  checkpoint: readonly RecoveryCheckpointInventoryEntry[],
): boolean {
  if (
    records.length !== checkpoint.length ||
    !records.every(backupRecordIsValid) ||
    new Set(records.map((record) => record.backupId)).size !== records.length
  ) {
    return false;
  }
  return checkpoint.every((entry) => {
    const record = records.find((candidate) => candidate.backupId === entry.backupId);
    if (!record || (entry.state === "destroyed" && record.state !== "destroyed")) return false;
    const projected = checkpointInventoryEntryForBackupRecord(record, entry.generation);
    return stableJsonStringify({ ...projected, state: entry.state }) === stableJsonStringify(entry);
  });
}

function markerEquals(left: RestoredSqlMarker, right: RestoredSqlMarker): boolean {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function markerIsValid(value: unknown): value is RestoredSqlMarker {
  return (
    hasExactKeys(value, [
      "recoveryId",
      "descriptorGeneration",
      "descriptorDigest",
      "oldIdentity",
      "newIdentity",
      "securityEpoch",
    ]) &&
    isCanonicalId(value.recoveryId) &&
    isSafePositiveInteger(value.descriptorGeneration) &&
    isSha256(value.descriptorDigest) &&
    identityIsValid(value.oldIdentity) &&
    identityIsValid(value.newIdentity) &&
    isSafeNonnegativeInteger(value.securityEpoch)
  );
}

function stringArrayIsValid(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isCanonicalId) && new Set(value).size === value.length;
}

function monotonicEntryIsValid(value: unknown): boolean {
  const keys =
    isRecord(value) && Object.hasOwn(value, "detail")
      ? ["id", "generation", "state", "detail"]
      : ["id", "generation", "state"];
  return (
    hasExactKeys(value, keys) &&
    isCanonicalId(value.id) &&
    isSafeNonnegativeInteger(value.generation) &&
    isCanonicalId(value.state) &&
    (!Object.hasOwn(value, "detail") || isRecord(value.detail))
  );
}

function operationBindingIsValid(value: unknown): value is RestoreOperationBinding {
  return (
    hasExactKeys(value, [
      "operationId",
      "target",
      "logicalHostId",
      "storeId",
      "operationNamespace",
      "actorId",
      "requestIdentity",
      "operationClass",
    ]) &&
    isCanonicalId(value.operationId) &&
    (value.target === "project" || value.target === "global" || value.target === "remote") &&
    isCanonicalId(value.logicalHostId) &&
    isCanonicalId(value.storeId) &&
    isCanonicalId(value.operationNamespace) &&
    isCanonicalId(value.actorId) &&
    isCanonicalId(value.requestIdentity) &&
    (value.operationClass === "logical-state" ||
      value.operationClass === "security-authority" ||
      value.operationClass === "external-effect")
  );
}

function restoredStateIsValid(value: unknown): value is RestorableControlPlaneState {
  if (
    !hasExactKeys(value, [
      "identity",
      "authorityGeneration",
      "effectiveGeneration",
      "securityEpoch",
      "domain",
      "lifecycle",
      "operationOutcomes",
      "security",
    ]) ||
    !identityIsValid(value.identity) ||
    !isSafeNonnegativeInteger(value.authorityGeneration) ||
    !isSafeNonnegativeInteger(value.effectiveGeneration) ||
    !isSafeNonnegativeInteger(value.securityEpoch) ||
    !Array.isArray(value.domain) ||
    !hasExactKeys(value.lifecycle, [
      "backups",
      "finalizations",
      "destructions",
      "keyRetirements",
      "externalDestructionIntents",
      "nonRestorableLedgers",
      "consumedOperationIds",
      "retentionCutoff",
      "purgeWatermark",
    ]) ||
    !hasExactKeys(value.security, [
      "sessions",
      "tokenFamilies",
      "approvals",
      "roles",
      "credentials",
      "projectBindingLeases",
      "vaultGrants",
    ])
  ) {
    return false;
  }

  const domainIds = new Set<string>();
  for (const row of value.domain) {
    const rowKeys =
      isRecord(row) && row.retentionOrdinal === undefined
        ? ["entityId", "value"]
        : ["entityId", "value", "retentionOrdinal"];
    if (
      !hasExactKeys(row, rowKeys) ||
      !isCanonicalId(row.entityId) ||
      !isRecord(row.value) ||
      ("retentionOrdinal" in row && !isSafeNonnegativeInteger(row.retentionOrdinal)) ||
      domainIds.has(row.entityId)
    ) {
      return false;
    }
    domainIds.add(row.entityId);
  }

  const lifecycle = value.lifecycle;
  if (
    !Array.isArray(lifecycle.backups) ||
    !lifecycle.backups.every(backupRecordIsValid) ||
    new Set(lifecycle.backups.map((entry) => entry.backupId)).size !== lifecycle.backups.length
  ) {
    return false;
  }
  const entryArrays = [
    lifecycle.finalizations,
    lifecycle.destructions,
    lifecycle.keyRetirements,
    lifecycle.externalDestructionIntents,
    lifecycle.nonRestorableLedgers,
  ];
  for (const entries of entryArrays) {
    if (!Array.isArray(entries) || !entries.every(monotonicEntryIsValid)) return false;
    const ids = entries.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) return false;
  }
  if (
    !Array.isArray(lifecycle.consumedOperationIds) ||
    !lifecycle.consumedOperationIds.every(operationBindingIsValid) ||
    !isSafeNonnegativeInteger(lifecycle.retentionCutoff) ||
    !isSafeNonnegativeInteger(lifecycle.purgeWatermark)
  ) {
    return false;
  }

  if (!Array.isArray(value.operationOutcomes)) return false;
  for (const outcome of value.operationOutcomes) {
    const keys =
      isRecord(outcome) && Object.hasOwn(outcome, "receipt")
        ? ["binding", "status", "receipt", "effectCommitments"]
        : ["binding", "status", "effectCommitments"];
    if (
      !hasExactKeys(outcome, keys) ||
      !operationBindingIsValid(outcome.binding) ||
      !["reserved", "committed", "not_committed", "superseded_by_restore"].includes(
        outcome.status as string,
      ) ||
      (Object.hasOwn(outcome, "receipt") && !isRecord(outcome.receipt)) ||
      !Array.isArray(outcome.effectCommitments)
    ) {
      return false;
    }
    const effectEntityIds = new Set<string>();
    for (const effect of outcome.effectCommitments) {
      if (
        !hasExactKeys(effect, ["entityId", "after"]) ||
        !isCanonicalId(effect.entityId) ||
        effectEntityIds.has(effect.entityId) ||
        !isRecord(effect.after) ||
        !(
          (hasExactKeys(effect.after, ["kind"]) && effect.after.kind === "absent") ||
          (hasExactKeys(effect.after, ["kind", "value"]) &&
            effect.after.kind === "present" &&
            isRecord(effect.after.value))
        )
      ) {
        return false;
      }
      effectEntityIds.add(effect.entityId);
    }
  }

  return (
    stringArrayIsValid(value.security.sessions) &&
    stringArrayIsValid(value.security.tokenFamilies) &&
    stringArrayIsValid(value.security.approvals) &&
    stringArrayIsValid(value.security.roles) &&
    stringArrayIsValid(value.security.credentials) &&
    stringArrayIsValid(value.security.projectBindingLeases) &&
    stringArrayIsValid(value.security.vaultGrants)
  );
}

function catastrophicState(
  restored: RestorableControlPlaneState,
  checkpoint: RecoveryCheckpointPayload,
  newIdentity: RestoreIdentity,
  canonicalBackupInventory: readonly BackupInventoryRecord[],
  allocated?: Readonly<{ authorityGeneration: number; securityEpoch: number }>,
): RestorableControlPlaneState {
  const authorityGeneration =
    allocated?.authorityGeneration ??
    Math.max(restored.authorityGeneration, checkpoint.generation) + 1;
  const securityEpoch =
    allocated?.securityEpoch ?? Math.max(restored.securityEpoch, checkpoint.securityEpoch) + 1;
  if (!Number.isSafeInteger(authorityGeneration) || !Number.isSafeInteger(securityEpoch)) {
    throw new CatastrophicRecoveryError("generation_overflow");
  }
  const receiptLedger: readonly RestoreMonotonicEntry[] = checkpoint.immutableReceipts.map(
    (receipt) => ({ id: receipt.receiptId, generation: receipt.generation, state: receipt.kind }),
  );
  return {
    ...restored,
    identity: newIdentity,
    authorityGeneration,
    securityEpoch,
    lifecycle: {
      ...restored.lifecycle,
      backups: structuredClone(canonicalBackupInventory),
      destructions: receiptLedger.filter((entry) => entry.state === "destruction"),
      externalDestructionIntents: checkpoint.pendingDestructionIntents.map((intent) => ({
        id: intent.intentId,
        generation: intent.generation,
        state: intent.phase,
      })),
      purgeWatermark: Math.max(
        restored.lifecycle.purgeWatermark,
        ...checkpoint.immutableReceipts
          .filter((receipt) => receipt.kind === "purge")
          .map((receipt) => receipt.generation),
      ),
      consumedOperationIds: [],
    },
    operationOutcomes: [],
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

function nextPayload(
  current: RecoveryCheckpointPayload,
  replacement: Omit<RecoveryCheckpointPayload, "generation" | "priorRecordDigest">,
): RecoveryCheckpointPayload {
  if (current.generation === Number.MAX_SAFE_INTEGER) {
    throw new CatastrophicRecoveryError("generation_overflow");
  }
  return {
    ...replacement,
    generation: current.generation + 1,
    priorRecordDigest: sha256(checkpointCanonicalBytes(current)),
  };
}

function recoveryContinuationIsValid(
  chain: readonly AuthenticatedRecoveryCheckpoint[],
  confirmation: CatastrophicRecoveryConfirmation,
): boolean {
  const commitment = confirmationDigest(confirmation);
  for (let index = confirmation.descriptorGeneration; index < chain.length; index += 1) {
    const payload = chain[index]!.payload;
    const boundReceipt = payload.immutableReceipts.some(
      (receipt) =>
        receipt.kind !== "purge" &&
        receipt.generation === payload.generation &&
        receipt.recoveryId === confirmation.recoveryId &&
        receipt.confirmationDigest === commitment,
    );
    if (!boundReceipt) return false;
  }
  return true;
}

export function createCatastrophicRecoveryCoordinator(
  input: Readonly<{
    replicas: readonly [RecoveryCheckpointReplicaPort, RecoveryCheckpointReplicaPort];
    descriptor: RecoveryDescriptorPort;
    hmac: RecoveryCheckpointHmacPort;
    port: CatastrophicRecoveryPort;
    failureInjector?:
      | ((point: CatastrophicRecoveryFailurePoint) => void | Promise<void>)
      | undefined;
  }>,
) {
  assertReplicaLocations(input.replicas);
  const fault = async (point: CatastrophicRecoveryFailurePoint) => input.failureInjector?.(point);

  return Object.freeze({
    async recover(
      confirmation: CatastrophicRecoveryConfirmation | undefined,
    ): Promise<Readonly<{ state: RestorableControlPlaneState; marker: RestoredSqlMarker }>> {
      if (!confirmation) throw new CatastrophicRecoveryError("confirmation_required");
      if (!confirmationIsValid(confirmation)) {
        throw new CatastrophicRecoveryError("confirmation_invalid");
      }
      const selectedDescriptor = await input.descriptor.read();
      if (!selectedDescriptor) throw new CatastrophicRecoveryError("checkpoint_missing");
      if (!descriptorIsValid(selectedDescriptor)) {
        throw new CatastrophicRecoveryError("checkpoint_stale");
      }
      let descriptor: RecoveryDescriptor = selectedDescriptor;
      if (
        descriptor.logicalHostId !== confirmation.oldIdentity.logicalHostId ||
        descriptor.generation < confirmation.descriptorGeneration ||
        (descriptor.generation === confirmation.descriptorGeneration &&
          descriptor.checkpointDigest !== confirmation.descriptorDigest)
      ) {
        throw new CatastrophicRecoveryError("confirmation_stale");
      }

      const confirmationDescriptor: RecoveryDescriptor = {
        generation: confirmation.descriptorGeneration,
        checkpointDigest: confirmation.descriptorDigest,
        logicalHostId: confirmation.oldIdentity.logicalHostId,
      };
      if (descriptor.generation > confirmation.descriptorGeneration) {
        const chains = await Promise.all(input.replicas.map((replica) => replica.readChain()));
        const validLive = await Promise.all(
          chains.map((chain) => validateChain(chain, descriptor!, input.hmac)),
        );
        const candidate = validLive[0] ? chains[0] : validLive[1] ? chains[1] : undefined;
        const base = candidate?.[confirmation.descriptorGeneration - 1];
        if (
          !base ||
          base.digest !== confirmation.descriptorDigest ||
          !recoveryContinuationIsValid(candidate!, confirmation)
        ) {
          throw new CatastrophicRecoveryError("confirmation_stale");
        }
      }

      const validation = await input.port.validateConfirmationWithoutSideEffects(
        confirmation,
        confirmationDescriptor,
      );
      if (validation !== "valid") {
        throw new CatastrophicRecoveryError(
          validation === "stale"
            ? "confirmation_stale"
            : validation === "reused"
              ? "confirmation_reused"
              : "confirmation_invalid",
        );
      }

      try {
        const claim = await input.port.claimConfirmation(confirmation);
        if (claim === "stale") throw new CatastrophicRecoveryError("confirmation_stale");
        if (claim === "reused") throw new CatastrophicRecoveryError("confirmation_reused");

        let chain = await reconcileSelectedReplicas({
          descriptor,
          descriptorPort: input.descriptor,
          replicas: input.replicas,
          hmac: input.hmac,
        });
        const baseCheckpoint = chain[confirmation.descriptorGeneration - 1];
        if (
          !baseCheckpoint ||
          baseCheckpoint.digest !== confirmation.descriptorDigest ||
          baseCheckpoint.payload.storeId !== confirmation.oldIdentity.storeId ||
          baseCheckpoint.payload.operationNamespace !== confirmation.oldIdentity.operationNamespace
        ) {
          throw new CatastrophicRecoveryError("checkpoint_mismatch");
        }
        if (!recoveryContinuationIsValid(chain, confirmation)) {
          throw new CatastrophicRecoveryError("confirmation_stale");
        }

        const material = await input.port.loadAndDecryptRecoveryBackup(baseCheckpoint.payload);
        if (!restoredStateIsValid(material.restored)) {
          throw new CatastrophicRecoveryError("restored_state_invalid");
        }
        if (
          material.restored.authorityGeneration === Number.MAX_SAFE_INTEGER ||
          material.restored.securityEpoch === Number.MAX_SAFE_INTEGER
        ) {
          throw new CatastrophicRecoveryError("generation_overflow");
        }
        if (
          material.providerCommitment !== baseCheckpoint.payload.providerCommitment ||
          material.keyCommitment !== baseCheckpoint.payload.keyCommitment ||
          material.restored.identity.logicalHostId !== baseCheckpoint.payload.logicalHostId ||
          material.restored.identity.storeId !== baseCheckpoint.payload.storeId ||
          material.restored.identity.operationNamespace !==
            baseCheckpoint.payload.operationNamespace ||
          material.restored.securityEpoch > baseCheckpoint.payload.securityEpoch
        ) {
          throw new CatastrophicRecoveryError("backup_binding_mismatch");
        }
        if (
          !inventoryEquals(
            material.completeBackupInventory,
            baseCheckpoint.payload.backupInventory,
          ) ||
          !canonicalInventoryMatchesCheckpoint(
            material.canonicalBackupInventory,
            baseCheckpoint.payload.backupInventory,
          )
        ) {
          throw new CatastrophicRecoveryError("backup_inventory_incomplete");
        }
        let canonicalBackupInventory = structuredClone(material.canonicalBackupInventory);

        const newIdentity = await input.port.allocateNewIdentity(
          confirmation.recoveryId,
          confirmation.oldIdentity,
        );
        if (
          !identityIsValid(newIdentity) ||
          newIdentity.logicalHostId !== confirmation.oldIdentity.logicalHostId ||
          newIdentity.storeId === confirmation.oldIdentity.storeId ||
          newIdentity.operationNamespace === confirmation.oldIdentity.operationNamespace
        ) {
          throw new CatastrophicRecoveryError("checkpoint_mismatch");
        }
        const initialState = catastrophicState(
          material.restored,
          baseCheckpoint.payload,
          newIdentity,
          canonicalBackupInventory,
        );
        await input.port.stageNewStore({
          recoveryId: confirmation.recoveryId,
          oldIdentity: confirmation.oldIdentity,
          newIdentity,
          state: initialState,
        });

        let currentPayload = chain.at(-1)!.payload;
        const commitment = confirmationDigest(confirmation);
        for (const intent of currentPayload.pendingDestructionIntents) {
          await fault("before-external-deletion");
          const evidence = await input.port.reconcileExternalDestruction({
            recoveryId: confirmation.recoveryId,
            oldIdentity: confirmation.oldIdentity,
            intent,
          });
          await fault("after-external-deletion");
          if (
            evidence === "incomplete" ||
            !hasExactKeys(evidence, [
              "receiptId",
              "providerId",
              "bytesTarget",
              "keyTarget",
              "targetDigest",
              "destroyedInventoryRecord",
            ]) ||
            !isCanonicalId(evidence.receiptId) ||
            evidence.providerId !== intent.providerId ||
            evidence.bytesTarget !== intent.bytesTarget ||
            evidence.keyTarget !== intent.keyTarget ||
            evidence.targetDigest !== intent.targetDigest ||
            !backupRecordIsValid(evidence.destroyedInventoryRecord) ||
            evidence.destroyedInventoryRecord.backupId !== intent.backupId ||
            evidence.destroyedInventoryRecord.providerIdentity !== intent.providerId ||
            evidence.destroyedInventoryRecord.envelopeBytesReference !== intent.bytesTarget ||
            evidence.destroyedInventoryRecord.wrappedKeyReference !== intent.keyTarget ||
            evidence.destroyedInventoryRecord.destructionId !== intent.intentId ||
            evidence.destroyedInventoryRecord.state !== "destroyed"
          ) {
            throw new CatastrophicRecoveryError("external_destruction_incomplete");
          }
          const currentInventory = currentPayload.backupInventory.find(
            (entry) => entry.backupId === intent.backupId,
          );
          if (
            !currentInventory ||
            stableJsonStringify({
              ...checkpointInventoryEntryForBackupRecord(
                evidence.destroyedInventoryRecord,
                currentInventory.generation,
              ),
              state: currentInventory.state,
            }) !== stableJsonStringify(currentInventory)
          ) {
            throw new CatastrophicRecoveryError("external_destruction_incomplete");
          }
          canonicalBackupInventory = canonicalBackupInventory.map((record) =>
            record.backupId === intent.backupId
              ? structuredClone(evidence.destroyedInventoryRecord)
              : record,
          );
          await fault("before-terminal-receipt");
          const terminalReceipt: RecoveryCheckpointReceipt = {
            receiptId: evidence.receiptId,
            generation: currentPayload.generation + 1,
            kind: "destruction",
            recoveryId: confirmation.recoveryId,
            confirmationDigest: commitment,
            targetIntentId: intent.intentId,
            backupId: intent.backupId,
            providerId: intent.providerId,
            bytesTarget: intent.bytesTarget,
            keyTarget: intent.keyTarget,
            targetDigest: intent.targetDigest,
          };
          const payload = nextPayload(currentPayload, {
            ...currentPayload,
            backupInventory: currentPayload.backupInventory.map((entry) =>
              entry.backupId === intent.backupId
                ? { ...entry, state: "destroyed" as const }
                : entry,
            ),
            pendingDestructionIntents: currentPayload.pendingDestructionIntents.filter(
              (entry) => entry.intentId !== intent.intentId,
            ),
            immutableReceipts: [...currentPayload.immutableReceipts, terminalReceipt],
          });
          descriptor = await advanceRecoveryCheckpoint({
            payload,
            replicas: input.replicas,
            descriptor: input.descriptor,
            hmac: input.hmac,
          });
          currentPayload = payload;
          await fault("after-terminal-receipt");
        }

        let isolationReceipt = currentPayload.immutableReceipts.find(
          (
            receipt,
          ): receipt is Extract<RecoveryCheckpointReceipt, { kind: "old-authority-isolation" }> =>
            receipt.kind === "old-authority-isolation" &&
            receipt.recoveryId === confirmation.recoveryId &&
            receipt.confirmationDigest === commitment,
        );
        let isolationEvidence: OldAuthorityIsolationEvidence;
        if (!isolationReceipt) {
          await fault("before-old-authority-isolation");
          const evidence = await input.port.establishOldAuthorityIsolation({
            confirmation,
            descriptor,
            oldIdentity: confirmation.oldIdentity,
            newIdentity,
          });
          if (evidence === "reachable") {
            throw new CatastrophicRecoveryError("old_authority_reachable");
          }
          if (evidence === "unproven") {
            throw new CatastrophicRecoveryError("old_authority_unproven");
          }
          if (
            !hasExactKeys(evidence, ["receiptId", "disposition"]) ||
            !isCanonicalId(evidence.receiptId) ||
            (evidence.disposition !== "destroyed" && evidence.disposition !== "isolated")
          ) {
            throw new CatastrophicRecoveryError("old_authority_unproven");
          }
          isolationEvidence = evidence;
          await fault("after-old-authority-isolation");
          if (
            !(await input.port.verifyOldJoinCredentialsRejected({
              confirmation,
              evidence,
              oldIdentity: confirmation.oldIdentity,
              newIdentity,
            }))
          ) {
            throw new CatastrophicRecoveryError("old_join_credentials_accepted");
          }

          const nextGeneration = currentPayload.generation + 1;
          isolationReceipt = {
            receiptId: evidence.receiptId,
            generation: nextGeneration,
            kind: "old-authority-isolation",
            recoveryId: confirmation.recoveryId,
            confirmationDigest: commitment,
            oldStoreId: confirmation.oldIdentity.storeId,
            oldOperationNamespace: confirmation.oldIdentity.operationNamespace,
            newStoreId: newIdentity.storeId,
            newOperationNamespace: newIdentity.operationNamespace,
            disposition: evidence.disposition,
            oldJoinCredentialsRejected: true,
          };
          const tombstoneReceipt: RecoveryCheckpointReceipt = {
            receiptId: `stale-${confirmation.recoveryId}`,
            generation: nextGeneration,
            kind: "stale-namespace",
            recoveryId: confirmation.recoveryId,
            confirmationDigest: commitment,
            staleNamespace: confirmation.oldIdentity.operationNamespace,
            oldStoreId: confirmation.oldIdentity.storeId,
            newStoreId: newIdentity.storeId,
          };
          await fault("before-new-authority-checkpoint");
          const newAuthorityPayload = nextPayload(currentPayload, {
            ...currentPayload,
            storeId: newIdentity.storeId,
            operationNamespace: newIdentity.operationNamespace,
            securityEpoch: initialState.securityEpoch,
            immutableReceipts: [
              ...currentPayload.immutableReceipts,
              isolationReceipt,
              tombstoneReceipt,
            ],
          });
          descriptor = await advanceRecoveryCheckpoint({
            payload: newAuthorityPayload,
            replicas: input.replicas,
            descriptor: input.descriptor,
            hmac: input.hmac,
          });
          currentPayload = newAuthorityPayload;
          await fault("after-new-authority-checkpoint");
        } else {
          isolationEvidence = {
            receiptId: isolationReceipt.receiptId,
            disposition: isolationReceipt.disposition,
          };
          if (
            currentPayload.storeId !== newIdentity.storeId ||
            currentPayload.operationNamespace !== newIdentity.operationNamespace ||
            !(await input.port.verifyOldJoinCredentialsRejected({
              confirmation,
              evidence: isolationEvidence,
              oldIdentity: confirmation.oldIdentity,
              newIdentity,
            }))
          ) {
            throw new CatastrophicRecoveryError("old_join_credentials_accepted");
          }
        }

        if (
          !canonicalInventoryMatchesCheckpoint(
            canonicalBackupInventory,
            currentPayload.backupInventory,
          )
        ) {
          throw new CatastrophicRecoveryError("backup_inventory_incomplete");
        }
        const finalAuthorityGeneration =
          Math.max(material.restored.authorityGeneration, currentPayload.generation) + 1;
        if (!Number.isSafeInteger(finalAuthorityGeneration)) {
          throw new CatastrophicRecoveryError("generation_overflow");
        }
        const state = catastrophicState(
          material.restored,
          currentPayload,
          newIdentity,
          canonicalBackupInventory,
          {
            authorityGeneration: finalAuthorityGeneration,
            securityEpoch: initialState.securityEpoch,
          },
        );
        if (state.securityEpoch !== currentPayload.securityEpoch) {
          throw new CatastrophicRecoveryError("checkpoint_mismatch");
        }
        await input.port.stageNewStore({
          recoveryId: confirmation.recoveryId,
          oldIdentity: confirmation.oldIdentity,
          newIdentity,
          state,
        });
        const marker: RestoredSqlMarker = {
          recoveryId: confirmation.recoveryId,
          descriptorGeneration: descriptor.generation,
          descriptorDigest: descriptor.checkpointDigest,
          oldIdentity: confirmation.oldIdentity,
          newIdentity,
          securityEpoch: state.securityEpoch,
        };
        await fault("before-restored-sql-marker");
        const existingMarker = await input.port.readRestoredSqlMarker(confirmation.recoveryId);
        if (
          existingMarker &&
          (!markerIsValid(existingMarker) || !markerEquals(existingMarker, marker))
        ) {
          throw new CatastrophicRecoveryError("restored_sql_marker_mismatch");
        }
        if (!existingMarker) await input.port.writeRestoredSqlMarkerAtomically(marker);
        await fault("after-restored-sql-marker");

        const selectedAfterWrite = await input.descriptor.read();
        if (!descriptorEquals(selectedAfterWrite, descriptor)) {
          throw new CatastrophicRecoveryError("checkpoint_stale");
        }
        chain = await reconcileSelectedReplicas({
          descriptor,
          descriptorPort: input.descriptor,
          replicas: input.replicas,
          hmac: input.hmac,
        });
        const replicaChains = await Promise.all(
          input.replicas.map((replica) => replica.readChain()),
        );
        const replicaDigests = replicaChains.map(
          (replicaChain) => replicaChain[descriptor.generation - 1]?.digest,
        );
        if (
          chain.at(-1)?.digest !== descriptor.checkpointDigest ||
          replicaDigests[0] !== descriptor.checkpointDigest ||
          replicaDigests[1] !== descriptor.checkpointDigest
        ) {
          throw new CatastrophicRecoveryError("checkpoint_mismatch");
        }
        const markerAfterWrite = await input.port.readRestoredSqlMarker(confirmation.recoveryId);
        if (
          !markerAfterWrite ||
          !markerIsValid(markerAfterWrite) ||
          !markerEquals(markerAfterWrite, marker)
        ) {
          throw new CatastrophicRecoveryError("restored_sql_marker_mismatch");
        }
        await input.port.enableReadiness({
          marker,
          descriptor,
          replicaCheckpointDigests: [replicaDigests[0], replicaDigests[1]],
          state,
          staleNamespaces: [confirmation.oldIdentity.operationNamespace],
          isolatedStoreIds: [confirmation.oldIdentity.storeId],
        });
        return { state, marker };
      } catch (error) {
        if (error instanceof CatastrophicRecoveryError) throw error;
        throw new CatastrophicRecoveryError("recovery_interrupted");
      }
    },
  });
}
