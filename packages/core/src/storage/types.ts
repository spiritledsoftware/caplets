export const MAX_AUTHORITY_GENERATION_BYTES = 64 * 1024 * 1024;
export const MAX_SEMANTIC_COMMITS_PER_PRINCIPAL_PER_MINUTE = 60;
export const MAX_SEMANTIC_COMMITS_PER_HOST_PER_MINUTE = 300;
export type AuthorityProviderKind = "filesystem" | "sqlite" | "postgresql" | "s3";
export type AuthorityGenerationId = string;

export type CapletProvenance =
  | {
      kind: "global-config" | "global-file" | "project-config" | "project-file";
      path: string;
      identity?: string;
    }
  | {
      kind: "authority";
      authorityId: string;
      recordId: string;
      generationId: AuthorityGenerationId;
    };

export type AuthorityGenerationIdentity = {
  authorityId: string;
  id: AuthorityGenerationId;
  sequence: number;
  predecessorId: AuthorityGenerationId | null;
};

export type AuthorityGeneration<TSnapshot = unknown> = AuthorityGenerationIdentity & {
  schemaVersion: number;
  digest: string;
  committedAt: string;
  provenance: { provider: AuthorityProviderKind; namespace: string };
  snapshot: TSnapshot;
};

export type AuthorityHead = AuthorityGenerationIdentity & { digest: string };

export type SemanticCommandEnvelope<TCommand = unknown> = {
  authorityId: string;
  currentHostId: string;
  principalId: string;
  expectedGeneration: AuthorityGenerationIdentity | null;
  idempotencyKey: string;
  requestDigest: string;
  command: TCommand;
};

export type AuthorityReceipt<TResult = unknown> = {
  currentHostId: string;
  principalId: string;
  idempotencyKey: string;
  requestDigest: string;
  generation: AuthorityGenerationIdentity;
  result: TResult;
  expiresAt: string;
};

export type AuthorityCommitResult<TResult = unknown> =
  | {
      kind: "committed" | "replayed";
      generation: AuthorityGenerationIdentity;
      receipt: AuthorityReceipt<TResult>;
    }
  | { kind: "conflict"; active: AuthorityGenerationIdentity | null }
  | { kind: "rate_limited" | "quota_exhausted"; retryAfterMs: number };

export type AuxiliaryRead =
  | { kind: "session_touch"; sessionId: string }
  | { kind: "security_events"; afterWatermark?: string; limit: number };
export type AuxiliaryCommit =
  | {
      kind: "session_touch";
      sessionId: string;
      lastUsedAt: string;
      expectedRevision: string;
      expectedGeneration: AuthorityGenerationIdentity | null;
    }
  | { kind: "remove_session_touch"; sessionId: string }
  | { kind: "security_event"; event: RedactedAuthorityEvent };
export type AuxiliaryCommitResult =
  | { kind: "applied" | "unchanged"; watermark: string }
  | { kind: "missing" | "revoked" | "conflict" };
export type RedactedAuthorityEvent = {
  kind: "rejected" | "conflicted";
  occurredAt: string;
  attemptedGenerationId?: string;
  idempotencyKeyHash?: string;
  code: string;
};

export type AuthorityAuxiliarySession = {
  revision: string;
  lastUsedAt: string;
  revoked: boolean;
};

export type AuthorityAuxiliaryExport = {
  watermark: string;
  sessions?: Record<string, AuthorityAuxiliarySession>;
  securityEvents?: RedactedAuthorityEvent[];
  /** Optional provider cursor aligned with securityEvents; event payloads remain unchanged. */
  securityEventWatermarks?: string[];
};

export type AuthorityExport = {
  generation: AuthorityGeneration;
  auxiliaryWatermark: string;
  /** Optional typed durable receipt records supplied by authorities that export them. */
  receipts?: AuthorityReceipt<unknown>[];
  /** Optional typed auxiliary state; providers may omit domains they cannot enumerate. */
  auxiliary?: AuthorityAuxiliaryExport;
};
export type AuthorityRestoreResult = {
  generation: AuthorityGenerationIdentity;
  auxiliaryWatermark: string;
  diagnostics?: AuthorityLifecycleDiagnostic[];
};
export type AuthorityMigrationStageContext = {
  owner: string;
};

/**
 * Provider-owned candidate returned by a migration stage operation.
 * Staging must leave the candidate unreachable from the authority head until
 * publishMigrationStage is called after all coordinator verification completes.
 */
export type AuthorityMigrationStage = {
  token: unknown;
  state?: AuthorityExport;
};

export interface AuthorityMigrationTarget {
  stageMigration(
    state: AuthorityExport,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityMigrationStage>;
  readMigrationStage(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityExport>;
  publishMigrationStage(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityRestoreResult | void>;
  invalidateMigrationStage(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<void>;
}

export type AuthorityLifecycleDiagnostic = {
  code: "MAINTENANCE_FENCE_RELEASE_FAILED";
  severity: "warning";
  operation: "migration" | "restore";
  phase: "cleanup";
  retryable: false;
  message: string;
};

export type MaintenanceFenceContext = {
  operation: "migration" | "restore";
  role: "source" | "destination";
  authorityId: string;
  namespace: string;
  owner: string;
};

export type MaintenanceFenceLease = {
  /** Provider-local renewal token; callers should use the lifecycle methods instead. */
  token?: string;
  renew?: (() => Promise<void>) | (() => void);
  release?: (() => Promise<void>) | (() => void);
};

/**
 * Provider-backed maintenance fencing used by migration and restore. Implementations
 * must persist ownership outside the process and reject unowned writes until the
 * lease deadline has elapsed.
 */
export interface MaintenanceFence {
  acquire(context: MaintenanceFenceContext): Promise<MaintenanceFenceLease | void>;
  assertReadOnly?(context: MaintenanceFenceContext): Promise<void> | void;
  assertStopped?(context: MaintenanceFenceContext): Promise<void> | void;
  renew?(
    lease: MaintenanceFenceLease | void,
    context: MaintenanceFenceContext,
  ): Promise<void> | void;
  release?(
    lease: MaintenanceFenceLease | void,
    context: MaintenanceFenceContext,
  ): Promise<void> | void;
}

export type AuthorityHealth = {
  provider: AuthorityProviderKind;
  authorityId: string;
  connectivity: "healthy" | "degraded" | "unavailable";
  writable: boolean;
  activeGeneration: AuthorityGenerationIdentity | null;
  refresh: "current" | "pending" | "failed";
  code?: string;
};

export interface WritableAuthority<TSnapshot = unknown, TCommand = unknown> {
  /** Provider-owned logical namespace for lifecycle restore and migration identity. */
  readonly namespace: string;
  /** Provider-owned logical snapshot schema expected by lifecycle operations. */
  readonly schemaVersion: number;
  readHead(): Promise<AuthorityHead | null>;
  readGeneration(id: AuthorityGenerationId): Promise<AuthorityGeneration<TSnapshot>>;
  commit<TResult = unknown>(
    envelope: SemanticCommandEnvelope<TCommand>,
  ): Promise<AuthorityCommitResult<TResult>>;
  readAuxiliary(request: AuxiliaryRead): Promise<unknown>;
  commitAuxiliary(command: AuxiliaryCommit): Promise<AuxiliaryCommitResult>;
  health(): Promise<AuthorityHealth>;
  maintenanceFence?(): MaintenanceFence;
  exportState(): Promise<AuthorityExport>;
  restoreState(state: AuthorityExport): Promise<AuthorityRestoreResult>;
  /**
   * Optional provider-native migration candidate lifecycle. Implementations
   * must not make a staged candidate reachable from readHead until publish.
   */
  stageMigration?(
    state: AuthorityExport,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityMigrationStage>;
  readMigrationStage?(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityExport>;
  publishMigrationStage?(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityRestoreResult | void>;
  invalidateMigrationStage?(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<void>;
  close(): Promise<void>;
}
