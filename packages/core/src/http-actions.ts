import type { CompatibilityCallToolResult, Tool } from "@modelcontextprotocol/sdk/types";
import { genericOAuthHeaders } from "./auth";
import type { HttpActionConfig, HttpApiConfig } from "./config";
import { FORBIDDEN_HEADERS, isAllowedRemoteUrl } from "./config/validation";
import {
  compactToolSafetyHints,
  compactToolSchemaHints,
  compactToolSelectionHints,
  type CompactTool,
} from "./downstream";
import { CapletsError, toSafeError } from "./errors";
import { readHttpLikeResponse } from "./http/response";
import { DEFAULT_MAX_RESPONSE_BYTES, isAbortError } from "./http/utils";
import { httpLikeMediaOutputSchema } from "./media/results";
import type { ServerRegistry } from "./registry";
import { markdownStructuredContent } from "./result-content";
import { searchToolList } from "./tool-search";

const DEFAULT_INPUT_SCHEMA = { type: "object", additionalProperties: true } as const;
type HttpActionOperation = HttpActionConfig & { name: string };

export class HttpActionManager {
  constructor(
    private registry: ServerRegistry,
    private readonly options: {
      authDir?: string;
      artifactDir?: string;
      exposeLocalArtifactPaths?: boolean;
      mediaInlineThresholdBytes?: number;
    } = {},
  ) {}

  updateRegistry(registry: ServerRegistry): void {
    this.registry = registry;
  }

  invalidate(_serverId: string): void {}

  async checkApi(api: HttpApiConfig): Promise<{
    id: string;
    status: string;
    toolCount?: number;
    elapsedMs: number;
    error?: unknown;
  }> {
    const startedAt = Date.now();
    try {
      const operations = operationsFor(api);
      validateBaseUrl(api);
      await authHeaders(api, this.options.authDir);
      for (const operation of operations) {
        validateAction(api, operation);
      }
      this.registry.setStatus(api.server, "available");
      return {
        id: api.server,
        status: "available",
        toolCount: operations.length,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      const safe = toSafeError(error, "SERVER_UNAVAILABLE");
      this.registry.setStatus(api.server, "unavailable", safe);
      return {
        id: api.server,
        status: "unavailable",
        elapsedMs: Date.now() - startedAt,
        error: safe,
      };
    }
  }

  async listTools(api: HttpApiConfig): Promise<Tool[]> {
    return operationsFor(api).map((operation) => this.toTool(operation));
  }

  async getTool(api: HttpApiConfig, toolName: string): Promise<Tool> {
    return this.toTool(getOperation(api, toolName));
  }

  async callTool(
    api: HttpApiConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CompatibilityCallToolResult> {
    const operation = getOperation(api, toolName);
    const startedAt = Date.now();
    const request = await buildRequest(api, operation, args, this.options.authDir);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), api.requestTimeoutMs);
    try {
      const response = await fetch(request.url, {
        method: operation.method,
        headers: request.headers,
        redirect: "manual",
        signal: controller.signal,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      if (response.status >= 300 && response.status < 400) {
        throw new CapletsError(
          "DOWNSTREAM_PROTOCOL_ERROR",
          "HTTP action request returned a redirect",
          {
            server: api.server,
            status: response.status,
            location: response.headers.get("location") ? "[REDACTED]" : undefined,
          },
        );
      }
      const parsed = {
        ...(await readHttpLikeResponse(response, {
          capletId: api.server,
          method: operation.method,
          ...(this.options.artifactDir ? { artifactDir: this.options.artifactDir } : {}),
          ...(this.options.exposeLocalArtifactPaths === false ? { exposeLocalPath: false } : {}),
          maxInlineBytes: this.options.mediaInlineThresholdBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
          maxBytes: api.maxResponseBytes,
        })),
        elapsedMs: Date.now() - startedAt,
      };
      return {
        content: markdownStructuredContent(parsed, {
          title: `${api.name} call_tool ${toolName}`,
          backend: "http",
          operation: "call_tool",
          tool: toolName,
        }),
        structuredContent: parsed,
        isError: !response.ok,
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw new CapletsError(
          "TOOL_CALL_TIMEOUT",
          `HTTP action request timed out for ${api.server}/${toolName}`,
        );
      }
      if (error instanceof CapletsError) {
        throw error;
      }
      throw new CapletsError(
        "DOWNSTREAM_TOOL_ERROR",
        `HTTP action request failed for ${api.server}/${toolName}`,
        toSafeError(error),
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  compact(api: HttpApiConfig, tool: Tool): CompactTool {
    return {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      hasInputSchema: Boolean(tool.inputSchema),
      hasOutputSchema: Boolean(tool.outputSchema),
      supportsFields: Boolean(tool.outputSchema),
      ...compactToolSelectionHints(tool),
      ...compactToolSchemaHints(tool),
      ...compactToolSafetyHints(tool),
    };
  }

  search(api: HttpApiConfig, tools: Tool[], query: string, limit: number): CompactTool[] {
    return searchToolList(tools, query, limit, (tool) => this.compact(api, tool));
  }

  private toTool(operation: HttpActionOperation): Tool {
    return {
      name: operation.name,
      ...(operation.description ? { description: operation.description } : {}),
      ...(operation.useWhen ? { useWhen: operation.useWhen } : {}),
      ...(operation.avoidWhen ? { avoidWhen: operation.avoidWhen } : {}),
      inputSchema: (operation.inputSchema ?? DEFAULT_INPUT_SCHEMA) as Tool["inputSchema"],
      ...(operation.outputSchema
        ? {
            outputSchema: httpLikeMediaOutputSchema(operation.outputSchema) as Tool["outputSchema"],
          }
        : {}),
      annotations: {
        readOnlyHint: operation.method === "GET",
        destructiveHint: operation.method === "DELETE",
      },
    };
  }
}

function operationsFor(api: HttpApiConfig): HttpActionOperation[] {
  return Object.entries(api.actions)
    .map(([name, action]) => ({ name, ...action }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function getOperation(api: HttpApiConfig, toolName: string): HttpActionOperation {
  const operations = operationsFor(api);
  const operation = operations.find((candidate) => candidate.name === toolName);
  if (!operation) {
    throw new CapletsError("TOOL_NOT_FOUND", `Tool ${toolName} was not found on ${api.server}`, {
      server: api.server,
      tool: toolName,
      suggestions: operations
        .map((candidate) => candidate.name)
        .filter((name) => name.toLocaleLowerCase().includes(toolName.toLocaleLowerCase()[0] ?? ""))
        .slice(0, 5),
    });
  }
  return operation;
}

async function buildRequest(
  api: HttpApiConfig,
  operation: HttpActionOperation,
  args: Record<string, unknown>,
  authDir?: string,
): Promise<{ url: URL; headers: Headers; body?: string }> {
  validateBaseUrl(api);
  validateAction(api, operation);
  const url = buildActionUrl(api.baseUrl, substitutePath(operation.path, args, operation), {
    allowEncodedSlash: true,
  });
  const query = resolveMappingToRecord(operation.query, args, "query");
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, serializeHttpValue("query", key, value));
    }
  }
  const headers = new Headers();
  await applyAuth(headers, api, authDir);
  const resolvedHeaders = resolveMappingToRecord(operation.headers, args, "headers");
  for (const [key, value] of Object.entries(resolvedHeaders)) {
    if (value !== undefined && value !== null) {
      validateResolvedHeader(api, operation, key);
      headers.set(key, serializeHttpValue("header", key, value));
    }
  }
  const bodyValue = resolveMapping(operation.jsonBody, args);
  if (operation.jsonBody !== undefined) {
    if (bodyValue === undefined) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "HTTP action jsonBody must not resolve to undefined",
      );
    }
    headers.set("content-type", "application/json");
    return { url, headers, body: JSON.stringify(bodyValue) };
  }
  return { url, headers };
}

function substitutePath(
  path: string,
  args: Record<string, unknown>,
  operation: HttpActionOperation,
): string {
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = args[name];
    if (value === undefined || value === null || value === "") {
      throw new CapletsError("REQUEST_INVALID", `Missing required path parameter ${name}`, {
        tool: operation.name,
      });
    }
    return encodeURIComponent(serializeHttpValue("path", name, value));
  });
}

function resolveMapping(mapping: unknown, input: Record<string, unknown>): unknown {
  if (typeof mapping === "string") {
    if (mapping === "$input") {
      return input;
    }
    if (mapping.startsWith("$input.")) {
      return valueAtPath(input, mapping.slice("$input.".length));
    }
    return mapping;
  }
  if (Array.isArray(mapping)) {
    return mapping.map((item) => resolveMapping(item, input));
  }
  if (mapping && typeof mapping === "object") {
    return Object.fromEntries(
      Object.entries(mapping).map(([key, value]) => [key, resolveMapping(value, input)]),
    );
  }
  return mapping;
}

function resolveMappingToRecord(
  mapping: unknown,
  input: Record<string, unknown>,
  name: "query" | "headers",
): Record<string, unknown> {
  if (mapping === undefined) {
    return {};
  }
  const resolved = resolveMapping(mapping, input);
  if (!isPlainObject(resolved)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `HTTP action ${name} mapping must resolve to an object`,
    );
  }
  return resolved;
}

function valueAtPath(input: Record<string, unknown>, path: string): unknown {
  let current: unknown = input;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function validateAction(api: HttpApiConfig, operation: HttpActionOperation): void {
  buildActionUrl(api.baseUrl, operation.path);
  validateConfiguredHeaders(api, operation);
}

function validateConfiguredHeaders(api: HttpApiConfig, operation: HttpActionOperation): void {
  const configured = asRecord(operation.headers);
  for (const key of Object.keys(configured)) {
    validateResolvedHeader(api, operation, key);
  }
}

function validateResolvedHeader(
  api: HttpApiConfig,
  operation: HttpActionOperation,
  key: string,
): void {
  const authHeaderNames =
    api.auth.type === "headers"
      ? new Set(Object.keys(api.auth.headers).map((header) => header.toLowerCase()))
      : new Set<string>();
  const normalized = key.toLowerCase();
  if (FORBIDDEN_HEADERS.has(normalized) || authHeaderNames.has(normalized)) {
    throw new CapletsError("CONFIG_INVALID", `HTTP action header ${key} is not allowed`, {
      server: api.server,
      tool: operation.name,
    });
  }
}

function serializeHttpValue(
  location: "path" | "query" | "header",
  name: string,
  value: unknown,
): string {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return String(value);
    default:
      throw new CapletsError(
        "REQUEST_INVALID",
        `HTTP action ${location} parameter ${name} must be a string, number, or boolean`,
      );
  }
}

async function applyAuth(headers: Headers, api: HttpApiConfig, authDir?: string): Promise<void> {
  for (const [key, value] of Object.entries(await authHeaders(api, authDir))) {
    headers.set(key, value);
  }
}

async function authHeaders(api: HttpApiConfig, authDir?: string): Promise<Record<string, string>> {
  switch (api.auth.type) {
    case "none":
      return {};
    case "bearer":
      return { authorization: `Bearer ${api.auth.token}` };
    case "headers":
      return api.auth.headers;
    case "oauth2":
    case "oidc":
      return await genericOAuthHeaders(
        {
          server: api.server,
          backend: "http",
          baseUrl: api.baseUrl,
          auth: api.auth,
          requestTimeoutMs: api.requestTimeoutMs,
        },
        authDir,
      );
  }
}

function validateBaseUrl(api: HttpApiConfig): void {
  if (!isAllowedRemoteUrl(api.baseUrl)) {
    throw new CapletsError("CONFIG_INVALID", `${api.server} HTTP API baseUrl is not allowed`);
  }
  const url = new URL(api.baseUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `${api.server} HTTP API baseUrl must not include credentials, query, or fragment`,
    );
  }
}

function buildActionUrl(
  base: string,
  actionPath: string,
  options: { allowEncodedSlash?: boolean } = {},
): URL {
  if (/^[a-z][a-z0-9+.-]*:/i.test(actionPath) || actionPath.startsWith("//")) {
    throw new CapletsError("CONFIG_INVALID", "HTTP action path cannot change origin");
  }
  for (const rawSegment of actionPath.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      throw new CapletsError("CONFIG_INVALID", "HTTP action path contains invalid encoding");
    }
    if (
      segment === "." ||
      segment === ".." ||
      (!options.allowEncodedSlash && segment.includes("/"))
    ) {
      throw new CapletsError("CONFIG_INVALID", "HTTP action path cannot contain dot segments");
    }
  }
  const baseUrl = new URL(base);
  const originalOrigin = baseUrl.origin;
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const relativePath = actionPath.replace(/^\/+/, "");
  baseUrl.pathname = [basePath, relativePath].filter(Boolean).join("/");
  if (baseUrl.origin !== originalOrigin) {
    throw new CapletsError("CONFIG_INVALID", "HTTP action path cannot change origin");
  }
  if (basePath && baseUrl.pathname !== basePath && !baseUrl.pathname.startsWith(`${basePath}/`)) {
    throw new CapletsError("CONFIG_INVALID", "HTTP action path cannot escape baseUrl path");
  }
  return baseUrl;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
