import SwaggerParser from "@apidevtools/swagger-parser";
import type { CompatibilityCallToolResult, Tool } from "@modelcontextprotocol/sdk/types";
import { parse as parseYaml } from "yaml";
import { genericOAuthHeaders } from "./auth";
import type { OpenApiEndpointConfig } from "./config";
import { isAllowedRemoteUrl } from "./config/validation";
import {
  compactToolSafetyHints,
  compactToolSchemaHints,
  compactToolSelectionHints,
  type CompactTool,
} from "./downstream";
import { CapletsError, toSafeError } from "./errors";
import { isAbortError, parseHttpBody, readLimitedText } from "./http/utils";
import type { ServerRegistry } from "./registry";
import { markdownStructuredContent } from "./result-content";
import { searchToolList } from "./tool-search";

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
const JSON_CONTENT_TYPES = ["application/json"];
const FORBIDDEN_ARGUMENT_HEADERS = new Set([
  "accept",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

type HttpMethod = (typeof HTTP_METHODS)[number];
type OpenApiDocument = Record<string, any>;
type OpenApiOperation = {
  name: string;
  method: HttpMethod;
  path: string;
  summary?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requestBodyContentType?: string;
  baseUrl?: string;
  staticHeaders?: Record<string, string>;
};

type ManagedOpenApi = {
  operations?: OpenApiOperation[];
  fetchedAt?: number;
  cacheKey: string;
};

export class OpenApiManager {
  private readonly cache = new Map<string, ManagedOpenApi>();

  constructor(
    private registry: ServerRegistry,
    private readonly options: { authDir?: string } = {},
  ) {}

  updateRegistry(registry: ServerRegistry): void {
    this.registry = registry;
  }

  invalidate(serverId: string): void {
    this.cache.delete(serverId);
  }

  async checkEndpoint(endpoint: OpenApiEndpointConfig): Promise<{
    id: string;
    status: string;
    toolCount?: number;
    elapsedMs: number;
    error?: unknown;
  }> {
    const startedAt = Date.now();
    try {
      const operations = await this.refreshOperations(endpoint, true);
      this.registry.setStatus(endpoint.server, "available");
      return {
        id: endpoint.server,
        status: "available",
        toolCount: operations.length,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      const safe = toSafeError(error, "SERVER_UNAVAILABLE");
      this.registry.setStatus(endpoint.server, "unavailable", safe);
      return {
        id: endpoint.server,
        status: "unavailable",
        elapsedMs: Date.now() - startedAt,
        error: safe,
      };
    }
  }

  async listTools(endpoint: OpenApiEndpointConfig): Promise<Tool[]> {
    const operations = await this.refreshOperations(endpoint, false);
    return operations.map((operation) => this.toTool(operation));
  }

  async getTool(endpoint: OpenApiEndpointConfig, toolName: string): Promise<Tool> {
    const operation = await this.getOperation(endpoint, toolName);
    return this.toTool(operation);
  }

  async callTool(
    endpoint: OpenApiEndpointConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CompatibilityCallToolResult> {
    const operation = await this.getOperation(endpoint, toolName);
    const request = buildRequest(endpoint, operation, args, this.options.authDir);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), endpoint.requestTimeoutMs);
    try {
      const init: RequestInit = {
        method: operation.method.toUpperCase(),
        headers: request.headers,
        redirect: "manual",
        signal: controller.signal,
        ...(request.body === undefined ? {} : { body: request.body }),
      };
      const response = await fetch(request.url, init);
      if (response.status >= 300 && response.status < 400) {
        throw new CapletsError("DOWNSTREAM_PROTOCOL_ERROR", "OpenAPI request returned a redirect", {
          server: endpoint.server,
          status: response.status,
          location: response.headers.get("location") ? "[REDACTED]" : undefined,
        });
      }
      if (response.status === 401 || response.status === 403) {
        throw new CapletsError(
          response.status === 401 ? "AUTH_REQUIRED" : "AUTH_FAILED",
          "OpenAPI authentication failed",
          {
            server: endpoint.server,
            status: response.status,
            message: response.statusText,
            authType: endpoint.auth.type,
            challenge: response.headers.get("www-authenticate") ? "[REDACTED]" : undefined,
            ...(endpoint.auth.type === "oauth2" || endpoint.auth.type === "oidc"
              ? { nextAction: "run_caplets_auth_login" }
              : {}),
          },
        );
      }
      const parsed = await readResponse(response);
      return {
        content: markdownStructuredContent(parsed, {
          title: `${endpoint.name} call_tool ${toolName}`,
          backend: "openapi",
          operation: "call_tool",
          tool: toolName,
        }),
        structuredContent: parsed as Record<string, unknown>,
        isError: response.ok ? false : true,
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw new CapletsError(
          "TOOL_CALL_TIMEOUT",
          `OpenAPI request timed out for ${endpoint.server}/${toolName}`,
        );
      }
      if (error instanceof CapletsError) {
        throw error;
      }
      throw new CapletsError(
        "DOWNSTREAM_TOOL_ERROR",
        `OpenAPI request failed for ${endpoint.server}/${toolName}`,
        toSafeError(error),
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  compact(endpoint: OpenApiEndpointConfig, tool: Tool): CompactTool {
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

  search(
    endpoint: OpenApiEndpointConfig,
    tools: Tool[],
    query: string,
    limit: number,
  ): CompactTool[] {
    return searchToolList(tools, query, limit, (tool) => this.compact(endpoint, tool));
  }

  private async getOperation(
    endpoint: OpenApiEndpointConfig,
    toolName: string,
  ): Promise<OpenApiOperation> {
    const operations = await this.refreshOperations(endpoint, false);
    const operation = operations.find((candidate) => candidate.name === toolName);
    if (!operation) {
      throw new CapletsError(
        "TOOL_NOT_FOUND",
        `Tool ${toolName} was not found on ${endpoint.server}`,
        {
          server: endpoint.server,
          tool: toolName,
          suggestions: operations
            .map((candidate) => candidate.name)
            .filter((name) =>
              name.toLocaleLowerCase().includes(toolName.toLocaleLowerCase()[0] ?? ""),
            )
            .slice(0, 5),
        },
      );
    }
    return operation;
  }

  private async refreshOperations(
    endpoint: OpenApiEndpointConfig,
    force: boolean,
  ): Promise<OpenApiOperation[]> {
    const cached = this.cache.get(endpoint.server);
    const cacheKey = openApiCacheKey(endpoint);
    const now = Date.now();
    const isFresh =
      cached?.operations &&
      cached.cacheKey === cacheKey &&
      cached.fetchedAt !== undefined &&
      endpoint.operationCacheTtlMs > 0 &&
      now - cached.fetchedAt <= endpoint.operationCacheTtlMs;
    if (!force && isFresh) {
      return cached.operations ?? [];
    }

    try {
      const document = await loadOpenApiDocument(endpoint, this.options.authDir);
      const operations = extractOperations(endpoint, document);
      this.cache.set(endpoint.server, { operations, fetchedAt: Date.now(), cacheKey });
      this.registry.setStatus(endpoint.server, "available");
      return operations;
    } catch (error) {
      const safe = toSafeError(error, "DOWNSTREAM_PROTOCOL_ERROR");
      this.registry.setStatus(endpoint.server, "unavailable", safe);
      throw new CapletsError(
        safe.code,
        `Could not load OpenAPI operations for ${endpoint.server}`,
        safe,
      );
    }
  }

  private toTool(operation: OpenApiOperation): Tool {
    return {
      name: operation.name,
      ...(operation.summary || operation.description
        ? { description: operation.summary ?? operation.description }
        : {}),
      inputSchema: operation.inputSchema as Tool["inputSchema"],
      ...(operation.outputSchema
        ? { outputSchema: operation.outputSchema as Tool["outputSchema"] }
        : {}),
      annotations: {
        readOnlyHint: operation.method === "get" || operation.method === "head",
        destructiveHint: operation.method === "delete",
      },
    };
  }
}

async function loadOpenApiDocument(
  endpoint: OpenApiEndpointConfig,
  authDir?: string,
): Promise<OpenApiDocument> {
  const source = await loadOpenApiSource(endpoint, authDir);
  return (await SwaggerParser.validate(source as any, {
    resolve: {
      external: false,
    },
    dereference: { circular: "ignore" },
  })) as OpenApiDocument;
}

async function loadOpenApiSource(
  endpoint: OpenApiEndpointConfig,
  authDir?: string,
): Promise<string | OpenApiDocument> {
  if (endpoint.specPath) {
    return endpoint.specPath;
  }
  if (!endpoint.specUrl) {
    throw new CapletsError("CONFIG_INVALID", `${endpoint.server} is missing OpenAPI spec source`);
  }
  if (!endpoint.baseUrl) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `${endpoint.server} must configure baseUrl when using remote specUrl`,
    );
  }
  const response = await fetchWithLimit(
    endpoint.specUrl,
    endpoint.requestTimeoutMs,
    shouldSendSpecAuth(endpoint) ? authHeaders(endpoint, authDir) : {},
  );
  return parseOpenApiSourceText(response);
}

function parseOpenApiSourceText(source: string): OpenApiDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (jsonError) {
    try {
      parsed = parseYaml(source);
    } catch {
      throw jsonError instanceof Error ? jsonError : new Error(String(jsonError));
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OpenAPI source must parse to an object");
  }
  return parsed as OpenApiDocument;
}

function extractOperations(
  endpoint: OpenApiEndpointConfig,
  document: OpenApiDocument,
): OpenApiOperation[] {
  const operations: OpenApiOperation[] = [];
  const seen = new Set<string>();
  for (const [path, pathItem] of Object.entries((document.paths ?? {}) as Record<string, any>)) {
    if (!pathItem || typeof pathItem !== "object") {
      continue;
    }
    const inheritedParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== "object") {
        continue;
      }
      const name =
        typeof operation.operationId === "string" && operation.operationId.trim()
          ? operation.operationId.trim()
          : `${method.toUpperCase()} ${path}`;
      if (seen.has(name)) {
        throw new CapletsError("CONFIG_INVALID", `Duplicate OpenAPI operation name ${name}`, {
          server: endpoint.server,
        });
      }
      seen.add(name);
      const parameters = [
        ...inheritedParameters,
        ...(Array.isArray(operation.parameters) ? operation.parameters : []),
      ];
      const requestBody = requestBodyFor(operation);
      const outputSchema = outputSchemaFor(operation);
      const baseUrl = endpoint.baseUrl ?? firstServerUrl(document);
      const staticHeaders = staticHeaderDefaultsFor(endpoint, parameters);
      validateOperationBaseUrl(endpoint, baseUrl);
      operations.push({
        name,
        method,
        path,
        ...(typeof operation.summary === "string" ? { summary: operation.summary } : {}),
        ...(typeof operation.description === "string"
          ? { description: operation.description }
          : {}),
        inputSchema: inputSchemaFor(parameters, requestBody, staticHeaders),
        ...(outputSchema ? { outputSchema } : {}),
        ...(requestBody?.contentType ? { requestBodyContentType: requestBody.contentType } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(Object.keys(staticHeaders).length ? { staticHeaders } : {}),
      });
    }
  }
  return operations.sort((left, right) => left.name.localeCompare(right.name));
}

function staticHeaderDefaultsFor(
  endpoint: OpenApiEndpointConfig,
  parameters: any[],
): Record<string, string> {
  const configuredHeaderNames = configuredAuthHeaderNames(endpoint);
  const headers: Record<string, string> = {};
  for (const parameter of parameters) {
    if (parameter?.in !== "header" || typeof parameter.name !== "string") {
      continue;
    }
    const normalized = parameter.name.toLowerCase();
    if (
      configuredHeaderNames.has(normalized) ||
      (FORBIDDEN_ARGUMENT_HEADERS.has(normalized) && normalized !== "accept")
    ) {
      continue;
    }
    const defaultValue = parameter.schema?.default;
    if (["string", "number", "boolean"].includes(typeof defaultValue)) {
      headers[parameter.name] = String(defaultValue);
    }
  }
  return headers;
}

function requestBodyFor(
  operation: Record<string, any>,
): { required: boolean; schema: Record<string, unknown>; contentType: string } | undefined {
  const requestBody = operation.requestBody;
  if (!requestBody || typeof requestBody !== "object") {
    return undefined;
  }
  const content = requestBody.content;
  if (!content || typeof content !== "object") {
    return undefined;
  }
  const contentType = JSON_CONTENT_TYPES.find((candidate) => content[candidate]);
  if (!contentType) {
    throw new CapletsError("CONFIG_INVALID", "Unsupported OpenAPI request body content type");
  }
  return {
    required: requestBody.required === true,
    schema: safeSchema(content[contentType]?.schema),
    contentType,
  };
}

function outputSchemaFor(operation: Record<string, any>): Record<string, unknown> | undefined {
  const responses = operation.responses;
  if (!responses || typeof responses !== "object") {
    return undefined;
  }
  const schemas = [];
  for (const [status, response] of Object.entries(responses)) {
    if (!/^2\d\d$/.test(status) || !response || typeof response !== "object") {
      continue;
    }
    const content = (response as Record<string, any>).content;
    if (!content || typeof content !== "object") {
      continue;
    }
    const contentType = JSON_CONTENT_TYPES.find((candidate) => content[candidate]);
    if (!contentType) {
      continue;
    }
    const schema = actualSchema(content[contentType]?.schema);
    if (!schema) {
      continue;
    }
    schemas.push(schema);
  }
  if (schemas.length === 0) {
    return undefined;
  }
  const firstSchema = schemas[0]!;
  const restSchemas = schemas.slice(1);
  if (restSchemas.some((schema) => JSON.stringify(schema) !== JSON.stringify(firstSchema))) {
    return undefined;
  }
  return structuredOutputSchema(firstSchema);
}

function actualSchema(value: unknown): Record<string, unknown> | undefined {
  rejectExternalRefs(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const schema = value as Record<string, unknown>;
  return typeof schema.$ref === "string" ? undefined : schema;
}

function structuredOutputSchema(bodySchema: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "statusText", "headers"],
    properties: {
      status: { type: "number" },
      statusText: { type: "string" },
      // Keep generated headers intentionally small until response headers are modeled per operation.
      headers: {
        type: "object",
        additionalProperties: false,
        required: ["content-type"],
        properties: {
          "content-type": { type: "string" },
        },
      },
      body: bodySchema,
    },
  };
}

function inputSchemaFor(
  parameters: any[],
  requestBody?: { required: boolean; schema: Record<string, unknown>; contentType: string },
  staticHeaders: Record<string, string> = {},
): Record<string, unknown> {
  const schema: Record<string, any> = {
    type: "object",
    additionalProperties: false,
    properties: {},
  };
  const required: string[] = [];
  const protectedStaticHeaders = new Set(
    Object.keys(staticHeaders)
      .map((key) => key.toLowerCase())
      .filter((key) => FORBIDDEN_ARGUMENT_HEADERS.has(key)),
  );
  for (const location of ["path", "query", "header"] as const) {
    const locationParameters = parameters.filter(
      (parameter) =>
        parameter?.in === location &&
        !(location === "header" && protectedStaticHeaders.has(parameter.name?.toLowerCase())),
    );
    if (locationParameters.length === 0) {
      continue;
    }
    const nestedRequired = locationParameters
      .filter((parameter) => parameter.required === true || location === "path")
      .map((parameter) => parameter.name);
    schema.properties[location] = {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        locationParameters.map((parameter) => [parameter.name, safeSchema(parameter.schema)]),
      ),
      ...(nestedRequired.length ? { required: nestedRequired } : {}),
    };
    if (nestedRequired.length) {
      required.push(location);
    }
  }
  if (requestBody) {
    schema.properties.body = requestBody.schema;
    if (requestBody.required) {
      required.push("body");
    }
  }
  if (required.length) {
    schema.required = required;
  }
  return schema;
}

function safeSchema(value: unknown): Record<string, unknown> {
  rejectExternalRefs(value);
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function rejectExternalRefs(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      rejectExternalRefs(item);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const object = value as Record<string, unknown>;
  if (typeof object.$ref === "string" && !object.$ref.startsWith("#/")) {
    throw new CapletsError("CONFIG_INVALID", "External OpenAPI $ref values are not supported");
  }
  for (const nested of Object.values(object)) {
    rejectExternalRefs(nested);
  }
}

function buildRequest(
  endpoint: OpenApiEndpointConfig,
  operation: OpenApiOperation,
  args: Record<string, unknown>,
  authDir?: string,
): { url: URL; headers: Headers; body?: string } {
  const base = endpoint.baseUrl ?? operation.baseUrl;
  validateOperationBaseUrl(endpoint, base);
  const url = buildOperationUrl(
    base,
    substitutePath(operation.path, asRecord(args.path), operation),
  );
  for (const [key, value] of Object.entries(asRecord(args.query))) {
    if (value !== undefined && value !== null) {
      url.searchParams.append(key, serializeHttpValue("query", key, value));
    }
  }
  const headers = new Headers();
  applyAuth(headers, endpoint, authDir);
  const configuredHeaderNames = configuredAuthHeaderNames(endpoint);
  for (const [key, value] of Object.entries(operation.staticHeaders ?? {})) {
    if (!headers.has(key) && !configuredHeaderNames.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  for (const [key, value] of Object.entries(asRecord(args.header))) {
    if (value !== undefined && value !== null) {
      const normalized = key.toLowerCase();
      if (FORBIDDEN_ARGUMENT_HEADERS.has(normalized) || configuredHeaderNames.has(normalized)) {
        throw new CapletsError("REQUEST_INVALID", `Header ${key} cannot be supplied by arguments`);
      }
      headers.set(key, serializeHttpValue("header", key, value));
    }
  }
  let body: string | undefined;
  if ("body" in args) {
    if (operation.requestBodyContentType !== "application/json") {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Only application/json request bodies are supported",
      );
    }
    headers.set("content-type", "application/json");
    body = JSON.stringify(args.body);
  }
  return body === undefined ? { url, headers } : { url, headers, body };
}

function firstServerUrl(operation: Record<string, any>): string | undefined {
  const servers = operation.servers;
  if (Array.isArray(servers) && typeof servers[0]?.url === "string") {
    return servers[0].url;
  }
  return undefined;
}

function substitutePath(
  path: string,
  values: Record<string, unknown>,
  operation: OpenApiOperation,
): string {
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined || value === null || value === "") {
      throw new CapletsError("REQUEST_INVALID", `Missing required path parameter ${name}`, {
        tool: operation.name,
      });
    }
    return encodeURIComponent(serializeHttpValue("path", name, value));
  });
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
        `OpenAPI ${location} parameter ${name} must be a string, number, or boolean`,
      );
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function applyAuth(headers: Headers, endpoint: OpenApiEndpointConfig, authDir?: string): void {
  for (const [key, value] of Object.entries(authHeaders(endpoint, authDir))) {
    headers.set(key, value);
  }
}

function configuredAuthHeaderNames(endpoint: OpenApiEndpointConfig): Set<string> {
  return endpoint.auth.type === "headers"
    ? new Set(Object.keys(endpoint.auth.headers).map((key) => key.toLowerCase()))
    : new Set<string>();
}

function authHeaders(endpoint: OpenApiEndpointConfig, authDir?: string): Record<string, string> {
  switch (endpoint.auth.type) {
    case "none":
      return {};
    case "bearer":
      return { authorization: `Bearer ${endpoint.auth.token}` };
    case "headers":
      return endpoint.auth.headers;
    case "oauth2":
    case "oidc":
      return genericOAuthHeaders(endpoint, authDir);
  }
}

function shouldSendSpecAuth(endpoint: OpenApiEndpointConfig): boolean {
  return Boolean(
    endpoint.specUrl &&
    endpoint.baseUrl &&
    new URL(endpoint.specUrl).origin === new URL(endpoint.baseUrl).origin,
  );
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await readLimitedText(response, {
    errorMessage: "OpenAPI response exceeded byte limit",
  });
  const body = parseHttpBody(contentType, text);
  return {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "content-type": contentType,
    },
    ...(body === undefined ? {} : { body }),
  };
}

async function fetchWithLimit(
  url: string,
  timeoutMs: number,
  headers: Record<string, string> = {},
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers,
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new CapletsError(
        "DOWNSTREAM_PROTOCOL_ERROR",
        "OpenAPI spec request returned a redirect",
      );
    }
    if (!response.ok) {
      throw new CapletsError("DOWNSTREAM_PROTOCOL_ERROR", "OpenAPI spec request failed", {
        status: response.status,
      });
    }
    return await readLimitedText(response, {
      errorMessage: "OpenAPI response exceeded byte limit",
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new CapletsError("TOOL_CALL_TIMEOUT", "OpenAPI spec request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function validateOperationBaseUrl(
  endpoint: OpenApiEndpointConfig,
  base: string | undefined,
): asserts base is string {
  if (!base) {
    throw new CapletsError("CONFIG_INVALID", `${endpoint.server} is missing OpenAPI baseUrl`);
  }
  if (endpoint.specUrl && !endpoint.baseUrl) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `${endpoint.server} must configure baseUrl when using remote specUrl`,
    );
  }
  if (!isAllowedRemoteUrl(base)) {
    throw new CapletsError("CONFIG_INVALID", `${endpoint.server} OpenAPI baseUrl is not allowed`);
  }
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `${endpoint.server} OpenAPI baseUrl must not include credentials, query, or fragment`,
    );
  }
}

function buildOperationUrl(base: string, operationPath: string): URL {
  if (/^[a-z][a-z0-9+.-]*:/i.test(operationPath) || operationPath.startsWith("//")) {
    throw new CapletsError("CONFIG_INVALID", "OpenAPI operation path cannot change origin");
  }
  const baseUrl = new URL(base);
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const relativePath = operationPath.replace(/^\/+/, "");
  baseUrl.pathname = [basePath, relativePath].filter(Boolean).join("/");
  return baseUrl;
}

function openApiCacheKey(endpoint: OpenApiEndpointConfig): string {
  return JSON.stringify({
    specPath: endpoint.specPath,
    specUrl: endpoint.specUrl,
    baseUrl: endpoint.baseUrl,
  });
}
