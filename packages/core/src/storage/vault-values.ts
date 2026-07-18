import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { defaultStateBaseDir } from "../config/paths";
import { CapletsError } from "../errors";
import {
  decryptVaultValue,
  encryptVaultValue,
  parseEncryptedRecord,
  type VaultEncryptedRecord,
} from "../vault/crypto";
import type { LegacyVaultValueMigrationRecord } from "../vault";
import {
  ensureVaultKey,
  loadVaultKey,
  validateVaultKeyName,
  vaultKeySourceStatus,
} from "../vault/keys";
import { VAULT_MAX_VALUE_BYTES, type VaultKeySourceStatus } from "../vault/types";
import * as postgres from "./schema/postgres";
import * as sqlite from "./schema/sqlite";
import type { HostDatabase, PostgresHostDatabase, SqliteHostDatabase } from "./types";

export const VAULT_VALUES_NAMESPACE = "vault-values";

export type VaultValueRecordStatus =
  | {
      key: string;
      present: false;
    }
  | {
      key: string;
      present: true;
      generation: number;
      valueBytes: number;
      createdAt: string;
      updatedAt: string;
    };

export type VaultValueSetOptions = {
  force?: boolean | undefined;
  expectedGeneration?: number | undefined;
  operatorClientId?: string | undefined;
  now?: Date | undefined;
};

export type VaultValueDeleteOptions = {
  expectedGeneration?: number | undefined;
  operatorClientId?: string | undefined;
};

export type VaultValueDeleteResult =
  | {
      key: string;
      deleted: false;
    }
  | {
      key: string;
      deleted: true;
      generation: number;
    };

export type VaultValueStoreOptions = {
  root?: string | undefined;
  keyFile?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
};

export interface VaultValueRepository {
  set(
    key: string,
    value: string,
    options?: VaultValueSetOptions,
  ): Promise<Extract<VaultValueRecordStatus, { present: true }>>;
  getStatus(key: string): Promise<VaultValueRecordStatus>;
  listValues(): Promise<Array<Extract<VaultValueRecordStatus, { present: true }>>>;
  resolveValue(key: string): Promise<string>;
  delete(key: string, options?: VaultValueDeleteOptions): Promise<VaultValueDeleteResult>;
  keySourceStatus(): Promise<VaultKeySourceStatus>;
  assertLegacyValuesImportable(values: LegacyVaultValueMigrationRecord[]): Promise<void>;
  importLegacyValues(values: LegacyVaultValueMigrationRecord[]): Promise<void>;
  verifyLegacyValues(values: LegacyVaultValueMigrationRecord[]): Promise<void>;
}

type VaultValueRow = typeof sqlite.vaultValues.$inferSelect;
type PresentVaultValueStatus = Extract<VaultValueRecordStatus, { present: true }>;

export class VaultValueStore implements VaultValueRepository {
  readonly root: string;
  readonly keyFile: string;
  readonly env: Record<string, string | undefined>;

  constructor(
    private readonly database: HostDatabase,
    options: VaultValueStoreOptions = {},
  ) {
    this.root = options.root ?? join(defaultStateBaseDir(options.env), "caplets", "vault");
    this.keyFile = options.keyFile ?? join(this.root, "vault-key");
    this.env = options.env ?? process.env;
  }

  async set(
    key: string,
    value: string,
    options: VaultValueSetOptions = {},
  ): Promise<PresentVaultValueStatus> {
    const normalizedKey = validateVaultKeyName(key);
    validateValue(value);
    validateSetOptions(options);
    const encryptionKey = () => ensureVaultKey({ keyFile: this.keyFile, env: this.env });

    return this.database.dialect === "sqlite"
      ? setSqlite(this.database.db, normalizedKey, value, options, encryptionKey)
      : await setPostgres(this.database.db, normalizedKey, value, options, encryptionKey);
  }

  async getStatus(key: string): Promise<VaultValueRecordStatus> {
    const normalizedKey = validateVaultKeyName(key);
    const row =
      this.database.dialect === "sqlite"
        ? this.database.db
            .select()
            .from(sqlite.vaultValues)
            .where(eq(sqlite.vaultValues.vaultKey, normalizedKey))
            .get()
        : (
            await this.database.db
              .select()
              .from(postgres.vaultValues)
              .where(eq(postgres.vaultValues.vaultKey, normalizedKey))
              .limit(1)
          )[0];
    return row ? statusForRow(row, normalizedKey) : { key: normalizedKey, present: false };
  }

  async listValues(): Promise<PresentVaultValueStatus[]> {
    const rows =
      this.database.dialect === "sqlite"
        ? this.database.db
            .select()
            .from(sqlite.vaultValues)
            .orderBy(asc(sqlite.vaultValues.vaultKey))
            .all()
        : await this.database.db
            .select()
            .from(postgres.vaultValues)
            .orderBy(asc(postgres.vaultValues.vaultKey));
    return rows.map((row) => statusForRow(row, row.vaultKey));
  }

  async resolveValue(key: string): Promise<string> {
    const normalizedKey = validateVaultKeyName(key);
    const row =
      this.database.dialect === "sqlite"
        ? this.database.db
            .select()
            .from(sqlite.vaultValues)
            .where(eq(sqlite.vaultValues.vaultKey, normalizedKey))
            .get()
        : (
            await this.database.db
              .select()
              .from(postgres.vaultValues)
              .where(eq(postgres.vaultValues.vaultKey, normalizedKey))
              .limit(1)
          )[0];
    if (!row) {
      throw new CapletsError("CONFIG_INVALID", `Vault key ${normalizedKey} is missing.`);
    }
    return decryptVaultValue(
      encryptedRecordForRow(row, normalizedKey),
      loadVaultKey({ keyFile: this.keyFile, env: this.env }),
    );
  }

  async assertLegacyValuesImportable(values: LegacyVaultValueMigrationRecord[]): Promise<void> {
    const validated = validateLegacyValueImports(values);
    if (this.database.dialect === "sqlite") {
      assertLegacyValuesMatchSqlite(this.database.db, validated, () =>
        loadVaultKey({ keyFile: this.keyFile, env: this.env }),
      );
    } else {
      await assertLegacyValuesMatchPostgres(this.database.db, validated, () =>
        loadVaultKey({ keyFile: this.keyFile, env: this.env }),
      );
    }
  }

  async importLegacyValues(values: LegacyVaultValueMigrationRecord[]): Promise<void> {
    const validated = validateLegacyValueImports(values);
    if (validated.length === 0) return;
    if (this.database.dialect === "sqlite") {
      this.database.db.transaction((transaction) => {
        assertLegacyValuesMatchSqlite(transaction, validated, () =>
          loadVaultKey({ keyFile: this.keyFile, env: this.env }),
        );
        const pending = validated.filter(
          (value) =>
            !transaction
              .select({ key: sqlite.vaultValues.vaultKey })
              .from(sqlite.vaultValues)
              .where(eq(sqlite.vaultValues.vaultKey, value.key))
              .get(),
        );
        if (pending.length === 0) return;
        const key = ensureVaultKey({ keyFile: this.keyFile, env: this.env });
        transaction
          .insert(sqlite.vaultValues)
          .values(pending.map((value) => legacyValueRow(value, key)))
          .run();
      });
      return;
    }
    await this.database.db.transaction(async (transaction) => {
      for (const value of validated) {
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
            VAULT_VALUES_NAMESPACE,
            value.key,
          ])}, 0))`,
        );
      }
      await assertLegacyValuesMatchPostgres(transaction, validated, () =>
        loadVaultKey({ keyFile: this.keyFile, env: this.env }),
      );
      const existing = await transaction
        .select({ key: postgres.vaultValues.vaultKey })
        .from(postgres.vaultValues);
      const existingKeys = new Set(existing.map((row) => row.key));
      const pending = validated.filter((value) => !existingKeys.has(value.key));
      if (pending.length === 0) return;
      const key = ensureVaultKey({ keyFile: this.keyFile, env: this.env });
      await transaction
        .insert(postgres.vaultValues)
        .values(pending.map((value) => legacyValueRow(value, key)));
    });
  }

  async verifyLegacyValues(values: LegacyVaultValueMigrationRecord[]): Promise<void> {
    for (const value of validateLegacyValueImports(values)) {
      const status = await this.getStatus(value.key);
      if (
        !status.present ||
        status.valueBytes !== value.valueBytes ||
        status.createdAt !== value.createdAt ||
        status.updatedAt !== value.updatedAt ||
        createHash("sha256")
          .update(await this.resolveValue(value.key), "utf8")
          .digest("base64url") !==
          createHash("sha256").update(value.plaintext, "utf8").digest("base64url")
      ) {
        throw new CapletsError(
          "INTERNAL_ERROR",
          `Vault key ${value.key} failed post-migration verification.`,
        );
      }
    }
  }

  async delete(
    key: string,
    options: VaultValueDeleteOptions = {},
  ): Promise<VaultValueDeleteResult> {
    const normalizedKey = validateVaultKeyName(key);
    validateDeleteOptions(options);
    return this.database.dialect === "sqlite"
      ? deleteSqlite(this.database.db, normalizedKey, options)
      : await deletePostgres(this.database.db, normalizedKey, options);
  }

  async keySourceStatus(): Promise<VaultKeySourceStatus> {
    return vaultKeySourceStatus({ keyFile: this.keyFile, env: this.env });
  }
}

type SqliteVaultValueDatabase =
  | SqliteHostDatabase
  | Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0];
type PostgresVaultValueDatabase =
  | PostgresHostDatabase
  | Parameters<Parameters<PostgresHostDatabase["transaction"]>[0]>[0];

function validateLegacyValueImports(
  values: LegacyVaultValueMigrationRecord[],
): LegacyVaultValueMigrationRecord[] {
  const keys = new Set<string>();
  const validated = values.map((value) => {
    const key = validateVaultKeyName(value.key);
    validateValue(value.plaintext);
    if (
      key !== value.key ||
      keys.has(key) ||
      value.valueBytes !== Buffer.byteLength(value.plaintext, "utf8") ||
      !isCanonicalTimestamp(value.createdAt) ||
      !isCanonicalTimestamp(value.updatedAt) ||
      value.updatedAt < value.createdAt
    ) {
      throw new CapletsError("CONFIG_INVALID", "A legacy Vault value record is malformed.");
    }
    keys.add(key);
    return value;
  });
  return validated.sort((left, right) => left.key.localeCompare(right.key));
}

function assertLegacyValuesMatchSqlite(
  database: SqliteVaultValueDatabase,
  values: LegacyVaultValueMigrationRecord[],
  encryptionKey: () => Buffer,
): void {
  for (const value of values) {
    const row = database
      .select()
      .from(sqlite.vaultValues)
      .where(eq(sqlite.vaultValues.vaultKey, value.key))
      .get();
    if (row && !legacyValueMatches(row, value, encryptionKey())) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Vault key ${value.key} conflicts with the legacy snapshot.`,
      );
    }
  }
}

async function assertLegacyValuesMatchPostgres(
  database: PostgresVaultValueDatabase,
  values: LegacyVaultValueMigrationRecord[],
  encryptionKey: () => Buffer,
): Promise<void> {
  for (const value of values) {
    const [row] = await database
      .select()
      .from(postgres.vaultValues)
      .where(eq(postgres.vaultValues.vaultKey, value.key))
      .limit(1);
    if (row && !legacyValueMatches(row, value, encryptionKey())) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Vault key ${value.key} conflicts with the legacy snapshot.`,
      );
    }
  }
}

function legacyValueMatches(
  row: VaultValueRow,
  value: LegacyVaultValueMigrationRecord,
  encryptionKey: Buffer,
): boolean {
  const encrypted = encryptedRecordForRow(row, value.key);
  return (
    encrypted.valueBytes === value.valueBytes &&
    encrypted.createdAt === value.createdAt &&
    encrypted.updatedAt === value.updatedAt &&
    createHash("sha256")
      .update(decryptVaultValue(encrypted, encryptionKey), "utf8")
      .digest("base64url") ===
      createHash("sha256").update(value.plaintext, "utf8").digest("base64url")
  );
}

function legacyValueRow(value: LegacyVaultValueMigrationRecord, key: Buffer) {
  const encrypted = parseVaultValueRecord({
    ...encryptVaultValue({ plaintext: value.plaintext, key, now: new Date(value.updatedAt) }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
  return rowValues(value.key, 1, encrypted);
}

function setSqlite(
  db: SqliteHostDatabase,
  key: string,
  value: string,
  options: VaultValueSetOptions,
  encryptionKey: () => Buffer,
): PresentVaultValueStatus {
  return db.transaction((transaction) => {
    const current = transaction
      .select()
      .from(sqlite.vaultValues)
      .where(eq(sqlite.vaultValues.vaultKey, key))
      .get();
    const existing = current ? encryptedRecordForRow(current, key) : undefined;
    if (existing && !options.force) {
      throw new CapletsError("CONFIG_EXISTS", `Vault key ${key} already exists.`);
    }
    assertExpectedGeneration(current?.generation, options.expectedGeneration);
    const encrypted = encryptVaultValue({
      plaintext: value,
      key: encryptionKey(),
      now: options.now ?? new Date(),
      ...(existing ? { existing } : {}),
    });
    const generation = (current?.generation ?? 0) + 1;
    transaction
      .insert(sqlite.vaultValues)
      .values(rowValues(key, generation, encrypted))
      .onConflictDoUpdate({
        target: sqlite.vaultValues.vaultKey,
        set: rowValues(key, generation, encrypted),
      })
      .run();
    if (options.operatorClientId) {
      transaction
        .insert(sqlite.operatorActivity)
        .values(activity(options.operatorClientId, "vault_value_written", key, generation))
        .run();
    }
    return statusForEncryptedRecord(key, generation, encrypted);
  });
}

async function setPostgres(
  db: PostgresHostDatabase,
  key: string,
  value: string,
  options: VaultValueSetOptions,
  encryptionKey: () => Buffer,
): Promise<PresentVaultValueStatus> {
  return await db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vault-value", key])}, 0))`,
    );
    const [current] = await transaction
      .select()
      .from(postgres.vaultValues)
      .where(eq(postgres.vaultValues.vaultKey, key))
      .for("update")
      .limit(1);
    const existing = current ? encryptedRecordForRow(current, key) : undefined;
    if (existing && !options.force) {
      throw new CapletsError("CONFIG_EXISTS", `Vault key ${key} already exists.`);
    }
    assertExpectedGeneration(current?.generation, options.expectedGeneration);
    const encrypted = encryptVaultValue({
      plaintext: value,
      key: encryptionKey(),
      now: options.now ?? new Date(),
      ...(existing ? { existing } : {}),
    });
    const generation = (current?.generation ?? 0) + 1;
    await transaction
      .insert(postgres.vaultValues)
      .values(rowValues(key, generation, encrypted))
      .onConflictDoUpdate({
        target: postgres.vaultValues.vaultKey,
        set: rowValues(key, generation, encrypted),
      });
    if (options.operatorClientId) {
      await transaction
        .insert(postgres.operatorActivity)
        .values(activity(options.operatorClientId, "vault_value_written", key, generation));
    }
    return statusForEncryptedRecord(key, generation, encrypted);
  });
}

function deleteSqlite(
  db: SqliteHostDatabase,
  key: string,
  options: VaultValueDeleteOptions,
): VaultValueDeleteResult {
  return db.transaction((transaction) => {
    const current = transaction
      .select()
      .from(sqlite.vaultValues)
      .where(eq(sqlite.vaultValues.vaultKey, key))
      .get();
    if (!current) {
      assertExpectedGeneration(undefined, options.expectedGeneration);
      return { key, deleted: false };
    }
    encryptedRecordForRow(current, key);
    assertExpectedGeneration(current.generation, options.expectedGeneration);
    transaction.delete(sqlite.vaultValues).where(eq(sqlite.vaultValues.vaultKey, key)).run();
    if (options.operatorClientId) {
      transaction
        .insert(sqlite.operatorActivity)
        .values(activity(options.operatorClientId, "vault_value_deleted", key, current.generation))
        .run();
    }
    return { key, deleted: true, generation: current.generation };
  });
}

async function deletePostgres(
  db: PostgresHostDatabase,
  key: string,
  options: VaultValueDeleteOptions,
): Promise<VaultValueDeleteResult> {
  return await db.transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vault-value", key])}, 0))`,
    );
    const [current] = await transaction
      .select()
      .from(postgres.vaultValues)
      .where(eq(postgres.vaultValues.vaultKey, key))
      .for("update")
      .limit(1);
    if (!current) {
      assertExpectedGeneration(undefined, options.expectedGeneration);
      return { key, deleted: false };
    }
    encryptedRecordForRow(current, key);
    assertExpectedGeneration(current.generation, options.expectedGeneration);
    await transaction.delete(postgres.vaultValues).where(eq(postgres.vaultValues.vaultKey, key));
    if (options.operatorClientId) {
      await transaction
        .insert(postgres.operatorActivity)
        .values(activity(options.operatorClientId, "vault_value_deleted", key, current.generation));
    }
    return { key, deleted: true, generation: current.generation };
  });
}

export function parseVaultValueRecord(value: unknown): VaultEncryptedRecord {
  const parsed = parseEncryptedRecord(value);
  const actualFields = Object.keys(value as Record<string, unknown>).sort();
  const expectedFields = [
    "algorithm",
    "authTag",
    "ciphertext",
    "createdAt",
    "nonce",
    "updatedAt",
    "valueBytes",
    "version",
  ];
  if (
    actualFields.length !== expectedFields.length ||
    actualFields.some((field, index) => field !== expectedFields[index]) ||
    !Number.isSafeInteger(parsed.valueBytes) ||
    parsed.valueBytes < 0 ||
    parsed.valueBytes > VAULT_MAX_VALUE_BYTES ||
    !isCanonicalBase64Url(parsed.nonce, 12) ||
    !isCanonicalBase64Url(parsed.authTag, 16) ||
    !isCanonicalBase64Url(parsed.ciphertext, parsed.valueBytes) ||
    !isCanonicalTimestamp(parsed.createdAt) ||
    !isCanonicalTimestamp(parsed.updatedAt) ||
    parsed.updatedAt < parsed.createdAt
  ) {
    throw new CapletsError("CONFIG_INVALID", "Persisted Vault value record is malformed.");
  }
  return parsed;
}

function encryptedRecordForRow(row: VaultValueRow, expectedKey: string): VaultEncryptedRecord {
  if (row.vaultKey !== expectedKey || !Number.isSafeInteger(row.generation) || row.generation < 1) {
    throw new CapletsError("CONFIG_INVALID", "Persisted Vault value row is malformed.");
  }
  return parseVaultValueRecord({
    version: row.version,
    algorithm: row.algorithm,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    authTag: row.authTag,
    valueBytes: row.valueBytes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function statusForRow(row: VaultValueRow, expectedKey: string): PresentVaultValueStatus {
  return statusForEncryptedRecord(
    expectedKey,
    row.generation,
    encryptedRecordForRow(row, expectedKey),
  );
}

function statusForEncryptedRecord(
  key: string,
  generation: number,
  record: VaultEncryptedRecord,
): PresentVaultValueStatus {
  return {
    key,
    present: true,
    generation,
    valueBytes: record.valueBytes,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function rowValues(key: string, generation: number, record: VaultEncryptedRecord) {
  return {
    vaultKey: key,
    generation,
    version: record.version,
    algorithm: record.algorithm,
    nonce: record.nonce,
    ciphertext: record.ciphertext,
    authTag: record.authTag,
    valueBytes: record.valueBytes,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function activity(
  operatorClientId: string,
  action: "vault_value_written" | "vault_value_deleted",
  key: string,
  generation: number,
) {
  return {
    activityKey: randomUUID(),
    operatorClientId,
    action,
    targetKind: "vault_value",
    targetKey: key,
    outcome: "succeeded",
    metadata: { generation },
    createdAt: new Date().toISOString(),
  };
}

function validateValue(value: string): void {
  if (typeof value !== "string") {
    throw new CapletsError("REQUEST_INVALID", "Vault values must be strings.");
  }
  if (Buffer.byteLength(value, "utf8") > VAULT_MAX_VALUE_BYTES) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Vault values must be ${VAULT_MAX_VALUE_BYTES} bytes or smaller.`,
    );
  }
}

function validateSetOptions(options: VaultValueSetOptions): void {
  validateDeleteOptions(options);
  if (options.force !== undefined && typeof options.force !== "boolean") {
    throw new CapletsError("REQUEST_INVALID", "Vault force must be a boolean when provided.");
  }
  if (
    options.now !== undefined &&
    (!(options.now instanceof Date) || !Number.isFinite(options.now.getTime()))
  ) {
    throw new CapletsError("REQUEST_INVALID", "Vault mutation time must be a valid date.");
  }
}

function validateDeleteOptions(options: VaultValueDeleteOptions): void {
  if (
    options.expectedGeneration !== undefined &&
    (!Number.isSafeInteger(options.expectedGeneration) || options.expectedGeneration < 0)
  ) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Vault expected generation must be a non-negative integer.",
    );
  }
  if (options.operatorClientId !== undefined && !options.operatorClientId.trim()) {
    throw new CapletsError("REQUEST_INVALID", "Operator client ID is required when provided.");
  }
}

function assertExpectedGeneration(
  currentGeneration: number | undefined,
  expectedGeneration: number | undefined,
): void {
  if (expectedGeneration === undefined) return;
  const normalizedCurrentGeneration = currentGeneration ?? 0;
  if (normalizedCurrentGeneration === expectedGeneration) return;
  throw new CapletsError(
    "REQUEST_INVALID",
    "Vault value changed after it was read; reload and retry.",
    {
      kind: "stale_generation",
      expectedGeneration,
      currentGeneration: normalizedCurrentGeneration,
    },
  );
}

function isCanonicalBase64Url(value: string, expectedBytes: number): boolean {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === expectedBytes && decoded.toString("base64url") === value;
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}
