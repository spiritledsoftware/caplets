import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { CapletsError } from "../errors";
import { defaultStateBaseDir } from "../config/paths";
import { stableJsonStringify } from "../stable-json";
import type {
  AuthorityCommitResult,
  AuthorityGenerationIdentity,
  AuthorityHead,
  WritableAuthority,
} from "../storage/types";
import {
  decryptVaultValue,
  encryptVaultValue,
  parseEncryptedRecord,
  type VaultEncryptedRecord,
} from "./crypto";
import {
  ensureVaultKey,
  loadInjectedVaultKey,
  loadVaultKey,
  validateVaultKeyName,
  vaultKeyFingerprint,
  vaultKeySourceStatus,
} from "./keys";
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
  loadInjectedVaultKey,
  vaultKeyFingerprint,
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

export type VaultMutationOptions = {
  force?: boolean | undefined;
  now?: Date | undefined;
  expectedGeneration?: AuthorityGenerationIdentity | null | undefined;
  idempotencyKey?: string | undefined;
  requestDigest?: string | undefined;
};

export type VaultSetWithGrantOptions = VaultMutationOptions & {
  grant?: VaultAccessGrantInput | undefined;
};

export type VaultSetWithGrantResult = {
  status: VaultValueStatus;
  grant?: VaultAccessGrant | undefined;
  replayed?: boolean | undefined;
};

/**
 * The safe administration surface shared by Current Host adapters.
 *
 * Raw resolution is intentionally absent. Implementations are asynchronous so
 * the same facade can target a provider-backed authority without adapting its
 * reads or writes at each callsite.
 */
export interface VaultAdministrationStore {
  set(key: string, value: string, options?: VaultMutationOptions): Promise<VaultValueStatus>;
  getStatus(key: string): Promise<VaultValueStatus>;
  listValues(): Promise<VaultValueStatus[]>;
  delete(key: string, options?: VaultMutationOptions): Promise<VaultDeleteStatus>;
  grantAccess(
    input: VaultAccessGrantInput,
    options?: VaultMutationOptions,
  ): Promise<VaultAccessGrant>;
  listAccess(filter?: VaultAccessGrantFilter): Promise<VaultAccessGrant[]>;
  revokeAccess(
    filter: VaultAccessGrantFilter,
    options?: VaultMutationOptions,
  ): Promise<VaultAccessGrant[]>;
  setWithGrant?(
    key: string,
    value: string,
    options?: VaultSetWithGrantOptions,
  ): Promise<VaultSetWithGrantResult>;
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

  set(key: string, value: string, options: VaultMutationOptions = {}): VaultValueStatus {
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

export type AuthorityVaultSnapshot = {
  version: 1;
  keyFingerprint: string;
  values: Record<string, VaultEncryptedRecord>;
  grants: VaultAccessGrant[];
};

export type AuthorityVaultAuthorization = {
  operation: "read" | "write" | "grant" | "revoke";
  storedKey?: string | undefined;
  referenceName?: string | undefined;
  capletId?: string | undefined;
};

export type AuthorityVaultStoreOptions = {
  authority: WritableAuthority<unknown, never> & { readonly authorityId?: string | undefined };
  authorityId?: string | undefined;
  currentHostId?: string | undefined;
  principalId?: string | undefined;
  key: string | Uint8Array | undefined;
  authorize?: ((input: AuthorityVaultAuthorization) => void | Promise<void | boolean>) | undefined;
  now?: (() => Date) | undefined;
};

/**
 * Async Vault codec for a Writable Authority. Only ciphertext and grant
 * metadata cross the authority boundary; plaintext is materialized for one
 * explicitly granted reference and never returned by enumeration.
 */
export class AuthorityVaultStore {
  readonly authorityId: string;
  private readonly key: Buffer;
  private readonly keyFingerprint: string;
  private readonly currentHostId: string;
  private readonly principalId: string;
  private readonly authorize?: AuthorityVaultStoreOptions["authorize"];
  private readonly now: () => Date;
  private readonly authority: AuthorityVaultStoreOptions["authority"];

  constructor(options: AuthorityVaultStoreOptions) {
    this.authority = options.authority;
    this.authorityId =
      options.authorityId ??
      (typeof options.authority.authorityId === "string"
        ? options.authority.authorityId
        : "authority");
    this.key = loadInjectedVaultKey({ key: options.key });
    this.keyFingerprint = vaultKeyFingerprint(this.key);
    this.currentHostId = options.currentHostId ?? "current-host";
    this.principalId = options.principalId ?? "vault";
    this.authorize = options.authorize;
    this.now = options.now ?? (() => new Date());
  }

  async set(
    key: string,
    value: string,
    options: VaultMutationOptions = {},
  ): Promise<VaultValueStatus> {
    const normalizedKey = validateVaultKeyName(key);
    if (Buffer.byteLength(value, "utf8") > VAULT_MAX_VALUE_BYTES) {
      throw new CapletsError(
        "REQUEST_INVALID",
        `Vault values must be ${VAULT_MAX_VALUE_BYTES} bytes or smaller.`,
      );
    }
    await this.ensureAuthorized({ operation: "write", storedKey: normalizedKey });
    const current = await this.readState();
    const existing = current.values[normalizedKey];
    if (existing && !options.force) {
      throw new CapletsError("CONFIG_EXISTS", `Vault key ${normalizedKey} already exists.`);
    }
    const encrypted = encryptVaultValue({
      plaintext: value,
      key: this.key,
      now: options.now ?? this.now(),
      ...(existing ? { existing } : {}),
    });
    const snapshot = {
      ...current.snapshot,
      vault: {
        version: 1 as const,
        keyFingerprint: this.keyFingerprint,
        values: { ...current.values, [normalizedKey]: encrypted },
        grants: current.grants,
      },
    };
    await this.commitSnapshot(
      snapshot,
      "write",
      vaultMutationOptions(options, { key: normalizedKey, value }),
      current.expectedGeneration,
    );
    return {
      key: normalizedKey,
      present: true,
      valueBytes: encrypted.valueBytes,
      createdAt: encrypted.createdAt,
      updatedAt: encrypted.updatedAt,
    };
  }

  /**
   * Encrypt a value and upsert its optional access grant in one authority
   * generation. The authority CAS is the only persistence boundary; no
   * plaintext or local rollback state is needed.
   */
  async setWithGrant(
    key: string,
    value: string,
    options: VaultSetWithGrantOptions = {},
  ): Promise<VaultSetWithGrantResult> {
    const normalizedKey = validateVaultKeyName(key);
    if (Buffer.byteLength(value, "utf8") > VAULT_MAX_VALUE_BYTES) {
      throw new CapletsError(
        "REQUEST_INVALID",
        `Vault values must be ${VAULT_MAX_VALUE_BYTES} bytes or smaller.`,
      );
    }
    const next =
      options.grant === undefined
        ? undefined
        : normalizeVaultGrant({ ...options.grant, storedKey: normalizedKey });
    if (next) {
      assertStableAuthorityOrigin(next.origin);
    }
    await this.ensureAuthorized({
      operation: "write",
      storedKey: normalizedKey,
      ...(next
        ? {
            referenceName: next.referenceName,
            capletId: next.capletId,
          }
        : {}),
    });
    if (next) {
      await this.ensureAuthorized({
        operation: "grant",
        storedKey: next.storedKey,
        referenceName: next.referenceName,
        capletId: next.capletId,
      });
    }
    const current = await this.readState();
    const existing = current.values[normalizedKey];
    if (existing && !options.force) {
      throw new CapletsError("CONFIG_EXISTS", `Vault key ${normalizedKey} already exists.`);
    }
    const encrypted = encryptVaultValue({
      plaintext: value,
      key: this.key,
      now: options.now ?? this.now(),
      ...(existing ? { existing } : {}),
    });
    const grants = next
      ? upsertVaultGrant(current.grants, { ...options.grant!, storedKey: normalizedKey })
      : current.grants;
    const snapshot = {
      ...current.snapshot,
      vault: {
        version: 1 as const,
        keyFingerprint: this.keyFingerprint,
        values: { ...current.values, [normalizedKey]: encrypted },
        grants,
      },
    };
    const committed = await this.commitSnapshot<{
      status: VaultValueStatus;
      grant?: VaultAccessGrant;
    }>(
      snapshot,
      "set_with_grant",
      vaultMutationOptions(options, { key: normalizedKey, value, grant: next }),
      current.expectedGeneration,
    );
    const grant = next
      ? (grants.find(
          (candidate) =>
            candidate.storedKey === next.storedKey &&
            candidate.referenceName === next.referenceName &&
            candidate.capletId === next.capletId &&
            sameOrigin(candidate.origin, next.origin),
        ) as VaultAccessGrant)
      : undefined;
    return {
      status: {
        key: normalizedKey,
        present: true,
        valueBytes: encrypted.valueBytes,
        createdAt: encrypted.createdAt,
        updatedAt: encrypted.updatedAt,
      },
      ...(grant ? { grant } : {}),
      ...(committed.kind === "replayed" ? { replayed: true } : {}),
    };
  }

  async getStatus(key: string): Promise<VaultValueStatus> {
    const normalizedKey = validateVaultKeyName(key);
    await this.ensureAuthorized({ operation: "read", storedKey: normalizedKey });
    const current = await this.readState();
    const record = current.values[normalizedKey];
    return record
      ? {
          key: normalizedKey,
          present: true,
          valueBytes: record.valueBytes,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        }
      : { key: normalizedKey, present: false };
  }

  async listValues(): Promise<VaultValueStatus[]> {
    await this.ensureAuthorized({ operation: "read" });
    const current = await this.readState();
    return Object.entries(current.values)
      .map(([key, record]) => ({
        key,
        present: true as const,
        valueBytes: record.valueBytes,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }
  async delete(key: string, options: VaultMutationOptions = {}): Promise<VaultDeleteStatus> {
    const normalizedKey = validateVaultKeyName(key);
    await this.ensureAuthorized({ operation: "write", storedKey: normalizedKey });
    const current = await this.readState();
    const existing = current.values[normalizedKey];
    const grantsRetained = current.grants.filter(
      (grant) => grant.storedKey === normalizedKey,
    ).length;
    if (existing === undefined) {
      return { key: normalizedKey, deleted: false, grantsRetained };
    }
    const values = { ...current.values };
    delete values[normalizedKey];
    await this.commitSnapshot(
      {
        ...current.snapshot,
        vault: {
          version: 1 as const,
          keyFingerprint: this.keyFingerprint,
          values,
          grants: current.grants,
        },
      },
      "delete",
      options,
      current.expectedGeneration,
    );
    return { key: normalizedKey, deleted: true, grantsRetained };
  }

  async grantAccess(
    input: VaultAccessGrantInput,
    options: VaultMutationOptions = {},
  ): Promise<VaultAccessGrant> {
    const next = normalizeVaultGrant(input);
    assertStableAuthorityOrigin(next.origin);
    await this.ensureAuthorized({
      operation: "grant",
      storedKey: next.storedKey,
      referenceName: next.referenceName,
      capletId: next.capletId,
    });
    const current = await this.readState();
    const grants = upsertVaultGrant(current.grants, input);
    const snapshot = {
      ...current.snapshot,
      vault: {
        version: 1 as const,
        keyFingerprint: this.keyFingerprint,
        values: current.values,
        grants,
      },
    };
    await this.commitSnapshot(snapshot, "grant", options, current.expectedGeneration);
    return grants.find(
      (grant) =>
        grant.storedKey === next.storedKey &&
        grant.referenceName === next.referenceName &&
        grant.capletId === next.capletId &&
        sameOrigin(grant.origin, next.origin),
    ) as VaultAccessGrant;
  }

  async listAccess(filter: VaultAccessGrantFilter = {}): Promise<VaultAccessGrant[]> {
    await this.ensureAuthorized({
      operation: "read",
      ...(filter.storedKey ? { storedKey: filter.storedKey } : {}),
      ...(filter.referenceName ? { referenceName: filter.referenceName } : {}),
      ...(filter.capletId ? { capletId: filter.capletId } : {}),
    });
    const current = await this.readState();
    return filterVaultGrants(current.grants, filter);
  }

  async revokeAccess(
    filter: VaultAccessGrantFilter,
    options: VaultMutationOptions = {},
  ): Promise<VaultAccessGrant[]> {
    await this.ensureAuthorized({
      operation: "revoke",
      ...(filter.storedKey ? { storedKey: filter.storedKey } : {}),
      ...(filter.referenceName ? { referenceName: filter.referenceName } : {}),
      ...(filter.capletId ? { capletId: filter.capletId } : {}),
    });
    const current = await this.readState();
    const removed = filterVaultGrants(current.grants, filter);
    if (removed.length === 0) return [];
    const removedKeys = new Set(removed.map(accessGrantIdentity));
    const grants = current.grants.filter((grant) => !removedKeys.has(accessGrantIdentity(grant)));
    const snapshot = {
      ...current.snapshot,
      vault: {
        version: 1 as const,
        keyFingerprint: this.keyFingerprint,
        values: current.values,
        grants,
      },
    };
    await this.commitSnapshot(snapshot, "revoke", options, current.expectedGeneration);
    return removed;
  }

  async resolveGrantedValue(input: {
    referenceName: string;
    capletId: string;
    origin: VaultConfigOrigin;
  }): Promise<VaultResolvedGrant> {
    const referenceName = validateVaultKeyName(input.referenceName);
    assertStableAuthorityOrigin(input.origin);
    await this.ensureAuthorized({
      operation: "read",
      referenceName,
      capletId: input.capletId,
    });
    const current = await this.readState();
    const grant = filterVaultGrants(current.grants, {
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
    const record = current.values[grant.storedKey];
    if (!record) {
      return {
        reason: "missing",
        storedKey: grant.storedKey,
        referenceName,
        capletId: input.capletId,
        origin: input.origin,
      };
    }
    return {
      storedKey: grant.storedKey,
      value: decryptVaultValue(record, this.key),
    };
  }

  private async readState(): Promise<{
    snapshot: Record<string, unknown>;
    values: Record<string, VaultEncryptedRecord>;
    grants: VaultAccessGrant[];
    expectedGeneration: AuthorityGenerationIdentity | null;
  }> {
    const head = await this.authority.readHead();
    if (!head) {
      return { snapshot: { caplets: {} }, values: {}, grants: [], expectedGeneration: null };
    }
    const generation = await this.authority.readGeneration(head.id);
    const snapshot = isRecord(generation.snapshot) ? structuredClone(generation.snapshot) : {};
    const nested = isRecord(snapshot.vault) ? snapshot.vault : undefined;
    const fingerprint =
      typeof nested?.keyFingerprint === "string" ? nested.keyFingerprint : undefined;
    if (fingerprint && fingerprint !== this.keyFingerprint) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Shared Vault encryption key does not match authority state.",
      );
    }
    const values: Record<string, VaultEncryptedRecord> = {};
    if (isRecord(nested?.values)) {
      for (const [name, record] of Object.entries(nested.values)) {
        values[name] = parseEncryptedRecord(record);
      }
    }
    const grants = Array.isArray(nested?.grants) ? nested.grants.map(parseStoredGrant) : [];
    return { snapshot, values, grants, expectedGeneration: authorityGenerationIdentity(head) };
  }

  private async commitSnapshot<TResult = unknown>(
    snapshot: Record<string, unknown>,
    operation: string,
    options: VaultMutationOptions = {},
    expectedGenerationFromRead: AuthorityGenerationIdentity | null,
  ): Promise<AuthorityCommitResult<TResult>> {
    const command = {
      kind: "replace_snapshot",
      snapshot: {
        ...snapshot,
        caplets: isRecord(snapshot.caplets) ? snapshot.caplets : {},
      },
    };
    const authorityCommand = command as never;
    const requestDigest =
      options.requestDigest ??
      createHash("sha256")
        .update(stableJsonStringify({ operation, snapshot: command.snapshot }))
        .digest("hex");
    const result: AuthorityCommitResult<TResult> = await this.authority.commit<TResult>({
      authorityId: this.authorityId,
      currentHostId: this.currentHostId,
      principalId: this.principalId,
      expectedGeneration:
        options.expectedGeneration !== undefined
          ? options.expectedGeneration
          : expectedGenerationFromRead,
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      requestDigest,
      command: authorityCommand,
    });
    if (result.kind === "conflict") {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Vault authority generation changed; retry the request.",
      );
    }
    if (result.kind === "rate_limited" || result.kind === "quota_exhausted") {
      throw new CapletsError("SERVER_UNAVAILABLE", "Vault authority mutation is rate limited.", {
        retryAfterMs: result.retryAfterMs,
      });
    }
    return result;
  }

  private async ensureAuthorized(input: AuthorityVaultAuthorization): Promise<void> {
    const result = await this.authorize?.(input);
    if (result === false) {
      throw new CapletsError("AUTH_FAILED", "Vault authority authorization failed.");
    }
  }
}

function assertStableAuthorityOrigin(origin: VaultConfigOrigin): void {
  if (origin.kind !== "authority" && !origin.identity) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Shared Vault grants require stable provenance identity; local paths are not portable.",
    );
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function authorityGenerationIdentity(
  head: AuthorityHead | null,
): AuthorityGenerationIdentity | null {
  return head
    ? {
        authorityId: head.authorityId,
        id: head.id,
        sequence: head.sequence,
        predecessorId: head.predecessorId,
      }
    : null;
}
function vaultMutationOptions(
  options: VaultMutationOptions,
  semantic: { key: string; value: string; grant?: VaultAccessGrant | undefined },
): VaultMutationOptions {
  if (!options.idempotencyKey || options.requestDigest) return options;
  const grant = semantic.grant;
  const origin =
    grant?.origin.kind === "authority"
      ? {
          kind: "authority" as const,
          authorityId: grant.origin.authorityId,
          recordId: grant.origin.recordId,
        }
      : grant?.origin
        ? {
            kind: grant.origin.kind,
            identity: grant.origin.identity ?? grant.origin.path,
          }
        : null;
  const valueDigest = createHash("sha256").update(semantic.value).digest("hex");
  return {
    ...options,
    requestDigest: createHash("sha256")
      .update(
        stableJsonStringify({
          key: semantic.key,
          valueDigest,
          grant: grant
            ? {
                storedKey: grant.storedKey,
                referenceName: grant.referenceName,
                capletId: grant.capletId,
                origin,
              }
            : null,
        }),
      )
      .digest("hex"),
  };
}

function accessGrantIdentity(grant: VaultAccessGrant): string {
  const originIdentity =
    grant.origin.kind === "authority"
      ? `${grant.origin.authorityId}\0${grant.origin.recordId}`
      : (grant.origin.identity ?? grant.origin.path);
  return [
    grant.storedKey,
    grant.referenceName,
    grant.capletId,
    grant.origin.kind,
    originIdentity,
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
  let origin: VaultConfigOrigin;
  if (originRecord.kind === "authority") {
    if (
      typeof originRecord.authorityId !== "string" ||
      typeof originRecord.recordId !== "string" ||
      typeof originRecord.generationId !== "string"
    ) {
      throw new CapletsError("CONFIG_INVALID", "Vault access grant origin is malformed.");
    }
    origin = {
      kind: "authority",
      authorityId: originRecord.authorityId,
      recordId: originRecord.recordId,
      generationId: originRecord.generationId,
    };
  } else {
    if (
      typeof originRecord.kind !== "string" ||
      typeof originRecord.path !== "string" ||
      !["global-config", "global-file", "project-config", "project-file"].includes(
        originRecord.kind,
      )
    ) {
      throw new CapletsError("CONFIG_INVALID", "Vault access grant origin is malformed.");
    }
    origin = {
      kind: originRecord.kind as Exclude<VaultConfigOrigin["kind"], "authority">,
      path: originRecord.path,
      ...(typeof originRecord.identity === "string" ? { identity: originRecord.identity } : {}),
    };
  }
  const normalized = normalizeVaultGrant({
    storedKey: record.storedKey,
    referenceName: record.referenceName,
    capletId: record.capletId,
    origin,
  });
  return {
    ...normalized,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
