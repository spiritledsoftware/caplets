import { readFileSync } from "node:fs";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { BackendAuthStateStore } from "../src/storage/backend-auth";
import { backendAuthStates, operatorActivity, sqliteSchema } from "../src/storage/schema/sqlite";

describe("BackendAuthStateStore dedicated SQL table", () => {
  it("keeps CAS state and sanitized activity atomic", async () => {
    const client = new BetterSqlite3(":memory:");
    client.exec(`
      create table backend_auth_states (
        server text primary key not null,
        generation integer not null,
        token_bundle text not null,
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

      client.exec(`
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
      expect(database.select().from(backendAuthStates).all()).toHaveLength(1);
      expect(database.select().from(operatorActivity).all()).toMatchObject([
        {
          operatorClientId: "operator-1",
          action: "backend_auth_written",
          targetKey: "github",
          metadata: { generation: 1 },
        },
      ]);
      expect(JSON.stringify(database.select().from(operatorActivity).all())).not.toContain(
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
    }
  });

  it("migrates legacy generic backend auth rows into the dedicated table", async () => {
    const client = new BetterSqlite3(":memory:");
    const bundle = { server: "github", accessToken: "existing-secret" };
    client.exec(`
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
    client
      .prepare(`
      insert into host_state_records
        (namespace, state_key, generation, payload, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?)
    `)
      .run(
        "backend-auth",
        "github",
        3,
        JSON.stringify(bundle),
        "2026-07-17T00:00:00.000Z",
        "2026-07-18T00:00:00.000Z",
      );

    try {
      const migration = readFileSync(
        new URL("../src/storage/drizzle/sqlite/0008_dry_supreme_intelligence.sql", import.meta.url),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) client.exec(statement);
      }
      const database = drizzle(client, { schema: sqliteSchema });
      const store = new BackendAuthStateStore({ dialect: "sqlite", db: database });
      await expect(store.readTokenBundle("github")).resolves.toEqual({ bundle, generation: 3 });
      expect(client.prepare("select count(*) as count from host_state_records").get()).toEqual({
        count: 0,
      });
      expect(database.select().from(backendAuthStates).all()).toMatchObject([
        { server: "github", generation: 3, tokenBundle: bundle },
      ]);
    } finally {
      client.close();
    }
  });
});
