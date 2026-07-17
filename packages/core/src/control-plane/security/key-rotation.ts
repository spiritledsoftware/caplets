import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { CapletsError } from "../../errors";
import { stableJsonStringify } from "../../stable-json";
import { fileV1AssociatedData, type FileV1KeyProvider } from "../key-provider/file-v1";
import {
  FILE_V1_PURPOSE_SPECS,
  FILE_V1_RUNTIME_PURPOSES,
  type FileV1Algorithm,
  type FileV1Purpose,
} from "../key-provider/manifest";
import {
  decodeCanonicalJson,
  decodeCanonicalVersion,
  encodeCanonicalJson,
} from "../schema/model-codec";
import type {
  ControlPlaneDatabaseRow,
  ControlPlaneSqlTransaction,
  ControlPlaneTransactionalDialect,
} from "../store";
import { STORAGE_BENCHMARK_ENVELOPE } from "../storage-benchmark-envelope";
import type { ControlPlaneStoreIdentity, ControlPlaneWriterFence } from "../types";

const CANARY_AAD_VERSION = 1;
const CANARY_LABEL_VERSION = 1;
const RETIREMENT_PREVIEW_TTL_MS = 5 * 60_000;

export type KeyInventoryState =
  | "staged"
  | "active"
  | "decrypt-only"
  | "retired"
  | "destruction-intended"
  | "destroyed";

export type KeyInventoryStatus = Readonly<{
  provider: "file-v1";
  keyId: string;
  purpose: FileV1Purpose;
  algorithm: FileV1Algorithm;
  keyVersion: number;
  state: KeyInventoryState;
  verifiedNodeIds: readonly string[];
  purgeWatermark: number;
  activatedAt: string;
  decryptOnlyAt?: string | undefined;
  retiredAt?: string | undefined;
  destroyedAt?: string | undefined;
  destructionId?: string | undefined;
}>;

export type KeyRetirementPreview = Readonly<{
  previewId: string;
  action: "key-retirement";
  logicalHostId: string;
  storeId: string;
  purpose: FileV1Purpose;
  keyVersion: number;
  authorityToken: string;
  minimumPurgeWatermark: number;
  inventoryHash: string;
  affectedVersions: readonly string[];
  expiresAt: string;
  consequences: readonly string[];
}>;

export type KeyRetirementResult =
  | Readonly<{ status: "retired"; inventory: KeyInventoryStatus }>
  | Readonly<{
      status: "refused";
      reason:
        | "active-version"
        | "live-records"
        | "undecryptable-records"
        | "retained-backups"
        | "tombstones"
        | "destruction-receipts"
        | "watermark"
        | "stale-preview"
        | "stale-authority"
        | "expired-preview"
        | "already-retired";
      blockers: readonly string[];
    }>;

type NodeCanaryVerification = Readonly<{
  verified: boolean;
  readiness: "canary-verified" | "denied";
  writerLease: "active" | "revoked";
}>;
type NodeCanaryProof =
  | Readonly<{ nodeId: string }>
  | Readonly<{
      nodeId: string;
      leaseId: string;
      writerEpoch: number;
      authorityGeneration: number;
    }>;

export interface ControlPlaneKeyRotationManager {
  registerActiveVersion(
    input: Readonly<{
      provider: FileV1KeyProvider;
      purpose: (typeof FILE_V1_RUNTIME_PURPOSES)[number];
      securityEpoch?: number | undefined;
      writerFence?: ControlPlaneWriterFence | undefined;
    }>,
  ): Promise<KeyInventoryStatus>;
  verifyNodeCanary(
    input: Readonly<{
      nodeId: string;
      purpose: (typeof FILE_V1_RUNTIME_PURPOSES)[number];
      keyVersion: number;
      provider: FileV1KeyProvider;
      writerFence?: ControlPlaneWriterFence | undefined;
    }>,
  ): Promise<NodeCanaryVerification>;
  activationStatus(
    input: Readonly<{
      purpose: (typeof FILE_V1_RUNTIME_PURPOSES)[number];
      keyVersion: number;
      /** SQLite-only compatibility seam; Postgres always derives the live ready cohort. */
      requiredNodeIds?: readonly string[] | undefined;
    }>,
  ): Promise<
    Readonly<{
      ready: boolean;
      missingNodeIds: readonly string[];
      clusterActivation: "active" | "pending";
    }>
  >;
  activateVersion(
    input: Readonly<{
      purpose: (typeof FILE_V1_RUNTIME_PURPOSES)[number];
      keyVersion: number;
      securityEpoch?: number | undefined;
      writerFence?: ControlPlaneWriterFence | undefined;
    }>,
  ): Promise<KeyInventoryStatus>;
  listInventory(): Promise<readonly KeyInventoryStatus[]>;
  advancePurgeWatermark(
    input: Readonly<{
      purpose: FileV1Purpose;
      keyVersion: number;
      watermark: number;
    }>,
  ): Promise<number>;
  recordRetainedBackup(
    input: Readonly<{
      backupId: string;
      providerIdentity: string;
      sourceIdentity: string;
      sourceProfile: string;
      manifestHash: string;
      purpose: FileV1Purpose;
      algorithm: FileV1Algorithm;
      keyVersion: number;
      unwrapIdentity: string;
      retentionUntil: string;
    }>,
  ): Promise<void>;
  recordBackupDestruction(
    input: Readonly<{
      backupId: string;
      destructionId: string;
    }>,
  ): Promise<void>;
  previewRetirement(
    input: Readonly<{
      purpose: FileV1Purpose;
      keyVersion: number;
      authorityToken: string;
      securityEpoch?: number | undefined;
      writerFence?: ControlPlaneWriterFence | undefined;
      minimumPurgeWatermark: number;
    }>,
  ): Promise<KeyRetirementPreview>;
  retireVersion(
    input: Readonly<{
      preview: KeyRetirementPreview;
      authorityToken: string;
      securityEpoch?: number | undefined;
      writerFence?: ControlPlaneWriterFence | undefined;
    }>,
  ): Promise<KeyRetirementResult>;
  markDestructionIntended(
    input: Readonly<{
      purpose: FileV1Purpose;
      keyVersion: number;
      destructionId: string;
    }>,
  ): Promise<KeyInventoryStatus>;
  markDestroyed(
    input: Readonly<{
      purpose: FileV1Purpose;
      keyVersion: number;
      destructionId: string;
    }>,
  ): Promise<KeyInventoryStatus>;
}

export function createControlPlaneKeyRotationManager(
  options: Readonly<{
    identity: ControlPlaneStoreIdentity;
    dialect: ControlPlaneTransactionalDialect;
  }>,
): ControlPlaneKeyRotationManager {
  const { identity, dialect } = options;
  const providers = new Map<FileV1Purpose, FileV1KeyProvider>();

  const manager: ControlPlaneKeyRotationManager = {
    async registerActiveVersion(input) {
      const entry = activeManifestEntry(input.provider, identity, input.purpose);
      const status = await dialect.runtimeTransaction(async (transaction) => {
        const now = await transaction.databaseTime();
        await transaction.lock(`key-rotation:${input.purpose}`);
        const rows = await inventoryRows(transaction, identity, input.purpose);
        await assertProviderOverlap(transaction, identity, input.purpose, rows, input.provider);
        const existing = rows.find((row) => row.keyVersion === entry.keyVersion);
        if (existing && existing.state !== "active" && existing.state !== "staged") {
          throw new CapletsError(
            "REQUEST_INVALID",
            "Only an active or staged key version may be registered.",
          );
        }
        if (existing) {
          if (
            existing.keyId !== entry.keyId ||
            existing.algorithm !== entry.algorithm ||
            existing.provider !== "file-v1"
          ) {
            throw new CapletsError(
              "AUTH_FAILED",
              "Key inventory metadata conflicts with the resolved file-v1 version.",
            );
          }
          return inventoryStatus(existing);
        }
        const highest = Math.max(0, ...rows.map((row) => row.keyVersion));
        if (entry.keyVersion <= highest) {
          throw new CapletsError("REQUEST_INVALID", "Key versions must advance monotonically.");
        }
        if (rows.some((row) => row.state === "staged")) {
          throw new CapletsError(
            "REQUEST_INVALID",
            "A staged key version must be activated or aborted before staging another version.",
          );
        }
        const stageForCluster =
          dialect.backend === "postgres" && rows.some((row) => row.state === "active");
        if (stageForCluster) {
          await assertKeyMaintenanceFence(
            transaction,
            identity,
            input.securityEpoch,
            input.writerFence,
          );
        }
        if (!stageForCluster) {
          for (const row of rows) {
            if (row.state !== "active") continue;
            await transaction.update(
              "keyInventory",
              { state: "decrypt-only", decryptOnlyAt: now, updatedAt: now },
              scope(identity, {
                purpose: input.purpose,
                keyVersion: row.keyVersion,
                state: "active",
              }),
            );
          }
        }
        const inventoryId = keyInventoryId(input.purpose, entry.keyVersion);
        await transaction.insert("keyInventory", {
          ...baseRow(identity, inventoryId, now),
          provider: "file-v1",
          keyId: entry.keyId,
          purpose: input.purpose,
          algorithm: entry.algorithm,
          keyVersion: entry.keyVersion,
          state: stageForCluster ? "staged" : "active",
          verifiedNodeIds: encodeCanonicalJson([]),
          purgeWatermark: 0,
          activatedAt: now,
          decryptOnlyAt: null,
          retiredAt: null,
          destroyedAt: null,
          destructionId: null,
        });
        const canary = createCanary(
          identity,
          input.provider,
          input.purpose,
          entry.keyVersion,
          entry.keyId,
        );
        await transaction.insert("keyCanaries", {
          ...baseRow(identity, keyCanaryId(input.purpose, entry.keyVersion), now),
          purpose: input.purpose,
          algorithm: entry.algorithm,
          keyVersion: entry.keyVersion,
          protection: canary.protection,
          labelHash: canary.labelHash,
          aadVersion: CANARY_AAD_VERSION,
          nonce: canary.nonce,
          ciphertext: canary.ciphertext,
          authTag: canary.authTag,
          verifier: canary.verifier,
          state: stageForCluster ? "staged" : "active",
        });
        const [created] = await inventoryRows(
          transaction,
          identity,
          input.purpose,
          entry.keyVersion,
        );
        if (!created) throw new Error("Key inventory insert was not observable");
        return inventoryStatus(created);
      });
      providers.set(input.purpose, input.provider);
      return status;
    },

    async verifyNodeCanary(input) {
      const nodeId = requiredNodeId(input.nodeId);
      const providerEligible =
        providerMatchesIdentity(input.provider, identity) &&
        input.provider.hasCapability(
          input.purpose,
          FILE_V1_PURPOSE_SPECS[input.purpose].algorithm === "AES-256-GCM" ? "decrypt" : "verify",
        );
      const manifestEntry = providerEligible
        ? input.provider.manifest.entries.find(
            (entry) =>
              entry.purpose === input.purpose &&
              entry.keyVersion === input.keyVersion &&
              entry.algorithm === FILE_V1_PURPOSE_SPECS[input.purpose].algorithm,
          )
        : undefined;
      const verified = await dialect.runtimeTransaction(async (transaction) => {
        await transaction.lock(`key-rotation:${input.purpose}`);
        await transaction.lock(nodeAdmissionLock(identity));
        const now = await transaction.databaseTime();
        const [inventory] = await inventoryRows(
          transaction,
          identity,
          input.purpose,
          input.keyVersion,
        );
        const [canary] = await transaction.select<KeyCanaryRow>(
          "keyCanaries",
          scope(identity, {
            purpose: input.purpose,
            keyVersion: input.keyVersion,
          }),
        );
        const currentAuthorityGeneration =
          dialect.backend === "postgres"
            ? await readCurrentAuthorityGeneration(transaction, identity)
            : undefined;
        const verifiedFenceState =
          dialect.backend === "postgres" &&
          input.writerFence !== undefined &&
          input.writerFence.authorityGeneration === currentAuthorityGeneration
            ? await writerFenceState(transaction, identity, nodeId, input.writerFence, now, true)
            : undefined;
        const leaseActive = dialect.backend === "sqlite" || verifiedFenceState !== undefined;
        const valid =
          manifestEntry !== undefined &&
          inventory?.keyId === manifestEntry.keyId &&
          (inventory.state === "active" || inventory.state === "staged") &&
          canary !== undefined &&
          canary.state === inventory.state &&
          leaseActive &&
          verifyCanary(identity, input.provider, inventory, canary);
        const proofs = new Map(
          (inventory ? parseNodeCanaryProofs(inventory.verifiedNodeIds) : []).map((proof) => [
            proof.nodeId,
            proof,
          ]),
        );
        if (valid) {
          proofs.set(
            nodeId,
            dialect.backend === "postgres"
              ? {
                  nodeId,
                  leaseId: input.writerFence!.leaseId,
                  writerEpoch: input.writerFence!.writerEpoch,
                  authorityGeneration: input.writerFence!.authorityGeneration,
                }
              : { nodeId },
          );
        } else {
          proofs.delete(nodeId);
          if (dialect.backend === "sqlite" || input.writerFence) {
            await revokeNodeAndWriterFence(transaction, identity, nodeId, now, input.writerFence);
          }
        }
        if (inventory && (inventory.state === "active" || inventory.state === "staged")) {
          await transaction.update(
            "keyInventory",
            {
              verifiedNodeIds: encodeNodeCanaryProofs([...proofs.values()]),
              updatedAt: now,
            },
            scope(identity, {
              purpose: input.purpose,
              keyVersion: input.keyVersion,
              state: inventory.state,
            }),
          );
        }
        if (
          valid &&
          dialect.backend === "postgres" &&
          input.writerFence &&
          verifiedFenceState &&
          !(await guardWriterFenceForCommit(
            transaction,
            identity,
            nodeId,
            input.writerFence,
            verifiedFenceState,
          ))
        ) {
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            "The key canary verification lost its writer lease before commit.",
          );
        }
        return valid;
      });
      return verified
        ? { verified: true, readiness: "canary-verified", writerLease: "active" }
        : deniedCanaryVerification();
    },

    async activationStatus(input) {
      return dialect.snapshotTransaction(async (transaction) => {
        const [inventory] = await inventoryRows(
          transaction,
          identity,
          input.purpose,
          input.keyVersion,
        );
        const proofs =
          inventory && (inventory.state === "active" || inventory.state === "staged")
            ? parseNodeCanaryProofs(inventory.verifiedNodeIds)
            : [];
        const required =
          dialect.backend === "postgres"
            ? await liveReadyNodeIds(transaction, identity)
            : [...new Set((input.requiredNodeIds ?? []).map(requiredNodeId))].toSorted();
        const missingNodeIds =
          dialect.backend === "postgres"
            ? await missingLiveReadyProofNodeIds(transaction, identity, required, proofs)
            : required.filter((nodeId) => !proofs.some((proof) => proof.nodeId === nodeId));
        const ready =
          Boolean(inventory) &&
          missingNodeIds.length === 0 &&
          (dialect.backend === "sqlite" || required.length > 0);
        return {
          ready,
          missingNodeIds,
          clusterActivation: inventory?.state === "active" ? "active" : "pending",
        };
      });
    },

    async activateVersion(input) {
      return dialect.runtimeTransaction(async (transaction) => {
        await transaction.lock(`key-rotation:${input.purpose}`);
        await transaction.lock(authorityGenerationLock(identity));
        await transaction.lock(securityEpochLock(identity));
        await transaction.lock(nodeAdmissionLock(identity));
        const [inventory] = await inventoryRows(
          transaction,
          identity,
          input.purpose,
          input.keyVersion,
        );
        if (!inventory) {
          throw new CapletsError("CONFIG_INVALID", "Key inventory version is missing.");
        }
        if (inventory.state === "active") return inventoryStatus(inventory);
        if (inventory.state !== "staged") {
          throw new CapletsError("REQUEST_INVALID", "Key inventory version is not staged.");
        }
        const activeVersion = Math.max(
          0,
          ...(await inventoryRows(transaction, identity, input.purpose))
            .filter((row) => row.state === "active")
            .map((row) => row.keyVersion),
        );
        if (input.keyVersion <= activeVersion) {
          throw new CapletsError(
            "REQUEST_INVALID",
            "Key activation cannot move the active version backward.",
          );
        }
        const activationNodeId = input.writerFence?.leaseId.startsWith("writer:")
          ? input.writerFence.leaseId.slice("writer:".length)
          : undefined;
        const activationAuthorityGeneration =
          dialect.backend === "postgres"
            ? await readCurrentAuthorityGeneration(transaction, identity)
            : undefined;
        const [security] = await transaction.select<SecurityEpochRow>(
          "securityVersions",
          scope(identity),
          [{ column: "epoch", direction: "desc" }],
          1,
        );
        const currentSecurityEpoch = security ? decodeCanonicalVersion(security.epoch) : 0;
        if (
          dialect.backend === "postgres" &&
          (input.writerFence === undefined ||
            input.securityEpoch === undefined ||
            input.securityEpoch !== currentSecurityEpoch ||
            activationNodeId === undefined ||
            activationNodeId.length === 0 ||
            input.writerFence.authorityGeneration !== activationAuthorityGeneration ||
            !(await writerFenceIsLive(
              transaction,
              identity,
              activationNodeId,
              input.writerFence,
              await transaction.databaseTime(),
            )))
        ) {
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            "Key activation requires a live ready-node writer fence.",
          );
        }
        const required = await liveReadyNodeIds(transaction, identity);
        const proofs = parseNodeCanaryProofs(inventory.verifiedNodeIds);
        const finalRequired = await liveReadyNodeIds(transaction, identity);
        const cohortChanged =
          required.length !== finalRequired.length ||
          required.some((nodeId, index) => nodeId !== finalRequired[index]);
        const finalMissingNodeIds = await missingLiveReadyProofNodeIds(
          transaction,
          identity,
          finalRequired,
          proofs,
        );
        if (required.length === 0 || cohortChanged || finalMissingNodeIds.length > 0) {
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            "Every ready node must verify the staged key with its current writer lease before activation.",
          );
        }
        const now = await transaction.databaseTime();
        await transaction.update(
          "keyInventory",
          { state: "decrypt-only", decryptOnlyAt: now, updatedAt: now },
          scope(identity, { purpose: input.purpose, state: "active" }),
        );
        const changed = await transaction.update(
          "keyInventory",
          { state: "active", activatedAt: now, updatedAt: now },
          scope(identity, {
            purpose: input.purpose,
            keyVersion: input.keyVersion,
            state: "staged",
          }),
        );
        if (changed !== 1) throw new Error("Staged key activation changed concurrently");
        await transaction.update(
          "keyCanaries",
          { state: "active", updatedAt: now },
          scope(identity, {
            purpose: input.purpose,
            keyVersion: input.keyVersion,
            state: "staged",
          }),
        );
        const epoch = currentSecurityEpoch + 1;
        await transaction.insert("securityVersions", {
          ...baseRow(identity, `key-activation:${input.purpose}:${input.keyVersion}`, now),
          securityVersion: epoch,
          epoch,
          minimumKeyVersion: input.keyVersion,
          revocationWatermark: security ? decodeCanonicalVersion(security.revocationWatermark) : 0,
          advancedAt: now,
        });
        if (dialect.backend === "postgres") {
          if (!input.writerFence || activationNodeId === undefined) {
            throw new CapletsError(
              "SERVER_UNAVAILABLE",
              "Key activation requires a live ready-node writer fence.",
            );
          }
          const advanced = await transaction.advanceSnapshotEnvelope({
            logicalHostId: identity.logicalHostId,
            storeId: identity.storeId,
            envelopeId: "control-plane",
            capletDelta: 0,
            normalizedRowDelta: 0,
            encodedByteDelta: 0,
            maxCaplets: STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets,
            maxNormalizedRows: STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows,
            maxEncodedBytes: STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes,
            expectedAuthorityGeneration: activationAuthorityGeneration!,
            expectedSecurityEpoch: epoch,
            leaseId: input.writerFence.leaseId,
            writerEpoch: input.writerFence.writerEpoch,
            fenceAuthorityGeneration: input.writerFence.authorityGeneration,
            fenceState: "active",
          });
          if (advanced !== 1) {
            throw new CapletsError(
              "SERVER_UNAVAILABLE",
              "Key activation lost its writer fence before commit.",
            );
          }
        } else {
          const advanced = await transaction.update(
            "snapshotEnvelopes",
            { securityVersion: epoch, updatedAt: now },
            scope(identity, { envelopeId: "control-plane" }),
          );
          if (advanced !== 1) throw new Error("Key activation snapshot envelope is missing");
        }
        return inventoryStatus({
          ...inventory,
          state: "active",
          activatedAt: now,
          updatedAt: now,
        });
      });
    },

    async listInventory() {
      return dialect.snapshotTransaction(async (transaction) =>
        (
          await transaction.select<KeyInventoryRow>("keyInventory", scope(identity), [
            { column: "purpose" },
            { column: "keyVersion" },
          ])
        ).map(inventoryStatus),
      );
    },

    async advancePurgeWatermark(input) {
      if (!Number.isSafeInteger(input.watermark) || input.watermark < 0) {
        throw new CapletsError("REQUEST_INVALID", "Key purge watermark is invalid.");
      }
      return dialect.runtimeTransaction(async (transaction) => {
        await transaction.lock(`key-watermark:${input.purpose}:${input.keyVersion}`);
        const [row] = await inventoryRows(transaction, identity, input.purpose, input.keyVersion);
        if (!row) throw new CapletsError("CONFIG_INVALID", "Key inventory version is missing.");
        if (input.watermark < row.purgeWatermark) {
          throw new CapletsError("REQUEST_INVALID", "Key purge watermark cannot regress.");
        }
        await transaction.update(
          "keyInventory",
          { purgeWatermark: input.watermark, updatedAt: await transaction.databaseTime() },
          scope(identity, { purpose: input.purpose, keyVersion: input.keyVersion }),
        );
        return input.watermark;
      });
    },

    async recordRetainedBackup(input) {
      if (input.algorithm !== FILE_V1_PURPOSE_SPECS[input.purpose].algorithm) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Backup key algorithm does not match its purpose.",
        );
      }
      await dialect.runtimeTransaction(async (transaction) => {
        await transaction.lock(`key-retirement:${input.purpose}:${input.keyVersion}`);
        const [inventory] = await inventoryRows(
          transaction,
          identity,
          input.purpose,
          input.keyVersion,
        );
        if (!inventory || inventory.state === "retired" || inventory.state === "destroyed") {
          throw new CapletsError(
            "REQUEST_INVALID",
            "Retained backup references an unavailable key version.",
          );
        }
        const now = await transaction.databaseTime();
        await transaction.insert("backups", {
          ...baseRow(identity, `backup:${input.backupId}`, now),
          backupId: input.backupId,
          providerIdentity: input.providerIdentity,
          sourceIdentity: input.sourceIdentity,
          sourceProfile: input.sourceProfile,
          manifestHash: input.manifestHash,
          keyVersion: input.keyVersion,
          keyPurpose: input.purpose,
          keyAlgorithm: input.algorithm,
          unwrapIdentity: input.unwrapIdentity,
          retentionUntil: input.retentionUntil,
          state: "retained",
          destroyedAt: null,
          destructionId: null,
        });
      });
    },

    async recordBackupDestruction(input) {
      await dialect.runtimeTransaction(async (transaction) => {
        const now = await transaction.databaseTime();
        const [destruction] = await transaction.select<ExternalDestructionRow>(
          "externalDestructions",
          scope(identity, { destructionId: input.destructionId, phase: "completed" }),
        );
        if (!destruction?.receipt || !destructionCovers(destruction, "bytes", input.backupId)) {
          throw new CapletsError(
            "REQUEST_INVALID",
            "Backup destruction requires a completed receipt bound to that backup.",
          );
        }
        const changed = await transaction.update(
          "backups",
          {
            state: "destroyed",
            destroyedAt: now,
            destructionId: input.destructionId,
            updatedAt: now,
          },
          scope(identity, { backupId: input.backupId, destroyedAt: null }),
        );
        if (changed !== 1) {
          throw new CapletsError("CONFIG_INVALID", "Retained backup inventory is missing.");
        }
      });
    },

    async previewRetirement(input) {
      if (!Number.isSafeInteger(input.minimumPurgeWatermark) || input.minimumPurgeWatermark < 0) {
        throw new CapletsError("REQUEST_INVALID", "Retirement watermark is invalid.");
      }
      return dialect.runtimeTransaction(async (transaction) => {
        await transaction.lock(`key-retirement:${input.purpose}:${input.keyVersion}`);
        await transaction.lock(authorityGenerationLock(identity));
        const currentAuthorityToken = await readCurrentAuthorityToken(transaction, identity);
        if (currentAuthorityToken !== input.authorityToken) {
          throw new CapletsError("AUTH_FAILED", "Key retirement authority is stale.");
        }
        const now = await transaction.databaseTime();
        const inventory = await retirementInventory(
          transaction,
          identity,
          input.purpose,
          input.keyVersion,
          providers.get(input.purpose),
        );
        const preview: KeyRetirementPreview = {
          previewId: `key-retirement_${randomBytes(18).toString("base64url")}`,
          action: "key-retirement",
          logicalHostId: identity.logicalHostId,
          storeId: identity.storeId,
          purpose: input.purpose,
          keyVersion: input.keyVersion,
          authorityToken: input.authorityToken,
          minimumPurgeWatermark: input.minimumPurgeWatermark,
          inventoryHash: hashRetirementInventory(inventory),
          affectedVersions: [
            `${input.purpose}:${input.keyVersion}`,
            ...inventory.backups.map((row) => `backup:${row.backupId}`),
          ].toSorted(),
          expiresAt: new Date(Date.parse(now) + RETIREMENT_PREVIEW_TTL_MS).toISOString(),
          consequences: [
            "The selected key version will no longer decrypt live records.",
            "Provider material remains external until destruction is separately receipted.",
          ],
        };
        await assertKeyMaintenanceFence(
          transaction,
          identity,
          input.securityEpoch,
          input.writerFence,
        );
        await transaction.insert("confirmations", {
          ...baseRow(identity, `confirmation:${preview.previewId}`, now),
          confirmationId: preview.previewId,
          action: preview.action,
          authorityToken: hashAuthorityToken(identity, input.authorityToken),
          inventoryHash: preview.inventoryHash,
          affectedInventory: encodeCanonicalJson(retirementConfirmation(preview)),
          expiresAt: preview.expiresAt,
          consequences: encodeCanonicalJson(preview.consequences),
          state: "previewed",
          consumedAt: null,
        });
        return preview;
      });
    },

    async retireVersion(input) {
      const preview = input.preview;
      if (
        preview.logicalHostId !== identity.logicalHostId ||
        preview.storeId !== identity.storeId ||
        preview.action !== "key-retirement"
      ) {
        return refused("stale-preview", ["preview-target"]);
      }
      return dialect.runtimeTransaction(async (transaction) => {
        const now = await transaction.databaseTime();
        await transaction.lock(`key-retirement:${preview.purpose}:${preview.keyVersion}`);
        await transaction.lock(`confirmation:${preview.previewId}`);
        await transaction.lock(authorityGenerationLock(identity));
        await transaction.lock(securityEpochLock(identity));
        await transaction.lock(nodeAdmissionLock(identity));
        const [confirmation] = await transaction.select<ConfirmationRow>(
          "confirmations",
          scope(identity, { confirmationId: preview.previewId }),
        );
        if (
          !confirmation ||
          confirmation.action !== "key-retirement" ||
          confirmation.state !== "previewed" ||
          confirmation.consumedAt
        ) {
          return refused("stale-preview", ["confirmation-consumed-or-missing"]);
        }
        const stored = decodeRetirementConfirmation(confirmation.affectedInventory);
        if (
          stored.logicalHostId !== identity.logicalHostId ||
          stored.storeId !== identity.storeId ||
          stored.purpose !== preview.purpose ||
          stored.keyVersion !== preview.keyVersion ||
          stored.minimumPurgeWatermark !== preview.minimumPurgeWatermark ||
          confirmation.inventoryHash !== preview.inventoryHash ||
          confirmation.expiresAt !== preview.expiresAt ||
          !sameStrings(stored.affectedVersions, preview.affectedVersions)
        ) {
          return refused("stale-preview", ["confirmation-mismatch"]);
        }
        if (Date.parse(confirmation.expiresAt) <= Date.parse(now)) {
          return refused("expired-preview", ["preview-expired"]);
        }
        const retirementNodeId = input.writerFence?.leaseId.startsWith("writer:")
          ? input.writerFence.leaseId.slice("writer:".length)
          : undefined;
        if (dialect.backend === "postgres") {
          const [security] = await transaction.select<SecurityEpochRow>(
            "securityVersions",
            scope(identity),
            [{ column: "epoch", direction: "desc" }],
            1,
          );
          if (
            input.writerFence === undefined ||
            retirementNodeId === undefined ||
            retirementNodeId.length === 0 ||
            input.securityEpoch === undefined ||
            !security ||
            decodeCanonicalVersion(security.epoch) !== input.securityEpoch ||
            input.writerFence.authorityGeneration !==
              (await readCurrentAuthorityGeneration(transaction, identity)) ||
            !(await writerFenceIsLive(
              transaction,
              identity,
              retirementNodeId,
              input.writerFence,
              now,
            ))
          ) {
            return refused("stale-authority", ["security-epoch", "writer-fence"]);
          }
        }
        const currentAuthorityToken = await readCurrentAuthorityToken(transaction, identity);
        if (
          !authorityHashMatches(confirmation.authorityToken, identity, input.authorityToken) ||
          !authorityHashMatches(confirmation.authorityToken, identity, currentAuthorityToken)
        ) {
          if (dialect.backend === "sqlite") {
            await transaction.update(
              "confirmations",
              { state: "invalidated", consumedAt: now, updatedAt: now },
              scope(identity, {
                confirmationId: preview.previewId,
                state: "previewed",
                consumedAt: null,
              }),
            );
          }
          return refused("stale-authority", ["authority-token"]);
        }
        const consumed = await transaction.update(
          "confirmations",
          { state: "consumed", consumedAt: now, updatedAt: now },
          scope(identity, {
            confirmationId: preview.previewId,
            state: "previewed",
            consumedAt: null,
          }),
        );
        if (consumed !== 1) {
          return refused("stale-preview", ["confirmation-consumed"]);
        }
        const current = await retirementInventory(
          transaction,
          identity,
          stored.purpose,
          stored.keyVersion,
          providers.get(stored.purpose),
        );
        if (hashRetirementInventory(current) !== confirmation.inventoryHash) {
          return refused("stale-preview", ["inventory-changed"]);
        }
        const target = current.inventory;
        if (!target || target.state === "retired" || target.state === "destroyed") {
          return refused("already-retired", ["inventory-state"]);
        }
        if (target.state !== "decrypt-only") {
          return refused("active-version", [`${stored.purpose}:${stored.keyVersion}`]);
        }
        if (target.purgeWatermark < stored.minimumPurgeWatermark) {
          return refused("watermark", [`watermark:${target.purgeWatermark}`]);
        }
        if (current.liveRecordIds.length > 0) {
          return refused("live-records", current.liveRecordIds);
        }
        if (current.undecryptableRecordIds.length > 0) {
          return refused("undecryptable-records", current.undecryptableRecordIds);
        }
        const retained = current.backups.filter(
          (backup) =>
            backup.state !== "destroyed" && Date.parse(backup.retentionUntil) > Date.parse(now),
        );
        if (retained.length > 0) {
          return refused(
            "retained-backups",
            retained.map((backup) => backup.backupId),
          );
        }
        const invalidReceipts = current.backups.filter(
          (backup) =>
            backup.state === "destroyed" &&
            (!backup.destructionId ||
              !current.completedDestructions.some(
                (destruction) =>
                  destruction.destructionId === backup.destructionId &&
                  Boolean(destruction.receipt) &&
                  destructionCovers(destruction, "bytes", backup.backupId),
              )),
        );
        if (invalidReceipts.length > 0) {
          return refused(
            "destruction-receipts",
            invalidReceipts.map((backup) => backup.backupId),
          );
        }
        if (current.tombstoneIds.length > 0) {
          return refused("tombstones", current.tombstoneIds);
        }
        const retiredAt = now;
        const changed = await transaction.update(
          "keyInventory",
          { state: "retired", retiredAt, updatedAt: retiredAt },
          scope(identity, {
            purpose: stored.purpose,
            keyVersion: stored.keyVersion,
            state: "decrypt-only",
          }),
        );
        if (changed !== 1) {
          return refused("already-retired", ["inventory-state"]);
        }
        if (
          dialect.backend === "postgres" &&
          (input.writerFence === undefined ||
            retirementNodeId === undefined ||
            !(await guardWriterFenceForCommit(
              transaction,
              identity,
              retirementNodeId,
              input.writerFence,
            )))
        ) {
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            "Key retirement lost its exact writer fence before commit.",
          );
        }
        return {
          status: "retired",
          inventory: inventoryStatus({
            ...target,
            state: "retired",
            retiredAt,
            updatedAt: retiredAt,
          }),
        } as const;
      });
    },

    async markDestructionIntended(input) {
      return updateDestructionState(dialect, identity, input, "retired", "destruction-intended");
    },

    async markDestroyed(input) {
      return dialect.runtimeTransaction(async (transaction) => {
        await transaction.lock(`key-destruction:${input.purpose}:${input.keyVersion}`);
        const [inventory] = await inventoryRows(
          transaction,
          identity,
          input.purpose,
          input.keyVersion,
        );
        const [receipt] = await transaction.select<ExternalDestructionRow>(
          "externalDestructions",
          scope(identity, { destructionId: input.destructionId, phase: "completed" }),
        );
        if (
          !inventory ||
          !receipt?.receipt ||
          !destructionCovers(receipt, "key", inventory.keyId)
        ) {
          throw new CapletsError(
            "REQUEST_INVALID",
            "Key destruction requires a completed receipt bound to that key.",
          );
        }
        const now = await transaction.databaseTime();
        const changed = await transaction.update(
          "keyInventory",
          { state: "destroyed", destroyedAt: now, updatedAt: now },
          scope(identity, {
            purpose: input.purpose,
            keyVersion: input.keyVersion,
            state: "destruction-intended",
            destructionId: input.destructionId,
          }),
        );
        if (changed !== 1) {
          throw new CapletsError(
            "REQUEST_INVALID",
            "Key destruction state transition was refused.",
          );
        }
        const [row] = await inventoryRows(transaction, identity, input.purpose, input.keyVersion);
        if (!row) throw new Error("Destroyed key inventory disappeared");
        return inventoryStatus(row);
      });
    },
  };
  return Object.freeze(manager);
}

type KeyInventoryRow = ControlPlaneDatabaseRow & {
  provider: "file-v1";
  keyId: string;
  purpose: FileV1Purpose;
  algorithm: FileV1Algorithm;
  keyVersion: number;
  state: KeyInventoryState;
  verifiedNodeIds: string;
  purgeWatermark: number;
  activatedAt: string;
  decryptOnlyAt: string | null;
  retiredAt: string | null;
  destroyedAt: string | null;
  destructionId: string | null;
};
type KeyCanaryRow = ControlPlaneDatabaseRow & {
  purpose: FileV1Purpose;
  algorithm: FileV1Algorithm;
  keyVersion: number;
  protection: "aead" | "hmac";
  labelHash: string;
  aadVersion: number;
  nonce: Buffer | null;
  ciphertext: Buffer | null;
  authTag: Buffer | null;
  verifier: Buffer | null;
  state: "active" | "staged";
};
type BackupRow = ControlPlaneDatabaseRow & {
  backupId: string;
  keyVersion: number;
  keyPurpose: FileV1Purpose;
  retentionUntil: string;
  state: string;
  destroyedAt: string | null;
  destructionId: string | null;
};
type ExternalDestructionRow = ControlPlaneDatabaseRow & {
  destructionId: string;
  phase: string;
  intent: unknown;
  receipt: unknown;
};
type ConfirmationRow = ControlPlaneDatabaseRow & {
  confirmationId: string;
  action: string;
  authorityToken: string;
  inventoryHash: string;
  affectedInventory: unknown;
  expiresAt: string;
  state: string;
  consumedAt: string | null;
};
type RetentionRow = ControlPlaneDatabaseRow & {
  retentionId: string;
  resourceKind: string;
  resourceId: string;
  destroyedAt: string | null;
};
type GenerationRow = ControlPlaneDatabaseRow & { generation: number | bigint };
type ClusterNodeRow = ControlPlaneDatabaseRow & {
  nodeId: string;
  state: string;
  expiresAt: string;
};
type WriterFenceRow = ControlPlaneDatabaseRow & {
  leaseId: string;
  writerEpoch: number | bigint;
  authorityGeneration: number | bigint;
  state: string;
  expiresAt: string;
};
type SecurityEpochRow = ControlPlaneDatabaseRow & {
  epoch: number | bigint;
  revocationWatermark: number | bigint;
};

type RetirementConfirmation = Readonly<{
  logicalHostId: string;
  storeId: string;
  purpose: FileV1Purpose;
  keyVersion: number;
  minimumPurgeWatermark: number;
  affectedVersions: readonly string[];
}>;

type RetirementInventory = Readonly<{
  inventory: KeyInventoryRow | undefined;
  liveRecordIds: readonly string[];
  undecryptableRecordIds: readonly string[];
  backups: readonly BackupRow[];
  tombstoneIds: readonly string[];
  completedDestructions: readonly ExternalDestructionRow[];
}>;

async function assertProviderOverlap(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  purpose: FileV1Purpose,
  inventory: readonly KeyInventoryRow[],
  provider: FileV1KeyProvider,
): Promise<void> {
  const requiredOperation =
    FILE_V1_PURPOSE_SPECS[purpose].algorithm === "AES-256-GCM" ? "decrypt" : "verify";
  if (!provider.hasCapability(purpose, requiredOperation)) {
    throw new CapletsError("AUTH_FAILED", "Key provider lacks decrypt-only overlap capability.");
  }
  for (const row of inventory) {
    if (row.state !== "active" && row.state !== "staged" && row.state !== "decrypt-only") {
      continue;
    }
    const manifestEntry = provider.manifest.entries.find(
      (entry) =>
        entry.purpose === purpose &&
        entry.algorithm === row.algorithm &&
        entry.keyVersion === row.keyVersion &&
        entry.keyId === row.keyId,
    );
    const [canary] = await transaction.select<KeyCanaryRow>(
      "keyCanaries",
      scope(identity, { purpose, keyVersion: row.keyVersion }),
    );
    if (!manifestEntry || !canary || !verifyCanary(identity, provider, row, canary)) {
      throw new CapletsError(
        "AUTH_FAILED",
        "Key provider cannot verify every active and decrypt-only version.",
      );
    }
  }
}

function activeManifestEntry(
  provider: FileV1KeyProvider,
  identity: ControlPlaneStoreIdentity,
  purpose: (typeof FILE_V1_RUNTIME_PURPOSES)[number],
) {
  if (!providerMatchesIdentity(provider, identity)) {
    throw new CapletsError("AUTH_FAILED", "Key provider identity does not match this SQL store.");
  }
  if (provider.manifest.profile !== "online") {
    throw new CapletsError("AUTH_FAILED", "Key rotation requires the online file-v1 profile.");
  }
  const entry = provider.manifest.entries
    .filter((candidate) => candidate.purpose === purpose)
    .toSorted((left, right) => right.keyVersion - left.keyVersion)[0];
  if (!entry) throw new CapletsError("AUTH_FAILED", "Active file-v1 key version is missing.");
  const requiredOperation =
    entry.algorithm === "AES-256-GCM" ? ("encrypt" as const) : ("compute" as const);
  if (!provider.hasCapability(purpose, requiredOperation)) {
    throw new CapletsError("AUTH_FAILED", "Active file-v1 purpose capability is unavailable.");
  }
  return entry;
}

function providerMatchesIdentity(
  provider: FileV1KeyProvider,
  identity: ControlPlaneStoreIdentity,
): boolean {
  return (
    provider.manifest.provider === "file-v1" &&
    provider.manifest.logicalHostId === identity.logicalHostId &&
    provider.manifest.storeId === identity.storeId
  );
}

function createCanary(
  identity: ControlPlaneStoreIdentity,
  provider: FileV1KeyProvider,
  purpose: (typeof FILE_V1_RUNTIME_PURPOSES)[number],
  keyVersion: number,
  keyId: string,
) {
  const label = canaryLabel(identity, purpose, keyVersion, keyId);
  const labelHash = createHash("sha256").update(label).digest("hex");
  const associatedData = fileV1AssociatedData({
    logicalHostId: identity.logicalHostId,
    storeId: identity.storeId,
    purpose,
    recordId: `node-canary:${purpose}:${keyVersion}`,
    context: { labelVersion: CANARY_LABEL_VERSION },
  });
  if (FILE_V1_PURPOSE_SPECS[purpose].algorithm === "AES-256-GCM") {
    const nonce = randomBytes(12);
    const protectedLabel = provider.encrypt(purpose, label, nonce, associatedData);
    if (protectedLabel.keyVersion !== keyVersion) {
      throw new CapletsError("AUTH_FAILED", "Canary did not use the selected active key version.");
    }
    return {
      protection: "aead" as const,
      labelHash,
      nonce,
      ciphertext: protectedLabel.ciphertext,
      authTag: protectedLabel.authenticationTag,
      verifier: null,
    };
  }
  const verifier = provider.compute(
    purpose,
    Buffer.concat([associatedData, Buffer.from([0]), label]),
  );
  if (verifier.keyVersion !== keyVersion) {
    throw new CapletsError("AUTH_FAILED", "Canary did not use the selected active key version.");
  }
  return {
    protection: "hmac" as const,
    labelHash,
    nonce: null,
    ciphertext: null,
    authTag: null,
    verifier: verifier.bytes,
  };
}

function verifyCanary(
  identity: ControlPlaneStoreIdentity,
  provider: FileV1KeyProvider,
  inventory: KeyInventoryRow,
  canary: KeyCanaryRow,
): boolean {
  if (
    canary.purpose !== inventory.purpose ||
    canary.algorithm !== inventory.algorithm ||
    canary.keyVersion !== inventory.keyVersion ||
    canary.aadVersion !== CANARY_AAD_VERSION
  ) {
    return false;
  }
  try {
    const label = canaryLabel(identity, inventory.purpose, inventory.keyVersion, inventory.keyId);
    if (createHash("sha256").update(label).digest("hex") !== canary.labelHash) return false;
    const associatedData = fileV1AssociatedData({
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      purpose: inventory.purpose,
      recordId: `node-canary:${inventory.purpose}:${inventory.keyVersion}`,
      aadVersion: CANARY_AAD_VERSION,
      context: { labelVersion: CANARY_LABEL_VERSION },
    });
    if (canary.protection === "aead") {
      if (!canary.nonce || !canary.ciphertext || !canary.authTag) return false;
      const plaintext = provider.decrypt(
        inventory.purpose,
        inventory.keyVersion,
        bytes(canary.ciphertext),
        bytes(canary.nonce),
        bytes(canary.authTag),
        associatedData,
      );
      return safeEqual(plaintext, label);
    }
    return Boolean(
      canary.verifier &&
      provider.verify(
        inventory.purpose,
        inventory.keyVersion,
        Buffer.concat([associatedData, Buffer.from([0]), label]),
        bytes(canary.verifier),
      ),
    );
  } catch {
    return false;
  }
}

function canaryLabel(
  identity: ControlPlaneStoreIdentity,
  purpose: FileV1Purpose,
  keyVersion: number,
  keyId: string,
): Buffer {
  return Buffer.from(
    stableJsonStringify({
      domain: "caplets/file-v1/node-canary",
      labelVersion: CANARY_LABEL_VERSION,
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      purpose,
      keyVersion,
      keyId,
      label: "CAPLETS_SHARED_NODE_CANARY",
    }),
    "utf8",
  );
}

async function inventoryRows(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  purpose?: FileV1Purpose,
  keyVersion?: number,
): Promise<readonly KeyInventoryRow[]> {
  return transaction.select<KeyInventoryRow>(
    "keyInventory",
    scope(identity, {
      ...(purpose ? { purpose } : {}),
      ...(keyVersion === undefined ? {} : { keyVersion }),
    }),
    [{ column: "keyVersion" }],
  );
}

function inventoryStatus(row: KeyInventoryRow): KeyInventoryStatus {
  return {
    provider: row.provider,
    keyId: row.keyId,
    purpose: row.purpose,
    algorithm: row.algorithm,
    keyVersion: row.keyVersion,
    state: row.state,
    verifiedNodeIds: verifiedNodeIds(row.verifiedNodeIds),
    purgeWatermark: row.purgeWatermark,
    activatedAt: row.activatedAt,
    ...(row.decryptOnlyAt ? { decryptOnlyAt: row.decryptOnlyAt } : {}),
    ...(row.retiredAt ? { retiredAt: row.retiredAt } : {}),
    ...(row.destroyedAt ? { destroyedAt: row.destroyedAt } : {}),
    ...(row.destructionId ? { destructionId: row.destructionId } : {}),
  };
}

async function findUndecryptableRecords(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  purpose: FileV1Purpose,
  provider: FileV1KeyProvider | undefined,
): Promise<readonly string[]> {
  if (purpose !== "active-record" && purpose !== "vault-record") return [];
  if (!provider) return [`${purpose}:provider-unavailable`];
  const table = purpose === "active-record" ? "oauthTokens" : "vaultValues";
  const rows = await transaction.select<ControlPlaneDatabaseRow>(table, scope(identity));
  const failed: string[] = [];
  for (const row of rows) {
    const recordName = purpose === "active-record" ? row.serverName : row.referenceName;
    const recordLabel = `${table}:${String(row.id)}`;
    try {
      if (
        row.algorithm !== "AES-256-GCM" ||
        row.aadVersion !== 1 ||
        typeof row.keyVersion !== "number" ||
        !Number.isSafeInteger(row.keyVersion) ||
        typeof recordName !== "string"
      ) {
        throw new Error("unsupported protection metadata");
      }
      provider.decrypt(
        purpose,
        row.keyVersion,
        bytes(purpose === "active-record" ? row.accessCiphertext : row.ciphertext),
        bytes(row.nonce),
        bytes(row.authTag),
        fileV1AssociatedData({
          logicalHostId: identity.logicalHostId,
          storeId: identity.storeId,
          purpose,
          recordId: purpose === "active-record" ? `oauth-token:${recordName}` : recordName,
          aadVersion: row.aadVersion,
        }),
      );
    } catch {
      failed.push(recordLabel);
    }
  }
  return failed.toSorted();
}

async function retirementInventory(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  purpose: FileV1Purpose,
  keyVersion: number,
  provider: FileV1KeyProvider | undefined,
): Promise<RetirementInventory> {
  const [inventory] = await inventoryRows(transaction, identity, purpose, keyVersion);
  const liveRecordIds: string[] = [];
  const tablePurposePairs = [
    { table: "oauthTokens", purpose: "active-record", equals: {} },
    { table: "vaultValues", purpose: "vault-record", equals: {} },
    { table: "pendingApprovals", purpose: "credential-verifier", equals: { state: "pending" } },
    { table: "dashboardSessions", purpose: "credential-verifier", equals: { revokedAt: null } },
    { table: "credentials", purpose: "credential-verifier", equals: { consumedAt: null } },
  ] as const;
  for (const candidate of tablePurposePairs) {
    if (candidate.purpose !== purpose) continue;
    const rows = await transaction.select<ControlPlaneDatabaseRow>(
      candidate.table,
      scope(identity, { keyVersion, ...candidate.equals }),
    );
    liveRecordIds.push(...rows.map((row) => `${candidate.table}:${String(row.id)}`));
  }
  const undecryptableRecordIds = await findUndecryptableRecords(
    transaction,
    identity,
    purpose,
    provider,
  );
  const backups = await transaction.select<BackupRow>(
    "backups",
    scope(identity, { keyPurpose: purpose, keyVersion }),
    [{ column: "retentionUntil" }],
  );
  const tombstones = await transaction.select<RetentionRow>(
    "retentions",
    scope(identity, {
      resourceKind: "key-tombstone",
      resourceId: `${purpose}:${keyVersion}`,
      destroyedAt: null,
    }),
  );
  const completedDestructions = await transaction.select<ExternalDestructionRow>(
    "externalDestructions",
    scope(identity, { phase: "completed" }),
  );
  return {
    inventory,
    liveRecordIds: liveRecordIds.toSorted(),
    undecryptableRecordIds,
    backups,
    tombstoneIds: tombstones.map((row) => row.retentionId).toSorted(),
    completedDestructions: completedDestructions.filter((row) => Boolean(row.receipt)),
  };
}

function hashRetirementInventory(inventory: RetirementInventory): string {
  return createHash("sha256")
    .update(
      stableJsonStringify({
        inventory: inventory.inventory
          ? {
              keyId: inventory.inventory.keyId,
              purpose: inventory.inventory.purpose,
              keyVersion: inventory.inventory.keyVersion,
              state: inventory.inventory.state,
              purgeWatermark: inventory.inventory.purgeWatermark,
              verifiedNodeIds: verifiedNodeIds(inventory.inventory.verifiedNodeIds),
            }
          : null,
        liveRecordIds: inventory.liveRecordIds,
        undecryptableRecordIds: inventory.undecryptableRecordIds,
        backups: inventory.backups.map((backup) => ({
          backupId: backup.backupId,
          retentionUntil: backup.retentionUntil,
          state: backup.state,
          destructionId: backup.destructionId,
        })),
        tombstoneIds: inventory.tombstoneIds,
        completedDestructions: inventory.completedDestructions.map((destruction) => ({
          destructionId: destruction.destructionId,
          receiptHash:
            destruction.receipt === null
              ? null
              : createHash("sha256").update(canonicalBytes(destruction.receipt)).digest("hex"),
          intentHash: createHash("sha256")
            .update(stableJsonStringify(destruction.intent))
            .digest("hex"),
        })),
      }),
    )
    .digest("hex");
}

function retirementConfirmation(preview: KeyRetirementPreview): RetirementConfirmation {
  return {
    logicalHostId: preview.logicalHostId,
    storeId: preview.storeId,
    purpose: preview.purpose,
    keyVersion: preview.keyVersion,
    minimumPurgeWatermark: preview.minimumPurgeWatermark,
    affectedVersions: preview.affectedVersions,
  };
}

function decodeRetirementConfirmation(value: unknown): RetirementConfirmation {
  const decoded = typeof value === "string" ? decodeCanonicalJson(value) : value;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new CapletsError("CONFIG_INVALID", "Retirement confirmation payload is malformed.");
  }
  const record = decoded as Record<string, unknown>;
  if (
    typeof record.logicalHostId !== "string" ||
    typeof record.storeId !== "string" ||
    typeof record.purpose !== "string" ||
    !(record.purpose in FILE_V1_PURPOSE_SPECS) ||
    typeof record.keyVersion !== "number" ||
    !Number.isSafeInteger(record.keyVersion) ||
    typeof record.minimumPurgeWatermark !== "number" ||
    !Number.isSafeInteger(record.minimumPurgeWatermark) ||
    !Array.isArray(record.affectedVersions) ||
    !record.affectedVersions.every((entry) => typeof entry === "string")
  ) {
    throw new CapletsError("CONFIG_INVALID", "Retirement confirmation payload is malformed.");
  }
  return {
    logicalHostId: record.logicalHostId,
    storeId: record.storeId,
    purpose: record.purpose as FileV1Purpose,
    keyVersion: record.keyVersion,
    minimumPurgeWatermark: record.minimumPurgeWatermark,
    affectedVersions: record.affectedVersions as string[],
  };
}

function authorityGenerationLock(identity: ControlPlaneStoreIdentity): string {
  return `authority-generation:${identity.logicalHostId}:${identity.storeId}`;
}

function securityEpochLock(identity: ControlPlaneStoreIdentity): string {
  return `security-epoch:${identity.logicalHostId}:${identity.storeId}`;
}

function nodeAdmissionLock(identity: ControlPlaneStoreIdentity): string {
  return `node-admission:${identity.logicalHostId}:${identity.storeId}`;
}

async function readCurrentAuthorityToken(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
): Promise<string> {
  const [authority] = await transaction.select<GenerationRow>(
    "authorityVersions",
    scope(identity),
    [{ column: "generation", direction: "desc" }],
    1,
  );
  const [effective] = await transaction.select<GenerationRow>(
    "effectiveVersions",
    scope(identity),
    [{ column: "generation", direction: "desc" }],
    1,
  );
  if (!authority || !effective) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Control-plane authority is not initialized.");
  }
  return `${authority.generation}:${effective.generation}`;
}

function authorityHashMatches(
  expectedHash: string,
  identity: ControlPlaneStoreIdentity,
  authorityToken: string,
): boolean {
  const actualHash = hashAuthorityToken(identity, authorityToken);
  return (
    expectedHash.length === actualHash.length &&
    safeEqual(Buffer.from(expectedHash, "hex"), Buffer.from(actualHash, "hex"))
  );
}

function hashAuthorityToken(identity: ControlPlaneStoreIdentity, authorityToken: string): string {
  return createHash("sha256")
    .update("caplets/key-retirement-authority/v1")
    .update("\0")
    .update(identity.logicalHostId)
    .update("\0")
    .update(identity.storeId)
    .update("\0")
    .update(authorityToken)
    .digest("hex");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function refused(
  reason: Extract<KeyRetirementResult, { status: "refused" }>["reason"],
  blockers: readonly string[],
): Extract<KeyRetirementResult, { status: "refused" }> {
  return { status: "refused", reason, blockers };
}
function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(typeof value === "string" ? value : stableJsonStringify(value), "utf8");
}

function deniedCanaryVerification(): NodeCanaryVerification {
  return {
    verified: false,
    readiness: "denied",
    writerLease: "revoked",
  };
}

async function revokeNodeAndWriterFence(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  nodeId: string,
  now: string,
  expectedFence?: ControlPlaneWriterFence | undefined,
): Promise<void> {
  if (expectedFence) {
    if (expectedFence.leaseId !== `writer:${nodeId}`) return;
    const activeChanged = await transaction.update(
      "writerFences",
      { state: "revoked", expiresAt: now, updatedAt: now },
      scope(identity, {
        leaseId: expectedFence.leaseId,
        writerEpoch: expectedFence.writerEpoch,
        authorityGeneration: expectedFence.authorityGeneration,
        state: "active",
      }),
    );
    if (activeChanged !== 1) {
      const pendingChanged = await transaction.update(
        "writerFences",
        { state: "revoked", expiresAt: now, updatedAt: now },
        scope(identity, {
          leaseId: expectedFence.leaseId,
          writerEpoch: expectedFence.writerEpoch,
          authorityGeneration: expectedFence.authorityGeneration,
          state: "pending",
        }),
      );
      if (pendingChanged !== 1) return;
    }
  } else {
    await transaction.update(
      "writerFences",
      { state: "revoked", expiresAt: now, updatedAt: now },
      scope(identity, { leaseId: `writer:${nodeId}`, state: "active" }),
    );
  }
  await transaction.update(
    "clusterNodeLeases",
    { state: "revoked", expiresAt: now, updatedAt: now },
    scope(identity, { nodeId }),
  );
}

async function readCurrentAuthorityGeneration(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
): Promise<number> {
  const [authority] = await transaction.select<GenerationRow>(
    "authorityVersions",
    scope(identity),
    [{ column: "generation", direction: "desc" }],
    1,
  );
  if (!authority) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Control-plane authority is not initialized.");
  }
  return decodeCanonicalVersion(authority.generation);
}

async function missingLiveReadyProofNodeIds(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  requiredNodeIds: readonly string[],
  proofs: readonly NodeCanaryProof[],
): Promise<readonly string[]> {
  if (requiredNodeIds.length === 0) return [];
  const now = await transaction.databaseTime();
  const authorityGeneration = await readCurrentAuthorityGeneration(transaction, identity);
  const proofByNode = new Map(proofs.map((proof) => [proof.nodeId, proof]));
  const missingNodeIds: string[] = [];
  for (const nodeId of requiredNodeIds) {
    const proof = proofByNode.get(nodeId);
    if (
      !proof ||
      !("leaseId" in proof) ||
      proof.authorityGeneration !== authorityGeneration ||
      !(await writerFenceIsLive(transaction, identity, nodeId, proof, now))
    ) {
      missingNodeIds.push(nodeId);
    }
  }
  return missingNodeIds;
}

async function liveReadyNodeIds(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
): Promise<readonly string[]> {
  const now = await transaction.databaseTime();
  const rows = await transaction.select<ClusterNodeRow>("clusterNodeLeases", {
    equals: {
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      state: "ready",
    },
    greaterThan: { expiresAt: now },
  });
  return [...new Set(rows.map((row) => requiredNodeId(row.nodeId)))].toSorted();
}

async function assertKeyMaintenanceFence(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  securityEpoch: number | undefined,
  fence: ControlPlaneWriterFence | undefined,
): Promise<void> {
  if (transaction.backend === "sqlite") return;
  await transaction.lock(authorityGenerationLock(identity));
  await transaction.lock(securityEpochLock(identity));
  await transaction.lock(nodeAdmissionLock(identity));
  const nodeId = fence?.leaseId.startsWith("writer:")
    ? fence.leaseId.slice("writer:".length)
    : undefined;
  const [security] = await transaction.select<SecurityEpochRow>(
    "securityVersions",
    scope(identity),
    [{ column: "epoch", direction: "desc" }],
    1,
  );
  const now = await transaction.databaseTime();
  if (
    !fence ||
    !nodeId ||
    securityEpoch === undefined ||
    !security ||
    decodeCanonicalVersion(security.epoch) !== securityEpoch ||
    fence.authorityGeneration !== (await readCurrentAuthorityGeneration(transaction, identity)) ||
    !(await writerFenceIsLive(transaction, identity, nodeId, fence, now)) ||
    !(await guardWriterFenceForCommit(transaction, identity, nodeId, fence))
  ) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Postgres key maintenance requires an exact live authority fence.",
    );
  }
}

async function writerFenceIsLive(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  nodeId: string,
  fence: ControlPlaneWriterFence,
  now: string,
): Promise<boolean> {
  return (await writerFenceState(transaction, identity, nodeId, fence, now, false)) === "active";
}

async function writerFenceState(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  nodeId: string,
  fence: ControlPlaneWriterFence,
  now: string,
  allowPending: boolean,
): Promise<"active" | "pending" | undefined> {
  if (fence.leaseId !== `writer:${nodeId}`) return undefined;
  const [node] = await transaction.select<ClusterNodeRow>(
    "clusterNodeLeases",
    {
      equals: {
        logicalHostId: identity.logicalHostId,
        storeId: identity.storeId,
        nodeId,
      },
      greaterThan: { expiresAt: now },
    },
    [],
    1,
  );
  const [storedFence] = await transaction.select<WriterFenceRow>(
    "writerFences",
    {
      equals: {
        logicalHostId: identity.logicalHostId,
        storeId: identity.storeId,
        leaseId: fence.leaseId,
        writerEpoch: fence.writerEpoch,
        authorityGeneration: fence.authorityGeneration,
      },
      greaterThan: { expiresAt: now },
    },
    [],
    1,
  );
  if (
    !node ||
    !storedFence ||
    (node.state !== "ready" && (!allowPending || node.state !== "catching-up")) ||
    (storedFence.state !== "active" && (!allowPending || storedFence.state !== "pending"))
  ) {
    return undefined;
  }
  return storedFence.state;
}

async function guardWriterFenceForCommit(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  nodeId: string,
  fence: ControlPlaneWriterFence,
  state: "active" | "pending" = "active",
): Promise<boolean> {
  if (fence.leaseId !== `writer:${nodeId}`) return false;
  const changed = await transaction.finalWriterFenceGuard({
    logicalHostId: identity.logicalHostId,
    storeId: identity.storeId,
    leaseId: fence.leaseId,
    writerEpoch: fence.writerEpoch,
    authorityGeneration: fence.authorityGeneration,
    state,
  });
  return changed === 1;
}

function destructionCovers(
  destruction: ExternalDestructionRow,
  kind: "bytes" | "key",
  id: string,
): boolean {
  try {
    const intent =
      typeof destruction.intent === "string"
        ? decodeCanonicalJson(destruction.intent)
        : destruction.intent;
    return (
      Array.isArray(intent) &&
      intent.some(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          (item as Record<string, unknown>).kind === kind &&
          (item as Record<string, unknown>).id === id,
      )
    );
  } catch {
    return false;
  }
}

async function updateDestructionState(
  dialect: ControlPlaneTransactionalDialect,
  identity: ControlPlaneStoreIdentity,
  input: Readonly<{ purpose: FileV1Purpose; keyVersion: number; destructionId: string }>,
  expectedState: KeyInventoryState,
  state: KeyInventoryState,
): Promise<KeyInventoryStatus> {
  return dialect.runtimeTransaction(async (transaction) => {
    await transaction.lock(`key-destruction:${input.purpose}:${input.keyVersion}`);
    const [inventory] = await inventoryRows(transaction, identity, input.purpose, input.keyVersion);
    const [destruction] = await transaction.select<ExternalDestructionRow>(
      "externalDestructions",
      scope(identity, { destructionId: input.destructionId }),
    );
    if (!inventory || !destruction || !destructionCovers(destruction, "key", inventory.keyId)) {
      throw new CapletsError("REQUEST_INVALID", "Key destruction intent is not bound to that key.");
    }
    const now = await transaction.databaseTime();
    const changed = await transaction.update(
      "keyInventory",
      { state, destructionId: input.destructionId, updatedAt: now },
      scope(identity, {
        purpose: input.purpose,
        keyVersion: input.keyVersion,
        state: expectedState,
      }),
    );
    if (changed !== 1) {
      throw new CapletsError("REQUEST_INVALID", "Key destruction state transition was refused.");
    }
    const [row] = await inventoryRows(transaction, identity, input.purpose, input.keyVersion);
    if (!row) throw new Error("Key inventory disappeared during destruction transition");
    return inventoryStatus(row);
  });
}

function keyInventoryId(purpose: FileV1Purpose, keyVersion: number): string {
  return `key-inventory:${purpose}:${keyVersion}`;
}

function keyCanaryId(purpose: FileV1Purpose, keyVersion: number): string {
  return `key-canary:${purpose}:${keyVersion}`;
}

function requiredNodeId(nodeId: string): string {
  if (!nodeId || nodeId.length > 256 || nodeId.includes("\0")) {
    throw new CapletsError("REQUEST_INVALID", "Cluster node identity is invalid.");
  }
  return nodeId;
}

function parseNodeCanaryProofs(value: string): NodeCanaryProof[] {
  const parsed = decodeCanonicalJson(value);
  if (!Array.isArray(parsed)) {
    throw new CapletsError("CONFIG_INVALID", "Key node capability inventory is malformed.");
  }
  return parsed.map((item) => {
    if (typeof item === "string") {
      if (!item || item.length > 256 || item.includes("\0")) {
        throw new CapletsError("CONFIG_INVALID", "Key node capability inventory is malformed.");
      }
      return { nodeId: item };
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new CapletsError("CONFIG_INVALID", "Key node capability inventory is malformed.");
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.nodeId !== "string" ||
      !record.nodeId ||
      record.nodeId.length > 256 ||
      record.nodeId.includes("\0") ||
      typeof record.leaseId !== "string" ||
      !record.leaseId ||
      !Number.isSafeInteger(record.writerEpoch) ||
      (record.writerEpoch as number) < 0 ||
      !Number.isSafeInteger(record.authorityGeneration) ||
      (record.authorityGeneration as number) < 0
    ) {
      throw new CapletsError("CONFIG_INVALID", "Key node capability inventory is malformed.");
    }
    return {
      nodeId: record.nodeId,
      leaseId: record.leaseId,
      writerEpoch: record.writerEpoch as number,
      authorityGeneration: record.authorityGeneration as number,
    };
  });
}

function encodeNodeCanaryProofs(proofs: readonly NodeCanaryProof[]): string {
  return encodeCanonicalJson(
    proofs
      .toSorted((left, right) => left.nodeId.localeCompare(right.nodeId))
      .map((proof) => ("leaseId" in proof ? proof : proof.nodeId)),
  );
}

function verifiedNodeIds(value: string): string[] {
  return [...new Set(parseNodeCanaryProofs(value).map((proof) => proof.nodeId))].toSorted();
}

function bytes(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new CapletsError("CONFIG_INVALID", "Key canary bytes are malformed.");
}

function safeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function baseRow(identity: ControlPlaneStoreIdentity, id: string, now: string) {
  return {
    modelVersion: 1,
    id,
    logicalHostId: identity.logicalHostId,
    storeId: identity.storeId,
    createdAt: now,
    updatedAt: now,
    aggregateVersion: 0,
    authorityVersion: 0,
    effectiveVersion: 0,
    securityVersion: 0,
  } as const;
}

function scope(
  identity: ControlPlaneStoreIdentity,
  equals: Readonly<Record<string, unknown>> = {},
) {
  return {
    equals: {
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      ...equals,
    },
  } as const;
}
