import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
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
  name: string;
  description: string;
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

export type CapletsOptions = {
  defaultSearchLimit: number;
  maxSearchLimit: number;
};

export type CapletsConfig = {
  version: 1;
  options: CapletsOptions;
  mcpServers: Record<string, CapletServerConfig>;
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

export const DEFAULT_CONFIG_PATH = join(homedir(), ".caplets", "config.json");
export const DEFAULT_AUTH_DIR = join(homedir(), ".caplets", "auth");

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

const serverSchema = z
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

export const configFileSchema = z
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
      .record(z.string().regex(SERVER_ID_PATTERN), serverSchema)
      .describe("Downstream MCP servers keyed by stable server ID."),
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

    for (const [server, raw] of Object.entries(config.mcpServers)) {
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
  });

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

export function loadConfig(path = resolveConfigPath()): CapletsConfig {
  if (!existsSync(path)) {
    throw new CapletsError("CONFIG_NOT_FOUND", `Caplets config not found at ${path}`);
  }

  try {
    return parseConfig(JSON.parse(readFileSync(path, "utf8")));
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

export function parseConfig(input: unknown): CapletsConfig {
  const parsed = configFileSchema.safeParse(interpolateServer(input));
  if (!parsed.success) {
    throw new CapletsError("CONFIG_INVALID", "Caplets config is invalid", parsed.error.issues);
  }

  const servers: Record<string, CapletServerConfig> = {};
  for (const [server, raw] of Object.entries(parsed.data.mcpServers)) {
    const interpolated = raw;
    servers[server] = stripUndefined({
      ...interpolated,
      server,
      transport: interpolated.transport ?? (interpolated.command ? "stdio" : "http"),
    }) as CapletServerConfig;
  }

  return {
    version: parsed.data.version,
    options: {
      defaultSearchLimit: parsed.data.defaultSearchLimit,
      maxSearchLimit: parsed.data.maxSearchLimit,
    },
    mcpServers: servers,
  };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, nested]) => nested !== undefined),
  ) as T;
}

function interpolateServer<T>(value: T): T {
  if (typeof value === "string") {
    return interpolateEnv(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateServer(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, interpolateServer(nested)]),
    ) as T;
  }
  return value;
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
