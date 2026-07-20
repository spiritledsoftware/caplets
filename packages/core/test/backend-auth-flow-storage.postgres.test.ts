import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { GenericBackendAuthFlowState } from "../src/auth";
import {
  createHostStorage,
  migrateHostStorage,
  type HostStorage,
  type PostgresHostStorageConfig,
} from "../src/storage";
import * as postgres from "../src/storage/schema/postgres";

const NOW = new Date("2026-07-20T12:00:00.000Z");
const KEY = Buffer.alloc(32, 29).toString("base64url");
const SERVER = "github";
const postgresUrl = process.env.CAPLETS_TEST_POSTGRES_URL;
if (process.env.CAPLETS_REQUIRE_TEST_POSTGRES === "1" && !postgresUrl) {
  throw new Error("CAPLETS_TEST_POSTGRES_URL is required when CAPLETS_REQUIRE_TEST_POSTGRES=1.");
}
const postgresIt = postgresUrl ? it : it.skip;
const schemas = new Set<string>();
const storages = new Set<HostStorage>();
const originalEncryptionKey = process.env.CAPLETS_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.CAPLETS_ENCRYPTION_KEY = KEY;
});

afterEach(async () => {
  if (originalEncryptionKey === undefined) delete process.env.CAPLETS_ENCRYPTION_KEY;
  else process.env.CAPLETS_ENCRYPTION_KEY = originalEncryptionKey;

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

postgresIt("round-trips encrypted flow state across HostStorage instances", async () => {
  const { first, second, firstVaultRoot, secondVaultRoot } = await openPair("round_trip");
  const flowId = "postgres_round_trip";
  const secret = "postgres-pkce-round-trip-secret";
  const state = flowState(flowId, {
    pkceVerifier: secret,
    startingBackendAuthGeneration: 4,
  });

  expect(first.backendAuthFlows.root).toBe(firstVaultRoot);
  expect(first.backendAuthFlows.keyFile).toBe(join(firstVaultRoot, "vault-key"));
  expect(second.backendAuthFlows.root).toBe(secondVaultRoot);
  expect(second.backendAuthFlows.keyFile).toBe(join(secondVaultRoot, "vault-key"));
  expect(firstVaultRoot).not.toBe(secondVaultRoot);
  expect(first.backendAuthFlows.root).toBe(first.vaultValues.root);
  expect(first.backendAuthFlows.keyFile).toBe(first.vaultValues.keyFile);

  await expect(
    first.backendAuthFlows.create({
      flowId,
      server: SERVER,
      state,
      expiresAt: after(10_000),
      startingBackendAuthGeneration: 4,
      now: NOW,
    }),
  ).resolves.toMatchObject({ flowId, server: SERVER, status: "pending" });

  const raw = await rawRow(first, flowId);
  expect(JSON.stringify(raw)).not.toContain(secret);
  expect(raw.encryptedPayload).toMatchObject({
    version: 1,
    algorithm: "aes-256-gcm",
    nonce: expect.any(String),
    ciphertext: expect.any(String),
    authTag: expect.any(String),
  });
  expect(JSON.stringify(await second.backendAuthFlows.list({ now: NOW }))).not.toContain(secret);

  await expect(
    second.backendAuthFlows.claim({
      flowId,
      claimToken: "postgres_round_trip_claim",
      now: after(1_000),
    }),
  ).resolves.toMatchObject({
    acquired: true,
    claimToken: "postgres_round_trip_claim",
    startingBackendAuthGeneration: 4,
    state,
  });
});

postgresIt("fails closed without a valid shared encryption key across local roots", async () => {
  const { first, second, firstVaultRoot, secondVaultRoot } = await openPair("shared_key");
  const flowId = "postgres_shared_key_required";
  await first.backendAuthFlows.create({
    flowId,
    server: SERVER,
    state: flowState(flowId),
    expiresAt: after(10_000),
    now: NOW,
  });

  delete process.env.CAPLETS_ENCRYPTION_KEY;
  await expect(
    second.backendAuthFlows.claim({
      flowId,
      claimToken: "postgres_missing_key_claim",
      now: after(1_000),
    }),
  ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  expect(await rawRow(first, flowId)).toMatchObject({ status: "pending", claimToken: null });
  expect(existsSync(join(firstVaultRoot, "vault-key"))).toBe(false);
  expect(existsSync(join(secondVaultRoot, "vault-key"))).toBe(false);

  process.env.CAPLETS_ENCRYPTION_KEY = "invalid-shared-key";
  await expect(
    second.backendAuthFlows.create({
      flowId: "postgres_invalid_shared_key",
      server: SERVER,
      state: flowState("postgres_invalid_shared_key"),
      expiresAt: after(10_000),
      now: NOW,
    }),
  ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

  process.env.CAPLETS_ENCRYPTION_KEY = KEY;
  await expect(
    second.backendAuthFlows.claim({
      flowId,
      claimToken: "postgres_shared_key_claim",
      now: after(1_000),
    }),
  ).resolves.toMatchObject({ acquired: true });
});

postgresIt("guards cross-instance claim, release, and finalize CAS", async () => {
  const { first, second } = await openPair("cas");
  const flowId = "postgres_concurrent_claim";
  await first.backendAuthFlows.create({
    flowId,
    server: SERVER,
    state: flowState(flowId),
    completionCorrelation: "postgres_completion_correlation",
    expiresAt: after(10_000),
    startingBackendAuthGeneration: 0,
    now: NOW,
  });

  const claims = await Promise.all([
    first.backendAuthFlows.claim({
      flowId,
      claimToken: "postgres_claim_first",
      now: after(1_000),
    }),
    second.backendAuthFlows.claim({
      flowId,
      claimToken: "postgres_claim_second",
      now: after(1_000),
    }),
  ]);
  expect(claims.filter((claim) => claim.acquired)).toHaveLength(1);
  expect(claims.filter((claim) => !claim.acquired)).toEqual([
    expect.objectContaining({ acquired: false, reason: "in_progress" }),
  ]);
  const winner = claims.find((claim) => claim.acquired);
  if (!winner?.acquired) throw new Error("Expected exactly one PostgreSQL flow claim.");

  await expect(
    second.backendAuthFlows.release({
      flowId,
      claimToken: "postgres_claim_mismatch",
      now: after(1_500),
    }),
  ).resolves.toBe(false);
  await expect(
    first.backendAuthFlows.release({
      flowId,
      claimToken: winner.claimToken,
      now: after(1_500),
    }),
  ).resolves.toBe(true);

  const retried = await second.backendAuthFlows.claim({
    flowId,
    claimToken: "postgres_claim_retry",
    now: after(2_000),
  });
  if (!retried.acquired) {
    throw new Error("Expected released PostgreSQL flow to be claimable.");
  }
  await expect(
    first.backendAuthFlows.finalize({
      flowId,
      claimToken: retried.claimToken,
      completionCorrelation: "postgres_correlation_mismatch",
      backendAuthGeneration: 1,
      now: after(2_500),
    }),
  ).resolves.toBe(false);
  await expect(
    second.backendAuthFlows.finalize({
      flowId,
      claimToken: retried.claimToken,
      completionCorrelation: retried.completionCorrelation,
      backendAuthGeneration: 1,
      now: after(2_500),
    }),
  ).resolves.toBe(true);

  expect(await rawRow(first, flowId)).toMatchObject({
    status: "completed",
    encryptedPayload: null,
    startingBackendAuthGeneration: null,
    completionCorrelation: null,
    claimToken: null,
    claimedAt: null,
    completedBackendAuthGeneration: 1,
    terminalAt: after(2_500).toISOString(),
  });
});

postgresIt("allows only one generation-zero flow to commit atomically", async () => {
  const { first, second } = await openPair("atomic_empty_generation");
  const claims = [];
  for (const suffix of ["first", "second"]) {
    const flowId = `postgres_empty_generation_${suffix}`;
    await first.backendAuthFlows.create({
      flowId,
      server: SERVER,
      state: flowState(flowId),
      completionCorrelation: `postgres_empty_correlation_${suffix}`,
      startingBackendAuthGeneration: 0,
      expiresAt: after(10_000),
      now: NOW,
    });
    const claim = await first.backendAuthFlows.claim({
      flowId,
      claimToken: `postgres_empty_claim_${suffix}`,
      now: after(1_000),
    });
    if (!claim.acquired) throw new Error("Expected PostgreSQL completion claim.");
    claims.push(claim);
  }

  const completions = await Promise.allSettled(
    claims.map(
      async (claim, index) =>
        await (index === 0 ? first : second).backendAuthFlows.completeClaim({
          flowId: claim.flow.flowId,
          server: SERVER,
          claimToken: claim.claimToken,
          completionCorrelation: claim.completionCorrelation,
          expectedGeneration: 0,
          bundle: {
            server: SERVER,
            accessToken: `postgres-empty-token-${index}`,
            metadata: {
              backendAuthFlow: {
                flowId: claim.flow.flowId,
                completionCorrelation: claim.completionCorrelation,
              },
            },
          },
          now: after(2_000),
        }),
    ),
  );

  expect(completions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  await expect(first.backendAuth.readTokenBundle(SERVER)).resolves.toMatchObject({
    generation: 1,
  });
  const rows = await Promise.all(
    claims.map(async (claim) => await rawRow(first, claim.flow.flowId)),
  );
  expect(rows.filter((row) => row.status === "completed")).toHaveLength(1);
});

postgresIt("serializes abandoned claims across instances", async () => {
  const { first, second } = await openPair("reconcile");
  await createAndClaim(first, "postgres_reconciled", "postgres_reconciled_correlation");

  await expect(
    first.backendAuthFlows.reconcileAbandoned({
      flowId: "postgres_reconciled",
      abandonedBefore: after(500),
      observedCompletionCorrelation: "postgres_reconciled_correlation",
      observedBackendAuthGeneration: 7,
      now: after(1_500),
    }),
  ).resolves.toBeUndefined();

  const reconciliations = await Promise.all([
    first.backendAuthFlows.reconcileAbandoned({
      flowId: "postgres_reconciled",
      abandonedBefore: after(1_000),
      observedCompletionCorrelation: "postgres_reconciled_correlation",
      observedBackendAuthGeneration: 7,
      now: after(2_000),
    }),
    second.backendAuthFlows.reconcileAbandoned({
      flowId: "postgres_reconciled",
      abandonedBefore: after(1_000),
      observedCompletionCorrelation: "postgres_reconciled_correlation",
      observedBackendAuthGeneration: 7,
      now: after(2_000),
    }),
  ]);
  expect(reconciliations.filter((result) => result?.status === "completed")).toHaveLength(1);
  expect(reconciliations.filter((result) => result === undefined)).toHaveLength(1);
  expect(await rawRow(second, "postgres_reconciled")).toMatchObject({
    status: "completed",
    encryptedPayload: null,
    completionCorrelation: null,
    claimToken: null,
    completedBackendAuthGeneration: 7,
  });

  await createAndClaim(first, "postgres_unknown", "postgres_unknown_correlation");
  await expect(
    second.backendAuthFlows.reconcileAbandoned({
      flowId: "postgres_unknown",
      abandonedBefore: after(1_000),
      now: after(2_000),
    }),
  ).resolves.toMatchObject({ status: "unknown" });
  expect(await rawRow(first, "postgres_unknown")).toMatchObject({
    status: "unknown",
    encryptedPayload: null,
    completionCorrelation: null,
    claimToken: null,
    completedBackendAuthGeneration: null,
  });
});

postgresIt("scrubs expiry and races terminal pruning", async () => {
  const { first, second } = await openPair("expiry_prune");
  for (const flowId of ["postgres_expired_1", "postgres_expired_2", "postgres_expired_3"]) {
    await first.backendAuthFlows.create({
      flowId,
      server: SERVER,
      state: flowState(flowId, { pkceVerifier: `${flowId}-secret` }),
      expiresAt: after(1_000),
      now: NOW,
    });
  }
  await first.backendAuthFlows.create({
    flowId: "postgres_pending",
    server: SERVER,
    state: flowState("postgres_pending"),
    expiresAt: after(100_000),
    now: NOW,
  });

  await expect(
    second.backendAuthFlows.claim({
      flowId: "postgres_expired_1",
      claimToken: "postgres_expired_claim",
      now: after(1_001),
    }),
  ).resolves.toMatchObject({ acquired: false, reason: "expired" });
  await expect(first.backendAuthFlows.expireDue({ now: after(1_001) })).resolves.toBe(2);
  for (const flowId of ["postgres_expired_1", "postgres_expired_2", "postgres_expired_3"]) {
    expect(await rawRow(first, flowId)).toMatchObject({
      status: "expired",
      encryptedPayload: null,
      startingBackendAuthGeneration: null,
      completionCorrelation: null,
      claimToken: null,
      claimedAt: null,
      terminalAt: after(1_001).toISOString(),
    });
  }

  const pruned = await Promise.all([
    first.backendAuthFlows.prune({
      now: after(3_000),
      retentionMs: 0,
      limit: 2,
    }),
    second.backendAuthFlows.prune({
      now: after(3_000),
      retentionMs: 0,
      limit: 2,
    }),
  ]);
  expect(pruned[0] + pruned[1]).toBe(3);
  await expect(first.backendAuthFlows.get("postgres_pending", after(3_000))).resolves.toMatchObject(
    {
      status: "pending",
    },
  );
  await expect(first.backendAuthFlows.list({ now: after(3_000) })).resolves.toEqual([
    expect.objectContaining({ flowId: "postgres_pending", status: "pending" }),
  ]);
});

async function openPair(domain: string): Promise<{
  schema: string;
  firstVaultRoot: string;
  secondVaultRoot: string;
  first: HostStorage;
  second: HostStorage;
}> {
  const schema = `caplets_oauth_${domain.slice(0, 15)}_${randomUUID().replaceAll("-", "")}`;
  const firstVaultRoot = `/tmp/${schema}-first-vault`;
  const secondVaultRoot = `/tmp/${schema}-second-vault`;
  schemas.add(schema);
  const config: PostgresHostStorageConfig = {
    type: "postgres",
    connectionString: postgresUrl!,
    schema,
  };
  await migrateHostStorage(config);
  const first = await createHostStorage(config, { vaultRoot: firstVaultRoot });
  storages.add(first);
  const second = await createHostStorage(config, { vaultRoot: secondVaultRoot });
  storages.add(second);
  return { schema, firstVaultRoot, secondVaultRoot, first, second };
}

async function rawRow(storage: HostStorage, flowId: string) {
  if (storage.database.dialect !== "postgres") {
    throw new Error("Expected PostgreSQL storage.");
  }
  const [row] = await storage.database.db
    .select()
    .from(postgres.backendAuthFlows)
    .where(eq(postgres.backendAuthFlows.flowId, flowId))
    .limit(1);
  if (!row) throw new Error(`Missing backend auth flow ${flowId}.`);
  return row;
}

async function createAndClaim(
  storage: HostStorage,
  flowId: string,
  completionCorrelation: string,
): Promise<void> {
  await storage.backendAuthFlows.create({
    flowId,
    server: SERVER,
    state: flowState(flowId),
    completionCorrelation,
    expiresAt: after(10_000),
    startingBackendAuthGeneration: 0,
    now: NOW,
  });
  const claimed = await storage.backendAuthFlows.claim({
    flowId,
    claimToken: `${flowId}_claim`,
    now: after(1_000),
  });
  if (!claimed.acquired) throw new Error(`Could not claim backend auth flow ${flowId}.`);
}

function flowState(
  flowId: string,
  overrides: Partial<GenericBackendAuthFlowState> = {},
): GenericBackendAuthFlowState {
  return {
    version: 1,
    flowId,
    server: SERVER,
    provider: "generic",
    backend: "http",
    authType: "oauth2",
    redirectUri: "https://host.example/callback",
    stateVerifier: "postgres-state-secret",
    pkceVerifier: "postgres-pkce-secret",
    configurationFingerprint: "postgres-configuration-fingerprint",
    startingBackendAuthGeneration: 0,
    authorizationEndpoint: "https://oauth.example/authorize",
    tokenEndpoint: "https://oauth.example/token",
    clientId: "postgres-client",
    allowLoopbackHttp: false,
    createdAt: NOW.toISOString(),
    expiresAt: after(10_000).toISOString(),
    ...overrides,
  };
}

function after(milliseconds: number): Date {
  return new Date(NOW.getTime() + milliseconds);
}
