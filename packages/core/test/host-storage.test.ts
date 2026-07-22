import { Buffer } from "node:buffer";
import { once } from "node:events";
import BetterSqlite3 from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_STORAGE_SCHEMA_VERSION, createHostStorage, migrateHostStorage } from "../src/storage";

const directories: string[] = [];
const postgresUrl = process.env.CAPLETS_TEST_POSTGRES_URL;
if (process.env.CAPLETS_REQUIRE_TEST_POSTGRES === "1" && !postgresUrl) {
  throw new Error("CAPLETS_TEST_POSTGRES_URL is required when CAPLETS_REQUIRE_TEST_POSTGRES=1.");
}
const postgresSchemas: string[] = [];
const postgresIt = postgresUrl ? it : it.skip;
const RESOURCE_VERSION_MIGRATION_CREATED_AT = 1_784_565_600_999;

function legacyGrantVersion(
  subjectKind: string,
  subjectKey: string,
  referenceName: string,
): string {
  const identity =
    `${subjectKind.length}:${subjectKind}` +
    `${subjectKey.length}:${subjectKey}` +
    `${referenceName.length}:${referenceName}`;
  return `legacy-v16-${Buffer.from(identity).toString("hex")}`;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  if (postgresUrl && postgresSchemas.length > 0) {
    const client = new Pool({ connectionString: postgresUrl });
    try {
      for (const schema of postgresSchemas.splice(0)) {
        await client.query(`drop schema if exists "${schema}" cascade`);
      }
    } finally {
      await client.end();
    }
  }
});

describe("host storage", () => {
  it("creates a ready migrated SQLite store by default", async () => {
    expect(HOST_STORAGE_SCHEMA_VERSION).toBe(18);
    const directory = mkdtempSync(join(tmpdir(), "caplets-storage-"));
    directories.push(directory);

    const storage = await createHostStorage({
      type: "sqlite",
      path: join(directory, "caplets.sqlite3"),
    });

    try {
      await expect(storage.health()).resolves.toEqual({
        backend: "sqlite",
        ready: true,
        schemaVersion: HOST_STORAGE_SCHEMA_VERSION,
        assets: { backend: "sql", ready: true },
      });
    } finally {
      await storage.close();
    }
  });

  it("retries migration after a transient SQLite writer lock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-storage-lock-"));
    directories.push(directory);
    const path = join(directory, "caplets.sqlite3");
    const config = { type: "sqlite" as const, path };
    const seed = await createHostStorage(config);
    await seed.close();

    // This integration test must outlive SQLite's native busy timeout; fake timers cannot drive it.
    const worker = new Worker(
      `
        const BetterSqlite3 = require("better-sqlite3");
        const { parentPort, workerData } = require("node:worker_threads");
        const database = new BetterSqlite3(workerData.path);
        database.exec("BEGIN IMMEDIATE");
        parentPort.postMessage("locked");
        setTimeout(() => {
          database.exec("COMMIT");
          database.close();
        }, workerData.holdMs);
      `,
      { eval: true, workerData: { path, holdMs: 5_250 } },
    );
    const exited = once(worker, "exit");
    const [message] = await once(worker, "message");
    expect(message).toBe("locked");

    let storage: Awaited<ReturnType<typeof createHostStorage>> | undefined;
    try {
      storage = await createHostStorage(config);
      await expect(storage.health()).resolves.toMatchObject({ ready: true });
      await expect(exited).resolves.toEqual([0]);
    } finally {
      await storage?.close();
      await worker.terminate();
    }
  }, 10_000);

  it("tracks SQLite migrations with integer keys and immutable hashes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-storage-"));
    directories.push(directory);
    const path = join(directory, "caplets.sqlite3");
    const config = { type: "sqlite" as const, path };

    await migrateHostStorage(config);
    const database = new BetterSqlite3(path);
    try {
      const idColumn = (
        database.pragma("table_info(caplets_migrations)") as Array<{
          name: string;
          type: string;
          pk: number;
        }>
      ).find((column) => column.name === "id");
      expect(idColumn).toMatchObject({ type: "INTEGER", pk: 1 });
      const rows = database
        .prepare("SELECT id, hash FROM caplets_migrations ORDER BY created_at")
        .all() as Array<{ id: number; hash: string }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => Number.isInteger(row.id))).toBe(true);
      database
        .prepare(
          "UPDATE caplets_migrations SET hash = 'tampered' WHERE created_at = (SELECT MIN(created_at) FROM caplets_migrations)",
        )
        .run();
    } finally {
      database.close();
    }

    await expect(migrateHostStorage(config)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("rejects gaps in SQLite migration history", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-storage-"));
    directories.push(directory);
    const path = join(directory, "caplets.sqlite3");
    const config = { type: "sqlite" as const, path };

    await migrateHostStorage(config);
    const database = new BetterSqlite3(path);
    try {
      database
        .prepare(
          "DELETE FROM caplets_migrations WHERE created_at = (SELECT MIN(created_at) FROM caplets_migrations)",
        )
        .run();
    } finally {
      database.close();
    }

    await expect(migrateHostStorage(config)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("backfills pre-v16 SQLite resource versions without secret material", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-storage-v16-"));
    directories.push(directory);
    const path = join(directory, "caplets.sqlite3");
    const config = { type: "sqlite" as const, path };
    await migrateHostStorage(config);

    const subjectKey = JSON.stringify(["shared", "global-file", "/shared/CAPLET.md"]);
    const database = new BetterSqlite3(path);
    try {
      database
        .prepare(
          `INSERT INTO remote_clients (
            client_id, client_label, role, host_url, access_token_hash,
            access_expires_at, generation, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "rcli_existing",
          "Existing",
          "access",
          "https://remote.example.test",
          "secret-access-hash",
          "2027-01-01T00:00:00.000Z",
          9,
          "2026-01-01T00:00:00.000Z",
        );
      database
        .prepare(
          `INSERT INTO remote_pending_logins (
            flow_id, host_url, operator_code_hash, pending_refresh_hash,
            pending_completion_hash, client_label, requested_role, created_at,
            code_expires_at, flow_expires_at, generation, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "rlogin_existing",
          "https://remote.example.test",
          "secret-code-hash",
          "secret-refresh-hash",
          "secret-completion-hash",
          "Existing pending",
          "access",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:10:00.000Z",
          "2026-01-02T00:00:00.000Z",
          7,
          "pending",
        );
      database
        .prepare(
          `INSERT INTO vault_access_grants (
            subject_kind, subject_key, caplet_id, vault_key, reference_name,
            origin_kind, origin_path, resource_version, created_at, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "file",
          subjectKey,
          "shared",
          "SECRET_TOKEN",
          "TOKEN",
          "global-file",
          "/shared/CAPLET.md",
          "old-version",
          "2026-01-01T00:00:00.000Z",
          "secret-operator",
        );
      database.exec(`
        DROP INDEX caplet_records_updated_key_idx;
        DROP INDEX remote_pending_logins_status_created_idx;
        ALTER TABLE remote_clients DROP COLUMN generation;
        ALTER TABLE remote_pending_logins DROP COLUMN generation;
        ALTER TABLE vault_access_grants DROP COLUMN resource_version;
        DELETE FROM caplets_migrations
        WHERE created_at >= ${RESOURCE_VERSION_MIGRATION_CREATED_AT};
        UPDATE caplets_schema SET version = 15 WHERE singleton = 1;
      `);
    } finally {
      database.close();
    }

    await migrateHostStorage(config);
    const migrated = new BetterSqlite3(path);
    try {
      expect(
        migrated
          .prepare("SELECT generation FROM remote_clients WHERE client_id = ?")
          .get("rcli_existing"),
      ).toEqual({ generation: 1 });
      expect(
        migrated
          .prepare("SELECT generation FROM remote_pending_logins WHERE flow_id = ?")
          .get("rlogin_existing"),
      ).toEqual({ generation: 1 });
      const grant = migrated
        .prepare(
          "SELECT resource_version AS resourceVersion FROM vault_access_grants WHERE subject_key = ?",
        )
        .get(subjectKey) as { resourceVersion: string };
      expect(grant.resourceVersion).toBe(legacyGrantVersion("file", subjectKey, "TOKEN"));
      expect(grant.resourceVersion).not.toContain("SECRET_TOKEN");
      expect(grant.resourceVersion).not.toContain("secret-operator");
    } finally {
      migrated.close();
    }
  });

  it("rejects invalid and unavailable PostgreSQL storage", async () => {
    await expect(
      createHostStorage({
        type: "postgres",
        connectionString: "postgres://127.0.0.1:1/caplets?connect_timeout=1",
        schema: "invalid-schema",
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      createHostStorage({
        type: "postgres",
        connectionString: "postgres://127.0.0.1:1/caplets?connect_timeout=1",
      }),
    ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
  });

  postgresIt("refuses an unmigrated PostgreSQL schema", async () => {
    const schema = `caplets_test_${randomUUID().replaceAll("-", "")}`;
    postgresSchemas.push(schema);
    await expect(
      createHostStorage({
        type: "postgres",
        connectionString: postgresUrl!,
        schema,
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  postgresIt("migrates PostgreSQL before opening runtime storage", async () => {
    const schema = `caplets_test_${randomUUID().replaceAll("-", "")}`;
    postgresSchemas.push(schema);
    const config = {
      type: "postgres" as const,
      connectionString: postgresUrl!,
      schema,
    };

    await migrateHostStorage(config);
    const storage = await createHostStorage(config);
    try {
      await expect(storage.health()).resolves.toEqual({
        backend: "postgres",
        ready: true,
        schemaVersion: HOST_STORAGE_SCHEMA_VERSION,
        assets: { backend: "sql", ready: true },
      });
    } finally {
      await storage.close();
    }
  });
  postgresIt("backfills pre-v16 PostgreSQL resource versions without secret material", async () => {
    const schema = `caplets_v16_${randomUUID().replaceAll("-", "")}`;
    postgresSchemas.push(schema);
    const config = {
      type: "postgres" as const,
      connectionString: postgresUrl!,
      schema,
    };
    await migrateHostStorage(config);

    const subjectKey = JSON.stringify(["shared", "global-file", "/shared/CAPLET.md"]);
    const pool = new Pool({ connectionString: postgresUrl! });
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO "${schema}".remote_clients (
          client_id, client_label, role, host_url, access_token_hash,
          access_expires_at, generation, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          "rcli_existing",
          "Existing",
          "access",
          "https://remote.example.test",
          "secret-access-hash",
          "2027-01-01T00:00:00.000Z",
          9,
          "2026-01-01T00:00:00.000Z",
        ],
      );
      await client.query(
        `INSERT INTO "${schema}".remote_pending_logins (
          flow_id, host_url, operator_code_hash, pending_refresh_hash,
          pending_completion_hash, client_label, requested_role, created_at,
          code_expires_at, flow_expires_at, generation, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          "rlogin_existing",
          "https://remote.example.test",
          "secret-code-hash",
          "secret-refresh-hash",
          "secret-completion-hash",
          "Existing pending",
          "access",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:10:00.000Z",
          "2026-01-02T00:00:00.000Z",
          7,
          "pending",
        ],
      );
      await client.query(
        `INSERT INTO "${schema}".vault_access_grants (
          subject_kind, subject_key, caplet_id, vault_key, reference_name,
          origin_kind, origin_path, resource_version, created_at, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          "file",
          subjectKey,
          "shared",
          "SECRET_TOKEN",
          "TOKEN",
          "global-file",
          "/shared/CAPLET.md",
          "old-version",
          "2026-01-01T00:00:00.000Z",
          "secret-operator",
        ],
      );
      await client.query(`
        DROP INDEX "${schema}".caplet_records_updated_key_idx;
        DROP INDEX "${schema}".remote_pending_logins_status_created_idx;
        ALTER TABLE "${schema}".remote_clients DROP COLUMN generation;
        ALTER TABLE "${schema}".remote_pending_logins DROP COLUMN generation;
        ALTER TABLE "${schema}".vault_access_grants DROP COLUMN resource_version;
        DELETE FROM "${schema}".caplets_migrations
        WHERE created_at >= ${RESOURCE_VERSION_MIGRATION_CREATED_AT};
        UPDATE "${schema}".caplets_schema SET version = 15 WHERE singleton = 1;
      `);
    } finally {
      client.release();
      await pool.end();
    }

    await migrateHostStorage(config);
    const migrated = new Pool({ connectionString: postgresUrl! });
    try {
      await expect(
        migrated.query(`SELECT generation FROM "${schema}".remote_clients WHERE client_id = $1`, [
          "rcli_existing",
        ]),
      ).resolves.toMatchObject({ rows: [{ generation: 1 }] });
      await expect(
        migrated.query(
          `SELECT generation FROM "${schema}".remote_pending_logins WHERE flow_id = $1`,
          ["rlogin_existing"],
        ),
      ).resolves.toMatchObject({ rows: [{ generation: 1 }] });
      const grant = await migrated.query<{ resourceVersion: string }>(
        `SELECT resource_version AS "resourceVersion"
         FROM "${schema}".vault_access_grants WHERE subject_key = $1`,
        [subjectKey],
      );
      expect(grant.rows[0]?.resourceVersion).toBe(legacyGrantVersion("file", subjectKey, "TOKEN"));
      expect(grant.rows[0]?.resourceVersion).not.toContain("SECRET_TOKEN");
      expect(grant.rows[0]?.resourceVersion).not.toContain("secret-operator");
    } finally {
      await migrated.end();
    }
  });
});
