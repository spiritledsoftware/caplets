import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { version as packageJsonVersion } from "../../package.json";
import type { CapletConfig, CapletsConfig } from "../config";
import type { CapletsEngine } from "../engine";
import { capabilityDescription } from "../registry";
import { generatedToolInputSchema } from "../tools";

export type ToolServer = Pick<McpServer, "registerTool" | "connect" | "close">;

export type CapletsMcpSessionOptions = {
  server?: ToolServer;
};

export class CapletsMcpSession {
  readonly server: ToolServer;
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly unsubscribeReload: () => void;
  private closed = false;

  constructor(
    private readonly engine: CapletsEngine,
    options: CapletsMcpSessionOptions = {},
  ) {
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

  registeredToolIds(): string[] {
    return [...this.tools.keys()].sort();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.unsubscribeReload();
    this.tools.clear();
    await this.server.close();
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
    ...Object.values(config.capletSets),
  ].filter((server) => !server.disabled);
}

function capletById(config: CapletsConfig, serverId: string): CapletConfig | undefined {
  return (
    config.mcpServers[serverId] ??
    config.openapiEndpoints[serverId] ??
    config.graphqlEndpoints[serverId] ??
    config.httpApis[serverId] ??
    config.cliTools[serverId] ??
    config.capletSets[serverId]
  );
}

function serializeCaplet(caplet: CapletConfig | undefined): string {
  return JSON.stringify(caplet ?? null);
}
