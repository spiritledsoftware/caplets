import { type Plugin, type PluginInput } from "@opencode-ai/plugin";
import {
  createNativeCapletsService,
  registerNativeCapletsProcessCleanup,
} from "@caplets/core/native";
import { createCapletsOpenCodeHooks } from "./hooks.js";

const plugin: Plugin = async (_ctx: PluginInput) => {
  const service = createNativeCapletsService();
  registerNativeCapletsProcessCleanup(service);
  return createCapletsOpenCodeHooks(service);
};

export default plugin;
