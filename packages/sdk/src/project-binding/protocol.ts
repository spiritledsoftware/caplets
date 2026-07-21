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

export type ProjectBindingSyncState = "not_started" | "pending" | "syncing" | "idle" | "failed";

export type BindingTerminalReasonCode =
  | "project_binding_forbidden"
  | "endpoint_unavailable"
  | "websocket_upgrade_required"
  | "sync_required"
  | "sync_failed"
  | "sync_size_limit_exceeded"
  | "lease_conflict"
  | "lease_expired"
  | "policy_denied"
  | "remote_credentials_required"
  | "remote_credentials_revoked"
  | "remote_auth_failed"
  | "interrupted"
  | "completed";

export type BindingTerminalReason = {
  code: BindingTerminalReasonCode;
  message: string;
  recoveryCommand?: string;
  requestId?: string;
};

export type ProjectBindingSocketClientMessage =
  | {
      type: "heartbeat";
      bindingId: string;
      sessionId: string;
      state: ProjectBindingState;
      syncState: ProjectBindingSyncState;
    }
  | {
      type: "end";
      bindingId: string;
      sessionId: string;
      reason: BindingTerminalReason;
    };

export type ProjectBindingSocketServerMessage =
  | {
      type: "state";
      state: ProjectBindingState;
      syncState: ProjectBindingSyncState;
      requestId?: string;
    }
  | {
      type: "ready";
      bindingId: string;
      sessionId: string;
      syncState: ProjectBindingSyncState;
      requestId?: string;
    }
  | { type: "blocked"; reason: BindingTerminalReason }
  | { type: "ended"; reason: BindingTerminalReason };
