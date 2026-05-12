import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  CompatibilityCallToolResultSchema,
  type CompatibilityCallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { CapletServerConfig } from "./config.js";
import { classifyRemoteAuthError, oauthHeaders, staticRemoteHeaders } from "./auth.js";
import { CapletsError, toSafeError } from "./errors.js";
import type { ServerRegistry } from "./registry.js";

export type CompactTool = {
  server: string;
  tool: string;
  description?: string;
  annotations?: unknown;
  hasInputSchema: boolean;
};

type ManagedConnection = {
  client: Client;
  transport: { close(): Promise<void>; onclose?: () => void; onerror?: (error: Error) => void };
  tools?: Tool[];
  toolsFetchedAt?: number;
  restartingAfterDeath?: boolean;
};

export class DownstreamManager {
  private readonly connections = new Map<string, ManagedConnection>();
  private readonly restartState = new Map<string, { restartUsed: boolean; backoffUntil: number }>();

  constructor(
    private readonly registry: ServerRegistry,
    private readonly options: { authDir?: string } = {},
  ) {}

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.connections.values()].map((connection) => connection.transport.close()),
    );
    this.connections.clear();
  }

  async checkServer(server: CapletServerConfig): Promise<{
    server: string;
    status: string;
    toolCount?: number;
    elapsedMs: number;
    error?: unknown;
  }> {
    const startedAt = Date.now();
    try {
      const tools = await this.refreshTools(server, true);
      this.registry.setStatus(server.server, "available");
      return {
        server: server.server,
        status: "available",
        toolCount: tools.length,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      const safe = toSafeError(error, "SERVER_UNAVAILABLE");
      this.registry.setStatus(server.server, "unavailable", safe);
      return {
        server: server.server,
        status: "unavailable",
        elapsedMs: Date.now() - startedAt,
        error: safe,
      };
    }
  }

  async listTools(server: CapletServerConfig): Promise<Tool[]> {
    return this.refreshTools(server, false);
  }

  async getTool(server: CapletServerConfig, toolName: string): Promise<Tool> {
    const tools = await this.refreshTools(server, false);
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new CapletsError(
        "TOOL_NOT_FOUND",
        `Tool ${toolName} was not found on ${server.server}`,
        {
          server: server.server,
          tool: toolName,
          suggestions: nearbyToolNames(tools, toolName),
        },
      );
    }
    return tool;
  }

  async callTool(
    server: CapletServerConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CompatibilityCallToolResult> {
    await this.getTool(server, toolName);
    const connection = await this.connect(server);
    try {
      return await connection.client.callTool(
        { name: toolName, arguments: args },
        CompatibilityCallToolResultSchema,
        { timeout: server.callTimeoutMs },
      );
    } catch (error) {
      if (isTimeoutLike(error)) {
        throw new CapletsError(
          "TOOL_CALL_TIMEOUT",
          `Tool call timed out for ${server.server}/${toolName}`,
        );
      }
      throw new CapletsError(
        "DOWNSTREAM_TOOL_ERROR",
        `Downstream tool failed for ${server.server}/${toolName}`,
        toSafeError(error),
      );
    }
  }

  compact(server: CapletServerConfig, tool: Tool): CompactTool {
    return {
      server: server.server,
      tool: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      hasInputSchema: Boolean(tool.inputSchema),
    };
  }

  search(server: CapletServerConfig, tools: Tool[], query: string, limit: number): CompactTool[] {
    const needle = query.toLocaleLowerCase();
    return tools
      .filter((tool) =>
        `${tool.name}\n${tool.description ?? ""}`.toLocaleLowerCase().includes(needle),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, limit)
      .map((tool) => this.compact(server, tool));
  }

  private async refreshTools(server: CapletServerConfig, force: boolean): Promise<Tool[]> {
    const connection = await this.connect(server);
    const now = Date.now();
    const isFresh =
      connection.tools &&
      connection.toolsFetchedAt !== undefined &&
      server.toolCacheTtlMs > 0 &&
      now - connection.toolsFetchedAt <= server.toolCacheTtlMs;
    if (!force && isFresh) {
      return connection.tools ?? [];
    }

    try {
      const result = await connection.client.listTools(undefined, {
        timeout: server.startupTimeoutMs,
      });
      connection.tools = result.tools ?? [];
      connection.toolsFetchedAt = Date.now();
      this.registry.setStatus(server.server, "available");
      return result.tools ?? [];
    } catch (error) {
      const safe = toSafeError(
        error,
        isTimeoutLike(error) ? "SERVER_START_TIMEOUT" : "DOWNSTREAM_PROTOCOL_ERROR",
      );
      this.registry.setStatus(server.server, "unavailable", safe);
      throw new CapletsError(safe.code, `Could not list tools for ${server.server}`, safe);
    }
  }

  private async connect(server: CapletServerConfig): Promise<ManagedConnection> {
    const existing = this.connections.get(server.server);
    if (existing) {
      return existing;
    }
    const restart = this.restartState.get(server.server);
    if (restart && restart.restartUsed && Date.now() < restart.backoffUntil) {
      throw new CapletsError("SERVER_UNAVAILABLE", `${server.server} is in restart backoff`);
    }

    this.registry.setStatus(server.server, "starting");
    try {
      const client = new Client({ name: "caplets", version: "1.0.0" }, { capabilities: {} });
      const transport = this.createTransport(server);
      transport.onclose = () => {
        this.connections.delete(server.server);
        this.restartState.set(server.server, {
          restartUsed: true,
          backoffUntil: Date.now() + 1_000,
        });
        this.registry.setStatus(
          server.server,
          "unavailable",
          toSafeError(new CapletsError("SERVER_UNAVAILABLE", `${server.server} disconnected`)),
        );
      };
      transport.onerror = (error: Error) => {
        this.registry.setStatus(
          server.server,
          "unavailable",
          toSafeError(error, "SERVER_UNAVAILABLE"),
        );
      };
      await client.connect(transport, { timeout: server.startupTimeoutMs });
      const connection: ManagedConnection = { client, transport };
      this.connections.set(server.server, connection);
      this.registry.setStatus(server.server, "available");
      return connection;
    } catch (error) {
      const code = isTimeoutLike(error) ? "SERVER_START_TIMEOUT" : "SERVER_UNAVAILABLE";
      const safe = toSafeError(error, code);
      this.registry.setStatus(server.server, "unavailable", safe);
      throw new CapletsError(code, `Could not start ${server.server}`, safe);
    }
  }

  private createTransport(server: CapletServerConfig): any {
    if (server.transport === "stdio") {
      return new StdioClientTransport({
        command: server.command!,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env
          ? {
              env: Object.fromEntries(
                Object.entries({ ...process.env, ...server.env }).filter(
                  ([, value]) => value !== undefined,
                ),
              ) as Record<string, string>,
            }
          : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
        stderr: "pipe",
      });
    }

    if (!server.url) {
      throw new CapletsError("CONFIG_INVALID", `${server.server} is missing url`);
    }

    const headers = {
      ...staticRemoteHeaders(server),
      ...oauthHeaders(server, this.options.authDir),
    };
    const requestInit = Object.keys(headers).length ? { headers } : undefined;
    const fetchWithAuthClassification = async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const response = await fetch(input, init);
      const authError = classifyRemoteAuthError(server, response);
      if (authError) {
        throw authError;
      }
      return response;
    };
    if (server.transport === "http") {
      return new StreamableHTTPClientTransport(
        new URL(server.url),
        requestInit
          ? { requestInit, fetch: fetchWithAuthClassification }
          : { fetch: fetchWithAuthClassification },
      );
    }
    if (server.transport === "sse") {
      return new SSEClientTransport(
        new URL(server.url),
        requestInit
          ? { requestInit, fetch: fetchWithAuthClassification }
          : { fetch: fetchWithAuthClassification },
      );
    }

    throw new CapletsError("UNSUPPORTED_TRANSPORT", `Unsupported transport for ${server.server}`);
  }
}

function nearbyToolNames(tools: Tool[], needle: string): string[] {
  const lower = needle.toLocaleLowerCase();
  return tools
    .map((tool) => tool.name)
    .filter((name) => name.toLocaleLowerCase().includes(lower[0] ?? ""))
    .sort()
    .slice(0, 5);
}

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && /timeout|timed out|aborted/i.test(error.message);
}
