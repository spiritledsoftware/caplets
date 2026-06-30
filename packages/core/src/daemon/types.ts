import type { HttpServeOptions, RawServeOptions } from "../serve/options";

export type DaemonInstance = "default";

export type RawDaemonServeOptions = Omit<RawServeOptions, "transport"> & {
  preserveUnauthenticatedAuth?: boolean;
};

export type DaemonServeOverrides = RawDaemonServeOptions;

export type DaemonPaths = {
  instance: DaemonInstance;
  stateDir: string;
  logDir: string;
  stateFile: string;
  stdoutLog: string;
  stderrLog: string;
  configFile: string;
  descriptorFile: string;
  wrapperFile: string;
};

export type DaemonEnvConfig = {
  inherit: boolean;
  values: Record<string, string>;
};

export type DaemonShellPlan = {
  executable: string;
  args: string[];
  source: "SHELL" | "account" | "fallback";
};

export type DaemonCommandPlan = {
  executable: string;
  args: string[];
  workingDirectory: string;
  env: Record<string, string>;
  inheritEnv: boolean;
  stdoutLog: string;
  stderrLog: string;
  shell?: DaemonShellPlan;
};

export type DaemonConfig = {
  instance: DaemonInstance;
  serve: HttpServeOptions;
  serveOverrides?: DaemonServeOverrides | undefined;
  command: DaemonCommandPlan;
  env: DaemonEnvConfig;
  paths: DaemonPaths;
  updatedAt: string;
};

export type DaemonState = {
  instance: DaemonInstance;
  installed: boolean;
  running: boolean;
  nativeState: NativeDaemonStateName;
  updatedAt: string;
  startedAt?: string;
  pid?: number;
};

export type NativeDaemonStateName =
  | "not_installed"
  | "installed_stopped"
  | "running"
  | "failed"
  | "unavailable"
  | "unknown";

export type NativeDaemonStatus = {
  state: NativeDaemonStateName;
  installed: boolean;
  running: boolean;
  pid?: number;
  raw?: Record<string, unknown>;
  message?: string;
};

export type DaemonStatus = {
  instance: DaemonInstance;
  installed: boolean;
  running: boolean;
  nativeState: NativeDaemonStateName;
  paths: DaemonPaths;
  config?: DaemonConfig;
  native: NativeDaemonStatus;
  health?: DaemonHealthResult;
};

export type DaemonHealthResult = {
  ok: boolean;
  url: string;
  status?: number;
  error?: string;
};

export type DaemonDescriptor =
  | {
      kind: "launchd-user-agent";
      label: string;
      path: string;
      contents: string;
    }
  | {
      kind: "systemd-user";
      unitName: string;
      path: string;
      contents: string;
    }
  | {
      kind: "windows-scheduled-task";
      taskName: string;
      path: string;
      command: string;
      xml: string;
      wrapper: { path: string; contents: string };
    };

export type DaemonManager = {
  descriptor(config: DaemonConfig): DaemonDescriptor;
  status(config: DaemonConfig | undefined, paths: DaemonPaths): Promise<NativeDaemonStatus>;
  install(config: DaemonConfig): Promise<DaemonManagerAction>;
  uninstall(config: DaemonConfig | undefined, paths: DaemonPaths): Promise<DaemonManagerAction>;
  start(config: DaemonConfig): Promise<DaemonManagerAction>;
  restart(config: DaemonConfig): Promise<DaemonManagerAction>;
  stop(config?: DaemonConfig): Promise<DaemonManagerAction>;
};

export type DaemonManagerAction = {
  action: string;
  native: NativeDaemonStatus;
  commands?: string[][];
  descriptor?: DaemonDescriptor;
};

export type DaemonCommandRunner = {
  exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
};

export type DaemonOperationOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
  manager?: DaemonManager;
  commandRunner?: DaemonCommandRunner;
  fetch?: typeof fetch;
  validateCommand?: (config: DaemonConfig) => Promise<DaemonHealthResult>;
  accountShell?: string;
  serviceAvailable?: boolean;
  uid?: number;
  now?: Date;
  readPrompt?: (prompt: string) => Promise<string>;
  isInteractive?: boolean;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
};

export type DaemonInstallOptions = RawDaemonServeOptions & {
  reset?: boolean;
  env?: string[];
  unsetEnv?: string[];
  inheritEnv?: boolean;
  dryRun?: boolean;
  validate?: boolean;
  start?: boolean;
  restart?: boolean;
  noRestart?: boolean;
};

export type DaemonUninstallOptions = {
  purge?: boolean;
  dryRun?: boolean;
};

export type DaemonLifecycleResult = {
  action: string;
  status: DaemonStatus;
  native?: DaemonManagerAction;
};

export type DaemonInstallResult = DaemonLifecycleResult & {
  config: DaemonConfig;
  descriptor: DaemonDescriptor;
  validation?: DaemonHealthResult;
  dryRun: boolean;
  plannedActions: string[];
};

export type DaemonUninstallResult = DaemonLifecycleResult & {
  purge: boolean;
  dryRun: boolean;
  removed: string[];
};

export type DaemonLogStream = "stdout" | "stderr" | "all";

export type DaemonLogEntry = {
  stream: "stdout" | "stderr";
  line: string;
};

export type DaemonLogsResult = {
  paths: Pick<DaemonPaths, "stdoutLog" | "stderrLog">;
  entries: DaemonLogEntry[];
};
