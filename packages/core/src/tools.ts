import type { CallToolResult } from "@modelcontextprotocol/sdk/types";
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import type { CapletSetManager } from "./caplet-sets";
import type { CapletConfig } from "./config";
import type { CliToolsManager } from "./cli-tools";
import type { DownstreamManager } from "./downstream";
import { CapletsError } from "./errors";
import type { GoogleDiscoveryManager } from "./google-discovery";
import type { GraphQLManager } from "./graphql";
import type { HttpActionManager } from "./http-actions";
import type { OpenApiManager } from "./openapi";
import {
  normalizedObservableValue,
  observeOutputShape,
  observedOutputShapeKey,
  usefulOutputSchema,
  type ObservedOutputShapeStore,
} from "./observed-output-shapes";
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

const ajv = new Ajv({
  allErrors: true,
  allowUnionTypes: true,
  strict: false,
  validateSchema: false,
});
const compiledValidators = new WeakMap<object, ValidateFunction>();
const MAX_SCHEMA_ERRORS = 8;

export type GeneratedServerToolRequest = RequiredOperationRequest;

type ParsedOperationRequest = RequiredOperationRequest & Record<string, unknown>;

export type HandleServerToolOptions = {
  observedOutputShapeStore?: ObservedOutputShapeStore | undefined;
  observedOutputShapeScope?: "local" | "self_hosted" | "cloud" | undefined;
  workspaceId?: string | undefined;
  projectFingerprint?: string | undefined;
};

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
  options: HandleServerToolOptions = {},
  googleDiscovery?: GoogleDiscoveryManager,
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
    case "check": {
      const result = await backendFor(
        server,
        downstream,
        openapi,
        graphql,
        http,
        cli,
        caplets,
        googleDiscovery,
      ).check(server as never);
      return jsonResult(result, metadataFor(server, "check", undefined, startedAt));
    }
    case "tools": {
      const backend = backendFor(
        server,
        downstream,
        openapi,
        graphql,
        http,
        cli,
        caplets,
        googleDiscovery,
      );
      const tools = await backend.listTools(server as never);
      const page = pageItems(
        tools.map((tool) => backend.compact(server as never, tool)),
        parsed,
        registry.config.options.maxSearchLimit,
      );
      return jsonResult(
        {
          id: server.server,
          name: server.name,
          ...page,
        },
        metadataFor(server, "tools", undefined, startedAt),
      );
    }
    case "search_tools": {
      const backend = backendFor(
        server,
        downstream,
        openapi,
        graphql,
        http,
        cli,
        caplets,
        googleDiscovery,
      );
      const tools = await backend.listTools(server as never);
      const limit = parsed.limit ?? registry.config.options.defaultSearchLimit;
      const matches = backend.search(server as never, tools, parsed.query, limit);
      const page = pageItems(matches, parsed, registry.config.options.maxSearchLimit);
      return jsonResult(
        {
          id: server.server,
          name: server.name,
          query: parsed.query,
          ...page,
        },
        metadataFor(server, "search_tools", undefined, startedAt),
      );
    }
    case "describe_tool": {
      const backend = backendFor(
        server,
        downstream,
        openapi,
        graphql,
        http,
        cli,
        caplets,
        googleDiscovery,
      );
      const tool = await backend.getTool(server as never, parsed.name);
      const observedOutputShape = await readObservedOutputShape(
        options,
        server,
        parsed.name,
        tool.outputSchema,
      );
      return jsonResult(
        {
          id: server.server,
          tool,
          ...(observedOutputShape ? { observedOutputShape } : {}),
          fieldSelection: fieldSelectionFor(server, tool),
        },
        metadataFor(server, "describe_tool", parsed.name, startedAt),
      );
    }
    case "call_tool": {
      const backend = backendFor(
        server,
        downstream,
        openapi,
        graphql,
        http,
        cli,
        caplets,
        googleDiscovery,
      );
      const tool = await maybeGetToolForValidation(backend, server, parsed.name);
      validateToolArgsForAgent(tool, parsed.name, parsed.args);
      if (parsed.fields === undefined) {
        const result = await backend.callTool(server as never, parsed.name, parsed.args);
        await writeObservedOutputShape(options, server, parsed.name, result);
        return annotateCallToolResult(
          result,
          metadataFor(server, "call_tool", parsed.name, startedAt),
        );
      }
      if (server.backend === "graphql") {
        throw new CapletsError(
          "REQUEST_INVALID",
          "call_tool.fields is not supported for GraphQL-backed Caplets; select fields in the GraphQL operation document instead",
        );
      }

      const fieldSelectionTool = tool ?? (await backend.getTool(server as never, parsed.name));
      if (!fieldSelectionTool.outputSchema) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Field selection requires an output schema. Retry without fields, or call describe_tool first and only use fields when fieldSelection.supported is true.",
        );
      }
      validateFieldSelection(fieldSelectionTool.outputSchema, parsed.fields);

      const metadata = metadataFor(server, "call_tool", parsed.name, startedAt);
      const rawResult = await backend.callTool(server as never, parsed.name, parsed.args);
      await writeObservedOutputShape(options, server, parsed.name, rawResult);
      const result = projectCallToolResult(
        rawResult,
        fieldSelectionTool.outputSchema,
        parsed.fields,
        markdownContextFor(metadata),
      );
      return annotateCallToolResult(result, metadata);
    }
    case "resources": {
      const backend = mcpBackendFor(server, downstream, "page");
      if (!backend) {
        return jsonResult(
          { id: server.server, name: server.name, items: [] },
          metadataFor(server, "resources", undefined, startedAt),
        );
      }
      const resources = await backend.listResources(server as never);
      const page = pageItems(
        resources.map((resource) => backend.compactResource(server as never, resource)),
        parsed,
        registry.config.options.maxSearchLimit,
      );
      return jsonResult(
        {
          id: server.server,
          name: server.name,
          ...page,
        },
        metadataFor(server, "resources", undefined, startedAt),
      );
    }
    case "search_resources": {
      const backend = mcpBackendFor(server, downstream, "page");
      if (!backend) {
        return jsonResult(
          { id: server.server, name: server.name, query: parsed.query, items: [] },
          metadataFor(server, "search_resources", undefined, startedAt),
        );
      }
      const resources = await backend.listResources(server as never);
      const limit = parsed.limit ?? registry.config.options.defaultSearchLimit;
      const resourceMatches = backend.searchResources(
        server as never,
        resources,
        parsed.query,
        limit,
      );
      const page = pageItems(resourceMatches, parsed, registry.config.options.maxSearchLimit);
      return jsonResult(
        {
          id: server.server,
          name: server.name,
          query: parsed.query,
          ...page,
        },
        metadataFor(server, "search_resources", undefined, startedAt),
      );
    }
    case "resource_templates": {
      const backend = mcpBackendFor(server, downstream, "page");
      if (!backend) {
        return jsonResult(
          { id: server.server, name: server.name, items: [] },
          metadataFor(server, "resource_templates", undefined, startedAt),
        );
      }
      const templates = await backend.listResourceTemplates(server as never);
      const page = pageItems(
        templates.map((template) => backend.compactResourceTemplate(server as never, template)),
        parsed,
        registry.config.options.maxSearchLimit,
      );
      return jsonResult(
        {
          id: server.server,
          name: server.name,
          ...page,
        },
        metadataFor(server, "resource_templates", undefined, startedAt),
      );
    }
    case "read_resource": {
      const result = await mcpBackendFor(server, downstream, "direct")!.readResource(
        server as never,
        parsed.uri,
      );
      return annotateMcpResult(
        result,
        metadataFor(server, "read_resource", { uri: parsed.uri }, startedAt),
      );
    }
    case "prompts": {
      const backend = mcpBackendFor(server, downstream, "page");
      if (!backend) {
        return jsonResult(
          { id: server.server, name: server.name, items: [] },
          metadataFor(server, "prompts", undefined, startedAt),
        );
      }
      const prompts = await backend.listPrompts(server as never);
      const page = pageItems(
        prompts.map((prompt) => backend.compactPrompt(server as never, prompt)),
        parsed,
        registry.config.options.maxSearchLimit,
      );
      return jsonResult(
        {
          id: server.server,
          name: server.name,
          ...page,
        },
        metadataFor(server, "prompts", undefined, startedAt),
      );
    }
    case "search_prompts": {
      const backend = mcpBackendFor(server, downstream, "page");
      if (!backend) {
        return jsonResult(
          { id: server.server, name: server.name, query: parsed.query, items: [] },
          metadataFor(server, "search_prompts", undefined, startedAt),
        );
      }
      const prompts = await backend.listPrompts(server as never);
      const limit = parsed.limit ?? registry.config.options.defaultSearchLimit;
      const matches = backend.searchPrompts(server as never, prompts, parsed.query, limit);
      const page = pageItems(matches, parsed, registry.config.options.maxSearchLimit);
      return jsonResult(
        {
          id: server.server,
          name: server.name,
          query: parsed.query,
          ...page,
        },
        metadataFor(server, "search_prompts", undefined, startedAt),
      );
    }
    case "get_prompt": {
      const result = await mcpBackendFor(server, downstream, "direct")!.getPrompt(
        server as never,
        parsed.name,
        parsed.args,
      );
      return annotateMcpResult(
        result,
        metadataFor(server, "get_prompt", { prompt: parsed.name }, startedAt),
      );
    }
    case "complete": {
      const result = await mcpBackendFor(server, downstream, "direct")!.complete(server as never, {
        ref: parsed.ref,
        argument: parsed.argument,
      });
      return annotateMcpResult(result, metadataFor(server, "complete", undefined, startedAt));
    }
  }
}

function fieldSelectionFor(
  server: CapletConfig,
  tool: { outputSchema?: unknown },
): { supported: boolean; reason?: string } {
  if (server.backend === "graphql") {
    return { supported: false, reason: "graphql_document_selection" };
  }
  if (!tool.outputSchema) {
    return { supported: false, reason: "output_schema_unavailable" };
  }
  return { supported: true };
}

async function maybeGetToolForValidation(
  backend: unknown,
  server: CapletConfig,
  toolName: string,
): Promise<{ inputSchema?: unknown; outputSchema?: unknown } | undefined> {
  if (!hasGetTool(backend)) return undefined;
  try {
    return await backend.getTool(server as never, toolName);
  } catch {
    return undefined;
  }
}

function validateToolArgsForAgent(
  tool: { inputSchema?: unknown; outputSchema?: unknown } | undefined,
  toolName: string,
  args: Record<string, unknown>,
): void {
  const schema = isPlainObject(tool?.inputSchema) ? tool.inputSchema : undefined;
  if (!schema) return;
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const acceptedArgs = Object.keys(properties).sort();
  const requiredArgs = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string").sort()
    : [];
  const validator = validatorFor(schema);
  const valid = validator ? validator(args) : manualValidateObjectArgs(schema, args);
  if (valid) return;

  const errors = validator?.errors ?? manualValidationErrors(schema, args);
  const schemaErrors = compactSchemaErrors(errors);
  const missing = missingArgsFromErrors(schemaErrors, requiredArgs, args);
  const unexpectedArgs = Object.keys(args)
    .filter((key) => acceptedArgs.length > 0 && !acceptedArgs.includes(key))
    .sort();
  const unexpected = unexpectedArgsFromErrors(schemaErrors);

  const inputTypeName = `${toolTypeBaseName(toolName)}Input`;
  const outputTypeName = `${toolTypeBaseName(toolName)}Output`;
  const requiredTemplate = minimalArgsTemplate(schema, requiredArgs);
  const parts = [
    missing.length > 0 ? `missing required argument(s): ${missing.join(", ")}` : undefined,
    unexpected.length > 0 ? `unexpected argument(s): ${unexpected.join(", ")}` : undefined,
    ...schemaErrors
      .filter((error) => error.rule !== "required" && error.rule !== "additionalProperties")
      .slice(0, 3)
      .map(formatSchemaError),
  ].filter((value): value is string => value !== undefined);
  const reason = parts.length > 0 ? parts.join("; ") : "schema validation failed";
  throw new CapletsError(
    "REQUEST_INVALID",
    `call_tool args for ${toolName} are invalid: ${reason}. Use describe_tool for the schema and retry with exact argument names.`,
    {
      tool: toolName,
      requiredArgs,
      acceptedArgs,
      ...(unexpectedArgs.length > 0 ? { unexpectedArgs } : {}),
      ...(Object.keys(requiredTemplate).length > 0
        ? { minimalArgsTemplate: requiredTemplate }
        : {}),
      ...(schemaErrors.length > 0 ? { schemaErrors } : {}),
      callSignature: `callTool(name: ${JSON.stringify(toolName)}, args: ${inputTypeName}): Promise<CapletsResult<${outputTypeName}>>`,
      inputTypeScript: schemaToTypeScript(schema, inputTypeName),
      retry:
        "Call describe_tool for this tool, then call_tool with args matching inputSchema/inputTypeScript exactly.",
    },
  );
}

function validatorFor(schema: Record<string, unknown>): ValidateFunction | undefined {
  const existing = compiledValidators.get(schema);
  if (existing) return existing;
  try {
    const validator = ajv.compile(schema);
    compiledValidators.set(schema, validator);
    return validator;
  } catch {
    return undefined;
  }
}

function manualValidateObjectArgs(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): boolean {
  return manualValidationErrors(schema, args).length === 0;
}

function manualValidationErrors(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): ErrorObject[] {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const acceptedArgs = Object.keys(properties).sort();
  const requiredArgs = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string").sort()
    : [];
  const errors: ErrorObject[] = [];
  for (const key of requiredArgs) {
    if (args[key] === undefined) {
      errors.push({
        instancePath: "",
        schemaPath: "#/required",
        keyword: "required",
        params: { missingProperty: key },
      });
    }
  }
  if (schema.additionalProperties === false && acceptedArgs.length > 0) {
    for (const key of Object.keys(args).sort()) {
      if (!acceptedArgs.includes(key)) {
        errors.push({
          instancePath: "",
          schemaPath: "#/additionalProperties",
          keyword: "additionalProperties",
          params: { additionalProperty: key },
        });
      }
    }
  }
  return errors;
}

type CompactSchemaError = {
  path: string;
  rule: string;
  expected?: string;
  allowed?: unknown[];
  missing?: string;
  unexpected?: string;
  message?: string;
};

function compactSchemaErrors(errors: ErrorObject[] | null | undefined): CompactSchemaError[] {
  if (!errors) return [];
  return errors.slice(0, MAX_SCHEMA_ERRORS).map((error) => {
    const path = error.instancePath || "/";
    if (error.keyword === "required") {
      const missing = stringParam(error, "missingProperty");
      return {
        path: appendJsonPointer(path, missing),
        rule: "required",
        ...(missing === undefined ? {} : { missing }),
      };
    }
    if (error.keyword === "additionalProperties") {
      const unexpected = stringParam(error, "additionalProperty");
      return {
        path: appendJsonPointer(path, unexpected),
        rule: "additionalProperties",
        ...(unexpected === undefined ? {} : { unexpected }),
      };
    }
    if (error.keyword === "type") {
      const expected = stringParam(error, "type");
      return {
        path,
        rule: "type",
        ...(expected === undefined ? {} : { expected }),
      };
    }
    if (error.keyword === "enum") {
      return {
        path,
        rule: "enum",
        ...(Array.isArray(error.params.allowedValues)
          ? { allowed: error.params.allowedValues as unknown[] }
          : {}),
      };
    }
    if (error.keyword === "const") {
      return {
        path,
        rule: "const",
        allowed: [error.params.allowedValue],
      };
    }
    return {
      path,
      rule: error.keyword,
      ...(error.message ? { message: error.message } : {}),
    };
  });
}

function stringParam(error: ErrorObject, key: string): string | undefined {
  const value = (error.params as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function appendJsonPointer(path: string, key: string | undefined): string {
  if (!key) return path;
  const escaped = key.replace(/~/gu, "~0").replace(/\//gu, "~1");
  return path === "/" ? `/${escaped}` : `${path}/${escaped}`;
}

function missingArgsFromErrors(
  errors: CompactSchemaError[],
  requiredArgs: string[],
  args: Record<string, unknown>,
): string[] {
  const missing = errors
    .filter((error) => error.rule === "required" && error.path.split("/").length === 2)
    .map((error) => error.missing)
    .filter((value): value is string => typeof value === "string");
  if (missing.length > 0) return [...new Set(missing)].sort();
  return requiredArgs.filter((key) => args[key] === undefined);
}

function unexpectedArgsFromErrors(errors: CompactSchemaError[]): string[] {
  return errors
    .filter((error) => error.rule === "additionalProperties" && error.unexpected)
    .map((error) => error.unexpected!)
    .sort();
}

function formatSchemaError(error: CompactSchemaError): string {
  if (error.rule === "type" && error.expected) {
    return `${error.path} must be ${error.expected}`;
  }
  if (error.rule === "enum" && error.allowed) {
    return `${error.path} must be one of ${error.allowed.map((value) => JSON.stringify(value)).join(", ")}`;
  }
  if (error.rule === "const" && error.allowed) {
    return `${error.path} must be ${JSON.stringify(error.allowed[0])}`;
  }
  return error.message ? `${error.path} ${error.message}` : `${error.path} failed ${error.rule}`;
}

function minimalArgsTemplate(
  schema: Record<string, unknown>,
  requiredArgs: string[],
): Record<string, unknown> {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const template: Record<string, unknown> = {};
  for (const key of requiredArgs) {
    template[key] = placeholderValueForSchema(properties[key], 0);
  }
  return template;
}

function placeholderValueForSchema(schema: unknown, depth: number): unknown {
  if (depth > 2 || !isPlainObject(schema)) return null;
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const type = Array.isArray(schema.type)
    ? (schema.type.find((value) => value !== "null") ?? schema.type[0])
    : schema.type;
  if (type === "string") return "";
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  if (type === "array") return [];
  if (type === "object" || isPlainObject(schema.properties)) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string").sort()
      : [];
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const value: Record<string, unknown> = {};
    for (const key of required) {
      value[key] = placeholderValueForSchema(properties[key], depth + 1);
    }
    return value;
  }
  return null;
}

function hasGetTool(backend: unknown): backend is {
  getTool(server: never, name: string): Promise<{ inputSchema?: unknown; outputSchema?: unknown }>;
} {
  return Boolean(
    backend &&
    typeof backend === "object" &&
    "getTool" in backend &&
    typeof (backend as { getTool?: unknown }).getTool === "function",
  );
}

function schemaToTypeScript(schema: unknown, fallbackName: string): string {
  return `type ${fallbackName} = ${schemaType(schema)};`;
}

function schemaType(schema: unknown): string {
  if (!isPlainObject(schema)) return "unknown";
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ") || "unknown";
  }
  const type = schema.type;
  if (Array.isArray(type)) {
    const variants = type.map((item) => schemaType({ ...schema, type: item }));
    return [...new Set(variants)].join(" | ") || "unknown";
  }
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "null") return "null";
  if (type === "array") return `${schemaType(schema.items)}[]`;
  if (type === "object" || isPlainObject(schema.properties)) return objectSchemaType(schema);
  if (Array.isArray(schema.oneOf)) return unionSchemaType(schema.oneOf);
  if (Array.isArray(schema.anyOf)) return unionSchemaType(schema.anyOf);
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.map(schemaType).join(" & ") || "Record<string, unknown>";
  }
  return "unknown";
}

function objectSchemaType(schema: Record<string, unknown>): string {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  const fields = Object.entries(properties)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      const optional = required.has(key) ? "" : "?";
      return `${propertySignature(key)}${optional}: ${schemaType(value)};`;
    });
  if (fields.length === 0) {
    return schema.additionalProperties === false ? "{}" : "Record<string, unknown>";
  }
  if (schema.additionalProperties && isPlainObject(schema.additionalProperties)) {
    fields.push(`[key: string]: ${schemaType(schema.additionalProperties)};`);
  }
  return `{ ${fields.join(" ")} }`;
}

function unionSchemaType(schemas: unknown[]): string {
  return schemas.map(schemaType).join(" | ") || "unknown";
}

function propertySignature(key: string): string {
  return /^[A-Za-z_$][\w$]*$/u.test(key) ? key : JSON.stringify(key);
}

function toolTypeBaseName(toolName: string): string {
  const base = toolName
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
  return base || "Tool";
}

async function readObservedOutputShape(
  options: HandleServerToolOptions,
  server: CapletConfig,
  toolName: string,
  outputSchema: unknown,
) {
  if (!options.observedOutputShapeStore || usefulOutputSchema(outputSchema)) return undefined;
  try {
    return await options.observedOutputShapeStore.read(
      observedOutputShapeKey({
        scope: options.observedOutputShapeScope ?? "local",
        workspaceId: options.workspaceId,
        projectFingerprint: options.projectFingerprint,
        caplet: server,
        toolName,
      }),
    );
  } catch {
    return undefined;
  }
}

async function writeObservedOutputShape(
  options: HandleServerToolOptions,
  server: CapletConfig,
  toolName: string,
  result: unknown,
): Promise<void> {
  if (!options.observedOutputShapeStore || resultIsError(result)) return;
  const value = normalizedObservableValue(result);
  if (value === undefined) return;
  const key = observedOutputShapeKey({
    scope: options.observedOutputShapeScope ?? "local",
    workspaceId: options.workspaceId,
    projectFingerprint: options.projectFingerprint,
    caplet: server,
    toolName,
  });
  try {
    const existing = await options.observedOutputShapeStore.read(key);
    const observed = observeOutputShape({ value, existing });
    if (observed) await options.observedOutputShapeStore.write(key, observed);
  } catch {
    return;
  }
}

function resultIsError(result: unknown): boolean {
  return Boolean(result && typeof result === "object" && (result as { isError?: unknown }).isError);
}

export function validateOperationRequest(
  request: unknown,
  _maxSearchLimit: number,
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
    case "check":
      allowed([]);
      return { operation: value.operation };
    case "tools":
      allowed(["limit", "cursor"]);
      return normalizePageRequest(value);
    case "search_tools":
      allowed(["query", "limit", "cursor"]);
      if (!value.query) {
        throw new CapletsError("REQUEST_INVALID", "search_tools requires query");
      }
      return normalizePageRequest(value) as RequiredOperationRequest;
    case "describe_tool":
      allowed(["name"]);
      if (!value.name) {
        throw new CapletsError("REQUEST_INVALID", "describe_tool requires name");
      }
      return { operation: "describe_tool", name: value.name };
    case "call_tool":
      allowed(["name", "args", "fields"]);
      if (!value.name) {
        throw new CapletsError("REQUEST_INVALID", "call_tool requires name");
      }
      if (!isPlainObject(value.args)) {
        throw new CapletsError("REQUEST_INVALID", "call_tool.args must be a JSON object");
      }
      return value.fields === undefined
        ? { operation: "call_tool", name: value.name, args: value.args }
        : {
            operation: "call_tool",
            name: value.name,
            args: value.args,
            fields: value.fields,
          };
    case "resources":
    case "resource_templates":
    case "prompts":
      allowed(["limit", "cursor"]);
      return normalizePageRequest(value);
    case "search_resources":
    case "search_prompts":
      allowed(["query", "limit", "cursor"]);
      if (!value.query)
        throw new CapletsError("REQUEST_INVALID", `${value.operation} requires query`);
      return normalizePageRequest(value) as RequiredOperationRequest;
    case "read_resource":
      allowed(["uri"]);
      if (!value.uri) throw new CapletsError("REQUEST_INVALID", "read_resource requires uri");
      return { operation: "read_resource", uri: value.uri };
    case "get_prompt":
      allowed(["name", "args"]);
      if (!value.name) throw new CapletsError("REQUEST_INVALID", "get_prompt requires name");
      if (value.args !== undefined && !isPlainObject(value.args)) {
        throw new CapletsError("REQUEST_INVALID", "get_prompt.args must be a JSON object");
      }
      return { operation: "get_prompt", name: value.name, args: value.args ?? {} };
    case "complete":
      allowed(["ref", "argument"]);
      if (!value.ref) throw new CapletsError("REQUEST_INVALID", "complete requires ref");
      if (!value.argument) throw new CapletsError("REQUEST_INVALID", "complete requires argument");
      return { operation: "complete", ref: value.ref, argument: value.argument };
  }
  throw new CapletsError("INTERNAL_ERROR", "Unhandled operation");
}

function normalizePageRequest<T extends ParsedOperationRequest>(value: T): T {
  return {
    ...value,
    ...(value.limit === undefined ? {} : { limit: value.limit }),
    ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
  };
}

function pageItems<T>(
  items: T[],
  input: { limit?: number; cursor?: string },
  maxLimit: number,
): { items: T[]; nextCursor?: string; truncated?: boolean } {
  const cursor = input.cursor === undefined ? 0 : Number.parseInt(input.cursor, 10);
  const start = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
  const requestedLimit = input.limit ?? maxLimit;
  const limit = Math.max(1, Math.min(requestedLimit, maxLimit));
  const page = items.slice(start, start + limit);
  const nextIndex = start + page.length;
  return nextIndex < items.length
    ? { items: page, nextCursor: String(nextIndex), truncated: true }
    : { items: page };
}

function mcpBackendFor(
  server: CapletConfig,
  downstream: DownstreamManager,
  mode: "page" | "direct",
): DownstreamManager | undefined {
  if (server.backend !== "mcp") {
    if (mode === "page") return undefined;
    throw new CapletsError(
      "UNSUPPORTED_OPERATION",
      "MCP resource, prompt, and completion operations require an MCP-backed Caplet",
    );
  }
  return downstream;
}

type RequiredOperationRequest =
  | { operation: "inspect" | "check" }
  | { operation: "tools"; limit?: number; cursor?: string }
  | { operation: "search_tools"; query: string; limit?: number; cursor?: string }
  | { operation: "describe_tool"; name: string }
  | { operation: "call_tool"; name: string; args: Record<string, unknown>; fields?: string[] }
  | { operation: "resources" | "resource_templates" | "prompts"; limit?: number; cursor?: string }
  | {
      operation: "search_resources" | "search_prompts";
      query: string;
      limit?: number;
      cursor?: string;
    }
  | { operation: "read_resource"; uri: string }
  | { operation: "get_prompt"; name: string; args: Record<string, unknown> }
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
  if (hasArtifactPlaceholderForSelectedFields(structuredContent, fields)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Field selection cannot project from an artifact response. Retry without fields and read the returned artifact.",
    );
  }

  const projected = projectStructuredContent(structuredContent, outputSchema, fields);
  return {
    ...result,
    content: markdownStructuredContent(projected, context),
    structuredContent: projected,
  } as T & CallToolResult;
}

function hasArtifactPlaceholderForSelectedFields(
  structuredContent: Record<string, unknown>,
  fields: string[],
): boolean {
  const body = structuredContent.body;
  return (
    isPlainObject(body) &&
    isPlainObject(body.artifact) &&
    fields.some((field) => field === "body" || field.startsWith("body."))
  );
}

export function extractArtifacts(result: unknown): CapletArtifact[] {
  if (!isPlainObject(result)) {
    return [];
  }

  const artifacts: CapletArtifact[] = [];
  const seen = new Set<string>();
  addStructuredArtifact(artifacts, seen, result.structuredContent);
  if (!Array.isArray(result.content)) {
    return artifacts;
  }
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

function addStructuredArtifact(
  artifacts: CapletArtifact[],
  seen: Set<string>,
  structuredContent: unknown,
): void {
  if (!isPlainObject(structuredContent)) return;
  const body = structuredContent.body;
  if (!isPlainObject(body) || !isPlainObject(body.artifact)) return;
  const path = typeof body.artifact.path === "string" ? body.artifact.path : undefined;
  const uri = typeof body.artifact.uri === "string" ? body.artifact.uri : undefined;
  const displayPath = path ?? uri;
  if (!displayPath || seen.has(displayPath)) return;
  seen.add(displayPath);
  artifacts.push({
    kind: "file",
    displayPath,
    pathResolution: path ? "absolute" : "relative-to-mcp-server",
  });
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
  googleDiscovery?: GoogleDiscoveryManager,
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
  if (server.backend === "googleDiscovery") {
    if (!googleDiscovery) {
      throw new CapletsError("INTERNAL_ERROR", "Google Discovery manager is not configured");
    }
    return {
      check: (...args: Parameters<GoogleDiscoveryManager["checkApi"]>) =>
        googleDiscovery.checkApi(...args),
      listTools: (...args: Parameters<GoogleDiscoveryManager["listTools"]>) =>
        googleDiscovery.listTools(...args),
      getTool: (...args: Parameters<GoogleDiscoveryManager["getTool"]>) =>
        googleDiscovery.getTool(...args),
      callTool: (...args: Parameters<GoogleDiscoveryManager["callTool"]>) =>
        googleDiscovery.callTool(...args),
      compact: (...args: Parameters<GoogleDiscoveryManager["compact"]>) =>
        googleDiscovery.compact(...args),
      search: (...args: Parameters<GoogleDiscoveryManager["search"]>) =>
        googleDiscovery.search(...args),
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
