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
  ControlPlaneActivationState,
  ControlPlaneConvergenceToken,
  ControlPlaneDetailedDiagnostics,
  ControlPlaneHealthSummary,
  ControlPlaneMutationResult,
  ControlPlaneNodeApplication,
  ControlPlaneNodeApplicationResult,
  ControlPlaneNodeRegistration,
  ControlPlaneRuntimeCompatibility,
  ControlPlaneMaintenanceFence,
  ControlPlaneWriterFence,
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
  | "setupApprovals"
  | "setupExecutions"
  | "setupAttempts"
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
  | "snapshotEnvelopes"
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
  tryLock?(serialKey: string): Promise<boolean>;
  /**
   * Postgres-only SECURITY DEFINER proof that no application payload rows occupy a fresh
   * offline-migration destination. The maintenance role never receives direct table reads.
   */
  migrationDestinationContainsAuthoritativeRows?(
    logicalHostId: string,
    storeId: string,
  ): Promise<boolean>;
  finalWriterFenceGuard(
    input: Readonly<{
      logicalHostId: string;
      storeId: string;
      leaseId: string;
      writerEpoch: number;
      authorityGeneration: number;
      state?: "active" | "pending" | undefined;
    }>,
  ): Promise<number>;
  advanceSnapshotEnvelope(
    input: Readonly<{
      logicalHostId: string;
      storeId: string;
      envelopeId: string;
      capletDelta: number;
      normalizedRowDelta: number;
      encodedByteDelta: number;
      maxCaplets: number;
      maxNormalizedRows: number;
      maxEncodedBytes: number;
      expectedAuthorityGeneration: number;
      expectedSecurityEpoch: number;
      leaseId: string;
      writerEpoch: number;
      fenceAuthorityGeneration: number;
      fenceState: "active" | "pending";
    }>,
  ): Promise<number>;
  settleConvergenceReceipts(
    input: Readonly<{
      logicalHostId: string;
      storeId: string;
      authorityGeneration: number;
      effectiveGeneration: number;
      securityEpoch: number;
      appliedNodes: number;
      limit: number;
    }>,
  ): Promise<number>;
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
  /** Read-only initialization metadata uses the credential available to the current process. */
  metadataReadTransaction?<T>(
    work: (transaction: ControlPlaneSqlTransaction) => Promise<T>,
  ): Promise<T>;
  /**
   * Postgres notifications are lossy wakeups only. Consumers always confirm the ordered token
   * from SQL before composing or publishing a generation.
   */
  subscribeToChanges?(
    listener: (token: ControlPlaneConvergenceToken | undefined) => void,
  ): Promise<() => Promise<void>>;
  publishChange?(token: ControlPlaneConvergenceToken): Promise<void>;
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
  activationState(): Promise<ControlPlaneActivationState>;
  initializeActivationFingerprint(fingerprint: string): Promise<ControlPlaneActivationState>;
  stageNextFingerprint(
    nextFingerprint: string,
    fence?: ControlPlaneMaintenanceFence | undefined,
  ): Promise<ControlPlaneActivationState>;
  abortNextFingerprint(
    nextFingerprint: string,
    fence?: ControlPlaneMaintenanceFence | undefined,
  ): Promise<ControlPlaneActivationState>;
  activateNextFingerprint(
    nextFingerprint: string,
    fence?: ControlPlaneMaintenanceFence | undefined,
  ): Promise<ControlPlaneActivationState>;
  adoptSqliteActivationFingerprint?(
    input: Readonly<{
      previousFingerprint?: string | undefined;
      nextFingerprint: string;
      expectedEffectiveRuntimeFingerprint: string;
      expectedAuthorityGeneration: number;
      expectedEffectiveGeneration: number;
      expectedSecurityEpoch: number;
    }>,
  ): Promise<ControlPlaneActivationState>;
  convergenceToken(): Promise<ControlPlaneConvergenceToken>;
  subscribeToChanges(
    listener: (token: ControlPlaneConvergenceToken | undefined) => void,
  ): Promise<() => Promise<void>>;
  registerNode(input: ControlPlaneNodeRegistration): Promise<ControlPlaneNodeRegistrationResult>;
  acknowledgeNode(input: ControlPlaneNodeApplication): Promise<ControlPlaneNodeApplicationResult>;
  validateWriterFence?(writerFence: ControlPlaneWriterFence): Promise<boolean>;
  revokeNode(nodeId: string, writerFence?: ControlPlaneWriterFence | undefined): Promise<void>;
  sweepOverdueNodes(maximumLagMs: number): Promise<number>;
  health(): Promise<ControlPlaneHealthSummary>;
  detailedDiagnostics(): Promise<ControlPlaneDetailedDiagnostics>;
}
