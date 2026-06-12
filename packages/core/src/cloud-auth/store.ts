import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";
import { defaultConfigBaseDir } from "../config/paths";
import { HOSTED_CLOUD_AUTH_SCOPES } from "./types";
import type { RedactedCloudAuthStatus } from "./types";

type CloudAuthPathEnv = Partial<
  Record<"CAPLETS_CLOUD_AUTH_PATH" | "XDG_CONFIG_HOME" | "APPDATA", string>
>;

export type CloudAuthCredentials = {
  version?: 1 | 2 | undefined;
  cloudUrl: string;
  workspaceId: string;
  workspaceSlug?: string | undefined;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  scope?: string[] | undefined;
  tokenType?: string | undefined;
  credentialFamilyId?: string | undefined;
  deviceName?: string | undefined;
  createdAt?: string | undefined;
  lastRefreshAt?: string | undefined;
  selectedWorkspaceSwitchedAt?: string | undefined;
};

export type CloudAuthStoreOptions = {
  path?: string;
  env?: CloudAuthPathEnv;
  home?: string;
  platform?: NodeJS.Platform;
};

export class CloudAuthStore {
  readonly path: string;

  constructor(options: CloudAuthStoreOptions = {}) {
    this.path = options.path ?? cloudAuthPath(options);
  }

  async load(): Promise<CloudAuthCredentials | undefined> {
    if (!existsSync(this.path)) return undefined;
    return migrateCredentials(JSON.parse(readFileSync(this.path, "utf8")));
  }

  async save(credentials: CloudAuthCredentials): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(migrateCredentials(credentials), null, 2)}\n`, {
      mode: 0o600,
    });
  }

  async clear(): Promise<void> {
    rmSync(this.path, { force: true });
  }
}

export function migrateCredentials(value: unknown): CloudAuthCredentials {
  const record = isRecord(value) ? value : {};
  const now = new Date().toISOString();
  return {
    version: 2,
    cloudUrl: stringValue(record.cloudUrl) ?? "https://cloud.caplets.dev",
    workspaceId: stringValue(record.workspaceId) ?? "",
    ...(stringValue(record.workspaceSlug)
      ? { workspaceSlug: stringValue(record.workspaceSlug) }
      : {}),
    accessToken: stringValue(record.accessToken) ?? "",
    refreshToken: stringValue(record.refreshToken) ?? "",
    expiresAt: stringValue(record.expiresAt) ?? now,
    scope: arrayValue(record.scope) ?? [...HOSTED_CLOUD_AUTH_SCOPES],
    tokenType: stringValue(record.tokenType) ?? "Bearer",
    credentialFamilyId: stringValue(record.credentialFamilyId) ?? "legacy_family",
    deviceName: stringValue(record.deviceName) ?? "Caplets CLI",
    createdAt: stringValue(record.createdAt) ?? now,
    lastRefreshAt: stringValue(record.lastRefreshAt) ?? stringValue(record.createdAt) ?? now,
    ...(stringValue(record.selectedWorkspaceSwitchedAt)
      ? { selectedWorkspaceSwitchedAt: stringValue(record.selectedWorkspaceSwitchedAt) }
      : {}),
  };
}

export function redactedCloudAuthStatus(
  credentials: CloudAuthCredentials | undefined,
  now = new Date(),
): RedactedCloudAuthStatus {
  if (!credentials) return { authenticated: false, status: "unauthenticated" };
  const expired = Number.isFinite(Date.parse(credentials.expiresAt))
    ? Date.parse(credentials.expiresAt) <= now.getTime()
    : false;
  const refreshable = expired && Boolean(credentials.refreshToken);
  return {
    authenticated: !expired,
    status: refreshable ? "refreshable" : expired ? "expired" : "authenticated",
    cloudUrl: credentials.cloudUrl,
    workspaceId: credentials.workspaceId,
    ...(credentials.workspaceSlug ? { workspaceSlug: credentials.workspaceSlug } : {}),
    expiresAt: credentials.expiresAt,
    scope: credentials.scope,
    tokenType: credentials.tokenType,
    credentialFamilyId: credentials.credentialFamilyId,
    deviceName: credentials.deviceName,
    createdAt: credentials.createdAt,
    lastRefreshAt: credentials.lastRefreshAt,
    selectedWorkspaceSwitchedAt: credentials.selectedWorkspaceSwitchedAt,
  };
}

export function cloudAuthPath(options: CloudAuthStoreOptions = {}): string {
  const env = options.env ?? process.env;
  if (env.CAPLETS_CLOUD_AUTH_PATH?.trim()) return env.CAPLETS_CLOUD_AUTH_PATH.trim();
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  if (platform === "win32") {
    return win32.join(defaultConfigBaseDir(env, home, platform), "Caplets", "cloud-auth.json");
  }
  return posix.join(defaultConfigBaseDir(env, home, platform), "caplets", "cloud-auth.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function arrayValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") return value.split(/\s+/u).filter(Boolean);
  return undefined;
}
