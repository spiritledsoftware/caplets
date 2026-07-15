import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import { createRequire } from "node:module";
import type { ResolvedPostgresStorage } from "../storage-config";
import {
  assertMigrationEnvironment,
  assertRollbackAllowed,
  loadMigrationRegistry,
  planPendingMigrations,
  type AppliedMigration,
  type LoadedMigrationRegistry,
  type MigrationEnvironment,
} from "./migrations";
import {
  assertSafeSqlIdentifier,
  fixedPostgresSearchPath,
  quoteSafeSqlIdentifier,
} from "../schema/model-codec";
import { CONTROL_PLANE_POSTGRES_SCHEMA } from "../schema/definition";
import { postgresControlPlaneSchema } from "../schema/postgres";

import type {
  ControlPlaneDatabaseRow,
  ControlPlaneFilter,
  ControlPlaneOrder,
  ControlPlaneTable,
  ControlPlaneSqlTransaction,
  ControlPlaneTransactionalDialect,
} from "../store";
const require = createRequire(import.meta.url);
const POSTGRES_HISTORY_TABLE = "__caplets_migration_history_v1";
const MIGRATION_ADVISORY_LOCK = "731840728441713664";

export type PostgresQueryResult = {
  rows: unknown[];
  rowCount: number | null;
};

export type PostgresClient = {
  query(sql: string, parameters?: readonly unknown[]): Promise<PostgresQueryResult>;
  release(): void;
};

export type PostgresPool = {
  connect(): Promise<PostgresClient>;
  query(sql: string, parameters?: readonly unknown[]): Promise<PostgresQueryResult>;
  end(): Promise<void>;
};

type PostgresPoolConstructor = new (configuration: Record<string, unknown>) => PostgresPool;

export type PostgresConnectionProfile = {
  role: string;
  connectionString: string;
  tls: {
    mode: "verify-full";
    servername: string;
    ca: string;
  };
  maximumConnections?: number | undefined;
};

export type PostgresPoolSet = {
  runtime: PostgresPool;
  migrator: PostgresPool;
  maintenance?: PostgresPool | undefined;
};

export type PostgresRoleSet = {
  runtime: string;
  migrator: string;
  maintenance?: string | undefined;
};

export type PostgresControlPlaneDialect = ControlPlaneTransactionalDialect & {
  readonly backend: "postgres";
  readonly ready: boolean;
  migrate(): Promise<readonly string[]>;
  rollbackLatest(): Promise<string>;
  query<T>(sql: string, parameters?: readonly unknown[]): Promise<readonly T[]>;
  maintenanceQuery<T>(sql: string, parameters?: readonly unknown[]): Promise<readonly T[]>;
  close(): Promise<void>;
};

export async function openPostgresControlPlaneDialect(options: {
  storage: ResolvedPostgresStorage;
  runtime: PostgresConnectionProfile;
  migrator: PostgresConnectionProfile;
  maintenance?: PostgresConnectionProfile | undefined;
  environment: MigrationEnvironment;
  schema?: string | undefined;
  assetRoot?: URL | string | undefined;
}): Promise<PostgresControlPlaneDialect> {
  assertDistinctProfiles(options.runtime, options.migrator, options.maintenance);
  const registry = await loadMigrationRegistry({
    dialect: "postgres",
    ...(options.assetRoot === undefined ? {} : { assetRoot: options.assetRoot }),
  });
  assertMigrationEnvironment(registry, options.environment);
  const Pool = loadPoolConstructor();
  const runtime = new Pool(poolConfiguration(options.runtime));
  const migrator = new Pool(poolConfiguration(options.migrator));
  const maintenance = options.maintenance
    ? new Pool(poolConfiguration(options.maintenance))
    : undefined;
  try {
    return await attachVerifiedPostgresPools({
      storage: options.storage,
      pools: { runtime, migrator, ...(maintenance ? { maintenance } : {}) },
      roles: {
        runtime: options.runtime.role,
        migrator: options.migrator.role,
        ...(options.maintenance ? { maintenance: options.maintenance.role } : {}),
      },
      registry,
      environment: options.environment,
      schema: options.schema ?? CONTROL_PLANE_POSTGRES_SCHEMA,
    });
  } catch (error) {
    await closePools({ runtime, migrator, ...(maintenance ? { maintenance } : {}) });
    throw error;
  }
}

/**
 * Attaches pools after the deployment resolver has performed its verify-full endpoint check.
 * Role identity, NOINHERIT/no-membership, and fixed search path are still re-verified here.
 */
export async function attachVerifiedPostgresPools(options: {
  storage: ResolvedPostgresStorage;
  pools: PostgresPoolSet;
  roles: PostgresRoleSet;
  registry: LoadedMigrationRegistry;
  environment: MigrationEnvironment;
  schema?: string | undefined;
}): Promise<PostgresControlPlaneDialect> {
  const schema = assertSafeSqlIdentifier(
    options.schema ?? CONTROL_PLANE_POSTGRES_SCHEMA,
    "Postgres control-plane schema",
  );
  assertRoleSet(options.roles, options.pools);
  assertMigrationEnvironment(options.registry, options.environment);
  await verifyRole(options.pools.runtime, options.roles.runtime, "runtime", schema);
  await verifyRole(options.pools.migrator, options.roles.migrator, "migrator", schema);
  if (options.pools.maintenance && options.roles.maintenance) {
    await verifyRole(options.pools.maintenance, options.roles.maintenance, "maintenance", schema);
  }
  return createDialect(options, schema);
}

function createDialect(
  options: {
    storage: ResolvedPostgresStorage;
    pools: PostgresPoolSet;
    roles: PostgresRoleSet;
    registry: LoadedMigrationRegistry;
    environment: MigrationEnvironment;
  },
  schema: string,
): PostgresControlPlaneDialect {
  let ready = false;
  let closed = false;
  const requireOpen = () => {
    if (closed) throw new Error("Postgres control-plane dialect is closed");
  };
  const requireReady = () => {
    requireOpen();
    if (!ready) throw new Error("Postgres control-plane dialect is not migration-ready");
  };

  return {
    backend: "postgres",
    compatibility: Object.freeze({
      binaryVersion: options.environment.binaryVersion,
      schemaVersion:
        options.registry.migrations.at(-1)?.manifest.destinationSchemaVersion ??
        options.environment.supportedSchemaVersion,
      keyVersion: options.environment.keyVersion,
      manifestVersion: options.environment.manifestVersion,
    }),
    async runtimeTransaction<T>(
      work: (transaction: ControlPlaneSqlTransaction) => Promise<T>,
    ): Promise<T> {
      requireReady();
      return withRuntimeTransaction(options.pools.runtime, schema, work);
    },
    async snapshotTransaction<T>(
      work: (transaction: ControlPlaneSqlTransaction) => Promise<T>,
    ): Promise<T> {
      requireReady();
      return withRuntimeTransaction(
        options.pools.runtime,
        schema,
        work,
        "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
    },
    async maintenanceTransaction<T>(
      work: (transaction: ControlPlaneSqlTransaction) => Promise<T>,
    ): Promise<T> {
      requireReady();
      const pool = options.pools.maintenance;
      if (!pool) throw new Error("Postgres maintenance pool is unavailable");
      return withRuntimeTransaction(pool, schema, work);
    },
    async maintenancePurgeExpiredOperatorActivity(input) {
      requireReady();
      const pool = options.pools.maintenance;
      if (!pool) throw new Error("Postgres maintenance pool is unavailable");
      const rows = await queryWithFixedSearchPath<{
        deletedCount: string | number;
        occurredAt: string;
      }>(
        pool,
        schema,
        `SELECT deleted_count AS "deletedCount", occurred_at AS "occurredAt" FROM ` +
          `${qualified(schema, "cp_purge_expired_operator_activity")}($1, $2, $3, $4, $5)`,
        [input.logicalHostId, input.storeId, input.receiptId, input.watermark, input.limit],
      );
      const row = rows[0];
      if (!row || rows.length !== 1) {
        throw new Error("Postgres activity purge receipt is unavailable");
      }
      const deleted = Number(row.deletedCount);
      if (!Number.isSafeInteger(deleted) || deleted < 0) {
        throw new Error("Postgres activity purge count is invalid");
      }
      if (!Number.isFinite(Date.parse(row.occurredAt))) {
        throw new Error("Postgres activity purge clock is invalid");
      }
      return { deleted, occurredAt: row.occurredAt };
    },
    get ready() {
      return ready;
    },
    async migrate() {
      requireOpen();
      assertMigrationEnvironment(options.registry, options.environment);
      try {
        const activated = await withMigrationTransaction(
          options.pools.migrator,
          schema,
          async (client) => {
            await ensurePostgresHistory(client, schema);
            const applied = await readAppliedMigrations(client, schema);
            const pending = planPendingMigrations(options.registry, applied, options.environment);
            const migrationIds: string[] = [];
            for (const migration of pending) {
              await client.query(migration.sql);
              const appliedAt = (options.environment.now ?? new Date()).toISOString();
              await client.query(
                `INSERT INTO ${qualified(schema, POSTGRES_HISTORY_TABLE)} ` +
                  "(migration_id, sql_sha256, manifest_sha256, destination_schema_version, applied_at) " +
                  "VALUES ($1, $2, $3, $4, $5)",
                [
                  migration.manifest.migrationId,
                  migration.manifest.sql.sha256,
                  migration.manifest.manifestSha256,
                  migration.manifest.destinationSchemaVersion,
                  appliedAt,
                ],
              );
              migrationIds.push(migration.manifest.migrationId);
            }
            if (
              options.roles.maintenance &&
              options.registry.migrations.some(
                (migration) => migration.manifest.migrationId === "0002_parched_sauron",
              )
            ) {
              await client.query(
                `GRANT USAGE ON SCHEMA ${quoteSafeSqlIdentifier(schema)} TO ` +
                  quoteSafeSqlIdentifier(options.roles.maintenance),
              );
              await client.query(
                `GRANT EXECUTE ON FUNCTION ${qualified(
                  schema,
                  "cp_purge_expired_operator_activity",
                )}(text, text, text, bigint, integer) TO ` +
                  quoteSafeSqlIdentifier(options.roles.maintenance),
              );
            }
            await ensurePostgresStorageIdentity(
              client,
              schema,
              options.storage.logicalHostId,
              options.storage.storeId,
            );
            return migrationIds;
          },
        );
        ready = true;
        return activated;
      } catch (error) {
        ready = false;
        throw error;
      }
    },
    async rollbackLatest() {
      requireOpen();
      const migrationId = await withMigrationTransaction(
        options.pools.migrator,
        schema,
        async (client) => {
          await ensurePostgresHistory(client, schema);
          const applied = await readAppliedMigrations(client, schema);
          const latest = applied.at(-1);
          if (!latest) throw new Error("No applied migration is available to roll back");
          const migration = options.registry.migrations.find(
            (candidate) => candidate.manifest.migrationId === latest.migrationId,
          );
          if (!migration) throw new Error("Applied migration is newer than this binary");
          assertRollbackAllowed(migration, latest.appliedAt, options.environment);
          if (migration.manifest.rollback.mode !== "down" || !migration.downSql) {
            throw new Error("Postgres rollback requires reviewed down SQL");
          }
          await client.query(migration.downSql);
          await client.query(
            `DELETE FROM ${qualified(schema, POSTGRES_HISTORY_TABLE)} WHERE migration_id = $1`,
            [latest.migrationId],
          );
          return latest.migrationId;
        },
      );
      ready = false;
      return migrationId;
    },
    async query<T>(sql: string, parameters: readonly unknown[] = []) {
      requireReady();
      return queryWithFixedSearchPath<T>(options.pools.runtime, schema, sql, parameters);
    },
    async maintenanceQuery<T>(sql: string, parameters: readonly unknown[] = []) {
      requireReady();
      if (!options.pools.maintenance) throw new Error("Postgres maintenance pool is unavailable");
      return queryWithFixedSearchPath<T>(options.pools.maintenance, schema, sql, parameters);
    },
    async close() {
      if (closed) return;
      closed = true;
      ready = false;
      await closePools(options.pools);
    },
  };
}

async function withRuntimeTransaction<T>(
  pool: PostgresPool,
  schema: string,
  work: (transaction: ControlPlaneSqlTransaction) => Promise<T>,
  begin = "BEGIN",
): Promise<T> {
  const client = await pool.connect();
  const orm = drizzle(client as never, { schema: postgresControlPlaneSchema });
  try {
    await client.query(begin);
    try {
      await client.query("SELECT set_config('search_path', $1, true)", [
        fixedPostgresSearchPath(schema),
      ]);
      const transaction: ControlPlaneSqlTransaction = {
        backend: "postgres",
        async select<Row extends ControlPlaneDatabaseRow>(
          tableName: ControlPlaneTable,
          filter?: ControlPlaneFilter,
          order: readonly ControlPlaneOrder[] = [],
          limit?: number,
        ) {
          const table = postgresControlPlaneSchema[tableName] as AnyPgTable &
            Record<string, AnyPgColumn>;
          let query = orm.select().from(table).$dynamic();
          const where = postgresFilter(table, filter);
          if (where) query = query.where(where);
          if (order.length > 0) {
            query = query.orderBy(
              ...order.map((entry) =>
                entry.direction === "desc" ? desc(table[entry.column]!) : asc(table[entry.column]!),
              ),
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
          const table = postgresControlPlaneSchema[tableName] as AnyPgTable &
            Record<string, AnyPgColumn>;
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
          const result = await query;
          return result.rowCount ?? 0;
        },
        async update(
          tableName: ControlPlaneTable,
          values: Readonly<Record<string, unknown>>,
          filter: ControlPlaneFilter,
        ) {
          const table = postgresControlPlaneSchema[tableName] as AnyPgTable &
            Record<string, AnyPgColumn>;
          const result = await orm.update(table).set(values).where(postgresFilter(table, filter));
          return result.rowCount ?? 0;
        },
        async delete(tableName: ControlPlaneTable, filter: ControlPlaneFilter) {
          const table = postgresControlPlaneSchema[tableName] as AnyPgTable &
            Record<string, AnyPgColumn>;
          const result = await orm.delete(table).where(postgresFilter(table, filter));
          return result.rowCount ?? 0;
        },
        async databaseTime() {
          const result = await orm.execute<{ now: string }>(
            sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS now`,
          );
          return String(result.rows[0]?.now);
        },
        async lock(serialKey: string) {
          await orm.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${serialKey}, 0))`);
        },
      };
      const result = await work(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original runtime failure remains authoritative.
      }
      throw error;
    }
  } finally {
    client.release();
  }
}

function postgresFilter(
  table: AnyPgTable & Record<string, AnyPgColumn>,
  filter: ControlPlaneFilter | undefined,
) {
  if (!filter) return undefined;
  const predicates = [
    ...Object.entries(filter.equals ?? {}).map(([column, value]) =>
      value === null ? isNull(table[column]!) : eq(table[column]!, value),
    ),
    ...Object.entries(filter.greaterThan ?? {}).map(([column, value]) => gt(table[column]!, value)),
  ];
  return predicates.length === 0 ? undefined : and(...predicates);
}

async function withMigrationTransaction<T>(
  pool: PostgresPool,
  schema: string,
  work: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('search_path', $1, true)", [
        fixedPostgresSearchPath(schema),
      ]);
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [MIGRATION_ADVISORY_LOCK]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteSafeSqlIdentifier(schema)}`);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original migration failure remains authoritative.
      }
      throw error;
    }
  } finally {
    client.release();
  }
}

async function queryWithFixedSearchPath<T>(
  pool: PostgresPool,
  schema: string,
  query: string,
  parameters: readonly unknown[],
): Promise<readonly T[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('search_path', $1, false)", [
      fixedPostgresSearchPath(schema),
    ]);
    const result = await client.query(query, parameters);
    return result.rows as T[];
  } finally {
    client.release();
  }
}

async function verifyRole(
  pool: PostgresPool,
  expectedRole: string,
  purpose: "runtime" | "migrator" | "maintenance",
  schema: string,
): Promise<void> {
  assertSafeSqlIdentifier(expectedRole, `${purpose} Postgres role`);
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('search_path', $1, false)", [
      fixedPostgresSearchPath(schema),
    ]);
    const identityResult = await client.query(
      "SELECT current_user AS current_user, session_user AS session_user, " +
        "rolsuper, rolinherit, rolcreatedb, rolcreaterole, rolcanlogin " +
        "FROM pg_roles WHERE rolname = current_user",
    );
    const identity = singleRecord(identityResult, `${purpose} Postgres role identity`);
    if (
      identity.current_user !== expectedRole ||
      identity.session_user !== expectedRole ||
      identity.rolsuper !== false ||
      identity.rolinherit !== false ||
      identity.rolcreatedb !== false ||
      identity.rolcreaterole !== false ||
      identity.rolcanlogin !== true
    ) {
      throw new Error(`${purpose} Postgres role violates the least-privilege identity contract`);
    }
    const membershipsResult = await client.query(
      "SELECT count(*)::int AS memberships FROM pg_auth_members " +
        "WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user)",
    );
    const memberships = singleRecord(membershipsResult, `${purpose} Postgres memberships`);
    if (memberships.memberships !== 0) {
      throw new Error(`${purpose} Postgres role can SET ROLE through a membership`);
    }
    const searchPathResult = await client.query("SHOW search_path");
    const searchPath = singleRecord(searchPathResult, `${purpose} Postgres search path`);
    if (searchPath.search_path !== fixedPostgresSearchPath(schema)) {
      throw new Error(`${purpose} Postgres search path is not fixed`);
    }
  } finally {
    client.release();
  }
}

function singleRecord(result: PostgresQueryResult, label: string): Record<string, unknown> {
  if (result.rows.length !== 1) throw new Error(`${label} is unavailable`);
  const value = result.rows[0];
  if (!isRecord(value)) throw new Error(`${label} is invalid`);
  return value;
}

async function ensurePostgresHistory(client: PostgresClient, schema: string): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${qualified(schema, POSTGRES_HISTORY_TABLE)} (` +
      "migration_id text PRIMARY KEY NOT NULL, sql_sha256 text NOT NULL, " +
      "manifest_sha256 text NOT NULL, destination_schema_version bigint NOT NULL, " +
      "applied_at text NOT NULL)",
  );
}

async function readAppliedMigrations(
  client: PostgresClient,
  schema: string,
): Promise<AppliedMigration[]> {
  const result = await client.query(
    'SELECT migration_id AS "migrationId", sql_sha256 AS "sqlSha256", ' +
      'manifest_sha256 AS "manifestSha256", ' +
      'destination_schema_version::int AS "destinationSchemaVersion", ' +
      `applied_at AS "appliedAt" FROM ${qualified(schema, POSTGRES_HISTORY_TABLE)} ORDER BY applied_at, migration_id`,
  );
  const applied: AppliedMigration[] = [];
  for (const row of result.rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("Postgres migration history row is invalid");
    }
    if (
      !("migrationId" in row) ||
      !("sqlSha256" in row) ||
      !("manifestSha256" in row) ||
      !("destinationSchemaVersion" in row) ||
      !("appliedAt" in row) ||
      typeof row.migrationId !== "string" ||
      typeof row.sqlSha256 !== "string" ||
      typeof row.manifestSha256 !== "string" ||
      typeof row.destinationSchemaVersion !== "number" ||
      typeof row.appliedAt !== "string"
    ) {
      throw new Error("Postgres migration history row is malformed");
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

async function ensurePostgresStorageIdentity(
  client: PostgresClient,
  schema: string,
  logicalHostId: string,
  storeId: string,
): Promise<void> {
  const table = qualified(schema, "__caplets_storage_identity_v1");
  await client.query(
    `INSERT INTO ${table} (singleton, logical_host_id, store_id) VALUES (1, $1, $2) ` +
      "ON CONFLICT (singleton) DO NOTHING",
    [logicalHostId, storeId],
  );
  const result = await client.query(
    `SELECT logical_host_id, store_id FROM ${table} WHERE singleton = 1`,
  );
  const identity = singleRecord(result, "Postgres storage identity");
  if (identity.logical_host_id !== logicalHostId || identity.store_id !== storeId) {
    throw new Error("Postgres storage identity does not match the resolved deployment");
  }
}

function poolConfiguration(profile: PostgresConnectionProfile): Record<string, unknown> {
  assertSafeSqlIdentifier(profile.role, "Postgres connection role");
  const url = new URL(profile.connectionString);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Postgres connection string protocol is invalid");
  }
  if (decodeURIComponent(url.username) !== profile.role) {
    throw new Error("Postgres connection role does not match the connection string");
  }
  if (profile.tls.mode !== "verify-full" || !profile.tls.ca || !profile.tls.servername) {
    throw new Error("Postgres connections require verify-full TLS identity");
  }
  if (url.searchParams.get("sslmode") !== "verify-full") {
    throw new Error("Postgres connection string must declare sslmode=verify-full");
  }
  for (const key of url.searchParams.keys()) {
    if (key.toLowerCase().startsWith("ssl") && key !== "sslmode") {
      throw new Error(`Postgres connection string cannot override TLS with ${key}`);
    }
  }
  url.searchParams.delete("sslmode");
  if (profile.tls.servername.toLowerCase() !== url.hostname.toLowerCase()) {
    throw new Error("Postgres TLS server identity does not match the connection host");
  }
  return {
    connectionString: url.href,
    max: profile.maximumConnections ?? 8,
    ssl: {
      rejectUnauthorized: true,
      ca: profile.tls.ca,
      servername: profile.tls.servername,
    },
  };
}

function assertDistinctProfiles(
  runtime: PostgresConnectionProfile,
  migrator: PostgresConnectionProfile,
  maintenance: PostgresConnectionProfile | undefined,
): void {
  const roles = [runtime.role, migrator.role, ...(maintenance ? [maintenance.role] : [])];
  if (new Set(roles).size !== roles.length)
    throw new Error("Postgres storage roles must be distinct");
  const connectionStrings = [
    runtime.connectionString,
    migrator.connectionString,
    ...(maintenance ? [maintenance.connectionString] : []),
  ];
  if (new Set(connectionStrings).size !== connectionStrings.length) {
    throw new Error("Postgres storage pools must use distinct credentials");
  }
}

function assertRoleSet(roles: PostgresRoleSet, pools: PostgresPoolSet): void {
  const values = [roles.runtime, roles.migrator, ...(roles.maintenance ? [roles.maintenance] : [])];
  if (new Set(values).size !== values.length)
    throw new Error("Postgres role identities must be distinct");
  if (Boolean(roles.maintenance) !== Boolean(pools.maintenance)) {
    throw new Error("Postgres maintenance role and pool must be configured together");
  }
  if (
    pools.runtime === pools.migrator ||
    pools.runtime === pools.maintenance ||
    pools.migrator === pools.maintenance
  ) {
    throw new Error("Postgres runtime, migrator, and maintenance pools must be separate");
  }
}

function loadPoolConstructor(): PostgresPoolConstructor {
  const moduleValue: unknown = require("pg");
  if (!moduleValue || typeof moduleValue !== "object" || !("Pool" in moduleValue)) {
    throw new Error("Postgres driver does not expose Pool");
  }
  const Pool = moduleValue.Pool;
  if (typeof Pool !== "function") throw new Error("Postgres Pool constructor is invalid");
  return Pool as PostgresPoolConstructor;
}

function qualified(schema: string, table: string): string {
  return `${quoteSafeSqlIdentifier(schema)}.${quoteSafeSqlIdentifier(table)}`;
}

async function closePools(pools: PostgresPoolSet): Promise<void> {
  const failures: unknown[] = [];
  for (const pool of [pools.maintenance, pools.migrator, pools.runtime]) {
    if (!pool) continue;
    try {
      await pool.end();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0)
    throw new AggregateError(failures, "Postgres pools did not close cleanly");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
