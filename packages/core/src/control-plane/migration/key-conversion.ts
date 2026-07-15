import { createHmac, timingSafeEqual } from "node:crypto";
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

function conversionRefused(): CapletsError {
  return new CapletsError("REQUEST_INVALID", "Recovery key conversion is not permitted.");
}
