import { Buffer } from "node:buffer";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { CapletsError } from "../errors";
import type { FileV1KeyProvider } from "../control-plane/key-provider/file-v1";
import { ensurePrivateDir, writePrivateFileAtomic } from "./store";
import type { VaultKeySourceStatus } from "./types";

const VAULT_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
const KEY_FILE_PREFIX = "caplets-vault-key-v1.";
const KEY_BYTES = 32;

export function assertSqlVaultKeyProvider(
  provider: FileV1KeyProvider,
  expected: Readonly<{ logicalHostId: string; storeId: string }>,
): void {
  if (
    provider.manifest.provider !== "file-v1" ||
    provider.manifest.profile !== "online" ||
    provider.manifest.logicalHostId !== expected.logicalHostId ||
    provider.manifest.storeId !== expected.storeId ||
    !provider.hasCapability("vault-record", "encrypt") ||
    !provider.hasCapability("vault-record", "decrypt")
  ) {
    throw new CapletsError(
      "AUTH_FAILED",
      "SQL Vault persistence requires an online file-v1 vault-record key provider.",
    );
  }
}

export function validateVaultKeyName(name: string): string {
  if (!VAULT_KEY_PATTERN.test(name)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Vault key names must match ^[A-Z_][A-Z0-9_]{0,127}$",
    );
  }
  return name;
}

export function loadVaultKey(input: {
  keyFile: string;
  env?: Record<string, string | undefined> | undefined;
}): Buffer {
  const envKey = input.env?.CAPLETS_ENCRYPTION_KEY;
  if (envKey !== undefined) return decodeExactKey(envKey, "CAPLETS_ENCRYPTION_KEY");

  const status = vaultKeySourceStatus(input);
  if (!status.available) {
    const reason = "reason" in status ? status.reason : "invalid";
    throw new CapletsError("CONFIG_INVALID", `Vault key source is unavailable: ${reason}`);
  }
  return parseKeyFile(readFileSync(input.keyFile, "utf8"));
}

export function ensureVaultKey(input: {
  keyFile: string;
  env?: Record<string, string | undefined> | undefined;
}): Buffer {
  const envKey = input.env?.CAPLETS_ENCRYPTION_KEY;
  if (envKey !== undefined) return decodeExactKey(envKey, "CAPLETS_ENCRYPTION_KEY");

  if (!existsSync(input.keyFile)) {
    ensurePrivateDir(dirname(input.keyFile));
    const encoded = randomBytes(KEY_BYTES).toString("base64url");
    writePrivateFileAtomic(input.keyFile, `${KEY_FILE_PREFIX}${encoded}\n`);
    try {
      chmodSync(input.keyFile, 0o600);
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
  }
  return loadVaultKey(input);
}

export function vaultKeySourceStatus(input: {
  keyFile: string;
  env?: Record<string, string | undefined> | undefined;
}): VaultKeySourceStatus {
  const envKey = input.env?.CAPLETS_ENCRYPTION_KEY;
  if (envKey !== undefined) {
    try {
      decodeExactKey(envKey, "CAPLETS_ENCRYPTION_KEY");
      return { available: true, source: "env" };
    } catch {
      return { available: false, source: "env", reason: "invalid" };
    }
  }

  if (!existsSync(input.keyFile)) {
    return { available: false, source: "file", reason: "missing", keyFile: input.keyFile };
  }
  let mode: number;
  try {
    mode = statSync(input.keyFile).mode;
  } catch (error) {
    return unavailableKeyFileStatus(input.keyFile, error);
  }
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    return {
      available: false,
      source: "file",
      reason: "wrong-permissions",
      keyFile: input.keyFile,
    };
  }
  let contents: string;
  try {
    contents = readFileSync(input.keyFile, "utf8");
  } catch (error) {
    return unavailableKeyFileStatus(input.keyFile, error);
  }
  try {
    parseKeyFile(contents);
    return { available: true, source: "file", keyFile: input.keyFile };
  } catch (error) {
    const reason =
      error instanceof CapletsError && error.message.includes("unsupported")
        ? "unsupported-version"
        : "invalid";
    return { available: false, source: "file", reason, keyFile: input.keyFile };
  }
}

function unavailableKeyFileStatus(keyFile: string, error: unknown): VaultKeySourceStatus {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  return {
    available: false,
    source: "file",
    reason: code === "ENOENT" ? "missing" : "unreadable",
    keyFile,
  };
}

function parseKeyFile(contents: string): Buffer {
  const trimmed = contents.trim();
  if (!trimmed.startsWith(KEY_FILE_PREFIX)) {
    throw new CapletsError("CONFIG_INVALID", "Vault key file has an unsupported format version.");
  }
  return decodeExactKey(trimmed.slice(KEY_FILE_PREFIX.length), "Vault key file");
}

function decodeExactKey(encoded: string, label: string): Buffer {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(encoded, "base64url");
  } catch {
    throw new CapletsError("REQUEST_INVALID", `${label} must be a base64url-encoded 32-byte key.`);
  }
  if (
    decoded.length !== KEY_BYTES ||
    decoded.toString("base64url") !== encoded.replace(/=+$/u, "")
  ) {
    throw new CapletsError("REQUEST_INVALID", `${label} must be a base64url-encoded 32-byte key.`);
  }
  return decoded;
}
