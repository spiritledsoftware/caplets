import type { CapletsConfig, CapletServerConfig } from "./config.js";
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
  server: string;
  name: string;
  description: string;
};

export class ServerRegistry {
  readonly config: CapletsConfig;
  private readonly statuses = new Map<
    string,
    { status: ServerStatus; lastError?: SafeErrorSummary }
  >();

  constructor(config: CapletsConfig) {
    this.config = config;
    for (const server of Object.values(config.mcpServers)) {
      this.statuses.set(server.server, { status: server.disabled ? "disabled" : "not_started" });
    }
  }

  enabledServers(): CapletServerConfig[] {
    return Object.values(this.config.mcpServers).filter((server) => !server.disabled);
  }

  get(serverId: string): CapletServerConfig | undefined {
    const server = this.config.mcpServers[serverId];
    return server?.disabled ? undefined : server;
  }

  require(serverId: string): CapletServerConfig {
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

  summary(server: CapletServerConfig): CapletServerSummary {
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

  detail(server: CapletServerConfig): CapletServerDetail {
    return {
      server: server.server,
      name: server.name,
      description: server.description,
    };
  }
}

export function capabilityDescription(server: CapletServerConfig): string {
  const hint = [
    `Use this Caplets wrapper to inspect and call tools from ${server.server}.`,
    "",
    "Recommended flow:",
    '- Discover tools: {"operation":"list_tools"} or {"operation":"search_tools","query":"<what you need>"}',
    '- Read one tool schema: {"operation":"get_tool","tool":"<tool name>"}',
    '- Invoke one downstream tool: {"operation":"call_tool","tool":"<tool name>","arguments":{...}}',
    "",
    'Important: call_tool requires a top-level "arguments" JSON object containing the downstream tool inputs. Do not put downstream arguments at the top level of this wrapper request.',
  ].join("\n");
  return `${server.name}\n\n${server.description}\n\n${hint}`;
}
