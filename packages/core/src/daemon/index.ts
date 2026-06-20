import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  DaemonHealthResult,
  DaemonInstallOptions,
  DaemonInstallResult,
  DaemonLifecycleResult,
  DaemonManager,
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
  const persisted = readDaemonConfig(paths);
  const existing = install.reset ? undefined : persisted;
  const daemonEnv = mergeDaemonEnv(existing?.env, install);
  const serveEnv =
    existing?.serve.publicOrigin && env.CAPLETS_SERVER_URL === undefined
      ? { ...env, CAPLETS_SERVER_URL: existing.serve.publicOrigin }
      : env;
  const serve = resolveDaemonHttpServeOptions(mergeServeOptions(existing, install), serveEnv);
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

  const existingNative =
    persisted || existsSync(paths.descriptorFile)
      ? await manager.status(persisted, paths)
      : undefined;
  const restartDecisionRequired =
    existingNative?.running === true && !install.start && !install.restart && !install.noRestart;
  if (
    restartDecisionRequired &&
    !install.dryRun &&
    (!options.isInteractive || !options.readPrompt)
  ) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Daemon is already running; rerun with --restart, --start, or --no-restart.",
    );
  }

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

  let validation = undefined;
  if (install.validate !== false) {
    validation = await validateInstallCommand({
      config,
      existing: persisted,
      existingNativeRunning: existingNative?.running === true,
      options,
    });
    assertDaemonHealth(validation, "Daemon install validation");
  }

  mkdirSync(paths.logDir, { recursive: true, mode: 0o700 });
  ensureDaemonLogFiles(paths);
  const persistenceBackups = backupPersistenceFiles([paths.configFile, paths.stateFile]);
  const hadExistingDescriptor = existsSync(paths.descriptorFile);
  let native: Awaited<ReturnType<DaemonManager["install"]>> | undefined;
  try {
    writeDaemonConfig(paths, config);
    native = await manager.install(config);
    writeDaemonState(paths, {
      instance: "default",
      installed: true,
      running: native.native.running,
      nativeState: native.native.state,
      updatedAt: (options.now ?? new Date()).toISOString(),
      ...(native.native.pid === undefined ? {} : { pid: native.native.pid }),
    });
  } catch (error) {
    if (native) await rollbackNativeInstall(manager, persisted, paths, hadExistingDescriptor);
    restorePersistenceFiles(persistenceBackups);
    throw error;
  }

  if (install.start || install.restart) {
    const action =
      install.restart || (install.start && existingNative?.running)
        ? await manager.restart(config)
        : await manager.start(config);
    const health = await waitForDaemonHealth(config, options);
    assertDaemonHealth(health, "Native daemon health check");
    writeDaemonState(paths, {
      instance: "default",
      installed: true,
      running: action.native.running,
      nativeState: action.native.state,
      updatedAt: (options.now ?? new Date()).toISOString(),
      ...(action.native.pid === undefined ? {} : { pid: action.native.pid }),
    });
  } else if (restartDecisionRequired && options.readPrompt) {
    const answer = await options.readPrompt("Restart the running Caplets daemon now? [y/N] ");
    if (/^y(?:es)?$/iu.test(answer.trim())) {
      const action = await manager.restart(config);
      const health = await waitForDaemonHealth(config, options);
      assertDaemonHealth(health, "Native daemon health check");
      writeDaemonState(paths, {
        instance: "default",
        installed: true,
        running: action.native.running,
        nativeState: action.native.state,
        updatedAt: (options.now ?? new Date()).toISOString(),
        ...(action.native.pid === undefined ? {} : { pid: action.native.pid }),
      });
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

async function validateInstallCommand(input: {
  config: DaemonConfig;
  existing: DaemonConfig | undefined;
  existingNativeRunning: boolean;
  options: DaemonOperationOptions;
}): Promise<DaemonHealthResult> {
  const useTemporaryPort =
    input.existingNativeRunning &&
    (!input.existing || input.existing.serve.port === input.config.serve.port);
  const attempts = useTemporaryPort ? 3 : 1;
  let last: DaemonHealthResult | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const validationConfig = useTemporaryPort
      ? await temporaryValidationConfig(input.config, input.options)
      : input.config;
    last = input.options.validateCommand
      ? await input.options.validateCommand(validationConfig)
      : await validateDaemonCommand(
          validationConfig,
          input.options.fetch ? { fetch: input.options.fetch } : {},
        );
    if (last.ok) return last;
  }
  return (
    last ?? {
      ok: false,
      url: "",
      error: "daemon install validation did not run",
    }
  );
}

async function waitForDaemonHealth(
  config: DaemonConfig,
  options: DaemonOperationOptions,
): Promise<DaemonHealthResult> {
  const deadline = Date.now() + (options.healthTimeoutMs ?? 10_000);
  const intervalMs = options.healthIntervalMs ?? 200;
  let last: DaemonHealthResult | undefined;
  while (Date.now() < deadline) {
    last = await probeDaemonHealth(config, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      timeoutMs: 1_000,
    });
    if (last.ok) return last;
    await sleep(intervalMs);
  }
  return (
    last ?? {
      ok: false,
      url: "",
      error: "native daemon health probe timed out",
    }
  );
}

export async function uninstallDaemon(
  uninstall: DaemonUninstallOptions = {},
  options: DaemonOperationOptions = {},
): Promise<DaemonUninstallResult> {
  const paths = resolveDaemonPaths(options);
  const manager = options.manager ?? createNativeDaemonManager(options);
  const config = readDaemonConfig(paths);
  const removesWrapper = (options.platform ?? process.platform) === "win32";
  const removed = uninstall.purge
    ? [
        paths.descriptorFile,
        ...(removesWrapper ? [paths.wrapperFile] : []),
        paths.configFile,
        paths.stateFile,
        paths.stdoutLog,
        paths.stderrLog,
      ]
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
  if (nativeStatus.running) await manager.stop(config);
  const native = await manager.uninstall(config, paths);
  if (uninstall.purge) {
    removeDaemonConfig(paths);
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
    ...(config ? { config: redactDaemonConfig(config) } : {}),
    native: redactNativeStatus(native, config),
  };
  if (config && native.running) {
    status.health = await probeDaemonHealth(config, options.fetch ? { fetch: options.fetch } : {});
  }
  return status;
}

export function redactDaemonInstallResult(result: DaemonInstallResult): DaemonInstallResult {
  const secrets = collectDaemonSecrets(result.config);
  return {
    ...result,
    config: redactDaemonConfig(result.config),
    descriptor: redactDescriptor(result.descriptor, secrets),
    ...(result.native
      ? {
          native: {
            ...result.native,
            native: redactNativeStatus(result.native.native, result.config),
            ...(result.native.descriptor
              ? { descriptor: redactDescriptor(result.native.descriptor, secrets) }
              : {}),
          },
        }
      : {}),
  };
}

function redactDaemonConfig(config: DaemonConfig): DaemonConfig {
  const env = redactEnv(config.env.values);
  const serve = redactLegacyDaemonServeAuth(config.serve);
  return {
    ...config,
    env: {
      ...config.env,
      values: env,
    },
    serve: {
      ...serve,
      ...(config.serve.remoteCredentialStateDir ? { remoteCredentialStateDir: "[REDACTED]" } : {}),
    },
    command: {
      ...config.command,
      args: redactSensitiveArgs(config.command.args),
      env: redactEnv(config.command.env),
    },
  };
}

function redactLegacyDaemonServeAuth(serve: DaemonConfig["serve"]): DaemonConfig["serve"] {
  const legacyAuth = legacyDaemonServeAuth(serve);
  if (!legacyAuth?.password) return serve;
  return {
    ...serve,
    auth: {
      ...legacyAuth,
      password: "[redacted]",
    },
  } as unknown as DaemonConfig["serve"];
}

function redactNativeStatus(
  native: DaemonStatus["native"],
  config: DaemonConfig | undefined,
): DaemonStatus["native"] {
  return redactNativeValue(
    native,
    config ? collectDaemonSecrets(config) : [],
  ) as DaemonStatus["native"];
}

function collectDaemonSecrets(config: DaemonConfig): string[] {
  const secrets = Array.from(
    new Set(
      [
        config.serve.remoteCredentialStateDir,
        legacyDaemonServeAuth(config.serve)?.password,
        ...Object.values(config.env.values),
        ...Object.values(config.command.env),
      ].filter((value): value is string => value !== undefined && value.length > 0),
    ),
  );
  return Array.from(new Set(secrets.flatMap(secretRedactionVariants))).sort(
    (left, right) => right.length - left.length,
  );
}

function legacyDaemonServeAuth(
  serve: DaemonConfig["serve"],
): ({ password?: string | undefined } & Record<string, unknown>) | undefined {
  const auth = (serve as { auth?: unknown }).auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return undefined;
  const record = auth as Record<string, unknown>;
  return {
    ...record,
    ...(typeof record.password === "string" ? { password: record.password } : {}),
  };
}

function redactNativeValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return redactSecrets(redactSensitiveFlagString(value), secrets);
  if (Array.isArray(value)) return value.map((item) => redactNativeValue(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactNativeValue(item, secrets)]),
    );
  }
  return value;
}

function redactDescriptor<T>(descriptor: T, secrets: string[]): T {
  return redactNativeValue(descriptor, secrets) as T;
}

function redactEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(env).map((key) => [key, "[redacted]"]));
}

function redactSecrets(value: string, secrets: string[]): string {
  return secrets.reduce((redacted, secret) => redacted.replaceAll(secret, "[redacted]"), value);
}

function secretRedactionVariants(secret: string): string[] {
  const posixShellEscaped = posixShellEscapedSecret(secret);
  const posixShellQuoted = posixShellQuotedSecret(secret);
  return [
    secret,
    jsonEscapedSecret(secret),
    systemdEscapedSecret(secret),
    systemdEscapedSecret(posixShellEscaped),
    systemdEscapedSecret(posixShellQuoted),
    xmlEscapedSecret(secret),
    cmdEscapedSecret(secret),
    powershellSingleQuotedSecret(secret),
    posixShellEscaped,
    posixShellQuoted,
  ].filter((value) => value.length > 0);
}

function jsonEscapedSecret(secret: string): string {
  return JSON.stringify(secret).slice(1, -1);
}

function systemdEscapedSecret(secret: string): string {
  return secret
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", "$$$$")
    .replaceAll("\n", "\\n");
}

function xmlEscapedSecret(secret: string): string {
  return secret
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function cmdEscapedSecret(secret: string): string {
  return secret.replaceAll("%", "%%");
}

function powershellSingleQuotedSecret(secret: string): string {
  return secret.replaceAll("'", "''");
}

function posixShellEscapedSecret(secret: string): string {
  return secret.replaceAll("'", "'\\''");
}

function posixShellQuotedSecret(secret: string): string {
  return `'${posixShellEscapedSecret(secret)}'`;
}

function redactSensitiveFlagString(value: string): string {
  return value.replace(
    /(--(?:password|remote-state-path)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/giu,
    "$1[redacted]",
  );
}

function redactSensitiveArgs(args: string[]): string[] {
  const redacted = [...args];
  for (let index = 0; index < redacted.length; index += 1) {
    if (
      (redacted[index] === "--password" || redacted[index] === "--remote-state-path") &&
      redacted[index + 1]
    ) {
      redacted[index + 1] = "[redacted]";
    }
  }
  return redacted;
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
  if (!config) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Caplets daemon is not installed. Run caplets daemon install${action === "start" || action === "restart" ? " --start" : ""} first.`,
    );
  }
  const manager = options.manager ?? createNativeDaemonManager(options);
  const before = await manager.status(config, paths);
  if (before.state === "not_installed") {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Caplets daemon is not installed. Run caplets daemon install${action === "start" || action === "restart" ? " --start" : ""} first.`,
    );
  }
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
  if (effectiveAction === "start" || effectiveAction === "restart") {
    const health = await waitForDaemonHealth(config, options);
    assertDaemonHealth(health, "Native daemon health check");
    const status = await daemonStatus({ ...options, manager });
    status.health = health;
    return { action: effectiveAction, native, status };
  }
  const status = await daemonStatus({ ...options, manager });
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
    ...(install.remoteStatePath !== undefined
      ? { remoteStatePath: install.remoteStatePath }
      : existing?.serve.remoteCredentialStateDir
        ? { remoteStatePath: existing.serve.remoteCredentialStateDir }
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
    ...(existing &&
    existing.serve.auth.type === "development_unauthenticated" &&
    install.allowUnauthenticatedHttp === undefined
      ? { preserveUnauthenticatedAuth: true }
      : {}),
  };
}

type PersistenceBackup = { path: string; existed: boolean; contents?: Buffer; mode?: number };

function backupPersistenceFiles(paths: string[]): PersistenceBackup[] {
  return paths.map((path) => ({
    path,
    existed: existsSync(path),
    ...(existsSync(path) ? { contents: readFileSync(path) } : {}),
    ...(existsSync(path) ? { mode: statSync(path).mode & 0o777 } : {}),
  }));
}

function restorePersistenceFiles(backups: PersistenceBackup[]): void {
  for (const backup of backups) {
    if (backup.existed && backup.contents) {
      mkdirSync(dirname(backup.path), { recursive: true, mode: 0o700 });
      writeFileSync(backup.path, backup.contents, { mode: backup.mode ?? 0o600 });
      chmodSync(backup.path, backup.mode ?? 0o600);
    } else {
      rmSync(backup.path, { recursive: true, force: true });
    }
  }
}

async function rollbackNativeInstall(
  manager: DaemonManager,
  persisted: DaemonConfig | undefined,
  paths: DaemonConfig["paths"],
  hadExistingDescriptor: boolean,
): Promise<void> {
  try {
    if (persisted && hadExistingDescriptor) {
      await manager.install(persisted);
    } else {
      await manager.uninstall(persisted, paths);
    }
  } catch {
    // Preserve the local persistence failure as the actionable error.
  }
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
