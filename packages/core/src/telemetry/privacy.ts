import type { TelemetryProperties } from "./events";

const ALLOWED_PROPERTY_KEYS = new Set([
  "$process_person_profile",
  "$geoip_disable",
  "package",
  "version",
  "surface",
  "runtime_mode",
  "execution_context",
  "command_family",
  "operation_family",
  "outcome",
  "duration_bucket",
  "timeout_bucket",
  "integration",
  "exposure_mode",
  "backend_mcp_count",
  "backend_openapi_count",
  "backend_google_discovery_count",
  "backend_graphql_count",
  "backend_http_count",
  "backend_cli_count",
  "backend_caplets_count",
  "direct_count",
  "progressive_count",
  "code_mode_count",
  "session_category",
  "any_caplet_invoked",
  "provider",
  "reason",
  "count_bucket",
  "error_code",
  "diagnostic_category",
  "attribution_source",
  "attribution_intent",
  "first_activation",
  "os_family",
  "arch",
  "node_major",
]);

const SAFE_STRING = /^[a-zA-Z0-9@._:-]{1,80}$/u;
const SAFE_PACKAGE = /^@?[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)?$/u;
const SUSPICIOUS_VALUE = [
  /^\/|^[A-Za-z]:\\/u,
  /^https?:\/\//iu,
  /[a-z0-9-]+\.[a-z]{2,}/iu,
  /(?:^|[_.-])token(?:$|[_.=-])/iu,
  /(?:^|[_.-])secret(?:$|[_.=-])/iu,
  /(?:^|[_.-])key(?:$|[_.=-])/iu,
  /^sk-[a-z0-9]/iu,
  /^gh[pousr]_[a-z0-9]/iu,
  /^[A-Z_]{3,}=.+/u,
];
const COMMAND_FAMILIES = new Set([
  "init",
  "setup",
  "add",
  "install",
  "auth",
  "remote",
  "doctor",
  "serve",
  "attach",
  "daemon",
  "inspect",
  "check",
  "tools",
  "resources",
  "prompts",
  "complete",
  "code_mode",
  "native",
  "telemetry",
  "unknown",
]);
const STRING_VALUE_ALLOWLISTS: Record<string, ReadonlySet<string>> = {
  surface: new Set(["cli", "serve", "attach", "daemon", "native", "code_mode"]),
  runtime_mode: new Set(["local", "remote", "cloud", "unknown"]),
  execution_context: new Set(["interactive", "noninteractive", "ci"]),
  command_family: COMMAND_FAMILIES,
  operation_family: COMMAND_FAMILIES,
  outcome: new Set(["success", "failure", "cancelled", "timeout", "suppressed"]),
  duration_bucket: new Set(["lt_100ms", "lt_1s", "lt_5s", "lt_30s", "gte_30s"]),
  timeout_bucket: new Set(["none", "lt_1s", "lt_10s", "lt_60s", "gte_60s"]),
  integration: new Set(["opencode", "pi", "native", "unknown"]),
  exposure_mode: new Set(["direct", "progressive", "code_mode", "mixed", "unknown"]),
  session_category: new Set(["created", "reused", "none", "unknown"]),
  provider: new Set(["posthog", "sentry"]),
  reason: new Set(["not_configured", "send_failed"]),
  diagnostic_category: new Set([
    "config",
    "auth",
    "network",
    "runtime",
    "validation",
    "code_mode",
    "provider",
    "unknown",
  ]),
  attribution_source: new Set(["landing", "docs", "catalog", "unknown"]),
  attribution_intent: new Set(["install_run", "unknown"]),
};

export type SanitizedStackFrame = {
  filename: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
};

export type SanitizedRuntimeException = {
  values: [
    {
      type: string;
      stacktrace: { frames: SanitizedStackFrame[] };
    },
  ];
};

export function assertTelemetrySafeProperties(
  properties: TelemetryProperties & Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(properties)) {
    if (!ALLOWED_PROPERTY_KEYS.has(key)) {
      throw new Error(`unknown telemetry property: ${key}`);
    }
    if (typeof value === "string") {
      const valueAllowlist = STRING_VALUE_ALLOWLISTS[key];
      if (valueAllowlist && !valueAllowlist.has(value)) {
        throw new Error(`unsafe telemetry property ${key}`);
      }
      if (key === "error_code" && !/^[A-Z_]{2,80}$/u.test(value)) {
        throw new Error(`unsafe telemetry property ${key}`);
      }
      const safeShape = key === "package" ? SAFE_PACKAGE.test(value) : SAFE_STRING.test(value);
      if (
        !safeShape ||
        (key !== "package" &&
          key !== "version" &&
          SUSPICIOUS_VALUE.some((pattern) => pattern.test(value)))
      ) {
        throw new Error(`unsafe telemetry property ${key}`);
      }
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
        throw new Error(`unsafe telemetry property ${key}`);
      }
      continue;
    }
    if (typeof value === "boolean") {
      continue;
    }
    throw new Error(`unsafe telemetry property ${key}`);
  }
}

export function stripSentryEvent(event: Record<string, unknown>): Record<string, unknown> {
  const stripped: Record<string, unknown> = {};
  if (event.tags && typeof event.tags === "object" && !Array.isArray(event.tags)) {
    stripped.tags = event.tags;
  }
  if (Array.isArray(event.fingerprint)) {
    stripped.fingerprint = event.fingerprint;
  }
  if (event.level) {
    stripped.level = event.level;
  }
  const exception = sanitizeSentryException(event.exception);
  if (exception) {
    stripped.exception = exception;
  }
  return stripped;
}

export function sanitizeRuntimeException(error: unknown): SanitizedRuntimeException | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as { name?: unknown; stack?: unknown };
  if (typeof record.stack !== "string") return undefined;
  const frames = sanitizeStack(record.stack);
  if (frames.length === 0) return undefined;
  const type =
    typeof record.name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(record.name)
      ? record.name
      : "Error";
  return { values: [{ type, stacktrace: { frames } }] };
}

function sanitizeStack(stack: string): SanitizedStackFrame[] {
  const frames: SanitizedStackFrame[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const frame = sanitizeStackLine(line);
    if (frame) frames.push(frame);
    if (frames.length >= 20) break;
  }
  return frames.reverse();
}

function sanitizeStackLine(line: string): SanitizedStackFrame | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("at ")) return undefined;
  const withoutAt = trimmed.slice(3);
  const match = /^(?:(?<fn>.*?) \()?(?<file>.*?)(?::(?<line>\d+))?(?::(?<col>\d+))?\)?$/u.exec(
    withoutAt,
  );
  const rawFilename = match?.groups?.file;
  if (!rawFilename) return undefined;
  const filename = sanitizeFilename(rawFilename);
  if (!filename) return undefined;
  const rawFunction = match.groups?.fn;
  const functionName = rawFunction ? sanitizeFunctionName(rawFunction) : undefined;
  const lineno = safePositiveInt(match.groups?.line);
  const colno = safePositiveInt(match.groups?.col);
  return {
    filename,
    ...(functionName ? { function: functionName } : {}),
    ...(lineno ? { lineno } : {}),
    ...(colno ? { colno } : {}),
    in_app: filename.startsWith("packages/") || filename.startsWith("apps/"),
  };
}

function sanitizeFilename(raw: string): string | undefined {
  const normalized = raw.replaceAll("\\", "/").replace(/^file:\/\//u, "");
  if (SUSPICIOUS_VALUE.some((pattern) => pattern.test(normalized))) {
    const relative = relativeSafePath(normalized);
    return relative;
  }
  return relativeSafePath(normalized);
}

function relativeSafePath(value: string): string | undefined {
  const nodeModules = value.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)(?:\/(.+))?$/u);
  if (nodeModules) {
    return ["node_modules", nodeModules[1], nodeModules[2]].filter(Boolean).join("/");
  }
  const workspace = value.match(/(?:^|\/)((?:packages|apps)\/[A-Za-z0-9._/-]+)$/u);
  if (workspace) return workspace[1];
  if (value.startsWith("node:")) return value;
  const basename = value.split("/").filter(Boolean).at(-1);
  if (!basename || !/^[A-Za-z0-9@._:-]{1,120}$/u.test(basename)) return undefined;
  if (SUSPICIOUS_VALUE.some((pattern) => pattern.test(basename))) return undefined;
  return basename;
}

function sanitizeFunctionName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || SUSPICIOUS_VALUE.some((pattern) => pattern.test(trimmed))) return undefined;
  if (!/^[A-Za-z0-9_$.[\]<>:/ -]{1,120}$/u.test(trimmed)) return undefined;
  return trimmed;
}

function safePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function sanitizeSentryException(value: unknown): SanitizedRuntimeException | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const values = (value as { values?: unknown }).values;
  if (!Array.isArray(values)) return undefined;
  for (const entry of values) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as { type?: unknown; stacktrace?: unknown };
    const type =
      typeof record.type === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(record.type)
        ? record.type
        : "Error";
    const stacktrace = record.stacktrace;
    if (!stacktrace || typeof stacktrace !== "object" || Array.isArray(stacktrace)) continue;
    const frames = (stacktrace as { frames?: unknown }).frames;
    if (!Array.isArray(frames)) continue;
    const sanitizedFrames = frames.flatMap(sanitizeSentryFrame).slice(-20);
    if (sanitizedFrames.length > 0) {
      return { values: [{ type, stacktrace: { frames: sanitizedFrames } }] };
    }
  }
  return undefined;
}

function sanitizeSentryFrame(value: unknown): SanitizedStackFrame[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const filename =
    typeof record.filename === "string" ? sanitizeFilename(record.filename) : undefined;
  if (!filename) return [];
  const functionName =
    typeof record.function === "string" ? sanitizeFunctionName(record.function) : undefined;
  const lineno = typeof record.lineno === "number" ? safeFrameNumber(record.lineno) : undefined;
  const colno = typeof record.colno === "number" ? safeFrameNumber(record.colno) : undefined;
  return [
    {
      filename,
      ...(functionName ? { function: functionName } : {}),
      ...(lineno ? { lineno } : {}),
      ...(colno ? { colno } : {}),
      ...(typeof record.in_app === "boolean" ? { in_app: record.in_app } : {}),
    },
  ];
}

function safeFrameNumber(value: number): number | undefined {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
