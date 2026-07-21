import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, it } from "vitest";
import {
  createHostStorage,
  migrateHostStorage,
  type PostgresHostStorageConfig,
} from "../src/storage";

const connectionString = process.env.CAPLETS_TEST_POSTGRES_URL;
if (process.env.CAPLETS_REQUIRE_TEST_POSTGRES === "1" && !connectionString) {
  throw new Error("CAPLETS_TEST_POSTGRES_URL is required when CAPLETS_REQUIRE_TEST_POSTGRES=1.");
}
const postgresIt = connectionString ? it : it.skip;

postgresIt("keyset-pages stable Operator Activity ties and filters on PostgreSQL", async () => {
  const schema = `caplets_pg_activity_page_${randomUUID().replaceAll("-", "")}`;
  const config: PostgresHostStorageConfig = {
    type: "postgres",
    connectionString: connectionString!,
    schema,
  };
  await migrateHostStorage(config);
  const storage = await createHostStorage(config);

  try {
    await storage.operatorActivity.importLegacyEntries([
      {
        id: "activity-c",
        createdAt: "2026-07-20T12:00:00.000Z",
        actorClientId: "operator-postgres",
        action: "vault_set",
        outcome: "success",
        target: { type: "vault", id: "C" },
      },
      {
        id: "activity-b",
        createdAt: "2026-07-20T12:00:00.000Z",
        actorClientId: "operator-postgres",
        action: "catalog_updated",
        outcome: "success",
        target: { type: "catalog", id: "B" },
      },
      {
        id: "activity-a",
        createdAt: "2026-07-20T12:00:00.000Z",
        actorClientId: "operator-postgres",
        action: "vault_set",
        outcome: "failure",
        target: { type: "vault", id: "A" },
      },
    ]);

    const first = await storage.operatorActivity.listPage({ limit: 2 });
    expect(first.items.map(({ id }) => id)).toEqual(["activity-c", "activity-b"]);
    expect(first.nextKey).toEqual({
      createdAt: "2026-07-20T12:00:00.000Z",
      activityKey: "activity-b",
    });
    await expect(
      storage.operatorActivity.listPage({ limit: 2, after: first.nextKey }),
    ).resolves.toEqual({
      items: [expect.objectContaining({ id: "activity-a" })],
    });
    await expect(
      storage.operatorActivity.listPage({ action: "vault_set", limit: 2 }),
    ).resolves.toEqual({
      items: [
        expect.objectContaining({ id: "activity-c" }),
        expect.objectContaining({ id: "activity-a" }),
      ],
    });
  } finally {
    await storage.close();
    const pool = new Pool({ connectionString });
    try {
      await pool.query(`drop schema if exists "${schema}" cascade`);
    } finally {
      await pool.end();
    }
  }
});
