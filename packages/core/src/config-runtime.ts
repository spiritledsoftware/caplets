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
} from "./config/validation";
import { CapletsError } from "./errors";

export type RemoteAuthConfig =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "headers"; headers: Record<string, string> }
  | {
      type: "oauth2" | "oidc";
      authorizationUrl?: string | undefined;
      tokenUrl?: string | undefined;
      issuer?: string | undefined;
      resourceMetadataUrl?: string | undefined;
      authorizationServerMetadataUrl?: string | undefined;
      openidConfigurationUrl?: string | undefined;
      clientMetadataUrl?: string | undefined;
      clientId?: string | undefined;
      clientSecret?: string | undefined;
      scopes?: string[] | undefined;
      redirectUri?: string | undefined;
    };

export type CapletSetupCommandConfig = {
  label: string;
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  maxOutputBytes?: number | undefined;
};

export type CapletSetupConfig = {
  commands?: CapletSetupCommandConfig[] | undefined;
  verify?: CapletSetupCommandConfig[] | undefined;
};

export type ProjectBindingConfig = { required: true };
export type RuntimeFeature = "docker" | "browser";
export type RuntimeResourceClass = "standard" | "large" | "heavy";
export type RuntimeRequirementsConfig = {
  features?: RuntimeFeature[] | undefined;
  resources?: { class?: RuntimeResourceClass | undefined } | undefined;
};

export type AgentSelectionHintsConfig = {
  useWhen?: string | undefined;
  avoidWhen?: string | undefined;
};

export type CapletExposure =
  | "direct"
  | "progressive"
  | "code_mode"
  | "direct_and_code_mode"
  | "progressive_and_code_mode";

export type CapletServerConfig = CommonCapletConfig & {
  backend: "mcp";
  transport: "stdio" | "http" | "sse";
  command?: string | undefined;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  url?: string | undefined;
  auth?: RemoteAuthConfig | undefined;
  startupTimeoutMs: number;
  callTimeoutMs: number;
  toolCacheTtlMs: number;
};

export type OpenApiAuthConfig = RemoteAuthConfig;

export type OpenApiEndpointConfig = CommonCapletConfig & {
  backend: "openapi";
  specPath?: string | undefined;
  specUrl?: string | undefined;
  baseUrl?: string | undefined;
  auth: OpenApiAuthConfig;
  requestTimeoutMs: number;
  operationCacheTtlMs: number;
};

export type GraphQlOperationConfig = AgentSelectionHintsConfig & {
  document?: string | undefined;
  documentPath?: string | undefined;
  operationName?: string | undefined;
  description?: string | undefined;
};

export type GraphQlEndpointConfig = CommonCapletConfig & {
  backend: "graphql";
  endpointUrl: string;
  schemaPath?: string | undefined;
  schemaUrl?: string | undefined;
  introspection?: true | undefined;
  operations?: Record<string, GraphQlOperationConfig> | undefined;
  auth: OpenApiAuthConfig;
  requestTimeoutMs: number;
  operationCacheTtlMs: number;
  selectionDepth: number;
};

export type HttpActionConfig = AgentSelectionHintsConfig & {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  description?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
  outputSchema?: Record<string, unknown> | undefined;
  query?: Record<string, string | number | boolean> | undefined;
  headers?: Record<string, string | number | boolean> | undefined;
  jsonBody?: unknown;
};

export type HttpApiConfig = CommonCapletConfig & {
  backend: "http";
  baseUrl: string;
  auth: OpenApiAuthConfig;
  actions: Record<string, HttpActionConfig>;
  requestTimeoutMs: number;
  maxResponseBytes: number;
};

export type CliToolActionConfig = AgentSelectionHintsConfig & {
  description?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
  outputSchema?: Record<string, unknown> | undefined;
  command: string;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  maxOutputBytes?: number | undefined;
  output?: { type: "text" | "json" } | undefined;
  annotations?:
    | {
        readOnlyHint?: boolean | undefined;
        destructiveHint?: boolean | undefined;
        idempotentHint?: boolean | undefined;
        openWorldHint?: boolean | undefined;
      }
    | undefined;
};

export type CliToolsConfig = CommonCapletConfig & {
  backend: "cli";
  actions: Record<string, CliToolActionConfig>;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  timeoutMs: number;
  maxOutputBytes: number;
};

export type CapletSetConfig = CommonCapletConfig & {
  backend: "caplets";
  configPath?: string | undefined;
  capletsRoot?: string | undefined;
  defaultSearchLimit: number;
  maxSearchLimit: number;
  toolCacheTtlMs: number;
};

export type CapletConfig =
  | CapletServerConfig
  | OpenApiEndpointConfig
  | GraphQlEndpointConfig
  | HttpApiConfig
  | CliToolsConfig
  | CapletSetConfig;

export type CapletsConfig = {
  version: 1;
  options: {
    defaultSearchLimit: number;
    maxSearchLimit: number;
    exposure: CapletExposure;
    exposureDiscoveryTimeoutMs: number;
    exposureDiscoveryConcurrency: number;
    completion: {
      discoveryTimeoutMs: number;
      overallTimeoutMs: number;
      cacheTtlMs: number;
      negativeCacheTtlMs: number;
    };
  };
  mcpServers: Record<string, CapletServerConfig>;
  openapiEndpoints: Record<string, OpenApiEndpointConfig>;
  graphqlEndpoints: Record<string, GraphQlEndpointConfig>;
  httpApis: Record<string, HttpApiConfig>;
  cliTools: Record<string, CliToolsConfig>;
  capletSets: Record<string, CapletSetConfig>;
};

type CommonCapletConfig = AgentSelectionHintsConfig & {
  server: string;
  name: string;
  description: string;
  exposure?: CapletExposure | undefined;
  tags?: string[] | undefined;
  body?: string | undefined;
  setup?: CapletSetupConfig | undefined;
  projectBinding?: ProjectBindingConfig | undefined;
  runtime?: RuntimeRequirementsConfig | undefined;
  disabled: boolean;
};

const stringMapSchema = z.record(z.string(), z.string());
const authSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("bearer"), token: z.string().min(1) }).strict(),
  z.object({ type: z.literal("headers"), headers: stringMapSchema }).strict(),
  oauthLikeSchema("oauth2"),
  oauthLikeSchema("oidc"),
]);
const setupCommandSchema = z
  .object({
    label: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: stringMapSchema.optional(),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
  })
  .strict();
const setupSchema = z
  .object({
    commands: z.array(setupCommandSchema).optional(),
    verify: z.array(setupCommandSchema).optional(),
  })
  .strict()
  .refine(
    (setup) => (setup.commands?.length ?? 0) > 0 || (setup.verify?.length ?? 0) > 0,
    "setup must define at least one command or verify step",
  );
const projectBindingSchema = z.object({ required: z.literal(true) }).strict();
const runtimeFeatureSchema = z.enum(["docker", "browser"]);
const runtimeFeaturesSchema = z
  .array(runtimeFeatureSchema)
  .refine((features) => new Set(features).size === features.length, {
    message: "runtime.features must not contain duplicate feature names",
  });
const runtimeRequirementsSchema = z
  .object({
    features: runtimeFeaturesSchema.optional(),
    resources: z
      .object({
        class: z.enum(["standard", "large", "heavy"]).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const agentSelectionHintSchema = z.string().trim().min(1).max(500);
const agentSelectionHintsSchema = {
  useWhen: agentSelectionHintSchema.optional(),
  avoidWhen: agentSelectionHintSchema.optional(),
};
const exposureSchema = z.enum([
  "direct",
  "progressive",
  "code_mode",
  "direct_and_code_mode",
  "progressive_and_code_mode",
]);
const commonSchema = {
  name: z.string().trim().min(1).max(80),
  description: z
    .string()
    .refine(
      (value) => value.trim().length >= 10,
      "description must contain at least 10 non-whitespace characters",
    )
    .refine((value) => value.length <= 1500, "description must be at most 1500 characters"),
  tags: z.array(z.string().trim().min(1).max(80)).optional(),
  exposure: exposureSchema.optional(),
  ...agentSelectionHintsSchema,
  body: z.string().optional(),
  setup: setupSchema.optional(),
  projectBinding: projectBindingSchema.optional(),
  runtime: runtimeRequirementsSchema.optional(),
  disabled: z.boolean().default(false),
};
const mcpServerSchema = z
  .object({
    ...commonSchema,
    transport: z.enum(["stdio", "http", "sse"]).optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: stringMapSchema.optional(),
    cwd: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    auth: authSchema.optional(),
    startupTimeoutMs: z.number().int().positive().default(10_000),
    callTimeoutMs: z.number().int().positive().default(60_000),
    toolCacheTtlMs: z.number().int().nonnegative().default(30_000),
  })
  .strict();
const openApiEndpointSchema = z
  .object({
    ...commonSchema,
    specPath: z.string().min(1).optional(),
    specUrl: z.string().min(1).optional(),
    baseUrl: z.string().min(1).optional(),
    auth: authSchema,
    requestTimeoutMs: z.number().int().positive().default(60_000),
    operationCacheTtlMs: z.number().int().nonnegative().default(30_000),
  })
  .strict();
const graphQlOperationSchema = z
  .object({
    document: z.string().min(1).optional(),
    documentPath: z.string().min(1).optional(),
    operationName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    ...agentSelectionHintsSchema,
  })
  .strict()
  .refine((operation) => Boolean(operation.document) !== Boolean(operation.documentPath), {
    message: "GraphQL operation must define exactly one document source",
  });
const graphQlEndpointSchema = z
  .object({
    ...commonSchema,
    endpointUrl: z.string().min(1),
    schemaPath: z.string().min(1).optional(),
    schemaUrl: z.string().min(1).optional(),
    introspection: z.literal(true).optional(),
    operations: z.record(z.string().regex(SERVER_ID_PATTERN), graphQlOperationSchema).optional(),
    auth: authSchema,
    requestTimeoutMs: z.number().int().positive().default(60_000),
    operationCacheTtlMs: z.number().int().nonnegative().default(30_000),
    selectionDepth: z.number().int().positive().max(5).default(2),
  })
  .strict();
const scalarMapSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
const httpActionSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z
      .string()
      .min(1)
      .regex(/^\//, "HTTP action path must start with /")
      .refine((value) => !value.startsWith("//"), "HTTP action path must not start with //")
      .refine((value) => !isUrl(value), "HTTP action path must be a URL path, not a URL"),
    description: z.string().min(1).optional(),
    ...agentSelectionHintsSchema,
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    query: scalarMapSchema.optional(),
    headers: scalarMapSchema.optional(),
    jsonBody: z.unknown().optional(),
  })
  .strict()
  .refine((action) => action.method !== "GET" || action.jsonBody === undefined, {
    path: ["jsonBody"],
    message: "HTTP GET actions must not define jsonBody",
  });
const httpApiSchema = z
  .object({
    ...commonSchema,
    baseUrl: z
      .string()
      .min(1)
      .regex(
        HTTP_BASE_URL_PATTERN,
        "HTTP API baseUrl must not include credentials, query, or fragment",
      ),
    auth: authSchema,
    actions: z
      .record(z.string().regex(SERVER_ID_PATTERN), httpActionSchema)
      .refine(
        (actions) => Object.keys(actions).length > 0,
        "HTTP API must define at least one action",
      ),
    requestTimeoutMs: z.number().int().positive().default(60_000),
    maxResponseBytes: z.number().int().positive().default(200_000),
  })
  .strict();
const cliActionSchema = z
  .object({
    description: z.string().min(1).optional(),
    ...agentSelectionHintsSchema,
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: stringMapSchema.optional(),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxOutputBytes: z.number().int().positive().optional(),
    output: z
      .object({ type: z.enum(["text", "json"]).default("text") })
      .strict()
      .optional(),
    annotations: z
      .object({
        readOnlyHint: z.boolean().optional(),
        destructiveHint: z.boolean().optional(),
        idempotentHint: z.boolean().optional(),
        openWorldHint: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const cliToolsSchema = z
  .object({
    ...commonSchema,
    actions: z
      .record(z.string().regex(SERVER_ID_PATTERN), cliActionSchema)
      .refine(
        (actions) => Object.keys(actions).length > 0,
        "CLI tools backend must define at least one action",
      ),
    cwd: z.string().min(1).optional(),
    env: stringMapSchema.optional(),
    timeoutMs: z.number().int().positive().default(60_000),
    maxOutputBytes: z.number().int().positive().default(200_000),
  })
  .strict();
const capletSetSchema = z
  .object({
    ...commonSchema,
    configPath: z.string().min(1).optional(),
    capletsRoot: z.string().min(1).optional(),
    defaultSearchLimit: z.number().int().positive().default(20),
    maxSearchLimit: z.number().int().positive().max(50).default(50),
    toolCacheTtlMs: z.number().int().nonnegative().default(30_000),
  })
  .strict();

const configSchema = z
  .object({
    version: z.literal(1).default(1),
    defaultSearchLimit: z.number().int().positive().default(20),
    maxSearchLimit: z.number().int().positive().max(50).default(50),
    completion: z
      .object({
        discoveryTimeoutMs: z.number().int().positive().default(750),
        overallTimeoutMs: z.number().int().positive().default(1500),
        cacheTtlMs: z.number().int().nonnegative().default(300_000),
        negativeCacheTtlMs: z.number().int().nonnegative().default(30_000),
      })
      .strict()
      .default({
        discoveryTimeoutMs: 750,
        overallTimeoutMs: 1500,
        cacheTtlMs: 300_000,
        negativeCacheTtlMs: 30_000,
      }),
    options: z
      .object({
        exposure: exposureSchema.default("progressive_and_code_mode"),
        exposureDiscoveryTimeoutMs: z.number().int().positive().default(15_000),
        exposureDiscoveryConcurrency: z.number().int().positive().max(32).default(4),
      })
      .strict()
      .default({
        exposure: "progressive_and_code_mode",
        exposureDiscoveryTimeoutMs: 15_000,
        exposureDiscoveryConcurrency: 4,
      }),
    mcpServers: z.record(z.string().regex(SERVER_ID_PATTERN), mcpServerSchema).default({}),
    openapiEndpoints: z
      .record(z.string().regex(SERVER_ID_PATTERN), openApiEndpointSchema)
      .default({}),
    graphqlEndpoints: z
      .record(z.string().regex(SERVER_ID_PATTERN), graphQlEndpointSchema)
      .default({}),
    httpApis: z.record(z.string().regex(SERVER_ID_PATTERN), httpApiSchema).default({}),
    cliTools: z.record(z.string().regex(SERVER_ID_PATTERN), cliToolsSchema).default({}),
    capletSets: z.record(z.string().regex(SERVER_ID_PATTERN), capletSetSchema).default({}),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.defaultSearchLimit > config.maxSearchLimit) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultSearchLimit"],
        message: "defaultSearchLimit must be <= maxSearchLimit",
      });
    }
    validateBackends(config, ctx);
  });

export function parseConfig(input: unknown): CapletsConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    throw new CapletsError("CONFIG_INVALID", "Caplets config is invalid", parsed.error.issues);
  }
  const config = parsed.data;
  return {
    version: 1,
    options: {
      defaultSearchLimit: config.defaultSearchLimit,
      maxSearchLimit: config.maxSearchLimit,
      exposure: config.options.exposure,
      exposureDiscoveryTimeoutMs: config.options.exposureDiscoveryTimeoutMs,
      exposureDiscoveryConcurrency: config.options.exposureDiscoveryConcurrency,
      completion: config.completion,
    },
    mcpServers: mapBackend(config.mcpServers, "mcp", (id, raw) => {
      const server = raw as z.infer<typeof mcpServerSchema>;
      return {
        ...server,
        server: id,
        transport: server.transport ?? (server.command ? "stdio" : "http"),
      };
    }),
    openapiEndpoints: mapBackend(config.openapiEndpoints, "openapi"),
    graphqlEndpoints: mapBackend(config.graphqlEndpoints, "graphql"),
    httpApis: mapBackend(config.httpApis, "http"),
    cliTools: mapBackend(config.cliTools, "cli"),
    capletSets: mapBackend(config.capletSets, "caplets"),
  };
}

function oauthLikeSchema(type: "oauth2" | "oidc") {
  return z
    .object({
      type: z.literal(type),
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
    .strict();
}

function validateBackends(config: z.infer<typeof configSchema>, ctx: z.RefinementCtx): void {
  for (const [server, raw] of Object.entries(config.mcpServers)) {
    const effectiveTransport = raw.transport ?? (raw.command ? "stdio" : undefined);
    const hasCommand = Boolean(raw.command);
    const hasUrl = Boolean(raw.url);
    if (hasCommand === hasUrl) {
      ctx.addIssue({
        code: "custom",
        path: ["mcpServers", server],
        message: "MCP server must define exactly one connection shape: command or url",
      });
    }
    if (effectiveTransport === "stdio" && !raw.command) {
      ctx.addIssue({
        code: "custom",
        path: ["mcpServers", server, "command"],
        message: "stdio servers require command",
      });
    }
    if ((effectiveTransport === "http" || effectiveTransport === "sse") && !raw.url) {
      ctx.addIssue({
        code: "custom",
        path: ["mcpServers", server, "url"],
        message: "remote servers require url",
      });
    }
    if (raw.url && !hasEnvReference(raw.url) && !isAllowedRemoteUrl(raw.url)) {
      ctx.addIssue({
        code: "custom",
        path: ["mcpServers", server, "url"],
        message: "remote url must use https except loopback development urls",
      });
    }
    validateAuthHeaders(raw.auth, ctx, ["mcpServers", server, "auth"]);
  }
  for (const [server, raw] of Object.entries(config.openapiEndpoints)) {
    if (Boolean(raw.specPath) === Boolean(raw.specUrl)) {
      ctx.addIssue({
        code: "custom",
        path: ["openapiEndpoints", server],
        message: "OpenAPI endpoint must define exactly one spec source: specPath or specUrl",
      });
    }
    if (raw.specUrl && !hasEnvReference(raw.specUrl) && !isAllowedRemoteUrl(raw.specUrl)) {
      ctx.addIssue({
        code: "custom",
        path: ["openapiEndpoints", server, "specUrl"],
        message: "OpenAPI specUrl must use https except loopback development urls",
      });
    }
    if (raw.baseUrl && !hasEnvReference(raw.baseUrl) && !isAllowedRemoteUrl(raw.baseUrl)) {
      ctx.addIssue({
        code: "custom",
        path: ["openapiEndpoints", server, "baseUrl"],
        message: "OpenAPI baseUrl must use https except loopback development urls",
      });
    }
    validateAuthHeaders(raw.auth, ctx, ["openapiEndpoints", server, "auth"]);
  }
  for (const [server, raw] of Object.entries(config.graphqlEndpoints)) {
    const sourceCount =
      Number(Boolean(raw.schemaPath)) +
      Number(Boolean(raw.schemaUrl)) +
      Number(raw.introspection === true);
    if (sourceCount !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["graphqlEndpoints", server],
        message: "GraphQL endpoint must define exactly one schema source",
      });
    }
    if (
      raw.endpointUrl &&
      !hasEnvReference(raw.endpointUrl) &&
      !isAllowedRemoteUrl(raw.endpointUrl)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["graphqlEndpoints", server, "endpointUrl"],
        message: "GraphQL endpointUrl must use https except loopback development urls",
      });
    }
    validateAuthHeaders(raw.auth, ctx, ["graphqlEndpoints", server, "auth"]);
  }
  for (const [server, raw] of Object.entries(config.httpApis)) {
    if (raw.baseUrl && !hasEnvReference(raw.baseUrl) && !isAllowedHttpBaseUrl(raw.baseUrl)) {
      ctx.addIssue({
        code: "custom",
        path: ["httpApis", server, "baseUrl"],
        message:
          "HTTP API baseUrl must use https except loopback development urls and must not include credentials, query, or fragment",
      });
    }
    validateAuthHeaders(raw.auth, ctx, ["httpApis", server, "auth"]);
    for (const [actionName, action] of Object.entries(raw.actions)) {
      if (action.headers)
        validateHttpActionHeaders(action.headers, ctx, [
          "httpApis",
          server,
          "actions",
          actionName,
          "headers",
        ]);
    }
  }
  for (const [server, raw] of Object.entries(config.capletSets)) {
    if (!raw.configPath && !raw.capletsRoot) {
      ctx.addIssue({
        code: "custom",
        path: ["capletSets", server],
        message: "Caplet set must define at least one source: configPath or capletsRoot",
      });
    }
    if (raw.defaultSearchLimit > raw.maxSearchLimit) {
      ctx.addIssue({
        code: "custom",
        path: ["capletSets", server, "defaultSearchLimit"],
        message: "defaultSearchLimit must be <= maxSearchLimit",
      });
    }
  }
}

function validateAuthHeaders(
  auth: RemoteAuthConfig | undefined,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (auth?.type !== "headers") return;
  for (const headerName of Object.keys(auth.headers)) {
    const normalized = headerName.toLowerCase();
    if (!HEADER_NAME_PATTERN.test(headerName) || FORBIDDEN_HEADERS.has(normalized)) {
      ctx.addIssue({
        code: "custom",
        path: [...path, "headers", headerName],
        message: `header ${headerName} is not allowed`,
      });
    }
  }
}

function mapBackend<B extends CapletConfig["backend"]>(
  records: Record<string, object>,
  backend: B,
  prepare?: (id: string, raw: object) => object,
): Record<string, Extract<CapletConfig, { backend: B }>> {
  return Object.fromEntries(
    Object.entries(records).map(([id, raw]) => [
      id,
      stripUndefined({
        ...(prepare ? prepare(id, raw) : raw),
        server: id,
        backend,
      }) as Extract<CapletConfig, { backend: B }>,
    ]),
  );
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined));
}

function hasEnvReference(value: string): boolean {
  return /\$\{?[A-Z_][A-Z0-9_]*\}?|\$env:[A-Z_][A-Z0-9_]*/u.test(value);
}
