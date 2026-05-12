import type { CapletConfig, CapletsConfig, CapletServerConfig } from "./config.js";
import type { SafeErrorSummary } from "./errors.js";

export type ServerStatus = "disabled" | "not_started" | "starting" | "available" | "unavailable";

export type CapletServerSummary = {
  server: string;
  name: string;
  description: string;
  disabled?: boolean;
  status: ServerStatus;
  lastError?: SafeErrorSummary;
};

export type CapletServerDetail = {
  caplet: string;
  name: string;
  description: string;
  tags?: string[];
  body?: string;
  backend:
    | {
        type: "mcp";
        transport: CapletServerConfig["transport"];
        disabled: boolean;
        startupTimeoutMs: number;
        callTimeoutMs: number;
        toolCacheTtlMs: number;
      }
    | {
        type: "openapi";
        disabled: boolean;
        requestTimeoutMs: number;
        operationCacheTtlMs: number;
        source: "specPath" | "specUrl";
      };
  mcpServer?: {
    transport: CapletServerConfig["transport"];
    disabled: boolean;
    startupTimeoutMs: number;
    callTimeoutMs: number;
    toolCacheTtlMs: number;
  };
};

export class ServerRegistry {
  readonly config: CapletsConfig;
  private readonly statuses = new Map<
    string,
    { status: ServerStatus; lastError?: SafeErrorSummary }
  >();

  constructor(config: CapletsConfig) {
    this.config = config;
    for (const server of this.allCaplets()) {
      this.statuses.set(server.server, { status: server.disabled ? "disabled" : "not_started" });
    }
  }

  enabledServers(): CapletConfig[] {
    return this.allCaplets().filter((server) => !server.disabled);
  }

  get(serverId: string): CapletConfig | undefined {
    const server = this.config.mcpServers[serverId] ?? this.config.openapiEndpoints[serverId];
    return server?.disabled ? undefined : server;
  }

  require(serverId: string): CapletConfig {
    const server = this.get(serverId);
    if (!server) {
      throw new Error(`server not found: ${serverId}`);
    }
    return server;
  }

  setStatus(serverId: string, status: ServerStatus, lastError?: SafeErrorSummary): void {
    this.statuses.set(serverId, lastError ? { status, lastError } : { status });
  }

  getStatus(serverId: string): ServerStatus {
    return this.statuses.get(serverId)?.status ?? "not_started";
  }

  summary(server: CapletConfig): CapletServerSummary {
    const status = this.statuses.get(server.server);
    return {
      server: server.server,
      name: server.name,
      description: server.description,
      ...(server.disabled ? { disabled: true } : {}),
      status: status?.status ?? (server.disabled ? "disabled" : "not_started"),
      ...(status?.lastError ? { lastError: status.lastError } : {}),
    };
  }

  detail(server: CapletConfig): CapletServerDetail {
    const backend = backendDetail(server);
    return {
      caplet: server.server,
      name: server.name,
      description: server.description,
      ...(server.tags ? { tags: server.tags } : {}),
      ...(server.body ? { body: server.body } : {}),
      backend,
      ...(server.backend === "mcp"
        ? {
            mcpServer: {
              transport: server.transport,
              disabled: server.disabled,
              startupTimeoutMs: server.startupTimeoutMs,
              callTimeoutMs: server.callTimeoutMs,
              toolCacheTtlMs: server.toolCacheTtlMs,
            },
          }
        : {}),
    };
  }

  private allCaplets(): CapletConfig[] {
    return [
      ...Object.values(this.config.mcpServers),
      ...Object.values(this.config.openapiEndpoints),
    ];
  }
}

export function capabilityDescription(server: CapletConfig): string {
  const backendName = server.backend === "mcp" ? "MCP server" : "OpenAPI endpoint";
  const checkOperation = server.backend === "mcp" ? "check_mcp_server" : "check_backend";
  const hint = [
    `Use this Caplet to inspect and call tools from its ${backendName} backend.`,
    "",
    "Recommended flow:",
    '- Read the full Caplet card: {"operation":"get_caplet"}',
    `- Check the backend: {"operation":"${checkOperation}"}`,
    '- Discover tools: {"operation":"list_tools"} or {"operation":"search_tools","query":"<what you need>"}',
    '- Read one tool schema: {"operation":"get_tool","tool":"<tool name>"}',
    '- Invoke one downstream tool: {"operation":"call_tool","tool":"<tool name>","arguments":{...}}',
    "",
    'Important: call_tool requires a top-level "arguments" JSON object containing the downstream tool inputs. Do not put downstream arguments at the top level of this wrapper request.',
  ].join("\n");
  return `${server.name}\n\n${server.description}\n\n${hint}`;
}

function backendDetail(server: CapletConfig): CapletServerDetail["backend"] {
  if (server.backend === "openapi") {
    return {
      type: "openapi",
      disabled: server.disabled,
      requestTimeoutMs: server.requestTimeoutMs,
      operationCacheTtlMs: server.operationCacheTtlMs,
      source: server.specPath ? "specPath" : "specUrl",
    };
  }

  return {
    type: "mcp",
    transport: server.transport,
    disabled: server.disabled,
    startupTimeoutMs: server.startupTimeoutMs,
    callTimeoutMs: server.callTimeoutMs,
    toolCacheTtlMs: server.toolCacheTtlMs,
  };
}
