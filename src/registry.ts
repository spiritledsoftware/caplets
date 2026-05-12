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
  const hint = `Use this tool to inspect and call tools from ${server.server}. Start with search_tools or list_tools; use get_tool for schema; use call_tool to invoke.`;
  return `${server.name}\n\n${server.description}\n\n${hint}`;
}
