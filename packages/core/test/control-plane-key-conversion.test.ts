import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptRecoveryEnvelope,
  writeRecoveryEnvelope,
  type BackupInventoryRecord,
  type BackupInventorySnapshot,
  type RecoveryBackupIntent,
} from "../src/control-plane/migration/backup";
import {
  assertRecoveryKeyRetirementAllowed,
  convertRecoveryWrappedDataKey,
  convertTransferSecurityRecords,
  recoveryKeyHasRetainedReferences,
  retireRecoveryKeyTransactionally,
  type RecoveryKeyRetirementPort,
  type RecoveryKeyRetirementTransaction,
  type RecoveryKeyLifecycle,
  type TransferDestinationCipherCapability,
  type TransferSecurityRecord,
  type TransferSourceCipherCapability,
} from "../src/control-plane/migration/key-conversion";
import { restoreRecoveryBundleWithRecordedAuthority } from "../src/control-plane/migration/restore";
import {
  recoveryEnvelopeBindingDigest,
  type RecoveryEnvelopeBinding,
  type RecoveryKeyReference,
  type RecoveryUnwrapAuthority,
  type RecoveryWrapAuthority,
} from "../src/control-plane/migration/manifest";

const logicalHostId = "host_01J00000000000000000000000";
const storeId = "store_01J00000000000000000000000";
const sourceReference: RecoveryKeyReference = {
  provider: "test-wrap-v1",
  providerIdentity: "test-provider-source",
  logicalHostId,
  storeId,
  profile: "offline-recovery",
  purpose: "backup-recovery",
  keyId: "key_01J00000000000000000000000",
  keyVersion: 1,
};
const destinationReference: RecoveryKeyReference = {
  ...sourceReference,
  providerIdentity: "test-provider-destination",
  keyId: "key_01J00000000000000000000001",
  keyVersion: 2,
};

class XorAuthority implements RecoveryWrapAuthority, RecoveryUnwrapAuthority {
  readonly reference: RecoveryKeyReference;
  readonly #mask: Buffer;

  constructor(reference: RecoveryKeyReference, fill: number) {
    this.reference = reference;
    this.#mask = Buffer.alloc(32, fill);
  }

  async wrapDataKey(dataKey: Uint8Array): Promise<Uint8Array> {
    return this.applyMask(dataKey);
  }

  async unwrapDataKey(wrappedDataKey: Uint8Array): Promise<Uint8Array> {
    return this.applyMask(wrappedDataKey);
  }

  private applyMask(value: Uint8Array): Buffer {
    const output = Buffer.allocUnsafe(value.byteLength);
    for (let index = 0; index < value.byteLength; index += 1) {
      output[index] = value[index]! ^ this.#mask[index % this.#mask.length]!;
    }
    return output;
  }
}

function retainedBackup(
  backupId: string,
  reference = sourceReference,
  state: BackupInventoryRecord["state"] = "finalized",
): BackupInventoryRecord {
  return {
    backupId,
    bindingDigest: "a".repeat(64),
    headerDigest: "b".repeat(64),
    terminalManifestDigest: "c".repeat(64),
    wrappedKeyDigest: createHash("sha256").update(Buffer.alloc(32, 0x6d)).digest("hex"),
    providerIdentity: "test-backup-provider",
    envelopeBytesReference: `bytes:${backupId}`,
    wrappedKeyReference: `key:${backupId}`,
    recoveryKeyReference: reference,
    createdAt: "2026-07-14T00:00:00.000Z",
    retentionUntil: "2027-07-14T00:00:00.000Z",
    state,
    ...(state === "finalized" ? { finalizedAt: "2026-07-14T00:01:00.000Z" } : {}),
    ...(state === "destroyed" ? { destroyedAt: "2026-07-14T00:02:00.000Z" } : {}),
  };
}

const retainedInventory: BackupInventorySnapshot = {
  version: 2,
  purgeWatermark: 0,
  records: [retainedBackup("backup-b0"), retainedBackup("backup-b1")],
};

const decryptOnlySource: RecoveryKeyLifecycle = {
  reference: sourceReference,
  state: "decrypt-only",
};

describe("protected recovery key conversion", () => {
  it("rewraps only the data key and preserves decryptability through the last retained bundle", async () => {
    const source = new XorAuthority(sourceReference, 0x11);
    const destination = new XorAuthority(destinationReference, 0x22);
    const dataKey = Buffer.alloc(32, 0x7c);
    const sourceWrapped = await source.wrapDataKey(dataKey);

    for (const bundle of retainedInventory.records) {
      const converted = await convertRecoveryWrappedDataKey({
        bundle,
        inventory: retainedInventory,
        wrappedDataKey: sourceWrapped,
        sourceAuthority: source,
        sourceKey: decryptOnlySource,
        destinationAuthority: destination,
        destinationKey: { reference: destinationReference, state: "active" },
      });
      expect(converted.recoveryKeyReference).toEqual(destinationReference);
      expect(await destination.unwrapDataKey(converted.wrappedDataKey)).toEqual(dataKey);
    }

    expect(recoveryKeyHasRetainedReferences(retainedInventory, sourceReference)).toBe(true);
    expect(() => assertRecoveryKeyRetirementAllowed(retainedInventory, sourceReference)).toThrow(
      /retained recovery bundles/u,
    );
    const afterB0 = {
      ...retainedInventory,
      version: 3,
      records: [
        retainedBackup("backup-b0", sourceReference, "destroyed"),
        retainedBackup("backup-b1"),
      ],
    } satisfies BackupInventorySnapshot;
    expect(() => assertRecoveryKeyRetirementAllowed(afterB0, sourceReference)).toThrow(
      /retained recovery bundles/u,
    );
    const afterLastRetention = {
      ...afterB0,
      version: 4,
      records: afterB0.records.map((bundle) => ({
        ...bundle,
        state: "destroyed" as const,
        destroyedAt: "2026-07-14T00:02:00.000Z",
      })),
    } satisfies BackupInventorySnapshot;
    expect(recoveryKeyHasRetainedReferences(afterLastRetention, sourceReference)).toBe(false);
    expect(() =>
      assertRecoveryKeyRetirementAllowed(afterLastRetention, sourceReference),
    ).not.toThrow();
  });

  it.each(["retired", "destroyed"] as const)(
    "rejects conversion through a %s recovery key",
    async (state) => {
      const source = new XorAuthority(sourceReference, 0x11);
      await expect(
        convertRecoveryWrappedDataKey({
          bundle: retainedInventory.records[0]!,
          inventory: retainedInventory,
          wrappedDataKey: await source.wrapDataKey(Buffer.alloc(32, 0x7c)),
          sourceAuthority: source,
          sourceKey: { reference: sourceReference, state },
          destinationAuthority: new XorAuthority(destinationReference, 0x22),
          destinationKey: { reference: destinationReference, state: "active" },
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    },
  );

  it("rejects a destroyed wrapped key and a bundle absent from retained inventory", async () => {
    const source = new XorAuthority(sourceReference, 0x11);
    const bundle = retainedInventory.records[0]!;
    await expect(
      convertRecoveryWrappedDataKey({
        bundle: { ...bundle, state: "destroyed", destroyedAt: "2026-07-14T00:02:00.000Z" },
        inventory: {
          ...retainedInventory,
          records: [
            { ...bundle, state: "destroyed", destroyedAt: "2026-07-14T00:02:00.000Z" },
            retainedInventory.records[1]!,
          ],
        },
        wrappedDataKey: await source.wrapDataKey(Buffer.alloc(32, 0x7c)),
        sourceAuthority: source,
        sourceKey: decryptOnlySource,
        destinationAuthority: new XorAuthority(destinationReference, 0x22),
        destinationKey: { reference: destinationReference, state: "active" },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

    await expect(
      convertRecoveryWrappedDataKey({
        bundle: retainedBackup("backup-unknown"),
        inventory: retainedInventory,
        wrappedDataKey: await source.wrapDataKey(Buffer.alloc(32, 0x7c)),
        sourceAuthority: source,
        sourceKey: decryptOnlySource,
        destinationAuthority: new XorAuthority(destinationReference, 0x22),
        destinationKey: { reference: destinationReference, state: "active" },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("rejects mismatched authorities without attempting unwrap or wrap", async () => {
    const source = new XorAuthority({ ...sourceReference, keyVersion: 9 }, 0x11);
    const destination = new XorAuthority(destinationReference, 0x22);
    await expect(
      convertRecoveryWrappedDataKey({
        bundle: retainedInventory.records[0]!,
        inventory: retainedInventory,
        wrappedDataKey: Buffer.alloc(32),
        sourceAuthority: source,
        sourceKey: decryptOnlySource,
        destinationAuthority: destination,
        destinationKey: { reference: destinationReference, state: "active" },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });
  it("zeroes the exact unwrapped key when destination wrapping fails", async () => {
    let unwrapped: Uint8Array = new Uint8Array();
    const sourceAuthority: RecoveryUnwrapAuthority = {
      reference: sourceReference,
      unwrapDataKey: async () => {
        unwrapped = Buffer.alloc(32, 0x7c);
        return unwrapped;
      },
    };
    const destinationAuthority: RecoveryWrapAuthority = {
      reference: destinationReference,
      wrapDataKey: async () => {
        throw new Error("injected destination sink failure");
      },
    };
    await expect(
      convertRecoveryWrappedDataKey({
        bundle: retainedInventory.records[0]!,
        inventory: retainedInventory,
        wrappedDataKey: Buffer.alloc(32, 0x6d),
        sourceAuthority,
        sourceKey: decryptOnlySource,
        destinationAuthority,
        destinationKey: { reference: destinationReference, state: "active" },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    expect([...unwrapped].every((value) => value === 0)).toBe(true);
  });

  it("rejects a selected bundle whose wrapped-key digest belongs to another bundle", async () => {
    const source = new XorAuthority(sourceReference, 0x11);
    const wrappedDataKey = await source.wrapDataKey(Buffer.alloc(32, 0x7c));
    const wrongBundle = {
      ...retainedInventory.records[0]!,
      wrappedKeyDigest: createHash("sha256").update("another bundle").digest("hex"),
    };
    await expect(
      convertRecoveryWrappedDataKey({
        bundle: wrongBundle,
        inventory: { ...retainedInventory, records: [wrongBundle, retainedInventory.records[1]!] },
        wrappedDataKey,
        sourceAuthority: source,
        sourceKey: decryptOnlySource,
        destinationAuthority: new XorAuthority(destinationReference, 0x22),
        destinationKey: { reference: destinationReference, state: "active" },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("records retirement atomically against the live inventory", async () => {
    let inventory = retainedInventory;
    let lifecycle = decryptOnlySource;
    const port: RecoveryKeyRetirementPort = {
      transaction: async (work) => {
        const transaction: RecoveryKeyRetirementTransaction = {
          readInventory: async () => inventory,
          readKeyLifecycle: async () => lifecycle,
          writeKeyLifecycle: async (next) => {
            lifecycle = next;
          },
        };
        return work(transaction);
      },
    };
    await expect(retireRecoveryKeyTransactionally(port, sourceReference)).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
    expect(lifecycle.state).toBe("decrypt-only");
    inventory = {
      ...inventory,
      version: inventory.version + 1,
      records: inventory.records.map((record) => ({
        ...record,
        state: "destroyed" as const,
        finalizedAt: record.finalizedAt ?? "2026-07-14T00:01:00.000Z",
        destructionId: "destruction-complete",
        destroyedAt: "2026-07-14T00:02:00.000Z",
      })),
    };
    await expect(retireRecoveryKeyTransactionally(port, sourceReference)).resolves.toMatchObject({
      state: "retired",
    });
    expect(lifecycle.state).toBe("retired");
  });
  it("decrypts the authenticated envelope through the converted destination key slot", async () => {
    const source = new XorAuthority(sourceReference, 0x11);
    const destination = new XorAuthority(destinationReference, 0x22);
    const binding: RecoveryEnvelopeBinding = {
      logicalHostId,
      storeId,
      sourceBackend: "sqlite",
      requiredSchemaNames: ["sqlite"],
      schemaChecksums: [{ name: "sqlite", sha256: "a".repeat(64) }],
      authorityToken: "authority:7",
      effectiveToken: "effective:11",
      securityToken: "security:5",
      requiredEntityNames: ["clients", "empty-entity"],
      entityManifest: [
        { entity: "clients", count: 1, sha256: "b".repeat(64) },
        { entity: "empty-entity", count: 0, sha256: "c".repeat(64) },
      ],
      recoveryKeyReference: sourceReference,
    };
    const frames: Buffer[] = [];
    let wrappedDataKey = Buffer.alloc(0);
    let backupIntentState: RecoveryBackupIntent | undefined;
    const written = await writeRecoveryEnvelope({
      backupLifecycle: {
        transaction: async (work) => {
          return work({
            readBackupIntent: async () => backupIntentState,
            writeBackupIntent: async (intent) => {
              backupIntentState = intent;
            },
          });
        },
      },
      backupIntent: {
        version: 1,
        backupId: "backup-converted",
        bindingDigest: recoveryEnvelopeBindingDigest(binding),
        providerIdentity: "test-backup-provider",
        envelopeBytesReference: "bytes:backup-converted",
        wrappedKeyReference: "key:backup-converted",
        recoveryKeyReference: sourceReference,
        createdAt: "2026-07-14T00:00:00.000Z",
        phase: "staged",
      },
      finalizedAt: "2026-07-14T00:01:00.000Z",
      binding,
      source: (async function* () {
        yield Buffer.from("post-conversion plaintext");
      })(),
      wrapAuthority: source,
      envelopeSink: {
        providerIdentity: "test-backup-provider",
        envelopeBytesReference: "bytes:backup-converted",
        writeEnvelopeBytes: async (bytes) => {
          frames.push(Buffer.from(bytes));
        },
      },
      wrappedKeySink: {
        providerIdentity: "test-backup-provider",
        wrappedKeyReference: "key:backup-converted",
        writeWrappedKey: async (_reference, bytes) => {
          wrappedDataKey = Buffer.from(bytes);
        },
      },
    });
    const bundle: BackupInventoryRecord = {
      backupId: "backup-converted",
      bindingDigest: written.bindingDigest,
      headerDigest: written.headerDigest,
      terminalManifestDigest: written.terminalManifestDigest,
      wrappedKeyDigest: written.wrappedKeyDigest,
      providerIdentity: "test-backup-provider",
      envelopeBytesReference: "bytes:backup-converted",
      wrappedKeyReference: "key:backup-converted",
      recoveryKeyReference: sourceReference,
      createdAt: "2026-07-14T00:00:00.000Z",
      retentionUntil: "2027-07-14T00:00:00.000Z",
      state: "finalized",
      finalizedAt: "2026-07-14T00:01:00.000Z",
    };
    const convertedKeySlot = await convertRecoveryWrappedDataKey({
      bundle,
      inventory: { version: 1, purgeWatermark: 0, records: [bundle] },
      wrappedDataKey,
      sourceAuthority: source,
      sourceKey: decryptOnlySource,
      destinationAuthority: destination,
      destinationKey: { reference: destinationReference, state: "active" },
    });
    const staged: Buffer[] = [];
    let restored = "";
    await decryptRecoveryEnvelope({
      source: (async function* () {
        yield* frames;
      })(),
      expectedBinding: binding,
      unwrapAuthority: destination,
      convertedKeySlot,
      plaintextSink: {
        begin: async () => ({
          stageChunk: async (chunk) => {
            staged.push(Buffer.from(chunk));
          },
          commit: async () => {
            restored = Buffer.concat(staged).toString("utf8");
          },
          abort: async () => {
            staged.length = 0;
          },
        }),
      },
    });
    expect(restored).toBe("post-conversion plaintext");

    const recordedRestoredChunks: Buffer[] = [];
    let recordedRestored = "";
    const currentStaticAuthority = destination;
    await restoreRecoveryBundleWithRecordedAuthority({
      recorded: {
        transferId: "transfer_01J00000000000000000000000",
        sourceDescriptorDigest: "d".repeat(64),
        backupId: bundle.backupId,
        bindingDigest: bundle.bindingDigest,
        recoveryKeyReference: sourceReference,
      },
      bundle,
      expectedBinding: binding,
      source: (async function* () {
        yield* frames;
      })(),
      wrappedKeySource: {
        readWrappedKey: async () => wrappedDataKey,
      },
      plaintextSink: {
        begin: async () => ({
          stageChunk: async (chunk) => {
            recordedRestoredChunks.push(Buffer.from(chunk));
          },
          commit: async () => {
            recordedRestored = Buffer.concat(recordedRestoredChunks).toString("utf8");
          },
          abort: async () => {
            recordedRestoredChunks.length = 0;
          },
        }),
      },
      authorityResolver: {
        resolveRecordedSourceAuthority: async (recorded) => {
          expect(currentStaticAuthority.reference).toEqual(destinationReference);
          expect(recorded.recoveryKeyReference).toEqual(sourceReference);
          return source;
        },
      },
    });
    expect(recordedRestored).toBe("post-conversion plaintext");

    let forbiddenResolverCalls = 0;
    await expect(
      restoreRecoveryBundleWithRecordedAuthority({
        recorded: {
          transferId: "transfer_01J00000000000000000000000",
          sourceDescriptorDigest: "d".repeat(64),
          backupId: bundle.backupId,
          bindingDigest: bundle.bindingDigest,
          recoveryKeyReference: { ...sourceReference, profile: "transfer-source" },
        },
        bundle,
        expectedBinding: binding,
        source: (async function* () {
          yield* frames;
        })(),
        wrappedKeySource: {
          readWrappedKey: async () => wrappedDataKey,
        },
        plaintextSink: {
          begin: async () => {
            throw new Error("must not stage");
          },
        },
        authorityResolver: {
          resolveRecordedSourceAuthority: async () => {
            forbiddenResolverCalls += 1;
            return source;
          },
        },
      }),
    ).rejects.toMatchObject({ code: "restore_auth_fence_failed" });
    expect(forbiddenResolverCalls).toBe(0);
  });
});

describe("offline transfer ciphertext conversion", () => {
  const transferId = "transfer_01J00000000000000000000000";
  const expiresAt = "2026-07-18T00:00:00.000Z";
  const sourceScope = {
    profile: "transfer-source",
    transferId,
    logicalHostId,
    storeId,
    keyringIdentity: "source-keyring",
    expiresAt,
  } as const;
  const destinationScope = {
    profile: "transfer-destination",
    transferId,
    logicalHostId,
    storeId,
    keyringIdentity: "destination-keyring",
    expiresAt,
  } as const;

  function capabilities() {
    const returnedPlaintexts: Uint8Array[] = [];
    let decryptCalls = 0;
    let encryptCalls = 0;
    let concurrentPlaintexts = 0;
    let maximumConcurrentPlaintexts = 0;
    const source: TransferSourceCipherCapability = {
      scope: sourceScope,
      decryptRecord: async (record) => {
        decryptCalls += 1;
        const plaintext = Buffer.from(record.ciphertext);
        returnedPlaintexts.push(plaintext);
        return plaintext;
      },
    };
    const destination: TransferDestinationCipherCapability = {
      scope: destinationScope,
      encryptRecord: async (record) => {
        encryptCalls += 1;
        concurrentPlaintexts += 1;
        maximumConcurrentPlaintexts = Math.max(maximumConcurrentPlaintexts, concurrentPlaintexts);
        try {
          return {
            keyVersion: record.purpose === "active-record" ? 17 : 23,
            nonce: Buffer.alloc(12, record.purpose === "active-record" ? 0x17 : 0x23),
            ciphertext: Buffer.from(record.plaintext),
            authenticationTag: Buffer.alloc(16, 0x5a),
          };
        } finally {
          concurrentPlaintexts -= 1;
        }
      },
    };
    return {
      source,
      destination,
      returnedPlaintexts,
      stats: () => ({
        decryptCalls,
        encryptCalls,
        maximumConcurrentPlaintexts,
      }),
    };
  }

  function records(): TransferSecurityRecord[] {
    return [
      {
        kind: "encrypted",
        ordinal: 0,
        recordId: "oauth-token:primary",
        purpose: "active-record",
        keyVersion: 1,
        nonce: Buffer.alloc(12, 1),
        ciphertext: Buffer.from("source access secret"),
        authenticationTag: Buffer.alloc(16, 2),
        associatedData: Buffer.from("active-aad"),
      },
      {
        kind: "encrypted",
        ordinal: 1,
        recordId: "vault-value:API_TOKEN",
        purpose: "vault-record",
        keyVersion: 4,
        nonce: Buffer.alloc(12, 3),
        ciphertext: Buffer.from("source vault secret"),
        authenticationTag: Buffer.alloc(16, 4),
        associatedData: Buffer.from("vault-aad"),
      },
      {
        kind: "high-entropy-verifier",
        ordinal: 2,
        recordId: "remote-client:bearer",
        algorithm: "SHA-256",
        verifier: Buffer.alloc(32, 0x31),
      },
      {
        kind: "short-code-verifier",
        ordinal: 3,
        recordId: "pending-approval:code",
        algorithm: "HMAC-SHA-256",
        verifierVersion: 1,
        keyVersion: 7,
        verifier: Buffer.alloc(32, 0x41),
      },
      {
        kind: "invalidated-short-code",
        ordinal: 4,
        recordId: "pending-approval:already-invalid",
        invalidatedAt: "2026-07-16T20:00:00.000Z",
        reason: "consumed",
      },
    ];
  }

  async function* stream(values = records()): AsyncGenerator<TransferSecurityRecord> {
    yield* values;
  }

  it("re-encrypts active and Vault ciphertext under unrelated keyrings while preserving safe verifier behavior", async () => {
    const { source, destination, returnedPlaintexts, stats } = capabilities();
    const staged: TransferSecurityRecord[] = [];
    const result = await convertTransferSecurityRecords({
      scope: { transferId, logicalHostId, storeId },
      sourceCapability: source,
      destinationCapability: destination,
      source: stream(),
      sink: {
        stageConvertedRecord: async (record) => {
          staged.push(record);
        },
      },
      semanticCommitmentKey: Buffer.alloc(32, 0x6b),
      invalidatedAt: "2026-07-17T00:00:00.000Z",
      now: () => new Date("2026-07-17T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      recordCount: 5,
      encryptedRecordCount: 2,
      preservedVerifierCount: 1,
      invalidatedShortCodeCount: 2,
    });
    expect(result.semanticCommitment).toMatch(/^[a-f0-9]{64}$/u);
    expect(staged[0]).toMatchObject({
      kind: "encrypted",
      keyVersion: 17,
      purpose: "active-record",
    });
    expect(staged[1]).toMatchObject({
      kind: "encrypted",
      keyVersion: 23,
      purpose: "vault-record",
    });
    expect(staged[2]).toEqual(records()[2]);
    expect(staged[3]).toEqual({
      kind: "invalidated-short-code",
      ordinal: 3,
      recordId: "pending-approval:code",
      invalidatedAt: "2026-07-17T00:00:00.000Z",
      reason: "transfer-keyring-change",
    });
    expect(staged[4]).toEqual(records()[4]);
    expect(stats()).toEqual({
      decryptCalls: 2,
      encryptCalls: 2,
      maximumConcurrentPlaintexts: 1,
    });
    expect(returnedPlaintexts.every((value) => value.every((byte) => byte === 0))).toBe(true);
  });

  it("denies expired, cross-transfer, same-keyring, and non-transfer capabilities before record access", async () => {
    const cases = [
      {
        sourcePatch: { scope: { ...sourceScope, transferId: `${transferId}-other` } },
      },
      {
        destinationPatch: {
          scope: { ...destinationScope, expiresAt: "2026-07-16T00:00:00.000Z" },
        },
      },
      {
        sourcePatch: {
          scope: { ...sourceScope, profile: "migrator" as "transfer-source" },
        },
      },
      {
        destinationPatch: {
          scope: { ...destinationScope, keyringIdentity: sourceScope.keyringIdentity },
        },
      },
    ];
    for (const testCase of cases) {
      const { source, destination, stats } = capabilities();
      let sourceRead = false;
      await expect(
        convertTransferSecurityRecords({
          scope: { transferId, logicalHostId, storeId },
          sourceCapability: Object.assign(source, testCase.sourcePatch),
          destinationCapability: Object.assign(destination, testCase.destinationPatch),
          source: (async function* () {
            sourceRead = true;
            yield* records();
          })(),
          sink: { stageConvertedRecord: async () => undefined },
          semanticCommitmentKey: Buffer.alloc(32, 0x6b),
          invalidatedAt: "2026-07-17T00:00:00.000Z",
          now: () => new Date("2026-07-17T00:00:00.000Z"),
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
      expect(sourceRead).toBe(false);
      expect(stats()).toMatchObject({ decryptCalls: 0, encryptCalls: 0 });
    }
    const { source, destination, stats } = capabilities();
    let clockReads = 0;
    let stagedBeforeExpiry = 0;
    await expect(
      convertTransferSecurityRecords({
        scope: { transferId, logicalHostId, storeId },
        sourceCapability: source,
        destinationCapability: destination,
        source: stream(records().slice(0, 2)),
        sink: {
          stageConvertedRecord: async () => {
            stagedBeforeExpiry += 1;
          },
        },
        semanticCommitmentKey: Buffer.alloc(32, 0x6b),
        invalidatedAt: "2026-07-17T00:00:00.000Z",
        now: () =>
          new Date(++clockReads < 3 ? "2026-07-17T00:00:00.000Z" : "2026-07-19T00:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    expect(stagedBeforeExpiry).toBe(1);
    expect(stats()).toMatchObject({ decryptCalls: 1, encryptCalls: 1 });
  });

  it("is bounded, retry-safe for an idempotent staging sink, and never emits plaintext", async () => {
    const staged = new Map<number, TransferSecurityRecord>();
    let injected = true;
    const run = async () => {
      const { source, destination } = capabilities();
      return convertTransferSecurityRecords({
        scope: { transferId, logicalHostId, storeId },
        sourceCapability: source,
        destinationCapability: destination,
        source: stream(),
        sink: {
          stageConvertedRecord: async (record) => {
            if (injected && record.ordinal === 1) {
              injected = false;
              throw new Error("sink failed with source vault secret");
            }
            staged.set(record.ordinal, record);
          },
        },
        semanticCommitmentKey: Buffer.alloc(32, 0x6b),
        invalidatedAt: "2026-07-17T00:00:00.000Z",
        now: () => new Date("2026-07-17T00:00:00.000Z"),
        plaintextByteLimit: 64,
      });
    };

    await expect(run()).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: "Transfer ciphertext conversion is not permitted.",
    });
    const result = await run();
    expect(staged).toHaveLength(5);
    expect(
      JSON.stringify({
        staged: [...staged.values()],
        result,
      }),
    ).not.toContain("source access secret");
    expect(
      JSON.stringify({
        staged: [...staged.values()],
        result,
      }),
    ).not.toContain("source vault secret");

    const oversized = records()[0]!;
    if (oversized.kind !== "encrypted") throw new Error("invalid test fixture");
    const { source, destination } = capabilities();
    await expect(
      convertTransferSecurityRecords({
        scope: { transferId, logicalHostId, storeId },
        sourceCapability: source,
        destinationCapability: destination,
        source: stream([
          {
            ...oversized,
            ciphertext: Buffer.alloc(65),
          },
        ]),
        sink: { stageConvertedRecord: async () => undefined },
        semanticCommitmentKey: Buffer.alloc(32, 0x6b),
        invalidatedAt: "2026-07-17T00:00:00.000Z",
        now: () => new Date("2026-07-17T00:00:00.000Z"),
        plaintextByteLimit: 64,
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });
});
