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
export const DEFAULT_COMPLETION_CACHE_DIR = defaultCompletionCacheDir();
export const DEFAULT_OBSERVED_OUTPUT_SHAPE_CACHE_DIR = defaultObservedOutputShapeCacheDir();
export const PROJECT_CONFIG_FILE = join(".caplets", "config.json");

export function resolveConfigPath(path?: string): string {
  return path ?? DEFAULT_CONFIG_PATH;
}

export function resolveProjectConfigPath(cwd = process.cwd()): string {
  return join(displayPath(cwd), PROJECT_CONFIG_FILE);
}

export function resolveCapletsRoot(configPath = resolveConfigPath()): string {
  return dirname(configPath);
}

export function resolveProjectCapletsRoot(cwd = process.cwd()): string {
  return join(displayPath(cwd), ".caplets");
}

function displayPath(path: string): string {
  return path;
}
