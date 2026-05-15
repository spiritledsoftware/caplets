import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { version as packageJsonVersion } from "../package.json";
import { type CapletConfig, type CapletsConfig } from "./config.js";
import { CapletsEngine, type CapletsEngineOptions } from "./engine.js";
import { capabilityDescription } from "./registry.js";
import { generatedToolInputSchema } from "./tools.js";

type ToolServer = Pick<McpServer, "registerTool" | "connect" | "close">;

type CapletsRuntimeOptions = {
  configPath?: string;
  projectConfigPath?: string;
  authDir?: string;
  watchDebounceMs?: number;
  server?: ToolServer;
  writeErr?: (value: string) => void;
};

export class CapletsRuntime {
  readonly server: ToolServer;
  private readonly engine: CapletsEngine;
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly unsubscribeReload: () => void;

  constructor(options: CapletsRuntimeOptions = {}) {
    this.engine = new CapletsEngine(engineOptions(options));
    this.server =
      options.server ??
      new McpServer({
        name: "caplets",
        version: packageJsonVersion,
      });
    this.unsubscribeReload = this.engine.onReload(({ previous, next }) =>
      this.reconcileTools(previous, next),
    );
    this.reconcileTools(undefined, this.engine.currentConfig());
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  scheduleReload(): void {
    this.engine.scheduleReload();
  }

  async reload(): Promise<boolean> {
    return await this.engine.reload();
  }

  async close(): Promise<void> {
    this.unsubscribeReload();
    try {
      await this.engine.close();
    } finally {
      await this.server.close();
    }
  }

  currentConfig(): CapletsConfig {
    return this.engine.currentConfig();
  }

  registeredToolIds(): string[] {
    return [...this.tools.keys()].sort();
  }

  watchedPaths(): string[] {
    return this.engine.watchedPaths();
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
    return await this.engine.execute(serverId, request);
  }
}

function nextEnabledServers(config: CapletsConfig): CapletConfig[] {
  return [
    ...Object.values(config.mcpServers),
    ...Object.values(config.openapiEndpoints),
    ...Object.values(config.graphqlEndpoints),
    ...Object.values(config.httpApis),
    ...Object.values(config.cliTools),
  ].filter((server) => !server.disabled);
}

function capletById(config: CapletsConfig, serverId: string): CapletConfig | undefined {
  return (
    config.mcpServers[serverId] ??
    config.openapiEndpoints[serverId] ??
    config.graphqlEndpoints[serverId] ??
    config.httpApis[serverId] ??
    config.cliTools[serverId]
  );
}

function serializeCaplet(caplet: CapletConfig | undefined): string {
  return JSON.stringify(caplet ?? null);
}

function engineOptions(options: CapletsRuntimeOptions): CapletsEngineOptions {
  const engineOptions: CapletsEngineOptions = {};
  if (options.configPath !== undefined) {
    engineOptions.configPath = options.configPath;
  }
  if (options.projectConfigPath !== undefined) {
    engineOptions.projectConfigPath = options.projectConfigPath;
  }
  if (options.authDir !== undefined) {
    engineOptions.authDir = options.authDir;
  }
  if (options.watchDebounceMs !== undefined) {
    engineOptions.watchDebounceMs = options.watchDebounceMs;
  }
  if (options.writeErr !== undefined) {
    engineOptions.writeErr = options.writeErr;
  }
  return engineOptions;
}
