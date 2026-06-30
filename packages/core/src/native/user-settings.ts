import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveCapletsRoot, resolveConfigPath } from "../config";

export type NativeDefaults = {
  version: 1;
  source: "setup";
  updatedAt: string;
  daemon: { url: string };
};

export type NativeDefaultsInput = {
  source: "setup";
  daemon: { url: string };
};

export type NativeDefaultsPathOptions = {
  path?: string;
  configPath?: string;
  env?: Record<string, string | undefined> | NodeJS.ProcessEnv;
};

export function nativeDefaultsPath(options: NativeDefaultsPathOptions = {}): string {
  if (options.path) return options.path;
  const configPath = options.configPath ?? options.env?.CAPLETS_CONFIG ?? resolveConfigPath();
  return join(resolveCapletsRoot(configPath), "native-defaults.json");
}

export function writeNativeDefaults(
  input: NativeDefaultsInput,
  options: NativeDefaultsPathOptions & { now?: Date } = {},
): string {
  const path = nativeDefaultsPath(options);
  const defaults: NativeDefaults = {
    version: 1,
    source: input.source,
    updatedAt: (options.now ?? new Date()).toISOString(),
    daemon: { url: input.daemon.url },
  };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(defaults, null, 2)}\n`, { mode: 0o600 });
  return path;
}

export function readNativeDefaults(
  options: NativeDefaultsPathOptions & { writeWarning?: (message: string) => void } = {},
): NativeDefaults | undefined {
  const path = nativeDefaultsPath(options);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isNativeDefaults(parsed)) throw new Error("invalid native defaults shape");
    return parsed;
  } catch (error) {
    options.writeWarning?.(
      `Ignoring Caplets native defaults at ${path}: ${error instanceof Error ? error.message : "invalid file"}`,
    );
    return undefined;
  }
}

function isNativeDefaults(value: unknown): value is NativeDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const daemon = record.daemon as Record<string, unknown> | undefined;
  return (
    record.version === 1 &&
    record.source === "setup" &&
    typeof record.updatedAt === "string" &&
    Boolean(daemon) &&
    typeof daemon?.url === "string"
  );
}
