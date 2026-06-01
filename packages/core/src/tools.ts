import type { CallToolResult } from "@modelcontextprotocol/sdk/types";
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
import {
  generatedToolInputSchemaForCaplet,
  mcpOperations,
  operations,
} from "./generated-tool-input-schema";
import {
  markdownCallToolResultContent,
  markdownStructuredContent,
  type ResultMarkdownContext,
} from "./result-content";

export { generatedToolInputSchema } from "./generated-tool-input-schema";

export type GeneratedServerToolRequest = RequiredOperationRequest;

type ParsedOperationRequest = RequiredOperationRequest & Record<string, unknown>;

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
  const parsed = validateOperationRequest(
    request,
    registry.config.options.maxSearchLimit,
    server.backend,
  );

  switch (parsed.operation) {
    case "inspect":
      return jsonResult(
        registry.detail(server),
        metadataFor(server, "inspect", undefined, startedAt),
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
          id: server.server,
          name: server.name,
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
          id: server.server,
          name: server.name,
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
        { id: server.server, tool },
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

      const metadata = metadataFor(server, "call_tool", parsed.tool, startedAt);
      const result = projectCallToolResult(
        await backend.callTool(server as never, parsed.tool, parsed.arguments),
        tool.outputSchema,
        parsed.fields,
        markdownContextFor(metadata),
      );
      return annotateCallToolResult(result, metadata);
    }
    case "list_resources": {
      const backend = mcpBackendFor(server, downstream);
      const resources = await backend.listResources(server as never);
      const templates = await backend.listResourceTemplates(server as never);
      const limit = parsed.limit ?? resources.length + templates.length;
      return jsonResult(
        {
          id: server.server,
          name: server.name,
          resources: resources
            .slice(0, limit)
            .map((resource) => backend.compactResource(server as never, resource)),
          resourceTemplates: templates
            .slice(0, Math.max(0, limit - resources.length))
            .map((template) => backend.compactResourceTemplate(server as never, template)),
        },
        metadataFor(server, "list_resources", undefined, startedAt),
      );
    }
    case "search_resources": {
      const backend = mcpBackendFor(server, downstream);
      const resources = await backend.listResources(server as never);
      const templates = await backend.listResourceTemplates(server as never);
      const limit = parsed.limit ?? registry.config.options.defaultSearchLimit;
      const resourceMatches = backend.searchResources(
        server as never,
        resources,
        parsed.query,
        limit,
      );
      const templateMatches = backend.searchResourceTemplates(
        server as never,
        templates,
        parsed.query,
        Math.max(0, limit - resourceMatches.length),
      );
      return jsonResult(
        {
          id: server.server,
          name: server.name,
          query: parsed.query,
          matches: [...resourceMatches, ...templateMatches],
        },
        metadataFor(server, "search_resources", undefined, startedAt),
      );
    }
    case "list_resource_templates": {
      const backend = mcpBackendFor(server, downstream);
      const templates = await backend.listResourceTemplates(server as never);
      const limit = parsed.limit ?? templates.length;
      return jsonResult(
        {
          id: server.server,
          name: server.name,
          resourceTemplates: templates
            .slice(0, limit)
            .map((template) => backend.compactResourceTemplate(server as never, template)),
        },
        metadataFor(server, "list_resource_templates", undefined, startedAt),
      );
    }
    case "read_resource": {
      const result = await mcpBackendFor(server, downstream).readResource(
        server as never,
        parsed.uri,
      );
      return annotateMcpResult(
        result,
        metadataFor(server, "read_resource", { uri: parsed.uri }, startedAt),
      );
    }
    case "list_prompts": {
      const backend = mcpBackendFor(server, downstream);
      const prompts = await backend.listPrompts(server as never);
      const limit = parsed.limit ?? prompts.length;
      return jsonResult(
        {
          id: server.server,
          name: server.name,
          prompts: prompts
            .slice(0, limit)
            .map((prompt) => backend.compactPrompt(server as never, prompt)),
        },
        metadataFor(server, "list_prompts", undefined, startedAt),
      );
    }
    case "search_prompts": {
      const backend = mcpBackendFor(server, downstream);
      const prompts = await backend.listPrompts(server as never);
      const limit = parsed.limit ?? registry.config.options.defaultSearchLimit;
      return jsonResult(
        {
          id: server.server,
          name: server.name,
          query: parsed.query,
          prompts: backend.searchPrompts(server as never, prompts, parsed.query, limit),
        },
        metadataFor(server, "search_prompts", undefined, startedAt),
      );
    }
    case "get_prompt": {
      const result = await mcpBackendFor(server, downstream).getPrompt(
        server as never,
        parsed.prompt,
        parsed.arguments,
      );
      return annotateMcpResult(
        result,
        metadataFor(server, "get_prompt", { prompt: parsed.prompt }, startedAt),
      );
    }
    case "complete": {
      const result = await mcpBackendFor(server, downstream).complete(server as never, {
        ref: parsed.ref,
        argument: parsed.argument,
      });
      return annotateMcpResult(result, metadataFor(server, "complete", undefined, startedAt));
    }
  }
}

export function validateOperationRequest(
  request: unknown,
  maxSearchLimit: number,
  backend: string = "tool",
): RequiredOperationRequest {
  const result = generatedToolInputSchemaForCaplet({ backend }).safeParse(request);
  if (
    request &&
    typeof request === "object" &&
    "operation" in request &&
    typeof (request as { operation?: unknown }).operation === "string" &&
    !mcpOperations.includes((request as { operation: string }).operation as never)
  ) {
    throw new CapletsError(
      "UNKNOWN_OPERATION",
      `Unknown operation: ${(request as { operation: string }).operation}`,
    );
  }
  if (
    request &&
    typeof request === "object" &&
    "operation" in request &&
    typeof (request as { operation?: unknown }).operation === "string" &&
    backend !== "mcp" &&
    mcpOperations.includes((request as { operation: string }).operation as never) &&
    !operations.includes((request as { operation: string }).operation as never)
  ) {
    throw new CapletsError(
      "UNSUPPORTED_OPERATION",
      `${(request as { operation: string }).operation} is only available for MCP-backed Caplets`,
    );
  }
  if (!result.success) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Generated server tool request is invalid",
      result.error.issues,
    );
  }

  const value = result.data as ParsedOperationRequest;
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
    case "inspect":
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
    case "list_resources":
    case "list_resource_templates":
    case "list_prompts":
      allowed(["limit"]);
      if (value.limit !== undefined && value.limit > maxSearchLimit) {
        throw new CapletsError(
          "REQUEST_INVALID",
          `${value.operation} limit must be <= ${maxSearchLimit}`,
        );
      }
      return value.limit === undefined
        ? { operation: value.operation }
        : { operation: value.operation, limit: value.limit };
    case "search_resources":
    case "search_prompts":
      allowed(["query", "limit"]);
      if (!value.query)
        throw new CapletsError("REQUEST_INVALID", `${value.operation} requires query`);
      if (value.limit !== undefined && value.limit > maxSearchLimit) {
        throw new CapletsError(
          "REQUEST_INVALID",
          `${value.operation} limit must be <= ${maxSearchLimit}`,
        );
      }
      return value.limit === undefined
        ? { operation: value.operation, query: value.query }
        : { operation: value.operation, query: value.query, limit: value.limit };
    case "read_resource":
      allowed(["uri"]);
      if (!value.uri) throw new CapletsError("REQUEST_INVALID", "read_resource requires uri");
      return { operation: "read_resource", uri: value.uri };
    case "get_prompt":
      allowed(["prompt", "arguments"]);
      if (!value.prompt) throw new CapletsError("REQUEST_INVALID", "get_prompt requires prompt");
      if (value.arguments !== undefined && !isPlainObject(value.arguments)) {
        throw new CapletsError("REQUEST_INVALID", "get_prompt.arguments must be a JSON object");
      }
      return { operation: "get_prompt", prompt: value.prompt, arguments: value.arguments ?? {} };
    case "complete":
      allowed(["ref", "argument"]);
      if (!value.ref) throw new CapletsError("REQUEST_INVALID", "complete requires ref");
      if (!value.argument) throw new CapletsError("REQUEST_INVALID", "complete requires argument");
      return { operation: "complete", ref: value.ref, argument: value.argument };
  }
  throw new CapletsError("INTERNAL_ERROR", "Unhandled operation");
}

function mcpBackendFor(server: CapletConfig, downstream: DownstreamManager): DownstreamManager {
  if (server.backend !== "mcp") {
    throw new CapletsError(
      "UNSUPPORTED_OPERATION",
      "MCP resource, prompt, and completion operations require an MCP-backed Caplet",
    );
  }
  return downstream;
}

type RequiredOperationRequest =
  | { operation: "inspect" | "check_backend" }
  | { operation: "list_tools"; limit?: number }
  | { operation: "search_tools"; query: string; limit?: number }
  | { operation: "get_tool"; tool: string }
  | { operation: "call_tool"; tool: string; arguments: Record<string, unknown>; fields?: string[] }
  | { operation: "list_resources" | "list_resource_templates" | "list_prompts"; limit?: number }
  | { operation: "search_resources" | "search_prompts"; query: string; limit?: number }
  | { operation: "read_resource"; uri: string }
  | { operation: "get_prompt"; prompt: string; arguments: Record<string, unknown> }
  | {
      operation: "complete";
      ref: { type: "prompt"; name: string } | { type: "resourceTemplate"; uri: string };
      argument: { name: string; value: string };
    };

export type CapletArtifact = {
  kind: "screenshot" | "snapshot" | "console-log" | "network-log" | "file";
  displayPath: string;
  pathResolution: "absolute" | "relative-to-mcp-server";
};

export type CapletExecutionMetadata = {
  kind: "local" | "remote" | "cloud" | "local-fallback";
  runtimeId?: string | undefined;
  sandboxId?: string | undefined;
  presenceId?: string | undefined;
  fallback?: boolean | undefined;
  fallbackReason?: "hosted_runtime_limit_reached" | "hosted_runtime_degraded" | undefined;
  project?:
    | {
        bound: boolean;
        fingerprint?: string | undefined;
        syncReceiptId?: string | undefined;
        applyReceiptId?: string | undefined;
      }
    | undefined;
};

export type CapletResultMetadata = {
  id: string;
  name: string;
  backend: string;
  operation: RequiredOperationRequest["operation"];
  tool?: string;
  uri?: string;
  prompt?: string;
  status: "ok" | "error";
  elapsedMs?: number;
  artifacts?: CapletArtifact[];
  execution?: CapletExecutionMetadata | undefined;
};

export function metadataFor(
  server: CapletConfig,
  operation: RequiredOperationRequest["operation"],
  target?: string | { tool?: string; uri?: string; prompt?: string },
  startedAt?: number,
  execution?: CapletExecutionMetadata,
): CapletResultMetadata {
  const targetFields = typeof target === "string" ? { tool: target } : (target ?? {});
  return {
    id: server.server,
    name: server.name,
    backend: server.backend,
    operation,
    ...targetFields,
    status: "ok",
    ...(startedAt === undefined ? {} : { elapsedMs: Date.now() - startedAt }),
    ...(execution === undefined ? {} : { execution }),
  };
}

export function annotateMcpResult<T extends object>(result: T, metadata: CapletResultMetadata): T {
  const existingMeta = (result as { _meta?: unknown })._meta;
  return {
    ...result,
    _meta: {
      ...(isPlainObject(existingMeta) ? existingMeta : {}),
      caplets: metadata,
    },
  };
}

function markdownContextFor(metadata: CapletResultMetadata): ResultMarkdownContext {
  return {
    title: [metadata.name, metadata.operation, metadata.tool ?? metadata.uri ?? metadata.prompt]
      .filter(Boolean)
      .join(" "),
    backend: metadata.backend,
    operation: metadata.operation,
    ...(metadata.tool ? { tool: metadata.tool } : {}),
    ...(metadata.uri ? { uri: metadata.uri } : {}),
    ...(metadata.prompt ? { prompt: metadata.prompt } : {}),
  };
}

export function jsonResult(value: unknown, metadata?: CapletResultMetadata): CallToolResult {
  const structuredContent = {
    ...(metadata === undefined ? {} : { caplets: metadata }),
    result: value as Record<string, unknown>,
  };
  return {
    content: markdownStructuredContent(
      structuredContent,
      metadata ? markdownContextFor(metadata) : { title: "Result" },
    ),
    structuredContent,
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
    content: markdownCallToolResultContent(
      result as CallToolResult,
      markdownContextFor(annotatedMetadata),
    ),
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
  context: ResultMarkdownContext = {},
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
    content: markdownStructuredContent(projected, context),
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
