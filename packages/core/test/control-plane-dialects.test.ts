import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createArtifactProviderIdentity } from "../src/control-plane/artifacts/provider";
import {
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
    hostAdministrator: false,
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
    await dialect.close();
    expect([runtime.ends, migrator.ends, maintenance.ends]).toEqual([1, 1, 1]);
  });

  it("rejects role membership, shared pools, and non-verify-full profiles", async () => {
    const registry = await loadMigrationRegistry({ dialect: "postgres", assetRoot });
    const runtime = new RolePool("caplets_runtime", 1);
    await expect(
      attachVerifiedPostgresPools({
        storage: postgresStorage(),
        pools: { runtime, migrator: new RolePool("caplets_migrator") },
        roles: { runtime: "caplets_runtime", migrator: "caplets_migrator" },
        registry,
        environment: environment(),
      }),
    ).rejects.toThrow(/can SET ROLE/u);

    const shared = new RolePool("caplets_runtime");
    await expect(
      attachVerifiedPostgresPools({
        storage: postgresStorage(),
        pools: { runtime: shared, migrator: shared },
        roles: { runtime: "caplets_runtime", migrator: "caplets_migrator" },
        registry,
        environment: environment(),
      }),
    ).rejects.toThrow(/must be separate/u);

    await expect(
      openPostgresControlPlaneDialect({
        storage: postgresStorage(),
        runtime: {
          role: "caplets_runtime",
          connectionString: "postgres://caplets_runtime:secret@db.example/caplets?sslmode=require",
          tls: { mode: "verify-full", servername: "db.example", ca: "certificate" },
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
    ).rejects.toThrow(/sslmode=verify-full/u);
  });
});

class RolePool implements PostgresPool {
  readonly queries: string[] = [];
  ends = 0;

  constructor(
    private readonly role: string,
    private readonly memberships = 0,
  ) {}

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

  private async runQuery(
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
    return { rows: [], rowCount: 0 };
  }
}
