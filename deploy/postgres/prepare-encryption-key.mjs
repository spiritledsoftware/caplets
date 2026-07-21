import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  chownSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

const LEGACY_KEY_PREFIX = "caplets-vault-key-v1.";
const CANONICAL_KEY = /^[A-Za-z0-9_-]{43}$/u;

const legacyKeyFile = requiredEnvironment("CAPLETS_LEGACY_ENCRYPTION_KEY_FILE");
const preparedKeyFile = requiredEnvironment("CAPLETS_PREPARED_ENCRYPTION_KEY_FILE");
const externalKeyFile = requiredEnvironment("CAPLETS_EXTERNAL_ENCRYPTION_KEY_FILE");
const externalConfigured = process.env.CAPLETS_EXTERNAL_ENCRYPTION_KEY_CONFIGURED === "1";
const ownerUid = nonNegativeIntegerEnvironment("CAPLETS_KEY_OWNER_UID");
const ownerGid = nonNegativeIntegerEnvironment("CAPLETS_KEY_OWNER_GID");

const candidates = [];
const legacy = readCandidate(legacyKeyFile, "retained Vault key", {
  format: "legacy",
  privatePermissions: true,
});
if (legacy) candidates.push(legacy);
const prepared = readCandidate(preparedKeyFile, "prepared encryption key", {
  format: "canonical",
  privatePermissions: true,
});
if (prepared) candidates.push(prepared);
const external = readCandidate(externalKeyFile, "external encryption key secret", {
  format: "canonical",
  required: externalConfigured,
  emptyIsAbsent: !externalConfigured,
});
if (external) candidates.push(external);

const selected = candidates[0] ?? {
  label: "fresh generated encryption key",
  key: randomBytes(32),
};
for (const candidate of candidates.slice(1)) {
  if (!timingSafeEqual(selected.key, candidate.key)) {
    throw new Error(`Encryption key sources conflict: ${selected.label} and ${candidate.label}.`);
  }
}

mkdirSync(dirname(preparedKeyFile), { recursive: true, mode: 0o700 });
const temporaryKeyFile = `${preparedKeyFile}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
try {
  writeFileSync(temporaryKeyFile, selected.key.toString("base64url"), {
    flag: "wx",
    mode: 0o400,
  });
  chownSync(temporaryKeyFile, ownerUid, ownerGid);
  chmodSync(temporaryKeyFile, 0o400);
  renameSync(temporaryKeyFile, preparedKeyFile);
} catch (error) {
  rmSync(temporaryKeyFile, { force: true });
  throw error;
}

function readCandidate(
  path,
  label,
  { format, privatePermissions = false, required = false, emptyIsAbsent = false },
) {
  let status;
  let contents;
  try {
    status = lstatSync(path);
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return undefined;
    throw new Error(`${label} is unavailable.`, { cause: error });
  }
  if (emptyIsAbsent && contents.length === 0) return undefined;
  if (!status.isFile()) throw new Error(`${label} must be a regular file.`);
  if (privatePermissions && process.platform !== "win32" && (status.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users.`);
  }
  const key =
    format === "legacy"
      ? parseLegacyKey(contents, label)
      : decodeCanonicalKey(removeOptionalLineEnding(contents), label);
  return { label, key };
}

function parseLegacyKey(contents, label) {
  const encoded = removeOptionalLineEnding(contents);
  if (!encoded.startsWith(LEGACY_KEY_PREFIX)) throw new Error(`${label} is invalid.`);
  return decodeCanonicalKey(encoded.slice(LEGACY_KEY_PREFIX.length), label);
}

function decodeCanonicalKey(encoded, label) {
  if (!CANONICAL_KEY.test(encoded)) throw new Error(`${label} is invalid.`);
  const key = Buffer.from(encoded, "base64url");
  if (key.byteLength !== 32 || key.toString("base64url") !== encoded) {
    throw new Error(`${label} is invalid.`);
  }
  return key;
}

function removeOptionalLineEnding(contents) {
  if (contents.endsWith("\r\n")) return contents.slice(0, -2);
  if (contents.endsWith("\n")) return contents.slice(0, -1);
  return contents;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function nonNegativeIntegerEnvironment(name) {
  const value = Number(requiredEnvironment(name));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is invalid.`);
  return value;
}
