import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
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
  return resolveServeOptions({ ...raw, transport: "http" }, env) as HttpServeOptions;
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
  if (options.auth.enabled)
    args.push("--user", options.auth.user, "--password", options.auth.password);
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
  const base = {
    executable,
    args,
    workingDirectory,
    env: options.explicitEnv ?? {},
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
