import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { defaultStateBaseDir } from "../config/paths";
import { CapletsError } from "../errors";
import { createAssetObjectStore, type AssetObjectStore } from "./asset-store";
import { CapletRecordStore, type AssetGarbageCollectionResult } from "./caplet-records";
import { CapletInstallationStore } from "./installations";
import { HostCoordinationStore } from "./coordination";
import { VaultGrantStore } from "./vault-grants";
import { BackendAuthStateStore } from "./backend-auth";
import { DashboardSessionRepository } from "./dashboard-sessions";
import { ProjectBindingStore } from "./project-bindings";
import { RemoteSecurityStore } from "./remote-security";
import { SetupStateStore } from "./setup-state";
import { OperatorActivityStore } from "./operator-activity";
import { VaultValueStore } from "./vault-values";
import { inspectHostDatabase, migrateHostDatabase } from "./migrations";
import { postgresSchema } from "./schema/postgres";
import { sqliteSchema } from "./schema/sqlite";
import type {
  HostDatabase,
  HostStorageConfig,
  HostStorageHealth,
  PostgresHostStorageConfig,
  SqliteHostStorageConfig,
} from "./types";

const POSTGRES_SCHEMA_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/u;

export type HostStorageOptions = {
  vaultRoot?: string | undefined;
};

export class HostStorage {
  readonly backend: HostStorageConfig["type"];
  readonly caplets: CapletRecordStore;
  readonly installations: CapletInstallationStore;
  readonly coordination: HostCoordinationStore;
  readonly vaultGrants: VaultGrantStore;
  readonly backendAuth: BackendAuthStateStore;
  readonly dashboardSessions: DashboardSessionRepository;
  readonly projectBindings: ProjectBindingStore;
  readonly remoteSecurity: RemoteSecurityStore;
  readonly setupState: SetupStateStore;
  readonly operatorActivity: OperatorActivityStore;
  readonly vaultValues: VaultValueStore;
  private readonly assetObjectStore: AssetObjectStore | undefined;
  private closed = false;

  constructor(
    readonly database: HostDatabase,
    private readonly closeDatabase: () => Promise<void>,
    config: HostStorageConfig,
    options: HostStorageOptions = {},
    postgresListenerPool?: Pick<Pool, "connect"> | undefined,
  ) {
    this.backend = database.dialect;
    this.assetObjectStore = createAssetObjectStore(config.assets);
    this.caplets = new CapletRecordStore(database, {
      objectStore: this.assetObjectStore,
      limits: config.bundleLimits,
    });
    this.installations = new CapletInstallationStore(database);
    this.vaultGrants = new VaultGrantStore(database);
    this.coordination = new HostCoordinationStore(database, postgresListenerPool);
    this.backendAuth = new BackendAuthStateStore(database);
    this.dashboardSessions = new DashboardSessionRepository(database);
    this.projectBindings = new ProjectBindingStore(database);
    this.remoteSecurity = new RemoteSecurityStore(database);
    this.setupState = new SetupStateStore(database);
    this.operatorActivity = new OperatorActivityStore(database);
    this.vaultValues = new VaultValueStore(
      database,
      options.vaultRoot === undefined ? {} : { root: options.vaultRoot },
    );
  }

  async health(): Promise<HostStorageHealth> {
    const assetBackend = this.assetObjectStore ? "s3" : "sql";
    if (this.closed) {
      return {
        backend: this.backend,
        ready: false,
        reason: "database_unavailable",
        assets: { backend: assetBackend, ready: false },
      };
    }
    const databaseHealth = await inspectHostDatabase(this.database);
    if (!databaseHealth.ready) {
      return {
        ...databaseHealth,
        assets: { backend: assetBackend, ready: false },
      };
    }
    if (!this.assetObjectStore) {
      return {
        ...databaseHealth,
        ready: true,
        assets: { backend: "sql", ready: true },
      };
    }
    if (!(await this.assetObjectStore.health())) {
      return {
        ...databaseHealth,
        ready: false,
        reason: "object_store_unavailable",
        assets: { backend: "s3", ready: false },
      };
    }
    let currentAssets;
    try {
      currentAssets = await this.caplets.currentAssetHealth();
    } catch {
      return {
        ...databaseHealth,
        ready: false,
        reason: "database_unavailable",
        assets: { backend: "s3", ready: false },
      };
    }
    if (!currentAssets.ready) {
      return {
        ...databaseHealth,
        ready: false,
        reason: "current_record_assets_unavailable",
        assets: {
          backend: "s3",
          ready: false,
          affectedRecordIds: currentAssets.affectedRecordIds,
        },
      };
    }
    return {
      ...databaseHealth,
      ready: true,
      assets: { backend: "s3", ready: true },
    };
  }

  async maintainAssets(input: {
    ownerNodeId: string;
    graceMs: number;
    leaseTtlMs?: number | undefined;
    now?: Date | undefined;
  }): Promise<(AssetGarbageCollectionResult & { fencingToken: number }) | undefined> {
    const lease = await this.coordination.acquireLease({
      leaseName: "caplet-asset-cleanup",
      ownerNodeId: input.ownerNodeId,
      ttlMs: input.leaseTtlMs ?? 30_000,
      now: input.now,
    });
    if (!lease) return undefined;
    const result = await this.caplets.collectAssetGarbage({
      graceMs: input.graceMs,
      now: input.now,
    });
    await this.coordination.checkpointLease({
      leaseName: lease.leaseName,
      ownerNodeId: lease.ownerNodeId,
      fencingToken: lease.fencingToken,
      cursor: JSON.stringify(result),
      now: input.now,
    });
    return { ...result, fencingToken: lease.fencingToken };
  }

  async invalidateConfig(createdBy: string): Promise<number> {
    return await this.coordination.publishConfigGeneration(`mutation:${randomUUID()}`, createdBy);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.coordination.close();
    } finally {
      try {
        await this.closeDatabase();
      } finally {
        this.assetObjectStore?.close();
      }
    }
  }
}

export async function createHostStorage(
  config: HostStorageConfig = { type: "sqlite" },
  options: HostStorageOptions = {},
): Promise<HostStorage> {
  const storage = openHostStorage(config, options);
  try {
    if (config.type === "sqlite") {
      await migrateHostDatabase(storage.database);
    } else {
      const health = await storage.health();
      if (!health.ready) throw schemaHealthError(health);
    }
    return storage;
  } catch (error) {
    await storage.close().catch(() => undefined);
    throw error;
  }
}

export async function migrateHostStorage(config: HostStorageConfig): Promise<void> {
  if (config.type === "postgres") {
    const schema = validatedPostgresSchema(config);
    const migrator = new Pool({ connectionString: config.connectionString });
    try {
      await migrator.query(`create schema if not exists "${schema}"`);
    } finally {
      await migrator.end();
    }
  }

  const storage = openHostStorage(config);
  try {
    await migrateHostDatabase(storage.database);
  } finally {
    await storage.close();
  }
}

export function defaultSqliteStoragePath(
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
  platform?: NodeJS.Platform,
): string {
  return join(defaultStateBaseDir(env, home, platform), "caplets.sqlite3");
}

function openHostStorage(config: HostStorageConfig, options: HostStorageOptions = {}): HostStorage {
  if (config.type === "sqlite") return openSqliteStorage(config, options);
  return openPostgresStorage(config, options);
}

function openSqliteStorage(
  config: SqliteHostStorageConfig,
  options: HostStorageOptions,
): HostStorage {
  const path = config.path ?? defaultSqliteStoragePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const client = new BetterSqlite3(path);
  client.pragma("busy_timeout = 5000");
  client.pragma("foreign_keys = ON");
  client.pragma("journal_mode = WAL");
  client.pragma("synchronous = FULL");
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on platforms without POSIX permissions.
  }
  const db = drizzleSqlite(client, { schema: sqliteSchema });
  return new HostStorage(
    { dialect: "sqlite", db },
    async () => {
      client.close();
    },
    config,
    options,
  );
}

function openPostgresStorage(
  config: PostgresHostStorageConfig,
  options: HostStorageOptions,
): HostStorage {
  const schema = validatedPostgresSchema(config);
  const client = new Pool({
    connectionString: config.connectionString,
    options: `-c search_path=${schema}`,
  });
  const db = drizzlePostgres(client, { schema: postgresSchema });
  return new HostStorage(
    { dialect: "postgres", db, schema },
    async () => await client.end(),
    config,
    options,
    client,
  );
}

function validatedPostgresSchema(config: PostgresHostStorageConfig): string {
  const schema = config.schema ?? "caplets";
  if (!POSTGRES_SCHEMA_PATTERN.test(schema)) {
    throw new CapletsError("CONFIG_INVALID", `Invalid PostgreSQL schema name ${schema}.`);
  }
  if (!config.connectionString.trim()) {
    throw new CapletsError("CONFIG_INVALID", "PostgreSQL storage requires a connection string.");
  }
  return schema;
}

function schemaHealthError(health: HostStorageHealth): CapletsError {
  const detail =
    health.schemaVersion === undefined ? "" : ` Current version: ${health.schemaVersion}.`;
  if (health.reason === "database_unavailable") {
    return new CapletsError(
      "SERVER_UNAVAILABLE",
      "Authoritative PostgreSQL storage is unavailable.",
    );
  }
  return new CapletsError(
    "CONFIG_INVALID",
    `Authoritative PostgreSQL storage is not ready (${health.reason ?? "unknown"}).${detail}`,
  );
}
