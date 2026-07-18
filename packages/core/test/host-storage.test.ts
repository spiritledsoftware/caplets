import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_STORAGE_SCHEMA_VERSION, createHostStorage, migrateHostStorage } from "../src/storage";

const directories: string[] = [];
const postgresUrl = process.env.CAPLETS_TEST_POSTGRES_URL;
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
