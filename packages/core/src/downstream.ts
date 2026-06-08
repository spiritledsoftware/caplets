import { Client } from "@modelcontextprotocol/sdk/client/index";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import {
  CompatibilityCallToolResultSchema,
  type CompleteRequestParams,
  type Prompt,
  type Resource,
  type ResourceTemplate as McpResourceTemplate,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  type CompatibilityCallToolResult,
  type Tool,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types";
import type { CapletServerConfig } from "./config";
import {
  classifyRemoteAuthError,
  FileOAuthProvider,
  readTokenBundle,
  staticRemoteHeaders,
} from "./auth";
import { CapletsError, toSafeError } from "./errors";
import type { ServerRegistry } from "./registry";
import { searchToolList } from "./tool-search";

export type CompactTool = {
  name: string;
  description?: string;
  useWhen?: string;
  avoidWhen?: string;
  hasInputSchema: boolean;
  hasOutputSchema: boolean;
  supportsFields: boolean;
  requiredArgs?: string[];
  acceptedArgs?: string[];
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
};

export type CompactResource = {
  id: string;
  kind: "resource";
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  size?: number;
};
export type CompactResourceTemplate = {
  id: string;
  kind: "resourceTemplate";
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
};
export type CompactPrompt = {
  id: string;
  prompt: string;
  description?: string;
  arguments?: Prompt["arguments"];
};

type ManagedConnection = {
  client: Client;
  transport: Transport;
  configFingerprint: string;
  tools?: Tool[] | undefined;
  toolsFetchedAt?: number | undefined;
  resources?: Resource[] | undefined;
  resourcesFetchedAt?: number | undefined;
  resourceTemplates?: McpResourceTemplate[] | undefined;
  resourceTemplatesFetchedAt?: number | undefined;
  prompts?: Prompt[] | undefined;
  promptsFetchedAt?: number | undefined;
  restartingAfterDeath?: boolean;
  closing?: boolean;
};

type PendingConnection = {
  connection: ManagedConnection;
  promise: Promise<ManagedConnection>;
};

export class DownstreamManager {
  private readonly connections = new Map<string, ManagedConnection>();
  private readonly connecting = new Map<string, PendingConnection>();
  private readonly restartState = new Map<string, { restartUsed: boolean; backoffUntil: number }>();

  constructor(
    private registry: ServerRegistry,
    private readonly options: { authDir?: string } = {},
  ) {}

  updateRegistry(registry: ServerRegistry): void {
    this.registry = registry;
  }

  async close(): Promise<void> {
    const connections = [
      ...this.connections.values(),
      ...[...this.connecting.values()].map((pending) => pending.connection),
    ];
    for (const connection of connections) {
      connection.closing = true;
    }
    await Promise.allSettled(connections.map((connection) => connection.transport.close()));
    this.connections.clear();
    this.connecting.clear();
  }

  async closeServer(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId) ?? this.connecting.get(serverId)?.connection;
    this.connections.delete(serverId);
    this.connecting.delete(serverId);
    this.restartState.delete(serverId);
    if (connection) {
      connection.closing = true;
      await connection.transport.close();
    }
  }

  async checkServer(server: CapletServerConfig): Promise<{
    id: string;
    status: string;
    toolCount?: number;
    elapsedMs: number;
    error?: unknown;
  }> {
    const startedAt = Date.now();
    try {
      const connection = await this.connect(server);
      const capabilities = connection.client.getServerCapabilities() ?? {};
      const tools = await this.refreshTools(server, true);
      this.registry.setStatus(server.server, "available");
      const result = {
        id: server.server,
        status: "available",
        capabilities: {
          tools: Boolean(capabilities.tools),
          resources: Boolean(capabilities.resources),
          resourceTemplates: Boolean(capabilities.resources),
          prompts: Boolean(capabilities.prompts),
          completions: Boolean(capabilities.completions),
        },
        toolCount: tools.length,
        elapsedMs: Date.now() - startedAt,
      };
      if (capabilities.resources) {
        Object.assign(result, {
          resourceCount: (await this.listResources(server, true)).length,
          resourceTemplateCount: (await this.listResourceTemplates(server, true)).length,
        });
      }
      if (capabilities.prompts) {
        Object.assign(result, { promptCount: (await this.listPrompts(server, true)).length });
      }
      return result;
    } catch (error) {
      const safe = toSafeError(error, "SERVER_UNAVAILABLE");
      this.registry.setStatus(server.server, "unavailable", safe);
      return {
        id: server.server,
        status: "unavailable",
        elapsedMs: Date.now() - startedAt,
        error: safe,
      };
    }
  }

  async listTools(server: CapletServerConfig): Promise<Tool[]> {
    return this.refreshTools(server, false);
  }

  async getTool(server: CapletServerConfig, toolName: string): Promise<Tool> {
    const tools = await this.refreshTools(server, false);
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new CapletsError(
        "TOOL_NOT_FOUND",
        `Tool ${toolName} was not found on ${server.server}`,
        {
          server: server.server,
          tool: toolName,
          suggestions: nearbyToolNames(tools, toolName),
        },
      );
    }
    return tool;
  }

  async callTool(
    server: CapletServerConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CompatibilityCallToolResult> {
    await this.getTool(server, toolName);
    const connection = await this.connect(server);
    try {
      return await connection.client.callTool(
        { name: toolName, arguments: args },
        CompatibilityCallToolResultSchema,
        { timeout: server.callTimeoutMs },
      );
    } catch (error) {
      if (isAuthRemediationError(error)) {
        this.registry.setStatus(server.server, "unavailable", toSafeError(error));
        throw error;
      }
      if (isTimeoutLike(error)) {
        throw new CapletsError(
          "TOOL_CALL_TIMEOUT",
          `Tool call timed out for ${server.server}/${toolName}`,
        );
      }
      throw new CapletsError(
        "DOWNSTREAM_TOOL_ERROR",
        `Downstream tool failed for ${server.server}/${toolName}`,
        toSafeError(error),
      );
    }
  }

  async listResources(server: CapletServerConfig, force = false): Promise<Resource[]> {
    const connection = await this.assertCapability(server, "resources");
    if (
      !force &&
      connection.resources &&
      this.isCacheFresh(connection.resourcesFetchedAt, server.toolCacheTtlMs)
    )
      return connection.resources;
    const resources: Resource[] = [];
    let cursor: string | undefined;
    do {
      const result = await connection.client.listResources(cursor ? { cursor } : undefined, {
        timeout: server.startupTimeoutMs,
      });
      resources.push(...(result.resources ?? []));
      cursor = result.nextCursor;
    } while (cursor);
    connection.resources = resources;
    connection.resourcesFetchedAt = Date.now();
    return resources;
  }

  async listResourceTemplates(
    server: CapletServerConfig,
    force = false,
  ): Promise<McpResourceTemplate[]> {
    const connection = await this.assertCapability(server, "resources");
    if (
      !force &&
      connection.resourceTemplates &&
      this.isCacheFresh(connection.resourceTemplatesFetchedAt, server.toolCacheTtlMs)
    )
      return connection.resourceTemplates;
    const resourceTemplates: McpResourceTemplate[] = [];
    let cursor: string | undefined;
    do {
      const result = await connection.client.listResourceTemplates(
        cursor ? { cursor } : undefined,
        { timeout: server.startupTimeoutMs },
      );
      resourceTemplates.push(...(result.resourceTemplates ?? []));
      cursor = result.nextCursor;
    } while (cursor);
    connection.resourceTemplates = resourceTemplates;
    connection.resourceTemplatesFetchedAt = Date.now();
    return resourceTemplates;
  }

  async readResource(server: CapletServerConfig, uri: string) {
    const connection = await this.assertCapability(server, "resources");
    try {
      return await connection.client.readResource({ uri }, { timeout: server.callTimeoutMs });
    } catch (error) {
      throw new CapletsError(
        "DOWNSTREAM_RESOURCE_ERROR",
        `Downstream resource read failed for ${server.server}/${uri}`,
        toSafeError(error),
      );
    }
  }

  async listPrompts(server: CapletServerConfig, force = false): Promise<Prompt[]> {
    const connection = await this.assertCapability(server, "prompts");
    if (
      !force &&
      connection.prompts &&
      this.isCacheFresh(connection.promptsFetchedAt, server.toolCacheTtlMs)
    )
      return connection.prompts;
    const prompts: Prompt[] = [];
    let cursor: string | undefined;
    do {
      const result = await connection.client.listPrompts(cursor ? { cursor } : undefined, {
        timeout: server.startupTimeoutMs,
      });
      prompts.push(...(result.prompts ?? []));
      cursor = result.nextCursor;
    } while (cursor);
    connection.prompts = prompts;
    connection.promptsFetchedAt = Date.now();
    return prompts;
  }

  async getPrompt(server: CapletServerConfig, promptName: string, args: Record<string, unknown>) {
    const prompts = await this.listPrompts(server);
    if (!prompts.some((prompt) => prompt.name === promptName))
      throw new CapletsError(
        "PROMPT_NOT_FOUND",
        `Prompt ${promptName} was not found on ${server.server}`,
      );
    const connection = await this.connect(server);
    try {
      return await connection.client.getPrompt(
        { name: promptName, arguments: stringifyPromptArgs(args) },
        { timeout: server.callTimeoutMs },
      );
    } catch (error) {
      throw new CapletsError(
        "DOWNSTREAM_PROMPT_ERROR",
        `Downstream prompt failed for ${server.server}/${promptName}`,
        toSafeError(error),
      );
    }
  }

  async complete(
    server: CapletServerConfig,
    request: {
      ref: { type: "prompt"; name: string } | { type: "resourceTemplate"; uri: string };
      argument: { name: string; value: string };
    },
  ) {
    const connection = await this.assertCapability(server, "completions");
    const params: CompleteRequestParams = {
      ref:
        request.ref.type === "prompt"
          ? { type: "ref/prompt", name: request.ref.name }
          : { type: "ref/resource", uri: request.ref.uri },
      argument: request.argument,
    };
    try {
      return await connection.client.complete(params, { timeout: server.callTimeoutMs });
    } catch (error) {
      throw new CapletsError(
        "DOWNSTREAM_COMPLETION_ERROR",
        `Downstream completion failed for ${server.server}`,
        toSafeError(error),
      );
    }
  }

  compact(server: CapletServerConfig, tool: Tool): CompactTool {
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

  compactResource(server: CapletServerConfig, resource: Resource): CompactResource {
    return {
      id: server.server,
      kind: "resource",
      uri: resource.uri,
      ...(resource.name ? { name: resource.name } : {}),
      ...(resource.description ? { description: resource.description } : {}),
      ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
      ...(typeof resource.size === "number" ? { size: resource.size } : {}),
    };
  }
  compactResourceTemplate(
    server: CapletServerConfig,
    template: McpResourceTemplate,
  ): CompactResourceTemplate {
    return {
      id: server.server,
      kind: "resourceTemplate",
      uriTemplate: template.uriTemplate,
      ...(template.name ? { name: template.name } : {}),
      ...(template.description ? { description: template.description } : {}),
      ...(template.mimeType ? { mimeType: template.mimeType } : {}),
    };
  }
  compactPrompt(server: CapletServerConfig, prompt: Prompt): CompactPrompt {
    return {
      id: server.server,
      prompt: prompt.name,
      ...(prompt.description ? { description: prompt.description } : {}),
      ...(prompt.arguments ? { arguments: prompt.arguments } : {}),
    };
  }

  searchResources(
    server: CapletServerConfig,
    resources: Resource[],
    query: string,
    limit: number,
  ): CompactResource[] {
    const lower = query.toLocaleLowerCase();
    return resources
      .map((resource) => this.compactResource(server, resource))
      .filter((resource) =>
        [resource.uri, resource.name, resource.description, resource.mimeType].some((value) =>
          value?.toLocaleLowerCase().includes(lower),
        ),
      )
      .slice(0, limit);
  }
  searchResourceTemplates(
    server: CapletServerConfig,
    templates: McpResourceTemplate[],
    query: string,
    limit: number,
  ): CompactResourceTemplate[] {
    const lower = query.toLocaleLowerCase();
    return templates
      .map((template) => this.compactResourceTemplate(server, template))
      .filter((template) =>
        [template.uriTemplate, template.name, template.description, template.mimeType].some(
          (value) => value?.toLocaleLowerCase().includes(lower),
        ),
      )
      .slice(0, limit);
  }
  searchPrompts(
    server: CapletServerConfig,
    prompts: Prompt[],
    query: string,
    limit: number,
  ): CompactPrompt[] {
    const lower = query.toLocaleLowerCase();
    return prompts
      .map((prompt) => this.compactPrompt(server, prompt))
      .filter((prompt) =>
        [
          prompt.prompt,
          prompt.description,
          ...(prompt.arguments ?? []).flatMap((arg) => [arg.name, arg.description]),
        ].some((value) => value?.toLocaleLowerCase().includes(lower)),
      )
      .slice(0, limit);
  }

  search(server: CapletServerConfig, tools: Tool[], query: string, limit: number): CompactTool[] {
    return searchToolList(tools, query, limit, (tool) => this.compact(server, tool));
  }

  private async assertCapability(
    server: CapletServerConfig,
    capability: "resources" | "prompts" | "completions",
  ): Promise<ManagedConnection> {
    const connection = await this.connect(server);
    const capabilities = connection.client.getServerCapabilities();
    if (!capabilities?.[capability])
      throw new CapletsError(
        "UNSUPPORTED_CAPABILITY",
        `${server.server} does not advertise MCP ${capability}`,
        { server: server.server, capability },
      );
    return connection;
  }

  private isCacheFresh(fetchedAt: number | undefined, ttlMs: number): boolean {
    return fetchedAt !== undefined && ttlMs > 0 && Date.now() - fetchedAt <= ttlMs;
  }

  private async refreshTools(server: CapletServerConfig, force: boolean): Promise<Tool[]> {
    const connection = await this.connect(server);
    const now = Date.now();
    const isFresh =
      connection.tools &&
      connection.toolsFetchedAt !== undefined &&
      server.toolCacheTtlMs > 0 &&
      now - connection.toolsFetchedAt <= server.toolCacheTtlMs;
    if (!force && isFresh) {
      return connection.tools ?? [];
    }

    try {
      const result = await connection.client.listTools(undefined, {
        timeout: server.startupTimeoutMs,
      });
      connection.tools = result.tools ?? [];
      connection.toolsFetchedAt = Date.now();
      this.registry.setStatus(server.server, "available");
      return result.tools ?? [];
    } catch (error) {
      const safe = toSafeError(
        error,
        isTimeoutLike(error) ? "SERVER_START_TIMEOUT" : "DOWNSTREAM_PROTOCOL_ERROR",
      );
      this.registry.setStatus(server.server, "unavailable", safe);
      if (isAuthRemediationError(error)) {
        throw error;
      }
      throw new CapletsError(safe.code, `Could not list tools for ${server.server}`, safe);
    }
  }

  private async connect(server: CapletServerConfig): Promise<ManagedConnection> {
    const expectedFingerprint = this.currentServerFingerprint(server);
    const existing = this.connections.get(server.server);
    if (existing) {
      if (existing.configFingerprint !== expectedFingerprint) {
        this.connections.delete(server.server);
        existing.closing = true;
        await existing.transport.close();
      } else {
        return existing;
      }
    }
    const pending = this.connecting.get(server.server);
    if (pending) {
      if (pending.connection.configFingerprint !== expectedFingerprint) {
        this.connecting.delete(server.server);
        pending.connection.closing = true;
        await pending.connection.transport.close();
      } else {
        return await pending.promise;
      }
    }
    if (this.currentServerFingerprint(server) !== expectedFingerprint) {
      throw staleServerConfigError(server.server);
    }
    const currentServer = this.currentServer(server.server);
    if (!sameServerConfig(currentServer, server)) {
      throw staleServerConfigError(server.server);
    }
    const restart = this.restartState.get(server.server);
    if (restart && restart.restartUsed && Date.now() < restart.backoffUntil) {
      throw new CapletsError("SERVER_UNAVAILABLE", `${server.server} is in restart backoff`);
    }

    this.registry.setStatus(server.server, "starting");
    try {
      const client = new Client({ name: "caplets", version: "1.0.0" }, { capabilities: {} });
      const transport = this.createTransport(server);
      const connection: ManagedConnection = {
        client,
        transport,
        configFingerprint: expectedFingerprint,
      };
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        connection.tools = undefined;
        connection.toolsFetchedAt = undefined;
      });
      client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
        connection.resources = undefined;
        connection.resourcesFetchedAt = undefined;
        connection.resourceTemplates = undefined;
        connection.resourceTemplatesFetchedAt = undefined;
      });
      client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
        connection.prompts = undefined;
        connection.promptsFetchedAt = undefined;
      });
      transport.onclose = () => {
        const current = this.connections.get(server.server);
        if (current === connection) {
          this.connections.delete(server.server);
        }
        if (connection.closing) {
          return;
        }
        if (current !== connection) {
          return;
        }
        this.restartState.set(server.server, {
          restartUsed: true,
          backoffUntil: Date.now() + 1_000,
        });
        this.registry.setStatus(
          server.server,
          "unavailable",
          toSafeError(new CapletsError("SERVER_UNAVAILABLE", `${server.server} disconnected`)),
        );
      };
      transport.onerror = (error: Error) => {
        if (connection.closing) {
          return;
        }
        if (this.connections.get(server.server) !== connection) {
          return;
        }
        this.registry.setStatus(
          server.server,
          "unavailable",
          toSafeError(error, "SERVER_UNAVAILABLE"),
        );
      };
      const pendingConnection: PendingConnection = {
        connection,
        promise: this.startConnection(server, expectedFingerprint, connection),
      };
      this.connecting.set(server.server, pendingConnection);
      return await pendingConnection.promise;
    } catch (error) {
      const code = isTimeoutLike(error) ? "SERVER_START_TIMEOUT" : "SERVER_UNAVAILABLE";
      const safe = toSafeError(error, code);
      this.registry.setStatus(server.server, "unavailable", safe);
      if (isAuthRemediationError(error)) {
        throw error;
      }
      throw new CapletsError(code, `Could not start ${server.server}`, safe);
    }
  }

  private async startConnection(
    server: CapletServerConfig,
    expectedFingerprint: string,
    connection: ManagedConnection,
  ): Promise<ManagedConnection> {
    try {
      await connection.client.connect(connection.transport, { timeout: server.startupTimeoutMs });
      if (connection.closing) {
        await connection.transport.close();
        throw new CapletsError("SERVER_UNAVAILABLE", `${server.server} connection was closed`);
      }
      if (this.currentServerFingerprint(server) !== expectedFingerprint) {
        connection.closing = true;
        await connection.transport.close();
        throw staleServerConfigError(server.server);
      }
      const pending = this.connecting.get(server.server);
      if (pending?.connection !== connection) {
        connection.closing = true;
        await connection.transport.close();
        throw new CapletsError("SERVER_UNAVAILABLE", `${server.server} connection was replaced`);
      }
      this.connecting.delete(server.server);
      this.connections.set(server.server, connection);
      this.registry.setStatus(server.server, "available");
      return connection;
    } catch (error) {
      const pending = this.connecting.get(server.server);
      if (pending?.connection === connection) {
        this.connecting.delete(server.server);
      }
      throw error;
    }
  }

  private createTransport(server: CapletServerConfig): any {
    if (server.transport === "stdio") {
      return new StdioClientTransport({
        command: server.command!,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env
          ? {
              env: Object.fromEntries(
                Object.entries({ ...process.env, ...server.env }).filter(
                  ([, value]) => value !== undefined,
                ),
              ) as Record<string, string>,
            }
          : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
        stderr: "pipe",
      });
    }

    if (!server.url) {
      throw new CapletsError("CONFIG_INVALID", `${server.server} is missing url`);
    }

    const headers = staticRemoteHeaders(server);
    const requestInit = Object.keys(headers).length ? { headers } : undefined;
    const authProvider = this.oauthProvider(server);
    const fetchWithAuthClassification = async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const response = await fetch(input, init);
      const authError = classifyRemoteAuthError(server, response);
      if (authError) {
        throw authError;
      }
      return response;
    };
    const fetchWithOAuthAuthClassification = async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const response = await fetch(input, init);
      if (response.status === 403) {
        const authError = classifyRemoteAuthError(server, response);
        if (authError) {
          throw authError;
        }
      }
      return response;
    };
    if (server.transport === "http") {
      return new StreamableHTTPClientTransport(new URL(server.url), {
        ...(requestInit ? { requestInit } : {}),
        ...(authProvider ? { authProvider } : {}),
        fetch: authProvider ? fetchWithOAuthAuthClassification : fetchWithAuthClassification,
      });
    }
    if (server.transport === "sse") {
      return new SSEClientTransport(new URL(server.url), {
        ...(requestInit ? { requestInit } : {}),
        ...(authProvider ? { authProvider } : {}),
        fetch: authProvider ? fetchWithOAuthAuthClassification : fetchWithAuthClassification,
      });
    }

    throw new CapletsError("UNSUPPORTED_TRANSPORT", `Unsupported transport for ${server.server}`);
  }

  private oauthProvider(server: CapletServerConfig): FileOAuthProvider | undefined {
    if (server.auth?.type !== "oauth2" && server.auth?.type !== "oidc") {
      return undefined;
    }
    const bundle = readTokenBundle(server.server, this.options.authDir);
    if (!bundle?.accessToken && !bundle?.refreshToken) {
      throw new CapletsError("AUTH_REQUIRED", `OAuth credentials required for ${server.server}`, {
        server: server.server,
        authType: server.auth.type,
        nextAction: "run_caplets_auth_login",
      });
    }
    return new FileOAuthProvider(
      server,
      server.auth.redirectUri ?? "http://127.0.0.1/callback",
      (_url: URL) => {
        throw new CapletsError("AUTH_REQUIRED", `OAuth credentials required for ${server.server}`, {
          server: server.server,
          authType: server.auth?.type,
          nextAction: "run_caplets_auth_login",
        });
      },
      this.options.authDir,
    );
  }

  private currentServer(serverId: string): CapletServerConfig {
    const current = this.registry.require(serverId);
    if (current.backend !== "mcp") {
      throw staleServerConfigError(serverId);
    }
    return current;
  }

  private currentServerFingerprint(server: CapletServerConfig): string {
    const current = this.currentServer(server.server);
    if (!sameServerConfig(current, server)) {
      throw staleServerConfigError(server.server);
    }
    return serializeServerConfig(current);
  }
}

export function compactToolSafetyHints(
  tool: Tool,
): Pick<CompactTool, "readOnlyHint" | "destructiveHint"> {
  const annotations = tool.annotations;
  return {
    ...(typeof annotations?.readOnlyHint === "boolean"
      ? { readOnlyHint: annotations.readOnlyHint }
      : {}),
    ...(typeof annotations?.destructiveHint === "boolean"
      ? { destructiveHint: annotations.destructiveHint }
      : {}),
  };
}

export function compactToolSchemaHints(
  tool: Tool,
): Pick<CompactTool, "requiredArgs" | "acceptedArgs"> {
  const schema = isRecord(tool.inputSchema) ? tool.inputSchema : undefined;
  const properties = isRecord(schema?.properties) ? schema.properties : {};
  const acceptedArgs = Object.keys(properties).sort();
  const requiredArgs = Array.isArray(schema?.required)
    ? schema.required.filter((value): value is string => typeof value === "string").sort()
    : [];
  return {
    ...(requiredArgs.length > 0 ? { requiredArgs } : {}),
    ...(acceptedArgs.length > 0 ? { acceptedArgs } : {}),
  };
}

export function compactToolSelectionHints(
  tool: unknown,
): Pick<CompactTool, "useWhen" | "avoidWhen"> {
  if (!isRecord(tool)) return {};
  return {
    ...(typeof tool.useWhen === "string" && tool.useWhen.trim()
      ? { useWhen: tool.useWhen.trim() }
      : {}),
    ...(typeof tool.avoidWhen === "string" && tool.avoidWhen.trim()
      ? { avoidWhen: tool.avoidWhen.trim() }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameServerConfig(left: CapletServerConfig, right: CapletServerConfig): boolean {
  return serializeServerConfig(left) === serializeServerConfig(right);
}

function serializeServerConfig(server: CapletServerConfig): string {
  return JSON.stringify(server);
}

function staleServerConfigError(serverId: string): CapletsError {
  return new CapletsError("SERVER_UNAVAILABLE", `${serverId} configuration changed; retry request`);
}

function nearbyToolNames(tools: Tool[], needle: string): string[] {
  const lower = needle.toLocaleLowerCase();
  return tools
    .map((tool) => tool.name)
    .filter((name) => name.toLocaleLowerCase().includes(lower[0] ?? ""))
    .sort()
    .slice(0, 5);
}

function isTimeoutLike(error: unknown): boolean {
  return error instanceof Error && /timeout|timed out|aborted/i.test(error.message);
}

function stringifyPromptArgs(args: Record<string, unknown>): Record<string, string> {
  const stringified: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      stringified[key] = value;
      continue;
    }
    const serialized = JSON.stringify(value);
    if (typeof serialized === "string") stringified[key] = serialized;
  }
  return stringified;
}

function isAuthRemediationError(error: unknown): error is CapletsError {
  return (
    error instanceof CapletsError &&
    (error.code === "AUTH_REQUIRED" || error.code === "AUTH_FAILED")
  );
}
