import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CapletsError } from "../../errors";
import type {
  CurrentHostConfirmationToken,
  CurrentHostOperationBinding,
  CurrentHostOperationLookupOutcome,
  CurrentHostOperationReceipt,
} from "../../current-host/operations";
import { STORAGE_BENCHMARK_ENVELOPE } from "../benchmarks/fixture";
import {
  type CanonicalCapletAggregate,
  type CanonicalCapletRelationalProjection,
  type PortableJson,
  validateCapletRelationalProjection,
} from "./model";
import { encodePortableCaplet, validatePortableCaplet } from "./portable-codec";
import { parseCanonicalHostSetting } from "../model";
import {
  decodeCanonicalBytes,
  decodeCanonicalJson,
  decodeCanonicalTimestamp,
  decodeCanonicalVersion,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  encodeCanonicalTimestamp,
} from "../schema/model-codec";
import type {
  ControlPlaneFailurePoint,
  ControlPlaneDatabaseRow as ControlPlaneSqlRow,
  ControlPlaneTable,
  ControlPlaneSqlTransaction,
  ControlPlaneStore,
  ControlPlaneStoreOptions,
} from "../store";
import type {
  CapletManagementMutation,
  ConfirmationConsumeResult,
  ConfirmationConsumption,
  ConfirmationPreviewRequest,
  ControlPlaneConflictReason,
  ControlPlaneHealthSummary,
  ControlPlaneMutationResult,
  ControlPlaneNodeRegistration,
  ControlPlaneNodeRegistrationResult,
  ControlPlaneOperationReservationResult,
  ControlPlaneSnapshot,
  ControlPlaneStoreIdentity,
  ControlPlaneVersionState,
  ExternalDestructionIntent,
  ExternalDestructionPort,
  ExternalDestructionStatus,
  HostSettingManagementMutation,
} from "../types";

const DEFAULT_RESERVATION_TTL_MS = 5 * 60_000;
const EXTERNAL_DESTRUCTION_CLAIM_TTL_MS = 30_000;
const COMMON_COLUMNS = [
  "model_version",
  "id",
  "logical_host_id",
  "store_id",
  "created_at",
  "updated_at",
  "aggregate_version",
  "authority_version",
  "effective_version",
  "security_version",
] as const;

class StoreResultError extends Error {
  constructor(
    readonly result: Extract<
      ControlPlaneMutationResult,
      { status: "conflict" | "denied" | "unavailable" }
    >,
  ) {
    super(result.status);
  }
}

type CommonVersions = Readonly<{
  aggregateVersion: number;
  authorityVersion: number;
  effectiveVersion: number;
  securityVersion: number;
}>;

type OperationTarget = Readonly<{
  binding: CurrentHostOperationBinding;
  aggregateId?: string | undefined;
  retryReservationId?: string | undefined;
}>;

type VersionRows = Readonly<{
  authorityGeneration: number;
  effectiveGeneration: number;
  securityEpoch: number;
}>;

export function createControlPlaneRepository(options: ControlPlaneStoreOptions): ControlPlaneStore {
  const reservationTtlMs = options.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
  let lastKnownVersions: VersionRows = {
    authorityGeneration: 0,
    effectiveGeneration: 0,
    securityEpoch: 0,
  };
  let cachedSnapshot:
    | Readonly<{ versions: VersionRows; snapshot: ControlPlaneSnapshot }>
    | undefined;
  let snapshotLoadTail: Promise<void> = Promise.resolve();
  const fail = async (point: ControlPlaneFailurePoint) => {
    await options.failureInjector?.(point);
  };

  const initialize = async (): Promise<ControlPlaneVersionState> => {
    requireReady(options);
    const versions = await options.dialect.runtimeTransaction(async (transaction) => {
      const now = await transaction.databaseTime();
      await transaction.lock(
        `initialize:${options.identity.logicalHostId}:${options.identity.storeId}`,
      );
      const zero = commonValues(options, now, "initial", {
        aggregateVersion: 0,
        authorityVersion: 0,
        effectiveVersion: 0,
        securityVersion: 0,
      });
      await insertIgnore(
        transaction,
        "cp_operation_namespace",
        [...COMMON_COLUMNS, "namespace_id", "generation", "state", "replaced_by", "replaced_at"],
        [...zero, options.identity.operationNamespace, 0, "active", null, null],
        ["logical_host_id", "id"],
      );
      await insertIgnore(
        transaction,
        "cp_authority_version",
        [
          ...COMMON_COLUMNS,
          "generation",
          "binding_state",
          "authority_token",
          "operation_namespace",
          "transfer_id",
        ],
        [...zero, 0, "active", authorityTokenText(0, 0), options.identity.operationNamespace, null],
        ["logical_host_id", "id"],
      );
      await insertIgnore(
        transaction,
        "cp_effective_version",
        [...COMMON_COLUMNS, "generation", "snapshot_hash", "applied_token", "published_at"],
        [...zero, 0, sha256("empty-snapshot"), authorityTokenText(0, 0), now],
        ["logical_host_id", "id"],
      );
      await insertIgnore(
        transaction,
        "cp_security_version",
        [...COMMON_COLUMNS, "epoch", "minimum_key_version", "revocation_watermark", "advanced_at"],
        [...zero, 0, 0, 0, now],
        ["logical_host_id", "id"],
      );
      return readVersions(transaction, options.identity.logicalHostId);
    });
    lastKnownVersions = versions;
    return versions;
  };

  const reserveOperation = async (
    binding: CurrentHostOperationBinding,
    aggregateId: string,
  ): Promise<ControlPlaneOperationReservationResult> => {
    if (!options.dialect.ready) return { status: "unavailable" };
    if (!matchesStore(options, binding)) {
      return { status: "conflict", reason: "operation-binding" };
    }
    try {
      return await options.dialect.runtimeTransaction(async (transaction) => {
        await transaction.lock(aggregateSerialKey(options.identity, aggregateId));
        await transaction.lock(operationSerialKey(binding));
        const outcome = await readOutcome(transaction, options, binding.operationId);
        if (outcome) {
          return bindingsEqual(outcome.binding, binding)
            ? { status: "committed", receipt: outcome }
            : { status: "conflict", reason: "operation-binding" };
        }
        const tombstone = await readTombstone(transaction, options, binding.operationId);
        if (tombstone) {
          return bindingsEqual(tombstone.binding, binding)
            ? { status: "conflict", reason: "operation-consumed" }
            : { status: "conflict", reason: "operation-binding" };
        }
        const existing = await readReservation(transaction, options, binding.operationId);
        if (existing) {
          if (!bindingsEqual(existing.binding, binding) || existing.aggregateId !== aggregateId) {
            return { status: "conflict", reason: "operation-binding" };
          }
          return existing.state === "reserved"
            ? { status: "reserved", binding }
            : { status: "conflict", reason: "operation-consumed" };
        }
        const versions = await readVersions(transaction, options.identity.logicalHostId);
        const now = await transaction.databaseTime();
        const common = commonValues(options, now, operationRowId(binding.operationId), {
          aggregateVersion: 0,
          authorityVersion: versions.authorityGeneration,
          effectiveVersion: versions.effectiveGeneration,
          securityVersion: versions.securityEpoch,
        });
        await insert(
          transaction,
          "cp_operation_reservation",
          [
            ...COMMON_COLUMNS,
            "operation_id",
            "namespace_id",
            "target",
            "actor_id",
            "request_hash",
            "state",
            "reserved_at",
            "committed_at",
          ],
          [
            ...common,
            binding.operationId,
            binding.operationNamespace,
            encodeCanonicalJson({ binding, aggregateId }),
            binding.actorId,
            sha256(binding.requestIdentity),
            "reserved",
            now,
            null,
          ],
        );
        return { status: "reserved", binding };
      });
    } catch {
      return { status: "unavailable" };
    }
  };

  const lookupOrReserveNotCommitted = async (
    binding: CurrentHostOperationBinding,
    aggregateId?: string,
  ): Promise<CurrentHostOperationLookupOutcome> => {
    if (!options.dialect.ready) return { status: "unavailable", binding };
    if (
      binding.logicalHostId !== options.identity.logicalHostId ||
      binding.storeId !== options.identity.storeId
    ) {
      return { status: "wrong_target", binding };
    }
    if (binding.operationNamespace !== options.identity.operationNamespace) {
      return { status: "stale_namespace", binding };
    }
    try {
      return await options.dialect.runtimeTransaction(async (transaction) => {
        if (aggregateId) {
          await transaction.lock(aggregateSerialKey(options.identity, aggregateId));
        }
        await transaction.lock(operationSerialKey(binding));
        const outcome = await readOutcome(transaction, options, binding.operationId);
        if (outcome) {
          return bindingsEqual(outcome.binding, binding)
            ? { status: "committed", receipt: outcome }
            : { status: "wrong_target", binding };
        }
        const existingTombstone = await readTombstone(transaction, options, binding.operationId);
        if (existingTombstone) {
          return bindingsEqual(existingTombstone.binding, binding)
            ? {
                status: "not_committed",
                binding,
                retryReservationId:
                  existingTombstone.retryReservationId ?? retryReservationId(binding),
              }
            : { status: "wrong_target", binding };
        }
        const reservation = await readReservation(transaction, options, binding.operationId);
        if (
          reservation &&
          (!bindingsEqual(reservation.binding, binding) ||
            (aggregateId !== undefined && reservation.aggregateId !== aggregateId))
        ) {
          return { status: "wrong_target", binding };
        }
        const retryId = retryReservationId(binding);
        const now = await transaction.databaseTime();
        const versions = await readVersions(transaction, options.identity.logicalHostId);
        const common = commonValues(options, now, tombstoneRowId(binding.operationId), {
          aggregateVersion: 0,
          authorityVersion: versions.authorityGeneration,
          effectiveVersion: versions.effectiveGeneration,
          securityVersion: versions.securityEpoch,
        });
        await insert(
          transaction,
          "cp_operation_tombstone",
          [
            ...COMMON_COLUMNS,
            "operation_id",
            "namespace_id",
            "target",
            "request_hash",
            "reason",
            "consumed_at",
          ],
          [
            ...common,
            binding.operationId,
            binding.operationNamespace,
            encodeCanonicalJson({ binding, aggregateId, retryReservationId: retryId }),
            sha256(binding.requestIdentity),
            "authoritative-absence",
            now,
          ],
        );
        return { status: "not_committed", binding, retryReservationId: retryId };
      });
    } catch {
      return { status: "unavailable", binding };
    }
  };

  const mutateCaplet = async (
    input: CapletManagementMutation,
  ): Promise<ControlPlaneMutationResult> => {
    validatePortableCaplet(input.aggregate.portable);
    validateCapletRelationalProjection(input.aggregate, input.projection);
    if (
      input.aggregate.installationProvenanceId !== undefined &&
      input.aggregate.installationProvenanceId !== input.provenance.id
    ) {
      throw new Error("Caplet installation provenance does not match the mutation provenance");
    }
    return runManagementMutation(
      options,
      input,
      fail,
      reservationTtlMs,
      async (transaction, state) => {
        await writeCaplet(transaction, options, input, state);
      },
    );
  };

  const mutateHostSetting = async (
    input: HostSettingManagementMutation,
  ): Promise<ControlPlaneMutationResult> => {
    parseCanonicalHostSetting(input.setting);
    return runManagementMutation(
      options,
      input,
      fail,
      reservationTtlMs,
      async (transaction, state) => {
        await writeHostSetting(transaction, options, input, state);
      },
    );
  };

  const loadSnapshot = async (): Promise<ControlPlaneSnapshot> => {
    requireReady(options);
    const previous = snapshotLoadTail;
    let release: (() => void) | undefined;
    snapshotLoadTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await options.dialect.snapshotTransaction(async (transaction) => {
        const versions = await readVersions(transaction, options.identity.logicalHostId);
        if (cachedSnapshot && sameVersions(cachedSnapshot.versions, versions)) {
          return cachedSnapshot.snapshot;
        }
        const snapshot = await readSnapshot(transaction, options, versions);
        cachedSnapshot = Object.freeze({ versions, snapshot });
        return snapshot;
      });
    } catch {
      throw new CapletsError("SERVER_UNAVAILABLE", "Control-plane storage is unavailable.");
    } finally {
      release?.();
    }
  };

  const createConfirmationPreview = async (
    request: ConfirmationPreviewRequest,
  ): Promise<CurrentHostConfirmationToken> => {
    requireReady(options);
    if (!Number.isSafeInteger(request.expiresInMs) || request.expiresInMs <= 0) {
      throw new Error("Confirmation expiry must be a positive integer");
    }
    return options.dialect.runtimeTransaction(async (transaction) => {
      await transaction.lock(
        `effective-generation:${options.identity.logicalHostId}:${options.identity.storeId}`,
      );
      await transaction.lock(
        `authority-generation:${options.identity.logicalHostId}:${options.identity.storeId}`,
      );
      const versions = await readVersions(transaction, options.identity.logicalHostId);
      if (
        request.authorityToken.authorityGeneration !== versions.authorityGeneration ||
        request.authorityToken.effectiveGeneration !== versions.effectiveGeneration
      ) {
        throw new Error("Confirmation authority is stale");
      }
      const now = await transaction.databaseTime();
      const expiresAt = new Date(Date.parse(now) + request.expiresInMs).toISOString();
      const common = commonValues(options, now, confirmationRowId(request.tokenId), {
        aggregateVersion: 0,
        authorityVersion: versions.authorityGeneration,
        effectiveVersion: versions.effectiveGeneration,
        securityVersion: versions.securityEpoch,
      });
      await insert(
        transaction,
        "cp_confirmation",
        [
          ...COMMON_COLUMNS,
          "confirmation_id",
          "action",
          "authority_token",
          "inventory_hash",
          "affected_inventory",
          "expires_at",
          "consequences",
          "state",
          "consumed_at",
        ],
        [
          ...common,
          request.tokenId,
          request.action,
          authorityTokenText(
            request.authorityToken.authorityGeneration,
            request.authorityToken.effectiveGeneration,
          ),
          inventoryHash(request.affectedVersions),
          encodeCanonicalJson([...request.affectedVersions].sort()),
          expiresAt,
          encodeCanonicalJson(request.consequences),
          "previewed",
          null,
        ],
      );
      return Object.freeze({
        version: 1 as const,
        tokenId: request.tokenId,
        action: request.action,
        logicalHostId: options.identity.logicalHostId,
        storeId: options.identity.storeId,
        authorityToken: request.authorityToken,
        affectedVersions: [...request.affectedVersions],
        expiresAt,
        consequences: [...request.consequences],
        consumed: false as const,
      });
    });
  };

  const consumeConfirmationInTransaction = async <T>(
    transaction: ControlPlaneSqlTransaction,
    request: ConfirmationConsumption,
    action: (transaction: ControlPlaneSqlTransaction) => Promise<T>,
  ): Promise<ConfirmationConsumeResult<T>> => {
    await transaction.lock(
      `effective-generation:${options.identity.logicalHostId}:${options.identity.storeId}`,
    );
    await transaction.lock(
      `authority-generation:${options.identity.logicalHostId}:${options.identity.storeId}`,
    );
    await transaction.lock(`confirmation:${request.token.tokenId}`);
    const rows = await transaction.select<ConfirmationRow>("confirmations", {
      equals: {
        logicalHostId: options.identity.logicalHostId,
        storeId: options.identity.storeId,
        confirmationId: request.token.tokenId,
      },
    });
    const row = rows[0];
    if (!row) return { status: "rejected", reason: "absent" };
    if (row.state !== "previewed") return { status: "rejected", reason: "replayed" };
    if (row.action !== request.action || row.action !== request.token.action) {
      return { status: "rejected", reason: "mismatched-action" };
    }
    const versions = await readVersions(transaction, options.identity.logicalHostId);
    const storedToken = authorityTokenText(
      request.authorityToken.authorityGeneration,
      request.authorityToken.effectiveGeneration,
    );
    const confirmationToken = authorityTokenText(
      request.token.authorityToken.authorityGeneration,
      request.token.authorityToken.effectiveGeneration,
    );
    const currentToken = authorityTokenText(
      versions.authorityGeneration,
      versions.effectiveGeneration,
    );
    if (
      request.token.logicalHostId !== options.identity.logicalHostId ||
      request.token.storeId !== options.identity.storeId ||
      row.authorityToken !== storedToken ||
      storedToken !== confirmationToken ||
      confirmationToken !== currentToken
    ) {
      return { status: "rejected", reason: "stale-authority" };
    }
    if (
      row.inventoryHash !== inventoryHash(request.affectedVersions) ||
      row.inventoryHash !== inventoryHash(request.token.affectedVersions)
    ) {
      return { status: "rejected", reason: "changed-inventory" };
    }
    const now = await transaction.databaseTime();
    if (Date.parse(row.expiresAt) <= Date.parse(now)) {
      return { status: "rejected", reason: "expired" };
    }
    const value = await action(transaction);
    const changed = await transaction.update(
      "confirmations",
      { state: "consumed", consumedAt: now, updatedAt: now },
      {
        equals: {
          logicalHostId: options.identity.logicalHostId,
          storeId: options.identity.storeId,
          confirmationId: request.token.tokenId,
          state: "previewed",
        },
      },
    );
    if (changed !== 1) throw new Error("Confirmation was consumed concurrently");
    return { status: "committed", value };
  };

  const consumeConfirmation = async <T>(
    request: ConfirmationConsumption,
    action: (transaction: ControlPlaneSqlTransaction) => Promise<T>,
  ): Promise<ConfirmationConsumeResult<T>> => {
    requireReady(options);
    return options.dialect.runtimeTransaction((transaction) =>
      consumeConfirmationInTransaction(transaction, request, action),
    );
  };

  const confirmExternalDestruction = async (
    request: ConfirmationConsumption,
    intent: ExternalDestructionIntent,
  ): Promise<ConfirmationConsumeResult<ExternalDestructionStatus>> => {
    requireReady(options);
    if (
      request.action !== "external-destruction" ||
      request.token.tokenId !== intent.confirmationId ||
      intent.inventoryHash !== inventoryHash(externalDestructionAffectedVersions(intent))
    ) {
      return { status: "rejected", reason: "changed-inventory" };
    }
    return options.dialect.runtimeTransaction((transaction) =>
      consumeConfirmationInTransaction(transaction, request, async () => {
        await transaction.lock(`destruction:${intent.destructionId}`);
        const byConfirmation = await transaction.select<DestructionRow>(
          "externalDestructions",
          {
            equals: {
              logicalHostId: options.identity.logicalHostId,
              storeId: options.identity.storeId,
              confirmationId: intent.confirmationId,
            },
          },
          [],
          1,
        );
        if (byConfirmation.length > 0) {
          throw new Error("Confirmation already authorized an external destruction");
        }
        const versions = await readVersions(transaction, options.identity.logicalHostId);
        const now = await transaction.databaseTime();
        const common = commonValues(options, now, destructionRowId(intent.destructionId), {
          aggregateVersion: 0,
          authorityVersion: versions.authorityGeneration,
          effectiveVersion: versions.effectiveGeneration,
          securityVersion: versions.securityEpoch,
        });
        await insert(
          transaction,
          "cp_external_destruction",
          [
            ...COMMON_COLUMNS,
            "destruction_id",
            "provider_identity",
            "phase",
            "inventory_hash",
            "confirmation_id",
            "intent",
            "receipt",
            "completed_at",
          ],
          [
            ...common,
            intent.destructionId,
            intent.providerIdentity,
            "intended",
            intent.inventoryHash,
            intent.confirmationId,
            encodeCanonicalJson(intent.material),
            null,
            null,
          ],
        );
        return {
          destructionId: intent.destructionId,
          phase: "intended" as const,
        };
      }),
    );
  };

  const resumeExternalDestruction = async (
    destructionId: string,
    external: ExternalDestructionPort,
  ): Promise<ExternalDestructionStatus> => {
    requireReady(options);
    const claimToken = randomUUID();
    const claimed = await options.dialect.runtimeTransaction(async (transaction) => {
      await transaction.lock(`destruction:${destructionId}`);
      const current = await readDestruction(transaction, options, destructionId);
      if (!current) throw new Error("External destruction intent was not found");
      if (current.status.phase === "completed") return current;
      const now = await transaction.databaseTime();
      if (current.claim && Date.parse(current.claim.expiresAt) > Date.parse(now)) {
        throw new Error("External destruction is already being executed");
      }
      const claim = {
        token: claimToken,
        expiresAt: new Date(Date.parse(now) + EXTERNAL_DESTRUCTION_CLAIM_TTL_MS).toISOString(),
      };
      const changed = await transaction.update(
        "externalDestructions",
        {
          phase: "in-progress",
          receipt: databaseJson(transaction, claim),
          updatedAt: now,
        },
        {
          equals: {
            logicalHostId: options.identity.logicalHostId,
            storeId: options.identity.storeId,
            destructionId,
            phase: current.status.phase,
            updatedAt: current.updatedAt,
          },
        },
      );
      if (changed !== 1) throw new Error("External destruction claim changed concurrently");
      return {
        ...current,
        claim,
        status: { destructionId, phase: "in-progress" as const },
      };
    });
    if (claimed.status.phase === "completed") return claimed.status;
    if (external.providerIdentity !== claimed.providerIdentity) {
      await releaseExternalDestructionClaim(options, destructionId, claimToken);
      throw new Error("External destruction provider identity does not match the durable intent");
    }
    try {
      for (const material of claimed.material) {
        if (await external.isAbsent(material)) continue;
        await fail("before-external-remove");
        await external.remove(material);
        await fail("after-external-remove");
      }
      for (const material of claimed.material) {
        if (!(await external.isAbsent(material))) {
          throw new Error("External destruction material remains present");
        }
      }
      await fail("before-destruction-receipt");
      return await options.dialect.runtimeTransaction(async (transaction) => {
        await transaction.lock(`destruction:${destructionId}`);
        const current = await readDestruction(transaction, options, destructionId);
        if (!current) throw new Error("External destruction intent was not found");
        if (current.status.phase === "completed") return current.status;
        if (current.claim?.token !== claimToken) {
          throw new Error("External destruction claim is no longer owned");
        }
        const now = await transaction.databaseTime();
        const receipt = Object.freeze({
          materialCount: current.material.length,
          inventoryHash: current.inventoryHash,
        });
        const changed = await transaction.update(
          "externalDestructions",
          {
            phase: "completed",
            receipt: databaseJson(transaction, receipt),
            completedAt: now,
            updatedAt: now,
          },
          {
            equals: {
              logicalHostId: options.identity.logicalHostId,
              storeId: options.identity.storeId,
              destructionId,
              phase: "in-progress",
              updatedAt: current.updatedAt,
            },
          },
        );
        if (changed !== 1) throw new Error("External destruction claim changed concurrently");
        return { destructionId, phase: "completed", completedAt: now, receipt };
      });
    } catch (error) {
      await releaseExternalDestructionClaim(options, destructionId, claimToken).catch(
        () => undefined,
      );
      throw error;
    }
  };

  const recordOperationalLedger: ControlPlaneStore["recordOperationalLedger"] = async (input) => {
    requireReady(options);
    const execute =
      input.kind === "retention"
        ? options.dialect.maintenanceTransaction
        : options.dialect.runtimeTransaction;
    await execute(async (transaction) => {
      const now = await transaction.databaseTime();
      const versions = await readVersions(transaction, options.identity.logicalHostId);
      const common = commonValues(options, now, ledgerRowId(input.kind, input.id), {
        aggregateVersion: 0,
        authorityVersion: versions.authorityGeneration,
        effectiveVersion: versions.effectiveGeneration,
        securityVersion: versions.securityEpoch,
      });
      if (input.kind === "heartbeat") {
        await insertIgnore(
          transaction,
          "cp_cluster_node_lease",
          [
            ...COMMON_COLUMNS,
            "node_id",
            "bootstrap_fingerprint",
            "compatibility",
            "heartbeat_at",
            "expires_at",
            "state",
          ],
          [
            ...common,
            input.id,
            sha256(encodeCanonicalJson(input.detail ?? {})),
            encodeCanonicalJson(input.detail ?? {}),
            now,
            now,
            "operational-ledger",
          ],
          ["logical_host_id", "id"],
        );
      } else if (input.kind === "migration") {
        await insertIgnore(
          transaction,
          "cp_migration",
          [
            ...COMMON_COLUMNS,
            "migration_id",
            "source",
            "destination",
            "phase",
            "manifest_hash",
            "checksum",
            "compatibility",
            "activated_at",
          ],
          [
            ...common,
            input.id,
            "operational",
            "operational",
            "discovered",
            sha256(`manifest:${input.id}`),
            sha256(`checksum:${input.id}`),
            encodeCanonicalJson(input.detail ?? {}),
            null,
          ],
          ["logical_host_id", "id"],
        );
      } else {
        await insertIgnore(
          transaction,
          "cp_retention",
          [
            ...COMMON_COLUMNS,
            "retention_id",
            "resource_kind",
            "resource_id",
            "policy",
            "purge_watermark",
            "retain_until",
            "destroyed_at",
          ],
          [
            ...common,
            input.id,
            input.kind,
            input.id,
            encodeCanonicalJson(input.detail ?? {}),
            0,
            now,
            input.kind === "session-expiry" ? now : null,
          ],
          ["logical_host_id", "id"],
        );
      }
    });
  };

  const registerNode = async (
    input: ControlPlaneNodeRegistration,
  ): Promise<ControlPlaneNodeRegistrationResult> => {
    requireReady(options);
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
      throw new Error("Node lease TTL must be a positive integer");
    }
    return options.dialect.runtimeTransaction(async (transaction) => {
      await transaction.lock(`nodes:${options.identity.logicalHostId}`);
      const now = await transaction.databaseTime();
      const existing = await transaction.select<NodeRow>("clusterNodeLeases", {
        equals: {
          logicalHostId: options.identity.logicalHostId,
          storeId: options.identity.storeId,
          nodeId: input.nodeId,
        },
      });
      const versions = await readVersions(transaction, options.identity.logicalHostId);
      const leaseId = `writer:${input.nodeId}`;
      const existingFence = await transaction.select<FenceRow>(
        "writerFences",
        {
          equals: {
            logicalHostId: options.identity.logicalHostId,
            storeId: options.identity.storeId,
            leaseId,
          },
        },
        [],
        1,
      );
      const currentNode = existing[0];
      const expectedFingerprint = /^[a-f0-9]{64}$/u.test(input.bootstrapFingerprint)
        ? input.bootstrapFingerprint
        : sha256(input.bootstrapFingerprint);
      if (currentNode && currentNode.bootstrapFingerprint !== expectedFingerprint) {
        return { status: "identity-conflict" };
      }
      const nodeStillReady =
        currentNode?.state === "ready" && Date.parse(currentNode.expiresAt) > Date.parse(now);
      const currentFence = existingFence[0];
      const fenceStillActive =
        nodeStillReady &&
        currentFence?.state === "active" &&
        Date.parse(currentFence.expiresAt) > Date.parse(now) &&
        decodeCanonicalVersion(currentFence.authorityGeneration) === versions.authorityGeneration;
      const fence = {
        leaseId,
        writerEpoch: currentFence
          ? decodeCanonicalVersion(currentFence.writerEpoch) + (fenceStillActive ? 0 : 1)
          : 1,
        authorityGeneration: versions.authorityGeneration,
      } as const;
      const readyNodes = await countReadyNodes(transaction, options, now);
      const expiresAt = new Date(Date.parse(now) + input.ttlMs).toISOString();
      const common = commonValues(options, now, nodeRowId(input.nodeId), {
        aggregateVersion: 0,
        authorityVersion: versions.authorityGeneration,
        effectiveVersion: versions.effectiveGeneration,
        securityVersion: versions.securityEpoch,
      });
      if (!isDeepStrictEqual(options.dialect.compatibility, input.compatibility)) {
        await upsertNode(
          transaction,
          common,
          input,
          now,
          now,
          "compatibility-rejected",
          readyNodes,
        );
        await transaction.delete("writerFences", {
          equals: {
            logicalHostId: options.identity.logicalHostId,
            storeId: options.identity.storeId,
            leaseId,
          },
        });
        return { status: "compatibility-rejected" };
      }
      if (currentNode) {
        const storedCompatibility = decodeJson(currentNode.compatibility) as {
          declared?: unknown;
        };
        if (!isDeepStrictEqual(storedCompatibility.declared, input.compatibility)) {
          return { status: "identity-conflict" };
        }
      }
      if (
        !nodeStillReady &&
        options.dialect.backend === "postgres" &&
        readyNodes >= STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes
      ) {
        await upsertNode(transaction, common, input, now, expiresAt, "capacity-rejected", 16);
        return { status: "capacity-rejected", readyNodes: 16 };
      }
      const renewedReadyNodes = nodeStillReady ? readyNodes : readyNodes + 1;
      await upsertNode(transaction, common, input, now, expiresAt, "ready", renewedReadyNodes);
      const fenceCommon = commonValues(options, now, fenceRowId(fence.leaseId), {
        aggregateVersion: 0,
        authorityVersion: versions.authorityGeneration,
        effectiveVersion: versions.effectiveGeneration,
        securityVersion: versions.securityEpoch,
      });
      await upsert(
        transaction,
        "cp_writer_fence",
        [
          ...COMMON_COLUMNS,
          "lease_id",
          "writer_epoch",
          "authority_generation",
          "expires_at",
          "state",
        ],
        [
          ...fenceCommon,
          fence.leaseId,
          fence.writerEpoch,
          fence.authorityGeneration,
          expiresAt,
          "active",
        ],
        ["logical_host_id", "id"],
      );
      return { status: "ready", readyNodes: renewedReadyNodes, writerFence: fence };
    });
  };

  const health = async (): Promise<ControlPlaneHealthSummary> => {
    if (!options.dialect.ready) {
      return {
        backend: options.dialect.backend,
        readiness: "not-ready",
        connectivity: "unavailable",
        migration: "blocked",
        authorityToken: { authorityGeneration: 0, effectiveGeneration: 0 },
        securityEpoch: 0,
        convergence: options.dialect.backend === "sqlite" ? "single-node" : "overdue",
        guidanceCode: "storage-unavailable",
      };
    }
    try {
      const versions = await initialize();
      if (options.dialect.backend === "sqlite") {
        return {
          backend: "sqlite",
          readiness: "ready",
          connectivity: "connected",
          migration: "current",
          authorityToken: {
            authorityGeneration: versions.authorityGeneration,
            effectiveGeneration: versions.effectiveGeneration,
          },
          securityEpoch: versions.securityEpoch,
          convergence: "single-node",
          guidanceCode: "ok",
        };
      }
      const nodeState = await options.dialect.snapshotTransaction(async (transaction) => {
        const now = await transaction.databaseTime();
        const rows = await transaction.select<NodeRow>("clusterNodeLeases", {
          equals: {
            logicalHostId: options.identity.logicalHostId,
            storeId: options.identity.storeId,
            state: "ready",
          },
          greaterThan: { expiresAt: now },
        });
        return {
          readyNodes: rows.length,
          allApplied: rows.every(
            (row) =>
              decodeCanonicalVersion(row.effectiveVersion) >= versions.effectiveGeneration &&
              decodeCanonicalVersion(row.authorityVersion) >= versions.authorityGeneration,
          ),
        };
      });
      const healthy = nodeState.readyNodes > 0 && nodeState.allApplied;
      return {
        backend: "postgres",
        readiness: healthy ? "ready" : "stale-read-only",
        connectivity: "connected",
        migration: "current",
        authorityToken: {
          authorityGeneration: versions.authorityGeneration,
          effectiveGeneration: versions.effectiveGeneration,
        },
        securityEpoch: versions.securityEpoch,
        convergence: healthy ? "within-budget" : "overdue",
        guidanceCode: healthy ? "ok" : "convergence-overdue",
      };
    } catch {
      return {
        backend: options.dialect.backend,
        readiness: "not-ready",
        connectivity: "unavailable",
        migration: "current",
        authorityToken: {
          authorityGeneration: lastKnownVersions.authorityGeneration,
          effectiveGeneration: lastKnownVersions.effectiveGeneration,
        },
        securityEpoch: lastKnownVersions.securityEpoch,
        convergence: options.dialect.backend === "sqlite" ? "single-node" : "overdue",
        guidanceCode: "storage-unavailable",
      };
    }
  };

  return Object.freeze({
    identity: options.identity,
    backend: options.dialect.backend,
    initialize,
    reserveOperation,
    lookupOrReserveNotCommitted,
    mutateCaplet,
    mutateHostSetting,
    loadSnapshot,
    createConfirmationPreview,
    consumeConfirmation,
    confirmExternalDestruction,
    resumeExternalDestruction,
    recordOperationalLedger,
    registerNode,
    health,
  });
}

async function runManagementMutation(
  options: ControlPlaneStoreOptions,
  input: CapletManagementMutation | HostSettingManagementMutation,
  fail: (point: ControlPlaneFailurePoint) => Promise<void>,
  reservationTtlMs: number,
  writeDomain: (transaction: ControlPlaneSqlTransaction, state: MutationState) => Promise<void>,
): Promise<ControlPlaneMutationResult> {
  if (!options.dialect.ready) return { status: "unavailable" };
  if (input.binding.logicalHostId !== options.identity.logicalHostId) {
    return { status: "denied", reason: "wrong-host" };
  }
  if (input.binding.storeId !== options.identity.storeId) {
    return { status: "denied", reason: "wrong-store" };
  }
  if (input.binding.operationNamespace !== options.identity.operationNamespace) {
    return { status: "denied", reason: "stale-authority" };
  }
  if (
    ("aggregate" in input &&
      (input.aggregate.id !== input.aggregateId ||
        input.aggregate.aggregateVersion !== input.expectedAggregateVersion + 1)) ||
    ("setting" in input && input.setting.key !== input.aggregateId)
  ) {
    return { status: "conflict", reason: "aggregate-version" };
  }
  try {
    const result = await options.dialect.runtimeTransaction(async (transaction) => {
      await transaction.lock(aggregateSerialKey(options.identity, input.aggregateId));
      await transaction.lock(operationSerialKey(input.binding));
      await fail("after-operation-lock");
      const replay = await readOutcome(transaction, options, input.binding.operationId);
      if (replay) {
        if (!bindingsEqual(replay.binding, input.binding)) {
          throw new StoreResultError({ status: "conflict", reason: "operation-reservation" });
        }
        return { status: "committed", receipt: replay } as const;
      }
      const tombstone = await readTombstone(transaction, options, input.binding.operationId);
      if (tombstone) {
        throw new StoreResultError({ status: "conflict", reason: "operation-reservation" });
      }
      const reservation = await readReservation(transaction, options, input.binding.operationId);
      const now = await transaction.databaseTime();
      if (
        !reservation ||
        reservation.state !== "reserved" ||
        reservation.aggregateId !== input.aggregateId ||
        !bindingsEqual(reservation.binding, input.binding) ||
        Date.parse(now) - Date.parse(reservation.reservedAt) > reservationTtlMs
      ) {
        throw new StoreResultError({ status: "conflict", reason: "operation-reservation" });
      }
      const currentAggregateVersion = await readAggregateVersion(
        transaction,
        options,
        "aggregate" in input ? "cp_caplet" : "cp_host_setting",
        input.aggregateId,
      );
      if (currentAggregateVersion !== input.expectedAggregateVersion) {
        throw new StoreResultError({ status: "conflict", reason: "aggregate-version" });
      }
      const effectiveStateChanged = await changesEffectiveState(transaction, options, input);
      if (effectiveStateChanged) {
        await transaction.lock(
          `effective-generation:${options.identity.logicalHostId}:${options.identity.storeId}`,
        );
      }
      const versions = await readVersions(transaction, options.identity.logicalHostId);
      if (versions.authorityGeneration !== input.expectedAuthorityGeneration) {
        throw new StoreResultError({ status: "conflict", reason: "authority-generation" });
      }
      if (versions.securityEpoch !== input.expectedSecurityEpoch) {
        throw new StoreResultError({ status: "conflict", reason: "security-epoch" });
      }
      const effectiveGeneration = effectiveStateChanged
        ? versions.effectiveGeneration + 1
        : versions.effectiveGeneration;
      const state: MutationState = { now, versions, effectiveGeneration };
      await writeDomain(transaction, state);
      await fail("after-domain-write");
      await writeProvenance(transaction, options, input, state);
      await fail("after-provenance");
      await writeActivity(transaction, options, input, state);
      await fail("after-activity");
      if (effectiveStateChanged) {
        await writeEffectiveGeneration(transaction, options, input, state);
      }
      await fail("after-generation");
      await fail("before-fence-guard");
      if (input.finalAuthorization) {
        const finalAuthorization = await input.finalAuthorization();
        if (finalAuthorization.status === "unavailable") {
          throw new StoreResultError({ status: "unavailable" });
        }
        if (finalAuthorization.status === "denied") {
          throw new StoreResultError(finalAuthorization);
        }
        if (finalAuthorization.securityEpoch !== input.expectedSecurityEpoch) {
          throw new StoreResultError({ status: "denied", reason: "stale-security" });
        }
        if (!isDeepStrictEqual(finalAuthorization.writerFence, input.writerFence)) {
          throw new StoreResultError({ status: "conflict", reason: "writer-fence" });
        }
      }
      const guardConflict = await guardWriterFence(transaction, options, input);
      if (guardConflict) {
        throw new StoreResultError({ status: "conflict", reason: guardConflict });
      }
      const receipt = createReceipt(options, input, state);
      await writeOutcome(transaction, options, input, state, receipt);
      return { status: "committed", receipt } as const;
    });
    try {
      await fail("after-receipt");
    } catch {
      return { status: "indeterminate", binding: input.binding };
    }
    return result;
  } catch (error) {
    if (error instanceof StoreResultError) return error.result;
    if (error instanceof Error && error.message.startsWith("injected:")) throw error;
    return { status: "unavailable" };
  }
}

type MutationState = Readonly<{
  now: string;
  versions: VersionRows;
  effectiveGeneration: number;
}>;

async function writeCaplet(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  input: CapletManagementMutation,
  state: MutationState,
): Promise<void> {
  const common = commonValues(options, state.now, input.aggregate.id, {
    aggregateVersion: input.aggregate.aggregateVersion,
    authorityVersion: state.versions.authorityGeneration,
    effectiveVersion: state.effectiveGeneration,
    securityVersion: state.versions.securityEpoch,
  });
  await upsert(
    transaction,
    "cp_caplet",
    [
      ...COMMON_COLUMNS,
      "name",
      "description",
      "ownership",
      "activation",
      "effective",
      "update_state",
      "portable_aggregate_id",
      "installation_provenance_id",
    ],
    [
      ...common,
      input.aggregate.portable.name,
      input.aggregate.portable.description,
      input.aggregate.ownership,
      input.aggregate.activation,
      input.aggregate.effective ? 1 : 0,
      input.aggregate.updateState,
      input.aggregate.portable.id,
      input.aggregate.installationProvenanceId ?? null,
    ],
    ["logical_host_id", "id"],
  );
  for (const table of [
    "capletActivationHistory",
    "capletAssets",
    "capletReferences",
    "capletDeclaredInputs",
    "capletCatalogTags",
    "capletCatalogs",
    "capletBackends",
    "capletDocuments",
  ] as const) {
    await transaction.delete(table, {
      equals: {
        logicalHostId: options.identity.logicalHostId,
        capletId: input.aggregate.id,
      },
    });
  }
  const documentEnvelope = {
    sourceFrontmatter: input.projection.sourceFrontmatter,
    portableBackend: input.aggregate.portable.frontmatter.backend,
  };
  await insert(
    transaction,
    "cp_caplet_document",
    [
      "logical_host_id",
      "caplet_id",
      "portable_version",
      "canonical_model_version",
      "source_path",
      "source_frontmatter",
      "body",
    ],
    [
      options.identity.logicalHostId,
      input.aggregate.id,
      input.aggregate.portable.portableVersion,
      input.aggregate.portable.canonicalModelVersion,
      input.aggregate.portable.sourcePath,
      encodeCanonicalJson(documentEnvelope),
      input.projection.body,
    ],
  );
  for (const backend of input.projection.backends) {
    await insert(
      transaction,
      "cp_caplet_backend",
      ["logical_host_id", "caplet_id", "ordinal", "kind", "child_id", "config"],
      [
        options.identity.logicalHostId,
        input.aggregate.id,
        backend.ordinal,
        backend.kind,
        backend.childId ?? null,
        encodeCanonicalJson(backend.config),
      ],
    );
  }
  const catalog = input.aggregate.portable.frontmatter.catalog;
  if (catalog) {
    await insert(
      transaction,
      "cp_caplet_catalog",
      [
        "logical_host_id",
        "caplet_id",
        "display_name",
        "summary",
        "icon_type",
        "icon_path",
        "icon_url",
      ],
      [
        options.identity.logicalHostId,
        input.aggregate.id,
        catalog.displayName ?? null,
        catalog.summary ?? null,
        catalog.icon?.type ?? null,
        catalog.icon?.type === "local" ? catalog.icon.path : null,
        catalog.icon?.type === "external" ? catalog.icon.url : null,
      ],
    );
    for (const [ordinal, tag] of (catalog.tags ?? []).entries()) {
      await insert(
        transaction,
        "cp_caplet_catalog_tag",
        ["logical_host_id", "caplet_id", "ordinal", "tag"],
        [options.identity.logicalHostId, input.aggregate.id, ordinal, tag],
      );
    }
  }
  for (const [ordinal, declared] of input.aggregate.portable.frontmatter.declaredInputs.entries()) {
    await insert(
      transaction,
      "cp_caplet_declared_input",
      [
        "logical_host_id",
        "caplet_id",
        "ordinal",
        "name",
        "reference_type",
        "path",
        "url",
        "setup_name",
      ],
      [
        options.identity.logicalHostId,
        input.aggregate.id,
        ordinal,
        declared.name,
        declared.reference.type,
        declared.reference.type === "local" ? declared.reference.path : null,
        declared.reference.type === "external" ? declared.reference.url : null,
        declared.reference.type === "unresolved-setup" ? declared.reference.name : null,
      ],
    );
  }
  for (const reference of input.projection.references) {
    await insert(
      transaction,
      "cp_caplet_reference",
      [
        "logical_host_id",
        "caplet_id",
        "ordinal",
        "owner",
        "reference_type",
        "path",
        "url",
        "setup_name",
      ],
      [
        options.identity.logicalHostId,
        input.aggregate.id,
        reference.ordinal,
        reference.reference.owner,
        reference.reference.type,
        reference.reference.type === "local" ? reference.reference.path : null,
        reference.reference.type === "external" ? reference.reference.url : null,
        reference.reference.type === "unresolved-setup" ? reference.reference.name : null,
      ],
    );
  }
  for (const asset of input.projection.assets) {
    await insert(
      transaction,
      "cp_caplet_asset",
      [
        "logical_host_id",
        "caplet_id",
        "ordinal",
        "path",
        "role",
        "media_type",
        "bytes",
        "content_hash",
        "byte_length",
      ],
      [
        options.identity.logicalHostId,
        input.aggregate.id,
        asset.ordinal,
        asset.path,
        asset.role,
        asset.mediaType,
        encodeCanonicalBytes(asset.content),
        asset.contentHash,
        asset.content.byteLength,
      ],
    );
  }
  for (const event of input.projection.activationHistory) {
    await insert(
      transaction,
      "cp_caplet_activation_history",
      [
        "logical_host_id",
        "caplet_id",
        "sequence",
        "from_state",
        "to_state",
        "reason",
        "actor_id",
        "aggregate_version",
        "authority_version",
        "effective_version",
        "occurred_at",
      ],
      [
        options.identity.logicalHostId,
        input.aggregate.id,
        event.sequence,
        event.from,
        event.to,
        event.reason,
        event.actorId,
        event.aggregateVersion,
        event.authorityVersion,
        event.effectiveVersion,
        encodeCanonicalTimestamp(event.occurredAt),
      ],
    );
  }
}

async function writeHostSetting(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  input: HostSettingManagementMutation,
  state: MutationState,
): Promise<void> {
  const common = commonValues(options, state.now, input.aggregateId, {
    aggregateVersion: input.expectedAggregateVersion + 1,
    authorityVersion: state.versions.authorityGeneration,
    effectiveVersion: state.effectiveGeneration,
    securityVersion: state.versions.securityEpoch,
  });
  const hostCommon = [...common];
  hostCommon[5] = encodeCanonicalTimestamp(input.setting.updatedAt);
  await upsert(
    transaction,
    "cp_host_setting",
    [
      ...COMMON_COLUMNS,
      "key",
      "value",
      "ownership",
      "activation",
      "effective",
      "provenance_id",
      "provenance_source_kind",
      "provenance_source",
      "provenance_content_hash",
      "provenance_runtime_fingerprint",
      "provenance_installed_at",
      "provenance_resolved_revision",
      "provenance_risk_summary",
      "provenance_owner_id",
    ],
    [
      ...hostCommon,
      input.setting.key,
      encodeCanonicalJson(input.setting.value),
      "sql",
      "active",
      1,
      input.provenance.id,
      input.provenance.sourceKind,
      encodeCanonicalJson(input.provenance.source),
      input.provenance.contentHash,
      input.provenance.runtimeFingerprint ?? null,
      input.provenance.installedAt ? encodeCanonicalTimestamp(input.provenance.installedAt) : null,
      input.provenance.resolvedRevision ?? null,
      encodeCanonicalJson(input.provenance.riskSummary ?? {}),
      input.provenance.ownerId ?? null,
    ],
    ["logical_host_id", "id"],
  );
}

async function writeProvenance(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  input: CapletManagementMutation | HostSettingManagementMutation,
  state: MutationState,
): Promise<void> {
  if (!("aggregate" in input)) return;
  const common = commonValues(options, state.now, input.provenance.id, {
    aggregateVersion: input.aggregate.aggregateVersion,
    authorityVersion: state.versions.authorityGeneration,
    effectiveVersion: state.effectiveGeneration,
    securityVersion: state.versions.securityEpoch,
  });
  await insert(
    transaction,
    "cp_caplet_provenance",
    [
      ...COMMON_COLUMNS,
      "caplet_id",
      "source_kind",
      "source",
      "content_hash",
      "runtime_fingerprint",
      "installed_at",
      "resolved_revision",
      "risk_summary",
      "owner_id",
    ],
    [
      ...common,
      input.aggregate.id,
      input.provenance.sourceKind,
      encodeCanonicalJson(input.provenance.source),
      input.provenance.contentHash,
      input.provenance.runtimeFingerprint ?? null,
      input.provenance.installedAt ?? null,
      input.provenance.resolvedRevision ?? null,
      encodeCanonicalJson(input.provenance.riskSummary ?? {}),
      input.provenance.ownerId ?? null,
    ],
  );
}

async function writeActivity(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  input: CapletManagementMutation | HostSettingManagementMutation,
  state: MutationState,
): Promise<void> {
  const common = commonValues(options, state.now, input.activity.id, {
    aggregateVersion:
      "aggregate" in input ? input.aggregate.aggregateVersion : input.expectedAggregateVersion + 1,
    authorityVersion: state.versions.authorityGeneration,
    effectiveVersion: state.effectiveGeneration,
    securityVersion: state.versions.securityEpoch,
  });
  const detail = sanitizeActivityDetail({
    ...input.activity.detail,
    provenanceId: input.provenance.id,
    provenanceKind: input.provenance.sourceKind,
    provenanceHash: input.provenance.contentHash,
    operationId: input.binding.operationId,
  });
  await insert(
    transaction,
    "cp_operator_activity",
    [
      ...COMMON_COLUMNS,
      "activity_id",
      "actor_id",
      "action",
      "outcome",
      "target",
      "redacted_detail",
      "occurred_at",
    ],
    [
      ...common,
      input.activity.id,
      input.binding.actorId,
      input.activity.action,
      "success",
      encodeCanonicalJson(sanitizeActivityDetail(input.activity.target)),
      encodeCanonicalJson(detail),
      state.now,
    ],
  );
}

async function writeEffectiveGeneration(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  input: CapletManagementMutation | HostSettingManagementMutation,
  state: MutationState,
): Promise<void> {
  const id = `effective:${state.effectiveGeneration}`;
  const common = commonValues(options, state.now, id, {
    aggregateVersion: state.effectiveGeneration,
    authorityVersion: state.versions.authorityGeneration,
    effectiveVersion: state.effectiveGeneration,
    securityVersion: state.versions.securityEpoch,
  });
  await insert(
    transaction,
    "cp_effective_version",
    [...COMMON_COLUMNS, "generation", "snapshot_hash", "applied_token", "published_at"],
    [
      ...common,
      state.effectiveGeneration,
      sha256(`${input.aggregateId}:${input.expectedAggregateVersion + 1}`),
      authorityTokenText(state.versions.authorityGeneration, state.effectiveGeneration),
      state.now,
    ],
  );
}

async function changesEffectiveState(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  input: CapletManagementMutation | HostSettingManagementMutation,
): Promise<boolean> {
  if ("setting" in input) return true;
  const current = await transaction.select<ControlPlaneSqlRow>(
    "caplets",
    {
      equals: {
        logicalHostId: options.identity.logicalHostId,
        storeId: options.identity.storeId,
        id: input.aggregateId,
      },
    },
    [],
    1,
  );
  return input.aggregate.effective || booleanValue(current[0]?.effective);
}

async function guardWriterFence(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  input: CapletManagementMutation | HostSettingManagementMutation,
): Promise<ControlPlaneConflictReason | undefined> {
  await transaction.lock(
    `authority-generation:${options.identity.logicalHostId}:${options.identity.storeId}`,
  );
  await transaction.lock(
    `security-epoch:${options.identity.logicalHostId}:${options.identity.storeId}`,
  );
  const current = await readVersions(transaction, options.identity.logicalHostId);
  if (current.authorityGeneration !== input.expectedAuthorityGeneration) {
    return "authority-generation";
  }
  if (current.securityEpoch !== input.expectedSecurityEpoch) {
    return "security-epoch";
  }
  const now = await transaction.databaseTime();
  const changed = await transaction.update(
    "writerFences",
    { updatedAt: now },
    {
      equals: {
        logicalHostId: options.identity.logicalHostId,
        storeId: options.identity.storeId,
        leaseId: input.writerFence.leaseId,
        writerEpoch: input.writerFence.writerEpoch,
        authorityGeneration: input.expectedAuthorityGeneration,
        state: "active",
      },
      greaterThan: { expiresAt: now },
    },
  );
  return changed === 1 ? undefined : "writer-fence";
}

function createReceipt(
  options: ControlPlaneStoreOptions,
  input: CapletManagementMutation | HostSettingManagementMutation,
  state: MutationState,
): CurrentHostOperationReceipt {
  const aggregateVersion =
    "aggregate" in input ? input.aggregate.aggregateVersion : input.expectedAggregateVersion + 1;
  return Object.freeze({
    status: "committed" as const,
    binding: Object.freeze({ ...input.binding }),
    aggregateVersion,
    authorityToken: Object.freeze({
      authorityGeneration: state.versions.authorityGeneration,
      effectiveGeneration: state.effectiveGeneration,
    }),
    localApplication: "applied" as const,
    convergence:
      options.dialect.backend === "sqlite"
        ? ({ kind: "single-node" } as const)
        : ({
            kind: "pending" as const,
            deadline: new Date(Date.parse(state.now) + 5_000).toISOString(),
          } as const),
  });
}

async function writeOutcome(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  input: CapletManagementMutation | HostSettingManagementMutation,
  state: MutationState,
  receipt: CurrentHostOperationReceipt,
): Promise<void> {
  const receiptJson = encodeCanonicalJson(receipt);
  const common = commonValues(options, state.now, outcomeRowId(input.binding.operationId), {
    aggregateVersion: receipt.aggregateVersion,
    authorityVersion: state.versions.authorityGeneration,
    effectiveVersion: state.effectiveGeneration,
    securityVersion: state.versions.securityEpoch,
  });
  await insert(
    transaction,
    "cp_operation_outcome",
    [
      ...COMMON_COLUMNS,
      "operation_id",
      "operation_class",
      "request_hash",
      "receipt_hash",
      "receipt",
      "result_aggregate_version",
      "result_authority_version",
      "result_effective_version",
      "convergence_class",
    ],
    [
      ...common,
      input.binding.operationId,
      input.binding.operationClass,
      sha256(input.binding.requestIdentity),
      sha256(receiptJson),
      databaseJson(transaction, receipt),
      receipt.aggregateVersion,
      state.versions.authorityGeneration,
      state.effectiveGeneration,
      receipt.convergence.kind,
    ],
  );
  const changed = await transaction.update(
    "operationReservations",
    { state: "committed", committedAt: state.now, updatedAt: state.now },
    {
      equals: {
        logicalHostId: options.identity.logicalHostId,
        storeId: options.identity.storeId,
        operationId: input.binding.operationId,
        state: "reserved",
      },
    },
  );
  if (changed !== 1) {
    throw new StoreResultError({ status: "conflict", reason: "operation-reservation" });
  }
}

async function readSnapshot(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  versions: VersionRows,
): Promise<ControlPlaneSnapshot> {
  const hostRows = await transaction.select<HostSettingRow>(
    "hostSettings",
    {
      equals: {
        logicalHostId: options.identity.logicalHostId,
        storeId: options.identity.storeId,
      },
    },
    [{ column: "key" }],
  );
  const capletRows = await transaction.select<CapletRow>(
    "caplets",
    {
      equals: {
        logicalHostId: options.identity.logicalHostId,
        storeId: options.identity.storeId,
      },
    },
    [{ column: "id" }],
  );
  const documents = groupByCaplet(
    await queryChildren<DocumentRow>(transaction, options, "capletDocuments"),
  );
  const backends = groupByCaplet(
    await queryChildren<BackendRow>(transaction, options, "capletBackends", ["ordinal"]),
  );
  const catalogs = groupByCaplet(
    await queryChildren<CatalogRow>(transaction, options, "capletCatalogs"),
  );
  const tags = groupByCaplet(
    await queryChildren<TagRow>(transaction, options, "capletCatalogTags", ["ordinal"]),
  );
  const inputs = groupByCaplet(
    await queryChildren<InputRow>(transaction, options, "capletDeclaredInputs", ["ordinal"]),
  );
  const references = groupByCaplet(
    await queryChildren<ReferenceRow>(transaction, options, "capletReferences", ["ordinal"]),
  );
  const assets = groupByCaplet(
    await queryChildren<AssetRow>(transaction, options, "capletAssets", ["ordinal"]),
  );
  const history = groupByCaplet(
    await queryChildren<HistoryRow>(transaction, options, "capletActivationHistory", ["sequence"]),
  );
  const caplets = capletRows.map((row) =>
    hydrateCaplet(
      row,
      documents.get(row.id)?.[0],
      backends.get(row.id) ?? [],
      catalogs.get(row.id)?.[0],
      tags.get(row.id) ?? [],
      inputs.get(row.id) ?? [],
      references.get(row.id) ?? [],
      assets.get(row.id) ?? [],
      history.get(row.id) ?? [],
    ),
  );
  const hostSettings = hostRows.map((row) =>
    parseCanonicalHostSetting({
      version: 1,
      key: row.key,
      value: decodeJson(row.value),
      updatedAt: decodeCanonicalTimestamp(row.updatedAt),
    }),
  );
  const encodedBytes = caplets.reduce(
    (total, entry) => total + encodePortableCaplet(entry.aggregate.portable).byteLength,
    0,
  );
  const normalizedRows =
    hostRows.length +
    capletRows.length +
    [
      ...documents,
      ...backends,
      ...catalogs,
      ...tags,
      ...inputs,
      ...references,
      ...assets,
      ...history,
    ].reduce((total, [, rows]) => total + rows.length, 0);
  return Object.freeze({
    identity: Object.freeze({ ...options.identity }),
    versions: Object.freeze(versions),
    caplets: Object.freeze(caplets),
    hostSettings: Object.freeze(hostSettings),
    encodedBytes,
    normalizedRows,
  });
}

function hydrateCaplet(
  row: CapletRow,
  document: DocumentRow | undefined,
  backendRows: readonly BackendRow[],
  catalogRow: CatalogRow | undefined,
  tagRows: readonly TagRow[],
  inputRows: readonly InputRow[],
  referenceRows: readonly ReferenceRow[],
  assetRows: readonly AssetRow[],
  historyRows: readonly HistoryRow[],
): Readonly<{
  aggregate: CanonicalCapletAggregate;
  projection: CanonicalCapletRelationalProjection;
}> {
  if (!document) throw new Error(`Stored Caplet ${row.id} has no document row`);
  const documentEnvelope = decodeJson(document.sourceFrontmatter) as {
    sourceFrontmatter: PortableJson;
    portableBackend: CanonicalCapletAggregate["portable"]["frontmatter"]["backend"];
  };
  const projectionAssets = assetRows.map((asset) => ({
    capletId: row.id,
    ordinal: decodeCanonicalVersion(asset.ordinal),
    path: asset.path,
    role: asset.role as CanonicalCapletRelationalProjection["assets"][number]["role"],
    mediaType: asset.mediaType,
    content: decodeCanonicalBytes(asset.bytes),
    contentHash: asset.contentHash,
  }));
  const projectionReferences = referenceRows.map((reference) => ({
    capletId: row.id,
    ordinal: decodeCanonicalVersion(reference.ordinal),
    reference: referenceFromRow(reference),
  }));
  const projection: CanonicalCapletRelationalProjection = {
    capletId: row.id,
    sourceFrontmatter: documentEnvelope.sourceFrontmatter,
    body: document.body,
    backends: backendRows.map((backend) => ({
      capletId: row.id,
      ordinal: decodeCanonicalVersion(backend.ordinal),
      kind: backend.kind as CanonicalCapletRelationalProjection["backends"][number]["kind"],
      ...(backend.childId === null || backend.childId === undefined
        ? {}
        : { childId: backend.childId }),
      config: decodeJson(backend.config),
    })),
    assets: projectionAssets,
    references: projectionReferences,
    activationHistory: historyRows.map((event) => ({
      capletId: row.id,
      sequence: decodeCanonicalVersion(event.sequence),
      from: event.fromState as CanonicalCapletRelationalProjection["activationHistory"][number]["from"],
      to: event.toState as CanonicalCapletRelationalProjection["activationHistory"][number]["to"],
      reason:
        event.reason as CanonicalCapletRelationalProjection["activationHistory"][number]["reason"],
      actorId: event.actorId,
      aggregateVersion: decodeCanonicalVersion(event.aggregateVersion),
      authorityVersion: decodeCanonicalVersion(event.authorityVersion),
      effectiveVersion: decodeCanonicalVersion(event.effectiveVersion),
      occurredAt: decodeCanonicalTimestamp(event.occurredAt),
    })),
  };
  const catalog = catalogRow
    ? {
        ...(catalogRow.displayName ? { displayName: catalogRow.displayName } : {}),
        ...(catalogRow.summary ? { summary: catalogRow.summary } : {}),
        ...(tagRows.length > 0 ? { tags: tagRows.map((tag) => tag.tag) } : {}),
        ...(catalogRow.iconType === "local" && catalogRow.iconPath
          ? { icon: { type: "local" as const, path: catalogRow.iconPath } }
          : catalogRow.iconType === "external" && catalogRow.iconUrl
            ? { icon: { type: "external" as const, url: catalogRow.iconUrl } }
            : {}),
      }
    : undefined;
  const aggregate: CanonicalCapletAggregate = {
    modelVersion: 1,
    id: row.id,
    aggregateVersion: decodeCanonicalVersion(row.aggregateVersion),
    ownership: row.ownership as CanonicalCapletAggregate["ownership"],
    activation: row.activation as CanonicalCapletAggregate["activation"],
    effective: booleanValue(row.effective),
    ...(row.installationProvenanceId
      ? { installationProvenanceId: row.installationProvenanceId }
      : {}),
    portable: {
      portableVersion: 1,
      canonicalModelVersion: 1,
      id: row.id,
      name: row.name,
      description: row.description,
      sourcePath: document.sourcePath,
      frontmatter: {
        source: documentEnvelope.sourceFrontmatter,
        backend: documentEnvelope.portableBackend,
        ...(catalog ? { catalog } : {}),
        declaredInputs: inputRows.map((input) => ({
          name: input.name,
          reference: inputReferenceFromRow(input),
        })),
      },
      body: document.body,
      assets: projectionAssets.map((asset) => ({
        path: asset.path,
        role: asset.role,
        mediaType: asset.mediaType,
        encoding: "base64" as const,
        content: Buffer.from(asset.content).toString("base64"),
        contentHash: asset.contentHash,
        byteLength: asset.content.byteLength,
      })),
      references: projectionReferences.map((reference) => reference.reference),
    },
    updateState: row.updateState as CanonicalCapletAggregate["updateState"],
  };
  validateCapletRelationalProjection(aggregate, projection);
  return Object.freeze({
    aggregate: Object.freeze(aggregate),
    projection: Object.freeze(projection),
  });
}

async function readVersions(
  transaction: ControlPlaneSqlTransaction,
  logicalHostId: string,
): Promise<VersionRows> {
  const authority = await transaction.select<AuthorityVersionRow>(
    "authorityVersions",
    { equals: { logicalHostId } },
    [{ column: "generation", direction: "desc" }],
    1,
  );
  const effective = await transaction.select<EffectiveVersionRow>(
    "effectiveVersions",
    { equals: { logicalHostId } },
    [{ column: "generation", direction: "desc" }],
    1,
  );
  const security = await transaction.select<SecurityVersionRow>(
    "securityVersions",
    { equals: { logicalHostId } },
    [{ column: "epoch", direction: "desc" }],
    1,
  );
  if (!authority[0] || !effective[0] || !security[0]) {
    throw new Error("Control-plane versions are not initialized");
  }
  return {
    authorityGeneration: decodeCanonicalVersion(authority[0].generation),
    effectiveGeneration: decodeCanonicalVersion(effective[0].generation),
    securityEpoch: decodeCanonicalVersion(security[0].epoch),
  };
}

async function readAggregateVersion(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  table: "cp_caplet" | "cp_host_setting",
  id: string,
): Promise<number> {
  const rows = await transaction.select<AggregateVersionRow>(
    table === "cp_caplet" ? "caplets" : "hostSettings",
    {
      equals: {
        logicalHostId: options.identity.logicalHostId,
        storeId: options.identity.storeId,
        id,
      },
    },
  );
  return rows[0] ? decodeCanonicalVersion(rows[0].aggregateVersion) : 0;
}

async function readReservation(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  operationId: string,
): Promise<
  | Readonly<{
      binding: CurrentHostOperationBinding;
      aggregateId?: string | undefined;
      state: string;
      reservedAt: string;
    }>
  | undefined
> {
  const rows = await transaction.select<ReservationRow>("operationReservations", {
    equals: {
      logicalHostId: options.identity.logicalHostId,
      storeId: options.identity.storeId,
      operationId,
    },
  });
  const row = rows[0];
  if (!row) return undefined;
  const target = decodeJson(row.target) as OperationTarget;
  return {
    binding: target.binding,
    aggregateId: target.aggregateId,
    state: row.state,
    reservedAt: decodeCanonicalTimestamp(row.reservedAt),
  };
}

async function readOutcome(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  operationId: string,
): Promise<CurrentHostOperationReceipt | undefined> {
  const rows = await transaction.select<OutcomeRow>("operationOutcomes", {
    equals: {
      logicalHostId: options.identity.logicalHostId,
      storeId: options.identity.storeId,
      operationId,
    },
  });
  return rows[0] ? (decodeJson(rows[0].receipt) as CurrentHostOperationReceipt) : undefined;
}

async function readTombstone(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  operationId: string,
): Promise<
  Readonly<{ binding: CurrentHostOperationBinding; retryReservationId?: string }> | undefined
> {
  const rows = await transaction.select<TombstoneRow>("operationTombstones", {
    equals: {
      logicalHostId: options.identity.logicalHostId,
      storeId: options.identity.storeId,
      operationId,
    },
  });
  if (!rows[0]) return undefined;
  const target = decodeJson(rows[0].target) as OperationTarget;
  return {
    binding: target.binding,
    ...(target.retryReservationId ? { retryReservationId: target.retryReservationId } : {}),
  };
}

async function readDestruction(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  destructionId: string,
): Promise<
  | Readonly<{
      status: ExternalDestructionStatus;
      material: ExternalDestructionIntent["material"];
      inventoryHash: string;
      providerIdentity: string;
      updatedAt: string;
      claim?: Readonly<{ token: string; expiresAt: string }> | undefined;
    }>
  | undefined
> {
  const rows = await transaction.select<DestructionRow>("externalDestructions", {
    equals: {
      logicalHostId: options.identity.logicalHostId,
      storeId: options.identity.storeId,
      destructionId,
    },
  });
  const row = rows[0];
  if (!row) return undefined;
  const phase = row.phase as ExternalDestructionStatus["phase"];
  const persistedReceipt =
    row.receipt === null || row.receipt === undefined ? undefined : decodeJson(row.receipt);
  const claim =
    phase === "in-progress" && isExternalDestructionClaim(persistedReceipt)
      ? persistedReceipt
      : undefined;
  return {
    status: {
      destructionId,
      phase,
      ...(row.completedAt ? { completedAt: decodeCanonicalTimestamp(row.completedAt) } : {}),
      ...(phase === "completed" && persistedReceipt && typeof persistedReceipt === "object"
        ? { receipt: persistedReceipt as Readonly<Record<string, unknown>> }
        : {}),
    },
    material: decodeJson(row.intent) as unknown as ExternalDestructionIntent["material"],
    inventoryHash: row.inventoryHash,
    providerIdentity: row.providerIdentity,
    updatedAt: row.updatedAt,
    ...(claim ? { claim } : {}),
  };
}

function isExternalDestructionClaim(
  value: unknown,
): value is Readonly<{ token: string; expiresAt: string }> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.token === "string" && typeof candidate.expiresAt === "string";
}

async function releaseExternalDestructionClaim(
  options: ControlPlaneStoreOptions,
  destructionId: string,
  claimToken: string,
): Promise<void> {
  await options.dialect.runtimeTransaction(async (transaction) => {
    await transaction.lock(`destruction:${destructionId}`);
    const current = await readDestruction(transaction, options, destructionId);
    if (current?.status.phase !== "in-progress" || current.claim?.token !== claimToken) return;
    const now = await transaction.databaseTime();
    await transaction.update(
      "externalDestructions",
      {
        receipt: databaseJson(transaction, { token: claimToken, expiresAt: now }),
        updatedAt: now,
      },
      {
        equals: {
          logicalHostId: options.identity.logicalHostId,
          storeId: options.identity.storeId,
          destructionId,
          phase: "in-progress",
          updatedAt: current.updatedAt,
        },
      },
    );
  });
}

async function countReadyNodes(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  now: string,
): Promise<number> {
  const rows = await transaction.select<NodeRow>("clusterNodeLeases", {
    equals: {
      logicalHostId: options.identity.logicalHostId,
      storeId: options.identity.storeId,
      state: "ready",
    },
    greaterThan: { expiresAt: now },
  });
  return rows.length;
}

async function upsertNode(
  transaction: ControlPlaneSqlTransaction,
  common: readonly unknown[],
  input: ControlPlaneNodeRegistration,
  now: string,
  expiresAt: string,
  state: "ready" | "capacity-rejected" | "compatibility-rejected",
  assignedReadyNodes: number,
): Promise<void> {
  await upsert(
    transaction,
    "cp_cluster_node_lease",
    [
      ...COMMON_COLUMNS,
      "node_id",
      "bootstrap_fingerprint",
      "compatibility",
      "heartbeat_at",
      "expires_at",
      "state",
    ],
    [
      ...common,
      input.nodeId,
      /^[a-f0-9]{64}$/u.test(input.bootstrapFingerprint)
        ? input.bootstrapFingerprint
        : sha256(input.bootstrapFingerprint),
      encodeCanonicalJson({ declared: input.compatibility, assignedReadyNodes }),
      now,
      expiresAt,
      state,
    ],
    ["logical_host_id", "id"],
  );
}

function commonValues(
  options: ControlPlaneStoreOptions,
  now: string,
  id: string,
  versions: CommonVersions,
): readonly unknown[] {
  return [
    1,
    id,
    options.identity.logicalHostId,
    options.identity.storeId,
    now,
    now,
    versions.aggregateVersion,
    versions.authorityVersion,
    versions.effectiveVersion,
    versions.securityVersion,
  ];
}

const TABLE_BY_SQL_NAME: Readonly<Record<string, ControlPlaneTable>> = {
  cp_host_setting: "hostSettings",
  cp_caplet: "caplets",
  cp_caplet_provenance: "capletProvenance",
  cp_operation_namespace: "operationNamespaces",
  cp_operation_reservation: "operationReservations",
  cp_operation_outcome: "operationOutcomes",
  cp_operation_tombstone: "operationTombstones",
  cp_confirmation: "confirmations",
  cp_operator_activity: "operatorActivities",
  cp_authority_version: "authorityVersions",
  cp_effective_version: "effectiveVersions",
  cp_security_version: "securityVersions",
  cp_cluster_node_lease: "clusterNodeLeases",
  cp_writer_fence: "writerFences",
  cp_migration: "migrations",
  cp_retention: "retentions",
  cp_external_destruction: "externalDestructions",
  cp_caplet_document: "capletDocuments",
  cp_caplet_backend: "capletBackends",
  cp_caplet_catalog: "capletCatalogs",
  cp_caplet_catalog_tag: "capletCatalogTags",
  cp_caplet_declared_input: "capletDeclaredInputs",
  cp_caplet_reference: "capletReferences",
  cp_caplet_asset: "capletAssets",
  cp_caplet_activation_history: "capletActivationHistory",
};

async function insert(
  transaction: ControlPlaneSqlTransaction,
  table: string,
  columns: readonly string[],
  values: readonly unknown[],
): Promise<void> {
  await transaction.insert(
    requireTable(table),
    rowFromColumns(transaction, table, columns, values),
  );
}

async function insertIgnore(
  transaction: ControlPlaneSqlTransaction,
  table: string,
  columns: readonly string[],
  values: readonly unknown[],
  conflictColumns: readonly string[],
): Promise<void> {
  await transaction.insert(
    requireTable(table),
    rowFromColumns(transaction, table, columns, values),
    { target: conflictColumns.map(sqlColumnToProperty) },
  );
}

async function upsert(
  transaction: ControlPlaneSqlTransaction,
  table: string,
  columns: readonly string[],
  values: readonly unknown[],
  conflictColumns: readonly string[],
): Promise<void> {
  const tableName = requireTable(table);
  const row = rowFromColumns(transaction, table, columns, values);
  const conflict = new Set(conflictColumns.map(sqlColumnToProperty));
  const equals = Object.fromEntries([...conflict].map((property) => [property, row[property]]));
  const existing = await transaction.select(tableName, { equals }, [], 1);
  if (existing.length === 0) {
    await transaction.insert(tableName, row);
    return;
  }
  const update = Object.fromEntries(
    Object.entries(row).filter(([property]) => !conflict.has(property) && property !== "createdAt"),
  );
  await transaction.update(tableName, update, { equals });
}

function rowFromColumns(
  transaction: ControlPlaneSqlTransaction,
  table: string,
  columns: readonly string[],
  values: readonly unknown[],
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    columns.map((column, index) => [
      sqlColumnToProperty(column),
      jsonColumn(table, column) ? databaseJson(transaction, values[index]) : values[index],
    ]),
  );
}

function requireTable(sqlName: string): ControlPlaneTable {
  const table = TABLE_BY_SQL_NAME[sqlName];
  if (!table) throw new Error(`Unsupported control-plane table ${sqlName}`);
  return table;
}

function sqlColumnToProperty(column: string): string {
  return column.replace(/_([a-z])/gu, (_, character: string) => character.toUpperCase());
}

const JSON_COLUMNS_BY_TABLE: Readonly<Record<string, readonly string[]>> = {
  cp_host_setting: ["value"],
  cp_caplet_provenance: ["source", "risk_summary"],
  cp_operation_reservation: ["target"],
  cp_operation_outcome: ["receipt"],
  cp_operation_tombstone: ["target"],
  cp_confirmation: ["affected_inventory"],
  cp_operator_activity: ["target", "redacted_detail"],
  cp_cluster_node_lease: ["compatibility"],
  cp_migration: ["compatibility"],
  cp_external_destruction: ["intent", "receipt"],
  cp_caplet_document: ["source_frontmatter"],
  cp_caplet_backend: ["config"],
};

function jsonColumn(table: string, column: string): boolean {
  return JSON_COLUMNS_BY_TABLE[table]?.includes(column) ?? false;
}

function databaseJson(transaction: ControlPlaneSqlTransaction, value: unknown): unknown {
  const canonical = typeof value === "string" ? decodeCanonicalJson(value) : decodeJson(value);
  return transaction.backend === "sqlite" ? encodeCanonicalJson(canonical) : canonical;
}

async function queryChildren<Row extends ControlPlaneSqlRow & { capletId: string }>(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  table: ControlPlaneTable,
  order: readonly string[] = [],
): Promise<readonly Row[]> {
  return transaction.select<Row>(
    table,
    { equals: { logicalHostId: options.identity.logicalHostId } },
    [{ column: "capletId" }, ...order.map((column) => ({ column }))],
  );
}

function groupByCaplet<Row extends { capletId: string }>(
  rows: readonly Row[],
): Map<string, readonly Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const existing = grouped.get(row.capletId);
    if (existing) existing.push(row);
    else grouped.set(row.capletId, [row]);
  }
  return grouped;
}

function decodeJson(value: unknown): PortableJson {
  if (typeof value === "string") return decodeCanonicalJson(value);
  return decodeCanonicalJson(encodeCanonicalJson(value));
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === 1n;
}

function referenceFromRow(row: ReferenceRow) {
  if (row.referenceType === "local" && row.path) {
    return { type: "local" as const, owner: row.owner, path: row.path };
  }
  if (row.referenceType === "external" && row.url) {
    return { type: "external" as const, owner: row.owner, url: row.url };
  }
  if (row.referenceType === "unresolved-setup" && row.setupName) {
    return { type: "unresolved-setup" as const, owner: row.owner, name: row.setupName };
  }
  throw new Error("Stored Caplet reference is invalid");
}

function inputReferenceFromRow(row: InputRow) {
  if (row.referenceType === "local" && row.path) return { type: "local" as const, path: row.path };
  if (row.referenceType === "external" && row.url) {
    return { type: "external" as const, url: row.url };
  }
  if (row.referenceType === "unresolved-setup" && row.setupName) {
    return { type: "unresolved-setup" as const, name: row.setupName };
  }
  throw new Error("Stored declared input reference is invalid");
}

const SAFE_ACTIVITY_KEYS = new Set([
  "type",
  "id",
  "key",
  "kind",
  "status",
  "count",
  "capletId",
  "aggregateId",
  "operationId",
  "provenanceId",
  "provenanceKind",
  "provenanceHash",
]);

function sanitizeActivityDetail(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string | number | boolean | null>> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, nested] of Object.entries(value).slice(0, 32)) {
    if (!SAFE_ACTIVITY_KEYS.has(key)) continue;
    if (nested === null || typeof nested === "number" || typeof nested === "boolean") {
      result[key] = nested;
    } else if (typeof nested === "string" && nested.length <= 256 && !looksSensitive(nested)) {
      result[key] = nested;
    }
  }
  return Object.freeze(result);
}

function looksSensitive(value: string): boolean {
  return (
    /(?:bearer|basic)\s+[A-Za-z0-9+/=_-]+/iu.test(value) ||
    /(?:^|[\\/])(?:home|users|var|tmp|etc)(?:[\\/]|$)/iu.test(value) ||
    /^[A-Za-z]:\\/u.test(value) ||
    /^(?:gh[opsu]_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.)/u.test(value) ||
    /(?:postgres(?:ql)?|https?|file):\/\//iu.test(value)
  );
}

function bindingsEqual(
  left: CurrentHostOperationBinding,
  right: CurrentHostOperationBinding,
): boolean {
  return isDeepStrictEqual(left, right);
}

function matchesStore(
  options: ControlPlaneStoreOptions,
  binding: CurrentHostOperationBinding,
): boolean {
  return (
    binding.logicalHostId === options.identity.logicalHostId &&
    binding.storeId === options.identity.storeId &&
    binding.operationNamespace === options.identity.operationNamespace
  );
}

function requireReady(options: ControlPlaneStoreOptions): void {
  if (!options.dialect.ready) throw new Error("Control-plane store is unavailable");
}

function authorityTokenText(authorityGeneration: number, effectiveGeneration: number): string {
  return `${authorityGeneration}:${effectiveGeneration}`;
}

function inventoryHash(versions: readonly string[]): string {
  return sha256(encodeCanonicalJson([...versions].sort()));
}

function externalDestructionAffectedVersions(intent: ExternalDestructionIntent): readonly string[] {
  const material = intent.material.map((item) => `${item.kind}:${item.id}`).sort();
  return [`provider:${intent.providerIdentity}`, ...material];
}

function sameVersions(left: VersionRows, right: VersionRows): boolean {
  return (
    left.authorityGeneration === right.authorityGeneration &&
    left.effectiveGeneration === right.effectiveGeneration &&
    left.securityEpoch === right.securityEpoch
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function operationSerialKey(binding: CurrentHostOperationBinding): string {
  return `operation:${binding.logicalHostId}:${binding.storeId}:${binding.operationNamespace}:${binding.operationId}`;
}

function retryReservationId(binding: CurrentHostOperationBinding): string {
  return `retry_${sha256(encodeCanonicalJson(binding)).slice(0, 24)}`;
}

function operationRowId(operationId: string): string {
  return `operation:${operationId}`;
}

function outcomeRowId(operationId: string): string {
  return `outcome:${operationId}`;
}

function tombstoneRowId(operationId: string): string {
  return `tombstone:${operationId}`;
}

function aggregateSerialKey(identity: ControlPlaneStoreIdentity, aggregateId: string): string {
  return `aggregate:${identity.logicalHostId}:${identity.storeId}:${aggregateId}`;
}

function confirmationRowId(tokenId: string): string {
  return `confirmation:${tokenId}`;
}

function destructionRowId(destructionId: string): string {
  return `destruction:${destructionId}`;
}

function ledgerRowId(kind: string, id: string): string {
  return `ledger:${kind}:${id}`;
}

function nodeRowId(nodeId: string): string {
  return `node:${nodeId}`;
}

function fenceRowId(leaseId: string): string {
  return `fence:${leaseId}`;
}

type AuthorityVersionRow = ControlPlaneSqlRow & { generation: number | bigint };
type EffectiveVersionRow = ControlPlaneSqlRow & { generation: number | bigint };
type SecurityVersionRow = ControlPlaneSqlRow & { epoch: number | bigint };
type AggregateVersionRow = ControlPlaneSqlRow & { aggregateVersion: number | bigint };
type ReservationRow = ControlPlaneSqlRow & {
  target: unknown;
  state: string;
  reservedAt: string;
};
type OutcomeRow = ControlPlaneSqlRow & { receipt: unknown };
type TombstoneRow = ControlPlaneSqlRow & { target: unknown };
type ConfirmationRow = ControlPlaneSqlRow & {
  confirmationId: string;
  action: string;
  authorityToken: string;
  inventoryHash: string;
  expiresAt: string;
  state: string;
};
type DestructionRow = ControlPlaneSqlRow & {
  providerIdentity: string;
  phase: string;
  inventoryHash: string;
  intent: unknown;
  receipt?: unknown;
  completedAt?: string;
  updatedAt: string;
};
type FenceRow = ControlPlaneSqlRow & {
  writerEpoch: number | bigint;
  authorityGeneration: number | bigint;
  expiresAt: string;
  state: string;
};
type NodeRow = ControlPlaneSqlRow & {
  state: string;
  expiresAt: string;
  compatibility: unknown;
  bootstrapFingerprint: string;
  authorityVersion: number | bigint;
  effectiveVersion: number | bigint;
};
type HostSettingRow = ControlPlaneSqlRow & { key: string; value: unknown; updatedAt: string };
type CapletRow = ControlPlaneSqlRow & {
  id: string;
  aggregateVersion: number | bigint;
  name: string;
  description: string;
  ownership: string;
  activation: string;
  effective: unknown;
  updateState: string;
  installationProvenanceId?: string | null;
};
type DocumentRow = ControlPlaneSqlRow & {
  capletId: string;
  sourcePath: string;
  sourceFrontmatter: unknown;
  body: string;
};
type BackendRow = ControlPlaneSqlRow & {
  capletId: string;
  ordinal: number | bigint;
  kind: string;
  childId?: string | null;
  config: unknown;
};
type CatalogRow = ControlPlaneSqlRow & {
  capletId: string;
  displayName?: string | null;
  summary?: string | null;
  iconType?: string | null;
  iconPath?: string | null;
  iconUrl?: string | null;
};
type TagRow = ControlPlaneSqlRow & { capletId: string; ordinal: number | bigint; tag: string };
type InputRow = ControlPlaneSqlRow & {
  capletId: string;
  ordinal: number | bigint;
  name: string;
  referenceType: string;
  path?: string | null;
  url?: string | null;
  setupName?: string | null;
};
type ReferenceRow = ControlPlaneSqlRow & {
  capletId: string;
  ordinal: number | bigint;
  owner: string;
  referenceType: string;
  path?: string | null;
  url?: string | null;
  setupName?: string | null;
};
type AssetRow = ControlPlaneSqlRow & {
  capletId: string;
  ordinal: number | bigint;
  path: string;
  role: string;
  mediaType: string;
  bytes: Uint8Array;
  contentHash: string;
};
type HistoryRow = ControlPlaneSqlRow & {
  capletId: string;
  sequence: number | bigint;
  fromState: string;
  toState: string;
  reason: string;
  actorId: string;
  aggregateVersion: number | bigint;
  authorityVersion: number | bigint;
  effectiveVersion: number | bigint;
  occurredAt: string;
};
