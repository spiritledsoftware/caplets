import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadAuthorityBootstrap,
  resolveProjectCapletsRoot,
  resolveProjectConfigPath,
  resolveConfigPath,
  type AuthorityBootstrap,
  type AuthoritySecretResolver,
  type CapletsConfig,
  type ConfigSource,
  type LoadedAuthorityBootstrap,
  type ResolvedAuthoritySecrets,
} from "../config";
import {
  CapletsEngine,
  type CapletsEngineOptions,
  type ResolvedExposureProjection,
} from "../engine";
import { CapletsError, toSafeError, type SafeErrorSummary } from "../errors";
import { createAuthority, type AuthorityProviderContext } from "./factory";
import {
  composeRuntimeConfig,
  type AuthorityCompositionInput,
  type AuthoritySnapshot,
  type ComposedRuntimeConfig,
  type StagedConfigSource,
  loadStagedFilesystemSource,
} from "./composition";
import type {
  AuthorityCommitResult,
  AuthorityGeneration,
  AuthorityGenerationIdentity,
  AuthorityHead,
  AuthorityHealth,
  SemanticCommandEnvelope,
  WritableAuthority,
} from "./types";
import type { ContentAddressedBundleCache } from "./bundle-cache";

const MAX_REFRESH_INTERVAL_MS = 2_500;
const DEFAULT_READ_DEADLINE_MS = 1_000;
const DEFAULT_ACTIVATION_DEADLINE_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 2_500;

type TimerHandle = ReturnType<typeof setTimeout>;

type AuthorityLike<TSnapshot> = WritableAuthority<TSnapshot, unknown>;

type AuthorityBootstrapInput = AuthorityBootstrap | LoadedAuthorityBootstrap;

export type RuntimeEpochLease = {
  readonly view: PreparedRuntimeView;
  release(): void;
};

export type PreparedRuntimeViewOptions = {
  engine: CapletsEngine;
  authorityGeneration: AuthorityGeneration<AuthoritySnapshot> | null;
  exposureGeneration: number;
  stagedProvenance?: Record<string, { kind: string; path?: string | undefined }> | undefined;
  projection?: ResolvedExposureProjection | undefined;
  dispose?: (() => Promise<void>) | undefined;
};

/**
 * A completely prepared runtime. The view is immutable from the coordinator's
 * perspective; managers and projections are never mutated after activation.
 */
export class PreparedRuntimeView {
  readonly engine: CapletsEngine;
  readonly config: CapletsConfig;
  readonly authorityGeneration: AuthorityGeneration<AuthoritySnapshot> | null;
  readonly authorityGenerationId: string | null;
  readonly authoritySequence: number | null;
  readonly exposureGeneration: number;
  readonly stagedProvenance: Record<string, { kind: string; path?: string | undefined }>;
  readonly projection: ResolvedExposureProjection | undefined;

  private references = 0;
  private retired = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readonly dispose: () => Promise<void>;

  constructor(options: PreparedRuntimeViewOptions) {
    this.engine = options.engine;
    this.config = freezeValue(options.engine.currentConfig());
    this.authorityGeneration = options.authorityGeneration
      ? freezeGeneration(options.authorityGeneration)
      : null;
    this.authorityGenerationId = this.authorityGeneration?.id ?? null;
    this.authoritySequence = this.authorityGeneration?.sequence ?? null;
    this.exposureGeneration = options.exposureGeneration;
    this.stagedProvenance = freezeValue(options.stagedProvenance ?? {});
    this.projection = options.projection ? freezeValue(options.projection) : undefined;
    this.dispose = options.dispose ?? (async () => await options.engine.close());
  }

  get inFlight(): number {
    return this.references;
  }

  get isRetired(): boolean {
    return this.retired;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  retain(): RuntimeEpochLease {
    if (this.closed || this.retired) {
      throw new CapletsError("SERVER_UNAVAILABLE", "Runtime epoch is no longer available");
    }
    this.references += 1;
    let released = false;
    return {
      view: this,
      release: () => {
        if (released) return;
        released = true;
        this.references -= 1;
        if (this.retired && this.references === 0) void this.close();
      },
    };
  }

  /** Mark this view unavailable and close it once all leases are released. */
  async retire(): Promise<void> {
    this.retired = true;
    if (this.references === 0) await this.close();
  }

  /** Close an already retired view. Active views should be retired first. */
  async close(): Promise<void> {
    if (this.closed) return await this.closePromise;
    if (this.references > 0) return;
    this.closed = true;
    this.closePromise = Promise.resolve()
      .then(() => this.dispose())
      .catch((error: unknown) => {
        this.closed = false;
        this.closePromise = undefined;
        throw error;
      });
    return await this.closePromise;
  }
}

export type RuntimeCoordinatorHealth = AuthorityHealth & {
  lifecycle: "cold" | "ready" | "degraded" | "shutdown";
  readiness: "cold" | "ready" | "failed" | "pending" | "shutdown";
  observedGeneration: AuthorityGenerationIdentity | null;
  exposureGeneration: number | null;
  stagedFingerprint?: string;
  lag: number | null;
  lastError?: SafeErrorSummary;
};

export type RuntimeEpochCoordinatorOptions<TSnapshot = AuthoritySnapshot> = {
  authority?: AuthorityLike<TSnapshot> | undefined;
  authorityFactory?:
    | ((context: AuthorityProviderContext) => Promise<AuthorityLike<TSnapshot>>)
    | undefined;
  bootstrap?: AuthorityBootstrapInput | undefined;
  configPath?: string | undefined;
  projectConfigPath?: string | undefined;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined;
  secretResolver?: AuthoritySecretResolver | undefined;
  staged?: StagedConfigSource[] | undefined;
  stagedPaths?: string[] | undefined;
  stagedFingerprint?: string | undefined;
  bundleCache?: ContentAddressedBundleCache | undefined;
  engineOptions?: CapletsEngineOptions | undefined;
  engineFactory?:
    | ((
        config: CapletsConfig,
        options: CapletsEngineOptions,
      ) => CapletsEngine | Promise<CapletsEngine>)
    | undefined;
  projectionFactory?: ((engine: CapletsEngine) => Promise<ResolvedExposureProjection>) | undefined;
  readDeadlineMs?: number | undefined;
  activationDeadlineMs?: number | undefined;
  pollIntervalMs?: number | undefined;
  clock?: (() => number) | undefined;
  setTimeout?: ((handler: () => void, timeout: number) => TimerHandle) | undefined;
  clearTimeout?: ((timer: TimerHandle) => void) | undefined;
  autoRefresh?: boolean | undefined;
  signal?: AbortSignal | undefined;
};

type ResolvedCoordinatorOptions<TSnapshot> = RuntimeEpochCoordinatorOptions<TSnapshot> & {
  bootstrap: LoadedAuthorityBootstrap;
  configPath: string;
  projectConfigPath: string;
  secrets: ResolvedAuthoritySecrets;
  pollIntervalMs: number;
  readDeadlineMs: number;
  activationDeadlineMs: number;
  clock: () => number;
  setTimeout: (handler: () => void, timeout: number) => TimerHandle;
  clearTimeout: (timer: TimerHandle) => void;
};

export type RuntimeRefreshAtLeastResult = {
  status: "active" | "pending" | "degraded";
  activeGeneration: AuthorityGenerationIdentity | null;
  observedGeneration: AuthorityGenerationIdentity | null;
  exposureGeneration: number | null;
  lag: number | null;
};

/**
 * Coordinates provider reads and immutable runtime epochs. Construction is
 * synchronous, but `start` is deliberately async and does not expose a view
 * until the first valid generation has been prepared and activated.
 */
export class RuntimeEpochCoordinator<TSnapshot = AuthoritySnapshot> {
  readonly options: ResolvedCoordinatorOptions<TSnapshot>;
  readonly bootstrap: LoadedAuthorityBootstrap;

  private authorityInstance: AuthorityLike<TSnapshot> | undefined;
  private active: PreparedRuntimeView | undefined;
  private exposureGeneration = 0;
  private observed: AuthorityGenerationIdentity | null = null;
  private lifecycle: RuntimeCoordinatorHealth["lifecycle"] = "cold";
  private readiness: RuntimeCoordinatorHealth["readiness"] = "cold";
  private connectivity: AuthorityHealth["connectivity"] = "unavailable";
  private writable = false;
  private refreshState: AuthorityHealth["refresh"] = "failed";
  private stagedFingerprint: string | undefined;
  private lastError: SafeErrorSummary | undefined;
  private refreshInFlight: Promise<boolean> | undefined;
  private pendingRefresh = false;
  private pollTimer: TimerHandle | undefined;
  private pollBackoffMs: number;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(options: RuntimeEpochCoordinatorOptions<TSnapshot> = {}) {
    const configPath = resolveConfigPath(options.configPath);
    const projectConfigPath = options.projectConfigPath ?? resolveProjectConfigPath();
    const loaded = resolveLoadedBootstrap(options, configPath, projectConfigPath);
    const pollIntervalMs = boundedInterval(
      options.pollIntervalMs ?? loaded.bootstrap.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    );
    this.options = {
      ...options,
      bootstrap: loaded,
      configPath,
      projectConfigPath,
      secrets: loaded.secrets,
      pollIntervalMs,
      readDeadlineMs: boundedDeadline(
        options.readDeadlineMs ?? DEFAULT_READ_DEADLINE_MS,
        "provider read deadline",
      ),
      activationDeadlineMs: boundedDeadline(
        options.activationDeadlineMs ?? DEFAULT_ACTIVATION_DEADLINE_MS,
        "runtime activation deadline",
      ),
      clock: options.clock ?? Date.now,
      setTimeout: options.setTimeout ?? ((handler, timeout) => setTimeout(handler, timeout)),
      clearTimeout: options.clearTimeout ?? ((timer) => clearTimeout(timer)),
    };
    this.bootstrap = loaded;
    this.pollBackoffMs = pollIntervalMs;
  }

  get authority(): AuthorityLike<TSnapshot> | undefined {
    return this.authorityInstance;
  }

  get current(): PreparedRuntimeView | undefined {
    return this.active;
  }

  requireCurrent(): PreparedRuntimeView {
    if (!this.active || this.closed) {
      throw new CapletsError("SERVER_UNAVAILABLE", "No prepared runtime epoch is active");
    }
    return this.active;
  }

  /** Start provider initialization and activate the first valid generation. */
  async start(): Promise<PreparedRuntimeView> {
    if (this.closed) throw new CapletsError("SERVER_UNAVAILABLE", "Runtime coordinator is closed");
    if (this.active) return this.active;
    if (this.options.signal?.aborted) {
      throw new CapletsError("SERVER_UNAVAILABLE", "Runtime coordinator startup was aborted");
    }
    try {
      this.authorityInstance = await this.createAuthority();
      const activated = await this.refreshOnce(true);
      if (!activated || !this.active) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "Writable Authority has no valid committed generation; runtime startup is fail-closed",
          { readiness: this.readiness, refresh: this.refreshState },
        );
      }
      if (this.options.autoRefresh !== false) this.schedulePoll(this.pollBackoffMs);
      return this.active;
    } catch (error) {
      this.markFailure(error, false);
      await this.closeAuthority();
      throw error;
    }
  }

  /** Request a bounded refresh. Concurrent callers coalesce into one attempt. */
  async refresh(): Promise<boolean> {
    if (this.closed) return false;
    if (this.refreshInFlight) {
      this.pendingRefresh = true;
      return await this.refreshInFlight;
    }
    this.refreshInFlight = this.refreshLoop().finally(() => {
      this.refreshInFlight = undefined;
    });
    return await this.refreshInFlight;
  }

  /** Retain the current view for one request/session lifetime. */
  retain(): RuntimeEpochLease {
    return this.requireCurrent().retain();
  }

  /** Commit a provider-neutral semantic envelope without exposing the provider. */
  async commit<TResult = unknown>(
    envelope: SemanticCommandEnvelope<unknown>,
  ): Promise<AuthorityCommitResult<TResult>> {
    if (this.closed || !this.authorityInstance) {
      throw new CapletsError("SERVER_UNAVAILABLE", "Writable Authority is unavailable.");
    }
    const health = await this.health();
    if (!health.writable) {
      throw new CapletsError("SERVER_UNAVAILABLE", "Writable Authority is read-only.", {
        action: "read-only",
      });
    }
    return await this.authorityInstance.commit<TResult>(envelope);
  }

  /** Refresh until a committed generation is active or the bounded deadline expires. */
  async refreshAtLeast(
    generation: AuthorityGenerationIdentity,
  ): Promise<RuntimeRefreshAtLeastResult> {
    const activeIdentity = this.active?.authorityGeneration
      ? identityOf(this.active.authorityGeneration)
      : null;
    if (satisfiesGeneration(activeIdentity, generation)) {
      const health = await this.health();
      return {
        status: "active",
        activeGeneration: health.activeGeneration,
        observedGeneration: health.observedGeneration,
        exposureGeneration: health.exposureGeneration,
        lag: health.lag,
      };
    }

    const deadline =
      this.options.clock() + this.options.activationDeadlineMs + this.options.readDeadlineMs;
    while (!this.closed) {
      await this.refresh();
      const health = await this.health();
      if (satisfiesGeneration(health.activeGeneration, generation)) {
        return {
          status: "active",
          activeGeneration: health.activeGeneration,
          observedGeneration: health.observedGeneration,
          exposureGeneration: health.exposureGeneration,
          lag: health.lag,
        };
      }
      const now = this.options.clock();
      if (now >= deadline) {
        return {
          status: health.connectivity === "degraded" ? "degraded" : "pending",
          activeGeneration: health.activeGeneration,
          observedGeneration: health.observedGeneration,
          exposureGeneration: health.exposureGeneration,
          lag: health.lag,
        };
      }
      await this.waitForRefresh(Math.min(this.pollBackoffMs, deadline - now));
    }
    const health = await this.health();
    return {
      status: "degraded",
      activeGeneration: health.activeGeneration,
      observedGeneration: health.observedGeneration,
      exposureGeneration: health.exposureGeneration,
      lag: health.lag,
    };
  }

  private async waitForRefresh(delay: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.options.setTimeout(
        resolve,
        Math.min(MAX_REFRESH_INTERVAL_MS, Math.max(1, Math.floor(delay))),
      );
    });
  }

  async health(): Promise<RuntimeCoordinatorHealth> {
    let authorityHealth: AuthorityHealth | undefined;
    if (this.authorityInstance) {
      authorityHealth = await withDeadline(
        this.authorityInstance.health(),
        this.options.readDeadlineMs,
        "authority health",
      ).catch(() => undefined);
    }
    return {
      provider: authorityHealth?.provider ?? this.bootstrap.bootstrap.provider,
      authorityId: authorityHealth?.authorityId ?? this.bootstrap.bootstrap.authorityId,
      connectivity:
        this.lifecycle === "degraded"
          ? "degraded"
          : (authorityHealth?.connectivity ?? this.connectivity),
      writable: this.writable && (authorityHealth?.writable ?? true),
      activeGeneration: this.active?.authorityGeneration
        ? identityOf(this.active.authorityGeneration)
        : null,
      refresh: this.refreshState,
      lifecycle: this.lifecycle,
      readiness: this.readiness,
      observedGeneration: this.observed,
      exposureGeneration: this.active?.exposureGeneration ?? null,
      ...(this.stagedFingerprint ? { stagedFingerprint: this.stagedFingerprint } : {}),
      lag:
        this.active && this.observed
          ? Math.max(0, this.observed.sequence - this.active.authoritySequence!)
          : null,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(authorityHealth?.code ? { code: authorityHealth.code } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closed = true;
    this.lifecycle = "shutdown";
    this.readiness = "shutdown";
    this.refreshState = "failed";
    if (this.pollTimer) {
      this.options.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.closePromise = (async () => {
      if (this.refreshInFlight) await this.refreshInFlight.catch(() => undefined);
      const active = this.active;
      this.active = undefined;
      if (active) await active.retire().catch(() => undefined);
      await this.closeAuthority();
    })();
    return await this.closePromise;
  }

  private async refreshLoop(): Promise<boolean> {
    let activated = false;
    do {
      this.pendingRefresh = false;
      const result = await this.refreshOnce(false);
      activated = result || activated;
    } while (this.pendingRefresh && !this.closed);
    this.schedulePoll(this.pollBackoffMs);
    return activated;
  }

  private async refreshOnce(startup: boolean): Promise<boolean> {
    if (this.closed || !this.authorityInstance) return false;
    this.refreshState = "pending";
    const authority = this.authorityInstance;
    let head: AuthorityHead | null;
    try {
      head = await withDeadline(
        authority.readHead(),
        this.options.readDeadlineMs,
        "authority head read",
      );
      this.observed = head ? identityOf(head) : null;
      if (!head) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "Writable Authority has no committed generation; runtime startup is fail-closed",
        );
      }
      const activeGeneration = this.active?.authorityGeneration;
      if (activeGeneration && sameHead(head, activeGeneration)) {
        this.markHealthy(head, this.active?.authorityGeneration ?? null);
        return false;
      }
      if (activeGeneration && head.authorityId !== activeGeneration.authorityId) {
        throw new CapletsError(
          "CONFIG_INVALID",
          "Authority head changed to a different authority",
          {
            active: identityOf(activeGeneration),
            observed: identityOf(head),
          },
        );
      }
      if (activeGeneration && head.sequence <= activeGeneration.sequence) {
        throw new CapletsError(
          "CONFIG_INVALID",
          "Authority head regressed or changed at an equal sequence",
          {
            active: identityOf(activeGeneration),
            observed: identityOf(head),
          },
        );
      }
      const generation = await withDeadline(
        authority.readGeneration(head.id) as Promise<AuthorityGeneration<TSnapshot>>,
        this.options.readDeadlineMs,
        "authority generation read",
      );
      validateGeneration(head, generation);
      const view = await this.prepare(generation);
      if (this.closed) {
        await view.retire();
        return false;
      }
      this.activate(view);
      this.markHealthy(head, generation);
      this.pollBackoffMs = this.options.pollIntervalMs;
      return true;
    } catch (error) {
      this.markFailure(error, Boolean(this.active));
      if (startup && !this.active) throw error;
      this.pollBackoffMs = Math.min(
        MAX_REFRESH_INTERVAL_MS,
        Math.max(this.options.pollIntervalMs, this.pollBackoffMs * 2),
      );
      return false;
    }
  }
  private async prepare(generation: AuthorityGeneration<TSnapshot>): Promise<PreparedRuntimeView> {
    let composed: ComposedRuntimeConfig | undefined;
    let engine: CapletsEngine | undefined;
    try {
      composed = await withLateResultCleanup(
        this.compose(generation),
        this.options.activationDeadlineMs,
        "runtime preparation",
        (lateComposed) => lateComposed.releaseBundles(),
      );
      const engineOptions: CapletsEngineOptions = {
        ...this.options.engineOptions,
        configPath: this.options.configPath,
        projectConfigPath: this.options.projectConfigPath,
        watch: false,
        allowSharedAuthority: true,
        initialExposureGeneration: this.exposureGeneration + 1,
        configLoader: () => composed!.config,
      };
      engine = await withLateResultCleanup(
        Promise.resolve(
          this.options.engineFactory
            ? this.options.engineFactory(composed.config, engineOptions)
            : new CapletsEngine(engineOptions),
        ),
        this.options.activationDeadlineMs,
        "runtime manager activation",
        (lateEngine) => lateEngine.close(),
      );
      const projection = this.options.projectionFactory
        ? await withDeadline(
            this.options.projectionFactory(engine),
            this.options.activationDeadlineMs,
            "runtime projection",
          )
        : await withDeadline(
            engine.exposureProjection({ discoverNonDirectMcpSurfaces: false }),
            this.options.activationDeadlineMs,
            "runtime projection",
          );
      return new PreparedRuntimeView({
        engine,
        authorityGeneration: generation as AuthorityGeneration<AuthoritySnapshot>,
        exposureGeneration: this.exposureGeneration + 1,
        stagedProvenance: stagedProvenanceFromSources(composed.sources),
        projection,
        dispose: async () => {
          await Promise.allSettled([engine!.close(), composed!.releaseBundles()]);
        },
      });
    } catch (error) {
      if (engine) await engine.close().catch(() => undefined);
      if (composed) await composed.releaseBundles().catch(() => undefined);
      throw error;
    }
  }

  private async compose(
    generation: AuthorityGeneration<TSnapshot>,
  ): Promise<ComposedRuntimeConfig> {
    const staged = this.options.staged ?? this.loadStagedSources();
    const stagedFingerprint = this.options.stagedFingerprint ?? (await computeFingerprint(staged));
    this.stagedFingerprint = stagedFingerprint;
    const authority: AuthorityCompositionInput = {
      authorityId: this.bootstrap.bootstrap.authorityId,
      generation: generation as AuthorityGeneration<AuthoritySnapshot>,
      ...(this.options.bundleCache ? { bundleCache: this.options.bundleCache } : {}),
    };
    return await composeRuntimeConfig({ staged, stagedFingerprint, authority });
  }

  private loadStagedSources(): StagedConfigSource[] {
    const paths =
      this.options.stagedPaths ??
      this.bootstrap.inventory.entries
        .filter((entry) => entry.owner === "staged")
        .map((entry) => entry.path);
    const resolvedPaths =
      paths.length > 0
        ? paths
        : [
            this.options.projectConfigPath,
            resolveProjectCapletsRoot(this.options.projectConfigPath),
          ].filter((path): path is string => Boolean(path) && existsSync(path));
    const staged: StagedConfigSource[] = [];
    for (const path of resolvedPaths) {
      if (!existsSync(path)) continue;
      const info = statSync(path);
      staged.push(
        ...(info.isDirectory()
          ? loadStagedFilesystemSource({
              capletsRoot: path,
              configKind: "project-config",
              fileKind: "project-file",
            })
          : loadStagedFilesystemSource({
              configPath: path,
              configKind: "project-config",
              fileKind: "project-file",
            })),
      );
    }
    return staged;
  }

  private async createAuthority(): Promise<AuthorityLike<TSnapshot>> {
    if (this.options.authority) return this.options.authority;
    const context: AuthorityProviderContext = {
      bootstrap: this.bootstrap.bootstrap,
      secrets: this.bootstrap.secrets,
    };
    if (this.options.authorityFactory) return await this.options.authorityFactory(context);
    try {
      return (await createAuthority(context)) as AuthorityLike<TSnapshot>;
    } catch (error) {
      if (!(error instanceof CapletsError) || !error.message.includes("is not registered"))
        throw error;
      return (await createBuiltinAuthority(
        this.bootstrap,
        this.options.configPath,
      )) as AuthorityLike<TSnapshot>;
    }
  }
  private activate(view: PreparedRuntimeView): void {
    const previous = this.active;
    this.exposureGeneration = view.exposureGeneration;
    this.active = view;
    this.lifecycle = "ready";
    this.readiness = "ready";
    if (previous) void previous.retire().catch(() => undefined);
  }

  private markHealthy(head: AuthorityHead, generation: AuthorityGeneration<unknown> | null): void {
    this.connectivity = "healthy";
    this.writable = true;
    this.refreshState = "current";
    this.lifecycle = "ready";
    this.readiness = this.active ? "ready" : "pending";
    this.lastError = undefined;
    this.observed = identityOf(head);
    if (generation) this.observed = identityOf(generation);
  }

  private markFailure(error: unknown, hasKnownGood: boolean): void {
    const safe = toSafeError(error, "SERVER_UNAVAILABLE");
    this.lastError = safe;
    this.refreshState = "failed";
    this.connectivity = hasKnownGood ? "degraded" : "unavailable";
    this.writable = false;
    this.lifecycle = hasKnownGood ? "degraded" : "cold";
    this.readiness = hasKnownGood ? "ready" : "failed";
  }

  private schedulePoll(delay: number): void {
    if (this.closed || this.options.autoRefresh === false || this.pollTimer) return;
    this.pollTimer = this.options.setTimeout(
      () => {
        this.pollTimer = undefined;
        void this.refresh();
      },
      Math.min(MAX_REFRESH_INTERVAL_MS, Math.max(1, delay)),
    );
  }

  private async closeAuthority(): Promise<void> {
    const authority = this.authorityInstance;
    this.authorityInstance = undefined;
    if (authority) await authority.close().catch(() => undefined);
  }
}

export type PreparedRuntimeHost = {
  readonly coordinator: RuntimeEpochCoordinator;
  readonly view: PreparedRuntimeView;
  readonly engine: CapletsEngine;
  retain(): RuntimeEpochLease;
  refresh(): Promise<boolean>;
  refreshAtLeast(generation: AuthorityGenerationIdentity): Promise<RuntimeRefreshAtLeastResult>;
  commit<TResult = unknown>(
    envelope: SemanticCommandEnvelope<unknown>,
  ): Promise<AuthorityCommitResult<TResult>>;
  health(): Promise<RuntimeCoordinatorHealth>;
  close(): Promise<void>;
};

/** Assemble a host only after the first valid immutable epoch is active. */
export async function assembleCapletsHost<TSnapshot = AuthoritySnapshot>(
  options: RuntimeEpochCoordinatorOptions<TSnapshot> = {},
): Promise<PreparedRuntimeHost> {
  const coordinator = new RuntimeEpochCoordinator(options);
  await coordinator.start();
  return {
    coordinator: coordinator as RuntimeEpochCoordinator,
    get view() {
      return coordinator.requireCurrent();
    },
    get engine() {
      return coordinator.requireCurrent().engine;
    },
    refreshAtLeast: (generation) => coordinator.refreshAtLeast(generation),
    commit: (envelope) => coordinator.commit(envelope),
    retain: () => coordinator.retain(),
    refresh: () => coordinator.refresh(),
    health: () => coordinator.health(),
    close: () => coordinator.close(),
  };
}

export const createAsyncCapletsEngine = assembleCapletsHost;

function resolveLoadedBootstrap<TSnapshot>(
  options: RuntimeEpochCoordinatorOptions<TSnapshot>,
  configPath: string,
  projectConfigPath: string,
): LoadedAuthorityBootstrap {
  if (options.bootstrap && "bootstrap" in options.bootstrap) return options.bootstrap;
  if (options.bootstrap) {
    return {
      bootstrap: options.bootstrap,
      inventory: { entries: [{ path: configPath, owner: "authority" }] },
      secrets: resolveSecrets(options.bootstrap, options.secretResolver, options.env),
    };
  }
  if (options.authority && !existsSync(configPath)) {
    const authorityId =
      typeof options.authority === "object" &&
      options.authority !== null &&
      "authorityId" in options.authority &&
      typeof options.authority.authorityId === "string"
        ? options.authority.authorityId
        : "test-authority";
    return {
      bootstrap: {
        provider: "filesystem",
        authorityId,
        namespace: "default",
        pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      },
      inventory: { entries: [] },
      secrets: {},
    };
  }
  return loadAuthorityBootstrap(configPath, options.env, options.secretResolver, {
    projectPath: projectConfigPath,
  });
}

function resolveSecrets(
  bootstrap: AuthorityBootstrap,
  resolver: AuthoritySecretResolver | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
): ResolvedAuthoritySecrets {
  const resolveSecret = resolver ?? ((reference: string) => (env ?? process.env)[reference]);
  return {
    ...(bootstrap.credentialRef ? { credential: resolveSecret(bootstrap.credentialRef) } : {}),
    ...(bootstrap.vaultKeyRef ? { vaultKey: resolveSecret(bootstrap.vaultKeyRef) } : {}),
  };
}

async function createBuiltinAuthority(
  loaded: LoadedAuthorityBootstrap,
  configPath: string,
): Promise<WritableAuthority> {
  const bootstrap = loaded.bootstrap;
  if (bootstrap.provider === "filesystem") {
    // Provider modules must load only after the configured provider is selected.
    const { createFilesystemAuthority } = await import("./filesystem-authority");
    return await createFilesystemAuthority({
      root: resolve(resolveConfigPath(configPath), "..", "caplets"),
      authorityId: bootstrap.authorityId,
      namespace: bootstrap.namespace,
    });
  }
  if (bootstrap.provider === "sqlite") {
    // Provider modules must load only after the configured provider is selected.
    const { createSqliteAuthority } = await import("./sql/authority");
    return await createSqliteAuthority({
      databasePath: bootstrap.databasePath,
      authorityId: bootstrap.authorityId,
      namespace: bootstrap.namespace,
    });
  }
  if (bootstrap.provider === "postgresql") {
    const credential = loaded.secrets.credential;
    if (typeof credential !== "string") {
      throw new CapletsError(
        "CONFIG_INVALID",
        "PostgreSQL authority requires a resolved connection credential",
      );
    }
    // Provider modules must load only after the configured provider is selected.
    const { createPostgresAuthority } = await import("./sql/authority");
    return await createPostgresAuthority({
      connectionString: credential,
      authorityId: bootstrap.authorityId,
      namespace: bootstrap.namespace,
    });
  }
  const credential = loaded.secrets.credential;
  // Provider modules must load only after the configured provider is selected.
  const { createS3Authority } = await import("./s3-authority");
  return await createS3Authority({
    bucket: bootstrap.bucket,
    region: bootstrap.region,
    ...(bootstrap.endpoint ? { endpoint: bootstrap.endpoint } : {}),
    ...(bootstrap.forcePathStyle === undefined ? {} : { forcePathStyle: bootstrap.forcePathStyle }),
    ...(credential ? { credentialProvider: () => parseS3Credential(credential) } : {}),
    authorityId: bootstrap.authorityId,
    namespace: bootstrap.namespace,
  });
}

function parseS3Credential(value: string | Uint8Array): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
} {
  if (typeof value !== "string")
    throw new CapletsError("CONFIG_INVALID", "S3 credential is invalid");
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.accessKeyId !== "string" || typeof parsed.secretAccessKey !== "string")
      throw new Error("invalid");
    return {
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey,
      ...(typeof parsed.sessionToken === "string" ? { sessionToken: parsed.sessionToken } : {}),
    };
  } catch {
    throw new CapletsError(
      "CONFIG_INVALID",
      "S3 credential must resolve to a JSON access key pair",
    );
  }
}

function boundedInterval(value: number, label = "poll interval"): number {
  if (!Number.isFinite(value) || value < 1 || value > MAX_REFRESH_INTERVAL_MS) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `${label} must be between 1ms and ${MAX_REFRESH_INTERVAL_MS}ms`,
    );
  }
  return Math.floor(value);
}

function boundedDeadline(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 1 || value > MAX_REFRESH_INTERVAL_MS) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `${label} must be between 1ms and ${MAX_REFRESH_INTERVAL_MS}ms`,
    );
  }
  return Math.floor(value);
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: TimerHandle | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new CapletsError("SERVER_START_TIMEOUT", `${label} exceeded ${timeoutMs}ms`)),
        timeoutMs,
      );
      void promise.then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
  }
}

async function withLateResultCleanup<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  cleanup: (value: T) => Promise<void> | void,
): Promise<T> {
  let timer: TimerHandle | undefined;
  let expired = false;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new CapletsError("SERVER_START_TIMEOUT", `${label} exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      void promise.then(
        (value) => {
          if (expired) {
            void Promise.resolve()
              .then(() => cleanup(value))
              .catch(() => undefined);
          } else {
            resolve(value);
          }
        },
        (error: unknown) => {
          if (!expired) reject(error);
        },
      );
    });
  } finally {
    clearTimeout(timer);
  }
}

function validateGeneration<TSnapshot>(
  head: AuthorityHead,
  generation: AuthorityGeneration<TSnapshot>,
): void {
  if (
    generation.authorityId !== head.authorityId ||
    generation.id !== head.id ||
    generation.sequence !== head.sequence ||
    generation.predecessorId !== head.predecessorId ||
    generation.digest !== head.digest
  ) {
    throw new CapletsError("CONFIG_INVALID", "Authority head and generation identity do not match");
  }
  if (!Number.isSafeInteger(generation.sequence) || generation.sequence < 1) {
    throw new CapletsError("CONFIG_INVALID", "Authority generation sequence is invalid");
  }
}

function sameHead(head: AuthorityHead, generation: AuthorityGeneration<unknown>): boolean {
  return (
    head.authorityId === generation.authorityId &&
    head.id === generation.id &&
    head.sequence === generation.sequence &&
    head.predecessorId === generation.predecessorId &&
    head.digest === generation.digest
  );
}

function sameGenerationIdentity(
  left: AuthorityGenerationIdentity | null,
  right: AuthorityGenerationIdentity | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.authorityId === right.authorityId &&
    left.id === right.id &&
    left.sequence === right.sequence &&
    left.predecessorId === right.predecessorId
  );
}

function satisfiesGeneration(
  active: AuthorityGenerationIdentity | null,
  requested: AuthorityGenerationIdentity,
): boolean {
  return (
    sameGenerationIdentity(active, requested) ||
    Boolean(
      active &&
      active.authorityId === requested.authorityId &&
      active.sequence > requested.sequence,
    )
  );
}
function identityOf(
  value: AuthorityHead | AuthorityGenerationIdentity | AuthorityGeneration<unknown>,
): AuthorityGenerationIdentity {
  return {
    authorityId: value.authorityId,
    id: value.id,
    sequence: value.sequence,
    predecessorId: value.predecessorId,
  };
}

function freezeGeneration<TSnapshot>(
  generation: AuthorityGeneration<TSnapshot>,
): AuthorityGeneration<AuthoritySnapshot> {
  return freezeValue({
    ...generation,
    snapshot: freezeValue(generation.snapshot) as AuthoritySnapshot,
  }) as AuthorityGeneration<AuthoritySnapshot>;
}

function freezeValue<T>(value: T): T {
  if (!value || typeof value !== "object" || ArrayBuffer.isView(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) freezeValue(nested);
  return Object.freeze(value);
}

async function computeFingerprint(staged: StagedConfigSource[]): Promise<string> {
  const paths = staged
    .map((source) => source.fingerprintPath)
    .filter((path): path is string => Boolean(path));
  if (paths.length === 0) return "sha256:empty";
  const { computeStagedFingerprint } = await import("./composition");
  return await computeStagedFingerprint(paths);
}

export type { AuthoritySnapshot, ComposedRuntimeConfig, StagedConfigSource } from "./composition";
export type { AuthorityProviderKind } from "./types";
function stagedProvenanceFromSources(
  sources: Record<string, ConfigSource>,
): Record<string, { kind: string; path?: string | undefined }> {
  const staged: Record<string, { kind: string; path?: string | undefined }> = {};
  for (const [id, source] of Object.entries(sources)) {
    if (source.kind === "authority") continue;
    staged[id] = { kind: source.kind, path: source.path };
  }
  return staged;
}
