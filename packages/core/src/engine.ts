import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, join, parse } from "node:path";
import {
  createBackendOperationRuntime,
  type BackendOperationRuntime,
} from "./backend-operation-dispatch";
import { CapletSetManager } from "./caplet-sets";
import { CliToolsManager } from "./cli-tools";
import { findProjectRoot, fingerprintProjectRoot } from "./cloud/project-root";
import {
  type CapletConfig,
  type CapletsConfig,
  type ConfigVaultResolver,
  loadLocalRuntimeConfig,
  type LocalOverlayConfigWarning,
  resolveCapletsRoot,
  resolveConfigPath,
  resolveProjectConfigPath,
  runtimeFingerprintForConfig,
  vaultResolverForAuthDir,
} from "./config";
import { DEFAULT_OBSERVED_OUTPUT_SHAPE_CACHE_DIR } from "./config/paths";
import {
  resolvedExecutionFingerprintForConfig,
  type DeclaredInputReader,
} from "./caplet-source/runtime-fingerprint";
import type {
  ControlPlaneRuntimeSnapshot,
  ControlPlaneRuntimeSnapshotLoader,
} from "./control-plane/snapshot";
import type {
  ActivatedControlPlaneRead,
  ControlPlaneLiveOperationClass,
  ControlPlaneMaintenanceCoordinator,
  ControlPlaneStaleReadClass,
} from "./control-plane/service";
import {
  bindProductionSnapshotPublisher,
  createProductionControlPlane,
} from "./control-plane/production-runtime";
import type { ControlPlaneSecurityRepository } from "./control-plane/security/repository";
import type { CurrentHostManagementDependencies } from "./current-host/operations";
import type {
  ControlPlaneDetailedDiagnostics,
  ControlPlaneHealthSummary,
} from "./control-plane/types";
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

type ToolSummary = { name: string; description?: string };

export type ResolvedExposureProjection = {
  generation: number;
  projection: ExposureProjection;
};

export type CapletsEngineOptions = {
  configPath?: string;
  projectConfigPath?: string;
  authDir?: string;
  env?: NodeJS.ProcessEnv | undefined;
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

type InternalCapletsEngineInitialization = Readonly<{
  snapshot: ControlPlaneRuntimeSnapshot;
  loader: ControlPlaneRuntimeSnapshotLoader;
  close?: (() => Promise<void>) | undefined;
  management?: CurrentHostManagementDependencies | undefined;
  security?: ControlPlaneSecurityRepository | undefined;
  maintenance?: ControlPlaneMaintenanceCoordinator | undefined;
  health?: (() => Promise<ControlPlaneHealthSummary>) | undefined;
  detailedDiagnostics?:
    | ((reauthorize: () => Promise<boolean>) => Promise<ControlPlaneDetailedDiagnostics>)
    | undefined;
  vaultResolver?: ConfigVaultResolver | undefined;
  requireLive?: ((operation: ControlPlaneLiveOperationClass) => Promise<unknown>) | undefined;
  refresh?: (() => Promise<ControlPlaneRuntimeSnapshot>) | undefined;
  read?: ((operation: ControlPlaneStaleReadClass) => ActivatedControlPlaneRead) | undefined;
}>;
type NonActivatedCapletsEngineInitialization = Readonly<{
  mode: "filesystem-overlay" | "test";
}>;
type CapletsEngineInitialization =
  | InternalCapletsEngineInitialization
  | NonActivatedCapletsEngineInitialization;

/**
 * Production factory. Storage resolution, migrations, key/provider compatibility,
 * convergence registration, and the first complete SQL snapshot all finish before
 * the engine can be observed by any caller.
 */
export async function createCapletsEngine(
  options: CapletsEngineOptions = {},
): Promise<CapletsEngine> {
  const production = await createProductionControlPlane({
    configPath: options.configPath,
    projectConfigPath: options.projectConfigPath,
    authDir: options.authDir,
    env: options.env,
  });
  try {
    const engine = await createInternalCapletsEngine(
      { ...options, watch: false },
      production.loader,
      production.initialSnapshot,
      production.close,
      production.management,
      production.activated.health,
      production.activated.requireLive,
      production.security,
      production.activated.refresh,
      production.vaultResolver,
      production.activated.read,
      production.activated.detailedDiagnostics,
      production.maintenance,
    );
    bindProductionSnapshotPublisher(production, async (snapshot, publication) => {
      if (!(await engine.publishActivatedSnapshot(snapshot, publication.signal))) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "Activated SQL snapshot could not be published atomically.",
        );
      }
    });
    return engine;
  } catch (error) {
    await production.close().catch(() => undefined);
    throw error;
  }
}

/** Awaited internal/production seam. No engine is returned before a complete SQL snapshot exists. */
export async function createInternalCapletsEngine(
  options: CapletsEngineOptions,
  loader: ControlPlaneRuntimeSnapshotLoader,
  initializedSnapshot?: ControlPlaneRuntimeSnapshot,
  close?: (() => Promise<void>) | undefined,
  management?: CurrentHostManagementDependencies | undefined,
  health?: (() => Promise<ControlPlaneHealthSummary>) | undefined,
  requireLive?: ((operation: ControlPlaneLiveOperationClass) => Promise<unknown>) | undefined,
  security?: ControlPlaneSecurityRepository | undefined,
  refresh?: (() => Promise<ControlPlaneRuntimeSnapshot>) | undefined,
  vaultResolver?: ConfigVaultResolver | undefined,
  read?: ((operation: ControlPlaneStaleReadClass) => ActivatedControlPlaneRead) | undefined,
  detailedDiagnostics?:
    | ((reauthorize: () => Promise<boolean>) => Promise<ControlPlaneDetailedDiagnostics>)
    | undefined,
  maintenance?: ControlPlaneMaintenanceCoordinator | undefined,
): Promise<CapletsEngine> {
  const snapshot =
    initializedSnapshot ??
    (await loader.initialize({
      vaultResolver: vaultResolver ?? vaultResolverForAuthDir(options.authDir, options.env),
    }));
  return new CapletsEngine(options, {
    snapshot,
    loader,
    close,
    management,
    health,
    detailedDiagnostics,
    requireLive,
    security,
    maintenance,
    refresh,
    vaultResolver,
    read,
  });
}

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
  private runtimeSnapshot: ControlPlaneRuntimeSnapshot | undefined;
  private readonly runtimeSnapshotLoader: ControlPlaneRuntimeSnapshotLoader | undefined;
  private readonly closeActivatedControlPlane: (() => Promise<void>) | undefined;
  private readonly currentHostManagement: CurrentHostManagementDependencies | undefined;
  private readonly controlPlaneSecurity: ControlPlaneSecurityRepository | undefined;
  private readonly controlPlaneMaintenance: ControlPlaneMaintenanceCoordinator | undefined;
  private readonly runtimeVaultResolver: ConfigVaultResolver;
  private readonly activatedHealth: (() => Promise<ControlPlaneHealthSummary>) | undefined;
  private readonly activatedDetailedDiagnostics:
    | ((reauthorize: () => Promise<boolean>) => Promise<ControlPlaneDetailedDiagnostics>)
    | undefined;
  private readonly requireActivatedLive:
    | ((operation: ControlPlaneLiveOperationClass) => Promise<unknown>)
    | undefined;
  private readonly refreshActivatedControlPlane:
    | (() => Promise<ControlPlaneRuntimeSnapshot>)
    | undefined;
  private readonly activatedRead:
    | ((operation: ControlPlaneStaleReadClass) => ActivatedControlPlaneRead)
    | undefined;

  constructor(options: CapletsEngineOptions, internal: CapletsEngineInitialization) {
    const activated = "snapshot" in internal ? internal : undefined;
    this.paths = {
      configPath: resolveConfigPath(options.configPath),
      projectConfigPath: options.projectConfigPath ?? resolveProjectConfigPath(),
    };
    this.writeErr = options.writeErr ?? ((value: string) => process.stderr.write(value));
    this.runtimeVaultResolver =
      activated?.vaultResolver ?? vaultResolverForAuthDir(options.authDir, options.env);
    this.configLoader =
      options.configLoader ??
      runtimeConfigLoader(options.authDir, options.vaultRecoveryTarget, this.runtimeVaultResolver);
    this.declaredInputReader = options.declaredInputReader;
    this.requireValidCustomFingerprint = options.configLoader !== undefined;
    this.runtimeSnapshot = activated?.snapshot;
    this.runtimeSnapshotLoader = activated?.loader;
    this.closeActivatedControlPlane = activated?.close;
    this.currentHostManagement = activated?.management;
    this.controlPlaneSecurity = activated?.security;
    this.controlPlaneMaintenance = activated?.maintenance;
    const config = activated?.snapshot.config ?? this.loadConfigWithWarnings();
    this.activatedHealth = activated?.health;
    this.activatedDetailedDiagnostics = activated?.detailedDiagnostics;
    this.requireActivatedLive = activated?.requireLive;
    this.activatedRead = activated?.read;
    this.stableHostConfigurationFingerprint =
      runtimeFingerprintForConfig(config).hostConfigurationFingerprint;
    this.resolvedExecutionFingerprint = resolvedExecutionFingerprintForConfig(config);
    this.refreshActivatedControlPlane = activated?.refresh;
    this.registry = new ServerRegistry(config, activated?.snapshot.caplets);
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
    const authOptions = activated
      ? activated.security
        ? { authTokenRepository: activated.security }
        : {}
      : selectAuthOptions(options.authDir);
    const httpLikeOptions = selectHttpLikeOptions(options, activated?.security);
    this.downstream = new DownstreamManager(this.registry, {
      ...authOptions,
      projectBindingContext: options.projectBindingContext,
    });
    this.openapi = new OpenApiManager(this.registry, httpLikeOptions);
    this.googleDiscovery = new GoogleDiscoveryManager(this.registry, httpLikeOptions);
    this.graphql = new GraphQLManager(this.registry, httpLikeOptions);
    this.http = new HttpActionManager(this.registry, httpLikeOptions);
    this.cli = new CliToolsManager(this.registry, {
      projectBindingContext: options.projectBindingContext,
    });
    this.capletSets = new CapletSetManager(this.registry, {
      ...httpLikeOptions,
      vaultResolver: this.runtimeVaultResolver,
    });
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
  }

  /** @internal Explicit read-only filesystem overlay for remote/project composition. */
  static createFilesystemOverlay(options: CapletsEngineOptions): CapletsEngine {
    return new CapletsEngine(options, { mode: "filesystem-overlay" });
  }

  /** @internal Test-only unactivated engine seam. Production callers must use createCapletsEngine. */
  static unactivatedForTests(options: CapletsEngineOptions = {}): CapletsEngine {
    return new CapletsEngine(options, { mode: "test" });
  }

  currentConfig(): CapletsConfig {
    return this.registry.config;
  }

  currentControlPlaneRuntimeSnapshot(): ControlPlaneRuntimeSnapshot | undefined {
    return this.runtimeSnapshot;
  }

  currentHostManagementDependencies(): CurrentHostManagementDependencies | undefined {
    return this.currentHostManagement;
  }

  controlPlaneSecurityRepository(): ControlPlaneSecurityRepository | undefined {
    return this.controlPlaneSecurity;
  }

  /** @internal Local production orchestration only; never project into callable Caplet surfaces. */
  controlPlaneMaintenanceCoordinator(): ControlPlaneMaintenanceCoordinator | undefined {
    return this.controlPlaneMaintenance;
  }
  async controlPlaneHealth(): Promise<ControlPlaneHealthSummary | undefined> {
    return this.activatedHealth?.();
  }

  hasActivatedControlPlaneAuthority(): boolean {
    return this.runtimeSnapshotLoader !== undefined;
  }

  async requireLiveControlPlane(operation: ControlPlaneLiveOperationClass): Promise<void> {
    await this.requireActivatedLive?.(operation);
  }

  async controlPlaneDetailedDiagnostics(
    reauthorize: () => Promise<boolean>,
  ): Promise<ControlPlaneDetailedDiagnostics> {
    if (!this.activatedDetailedDiagnostics) {
      throw new CapletsError("SERVER_UNAVAILABLE", "Activated SQL diagnostics are unavailable.");
    }
    await this.requireLiveControlPlane("admin");
    return this.activatedDetailedDiagnostics(reauthorize);
  }

  controlPlaneRead(operation: ControlPlaneStaleReadClass): ActivatedControlPlaneRead | undefined {
    return this.activatedRead?.(operation);
  }

  async publishActivatedSnapshot(
    snapshot: ControlPlaneRuntimeSnapshot,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.runtimeSnapshotLoader) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Activated SQL snapshot publication requires the awaited runtime loader.",
      );
    }
    return this.applyReloadCandidate(snapshot.config, snapshot, false, signal);
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
      await this.requireActivatedLive?.("mutation");
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
      await this.requireActivatedLive?.("mutation");
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
      await this.requireActivatedLive?.("mutation");
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
      await this.requireActivatedLive?.("mutation");
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
      await this.requireActivatedLive?.("mutation");
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
    await this.requireActivatedLive?.("mutation");
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
      await this.closeActivatedControlPlane?.();
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
    if (this.closed) return false;
    let nextConfig: CapletsConfig;
    let nextRuntimeSnapshot: ControlPlaneRuntimeSnapshot | undefined;
    try {
      if (this.refreshActivatedControlPlane) {
        await this.refreshActivatedControlPlane();
        return true;
      }
      nextRuntimeSnapshot = this.runtimeSnapshotLoader
        ? await this.runtimeSnapshotLoader.reload({
            vaultResolver: this.runtimeVaultResolver,
          })
        : undefined;
      nextConfig = nextRuntimeSnapshot?.config ?? this.loadConfigWithWarnings();
    } catch (error) {
      this.writeErr(`Caplets config reload failed; keeping last known-good config.\n`);
      this.writeErr(`${JSON.stringify(toSafeError(error, "CONFIG_INVALID"), null, 2)}\n`);
      return false;
    }
    return this.applyReloadCandidate(nextConfig, nextRuntimeSnapshot, true);
  }

  private async applyReloadCandidate(
    nextConfig: CapletsConfig,
    nextRuntimeSnapshot: ControlPlaneRuntimeSnapshot | undefined,
    commitSnapshot: boolean,
    publicationSignal?: AbortSignal,
  ): Promise<boolean> {
    if (this.closed) return false;
    const nextStableHostConfigurationFingerprint =
      runtimeFingerprintForConfig(nextConfig).hostConfigurationFingerprint;
    const nextResolvedExecutionFingerprint = resolvedExecutionFingerprintForConfig(nextConfig);
    if (
      nextStableHostConfigurationFingerprint === this.stableHostConfigurationFingerprint &&
      nextResolvedExecutionFingerprint === this.resolvedExecutionFingerprint
    ) {
      if (publicationSignal?.aborted) return false;
      if (nextRuntimeSnapshot) {
        if (commitSnapshot && !this.runtimeSnapshotLoader?.commit(nextRuntimeSnapshot)) {
          return false;
        }
        const nextRegistry = this.registry.withRuntimeMetadata(
          nextConfig,
          nextRuntimeSnapshot.caplets,
        );
        this.registry = nextRegistry;
        this.runtimeSnapshot = nextRuntimeSnapshot;
        this.updateManagerRegistries(nextRegistry);
      }
      return true;
    }

    const previousConfig = this.registry.config;
    const nextRegistry = new ServerRegistry(nextConfig, nextRuntimeSnapshot?.caplets);
    let invalidated = true;
    try {
      await this.invalidateChangedBackends(previousConfig, nextConfig);
    } catch (error) {
      invalidated = false;
      const message = nextRuntimeSnapshot
        ? "Caplets backend invalidation failed; keeping last known-good config."
        : "Caplets backend invalidation failed; continuing reload.";
      this.writeErr(`${message}\n`);
      this.writeErr(`${JSON.stringify(toSafeError(error, "INTERNAL_ERROR"), null, 2)}\n`);
      if (nextRuntimeSnapshot) {
        return false;
      }
    }
    if (this.closed) {
      return false;
    }
    if (publicationSignal?.aborted) {
      return false;
    }
    if (
      nextRuntimeSnapshot &&
      commitSnapshot &&
      !this.runtimeSnapshotLoader?.commit(nextRuntimeSnapshot)
    ) {
      return false;
    }
    this.registry = nextRegistry;
    this.runtimeSnapshot = nextRuntimeSnapshot;
    this.updateManagerRegistries(nextRegistry);
    this.exposureGeneration += 1;
    this.telemetry.config = nextConfig;
    this.stableHostConfigurationFingerprint = nextStableHostConfigurationFingerprint;
    this.resolvedExecutionFingerprint = nextResolvedExecutionFingerprint;

    if (this.watchEnabled) this.resetWatchers();
    this.emitReload({ previous: previousConfig, next: nextConfig, invalidated });
    return invalidated;
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

  private updateManagerRegistries(registry: ServerRegistry): void {
    this.downstream.updateRegistry(registry);
    this.openapi.updateRegistry(registry);
    this.googleDiscovery.updateRegistry(registry);
    this.graphql.updateRegistry(registry);
    this.http.updateRegistry(registry);
    this.cli.updateRegistry(registry);
    this.capletSets.updateRegistry(registry);
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
  vaultResolver: ConfigVaultResolver = vaultResolverForAuthDir(authDir),
): NonNullable<CapletsEngineOptions["configLoader"]> {
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

function selectHttpLikeOptions(
  options: CapletsEngineOptions,
  authTokenRepository?: ControlPlaneSecurityRepository,
): {
  authDir?: string;
  authTokenRepository?: ControlPlaneSecurityRepository;
  artifactDir?: string;
  exposeLocalArtifactPaths?: boolean;
  mediaInlineThresholdBytes?: number;
  mediaArtifactMaxBytes?: number;
} {
  return {
    ...(authTokenRepository ? { authTokenRepository } : selectAuthOptions(options.authDir)),
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
