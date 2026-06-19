import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DEFAULT_AUTH_DIR } from "../config/paths";
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
    const path = this.pathForKey(key);
    if (!existsSync(path)) return undefined;
    return parseRemoteProfileCredential(JSON.parse(readFileSync(path, "utf8")));
  }

  async save(key: string, credential: RemoteProfileCredential): Promise<void> {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.root, 0o700);
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
    const path = this.pathForKey(key);
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(tempPath, 0o600);
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
    renameSync(tempPath, path);
  }

  async delete(key: string): Promise<boolean> {
    const path = this.pathForKey(key);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }
}

function parseRemoteProfileCredential(value: unknown): RemoteProfileCredential | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...(typeof value.accessToken === "string" ? { accessToken: value.accessToken } : {}),
    ...(typeof value.refreshToken === "string" ? { refreshToken: value.refreshToken } : {}),
    ...(typeof value.tokenType === "string" ? { tokenType: value.tokenType } : {}),
    ...(typeof value.expiresAt === "string" ? { expiresAt: value.expiresAt } : {}),
    ...(Array.isArray(value.scope)
      ? { scope: value.scope.filter((entry): entry is string => typeof entry === "string") }
      : {}),
    ...(typeof value.clientSecret === "string" ? { clientSecret: value.clientSecret } : {}),
    ...(typeof value.pairingCode === "string" ? { pairingCode: value.pairingCode } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
