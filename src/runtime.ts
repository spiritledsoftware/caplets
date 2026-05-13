import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, parse } from "node:path";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { version as packageJsonVersion } from "../package.json";
import {
  type CapletConfig,
  type CapletsConfig,
  loadConfig,
  resolveCapletsRoot,
  resolveConfigPath,
  resolveProjectConfigPath,
  TRUST_PROJECT_CAPLETS_ENV,
  isTrustedEnvEnabled,
} from "./config.js";
import { DownstreamManager } from "./downstream.js";
import { errorResult, toSafeError } from "./errors.js";
import { GraphQLManager } from "./graphql.js";
import { OpenApiManager } from "./openapi.js";
import { capabilityDescription, ServerRegistry } from "./registry.js";
import { generatedToolInputSchema, handleServerTool } from "./tools.js";

type ToolServer = Pick<McpServer, "registerTool" | "connect" | "close">;

type RuntimePaths = {
  configPath: string;
  projectConfigPath: string;
};

type CapletsRuntimeOptions = {
  configPath?: string;
  projectConfigPath?: string;
  authDir?: string;
  watchDebounceMs?: number;
  server?: ToolServer;
  writeErr?: (value: string) => void;
};

type WatchedPath = {
  path: string;
  reason: "config" | "caplets";
};

export class CapletsRuntime {
  readonly server: ToolServer;
  private registry: ServerRegistry;
  private readonly downstream: DownstreamManager;
  private readonly openapi: OpenApiManager;
  private readonly graphql: GraphQLManager;
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly paths: RuntimePaths;
  private readonly watchDebounceMs: number;
  private readonly writeErr: (value: string) => void;
  private watchers: FSWatcher[] = [];
  private reloadTimer: NodeJS.Timeout | undefined;
  private watcherRefreshTimer: NodeJS.Timeout | undefined;
  private reloading: Promise<boolean> | undefined;
  private pendingReload = false;
  private closed = false;

  constructor(options: CapletsRuntimeOptions = {}) {
    this.paths = {
      configPath: resolveConfigPath(options.configPath),
      projectConfigPath: options.projectConfigPath ?? resolveProjectConfigPath(),
    };
    const config = loadConfig(this.paths.configPath, this.paths.projectConfigPath);
    this.registry = new ServerRegistry(config);
    this.downstream = new DownstreamManager(this.registry, selectAuthOptions(options.authDir));
    this.openapi = new OpenApiManager(this.registry, selectAuthOptions(options.authDir));
    this.graphql = new GraphQLManager(this.registry, selectAuthOptions(options.authDir));
    this.server =
      options.server ??
      new McpServer({
        name: "caplets",
        version: packageJsonVersion,
      });
    this.watchDebounceMs = options.watchDebounceMs ?? 250;
    this.writeErr = options.writeErr ?? ((value: string) => process.stderr.write(value));
    this.reconcileTools(undefined, config);
    this.resetWatchers();
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
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
      await this.server.close();
    }
  }

  currentConfig(): CapletsConfig {
    return this.registry.config;
  }

  registeredToolIds(): string[] {
    return [...this.tools.keys()].sort();
  }

  watchedPaths(): string[] {
    return [...new Set(watchedPaths(this.paths).map((entry) => entry.path))].sort();
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
    this.reconcileTools(previousConfig, nextConfig);
    this.resetWatchers();
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

  private reconcileTools(previous: CapletsConfig | undefined, next: CapletsConfig): void {
    const enabled = new Map(nextEnabledServers(next).map((server) => [server.server, server]));

    for (const [serverId, tool] of this.tools) {
      const caplet = enabled.get(serverId);
      if (!caplet) {
        tool.remove();
        this.tools.delete(serverId);
        continue;
      }

      const previousCaplet = previous ? capletById(previous, serverId) : undefined;
      if (!previousCaplet || serializeCaplet(previousCaplet) !== serializeCaplet(caplet)) {
        tool.update({
          title: caplet.name,
          description: capabilityDescription(caplet),
          callback: async (request) => this.handleTool(serverId, request),
          enabled: true,
        });
      }
    }

    for (const caplet of enabled.values()) {
      if (this.tools.has(caplet.server)) {
        continue;
      }
      this.tools.set(caplet.server, this.registerCapletTool(caplet));
    }
  }

  private registerCapletTool(caplet: CapletConfig): RegisteredTool {
    return this.server.registerTool(
      caplet.server,
      {
        title: caplet.name,
        description: capabilityDescription(caplet),
        inputSchema: generatedToolInputSchema,
      },
      async (request) => this.handleTool(caplet.server, request),
    );
  }

  private async handleTool(serverId: string, request: unknown): Promise<any> {
    try {
      const caplet = this.registry.require(serverId);
      return await handleServerTool(
        caplet,
        request,
        this.registry,
        this.downstream,
        this.openapi,
        this.graphql,
      );
    } catch (error) {
      return errorResult(error);
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
        // Clean up any watchers created so far before rethrowing
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
  const entries: WatchedPath[] = [
    { path: dirname(paths.configPath), reason: "config" },
    { path: dirname(paths.projectConfigPath), reason: "config" },
    { path: resolveCapletsRoot(paths.configPath), reason: "caplets" },
  ];
  if (isTrustedEnvEnabled(process.env[TRUST_PROJECT_CAPLETS_ENV])) {
    entries.push({ path: dirname(paths.projectConfigPath), reason: "caplets" });
  }

  return uniqueWatchedPaths(entries);
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
  ];
}

function nextEnabledServers(config: CapletsConfig): CapletConfig[] {
  return allCaplets(config).filter((server) => !server.disabled);
}

function capletById(config: CapletsConfig, serverId: string): CapletConfig | undefined {
  return (
    config.mcpServers[serverId] ??
    config.openapiEndpoints[serverId] ??
    config.graphqlEndpoints[serverId]
  );
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
      directories.push(...discoverDirectories(`${root}/${entry.name}`));
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
