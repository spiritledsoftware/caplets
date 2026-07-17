import { chmod, open, lstat, readFile, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { AnySQLiteColumn, AnySQLiteTable } from "drizzle-orm/sqlite-core";
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
import { sqliteControlPlaneSchema } from "../schema/sqlite";
import type {
  ControlPlaneDatabaseRow,
  ControlPlaneFilter,
  ControlPlaneOrder,
  ControlPlaneTable,
  ControlPlaneSqlTransaction,
  ControlPlaneTransactionalDialect,
} from "../store";

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

export type SqliteControlPlaneDialect = ControlPlaneTransactionalDialect & {
  readonly databasePath: string;
  readonly backend: "sqlite";
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
  const orm = drizzle(database as never, { schema: sqliteControlPlaneSchema });
  let ready = false;
  let closed = false;
  const requireOpen = () => {
    if (closed) throw new Error("SQLite control-plane dialect is closed");
  };
  const requireReady = () => {
    requireOpen();
    if (!ready) throw new Error("SQLite control-plane dialect is not migration-ready");
  };
  let runtimeTail: Promise<void> = Promise.resolve();

  const runtimeTransaction = async <T>(
    work: (transaction: ControlPlaneSqlTransaction) => Promise<T>,
  ): Promise<T> => {
    requireReady();
    const previous = runtimeTail;
    let release!: () => void;
    runtimeTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    database.exec("BEGIN IMMEDIATE");
    const scoped: ControlPlaneSqlTransaction = {
      backend: "sqlite",
      async select<Row extends ControlPlaneDatabaseRow>(
        tableName: ControlPlaneTable,
        filter?: ControlPlaneFilter,
        order: readonly ControlPlaneOrder[] = [],
        limit?: number,
      ) {
        const table = sqliteControlPlaneSchema[tableName] as AnySQLiteTable &
          Record<string, AnySQLiteColumn>;
        let query = orm.select().from(table).$dynamic();
        const where = sqliteFilter(table, filter);
        if (where) query = query.where(where);
        if (order.length > 0) {
          query = query.orderBy(
            ...order.map((entry) => {
              const column = sqliteColumn(table, entry.column);
              return entry.direction === "desc" ? desc(column) : asc(column);
            }),
          );
        }
        if (limit !== undefined) query = query.limit(limit);
        return (await query) as Row[];
      },
      async insert(
        tableName: ControlPlaneTable,
        values: Readonly<Record<string, unknown>>,
        conflict?: Readonly<{
          target: readonly string[];
          update?: Readonly<Record<string, unknown>> | undefined;
        }>,
      ) {
        const table = sqliteControlPlaneSchema[tableName] as AnySQLiteTable &
          Record<string, AnySQLiteColumn>;
        const base = orm.insert(table).values(values);
        const query = conflict
          ? conflict.update
            ? base.onConflictDoUpdate({
                target: conflict.target.map((column) => table[column]!),
                set: conflict.update,
              })
            : base.onConflictDoNothing({
                target: conflict.target.map((column) => table[column]!),
              })
          : base;
        const result = await query.run();
        return Number(result.changes);
      },
      async update(
        tableName: ControlPlaneTable,
        values: Readonly<Record<string, unknown>>,
        filter: ControlPlaneFilter,
      ) {
        const table = sqliteControlPlaneSchema[tableName] as AnySQLiteTable &
          Record<string, AnySQLiteColumn>;
        const result = await orm.update(table).set(values).where(sqliteFilter(table, filter)).run();
        return Number(result.changes);
      },
      async delete(tableName: ControlPlaneTable, filter: ControlPlaneFilter) {
        const table = sqliteControlPlaneSchema[tableName] as AnySQLiteTable &
          Record<string, AnySQLiteColumn>;
        const result = await orm.delete(table).where(sqliteFilter(table, filter)).run();
        return Number(result.changes);
      },
      async databaseTime() {
        const row = orm.get<{ now: string }>(
          sql`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now`,
        );
        return row.now;
      },
      async lock() {
        // BEGIN IMMEDIATE is the single-writer serialization point for SQLite.
      },
      async finalWriterFenceGuard(input) {
        const table = sqliteControlPlaneSchema.writerFences;
        const now = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
        const result = await orm
          .update(table)
          .set({ updatedAt: now })
          .where(
            and(
              eq(table.logicalHostId!, input.logicalHostId),
              eq(table.storeId!, input.storeId),
              eq(table.leaseId!, input.leaseId),
              eq(table.writerEpoch!, input.writerEpoch),
              eq(table.authorityGeneration!, input.authorityGeneration),
              eq(table.state!, input.state ?? "active"),
              gt(table.expiresAt!, now),
            ),
          )
          .run();
        return Number(result.changes);
      },
      async advanceSnapshotEnvelope(input) {
        const result = database
          .prepare(
            `UPDATE cp_snapshot_envelope
             SET caplet_count = caplet_count + ?,
                 normalized_row_count = normalized_row_count + ?,
                 encoded_byte_count = encoded_byte_count + ?,
                 aggregate_version = (
                   SELECT generation FROM cp_effective_version
                   WHERE logical_host_id = ? AND store_id = ?
                   ORDER BY generation DESC LIMIT 1
                 ),
                 authority_version = ?,
                 effective_version = (
                   SELECT generation FROM cp_effective_version
                   WHERE logical_host_id = ? AND store_id = ?
                   ORDER BY generation DESC LIMIT 1
                 ),
                 security_version = ?,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE logical_host_id = ?
               AND store_id = ?
               AND envelope_id = ?
               AND caplet_count + ? BETWEEN 0 AND ?
               AND normalized_row_count + ? BETWEEN 0 AND ?
               AND encoded_byte_count + ? BETWEEN 0 AND ?
               AND (
                 SELECT generation FROM cp_authority_version
                 WHERE logical_host_id = ?
                   AND store_id = ?
                 ORDER BY generation DESC LIMIT 1
               ) = ?
               AND (
                 SELECT epoch FROM cp_security_version
                 WHERE logical_host_id = ?
                   AND store_id = ?
                 ORDER BY epoch DESC LIMIT 1
               ) = ?
               AND EXISTS (
                 SELECT 1 FROM cp_writer_fence
                 WHERE logical_host_id = ?
                   AND store_id = ?
                   AND lease_id = ?
                   AND writer_epoch = ?
                   AND authority_generation = ?
                   AND state = ?
                   AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
               )`,
          )
          .run(
            input.capletDelta,
            input.normalizedRowDelta,
            input.encodedByteDelta,
            input.logicalHostId,
            input.storeId,
            input.expectedAuthorityGeneration,
            input.logicalHostId,
            input.storeId,
            input.expectedSecurityEpoch,
            input.logicalHostId,
            input.storeId,
            input.envelopeId,
            input.capletDelta,
            input.maxCaplets,
            input.normalizedRowDelta,
            input.maxNormalizedRows,
            input.encodedByteDelta,
            input.maxEncodedBytes,
            input.logicalHostId,
            input.storeId,
            input.expectedAuthorityGeneration,
            input.logicalHostId,
            input.storeId,
            input.expectedSecurityEpoch,
            input.logicalHostId,
            input.storeId,
            input.leaseId,
            input.writerEpoch,
            input.fenceAuthorityGeneration,
            input.fenceState,
          );
        return Number(result.changes);
      },
      async settleConvergenceReceipts(input) {
        const result = database
          .prepare(
            `UPDATE cp_operation_outcome
             SET convergence_class = CASE
                   WHEN json_extract(receipt, '$.convergence.deadline') <=
                        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                     THEN 'overdue'
                   ELSE 'converged'
                 END,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE rowid IN (
               SELECT rowid
               FROM cp_operation_outcome
               WHERE logical_host_id = ?
                 AND store_id = ?
                 AND convergence_class = 'pending'
                 AND (
                   json_extract(receipt, '$.convergence.deadline') <=
                     strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                   OR (
                     json_extract(receipt, '$.convergence.requiredNodes') <= ?
                     AND json_extract(receipt, '$.authorityToken.authorityGeneration') = ?
                     AND json_extract(receipt, '$.authorityToken.effectiveGeneration') <= ?
                     AND security_version <= ?
                   )
                 )
               ORDER BY operation_id
               LIMIT ?
             )
             AND convergence_class = 'pending'`,
          )
          .run(
            input.logicalHostId,
            input.storeId,
            input.appliedNodes,
            input.authorityGeneration,
            input.effectiveGeneration,
            input.securityEpoch,
            input.limit,
          );
        return Number(result.changes);
      },
    };
    try {
      const result = await work(scoped);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Preserve the operation error when rollback cannot make progress.
      }
      throw error;
    } finally {
      release();
    }
  };
  function sqliteFilter(
    table: AnySQLiteTable & Record<string, AnySQLiteColumn>,
    filter: ControlPlaneFilter | undefined,
  ) {
    if (!filter) return undefined;
    const predicates = [
      ...Object.entries(filter.equals ?? {}).map(([column, value]) => {
        const target = sqliteColumn(table, column);
        return value === null ? isNull(target) : eq(target, value);
      }),
      ...Object.entries(filter.greaterThan ?? {}).map(([column, value]) =>
        gt(sqliteColumn(table, column), value),
      ),
    ];
    return predicates.length === 0 ? undefined : and(...predicates);
  }

  function sqliteColumn(
    table: AnySQLiteTable & Record<string, AnySQLiteColumn>,
    name: string,
  ): AnySQLiteColumn {
    const column = table[name];
    if (!column) throw new Error(`Unknown SQLite control-plane column: ${name}`);
    return column;
  }

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
    backend: "sqlite",
    compatibility: Object.freeze({
      binaryVersion: environment.binaryVersion,
      schemaVersion:
        registry.migrations.at(-1)?.manifest.destinationSchemaVersion ??
        environment.supportedSchemaVersion,
      keyVersion: environment.keyVersion,
      manifestVersion: environment.manifestVersion,
    }),
    runtimeTransaction,
    snapshotTransaction: runtimeTransaction,
    maintenanceTransaction: runtimeTransaction,
    get ready() {
      return ready;
    },
    migrate() {
      requireOpen();
      assertMigrationEnvironment(registry, environment);
      database.pragma("foreign_keys = OFF");
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
          const violations = database.pragma("foreign_key_check");
          if (Array.isArray(violations) && violations.length > 0) {
            throw new Error("SQLite migration violates foreign-key integrity");
          }
          return activated;
        });
        ready = true;
        return appliedIds;
      } catch (error) {
        ready = false;
        throw error;
      } finally {
        database.pragma("foreign_keys = ON");
      }
    },
    rollbackLatest() {
      requireOpen();
      database.pragma("foreign_keys = OFF");
      try {
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
          const violations = database.pragma("foreign_key_check");
          if (Array.isArray(violations) && violations.length > 0) {
            throw new Error("SQLite rollback violates foreign-key integrity");
          }
          return latest.migrationId;
        });
        ready = false;
        return rolledBack;
      } finally {
        database.pragma("foreign_keys = ON");
      }
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
