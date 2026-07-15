import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createArtifactProviderIdentity } from "../src/control-plane/artifacts/provider";
import {
  attachVerifiedPostgresPools,
  type PostgresControlPlaneDialect,
  type PostgresPool,
} from "../src/control-plane/dialect/postgres";
import type {
  ResolvedPostgresStorage,
  ResolvedSqliteStorage,
} from "../src/control-plane/storage-config";
import {
  loadMigrationRegistry,
  type MigrationEnvironment,
} from "../src/control-plane/dialect/migrations";
import { openSqliteControlPlaneDialect } from "../src/control-plane/dialect/sqlite";
import { stableJsonStringify } from "../src/stable-json";
import { quoteSafeSqlIdentifier } from "../src/control-plane/schema/model-codec";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as new (path: string) => {
  prepare(sql: string): { get(...values: unknown[]): unknown; run(...values: unknown[]): unknown };
  close(): void;
};
const sourceAssetRoot = resolve(import.meta.dirname, "..", "drizzle");
const postgresAdminUrl = process.env.CAPLETS_TEST_POSTGRES_URL;
const logicalHostId = "host_01J00000000000000000000000";
const storeId = "store_01J00000000000000000000000";
const roots: string[] = [];
const mutableTestManifestSchema = z
  .object({
    sql: z.object({ file: z.string(), sha256: z.string() }).strict(),
    manifestSha256: z.string(),
  })
  .passthrough();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function migrationEnvironment(now = new Date("2026-07-14T00:00:00.000Z")): MigrationEnvironment {
  return {
    binaryVersion: "0.34.1",
    supportedSchemaVersion: 1,
    keyVersion: 1,
    manifestVersion: 1,
    verifiedSchemaAwareBackup: true,
    oldNodesDrained: true,
    retainedKeyVersions: [1],
    hostAdministrator: true,
    now,
  };
}

async function sqliteFixture(assetRoot = sourceAssetRoot) {
  const root = await mkdtemp(join(tmpdir(), "caplets-control-plane-migrations-"));
  roots.push(root);
  const databasePath = join(root, "control-plane.sqlite3");
  const storage: ResolvedSqliteStorage = {
    backend: "sqlite",
    logicalHostId,
    storeId,
    operationNamespace: "namespace_01J00000000000000000000",
    stateRoot: root,
    databasePath,
    keyProviderManifest: join(root, "key-provider.json"),
    artifacts: { kind: "filesystem", root: join(root, "artifacts") },
  };
  return { root, databasePath, storage, assetRoot };
}

async function copiedAssets() {
  const root = await mkdtemp(join(tmpdir(), "caplets-control-plane-assets-"));
  roots.push(root);
  await cp(sourceAssetRoot, root, { recursive: true });
  return root;
}

describe("control-plane migration registry and SQLite executor", () => {
  it("requires explicit host administration for the U6 contract migration", async () => {
    const fixture = await sqliteFixture();
    await expect(
      openSqliteControlPlaneDialect({
        storage: fixture.storage,
        environment: { ...migrationEnvironment(), hostAdministrator: false },
        assetRoot: fixture.assetRoot,
      }),
    ).rejects.toThrow(/0002_colorful_maverick requires host administration/u);
    await expect(
      openSqliteControlPlaneDialect({
        storage: fixture.storage,
        environment: { ...migrationEnvironment(), oldNodesDrained: false },
        assetRoot: fixture.assetRoot,
      }),
    ).rejects.toThrow(/0002_colorful_maverick requires old-node drain/u);
  });

  it("migrates fresh/current databases idempotently, excludes a second writer, and rolls back", async () => {
    const fixture = await sqliteFixture();
    const environment = migrationEnvironment();
    const dialect = await openSqliteControlPlaneDialect({
      storage: fixture.storage,
      environment,
      assetRoot: fixture.assetRoot,
    });
    expect(dialect.ready).toBe(false);
    expect(dialect.migrate()).toEqual([
      "0000_orange_tusk",
      "0001_conscious_wilson_fisk",
      "0002_colorful_maverick",
      "0003_lazy_terrax",
    ]);
    expect(dialect.ready).toBe(true);
    expect(dialect.migrate()).toEqual([]);
    const tables = dialect.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = ? AND name LIKE ? ORDER BY name",
      ["table", "cp_%"],
    );
    expect(tables).toHaveLength(41);
    expect(() =>
      dialect.execute(
        "INSERT INTO cp_host_setting (model_version,id,logical_host_id,store_id,created_at,updated_at,aggregate_version,authority_version,effective_version,security_version,key,value,ownership,activation,effective) VALUES (1,?,?,?,?,?,0,0,0,0,?,?,?,?,1)",
        [
          "setting-1",
          fixture.storage.logicalHostId,
          fixture.storage.storeId,
          "2026-07-14T00:00:00.000Z",
          "2026-07-14T00:00:00.000Z",
          "serve.storage",
          '{"source":"setup","url":"http://127.0.0.1:3100/"}',
          "sql",
          "active",
        ],
      ),
    ).toThrow(/constraint/u);
    dialect.execute("CREATE TABLE rebuild_me (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    dialect.execute("INSERT INTO rebuild_me (id, value) VALUES (?, ?)", ["row-1", "preserved"]);
    dialect.rebuildTable({
      tableName: "rebuild_me",
      replacementName: "rebuild_next",
      createReplacementSql:
        'CREATE TABLE "rebuild_next" (id TEXT PRIMARY KEY, value TEXT NOT NULL, added INTEGER NOT NULL DEFAULT 7)',
      columns: ["id", "value"],
    });
    expect(dialect.query("SELECT id, value, added FROM rebuild_me")).toEqual([
      { id: "row-1", value: "preserved", added: 7 },
    ]);
    expect(() =>
      dialect.rebuildTable({
        tableName: "rebuild_me; DROP TABLE cp_caplet",
        replacementName: "rebuild_next",
        createReplacementSql: 'CREATE TABLE "rebuild_next" (id TEXT)',
        columns: ["id"],
      }),
    ).toThrow(/unsafe/u);
    await expect(
      openSqliteControlPlaneDialect({
        storage: fixture.storage,
        environment,
        assetRoot: fixture.assetRoot,
      }),
    ).rejects.toThrow(/writer already owns/u);
    dialect.integrityCheck();
    const backupPath = join(fixture.root, "backup.sqlite3");
    await dialect.onlineBackup(backupPath);
    expect((await stat(backupPath)).size).toBeGreaterThan(0);
    dialect.execute(
      "INSERT INTO cp_migration (" +
        "model_version,id,logical_host_id,store_id,created_at,updated_at," +
        "aggregate_version,authority_version,effective_version,security_version," +
        "migration_id,source,destination,phase,manifest_hash,checksum,compatibility,state_document" +
        ") VALUES (1,?,?,?,?,?,0,0,0,0,?,?,?,?,?,?,?,?)",
      [
        "u7-rollback-guard",
        fixture.storage.logicalHostId,
        fixture.storage.storeId,
        "2026-07-14T00:00:00.000Z",
        "2026-07-14T00:00:00.000Z",
        "u7-rollback-guard",
        "legacy",
        "sqlite",
        "staged",
        "0".repeat(64),
        "1".repeat(64),
        "{}",
        '{"version":1,"kind":"rollback-guard"}',
      ],
    );
    expect(() => dialect.rollbackLatest()).toThrow(/NOT NULL constraint failed/u);
    dialect.execute("DELETE FROM cp_migration WHERE id = ?", ["u7-rollback-guard"]);
    expect(dialect.rollbackLatest()).toBe("0003_lazy_terrax");
    expect(dialect.ready).toBe(false);
    await dialect.close();

    const remigrated = await openSqliteControlPlaneDialect({
      storage: fixture.storage,
      environment,
      assetRoot: fixture.assetRoot,
    });
    expect(remigrated.migrate()).toEqual(["0003_lazy_terrax"]);
    await remigrated.close();
  });

  it("invalidates legacy short-code approvals and sessions during the U6 migration", async () => {
    const partialAssetRoot = await copiedAssets();
    await Promise.all(
      [
        "0002_colorful_maverick.sql",
        "0002_colorful_maverick.down.sql",
        "0002_colorful_maverick.manifest.json",
        "0003_lazy_terrax.sql",
        "0003_lazy_terrax.down.sql",
        "0003_lazy_terrax.manifest.json",
      ].map((file) => rm(join(partialAssetRoot, "sqlite", file))),
    );
    const fixture = await sqliteFixture(partialAssetRoot);
    const legacy = await openSqliteControlPlaneDialect({
      storage: fixture.storage,
      environment: migrationEnvironment(),
      assetRoot: partialAssetRoot,
    });
    expect(legacy.migrate()).toEqual(["0000_orange_tusk", "0001_conscious_wilson_fisk"]);
    const now = "2026-07-14T00:00:00.000Z";
    legacy.execute(
      "INSERT INTO cp_client " +
        "(model_version,id,logical_host_id,store_id,created_at,updated_at,aggregate_version," +
        "authority_version,effective_version,security_version,client_id,role,status,owner_id," +
        "last_authenticated_at,revoked_at) VALUES (1,?,?,?,?,?,0,0,0,0,?,?,?,NULL,NULL,NULL)",
      ["client:legacy-u6", logicalHostId, storeId, now, now, "legacy-u6", "operator", "active"],
    );
    legacy.execute(
      "INSERT INTO cp_pending_approval " +
        "(model_version,id,logical_host_id,store_id,created_at,updated_at,aggregate_version," +
        "authority_version,effective_version,security_version,approval_id,client_id,verifier," +
        "actor_id,state,expires_at,consumed_at) VALUES (1,?,?,?,?,?,0,0,0,0,?,NULL,?,NULL,?,?,NULL)",
      [
        "pending-approval:legacy-u6",
        logicalHostId,
        storeId,
        now,
        now,
        "legacy-u6",
        Buffer.from("legacy-short-code"),
        "pending",
        "9999-12-31T23:59:59.999Z",
      ],
    );
    legacy.execute(
      "INSERT INTO cp_dashboard_session " +
        "(model_version,id,logical_host_id,store_id,created_at,updated_at,aggregate_version," +
        "authority_version,effective_version,security_version,session_id,client_id,verifier," +
        "expires_at,last_seen_at,revoked_at) VALUES (1,?,?,?,?,?,0,0,0,0,?,?,?, ?,?,NULL)",
      [
        "dashboard-session:legacy-u6",
        logicalHostId,
        storeId,
        now,
        now,
        "legacy-u6",
        "legacy-u6",
        Buffer.from("legacy-cookie-verifier"),
        "9999-12-31T23:59:59.999Z",
        now,
      ],
    );
    await legacy.close();

    const upgraded = await openSqliteControlPlaneDialect({
      storage: fixture.storage,
      environment: migrationEnvironment(),
      assetRoot: sourceAssetRoot,
    });
    expect(upgraded.migrate()).toEqual(["0002_colorful_maverick", "0003_lazy_terrax"]);
    expect(
      upgraded.query(
        "SELECT state, algorithm, verifier_version AS verifierVersion, key_version AS keyVersion, " +
          "consumed_at AS consumedAt FROM cp_pending_approval WHERE approval_id = ?",
        ["legacy-u6"],
      ),
    ).toEqual([
      {
        state: "invalidated",
        algorithm: "legacy-invalidated",
        verifierVersion: 0,
        keyVersion: 0,
        consumedAt: now,
      },
    ]);
    expect(
      upgraded.query(
        "SELECT host_url AS hostUrl, client_label AS clientLabel FROM cp_client WHERE client_id = ?",
        ["legacy-u6"],
      ),
    ).toEqual([{ hostUrl: "legacy-unbound", clientLabel: "legacy-u6" }]);
    expect(
      upgraded.query(
        "SELECT revoked_at AS revokedAt, algorithm, csrf_algorithm AS csrfAlgorithm, " +
          "absolute_expires_at AS absoluteExpiresAt, idle_expires_at AS idleExpiresAt " +
          "FROM cp_dashboard_session WHERE session_id = ?",
        ["legacy-u6"],
      ),
    ).toEqual([
      {
        revokedAt: now,
        algorithm: "legacy-invalidated",
        csrfAlgorithm: "legacy-invalidated",
        absoluteExpiresAt: "9999-12-31T23:59:59.999Z",
        idleExpiresAt: now,
      },
    ]);
    await upgraded.close();
  });

  it("rolls back the additive SQLite migration without breaking populated child relations", async () => {
    const partialAssetRoot = await copiedAssets();
    await Promise.all(
      ["0003_lazy_terrax.sql", "0003_lazy_terrax.down.sql", "0003_lazy_terrax.manifest.json"].map(
        (file) => rm(join(partialAssetRoot, "sqlite", file)),
      ),
    );
    const fixture = await sqliteFixture(partialAssetRoot);
    const dialect = await openSqliteControlPlaneDialect({
      storage: fixture.storage,
      environment: migrationEnvironment(),
      assetRoot: fixture.assetRoot,
    });
    dialect.migrate();
    const now = "2026-07-14T00:00:00.000Z";
    dialect.execute(
      "INSERT INTO cp_caplet (" +
        "model_version, id, logical_host_id, store_id, created_at, updated_at, " +
        "aggregate_version, authority_version, effective_version, security_version, " +
        "name, description, ownership, activation, effective, update_state, " +
        "portable_aggregate_id, installation_provenance_id" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        1,
        "caplet-rollback",
        fixture.storage.logicalHostId,
        fixture.storage.storeId,
        now,
        now,
        1,
        0,
        0,
        0,
        "Rollback Caplet",
        "data-bearing rollback fixture",
        "sql",
        "active",
        1,
        "current",
        "caplet-rollback",
        null,
      ],
    );
    dialect.execute(
      "INSERT INTO cp_caplet_document " +
        "(logical_host_id, caplet_id, portable_version, canonical_model_version, source_path, source_frontmatter, body) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
      [fixture.storage.logicalHostId, "caplet-rollback", 1, 1, "CAPLET.md", "{}", "# Rollback"],
    );
    dialect.execute(
      "INSERT INTO cp_vault_grant " +
        "(model_version,id,logical_host_id,store_id,created_at,updated_at,aggregate_version," +
        "authority_version,effective_version,security_version,reference_name,caplet_id,origin," +
        "stored_key,scope,owner_id) VALUES " +
        "(1,?,?,?,?,?,0,0,0,0,?,?,?,?,NULL,NULL),(1,?,?,?,?,?,0,0,0,0,?,?,?,?,NULL,NULL)",
      [
        "grant-a",
        fixture.storage.logicalHostId,
        fixture.storage.storeId,
        now,
        now,
        "ROLLBACK_REF",
        "caplet-rollback",
        '{"kind":"declared","path":"a"}',
        "ROLLBACK_A",
        "grant-b",
        fixture.storage.logicalHostId,
        fixture.storage.storeId,
        now,
        now,
        "ROLLBACK_REF",
        "caplet-rollback",
        '{"kind":"declared","path":"b"}',
        "ROLLBACK_B",
      ],
    );
    expect(() => dialect.rollbackLatest()).toThrow(/UNIQUE constraint failed/u);
    expect(
      dialect.query<{ id: string }>(
        "SELECT id FROM cp_vault_grant WHERE reference_name = ? ORDER BY id",
        ["ROLLBACK_REF"],
      ),
    ).toEqual([{ id: "grant-a" }, { id: "grant-b" }]);
    dialect.execute("DELETE FROM cp_vault_grant WHERE id = ?", ["grant-b"]);
    expect(dialect.rollbackLatest()).toBe("0002_colorful_maverick");
    expect(dialect.rollbackLatest()).toBe("0001_conscious_wilson_fisk");
    await dialect.close();

    const database = new Database(fixture.databasePath);
    expect(
      database.prepare("SELECT name FROM cp_caplet WHERE id = ?").get("caplet-rollback"),
    ).toEqual({ name: "Rollback Caplet" });
    expect(
      database
        .prepare("SELECT body FROM cp_caplet_document WHERE caplet_id = ?")
        .get("caplet-rollback"),
    ).toEqual({ body: "# Rollback" });
    expect(
      database
        .prepare("SELECT id, stored_key AS storedKey FROM cp_vault_grant WHERE reference_name = ?")
        .get("ROLLBACK_REF"),
    ).toEqual({ id: "grant-a", storedKey: "ROLLBACK_A" });
    database.close();
  });

  it("rolls back failed SQL atomically and blocks readiness", async () => {
    const assetRoot = await copiedAssets();
    const migration = join(assetRoot, "sqlite", "0000_orange_tusk.sql");
    await writeFile(
      migration,
      `${await readFile(migration, "utf8")}\nCREATE TABLE cp_should_rollback (id text);\nTHIS IS NOT SQL;\n`,
    );
    await refreshManifest(assetRoot, "sqlite", "0000_orange_tusk");
    const fixture = await sqliteFixture(assetRoot);
    const dialect = await openSqliteControlPlaneDialect({
      storage: fixture.storage,
      environment: migrationEnvironment(),
      assetRoot,
    });
    expect(() => dialect.migrate()).toThrow();
    expect(dialect.ready).toBe(false);
    await dialect.close();

    const database = new Database(fixture.databasePath);
    const rollbackTable = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cp_should_rollback'",
      )
      .get();
    const canonicalTable = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cp_caplet'")
      .get();
    database.close();
    expect(rollbackTable).toBeUndefined();
    expect(canonicalTable).toBeUndefined();
  });

  it("rejects checksum drift and incompatible ranges before database access", async () => {
    const assetRoot = await copiedAssets();
    const migration = join(assetRoot, "sqlite", "0000_orange_tusk.sql");
    await writeFile(migration, `${await readFile(migration, "utf8")}\n-- drift\n`);
    await expect(loadMigrationRegistry({ dialect: "sqlite", assetRoot })).rejects.toThrow(
      /checksum drift/u,
    );

    const fixture = await sqliteFixture(sourceAssetRoot);
    const incompatibleEnvironments: MigrationEnvironment[] = [
      { ...migrationEnvironment(), binaryVersion: "0.35.0" },
      { ...migrationEnvironment(), supportedSchemaVersion: 2 },
      { ...migrationEnvironment(), keyVersion: 2 },
      { ...migrationEnvironment(), manifestVersion: 2 },
    ];
    for (const incompatible of incompatibleEnvironments) {
      await expect(
        openSqliteControlPlaneDialect({
          storage: fixture.storage,
          environment: incompatible,
          assetRoot: sourceAssetRoot,
        }),
      ).rejects.toThrow(/incompatible/u);
    }
    await expect(stat(fixture.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an applied schema newer than the packaged registry", async () => {
    const fixture = await sqliteFixture();
    const dialect = await openSqliteControlPlaneDialect({
      storage: fixture.storage,
      environment: migrationEnvironment(),
      assetRoot: fixture.assetRoot,
    });
    dialect.migrate();
    await dialect.close();
    const database = new Database(fixture.databasePath);
    database
      .prepare(
        'INSERT INTO "__caplets_migration_history_v1" ' +
          "(migration_id,sql_sha256,manifest_sha256,destination_schema_version,applied_at) " +
          "VALUES (?,?,?,?,?)",
      )
      .run("9999_future_schema", "0".repeat(64), "1".repeat(64), 9999, "2026-07-14T00:00:01.000Z");
    database.close();
    const future = await openSqliteControlPlaneDialect({
      storage: fixture.storage,
      environment: migrationEnvironment(),
      assetRoot: fixture.assetRoot,
    });
    expect(() => future.migrate()).toThrow(/newer than this binary/u);
    expect(future.ready).toBe(false);
    await future.close();
  });

  it("fails closed after the reviewed rollback window expires", async () => {
    const fixture = await sqliteFixture();
    const environment = migrationEnvironment();
    const dialect = await openSqliteControlPlaneDialect({
      storage: fixture.storage,
      environment,
      assetRoot: fixture.assetRoot,
    });
    dialect.migrate();
    environment.now = new Date("2026-07-22T00:00:00.001Z");
    expect(() => dialect.rollbackLatest()).toThrow(/Rollback window expired/u);
    expect(dialect.ready).toBe(true);
    await dialect.close();
  });
});

describe.skipIf(!postgresAdminUrl)("real Postgres migrations and least-privilege roles", () => {
  it("serializes starters, enforces role boundaries, and performs reviewed rollback", async () => {
    if (!postgresAdminUrl) throw new Error("Postgres fixture URL is unavailable");
    const Pool = loadPostgresPoolConstructor();
    const admin = new Pool({ connectionString: postgresAdminUrl, max: 2 });
    const databaseName = new URL(postgresAdminUrl).pathname.slice(1);
    const runtimeRole = "caplets_runtime";
    const migratorRole = "caplets_migrator";
    const maintenanceRole = "caplets_maintenance";
    const runtimePassword = "runtime-fixture-password";
    const migratorPassword = "migrator-fixture-password";
    const maintenancePassword = "maintenance-fixture-password";
    let first: PostgresControlPlaneDialect | undefined;
    let second: PostgresControlPlaneDialect | undefined;
    try {
      await admin.query(`
        DROP SCHEMA IF EXISTS caplets CASCADE;
        DROP ROLE IF EXISTS ${quoteSafeSqlIdentifier(runtimeRole)};
        DROP ROLE IF EXISTS ${quoteSafeSqlIdentifier(migratorRole)};
        DROP ROLE IF EXISTS ${quoteSafeSqlIdentifier(maintenanceRole)};
        CREATE ROLE ${quoteSafeSqlIdentifier(runtimeRole)}
          LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
          PASSWORD '${runtimePassword}';
        CREATE ROLE ${quoteSafeSqlIdentifier(migratorRole)}
          LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
          PASSWORD '${migratorPassword}';
        CREATE ROLE ${quoteSafeSqlIdentifier(maintenanceRole)}
          LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
          PASSWORD '${maintenancePassword}';
        GRANT CREATE ON DATABASE ${quoteSafeSqlIdentifier(databaseName)}
          TO ${quoteSafeSqlIdentifier(migratorRole)};
      `);
      const registry = await loadMigrationRegistry({
        dialect: "postgres",
        assetRoot: sourceAssetRoot,
      });
      const storage = postgresFixtureStorage();
      const environment = migrationEnvironment();
      const firstPools = postgresPools(
        Pool,
        postgresAdminUrl,
        runtimeRole,
        runtimePassword,
        migratorRole,
        migratorPassword,
        maintenanceRole,
        maintenancePassword,
      );
      const secondPools = postgresPools(
        Pool,
        postgresAdminUrl,
        runtimeRole,
        runtimePassword,
        migratorRole,
        migratorPassword,
        maintenanceRole,
        maintenancePassword,
      );
      [first, second] = await Promise.all([
        attachVerifiedPostgresPools({
          storage,
          pools: firstPools,
          roles: {
            runtime: runtimeRole,
            migrator: migratorRole,
            maintenance: maintenanceRole,
          },
          registry,
          environment,
        }),
        attachVerifiedPostgresPools({
          storage,
          pools: secondPools,
          roles: {
            runtime: runtimeRole,
            migrator: migratorRole,
            maintenance: maintenanceRole,
          },
          registry,
          environment,
        }),
      ]);
      const elected = await Promise.all([first.migrate(), second.migrate()]);
      expect(elected.map((migrations) => migrations.length).sort()).toEqual([0, 4]);
      const tableCount = await admin.query(
        "SELECT count(*)::int AS count FROM information_schema.tables " +
          "WHERE table_schema = 'caplets' AND table_name LIKE 'cp_%'",
      );
      expect(singleNumber(tableCount.rows, "count")).toBe(41);

      await admin.query(`
        GRANT USAGE ON SCHEMA caplets TO
          ${quoteSafeSqlIdentifier(runtimeRole)}, ${quoteSafeSqlIdentifier(maintenanceRole)};
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA caplets
          TO ${quoteSafeSqlIdentifier(runtimeRole)};
        REVOKE UPDATE, DELETE ON caplets.cp_operator_activity
          FROM ${quoteSafeSqlIdentifier(runtimeRole)};
        REVOKE INSERT, UPDATE, DELETE ON caplets.cp_retention
          FROM ${quoteSafeSqlIdentifier(runtimeRole)};
      `);
      await expect(
        first.query("CREATE TABLE caplets.runtime_ddl_denied (id int)"),
      ).rejects.toThrow();
      await expect(
        first.query(`SET ROLE ${quoteSafeSqlIdentifier(migratorRole)}`),
      ).rejects.toThrow();
      await firstPools.migrator.query("CREATE TABLE caplets.migrator_ddl_proof (id int)");
      await firstPools.migrator.query("DROP TABLE caplets.migrator_ddl_proof");

      const canonicalClock = "2026-07-14T00:00:00.000Z";
      await admin.query(
        `INSERT INTO caplets.cp_operator_activity (
          model_version,id,logical_host_id,store_id,created_at,updated_at,
          aggregate_version,authority_version,effective_version,security_version,
          activity_id,actor_id,action,outcome,target,redacted_detail,occurred_at,expires_at
        ) VALUES (1,$1,$2,$3,$4,$4,0,0,0,0,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$4,$4)`,
        [
          "activity-row",
          logicalHostId,
          storeId,
          canonicalClock,
          "activity-1",
          "actor-1",
          "test",
          "ok",
          "{}",
          "{}",
        ],
      );
      await expect(
        first.query("UPDATE caplets.cp_operator_activity SET outcome = $1 WHERE id = $2", [
          "changed",
          "activity-row",
        ]),
      ).rejects.toThrow();
      await expect(
        first.query("DELETE FROM caplets.cp_operator_activity WHERE id = $1", ["activity-row"]),
      ).rejects.toThrow();

      await expect(
        first.maintenanceQuery("SELECT reference_name FROM caplets.cp_vault_value"),
      ).rejects.toThrow();
      const maintained = await first.maintenanceQuery<{
        deletedCount: string;
        occurredAt: string;
      }>(
        `SELECT deleted_count AS "deletedCount", occurred_at AS "occurredAt"
         FROM caplets.cp_purge_expired_operator_activity($1, $2, $3, $4, $5)`,
        [logicalHostId, storeId, "activity-purge-receipt", 1, 1],
      );
      expect(maintained).toMatchObject([{ deletedCount: "1" }]);
      expect(
        (
          await admin.query(
            'SELECT resource_kind AS "resourceKind", policy, purge_watermark AS "watermark" ' +
              "FROM caplets.cp_retention WHERE retention_id = $1",
            ["activity-purge-receipt"],
          )
        ).rows,
      ).toEqual([
        {
          resourceKind: "operator-activity",
          policy: "bounded-expired-only",
          watermark: "1",
        },
      ]);
      await expect(
        first.maintenanceQuery("UPDATE caplets.cp_caplet SET description = 'unsafe'"),
      ).rejects.toThrow();

      await admin.query(
        `INSERT INTO caplets.cp_migration (
          model_version,id,logical_host_id,store_id,created_at,updated_at,
          aggregate_version,authority_version,effective_version,security_version,
          migration_id,source,destination,phase,manifest_hash,checksum,compatibility,state_document
        ) VALUES (1,$1,$2,$3,$4,$4,0,0,0,0,$1,'legacy','postgres','staged',$5,$6,'{}'::jsonb,$7::jsonb)`,
        [
          "u7-rollback-guard",
          logicalHostId,
          storeId,
          canonicalClock,
          "0".repeat(64),
          "1".repeat(64),
          '{"version":1,"kind":"rollback-guard"}',
        ],
      );
      await expect(first.rollbackLatest()).rejects.toThrow(/refusing U7 rollback/u);
      await admin.query("DELETE FROM caplets.cp_migration WHERE id = $1", ["u7-rollback-guard"]);
      expect(await first.rollbackLatest()).toBe("0003_concerned_lily_hollister");
      expect(first.ready).toBe(false);
      await second.close();
      second = undefined;
      expect(await first.migrate()).toEqual(["0003_concerned_lily_hollister"]);
      environment.now = new Date("2026-07-22T00:00:00.001Z");
      await expect(first.rollbackLatest()).rejects.toThrow(/Rollback window expired/u);
      expect(first.ready).toBe(true);
    } finally {
      await Promise.allSettled([first?.close(), second?.close()]);
      await admin.query(`
        DROP SCHEMA IF EXISTS caplets CASCADE;
        DROP OWNED BY ${quoteSafeSqlIdentifier(runtimeRole)};
        DROP OWNED BY ${quoteSafeSqlIdentifier(migratorRole)};
        DROP OWNED BY ${quoteSafeSqlIdentifier(maintenanceRole)};
        DROP ROLE IF EXISTS ${quoteSafeSqlIdentifier(runtimeRole)};
        DROP ROLE IF EXISTS ${quoteSafeSqlIdentifier(migratorRole)};
        DROP ROLE IF EXISTS ${quoteSafeSqlIdentifier(maintenanceRole)};
      `);
      await admin.end();
    }
  });
});

async function refreshManifest(
  assetRoot: string,
  dialect: "sqlite" | "postgres",
  basename: string,
) {
  const directory = join(assetRoot, dialect);
  const manifestPath = join(directory, `${basename}.manifest.json`);
  const manifest = mutableTestManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  const sql = {
    ...manifest.sql,
    sha256: sha256(await readFile(join(directory, manifest.sql.file), "utf8")),
  };
  const unsigned: Record<string, unknown> = { ...manifest, sql };
  delete unsigned.manifestSha256;
  const refreshed = {
    ...unsigned,
    manifestSha256: sha256(stableJsonStringify(unsigned)),
  };
  await writeFile(manifestPath, `${JSON.stringify(refreshed, null, 2)}\n`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type TestPostgresPoolConstructor = new (configuration: Record<string, unknown>) => PostgresPool;

function loadPostgresPoolConstructor(): TestPostgresPoolConstructor {
  const moduleValue: unknown = require("pg");
  if (!moduleValue || typeof moduleValue !== "object" || !("Pool" in moduleValue)) {
    throw new Error("Postgres test driver does not expose Pool");
  }
  const Pool = moduleValue.Pool;
  if (typeof Pool !== "function") throw new Error("Postgres test Pool is invalid");
  return Pool as TestPostgresPoolConstructor;
}

function postgresPools(
  Pool: TestPostgresPoolConstructor,
  adminUrl: string,
  runtimeRole: string,
  runtimePassword: string,
  migratorRole: string,
  migratorPassword: string,
  maintenanceRole: string,
  maintenancePassword: string,
): { runtime: PostgresPool; migrator: PostgresPool; maintenance: PostgresPool } {
  return {
    runtime: new Pool({
      connectionString: roleConnectionString(adminUrl, runtimeRole, runtimePassword),
      max: 2,
    }),
    migrator: new Pool({
      connectionString: roleConnectionString(adminUrl, migratorRole, migratorPassword),
      max: 2,
    }),
    maintenance: new Pool({
      connectionString: roleConnectionString(adminUrl, maintenanceRole, maintenancePassword),
      max: 2,
    }),
  };
}

function roleConnectionString(adminUrl: string, role: string, password: string): string {
  const url = new URL(adminUrl);
  url.username = role;
  url.password = password;
  return url.href;
}

function postgresFixtureStorage(): ResolvedPostgresStorage {
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

function singleNumber(rows: readonly unknown[], property: string): number {
  if (rows.length !== 1) throw new Error(`Postgres proof ${property} row is unavailable`);
  const row = rows[0];
  if (!isRecord(row) || !(property in row)) {
    throw new Error(`Postgres proof ${property} row is malformed`);
  }
  const value = row[property];
  if (typeof value !== "number") throw new Error(`Postgres proof ${property} is not numeric`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
