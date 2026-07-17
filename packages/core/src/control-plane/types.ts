import type {
  CurrentHostAuthorityToken,
  CurrentHostConfirmationToken,
  CurrentHostOperationBinding,
  CurrentHostOperationLookupOutcome,
  CurrentHostOperationReceipt,
  CurrentHostOperationIndeterminateOutcome,
} from "../current-host/operations";
import type { CurrentHostManagementTargetDetail } from "../current-host/operations";
import type {
  CanonicalCapletAggregate,
  CanonicalCapletRelationalProjection,
} from "./caplets/model";
import type { CanonicalHostSetting } from "./model";
import type { ControlPlaneSqlTransaction } from "./store";

export type ControlPlaneStoreIdentity = Readonly<{
  logicalHostId: string;
  storeId: string;
  operationNamespace: string;
}>;

export function controlPlaneNodeAdmissionLock(
  identity: Pick<ControlPlaneStoreIdentity, "logicalHostId" | "storeId">,
): string {
  return `node-admission:${identity.logicalHostId}:${identity.storeId}`;
}

export type ControlPlaneVersionState = Readonly<{
  authorityGeneration: number;
  effectiveGeneration: number;
  securityEpoch: number;
}>;

export type ControlPlaneWriterFence = Readonly<{
  leaseId: string;
  writerEpoch: number;
  authorityGeneration: number;
}>;

/** Exact live authority required by internal production maintenance mutations. */
export type ControlPlaneMaintenanceFence = Readonly<{
  securityEpoch: number;
  writerFence: ControlPlaneWriterFence;
}>;

export type ControlPlaneAuthorization = Readonly<{
  logicalHostId: string;
  storeId: string;
  operationNamespace: string;
  actorId: string;
  role: "access" | "operator";
  securityEpoch: number;
  writerFence: ControlPlaneWriterFence;
}>;

export type ControlPlaneProvenance = Readonly<{
  id: string;
  sourceKind: string;
  source: Readonly<Record<string, unknown>>;
  contentHash: string;
  runtimeFingerprint?: string | undefined;
  installedAt?: string | undefined;
  resolvedRevision?: string | undefined;
  riskSummary?: Readonly<Record<string, unknown>> | undefined;
  ownerId?: string | undefined;
}>;

export type ControlPlaneActivity = Readonly<{
  id: string;
  action: string;
  target: Readonly<Record<string, unknown>>;
  detail?: Readonly<Record<string, unknown>> | undefined;
}>;

export type ControlPlaneFinalAuthorization =
  | Readonly<{
      status: "authorized";
      securityEpoch: number;
      writerFence: ControlPlaneWriterFence;
    }>
  | Readonly<{
      status: "denied";
      reason: "wrong-host" | "wrong-store" | "stale-authority" | "stale-security" | "revoked-role";
    }>
  | Readonly<{ status: "unavailable" }>;

export type ControlPlaneMutationContext = Readonly<{
  binding: CurrentHostOperationBinding;
  aggregateId: string;
  expectedAggregateVersion: number;
  expectedAuthorityGeneration: number;
  expectedSecurityEpoch: number;
  writerFence: ControlPlaneWriterFence;
  localApplication?: CurrentHostOperationReceipt["localApplication"] | undefined;
  managementTarget?: CurrentHostManagementTargetDetail | undefined;
  activity: ControlPlaneActivity;
  finalAuthorization?:
    | ((transaction: ControlPlaneSqlTransaction) => Promise<ControlPlaneFinalAuthorization>)
    | undefined;
}>;

export type CapletManagementMutation = ControlPlaneMutationContext &
  Readonly<{
    aggregate: CanonicalCapletAggregate;
    projection: CanonicalCapletRelationalProjection;
    provenance: ControlPlaneProvenance;
  }>;

export type HostSettingManagementMutation = ControlPlaneMutationContext &
  Readonly<{
    setting: CanonicalHostSetting;
    provenance: ControlPlaneProvenance;
  }>;

export type UntrustedCapletManagementMutation = Omit<
  CapletManagementMutation,
  "writerFence" | "finalAuthorization"
>;

export type UntrustedHostSettingManagementMutation = Omit<
  HostSettingManagementMutation,
  "writerFence" | "finalAuthorization"
>;

export type ControlPlaneConflictReason =
  | "aggregate-version"
  | "operation-reservation"
  | "writer-fence"
  | "authority-generation"
  | "security-epoch";

export type ControlPlaneMutationResult =
  | Readonly<{ status: "committed"; receipt: CurrentHostOperationReceipt }>
  | CurrentHostOperationIndeterminateOutcome
  | Readonly<{ status: "conflict"; reason: ControlPlaneConflictReason }>
  | Readonly<{
      status: "denied";
      reason: "wrong-host" | "wrong-store" | "stale-authority" | "stale-security" | "revoked-role";
    }>
  | Readonly<{ status: "unavailable" }>;

export type ControlPlaneOperationReservationResult =
  | Readonly<{ status: "reserved"; binding: CurrentHostOperationBinding }>
  | Readonly<{ status: "committed"; receipt: CurrentHostOperationReceipt }>
  | Readonly<{ status: "conflict"; reason: "operation-binding" | "operation-consumed" }>
  | Readonly<{ status: "unavailable" }>;

export type ConfirmationPreviewRequest = Readonly<{
  tokenId: string;
  action: string;
  authorityToken: CurrentHostAuthorityToken;
  affectedVersions: readonly string[];
  expiresInMs: number;
  consequences: readonly string[];
}>;

export type ConfirmationConsumption = Readonly<{
  token: CurrentHostConfirmationToken;
  action: string;
  authorityToken: CurrentHostAuthorityToken;
  affectedVersions: readonly string[];
}>;

export type ConfirmationConsumeResult<T> =
  | Readonly<{ status: "committed"; value: T }>
  | Readonly<{
      status: "rejected";
      reason:
        | "absent"
        | "expired"
        | "stale-authority"
        | "changed-inventory"
        | "mismatched-action"
        | "replayed";
    }>;

export type ExternalDestructionMaterial = Readonly<{
  kind: "bytes" | "key";
  id: string;
}>;

export type ExternalDestructionIntent = Readonly<{
  destructionId: string;
  providerIdentity: string;
  confirmationId: string;
  inventoryHash: string;
  material: readonly ExternalDestructionMaterial[];
}>;

export type ExternalDestructionStatus = Readonly<{
  destructionId: string;
  phase: "intended" | "in-progress" | "completed";
  completedAt?: string | undefined;
  receipt?: Readonly<Record<string, unknown>> | undefined;
}>;

export type ExternalDestructionPort = Readonly<{
  providerIdentity: string;
  remove(material: ExternalDestructionMaterial): Promise<void>;
  isAbsent(material: ExternalDestructionMaterial): Promise<boolean>;
}>;

export type ControlPlaneRuntimeCompatibility = Readonly<{
  binaryVersion: string;
  schemaVersion: number;
  keyVersion: number;
  manifestVersion: number;
  schemaManifestFingerprint?: string | undefined;
  providerCommitment?: string | undefined;
  keyCanaryCommitment?: string | undefined;
  capabilities?: readonly string[] | undefined;
}>;

export type ControlPlaneConvergenceToken = ControlPlaneVersionState;

export type ControlPlaneActivationState = Readonly<{
  generation: number;
  currentFingerprint: string;
  nextFingerprint?: string | undefined;
}>;

export type ControlPlaneNodeRegistration = Readonly<{
  nodeId: string;
  bootstrapFingerprint: string;
  effectiveRuntimeFingerprint: string;
  compatibility: ControlPlaneRuntimeCompatibility;
  appliedToken: ControlPlaneConvergenceToken;
  ttlMs: number;
}>;

export type ControlPlaneNodeRegistrationResult =
  | Readonly<{ status: "ready"; readyNodes: number; writerFence: ControlPlaneWriterFence }>
  | Readonly<{
      status: "catching-up";
      readyNodes: number;
      writerFence?: ControlPlaneWriterFence | undefined;
    }>
  | Readonly<{ status: "activation-pending"; readyNodes: number }>
  | Readonly<{ status: "capacity-rejected"; readyNodes: 16 }>
  | Readonly<{ status: "compatibility-rejected" }>
  | Readonly<{ status: "identity-conflict" }>;

export type ControlPlaneNodeApplication = Readonly<{
  nodeId: string;
  bootstrapFingerprint: string;
  effectiveRuntimeFingerprint: string;
  appliedToken: ControlPlaneConvergenceToken;
  writerFence: ControlPlaneWriterFence;
}>;

export type ControlPlaneNodeApplicationResult =
  | Readonly<{ status: "applied"; appliedNodes: number }>
  | Readonly<{
      status: "rejected";
      reason: "lease-revoked" | "token-regression" | "token-behind" | "token-ahead" | "fingerprint";
    }>;

export type ControlPlaneSnapshot = Readonly<{
  identity: ControlPlaneStoreIdentity;
  versions: ControlPlaneVersionState;
  caplets: readonly Readonly<{
    aggregate: CanonicalCapletAggregate;
    projection: CanonicalCapletRelationalProjection;
  }>[];
  hostSettings: readonly CanonicalHostSetting[];
  hostSettingVersions?: Readonly<Record<string, number>> | undefined;
  encodedBytes: number;
  normalizedRows: number;
}>;

export type ControlPlaneHealthSummary = Readonly<{
  backend: "sqlite" | "postgres";
  readiness: "ready" | "not-ready" | "stale-read-only";
  connectivity: "connected" | "unavailable";
  migration: "current" | "blocked";
  authorityToken: CurrentHostAuthorityToken;
  bootstrapCompatibility: "current" | "staged" | "incompatible";
  staleAgeMs?: number | undefined;
  convergence: "single-node" | "within-budget" | "pending" | "overdue";
  guidanceCode:
    | "ok"
    | "storage-unavailable"
    | "migration-required"
    | "convergence-pending"
    | "convergence-overdue"
    | "bootstrap-incompatible";
}>;

export type ControlPlaneDetailedDiagnostics = Readonly<{
  backend: "sqlite" | "postgres";
  store: ControlPlaneStoreIdentity;
  fingerprint: ControlPlaneActivationState;
  keyCompatibility: Readonly<{
    status: "compatible" | "incompatible";
    activeVersion: number;
    providerCommitmentPresent: boolean;
    canaryCommitmentPresent: boolean;
  }>;
  readyNodes: number;
  overdueNodes: number;
}>;

export type OperationLookupResult = CurrentHostOperationLookupOutcome;
