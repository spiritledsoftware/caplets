import type {
  CompatibilityCallToolResult,
  CompleteResult,
  GetPromptResult,
  ReadResourceResult,
  Tool,
} from "@modelcontextprotocol/sdk/types";
import type {
  CapletConfig,
  CapletServerConfig,
  CapletSetConfig,
  CliToolsConfig,
  GoogleDiscoveryApiConfig,
  GraphQlEndpointConfig,
  HttpApiConfig,
  OpenApiEndpointConfig,
} from "./config";
import type { CompactTool, DownstreamManager } from "./downstream";

export type BackendCheckResult = {
  id: string;
  status: string;
  toolCount?: number;
  elapsedMs: number;
  error?: unknown;
};
export type BackendCallToolResult =
  | CompatibilityCallToolResult
  | ReadResourceResult
  | GetPromptResult
  | CompleteResult;

export interface BackendOperationDispatch {
  check(server: CapletConfig): Promise<BackendCheckResult>;
  listTools(server: CapletConfig): Promise<Tool[]>;
  getTool(server: CapletConfig, toolName: string): Promise<Tool>;
  callTool(
    server: CapletConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<BackendCallToolResult>;
  compact(server: CapletConfig, tool: Tool): CompactTool;
  search(server: CapletConfig, tools: Tool[], query: string, limit: number): CompactTool[];
}

export type McpOperationAdapter = Pick<
  DownstreamManager,
  | "listResources"
  | "listResourceTemplates"
  | "readResource"
  | "listPrompts"
  | "getPrompt"
  | "complete"
  | "compactResource"
  | "compactResourceTemplate"
  | "compactPrompt"
  | "searchResources"
  | "searchPrompts"
>;

export type BackendOperationRuntime = {
  operations: BackendOperationDispatch;
  mcp: McpOperationAdapter;
};

export type BackendOperationManagers = {
  mcp: ManagerWithCheck<CapletServerConfig, "checkServer"> & McpOperationAdapter;
  openapi: ManagerWithCheck<OpenApiEndpointConfig, "checkEndpoint">;
  googleDiscovery: ManagerWithCheck<GoogleDiscoveryApiConfig, "checkApi">;
  graphql: ManagerWithCheck<GraphQlEndpointConfig, "checkEndpoint">;
  http: ManagerWithCheck<HttpApiConfig, "checkApi">;
  cli: ManagerWithCheck<CliToolsConfig, "checkTools">;
  caplets: ManagerWithCheck<CapletSetConfig, "checkSet">;
};

export function createBackendOperationRuntime(
  managers: BackendOperationManagers,
): BackendOperationRuntime {
  return {
    operations: createBackendOperationDispatch(managers),
    mcp: managers.mcp,
  };
}

type BackendOperationAdapter<C extends CapletConfig> = {
  manager: CommonManager<C>;
  check(server: C): Promise<BackendCheckResult>;
};

type BackendOperationAdapterTable = {
  [B in CapletConfig["backend"]]: BackendOperationAdapter<Extract<CapletConfig, { backend: B }>>;
};

export function createBackendOperationDispatch(
  managers: BackendOperationManagers,
): BackendOperationDispatch {
  const adapters: BackendOperationAdapterTable = {
    mcp: {
      manager: managers.mcp,
      check: (server) => managers.mcp.checkServer(server),
    },
    openapi: {
      manager: managers.openapi,
      check: (server) => managers.openapi.checkEndpoint(server),
    },
    googleDiscovery: {
      manager: managers.googleDiscovery,
      check: (server) => managers.googleDiscovery.checkApi(server),
    },
    graphql: {
      manager: managers.graphql,
      check: (server) => managers.graphql.checkEndpoint(server),
    },
    http: {
      manager: managers.http,
      check: (server) => managers.http.checkApi(server),
    },
    cli: {
      manager: managers.cli,
      check: (server) => managers.cli.checkTools(server),
    },
    caplets: {
      manager: managers.caplets,
      check: (server) => managers.caplets.checkSet(server),
    },
  };

  const adapterFor = <C extends CapletConfig>(server: C): BackendOperationAdapter<C> =>
    adapters[server.backend] as BackendOperationAdapter<C>;

  return {
    check: (server) => adapterFor(server).check(server),
    listTools: (server) => adapterFor(server).manager.listTools(server),
    getTool: (server, toolName) => adapterFor(server).manager.getTool(server, toolName),
    callTool: (server, toolName, args) =>
      adapterFor(server).manager.callTool(server, toolName, args),
    compact: (server, tool) => adapterFor(server).manager.compact(server, tool),
    search: (server, tools, query, limit) =>
      adapterFor(server).manager.search(server, tools, query, limit),
  };
}

type CommonManager<C extends CapletConfig> = {
  listTools(server: C): Promise<Tool[]>;
  getTool(server: C, toolName: string): Promise<Tool>;
  callTool(
    server: C,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<BackendCallToolResult>;
  compact(server: C, tool: Tool): CompactTool;
  search(server: C, tools: Tool[], query: string, limit: number): CompactTool[];
};

type ManagerWithCheck<C extends CapletConfig, K extends string> = CommonManager<C> &
  Record<K, (server: C) => Promise<BackendCheckResult>>;
