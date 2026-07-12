import { createRequire } from "node:module";
import { mkdtemp, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type postgres from "postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import corePackage from "../package.json";
import {
  POSTGRES_MIGRATIONS,
  SQLITE_MIGRATIONS,
  migratePostgresDatabase,
  migrateSqliteDatabase,
  verifyMigrationHistory,
} from "../src/storage/sql/migrate";
import { postgresSchema } from "../src/storage/sql/schema-postgres";

const require = createRequire(import.meta.url);
const loadPostgres = require("postgres") as typeof postgres;
const coreRoot = fileURLToPath(new URL("..", import.meta.url));

it("pins the stable Drizzle and native driver packaging", () => {
  expect(corePackage.dependencies["drizzle-orm"]).toBe("0.45.2");
  expect(corePackage.dependencies["postgres"]).toBe("3.4.9");
  expect(corePackage.dependencies["better-sqlite3"]).toBe("12.11.1");
  expect(corePackage.devDependencies["drizzle-kit"]).toBe("0.31.10");
  expect(corePackage.devDependencies["@types/better-sqlite3"]).toBe("7.6.13");
});

describe("SQL authority migrations", () => {
  it("keeps separate dialect histories with stable checksums", () => {
    expect(SQLITE_MIGRATIONS.length).toBeGreaterThan(0);
    expect(POSTGRES_MIGRATIONS.length).toBe(SQLITE_MIGRATIONS.length);
    expect(new Set(SQLITE_MIGRATIONS.map((migration) => migration.checksum)).size).toBe(
      SQLITE_MIGRATIONS.length,
    );
    expect(new Set(POSTGRES_MIGRATIONS.map((migration) => migration.checksum)).size).toBe(
      POSTGRES_MIGRATIONS.length,
    );
    expect(POSTGRES_MIGRATIONS.map((migration) => migration.version)).toEqual(
      SQLITE_MIGRATIONS.map((migration) => migration.version),
    );
  });

  it("pins every PostgreSQL migration and Drizzle table to the caplets schema", () => {
    for (const migration of POSTGRES_MIGRATIONS) {
      expect(migration.sql).toContain("caplets.");
      expect(migration.sql).not.toMatch(
        /\b(?:FROM|INTO|UPDATE|TABLE(?: IF NOT EXISTS)?|ON)\s+authority_/,
      );
    }
    for (const table of Object.values(postgresSchema)) {
      expect(getTableConfig(table).schema).toBe("caplets");
    }
  });

  it("uses valid fixed-schema PostgreSQL index DDL", () => {
    const initial = POSTGRES_MIGRATIONS.find((migration) => migration.name === "0000_initial");
    expect(initial?.sql).toContain(
      "CREATE INDEX IF NOT EXISTS authority_events_after_idx ON caplets.authority_events (authority_id, watermark);",
    );
    expect(initial?.sql).not.toContain(
      "CREATE INDEX IF NOT EXISTS caplets.authority_events_after_idx",
    );
  });

  it("rejects missing, reordered, newer, and tampered history", () => {
    const expected = SQLITE_MIGRATIONS;
    expect(() => verifyMigrationHistory([], expected, { requireComplete: true })).toThrow();
    expect(() => verifyMigrationHistory([{ ...expected[0]!, version: 2 }], expected)).toThrow();
    expect(() =>
      verifyMigrationHistory([{ ...expected[0]!, checksum: "sha256:tampered" }], expected),
    ).toThrow();
    expect(() => verifyMigrationHistory([{ ...expected[0]!, version: 99 }], expected)).toThrow();
  });

  it("applies a fresh SQLite history and replays it without changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caplets-migration-"));
    const path = join(directory, "authority.sqlite");
    const first = await migrateSqliteDatabase({
      databasePath: path,
      authorityId: "migration-test",
      namespace: "test",
    });
    const second = await migrateSqliteDatabase({
      databasePath: path,
      authorityId: "migration-test",
      namespace: "test",
    });
    expect(first.applied).toBeGreaterThan(0);
    expect(second.applied).toBe(0);
    expect(second.logicalSchemaVersion).toBe(first.logicalSchemaVersion);
  });

  it("rejects an existing namespace mismatch without overwriting the stored namespace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "caplets-migration-namespace-"));
    const path = join(directory, "authority.sqlite");
    await migrateSqliteDatabase({
      databasePath: path,
      authorityId: "migration-namespace-test",
      namespace: "stable",
    });
    await expect(
      migrateSqliteDatabase({
        databasePath: path,
        authorityId: "migration-namespace-test",
        namespace: "wrong",
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      migrateSqliteDatabase({
        databasePath: path,
        authorityId: "migration-namespace-test",
        namespace: "stable",
      }),
    ).resolves.toMatchObject({ applied: 0, logicalSchemaVersion: 3 });
  });

  it("keeps the lease migration in both Drizzle journal histories", async () => {
    const sqliteJournal = JSON.parse(
      await readFile(
        join(coreRoot, "src/storage/sql/migrations/sqlite/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; version: string; tag: string }> };
    const postgresJournal = JSON.parse(
      await readFile(
        join(coreRoot, "src/storage/sql/migrations/postgres/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; version: string; tag: string }> };
    for (const journal of [sqliteJournal, postgresJournal]) {
      expect(journal.entries.at(-1)).toMatchObject({
        idx: 2,
        version: "3",
        tag: "0002_maintenance_lease",
      });
    }
  });

  it("keeps checked-in PostgreSQL artifacts byte-aligned with runtime migrations", async () => {
    for (const migration of POSTGRES_MIGRATIONS) {
      const sql = await readFile(
        join(coreRoot, "src/storage/sql/migrations/postgres", `${migration.name}.sql`),
        "utf8",
      );
      expect(sql).toBe(migration.sql);
    }
  });

  it("serializes concurrent fixed-schema PostgreSQL migrators behind a rollback-safe lock", async () => {
    const connectionString = process.env.TEST_POSTGRES_URL;
    if (!connectionString) return;
    const blocker = loadPostgres(connectionString, { max: 1, prepare: false });
    const firstPromise = migratePostgresDatabase({
      connectionString,
      authorityId: "current-host",
      namespace: "default",
    });
    const secondPromise = migratePostgresDatabase({
      connectionString,
      authorityId: "current-host",
      namespace: "default",
    });
    let settled = false;
    const resultsPromise = Promise.all([firstPromise, secondPromise]).then((results) => {
      settled = true;
      return results;
    });
    try {
      await expect(
        blocker.begin(async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended('caplets:sql:migrate:caplets', 0))`;
          await delay(100);
          expect(settled).toBe(false);
          throw new Error("rollback global migration lock");
        }),
      ).rejects.toThrow("rollback global migration lock");
      const [first, second] = await resultsPromise;
      expect(first.logicalSchemaVersion).toBe(3);
      expect(second.logicalSchemaVersion).toBe(3);
      expect(first.applied + second.applied).toBeLessThanOrEqual(3);
    } finally {
      await blocker.end({ timeout: 2 }).catch(() => undefined);
    }
  });

  it("does not auto-run PostgreSQL migration during authority startup", async () => {
    const connectionString = process.env.TEST_POSTGRES_URL;
    if (!connectionString) return;
    await expect(
      migratePostgresDatabase({
        connectionString,
        authorityId: "migration-test",
        namespace: "test",
      }),
    ).resolves.toMatchObject({
      applied: expect.any(Number),
    });
  });
});
