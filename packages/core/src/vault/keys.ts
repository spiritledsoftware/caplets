import { Buffer } from "node:buffer";
import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { CapletsError } from "../errors";
import { ensurePrivateDir, writePrivateFileAtomic } from "./store";
import type { VaultKeySourceStatus } from "./types";

const VAULT_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
const KEY_FILE_PREFIX = "caplets-vault-key-v1.";
const KEY_BYTES = 32;

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
  const externalKeyFile = input.env?.CAPLETS_ENCRYPTION_KEY_FILE;
  if (externalKeyFile !== undefined) return loadExternalKeyFile(externalKeyFile);

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
  const externalKeyFile = input.env?.CAPLETS_ENCRYPTION_KEY_FILE;
  if (externalKeyFile !== undefined) return loadExternalKeyFile(externalKeyFile);

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
  const externalKeyFile = input.env?.CAPLETS_ENCRYPTION_KEY_FILE;
  if (externalKeyFile !== undefined) {
    if (!externalKeyFile) {
      return {
        available: false,
        source: "file",
        reason: "invalid",
        keyFile: externalKeyFile,
      };
    }
    return keyFileSourceStatus(externalKeyFile, parseExternalKeyFile);
  }

  return keyFileSourceStatus(input.keyFile, parseKeyFile);
}

function keyFileSourceStatus(
  keyFile: string,
  parse: (contents: string) => Buffer,
): VaultKeySourceStatus {
  if (!existsSync(keyFile)) {
    return { available: false, source: "file", reason: "missing", keyFile };
  }
  let mode: number;
  try {
    mode = statSync(keyFile).mode;
  } catch (error) {
    return unavailableKeyFileStatus(keyFile, error);
  }
  if (process.platform !== "win32" && (mode & 0o077) !== 0) {
    return {
      available: false,
      source: "file",
      reason: "wrong-permissions",
      keyFile,
    };
  }
  let contents: string;
  try {
    contents = readFileSync(keyFile, "utf8");
  } catch (error) {
    return unavailableKeyFileStatus(keyFile, error);
  }
  try {
    parse(contents);
    return { available: true, source: "file", keyFile };
  } catch (error) {
    const reason =
      error instanceof CapletsError && error.message.includes("unsupported")
        ? "unsupported-version"
        : "invalid";
    return { available: false, source: "file", reason, keyFile };
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

function loadExternalKeyFile(keyFile: string): Buffer {
  const status = keyFileSourceStatus(keyFile, parseExternalKeyFile);
  if (!status.available) {
    const reason = "reason" in status ? status.reason : "invalid";
    throw new CapletsError(
      "CONFIG_INVALID",
      `CAPLETS_ENCRYPTION_KEY_FILE is unavailable: ${reason}`,
    );
  }
  try {
    return parseExternalKeyFile(readFileSync(keyFile, "utf8"));
  } catch (error) {
    if (error instanceof CapletsError) throw error;
    throw new CapletsError("CONFIG_INVALID", "CAPLETS_ENCRYPTION_KEY_FILE is unreadable.");
  }
}

function parseExternalKeyFile(contents: string): Buffer {
  let withoutLineEnding = contents;
  if (contents.endsWith("\r\n")) withoutLineEnding = contents.slice(0, -2);
  else if (contents.endsWith("\n")) withoutLineEnding = contents.slice(0, -1);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(withoutLineEnding)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "CAPLETS_ENCRYPTION_KEY_FILE contents must be a base64url-encoded 32-byte key.",
    );
  }
  return decodeExactKey(withoutLineEnding, "CAPLETS_ENCRYPTION_KEY_FILE contents");
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
