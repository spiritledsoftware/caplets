export declare const LIVE_AGENT_MODES: Readonly<{
  pi: readonly ["direct-flat", "pi-proxy", "caplets"];
  opencode: readonly ["direct-flat", "caplets"];
}>;
export declare const DEFAULT_LIVE_AGENT: "pi";
export declare const DEFAULT_RUNS: 1;

export interface LiveBenchmarkOptions {
  agent?: "pi" | "opencode" | "all";
  modes?: string[];
  model?: string;
  tasks?: string[];
  runs?: number;
  timeoutMs?: number;
  outputDir?: string;
  preserveArtifacts?: boolean;
}

export interface LiveBenchmarkMatrixEntry {
  agent: "pi" | "opencode";
  mode: string;
}

export declare function parseLiveArgs(argv?: string[]): Required<
  Omit<LiveBenchmarkOptions, "model" | "tasks" | "modes">
> & {
  model?: string;
  tasks?: string[];
  modes?: string[];
};

export declare function loadTasks(tasksPath?: string): Promise<Record<string, any>[]>;

export declare function buildLiveMatrix(options?: LiveBenchmarkOptions): LiveBenchmarkMatrixEntry[];

export declare function runLiveBenchmark(options?: {
  options?: LiveBenchmarkOptions;
  env?: Record<string, string | undefined>;
  runners?: Record<string, { run: (context: Record<string, any>) => Promise<any> | any }>;
  fixtureRoot?: string;
  fixtureWorkspaceRoot?: string;
  tasksPath?: string;
  now?: () => Date;
}): Promise<{ report: Record<string, any>; jsonPath: string; markdownPath: string }>;

export declare function renderLiveMarkdownReport(report: Record<string, any>): string;
