import { readFileSync } from "node:fs";
import type { CompatibilityCallToolResult, Tool } from "@modelcontextprotocol/sdk/types";
import {
  buildClientSchema,
  buildSchema,
  getIntrospectionQuery,
  getNamedType,
  GraphQLEnumType,
  GraphQLInputObjectType,
  type GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  type GraphQLObjectType,
  GraphQLScalarType,
  type GraphQLField,
  type GraphQLArgument,
  type GraphQLInputType,
  type GraphQLOutputType,
  type GraphQLSchema,
  isAbstractType,
  isInputObjectType,
  isNonNullType,
  isObjectType,
  isScalarType,
  parse,
  type OperationDefinitionNode,
  type TypeNode,
  validate,
} from "graphql";
import { genericOAuthHeaders } from "./auth";
import type { GraphQlEndpointConfig } from "./config";
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

const GRAPHQL_METHOD = "POST";
const SCALAR_JSON_SCHEMA: Record<string, Record<string, unknown>> = {
  String: { type: "string" },
  ID: { type: "string" },
  Int: { type: "integer" },
  Float: { type: "number" },
  Boolean: { type: "boolean" },
};

type GraphQlOperation = {
  name: string;
  description?: string;
  useWhen?: string;
  avoidWhen?: string;
  document: string;
  operationName?: string;
  inputSchema: Record<string, unknown>;
  kind: "query" | "mutation";
  generated: boolean;
};

type ManagedGraphQl = {
  operations?: GraphQlOperation[];
  fetchedAt?: number;
  cacheKey: string;
};

export type { GraphQlEndpointConfig as GraphqlEndpointConfig } from "./config";

export class GraphQLManager {
  private readonly cache = new Map<string, ManagedGraphQl>();

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

  async checkEndpoint(endpoint: GraphQlEndpointConfig): Promise<{
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

  async listTools(endpoint: GraphQlEndpointConfig): Promise<Tool[]> {
    const operations = await this.refreshOperations(endpoint, false);
    return operations.map((operation) => this.toTool(operation));
  }

  async getTool(endpoint: GraphQlEndpointConfig, toolName: string): Promise<Tool> {
    const operation = await this.getOperation(endpoint, toolName);
    return this.toTool(operation);
  }

  async callTool(
    endpoint: GraphQlEndpointConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CompatibilityCallToolResult> {
    const operation = await this.getOperation(endpoint, toolName);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), endpoint.requestTimeoutMs);
    try {
      const headers = new Headers({
        "content-type": "application/json",
        ...staticHeaders(endpoint),
        ...(await genericOAuthHeaders(
          {
            server: endpoint.server,
            backend: "graphql",
            url: endpoint.endpointUrl,
            auth: endpoint.auth,
            requestTimeoutMs: endpoint.requestTimeoutMs,
          },
          this.options.authDir,
        )),
      });
      const response = await fetch(endpoint.endpointUrl, {
        method: GRAPHQL_METHOD,
        headers,
        redirect: "manual",
        signal: controller.signal,
        body: JSON.stringify({
          query: operation.document,
          variables: args,
          ...(operation.operationName ? { operationName: operation.operationName } : {}),
        }),
      });
      if (response.status >= 300 && response.status < 400) {
        throw new CapletsError("DOWNSTREAM_PROTOCOL_ERROR", "GraphQL request returned a redirect", {
          server: endpoint.server,
          status: response.status,
          location: response.headers.get("location") ? "[REDACTED]" : undefined,
        });
      }
      if (response.status === 401 || response.status === 403) {
        throw new CapletsError(
          response.status === 401 ? "AUTH_REQUIRED" : "AUTH_FAILED",
          "GraphQL authentication failed",
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
      const body = parseHttpBody(
        response.headers.get("content-type") ?? "",
        await readGraphQlText(response),
      );
      const result = {
        status: response.status,
        statusText: response.statusText,
        headers: {
          "content-type": response.headers.get("content-type") ?? "",
        },
        body,
      };
      return {
        content: markdownStructuredContent(result, {
          title: `${endpoint.name} call_tool ${toolName}`,
          backend: "graphql",
          operation: "call_tool",
          tool: toolName,
        }),
        structuredContent: result,
        isError:
          !response.ok ||
          Boolean(body && typeof body === "object" && "errors" in body && (body as any).errors),
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw new CapletsError(
          "TOOL_CALL_TIMEOUT",
          `GraphQL request timed out for ${endpoint.server}/${toolName}`,
        );
      }
      if (error instanceof CapletsError) {
        throw error;
      }
      throw new CapletsError(
        "DOWNSTREAM_TOOL_ERROR",
        `GraphQL request failed for ${endpoint.server}/${toolName}`,
        toSafeError(error),
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  compact(endpoint: GraphQlEndpointConfig, tool: Tool): CompactTool {
    return {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      hasInputSchema: Boolean(tool.inputSchema),
      hasOutputSchema: Boolean(tool.outputSchema),
      supportsFields: false,
      ...compactToolSelectionHints(tool),
      ...compactToolSchemaHints(tool),
      ...compactToolSafetyHints(tool),
    };
  }

  search(
    endpoint: GraphQlEndpointConfig,
    tools: Tool[],
    query: string,
    limit: number,
  ): CompactTool[] {
    return searchToolList(tools, query, limit, (tool) => this.compact(endpoint, tool));
  }

  private async getOperation(
    endpoint: GraphQlEndpointConfig,
    toolName: string,
  ): Promise<GraphQlOperation> {
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
    endpoint: GraphQlEndpointConfig,
    force: boolean,
  ): Promise<GraphQlOperation[]> {
    const cached = this.cache.get(endpoint.server);
    const cacheKey = graphQlCacheKey(endpoint);
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
      validateEndpointUrl(endpoint.endpointUrl);
      const schema = await loadSchema(endpoint, this.options.authDir);
      const operations =
        endpoint.operations && Object.keys(endpoint.operations).length > 0
          ? loadConfiguredOperations(endpoint, schema)
          : autoGeneratedOperations(endpoint, schema);
      this.cache.set(endpoint.server, { operations, fetchedAt: Date.now(), cacheKey });
      this.registry.setStatus(endpoint.server, "available");
      return operations;
    } catch (error) {
      const safe = toSafeError(error, "DOWNSTREAM_PROTOCOL_ERROR");
      this.registry.setStatus(endpoint.server, "unavailable", safe);
      throw new CapletsError(
        safe.code,
        `Could not load GraphQL operations for ${endpoint.server}`,
        safe,
      );
    }
  }

  private toTool(operation: GraphQlOperation): Tool {
    return {
      name: operation.name,
      ...(operation.description ? { description: operation.description } : {}),
      ...(operation.useWhen ? { useWhen: operation.useWhen } : {}),
      ...(operation.avoidWhen ? { avoidWhen: operation.avoidWhen } : {}),
      inputSchema: operation.inputSchema as Tool["inputSchema"],
      annotations:
        operation.kind === "query"
          ? { readOnlyHint: true, destructiveHint: false }
          : { readOnlyHint: false, destructiveHint: true },
    };
  }
}

async function loadSchema(
  endpoint: GraphQlEndpointConfig,
  authDir?: string,
): Promise<GraphQLSchema> {
  if (endpoint.schemaPath) {
    return parseSchemaSource(readFileSync(endpoint.schemaPath, "utf8"));
  }
  if (endpoint.schemaUrl) {
    validateEndpointUrl(endpoint.schemaUrl);
    const source = await fetchGraphQlText(
      endpoint,
      endpoint.schemaUrl,
      authDir,
      shouldSendSchemaAuth(endpoint),
    );
    return parseSchemaSource(source);
  }
  const response = await postGraphQl(
    endpoint,
    endpoint.endpointUrl,
    { query: getIntrospectionQuery() },
    authDir,
  );
  if (!response.ok) {
    throw new CapletsError("DOWNSTREAM_PROTOCOL_ERROR", "GraphQL introspection request failed", {
      status: response.status,
    });
  }
  const parsed = JSON.parse(await readGraphQlText(response)) as {
    data?: unknown;
    errors?: unknown;
  };
  if (parsed.errors || !parsed.data) {
    throw new CapletsError("DOWNSTREAM_PROTOCOL_ERROR", "GraphQL introspection returned errors");
  }
  return buildClientSchema(parsed.data as any);
}

function parseSchemaSource(source: string): GraphQLSchema {
  const trimmed = source.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed);
    return buildClientSchema((parsed.data ?? parsed) as any);
  }
  return buildSchema(source);
}

function loadConfiguredOperations(
  endpoint: GraphQlEndpointConfig,
  schema: GraphQLSchema,
): GraphQlOperation[] {
  return Object.entries(endpoint.operations ?? {})
    .map(([name, config]) => {
      const document = config.document ?? readFileSync(config.documentPath!, "utf8");
      const parsed = parse(document);
      const errors = validate(schema, parsed);
      if (errors.length > 0) {
        throw new CapletsError("CONFIG_INVALID", `GraphQL operation ${name} is invalid`, {
          server: endpoint.server,
          errors: errors.map((error) => error.message),
        });
      }
      const operation = selectOperation(
        parsed.definitions.filter(isOperationDefinition),
        config.operationName,
      );
      return {
        name,
        ...(config.description ? { description: config.description } : {}),
        ...(config.useWhen ? { useWhen: config.useWhen } : {}),
        ...(config.avoidWhen ? { avoidWhen: config.avoidWhen } : {}),
        document,
        ...(config.operationName ? { operationName: config.operationName } : {}),
        inputSchema: variablesSchema(schema, operation),
        kind: operation.operation === "mutation" ? ("mutation" as const) : ("query" as const),
        generated: false,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function autoGeneratedOperations(
  endpoint: GraphQlEndpointConfig,
  schema: GraphQLSchema,
): GraphQlOperation[] {
  const operations: GraphQlOperation[] = [];
  for (const [kind, root] of [
    ["query", schema.getQueryType()],
    ["mutation", schema.getMutationType()],
  ] as const) {
    if (!root) {
      continue;
    }
    for (const [fieldName, field] of Object.entries(root.getFields())) {
      const name = `${kind}_${fieldName}`;
      const document = autoDocument(kind, fieldName, field, endpoint.selectionDepth, schema);
      operations.push({
        name,
        ...(field.description ? { description: field.description } : {}),
        document,
        operationName: name,
        inputSchema: argsSchema(field.args),
        kind,
        generated: true,
      });
    }
  }
  return operations.sort((left, right) => left.name.localeCompare(right.name));
}

function autoDocument(
  kind: "query" | "mutation",
  fieldName: string,
  field: GraphQLField<unknown, unknown>,
  depth: number,
  schema: GraphQLSchema,
): string {
  const operationName = `${kind}_${fieldName}`;
  const variables = field.args.map((arg) => `$${arg.name}: ${String(arg.type)}`).join(", ");
  const callArgs = field.args.map((arg) => `${arg.name}: $${arg.name}`).join(", ");
  const selection = selectionSet(field.type, schema, depth);
  return [
    `${kind} ${operationName}${variables ? `(${variables})` : ""} {`,
    `  ${fieldName}${callArgs ? `(${callArgs})` : ""}${selection ? ` ${selection}` : ""}`,
    "}",
  ].join("\n");
}

function selectionSet(type: GraphQLOutputType, schema: GraphQLSchema, depth: number): string {
  const named = getNamedType(type);
  if (isScalarType(named) || named instanceof GraphQLEnumType || depth <= 0) {
    return "";
  }
  if (isAbstractType(named)) {
    const possible = schema.getPossibleTypes(named);
    const fragments = possible
      .map((object) => `... on ${object.name} ${objectSelection(object, schema, depth)}`)
      .filter((fragment) => !fragment.endsWith("{\n  __typename\n}"));
    return ["{", "  __typename", ...fragments.map((fragment) => `  ${fragment}`), "}"].join("\n");
  }
  if (isObjectType(named)) {
    return objectSelection(named, schema, depth);
  }
  return "";
}

function objectSelection(
  type: GraphQLObjectType | GraphQLInterfaceType,
  schema: GraphQLSchema,
  depth: number,
): string {
  const fields = Object.values(type.getFields())
    .filter(
      (field) =>
        !field.args.some((arg) => arg.defaultValue === undefined && isNonNullType(arg.type)),
    )
    .map((field) => {
      const nested = selectionSet(field.type, schema, depth - 1);
      return nested ? `${field.name} ${nested}` : field.name;
    })
    .filter(Boolean);
  return ["{", "  __typename", ...fields.map((field) => `  ${field}`), "}"].join("\n");
}

function variablesSchema(
  schema: GraphQLSchema,
  operation: OperationDefinitionNode,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const variable of operation.variableDefinitions ?? []) {
    const name = variable.variable.name.value;
    properties[name] = inputSchemaForTypeNode(schema, variable.type);
    if (variable.type.kind === "NonNullType" && !variable.defaultValue) {
      required.push(name);
    }
  }
  return objectSchema(properties, required);
}

function argsSchema(args: readonly GraphQLArgument[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const arg of args) {
    properties[arg.name] = inputSchemaForInputType(arg.type);
    if (isNonNullType(arg.type) && arg.defaultValue === undefined) {
      required.push(arg.name);
    }
  }
  return objectSchema(properties, required);
}

function inputSchemaForTypeNode(schema: GraphQLSchema, type: TypeNode): Record<string, unknown> {
  if (type.kind === "NonNullType") {
    return inputSchemaForTypeNode(schema, type.type);
  }
  if (type.kind === "ListType") {
    return { type: "array", items: inputSchemaForTypeNode(schema, type.type) };
  }
  const graphQlType = schema.getType(type.name.value);
  return graphQlType && isInputTypeLike(graphQlType) ? inputSchemaForInputType(graphQlType) : {};
}

function inputSchemaForInputType(type: GraphQLInputType): Record<string, unknown> {
  if (type instanceof GraphQLNonNull) {
    return inputSchemaForInputType(type.ofType);
  }
  if (type instanceof GraphQLList) {
    return { type: "array", items: inputSchemaForInputType(type.ofType) };
  }
  if (type instanceof GraphQLScalarType) {
    return SCALAR_JSON_SCHEMA[type.name] ?? {};
  }
  if (type instanceof GraphQLEnumType) {
    return { type: "string", enum: type.getValues().map((value) => value.name) };
  }
  if (isInputObjectType(type)) {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [name, field] of Object.entries((type as GraphQLInputObjectType).getFields())) {
      properties[name] = inputSchemaForInputType(field.type);
      if (field.type instanceof GraphQLNonNull && field.defaultValue === undefined) {
        required.push(name);
      }
    }
    return objectSchema(properties, required);
  }
  return {};
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
  };
}

function selectOperation(
  operations: OperationDefinitionNode[],
  operationName: string | undefined,
): OperationDefinitionNode {
  if (operationName) {
    const operation = operations.find((candidate) => candidate.name?.value === operationName);
    if (!operation) {
      throw new CapletsError("CONFIG_INVALID", `GraphQL operation ${operationName} was not found`);
    }
    return operation;
  }
  if (operations.length !== 1) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "GraphQL document must have operationName when it contains multiple operations",
    );
  }
  return operations[0]!;
}

function isOperationDefinition(value: unknown): value is OperationDefinitionNode {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "OperationDefinition",
  );
}

function isInputTypeLike(value: unknown): value is GraphQLInputType {
  return (
    value instanceof GraphQLScalarType ||
    value instanceof GraphQLEnumType ||
    value instanceof GraphQLInputObjectType ||
    value instanceof GraphQLList ||
    value instanceof GraphQLNonNull
  );
}

async function postGraphQl(
  endpoint: GraphQlEndpointConfig,
  url: string,
  payload: Record<string, unknown>,
  authDir?: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), endpoint.requestTimeoutMs);
  try {
    return await fetch(url, {
      method: GRAPHQL_METHOD,
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...staticHeaders(endpoint),
        ...(await genericOAuthHeaders(
          {
            server: endpoint.server,
            backend: "graphql",
            url: endpoint.endpointUrl,
            auth: endpoint.auth,
            requestTimeoutMs: endpoint.requestTimeoutMs,
          },
          authDir,
        )),
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new CapletsError("TOOL_CALL_TIMEOUT", "GraphQL request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGraphQlText(
  endpoint: GraphQlEndpointConfig,
  url: string,
  authDir?: string,
  sendAuth = true,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), endpoint.requestTimeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "manual",
      signal: controller.signal,
      headers: {
        ...(sendAuth ? await schemaAuthHeaders(endpoint, authDir) : {}),
      },
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new CapletsError("TOOL_CALL_TIMEOUT", "GraphQL schema request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new CapletsError(
      "DOWNSTREAM_PROTOCOL_ERROR",
      "GraphQL schema request returned a redirect",
    );
  }
  if (!response.ok) {
    throw new CapletsError("DOWNSTREAM_PROTOCOL_ERROR", "GraphQL schema request failed", {
      status: response.status,
    });
  }
  return readGraphQlText(response);
}

async function schemaAuthHeaders(
  endpoint: GraphQlEndpointConfig,
  authDir?: string,
): Promise<Record<string, string>> {
  return {
    ...staticHeaders(endpoint),
    ...(await genericOAuthHeaders(
      {
        server: endpoint.server,
        backend: "graphql",
        url: endpoint.endpointUrl,
        auth: endpoint.auth,
        requestTimeoutMs: endpoint.requestTimeoutMs,
      },
      authDir,
    )),
  };
}

function staticHeaders(endpoint: GraphQlEndpointConfig): Record<string, string> {
  if (endpoint.auth.type === "bearer") {
    return { authorization: `Bearer ${endpoint.auth.token}` };
  }
  if (endpoint.auth.type === "headers") {
    return endpoint.auth.headers;
  }
  return {};
}

function shouldSendSchemaAuth(endpoint: GraphQlEndpointConfig): boolean {
  return Boolean(
    endpoint.schemaUrl &&
    new URL(endpoint.schemaUrl).origin === new URL(endpoint.endpointUrl).origin,
  );
}

async function readGraphQlText(response: Response): Promise<string> {
  return readLimitedText(response, { errorMessage: "GraphQL response exceeded byte limit" });
}

function validateEndpointUrl(value: string): void {
  if (isAllowedRemoteUrl(value)) {
    return;
  }
  throw new CapletsError(
    "CONFIG_INVALID",
    "GraphQL URLs must use https except loopback development urls",
  );
}

function graphQlCacheKey(endpoint: GraphQlEndpointConfig): string {
  return JSON.stringify({
    endpointUrl: endpoint.endpointUrl,
    schemaPath: endpoint.schemaPath,
    schemaUrl: endpoint.schemaUrl,
    introspection: endpoint.introspection,
    operations: endpoint.operations,
    selectionDepth: endpoint.selectionDepth,
  });
}
