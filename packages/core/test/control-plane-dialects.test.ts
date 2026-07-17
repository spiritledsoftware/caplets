import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createArtifactProviderIdentity } from "../src/control-plane/artifacts/provider";
import {
  assertFinalizedPostgresInitialization,
  attachVerifiedPostgresPools,
  openPostgresControlPlaneDialect,
  type PostgresClient,
  type PostgresPool,
  type PostgresQueryResult,
} from "../src/control-plane/dialect/postgres";
import {
  loadMigrationRegistry,
  type MigrationEnvironment,
} from "../src/control-plane/dialect/migrations";
import type { ResolvedPostgresStorage } from "../src/control-plane/storage-config";
import {
  assertSafeSqlIdentifier,
  decodeCanonicalBytes,
  decodeCanonicalJson,
  decodeCanonicalTimestamp,
  decodeCanonicalVersion,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  encodeCanonicalTimestamp,
  encodeCanonicalVersion,
  fixedPostgresSearchPath,
} from "../src/control-plane/schema/model-codec";

const assetRoot = resolve(import.meta.dirname, "..", "drizzle");
const logicalHostId = "host_01J00000000000000000000000";
const storeId = "store_01J00000000000000000000000";

function environment(): MigrationEnvironment {
  return {
    binaryVersion: "0.34.1",
    supportedSchemaVersion: 1,
    keyVersion: 1,
    manifestVersion: 1,
    verifiedSchemaAwareBackup: true,
    oldNodesDrained: true,
    retainedKeyVersions: [1],
    hostAdministrator: true,
  };
}

function postgresStorage(): ResolvedPostgresStorage {
  return {
    backend: "postgres",
    logicalHostId,
    storeId,
    operationNamespace: "namespace_01J00000000000000000000",
    stateRoot: "/tmp/caplets-control-plane-postgres",
    keyProviderManifest: "/tmp/caplets-control-plane-postgres/key-provider.json",
    artifacts: {
      kind: "s3",
      identity: createArtifactProviderIdentity({
        kind: "s3",
        provider: "https://objects.invalid/caplets",
        namespace: "control-plane-test",
        logicalHostId,
        storeId,
      }),
    },
  };
}

describe("canonical SQL codecs", () => {
  it("round-trips canonical JSON and bytes without representation ambiguity", () => {
    const json = { z: [true, null, 3], a: { second: "two", first: "one" } };
    const encoded = encodeCanonicalJson(json);
    expect(encoded).toBe('{"a":{"first":"one","second":"two"},"z":[true,null,3]}');
    expect(decodeCanonicalJson(encoded)).toEqual(json);
    expect(() => decodeCanonicalJson('{"z":1,"a":2}')).toThrow(/not canonically encoded/u);
    expect(() => encodeCanonicalJson({ unsafe: undefined })).toThrow(/undefined/u);
    expect(() => encodeCanonicalJson({ unsafe: Number.NaN })).toThrow(/not finite/u);

    const source = new Uint8Array([0, 127, 255]);
    const stored = encodeCanonicalBytes(source);
    const decoded = decodeCanonicalBytes(stored);
    expect([...decoded]).toEqual([0, 127, 255]);
    source[0] = 42;
    expect([...decoded]).toEqual([0, 127, 255]);
    expect(() => encodeCanonicalBytes(new Uint8Array())).toThrow(/non-empty/u);
  });

  it("enforces canonical clocks, safe versions, identifiers, and fixed search paths", () => {
    expect(encodeCanonicalTimestamp("2026-07-14T01:02:03.004Z")).toBe("2026-07-14T01:02:03.004Z");
    expect(decodeCanonicalTimestamp("2026-07-14T01:02:03.004Z")).toBe("2026-07-14T01:02:03.004Z");
    expect(() => encodeCanonicalTimestamp("2026-07-14T01:02:03Z")).toThrow(/ISO UTC/u);
    expect(encodeCanonicalVersion(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(decodeCanonicalVersion(12n)).toBe(12);
    expect(() => decodeCanonicalVersion(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(
      /safe integer/u,
    );
    expect(assertSafeSqlIdentifier("caplets_runtime")).toBe("caplets_runtime");
    expect(fixedPostgresSearchPath("caplets")).toBe('"caplets", pg_catalog');
    for (const unsafe of [
      "caplets,public",
      "caplets;DROP SCHEMA public",
      'caplets"',
      "pg_catalog",
      "Public",
      "",
    ]) {
      expect(() => assertSafeSqlIdentifier(unsafe)).toThrow(/unsafe/u);
    }
  });
});

describe("Postgres pool and role boundaries", () => {
  it("requires separate NOINHERIT/no-membership roles and fixes every search path", async () => {
    const registry = await loadMigrationRegistry({ dialect: "postgres", assetRoot });
    const runtime = new RolePool("caplets_runtime");
    const migrator = new RolePool("caplets_migrator");
    const maintenance = new RolePool("caplets_maintenance");
    const dialect = await attachVerifiedPostgresPools({
      storage: postgresStorage(),
      pools: { runtime, migrator, maintenance },
      roles: {
        runtime: "caplets_runtime",
        migrator: "caplets_migrator",
        maintenance: "caplets_maintenance",
      },
      registry,
      environment: environment(),
    });
    expect(dialect.ready).toBe(false);
    await expect(dialect.query("SELECT 1")).rejects.toThrow(/not migration-ready/u);
    expect(runtime.queries).toContain("SHOW search_path");
    expect(migrator.queries).toContain("SHOW search_path");
    expect(maintenance.queries).toContain("SHOW search_path");
    await expect(dialect.migrate()).resolves.toHaveLength(9);
    const maintenanceGrants = migrator.queries.filter(
      (query) => query.startsWith("GRANT ") && query.includes('TO "caplets_maintenance"'),
    );
    expect(maintenanceGrants.join("\n")).toContain("__caplets_storage_identity_v1");
    expect(maintenanceGrants.join("\n")).toContain("__caplets_migration_history_v1");
    expect(maintenanceGrants.join("\n")).toContain("cp_operation_namespace");
    expect(maintenanceGrants.join("\n")).toContain("cp_cluster_node_lease");
    expect(maintenanceGrants.join("\n")).toContain("cp_writer_fence");
    expect(maintenanceGrants.join("\n")).toContain("cp_migration");
    expect(maintenanceGrants.join("\n")).not.toContain("cp_caplet");
    expect(maintenanceGrants.join("\n")).not.toContain("cp_vault_value");
    const runtimeGrants = migrator.queries.filter(
      (query) => query.startsWith("GRANT ") && query.includes('TO "caplets_runtime"'),
    );
    expect(runtimeGrants.join("\n")).toContain("__caplets_storage_identity_v1");
    expect(runtimeGrants.join("\n")).toContain("__caplets_migration_history_v1");
    expect(runtimeGrants.join("\n")).toContain("cp_caplet");
    const runtimeMutationGrant = runtimeGrants.find((query) =>
      query.startsWith("GRANT INSERT, UPDATE, DELETE"),
    );
    expect(runtimeMutationGrant).toContain("cp_caplet");
    expect(runtimeMutationGrant).not.toContain("cp_migration");
    expect(runtimeMutationGrant).not.toContain("cp_backup");
    expect(runtimeGrants).toContain(
      'GRANT INSERT, UPDATE ON "caplets"."cp_migration" TO "caplets_runtime"',
    );
    expect(
      migrator.queries.some(
        (query) =>
          query.includes("cp_migration_destination_contains_authoritative_rows") &&
          query.includes("SECURITY DEFINER"),
      ),
    ).toBe(true);
    expect(
      migrator.queries.some(
        (query) =>
          query.startsWith("REVOKE ALL ON FUNCTION") &&
          query.includes("cp_migration_destination_contains_authoritative_rows"),
      ),
    ).toBe(true);
    await dialect.close();
    expect([runtime.ends, migrator.ends, maintenance.ends]).toEqual([1, 1, 1]);
  });

  it("persists and exactly releases the Postgres migration drain gate", async () => {
    const registry = await loadMigrationRegistry({ dialect: "postgres", assetRoot });
    const runtime = new RolePool("caplets_runtime");
    const migrator = new MigrationDrainRolePool("caplets_migrator");
    const maintenance = new RolePool("caplets_maintenance");
    const dialect = await attachVerifiedPostgresPools({
      storage: postgresStorage(),
      pools: { runtime, migrator, maintenance },
      roles: {
        runtime: "caplets_runtime",
        migrator: "caplets_migrator",
        maintenance: "caplets_maintenance",
      },
      registry,
      environment: environment(),
    });
    const original = migrator.compatibility;

    await expect(dialect.beginMigrationDrain("gate-1")).resolves.toEqual({
      gateId: "gate-1",
      status: "active",
    });
    expect(JSON.parse(migrator.compatibility)).toMatchObject({
      migrationDrain: { gateId: "gate-1", previousCompatibility: original },
    });
    expect(
      migrator.queries.some(
        (query) =>
          query.includes("CREATE TRIGGER") && query.includes("cp_migration_drain_node_lease"),
      ),
    ).toBe(true);

    await dialect.releaseMigrationDrain("gate-1", "rolled-back");
    expect(migrator.compatibility).toBe(original);
    await dialect.close();
  });

  it("adopts a finalized legacy U7 initialization and rejects an empty destination", () => {
    expect(
      assertFinalizedPostgresInitialization({
        rows: [
          {
            migration_id: "legacy-v1",
            state_document: {
              kind: "legacy-initialization",
              step: "finalized",
              metadata: { kind: "legacy" },
            },
          },
        ],
        rowCount: 1,
      }),
    ).toBe("legacy");
    expect(() => assertFinalizedPostgresInitialization({ rows: [], rowCount: 0 })).toThrow(
      /requires one finalized U7 initialization/u,
    );
  });

  it("accepts explicitly configured TLS and rejects plaintext connection profiles", async () => {
    await expect(
      openPostgresControlPlaneDialect({
        storage: postgresStorage(),
        runtime: {
          role: "caplets_runtime",
          connectionString: "postgres://caplets_runtime:secret@db.example/caplets?sslmode=disable",
          tls: { mode: "verify-full", servername: "db.example", ca: "" },
        },
        migrator: {
          role: "caplets_migrator",
          connectionString:
            "postgres://caplets_migrator:secret@db.example/caplets?sslmode=verify-full",
          tls: { mode: "verify-full", servername: "db.example", ca: "certificate" },
        },
        environment: environment(),
        assetRoot,
      }),
    ).rejects.toThrow(/connection string is invalid/u);

    await expect(
      openPostgresControlPlaneDialect({
        storage: postgresStorage(),
        runtime: {
          role: "caplets_runtime",
          connectionString: "postgres://caplets_runtime:secret@db.example/caplets",
          tls: { mode: "verify-full", servername: "db.example", ca: "" },
        },
        migrator: {
          role: "caplets_migrator",
          connectionString:
            "postgres://caplets_migrator:secret@db.example/caplets?sslmode=verify-full",
          tls: { mode: "verify-full", servername: "db.example", ca: "certificate" },
        },
        environment: environment(),
        assetRoot,
      }),
    ).rejects.toThrow(/connection string is invalid/u);
  });

  it("contains LISTEN client failure so tuple polling remains authoritative", async () => {
    const registry = await loadMigrationRegistry({ dialect: "postgres", assetRoot });
    const runtime = new EventedRolePool("caplets_runtime");
    const dialect = await attachVerifiedPostgresPools({
      storage: postgresStorage(),
      pools: { runtime, migrator: new RolePool("caplets_migrator") },
      roles: { runtime: "caplets_runtime", migrator: "caplets_migrator" },
      registry,
      environment: environment(),
    });
    await dialect.migrate();
    const unsubscribe = await dialect.subscribeToChanges!(() => undefined);

    expect(() => runtime.listenerClient!.emit("error", new Error("connection lost"))).not.toThrow();
    await Promise.resolve();
    expect(runtime.listenerClient!.released).toBe(true);
    expect(runtime.listenerClient!.releaseError).toEqual(new Error("connection lost"));
    expect(() =>
      runtime.listenerClient!.emit("error", new Error("follow-up failure")),
    ).not.toThrow();
    await expect(unsubscribe()).resolves.toBeUndefined();
    await dialect.close();
  });

  it("treats malformed and out-of-order NOTIFY payloads only as tuple reread wakeups", async () => {
    const registry = await loadMigrationRegistry({ dialect: "postgres", assetRoot });
    const runtime = new EventedRolePool("caplets_runtime");
    const dialect = await attachVerifiedPostgresPools({
      storage: postgresStorage(),
      pools: { runtime, migrator: new RolePool("caplets_migrator") },
      roles: { runtime: "caplets_runtime", migrator: "caplets_migrator" },
      registry,
      environment: environment(),
    });
    await dialect.migrate();
    const received: unknown[] = [];
    const unsubscribe = await dialect.subscribeToChanges!((token) => received.push(token));

    runtime.listenerClient!.emit("notification", {
      channel: "caplets_control_plane_change",
      payload: JSON.stringify({
        authorityGeneration: 99,
        effectiveGeneration: 1,
        securityEpoch: 0,
      }),
    });
    runtime.listenerClient!.emit("notification", {
      channel: "caplets_control_plane_change",
      payload: "{malformed",
    });
    runtime.listenerClient!.emit("notification", {
      channel: "unrelated",
      payload: JSON.stringify({
        authorityGeneration: 100,
        effectiveGeneration: 100,
        securityEpoch: 100,
      }),
    });

    expect(received).toEqual([undefined, undefined]);
    await unsubscribe();
    await dialect.close();
  });

  it("elects one nonblocking advisory-lock winner under concurrent sweep attempts", async () => {
    const registry = await loadMigrationRegistry({ dialect: "postgres", assetRoot });
    const runtime = new ElectionRolePool("caplets_runtime");
    const dialect = await attachVerifiedPostgresPools({
      storage: postgresStorage(),
      pools: { runtime, migrator: new RolePool("caplets_migrator") },
      roles: { runtime: "caplets_runtime", migrator: "caplets_migrator" },
      registry,
      environment: environment(),
    });
    await dialect.migrate();

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        dialect.runtimeTransaction((transaction) =>
          transaction.tryLock!("overdue-sweep:host:store"),
        ),
      ),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(runtime.electionAttempts).toBe(8);
    await dialect.close();
  });

  it("contains idle pool failures so a database partition cannot terminate serve", async () => {
    const registry = await loadMigrationRegistry({ dialect: "postgres", assetRoot });
    const runtime = new RolePool("caplets_runtime");
    const dialect = await attachVerifiedPostgresPools({
      storage: postgresStorage(),
      pools: { runtime, migrator: new RolePool("caplets_migrator") },
      roles: { runtime: "caplets_runtime", migrator: "caplets_migrator" },
      registry,
      environment: environment(),
    });
    await dialect.migrate();

    expect(runtime.listenerCount("error")).toBe(1);
    expect(() => runtime.emit("error", new Error("database partition"))).not.toThrow();
    await dialect.close();
    expect(() => runtime.emit("error", new Error("late socket failure"))).not.toThrow();
  });

  it("bounds unavailable runtime transactions and discards the timed-out client", async () => {
    const registry = await loadMigrationRegistry({ dialect: "postgres", assetRoot });
    const runtime = new TimeoutRolePool("caplets_runtime");
    const dialect = await attachVerifiedPostgresPools({
      storage: postgresStorage(),
      pools: { runtime, migrator: new RolePool("caplets_migrator") },
      roles: { runtime: "caplets_runtime", migrator: "caplets_migrator" },
      registry,
      environment: environment(),
    });
    await dialect.migrate();

    await expect(dialect.runtimeTransaction(async () => undefined)).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
    expect(runtime.transactionClient?.releaseError).toEqual(new Error("Query read timeout"));
    await dialect.close();
  });
});

class EventedClient extends EventEmitter implements PostgresClient {
  released = false;
  releaseError: Error | undefined;

  constructor(
    private readonly run: (
      sql: string,
      parameters?: readonly unknown[],
    ) => Promise<PostgresQueryResult>,
  ) {
    super();
  }

  query(sql: string, parameters?: readonly unknown[]): Promise<PostgresQueryResult> {
    return this.run(sql, parameters);
  }

  release(error?: Error): void {
    this.released = true;
    this.releaseError = error;
  }
}

class RolePool extends EventEmitter implements PostgresPool {
  readonly queries: string[] = [];
  ends = 0;

  constructor(
    protected readonly role: string,
    private readonly memberships = 0,
  ) {
    super();
  }

  async connect(): Promise<PostgresClient> {
    return {
      query: (sql, parameters) => this.runQuery(sql, parameters),
      release() {},
    };
  }

  async query(sql: string, parameters?: readonly unknown[]): Promise<PostgresQueryResult> {
    return this.runQuery(sql, parameters);
  }

  async end(): Promise<void> {
    this.ends += 1;
  }

  protected async runQuery(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<PostgresQueryResult> {
    this.queries.push(sql);
    if (sql.startsWith("SELECT set_config")) {
      return { rows: [{ set_config: parameters?.[0] }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT current_user")) {
      return {
        rows: [
          {
            current_user: this.role,
            session_user: this.role,
            rolsuper: false,
            rolinherit: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolcanlogin: true,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith("SELECT count(*)::int AS memberships")) {
      return { rows: [{ memberships: this.memberships }], rowCount: 1 };
    }
    if (sql === "SHOW search_path") {
      return { rows: [{ search_path: '"caplets", pg_catalog' }], rowCount: 1 };
    }
    if (sql.includes("__caplets_storage_identity_v1") && sql.startsWith("SELECT")) {
      return { rows: [{ logical_host_id: logicalHostId, store_id: storeId }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

class MigrationDrainRolePool extends RolePool {
  compatibility = JSON.stringify({
    generation: 1,
    currentFingerprint: "a".repeat(64),
  });

  protected override async runQuery(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<PostgresQueryResult> {
    if (sql.startsWith("SELECT to_regclass($1) AS activation")) {
      return {
        rows: [
          {
            activation: "cp_migration",
            leases: "cp_cluster_node_lease",
            fences: "cp_writer_fence",
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT compatibility") && sql.includes("cp_migration")) {
      return { rows: [{ compatibility: this.compatibility }], rowCount: 1 };
    }
    if (sql.includes("SELECT EXISTS") && sql.includes("cp_cluster_node_lease")) {
      return { rows: [{ active: false }], rowCount: 1 };
    }
    if (sql.includes('UPDATE "caplets"."cp_migration"')) {
      if (
        parameters?.length === 5 &&
        typeof parameters[4] === "string" &&
        parameters[4] !== this.compatibility
      ) {
        return { rows: [], rowCount: 0 };
      }
      const compatibility = parameters?.[0];
      if (typeof compatibility !== "string") {
        throw new Error("Migration drain compatibility was not encoded");
      }
      this.compatibility = compatibility;
      return { rows: [], rowCount: 1 };
    }
    return super.runQuery(sql, parameters);
  }
}

class EventedRolePool extends RolePool {
  listenerClient: EventedClient | undefined;
  private connections = 0;

  override async connect(): Promise<PostgresClient> {
    const client = new EventedClient((sql, parameters) => this.runQuery(sql, parameters));
    this.connections += 1;
    if (this.connections > 1) this.listenerClient = client;
    return client;
  }
}

class ElectionRolePool extends RolePool {
  electionAttempts = 0;

  override async connect(): Promise<PostgresClient> {
    return {
      query: (sql, parameters) => {
        const query: unknown = sql;
        if (typeof query === "string") return this.runQuery(query, parameters);
        if (
          query &&
          typeof query === "object" &&
          "text" in query &&
          typeof query.text === "string"
        ) {
          return this.runQuery(query.text, parameters);
        }
        throw new Error("Unexpected Postgres test query shape");
      },
      release() {},
    };
  }

  protected override async runQuery(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<PostgresQueryResult> {
    if (sql.includes("pg_try_advisory_xact_lock")) {
      this.electionAttempts += 1;
      return { rows: [{ acquired: this.electionAttempts === 1 }], rowCount: 1 };
    }
    return super.runQuery(sql, parameters);
  }
}

class TimeoutRolePool extends RolePool {
  transactionClient: EventedClient | undefined;

  override async connect(): Promise<PostgresClient> {
    const client = new EventedClient(async (sql, parameters) => {
      if (sql === "BEGIN") throw new Error("Query read timeout");
      return this.runQuery(sql, parameters);
    });
    this.transactionClient = client;
    return client;
  }
}
