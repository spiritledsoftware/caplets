import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  DaemonCommandPlan,
  ServeDaemonConfig,
  ServeDaemonPaths,
  ServeDaemonState,
  ServeDaemonStatus,
} from "./types";

export function readDaemonConfig(paths: ServeDaemonPaths): ServeDaemonConfig | undefined {
  return readJson<ServeDaemonConfig>(paths.configFile);
}

export function writeDaemonConfig(
  paths: ServeDaemonPaths,
  serve: ServeDaemonConfig["serve"],
  command: DaemonCommandPlan,
  now = new Date(),
): ServeDaemonConfig {
  const config: ServeDaemonConfig = {
    instance: "default",
    serve,
    command,
    paths,
    updatedAt: now.toISOString(),
  };
  writeJson(paths.configFile, config);
  return config;
}

export function readDaemonState(paths: ServeDaemonPaths): ServeDaemonState | undefined {
  return readJson<ServeDaemonState>(paths.stateFile);
}

export function writeDaemonState(
  paths: ServeDaemonPaths,
  state: Omit<ServeDaemonState, "instance" | "updatedAt"> & { updatedAt?: string },
  now = new Date(),
): ServeDaemonState {
  const next: ServeDaemonState = {
    instance: "default",
    ...state,
    updatedAt: state.updatedAt ?? now.toISOString(),
  };
  writeJson(paths.stateFile, next);
  return next;
}

export function redactDaemonStatus(status: ServeDaemonStatus): ServeDaemonStatus {
  return redactDaemonValue(status) as ServeDaemonStatus;
}

function redactDaemonValue(value: unknown): unknown {
  if (Array.isArray(value)) return redactDaemonArray(value);
  if (!value || typeof value !== "object") return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    redacted[key] = /password|token|secret|authorization|credential/iu.test(key)
      ? "[REDACTED]"
      : redactDaemonValue(nested);
  }
  return redacted;
}

function redactDaemonArray(value: unknown[]): unknown[] {
  const redacted: unknown[] = [];
  let redactNext = false;
  for (const item of value) {
    if (redactNext) {
      redacted.push("[REDACTED]");
      redactNext = false;
      continue;
    }
    redacted.push(redactDaemonValue(item));
    if (
      typeof item === "string" &&
      /--(?:password|token|secret|authorization|credential)$/iu.test(item)
    ) {
      redactNext = true;
    }
  }
  return redacted;
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
