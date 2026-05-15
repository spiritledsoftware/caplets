import {
  createNativeCapletsService,
  registerNativeCapletsProcessCleanup,
  type NativeCapletTool,
  type NativeCapletsService,
} from "@caplets/core/native";
import { capletsPiParameters } from "./schema.js";

export type PiExtensionApi = {
  registerTool(definition: unknown): void;
  getActiveTools?(): string[];
  setActiveTools?(names: string[]): void;
  on?(event: "session_shutdown", handler: () => void): void;
};

export type CapletsPiOptions = {
  service?: NativeCapletsService;
};

export default function capletsPiExtension(pi: PiExtensionApi, options: CapletsPiOptions = {}) {
  const ownsService = !options.service;
  const service = options.service ?? createNativeCapletsService();
  if (ownsService) {
    registerNativeCapletsProcessCleanup(service);
  }

  const registeredCapletToolSignatures = new Map<string, string>();
  let knownCapletTools = new Set<string>();

  const syncTools = (caplets = service.listTools()) => {
    const nextCapletTools = new Set(caplets.map((caplet) => caplet.toolName));
    for (const caplet of caplets) {
      const signature = piToolSignature(caplet);
      if (registeredCapletToolSignatures.get(caplet.toolName) === signature) {
        continue;
      }
      registeredCapletToolSignatures.set(caplet.toolName, signature);
      pi.registerTool(createPiTool(service, caplet));
    }

    if (pi.getActiveTools && pi.setActiveTools) {
      const activeNonCaplets = pi
        .getActiveTools()
        .filter((name) => !knownCapletTools.has(name) && !nextCapletTools.has(name));
      pi.setActiveTools([...activeNonCaplets, ...nextCapletTools]);
    }

    knownCapletTools = nextCapletTools;
  };

  syncTools();
  const unsubscribe = service.onToolsChanged(syncTools);
  pi.on?.("session_shutdown", () => {
    unsubscribe();
    if (ownsService) {
      void service.close();
    }
  });
}

function piToolSignature(caplet: NativeCapletTool): string {
  return JSON.stringify({
    title: caplet.title,
    description: caplet.description,
    promptGuidance: caplet.promptGuidance,
  });
}

function createPiTool(service: NativeCapletsService, caplet: NativeCapletTool): unknown {
  return {
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
  };
}

function serializeResult(result: unknown): { text: string; serializationError?: string } {
  try {
    return { text: JSON.stringify(result, null, 2) ?? "null" };
  } catch (error) {
    const serializationError = error instanceof Error ? error.message : String(error);
    return { text: `[Serialization error: ${serializationError}]`, serializationError };
  }
}
