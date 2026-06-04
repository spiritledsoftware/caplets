import type { HttpServeOptions, RawServeOptions } from "../options";

export type ServeDaemonInstance = "default";

export type ServeDaemonPaths = {
  instance: ServeDaemonInstance;
  stateDir: string;
  logDir: string;
  stateFile: string;
  pidFile: string;
  stdoutLog: string;
  stderrLog: string;
  configFile: string;
};

export type ServeDaemonConfig = {
  instance: ServeDaemonInstance;
  serve: HttpServeOptions;
  command: DaemonCommandPlan;
  paths: ServeDaemonPaths;
  updatedAt: string;
};

export type ServeDaemonState = {
  instance: ServeDaemonInstance;
  running: boolean;
  pid?: number;
  startedAt?: string;
  updatedAt: string;
  enabled: boolean;
};

export type ServeDaemonStatus = ServeDaemonState & {
  paths: ServeDaemonPaths;
  config?: ServeDaemonConfig;
};

export type DaemonCommandPlan = {
  executable: string;
  args: string[];
};

export type DaemonProcessStart = {
  args: string[];
  stdoutLog: string;
  stderrLog: string;
  configFile: string;
};

export type DaemonProcessRunner = {
  isRunning(pid: number): Promise<boolean>;
  start(command: DaemonProcessStart): Promise<number>;
  stop(pid: number): Promise<void>;
};

export type ServeDaemonOperationOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
  process?: DaemonProcessRunner;
  serviceAvailable?: boolean;
};

export type ServeDaemonStartOptions = ServeDaemonOperationOptions & {
  raw?: RawServeOptions;
};

export type ServeDaemonOperationResult = {
  status: ServeDaemonStatus;
};

export type LaunchdUserAgentDescriptor = {
  kind: "launchd-user-agent";
  label: string;
  path: string;
  plist: string;
};

export type SystemdUserServiceDescriptor = {
  kind: "systemd-user";
  unitName: string;
  path: string;
  unit: string;
};

export type ManualServiceDescriptor = {
  kind: "manual";
  reason: string;
  command: DaemonCommandPlan;
};

export type WindowsScheduledTaskDescriptor = {
  kind: "windows-scheduled-task";
  taskName: string;
  commands: {
    register: string;
    unregister: string;
    query: string;
  };
};

export type DaemonPlatformDescriptor =
  | LaunchdUserAgentDescriptor
  | SystemdUserServiceDescriptor
  | ManualServiceDescriptor
  | WindowsScheduledTaskDescriptor;
