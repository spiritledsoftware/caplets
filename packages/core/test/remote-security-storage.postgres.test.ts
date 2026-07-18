import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, expect, it } from "vitest";
import { createHostStorage, migrateHostStorage } from "../src/storage";
import { RemoteSecurityStore } from "../src/storage/remote-security";

const postgresUrl = process.env.CAPLETS_TEST_POSTGRES_URL;
const postgresIt = postgresUrl ? it : it.skip;
const schemas: string[] = [];

afterEach(async () => {
  if (!postgresUrl) return;
  const pool = new Pool({ connectionString: postgresUrl });
  try {
    for (const schema of schemas.splice(0)) {
      await pool.query(`drop schema if exists "${schema}" cascade`);
    }
  } finally {
    await pool.end();
  }
});

postgresIt("keeps pairing exchange and refresh rotation one-time on PostgreSQL", async () => {
  const schema = `caplets_remote_security_${randomUUID().replaceAll("-", "")}`;
  schemas.push(schema);
  const config = {
    type: "postgres" as const,
    connectionString: postgresUrl!,
    schema,
  };
  await migrateHostStorage(config);
  const storage = await createHostStorage(config);
  try {
    const security = new RemoteSecurityStore(storage.database);
    const hostUrl = "https://remote.example.test";
    const pairing = await security.createPairingCode({ hostUrl });
    const exchanges = await Promise.allSettled([
      security.exchangePairingCode({ hostUrl, code: pairing.code }),
      security.exchangePairingCode({ hostUrl, code: pairing.code }),
    ]);
    const issued = exchanges.find((result) => result.status === "fulfilled");
    expect(issued?.status).toBe("fulfilled");
    expect(exchanges.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    if (!issued || issued.status !== "fulfilled") throw new Error("Pairing did not succeed.");

    const refreshes = await Promise.allSettled([
      security.refreshClientCredentials({ hostUrl, refreshToken: issued.value.refreshToken }),
      security.refreshClientCredentials({ hostUrl, refreshToken: issued.value.refreshToken }),
    ]);
    expect(refreshes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(refreshes.filter((result) => result.status === "rejected")).toHaveLength(1);
  } finally {
    await storage.close();
  }
});
