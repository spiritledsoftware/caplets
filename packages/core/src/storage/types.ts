import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { HostStorageConfig } from "../config";
import type { postgresSchema } from "./schema/postgres";
import type { sqliteSchema } from "./schema/sqlite";

export const HOST_STORAGE_SCHEMA_VERSION = 18;

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
    | "current_record_assets_unavailable"
    | undefined;
  assets?:
    | {
        backend: "sql" | "s3";
        ready: boolean;
        affectedRecordIds?: string[] | undefined;
      }
    | undefined;
};

export type SqliteHostDatabase = LibSQLDatabase<typeof sqliteSchema>;
export type PostgresHostDatabase = NodePgDatabase<typeof postgresSchema>;
export type SqliteHostTransaction = Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0];
export type PostgresHostTransaction = Parameters<
  Parameters<PostgresHostDatabase["transaction"]>[0]
>[0];

export type HostDatabaseTransaction =
  | { dialect: "sqlite"; db: SqliteHostTransaction }
  | { dialect: "postgres"; db: PostgresHostTransaction };

export type HostDatabase =
  | { dialect: "sqlite"; db: SqliteHostDatabase }
  | { dialect: "postgres"; db: PostgresHostDatabase; schema: string };
