import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { executeWithIdempotency } from "../src/admin-api/idempotency";
import { stableJsonStringify } from "../src/stable-json";
import * as sqlite from "../src/storage/schema/sqlite";
import {
  createHostStorage,
  MAX_IDEMPOTENCY_FINAL_BODY_BYTES,
  type HostStorage,
  type IdempotencyClaimInput,
  type IdempotencyStoreOptions,
} from "../src/storage";

const NOW = new Date("2026-07-20T12:00:00.000Z");
const BASE_CLAIM = {
  principalClientId: "operator-1",
  operationId: "caplets.create",
  idempotencyKey: "request-1",
  requestFingerprintSource: '{"request":"first"}',
  reconciliationLinks: ["/v2/admin/caplets/example"],
} satisfies Omit<IdempotencyClaimInput, "now">;
const directories: string[] = [];
const storages = new Set<HostStorage>();

afterEach(async () => {
  await Promise.allSettled([...storages].map(async (storage) => await storage.close()));
  storages.clear();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("acquires the first claim", async () => {
  const storage = await openStorage();

  await expect(storage.idempotency.claim(claimAt(NOW))).resolves.toMatchObject({
    outcome: "acquired",
    ownerToken: expect.any(String),
  });
});

it("does not persist an offline verifier for Vault plaintext requests", async () => {
  const storage = await openStorage();
  const validatedRequest = {
    method: "PUT",
    path: { key: "DATABASE_PASSWORD" },
    query: {},
    mediaType: "application/json",
    body: { value: "correct horse battery staple" },
  };

  const executeRequest = async (target: HostStorage) =>
    await executeWithIdempotency({
      store: target.idempotency,
      principalClientId: BASE_CLAIM.principalClientId,
      operationId: "adminV2PutVaultValue",
      idempotencyKey: "vault-secret-request",
      validatedRequest,
      execute: async () => response("stored"),
    });

  await expect(executeRequest(storage)).resolves.toMatchObject({
    outcome: "response",
    replayed: false,
  });

  if (storage.database.dialect !== "sqlite") throw new Error("expected SQLite storage");
  const row = storage.database.db
    .select({ requestHash: sqlite.idempotencyRecords.requestHash })
    .from(sqlite.idempotencyRecords)
    .limit(1)
    .get();
  const unkeyedVerifier = createHash("sha256")
    .update(stableJsonStringify(validatedRequest))
    .digest("hex");

  expect(row?.requestHash).toMatch(/^hmac-sha256:[a-f0-9]{64}$/u);
  expect(row?.requestHash).not.toBe(`hmac-sha256:${unkeyedVerifier}`);
});

it("has one winner when separate SQLite instances claim concurrently", async () => {
  const path = temporaryDatabasePath();
  const first = await openStorage(path);
  const second = await openStorage(path);

  const results = await Promise.all([
    first.idempotency.claim(claimAt(NOW)),
    second.idempotency.claim(claimAt(NOW)),
  ]);

  expect(results.map((result) => result.outcome).sort()).toEqual(["acquired", "in_progress"]);
});

it("returns in-progress with Retry-After for a matching live claim", async () => {
  const storage = await openStorage(undefined, { pendingTtlMs: 10_000 });
  await storage.idempotency.claim(claimAt(NOW));

  await expect(storage.idempotency.claim(claimAt(after(2_500)))).resolves.toEqual({
    outcome: "in_progress",
    retryAfterSeconds: 8,
  });
});

it("conflicts whenever the same key has a different request hash", async () => {
  const storage = await openStorage();
  const acquired = await storage.idempotency.claim(claimAt(NOW));
  expect(acquired.outcome).toBe("acquired");

  await expect(
    storage.idempotency.claim({
      ...claimAt(NOW),
      requestFingerprintSource: '{"request":"different"}',
    }),
  ).resolves.toEqual({ outcome: "conflict" });
  if (acquired.outcome !== "acquired") throw new Error("expected an acquired claim");
  await storage.idempotency.finalize({
    ...recordKey(),
    ownerToken: acquired.ownerToken,
    response: response("final"),
    now: after(1_000),
  });
  await expect(
    storage.idempotency.claim({
      ...claimAt(after(2_000)),
      requestFingerprintSource: '{"request":"still-different"}',
    }),
  ).resolves.toEqual({ outcome: "conflict" });
});

it("heartbeats a live owner and extends its in-progress window", async () => {
  const storage = await openStorage(undefined, { pendingTtlMs: 10_000 });
  const acquired = await storage.idempotency.claim(claimAt(NOW));
  if (acquired.outcome !== "acquired") throw new Error("expected an acquired claim");

  await expect(
    storage.idempotency.heartbeat({
      ...recordKey(),
      ownerToken: acquired.ownerToken,
      now: after(9_000),
    }),
  ).resolves.toBe(true);
  await expect(storage.idempotency.claim(claimAt(after(15_000)))).resolves.toEqual({
    outcome: "in_progress",
    retryAfterSeconds: 4,
  });
});

it("fences non-owners from heartbeat and finalization", async () => {
  const storage = await openStorage();
  const acquired = await storage.idempotency.claim(claimAt(NOW));
  if (acquired.outcome !== "acquired") throw new Error("expected an acquired claim");

  await expect(
    storage.idempotency.heartbeat({
      ...recordKey(),
      ownerToken: "not-the-owner",
      now: after(1_000),
    }),
  ).resolves.toBe(false);
  await expect(
    storage.idempotency.finalize({
      ...recordKey(),
      ownerToken: "not-the-owner",
      response: response("wrong"),
      now: after(2_000),
    }),
  ).resolves.toBe(false);
  await expect(
    storage.idempotency.finalize({
      ...recordKey(),
      ownerToken: acquired.ownerToken,
      response: response("right"),
      now: after(2_000),
    }),
  ).resolves.toBe(true);
});

it("fails closed when a matching owner finalizes after its claim TTL", async () => {
  const storage = await openStorage(undefined, { pendingTtlMs: 1_000 });
  const acquired = await storage.idempotency.claim(claimAt(NOW));
  if (acquired.outcome !== "acquired") throw new Error("expected an acquired claim");

  await expect(
    storage.idempotency.finalize({
      ...recordKey(),
      ownerToken: acquired.ownerToken,
      response: response("late"),
      now: after(1_001),
    }),
  ).resolves.toBe(false);
  await expect(storage.idempotency.claim(claimAt(after(1_001)))).resolves.toEqual({
    outcome: "unknown",
    reconciliationLinks: BASE_CLAIM.reconciliationLinks,
  });
});

it("replays the exact finalized response", async () => {
  const storage = await openStorage();
  const acquired = await storage.idempotency.claim(claimAt(NOW));
  if (acquired.outcome !== "acquired") throw new Error("expected an acquired claim");
  const finalResponse = {
    status: 422,
    contentType: "application/problem+json; charset=utf-8",
    body: '{"detail":"café 東京 \\\\n"}',
  };

  await expect(
    storage.idempotency.finalize({
      ...recordKey(),
      ownerToken: acquired.ownerToken,
      response: finalResponse,
      now: after(1_000),
    }),
  ).resolves.toBe(true);
  await expect(
    storage.idempotency.finalize({
      ...recordKey(),
      ownerToken: acquired.ownerToken,
      response: response("replacement"),
      now: after(1_500),
    }),
  ).resolves.toBe(false);
  await expect(storage.idempotency.claim(claimAt(after(2_000)))).resolves.toEqual({
    outcome: "replay",
    response: finalResponse,
  });
});

it("accepts a 1 MiB UTF-8 body and rejects one byte more before mutation", async () => {
  const storage = await openStorage();
  const acquired = await storage.idempotency.claim(claimAt(NOW));
  if (acquired.outcome !== "acquired") throw new Error("expected an acquired claim");
  const oneMiB = "é".repeat(MAX_IDEMPOTENCY_FINAL_BODY_BYTES / 2);

  await expect(
    storage.idempotency.finalize({
      ...recordKey(),
      ownerToken: acquired.ownerToken,
      response: response(`${oneMiB}a`),
      now: after(1_000),
    }),
  ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  await expect(
    storage.idempotency.finalize({
      ...recordKey(),
      ownerToken: acquired.ownerToken,
      response: response(oneMiB),
      now: after(1_000),
    }),
  ).resolves.toBe(true);
  const replay = await storage.idempotency.claim(claimAt(after(2_000)));
  expect(replay).toMatchObject({ outcome: "replay" });
  if (replay.outcome !== "replay") throw new Error("expected replay");
  expect(Buffer.byteLength(replay.response.body, "utf8")).toBe(MAX_IDEMPOTENCY_FINAL_BODY_BYTES);
  expect(replay.response.body).toBe(oneMiB);
});

it("atomically changes a stale pending claim to unknown and never reclaims it", async () => {
  const storage = await openStorage(undefined, { pendingTtlMs: 1_000 });
  const acquired = await storage.idempotency.claim(claimAt(NOW));
  if (acquired.outcome !== "acquired") throw new Error("expected an acquired claim");

  await expect(storage.idempotency.claim(claimAt(after(1_000)))).resolves.toEqual({
    outcome: "unknown",
    reconciliationLinks: BASE_CLAIM.reconciliationLinks,
  });
  await expect(storage.idempotency.claim(claimAt(after(2_000)))).resolves.toEqual({
    outcome: "unknown",
    reconciliationLinks: BASE_CLAIM.reconciliationLinks,
  });
  await expect(
    storage.idempotency.claim({
      ...claimAt(after(2_000)),
      requestFingerprintSource: '{"request":"different-after-unknown"}',
    }),
  ).resolves.toEqual({ outcome: "conflict" });
  await expect(
    storage.idempotency.finalize({
      ...recordKey(),
      ownerToken: acquired.ownerToken,
      response: response("late"),
      now: after(2_000),
    }),
  ).resolves.toBe(false);
});

it("transitions stale pending rows before pruning expired terminal rows", async () => {
  const storage = await openStorage(undefined, { pendingTtlMs: 1_000, retentionMs: 2_000 });
  await storage.idempotency.claim(claimAt(NOW));

  await expect(storage.idempotency.prune({ now: after(1_000) })).resolves.toEqual({
    transitionedToUnknown: 1,
    deleted: 0,
  });
  await expect(storage.idempotency.prune({ now: after(2_999) })).resolves.toEqual({
    transitionedToUnknown: 0,
    deleted: 0,
  });
  await expect(storage.idempotency.prune({ now: after(3_000) })).resolves.toEqual({
    transitionedToUnknown: 0,
    deleted: 1,
  });
  await expect(storage.idempotency.claim(claimAt(after(3_000)))).resolves.toMatchObject({
    outcome: "acquired",
  });
});

it("prunes finalized rows only after retention expires", async () => {
  const storage = await openStorage(undefined, { retentionMs: 1_000 });
  const acquired = await storage.idempotency.claim(claimAt(NOW));
  if (acquired.outcome !== "acquired") throw new Error("expected an acquired claim");
  await storage.idempotency.finalize({
    ...recordKey(),
    ownerToken: acquired.ownerToken,
    response: response("retained"),
    now: NOW,
  });

  await expect(storage.idempotency.prune({ now: after(999) })).resolves.toEqual({
    transitionedToUnknown: 0,
    deleted: 0,
  });
  await expect(storage.idempotency.prune({ now: after(1_000) })).resolves.toEqual({
    transitionedToUnknown: 0,
    deleted: 1,
  });
});

it("enforces the principal row bound without removing live pending or unknown rows", async () => {
  const storage = await openStorage(undefined, {
    pendingTtlMs: 1_000,
    retentionMs: 10_000,
    maxRowsPerPrincipal: 2,
  });
  const unknownClaim = { ...claimAt(NOW), idempotencyKey: "unknown-key" };
  await storage.idempotency.claim(unknownClaim);
  await expect(
    storage.idempotency.claim({ ...unknownClaim, now: after(1_000) }),
  ).resolves.toMatchObject({ outcome: "unknown" });
  const liveClaim = { ...claimAt(after(1_000)), idempotencyKey: "live-key" };
  await storage.idempotency.claim(liveClaim);

  await expect(
    storage.idempotency.claim({ ...claimAt(after(1_000)), idempotencyKey: "third-key" }),
  ).resolves.toEqual({ outcome: "capacity_exceeded" });
  await expect(
    storage.idempotency.claim({ ...unknownClaim, now: after(1_000) }),
  ).resolves.toMatchObject({ outcome: "unknown" });
  await expect(storage.idempotency.claim(liveClaim)).resolves.toMatchObject({
    outcome: "in_progress",
  });
  await expect(
    storage.idempotency.claim({
      ...claimAt(after(1_000)),
      principalClientId: "operator-2",
      idempotencyKey: "other-principal",
    }),
  ).resolves.toMatchObject({ outcome: "acquired" });
});

it("encrypts OAuth authorization responses at rest and replays them after reopen", async () => {
  const path = temporaryDatabasePath();
  const first = await openStorage(path);
  const acquired = await first.idempotency.claim(claimAt(NOW));
  if (acquired.outcome !== "acquired") throw new Error("expected an acquired claim");
  const authorizationUrl =
    "https://accounts.example.test/oauth/authorize?state=oauth-state-secret&code_challenge=pkce-secret";
  const finalized = {
    status: 201,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ authorizationUrl, state: "oauth-state-secret" }),
  };
  await first.idempotency.finalize({
    ...recordKey(),
    ownerToken: acquired.ownerToken,
    response: finalized,
    now: after(1_000),
  });

  if (first.database.dialect !== "sqlite") throw new Error("expected SQLite storage");
  const stored = first.database.db
    .select({ responseBody: sqlite.idempotencyRecords.responseBody })
    .from(sqlite.idempotencyRecords)
    .limit(1)
    .get();
  expect(stored?.responseBody).not.toContain(authorizationUrl);
  expect(stored?.responseBody).not.toContain("oauth-state-secret");
  expect(stored?.responseBody).not.toContain("pkce-secret");

  await first.close();
  storages.delete(first);
  const second = await openStorage(path);
  await expect(second.idempotency.claim(claimAt(after(2_000)))).resolves.toEqual({
    outcome: "replay",
    response: finalized,
  });
});

it("rejects tampered, malformed, or identity-relocated finalized response envelopes", async () => {
  const storage = await openStorage();
  const acquired = await storage.idempotency.claim(claimAt(NOW));
  if (acquired.outcome !== "acquired") throw new Error("expected an acquired claim");
  await storage.idempotency.finalize({
    ...recordKey(),
    ownerToken: acquired.ownerToken,
    response: response("oauth-state-secret"),
    now: after(1_000),
  });
  if (storage.database.dialect !== "sqlite") throw new Error("expected SQLite storage");
  const stored = storage.database.db
    .select({ responseBody: sqlite.idempotencyRecords.responseBody })
    .from(sqlite.idempotencyRecords)
    .where(eq(sqlite.idempotencyRecords.idempotencyKey, BASE_CLAIM.idempotencyKey))
    .get();
  if (!stored?.responseBody) throw new Error("expected an encrypted finalized body");
  const envelope = JSON.parse(stored.responseBody) as { ciphertext: string };
  const tamperedCiphertext = `${envelope.ciphertext.startsWith("A") ? "B" : "A"}${envelope.ciphertext.slice(1)}`;
  storage.database.db
    .update(sqlite.idempotencyRecords)
    .set({ responseBody: JSON.stringify({ ...envelope, ciphertext: tamperedCiphertext }) })
    .where(eq(sqlite.idempotencyRecords.idempotencyKey, BASE_CLAIM.idempotencyKey))
    .run();
  await expect(storage.idempotency.claim(claimAt(after(2_000)))).rejects.toMatchObject({
    code: "CONFIG_INVALID",
    message: expect.not.stringContaining("oauth-state-secret"),
  });

  storage.database.db
    .update(sqlite.idempotencyRecords)
    .set({ responseBody: stored.responseBody, idempotencyKey: "relocated-request" })
    .where(eq(sqlite.idempotencyRecords.idempotencyKey, BASE_CLAIM.idempotencyKey))
    .run();
  const relocatedClaim = { ...claimAt(after(2_000)), idempotencyKey: "relocated-request" };
  await expect(storage.idempotency.claim(relocatedClaim)).rejects.toMatchObject({
    code: "CONFIG_INVALID",
  });

  storage.database.db
    .update(sqlite.idempotencyRecords)
    .set({ responseBody: "oauth-state-secret" })
    .where(eq(sqlite.idempotencyRecords.idempotencyKey, "relocated-request"))
    .run();
  await expect(storage.idempotency.claim(relocatedClaim)).rejects.toMatchObject({
    code: "CONFIG_INVALID",
    message: expect.not.stringContaining("oauth-state-secret"),
  });
});

it("uses HostStorage CAPLETS_ENCRYPTION_KEY_FILE wiring for finalized replay bodies", async () => {
  const path = temporaryDatabasePath();
  const externalKeyFile = join(dirname(path), "shared-encryption-key");
  writeFileSync(externalKeyFile, Buffer.alloc(32, 42).toString("base64url"), { mode: 0o600 });
  const env = { CAPLETS_ENCRYPTION_KEY_FILE: externalKeyFile };
  const first = await openStorage(path, undefined, env);
  const acquired = await first.idempotency.claim(claimAt(NOW));
  if (acquired.outcome !== "acquired") throw new Error("expected an acquired claim");
  await first.idempotency.finalize({
    ...recordKey(),
    ownerToken: acquired.ownerToken,
    response: response("external-file-replay-secret"),
    now: after(1_000),
  });
  expect(existsSync(join(dirname(path), "vault", "vault-key"))).toBe(false);
  await first.close();
  storages.delete(first);

  const second = await openStorage(path, undefined, env);
  await expect(second.idempotency.claim(claimAt(after(2_000)))).resolves.toEqual({
    outcome: "replay",
    response: response("external-file-replay-secret"),
  });
});

it("accepts only 1-128 visible ASCII key characters", async () => {
  const storage = await openStorage();
  await expect(
    storage.idempotency.claim({ ...claimAt(NOW), idempotencyKey: "x".repeat(128) }),
  ).resolves.toMatchObject({ outcome: "acquired" });
  await expect(
    storage.idempotency.claim({ ...claimAt(NOW), idempotencyKey: "x".repeat(129) }),
  ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  await expect(
    storage.idempotency.claim({ ...claimAt(NOW), idempotencyKey: "not visible" }),
  ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
});

it("validates claims before opportunistic database pruning", async () => {
  const storage = await openStorage(undefined, { pendingTtlMs: 1_000 });
  const acquired = await storage.idempotency.claim(claimAt(NOW));
  if (acquired.outcome !== "acquired") throw new Error("expected an acquired claim");

  await expect(
    storage.idempotency.claim({ ...claimAt(after(2_000)), idempotencyKey: "has space" }),
  ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  await expect(
    storage.idempotency.finalize({
      ...recordKey(),
      ownerToken: acquired.ownerToken,
      response: response("still-owned"),
      now: after(500),
    }),
  ).resolves.toBe(true);
});

function claimAt(now: Date): IdempotencyClaimInput {
  return { ...BASE_CLAIM, now };
}

function recordKey() {
  return {
    principalClientId: BASE_CLAIM.principalClientId,
    operationId: BASE_CLAIM.operationId,
    idempotencyKey: BASE_CLAIM.idempotencyKey,
  };
}

function response(body: string) {
  return { status: 201, contentType: "application/json; charset=utf-8", body };
}

function after(milliseconds: number): Date {
  return new Date(NOW.getTime() + milliseconds);
}

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "caplets-idempotency-"));
  directories.push(directory);
  return join(directory, "caplets.sqlite3");
}

async function openStorage(
  path?: string,
  idempotency?: IdempotencyStoreOptions,
  env?: Record<string, string | undefined>,
): Promise<HostStorage> {
  const databasePath = path ?? temporaryDatabasePath();
  const storage = await createHostStorage(
    { type: "sqlite", path: databasePath },
    { idempotency, vaultRoot: join(dirname(databasePath), "vault"), env },
  );
  storages.add(storage);
  return storage;
}
