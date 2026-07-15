import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  loadCapletFilesFromMap,
  loadCapletFilesWithPaths,
  loadCapletFilesWithPathsBestEffort,
} from "./caplet-files";
import { FilesystemCapletSource } from "./caplet-source/filesystem";
import {
  createRuntimeFingerprintSnapshot,
  type DeclaredInputReader,
  type RuntimeFingerprintProvenance,
  type RuntimeFingerprintSnapshot,
} from "./caplet-source/runtime-fingerprint";
import {
  parseConfig as parseRuntimeTemplateConfig,
  type CapletConfig as RuntimeTemplateCapletConfig,
  type CapletsConfig as RuntimeTemplateConfig,
} from "./config-runtime";
import {
  defaultConfigPath,
  resolveCapletsRoot,
  resolveConfigPath,
  resolveProjectConfigPath,
} from "./config/paths";
import {
  FORBIDDEN_HEADERS,
  HEADER_NAME_PATTERN,
  HTTP_BASE_URL_PATTERN,
  NAMESPACE_ALIAS_LABEL_PATTERN,
  SERVER_ID_PATTERN,
  isAllowedHttpBaseUrl,
  isAllowedRemoteUrl,
  isVerifiedHttpsBaseUrl,
  isUrl,
  validateHttpActionHeaders,
} from "./config/validation";
import { CapletsError, redactSecrets } from "./errors";
import { nestedSchema, schemaPath } from "./schema-utils";
import { FileVaultStore, validateVaultKeyName, type VaultConfigOrigin } from "./vault";

export {
  DEFAULT_AUTH_DIR,
  DEFAULT_CAPLETS_LOCKFILE_PATH,
  DEFAULT_COMPLETION_CACHE_DIR,
  DEFAULT_CONFIG_PATH,
  DEFAULT_UPDATE_CHECK_CACHE_DIR,
  DEFAULT_UPDATE_CHECK_STATE_DIR,
  DEFAULT_TELEMETRY_STATE_DIR,
  PROJECT_CONFIG_FILE,
  defaultCacheBaseDir,
  defaultCapletsLockfilePath,
  defaultCompletionCacheDir,
  defaultStorageArtifactDir,
  defaultStorageDatabasePath,
  defaultStorageKeyProviderManifestPath,
  defaultStorageStateDir,
  defaultTelemetryStateDir,
  defaultUpdateCheckCacheDir,
  defaultUpdateCheckStateDir,
  resolveCapletsLockfilePath,
  resolveCapletsRoot,
  resolveConfigPath,
  resolveProjectCapletsRoot,
  resolveProjectConfigPath,
  resolveProjectLockfilePath,
  resolveTelemetryStateDir,
  resolveUpdateCheckCacheDir,
  resolveUpdateCheckStateDir,
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

export type CapletShadowingPolicy = "forbid" | "allow" | "namespace";

export type CapletExposure =
  | "direct"
  | "progressive"
  | "code_mode"
  | "direct_and_code_mode"
  | "progressive_and_code_mode";

export type CapletServerConfig = {
  server: string;
  backend: "mcp";
  name: string;
  description: string;
  exposure?: CapletExposure | undefined;
  shadowing?: CapletShadowingPolicy | undefined;
  tags?: string[] | undefined;
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

export type OpenApiEndpointConfig = {
  server: string;
  backend: "openapi";
  name: string;
  description: string;
  exposure?: CapletExposure | undefined;
  shadowing?: CapletShadowingPolicy | undefined;
  tags?: string[] | undefined;
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

export type GraphQlOperationConfig = {
  document?: string | undefined;
  documentPath?: string | undefined;
  operationName?: string | undefined;
  description?: string | undefined;
};

export type GraphQlEndpointConfig = {
  server: string;
  backend: "graphql";
  name: string;
  description: string;
  exposure?: CapletExposure | undefined;
  shadowing?: CapletShadowingPolicy | undefined;
  tags?: string[] | undefined;
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

export type HttpActionConfig = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  description?: string | undefined;
  inputSchema?: Record<string, unknown> | undefined;
  outputSchema?: Record<string, unknown> | undefined;
  query?: Record<string, string | number | boolean> | undefined;
  headers?: Record<string, string | number | boolean> | undefined;
  jsonBody?: unknown;
};

export type HttpApiConfig = {
  server: string;
  backend: "http";
  name: string;
  description: string;
  exposure?: CapletExposure | undefined;
  shadowing?: CapletShadowingPolicy | undefined;
  tags?: string[] | undefined;
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

export type GoogleDiscoveryApiConfig = {
  server: string;
  backend: "googleDiscovery";
  name: string;
  description: string;
  exposure?: CapletExposure | undefined;
  shadowing?: CapletShadowingPolicy | undefined;
  tags?: string[] | undefined;
  discoveryPath?: string | undefined;
  discoveryUrl?: string | undefined;
  baseUrl?: string | undefined;
  includeOperations?: string[] | undefined;
  excludeOperations?: string[] | undefined;
  auth: OpenApiAuthConfig;
  requestTimeoutMs: number;
  operationCacheTtlMs: number;
  disabled: boolean;
  setup?: CapletSetupConfig | undefined;
  projectBinding?: ProjectBindingConfig | undefined;
  runtime?: RuntimeRequirementsConfig | undefined;
};

export type CliToolOutputConfig = {
  type: "text" | "json";
};

export type CliToolActionConfig = {
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

export type CliToolsConfig = {
  server: string;
  backend: "cli";
  name: string;
  description: string;
  exposure?: CapletExposure | undefined;
  shadowing?: CapletShadowingPolicy | undefined;
  tags?: string[] | undefined;
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

export type CapletSetConfig = {
  server: string;
  backend: "caplets";
  name: string;
  description: string;
  exposure?: CapletExposure | undefined;
  shadowing?: CapletShadowingPolicy | undefined;
  tags?: string[] | undefined;
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
  | GoogleDiscoveryApiConfig
  | GraphQlEndpointConfig
  | HttpApiConfig
  | CliToolsConfig
  | CapletSetConfig;

export type NamespaceAliasesConfig = {
  local?: string | undefined;
  upstreams: Record<string, string>;
};

export type CapletsOptions = {
  defaultSearchLimit: number;
  maxSearchLimit: number;
  exposure: CapletExposure;
  exposureDiscoveryTimeoutMs: number;
  exposureDiscoveryConcurrency: number;
  completion: CompletionConfig;
};

export type DeploymentSecretReference =
  | { kind: "env"; name: string }
  | { kind: "file"; path: string };

export type FilesystemArtifactStorageConfig = {
  kind: "filesystem";
  root: string;
};

export type S3ArtifactStorageConfig = {
  kind: "s3";
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  canary: DeploymentSecretReference;
  credentials: {
    accessKeyId: DeploymentSecretReference;
    secretAccessKey: DeploymentSecretReference;
  };
};

export type SqliteStorageConfig = {
  kind: "sqlite";
  stateRoot?: string | undefined;
  databasePath?: string | undefined;
  keyProviderManifest?: string | undefined;
  artifacts?: FilesystemArtifactStorageConfig | undefined;
};

export type PostgresProcessRole = "online" | "migrator" | "maintenance";

export type PostgresRoleCredentialConfig = {
  role: string;
  credential: DeploymentSecretReference;
};

export type PostgresStorageConfig = {
  kind: "postgres";
  stateRoot: string;
  logicalHostId: string;
  expectedStoreId: string;
  processRole: PostgresProcessRole;
  connection: {
    tls: {
      mode: "verify-full";
      serverName: string;
      ca?: DeploymentSecretReference | undefined;
    };
    roles: {
      runtime: PostgresRoleCredentialConfig;
      migrator: PostgresRoleCredentialConfig;
      maintenance: PostgresRoleCredentialConfig;
    };
  };
  keyProviderManifest: string;
  artifacts: S3ArtifactStorageConfig;
  migration: { designated: boolean };
  retention: { backupDays: number };
};

export type ServeStorageConfig = SqliteStorageConfig | PostgresStorageConfig;

export type ServeConfig = {
  host?: string | undefined;
  port?: number | undefined;
  path?: string | undefined;
  remoteStatePath?: string | undefined;
  upstreamUrl?: string | undefined;
  allowUnauthenticatedHttp?: boolean | undefined;
  trustProxy?: boolean | undefined;
  publicOrigins: string[];
  storage?: ServeStorageConfig | undefined;
};

export type CompletionConfig = {
  discoveryTimeoutMs: number;
  overallTimeoutMs: number;
  cacheTtlMs: number;
  negativeCacheTtlMs: number;
};

export type CapletsConfig = {
  version: 1;
  telemetry?: boolean | undefined;
  serve?: ServeConfig | undefined;
  options: CapletsOptions;
  namespaceAliases: NamespaceAliasesConfig;
  mcpServers: Record<string, CapletServerConfig>;
  openapiEndpoints: Record<string, OpenApiEndpointConfig>;
  googleDiscoveryApis: Record<string, GoogleDiscoveryApiConfig>;
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
  runtimeFingerprint?: RuntimeFingerprintSnapshot | undefined;
};

const runtimeFingerprintByConfig = new WeakMap<CapletsConfig, RuntimeFingerprintSnapshot>();

export function runtimeFingerprintForConfig(
  config: CapletsConfig,
  reader?: DeclaredInputReader,
): RuntimeFingerprintSnapshot {
  const existing = runtimeFingerprintByConfig.get(config);
  if (existing && (existing.valid || reader === undefined)) return existing;
  const fingerprint = createRuntimeFingerprintSnapshot({
    config,
    provenance: {},
    reader: reader ?? {
      read: () => ({ state: "missing" }),
      list: () => ({ state: "missing" }),
    },
  });
  runtimeFingerprintByConfig.set(config, fingerprint);
  return fingerprint;
}

type GenericLocalOverlayConfigWarning = {
  type?: undefined;
  kind: ConfigSourceKind;
  path: string;
  message: string;
  recoverable?: boolean | undefined;
};

export type LocalOverlayConfigWarning = GenericLocalOverlayConfigWarning | VaultQuarantineOutcome;

export type LocalOverlayConfigWithSources = ConfigWithSources & {
  warnings: LocalOverlayConfigWarning[];
  sourceFound: boolean;
};

export type ConfigVaultReference = {
  referenceName: string;
  capletId: string;
  origin: VaultConfigOrigin;
  path: string;
};

export type ConfigVaultResolution =
  | { storedKey: string; value: string }
  | {
      reason: "missing" | "ungranted" | "unavailable" | "invalid-key-source";
      storedKey?: string | undefined;
      referenceName: string;
      capletId: string;
      origin: VaultConfigOrigin;
    };

export type VaultQuarantineOutcome = {
  type: "vault-quarantine";
  kind: ConfigSourceKind;
  path: string;
  message: string;
  recoverable: true;
  capletId: string;
  referencePath: string;
  referenceName: string;
  storedKey?: string | undefined;
  effectiveKey: string;
  reason: Exclude<ConfigVaultResolution, { value: string }>["reason"];
  target: "global" | "remote";
};

export type ConfigVaultResolver = (reference: ConfigVaultReference) => ConfigVaultResolution;

export type ConfigParseOptions = {
  sources?: Record<string, ConfigSource> | undefined;
  vaultResolver?: ConfigVaultResolver | undefined;
  vaultRecoveryTarget?: "global" | "remote" | undefined;
};

const NON_INTERPOLATED_SERVER_FIELDS: Record<string, true> = {
  name: true,
  description: true,
  tags: true,
};
const VAULT_BARE_REFERENCE = "[A-Za-z0-9_-]+";

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

const exposureSchema = z
  .enum(["direct", "progressive", "code_mode", "direct_and_code_mode", "progressive_and_code_mode"])
  .describe("How this Caplet is exposed to agents.");

const shadowingSchema = z
  .enum(["forbid", "allow", "namespace"])
  .default("forbid")
  .describe("Whether attached local Caplets may shadow this remote Caplet ID.");

const namespaceAliasLabelSchema = z
  .string()
  .regex(
    NAMESPACE_ALIAS_LABEL_PATTERN,
    "namespace alias labels must be lowercase DNS-style labels using letters, numbers, or hyphens",
  )
  .describe("Namespace label used when qualifying colliding Caplet IDs.");

const namespaceAliasesSchema = z
  .object({
    local: namespaceAliasLabelSchema.optional(),
    upstreams: z
      .record(z.string().trim().min(1), namespaceAliasLabelSchema)
      .default({})
      .describe("Namespace aliases keyed by durable upstream source identity."),
  })
  .strict()
  .default({ upstreams: {} })
  .superRefine((aliases, ctx) => {
    const seen = new Map<string, Array<string | number>>();
    const addAlias = (value: string | undefined, path: Array<string | number>) => {
      if (!value) return;
      const existing = seen.get(value);
      if (existing) {
        ctx.addIssue({
          code: "custom",
          path,
          message: `namespace alias '${value}' is already used at ${existing.join(".")}`,
        });
        return;
      }
      seen.set(value, path);
    };

    addAlias(aliases.local, ["local"]);
    for (const [selector, alias] of Object.entries(aliases.upstreams)) {
      addAlias(alias, ["upstreams", selector]);
    }
  })
  .describe("Source-level namespace aliases for hash-qualified Caplet IDs.");

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
    shadowing: shadowingSchema,
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

const normalizedServerSchema = publicServerSchema;

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
    shadowing: shadowingSchema,
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

const normalizedOpenApiEndpointSchema = publicOpenApiEndpointSchema;

const operationFilterSchema = z.array(z.string().trim().min(1).max(160));

const publicGoogleDiscoveryApiSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe("Human-readable Google Discovery API display name."),
    description: z
      .string()
      .describe(
        "Capability description shown to agents before Google Discovery operations are disclosed.",
      )
      .refine(
        (value) => value.trim().length >= 10,
        "description must contain at least 10 non-whitespace characters",
      )
      .refine((value) => value.length <= 1500, "description must be at most 1500 characters"),
    discoveryPath: z.string().min(1).optional().describe("Local Google Discovery document path."),
    discoveryUrl: z.string().url().optional().describe("Remote Google Discovery document URL."),
    baseUrl: z.string().url().optional().describe("Override base URL for Google API requests."),
    includeOperations: operationFilterSchema.optional(),
    excludeOperations: operationFilterSchema.optional(),
    auth: openApiAuthSchema.describe(
      'Explicit Google API request auth config. Use {"type":"none"} for public APIs.',
    ),
    tags: z.array(z.string().trim().min(1).max(80)).optional(),
    exposure: exposureSchema.optional(),
    shadowing: shadowingSchema,
    setup: setupSchema.optional(),
    projectBinding: projectBindingSchema.optional(),
    runtime: runtimeRequirementsSchema.optional(),
    requestTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(60_000)
      .describe("Timeout in milliseconds for Google Discovery HTTP requests."),
    operationCacheTtlMs: z
      .number()
      .int()
      .nonnegative()
      .default(30_000)
      .describe(
        "Milliseconds Google Discovery operation metadata stays fresh. Set 0 to refresh every time.",
      ),
    disabled: z
      .boolean()
      .default(false)
      .describe("When true, omit this Google Discovery Caplet from discovery."),
  })
  .strict();

const normalizedGoogleDiscoveryApiSchema = publicGoogleDiscoveryApiSchema;

const graphQlOperationSchema = z
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
    shadowing: shadowingSchema,
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

const normalizedGraphQlEndpointSchema = publicGraphQlEndpointSchema;

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
    shadowing: shadowingSchema,
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

const normalizedHttpApiSchema = publicHttpApiSchema;

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
    shadowing: shadowingSchema,
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

const normalizedCliToolsSchema = publicCliToolsSchema;

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
    shadowing: shadowingSchema,
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

const normalizedCapletSetSchema = publicCapletSetSchema;

type ConfigSchemaServerValue = z.infer<typeof normalizedServerSchema>;
type ConfigSchemaOpenApiEndpointValue = z.infer<typeof normalizedOpenApiEndpointSchema>;
type ConfigSchemaGoogleDiscoveryApiValue = z.infer<typeof normalizedGoogleDiscoveryApiSchema>;
type ConfigSchemaGraphQlEndpointValue = z.infer<typeof normalizedGraphQlEndpointSchema>;
type ConfigSchemaHttpApiValue = z.infer<typeof normalizedHttpApiSchema>;
type ConfigSchemaCliToolsValue = z.infer<typeof normalizedCliToolsSchema>;
type ConfigSchemaCapletSetValue = z.infer<typeof normalizedCapletSetSchema>;
type ConfigInput = {
  telemetry?: unknown;
  serve?: unknown;
  namespaceAliases?: unknown;
  mcpServers?: Record<string, unknown>;
  openapiEndpoints?: Record<string, unknown>;
  googleDiscoveryApis?: Record<string, unknown>;
  graphqlEndpoints?: Record<string, unknown>;
  httpApis?: Record<string, unknown>;
  cliTools?: Record<string, unknown>;
  capletSets?: Record<string, unknown>;
  [key: string]: unknown;
};

const CAPLET_BACKEND_KEYS = [
  "mcpServers",
  "openapiEndpoints",
  "googleDiscoveryApis",
  "graphqlEndpoints",
  "httpApis",
  "cliTools",
  "capletSets",
] as const satisfies ReadonlyArray<keyof ConfigInput>;

const CAPLET_BACKEND_KEY_SET = new Set<string>(CAPLET_BACKEND_KEYS);
const SERVE_PUBLIC_ORIGIN_PATTERN = /^https?:\/\/(?![^/?#]*@)[^/?#]+\/?$/u;

const publicOriginSchema = z
  .string()
  .describe("Public HTTP(S) origin for DNS rebinding and credential audience checks.")
  .regex(SERVE_PUBLIC_ORIGIN_PATTERN, {
    message:
      "public origin must be an http(s) origin without credentials, path, query, or fragment",
  })
  .refine(isAllowedServePublicOrigin, {
    message:
      "public origin must be an http(s) origin without credentials, path, query, or fragment; http is only allowed for loopback development origins",
  })
  .transform(normalizePublicOrigin);
const STORAGE_IDENTIFIER_PATTERNS = {
  logicalHost: /^host_[0-9A-HJKMNP-TV-Z]{26}$/u,
  store: /^store_[0-9A-HJKMNP-TV-Z]{26}$/u,
  environment: /^[A-Z_][A-Z0-9_]*$/u,
  databaseRole: /^[a-z_][a-z0-9_]{0,62}$/u,
  bucket: /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/u,
} as const;

const absoluteStoragePathSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/u, "storage path must be absolute");

function deploymentSecretReferenceIdentity(reference: DeploymentSecretReference): string {
  if (reference.kind === "env") {
    const name = process.platform === "win32" ? reference.name.toLowerCase() : reference.name;
    return `env:${name}`;
  }
  const normalized = resolve(reference.path);
  return `file:${process.platform === "win32" ? normalized.toLowerCase() : normalized}`;
}

const deploymentSecretReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("env"),
      name: z
        .string()
        .regex(STORAGE_IDENTIFIER_PATTERNS.environment)
        .describe("Name of a deployment-owned environment variable."),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file"),
      path: absoluteStoragePathSchema.describe(
        "Owner/service-only secret file opened with bounded no-follow semantics.",
      ),
    })
    .strict(),
]);

const filesystemArtifactStorageSchema = z
  .object({
    kind: z.literal("filesystem"),
    root: absoluteStoragePathSchema,
  })
  .strict();

const s3ArtifactStorageSchema = z
  .object({
    kind: z.literal("s3"),
    endpoint: z
      .string()
      .url()
      .regex(
        /^https:\/\/[^/?#@]+(?:\/[^?#]*)?$/u,
        "S3 endpoint must use verified HTTPS without credentials, query, or fragment",
      )
      .refine(isVerifiedHttpsBaseUrl, {
        message: "S3 endpoint must use verified HTTPS without credentials, query, or fragment",
      }),
    region: z.string().trim().min(1),
    bucket: z.string().regex(STORAGE_IDENTIFIER_PATTERNS.bucket),
    prefix: z
      .string()
      .trim()
      .min(1)
      .regex(
        /^(?!\/)(?!.*\/\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\\]*[^/\\]$/u,
        "S3 prefix must be a relative canonical object prefix",
      ),
    canary: deploymentSecretReferenceSchema.describe(
      "Reference to the provisioned immutable shared-provider canary.",
    ),
    credentials: z
      .object({
        accessKeyId: deploymentSecretReferenceSchema,
        secretAccessKey: deploymentSecretReferenceSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((storage, ctx) => {
    const references = [
      storage.canary,
      storage.credentials.accessKeyId,
      storage.credentials.secretAccessKey,
    ].map(deploymentSecretReferenceIdentity);
    if (new Set(references).size !== references.length) {
      ctx.addIssue({
        code: "custom",
        path: ["credentials"],
        message: "S3 canary and credentials must use distinct references",
      });
    }
  });

const postgresRoleCredentialSchema = z
  .object({
    role: z.string().regex(STORAGE_IDENTIFIER_PATTERNS.databaseRole),
    credential: deploymentSecretReferenceSchema.describe(
      "Reference to a complete PostgreSQL connection string for this exact role.",
    ),
  })
  .strict();

const sqliteStorageSchema = z
  .object({
    kind: z.literal("sqlite"),
    stateRoot: absoluteStoragePathSchema.optional(),
    databasePath: absoluteStoragePathSchema.optional(),
    keyProviderManifest: absoluteStoragePathSchema.optional(),
    artifacts: filesystemArtifactStorageSchema.optional(),
  })
  .strict();

const postgresStorageSchema = z
  .object({
    kind: z.literal("postgres"),
    stateRoot: absoluteStoragePathSchema,
    logicalHostId: z.string().regex(STORAGE_IDENTIFIER_PATTERNS.logicalHost),
    expectedStoreId: z.string().regex(STORAGE_IDENTIFIER_PATTERNS.store),
    processRole: z.enum(["online", "migrator", "maintenance"]),
    connection: z
      .object({
        tls: z
          .object({
            mode: z.literal("verify-full"),
            serverName: z.string().trim().min(1),
            ca: deploymentSecretReferenceSchema.optional(),
          })
          .strict(),
        roles: z
          .object({
            runtime: postgresRoleCredentialSchema,
            migrator: postgresRoleCredentialSchema,
            maintenance: postgresRoleCredentialSchema,
          })
          .strict(),
      })
      .strict(),
    keyProviderManifest: absoluteStoragePathSchema,
    artifacts: s3ArtifactStorageSchema,
    migration: z.object({ designated: z.boolean() }).strict(),
    retention: z.object({ backupDays: z.number().int().min(1).max(3_650) }).strict(),
  })
  .strict()
  .superRefine((storage, ctx) => {
    const roles = Object.values(storage.connection.roles);
    if (new Set(roles.map((entry) => entry.role)).size !== roles.length) {
      ctx.addIssue({
        code: "custom",
        path: ["connection", "roles"],
        message: "Postgres runtime, migrator, and maintenance roles must be distinct",
      });
    }
    const references = [
      ...roles.map(({ credential }) => credential),
      ...(storage.connection.tls.ca ? [storage.connection.tls.ca] : []),
      storage.artifacts.canary,
      storage.artifacts.credentials.accessKeyId,
      storage.artifacts.credentials.secretAccessKey,
    ].map(deploymentSecretReferenceIdentity);
    if (new Set(references).size !== references.length) {
      ctx.addIssue({
        code: "custom",
        path: ["connection", "roles"],
        message: "Postgres and S3 deployment secrets must use distinct references",
      });
    }
    if (/(?:admin|owner|superuser|migrat|maint)/u.test(storage.connection.roles.runtime.role)) {
      ctx.addIssue({
        code: "custom",
        path: ["connection", "roles", "runtime", "role"],
        message: "Postgres runtime role must be least-privilege and non-administrative",
      });
    }
    if (storage.processRole === "migrator" && !storage.migration.designated) {
      ctx.addIssue({
        code: "custom",
        path: ["migration", "designated"],
        message: "Postgres migrator process must be explicitly designated",
      });
    }
  });

const serveStorageSchema = z.discriminatedUnion("kind", [
  sqliteStorageSchema,
  postgresStorageSchema,
]);

const serveConfigSchema = z
  .object({
    host: z.string().trim().min(1).optional().describe("Default HTTP bind host for caplets serve."),
    port: z.number().int().min(1).max(65_535).optional().describe("Default HTTP port."),
    path: z
      .string()
      .refine((value) => value.startsWith("/") && !value.includes("?") && !value.includes("#"), {
        message: "serve path must start with / and must not include query or fragment",
      })
      .optional()
      .describe("Default HTTP base path."),
    remoteStatePath: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Default remote credential state directory for HTTP serve."),
    upstreamUrl: z
      .string()
      .refine(isAllowedHttpBaseUrl)
      .optional()
      .describe("Default upstream Caplets URL for stacked HTTP serve."),
    allowUnauthenticatedHttp: z
      .boolean()
      .optional()
      .describe("Opt in to unauthenticated HTTP serving; intended only for trusted local use."),
    trustProxy: z
      .boolean()
      .optional()
      .describe("Trust proxy headers when deriving public HTTP request URLs."),
    storage: serveStorageSchema
      .optional()
      .describe("Static deployment-owned SQLite or Postgres control-plane storage."),
    publicOrigins: z
      .array(publicOriginSchema)
      .default([])
      .describe("Additional public HTTP origins."),
  })
  .strict();

const serveDefaultsFileSchema = z.object({ serve: serveConfigSchema.optional() }).passthrough();

type MissingEnvReference = {
  name: string;
  path: string;
};

function configSchemaFor(
  serverValueSchema: z.ZodTypeAny,
  openApiEndpointValueSchema: z.ZodTypeAny,
  googleDiscoveryApiValueSchema: z.ZodTypeAny,
  graphQlEndpointValueSchema: z.ZodTypeAny,
  httpApiValueSchema: z.ZodTypeAny,
  cliToolsValueSchema: z.ZodTypeAny,
  capletSetValueSchema: z.ZodTypeAny,
) {
  return z
    .object({
      $schema: z.string().optional().describe("Optional JSON Schema for editor validation."),
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
      telemetry: z
        .boolean()
        .optional()
        .describe("Set false to disable anonymous Caplets telemetry for this user config."),
      serve: serveConfigSchema
        .optional()
        .describe("User-owned HTTP serve defaults. Ignored from project config for security."),
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
      namespaceAliases: namespaceAliasesSchema,
      mcpServers: z
        .record(z.string().regex(SERVER_ID_PATTERN), serverValueSchema)
        .default({})
        .describe("Downstream MCP servers keyed by stable server ID."),
      openapiEndpoints: z
        .record(z.string().regex(SERVER_ID_PATTERN), openApiEndpointValueSchema)
        .default({})
        .describe("OpenAPI endpoints keyed by stable Caplet ID."),
      googleDiscoveryApis: z
        .record(z.string().regex(SERVER_ID_PATTERN), googleDiscoveryApiValueSchema)
        .default({})
        .describe("Google Discovery APIs keyed by stable Caplet ID."),
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

      for (const [api, rawValue] of Object.entries(config.googleDiscoveryApis)) {
        const raw = rawValue as ConfigSchemaGoogleDiscoveryApiValue;
        const duplicateBackend = config.mcpServers[api]
          ? "mcpServers"
          : config.openapiEndpoints[api]
            ? "openapiEndpoints"
            : config.graphqlEndpoints[api]
              ? "graphqlEndpoints"
              : config.httpApis[api]
                ? "httpApis"
                : config.cliTools[api]
                  ? "cliTools"
                  : config.capletSets[api]
                    ? "capletSets"
                    : undefined;
        if (duplicateBackend) {
          ctx.addIssue({
            code: "custom",
            path: ["googleDiscoveryApis", api],
            message: `Caplet ID ${api} is already used by ${duplicateBackend}`,
          });
        }
        if (!SERVER_ID_PATTERN.test(api)) {
          ctx.addIssue({
            code: "custom",
            path: ["googleDiscoveryApis", api],
            message: "Google Discovery API ID must match ^[a-zA-Z0-9_-]{1,64}$",
          });
        }
        if (Boolean(raw.discoveryPath) === Boolean(raw.discoveryUrl)) {
          ctx.addIssue({
            code: "custom",
            path: ["googleDiscoveryApis", api],
            message:
              "Google Discovery API must define exactly one discovery source: discoveryPath or discoveryUrl",
          });
        }
        if (raw.discoveryUrl && !isAllowedRemoteUrl(raw.discoveryUrl)) {
          ctx.addIssue({
            code: "custom",
            path: ["googleDiscoveryApis", api, "discoveryUrl"],
            message:
              "Google Discovery API discoveryUrl must use https except loopback development urls",
          });
        }
        if (raw.baseUrl && !isAllowedHttpBaseUrl(raw.baseUrl)) {
          ctx.addIssue({
            code: "custom",
            path: ["googleDiscoveryApis", api, "baseUrl"],
            message:
              "Google Discovery API baseUrl must use https except loopback development urls and must not include credentials, query, or fragment",
          });
        }
        if (raw.auth?.type === "headers") {
          for (const headerName of Object.keys(raw.auth.headers)) {
            const normalized = headerName.toLowerCase();
            if (!HEADER_NAME_PATTERN.test(headerName) || FORBIDDEN_HEADERS.has(normalized)) {
              ctx.addIssue({
                code: "custom",
                path: ["googleDiscoveryApis", api, "auth", "headers", headerName],
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
            : config.googleDiscoveryApis[endpoint]
              ? "googleDiscoveryApis"
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
            : config.googleDiscoveryApis[endpoint]
              ? "googleDiscoveryApis"
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
            : config.googleDiscoveryApis[server]
              ? "googleDiscoveryApis"
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
            : config.googleDiscoveryApis[server]
              ? "googleDiscoveryApis"
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
  publicGoogleDiscoveryApiSchema,
  publicGraphQlEndpointSchema,
  publicHttpApiSchema,
  publicCliToolsSchema,
  publicCapletSetSchema,
);
const normalizedConfigFileSchema = configSchemaFor(
  normalizedServerSchema,
  normalizedOpenApiEndpointSchema,
  normalizedGoogleDiscoveryApiSchema,
  normalizedGraphQlEndpointSchema,
  normalizedHttpApiSchema,
  normalizedCliToolsSchema,
  normalizedCapletSetSchema,
);

export function configJsonSchema(): unknown {
  return patchConfigJsonSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://caplets.dev/config.schema.json",
    title: "Caplets config",
    description: "Configuration file for the Caplets progressive MCP disclosure gateway.",
    ...z.toJSONSchema(configFileSchema, { io: "input" }),
  });
}

export function loadConfig(
  path = resolveConfigPath(),
  projectPath = resolveProjectConfigPath(),
  options: Pick<ConfigParseOptions, "vaultResolver"> = {},
): CapletsConfig {
  return loadConfigWithSources(path, projectPath, options).config;
}

export function loadConfigWithSources(
  path = resolveConfigPath(),
  projectPath = resolveProjectConfigPath(),
  options: Pick<ConfigParseOptions, "vaultResolver"> = {},
): ConfigWithSources {
  const hasUserConfig = existsSync(path);
  const hasProjectConfig = existsSync(projectPath);
  const userConfig = hasUserConfig ? readPublicConfigInput(path) : undefined;
  const userCaplets = loadCapletFilesWithPaths(resolveCapletsRoot(path));
  const projectConfig = hasProjectConfig
    ? rejectProjectConfigExecutableBackendMaps(
        stripProjectServeConfig(readPublicConfigInput(projectPath), projectPath),
        projectPath,
      )
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
    "Caplets config must define at least one MCP server, OpenAPI endpoint, Google Discovery API, GraphQL endpoint, HTTP API, CLI tools backend, or Caplet set",
    options,
  );
}

export function loadGlobalConfig(
  path = resolveConfigPath(),
  options: Pick<ConfigParseOptions, "vaultResolver"> = {},
): CapletsConfig {
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
    options,
  ).config;
}

export function loadGlobalServeDefaults(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  options: { home?: string | undefined; platform?: NodeJS.Platform | undefined } = {},
): ServeConfig | undefined {
  const explicitPath = env.CAPLETS_CONFIG?.trim();
  const configPath =
    explicitPath || defaultConfigPath(env as NodeJS.ProcessEnv, options.home, options.platform);
  if (!existsSync(configPath)) return undefined;
  return readServeDefaultsInput(configPath);
}

export function loadProjectConfig(
  projectPath = resolveProjectConfigPath(),
  options: Pick<ConfigParseOptions, "vaultResolver"> = {},
): CapletsConfig {
  const projectConfig = existsSync(projectPath)
    ? rejectProjectConfigExecutableBackendMaps(
        stripProjectServeConfig(readPublicConfigInput(projectPath), projectPath),
        projectPath,
      )
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
    options,
  ).config;
}

function buildConfigWithSources(
  inputs: Array<ConfigInputWithSource | undefined>,
  notFoundMessage: string,
  emptyMessage: string | undefined,
  options: Pick<ConfigParseOptions, "vaultResolver"> = {},
): ConfigWithSources {
  if (!inputs.some((entry) => entry?.input !== undefined)) {
    throw new CapletsError("CONFIG_NOT_FOUND", notFoundMessage);
  }

  try {
    const { input, sources, shadows } = mergeConfigInputsWithSources(...inputs);
    const config = parseConfig(input, {
      sources,
      vaultResolver: options.vaultResolver ?? defaultVaultResolver(),
    });
    if (
      emptyMessage &&
      Object.keys(config.mcpServers).length === 0 &&
      Object.keys(config.openapiEndpoints).length === 0 &&
      Object.keys(config.googleDiscoveryApis).length === 0 &&
      Object.keys(config.graphqlEndpoints).length === 0 &&
      Object.keys(config.httpApis).length === 0 &&
      Object.keys(config.cliTools).length === 0 &&
      Object.keys(config.capletSets).length === 0
    ) {
      throw new CapletsError("CONFIG_INVALID", emptyMessage);
    }
    const runtimeFingerprint = createLoadedRuntimeFingerprint(input, sources);
    runtimeFingerprintByConfig.set(config, runtimeFingerprint);
    return { config, sources, shadows, runtimeFingerprint };
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

function createLoadedRuntimeFingerprint(
  input: ConfigInput,
  sources: Record<string, ConfigSource>,
): RuntimeFingerprintSnapshot {
  const runtimeInput = {
    version: input.version,
    defaultSearchLimit: input.defaultSearchLimit,
    maxSearchLimit: input.maxSearchLimit,
    completion: input.completion,
    options: input.options,
    namespaceAliases: input.namespaceAliases,
    mcpServers: input.mcpServers,
    openapiEndpoints: input.openapiEndpoints,
    googleDiscoveryApis: input.googleDiscoveryApis,
    graphqlEndpoints: input.graphqlEndpoints,
    httpApis: input.httpApis,
    cliTools: input.cliTools,
    capletSets: input.capletSets,
  };
  const templateConfig = parseRuntimeTemplateConfig(runtimeInput);
  const provenance: Record<string, RuntimeFingerprintProvenance> = {};
  const readersByScope = new Map<string, DeclaredInputReader>();
  const privateRootsByScope = new Map<string, Map<string, string>>();
  for (const caplet of runtimeTemplateCaplets(templateConfig)) {
    const source = sources[caplet.server];
    const sourceInfo = fingerprintSourceInfo(source?.path, caplet.server);
    provenance[caplet.server] = {
      parentId: sourceInfo.parentId,
      ...(sourceInfo.childId ? { childId: sourceInfo.childId } : {}),
      sourcePath: sourceInfo.sourcePath,
      readerScope: sourceInfo.scope,
    };
    readersByScope.set(
      sourceInfo.scope,
      new FilesystemCapletSource(sourceInfo.root).declaredInputReader(),
    );
    logicalizeRuntimeTemplatePaths(
      caplet,
      sourceInfo.root,
      literalAbsoluteDeclaredInputValues(source?.path, caplet.server),
    );
  }
  const privatePath = (
    logicalPath: string,
    context: Parameters<DeclaredInputReader["read"]>[1],
  ): string | undefined => {
    if (!context?.readerScope) return undefined;
    if (context.privateReference) {
      const logicalBase = logicalPath.split("/").slice(0, -1).join("/") || logicalPath;
      const roots = privateRootsByScope.get(context.readerScope) ?? new Map<string, string>();
      roots.set(logicalBase, dirname(context.privateReference));
      privateRootsByScope.set(context.readerScope, roots);
      return context.privateReference;
    }
    const roots = privateRootsByScope.get(context.readerScope);
    if (!roots) return undefined;
    const match = [...roots.entries()]
      .filter(
        ([logicalBase]) => logicalPath === logicalBase || logicalPath.startsWith(`${logicalBase}/`),
      )
      .sort(([left], [right]) => right.length - left.length)[0];
    if (!match) return undefined;
    const suffix = logicalPath.slice(match[0].length).replace(/^\//u, "");
    return resolve(match[1], suffix);
  };
  const privateRoot = (
    logicalRoot: string,
    context: Parameters<DeclaredInputReader["list"]>[1],
  ): string | undefined => {
    if (!context?.readerScope) return undefined;
    if (context.privateReference) {
      const roots = privateRootsByScope.get(context.readerScope) ?? new Map<string, string>();
      roots.set(logicalRoot, context.privateReference);
      privateRootsByScope.set(context.readerScope, roots);
      return context.privateReference;
    }
    return privatePath(logicalRoot, context);
  };
  const reader: DeclaredInputReader = {
    read(logicalPath, context) {
      const physicalPath = privatePath(logicalPath, context);
      if (physicalPath) {
        return new FilesystemCapletSource(dirname(physicalPath))
          .declaredInputReader()
          .read(basename(physicalPath), context);
      }
      return context?.readerScope
        ? (readersByScope.get(context.readerScope)?.read(logicalPath, context) ?? {
            state: "unreadable",
          })
        : { state: "unreadable" };
    },
    list(logicalRoot, context) {
      const physicalRoot = privateRoot(logicalRoot, context);
      if (physicalRoot) {
        const listed = new FilesystemCapletSource(dirname(physicalRoot))
          .declaredInputReader()
          .list(basename(physicalRoot), context);
        if (listed.state !== "present") return listed;
        const physicalPrefix = `${basename(physicalRoot)}/`;
        return {
          ...listed,
          paths: listed.paths.map((path) =>
            path.startsWith(physicalPrefix)
              ? `${logicalRoot}/${path.slice(physicalPrefix.length)}`
              : logicalRoot,
          ),
        };
      }
      return context?.readerScope
        ? (readersByScope.get(context.readerScope)?.list(logicalRoot, context) ?? {
            state: "unreadable",
          })
        : { state: "unreadable" };
    },
  };
  const hostConfig = Object.assign(templateConfig, {
    ...(typeof input.telemetry === "boolean" ? { telemetry: input.telemetry } : {}),
    ...(isPlainObject(input.serve) ? { serve: input.serve as ServeConfig } : {}),
  });
  return createRuntimeFingerprintSnapshot({
    config: hostConfig,
    provenance,
    reader,
  });
}

function runtimeTemplateCaplets(config: RuntimeTemplateConfig): RuntimeTemplateCapletConfig[] {
  return [
    ...Object.values(config.mcpServers),
    ...Object.values(config.openapiEndpoints),
    ...Object.values(config.googleDiscoveryApis),
    ...Object.values(config.graphqlEndpoints),
    ...Object.values(config.httpApis),
    ...Object.values(config.cliTools),
    ...Object.values(config.capletSets),
  ];
}

function fingerprintSourceInfo(
  path: string | undefined,
  runtimeId: string,
): {
  root: string;
  sourcePath: string;
  scope: string;
  parentId: string;
  childId?: string | undefined;
} {
  const resolvedPath = resolve(path || `${runtimeId}.json`);
  const fileName = basename(resolvedPath);
  if (fileName === "CAPLET.md") {
    const artifactDirectory = dirname(resolvedPath);
    const parentId = basename(artifactDirectory);
    return {
      root: dirname(artifactDirectory),
      sourcePath: `${parentId}/CAPLET.md`,
      scope: `${runtimeId}:${resolvedPath}`,
      parentId,
      ...(runtimeId.startsWith(`${parentId}__`)
        ? { childId: runtimeId.slice(parentId.length + 2) }
        : {}),
    };
  }
  const parentId = fileName.toLowerCase().endsWith(".md") ? fileName.slice(0, -3) : runtimeId;
  return {
    root: dirname(resolvedPath),
    sourcePath: fileName,
    scope: `${runtimeId}:${resolvedPath}`,
    parentId,
    ...(runtimeId.startsWith(`${parentId}__`)
      ? { childId: runtimeId.slice(parentId.length + 2) }
      : {}),
  };
}

function logicalizeRuntimeTemplatePaths(
  caplet: RuntimeTemplateCapletConfig,
  sourceRoot: string,
  literalAbsoluteValues: Set<string> | undefined,
): void {
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (typeof nested === "string" && RUNTIME_DECLARED_INPUT_PATH_KEYS[key]) {
        if (
          isAbsolute(nested) &&
          literalAbsoluteValues !== undefined &&
          !literalAbsoluteValues.has(nested) &&
          isWithinFingerprintRoot(sourceRoot, nested)
        ) {
          (value as Record<string, unknown>)[key] = relative(sourceRoot, nested)
            .split(sep)
            .join("/");
        }
        continue;
      }
      visit(nested);
    }
  };
  visit(caplet);
}

function literalAbsoluteDeclaredInputValues(
  sourcePath: string | undefined,
  runtimeId: string,
): Set<string> | undefined {
  if (!sourcePath) return undefined;
  try {
    let sourceConfig: unknown;
    if (sourcePath.toLowerCase().endsWith(".md")) {
      const fileName =
        basename(sourcePath) === "CAPLET.md"
          ? `${basename(dirname(sourcePath))}/CAPLET.md`
          : basename(sourcePath);
      const loaded = loadCapletFilesFromMap({
        files: [{ path: fileName, content: readFileSync(sourcePath, "utf8") }],
      });
      sourceConfig = loaded
        ? runtimeInputValue(loaded.config as Record<string, unknown>, runtimeId)
        : undefined;
    } else {
      sourceConfig = runtimeInputValue(
        JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, unknown>,
        runtimeId,
      );
    }
    if (!sourceConfig) return undefined;
    const values = new Set<string>();
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (
          typeof nested === "string" &&
          RUNTIME_DECLARED_INPUT_PATH_KEYS[key] &&
          isCrossPlatformAbsolutePath(nested)
        ) {
          values.add(nested);
          if (!isAbsolute(nested)) values.add(resolve(dirname(sourcePath), nested));
        } else {
          visit(nested);
        }
      }
    };
    visit(sourceConfig);
    return values;
  } catch {
    return undefined;
  }
}

function runtimeInputValue(input: Record<string, unknown>, runtimeId: string): unknown {
  for (const key of [
    "mcpServers",
    "openapiEndpoints",
    "googleDiscoveryApis",
    "graphqlEndpoints",
    "httpApis",
    "cliTools",
    "capletSets",
  ]) {
    const values = input[key];
    if (isPlainObject(values)) {
      if (values[runtimeId] !== undefined) return values[runtimeId];
      const childId = runtimeId.includes("__") ? runtimeId.split("__").at(-1) : undefined;
      if (childId && values[childId] !== undefined) return values[childId];
    }
  }
  return undefined;
}

const RUNTIME_DECLARED_INPUT_PATH_KEYS: Record<string, true> = {
  specPath: true,
  discoveryPath: true,
  schemaPath: true,
  documentPath: true,
  configPath: true,
  capletsRoot: true,
};

function isWithinFingerprintRoot(root: string, path: string): boolean {
  const nested = relative(resolve(root), resolve(path));
  return (
    nested === "" || (!nested.startsWith(`..${sep}`) && nested !== ".." && !isAbsolute(nested))
  );
}

function isCrossPlatformAbsolutePath(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/u.test(path);
}

export function loadLocalOverlayConfigWithSources(
  path = resolveConfigPath(),
  projectPath = resolveProjectConfigPath(),
  options: Pick<ConfigParseOptions, "vaultResolver" | "vaultRecoveryTarget"> = {},
): LocalOverlayConfigWithSources {
  const parseOptions = {
    vaultResolver: options.vaultResolver ?? defaultVaultResolver(),
    vaultRecoveryTarget: options.vaultRecoveryTarget,
  };
  const warnings: LocalOverlayConfigWarning[] = [];
  const userConfig = existsSync(path)
    ? readBestEffortConfigInput(path, "global-config", warnings, undefined, parseOptions)
    : undefined;
  const userCaplets = loadBestEffortCapletFiles(
    resolveCapletsRoot(path),
    "global-file",
    warnings,
    parseOptions,
  );
  const projectConfig = existsSync(projectPath)
    ? readBestEffortConfigInput(
        projectPath,
        "project-config",
        warnings,
        (input) =>
          rejectProjectConfigExecutableBackendMaps(
            stripProjectServeConfig(input, projectPath, warnings),
            projectPath,
          ),
        parseOptions,
      )
    : undefined;
  const projectCapletsRoot = resolveProjectCapletsRootForConfigPath(projectPath);
  const projectCaplets = projectCapletsRoot
    ? loadBestEffortCapletFiles(projectCapletsRoot, "project-file", warnings, parseOptions)
    : undefined;
  const sourceFound = Boolean(userConfig || userCaplets || projectConfig || projectCaplets);

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

  const config = parseConfig(input, { sources, vaultResolver: parseOptions.vaultResolver });
  const runtimeFingerprint = createLoadedRuntimeFingerprint(input, sources);
  runtimeFingerprintByConfig.set(config, runtimeFingerprint);
  return {
    config,
    sources,
    shadows,
    runtimeFingerprint,
    warnings,
    sourceFound,
  };
}

export function loadLocalRuntimeConfig(
  path = resolveConfigPath(),
  projectPath = resolveProjectConfigPath(),
  options: Pick<ConfigParseOptions, "vaultResolver" | "vaultRecoveryTarget"> & {
    writeWarning?: ((warning: LocalOverlayConfigWarning) => void) | undefined;
  } = {},
): CapletsConfig {
  const overlay = loadLocalOverlayConfigWithSources(path, projectPath, {
    vaultResolver: options.vaultResolver,
    vaultRecoveryTarget: options.vaultRecoveryTarget,
  });
  for (const warning of overlay.warnings) {
    options.writeWarning?.(warning);
  }
  const blockingWarning = overlay.warnings.find(
    (warning) =>
      !warning.recoverable &&
      (warning.kind === "global-config" || warning.kind === "project-config"),
  );
  if (blockingWarning) {
    throw new CapletsError("CONFIG_INVALID", blockingWarning.message);
  }
  if (!overlay.sourceFound) {
    throw new CapletsError(
      "CONFIG_NOT_FOUND",
      `Caplets config not found at ${path} or ${projectPath}`,
    );
  }
  if (
    !configHasAnyCaplets(overlay.config) &&
    !overlay.warnings.some((warning) => warning.recoverable)
  ) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Caplets config must define at least one MCP server, OpenAPI endpoint, Google Discovery API, GraphQL endpoint, HTTP API, CLI tools backend, or Caplet set",
    );
  }
  return overlay.config;
}

function readBestEffortConfigInput(
  path: string,
  kind: ConfigSourceKind,
  warnings: LocalOverlayConfigWarning[],
  transform?: (input: ConfigInput) => ConfigInput,
  options: Pick<ConfigParseOptions, "vaultResolver" | "vaultRecoveryTarget"> = {},
): ConfigInput | undefined {
  try {
    const input = readBestEffortJsonConfigInput(path);
    const normalized = normalizeLocalPaths(input, dirname(path));
    const transformed = transform ? transform(normalized) : normalized;
    const filtered = quarantineUnresolvedReferenceCaplets(
      transformed,
      kind,
      path,
      warnings,
      options,
    );
    const validationOptions = {
      ...options,
      sources: Object.fromEntries(
        capletIds(filtered).map((id) => [id, { kind, path } satisfies ConfigSource]),
      ),
    };
    const parsed = configFileSchema.safeParse(interpolateConfig(filtered, [], validationOptions));
    if (!parsed.success) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Caplets config at ${path} is invalid`,
        parsed.error.issues,
      );
    }
    return filtered;
  } catch (error) {
    warnings.push({ kind, path, message: errorMessage(error) });
    return undefined;
  }
}

function readBestEffortJsonConfigInput(path: string): ConfigInput {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ConfigInput;
  } catch (error) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Caplets config at ${path} is not valid JSON`,
      redactSecrets(error),
    );
  }
}

function quarantineUnresolvedReferenceCaplets(
  input: ConfigInput,
  kind: ConfigSourceKind,
  sourcePath: string | ((id: string) => string),
  warnings: LocalOverlayConfigWarning[],
  options: Pick<ConfigParseOptions, "vaultResolver" | "vaultRecoveryTarget"> = {},
): ConfigInput {
  let filtered = input;

  for (const backend of CAPLET_BACKEND_KEYS) {
    const caplets = filtered[backend];
    if (!isPlainObject(caplets)) {
      continue;
    }

    for (const [id, caplet] of Object.entries(caplets)) {
      const envMissing = missingEnvReferences(caplet, [backend, id]);
      const capletSourcePath = typeof sourcePath === "function" ? sourcePath(id) : sourcePath;
      const vaultIssues = unresolvedVaultReferences(
        caplet,
        [backend, id],
        {
          capletId: id,
          origin: { kind, path: capletSourcePath },
        },
        options,
      );
      if (envMissing.length === 0 && vaultIssues.length === 0) {
        continue;
      }

      filtered = removeCapletBackendId(filtered, backend, id);
      for (const missing of groupMissingEnvReferences(envMissing)) {
        warnings.push({
          kind,
          path: capletSourcePath,
          message: formatMissingEnvWarning(id, missing),
          recoverable: true,
        });
      }
      for (const issue of vaultIssues) {
        warnings.push(
          vaultQuarantineOutcome(kind, capletSourcePath, id, issue, options.vaultRecoveryTarget),
        );
      }
    }
  }

  return filtered;
}

function missingEnvReferences(value: unknown, path: string[]): MissingEnvReference[] {
  if (isPublicMetadataPath(path)) {
    return [];
  }
  if (typeof value === "string") {
    return missingEnvReferencesInString(value, path.join("."));
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => missingEnvReferences(item, [...path, String(index)]));
  }
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([key, nested]) =>
      missingEnvReferences(nested, [...path, key]),
    );
  }
  return [];
}

function missingEnvReferencesInString(value: string, path: string): MissingEnvReference[] {
  const missing: MissingEnvReference[] = [];
  const pattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$env:([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of value.matchAll(pattern)) {
    const name = match[1] ?? match[2];
    if (name && process.env[name] === undefined) {
      missing.push({ name, path });
    }
  }
  return missing;
}

function formatMissingEnvWarning(id: string, missing: MissingEnvReference[]): string {
  const names = [...new Set(missing.map((reference) => reference.name))];
  const paths = [...new Set(missing.map((reference) => reference.path))];
  const variableLabel = names.length === 1 ? "environment variable" : "environment variables";
  return `Caplet ${id} references missing ${variableLabel} ${names.join(", ")} at ${paths.join(", ")}; skipping Caplet ${id}.`;
}

function groupMissingEnvReferences(missing: MissingEnvReference[]): MissingEnvReference[][] {
  return missing.length === 0 ? [] : [missing];
}

function configHasAnyCaplets(config: CapletsConfig): boolean {
  return (
    Object.keys(config.mcpServers).length > 0 ||
    Object.keys(config.openapiEndpoints).length > 0 ||
    Object.keys(config.googleDiscoveryApis).length > 0 ||
    Object.keys(config.graphqlEndpoints).length > 0 ||
    Object.keys(config.httpApis).length > 0 ||
    Object.keys(config.cliTools).length > 0 ||
    Object.keys(config.capletSets).length > 0
  );
}

type VaultReferenceIssue = {
  name: string;
  path: string;
  reason: Exclude<ConfigVaultResolution, { value: string }>["reason"];
  storedKey?: string | undefined;
};

function unresolvedVaultReferences(
  value: unknown,
  path: string[],
  context: Pick<ConfigVaultReference, "capletId" | "origin">,
  options: Pick<ConfigParseOptions, "vaultResolver">,
): VaultReferenceIssue[] {
  if (isPublicMetadataPath(path)) {
    return [];
  }
  if (typeof value === "string") {
    return unresolvedVaultReferencesInString(value, path.join("."), context, options);
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      unresolvedVaultReferences(item, [...path, String(index)], context, options),
    );
  }
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([key, nested]) =>
      unresolvedVaultReferences(nested, [...path, key], context, options),
    );
  }
  return [];
}

function unresolvedVaultReferencesInString(
  value: string,
  path: string,
  context: Pick<ConfigVaultReference, "capletId" | "origin">,
  options: Pick<ConfigParseOptions, "vaultResolver">,
): VaultReferenceIssue[] {
  const issues: VaultReferenceIssue[] = [];
  for (const match of value.matchAll(VAULT_REFERENCE_PATTERN)) {
    const name = match[1] ?? match[2];
    if (!name) continue;
    try {
      validateVaultKeyName(name);
    } catch {
      issues.push({ name, path, reason: "invalid-key-source" });
      continue;
    }
    const resolution = options.vaultResolver?.({
      referenceName: name,
      capletId: context.capletId,
      origin: context.origin,
      path,
    });
    if (!resolution || !("value" in resolution)) {
      const reason = resolution && "reason" in resolution ? resolution.reason : "unavailable";
      issues.push({
        name,
        path,
        reason,
        ...(resolution && "storedKey" in resolution && resolution.storedKey
          ? { storedKey: resolution.storedKey }
          : {}),
      });
    }
  }
  return issues;
}

function vaultQuarantineOutcome(
  kind: ConfigSourceKind,
  path: string,
  capletId: string,
  issue: VaultReferenceIssue,
  target: ConfigParseOptions["vaultRecoveryTarget"],
): VaultQuarantineOutcome {
  const outcome: VaultQuarantineOutcome = {
    type: "vault-quarantine",
    kind,
    path,
    message: "",
    recoverable: true,
    capletId,
    referencePath: issue.path,
    referenceName: issue.name,
    ...(issue.storedKey ? { storedKey: issue.storedKey } : {}),
    effectiveKey: issue.storedKey ?? issue.name,
    reason: issue.reason,
    target: target ?? "global",
  };
  outcome.message = formatVaultReferenceWarning(outcome);
  return outcome;
}

function formatVaultReferenceWarning(outcome: VaultQuarantineOutcome): string {
  const command = formatVaultRecoveryCommand(outcome);
  if (outcome.reason === "invalid-key-source") {
    return `Caplet ${outcome.capletId} references invalid-key-source Vault key ${outcome.effectiveKey} at ${outcome.referencePath}; run \`${command}\` for key-source details, then reload Caplets; skipping Caplet ${outcome.capletId}.`;
  }
  if (outcome.reason === "missing") {
    return `Caplet ${outcome.capletId} references missing Vault key ${outcome.effectiveKey} at ${outcome.referencePath}; run \`${command}\`, then reload Caplets; skipping Caplet ${outcome.capletId}.`;
  }
  return `Caplet ${outcome.capletId} references ${outcome.reason} Vault key ${outcome.effectiveKey} at ${outcome.referencePath}; run \`${command}\` after setting the value, then reload Caplets; skipping Caplet ${outcome.capletId}.`;
}

export function formatVaultRecoveryCommand(outcome: VaultQuarantineOutcome): string {
  if (outcome.reason === "invalid-key-source") return "caplets doctor";
  const targetFlag = outcome.target === "remote" ? " --remote" : "";
  if (outcome.reason === "missing") {
    return `caplets vault set ${outcome.effectiveKey}${targetFlag}`;
  }
  const remapFlag =
    outcome.effectiveKey !== outcome.referenceName ? ` --as ${outcome.referenceName}` : "";
  return `caplets vault access grant ${outcome.effectiveKey} ${outcome.capletId}${targetFlag}${remapFlag}`;
}

export function defaultVaultResolver(store = new FileVaultStore()): ConfigVaultResolver {
  return (reference) => {
    try {
      return store.resolveGrantedValue(reference);
    } catch (error) {
      return {
        reason: error instanceof CapletsError ? "invalid-key-source" : "unavailable",
        referenceName: reference.referenceName,
        capletId: reference.capletId,
        origin: reference.origin,
      };
    }
  };
}

export function vaultStoreForAuthDir(authDir: string | undefined): FileVaultStore {
  return new FileVaultStore(authDir ? { root: join(authDir, "vault") } : {});
}

export function vaultResolverForAuthDir(authDir: string | undefined): ConfigVaultResolver {
  return defaultVaultResolver(vaultStoreForAuthDir(authDir));
}

export const vaultBootstrapResolver: ConfigVaultResolver = (reference) => ({
  storedKey: reference.referenceName,
  value: vaultBootstrapPlaceholderValue(reference.path),
});

function vaultBootstrapPlaceholderValue(path: string): string {
  const leaf = path.split(".").at(-1)?.toLowerCase() ?? "";
  if (leaf.endsWith("url") || leaf.endsWith("uri") || leaf === "issuer") {
    return "https://caplets.local/vault-placeholder";
  }
  return "caplets-vault-placeholder";
}

function loadBestEffortCapletFiles(
  root: string,
  kind: ConfigSourceKind,
  warnings: LocalOverlayConfigWarning[],
  options: Pick<ConfigParseOptions, "vaultResolver" | "vaultRecoveryTarget"> = {},
): { config: ConfigInput; paths: Record<string, string> } | undefined {
  const result = loadCapletFilesWithPathsBestEffort(root);
  if (!result) {
    return undefined;
  }
  for (const warning of result.warnings) {
    warnings.push({ kind, path: warning.path ?? root, message: warning.message });
  }
  const config = quarantineUnresolvedReferenceCaplets(
    result.config,
    kind,
    (id) => result.paths[id] ?? root,
    warnings,
    options,
  );
  const retainedIds = new Set(capletIds(config));
  const paths = Object.fromEntries(
    Object.entries(result.paths).filter(([id]) => retainedIds.has(id)),
  );
  return { config, paths };
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
  vaultResolver?: ConfigVaultResolver | undefined;
  vaultRecoveryTarget?: ConfigParseOptions["vaultRecoveryTarget"];
}): CapletsConfig {
  if (!options.configPath && !options.capletsRoot) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Nested Caplet set must define at least one source: configPath or capletsRoot",
    );
  }

  const warnings: LocalOverlayConfigWarning[] = [];
  const parseOptions = {
    vaultResolver: options.vaultResolver ?? defaultVaultResolver(),
    vaultRecoveryTarget: options.vaultRecoveryTarget,
  };
  const configExists = Boolean(options.configPath && existsSync(options.configPath));
  const configInput = configExists
    ? readBestEffortConfigInput(
        options.configPath!,
        "global-config",
        warnings,
        undefined,
        parseOptions,
      )
    : undefined;
  const capletInput = options.capletsRoot
    ? loadBestEffortCapletFiles(options.capletsRoot, "global-file", warnings, parseOptions)
    : undefined;
  if (!configExists && !capletInput) {
    throw new CapletsError(
      "CONFIG_NOT_FOUND",
      `Nested Caplet set sources not found: ${[options.configPath, options.capletsRoot].filter(Boolean).join(", ")}`,
    );
  }
  const blockingWarning = warnings.find((warning) => !warning.recoverable);
  if (blockingWarning) {
    throw new CapletsError("CONFIG_INVALID", blockingWarning.message);
  }

  const { input, sources } = mergeConfigInputsWithSources(
    { input: configInput, source: { kind: "global-config", path: options.configPath ?? "" } },
    capletInput
      ? { input: capletInput.config, source: { kind: "global-file", path: capletInput.paths } }
      : undefined,
    {
      input: {
        version: 1,
        defaultSearchLimit: options.defaultSearchLimit,
        maxSearchLimit: options.maxSearchLimit,
      },
      source: { kind: "global-config", path: options.configPath ?? "" },
    },
  );
  const config = parseConfig(input, { sources, vaultResolver: parseOptions.vaultResolver });
  if (
    Object.keys(config.mcpServers).length === 0 &&
    Object.keys(config.openapiEndpoints).length === 0 &&
    Object.keys(config.googleDiscoveryApis).length === 0 &&
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
    const validationOptions = {
      sources: Object.fromEntries(
        capletIds(normalized).map((id) => [
          id,
          { kind: "global-config", path } satisfies ConfigSource,
        ]),
      ),
      vaultResolver: vaultBootstrapResolver,
    };
    const parsed = configFileSchema.safeParse(interpolateConfig(normalized, [], validationOptions));
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

function readServeDefaultsInput(path: string): ServeConfig | undefined {
  try {
    const input = JSON.parse(readFileSync(path, "utf8"));
    const validationOptions = { sources: {}, vaultResolver: vaultBootstrapResolver };
    const parsed = serveDefaultsFileSchema.safeParse(
      interpolateConfig(input as ConfigInput, [], validationOptions),
    );
    if (!parsed.success) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Caplets config at ${path} has invalid serve defaults`,
        parsed.error.issues,
      );
    }
    return parsed.data.serve ? normalizeServeConfig(parsed.data.serve) : undefined;
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
    googleDiscoveryApis: normalizeEndpointPaths(
      input.googleDiscoveryApis,
      baseDir,
      normalizeGoogleDiscoveryPath,
    ),
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
    specPath: normalizeDeclaredLocalPath(endpoint.specPath, baseDir),
  };
}

function normalizeGoogleDiscoveryPath(
  endpoint: Record<string, unknown>,
  baseDir: string,
): Record<string, unknown> {
  return {
    ...endpoint,
    discoveryPath: normalizeDeclaredLocalPath(endpoint.discoveryPath, baseDir),
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
                documentPath: normalizeDeclaredLocalPath(operation.documentPath, baseDir),
              }
            : operation,
        ]),
      )
    : endpoint.operations;
  return {
    ...endpoint,
    schemaPath: normalizeDeclaredLocalPath(endpoint.schemaPath, baseDir),
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
    configPath: normalizeDeclaredLocalPath(endpoint.configPath, baseDir),
    capletsRoot: normalizeDeclaredLocalPath(endpoint.capletsRoot, baseDir),
  };
}

function normalizeLocalPath(value: unknown, baseDir: string): unknown {
  if (
    typeof value !== "string" ||
    !value ||
    isAbsolute(value) ||
    hasInterpolationReference(value)
  ) {
    return value;
  }
  return join(baseDir, value);
}

function normalizeDeclaredLocalPath(value: unknown, baseDir: string): unknown {
  if (
    typeof value === "string" &&
    !isAbsolute(value) &&
    !hasInterpolationReference(value) &&
    value.replace(/\\/gu, "/").split("/").includes("..")
  ) {
    throw new CapletsError("CONFIG_INVALID", "Declared input path traversal is not allowed");
  }
  return normalizeLocalPath(value, baseDir);
}

function rejectProjectConfigExecutableBackendMaps(input: ConfigInput, path: string): ConfigInput {
  if (input.openapiEndpoints && Object.keys(input.openapiEndpoints).length > 0) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Project config at ${path} cannot define executable backend map openapiEndpoints; use project Markdown Caplet files or user config instead`,
    );
  }
  if (input.googleDiscoveryApis && Object.keys(input.googleDiscoveryApis).length > 0) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Project config at ${path} cannot define executable backend map googleDiscoveryApis; use project Markdown Caplet files or user config instead`,
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
      telemetry: input.telemetry === undefined ? merged?.telemetry : input.telemetry,
      serve: input.serve === undefined ? merged?.serve : input.serve,
      namespaceAliases: mergeNamespaceAliases(merged?.namespaceAliases, input.namespaceAliases),
      mcpServers: {
        ...merged?.mcpServers,
        ...input.mcpServers,
      },
      openapiEndpoints: {
        ...merged?.openapiEndpoints,
        ...input.openapiEndpoints,
      },
      googleDiscoveryApis: {
        ...merged?.googleDiscoveryApis,
        ...input.googleDiscoveryApis,
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

function mergeNamespaceAliases(left: unknown, right: unknown): Record<string, unknown> | undefined {
  if (right !== undefined && !isPlainObject(right)) {
    return right as Record<string, unknown>;
  }
  if (left !== undefined && !isPlainObject(left)) {
    return left as Record<string, unknown>;
  }
  if (!isPlainObject(left) && !isPlainObject(right)) {
    return undefined;
  }
  const leftRecord = isPlainObject(left) ? left : undefined;
  const rightRecord = isPlainObject(right) ? right : undefined;
  const leftUpstreams = isPlainObject(leftRecord?.upstreams) ? leftRecord.upstreams : undefined;
  const rightUpstreams = isPlainObject(rightRecord?.upstreams) ? rightRecord.upstreams : undefined;
  return stripUndefined({
    ...leftRecord,
    ...rightRecord,
    upstreams: {
      ...leftUpstreams,
      ...rightUpstreams,
    },
  });
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
    const entryInput =
      entry.source.kind === "global-config" ? entry.input : stripUserOnlyConfig(entry.input);
    for (const id of capletIds(entryInput)) {
      const source = sourceForId(entry.source, id);
      if (sources[id]) {
        shadows[id] = [...(shadows[id] ?? []), sources[id]];
      }
      sources[id] = source;
      merged = removeCapletId(merged, id);
    }
    merged = mergeConfigInputs(merged, entryInput) ?? {};
  }

  return { input: merged, sources, shadows };
}

function stripUserOnlyConfig(input: ConfigInput): ConfigInput {
  const { telemetry: _telemetry, serve: _serve, ...rest } = input;
  return rest;
}

function stripProjectServeConfig(
  input: ConfigInput,
  path: string,
  warnings?: LocalOverlayConfigWarning[],
): ConfigInput {
  if (input.serve === undefined) {
    return input;
  }
  warnings?.push({
    kind: "project-config",
    path,
    message: `Project config at ${path} cannot define user-owned serve settings; serve was ignored for security reasons`,
    recoverable: true,
  });
  const { serve: _serve, ...rest } = input;
  return rest;
}

function removeCapletBackendId(
  input: ConfigInput,
  backend: (typeof CAPLET_BACKEND_KEYS)[number],
  id: string,
): ConfigInput {
  const caplets = input[backend];
  if (!isPlainObject(caplets)) {
    return input;
  }
  const { [id]: _removed, ...remaining } = caplets;
  return { ...input, [backend]: remaining };
}

function removeCapletId(input: ConfigInput, id: string): ConfigInput {
  const { [id]: _mcpServer, ...mcpServers } = input.mcpServers ?? {};
  const { [id]: _openapiEndpoint, ...openapiEndpoints } = input.openapiEndpoints ?? {};
  const { [id]: _googleDiscoveryApi, ...googleDiscoveryApis } = input.googleDiscoveryApis ?? {};
  const { [id]: _graphqlEndpoint, ...graphqlEndpoints } = input.graphqlEndpoints ?? {};
  const { [id]: _httpApi, ...httpApis } = input.httpApis ?? {};
  const { [id]: _cliTools, ...cliTools } = input.cliTools ?? {};
  const { [id]: _capletSet, ...capletSets } = input.capletSets ?? {};

  return {
    ...input,
    mcpServers,
    openapiEndpoints,
    googleDiscoveryApis,
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
    ...Object.keys(input.googleDiscoveryApis ?? {}),
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

export function parseConfig(input: unknown, options: ConfigParseOptions = {}): CapletsConfig {
  const parsed = normalizedConfigFileSchema.safeParse(interpolateConfig(input, [], options));
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

  const googleDiscoveryApis: Record<string, GoogleDiscoveryApiConfig> = {};
  for (const [server, raw] of Object.entries(parsed.data.googleDiscoveryApis)) {
    const interpolated = raw as ConfigSchemaGoogleDiscoveryApiValue;
    googleDiscoveryApis[server] = stripUndefined({
      ...interpolated,
      server,
      backend: "googleDiscovery",
    }) as GoogleDiscoveryApiConfig;
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
    telemetry: parsed.data.telemetry,
    ...(parsed.data.serve ? { serve: normalizeServeConfig(parsed.data.serve) } : {}),
    options: {
      defaultSearchLimit: parsed.data.defaultSearchLimit,
      maxSearchLimit: parsed.data.maxSearchLimit,
      exposure: parsed.data.options.exposure,
      exposureDiscoveryTimeoutMs: parsed.data.options.exposureDiscoveryTimeoutMs,
      exposureDiscoveryConcurrency: parsed.data.options.exposureDiscoveryConcurrency,
      completion: parsed.data.completion,
    },
    namespaceAliases: stripUndefined({
      local: parsed.data.namespaceAliases.local,
      upstreams: parsed.data.namespaceAliases.upstreams,
    }) as NamespaceAliasesConfig,
    mcpServers: servers,
    openapiEndpoints,
    googleDiscoveryApis,
    graphqlEndpoints,
    httpApis,
    cliTools,
    capletSets,
  };
}

function normalizeServeConfig(raw: z.infer<typeof serveConfigSchema>): ServeConfig {
  return stripUndefined({
    host: raw.host,
    port: raw.port,
    path: raw.path,
    remoteStatePath: raw.remoteStatePath,
    upstreamUrl: raw.upstreamUrl,
    allowUnauthenticatedHttp: raw.allowUnauthenticatedHttp,
    trustProxy: raw.trustProxy,
    storage: raw.storage,
    publicOrigins: raw.publicOrigins,
  }) as ServeConfig;
}

function isAllowedServePublicOrigin(value: string): boolean {
  if (!isAllowedHttpBaseUrl(value)) return false;
  return new URL(value).pathname === "/";
}

function normalizePublicOrigin(value: string): string {
  return new URL(value).origin;
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

function interpolateConfig<T>(value: T, path: string[] = [], options: ConfigParseOptions = {}): T {
  if (path[0] === "serve" && path[1] === "storage") {
    return value;
  }
  if (isPublicMetadataPath(path)) {
    return value;
  }
  if (typeof value === "string") {
    return interpolateVault(interpolateEnv(value), path, options) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      interpolateConfig(item, [...path, String(index)], options),
    ) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nested]) => [
        nestedKey,
        interpolateConfig(nested, [...path, nestedKey], options),
      ]),
    ) as T;
  }
  return value;
}

function isPublicMetadataPath(path: string[]): boolean {
  if (path.length < 3 || !CAPLET_BACKEND_KEY_SET.has(path[0] ?? "")) {
    return false;
  }
  return NON_INTERPOLATED_SERVER_FIELDS[path[2] ?? ""] === true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasInterpolationReference(value: string): boolean {
  return new RegExp(
    `\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}|\\$env:[A-Za-z_][A-Za-z0-9_]*|\\$\\{vault:[^}]+\\}|\\$vault:${VAULT_BARE_REFERENCE}`,
  ).test(value);
}

const VAULT_REFERENCE_PATTERN = new RegExp(
  `\\$\\{vault:([^}]+)\\}|\\$vault:(${VAULT_BARE_REFERENCE})`,
  "g",
);

function interpolateVault(value: string, path: string[], options: ConfigParseOptions): string {
  if (!options.vaultResolver) return value;
  const backend = path[0];
  const capletId = path[1];
  if (!backend || !capletId || !CAPLET_BACKEND_KEY_SET.has(backend)) return value;
  const origin = options.sources?.[capletId];
  if (!origin) return value;
  return value.replace(VAULT_REFERENCE_PATTERN, (_match, braced: string, bare: string) => {
    const referenceName = validateVaultKeyName(braced ?? bare);
    const resolution = options.vaultResolver?.({
      referenceName,
      capletId,
      origin,
      path: path.join("."),
    });
    if (!resolution || !("value" in resolution)) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Vault key ${referenceName} is unresolved for Caplet ${capletId}`,
      );
    }
    return resolution.value;
  });
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
