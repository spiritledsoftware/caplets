import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, join, parse } from "node:path";
import { CliToolsManager } from "./cli-tools.js";
import {
  type CapletConfig,
  type CapletsConfig,
  loadConfig,
  resolveCapletsRoot,
  resolveConfigPath,
  resolveProjectConfigPath,
} from "./config.js";
import { DownstreamManager } from "./downstream.js";
import { errorResult, toSafeError } from "./errors.js";
import { GraphQLManager } from "./graphql.js";
import { HttpActionManager } from "./http-actions.js";
import { OpenApiManager } from "./openapi.js";
import { ServerRegistry } from "./registry.js";
import { handleServerTool } from "./tools.js";

export type CapletsEngineOptions = {
  configPath?: string;
  projectConfigPath?: string;
  authDir?: string;
  watchDebounceMs?: number;
  watch?: boolean;
  writeErr?: (value: string) => void;
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
  private readonly graphql: GraphQLManager;
  private readonly http: HttpActionManager;
  private readonly cli: CliToolsManager;
  private readonly paths: RuntimePaths;
  private readonly watchDebounceMs: number;
  private readonly watchEnabled: boolean;
  private readonly writeErr: (value: string) => void;
  private readonly reloadListeners = new Set<(event: CapletsEngineReloadEvent) => void>();
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
    const config = loadConfig(this.paths.configPath, this.paths.projectConfigPath);
    this.registry = new ServerRegistry(config);
    this.downstream = new DownstreamManager(this.registry, selectAuthOptions(options.authDir));
    this.openapi = new OpenApiManager(this.registry, selectAuthOptions(options.authDir));
    this.graphql = new GraphQLManager(this.registry, selectAuthOptions(options.authDir));
    this.http = new HttpActionManager(this.registry, selectAuthOptions(options.authDir));
    this.cli = new CliToolsManager(this.registry);
    this.watchDebounceMs = options.watchDebounceMs ?? 250;
    this.watchEnabled = options.watch ?? true;
    this.writeErr = options.writeErr ?? ((value: string) => process.stderr.write(value));
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
    try {
      const caplet = this.registry.require(serverId);
      return await handleServerTool(
        caplet,
        request,
        this.registry,
        this.downstream,
        this.openapi,
        this.graphql,
        this.http,
        this.cli,
      );
    } catch (error) {
      return errorResult(error);
    }
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
      this.reloadListeners.clear();
    }
  }

  private async reloadOnce(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    let nextConfig: CapletsConfig;
    try {
      nextConfig = loadConfig(this.paths.configPath, this.paths.projectConfigPath);
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
    this.downstream.updateRegistry(nextRegistry);
    this.openapi.updateRegistry(nextRegistry);
    this.graphql.updateRegistry(nextRegistry);
    this.http.updateRegistry(nextRegistry);
    this.cli.updateRegistry(nextRegistry);

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
      if (before?.backend === "graphql" || after?.backend === "graphql" || !after) {
        this.graphql.invalidate(serverId);
      }
      if (before?.backend === "http" || after?.backend === "http" || !after) {
        this.http.invalidate(serverId);
      }
      if (before?.backend === "cli" || after?.backend === "cli" || !after) {
        this.cli.invalidate(serverId);
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
}

function selectAuthOptions(authDir: string | undefined): { authDir?: string } {
  return authDir ? { authDir } : {};
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
    ...Object.values(config.graphqlEndpoints),
    ...Object.values(config.httpApis),
    ...Object.values(config.cliTools),
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
