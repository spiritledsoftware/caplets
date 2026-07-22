import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { DEFAULT_AUTH_DIR } from "../config/paths";
import { CapletsError } from "../errors";
import type { RemoteProfileCredential } from "./profiles";

export type RemoteCredentialStoreOptions = {
  root?: string | undefined;
};

export class FileRemoteCredentialStore {
  readonly root: string;

  constructor(options: RemoteCredentialStoreOptions = {}) {
    this.root = options.root ?? join(DEFAULT_AUTH_DIR, "remote-credentials");
  }

  pathForKey(key: string): string {
    return join(this.root, `${encodeURIComponent(key)}.json`);
  }

  async load(key: string): Promise<RemoteProfileCredential | undefined> {
    assertGenericKey(key);
    const path = this.pathForKey(key);
    const stat = lstatOptional(path);
    if (!stat) return undefined;
    if (!stat.isFile() || stat.isSymbolicLink()) throw invalidCredentialState();
    try {
      return parseRemoteProfileCredential(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return undefined;
    }
  }

  async save(key: string, credential: RemoteProfileCredential): Promise<void> {
    assertGenericKey(key);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.root, 0o700);
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
    const path = this.pathForKey(key);
    const existing = lstatOptional(path);
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
      throw invalidCredentialState();
    }
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    const descriptor = openSync(tempPath, "wx", 0o600);
    try {
      writeSync(descriptor, `${JSON.stringify(credential, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      chmodSync(tempPath, 0o600);
      renameSync(tempPath, path);
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }
  }

  async delete(key: string): Promise<boolean> {
    assertGenericKey(key);
    const path = this.pathForKey(key);
    const stat = lstatOptional(path);
    if (!stat) return false;
    if (!stat.isFile() && !stat.isSymbolicLink()) throw invalidCredentialState();
    rmSync(path, { force: true });
    return true;
  }
}

export function parseRemoteProfileCredential(value: unknown): RemoteProfileCredential | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...(typeof value.accessToken === "string" ? { accessToken: value.accessToken } : {}),
    ...(typeof value.refreshToken === "string" ? { refreshToken: value.refreshToken } : {}),
    ...(typeof value.tokenType === "string" ? { tokenType: value.tokenType } : {}),
    ...(typeof value.expiresAt === "string" ? { expiresAt: value.expiresAt } : {}),
    ...(Array.isArray(value.scope) && value.scope.every((entry) => typeof entry === "string")
      ? { scope: value.scope }
      : {}),
    ...(typeof value.clientSecret === "string" ? { clientSecret: value.clientSecret } : {}),
    ...(typeof value.pairingCode === "string" ? { pairingCode: value.pairingCode } : {}),
  };
}

function lstatOptional(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function invalidCredentialState(): CapletsError {
  return new CapletsError("REQUEST_INVALID", "Remote credential state is invalid.");
}

function assertGenericKey(key: string): void {
  if (key.startsWith("remote:")) return;
  throw new CapletsError("REQUEST_INVALID", "Remote credential key is invalid.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
