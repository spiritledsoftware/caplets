import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CapletsError } from "../../errors";
import {
  validateCurrentHostConfirmation,
  type CurrentHostAuthorityToken,
  type CurrentHostConfirmationToken,
} from "../../current-host/operations";
import { stableJsonStringify } from "../../stable-json";
import {
  DEFAULT_RECOVERY_CHUNK_PLAINTEXT_LIMIT,
  RECOVERY_ENVELOPE_VERSION,
  assertRecoveryEnvelopeBinding,
  assertRecoveryEnvelopeHeader,
  assertRecoveryTerminalManifest,
  assertRecoveryKeyReference,
  canonicalRecoveryBytes,
  createRecoveryEnvelopeHeader,
  decodeRecoveryBase64,
  recoveryChunkAssociatedData,
  recoveryChunkDigest,
  recoveryChunkNonce,
  recoveryEnvelopeBindingDigest,
  recoveryEnvelopeHeaderDigest,
  recoveryTerminalAssociatedData,
  recoveryTerminalManifestDigest,
  recoveryTerminalNonce,
  sameRecoveryEnvelopeBinding,
  sameRecoveryKeyReference,
  sha256RecoveryBytes,
  type RecoveryEnvelopeBinding,
  type RecoveryEnvelopeChunkFrame,
  type RecoveryEnvelopeChunkMetadata,
  type RecoveryEnvelopeHeader,
  type RecoveryEnvelopeTerminalFrame,
  type RecoveryEnvelopeTerminalManifest,
  type RecoveryKeyReference,
  type RecoveryUnwrapAuthority,
  type RecoveryWrapAuthority,
} from "./manifest";
import { unwrapConvertedRecoveryKeySlot, type ConvertedRecoveryWrappedKey } from "./key-conversion";

export type {
  RecoveryEnvelopeBinding,
  RecoveryKeyReference,
  RecoveryUnwrapAuthority,
  RecoveryWrapAuthority,
} from "./manifest";

const MAX_ENCODED_RECOVERY_FRAME_BYTES = 32 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DESTRUCTION_ACTION = "backup-destruction";

export interface RecoveryEnvelopeSink {
  readonly providerIdentity: string;
  readonly envelopeBytesReference: string;
  writeEnvelopeBytes(bytes: Uint8Array): Promise<void>;
}

export interface RecoveryWrappedKeySink {
  readonly providerIdentity: string;
  readonly wrappedKeyReference: string;
  writeWrappedKey(reference: RecoveryKeyReference, bytes: Uint8Array): Promise<void>;
}

export interface RecoveryWrappedKeySource {
  readWrappedKey(reference: RecoveryKeyReference): Promise<Uint8Array | undefined>;
}

export type RecoveryEnvelopeWriteResult = Readonly<{
  bindingDigest: string;
  headerDigest: string;
  terminalManifestDigest: string;
  wrappedKeyDigest: string;
  chunkCount: number;
  plaintextLength: number;
}>;

export type RecoveryEnvelopeReadResult = RecoveryEnvelopeWriteResult;
export type RecoveryBackupIntentPhase =
  | "staged"
  | "wrapped-key-written"
  | "envelope-written"
  | "finalized";

export type RecoveryBackupIntent = Readonly<{
  version: 1;
  backupId: string;
  bindingDigest: string;
  providerIdentity: string;
  envelopeBytesReference: string;
  wrappedKeyReference: string;
  recoveryKeyReference: RecoveryKeyReference;
  createdAt: string;
  phase: RecoveryBackupIntentPhase;
  wrappedKeyDigest?: string | undefined;
  headerDigest?: string | undefined;
  terminalManifestDigest?: string | undefined;
  chunkCount?: number | undefined;
  plaintextLength?: number | undefined;
  finalizedAt?: string | undefined;
}>;

export interface RecoveryBackupLifecycleTransaction {
  readBackupIntent(backupId: string): Promise<RecoveryBackupIntent | undefined>;
  writeBackupIntent(intent: RecoveryBackupIntent): Promise<void>;
}

export interface RecoveryBackupLifecyclePort {
  transaction<T>(work: (transaction: RecoveryBackupLifecycleTransaction) => Promise<T>): Promise<T>;
}

/**
 * Writes the wrapped key separately, then streams canonical envelope frames to the byte sink.
 * A failed write is not a finalized backup; callers reconcile the staged material through the
 * lifecycle ledger rather than treating partial bytes as recoverable.
 */
export async function writeRecoveryEnvelope(
  input: Readonly<{
    binding: RecoveryEnvelopeBinding;
    source: AsyncIterable<Uint8Array>;
    wrapAuthority: RecoveryWrapAuthority;
    envelopeSink: RecoveryEnvelopeSink;
    wrappedKeySink: RecoveryWrappedKeySink;
    backupLifecycle: RecoveryBackupLifecyclePort;
    backupIntent: RecoveryBackupIntent;
    finalizedAt: string;
    chunkPlaintextLimit?: number | undefined;
  }>,
): Promise<RecoveryEnvelopeWriteResult> {
  assertRecoveryEnvelopeBinding(input.binding);
  if (
    !sameRecoveryKeyReference(input.binding.recoveryKeyReference, input.wrapAuthority.reference)
  ) {
    throw recoveryVerificationError();
  }
  assertBackupIntent(input.backupIntent);
  if (
    input.backupIntent.phase !== "staged" ||
    input.backupIntent.bindingDigest !== recoveryEnvelopeBindingDigest(input.binding) ||
    !sameRecoveryKeyReference(
      input.backupIntent.recoveryKeyReference,
      input.binding.recoveryKeyReference,
    ) ||
    input.backupIntent.providerIdentity !== input.envelopeSink.providerIdentity ||
    input.backupIntent.providerIdentity !== input.wrappedKeySink.providerIdentity ||
    input.backupIntent.envelopeBytesReference !== input.envelopeSink.envelopeBytesReference ||
    input.backupIntent.wrappedKeyReference !== input.wrappedKeySink.wrappedKeyReference
  ) {
    throw recoveryVerificationError();
  }
  assertTimestamp(input.finalizedAt);
  const chunkPlaintextLimit = input.chunkPlaintextLimit ?? DEFAULT_RECOVERY_CHUNK_PLAINTEXT_LIMIT;
  const dataKey = randomBytes(32);
  const noncePrefix = randomBytes(4);
  try {
    await input.backupLifecycle.transaction(async (transaction) => {
      const existing = await transaction.readBackupIntent(input.backupIntent.backupId);
      if (existing !== undefined) throw recoveryVerificationError();
      await transaction.writeBackupIntent(input.backupIntent);
    });
    const wrappedKey = Buffer.from(await input.wrapAuthority.wrapDataKey(dataKey));
    if (wrappedKey.byteLength === 0) throw recoveryVerificationError();
    const wrappedKeyDigest = sha256RecoveryBytes(wrappedKey);
    const header = createRecoveryEnvelopeHeader({
      binding: input.binding,
      noncePrefix,
      wrappedKeyDigest,
      chunkPlaintextLimit,
    });
    const headerDigest = recoveryEnvelopeHeaderDigest(header);
    await input.wrappedKeySink.writeWrappedKey(input.binding.recoveryKeyReference, wrappedKey);
    await persistBackupIntentPhase(
      input.backupLifecycle,
      input.backupIntent,
      "wrapped-key-written",
      { wrappedKeyDigest },
    );
    wrappedKey.fill(0);
    await input.envelopeSink.writeEnvelopeBytes(encodeRecoveryFrame(header));

    const orderedMetadataHash = createHash("sha256");
    let chunkCount = 0;
    let priorDigest = headerDigest;
    let plaintextLength = 0;
    for await (const suppliedChunk of input.source) {
      if (!(suppliedChunk instanceof Uint8Array)) throw recoveryVerificationError();
      for (let offset = 0; offset < suppliedChunk.byteLength; offset += chunkPlaintextLimit) {
        const plaintext = suppliedChunk.subarray(
          offset,
          Math.min(offset + chunkPlaintextLimit, suppliedChunk.byteLength),
        );
        if (plaintext.byteLength === 0) continue;
        const ordinal = chunkCount;
        if (!Number.isSafeInteger(ordinal)) throw recoveryVerificationError();
        const associatedData = recoveryChunkAssociatedData({
          headerDigest,
          ordinal,
          plaintextLength: plaintext.byteLength,
          priorDigest,
        });
        const cipher = createCipheriv(
          "aes-256-gcm",
          dataKey,
          recoveryChunkNonce(noncePrefix, ordinal),
        );
        cipher.setAAD(associatedData);
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const authenticationTag = cipher.getAuthTag();
        const digest = recoveryChunkDigest({ associatedData, ciphertext, authenticationTag });
        const chunkMetadata: RecoveryEnvelopeChunkMetadata = {
          ordinal,
          plaintextLength: plaintext.byteLength,
          priorDigest,
          digest,
        };
        const frame: RecoveryEnvelopeChunkFrame = {
          type: "chunk",
          ...chunkMetadata,
          ciphertext: ciphertext.toString("base64"),
          authenticationTag: authenticationTag.toString("base64"),
        };
        await input.envelopeSink.writeEnvelopeBytes(encodeRecoveryFrame(frame));
        orderedMetadataHash.update(canonicalRecoveryBytes(chunkMetadata));
        chunkCount += 1;
        priorDigest = digest;
        plaintextLength += plaintext.byteLength;
        if (!Number.isSafeInteger(plaintextLength)) throw recoveryVerificationError();
      }
    }

    const terminalManifest: RecoveryEnvelopeTerminalManifest = {
      version: RECOVERY_ENVELOPE_VERSION,
      headerDigest,
      chunkCount,
      plaintextLength,
      orderedChunkMetadataDigest: orderedMetadataHash.digest("hex"),
      lastChunkDigest: priorDigest,
    };
    const terminalCipher = createCipheriv(
      "aes-256-gcm",
      dataKey,
      recoveryTerminalNonce(noncePrefix),
    );
    terminalCipher.setAAD(recoveryTerminalAssociatedData(terminalManifest));
    terminalCipher.final();
    const terminalFrame: RecoveryEnvelopeTerminalFrame = {
      type: "terminal",
      manifest: terminalManifest,
      authenticationTag: terminalCipher.getAuthTag().toString("base64"),
    };
    await input.envelopeSink.writeEnvelopeBytes(encodeRecoveryFrame(terminalFrame));
    const result: RecoveryEnvelopeWriteResult = {
      bindingDigest: recoveryEnvelopeBindingDigest(input.binding),
      headerDigest,
      terminalManifestDigest: recoveryTerminalManifestDigest(terminalManifest),
      wrappedKeyDigest,
      chunkCount,
      plaintextLength,
    };
    const wrappedIntent = {
      ...input.backupIntent,
      phase: "wrapped-key-written" as const,
      wrappedKeyDigest,
    };
    await persistBackupIntentPhase(
      input.backupLifecycle,
      wrappedIntent,
      "envelope-written",
      result,
    );
    await persistBackupIntentPhase(
      input.backupLifecycle,
      { ...wrappedIntent, phase: "envelope-written", ...result },
      "finalized",
      { finalizedAt: input.finalizedAt },
    );
    return result;
  } catch (error) {
    if (
      error instanceof CapletsError &&
      error.message === "Recovery envelope verification failed."
    ) {
      throw error;
    }
    throw recoveryVerificationError();
  } finally {
    dataKey.fill(0);
    noncePrefix.fill(0);
  }
}

export interface RecoveryPlaintextStagingTransaction {
  stageChunk(chunk: Uint8Array, metadata: RecoveryEnvelopeChunkMetadata): Promise<void>;
  commit(result: RecoveryEnvelopeReadResult): Promise<void>;
  abort(): Promise<void>;
}

export interface RecoveryPlaintextStagingPort {
  begin(): Promise<RecoveryPlaintextStagingTransaction>;
}

/**
 * Owns the staging transaction: authenticated chunks remain disposable until the terminal frame
 * authenticates, and every terminal or sink failure aborts the transaction before rejection.
 */
export async function decryptRecoveryEnvelope(
  input: Readonly<{
    source: AsyncIterable<Uint8Array>;
    expectedBinding: RecoveryEnvelopeBinding;
    plaintextSink: RecoveryPlaintextStagingPort;
  }> &
    (
      | Readonly<{
          unwrapAuthority: RecoveryUnwrapAuthority;
          wrappedKeySource: RecoveryWrappedKeySource;
          convertedKeySlot?: never;
        }>
      | Readonly<{
          unwrapAuthority: RecoveryUnwrapAuthority;
          convertedKeySlot: ConvertedRecoveryWrappedKey;
          wrappedKeySource?: never;
        }>
    ),
): Promise<RecoveryEnvelopeReadResult> {
  let dataKey: Buffer | undefined;
  let exactUnwrappedDataKey: Uint8Array | undefined;
  let staging: RecoveryPlaintextStagingTransaction | undefined;
  try {
    assertRecoveryEnvelopeBinding(input.expectedBinding);
    staging = await input.plaintextSink.begin();
    const frames = decodeRecoveryFrames(input.source);
    const first = await frames.next();
    if (first.done) throw recoveryVerificationError();
    const header = parseHeaderFrame(first.value);
    const usesConvertedSlot = input.convertedKeySlot !== undefined;
    if (
      !sameRecoveryEnvelopeBinding(header.binding, input.expectedBinding) ||
      (!usesConvertedSlot &&
        !sameRecoveryKeyReference(
          header.binding.recoveryKeyReference,
          input.unwrapAuthority.reference,
        ))
    ) {
      throw recoveryVerificationError();
    }
    if (usesConvertedSlot) {
      exactUnwrappedDataKey = await unwrapConvertedRecoveryKeySlot({
        slot: input.convertedKeySlot,
        backupId: input.convertedKeySlot.backupId,
        sourceHeaderDigest: recoveryEnvelopeHeaderDigest(header),
        sourceWrappedKeyDigest: header.wrappedKeyDigest,
        sourceRecoveryKeyReference: header.binding.recoveryKeyReference,
        destinationAuthority: input.unwrapAuthority,
      });
      dataKey = Buffer.from(exactUnwrappedDataKey);
    } else {
      const wrappedKeyBytes = await input.wrappedKeySource.readWrappedKey(
        header.binding.recoveryKeyReference,
      );
      if (wrappedKeyBytes === undefined) throw recoveryVerificationError();
      const wrappedKey = Buffer.from(wrappedKeyBytes);
      try {
        if (sha256RecoveryBytes(wrappedKey) !== header.wrappedKeyDigest) {
          throw recoveryVerificationError();
        }
        exactUnwrappedDataKey = await input.unwrapAuthority.unwrapDataKey(wrappedKey);
        dataKey = Buffer.from(exactUnwrappedDataKey);
      } finally {
        wrappedKey.fill(0);
      }
    }
    if (dataKey.byteLength !== 32) throw recoveryVerificationError();

    const headerDigest = recoveryEnvelopeHeaderDigest(header);
    const noncePrefix = decodeRecoveryBase64(header.noncePrefix);
    const orderedMetadataHash = createHash("sha256");
    let chunkCount = 0;
    let plaintextLength = 0;
    let priorDigest = headerDigest;
    let terminalManifest: RecoveryEnvelopeTerminalManifest | undefined;

    for await (const value of frames) {
      if (terminalManifest !== undefined) throw recoveryVerificationError();
      const parsed = parseCanonicalFrame(value);
      if (parsed.type === "terminal") {
        const terminal = parseTerminalFrame(parsed);
        assertRecoveryTerminalManifest(terminal.manifest);
        const orderedChunkMetadataDigest = orderedMetadataHash.digest("hex");
        if (
          terminal.manifest.headerDigest !== headerDigest ||
          terminal.manifest.chunkCount !== chunkCount ||
          terminal.manifest.plaintextLength !== plaintextLength ||
          terminal.manifest.orderedChunkMetadataDigest !== orderedChunkMetadataDigest ||
          terminal.manifest.lastChunkDigest !== priorDigest
        ) {
          throw recoveryVerificationError();
        }
        const authenticationTag = decodeRecoveryBase64(terminal.authenticationTag);
        if (authenticationTag.byteLength !== 16) throw recoveryVerificationError();
        const decipher = createDecipheriv(
          "aes-256-gcm",
          dataKey,
          recoveryTerminalNonce(noncePrefix),
        );
        decipher.setAAD(recoveryTerminalAssociatedData(terminal.manifest));
        decipher.setAuthTag(authenticationTag);
        decipher.final();
        terminalManifest = terminal.manifest;
        continue;
      }
      const chunk = parseChunkFrame(parsed);
      if (
        chunk.ordinal !== chunkCount ||
        chunk.priorDigest !== priorDigest ||
        chunk.plaintextLength < 1 ||
        chunk.plaintextLength > header.chunkPlaintextLimit
      ) {
        throw recoveryVerificationError();
      }
      const associatedData = recoveryChunkAssociatedData({
        headerDigest,
        ordinal: chunk.ordinal,
        plaintextLength: chunk.plaintextLength,
        priorDigest: chunk.priorDigest,
      });
      const ciphertext = decodeRecoveryBase64(chunk.ciphertext);
      const authenticationTag = decodeRecoveryBase64(chunk.authenticationTag);
      if (
        authenticationTag.byteLength !== 16 ||
        ciphertext.byteLength !== chunk.plaintextLength ||
        recoveryChunkDigest({ associatedData, ciphertext, authenticationTag }) !== chunk.digest
      ) {
        throw recoveryVerificationError();
      }
      const decipher = createDecipheriv(
        "aes-256-gcm",
        dataKey,
        recoveryChunkNonce(noncePrefix, chunk.ordinal),
      );
      decipher.setAAD(associatedData);
      decipher.setAuthTag(authenticationTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      try {
        if (plaintext.byteLength !== chunk.plaintextLength) throw recoveryVerificationError();
        const chunkMetadata: RecoveryEnvelopeChunkMetadata = {
          ordinal: chunk.ordinal,
          plaintextLength: chunk.plaintextLength,
          priorDigest: chunk.priorDigest,
          digest: chunk.digest,
        };
        await staging.stageChunk(plaintext, chunkMetadata);
        orderedMetadataHash.update(canonicalRecoveryBytes(chunkMetadata));
      } finally {
        plaintext.fill(0);
      }
      chunkCount += 1;
      priorDigest = chunk.digest;
      plaintextLength += chunk.plaintextLength;
      if (!Number.isSafeInteger(plaintextLength)) throw recoveryVerificationError();
    }
    if (terminalManifest === undefined) throw recoveryVerificationError();
    const result: RecoveryEnvelopeReadResult = {
      bindingDigest: recoveryEnvelopeBindingDigest(header.binding),
      headerDigest,
      terminalManifestDigest: recoveryTerminalManifestDigest(terminalManifest),
      wrappedKeyDigest: header.wrappedKeyDigest,
      chunkCount: terminalManifest.chunkCount,
      plaintextLength: terminalManifest.plaintextLength,
    };
    await staging.commit(result);
    return result;
  } catch {
    await staging?.abort().catch(() => undefined);
    throw recoveryVerificationError();
  } finally {
    dataKey?.fill(0);
    exactUnwrappedDataKey?.fill(0);
  }
}

async function persistBackupIntentPhase(
  lifecycle: RecoveryBackupLifecyclePort,
  expected: RecoveryBackupIntent,
  phase: RecoveryBackupIntentPhase,
  fields: Partial<RecoveryBackupIntent>,
): Promise<void> {
  await lifecycle.transaction(async (transaction) => {
    const current = await transaction.readBackupIntent(expected.backupId);
    if (!current || !isDeepStrictEqual(current, expected)) throw recoveryVerificationError();
    const next = { ...current, ...fields, phase };
    assertBackupIntent(next);
    await transaction.writeBackupIntent(next);
  });
}

function assertBackupIntent(intent: RecoveryBackupIntent): void {
  assertNonEmpty(intent.backupId);
  assertNonEmpty(intent.providerIdentity);
  assertNonEmpty(intent.envelopeBytesReference);
  assertNonEmpty(intent.wrappedKeyReference);
  assertRecoveryKeyReference(intent.recoveryKeyReference);
  assertTimestamp(intent.createdAt);
  const requiredKeys = [
    "backupId",
    "bindingDigest",
    "createdAt",
    "envelopeBytesReference",
    "phase",
    "providerIdentity",
    "recoveryKeyReference",
    "version",
    "wrappedKeyReference",
  ];
  if (intent.phase !== "staged") requiredKeys.push("wrappedKeyDigest");
  if (intent.phase === "envelope-written" || intent.phase === "finalized") {
    requiredKeys.push("chunkCount", "headerDigest", "plaintextLength", "terminalManifestDigest");
  }
  if (intent.phase === "finalized") requiredKeys.push("finalizedAt");
  const actualKeys = Object.keys(intent);
  if (
    intent.version !== 1 ||
    !["staged", "wrapped-key-written", "envelope-written", "finalized"].includes(intent.phase) ||
    !SHA256_PATTERN.test(intent.bindingDigest) ||
    actualKeys.length !== requiredKeys.length ||
    requiredKeys.some((key) => !Object.hasOwn(intent, key)) ||
    (intent.wrappedKeyDigest !== undefined && !SHA256_PATTERN.test(intent.wrappedKeyDigest)) ||
    (intent.headerDigest !== undefined && !SHA256_PATTERN.test(intent.headerDigest)) ||
    (intent.terminalManifestDigest !== undefined &&
      !SHA256_PATTERN.test(intent.terminalManifestDigest)) ||
    (intent.chunkCount !== undefined &&
      (!Number.isSafeInteger(intent.chunkCount) || intent.chunkCount < 0)) ||
    (intent.plaintextLength !== undefined &&
      (!Number.isSafeInteger(intent.plaintextLength) || intent.plaintextLength < 0))
  ) {
    throw recoveryVerificationError();
  }
  if (intent.finalizedAt !== undefined) assertTimestamp(intent.finalizedAt);
}

export type BackupInventoryState = "staged" | "finalized" | "destruction-intended" | "destroyed";

export type BackupInventoryRecord = Readonly<{
  backupId: string;
  bindingDigest: string;
  headerDigest: string;
  terminalManifestDigest: string;
  wrappedKeyDigest: string;
  providerIdentity: string;
  envelopeBytesReference: string;
  wrappedKeyReference: string;
  recoveryKeyReference: RecoveryKeyReference;
  createdAt: string;
  retentionUntil: string;
  state: BackupInventoryState;
  finalizedAt?: string | undefined;
  destructionId?: string | undefined;
  destroyedAt?: string | undefined;
}>;

export type BackupInventorySnapshot = Readonly<{
  version: number;
  purgeWatermark: number;
  records: readonly BackupInventoryRecord[];
}>;

export type BackupDestructionPreviewRecord = Readonly<{
  token: CurrentHostConfirmationToken;
  inventoryHash: string;
  target: BackupDestructionTarget;
  consumedAt?: string | undefined;
}>;

export type BackupDestructionTarget = Readonly<{
  backupId: string;
  providerIdentity: string;
  envelopeBytesReference: string;
  wrappedKeyReference: string;
  recoveryKeyReference: RecoveryKeyReference;
}>;

export type BackupDestructionPhase =
  | "confirmed"
  | "bytes-deleting"
  | "bytes-deleted"
  | "key-deleting"
  | "key-deleted"
  | "completed";
export type BackupDestructionReceipt = Readonly<{
  version: 1;
  destructionId: string;
  backupId: string;
  confirmationId: string;
  inventoryHash: string;
  targetDigest: string;
  completedAt: string;
  bytesAbsent: true;
  wrappedKeyAbsent: true;
  receiptDigest: string;
}>;

export type BackupDestructionIntent = Readonly<{
  version: 1;
  destructionId: string;
  confirmationId: string;
  inventoryHash: string;
  targetDigest: string;
  target: BackupDestructionTarget;
  phase: BackupDestructionPhase;
  createdAt: string;
  receipt?: BackupDestructionReceipt | undefined;
}>;

export interface BackupLifecycleTransaction {
  readAuthorityToken(): Promise<CurrentHostAuthorityToken>;
  readInventory(): Promise<BackupInventorySnapshot>;
  writeInventory(snapshot: BackupInventorySnapshot): Promise<void>;
  readDestructionPreview(tokenId: string): Promise<BackupDestructionPreviewRecord | undefined>;
  writeDestructionPreview(preview: BackupDestructionPreviewRecord): Promise<void>;
  readDestructionIntent(destructionId: string): Promise<BackupDestructionIntent | undefined>;
  writeDestructionIntent(intent: BackupDestructionIntent): Promise<void>;
}

export interface BackupLifecycleLedgerPort {
  /** Runs one serializable transaction; writes are rolled back if the callback rejects. */
  transaction<T>(work: (transaction: BackupLifecycleTransaction) => Promise<T>): Promise<T>;
}

export interface RecoveryMaterialDestructionPort {
  readonly providerIdentity: string;
  envelopeBytesExist(reference: string): Promise<boolean>;
  deleteEnvelopeBytes(reference: string): Promise<void>;
  wrappedKeyExists(reference: string): Promise<boolean>;
  deleteWrappedKey(reference: string): Promise<void>;
}

export async function recordBackupInventory(
  ledger: BackupLifecycleLedgerPort,
  record: BackupInventoryRecord,
): Promise<BackupInventoryRecord> {
  assertBackupRecord(record);
  if (record.state !== "staged") throw lifecycleError("Backup inventory must begin staged.");
  return ledger.transaction(async (transaction) => {
    const current = await transaction.readInventory();
    assertInventorySnapshot(current);
    const existing = current.records.find((candidate) => candidate.backupId === record.backupId);
    if (existing) {
      if (
        !isDeepStrictEqual(immutableBackupRecord(existing), immutableBackupRecord(record)) ||
        existing.retentionUntil !== record.retentionUntil
      ) {
        throw lifecycleError("Backup inventory conflicts.");
      }
      return existing;
    }
    const next: BackupInventorySnapshot = {
      version: current.version + 1,
      purgeWatermark: current.purgeWatermark,
      records: [...current.records, structuredClone(record)].sort((left, right) =>
        left.backupId < right.backupId ? -1 : left.backupId > right.backupId ? 1 : 0,
      ),
    };
    await transaction.writeInventory(next);
    return record;
  });
}

export async function finalizeBackupInventory(
  ledger: BackupLifecycleLedgerPort,
  input: Readonly<{
    backupId: string;
    headerDigest: string;
    terminalManifestDigest: string;
    retentionUntil: string;
    finalizedAt: string;
  }>,
): Promise<BackupInventoryRecord> {
  return ledger.transaction(async (transaction) => {
    const current = await transaction.readInventory();
    assertInventorySnapshot(current);
    const existing = current.records.find((record) => record.backupId === input.backupId);
    if (!existing) throw lifecycleError("Backup inventory is missing.");
    if (
      existing.headerDigest !== input.headerDigest ||
      existing.terminalManifestDigest !== input.terminalManifestDigest ||
      existing.retentionUntil !== input.retentionUntil
    ) {
      throw lifecycleError("Backup finalization does not match staged material.");
    }
    if (existing.state !== "staged") return existing;
    assertTimestamp(input.finalizedAt);
    const finalized: BackupInventoryRecord = {
      ...existing,
      state: "finalized",
      finalizedAt: input.finalizedAt,
    };
    await transaction.writeInventory({
      ...current,
      version: current.version + 1,
      records: current.records.map((record) =>
        record.backupId === input.backupId ? finalized : record,
      ),
    });
    return finalized;
  });
}

export async function mergeBackupInventory(
  ledger: BackupLifecycleLedgerPort,
  restored: BackupInventorySnapshot,
): Promise<BackupInventorySnapshot> {
  assertInventorySnapshot(restored);
  return ledger.transaction(async (transaction) => {
    const current = await transaction.readInventory();
    const merged = mergeBackupInventorySnapshots(current, restored);
    if (!isDeepStrictEqual(current, merged)) await transaction.writeInventory(merged);
    return merged;
  });
}

export function mergeBackupInventorySnapshots(
  current: BackupInventorySnapshot,
  restored: BackupInventorySnapshot,
): BackupInventorySnapshot {
  assertInventorySnapshot(current);
  assertInventorySnapshot(restored);
  const records = new Map(current.records.map((record) => [record.backupId, record]));
  for (const restoredRecord of restored.records) {
    const currentRecord = records.get(restoredRecord.backupId);
    records.set(
      restoredRecord.backupId,
      currentRecord ? mergeBackupRecord(currentRecord, restoredRecord) : restoredRecord,
    );
  }
  const mergedRecords = [...records.values()].sort((left, right) =>
    left.backupId < right.backupId ? -1 : left.backupId > right.backupId ? 1 : 0,
  );
  const purgeWatermark = Math.max(current.purgeWatermark, restored.purgeWatermark);
  if (
    purgeWatermark === current.purgeWatermark &&
    isDeepStrictEqual(mergedRecords, current.records)
  ) {
    return current;
  }
  return {
    version: Math.max(current.version, restored.version) + 1,
    purgeWatermark,
    records: mergedRecords,
  };
}

export async function advanceBackupPurgeWatermark(
  ledger: BackupLifecycleLedgerPort,
  watermark: number,
): Promise<number> {
  if (!Number.isSafeInteger(watermark) || watermark < 0) {
    throw lifecycleError("Backup purge watermark is invalid.");
  }
  return ledger.transaction(async (transaction) => {
    const current = await transaction.readInventory();
    assertInventorySnapshot(current);
    if (watermark < current.purgeWatermark) {
      throw lifecycleError("Backup purge watermark cannot regress.");
    }
    if (watermark === current.purgeWatermark) return watermark;
    await transaction.writeInventory({
      ...current,
      version: current.version + 1,
      purgeWatermark: watermark,
    });
    return watermark;
  });
}

export async function previewBackupDestruction(
  ledger: BackupLifecycleLedgerPort,
  input: Readonly<{
    backupId: string;
    authorityToken: CurrentHostAuthorityToken;
    tokenId: string;
    expiresAt: string;
    consequences: readonly string[];
  }>,
): Promise<CurrentHostConfirmationToken> {
  assertNonEmpty(input.tokenId);
  assertTimestamp(input.expiresAt);
  return ledger.transaction(async (transaction) => {
    const [currentAuthorityToken, inventory] = await Promise.all([
      transaction.readAuthorityToken(),
      transaction.readInventory(),
    ]);
    assertInventorySnapshot(inventory);
    if (!isDeepStrictEqual(currentAuthorityToken, input.authorityToken)) {
      throw lifecycleError("Backup destruction preview authority is stale.");
    }
    const backup = inventory.records.find((record) => record.backupId === input.backupId);
    if (!backup || backup.state !== "finalized") {
      throw lifecycleError("Backup is not eligible for destruction preview.");
    }
    const existing = await transaction.readDestructionPreview(input.tokenId);
    if (existing) throw lifecycleError("Backup destruction preview ID already exists.");
    const target = destructionTarget(backup);
    const inventoryHash = backupInventoryHash(inventory);
    const token: CurrentHostConfirmationToken = {
      version: 1,
      tokenId: input.tokenId,
      consumed: false,
      action: DESTRUCTION_ACTION,
      logicalHostId: backup.recoveryKeyReference.logicalHostId,
      storeId: backup.recoveryKeyReference.storeId,
      authorityToken: currentAuthorityToken,
      affectedVersions: [
        `backup:${backup.backupId}`,
        `inventory:${inventory.version}`,
        `recovery-key:${recoveryKeyReferenceDigest(backup.recoveryKeyReference)}`,
      ],
      expiresAt: input.expiresAt,
      consequences: [...input.consequences],
    };
    await transaction.writeDestructionPreview({ token, inventoryHash, target });
    return token;
  });
}

export type ConfirmBackupDestructionResult =
  | Readonly<{ status: "confirmed"; intent: BackupDestructionIntent }>
  | Readonly<{
      status: "unchanged";
      reason: "missing" | "stale" | "mismatched" | "reused";
    }>;

export async function confirmBackupDestruction(
  ledger: BackupLifecycleLedgerPort,
  input: Readonly<{
    confirmation?: CurrentHostConfirmationToken | undefined;
    destructionId: string;
    now?: Date | undefined;
  }>,
): Promise<ConfirmBackupDestructionResult> {
  if (input.confirmation === undefined) return { status: "unchanged", reason: "missing" };
  assertNonEmpty(input.destructionId);
  const now = input.now ?? new Date();
  return ledger.transaction(async (transaction) => {
    const stored = await transaction.readDestructionPreview(input.confirmation!.tokenId);
    if (!stored) return { status: "unchanged", reason: "mismatched" };
    if (stored.consumedAt !== undefined) return { status: "unchanged", reason: "reused" };
    if (!isDeepStrictEqual(stored.token, input.confirmation)) {
      return { status: "unchanged", reason: "mismatched" };
    }
    try {
      validateCurrentHostConfirmation(
        input.confirmation!,
        {
          action: stored.token.action,
          logicalHostId: stored.token.logicalHostId,
          storeId: stored.token.storeId,
          authorityToken: stored.token.authorityToken,
          affectedVersions: stored.token.affectedVersions,
        },
        now,
      );
    } catch {
      return { status: "unchanged", reason: "stale" };
    }
    const [currentAuthorityToken, inventory, existingIntent] = await Promise.all([
      transaction.readAuthorityToken(),
      transaction.readInventory(),
      transaction.readDestructionIntent(input.destructionId),
    ]);
    if (existingIntent) return { status: "unchanged", reason: "reused" };
    if (!isDeepStrictEqual(currentAuthorityToken, stored.token.authorityToken)) {
      return { status: "unchanged", reason: "stale" };
    }
    assertInventorySnapshot(inventory);
    const backup = inventory.records.find((record) => record.backupId === stored.target.backupId);
    if (
      backup?.state !== "finalized" ||
      backupInventoryHash(inventory) !== stored.inventoryHash ||
      !isDeepStrictEqual(destructionTarget(backup), stored.target)
    ) {
      return { status: "unchanged", reason: "stale" };
    }
    const createdAt = now.toISOString();
    const targetDigest = destructionTargetDigest(stored.target);
    const intent: BackupDestructionIntent = {
      version: 1,
      destructionId: input.destructionId,
      confirmationId: stored.token.tokenId,
      inventoryHash: stored.inventoryHash,
      targetDigest,
      target: stored.target,
      phase: "confirmed",
      createdAt,
    };
    const intended: BackupInventoryRecord = {
      ...backup,
      state: "destruction-intended",
      destructionId: input.destructionId,
    };
    await transaction.writeDestructionPreview({ ...stored, consumedAt: createdAt });
    await transaction.writeDestructionIntent(intent);
    await transaction.writeInventory({
      ...inventory,
      version: inventory.version + 1,
      records: inventory.records.map((record) =>
        record.backupId === backup.backupId ? intended : record,
      ),
    });
    return { status: "confirmed", intent };
  });
}

export async function reconcileBackupDestruction(
  ledger: BackupLifecycleLedgerPort,
  material: RecoveryMaterialDestructionPort,
  destructionId: string,
  now: () => Date = () => new Date(),
): Promise<BackupDestructionReceipt> {
  assertNonEmpty(destructionId);
  for (;;) {
    const intent = await ledger.transaction(async (transaction) => {
      const current = await transaction.readDestructionIntent(destructionId);
      if (!current) throw lifecycleError("Backup destruction intent is missing.");
      assertDestructionIntent(current);
      return current;
    });
    if (material.providerIdentity !== intent.target.providerIdentity) {
      throw lifecycleError("Backup destruction provider does not match the confirmed target.");
    }
    switch (intent.phase) {
      case "confirmed":
        await transitionDestruction(ledger, intent, "bytes-deleting");
        break;
      case "bytes-deleting":
        if (await material.envelopeBytesExist(intent.target.envelopeBytesReference)) {
          await material.deleteEnvelopeBytes(intent.target.envelopeBytesReference);
        }
        if (await material.envelopeBytesExist(intent.target.envelopeBytesReference)) {
          throw lifecycleError("Backup bytes absence could not be verified.");
        }
        await transitionDestruction(ledger, intent, "bytes-deleted");
        break;
      case "bytes-deleted":
        await transitionDestruction(ledger, intent, "key-deleting");
        break;
      case "key-deleting":
        if (await material.wrappedKeyExists(intent.target.wrappedKeyReference)) {
          await material.deleteWrappedKey(intent.target.wrappedKeyReference);
        }
        if (await material.wrappedKeyExists(intent.target.wrappedKeyReference)) {
          throw lifecycleError("Wrapped key absence could not be verified.");
        }
        await transitionDestruction(ledger, intent, "key-deleted");
        break;
      case "key-deleted": {
        const receiptWithoutDigest = {
          version: 1 as const,
          destructionId: intent.destructionId,
          backupId: intent.target.backupId,
          confirmationId: intent.confirmationId,
          inventoryHash: intent.inventoryHash,
          targetDigest: intent.targetDigest,
          completedAt: now().toISOString(),
          bytesAbsent: true as const,
          wrappedKeyAbsent: true as const,
        };
        const receipt: BackupDestructionReceipt = {
          ...receiptWithoutDigest,
          receiptDigest: sha256RecoveryBytes(canonicalRecoveryBytes(receiptWithoutDigest)),
        };
        await completeDestruction(ledger, intent, receipt);
        break;
      }
      case "completed":
        if (!intent.receipt) throw lifecycleError("Backup destruction receipt is missing.");
        return intent.receipt;
    }
  }
}

function mergeBackupRecord(
  current: BackupInventoryRecord,
  restored: BackupInventoryRecord,
): BackupInventoryRecord {
  const immutableCurrent = immutableBackupRecord(current);
  const immutableRestored = immutableBackupRecord(restored);
  if (!isDeepStrictEqual(immutableCurrent, immutableRestored)) {
    throw lifecycleError("Backup inventory identity conflicts.");
  }
  const rank: Record<BackupInventoryState, number> = {
    staged: 0,
    finalized: 1,
    "destruction-intended": 2,
    destroyed: 3,
  };
  const advanced = rank[current.state] >= rank[restored.state] ? current : restored;
  const other = advanced === current ? restored : current;
  return {
    ...advanced,
    retentionUntil:
      Date.parse(current.retentionUntil) >= Date.parse(restored.retentionUntil)
        ? current.retentionUntil
        : restored.retentionUntil,
    ...((advanced.finalizedAt ?? other.finalizedAt)
      ? { finalizedAt: advanced.finalizedAt ?? other.finalizedAt }
      : {}),
    ...((advanced.destructionId ?? other.destructionId)
      ? { destructionId: advanced.destructionId ?? other.destructionId }
      : {}),
    ...((advanced.destroyedAt ?? other.destroyedAt)
      ? { destroyedAt: advanced.destroyedAt ?? other.destroyedAt }
      : {}),
  };
}

function immutableBackupRecord(record: BackupInventoryRecord) {
  return {
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
  };
}

function destructionTarget(record: BackupInventoryRecord): BackupDestructionTarget {
  return {
    backupId: record.backupId,
    providerIdentity: record.providerIdentity,
    envelopeBytesReference: record.envelopeBytesReference,
    wrappedKeyReference: record.wrappedKeyReference,
    recoveryKeyReference: record.recoveryKeyReference,
  };
}

async function transitionDestruction(
  ledger: BackupLifecycleLedgerPort,
  expected: BackupDestructionIntent,
  phase: BackupDestructionPhase,
): Promise<void> {
  await ledger.transaction(async (transaction) => {
    const current = await transaction.readDestructionIntent(expected.destructionId);
    if (!current) throw lifecycleError("Backup destruction intent is missing.");
    assertSameDestructionTarget(current, expected);
    if (current.phase !== expected.phase) return;
    await transaction.writeDestructionIntent({ ...current, phase });
  });
}

async function completeDestruction(
  ledger: BackupLifecycleLedgerPort,
  expected: BackupDestructionIntent,
  receipt: BackupDestructionReceipt,
): Promise<void> {
  await ledger.transaction(async (transaction) => {
    const current = await transaction.readDestructionIntent(expected.destructionId);
    if (!current) throw lifecycleError("Backup destruction intent is missing.");
    assertSameDestructionTarget(current, expected);
    assertDestructionReceipt(receipt, current);
    if (current.phase === "completed") return;
    if (current.phase !== "key-deleted") return;
    const inventory = await transaction.readInventory();
    assertInventorySnapshot(inventory);
    const backup = inventory.records.find((record) => record.backupId === current.target.backupId);
    if (
      backup?.state !== "destruction-intended" ||
      backup.destructionId !== current.destructionId ||
      !isDeepStrictEqual(destructionTarget(backup), current.target)
    ) {
      throw lifecycleError("Backup destruction target changed.");
    }
    await transaction.writeDestructionIntent({ ...current, phase: "completed", receipt });
    await transaction.writeInventory({
      ...inventory,
      version: inventory.version + 1,
      records: inventory.records.map((record) =>
        record.backupId === backup.backupId
          ? { ...backup, state: "destroyed", destroyedAt: receipt.completedAt }
          : record,
      ),
    });
  });
}

function assertSameDestructionTarget(
  current: BackupDestructionIntent,
  expected: BackupDestructionIntent,
): void {
  assertDestructionIntent(current);
  if (
    current.version !== expected.version ||
    current.destructionId !== expected.destructionId ||
    current.confirmationId !== expected.confirmationId ||
    current.inventoryHash !== expected.inventoryHash ||
    current.targetDigest !== expected.targetDigest ||
    current.createdAt !== expected.createdAt ||
    !isDeepStrictEqual(current.target, expected.target)
  ) {
    throw lifecycleError("Backup destruction target changed.");
  }
}

function assertDestructionIntent(intent: BackupDestructionIntent): void {
  assertNonEmpty(intent.destructionId);
  assertNonEmpty(intent.confirmationId);
  assertTimestamp(intent.createdAt);
  if (
    intent.version !== 1 ||
    intent.targetDigest !== destructionTargetDigest(intent.target) ||
    ![
      "confirmed",
      "bytes-deleting",
      "bytes-deleted",
      "key-deleting",
      "key-deleted",
      "completed",
    ].includes(intent.phase) ||
    (intent.phase === "completed") !== (intent.receipt !== undefined)
  ) {
    throw lifecycleError("Backup destruction intent is invalid.");
  }
  if (intent.receipt !== undefined) assertDestructionReceipt(intent.receipt, intent);
}

function assertInventorySnapshot(snapshot: BackupInventorySnapshot): void {
  if (
    !Number.isSafeInteger(snapshot.version) ||
    snapshot.version < 0 ||
    !Number.isSafeInteger(snapshot.purgeWatermark) ||
    snapshot.purgeWatermark < 0
  ) {
    throw lifecycleError("Backup inventory is invalid.");
  }
  let previous: string | undefined;
  for (const record of snapshot.records) {
    assertBackupRecord(record);
    if (previous !== undefined && previous >= record.backupId) {
      throw lifecycleError("Backup inventory is not canonical.");
    }
    previous = record.backupId;
  }
}

function assertBackupRecord(record: BackupInventoryRecord): void {
  assertNonEmpty(record.backupId);
  assertNonEmpty(record.providerIdentity);
  assertNonEmpty(record.envelopeBytesReference);
  assertNonEmpty(record.wrappedKeyReference);
  if (
    !SHA256_PATTERN.test(record.bindingDigest) ||
    !SHA256_PATTERN.test(record.headerDigest) ||
    !SHA256_PATTERN.test(record.terminalManifestDigest) ||
    !SHA256_PATTERN.test(record.wrappedKeyDigest)
  ) {
    throw lifecycleError("Backup inventory digest is invalid.");
  }
  assertTimestamp(record.createdAt);
  assertTimestamp(record.retentionUntil);
  if (record.finalizedAt !== undefined) assertTimestamp(record.finalizedAt);
  if (record.destroyedAt !== undefined) assertTimestamp(record.destroyedAt);
  const exactLifecycle =
    (record.state === "staged" &&
      record.finalizedAt === undefined &&
      record.destructionId === undefined &&
      record.destroyedAt === undefined) ||
    (record.state === "finalized" &&
      record.finalizedAt !== undefined &&
      record.destructionId === undefined &&
      record.destroyedAt === undefined) ||
    (record.state === "destruction-intended" &&
      record.finalizedAt !== undefined &&
      record.destructionId !== undefined &&
      record.destroyedAt === undefined) ||
    (record.state === "destroyed" &&
      record.finalizedAt !== undefined &&
      record.destructionId !== undefined &&
      record.destroyedAt !== undefined);
  if (!exactLifecycle) throw lifecycleError("Backup inventory lifecycle is invalid.");
  assertRecoveryKeyReference(record.recoveryKeyReference);
}

function assertDestructionReceipt(
  receipt: BackupDestructionReceipt,
  intent: BackupDestructionIntent,
): void {
  const { receiptDigest, ...withoutDigest } = receipt;
  if (
    !hasExactKeys(receipt as unknown as Record<string, unknown>, [
      "backupId",
      "bytesAbsent",
      "completedAt",
      "confirmationId",
      "destructionId",
      "inventoryHash",
      "receiptDigest",
      "targetDigest",
      "version",
      "wrappedKeyAbsent",
    ]) ||
    receipt.version !== 1 ||
    receipt.destructionId !== intent.destructionId ||
    receipt.confirmationId !== intent.confirmationId ||
    receipt.inventoryHash !== intent.inventoryHash ||
    receipt.targetDigest !== intent.targetDigest ||
    receipt.backupId !== intent.target.backupId ||
    receipt.bytesAbsent !== true ||
    receipt.wrappedKeyAbsent !== true ||
    receiptDigest !== sha256RecoveryBytes(canonicalRecoveryBytes(withoutDigest))
  ) {
    throw lifecycleError("Backup destruction receipt is invalid.");
  }
  assertTimestamp(receipt.completedAt);
}

function backupInventoryHash(inventory: BackupInventorySnapshot): string {
  return sha256RecoveryBytes(canonicalRecoveryBytes(inventory));
}

function recoveryKeyReferenceDigest(reference: RecoveryKeyReference): string {
  return sha256RecoveryBytes(canonicalRecoveryBytes(reference));
}

function destructionTargetDigest(target: BackupDestructionTarget): string {
  return sha256RecoveryBytes(canonicalRecoveryBytes(target));
}

function encodeRecoveryFrame(value: unknown): Buffer {
  const body = canonicalRecoveryBytes(value);
  if (body.byteLength > MAX_ENCODED_RECOVERY_FRAME_BYTES) throw recoveryVerificationError();
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(body.byteLength);
  return Buffer.concat([length, body]);
}

async function* decodeRecoveryFrames(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Buffer, void, void> {
  const lengthBytes = Buffer.allocUnsafe(4);
  let lengthBytesRead = 0;
  let frame: Buffer | undefined;
  let frameBytesRead = 0;
  for await (const input of source) {
    if (!(input instanceof Uint8Array)) throw recoveryVerificationError();
    let inputOffset = 0;
    while (inputOffset < input.byteLength) {
      if (frame === undefined) {
        const copied = Math.min(4 - lengthBytesRead, input.byteLength - inputOffset);
        lengthBytes.set(input.subarray(inputOffset, inputOffset + copied), lengthBytesRead);
        lengthBytesRead += copied;
        inputOffset += copied;
        if (lengthBytesRead < 4) continue;
        const length = lengthBytes.readUInt32BE(0);
        if (length < 2 || length > MAX_ENCODED_RECOVERY_FRAME_BYTES) {
          throw recoveryVerificationError();
        }
        frame = Buffer.allocUnsafe(length);
        frameBytesRead = 0;
        lengthBytesRead = 0;
      }
      const copied = Math.min(frame.byteLength - frameBytesRead, input.byteLength - inputOffset);
      frame.set(input.subarray(inputOffset, inputOffset + copied), frameBytesRead);
      frameBytesRead += copied;
      inputOffset += copied;
      if (frameBytesRead === frame.byteLength) {
        yield frame;
        frame = undefined;
        frameBytesRead = 0;
      }
    }
  }
  if (lengthBytesRead !== 0 || frame !== undefined) throw recoveryVerificationError();
}

function parseHeaderFrame(bytes: Uint8Array): RecoveryEnvelopeHeader {
  const parsed = parseCanonicalFrame(bytes);
  if (
    parsed.type !== "header" ||
    !hasExactKeys(parsed, [
      "algorithm",
      "binding",
      "chunkPlaintextLimit",
      "noncePrefix",
      "type",
      "version",
      "wrappedKeyDigest",
    ])
  ) {
    throw recoveryVerificationError();
  }
  const header = parsed as RecoveryEnvelopeHeader;
  assertRecoveryEnvelopeHeader(header);
  return header;
}

function parseChunkFrame(parsed: Record<string, unknown>): RecoveryEnvelopeChunkFrame {
  if (
    parsed.type !== "chunk" ||
    !hasExactKeys(parsed, [
      "authenticationTag",
      "ciphertext",
      "digest",
      "ordinal",
      "plaintextLength",
      "priorDigest",
      "type",
    ]) ||
    typeof parsed.ciphertext !== "string" ||
    typeof parsed.authenticationTag !== "string" ||
    typeof parsed.digest !== "string" ||
    typeof parsed.priorDigest !== "string" ||
    typeof parsed.ordinal !== "number" ||
    typeof parsed.plaintextLength !== "number"
  ) {
    throw recoveryVerificationError();
  }
  return parsed as RecoveryEnvelopeChunkFrame;
}

function parseTerminalFrame(parsed: Record<string, unknown>): RecoveryEnvelopeTerminalFrame {
  if (
    parsed.type !== "terminal" ||
    !hasExactKeys(parsed, ["authenticationTag", "manifest", "type"]) ||
    typeof parsed.authenticationTag !== "string" ||
    typeof parsed.manifest !== "object" ||
    parsed.manifest === null
  ) {
    throw recoveryVerificationError();
  }
  return parsed as RecoveryEnvelopeTerminalFrame;
}

function parseCanonicalFrame(bytes: Uint8Array): Record<string, unknown> {
  try {
    const text = Buffer.from(bytes).toString("utf8");
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      stableJsonStringify(parsed) !== text
    ) {
      throw recoveryVerificationError();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw recoveryVerificationError();
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function assertNonEmpty(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,256}$/u.test(value)) {
    throw lifecycleError("Recovery lifecycle identifier is invalid.");
  }
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value)))
    throw lifecycleError("Recovery lifecycle timestamp is invalid.");
}

function lifecycleError(message: string): CapletsError {
  return new CapletsError("REQUEST_INVALID", message);
}

function recoveryVerificationError(): CapletsError {
  return new CapletsError("AUTH_FAILED", "Recovery envelope verification failed.");
}
