import type { NativeCapletsServiceResolutionInput } from "./options";
import { resolveNativeCapletsServiceOptions } from "./options";
import {
  createSdkRemoteCapletsClient,
  RemoteNativeCapletsService,
  type RemoteCapletsClient,
} from "./remote";
import { CapletsEngine } from "../engine";
import { CapletsError } from "../errors";
import {
  nativeCapletPromptGuidance,
  nativeCapletToolDescription,
  nativeCapletToolName,
} from "./tools";
import { loadLocalOverlayConfigWithSources, type CapletsConfig } from "../config";
import { generatedToolInputJsonSchemaForCaplet } from "../generated-tool-input-schema";

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
  localServiceFactory?: (options: LocalNativeCapletsServiceOptions) => NativeCapletsService;
};

export type NativeCapletTool = {
  caplet: string;
  toolName: string;
  title: string;
  description: string;
  promptGuidance: string[];
  inputSchema?: ReturnType<typeof generatedToolInputJsonSchemaForCaplet> | Record<string, unknown>;
  operationNames?: string[];
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
    const localOptions = {
      ...options,
      mode: "local",
      configLoader: createLocalOverlayConfigLoader(options),
    } satisfies LocalNativeCapletsServiceOptions;
    const local = (options.localServiceFactory ?? createDefaultNativeCapletsService)(localOptions);
    try {
      const client = (options.remoteClientFactory ?? createSdkRemoteCapletsClient)(resolved.remote);
      const remote = new RemoteNativeCapletsService({
        client,
        clientFactory: () =>
          (options.remoteClientFactory ?? createSdkRemoteCapletsClient)(resolved.remote),
        pollIntervalMs: resolved.remote.pollIntervalMs,
        ...(options.writeErr ? { writeErr: options.writeErr } : {}),
      });
      return new CompositeNativeCapletsService(remote, local, options);
    } catch (error) {
      void local.close().catch((closeError) => {
        writeErr(
          options,
          `Could not close local overlay Caplets service: ${errorMessage(closeError)}\n`,
        );
      });
      throw error;
    }
  }
  return new DefaultNativeCapletsService(options);
}

type LocalNativeCapletsServiceOptions = NativeCapletsServiceOptions & {
  configLoader?: (configPath: string, projectConfigPath: string) => CapletsConfig;
};

class DefaultNativeCapletsService implements NativeCapletsService {
  private readonly engine: CapletsEngine;

  constructor(options: LocalNativeCapletsServiceOptions) {
    this.engine = new CapletsEngine(options);
  }

  listTools(): NativeCapletTool[] {
    return this.engine.enabledServers().map((caplet) => {
      const toolName = nativeCapletToolName(caplet.server);
      const inputSchema = generatedToolInputJsonSchemaForCaplet(caplet);
      return {
        caplet: caplet.server,
        toolName,
        title: caplet.name,
        description: nativeCapletToolDescription(toolName, caplet),
        promptGuidance: nativeCapletPromptGuidance(toolName, caplet),
        inputSchema,
        operationNames: [...inputSchema.properties.operation.enum],
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

function createDefaultNativeCapletsService(
  options: LocalNativeCapletsServiceOptions,
): NativeCapletsService {
  return new DefaultNativeCapletsService(options);
}

class CompositeNativeCapletsService implements NativeCapletsService {
  private readonly listeners = new Set<NativeCapletsToolsChangedListener>();
  private readonly unsubscribers: Array<() => void>;
  private tools: NativeCapletTool[] = [];
  private closed = false;
  private batchingReload = false;

  constructor(
    private readonly remote: NativeCapletsService,
    private readonly local: NativeCapletsService,
    private readonly options: NativeCapletsServiceOptions,
  ) {
    this.unsubscribers = [
      this.remote.onToolsChanged(() => this.updateMergedTools()),
      this.local.onToolsChanged(() => this.updateMergedTools()),
    ];
    this.tools = this.mergeTools();
  }

  listTools(): NativeCapletTool[] {
    return [...this.tools];
  }

  async execute(capletId: string, request: unknown): Promise<unknown> {
    if (this.local.listTools().some((tool) => tool.caplet === capletId)) {
      return await this.local.execute(capletId, request);
    }
    return await this.remote.execute(capletId, request);
  }

  async reload(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    this.batchingReload = true;
    const remoteReloaded = await this.reloadChild(this.remote, "remote");
    const localReloaded = await this.reloadChild(this.local, "local overlay");
    this.batchingReload = false;
    if (remoteReloaded === undefined || localReloaded === undefined) {
      return false;
    }
    this.updateMergedTools();
    return remoteReloaded || localReloaded;
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
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
    this.listeners.clear();
    await Promise.all([this.remote.close(), this.local.close()]);
  }

  private updateMergedTools(): void {
    if (this.closed || this.batchingReload) {
      return;
    }
    const tools = this.mergeTools();
    if (JSON.stringify(tools) === JSON.stringify(this.tools)) {
      return;
    }
    this.tools = tools;
    for (const listener of this.listeners) {
      try {
        listener(this.listTools());
      } catch (error) {
        writeErr(this.options, `Caplets tools-changed listener failed: ${errorMessage(error)}\n`);
      }
    }
  }

  private mergeTools(): NativeCapletTool[] {
    const localTools = this.local.listTools();
    const localIds = new Set(localTools.map((tool) => tool.caplet));
    return [...this.remote.listTools().filter((tool) => !localIds.has(tool.caplet)), ...localTools];
  }

  private async reloadChild(
    service: NativeCapletsService,
    label: string,
  ): Promise<boolean | undefined> {
    try {
      return await service.reload();
    } catch (error) {
      writeErr(
        this.options,
        `Could not reload composite Caplets tools from ${label}: ${errorMessage(error)}\n`,
      );
      return undefined;
    }
  }
}

function createLocalOverlayConfigLoader(options: NativeCapletsServiceOptions) {
  let hasLoaded = false;
  let previousWarnings = new Set<string>();
  return (configPath: string, projectConfigPath: string): CapletsConfig => {
    const result = loadLocalOverlayConfigWithSources(configPath, projectConfigPath);
    for (const warning of result.warnings) {
      const path = typeof warning.path === "string" ? ` at ${warning.path}` : "";
      writeErr(options, `Caplets local overlay warning${path}: ${warning.message}\n`);
    }
    const warnings = new Set(result.warnings.map(warningKey));
    if (hasLoaded && [...warnings].some((warning) => !previousWarnings.has(warning))) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Caplets local overlay reload produced new warnings; keeping last known-good config.",
      );
    }
    previousWarnings = warnings;
    hasLoaded = true;
    return result.config;
  };
}

function warningKey(warning: { kind: string; path: string; message: string }): string {
  return `${warning.kind}\0${warning.path}\0${warning.message}`;
}

function writeErr(options: NativeCapletsServiceOptions, message: string): void {
  (options.writeErr ?? ((value: string) => process.stderr.write(value)))(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
