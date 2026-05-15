import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { VFile } from "vfile";
import { matter as parseMatter } from "vfile-matter";
import { z } from "zod";
import {
  FORBIDDEN_HEADERS,
  HEADER_NAME_PATTERN,
  HTTP_BASE_URL_PATTERN,
  SERVER_ID_PATTERN,
  isAllowedHttpBaseUrl,
  isAllowedRemoteUrl,
  isUrl,
  validateHttpActionHeaders,
} from "./config/validation.js";
import { CapletsError, redactSecrets } from "./errors.js";
import { nestedSchema, schemaPath } from "./schema-utils.js";

const MAX_CAPLET_FILE_BYTES = 128 * 1024;
const MAX_CAPLET_BODY_CHARS = 64 * 1024;

const capletRemoteAuthSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("none") }).strict(),
    z.object({ type: z.literal("bearer"), token: z.string().min(1) }).strict(),
    z
      .object({ type: z.literal("headers"), headers: z.record(z.string(), z.string().min(1)) })
      .strict(),
    z
      .object({
        type: z.literal("oauth2"),
        authorizationUrl: z.string().min(1).optional(),
        tokenUrl: z.string().min(1).optional(),
        issuer: z.string().min(1).optional(),
        resourceMetadataUrl: z.string().min(1).optional(),
        authorizationServerMetadataUrl: z.string().min(1).optional(),
        openidConfigurationUrl: z.string().min(1).optional(),
        clientMetadataUrl: z.string().min(1).optional(),
        clientId: z.string().min(1).optional(),
        clientSecret: z.string().min(1).optional(),
        scopes: z.array(z.string().min(1)).optional(),
        redirectUri: z.string().min(1).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("oidc"),
        authorizationUrl: z.string().min(1).optional(),
        tokenUrl: z.string().min(1).optional(),
        issuer: z.string().min(1).optional(),
        resourceMetadataUrl: z.string().min(1).optional(),
        authorizationServerMetadataUrl: z.string().min(1).optional(),
        openidConfigurationUrl: z.string().min(1).optional(),
        clientMetadataUrl: z.string().min(1).optional(),
        clientId: z.string().min(1).optional(),
        clientSecret: z.string().min(1).optional(),
        scopes: z.array(z.string().min(1)).optional(),
        redirectUri: z.string().min(1).optional(),
      })
      .strict(),
  ])
  .describe("Authentication settings for a remote MCP server.");

const capletEndpointAuthSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("none") }).strict(),
    z.object({ type: z.literal("bearer"), token: z.string().min(1) }).strict(),
    z
      .object({ type: z.literal("headers"), headers: z.record(z.string(), z.string().min(1)) })
      .strict(),
    z
      .object({
        type: z.literal("oauth2"),
        authorizationUrl: z.string().min(1).optional(),
        tokenUrl: z.string().min(1).optional(),
        issuer: z.string().min(1).optional(),
        resourceMetadataUrl: z.string().min(1).optional(),
        authorizationServerMetadataUrl: z.string().min(1).optional(),
        openidConfigurationUrl: z.string().min(1).optional(),
        clientMetadataUrl: z.string().min(1).optional(),
        clientId: z.string().min(1).optional(),
        clientSecret: z.string().min(1).optional(),
        scopes: z.array(z.string().min(1)).optional(),
        redirectUri: z.string().min(1).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("oidc"),
        authorizationUrl: z.string().min(1).optional(),
        tokenUrl: z.string().min(1).optional(),
        issuer: z.string().min(1).optional(),
        resourceMetadataUrl: z.string().min(1).optional(),
        authorizationServerMetadataUrl: z.string().min(1).optional(),
        openidConfigurationUrl: z.string().min(1).optional(),
        clientMetadataUrl: z.string().min(1).optional(),
        clientId: z.string().min(1).optional(),
        clientSecret: z.string().min(1).optional(),
        scopes: z.array(z.string().min(1)).optional(),
        redirectUri: z.string().min(1).optional(),
      })
      .strict(),
  ])
  .describe("Authentication settings for an OpenAPI or GraphQL endpoint.");

const capletMcpServerSchema = z
  .object({
    transport: z
      .enum(["stdio", "http", "sse"])
      .optional()
      .describe("Downstream MCP transport. Defaults to stdio when command is present."),
    command: z.string().min(1).optional().describe("Executable command for stdio servers."),
    args: z.array(z.string()).optional().describe("Arguments passed to the stdio command."),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("Environment variables for stdio servers. Supports ${VAR} and $env:VAR."),
    cwd: z.string().min(1).optional().describe("Working directory for stdio servers."),
    url: z.string().min(1).optional().describe("Remote MCP server URL for http or sse transport."),
    auth: capletRemoteAuthSchema.optional(),
    startupTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Timeout in milliseconds for starting or checking a downstream server."),
    callTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Timeout in milliseconds for downstream tool calls."),
    toolCacheTtlMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Milliseconds downstream tool metadata stays fresh. Set 0 to refresh every time."),
    disabled: z
      .boolean()
      .optional()
      .describe("When true, omit this Caplet from discovery and do not start its MCP server."),
  })
  .strict()
  .superRefine((server, ctx) => {
    const effectiveTransport = server.transport ?? (server.command ? "stdio" : undefined);
    const hasStdio = Boolean(server.command);
    const hasRemote = Boolean(server.url);
    if (hasStdio === hasRemote) {
      ctx.addIssue({
        code: "custom",
        message: "mcpServer must define exactly one connection shape: command or url",
      });
    }

    if (effectiveTransport === "stdio" && !server.command) {
      ctx.addIssue({
        code: "custom",
        path: ["command"],
        message: "stdio servers require command",
      });
    }

    if ((effectiveTransport === "http" || effectiveTransport === "sse") && !server.url) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "remote servers require url",
      });
    }

    if (server.url && !hasEnvReference(server.url) && !isAllowedRemoteUrl(server.url)) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message: "remote url must use https except loopback development urls",
      });
    }

    if (server.auth?.type === "oauth2" || server.auth?.type === "oidc") {
      for (const field of [
        "authorizationUrl",
        "tokenUrl",
        "issuer",
        "clientMetadataUrl",
        "redirectUri",
      ] as const) {
        const value = server.auth[field];
        if (value && !hasEnvReference(value) && !isUrl(value)) {
          ctx.addIssue({
            code: "custom",
            path: ["auth", field],
            message: `${field} must be a URL or environment reference`,
          });
        }
      }
    }

    if (server.auth?.type === "headers") {
      for (const headerName of Object.keys(server.auth.headers)) {
        const normalized = headerName.toLowerCase();
        if (!HEADER_NAME_PATTERN.test(headerName) || FORBIDDEN_HEADERS.has(normalized)) {
          ctx.addIssue({
            code: "custom",
            path: ["auth", "headers", headerName],
            message: `header ${headerName} is not allowed`,
          });
        }
      }
    }
  });

const capletOpenApiEndpointSchema = z
  .object({
    specPath: z.string().min(1).optional().describe("Local OpenAPI specification path."),
    specUrl: z.string().min(1).optional().describe("Remote OpenAPI specification URL."),
    baseUrl: z.string().min(1).optional().describe("Override base URL for OpenAPI requests."),
    auth: capletEndpointAuthSchema.describe(
      'Explicit OpenAPI request auth config. Use {"type":"none"} for public APIs.',
    ),
    requestTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Timeout in milliseconds for OpenAPI HTTP requests."),
    operationCacheTtlMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Milliseconds OpenAPI operation metadata stays fresh. Set 0 to refresh every time.",
      ),
    disabled: z.boolean().optional().describe("When true, omit this Caplet from discovery."),
  })
  .strict()
  .superRefine((endpoint, ctx) => {
    if (Boolean(endpoint.specPath) === Boolean(endpoint.specUrl)) {
      ctx.addIssue({
        code: "custom",
        message: "openapiEndpoint must define exactly one spec source: specPath or specUrl",
      });
    }
    if (
      endpoint.specUrl &&
      !hasEnvReference(endpoint.specUrl) &&
      !isAllowedRemoteUrl(endpoint.specUrl)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["specUrl"],
        message: "OpenAPI specUrl must use https except loopback development urls",
      });
    }
    if (
      endpoint.baseUrl &&
      !hasEnvReference(endpoint.baseUrl) &&
      !isAllowedRemoteUrl(endpoint.baseUrl)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "OpenAPI baseUrl must use https except loopback development urls",
      });
    }
    validateEndpointAuthHeaders(endpoint.auth, ctx);
  });

const capletGraphQlOperationSchema = z
  .object({
    document: z.string().min(1).optional().describe("Inline GraphQL operation document."),
    documentPath: z.string().min(1).optional().describe("Path to a GraphQL operation document."),
    operationName: z.string().min(1).optional().describe("Operation name to execute."),
    description: z.string().min(1).optional().describe("Operation capability description."),
  })
  .strict()
  .superRefine((operation, ctx) => {
    if (Boolean(operation.document) === Boolean(operation.documentPath)) {
      ctx.addIssue({
        code: "custom",
        message:
          "GraphQL operation must define exactly one document source: document or documentPath",
      });
    }
  });

const capletGraphQlEndpointSchema = z
  .object({
    endpointUrl: z.string().min(1).describe("GraphQL HTTP endpoint URL."),
    schemaPath: z.string().min(1).optional().describe("Local GraphQL SDL or introspection path."),
    schemaUrl: z.string().min(1).optional().describe("Remote GraphQL SDL or introspection URL."),
    introspection: z
      .literal(true)
      .optional()
      .describe("Load schema through endpoint introspection."),
    operations: z
      .record(z.string().regex(SERVER_ID_PATTERN), capletGraphQlOperationSchema)
      .optional()
      .describe("Configured GraphQL operations keyed by stable tool name."),
    auth: capletEndpointAuthSchema.describe(
      'Explicit GraphQL request auth config. Use {"type":"none"} for public APIs.',
    ),
    requestTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Timeout in milliseconds for GraphQL HTTP requests."),
    operationCacheTtlMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Milliseconds GraphQL operation metadata stays fresh. Set 0 to refresh every time.",
      ),
    selectionDepth: z
      .number()
      .int()
      .positive()
      .max(5)
      .optional()
      .describe("Maximum depth for auto-generated GraphQL selection sets."),
    disabled: z.boolean().optional().describe("When true, omit this Caplet from discovery."),
  })
  .strict()
  .superRefine((endpoint, ctx) => {
    const sourceCount =
      Number(Boolean(endpoint.schemaPath)) +
      Number(Boolean(endpoint.schemaUrl)) +
      Number(endpoint.introspection === true);
    if (sourceCount !== 1) {
      ctx.addIssue({
        code: "custom",
        message:
          "graphqlEndpoint must define exactly one schema source: schemaPath, schemaUrl, or introspection",
      });
    }
    if (
      endpoint.endpointUrl &&
      !hasEnvReference(endpoint.endpointUrl) &&
      !isAllowedRemoteUrl(endpoint.endpointUrl)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["endpointUrl"],
        message: "GraphQL endpointUrl must use https except loopback development urls",
      });
    }
    if (
      endpoint.schemaUrl &&
      !hasEnvReference(endpoint.schemaUrl) &&
      !isAllowedRemoteUrl(endpoint.schemaUrl)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["schemaUrl"],
        message: "GraphQL schemaUrl must use https except loopback development urls",
      });
    }
    validateEndpointAuthHeaders(endpoint.auth, ctx);
  });

const httpScalarMappingSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

const capletHttpActionSchema = z
  .object({
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
      .describe("HTTP method used for this action."),
    path: z
      .string()
      .min(1)
      .regex(/^\//, "HTTP action path must start with /")
      .describe("URL path appended to the HTTP API baseUrl.")
      .refine((value) => !value.startsWith("//"), "HTTP action path must not start with //")
      .refine((value) => !isUrl(value), "HTTP action path must be a URL path, not a URL"),
    description: z.string().min(1).optional().describe("Action capability description."),
    inputSchema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("JSON Schema for call_tool arguments."),
    query: httpScalarMappingSchema.optional().describe("Query parameter mapping."),
    headers: httpScalarMappingSchema.optional().describe("Request header mapping."),
    jsonBody: z.unknown().optional().describe("JSON request body mapping."),
  })
  .strict()
  .superRefine((action, ctx) => {
    if (action.method === "GET" && action.jsonBody !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["jsonBody"],
        message: "HTTP GET actions must not define jsonBody",
      });
    }
  });

const capletHttpApiSchema = z
  .object({
    baseUrl: z
      .string()
      .min(1)
      .regex(
        HTTP_BASE_URL_PATTERN,
        "HTTP API baseUrl must not include credentials, query, or fragment",
      )
      .describe("Base URL for HTTP action requests."),
    auth: capletEndpointAuthSchema.describe(
      'Explicit HTTP API request auth config. Use {"type":"none"} for public APIs.',
    ),
    actions: z
      .record(z.string().regex(SERVER_ID_PATTERN), capletHttpActionSchema)
      .refine(
        (actions) => Object.keys(actions).length > 0,
        "HTTP API must define at least one action",
      )
      .describe("Configured HTTP actions keyed by stable tool name."),
    requestTimeoutMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Timeout in milliseconds for HTTP action requests."),
    maxResponseBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum HTTP action response body bytes to read."),
    disabled: z.boolean().optional().describe("When true, omit this Caplet from discovery."),
  })
  .strict()
  .superRefine((api, ctx) => {
    if (api.baseUrl && !hasEnvReference(api.baseUrl) && !isAllowedHttpBaseUrl(api.baseUrl)) {
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message:
          "HTTP API baseUrl must use https except loopback development urls and must not include credentials, query, or fragment",
      });
    }
    validateEndpointAuthHeaders(api.auth, ctx);
    for (const [actionName, action] of Object.entries(api.actions)) {
      if (action.headers) {
        validateHttpActionHeaders(action.headers, ctx, ["actions", actionName, "headers"]);
      }
    }
  });

const capletCliToolOutputSchema = z
  .object({
    type: z.enum(["text", "json"]).optional(),
  })
  .strict();

const capletCliToolAnnotationsSchema = z
  .object({
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .strict();

const capletCliToolActionSchema = z
  .object({
    description: z.string().min(1).optional().describe("Action capability description."),
    inputSchema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("JSON Schema for call_tool arguments."),
    outputSchema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("JSON Schema for structuredContent returned by this action."),
    command: z.string().min(1).describe("Executable command to spawn without a shell."),
    args: z.array(z.string()).optional().describe("Arguments passed to the command."),
    env: z.record(z.string(), z.string()).optional().describe("Additional environment variables."),
    cwd: z.string().min(1).optional().describe("Working directory for this action."),
    timeoutMs: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
    output: capletCliToolOutputSchema.optional(),
    annotations: capletCliToolAnnotationsSchema.optional(),
  })
  .strict();

const capletCliToolsSchema = z
  .object({
    actions: z
      .record(z.string().regex(SERVER_ID_PATTERN), capletCliToolActionSchema)
      .refine(
        (actions) => Object.keys(actions).length > 0,
        "CLI tools backend must define at least one action",
      )
      .describe("Configured CLI actions keyed by stable tool name."),
    cwd: z.string().min(1).optional().describe("Default working directory for CLI actions."),
    env: z.record(z.string(), z.string()).optional().describe("Default environment variables."),
    timeoutMs: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
    disabled: z.boolean().optional().describe("When true, omit this Caplet from discovery."),
  })
  .strict();

export const capletFileSchema = z
  .object({
    $schema: z
      .string()
      .url()
      .optional()
      .describe("Optional JSON Schema URL for editor validation."),
    name: z.string().trim().min(1).max(80).describe("Human-readable Caplet display name."),
    description: z
      .string()
      .describe("Compact capability description shown before the full Caplet card is disclosed.")
      .refine(
        (value) => value.trim().length >= 10,
        "description must contain at least 10 non-whitespace characters",
      )
      .refine((value) => value.length <= 1500, "description must be at most 1500 characters"),
    tags: z
      .array(z.string().trim().min(1).max(80))
      .optional()
      .describe("Optional tags for grouping or searching Caplets."),
    mcpServer: capletMcpServerSchema
      .describe("MCP server backend configuration for this Caplet.")
      .optional(),
    openapiEndpoint: capletOpenApiEndpointSchema
      .describe("OpenAPI endpoint backend configuration for this Caplet.")
      .optional(),
    graphqlEndpoint: capletGraphQlEndpointSchema
      .describe("GraphQL endpoint backend configuration for this Caplet.")
      .optional(),
    httpApi: capletHttpApiSchema
      .describe("HTTP API backend configuration for this Caplet.")
      .optional(),
    cliTools: capletCliToolsSchema
      .describe("CLI tools backend configuration for this Caplet.")
      .optional(),
  })
  .strict()
  .superRefine((frontmatter, ctx) => {
    const backendCount =
      Number(Boolean(frontmatter.mcpServer)) +
      Number(Boolean(frontmatter.openapiEndpoint)) +
      Number(Boolean(frontmatter.graphqlEndpoint)) +
      Number(Boolean(frontmatter.httpApi)) +
      Number(Boolean(frontmatter.cliTools));
    if (backendCount !== 1) {
      ctx.addIssue({
        code: "custom",
        message:
          "Caplet file must define exactly one backend: mcpServer, openapiEndpoint, graphqlEndpoint, httpApi, or cliTools",
      });
    }
  });

type CapletFileFrontmatter = z.infer<typeof capletFileSchema>;

export function capletJsonSchema(): unknown {
  return patchCapletJsonSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplet.schema.json",
    title: "Caplet file frontmatter",
    description: "YAML frontmatter schema for a Markdown Caplet file.",
    ...z.toJSONSchema(capletFileSchema, { io: "input" }),
  });
}

export type CapletFileConfig = {
  mcpServers?: Record<string, unknown>;
  openapiEndpoints?: Record<string, unknown>;
  graphqlEndpoints?: Record<string, unknown>;
  httpApis?: Record<string, unknown>;
  cliTools?: Record<string, unknown>;
};

export function loadCapletFiles(root: string): CapletFileConfig | undefined {
  if (!existsSync(root)) {
    return undefined;
  }

  const servers: Record<string, unknown> = {};
  const openapiEndpoints: Record<string, unknown> = {};
  const graphqlEndpoints: Record<string, unknown> = {};
  const httpApis: Record<string, unknown> = {};
  const cliTools: Record<string, unknown> = {};
  for (const candidate of discoverCapletFiles(root)) {
    if (
      servers[candidate.id] ||
      openapiEndpoints[candidate.id] ||
      graphqlEndpoints[candidate.id] ||
      httpApis[candidate.id] ||
      cliTools[candidate.id]
    ) {
      throw new CapletsError("CONFIG_INVALID", `Duplicate Caplet ID ${candidate.id} under ${root}`);
    }
    const config = readCapletFile(candidate.path);
    if (isPlainObject(config) && config.backend === "openapi") {
      const { backend: _backend, ...endpoint } = config;
      openapiEndpoints[candidate.id] = endpoint;
    } else if (isPlainObject(config) && config.backend === "graphql") {
      const { backend: _backend, ...endpoint } = config;
      graphqlEndpoints[candidate.id] = endpoint;
    } else if (isPlainObject(config) && config.backend === "http") {
      const { backend: _backend, ...endpoint } = config;
      httpApis[candidate.id] = endpoint;
    } else if (isPlainObject(config) && config.backend === "cli") {
      const { backend: _backend, ...endpoint } = config;
      cliTools[candidate.id] = endpoint;
    } else {
      servers[candidate.id] = config;
    }
  }

  const hasServers = Object.keys(servers).length > 0;
  const hasOpenApi = Object.keys(openapiEndpoints).length > 0;
  const hasGraphQl = Object.keys(graphqlEndpoints).length > 0;
  const hasHttpApis = Object.keys(httpApis).length > 0;
  const hasCliTools = Object.keys(cliTools).length > 0;
  return hasServers || hasOpenApi || hasGraphQl || hasHttpApis || hasCliTools
    ? {
        ...(hasServers ? { mcpServers: servers } : {}),
        ...(hasOpenApi ? { openapiEndpoints } : {}),
        ...(hasGraphQl ? { graphqlEndpoints } : {}),
        ...(hasHttpApis ? { httpApis } : {}),
        ...(hasCliTools ? { cliTools } : {}),
      }
    : undefined;
}

export function discoverCapletFiles(root: string): Array<{ id: string; path: string }> {
  const entries = readdirSync(root, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const candidates: Array<{ id: string; path: string }> = [];
  function addCandidate(id: string, path: string): void {
    validateCapletId(id, path);
    candidates.push({ id, path });
  }

  for (const entry of entries) {
    if (entry.name === "auth" || entry.name === "config.json") {
      continue;
    }

    const path = join(root, entry.name);
    if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      addCandidate(basename(entry.name, extname(entry.name)), path);
      continue;
    }

    if (entry.isDirectory()) {
      const capletPath = join(path, "CAPLET.md");
      if (existsSync(capletPath) && statSync(capletPath).isFile()) {
        addCandidate(entry.name, capletPath);
      }
    }
  }

  return candidates;
}

function readCapletFile(path: string): unknown {
  const stat = statSync(path);
  if (stat.size > MAX_CAPLET_FILE_BYTES) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Caplet file at ${path} exceeds the ${MAX_CAPLET_FILE_BYTES} byte limit`,
    );
  }
  const text = readFileSync(path, "utf8");
  const { frontmatter, body } = parseFrontmatter(text, path);
  if (body.length > MAX_CAPLET_BODY_CHARS) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Caplet file at ${path} body exceeds the ${MAX_CAPLET_BODY_CHARS} character limit`,
    );
  }
  const parsed = capletFileSchema.safeParse(frontmatter);
  if (!parsed.success) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Caplet file at ${path} has invalid frontmatter`,
      parsed.error.issues,
    );
  }

  return capletToServerConfig(parsed.data, body, dirname(path));
}

export function validateCapletFile(path: string): void {
  readCapletFile(path);
}

function capletToServerConfig(
  frontmatter: CapletFileFrontmatter,
  body: string,
  baseDir: string,
): unknown {
  if (frontmatter.openapiEndpoint) {
    return {
      ...frontmatter.openapiEndpoint,
      specPath: normalizeLocalPath(frontmatter.openapiEndpoint.specPath, baseDir),
      backend: "openapi",
      name: frontmatter.name,
      description: frontmatter.description,
      ...(frontmatter.tags ? { tags: frontmatter.tags } : {}),
      body,
    };
  }

  if (frontmatter.graphqlEndpoint) {
    return {
      ...frontmatter.graphqlEndpoint,
      schemaPath: normalizeLocalPath(frontmatter.graphqlEndpoint.schemaPath, baseDir),
      operations: normalizeGraphQlOperations(frontmatter.graphqlEndpoint.operations, baseDir),
      backend: "graphql",
      name: frontmatter.name,
      description: frontmatter.description,
      ...(frontmatter.tags ? { tags: frontmatter.tags } : {}),
      body,
    };
  }

  if (frontmatter.httpApi) {
    return {
      ...frontmatter.httpApi,
      backend: "http",
      name: frontmatter.name,
      description: frontmatter.description,
      ...(frontmatter.tags ? { tags: frontmatter.tags } : {}),
      body,
    };
  }

  if (frontmatter.cliTools) {
    return {
      ...frontmatter.cliTools,
      cwd: normalizeLocalPath(frontmatter.cliTools.cwd, baseDir),
      actions: normalizeCliToolActions(frontmatter.cliTools.actions, baseDir),
      backend: "cli",
      name: frontmatter.name,
      description: frontmatter.description,
      ...(frontmatter.tags ? { tags: frontmatter.tags } : {}),
      body,
    };
  }

  return {
    ...frontmatter.mcpServer!,
    name: frontmatter.name,
    description: frontmatter.description,
    ...(frontmatter.tags ? { tags: frontmatter.tags } : {}),
    body,
  };
}

function normalizeCliToolActions(
  actions: z.infer<typeof capletCliToolsSchema>["actions"],
  baseDir: string,
): z.infer<typeof capletCliToolsSchema>["actions"] {
  return Object.fromEntries(
    Object.entries(actions).map(([name, action]) => [
      name,
      {
        ...action,
        cwd: normalizeLocalPath(action.cwd, baseDir) as string | undefined,
      },
    ]),
  );
}

function normalizeGraphQlOperations(
  operations: z.infer<typeof capletGraphQlEndpointSchema>["operations"],
  baseDir: string,
): z.infer<typeof capletGraphQlEndpointSchema>["operations"] {
  if (!operations) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(operations).map(([name, operation]) => [
      name,
      {
        ...operation,
        documentPath: normalizeLocalPath(operation.documentPath, baseDir),
      },
    ]),
  );
}

function normalizeLocalPath(value: string | undefined, baseDir: string): string | undefined {
  if (!value || isAbsolute(value) || hasEnvReference(value)) {
    return value;
  }
  return join(baseDir, value);
}

function validateEndpointAuthHeaders(
  auth: z.infer<typeof capletEndpointAuthSchema> | undefined,
  ctx: z.RefinementCtx,
): void {
  if (auth?.type !== "headers") {
    return;
  }
  for (const headerName of Object.keys(auth.headers)) {
    const normalized = headerName.toLowerCase();
    if (!HEADER_NAME_PATTERN.test(headerName) || FORBIDDEN_HEADERS.has(normalized)) {
      ctx.addIssue({
        code: "custom",
        path: ["auth", "headers", headerName],
        message: `header ${headerName} is not allowed`,
      });
    }
  }
}

function parseFrontmatter(text: string, path: string): { frontmatter: unknown; body: string } {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Caplet file at ${path} must start with fenced YAML frontmatter`,
    );
  }

  try {
    const file = new VFile({ path, value: text });
    parseMatter(file, { strip: true });
    if (!isPlainObject(file.data.matter) || Object.keys(file.data.matter).length === 0) {
      throw new Error("empty frontmatter");
    }
    return {
      frontmatter: file.data.matter,
      body: String(file),
    };
  } catch (error) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Caplet file at ${path} has invalid YAML frontmatter`,
      redactSecrets(error),
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateCapletId(id: string, path: string): void {
  if (!SERVER_ID_PATTERN.test(id)) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Caplet file at ${path} derives invalid ID ${id}; ID must match ^[a-zA-Z0-9_-]{1,64}$`,
    );
  }
}

function hasEnvReference(value: string): boolean {
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$env:[A-Za-z_][A-Za-z0-9_]*/.test(value);
}

function patchCapletJsonSchema<T>(schema: T): T {
  const httpApiProperties = schemaPath<Record<string, unknown>>(schema, [
    "properties",
    "httpApi",
    "properties",
  ]);
  const actions = nestedSchema<Record<string, unknown>>(httpApiProperties, "actions");
  if (actions) {
    actions.minProperties = 1;
  }
  const baseUrl = nestedSchema<Record<string, unknown>>(httpApiProperties, "baseUrl");
  if (baseUrl) {
    baseUrl.format = "uri";
  }
  const cliToolsProperties = schemaPath<Record<string, unknown>>(schema, [
    "properties",
    "cliTools",
    "properties",
  ]);
  const cliActions = nestedSchema<Record<string, unknown>>(cliToolsProperties, "actions");
  if (cliActions) {
    cliActions.minProperties = 1;
  }
  return schema;
}
