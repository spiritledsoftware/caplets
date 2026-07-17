import { createHash } from "node:crypto";
import { isAbsolute, posix, win32 } from "node:path";
import { CapletsError } from "../../errors";

const MAX_LIVE_KEY_VERSIONS = 3;
const ACTIVE_ONLY_OPERATIONS = new Set<FileV1Operation>(["encrypt", "compute", "wrap"]);

export const FILE_V1_PURPOSES = [
  "active-record",
  "vault-record",
  "credential-verifier",
  "bootstrap-attestation",
  "node-canary",
  "backup-wrap",
  "backup-recovery",
  "recovery-checkpoint",
  "transfer",
] as const;

export type FileV1Purpose = (typeof FILE_V1_PURPOSES)[number];
export const FILE_V1_RUNTIME_PURPOSES = [
  "active-record",
  "vault-record",
  "credential-verifier",
  "bootstrap-attestation",
  "node-canary",
] as const satisfies readonly FileV1Purpose[];
export type FileV1Algorithm = "AES-256-GCM" | "HMAC-SHA-256" | "RSA-OAEP-256";
export type FileV1Operation = "encrypt" | "decrypt" | "compute" | "verify" | "wrap" | "unwrap";
export type FileV1Profile =
  | "inventory"
  | "online"
  | "migrator"
  | "maintenance"
  | "backup-writer"
  | "offline-recovery"
  | "transfer-source"
  | "transfer-destination";

export type FileV1ManifestEntry = {
  keyId: string;
  keyVersion: number;
  algorithm: FileV1Algorithm;
  purpose: FileV1Purpose;
  operations: FileV1Operation[];
  file: string;
};
export type FileV1CompatibilityKey = {
  keyId: string;
  keyVersion: number;
  purpose: FileV1Purpose;
  commitment: string;
};

export type FileV1Manifest = {
  version: 1;
  provider: "file-v1";
  generation: number;
  profile: FileV1Profile;
  compatibilityCommitment: string;
  backupKeyPairCommitment: string;
  compatibilityKeys: FileV1CompatibilityKey[];
  logicalHostId: string;
  storeId: string;
  entries: FileV1ManifestEntry[];
};

export type FileV1PurposeSpec = {
  algorithm: FileV1Algorithm;
  operations: readonly FileV1Operation[];
  bytes?: number | undefined;
  material: "symmetric" | "public-key" | "private-key";
};

export const FILE_V1_PURPOSE_SPECS: Record<FileV1Purpose, FileV1PurposeSpec> = {
  "active-record": {
    algorithm: "AES-256-GCM",
    operations: ["encrypt", "decrypt"],
    bytes: 32,
    material: "symmetric",
  },
  "vault-record": {
    algorithm: "AES-256-GCM",
    operations: ["encrypt", "decrypt"],
    bytes: 32,
    material: "symmetric",
  },
  "credential-verifier": {
    algorithm: "HMAC-SHA-256",
    operations: ["compute", "verify"],
    bytes: 32,
    material: "symmetric",
  },
  "bootstrap-attestation": {
    algorithm: "HMAC-SHA-256",
    operations: ["compute", "verify"],
    bytes: 32,
    material: "symmetric",
  },
  "node-canary": {
    algorithm: "HMAC-SHA-256",
    operations: ["compute", "verify"],
    bytes: 32,
    material: "symmetric",
  },
  "backup-wrap": {
    algorithm: "RSA-OAEP-256",
    operations: ["wrap"],
    material: "public-key",
  },
  "backup-recovery": {
    algorithm: "RSA-OAEP-256",
    operations: ["unwrap"],
    material: "private-key",
  },
  "recovery-checkpoint": {
    algorithm: "HMAC-SHA-256",
    operations: ["compute", "verify"],
    bytes: 32,
    material: "symmetric",
  },
  transfer: {
    algorithm: "AES-256-GCM",
    operations: ["encrypt", "decrypt"],
    bytes: 32,
    material: "symmetric",
  },
};

export type FileV1Capability = {
  purpose: FileV1Purpose;
  operations: readonly FileV1Operation[];
};

export const FILE_V1_PROFILE_CAPABILITIES: Record<FileV1Profile, readonly FileV1Capability[]> = {
  inventory: FILE_V1_PURPOSES.map((purpose) => ({
    purpose,
    operations: FILE_V1_PURPOSE_SPECS[purpose].operations,
  })),
  online: [
    { purpose: "active-record", operations: ["encrypt", "decrypt"] },
    { purpose: "vault-record", operations: ["encrypt", "decrypt"] },
    { purpose: "credential-verifier", operations: ["compute", "verify"] },
    { purpose: "bootstrap-attestation", operations: ["compute", "verify"] },
    { purpose: "node-canary", operations: ["compute", "verify"] },
  ],
  migrator: [
    { purpose: "active-record", operations: ["encrypt", "decrypt"] },
    { purpose: "vault-record", operations: ["encrypt", "decrypt"] },
    { purpose: "credential-verifier", operations: ["compute", "verify"] },
    { purpose: "bootstrap-attestation", operations: ["compute", "verify"] },
  ],
  maintenance: [],
  "backup-writer": [{ purpose: "backup-wrap", operations: ["wrap"] }],
  "offline-recovery": [
    { purpose: "backup-recovery", operations: ["unwrap"] },
    { purpose: "recovery-checkpoint", operations: ["compute", "verify"] },
  ],
  "transfer-source": [{ purpose: "transfer", operations: ["decrypt"] }],
  "transfer-destination": [{ purpose: "transfer", operations: ["encrypt"] }],
};

const HOST_ID_PATTERN = /^host_[0-9A-HJKMNP-TV-Z]{26}$/u;
const STORE_ID_PATTERN = /^store_[0-9A-HJKMNP-TV-Z]{26}$/u;
const KEY_ID_PATTERN = /^key_[0-9A-HJKMNP-TV-Z]{26}$/u;
const PROFILE_VALUES = Object.keys(FILE_V1_PROFILE_CAPABILITIES) as FileV1Profile[];
const PURPOSE_VALUES = FILE_V1_PURPOSES as readonly string[];
const OPERATION_VALUES = ["encrypt", "decrypt", "compute", "verify", "wrap", "unwrap"] as const;

export function parseFileV1Manifest(contents: string): FileV1Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw manifestError("file-v1 manifest is malformed.");
  }
  const value = record(parsed, "manifest");
  exactKeys(value, [
    "version",
    "provider",
    "generation",
    "compatibilityCommitment",
    "backupKeyPairCommitment",
    "compatibilityKeys",
    "profile",
    "logicalHostId",
    "storeId",
    "entries",
  ]);
  if (value.version !== 1 || value.provider !== "file-v1") {
    throw manifestError("file-v1 manifest version or provider is unsupported.");
  }
  const generation = positiveInteger(value.generation, "generation");
  const compatibilityCommitment = string(value.compatibilityCommitment, "compatibility commitment");
  if (!/^[a-f0-9]{64}$/u.test(compatibilityCommitment)) {
    throw manifestError("file-v1 manifest compatibility commitment is invalid.");
  }
  const backupKeyPairCommitment = string(
    value.backupKeyPairCommitment,
    "backup key-pair commitment",
  );
  if (!/^[a-f0-9]{64}$/u.test(backupKeyPairCommitment)) {
    throw manifestError("file-v1 backup key-pair commitment is invalid.");
  }
  if (!Array.isArray(value.compatibilityKeys)) {
    throw manifestError("file-v1 manifest compatibility keys are invalid.");
  }
  const compatibilityKeys = value.compatibilityKeys.map(parseCompatibilityKey);
  validateCompatibilityKeys(compatibilityKeys, compatibilityCommitment);
  const profile = string(value.profile, "profile");
  if (!PROFILE_VALUES.includes(profile as FileV1Profile)) {
    throw manifestError("file-v1 manifest profile is undeclared.");
  }
  const logicalHostId = string(value.logicalHostId, "logical-host binding");
  const storeId = string(value.storeId, "store binding");
  if (!HOST_ID_PATTERN.test(logicalHostId) || !STORE_ID_PATTERN.test(storeId)) {
    throw manifestError("file-v1 manifest has an invalid identity binding.");
  }
  if (!Array.isArray(value.entries)) throw manifestError("file-v1 manifest entries are invalid.");
  const entries = value.entries.map(parseEntry);
  const keyBindings = new Set<string>();
  const keyIds = new Set<string>();
  const fileReferences = new Set<string>();
  for (const entry of entries) {
    const binding = `${entry.purpose}:${entry.keyVersion}`;
    if (keyBindings.has(binding) || keyIds.has(entry.keyId) || fileReferences.has(entry.file)) {
      throw manifestError("file-v1 manifest has duplicate key bindings.");
    }
    keyBindings.add(binding);
    keyIds.add(entry.keyId);
    fileReferences.add(entry.file);
  }
  for (const entry of entries) {
    if (
      !compatibilityKeys.some(
        (key) =>
          key.keyId === entry.keyId &&
          key.keyVersion === entry.keyVersion &&
          key.purpose === entry.purpose,
      )
    ) {
      throw manifestError("file-v1 entry is absent from compatibility keys.");
    }
  }
  const grantedPurposes = new Set(
    profile === "inventory"
      ? FILE_V1_PURPOSES
      : FILE_V1_PROFILE_CAPABILITIES[profile as Exclude<FileV1Profile, "inventory">].map(
          (capability) => capability.purpose,
        ),
  );
  for (const key of compatibilityKeys) {
    if (
      grantedPurposes.has(key.purpose) &&
      !entries.some(
        (entry) =>
          entry.keyId === key.keyId &&
          entry.keyVersion === key.keyVersion &&
          entry.purpose === key.purpose,
      )
    ) {
      throw manifestError("file-v1 live compatibility key is absent from the process profile.");
    }
  }
  validateProfileCapabilities(profile as FileV1Profile, entries);
  return {
    version: 1,
    provider: "file-v1",
    generation,
    profile: profile as FileV1Profile,
    compatibilityCommitment,
    backupKeyPairCommitment,
    compatibilityKeys,
    logicalHostId,
    storeId,
    entries,
  };
}

export type FileV1ProfileDerivationOptions = {
  retiredVersions?: Partial<Record<FileV1Purpose, readonly number[]>> | undefined;
};

export function manifestForProfile(
  inventory: FileV1Manifest,
  profile: Exclude<FileV1Profile, "inventory">,
  options: FileV1ProfileDerivationOptions = {},
): FileV1Manifest {
  if (inventory.profile !== "inventory") {
    throw manifestError("Profile manifests can only be derived from an inventory manifest.");
  }
  const allowed = FILE_V1_PROFILE_CAPABILITIES[profile];
  const entries = allowed.flatMap((capability) => {
    const retiredVersions = new Set(options.retiredVersions?.[capability.purpose] ?? []);
    const sourceEntries = inventory.entries
      .filter(
        (entry) => entry.purpose === capability.purpose && !retiredVersions.has(entry.keyVersion),
      )
      .sort((left, right) => right.keyVersion - left.keyVersion);
    if (sourceEntries.length === 0) throw manifestError("Inventory manifest is incomplete.");
    if (sourceEntries.length > MAX_LIVE_KEY_VERSIONS) {
      throw manifestError(
        "Inventory manifest requires explicit referenced-version retirement evidence.",
      );
    }
    return sourceEntries.map((source, index) => {
      const operations = capability.operations.filter(
        (operation) => index === 0 || !ACTIVE_ONLY_OPERATIONS.has(operation),
      );
      return { ...source, operations };
    });
  });
  const compatibilityKeys = inventory.compatibilityKeys.filter(
    (key) => !(options.retiredVersions?.[key.purpose] ?? []).includes(key.keyVersion),
  );
  return parseFileV1Manifest(
    JSON.stringify({
      ...inventory,
      profile,
      compatibilityKeys,
      compatibilityCommitment: fileV1CompatibilityManifestCommitment(compatibilityKeys),
      entries,
    }),
  );
}

export function fileV1CompatibilityManifestCommitment(
  keys: readonly FileV1CompatibilityKey[],
): string {
  const hash = createHash("sha256");
  for (const key of [...keys].sort((left, right) => left.keyId.localeCompare(right.keyId))) {
    hash.update(JSON.stringify(key));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function parseCompatibilityKey(input: unknown): FileV1CompatibilityKey {
  const value = record(input, "compatibility key");
  exactKeys(value, ["keyId", "keyVersion", "purpose", "commitment"]);
  const keyId = string(value.keyId, "compatibility keyId");
  const keyVersion = positiveInteger(value.keyVersion, "compatibility keyVersion");
  const purpose = string(value.purpose, "compatibility purpose");
  const commitment = string(value.commitment, "key commitment");
  if (
    !KEY_ID_PATTERN.test(keyId) ||
    !FILE_V1_PURPOSES.includes(purpose as FileV1Purpose) ||
    !/^[a-f0-9]{64}$/u.test(commitment)
  ) {
    throw manifestError("file-v1 compatibility key is invalid.");
  }
  return {
    keyId,
    keyVersion,
    purpose: purpose as FileV1CompatibilityKey["purpose"],
    commitment,
  };
}

function validateCompatibilityKeys(
  keys: readonly FileV1CompatibilityKey[],
  expectedCommitment: string,
): void {
  const keyIds = new Set<string>();
  const bindings = new Set<string>();
  for (const key of keys) {
    const binding = `${key.purpose}:${key.keyVersion}`;
    if (keyIds.has(key.keyId) || bindings.has(binding)) {
      throw manifestError("file-v1 compatibility keys contain duplicates.");
    }
    keyIds.add(key.keyId);
    bindings.add(binding);
  }
  const materialCommitments = new Set<string>();
  for (const key of keys) {
    if (materialCommitments.has(key.commitment)) {
      throw manifestError("file-v1 compatibility keys reuse key material.");
    }
    materialCommitments.add(key.commitment);
  }
  for (const purpose of FILE_V1_PURPOSES) {
    const versions = keys.filter((key) => key.purpose === purpose);
    if (versions.length === 0 || versions.length > MAX_LIVE_KEY_VERSIONS) {
      throw manifestError("file-v1 compatibility keys have an invalid live-version window.");
    }
  }
  if (fileV1CompatibilityManifestCommitment(keys) !== expectedCommitment) {
    throw manifestError("file-v1 manifest compatibility commitment does not match its keys.");
  }
}

function parseEntry(input: unknown): FileV1ManifestEntry {
  const value = record(input, "entry");
  exactKeys(value, ["keyId", "keyVersion", "algorithm", "purpose", "operations", "file"]);
  const keyId = string(value.keyId, "keyId");
  if (!KEY_ID_PATTERN.test(keyId)) throw manifestError("file-v1 keyId is invalid.");
  const keyVersion = positiveInteger(value.keyVersion, "keyVersion");
  const purpose = string(value.purpose, "purpose");
  if (!PURPOSE_VALUES.includes(purpose)) throw manifestError("file-v1 key purpose is undeclared.");
  const spec = FILE_V1_PURPOSE_SPECS[purpose as FileV1Purpose];
  const algorithm = string(value.algorithm, "algorithm");
  if (algorithm !== spec.algorithm) {
    throw manifestError("file-v1 key algorithm does not match its purpose.");
  }
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    throw manifestError("file-v1 key operations are invalid.");
  }
  const operations = value.operations.map((operation) => string(operation, "operation"));
  if (
    new Set(operations).size !== operations.length ||
    operations.some(
      (operation) =>
        !OPERATION_VALUES.includes(operation as FileV1Operation) ||
        !spec.operations.includes(operation as FileV1Operation),
    )
  ) {
    throw manifestError("file-v1 key capability exceeds its purpose.");
  }
  const file = string(value.file, "file reference");
  if (!isCanonicalRelativeFileReference(file)) {
    throw manifestError("file-v1 key file reference is invalid.");
  }
  return {
    keyId,
    keyVersion,
    algorithm: algorithm as FileV1Algorithm,
    purpose: purpose as FileV1Purpose,
    operations: operations as FileV1Operation[],
    file,
  };
}

function validateProfileCapabilities(profile: FileV1Profile, entries: FileV1ManifestEntry[]): void {
  const allowed = FILE_V1_PROFILE_CAPABILITIES[profile];
  for (const entry of entries) {
    const capability = allowed.find((candidate) => candidate.purpose === entry.purpose);
    if (
      !capability ||
      entry.operations.some((operation) => !capability.operations.includes(operation))
    ) {
      throw manifestError("file-v1 manifest contains a profile capability escalation.");
    }
  }
  for (const capability of allowed) {
    const entriesForPurpose = entries.filter((entry) => entry.purpose === capability.purpose);
    if (profile !== "inventory" && entriesForPurpose.length > MAX_LIVE_KEY_VERSIONS) {
      throw manifestError("file-v1 manifest exceeds the bounded live key versions.");
    }
    const activeVersion = Math.max(...entriesForPurpose.map((entry) => entry.keyVersion));
    if (
      entriesForPurpose.some(
        (entry) =>
          entry.keyVersion !== activeVersion &&
          entry.operations.some((operation) => ACTIVE_ONLY_OPERATIONS.has(operation)),
      )
    ) {
      throw manifestError("file-v1 manifest grants an active operation to an old key version.");
    }
    if (
      entriesForPurpose.length === 0 ||
      capability.operations.some(
        (operation) => !entriesForPurpose.some((entry) => entry.operations.includes(operation)),
      )
    ) {
      throw manifestError("file-v1 manifest is missing a required profile capability.");
    }
  }
}

function isCanonicalRelativeFileReference(value: string): boolean {
  if (isAbsolute(value) || win32.isAbsolute(value) || value.includes("\\")) return false;
  const normalized = posix.normalize(value);
  return (
    normalized === value &&
    !normalized.startsWith("../") &&
    normalized !== ".." &&
    normalized.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw manifestError(`file-v1 ${field} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw manifestError(`file-v1 ${field} is invalid.`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw manifestError(`file-v1 ${field} is invalid.`);
  }
  return value as number;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw manifestError("file-v1 manifest has unknown or missing fields.");
  }
}

function manifestError(message: string): CapletsError {
  return new CapletsError("REQUEST_INVALID", message);
}
