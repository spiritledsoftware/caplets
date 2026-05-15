import { createNativeCapletsService, type NativeCapletsService } from "@caplets/core/native";
import { capletsPiParameters } from "./schema.js";

export type PiExtensionApi = {
  registerTool(definition: unknown): void;
};

export type CapletsPiOptions = {
  service?: NativeCapletsService;
};

export default function capletsPiExtension(pi: PiExtensionApi, options: CapletsPiOptions = {}) {
  const service = options.service ?? createNativeCapletsService();
  if (!options.service) {
    registerProcessCleanup(service);
  }
  for (const caplet of service.listTools()) {
    pi.registerTool({
      name: caplet.toolName,
      label: caplet.title,
      description: caplet.description,
      promptSnippet: `Use ${caplet.toolName} for the ${caplet.title} Caplet capability domain.`,
      promptGuidelines: caplet.promptGuidance,
      parameters: capletsPiParameters(),
      async execute(_toolCallId: string, params: unknown) {
        const result = await service.execute(caplet.caplet, params);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: { result },
        };
      },
    });
  }
}

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
