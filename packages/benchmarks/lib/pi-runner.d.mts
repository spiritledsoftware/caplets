import type { ProcessResult } from "./live-agent.d.mts";

export declare const PI_CONFIG_MODES: readonly ["direct-flat", "pi-proxy", "caplets"];
export declare const DEFAULT_PI_COMMAND: string;
export declare const DEFAULT_PI_CONFIG_FILENAME: string;
export declare const piRunner: Readonly<{
  name: string;
  detect: typeof detectPiCli;
  run: typeof runPi;
}>;

export interface PiDetection {
  available: boolean;
  command: string;
  version?: string;
  reason?: string;
}

export interface PiMcpConfig {
  mode: string;
  dir: string;
  path: string;
  settings?: Record<string, any>;
  mcpServers: Record<string, any>;
  supportFiles?: Record<string, any>;
}

export interface PiRunResult extends ProcessResult {
  agent: "pi";
  mode: string;
  model: string | null;
  piVersion?: string | null;
  commandLine: string;
  configPaths: Record<string, string>;
  activeConfigPath: string;
  piCodingAgentDir: string;
  cleanedUp: boolean;
  artifactsPreserved: boolean;
  skipped?: boolean;
  unavailable?: boolean;
  reason?: string;
}

export declare function detectPiCli(options?: {
  command?: string;
  runProcess?: (options: Record<string, any>) => Promise<ProcessResult>;
}): Promise<PiDetection>;

export declare function runPi(options?: Record<string, any>): Promise<PiRunResult>;

export declare function buildPiCommand(options?: {
  command?: string;
  prompt: string;
  model?: string;
  mcpConfigPath?: string;
  extraArgs?: string[];
}): { command: string; args: string[] };

export declare function createPiMcpConfigs(options?: {
  rootDir?: string;
  requireCapletsBuild?: boolean;
}): Promise<{
  rootDir: string;
  configPaths: Record<string, string>;
  configs: Record<string, PiMcpConfig>;
}>;
