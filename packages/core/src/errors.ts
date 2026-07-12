import { isSecretKey, redactSecretText } from "./redaction";

export const CAPLETS_ERROR_CODES = [
  "CONFIG_NOT_FOUND",
  "CONFIG_EXISTS",
  "CONFIG_INVALID",
  "REQUEST_INVALID",
  "SERVER_NOT_FOUND",
  "SERVER_UNAVAILABLE",
  "SERVER_START_TIMEOUT",
  "UNKNOWN_OPERATION",
  "CAPLET_NAMESPACE_COLLISION",
  "TOOL_NOT_FOUND",
  "TOOL_CALL_TIMEOUT",
  "AUTH_REQUIRED",
  "AUTH_FAILED",
  "REMOTE_CREDENTIALS_REVOKED",
  "AUTH_REFRESH_FAILED",
  "DOWNSTREAM_PROTOCOL_ERROR",
  "DOWNSTREAM_TOOL_ERROR",
  "UNSUPPORTED_OPERATION",
  "UNSUPPORTED_CAPABILITY",
  "PROMPT_NOT_FOUND",
  "DOWNSTREAM_RESOURCE_ERROR",
  "DOWNSTREAM_PROMPT_ERROR",
  "DOWNSTREAM_COMPLETION_ERROR",
  "ATTACH_MANIFEST_STALE",
  "ATTACH_EXPORT_NOT_FOUND",
  "UNSUPPORTED_TRANSPORT",
  "ASYNC_AUTHORITY_REQUIRED",
  "INTERNAL_ERROR",
] as const;

export type CapletsErrorCode = (typeof CAPLETS_ERROR_CODES)[number];

export type SafeErrorSummary = {
  code: CapletsErrorCode;
  message: string;
  details?: unknown;
};

export class CapletsError extends Error {
  readonly code: CapletsErrorCode;
  readonly details?: unknown;

  constructor(code: CapletsErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "CapletsError";
    this.code = code;
    this.details = details;
  }
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecretText(value).text;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      redacted[key] = isSecretKey(key) ? "[REDACTED]" : redactSecrets(nested);
    }
    return redacted;
  }

  return value;
}

export function toSafeError(
  error: unknown,
  fallback: CapletsErrorCode = "INTERNAL_ERROR",
): SafeErrorSummary {
  if (error instanceof CapletsError) {
    return {
      code: error.code,
      message: String(redactSecrets(error.message)),
      ...(error.details === undefined ? {} : { details: redactSecrets(error.details) }),
    };
  }

  if (error instanceof Error) {
    return {
      code: fallback,
      message: String(redactSecrets(error.message)),
    };
  }

  return {
    code: fallback,
    message: String(redactSecrets(error)),
  };
}

export function errorResult(error: unknown, fallback?: CapletsErrorCode) {
  const safe = toSafeError(error, fallback);
  const structuredContent = { error: safe };
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: [
          "# Error",
          "",
          `## ${safe.code}`,
          "",
          safe.message,
          "",
          "## Details",
          "",
          "```json",
          JSON.stringify(safe, null, 2),
          "```",
        ].join("\n"),
      },
    ],
    structuredContent,
  };
}
