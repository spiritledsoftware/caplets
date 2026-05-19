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
import { compactStructuredContent } from "./result-content";

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
  const startedAt = Date.now();
  const parsed = validateOperationRequest(request, registry.config.options.maxSearchLimit);

  switch (parsed.operation) {
    case "get_caplet":
      return jsonResult(
        registry.detail(server),
        metadataFor(server, "get_caplet", undefined, startedAt),
      );
    case "check_backend": {
      const result = await backendFor(
        server,
        downstream,
        openapi,
        graphql,
        http,
        cli,
        caplets,
      ).check(server as never);
      return jsonResult(result, metadataFor(server, "check_backend", undefined, startedAt));
    }
    case "list_tools": {
      const backend = backendFor(server, downstream, openapi, graphql, http, cli, caplets);
      const tools = await backend.listTools(server as never);
      const limit = parsed.limit ?? tools.length;
      return jsonResult(
        {
          server: server.server,
          tools: tools.slice(0, limit).map((tool) => backend.compact(server as never, tool)),
        },
        metadataFor(server, "list_tools", undefined, startedAt),
      );
    }
    case "search_tools": {
      const backend = backendFor(server, downstream, openapi, graphql, http, cli, caplets);
      const tools = await backend.listTools(server as never);
      const limit = parsed.limit ?? registry.config.options.defaultSearchLimit;
      return jsonResult(
        {
          server: server.server,
          query: parsed.query,
          tools: backend.search(server as never, tools, parsed.query, limit),
        },
        metadataFor(server, "search_tools", undefined, startedAt),
      );
    }
    case "get_tool": {
      const backend = backendFor(server, downstream, openapi, graphql, http, cli, caplets);
      const tool = await backend.getTool(server as never, parsed.tool);
      return jsonResult(
        { server: server.server, tool },
        metadataFor(server, "get_tool", parsed.tool, startedAt),
      );
    }
    case "call_tool": {
      const backend = backendFor(server, downstream, openapi, graphql, http, cli, caplets);
      if (parsed.fields === undefined) {
        const result = await backend.callTool(server as never, parsed.tool, parsed.arguments);
        return annotateCallToolResult(
          result,
          metadataFor(server, "call_tool", parsed.tool, startedAt),
        );
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

      const result = projectCallToolResult(
        await backend.callTool(server as never, parsed.tool, parsed.arguments),
        tool.outputSchema,
        parsed.fields,
      );
      return annotateCallToolResult(
        result,
        metadataFor(server, "call_tool", parsed.tool, startedAt),
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
      allowed([]);
      return { operation: value.operation };
    case "list_tools":
      allowed(["limit"]);
      if (value.limit !== undefined && value.limit > maxSearchLimit) {
        throw new CapletsError("REQUEST_INVALID", `list_tools limit must be <= ${maxSearchLimit}`);
      }
      return value.limit === undefined
        ? { operation: "list_tools" }
        : { operation: "list_tools", limit: value.limit };
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
  | { operation: "get_caplet" | "check_backend" }
  | { operation: "list_tools"; limit?: number }
  | { operation: "search_tools"; query: string; limit?: number }
  | { operation: "get_tool"; tool: string }
  | { operation: "call_tool"; tool: string; arguments: Record<string, unknown>; fields?: string[] };

export type CapletArtifact = {
  kind: "screenshot" | "snapshot" | "console-log" | "network-log" | "file";
  displayPath: string;
  pathResolution: "absolute" | "relative-to-mcp-server";
};

export type CapletResultMetadata = {
  caplet: string;
  name: string;
  backend: string;
  operation: RequiredOperationRequest["operation"];
  tool?: string;
  status: "ok" | "error";
  elapsedMs?: number;
  artifacts?: CapletArtifact[];
};

export function metadataFor(
  server: CapletConfig,
  operation: RequiredOperationRequest["operation"],
  tool?: string,
  startedAt?: number,
): CapletResultMetadata {
  return {
    caplet: server.server,
    name: server.name,
    backend: server.backend,
    operation,
    ...(tool === undefined ? {} : { tool }),
    status: "ok",
    ...(startedAt === undefined ? {} : { elapsedMs: Date.now() - startedAt }),
  };
}

export function jsonResult(value: unknown, metadata?: CapletResultMetadata): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: {
      ...(metadata === undefined ? {} : { caplets: metadata }),
      result: value as Record<string, unknown>,
    },
  };
}

export function annotateCallToolResult<T extends object>(
  result: T,
  metadata: CapletResultMetadata,
): T & CallToolResult {
  const existingMeta = (result as { _meta?: unknown })._meta;
  const artifacts = extractArtifacts(result);
  const annotatedMetadata = {
    ...metadata,
    status: (result as { isError?: unknown }).isError === true ? "error" : metadata.status,
    ...(artifacts.length === 0 ? {} : { artifacts }),
  };

  return {
    ...result,
    _meta: {
      ...(isPlainObject(existingMeta) ? existingMeta : {}),
      caplets: annotatedMetadata,
    },
  } as T & CallToolResult;
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
    content: compactStructuredContent(projected),
    structuredContent: projected,
  } as T & CallToolResult;
}

export function extractArtifacts(result: unknown): CapletArtifact[] {
  if (!isPlainObject(result) || !Array.isArray(result.content)) {
    return [];
  }

  const artifacts: CapletArtifact[] = [];
  const seen = new Set<string>();
  for (const item of result.content) {
    if (!isPlainObject(item) || item.type !== "text" || typeof item.text !== "string") {
      continue;
    }

    const text = item.text;
    for (const link of parseMarkdownLinks(text)) {
      const label = link.label;
      const displayPath = link.destination;
      const matchStart = link.start;
      const matchEnd = link.end;
      const start = Math.max(
        text.lastIndexOf(".", matchStart - 1),
        text.lastIndexOf(";", matchStart - 1),
        text.lastIndexOf(",", matchStart - 1),
        text.lastIndexOf("\n", matchStart - 1),
        0,
      );
      const followingDelimiters = [".", ";", ",", "\n"]
        .map((delimiter) => text.indexOf(delimiter, matchEnd))
        .filter((index) => index >= 0);
      const end = followingDelimiters.length === 0 ? text.length : Math.min(...followingDelimiters);
      const surroundingText = text.slice(start, end);
      if (
        !isLocalArtifactPath(displayPath) ||
        seen.has(displayPath) ||
        !isArtifactLink(displayPath, label, surroundingText)
      ) {
        continue;
      }
      seen.add(displayPath);
      artifacts.push({
        kind: artifactKind(displayPath, label, surroundingText),
        displayPath,
        pathResolution: isAbsoluteLocalPath(displayPath) ? "absolute" : "relative-to-mcp-server",
      });
    }
  }
  return artifacts;
}

type MarkdownLink = {
  label: string;
  destination: string;
  start: number;
  end: number;
};

function parseMarkdownLinks(text: string): MarkdownLink[] {
  const links: MarkdownLink[] = [];
  let index = 0;
  while (index < text.length) {
    const labelStart = text.indexOf("[", index);
    if (labelStart < 0) {
      break;
    }
    const labelEnd = text.indexOf("](", labelStart + 1);
    if (labelEnd < 0) {
      break;
    }
    const destinationStart = labelEnd + 2;
    const parsed = parseMarkdownLinkDestination(text, destinationStart);
    if (parsed !== undefined) {
      links.push({
        label: text.slice(labelStart + 1, labelEnd),
        destination: parsed.destination,
        start: labelStart,
        end: parsed.end,
      });
      index = parsed.end;
      continue;
    }
    index = destinationStart;
  }
  return links;
}

function parseMarkdownLinkDestination(
  text: string,
  start: number,
): { destination: string; end: number } | undefined {
  let index = start;
  while (/\s/.test(text[index] ?? "")) {
    index += 1;
  }
  const destinationStart = index;
  let parenDepth = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "(") {
      parenDepth += 1;
    } else if (char === ")") {
      if (parenDepth === 0) {
        return { destination: text.slice(destinationStart, index), end: index + 1 };
      }
      parenDepth -= 1;
    } else if (/\s/.test(char ?? "") && parenDepth === 0) {
      const titleStart = skipWhitespace(text, index + 1);
      if (text[titleStart] === '"' || text[titleStart] === "'") {
        const titleEnd = findMarkdownLinkTitleEnd(text, titleStart);
        return titleEnd === undefined
          ? undefined
          : { destination: text.slice(destinationStart, index), end: titleEnd };
      }
    }
    index += 1;
  }
  return undefined;
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (/\s/.test(text[index] ?? "")) {
    index += 1;
  }
  return index;
}

function findMarkdownLinkTitleEnd(text: string, start: number): number | undefined {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === quote) {
      const end = skipWhitespace(text, index + 1);
      return text[end] === ")" ? end + 1 : undefined;
    }
  }
  return undefined;
}

function isLocalArtifactPath(path: string): boolean {
  if (path.startsWith("#")) {
    return false;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) && !/^[A-Za-z]:[\\/]/.test(path)) {
    return false;
  }
  return path.length > 0;
}

function isArtifactLink(path: string, label: string, surroundingText: string): boolean {
  const text = `${path} ${label} ${surroundingText}`.toLowerCase();
  if (
    /artifact|screenshot|screen[-_ ]?shot|snapshot|console|network|trace|archive|download|saved|file/.test(
      text,
    )
  ) {
    return true;
  }
  return /\.(?:png|jpe?g|gif|webp|zip|tar|tgz|gz|har|log|txt|pdf|yaml|json)$/i.test(path);
}

function isAbsoluteLocalPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

function artifactKind(
  path: string,
  label: string,
  surroundingText: string,
): CapletArtifact["kind"] {
  const directText = `${path} ${label}`.toLowerCase();
  const directKind = artifactKindFromText(directText);
  if (directKind !== "file") {
    return directKind;
  }
  return artifactKindFromText(surroundingText.toLowerCase());
}

function artifactKindFromText(text: string): CapletArtifact["kind"] {
  if (/screenshot|screen[-_ ]?shot|viewport/.test(text)) {
    return "screenshot";
  }
  if (/snapshot|aria[-_ ]?snapshot/.test(text)) {
    return "snapshot";
  }
  if (/console[-_ ]?(?:log)?|browser[-_ ]?console/.test(text)) {
    return "console-log";
  }
  if (/network[-_ ]?(?:log)?|har\b/.test(text)) {
    return "network-log";
  }
  return "file";
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
