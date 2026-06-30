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
  hasNativeRuntimeSelectionEnv,
  readNativeDefaults,
  registerNativeCapletsProcessCleanup,
  type NativeCapletTool,
  type NativeCapletsService,
  type NativeCapletsServiceOptions,
} from "@caplets/core/native";

type PiNativeCapletsOptions = Pick<NativeCapletsServiceOptions, "mode" | "remote" | "daemon">;

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
  const writeWarning = options.writeWarning ?? (() => undefined);
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
  const defaultsArgs =
    ownsService &&
    !explicitNativeOptions &&
    !hasNativeRuntimeSettings(settingsArgs) &&
    !hasNativeRuntimeSelectionEnv()
      ? nativeDefaultsServiceOptions(options.writeWarning)
      : undefined;
  const serviceOptions =
    explicitNativeOptions ?? mergeNativeServiceOptions(defaultsArgs, settingsArgs);
  const service =
    options.service ??
    createNativeCapletsService({
      ...nativeServiceOptions(serviceOptions),
      telemetryIntegration: "pi",
    });
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
    const parsed = parsePiNativeOptions(argsValue, writeWarning, `${path}.${key}`);
    if (!parsed) {
      writeWarning(`[caplets/pi] Ignoring Pi settings args: invalid ${path}.${key} shape`);
      return {};
    }
    return parsed;
  }
  return undefined;
}

function parsePiNativeOptions(
  value: unknown,
  _writeWarning?: (message: string) => void,
  _path = "settings.caplets",
): PiCapletsSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const result: PiCapletsSettings = {};
  const mode = raw.mode;
  if (mode !== undefined) {
    if (
      mode !== "auto" &&
      mode !== "local" &&
      mode !== "remote" &&
      mode !== "cloud" &&
      mode !== "daemon"
    ) {
      return undefined;
    }
    result.mode = mode;
  }
  const statusWidget = raw.statusWidget;
  if (statusWidget !== undefined) {
    if (typeof statusWidget !== "boolean") return undefined;
    result.statusWidget = statusWidget;
  }
  const nerdFontIcons = raw.nerdFontIcons;
  if (nerdFontIcons !== undefined) {
    if (typeof nerdFontIcons !== "boolean") return undefined;
    result.nerdFontIcons = nerdFontIcons;
  }
  const remote = objectProperty(value, "remote");
  if (raw.remote !== undefined && !remote) {
    return undefined;
  }
  if (remote) {
    const parsedRemote: NonNullable<PiNativeCapletsOptions["remote"]> = {};
    for (const key of ["url", "workspace"] as const) {
      const field = remote[key];
      if (field !== undefined) {
        if (typeof field !== "string") return undefined;
        parsedRemote[key] = field;
      }
    }
    const pollIntervalMs = remote.pollIntervalMs;
    if (pollIntervalMs !== undefined) {
      if (!isValidNativePollIntervalMs(pollIntervalMs)) return undefined;
      parsedRemote.pollIntervalMs = pollIntervalMs;
    }
    result.remote = parsedRemote;
  }
  const daemon = objectProperty(value, "daemon");
  if (raw.daemon !== undefined && !daemon) {
    return undefined;
  }
  if (daemon) {
    const parsedDaemon: NonNullable<PiNativeCapletsOptions["daemon"]> = {};
    const url = daemon.url;
    if (url !== undefined) {
      if (typeof url !== "string") return undefined;
      parsedDaemon.url = url;
    }
    const pollIntervalMs = daemon.pollIntervalMs;
    if (pollIntervalMs !== undefined) {
      if (!isValidNativePollIntervalMs(pollIntervalMs)) return undefined;
      parsedDaemon.pollIntervalMs = pollIntervalMs;
    }
    result.daemon = parsedDaemon;
  }
  if (raw.server !== undefined) {
    return undefined;
  }
  return result;
}

function isValidNativePollIntervalMs(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 1_000
  );
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
    ...(options.remote ? { remote: options.remote } : {}),
    ...(options.daemon ? { daemon: options.daemon } : {}),
  };
}

function hasNativeRuntimeSettings(options: PiCapletsSettings | undefined): boolean {
  return Boolean(options?.mode || options?.remote || options?.daemon);
}

function nativeDefaultsServiceOptions(
  writeWarning: ((message: string) => void) | undefined,
): PiNativeCapletsOptions {
  const defaults = readNativeDefaults({
    writeWarning: (message) => writeWarning?.(`[caplets/pi] ${message}`),
  });
  return defaults ? { mode: "daemon", daemon: { url: defaults.daemon.url } } : {};
}

function mergeNativeServiceOptions(
  defaults: PiNativeCapletsOptions | undefined,
  settings: PiCapletsSettings | undefined,
): PiNativeCapletsOptions {
  return {
    ...defaults,
    ...nativeServiceOptions(settings ?? {}),
  };
}

function shouldShowStatusWidget(
  options: PiNativeCapletsOptions,
  statusWidget: boolean | undefined,
): boolean {
  if (statusWidget === false) {
    return false;
  }
  if (options.mode === "local") {
    return false;
  }
  return (
    options.mode === "remote" ||
    options.mode === "cloud" ||
    options.mode === "daemon" ||
    !!options.remote?.url ||
    process.env.CAPLETS_REMOTE_URL !== undefined ||
    process.env.CAPLETS_MODE === "daemon" ||
    process.env.CAPLETS_DAEMON_URL !== undefined
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
    parameters: (caplet.inputSchema ??
      generatedToolInputJsonSchema()) as ToolDefinition["parameters"],
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
  const codeModeContent = codeModeAgentContent(result);
  if (codeModeContent) {
    return codeModeContent;
  }

  const content = arrayProperty(result, "content")
    .filter((item) => stringProperty(item, "type") === "text")
    .map((item) => ({ type: "text" as const, text: stringProperty(item, "text") }))
    .filter((item): item is { type: "text"; text: string } => Boolean(item.text));
  if (content.length > 0) {
    return content;
  }
  return [{ type: "text", text: JSON.stringify(result, null, 2) ?? "null" }];
}

function codeModeAgentContent(result: unknown): Array<{ type: "text"; text: string }> | undefined {
  if (!isCodeModeRunEnvelope(result)) return undefined;
  const ok = Boolean(result.ok);
  const diagnostics = arrayProperty(result, "diagnostics");
  const logs = objectProperty(result, "logs");
  const meta = objectProperty(result, "meta");
  const value = (result as Record<string, unknown>).value;
  const compact: Record<string, unknown> = {
    ok,
    ...(ok ? { value: compactCodeModeAgentValue(value) } : { error: result.error }),
  };
  if (diagnostics.length > 0) compact.diagnostics = diagnostics;
  const logSummary = codeModeLogSummary(logs);
  if (logSummary) compact.logs = logSummary;
  if (meta) compact.meta = meta;
  return [{ type: "text", text: JSON.stringify(compact) ?? "null" }];
}

function compactCodeModeAgentValue(value: unknown, depth = 0): unknown {
  if (depth > 16) return "[Max depth reached]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 40).map((item) => compactCodeModeAgentValue(item, depth + 1));
    return value.length > items.length
      ? [...items, { truncatedItems: value.length - items.length }]
      : items;
  }
  if (!value || typeof value !== "object") return compactCodeModeScalar(value);
  const record = value as Record<string, unknown>;
  if (isSuccessfulToolCallResultEnvelope(record)) {
    return compactCodeModeAgentValue(record.data, depth + 1);
  }
  if (isFailedToolCallResultEnvelope(record)) {
    return { ok: false, error: compactCodeModeAgentValue(record.error, depth + 1) };
  }
  const descriptor = compactCodeModeDescriptor(record, depth);
  if (descriptor) return descriptor;
  const entries = Object.entries(record).flatMap(([key, nested]) => {
    if (isCodeModeAgentNoiseKey(key, nested)) return [];
    return [[key, compactCodeModeAgentValue(nested, depth + 1)] as const];
  });
  return Object.fromEntries(entries);
}

function compactCodeModeScalar(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed.length > 1200 ? `${collapsed.slice(0, 1197).trimEnd()}...` : value;
}

function isSuccessfulToolCallResultEnvelope(record: Record<string, unknown>): boolean {
  return (
    record.ok === true &&
    "data" in record &&
    Object.keys(record).every((key) => ["ok", "data", "meta"].includes(key)) &&
    isCapletsToolMeta(record.meta)
  );
}

function isFailedToolCallResultEnvelope(record: Record<string, unknown>): boolean {
  return (
    record.ok === false &&
    "error" in record &&
    Object.keys(record).every((key) => ["ok", "error", "meta"].includes(key)) &&
    (record.meta === undefined || isCapletsToolMeta(record.meta))
  );
}

function isCapletsToolMeta(value: unknown): boolean {
  const meta = value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  if (!meta) return false;
  const record = meta as Record<string, unknown>;
  return Boolean(
    typeof record.capletId === "string" ||
    typeof record.tool === "string" ||
    typeof record.status === "string" ||
    typeof record.durationMs === "number" ||
    typeof record.elapsedMs === "number",
  );
}

function compactCodeModeDescriptor(
  record: Record<string, unknown>,
  depth: number,
): Record<string, unknown> | undefined {
  if (!("callSignature" in record || "inputTypeScript" in record || "inputSchema" in record)) {
    return undefined;
  }
  const compact: Record<string, unknown> = {};
  for (const key of ["id", "name", "title", "description", "callSignature", "inputTypeScript"])
    if (record[key] !== undefined) compact[key] = compactCodeModeAgentValue(record[key], depth + 1);
  const tool = objectProperty(record, "tool");
  if (tool) {
    compact.tool = compactCodeModeAgentValue(
      Object.fromEntries(
        Object.entries(tool).filter(
          ([key]) => !["inputSchema", "outputSchema", "annotations"].includes(key),
        ),
      ),
      depth + 1,
    );
  }
  return compact;
}

function isCodeModeAgentNoiseKey(key: string, value: unknown): boolean {
  if (["inputSchema", "outputSchema", "outputTypeScript", "observedOutputShape"].includes(key)) {
    return true;
  }
  if (key === "examples" && Array.isArray(value)) return value.length > 0;
  if (key === "fieldSelection") return true;
  if (key === "meta" && isCapletsToolMeta(value)) return true;
  return false;
}

function isCodeModeRunEnvelope(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.ok === "boolean" &&
    Array.isArray(record.diagnostics) &&
    Boolean(record.logs) &&
    typeof record.logs === "object" &&
    !Array.isArray(record.logs) &&
    Boolean(record.meta) &&
    typeof record.meta === "object" &&
    !Array.isArray(record.meta) &&
    ("value" in record || "error" in record)
  );
}

function codeModeLogSummary(
  logs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!logs) return undefined;
  const entries = arrayProperty(logs, "entries");
  const truncated = logs.truncated === true;
  const logRef = stringProperty(logs, "logRef");
  const summary: Record<string, unknown> = {};
  if (entries.length > 0) summary.entries = entries;
  if (truncated) summary.truncated = true;
  if (logRef) summary.logRef = logRef;
  return Object.keys(summary).length > 0 ? summary : undefined;
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
