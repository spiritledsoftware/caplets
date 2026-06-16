import {
  DEFAULT_COMPLETION_CACHE_DIR,
  type CapletConfig,
  type CapletsConfig,
  type CompletionConfig,
} from "../config";
import { CapletsError } from "../errors";
import {
  completionCacheKey,
  readCompletionCacheEntry,
  writeCompletionCacheEntry,
  type CompletionCandidate,
  type CompletionDiscoveryKind,
} from "./completion-cache";

export type CompletionDiscoveryManagers = {
  listTools?: (server: CapletConfig) => Promise<Array<{ name: string; description?: string }>>;
  listPrompts?: (server: CapletConfig) => Promise<Array<{ name: string; description?: string }>>;
  listResources?: (
    server: CapletConfig,
  ) => Promise<Array<{ uri: string; name?: string; description?: string }>>;
  listResourceTemplates?: (
    server: CapletConfig,
  ) => Promise<Array<{ uriTemplate: string; name?: string; description?: string }>>;
};

export type CompletionDiscoveryOptions = {
  config: CapletsConfig;
  completion?: CompletionConfig | undefined;
  cacheDir?: string | undefined;
  managers?: CompletionDiscoveryManagers | undefined;
  now?: number | undefined;
};

export async function discoverCompletionCandidates(
  serverId: string,
  kind: CompletionDiscoveryKind,
  options: CompletionDiscoveryOptions,
): Promise<CompletionCandidate[]> {
  const server = enabledServer(serverId, options.config);
  if (!server) return [];
  const completion = options.completion ?? options.config.options.completion;
  const now = options.now ?? Date.now();
  const configCandidates = configDefinedCandidates(serverId, kind, options.config);
  const cacheDir = options.cacheDir ?? DEFAULT_COMPLETION_CACHE_DIR;
  const key = completionCacheKey({
    server: server.server,
    backend: server.backend,
    kind,
    fingerprint: completionFingerprint(server, kind, completion),
  });
  const cached = readCompletionCacheEntry(cacheDir, key, now);
  if (cached?.status === "positive" && cached.fresh) return cached.candidates;
  if (cached?.status === "negative" && cached.fresh) return cached.candidates ?? configCandidates;

  try {
    const live = await withTimeout(
      liveCandidates(server, kind, options.managers),
      Math.min(completion.discoveryTimeoutMs, completion.overallTimeoutMs),
    );
    const candidates = dedupeCandidates([...configCandidates, ...live]);
    writeCompletionCacheEntry(cacheDir, key, {
      status: "positive",
      fetchedAt: now,
      expiresAt: now + completion.cacheTtlMs,
      candidates,
    });
    return candidates;
  } catch (error) {
    writeCompletionCacheEntry(cacheDir, key, {
      status: "negative",
      fetchedAt: now,
      expiresAt: now + completion.negativeCacheTtlMs,
      reason: negativeReason(error),
      ...(cached?.status === "positive" ? { candidates: cached.candidates } : {}),
    });
    if (cached?.status === "positive") return cached.candidates;
    return configCandidates;
  }
}

function configDefinedCandidates(
  serverId: string,
  kind: CompletionDiscoveryKind,
  config: CapletsConfig,
): CompletionCandidate[] {
  if (kind !== "tools") return [];
  const cli = config.cliTools[serverId];
  if (cli && !cli.disabled)
    return Object.keys(cli.actions).map((name) => ({ value: `${serverId}.${name}` }));
  const http = config.httpApis[serverId];
  if (http && !http.disabled)
    return Object.keys(http.actions).map((name) => ({ value: `${serverId}.${name}` }));
  const graphql = config.graphqlEndpoints[serverId];
  if (graphql && !graphql.disabled && graphql.operations)
    return Object.keys(graphql.operations).map((name) => ({ value: `${serverId}.${name}` }));
  return [];
}

async function liveCandidates(
  server: CapletConfig,
  kind: CompletionDiscoveryKind,
  managers: CompletionDiscoveryManagers | undefined,
): Promise<CompletionCandidate[]> {
  if (kind === "tools" && managers?.listTools) {
    return (await managers.listTools(server)).map((tool) => ({
      value: `${server.server}.${tool.name}`,
      description: tool.description,
    }));
  }
  if (kind === "tools") return [];
  if (server.backend !== "mcp") return [];
  if (kind === "prompts" && managers?.listPrompts) {
    return (await managers.listPrompts(server)).map((prompt) => ({
      value: `${server.server}.${prompt.name}`,
      description: prompt.description,
    }));
  }
  if (kind === "resources" && managers?.listResources) {
    return (await managers.listResources(server)).map((resource) => ({
      value: resource.uri,
      label: resource.name,
      description: resource.description,
    }));
  }
  if (kind === "resourceTemplates" && managers?.listResourceTemplates) {
    return (await managers.listResourceTemplates(server)).map((template) => ({
      value: template.uriTemplate,
      label: template.name,
      description: template.description,
    }));
  }
  throw new CapletsError(
    "UNSUPPORTED_CAPABILITY",
    `Completion discovery is unsupported for ${kind}`,
  );
}

function completionFingerprint(
  server: CapletConfig,
  kind: CompletionDiscoveryKind,
  completion: CompletionConfig,
): string {
  return JSON.stringify({
    kind,
    completion: {
      discoveryTimeoutMs: completion.discoveryTimeoutMs,
      cacheTtlMs: completion.cacheTtlMs,
      negativeCacheTtlMs: completion.negativeCacheTtlMs,
    },
    server: secretFreeServerShape(server),
  });
}

function secretFreeServerShape(server: CapletConfig): Record<string, unknown> {
  const base = {
    server: server.server,
    backend: server.backend,
    name: server.name,
    description: server.description,
    tags: server.tags,
    disabled: server.disabled,
  };
  switch (server.backend) {
    case "mcp":
      return {
        ...base,
        transport: server.transport,
        command: server.command,
        args: server.args,
        cwd: server.cwd,
        url: server.url,
        authType: server.auth?.type,
        startupTimeoutMs: server.startupTimeoutMs,
        callTimeoutMs: server.callTimeoutMs,
      };
    case "openapi":
      return {
        ...base,
        specPath: server.specPath,
        specUrl: server.specUrl,
        baseUrl: server.baseUrl,
        authType: server.auth.type,
        requestTimeoutMs: server.requestTimeoutMs,
      };
    case "googleDiscovery":
      return {
        ...base,
        discoveryPath: server.discoveryPath,
        discoveryUrl: server.discoveryUrl,
        baseUrl: server.baseUrl,
        includeOperations: server.includeOperations,
        excludeOperations: server.excludeOperations,
        authType: server.auth.type,
        requestTimeoutMs: server.requestTimeoutMs,
      };
    case "graphql":
      return {
        ...base,
        endpointUrl: server.endpointUrl,
        schemaPath: server.schemaPath,
        schemaUrl: server.schemaUrl,
        authType: server.auth.type,
        operationNames: server.operations ? Object.keys(server.operations) : undefined,
      };
    case "http":
      return {
        ...base,
        baseUrl: server.baseUrl,
        authType: server.auth.type,
        actions: Object.fromEntries(
          Object.entries(server.actions).map(([name, action]) => [
            name,
            { method: action.method, path: action.path },
          ]),
        ),
        requestTimeoutMs: server.requestTimeoutMs,
      };
    case "cli":
      return {
        ...base,
        cwd: server.cwd,
        actions: Object.fromEntries(
          Object.entries(server.actions).map(([name, action]) => [
            name,
            { command: action.command, args: action.args, cwd: action.cwd },
          ]),
        ),
        timeoutMs: server.timeoutMs,
        maxOutputBytes: server.maxOutputBytes,
      };
    case "caplets":
      return {
        ...base,
        configPath: server.configPath,
        capletsRoot: server.capletsRoot,
        defaultSearchLimit: server.defaultSearchLimit,
        maxSearchLimit: server.maxSearchLimit,
      };
  }
}

function negativeReason(
  error: unknown,
): "auth_required" | "timeout" | "unavailable" | "unsupported" | "error" {
  if (error instanceof CapletsError) {
    if (
      error.code === "AUTH_REQUIRED" ||
      error.code === "AUTH_FAILED" ||
      error.code === "AUTH_REFRESH_FAILED"
    ) {
      return "auth_required";
    }
    if (error.code === "SERVER_UNAVAILABLE" || error.code === "SERVER_START_TIMEOUT") {
      return "unavailable";
    }
    if (error.code === "UNSUPPORTED_CAPABILITY" || error.code === "UNSUPPORTED_OPERATION") {
      return "unsupported";
    }
    if (error.code === "TOOL_CALL_TIMEOUT" || error.code === "DOWNSTREAM_COMPLETION_ERROR") {
      return "timeout";
    }
  }
  return error instanceof Error && error.message.includes("timeout") ? "timeout" : "error";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("completion discovery timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function enabledServer(serverId: string, config: CapletsConfig): CapletConfig | undefined {
  const server =
    config.mcpServers[serverId] ??
    config.openapiEndpoints[serverId] ??
    config.googleDiscoveryApis[serverId] ??
    config.graphqlEndpoints[serverId] ??
    config.httpApis[serverId] ??
    config.cliTools[serverId] ??
    config.capletSets[serverId];
  return server && !server.disabled ? server : undefined;
}

function dedupeCandidates(candidates: CompletionCandidate[]): CompletionCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.value)) return false;
    seen.add(candidate.value);
    return true;
  });
}
