import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { HostStorageConfig } from "../config";
import type { postgresSchema } from "./schema/postgres";
import type { sqliteSchema } from "./schema/sqlite";

export const HOST_STORAGE_SCHEMA_VERSION = 12;

export type SqliteHostStorageConfig = Extract<HostStorageConfig, { type: "sqlite" }>;
export type PostgresHostStorageConfig = Extract<HostStorageConfig, { type: "postgres" }>;
export type { HostStorageConfig };

export type HostStorageHealth = {
  backend: HostStorageConfig["type"];
  ready: boolean;
  schemaVersion?: number | undefined;
  reason?:
    | "database_unavailable"
    | "schema_missing"
    | "schema_outdated"
    | "schema_newer"
    | "object_store_unavailable"
    | undefined;
  assets?:
    | {
        backend: "sql" | "s3";
        ready: boolean;
      }
    | undefined;
};

export type SqliteHostDatabase = BetterSQLite3Database<typeof sqliteSchema>;
export type PostgresHostDatabase = NodePgDatabase<typeof postgresSchema>;

export type HostDatabase =
  | { dialect: "sqlite"; db: SqliteHostDatabase }
  | { dialect: "postgres"; db: PostgresHostDatabase; schema: string };
