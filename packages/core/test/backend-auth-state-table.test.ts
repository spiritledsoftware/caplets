import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { describe, expect, it } from "vitest";
import { BackendAuthStateStore } from "../src/storage/backend-auth";
import { backendAuthStates, operatorActivity, sqliteSchema } from "../src/storage/schema/sqlite";

describe("BackendAuthStateStore dedicated SQL table", () => {
  it("keeps CAS state and sanitized activity atomic", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-backend-auth-table-"));
    const client = createClient({
      url: pathToFileURL(join(directory, "storage.sqlite3")).href,
    });
    await client.execute(`
      create table backend_auth_states (
        server text primary key not null,
        generation integer not null,
        token_bundle text,
        created_at text not null,
        updated_at text not null
      )
    `);
    const database = drizzle(client, { schema: sqliteSchema });
    const store = new BackendAuthStateStore({ dialect: "sqlite", db: database });
    const bundle = {
      server: "github",
      accessToken: "secret-access-token",
      refreshToken: "secret-refresh-token",
    };

    try {
      await expect(
        store.writeTokenBundle(bundle, { operatorClientId: "operator-1" }),
      ).rejects.toThrow();
      await expect(store.readTokenBundle("github")).resolves.toBeUndefined();

      await client.execute(`
        create table operator_activity (
          activity_key text primary key not null,
          operator_client_id text not null,
          action text not null,
          target_kind text not null,
          target_key text not null,
          outcome text not null,
          metadata text not null,
          created_at text not null
        )
      `);
      await expect(
        store.writeTokenBundle(bundle, { operatorClientId: "operator-1" }),
      ).resolves.toEqual({ bundle, generation: 1 });
      await expect(
        store.writeTokenBundle(
          { ...bundle, accessToken: "stale-secret" },
          { expectedGeneration: 0, operatorClientId: "operator-1" },
        ),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
        details: { kind: "stale_generation", currentGeneration: 1 },
      });
      await expect(store.listTokenBundles()).resolves.toEqual([{ bundle, generation: 1 }]);
      expect(await database.select().from(backendAuthStates).all()).toHaveLength(1);
      expect(await database.select().from(operatorActivity).all()).toMatchObject([
        {
          operatorClientId: "operator-1",
          action: "backend_auth_written",
          targetKey: "github",
          metadata: { generation: 1 },
        },
      ]);
      expect(JSON.stringify(await database.select().from(operatorActivity).all())).not.toContain(
        "secret",
      );
      await expect(
        store.deleteTokenBundle("github", {
          expectedGeneration: 1,
          operatorClientId: "operator-1",
        }),
      ).resolves.toBe(true);
      await expect(store.readTokenBundle("github")).resolves.toBeUndefined();
    } finally {
      client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("migrates legacy generic backend auth rows into the dedicated table", async () => {
    const client = createClient({ url: "file::memory:" });
    const bundle = { server: "github", accessToken: "existing-secret" };
    await client.execute(`
      create table host_state_records (
        namespace text not null,
        state_key text not null,
        generation integer not null,
        payload text not null,
        created_at text not null,
        updated_at text not null,
        primary key (namespace, state_key)
      )
    `);
    await client.execute({
      sql: `
        insert into host_state_records
          (namespace, state_key, generation, payload, created_at, updated_at)
        values (?, ?, ?, ?, ?, ?)
      `,
      args: [
        "backend-auth",
        "github",
        3,
        JSON.stringify(bundle),
        "2026-07-17T00:00:00.000Z",
        "2026-07-18T00:00:00.000Z",
      ],
    });

    try {
      const migration = readFileSync(
        new URL("../src/storage/drizzle/sqlite/0008_dry_supreme_intelligence.sql", import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.execute(statement);
      }
      const database = drizzle(client, { schema: sqliteSchema });
      const store = new BackendAuthStateStore({ dialect: "sqlite", db: database });
      await expect(store.readTokenBundle("github")).resolves.toEqual({ bundle, generation: 3 });
      expect(
        (await client.execute("select count(*) as count from host_state_records")).rows[0],
      ).toEqual({
        count: 0,
      });
      expect(await database.select().from(backendAuthStates).all()).toMatchObject([
        { server: "github", generation: 3, tokenBundle: bundle },
      ]);
    } finally {
      client.close();
    }
  });
});
