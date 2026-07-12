import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import type { CapletsConfig } from "./config";
import { CapletsEngine, type CapletsEngineOptions } from "./engine";
import { CapletsMcpSession, type CapletsMcpSessionOptions, type ToolServer } from "./serve/session";
import {
  assembleCapletsHost,
  type PreparedRuntimeHost,
  type RuntimeEpochCoordinatorOptions,
  type RuntimeEpochLease,
} from "./storage/coordinator";

export type CapletsRuntimeOptions = {
  configPath?: string;
  projectConfigPath?: string;
  authDir?: string;
  artifactDir?: string;
  exposeLocalArtifactPaths?: boolean;
  mediaInlineThresholdBytes?: number;
  mediaArtifactMaxBytes?: number;
  watchDebounceMs?: number;
  server?: ToolServer;
  writeErr?: (value: string) => void;
};

export type AsyncCapletsRuntimeOptions = CapletsRuntimeOptions & RuntimeEpochCoordinatorOptions;

export class CapletsRuntime {
  readonly server: ToolServer;
  private readonly engine: CapletsEngine;
  private readonly session: CapletsMcpSession;
  private readonly ownsEngine: boolean;

  constructor(
    options: CapletsRuntimeOptions = {},
    preparedEngine?: CapletsEngine,
    runtimeLease?: RuntimeEpochLease,
  ) {
    this.ownsEngine = preparedEngine === undefined;
    this.engine = preparedEngine ?? new CapletsEngine(engineOptions(options));
    this.session = new CapletsMcpSession(this.engine, selectSessionOptions(options, runtimeLease));
    this.server = this.session.server;
  }

  async connect(transport: Transport): Promise<void> {
    await this.session.connect(transport);
  }

  scheduleReload(): void {
    this.engine.scheduleReload();
  }

  async reload(): Promise<boolean> {
    const previousGeneration = this.engine.currentExposureGeneration();
    const reloaded = await this.engine.reload();
    if (this.engine.currentExposureGeneration() !== previousGeneration) {
      await this.session.waitForReloadRefresh().catch(() => undefined);
    }
    return reloaded;
  }

  async close(): Promise<void> {
    try {
      await this.session.close();
    } finally {
      if (this.ownsEngine) await this.engine.close();
    }
  }

  currentConfig(): CapletsConfig {
    return this.engine.currentConfig();
  }

  registeredToolIds(): string[] {
    return this.session.registeredToolIds();
  }

  watchedPaths(): string[] {
    return this.engine.watchedPaths();
  }
}

export type PreparedCapletsRuntimeHost = PreparedRuntimeHost & {
  readonly runtime: CapletsRuntime;
};

export async function createAsyncCapletsRuntime(
  options: AsyncCapletsRuntimeOptions = {},
): Promise<PreparedCapletsRuntimeHost> {
  const host = await assembleCapletsHost({
    ...options,
    engineOptions: {
      ...options.engineOptions,
      ...engineOptions(options),
    },
  });
  const lease = host.retain();
  let runtime: CapletsRuntime;
  try {
    runtime = new CapletsRuntime(options, lease.view.engine, lease);
  } catch (error) {
    lease.release();
    await host.close();
    throw error;
  }
  let closed = false;
  return {
    coordinator: host.coordinator,
    get view() {
      return host.coordinator.requireCurrent();
    },
    get engine() {
      return host.coordinator.requireCurrent().engine;
    },
    runtime,
    retain: () => host.coordinator.retain(),
    refresh: () => host.coordinator.refresh(),
    health: () => host.coordinator.health(),
    refreshAtLeast: (generation) => host.refreshAtLeast(generation),
    commit: (envelope) => host.coordinator.commit(envelope),
    close: async () => {
      if (closed) return;
      closed = true;
      await runtime.close();
      await host.coordinator.close();
    },
  };
}

function selectSessionOptions(
  options: CapletsRuntimeOptions,
  runtimeLease?: RuntimeEpochLease,
): CapletsMcpSessionOptions {
  return {
    ...(options.server === undefined ? {} : { server: options.server }),
    ...(options.writeErr === undefined ? {} : { writeErr: options.writeErr }),
    ...(runtimeLease ? { runtimeLease } : {}),
  };
}

function engineOptions(options: CapletsRuntimeOptions): CapletsEngineOptions {
  const engineOptions: CapletsEngineOptions = {};
  if (options.configPath !== undefined) {
    engineOptions.configPath = options.configPath;
  }
  if (options.projectConfigPath !== undefined) {
    engineOptions.projectConfigPath = options.projectConfigPath;
  }
  if (options.authDir !== undefined) {
    engineOptions.authDir = options.authDir;
  }
  if (options.artifactDir !== undefined) {
    engineOptions.artifactDir = options.artifactDir;
  }
  if (options.exposeLocalArtifactPaths !== undefined) {
    engineOptions.exposeLocalArtifactPaths = options.exposeLocalArtifactPaths;
  }
  if (options.mediaInlineThresholdBytes !== undefined) {
    engineOptions.mediaInlineThresholdBytes = options.mediaInlineThresholdBytes;
  }
  if (options.mediaArtifactMaxBytes !== undefined) {
    engineOptions.mediaArtifactMaxBytes = options.mediaArtifactMaxBytes;
  }
  if (options.watchDebounceMs !== undefined) {
    engineOptions.watchDebounceMs = options.watchDebounceMs;
  }
  if (options.writeErr !== undefined) {
    engineOptions.writeErr = options.writeErr;
  }
  return engineOptions;
}
