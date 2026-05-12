import { existsSync, watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
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
  private reloading: Promise<void> | undefined;
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
      await this.reloading;
    }
    this.reloading = this.reloadOnce().finally(() => {
      this.reloading = undefined;
    });
    await this.reloading;
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = undefined;
    }
    this.closeWatchers();
    await this.downstream.close();
    await this.server.close();
  }

  currentConfig(): CapletsConfig {
    return this.registry.config;
  }

  registeredToolIds(): string[] {
    return [...this.tools.keys()].sort();
  }

  watchedPaths(): string[] {
    return watchedPaths(this.paths)
      .map((entry) => entry.path)
      .sort();
  }

  private async reloadOnce(): Promise<void> {
    let nextConfig: CapletsConfig;
    try {
      nextConfig = loadConfig(this.paths.configPath, this.paths.projectConfigPath);
    } catch (error) {
      this.writeErr(`Caplets config reload failed; keeping last known-good config.\n`);
      this.writeErr(`${JSON.stringify(toSafeError(error, "CONFIG_INVALID"), null, 2)}\n`);
      return;
    }

    const previousConfig = this.registry.config;
    const nextRegistry = new ServerRegistry(nextConfig);
    await this.invalidateChangedBackends(previousConfig, nextConfig);
    this.registry = nextRegistry;
    this.downstream.updateRegistry(nextRegistry);
    this.openapi.updateRegistry(nextRegistry);
    this.graphql.updateRegistry(nextRegistry);
    this.reconcileTools(previousConfig, nextConfig);
    this.resetWatchers();
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
      if (
        before &&
        before.backend === "mcp" &&
        serializeCaplet(before) !== serializeCaplet(after)
      ) {
        await this.downstream.closeServer(serverId);
      }
      if (after?.backend === "openapi" && serializeCaplet(before) !== serializeCaplet(after)) {
        this.openapi.invalidate(serverId);
      }
      if (after?.backend === "graphql" && serializeCaplet(before) !== serializeCaplet(after)) {
        this.graphql.invalidate(serverId);
      }
      if (!after) {
        this.openapi.invalidate(serverId);
        this.graphql.invalidate(serverId);
      }
    }
  }

  private resetWatchers(): void {
    this.closeWatchers();
    for (const entry of watchedPaths(this.paths)) {
      if (!existsSync(entry.path)) {
        continue;
      }
      try {
        this.watchers.push(
          watch(entry.path, { persistent: true }, () => {
            this.scheduleReload();
          }),
        );
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
    if (seen.has(entry.path)) {
      continue;
    }
    seen.add(entry.path);
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
