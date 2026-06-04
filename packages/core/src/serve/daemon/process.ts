import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type { HttpServeOptions } from "../options";
import type { DaemonCommandPlan, DaemonProcessRunner, DaemonProcessStart } from "./types";

export function daemonServeCommand(options: HttpServeOptions): DaemonCommandPlan {
  return {
    executable: process.argv[1] ?? "caplets",
    args: daemonServeArgs(options),
  };
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
    "--user",
    options.auth.user,
  ];
  if (options.auth.enabled) {
    args.push("--password", options.auth.password);
  }
  if (options.warnUnauthenticatedNetwork) {
    args.push("--allow-unauthenticated-http");
  }
  if (options.trustProxy) {
    args.push("--trust-proxy");
  }
  return args;
}

export function createNodeDaemonProcessRunner(): DaemonProcessRunner {
  return {
    async isRunning(pid: number): Promise<boolean> {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    async start(command: DaemonProcessStart): Promise<number> {
      mkdirSync(dirname(command.stdoutLog), { recursive: true });
      mkdirSync(dirname(command.stderrLog), { recursive: true });
      const stdout = openSync(command.stdoutLog, "a");
      const stderr = openSync(command.stderrLog, "a");
      try {
        const child = spawn(process.execPath, [process.argv[1] ?? "caplets", ...command.args], {
          detached: true,
          stdio: ["ignore", stdout, stderr],
          env: process.env,
        });
        child.unref();
        return child.pid ?? 0;
      } finally {
        closeSync(stdout);
        closeSync(stderr);
      }
    },
    async stop(pid: number): Promise<void> {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return;
      }
    },
  };
}
