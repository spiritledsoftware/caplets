import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { CapletsError } from "../errors";
import {
  mergeDaemonEnv,
  readDaemonConfig,
  removeDaemonConfig,
  removeDaemonState,
  writeDaemonConfig,
  writeDaemonState,
} from "./config";
import { ensureDaemonLogFiles, readDaemonLogs } from "./logs";
import { createNativeDaemonManager } from "./manager";
import { resolveDaemonPaths } from "./paths";
import { buildDaemonCommandPlan, resolveDaemonHttpServeOptions } from "./process";
import {
  allocateLoopbackPort,
  assertDaemonHealth,
  probeDaemonHealth,
  validateDaemonCommand,
} from "./validation";
import type {
  DaemonConfig,
  DaemonInstallOptions,
  DaemonInstallResult,
  DaemonLifecycleResult,
  DaemonLogStream,
  DaemonLogsResult,
  DaemonOperationOptions,
  DaemonStatus,
  DaemonUninstallOptions,
  DaemonUninstallResult,
  RawDaemonServeOptions,
} from "./types";

export async function installDaemon(
  install: DaemonInstallOptions = {},
  options: DaemonOperationOptions = {},
): Promise<DaemonInstallResult> {
  assertRestartDecision(install);
  const env = options.env ?? process.env;
  const paths = resolveDaemonPaths(options);
  const manager = options.manager ?? createNativeDaemonManager(options);
  const existing = install.reset ? undefined : readDaemonConfig(paths);
  const daemonEnv = mergeDaemonEnv(existing?.env, install);
  const serve = resolveDaemonHttpServeOptions(mergeServeOptions(existing, install), env);
  const command = buildDaemonCommandPlan({
    serve,
    paths,
    operation: options,
    explicitEnv: daemonEnv.values,
    inheritEnv: daemonEnv.inherit,
  });
  const config: DaemonConfig = {
    instance: "default",
    serve,
    command,
    env: daemonEnv,
    paths,
    updatedAt: (options.now ?? new Date()).toISOString(),
  };
  const descriptor = manager.descriptor(config);
  const plannedActions = ["write-config", "write-descriptor", "register-service"];

  if (install.dryRun) {
    return {
      action: "install",
      status: await daemonStatusSnapshot(options),
      config,
      descriptor,
      dryRun: true,
      plannedActions,
    };
  }

  const existingNative = existing ? await manager.status(existing, paths) : undefined;
  let validation = undefined;
  if (install.validate !== false) {
    const validationConfig =
      existing && existingNative?.running && existing.serve.port === config.serve.port
        ? await temporaryValidationConfig(config, options)
        : config;
    validation = options.validateCommand
      ? await options.validateCommand(validationConfig)
      : await validateDaemonCommand(
          validationConfig,
          options.fetch ? { fetch: options.fetch } : {},
        );
    assertDaemonHealth(validation, "Daemon install validation");
  }

  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  ensureDaemonLogFiles(paths);
  const native = await manager.install(config);
  writeDaemonConfig(paths, config);
  writeDaemonState(paths, {
    instance: "default",
    installed: true,
    running: native.native.running,
    nativeState: native.native.state,
    updatedAt: (options.now ?? new Date()).toISOString(),
    ...(native.native.pid === undefined ? {} : { pid: native.native.pid }),
  });

  if (install.start || install.restart) {
    const action = install.restart ? await manager.restart(config) : await manager.start(config);
    const health = await probeDaemonHealth(config, options.fetch ? { fetch: options.fetch } : {});
    assertDaemonHealth(health, "Native daemon health check");
    writeDaemonState(paths, {
      instance: "default",
      installed: true,
      running: action.native.running,
      nativeState: action.native.state,
      updatedAt: (options.now ?? new Date()).toISOString(),
      ...(action.native.pid === undefined ? {} : { pid: action.native.pid }),
    });
  } else if (existing) {
    const current = existingNative ?? (await manager.status(existing, paths));
    if (current.running && !install.noRestart) {
      if (!options.isInteractive || !options.readPrompt) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Daemon is already running; rerun with --restart, --start, or --no-restart.",
        );
      }
      const answer = await options.readPrompt("Restart the running Caplets daemon now? [y/N] ");
      if (/^y(?:es)?$/iu.test(answer.trim())) await manager.restart(config);
    }
  }

  return {
    action: "install",
    status: await daemonStatus({ ...options, manager }),
    config,
    descriptor,
    ...(validation ? { validation } : {}),
    native,
    dryRun: false,
    plannedActions,
  };
}

async function temporaryValidationConfig(
  config: DaemonConfig,
  options: DaemonOperationOptions,
): Promise<DaemonConfig> {
  const serve = {
    ...config.serve,
    host: "127.0.0.1",
    port: await allocateLoopbackPort(),
    loopback: true,
    warnUnauthenticatedNetwork: false,
  };
  return {
    ...config,
    serve,
    command: buildDaemonCommandPlan({
      serve,
      paths: config.paths,
      operation: options,
      explicitEnv: config.env.values,
      inheritEnv: config.env.inherit,
    }),
  };
}

export async function uninstallDaemon(
  uninstall: DaemonUninstallOptions = {},
  options: DaemonOperationOptions = {},
): Promise<DaemonUninstallResult> {
  const paths = resolveDaemonPaths(options);
  const manager = options.manager ?? createNativeDaemonManager(options);
  const config = readDaemonConfig(paths);
  const removed = uninstall.purge
    ? [paths.descriptorFile, paths.configFile, paths.stateFile, paths.stdoutLog, paths.stderrLog]
    : [paths.descriptorFile];
  if (uninstall.dryRun) {
    return {
      action: "uninstall",
      status: await daemonStatusSnapshot({ ...options, manager }),
      purge: uninstall.purge === true,
      dryRun: true,
      removed,
    };
  }
  const nativeStatus = await manager.status(config, paths);
  if (nativeStatus.running && config) await manager.stop(config);
  const native = await manager.uninstall(config, paths);
  removeDaemonConfig(paths);
  if (uninstall.purge) {
    removeDaemonState(paths);
    rmSync(paths.logDir, { recursive: true, force: true });
    rmSync(dirname(paths.configFile), { recursive: true, force: true });
  }
  const status = uninstall.purge
    ? {
        instance: "default" as const,
        installed: false,
        running: false,
        nativeState: "not_installed" as const,
        paths,
        native: native.native,
      }
    : await daemonStatus({ ...options, manager });
  return {
    action: "uninstall",
    status,
    native,
    purge: uninstall.purge === true,
    dryRun: false,
    removed,
  };
}

export async function startDaemon(
  options: DaemonOperationOptions = {},
): Promise<DaemonLifecycleResult> {
  return daemonLifecycle("start", options);
}

export async function restartDaemon(
  options: DaemonOperationOptions = {},
): Promise<DaemonLifecycleResult> {
  return daemonLifecycle("restart", options);
}

export async function stopDaemon(
  options: DaemonOperationOptions = {},
): Promise<DaemonLifecycleResult> {
  return daemonLifecycle("stop", options);
}

export async function daemonStatus(options: DaemonOperationOptions = {}): Promise<DaemonStatus> {
  return daemonStatusSnapshot(options, { writeState: true });
}

async function daemonStatusSnapshot(
  options: DaemonOperationOptions = {},
  snapshotOptions: { writeState?: boolean } = {},
): Promise<DaemonStatus> {
  const paths = resolveDaemonPaths(options);
  const config = readDaemonConfig(paths);
  const manager = options.manager ?? createNativeDaemonManager(options);
  const native = await manager.status(config, paths);
  if (snapshotOptions.writeState) {
    writeDaemonState(paths, {
      instance: "default",
      installed: native.installed,
      running: native.running,
      nativeState: native.state,
      updatedAt: (options.now ?? new Date()).toISOString(),
      ...(native.pid === undefined ? {} : { pid: native.pid }),
    });
  }
  const status: DaemonStatus = {
    instance: "default",
    installed: native.installed,
    running: native.running,
    nativeState: native.state,
    paths,
    ...(config ? { config } : {}),
    native,
  };
  if (config && native.running) {
    status.health = await probeDaemonHealth(config, options.fetch ? { fetch: options.fetch } : {});
  }
  return status;
}

export function daemonLogs(
  options: DaemonOperationOptions & { stream?: DaemonLogStream; tail?: number } = {},
): DaemonLogsResult {
  return readDaemonLogs(resolveDaemonPaths(options), options);
}

async function daemonLifecycle(
  action: "start" | "restart" | "stop",
  options: DaemonOperationOptions,
): Promise<DaemonLifecycleResult> {
  const paths = resolveDaemonPaths(options);
  const config = readDaemonConfig(paths);
  if (!config || !existsSync(paths.descriptorFile)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Caplets daemon is not installed. Run caplets daemon install${action === "start" || action === "restart" ? " --start" : ""} first.`,
    );
  }
  const manager = options.manager ?? createNativeDaemonManager(options);
  const before = await manager.status(config, paths);
  const effectiveAction = action === "start" && before.running ? "restart" : action;
  const native =
    effectiveAction === "start"
      ? await manager.start(config)
      : effectiveAction === "restart"
        ? await manager.restart(config)
        : await manager.stop(config);
  writeDaemonState(paths, {
    instance: "default",
    installed: native.native.installed,
    running: native.native.running,
    nativeState: native.native.state,
    updatedAt: (options.now ?? new Date()).toISOString(),
    ...(native.native.pid === undefined ? {} : { pid: native.native.pid }),
  });
  const status = await daemonStatus({ ...options, manager });
  if (effectiveAction === "start" || effectiveAction === "restart") {
    assertDaemonHealth(
      status.health ?? {
        ok: false,
        url: "",
        error: "native daemon did not report a running service",
      },
      "Native daemon health check",
    );
  }
  return { action: effectiveAction, native, status };
}

function mergeServeOptions(
  existing: DaemonConfig | undefined,
  install: DaemonInstallOptions,
): RawDaemonServeOptions {
  return {
    ...(install.host !== undefined
      ? { host: install.host }
      : existing?.serve.host
        ? { host: existing.serve.host }
        : {}),
    ...(install.port !== undefined
      ? { port: install.port }
      : existing?.serve.port
        ? { port: existing.serve.port }
        : {}),
    ...(install.path !== undefined
      ? { path: install.path }
      : existing?.serve.path
        ? { path: existing.serve.path }
        : {}),
    ...(install.user !== undefined
      ? { user: install.user }
      : existing?.serve.auth.enabled
        ? { user: existing.serve.auth.user }
        : {}),
    ...(install.password !== undefined
      ? { password: install.password }
      : existing?.serve.auth.enabled
        ? { password: existing.serve.auth.password }
        : {}),
    ...(install.allowUnauthenticatedHttp !== undefined
      ? { allowUnauthenticatedHttp: install.allowUnauthenticatedHttp }
      : existing
        ? { allowUnauthenticatedHttp: existing.serve.allowUnauthenticatedHttp }
        : {}),
    ...(install.trustProxy !== undefined
      ? { trustProxy: install.trustProxy }
      : existing
        ? { trustProxy: existing.serve.trustProxy }
        : {}),
  };
}

function assertRestartDecision(options: DaemonInstallOptions): void {
  const selected = [options.start, options.restart, options.noRestart].filter(Boolean).length;
  if (selected > 1) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "--start, --restart, and --no-restart are mutually exclusive.",
    );
  }
}

export { resolveDaemonPaths } from "./paths";
export { resolveDaemonHttpServeOptions, daemonServeArgs } from "./process";
export { readDaemonConfig, readDaemonState } from "./config";
export { createNativeDaemonManager } from "./manager";
export { followDaemonLogs } from "./logs";
export type {
  DaemonCommandPlan,
  DaemonCommandRunner,
  DaemonConfig,
  DaemonDescriptor,
  DaemonInstallOptions,
  DaemonLogEntry,
  DaemonLogStream,
  DaemonLogsResult,
  DaemonManager,
  DaemonOperationOptions,
  DaemonPaths,
  DaemonStatus,
  NativeDaemonStatus,
  RawDaemonServeOptions,
} from "./types";
