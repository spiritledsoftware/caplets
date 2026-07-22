import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import {
  createHostStorage,
  migrateHostStorage,
  type HostStorage,
  type PostgresHostStorageConfig,
} from "../src/storage";
import * as postgres from "../src/storage/schema/postgres";

const NOW = new Date("2026-07-20T12:00:00.000Z");
const KEY = Buffer.alloc(32, 41).toString("base64url");
const postgresUrl = process.env.CAPLETS_TEST_POSTGRES_URL;
if (process.env.CAPLETS_REQUIRE_TEST_POSTGRES === "1" && !postgresUrl) {
  throw new Error("CAPLETS_TEST_POSTGRES_URL is required when CAPLETS_REQUIRE_TEST_POSTGRES=1.");
}
const postgresIt = postgresUrl ? it : it.skip;
const schemas = new Set<string>();
const storages = new Set<HostStorage>();

afterEach(async () => {
  await Promise.allSettled([...storages].map(async (storage) => await storage.close()));
  storages.clear();
  if (!postgresUrl || schemas.size === 0) return;
  const pool = new Pool({ connectionString: postgresUrl });
  try {
    for (const schema of schemas) {
      await pool.query(`drop schema if exists "${schema}" cascade`);
    }
  } finally {
    schemas.clear();
    await pool.end();
  }
});

postgresIt("has one claim winner across PostgreSQL instances", async () => {
  const { first, second } = await openPair("race");

  const results = await Promise.all([
    first.idempotency.claim(claimAt(NOW)),
    second.idempotency.claim(claimAt(NOW)),
  ]);

  expect(results.map((result) => result.outcome).sort()).toEqual(["acquired", "in_progress"]);
});

postgresIt("atomically records stale PostgreSQL claims as unknown without reclaiming", async () => {
  const { first, second } = await openPair("stale", 1_000);
  const acquired = await first.idempotency.claim(claimAt(NOW));
  if (acquired.outcome !== "acquired") throw new Error("expected an acquired claim");

  await expect(second.idempotency.claim(claimAt(after(1_000)))).resolves.toEqual({
    outcome: "unknown",
    reconciliationLinks: ["/v2/admin/caplets/example"],
  });
  await expect(first.idempotency.claim(claimAt(after(2_000)))).resolves.toEqual({
    outcome: "unknown",
    reconciliationLinks: ["/v2/admin/caplets/example"],
  });
  await expect(
    first.idempotency.finalize({
      ...recordKey(),
      ownerToken: acquired.ownerToken,
      response: finalResponse("late"),
      now: after(2_000),
    }),
  ).resolves.toBe(false);
});

postgresIt("fails closed when a PostgreSQL owner finalizes after its claim TTL", async () => {
  const { first, second } = await openPair("stfin", 1_000);
  const acquired = await first.idempotency.claim(claimAt(NOW));
  if (acquired.outcome !== "acquired") throw new Error("expected an acquired claim");

  await expect(
    first.idempotency.finalize({
      ...recordKey(),
      ownerToken: acquired.ownerToken,
      response: finalResponse("late"),
      now: after(1_001),
    }),
  ).resolves.toBe(false);
  await expect(second.idempotency.claim(claimAt(after(1_001)))).resolves.toEqual({
    outcome: "unknown",
    reconciliationLinks: ["/v2/admin/caplets/example"],
  });
});

postgresIt(
  "encrypts and exactly replays finalized PostgreSQL responses across instances",
  async () => {
    const { first, second } = await openPair("replay");
    const acquired = await first.idempotency.claim(claimAt(NOW));
    if (acquired.outcome !== "acquired") throw new Error("expected an acquired claim");
    const authorizationUrl =
      "https://accounts.example.test/oauth/authorize?state=postgres-oauth-state&code_challenge=postgres-pkce-secret";
    const response = finalResponse(
      JSON.stringify({ authorizationUrl, state: "postgres-oauth-state", text: "café 東京" }),
    );

    await expect(
      first.idempotency.finalize({
        ...recordKey(),
        ownerToken: "not-the-owner",
        response: finalResponse("wrong"),
        now: after(500),
      }),
    ).resolves.toBe(false);
    await expect(
      first.idempotency.finalize({
        ...recordKey(),
        ownerToken: acquired.ownerToken,
        response,
        now: after(1_000),
      }),
    ).resolves.toBe(true);
    if (first.database.dialect !== "postgres") throw new Error("expected PostgreSQL storage");
    const [stored] = await first.database.db
      .select({ responseBody: postgres.idempotencyRecords.responseBody })
      .from(postgres.idempotencyRecords)
      .where(eq(postgres.idempotencyRecords.idempotencyKey, recordKey().idempotencyKey))
      .limit(1);
    expect(stored?.responseBody).not.toContain(authorizationUrl);
    expect(stored?.responseBody).not.toContain("postgres-oauth-state");
    expect(stored?.responseBody).not.toContain("postgres-pkce-secret");

    await expect(second.idempotency.claim(claimAt(after(2_000)))).resolves.toEqual({
      outcome: "replay",
      response,
    });
    await expect(
      second.idempotency.claim({
        ...claimAt(after(2_000)),
        requestFingerprintSource: '{"request":"different"}',
      }),
    ).resolves.toEqual({ outcome: "conflict" });

    await first.database.db
      .update(postgres.idempotencyRecords)
      .set({ responseBody: '{"version":1,"algorithm":"aes-256-gcm","nonce":"tampered"}' })
      .where(eq(postgres.idempotencyRecords.idempotencyKey, recordKey().idempotencyKey));
    await expect(second.idempotency.claim(claimAt(after(2_000)))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  },
);

postgresIt(
  "fails idempotency closed when PostgreSQL has no shared encryption key source",
  async () => {
    const { first } = await openPair("nokey", 30_000, {});

    await expect(first.idempotency.claim(claimAt(NOW))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("CAPLETS_ENCRYPTION_KEY or CAPLETS_ENCRYPTION_KEY_FILE"),
    });
  },
);

async function openPair(
  label: string,
  pendingTtlMs = 30_000,
  env: Record<string, string | undefined> = { CAPLETS_ENCRYPTION_KEY: KEY },
) {
  const schema = `caplets_idempotency_${label}_${randomUUID().replaceAll("-", "")}`;
  schemas.add(schema);
  const config: PostgresHostStorageConfig = {
    type: "postgres",
    connectionString: postgresUrl!,
    schema,
  };
  await migrateHostStorage(config);
  const first = await createHostStorage(config, { idempotency: { pendingTtlMs }, env });
  const second = await createHostStorage(config, { idempotency: { pendingTtlMs }, env });
  storages.add(first);
  storages.add(second);
  return { first, second };
}

function claimAt(now: Date) {
  return {
    ...recordKey(),
    requestFingerprintSource: '{"request":"first"}',
    reconciliationLinks: ["/v2/admin/caplets/example"],
    now,
  };
}

function recordKey() {
  return {
    principalClientId: "operator-1",
    operationId: "caplets.create",
    idempotencyKey: "request-1",
  };
}

function finalResponse(body: string) {
  return { status: 201, contentType: "application/json; charset=utf-8", body };
}

function after(milliseconds: number): Date {
  return new Date(NOW.getTime() + milliseconds);
}
