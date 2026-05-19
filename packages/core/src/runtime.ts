import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CapletsConfig } from "./config";
import { CapletsEngine, type CapletsEngineOptions } from "./engine";
import { CapletsMcpSession, type ToolServer } from "./serve/session";

type CapletsRuntimeOptions = {
  configPath?: string;
  projectConfigPath?: string;
  authDir?: string;
  watchDebounceMs?: number;
  server?: ToolServer;
  writeErr?: (value: string) => void;
};

export class CapletsRuntime {
  readonly server: ToolServer;
  private readonly engine: CapletsEngine;
  private readonly session: CapletsMcpSession;

  constructor(options: CapletsRuntimeOptions = {}) {
    this.engine = new CapletsEngine(engineOptions(options));
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
    return await this.engine.reload();
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

function selectSessionOptions(options: CapletsRuntimeOptions): { server?: ToolServer } {
  return options.server === undefined ? {} : { server: options.server };
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
  if (options.watchDebounceMs !== undefined) {
    engineOptions.watchDebounceMs = options.watchDebounceMs;
  }
  if (options.writeErr !== undefined) {
    engineOptions.writeErr = options.writeErr;
  }
  return engineOptions;
}
