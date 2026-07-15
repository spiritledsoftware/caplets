import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CATASTROPHIC_RECOVERY_FAILURE_POINTS,
  CHECKPOINT_ADVANCE_FAILURE_POINTS,
  advanceRecoveryCheckpoint,
  checkpointCanonicalBytes,
  createAuthenticatedRecoveryCheckpoint,
  createCatastrophicRecoveryCoordinator,
  checkpointInventoryEntryForBackupRecord,
  destructionTargetDigest,
  verifyAuthenticatedRecoveryCheckpoint,
  type AuthenticatedRecoveryCheckpoint,
  type CatastrophicRecoveryConfirmation,
  type CatastrophicRecoveryPort,
  type RecoveryBackupMaterial,
  type RecoveryCheckpointDestructionIntent,
  type RecoveryCheckpointHmacPort,
  type RecoveryCheckpointPayload,
  type RecoveryCheckpointReplicaPort,
  type RecoveryDescriptor,
  type RecoveryDescriptorPort,
  type RestoredSqlMarker,
} from "../src/control-plane/migration/catastrophic-recovery";
import type { BackupInventoryRecord } from "../src/control-plane/migration/backup";
import type {
  RestorableControlPlaneState,
  RestoreIdentity,
} from "../src/control-plane/migration/restore";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

const oldIdentity: RestoreIdentity = {
  logicalHostId: "host_01J00000000000000000000000",
  storeId: "store_old_01J0000000000000000000",
  operationNamespace: "namespace_old_01J00000000000000",
};

const hmac: RecoveryCheckpointHmacPort = {
  capability: "recovery-checkpoint",
  async authenticate(bytes) {
    return createHmac("sha256", "independent-checkpoint-key").update(bytes).digest("hex");
  },
  async verify(bytes, authentication) {
    const expected = Buffer.from(
      createHmac("sha256", "independent-checkpoint-key").update(bytes).digest("hex"),
      "hex",
    );
    const actual = Buffer.from(authentication, "hex");
    return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
  },
};

function backupRecord(
  backupId: "B0" | "B1",
  state: BackupInventoryRecord["state"] = "finalized",
): BackupInventoryRecord {
  const keyVersion = backupId === "B0" ? 1 : 2;
  const base = {
    backupId,
    bindingDigest: digest(`binding:${backupId}`),
    headerDigest: digest(`header:${backupId}`),
    terminalManifestDigest: digest(`terminal:${backupId}`),
    wrappedKeyDigest: digest(`wrapped-key:${backupId}`),
    providerIdentity: backupId === "B0" ? "backup-provider-primary" : "backup-provider-secondary",
    envelopeBytesReference: `backup-bytes-${backupId}`,
    wrappedKeyReference: `wrapped-key-${backupId}`,
    recoveryKeyReference: {
      provider: "vault",
      providerIdentity: "vault-primary",
      logicalHostId: oldIdentity.logicalHostId,
      storeId: oldIdentity.storeId,
      profile: "recovery",
      purpose: "backup-recovery" as const,
      keyId: `recovery-key-${backupId}`,
      keyVersion,
    },
    createdAt: `2026-07-0${keyVersion}T00:00:00.000Z`,
    retentionUntil: "2027-07-01T00:00:00.000Z",
  };
  if (state === "staged") return { ...base, state };
  if (state === "finalized") {
    return { ...base, state, finalizedAt: "2026-07-03T00:00:00.000Z" };
  }
  if (state === "destruction-intended") {
    return {
      ...base,
      state,
      finalizedAt: "2026-07-03T00:00:00.000Z",
      destructionId: `destroy-${backupId}`,
    };
  }
  return {
    ...base,
    state,
    finalizedAt: "2026-07-03T00:00:00.000Z",
    destructionId: `destroy-${backupId}`,
    destroyedAt: "2026-07-04T00:00:00.000Z",
  };
}

function inventoryEntry(backupId: "B0" | "B1", generation: number) {
  return checkpointInventoryEntryForBackupRecord(backupRecord(backupId), generation);
}

function backupInventory(backupId: "B0" | "B1") {
  return backupId === "B0"
    ? [inventoryEntry("B0", 1)]
    : [inventoryEntry("B0", 1), inventoryEntry("B1", 2)];
}

function pendingIntent(generation: number): RecoveryCheckpointDestructionIntent {
  const providerId = "backup-provider-primary";
  const bytesTarget = "backup-bytes-B0";
  const keyTarget = "wrapped-key-B0";
  return {
    intentId: "destroy-B0",
    backupId: "B0",
    generation,
    providerId,
    bytesTarget,
    keyTarget,
    targetDigest: destructionTargetDigest({ providerId, bytesTarget, keyTarget }),
    phase: "pending",
  };
}

function checkpointPayload(
  input: Readonly<{
    generation: number;
    priorRecordDigest: string | null;
    backupId?: "B0" | "B1";
    pendingIntent?: boolean;
  }>,
): RecoveryCheckpointPayload {
  const backupId = input.backupId ?? "B0";
  return {
    generation: input.generation,
    priorRecordDigest: input.priorRecordDigest,
    logicalHostId: oldIdentity.logicalHostId,
    storeId: oldIdentity.storeId,
    operationNamespace: oldIdentity.operationNamespace,
    securityEpoch: 8,
    providerCommitment: digest("provider-commitment"),
    keyCommitment: digest("recovery-key-commitment"),
    backupInventory: backupInventory(backupId),
    pendingDestructionIntents: input.pendingIntent ? [pendingIntent(input.generation)] : [],
    immutableReceipts: [{ receiptId: "purge-through-7", generation: 7, kind: "purge" as const }],
    backupId,
  };
}

function restoredState(checkpoint: RecoveryCheckpointPayload): RestorableControlPlaneState {
  return {
    identity: oldIdentity,
    authorityGeneration: checkpoint.generation,
    effectiveGeneration: 40,
    securityEpoch: checkpoint.securityEpoch,
    domain: [{ entityId: `domain-${checkpoint.backupId}`, value: { restored: true } }],
    lifecycle: {
      backups: [],
      finalizations: [],
      destructions: [],
      keyRetirements: [],
      externalDestructionIntents: [],
      nonRestorableLedgers: [],
      consumedOperationIds: [
        {
          ...oldIdentity,
          actorId: "old-operator",
          operationId: "old-operation-id",
          target: "global",
          requestIdentity: "old-request",
          operationClass: "external-effect",
        },
      ],
      retentionCutoff: 0,
      purgeWatermark: 0,
    },
    operationOutcomes: [],
    security: {
      sessions: ["old-session"],
      tokenFamilies: ["old-family"],
      approvals: ["old-approval"],
      roles: ["old-role"],
      credentials: ["old-credential"],
      projectBindingLeases: ["old-lease"],
      vaultGrants: ["old-grant"],
    },
  };
}

class Descriptor implements RecoveryDescriptorPort {
  value: RecoveryDescriptor | undefined;

  async read() {
    return this.value ? { ...this.value } : undefined;
  }

  async compareAndSwap(expected: RecoveryDescriptor | undefined, replacement: RecoveryDescriptor) {
    if (JSON.stringify(this.value) !== JSON.stringify(expected)) return false;
    this.value = { ...replacement };
    return true;
  }
}

class Replica implements RecoveryCheckpointReplicaPort {
  readonly ownerPrivate = true;
  readonly fsyncedPrepared = new Set<number>();
  readonly fsyncedRepairs = new Set<number>();
  chain: AuthenticatedRecoveryCheckpoint[] = [];
  repairFault: "stale-descriptor" | "fsync" | undefined;

  constructor(
    readonly replicaId: string,
    readonly outsideSqlAndManagedBackup: boolean,
    private readonly descriptor?: Descriptor,
  ) {}

  async readChain() {
    return structuredClone(this.chain);
  }

  async writePrepared(checkpoint: AuthenticatedRecoveryCheckpoint) {
    const index = checkpoint.payload.generation - 1;
    if (index > this.chain.length) throw new Error("checkpoint generation gap");
    this.chain[index] = structuredClone(checkpoint);
    this.chain.length = index + 1;
    this.fsyncedPrepared.delete(checkpoint.payload.generation);
  }

  async fsyncPrepared(generation: number) {
    if (!this.chain[generation - 1]) throw new Error("checkpoint is missing");
    this.fsyncedPrepared.add(generation);
  }

  async rereadPrepared(generation: number) {
    if (!this.fsyncedPrepared.has(generation)) return undefined;
    const checkpoint = this.chain[generation - 1];
    return checkpoint ? structuredClone(checkpoint) : undefined;
  }

  async promoteSelected(generation: number, checkpointDigest: string) {
    const checkpoint = this.chain[generation - 1];
    if (!checkpoint || checkpoint.digest !== checkpointDigest)
      throw new Error("selection mismatch");
    this.chain[generation - 1] = { ...checkpoint, state: "selected" };
  }

  async repairSelectedChainAtomically(input: {
    expectedDescriptor: RecoveryDescriptor;
    chain: readonly AuthenticatedRecoveryCheckpoint[];
  }) {
    if (this.repairFault === "stale-descriptor") return "stale-descriptor" as const;
    if (
      this.descriptor &&
      JSON.stringify(await this.descriptor.read()) !== JSON.stringify(input.expectedDescriptor)
    ) {
      return "stale-descriptor" as const;
    }
    if (
      this.chain.some(
        (checkpoint) =>
          checkpoint.state === "selected" &&
          checkpoint.payload.generation > input.expectedDescriptor.generation,
      )
    ) {
      return "newer-selected-generation" as const;
    }
    this.chain = structuredClone([...input.chain]);
    this.fsyncedRepairs.delete(input.expectedDescriptor.generation);
    return "repaired" as const;
  }

  async fsyncSelectedChain(generation: number) {
    if (this.repairFault === "fsync") throw new Error("repair fsync failed");
    this.fsyncedRepairs.add(generation);
  }

  async rereadSelectedChain(generation: number) {
    return this.fsyncedRepairs.has(generation) ? structuredClone(this.chain) : undefined;
  }

  async discardUnselected(generation: number, checkpointDigest: string) {
    const checkpoint = this.chain[generation - 1];
    if (checkpoint?.digest === checkpointDigest && checkpoint.state === "prepared") {
      this.chain.length = generation - 1;
      this.fsyncedPrepared.delete(generation);
    }
  }
}

class RecoveryFixture implements CatastrophicRecoveryPort {
  validation: "valid" | "invalid" | "stale" | "reused" = "valid";
  claimOverride: "stale" | "reused" | undefined;
  authorityIsolation: "isolated" | "destroyed" | "reachable" | "unproven" = "isolated";
  rejectOldJoinCredentials = true;
  inventoryOverride: RecoveryBackupMaterial["completeBackupInventory"] | undefined;
  restoredOverride: RestorableControlPlaneState | undefined;
  marker: RestoredSqlMarker | undefined;
  staged: RestorableControlPlaneState | undefined;
  readonly claimed = new Set<string>();
  readonly completed = new Set<string>();
  readonly deletionTargets: RecoveryCheckpointDestructionIntent[] = [];
  readonly destroyedInventory = new Map<string, BackupInventoryRecord>();
  readonly staleNamespaces = new Set<string>();
  readonly isolatedStores = new Set<string>();
  readinessDescriptor: RecoveryDescriptor | undefined;
  readinessReplicaDigests: readonly [string, string] | undefined;
  ready = false;

  protectedState() {
    return structuredClone({
      marker: this.marker,
      staged: this.staged,
      claimed: [...this.claimed],
      completed: [...this.completed],
      deletionTargets: this.deletionTargets,
      staleNamespaces: [...this.staleNamespaces],
      isolatedStores: [...this.isolatedStores],
      ready: this.ready,
    });
  }

  async validateConfirmationWithoutSideEffects(confirmation: CatastrophicRecoveryConfirmation) {
    if (this.completed.has(confirmation.token)) return "reused" as const;
    return this.validation;
  }

  async claimConfirmation(confirmation: CatastrophicRecoveryConfirmation) {
    if (this.claimOverride) return this.claimOverride;
    if (this.completed.has(confirmation.token)) return "reused" as const;
    if (this.claimed.has(confirmation.token)) return "resume" as const;
    this.claimed.add(confirmation.token);
    return "claimed" as const;
  }

  async loadAndDecryptRecoveryBackup(
    checkpoint: RecoveryCheckpointPayload,
  ): Promise<RecoveryBackupMaterial> {
    const canonicalBackupInventory = checkpoint.backupInventory.map(
      (entry): BackupInventoryRecord =>
        this.destroyedInventory.get(entry.backupId) ??
        backupRecord(
          entry.backupId as "B0" | "B1",
          checkpoint.pendingDestructionIntents.some((intent) => intent.backupId === entry.backupId)
            ? "destruction-intended"
            : "finalized",
        ),
    );
    return {
      restored: this.restoredOverride ?? restoredState(checkpoint),
      providerCommitment: checkpoint.providerCommitment,
      keyCommitment: checkpoint.keyCommitment,
      completeBackupInventory: this.inventoryOverride ?? checkpoint.backupInventory,
      canonicalBackupInventory,
    };
  }

  async allocateNewIdentity(recoveryId: string): Promise<RestoreIdentity> {
    return {
      logicalHostId: oldIdentity.logicalHostId,
      storeId: `store-new-${recoveryId}`,
      operationNamespace: `namespace-new-${recoveryId}`,
    };
  }

  async stageNewStore(input: { state: RestorableControlPlaneState }) {
    this.staged = structuredClone(input.state);
  }

  async establishOldAuthorityIsolation() {
    if (this.authorityIsolation === "reachable" || this.authorityIsolation === "unproven") {
      return this.authorityIsolation;
    }
    return {
      receiptId: "old-authority-receipt",
      disposition: this.authorityIsolation,
    } as const;
  }

  async verifyOldJoinCredentialsRejected() {
    return this.rejectOldJoinCredentials;
  }

  async reconcileExternalDestruction(input: { intent: RecoveryCheckpointDestructionIntent }) {
    this.deletionTargets.push(structuredClone(input.intent));
    const destroyedInventoryRecord = backupRecord(
      input.intent.backupId as "B0" | "B1",
      "destroyed",
    );
    this.destroyedInventory.set(input.intent.backupId, destroyedInventoryRecord);
    return {
      receiptId: `terminal-${input.intent.intentId}`,
      providerId: input.intent.providerId,
      bytesTarget: input.intent.bytesTarget,
      keyTarget: input.intent.keyTarget,
      targetDigest: input.intent.targetDigest,
      destroyedInventoryRecord,
    } as const;
  }

  async writeRestoredSqlMarkerAtomically(marker: RestoredSqlMarker) {
    if (this.marker && JSON.stringify(this.marker) !== JSON.stringify(marker)) {
      throw new Error("marker mismatch");
    }
    this.marker = structuredClone(marker);
  }

  async readRestoredSqlMarker() {
    return this.marker ? structuredClone(this.marker) : undefined;
  }

  async enableReadiness(input: {
    marker: RestoredSqlMarker;
    descriptor: RecoveryDescriptor;
    replicaCheckpointDigests: readonly [string, string];
    staleNamespaces: readonly string[];
    isolatedStoreIds: readonly string[];
  }) {
    for (const namespace of input.staleNamespaces) this.staleNamespaces.add(namespace);
    for (const storeId of input.isolatedStoreIds) this.isolatedStores.add(storeId);
    this.readinessDescriptor = structuredClone(input.descriptor);
    this.readinessReplicaDigests = structuredClone(input.replicaCheckpointDigests);
    this.ready = true;
    this.completed.add(input.marker.recoveryId === "recovery-1" ? "recovery-confirmation" : "");
  }

  lookupOldOperation(namespace: string) {
    return this.staleNamespaces.has(namespace) ? "stale_namespace" : "not_committed";
  }

  oldNodeCanJoin(storeId: string) {
    return !this.isolatedStores.has(storeId) && !this.rejectOldJoinCredentials;
  }
}

function confirmation(descriptor: RecoveryDescriptor): CatastrophicRecoveryConfirmation {
  return {
    token: "recovery-confirmation",
    recoveryId: "recovery-1",
    descriptorGeneration: descriptor.generation,
    descriptorDigest: descriptor.checkpointDigest,
    oldIdentity,
    consequencesCommitment: digest("destroy-old-authority-and-invalidate-credentials"),
  };
}

async function selectedCheckpoint(
  input: Readonly<{
    backupId?: "B0" | "B1";
    pendingIntent?: boolean;
  }> = {},
) {
  const descriptor = new Descriptor();
  const replicas = [
    new Replica("replica-a", false, descriptor),
    new Replica("replica-b", true, descriptor),
  ] as const;
  const payload = checkpointPayload({
    generation: 1,
    priorRecordDigest: null,
    backupId: input.backupId ?? "B0",
    pendingIntent: input.pendingIntent ?? false,
  });
  const selected = await advanceRecoveryCheckpoint({ payload, replicas, descriptor, hmac });
  return { replicas, descriptor, payload, selected };
}

async function expectInvalidPayload(mutator: (payload: Record<string, unknown>) => void) {
  const payload = structuredClone(
    checkpointPayload({ generation: 1, priorRecordDigest: null }),
  ) as unknown as Record<string, unknown>;
  mutator(payload);
  await expect(
    createAuthenticatedRecoveryCheckpoint(payload as unknown as RecoveryCheckpointPayload, hmac),
  ).rejects.toMatchObject({ code: "checkpoint_authentication_failed" });
}

describe("catastrophic control-plane recovery", () => {
  it("canonicalizes ASCII identifiers using deterministic code-unit order", () => {
    const left = checkpointPayload({ generation: 1, priorRecordDigest: null, backupId: "B1" });
    const right = {
      ...left,
      backupInventory: [...left.backupInventory].reverse(),
      immutableReceipts: [...left.immutableReceipts].reverse(),
    };
    expect(checkpointCanonicalBytes(right)).toEqual(checkpointCanonicalBytes(left));
    const canonical = JSON.parse(new TextDecoder().decode(checkpointCanonicalBytes(left))) as {
      payload: { backupInventory: { backupId: string }[] };
    };
    expect(canonical.payload.backupInventory.map((entry) => entry.backupId)).toEqual(["B0", "B1"]);
  });

  it("strictly rejects noncanonical IDs, digests, enums, exact-key violations, and broken linkages", async () => {
    await expectInvalidPayload((payload) => {
      payload.logicalHostId = "höst";
    });
    await expectInvalidPayload((payload) => {
      payload.providerCommitment = "ABC";
    });
    await expectInvalidPayload((payload) => {
      payload.unexpected = true;
    });
    await expectInvalidPayload((payload) => {
      (payload.backupInventory as Record<string, unknown>[])[0]!.state = "missing";
    });
    await expectInvalidPayload((payload) => {
      (payload.backupInventory as Record<string, unknown>[])[0]!.unexpected = true;
    });
    await expectInvalidPayload((payload) => {
      payload.pendingDestructionIntents = [
        { ...pendingIntent(1), targetDigest: digest("wrong-target") },
      ];
    });
    await expectInvalidPayload((payload) => {
      payload.pendingDestructionIntents = [{ ...pendingIntent(1), backupId: "absent-backup" }];
    });
    await expectInvalidPayload((payload) => {
      payload.immutableReceipts = [
        {
          receiptId: "receipt",
          generation: 1,
          kind: "destruction",
          targetIntentId: "missing-intent",
          backupId: "B0",
          providerId: "provider",
          bytesTarget: "bytes",
          keyTarget: "key",
          targetDigest: digest("target"),
        },
      ];
    });
  });

  it("rejects generation overflow before any replica write", async () => {
    const setup = await selectedCheckpoint();
    setup.descriptor.value = { ...setup.selected, generation: Number.MAX_SAFE_INTEGER };
    const before = await Promise.all(setup.replicas.map((replica) => replica.readChain()));
    await expect(
      advanceRecoveryCheckpoint({
        payload: checkpointPayload({
          generation: Number.MAX_SAFE_INTEGER,
          priorRecordDigest: setup.selected.checkpointDigest,
        }),
        replicas: setup.replicas,
        descriptor: setup.descriptor,
        hmac,
      }),
    ).rejects.toMatchObject({ code: "generation_overflow" });
    expect(await Promise.all(setup.replicas.map((replica) => replica.readChain()))).toEqual(before);
  });

  it("fences repair against a stale live descriptor and never truncates a newer selection", async () => {
    const setup = await selectedCheckpoint();
    const generationTwo = checkpointPayload({
      generation: 2,
      priorRecordDigest: setup.selected.checkpointDigest,
      backupId: "B1",
    });
    const selectedTwo = await advanceRecoveryCheckpoint({
      payload: generationTwo,
      replicas: setup.replicas,
      descriptor: setup.descriptor,
      hmac,
    });
    const newerChain = await setup.replicas[0].readChain();
    setup.replicas[1].chain = [];
    setup.replicas[1].repairFault = "stale-descriptor";

    await expect(
      createCatastrophicRecoveryCoordinator({
        replicas: setup.replicas,
        descriptor: setup.descriptor,
        hmac,
        port: new RecoveryFixture(),
      }).recover(confirmation(selectedTwo)),
    ).rejects.toMatchObject({ code: "checkpoint_stale" });
    expect(await setup.descriptor.read()).toEqual(selectedTwo);
    expect(await setup.replicas[0].readChain()).toEqual(newerChain);

    setup.replicas[1].chain = structuredClone(newerChain);
    setup.replicas[1].repairFault = undefined;
    setup.descriptor.value = setup.selected;
    await expect(
      advanceRecoveryCheckpoint({
        payload: generationTwo,
        replicas: setup.replicas,
        descriptor: setup.descriptor,
        hmac,
      }),
    ).rejects.toMatchObject({ code: "checkpoint_stale" });
    expect(setup.replicas[1].chain).toHaveLength(2);
    expect(setup.replicas[1].chain.at(-1)?.digest).toBe(selectedTwo.checkpointDigest);
  });

  it("requires atomic repair fsync and reread before recovery work", async () => {
    const setup = await selectedCheckpoint();
    setup.replicas[1].chain = [];
    setup.replicas[1].repairFault = "fsync";
    const port = new RecoveryFixture();
    await expect(
      createCatastrophicRecoveryCoordinator({
        replicas: setup.replicas,
        descriptor: setup.descriptor,
        hmac,
        port,
      }).recover(confirmation(setup.selected)),
    ).rejects.toMatchObject({ code: "recovery_interrupted" });
    expect(port.staged).toBeUndefined();
    expect(port.deletionTargets).toEqual([]);
    expect(port.ready).toBe(false);
  });

  it("checkpoints exact deletion targets, terminal receipt, and new authority before readiness", async () => {
    const setup = await selectedCheckpoint({ backupId: "B1", pendingIntent: true });
    setup.replicas[1].chain = [];
    const port = new RecoveryFixture();
    const result = await createCatastrophicRecoveryCoordinator({
      replicas: setup.replicas,
      descriptor: setup.descriptor,
      hmac,
      port,
    }).recover(confirmation(setup.selected));

    const finalDescriptor = await setup.descriptor.read();
    expect(finalDescriptor?.generation).toBe(3);
    expect(result.marker).toMatchObject({
      descriptorGeneration: 3,
      descriptorDigest: finalDescriptor?.checkpointDigest,
      newIdentity: result.state.identity,
    });
    expect(result.state.identity).toEqual({
      logicalHostId: oldIdentity.logicalHostId,
      storeId: "store-new-recovery-1",
      operationNamespace: "namespace-new-recovery-1",
    });
    expect(result.state.securityEpoch).toBe(9);
    expect(result.state.authorityGeneration).toBe(4);
    expect(result.state.security).toEqual({
      sessions: [],
      tokenFamilies: [],
      approvals: [],
      roles: [],
      credentials: [],
      projectBindingLeases: [],
      vaultGrants: [],
    });
    expect(port.deletionTargets).toEqual([pendingIntent(1)]);
    const terminalCheckpoint = setup.replicas[0].chain[1]!.payload;
    expect(terminalCheckpoint.pendingDestructionIntents).toEqual([]);
    expect(terminalCheckpoint.backupInventory.find((entry) => entry.backupId === "B0")?.state).toBe(
      "destroyed",
    );
    expect(terminalCheckpoint.immutableReceipts).toContainEqual(
      expect.objectContaining({
        receiptId: "terminal-destroy-B0",
        generation: 2,
        kind: "destruction",
        recoveryId: "recovery-1",
        targetIntentId: "destroy-B0",
        backupId: "B0",
        providerId: "backup-provider-primary",
        bytesTarget: "backup-bytes-B0",
        keyTarget: "wrapped-key-B0",
        targetDigest: pendingIntent(1).targetDigest,
      }),
    );
    const authorityCheckpoint = setup.replicas[0].chain[2]!.payload;
    expect(authorityCheckpoint).toMatchObject({
      storeId: "store-new-recovery-1",
      operationNamespace: "namespace-new-recovery-1",
      securityEpoch: 9,
    });
    expect(authorityCheckpoint.immutableReceipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "old-authority-isolation", recoveryId: "recovery-1" }),
        expect.objectContaining({
          kind: "stale-namespace",
          recoveryId: "recovery-1",
          staleNamespace: oldIdentity.operationNamespace,
        }),
      ]),
    );
    expect(port.lookupOldOperation(oldIdentity.operationNamespace)).toBe("stale_namespace");
    expect(port.oldNodeCanJoin(oldIdentity.storeId)).toBe(false);
    expect(port.readinessDescriptor).toEqual(finalDescriptor);
    expect(port.readinessReplicaDigests).toEqual([
      finalDescriptor?.checkpointDigest,
      finalDescriptor?.checkpointDigest,
    ]);
    expect(setup.replicas[0].chain).toEqual(setup.replicas[1].chain);
    expect(port.ready).toBe(true);
  });

  it.each([
    ["reachable", true, "old_authority_reachable"],
    ["unproven", true, "old_authority_unproven"],
    ["isolated", false, "old_join_credentials_accepted"],
  ] as const)(
    "requires a checkpointable old-authority receipt and rejected old credentials: %s",
    async (authorityIsolation, rejectOldJoinCredentials, expectedCode) => {
      const setup = await selectedCheckpoint();
      const port = new RecoveryFixture();
      port.authorityIsolation = authorityIsolation;
      port.rejectOldJoinCredentials = rejectOldJoinCredentials;
      await expect(
        createCatastrophicRecoveryCoordinator({
          replicas: setup.replicas,
          descriptor: setup.descriptor,
          hmac,
          port,
        }).recover(confirmation(setup.selected)),
      ).rejects.toMatchObject({ code: expectedCode });
      expect(port.ready).toBe(false);
      expect((await setup.descriptor.read())?.generation).toBe(1);
    },
  );

  it("strictly rejects malformed restored state and authority/security overflow", async () => {
    const malformed = await selectedCheckpoint();
    const malformedPort = new RecoveryFixture();
    malformedPort.restoredOverride = {
      ...restoredState(malformed.payload),
      lifecycle: {
        ...restoredState(malformed.payload).lifecycle,
        backups: [{ invalid: true }],
      },
    } as unknown as RestorableControlPlaneState;
    await expect(
      createCatastrophicRecoveryCoordinator({
        replicas: malformed.replicas,
        descriptor: malformed.descriptor,
        hmac,
        port: malformedPort,
      }).recover(confirmation(malformed.selected)),
    ).rejects.toMatchObject({ code: "restored_state_invalid" });

    for (const field of ["authorityGeneration", "securityEpoch"] as const) {
      const setup = await selectedCheckpoint();
      const port = new RecoveryFixture();
      port.restoredOverride = {
        ...restoredState(setup.payload),
        [field]: Number.MAX_SAFE_INTEGER,
      };
      await expect(
        createCatastrophicRecoveryCoordinator({
          replicas: setup.replicas,
          descriptor: setup.descriptor,
          hmac,
          port,
        }).recover(confirmation(setup.selected)),
      ).rejects.toMatchObject({ code: "generation_overflow" });
      expect(port.ready).toBe(false);
      expect((await setup.descriptor.read())?.generation).toBe(1);
    }
  });

  it.each([
    ["missing", undefined, "confirmation_required"],
    ["mismatched", "invalid", "confirmation_invalid"],
    ["expired", "invalid", "confirmation_invalid"],
    ["stale", "stale", "confirmation_stale"],
    ["reused", "reused", "confirmation_reused"],
  ] as const)(
    "%s catastrophic confirmation is a no-op, including no replica repair",
    async (_caseName, validation, expectedCode) => {
      const setup = await selectedCheckpoint();
      setup.replicas[1].chain = [];
      const port = new RecoveryFixture();
      if (validation !== undefined) port.validation = validation;
      const before = {
        port: port.protectedState(),
        replicaA: await setup.replicas[0].readChain(),
        replicaB: await setup.replicas[1].readChain(),
        descriptor: await setup.descriptor.read(),
      };
      await expect(
        createCatastrophicRecoveryCoordinator({
          replicas: setup.replicas,
          descriptor: setup.descriptor,
          hmac,
          port,
        }).recover(validation === undefined ? undefined : confirmation(setup.selected)),
      ).rejects.toMatchObject({ code: expectedCode });
      expect({
        port: port.protectedState(),
        replicaA: await setup.replicas[0].readChain(),
        replicaB: await setup.replicas[1].readChain(),
        descriptor: await setup.descriptor.read(),
      }).toEqual(before);
    },
  );

  it("fails for missing checkpoints and incomplete exact inventory", async () => {
    const missingDescriptor = new Descriptor();
    const missingReplicas = [
      new Replica("a", false, missingDescriptor),
      new Replica("b", true, missingDescriptor),
    ] as const;
    await expect(
      createCatastrophicRecoveryCoordinator({
        replicas: missingReplicas,
        descriptor: missingDescriptor,
        hmac,
        port: new RecoveryFixture(),
      }).recover({
        ...confirmation({
          generation: 1,
          checkpointDigest: digest("missing"),
          logicalHostId: oldIdentity.logicalHostId,
        }),
      }),
    ).rejects.toMatchObject({ code: "checkpoint_missing" });

    const incomplete = await selectedCheckpoint({ backupId: "B1" });
    const incompletePort = new RecoveryFixture();
    incompletePort.inventoryOverride = backupInventory("B0");
    await expect(
      createCatastrophicRecoveryCoordinator({
        replicas: incomplete.replicas,
        descriptor: incomplete.descriptor,
        hmac,
        port: incompletePort,
      }).recover(confirmation(incomplete.selected)),
    ).rejects.toMatchObject({ code: "backup_inventory_incomplete" });
  });

  it("every checkpoint boundary leaves only descriptor-selected authority", async () => {
    for (const failurePoint of CHECKPOINT_ADVANCE_FAILURE_POINTS) {
      const setup = await selectedCheckpoint({ backupId: "B0" });
      const generationTwo = checkpointPayload({
        generation: 2,
        priorRecordDigest: setup.selected.checkpointDigest,
        backupId: "B1",
      });
      await expect(
        advanceRecoveryCheckpoint({
          payload: generationTwo,
          replicas: setup.replicas,
          descriptor: setup.descriptor,
          hmac,
          failureInjector(point) {
            if (point === failurePoint) throw new Error(`fault:${point}`);
          },
        }),
      ).rejects.toThrow(`fault:${failurePoint}`);

      const selected = await setup.descriptor.read();
      expect(selected).toBeDefined();
      const chain = setup.replicas.find(
        (replica) => replica.chain[selected!.generation - 1]?.digest === selected!.checkpointDigest,
      )?.chain;
      expect(chain?.[selected!.generation - 1]?.digest).toBe(selected!.checkpointDigest);
      for (const replica of setup.replicas) {
        const higherSelected = replica.chain.find(
          (checkpoint) =>
            checkpoint.state === "selected" && checkpoint.payload.generation > selected!.generation,
        );
        expect(higherSelected).toBeUndefined();
      }
      const port = new RecoveryFixture();
      const recovered = await createCatastrophicRecoveryCoordinator({
        replicas: setup.replicas,
        descriptor: setup.descriptor,
        hmac,
        port,
      }).recover(confirmation(selected!));
      const finalDescriptor = await setup.descriptor.read();
      expect(finalDescriptor?.generation).toBe(selected!.generation + 1);
      expect(recovered.marker.descriptorDigest).toBe(finalDescriptor?.checkpointDigest);
      expect(setup.replicas[0].chain).toEqual(setup.replicas[1].chain);
      expect(port.ready).toBe(true);
    }
  });

  it("resumes every catastrophic boundary through receipt and new-authority checkpoint generations", async () => {
    for (const failurePoint of CATASTROPHIC_RECOVERY_FAILURE_POINTS) {
      const setup = await selectedCheckpoint({ backupId: "B1", pendingIntent: true });
      const port = new RecoveryFixture();
      const failing = createCatastrophicRecoveryCoordinator({
        replicas: setup.replicas,
        descriptor: setup.descriptor,
        hmac,
        port,
        failureInjector(point) {
          if (point === failurePoint) throw new Error(`fault:${point}`);
        },
      });
      await expect(failing.recover(confirmation(setup.selected))).rejects.toMatchObject({
        code: "recovery_interrupted",
      });
      expect(port.ready).toBe(false);

      const resumed = await createCatastrophicRecoveryCoordinator({
        replicas: setup.replicas,
        descriptor: setup.descriptor,
        hmac,
        port,
      }).recover(confirmation(setup.selected));
      const selected = await setup.descriptor.read();
      expect(selected?.generation).toBe(3);
      expect(resumed.marker.descriptorDigest).toBe(selected?.checkpointDigest);
      expect(port.ready).toBe(true);
    }
  });

  it("rejects authenticated non-monotonic inventory, intent mutation, and receipt mutation", async () => {
    const setup = await selectedCheckpoint({ backupId: "B1", pendingIntent: true });
    const variants: readonly [
      RecoveryCheckpointPayload,
      "checkpoint_mismatch" | "checkpoint_authentication_failed",
    ][] = [
      [
        {
          ...checkpointPayload({
            generation: 2,
            priorRecordDigest: setup.selected.checkpointDigest,
            backupId: "B1",
          }),
          backupInventory: [inventoryEntry("B1", 2)],
        },
        "checkpoint_mismatch",
      ],
      [
        {
          ...checkpointPayload({
            generation: 2,
            priorRecordDigest: setup.selected.checkpointDigest,
            backupId: "B1",
            pendingIntent: true,
          }),
          pendingDestructionIntents: [
            { ...pendingIntent(2), bytesTarget: "widened-target", phase: "bytes-absent" },
          ],
        },
        "checkpoint_authentication_failed",
      ],
      [
        {
          ...checkpointPayload({
            generation: 2,
            priorRecordDigest: setup.selected.checkpointDigest,
            backupId: "B1",
            pendingIntent: true,
          }),
          immutableReceipts: [{ receiptId: "purge-through-7", generation: 8, kind: "purge" }],
        },
        "checkpoint_mismatch",
      ],
    ];

    for (const [payload, expectedCode] of variants) {
      await expect(
        advanceRecoveryCheckpoint({
          payload,
          replicas: setup.replicas,
          descriptor: setup.descriptor,
          hmac,
        }),
      ).rejects.toMatchObject({ code: expectedCode });
      expect((await setup.descriptor.read())?.generation).toBe(1);
    }
  });

  it("rejects insecure placement and tampered authentication", async () => {
    const descriptor = new Descriptor();
    const replicas = [
      new Replica("replica-a", false, descriptor),
      new Replica("replica-b", false, descriptor),
    ] as const;
    await expect(
      advanceRecoveryCheckpoint({
        payload: checkpointPayload({ generation: 1, priorRecordDigest: null }),
        replicas,
        descriptor,
        hmac,
      }),
    ).rejects.toMatchObject({ code: "checkpoint_location_insecure" });

    const checkpoint = await createAuthenticatedRecoveryCheckpoint(
      checkpointPayload({ generation: 1, priorRecordDigest: null }),
      hmac,
    );
    expect(
      await verifyAuthenticatedRecoveryCheckpoint(
        { ...checkpoint, authentication: digest("tampered") },
        hmac,
      ),
    ).toBe(false);
  });
});
