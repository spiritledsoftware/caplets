import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  keyText,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { generatedToolInputJsonSchema } from "@caplets/core/generated-tool-input-schema";
import {
  createNativeCapletsService,
  registerNativeCapletsProcessCleanup,
  type NativeCapletTool,
  type NativeCapletsService,
  type NativeCapletsServiceOptions,
} from "@caplets/core/native";

type PiNativeCapletsOptions = Pick<NativeCapletsServiceOptions, "mode" | "server" | "remote">;

export type PiExtensionApi = Pick<ExtensionAPI, "registerTool"> &
  Partial<Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">> & {
    on?: (
      event: "session_start" | "session_shutdown",
      handler: (event?: unknown, ctx?: ExtensionContext) => void,
    ) => void;
  };

type PiCapletsSettings = PiNativeCapletsOptions & {
  statusWidget?: boolean;
  nerdFontIcons?: boolean;
};

export type CapletsPiOptions = {
  service?: NativeCapletsService;
  args?: PiNativeCapletsOptions;
  native?: PiNativeCapletsOptions;
  statusWidget?: boolean;
};

type InternalCapletsPiOptions = CapletsPiOptions & {
  loadSettings?: boolean;
  settingsPath?: string;
  readSettingsFile?: (path: string) => Promise<string>;
  writeWarning?: (message: string) => void;
};

export function createCapletsPiExtension(
  options: CapletsPiOptions,
): (pi: PiExtensionApi) => void | Promise<void> {
  return (pi) => registerCapletsPiExtension(pi, options);
}

export async function loadPiSettingsArgs(
  options: {
    settingsPath?: string;
    projectSettingsPath?: string;
    readSettingsFile?: (path: string) => Promise<string>;
    writeWarning?: (message: string) => void;
  } = {},
): Promise<PiCapletsSettings> {
  const settingsPath = options.settingsPath ?? join(homedir(), ".pi", "agent", "settings.json");
  const projectSettingsPath =
    options.projectSettingsPath ?? join(process.cwd(), ".pi", "settings.json");
  const readSettingsFile = options.readSettingsFile ?? readFileUtf8;
  const writeWarning = options.writeWarning ?? ((message) => process.stderr.write(`${message}\n`));
  const userSettings = await readPiSettingsFile(settingsPath, readSettingsFile, writeWarning);
  const projectSettings = await readPiSettingsFile(
    projectSettingsPath,
    readSettingsFile,
    writeWarning,
  );
  return {
    ...extractPiSettingsArgs(userSettings, writeWarning),
    ...extractPiSettingsArgs(projectSettings, writeWarning),
  };
}

async function readPiSettingsFile(
  settingsPath: string,
  readSettingsFile: (path: string) => Promise<string>,
  writeWarning: (message: string) => void,
): Promise<unknown> {
  try {
    return JSON.parse(await readSettingsFile(settingsPath));
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {};
    }
    writeWarning(
      `[caplets/pi] Ignoring Pi settings args from ${settingsPath}: ${safeErrorMessage(error)}`,
    );
    return {};
  }
}

export default async function capletsPiExtension(pi: PiExtensionApi): Promise<void> {
  return registerCapletsPiExtension(pi, { loadSettings: true });
}

async function registerCapletsPiExtension(
  pi: PiExtensionApi,
  options: InternalCapletsPiOptions,
): Promise<void> {
  const ownsService = !options.service;
  const explicitNativeOptions = options.native ?? options.args;
  const settingsArgs =
    ownsService && !explicitNativeOptions && options.loadSettings
      ? await loadPiSettingsArgs(options)
      : undefined;
  const serviceOptions = explicitNativeOptions ?? settingsArgs ?? {};
  const service =
    options.service ?? createNativeCapletsService(nativeServiceOptions(serviceOptions));
  const showStatusWidget = shouldShowStatusWidget(
    serviceOptions,
    options.statusWidget ?? settingsArgs?.statusWidget,
  );
  const useNerdFontIcons = settingsArgs?.nerdFontIcons !== false;
  if (ownsService) {
    registerNativeCapletsProcessCleanup(service);
  }

  const registeredCapletToolSignatures = new Map<string, string>();
  let currentCapletTools = new Set<string>();
  let knownCapletTools = new Set<string>();
  let canSyncActiveTools = false;
  let statusCtx: ExtensionContext | undefined;
  let remoteStatus: "connected" | "offline" = "offline";

  const syncStatusWidget = () => {
    if (!showStatusWidget || !statusCtx) {
      return;
    }
    statusCtx.ui.setWidget(
      "caplets",
      (_tui, theme) =>
        new Text(
          theme.fg(
            remoteStatus === "connected" ? "success" : "error",
            capletsRemoteStatusText(remoteStatus, useNerdFontIcons),
          ),
          0,
          0,
        ),
      { placement: "belowEditor" },
    );
  };

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

  let unsubscribe: (() => void) | undefined;
  let isShutdown = false;
  const startSync = () => {
    if (isShutdown) {
      return;
    }
    currentCapletTools = syncToolRegistrations();
    unsubscribe = service.onToolsChanged((caplets) => {
      if (isShutdown) {
        return;
      }
      remoteStatus = "connected";
      syncStatusWidget();
      syncActiveTools(syncToolRegistrations(caplets));
    });
  };
  pi.on?.("session_start", (_event, ctx) => {
    statusCtx = ctx;
    syncStatusWidget();
    canSyncActiveTools = true;
    knownCapletTools = new Set(
      pi.getActiveTools?.().filter((name) => name.startsWith("caplets_")) ?? [],
    );
    syncActiveTools();
  });
  pi.on?.("session_shutdown", () => {
    isShutdown = true;
    statusCtx?.ui.setWidget("caplets", undefined);
    statusCtx = undefined;
    unsubscribe?.();
    if (ownsService) {
      void service.close();
    }
  });
  if (ownsService) {
    remoteStatus = (await service.reload()) ? "connected" : "offline";
    if (!isShutdown) {
      startSync();
    }
    return;
  }
  startSync();
}

function extractPiSettingsArgs(
  settings: unknown,
  writeWarning: (message: string) => void,
  path = "settings",
): PiCapletsSettings {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return {};
  }
  const settingsObject = settings as Record<string, unknown>;
  return topLevelCapletsOptions(settingsObject, writeWarning, path) ?? {};
}

function topLevelCapletsOptions(
  settings: Record<string, unknown>,
  writeWarning: (message: string) => void,
  path: string,
): PiCapletsSettings | undefined {
  for (const key of ["caplets", "@caplets/pi", "capletsPi", "caplets-pi"]) {
    const value = objectProperty(settings, key);
    if (!value) {
      continue;
    }
    const argsValue = objectProperty(value, "native") ?? objectProperty(value, "args") ?? value;
    const parsed = parsePiNativeOptions(argsValue);
    if (!parsed) {
      writeWarning(`[caplets/pi] Ignoring Pi settings args: invalid ${path}.${key} shape`);
      return {};
    }
    return parsed;
  }
  return undefined;
}

function parsePiNativeOptions(value: unknown): PiCapletsSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const result: PiCapletsSettings = {};
  const mode = (value as Record<string, unknown>).mode;
  if (mode !== undefined) {
    if (mode !== "auto" && mode !== "local" && mode !== "remote") return undefined;
    result.mode = mode;
  }
  const statusWidget = (value as Record<string, unknown>).statusWidget;
  if (statusWidget !== undefined) {
    if (typeof statusWidget !== "boolean") return undefined;
    result.statusWidget = statusWidget;
  }
  const nerdFontIcons = (value as Record<string, unknown>).nerdFontIcons;
  if (nerdFontIcons !== undefined) {
    if (typeof nerdFontIcons !== "boolean") return undefined;
    result.nerdFontIcons = nerdFontIcons;
  }
  const remote = objectProperty(value, "remote");
  if (remote) {
    const parsedRemote: NonNullable<PiNativeCapletsOptions["remote"]> = {};
    const pollIntervalMs = remote.pollIntervalMs;
    if (pollIntervalMs !== undefined) {
      if (typeof pollIntervalMs !== "number" || !Number.isFinite(pollIntervalMs)) return undefined;
      parsedRemote.pollIntervalMs = pollIntervalMs;
    }
    result.remote = parsedRemote;
  }
  const server = objectProperty(value, "server");
  if (server) {
    const parsedServer: NonNullable<PiNativeCapletsOptions["server"]> = {};
    for (const key of ["url", "user", "password"] as const) {
      const field = server[key];
      if (field !== undefined) {
        if (typeof field !== "string") return undefined;
        parsedServer[key] = field;
      }
    }
    result.server = parsedServer;
  }
  return result;
}

function capletsRemoteStatusText(status: "connected" | "offline", nerdFontIcons: boolean): string {
  if (nerdFontIcons) {
    return status === "connected" ? "󰖟 caplets ✓" : "󰖟 caplets ×";
  }
  return status === "connected" ? "caplets ✓" : "caplets ×";
}

function nativeServiceOptions(options: PiCapletsSettings): PiNativeCapletsOptions {
  return {
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.server ? { server: options.server } : {}),
    ...(options.remote ? { remote: options.remote } : {}),
  };
}

function shouldShowStatusWidget(
  options: PiNativeCapletsOptions,
  statusWidget: boolean | undefined,
): boolean {
  if (statusWidget === false) {
    return false;
  }
  return (
    options.mode === "remote" ||
    !!options.server?.url ||
    process.env.CAPLETS_SERVER_URL !== undefined
  );
}

async function readFileUtf8(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(password|token|secret)(["'\s:=]+)([^\s,"'}]+)/giu, "$1$2[redacted]");
}

function piToolSignature(caplet: NativeCapletTool): string {
  return JSON.stringify({
    caplet: caplet.caplet,
    title: caplet.title,
    description: caplet.description,
    promptGuidance: caplet.promptGuidance,
  });
}

function createPiTool(service: NativeCapletsService, caplet: NativeCapletTool): ToolDefinition {
  return {
    name: caplet.toolName,
    label: caplet.title,
    description: caplet.description,
    promptSnippet: `Use ${caplet.toolName} for the ${caplet.title} Caplet capability domain.`,
    promptGuidelines: caplet.promptGuidance,
    parameters: generatedToolInputJsonSchema() as ToolDefinition["parameters"],
    async execute(_toolCallId, params) {
      const result = await service.execute(caplet.caplet, params);
      const serialized = serializeResult(result);
      return {
        content: serialized.serializationError
          ? [{ type: "text", text: serialized.text }]
          : agentContent(result),
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
      const statusView = capletsStatusView(metadata.status);
      if (expanded) {
        const artifactLines = metadata.artifacts.map(
          (artifact) =>
            `Artifact: ${artifact.kind} ${artifact.displayPath} (${artifact.pathResolution})`,
        );
        const output = resultFullContent(result.content);
        return textComponent(
          [
            theme.fg(statusView.tone, `${statusView.icon} ${header} ${statusView.label}`) +
              theme.fg("dim", ` (${toolExpandKeyText()} to collapse)`),
            ...artifactLines.map((line) => theme.fg("toolOutput", line)),
            ...(output ? [theme.fg("toolOutput", output)] : []),
          ].join("\n"),
        );
      }

      const preview = resultPreview(result.details, result.content);
      return textComponent(
        [
          theme.fg(statusView.tone, `${statusView.icon} ${header} ${statusView.label}`) +
            theme.fg("dim", ` (${toolExpandKeyText()} to expand)`),
          ...(preview ? [theme.fg("toolOutput", preview)] : []),
        ].join("\n"),
      );
    },
  };
}

function toolExpandKeyText(): string {
  return keyText("app.tools.expand") || "ctrl+o";
}

function textComponent(text: string): { render(width: number): string[]; invalidate(): void } {
  return {
    render(width) {
      return text.split("\n").map((line) => fitLineToWidth(line, width));
    },
    invalidate() {},
  };
}

function fitLineToWidth(line: string, width: number): string {
  if (width <= 0 || visibleWidth(line) <= width) {
    return line;
  }
  return truncateToWidth(line, width);
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
  status?: string;
  artifacts: CapletsResultArtifact[];
};

function capletsStatusView(status?: string): {
  tone: "success" | "error";
  icon: string;
  label: string;
} {
  if (status === "error" || status === "failed") {
    return { tone: "error", icon: "✗", label: "failed" };
  }
  return { tone: "success", icon: "✓", label: status && status !== "ok" ? status : "complete" };
}

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
  const status = stringProperty(metadata, "status");
  if (name) {
    resultMetadata.name = name;
  }
  if (operation) {
    resultMetadata.operation = operation;
  }
  if (tool) {
    resultMetadata.tool = tool;
  }
  if (status) {
    resultMetadata.status = status;
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
  maxLength = 96,
): string {
  const result = objectProperty(details, "result");
  if (result) {
    return compactResultText(result, maxLength);
  }
  const output = content
    .filter((item) => stringProperty(item, "type") === "text")
    .map((item) => stringProperty(item, "text"))
    .filter((text): text is string => Boolean(text))
    .join("\n");
  return compactText(output, maxLength);
}

function resultFullContent(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((item) => stringProperty(item, "type") === "text")
    .map((item) => stringProperty(item, "text"))
    .filter((text): text is string => Boolean(text))
    .join("\n");
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
    JSON.stringify(result);
    return { text: compactResultText(result) };
  } catch (error) {
    const serializationError = error instanceof Error ? error.message : String(error);
    return { text: `[Serialization error: ${serializationError}]`, serializationError };
  }
}

function agentContent(result: unknown): Array<{ type: "text"; text: string }> {
  const content = arrayProperty(result, "content")
    .filter((item) => stringProperty(item, "type") === "text")
    .map((item) => ({ type: "text" as const, text: stringProperty(item, "text") }))
    .filter((item): item is { type: "text"; text: string } => Boolean(item.text));
  if (content.length > 0) {
    return content;
  }
  return [{ type: "text", text: JSON.stringify(result, null, 2) ?? "null" }];
}

function compactResultText(result: unknown, maxLength = 600): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return compactText(String(result ?? "null"), maxLength);
  }
  const structured = objectProperty(result, "structuredContent");
  const payload = objectProperty(structured, "result");
  if (payload) {
    return compactPayloadSummary(payload, maxLength);
  }
  const content = arrayProperty(result, "content")
    .filter((item) => stringProperty(item, "type") === "text")
    .map((item) => stringProperty(item, "text"))
    .filter((text): text is string => Boolean(text));
  if (content.length > 0) {
    return compactText(content.join("\n"), maxLength);
  }
  return "Caplets result";
}

function compactPayloadSummary(payload: Record<string, unknown>, maxLength = 600): string {
  const tools = arrayProperty(payload, "tools");
  if (tools.length > 0) {
    const names = tools
      .map((tool) => stringProperty(tool, "tool") ?? stringProperty(tool, "name"))
      .filter((name): name is string => Boolean(name));
    const suffix = names.length > 0 ? `: ${names.join(", ")}` : "";
    return compactText(`${tools.length} tools${suffix}`, maxLength);
  }
  const tool = objectProperty(payload, "tool");
  if (tool) {
    const name = stringProperty(tool, "name") ?? stringProperty(payload, "tool");
    const inputSchema = objectProperty(tool, "inputSchema");
    const required = arrayProperty(inputSchema, "required")
      .filter((value): value is string => typeof value === "string")
      .join(", ");
    return compactText(
      [name, required ? `requires: ${required}` : undefined].filter(Boolean).join(" · "),
      maxLength,
    );
  }
  const caplet = stringProperty(payload, "caplet");
  if (caplet) {
    const name = stringProperty(payload, "name") ?? caplet;
    const backend = objectProperty(payload, "backend");
    const backendType = stringProperty(backend, "type");
    return compactText(
      [name, backendType ? `${backendType} backend` : undefined].filter(Boolean).join(" · "),
      maxLength,
    );
  }
  return compactText(JSON.stringify(payload), maxLength);
}

function compactText(value: string, maxLength = 600): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed.length > maxLength
    ? `${collapsed.slice(0, maxLength - 1).trimEnd()}…`
    : collapsed;
}
