import type { NativeCapletsServiceResolutionInput } from "./options";
import {
  resolveNativeCapletsServiceOptions,
  type NativeRemoteAuthOptions,
  type ResolvedNativeCloudPresenceOptions,
} from "./options";
import { CapletsCloudClient } from "../cloud/client";
import { ProjectBindingSessionManager } from "../cloud/presence";
import { projectSyncFiles } from "../cloud/sync";
import { findProjectRoot, fingerprintProjectRoot } from "../cloud/project-root";
import {
  createSdkRemoteCapletsClient,
  RemoteNativeCapletsService,
  type RemoteCapletsClient,
} from "./remote";
import { CapletsEngine } from "../engine";
import { CapletsError } from "../errors";
import {
  nativeCapletPromptGuidance,
  nativeCapletToolDescription,
  nativeCapletToolName,
  nativeCodeModeToolId,
  nativeCodeModeToolName,
} from "./tools";
import { nativeDirectToolName } from "../exposure/direct-names";
import { resolveExposure } from "../exposure/policy";
import {
  generateCodeModeDeclarations,
  generateCodeModeRunToolDescription,
} from "../code-mode/declarations";
import type { DirectToolRegistration, ExposureSnapshot } from "../exposure/discovery";
import { runCodeMode } from "../code-mode/runner";
import { codeModeRunInputJsonSchema, codeModeRunInputSchema } from "../code-mode/tool";
import type { CodeModeCallableCaplet } from "../code-mode/types";
import {
  loadLocalOverlayConfigWithSources,
  parseConfig,
  type CapletsConfig,
  type LocalOverlayConfigWithSources,
} from "../config";
import { generatedToolInputJsonSchemaForCaplet } from "../generated-tool-input-schema";
import type { CapletsRemoteAuth } from "../remote/options";
import { resolveRemoteSelection } from "../remote/selection";

const REMOTE_PROJECT_BINDING_FALLBACK_WARNING =
  "Remote project binding unavailable; using local Caplets only. Run caplets doctor for details.\n";
let hasWarnedRemoteProjectBindingFallback = false;

export type NativeCapletsServiceOptions = NativeCapletsServiceResolutionInput & {
  configPath?: string;
  projectConfigPath?: string;
  authDir?: string;
  watchDebounceMs?: number;
  watch?: boolean;
  writeErr?: (value: string) => void;
  remoteClientFactory?: (options: ResolvedNativeRemoteOptions) => RemoteCapletsClient;
  localServiceFactory?: (options: LocalNativeCapletsServiceOptions) => NativeCapletsService;
};

export type NativeCapletTool = {
  caplet: string;
  sourceCaplet?: string;
  toolName: string;
  title: string;
  description: string;
  codeModeRun?: boolean;
  useWhen?: string;
  avoidWhen?: string;
  promptGuidance: string[];
  inputSchema?: ReturnType<typeof generatedToolInputJsonSchemaForCaplet> | Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  operationNames?: string[];
  codeModeCaplets?: CodeModeCallableCaplet[];
};

export type NativeCapletsToolsChangedListener = (tools: NativeCapletTool[]) => void;

export type NativeCapletsService = {
  listTools(): NativeCapletTool[];
  execute(capletId: string, request: unknown): Promise<unknown>;
  reload(): Promise<boolean>;
  onToolsChanged(listener: NativeCapletsToolsChangedListener): () => void;
  close(): Promise<void>;
};

export function createNativeCapletsService(
  options: NativeCapletsServiceOptions = {},
): NativeCapletsService {
  const resolved = resolveNativeCapletsServiceOptions(options);
  if (resolved.mode === "remote") {
    const local = createLocalOverlayService(options);
    try {
      return createCompositeRemoteService(resolved.remote, local, options, "self_hosted_remote");
    } catch (error) {
      if (options.mode !== "remote") {
        warnRemoteProjectBindingFallback(options);
        return local;
      }
      void local.close().catch((closeError) => {
        writeErr(
          options,
          `Could not close local overlay Caplets service: ${errorMessage(closeError)}\n`,
        );
      });
      throw error;
    }
  }
  if (resolved.mode === "cloud") {
    return new CloudNativeCapletsService(options, resolved.remote);
  }
  return new DefaultNativeCapletsService(options);
}

export function resetNativeProjectBindingFallbackWarningForTests(): void {
  hasWarnedRemoteProjectBindingFallback = false;
}

type LocalNativeCapletsServiceOptions = NativeCapletsServiceOptions & {
  configLoader?: (configPath: string, projectConfigPath: string) => CapletsConfig;
};

class DefaultNativeCapletsService implements NativeCapletsService {
  private readonly engine: CapletsEngine;
  private readonly writeErr: (value: string) => void;
  private readonly unsubscribeEngineReload: () => void;
  private readonly toolListeners = new Set<NativeCapletsToolsChangedListener>();
  private directToolRoutes = new Map<string, { capletId: string; operationName: string }>();
  private exposureSnapshot: ExposureSnapshot | undefined;
  private postReloadRefresh: Promise<void> | undefined;
  private exposureRefreshGeneration = 0;

  constructor(options: LocalNativeCapletsServiceOptions) {
    this.writeErr = options.writeErr ?? (() => undefined);
    this.engine = new CapletsEngine({
      ...options,
      writeErr: this.writeErr,
    });
    this.postReloadRefresh = this.refreshExposureSnapshot({
      emitToolsChanged: this.hasDirectMcpExposure(),
    });
    this.unsubscribeEngineReload = this.engine.onReload(() => {
      this.postReloadRefresh = this.refreshExposureSnapshot({ emitToolsChanged: true });
    });
  }

  listTools(): NativeCapletTool[] {
    this.directToolRoutes = new Map();
    const progressiveTools: NativeCapletTool[] = [];
    const codeModeCaplets: NativeCapletTool[] = [];
    const directTools: NativeCapletTool[] = [];
    for (const caplet of this.engine.enabledServers()) {
      if (caplet.setup || caplet.projectBinding?.required) continue;
      const exposure = resolveExposure(
        caplet.exposure,
        this.engine.currentConfig().options.exposure,
      );
      if (exposure.progressive) {
        const tool = progressiveNativeTool(caplet);
        progressiveTools.push(tool);
        if (exposure.codeMode) codeModeCaplets.push(codeModeCapletDescriptor(caplet));
        continue;
      }
      if (exposure.direct) {
        directTools.push(...this.directNativeTools(caplet, this.exposureSnapshot));
      }
      if (exposure.codeMode) {
        codeModeCaplets.push(codeModeCapletDescriptor(caplet));
      }
    }
    return [
      ...progressiveTools,
      ...directTools,
      ...(codeModeCaplets.length > 0 ? [codeModeRunNativeTool(codeModeCaplets)] : []),
    ];
  }

  async execute(capletId: string, request: unknown): Promise<unknown> {
    if (capletId === nativeCodeModeToolId) {
      return await executeCodeModeRunNative(this.codeModeDelegate(), request);
    }
    const route = this.directToolRoutes.get(capletId);
    if (route) {
      if (isMcpPrimitiveRoute(route.operationName)) {
        return await this.engine.execute(
          route.capletId,
          nativeMcpPrimitiveRequest(route.operationName, request),
        );
      }
      return await this.engine.executeDirectTool(
        route.capletId,
        route.operationName,
        isRecord(request) ? request : {},
      );
    }
    return await this.engine.execute(capletId, request);
  }

  async reload(): Promise<boolean> {
    const reloaded = await this.engine.reload();
    await this.postReloadRefresh;
    return reloaded;
  }

  onToolsChanged(listener: NativeCapletsToolsChangedListener): () => void {
    this.toolListeners.add(listener);
    return () => {
      this.toolListeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    this.unsubscribeEngineReload();
    this.toolListeners.clear();
    await this.engine.close();
  }

  private directNativeTools(
    caplet: ReturnType<CapletsEngine["enabledServers"]>[number],
    snapshot: ExposureSnapshot | undefined,
  ): NativeCapletTool[] {
    if (caplet.backend === "http") {
      return Object.entries(caplet.actions)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([operationName, action]) =>
          this.directNativeTool(caplet, operationName, {
            ...(action.description ? { description: action.description } : {}),
            ...(action.inputSchema ? { inputSchema: action.inputSchema } : {}),
            ...(action.outputSchema ? { outputSchema: action.outputSchema } : {}),
            annotations: {
              readOnlyHint: action.method === "GET",
              destructiveHint: action.method === "DELETE",
            },
          }),
        );
    }
    if (caplet.backend === "cli") {
      return Object.entries(caplet.actions)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([operationName, action]) =>
          this.directNativeTool(caplet, operationName, {
            ...(action.description ? { description: action.description } : {}),
            ...(action.inputSchema ? { inputSchema: action.inputSchema } : {}),
            ...(action.outputSchema ? { outputSchema: action.outputSchema } : {}),
            ...(action.annotations ? { annotations: action.annotations } : {}),
          }),
        );
    }
    if (caplet.backend === "mcp") {
      const directTools =
        snapshot?.directTools
          .filter((entry) => entry.caplet.server === caplet.server)
          .map((entry) => this.directMcpTool(caplet, entry)) ?? [];
      return [
        ...directTools,
        ...mcpPrimitiveNativeTools(caplet, snapshot).map((operationName) =>
          this.directNativeTool(caplet, operationName, {
            description: `MCP ${operationName.replace(/_/g, " ")}.`,
            inputSchema: nativeMcpPrimitiveInputSchema(operationName),
          }),
        ),
      ];
    }
    return [];
  }

  private directMcpTool(
    caplet: ReturnType<CapletsEngine["enabledServers"]>[number],
    entry: DirectToolRegistration,
  ): NativeCapletTool {
    return this.directNativeTool(caplet, entry.downstreamName, {
      ...(entry.tool.description ? { description: entry.tool.description } : {}),
      ...(entry.tool.inputSchema
        ? { inputSchema: entry.tool.inputSchema as Record<string, unknown> }
        : {}),
      ...(entry.tool.outputSchema
        ? { outputSchema: entry.tool.outputSchema as Record<string, unknown> }
        : {}),
      ...(entry.tool.annotations ? { annotations: entry.tool.annotations } : {}),
    });
  }

  private directNativeTool(
    caplet: ReturnType<CapletsEngine["enabledServers"]>[number],
    operationName: string,
    options: {
      description?: string;
      inputSchema?: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
      annotations?: Record<string, unknown>;
    },
  ): NativeCapletTool {
    const routeId = `${caplet.server}__${operationName}`;
    const toolName = nativeDirectToolName(caplet.server, operationName);
    this.directToolRoutes.set(routeId, { capletId: caplet.server, operationName });
    return {
      caplet: routeId,
      toolName,
      title: operationName,
      description: options.description ?? "",
      ...(caplet.useWhen ? { useWhen: caplet.useWhen } : {}),
      ...(caplet.avoidWhen ? { avoidWhen: caplet.avoidWhen } : {}),
      promptGuidance: [`Use ${toolName} for ${caplet.name} ${operationName}.`],
      ...(options.inputSchema ? { inputSchema: options.inputSchema } : {}),
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
    };
  }

  private async refreshExposureSnapshot(options: { emitToolsChanged: boolean }): Promise<void> {
    const generation = ++this.exposureRefreshGeneration;
    try {
      const snapshot = await this.engine.exposureSnapshot({
        discoverNonDirectMcpSurfaces: false,
      });
      if (generation !== this.exposureRefreshGeneration) return;
      this.exposureSnapshot = snapshot;
      if (options.emitToolsChanged) this.emitToolsChanged();
    } catch (error) {
      if (generation !== this.exposureRefreshGeneration) return;
      this.writeErr(`Caplets native tool reload failed.\n`);
      this.writeErr(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  private hasDirectMcpExposure(): boolean {
    return this.engine.enabledServers().some((caplet) => {
      if (caplet.backend !== "mcp" || caplet.setup || caplet.projectBinding?.required) return false;
      return resolveExposure(caplet.exposure, this.engine.currentConfig().options.exposure).direct;
    });
  }

  private emitToolsChanged(): void {
    const tools = this.listTools();
    for (const listener of this.toolListeners) {
      try {
        listener(tools);
      } catch (error) {
        this.writeErr(`Caplets native tool listener failed.\n`);
        this.writeErr(`${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }

  private codeModeDelegate(): NativeCapletsService {
    return {
      listTools: () => this.codeModeNativeTools(),
      execute: async (capletId, request) => await this.engine.execute(capletId, request),
      reload: async () => await this.reload(),
      onToolsChanged: () => () => undefined,
      close: async () => undefined,
    };
  }

  private codeModeNativeTools(): NativeCapletTool[] {
    const snapshotCaplets = this.exposureSnapshot?.codeModeCaplets.map((entry) => entry.caplet);
    const caplets =
      snapshotCaplets ??
      this.engine.enabledServers().filter((caplet) => {
        if (caplet.setup || caplet.projectBinding?.required) return false;
        return resolveExposure(caplet.exposure, this.engine.currentConfig().options.exposure)
          .codeMode;
      });
    return caplets.map(codeModeCapletDescriptor);
  }
}

function progressiveNativeTool(
  caplet: ReturnType<CapletsEngine["enabledServers"]>[number],
): NativeCapletTool {
  const toolName = nativeCapletToolName(caplet.server);
  const inputSchema = generatedToolInputJsonSchemaForCaplet(caplet);
  return {
    caplet: caplet.server,
    toolName,
    title: caplet.name,
    description: nativeCapletToolDescription(toolName, caplet),
    ...(caplet.useWhen ? { useWhen: caplet.useWhen } : {}),
    ...(caplet.avoidWhen ? { avoidWhen: caplet.avoidWhen } : {}),
    promptGuidance: nativeCapletPromptGuidance(toolName, caplet),
    inputSchema,
    operationNames: [...inputSchema.properties.operation.enum],
  };
}

function codeModeCapletDescriptor(
  caplet: ReturnType<CapletsEngine["enabledServers"]>[number],
): NativeCapletTool {
  const toolName = nativeCapletToolName(caplet.server);
  return {
    caplet: caplet.server,
    toolName,
    title: caplet.name,
    description: nativeCapletToolDescription(toolName, caplet),
    ...(caplet.useWhen ? { useWhen: caplet.useWhen } : {}),
    ...(caplet.avoidWhen ? { avoidWhen: caplet.avoidWhen } : {}),
    promptGuidance: nativeCapletPromptGuidance(toolName, caplet),
  };
}

function mcpPrimitiveNativeTools(
  caplet: ReturnType<CapletsEngine["enabledServers"]>[number],
  snapshot: ExposureSnapshot | undefined,
): string[] {
  const operations = [];
  if (snapshot?.directResources.some((entry) => entry.caplet.server === caplet.server)) {
    operations.push("list_resources", "read_resource");
  }
  if (snapshot?.directResourceTemplates.some((entry) => entry.caplet.server === caplet.server)) {
    operations.push("list_resource_templates", "read_resource");
  }
  if (snapshot?.directPrompts.some((entry) => entry.caplet.server === caplet.server)) {
    operations.push("list_prompts", "get_prompt", "complete");
  }
  return [...new Set(operations)];
}

function nativeMcpPrimitiveInputSchema(operationName: string): Record<string, unknown> {
  if (operationName === "read_resource") {
    return {
      type: "object",
      properties: { uri: { type: "string" } },
      required: ["uri"],
      additionalProperties: false,
    };
  }
  if (operationName === "get_prompt") {
    return {
      type: "object",
      properties: {
        name: { type: "string" },
        args: { type: "object", additionalProperties: true },
      },
      required: ["name"],
      additionalProperties: false,
    };
  }
  if (operationName === "complete") {
    return {
      type: "object",
      properties: {
        ref: { type: "object", additionalProperties: true },
        argument: { type: "object", additionalProperties: true },
      },
      required: ["ref", "argument"],
      additionalProperties: false,
    };
  }
  return { type: "object", additionalProperties: false };
}

function isMcpPrimitiveRoute(operationName: string): boolean {
  return [
    "list_resources",
    "list_resource_templates",
    "read_resource",
    "list_prompts",
    "get_prompt",
    "complete",
  ].includes(operationName);
}

function nativeMcpPrimitiveRequest(
  operationName: string,
  request: unknown,
): Record<string, unknown> {
  const args = isRecord(request) ? request : {};
  if (operationName === "list_resources") return { operation: "resources" };
  if (operationName === "list_resource_templates") return { operation: "resource_templates" };
  if (operationName === "list_prompts") return { operation: "prompts" };
  if (operationName === "read_resource") return { operation: "read_resource", uri: args.uri };
  if (operationName === "get_prompt") {
    return { operation: "get_prompt", name: args.name, args: args.args ?? {} };
  }
  if (operationName === "complete") {
    return { operation: "complete", ref: args.ref, argument: args.argument };
  }
  return { operation: operationName };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function codeModeRunNativeTool(capletTools: NativeCapletTool[]): NativeCapletTool {
  const codeModeCaplets = capletTools.map((tool) => ({
    id: tool.caplet,
    name: tool.title,
    description: tool.description,
    ...(tool.useWhen ? { useWhen: tool.useWhen } : {}),
    ...(tool.avoidWhen ? { avoidWhen: tool.avoidWhen } : {}),
  }));
  const declaration = generateCodeModeDeclarations({
    caplets: codeModeCaplets,
  });
  return {
    caplet: nativeCodeModeToolId,
    toolName: nativeCodeModeToolName,
    title: "Code Mode",
    description: [
      generateCodeModeRunToolDescription(declaration),
      "",
      `Native tool name: ${nativeCodeModeToolName}`,
    ].join("\n"),
    codeModeRun: true,
    codeModeCaplets,
    promptGuidance: [
      `Use ${nativeCodeModeToolName} to run Caplets Code Mode TypeScript with generated caplets.<id> handles.`,
      "Prefer Code Mode for multi-step Caplet discovery, tool calls, filtering, joins, and compact synthesis.",
      "Return decision-ready JSON from Code Mode rather than raw bulky provider payloads.",
    ],
    inputSchema: codeModeRunInputJsonSchema(),
  };
}

function codeModeCallableNativeTools(
  tools: NativeCapletTool[],
  options: { fallbackToVisible: boolean },
): NativeCapletTool[] {
  const codeModeCaplets = tools.flatMap((tool) => tool.codeModeCaplets ?? []);
  if (codeModeCaplets.length === 0) {
    return options.fallbackToVisible ? tools.filter((tool) => tool.codeModeRun !== true) : [];
  }
  const byId = new Map(tools.map((tool) => [tool.caplet, tool]));
  return codeModeCaplets.map((caplet) => {
    const tool = byId.get(caplet.id);
    return {
      caplet: caplet.id,
      toolName: tool?.toolName ?? nativeCapletToolName(caplet.id),
      title: caplet.name,
      description: caplet.description,
      ...(caplet.useWhen ? { useWhen: caplet.useWhen } : {}),
      ...(caplet.avoidWhen ? { avoidWhen: caplet.avoidWhen } : {}),
      promptGuidance: tool?.promptGuidance ?? [],
    };
  });
}

async function executeCodeModeRunNative(
  service: NativeCapletsService,
  request: unknown,
): Promise<unknown> {
  const parsed = codeModeRunInputSchema.safeParse(request);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "Code Mode run input is invalid.",
        details: parsed.error.issues,
      },
      diagnostics: [],
      logs: { entries: [], truncated: false, stored: false },
      meta: {
        runId: "",
        traceId: "",
        declarationHash: "",
        durationMs: 0,
        timeoutMs: 0,
        maxTimeoutMs: 0,
      },
    };
  }
  return await runCodeMode({
    code: parsed.data.code,
    service,
    ...(parsed.data.timeoutMs === undefined ? {} : { timeoutMs: parsed.data.timeoutMs }),
    runtimeScope: process.env.CAPLETS_MODE?.trim() || "local",
  });
}

function createDefaultNativeCapletsService(
  options: LocalNativeCapletsServiceOptions,
): NativeCapletsService {
  return new DefaultNativeCapletsService(options);
}

type ResolvedNativeRemoteOptions = Extract<
  Exclude<ReturnType<typeof resolveNativeCapletsServiceOptions>, { mode: "local" }>,
  { remote: unknown }
>["remote"];

function createLocalOverlayService(options: NativeCapletsServiceOptions): NativeCapletsService {
  const localOptions = {
    ...options,
    mode: "local",
    configLoader: createLocalOverlayConfigLoader(options),
  } satisfies LocalNativeCapletsServiceOptions;
  return (options.localServiceFactory ?? createDefaultNativeCapletsService)(localOptions);
}

function createCompositeRemoteService(
  remoteOptions: ResolvedNativeRemoteOptions,
  local: NativeCapletsService,
  options: NativeCapletsServiceOptions,
  authKind: "self_hosted_remote" | "hosted_cloud",
): NativeCapletsService {
  const client = (options.remoteClientFactory ?? createSdkRemoteCapletsClient)(remoteOptions);
  const remote = new RemoteNativeCapletsService({
    client,
    clientFactory: () =>
      (options.remoteClientFactory ?? createSdkRemoteCapletsClient)(remoteOptions),
    pollIntervalMs: remoteOptions.pollIntervalMs,
    authKind,
    ...(options.writeErr ? { writeErr: options.writeErr } : {}),
  });
  const presence = createProjectBindingSessionManager(remoteOptions.cloud, local, options);
  return new CompositeNativeCapletsService(remote, local, options, presence);
}

class CloudNativeCapletsService implements NativeCapletsService {
  private readonly local: NativeCapletsService;
  private readonly listeners = new Set<NativeCapletsToolsChangedListener>();
  private delegate: NativeCapletsService | undefined;
  private unsubscribeDelegate: (() => void) | undefined;
  private closed = false;

  constructor(
    private readonly options: NativeCapletsServiceOptions,
    private readonly baseRemote: ResolvedNativeRemoteOptions,
  ) {
    this.local = createLocalOverlayService(options);
  }

  listTools(): NativeCapletTool[] {
    return this.delegate?.listTools() ?? this.local.listTools();
  }

  async execute(capletId: string, request: unknown): Promise<unknown> {
    return await (this.delegate ?? this.local).execute(capletId, request);
  }

  async reload(): Promise<boolean> {
    if (this.closed) return false;
    if (!this.delegate) {
      try {
        const cloudFetch = this.options.remote?.fetch ?? this.options.server?.fetch;
        const remoteUrl =
          this.options.server?.url ?? this.baseRemote.url.toString().replace(/\/mcp$/u, "");
        const selection = await resolveRemoteSelection(
          {
            mode: "cloud",
            remoteUrl,
            ...(cloudFetch ? { fetch: cloudFetch } : {}),
          },
          {
            ...process.env,
            CAPLETS_MODE: "cloud",
            CAPLETS_REMOTE_URL: remoteUrl,
          },
        );
        if (selection.kind !== "hosted_cloud") {
          throw new CapletsError("REQUEST_INVALID", "CAPLETS_MODE=cloud requires Caplets Cloud.");
        }
        const cloudPresence = {
          url: selection.cloudPresence.url,
          accessToken: selection.cloudPresence.accessToken,
          workspaceId: selection.cloudPresence.workspaceId,
          ...(this.options.remote?.cloud?.projectRoot
            ? { projectRoot: this.options.remote.cloud.projectRoot }
            : {}),
          heartbeatIntervalMs:
            this.options.remote?.cloud?.heartbeatIntervalMs ??
            this.baseRemote.cloud?.heartbeatIntervalMs ??
            30_000,
        } satisfies ResolvedNativeCloudPresenceOptions;
        const remoteOptions = {
          ...this.baseRemote,
          url: selection.remote.attachUrl,
          auth: nativeAuthFromRemoteAuth(selection.remote.auth),
          requestInit: selection.remote.requestInit,
          ...(selection.remote.fetch ? { fetch: selection.remote.fetch } : {}),
          cloud: cloudPresence,
        } satisfies ResolvedNativeRemoteOptions;
        this.delegate = createCompositeRemoteService(
          remoteOptions,
          this.local,
          this.options,
          "hosted_cloud",
        );
        this.unsubscribeDelegate = this.delegate.onToolsChanged((tools) => this.emit(tools));
      } catch (error) {
        if (this.options.mode === "cloud") throw error;
        warnRemoteProjectBindingFallback(this.options);
        return await this.local.reload();
      }
    }
    return await this.delegate.reload();
  }

  onToolsChanged(listener: NativeCapletsToolsChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeDelegate?.();
    this.listeners.clear();
    await (this.delegate ? this.delegate.close() : this.local.close());
  }

  private emit(tools: NativeCapletTool[]): void {
    for (const listener of this.listeners) {
      listener(tools);
    }
  }
}

function nativeAuthFromRemoteAuth(auth: CapletsRemoteAuth): NativeRemoteAuthOptions {
  if (auth.type === "basic") {
    return { enabled: true, user: auth.user, password: auth.password };
  }
  if (auth.type === "none") {
    return { enabled: false, user: auth.user };
  }
  return { enabled: false, user: "caplets" };
}

class CompositeNativeCapletsService implements NativeCapletsService {
  private readonly listeners = new Set<NativeCapletsToolsChangedListener>();
  private readonly unsubscribers: Array<() => void>;
  private readonly warnedShadowedLocalCaplets = new Set<string>();
  private tools: NativeCapletTool[] = [];
  private closed = false;
  private batchingReload = false;

  constructor(
    private readonly remote: NativeCapletsService,
    private readonly local: NativeCapletsService,
    private readonly options: NativeCapletsServiceOptions,
    private readonly presence?: ProjectBindingSessionManager,
  ) {
    this.unsubscribers = [
      this.remote.onToolsChanged(() => this.updateMergedTools()),
      this.local.onToolsChanged(() => this.updateMergedTools()),
    ];
    this.tools = this.mergeTools();
    void this.presence?.start().catch((error) => {
      writeErr(
        options,
        `Could not register Caplets Cloud Project Binding: ${errorMessage(error)}\n`,
      );
    });
  }

  listTools(): NativeCapletTool[] {
    return [...this.tools];
  }

  async execute(capletId: string, request: unknown): Promise<unknown> {
    if (capletId === nativeCodeModeToolId) {
      return await executeCodeModeRunNative(this, request);
    }
    const localHasCaplet = this.local.listTools().some((tool) => tool.caplet === capletId);
    const remoteHasCaplet = serviceHasCaplet(this.remote, capletId);
    if (localHasCaplet && !remoteHasCaplet) {
      return await this.local.execute(capletId, request);
    }
    return await this.remote.execute(capletId, request);
  }

  async reload(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    this.batchingReload = true;
    const remoteReloaded = await this.reloadChild(this.remote, "remote");
    const localReloaded = await this.reloadChild(this.local, "local overlay");
    this.batchingReload = false;
    if (remoteReloaded === undefined || localReloaded === undefined) {
      return false;
    }
    if (localReloaded) {
      await this.presence?.updateAllowedCapletIds(
        this.local.listTools().map((tool) => tool.caplet),
      );
    }
    this.updateMergedTools();
    return remoteReloaded || localReloaded;
  }

  onToolsChanged(listener: NativeCapletsToolsChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
    this.listeners.clear();
    await Promise.all([this.remote.close(), this.local.close(), this.presence?.close()]);
  }

  private updateMergedTools(): void {
    if (this.closed || this.batchingReload) {
      return;
    }
    const tools = this.mergeTools();
    if (JSON.stringify(tools) === JSON.stringify(this.tools)) {
      return;
    }
    this.tools = tools;
    for (const listener of this.listeners) {
      try {
        listener(this.listTools());
      } catch (error) {
        writeErr(this.options, `Caplets tools-changed listener failed: ${errorMessage(error)}\n`);
      }
    }
  }

  private mergeTools(): NativeCapletTool[] {
    const allLocalTools = this.local.listTools();
    const allRemoteTools = this.remote.listTools();
    const remoteCodeModeTools = codeModeCallableNativeTools(allRemoteTools, {
      fallbackToVisible: true,
    });
    const remoteIds = new Set(
      [
        ...allRemoteTools
          .filter((tool) => tool.codeModeRun !== true)
          .map((tool) => tool.sourceCaplet ?? tool.caplet),
        ...remoteCodeModeTools.map((tool) => tool.caplet),
      ].filter((caplet) => caplet !== nativeCodeModeToolId),
    );
    const localTools = allLocalTools.filter(
      (tool) => tool.codeModeRun !== true && !remoteIds.has(tool.sourceCaplet ?? tool.caplet),
    );
    this.warnShadowedLocalCaplets(allLocalTools, remoteIds);
    const localCodeModeTools = codeModeCallableNativeTools(allLocalTools, {
      fallbackToVisible: false,
    }).filter((tool) => !remoteIds.has(tool.caplet));
    const remoteTools = allRemoteTools.filter((tool) => tool.codeModeRun !== true);
    const mergedTools = [...remoteTools, ...localTools];
    const codeModeTools = [...remoteCodeModeTools, ...localCodeModeTools];
    return [
      ...mergedTools,
      ...(codeModeTools.length > 0 ? [codeModeRunNativeTool(codeModeTools)] : []),
    ];
  }

  private warnShadowedLocalCaplets(localTools: NativeCapletTool[], remoteIds: Set<string>): void {
    const localIds = new Set([
      ...localTools
        .filter((tool) => tool.codeModeRun !== true)
        .map((tool) => tool.sourceCaplet ?? tool.caplet),
      ...codeModeCallableNativeTools(localTools, { fallbackToVisible: false }).map(
        (tool) => tool.caplet,
      ),
    ]);
    for (const capletId of localIds) {
      if (!remoteIds.has(capletId)) continue;
      if (this.warnedShadowedLocalCaplets.has(capletId)) continue;
      this.warnedShadowedLocalCaplets.add(capletId);
      writeErr(
        this.options,
        `Local Caplet '${capletId}' is suppressed because the remote attach manifest forbids shadowing that Caplet ID.\n`,
      );
    }
  }

  private async reloadChild(
    service: NativeCapletsService,
    label: string,
  ): Promise<boolean | undefined> {
    try {
      return await service.reload();
    } catch (error) {
      writeErr(
        this.options,
        `Could not reload composite Caplets tools from ${label}: ${errorMessage(error)}\n`,
      );
      return undefined;
    }
  }
}

function serviceHasCaplet(service: NativeCapletsService, capletId: string): boolean {
  return service.listTools().some((tool) => {
    if (tool.codeModeRun) {
      return tool.codeModeCaplets?.some((caplet) => caplet.id === capletId) ?? false;
    }
    return tool.caplet === capletId;
  });
}

function createProjectBindingSessionManager(
  cloud: ResolvedNativeRemoteOptions["cloud"],
  local: NativeCapletsService,
  options: NativeCapletsServiceOptions,
): ProjectBindingSessionManager | undefined {
  if (!cloud) {
    return undefined;
  }
  const projectRoot = cloud.projectRoot ?? findProjectRoot();
  const cloudFetch = options.remote?.fetch ?? options.server?.fetch;
  const clientOptions = {
    baseUrl: cloud.url,
    accessToken: cloud.accessToken,
    ...(cloudFetch ? { fetch: cloudFetch } : {}),
  };
  return new ProjectBindingSessionManager({
    client: new CapletsCloudClient(clientOptions),
    workspaceId: cloud.workspaceId,
    projectRoot,
    projectFingerprint: fingerprintProjectRoot(projectRoot),
    projectFiles: projectSyncFiles(projectRoot),
    allowedCapletIds: local.listTools().map((tool) => tool.caplet),
    heartbeatIntervalMs: cloud.heartbeatIntervalMs,
    onError: (error) => {
      writeErr(options, `Caplets Cloud Project Binding heartbeat failed: ${errorMessage(error)}\n`);
    },
  });
}

function createLocalOverlayConfigLoader(options: NativeCapletsServiceOptions) {
  let hasLoaded = false;
  let previousWarnings = new Set<string>();
  return (configPath: string, projectConfigPath: string): CapletsConfig => {
    let result: LocalOverlayConfigWithSources;
    try {
      result = loadLocalOverlayConfigWithSources(configPath, projectConfigPath);
    } catch (error) {
      writeErr(
        options,
        `Caplets local overlay warning: Could not load local overlay config: ${errorMessage(error)}\n`,
      );
      if (hasLoaded) {
        throw new CapletsError(
          "CONFIG_INVALID",
          "Caplets local overlay reload failed; keeping last known-good config.",
          error,
        );
      }
      hasLoaded = true;
      return parseConfig({});
    }
    for (const warning of result.warnings) {
      const path = typeof warning.path === "string" ? ` at ${warning.path}` : "";
      writeErr(options, `Caplets local overlay warning${path}: ${warning.message}\n`);
    }
    const warnings = new Set(result.warnings.map(warningKey));
    if (hasLoaded && [...warnings].some((warning) => !previousWarnings.has(warning))) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Caplets local overlay reload produced new warnings; keeping last known-good config.",
      );
    }
    previousWarnings = warnings;
    hasLoaded = true;
    return result.config;
  };
}

function warningKey(warning: { kind: string; path: string; message: string }): string {
  return `${warning.kind}\0${warning.path}\0${warning.message}`;
}

function writeErr(options: NativeCapletsServiceOptions, message: string): void {
  options.writeErr?.(message);
}

function warnRemoteProjectBindingFallback(options: NativeCapletsServiceOptions): void {
  if (hasWarnedRemoteProjectBindingFallback) {
    return;
  }
  hasWarnedRemoteProjectBindingFallback = true;
  writeErr(options, REMOTE_PROJECT_BINDING_FALLBACK_WARNING);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
