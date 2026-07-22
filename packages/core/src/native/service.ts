import { fingerprintProjectRoot } from "@caplets/sdk/project-binding/node";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { isLoopbackCurrentHostHostname } from "../current-host/origin";
import {
  resolveNativeCapletsServiceOptions,
  type NativeCapletsServiceResolutionInput,
  type NativeRemoteAuthOptions,
  type ResolvedNativeRemoteOptions,
} from "./options";
import {
  NativeProjectBindingLifecycle,
  type ProjectBindingLifecycle,
  type ProjectBindingSessionAdapter,
} from "../project-binding/lifecycle";
import {
  createSdkRemoteCapletsClient,
  RemoteNativeCapletsService,
  type RemoteCapletsClient,
  type SdkRemoteCapletsClientOptions,
} from "./remote";
import { CapletsEngine, type ResolvedExposureProjection } from "../engine";
import { CapletsError, errorResult } from "../errors";
import type {
  RuntimeMode,
  TelemetryDebugSink,
  TelemetryDispatcher,
  TelemetrySurface,
  TelemetryVisibility,
} from "../telemetry";
import {
  captureRuntimeReliabilityEvent,
  captureRuntimeTelemetryEvent,
  createRuntimeTelemetryContext,
  runtimeFailureTelemetryProperties,
  toolActivationProperties,
  type RuntimeTelemetryContext,
} from "../telemetry";
import {
  nativeCapletToolName,
  nativeCodeModePromptGuidance,
  nativeCodeModeToolId,
  nativeCodeModeToolName,
} from "./tools";
import { nativeDirectToolName } from "../exposure/direct-names";
import { completionContextJsonSchema } from "../generated-tool-input-schema";
import type { NamespaceDiagnostic } from "../exposure/namespace";
import {
  resolveNativeProjectionMerge,
  type ExposureProjection,
  type ExposureProjectionCodeModeCaplet,
  type ExposureProjectionProgressiveCaplet,
} from "../exposure/projection";
import {
  generateCodeModeDeclarations,
  generateCodeModeRunToolDescription,
} from "../code-mode/declarations";
import type { ProjectBindingExecutionContext } from "../project-binding/execution-context";
import { runCodeMode } from "../code-mode/runner";
import {
  isUnsupportedRemoteProjectBinding,
  RemoteProjectBindingSessionManager,
} from "../project-binding/session";
import { CodeModeSessionManager } from "../code-mode/sessions";
import { CodeModeJournalStore } from "../code-mode/journal";
import {
  codeModeRunInputJsonSchema,
  codeModeRunInputSchema,
  emptyCodeModeRunMeta,
} from "../code-mode/tool";
import type { CodeModeCallableCaplet } from "../code-mode/types";
import {
  loadLocalOverlayConfigWithSources,
  parseConfig,
  type CapletShadowingPolicy,
  type CapletsConfig,
  type LocalOverlayConfigWithSources,
  type NamespaceAliasesConfig,
  resolveConfigPath,
  resolveProjectConfigPath,
} from "../config";
import type { CapletsRemoteAuth } from "../remote/options";
import { resolveRemoteSelection, type ResolvedRemoteSelection } from "../remote/selection";

const REMOTE_PROJECT_BINDING_FALLBACK_WARNING =
  "Remote project binding unavailable; using local Caplets only. Run caplets doctor for details.\n";
let hasWarnedRemoteProjectBindingFallback = false;

export type NativeCapletsServiceOptions = NativeCapletsServiceResolutionInput & {
  configPath?: string;
  projectRoot?: string;
  projectConfigPath?: string;
  authDir?: string;
  exposeLocalArtifactPaths?: boolean;
  watchDebounceMs?: number;
  watch?: boolean;
  writeErr?: (value: string) => void;
  remoteClientFactory?: (options: ResolvedNativeRemoteOptions) => RemoteCapletsClient;
  localServiceFactory?: (options: LocalNativeCapletsServiceOptions) => NativeCapletsService;
  telemetryStateDir?: string | undefined;
  telemetryEnv?: NodeJS.ProcessEnv | undefined;
  telemetrySurface?: TelemetrySurface | undefined;
  telemetryVisibility?: TelemetryVisibility | undefined;
  telemetryRuntimeMode?: RuntimeMode | undefined;
  telemetryIntegration?: "opencode" | "pi" | "native" | "unknown" | undefined;
  telemetryDebugSink?: TelemetryDebugSink | undefined;
  telemetryDispatcher?: TelemetryDispatcher | undefined;
};

export type NativeCapletTool = {
  caplet: string;
  sourceCaplet?: string;
  shadowing?: CapletShadowingPolicy;
  toolName: string;
  title: string;
  description: string;
  codeModeRun?: boolean;
  useWhen?: string;
  avoidWhen?: string;
  promptGuidance: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  operationNames?: string[];
  codeModeCaplets?: CodeModeCallableCaplet[];
};

export type NativeCapletsToolsChangedListener = (tools: NativeCapletTool[]) => void;

export type NativeCapletsService = {
  listTools(): NativeCapletTool[];
  execute(capletId: string, request: unknown): Promise<unknown>;
  captureCodeModeOutcome?(
    envelope: unknown,
    options: { started: number; timeoutMs?: number | undefined },
  ): Promise<void>;
  codeModeService?(): NativeCapletsService;
  reload(): Promise<boolean>;
  onToolsChanged(listener: NativeCapletsToolsChangedListener): () => void;
  close(): Promise<void>;
};

export function createNativeCapletsService(
  options: NativeCapletsServiceOptions = {},
): NativeCapletsService {
  const resolved = resolveNativeCapletsServiceOptions(options);
  if (resolved.mode === "remote") {
    if (options.remoteClientFactory) {
      const local = createLocalOverlayService(options);
      try {
        return createCompositeRemoteService(resolved.remote, local, options);
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
    return new ProfileBackedNativeCapletsService(options, resolved.remote);
  }
  if (resolved.mode === "daemon") {
    const remote = new RemoteNativeCapletsService({
      client: createRemoteClient(resolved.remote, options),
      clientFactory: () => createRemoteClient(resolved.remote, options),
      pollIntervalMs: resolved.remote.pollIntervalMs,
      ...(options.writeErr ? { writeErr: options.writeErr } : {}),
    });
    return remote;
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
  private directToolRoutes = new Map<
    string,
    { capletId: string; operationName: string; generation: number }
  >();
  private capletRoutes = new Map<string, { capletId: string; generation: number }>();
  private resolvedProjection: ResolvedExposureProjection | undefined;
  private readonly codeModeSessions = new CodeModeSessionManager();
  private postReloadRefresh: Promise<void> | undefined;
  private exposureRefreshSequence = 0;

  constructor(options: LocalNativeCapletsServiceOptions) {
    this.writeErr = options.writeErr ?? (() => undefined);
    this.engine = new CapletsEngine({
      ...options,
      writeErr: this.writeErr,
      projectBindingContext: projectBindingContextForNativeOptions(options),
      telemetrySurface: options.telemetrySurface ?? "native",
      telemetryVisibility: options.telemetryVisibility ?? "hidden",
      telemetryRuntimeMode: options.telemetryRuntimeMode ?? runtimeModeFromNativeOptions(options),
      telemetryIntegration: options.telemetryIntegration ?? "native",
    });
    this.postReloadRefresh = this.refreshExposureProjection({ emitToolsChanged: true });
    this.unsubscribeEngineReload = this.engine.onReload(() => {
      this.postReloadRefresh = this.refreshExposureProjection({ emitToolsChanged: true });
    });
  }

  listTools(): NativeCapletTool[] {
    this.directToolRoutes = new Map();
    this.capletRoutes = new Map();
    const resolved = this.resolvedProjection;
    if (!resolved || resolved.generation !== this.engine.currentExposureGeneration()) return [];
    return this.projectedNativeTools(resolved.projection, resolved.generation);
  }

  private projectedNativeTools(
    projection: ExposureProjection,
    generation: number,
  ): NativeCapletTool[] {
    const progressiveTools: NativeCapletTool[] = [];
    const directTools: NativeCapletTool[] = [];
    const codeModeCaplets: NativeCapletTool[] = [];
    const primitiveCapletIds = new Set<string>();

    for (const entry of projection.entries) {
      if (entry.kind === "progressive-caplet") {
        progressiveTools.push(progressiveNativeTool(entry));
        this.capletRoutes.set(entry.id, { capletId: entry.route.capletId, generation });
      }
      if (entry.kind === "code-mode-caplet") {
        codeModeCaplets.push(codeModeCapletDescriptor(entry));
      }
      if (entry.kind === "direct-tool") {
        const inputSchema = asRecord(entry.inputSchema);
        const outputSchema = asRecord(entry.outputSchema);
        const annotations = asRecord(entry.annotations);
        directTools.push(
          this.directNativeTool(entry.route.capletId, entry.route.downstreamName, generation, {
            visibleId: entry.id,
            ...(entry.title ? { title: entry.title } : {}),
            ...(entry.description ? { description: entry.description } : {}),
            ...(inputSchema ? { inputSchema } : {}),
            ...(outputSchema ? { outputSchema } : {}),
            ...(annotations ? { annotations } : {}),
            ...(entry.useWhen ? { useWhen: entry.useWhen } : {}),
            ...(entry.avoidWhen ? { avoidWhen: entry.avoidWhen } : {}),
            shadowing: entry.shadowing,
          }),
        );
      }
      if (
        entry.kind === "direct-resource" ||
        entry.kind === "direct-resource-template" ||
        entry.kind === "direct-prompt" ||
        entry.kind === "completion"
      ) {
        primitiveCapletIds.add(entry.capletId);
      }
    }

    for (const capletId of [...primitiveCapletIds].sort()) {
      const metadata = nativeProjectionMetadata(capletId, projection);
      directTools.push(
        ...mcpPrimitiveNativeTools(capletId, projection).map((operationName) =>
          this.directNativeTool(capletId, operationName, generation, {
            description: `MCP ${operationName.replace(/_/g, " ")}.`,
            inputSchema: nativeMcpPrimitiveInputSchema(operationName),
            ...metadata,
          }),
        ),
      );
    }

    return [
      ...progressiveTools,
      ...directTools,
      ...(codeModeCaplets.length > 0 ? [codeModeRunNativeTool(codeModeCaplets)] : []),
    ];
  }

  async execute(capletId: string, request: unknown): Promise<unknown> {
    this.assertResolvedProjection();
    if (capletId === nativeCodeModeToolId) {
      if (this.codeModeNativeTools().length === 0) {
        throw new CapletsError("REQUEST_INVALID", "Code Mode has no callable Caplets.");
      }
      const started = Date.now();
      const envelope = await executeCodeModeRunNative(
        this.codeModeDelegate(),
        request,
        this.codeModeSessions,
      );
      const parsed = codeModeRunInputSchema.safeParse(request);
      void this.engine
        .captureCodeModeOutcome(envelope, {
          started,
          ...(parsed.success && parsed.data.timeoutMs !== undefined
            ? { timeoutMs: parsed.data.timeoutMs }
            : {}),
        })
        .catch(() => undefined);
      return envelope;
    }
    const capletRoute = this.capletRoutes.get(capletId);
    if (capletRoute) {
      this.assertRouteGeneration(capletRoute.generation);
      return await this.engine.execute(capletRoute.capletId, request);
    }
    const route = this.directToolRoutes.get(capletId);
    if (route) {
      this.assertRouteGeneration(route.generation);
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
    return errorResult(new Error(`server not found: ${capletId}`));
  }

  async captureCodeModeOutcome(
    envelope: unknown,
    options: { started: number; timeoutMs?: number | undefined },
  ): Promise<void> {
    await this.engine.captureCodeModeOutcome(envelope, options);
  }

  codeModeService(): NativeCapletsService {
    return this.codeModeDelegate();
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
    this.codeModeSessions.close();
    this.toolListeners.clear();
    await this.engine.close();
  }

  private directNativeTool(
    capletId: string,
    operationName: string,
    generation: number,
    options: {
      visibleId?: string;
      title?: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
      annotations?: Record<string, unknown>;
      useWhen?: string;
      avoidWhen?: string;
      shadowing?: CapletShadowingPolicy;
    },
  ): NativeCapletTool {
    const routeId = options.visibleId ?? `${capletId}__${operationName}`;
    const toolName = nativeDirectToolName(capletId, operationName);
    this.directToolRoutes.set(routeId, { capletId, operationName, generation });
    return {
      caplet: routeId,
      sourceCaplet: capletId,
      toolName,
      title: options.title ?? operationName,
      description: options.description ?? "",
      promptGuidance: [`Use ${toolName} for ${capletId} ${operationName}.`],
      ...(options.inputSchema ? { inputSchema: options.inputSchema } : {}),
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
      ...(options.annotations ? { annotations: options.annotations } : {}),
      ...(options.useWhen ? { useWhen: options.useWhen } : {}),
      ...(options.avoidWhen ? { avoidWhen: options.avoidWhen } : {}),
      shadowing: options.shadowing ?? "forbid",
    };
  }

  private async refreshExposureProjection(options: { emitToolsChanged: boolean }): Promise<void> {
    const sequence = ++this.exposureRefreshSequence;
    try {
      const resolved = await this.engine.exposureProjection({
        discoverNonDirectMcpSurfaces: false,
      });
      if (
        sequence !== this.exposureRefreshSequence ||
        resolved.generation !== this.engine.currentExposureGeneration()
      ) {
        return;
      }
      this.resolvedProjection = resolved;
      if (options.emitToolsChanged) this.emitToolsChanged();
    } catch (error) {
      if (sequence !== this.exposureRefreshSequence) return;
      this.writeErr(`Caplets native tool reload failed.\n`);
      this.writeErr(`${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  private assertResolvedProjection(): ResolvedExposureProjection {
    const resolved = this.resolvedProjection;
    if (resolved && resolved.generation === this.engine.currentExposureGeneration()) {
      return resolved;
    }
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Caplets exposure is unavailable until the current projection resolves.",
    );
  }

  private assertRouteGeneration(generation: number): void {
    const resolved = this.assertResolvedProjection();
    if (resolved.generation === generation) return;
    throw new CapletsError("SERVER_UNAVAILABLE", "Caplets exposure route is stale.");
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
      execute: async (capletId, request) => await this.executeCodeModeCaplet(capletId, request),
      reload: async () => await this.reload(),
      onToolsChanged: () => () => undefined,
      close: async () => undefined,
    };
  }

  private codeModeNativeTools(): NativeCapletTool[] {
    const resolved = this.resolvedProjection;
    if (!resolved || resolved.generation !== this.engine.currentExposureGeneration()) return [];
    return resolved.projection.entries
      .filter(
        (entry): entry is ExposureProjectionCodeModeCaplet => entry.kind === "code-mode-caplet",
      )
      .map(codeModeCapletDescriptor);
  }

  private async executeCodeModeCaplet(capletId: string, request: unknown): Promise<unknown> {
    const caplets = this.codeModeNativeTools();
    if (!caplets.some((caplet) => caplet.caplet === capletId)) {
      throw new CapletsError("REQUEST_INVALID", `Caplet ${capletId} is not callable in Code Mode.`);
    }
    return await this.engine.execute(capletId, request);
  }
}

function progressiveNativeTool(entry: ExposureProjectionProgressiveCaplet): NativeCapletTool {
  const toolName = nativeCapletToolName(entry.id);
  const inputSchema = asRecord(entry.inputSchema);
  return {
    caplet: entry.id,
    ...(entry.sourceCapletId ? { sourceCaplet: entry.sourceCapletId } : {}),
    toolName,
    title: entry.title ?? entry.id,
    description: projectionNativeDescription(toolName, entry),
    promptGuidance: projectionNativePromptGuidance(toolName, entry),
    ...(inputSchema ? { inputSchema } : {}),
    ...(entry.operationNames ? { operationNames: [...entry.operationNames] } : {}),
    shadowing: entry.shadowing,
  };
}

function codeModeCapletDescriptor(entry: ExposureProjectionCodeModeCaplet): NativeCapletTool {
  const toolName = nativeCapletToolName(entry.id);
  return {
    caplet: entry.id,
    ...(entry.sourceCapletId ? { sourceCaplet: entry.sourceCapletId } : {}),
    toolName,
    title: entry.title ?? entry.id,
    description: projectionNativeDescription(toolName, entry),
    promptGuidance: projectionNativePromptGuidance(toolName, entry),
    shadowing: entry.shadowing,
  };
}

function projectionNativeDescription(
  toolName: string,
  entry: ExposureProjectionProgressiveCaplet | ExposureProjectionCodeModeCaplet,
): string {
  return [
    entry.description ?? "",
    "Use tools/search_tools to find downstream names, arg hints, and callTemplate. Call call_tool directly from callTemplate/argsTemplate for simple calls; reserve describe_tool for exact schemas, nested args, fields, or uncertainty. call_tool.args must match inputSchema exactly. Do not guess tool names or schemas. Prefer read/search/list tools for triage.",
    "",
    `Native tool name: ${toolName}`,
    `Original Caplet ID: ${entry.id}`,
  ].join("\n");
}

function projectionNativePromptGuidance(
  toolName: string,
  entry: ExposureProjectionProgressiveCaplet | ExposureProjectionCodeModeCaplet,
): string[] {
  const descriptorFirst =
    "Use tools/search_tools callTemplate/arg hints for simple calls; reserve describe_tool for exact schemas, nested args, fields, or uncertainty. call_tool.args must match inputSchema exactly. Do not guess tool names or schemas.";
  return entry.backend === "mcp"
    ? [
        `Use ${toolName} for the ${entry.title ?? entry.id} Caplet capability domain.`,
        "Prefer resources for readable context, prompts for reusable workflows, and tools for actions.",
        descriptorFirst,
      ]
    : [
        `Use ${toolName} for the ${entry.title ?? entry.id} Caplet capability domain.`,
        descriptorFirst,
      ];
}

function nativeProjectionMetadata(
  capletId: string,
  projection: ExposureProjection,
): {
  shadowing: CapletShadowingPolicy;
} {
  const entries = projection.entries.filter((entry) => entry.capletId === capletId);
  const shadowing = entries.some((entry) => entry.shadowing === "forbid")
    ? "forbid"
    : entries.some((entry) => entry.shadowing === "namespace")
      ? "namespace"
      : "allow";
  return {
    shadowing,
  };
}

function mcpPrimitiveNativeTools(capletId: string, projection: ExposureProjection): string[] {
  const kinds = new Set(
    projection.entries.filter((entry) => entry.capletId === capletId).map((entry) => entry.kind),
  );
  const operations: string[] = [];
  if (kinds.has("direct-resource")) operations.push("list_resources", "read_resource");
  if (kinds.has("direct-resource-template")) {
    operations.push("list_resource_templates", "read_resource");
  }
  if (kinds.has("direct-prompt")) operations.push("list_prompts", "get_prompt");
  if (kinds.has("completion")) operations.push("complete");
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
        context: completionContextJsonSchema,
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
    return {
      operation: "complete",
      ref: args.ref,
      argument: args.argument,
      ...(args.context ? { context: args.context } : {}),
    };
  }
  return { operation: operationName };
}

function operationFromNativeRequest(request: unknown): unknown {
  return isRecord(request) ? request.operation : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function runtimeModeFromNativeOptions(options: NativeCapletsServiceOptions) {
  if (options.mode === "local") return "local";
  if (options.mode === "remote") return "remote";
  if (options.mode === "daemon") return "remote";
  if (options.remote?.url) return "remote";
  const envMode = options.telemetryEnv?.CAPLETS_MODE ?? process.env.CAPLETS_MODE;
  if (envMode === "remote" || envMode === "local") return envMode;
  return "local";
}

function telemetryConfigFromNativeOptions(options: NativeCapletsServiceOptions): CapletsConfig {
  const configPath = resolveConfigPath(options.configPath);
  const config = createLocalOverlayConfigLoader(options)(
    configPath,
    options.projectConfigPath ?? resolveProjectConfigPath(),
  );
  const explicitTelemetry = readTelemetryOnlyConfig(configPath);
  return explicitTelemetry === undefined ? config : { ...config, telemetry: explicitTelemetry };
}

function readTelemetryOnlyConfig(path: string): boolean | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? typeof (parsed as Record<string, unknown>).telemetry === "boolean"
        ? ((parsed as Record<string, unknown>).telemetry as boolean)
        : undefined
      : undefined;
  } catch {
    return undefined;
  }
}

function codeModeRunNativeTool(capletTools: NativeCapletTool[]): NativeCapletTool {
  const codeModeCaplets = capletTools.map((tool) => ({
    id: tool.caplet,
    ...(tool.sourceCaplet ? { sourceCapletId: tool.sourceCaplet } : {}),
    name: tool.title,
    description: tool.description,
    ...(tool.shadowing ? { shadowing: tool.shadowing } : {}),
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
    promptGuidance: nativeCodeModePromptGuidance(),
    inputSchema: codeModeRunInputJsonSchema(),
  };
}

function codeModeCallableNativeTools(
  tools: NativeCapletTool[],
  options: { fallbackToVisible: boolean },
): NativeCapletTool[] {
  const codeModeCaplets = tools.flatMap((tool) => tool.codeModeCaplets ?? []);
  const hasExplicitCodeModeManifest = tools.some((tool) => tool.codeModeCaplets !== undefined);
  if (codeModeCaplets.length === 0) {
    return options.fallbackToVisible && !hasExplicitCodeModeManifest
      ? tools.filter((tool) => tool.codeModeRun !== true)
      : [];
  }
  const byId = new Map(tools.map((tool) => [tool.caplet, tool]));
  return codeModeCaplets.map((caplet) => {
    const tool = byId.get(caplet.id);
    return {
      caplet: caplet.id,
      ...(caplet.sourceCapletId && caplet.sourceCapletId !== caplet.id
        ? { sourceCaplet: caplet.sourceCapletId }
        : {}),
      toolName: tool?.toolName ?? nativeCapletToolName(caplet.id),
      title: caplet.name,
      description: caplet.description,
      ...(caplet.shadowing ? { shadowing: caplet.shadowing } : {}),
      promptGuidance: tool?.promptGuidance ?? [],
    };
  });
}

async function executeCodeModeRunNative(
  service: NativeCapletsService,
  request: unknown,
  sessionManager?: CodeModeSessionManager,
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
      meta: emptyCodeModeRunMeta(),
    };
  }
  const runtimeScopeInput = process.env.CAPLETS_MODE?.trim();
  const runtimeScope =
    runtimeScopeInput === "remote" || runtimeScopeInput === "daemon" ? runtimeScopeInput : "local";
  return await runCodeMode({
    code: parsed.data.code,
    service,
    ...(parsed.data.timeoutMs === undefined ? {} : { timeoutMs: parsed.data.timeoutMs }),
    ...(parsed.data.sessionId === undefined ? {} : { sessionId: parsed.data.sessionId }),
    runtimeScope,
    journalStore: new CodeModeJournalStore(),
    ...(sessionManager === undefined ? {} : { sessionManager }),
  });
}

function createDefaultNativeCapletsService(
  options: LocalNativeCapletsServiceOptions,
): NativeCapletsService {
  return new DefaultNativeCapletsService(options);
}

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
): NativeCapletsService {
  const { remote, projectBinding } = createCompositeRemoteParts(remoteOptions, options);
  return new CompositeNativeCapletsService(
    remote,
    local,
    options,
    remoteOptions.origin.origin,
    projectBinding,
  );
}

function createCompositeRemoteParts(
  remoteOptions: ResolvedNativeRemoteOptions,
  options: NativeCapletsServiceOptions,
  resolveRuntimeRemoteOptions?: () => Promise<ResolvedNativeRemoteOptions>,
): { remote: NativeCapletsService; projectBinding?: ProjectBindingSessionAdapter } {
  const client = createRemoteClient(remoteOptions, options, resolveRuntimeRemoteOptions);
  const remote = new RemoteNativeCapletsService({
    client,
    clientFactory: () => createRemoteClient(remoteOptions, options, resolveRuntimeRemoteOptions),
    pollIntervalMs: remoteOptions.pollIntervalMs,
    ...(options.writeErr ? { writeErr: options.writeErr } : {}),
  });
  const projectBinding = createProjectBindingSessionManager(remoteOptions, options);
  return { remote, ...(projectBinding ? { projectBinding } : {}) };
}

function createRemoteClient(
  remoteOptions: ResolvedNativeRemoteOptions,
  options: NativeCapletsServiceOptions,
  resolveRuntimeRemoteOptions?: () => Promise<ResolvedNativeRemoteOptions>,
): RemoteCapletsClient {
  if (options.remoteClientFactory) {
    return options.remoteClientFactory(remoteOptions);
  }
  const attachSessionMetadata = isLoopbackRemote(remoteOptions)
    ? attachSessionMetadataForOptions(options)
    : undefined;
  const sdkOptions: SdkRemoteCapletsClientOptions = {
    ...remoteOptions,
    ...(options.writeErr ? { writeErr: options.writeErr } : {}),
    ...(attachSessionMetadata ? { attachSessionMetadata } : {}),
    ...(resolveRuntimeRemoteOptions ? { resolveRuntimeOptions: resolveRuntimeRemoteOptions } : {}),
  };
  return createSdkRemoteCapletsClient(sdkOptions);
}

function attachSessionMetadataForOptions(
  options: NativeCapletsServiceOptions,
): SdkRemoteCapletsClientOptions["attachSessionMetadata"] {
  if (!options.projectRoot) return undefined;
  const projectRoot = canonicalProjectRootForMetadata(options.projectRoot);
  return {
    projectRoot,
    projectConfigPath: resolvePath(projectRoot, ".caplets", "config.json"),
  };
}

function canonicalProjectRootForMetadata(projectRoot: string): string {
  try {
    return realpathSync(projectRoot);
  } catch {
    return projectRoot;
  }
}

function projectBindingContextForNativeOptions(
  options: NativeCapletsServiceOptions,
): ProjectBindingExecutionContext | undefined {
  if (!options.projectRoot) return undefined;
  const projectRoot = canonicalProjectRootForMetadata(options.projectRoot);
  return {
    projectRoot,
    projectFingerprint: fingerprintProjectRoot(projectRoot),
    projectConfigPath:
      options.projectConfigPath ?? resolvePath(projectRoot, ".caplets", "config.json"),
    sessionId: "native-local",
    bindingId: "native-local",
  };
}

function isLoopbackRemote(remoteOptions: ResolvedNativeRemoteOptions): boolean {
  return (
    remoteOptions.origin.protocol === "http:" &&
    isLoopbackCurrentHostHostname(remoteOptions.origin.hostname)
  );
}

class ProfileBackedNativeCapletsService implements NativeCapletsService {
  private readonly local: NativeCapletsService;
  private readonly listeners = new Set<NativeCapletsToolsChangedListener>();
  private delegate: CompositeNativeCapletsService | undefined;
  private unsubscribeDelegate: (() => void) | undefined;
  private remoteSignature: string | undefined;
  private credentialExpiresAt: string | undefined;
  private ensureDelegateCurrentInFlight: Promise<void> | undefined;
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
    if (!this.delegate || nativeCredentialsNeedRefresh(this.credentialExpiresAt)) {
      await this.ensureDelegateCurrent();
    }
    return await (this.delegate ?? this.local).execute(capletId, request);
  }

  codeModeService(): NativeCapletsService {
    return (this.delegate ?? this.local).codeModeService?.() ?? this.delegate ?? this.local;
  }

  async reload(): Promise<boolean> {
    if (this.closed) return false;
    await this.ensureDelegateCurrent();
    return await (this.delegate ?? this.local).reload();
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

  private async ensureDelegateCurrent(): Promise<void> {
    if (this.ensureDelegateCurrentInFlight) {
      await this.ensureDelegateCurrentInFlight;
      return;
    }
    const refresh = this.ensureDelegateCurrentNow();
    this.ensureDelegateCurrentInFlight = refresh;
    try {
      await refresh;
    } finally {
      if (this.ensureDelegateCurrentInFlight === refresh) {
        this.ensureDelegateCurrentInFlight = undefined;
      }
    }
  }

  private async ensureDelegateCurrentNow(): Promise<void> {
    try {
      const remoteOptions = await this.resolveProfileRemoteOptions();
      if (this.closed) return;
      const signature = remoteOptionsSignature(remoteOptions);
      if (!this.delegate) {
        const { remote, projectBinding } = createCompositeRemoteParts(
          remoteOptions,
          this.options,
          () => this.resolveProfileRemoteOptions(),
        );
        this.delegate = new CompositeNativeCapletsService(
          remote,
          this.local,
          this.options,
          remoteOptions.origin.origin,
          projectBinding,
        );
        this.unsubscribeDelegate = this.delegate.onToolsChanged((tools) => this.emit(tools));
        this.remoteSignature = signature;
        this.credentialExpiresAt = remoteOptions.credentialExpiresAt;
        return;
      }
      if (signature === this.remoteSignature) return;
      const { remote, projectBinding } = createCompositeRemoteParts(
        remoteOptions,
        this.options,
        () => this.resolveProfileRemoteOptions(),
      );
      if (!(await remote.reload())) {
        projectBinding?.dispose?.();
        await remote.close();
        return;
      }
      const bindingReady = await this.delegate.replaceRemote(
        remote,
        remoteOptions.origin.origin,
        projectBinding,
      );
      if (!bindingReady) return;
      this.remoteSignature = signature;
      this.credentialExpiresAt = remoteOptions.credentialExpiresAt;
    } catch (error) {
      if (this.options.mode === "remote") {
        if (this.delegate) throw error;
        await this.close().catch((closeError: unknown) => {
          writeErr(
            this.options,
            `Could not close local overlay Caplets service: ${errorMessage(closeError)}\n`,
          );
        });
        throw error;
      }
      warnRemoteProjectBindingFallback(this.options);
      if (!this.delegate) await this.local.reload();
    }
  }

  private async resolveProfileRemoteOptions(): Promise<ProfileResolvedNativeRemoteOptions> {
    const remoteFetch = this.options.remote?.fetch;
    const remoteUrl =
      this.options.remote?.url ?? process.env.CAPLETS_REMOTE_URL ?? this.baseRemote.origin.origin;
    const selection = await resolveRemoteSelection(
      {
        mode: "remote",
        remoteUrl,
        ...(this.options.authDir ? { authDir: this.options.authDir } : {}),
        ...(remoteFetch ? { fetch: remoteFetch } : {}),
      },
      {
        ...process.env,
        CAPLETS_MODE: "remote",
        CAPLETS_REMOTE_URL: remoteUrl,
      },
    );
    return remoteOptionsFromSelection(selection, this.baseRemote);
  }
}

type ProfileResolvedNativeRemoteOptions = ResolvedNativeRemoteOptions & {
  credentialExpiresAt?: string | undefined;
};

function remoteOptionsFromSelection(
  selection: ResolvedRemoteSelection,
  baseRemote: ResolvedNativeRemoteOptions,
): ProfileResolvedNativeRemoteOptions {
  return {
    ...baseRemote,
    origin: selection.remote.baseUrl,
    auth: nativeAuthFromRemoteAuth(selection.remote.auth),
    requestInit: selection.remote.requestInit,
    ...(selection.remote.fetch ? { fetch: selection.remote.fetch } : {}),
    ...("credentialExpiresAt" in selection && selection.credentialExpiresAt
      ? { credentialExpiresAt: selection.credentialExpiresAt }
      : {}),
  };
}

function remoteOptionsSignature(remoteOptions: ProfileResolvedNativeRemoteOptions): string {
  return JSON.stringify({
    origin: remoteOptions.origin.origin,
    requestInit: remoteOptions.requestInit,
    credentialExpiresAt: remoteOptions.credentialExpiresAt,
  });
}

function nativeCredentialsNeedRefresh(expiresAt: string | undefined): boolean {
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed <= Date.now() + 60_000;
}

function nativeAuthFromRemoteAuth(auth: CapletsRemoteAuth): NativeRemoteAuthOptions {
  if (auth.type === "none") {
    return { enabled: false, user: auth.user };
  }
  return { enabled: false, user: "caplets" };
}

class CompositeNativeCapletsService implements NativeCapletsService {
  private readonly listeners = new Set<NativeCapletsToolsChangedListener>();
  private unsubscribeRemote: () => void;
  private readonly unsubscribeLocal: () => void;
  private readonly warnedShadowedLocalCaplets = new Set<string>();
  private tools: NativeCapletTool[] = [];
  private routes = new Map<string, { service: "local" | "remote"; capletId: string }>();
  private namespaceDiagnostics = new Map<string, NamespaceDiagnostic>();
  private closed = false;
  private closing = false;
  private closeInFlight: Promise<void> | undefined;
  private batchingReload = false;
  private readonly codeModeSessions = new CodeModeSessionManager();
  private readonly telemetry: RuntimeTelemetryContext;
  private readonly ownsTelemetryDispatcher: boolean;
  private projectBinding: ProjectBindingLifecycle | undefined;

  constructor(
    private remote: NativeCapletsService,
    private readonly local: NativeCapletsService,
    private readonly options: NativeCapletsServiceOptions,
    private remoteIdentity: string,
    bindingAdapter?: ProjectBindingSessionAdapter,
  ) {
    const initialLocalTools = this.local.listTools();
    if (bindingAdapter) {
      this.projectBinding = new NativeProjectBindingLifecycle(
        bindingAdapter,
        initialLocalTools.map((tool) => tool.caplet),
      );
    }
    this.unsubscribeRemote = this.remote.onToolsChanged(() => this.updateMergedTools());
    this.unsubscribeLocal = this.local.onToolsChanged((tools) => {
      this.acceptLocalTools(tools);
      void this.projectBinding?.start().catch((error) => {
        if (isUnsupportedRemoteProjectBinding(error)) return;
        writeErr(
          this.options,
          `Could not start upstream Project Binding: ${errorMessage(error)}\n`,
        );
      });
      this.updateMergedTools();
    });
    this.ownsTelemetryDispatcher = options.telemetryDispatcher === undefined;
    this.telemetry = createRuntimeTelemetryContext({
      config: telemetryConfigFromNativeOptions(options),
      env: options.telemetryEnv,
      stateDir: options.telemetryStateDir,
      surface: options.telemetrySurface ?? "native",
      visibility: options.telemetryVisibility ?? "hidden",
      runtimeMode: options.telemetryRuntimeMode ?? runtimeModeFromNativeOptions(options),
      integration: options.telemetryIntegration ?? "native",
      debugSink: options.telemetryDebugSink,
      dispatcher: options.telemetryDispatcher,
    });
    const merged = this.mergeTools();
    this.tools = merged.tools;
    this.routes = merged.routes;
    this.namespaceDiagnostics = merged.namespaceDiagnostics;
    if (initialLocalTools.length > 0) {
      void this.projectBinding?.start().catch((error) => {
        if (isUnsupportedRemoteProjectBinding(error)) return;
        writeErr(
          this.options,
          `Could not start upstream Project Binding: ${errorMessage(error)}\n`,
        );
      });
    }
  }

  listTools(): NativeCapletTool[] {
    return [...this.tools];
  }

  async execute(capletId: string, request: unknown): Promise<unknown> {
    if (capletId === nativeCodeModeToolId) {
      return await executeCodeModeRunNative(this, request, this.codeModeSessions);
    }
    const route = this.routes.get(capletId);
    if (route?.service === "local") {
      return await this.local.execute(route.capletId, request);
    }
    if (route?.service === "remote") {
      return await this.executeRemote(route.capletId, request);
    }
    const diagnostic = this.namespaceDiagnostics.get(capletId);
    if (diagnostic) {
      throw new CapletsError("CAPLET_NAMESPACE_COLLISION", diagnostic.hint, diagnostic);
    }
    return await this.executeRemote(capletId, request);
  }

  codeModeService(): NativeCapletsService {
    return {
      listTools: () => codeModeCallableNativeTools(this.listTools(), { fallbackToVisible: false }),
      execute: async (capletId, request) => await this.execute(capletId, request),
      codeModeService: () => this.codeModeService(),
      reload: async () => await this.reload(),
      onToolsChanged: () => () => undefined,
      close: async () => undefined,
    };
  }

  async reload(): Promise<boolean> {
    if (this.closed || this.closing) {
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
      await this.projectBinding?.updateAllowedCapletIds(
        this.local.listTools().map((tool) => tool.caplet),
      );
    }
    this.telemetry.config = telemetryConfigFromNativeOptions(this.options);
    void this.projectBinding?.start().catch((error) => {
      if (isUnsupportedRemoteProjectBinding(error)) return;
      writeErr(this.options, `Could not start upstream Project Binding: ${errorMessage(error)}\n`);
    });
    this.updateMergedTools();
    return remoteReloaded || localReloaded;
  }

  onToolsChanged(listener: NativeCapletsToolsChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closeInFlight) {
      await this.closeInFlight;
      return;
    }

    this.closing = true;
    this.unsubscribeRemote();
    this.unsubscribeLocal();
    this.listeners.clear();
    this.codeModeSessions.close();
    const close = (async () => {
      await this.projectBinding?.close();
      await this.remote.close();
      await this.local.close();
      if (this.ownsTelemetryDispatcher) {
        await this.telemetry.dispatcher.shutdown();
      }
    })();
    this.closeInFlight = close;
    try {
      await close;
      this.closed = true;
    } finally {
      if (this.closeInFlight === close) this.closeInFlight = undefined;
    }
  }

  async replaceRemote(
    remote: NativeCapletsService,
    remoteIdentity: string,
    nextProjectBinding?: ProjectBindingSessionAdapter,
  ): Promise<boolean> {
    if (this.closed || this.closing) {
      nextProjectBinding?.dispose?.();
      await remote.close();
      return false;
    }

    const previousRemote = this.remote;
    const previousUnsubscribe = this.unsubscribeRemote;
    const hadProjectBinding = this.projectBinding !== undefined;
    let previousRemoteClosed = false;
    let terminalRemoteCloseFailure = false;
    let bindingStartError: unknown;
    const closePreviousRemote = async () => {
      try {
        await previousRemote.close();
        previousRemoteClosed = true;
      } catch (error) {
        terminalRemoteCloseFailure = previousRemote instanceof RemoteNativeCapletsService;
        throw error;
      }
    };
    previousUnsubscribe();
    try {
      if (this.projectBinding) {
        await this.projectBinding.replace(nextProjectBinding, closePreviousRemote);
      } else {
        await closePreviousRemote();
        if (this.closed || this.closing) {
          nextProjectBinding?.dispose?.();
          await remote.close();
          return false;
        }
        if (nextProjectBinding) {
          this.projectBinding = new NativeProjectBindingLifecycle(
            nextProjectBinding,
            this.local.listTools().map((tool) => tool.caplet),
          );
        }
      }
    } catch (error) {
      const bindingCleanupFailed = hadProjectBinding && this.projectBinding?.isCleanupFailed();
      if (
        !previousRemoteClosed &&
        !terminalRemoteCloseFailure &&
        (!hadProjectBinding || bindingCleanupFailed)
      ) {
        if (!this.closed && !this.closing) {
          this.unsubscribeRemote = previousRemote.onToolsChanged(() => this.updateMergedTools());
        }
        if (!hadProjectBinding) nextProjectBinding?.dispose?.();
        await remote.close().catch(() => undefined);
        throw error;
      }
      bindingStartError = error;
    }

    if (this.closed || this.closing) {
      await remote.close();
      return false;
    }
    this.remote = remote;
    this.remoteIdentity = remoteIdentity;
    this.unsubscribeRemote = this.remote.onToolsChanged(() => this.updateMergedTools());
    if (bindingStartError) {
      if (!isUnsupportedRemoteProjectBinding(bindingStartError)) {
        writeErr(
          this.options,
          `Could not start upstream Project Binding: ${errorMessage(bindingStartError)}\n`,
        );
      }
    } else {
      void this.projectBinding?.start().catch((error) => {
        if (isUnsupportedRemoteProjectBinding(error)) return;
        writeErr(
          this.options,
          `Could not start upstream Project Binding: ${errorMessage(error)}\n`,
        );
      });
    }
    this.updateMergedTools();
    return bindingStartError === undefined || isUnsupportedRemoteProjectBinding(bindingStartError);
  }

  private updateMergedTools(): void {
    if (this.closed || this.batchingReload) {
      return;
    }
    const merged = this.mergeTools();
    if (JSON.stringify(merged.tools) === JSON.stringify(this.tools)) {
      this.routes = merged.routes;
      this.namespaceDiagnostics = merged.namespaceDiagnostics;
      return;
    }
    this.tools = merged.tools;
    this.routes = merged.routes;
    this.namespaceDiagnostics = merged.namespaceDiagnostics;
    for (const listener of this.listeners) {
      try {
        listener(this.listTools());
      } catch (error) {
        writeErr(this.options, `Caplets tools-changed listener failed: ${errorMessage(error)}\n`);
      }
    }
  }

  private async executeRemote(capletId: string, request: unknown): Promise<unknown> {
    const started = Date.now();
    try {
      const result = await this.remote.execute(capletId, request);
      this.captureRemoteToolActivation(request, result, started);
      return result;
    } catch (error) {
      const result = errorResult(error);
      this.captureRemoteReliabilityError(request, result);
      this.captureRemoteToolActivation(request, result, started);
      throw error;
    }
  }

  private captureRemoteToolActivation(request: unknown, result: unknown, started: number): void {
    void captureRuntimeTelemetryEvent(this.telemetry, "caplets_tool_activation", {
      command_family: "native",
      ...toolActivationProperties({
        config: this.telemetry.config,
        caplet: undefined,
        operation: operationFromNativeRequest(request),
        exposureMode: "direct",
        result,
        durationMs: Date.now() - started,
      }),
    }).catch(() => undefined);
  }

  private captureRemoteReliabilityError(request: unknown, result: unknown): void {
    void captureRuntimeReliabilityEvent(this.telemetry, {
      command_family: "native",
      ...runtimeFailureTelemetryProperties({
        operation: operationFromNativeRequest(request),
        exposureMode: "direct",
        result,
      }),
    }).catch(() => undefined);
  }

  private mergeTools(): {
    tools: NativeCapletTool[];
    routes: Map<string, { service: "local" | "remote"; capletId: string }>;
    namespaceDiagnostics: Map<string, NamespaceDiagnostic>;
  } {
    const localTools = this.local.listTools();
    const remoteTools = this.remote.listTools();
    const resolved = resolveNativeProjectionMerge({
      remoteTools,
      localTools,
      remoteCodeModeTools: remoteCodeModeCallableNativeTools(remoteTools),
      localCodeModeTools: codeModeCallableNativeTools(localTools, { fallbackToVisible: false }),
      remoteIdentity: this.remoteIdentity,
      ...nativeNamespaceContext(this.options),
      renameTool: renameNativeTool,
    });
    this.warnShadowedLocalCaplets(localTools, resolved.suppressedLocalIds);
    const codeModeTools = [...resolved.remoteCodeModeTools, ...resolved.localCodeModeTools];
    return {
      tools: [
        ...resolved.remoteTools,
        ...resolved.localTools,
        ...(codeModeTools.length > 0 ? [codeModeRunNativeTool(codeModeTools)] : []),
      ],
      routes: resolved.routes,
      namespaceDiagnostics: resolved.namespaceDiagnostics,
    };
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

  private acceptLocalTools(tools: NativeCapletTool[]): void {
    void this.projectBinding
      ?.updateAllowedCapletIds(tools.map((tool) => tool.caplet))
      .catch((error) => {
        writeErr(
          this.options,
          `Could not update upstream Project Binding: ${errorMessage(error)}\n`,
        );
      });
  }
}

function nativeNamespaceContext(options: NativeCapletsServiceOptions): {
  localIdentity: string;
  namespaceAliases: NamespaceAliasesConfig;
} {
  const configPath = options.configPath ?? resolveConfigPath();
  const projectConfigPath = options.projectConfigPath ?? resolveProjectConfigPath();
  let namespaceAliases = parseConfig({}).namespaceAliases;
  try {
    namespaceAliases = loadLocalOverlayConfigWithSources(configPath, projectConfigPath).config
      .namespaceAliases;
  } catch {
    // Local overlay loading owns user-facing warnings and last-known-good behavior.
  }
  return {
    localIdentity: `local:${configPath}\0${projectConfigPath}`,
    namespaceAliases,
  };
}

function renameNativeTool(tool: NativeCapletTool, visibleBaseId: string): NativeCapletTool {
  const baseId = tool.sourceCaplet ?? tool.caplet;
  const directTool = Boolean(tool.sourceCaplet && tool.caplet.startsWith(`${baseId}__`));
  const visibleCapletId = directTool
    ? `${visibleBaseId}${tool.caplet.slice(baseId.length)}`
    : visibleBaseId;
  const operationName = directTool ? tool.caplet.slice(baseId.length + 2) : undefined;
  const toolName = operationName
    ? nativeDirectToolName(visibleBaseId, operationName)
    : nativeCapletToolName(visibleCapletId);
  return {
    ...tool,
    caplet: visibleCapletId,
    sourceCaplet: directTool ? visibleBaseId : baseId,
    toolName,
  };
}

function remoteCodeModeCallableNativeTools(tools: NativeCapletTool[]): NativeCapletTool[] {
  return codeModeCallableNativeTools(tools, { fallbackToVisible: true });
}

function createProjectBindingSessionManager(
  remoteOptions: ResolvedNativeRemoteOptions,
  options: NativeCapletsServiceOptions,
): ProjectBindingSessionAdapter | undefined {
  if (!options.projectRoot || !isLoopbackRemote(remoteOptions)) return undefined;
  return new RemoteProjectBindingSessionManager({
    origin: remoteOptions.origin,
    requestInit: remoteOptions.requestInit,
    ...(remoteOptions.fetch ? { fetch: remoteOptions.fetch } : {}),
    projectRoot: options.projectRoot,
    heartbeatIntervalMs: 30_000,
    ...(options.writeErr ? { writeErr: options.writeErr } : {}),
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
    const fatalWarnings = new Set(
      result.warnings.filter((warning) => !warning.recoverable).map(warningKey),
    );
    if (hasLoaded && [...fatalWarnings].some((warning) => !previousWarnings.has(warning))) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Caplets local overlay reload produced new warnings; keeping last known-good config.",
      );
    }
    previousWarnings = fatalWarnings;
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
