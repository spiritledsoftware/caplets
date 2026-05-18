import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CapletSetManager } from "./caplet-sets";
import type { CapletConfig } from "./config";
import type { CliToolsManager } from "./cli-tools";
import type { DownstreamManager } from "./downstream";
import { CapletsError } from "./errors";
import type { GraphQLManager } from "./graphql";
import type { HttpActionManager } from "./http-actions";
import type { OpenApiManager } from "./openapi";
import type { ServerRegistry } from "./registry";
import { projectStructuredContent, validateFieldSelection } from "./field-selection";
import { generatedToolInputDescriptions, operations } from "./generated-tool-input-schema";

const operationSchema = z.enum(operations);

export const generatedToolInputSchema = z
  .object({
    operation: operationSchema.describe(generatedToolInputDescriptions.operation),
    query: z.string().optional().describe(generatedToolInputDescriptions.query),
    limit: z.number().int().positive().optional().describe(generatedToolInputDescriptions.limit),
    tool: z.string().optional().describe(generatedToolInputDescriptions.tool),
    arguments: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(generatedToolInputDescriptions.arguments),
    fields: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(generatedToolInputDescriptions.fields),
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
  cli?: CliToolsManager,
  caplets?: CapletSetManager,
): Promise<any> {
  const parsed = validateOperationRequest(request, registry.config.options.maxSearchLimit);

  switch (parsed.operation) {
    case "get_caplet":
      return jsonResult(registry.detail(server));
    case "check_backend":
      return jsonResult(
        await backendFor(server, downstream, openapi, graphql, http, cli, caplets).check(
          server as never,
        ),
      );
    case "list_tools": {
      const backend = backendFor(server, downstream, openapi, graphql, http, cli, caplets);
      const tools = await backend.listTools(server as never);
      return jsonResult({
        server: server.server,
        tools: tools.map((tool) => backend.compact(server as never, tool)),
      });
    }
    case "search_tools": {
      const backend = backendFor(server, downstream, openapi, graphql, http, cli, caplets);
      const tools = await backend.listTools(server as never);
      const limit = parsed.limit ?? registry.config.options.defaultSearchLimit;
      return jsonResult({
        server: server.server,
        query: parsed.query,
        tools: backend.search(server as never, tools, parsed.query, limit),
      });
    }
    case "get_tool": {
      const backend = backendFor(server, downstream, openapi, graphql, http, cli, caplets);
      const tool = await backend.getTool(server as never, parsed.tool);
      return jsonResult({ server: server.server, tool });
    }
    case "call_tool": {
      const backend = backendFor(server, downstream, openapi, graphql, http, cli, caplets);
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
  return assertNever(value.operation);
}

function assertNever(value: never): never {
  throw new CapletsError("INTERNAL_ERROR", `Unhandled operation: ${String(value)}`);
}

type RequiredOperationRequest =
  | { operation: "get_caplet" | "check_backend" | "list_tools" }
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

  const structuredContent = (result as { structuredContent?: unknown }).structuredContent;
  if (!isPlainObject(structuredContent)) {
    throw new CapletsError(
      "DOWNSTREAM_PROTOCOL_ERROR",
      "Field selection requires the downstream tool to return object structuredContent",
    );
  }

  const projected = projectStructuredContent(structuredContent, outputSchema, fields);
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
  cli?: CliToolsManager,
  caplets?: CapletSetManager,
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
  if (server.backend === "cli") {
    if (!cli) {
      throw new CapletsError("INTERNAL_ERROR", "CLI tools manager is not configured");
    }
    return {
      check: (...args: Parameters<CliToolsManager["checkTools"]>) => cli.checkTools(...args),
      listTools: (...args: Parameters<CliToolsManager["listTools"]>) => cli.listTools(...args),
      getTool: (...args: Parameters<CliToolsManager["getTool"]>) => cli.getTool(...args),
      callTool: (...args: Parameters<CliToolsManager["callTool"]>) => cli.callTool(...args),
      compact: (...args: Parameters<CliToolsManager["compact"]>) => cli.compact(...args),
      search: (...args: Parameters<CliToolsManager["search"]>) => cli.search(...args),
    };
  }
  if (server.backend === "caplets") {
    if (!caplets) {
      throw new CapletsError("INTERNAL_ERROR", "Caplet set manager is not configured");
    }
    return {
      check: (...args: Parameters<CapletSetManager["checkSet"]>) => caplets.checkSet(...args),
      listTools: (...args: Parameters<CapletSetManager["listTools"]>) => caplets.listTools(...args),
      getTool: (...args: Parameters<CapletSetManager["getTool"]>) => caplets.getTool(...args),
      callTool: (...args: Parameters<CapletSetManager["callTool"]>) => caplets.callTool(...args),
      compact: (...args: Parameters<CapletSetManager["compact"]>) => caplets.compact(...args),
      search: (...args: Parameters<CapletSetManager["search"]>) => caplets.search(...args),
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
