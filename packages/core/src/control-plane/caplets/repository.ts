import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { satisfies } from "semver";
import { CapletsError } from "../../errors";
import type {
  CurrentHostConfirmationToken,
  CurrentHostOperationBinding,
  CurrentHostOperationLookupOutcome,
  CurrentHostOperationReceipt,
} from "../../current-host/operations";
import { STORAGE_BENCHMARK_ENVELOPE } from "../storage-benchmark-envelope";
import { controlPlaneNodeAdmissionLock } from "../types";
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
  ControlPlaneActivationState,
  ControlPlaneConvergenceToken,
  ControlPlaneDetailedDiagnostics,
  ControlPlaneConflictReason,
  ControlPlaneHealthSummary,
  ControlPlaneMutationResult,
  ControlPlaneNodeApplication,
  ControlPlaneNodeApplicationResult,
  ControlPlaneNodeRegistration,
  ControlPlaneNodeRegistrationResult,
  ControlPlaneMaintenanceFence,
  ControlPlaneOperationReservationResult,
  ControlPlaneSnapshot,
  ControlPlaneStoreIdentity,
  ControlPlaneVersionState,
  ControlPlaneWriterFence,
  ExternalDestructionIntent,
  ExternalDestructionPort,
  ExternalDestructionStatus,
  HostSettingManagementMutation,
} from "../types";

const DEFAULT_RESERVATION_TTL_MS = 5 * 60_000;
const EXTERNAL_DESTRUCTION_CLAIM_TTL_MS = 30_000;
const OPERATOR_ACTIVITY_RETENTION_MS = 90 * 24 * 60 * 60_000;
const ACTIVATION_MIGRATION_ID = "u10-runtime-activation";
const TUPLE_FINGERPRINT_MIGRATION_PREFIX = "u10-runtime-tuple";
const CONVERGENCE_RECEIPT_BATCH_SIZE =
  STORAGE_BENCHMARK_ENVELOPE.managementWritesPerSecond *
  STORAGE_BENCHMARK_ENVELOPE.writeBurstSeconds;
const SUPPORTED_RUNTIME_BINARY_RANGE = ">=0.34.1 <0.35.0";
const REQUIRED_RUNTIME_CAPABILITIES = Object.freeze([
  "ordered-tuple-polling",
  "writer-fence-v1",
  "complete-snapshot-v1",
]);
const SNAPSHOT_ENVELOPE_ID = "control-plane";
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

type SnapshotEnvelopeMetrics = Readonly<{
  caplets: number;
  normalizedRows: number;
  encodedBytes: number;
}>;

type SnapshotEnvelopeContribution = SnapshotEnvelopeMetrics;

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
  let lastConnectedAt = 0;
  let localNodeId: string | undefined;
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
      const initialized = await readVersions(transaction, options.identity.logicalHostId);
      await loadOrCreateSnapshotEnvelopeMetrics(transaction, options, now, initialized);
      return initialized;
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
    const result = await runManagementMutation(
      options,
      input,
      fail,
      reservationTtlMs,
      async (transaction, state) => {
        await writeCaplet(transaction, options, input, state);
      },
    );
    if (result.status === "committed") {
      const token = {
        authorityGeneration: result.receipt.authorityToken.authorityGeneration,
        effectiveGeneration: result.receipt.authorityToken.effectiveGeneration,
        securityEpoch: input.expectedSecurityEpoch,
      };
      lastKnownVersions = token;
      try {
        await options.dialect.publishChange?.(token);
      } catch {
        // The receipt is already durable; tuple polling remains authoritative.
      }
    }
    return result;
  };

  const mutateHostSetting = async (
    input: HostSettingManagementMutation,
  ): Promise<ControlPlaneMutationResult> => {
    parseCanonicalHostSetting(input.setting);
    const result = await runManagementMutation(
      options,
      input,
      fail,
      reservationTtlMs,
      async (transaction, state) => {
        await writeHostSetting(transaction, options, input, state);
      },
    );
    if (result.status === "committed") {
      const token = {
        authorityGeneration: result.receipt.authorityToken.authorityGeneration,
        effectiveGeneration: result.receipt.authorityToken.effectiveGeneration,
        securityEpoch: input.expectedSecurityEpoch,
      };
      lastKnownVersions = token;
      try {
        await options.dialect.publishChange?.(token);
      } catch {
        // The receipt is already durable; tuple polling remains authoritative.
      }
    }
    return result;
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

  const activationState = async (): Promise<ControlPlaneActivationState> => {
    requireReady(options);
    return options.dialect.snapshotTransaction(async (transaction) => {
      const state = await readActivationState(transaction, options.identity);
      if (!state) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "Control-plane runtime activation is not initialized.",
        );
      }
      return state;
    });
  };

  const initializeActivationFingerprint = async (
    initialFingerprint: string,
  ): Promise<ControlPlaneActivationState> => {
    requireReady(options);
    const fingerprint = normalizeFingerprint(initialFingerprint);
    return options.dialect.runtimeTransaction(async (transaction) => {
      await transaction.lock(activationLock(options.identity));
      return (
        (await readActivationState(transaction, options.identity)) ??
        initializeActivationState(transaction, options.identity, fingerprint)
      );
    });
  };

  const stageNextFingerprint = async (
    nextFingerprint: string,
    fence?: ControlPlaneMaintenanceFence,
  ): Promise<ControlPlaneActivationState> => {
    requireReady(options);
    const fingerprint = normalizeFingerprint(nextFingerprint);
    return options.dialect.runtimeTransaction(async (transaction) => {
      await transaction.lock(activationLock(options.identity));
      await lockMaintenanceAuthority(transaction, options.identity);
      const current = await readActivationState(transaction, options.identity);
      if (!current) {
        return initializeActivationState(transaction, options.identity, fingerprint);
      }
      if (fingerprint === current.currentFingerprint || fingerprint === current.nextFingerprint) {
        return current;
      }
      if (current.nextFingerprint) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Only one next runtime fingerprint may be staged.",
        );
      }
      const staged = Object.freeze({ ...current, nextFingerprint: fingerprint });
      await assertMaintenanceFence(transaction, options, fence);
      await persistActivationState(transaction, options.identity, staged);
      return staged;
    });
  };

  const abortNextFingerprint = async (
    nextFingerprint: string,
    fence?: ControlPlaneMaintenanceFence,
  ): Promise<ControlPlaneActivationState> => {
    requireReady(options);
    const fingerprint = normalizeFingerprint(nextFingerprint);
    return options.dialect.runtimeTransaction(async (transaction) => {
      await transaction.lock(activationLock(options.identity));
      await lockMaintenanceAuthority(transaction, options.identity);
      const current = await requireActivationState(transaction, options.identity);
      if (current.nextFingerprint !== fingerprint) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Runtime fingerprint is not the staged next value.",
        );
      }
      await transaction.delete("clusterNodeLeases", {
        equals: {
          logicalHostId: options.identity.logicalHostId,
          storeId: options.identity.storeId,
          state: "activation-pending",
          bootstrapFingerprint: fingerprint,
        },
      });
      const aborted = Object.freeze({
        generation: current.generation,
        currentFingerprint: current.currentFingerprint,
      });
      await assertMaintenanceFence(transaction, options, fence);
      await persistActivationState(transaction, options.identity, aborted);
      return aborted;
    });
  };

  const activateNextFingerprint = async (
    nextFingerprint: string,
    fence?: ControlPlaneMaintenanceFence,
  ): Promise<ControlPlaneActivationState> => {
    requireReady(options);
    const fingerprint = normalizeFingerprint(nextFingerprint);
    const activated = await options.dialect.runtimeTransaction(async (transaction) => {
      await transaction.lock(activationLock(options.identity));
      await transaction.lock(
        `authority-generation:${options.identity.logicalHostId}:${options.identity.storeId}`,
      );
      await transaction.lock(
        `security-epoch:${options.identity.logicalHostId}:${options.identity.storeId}`,
      );
      const current = await requireActivationState(transaction, options.identity);
      if (current.nextFingerprint !== fingerprint) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Runtime fingerprint is not the staged next value.",
        );
      }
      const versions = await readVersions(transaction, options.identity.logicalHostId);
      const now = await transaction.databaseTime();
      await transaction.update(
        "clusterNodeLeases",
        { state: "activation-drained", expiresAt: now, updatedAt: now },
        scope(options.identity),
      );
      await transaction.update(
        "clusterNodeLeases",
        { state: "catching-up", expiresAt: now, updatedAt: now },
        scope(options.identity, { bootstrapFingerprint: fingerprint }),
      );
      await assertMaintenanceFence(transaction, options, fence);
      await transaction.update(
        "writerFences",
        { state: "revoked", expiresAt: now, updatedAt: now },
        scope(options.identity),
      );
      await transaction.update(
        "authorityVersions",
        { bindingState: "inactive", updatedAt: now },
        scope(options.identity, { generation: versions.authorityGeneration }),
      );
      const authorityGeneration = versions.authorityGeneration + 1;
      const common = commonValues(options, now, `u10-authority:${authorityGeneration}`, {
        aggregateVersion: 0,
        authorityVersion: authorityGeneration,
        effectiveVersion: versions.effectiveGeneration,
        securityVersion: versions.securityEpoch,
      });
      await insert(
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
        [
          ...common,
          authorityGeneration,
          "active",
          authorityTokenText(authorityGeneration, versions.effectiveGeneration),
          options.identity.operationNamespace,
          null,
        ],
      );
      const next = Object.freeze({
        generation: current.generation + 1,
        currentFingerprint: fingerprint,
      });
      await persistActivationState(transaction, options.identity, next);
      lastKnownVersions = { ...versions, authorityGeneration };
      return { state: next, token: lastKnownVersions };
    });
    try {
      await options.dialect.publishChange?.(activated.token);
    } catch {
      // Activation is durable; ordered tuple polling remains authoritative.
    }
    return activated.state;
  };
  const adoptSqliteActivationFingerprint: NonNullable<
    ControlPlaneStore["adoptSqliteActivationFingerprint"]
  > = async (input) => {
    requireReady(options);
    if (options.dialect.backend !== "sqlite") {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Atomic runtime fingerprint adoption is available only for SQLite.",
      );
    }
    const nextFingerprint = normalizeFingerprint(input.nextFingerprint);
    const previousFingerprint =
      input.previousFingerprint === undefined
        ? undefined
        : normalizeFingerprint(input.previousFingerprint);
    normalizeFingerprint(input.expectedEffectiveRuntimeFingerprint);
    if (
      [
        input.expectedAuthorityGeneration,
        input.expectedEffectiveGeneration,
        input.expectedSecurityEpoch,
      ].some((value) => !Number.isSafeInteger(value) || value < 0)
    ) {
      throw new CapletsError("REQUEST_INVALID", "Expected convergence tuple is invalid.");
    }
    const adopted = await options.dialect.runtimeTransaction(async (transaction) => {
      await transaction.lock(activationLock(options.identity));
      await transaction.lock(
        `authority-generation:${options.identity.logicalHostId}:${options.identity.storeId}`,
      );
      await transaction.lock(
        `security-epoch:${options.identity.logicalHostId}:${options.identity.storeId}`,
      );
      const current = await readActivationState(transaction, options.identity);
      const versions = await readVersions(transaction, options.identity.logicalHostId);
      if (
        current?.currentFingerprint !== previousFingerprint ||
        current?.nextFingerprint !== undefined ||
        versions.authorityGeneration !== input.expectedAuthorityGeneration ||
        versions.effectiveGeneration !== input.expectedEffectiveGeneration ||
        versions.securityEpoch !== input.expectedSecurityEpoch
      ) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "SQLite runtime fingerprint adoption lost its exact authority fence.",
        );
      }
      if (!current) {
        const state = await initializeActivationState(
          transaction,
          options.identity,
          nextFingerprint,
        );
        lastKnownVersions = versions;
        return { state, token: versions };
      }
      if (current.currentFingerprint === nextFingerprint) {
        return { state: current, token: versions };
      }
      const now = await transaction.databaseTime();
      await transaction.update(
        "clusterNodeLeases",
        { state: "activation-drained", expiresAt: now, updatedAt: now },
        scope(options.identity),
      );
      await transaction.update(
        "writerFences",
        { state: "revoked", expiresAt: now, updatedAt: now },
        scope(options.identity),
      );
      await transaction.update(
        "authorityVersions",
        { bindingState: "inactive", updatedAt: now },
        scope(options.identity, { generation: versions.authorityGeneration }),
      );
      const authorityGeneration = versions.authorityGeneration + 1;
      const common = commonValues(options, now, `u10-authority:${authorityGeneration}`, {
        aggregateVersion: 0,
        authorityVersion: authorityGeneration,
        effectiveVersion: versions.effectiveGeneration,
        securityVersion: versions.securityEpoch,
      });
      await insert(
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
        [
          ...common,
          authorityGeneration,
          "active",
          authorityTokenText(authorityGeneration, versions.effectiveGeneration),
          options.identity.operationNamespace,
          null,
        ],
      );
      const state = Object.freeze({
        generation: current.generation + 1,
        currentFingerprint: nextFingerprint,
      });
      await persistActivationState(transaction, options.identity, state);
      const token = { ...versions, authorityGeneration };
      lastKnownVersions = token;
      return { state, token };
    });
    try {
      await options.dialect.publishChange?.(adopted.token);
    } catch {
      // Adoption is durable; ordered tuple polling remains authoritative.
    }
    return adopted.state;
  };

  const convergenceToken = async (): Promise<ControlPlaneConvergenceToken> => {
    requireReady(options);
    const token = await options.dialect.snapshotTransaction((transaction) =>
      readVersions(transaction, options.identity.logicalHostId),
    );
    lastKnownVersions = token;
    return token;
  };
  const subscribeToChanges: ControlPlaneStore["subscribeToChanges"] = async (listener) => {
    if (!options.dialect.subscribeToChanges) return async () => undefined;
    return options.dialect.subscribeToChanges(listener);
  };

  const registerNode = async (
    input: ControlPlaneNodeRegistration,
  ): Promise<ControlPlaneNodeRegistrationResult> => {
    requireReady(options);
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
      throw new Error("Node lease TTL must be a positive integer");
    }
    validateConvergenceToken(input.appliedToken);
    const expectedFingerprint = normalizeFingerprint(input.bootstrapFingerprint);
    const effectiveRuntimeFingerprint = normalizeFingerprint(input.effectiveRuntimeFingerprint);
    const result = await options.dialect.runtimeTransaction<ControlPlaneNodeRegistrationResult>(
      async (transaction) => {
        await transaction.lock(nodeLeaseLock(options.identity, input.nodeId));
        if (options.dialect.backend === "postgres") {
          await transaction.lock(controlPlaneNodeAdmissionLock(options.identity));
        }
        let now = await transaction.databaseTime();
        let activation = await readActivationState(transaction, options.identity);
        const existing = await transaction.select<NodeRow>(
          "clusterNodeLeases",
          scope(options.identity, { nodeId: input.nodeId }),
        );
        let versions = await readVersions(transaction, options.identity.logicalHostId);
        const leaseId = `writer:${input.nodeId}`;
        const existingFence = await transaction.select<FenceRow>(
          "writerFences",
          scope(options.identity, { leaseId }),
          [],
          1,
        );
        const currentNode = existing[0];
        const currentNodeIsLive =
          currentNode !== undefined && Date.parse(currentNode.expiresAt) > Date.parse(now);
        if (currentNodeIsLive && currentNode.bootstrapFingerprint !== expectedFingerprint) {
          return { status: "identity-conflict" };
        }
        let readyNodes = await countReadyNodes(transaction, options, now);
        let expiresAt = new Date(Date.parse(now) + input.ttlMs).toISOString();
        const compatible =
          runtimeCompatibilityMatches(
            options.dialect.compatibility,
            input.compatibility,
            options.dialect.backend === "postgres",
          ) &&
          (options.dialect.backend === "sqlite" ||
            (await cohortCommitmentsMatch(
              transaction,
              options.identity,
              input.compatibility,
              now,
            )));
        const previousToken = currentNode
          ? nodeConvergenceToken(currentNode)
          : { authorityGeneration: 0, effectiveGeneration: 0, securityEpoch: 0 };
        const previousFingerprint = currentNode
          ? nodeAcknowledgedEffectiveRuntimeFingerprint(currentNode)
          : undefined;
        let common = commonValues(options, now, nodeRowId(input.nodeId), {
          aggregateVersion: 0,
          authorityVersion: previousToken.authorityGeneration,
          effectiveVersion: previousToken.effectiveGeneration,
          securityVersion: previousToken.securityEpoch,
        });
        if (!compatible) {
          await upsertNode(
            transaction,
            common,
            input,
            now,
            now,
            "compatibility-rejected",
            readyNodes,
            previousFingerprint,
          );
          await retireWriterFence(transaction, options.identity, leaseId, now);
          return { status: "compatibility-rejected" };
        }
        activation ??= await initializeActivationState(
          transaction,
          options.identity,
          expectedFingerprint,
        );
        if (expectedFingerprint === activation.nextFingerprint) {
          await upsertNode(
            transaction,
            common,
            input,
            now,
            expiresAt,
            "activation-pending",
            readyNodes,
            previousFingerprint,
          );
          await retireWriterFence(transaction, options.identity, leaseId, now);
          return { status: "activation-pending", readyNodes };
        }
        if (expectedFingerprint !== activation.currentFingerprint) {
          await upsertNode(
            transaction,
            common,
            input,
            now,
            now,
            "compatibility-rejected",
            readyNodes,
            previousFingerprint,
          );
          await retireWriterFence(transaction, options.identity, leaseId, now);
          return { status: "compatibility-rejected" };
        }
        if (!sameConvergenceToken(input.appliedToken, versions)) {
          if (compareConvergenceTokens(input.appliedToken, versions) > 0) {
            await upsertNode(
              transaction,
              common,
              input,
              now,
              now,
              "compatibility-rejected",
              readyNodes,
              previousFingerprint,
            );
            await retireWriterFence(transaction, options.identity, leaseId, now);
            return { status: "compatibility-rejected" };
          }
          await upsertNode(
            transaction,
            common,
            input,
            now,
            expiresAt,
            "catching-up",
            readyNodes,
            previousFingerprint,
          );
          await retireWriterFence(transaction, options.identity, leaseId, now);
          return { status: "catching-up", readyNodes };
        }
        if (
          previousFingerprint &&
          sameConvergenceToken(previousToken, input.appliedToken) &&
          previousFingerprint !== effectiveRuntimeFingerprint
        ) {
          return { status: "compatibility-rejected" };
        }
        if (
          !(await tupleFingerprintMatches(
            transaction,
            options.identity,
            input.appliedToken,
            effectiveRuntimeFingerprint,
          ))
        ) {
          return { status: "compatibility-rejected" };
        }
        const nodeStillReady =
          currentNode?.state === "ready" && Date.parse(currentNode.expiresAt) > Date.parse(now);
        if (!nodeStillReady && options.dialect.backend === "postgres") {
          now = await transaction.databaseTime();
          versions = await readVersions(transaction, options.identity.logicalHostId);
          expiresAt = new Date(Date.parse(now) + input.ttlMs).toISOString();
          common = commonValues(options, now, nodeRowId(input.nodeId), {
            aggregateVersion: 0,
            authorityVersion: previousToken.authorityGeneration,
            effectiveVersion: previousToken.effectiveGeneration,
            securityVersion: previousToken.securityEpoch,
          });
          if (!sameConvergenceToken(input.appliedToken, versions)) {
            await upsertNode(
              transaction,
              common,
              input,
              now,
              expiresAt,
              "catching-up",
              readyNodes,
              previousFingerprint,
            );
            await retireWriterFence(transaction, options.identity, leaseId, now);
            return { status: "catching-up", readyNodes };
          }
          readyNodes = await countReadyNodes(transaction, options, now);
        }
        if (
          !nodeStillReady &&
          options.dialect.backend === "postgres" &&
          readyNodes >= STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes
        ) {
          await upsertNode(
            transaction,
            common,
            input,
            now,
            expiresAt,
            "capacity-rejected",
            16,
            previousFingerprint,
          );
          await retireWriterFence(transaction, options.identity, leaseId, now);
          return { status: "capacity-rejected", readyNodes: 16 };
        }
        const currentFence = existingFence[0];
        if (
          nodeStillReady &&
          currentFence?.state === "active" &&
          decodeCanonicalVersion(currentFence.authorityGeneration) ===
            versions.authorityGeneration &&
          Date.parse(currentFence.expiresAt) > Date.parse(now)
        ) {
          await upsertNode(
            transaction,
            common,
            input,
            now,
            expiresAt,
            "ready",
            readyNodes,
            previousFingerprint,
          );
          const renewed = await transaction.update(
            "writerFences",
            { expiresAt, updatedAt: now },
            {
              equals: {
                logicalHostId: options.identity.logicalHostId,
                storeId: options.identity.storeId,
                leaseId,
                writerEpoch: currentFence.writerEpoch,
                authorityGeneration: versions.authorityGeneration,
                state: "active",
              },
              greaterThan: { expiresAt: now },
            },
          );
          if (renewed !== 1) {
            throw new CapletsError("SERVER_UNAVAILABLE", "Node lease changed concurrently.");
          }
          return {
            status: "ready",
            readyNodes,
            writerFence: {
              leaseId,
              writerEpoch: decodeCanonicalVersion(currentFence.writerEpoch),
              authorityGeneration: versions.authorityGeneration,
            },
          };
        }
        const fence = {
          leaseId,
          writerEpoch: currentFence ? decodeCanonicalVersion(currentFence.writerEpoch) + 1 : 1,
          authorityGeneration: versions.authorityGeneration,
        } as const;
        const admittedReadyNodes = nodeStillReady ? readyNodes : readyNodes + 1;
        await upsertNode(
          transaction,
          common,
          input,
          now,
          expiresAt,
          "catching-up",
          admittedReadyNodes,
          previousFingerprint,
        );
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
            "pending",
          ],
          ["logical_host_id", "id"],
        );
        return { status: "ready", readyNodes: admittedReadyNodes, writerFence: fence };
      },
    );
    if (result.status === "ready") localNodeId = input.nodeId;
    return result;
  };

  const acknowledgeNode = async (
    input: ControlPlaneNodeApplication,
  ): Promise<ControlPlaneNodeApplicationResult> => {
    requireReady(options);
    validateConvergenceToken(input.appliedToken);
    const fingerprint = normalizeFingerprint(input.bootstrapFingerprint);
    if (input.writerFence.leaseId !== `writer:${input.nodeId}`) {
      return { status: "rejected", reason: "lease-revoked" };
    }
    const effectiveRuntimeFingerprint = normalizeFingerprint(input.effectiveRuntimeFingerprint);
    return options.dialect.runtimeTransaction(async (transaction) => {
      await transaction.lock(nodeLeaseLock(options.identity, input.nodeId));
      if (options.dialect.backend === "postgres") {
        await transaction.lock(controlPlaneNodeAdmissionLock(options.identity));
      }
      const now = await transaction.databaseTime();
      const versions = await readVersions(transaction, options.identity.logicalHostId);
      const activation = await requireActivationState(transaction, options.identity);
      if (fingerprint !== activation.currentFingerprint) {
        return { status: "rejected", reason: "fingerprint" };
      }
      const [node] = await transaction.select<NodeRow>(
        "clusterNodeLeases",
        scope(options.identity, { nodeId: input.nodeId }),
        [],
        1,
      );
      const [fence] = await transaction.select<FenceRow>(
        "writerFences",
        scope(options.identity, {
          leaseId: input.writerFence.leaseId,
          writerEpoch: input.writerFence.writerEpoch,
          authorityGeneration: input.writerFence.authorityGeneration,
        }),
        [],
        1,
      );
      const pendingApplication = node?.state === "catching-up" && fence?.state === "pending";
      const readyHeartbeat = node?.state === "ready" && fence?.state === "active";
      if (
        !node ||
        !fence ||
        (!pendingApplication && !readyHeartbeat) ||
        node.bootstrapFingerprint !== fingerprint ||
        (pendingApplication &&
          nodePendingEffectiveRuntimeFingerprint(node) !== effectiveRuntimeFingerprint) ||
        Date.parse(node.expiresAt) <= Date.parse(now) ||
        Date.parse(fence.expiresAt) <= Date.parse(now)
      ) {
        return { status: "rejected", reason: "lease-revoked" };
      }
      const previous = nodeConvergenceToken(node);
      if (compareConvergenceTokens(input.appliedToken, previous) < 0) {
        return { status: "rejected", reason: "token-regression" };
      }
      if (compareConvergenceTokens(input.appliedToken, versions) > 0) {
        return { status: "rejected", reason: "token-ahead" };
      }
      if (compareConvergenceTokens(input.appliedToken, versions) < 0) {
        return { status: "rejected", reason: "token-behind" };
      }
      const acknowledgedFingerprint = nodeAcknowledgedEffectiveRuntimeFingerprint(node);
      if (
        acknowledgedFingerprint &&
        sameConvergenceToken(previous, input.appliedToken) &&
        acknowledgedFingerprint !== effectiveRuntimeFingerprint
      ) {
        return { status: "rejected", reason: "fingerprint" };
      }
      if (
        !(await bindTupleFingerprint(
          transaction,
          options,
          now,
          input.appliedToken,
          effectiveRuntimeFingerprint,
        ))
      ) {
        return { status: "rejected", reason: "fingerprint" };
      }
      if (
        pendingApplication &&
        options.dialect.backend === "postgres" &&
        (await countReadyNodes(transaction, options, now)) >=
          STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes
      ) {
        return { status: "rejected", reason: "lease-revoked" };
      }
      if (
        pendingApplication &&
        options.dialect.backend === "postgres" &&
        !(await hasCurrentCanaryProofs(
          transaction,
          options.identity,
          input.nodeId,
          input.writerFence,
        ))
      ) {
        return { status: "rejected", reason: "lease-revoked" };
      }
      const nodeUpdated = await transaction.update(
        "clusterNodeLeases",
        {
          authorityVersion: input.appliedToken.authorityGeneration,
          effectiveVersion: input.appliedToken.effectiveGeneration,
          securityVersion: input.appliedToken.securityEpoch,
          compatibility: encodeCanonicalJson({
            declared: nodeDeclaredCompatibility(node),
            effectiveRuntimeFingerprint,
            acknowledgedEffectiveRuntimeFingerprint: effectiveRuntimeFingerprint,
          }),
          state: "ready",
          heartbeatAt: now,
          updatedAt: now,
        },
        scope(options.identity, { nodeId: input.nodeId, state: node.state }),
      );
      const fenceUpdated = await transaction.update(
        "writerFences",
        { state: "active", updatedAt: now },
        scope(options.identity, {
          leaseId: input.writerFence.leaseId,
          writerEpoch: input.writerFence.writerEpoch,
          authorityGeneration: input.writerFence.authorityGeneration,
          state: fence.state,
        }),
      );
      if (nodeUpdated !== 1 || fenceUpdated !== 1) {
        throw new CapletsError("SERVER_UNAVAILABLE", "Node acknowledgement changed concurrently.");
      }
      const appliedNodes = await countAppliedNodes(transaction, options, now, versions);
      const readyNodes = await countReadyNodes(transaction, options, now);
      if (appliedNodes >= readyNodes) {
        await updateConvergedReceipts(transaction, options, now, versions, appliedNodes);
      }
      return { status: "applied", appliedNodes };
    });
  };

  const validateWriterFence = async (writerFence: ControlPlaneWriterFence): Promise<boolean> => {
    requireReady(options);
    return (
      (await options.dialect.runtimeTransaction((transaction) =>
        transaction.finalWriterFenceGuard({
          logicalHostId: options.identity.logicalHostId,
          storeId: options.identity.storeId,
          leaseId: writerFence.leaseId,
          writerEpoch: writerFence.writerEpoch,
          authorityGeneration: writerFence.authorityGeneration,
          state: "active",
        }),
      )) === 1
    );
  };

  const revokeNode = async (
    nodeId: string,
    expectedFence?: ControlPlaneWriterFence | undefined,
  ): Promise<void> => {
    requireReady(options);
    await options.dialect.runtimeTransaction(async (transaction) => {
      await transaction.lock(nodeLeaseLock(options.identity, nodeId));
      const now = await transaction.databaseTime();
      if (expectedFence) {
        if (expectedFence.leaseId !== `writer:${nodeId}`) return;
        const [currentFence] = await transaction.select<FenceRow>(
          "writerFences",
          scope(options.identity, {
            leaseId: expectedFence.leaseId,
            writerEpoch: expectedFence.writerEpoch,
            authorityGeneration: expectedFence.authorityGeneration,
          }),
          [],
          1,
        );
        if (
          !currentFence ||
          (currentFence.state !== "active" && currentFence.state !== "pending")
        ) {
          return;
        }
      }
      await transaction.update(
        "clusterNodeLeases",
        { state: "revoked", expiresAt: now, updatedAt: now },
        scope(options.identity, { nodeId }),
      );
      await retireWriterFence(transaction, options.identity, `writer:${nodeId}`, now);
    });
  };

  const sweepOverdueNodes = async (maximumLagMs: number): Promise<number> => {
    requireReady(options);
    if (!Number.isSafeInteger(maximumLagMs) || maximumLagMs <= 0) {
      throw new Error("Convergence deadline must be a positive integer");
    }
    return options.dialect.runtimeTransaction(async (transaction) => {
      const sweepKey = `overdue-sweep:${options.identity.logicalHostId}:${options.identity.storeId}`;
      if (
        options.dialect.backend === "postgres" &&
        transaction.tryLock &&
        !(await transaction.tryLock(sweepKey))
      ) {
        return 0;
      }
      if (options.dialect.backend !== "postgres" || !transaction.tryLock) {
        await transaction.lock(sweepKey);
      }
      const now = await transaction.databaseTime();
      const versions = await readVersions(transaction, options.identity.logicalHostId);
      const advancedAt = await currentConvergenceAdvancedAt(
        transaction,
        options.identity,
        versions,
      );
      if (Date.parse(now) - Date.parse(advancedAt) < maximumLagMs) return 0;
      const nodes = await transaction.select<NodeRow>(
        "clusterNodeLeases",
        scope(options.identity, { state: "ready" }),
        [],
      );
      let overdue = 0;
      for (const node of nodes) {
        if (
          decodeCanonicalVersion(node.authorityVersion) === versions.authorityGeneration &&
          decodeCanonicalVersion(node.effectiveVersion) === versions.effectiveGeneration &&
          decodeCanonicalVersion(node.securityVersion) === versions.securityEpoch
        ) {
          continue;
        }
        overdue += await transaction.update(
          "clusterNodeLeases",
          { state: "overdue", expiresAt: now, updatedAt: now },
          scope(options.identity, { nodeId: node.nodeId, state: "ready" }),
        );
        await retireWriterFence(transaction, options.identity, `writer:${node.nodeId}`, now);
      }
      const appliedNodes = await countAppliedNodes(transaction, options, now, {
        authorityGeneration: versions.authorityGeneration,
        effectiveGeneration: versions.effectiveGeneration,
        securityEpoch: versions.securityEpoch,
      });
      let settled: number;
      do {
        settled = await transaction.settleConvergenceReceipts({
          logicalHostId: options.identity.logicalHostId,
          storeId: options.identity.storeId,
          authorityGeneration: versions.authorityGeneration,
          effectiveGeneration: versions.effectiveGeneration,
          securityEpoch: versions.securityEpoch,
          appliedNodes,
          limit: CONVERGENCE_RECEIPT_BATCH_SIZE,
        });
      } while (settled === CONVERGENCE_RECEIPT_BATCH_SIZE);
      return overdue;
    });
  };

  const health = async (): Promise<ControlPlaneHealthSummary> => {
    if (!options.dialect.ready) {
      return unavailableHealth(
        options,
        lastKnownVersions,
        cachedSnapshot !== undefined,
        lastConnectedAt,
      );
    }
    try {
      const observed = await options.dialect.snapshotTransaction(async (transaction) => {
        const versions = await readVersions(transaction, options.identity.logicalHostId);
        const activation = await readActivationState(transaction, options.identity);
        if (!activation) {
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            "Control-plane runtime activation is not initialized.",
          );
        }
        if (options.dialect.backend === "sqlite") return { versions, activation };
        const now = await transaction.databaseTime();
        const rows = await transaction.select<NodeRow>("clusterNodeLeases", {
          equals: {
            logicalHostId: options.identity.logicalHostId,
            storeId: options.identity.storeId,
            state: "ready",
          },
          greaterThan: { expiresAt: now },
        });
        const allApplied = rows.every((row) =>
          sameConvergenceToken(
            {
              authorityGeneration: decodeCanonicalVersion(row.authorityVersion),
              effectiveGeneration: decodeCanonicalVersion(row.effectiveVersion),
              securityEpoch: decodeCanonicalVersion(row.securityVersion),
            },
            versions,
          ),
        );
        const localReady = rows.some(
          (row) =>
            row.nodeId === localNodeId &&
            sameConvergenceToken(
              {
                authorityGeneration: decodeCanonicalVersion(row.authorityVersion),
                effectiveGeneration: decodeCanonicalVersion(row.effectiveVersion),
                securityEpoch: decodeCanonicalVersion(row.securityVersion),
              },
              versions,
            ),
        );
        const advancedAt = await currentConvergenceAdvancedAt(
          transaction,
          options.identity,
          versions,
        );
        return {
          versions,
          activation,
          nodeState: {
            readyNodes: rows.length,
            allApplied,
            localReady,
            overdue:
              Date.parse(now) - Date.parse(advancedAt) >=
              STORAGE_BENCHMARK_ENVELOPE.maxConvergenceP99Ms,
          },
        };
      });
      lastKnownVersions = observed.versions;
      lastConnectedAt = Date.now();
      if (options.dialect.backend === "sqlite") {
        return {
          backend: "sqlite",
          readiness: "ready",
          connectivity: "connected",
          migration: "current",
          authorityToken: {
            authorityGeneration: observed.versions.authorityGeneration,
            effectiveGeneration: observed.versions.effectiveGeneration,
          },
          bootstrapCompatibility: "current",
          convergence: "single-node",
          guidanceCode: "ok",
        };
      }
      if (!("nodeState" in observed)) {
        throw new Error("Postgres health observation did not include node state");
      }
      const healthy =
        observed.nodeState.readyNodes > 0 &&
        observed.nodeState.allApplied &&
        observed.nodeState.localReady;
      const overdue = !healthy && observed.nodeState.overdue;
      return {
        backend: "postgres",
        readiness: healthy ? "ready" : "not-ready",
        connectivity: "connected",
        migration: "current",
        authorityToken: {
          authorityGeneration: observed.versions.authorityGeneration,
          effectiveGeneration: observed.versions.effectiveGeneration,
        },
        bootstrapCompatibility: observed.activation.nextFingerprint ? "staged" : "current",
        convergence: healthy ? "within-budget" : overdue ? "overdue" : "pending",
        guidanceCode: healthy ? "ok" : overdue ? "convergence-overdue" : "convergence-pending",
      };
    } catch {
      return unavailableHealth(
        options,
        lastKnownVersions,
        cachedSnapshot !== undefined,
        lastConnectedAt,
      );
    }
  };

  const detailedDiagnostics = async (): Promise<ControlPlaneDetailedDiagnostics> => {
    requireReady(options);
    return options.dialect.snapshotTransaction(async (transaction) => {
      const activation = await requireActivationState(transaction, options.identity);
      const now = await transaction.databaseTime();
      const nodes = await transaction.select<NodeRow>("clusterNodeLeases", scope(options.identity));
      return Object.freeze({
        backend: options.dialect.backend,
        store: Object.freeze({ ...options.identity }),
        fingerprint: activation,
        keyCompatibility: Object.freeze({
          status:
            options.dialect.compatibility.providerCommitment &&
            options.dialect.compatibility.keyCanaryCommitment
              ? "compatible"
              : "incompatible",
          activeVersion: options.dialect.compatibility.keyVersion,
          providerCommitmentPresent: Boolean(options.dialect.compatibility.providerCommitment),
          canaryCommitmentPresent: Boolean(options.dialect.compatibility.keyCanaryCommitment),
        }),
        readyNodes: nodes.filter(
          (node) => node.state === "ready" && Date.parse(node.expiresAt) > Date.parse(now),
        ).length,
        overdueNodes: nodes.filter((node) => node.state === "overdue").length,
      });
    });
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
    activationState,
    initializeActivationFingerprint,
    stageNextFingerprint,
    abortNextFingerprint,
    activateNextFingerprint,
    adoptSqliteActivationFingerprint,
    convergenceToken,
    subscribeToChanges,
    registerNode,
    acknowledgeNode,
    validateWriterFence,
    revokeNode,
    sweepOverdueNodes,
    health,
    detailedDiagnostics,
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
      // Runtime snapshots contain every SQL Caplet row, including disabled and shadowed
      // aggregates. Their token must advance whenever any Caplet aggregate changes.
      const snapshotDataChanged = effectiveStateChanged || "aggregate" in input;
      if (snapshotDataChanged) {
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
      const previousContribution = await readSnapshotEnvelopeContribution(
        transaction,
        options,
        input,
      );
      const effectiveGeneration = snapshotDataChanged
        ? versions.effectiveGeneration + 1
        : versions.effectiveGeneration;
      const state: MutationState = {
        now,
        versions,
        effectiveGeneration,
        previousContribution,
      };
      await writeDomain(transaction, state);
      await fail("after-domain-write");
      await writeProvenance(transaction, options, input, state);
      await fail("after-provenance");
      await transaction.lock(
        `management-rate:${options.identity.logicalHostId}:${options.identity.storeId}`,
      );
      const rateBoundary = await transaction.databaseTime();
      const recentActivity = await transaction.select<ControlPlaneSqlRow & { occurredAt: string }>(
        "operatorActivities",
        scope(options.identity),
        [{ column: "occurredAt", direction: "desc" }],
        STORAGE_BENCHMARK_ENVELOPE.managementWritesPerSecond,
      );
      if (
        recentActivity.length >= STORAGE_BENCHMARK_ENVELOPE.managementWritesPerSecond &&
        recentActivity.every(
          (activity) => Date.parse(rateBoundary) - Date.parse(activity.occurredAt) < 1_000,
        )
      ) {
        throw new StoreResultError({ status: "unavailable" });
      }
      await writeActivity(transaction, options, input, state);
      await fail("after-activity");
      if (snapshotDataChanged) {
        await writeEffectiveGeneration(transaction, options, input, state);
      }
      await fail("before-fence-guard");
      if (input.finalAuthorization) {
        const finalAuthorization = await input.finalAuthorization(transaction);
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
      const receiptState = Object.freeze({
        ...state,
        now: await transaction.databaseTime(),
      });
      const requiredNodes =
        options.dialect.backend === "postgres"
          ? await countReadyNodes(transaction, options, receiptState.now)
          : 1;
      const receipt = createReceipt(options, input, receiptState, requiredNodes);
      await writeOutcome(transaction, options, input, receiptState, receipt);
      const envelopeDelta = snapshotEnvelopeDelta(input, state.previousContribution);
      const envelopeAdvanced = await transaction.advanceSnapshotEnvelope({
        logicalHostId: options.identity.logicalHostId,
        storeId: options.identity.storeId,
        envelopeId: SNAPSHOT_ENVELOPE_ID,
        ...envelopeDelta,
        maxCaplets: STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets,
        maxNormalizedRows: STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows,
        maxEncodedBytes: STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes,
        expectedAuthorityGeneration: input.expectedAuthorityGeneration,
        expectedSecurityEpoch: input.expectedSecurityEpoch,
        leaseId: input.writerFence.leaseId,
        writerEpoch: input.writerFence.writerEpoch,
        fenceAuthorityGeneration: input.writerFence.authorityGeneration,
        fenceState: "active",
      });
      if (envelopeAdvanced !== 1) {
        const guardConflict = await guardWriterFence(transaction, options, input);
        if (guardConflict) {
          throw new StoreResultError({ status: "conflict", reason: guardConflict });
        }
        const finalVersions = await readVersions(transaction, options.identity.logicalHostId);
        if (finalVersions.authorityGeneration !== input.expectedAuthorityGeneration) {
          throw new StoreResultError({ status: "conflict", reason: "authority-generation" });
        }
        if (finalVersions.securityEpoch !== input.expectedSecurityEpoch) {
          throw new StoreResultError({ status: "denied", reason: "stale-security" });
        }
        throw new StoreResultError({ status: "unavailable" });
      }
      await fail("after-generation");
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
  previousContribution: SnapshotEnvelopeContribution;
}>;

export async function writeCanonicalCapletRows(
  transaction: ControlPlaneSqlTransaction,
  input: Readonly<{
    identity: ControlPlaneStoreIdentity;
    aggregate: CanonicalCapletAggregate;
    projection: CanonicalCapletRelationalProjection;
    now: string;
    authorityGeneration: number;
    effectiveGeneration: number;
    securityEpoch: number;
  }>,
): Promise<void> {
  await writeCaplet(
    transaction,
    { identity: input.identity },
    { aggregate: input.aggregate, projection: input.projection },
    {
      now: input.now,
      versions: {
        authorityGeneration: input.authorityGeneration,
        effectiveGeneration: input.effectiveGeneration,
        securityEpoch: input.securityEpoch,
      },
      effectiveGeneration: input.effectiveGeneration,
      previousContribution: { caplets: 0, normalizedRows: 0, encodedBytes: 0 },
    },
  );
}

async function writeCaplet(
  transaction: ControlPlaneSqlTransaction,
  options: Pick<ControlPlaneStoreOptions, "identity">,
  input: Pick<CapletManagementMutation, "aggregate" | "projection">,
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
      "expires_at",
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
      new Date(Date.parse(state.now) + OPERATOR_ACTIVITY_RETENTION_MS).toISOString(),
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

async function lockMaintenanceAuthority(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
): Promise<void> {
  await transaction.lock(`authority-generation:${identity.logicalHostId}:${identity.storeId}`);
  await transaction.lock(`security-epoch:${identity.logicalHostId}:${identity.storeId}`);
}

async function assertMaintenanceFence(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  fence: ControlPlaneMaintenanceFence | undefined,
): Promise<void> {
  if (transaction.backend === "sqlite") return;
  if (!fence) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Postgres maintenance requires an exact live authority fence.",
    );
  }
  const current = await readVersions(transaction, options.identity.logicalHostId);
  if (
    current.authorityGeneration !== fence.writerFence.authorityGeneration ||
    current.securityEpoch !== fence.securityEpoch
  ) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Postgres maintenance authority is stale.");
  }
  const guarded = await transaction.finalWriterFenceGuard({
    logicalHostId: options.identity.logicalHostId,
    storeId: options.identity.storeId,
    leaseId: fence.writerFence.leaseId,
    writerEpoch: fence.writerFence.writerEpoch,
    authorityGeneration: fence.writerFence.authorityGeneration,
  });
  if (guarded !== 1) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Postgres maintenance writer fence is stale.");
  }
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
  const changed = await transaction.finalWriterFenceGuard({
    logicalHostId: options.identity.logicalHostId,
    storeId: options.identity.storeId,
    leaseId: input.writerFence.leaseId,
    writerEpoch: input.writerFence.writerEpoch,
    authorityGeneration: input.expectedAuthorityGeneration,
  });
  return changed === 1 ? undefined : "writer-fence";
}

function createReceipt(
  options: ControlPlaneStoreOptions,
  input: CapletManagementMutation | HostSettingManagementMutation,
  state: MutationState,
  requiredNodes: number,
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
    localApplication: input.localApplication ?? ("applied" as const),
    convergence:
      options.dialect.backend === "sqlite"
        ? ({ kind: "single-node" } as const)
        : ({
            kind: "pending" as const,
            deadline: new Date(Date.parse(state.now) + 5_000).toISOString(),
            requiredNodes,
          } as const),
    ...(input.managementTarget ? { management: Object.freeze({ ...input.managementTarget }) } : {}),
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

async function loadOrCreateSnapshotEnvelopeMetrics(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  now: string,
  versions: VersionRows,
): Promise<SnapshotEnvelopeMetrics> {
  const [existing] = await transaction.select<SnapshotEnvelopeRow>(
    "snapshotEnvelopes",
    scope(options.identity, { envelopeId: SNAPSHOT_ENVELOPE_ID }),
    [],
    1,
  );
  if (existing) {
    return {
      caplets: decodeCanonicalVersion(existing.capletCount),
      normalizedRows: decodeCanonicalVersion(existing.normalizedRowCount),
      encodedBytes: decodeCanonicalVersion(existing.encodedByteCount),
    };
  }
  const snapshot = await readSnapshot(transaction, options, versions);
  const metrics: SnapshotEnvelopeMetrics = {
    caplets: snapshot.caplets.length,
    normalizedRows: snapshot.normalizedRows,
    encodedBytes: snapshot.encodedBytes,
  };
  assertSnapshotEnvelope(metrics);
  const common = commonValues(options, now, `snapshot-envelope:${SNAPSHOT_ENVELOPE_ID}`, {
    aggregateVersion: versions.effectiveGeneration,
    authorityVersion: versions.authorityGeneration,
    effectiveVersion: versions.effectiveGeneration,
    securityVersion: versions.securityEpoch,
  });
  await insert(
    transaction,
    "cp_snapshot_envelope",
    [
      ...COMMON_COLUMNS,
      "envelope_id",
      "caplet_count",
      "normalized_row_count",
      "encoded_byte_count",
    ],
    [
      ...common,
      SNAPSHOT_ENVELOPE_ID,
      metrics.caplets,
      metrics.normalizedRows,
      metrics.encodedBytes,
    ],
  );
  return metrics;
}

async function readSnapshotEnvelopeContribution(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  input: CapletManagementMutation | HostSettingManagementMutation,
): Promise<SnapshotEnvelopeContribution> {
  if ("setting" in input) {
    const rows = await transaction.select<HostSettingRow>(
      "hostSettings",
      scope(options.identity, { id: input.aggregateId }),
      [],
      1,
    );
    return { caplets: 0, normalizedRows: rows.length, encodedBytes: 0 };
  }
  const [caplet] = await transaction.select<CapletRow>(
    "caplets",
    scope(options.identity, { id: input.aggregateId }),
    [],
    1,
  );
  if (!caplet) return { caplets: 0, normalizedRows: 0, encodedBytes: 0 };
  const childFilter = {
    equals: {
      logicalHostId: options.identity.logicalHostId,
      capletId: input.aggregateId,
    },
  } as const;
  const limit = STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows + 1;
  const [documents, backends, catalogs, tags, inputs, references, assets, history] =
    await Promise.all([
      transaction.select<DocumentRow>("capletDocuments", childFilter, [], limit),
      transaction.select<BackendRow>("capletBackends", childFilter, [{ column: "ordinal" }], limit),
      transaction.select<CatalogRow>("capletCatalogs", childFilter, [], limit),
      transaction.select<TagRow>("capletCatalogTags", childFilter, [{ column: "ordinal" }], limit),
      transaction.select<InputRow>(
        "capletDeclaredInputs",
        childFilter,
        [{ column: "ordinal" }],
        limit,
      ),
      transaction.select<ReferenceRow>(
        "capletReferences",
        childFilter,
        [{ column: "ordinal" }],
        limit,
      ),
      transaction.select<AssetRow>("capletAssets", childFilter, [{ column: "ordinal" }], limit),
      transaction.select<HistoryRow>(
        "capletActivationHistory",
        childFilter,
        [{ column: "sequence" }],
        limit,
      ),
    ]);
  const hydrated = hydrateCaplet(
    caplet,
    documents[0],
    backends,
    catalogs[0],
    tags,
    inputs,
    references,
    assets,
    history,
  );
  return {
    caplets: 1,
    normalizedRows:
      1 +
      documents.length +
      backends.length +
      catalogs.length +
      tags.length +
      inputs.length +
      references.length +
      assets.length +
      history.length,
    encodedBytes: encodePortableCaplet(hydrated.aggregate.portable).byteLength,
  };
}

function snapshotEnvelopeDelta(
  input: CapletManagementMutation | HostSettingManagementMutation,
  previousContribution: SnapshotEnvelopeContribution,
): Readonly<{
  capletDelta: number;
  normalizedRowDelta: number;
  encodedByteDelta: number;
}> {
  const nextContribution: SnapshotEnvelopeContribution =
    "setting" in input
      ? {
          caplets: 0,
          normalizedRows: 1,
          encodedBytes: 0,
        }
      : {
          caplets: 1,
          normalizedRows:
            2 +
            input.projection.backends.length +
            (input.aggregate.portable.frontmatter.catalog ? 1 : 0) +
            (input.aggregate.portable.frontmatter.catalog?.tags?.length ?? 0) +
            input.aggregate.portable.frontmatter.declaredInputs.length +
            input.projection.references.length +
            input.projection.assets.length +
            input.projection.activationHistory.length,
          encodedBytes: encodePortableCaplet(input.aggregate.portable).byteLength,
        };
  return {
    capletDelta: nextContribution.caplets - previousContribution.caplets,
    normalizedRowDelta: nextContribution.normalizedRows - previousContribution.normalizedRows,
    encodedByteDelta: nextContribution.encodedBytes - previousContribution.encodedBytes,
  };
}

function assertSnapshotEnvelope(metrics: SnapshotEnvelopeMetrics): void {
  if (
    metrics.caplets < 0 ||
    metrics.caplets > STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets ||
    metrics.normalizedRows < 0 ||
    metrics.normalizedRows > STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows ||
    metrics.encodedBytes < 0 ||
    metrics.encodedBytes > STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes
  ) {
    throw new StoreResultError({ status: "unavailable" });
  }
}

async function readSnapshot(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  versions: VersionRows,
): Promise<ControlPlaneSnapshot> {
  const [snapshotEnvelope] = await transaction.select<SnapshotEnvelopeRow>(
    "snapshotEnvelopes",
    scope(options.identity, { envelopeId: SNAPSHOT_ENVELOPE_ID }),
    [],
    1,
  );
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
  const hostSettingVersions = Object.freeze(
    Object.fromEntries(
      hostRows.map((row) => [
        row.key,
        decodeCanonicalVersion(row.aggregateVersion as number | bigint),
      ]),
    ),
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
  const snapshotEnvelopeIsCurrent =
    snapshotEnvelope !== undefined &&
    decodeCanonicalVersion(snapshotEnvelope.effectiveVersion) === versions.effectiveGeneration &&
    decodeCanonicalVersion(snapshotEnvelope.capletCount) === capletRows.length &&
    decodeCanonicalVersion(snapshotEnvelope.normalizedRowCount) === normalizedRows;
  const encodedBytes = snapshotEnvelopeIsCurrent
    ? decodeCanonicalVersion(snapshotEnvelope.encodedByteCount)
    : caplets.reduce(
        (total, entry) => total + encodePortableCaplet(entry.aggregate.portable).byteLength,
        0,
      );
  assertSnapshotEnvelope({
    caplets: capletRows.length,
    normalizedRows,
    encodedBytes,
  });
  return Object.freeze({
    identity: Object.freeze({ ...options.identity }),
    versions: Object.freeze(versions),
    caplets: Object.freeze(caplets),
    hostSettings: Object.freeze(hostSettings),
    hostSettingVersions,
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
  if (!rows[0]) return undefined;
  const receipt = decodeJson(rows[0].receipt) as unknown as CurrentHostOperationReceipt;
  if (receipt.convergence.kind !== "pending") return receipt;
  if (rows[0].convergenceClass === "converged") {
    return {
      ...receipt,
      convergence: {
        kind: "converged",
        appliedNodes: receipt.convergence.requiredNodes,
      },
    };
  }
  if (rows[0].convergenceClass === "overdue") {
    return {
      ...receipt,
      convergence: {
        kind: "overdue",
        deadline: receipt.convergence.deadline,
        requiredNodes: receipt.convergence.requiredNodes,
      },
    };
  }
  return receipt;
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

async function readActivationState(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
): Promise<ControlPlaneActivationState | undefined> {
  const [row] = await transaction.select<MigrationRow>(
    "migrations",
    scope(identity, { migrationId: ACTIVATION_MIGRATION_ID }),
    [],
    1,
  );
  if (!row) return undefined;
  const document = decodeJson(row.compatibility);
  if (!isRecord(document)) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Control-plane runtime activation state is invalid.",
    );
  }
  if (
    typeof document.generation !== "number" ||
    !Number.isSafeInteger(document.generation) ||
    typeof document.currentFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(document.currentFingerprint) ||
    (document.nextFingerprint !== undefined &&
      (typeof document.nextFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/u.test(document.nextFingerprint)))
  ) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Control-plane runtime activation state is invalid.",
    );
  }
  return Object.freeze({
    generation: document.generation,
    currentFingerprint: document.currentFingerprint,
    ...(document.nextFingerprint === undefined
      ? {}
      : { nextFingerprint: document.nextFingerprint }),
  });
}

async function requireActivationState(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
): Promise<ControlPlaneActivationState> {
  const state = await readActivationState(transaction, identity);
  if (!state) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Control-plane runtime activation is not initialized.",
    );
  }
  return state;
}

async function initializeActivationState(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  fingerprint: string,
): Promise<ControlPlaneActivationState> {
  const now = await transaction.databaseTime();
  const state = Object.freeze({ generation: 0, currentFingerprint: fingerprint });
  await transaction.insert(
    "migrations",
    {
      modelVersion: 1,
      id: `migration:${ACTIVATION_MIGRATION_ID}`,
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      createdAt: now,
      updatedAt: now,
      aggregateVersion: 0,
      authorityVersion: 0,
      effectiveVersion: 0,
      securityVersion: 0,
      migrationId: ACTIVATION_MIGRATION_ID,
      source: "runtime-bootstrap",
      destination: "runtime-bootstrap",
      phase: "activated",
      manifestHash: fingerprint,
      checksum: fingerprint,
      compatibility: encodeCanonicalJson(state),
      activatedAt: now,
    },
    { target: ["logicalHostId", "id"] },
  );
  return (await readActivationState(transaction, identity)) ?? state;
}

async function persistActivationState(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  state: ControlPlaneActivationState,
): Promise<void> {
  const now = await transaction.databaseTime();
  const changed = await transaction.update(
    "migrations",
    {
      phase: state.nextFingerprint ? "staged" : "activated",
      manifestHash: state.currentFingerprint,
      checksum: state.nextFingerprint ?? state.currentFingerprint,
      compatibility: encodeCanonicalJson(state),
      activatedAt: state.nextFingerprint ? null : now,
      updatedAt: now,
    },
    scope(identity, { migrationId: ACTIVATION_MIGRATION_ID }),
  );
  if (changed !== 1) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Control-plane runtime activation changed concurrently.",
    );
  }
}

function normalizeFingerprint(value: string): string {
  return /^[a-f0-9]{64}$/u.test(value) ? value : sha256(value);
}

function validateConvergenceToken(token: ControlPlaneConvergenceToken): void {
  if (
    !Number.isSafeInteger(token.authorityGeneration) ||
    token.authorityGeneration < 0 ||
    !Number.isSafeInteger(token.effectiveGeneration) ||
    token.effectiveGeneration < 0 ||
    !Number.isSafeInteger(token.securityEpoch) ||
    token.securityEpoch < 0
  ) {
    throw new Error("Control-plane convergence token is invalid");
  }
}

function compareConvergenceTokens(
  left: ControlPlaneConvergenceToken,
  right: ControlPlaneConvergenceToken,
): number {
  return (
    left.authorityGeneration - right.authorityGeneration ||
    left.effectiveGeneration - right.effectiveGeneration ||
    left.securityEpoch - right.securityEpoch
  );
}

function sameConvergenceToken(
  left: ControlPlaneConvergenceToken,
  right: ControlPlaneConvergenceToken,
): boolean {
  return compareConvergenceTokens(left, right) === 0;
}

function runtimeCompatibilityMatches(
  expected: ControlPlaneStoreOptions["dialect"]["compatibility"],
  declared: ControlPlaneNodeRegistration["compatibility"],
  requireDistributedCommitments: boolean,
): boolean {
  const capabilities = new Set(declared.capabilities);
  return (
    satisfies(declared.binaryVersion, SUPPORTED_RUNTIME_BINARY_RANGE) &&
    expected.schemaVersion === declared.schemaVersion &&
    expected.keyVersion === declared.keyVersion &&
    expected.manifestVersion === declared.manifestVersion &&
    (!expected.schemaManifestFingerprint ||
      expected.schemaManifestFingerprint === declared.schemaManifestFingerprint) &&
    (!requireDistributedCommitments ||
      (isCommitment(declared.providerCommitment) &&
        isCommitment(declared.keyCanaryCommitment) &&
        REQUIRED_RUNTIME_CAPABILITIES.every((capability) => capabilities.has(capability))))
  );
}

function isCommitment(value: string | undefined): value is string {
  return value !== undefined && /^[a-f0-9]{64}$/u.test(value);
}

async function cohortCommitmentsMatch(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  declared: ControlPlaneNodeRegistration["compatibility"],
  now: string,
): Promise<boolean> {
  const nodes = await transaction.select<NodeRow>("clusterNodeLeases", {
    equals: { logicalHostId: identity.logicalHostId, storeId: identity.storeId, state: "ready" },
    greaterThan: { expiresAt: now },
  });
  return nodes.every((node) => {
    const current = nodeDeclaredCompatibility(node);
    return (
      satisfies(current.binaryVersion, SUPPORTED_RUNTIME_BINARY_RANGE) &&
      current.schemaVersion === declared.schemaVersion &&
      current.keyVersion === declared.keyVersion &&
      current.manifestVersion === declared.manifestVersion &&
      current.schemaManifestFingerprint === declared.schemaManifestFingerprint &&
      keyProviderAdvertisementsOverlap(current, declared) &&
      REQUIRED_RUNTIME_CAPABILITIES.every(
        (capability) =>
          current.capabilities?.includes(capability) && declared.capabilities?.includes(capability),
      )
    );
  });
}

function keyProviderAdvertisementsOverlap(
  current: ControlPlaneNodeRegistration["compatibility"],
  declared: ControlPlaneNodeRegistration["compatibility"],
): boolean {
  const currentMaterials = keyMaterialsByPurpose(current.capabilities);
  const declaredMaterials = keyMaterialsByPurpose(declared.capabilities);
  const purposes = new Set([...currentMaterials.keys(), ...declaredMaterials.keys()]);
  if (purposes.size === 0) {
    return (
      current.providerCommitment === declared.providerCommitment &&
      current.keyCanaryCommitment === declared.keyCanaryCommitment
    );
  }
  for (const purpose of purposes) {
    const currentKeys = currentMaterials.get(purpose);
    const declaredKeys = declaredMaterials.get(purpose);
    if (!currentKeys || !declaredKeys) return false;
    if (![...currentKeys].some((key) => declaredKeys.has(key))) return false;
  }
  return true;
}

function keyMaterialsByPurpose(
  capabilities: readonly string[] | undefined,
): ReadonlyMap<string, ReadonlySet<string>> {
  const materials = new Map<string, Set<string>>();
  for (const capability of capabilities ?? []) {
    const match = /^key-material:([^:]+):([1-9]\d*):([^:]+):([a-f0-9]{64})$/u.exec(capability);
    if (!match) continue;
    const purpose = match[1]!;
    const material = `${match[2]}:${match[3]}:${match[4]}`;
    const values = materials.get(purpose) ?? new Set<string>();
    values.add(material);
    materials.set(purpose, values);
  }
  return materials;
}

function nodeDeclaredCompatibility(node: NodeRow): ControlPlaneNodeRegistration["compatibility"] {
  const value = decodeJson(node.compatibility);
  if (!isRecord(value) || !isRecord(value.declared)) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Node compatibility advertisement is invalid.");
  }
  const declared = value.declared;
  const capabilities = declared.capabilities;
  if (
    typeof declared.binaryVersion !== "string" ||
    typeof declared.schemaVersion !== "number" ||
    !Number.isSafeInteger(declared.schemaVersion) ||
    typeof declared.keyVersion !== "number" ||
    !Number.isSafeInteger(declared.keyVersion) ||
    typeof declared.manifestVersion !== "number" ||
    !Number.isSafeInteger(declared.manifestVersion) ||
    (declared.schemaManifestFingerprint !== undefined &&
      typeof declared.schemaManifestFingerprint !== "string") ||
    (declared.providerCommitment !== undefined &&
      typeof declared.providerCommitment !== "string") ||
    (declared.keyCanaryCommitment !== undefined &&
      typeof declared.keyCanaryCommitment !== "string") ||
    (capabilities !== undefined &&
      (!Array.isArray(capabilities) ||
        capabilities.some((capability: unknown) => typeof capability !== "string")))
  ) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Node compatibility advertisement is invalid.");
  }
  return Object.freeze({
    binaryVersion: declared.binaryVersion,
    schemaVersion: declared.schemaVersion,
    keyVersion: declared.keyVersion,
    manifestVersion: declared.manifestVersion,
    ...(declared.schemaManifestFingerprint === undefined
      ? {}
      : { schemaManifestFingerprint: declared.schemaManifestFingerprint }),
    ...(declared.providerCommitment === undefined
      ? {}
      : { providerCommitment: declared.providerCommitment }),
    ...(declared.keyCanaryCommitment === undefined
      ? {}
      : { keyCanaryCommitment: declared.keyCanaryCommitment }),
    ...(capabilities === undefined
      ? {}
      : { capabilities: Object.freeze(capabilities.map((capability) => String(capability))) }),
  });
}

function nodeConvergenceToken(node: NodeRow): ControlPlaneConvergenceToken {
  return {
    authorityGeneration: decodeCanonicalVersion(node.authorityVersion),
    effectiveGeneration: decodeCanonicalVersion(node.effectiveVersion),
    securityEpoch: decodeCanonicalVersion(node.securityVersion),
  };
}

function nodePendingEffectiveRuntimeFingerprint(node: NodeRow): string | undefined {
  const value = decodeJson(node.compatibility);
  return isRecord(value) && typeof value.effectiveRuntimeFingerprint === "string"
    ? normalizeFingerprint(value.effectiveRuntimeFingerprint)
    : undefined;
}

function nodeAcknowledgedEffectiveRuntimeFingerprint(node: NodeRow): string | undefined {
  const value = decodeJson(node.compatibility);
  if (!isRecord(value)) return undefined;
  if (typeof value.acknowledgedEffectiveRuntimeFingerprint === "string") {
    return normalizeFingerprint(value.acknowledgedEffectiveRuntimeFingerprint);
  }
  return node.state === "ready" && typeof value.effectiveRuntimeFingerprint === "string"
    ? normalizeFingerprint(value.effectiveRuntimeFingerprint)
    : undefined;
}

function tupleFingerprintMigrationId(token: ControlPlaneConvergenceToken): string {
  return `${TUPLE_FINGERPRINT_MIGRATION_PREFIX}:${token.authorityGeneration}:${token.effectiveGeneration}:${token.securityEpoch}`;
}

async function tupleFingerprintMatches(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  token: ControlPlaneConvergenceToken,
  fingerprint: string,
): Promise<boolean> {
  const [row] = await transaction.select<MigrationRow>(
    "migrations",
    scope(identity, { migrationId: tupleFingerprintMigrationId(token) }),
    [],
    1,
  );
  if (!row) return true;
  const compatibility = decodeJson(row.compatibility);
  return (
    isRecord(compatibility) &&
    typeof compatibility.effectiveRuntimeFingerprint === "string" &&
    normalizeFingerprint(compatibility.effectiveRuntimeFingerprint) === fingerprint
  );
}

async function bindTupleFingerprint(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  now: string,
  token: ControlPlaneConvergenceToken,
  fingerprint: string,
): Promise<boolean> {
  const migrationId = tupleFingerprintMigrationId(token);
  const common = commonValues(options, now, `migration:${migrationId}`, {
    aggregateVersion: 0,
    authorityVersion: token.authorityGeneration,
    effectiveVersion: token.effectiveGeneration,
    securityVersion: token.securityEpoch,
  });
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
      migrationId,
      "runtime-tuple",
      "runtime-tuple",
      "activated",
      fingerprint,
      fingerprint,
      encodeCanonicalJson({ effectiveRuntimeFingerprint: fingerprint }),
      now,
    ],
    ["logical_host_id", "id"],
  );
  return tupleFingerprintMatches(transaction, options.identity, token, fingerprint);
}

async function countAppliedNodes(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  now: string,
  token: ControlPlaneConvergenceToken,
): Promise<number> {
  const nodes = await transaction.select<NodeRow>("clusterNodeLeases", {
    equals: {
      logicalHostId: options.identity.logicalHostId,
      storeId: options.identity.storeId,
      state: "ready",
    },
    greaterThan: { expiresAt: now },
  });
  return nodes.filter((node) =>
    sameConvergenceToken(
      {
        authorityGeneration: decodeCanonicalVersion(node.authorityVersion),
        effectiveGeneration: decodeCanonicalVersion(node.effectiveVersion),
        securityEpoch: decodeCanonicalVersion(node.securityVersion),
      },
      token,
    ),
  ).length;
}

async function updateConvergedReceipts(
  transaction: ControlPlaneSqlTransaction,
  options: ControlPlaneStoreOptions,
  _now: string,
  token: ControlPlaneConvergenceToken,
  appliedNodes: number,
): Promise<void> {
  await transaction.settleConvergenceReceipts({
    logicalHostId: options.identity.logicalHostId,
    storeId: options.identity.storeId,
    authorityGeneration: token.authorityGeneration,
    effectiveGeneration: token.effectiveGeneration,
    securityEpoch: token.securityEpoch,
    appliedNodes,
    limit: CONVERGENCE_RECEIPT_BATCH_SIZE,
  });
}

async function currentConvergenceAdvancedAt(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  versions: VersionRows,
): Promise<string> {
  const [authority, effective, security] = await Promise.all([
    transaction.select<AuthorityVersionRow>(
      "authorityVersions",
      scope(identity, { generation: versions.authorityGeneration }),
      [],
      1,
    ),
    transaction.select<EffectiveVersionRow>(
      "effectiveVersions",
      scope(identity, { generation: versions.effectiveGeneration }),
      [],
      1,
    ),
    transaction.select<SecurityVersionRow>(
      "securityVersions",
      scope(identity, { epoch: versions.securityEpoch }),
      [],
      1,
    ),
  ]);
  const clocks = [authority[0]?.updatedAt, effective[0]?.publishedAt, security[0]?.advancedAt];
  const validClocks = clocks.filter((clock): clock is string => typeof clock === "string");
  if (validClocks.length !== clocks.length) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Convergence publication clock is unavailable.");
  }
  return validClocks.reduce((latest, clock) =>
    Date.parse(clock) > Date.parse(latest) ? clock : latest,
  );
}

function unavailableHealth(
  options: ControlPlaneStoreOptions,
  versions: VersionRows,
  warm: boolean,
  lastConnectedAt: number,
): ControlPlaneHealthSummary {
  return {
    backend: options.dialect.backend,
    readiness: warm ? "stale-read-only" : "not-ready",
    connectivity: "unavailable",
    migration: options.dialect.ready ? "current" : "blocked",
    authorityToken: {
      authorityGeneration: versions.authorityGeneration,
      effectiveGeneration: versions.effectiveGeneration,
    },
    bootstrapCompatibility: "current",
    ...(warm ? { staleAgeMs: Math.max(0, Date.now() - lastConnectedAt) } : {}),
    convergence: options.dialect.backend === "sqlite" ? "single-node" : "overdue",
    guidanceCode: "storage-unavailable",
  };
}

function activationLock(identity: ControlPlaneStoreIdentity): string {
  return `runtime-activation:${identity.logicalHostId}:${identity.storeId}`;
}

function nodeLeaseLock(identity: ControlPlaneStoreIdentity, nodeId: string): string {
  return `node-lease:${identity.logicalHostId}:${identity.storeId}:${nodeId}`;
}

function scope(
  identity: ControlPlaneStoreIdentity,
  values: Readonly<Record<string, unknown>> = {},
) {
  return {
    equals: {
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      ...values,
    },
  } as const;
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

async function hasCurrentCanaryProofs(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  nodeId: string,
  fence: ControlPlaneWriterFence,
): Promise<boolean> {
  if (fence.leaseId !== `writer:${nodeId}`) return false;
  const inventories = await transaction.select<KeyInventoryProofRow>(
    "keyInventory",
    scope(identity, { state: "active" }),
  );
  return inventories.every((inventory) => {
    try {
      const proofs = decodeCanonicalJson(inventory.verifiedNodeIds);
      return (
        Array.isArray(proofs) &&
        proofs.some(
          (proof) =>
            isRecord(proof) &&
            proof.nodeId === nodeId &&
            proof.leaseId === fence.leaseId &&
            proof.writerEpoch === fence.writerEpoch &&
            proof.authorityGeneration === fence.authorityGeneration,
        )
      );
    } catch {
      return false;
    }
  });
}

async function retireWriterFence(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  leaseId: string,
  now: string,
): Promise<void> {
  await transaction.update(
    "writerFences",
    { state: "revoked", expiresAt: now, updatedAt: now },
    scope(identity, { leaseId }),
  );
}

async function upsertNode(
  transaction: ControlPlaneSqlTransaction,
  common: readonly unknown[],
  input: ControlPlaneNodeRegistration,
  now: string,
  expiresAt: string,
  state:
    | "ready"
    | "catching-up"
    | "activation-pending"
    | "capacity-rejected"
    | "compatibility-rejected",
  assignedReadyNodes: number,
  acknowledgedEffectiveRuntimeFingerprint?: string,
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
      normalizeFingerprint(input.bootstrapFingerprint),
      encodeCanonicalJson({
        declared: input.compatibility,
        effectiveRuntimeFingerprint: normalizeFingerprint(input.effectiveRuntimeFingerprint),
        assignedReadyNodes,
        ...(acknowledgedEffectiveRuntimeFingerprint
          ? {
              acknowledgedEffectiveRuntimeFingerprint: normalizeFingerprint(
                acknowledgedEffectiveRuntimeFingerprint,
              ),
            }
          : {}),
      }),
      now,
      expiresAt,
      state,
    ],
    ["logical_host_id", "id"],
  );
}

function commonValues(
  options: Pick<ControlPlaneStoreOptions, "identity">,
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
  cp_snapshot_envelope: "snapshotEnvelopes",
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

type AuthorityVersionRow = ControlPlaneSqlRow & {
  generation: number | bigint;
  updatedAt: string;
};
type EffectiveVersionRow = ControlPlaneSqlRow & {
  generation: number | bigint;
  publishedAt: string;
};
type SecurityVersionRow = ControlPlaneSqlRow & {
  epoch: number | bigint;
  advancedAt: string;
};
type AggregateVersionRow = ControlPlaneSqlRow & { aggregateVersion: number | bigint };
type ReservationRow = ControlPlaneSqlRow & {
  target: unknown;
  state: string;
  reservedAt: string;
};
type OutcomeRow = ControlPlaneSqlRow & {
  operationId: string;
  receipt: unknown;
  convergenceClass: string;
  securityVersion: number | bigint;
};
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
type KeyInventoryProofRow = ControlPlaneSqlRow & {
  verifiedNodeIds: string;
};
type FenceRow = ControlPlaneSqlRow & {
  writerEpoch: number | bigint;
  authorityGeneration: number | bigint;
  expiresAt: string;
  state: string;
};
type SnapshotEnvelopeRow = ControlPlaneSqlRow & {
  envelopeId: string;
  effectiveVersion: number | bigint;
  capletCount: number | bigint;
  normalizedRowCount: number | bigint;
  encodedByteCount: number | bigint;
};
type MigrationRow = ControlPlaneSqlRow & {
  migrationId: string;
  compatibility: unknown;
};
type NodeRow = ControlPlaneSqlRow & {
  nodeId: string;
  state: string;
  expiresAt: string;
  compatibility: unknown;
  bootstrapFingerprint: string;
  authorityVersion: number | bigint;
  effectiveVersion: number | bigint;
  securityVersion: number | bigint;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
