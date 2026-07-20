import { Buffer } from "node:buffer";
import { createHash, createHmac, randomUUID } from "node:crypto";
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
import type {
  HostDatabase,
  HostDatabaseTransaction,
  PostgresHostDatabase,
  SqliteHostDatabase,
} from "./types";

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

export type ResolvedVaultValueStoreOptions = {
  root: string;
  keyFile: string;
  env: Record<string, string | undefined>;
};

export function resolveVaultValueStoreOptions(
  options: VaultValueStoreOptions = {},
): ResolvedVaultValueStoreOptions {
  const root = options.root ?? join(defaultStateBaseDir(options.env), "caplets", "vault");
  return {
    root,
    keyFile: options.keyFile ?? join(root, "vault-key"),
    env: options.env ?? process.env,
  };
}

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

export type PreparedVaultValueSet = {
  key: string;
  plaintext: string;
  encryptionKey: Buffer;
  force: boolean;
  expectedGeneration?: number | undefined;
  operatorClientId?: string | undefined;
};

export function prepareVaultValueSet(
  key: string,
  value: string,
  options: VaultValueSetOptions = {},
  storeOptions: VaultValueStoreOptions = {},
): PreparedVaultValueSet {
  const normalizedKey = validateVaultKeyName(key);
  validateValue(value);
  validateSetOptions(options);
  const { keyFile, env } = resolveVaultValueStoreOptions(storeOptions);
  return {
    key: normalizedKey,
    plaintext: value,
    encryptionKey: ensureVaultKey({ keyFile, env }),
    force: options.force ?? false,
    ...(options.expectedGeneration !== undefined
      ? { expectedGeneration: options.expectedGeneration }
      : {}),
    ...(options.operatorClientId !== undefined
      ? { operatorClientId: options.operatorClientId }
      : {}),
  };
}

export class VaultValueStore implements VaultValueRepository {
  readonly root: string;
  readonly keyFile: string;
  readonly env: Record<string, string | undefined>;

  constructor(
    private readonly database: HostDatabase,
    options: VaultValueStoreOptions = {},
  ) {
    const resolved = resolveVaultValueStoreOptions(options);
    this.root = resolved.root;
    this.keyFile = resolved.keyFile;
    this.env = resolved.env;
  }

  hostRuntimeFingerprint(hostConfigurationFingerprint: string): string {
    const key = ensureVaultKey({ keyFile: this.keyFile, env: this.env });
    const digest = createHmac("sha256", key)
      .update("caplets-host-runtime-fingerprint-v1")
      .update("\0")
      .update(hostConfigurationFingerprint)
      .digest("hex");
    return `hmac-sha256:${digest}`;
  }

  async set(
    key: string,
    value: string,
    options: VaultValueSetOptions = {},
  ): Promise<PresentVaultValueStatus> {
    const prepared = prepareVaultValueSet(key, value, options, {
      root: this.root,
      keyFile: this.keyFile,
      env: this.env,
    });
    if (this.database.dialect === "sqlite") {
      return this.database.db.transaction(
        (transaction) => setPreparedVaultValueSqlite(transaction, prepared),
        { behavior: "immediate" },
      );
    }
    return await this.database.db.transaction(
      async (transaction) => await setPreparedVaultValuePostgres(transaction, prepared),
    );
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
      this.database.db.transaction((transaction) =>
        importLegacyValuesSqlite(transaction, validated, this.keyFile, this.env),
      );
      return;
    }
    await this.database.db.transaction(
      async (transaction) =>
        await importLegacyValuesPostgres(transaction, validated, this.keyFile, this.env),
    );
  }

  importLegacyValuesInTransaction(
    values: LegacyVaultValueMigrationRecord[],
    transaction: HostDatabaseTransaction,
  ): void | Promise<void> {
    const validated = validateLegacyValueImports(values);
    if (validated.length === 0) return;
    return transaction.dialect === "sqlite"
      ? importLegacyValuesSqlite(transaction.db, validated, this.keyFile, this.env)
      : importLegacyValuesPostgres(transaction.db, validated, this.keyFile, this.env);
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
  verifyLegacyValuesInTransaction(
    values: LegacyVaultValueMigrationRecord[],
    transaction: HostDatabaseTransaction,
  ): void | Promise<void> {
    const validated = validateLegacyValueImports(values);
    const encryptionKey = () => loadVaultKey({ keyFile: this.keyFile, env: this.env });
    return transaction.dialect === "sqlite"
      ? verifyLegacyValuesSqlite(transaction.db, validated, encryptionKey)
      : verifyLegacyValuesPostgres(transaction.db, validated, encryptionKey);
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

type SqliteVaultValueTransaction = Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0];
type SqliteVaultValueDatabase = SqliteHostDatabase | SqliteVaultValueTransaction;
type PostgresVaultValueTransaction = Parameters<
  Parameters<PostgresHostDatabase["transaction"]>[0]
>[0];
type PostgresVaultValueDatabase = PostgresHostDatabase | PostgresVaultValueTransaction;
function importLegacyValuesSqlite(
  database: SqliteVaultValueDatabase,
  values: LegacyVaultValueMigrationRecord[],
  keyFile: string,
  env: Record<string, string | undefined>,
): void {
  assertLegacyValuesMatchSqlite(database, values, () => loadVaultKey({ keyFile, env }));
  const pending = values.filter(
    (value) =>
      !database
        .select({ key: sqlite.vaultValues.vaultKey })
        .from(sqlite.vaultValues)
        .where(eq(sqlite.vaultValues.vaultKey, value.key))
        .get(),
  );
  if (pending.length === 0) return;
  const key = ensureVaultKey({ keyFile, env });
  database
    .insert(sqlite.vaultValues)
    .values(pending.map((value) => legacyValueRow(value, key)))
    .run();
}

async function importLegacyValuesPostgres(
  database: PostgresVaultValueDatabase,
  values: LegacyVaultValueMigrationRecord[],
  keyFile: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  for (const value of values) {
    await database.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([
        VAULT_VALUES_NAMESPACE,
        value.key,
      ])}, 0))`,
    );
  }
  await assertLegacyValuesMatchPostgres(database, values, () => loadVaultKey({ keyFile, env }));
  const existing = await database
    .select({ key: postgres.vaultValues.vaultKey })
    .from(postgres.vaultValues);
  const existingKeys = new Set(existing.map((row) => row.key));
  const pending = values.filter((value) => !existingKeys.has(value.key));
  if (pending.length === 0) return;
  const key = ensureVaultKey({ keyFile, env });
  await database
    .insert(postgres.vaultValues)
    .values(pending.map((value) => legacyValueRow(value, key)));
}

function verifyLegacyValuesSqlite(
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
    if (!row || !legacyValueMatches(row, value, encryptionKey())) {
      throw legacyValueVerificationError(value.key);
    }
  }
}

async function verifyLegacyValuesPostgres(
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
    if (!row || !legacyValueMatches(row, value, encryptionKey())) {
      throw legacyValueVerificationError(value.key);
    }
  }
}

function legacyValueVerificationError(key: string): CapletsError {
  return new CapletsError("INTERNAL_ERROR", `Vault key ${key} failed post-migration verification.`);
}

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

export function setPreparedVaultValueSqlite(
  db: SqliteVaultValueTransaction,
  prepared: PreparedVaultValueSet,
): PresentVaultValueStatus {
  const current = db
    .select()
    .from(sqlite.vaultValues)
    .where(eq(sqlite.vaultValues.vaultKey, prepared.key))
    .get();
  const existing = current ? encryptedRecordForRow(current, prepared.key) : undefined;
  if (existing && !prepared.force) {
    throw new CapletsError("CONFIG_EXISTS", `Vault key ${prepared.key} already exists.`);
  }
  assertExpectedGeneration(current?.generation, prepared.expectedGeneration);
  const mutationCreatedAt = mutationTimestamp(new Date().toISOString(), existing);
  const encrypted = encryptPreparedVaultValue(prepared, mutationCreatedAt, existing);
  const generation = (current?.generation ?? 0) + 1;
  db.insert(sqlite.vaultValues)
    .values(rowValues(prepared.key, generation, encrypted))
    .onConflictDoUpdate({
      target: sqlite.vaultValues.vaultKey,
      set: rowValues(prepared.key, generation, encrypted),
    })
    .run();
  if (prepared.operatorClientId) {
    db.insert(sqlite.operatorActivity)
      .values(
        activity(
          prepared.operatorClientId,
          "vault_value_written",
          prepared.key,
          generation,
          mutationCreatedAt,
        ),
      )
      .run();
  }
  return statusForEncryptedRecord(prepared.key, generation, encrypted);
}

export async function setPreparedVaultValuePostgres(
  db: PostgresVaultValueTransaction,
  prepared: PreparedVaultValueSet,
): Promise<PresentVaultValueStatus> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vault-value", prepared.key])}, 0))`,
  );
  const [current] = await db
    .select()
    .from(postgres.vaultValues)
    .where(eq(postgres.vaultValues.vaultKey, prepared.key))
    .for("update")
    .limit(1);
  const existing = current ? encryptedRecordForRow(current, prepared.key) : undefined;
  if (existing && !prepared.force) {
    throw new CapletsError("CONFIG_EXISTS", `Vault key ${prepared.key} already exists.`);
  }
  assertExpectedGeneration(current?.generation, prepared.expectedGeneration);
  const mutationCreatedAt = await postgresMutationTimestamp(db, existing);
  const encrypted = encryptPreparedVaultValue(prepared, mutationCreatedAt, existing);
  const generation = (current?.generation ?? 0) + 1;
  await db
    .insert(postgres.vaultValues)
    .values(rowValues(prepared.key, generation, encrypted))
    .onConflictDoUpdate({
      target: postgres.vaultValues.vaultKey,
      set: rowValues(prepared.key, generation, encrypted),
    });
  if (prepared.operatorClientId) {
    await db
      .insert(postgres.operatorActivity)
      .values(
        activity(
          prepared.operatorClientId,
          "vault_value_written",
          prepared.key,
          generation,
          mutationCreatedAt,
        ),
      );
  }
  return statusForEncryptedRecord(prepared.key, generation, encrypted);
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

function encryptPreparedVaultValue(
  prepared: PreparedVaultValueSet,
  mutationCreatedAt: string,
  existing: VaultEncryptedRecord | undefined,
): VaultEncryptedRecord {
  return encryptVaultValue({
    plaintext: prepared.plaintext,
    key: prepared.encryptionKey,
    now: new Date(mutationCreatedAt),
    ...(existing ? { existing } : {}),
  });
}

function mutationTimestamp(
  authorityTimestamp: string,
  existing: VaultEncryptedRecord | undefined,
): string {
  return existing && authorityTimestamp < existing.updatedAt
    ? existing.updatedAt
    : authorityTimestamp;
}

async function postgresMutationTimestamp(
  db: PostgresVaultValueTransaction,
  existing: VaultEncryptedRecord | undefined,
): Promise<string> {
  const result = await db.execute<{ timestamp: string }>(
    sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "timestamp"`,
  );
  const timestamp = result.rows[0]?.timestamp;
  if (!timestamp) {
    throw new CapletsError("INTERNAL_ERROR", "Vault mutation clock query failed.");
  }
  return mutationTimestamp(timestamp, existing);
}

function activity(
  operatorClientId: string,
  action: "vault_value_written" | "vault_value_deleted",
  key: string,
  generation: number,
  createdAt = new Date().toISOString(),
) {
  return {
    activityKey: randomUUID(),
    operatorClientId,
    action,
    targetKind: "vault_value",
    targetKey: key,
    outcome: "succeeded",
    metadata: { generation },
    createdAt,
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
