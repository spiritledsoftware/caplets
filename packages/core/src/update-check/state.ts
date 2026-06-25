import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_UPDATE_CHECK_CACHE_DIR, DEFAULT_UPDATE_CHECK_STATE_DIR } from "../config/paths";
import type { PackageVersionMetadata } from "./version";

export const UPDATE_CHECK_PACKAGE_NAME = "caplets";
export const UPDATE_CHECK_REGISTRY_URL = "https://registry.npmjs.org/caplets";
export const UPDATE_CHECK_ACCEPT_HEADER = "application/vnd.npm.install-v1+json";
export const UPDATE_CHECK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_NEGATIVE_TTL_MS = 60 * 60 * 1000;
export const UPDATE_CHECK_LOCK_TTL_MS = 60 * 1000;
export const UPDATE_CHECK_FETCH_TIMEOUT_MS = 250;
export const UPDATE_CHECK_MAX_RESPONSE_BYTES = 1024 * 1024;
export const UPDATE_CHECK_NOTICE_REPEAT_MS = 7 * 24 * 60 * 60 * 1000;

export type UpdateCheckPathsOptions = {
  cacheDir?: string | undefined;
  stateDir?: string | undefined;
};

export type UpdateMetadataCacheEntry =
  | {
      status: "positive";
      fetchedAt: number;
      expiresAt: number;
      staleUntil: number;
      source: typeof UPDATE_CHECK_REGISTRY_URL;
      metadata: PackageVersionMetadata;
    }
  | {
      status: "negative";
      fetchedAt: number;
      expiresAt: number;
      reason: "http" | "timeout" | "invalid" | "network" | "too_large" | "error";
    };

export type ReadUpdateMetadataCacheEntry = UpdateMetadataCacheEntry & {
  fresh: boolean;
  usable: boolean;
};

export type UpdateNoticeState = {
  shown: Record<string, { shownAt: number }>;
};

export function updateCheckCacheDir(options: UpdateCheckPathsOptions = {}): string {
  return options.cacheDir ?? DEFAULT_UPDATE_CHECK_CACHE_DIR;
}

export function updateCheckStateDir(options: UpdateCheckPathsOptions = {}): string {
  return options.stateDir ?? DEFAULT_UPDATE_CHECK_STATE_DIR;
}

export function updateMetadataCachePath(options: UpdateCheckPathsOptions = {}): string {
  return join(updateCheckCacheDir(options), "metadata.json");
}

export function updateRefreshLockPath(options: UpdateCheckPathsOptions = {}): string {
  return join(updateCheckCacheDir(options), "refresh.lock");
}

export function updateNoticeStatePath(options: UpdateCheckPathsOptions = {}): string {
  return join(updateCheckStateDir(options), "notice.json");
}

export function readUpdateMetadataCache(
  options: UpdateCheckPathsOptions & { now?: number | undefined } = {},
): ReadUpdateMetadataCacheEntry | undefined {
  const now = options.now ?? Date.now();
  const parsed = readJson<UpdateMetadataCacheEntry>(updateMetadataCachePath(options));
  if (!parsed) return undefined;
  if (parsed.status === "positive" && isPackageMetadata(parsed.metadata)) {
    return {
      ...parsed,
      fresh: now <= parsed.expiresAt,
      usable: now <= parsed.staleUntil,
    };
  }
  if (parsed.status === "negative" && typeof parsed.reason === "string") {
    return { ...parsed, fresh: now <= parsed.expiresAt, usable: now <= parsed.expiresAt };
  }
  return undefined;
}

export function writeUpdateMetadataCache(
  entry: UpdateMetadataCacheEntry,
  options: UpdateCheckPathsOptions = {},
): boolean {
  return writePrivateJson(updateMetadataCachePath(options), entry);
}

export function readUpdateNoticeState(options: UpdateCheckPathsOptions = {}): UpdateNoticeState {
  const parsed = readJson<UpdateNoticeState>(updateNoticeStatePath(options));
  if (!parsed?.shown || typeof parsed.shown !== "object" || Array.isArray(parsed.shown)) {
    return { shown: {} };
  }

  const shown: UpdateNoticeState["shown"] = {};
  for (const [version, value] of Object.entries(parsed.shown)) {
    if (
      typeof version === "string" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof value.shownAt === "number"
    ) {
      shown[version] = { shownAt: value.shownAt };
    }
  }
  return { shown };
}

export function shouldShowUpdateNotice(
  version: string,
  options: UpdateCheckPathsOptions & { now?: number | undefined } = {},
): boolean {
  const now = options.now ?? Date.now();
  const shownAt = readUpdateNoticeState(options).shown[version]?.shownAt;
  return shownAt === undefined || now - shownAt >= UPDATE_CHECK_NOTICE_REPEAT_MS;
}

export function recordUpdateNoticeShown(
  version: string,
  options: UpdateCheckPathsOptions & { now?: number | undefined } = {},
): boolean {
  const now = options.now ?? Date.now();
  const state = readUpdateNoticeState(options);
  state.shown[version] = { shownAt: now };
  return writePrivateJson(updateNoticeStatePath(options), state);
}

export function acquireUpdateRefreshLock(
  options: UpdateCheckPathsOptions & { now?: number | undefined } = {},
): boolean {
  const now = options.now ?? Date.now();
  const path = updateRefreshLockPath(options);
  if (createUpdateRefreshLock(path, now)) return true;

  const existing = readJson<{ lockedAt?: unknown }>(path);
  if (
    typeof existing?.lockedAt === "number" &&
    now - existing.lockedAt < UPDATE_CHECK_LOCK_TTL_MS
  ) {
    return false;
  }
  if (!existing && !existsSync(path)) return false;

  try {
    rmSync(path, { force: true });
  } catch {
    return false;
  }
  return createUpdateRefreshLock(path, now);
}

export function releaseUpdateRefreshLock(options: UpdateCheckPathsOptions = {}): void {
  try {
    rmSync(updateRefreshLockPath(options), { force: true });
  } catch {
    // Update-check state is best effort.
  }
}

export function writePrivateJson(path: string, value: unknown): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

function createUpdateRefreshLock(path: string, now: number): boolean {
  let fd: number | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify({ lockedAt: now }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Update-check state is best effort.
      }
    }
  }
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function isPackageMetadata(value: unknown): value is PackageVersionMetadata {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as PackageVersionMetadata).packageName === UPDATE_CHECK_PACKAGE_NAME &&
    typeof (value as PackageVersionMetadata).distTags === "object" &&
    !Array.isArray((value as PackageVersionMetadata).distTags) &&
    Array.isArray((value as PackageVersionMetadata).versions)
  );
}
