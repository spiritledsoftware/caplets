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

/** Async encrypted token repository used only by the internal SQL activation path. */
export interface AuthTokenRepository {
  readTokenBundle(server: string): Promise<StoredOAuthTokenBundle | undefined>;
  listTokenBundles(): Promise<StoredOAuthTokenBundle[]>;
  writeTokenBundle(bundle: StoredOAuthTokenBundle): Promise<void>;
  deleteTokenBundle(server: string): Promise<boolean>;
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
