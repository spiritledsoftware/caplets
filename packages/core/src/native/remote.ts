import { Client } from "@modelcontextprotocol/sdk/client/index";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types";

import { CapletsError } from "../errors";
import { generatedToolInputJsonSchemaForCaplet, operations } from "../generated-tool-input-schema";
import type { ResolvedNativeCapletsServiceOptions } from "./options";
import type {
  NativeCapletsService,
  NativeCapletsToolsChangedListener,
  NativeCapletTool,
} from "./service";
import { nativeCapletToolName, nativeCodeModeRunToolId } from "./tools";

export type RemoteCapletsTool = {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema?: unknown;
};

export type RemoteCapletsClient = {
  listTools(): Promise<RemoteCapletsTool[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  onToolsChanged(listener: () => void): () => void;
  close(): Promise<void>;
};

export type RemoteCapletsClientOptions = ResolvedNativeCapletsServiceOptions & {
  mode: "remote" | "cloud";
};

export type RemoteNativeCapletsServiceOptions = {
  client: RemoteCapletsClient;
  clientFactory?: () => RemoteCapletsClient;
  pollIntervalMs: number;
  authKind?: "self_hosted_remote" | "hosted_cloud";
  writeErr?: (value: string) => void;
};

export function createSdkRemoteCapletsClient(
  options: RemoteCapletsClientOptions["remote"],
): RemoteCapletsClient {
  const client = new Client({ name: "caplets-native", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(options.url, {
    requestInit: options.requestInit,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  // The SDK transport type is narrower than StreamableHTTPClientTransport at compile time,
  // but this is the documented transport used by the streamable HTTP client.
  const ready = client.connect(transport as never);
  const readyObserved = ready.catch(() => undefined);
  const listeners = new Set<() => void>();

  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    for (const listener of listeners) {
      listener();
    }
  });

  return {
    async listTools() {
      await ready;
      const result = await client.listTools();
      return (result.tools ?? []).map((tool) => ({
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      }));
    },
    async callTool(name, args) {
      await ready;
      const toolArguments =
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : undefined;
      return await client.callTool({ name, arguments: toolArguments });
    },
    onToolsChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      listeners.clear();
      await readyObserved;
      await transport.terminateSession().catch(() => undefined);
      await client.close();
    },
  };
}

export class RemoteNativeCapletsService implements NativeCapletsService {
  private tools: NativeCapletTool[] = [];
  private readonly listeners = new Set<NativeCapletsToolsChangedListener>();
  private readonly clientFactory: () => RemoteCapletsClient;
  private client: RemoteCapletsClient;
  private unsubscribeRemote: () => void;
  private readonly pollTimer: ReturnType<typeof setInterval>;
  private closed = false;
  private resetInFlight: Promise<boolean> | undefined;

  constructor(private readonly options: RemoteNativeCapletsServiceOptions) {
    this.client = options.client;
    this.clientFactory = options.clientFactory ?? (() => options.client);
    this.unsubscribeRemote = this.subscribeRemote(this.client);
    this.pollTimer = setInterval(() => {
      void this.reload();
    }, options.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  listTools(): NativeCapletTool[] {
    return [...this.tools];
  }

  async execute(capletId: string, request: unknown): Promise<unknown> {
    try {
      return await this.client.callTool(capletId, request);
    } catch (error) {
      if (isAuthFailure(error)) {
        throw remoteAuthError(this.options.authKind ?? "self_hosted_remote");
      }
      if (isSessionFailure(error)) {
        if (!(await this.resetClient()) || this.closed) {
          throw error;
        }
        try {
          return await this.client.callTool(capletId, request);
        } catch (retryError) {
          if (isAuthFailure(retryError)) {
            throw remoteAuthError(this.options.authKind ?? "self_hosted_remote");
          }
          throw retryError;
        }
      }
      throw error;
    }
  }

  async reload(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    try {
      await this.reloadFromClient();
      return true;
    } catch (error) {
      if (isSessionFailure(error)) {
        try {
          if (!(await this.resetClient()) || this.closed) {
            return false;
          }
          await this.reloadFromClient();
          return !this.closed;
        } catch (retryError) {
          this.warn(`Could not reload remote Caplets tools: ${errorMessage(retryError)}\n`);
          return false;
        }
      }
      this.warn(`Could not reload remote Caplets tools: ${errorMessage(error)}\n`);
      return false;
    }
  }

  onToolsChanged(listener: NativeCapletsToolsChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.pollTimer);
    this.unsubscribeRemote();
    this.listeners.clear();
    await this.client.close();
  }

  private async reloadFromClient(): Promise<void> {
    const tools = (await this.client.listTools()).map(remoteToolToNativeTool);
    const changed = JSON.stringify(tools) !== JSON.stringify(this.tools);
    this.tools = tools;
    if (changed) {
      this.emitToolsChanged();
    }
  }

  private subscribeRemote(client: RemoteCapletsClient): () => void {
    return client.onToolsChanged(() => {
      void this.reload();
    });
  }

  private async resetClient(): Promise<boolean> {
    if (this.resetInFlight) {
      return await this.resetInFlight;
    }
    this.resetInFlight = this.doResetClient();
    try {
      return await this.resetInFlight;
    } finally {
      this.resetInFlight = undefined;
    }
  }

  private async doResetClient(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    this.unsubscribeRemote();
    await this.client.close().catch(() => undefined);
    if (this.closed) {
      return false;
    }
    const nextClient = this.clientFactory();
    if (this.closed) {
      await nextClient.close().catch(() => undefined);
      return false;
    }
    this.client = nextClient;
    this.unsubscribeRemote = this.subscribeRemote(this.client);
    return true;
  }

  private emitToolsChanged(): void {
    const tools = this.listTools();
    for (const listener of this.listeners) {
      listener(tools);
    }
  }

  private warn(message: string): void {
    this.options.writeErr?.(message);
  }
}

function remoteToolToNativeTool(tool: RemoteCapletsTool): NativeCapletTool {
  const toolName = nativeCapletToolName(tool.name);
  const inputSchema = isPlainObject(tool.inputSchema)
    ? tool.inputSchema
    : generatedToolInputJsonSchemaForCaplet({ backend: "tool" });
  return {
    caplet: tool.name,
    toolName,
    title: tool.title ?? tool.name,
    description: [
      tool.description ?? "Remote Caplets tool.",
      "",
      `Native tool name: ${toolName}`,
      `Remote Caplet ID: ${tool.name}`,
    ].join("\n"),
    promptGuidance: [`Use ${toolName} through the remote Caplets service.`],
    ...(tool.name === nativeCodeModeRunToolId ? { codeModeRun: true } : {}),
    inputSchema,
    operationNames: operationNamesFromSchema(inputSchema),
  };
}

function operationNamesFromSchema(schema: Record<string, unknown>): string[] {
  const properties = schema.properties;
  if (!isPlainObject(properties)) return [...operations];
  const operation = properties.operation;
  if (!isPlainObject(operation) || !Array.isArray(operation.enum)) return [...operations];
  return operation.enum.filter((value): value is string => typeof value === "string");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function remoteAuthError(kind: "self_hosted_remote" | "hosted_cloud"): CapletsError {
  return new CapletsError(
    "AUTH_FAILED",
    kind === "hosted_cloud"
      ? "Caplets Cloud authentication failed; run caplets cloud auth login."
      : "Remote Caplets authentication failed; check CAPLETS_REMOTE_TOKEN or CAPLETS_REMOTE_USER and CAPLETS_REMOTE_PASSWORD.",
  );
}

function isSessionFailure(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return /session|transport|connection|connect|closed|invalid/u.test(message);
}

function isAuthFailure(error: unknown): boolean {
  const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  const status = typeof candidate?.status === "number" ? candidate.status : undefined;
  const statusCode = typeof candidate?.statusCode === "number" ? candidate.statusCode : undefined;
  const code = typeof candidate?.code === "number" ? candidate.code : undefined;
  if (
    status === 401 ||
    status === 403 ||
    statusCode === 401 ||
    statusCode === 403 ||
    code === 401 ||
    code === 403
  ) {
    return true;
  }
  return /\b(401|403|unauthorized|forbidden)\b/iu.test(errorMessage(error));
}
