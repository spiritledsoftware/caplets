import type { NativeCapletsServiceResolutionInput } from "./options";
import { resolveNativeCapletsServiceOptions } from "./options";
import {
  createSdkRemoteCapletsClient,
  RemoteNativeCapletsService,
  type RemoteCapletsClient,
} from "./remote";
import { CapletsEngine } from "../engine";
import {
  nativeCapletPromptGuidance,
  nativeCapletToolDescription,
  nativeCapletToolName,
} from "./tools";

export type NativeCapletsServiceOptions = NativeCapletsServiceResolutionInput & {
  configPath?: string;
  projectConfigPath?: string;
  authDir?: string;
  watchDebounceMs?: number;
  watch?: boolean;
  writeErr?: (value: string) => void;
  remoteClientFactory?: (
    options: Extract<
      ReturnType<typeof resolveNativeCapletsServiceOptions>,
      { mode: "remote" }
    >["remote"],
  ) => RemoteCapletsClient;
};

export type NativeCapletTool = {
  caplet: string;
  toolName: string;
  title: string;
  description: string;
  promptGuidance: string[];
};

export type NativeCapletsToolsChangedListener = (tools: NativeCapletTool[]) => void;

export type NativeCapletsService = {
  listTools(): NativeCapletTool[];
  execute(capletId: string, request: unknown): Promise<unknown>;
  reload(): Promise<boolean>;
  onToolsChanged(listener: NativeCapletsToolsChangedListener): () => void;
  close(): Promise<void>;
};

export function createNativeCapletsService(
  options: NativeCapletsServiceOptions = {},
): NativeCapletsService {
  const resolved = resolveNativeCapletsServiceOptions(options);
  if (resolved.mode === "remote") {
    const client = (options.remoteClientFactory ?? createSdkRemoteCapletsClient)(resolved.remote);
    return new RemoteNativeCapletsService({
      client,
      pollIntervalMs: resolved.remote.pollIntervalMs,
      ...(options.writeErr ? { writeErr: options.writeErr } : {}),
    });
  }
  return new DefaultNativeCapletsService(options);
}

class DefaultNativeCapletsService implements NativeCapletsService {
  private readonly engine: CapletsEngine;

  constructor(options: NativeCapletsServiceOptions) {
    this.engine = new CapletsEngine(options);
  }

  listTools(): NativeCapletTool[] {
    return this.engine.enabledServers().map((caplet) => {
      const toolName = nativeCapletToolName(caplet.server);
      return {
        caplet: caplet.server,
        toolName,
        title: caplet.name,
        description: nativeCapletToolDescription(toolName, caplet),
        promptGuidance: nativeCapletPromptGuidance(toolName, caplet),
      };
    });
  }

  async execute(capletId: string, request: unknown): Promise<unknown> {
    return await this.engine.execute(capletId, request);
  }

  async reload(): Promise<boolean> {
    return await this.engine.reload();
  }

  onToolsChanged(listener: NativeCapletsToolsChangedListener): () => void {
    return this.engine.onReload(() => listener(this.listTools()));
  }

  async close(): Promise<void> {
    await this.engine.close();
  }
}
