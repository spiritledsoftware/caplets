import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CapletsError } from "../errors";

export type VaultEncryptedRecord = {
  version: 1;
  algorithm: "aes-256-gcm";
  nonce: string;
  ciphertext: string;
  authTag: string;
  valueBytes: number;
  createdAt: string;
  updatedAt: string;
};

const NONCE_BYTES = 12;

export function encryptVaultValue(input: {
  plaintext: string;
  key: Buffer;
  now: Date;
  existing?: VaultEncryptedRecord | undefined;
}): VaultEncryptedRecord {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", input.key, nonce);
  const ciphertext = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const timestamp = input.now.toISOString();
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: authTag.toString("base64url"),
    valueBytes: Buffer.byteLength(input.plaintext, "utf8"),
    createdAt: input.existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

export function decryptVaultValue(record: unknown, key: Buffer): string {
  const parsed = parseEncryptedRecord(record);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.nonce, "base64url"));
    decipher.setAuthTag(Buffer.from(parsed.authTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new CapletsError("CONFIG_INVALID", "Vault encrypted record could not be decrypted.");
  }
}

export function parseEncryptedRecord(record: unknown): VaultEncryptedRecord {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new CapletsError("CONFIG_INVALID", "Vault encrypted record must be an object.");
  }
  const value = record as Record<string, unknown>;
  if (value.version !== 1 || value.algorithm !== "aes-256-gcm") {
    throw new CapletsError("CONFIG_INVALID", "Vault encrypted record version is unsupported.");
  }
  if (
    typeof value.nonce !== "string" ||
    typeof value.ciphertext !== "string" ||
    typeof value.authTag !== "string" ||
    typeof value.valueBytes !== "number" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw new CapletsError("CONFIG_INVALID", "Vault encrypted record is malformed.");
  }
  return value as VaultEncryptedRecord;
}
