export declare const PROCESS_TERMINATION_BEHAVIOR: string;
export declare const DEFAULT_TIMEOUT_MS: number;
export declare const DEFAULT_KILL_GRACE_MS: number;
export declare const DEFAULT_OUTPUT_MAX_BYTES: number;

export interface LiveAgentRunner<TContext = unknown, TResult = unknown> {
  name: string;
  detect: () => Promise<unknown> | unknown;
  run: (context: TContext) => Promise<TResult> | TResult;
}

export interface ProcessResult {
  command: string;
  args: string[];
  envKeys: string[];
  cwd?: string;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputMaxBytes: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  jsonEvents: unknown[];
  skipped?: boolean;
  unavailable?: boolean;
  configConflict?: boolean;
}

export interface RunProcessOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  killGraceMs?: number;
  outputMaxBytes?: number;
  stdin?: string;
  shell?: boolean;
}

export function createLiveAgentRunner<TContext = unknown, TResult = unknown>(options: {
  name: string;
  detect: () => Promise<unknown> | unknown;
  run: (context: TContext) => Promise<TResult> | TResult;
}): Readonly<LiveAgentRunner<TContext, TResult>>;

export function runProcess(options?: RunProcessOptions): Promise<ProcessResult>;

export function runCommandLine(
  commandLine: string,
  options?: Omit<RunProcessOptions, "command" | "args" | "shell">,
): Promise<ProcessResult>;

export function parseJsonEvents(stdout: string): unknown[];

export function redactOutput(value: string, env?: Record<string, string | undefined>): string;
