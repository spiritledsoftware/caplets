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
  return stripped;
}
