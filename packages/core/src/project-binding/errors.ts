import { CapletsError } from "../errors";

export const PROJECT_BINDING_ERROR_CODES = [
  "cloud_auth_required",
  "cloud_auth_expired",
  "cloud_auth_revoked",
  "workspace_selection_required",
  "workspace_switch_required",
  "workspace_forbidden",
  "project_binding_forbidden",
  "endpoint_unavailable",
  "websocket_upgrade_required",
  "sync_required",
  "sync_failed",
  "sync_size_limit_exceeded",
  "lease_conflict",
  "lease_expired",
  "policy_denied",
  "usage_limit_reached",
  "billing_required",
  "subscription_past_due",
  "email_verification_required",
  "remote_credentials_required",
  "remote_auth_failed",
] as const;

export type ProjectBindingErrorCode = (typeof PROJECT_BINDING_ERROR_CODES)[number];

export type ProjectBindingRecovery = {
  code: ProjectBindingErrorCode;
  message: string;
  recoveryCommand?: string | undefined;
  requestId?: string | undefined;
};

export class ProjectBindingError extends CapletsError {
  readonly projectBindingCode: ProjectBindingErrorCode;
  readonly recoveryCommand?: string | undefined;
  readonly requestId?: string | undefined;

  constructor(input: ProjectBindingRecovery) {
    super("SERVER_UNAVAILABLE", input.message, input);
    this.name = "ProjectBindingError";
    this.projectBindingCode = input.code;
    this.recoveryCommand = input.recoveryCommand;
    this.requestId = input.requestId;
  }
}

export function projectBindingRecovery(
  code: ProjectBindingErrorCode,
  message = defaultProjectBindingMessage(code),
): ProjectBindingRecovery {
  return {
    code,
    message,
    recoveryCommand: recoveryCommandFor(code),
  };
}

export function projectBindingError(
  code: ProjectBindingErrorCode,
  message?: string,
): ProjectBindingError {
  return new ProjectBindingError(projectBindingRecovery(code, message));
}

function recoveryCommandFor(code: ProjectBindingErrorCode): string | undefined {
  switch (code) {
    case "cloud_auth_required":
    case "cloud_auth_expired":
    case "cloud_auth_revoked":
    case "workspace_selection_required":
      return "caplets remote login <cloud-url>";
    case "workspace_switch_required":
      return "caplets remote login <cloud-url> --workspace <workspace>";
    case "sync_size_limit_exceeded":
      return "Add exclusions to .capletsignore or upgrade the workspace plan.";
    case "remote_credentials_required":
    case "remote_auth_failed":
      return "caplets remote login <url>";
    case "endpoint_unavailable":
    case "websocket_upgrade_required":
      return "caplets doctor";
    default:
      return undefined;
  }
}

function defaultProjectBindingMessage(code: ProjectBindingErrorCode): string {
  switch (code) {
    case "sync_size_limit_exceeded":
      return "Project sync size exceeds the selected workspace policy.";
    case "workspace_switch_required":
      return "The requested workspace differs from the saved Selected Workspace.";
    case "cloud_auth_required":
      return "Hosted Project Binding requires Remote Login.";
    case "endpoint_unavailable":
    case "websocket_upgrade_required":
      return "Project Binding endpoint is unavailable.";
    default:
      return code.replace(/_/gu, " ");
  }
}
