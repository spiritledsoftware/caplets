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
