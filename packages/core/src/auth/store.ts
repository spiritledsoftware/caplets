import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { DEFAULT_AUTH_DIR } from "../config/paths";
import { CapletsError } from "../errors";

export type StoredOAuthTokenBundle = {
  server: string;
  authType?: "oauth2" | "oidc" | undefined;
  accessToken: string;
  refreshToken?: string | undefined;
  tokenType?: string | undefined;
  expiresAt?: string | undefined;
  scope?: string | undefined;
  idToken?: string | undefined;
  issuer?: string | undefined;
  subject?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  protectedResourceOrigin?: string | undefined;
  metadata?: Record<string, unknown>;
};

export type StoredOAuthTokenBundleView = {
  bundle: StoredOAuthTokenBundle;
  generation: number;
};

export function isStoredOAuthTokenBundle(value: unknown): value is StoredOAuthTokenBundle {
  if (!isRecord(value)) return false;
  if (typeof value.server !== "string" || !value.server) return false;
  if (typeof value.accessToken !== "string") return false;
  if (value.authType !== undefined && value.authType !== "oauth2" && value.authType !== "oidc") {
    return false;
  }
  for (const field of optionalTokenBundleStringFields) {
    if (value[field] !== undefined && typeof value[field] !== "string") return false;
  }
  return value.metadata === undefined || isRecord(value.metadata);
}

const optionalTokenBundleStringFields = [
  "refreshToken",
  "tokenType",
  "expiresAt",
  "scope",
  "idToken",
  "issuer",
  "subject",
  "clientId",
  "clientSecret",
  "protectedResourceOrigin",
] as const satisfies ReadonlyArray<keyof StoredOAuthTokenBundle>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function authStorePath(server: string, authDir = DEFAULT_AUTH_DIR): string {
  if (!server || server.includes("/") || server.includes("\\") || server.includes("..")) {
    throw new CapletsError("REQUEST_INVALID", `Invalid auth store server name ${server}`);
  }
  const authRoot = resolve(authDir);
  const candidate = resolve(authRoot, `${server}.json`);
  const relativePath = relative(authRoot, candidate);
  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return candidate;
  }
  throw new CapletsError("REQUEST_INVALID", `Invalid auth store server name ${server}`);
}

export function readTokenBundle(
  server: string,
  authDir?: string,
): StoredOAuthTokenBundle | undefined {
  const path = authStorePath(server, authDir);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StoredOAuthTokenBundle;
  } catch {
    return undefined;
  }
}

export function listTokenBundles(authDir?: string): StoredOAuthTokenBundle[] {
  const dir = authDir ?? DEFAULT_AUTH_DIR;
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readTokenBundle(entry.name.slice(0, -".json".length), dir))
    .filter((bundle): bundle is StoredOAuthTokenBundle => Boolean(bundle))
    .sort((left, right) => left.server.localeCompare(right.server));
}

export type LegacyOAuthTokenBundleSnapshot = {
  bundles: StoredOAuthTokenBundle[];
  sourcePaths: string[];
};

/**
 * Strict migration reader. Unlike the runtime compatibility reader, this fails
 * the whole snapshot when any legacy token file is malformed.
 */
export function readLegacyOAuthTokenBundleSnapshot(
  authDir: string,
): LegacyOAuthTokenBundleSnapshot {
  if (!existsSync(authDir)) return { bundles: [], sourcePaths: [] };
  const bundles: StoredOAuthTokenBundle[] = [];
  const sourcePaths: string[] = [];
  for (const entry of readdirSync(authDir, { withFileTypes: true })
    .filter((candidate) => candidate.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) {
      throw new CapletsError("CONFIG_INVALID", "A legacy OAuth token artifact is not a file.");
    }
    const server = entry.name.slice(0, -".json".length);
    const path = authStorePath(server, authDir);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      throw new CapletsError("CONFIG_INVALID", `Legacy OAuth token bundle ${server} is invalid.`);
    }
    if (!isStoredOAuthTokenBundle(parsed) || parsed.server !== server) {
      throw new CapletsError("CONFIG_INVALID", `Legacy OAuth token bundle ${server} is invalid.`);
    }
    bundles.push(parsed);
    sourcePaths.push(path);
  }
  return { bundles, sourcePaths };
}

export function deleteTokenBundle(server: string, authDir?: string): boolean {
  const path = authStorePath(server, authDir);
  if (!existsSync(path)) {
    return false;
  }
  rmSync(path, { force: true });
  return true;
}

export function isTokenBundleExpired(bundle: StoredOAuthTokenBundle): boolean {
  return Boolean(bundle.expiresAt && Date.parse(bundle.expiresAt) <= Date.now());
}

export function writeTokenBundle(bundle: StoredOAuthTokenBundle, authDir?: string): void {
  const path = authStorePath(bundle.server, authDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tempPath, 0o600);
  } catch {
    // Best effort on platforms without POSIX permissions.
  }
  renameSync(tempPath, path);
}
