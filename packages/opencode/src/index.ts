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

  return {
    tool: Object.fromEntries(
      capletTools.map((caplet) => [
        caplet.toolName,
        tool({
          description: caplet.description,
          args: capletsOpenCodeArgs(),
          async execute(args) {
            const result = await service.execute(caplet.caplet, args);
            if (typeof result === "string") return result;
            try {
              return JSON.stringify(result, null, 2) ?? "null";
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return `[Serialization error: ${message}]`;
            }
          },
        }),
      ]),
    ),
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        nativeCapletsSystemGuidance(service.listTools().map((caplet) => caplet.toolName)),
      );
    },
  };
}

export default plugin;
