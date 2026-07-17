import { createHmac, timingSafeEqual } from "node:crypto";
import type { Hmac } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CapletsError } from "../../errors";
import {
  canonicalRecoveryBytes,
  sameRecoveryKeyReference,
  sha256RecoveryBytes,
  type RecoveryKeyReference,
  type RecoveryUnwrapAuthority,
  type RecoveryWrapAuthority,
} from "./manifest";
import type { BackupInventoryRecord, BackupInventorySnapshot } from "./backup";

export type RecoveryKeyLifecycleState =
  | "active"
  | "decrypt-only"
  | "retired"
  | "destruction-intended"
  | "destroyed";

export type RecoveryKeyLifecycle = Readonly<{
  reference: RecoveryKeyReference;
  state: RecoveryKeyLifecycleState;
}>;

export type ConvertedRecoveryWrappedKey = Readonly<{
  backupId: string;
  sourceRecoveryKeyReference: RecoveryKeyReference;
  recoveryKeyReference: RecoveryKeyReference;
  wrappedDataKey: Uint8Array;
  sourceHeaderDigest: string;
  sourceWrappedKeyDigest: string;
  wrappedKeyDigest: string;
  authenticationTag: Uint8Array;
}>;

/** A key remains retirement-blocked until every inventory reference is durably destroyed. */
export function recoveryKeyHasRetainedReferences(
  inventory: BackupInventorySnapshot,
  reference: RecoveryKeyReference,
): boolean {
  return inventory.records.some(
    (bundle) =>
      bundle.state !== "destroyed" &&
      sameRecoveryKeyReference(bundle.recoveryKeyReference, reference),
  );
}

export function assertRecoveryKeyRetirementAllowed(
  inventory: BackupInventorySnapshot,
  reference: RecoveryKeyReference,
): void {
  if (recoveryKeyHasRetainedReferences(inventory, reference)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Recovery key retirement is blocked by retained recovery bundles.",
    );
  }
}

export interface RecoveryKeyRetirementTransaction {
  readInventory(): Promise<BackupInventorySnapshot>;
  readKeyLifecycle(reference: RecoveryKeyReference): Promise<RecoveryKeyLifecycle | undefined>;
  writeKeyLifecycle(lifecycle: RecoveryKeyLifecycle): Promise<void>;
}

export interface RecoveryKeyRetirementPort {
  transaction<T>(work: (transaction: RecoveryKeyRetirementTransaction) => Promise<T>): Promise<T>;
}

export async function retireRecoveryKeyTransactionally(
  port: RecoveryKeyRetirementPort,
  reference: RecoveryKeyReference,
): Promise<RecoveryKeyLifecycle> {
  return port.transaction(async (transaction) => {
    const [inventory, lifecycle] = await Promise.all([
      transaction.readInventory(),
      transaction.readKeyLifecycle(reference),
    ]);
    if (
      lifecycle === undefined ||
      !sameRecoveryKeyReference(lifecycle.reference, reference) ||
      (lifecycle.state !== "active" && lifecycle.state !== "decrypt-only")
    ) {
      throw conversionRefused();
    }
    assertRecoveryKeyRetirementAllowed(inventory, reference);
    const retired: RecoveryKeyLifecycle = { reference, state: "retired" };
    await transaction.writeKeyLifecycle(retired);
    return retired;
  });
}

/**
 * Produces an authenticated destination key slot bound to one selected retained bundle.
 * The slot can decrypt only that bundle's unchanged authenticated envelope.
 */
export async function convertRecoveryWrappedDataKey(
  input: Readonly<{
    bundle: BackupInventoryRecord;
    inventory: BackupInventorySnapshot;
    wrappedDataKey: Uint8Array;
    sourceAuthority: RecoveryUnwrapAuthority;
    sourceKey: RecoveryKeyLifecycle;
    destinationAuthority: RecoveryWrapAuthority;
    destinationKey: RecoveryKeyLifecycle;
  }>,
): Promise<ConvertedRecoveryWrappedKey> {
  const retained = input.inventory.records.find(
    (candidate) => candidate.backupId === input.bundle.backupId,
  );
  if (
    !retained ||
    !isDeepStrictEqual(retained, input.bundle) ||
    retained.state !== "finalized" ||
    input.wrappedDataKey.byteLength === 0 ||
    sha256RecoveryBytes(input.wrappedDataKey) !== retained.wrappedKeyDigest
  ) {
    throw conversionRefused();
  }
  if (
    !sameRecoveryKeyReference(retained.recoveryKeyReference, input.sourceKey.reference) ||
    !sameRecoveryKeyReference(input.sourceKey.reference, input.sourceAuthority.reference) ||
    (input.sourceKey.state !== "active" && input.sourceKey.state !== "decrypt-only") ||
    !sameRecoveryKeyReference(
      input.destinationKey.reference,
      input.destinationAuthority.reference,
    ) ||
    input.destinationKey.state !== "active"
  ) {
    throw conversionRefused();
  }

  let dataKey: Buffer | undefined;
  let exactUnwrappedDataKey: Uint8Array | undefined;
  try {
    exactUnwrappedDataKey = await input.sourceAuthority.unwrapDataKey(input.wrappedDataKey);
    dataKey = Buffer.from(exactUnwrappedDataKey);
    if (dataKey.byteLength !== 32) throw conversionRefused();
    const converted = Buffer.from(await input.destinationAuthority.wrapDataKey(dataKey));
    if (converted.byteLength === 0) throw conversionRefused();
    const wrappedKeyDigest = sha256RecoveryBytes(converted);
    const authenticatedSlot = {
      backupId: retained.backupId,
      sourceHeaderDigest: retained.headerDigest,
      sourceWrappedKeyDigest: retained.wrappedKeyDigest,
      sourceRecoveryKeyReference: retained.recoveryKeyReference,
      recoveryKeyReference: input.destinationKey.reference,
      wrappedKeyDigest,
    };
    return {
      ...authenticatedSlot,
      wrappedDataKey: converted,
      authenticationTag: createHmac("sha256", dataKey)
        .update(canonicalRecoveryBytes(authenticatedSlot))
        .digest(),
    };
  } catch (error) {
    if (error instanceof CapletsError && error.code === "REQUEST_INVALID") throw error;
    throw conversionRefused();
  } finally {
    dataKey?.fill(0);
    exactUnwrappedDataKey?.fill(0);
  }
}

export async function unwrapConvertedRecoveryKeySlot(
  input: Readonly<{
    slot: ConvertedRecoveryWrappedKey;
    backupId: string;
    sourceHeaderDigest: string;
    sourceWrappedKeyDigest: string;
    sourceRecoveryKeyReference: RecoveryKeyReference;
    destinationAuthority: RecoveryUnwrapAuthority;
  }>,
): Promise<Uint8Array> {
  let dataKey: Uint8Array | undefined;
  try {
    if (
      input.slot.backupId !== input.backupId ||
      input.slot.sourceHeaderDigest !== input.sourceHeaderDigest ||
      input.slot.sourceWrappedKeyDigest !== input.sourceWrappedKeyDigest ||
      !sameRecoveryKeyReference(
        input.slot.sourceRecoveryKeyReference,
        input.sourceRecoveryKeyReference,
      ) ||
      !sameRecoveryKeyReference(
        input.slot.recoveryKeyReference,
        input.destinationAuthority.reference,
      ) ||
      sha256RecoveryBytes(input.slot.wrappedDataKey) !== input.slot.wrappedKeyDigest
    ) {
      throw conversionRefused();
    }
    dataKey = await input.destinationAuthority.unwrapDataKey(input.slot.wrappedDataKey);
    if (dataKey.byteLength !== 32) throw conversionRefused();
    const authenticatedSlot = {
      backupId: input.slot.backupId,
      sourceHeaderDigest: input.slot.sourceHeaderDigest,
      sourceWrappedKeyDigest: input.slot.sourceWrappedKeyDigest,
      sourceRecoveryKeyReference: input.slot.sourceRecoveryKeyReference,
      recoveryKeyReference: input.slot.recoveryKeyReference,
      wrappedKeyDigest: input.slot.wrappedKeyDigest,
    };
    const expectedTag = createHmac("sha256", dataKey)
      .update(canonicalRecoveryBytes(authenticatedSlot))
      .digest();
    if (
      input.slot.authenticationTag.byteLength !== expectedTag.byteLength ||
      !timingSafeEqual(input.slot.authenticationTag, expectedTag)
    ) {
      throw conversionRefused();
    }
    return dataKey;
  } catch (error) {
    dataKey?.fill(0);
    if (error instanceof CapletsError && error.code === "REQUEST_INVALID") throw error;
    throw conversionRefused();
  }
}

export const DEFAULT_TRANSFER_RECORD_PLAINTEXT_LIMIT = 64 * 1024;

export type TransferCipherPurpose = "active-record" | "vault-record";

export type TransferCipherCapabilityScope = Readonly<{
  profile: "transfer-source" | "transfer-destination";
  transferId: string;
  logicalHostId: string;
  storeId: string;
  keyringIdentity: string;
  expiresAt: string;
}>;

export type TransferEncryptedRecord = Readonly<{
  kind: "encrypted";
  ordinal: number;
  recordId: string;
  purpose: TransferCipherPurpose;
  keyVersion: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authenticationTag: Uint8Array;
  associatedData: Uint8Array;
}>;

export type TransferHighEntropyVerifierRecord = Readonly<{
  kind: "high-entropy-verifier";
  ordinal: number;
  recordId: string;
  algorithm: "SHA-256";
  verifier: Uint8Array;
}>;

export type TransferShortCodeVerifierRecord = Readonly<{
  kind: "short-code-verifier";
  ordinal: number;
  recordId: string;
  algorithm: "HMAC-SHA-256";
  verifierVersion: 1;
  keyVersion: number;
  verifier: Uint8Array;
}>;

export type TransferInvalidatedShortCodeRecord = Readonly<{
  kind: "invalidated-short-code";
  ordinal: number;
  recordId: string;
  invalidatedAt: string;
  reason: string;
}>;

export type TransferSecurityRecord =
  | TransferEncryptedRecord
  | TransferHighEntropyVerifierRecord
  | TransferShortCodeVerifierRecord
  | TransferInvalidatedShortCodeRecord;

export interface TransferSourceCipherCapability {
  readonly scope: TransferCipherCapabilityScope & Readonly<{ profile: "transfer-source" }>;
  decryptRecord(record: Omit<TransferEncryptedRecord, "kind" | "ordinal">): Promise<Uint8Array>;
}

export type TransferDestinationCiphertext = Readonly<{
  keyVersion: number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authenticationTag: Uint8Array;
}>;

export interface TransferDestinationCipherCapability {
  readonly scope: TransferCipherCapabilityScope & Readonly<{ profile: "transfer-destination" }>;
  encryptRecord(
    record: Readonly<{
      recordId: string;
      purpose: TransferCipherPurpose;
      plaintext: Uint8Array;
      associatedData: Uint8Array;
    }>,
  ): Promise<TransferDestinationCiphertext>;
}

export interface TransferSecurityRecordSink {
  /**
   * Staging is keyed by ordinal and must be an idempotent replace until destination activation.
   * A failed run never finalizes rows, so replay may safely replace randomized ciphertext.
   */
  stageConvertedRecord(record: TransferSecurityRecord): Promise<void>;
}

export type TransferSecurityConversionResult = Readonly<{
  recordCount: number;
  encryptedRecordCount: number;
  preservedVerifierCount: number;
  invalidatedShortCodeCount: number;
  semanticCommitment: string;
}>;

/**
 * Converts one security record at a time. Only authenticated ciphertext plaintext enters memory,
 * it is zeroed before advancing the source iterator, and neither errors nor results contain it.
 * Recovery authority is intentionally absent from both transfer capability interfaces.
 */
export async function convertTransferSecurityRecords(
  input: Readonly<{
    scope: Readonly<{ transferId: string; logicalHostId: string; storeId: string }>;
    sourceCapability: TransferSourceCipherCapability;
    destinationCapability: TransferDestinationCipherCapability;
    source: AsyncIterable<TransferSecurityRecord>;
    sink: TransferSecurityRecordSink;
    semanticCommitmentKey: Uint8Array;
    invalidatedAt: string;
    now?: (() => Date) | undefined;
    plaintextByteLimit?: number | undefined;
  }>,
): Promise<TransferSecurityConversionResult> {
  const currentTime = input.now ?? (() => new Date());
  const plaintextByteLimit = input.plaintextByteLimit ?? DEFAULT_TRANSFER_RECORD_PLAINTEXT_LIMIT;
  assertTransferConversionScope(
    input.scope,
    input.sourceCapability.scope,
    input.destinationCapability.scope,
    currentTime(),
  );
  if (
    input.semanticCommitmentKey.byteLength !== 32 ||
    !Number.isSafeInteger(plaintextByteLimit) ||
    plaintextByteLimit < 1 ||
    plaintextByteLimit > DEFAULT_TRANSFER_RECORD_PLAINTEXT_LIMIT
  ) {
    throw transferConversionRefused();
  }
  assertTransferTimestamp(input.invalidatedAt);

  const aggregateCommitment = createHmac("sha256", input.semanticCommitmentKey);
  let recordCount = 0;
  let encryptedRecordCount = 0;
  let preservedVerifierCount = 0;
  let invalidatedShortCodeCount = 0;
  try {
    for await (const record of input.source) {
      assertTransferConversionScope(
        input.scope,
        input.sourceCapability.scope,
        input.destinationCapability.scope,
        currentTime(),
      );
      assertTransferRecordIdentity(record, recordCount);
      let converted: TransferSecurityRecord;
      if (record.kind === "encrypted") {
        assertTransferEncryptedRecord(record, plaintextByteLimit);
        let exactPlaintext: Uint8Array | undefined;
        let plaintext: Buffer | undefined;
        try {
          exactPlaintext = await input.sourceCapability.decryptRecord({
            recordId: record.recordId,
            purpose: record.purpose,
            keyVersion: record.keyVersion,
            nonce: record.nonce,
            ciphertext: record.ciphertext,
            authenticationTag: record.authenticationTag,
            associatedData: record.associatedData,
          });
          plaintext = Buffer.from(exactPlaintext);
          if (plaintext.byteLength < 1 || plaintext.byteLength > plaintextByteLimit) {
            throw transferConversionRefused();
          }
          const destination = await input.destinationCapability.encryptRecord({
            recordId: record.recordId,
            purpose: record.purpose,
            plaintext,
            associatedData: record.associatedData,
          });
          assertDestinationCiphertext(destination, plaintext.byteLength, plaintextByteLimit);
          converted = {
            kind: "encrypted",
            ordinal: record.ordinal,
            recordId: record.recordId,
            purpose: record.purpose,
            keyVersion: destination.keyVersion,
            nonce: Buffer.from(destination.nonce),
            ciphertext: Buffer.from(destination.ciphertext),
            authenticationTag: Buffer.from(destination.authenticationTag),
            associatedData: Buffer.from(record.associatedData),
          };
          updateTransferSemanticCommitment(
            aggregateCommitment,
            {
              ordinal: record.ordinal,
              recordId: record.recordId,
              purpose: record.purpose,
              kind: record.kind,
            },
            plaintext,
          );
          encryptedRecordCount += 1;
        } finally {
          plaintext?.fill(0);
          exactPlaintext?.fill(0);
        }
      } else if (record.kind === "high-entropy-verifier") {
        if (record.algorithm !== "SHA-256" || record.verifier.byteLength !== 32) {
          throw transferConversionRefused();
        }
        converted = {
          ...record,
          verifier: Buffer.from(record.verifier),
        };
        updateTransferSemanticCommitment(
          aggregateCommitment,
          {
            ordinal: record.ordinal,
            recordId: record.recordId,
            kind: record.kind,
            algorithm: record.algorithm,
          },
          record.verifier,
        );
        preservedVerifierCount += 1;
      } else if (record.kind === "short-code-verifier") {
        if (
          record.algorithm !== "HMAC-SHA-256" ||
          record.verifierVersion !== 1 ||
          !Number.isSafeInteger(record.keyVersion) ||
          record.keyVersion < 1 ||
          record.verifier.byteLength !== 32
        ) {
          throw transferConversionRefused();
        }
        converted = {
          kind: "invalidated-short-code",
          ordinal: record.ordinal,
          recordId: record.recordId,
          invalidatedAt: input.invalidatedAt,
          reason: "transfer-keyring-change",
        };
        updateTransferSemanticCommitment(aggregateCommitment, converted);
        invalidatedShortCodeCount += 1;
      } else {
        assertTransferTimestamp(record.invalidatedAt);
        assertTransferText(record.reason);
        converted = { ...record };
        updateTransferSemanticCommitment(aggregateCommitment, converted);
        invalidatedShortCodeCount += 1;
      }
      await input.sink.stageConvertedRecord(converted);
      recordCount += 1;
      if (!Number.isSafeInteger(recordCount)) throw transferConversionRefused();
    }
    return {
      recordCount,
      encryptedRecordCount,
      preservedVerifierCount,
      invalidatedShortCodeCount,
      semanticCommitment: aggregateCommitment.digest("hex"),
    };
  } catch (error) {
    if (
      error instanceof CapletsError &&
      error.code === "REQUEST_INVALID" &&
      error.message === "Transfer ciphertext conversion is not permitted."
    ) {
      throw error;
    }
    throw transferConversionRefused();
  }
}

function assertTransferConversionScope(
  expected: Readonly<{ transferId: string; logicalHostId: string; storeId: string }>,
  source: TransferCipherCapabilityScope,
  destination: TransferCipherCapabilityScope,
  now: Date,
): void {
  assertTransferText(expected.transferId);
  assertTransferText(expected.logicalHostId);
  assertTransferText(expected.storeId);
  if (
    source.profile !== "transfer-source" ||
    destination.profile !== "transfer-destination" ||
    source.transferId !== expected.transferId ||
    destination.transferId !== expected.transferId ||
    source.logicalHostId !== expected.logicalHostId ||
    destination.logicalHostId !== expected.logicalHostId ||
    source.storeId !== expected.storeId ||
    destination.storeId !== expected.storeId ||
    source.keyringIdentity === destination.keyringIdentity ||
    !Number.isFinite(now.getTime())
  ) {
    throw transferConversionRefused();
  }
  for (const scope of [source, destination]) {
    assertTransferText(scope.keyringIdentity);
    assertTransferTimestamp(scope.expiresAt);
    if (Date.parse(scope.expiresAt) <= now.getTime()) throw transferConversionRefused();
  }
}

function assertTransferRecordIdentity(record: TransferSecurityRecord, ordinal: number): void {
  if (record.ordinal !== ordinal || !Number.isSafeInteger(record.ordinal)) {
    throw transferConversionRefused();
  }
  assertTransferText(record.recordId);
}

function assertTransferEncryptedRecord(
  record: TransferEncryptedRecord,
  plaintextByteLimit: number,
): void {
  if (
    (record.purpose !== "active-record" && record.purpose !== "vault-record") ||
    !Number.isSafeInteger(record.keyVersion) ||
    record.keyVersion < 1 ||
    record.nonce.byteLength !== 12 ||
    record.authenticationTag.byteLength !== 16 ||
    record.ciphertext.byteLength < 1 ||
    record.ciphertext.byteLength > plaintextByteLimit ||
    record.associatedData.byteLength < 1 ||
    record.associatedData.byteLength > DEFAULT_TRANSFER_RECORD_PLAINTEXT_LIMIT
  ) {
    throw transferConversionRefused();
  }
}

function assertDestinationCiphertext(
  ciphertext: TransferDestinationCiphertext,
  plaintextLength: number,
  plaintextByteLimit: number,
): void {
  if (
    !Number.isSafeInteger(ciphertext.keyVersion) ||
    ciphertext.keyVersion < 1 ||
    ciphertext.nonce.byteLength !== 12 ||
    ciphertext.authenticationTag.byteLength !== 16 ||
    ciphertext.ciphertext.byteLength !== plaintextLength ||
    ciphertext.ciphertext.byteLength > plaintextByteLimit
  ) {
    throw transferConversionRefused();
  }
}

function updateTransferSemanticCommitment(
  commitment: Hmac,
  metadata: unknown,
  bytes?: Uint8Array,
): void {
  const metadataBytes = canonicalRecoveryBytes(metadata);
  const lengths = Buffer.allocUnsafe(8);
  lengths.writeUInt32BE(metadataBytes.byteLength, 0);
  lengths.writeUInt32BE(bytes?.byteLength ?? 0, 4);
  commitment.update(lengths);
  commitment.update(metadataBytes);
  if (bytes !== undefined) commitment.update(bytes);
}

function assertTransferTimestamp(value: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw transferConversionRefused();
  }
}

function assertTransferText(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.includes("\0")) {
    throw transferConversionRefused();
  }
}

function transferConversionRefused(): CapletsError {
  return new CapletsError("REQUEST_INVALID", "Transfer ciphertext conversion is not permitted.");
}

function conversionRefused(): CapletsError {
  return new CapletsError("REQUEST_INVALID", "Recovery key conversion is not permitted.");
}
