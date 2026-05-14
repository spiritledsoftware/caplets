export interface BenchmarkPaths {
  repoRoot: string;
  fixtureServerPath: string;
  capletsCliPath: string;
}

export interface BenchmarkCapletsConfigResult {
  configPath: string;
  config: { mcpServers: Record<string, any> };
  repoRoot: string;
  supportDir: string;
  fixtureServerPath: string;
  cleanupPath: string;
  cleanup: () => Promise<void>;
  caplets: {
    command: string;
    args: string[];
    cwd: string;
    env: { CAPLETS_CONFIG: string };
    mcpServer: {
      command: string;
      args: string[];
      cwd: string;
      env: { CAPLETS_CONFIG: string };
    };
  };
}

export declare function getBenchmarkPaths(options?: { repoRoot?: string }): BenchmarkPaths;

export declare function createBenchmarkFixtureMcpServers(options?: {
  repoRoot?: string;
  fixtureServerPath?: string;
  cwd?: string;
  extra?: Record<string, any>;
  [key: string]: any;
}): Record<string, any>;

export declare function stageBenchmarkMcpSupportFiles(options?: {
  rootDir?: string;
  repoRoot?: string;
  supportDir?: string;
}): Promise<{ supportDir: string; fixtureServerPath: string }>;

export declare function createBenchmarkCapletsConfig(options?: {
  rootDir?: string;
  repoRoot?: string;
  capletsCliPath?: string;
  requireBuild?: boolean;
}): Promise<BenchmarkCapletsConfigResult>;
