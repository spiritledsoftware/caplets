import type { CapletsConfig } from "../config";
import {
  readTelemetryIdentity,
  readTelemetryNotice,
  type TelemetryExecutionContext,
  type TelemetryState,
  type TelemetryStateOptions,
  type TelemetrySurface,
  type TelemetryVisibility,
} from "./state";

export type ResolveTelemetryStateOptions = TelemetryStateOptions & {
  config?: Pick<CapletsConfig, "telemetry"> | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  surface: TelemetrySurface;
  visibility: TelemetryVisibility;
  debug?: boolean | undefined;
  allowWithoutNotice?: boolean | undefined;
  createIdentity?: boolean | undefined;
};

export function resolveTelemetryState(options: ResolveTelemetryStateOptions): TelemetryState {
  const env = options.env ?? process.env;
  const executionContext = classifyExecutionContext(env);
  const notice = readTelemetryNotice(options);
  const base = {
    surface: options.surface,
    visibility: options.visibility,
    executionContext,
    notice,
    stateDir: options.stateDir,
  };

  if (options.debug) {
    return { ...base, status: "debug", decider: "debug" };
  }
  if (env.CAPLETS_DISABLE_TELEMETRY === "1") {
    return { ...base, status: "disabled", decider: "env" };
  }
  if (options.config?.telemetry === false) {
    return { ...base, status: "disabled", decider: "config" };
  }
  if (isTestEnv(env)) {
    return { ...base, status: "disabled", decider: "test" };
  }

  if (
    executionContext !== "ci" &&
    !notice.shown &&
    !options.allowWithoutNotice &&
    options.visibility !== "visible"
  ) {
    return { ...base, status: "suppressed", decider: "notice" };
  }

  return {
    ...base,
    status: "enabled",
    decider: "default",
    identity: readTelemetryIdentity({ ...options, create: options.createIdentity !== false }),
  };
}

export function classifyExecutionContext(
  env: NodeJS.ProcessEnv = process.env,
): TelemetryExecutionContext {
  if (env.CI === "true" || env.GITHUB_ACTIONS === "true" || env.BUILDKITE === "true") {
    return "ci";
  }
  return process.stdout.isTTY || process.stderr.isTTY ? "interactive" : "noninteractive";
}

function isTestEnv(env: NodeJS.ProcessEnv): boolean {
  return (
    env.NODE_ENV === "test" ||
    env.VITEST === "true" ||
    env.VITEST_WORKER_ID !== undefined ||
    env.CAPLETS_TEST === "1"
  );
}
