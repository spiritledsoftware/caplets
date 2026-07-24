import { arch, platform } from "node:os";
import { version as packageJsonVersion } from "../../package.json";
import type { CapletConfig, CapletsConfig } from "../config";
import { resolveExposure } from "../exposure/policy";
import {
  buildReliabilityTelemetryEvent,
  buildProductTelemetryEvent,
  type DiagnosticCategory,
  durationBucket,
  timeoutBucket,
  type CommandFamily,
  type Outcome,
  type RuntimeMode,
  type TelemetryProductEventName,
  type TelemetryProperties,
} from "./events";
import { TelemetryDebugSink } from "./debug";
import { createTelemetryDispatcher, type TelemetryDispatcher } from "./providers";
import { resolveTelemetryState } from "./context";
import { runtimeDescriptor } from "./runtime-environment";
import {
  acknowledgeTelemetryAttributionClaim,
  claimTelemetryAttribution,
  releaseTelemetryAttributionClaim,
  type TelemetryAttribution,
  readTelemetryIdentity,
  type TelemetrySurface,
  type TelemetryVisibility,
} from "./state";

export type RuntimeTelemetryOptions = {
  config: CapletsConfig;
  env?: NodeJS.ProcessEnv | undefined;
  stateDir?: string | undefined;
  surface: TelemetrySurface;
  visibility: TelemetryVisibility;
  runtimeMode?: RuntimeMode | undefined;
  integration?: "opencode" | "pi" | "native" | "unknown" | undefined;
  debugSink?: TelemetryDebugSink | undefined;
  dispatcher?: TelemetryDispatcher | undefined;
};

export type RuntimeTelemetryContext = RuntimeTelemetryOptions & {
  dispatcher: TelemetryDispatcher;
};

export function createRuntimeTelemetryContext(
  options: RuntimeTelemetryOptions,
): RuntimeTelemetryContext {
  return {
    ...options,
    dispatcher: options.dispatcher ?? createTelemetryDispatcher({ stateDir: options.stateDir }),
  };
}

export async function captureRuntimeTelemetryEvent(
  context: RuntimeTelemetryContext,
  name: TelemetryProductEventName,
  properties: TelemetryProperties,
): Promise<void> {
  const state = resolveTelemetryState({
    config: context.config,
    env: context.env,
    stateDir: context.stateDir,
    surface: context.surface,
    visibility: context.visibility,
    debug: context.debugSink !== undefined,
  });
  if (state.status !== "enabled" && state.status !== "debug") {
    return;
  }
  const identity =
    state.identity ?? readTelemetryIdentity({ stateDir: context.stateDir, create: false });
  const attributionClaim =
    state.status === "enabled" && properties.outcome === "success"
      ? claimTelemetryAttribution({ stateDir: context.stateDir, env: context.env })
      : undefined;
  try {
    const event = buildProductTelemetryEvent({
      name,
      distinctId: identity.id,
      properties: {
        package: "@caplets/core",
        version: packageJsonVersion,
        surface: context.surface,
        runtime_mode: context.runtimeMode ?? "unknown",
        execution_context: state.executionContext,
        ...(context.integration ? { integration: context.integration } : {}),
        ...properties,
        ...attributionTelemetryProperties(attributionClaim?.attribution),
      },
    });
    if (state.status === "debug") {
      context.debugSink?.capture("debug", event);
      return;
    }
    await context.dispatcher.capture(state, event);
    if (attributionClaim) {
      acknowledgeTelemetryAttributionClaim({
        stateDir: context.stateDir,
        env: context.env,
        claim: attributionClaim,
      });
    }
  } catch (error) {
    if (attributionClaim) releaseTelemetryAttributionClaim(attributionClaim);
    throw error;
  }
}

export async function captureRuntimeReliabilityEvent(
  context: RuntimeTelemetryContext,
  properties: TelemetryProperties,
  error?: unknown,
): Promise<void> {
  const state = resolveTelemetryState({
    config: context.config,
    env: context.env,
    stateDir: context.stateDir,
    surface: context.surface,
    visibility: context.visibility,
    debug: context.debugSink !== undefined,
  });
  if (state.status !== "enabled" && state.status !== "debug") {
    return;
  }
  const runtime = runtimeDescriptor();
  const event = buildReliabilityTelemetryEvent({
    name: "caplets_reliability_error",
    properties: {
      package: "@caplets/core",
      version: packageJsonVersion,
      surface: context.surface,
      runtime_mode: context.runtimeMode ?? "unknown",
      execution_context: state.executionContext,
      ...(context.integration ? { integration: context.integration } : {}),
      os_family: platform(),
      arch: architectureForTelemetry(),
      runtime_name: runtime.name,
      runtime_major: runtime.major,
      ...properties,
    },
    error,
  });
  if (state.status === "debug") {
    context.debugSink?.capture("debug", event);
    return;
  }
  await context.dispatcher.capture(state, event);
}

const TELEMETRY_ARCHITECTURES = new Set([
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc",
  "ppc64",
  "riscv64",
  "s390",
  "s390x",
  "x64",
  "x32",
]);

function architectureForTelemetry(): NonNullable<TelemetryProperties["arch"]> {
  const value = arch();
  return TELEMETRY_ARCHITECTURES.has(value)
    ? (value as NonNullable<TelemetryProperties["arch"]>)
    : "unknown";
}

export function attributionTelemetryProperties(
  attribution: TelemetryAttribution | undefined,
): TelemetryProperties {
  if (!attribution) return {};
  return {
    attribution_source: attribution.source,
    attribution_intent: attribution.intent,
    first_activation: true,
  };
}

export function backendFamilyCounts(config: CapletsConfig): TelemetryProperties {
  return {
    backend_mcp_count: enabledCount(config.mcpServers),
    backend_openapi_count: enabledCount(config.openapiEndpoints),
    backend_google_discovery_count: enabledCount(config.googleDiscoveryApis),
    backend_graphql_count: enabledCount(config.graphqlEndpoints),
    backend_http_count: enabledCount(config.httpApis),
    backend_cli_count: enabledCount(config.cliTools),
    backend_caplets_count: enabledCount(config.capletSets),
  };
}

export function exposureModeCounts(config: CapletsConfig): TelemetryProperties {
  let direct = 0;
  let progressive = 0;
  let codeMode = 0;
  for (const caplet of allCaplets(config)) {
    if (caplet.disabled || caplet.setup || caplet.projectBinding?.required) continue;
    const exposure = resolveExposure(caplet.exposure, config.options.exposure);
    if (exposure.direct) direct += 1;
    if (exposure.progressive) progressive += 1;
    if (exposure.codeMode) codeMode += 1;
  }
  return {
    direct_count: direct,
    progressive_count: progressive,
    code_mode_count: codeMode,
  };
}

export function operationFamilyFromOperation(operation: unknown): CommandFamily {
  if (operation === "inspect") return "inspect";
  if (operation === "check") return "check";
  if (
    operation === "tools" ||
    operation === "search_tools" ||
    operation === "get_tool" ||
    operation === "describe_tool" ||
    operation === "call_tool"
  ) {
    return "tools";
  }
  if (
    operation === "resources" ||
    operation === "resource_templates" ||
    operation === "read_resource" ||
    operation === "search_resources" ||
    operation === "list_resources" ||
    operation === "list_resource_templates" ||
    operation === "search_resource_templates"
  ) {
    return "resources";
  }
  if (
    operation === "prompts" ||
    operation === "get_prompt" ||
    operation === "list_prompts" ||
    operation === "search_prompts"
  ) {
    return "prompts";
  }
  if (operation === "complete") return "complete";
  if (operation === "code_mode") return "code_mode";
  return "unknown";
}

export function outcomeFromResult(result: unknown): Outcome {
  if (isRecord(result) && result.isError === true) {
    const code = errorCodeFromResult(result);
    if (code.toLowerCase().includes("timeout")) return "timeout";
    return "failure";
  }
  if (isRecord(result) && result.ok === false) {
    const code = errorCodeFromResult(result);
    if (typeof code === "string" && code.toLowerCase().includes("timeout")) return "timeout";
    return "failure";
  }
  return "success";
}

export function codeModeTelemetryProperties(
  envelope: unknown,
  durationMs: number,
  timeoutMs: number | undefined,
): TelemetryProperties {
  const record = isRecord(envelope) ? envelope : {};
  const meta = isRecord(record.meta) ? record.meta : {};
  const sessionStatus = meta.sessionStatus;
  const effectiveTimeoutMs =
    timeoutMs ?? (typeof meta.timeoutMs === "number" ? meta.timeoutMs : undefined);
  return {
    command_family: "code_mode",
    outcome: outcomeFromResult(record),
    duration_bucket: durationBucket(durationMs),
    timeout_bucket: timeoutBucket(effectiveTimeoutMs),
    session_category:
      sessionStatus === "created" || sessionStatus === "reused"
        ? sessionStatus
        : sessionStatus === null
          ? "none"
          : "unknown",
    any_caplet_invoked: codeModeEnvelopeInvokedCaplet(record),
  };
}

export function toolActivationProperties(input: {
  config: CapletsConfig;
  caplet: CapletConfig | undefined;
  operation: unknown;
  exposureMode: "direct" | "progressive" | "code_mode" | "mixed" | "unknown";
  result: unknown;
  durationMs: number;
}): TelemetryProperties {
  return {
    operation_family: operationFamilyFromOperation(input.operation),
    exposure_mode: input.exposureMode,
    outcome: outcomeFromResult(input.result),
    duration_bucket: durationBucket(input.durationMs),
    ...backendFamilyCounts(input.config),
    ...exposureModeCounts(input.config),
  };
}

function enabledCount(record: Record<string, CapletConfig>): number {
  return Object.values(record).filter((caplet) => !caplet.disabled).length;
}

function allCaplets(config: CapletsConfig): CapletConfig[] {
  return [
    ...Object.values(config.mcpServers),
    ...Object.values(config.openapiEndpoints),
    ...Object.values(config.googleDiscoveryApis),
    ...Object.values(config.graphqlEndpoints),
    ...Object.values(config.httpApis),
    ...Object.values(config.cliTools),
    ...Object.values(config.capletSets),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function runtimeFailureTelemetryProperties(input: {
  operation: unknown;
  exposureMode: "direct" | "progressive" | "code_mode" | "mixed" | "unknown";
  result: unknown;
}): TelemetryProperties {
  const errorCode = errorCodeFromResult(input.result);
  return {
    operation_family: operationFamilyFromOperation(input.operation),
    exposure_mode: input.exposureMode,
    error_code: errorCode,
    diagnostic_category: diagnosticCategoryFromCode(errorCode),
  };
}

function errorCodeFromResult(result: unknown): string {
  if (!isRecord(result)) return "UNKNOWN";
  const error = isRecord(result.error)
    ? result.error
    : isRecord(result.structuredContent) && isRecord(result.structuredContent.error)
      ? result.structuredContent.error
      : undefined;
  if (isRecord(error) && typeof error.code === "string") return error.code;
  return "UNKNOWN";
}

function diagnosticCategoryFromCode(code: string): DiagnosticCategory {
  if (code.startsWith("CONFIG")) return "config";
  if (code.startsWith("AUTH")) return "auth";
  if (code.includes("NETWORK") || code.includes("UNAVAILABLE")) return "network";
  if (code.includes("VALID") || code.includes("REQUEST")) return "validation";
  if (code.includes("CODE_MODE") || code.includes("SANDBOX")) return "code_mode";
  return "runtime";
}

function codeModeEnvelopeInvokedCaplet(record: Record<string, unknown>): boolean {
  const meta = isRecord(record.meta) ? record.meta : undefined;
  return (
    hasBooleanTrue(meta, "anyCapletInvoked") ||
    hasBooleanTrue(meta, "capletInvoked") ||
    hasPositiveNumber(meta, "capletInvocationCount") ||
    hasPositiveNumber(meta, "toolCallCount")
  );
}

function hasBooleanTrue(record: Record<string, unknown> | undefined, key: string): boolean {
  return record?.[key] === true;
}

function hasPositiveNumber(record: Record<string, unknown> | undefined, key: string): boolean {
  const value = record?.[key];
  return typeof value === "number" && value > 0;
}
