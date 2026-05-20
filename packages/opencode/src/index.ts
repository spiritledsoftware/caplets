import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  createNativeCapletsService,
  registerNativeCapletsProcessCleanup,
  type NativeCapletsServiceOptions,
} from "@caplets/core/native";
import { createCapletsOpenCodeHooks } from "./hooks";

export type CapletsOpenCodeConfig = Pick<NativeCapletsServiceOptions, "mode" | "server" | "remote">;

const plugin = (async (_ctx: PluginInput, config?: CapletsOpenCodeConfig) => {
  const service = createNativeCapletsService(
    normalizeOpenCodeConfig(config) as NativeCapletsServiceOptions,
  );
  registerNativeCapletsProcessCleanup(service);
  if (!(await service.reload())) {
    throw new Error("Failed to initialize Caplets native service.");
  }
  return createCapletsOpenCodeHooks(service);
}) as Plugin;

function normalizeOpenCodeConfig(config: CapletsOpenCodeConfig | undefined): CapletsOpenCodeConfig {
  if (!config) {
    return {};
  }
  return {
    ...(config.mode ? { mode: config.mode } : {}),
    ...(config.server ? { server: config.server } : {}),
    ...(config.remote ? { remote: config.remote } : {}),
  };
}

export default plugin;
