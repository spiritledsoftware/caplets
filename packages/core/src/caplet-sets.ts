import type { Tool } from "@modelcontextprotocol/sdk/types";
import { resolve } from "node:path";
import {
  createBackendOperationRuntime,
  type BackendCallToolResult,
  type BackendOperationRuntime,
} from "./backend-operation-dispatch";
import { CliToolsManager } from "./cli-tools";
import {
  type CapletConfig,
  type CapletSetConfig,
  loadIsolatedConfig,
  vaultResolverForAuthDir,
} from "./config";
import {
  compactToolSafetyHints,
  compactToolSchemaHints,
  compactToolSelectionHints,
  DownstreamManager,
  type CompactTool,
} from "./downstream";
import { CapletsError, errorResult, toSafeError } from "./errors";
import { GoogleDiscoveryManager } from "./google-discovery";
import { GraphQLManager } from "./graphql";
import { HttpActionManager } from "./http-actions";
import { OpenApiManager } from "./openapi";
import { capabilityDescription, ServerRegistry } from "./registry";
import { generatedToolInputJsonSchema } from "./generated-tool-input-schema";
import { searchToolList } from "./tool-search";
import type { BackendAuthStateStore } from "./storage/backend-auth";
import { handleServerTool } from "./tools";

type ChildRuntime = {
  registry: ServerRegistry;
  downstream: DownstreamManager;
  capletSets: CapletSetManager;
  runtime: BackendOperationRuntime;
  cacheKey: string;
  configFingerprint: string;
  loadedAt: number;
};

export class CapletSetManager {
  private readonly children = new Map<string, ChildRuntime>();
  private readonly childRefreshLocks = new Map<string, Promise<ChildRuntime>>();

  constructor(
    private registry: ServerRegistry,
    private readonly options: {
      authDir?: string;
      backendAuth?: BackendAuthStateStore;
      artifactDir?: string;
      exposeLocalArtifactPaths?: boolean;
      mediaInlineThresholdBytes?: number;
      mediaArtifactMaxBytes?: number;
      ancestry?: Set<string>;
    } = {},
  ) {}

  updateRegistry(registry: ServerRegistry): void {
    this.registry = registry;
  }

  invalidate(serverId: string): void {
    const pending = this.childRefreshLocks.get(serverId);
    if (pending) {
      void pending.then(
        () => this.closeChild(serverId),
        () => this.closeChild(serverId),
      );
      return;
    }
    void this.closeChild(serverId);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.childRefreshLocks.values());
    await Promise.allSettled(
      [...this.children.keys()].map((serverId) => this.closeChild(serverId)),
    );
  }

  async checkSet(config: CapletSetConfig): Promise<{
    id: string;
    status: string;
    toolCount?: number;
    elapsedMs: number;
    error?: unknown;
  }> {
    const startedAt = Date.now();
    try {
      const child = await this.childRuntime(config, true);
      const childCaplets = child.registry.enabledServers();
      this.registry.setStatus(config.server, "available");
      return {
        id: config.server,
        status: "available",
        toolCount: childCaplets.length,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      const safe = toSafeError(error, "SERVER_UNAVAILABLE");
      this.registry.setStatus(config.server, "unavailable", safe);
      return {
        id: config.server,
        status: "unavailable",
        elapsedMs: Date.now() - startedAt,
        error: safe,
      };
    }
  }

  async listTools(config: CapletSetConfig): Promise<Tool[]> {
    const child = await this.childRuntime(config, false);
    return child.registry.enabledServers().map((caplet) => this.toTool(caplet));
  }

  async getTool(config: CapletSetConfig, toolName: string): Promise<Tool> {
    const child = await this.childRuntime(config, false);
    const caplet = child.registry.get(toolName);
    if (!caplet) {
      throw new CapletsError(
        "TOOL_NOT_FOUND",
        `Tool ${toolName} was not found on ${config.server}`,
        {
          server: config.server,
          tool: toolName,
          suggestions: nearbyCapletNames(child.registry.enabledServers(), toolName),
        },
      );
    }
    return this.toTool(caplet);
  }

  async callTool(
    config: CapletSetConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<BackendCallToolResult> {
    const child = await this.childRuntime(config, false);
    const caplet = child.registry.get(toolName);
    if (!caplet) {
      throw new CapletsError(
        "TOOL_NOT_FOUND",
        `Tool ${toolName} was not found on ${config.server}`,
        {
          server: config.server,
          tool: toolName,
          suggestions: nearbyCapletNames(child.registry.enabledServers(), toolName),
        },
      );
    }
    try {
      return await handleServerTool(caplet, args, child.registry, child.runtime);
    } catch (error) {
      return errorResult(error) as BackendCallToolResult;
    }
  }

  compact(config: CapletSetConfig, tool: Tool): CompactTool {
    return {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      hasInputSchema: Boolean(tool.inputSchema),
      hasOutputSchema: Boolean(tool.outputSchema),
      supportsFields: Boolean(tool.outputSchema),
      ...compactToolSelectionHints(tool),
      ...compactToolSchemaHints(tool),
      ...compactToolSafetyHints(tool),
    };
  }

  search(config: CapletSetConfig, tools: Tool[], query: string, limit: number): CompactTool[] {
    return searchToolList(tools, query, limit, (tool) => this.compact(config, tool));
  }

  private async childRuntime(config: CapletSetConfig, force: boolean): Promise<ChildRuntime> {
    const pending = this.childRefreshLocks.get(config.server);
    if (pending) {
      return pending;
    }

    const refresh = this.loadChildRuntime(config, force).finally(() => {
      this.childRefreshLocks.delete(config.server);
    });
    this.childRefreshLocks.set(config.server, refresh);
    return await refresh;
  }

  private async loadChildRuntime(config: CapletSetConfig, force: boolean): Promise<ChildRuntime> {
    const cacheKey = sourceKey(config);
    const existing = this.children.get(config.server);
    const now = Date.now();
    const isFresh =
      existing &&
      existing.cacheKey === cacheKey &&
      existing.configFingerprint === JSON.stringify(config) &&
      config.toolCacheTtlMs > 0 &&
      now - existing.loadedAt <= config.toolCacheTtlMs;
    if (existing && !force && isFresh) {
      return existing;
    }
    const ancestry = this.options.ancestry ?? new Set<string>();
    if (ancestry.has(cacheKey)) {
      throw new CapletsError("CONFIG_INVALID", "Nested Caplet set cycle detected", {
        server: config.server,
        source: cacheKey,
        ancestry: [...ancestry],
      });
    }

    let child: ChildRuntime;
    try {
      const childConfig = loadIsolatedConfig({
        ...(config.configPath ? { configPath: config.configPath } : {}),
        ...(config.capletsRoot ? { capletsRoot: config.capletsRoot } : {}),
        defaultSearchLimit: config.defaultSearchLimit,
        maxSearchLimit: config.maxSearchLimit,
        vaultResolver: vaultResolverForAuthDir(this.options.authDir),
      });
      const registry = new ServerRegistry(childConfig);
      const sharedOptions = {
        ...(this.options.authDir ? { authDir: this.options.authDir } : {}),
        ...(this.options.backendAuth ? { backendAuth: this.options.backendAuth } : {}),
        ...(this.options.artifactDir ? { artifactDir: this.options.artifactDir } : {}),
        ...(this.options.exposeLocalArtifactPaths === false
          ? { exposeLocalArtifactPaths: false }
          : {}),
        ...(this.options.mediaInlineThresholdBytes === undefined
          ? {}
          : { mediaInlineThresholdBytes: this.options.mediaInlineThresholdBytes }),
        ...(this.options.mediaArtifactMaxBytes === undefined
          ? {}
          : { mediaArtifactMaxBytes: this.options.mediaArtifactMaxBytes }),
      };
      const childAncestry = new Set([...ancestry, cacheKey]);
      const downstream = new DownstreamManager(registry, sharedOptions);
      const openapi = new OpenApiManager(registry, sharedOptions);
      const googleDiscovery = new GoogleDiscoveryManager(registry, sharedOptions);
      const graphql = new GraphQLManager(registry, sharedOptions);
      const http = new HttpActionManager(registry, sharedOptions);
      const cli = new CliToolsManager(registry);
      const capletSets = new CapletSetManager(registry, {
        ...sharedOptions,
        ancestry: childAncestry,
      });
      child = {
        registry,
        downstream,
        capletSets,
        runtime: createBackendOperationRuntime({
          mcp: downstream,
          openapi,
          googleDiscovery,
          graphql,
          http,
          cli,
          caplets: capletSets,
        }),
        cacheKey,
        configFingerprint: JSON.stringify(config),
        loadedAt: now,
      };
    } catch (error) {
      if (existing) {
        return existing;
      }
      throw error;
    }

    if (existing) {
      await this.closeChild(config.server);
    }
    this.children.set(config.server, child);
    this.registry.setStatus(config.server, "available");
    return child;
  }

  private async closeChild(serverId: string): Promise<void> {
    const child = this.children.get(serverId);
    this.children.delete(serverId);
    if (!child) {
      return;
    }
    await Promise.allSettled([child.downstream.close(), child.capletSets.close()]);
  }

  private toTool(caplet: CapletConfig): Tool {
    return {
      name: caplet.server,
      description: capabilityDescription(caplet),
      inputSchema: generatedToolInputJsonSchema() as unknown as Tool["inputSchema"],
    };
  }
}

function sourceKey(config: CapletSetConfig): string {
  return JSON.stringify({
    configPath: config.configPath ? resolve(config.configPath) : undefined,
    capletsRoot: config.capletsRoot ? resolve(config.capletsRoot) : undefined,
  });
}

function nearbyCapletNames(caplets: CapletConfig[], needle: string): string[] {
  const lower = needle.toLocaleLowerCase();
  return caplets
    .map((caplet) => caplet.server)
    .filter((name) => name.toLocaleLowerCase().includes(lower[0] ?? ""))
    .sort()
    .slice(0, 5);
}
