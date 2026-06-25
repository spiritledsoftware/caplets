export type ProjectBindingState =
  | "not_attached"
  | "attaching"
  | "syncing"
  | "ready"
  | "degraded"
  | "blocked"
  | "offline"
  | "cleaning_up"
  | "ended"
  | "expired";

export const PROJECT_BINDING_STATES: readonly ProjectBindingState[] = [
  "not_attached",
  "attaching",
  "syncing",
  "ready",
  "degraded",
  "blocked",
  "offline",
  "cleaning_up",
  "ended",
  "expired",
];

export const PROJECT_BINDING_SYNC_STATES = [
  "not_started",
  "pending",
  "syncing",
  "idle",
  "failed",
] as const;

export type ProjectBindingSyncState = (typeof PROJECT_BINDING_SYNC_STATES)[number];

export const PROJECT_BINDING_HIDDEN_REASONS = [
  "missing_context",
  "binding_unsupported",
  "auth_trust_failed",
  "metadata_unknown",
  "sync_failed",
  "retry_exhausted",
  "quarantined",
  "invalid_cwd",
  "policy_denied",
] as const;

export type ProjectBindingHiddenReason = (typeof PROJECT_BINDING_HIDDEN_REASONS)[number];

export type ProjectBindingRetrySnapshot = {
  attempts: number;
  maxAttempts: number;
  elapsedMs: number;
  maxElapsedMs: number;
  nextRetryAt?: string | undefined;
  lastErrorCode?: string | undefined;
  lastErrorMessage?: string | undefined;
};

export type ProjectBindingManagedSyncSnapshot = {
  state: string;
  diagnosticCode?: string | undefined;
  mutagenBinary?: string | undefined;
  mutagenVersion?: string | undefined;
  lastCommand?:
    | {
        command: string;
        args: string[];
        stdout: string;
        stderr: string;
        exitCode?: number | undefined;
      }
    | undefined;
};

export type ProjectBindingQuarantineRecord = {
  capletId: string;
  reason: ProjectBindingHiddenReason;
  message: string;
  code?: string | undefined;
  upstreamId?: string | undefined;
  recoveryCommand?: string | undefined;
  requestId?: string | undefined;
  recordedAt?: string | undefined;
  retry?: ProjectBindingRetrySnapshot | undefined;
  sync?: ProjectBindingManagedSyncSnapshot | undefined;
};

export type ProjectBindingSessionContext = {
  sessionId: string;
  projectRoot: string;
  projectFingerprint: string;
  projectConfigPath?: string | undefined;
  bindingId?: string | undefined;
  state: ProjectBindingState;
  syncState: ProjectBindingSyncState;
  retry?: ProjectBindingRetrySnapshot | undefined;
  sync?: ProjectBindingManagedSyncSnapshot | undefined;
  quarantineRecords?: ProjectBindingQuarantineRecord[] | undefined;
};

export type BindingTerminalReason = {
  code: import("./errors").ProjectBindingErrorCode | "interrupted" | "completed";
  message: string;
  recoveryCommand?: string | undefined;
  requestId?: string | undefined;
};

export type ProjectBindingLease = {
  bindingId: string;
  projectFingerprint: string;
  state: ProjectBindingState;
  active: boolean;
  updatedAt: string;
  expiresAt?: string;
  diagnosticCode?: string;
};

export type ProjectBindingWorkspaceMetadata = {
  projectFingerprint: string;
  projectRoot: string;
  createdAt: string;
  lastActiveAt: string;
};

export type ProjectBindingSetupReceipt = {
  capletId: string;
  status: "succeeded" | "failed" | "skipped";
  recordedAt?: string;
  contentHash?: string;
};
