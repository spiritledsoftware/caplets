import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { CapletsError } from "../errors";
import { capletsSchema as postgresCapletsSchema } from "./schema/postgres";
import { capletsSchema as sqliteCapletsSchema } from "./schema/sqlite";
import { HOST_STORAGE_SCHEMA_VERSION, type HostDatabase, type HostStorageHealth } from "./types";

const SQLITE_MIGRATIONS_FOLDER = fileURLToPath(new URL("./drizzle/sqlite", import.meta.url));
const POSTGRES_MIGRATIONS_FOLDER = fileURLToPath(new URL("./drizzle/postgres", import.meta.url));

export async function migrateHostDatabase(database: HostDatabase): Promise<void> {
  const appliedAt = new Date().toISOString();
  if (database.dialect === "sqlite") {
    migrateSqliteExclusively(database, appliedAt);
    return;
  }

  assertSchemaIsNotNewer(await inspectHostDatabase(database));
  await migratePostgres(database.db, {
    migrationsFolder: POSTGRES_MIGRATIONS_FOLDER,
    migrationsTable: "caplets_migrations",
    migrationsSchema: database.schema,
  });
  await database.db
    .insert(postgresCapletsSchema)
    .values({ singleton: 1, version: HOST_STORAGE_SCHEMA_VERSION, appliedAt })
    .onConflictDoUpdate({
      target: postgresCapletsSchema.singleton,
      set: { version: HOST_STORAGE_SCHEMA_VERSION, appliedAt },
    });
}

function migrateSqliteExclusively(
  database: Extract<HostDatabase, { dialect: "sqlite" }>,
  appliedAt: string,
): void {
  type AppliedMigration = {
    hash: string;
    created_at: number;
  };
  type Statement = {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
  type Client = {
    exec(source: string): void;
    prepare(source: string): Statement;
    transaction<T>(run: () => T): { exclusive(): T };
  };
  const client = (database.db as typeof database.db & { $client: Client }).$client;
  const migrations = readMigrationFiles({ migrationsFolder: SQLITE_MIGRATIONS_FOLDER });
  client
    .transaction(() => {
      const schemaTable = client
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'caplets_schema'",
        )
        .get() as { present?: number } | undefined;
      if (schemaTable?.present === 1) {
        const row = client
          .prepare("SELECT version FROM caplets_schema WHERE singleton = 1")
          .get() as { version?: number } | undefined;
        if (row?.version !== undefined && row.version > HOST_STORAGE_SCHEMA_VERSION) {
          throw schemaNewerError(row.version);
        }
      }
      client.exec(
        "CREATE TABLE IF NOT EXISTS caplets_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric NOT NULL)",
      );
      const appliedMigrations = client
        .prepare("SELECT hash, created_at FROM caplets_migrations ORDER BY created_at")
        .all() as AppliedMigration[];
      const appliedByCreatedAt = new Map<number, string>();
      for (const migration of appliedMigrations) {
        if (
          typeof migration.hash !== "string" ||
          typeof migration.created_at !== "number" ||
          appliedByCreatedAt.has(migration.created_at)
        ) {
          throw invalidSqliteMigrationHistory("contains malformed or duplicate entries");
        }
        appliedByCreatedAt.set(migration.created_at, migration.hash);
      }
      const latestApplied = appliedMigrations.at(-1)?.created_at;
      for (const migration of migrations) {
        const appliedHash = appliedByCreatedAt.get(migration.folderMillis);
        if (appliedHash !== undefined) {
          if (appliedHash !== migration.hash) {
            throw invalidSqliteMigrationHistory(
              `hash mismatch for migration ${migration.folderMillis}`,
            );
          }
          continue;
        }
        if (latestApplied !== undefined && migration.folderMillis < latestApplied) {
          throw invalidSqliteMigrationHistory(
            `migration ${migration.folderMillis} is missing before ${latestApplied}`,
          );
        }
        for (const statement of migration.sql) client.exec(statement);
        client
          .prepare("INSERT INTO caplets_migrations (hash, created_at) VALUES (?, ?)")
          .run(migration.hash, migration.folderMillis);
      }
      client
        .prepare(
          "INSERT INTO caplets_schema (singleton, version, applied_at) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at",
        )
        .run(HOST_STORAGE_SCHEMA_VERSION, appliedAt);
    })
    .exclusive();
}

export async function inspectHostDatabase(database: HostDatabase): Promise<HostStorageHealth> {
  try {
    const version =
      database.dialect === "sqlite"
        ? database.db
            .select({ version: sqliteCapletsSchema.version })
            .from(sqliteCapletsSchema)
            .where(eq(sqliteCapletsSchema.singleton, 1))
            .get()?.version
        : (
            await database.db
              .select({ version: postgresCapletsSchema.version })
              .from(postgresCapletsSchema)
              .where(eq(postgresCapletsSchema.singleton, 1))
              .limit(1)
          )[0]?.version;
    if (version === undefined) {
      return { backend: database.dialect, ready: false, reason: "schema_missing" };
    }
    if (version < HOST_STORAGE_SCHEMA_VERSION) {
      return {
        backend: database.dialect,
        ready: false,
        schemaVersion: version,
        reason: "schema_outdated",
      };
    }
    if (version > HOST_STORAGE_SCHEMA_VERSION) {
      return {
        backend: database.dialect,
        ready: false,
        schemaVersion: version,
        reason: "schema_newer",
      };
    }
    return { backend: database.dialect, ready: true, schemaVersion: version };
  } catch (error) {
    return {
      backend: database.dialect,
      ready: false,
      reason:
        database.dialect === "postgres" && errorCode(error) === "42P01"
          ? "schema_missing"
          : "database_unavailable",
    };
  }
}

function assertSchemaIsNotNewer(health: HostStorageHealth): void {
  if (health.reason !== "schema_newer") return;
  throw schemaNewerError(health.schemaVersion);
}

function schemaNewerError(version: number | undefined): CapletsError {
  return new CapletsError(
    "CONFIG_INVALID",
    `Host storage schema ${version} is newer than supported schema ${HOST_STORAGE_SCHEMA_VERSION}.`,
  );
}

function invalidSqliteMigrationHistory(reason: string): CapletsError {
  return new CapletsError("CONFIG_INVALID", `SQLite migration history ${reason}.`);
}

function errorCode(error: unknown): string | undefined {
  let current = error;
  while (current && typeof current === "object") {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}
