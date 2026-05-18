import { keyText, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generatedToolInputJsonSchema } from "@caplets/core/generated-tool-input-schema";
import {
  createNativeCapletsService,
  registerNativeCapletsProcessCleanup,
  type NativeCapletTool,
  type NativeCapletsService,
} from "@caplets/core/native";

export type PiExtensionApi = Pick<ExtensionAPI, "registerTool"> &
  Partial<Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "on">>;

type PiToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];

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
  let currentCapletTools = new Set<string>();
  let knownCapletTools = new Set<string>();
  let canSyncActiveTools = false;

  const syncToolRegistrations = (caplets = service.listTools()) => {
    const nextCapletTools = new Set(caplets.map((caplet) => caplet.toolName));
    for (const [toolName] of registeredCapletToolSignatures) {
      if (!nextCapletTools.has(toolName)) {
        registeredCapletToolSignatures.delete(toolName);
      }
    }
    for (const caplet of caplets) {
      const signature = piToolSignature(caplet);
      if (registeredCapletToolSignatures.get(caplet.toolName) === signature) {
        continue;
      }
      registeredCapletToolSignatures.set(caplet.toolName, signature);
      pi.registerTool(createPiTool(service, caplet));
    }

    currentCapletTools = nextCapletTools;
    return nextCapletTools;
  };

  const syncActiveTools = (nextCapletTools = currentCapletTools) => {
    if (!canSyncActiveTools || !pi.getActiveTools || !pi.setActiveTools) {
      return;
    }

    const activeNonCaplets = pi
      .getActiveTools()
      .filter((name) => !knownCapletTools.has(name) && !nextCapletTools.has(name));
    pi.setActiveTools([...activeNonCaplets, ...nextCapletTools]);
    knownCapletTools = nextCapletTools;
  };

  currentCapletTools = syncToolRegistrations();
  const unsubscribe = service.onToolsChanged((caplets) => {
    syncActiveTools(syncToolRegistrations(caplets));
  });
  pi.on?.("session_start", () => {
    canSyncActiveTools = true;
    knownCapletTools = new Set(
      pi.getActiveTools?.().filter((name) => name.startsWith("caplets_")) ?? [],
    );
    syncActiveTools();
  });
  pi.on?.("session_shutdown", () => {
    unsubscribe();
    if (ownsService) {
      void service.close();
    }
  });
}

function piToolSignature(caplet: NativeCapletTool): string {
  return JSON.stringify({
    caplet: caplet.caplet,
    title: caplet.title,
    description: caplet.description,
    promptGuidance: caplet.promptGuidance,
  });
}

function createPiTool(service: NativeCapletsService, caplet: NativeCapletTool): PiToolDefinition {
  return {
    name: caplet.toolName,
    label: caplet.title,
    description: caplet.description,
    promptSnippet: `Use ${caplet.toolName} for the ${caplet.title} Caplet capability domain.`,
    promptGuidelines: caplet.promptGuidance,
    parameters: generatedToolInputJsonSchema() as PiToolDefinition["parameters"],
    async execute(_toolCallId, params) {
      const result = await service.execute(caplet.caplet, params);
      const serialized = serializeResult(result);
      return {
        content: [{ type: "text", text: serialized.text }],
        details: serialized.serializationError
          ? { result, serializationError: serialized.serializationError }
          : { result },
      };
    },
    renderCall(args, theme) {
      const operation = stringProperty(args, "operation");
      const downstreamTool = stringProperty(args, "tool");
      const suffix = [operation, downstreamTool].filter(Boolean).join(" ");
      return textComponent(
        theme.fg("toolTitle", theme.bold(caplet.title)) +
          (suffix ? ` ${theme.fg("muted", suffix)}` : ""),
      );
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return textComponent(theme.fg("warning", `${caplet.title} running...`));
      }

      const output = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      if (expanded) {
        return textComponent(
          theme.fg("success", `✓ ${caplet.title} complete`) +
            theme.fg("dim", ` (${toolExpandKeyText()} to collapse)`) +
            (output ? `\n${theme.fg("toolOutput", output)}` : ""),
        );
      }

      return textComponent(
        theme.fg("success", `✓ ${caplet.title} complete`) +
          theme.fg("dim", ` (${toolExpandKeyText()} to expand)`),
      );
    },
  };
}

function toolExpandKeyText(): string {
  return keyText("app.tools.expand") || "ctrl+o";
}

function textComponent(text: string): { render(width: number): string[]; invalidate(): void } {
  return {
    render(_width) {
      return text.split("\n");
    },
    invalidate() {},
  };
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" && property.length > 0 ? property : undefined;
}

function serializeResult(result: unknown): { text: string; serializationError?: string } {
  try {
    return { text: JSON.stringify(result, null, 2) ?? "null" };
  } catch (error) {
    const serializationError = error instanceof Error ? error.message : String(error);
    return { text: `[Serialization error: ${serializationError}]`, serializationError };
  }
}
