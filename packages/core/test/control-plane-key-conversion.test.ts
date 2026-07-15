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
  recoveryKeyHasRetainedReferences,
  retireRecoveryKeyTransactionally,
  type RecoveryKeyRetirementPort,
  type RecoveryKeyRetirementTransaction,
  type RecoveryKeyLifecycle,
} from "../src/control-plane/migration/key-conversion";
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
  });
});
