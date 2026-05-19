import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import {
  createNativeCapletsService,
  registerNativeCapletsProcessCleanup,
  type NativeCapletsServiceOptions,
} from "@caplets/core/native";
import { createCapletsOpenCodeHooks } from "./hooks";

export type CapletsOpenCodeConfig = {
  mode?: "auto" | "local" | "remote";
  remote?: {
    url?: string;
    user?: string;
    password?: string;
    pollIntervalMs?: number;
    fetch?: typeof fetch;
  };
};

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
    ...(config.remote ? { remote: config.remote } : {}),
  };
}

export default plugin;
