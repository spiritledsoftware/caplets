import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { loadCapletFiles } from "./caplet-files.js";
import { CapletsError, redactSecrets } from "./errors.js";

export type RemoteAuthConfig =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "headers"; headers: Record<string, string> }
  | {
      type: "oauth2";
      authorizationUrl?: string | undefined;
      tokenUrl?: string | undefined;
      issuer?: string | undefined;
      clientId?: string | undefined;
      clientSecret?: string | undefined;
      scopes?: string[] | undefined;
      redirectUri?: string | undefined;
    };

export type CapletServerConfig = {
  server: string;
  backend: "mcp";
  name: string;
  description: string;
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
};

export type OpenApiAuthConfig =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "headers"; headers: Record<string, string> };

export type OpenApiEndpointConfig = {
  server: string;
  backend: "openapi";
  name: string;
  description: string;
  tags?: string[] | undefined;
  body?: string | undefined;
  specPath?: string | undefined;
  specUrl?: string | undefined;
  baseUrl?: string | undefined;
  auth: OpenApiAuthConfig;
  requestTimeoutMs: number;
  operationCacheTtlMs: number;
  disabled: boolean;
};

export type CapletConfig = CapletServerConfig | OpenApiEndpointConfig;

export type CapletsOptions = {
  defaultSearchLimit: number;
  maxSearchLimit: number;
};

export type CapletsConfig = {
  version: 1;
  options: CapletsOptions;
  mcpServers: Record<string, CapletServerConfig>;
  openapiEndpoints: Record<string, OpenApiEndpointConfig>;
};

const SERVER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FORBIDDEN_HEADERS = new Set([
  "accept",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "mcp-protocol-version",
  "mcp-session-id",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const NON_INTERPOLATED_SERVER_FIELDS = new Set(["name", "description", "tags", "body"]);

export const DEFAULT_CONFIG_PATH = join(homedir(), ".caplets", "config.json");
export const DEFAULT_AUTH_DIR = join(homedir(), ".caplets", "auth");
export const PROJECT_CONFIG_FILE = join(".caplets", "config.json");
export const TRUST_PROJECT_CAPLETS_ENV = "CAPLETS_TRUST_PROJECT_CAPLETS";

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
        clientId: z.string().min(1).optional(),
        clientSecret: z.string().min(1).optional(),
        scopes: z.array(z.string().min(1)).optional(),
        redirectUri: z.string().url().optional(),
      })
      .strict(),
  ])
  .describe("Authentication settings for a remote MCP server.");

const openApiAuthSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("none") }).strict(),
    z.object({ type: z.literal("bearer"), token: z.string().min(1) }).strict(),
    z
      .object({ type: z.literal("headers"), headers: z.record(z.string(), z.string().min(1)) })
      .strict(),
  ])
  .describe("Authentication settings for an OpenAPI endpoint.");

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

type ConfigSchemaServerValue = z.infer<typeof normalizedServerSchema>;
type ConfigSchemaOpenApiEndpointValue = z.infer<typeof normalizedOpenApiEndpointSchema>;
type ConfigInput = {
  mcpServers?: Record<string, unknown>;
  openapiEndpoints?: Record<string, unknown>;
  [key: string]: unknown;
};

function configSchemaFor(
  serverValueSchema: z.ZodTypeAny,
  openApiEndpointValueSchema: z.ZodTypeAny,
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
      mcpServers: z
        .record(z.string().regex(SERVER_ID_PATTERN), serverValueSchema)
        .default({})
        .describe("Downstream MCP servers keyed by stable server ID."),
      openapiEndpoints: z
        .record(z.string().regex(SERVER_ID_PATTERN), openApiEndpointValueSchema)
        .default({})
        .describe("OpenAPI endpoints keyed by stable Caplet ID."),
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
    });
}

export const configFileSchema = configSchemaFor(publicServerSchema, publicOpenApiEndpointSchema);
const normalizedConfigFileSchema = configSchemaFor(
  normalizedServerSchema,
  normalizedOpenApiEndpointSchema,
);

export function configJsonSchema(): unknown {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplets-config.schema.json",
    title: "Caplets config",
    description: "Configuration file for the Caplets progressive MCP disclosure gateway.",
    ...z.toJSONSchema(configFileSchema, { io: "input" }),
  };
}

export function resolveConfigPath(path?: string): string {
  return path ?? join(homedir(), ".caplets", "config.json");
}

export function resolveProjectConfigPath(cwd = process.cwd()): string {
  return join(cwd, PROJECT_CONFIG_FILE);
}

export function resolveCapletsRoot(configPath = resolveConfigPath()): string {
  return dirname(configPath);
}

export function resolveProjectCapletsRoot(cwd = process.cwd()): string {
  return join(cwd, ".caplets");
}

export function loadConfig(
  path = resolveConfigPath(),
  projectPath = resolveProjectConfigPath(),
): CapletsConfig {
  const hasUserConfig = existsSync(path);
  const hasProjectConfig = existsSync(projectPath);
  const userConfig = hasUserConfig ? readPublicConfigInput(path) : undefined;
  const userCaplets = loadCapletFiles(resolveCapletsRoot(path));
  const projectConfig = hasProjectConfig
    ? rejectUntrustedProjectOpenApi(readPublicConfigInput(projectPath), projectPath)
    : undefined;
  const projectCaplets = shouldLoadProjectCaplets()
    ? loadCapletFiles(dirname(projectPath))
    : undefined;

  if (!hasUserConfig && !hasProjectConfig && !userCaplets && !projectCaplets) {
    throw new CapletsError(
      "CONFIG_NOT_FOUND",
      `Caplets config not found at ${path} or ${projectPath}`,
    );
  }

  try {
    const config = parseConfig(
      mergeConfigInputs(userConfig, userCaplets, projectConfig, projectCaplets),
    );
    if (
      Object.keys(config.mcpServers).length === 0 &&
      Object.keys(config.openapiEndpoints).length === 0
    ) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Caplets config must define at least one MCP server or OpenAPI endpoint",
      );
    }
    return config;
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

function shouldLoadProjectCaplets(): boolean {
  return isTrustedEnvEnabled(process.env[TRUST_PROJECT_CAPLETS_ENV]);
}

function isTrustedEnvEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function readPublicConfigInput(path: string): ConfigInput {
  try {
    const input = JSON.parse(readFileSync(path, "utf8"));
    const parsed = configFileSchema.safeParse(interpolateConfig(input));
    if (!parsed.success) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Caplets config at ${path} is invalid`,
        parsed.error.issues,
      );
    }
    return input as ConfigInput;
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

function rejectUntrustedProjectOpenApi(input: ConfigInput, path: string): ConfigInput {
  if (input.openapiEndpoints && Object.keys(input.openapiEndpoints).length > 0) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Project config at ${path} cannot define openapiEndpoints; use trusted project Caplet files or user config`,
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
    };
  }
  return merged;
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

  return {
    version: parsed.data.version,
    options: {
      defaultSearchLimit: parsed.data.defaultSearchLimit,
      maxSearchLimit: parsed.data.maxSearchLimit,
    },
    mcpServers: servers,
    openapiEndpoints,
  };
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
  if (path.length < 3 || (path[0] !== "mcpServers" && path[0] !== "openapiEndpoints")) {
    return false;
  }
  return NON_INTERPOLATED_SERVER_FIELDS.has(path[2] ?? "");
}

export function interpolateEnv(value: string): string {
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => process.env[name] ?? "");
}

function isAllowedRemoteUrl(value: string): boolean {
  const url = new URL(value);
  if (url.protocol === "https:") {
    return true;
  }
  if (url.protocol !== "http:") {
    return false;
  }
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
}
