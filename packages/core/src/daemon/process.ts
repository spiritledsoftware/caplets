import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { defaultConfigPath } from "../config/paths";
import { CapletsError } from "../errors";
import { resolveServeOptions, type HttpServeOptions, type RawServeOptions } from "../serve/options";
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
): HttpServeOptions {
  if ((raw as RawServeOptions).transport !== undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "caplets daemon install does not accept --transport.",
    );
  }
  const serveRaw = { ...raw };
  delete serveRaw.preserveUnauthenticatedAuth;
  return resolveServeOptions({ ...serveRaw, transport: "http" }, env) as HttpServeOptions;
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
    "--path",
    options.path,
  ];
  if (options.auth.type === "remote_credentials" && options.remoteCredentialStateDir) {
    args.push("--remote-state-path", options.remoteCredentialStateDir);
  }
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
  const executable = resolveDaemonExecutable(process.argv[1]);
  const args = daemonServeArgs(options.serve);
  const workingDirectory = options.operation.home ?? homedir();
  const explicitEnv = options.explicitEnv ?? {};
  const serviceEnv = daemonServiceEnv({
    explicitEnv,
    operation: options.operation,
    platform,
    serve: options.serve,
    workingDirectory,
  });
  const base = {
    executable,
    args,
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

function resolveDaemonExecutable(scriptPath: string | undefined): string {
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

function isTransientRunnerPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return /(?:^|\/)_npx(?:\/|$)/u.test(normalized) || /(?:^|\/)dlx-[^/]+(?:\/|$)/u.test(normalized);
}
