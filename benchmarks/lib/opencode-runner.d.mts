import type { ProcessResult } from "./live-agent.d.mts";

export declare const OPENCODE_CONFIG_MODES: readonly ["direct-flat", "caplets"];
export declare const DEFAULT_OPENCODE_COMMAND: string;
export declare const DEFAULT_OPENCODE_CONFIG_FILENAME: string;
export declare const opencodeRunner: Readonly<{
  name: string;
  detect: typeof detectOpenCodeCli;
  run: typeof runOpenCode;
}>;

export interface OpenCodeDetection {
  available: boolean;
  command: string;
  version?: string;
  reason?: string;
}

export interface OpenCodeMcpConfig {
  mode: string;
  dir: string;
  path: string;
  mcp: Record<string, any>;
  supportFiles?: Record<string, any>;
}

export interface OpenCodeRunResult extends ProcessResult {
  agent: "opencode";
  mode: string;
  model: string | null;
  openCodeVersion?: string | null;
  commandLine: string;
  configPaths: Record<string, string>;
  activeConfigPath: string | null;
  activeProjectConfigPath: string | null;
  openCodeStateDir: string;
  configAssumptions: string[];
  cleanedUp: boolean;
  artifactsPreserved: boolean;
  generatedProjectConfigRemoved: boolean;
  skipped?: boolean;
  unavailable?: boolean;
  configConflict?: boolean;
  reason?: string;
}

export declare function detectOpenCodeCli(options?: {
  command?: string;
  runProcess?: (options: Record<string, any>) => Promise<ProcessResult>;
}): Promise<OpenCodeDetection>;

export declare function runOpenCode(options?: Record<string, any>): Promise<OpenCodeRunResult>;

export declare function buildOpenCodeCommand(options?: {
  command?: string;
  prompt: string;
  model?: string;
  workspace: string;
  extraArgs?: string[];
}): { command: string; args: string[] };

export declare function createOpenCodeMcpConfigs(options?: {
  rootDir?: string;
  workspaceDir?: string;
  requireCapletsBuild?: boolean;
}): Promise<{
  rootDir: string;
  configPaths: Record<string, string>;
  configs: Record<string, OpenCodeMcpConfig>;
  workspaceConfigPath: string | null;
  assumptions: string[];
}>;
