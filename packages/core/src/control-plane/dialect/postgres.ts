import { createHash } from "node:crypto";
import { and, asc, desc, eq, getTableName, gt, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { AnyPgColumn, AnyPgTable } from "drizzle-orm/pg-core";
import { createRequire } from "node:module";
import { CapletsError } from "../../errors";
import {
  normalizedPostgresConnectionReference,
  type ResolvedPostgresStorage,
} from "../storage-config";
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
import { controlPlaneNodeAdmissionLock } from "../types";
const require = createRequire(import.meta.url);
const POSTGRES_HISTORY_TABLE = "__caplets_migration_history_v1";
const MIGRATION_DESTINATION_PROOF_FUNCTION = "cp_migration_destination_contains_authoritative_rows";
const MIGRATION_ADVISORY_LOCK = "731840728441713664";
const MIGRATION_DRAIN_FUNCTION = "cp_guard_node_lifecycle_during_migration";
const MIGRATION_DRAIN_LEASE_TRIGGER = "cp_migration_drain_node_lease";
const MIGRATION_DRAIN_FENCE_TRIGGER = "cp_migration_drain_writer_fence";
const RUNTIME_ACTIVATION_MIGRATION_ID = "u10-runtime-activation";
const RUNTIME_READ_TABLES = Object.values(postgresControlPlaneSchema).map((table) =>
  getTableName(table),
);
const RUNTIME_MUTATION_EXCLUSIONS: Readonly<Record<string, true>> = {
  __caplets_storage_identity_v1: true,
  cp_migration: true,
  cp_backup: true,
  cp_recovery: true,
  cp_retention: true,
  cp_external_destruction: true,
  cp_recovery_checkpoint: true,
  cp_quarantine: true,
};
const RUNTIME_MUTATION_TABLES = RUNTIME_READ_TABLES.filter(
  (table) => !RUNTIME_MUTATION_EXCLUSIONS[table],
);

export type PostgresQueryResult = {
  rows: unknown[];
  rowCount: number | null;
};

export type PostgresClient = {
  query(sql: string, parameters?: readonly unknown[]): Promise<PostgresQueryResult>;
  on?(
    event: "notification",
    listener: (message: Readonly<{ channel?: string; payload?: string }>) => void,
  ): void;
  on?(event: "error", listener: (error: Error) => void): void;
  on?(event: "end", listener: () => void): void;
  removeListener?(
    event: "notification",
    listener: (message: Readonly<{ channel?: string; payload?: string }>) => void,
  ): void;
  removeListener?(event: "error", listener: (error: Error) => void): void;
  removeListener?(event: "end", listener: () => void): void;
  release(error?: Error): void;
};

export type PostgresPool = {
  connect(): Promise<PostgresClient>;
  query(sql: string, parameters?: readonly unknown[]): Promise<PostgresQueryResult>;
  end(): Promise<void>;
  on?(event: "error", listener: (error: Error) => void): void;
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

export type PostgresMigrationDrain = Readonly<{
  gateId: string;
  status: "active" | "not-applicable";
}>;

export type PostgresControlPlaneDialect = ControlPlaneTransactionalDialect & {
  readonly backend: "postgres";
  readonly ready: boolean;
  beginMigrationDrain(gateId: string): Promise<PostgresMigrationDrain>;
  releaseMigrationDrain(gateId: string, outcome: "finalized" | "rolled-back"): Promise<void>;
  migrate(): Promise<readonly string[]>;
  rollbackLatest(): Promise<string>;
  query<T>(sql: string, parameters?: readonly unknown[]): Promise<readonly T[]>;
  maintenanceQuery<T>(sql: string, parameters?: readonly unknown[]): Promise<readonly T[]>;
  close(): Promise<void>;
};

export async function verifyPostgresOldNodesDrained(
  profile: PostgresConnectionProfile,
): Promise<boolean> {
  const Pool = loadPoolConstructor();
  const pool = new Pool(poolConfiguration(profile));
  guardIdlePoolErrors(pool);
  try {
    const existing = await pool.query("SELECT to_regclass($1) AS table_name", [
      `${CONTROL_PLANE_POSTGRES_SCHEMA}.cp_cluster_node_lease`,
    ]);
    const tableName = existing.rows[0];
    if (
      !tableName ||
      typeof tableName !== "object" ||
      !("table_name" in tableName) ||
      tableName.table_name === null
    ) {
      return true;
    }
    const active = await pool.query(
      `SELECT EXISTS (
         SELECT 1
         FROM ${CONTROL_PLANE_POSTGRES_SCHEMA}.cp_cluster_node_lease AS node
         LEFT JOIN ${CONTROL_PLANE_POSTGRES_SCHEMA}.cp_writer_fence AS fence
           ON fence.logical_host_id = node.logical_host_id
          AND fence.store_id = node.store_id
          AND fence.lease_id = 'writer:' || node.node_id
         WHERE node.state IN ('ready', 'catching-up', 'activation-pending')
           AND node.expires_at::timestamptz > clock_timestamp()
           AND (
             fence.lease_id IS NULL
             OR (
               fence.state IN ('active', 'pending')
               AND fence.expires_at::timestamptz > clock_timestamp()
             )
           )
       ) AS active`,
    );
    const row = active.rows[0];
    return Boolean(row && typeof row === "object" && "active" in row && row.active === false);
  } finally {
    await pool.end();
  }
}

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
  guardIdlePoolErrors(runtime);
  guardIdlePoolErrors(migrator);
  if (maintenance) guardIdlePoolErrors(maintenance);
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
 * Opens a steady-state online dialect with only the runtime credential. Migration and
 * maintenance credentials are deliberately unreachable from the serving process.
 */
export async function openPostgresRuntimeControlPlaneDialect(options: {
  storage: ResolvedPostgresStorage;
  runtime: PostgresConnectionProfile;
  environment: MigrationEnvironment;
  schema?: string | undefined;
  assetRoot?: URL | string | undefined;
}): Promise<PostgresControlPlaneDialect> {
  const registry = await loadMigrationRegistry({
    dialect: "postgres",
    ...(options.assetRoot === undefined ? {} : { assetRoot: options.assetRoot }),
  });
  const schema = assertSafeSqlIdentifier(
    options.schema ?? CONTROL_PLANE_POSTGRES_SCHEMA,
    "Postgres control-plane schema",
  );
  const Pool = loadPoolConstructor();
  const runtime = new Pool(poolConfiguration(options.runtime));
  const unavailableMigrator = unavailablePostgresPool("migrator", "online");
  guardIdlePoolErrors(runtime);
  try {
    await verifyRole(runtime, options.runtime.role, "runtime", schema);
    await verifyRuntimeMigrationState(
      runtime,
      schema,
      registry,
      options.environment,
      options.storage,
    );
    return createDialect(
      {
        storage: options.storage,
        pools: { runtime, migrator: unavailableMigrator },
        roles: { runtime: options.runtime.role, migrator: "__unavailable_migrator__" },
        registry,
        environment: options.environment,
      },
      schema,
      true,
    );
  } catch (error) {
    await runtime.end().catch(() => undefined);
    throw error;
  }
}

/**
 * Opens a one-shot operational dialect with exactly one selected credential. It is not a
 * serving dialect: migrators can only migrate, and maintenance roles can only use maintenance
 * transactions required by explicit U7 initialization.
 */
export async function openPostgresOperationalControlPlaneDialect(options: {
  storage: ResolvedPostgresStorage;
  purpose: "migrator" | "maintenance";
  profile: PostgresConnectionProfile;
  runtimeRole: string;
  environment: MigrationEnvironment;
  schema?: string | undefined;
  assetRoot?: URL | string | undefined;
}): Promise<PostgresControlPlaneDialect> {
  const registry = await loadMigrationRegistry({
    dialect: "postgres",
    ...(options.assetRoot === undefined ? {} : { assetRoot: options.assetRoot }),
  });
  assertMigrationEnvironment(registry, options.environment);
  const schema = assertSafeSqlIdentifier(
    options.schema ?? CONTROL_PLANE_POSTGRES_SCHEMA,
    "Postgres control-plane schema",
  );
  const Pool = loadPoolConstructor();
  const selected = new Pool(poolConfiguration(options.profile));
  guardIdlePoolErrors(selected);
  try {
    await verifyRole(selected, options.profile.role, options.purpose, schema);
    const unavailableRuntime = unavailablePostgresPool("runtime", options.purpose);
    const unavailableMigrator =
      options.purpose === "migrator"
        ? selected
        : unavailablePostgresPool("migrator", options.purpose);
    return createDialect(
      {
        storage: options.storage,
        pools: {
          runtime: unavailableRuntime,
          migrator: unavailableMigrator,
          ...(options.purpose === "maintenance" ? { maintenance: selected } : {}),
        },
        roles: {
          runtime: options.runtimeRole,
          migrator:
            options.purpose === "migrator" ? options.profile.role : "__unavailable_migrator__",
          ...(options.purpose === "maintenance" ? { maintenance: options.profile.role } : {}),
        },
        registry,
        environment: options.environment,
      },
      schema,
      options.purpose === "maintenance",
      options.purpose === "migrator",
    );
  } catch (error) {
    await selected.end().catch(() => undefined);
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
  initiallyReady = false,
  requireMigrationDrain = false,
): PostgresControlPlaneDialect {
  guardIdlePoolErrors(options.pools.runtime);
  guardIdlePoolErrors(options.pools.migrator);
  if (options.pools.maintenance) guardIdlePoolErrors(options.pools.maintenance);
  let ready = initiallyReady;
  let closed = false;
  const notificationSubscriptions = new Set<() => Promise<void>>();
  let migrationDrain: PostgresMigrationDrain | undefined;
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
    async metadataReadTransaction<T>(
      work: (transaction: ControlPlaneSqlTransaction) => Promise<T>,
    ): Promise<T> {
      requireReady();
      return withRuntimeTransaction(
        options.pools.maintenance ?? options.pools.runtime,
        schema,
        work,
        "BEGIN READ ONLY",
      );
    },
    async subscribeToChanges(listener) {
      requireReady();
      const client = await options.pools.runtime.connect();
      if (!client.on || !client.removeListener) {
        client.release();
        throw new Error("Postgres notification client does not expose listener events");
      }
      let subscribed = true;
      const handler = (message: Readonly<{ channel?: string; payload?: string }>) => {
        if (message.channel !== "caplets_control_plane_change") return;
        // NOTIFY payloads are untrusted, lossy wakeups. Consumers always reread the full
        // authoritative ordered tuple in a repeatable-read transaction.
        listener(undefined);
      };
      const detach = async (unlisten: boolean, failure?: Error) => {
        if (!subscribed) return;
        subscribed = false;
        notificationSubscriptions.delete(unsubscribe);
        client.removeListener?.("notification", handler);
        client.removeListener?.("end", endHandler);
        if (unlisten) {
          client.removeListener?.("error", errorHandler);
          await client.query("UNLISTEN caplets_control_plane_change").catch(() => undefined);
        }
        client.release(failure);
      };
      const errorHandler = (error: Error) => {
        // LISTEN is only a lossy wakeup. Destroy a failed checked-out client while retaining its
        // error listener so follow-up driver errors cannot escape as unhandled EventEmitter errors.
        void detach(false, error);
      };
      const endHandler = () => {
        void detach(false, new Error("Postgres notification connection ended"));
      };
      const unsubscribe = () => detach(true);
      client.on("notification", handler);
      client.on("error", errorHandler);
      client.on("end", endHandler);
      try {
        await client.query("SELECT set_config('search_path', $1, false)", [
          fixedPostgresSearchPath(schema),
        ]);
        await client.query("LISTEN caplets_control_plane_change");
      } catch (error) {
        await detach(false);
        throw error;
      }
      if (subscribed) notificationSubscriptions.add(unsubscribe);
      return unsubscribe;
    },
    async publishChange(token) {
      requireReady();
      await queryWithFixedSearchPath(options.pools.runtime, schema, "SELECT pg_notify($1, $2)", [
        "caplets_control_plane_change",
        JSON.stringify(token),
      ]);
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
    async beginMigrationDrain(gateId) {
      requireOpen();
      if (migrationDrain) {
        if (migrationDrain.gateId !== gateId) {
          throw new Error("A different Postgres migration drain is already active");
        }
        return migrationDrain;
      }
      migrationDrain = await beginPostgresMigrationDrain(
        options.pools.migrator,
        schema,
        options.storage,
        gateId,
      );
      return migrationDrain;
    },
    async releaseMigrationDrain(gateId, outcome) {
      requireOpen();
      if (!migrationDrain || migrationDrain.gateId !== gateId) {
        throw new Error("The Postgres migration drain release does not match the active gate");
      }
      if (migrationDrain.status === "active") {
        await releasePostgresMigrationDrain(
          options.pools.migrator,
          schema,
          options.storage,
          gateId,
          outcome,
        );
      }
      migrationDrain = undefined;
    },
    async migrate() {
      requireOpen();
      if (requireMigrationDrain && !migrationDrain) {
        throw new Error("Postgres migration requires an active migration drain");
      }
      assertMigrationEnvironment(options.registry, options.environment);
      try {
        const activated = await withMigrationTransaction(
          options.pools.migrator,
          schema,
          async (client) => {
            if (requireMigrationDrain && migrationDrain?.status === "active") {
              await assertPostgresMigrationDrain(
                client,
                schema,
                options.storage,
                migrationDrain.gateId,
              );
            }
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
            if (options.roles.runtime !== "__unavailable_runtime__") {
              const runtimeRole = quoteSafeSqlIdentifier(options.roles.runtime);
              await client.query(
                `GRANT USAGE ON SCHEMA ${quoteSafeSqlIdentifier(schema)} TO ${runtimeRole}`,
              );
              await client.query(
                `GRANT SELECT ON ${[
                  qualified(schema, POSTGRES_HISTORY_TABLE),
                  ...RUNTIME_READ_TABLES.map((table) => qualified(schema, table)),
                ].join(", ")} TO ${runtimeRole}`,
              );
              await client.query(
                `GRANT INSERT, UPDATE, DELETE ON ${RUNTIME_MUTATION_TABLES.map((table) =>
                  qualified(schema, table),
                ).join(", ")} TO ${runtimeRole}`,
              );
              await client.query(
                `GRANT INSERT, UPDATE ON ${qualified(schema, "cp_migration")} TO ${runtimeRole}`,
              );
              await client.query(
                `REVOKE UPDATE, DELETE ON ${qualified(
                  schema,
                  "cp_operator_activity",
                )} FROM ${runtimeRole}`,
              );
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
                `GRANT SELECT ON ${[
                  "__caplets_storage_identity_v1",
                  POSTGRES_HISTORY_TABLE,
                  "cp_operation_namespace",
                  "cp_cluster_node_lease",
                  "cp_writer_fence",
                ]
                  .map((table) => qualified(schema, table))
                  .join(", ")} TO ` + quoteSafeSqlIdentifier(options.roles.maintenance),
              );
              await client.query(
                `GRANT SELECT, INSERT, UPDATE, DELETE ON ${[
                  "cp_migration",
                  "cp_authority_version",
                  "cp_effective_version",
                  "cp_security_version",
                  "cp_backup",
                ]
                  .map((table) => qualified(schema, table))
                  .join(", ")} TO ` + quoteSafeSqlIdentifier(options.roles.maintenance),
              );
              const destinationProofFunction = `${qualified(
                schema,
                MIGRATION_DESTINATION_PROOF_FUNCTION,
              )}(text, text)`;
              await client.query(
                `CREATE OR REPLACE FUNCTION ${destinationProofFunction}
                 RETURNS boolean
                 LANGUAGE plpgsql
                 SECURITY DEFINER
                 SET search_path = pg_catalog
                 AS $caplets$
                 DECLARE
                   candidate text;
                   contains_rows boolean;
                   has_store_id boolean;
                 BEGIN
                   FOR candidate IN
                     SELECT tablename
                     FROM pg_catalog.pg_tables
                     WHERE schemaname = ${postgresLiteral(schema)}
                       AND left(tablename, 3) = 'cp_'
                       AND tablename NOT IN (
                         'cp_migration',
                         'cp_operation_namespace',
                         'cp_authority_version',
                         'cp_effective_version',
                         'cp_security_version',
                         'cp_snapshot_envelope',
                         'cp_backup'
                       )
                   LOOP
                     SELECT EXISTS (
                       SELECT 1
                       FROM information_schema.columns
                       WHERE table_schema = ${postgresLiteral(schema)}
                         AND table_name = candidate
                         AND column_name = 'store_id'
                     ) INTO has_store_id;
                     IF has_store_id THEN
                       EXECUTE format(
                         'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE logical_host_id = $1 AND store_id = $2)',
                         ${postgresLiteral(schema)},
                         candidate
                       ) INTO contains_rows USING $1, $2;
                     ELSE
                       EXECUTE format(
                         'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE logical_host_id = $1)',
                         ${postgresLiteral(schema)},
                         candidate
                       ) INTO contains_rows USING $1;
                     END IF;
                     IF contains_rows THEN
                       RETURN true;
                     END IF;
                   END LOOP;
                   IF EXISTS (
                     SELECT 1
                     FROM ${qualified(schema, "cp_snapshot_envelope")}
                     WHERE logical_host_id = $1
                       AND store_id = $2
                       AND NOT (
                         id = 'snapshot-envelope:control-plane'
                         AND envelope_id = 'control-plane'
                         AND caplet_count = 0
                         AND normalized_row_count = 0
                         AND encoded_byte_count = 0
                         AND aggregate_version = 0
                         AND authority_version = 0
                         AND effective_version = 0
                         AND security_version = 0
                       )
                   ) THEN
                     RETURN true;
                   END IF;
                   RETURN false;
                 END
                 $caplets$`,
              );
              await client.query(`REVOKE ALL ON FUNCTION ${destinationProofFunction} FROM PUBLIC`);
              await client.query(
                `GRANT EXECUTE ON FUNCTION ${destinationProofFunction} TO ` +
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
      if (requireMigrationDrain && !migrationDrain) {
        throw new Error("Postgres rollback requires an active migration drain");
      }
      const migrationId = await withMigrationTransaction(
        options.pools.migrator,
        schema,
        async (client) => {
          if (requireMigrationDrain && migrationDrain?.status === "active") {
            await assertPostgresMigrationDrain(
              client,
              schema,
              options.storage,
              migrationDrain.gateId,
            );
          }
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
      await Promise.all([...notificationSubscriptions].map((unsubscribe) => unsubscribe()));
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
  const client = await pool.connect().catch((error: unknown) => {
    throw normalizePostgresAvailabilityError(error);
  });
  const orm = drizzle(client as never, { schema: postgresControlPlaneSchema });
  let releaseError: Error | undefined;
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
        async tryLock(serialKey: string) {
          const result = await orm.execute<{ acquired: boolean }>(
            sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${serialKey}, 0)) AS acquired`,
          );
          return result.rows[0]?.acquired === true;
        },
        async migrationDestinationContainsAuthoritativeRows(logicalHostId, storeId) {
          const result = await client.query(
            `SELECT ${qualified(
              schema,
              MIGRATION_DESTINATION_PROOF_FUNCTION,
            )}($1, $2) AS contains_rows`,
            [logicalHostId, storeId],
          );
          const row = singleRecord(result, "Postgres migration destination proof");
          if (typeof row.contains_rows !== "boolean") {
            throw new Error("Postgres migration destination proof is invalid");
          }
          return row.contains_rows;
        },
        async finalWriterFenceGuard(input) {
          const table = postgresControlPlaneSchema.writerFences;
          const now = sql<string>`to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
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
                sql`${table.expiresAt!}::timestamptz > clock_timestamp()`,
              ),
            );
          return result.rowCount ?? 0;
        },
        async advanceSnapshotEnvelope(input) {
          const result = await client.query(
            `UPDATE ${qualified(schema, "cp_snapshot_envelope")} AS envelope
             SET caplet_count = envelope.caplet_count + $4,
                 normalized_row_count = envelope.normalized_row_count + $5,
                 encoded_byte_count = envelope.encoded_byte_count + $6,
                 aggregate_version = (
                   SELECT generation FROM ${qualified(schema, "cp_effective_version")}
                   WHERE logical_host_id = $1 AND store_id = $2
                   ORDER BY generation DESC LIMIT 1
                 ),
                 authority_version = $10,
                 effective_version = (
                   SELECT generation FROM ${qualified(schema, "cp_effective_version")}
                   WHERE logical_host_id = $1 AND store_id = $2
                   ORDER BY generation DESC LIMIT 1
                 ),
                 security_version = $11,
                 updated_at = to_char(
                   clock_timestamp() AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                 )
             WHERE envelope.logical_host_id = $1
               AND envelope.store_id = $2
               AND envelope.envelope_id = $3
               AND envelope.caplet_count + $4 BETWEEN 0 AND $7
               AND envelope.normalized_row_count + $5 BETWEEN 0 AND $8
               AND envelope.encoded_byte_count + $6 BETWEEN 0 AND $9
               AND (
                 SELECT generation FROM ${qualified(schema, "cp_authority_version")}
                 WHERE logical_host_id = $1 AND store_id = $2
                 ORDER BY generation DESC LIMIT 1
               ) = $10
               AND (
                 SELECT epoch FROM ${qualified(schema, "cp_security_version")}
                 WHERE logical_host_id = $1 AND store_id = $2
                 ORDER BY epoch DESC LIMIT 1
               ) = $11
               AND EXISTS (
                 SELECT 1 FROM ${qualified(schema, "cp_writer_fence")} AS fence
                 WHERE fence.logical_host_id = $1
                   AND fence.store_id = $2
                   AND fence.lease_id = $12
                   AND fence.writer_epoch = $13
                   AND fence.authority_generation = $14
                   AND fence.state = $15
                   AND fence.expires_at::timestamptz > clock_timestamp()
               )
             RETURNING envelope.id`,
            [
              input.logicalHostId,
              input.storeId,
              input.envelopeId,
              input.capletDelta,
              input.normalizedRowDelta,
              input.encodedByteDelta,
              input.maxCaplets,
              input.maxNormalizedRows,
              input.maxEncodedBytes,
              input.expectedAuthorityGeneration,
              input.expectedSecurityEpoch,
              input.leaseId,
              input.writerEpoch,
              input.fenceAuthorityGeneration,
              input.fenceState,
            ],
          );
          return result.rowCount ?? 0;
        },
        async settleConvergenceReceipts(input) {
          const result = await client.query(
            `WITH candidates AS (
               SELECT id,
                      CASE
                        WHEN (receipt::jsonb #>> '{convergence,deadline}')::timestamptz <=
                             clock_timestamp()
                          THEN 'overdue'
                        ELSE 'converged'
                      END AS target
               FROM caplets.cp_operation_outcome
               WHERE logical_host_id = $1
                 AND store_id = $2
                 AND convergence_class = 'pending'
                 AND (
                   (receipt::jsonb #>> '{convergence,deadline}')::timestamptz <=
                     clock_timestamp()
                   OR (
                     (receipt::jsonb #>> '{convergence,requiredNodes}')::integer <= $3
                     AND (receipt::jsonb #>> '{authorityToken,authorityGeneration}')::bigint = $4
                     AND (receipt::jsonb #>> '{authorityToken,effectiveGeneration}')::bigint <= $5
                     AND security_version <= $6
                   )
                 )
               ORDER BY operation_id
               LIMIT $7
             )
             UPDATE caplets.cp_operation_outcome AS outcome
             SET convergence_class = candidates.target,
                 updated_at = to_char(
                   clock_timestamp() AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                 )
             FROM candidates
             WHERE outcome.logical_host_id = $1
               AND outcome.store_id = $2
               AND outcome.id = candidates.id
               AND outcome.convergence_class = 'pending'
             RETURNING outcome.id`,
            [
              input.logicalHostId,
              input.storeId,
              input.appliedNodes,
              input.authorityGeneration,
              input.effectiveGeneration,
              input.securityEpoch,
              input.limit,
            ],
          );
          return result.rowCount ?? 0;
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
      throw normalizePostgresAvailabilityError(error);
    }
  } catch (error) {
    const normalized = normalizePostgresAvailabilityError(error);
    if (normalized instanceof CapletsError && normalized.code === "SERVER_UNAVAILABLE") {
      releaseError = error instanceof Error ? error : normalized;
    }
    throw normalized;
  } finally {
    client.release(releaseError);
  }
}

function normalizePostgresAvailabilityError(error: unknown): unknown {
  if (error instanceof CapletsError) return error;
  const code =
    error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  const message = error instanceof Error ? error.message : "";
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EPIPE" ||
    code === "55P03" ||
    code === "55000" ||
    code === "57014" ||
    code?.startsWith("08") ||
    /(?:connection|query|statement|lock).*(?:closed|ended|lost|terminated|timeout|timed out)|query read timeout|terminating connection/iu.test(
      message,
    )
  ) {
    return new CapletsError("SERVER_UNAVAILABLE", "Postgres control-plane storage is unavailable.");
  }
  return error;
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

type MigrationDrainActivationRow = Readonly<{
  compatibility: unknown;
}>;

type MigrationDrainDocument = Readonly<{
  generation: number;
  currentFingerprint: string;
  migrationDrain?: Readonly<{
    gateId?: unknown;
    previousCompatibility?: unknown;
  }>;
}>;

async function beginPostgresMigrationDrain(
  pool: PostgresPool,
  schema: string,
  storage: ResolvedPostgresStorage,
  gateId: string,
): Promise<PostgresMigrationDrain> {
  assertMigrationDrainGateId(gateId);
  return withMigrationTransaction(pool, schema, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      controlPlaneNodeAdmissionLock(storage),
    ]);
    const tables = await client.query(
      "SELECT to_regclass($1) AS activation, to_regclass($2) AS leases, " +
        "to_regclass($3) AS fences",
      [`${schema}.cp_migration`, `${schema}.cp_cluster_node_lease`, `${schema}.cp_writer_fence`],
    );
    const tableState = tables.rows[0] as
      | Readonly<{ activation?: unknown; leases?: unknown; fences?: unknown }>
      | undefined;
    if (!tableState?.activation || !tableState.leases || !tableState.fences) {
      return Object.freeze({ gateId, status: "not-applicable" as const });
    }

    await ensureMigrationDrainTriggers(client, schema);
    const activation = await readMigrationDrainActivation(client, schema, storage);
    if (!activation) {
      return Object.freeze({ gateId, status: "not-applicable" as const });
    }
    const current = parseMigrationDrainDocument(activation.compatibility);
    if (current.migrationDrain) {
      if (current.migrationDrain.gateId !== gateId) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "A different Postgres migration drain is already active.",
        );
      }
      return Object.freeze({ gateId, status: "active" as const });
    }

    const activeNodes = await client.query(
      `SELECT EXISTS (
         SELECT 1
         FROM ${qualified(schema, "cp_cluster_node_lease")} AS node
         LEFT JOIN ${qualified(schema, "cp_writer_fence")} AS fence
           ON fence.logical_host_id = node.logical_host_id
          AND fence.store_id = node.store_id
          AND fence.lease_id = 'writer:' || node.node_id
         WHERE node.logical_host_id = $1
           AND node.store_id = $2
           AND node.state IN ('ready', 'catching-up', 'activation-pending')
           AND node.expires_at::timestamptz > clock_timestamp()
           AND (
             fence.lease_id IS NULL
             OR (
               fence.state IN ('active', 'pending')
               AND fence.expires_at::timestamptz > clock_timestamp()
             )
           )
       ) AS active`,
      [storage.logicalHostId, storage.storeId],
    );
    const active = (activeNodes.rows[0] as Readonly<{ active?: unknown }> | undefined)?.active;
    if (active !== false) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Postgres migration requires every old control-plane node lease to be drained.",
      );
    }

    await client.query(
      `UPDATE ${qualified(schema, "cp_cluster_node_lease")}
          SET state = 'activation-drained', expires_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE logical_host_id = $1 AND store_id = $2
          AND state IN ('ready', 'catching-up', 'activation-pending')`,
      [storage.logicalHostId, storage.storeId],
    );
    await client.query(
      `UPDATE ${qualified(schema, "cp_writer_fence")}
          SET state = 'revoked', expires_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE logical_host_id = $1 AND store_id = $2
          AND state IN ('active', 'pending')`,
      [storage.logicalHostId, storage.storeId],
    );
    const guarded: MigrationDrainDocument = Object.freeze({
      generation: current.generation,
      currentFingerprint: migrationDrainFingerprint(gateId),
      migrationDrain: Object.freeze({
        gateId,
        previousCompatibility: activation.compatibility,
      }),
    });
    await client.query(
      `UPDATE ${qualified(schema, "cp_migration")}
          SET compatibility = $1, updated_at = clock_timestamp()
        WHERE logical_host_id = $2 AND store_id = $3 AND migration_id = $4`,
      [
        JSON.stringify(guarded),
        storage.logicalHostId,
        storage.storeId,
        RUNTIME_ACTIVATION_MIGRATION_ID,
      ],
    );
    return Object.freeze({ gateId, status: "active" as const });
  });
}

async function releasePostgresMigrationDrain(
  pool: PostgresPool,
  schema: string,
  storage: ResolvedPostgresStorage,
  gateId: string,
  outcome: "finalized" | "rolled-back",
): Promise<void> {
  assertMigrationDrainGateId(gateId);
  if (outcome !== "finalized" && outcome !== "rolled-back") {
    throw new Error("Postgres migration drain outcome is invalid");
  }
  await withMigrationTransaction(pool, schema, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      controlPlaneNodeAdmissionLock(storage),
    ]);
    const activation = await readMigrationDrainActivation(client, schema, storage);
    if (!activation) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "The Postgres migration drain activation row is unavailable.",
      );
    }
    const current = parseMigrationDrainDocument(activation.compatibility);
    const previousCompatibility = current.migrationDrain?.previousCompatibility;
    if (current.migrationDrain?.gateId !== gateId || previousCompatibility === undefined) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "The Postgres migration drain no longer matches this operation.",
      );
    }
    parseMigrationDrainDocument(previousCompatibility);
    const restored = await client.query(
      `UPDATE ${qualified(schema, "cp_migration")}
          SET compatibility = $1::jsonb, updated_at = clock_timestamp()
        WHERE logical_host_id = $2 AND store_id = $3 AND migration_id = $4
          AND compatibility = $5::jsonb`,
      [
        encodePostgresJson(previousCompatibility),
        storage.logicalHostId,
        storage.storeId,
        RUNTIME_ACTIVATION_MIGRATION_ID,
        encodePostgresJson(activation.compatibility),
      ],
    );
    if (restored.rowCount !== 1) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "The Postgres migration drain changed concurrently.",
      );
    }
  });
}

async function ensureMigrationDrainTriggers(client: PostgresClient, schema: string): Promise<void> {
  const guard = qualified(schema, MIGRATION_DRAIN_FUNCTION);
  await client.query(
    `CREATE OR REPLACE FUNCTION ${guard}() RETURNS trigger
       LANGUAGE plpgsql
       SECURITY DEFINER
       SET search_path = pg_catalog
     AS $migration_drain$
     BEGIN
       IF EXISTS (
         SELECT 1
           FROM ${qualified(schema, "cp_migration")} AS activation
          WHERE activation.logical_host_id = NEW.logical_host_id
            AND activation.store_id = NEW.store_id
            AND activation.migration_id = '${RUNTIME_ACTIVATION_MIGRATION_ID}'
            AND COALESCE(activation.compatibility::jsonb ? 'migrationDrain', false)
       ) THEN
         RAISE EXCEPTION 'control-plane migration drain is active' USING ERRCODE = '55000';
       END IF;
       RETURN NEW;
     END
     $migration_drain$`,
  );
  await client.query(`REVOKE ALL ON FUNCTION ${guard}() FROM PUBLIC`);
  for (const [table, trigger] of [
    ["cp_cluster_node_lease", MIGRATION_DRAIN_LEASE_TRIGGER],
    ["cp_writer_fence", MIGRATION_DRAIN_FENCE_TRIGGER],
  ] as const) {
    await client.query(
      `DROP TRIGGER IF EXISTS ${quoteSafeSqlIdentifier(trigger)} ON ${qualified(schema, table)}`,
    );
    await client.query(
      `CREATE TRIGGER ${quoteSafeSqlIdentifier(trigger)}
         BEFORE INSERT OR UPDATE ON ${qualified(schema, table)}
         FOR EACH ROW EXECUTE FUNCTION ${guard}()`,
    );
  }
}

async function assertPostgresMigrationDrain(
  client: PostgresClient,
  schema: string,
  storage: ResolvedPostgresStorage,
  gateId: string,
): Promise<void> {
  const activation = await readMigrationDrainActivation(client, schema, storage);
  if (
    !activation ||
    parseMigrationDrainDocument(activation.compatibility).migrationDrain?.gateId !== gateId
  ) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "The Postgres migration drain no longer matches this operation.",
    );
  }
}

async function readMigrationDrainActivation(
  client: PostgresClient,
  schema: string,
  storage: ResolvedPostgresStorage,
): Promise<MigrationDrainActivationRow | undefined> {
  const result = await client.query(
    `SELECT compatibility
       FROM ${qualified(schema, "cp_migration")}
      WHERE logical_host_id = $1 AND store_id = $2 AND migration_id = $3
      FOR UPDATE`,
    [storage.logicalHostId, storage.storeId, RUNTIME_ACTIVATION_MIGRATION_ID],
  );
  const row = result.rows[0];
  if (!row || typeof row !== "object" || !("compatibility" in row)) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "The Postgres runtime activation document is invalid.",
    );
  }
  parseMigrationDrainDocument(row.compatibility);
  return Object.freeze({ compatibility: row.compatibility });
}

function parseMigrationDrainDocument(compatibility: unknown): MigrationDrainDocument {
  let document: unknown = compatibility;
  try {
    if (typeof compatibility === "string") document = JSON.parse(compatibility);
  } catch {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "The Postgres runtime activation document is invalid.",
    );
  }
  if (
    !document ||
    typeof document !== "object" ||
    !("generation" in document) ||
    typeof document.generation !== "number" ||
    !Number.isSafeInteger(document.generation) ||
    !("currentFingerprint" in document) ||
    typeof document.currentFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(document.currentFingerprint)
  ) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "The Postgres runtime activation document is invalid.",
    );
  }
  return document as MigrationDrainDocument;
}
function encodePostgresJson(value: unknown): string {
  try {
    const encoded = typeof value === "string" ? value : JSON.stringify(value);
    if (typeof encoded !== "string") throw new Error("JSON value is unavailable");
    JSON.parse(encoded);
    return encoded;
  } catch {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "The Postgres runtime activation document is invalid.",
    );
  }
}

function migrationDrainFingerprint(gateId: string): string {
  return createHash("sha256").update(`migration-drain:${gateId}`).digest("hex");
}

function assertMigrationDrainGateId(gateId: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(gateId)) {
    throw new Error("Postgres migration drain gate id is invalid");
  }
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

export function assertFinalizedPostgresInitialization(
  result: PostgresQueryResult,
): "fresh" | "legacy" {
  if (result.rows.length !== 1) {
    throw new Error(
      "Postgres control-plane requires one finalized U7 initialization before online startup",
    );
  }
  const initialization = singleRecord(result, "Postgres U7 initialization");
  const stateDocument = initialization.state_document;
  if (
    !isRecord(stateDocument) ||
    stateDocument.kind !== "legacy-initialization" ||
    stateDocument.step !== "finalized" ||
    !isRecord(stateDocument.metadata) ||
    (stateDocument.metadata.kind !== "fresh" && stateDocument.metadata.kind !== "legacy")
  ) {
    throw new Error("Postgres finalized U7 initialization metadata is invalid");
  }
  return stateDocument.metadata.kind;
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

async function verifyRuntimeMigrationState(
  pool: PostgresPool,
  schema: string,
  registry: LoadedMigrationRegistry,
  environment: MigrationEnvironment,
  storage: ResolvedPostgresStorage,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SELECT set_config('search_path', $1, true)", [
      fixedPostgresSearchPath(schema),
    ]);
    const applied = await readAppliedMigrations(client, schema);
    if (planPendingMigrations(registry, applied, environment).length > 0) {
      throw new Error("Postgres control-plane migration is required before online startup");
    }
    const result = await client.query(
      `SELECT logical_host_id, store_id FROM ${qualified(
        schema,
        "__caplets_storage_identity_v1",
      )} WHERE singleton = 1`,
    );
    const identity = singleRecord(result, "Postgres storage identity");
    if (
      identity.logical_host_id !== storage.logicalHostId ||
      identity.store_id !== storage.storeId
    ) {
      throw new Error("Postgres storage identity does not match the resolved deployment");
    }
    const initialization = await client.query(
      `SELECT migration_id, state_document FROM ${qualified(schema, "cp_migration")} ` +
        "WHERE logical_host_id = $1 AND store_id = $2 AND phase = 'finalized' " +
        "AND state_document->>'kind' = 'legacy-initialization' " +
        "AND state_document->>'step' = 'finalized'",
      [storage.logicalHostId, storage.storeId],
    );
    assertFinalizedPostgresInitialization(initialization);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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

export function assertPostgresConnectionProfile(profile: PostgresConnectionProfile): void {
  normalizedPostgresConnectionUrl(profile);
}

function normalizedPostgresConnectionUrl(profile: PostgresConnectionProfile): URL {
  assertSafeSqlIdentifier(profile.role, "Postgres connection role");
  if (profile.tls.mode !== "verify-full" || !profile.tls.servername) {
    throw new Error("Postgres connections require explicit TLS identity verification");
  }
  return normalizedPostgresConnectionReference(
    profile.connectionString,
    profile.role,
    profile.tls.servername,
  );
}

const POSTGRES_OPERATION_TIMEOUT_MS = 4_000;

function poolConfiguration(profile: PostgresConnectionProfile): Record<string, unknown> {
  const url = normalizedPostgresConnectionUrl(profile);
  return {
    connectionString: url.href,
    max: profile.maximumConnections ?? 8,
    connectionTimeoutMillis: POSTGRES_OPERATION_TIMEOUT_MS,
    query_timeout: POSTGRES_OPERATION_TIMEOUT_MS,
    statement_timeout: POSTGRES_OPERATION_TIMEOUT_MS,
    lock_timeout: POSTGRES_OPERATION_TIMEOUT_MS,
    ssl: {
      rejectUnauthorized: true,
      ...(profile.tls.ca ? { ca: profile.tls.ca } : {}),
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

function postgresLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

const guardedIdlePools = new WeakSet<PostgresPool>();

function guardIdlePoolErrors(pool: PostgresPool): void {
  if (!pool.on || guardedIdlePools.has(pool)) return;
  pool.on("error", (error) => {
    // node-postgres emits failures from idle clients on the pool. Queries still reject and drive
    // degraded state; consuming this event prevents a database partition from terminating serve.
    // Do not log the error object because the driver attaches credential-bearing client state.
    void error;
  });
  guardedIdlePools.add(pool);
}

function unavailablePostgresPool(
  credential: "runtime" | "migrator",
  processRole: "online" | "migrator" | "maintenance",
): PostgresPool {
  const unavailable = () => {
    throw new Error(`Postgres ${credential} credential is unavailable in a ${processRole} process`);
  };
  return {
    connect: unavailable,
    query: unavailable,
    async end() {},
  };
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
