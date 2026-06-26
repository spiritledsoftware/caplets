import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";

type Platform = NodeJS.Platform;
type PathEnv = NodeJS.ProcessEnv;

export function defaultConfigBaseDir(
  env: PathEnv = process.env,
  home = homedir(),
  platform: Platform = process.platform,
): string {
  if (platform === "win32") {
    return env.APPDATA && win32.isAbsolute(env.APPDATA)
      ? env.APPDATA
      : win32.join(home, "AppData", "Roaming");
  }

  return env.XDG_CONFIG_HOME && posix.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : posix.join(home, ".config");
}

export function defaultStateBaseDir(
  env: PathEnv = process.env,
  home = homedir(),
  platform: Platform = process.platform,
): string {
  if (platform === "win32") {
    return env.LOCALAPPDATA && win32.isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : win32.join(home, "AppData", "Local");
  }

  return env.XDG_STATE_HOME && posix.isAbsolute(env.XDG_STATE_HOME)
    ? env.XDG_STATE_HOME
    : posix.join(home, ".local", "state");
}

export function defaultCacheBaseDir(
  env: PathEnv = process.env,
  home = homedir(),
  platform: Platform = process.platform,
): string {
  if (platform === "win32") {
    return env.LOCALAPPDATA && win32.isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA
      : win32.join(home, "AppData", "Local");
  }

  if (platform === "darwin") {
    return posix.join(home, "Library", "Caches");
  }

  return env.XDG_CACHE_HOME && posix.isAbsolute(env.XDG_CACHE_HOME)
    ? env.XDG_CACHE_HOME
    : posix.join(home, ".cache");
}

export function defaultConfigPath(
  env: PathEnv = process.env,
  home = homedir(),
  platform: Platform = process.platform,
): string {
  const pathJoin = platform === "win32" ? win32.join : posix.join;
  return pathJoin(defaultConfigBaseDir(env, home, platform), "caplets", "config.json");
}

export function defaultAuthDir(
  env: PathEnv = process.env,
  home = homedir(),
  platform: Platform = process.platform,
): string {
  const pathJoin = platform === "win32" ? win32.join : posix.join;
  return pathJoin(defaultStateBaseDir(env, home, platform), "caplets", "auth");
}

export function defaultCapletsLockfilePath(
  env: PathEnv = process.env,
  home = homedir(),
  platform: Platform = process.platform,
): string {
  const pathJoin = platform === "win32" ? win32.join : posix.join;
  return pathJoin(defaultStateBaseDir(env, home, platform), "caplets", "caplets.lock.json");
}

export function defaultTelemetryStateDir(
  env: PathEnv = process.env,
  home = homedir(),
  platform: Platform = process.platform,
): string {
  const pathJoin = platform === "win32" ? win32.join : posix.join;
  return pathJoin(defaultStateBaseDir(env, home, platform), "caplets", "telemetry");
}

export function defaultTelemetryIdentityPath(
  env: PathEnv = process.env,
  home = homedir(),
  platform: Platform = process.platform,
): string {
  const pathJoin = platform === "win32" ? win32.join : posix.join;
  return pathJoin(defaultTelemetryStateDir(env, home, platform), "identity.json");
}

export function defaultTelemetryNoticePath(
  env: PathEnv = process.env,
  home = homedir(),
  platform: Platform = process.platform,
): string {
  const pathJoin = platform === "win32" ? win32.join : posix.join;
  return pathJoin(defaultTelemetryStateDir(env, home, platform), "notice.json");
}

export function defaultTelemetryDeliveryHealthPath(
  env: PathEnv = process.env,
  home = homedir(),
  platform: Platform = process.platform,
): string {
  const pathJoin = platform === "win32" ? win32.join : posix.join;
  return pathJoin(defaultTelemetryStateDir(env, home, platform), "delivery-health.json");
}

export function defaultUpdateCheckStateDir(
  env: PathEnv = process.env,
  home = homedir(),
  platform: Platform = process.platform,
): string {
  const pathJoin = platform === "win32" ? win32.join : posix.join;
  return pathJoin(defaultStateBaseDir(env, home, platform), "caplets", "update-check");
}

export function defaultUpdateCheckCacheDir(
  env: PathEnv = process.env,
  home = homedir(),
  platform: Platform = process.platform,
): string {
  const pathJoin = platform === "win32" ? win32.join : posix.join;
  return platform === "win32"
    ? pathJoin(defaultCacheBaseDir(env, home, platform), "caplets", "cache", "update-check")
    : pathJoin(defaultCacheBaseDir(env, home, platform), "caplets", "update-check");
}

export function defaultArtifactDir(
  env: PathEnv = process.env,
  home = homedir(),
  platform: Platform = process.platform,
): string {
  const pathJoin = platform === "win32" ? win32.join : posix.join;
  return pathJoin(defaultStateBaseDir(env, home, platform), "caplets", "artifacts");
}

export function defaultCompletionCacheDir(
  env: PathEnv = process.env,
  home = homedir(),
  platform: Platform = process.platform,
): string {
  const pathJoin = platform === "win32" ? win32.join : posix.join;
  return platform === "win32"
    ? pathJoin(defaultCacheBaseDir(env, home, platform), "caplets", "cache", "completions")
    : pathJoin(defaultCacheBaseDir(env, home, platform), "caplets", "completions");
}

export function defaultObservedOutputShapeCacheDir(
  env: PathEnv = process.env,
  home = homedir(),
  platform: Platform = process.platform,
): string {
  const pathJoin = platform === "win32" ? win32.join : posix.join;
  return platform === "win32"
    ? pathJoin(defaultCacheBaseDir(env, home, platform), "caplets", "cache", "result-shapes")
    : pathJoin(defaultCacheBaseDir(env, home, platform), "caplets", "result-shapes");
}

export const DEFAULT_CONFIG_PATH = defaultConfigPath();
export const DEFAULT_AUTH_DIR = defaultAuthDir();
export const DEFAULT_CAPLETS_LOCKFILE_PATH = defaultCapletsLockfilePath();
export const DEFAULT_ARTIFACT_DIR = defaultArtifactDir();
export const DEFAULT_TELEMETRY_STATE_DIR = defaultTelemetryStateDir();
export const DEFAULT_TELEMETRY_IDENTITY_PATH = defaultTelemetryIdentityPath();
export const DEFAULT_TELEMETRY_NOTICE_PATH = defaultTelemetryNoticePath();
export const DEFAULT_TELEMETRY_DELIVERY_HEALTH_PATH = defaultTelemetryDeliveryHealthPath();
export const DEFAULT_UPDATE_CHECK_STATE_DIR = defaultUpdateCheckStateDir();
export const DEFAULT_UPDATE_CHECK_CACHE_DIR = defaultUpdateCheckCacheDir();
export const DEFAULT_COMPLETION_CACHE_DIR = defaultCompletionCacheDir();
export const DEFAULT_OBSERVED_OUTPUT_SHAPE_CACHE_DIR = defaultObservedOutputShapeCacheDir();
export const PROJECT_CONFIG_FILE = join(".caplets", "config.json");

export function resolveConfigPath(path?: string): string {
  return path ?? DEFAULT_CONFIG_PATH;
}

export function resolveProjectConfigPath(cwd = process.cwd()): string {
  return join(displayPath(cwd), PROJECT_CONFIG_FILE);
}

export function resolveProjectLockfilePath(cwd = process.cwd()): string {
  return join(displayPath(cwd), ".caplets.lock.json");
}

export function resolveCapletsLockfilePath(path?: string): string {
  return path ?? DEFAULT_CAPLETS_LOCKFILE_PATH;
}

export function resolveCapletsRoot(configPath = resolveConfigPath()): string {
  return dirname(configPath);
}

export function resolveTelemetryStateDir(path?: string): string {
  return path ?? DEFAULT_TELEMETRY_STATE_DIR;
}

export function resolveUpdateCheckStateDir(path?: string): string {
  return path ?? DEFAULT_UPDATE_CHECK_STATE_DIR;
}

export function resolveUpdateCheckCacheDir(path?: string): string {
  return path ?? DEFAULT_UPDATE_CHECK_CACHE_DIR;
}

export function resolveProjectCapletsRoot(cwd = process.cwd()): string {
  return join(displayPath(cwd), ".caplets");
}

function displayPath(path: string): string {
  return path;
}
