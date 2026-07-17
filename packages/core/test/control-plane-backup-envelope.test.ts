import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  confirmBackupDestruction,
  decryptRecoveryEnvelope,
  finalizeBackupInventory,
  mergeBackupInventory,
  previewBackupDestruction,
  reconcileBackupDestruction,
  recordBackupInventory,
  writeDriverConsistentRecoveryEnvelope,
  writeRecoveryEnvelope,
  type BackupDestructionIntent,
  type BackupDestructionPreviewRecord,
  type BackupInventoryRecord,
  type BackupInventorySnapshot,
  type RecoveryBackupIntent,
  type RecoveryBackupLifecyclePort,
  type RecoveryBackupLifecycleTransaction,
  type DriverConsistentRecoverySnapshotIntent,
  type DriverConsistentRecoverySnapshotLifecyclePort,
  type DriverConsistentRecoverySnapshotLifecycleTransaction,
  type DriverConsistentRecoverySnapshotPort,
  type RecoveryStagedMaterialReconciliationPort,
  type BackupLifecycleLedgerPort,
  type BackupLifecycleTransaction,
  type RecoveryEnvelopeSink,
  type RecoveryMaterialDestructionPort,
  type RecoveryPlaintextStagingPort,
  type RecoveryPlaintextStagingTransaction,
  type RecoveryUnwrapAuthority,
  type RecoveryEnvelopeWriteResult,
  type RecoveryWrapAuthority,
  type RecoveryWrappedKeySink,
  type RecoveryWrappedKeySource,
} from "../src/control-plane/migration/backup";
import type {
  RecoveryEnvelopeBinding,
  RecoveryKeyReference,
} from "../src/control-plane/migration/manifest";
import type { CurrentHostAuthorityToken } from "../src/current-host/operations";
import { stableJsonStringify } from "../src/stable-json";

const logicalHostId = "host_01J00000000000000000000000";
const storeId = "store_01J00000000000000000000000";
const authorityToken: CurrentHostAuthorityToken = {
  authorityGeneration: 7,
  effectiveGeneration: 11,
};

const recoveryKeyReference: RecoveryKeyReference = {
  provider: "test-wrap-v1",
  providerIdentity: "test-provider-primary",
  logicalHostId,
  storeId,
  profile: "offline-recovery",
  purpose: "backup-recovery",
  keyId: "key_01J00000000000000000000000",
  keyVersion: 1,
};

const binding: RecoveryEnvelopeBinding = {
  logicalHostId,
  storeId,
  sourceBackend: "sqlite",
  requiredSchemaNames: ["postgres", "sqlite"],
  schemaChecksums: [
    { name: "postgres", sha256: "b".repeat(64) },
    { name: "sqlite", sha256: "a".repeat(64) },
  ],
  authorityToken: "authority:7",
  effectiveToken: "effective:11",
  securityToken: "security:5",
  requiredEntityNames: ["clients", "vault-values"],
  entityManifest: [
    { entity: "clients", count: 2, sha256: "c".repeat(64) },
    { entity: "vault-values", count: 1, sha256: "d".repeat(64) },
  ],
  recoveryKeyReference,
};

class TestWrapAuthority implements RecoveryWrapAuthority, RecoveryUnwrapAuthority {
  readonly reference: RecoveryKeyReference;
  readonly #mask: Buffer;

  constructor(reference = recoveryKeyReference, fill = 0x5a) {
    this.reference = reference;
    this.#mask = Buffer.alloc(32, fill);
  }

  async wrapDataKey(dataKey: Uint8Array): Promise<Uint8Array> {
    return xor(dataKey, this.#mask);
  }

  async unwrapDataKey(wrappedDataKey: Uint8Array): Promise<Uint8Array> {
    return xor(wrappedDataKey, this.#mask);
  }
}

class EnvelopeMemory
  implements RecoveryEnvelopeSink, RecoveryWrappedKeySink, RecoveryWrappedKeySource
{
  readonly providerIdentity = "test-provider-primary";
  readonly envelopeBytesReference = "envelope:memory";
  readonly wrappedKeyReference = "wrapped:memory";
  frames: Buffer[] = [];
  wrappedKey?: Buffer;

  async writeEnvelopeBytes(bytes: Uint8Array): Promise<void> {
    this.frames.push(Buffer.from(bytes));
  }

  async writeWrappedKey(_reference: RecoveryKeyReference, bytes: Uint8Array): Promise<void> {
    this.wrappedKey = Buffer.from(bytes);
  }

  async readWrappedKey(): Promise<Uint8Array | undefined> {
    return this.wrappedKey;
  }
}
class PlaintextMemory implements RecoveryPlaintextStagingPort {
  staged: Buffer[] = [];
  committed: Buffer[] = [];
  abortCount = 0;
  failStage = false;

  async begin(): Promise<RecoveryPlaintextStagingTransaction> {
    return {
      stageChunk: async (chunk) => {
        this.staged.push(Buffer.from(chunk));
        if (this.failStage) throw new Error("injected staging failure");
      },
      commit: async () => {
        this.committed = this.staged;
        this.staged = [];
      },
      abort: async () => {
        this.abortCount += 1;
        for (const chunk of this.staged) chunk.fill(0);
        this.staged = [];
      },
    };
  }
}
class MemoryBackupLifecycle implements RecoveryBackupLifecyclePort {
  intent: RecoveryBackupIntent | undefined;
  events: string[] = [];

  async transaction<T>(
    work: (transaction: RecoveryBackupLifecycleTransaction) => Promise<T>,
  ): Promise<T> {
    const transaction: RecoveryBackupLifecycleTransaction = {
      readBackupIntent: async () => this.intent,
      writeBackupIntent: async (intent) => {
        this.intent = structuredClone(intent);
        this.events.push(`intent:${intent.phase}`);
      },
      deleteBackupIntent: async () => {
        this.intent = undefined;
        this.events.push("intent:discarded");
      },
    };
    return work(transaction);
  }
}

function backupLifecycleInput(
  memory: EnvelopeMemory,
  backupId: string,
  envelopeBinding: RecoveryEnvelopeBinding = binding,
): {
  backupLifecycle: MemoryBackupLifecycle;
  backupIntent: RecoveryBackupIntent;
  finalizedAt: string;
} {
  const backupLifecycle = new MemoryBackupLifecycle();
  return {
    backupLifecycle,
    backupIntent: {
      version: 1,
      backupId,
      bindingDigest: createHash("sha256")
        .update(stableJsonStringify(envelopeBinding))
        .digest("hex"),
      providerIdentity: memory.providerIdentity,
      envelopeBytesReference: memory.envelopeBytesReference,
      wrappedKeyReference: memory.wrappedKeyReference,
      recoveryKeyReference: envelopeBinding.recoveryKeyReference,
      createdAt: "2026-07-14T00:00:00.000Z",
      phase: "staged",
    },
    finalizedAt: "2026-07-14T00:01:00.000Z",
  };
}

async function envelopeFixture() {
  const memory = new EnvelopeMemory();
  const write = await writeRecoveryEnvelope({
    ...backupLifecycleInput(memory, "backup-fixture"),
    binding,
    source: chunks("alpha", "beta", "gamma"),
    wrapAuthority: new TestWrapAuthority(),
    envelopeSink: memory,
    wrappedKeySink: memory,
  });
  return { memory, write };
}

async function decrypt(
  memory: EnvelopeMemory,
  options: Partial<{
    expectedBinding: RecoveryEnvelopeBinding;
    unwrapAuthority: RecoveryUnwrapAuthority;
    frames: readonly Uint8Array[];
  }> = {},
): Promise<string> {
  const plaintext = new PlaintextMemory();
  await decryptRecoveryEnvelope({
    source: chunks(...(options.frames ?? memory.frames)),
    expectedBinding: options.expectedBinding ?? binding,
    unwrapAuthority: options.unwrapAuthority ?? new TestWrapAuthority(),
    wrappedKeySource: memory,
    plaintextSink: plaintext,
  });
  return Buffer.concat(plaintext.committed).toString("utf8");
}

describe("protected recovery envelope", () => {
  it("persists staged intent before external I/O and durably finalizes the envelope", async () => {
    const memory = new EnvelopeMemory();
    const lifecycle = backupLifecycleInput(memory, "backup-ordering");
    const result = await writeRecoveryEnvelope({
      ...lifecycle,
      binding,
      source: chunks("ordered"),
      wrapAuthority: new TestWrapAuthority(),
      envelopeSink: {
        providerIdentity: memory.providerIdentity,
        envelopeBytesReference: memory.envelopeBytesReference,
        writeEnvelopeBytes: async (bytes) => {
          expect(lifecycle.backupLifecycle.intent?.phase).toBe("wrapped-key-written");
          await memory.writeEnvelopeBytes(bytes);
        },
      },
      wrappedKeySink: {
        providerIdentity: memory.providerIdentity,
        wrappedKeyReference: memory.wrappedKeyReference,
        writeWrappedKey: async (reference, bytes) => {
          expect(lifecycle.backupLifecycle.intent?.phase).toBe("staged");
          await memory.writeWrappedKey(reference, bytes);
        },
      },
    });
    expect(lifecycle.backupLifecycle.events).toEqual([
      "intent:staged",
      "intent:wrapped-key-written",
      "intent:envelope-written",
      "intent:finalized",
    ]);
    expect(lifecycle.backupLifecycle.intent).toMatchObject({
      phase: "finalized",
      wrappedKeyDigest: result.wrappedKeyDigest,
      headerDigest: result.headerDigest,
      terminalManifestDigest: result.terminalManifestDigest,
    } satisfies Partial<RecoveryBackupIntent & RecoveryEnvelopeWriteResult>);
  });

  it("streams a canonically bound envelope and authenticates its terminal manifest", async () => {
    const { memory, write } = await envelopeFixture();
    expect(await decrypt(memory)).toBe("alphabetagamma");
    expect(write).toMatchObject({ chunkCount: 3, plaintextLength: 14 });
    expect(write.headerDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(write.terminalManifestDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("generates and wraps a distinct 256-bit data key for every bundle", async () => {
    const first = await envelopeFixture();
    const second = await envelopeFixture();
    expect(first.memory.wrappedKey).toHaveLength(32);
    expect(second.memory.wrappedKey).toHaveLength(32);
    expect(first.memory.wrappedKey).not.toEqual(second.memory.wrappedKey);
    expect(first.write.wrappedKeyDigest).not.toBe(second.write.wrappedKeyDigest);
  });

  it("bounds plaintext chunks and accepts arbitrarily fragmented transport input", async () => {
    const memory = new EnvelopeMemory();
    const plaintext = Buffer.from("stream-without-bundle-buffering");
    const write = await writeRecoveryEnvelope({
      ...backupLifecycleInput(memory, "backup-fragmented"),
      binding,
      source: chunks(plaintext),
      wrapAuthority: new TestWrapAuthority(),
      envelopeSink: memory,
      wrappedKeySink: memory,
      chunkPlaintextLimit: 4,
    });
    const encoded = Buffer.concat(memory.frames);
    const fragments: Buffer[] = [];
    for (let offset = 0; offset < encoded.byteLength; offset += 3) {
      fragments.push(
        Buffer.from(encoded.subarray(offset, Math.min(offset + 3, encoded.byteLength))),
      );
    }
    expect(await decrypt(memory, { frames: fragments })).toBe(plaintext.toString());
    expect(write.chunkCount).toBe(Math.ceil(plaintext.byteLength / 4));
  });

  it("restores every retained bundle across recovery-key rotation", async () => {
    const rotatedReference: RecoveryKeyReference = {
      ...recoveryKeyReference,
      keyId: "key_01J00000000000000000000001",
      keyVersion: 2,
    };
    const versions = [
      { binding, authority: new TestWrapAuthority(recoveryKeyReference, 0x11) },
      {
        binding: { ...binding, recoveryKeyReference: rotatedReference },
        authority: new TestWrapAuthority(rotatedReference, 0x22),
      },
    ] as const;
    for (const version of versions) {
      const memory = new EnvelopeMemory();
      await writeRecoveryEnvelope({
        ...backupLifecycleInput(
          memory,
          `backup-rotation-${version.binding.recoveryKeyReference.keyVersion}`,
          version.binding,
        ),
        binding: version.binding,
        source: chunks("retained-recovery"),
        wrapAuthority: version.authority,
        envelopeSink: memory,
        wrappedKeySink: memory,
      });
      await expect(
        decrypt(memory, {
          expectedBinding: version.binding,
          unwrapAuthority: version.authority,
        }),
      ).resolves.toBe("retained-recovery");
    }
  });

  it.each([
    ["logical host", { ...binding, logicalHostId: "host_01J00000000000000000000001" }],
    ["store", { ...binding, storeId: "store_01J00000000000000000000001" }],
    ["backend", { ...binding, sourceBackend: "postgres" as const }],
    ["authority", { ...binding, authorityToken: "authority:8" }],
    ["effective state", { ...binding, effectiveToken: "effective:12" }],
    ["security state", { ...binding, securityToken: "security:6" }],
    [
      "schema",
      {
        ...binding,
        schemaChecksums: binding.schemaChecksums.map((entry) =>
          entry.name === "sqlite" ? { ...entry, sha256: "e".repeat(64) } : entry,
        ),
      },
    ],
    [
      "entities",
      {
        ...binding,
        entityManifest: binding.entityManifest.map((entry) =>
          entry.entity === "clients" ? { ...entry, count: 3 } : entry,
        ),
      },
    ],
    [
      "recovery key reference",
      {
        ...binding,
        recoveryKeyReference: { ...recoveryKeyReference, keyVersion: 2 },
      },
    ],
  ])("rejects a wrong %s binding before plaintext is accepted", async (_name, expectedBinding) => {
    const { memory } = await envelopeFixture();
    await expect(decrypt(memory, { expectedBinding })).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });

  it.each([
    ["nested logical host", { ...recoveryKeyReference, logicalHostId: "host_other" }],
    ["nested store", { ...recoveryKeyReference, storeId: "store_other" }],
  ])("rejects a %s recovery-key binding", async (_name, nestedReference) => {
    const memory = new EnvelopeMemory();
    await expect(
      writeRecoveryEnvelope({
        ...backupLifecycleInput(memory, "backup-invalid-nested"),
        binding: { ...binding, recoveryKeyReference: nestedReference },
        source: chunks("secret"),
        wrapAuthority: new TestWrapAuthority(nestedReference),
        envelopeSink: memory,
        wrappedKeySink: memory,
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(memory.frames).toEqual([]);
  });

  it.each([
    ["missing schema", { ...binding, schemaChecksums: binding.schemaChecksums.slice(1) }],
    [
      "missing zero-count entity",
      {
        ...binding,
        requiredEntityNames: ["clients", "empty-entity", "vault-values"],
      },
    ],
    ["non-ASCII ID", { ...binding, logicalHostId: "høst" }],
  ])("rejects %s from the exact manifest contract", async (_name, invalidBinding) => {
    const memory = new EnvelopeMemory();
    await expect(
      writeRecoveryEnvelope({
        ...backupLifecycleInput(memory, "backup-invalid-manifest"),
        binding: invalidBinding,
        source: chunks("secret"),
        wrapAuthority: new TestWrapAuthority(),
        envelopeSink: memory,
        wrappedKeySink: memory,
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(memory.frames).toEqual([]);
  });

  it("rejects the wrong recovery key without disclosing protected values", async () => {
    const { memory } = await envelopeFixture();
    await expect(
      decrypt(memory, { unwrapAuthority: new TestWrapAuthority(recoveryKeyReference, 0xa5) }),
    ).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: "Recovery envelope verification failed.",
    });
  });

  it("rejects restore after the separately stored wrapped key is destroyed", async () => {
    const { memory } = await envelopeFixture();
    delete memory.wrappedKey;
    await expect(decrypt(memory)).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: "Recovery envelope verification failed.",
    });
  });

  it.each([
    [
      "tampered header",
      (frames: Buffer[]) => replaceFrame(frames, 0, { logicalHostId: "tampered" }),
    ],
    ["tampered chunk", (frames: Buffer[]) => replaceFrame(frames, 1, { ciphertext: "AAAA" })],
    ["tampered terminal", (frames: Buffer[]) => replaceFrame(frames, -1, { chunkCount: 99 })],
    ["truncation", (frames: Buffer[]) => frames.slice(0, -1)],
    ["extension", (frames: Buffer[]) => [...frames, Buffer.from(frames.at(-1) ?? [])]],
    ["duplication", (frames: Buffer[]) => [frames[0]!, frames[1]!, frames[1]!, ...frames.slice(2)]],
    ["reordering", (frames: Buffer[]) => [frames[0]!, frames[2]!, frames[1]!, ...frames.slice(3)]],
  ])("rejects %s", async (_name, mutate) => {
    const { memory } = await envelopeFixture();
    await expect(decrypt(memory, { frames: mutate(memory.frames) })).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: "Recovery envelope verification failed.",
    });
  });
  it("aborts owned plaintext staging without committing authenticated prefixes", async () => {
    const { memory } = await envelopeFixture();
    const plaintext = new PlaintextMemory();
    await expect(
      decryptRecoveryEnvelope({
        source: chunks(...memory.frames.slice(0, -1)),
        expectedBinding: binding,
        unwrapAuthority: new TestWrapAuthority(),
        wrappedKeySource: memory,
        plaintextSink: plaintext,
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect(plaintext.committed).toEqual([]);
    expect(plaintext.staged).toEqual([]);
    expect(plaintext.abortCount).toBe(1);
  });

  it("zeroes the exact unwrap return and staged plaintext when the sink rejects", async () => {
    const { memory } = await envelopeFixture();
    let unwrapped: Uint8Array = new Uint8Array();
    let stagedPlaintext: Uint8Array = new Uint8Array();
    const authority: RecoveryUnwrapAuthority = {
      reference: recoveryKeyReference,
      unwrapDataKey: async (wrappedKey) => {
        unwrapped = xor(wrappedKey, Buffer.alloc(32, 0x5a));
        return unwrapped;
      },
    };
    const plaintextSink: RecoveryPlaintextStagingPort = {
      begin: async () => ({
        stageChunk: async (chunk) => {
          stagedPlaintext = chunk;
          throw new Error("injected sink fault");
        },
        commit: async () => {
          throw new Error("must not commit");
        },
        abort: async () => undefined,
      }),
    };
    await expect(
      decryptRecoveryEnvelope({
        source: chunks(...memory.frames),
        expectedBinding: binding,
        unwrapAuthority: authority,
        wrappedKeySource: memory,
        plaintextSink,
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    expect([...unwrapped].every((value) => value === 0)).toBe(true);
    expect(stagedPlaintext.length).toBeGreaterThan(0);
    expect([...stagedPlaintext].every((value) => value === 0)).toBe(true);
  });
});

describe("driver-consistent recovery backup", () => {
  it("records destruction before snapshot I/O, retries partial encryption, and bounds plaintext", async () => {
    const memory = new EnvelopeMemory();
    const backup = backupLifecycleInput(memory, "backup-driver-consistent");
    const events: string[] = [];
    let snapshotIntent: DriverConsistentRecoverySnapshotIntent | undefined;
    const snapshotLifecycle: DriverConsistentRecoverySnapshotLifecyclePort = {
      transaction: async (work) => {
        const transaction: DriverConsistentRecoverySnapshotLifecycleTransaction = {
          readSnapshotIntent: async () => snapshotIntent,
          writeSnapshotIntent: async (intent) => {
            snapshotIntent = structuredClone(intent);
            events.push(`snapshot:${intent.phase}`);
          },
        };
        return work(transaction);
      },
    };
    const yielded: Buffer[] = [];
    const snapshot: DriverConsistentRecoverySnapshotPort = {
      checkpoint: async () => {
        events.push("checkpoint");
      },
      integrityCheck: async () => {
        events.push("integrity");
      },
      createConsistentSnapshot: async () => {
        events.push("create");
      },
      readSnapshotChunks: async function* (_reference, maxChunkBytes) {
        expect(maxChunkBytes).toBe(4);
        for (const value of ["snap", "shot", "-db"]) {
          const bytes = Buffer.from(value);
          yielded.push(bytes);
          yield bytes;
        }
      },
      destroySnapshot: async () => {
        events.push("destroy");
      },
    };
    const originalWrite = memory.writeEnvelopeBytes.bind(memory);
    let failOnce = true;
    memory.writeEnvelopeBytes = async (bytes) => {
      if (failOnce && memory.frames.length === 1) {
        failOnce = false;
        throw new Error("injected snapshot plaintext");
      }
      await originalWrite(bytes);
    };
    const reconciliation: RecoveryStagedMaterialReconciliationPort = {
      discardStagedRecoveryMaterial: async () => {
        memory.frames = [];
        delete memory.wrappedKey;
        events.push("discard");
      },
    };
    const input = {
      ...backup,
      binding,
      wrapAuthority: new TestWrapAuthority(),
      envelopeSink: memory,
      wrappedKeySink: memory,
      snapshot,
      snapshotLifecycle,
      reconciliation,
      snapshotIntent: {
        version: 1,
        backupId: backup.backupIntent.backupId,
        bindingDigest: backup.backupIntent.bindingDigest,
        snapshotReference: "sqlite-snapshot:transfer",
        createdAt: "2026-07-14T00:00:00.000Z",
        phase: "destruction-intended",
      } satisfies DriverConsistentRecoverySnapshotIntent,
      chunkPlaintextLimit: 4,
    };

    await expect(writeDriverConsistentRecoveryEnvelope(input)).rejects.toMatchObject({
      code: "AUTH_FAILED",
      message: "Recovery envelope verification failed.",
    });
    const result = await writeDriverConsistentRecoveryEnvelope(input);
    expect(await decrypt(memory)).toBe("snapshot-db");
    expect(result.plaintextLength).toBe(11);
    expect(snapshotIntent?.phase).toBe("snapshot-destroyed");
    expect(events.indexOf("snapshot:destruction-intended")).toBeLessThan(
      events.indexOf("checkpoint"),
    );
    expect(events).toContain("discard");
    expect(yielded.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
    expect(JSON.stringify({ result, snapshotIntent })).not.toContain("snapshot-db");
  });
});

class MemoryLifecycleLedger implements BackupLifecycleLedgerPort {
  state: BackupInventorySnapshot = { version: 0, purgeWatermark: 0, records: [] };
  previews = new Map<string, BackupDestructionPreviewRecord>();
  intents = new Map<string, BackupDestructionIntent>();
  currentAuthorityToken = authorityToken;
  failDatabaseOperationAt: number | undefined;
  databaseOperationCount = 0;

  async transaction<T>(work: (transaction: BackupLifecycleTransaction) => Promise<T>): Promise<T> {
    this.faultDatabase();
    const saved = structuredClone({
      state: this.state,
      previews: [...this.previews],
      intents: [...this.intents],
    });
    const transaction: BackupLifecycleTransaction = {
      readAuthorityToken: async () => {
        this.faultDatabase();
        return this.currentAuthorityToken;
      },
      readInventory: async () => {
        this.faultDatabase();
        return this.state;
      },
      writeInventory: async (state) => {
        this.faultDatabase();
        this.state = structuredClone(state);
      },
      readDestructionPreview: async (tokenId) => {
        this.faultDatabase();
        return this.previews.get(tokenId);
      },
      writeDestructionPreview: async (preview) => {
        this.faultDatabase();
        this.previews.set(preview.token.tokenId, structuredClone(preview));
      },
      readDestructionIntent: async (destructionId) => {
        this.faultDatabase();
        return this.intents.get(destructionId);
      },
      writeDestructionIntent: async (intent) => {
        this.faultDatabase();
        this.intents.set(intent.destructionId, structuredClone(intent));
      },
    };
    try {
      const result = await work(transaction);
      this.faultDatabase();
      return result;
    } catch (error) {
      this.state = saved.state;
      this.previews = new Map(saved.previews);
      this.intents = new Map(saved.intents);
      throw error;
    }
  }

  private faultDatabase(): void {
    this.databaseOperationCount += 1;
    if (this.databaseOperationCount === this.failDatabaseOperationAt) {
      throw new Error("injected ledger fault");
    }
  }
}

class MemoryMaterial implements RecoveryMaterialDestructionPort {
  constructor(readonly providerIdentity = "test-provider-primary") {}

  present = new Set(["bytes:backup-b0", "key:backup-b0", "bytes:unrelated", "key:unrelated"]);
  removed: string[] = [];
  failOperationAt: number | undefined;
  operationCount = 0;

  async envelopeBytesExist(reference: string): Promise<boolean> {
    this.fault();
    return this.present.has(`bytes:${reference}`);
  }

  async deleteEnvelopeBytes(reference: string): Promise<void> {
    this.fault();
    this.present.delete(`bytes:${reference}`);
    this.removed.push(`bytes:${reference}`);
  }

  async wrappedKeyExists(reference: string): Promise<boolean> {
    this.fault();
    return this.present.has(`key:${reference}`);
  }

  async deleteWrappedKey(reference: string): Promise<void> {
    this.fault();
    this.present.delete(`key:${reference}`);
    this.removed.push(`key:${reference}`);
  }

  private fault(): void {
    this.operationCount += 1;
    if (this.operationCount === this.failOperationAt) throw new Error("injected material fault");
  }
}

function inventoryRecord(backupId: string, keyVersion: number): BackupInventoryRecord {
  return {
    backupId,
    bindingDigest: createHash("sha256").update(`binding:${backupId}`).digest("hex"),
    headerDigest: createHash("sha256").update(`header:${backupId}`).digest("hex"),
    terminalManifestDigest: createHash("sha256").update(`terminal:${backupId}`).digest("hex"),
    wrappedKeyDigest: createHash("sha256").update(`wrapped:${backupId}`).digest("hex"),
    providerIdentity: "test-provider-primary",
    envelopeBytesReference: backupId,
    wrappedKeyReference: backupId,
    recoveryKeyReference: { ...recoveryKeyReference, keyVersion },
    createdAt: "2026-07-14T00:00:00.000Z",
    retentionUntil: "2027-07-14T00:00:00.000Z",
    state: "staged",
  };
}

async function preparedDestruction() {
  const ledger = new MemoryLifecycleLedger();
  const material = new MemoryMaterial();
  const record = inventoryRecord("backup-b0", 1);
  await recordBackupInventory(ledger, record);
  await finalizeBackupInventory(ledger, {
    backupId: record.backupId,
    headerDigest: record.headerDigest,
    terminalManifestDigest: record.terminalManifestDigest,
    retentionUntil: record.retentionUntil,
    finalizedAt: "2026-07-14T00:01:00.000Z",
  });
  const confirmation = await previewBackupDestruction(ledger, {
    backupId: record.backupId,
    authorityToken,
    tokenId: "confirmation-b0",
    expiresAt: "2026-07-14T01:00:00.000Z",
    consequences: ["Protected recovery material becomes unavailable."],
  });
  return { ledger, material, record, confirmation };
}

describe("backup inventory and destruction", () => {
  it("merges B0 after B1 without regressing inventory, finalization, or purge watermark", async () => {
    const ledger = new MemoryLifecycleLedger();
    const b0 = inventoryRecord("backup-b0", 1);
    const b1 = inventoryRecord("backup-b1", 2);
    await recordBackupInventory(ledger, b0);
    const snapshotB0 = structuredClone(ledger.state);
    await recordBackupInventory(ledger, b1);
    await finalizeBackupInventory(ledger, {
      backupId: b1.backupId,
      headerDigest: b1.headerDigest,
      terminalManifestDigest: b1.terminalManifestDigest,
      retentionUntil: b1.retentionUntil,
      finalizedAt: "2026-07-14T00:02:00.000Z",
    });
    ledger.state = { ...ledger.state, version: ledger.state.version + 1, purgeWatermark: 9 };

    const merged = await mergeBackupInventory(ledger, snapshotB0);
    expect(merged.records.map((record) => record.backupId)).toEqual(["backup-b0", "backup-b1"]);
    expect(merged.records.find((record) => record.backupId === "backup-b1")?.state).toBe(
      "finalized",
    );
    expect(merged.purgeWatermark).toBe(9);
  });

  it.each([
    [
      "staged with finalization",
      { state: "staged" as const, finalizedAt: "2026-07-14T00:01:00.000Z" },
    ],
    [
      "finalized with destruction ID",
      {
        state: "finalized" as const,
        finalizedAt: "2026-07-14T00:01:00.000Z",
        destructionId: "unexpected",
      },
    ],
    [
      "destruction intent with destroyed timestamp",
      {
        state: "destruction-intended" as const,
        finalizedAt: "2026-07-14T00:01:00.000Z",
        destructionId: "destruction-b0",
        destroyedAt: "2026-07-14T00:02:00.000Z",
      },
    ],
  ])("rejects non-exact %s inventory fields", async (_name, lifecycle) => {
    const ledger = new MemoryLifecycleLedger();
    await expect(
      recordBackupInventory(ledger, { ...inventoryRecord("backup-invalid", 1), ...lifecycle }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    expect(ledger.state.records).toEqual([]);
  });

  it.each(["missing", "expired", "mismatched", "stale-authority", "changed-inventory", "reused"])(
    "%s destruction confirmation is a no-op",
    async (kind) => {
      const { ledger, material, confirmation } = await preparedDestruction();
      if (kind === "stale-authority") {
        ledger.currentAuthorityToken = { authorityGeneration: 8, effectiveGeneration: 11 };
      }
      if (kind === "changed-inventory") {
        await recordBackupInventory(ledger, inventoryRecord("backup-b1", 2));
      }
      if (kind === "reused") {
        await confirmBackupDestruction(ledger, {
          confirmation,
          destructionId: "destruction-b0",
          now: new Date("2026-07-14T00:30:00.000Z"),
        });
      }
      const stableBefore = stableJsonStringify({
        state: ledger.state,
        previews: [...ledger.previews],
        intents: [...ledger.intents],
        present: [...material.present],
      });
      const candidate =
        kind === "missing"
          ? undefined
          : kind === "mismatched"
            ? { ...confirmation, storeId: "store_01J00000000000000000000001" }
            : confirmation;
      const result = await confirmBackupDestruction(ledger, {
        confirmation: candidate,
        destructionId: kind === "reused" ? "destruction-reuse" : "destruction-b0",
        now: new Date(kind === "expired" ? "2026-07-14T02:00:00.000Z" : "2026-07-14T00:30:00.000Z"),
      });
      expect(result.status).toBe("unchanged");
      expect(
        stableJsonStringify({
          state: ledger.state,
          previews: [...ledger.previews],
          intents: [...ledger.intents],
          present: [...material.present],
        }),
      ).toBe(stableBefore);
    },
  );

  it("refuses a material provider outside the confirmed target", async () => {
    const { ledger, confirmation } = await preparedDestruction();
    await confirmBackupDestruction(ledger, {
      confirmation,
      destructionId: "destruction-b0",
      now: new Date("2026-07-14T00:30:00.000Z"),
    });
    const wrongProvider = new MemoryMaterial("test-provider-other");
    const before = new Set(wrongProvider.present);
    await expect(
      reconcileBackupDestruction(ledger, wrongProvider, "destruction-b0"),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    expect(wrongProvider.present).toEqual(before);
    expect(ledger.intents.get("destruction-b0")?.phase).toBe("confirmed");
  });

  it("resumes every database and external I/O fault without widening the target", async () => {
    const baseline = await preparedDestruction();
    await confirmBackupDestruction(baseline.ledger, {
      confirmation: baseline.confirmation,
      destructionId: "destruction-b0",
      now: new Date("2026-07-14T00:30:00.000Z"),
    });
    baseline.ledger.databaseOperationCount = 0;
    baseline.material.operationCount = 0;
    await reconcileBackupDestruction(baseline.ledger, baseline.material, "destruction-b0");
    const boundaryCounts = {
      database: baseline.ledger.databaseOperationCount,
      material: baseline.material.operationCount,
    };

    for (const faultKind of ["database", "material"] as const) {
      for (let faultAt = 1; faultAt <= boundaryCounts[faultKind]; faultAt += 1) {
        const { ledger, material, confirmation } = await preparedDestruction();
        await confirmBackupDestruction(ledger, {
          confirmation,
          destructionId: "destruction-b0",
          now: new Date("2026-07-14T00:30:00.000Z"),
        });
        ledger.databaseOperationCount = 0;
        material.operationCount = 0;
        if (faultKind === "database") ledger.failDatabaseOperationAt = faultAt;
        else material.failOperationAt = faultAt;
        await reconcileBackupDestruction(ledger, material, "destruction-b0").catch(() => undefined);
        ledger.failDatabaseOperationAt = undefined;
        material.failOperationAt = undefined;
        const receipt = await reconcileBackupDestruction(ledger, material, "destruction-b0");
        expect(receipt).toMatchObject({
          destructionId: "destruction-b0",
          backupId: "backup-b0",
          bytesAbsent: true,
          wrappedKeyAbsent: true,
        });
        expect(material.present).toEqual(new Set(["bytes:unrelated", "key:unrelated"]));
        expect(new Set(material.removed)).toEqual(new Set(["bytes:backup-b0", "key:backup-b0"]));
        expect(ledger.intents.get("destruction-b0")?.phase).toBe("completed");
        expect(ledger.state.records[0]?.state).toBe("destroyed");
      }
    }
  });
  it("rejects a terminal destruction receipt not exactly bound to its intent", async () => {
    const { ledger, material, confirmation } = await preparedDestruction();
    await confirmBackupDestruction(ledger, {
      confirmation,
      destructionId: "destruction-b0",
      now: new Date("2026-07-14T00:30:00.000Z"),
    });
    await reconcileBackupDestruction(
      ledger,
      material,
      "destruction-b0",
      () => new Date("2026-07-14T00:31:00.000Z"),
    );
    const completed = ledger.intents.get("destruction-b0")!;
    ledger.intents.set("destruction-b0", {
      ...completed,
      receipt: { ...completed.receipt!, backupId: "backup-other" },
    });
    await expect(
      reconcileBackupDestruction(ledger, material, "destruction-b0"),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });
});

async function* chunks(...values: readonly (string | Uint8Array)[]) {
  for (const value of values) {
    yield typeof value === "string" ? Buffer.from(value) : value;
  }
}

function xor(value: Uint8Array, mask: Uint8Array): Buffer {
  const output = Buffer.allocUnsafe(value.byteLength);
  for (let index = 0; index < value.byteLength; index += 1) {
    output[index] = value[index]! ^ mask[index % mask.byteLength]!;
  }
  return output;
}

function replaceFrame(
  frames: readonly Buffer[],
  index: number,
  patch: Record<string, unknown>,
): Buffer[] {
  const normalized = index < 0 ? frames.length + index : index;
  return frames.map((frame, frameIndex) => {
    if (frameIndex !== normalized) return Buffer.from(frame);
    const length = frame.readUInt32BE(0);
    const decoded = JSON.parse(frame.subarray(4, 4 + length).toString("utf8")) as Record<
      string,
      unknown
    >;
    return encodeFrame({ ...decoded, ...patch });
  });
}

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(stableJsonStringify(value));
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(body.byteLength);
  return Buffer.concat([prefix, body]);
}
