import { version as packageJsonVersion } from "../../package.json";
import type { CapletConfig, CapletsConfig } from "../config";
import { resolveExposure } from "../exposure/policy";
import {
  buildProductTelemetryEvent,
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
import { readTelemetryIdentity, type TelemetrySurface, type TelemetryVisibility } from "./state";

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
    },
  });
  if (state.status === "debug") {
    context.debugSink?.capture("debug", event);
    return;
  }
  await context.dispatcher.capture(state, event);
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
    operation === "call_tool"
  ) {
    return "tools";
  }
  if (
    operation === "resources" ||
    operation === "resource_templates" ||
    operation === "read_resource" ||
    operation === "list_resources" ||
    operation === "list_resource_templates"
  ) {
    return "resources";
  }
  if (operation === "prompts" || operation === "get_prompt" || operation === "list_prompts") {
    return "prompts";
  }
  if (operation === "complete") return "complete";
  if (operation === "code_mode") return "code_mode";
  return "unknown";
}

export function outcomeFromResult(result: unknown): Outcome {
  if (isRecord(result) && result.isError === true) return "failure";
  if (isRecord(result) && result.ok === false) {
    const code = isRecord(result.error) ? result.error.code : undefined;
    if (code === "TIMEOUT") return "timeout";
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
  return {
    command_family: "code_mode",
    outcome: outcomeFromResult(record),
    duration_bucket: durationBucket(durationMs),
    timeout_bucket: timeoutBucket(timeoutMs),
    session_category:
      sessionStatus === "created" || sessionStatus === "reused" ? sessionStatus : "unknown",
    any_caplet_invoked: false,
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
