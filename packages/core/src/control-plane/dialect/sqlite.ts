import { chmod, open, lstat, readFile, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { ResolvedSqliteStorage } from "../storage-config";
import {
  assertMigrationEnvironment,
  assertRollbackAllowed,
  loadMigrationRegistry,
  planPendingMigrations,
  type AppliedMigration,
  type LoadedMigrationRegistry,
  type MigrationEnvironment,
} from "./migrations";
import { quoteSafeSqlIdentifier } from "../schema/model-codec";

const require = createRequire(import.meta.url);
const SQLITE_HISTORY_TABLE = "__caplets_migration_history_v1";

type SqliteStatement = {
  all(...values: unknown[]): unknown[];
  get(...values: unknown[]): unknown;
  run(...values: unknown[]): { changes: number | bigint };
};

type SqliteDatabase = {
  exec(sql: string): void;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  prepare(sql: string): SqliteStatement;
  backup(destination: string): Promise<unknown>;
  close(): void;
};

type SqliteConstructor = new (
  filename: string,
  options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number },
) => SqliteDatabase;

export type SqliteControlPlaneDialect = {
  readonly databasePath: string;
  readonly ready: boolean;
  migrate(): readonly string[];
  rollbackLatest(): string;
  query<T>(sql: string, parameters?: readonly unknown[]): readonly T[];
  execute(sql: string, parameters?: readonly unknown[]): number;
  immediateTransaction<T>(work: () => T): T;
  exclusiveTransaction<T>(work: () => T): T;
  rebuildTable(request: {
    tableName: string;
    replacementName: string;
    createReplacementSql: string;
    columns: readonly string[];
  }): void;
  integrityCheck(): void;
  onlineBackup(destination: string): Promise<void>;
  close(): Promise<void>;
};

export async function openSqliteControlPlaneDialect(options: {
  storage: ResolvedSqliteStorage;
  environment: MigrationEnvironment;
  assetRoot?: URL | string | undefined;
}): Promise<SqliteControlPlaneDialect> {
  const registry = await loadMigrationRegistry({
    dialect: "sqlite",
    ...(options.assetRoot === undefined ? {} : { assetRoot: options.assetRoot }),
  });
  assertMigrationEnvironment(registry, options.environment);
  const databasePath = resolve(options.storage.databasePath);
  await assertOwnerPrivateDirectory(dirname(databasePath));
  const lock = await acquireWriterLock(databasePath);
  let database: SqliteDatabase | undefined;
  try {
    await ensureOwnerPrivateDatabaseFile(databasePath);
    const Database = require("better-sqlite3") as SqliteConstructor;
    database = new Database(databasePath, { timeout: 0 });
    await assertOwnerPrivateFile(databasePath);
    configureDatabase(database);
    ensureStorageIdentity(database, options.storage.logicalHostId, options.storage.storeId);
    return createDialect(databasePath, database, lock, registry, options.environment);
  } catch (error) {
    database?.close();
    await releaseWriterLock(lock);
    throw error;
  }
}

function createDialect(
  databasePath: string,
  database: SqliteDatabase,
  lock: WriterLock,
  registry: LoadedMigrationRegistry,
  environment: MigrationEnvironment,
): SqliteControlPlaneDialect {
  let ready = false;
  let closed = false;
  const requireOpen = () => {
    if (closed) throw new Error("SQLite control-plane dialect is closed");
  };
  const requireReady = () => {
    requireOpen();
    if (!ready) throw new Error("SQLite control-plane dialect is not migration-ready");
  };
  const transaction = <T>(mode: "IMMEDIATE" | "EXCLUSIVE", work: () => T): T => {
    requireOpen();
    database.exec(`BEGIN ${mode}`);
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The original failure remains authoritative.
      }
      throw error;
    }
  };

  return {
    databasePath,
    get ready() {
      return ready;
    },
    migrate() {
      assertMigrationEnvironment(registry, environment);
      try {
        const appliedIds = transaction("EXCLUSIVE", () => {
          ensureHistoryTable(database);
          const applied = readAppliedMigrations(database);
          const pending = planPendingMigrations(registry, applied, environment);
          const activated: string[] = [];
          for (const migration of pending) {
            database.exec(migration.sql);
            const appliedAt = (environment.now ?? new Date()).toISOString();
            database
              .prepare(
                `INSERT INTO ${quoteSafeSqlIdentifier(SQLITE_HISTORY_TABLE)} ` +
                  "(migration_id, sql_sha256, manifest_sha256, destination_schema_version, applied_at) " +
                  "VALUES (?, ?, ?, ?, ?)",
              )
              .run(
                migration.manifest.migrationId,
                migration.manifest.sql.sha256,
                migration.manifest.manifestSha256,
                migration.manifest.destinationSchemaVersion,
                appliedAt,
              );
            activated.push(migration.manifest.migrationId);
          }
          return activated;
        });
        ready = true;
        return appliedIds;
      } catch (error) {
        ready = false;
        throw error;
      }
    },
    rollbackLatest() {
      requireOpen();
      const rolledBack = transaction("EXCLUSIVE", () => {
        ensureHistoryTable(database);
        const applied = readAppliedMigrations(database);
        const latest = applied.at(-1);
        if (!latest) throw new Error("No applied migration is available to roll back");
        const migration = registry.migrations.find(
          (candidate) => candidate.manifest.migrationId === latest.migrationId,
        );
        if (!migration) throw new Error("Applied migration is newer than this binary");
        assertRollbackAllowed(migration, latest.appliedAt, environment);
        if (migration.manifest.rollback.mode !== "down" || !migration.downSql) {
          throw new Error("SQLite rollback requires reviewed down SQL");
        }
        database.exec(migration.downSql);
        database
          .prepare(
            `DELETE FROM ${quoteSafeSqlIdentifier(SQLITE_HISTORY_TABLE)} WHERE migration_id = ?`,
          )
          .run(latest.migrationId);
        return latest.migrationId;
      });
      ready = false;
      return rolledBack;
    },
    query<T>(sql: string, parameters: readonly unknown[] = []) {
      requireReady();
      return database.prepare(sql).all(...parameters) as T[];
    },
    execute(sql: string, parameters: readonly unknown[] = []) {
      requireReady();
      return Number(database.prepare(sql).run(...parameters).changes);
    },
    immediateTransaction<T>(work: () => T) {
      requireReady();
      return transaction("IMMEDIATE", work);
    },
    exclusiveTransaction<T>(work: () => T) {
      requireReady();
      return transaction("EXCLUSIVE", work);
    },
    rebuildTable(request) {
      requireReady();
      const table = quoteSafeSqlIdentifier(request.tableName);
      const replacement = quoteSafeSqlIdentifier(request.replacementName);
      if (request.tableName === request.replacementName || request.columns.length === 0) {
        throw new Error("SQLite rebuild table request is invalid");
      }
      const columns = request.columns.map((column) => quoteSafeSqlIdentifier(column)).join(", ");
      const expectedPrefix = `CREATE TABLE ${replacement}`;
      if (!request.createReplacementSql.trimStart().startsWith(expectedPrefix)) {
        throw new Error("SQLite rebuild DDL does not target the validated replacement table");
      }
      transaction("EXCLUSIVE", () => {
        database.exec(request.createReplacementSql);
        database.exec(`INSERT INTO ${replacement} (${columns}) SELECT ${columns} FROM ${table}`);
        database.exec(`DROP TABLE ${table}`);
        database.exec(`ALTER TABLE ${replacement} RENAME TO ${table}`);
      });
    },
    integrityCheck() {
      requireReady();
      if (database.pragma("integrity_check", { simple: true }) !== "ok") {
        ready = false;
        throw new Error("SQLite integrity check failed");
      }
      if (database.pragma("foreign_key_check", { simple: true }) !== undefined) {
        ready = false;
        throw new Error("SQLite foreign-key integrity check failed");
      }
    },
    async onlineBackup(destination: string) {
      requireReady();
      const target = resolve(destination);
      if (target === databasePath)
        throw new Error("SQLite backup destination must differ from source");
      await assertOwnerPrivateDirectory(dirname(target));
      await database.backup(target);
      await chmod(target, 0o600);
      await assertOwnerPrivateFile(target);
    },
    async close() {
      if (closed) return;
      closed = true;
      ready = false;
      database.close();
      await releaseWriterLock(lock);
    },
  };
}

function configureDatabase(database: SqliteDatabase): void {
  database.pragma("foreign_keys = ON");
  database.pragma("trusted_schema = OFF");
  database.pragma("synchronous = FULL");
  database.pragma("journal_mode = WAL");
  database.pragma("locking_mode = EXCLUSIVE");
  database.pragma("busy_timeout = 0");
  if (database.pragma("foreign_keys", { simple: true }) !== 1) {
    throw new Error("SQLite foreign-key enforcement is unavailable");
  }
}

function ensureStorageIdentity(
  database: SqliteDatabase,
  logicalHostId: string,
  storeId: string,
): void {
  database.exec(
    'CREATE TABLE IF NOT EXISTS "__caplets_storage_identity_v1" (' +
      '"singleton" INTEGER PRIMARY KEY CHECK ("singleton" = 1), ' +
      '"logical_host_id" TEXT NOT NULL, "store_id" TEXT NOT NULL)',
  );
  const stored = database
    .prepare(
      'SELECT "logical_host_id" AS logicalHostId, "store_id" AS storeId ' +
        'FROM "__caplets_storage_identity_v1" WHERE "singleton" = 1',
    )
    .get();
  if (stored === undefined) {
    database
      .prepare(
        'INSERT INTO "__caplets_storage_identity_v1" ' +
          '("singleton", "logical_host_id", "store_id") VALUES (1, ?, ?)',
      )
      .run(logicalHostId, storeId);
    return;
  }
  if (!isRecord(stored)) throw new Error("SQLite storage identity is malformed");
  if (stored.logicalHostId !== logicalHostId || stored.storeId !== storeId) {
    throw new Error("SQLite storage identity does not match the resolved deployment");
  }
}

function ensureHistoryTable(database: SqliteDatabase): void {
  database.exec(
    `CREATE TABLE IF NOT EXISTS ${quoteSafeSqlIdentifier(SQLITE_HISTORY_TABLE)} (` +
      "migration_id TEXT PRIMARY KEY NOT NULL, " +
      "sql_sha256 TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, " +
      "destination_schema_version INTEGER NOT NULL, applied_at TEXT NOT NULL)",
  );
}

function readAppliedMigrations(database: SqliteDatabase): AppliedMigration[] {
  const rows = database
    .prepare(
      "SELECT migration_id AS migrationId, sql_sha256 AS sqlSha256, " +
        "manifest_sha256 AS manifestSha256, destination_schema_version AS destinationSchemaVersion, " +
        `applied_at AS appliedAt FROM ${quoteSafeSqlIdentifier(SQLITE_HISTORY_TABLE)} ORDER BY rowid`,
    )
    .all();
  const applied: AppliedMigration[] = [];
  for (const row of rows) {
    if (
      !isRecord(row) ||
      typeof row.migrationId !== "string" ||
      typeof row.sqlSha256 !== "string" ||
      typeof row.manifestSha256 !== "string" ||
      typeof row.destinationSchemaVersion !== "number" ||
      typeof row.appliedAt !== "string"
    ) {
      throw new Error("SQLite migration history row is malformed");
    }
    applied.push({
      migrationId: row.migrationId,
      sqlSha256: row.sqlSha256,
      manifestSha256: row.manifestSha256,
      destinationSchemaVersion: row.destinationSchemaVersion,
      appliedAt: row.appliedAt,
    });
  }
  return applied;
}

type WriterLock = { handle: FileHandle; path: string };

async function acquireWriterLock(databasePath: string): Promise<WriterLock> {
  const path = `${databasePath}.writer.lock`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ version: 1, pid: process.pid, databasePath })}\n`);
      return { handle, path };
    } catch (error) {
      if (!isAlreadyExists(error) || attempt > 0) {
        throw new Error("A SQLite control-plane writer already owns this database", {
          cause: error,
        });
      }
      let ownerPid: number | undefined;
      try {
        const value: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!isRecord(value)) throw new Error("writer lock is not an object");
        if (Number.isSafeInteger(value.pid) && Number(value.pid) > 0) ownerPid = Number(value.pid);
      } catch {
        throw new Error("SQLite writer lock is malformed; refusing unsafe recovery");
      }
      if (ownerPid !== undefined && processIsAlive(ownerPid)) {
        throw new Error("A SQLite control-plane writer already owns this database");
      }
      await rm(path);
    }
  }
  throw new Error("Unable to acquire SQLite writer lock");
}

async function releaseWriterLock(lock: WriterLock): Promise<void> {
  await lock.handle.close();
  await rm(lock.path, { force: true });
}

async function assertOwnerPrivateDirectory(path: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0) {
    throw new Error("SQLite directory must be owner-private");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("SQLite directory owner does not match the process owner");
  }
}

async function ensureOwnerPrivateDatabaseFile(path: string): Promise<void> {
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  await assertOwnerPrivateFile(path);
}

async function assertOwnerPrivateFile(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("SQLite database must be an owner-private regular file");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("SQLite database owner does not match the process owner");
  }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
