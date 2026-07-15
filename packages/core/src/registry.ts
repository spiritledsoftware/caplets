import type {
  CapletConfig,
  CapletsConfig,
  CapletServerConfig,
  GoogleDiscoveryApiConfig,
  GraphQlEndpointConfig,
} from "./config";
import type { SafeErrorSummary } from "./errors";
import type { RuntimeCapletOwnership } from "./control-plane/snapshot";
export { capabilityDescription } from "./capability-description";

export type ServerStatus = "disabled" | "not_started" | "starting" | "available" | "unavailable";

export type CapletServerSummary = {
  id: string;
  name: string;
  description: string;
  disabled?: boolean;
  status: ServerStatus;
  lastError?: SafeErrorSummary;
  owner?: "sql" | "filesystem" | undefined;
  source?: RuntimeCapletOwnership["source"] | undefined;
  shadowed?: boolean | undefined;
  runtimeStatus?: RuntimeCapletOwnership["runtimeStatus"] | undefined;
  provenance?: RuntimeOwnershipProvenance | undefined;
};

export type CapletServerDetail = {
  id: string;
  name: string;
  description: string;
  tags?: string[];
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
      }
    | {
        type: "googleDiscovery";
        disabled: boolean;
        requestTimeoutMs: number;
        operationCacheTtlMs: number;
        source: "discoveryPath" | "discoveryUrl";
      }
    | {
        type: "graphql";
        disabled: boolean;
        requestTimeoutMs: number;
        operationCacheTtlMs: number;
        source: "schemaPath" | "schemaUrl" | "introspection";
        configuredOperations: boolean;
      }
    | {
        type: "http";
        disabled: boolean;
        requestTimeoutMs: number;
        configuredActions: number;
      }
    | {
        type: "cli";
        disabled: boolean;
        timeoutMs: number;
        maxOutputBytes: number;
        configuredActions: number;
      }
    | {
        type: "caplets";
        disabled: boolean;
        source: "configPath" | "capletsRoot" | "both";
        toolCacheTtlMs: number;
      };
  owner?: "sql" | "filesystem" | undefined;
  source?: RuntimeCapletOwnership["source"] | undefined;
  shadowed?: boolean | undefined;
  runtimeStatus?: RuntimeCapletOwnership["runtimeStatus"] | undefined;
  provenance?: RuntimeOwnershipProvenance | undefined;
};

export class ServerRegistry {
  readonly config: CapletsConfig;
  private readonly statuses = new Map<
    string,
    { status: ServerStatus; lastError?: SafeErrorSummary }
  >();
  private readonly ownership: Readonly<Record<string, RuntimeCapletOwnership>>;

  constructor(
    config: CapletsConfig,
    ownership: Readonly<Record<string, RuntimeCapletOwnership>> = {},
  ) {
    this.config = config;
    this.ownership = ownership;
    for (const server of this.allCaplets()) {
      this.statuses.set(server.server, { status: server.disabled ? "disabled" : "not_started" });
    }
  }

  enabledServers(): CapletConfig[] {
    return this.allCaplets().filter((server) => !server.disabled);
  }

  get(serverId: string): CapletConfig | undefined {
    const server =
      this.config.mcpServers[serverId] ??
      this.config.openapiEndpoints[serverId] ??
      this.config.googleDiscoveryApis?.[serverId] ??
      this.config.graphqlEndpoints[serverId] ??
      this.config.httpApis[serverId] ??
      this.config.cliTools[serverId] ??
      this.config.capletSets[serverId];
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

  runtimeOwnership(serverId: string): RuntimeCapletOwnership | undefined {
    return this.ownership[serverId];
  }

  withRuntimeMetadata(
    config: CapletsConfig,
    ownership: Readonly<Record<string, RuntimeCapletOwnership>>,
  ): ServerRegistry {
    const next = new ServerRegistry(config, ownership);
    for (const [serverId, status] of this.statuses) {
      if (next.statuses.has(serverId)) next.statuses.set(serverId, status);
    }
    return next;
  }

  summary(server: CapletConfig): CapletServerSummary {
    const status = this.statuses.get(server.server);
    return {
      id: server.server,
      name: server.name,
      description: server.description,
      ...(server.disabled ? { disabled: true } : {}),
      status: status?.status ?? (server.disabled ? "disabled" : "not_started"),
      ...(status?.lastError ? { lastError: status.lastError } : {}),
      ...ownershipSummary(this.ownership[server.server]),
    };
  }

  detail(server: CapletConfig): CapletServerDetail {
    const backend = backendDetail(server);
    return {
      id: server.server,
      name: server.name,
      description: server.description,
      ...(server.tags ? { tags: server.tags } : {}),
      backend,
      ...ownershipSummary(this.ownership[server.server]),
    };
  }

  private allCaplets(): CapletConfig[] {
    return [
      ...Object.values(this.config.mcpServers),
      ...Object.values(this.config.openapiEndpoints),
      ...Object.values(this.config.googleDiscoveryApis ?? {}),
      ...Object.values(this.config.graphqlEndpoints),
      ...Object.values(this.config.httpApis),
      ...Object.values(this.config.cliTools),
      ...Object.values(this.config.capletSets),
    ];
  }
}

type RuntimeOwnershipProvenance = NonNullable<
  RuntimeCapletOwnership["underlyingSql"]
>["provenance"];

function ownershipSummary(
  ownership: RuntimeCapletOwnership | undefined,
): Pick<CapletServerSummary, "owner" | "source" | "shadowed" | "runtimeStatus" | "provenance"> {
  if (!ownership) return {};
  const sqlLayer =
    ownership.owner === "sql"
      ? ownership.shadowChain.find((layer) => layer.owner === "sql")
      : ownership.underlyingSql;
  return {
    owner: ownership.owner,
    source: ownership.source,
    shadowed: Boolean(ownership.underlyingSql && ownership.owner === "filesystem"),
    runtimeStatus: ownership.runtimeStatus,
    ...(sqlLayer?.provenance ? { provenance: sqlLayer.provenance } : {}),
  };
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

  if (server.backend === "googleDiscovery") {
    return {
      type: "googleDiscovery",
      disabled: server.disabled,
      requestTimeoutMs: server.requestTimeoutMs,
      operationCacheTtlMs: server.operationCacheTtlMs,
      source: googleDiscoverySource(server),
    };
  }

  if (server.backend === "graphql") {
    return {
      type: "graphql",
      disabled: server.disabled,
      requestTimeoutMs: server.requestTimeoutMs,
      operationCacheTtlMs: server.operationCacheTtlMs,
      source: graphQlSource(server),
      configuredOperations: Boolean(server.operations && Object.keys(server.operations).length > 0),
    };
  }

  if (server.backend === "http") {
    return {
      type: "http",
      disabled: server.disabled,
      requestTimeoutMs: server.requestTimeoutMs,
      configuredActions: Object.keys(server.actions).length,
    };
  }

  if (server.backend === "cli") {
    return {
      type: "cli",
      disabled: server.disabled,
      timeoutMs: server.timeoutMs,
      maxOutputBytes: server.maxOutputBytes,
      configuredActions: Object.keys(server.actions).length,
    };
  }
  if (server.backend === "caplets") {
    return {
      type: "caplets",
      disabled: server.disabled,
      source: capletSetSource(server),
      toolCacheTtlMs: server.toolCacheTtlMs,
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

function googleDiscoverySource(server: GoogleDiscoveryApiConfig): "discoveryPath" | "discoveryUrl" {
  return server.discoveryPath ? "discoveryPath" : "discoveryUrl";
}

function capletSetSource(
  server: Extract<CapletConfig, { backend: "caplets" }>,
): "configPath" | "capletsRoot" | "both" {
  return server.configPath && server.capletsRoot
    ? "both"
    : server.configPath
      ? "configPath"
      : "capletsRoot";
}

function graphQlSource(
  server: GraphQlEndpointConfig,
): "schemaPath" | "schemaUrl" | "introspection" {
  if (server.schemaPath) {
    return "schemaPath";
  }
  if (server.schemaUrl) {
    return "schemaUrl";
  }
  return "introspection";
}
