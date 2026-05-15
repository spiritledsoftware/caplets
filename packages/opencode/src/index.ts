import { tool, type Hooks, type Plugin, type PluginInput } from "@opencode-ai/plugin";
import {
  createNativeCapletsService,
  nativeCapletsSystemGuidance,
  registerNativeCapletsProcessCleanup,
  type NativeCapletsService,
} from "@caplets/core/native";
import { capletsOpenCodeArgs } from "./schema.js";

const plugin: Plugin = async (_ctx: PluginInput) => {
  const service = createNativeCapletsService();
  registerNativeCapletsProcessCleanup(service);
  return createCapletsOpenCodeHooks(service);
};

export async function createCapletsOpenCodeHooks(service: NativeCapletsService): Promise<Hooks> {
  const capletTools = service.listTools();
  const toolNames = capletTools.map((caplet) => caplet.toolName);

  return {
    tool: Object.fromEntries(
      capletTools.map((caplet) => [
        caplet.toolName,
        tool({
          description: caplet.description,
          args: capletsOpenCodeArgs(),
          async execute(args) {
            const result = await service.execute(caplet.caplet, args);
            return typeof result === "string" ? result : JSON.stringify(result, null, 2);
          },
        }),
      ]),
    ),
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(nativeCapletsSystemGuidance(toolNames));
    },
  };
}

export default plugin;
