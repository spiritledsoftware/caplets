import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_CONFIG_PATH = join(homedir(), ".caplets", "config.json");
export const DEFAULT_AUTH_DIR = join(homedir(), ".caplets", "auth");
export const PROJECT_CONFIG_FILE = join(".caplets", "config.json");
export const TRUST_PROJECT_CAPLETS_ENV = "CAPLETS_TRUST_PROJECT_CAPLETS";

export function resolveConfigPath(path?: string): string {
  return path ?? DEFAULT_CONFIG_PATH;
}

export function resolveProjectConfigPath(cwd = process.cwd()): string {
  return join(cwd, PROJECT_CONFIG_FILE);
}

export function resolveCapletsRoot(configPath = resolveConfigPath()): string {
  return dirname(configPath);
}

export function resolveProjectCapletsRoot(cwd = process.cwd()): string {
  return join(cwd, ".caplets");
}

export function isTrustedEnvEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}
