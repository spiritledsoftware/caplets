import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CompatibilityCallToolResult, Tool } from "@modelcontextprotocol/sdk/types";
import { genericOAuthHeaders, readTokenBundle } from "../auth";
import type { GoogleDiscoveryApiConfig } from "../config";
import {
  compactToolSafetyHints,
  compactToolSchemaHints,
  compactToolSelectionHints,
  type CompactTool,
} from "../downstream";
import { CapletsError, toSafeError } from "../errors";
import { readHttpLikeResponse } from "../http/response";
import { isAbortError, readLimitedText } from "../http/utils";
import { readMediaInput, type ResolvedMediaInput } from "../media";
import type { ServerRegistry } from "../registry";
import { markdownStructuredContent } from "../result-content";
import { searchToolList } from "../tool-search";
import {
  discoveryOperations,
  googleDiscoveryScopesForOperations,
  type GoogleDiscoveryOperation,
} from "./operations";
import {
  buildGoogleDiscoveryUploadUrl,
  buildGoogleDiscoveryUrl,
  buildJsonRequestInit,
} from "./request";
import type { GoogleDiscoveryDocument } from "./types";

const DEFAULT_RESUMABLE_THRESHOLD_BYTES = 8 * 1024 * 1024;
const DEFAULT_MEDIA_RESPONSE_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_DISCOVERY_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

type ManagedGoogleDiscovery = {
  operations?: GoogleDiscoveryOperation[];
  baseUrl?: string;
  fetchedAt?: number;
  cacheKey: string;
};

export class GoogleDiscoveryManager {
  private readonly cache = new Map<string, ManagedGoogleDiscovery>();

  constructor(
    private registry: ServerRegistry,
    private readonly options: {
      authDir?: string;
      artifactDir?: string;
      exposeLocalArtifactPaths?: boolean;
    } = {},
  ) {}

  updateRegistry(registry: ServerRegistry): void {
    this.registry = registry;
  }

  invalidate(serverId: string): void {
    this.cache.delete(serverId);
  }

  async checkApi(api: GoogleDiscoveryApiConfig): Promise<{
    id: string;
    status: string;
    toolCount?: number;
    elapsedMs: number;
    error?: unknown;
  }> {
    const startedAt = Date.now();
    try {
      const operations = await this.refreshOperations(api, true);
      this.registry.setStatus(api.server, "available");
      return {
        id: api.server,
        status: "available",
        toolCount: operations.length,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      const safe = toSafeError(error, "SERVER_UNAVAILABLE");
      this.registry.setStatus(api.server, "unavailable", safe);
      return {
        id: api.server,
        status: "unavailable",
        elapsedMs: Date.now() - startedAt,
        error: safe,
      };
    }
  }

  async listTools(api: GoogleDiscoveryApiConfig): Promise<Tool[]> {
    const operations = await this.refreshOperations(api, false);
    return operations.map((operation) => this.toTool(operation));
  }

  async getTool(api: GoogleDiscoveryApiConfig, toolName: string): Promise<Tool> {
    return this.toTool(await this.getOperation(api, toolName));
  }

  async callTool(
    api: GoogleDiscoveryApiConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CompatibilityCallToolResult> {
    const operation = await this.getOperation(api, toolName);
    const requestApi = await this.resolveRequestApi(api);
    if (operation.supportsMediaUpload && "media" in args) {
      return this.callMediaUpload(requestApi, operation, args);
    }
    const requestArgs = shouldRequestMediaDownload(operation, args)
      ? withMediaDownloadQuery(args)
      : args;
    const url = buildGoogleDiscoveryUrl(requestApi, operation, requestArgs);
    const headers = new Headers(
      await authHeaders(requestApi, this.options.authDir, operation.scopes),
    );
    const init = buildJsonRequestInit(operation, args, headers);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestApi.requestTimeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        throw new CapletsError(
          "DOWNSTREAM_PROTOCOL_ERROR",
          "Google Discovery request returned a redirect",
          {
            server: requestApi.server,
            status: response.status,
            location: response.headers.get("location") ? "[REDACTED]" : undefined,
          },
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw googleAuthError(requestApi, response);
      }
      const parsed = await readHttpLikeResponse(response, {
        capletId: requestApi.server,
        method: operation.method,
        ...(this.options.artifactDir ? { artifactDir: this.options.artifactDir } : {}),
        ...(this.options.exposeLocalArtifactPaths === false ? { exposeLocalPath: false } : {}),
        ...(typeof args.filename === "string" ? { filename: args.filename } : {}),
        ...(typeof args.outputPath === "string" ? { outputPath: args.outputPath } : {}),
        maxBytes: DEFAULT_MEDIA_RESPONSE_MAX_BYTES,
        ...(operation.supportsMediaDownload &&
        (typeof args.filename === "string" || typeof args.outputPath === "string")
          ? { forceArtifact: true }
          : {}),
      });
      return {
        content: markdownStructuredContent(parsed, {
          title: `${requestApi.name} call_tool ${toolName}`,
          backend: "googleDiscovery",
          operation: "call_tool",
          tool: toolName,
        }),
        structuredContent: parsed as Record<string, unknown>,
        isError: !response.ok,
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw new CapletsError(
          "TOOL_CALL_TIMEOUT",
          `Google Discovery request timed out for ${requestApi.server}/${toolName}`,
        );
      }
      if (error instanceof CapletsError) throw error;
      throw new CapletsError(
        "DOWNSTREAM_TOOL_ERROR",
        `Google Discovery request failed for ${requestApi.server}/${toolName}`,
        toSafeError(error),
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async callMediaUpload(
    api: GoogleDiscoveryApiConfig,
    operation: GoogleDiscoveryOperation,
    args: Record<string, unknown>,
  ): Promise<CompatibilityCallToolResult> {
    const mediaOptions: {
      artifactRoot?: string;
      allowLocalPaths?: boolean;
    } = {};
    if (this.options.artifactDir) mediaOptions.artifactRoot = this.options.artifactDir;
    if (this.options.exposeLocalArtifactPaths === false) mediaOptions.allowLocalPaths = false;
    const media = await readMediaInput(args.media, mediaOptions);
    const headers = new Headers(await authHeaders(api, this.options.authDir, operation.scopes));
    const protocol = selectUploadProtocol(operation, media, args);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), api.requestTimeoutMs);
    try {
      const response =
        protocol === "resumable"
          ? await this.callResumableUpload(api, operation, args, media, headers, controller.signal)
          : await this.callSingleUpload(
              api,
              operation,
              args,
              media,
              headers,
              protocol,
              controller.signal,
            );
      const parsed = await readHttpLikeResponse(response, {
        capletId: api.server,
        method: operation.method,
        ...(this.options.artifactDir ? { artifactDir: this.options.artifactDir } : {}),
        ...(this.options.exposeLocalArtifactPaths === false ? { exposeLocalPath: false } : {}),
      });
      return {
        content: markdownStructuredContent(parsed, {
          title: `${api.name} call_tool ${operation.name}`,
          backend: "googleDiscovery",
          operation: "call_tool",
          tool: operation.name,
        }),
        structuredContent: parsed as Record<string, unknown>,
        isError: !response.ok,
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw new CapletsError(
          "TOOL_CALL_TIMEOUT",
          `Google Discovery request timed out for ${api.server}/${operation.name}`,
        );
      }
      if (error instanceof CapletsError) throw error;
      throw new CapletsError(
        "DOWNSTREAM_TOOL_ERROR",
        `Google Discovery request failed for ${api.server}/${operation.name}`,
        toSafeError(error),
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async callSingleUpload(
    api: GoogleDiscoveryApiConfig,
    operation: GoogleDiscoveryOperation,
    args: Record<string, unknown>,
    media: ResolvedMediaInput,
    headers: Headers,
    protocol: "simple" | "multipart",
    signal?: AbortSignal,
  ): Promise<Response> {
    const upload = operation.mediaUploadProtocols[protocol];
    if (!upload?.path) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Google Discovery ${protocol} upload path is missing`,
      );
    }
    const url = buildGoogleDiscoveryUploadUrl(
      api,
      operation,
      upload.path,
      protocol === "simple" ? "media" : "multipart",
      args,
    );
    const init =
      protocol === "simple"
        ? simpleUploadInit(operation, media, headers)
        : multipartUploadInit(operation, args.body, media, headers);
    return fetchGoogleRequest(api, operation, url, init, { signal });
  }

  private async callResumableUpload(
    api: GoogleDiscoveryApiConfig,
    operation: GoogleDiscoveryOperation,
    args: Record<string, unknown>,
    media: ResolvedMediaInput,
    headers: Headers,
    signal?: AbortSignal,
  ): Promise<Response> {
    const upload = operation.mediaUploadProtocols.resumable;
    if (!upload?.path) {
      throw new CapletsError("CONFIG_INVALID", "Google Discovery resumable upload path is missing");
    }
    const contentType = safeMediaContentType(media.mimeType);
    const startUrl = buildGoogleDiscoveryUploadUrl(api, operation, upload.path, "resumable", args);
    headers.set("content-type", "application/json; charset=UTF-8");
    headers.set("x-upload-content-type", contentType);
    headers.set("x-upload-content-length", String(media.bytes.byteLength));
    const started = await fetchGoogleRequest(
      api,
      operation,
      startUrl,
      {
        method: operation.method.toUpperCase(),
        headers,
        body: JSON.stringify(args.body ?? {}),
        redirect: "manual",
      },
      { signal },
    );
    if (!started.ok) {
      return started;
    }
    const location = started.headers.get("location");
    if (!location) {
      throw new CapletsError(
        "DOWNSTREAM_PROTOCOL_ERROR",
        "Google resumable upload missing Location",
      );
    }
    const uploadUrl = new URL(location);
    const uploadHeaders = new Headers();
    uploadHeaders.set("content-type", contentType);
    uploadHeaders.set("content-length", String(media.bytes.byteLength));
    uploadHeaders.set("content-range", resumableContentRange(media.bytes.byteLength));
    copySessionAuthorization(api, startUrl, uploadUrl, headers, uploadHeaders);
    return fetchGoogleRequest(
      api,
      operation,
      uploadUrl,
      {
        method: "PUT",
        headers: uploadHeaders,
        body: media.bytes,
        redirect: "manual",
      },
      { signal },
    );
  }

  compact(_api: GoogleDiscoveryApiConfig, tool: Tool): CompactTool {
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
    api: GoogleDiscoveryApiConfig,
    tools: Tool[],
    query: string,
    limit: number,
  ): CompactTool[] {
    return searchToolList(tools, query, limit, (tool) => this.compact(api, tool));
  }

  async resolveAuthScopes(api: GoogleDiscoveryApiConfig): Promise<string[]> {
    return googleDiscoveryScopesForOperations(await this.refreshOperations(api, false));
  }

  private async getOperation(
    api: GoogleDiscoveryApiConfig,
    toolName: string,
  ): Promise<GoogleDiscoveryOperation> {
    const operations = await this.refreshOperations(api, false);
    const operation = operations.find((candidate) => candidate.name === toolName);
    if (!operation) {
      throw new CapletsError("TOOL_NOT_FOUND", `Tool ${toolName} was not found on ${api.server}`, {
        server: api.server,
        tool: toolName,
        suggestions: operations
          .map((candidate) => candidate.name)
          .filter((name) =>
            name.toLocaleLowerCase().includes(toolName.toLocaleLowerCase()[0] ?? ""),
          )
          .slice(0, 5),
      });
    }
    return operation;
  }

  private async refreshOperations(
    api: GoogleDiscoveryApiConfig,
    force: boolean,
  ): Promise<GoogleDiscoveryOperation[]> {
    const cached = this.cache.get(api.server);
    const cacheKey = googleDiscoveryCacheKey(api);
    const now = Date.now();
    const isFresh =
      cached?.operations &&
      cached.cacheKey === cacheKey &&
      cached.fetchedAt !== undefined &&
      api.operationCacheTtlMs > 0 &&
      now - cached.fetchedAt <= api.operationCacheTtlMs;
    if (!force && isFresh) return cached.operations ?? [];

    try {
      const document = await loadGoogleDiscoveryDocument(api, this.options.authDir);
      const baseUrl = googleDiscoveryBaseUrl(api, document);
      const operations = discoveryOperations({
        server: api.server,
        document,
        ...(api.includeOperations ? { includeOperations: api.includeOperations } : {}),
        ...(api.excludeOperations ? { excludeOperations: api.excludeOperations } : {}),
      });
      this.cache.set(api.server, {
        operations,
        ...(baseUrl ? { baseUrl } : {}),
        fetchedAt: Date.now(),
        cacheKey,
      });
      this.registry.setStatus(api.server, "available");
      return operations;
    } catch (error) {
      const safe = toSafeError(error, "DOWNSTREAM_PROTOCOL_ERROR");
      this.registry.setStatus(api.server, "unavailable", safe);
      throw new CapletsError(
        safe.code,
        `Could not load Google Discovery operations for ${api.server}`,
        safe,
      );
    }
  }

  private toTool(operation: GoogleDiscoveryOperation): Tool {
    return {
      name: operation.name,
      ...(operation.description ? { description: operation.description } : {}),
      inputSchema: operation.inputSchema as Tool["inputSchema"],
      ...(operation.outputSchema
        ? { outputSchema: operation.outputSchema as Tool["outputSchema"] }
        : {}),
      annotations: {
        readOnlyHint: operation.readOnlyHint,
        destructiveHint: operation.destructiveHint,
      },
    };
  }

  async resolveBaseUrl(api: GoogleDiscoveryApiConfig): Promise<string | undefined> {
    await this.refreshOperations(api, false);
    return this.cache.get(api.server)?.baseUrl;
  }

  private async resolveRequestApi(
    api: GoogleDiscoveryApiConfig,
  ): Promise<GoogleDiscoveryApiConfig> {
    if (api.baseUrl) return api;
    const baseUrl = await this.resolveBaseUrl(api);
    if (!baseUrl) {
      throw new CapletsError("CONFIG_INVALID", `${api.server} is missing Google Discovery baseUrl`);
    }
    return { ...api, baseUrl };
  }
}

function selectUploadProtocol(
  operation: GoogleDiscoveryOperation,
  media: ResolvedMediaInput,
  args: Record<string, unknown>,
): "simple" | "multipart" | "resumable" {
  if (
    media.bytes.byteLength > DEFAULT_RESUMABLE_THRESHOLD_BYTES &&
    operation.mediaUploadProtocols.resumable
  ) {
    return "resumable";
  }
  if ("body" in args) {
    if (operation.mediaUploadProtocols.multipart) return "multipart";
    if (operation.mediaUploadProtocols.resumable) return "resumable";
    throw new CapletsError(
      "CONFIG_INVALID",
      "Google Discovery media upload metadata requires multipart or resumable upload",
    );
  }
  if (operation.mediaUploadProtocols.simple) return "simple";
  if (operation.mediaUploadProtocols.resumable) return "resumable";
  throw new CapletsError(
    "CONFIG_INVALID",
    "Google Discovery media upload has no supported protocol",
  );
}

function simpleUploadInit(
  operation: GoogleDiscoveryOperation,
  media: ResolvedMediaInput,
  headers: Headers,
): RequestInit {
  headers.set("content-type", safeMediaContentType(media.mimeType));
  headers.set("content-length", String(media.bytes.byteLength));
  return {
    method: operation.method.toUpperCase(),
    headers,
    body: media.bytes,
    redirect: "manual",
  };
}

function multipartUploadInit(
  operation: GoogleDiscoveryOperation,
  body: unknown,
  media: ResolvedMediaInput,
  headers: Headers,
): RequestInit {
  const boundary = `caplets_${randomUUID().replace(/-/gu, "")}`;
  const contentType = safeMediaContentType(media.mimeType);
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(
        body ?? {},
      )}\r\n`,
    ),
    Buffer.from(`--${boundary}\r\ncontent-type: ${contentType}\r\n\r\n`),
    media.bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  headers.set("content-type", `multipart/related; boundary=${boundary}`);
  headers.set("content-length", String(payload.byteLength));
  return {
    method: operation.method.toUpperCase(),
    headers,
    body: payload,
    redirect: "manual",
  };
}

function resumableContentRange(byteLength: number): string {
  return byteLength === 0 ? "bytes */0" : `bytes 0-${byteLength - 1}/${byteLength}`;
}

function safeMediaContentType(mimeType: string | undefined): string {
  const contentType = mimeType ?? "application/octet-stream";
  if (/[\r\n]/u.test(contentType)) {
    throw new CapletsError("REQUEST_INVALID", "media.mimeType must not contain line breaks");
  }
  return contentType;
}

function googleDiscoveryBaseUrl(
  api: GoogleDiscoveryApiConfig,
  document: GoogleDiscoveryDocument,
): string | undefined {
  if (api.baseUrl) return api.baseUrl;
  if (document.baseUrl) return document.baseUrl;
  if (document.rootUrl && document.servicePath) {
    return new URL(document.servicePath, document.rootUrl).toString();
  }
  return undefined;
}

async function fetchGoogleRequest(
  api: GoogleDiscoveryApiConfig,
  operation: GoogleDiscoveryOperation,
  url: URL,
  init: RequestInit,
  options: { signal?: AbortSignal | undefined } = {},
): Promise<Response> {
  const controller = options.signal ? undefined : new AbortController();
  const timeout = controller
    ? setTimeout(() => controller.abort(), api.requestTimeoutMs)
    : undefined;
  try {
    const response = await fetch(url, { ...init, signal: options.signal ?? controller!.signal });
    if (response.status >= 300 && response.status < 400) {
      throw new CapletsError(
        "DOWNSTREAM_PROTOCOL_ERROR",
        "Google Discovery request returned a redirect",
        {
          server: api.server,
          status: response.status,
          location: response.headers.get("location") ? "[REDACTED]" : undefined,
        },
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw googleAuthError(api, response);
    }
    return response;
  } catch (error) {
    if (isAbortError(error)) {
      throw new CapletsError(
        "TOOL_CALL_TIMEOUT",
        `Google Discovery request timed out for ${api.server}/${operation.name}`,
      );
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function loadGoogleDiscoveryDocument(
  api: GoogleDiscoveryApiConfig,
  authDir?: string,
): Promise<GoogleDiscoveryDocument> {
  const source = await loadGoogleDiscoverySource(api, authDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new CapletsError("DOWNSTREAM_PROTOCOL_ERROR", "Google Discovery document is not JSON", {
      server: api.server,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CapletsError(
      "DOWNSTREAM_PROTOCOL_ERROR",
      "Google Discovery document is not an object",
    );
  }
  return parsed as GoogleDiscoveryDocument;
}

async function loadGoogleDiscoverySource(
  api: GoogleDiscoveryApiConfig,
  authDir?: string,
): Promise<string> {
  if (api.discoveryPath) {
    return readFile(api.discoveryPath, "utf8");
  }
  if (!api.discoveryUrl) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `${api.server} is missing Google Discovery document source`,
    );
  }
  return fetchDiscoverySource(api, await discoveryAuthHeaders(api, authDir));
}

async function fetchDiscoverySource(
  api: GoogleDiscoveryApiConfig,
  headers: Record<string, string>,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), api.requestTimeoutMs);
  try {
    const response = await fetch(api.discoveryUrl!, {
      headers,
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new CapletsError(
        "DOWNSTREAM_PROTOCOL_ERROR",
        "Google Discovery document request returned a redirect",
      );
    }
    if (!response.ok) {
      throw new CapletsError(
        "DOWNSTREAM_PROTOCOL_ERROR",
        "Google Discovery document request failed",
        { status: response.status },
      );
    }
    return await readLimitedText(response, {
      maxBytes: DEFAULT_DISCOVERY_DOCUMENT_MAX_BYTES,
      errorMessage: "Google Discovery document exceeded byte limit",
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new CapletsError("TOOL_CALL_TIMEOUT", "Google Discovery document request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function discoveryAuthHeaders(
  api: GoogleDiscoveryApiConfig,
  authDir?: string,
): Promise<Record<string, string>> {
  if (api.auth.type === "none") return {};
  if (api.auth.type === "oauth2" || api.auth.type === "oidc") {
    const protectedOrigin = discoveryProtectedResourceOrigin(api, authDir);
    if (!protectedOrigin || !shouldSendDiscoveryAuth(api, protectedOrigin)) return {};
    const bundle = readTokenBundle(api.server, authDir);
    if (!bundle?.accessToken && !bundle?.refreshToken) return {};
    return genericOAuthHeaders({ ...api, baseUrl: protectedOrigin }, authDir);
  }
  if (!api.baseUrl || !shouldSendDiscoveryAuth(api, new URL(api.baseUrl).origin)) return {};
  return authHeaders(api, authDir);
}

async function authHeaders(
  api: GoogleDiscoveryApiConfig,
  authDir?: string,
  resolvedScopes?: string[],
): Promise<Record<string, string>> {
  switch (api.auth.type) {
    case "none":
      return {};
    case "bearer":
      return { authorization: `Bearer ${api.auth.token}` };
    case "headers":
      return api.auth.headers;
    case "oauth2":
    case "oidc":
      return genericOAuthHeaders({ ...api, resolvedScopes }, authDir);
  }
}

function discoveryProtectedResourceOrigin(
  api: GoogleDiscoveryApiConfig,
  authDir?: string,
): string | undefined {
  if (api.baseUrl) return new URL(api.baseUrl).origin;
  const bundle = readTokenBundle(api.server, authDir);
  return bundle?.protectedResourceOrigin;
}

function copySessionAuthorization(
  api: GoogleDiscoveryApiConfig,
  startUrl: URL,
  uploadUrl: URL,
  source: Headers,
  target: Headers,
): void {
  const authorization = source.get("authorization");
  if (!authorization || !isAllowedUploadSessionOrigin(api, startUrl, uploadUrl)) return;
  target.set("authorization", authorization);
}

function isAllowedUploadSessionOrigin(
  api: GoogleDiscoveryApiConfig,
  startUrl: URL,
  uploadUrl: URL,
): boolean {
  if (uploadUrl.origin === startUrl.origin) return true;
  if (api.baseUrl && uploadUrl.origin === new URL(api.baseUrl).origin) return true;
  return isGoogleApiOrigin(uploadUrl);
}

function isGoogleApiOrigin(url: URL): boolean {
  return url.protocol === "https:" && url.hostname.endsWith(".googleapis.com");
}

function shouldRequestMediaDownload(
  operation: GoogleDiscoveryOperation,
  args: Record<string, unknown>,
): boolean {
  return (
    operation.supportsMediaDownload &&
    (typeof args.filename === "string" || typeof args.outputPath === "string")
  );
}

function withMediaDownloadQuery(args: Record<string, unknown>): Record<string, unknown> {
  const query =
    args.query && typeof args.query === "object" && !Array.isArray(args.query)
      ? (args.query as Record<string, unknown>)
      : {};
  return {
    ...args,
    query: {
      ...query,
      alt: "media",
    },
  };
}

function googleAuthError(api: GoogleDiscoveryApiConfig, response: Response): CapletsError {
  return new CapletsError(
    response.status === 401 ? "AUTH_REQUIRED" : "AUTH_FAILED",
    "Google Discovery authentication failed",
    {
      server: api.server,
      status: response.status,
      message: response.statusText,
      authType: api.auth.type,
      challenge: response.headers.get("www-authenticate") ? "[REDACTED]" : undefined,
      ...(api.auth.type === "oauth2" || api.auth.type === "oidc"
        ? { nextAction: "run_caplets_auth_login" }
        : {}),
    },
  );
}

function shouldSendDiscoveryAuth(
  api: GoogleDiscoveryApiConfig,
  protectedResourceOrigin: string,
): boolean {
  return Boolean(api.discoveryUrl && new URL(api.discoveryUrl).origin === protectedResourceOrigin);
}

function googleDiscoveryCacheKey(api: GoogleDiscoveryApiConfig): string {
  return JSON.stringify({
    discoveryPath: api.discoveryPath,
    discoveryUrl: api.discoveryUrl,
    baseUrl: api.baseUrl,
    includeOperations: api.includeOperations,
    excludeOperations: api.excludeOperations,
  });
}
