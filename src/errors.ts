export const CAPLETS_ERROR_CODES = [
  "CONFIG_NOT_FOUND",
  "CONFIG_INVALID",
  "REQUEST_INVALID",
  "SERVER_NOT_FOUND",
  "SERVER_UNAVAILABLE",
  "SERVER_START_TIMEOUT",
  "UNKNOWN_OPERATION",
  "TOOL_NOT_FOUND",
  "TOOL_CALL_TIMEOUT",
  "AUTH_REQUIRED",
  "AUTH_FAILED",
  "AUTH_REFRESH_FAILED",
  "DOWNSTREAM_PROTOCOL_ERROR",
  "DOWNSTREAM_TOOL_ERROR",
  "UNSUPPORTED_TRANSPORT",
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

const SECRET_KEY_PATTERN =
  /(token|secret|authorization|auth|api[-_]?key|password|credential|clientsecret|client_secret|code|refresh)/i;

const SECRET_VALUE_PATTERN =
  /(bearer\s+)[a-z0-9._~+/=-]+|([?&](?:access_token|refresh_token|token|code)=)[^&\s]+/gi;

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(SECRET_VALUE_PATTERN, "$1$2[REDACTED]");
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      redacted[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSecrets(nested);
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
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(toSafeError(error, fallback), null, 2),
      },
    ],
    structuredContent: {
      error: toSafeError(error, fallback),
    },
  };
}
