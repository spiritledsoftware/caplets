import { CapletsError } from "../errors";

export type CloudAuthErrorCode =
  | "cloud_auth_required"
  | "cloud_auth_expired"
  | "cloud_auth_revoked"
  | "workspace_selection_required"
  | "workspace_switch_required"
  | "workspace_forbidden"
  | "endpoint_unavailable";

export type CloudAuthRecovery = {
  code: CloudAuthErrorCode;
  message: string;
  recoveryCommand: string;
  requestId?: string | undefined;
};

const SECRET_PATTERN =
  /(cap_access_[a-z0-9._~+/=-]+|cap_refresh_[a-z0-9._~+/=-]+|one_time_code_[a-z0-9._~+/=-]+|Bearer\s+)[^\s"]*/giu;

export function redactCloudAuthSecrets(value: unknown): unknown {
  if (typeof value === "string") return value.replace(SECRET_PATTERN, "$1[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redactCloudAuthSecrets(item));
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      redacted[key] = /token|secret|code|authorization|credential/i.test(key)
        ? "[REDACTED]"
        : redactCloudAuthSecrets(nested);
    }
    return redacted;
  }
  return value;
}

export function cloudAuthRecovery(code: CloudAuthErrorCode, detail?: string): CloudAuthRecovery {
  const recoveryCommand =
    code === "workspace_switch_required"
      ? "caplets cloud auth switch <workspace>"
      : code === "workspace_selection_required"
        ? "caplets cloud auth login --workspace <workspace>"
        : "caplets cloud auth login";
  return {
    code,
    message: detail ?? defaultMessage(code),
    recoveryCommand,
  };
}

export function cloudAuthError(code: CloudAuthErrorCode, detail?: string): CapletsError {
  const recovery = cloudAuthRecovery(code, detail);
  return new CapletsError("AUTH_REQUIRED", recovery.message, recovery);
}

function defaultMessage(code: CloudAuthErrorCode): string {
  switch (code) {
    case "cloud_auth_expired":
      return "Hosted Caplets Cloud credentials have expired.";
    case "cloud_auth_revoked":
      return "Hosted Caplets Cloud credentials were revoked.";
    case "workspace_selection_required":
      return "Select a hosted Caplets Cloud workspace before attaching this project.";
    case "workspace_switch_required":
      return "The requested workspace differs from the saved Selected Workspace.";
    case "workspace_forbidden":
      return "The saved Cloud Auth credential cannot access the requested workspace.";
    case "endpoint_unavailable":
      return "Hosted Caplets Cloud is unavailable.";
    case "cloud_auth_required":
    default:
      return "Run caplets cloud auth login before using hosted Project Binding.";
  }
}
