import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterEach, expect, it } from "vitest";
import {
  createHostStorage,
  migrateHostStorage,
  type CapletInstallationView,
  type HostStorage,
  type PostgresHostStorageConfig,
} from "../src/storage";

const connectionString = process.env.CAPLETS_TEST_POSTGRES_URL;
if (process.env.CAPLETS_REQUIRE_TEST_POSTGRES === "1" && !connectionString) {
  throw new Error("CAPLETS_TEST_POSTGRES_URL is required when CAPLETS_REQUIRE_TEST_POSTGRES=1.");
}
const postgresIt = connectionString ? it : it.skip;
const schemas = new Set<string>();
const storages = new Set<HostStorage>();
const operator = { clientId: "operator-postgres", role: "operator" } as const;

async function openPair(): Promise<[HostStorage, HostStorage]> {
  const schema = `caplets_pg_installations_${randomUUID().replaceAll("-", "")}`;
  schemas.add(schema);
  const config: PostgresHostStorageConfig = {
    type: "postgres",
    connectionString: connectionString!,
    schema,
  };
  await migrateHostStorage(config);
  const first = await createHostStorage(config);
  const second = await createHostStorage(config);
  storages.add(first);
  storages.add(second);
  return [first, second];
}

async function importRecord(storage: HostStorage, id: string): Promise<void> {
  await storage.caplets.importBundle({
    id,
    operator,
    files: [
      {
        path: "CAPLET.md",
        content: Buffer.from(
          `---\nname: PostgreSQL ${id}\ndescription: PostgreSQL installation contract.\nmcpServer:\n  command: test-server\n---\n# ${id}\n`,
        ),
        executable: false,
      },
    ],
  });
}

afterEach(async () => {
  await Promise.allSettled([...storages].map(async (storage) => await storage.close()));
  storages.clear();
  if (!connectionString || schemas.size === 0) return;
  const pool = new Pool({ connectionString });
  try {
    for (const schema of schemas) await pool.query(`drop schema if exists "${schema}" cascade`);
  } finally {
    schemas.clear();
    await pool.end();
  }
});

postgresIt(
  "atomically creates one exact installation key and rolls back its collision",
  async () => {
    const [first, second] = await openPair();
    await importRecord(first, "alpha");
    await importRecord(first, "beta");
    await expect(first.coordination.currentConfigGeneration()).resolves.toBe(2);

    const installationKey = "Installation_Exact_postgres_Zz";
    const attempts = await Promise.allSettled([
      first.installations.install({
        capletId: "alpha",
        installationKey,
        sourceKind: "catalog",
        sourceIdentity: "official/alpha",
        operator,
      }),
      second.installations.install({
        capletId: "beta",
        installationKey,
        sourceKind: "catalog",
        sourceIdentity: "official/beta",
        operator,
      }),
    ]);

    const fulfilled = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<CapletInstallationView> =>
        attempt.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "CONFIG_EXISTS" });
    expect(fulfilled[0]!.value).toMatchObject({ installationKey, generation: 1, status: "active" });

    const winner = fulfilled[0]!.value.capletId;
    const loser = winner === "alpha" ? "beta" : "alpha";
    await expect(second.installations.getByKey(installationKey)).resolves.toMatchObject({
      installationKey,
      capletId: winner,
    });
    await expect(first.installations.getActive(loser)).resolves.toBeUndefined();
    await expect(second.coordination.currentConfigGeneration()).resolves.toBe(3);
    expect(
      (await first.installations.listActivity()).filter(
        (entry) => entry.action === "caplet.install" && entry.targetKey === installationKey,
      ),
    ).toHaveLength(1);

    const detached = await first.installations.detach({
      capletId: winner,
      installationKey,
      expectedGeneration: 1,
      operator,
    });
    const replacement = await second.installations.replaceDetached({
      capletId: winner,
      detachedInstallationKey: installationKey,
      expectedGeneration: detached!.generation,
      sourceKind: "catalog",
      sourceIdentity: `official/${winner}/replacement`,
      operator,
    });
    await first.installations.appendObservation({
      capletId: winner,
      expectedGeneration: replacement.generation,
      status: "current",
      operator,
    });
    const currentReplacement = await first.installations.getActive(winner);
    if (!currentReplacement) throw new Error("Expected replacement installation.");
    const historicalDelete = await second.installations.detach({
      capletId: winner,
      installationKey,
      expectedGeneration: detached!.generation,
      operator,
    });
    expect(historicalDelete).toMatchObject({
      installationKey,
      status: "detached",
    });
    await expect(first.installations.getActive(winner)).resolves.toMatchObject({
      installationKey: currentReplacement.installationKey,
      generation: currentReplacement.generation,
      status: "active",
    });
    if (first.database.dialect !== "postgres") throw new Error("Expected PostgreSQL storage.");
    await first.database.db.execute(sql`
    update caplet_installations
    set updated_at = '2026-07-20T12:00:00.000Z'
    where record_key = ${replacement.recordKey}
  `);

    const firstPage = await first.installations.listPage(winner, { limit: 1 });
    const secondPage = await second.installations.listPage(winner, {
      limit: 1,
      after: firstPage.nextKey,
    });
    expect([...firstPage.items, ...secondPage.items].map((item) => item.installationKey)).toEqual(
      [installationKey, replacement.installationKey].toSorted().reverse(),
    );
    expect(secondPage.nextKey).toBeUndefined();
  },
);
