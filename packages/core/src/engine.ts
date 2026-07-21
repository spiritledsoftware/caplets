import { fingerprintProjectRoot } from "@caplets/sdk/project-binding/node";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, join, parse } from "node:path";
import {
  createBackendOperationRuntime,
  type BackendOperationRuntime,
} from "./backend-operation-dispatch";
import { CapletSetManager } from "./caplet-sets";
import { CliToolsManager } from "./cli-tools";
import { findProjectRoot } from "./cloud/project-root";
import {
  type CapletConfig,
  type CapletsConfig,
  loadLocalRuntimeConfig,
  loadConfigWithHostStorage,
  loadHostStorageConfig,
  type LocalOverlayConfigWarning,
  resolveCapletsRoot,
  resolveConfigPath,
  resolveProjectConfigPath,
  runtimeFingerprintForConfig,
  vaultResolverForAuthDir,
} from "./config";
import { DEFAULT_OBSERVED_OUTPUT_SHAPE_CACHE_DIR, defaultStateBaseDir } from "./config/paths";
import {
  resolvedExecutionFingerprintForConfig,
  type DeclaredInputReader,
} from "./caplet-source/runtime-fingerprint";
import { DownstreamManager } from "./downstream";
import { CapletsError, errorResult, toSafeError } from "./errors";
import { GraphQLManager } from "./graphql";
import { GoogleDiscoveryManager } from "./google-discovery";
import { HttpActionManager } from "./http-actions";
import { OpenApiManager } from "./openapi";
import {
  FileObservedOutputShapeStore,
  type ObservedOutputShapeKey,
  type ObservedOutputShapeStore,
} from "./observed-output-shapes";
import type { ProjectBindingExecutionContext } from "./project-binding/execution-context";
import { ServerRegistry } from "./registry";
import { createHostStorage, createHostStorageVaultResolver, type HostStorage } from "./storage";
import { extractArtifacts, handleServerTool } from "./tools";
import { discoverExposureSnapshot, type ExposureSnapshot } from "./exposure/discovery";
import { buildExposureProjection, type ExposureProjection } from "./exposure/projection";
import {
  captureRuntimeReliabilityEvent,
  captureRuntimeTelemetryEvent,
  codeModeTelemetryProperties,
  createRuntimeTelemetryContext,
  runtimeFailureTelemetryProperties,
  toolActivationProperties,
  type RuntimeMode,
  type RuntimeTelemetryContext,
} from "./telemetry";
import type {
  TelemetryDebugSink,
  TelemetryDispatcher,
  TelemetrySurface,
  TelemetryVisibility,
} from "./telemetry";

const HOST_RUNTIME_FINGERPRINT_PATTERN = /^hmac-sha256:[a-f0-9]{64}$/u;

type ToolSummary = { name: string; description?: string };

export type ResolvedExposureProjection = {
  generation: number;
  projection: ExposureProjection;
};

export type CapletsEngineOptions = {
  configPath?: string;
  projectConfigPath?: string;
  authDir?: string;
  artifactDir?: string;
  exposeLocalArtifactPaths?: boolean;
  mediaInlineThresholdBytes?: number;
  mediaArtifactMaxBytes?: number;
  watchDebounceMs?: number;
  watch?: boolean;
  writeErr?: (value: string) => void;
  configLoader?: (
    configPath: string,
    projectConfigPath: string,
    options?: { writeWarning?: ((warning: LocalOverlayConfigWarning) => void) | undefined },
  ) => CapletsConfig;
  asyncConfigLoader?: (
    configPath: string,
    projectConfigPath: string,
    options?: { writeWarning?: ((warning: LocalOverlayConfigWarning) => void) | undefined },
  ) => Promise<CapletsConfig>;
  initialConfig?: CapletsConfig | undefined;
  hostStorage?: HostStorage | undefined;
  hostNodeId?: string | undefined;
  hostConfigGeneration?: number | undefined;
  hostRuntimeFingerprint?: string | undefined;
  parityConfigLoader?: (() => Promise<CapletsConfig>) | undefined;
  declaredInputReader?: DeclaredInputReader | undefined;
  observedOutputShapeStore?: ObservedOutputShapeStore | undefined;
  observedOutputShapeScope?: ObservedOutputShapeKey["scope"] | undefined;
  observedOutputShapeCacheDir?: string | undefined;
  projectFingerprint?: string | undefined;
  vaultRecoveryTarget?: "global" | "remote" | undefined;
  telemetryStateDir?: string | undefined;
  telemetryEnv?: NodeJS.ProcessEnv | undefined;
  telemetrySurface?: TelemetrySurface | undefined;
  telemetryVisibility?: TelemetryVisibility | undefined;
  telemetryRuntimeMode?: RuntimeMode | undefined;
  telemetryIntegration?: "opencode" | "pi" | "native" | "unknown" | undefined;
  telemetryDebugSink?: TelemetryDebugSink | undefined;
  telemetryDispatcher?: TelemetryDispatcher | undefined;
  projectBindingContext?: ProjectBindingExecutionContext | undefined;
};

export type CapletsEngineReloadEvent = {
  previous: CapletsConfig;
  next: CapletsConfig;
  invalidated: boolean;
};

type RuntimePaths = {
  configPath: string;
  projectConfigPath: string;
};

type WatchedPath = {
  path: string;
  reason: "config" | "caplets";
};

export class CapletsEngine {
  private registry: ServerRegistry;
  private readonly downstream: DownstreamManager;
  private readonly openapi: OpenApiManager;
  private readonly googleDiscovery: GoogleDiscoveryManager;
  private readonly graphql: GraphQLManager;
  private readonly http: HttpActionManager;
  private readonly cli: CliToolsManager;
  private readonly capletSets: CapletSetManager;
  private readonly backendRuntime: BackendOperationRuntime;
  private readonly paths: RuntimePaths;
  private readonly watchDebounceMs: number;
  private readonly watchEnabled: boolean;
  private readonly writeErr: (value: string) => void;
  private readonly configLoader: NonNullable<CapletsEngineOptions["configLoader"]>;
  private readonly asyncConfigLoader: CapletsEngineOptions["asyncConfigLoader"];
  private readonly parityConfigLoader: CapletsEngineOptions["parityConfigLoader"];
  private readonly hostStorage: HostStorage | undefined;
  private readonly hostNodeId: string | undefined;
  private hostConfigGeneration: number;
  private hostRuntimeFingerprint: string;
  private coordinationTimer: NodeJS.Timeout | undefined;
  private coordinationAbortController: AbortController | undefined;
  private coordinationTask: Promise<void> | undefined;
  private readonly declaredInputReader: DeclaredInputReader | undefined;
  private readonly requireValidCustomFingerprint: boolean;
  private readonly observedOutputShapeStore: ObservedOutputShapeStore | undefined;
  private readonly observedOutputShapeScope: ObservedOutputShapeKey["scope"];
  private readonly projectFingerprint: string | undefined;
  private readonly projectBindingContext: ProjectBindingExecutionContext | undefined;
  private readonly telemetry: RuntimeTelemetryContext;
  private readonly telemetryExecuteExposureMode: "progressive" | "code_mode";
  private readonly reloadListeners = new Set<(event: CapletsEngineReloadEvent) => void>();
  private exposureGeneration = 0;
  private watchers: FSWatcher[] = [];
  private reloadTimer: NodeJS.Timeout | undefined;
  private watcherRefreshTimer: NodeJS.Timeout | undefined;
  private reloading: Promise<boolean> | undefined;
  private pendingReload = false;
  private closed = false;
  private stableHostConfigurationFingerprint: string;
  private resolvedExecutionFingerprint: string;

  static async create(options: CapletsEngineOptions = {}): Promise<CapletsEngine> {
    const configPath = resolveConfigPath(options.configPath);
    const projectConfigPath = options.projectConfigPath ?? resolveProjectConfigPath();
    const storage = await createHostStorage(loadHostStorageConfig(configPath), {
      vaultRoot: options.authDir ? join(options.authDir, "vault") : undefined,
    });
    const recordCacheRoot = join(defaultStateBaseDir(), "record-caplets");
    const load = async (
      path: string,
      projectPath: string,
      _loaderOptions?: {
        writeWarning?: ((warning: LocalOverlayConfigWarning) => void) | undefined;
      },
    ): Promise<CapletsConfig> =>
      (
        await loadConfigWithHostStorage(storage, path, projectPath, {
          recordCacheRoot,
          vaultResolver: await createHostStorageVaultResolver(storage),
        })
      ).config;
    const parityConfigLoader = async (): Promise<CapletsConfig> =>
      await load(configPath, join(recordCacheRoot, ".cluster-parity", "config.json"));
    try {
      const loaded = await loadConfigWithHostStorage(storage, configPath, projectConfigPath, {
        vaultResolver: await createHostStorageVaultResolver(storage),
        recordCacheRoot,
      });
      const initialConfig = loaded.config;
      const parityConfig = await parityConfigLoader();
      const hostRuntimeFingerprint = storage.vaultValues.hostRuntimeFingerprint(
        clusterHostConfigurationFingerprint(parityConfig),
      );
      const hostNodeId = randomUUID();
      const registration = await storage.coordination.registerNode({
        nodeId: hostNodeId,
        globalFileManifest: globalFileManifest(configPath),
        runtimeFingerprint: hostRuntimeFingerprint,
      });
      if (!registration.ready) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          `Host Node configuration conflicts with another active node (${registration.conflict}).`,
          { conflict: registration.conflict },
        );
      }
      const hostConfigGeneration = await storage.coordination.publishConfigGeneration(
        resolvedExecutionFingerprintForConfig(parityConfig),
        hostNodeId,
      );
      return new CapletsEngine({
        ...options,
        initialConfig,
        asyncConfigLoader: load,
        hostRuntimeFingerprint,
        parityConfigLoader,
        hostStorage: storage,
        hostNodeId,
        hostConfigGeneration,
      });
    } catch (error) {
      await storage.close();
      throw error;
    }
  }

  constructor(options: CapletsEngineOptions = {}) {
    this.paths = {
      configPath: resolveConfigPath(options.configPath),
      projectConfigPath: options.projectConfigPath ?? resolveProjectConfigPath(),
    };
    this.writeErr = options.writeErr ?? ((value: string) => process.stderr.write(value));
    this.configLoader =
      options.configLoader ?? runtimeConfigLoader(options.authDir, options.vaultRecoveryTarget);
    this.asyncConfigLoader = options.asyncConfigLoader;
    this.parityConfigLoader = options.parityConfigLoader;
    this.hostStorage = options.hostStorage;
    this.declaredInputReader = options.declaredInputReader;
    this.requireValidCustomFingerprint =
      options.configLoader !== undefined || options.asyncConfigLoader !== undefined;
    const config = options.initialConfig ?? this.loadConfigWithWarnings();
    this.hostNodeId = options.hostNodeId;
    this.hostConfigGeneration = options.hostConfigGeneration ?? 0;
    this.stableHostConfigurationFingerprint =
      runtimeFingerprintForConfig(config).hostConfigurationFingerprint;
    if (
      this.hostStorage &&
      this.hostNodeId &&
      !HOST_RUNTIME_FINGERPRINT_PATTERN.test(options.hostRuntimeFingerprint ?? "")
    ) {
      throw new CapletsError(
        "INTERNAL_ERROR",
        "Host Node keyed parity state must be initialized before runtime startup.",
      );
    }
    this.hostRuntimeFingerprint =
      options.hostRuntimeFingerprint ?? this.stableHostConfigurationFingerprint;
    this.resolvedExecutionFingerprint = resolvedExecutionFingerprintForConfig(config);
    this.registry = new ServerRegistry(config);
    this.telemetry = createRuntimeTelemetryContext({
      config: this.registry.config,
      env: options.telemetryEnv,
      stateDir: options.telemetryStateDir,
      surface: options.telemetrySurface ?? "serve",
      visibility: options.telemetryVisibility ?? "unknown",
      runtimeMode: options.telemetryRuntimeMode ?? runtimeModeFromEnv(options.telemetryEnv),
      integration: options.telemetryIntegration,
      debugSink: options.telemetryDebugSink,
      dispatcher: options.telemetryDispatcher,
    });
    this.telemetryExecuteExposureMode =
      options.telemetrySurface === "code_mode" ? "code_mode" : "progressive";
    this.downstream = new DownstreamManager(this.registry, {
      ...selectAuthOptions(options.authDir),
      ...(options.hostStorage ? { backendAuth: options.hostStorage.backendAuth } : {}),
      projectBindingContext: options.projectBindingContext,
    });
    this.openapi = new OpenApiManager(this.registry, selectHttpLikeOptions(options));
    this.googleDiscovery = new GoogleDiscoveryManager(
      this.registry,
      selectHttpLikeOptions(options),
    );
    this.graphql = new GraphQLManager(this.registry, selectHttpLikeOptions(options));
    this.http = new HttpActionManager(this.registry, selectHttpLikeOptions(options));
    this.cli = new CliToolsManager(this.registry, {
      projectBindingContext: options.projectBindingContext,
    });
    this.capletSets = new CapletSetManager(this.registry, selectHttpLikeOptions(options));
    this.backendRuntime = createBackendOperationRuntime({
      mcp: this.downstream,
      openapi: this.openapi,
      googleDiscovery: this.googleDiscovery,
      graphql: this.graphql,
      http: this.http,
      cli: this.cli,
      caplets: this.capletSets,
    });
    this.watchDebounceMs = options.watchDebounceMs ?? 250;
    this.watchEnabled = options.watch ?? true;
    this.observedOutputShapeStore =
      options.observedOutputShapeStore ??
      new FileObservedOutputShapeStore(
        options.observedOutputShapeCacheDir ?? DEFAULT_OBSERVED_OUTPUT_SHAPE_CACHE_DIR,
      );
    this.observedOutputShapeScope = options.observedOutputShapeScope ?? "local";
    this.projectFingerprint = options.projectFingerprint ?? safeProjectFingerprint();
    this.projectBindingContext = options.projectBindingContext;
    if (this.watchEnabled) {
      this.resetWatchers();
    }
    if (this.hostStorage && this.hostNodeId) {
      this.coordinationAbortController = new AbortController();
      this.coordinationTask = this.watchConfigGenerations(this.coordinationAbortController.signal);
      this.coordinationTimer = setInterval(() => {
        void this.refreshCoordinationHeartbeat();
      }, 1_000);
      this.coordinationTimer.unref();
    }
  }

  async readiness(): Promise<{
    ready: boolean;
    backend?: "sqlite" | "postgres" | undefined;
    reason?: string | undefined;
  }> {
    try {
      await this.assertHostStorageReady();
      return {
        ready: true,
        ...(this.hostStorage ? { backend: this.hostStorage.backend } : {}),
      };
    } catch (error) {
      let reason = "host_not_ready";
      if (
        error instanceof CapletsError &&
        error.details &&
        typeof error.details === "object" &&
        "reason" in error.details &&
        typeof error.details.reason === "string"
      ) {
        reason = error.details.reason;
      }
      return {
        ready: false,
        ...(this.hostStorage ? { backend: this.hostStorage.backend } : {}),
        reason,
      };
    }
  }
  authoritativeStorage(): HostStorage | undefined {
    return this.hostStorage;
  }
  hostNodeIdentity(): string | undefined {
    return this.hostNodeId;
  }

  currentConfig(): CapletsConfig {
    return this.registry.config;
  }

  enabledServers(): CapletConfig[] {
    return nextEnabledServers(this.registry.config);
  }

  currentExposureGeneration(): number {
    return this.exposureGeneration;
  }

  async exposureProjection(
    options: { discoverNonDirectMcpSurfaces?: boolean | undefined } = {},
  ): Promise<ResolvedExposureProjection> {
    const generation = this.exposureGeneration;
    return {
      generation,
      projection: buildExposureProjection(await this.exposureSnapshot(options)),
    };
  }

  async exposureSnapshot(
    options: { discoverNonDirectMcpSurfaces?: boolean | undefined } = {},
  ): Promise<ExposureSnapshot> {
    const config = this.registry.config;
    const caplets = allCaplets(config);
    return await discoverExposureSnapshot({
      config,
      caplets,
      ...(options.discoverNonDirectMcpSurfaces === undefined
        ? {}
        : { discoverNonDirectMcpSurfaces: options.discoverNonDirectMcpSurfaces }),
      ...(this.projectBindingContext === undefined
        ? {}
        : { projectBindingContext: this.projectBindingContext }),
      listTools: async (caplet) => this.backendRuntime.operations.listTools(caplet),
      listResources: async (caplet) =>
        this.optionalMcpList(caplet, () => this.downstream.listResources(caplet, true)),
      listResourceTemplates: async (caplet) =>
        this.optionalMcpList(caplet, () => this.downstream.listResourceTemplates(caplet, true)),
      listPrompts: async (caplet) =>
        this.optionalMcpList(caplet, () => this.downstream.listPrompts(caplet, true)),
      supportsCompletions: async (caplet) => await this.downstream.supportsCompletions(caplet),
    });
  }

  currentProjectBindingContext(): ProjectBindingExecutionContext | undefined {
    return this.projectBindingContext;
  }

  watchedPaths(): string[] {
    return [...new Set(watchedPaths(this.paths).map((entry) => entry.path))].sort();
  }

  onReload(listener: (event: CapletsEngineReloadEvent) => void): () => void {
    this.reloadListeners.add(listener);
    return () => {
      this.reloadListeners.delete(listener);
    };
  }

  scheduleReload(): void {
    if (this.closed) {
      return;
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.reload();
    }, this.watchDebounceMs);
  }

  async reload(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    if (this.reloading) {
      this.pendingReload = true;
      return await this.reloading;
    }
    this.reloading = this.reloadUntilSettled().finally(() => {
      this.reloading = undefined;
    });
    return await this.reloading;
  }

  async execute(serverId: string, request: unknown): Promise<unknown> {
    const started = Date.now();
    let caplet: CapletConfig | undefined;
    try {
      await this.assertHostStorageReady();
      caplet = this.registry.require(serverId);
      this.assertProjectBindingCallable(caplet);
      const result = await handleServerTool(caplet, request, this.registry, this.backendRuntime, {
        observedOutputShapeStore: this.observedOutputShapeStore,
        observedOutputShapeScope: this.observedOutputShapeScope,
        projectFingerprint: this.projectFingerprint,
      });
      this.captureToolActivation(
        caplet,
        operationFromRequest(request),
        this.telemetryExecuteExposureMode,
        result,
        started,
      );
      return result;
    } catch (error) {
      const result = errorResult(error);
      this.captureReliabilityError(
        operationFromRequest(request),
        this.telemetryExecuteExposureMode,
        result,
      );
      this.captureToolActivation(
        caplet,
        operationFromRequest(request),
        this.telemetryExecuteExposureMode,
        result,
        started,
      );
      return result;
    }
  }

  async executeDirectTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const started = Date.now();
    let caplet: CapletConfig | undefined;
    try {
      await this.assertHostStorageReady();
      caplet = this.registry.require(serverId);
      this.assertProjectBindingCallable(caplet);
      const result = await this.backendRuntime.operations.callTool(caplet, toolName, args);
      const annotated = annotateDirectResult(result, caplet, toolName);
      this.captureToolActivation(caplet, "call_tool", "direct", annotated, started);
      return annotated;
    } catch (error) {
      const result = errorResult(error);
      this.captureReliabilityError("call_tool", "direct", result);
      this.captureToolActivation(caplet, "call_tool", "direct", result, started);
      return result;
    }
  }

  async completeDirectReference(
    serverId: string,
    ref: { type: "prompt"; name: string } | { type: "resourceTemplate"; uri: string },
    argument: { name: string; value: string },
    context?: { arguments?: Record<string, string> | undefined } | undefined,
  ): Promise<string[]> {
    const started = Date.now();
    let caplet: CapletConfig | undefined;
    try {
      await this.assertHostStorageReady();
      caplet = this.registry.require(serverId);
      this.assertProjectBindingCallable(caplet);
      if (caplet.backend !== "mcp") throw new Error(`Caplet ${serverId} has no MCP completions`);
      const result = await this.downstream.complete(caplet, {
        ref,
        argument,
        ...(context ? { context } : {}),
      });
      this.captureToolActivation(caplet, "complete", "direct", result, started);
      return result.completion.values;
    } catch (error) {
      const result = errorResult(error);
      this.captureReliabilityError("complete", "direct", result);
      this.captureToolActivation(caplet, "complete", "direct", result, started);
      throw error;
    }
  }

  async readDirectResource(serverId: string, downstreamUri: string): Promise<unknown> {
    const started = Date.now();
    let caplet: CapletConfig | undefined;
    try {
      await this.assertHostStorageReady();
      caplet = this.registry.require(serverId);
      this.assertProjectBindingCallable(caplet);
      if (caplet.backend !== "mcp") throw new Error(`Caplet ${serverId} has no MCP resources`);
      const result = await this.downstream.readResource(caplet, downstreamUri);
      const annotated = annotateDirectResult(result, caplet, "read_resource");
      this.captureToolActivation(caplet, "read_resource", "direct", annotated, started);
      return annotated;
    } catch (error) {
      const result = errorResult(error);
      this.captureReliabilityError("read_resource", "direct", result);
      this.captureToolActivation(caplet, "read_resource", "direct", result, started);
      return result;
    }
  }

  async getDirectPrompt(
    serverId: string,
    promptName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const started = Date.now();
    let caplet: CapletConfig | undefined;
    try {
      await this.assertHostStorageReady();
      caplet = this.registry.require(serverId);
      this.assertProjectBindingCallable(caplet);
      if (caplet.backend !== "mcp") throw new Error(`Caplet ${serverId} has no MCP prompts`);
      const result = await this.downstream.getPrompt(caplet, promptName, args);
      const annotated = annotateDirectResult(result, caplet, promptName);
      this.captureToolActivation(caplet, "get_prompt", "direct", annotated, started);
      return annotated;
    } catch (error) {
      const result = errorResult(error);
      this.captureReliabilityError("get_prompt", "direct", result);
      this.captureToolActivation(caplet, "get_prompt", "direct", result, started);
      return result;
    }
  }

  async completeCliWords(words: string[]): Promise<string[]> {
    const { completeCliWords } = await import("./cli/completion");
    return await completeCliWords(words, {
      config: this.registry.config,
      managers: {
        listTools: async (server) => this.listCompletionTools(server),
        listPrompts: async (server) => {
          if (server.backend !== "mcp") return [];
          return (await this.downstream.listPrompts(server)).map((prompt) => ({
            name: prompt.name,
            ...(prompt.description ? { description: prompt.description } : {}),
          }));
        },
        listResources: async (server) => {
          if (server.backend !== "mcp") return [];
          return (await this.downstream.listResources(server)).map((resource) => ({
            uri: resource.uri,
            ...(resource.name ? { name: resource.name } : {}),
            ...(resource.description ? { description: resource.description } : {}),
          }));
        },
        listResourceTemplates: async (server) => {
          if (server.backend !== "mcp") return [];
          return (await this.downstream.listResourceTemplates(server)).map((template) => ({
            uriTemplate: template.uriTemplate,
            ...(template.name ? { name: template.name } : {}),
            ...(template.description ? { description: template.description } : {}),
          }));
        },
      },
    });
  }

  async captureCodeModeOutcome(
    envelope: unknown,
    options: { started: number; timeoutMs?: number | undefined },
  ): Promise<void> {
    await captureRuntimeTelemetryEvent(
      this.telemetry,
      "caplets_code_mode_outcome",
      codeModeTelemetryProperties(envelope, Date.now() - options.started, options.timeoutMs),
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    this.coordinationAbortController?.abort();
    this.coordinationAbortController = undefined;
    if (this.coordinationTimer) {
      clearInterval(this.coordinationTimer);
      this.coordinationTimer = undefined;
    }
    try {
      if (this.reloadTimer) {
        clearTimeout(this.reloadTimer);
        this.reloadTimer = undefined;
      }
      if (this.watcherRefreshTimer) {
        clearTimeout(this.watcherRefreshTimer);
        this.watcherRefreshTimer = undefined;
      }
      if (this.coordinationTask) {
        await this.coordinationTask;
        this.coordinationTask = undefined;
      }
      if (this.reloading) {
        await this.reloading;
      }
      if (this.hostStorage && this.hostNodeId) {
        await this.hostStorage.coordination.unregisterNode(this.hostNodeId);
      }
    } finally {
      this.closeWatchers();
      await this.downstream.close();
      await this.capletSets.close();
      await this.telemetry.dispatcher.shutdown();
      await this.hostStorage?.close();
      this.reloadListeners.clear();
    }
  }

  private async listCompletionTools(server: CapletConfig): Promise<ToolSummary[]> {
    const tools = await this.backendRuntime.operations.listTools(server);
    return tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
    }));
  }

  private assertProjectBindingCallable(caplet: CapletConfig): void {
    if (!caplet.projectBinding?.required) return;
    const quarantineRecord = this.projectBindingContext?.quarantineRecords?.find(
      (record) => record.capletId === caplet.server,
    );
    if (quarantineRecord) {
      throw new CapletsError("UNSUPPORTED_CAPABILITY", quarantineRecord.message, {
        projectBinding: {
          reason: quarantineRecord.reason,
          capletId: caplet.server,
          ...(quarantineRecord.code === undefined ? {} : { diagnosticCode: quarantineRecord.code }),
          ...(quarantineRecord.recoveryCommand === undefined
            ? {}
            : { recoveryCommand: quarantineRecord.recoveryCommand }),
        },
      });
    }
    if (this.projectBindingContext) return;
    throw new CapletsError(
      "UNSUPPORTED_CAPABILITY",
      "Project Binding session context is required before this Caplet can be exposed.",
      {
        projectBinding: {
          reason: "missing_context",
          capletId: caplet.server,
          recoveryCommand: "Reconnect through an attach or native session with project context.",
        },
      },
    );
  }

  private async optionalMcpList<T>(
    caplet: Extract<CapletConfig, { backend: "mcp" }>,
    list: () => Promise<T[]>,
  ): Promise<T[]> {
    try {
      return await list();
    } catch (error) {
      if (isUnsupportedCapability(error)) return [];
      throw error;
    }
  }

  private async reloadOnce(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    let nextConfig: CapletsConfig;
    let nextHostRuntimeFingerprint = this.hostRuntimeFingerprint;
    try {
      nextConfig = await this.loadConfigWithWarningsAsync();
      if (this.parityConfigLoader && this.hostStorage && this.hostNodeId) {
        const parityConfig = await this.parityConfigLoader();
        nextHostRuntimeFingerprint = this.hostStorage.vaultValues.hostRuntimeFingerprint(
          clusterHostConfigurationFingerprint(parityConfig),
        );
      }
    } catch (error) {
      this.writeErr(`Caplets config reload failed; keeping last known-good config.\n`);
      this.writeErr(`${JSON.stringify(toSafeError(error, "CONFIG_INVALID"), null, 2)}\n`);
      return false;
    }
    if (this.closed) {
      return false;
    }

    if (nextHostRuntimeFingerprint !== this.hostRuntimeFingerprint) {
      this.hostRuntimeFingerprint = nextHostRuntimeFingerprint;
      await this.refreshCoordinationHeartbeat();
    }

    const nextStableHostConfigurationFingerprint =
      runtimeFingerprintForConfig(nextConfig).hostConfigurationFingerprint;
    const nextResolvedExecutionFingerprint = resolvedExecutionFingerprintForConfig(nextConfig);
    if (
      nextStableHostConfigurationFingerprint === this.stableHostConfigurationFingerprint &&
      nextResolvedExecutionFingerprint === this.resolvedExecutionFingerprint
    ) {
      return true;
    }
    const previousConfig = this.registry.config;
    const nextRegistry = new ServerRegistry(nextConfig);
    this.registry = nextRegistry;
    this.exposureGeneration += 1;
    this.telemetry.config = nextConfig;
    this.stableHostConfigurationFingerprint = nextStableHostConfigurationFingerprint;
    this.resolvedExecutionFingerprint = nextResolvedExecutionFingerprint;
    this.downstream.updateRegistry(nextRegistry);
    this.openapi.updateRegistry(nextRegistry);
    this.googleDiscovery.updateRegistry(nextRegistry);
    this.graphql.updateRegistry(nextRegistry);
    this.http.updateRegistry(nextRegistry);
    this.cli.updateRegistry(nextRegistry);
    this.capletSets.updateRegistry(nextRegistry);

    let invalidated = true;
    try {
      await this.invalidateChangedBackends(previousConfig, nextConfig);
    } catch (error) {
      invalidated = false;
      this.writeErr(`Caplets backend invalidation failed; continuing reload.\n`);
      this.writeErr(`${JSON.stringify(toSafeError(error, "INTERNAL_ERROR"), null, 2)}\n`);
    }
    if (this.closed) {
      return false;
    }
    if (this.watchEnabled) {
      this.resetWatchers();
    }
    this.emitReload({ previous: previousConfig, next: nextConfig, invalidated });
    return invalidated;
  }

  private async assertHostStorageReady(): Promise<void> {
    if (!this.hostStorage) return;
    if (this.hostNodeId && !(await this.hostStorage.coordination.nodeReady(this.hostNodeId))) {
      throw new CapletsError("SERVER_UNAVAILABLE", "Host Node configuration parity is not ready.");
    }
    const health = await this.hostStorage.health();
    if (!health.ready) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Authoritative Host State storage is unavailable.",
        { backend: health.backend, reason: health.reason },
      );
    }
  }

  private async refreshCoordinationHeartbeat(): Promise<void> {
    if (!this.hostStorage || !this.hostNodeId || this.closed) return;
    try {
      await this.hostStorage.coordination.heartbeat({
        nodeId: this.hostNodeId,
        globalFileManifest: globalFileManifest(this.paths.configPath),
        runtimeFingerprint: this.hostRuntimeFingerprint,
      });
    } catch {
      // Request-time storage and node-readiness checks fail closed while coordination recovers.
    }
  }

  private async watchConfigGenerations(signal: AbortSignal): Promise<void> {
    if (!this.hostStorage) return;
    let observedGeneration = this.hostConfigGeneration;
    while (!this.closed && !signal.aborted) {
      try {
        const generation = await this.hostStorage.coordination.waitForConfigGeneration(
          observedGeneration,
          { signal },
        );
        if (this.closed || signal.aborted) return;
        observedGeneration = Math.max(observedGeneration, generation);
        if (generation > this.hostConfigGeneration && (await this.reload())) {
          this.hostConfigGeneration = generation;
        }
      } catch {
        if (this.closed || signal.aborted) return;
        await coordinationRetryDelay(signal);
      }
    }
  }

  private loadConfigWithWarnings(): CapletsConfig {
    const config = this.configLoader(this.paths.configPath, this.paths.projectConfigPath, {
      writeWarning: (warning) => {
        this.writeErr(`Warning: ${warning.kind} at ${warning.path}: ${warning.message}\n`);
      },
    });
    const runtimeFingerprint = runtimeFingerprintForConfig(config, this.declaredInputReader);
    if (this.requireValidCustomFingerprint && !runtimeFingerprint.valid) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Caplets runtime references must be present and readable.",
      );
    }
    return config;
  }

  private async loadConfigWithWarningsAsync(): Promise<CapletsConfig> {
    if (!this.asyncConfigLoader) return this.loadConfigWithWarnings();
    const config = await this.asyncConfigLoader(
      this.paths.configPath,
      this.paths.projectConfigPath,
      {
        writeWarning: (warning) => {
          this.writeErr(`Warning: ${warning.kind} at ${warning.path}: ${warning.message}\n`);
        },
      },
    );
    const runtimeFingerprint = runtimeFingerprintForConfig(config, this.declaredInputReader);
    if (this.requireValidCustomFingerprint && !runtimeFingerprint.valid) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Caplets runtime references must be present and readable.",
      );
    }
    return config;
  }

  private async reloadUntilSettled(): Promise<boolean> {
    let succeeded = true;
    do {
      this.pendingReload = false;
      try {
        succeeded = (await this.reloadOnce()) && succeeded;
      } catch (err) {
        this.writeErr(`Caplets reload failed.\n`);
        this.writeErr(`${JSON.stringify(toSafeError(err, "INTERNAL_ERROR"), null, 2)}\n`);
        succeeded = false;
      }
    } while (this.pendingReload && !this.closed);
    return succeeded && !this.closed;
  }

  private emitReload(event: CapletsEngineReloadEvent): void {
    for (const listener of this.reloadListeners) {
      try {
        listener(event);
      } catch (error) {
        this.writeErr(`Caplets reload listener failed.\n`);
        this.writeErr(`${JSON.stringify(toSafeError(error, "INTERNAL_ERROR"), null, 2)}\n`);
      }
    }
  }

  private async invalidateChangedBackends(
    previous: CapletsConfig,
    next: CapletsConfig,
  ): Promise<void> {
    const previousCaplets = new Map(allCaplets(previous).map((server) => [server.server, server]));
    const nextCaplets = new Map(allCaplets(next).map((server) => [server.server, server]));
    const changedIds = new Set([...previousCaplets.keys(), ...nextCaplets.keys()]);

    for (const serverId of changedIds) {
      const before = previousCaplets.get(serverId);
      const after = nextCaplets.get(serverId);
      const changed = serializeCaplet(before) !== serializeCaplet(after);
      if (!changed) {
        continue;
      }
      if (before?.backend === "mcp") {
        await this.downstream.closeServer(serverId);
      }
      if (before?.backend === "openapi" || after?.backend === "openapi" || !after) {
        this.openapi.invalidate(serverId);
      }
      if (before?.backend === "googleDiscovery" || after?.backend === "googleDiscovery" || !after) {
        this.googleDiscovery.invalidate(serverId);
      }
      if (before?.backend === "graphql" || after?.backend === "graphql" || !after) {
        this.graphql.invalidate(serverId);
      }
      if (before?.backend === "http" || after?.backend === "http" || !after) {
        this.http.invalidate(serverId);
      }
      if (before?.backend === "cli" || after?.backend === "cli" || !after) {
        this.cli.invalidate(serverId);
      }
      if (before?.backend === "caplets" || after?.backend === "caplets" || !after) {
        this.capletSets.invalidate(serverId);
      }
    }
  }

  private resetWatchers(): void {
    this.closeWatchers();
    const watched = new Set<string>();
    for (const entry of watchedPaths(this.paths)) {
      const watchPath = existsSync(entry.path) ? entry.path : nearestExistingParent(entry.path);
      const watchKey = `${entry.reason}:${watchPath}`;
      if (!watchPath || watched.has(watchKey)) {
        continue;
      }
      watched.add(watchKey);
      try {
        this.watchers.push(...this.watchEntry(entry, watchPath));
      } catch (error) {
        this.writeErr(`Caplets could not watch ${entry.reason} path ${entry.path}.\n`);
        this.writeErr(`${JSON.stringify(toSafeError(error, "SERVER_UNAVAILABLE"), null, 2)}\n`);
      }
    }
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }

  private watchEntry(entry: WatchedPath, watchPath: string): FSWatcher[] {
    if (entry.reason === "caplets" && existsSync(entry.path) && isDirectory(watchPath)) {
      return this.watchDirectoryTree(watchPath);
    }
    return [
      watch(watchPath, { persistent: true }, (eventType) => {
        this.scheduleReload();
        if (eventType === "rename" && entry.reason === "caplets" && existsSync(entry.path)) {
          this.scheduleWatcherRefresh();
        }
      }),
    ];
  }

  private watchDirectoryTree(root: string): FSWatcher[] {
    const watchers: FSWatcher[] = [];
    const directories = discoverDirectories(root);
    for (const directory of directories) {
      try {
        watchers.push(
          watch(directory, { persistent: true }, (eventType) => {
            this.scheduleReload();
            if (eventType === "rename") {
              this.scheduleWatcherRefresh();
            }
          }),
        );
      } catch (error) {
        for (const watcher of watchers) {
          watcher.close();
        }
        throw error;
      }
    }
    return watchers;
  }

  private scheduleWatcherRefresh(): void {
    if (this.closed) {
      return;
    }
    if (this.watcherRefreshTimer) {
      clearTimeout(this.watcherRefreshTimer);
    }
    this.watcherRefreshTimer = setTimeout(() => {
      this.watcherRefreshTimer = undefined;
      if (!this.closed) {
        this.resetWatchers();
      }
    }, this.watchDebounceMs);
  }

  private captureReliabilityError(
    operation: unknown,
    exposureMode: "direct" | "progressive" | "code_mode" | "mixed" | "unknown",
    result: unknown,
  ): void {
    void captureRuntimeReliabilityEvent(this.telemetry, {
      command_family: commandFamilyForTelemetrySurface(this.telemetry.surface),
      ...runtimeFailureTelemetryProperties({ operation, exposureMode, result }),
    }).catch(() => undefined);
  }

  private captureToolActivation(
    caplet: CapletConfig | undefined,
    operation: unknown,
    exposureMode: "direct" | "progressive" | "code_mode" | "mixed" | "unknown",
    result: unknown,
    started: number,
  ): void {
    void captureRuntimeTelemetryEvent(this.telemetry, "caplets_tool_activation", {
      command_family: commandFamilyForTelemetrySurface(this.telemetry.surface),
      ...toolActivationProperties({
        config: this.registry.config,
        caplet,
        operation,
        exposureMode,
        result,
        durationMs: Date.now() - started,
      }),
    }).catch(() => undefined);
  }
}

function coordinationRetryDelay(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, 1_000);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
  });
}

function runtimeConfigLoader(
  authDir: string | undefined,
  vaultRecoveryTarget: CapletsEngineOptions["vaultRecoveryTarget"],
): NonNullable<CapletsEngineOptions["configLoader"]> {
  const vaultResolver = vaultResolverForAuthDir(authDir);
  return (configPath, projectConfigPath, options) =>
    loadLocalRuntimeConfig(configPath, projectConfigPath, {
      ...options,
      vaultResolver,
      vaultRecoveryTarget,
    });
}

function selectAuthOptions(authDir: string | undefined): { authDir?: string } {
  return authDir ? { authDir } : {};
}

function selectHttpLikeOptions(options: CapletsEngineOptions): {
  authDir?: string;
  backendAuth?: HostStorage["backendAuth"];
  artifactDir?: string;
  exposeLocalArtifactPaths?: boolean;
  mediaInlineThresholdBytes?: number;
  mediaArtifactMaxBytes?: number;
} {
  return {
    ...selectAuthOptions(options.authDir),
    ...(options.hostStorage ? { backendAuth: options.hostStorage.backendAuth } : {}),
    ...(options.artifactDir ? { artifactDir: options.artifactDir } : {}),
    ...(options.exposeLocalArtifactPaths === false ? { exposeLocalArtifactPaths: false } : {}),
    ...(options.mediaInlineThresholdBytes === undefined
      ? {}
      : { mediaInlineThresholdBytes: options.mediaInlineThresholdBytes }),
    ...(options.mediaArtifactMaxBytes === undefined
      ? {}
      : { mediaArtifactMaxBytes: options.mediaArtifactMaxBytes }),
  };
}

function safeProjectFingerprint(): string | undefined {
  try {
    return fingerprintProjectRoot(findProjectRoot());
  } catch {
    return undefined;
  }
}

function watchedPaths(paths: RuntimePaths): WatchedPath[] {
  return uniqueWatchedPaths([
    { path: dirname(paths.configPath), reason: "config" },
    { path: dirname(paths.projectConfigPath), reason: "config" },
    { path: resolveCapletsRoot(paths.configPath), reason: "caplets" },
    { path: dirname(paths.projectConfigPath), reason: "caplets" },
  ]);
}

function uniqueWatchedPaths(entries: WatchedPath[]): WatchedPath[] {
  const seen = new Set<string>();
  const unique: WatchedPath[] = [];
  for (const entry of entries) {
    const key = `${entry.reason}:${entry.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

function allCaplets(config: CapletsConfig): CapletConfig[] {
  return [
    ...Object.values(config.mcpServers),
    ...Object.values(config.openapiEndpoints),
    ...Object.values(config.googleDiscoveryApis ?? {}),
    ...Object.values(config.graphqlEndpoints),
    ...Object.values(config.httpApis),
    ...Object.values(config.cliTools),
    ...Object.values(config.capletSets),
  ];
}

function nextEnabledServers(config: CapletsConfig): CapletConfig[] {
  return allCaplets(config).filter((server) => !server.disabled);
}

function serializeCaplet(caplet: CapletConfig | undefined): string {
  return JSON.stringify(caplet ?? null);
}

function nearestExistingParent(path: string): string | undefined {
  let candidate = dirname(path);
  const root = parse(candidate).root;
  while (candidate && candidate !== root) {
    if (existsSync(candidate)) {
      return candidate;
    }
    candidate = dirname(candidate);
  }
  return existsSync(root) ? root : undefined;
}

function discoverDirectories(root: string): string[] {
  if (!isDirectory(root)) {
    return [];
  }
  const directories = [root];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      directories.push(...discoverDirectories(join(root, entry.name)));
    }
  }
  return directories;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function annotateDirectResult(result: unknown, caplet: CapletConfig, operation: string): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const existingMeta = (result as { _meta?: unknown })._meta;
  const artifacts = extractArtifacts(result);
  return {
    ...result,
    _meta: {
      ...(isRecord(existingMeta) ? existingMeta : {}),
      caplets: {
        capletId: caplet.server,
        backend: caplet.backend,
        operation,
        exposure: "direct",
        ...(artifacts.length === 0 ? {} : { artifacts }),
      },
    },
  };
}

function isUnsupportedCapability(error: unknown): boolean {
  return error instanceof CapletsError && error.code === "UNSUPPORTED_CAPABILITY";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function operationFromRequest(request: unknown): unknown {
  return isRecord(request) ? request.operation : undefined;
}

function clusterHostConfigurationFingerprint(config: CapletsConfig): string {
  const { serve: _serve, telemetry: _telemetry, ...clusterConfig } = config;
  return runtimeFingerprintForConfig(clusterConfig).hostConfigurationFingerprint;
}

function globalFileManifest(configPath: string): string {
  const root = resolveCapletsRoot(configPath);
  const hash = createHash("sha256");
  if (!existsSync(root)) return hash.digest("hex");
  const appendFile = (path: string, relativePath: string): void => {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  };
  const visitBundle = (directory: string, relativeRoot: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = join(relativeRoot, name);
      const stat = statSync(path);
      if (stat.isDirectory()) visitBundle(path, relativePath);
      else if (stat.isFile()) appendFile(path, relativePath);
    }
  };
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isFile() && name.toLowerCase().endsWith(".md")) {
      appendFile(path, name);
    } else if (stat.isDirectory() && existsSync(join(path, "CAPLET.md"))) {
      visitBundle(path, name);
    }
  }
  return hash.digest("hex");
}

function runtimeModeFromEnv(env: NodeJS.ProcessEnv | undefined): RuntimeMode {
  const mode = env?.CAPLETS_MODE ?? process.env.CAPLETS_MODE;
  if (mode === "local" || mode === "remote" || mode === "cloud") return mode;
  return "unknown";
}

function commandFamilyForTelemetrySurface(surface: TelemetrySurface) {
  if (surface === "serve") return "serve";
  if (surface === "attach") return "attach";
  if (surface === "daemon") return "daemon";
  if (surface === "code_mode") return "code_mode";
  if (surface === "native") return "native";
  return "tools";
}
