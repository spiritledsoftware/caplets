import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";
import type postgres from "postgres";
import type { Sql, TransactionSql } from "postgres";

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CapletsError } from "../../errors";

const require = createRequire(import.meta.url);

type BetterSqlite3Constructor = new (
  filename: string,
  options?: { timeout?: number },
) => BetterSqlite3.Database;

type PostgresFactory = typeof postgres;

function loadBetterSqlite3(): BetterSqlite3Constructor {
  const loaded = require("better-sqlite3") as
    | { default?: BetterSqlite3Constructor }
    | BetterSqlite3Constructor;
  return typeof loaded === "function" ? loaded : loaded.default!;
}

function loadPostgres(): PostgresFactory {
  const loaded = require("postgres") as { default?: PostgresFactory } | PostgresFactory;
  return typeof loaded === "function" ? loaded : loaded.default!;
}

export const SQLITE_LOGICAL_SCHEMA_VERSION = 3;
export const POSTGRES_LOGICAL_SCHEMA_VERSION = 3;

export type SqlMigration = {
  version: number;
  name: string;
  sql: string;
  checksum: string;
};

export type AppliedMigration = {
  version: number;
  name: string;
  checksum: string;
};

const SQLITE_INITIAL_SQL = `CREATE TABLE IF NOT EXISTS authority_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS authority_schema_meta (
  authority_id TEXT PRIMARY KEY NOT NULL,
  namespace TEXT NOT NULL,
  logical_schema_version INTEGER NOT NULL,
  auxiliary_watermark INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS authority_heads (
  authority_id TEXT PRIMARY KEY NOT NULL,
  namespace TEXT NOT NULL,
  generation_id TEXT,
  sequence INTEGER NOT NULL DEFAULT 0,
  predecessor_id TEXT,
  schema_version INTEGER NOT NULL,
  digest TEXT,
  committed_at TEXT
);
CREATE TABLE IF NOT EXISTS authority_generations (
  authority_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  predecessor_id TEXT,
  schema_version INTEGER NOT NULL,
  digest TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (authority_id, generation_id),
  UNIQUE (authority_id, sequence)
);
CREATE TABLE IF NOT EXISTS authority_receipts (
  authority_id TEXT NOT NULL,
  current_host_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (authority_id, current_host_id, principal_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS authority_sessions (
  authority_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (authority_id, session_id)
);
CREATE TABLE IF NOT EXISTS authority_events (
  authority_id TEXT NOT NULL,
  watermark INTEGER NOT NULL,
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (authority_id, watermark)
);
CREATE INDEX IF NOT EXISTS authority_events_after_idx ON authority_events (authority_id, watermark);
`;

const POSTGRES_INITIAL_SQL = `CREATE TABLE IF NOT EXISTS authority_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS authority_schema_meta (
  authority_id TEXT PRIMARY KEY NOT NULL,
  namespace TEXT NOT NULL,
  logical_schema_version INTEGER NOT NULL,
  auxiliary_watermark INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS authority_heads (
  authority_id TEXT PRIMARY KEY NOT NULL,
  namespace TEXT NOT NULL,
  generation_id TEXT,
  sequence INTEGER NOT NULL DEFAULT 0,
  predecessor_id TEXT,
  schema_version INTEGER NOT NULL,
  digest TEXT,
  committed_at TEXT,
  CONSTRAINT authority_heads_singleton CHECK (authority_id <> '')
);
CREATE TABLE IF NOT EXISTS authority_generations (
  authority_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  predecessor_id TEXT,
  schema_version INTEGER NOT NULL,
  digest TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (authority_id, generation_id),
  UNIQUE (authority_id, sequence)
);
CREATE TABLE IF NOT EXISTS authority_receipts (
  authority_id TEXT NOT NULL,
  current_host_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (authority_id, current_host_id, principal_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS authority_sessions (
  authority_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (authority_id, session_id)
);
CREATE TABLE IF NOT EXISTS authority_events (
  authority_id TEXT NOT NULL,
  watermark INTEGER NOT NULL,
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (authority_id, watermark)
);
CREATE INDEX IF NOT EXISTS authority_events_after_idx ON authority_events (authority_id, watermark);
`;

const SQLITE_HEAD_GUARD_SQL = `CREATE TRIGGER IF NOT EXISTS authority_heads_undeletable
  BEFORE DELETE ON authority_heads
  FOR EACH ROW
  BEGIN
    SELECT RAISE(ABORT, 'authority head rows are undeletable');
  END;
`;

const POSTGRES_HEAD_GUARD_SQL = `CREATE OR REPLACE FUNCTION caplets_prevent_authority_head_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'authority head rows are undeletable';
END;
$$;
DROP TRIGGER IF EXISTS authority_heads_undeletable ON authority_heads;
CREATE TRIGGER authority_heads_undeletable
  BEFORE DELETE ON authority_heads
  FOR EACH ROW EXECUTE FUNCTION caplets_prevent_authority_head_delete();
`;

const SQLITE_MAINTENANCE_LEASE_SQL = `CREATE TABLE IF NOT EXISTS authority_maintenance_leases (
  authority_id TEXT PRIMARY KEY NOT NULL,
  namespace TEXT NOT NULL,
  owner TEXT NOT NULL,
  token TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);`;

const POSTGRES_MAINTENANCE_LEASE_SQL = `CREATE TABLE IF NOT EXISTS authority_maintenance_leases (
  authority_id TEXT PRIMARY KEY NOT NULL,
  namespace TEXT NOT NULL,
  owner TEXT NOT NULL,
  token TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);`;

function checksum(sql: string): string {
  return `sha256:${createHash("sha256").update(sql).digest("hex")}`;
}
export const SQLITE_MIGRATIONS: readonly SqlMigration[] = [
  {
    version: 1,
    name: "0000_initial",
    sql: SQLITE_INITIAL_SQL,
    checksum: checksum(SQLITE_INITIAL_SQL),
  },
  {
    version: 2,
    name: "0001_head_guard",
    sql: SQLITE_HEAD_GUARD_SQL,
    checksum: checksum(SQLITE_HEAD_GUARD_SQL),
  },
  {
    version: 3,
    name: "0002_maintenance_lease",
    sql: SQLITE_MAINTENANCE_LEASE_SQL,
    checksum: checksum(SQLITE_MAINTENANCE_LEASE_SQL),
  },
];

export const POSTGRES_MIGRATIONS: readonly SqlMigration[] = [
  {
    version: 1,
    name: "0000_initial",
    sql: POSTGRES_INITIAL_SQL,
    checksum: checksum(POSTGRES_INITIAL_SQL),
  },
  {
    version: 2,
    name: "0001_head_guard",
    sql: POSTGRES_HEAD_GUARD_SQL,
    checksum: checksum(POSTGRES_HEAD_GUARD_SQL),
  },
  {
    version: 3,
    name: "0002_maintenance_lease",
    sql: POSTGRES_MAINTENANCE_LEASE_SQL,
    checksum: checksum(POSTGRES_MAINTENANCE_LEASE_SQL),
  },
];

function assertSafeLocalSqlitePath(databasePath: string): void {
  if (databasePath === ":memory:") return;
  if (
    databasePath.length === 0 ||
    databasePath.includes("\0") ||
    databasePath.startsWith("//") ||
    databasePath.startsWith("\\\\") ||
    /^(?:file|https?|nfs|smb|cifs):\/\//i.test(databasePath)
  ) {
    throw new CapletsError("CONFIG_INVALID", "SQLite database path must be local");
  }
}

function boundedMilliseconds(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 1 || resolved > 60_000) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `${label} must be a finite value between 1ms and 60000ms`,
    );
  }
  return Math.floor(resolved);
}

export async function withPostgresStatementTimeout<T>(
  client: Sql,
  timeoutMs: number | undefined,
  operation: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  const statementTimeout = boundedMilliseconds(timeoutMs, 5_000, "PostgreSQL statement timeout");
  const result = await client.begin<T>(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = '${statementTimeout}ms'`, [], {
      prepare: false,
    });
    return await operation(tx);
  });
  return result as T;
}

function validateMigrationDefinitions(migrations: readonly SqlMigration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version <= previous ||
      migration.name.length === 0 ||
      checksum(migration.sql) !== migration.checksum
    ) {
      throw new CapletsError("CONFIG_INVALID", "SQL migration definition is invalid or tampered");
    }
    previous = migration.version;
  }
}
export type MigrationResult = {
  applied: number;
  logicalSchemaVersion: number;
};

export type SqliteMigrationOptions = {
  databasePath: string;
  authorityId: string;
  namespace: string;
  busyTimeoutMs?: number;
  migrations?: readonly SqlMigration[];
};

export type PostgresMigrationOptions = {
  connectionString?: string;
  client?: Sql;
  authorityId: string;
  namespace: string;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  ssl?: boolean | "require" | "allow" | "prefer" | "verify-full" | Record<string, unknown>;
  maxConnections?: number;
  prepare?: boolean;
  migrations?: readonly SqlMigration[];
};

export function verifyMigrationHistory(
  history: readonly AppliedMigration[],
  expected: readonly SqlMigration[],
  options: { requireComplete?: boolean } = {},
): void {
  validateMigrationDefinitions(expected);
  if (history.length > expected.length) {
    throw new CapletsError("CONFIG_INVALID", "SQL migration history contains a newer version");
  }
  for (const [index, applied] of history.entries()) {
    const migration = expected[index];
    if (
      !migration ||
      applied.version !== migration.version ||
      applied.name !== migration.name ||
      applied.checksum !== migration.checksum
    ) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "SQL migration history is missing, reordered, or tampered",
      );
    }
  }
  if (options.requireComplete && history.length !== expected.length) {
    throw new CapletsError("CONFIG_INVALID", "SQL migration history is incomplete");
  }
}

function safeSqliteError(error: unknown): CapletsError {
  const message = error instanceof Error ? error.message : String(error);
  if (/busy|locked/i.test(message)) {
    return new CapletsError("SERVER_UNAVAILABLE", "SQLite migration lock timed out");
  }
  return new CapletsError("CONFIG_INVALID", "SQLite migration failed");
}

function sqliteTableExists(db: BetterSqlite3.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

function assertSqliteAuthorityNamespace(
  db: BetterSqlite3.Database,
  authorityId: string,
  namespace: string,
): void {
  for (const table of ["authority_schema_meta", "authority_heads"] as const) {
    if (!sqliteTableExists(db, table)) continue;
    const row = db
      .prepare(`SELECT namespace FROM ${table} WHERE authority_id = ?`)
      .get(authorityId) as { namespace: string } | undefined;
    if (row && row.namespace !== namespace) {
      throw new CapletsError("CONFIG_INVALID", "SQLite authority namespace does not match");
    }
  }
}

async function assertPostgresAuthorityNamespace(
  tx: TransactionSql,
  authorityId: string,
  namespace: string,
): Promise<void> {
  const tables = await tx`SELECT
    to_regclass('public.authority_schema_meta') AS meta_table,
    to_regclass('public.authority_heads') AS heads_table`;
  const table = tables[0] as { meta_table: string | null; heads_table: string | null } | undefined;
  if (table?.meta_table) {
    const rows =
      await tx`SELECT namespace FROM authority_schema_meta WHERE authority_id = ${authorityId}`;
    const row = rows[0] as { namespace: string } | undefined;
    if (row && row.namespace !== namespace) {
      throw new CapletsError("CONFIG_INVALID", "PostgreSQL authority namespace does not match");
    }
  }
  if (table?.heads_table) {
    const rows =
      await tx`SELECT namespace FROM authority_heads WHERE authority_id = ${authorityId}`;
    const row = rows[0] as { namespace: string } | undefined;
    if (row && row.namespace !== namespace) {
      throw new CapletsError("CONFIG_INVALID", "PostgreSQL authority namespace does not match");
    }
  }
}

function readSqliteHistory(db: BetterSqlite3.Database): AppliedMigration[] {
  if (!sqliteTableExists(db, "authority_migrations")) return [];
  return db
    .prepare("SELECT version, name, checksum FROM authority_migrations ORDER BY version")
    .all() as AppliedMigration[];
}

export function runSqliteMigrations(
  db: BetterSqlite3.Database,
  options: Omit<SqliteMigrationOptions, "databasePath">,
): MigrationResult {
  const migrations = options.migrations ?? SQLITE_MIGRATIONS;
  const history = readSqliteHistory(db);
  verifyMigrationHistory(history, migrations);
  let applied = 0;
  try {
    db.exec("BEGIN EXCLUSIVE");
    const lockedHistory = readSqliteHistory(db);
    verifyMigrationHistory(lockedHistory, migrations);
    assertSqliteAuthorityNamespace(db, options.authorityId, options.namespace);
    for (const migration of migrations.slice(lockedHistory.length)) {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO authority_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      applied += 1;
    }
    assertSqliteAuthorityNamespace(db, options.authorityId, options.namespace);
    db.prepare(
      "INSERT INTO authority_schema_meta (authority_id, namespace, logical_schema_version) VALUES (?, ?, ?) ON CONFLICT(authority_id) DO UPDATE SET logical_schema_version = excluded.logical_schema_version",
    ).run(options.authorityId, options.namespace, migrations.at(-1)?.version ?? 0);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original migration error.
    }
    if (error instanceof CapletsError) throw error;
    throw safeSqliteError(error);
  }
  return { applied, logicalSchemaVersion: migrations.at(-1)?.version ?? 0 };
}

export function verifySqliteSchema(
  db: BetterSqlite3.Database,
  options: { migrations?: readonly SqlMigration[]; authorityId: string; namespace: string },
): MigrationResult {
  const migrations = options.migrations ?? SQLITE_MIGRATIONS;
  if (!sqliteTableExists(db, "authority_migrations")) {
    throw new CapletsError("CONFIG_INVALID", "SQLite authority schema is not migrated");
  }
  const history = readSqliteHistory(db);
  verifyMigrationHistory(history, migrations, { requireComplete: true });
  const meta = db
    .prepare(
      "SELECT namespace, logical_schema_version FROM authority_schema_meta WHERE authority_id = ?",
    )
    .get(options.authorityId) as { namespace: string; logical_schema_version: number } | undefined;
  if (
    !meta ||
    meta.namespace !== options.namespace ||
    meta.logical_schema_version !== (migrations.at(-1)?.version ?? 0)
  ) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "SQLite authority schema version or namespace is invalid",
    );
  }
  return { applied: 0, logicalSchemaVersion: meta.logical_schema_version };
}

export async function migrateSqliteDatabase(
  options: SqliteMigrationOptions,
): Promise<MigrationResult> {
  if (typeof process !== "undefined" && process.versions.bun) {
    throw new CapletsError("UNSUPPORTED_OPERATION", "SQLite authority requires Node.js");
  }
  assertSafeLocalSqlitePath(options.databasePath);
  const busyTimeoutMs = boundedMilliseconds(options.busyTimeoutMs, 2_000, "SQLite busy timeout");
  const resolvedPath =
    options.databasePath === ":memory:" ? options.databasePath : resolve(options.databasePath);
  if (resolvedPath !== ":memory:")
    mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  let db: BetterSqlite3.Database | undefined;
  try {
    const BetterSqlite3 = loadBetterSqlite3();
    db = new BetterSqlite3(resolvedPath, { timeout: busyTimeoutMs });
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    const result = runSqliteMigrations(db, options);
    if (resolvedPath !== ":memory:") chmodSync(resolvedPath, 0o600);
    return result;
  } catch (error) {
    if (error instanceof CapletsError) throw error;
    throw safeSqliteError(error);
  } finally {
    db?.close();
  }
}

function postgresOptions(
  options: PostgresMigrationOptions,
): postgres.Options<Record<string, never>> {
  const statementTimeoutMs = boundedMilliseconds(
    options.statementTimeoutMs,
    5_000,
    "PostgreSQL statement timeout",
  );
  if (
    options.maxConnections !== undefined &&
    (!Number.isSafeInteger(options.maxConnections) ||
      options.maxConnections < 1 ||
      options.maxConnections > 100)
  ) {
    throw new CapletsError("CONFIG_INVALID", "PostgreSQL pool size must be between 1 and 100");
  }
  return {
    max: options.maxConnections ?? 2,
    connect_timeout: Math.max(1, Math.ceil(statementTimeoutMs / 1_000)),
    prepare: options.prepare ?? false,
    ssl: options.ssl ?? false,
  } as postgres.Options<Record<string, never>>;
}

export async function runPostgresMigrations(
  client: Sql,
  options: Omit<PostgresMigrationOptions, "connectionString" | "client">,
): Promise<MigrationResult> {
  const migrations = options.migrations ?? POSTGRES_MIGRATIONS;
  validateMigrationDefinitions(migrations);
  const lockTimeout = boundedMilliseconds(options.lockTimeoutMs, 2_000, "PostgreSQL lock timeout");
  const statementTimeout = Math.max(
    lockTimeout,
    boundedMilliseconds(options.statementTimeoutMs, 5_000, "PostgreSQL statement timeout"),
  );
  const lockKey = "caplets:sql:migrate";
  let applied = 0;
  try {
    await client.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL lock_timeout = '${lockTimeout}ms'`, [], { prepare: false });
      await tx.unsafe(`SET LOCAL statement_timeout = '${statementTimeout}ms'`, [], {
        prepare: false,
      });
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const tableRows = await tx`SELECT to_regclass('public.authority_migrations') AS table_name`;
      const tableRow = tableRows[0] as { table_name: string | null } | undefined;
      const lockedRows = tableRow?.table_name
        ? await tx`SELECT version, name, checksum FROM authority_migrations ORDER BY version`
        : [];
      const lockedHistory = lockedRows as unknown as AppliedMigration[];
      verifyMigrationHistory(lockedHistory, migrations);
      await assertPostgresAuthorityNamespace(tx, options.authorityId, options.namespace);
      for (const migration of migrations.slice(lockedHistory.length)) {
        await tx.unsafe(migration.sql, [], { prepare: false });
        await tx`INSERT INTO authority_migrations (version, name, checksum, applied_at) VALUES (${migration.version}, ${migration.name}, ${migration.checksum}, ${new Date().toISOString()})`;
        applied += 1;
      }
      await assertPostgresAuthorityNamespace(tx, options.authorityId, options.namespace);
      await tx`INSERT INTO authority_schema_meta (authority_id, namespace, logical_schema_version, auxiliary_watermark) VALUES (${options.authorityId}, ${options.namespace}, ${migrations.at(-1)?.version ?? 0}, 0) ON CONFLICT (authority_id) DO UPDATE SET logical_schema_version = EXCLUDED.logical_schema_version`;
      await tx`INSERT INTO authority_heads (authority_id, namespace, schema_version) VALUES (${options.authorityId}, ${options.namespace}, ${migrations.at(-1)?.version ?? 0}) ON CONFLICT (authority_id) DO NOTHING`;
    });
    return { applied, logicalSchemaVersion: migrations.at(-1)?.version ?? 0 };
  } catch (error) {
    if (error instanceof CapletsError) throw error;
    throw new CapletsError("CONFIG_INVALID", "PostgreSQL migration failed");
  }
}

export async function verifyPostgresSchema(
  client: Sql,
  options: {
    migrations?: readonly SqlMigration[];
    authorityId: string;
    namespace: string;
    statementTimeoutMs?: number;
  },
): Promise<MigrationResult> {
  const migrations = options.migrations ?? POSTGRES_MIGRATIONS;
  let rows: AppliedMigration[];
  let meta: { namespace: string; logical_schema_version: number }[];
  try {
    ({ rows, meta } = await withPostgresStatementTimeout(
      client,
      options.statementTimeoutMs,
      async (tx) => {
        const migrationRows =
          await tx`SELECT version, name, checksum FROM authority_migrations ORDER BY version`;
        const metaRows =
          await tx`SELECT namespace, logical_schema_version FROM authority_schema_meta WHERE authority_id = ${options.authorityId}`;
        return {
          rows: migrationRows as unknown as AppliedMigration[],
          meta: metaRows as unknown as {
            namespace: string;
            logical_schema_version: number;
          }[],
        };
      },
    ));
  } catch {
    throw new CapletsError("CONFIG_INVALID", "PostgreSQL authority schema is not migrated");
  }
  verifyMigrationHistory(rows, migrations, { requireComplete: true });
  const record = meta[0];
  if (
    record &&
    (record.namespace !== options.namespace ||
      record.logical_schema_version !== (migrations.at(-1)?.version ?? 0))
  ) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "PostgreSQL authority schema version or namespace is invalid",
    );
  }
  return {
    applied: 0,
    logicalSchemaVersion: record?.logical_schema_version ?? migrations.at(-1)?.version ?? 0,
  };
}

export async function migratePostgresDatabase(
  options: PostgresMigrationOptions,
): Promise<MigrationResult> {
  const client =
    options.client ?? loadPostgres()(options.connectionString!, postgresOptions(options));
  try {
    return await runPostgresMigrations(client, options);
  } finally {
    if (!options.client)
      await client.end({
        timeout: Math.ceil(
          boundedMilliseconds(options.lockTimeoutMs, 2_000, "PostgreSQL lock timeout") / 1_000,
        ),
      });
  }
}

export const migrateSqlite = migrateSqliteDatabase;
export const migratePostgres = migratePostgresDatabase;
