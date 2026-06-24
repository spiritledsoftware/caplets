import type { TelemetryExecutionContext, TelemetrySurface } from "./state";
import { assertTelemetrySafeProperties } from "./privacy";

export type RuntimeMode = "local" | "remote" | "cloud" | "unknown";
export type CommandFamily =
  | "init"
  | "setup"
  | "add"
  | "install"
  | "auth"
  | "remote"
  | "doctor"
  | "serve"
  | "attach"
  | "daemon"
  | "inspect"
  | "check"
  | "tools"
  | "resources"
  | "prompts"
  | "complete"
  | "code_mode"
  | "native"
  | "telemetry"
  | "unknown";
export type Outcome = "success" | "failure" | "cancelled" | "timeout" | "suppressed";
export type DurationBucket = "lt_100ms" | "lt_1s" | "lt_5s" | "lt_30s" | "gte_30s";
export type TimeoutBucket = "none" | "lt_1s" | "lt_10s" | "lt_60s" | "gte_60s";
export type DiagnosticCategory =
  | "config"
  | "auth"
  | "network"
  | "runtime"
  | "validation"
  | "code_mode"
  | "provider"
  | "unknown";

export type TelemetryProductEventName =
  | "caplets_cli_command"
  | "caplets_setup_milestone"
  | "caplets_runtime_lifecycle"
  | "caplets_tool_activation"
  | "caplets_code_mode_outcome"
  | "caplets_delivery_health";

export type TelemetryReliabilityEventName = "caplets_reliability_error";

export type TelemetryPropertyValue = string | number | boolean;

export type TelemetryProperties = Partial<{
  package: string;
  version: string;
  surface: TelemetrySurface;
  runtime_mode: RuntimeMode;
  execution_context: TelemetryExecutionContext;
  command_family: CommandFamily;
  operation_family: CommandFamily;
  outcome: Outcome;
  duration_bucket: DurationBucket;
  timeout_bucket: TimeoutBucket;
  integration: "opencode" | "pi" | "native" | "unknown";
  exposure_mode: "direct" | "progressive" | "code_mode" | "mixed" | "unknown";
  backend_mcp_count: number;
  backend_openapi_count: number;
  backend_google_discovery_count: number;
  backend_graphql_count: number;
  backend_http_count: number;
  backend_cli_count: number;
  backend_caplets_count: number;
  direct_count: number;
  progressive_count: number;
  code_mode_count: number;
  session_category: "created" | "reused" | "none" | "unknown";
  any_caplet_invoked: boolean;
  provider: "posthog" | "sentry";
  reason: string;
  count_bucket: string;
  error_code: string;
  diagnostic_category: DiagnosticCategory;
  os_family: NodeJS.Platform | "unknown";
  arch: NodeJS.Architecture | "unknown";
  node_major: number;
}>;

export type ProductTelemetryEvent = {
  provider: "posthog";
  name: TelemetryProductEventName;
  distinctId: string;
  properties: TelemetryProperties & { $process_person_profile: false };
};

export type ReliabilityTelemetryEvent = {
  provider: "sentry";
  name: TelemetryReliabilityEventName;
  tags: Record<string, string>;
  fingerprint: string[];
};

export type TelemetryEvent = ProductTelemetryEvent | ReliabilityTelemetryEvent;

const PRODUCT_EVENTS = new Set<TelemetryProductEventName>([
  "caplets_cli_command",
  "caplets_setup_milestone",
  "caplets_runtime_lifecycle",
  "caplets_tool_activation",
  "caplets_code_mode_outcome",
  "caplets_delivery_health",
]);

const RELIABILITY_EVENTS = new Set<TelemetryReliabilityEventName>(["caplets_reliability_error"]);

export function buildProductTelemetryEvent(input: {
  name: TelemetryProductEventName;
  distinctId: string;
  properties: TelemetryProperties;
}): ProductTelemetryEvent {
  if (!PRODUCT_EVENTS.has(input.name)) {
    throw new Error(`unknown telemetry event: ${input.name}`);
  }
  assertTelemetrySafeProperties(input.properties);
  return {
    provider: "posthog",
    name: input.name,
    distinctId: input.distinctId,
    properties: {
      $process_person_profile: false,
      ...input.properties,
    },
  };
}

export function buildReliabilityTelemetryEvent(input: {
  name: TelemetryReliabilityEventName;
  properties: TelemetryProperties;
}): ReliabilityTelemetryEvent {
  if (!RELIABILITY_EVENTS.has(input.name)) {
    throw new Error(`unknown telemetry event: ${input.name}`);
  }
  assertTelemetrySafeProperties(input.properties);
  const tags = tagsFor(input.properties);
  return {
    provider: "sentry",
    name: input.name,
    tags,
    fingerprint: [
      tags.package ?? "unknown",
      tags.surface ?? "unknown",
      tags.command_family ?? "unknown",
      tags.runtime_mode ?? "unknown",
      tags.error_code ?? "unknown",
      tags.diagnostic_category ?? "unknown",
    ],
  };
}

export function durationBucket(ms: number): DurationBucket {
  if (ms < 100) return "lt_100ms";
  if (ms < 1_000) return "lt_1s";
  if (ms < 5_000) return "lt_5s";
  if (ms < 30_000) return "lt_30s";
  return "gte_30s";
}

export function timeoutBucket(ms: number | undefined): TimeoutBucket {
  if (ms === undefined) return "none";
  if (ms < 1_000) return "lt_1s";
  if (ms < 10_000) return "lt_10s";
  if (ms < 60_000) return "lt_60s";
  return "gte_60s";
}

function tagsFor(properties: TelemetryProperties): Record<string, string> {
  return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, String(value)]));
}
