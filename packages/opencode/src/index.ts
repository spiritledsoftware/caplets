import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  createNativeCapletsService,
  readNativeDefaults,
  registerNativeCapletsProcessCleanup,
  type NativeCapletsServiceOptions,
} from "@caplets/core/native";
import { createCapletsOpenCodeHooks } from "./hooks";

export type CapletsOpenCodeConfig = Pick<NativeCapletsServiceOptions, "mode" | "remote" | "daemon">;

const plugin = (async (_ctx: PluginInput, config?: CapletsOpenCodeConfig) => {
  const service = createNativeCapletsService({
    ...normalizeOpenCodeConfig(config),
    telemetryIntegration: "opencode",
  } as NativeCapletsServiceOptions);
  registerNativeCapletsProcessCleanup(service);
  if (!(await service.reload())) {
    throw new Error("Failed to initialize Caplets native service.");
  }
  return createCapletsOpenCodeHooks(service);
}) as Plugin;

function normalizeOpenCodeConfig(config: CapletsOpenCodeConfig | undefined): CapletsOpenCodeConfig {
  if (config) {
    return {
      ...(config.mode ? { mode: config.mode } : {}),
      ...(config.remote ? { remote: config.remote } : {}),
      ...(config.daemon ? { daemon: config.daemon } : {}),
    };
  }
  const defaults = readNativeDefaults();
  return defaults ? { mode: "daemon", daemon: { url: defaults.daemon.url } } : {};
}

export default plugin;
