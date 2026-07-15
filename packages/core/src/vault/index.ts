import { Buffer } from "node:buffer";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { CapletsError } from "../errors";
import { defaultStateBaseDir } from "../config/paths";
import {
  decryptVaultValue,
  encryptVaultValue,
  parseEncryptedRecord,
  type VaultEncryptedRecord,
} from "./crypto";
import { ensureVaultKey, loadVaultKey, validateVaultKeyName, vaultKeySourceStatus } from "./keys";
import { deleteFile, ensurePrivateDir, readJsonFile, writePrivateFileAtomic } from "./store";
import { filterVaultGrants, sameOrigin, upsertVaultGrant, normalizeVaultGrant } from "./access";
import {
  VAULT_MAX_VALUE_BYTES,
  type VaultAccessGrant,
  type VaultAccessGrantFilter,
  type VaultAccessGrantInput,
  type VaultConfigOrigin,
  type VaultDeleteStatus,
  type VaultKeySourceStatus,
  type VaultResolvedGrant,
  type VaultValueStatus,
} from "./types";

export {
  VAULT_MAX_VALUE_BYTES,
  validateVaultKeyName,
  type VaultAccessGrant,
  type VaultAccessGrantFilter,
  type VaultAccessGrantInput,
  type VaultConfigOrigin,
  type VaultDeleteStatus,
  type VaultKeySourceStatus,
  type VaultResolvedGrant,
  type VaultValueStatus,
};

type FileVaultStoreOptions = {
  root?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
};

type SetOptions = {
  force?: boolean | undefined;
  now?: Date | undefined;
};

/** Async transactional Vault seam; production stays on FileVaultStore until activation. */
export interface VaultRepository {
  setWithGrant(
    input: Readonly<{
      key: string;
      value: string;
      force?: boolean | undefined;
      grant?: VaultAccessGrantInput | undefined;
    }>,
  ): Promise<VaultValueStatus>;
  getStatus(key: string): Promise<VaultValueStatus>;
  listValues(): Promise<VaultValueStatus[]>;
  revealValue(key: string): Promise<string>;
  deleteValue(key: string): Promise<VaultDeleteStatus>;
  grantAccess(input: VaultAccessGrantInput): Promise<VaultAccessGrant>;
  listAccess(filter?: VaultAccessGrantFilter): Promise<VaultAccessGrant[]>;
  revokeAccess(filter: VaultAccessGrantFilter): Promise<VaultAccessGrant[]>;
  resolveGrantedValue(
    input: Readonly<{
      referenceName: string;
      capletId: string;
      origin: VaultConfigOrigin;
    }>,
  ): Promise<VaultResolvedGrant>;
}

export class FileVaultStore {
  readonly root: string;
  readonly env: Record<string, string | undefined>;
  readonly paths: {
    keyFile: string;
    valuesDir: string;
    grantsFile: string;
  };

  constructor(options: FileVaultStoreOptions = {}) {
    this.root = options.root ?? join(defaultStateBaseDir(options.env), "caplets", "vault");
    this.env = options.env ?? process.env;
    this.paths = {
      keyFile: join(this.root, "vault-key"),
      valuesDir: join(this.root, "values"),
      grantsFile: join(this.root, "access-grants.json"),
    };
  }

  valuePath(key: string): string {
    return join(this.paths.valuesDir, `${encodeURIComponent(validateVaultKeyName(key))}.json`);
  }

  set(key: string, value: string, options: SetOptions = {}): VaultValueStatus {
    const normalizedKey = validateVaultKeyName(key);
    const valueBytes = Buffer.byteLength(value, "utf8");
    if (valueBytes > VAULT_MAX_VALUE_BYTES) {
      throw new CapletsError(
        "REQUEST_INVALID",
        `Vault values must be ${VAULT_MAX_VALUE_BYTES} bytes or smaller.`,
      );
    }

    const path = this.valuePath(normalizedKey);
    const existing = this.loadValueRecord(normalizedKey);
    if (existing && !options.force) {
      throw new CapletsError("CONFIG_EXISTS", `Vault key ${normalizedKey} already exists.`);
    }

    ensurePrivateDir(this.root);
    ensurePrivateDir(this.paths.valuesDir);
    const encrypted = encryptVaultValue({
      plaintext: value,
      key: ensureVaultKey({ keyFile: this.paths.keyFile, env: this.env }),
      now: options.now ?? new Date(),
      ...(existing ? { existing } : {}),
    });
    writePrivateFileAtomic(path, `${JSON.stringify(encrypted, null, 2)}\n`);
    return this.statusForRecord(normalizedKey, encrypted);
  }

  getStatus(key: string): VaultValueStatus {
    const normalizedKey = validateVaultKeyName(key);
    const record = this.loadValueRecord(normalizedKey);
    return record
      ? this.statusForRecord(normalizedKey, record)
      : { key: normalizedKey, present: false };
  }

  listValues(): VaultValueStatus[] {
    if (!existsSync(this.paths.valuesDir)) return [];
    return readdirSync(this.paths.valuesDir)
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => decodeURIComponent(basename(entry, ".json")))
      .map((key) => this.getStatus(key))
      .filter((status) => status.present)
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  resolveValue(key: string): string {
    const normalizedKey = validateVaultKeyName(key);
    const record = this.loadValueRecord(normalizedKey);
    if (!record) {
      throw new CapletsError("CONFIG_INVALID", `Vault key ${normalizedKey} is missing.`);
    }
    return decryptVaultValue(record, loadVaultKey({ keyFile: this.paths.keyFile, env: this.env }));
  }

  delete(key: string): VaultDeleteStatus {
    const normalizedKey = validateVaultKeyName(key);
    const deleted = deleteFile(this.valuePath(normalizedKey));
    return {
      key: normalizedKey,
      deleted,
      grantsRetained: this.listAccess({ storedKey: normalizedKey }).length,
    };
  }

  keySourceStatus(): VaultKeySourceStatus {
    return vaultKeySourceStatus({ keyFile: this.paths.keyFile, env: this.env });
  }

  grantAccess(input: VaultAccessGrantInput): VaultAccessGrant {
    const next = normalizeVaultGrant(input);
    const grants = upsertVaultGrant(this.loadAccessGrants(), input);
    this.saveAccessGrants(grants);
    return grants.find(
      (grant) =>
        grant.storedKey === next.storedKey &&
        grant.referenceName === next.referenceName &&
        grant.capletId === next.capletId &&
        sameOrigin(grant.origin, next.origin),
    ) as VaultAccessGrant;
  }

  listAccess(filter: VaultAccessGrantFilter = {}): VaultAccessGrant[] {
    return filterVaultGrants(this.loadAccessGrants(), filter);
  }

  revokeAccess(filter: VaultAccessGrantFilter): VaultAccessGrant[] {
    const removed = this.listAccess(filter);
    if (removed.length === 0) return [];
    const removedKeys = new Set(removed.map(accessGrantIdentity));
    const remaining = this.loadAccessGrants().filter(
      (grant) => !removedKeys.has(accessGrantIdentity(grant)),
    );
    this.saveAccessGrants(remaining);
    return removed;
  }

  resolveGrantedValue(input: {
    referenceName: string;
    capletId: string;
    origin: VaultConfigOrigin;
  }): VaultResolvedGrant {
    const referenceName = validateVaultKeyName(input.referenceName);
    const grant = this.listAccess({
      referenceName,
      capletId: input.capletId,
      origin: input.origin,
    })[0];
    if (!grant) {
      return {
        reason: "ungranted",
        referenceName,
        capletId: input.capletId,
        origin: input.origin,
      };
    }
    if (!existsSync(this.valuePath(grant.storedKey))) {
      return {
        reason: "missing",
        storedKey: grant.storedKey,
        referenceName,
        capletId: input.capletId,
        origin: input.origin,
      };
    }
    return { storedKey: grant.storedKey, value: this.resolveValue(grant.storedKey) };
  }

  private loadValueRecord(key: string): VaultEncryptedRecord | undefined {
    const path = this.valuePath(key);
    if (!existsSync(path)) return undefined;
    let raw: unknown;
    try {
      raw = readJsonFile<unknown>(path, {});
    } catch {
      throw new CapletsError("CONFIG_INVALID", `Vault value record for ${key} is not valid JSON.`);
    }
    return parseEncryptedRecord(raw);
  }

  private statusForRecord(key: string, record: VaultEncryptedRecord): VaultValueStatus {
    return {
      key,
      present: true,
      valueBytes: record.valueBytes,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private loadAccessGrants(): VaultAccessGrant[] {
    let raw: unknown;
    try {
      raw = readJsonFile<unknown>(this.paths.grantsFile, []);
    } catch {
      throw new CapletsError("CONFIG_INVALID", "Vault access grants file is not valid JSON.");
    }
    if (!Array.isArray(raw)) {
      throw new CapletsError("CONFIG_INVALID", "Vault access grants file must contain an array.");
    }
    return raw.map(parseStoredGrant);
  }

  private saveAccessGrants(grants: VaultAccessGrant[]): void {
    ensurePrivateDir(this.root);
    writePrivateFileAtomic(this.paths.grantsFile, `${JSON.stringify(grants, null, 2)}\n`);
  }
}

function accessGrantIdentity(grant: VaultAccessGrant): string {
  return [
    grant.storedKey,
    grant.referenceName,
    grant.capletId,
    grant.origin.kind,
    grant.origin.path,
  ].join("\0");
}

function parseStoredGrant(value: unknown): VaultAccessGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CapletsError("CONFIG_INVALID", "Vault access grant must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.storedKey !== "string" ||
    typeof record.referenceName !== "string" ||
    typeof record.capletId !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.updatedAt !== "string" ||
    !record.origin ||
    typeof record.origin !== "object" ||
    Array.isArray(record.origin)
  ) {
    throw new CapletsError("CONFIG_INVALID", "Vault access grant is malformed.");
  }
  const originRecord = record.origin as Record<string, unknown>;
  if (
    typeof originRecord.kind !== "string" ||
    typeof originRecord.path !== "string" ||
    !["global-config", "global-file", "project-config", "project-file"].includes(originRecord.kind)
  ) {
    throw new CapletsError("CONFIG_INVALID", "Vault access grant origin is malformed.");
  }
  const normalized = normalizeVaultGrant({
    storedKey: record.storedKey,
    referenceName: record.referenceName,
    capletId: record.capletId,
    origin: {
      kind: originRecord.kind as VaultConfigOrigin["kind"],
      path: originRecord.path,
    },
  });
  return {
    ...normalized,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
