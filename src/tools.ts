import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CapletServerConfig } from "./config.js";
import type { DownstreamManager } from "./downstream.js";
import { CapletsError } from "./errors.js";
import type { ServerRegistry } from "./registry.js";

const operations = [
  "get_server",
  "check_server",
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
        "Caplets wrapper operation to perform for this configured MCP server.",
        "Use list_tools or search_tools to discover downstream tools, get_tool to read a downstream input schema, and call_tool to run one downstream tool.",
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
  })
  .strict();

export type GeneratedServerToolRequest = z.infer<typeof generatedToolInputSchema>;

export async function handleServerTool(
  server: CapletServerConfig,
  request: unknown,
  registry: ServerRegistry,
  downstream: DownstreamManager,
): Promise<any> {
  const parsed = validateOperationRequest(request, registry.config.options.maxSearchLimit);

  switch (parsed.operation) {
    case "get_server":
      return jsonResult(registry.detail(server));
    case "check_server":
      return jsonResult(await downstream.checkServer(server));
    case "list_tools": {
      const tools = await downstream.listTools(server);
      return jsonResult({
        server: server.server,
        tools: tools.map((tool) => downstream.compact(server, tool)),
      });
    }
    case "search_tools": {
      const tools = await downstream.listTools(server);
      const limit = parsed.limit ?? registry.config.options.defaultSearchLimit;
      return jsonResult({
        server: server.server,
        query: parsed.query,
        tools: downstream.search(server, tools, parsed.query, limit),
      });
    }
    case "get_tool": {
      const tool = await downstream.getTool(server, parsed.tool);
      return jsonResult({ server: server.server, tool });
    }
    case "call_tool":
      return downstream.callTool(server, parsed.tool, parsed.arguments);
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
    case "get_server":
    case "check_server":
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
      allowed(["tool", "arguments"]);
      if (!value.tool) {
        throw new CapletsError("REQUEST_INVALID", "call_tool requires tool");
      }
      if (!isPlainObject(value.arguments)) {
        throw new CapletsError("REQUEST_INVALID", "call_tool.arguments must be a JSON object");
      }
      return { operation: "call_tool", tool: value.tool, arguments: value.arguments };
  }
}

type RequiredOperationRequest =
  | { operation: "get_server" | "check_server" | "list_tools" }
  | { operation: "search_tools"; query: string; limit?: number }
  | { operation: "get_tool"; tool: string }
  | { operation: "call_tool"; tool: string; arguments: Record<string, unknown> };

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
