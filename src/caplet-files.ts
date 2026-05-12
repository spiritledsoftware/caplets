import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { VFile } from "vfile";
import { matter as parseMatter } from "vfile-matter";
import { z } from "zod";
import { CapletsError, redactSecrets } from "./errors.js";

const MAX_CAPLET_FILE_BYTES = 128 * 1024;
const MAX_CAPLET_BODY_CHARS = 64 * 1024;
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
        clientId: z.string().min(1).optional(),
        clientSecret: z.string().min(1).optional(),
        scopes: z.array(z.string().min(1)).optional(),
        redirectUri: z.string().min(1).optional(),
      })
      .strict(),
  ])
  .describe("Authentication settings for a remote MCP server.");

const capletOpenApiAuthSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("none") }).strict(),
    z.object({ type: z.literal("bearer"), token: z.string().min(1) }).strict(),
    z
      .object({ type: z.literal("headers"), headers: z.record(z.string(), z.string().min(1)) })
      .strict(),
  ])
  .describe("Authentication settings for an OpenAPI endpoint.");

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

    if (server.auth?.type === "oauth2") {
      for (const field of ["authorizationUrl", "tokenUrl", "issuer", "redirectUri"] as const) {
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
    auth: capletOpenApiAuthSchema.describe(
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
    if (endpoint.auth?.type === "headers") {
      for (const headerName of Object.keys(endpoint.auth.headers)) {
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
  })
  .strict()
  .superRefine((frontmatter, ctx) => {
    if (Boolean(frontmatter.mcpServer) === Boolean(frontmatter.openapiEndpoint)) {
      ctx.addIssue({
        code: "custom",
        message: "Caplet file must define exactly one backend: mcpServer or openapiEndpoint",
      });
    }
  });

type CapletFileFrontmatter = z.infer<typeof capletFileSchema>;

export function capletJsonSchema(): unknown {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplet.schema.json",
    title: "Caplet file frontmatter",
    description: "YAML frontmatter schema for a Markdown Caplet file.",
    ...z.toJSONSchema(capletFileSchema, { io: "input" }),
  };
}

export type CapletFileConfig = {
  mcpServers?: Record<string, unknown>;
  openapiEndpoints?: Record<string, unknown>;
};

export function loadCapletFiles(root: string): CapletFileConfig | undefined {
  if (!existsSync(root)) {
    return undefined;
  }

  const servers: Record<string, unknown> = {};
  const openapiEndpoints: Record<string, unknown> = {};
  for (const candidate of discoverCapletFiles(root)) {
    if (servers[candidate.id] || openapiEndpoints[candidate.id]) {
      throw new CapletsError("CONFIG_INVALID", `Duplicate Caplet ID ${candidate.id} under ${root}`);
    }
    const config = readCapletFile(candidate.path);
    if (isPlainObject(config) && config.backend === "openapi") {
      const { backend: _backend, ...endpoint } = config;
      openapiEndpoints[candidate.id] = endpoint;
    } else {
      servers[candidate.id] = config;
    }
  }

  const hasServers = Object.keys(servers).length > 0;
  const hasOpenApi = Object.keys(openapiEndpoints).length > 0;
  return hasServers || hasOpenApi
    ? {
        ...(hasServers ? { mcpServers: servers } : {}),
        ...(hasOpenApi ? { openapiEndpoints } : {}),
      }
    : undefined;
}

function discoverCapletFiles(root: string): Array<{ id: string; path: string }> {
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

  return capletToServerConfig(parsed.data, body);
}

function capletToServerConfig(frontmatter: CapletFileFrontmatter, body: string): unknown {
  if (frontmatter.openapiEndpoint) {
    return {
      ...frontmatter.openapiEndpoint,
      backend: "openapi",
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

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
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
