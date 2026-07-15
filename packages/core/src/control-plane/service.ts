import type {
  CurrentHostOperationBinding,
  CurrentHostOperationLookupOutcome,
} from "../current-host/operations";
import { CapletsError } from "../errors";
import {
  validateControlPlaneAuthorization,
  type ControlPlaneAuthorizer,
  type ControlPlaneAuthorizationDecision,
} from "./authorization";
import {
  createControlPlaneMigrationPersistence,
  type ControlPlaneMigrationPersistence,
  type ControlPlaneMigrationPersistenceOptions,
} from "./migration/persistence";
import type { ControlPlaneSqlTransaction, ControlPlaneStore } from "./store";
import type {
  CapletManagementMutation,
  ControlPlaneMutationResult,
  HostSettingManagementMutation,
} from "./types";

export type ControlPlaneService = Readonly<{
  mutateCaplet(input: CapletManagementMutation): Promise<ControlPlaneMutationResult>;
  mutateHostSetting(input: HostSettingManagementMutation): Promise<ControlPlaneMutationResult>;
  lookupOperation(binding: CurrentHostOperationBinding): Promise<CurrentHostOperationLookupOutcome>;
}>;

export function createControlPlaneService(options: {
  store: ControlPlaneStore;
  authorization: ControlPlaneAuthorizer;
}): ControlPlaneService {
  const authorize = async (
    binding: CurrentHostOperationBinding,
    transaction?: ControlPlaneSqlTransaction,
  ): Promise<ControlPlaneAuthorizationDecision> => {
    const request = {
      actorId: binding.actorId,
      logicalHostId: binding.logicalHostId,
      storeId: binding.storeId,
      operationNamespace: binding.operationNamespace,
      requiredRole: "operator" as const,
    };
    const decision =
      transaction && options.authorization.authorizeInTransaction
        ? await options.authorization.authorizeInTransaction(transaction, request)
        : await options.authorization.authorize(request);
    return validateControlPlaneAuthorization(request, decision);
  };

  const prepare = async <T extends CapletManagementMutation | HostSettingManagementMutation>(
    input: T,
  ): Promise<ControlPlaneMutationResult | T> => {
    if (input.binding.logicalHostId !== options.store.identity.logicalHostId) {
      return { status: "denied", reason: "wrong-host" };
    }
    if (input.binding.storeId !== options.store.identity.storeId) {
      return { status: "denied", reason: "wrong-store" };
    }
    const decision = await authorize(input.binding);
    if (decision.status === "denied") {
      if (decision.reason === "unavailable") return { status: "unavailable" };
      if (decision.reason === "namespace-mismatch") {
        return { status: "denied", reason: "stale-authority" };
      }
      return {
        status: "denied",
        reason:
          decision.reason === "revoked" || decision.reason === "role-insufficient"
            ? "revoked-role"
            : "wrong-store",
      };
    }
    if (decision.authorization.securityEpoch !== input.expectedSecurityEpoch) {
      return { status: "denied", reason: "stale-security" };
    }
    const trustedInput = {
      ...input,
      expectedSecurityEpoch: decision.authorization.securityEpoch,
      writerFence: decision.authorization.writerFence,
      finalAuthorization: async (transaction: ControlPlaneSqlTransaction) => {
        const finalDecision = await authorize(input.binding, transaction);
        if (finalDecision.status === "denied") {
          if (finalDecision.reason === "unavailable") return { status: "unavailable" } as const;
          if (finalDecision.reason === "namespace-mismatch") {
            return { status: "denied", reason: "stale-authority" } as const;
          }
          return {
            status: "denied",
            reason:
              finalDecision.reason === "revoked" || finalDecision.reason === "role-insufficient"
                ? "revoked-role"
                : "wrong-store",
          } as const;
        }
        if (finalDecision.authorization.securityEpoch !== input.expectedSecurityEpoch) {
          return { status: "denied", reason: "stale-security" } as const;
        }
        return {
          status: "authorized",
          securityEpoch: finalDecision.authorization.securityEpoch,
          writerFence: finalDecision.authorization.writerFence,
        } as const;
      },
    };
    const reservation = await options.store.reserveOperation(input.binding, input.aggregateId);
    if (reservation.status === "unavailable") return { status: "unavailable" };
    if (reservation.status === "conflict") {
      return { status: "conflict", reason: "operation-reservation" };
    }
    if (reservation.status === "committed") {
      return { status: "committed", receipt: reservation.receipt };
    }
    return trustedInput;
  };

  return {
    async lookupOperation(binding) {
      if (
        binding.logicalHostId !== options.store.identity.logicalHostId ||
        binding.storeId !== options.store.identity.storeId
      ) {
        return { status: "wrong_target", binding };
      }
      const decision = await authorize(binding);
      if (decision.status === "denied") {
        if (decision.reason === "unavailable") return { status: "unavailable", binding };
        if (decision.reason === "namespace-mismatch") {
          return { status: "stale_namespace", binding };
        }
        return { status: "unknown", binding };
      }
      return options.store.lookupOrReserveNotCommitted(binding);
    },
    async mutateCaplet(input) {
      const prepared = await prepare(input);
      return "aggregateId" in prepared ? options.store.mutateCaplet(prepared) : prepared;
    },
    async mutateHostSetting(input) {
      const prepared = await prepare(input);
      return "aggregateId" in prepared ? options.store.mutateHostSetting(prepared) : prepared;
    },
  };
}

export type InternalControlPlaneStorageMigrationRequest = Readonly<{
  target: "global";
  mode: "offline";
}>;

export type InternalControlPlaneStorageMigrationResult = Readonly<{
  status: "migrated" | "already-migrated";
  backend: "sqlite" | "postgres";
  authorityToken?: string | undefined;
  manifestSha256?: string | undefined;
}>;

/**
 * Internal U7 seam only. Production runtime construction intentionally does not create or call
 * this service until U10 owns the storage activation boundary.
 */
export type InternalControlPlaneStorageMigrationService = Readonly<{
  migrate(
    request: InternalControlPlaneStorageMigrationRequest,
  ): Promise<InternalControlPlaneStorageMigrationResult>;
}>;

export function createInternalControlPlaneStorageMigrationService(
  options: Readonly<{
    initialize(
      request: InternalControlPlaneStorageMigrationRequest,
      persistence?: ControlPlaneMigrationPersistence,
    ): Promise<InternalControlPlaneStorageMigrationResult>;
    persistence?: ControlPlaneMigrationPersistenceOptions | undefined;
  }>,
): InternalControlPlaneStorageMigrationService {
  const persistence = options.persistence
    ? createControlPlaneMigrationPersistence(options.persistence)
    : undefined;
  return {
    async migrate(request) {
      if (request.target !== "global" || request.mode !== "offline") {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Internal storage migration requires the global offline target",
        );
      }
      const migrationRequest = { target: "global", mode: "offline" } as const;
      return persistence
        ? options.initialize(migrationRequest, persistence)
        : options.initialize(migrationRequest);
    },
  };
}
