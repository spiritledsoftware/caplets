import { describe, expect, it } from "vitest";
import type { CurrentHostOperationBinding } from "../src/current-host/operations";
import type {
  BackupInventoryRecord,
  RecoveryEnvelopeBinding,
  RecoveryEnvelopeReadResult,
} from "../src/control-plane/migration/backup";
import {
  NORMAL_RESTORE_FAILURE_POINTS,
  NormalRestoreError,
  createNormalRestoreCoordinator,
  mergeRestoreState,
  type DurableInactiveRestoreCandidate,
  type NormalRestoreAbortPhase,
  type NormalRestoreConfirmation,
  type NormalRestoreFailurePoint,
  type NormalRestoreJournal,
  type NormalRestorePort,
  type RestoreOperationRecoveryEvidence,
  type RestorableControlPlaneState,
  type RestoreIdentity,
} from "../src/control-plane/migration/restore";

const identity: RestoreIdentity = {
  logicalHostId: "host_01J00000000000000000000000",
  storeId: "store_01J00000000000000000000000",
  operationNamespace: "namespace_01J00000000000000000000",
};

const recoveryKeyReference = {
  provider: "aws-kms",
  providerIdentity: "provider-production",
  logicalHostId: identity.logicalHostId,
  storeId: identity.storeId,
  profile: "production",
  purpose: "backup-recovery",
  keyId: "recovery-key",
  keyVersion: 1,
} as const;

const envelopeBinding: RecoveryEnvelopeBinding = {
  logicalHostId: identity.logicalHostId,
  storeId: identity.storeId,
  sourceBackend: "sqlite",
  requiredSchemaNames: ["control-plane"],
  schemaChecksums: [{ name: "control-plane", sha256: "1".repeat(64) }],
  authorityToken: "authority-40",
  effectiveToken: "effective-40",
  securityToken: "security-7",
  entityManifest: [{ entity: "settings", count: 1, sha256: "2".repeat(64) }],
  requiredEntityNames: ["settings"],
  recoveryKeyReference,
};

function inventoryRecord(
  backupId: string,
  digestCharacter: string,
  keyVersion = 1,
): BackupInventoryRecord {
  return {
    backupId,
    bindingDigest: digestCharacter.repeat(64),
    headerDigest: digestCharacter.repeat(64),
    terminalManifestDigest: digestCharacter.repeat(64),
    wrappedKeyDigest: digestCharacter.repeat(64),
    providerIdentity: "provider-production",
    envelopeBytesReference: `envelope/${backupId}`,
    wrappedKeyReference: `wrapped/${backupId}`,
    recoveryKeyReference: { ...recoveryKeyReference, keyVersion },
    createdAt: "2026-07-14T00:00:00.000Z",
    retentionUntil: "2027-07-14T00:00:00.000Z",
    state: "finalized",
    finalizedAt: "2026-07-14T00:01:00.000Z",
  };
}

const backupB0 = inventoryRecord("B0", "a");
const backupB1 = inventoryRecord("B1", "b", 2);
const completeBackupInventory = [backupB0, backupB1] as const;

const authenticatedTerminal: RecoveryEnvelopeReadResult = {
  bindingDigest: backupB0.bindingDigest,
  headerDigest: backupB0.headerDigest,
  terminalManifestDigest: backupB0.terminalManifestDigest,
  wrappedKeyDigest: backupB0.wrappedKeyDigest,
  chunkCount: 2,
  plaintextLength: 512,
};

function operationBinding(
  operationId: string,
  overrides: Partial<CurrentHostOperationBinding> = {},
): CurrentHostOperationBinding {
  return {
    operationId,
    target: "global",
    logicalHostId: identity.logicalHostId,
    storeId: identity.storeId,
    operationNamespace: identity.operationNamespace,
    actorId: "operator-1",
    requestIdentity: `request-${operationId}`,
    operationClass: "logical-state",
    ...overrides,
  };
}

function state(
  input: Readonly<{
    authorityGeneration: number;
    effectiveGeneration?: number;
    securityEpoch: number;
    domain?: RestorableControlPlaneState["domain"];
    backups?: RestorableControlPlaneState["lifecycle"]["backups"];
    finalizations?: RestorableControlPlaneState["lifecycle"]["finalizations"];
    destructions?: RestorableControlPlaneState["lifecycle"]["destructions"];
    keyRetirements?: RestorableControlPlaneState["lifecycle"]["keyRetirements"];
    externalDestructionIntents?: RestorableControlPlaneState["lifecycle"]["externalDestructionIntents"];
    nonRestorableLedgers?: RestorableControlPlaneState["lifecycle"]["nonRestorableLedgers"];
    consumedOperationIds?: RestorableControlPlaneState["lifecycle"]["consumedOperationIds"];
    retentionCutoff?: number;
    purgeWatermark?: number;
    operationOutcomes?: RestorableControlPlaneState["operationOutcomes"];
    identityOverride?: RestoreIdentity;
  }>,
): RestorableControlPlaneState {
  return {
    identity: input.identityOverride ?? identity,
    authorityGeneration: input.authorityGeneration,
    effectiveGeneration: input.effectiveGeneration ?? input.authorityGeneration,
    securityEpoch: input.securityEpoch,
    domain: input.domain ?? [],
    lifecycle: {
      backups: input.backups ?? [],
      finalizations: input.finalizations ?? [],
      destructions: input.destructions ?? [],
      keyRetirements: input.keyRetirements ?? [],
      externalDestructionIntents: input.externalDestructionIntents ?? [],
      nonRestorableLedgers: input.nonRestorableLedgers ?? [],
      consumedOperationIds: input.consumedOperationIds ?? [],
      retentionCutoff: input.retentionCutoff ?? 0,
      purgeWatermark: input.purgeWatermark ?? 0,
    },
    operationOutcomes: input.operationOutcomes ?? [],
    security: {
      sessions: ["session-current"],
      tokenFamilies: ["family-current"],
      approvals: ["approval-current"],
      roles: ["role-current"],
      credentials: ["credential-current"],
      projectBindingLeases: ["lease-current"],
      vaultGrants: ["grant-current"],
    },
  };
}

function confirmation(
  overrides: Partial<NormalRestoreConfirmation> = {},
): NormalRestoreConfirmation {
  return {
    token: "confirmation-token",
    restoreId: "restore-1",
    target: identity,
    expectedAuthorityGeneration: 60,
    expectedSecurityEpoch: 12,
    selectedBackup: backupB0,
    completeBackupInventory,
    envelopeBinding,
    consequencesCommitment: "restore-consequences",
    ...overrides,
  };
}

class RestoreFixture implements NormalRestorePort {
  readonly events: string[] = [];
  readonly hydratedNodes = [
    { nodeId: "node-a", authorityGeneration: 60, effectiveGeneration: 60 },
    { nodeId: "node-b", authorityGeneration: 60, effectiveGeneration: 60 },
  ];
  active: RestorableControlPlaneState;
  journal: NormalRestoreJournal = { status: "absent" };
  staged: RestorableControlPlaneState | undefined;
  fenced = false;
  validation: "valid" | "invalid" | "stale" | "reused" = "valid";
  activation: "activated" | "confirmation-invalid" | "conflict" = "activated";
  failDiscardOnce = false;
  failAbortReleaseOnce = false;
  failFenceOnce = false;
  corruptCandidateReadback = false;
  expectedOperationRecovery: RestoreOperationRecoveryEvidence = {
    consumedBindings: [],
    terminalOutcomes: [],
  };

  constructor(
    current: RestorableControlPlaneState,
    readonly backup: RestorableControlPlaneState,
    readonly rescanned: readonly BackupInventoryRecord[] = [],
  ) {
    this.active = structuredClone(current);
  }

  protectedState() {
    return structuredClone({
      active: this.active,
      journal: this.journal,
      staged: this.staged,
      fenced: this.fenced,
    });
  }

  async readRestoreJournal(): Promise<NormalRestoreJournal> {
    return this.journal;
  }

  async validateConfirmationWithoutSideEffects() {
    this.events.push("validate-confirmation");
    return this.validation;
  }

  async fenceAllNodes() {
    if (this.failFenceOnce) {
      this.failFenceOnce = false;
      throw new Error("fence-failed-with-sensitive-adapter-detail");
    }
    this.events.push("fence-all-nodes");
    this.fenced = true;
    return "fence-token";
  }

  async assertAuthenticationFailsClosed() {
    this.events.push("auth-fails-closed");
    return this.fenced;
  }

  async readCurrentState() {
    this.events.push("preserve-current-ledgers");
    return structuredClone(this.active);
  }

  async verifyAndDecryptBackup(input: Parameters<NormalRestorePort["verifyAndDecryptBackup"]>[0]) {
    this.events.push("verify-and-decrypt");
    expect(input).toEqual({
      selectedBackup: backupB0,
      completeBackupInventory,
      expectedBinding: envelopeBinding,
      target: identity,
    });
    return {
      state: structuredClone(this.backup),
      binding: structuredClone(envelopeBinding),
      authenticatedTerminal: structuredClone(authenticatedTerminal),
    };
  }

  async stageHistoricalDomainInactive(
    _restoreId: string,
    _fenceToken: string,
    restored: RestorableControlPlaneState,
  ) {
    this.events.push("stage-inactive");
    expect(this.active.authorityGeneration).toBe(60);
    this.staged = structuredClone(restored);
    this.journal = { status: "staged" };
  }

  async rescanManagedBackupStorage() {
    this.events.push("rescan-managed-backups");
    return structuredClone(this.rescanned);
  }

  async writeInactiveCandidate(input: Parameters<NormalRestorePort["writeInactiveCandidate"]>[0]) {
    this.events.push("persist-inactive-candidate");
    expect(input.candidate.securityEpoch).toBeGreaterThan(this.active.securityEpoch);
    const operationRecovery = input.operationRecovery;
    expect(operationRecovery).toEqual(this.expectedOperationRecovery);
    const candidate = {
      state: structuredClone(input.candidate),
      expectedAuthorityGeneration: input.expectedAuthorityGeneration,
      operationRecovery,
      persistenceToken: "durable-candidate-token",
    } as DurableInactiveRestoreCandidate;
    this.staged = structuredClone(input.candidate);
    this.journal = { status: "candidate-durable", candidate };
  }

  async readInactiveCandidate() {
    this.events.push("readback-inactive-candidate");
    if (this.journal.status !== "candidate-durable") return undefined;
    const candidate = structuredClone(this.journal.candidate);
    if (this.corruptCandidateReadback) {
      return { ...candidate, state: { ...candidate.state, securityEpoch: 12 } };
    }
    return candidate;
  }

  async verifyCandidate(
    _restoreId: string,
    _fenceToken: string,
    candidate: DurableInactiveRestoreCandidate,
  ) {
    this.events.push("verify-candidate");
    expect(candidate.persistenceToken).toBe("durable-candidate-token");
    expect(candidate.state.security).toEqual({
      sessions: [],
      tokenFamilies: [],
      approvals: [],
      roles: [],
      credentials: [],
      projectBindingLeases: [],
      vaultGrants: [],
    });
  }

  async activateCandidateAtomically(
    input: Parameters<NormalRestorePort["activateCandidateAtomically"]>[0],
  ): Promise<"activated" | "confirmation-invalid" | "conflict"> {
    this.events.push("activate-pointer");
    expect(this.fenced).toBe(true);
    expect(input.candidate.persistenceToken).toBe("durable-candidate-token");
    expect(this.journal.status).toBe("candidate-durable");
    if (this.activation !== "activated") return this.activation;
    this.active = structuredClone(input.candidate.state);
    this.journal = { status: "activated", candidate: structuredClone(input.candidate.state) };
    return "activated";
  }

  async notifyAuthorityChanged() {
    this.events.push("notify-authority");
  }

  async forceHydrateAllNodes(candidate: RestorableControlPlaneState) {
    this.events.push("force-hydrate-all-nodes");
    for (const node of this.hydratedNodes) {
      node.authorityGeneration = candidate.authorityGeneration;
      node.effectiveGeneration = candidate.effectiveGeneration;
    }
  }

  async journalAbortPhase(
    _restoreId: string,
    _fenceToken: string,
    phase: NormalRestoreAbortPhase | "completed",
  ) {
    this.events.push(`journal-abort:${phase}`);
    this.journal = phase === "completed" ? { status: "absent" } : { status: "aborting", phase };
  }

  async discardInactiveStage() {
    this.events.push("discard-inactive");
    if (this.failDiscardOnce) {
      this.failDiscardOnce = false;
      throw new Error("discard-failed");
    }
    this.staged = undefined;
  }

  async releaseFence(_fenceToken: string, outcome: "aborted" | "completed") {
    this.events.push(`release-fence:${outcome}`);
    if (outcome === "aborted" && this.failAbortReleaseOnce) {
      this.failAbortReleaseOnce = false;
      throw new Error("release-failed");
    }
    if (outcome === "completed" && this.journal.status === "activated") {
      this.journal = {
        status: "completed",
        candidate: structuredClone(this.journal.candidate),
      };
    }
    this.fenced = false;
  }
}

function restoreFixture(): RestoreFixture {
  return new RestoreFixture(
    state({ authorityGeneration: 60, securityEpoch: 12, backups: completeBackupInventory }),
    state({
      authorityGeneration: 40,
      effectiveGeneration: 40,
      securityEpoch: 7,
      backups: [backupB0],
      domain: [{ entityId: "historical", value: {} }],
    }),
    completeBackupInventory,
  );
}

describe("normal control-plane restore", () => {
  it("merges canonical B0/B1 inventory without resurrection and allocates generation 61", () => {
    const current = state({
      authorityGeneration: 60,
      securityEpoch: 12,
      backups: completeBackupInventory,
      finalizations: [{ id: "final-B0", generation: 4, state: "finalized" }],
      destructions: [{ id: "destroy-old", generation: 8, state: "verified-absent" }],
      keyRetirements: [{ id: "key-1", generation: 9, state: "blocked-by-B1" }],
      externalDestructionIntents: [{ id: "intent-B1", generation: 7, state: "bytes-removed" }],
      nonRestorableLedgers: [{ id: "recovery-ledger", generation: 11, state: "durable" }],
      retentionCutoff: 10,
      purgeWatermark: 30,
    });
    const restored = state({
      authorityGeneration: 40,
      effectiveGeneration: 40,
      securityEpoch: 7,
      domain: [
        { entityId: "expired", retentionOrdinal: 10, value: { value: "must-not-return" } },
        { entityId: "retained", retentionOrdinal: 11, value: { value: "historical" } },
      ],
      backups: [backupB0],
      destructions: [{ id: "destroy-old", generation: 1, state: "pending" }],
      retentionCutoff: 1,
      purgeWatermark: 2,
    });

    const result = mergeRestoreState({ current, restored, rescannedBackups: [backupB1] });

    expect(result.authorityGeneration).toBe(61);
    expect(result.effectiveGeneration).toBe(40);
    expect(result.securityEpoch).toBe(13);
    expect(result.domain.map((row) => row.entityId)).toEqual(["retained"]);
    expect(result.lifecycle.backups).toEqual(completeBackupInventory);
    expect(result.lifecycle.destructions).toEqual(current.lifecycle.destructions);
    expect(result.lifecycle.finalizations).toEqual(current.lifecycle.finalizations);
    expect(result.lifecycle.keyRetirements).toEqual(current.lifecycle.keyRetirements);
    expect(result.lifecycle.externalDestructionIntents).toEqual(
      current.lifecycle.externalDestructionIntents,
    );
    expect(result.lifecycle.nonRestorableLedgers).toEqual(current.lifecycle.nonRestorableLedgers);
    expect(result.lifecycle.retentionCutoff).toBe(10);
    expect(result.lifecycle.purgeWatermark).toBe(30);
  });

  it("preserves the full binding and supersedes exact update and delete lost-ack effects", () => {
    const updateBinding = operationBinding("operation-update-lost-ack", {
      target: "remote",
      requestIdentity: "request-update",
      operationClass: "external-effect",
    });
    const deleteBinding = operationBinding("operation-delete-lost-ack", {
      target: "project",
      requestIdentity: "request-delete",
      operationClass: "logical-state",
    });
    const result = mergeRestoreState({
      current: state({
        authorityGeneration: 60,
        securityEpoch: 12,
        consumedOperationIds: [updateBinding, deleteBinding],
        operationOutcomes: [
          {
            binding: updateBinding,
            status: "committed",
            receipt: { kind: "update" },
            effectCommitments: [
              { entityId: "updated", after: { kind: "present", value: { version: 2 } } },
            ],
          },
          {
            binding: deleteBinding,
            status: "committed",
            receipt: { kind: "delete" },
            effectCommitments: [{ entityId: "deleted", after: { kind: "absent" } }],
          },
        ],
      }),
      restored: state({
        authorityGeneration: 40,
        securityEpoch: 7,
        domain: [
          { entityId: "updated", value: { version: 1 } },
          { entityId: "deleted", value: { version: 1 } },
        ],
      }),
      rescannedBackups: [],
    });

    expect(result.operationOutcomes.map((outcome) => outcome.status)).toEqual([
      "superseded_by_restore",
      "superseded_by_restore",
    ]);
    expect(result.lifecycle.consumedOperationIds).toEqual(
      expect.arrayContaining([deleteBinding, updateBinding]),
    );
    expect(result.operationOutcomes.map((outcome) => outcome.binding)).toEqual(
      expect.arrayContaining([deleteBinding, updateBinding]),
    );
  });

  it("refuses a cross-target replay binding for the same consumed operation identity", () => {
    const original = operationBinding("operation-lost-ack");
    const replay = { ...original, target: "remote", requestIdentity: "request-replay" } as const;

    expect(() =>
      mergeRestoreState({
        current: state({
          authorityGeneration: 60,
          securityEpoch: 12,
          consumedOperationIds: [original],
        }),
        restored: state({
          authorityGeneration: 40,
          securityEpoch: 7,
          consumedOperationIds: [replay],
        }),
        rescannedBackups: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "restore_conflict" }));
  });

  it.each([NaN, -1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid effective generation %s",
    (effectiveGeneration) => {
      expect(() =>
        mergeRestoreState({
          current: state({ authorityGeneration: 60, effectiveGeneration: 60, securityEpoch: 12 }),
          restored: state({ authorityGeneration: 40, effectiveGeneration, securityEpoch: 7 }),
          rescannedBackups: [],
        }),
      ).toThrowError(expect.objectContaining({ code: "restore_conflict" }));
    },
  );

  it("durably persists and rereads the complete invalidated candidate before pointer CAS", async () => {
    const fixture = restoreFixture();
    const visited: NormalRestoreFailurePoint[] = [];
    const result = await createNormalRestoreCoordinator({
      port: fixture,
      failureInjector(point) {
        visited.push(point);
        expect(fixture.fenced).toBe(true);
      },
    }).restore(confirmation());

    expect(result.authorityGeneration).toBe(61);
    expect(result.securityEpoch).toBe(13);
    expect(visited).toEqual(NORMAL_RESTORE_FAILURE_POINTS);
    expect(fixture.events.indexOf("persist-inactive-candidate")).toBeLessThan(
      fixture.events.indexOf("readback-inactive-candidate"),
    );
    expect(fixture.events.indexOf("readback-inactive-candidate")).toBeLessThan(
      fixture.events.indexOf("verify-candidate"),
    );
    expect(fixture.events.indexOf("verify-candidate")).toBeLessThan(
      fixture.events.indexOf("activate-pointer"),
    );
    expect(fixture.events.at(-1)).toBe("release-fence:completed");
    expect(fixture.hydratedNodes).toEqual([
      { nodeId: "node-a", authorityGeneration: 61, effectiveGeneration: 40 },
      { nodeId: "node-b", authorityGeneration: 61, effectiveGeneration: 40 },
    ]);
  });

  it("persists lookup-ready supersession evidence before activating a lost-ack restore", async () => {
    const binding = operationBinding("operation-lost-ack", {
      target: "project",
      requestIdentity: "request-lost-ack",
      operationClass: "logical-state",
    });
    const receipt = { kind: "setting-update", aggregateVersion: 4 };
    const fixture = new RestoreFixture(
      state({
        authorityGeneration: 60,
        securityEpoch: 12,
        backups: completeBackupInventory,
        consumedOperationIds: [binding],
        operationOutcomes: [
          {
            binding,
            status: "committed",
            receipt,
            effectCommitments: [
              { entityId: "setting", after: { kind: "present", value: { version: 2 } } },
            ],
          },
        ],
      }),
      state({
        authorityGeneration: 40,
        effectiveGeneration: 40,
        securityEpoch: 7,
        backups: [backupB0],
        domain: [{ entityId: "setting", value: { version: 1 } }],
      }),
      completeBackupInventory,
    );
    fixture.expectedOperationRecovery = {
      consumedBindings: [binding],
      terminalOutcomes: [{ binding, disposition: "superseded", receipt }],
    };

    const result = await createNormalRestoreCoordinator({ port: fixture }).restore(confirmation());

    expect(result.operationOutcomes).toEqual([
      {
        binding,
        status: "superseded_by_restore",
        receipt,
        effectCommitments: [
          { entityId: "setting", after: { kind: "present", value: { version: 2 } } },
        ],
      },
    ]);
    expect(fixture.events.indexOf("persist-inactive-candidate")).toBeLessThan(
      fixture.events.indexOf("activate-pointer"),
    );
  });

  it("cannot switch authority when the durable candidate readback differs", async () => {
    const fixture = restoreFixture();
    fixture.corruptCandidateReadback = true;

    await expect(
      createNormalRestoreCoordinator({ port: fixture }).restore(confirmation()),
    ).rejects.toMatchObject({ code: "restore_conflict" });
    expect(fixture.events).not.toContain("activate-pointer");
    expect(fixture.active.authorityGeneration).toBe(60);
  });

  it("refuses a resumed durable candidate bound to a different authority generation", async () => {
    const fixture = restoreFixture();
    const candidate = mergeRestoreState({
      current: structuredClone(fixture.active),
      restored: structuredClone(fixture.backup),
      rescannedBackups: completeBackupInventory,
    });
    fixture.journal = {
      status: "candidate-durable",
      candidate: {
        state: candidate,
        expectedAuthorityGeneration: 59,
        operationRecovery: { consumedBindings: [], terminalOutcomes: [] },
        persistenceToken: "durable-candidate-token",
      },
    };

    await expect(
      createNormalRestoreCoordinator({ port: fixture }).restore(confirmation()),
    ).rejects.toMatchObject({ code: "restore_conflict" });
    expect(fixture.events).not.toContain("activate-pointer");
    expect(fixture.active.authorityGeneration).toBe(60);
  });

  it("rejects an authenticated terminal result that is not bound to the selected inventory", async () => {
    const fixture = restoreFixture();
    fixture.verifyAndDecryptBackup = async () => ({
      state: structuredClone(fixture.backup),
      binding: structuredClone(envelopeBinding),
      authenticatedTerminal: { ...authenticatedTerminal, headerDigest: "f".repeat(64) },
    });

    await expect(
      createNormalRestoreCoordinator({ port: fixture }).restore(confirmation()),
    ).rejects.toMatchObject({ code: "restore_conflict" });
    expect(fixture.events).not.toContain("activate-pointer");
  });

  it("faults at every phase with either the prior authority or one resumable activated authority", async () => {
    const postActivationPoints = new Set<NormalRestoreFailurePoint>([
      "after-authority-switch",
      "after-authority-notify",
      "after-force-hydrate",
    ]);
    for (const failurePoint of NORMAL_RESTORE_FAILURE_POINTS) {
      const fixture = restoreFixture();
      const firstAttempt = createNormalRestoreCoordinator({
        port: fixture,
        failureInjector(point) {
          if (point === failurePoint) throw new Error(`fault:${point}`);
        },
      });

      await expect(firstAttempt.restore(confirmation())).rejects.toMatchObject({
        code: "restore_interrupted",
      });
      if (!postActivationPoints.has(failurePoint)) {
        expect(fixture.active.authorityGeneration).toBe(60);
        expect(fixture.journal).toEqual({ status: "absent" });
        expect(fixture.fenced).toBe(false);
        continue;
      }

      expect(fixture.active.authorityGeneration).toBe(61);
      expect(fixture.journal.status).toBe("activated");
      expect(fixture.fenced).toBe(true);
      const resumed = await createNormalRestoreCoordinator({ port: fixture }).restore(
        confirmation(),
      );
      expect(resumed.authorityGeneration).toBe(61);
      expect(fixture.journal.status).toBe("completed");
      expect(fixture.fenced).toBe(false);
    }
  });

  it.each(["discard", "fence-release"] as const)(
    "journals and resumes a failed abort %s without swallowing the interruption",
    async (failure) => {
      const fixture = restoreFixture();
      if (failure === "discard") fixture.failDiscardOnce = true;
      else fixture.failAbortReleaseOnce = true;
      const coordinator = createNormalRestoreCoordinator({
        port: fixture,
        failureInjector(point) {
          if (point === "after-inactive-stage") throw new Error("restore-fault");
        },
      });

      await expect(coordinator.restore(confirmation())).rejects.toMatchObject({
        code: "restore_interrupted",
      });
      expect(fixture.journal.status).toBe("aborting");
      await expect(
        createNormalRestoreCoordinator({ port: fixture }).restore(confirmation()),
      ).rejects.toMatchObject({ code: "restore_interrupted" });
      expect(fixture.journal).toEqual({ status: "absent" });
      expect(fixture.fenced).toBe(false);
    },
  );

  it("maps an adapter fence failure to a secret-safe restore interruption", async () => {
    const fixture = restoreFixture();
    fixture.failFenceOnce = true;

    await expect(
      createNormalRestoreCoordinator({ port: fixture }).restore(confirmation()),
    ).rejects.toEqual(new NormalRestoreError("restore_interrupted"));
  });

  it.each([
    ["missing", undefined, "confirmation_required"],
    ["mismatched", "invalid", "confirmation_invalid"],
    ["expired", "invalid", "confirmation_invalid"],
    ["stale", "stale", "confirmation_stale"],
    ["reused", "reused", "confirmation_reused"],
  ] as const)(
    "%s confirmation is an exact protected-state no-op",
    async (_caseName, validation, expectedCode) => {
      const fixture = restoreFixture();
      if (validation !== undefined) fixture.validation = validation;
      const before = fixture.protectedState();

      await expect(
        createNormalRestoreCoordinator({ port: fixture }).restore(
          validation === undefined ? undefined : confirmation(),
        ),
      ).rejects.toMatchObject({ code: expectedCode });
      expect(fixture.protectedState()).toEqual(before);
    },
  );

  it("a confirmation stale at atomic consumption restores the exact active state", async () => {
    const fixture = restoreFixture();
    fixture.activation = "confirmation-invalid";
    const beforeActive = structuredClone(fixture.active);

    await expect(
      createNormalRestoreCoordinator({ port: fixture }).restore(confirmation()),
    ).rejects.toMatchObject({ code: "confirmation_stale" });

    expect(fixture.active).toEqual(beforeActive);
    expect(fixture.events).toContain("journal-abort:discard-pending");
    expect(fixture.events.at(-1)).toBe("journal-abort:completed");
  });

  it("reused completed confirmation is rejected before fencing or decrypting", async () => {
    const candidate = state({ authorityGeneration: 61, securityEpoch: 13 });
    const fixture = new RestoreFixture(
      candidate,
      state({ authorityGeneration: 40, securityEpoch: 7 }),
    );
    fixture.journal = { status: "completed", candidate };
    const before = fixture.protectedState();

    await expect(
      createNormalRestoreCoordinator({ port: fixture }).restore(confirmation()),
    ).rejects.toBeInstanceOf(NormalRestoreError);
    expect(fixture.protectedState()).toEqual(before);
    expect(fixture.events).toEqual([]);
  });
});
