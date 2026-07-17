import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import type { CapletsConfig } from "./config";
import {
  CapletsEngine,
  createCapletsEngine,
  createInternalCapletsEngine,
  type CapletsEngineOptions,
} from "./engine";
import { CapletsMcpSession, type CapletsMcpSessionOptions, type ToolServer } from "./serve/session";
import type { ControlPlaneRuntimeSnapshotLoader } from "./control-plane/snapshot";

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

export class CapletsRuntime {
  readonly server: ToolServer;
  private readonly engine: CapletsEngine;
  private readonly session: CapletsMcpSession;

  constructor(options: CapletsRuntimeOptions, internalEngine: CapletsEngine) {
    this.engine = internalEngine;
    this.session = new CapletsMcpSession(this.engine, selectSessionOptions(options));
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
      await this.engine.close();
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

/** Test-only source seam. This function is intentionally absent from the package root exports. */
export function createUnactivatedCapletsRuntimeForTests(
  options: CapletsRuntimeOptions = {},
): CapletsRuntime {
  return new CapletsRuntime(options, CapletsEngine.unactivatedForTests(engineOptions(options)));
}

export async function createCapletsRuntime(
  options: CapletsRuntimeOptions = {},
): Promise<CapletsRuntime> {
  const engine = await createCapletsEngine(engineOptions(options));
  return new CapletsRuntime(options, engine);
}

export async function createInternalCapletsRuntime(
  options: CapletsRuntimeOptions,
  loader: ControlPlaneRuntimeSnapshotLoader,
): Promise<CapletsRuntime> {
  const engine = await createInternalCapletsEngine(engineOptions(options), loader);
  return new CapletsRuntime(options, engine);
}

function selectSessionOptions(options: CapletsRuntimeOptions): CapletsMcpSessionOptions {
  return {
    ...(options.server === undefined ? {} : { server: options.server }),
    ...(options.writeErr === undefined ? {} : { writeErr: options.writeErr }),
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
