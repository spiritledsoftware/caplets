import { toCurrentHostSafeError } from "../current-host/operations";
import type { CapletsErrorCode } from "../errors";
import { isSecretKey, redactSecretText } from "../redaction";

export type ProblemStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 412
  | 413
  | 415
  | 422
  | 428
  | 429
  | 500
  | 503
  | 504;

type ProblemClass = {
  type: string;
  title: string;
};

const STATUS_BY_CODE = {
  CONFIG_NOT_FOUND: 404,
  CONFIG_EXISTS: 409,
  CONFIG_INVALID: 422,
  REQUEST_INVALID: 400,
  SERVER_NOT_FOUND: 404,
  SERVER_UNAVAILABLE: 503,
  SERVER_START_TIMEOUT: 504,
  UNKNOWN_OPERATION: 400,
  CAPLET_NAMESPACE_COLLISION: 409,
  TOOL_NOT_FOUND: 404,
  TOOL_CALL_TIMEOUT: 504,
  AUTH_REQUIRED: 401,
  AUTH_FAILED: 401,
  REMOTE_CREDENTIALS_REVOKED: 401,
  AUTH_REFRESH_FAILED: 401,
  DOWNSTREAM_PROTOCOL_ERROR: 503,
  DOWNSTREAM_TOOL_ERROR: 503,
  UNSUPPORTED_OPERATION: 422,
  UNSUPPORTED_CAPABILITY: 422,
  PROMPT_NOT_FOUND: 404,
  DOWNSTREAM_RESOURCE_ERROR: 503,
  DOWNSTREAM_PROMPT_ERROR: 503,
  DOWNSTREAM_COMPLETION_ERROR: 503,
  ATTACH_MANIFEST_STALE: 409,
  ATTACH_EXPORT_NOT_FOUND: 404,
  UNSUPPORTED_TRANSPORT: 415,
  PRECONDITION_REQUIRED: 428,
  PRECONDITION_FAILED: 412,
  CONTENT_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_IN_PROGRESS: 409,
  IDEMPOTENCY_UNKNOWN: 409,
  IDEMPOTENCY_CAPACITY_EXCEEDED: 503,
  UPLOAD_CAPACITY_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
} as const satisfies Record<CapletsErrorCode, ProblemStatus>;

const PROBLEM_CLASS_BY_STATUS: Record<ProblemStatus, ProblemClass> = {
  400: { type: "urn:caplets:problem:request-invalid", title: "Invalid request" },
  401: {
    type: "urn:caplets:problem:authentication-required",
    title: "Authentication required",
  },
  403: { type: "urn:caplets:problem:forbidden", title: "Forbidden" },
  404: { type: "urn:caplets:problem:resource-not-found", title: "Resource not found" },
  409: { type: "urn:caplets:problem:conflict", title: "Conflict" },
  412: { type: "urn:caplets:problem:precondition-failed", title: "Precondition failed" },
  413: { type: "urn:caplets:problem:content-too-large", title: "Content too large" },
  415: {
    type: "urn:caplets:problem:unsupported-media-type",
    title: "Unsupported media type",
  },
  422: {
    type: "urn:caplets:problem:representation-invalid",
    title: "Invalid representation",
  },
  428: {
    type: "urn:caplets:problem:precondition-required",
    title: "Precondition required",
  },
  429: { type: "urn:caplets:problem:too-many-requests", title: "Too many requests" },
  500: { type: "urn:caplets:problem:internal-error", title: "Internal server error" },
  503: { type: "urn:caplets:problem:service-unavailable", title: "Service unavailable" },
  504: { type: "urn:caplets:problem:gateway-timeout", title: "Gateway timeout" },
};

export type ProblemDetails = {
  type: string;
  title: string;
  status: ProblemStatus;
  detail: string;
  code: CapletsErrorCode;
  nextAction?: string;
  links?: Record<string, string>;
};

export type ProblemOptions = {
  status?: ProblemStatus;
  nextAction?: string;
  links?: Readonly<Record<string, string>>;
};

export function problemDetailsFromError(
  error: unknown,
  options: ProblemOptions = {},
): ProblemDetails {
  const safe = toCurrentHostSafeError(error);
  const status = options.status ?? STATUS_BY_CODE[safe.code];
  const problemClass = PROBLEM_CLASS_BY_STATUS[status];
  const nextAction =
    options.nextAction !== undefined && /^[a-z][a-z0-9_-]{0,127}$/u.test(options.nextAction)
      ? options.nextAction
      : undefined;
  const links = validatedLinks(options.links);
  return {
    ...problemClass,
    status,
    detail: safeProblemDetail(safe.code, safe.message),
    code: safe.code,
    ...(nextAction === undefined ? {} : { nextAction }),
    ...(links === undefined ? {} : { links }),
  };
}

function safeProblemDetail(code: CapletsErrorCode, detail: string): string {
  if (code === "INTERNAL_ERROR") return "Current Host administration failed.";
  if (code.startsWith("DOWNSTREAM_")) return "A downstream dependency failed.";
  return detail;
}

export function problemResponse(error: unknown, options: ProblemOptions = {}): Response {
  const problem = problemDetailsFromError(error, options);
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

function validatedLinks(
  value: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 16) return undefined;

  for (const [relation, href] of entries) {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(relation) || !isSafeLink(href)) return undefined;
  }
  return Object.fromEntries(entries);
}

function containsUnsafeLinkCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function isSafeLink(href: unknown): href is string {
  if (
    typeof href !== "string" ||
    href.length === 0 ||
    href.length > 2_048 ||
    containsUnsafeLinkCharacter(href) ||
    redactSecretText(href).redacted
  ) {
    return false;
  }
  if (!href.startsWith("/") && !/^https?:\/\//u.test(href)) return false;

  try {
    const url = new URL(href, "https://admin.invalid");
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    ) {
      return false;
    }
    for (const key of url.searchParams.keys()) {
      if (isSecretKey(key)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
