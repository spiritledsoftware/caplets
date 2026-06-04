import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { CapletsError } from "../../errors";
import { resolveDaemonServeOptions, type RawServeOptions } from "../options";
import {
  readDaemonConfig,
  readDaemonState,
  redactDaemonStatus,
  writeDaemonConfig,
  writeDaemonState,
} from "./config";
import { buildDaemonPlatformDescriptor } from "./platform";
import { createNodeDaemonProcessRunner, daemonServeCommand } from "./process";
import { resolveServeDaemonPaths } from "./paths";
import type {
  DaemonPlatformDescriptor,
  ServeDaemonOperationOptions,
  ServeDaemonOperationResult,
  ServeDaemonStatus,
} from "./types";

export type ServeDaemonServiceResult = {
  enabled: boolean;
  descriptor: DaemonPlatformDescriptor;
  status: ServeDaemonStatus;
};

export async function startDaemon(
  raw: RawServeOptions = {},
  options: ServeDaemonOperationOptions = {},
): Promise<ServeDaemonOperationResult> {
  const paths = resolveServeDaemonPaths(options);
  const processRunner = options.process ?? createNodeDaemonProcessRunner();
  const existing = await daemonStatus({ ...options, process: processRunner });
  if (existing.running) {
    throw new CapletsError("REQUEST_INVALID", "Caplets HTTP daemon is already running.");
  }

  const serve = resolveDaemonServeOptions(raw, options.env ?? process.env);
  const command = daemonServeCommand(serve);
  mkdirSync(paths.logDir, { recursive: true });
  const config = writeDaemonConfig(paths, serve, command);
  const pid = await processRunner.start({
    args: command.args,
    stdoutLog: paths.stdoutLog,
    stderrLog: paths.stderrLog,
    configFile: paths.configFile,
  });
  writeFileSync(paths.pidFile, `${pid}\n`);
  const now = new Date().toISOString();
  const state = writeDaemonState(paths, {
    running: true,
    pid,
    startedAt: now,
    enabled: existing.enabled,
    updatedAt: now,
  });

  return {
    status: redactDaemonStatus({ ...state, paths, config }),
  };
}

export async function stopDaemon(
  options: ServeDaemonOperationOptions = {},
): Promise<ServeDaemonOperationResult> {
  const paths = resolveServeDaemonPaths(options);
  const processRunner = options.process ?? createNodeDaemonProcessRunner();
  const existing = await daemonStatus({ ...options, process: processRunner });
  if (existing.running && existing.pid !== undefined) {
    await processRunner.stop(existing.pid);
  }
  rmSync(paths.pidFile, { force: true });
  const state = writeDaemonState(paths, {
    running: false,
    enabled: existing.enabled,
  });
  return {
    status: redactDaemonStatus({
      ...state,
      paths,
      ...configProperty(readDaemonConfig(paths)),
    }),
  };
}

export async function restartDaemon(
  raw: RawServeOptions = {},
  options: ServeDaemonOperationOptions = {},
): Promise<ServeDaemonOperationResult> {
  await stopDaemon(options);
  return startDaemon(raw, options);
}

export async function daemonStatus(
  options: ServeDaemonOperationOptions = {},
): Promise<ServeDaemonStatus> {
  const paths = resolveServeDaemonPaths(options);
  const processRunner = options.process ?? createNodeDaemonProcessRunner();
  const config = readDaemonConfig(paths);
  const storedState = readDaemonState(paths);
  const pid = readPid(paths.pidFile) ?? storedState?.pid;
  const running = pid === undefined ? false : await processRunner.isRunning(pid);
  if (!running) {
    rmSync(paths.pidFile, { force: true });
  }
  const state = writeDaemonState(paths, {
    running,
    ...(running && pid !== undefined ? { pid } : {}),
    ...(running && storedState?.startedAt ? { startedAt: storedState.startedAt } : {}),
    enabled: storedState?.enabled ?? false,
  });
  return redactDaemonStatus({ ...state, paths, ...(config ? { config } : {}) });
}

export async function enableDaemon(
  options: ServeDaemonOperationOptions = {},
): Promise<ServeDaemonServiceResult> {
  return setDaemonEnabled(true, options);
}

export async function disableDaemon(
  options: ServeDaemonOperationOptions = {},
): Promise<ServeDaemonServiceResult> {
  return setDaemonEnabled(false, options);
}

async function setDaemonEnabled(
  enabled: boolean,
  options: ServeDaemonOperationOptions,
): Promise<ServeDaemonServiceResult> {
  const paths = resolveServeDaemonPaths(options);
  const config = readDaemonConfig(paths);
  const command = config?.command ?? daemonServeCommand(resolveDaemonServeOptions({}, options.env));
  const descriptor = buildDaemonPlatformDescriptor({
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    ...(options.serviceAvailable !== undefined
      ? { serviceAvailable: options.serviceAvailable }
      : {}),
    paths,
    command,
  });
  const current = await daemonStatus(options);
  const state = writeDaemonState(paths, {
    running: current.running,
    ...(current.running && current.pid !== undefined ? { pid: current.pid } : {}),
    ...(current.running && current.startedAt ? { startedAt: current.startedAt } : {}),
    enabled,
  });
  return {
    enabled,
    descriptor,
    status: redactDaemonStatus({ ...state, paths, ...configProperty(config) }),
  };
}

function configProperty(config: ReturnType<typeof readDaemonConfig>): {
  config?: NonNullable<typeof config>;
} {
  return config ? { config } : {};
}

function readPid(path: string): number | undefined {
  try {
    const value = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export { buildDaemonPlatformDescriptor } from "./platform";
export { resolveServeDaemonPaths } from "./paths";
export type {
  DaemonPlatformDescriptor,
  DaemonProcessRunner,
  ServeDaemonConfig,
  ServeDaemonOperationOptions,
  ServeDaemonPaths,
  ServeDaemonState,
  ServeDaemonStatus,
} from "./types";
