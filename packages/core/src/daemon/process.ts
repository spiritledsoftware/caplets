import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { defaultConfigPath } from "../config/paths";
import { CapletsError } from "../errors";
import {
  resolveServeOptions,
  type HttpServeOptions,
  type RawServeOptions,
  type ServeDefaults,
} from "../serve/options";
import { DISABLE_UPDATE_CHECK_ENV } from "../update-check/control";
import { resolveDaemonShell } from "./env";
import type {
  DaemonCommandPlan,
  DaemonOperationOptions,
  DaemonPaths,
  RawDaemonServeOptions,
} from "./types";

export function resolveDaemonHttpServeOptions(
  raw: RawDaemonServeOptions,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  defaults?: ServeDefaults | undefined,
): HttpServeOptions {
  if ((raw as RawServeOptions).transport !== undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "caplets daemon install does not accept --transport.",
    );
  }
  const serveRaw = { ...raw };
  if (
    serveRaw.preserveUnauthenticatedAuth === true &&
    serveRaw.allowUnauthenticatedHttp === undefined
  ) {
    serveRaw.allowUnauthenticatedHttp = true;
  }
  delete serveRaw.preserveUnauthenticatedAuth;
  return resolveServeOptions({ ...serveRaw, transport: "http" }, env, defaults) as HttpServeOptions;
}

export function daemonServeArgs(options: HttpServeOptions): string[] {
  const args = [
    "serve",
    "--transport",
    "http",
    "--host",
    options.host,
    "--port",
    String(options.port),
  ];
  args.push(
    "--admin-upload-staging-dir",
    options.adminUploads.stagingDir,
    "--admin-upload-max-concurrent",
    String(options.adminUploads.maxConcurrent),
    "--admin-upload-max-staged-bytes",
    String(options.adminUploads.maxStagedBytes),
  );
  if (options.auth.type === "remote_credentials" && options.remoteCredentialStateDir) {
    args.push("--remote-state-path", options.remoteCredentialStateDir);
  }
  if (options.upstreamUrl) args.push("--upstream-url", options.upstreamUrl);
  if (options.allowUnauthenticatedHttp) args.push("--allow-unauthenticated-http");
  if (options.trustProxy) args.push("--trust-proxy");
  return args;
}

export function buildDaemonCommandPlan(options: {
  serve: HttpServeOptions;
  paths: DaemonPaths;
  operation: Pick<DaemonOperationOptions, "env" | "home" | "platform" | "accountShell">;
  explicitEnv?: Record<string, string>;
  inheritEnv?: boolean;
}): DaemonCommandPlan {
  const platform = options.operation.platform ?? process.platform;
  const command = resolveDaemonCommand({
    env: options.operation.env ?? process.env,
    platform,
    scriptPath: process.argv[1],
    serveArgs: daemonServeArgs(options.serve),
  });
  const workingDirectory = options.operation.home ?? homedir();
  const explicitEnv = options.explicitEnv ?? {};
  const serviceEnv = daemonServiceEnv({
    explicitEnv,
    operation: options.operation,
    platform,
    serve: options.serve,
    workingDirectory,
  });
  if (
    command.pathEnv &&
    serviceEnv.PATH === undefined &&
    serviceEnv.Path === undefined &&
    serviceEnv.path === undefined
  ) {
    serviceEnv.PATH = command.pathEnv;
  }
  const base = {
    executable: command.executable,
    args: command.args,
    workingDirectory,
    env: serviceEnv,
    inheritEnv: options.inheritEnv ?? false,
    stdoutLog: options.paths.stdoutLog,
    stderrLog: options.paths.stderrLog,
  };
  if (!options.inheritEnv) return base;
  return {
    ...base,
    shell: resolveDaemonShell({
      ...(options.operation.env ? { env: options.operation.env } : {}),
      platform,
      ...(options.operation.accountShell ? { accountShell: options.operation.accountShell } : {}),
    }),
  };
}

function daemonServiceEnv(options: {
  explicitEnv: Record<string, string>;
  operation: Pick<DaemonOperationOptions, "env" | "home" | "platform">;
  platform: NodeJS.Platform;
  serve: HttpServeOptions;
  workingDirectory: string;
}): Record<string, string> {
  const env = options.operation.env ?? process.env;
  const selectedConfigEnv = configSelectionEnv(env, options.workingDirectory, options.platform);
  const serviceEnv = { ...selectedConfigEnv, ...options.explicitEnv };
  if (options.serve.publicOrigin && serviceEnv.CAPLETS_SERVER_URL === undefined) {
    serviceEnv.CAPLETS_SERVER_URL = options.serve.publicOrigin;
  }
  serviceEnv[DISABLE_UPDATE_CHECK_ENV] = "1";
  return serviceEnv;
}

function configSelectionEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  home: string,
  platform: NodeJS.Platform,
): Record<string, string> {
  const selected: Record<string, string> = {};
  const configPath = env.CAPLETS_CONFIG?.trim();
  if (configPath) {
    selected.CAPLETS_CONFIG = configPath;
  } else if (env.XDG_CONFIG_HOME?.trim() || (platform === "win32" && env.APPDATA?.trim())) {
    selected.CAPLETS_CONFIG = defaultConfigPath(env, home, platform);
  }
  const projectConfigPath = env.CAPLETS_PROJECT_CONFIG?.trim();
  if (projectConfigPath) selected.CAPLETS_PROJECT_CONFIG = projectConfigPath;
  for (const key of configSelectionEnvKeys(platform)) {
    const value = env[key]?.trim();
    if (value) selected[key] = value;
  }
  return selected;
}

function configSelectionEnvKeys(platform: NodeJS.Platform): string[] {
  return platform === "win32"
    ? ["APPDATA", "LOCALAPPDATA"]
    : ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"];
}

function resolveDaemonCommand(options: {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  platform: NodeJS.Platform;
  scriptPath: string | undefined;
  serveArgs: string[];
}): { executable: string; args: string[]; pathEnv?: string | undefined } {
  const stableCommand = resolvePathCommand("caplets", options.env, options.platform);
  if (stableCommand) {
    return {
      executable: stableCommand,
      args: options.serveArgs,
      pathEnv: pathEnvValue(options.env),
    };
  }
  const script = resolveDaemonCliScript(options.scriptPath);
  return { executable: process.execPath, args: [script, ...options.serveArgs] };
}

function resolveDaemonCliScript(scriptPath: string | undefined): string {
  if (!scriptPath) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Cannot install the daemon because the Caplets CLI path could not be resolved.",
    );
  }
  const executable = isAbsolute(scriptPath) ? scriptPath : resolve(scriptPath);
  if (!existsSync(executable)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Cannot install the daemon because the Caplets CLI path does not exist: ${executable}`,
    );
  }
  const realExecutable = realpathSync(executable);
  if (isTransientRunnerPath(executable) || isTransientRunnerPath(realExecutable)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Cannot install the daemon from a temporary runner such as npx or pnpm dlx. Install caplets first, then rerun caplets daemon install.",
    );
  }
  return executable;
}

function resolvePathCommand(
  command: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string | undefined {
  const path = pathEnvValue(env);
  if (!path) return undefined;
  const delimiter = platform === "win32" ? ";" : ":";
  for (const entry of path.split(delimiter)) {
    const directory = entry.trim();
    if (!directory) continue;
    for (const candidate of pathCommandCandidates(directory, command, env, platform)) {
      if (!isRunnableCommand(candidate, platform)) continue;
      const realCandidate = safeRealpath(candidate);
      if (isTransientRunnerPath(candidate) || isTransientRunnerPath(realCandidate)) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Cannot install the daemon from a temporary runner such as npx or pnpm dlx. Install caplets first, then rerun caplets daemon install.",
        );
      }
      return candidate;
    }
  }
  return undefined;
}

function pathCommandCandidates(
  directory: string,
  command: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string[] {
  const resolved = isAbsolute(directory) ? directory : resolve(directory);
  if (platform !== "win32") return [resolve(resolved, command)];
  const lower = command.toLocaleLowerCase();
  if (/\.[^.\\/]+$/u.test(lower)) return [resolve(resolved, command)];
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);
  return extensions.map((extension) => resolve(resolved, `${command}${extension}`));
}

function pathEnvValue(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string | undefined {
  return env.PATH ?? env.Path ?? env.path;
}

function isRunnableCommand(path: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    if (platform === "win32") return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isTransientRunnerPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return /(?:^|\/)_npx(?:\/|$)/u.test(normalized) || /(?:^|\/)dlx-[^/]+(?:\/|$)/u.test(normalized);
}
