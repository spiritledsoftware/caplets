import BetterSqlite3 from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_STORAGE_SCHEMA_VERSION, createHostStorage, migrateHostStorage } from "../src/storage";

const directories: string[] = [];
const postgresUrl = process.env.CAPLETS_TEST_POSTGRES_URL;
if (process.env.CAPLETS_REQUIRE_TEST_POSTGRES === "1" && !postgresUrl) {
  throw new Error("CAPLETS_TEST_POSTGRES_URL is required when CAPLETS_REQUIRE_TEST_POSTGRES=1.");
}
const postgresSchemas: string[] = [];
const postgresIt = postgresUrl ? it : it.skip;

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
});
