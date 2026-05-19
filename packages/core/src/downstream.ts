import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  CompatibilityCallToolResultSchema,
  type CompatibilityCallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { CapletServerConfig } from "./config";
import {
  classifyRemoteAuthError,
  FileOAuthProvider,
  readTokenBundle,
  staticRemoteHeaders,
} from "./auth";
import { CapletsError, toSafeError } from "./errors";
import type { ServerRegistry } from "./registry";
import { searchToolList } from "./tool-search";

export type CompactTool = {
  id: string;
  tool: string;
  description?: string;
  hasInputSchema: boolean;
  hasOutputSchema: boolean;
};

type ManagedConnection = {
  client: Client;
  transport: { close(): Promise<void>; onclose?: () => void; onerror?: (error: Error) => void };
  configFingerprint: string;
  tools?: Tool[];
  toolsFetchedAt?: number;
  restartingAfterDeath?: boolean;
  closing?: boolean;
};

export class DownstreamManager {
  private readonly connections = new Map<string, ManagedConnection>();
  private readonly connecting = new Map<string, ManagedConnection>();
  private readonly restartState = new Map<string, { restartUsed: boolean; backoffUntil: number }>();

  constructor(
    private registry: ServerRegistry,
    private readonly options: { authDir?: string } = {},
  ) {}

  updateRegistry(registry: ServerRegistry): void {
    this.registry = registry;
  }

  async close(): Promise<void> {
    const connections = [...this.connections.values(), ...this.connecting.values()];
    for (const connection of connections) {
      connection.closing = true;
    }
    await Promise.allSettled(connections.map((connection) => connection.transport.close()));
    this.connections.clear();
    this.connecting.clear();
  }

  async closeServer(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId) ?? this.connecting.get(serverId);
    this.connections.delete(serverId);
    this.connecting.delete(serverId);
    this.restartState.delete(serverId);
    if (connection) {
      connection.closing = true;
      await connection.transport.close();
    }
  }

  async checkServer(server: CapletServerConfig): Promise<{
    id: string;
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
        id: server.server,
        status: "available",
        toolCount: tools.length,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      const safe = toSafeError(error, "SERVER_UNAVAILABLE");
      this.registry.setStatus(server.server, "unavailable", safe);
      return {
        id: server.server,
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
      if (isAuthRemediationError(error)) {
        this.registry.setStatus(server.server, "unavailable", toSafeError(error));
        throw error;
      }
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
      id: server.server,
      tool: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      hasInputSchema: Boolean(tool.inputSchema),
      hasOutputSchema: Boolean(tool.outputSchema),
    };
  }

  search(server: CapletServerConfig, tools: Tool[], query: string, limit: number): CompactTool[] {
    return searchToolList(tools, query, limit, (tool) => this.compact(server, tool));
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
      if (isAuthRemediationError(error)) {
        throw error;
      }
      throw new CapletsError(safe.code, `Could not list tools for ${server.server}`, safe);
    }
  }

  private async connect(server: CapletServerConfig): Promise<ManagedConnection> {
    const expectedFingerprint = this.currentServerFingerprint(server);
    const existing = this.connections.get(server.server);
    if (existing) {
      if (existing.configFingerprint !== expectedFingerprint) {
        this.connections.delete(server.server);
        existing.closing = true;
        await existing.transport.close();
      } else {
        return existing;
      }
    }
    if (this.currentServerFingerprint(server) !== expectedFingerprint) {
      throw staleServerConfigError(server.server);
    }
    const currentServer = this.currentServer(server.server);
    if (!sameServerConfig(currentServer, server)) {
      throw staleServerConfigError(server.server);
    }
    const restart = this.restartState.get(server.server);
    if (restart && restart.restartUsed && Date.now() < restart.backoffUntil) {
      throw new CapletsError("SERVER_UNAVAILABLE", `${server.server} is in restart backoff`);
    }

    this.registry.setStatus(server.server, "starting");
    let pendingConnection: ManagedConnection | undefined;
    try {
      const client = new Client({ name: "caplets", version: "1.0.0" }, { capabilities: {} });
      const transport = this.createTransport(server);
      const connection: ManagedConnection = {
        client,
        transport,
        configFingerprint: expectedFingerprint,
      };
      pendingConnection = connection;
      this.connecting.set(server.server, connection);
      transport.onclose = () => {
        const current = this.connections.get(server.server);
        if (current === connection) {
          this.connections.delete(server.server);
        }
        if (connection.closing) {
          return;
        }
        if (current !== connection) {
          return;
        }
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
        if (connection.closing) {
          return;
        }
        if (this.connections.get(server.server) !== connection) {
          return;
        }
        this.registry.setStatus(
          server.server,
          "unavailable",
          toSafeError(error, "SERVER_UNAVAILABLE"),
        );
      };
      await client.connect(transport, { timeout: server.startupTimeoutMs });
      if (connection.closing) {
        await transport.close();
        throw new CapletsError("SERVER_UNAVAILABLE", `${server.server} connection was closed`);
      }
      if (this.currentServerFingerprint(server) !== expectedFingerprint) {
        connection.closing = true;
        await transport.close();
        throw staleServerConfigError(server.server);
      }
      if (this.connecting.get(server.server) !== connection) {
        connection.closing = true;
        await transport.close();
        throw new CapletsError("SERVER_UNAVAILABLE", `${server.server} connection was replaced`);
      }
      this.connecting.delete(server.server);
      this.connections.set(server.server, connection);
      this.registry.setStatus(server.server, "available");
      return connection;
    } catch (error) {
      if (pendingConnection && this.connecting.get(server.server) === pendingConnection) {
        this.connecting.delete(server.server);
      }
      const code = isTimeoutLike(error) ? "SERVER_START_TIMEOUT" : "SERVER_UNAVAILABLE";
      const safe = toSafeError(error, code);
      this.registry.setStatus(server.server, "unavailable", safe);
      if (isAuthRemediationError(error)) {
        throw error;
      }
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

    const headers = staticRemoteHeaders(server);
    const requestInit = Object.keys(headers).length ? { headers } : undefined;
    const authProvider = this.oauthProvider(server);
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
    const fetchWithOAuthAuthClassification = async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const response = await fetch(input, init);
      if (response.status === 403) {
        const authError = classifyRemoteAuthError(server, response);
        if (authError) {
          throw authError;
        }
      }
      return response;
    };
    if (server.transport === "http") {
      return new StreamableHTTPClientTransport(new URL(server.url), {
        ...(requestInit ? { requestInit } : {}),
        ...(authProvider ? { authProvider } : {}),
        fetch: authProvider ? fetchWithOAuthAuthClassification : fetchWithAuthClassification,
      });
    }
    if (server.transport === "sse") {
      return new SSEClientTransport(new URL(server.url), {
        ...(requestInit ? { requestInit } : {}),
        ...(authProvider ? { authProvider } : {}),
        fetch: authProvider ? fetchWithOAuthAuthClassification : fetchWithAuthClassification,
      });
    }

    throw new CapletsError("UNSUPPORTED_TRANSPORT", `Unsupported transport for ${server.server}`);
  }

  private oauthProvider(server: CapletServerConfig): FileOAuthProvider | undefined {
    if (server.auth?.type !== "oauth2" && server.auth?.type !== "oidc") {
      return undefined;
    }
    const bundle = readTokenBundle(server.server, this.options.authDir);
    if (!bundle?.accessToken && !bundle?.refreshToken) {
      throw new CapletsError("AUTH_REQUIRED", `OAuth credentials required for ${server.server}`, {
        server: server.server,
        authType: server.auth.type,
        nextAction: "run_caplets_auth_login",
      });
    }
    return new FileOAuthProvider(
      server,
      server.auth.redirectUri ?? "http://127.0.0.1/callback",
      (_url: URL) => {
        throw new CapletsError("AUTH_REQUIRED", `OAuth credentials required for ${server.server}`, {
          server: server.server,
          authType: server.auth?.type,
          nextAction: "run_caplets_auth_login",
        });
      },
      this.options.authDir,
    );
  }

  private currentServer(serverId: string): CapletServerConfig {
    const current = this.registry.require(serverId);
    if (current.backend !== "mcp") {
      throw staleServerConfigError(serverId);
    }
    return current;
  }

  private currentServerFingerprint(server: CapletServerConfig): string {
    const current = this.currentServer(server.server);
    if (!sameServerConfig(current, server)) {
      throw staleServerConfigError(server.server);
    }
    return serializeServerConfig(current);
  }
}

function sameServerConfig(left: CapletServerConfig, right: CapletServerConfig): boolean {
  return serializeServerConfig(left) === serializeServerConfig(right);
}

function serializeServerConfig(server: CapletServerConfig): string {
  return JSON.stringify(server);
}

function staleServerConfigError(serverId: string): CapletsError {
  return new CapletsError("SERVER_UNAVAILABLE", `${serverId} configuration changed; retry request`);
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

function isAuthRemediationError(error: unknown): error is CapletsError {
  return (
    error instanceof CapletsError &&
    (error.code === "AUTH_REQUIRED" || error.code === "AUTH_FAILED")
  );
}
