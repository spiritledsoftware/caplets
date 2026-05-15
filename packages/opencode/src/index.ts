import { tool, type Hooks, type Plugin, type PluginInput } from "@opencode-ai/plugin";
import {
  createNativeCapletsService,
  nativeCapletsSystemGuidance,
  type NativeCapletsService,
} from "@caplets/core/native";
import { capletsOpenCodeArgs } from "./schema.js";

const plugin: Plugin = async (_ctx: PluginInput) => {
  const service = createNativeCapletsService();
  registerProcessCleanup(service);
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

function registerProcessCleanup(service: NativeCapletsService): void {
  let closed = false;
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    void service.close();
  };
  process.once("beforeExit", close);
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
