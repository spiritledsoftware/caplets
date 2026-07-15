import type {
  CurrentHostConfirmationToken,
  CurrentHostOperationBinding,
  CurrentHostOperationLookupOutcome,
} from "../current-host/operations";
import type {
  CapletManagementMutation,
  ConfirmationConsumeResult,
  ConfirmationConsumption,
  ConfirmationPreviewRequest,
  ControlPlaneHealthSummary,
  ControlPlaneMutationResult,
  ControlPlaneNodeRegistration,
  ControlPlaneRuntimeCompatibility,
  ControlPlaneNodeRegistrationResult,
  ControlPlaneOperationReservationResult,
  ControlPlaneSnapshot,
  ControlPlaneStoreIdentity,
  ControlPlaneVersionState,
  ExternalDestructionIntent,
  ExternalDestructionPort,
  ExternalDestructionStatus,
  HostSettingManagementMutation,
} from "./types";

export type ControlPlaneDatabaseRow = Readonly<Record<string, unknown>>;

export type ControlPlaneTable =
  | "hostSettings"
  | "caplets"
  | "capletProvenance"
  | "operationNamespaces"
  | "operationReservations"
  | "operationOutcomes"
  | "operationTombstones"
  | "confirmations"
  | "oauthTokens"
  | "clients"
  | "credentials"
  | "pendingApprovals"
  | "dashboardSessions"
  | "projectBindingWorkspaces"
  | "projectBindingLeases"
  | "projectBindingReceipts"
  | "vaultValues"
  | "vaultGrants"
  | "operatorActivities"
  | "authorityVersions"
  | "effectiveVersions"
  | "securityVersions"
  | "keyInventory"
  | "keyCanaries"
  | "clusterNodeLeases"
  | "writerFences"
  | "migrations"
  | "backups"
  | "recoveries"
  | "retentions"
  | "externalDestructions"
  | "recoveryCheckpoints"
  | "quarantines"
  | "capletDocuments"
  | "capletBackends"
  | "capletCatalogs"
  | "capletCatalogTags"
  | "capletDeclaredInputs"
  | "capletReferences"
  | "capletAssets"
  | "capletActivationHistory";

export type ControlPlaneFilter = Readonly<{
  equals?: Readonly<Record<string, unknown>> | undefined;
  greaterThan?: Readonly<Record<string, unknown>> | undefined;
}>;

export type ControlPlaneOrder = Readonly<{
  column: string;
  direction?: "asc" | "desc" | undefined;
}>;

/**
 * A transaction-scoped, dialect-neutral persistence capability. Implementations use the
 * corresponding U4 Drizzle schema; repository/service callers never receive a driver or dialect.
 */
export interface ControlPlaneSqlTransaction {
  readonly backend: "sqlite" | "postgres";
  select<Row extends ControlPlaneDatabaseRow>(
    table: ControlPlaneTable,
    filter?: ControlPlaneFilter,
    order?: readonly ControlPlaneOrder[],
    limit?: number,
  ): Promise<readonly Row[]>;
  insert(
    table: ControlPlaneTable,
    values: Readonly<Record<string, unknown>>,
    conflict?: Readonly<{
      target: readonly string[];
      update?: Readonly<Record<string, unknown>> | undefined;
    }>,
  ): Promise<number>;
  update(
    table: ControlPlaneTable,
    values: Readonly<Record<string, unknown>>,
    filter: ControlPlaneFilter,
  ): Promise<number>;
  delete(table: ControlPlaneTable, filter: ControlPlaneFilter): Promise<number>;
  databaseTime(): Promise<string>;
  lock(serialKey: string): Promise<void>;
}

/** The only dialect capability accepted by the neutral repository. */
export interface ControlPlaneTransactionalDialect {
  readonly backend: "sqlite" | "postgres";
  readonly ready: boolean;
  readonly compatibility: ControlPlaneRuntimeCompatibility;
  runtimeTransaction<T>(work: (transaction: ControlPlaneSqlTransaction) => Promise<T>): Promise<T>;
  snapshotTransaction<T>(work: (transaction: ControlPlaneSqlTransaction) => Promise<T>): Promise<T>;
  maintenanceTransaction<T>(
    work: (transaction: ControlPlaneSqlTransaction) => Promise<T>,
  ): Promise<T>;
  /** Postgres SECURITY DEFINER primitive; omitted by SQLite, which uses typed transaction CRUD. */
  maintenancePurgeExpiredOperatorActivity?(
    input: Readonly<{
      logicalHostId: string;
      storeId: string;
      receiptId: string;
      watermark: number;
      limit: number;
    }>,
  ): Promise<Readonly<{ deleted: number; occurredAt: string }>>;
}

export type ControlPlaneFailurePoint =
  | "after-operation-lock"
  | "after-domain-write"
  | "after-provenance"
  | "after-activity"
  | "after-generation"
  | "before-fence-guard"
  | "after-receipt"
  | "before-external-remove"
  | "after-external-remove"
  | "before-destruction-receipt";

export type ControlPlaneStoreOptions = Readonly<{
  identity: ControlPlaneStoreIdentity;
  dialect: ControlPlaneTransactionalDialect;
  reservationTtlMs?: number | undefined;
  failureInjector?: ((point: ControlPlaneFailurePoint) => void | Promise<void>) | undefined;
}>;

export interface ControlPlaneStore {
  readonly identity: ControlPlaneStoreIdentity;
  readonly backend: "sqlite" | "postgres";

  initialize(): Promise<ControlPlaneVersionState>;
  reserveOperation(
    binding: CurrentHostOperationBinding,
    aggregateId: string,
  ): Promise<ControlPlaneOperationReservationResult>;
  lookupOrReserveNotCommitted(
    binding: CurrentHostOperationBinding,
    aggregateId?: string,
  ): Promise<CurrentHostOperationLookupOutcome>;

  mutateCaplet(input: CapletManagementMutation): Promise<ControlPlaneMutationResult>;
  mutateHostSetting(input: HostSettingManagementMutation): Promise<ControlPlaneMutationResult>;
  loadSnapshot(): Promise<ControlPlaneSnapshot>;

  createConfirmationPreview(
    request: ConfirmationPreviewRequest,
  ): Promise<CurrentHostConfirmationToken>;
  consumeConfirmation<T>(
    request: ConfirmationConsumption,
    action: (transaction: ControlPlaneSqlTransaction) => Promise<T>,
  ): Promise<ConfirmationConsumeResult<T>>;

  confirmExternalDestruction(
    request: ConfirmationConsumption,
    intent: ExternalDestructionIntent,
  ): Promise<ConfirmationConsumeResult<ExternalDestructionStatus>>;
  resumeExternalDestruction(
    destructionId: string,
    external: ExternalDestructionPort,
  ): Promise<ExternalDestructionStatus>;

  recordOperationalLedger(
    input: Readonly<{
      kind: "heartbeat" | "session-expiry" | "retention" | "migration" | "recovery";
      id: string;
      detail?: Readonly<Record<string, unknown>> | undefined;
    }>,
  ): Promise<void>;
  registerNode(input: ControlPlaneNodeRegistration): Promise<ControlPlaneNodeRegistrationResult>;
  health(): Promise<ControlPlaneHealthSummary>;
}
