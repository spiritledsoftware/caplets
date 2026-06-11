import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  loadCapletFiles,
  loadCapletFilesWithPaths,
  loadCapletFilesWithPathsBestEffort,
} from "./caplet-files";
import { resolveCapletsRoot, resolveConfigPath, resolveProjectConfigPath } from "./config/paths";
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
import { CapletsError, redactSecrets } from "./errors";
import { nestedSchema, schemaPath } from "./schema-utils";

export {
  DEFAULT_AUTH_DIR,
  DEFAULT_COMPLETION_CACHE_DIR,
  DEFAULT_CONFIG_PATH,
  PROJECT_CONFIG_FILE,
  defaultCacheBaseDir,
  defaultCompletionCacheDir,
  resolveCapletsRoot,
  resolveConfigPath,
  resolveProjectCapletsRoot,
  resolveProjectConfigPath,
} from "./config/paths";

export type RemoteAuthConfig =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "headers"; headers: Record<string, string> }
  | {
      type: "oauth2";
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
    }
  | {
      type: "oidc";
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

export type CapletServerConfig = AgentSelectionHintsConfig & {
  server: string;
  backend: "mcp";
  name: string;
  description: string;
  exposure?: CapletExposure | undefined;
  tags?: string[] | undefined;
  body?: string | undefined;
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
  disabled: boolean;
  setup?: CapletSetupConfig | undefined;
  projectBinding?: ProjectBindingConfig | undefined;
  runtime?: RuntimeRequirementsConfig | undefined;
};

export type OpenApiAuthConfig =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "headers"; headers: Record<string, string> }
  | Extract<RemoteAuthConfig, { type: "oauth2" | "oidc" }>;

export type OpenApiEndpointConfig = AgentSelectionHintsConfig & {
  server: string;
  backend: "openapi";
  name: string;
  description: string;
  exposure?: CapletExposure | undefined;
  tags?: string[] | undefined;
  body?: string | undefined;
  specPath?: string | undefined;
  specUrl?: string | undefined;
  baseUrl?: string | undefined;
  auth: OpenApiAuthConfig;
  requestTimeoutMs: number;
  operationCacheTtlMs: number;
  disabled: boolean;
  setup?: CapletSetupConfig | undefined;
  projectBinding?: ProjectBindingConfig | undefined;
  runtime?: RuntimeRequirementsConfig | undefined;
};

export type GraphQlOperationConfig = AgentSelectionHintsConfig & {
  document?: string | undefined;
  documentPath?: string | undefined;
  operationName?: string | undefined;
  description?: string | undefined;
};

export type GraphQlEndpointConfig = AgentSelectionHintsConfig & {
  server: string;
  backend: "graphql";
  name: string;
  description: string;
  exposure?: CapletExposure | undefined;
  tags?: string[] | undefined;
  body?: string | undefined;
  endpointUrl: string;
  schemaPath?: string | undefined;
  schemaUrl?: string | undefined;
  introspection?: true | undefined;
  operations?: Record<string, GraphQlOperationConfig> | undefined;
  auth: OpenApiAuthConfig;
  requestTimeoutMs: number;
  operationCacheTtlMs: number;
  selectionDepth: number;
  disabled: boolean;
  setup?: CapletSetupConfig | undefined;
  projectBinding?: ProjectBindingConfig | undefined;
  runtime?: RuntimeRequirementsConfig | undefined;
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

export type HttpApiConfig = AgentSelectionHintsConfig & {
  server: string;
  backend: "http";
  name: string;
  description: string;
  exposure?: CapletExposure | undefined;
  tags?: string[] | undefined;
  body?: string | undefined;
  baseUrl: string;
  auth: OpenApiAuthConfig;
  actions: Record<string, HttpActionConfig>;
  requestTimeoutMs: number;
  maxResponseBytes: number;
  disabled: boolean;
  setup?: CapletSetupConfig | undefined;
  projectBinding?: ProjectBindingConfig | undefined;
  runtime?: RuntimeRequirementsConfig | undefined;
};

export type CliToolOutputConfig = {
  type: "text" | "json";
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
  output?: CliToolOutputConfig | undefined;
  annotations?:
    | {
        readOnlyHint?: boolean | undefined;
        destructiveHint?: boolean | undefined;
        idempotentHint?: boolean | undefined;
        openWorldHint?: boolean | undefined;
      }
    | undefined;
};

export type CliToolsConfig = AgentSelectionHintsConfig & {
  server: string;
  backend: "cli";
  name: string;
  description: string;
  exposure?: CapletExposure | undefined;
  tags?: string[] | undefined;
  body?: string | undefined;
  actions: Record<string, CliToolActionConfig>;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  timeoutMs: number;
  maxOutputBytes: number;
  disabled: boolean;
  setup?: CapletSetupConfig | undefined;
  projectBinding?: ProjectBindingConfig | undefined;
  runtime?: RuntimeRequirementsConfig | undefined;
};

export type CapletSetConfig = AgentSelectionHintsConfig & {
  server: string;
  backend: "caplets";
  name: string;
  description: string;
  exposure?: CapletExposure | undefined;
  tags?: string[] | undefined;
  body?: string | undefined;
  configPath?: string | undefined;
  capletsRoot?: string | undefined;
  defaultSearchLimit: number;
  maxSearchLimit: number;
  toolCacheTtlMs: number;
  disabled: boolean;
  setup?: CapletSetupConfig | undefined;
  projectBinding?: ProjectBindingConfig | undefined;
  runtime?: RuntimeRequirementsConfig | undefined;
};

export type CapletConfig =
  | CapletServerConfig
  | OpenApiEndpointConfig
  | GraphQlEndpointConfig
  | HttpApiConfig
  | CliToolsConfig
  | CapletSetConfig;

export type CapletsOptions = {
  defaultSearchLimit: number;
  maxSearchLimit: number;
  exposure: CapletExposure;
  exposureDiscoveryTimeoutMs: number;
  exposureDiscoveryConcurrency: number;
  completion: CompletionConfig;
};

export type CompletionConfig = {
  discoveryTimeoutMs: number;
  overallTimeoutMs: number;
  cacheTtlMs: number;
  negativeCacheTtlMs: number;
};

export type CapletsConfig = {
  version: 1;
  options: CapletsOptions;
  mcpServers: Record<string, CapletServerConfig>;
  openapiEndpoints: Record<string, OpenApiEndpointConfig>;
  graphqlEndpoints: Record<string, GraphQlEndpointConfig>;
  httpApis: Record<string, HttpApiConfig>;
  cliTools: Record<string, CliToolsConfig>;
  capletSets: Record<string, CapletSetConfig>;
};

export type ConfigSourceKind = "global-config" | "global-file" | "project-config" | "project-file";

export type ConfigSource = {
  kind: ConfigSourceKind;
  path: string;
};

export type ConfigWithSources = {
  config: CapletsConfig;
  sources: Record<string, ConfigSource>;
  shadows: Record<string, ConfigSource[]>;
};

export type LocalOverlayConfigWarning = {
  kind: ConfigSourceKind;
  path: string;
  message: string;
};

export type LocalOverlayConfigWithSources = ConfigWithSources & {
  warnings: LocalOverlayConfigWarning[];
};

const NON_INTERPOLATED_SERVER_FIELDS = new Set(["name", "description", "tags", "body"]);

const remoteAuthSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("none") }).strict(),
    z.object({ type: z.literal("bearer"), token: z.string().min(1) }).strict(),
    z
      .object({ type: z.literal("headers"), headers: z.record(z.string(), z.string().min(1)) })
      .strict(),
    z
      .object({
        type: z.literal("oauth2"),
        authorizationUrl: z.string().url().optional(),
        tokenUrl: z.string().url().optional(),
        issuer: z.string().url().optional(),
        resourceMetadataUrl: z.string().url().optional(),
        authorizationServerMetadataUrl: z.string().url().optional(),
        openidConfigurationUrl: z.string().url().optional(),
        clientMetadataUrl: z.string().url().optional(),
        clientId: z.string().min(1).optional(),
        clientSecret: z.string().min(1).optional(),
        scopes: z.array(z.string().min(1)).optional(),
        redirectUri: z.string().url().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("oidc"),
        authorizationUrl: z.string().url().optional(),
        tokenUrl: z.string().url().optional(),
        issuer: z.string().url().optional(),
        resourceMetadataUrl: z.string().url().optional(),
        authorizationServerMetadataUrl: z.string().url().optional(),
        openidConfigurationUrl: z.string().url().optional(),
        clientMetadataUrl: z.string().url().optional(),
        clientId: z.string().min(1).optional(),
        clientSecret: z.string().min(1).optional(),
        scopes: z.array(z.string().min(1)).optional(),
        redirectUri: z.string().url().optional(),
      })
      .strict(),
  ])
  .describe("Authentication settings for a remote MCP server.");

const oauthLikeAuthSchema = z.union([
  z
    .object({
      type: z.literal("oauth2"),
      authorizationUrl: z.string().url().optional(),
      tokenUrl: z.string().url().optional(),
      issuer: z.string().url().optional(),
      resourceMetadataUrl: z.string().url().optional(),
      authorizationServerMetadataUrl: z.string().url().optional(),
      openidConfigurationUrl: z.string().url().optional(),
      clientMetadataUrl: z.string().url().optional(),
      clientId: z.string().min(1).optional(),
      clientSecret: z.string().min(1).optional(),
      scopes: z.array(z.string().min(1)).optional(),
      redirectUri: z.string().url().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("oidc"),
      authorizationUrl: z.string().url().optional(),
      tokenUrl: z.string().url().optional(),
      issuer: z.string().url().optional(),
      resourceMetadataUrl: z.string().url().optional(),
      authorizationServerMetadataUrl: z.string().url().optional(),
      openidConfigurationUrl: z.string().url().optional(),
      clientMetadataUrl: z.string().url().optional(),
      clientId: z.string().min(1).optional(),
      clientSecret: z.string().min(1).optional(),
      scopes: z.array(z.string().min(1)).optional(),
      redirectUri: z.string().url().optional(),
    })
    .strict(),
]);

const openApiAuthSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("none") }).strict(),
    z.object({ type: z.literal("bearer"), token: z.string().min(1) }).strict(),
    z
      .object({ type: z.literal("headers"), headers: z.record(z.string(), z.string().min(1)) })
      .strict(),
    ...oauthLikeAuthSchema.options,
  ])
  .describe("Authentication settings for an OpenAPI endpoint.");

const setupCommandSchema = z
  .object({
    label: z.string().min(1).describe("Human-readable setup or verification step label."),
    command: z.string().min(1).describe("Executable command to spawn without a shell."),
    args: z.array(z.string()).optional().describe("Arguments passed to the command."),
    env: z.record(z.string(), z.string()).optional().describe("Additional environment variables."),
    cwd: z.string().min(1).optional().describe("Working directory for this command."),
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

const projectBindingSchema = z
  .object({
    required: z.literal(true).describe("Requires Project Binding before this Caplet can run."),
  })
  .strict()
  .describe("Project Binding requirements for Caplets that need an attached project.");

const runtimeFeatureSchema = z.enum(["docker", "browser"]);
const runtimeFeaturesSchema = z
  .array(runtimeFeatureSchema)
  .refine((features) => new Set(features).size === features.length, {
    message: "runtime.features must not contain duplicate feature names",
  })
  .describe("Runtime features required by this Caplet.");

const runtimeRequirementsSchema = z
  .object({
    features: runtimeFeaturesSchema.optional(),
    resources: z
      .object({
        class: z
          .enum(["standard", "large", "heavy"])
          .optional()
          .describe("Requested hosted sandbox resource class."),
      })
      .strict()
      .optional()
      .describe("Hosted sandbox resource requirements."),
  })
  .strict()
  .describe("Runtime feature and resource requirements for hosted execution.");

const agentSelectionHintSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe("Optional author-supplied hint for agent tool/caplet selection.");

const agentSelectionHintsSchema = {
  useWhen: agentSelectionHintSchema
    .optional()
    .describe("When agents should prefer this Caplet or configured action."),
  avoidWhen: agentSelectionHintSchema
    .optional()
    .describe("When agents should avoid this Caplet or configured action."),
};

const exposureSchema = z
  .enum(["direct", "progressive", "code_mode", "direct_and_code_mode", "progressive_and_code_mode"])
  .describe("How this Caplet is exposed to agents.");

const publicServerSchema = z
  .object({
    name: z.string().trim().min(1).max(80).describe("Human-readable server display name."),
    description: z
      .string()
      .describe("Capability description shown to agents before downstream tools are disclosed.")
      .refine(
        (value) => value.trim().length >= 10,
        "description must contain at least 10 non-whitespace characters",
      )
      .refine((value) => value.length <= 1500, "description must be at most 1500 characters"),
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
    url: z.string().url().optional().describe("Remote MCP server URL for http or sse transport."),
    auth: remoteAuthSchema.optional(),
    tags: z.array(z.string().trim().min(1).max(80)).optional(),
    exposure: exposureSchema.optional(),
    ...agentSelectionHintsSchema,
    setup: setupSchema.optional(),
    projectBinding: projectBindingSchema.optional(),
    runtime: runtimeRequirementsSchema.optional(),
    startupTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(10_000)
      .describe("Timeout in milliseconds for starting or checking a downstream server."),
    callTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(60_000)
      .describe("Timeout in milliseconds for downstream tool calls."),
    toolCacheTtlMs: z
      .number()
      .int()
      .nonnegative()
      .default(30_000)
      .describe("Milliseconds downstream tool metadata stays fresh. Set 0 to refresh every time."),
    disabled: z
      .boolean()
      .default(false)
      .describe("When true, omit this server from Caplets discovery and do not start it."),
  })
  .strict();

const normalizedServerSchema = publicServerSchema.extend({
  body: z.string().optional(),
});

const publicOpenApiEndpointSchema = z
  .object({
    name: z.string().trim().min(1).max(80).describe("Human-readable OpenAPI display name."),
    description: z
      .string()
      .describe("Capability description shown to agents before OpenAPI operations are disclosed.")
      .refine(
        (value) => value.trim().length >= 10,
        "description must contain at least 10 non-whitespace characters",
      )
      .refine((value) => value.length <= 1500, "description must be at most 1500 characters"),
    specPath: z.string().min(1).optional().describe("Local OpenAPI specification path."),
    specUrl: z.string().url().optional().describe("Remote OpenAPI specification URL."),
    baseUrl: z.string().url().optional().describe("Override base URL for OpenAPI requests."),
    auth: openApiAuthSchema.describe(
      'Explicit OpenAPI request auth config. Use {"type":"none"} for public APIs.',
    ),
    tags: z.array(z.string().trim().min(1).max(80)).optional(),
    exposure: exposureSchema.optional(),
    ...agentSelectionHintsSchema,
    setup: setupSchema.optional(),
    projectBinding: projectBindingSchema.optional(),
    runtime: runtimeRequirementsSchema.optional(),
    requestTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(60_000)
      .describe("Timeout in milliseconds for OpenAPI HTTP requests."),
    operationCacheTtlMs: z
      .number()
      .int()
      .nonnegative()
      .default(30_000)
      .describe(
        "Milliseconds OpenAPI operation metadata stays fresh. Set 0 to refresh every time.",
      ),
    disabled: z
      .boolean()
      .default(false)
      .describe("When true, omit this OpenAPI Caplet from discovery."),
  })
  .strict();

const normalizedOpenApiEndpointSchema = publicOpenApiEndpointSchema.extend({
  body: z.string().optional(),
});

const graphQlOperationSchema = z
  .object({
    document: z.string().min(1).optional().describe("Inline GraphQL operation document."),
    documentPath: z.string().min(1).optional().describe("Path to a GraphQL operation document."),
    operationName: z.string().min(1).optional().describe("Operation name to execute."),
    description: z.string().min(1).optional().describe("Operation capability description."),
    ...agentSelectionHintsSchema,
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

const publicGraphQlEndpointSchema = z
  .object({
    name: z.string().trim().min(1).max(80).describe("Human-readable GraphQL display name."),
    description: z
      .string()
      .describe("Capability description shown to agents before GraphQL operations are disclosed.")
      .refine(
        (value) => value.trim().length >= 10,
        "description must contain at least 10 non-whitespace characters",
      )
      .refine((value) => value.length <= 1500, "description must be at most 1500 characters"),
    endpointUrl: z.string().url().describe("GraphQL HTTP endpoint URL."),
    schemaPath: z.string().min(1).optional().describe("Local GraphQL SDL or introspection path."),
    schemaUrl: z.string().url().optional().describe("Remote GraphQL SDL or introspection URL."),
    introspection: z
      .literal(true)
      .optional()
      .describe("Load schema through endpoint introspection."),
    operations: z
      .record(z.string().regex(SERVER_ID_PATTERN), graphQlOperationSchema)
      .optional()
      .describe("Configured GraphQL operations keyed by stable tool name."),
    auth: openApiAuthSchema.describe(
      'Explicit GraphQL request auth config. Use {"type":"none"} for public APIs.',
    ),
    tags: z.array(z.string().trim().min(1).max(80)).optional(),
    exposure: exposureSchema.optional(),
    ...agentSelectionHintsSchema,
    setup: setupSchema.optional(),
    projectBinding: projectBindingSchema.optional(),
    runtime: runtimeRequirementsSchema.optional(),
    requestTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(60_000)
      .describe("Timeout in milliseconds for GraphQL HTTP requests."),
    operationCacheTtlMs: z
      .number()
      .int()
      .nonnegative()
      .default(30_000)
      .describe(
        "Milliseconds GraphQL operation metadata stays fresh. Set 0 to refresh every time.",
      ),
    selectionDepth: z
      .number()
      .int()
      .positive()
      .max(5)
      .default(2)
      .describe("Maximum depth for auto-generated GraphQL selection sets."),
    disabled: z.boolean().default(false).describe("When true, omit this GraphQL Caplet."),
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
          "GraphQL endpoint must define exactly one schema source: schemaPath, schemaUrl, or introspection",
      });
    }
  });

const normalizedGraphQlEndpointSchema = publicGraphQlEndpointSchema.extend({
  body: z.string().optional(),
});

const httpScalarMappingSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);

const httpActionSchema = z
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
    ...agentSelectionHintsSchema,
    inputSchema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("JSON Schema for call_tool arguments."),
    outputSchema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("JSON Schema for structuredContent returned by this action."),
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

const publicHttpApiSchema = z
  .object({
    name: z.string().trim().min(1).max(80).describe("Human-readable HTTP API display name."),
    description: z
      .string()
      .describe("Capability description shown to agents before HTTP actions are disclosed.")
      .refine(
        (value) => value.trim().length >= 10,
        "description must contain at least 10 non-whitespace characters",
      )
      .refine((value) => value.length <= 1500, "description must be at most 1500 characters"),
    baseUrl: z
      .string()
      .url()
      .regex(
        HTTP_BASE_URL_PATTERN,
        "HTTP API baseUrl must not include credentials, query, or fragment",
      )
      .describe("Base URL for HTTP action requests."),
    auth: openApiAuthSchema.describe(
      'Explicit HTTP API request auth config. Use {"type":"none"} for public APIs.',
    ),
    actions: z
      .record(z.string().regex(SERVER_ID_PATTERN), httpActionSchema)
      .refine(
        (actions) => Object.keys(actions).length > 0,
        "HTTP API must define at least one action",
      )
      .describe("Configured HTTP actions keyed by stable tool name."),
    tags: z.array(z.string().trim().min(1).max(80)).optional(),
    exposure: exposureSchema.optional(),
    ...agentSelectionHintsSchema,
    setup: setupSchema.optional(),
    projectBinding: projectBindingSchema.optional(),
    runtime: runtimeRequirementsSchema.optional(),
    requestTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(60_000)
      .describe("Timeout in milliseconds for HTTP action requests."),
    maxResponseBytes: z
      .number()
      .int()
      .positive()
      .default(200_000)
      .describe("Maximum HTTP action response body bytes to read."),
    disabled: z.boolean().default(false).describe("When true, omit this HTTP API Caplet."),
  })
  .strict();

const normalizedHttpApiSchema = publicHttpApiSchema.extend({
  body: z.string().optional(),
});

const cliToolOutputSchema = z
  .object({
    type: z
      .enum(["text", "json"])
      .default("text")
      .describe("How stdout should be represented in structuredContent."),
  })
  .strict();

const cliToolAnnotationsSchema = z
  .object({
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .strict();

const cliToolActionSchema = z
  .object({
    description: z.string().min(1).optional().describe("Action capability description."),
    ...agentSelectionHintsSchema,
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
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("Additional environment variables for the command."),
    cwd: z.string().min(1).optional().describe("Working directory for this action."),
    timeoutMs: z.number().int().positive().optional().describe("Command timeout in milliseconds."),
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum combined stdout and stderr bytes to keep."),
    output: cliToolOutputSchema.optional(),
    annotations: cliToolAnnotationsSchema.optional(),
  })
  .strict();

const publicCliToolsSchema = z
  .object({
    name: z.string().trim().min(1).max(80).describe("Human-readable CLI tools display name."),
    description: z
      .string()
      .describe("Capability description shown to agents before CLI actions are disclosed.")
      .refine(
        (value) => value.trim().length >= 10,
        "description must contain at least 10 non-whitespace characters",
      )
      .refine((value) => value.length <= 1500, "description must be at most 1500 characters"),
    actions: z
      .record(z.string().regex(SERVER_ID_PATTERN), cliToolActionSchema)
      .refine(
        (actions) => Object.keys(actions).length > 0,
        "CLI tools backend must define at least one action",
      )
      .describe("Configured CLI actions keyed by stable tool name."),
    cwd: z.string().min(1).optional().describe("Default working directory for CLI actions."),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe("Default environment variables for CLI actions."),
    tags: z.array(z.string().trim().min(1).max(80)).optional(),
    exposure: exposureSchema.optional(),
    ...agentSelectionHintsSchema,
    setup: setupSchema.optional(),
    projectBinding: projectBindingSchema.optional(),
    runtime: runtimeRequirementsSchema.optional(),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .default(60_000)
      .describe("Default timeout in milliseconds for CLI actions."),
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .default(200_000)
      .describe("Default maximum combined stdout and stderr bytes to keep."),
    disabled: z.boolean().default(false).describe("When true, omit this CLI tools Caplet."),
  })
  .strict();

const normalizedCliToolsSchema = publicCliToolsSchema.extend({
  body: z.string().optional(),
});

const publicCapletSetSchema = z
  .object({
    name: z.string().trim().min(1).max(80).describe("Human-readable Caplet set display name."),
    description: z
      .string()
      .describe("Capability description shown before child Caplets are disclosed.")
      .refine(
        (value) => value.trim().length >= 10,
        "description must contain at least 10 non-whitespace characters",
      )
      .refine((value) => value.length <= 1500, "description must be at most 1500 characters"),
    configPath: z.string().min(1).optional().describe("Child Caplets config.json path."),
    capletsRoot: z.string().min(1).optional().describe("Child Markdown Caplets root directory."),
    defaultSearchLimit: z
      .number()
      .int()
      .positive()
      .default(20)
      .describe("Default maximum number of child Caplet search results."),
    maxSearchLimit: z
      .number()
      .int()
      .positive()
      .max(50)
      .default(50)
      .describe("Maximum accepted child Caplet search result limit."),
    toolCacheTtlMs: z
      .number()
      .int()
      .nonnegative()
      .default(30_000)
      .describe("Milliseconds child Caplet metadata stays fresh. Set 0 to refresh every time."),
    tags: z.array(z.string().trim().min(1).max(80)).optional(),
    exposure: exposureSchema.optional(),
    ...agentSelectionHintsSchema,
    setup: setupSchema.optional(),
    projectBinding: projectBindingSchema.optional(),
    runtime: runtimeRequirementsSchema.optional(),
    disabled: z.boolean().default(false).describe("When true, omit this Caplet set."),
  })
  .strict()
  .superRefine((set, ctx) => {
    if (!set.configPath && !set.capletsRoot) {
      ctx.addIssue({
        code: "custom",
        message: "Caplet set must define at least one source: configPath or capletsRoot",
      });
    }
    if (set.defaultSearchLimit > set.maxSearchLimit) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultSearchLimit"],
        message: "defaultSearchLimit must be <= maxSearchLimit",
      });
    }
  });

const normalizedCapletSetSchema = publicCapletSetSchema.extend({
  body: z.string().optional(),
});

type ConfigSchemaServerValue = z.infer<typeof normalizedServerSchema>;
type ConfigSchemaOpenApiEndpointValue = z.infer<typeof normalizedOpenApiEndpointSchema>;
type ConfigSchemaGraphQlEndpointValue = z.infer<typeof normalizedGraphQlEndpointSchema>;
type ConfigSchemaHttpApiValue = z.infer<typeof normalizedHttpApiSchema>;
type ConfigSchemaCliToolsValue = z.infer<typeof normalizedCliToolsSchema>;
type ConfigSchemaCapletSetValue = z.infer<typeof normalizedCapletSetSchema>;
type ConfigInput = {
  mcpServers?: Record<string, unknown>;
  openapiEndpoints?: Record<string, unknown>;
  graphqlEndpoints?: Record<string, unknown>;
  httpApis?: Record<string, unknown>;
  cliTools?: Record<string, unknown>;
  capletSets?: Record<string, unknown>;
  [key: string]: unknown;
};

function configSchemaFor(
  serverValueSchema: z.ZodTypeAny,
  openApiEndpointValueSchema: z.ZodTypeAny,
  graphQlEndpointValueSchema: z.ZodTypeAny,
  httpApiValueSchema: z.ZodTypeAny,
  cliToolsValueSchema: z.ZodTypeAny,
  capletSetValueSchema: z.ZodTypeAny,
) {
  return z
    .object({
      $schema: z
        .string()
        .url()
        .optional()
        .describe("Optional JSON Schema URL for editor validation."),
      version: z.literal(1).default(1).describe("Caplets config schema version."),
      defaultSearchLimit: z
        .number()
        .int()
        .positive()
        .default(20)
        .describe("Default maximum number of same-server search results."),
      maxSearchLimit: z
        .number()
        .int()
        .positive()
        .max(50)
        .default(50)
        .describe("Maximum accepted search_tools limit."),
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
        })
        .describe("Shell completion discovery timeout and cache settings."),
      options: z
        .object({
          exposure: exposureSchema.default("code_mode"),
          exposureDiscoveryTimeoutMs: z.number().int().positive().default(15_000),
          exposureDiscoveryConcurrency: z.number().int().positive().max(32).default(4),
        })
        .strict()
        .default({
          exposure: "code_mode",
          exposureDiscoveryTimeoutMs: 15_000,
          exposureDiscoveryConcurrency: 4,
        })
        .describe("Global Caplets runtime options."),
      mcpServers: z
        .record(z.string().regex(SERVER_ID_PATTERN), serverValueSchema)
        .default({})
        .describe("Downstream MCP servers keyed by stable server ID."),
      openapiEndpoints: z
        .record(z.string().regex(SERVER_ID_PATTERN), openApiEndpointValueSchema)
        .default({})
        .describe("OpenAPI endpoints keyed by stable Caplet ID."),
      graphqlEndpoints: z
        .record(z.string().regex(SERVER_ID_PATTERN), graphQlEndpointValueSchema)
        .default({})
        .describe("GraphQL endpoints keyed by stable Caplet ID."),
      httpApis: z
        .record(z.string().regex(SERVER_ID_PATTERN), httpApiValueSchema)
        .default({})
        .describe("HTTP APIs keyed by stable Caplet ID."),
      cliTools: z
        .record(z.string().regex(SERVER_ID_PATTERN), cliToolsValueSchema)
        .default({})
        .describe("CLI tools keyed by stable Caplet ID."),
      capletSets: z
        .record(z.string().regex(SERVER_ID_PATTERN), capletSetValueSchema)
        .default({})
        .describe("Nested Caplet collections keyed by stable Caplet ID."),
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

      for (const [server, rawValue] of Object.entries(config.mcpServers)) {
        const raw = rawValue as ConfigSchemaServerValue;
        if (!SERVER_ID_PATTERN.test(server)) {
          ctx.addIssue({
            code: "custom",
            path: ["mcpServers", server],
            message: "server ID must match ^[a-zA-Z0-9_-]{1,64}$",
          });
        }

        const effectiveTransport = raw.transport ?? (raw.command ? "stdio" : undefined);
        const hasStdio = Boolean(raw.command);
        const hasRemote = Boolean(raw.url);
        if (hasStdio === hasRemote) {
          ctx.addIssue({
            code: "custom",
            path: ["mcpServers", server],
            message: "server must define exactly one connection shape: command or url",
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

        if (raw.url && !isAllowedRemoteUrl(raw.url)) {
          ctx.addIssue({
            code: "custom",
            path: ["mcpServers", server, "url"],
            message: "remote url must use https except loopback development urls",
          });
        }

        if (raw.auth?.type === "headers") {
          for (const headerName of Object.keys(raw.auth.headers)) {
            const normalized = headerName.toLowerCase();
            if (!HEADER_NAME_PATTERN.test(headerName) || FORBIDDEN_HEADERS.has(normalized)) {
              ctx.addIssue({
                code: "custom",
                path: ["mcpServers", server, "auth", "headers", headerName],
                message: `header ${headerName} is not allowed`,
              });
            }
          }
        }
      }

      for (const [endpoint, rawValue] of Object.entries(config.openapiEndpoints)) {
        const raw = rawValue as ConfigSchemaOpenApiEndpointValue;
        if (config.mcpServers[endpoint]) {
          ctx.addIssue({
            code: "custom",
            path: ["openapiEndpoints", endpoint],
            message: `Caplet ID ${endpoint} is already used by mcpServers`,
          });
        }
        if (!SERVER_ID_PATTERN.test(endpoint)) {
          ctx.addIssue({
            code: "custom",
            path: ["openapiEndpoints", endpoint],
            message: "OpenAPI endpoint ID must match ^[a-zA-Z0-9_-]{1,64}$",
          });
        }
        if (Boolean(raw.specPath) === Boolean(raw.specUrl)) {
          ctx.addIssue({
            code: "custom",
            path: ["openapiEndpoints", endpoint],
            message: "OpenAPI endpoint must define exactly one spec source: specPath or specUrl",
          });
        }
        if (raw.specUrl && !isAllowedRemoteUrl(raw.specUrl)) {
          ctx.addIssue({
            code: "custom",
            path: ["openapiEndpoints", endpoint, "specUrl"],
            message: "OpenAPI specUrl must use https except loopback development urls",
          });
        }
        if (raw.baseUrl && !isAllowedRemoteUrl(raw.baseUrl)) {
          ctx.addIssue({
            code: "custom",
            path: ["openapiEndpoints", endpoint, "baseUrl"],
            message: "OpenAPI baseUrl must use https except loopback development urls",
          });
        }
        if (raw.auth?.type === "headers") {
          for (const headerName of Object.keys(raw.auth.headers)) {
            const normalized = headerName.toLowerCase();
            if (!HEADER_NAME_PATTERN.test(headerName) || FORBIDDEN_HEADERS.has(normalized)) {
              ctx.addIssue({
                code: "custom",
                path: ["openapiEndpoints", endpoint, "auth", "headers", headerName],
                message: `header ${headerName} is not allowed`,
              });
            }
          }
        }
      }

      for (const [endpoint, rawValue] of Object.entries(config.graphqlEndpoints)) {
        const raw = rawValue as ConfigSchemaGraphQlEndpointValue;
        const duplicateBackend = config.mcpServers[endpoint]
          ? "mcpServers"
          : config.openapiEndpoints[endpoint]
            ? "openapiEndpoints"
            : undefined;
        if (duplicateBackend) {
          ctx.addIssue({
            code: "custom",
            path: ["graphqlEndpoints", endpoint],
            message: `Caplet ID ${endpoint} is already used by ${duplicateBackend}`,
          });
        }
        if (!SERVER_ID_PATTERN.test(endpoint)) {
          ctx.addIssue({
            code: "custom",
            path: ["graphqlEndpoints", endpoint],
            message: "GraphQL endpoint ID must match ^[a-zA-Z0-9_-]{1,64}$",
          });
        }
        const sourceCount =
          Number(Boolean(raw.schemaPath)) +
          Number(Boolean(raw.schemaUrl)) +
          Number(raw.introspection === true);
        if (sourceCount !== 1) {
          ctx.addIssue({
            code: "custom",
            path: ["graphqlEndpoints", endpoint],
            message:
              "GraphQL endpoint must define exactly one schema source: schemaPath, schemaUrl, or introspection",
          });
        }
        if (raw.endpointUrl && !isAllowedRemoteUrl(raw.endpointUrl)) {
          ctx.addIssue({
            code: "custom",
            path: ["graphqlEndpoints", endpoint, "endpointUrl"],
            message: "GraphQL endpointUrl must use https except loopback development urls",
          });
        }
        if (raw.schemaUrl && !isAllowedRemoteUrl(raw.schemaUrl)) {
          ctx.addIssue({
            code: "custom",
            path: ["graphqlEndpoints", endpoint, "schemaUrl"],
            message: "GraphQL schemaUrl must use https except loopback development urls",
          });
        }
        validateEndpointAuthHeaders(raw.auth, ctx, ["graphqlEndpoints", endpoint, "auth"]);
      }

      for (const [endpoint, rawValue] of Object.entries(config.httpApis)) {
        const raw = rawValue as ConfigSchemaHttpApiValue;
        const duplicateBackend = config.mcpServers[endpoint]
          ? "mcpServers"
          : config.openapiEndpoints[endpoint]
            ? "openapiEndpoints"
            : config.graphqlEndpoints[endpoint]
              ? "graphqlEndpoints"
              : undefined;
        if (duplicateBackend) {
          ctx.addIssue({
            code: "custom",
            path: ["httpApis", endpoint],
            message: `Caplet ID ${endpoint} is already used by ${duplicateBackend}`,
          });
        }
        if (!SERVER_ID_PATTERN.test(endpoint)) {
          ctx.addIssue({
            code: "custom",
            path: ["httpApis", endpoint],
            message: "HTTP API ID must match ^[a-zA-Z0-9_-]{1,64}$",
          });
        }
        if (raw.baseUrl && !isAllowedHttpBaseUrl(raw.baseUrl)) {
          ctx.addIssue({
            code: "custom",
            path: ["httpApis", endpoint, "baseUrl"],
            message:
              "HTTP API baseUrl must use https except loopback development urls and must not include credentials, query, or fragment",
          });
        }
        validateEndpointAuthHeaders(raw.auth, ctx, ["httpApis", endpoint, "auth"]);
        for (const [actionName, action] of Object.entries(raw.actions)) {
          if (action.headers) {
            validateHttpActionHeaders(action.headers, ctx, [
              "httpApis",
              endpoint,
              "actions",
              actionName,
              "headers",
            ]);
          }
        }
      }

      for (const [server, rawValue] of Object.entries(config.cliTools)) {
        const raw = rawValue as ConfigSchemaCliToolsValue;
        const duplicateBackend = config.mcpServers[server]
          ? "mcpServers"
          : config.openapiEndpoints[server]
            ? "openapiEndpoints"
            : config.graphqlEndpoints[server]
              ? "graphqlEndpoints"
              : config.httpApis[server]
                ? "httpApis"
                : undefined;
        if (duplicateBackend) {
          ctx.addIssue({
            code: "custom",
            path: ["cliTools", server],
            message: `Caplet ID ${server} is already used by ${duplicateBackend}`,
          });
        }
        if (!SERVER_ID_PATTERN.test(server)) {
          ctx.addIssue({
            code: "custom",
            path: ["cliTools", server],
            message: "CLI tools ID must match ^[a-zA-Z0-9_-]{1,64}$",
          });
        }
        for (const actionName of Object.keys(raw.actions)) {
          if (!SERVER_ID_PATTERN.test(actionName)) {
            ctx.addIssue({
              code: "custom",
              path: ["cliTools", server, "actions", actionName],
              message: "CLI action ID must match ^[a-zA-Z0-9_-]{1,64}$",
            });
          }
        }
      }

      for (const [server, rawValue] of Object.entries(config.capletSets)) {
        const raw = rawValue as ConfigSchemaCapletSetValue;
        const duplicateBackend = config.mcpServers[server]
          ? "mcpServers"
          : config.openapiEndpoints[server]
            ? "openapiEndpoints"
            : config.graphqlEndpoints[server]
              ? "graphqlEndpoints"
              : config.httpApis[server]
                ? "httpApis"
                : config.cliTools[server]
                  ? "cliTools"
                  : undefined;
        if (duplicateBackend) {
          ctx.addIssue({
            code: "custom",
            path: ["capletSets", server],
            message: `Caplet ID ${server} is already used by ${duplicateBackend}`,
          });
        }
        if (!SERVER_ID_PATTERN.test(server)) {
          ctx.addIssue({
            code: "custom",
            path: ["capletSets", server],
            message: "Caplet set ID must match ^[a-zA-Z0-9_-]{1,64}$",
          });
        }
        if (!raw.configPath && !raw.capletsRoot) {
          ctx.addIssue({
            code: "custom",
            path: ["capletSets", server],
            message: "Caplet set must define at least one source: configPath or capletsRoot",
          });
        }
      }
    });
}

export const configFileSchema = configSchemaFor(
  publicServerSchema,
  publicOpenApiEndpointSchema,
  publicGraphQlEndpointSchema,
  publicHttpApiSchema,
  publicCliToolsSchema,
  publicCapletSetSchema,
);
const normalizedConfigFileSchema = configSchemaFor(
  normalizedServerSchema,
  normalizedOpenApiEndpointSchema,
  normalizedGraphQlEndpointSchema,
  normalizedHttpApiSchema,
  normalizedCliToolsSchema,
  normalizedCapletSetSchema,
);

export function configJsonSchema(): unknown {
  return patchConfigJsonSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplets-config.schema.json",
    title: "Caplets config",
    description: "Configuration file for the Caplets progressive MCP disclosure gateway.",
    ...z.toJSONSchema(configFileSchema, { io: "input" }),
  });
}

export function loadConfig(
  path = resolveConfigPath(),
  projectPath = resolveProjectConfigPath(),
): CapletsConfig {
  return loadConfigWithSources(path, projectPath).config;
}

export function loadConfigWithSources(
  path = resolveConfigPath(),
  projectPath = resolveProjectConfigPath(),
): ConfigWithSources {
  const hasUserConfig = existsSync(path);
  const hasProjectConfig = existsSync(projectPath);
  const userConfig = hasUserConfig ? readPublicConfigInput(path) : undefined;
  const userCaplets = loadCapletFilesWithPaths(resolveCapletsRoot(path));
  const projectConfig = hasProjectConfig
    ? rejectProjectConfigExecutableBackendMaps(readPublicConfigInput(projectPath), projectPath)
    : undefined;
  const projectCapletsRoot = resolveProjectCapletsRootForConfigPath(projectPath);
  const projectCaplets = projectCapletsRoot
    ? loadCapletFilesWithPaths(projectCapletsRoot)
    : undefined;

  return buildConfigWithSources(
    [
      { input: userConfig, source: { kind: "global-config", path } },
      userCaplets
        ? { input: userCaplets.config, source: { kind: "global-file", path: userCaplets.paths } }
        : undefined,
      { input: projectConfig, source: { kind: "project-config", path: projectPath } },
      projectCaplets
        ? {
            input: projectCaplets.config,
            source: { kind: "project-file", path: projectCaplets.paths },
          }
        : undefined,
    ],
    `Caplets config not found at ${path} or ${projectPath}`,
    "Caplets config must define at least one MCP server, OpenAPI endpoint, GraphQL endpoint, HTTP API, CLI tools backend, or Caplet set",
  );
}

export function loadGlobalConfig(path = resolveConfigPath()): CapletsConfig {
  const userConfig = existsSync(path) ? readPublicConfigInput(path) : undefined;
  const userCaplets = loadCapletFilesWithPaths(resolveCapletsRoot(path));

  return buildConfigWithSources(
    [
      { input: userConfig, source: { kind: "global-config", path } },
      userCaplets
        ? { input: userCaplets.config, source: { kind: "global-file", path: userCaplets.paths } }
        : undefined,
    ],
    `Caplets user config not found at ${path}`,
    undefined,
  ).config;
}

export function loadProjectConfig(projectPath = resolveProjectConfigPath()): CapletsConfig {
  const projectConfig = existsSync(projectPath)
    ? rejectProjectConfigExecutableBackendMaps(readPublicConfigInput(projectPath), projectPath)
    : undefined;
  const projectCapletsRoot = resolveProjectCapletsRootForConfigPath(projectPath);
  const projectCaplets = projectCapletsRoot
    ? loadCapletFilesWithPaths(projectCapletsRoot)
    : undefined;

  return buildConfigWithSources(
    [
      { input: projectConfig, source: { kind: "project-config", path: projectPath } },
      projectCaplets
        ? {
            input: projectCaplets.config,
            source: { kind: "project-file", path: projectCaplets.paths },
          }
        : undefined,
    ],
    `Caplets project config not found at ${projectPath}`,
    undefined,
  ).config;
}

function buildConfigWithSources(
  inputs: Array<ConfigInputWithSource | undefined>,
  notFoundMessage: string,
  emptyMessage: string | undefined,
): ConfigWithSources {
  if (!inputs.some((entry) => entry?.input !== undefined)) {
    throw new CapletsError("CONFIG_NOT_FOUND", notFoundMessage);
  }

  try {
    const { input, sources, shadows } = mergeConfigInputsWithSources(...inputs);
    const config = parseConfig(input);
    if (
      emptyMessage &&
      Object.keys(config.mcpServers).length === 0 &&
      Object.keys(config.openapiEndpoints).length === 0 &&
      Object.keys(config.graphqlEndpoints).length === 0 &&
      Object.keys(config.httpApis).length === 0 &&
      Object.keys(config.cliTools).length === 0 &&
      Object.keys(config.capletSets).length === 0
    ) {
      throw new CapletsError("CONFIG_INVALID", emptyMessage);
    }
    return { config, sources, shadows };
  } catch (error) {
    if (error instanceof CapletsError) {
      throw error;
    }
    throw new CapletsError(
      "CONFIG_INVALID",
      "Caplets config is not valid JSON",
      redactSecrets(error),
    );
  }
}

export function loadLocalOverlayConfigWithSources(
  path = resolveConfigPath(),
  projectPath = resolveProjectConfigPath(),
): LocalOverlayConfigWithSources {
  const warnings: LocalOverlayConfigWarning[] = [];
  const userConfig = existsSync(path)
    ? readBestEffortConfigInput(path, "global-config", warnings)
    : undefined;
  const userCaplets = loadBestEffortCapletFiles(resolveCapletsRoot(path), "global-file", warnings);
  const projectConfig = existsSync(projectPath)
    ? readBestEffortConfigInput(projectPath, "project-config", warnings, (input) =>
        rejectProjectConfigExecutableBackendMaps(input, projectPath),
      )
    : undefined;
  const projectCapletsRoot = resolveProjectCapletsRootForConfigPath(projectPath);
  const projectCaplets = projectCapletsRoot
    ? loadBestEffortCapletFiles(projectCapletsRoot, "project-file", warnings)
    : undefined;

  const { input, sources, shadows } = mergeConfigInputsWithSources(
    { input: userConfig, source: { kind: "global-config", path } },
    userCaplets
      ? { input: userCaplets.config, source: { kind: "global-file", path: userCaplets.paths } }
      : undefined,
    { input: projectConfig, source: { kind: "project-config", path: projectPath } },
    projectCaplets
      ? {
          input: projectCaplets.config,
          source: { kind: "project-file", path: projectCaplets.paths },
        }
      : undefined,
  );

  return { config: parseConfig(input), sources, shadows, warnings };
}

function readBestEffortConfigInput(
  path: string,
  kind: ConfigSourceKind,
  warnings: LocalOverlayConfigWarning[],
  transform?: (input: ConfigInput) => ConfigInput,
): ConfigInput | undefined {
  try {
    const input = readPublicConfigInput(path);
    return transform ? transform(input) : input;
  } catch (error) {
    warnings.push({ kind, path, message: errorMessage(error) });
    return undefined;
  }
}

function loadBestEffortCapletFiles(
  root: string,
  kind: ConfigSourceKind,
  warnings: LocalOverlayConfigWarning[],
): { config: ConfigInput; paths: Record<string, string> } | undefined {
  const result = loadCapletFilesWithPathsBestEffort(root);
  if (!result) {
    return undefined;
  }
  for (const warning of result.warnings) {
    warnings.push({ kind, path: warning.path ?? root, message: warning.message });
  }
  return { config: result.config, paths: result.paths };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ConfigSourceInput =
  | { kind: ConfigSourceKind; path: string }
  | { kind: ConfigSourceKind; path: Record<string, string> };

type ConfigInputWithSource = {
  input: ConfigInput | undefined;
  source: ConfigSourceInput;
};

export function loadIsolatedConfig(options: {
  configPath?: string;
  capletsRoot?: string;
  defaultSearchLimit: number;
  maxSearchLimit: number;
}): CapletsConfig {
  if (!options.configPath && !options.capletsRoot) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Nested Caplet set must define at least one source: configPath or capletsRoot",
    );
  }

  const configInput = options.configPath ? readPublicConfigInput(options.configPath) : undefined;
  const capletInput = options.capletsRoot ? loadCapletFiles(options.capletsRoot) : undefined;
  if (!configInput && !capletInput) {
    throw new CapletsError(
      "CONFIG_NOT_FOUND",
      `Nested Caplet set sources not found: ${[options.configPath, options.capletsRoot].filter(Boolean).join(", ")}`,
    );
  }

  const config = parseConfig(
    mergeConfigInputs(configInput, capletInput, {
      version: 1,
      defaultSearchLimit: options.defaultSearchLimit,
      maxSearchLimit: options.maxSearchLimit,
    }),
  );
  if (
    Object.keys(config.mcpServers).length === 0 &&
    Object.keys(config.openapiEndpoints).length === 0 &&
    Object.keys(config.graphqlEndpoints).length === 0 &&
    Object.keys(config.httpApis).length === 0 &&
    Object.keys(config.cliTools).length === 0 &&
    Object.keys(config.capletSets).length === 0
  ) {
    throw new CapletsError("CONFIG_INVALID", "Nested Caplet set must define at least one Caplet");
  }
  return config;
}

function resolveProjectCapletsRootForConfigPath(projectPath: string): string | undefined {
  const root = dirname(projectPath);
  return basename(root) === ".caplets" && basename(projectPath) === "config.json"
    ? root
    : undefined;
}

function readPublicConfigInput(path: string): ConfigInput {
  try {
    const input = JSON.parse(readFileSync(path, "utf8"));
    const normalized = normalizeLocalPaths(input as ConfigInput, dirname(path));
    const parsed = configFileSchema.safeParse(interpolateConfig(normalized));
    if (!parsed.success) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Caplets config at ${path} is invalid`,
        parsed.error.issues,
      );
    }
    return normalized;
  } catch (error) {
    if (error instanceof CapletsError) {
      throw error;
    }
    throw new CapletsError(
      "CONFIG_INVALID",
      `Caplets config at ${path} is not valid JSON`,
      redactSecrets(error),
    );
  }
}

function normalizeLocalPaths(input: ConfigInput, baseDir: string): ConfigInput {
  return stripUndefined({
    ...input,
    openapiEndpoints: normalizeEndpointPaths(input.openapiEndpoints, baseDir, normalizeOpenApiPath),
    graphqlEndpoints: normalizeEndpointPaths(input.graphqlEndpoints, baseDir, normalizeGraphQlPath),
    cliTools: normalizeEndpointPaths(input.cliTools, baseDir, normalizeCliToolsPaths),
    capletSets: normalizeEndpointPaths(input.capletSets, baseDir, normalizeCapletSetPaths),
  }) as ConfigInput;
}

function normalizeEndpointPaths(
  endpoints: Record<string, unknown> | undefined,
  baseDir: string,
  normalize: (endpoint: Record<string, unknown>, baseDir: string) => Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!endpoints) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(endpoints).map(([id, endpoint]) => [
      id,
      isPlainObject(endpoint) ? normalize(endpoint, baseDir) : endpoint,
    ]),
  );
}

function normalizeOpenApiPath(
  endpoint: Record<string, unknown>,
  baseDir: string,
): Record<string, unknown> {
  return {
    ...endpoint,
    specPath: normalizeLocalPath(endpoint.specPath, baseDir),
  };
}

function normalizeGraphQlPath(
  endpoint: Record<string, unknown>,
  baseDir: string,
): Record<string, unknown> {
  const operations = isPlainObject(endpoint.operations)
    ? Object.fromEntries(
        Object.entries(endpoint.operations).map(([name, operation]) => [
          name,
          isPlainObject(operation)
            ? {
                ...operation,
                documentPath: normalizeLocalPath(operation.documentPath, baseDir),
              }
            : operation,
        ]),
      )
    : endpoint.operations;
  return {
    ...endpoint,
    schemaPath: normalizeLocalPath(endpoint.schemaPath, baseDir),
    operations,
  };
}

function normalizeCliToolsPaths(
  endpoint: Record<string, unknown>,
  baseDir: string,
): Record<string, unknown> {
  const actions = isPlainObject(endpoint.actions)
    ? Object.fromEntries(
        Object.entries(endpoint.actions).map(([name, action]) => [
          name,
          isPlainObject(action)
            ? {
                ...action,
                cwd: normalizeLocalPath(action.cwd, baseDir),
              }
            : action,
        ]),
      )
    : endpoint.actions;
  return {
    ...endpoint,
    cwd: normalizeLocalPath(endpoint.cwd, baseDir),
    actions,
  };
}

function normalizeCapletSetPaths(
  endpoint: Record<string, unknown>,
  baseDir: string,
): Record<string, unknown> {
  return {
    ...endpoint,
    configPath: normalizeLocalPath(endpoint.configPath, baseDir),
    capletsRoot: normalizeLocalPath(endpoint.capletsRoot, baseDir),
  };
}

function normalizeLocalPath(value: unknown, baseDir: string): unknown {
  if (typeof value !== "string" || !value || isAbsolute(value) || hasEnvReference(value)) {
    return value;
  }
  return join(baseDir, value);
}

function rejectProjectConfigExecutableBackendMaps(input: ConfigInput, path: string): ConfigInput {
  if (input.openapiEndpoints && Object.keys(input.openapiEndpoints).length > 0) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Project config at ${path} cannot define executable backend map openapiEndpoints; use project Markdown Caplet files or user config instead`,
    );
  }
  if (input.graphqlEndpoints && Object.keys(input.graphqlEndpoints).length > 0) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Project config at ${path} cannot define executable backend map graphqlEndpoints; use project Markdown Caplet files or user config instead`,
    );
  }
  if (input.httpApis && Object.keys(input.httpApis).length > 0) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Project config at ${path} cannot define executable backend map httpApis; use project Markdown Caplet files or user config instead`,
    );
  }
  if (input.cliTools && Object.keys(input.cliTools).length > 0) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Project config at ${path} cannot define executable backend map cliTools; use project Markdown Caplet files or user config instead`,
    );
  }
  if (input.capletSets && Object.keys(input.capletSets).length > 0) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Project config at ${path} cannot define executable backend map capletSets; use project Markdown Caplet files or user config instead`,
    );
  }
  return input;
}

function mergeConfigInputs(...inputs: Array<ConfigInput | undefined>): ConfigInput | undefined {
  let merged: ConfigInput | undefined;
  for (const input of inputs) {
    if (input === undefined) {
      continue;
    }
    merged = {
      ...merged,
      ...input,
      mcpServers: {
        ...merged?.mcpServers,
        ...input.mcpServers,
      },
      openapiEndpoints: {
        ...merged?.openapiEndpoints,
        ...input.openapiEndpoints,
      },
      graphqlEndpoints: {
        ...merged?.graphqlEndpoints,
        ...input.graphqlEndpoints,
      },
      httpApis: {
        ...merged?.httpApis,
        ...input.httpApis,
      },
      cliTools: {
        ...merged?.cliTools,
        ...input.cliTools,
      },
      capletSets: {
        ...merged?.capletSets,
        ...input.capletSets,
      },
    };
  }
  return merged;
}

function mergeConfigInputsWithSources(...inputs: Array<ConfigInputWithSource | undefined>): {
  input: ConfigInput;
  sources: Record<string, ConfigSource>;
  shadows: Record<string, ConfigSource[]>;
} {
  let merged: ConfigInput = {};
  const sources: Record<string, ConfigSource> = {};
  const shadows: Record<string, ConfigSource[]> = {};

  for (const entry of inputs) {
    if (entry?.input === undefined) {
      continue;
    }
    for (const id of capletIds(entry.input)) {
      const source = sourceForId(entry.source, id);
      if (sources[id]) {
        shadows[id] = [...(shadows[id] ?? []), sources[id]];
      }
      sources[id] = source;
      merged = removeCapletId(merged, id);
    }
    merged = mergeConfigInputs(merged, entry.input) ?? {};
  }

  return { input: merged, sources, shadows };
}

function removeCapletId(input: ConfigInput, id: string): ConfigInput {
  const { [id]: _mcpServer, ...mcpServers } = input.mcpServers ?? {};
  const { [id]: _openapiEndpoint, ...openapiEndpoints } = input.openapiEndpoints ?? {};
  const { [id]: _graphqlEndpoint, ...graphqlEndpoints } = input.graphqlEndpoints ?? {};
  const { [id]: _httpApi, ...httpApis } = input.httpApis ?? {};
  const { [id]: _cliTools, ...cliTools } = input.cliTools ?? {};
  const { [id]: _capletSet, ...capletSets } = input.capletSets ?? {};

  return {
    ...input,
    mcpServers,
    openapiEndpoints,
    graphqlEndpoints,
    httpApis,
    cliTools,
    capletSets,
  };
}

function capletIds(input: ConfigInput): string[] {
  return [
    ...Object.keys(input.mcpServers ?? {}),
    ...Object.keys(input.openapiEndpoints ?? {}),
    ...Object.keys(input.graphqlEndpoints ?? {}),
    ...Object.keys(input.httpApis ?? {}),
    ...Object.keys(input.cliTools ?? {}),
    ...Object.keys(input.capletSets ?? {}),
  ];
}

function sourceForId(source: ConfigSourceInput, id: string): ConfigSource {
  return {
    kind: source.kind,
    path: typeof source.path === "string" ? source.path : (source.path[id] ?? ""),
  };
}

export function parseConfig(input: unknown): CapletsConfig {
  const parsed = normalizedConfigFileSchema.safeParse(interpolateConfig(input));
  if (!parsed.success) {
    throw new CapletsError("CONFIG_INVALID", "Caplets config is invalid", parsed.error.issues);
  }

  const servers: Record<string, CapletServerConfig> = {};
  for (const [server, raw] of Object.entries(parsed.data.mcpServers)) {
    const interpolated = raw as ConfigSchemaServerValue;
    servers[server] = stripUndefined({
      ...interpolated,
      server,
      backend: "mcp",
      transport: interpolated.transport ?? (interpolated.command ? "stdio" : "http"),
    }) as CapletServerConfig;
  }

  const openapiEndpoints: Record<string, OpenApiEndpointConfig> = {};
  for (const [server, raw] of Object.entries(parsed.data.openapiEndpoints)) {
    const interpolated = raw as ConfigSchemaOpenApiEndpointValue;
    openapiEndpoints[server] = stripUndefined({
      ...interpolated,
      server,
      backend: "openapi",
    }) as OpenApiEndpointConfig;
  }

  const graphqlEndpoints: Record<string, GraphQlEndpointConfig> = {};
  for (const [server, raw] of Object.entries(parsed.data.graphqlEndpoints)) {
    const interpolated = raw as ConfigSchemaGraphQlEndpointValue;
    graphqlEndpoints[server] = stripUndefined({
      ...interpolated,
      server,
      backend: "graphql",
    }) as GraphQlEndpointConfig;
  }

  const httpApis: Record<string, HttpApiConfig> = {};
  for (const [server, raw] of Object.entries(parsed.data.httpApis)) {
    const interpolated = raw as ConfigSchemaHttpApiValue;
    httpApis[server] = stripUndefined({
      ...interpolated,
      server,
      backend: "http",
    }) as HttpApiConfig;
  }

  const cliTools: Record<string, CliToolsConfig> = {};
  for (const [server, raw] of Object.entries(parsed.data.cliTools)) {
    const interpolated = raw as ConfigSchemaCliToolsValue;
    cliTools[server] = stripUndefined({
      ...interpolated,
      server,
      backend: "cli",
    }) as CliToolsConfig;
  }

  const capletSets: Record<string, CapletSetConfig> = {};
  for (const [server, raw] of Object.entries(parsed.data.capletSets)) {
    const interpolated = raw as ConfigSchemaCapletSetValue;
    capletSets[server] = stripUndefined({
      ...interpolated,
      server,
      backend: "caplets",
    }) as CapletSetConfig;
  }

  return {
    version: parsed.data.version,
    options: {
      defaultSearchLimit: parsed.data.defaultSearchLimit,
      maxSearchLimit: parsed.data.maxSearchLimit,
      exposure: parsed.data.options.exposure,
      exposureDiscoveryTimeoutMs: parsed.data.options.exposureDiscoveryTimeoutMs,
      exposureDiscoveryConcurrency: parsed.data.options.exposureDiscoveryConcurrency,
      completion: parsed.data.completion,
    },
    mcpServers: servers,
    openapiEndpoints,
    graphqlEndpoints,
    httpApis,
    cliTools,
    capletSets,
  };
}

function validateEndpointAuthHeaders(
  auth: OpenApiAuthConfig | undefined,
  ctx: z.RefinementCtx,
  path: Array<string>,
): void {
  if (auth?.type !== "headers") {
    return;
  }
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

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, nested]) => nested !== undefined),
  ) as T;
}

function interpolateConfig<T>(value: T, path: string[] = []): T {
  if (isPublicMetadataPath(path)) {
    return value;
  }
  if (typeof value === "string") {
    return interpolateEnv(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => interpolateConfig(item, [...path, String(index)])) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nested]) => [
        nestedKey,
        interpolateConfig(nested, [...path, nestedKey]),
      ]),
    ) as T;
  }
  return value;
}

function isPublicMetadataPath(path: string[]): boolean {
  if (
    path.length < 3 ||
    (path[0] !== "mcpServers" &&
      path[0] !== "openapiEndpoints" &&
      path[0] !== "graphqlEndpoints" &&
      path[0] !== "httpApis" &&
      path[0] !== "cliTools" &&
      path[0] !== "capletSets")
  ) {
    return false;
  }
  return NON_INTERPOLATED_SERVER_FIELDS.has(path[2] ?? "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasEnvReference(value: string): boolean {
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$env:[A-Za-z_][A-Za-z0-9_]*/.test(value);
}

function patchConfigJsonSchema<T>(schema: T): T {
  const httpApiProperties = schemaPath<Record<string, unknown>>(schema, [
    "properties",
    "httpApis",
    "additionalProperties",
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
    "additionalProperties",
    "properties",
  ]);
  const cliActions = nestedSchema<Record<string, unknown>>(cliToolsProperties, "actions");
  if (cliActions) {
    cliActions.minProperties = 1;
  }
  return schema;
}

export function interpolateEnv(value: string): string {
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => process.env[name] ?? "");
}
