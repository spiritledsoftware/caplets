import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import type { ResolvedNativeCapletsServiceOptions } from "./options";
import type {
  NativeCapletsService,
  NativeCapletsToolsChangedListener,
  NativeCapletTool,
} from "./service";
import { nativeCapletToolName } from "./tools";

export type RemoteCapletsTool = {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
};

export type RemoteCapletsClient = {
  listTools(): Promise<RemoteCapletsTool[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  onToolsChanged(listener: () => void): () => void;
  close(): Promise<void>;
};

export type RemoteCapletsClientOptions = ResolvedNativeCapletsServiceOptions & {
  mode: "remote";
};

export type RemoteNativeCapletsServiceOptions = {
  client: RemoteCapletsClient;
  pollIntervalMs: number;
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
  const ready = client.connect(transport as never);
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
      await client.close();
    },
  };
}

export class RemoteNativeCapletsService implements NativeCapletsService {
  private tools: NativeCapletTool[] = [];
  private readonly listeners = new Set<NativeCapletsToolsChangedListener>();
  private readonly unsubscribeRemote: () => void;
  private readonly pollTimer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private readonly options: RemoteNativeCapletsServiceOptions) {
    this.unsubscribeRemote = options.client.onToolsChanged(() => {
      void this.reload();
    });
    this.pollTimer = setInterval(() => {
      void this.reload();
    }, options.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  listTools(): NativeCapletTool[] {
    return [...this.tools];
  }

  async execute(capletId: string, request: unknown): Promise<unknown> {
    return await this.options.client.callTool(capletId, request);
  }

  async reload(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    try {
      const tools = (await this.options.client.listTools()).map(remoteToolToNativeTool);
      const changed = JSON.stringify(tools) !== JSON.stringify(this.tools);
      this.tools = tools;
      if (changed) {
        this.emitToolsChanged();
      }
      return true;
    } catch (error) {
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
    await this.options.client.close();
  }

  private emitToolsChanged(): void {
    const tools = this.listTools();
    for (const listener of this.listeners) {
      listener(tools);
    }
  }

  private warn(message: string): void {
    if (this.options.writeErr) {
      this.options.writeErr(message);
      return;
    }
    process.stderr.write(message);
  }
}

function remoteToolToNativeTool(tool: RemoteCapletsTool): NativeCapletTool {
  const toolName = nativeCapletToolName(tool.name);
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
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
