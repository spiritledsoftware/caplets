import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type Client, type Transaction } from "@libsql/client";
import { drizzle as drizzleSqlite } from "drizzle-orm/libsql";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { defaultStateBaseDir } from "../config/paths";
import { CapletsError } from "../errors";
import { ensureVaultKey, loadVaultKey } from "../vault/keys";
import { createAssetObjectStore, type AssetObjectStore } from "./asset-store";
import { CapletRecordStore, type AssetGarbageCollectionResult } from "./caplet-records";
import { CapletInstallationStore } from "./installations";
import { HostCoordinationStore } from "./coordination";
import { VaultGrantStore } from "./vault-grants";
import { BackendAuthStateStore } from "./backend-auth";
import { BackendAuthFlowRepository } from "./backend-auth-flows";
import { DashboardSessionRepository } from "./dashboard-sessions";
import { ProjectBindingStore } from "./project-bindings";
import { RemoteSecurityStore } from "./remote-security";
import { SetupStateStore } from "./setup-state";
import { OperatorActivityStore } from "./operator-activity";
import { VaultValueStore } from "./vault-values";
import { VaultStateStore } from "./vault-state";
import { IdempotencyStore, type IdempotencyStoreOptions } from "./idempotency";
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
const SQLITE_BUSY_RETRY_DELAYS_MS = [50, 100] as const;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_OPERATION_QUEUES = new Map<string, SqliteOperationQueue>();

export type HostStorageOptions = {
  vaultRoot?: string | undefined;
  idempotency?: IdempotencyStoreOptions | undefined;
  env?: Record<string, string | undefined> | undefined;
};

export class HostStorage {
  readonly backend: HostStorageConfig["type"];
  readonly caplets: CapletRecordStore;
  readonly installations: CapletInstallationStore;
  readonly coordination: HostCoordinationStore;
  readonly vaultGrants: VaultGrantStore;
  readonly backendAuth: BackendAuthStateStore;
  readonly backendAuthFlows: BackendAuthFlowRepository;
  readonly dashboardSessions: DashboardSessionRepository;
  readonly projectBindings: ProjectBindingStore;
  readonly remoteSecurity: RemoteSecurityStore;
  readonly setupState: SetupStateStore;
  readonly operatorActivity: OperatorActivityStore;
  readonly vaultValues: VaultValueStore;
  readonly vaultState: VaultStateStore;
  readonly idempotency: IdempotencyStore;
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
    const vaultOptions = {
      ...(options.vaultRoot === undefined ? {} : { root: options.vaultRoot }),
      ...(options.env === undefined ? {} : { env: options.env }),
    };
    this.backendAuthFlows = new BackendAuthFlowRepository(database, vaultOptions);
    this.dashboardSessions = new DashboardSessionRepository(database);
    this.projectBindings = new ProjectBindingStore(database);
    this.remoteSecurity = new RemoteSecurityStore(database);
    this.setupState = new SetupStateStore(database);
    this.operatorActivity = new OperatorActivityStore(database);
    this.vaultValues = new VaultValueStore(database, vaultOptions);
    this.vaultState = new VaultStateStore(database, vaultOptions);
    const responseEncryptionKey = (create: boolean): Buffer => {
      assertSharedPostgresEncryptionKeySource(database, this.vaultValues.env);
      const input = { keyFile: this.vaultValues.keyFile, env: this.vaultValues.env };
      return create ? ensureVaultKey(input) : loadVaultKey(input);
    };
    this.idempotency = new IdempotencyStore(
      database,
      (canonicalRequest) => {
        assertSharedPostgresEncryptionKeySource(database, this.vaultValues.env);
        return this.vaultValues.idempotencyRequestFingerprint(canonicalRequest);
      },
      responseEncryptionKey,
      options.idempotency,
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
  if (config.type === "sqlite") return await openMigratedSqliteStorage(config, options);

  const storage = openPostgresStorage(config, options);
  try {
    const health = await storage.health();
    if (!health.ready) throw schemaHealthError(health);
    return storage;
  } catch (error) {
    await storage.close().catch(() => undefined);
    throw error;
  }
}

export async function migrateHostStorage(config: HostStorageConfig): Promise<void> {
  if (config.type === "sqlite") {
    const storage = await openMigratedSqliteStorage(config);
    await storage.close();
    return;
  }

  const schema = validatedPostgresSchema(config);
  const migrator = new Pool({ connectionString: config.connectionString });
  try {
    await migrator.query(`create schema if not exists "${schema}"`);
  } finally {
    await migrator.end();
  }

  const storage = openPostgresStorage(config, {});
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

async function openMigratedSqliteStorage(
  config: SqliteHostStorageConfig,
  options: HostStorageOptions = {},
): Promise<HostStorage> {
  return await retrySqliteBusy(async () => {
    const storage = await openSqliteStorage(config, options);
    try {
      await migrateHostDatabase(storage.database);
      return storage;
    } catch (error) {
      await storage.close().catch(() => undefined);
      throw error;
    }
  });
}

async function retrySqliteBusy<T>(operation: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      const retryDelayMs = SQLITE_BUSY_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs === undefined || !isSqliteBusy(error)) throw error;
      attempt += 1;
      await delay(retryDelayMs);
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "SQLITE_BUSY";
}

async function openSqliteStorage(
  config: SqliteHostStorageConfig,
  options: HostStorageOptions,
): Promise<HostStorage> {
  const configuredPath = config.path ?? defaultSqliteStoragePath();
  const ephemeralRoot =
    configuredPath === ":memory:" ? mkdtempSync(join(tmpdir(), "caplets-sqlite-")) : undefined;
  const path = ephemeralRoot ? join(ephemeralRoot, "host.sqlite3") : resolve(configuredPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const operationQueue = sqliteOperationQueue(path);
  const rawClient = createClient({
    url: pathToFileURL(path).href,
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });
  const client = serializeSqliteClient(rawClient, operationQueue);
  try {
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA synchronous = FULL");
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
    const db = drizzleSqlite(client, { schema: sqliteSchema });
    return new HostStorage(
      { dialect: "sqlite", db },
      async () => {
        await operationQueue.drain();
        rawClient.close();
        if (ephemeralRoot) rmSync(ephemeralRoot, { recursive: true, force: true });
      },
      config,
      options,
    );
  } catch (error) {
    try {
      await operationQueue.drain();
      rawClient.close();
    } catch {
      // Preserve the startup error.
    }
    if (ephemeralRoot) rmSync(ephemeralRoot, { recursive: true, force: true });
    throw error;
  }
}

class SqliteOperationQueue {
  private tail = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async acquire(): Promise<() => void> {
    const previous = this.tail;
    let releaseCurrent = (): void => {};
    this.tail = new Promise<void>((resolveCurrent) => {
      releaseCurrent = resolveCurrent;
    });
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
    };
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}

function sqliteOperationQueue(path: string): SqliteOperationQueue {
  const existing = SQLITE_OPERATION_QUEUES.get(path);
  if (existing) return existing;
  const queue = new SqliteOperationQueue();
  SQLITE_OPERATION_QUEUES.set(path, queue);
  return queue;
}

function serializeSqliteClient(client: Client, queue: SqliteOperationQueue): Client {
  const serializedMethods = new Set(["batch", "execute", "executeMultiple", "migrate", "sync"]);
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return async (...args: Parameters<Client["transaction"]>) => {
          const release = await queue.acquire();
          try {
            return serializeSqliteTransaction(await target.transaction(...args), release);
          } catch (error) {
            release();
            throw error;
          }
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      if (
        typeof property === "string" &&
        serializedMethods.has(property) &&
        typeof value === "function"
      ) {
        return (...args: unknown[]) =>
          queue.run(async () => await Reflect.apply(value, target, args));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function serializeSqliteTransaction(transaction: Transaction, release: () => void): Transaction {
  return new Proxy(transaction, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if ((property === "commit" || property === "rollback") && typeof value === "function") {
        return async (...args: unknown[]) => {
          try {
            return await Reflect.apply(value, target, args);
          } finally {
            release();
          }
        };
      }
      if (property === "close" && typeof value === "function") {
        return (...args: unknown[]) => {
          try {
            return Reflect.apply(value, target, args);
          } finally {
            release();
          }
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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

function assertSharedPostgresEncryptionKeySource(
  database: HostDatabase,
  env: Record<string, string | undefined>,
): void {
  if (
    database.dialect === "postgres" &&
    env.CAPLETS_ENCRYPTION_KEY === undefined &&
    env.CAPLETS_ENCRYPTION_KEY_FILE === undefined
  ) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "PostgreSQL Host Storage requires CAPLETS_ENCRYPTION_KEY or CAPLETS_ENCRYPTION_KEY_FILE.",
    );
  }
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
