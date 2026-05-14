import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CapletConfig } from "./config.js";
import type { DownstreamManager } from "./downstream.js";
import { CapletsError } from "./errors.js";
import type { GraphQLManager } from "./graphql.js";
import type { HttpActionManager } from "./http-actions.js";
import type { OpenApiManager } from "./openapi.js";
import type { ServerRegistry } from "./registry.js";
import { projectStructuredContent, validateFieldSelection } from "./field-selection.js";

const operations = [
  "get_caplet",
  "check_backend",
  "check_mcp_server",
  "list_tools",
  "search_tools",
  "get_tool",
  "call_tool",
] as const;
const operationSchema = z.enum(operations);

export const generatedToolInputSchema = z
  .object({
    operation: operationSchema.describe(
      [
        "Caplets wrapper operation to perform for this configured Caplet backend.",
        "Use get_caplet to read the full Caplet card, check_backend to check any backend, check_mcp_server to check an MCP backend, list_tools or search_tools to discover downstream tools, get_tool to read a downstream input schema, and call_tool to run one downstream tool or OpenAPI operation.",
        'For call_tool, pass downstream inputs only inside the top-level "arguments" object.',
      ].join(" "),
    ),
    query: z
      .string()
      .optional()
      .describe(
        'Required only for search_tools. Example: {"operation":"search_tools","query":"web search","limit":5}. Do not use query for call_tool; put downstream query values under arguments.query.',
      ),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Optional only for search_tools; defaults to the configured search limit. For downstream result limits, use call_tool.arguments with the downstream schema field name.",
      ),
    tool: z
      .string()
      .optional()
      .describe(
        'Exact downstream tool name for get_tool or call_tool. Example: {"operation":"get_tool","tool":"web_search_exa"} before calling it.',
      ),
    arguments: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Required JSON object only for call_tool. Put every downstream tool input inside this object. Example: {"operation":"call_tool","tool":"web_search_exa","arguments":{"query":"latest MCP docs","numResults":3}}. Do not send downstream inputs as top-level query, limit, url, path, or other fields.',
      ),
    fields: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(
        'Optional for call_tool after get_tool shows outputSchema on a non-GraphQL tool. Example: fields: ["path.to.field"].',
      ),
  })
  .strict();

export type GeneratedServerToolRequest = z.infer<typeof generatedToolInputSchema>;

export async function handleServerTool(
  server: CapletConfig,
  request: unknown,
  registry: ServerRegistry,
  downstream: DownstreamManager,
  openapi?: OpenApiManager,
  graphql?: GraphQLManager,
  http?: HttpActionManager,
): Promise<any> {
  const parsed = validateOperationRequest(request, registry.config.options.maxSearchLimit);

  switch (parsed.operation) {
    case "get_caplet":
      return jsonResult(registry.detail(server));
    case "check_backend":
      return jsonResult(
        await backendFor(server, downstream, openapi, graphql, http).check(server as never),
      );
    case "check_mcp_server":
      if (server.backend !== "mcp") {
        throw new CapletsError(
          "REQUEST_INVALID",
          "check_mcp_server is only valid for MCP-backed Caplets; use check_backend",
        );
      }
      return jsonResult(await downstream.checkServer(server));
    case "list_tools": {
      const backend = backendFor(server, downstream, openapi, graphql, http);
      const tools = await backend.listTools(server as never);
      return jsonResult({
        server: server.server,
        tools: tools.map((tool) => backend.compact(server as never, tool)),
      });
    }
    case "search_tools": {
      const backend = backendFor(server, downstream, openapi, graphql, http);
      const tools = await backend.listTools(server as never);
      const limit = parsed.limit ?? registry.config.options.defaultSearchLimit;
      return jsonResult({
        server: server.server,
        query: parsed.query,
        tools: backend.search(server as never, tools, parsed.query, limit),
      });
    }
    case "get_tool": {
      const backend = backendFor(server, downstream, openapi, graphql, http);
      const tool = await backend.getTool(server as never, parsed.tool);
      return jsonResult({ server: server.server, tool });
    }
    case "call_tool": {
      const backend = backendFor(server, downstream, openapi, graphql, http);
      if (parsed.fields === undefined) {
        return backend.callTool(server as never, parsed.tool, parsed.arguments);
      }
      if (server.backend === "graphql") {
        throw new CapletsError(
          "REQUEST_INVALID",
          "call_tool.fields is not supported for GraphQL-backed Caplets; select fields in the GraphQL operation document instead",
        );
      }

      const tool = await backend.getTool(server as never, parsed.tool);
      if (!tool.outputSchema) {
        throw new CapletsError("REQUEST_INVALID", "Field selection requires an output schema");
      }
      validateFieldSelection(tool.outputSchema, parsed.fields);

      return projectCallToolResult(
        await backend.callTool(server as never, parsed.tool, parsed.arguments),
        tool.outputSchema,
        parsed.fields,
      );
    }
  }
}

export function validateOperationRequest(
  request: unknown,
  maxSearchLimit: number,
): RequiredOperationRequest {
  if (
    request &&
    typeof request === "object" &&
    "operation" in request &&
    typeof (request as { operation?: unknown }).operation === "string" &&
    !operations.includes(
      (request as { operation: string }).operation as (typeof operations)[number],
    )
  ) {
    throw new CapletsError(
      "UNKNOWN_OPERATION",
      `Unknown operation: ${(request as { operation: string }).operation}`,
    );
  }

  const result = generatedToolInputSchema.safeParse(request);
  if (!result.success) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Generated server tool request is invalid",
      result.error.issues,
    );
  }

  const value = result.data;
  const keys = Object.keys(value).sort();
  const allowed = (fields: string[]) => {
    const expected = ["operation", ...fields].sort();
    const extras = keys.filter((key) => !expected.includes(key));
    if (extras.length > 0) {
      throw new CapletsError(
        "REQUEST_INVALID",
        `Unexpected field(s) for ${value.operation}: ${extras.join(", ")}`,
      );
    }
  };

  switch (value.operation) {
    case "get_caplet":
    case "check_backend":
    case "check_mcp_server":
    case "list_tools":
      allowed([]);
      return { operation: value.operation };
    case "search_tools":
      allowed(["query", "limit"]);
      if (!value.query) {
        throw new CapletsError("REQUEST_INVALID", "search_tools requires query");
      }
      if (value.limit !== undefined && value.limit > maxSearchLimit) {
        throw new CapletsError(
          "REQUEST_INVALID",
          `search_tools limit must be <= ${maxSearchLimit}`,
        );
      }
      return value.limit === undefined
        ? { operation: "search_tools", query: value.query }
        : { operation: "search_tools", query: value.query, limit: value.limit };
    case "get_tool":
      allowed(["tool"]);
      if (!value.tool) {
        throw new CapletsError("REQUEST_INVALID", "get_tool requires tool");
      }
      return { operation: "get_tool", tool: value.tool };
    case "call_tool":
      allowed(["tool", "arguments", "fields"]);
      if (!value.tool) {
        throw new CapletsError("REQUEST_INVALID", "call_tool requires tool");
      }
      if (!isPlainObject(value.arguments)) {
        throw new CapletsError("REQUEST_INVALID", "call_tool.arguments must be a JSON object");
      }
      return value.fields === undefined
        ? { operation: "call_tool", tool: value.tool, arguments: value.arguments }
        : {
            operation: "call_tool",
            tool: value.tool,
            arguments: value.arguments,
            fields: value.fields,
          };
  }
}

type RequiredOperationRequest =
  | { operation: "get_caplet" | "check_backend" | "check_mcp_server" | "list_tools" }
  | { operation: "search_tools"; query: string; limit?: number }
  | { operation: "get_tool"; tool: string }
  | { operation: "call_tool"; tool: string; arguments: Record<string, unknown>; fields?: string[] };

export function jsonResult(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: { result: value as Record<string, unknown> },
  };
}

export function projectCallToolResult<T extends object>(
  result: T,
  outputSchema: unknown,
  fields: string[],
): T & CallToolResult {
  if ((result as { isError?: unknown }).isError === true) {
    return result as T & CallToolResult;
  }

  const projected = projectStructuredContent(
    (result as { structuredContent?: unknown }).structuredContent,
    outputSchema,
    fields,
  );
  return {
    ...result,
    content: [
      {
        type: "text",
        text: JSON.stringify(projected, null, 2),
      },
    ],
    structuredContent: projected,
  } as T & CallToolResult;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function backendFor(
  server: CapletConfig | { backend: string },
  downstream: DownstreamManager,
  openapi?: OpenApiManager,
  graphql?: GraphQLManager,
  http?: HttpActionManager,
) {
  if (server.backend === "mcp") {
    return {
      check: (...args: Parameters<DownstreamManager["checkServer"]>) =>
        downstream.checkServer(...args),
      listTools: (...args: Parameters<DownstreamManager["listTools"]>) =>
        downstream.listTools(...args),
      getTool: (...args: Parameters<DownstreamManager["getTool"]>) => downstream.getTool(...args),
      callTool: (...args: Parameters<DownstreamManager["callTool"]>) =>
        downstream.callTool(...args),
      compact: (...args: Parameters<DownstreamManager["compact"]>) => downstream.compact(...args),
      search: (...args: Parameters<DownstreamManager["search"]>) => downstream.search(...args),
    };
  }
  if (server.backend === "graphql") {
    if (!graphql) {
      throw new CapletsError("INTERNAL_ERROR", "GraphQL manager is not configured");
    }
    return {
      check: (...args: Parameters<GraphQLManager["checkEndpoint"]>) =>
        graphql.checkEndpoint(...args),
      listTools: (...args: Parameters<GraphQLManager["listTools"]>) => graphql.listTools(...args),
      getTool: (...args: Parameters<GraphQLManager["getTool"]>) => graphql.getTool(...args),
      callTool: (...args: Parameters<GraphQLManager["callTool"]>) => graphql.callTool(...args),
      compact: (...args: Parameters<GraphQLManager["compact"]>) => graphql.compact(...args),
      search: (...args: Parameters<GraphQLManager["search"]>) => graphql.search(...args),
    };
  }
  if (server.backend === "http") {
    if (!http) {
      throw new CapletsError("INTERNAL_ERROR", "HTTP action manager is not configured");
    }
    return {
      check: (...args: Parameters<HttpActionManager["checkApi"]>) => http.checkApi(...args),
      listTools: (...args: Parameters<HttpActionManager["listTools"]>) => http.listTools(...args),
      getTool: (...args: Parameters<HttpActionManager["getTool"]>) => http.getTool(...args),
      callTool: (...args: Parameters<HttpActionManager["callTool"]>) => http.callTool(...args),
      compact: (...args: Parameters<HttpActionManager["compact"]>) => http.compact(...args),
      search: (...args: Parameters<HttpActionManager["search"]>) => http.search(...args),
    };
  }
  if (!openapi) {
    throw new CapletsError("INTERNAL_ERROR", "OpenAPI manager is not configured");
  }
  return {
    check: (...args: Parameters<OpenApiManager["checkEndpoint"]>) => openapi.checkEndpoint(...args),
    listTools: (...args: Parameters<OpenApiManager["listTools"]>) => openapi.listTools(...args),
    getTool: (...args: Parameters<OpenApiManager["getTool"]>) => openapi.getTool(...args),
    callTool: (...args: Parameters<OpenApiManager["callTool"]>) => openapi.callTool(...args),
    compact: (...args: Parameters<OpenApiManager["compact"]>) => openapi.compact(...args),
    search: (...args: Parameters<OpenApiManager["search"]>) => openapi.search(...args),
  };
}
