import type {
  CurrentHostAuthorityToken,
  CurrentHostConfirmationToken,
  CurrentHostOperationBinding,
  CurrentHostOperationLookupOutcome,
  CurrentHostOperationReceipt,
  CurrentHostOperationIndeterminateOutcome,
} from "../current-host/operations";
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
}>;

export type ControlPlaneNodeRegistration = Readonly<{
  nodeId: string;
  bootstrapFingerprint: string;
  compatibility: ControlPlaneRuntimeCompatibility;
  ttlMs: number;
}>;

export type ControlPlaneNodeRegistrationResult =
  | Readonly<{ status: "ready"; readyNodes: number; writerFence: ControlPlaneWriterFence }>
  | Readonly<{ status: "capacity-rejected"; readyNodes: 16 }>
  | Readonly<{ status: "compatibility-rejected" }>
  | Readonly<{ status: "identity-conflict" }>;

export type ControlPlaneSnapshot = Readonly<{
  identity: ControlPlaneStoreIdentity;
  versions: ControlPlaneVersionState;
  caplets: readonly Readonly<{
    aggregate: CanonicalCapletAggregate;
    projection: CanonicalCapletRelationalProjection;
  }>[];
  hostSettings: readonly CanonicalHostSetting[];
  encodedBytes: number;
  normalizedRows: number;
}>;

export type ControlPlaneHealthSummary = Readonly<{
  backend: "sqlite" | "postgres";
  readiness: "ready" | "not-ready" | "stale-read-only";
  connectivity: "connected" | "unavailable";
  migration: "current" | "blocked";
  authorityToken: CurrentHostAuthorityToken;
  securityEpoch: number;
  convergence: "single-node" | "within-budget" | "overdue";
  guidanceCode: "ok" | "storage-unavailable" | "migration-required" | "convergence-overdue";
}>;

export type OperationLookupResult = CurrentHostOperationLookupOutcome;
