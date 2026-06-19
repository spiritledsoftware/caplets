import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CapletsError } from "../errors";
import type {
  DaemonConfig,
  DaemonEnvConfig,
  DaemonInstallOptions,
  DaemonPaths,
  DaemonState,
} from "./types";

export function readDaemonConfig(paths: DaemonPaths): DaemonConfig | undefined {
  return readJson<DaemonConfig>(paths.configFile);
}

export function writeDaemonConfig(paths: DaemonPaths, config: DaemonConfig): DaemonConfig {
  writeJson(paths.configFile, config);
  return config;
}

export function readDaemonState(paths: DaemonPaths): DaemonState | undefined {
  return readJson<DaemonState>(paths.stateFile);
}

export function writeDaemonState(paths: DaemonPaths, state: DaemonState): DaemonState {
  writeJson(paths.stateFile, state);
  return state;
}

export function removeDaemonConfig(paths: DaemonPaths): void {
  rmSync(paths.configFile, { force: true });
}

export function removeDaemonState(paths: DaemonPaths): void {
  rmSync(paths.stateFile, { force: true });
}

export function mergeDaemonEnv(
  existing: DaemonEnvConfig | undefined,
  install: Pick<DaemonInstallOptions, "env" | "unsetEnv" | "inheritEnv">,
): DaemonEnvConfig {
  const values = { ...existing?.values };
  for (const key of install.unsetEnv ?? []) {
    validateEnvName(key);
    delete values[key];
  }
  for (const entry of install.env ?? []) {
    const index = entry.indexOf("=");
    if (index <= 0) {
      throw new CapletsError("REQUEST_INVALID", "--env must use KEY=VALUE");
    }
    const key = entry.slice(0, index);
    validateEnvName(key);
    values[key] = entry.slice(index + 1);
  }
  return {
    inherit: install.inheritEnv ?? existing?.inherit ?? false,
    values,
  };
}

function validateEnvName(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new CapletsError("REQUEST_INVALID", `Invalid environment variable name: ${value}`);
  }
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
