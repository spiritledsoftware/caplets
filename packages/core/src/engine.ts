import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, join, parse } from "node:path";
import { CapletSetManager } from "./caplet-sets";
import { CliToolsManager } from "./cli-tools";
import { findProjectRoot, fingerprintProjectRoot } from "./cloud/project-root";
import {
  type CapletConfig,
  type CapletsConfig,
  loadLocalRuntimeConfig,
  type LocalOverlayConfigWarning,
  resolveCapletsRoot,
  resolveConfigPath,
  resolveProjectConfigPath,
  vaultResolverForAuthDir,
} from "./config";
import { DEFAULT_OBSERVED_OUTPUT_SHAPE_CACHE_DIR } from "./config/paths";
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
import { ServerRegistry } from "./registry";
import { handleServerTool } from "./tools";
import { discoverExposureSnapshot, type ExposureSnapshot } from "./exposure/discovery";
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

type ToolSummary = { name: string; description?: string };

export type CapletsEngineOptions = {
  configPath?: string;
  projectConfigPath?: string;
  authDir?: string;
  artifactDir?: string;
  exposeLocalArtifactPaths?: boolean;
  watchDebounceMs?: number;
  watch?: boolean;
  writeErr?: (value: string) => void;
  configLoader?: (
    configPath: string,
    projectConfigPath: string,
    options?: { writeWarning?: ((warning: LocalOverlayConfigWarning) => void) | undefined },
  ) => CapletsConfig;
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
  private readonly paths: RuntimePaths;
  private readonly watchDebounceMs: number;
  private readonly watchEnabled: boolean;
  private readonly writeErr: (value: string) => void;
  private readonly configLoader: NonNullable<CapletsEngineOptions["configLoader"]>;
  private readonly observedOutputShapeStore: ObservedOutputShapeStore | undefined;
  private readonly observedOutputShapeScope: ObservedOutputShapeKey["scope"];
  private readonly projectFingerprint: string | undefined;
  private readonly telemetry: RuntimeTelemetryContext;
  private readonly telemetryExecuteExposureMode: "progressive" | "code_mode";
  private readonly reloadListeners = new Set<(event: CapletsEngineReloadEvent) => void>();
  private lastExposureSnapshot: ExposureSnapshot | undefined;
  private watchers: FSWatcher[] = [];
  private reloadTimer: NodeJS.Timeout | undefined;
  private watcherRefreshTimer: NodeJS.Timeout | undefined;
  private reloading: Promise<boolean> | undefined;
  private pendingReload = false;
  private closed = false;

  constructor(options: CapletsEngineOptions = {}) {
    this.paths = {
      configPath: resolveConfigPath(options.configPath),
      projectConfigPath: options.projectConfigPath ?? resolveProjectConfigPath(),
    };
    this.writeErr = options.writeErr ?? ((value: string) => process.stderr.write(value));
    this.configLoader =
      options.configLoader ?? runtimeConfigLoader(options.authDir, options.vaultRecoveryTarget);
    const config = this.loadConfigWithWarnings();
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
    this.downstream = new DownstreamManager(this.registry, selectAuthOptions(options.authDir));
    this.openapi = new OpenApiManager(this.registry, selectHttpLikeOptions(options));
    this.googleDiscovery = new GoogleDiscoveryManager(
      this.registry,
      selectHttpLikeOptions(options),
    );
    this.graphql = new GraphQLManager(this.registry, selectAuthOptions(options.authDir));
    this.http = new HttpActionManager(this.registry, selectHttpLikeOptions(options));
    this.cli = new CliToolsManager(this.registry);
    this.capletSets = new CapletSetManager(this.registry, selectHttpLikeOptions(options));
    this.watchDebounceMs = options.watchDebounceMs ?? 250;
    this.watchEnabled = options.watch ?? true;
    this.observedOutputShapeStore =
      options.observedOutputShapeStore ??
      new FileObservedOutputShapeStore(
        options.observedOutputShapeCacheDir ?? DEFAULT_OBSERVED_OUTPUT_SHAPE_CACHE_DIR,
      );
    this.observedOutputShapeScope = options.observedOutputShapeScope ?? "local";
    this.projectFingerprint = options.projectFingerprint ?? safeProjectFingerprint();
    if (this.watchEnabled) {
      this.resetWatchers();
    }
  }

  currentConfig(): CapletsConfig {
    return this.registry.config;
  }

  enabledServers(): CapletConfig[] {
    return nextEnabledServers(this.registry.config);
  }

  async exposureSnapshot(
    options: { discoverNonDirectMcpSurfaces?: boolean | undefined } = {},
  ): Promise<ExposureSnapshot> {
    this.lastExposureSnapshot = await discoverExposureSnapshot({
      config: this.registry.config,
      caplets: this.enabledServers(),
      ...(options.discoverNonDirectMcpSurfaces === undefined
        ? {}
        : { discoverNonDirectMcpSurfaces: options.discoverNonDirectMcpSurfaces }),
      listTools: async (caplet) => this.listTools(caplet),
      listResources: async (caplet) =>
        this.optionalMcpList(caplet, () => this.downstream.listResources(caplet, true)),
      listResourceTemplates: async (caplet) =>
        this.optionalMcpList(caplet, () => this.downstream.listResourceTemplates(caplet, true)),
      listPrompts: async (caplet) =>
        this.optionalMcpList(caplet, () => this.downstream.listPrompts(caplet, true)),
    });
    return this.lastExposureSnapshot;
  }

  currentExposureSnapshot(): ExposureSnapshot | undefined {
    return this.lastExposureSnapshot;
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
      caplet = this.registry.require(serverId);
      const result = await handleServerTool(
        caplet,
        request,
        this.registry,
        this.downstream,
        this.openapi,
        this.graphql,
        this.http,
        this.cli,
        this.capletSets,
        {
          observedOutputShapeStore: this.observedOutputShapeStore,
          observedOutputShapeScope: this.observedOutputShapeScope,
          projectFingerprint: this.projectFingerprint,
        },
        this.googleDiscovery,
      );
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
      caplet = this.registry.require(serverId);
      const result = await this.callTool(caplet, toolName, args);
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

  async readDirectResource(serverId: string, downstreamUri: string): Promise<unknown> {
    const started = Date.now();
    let caplet: CapletConfig | undefined;
    try {
      caplet = this.registry.require(serverId);
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
      caplet = this.registry.require(serverId);
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
    try {
      if (this.reloadTimer) {
        clearTimeout(this.reloadTimer);
        this.reloadTimer = undefined;
      }
      if (this.watcherRefreshTimer) {
        clearTimeout(this.watcherRefreshTimer);
        this.watcherRefreshTimer = undefined;
      }
      if (this.reloading) {
        await this.reloading;
      }
    } finally {
      this.closeWatchers();
      await this.downstream.close();
      await this.capletSets.close();
      await this.telemetry.dispatcher.shutdown();
      this.reloadListeners.clear();
    }
  }

  private async listCompletionTools(server: CapletConfig): Promise<ToolSummary[]> {
    const tools =
      server.backend === "mcp"
        ? await this.downstream.listTools(server)
        : server.backend === "openapi"
          ? await this.openapi.listTools(server)
          : server.backend === "googleDiscovery"
            ? await this.googleDiscovery.listTools(server)
            : server.backend === "graphql"
              ? await this.graphql.listTools(server)
              : server.backend === "http"
                ? await this.http.listTools(server)
                : server.backend === "cli"
                  ? await this.cli.listTools(server)
                  : await this.capletSets.listTools(server);
    return tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
    }));
  }

  private async listTools(server: CapletConfig) {
    return server.backend === "mcp"
      ? await this.downstream.listTools(server)
      : server.backend === "openapi"
        ? await this.openapi.listTools(server)
        : server.backend === "googleDiscovery"
          ? await this.googleDiscovery.listTools(server)
          : server.backend === "graphql"
            ? await this.graphql.listTools(server)
            : server.backend === "http"
              ? await this.http.listTools(server)
              : server.backend === "cli"
                ? await this.cli.listTools(server)
                : await this.capletSets.listTools(server);
  }

  private async callTool(server: CapletConfig, toolName: string, args: Record<string, unknown>) {
    return server.backend === "mcp"
      ? await this.downstream.callTool(server, toolName, args)
      : server.backend === "openapi"
        ? await this.openapi.callTool(server, toolName, args)
        : server.backend === "googleDiscovery"
          ? await this.googleDiscovery.callTool(server, toolName, args)
          : server.backend === "graphql"
            ? await this.graphql.callTool(server, toolName, args)
            : server.backend === "http"
              ? await this.http.callTool(server, toolName, args)
              : server.backend === "cli"
                ? await this.cli.callTool(server, toolName, args)
                : await this.capletSets.callTool(server, toolName, args);
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
    try {
      nextConfig = this.loadConfigWithWarnings();
    } catch (error) {
      this.writeErr(`Caplets config reload failed; keeping last known-good config.\n`);
      this.writeErr(`${JSON.stringify(toSafeError(error, "CONFIG_INVALID"), null, 2)}\n`);
      return false;
    }

    if (this.closed) {
      return false;
    }
    const previousConfig = this.registry.config;
    const nextRegistry = new ServerRegistry(nextConfig);
    this.registry = nextRegistry;
    this.telemetry.config = nextConfig;
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

  private loadConfigWithWarnings(): CapletsConfig {
    return this.configLoader(this.paths.configPath, this.paths.projectConfigPath, {
      writeWarning: (warning) => {
        this.writeErr(`Warning: ${warning.kind} at ${warning.path}: ${warning.message}\n`);
      },
    });
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
  artifactDir?: string;
  exposeLocalArtifactPaths?: boolean;
} {
  return {
    ...selectAuthOptions(options.authDir),
    ...(options.artifactDir ? { artifactDir: options.artifactDir } : {}),
    ...(options.exposeLocalArtifactPaths === false ? { exposeLocalArtifactPaths: false } : {}),
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
  return {
    ...result,
    _meta: {
      ...(isRecord(existingMeta) ? existingMeta : {}),
      caplets: {
        capletId: caplet.server,
        backend: caplet.backend,
        operation,
        exposure: "direct",
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
