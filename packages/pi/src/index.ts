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

      const metadata = capletsMetadata(result.details) ?? { name: caplet.title, artifacts: [] };
      const header = capletsResultHeader(metadata);
      if (expanded) {
        const artifactLines = metadata.artifacts.map(
          (artifact) =>
            `Artifact: ${artifact.kind} ${artifact.displayPath} (${artifact.pathResolution})`,
        );
        const preview = resultPreview(result.details, result.content);
        return textComponent(
          [
            theme.fg("success", `✓ ${header} complete`) +
              theme.fg("dim", ` (${toolExpandKeyText()} to collapse)`),
            ...artifactLines.map((line) => theme.fg("toolOutput", line)),
            ...(preview ? [theme.fg("toolOutput", `Output preview:\n${preview}`)] : []),
          ].join("\n"),
        );
      }

      return textComponent(
        theme.fg("success", `✓ ${header} complete`) +
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

type CapletsResultArtifact = {
  kind: string;
  displayPath: string;
  pathResolution: string;
};

type CapletsResultMetadata = {
  name?: string;
  operation?: string;
  tool?: string;
  artifacts: CapletsResultArtifact[];
};

function capletsResultHeader(metadata: CapletsResultMetadata): string {
  return [metadata.name, metadata.operation, metadata.tool].filter(Boolean).join(" ");
}

function capletsMetadata(details: unknown): CapletsResultMetadata | undefined {
  const result = objectProperty(details, "result");
  const metadata =
    objectProperty(objectProperty(result, "_meta"), "caplets") ??
    objectProperty(objectProperty(result, "structuredContent"), "caplets");
  if (!metadata) {
    return undefined;
  }
  const resultMetadata: CapletsResultMetadata = { artifacts: [] };
  const name = stringProperty(metadata, "name");
  const operation = stringProperty(metadata, "operation");
  const tool = stringProperty(metadata, "tool");
  if (name) {
    resultMetadata.name = name;
  }
  if (operation) {
    resultMetadata.operation = operation;
  }
  if (tool) {
    resultMetadata.tool = tool;
  }
  resultMetadata.artifacts = arrayProperty(metadata, "artifacts")
    .map((artifact) => {
      const kind = stringProperty(artifact, "kind");
      const displayPath = stringProperty(artifact, "displayPath");
      const pathResolution = stringProperty(artifact, "pathResolution");
      return kind && displayPath && pathResolution
        ? { kind, displayPath, pathResolution }
        : undefined;
    })
    .filter((artifact): artifact is CapletsResultArtifact => Boolean(artifact));
  return resultMetadata;
}

function resultPreview(
  details: unknown,
  content: Array<{ type: string; text?: string }>,
  maxLength = 600,
): string {
  const rawContent = arrayProperty(objectProperty(details, "result"), "content");
  const resultContent = rawContent.length > 0 ? rawContent : content;
  const output = resultContent
    .filter((item) => stringProperty(item, "type") === "text")
    .map((item) => stringProperty(item, "text"))
    .filter((text): text is string => Boolean(text))
    .join("\n");
  if (!output) {
    return "";
  }
  return output.length > maxLength ? `${output.slice(0, maxLength).trimEnd()}…` : output;
}

function arrayProperty(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object" || !(key in value)) {
    return [];
  }
  const property = (value as Record<string, unknown>)[key];
  return Array.isArray(property) ? property : [];
}

function objectProperty(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || !(key in value)) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return property && typeof property === "object" && !Array.isArray(property)
    ? (property as Record<string, unknown>)
    : undefined;
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
