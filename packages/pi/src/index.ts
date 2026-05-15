import {
  createNativeCapletsService,
  registerNativeCapletsProcessCleanup,
  type NativeCapletsService,
} from "@caplets/core/native";
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
    registerNativeCapletsProcessCleanup(service);
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
        const serialized = serializeResult(result);
        return {
          content: [{ type: "text", text: serialized.text }],
          details: serialized.serializationError
            ? { result, serializationError: serialized.serializationError }
            : { result },
        };
      },
    });
  }
}

function serializeResult(result: unknown): { text: string; serializationError?: string } {
  try {
    return { text: JSON.stringify(result, null, 2) ?? "null" };
  } catch (error) {
    const serializationError = error instanceof Error ? error.message : String(error);
    return { text: `[Serialization error: ${serializationError}]`, serializationError };
  }
}
