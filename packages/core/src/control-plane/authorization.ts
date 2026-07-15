import { roleAllows, type RemoteClientRole } from "../remote/server-credentials";
import type { ControlPlaneSqlTransaction } from "./store";
import type { ControlPlaneAuthorization } from "./types";

export type ControlPlaneAuthorizationRequest = Readonly<{
  actorId: string;
  logicalHostId: string;
  storeId: string;
  operationNamespace: string;
  requiredRole: RemoteClientRole;
}>;

export type ControlPlaneAuthorizationDecision =
  | Readonly<{ status: "authorized"; authorization: ControlPlaneAuthorization }>
  | Readonly<{
      status: "denied";
      reason:
        | "revoked"
        | "role-insufficient"
        | "target-mismatch"
        | "namespace-mismatch"
        | "unavailable";
    }>;

export interface ControlPlaneAuthorizer {
  authorize(request: ControlPlaneAuthorizationRequest): Promise<ControlPlaneAuthorizationDecision>;
  authorizeInTransaction?(
    transaction: ControlPlaneSqlTransaction,
    request: ControlPlaneAuthorizationRequest,
  ): Promise<ControlPlaneAuthorizationDecision>;
}

export function validateControlPlaneAuthorization(
  request: ControlPlaneAuthorizationRequest,
  decision: ControlPlaneAuthorizationDecision,
): ControlPlaneAuthorizationDecision {
  if (decision.status === "denied") return decision;
  const authorization = decision.authorization;
  if (
    authorization.actorId !== request.actorId ||
    authorization.logicalHostId !== request.logicalHostId ||
    authorization.storeId !== request.storeId
  ) {
    return { status: "denied", reason: "target-mismatch" };
  }
  if (authorization.operationNamespace !== request.operationNamespace) {
    return { status: "denied", reason: "namespace-mismatch" };
  }
  if (!roleAllows(authorization.role, request.requiredRole)) {
    return { status: "denied", reason: "role-insufficient" };
  }
  return decision;
}
