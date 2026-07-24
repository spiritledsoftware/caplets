import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GenericBackendAuthFlowState } from "../src/auth";
import { createHostStorage, migrateHostStorage, type HostStorage } from "../src/storage";
import { BackendAuthFlowRepository } from "../src/storage/backend-auth-flows";
import * as sqlite from "../src/storage/schema/sqlite";

const NOW = new Date("2026-07-20T12:00:00.000Z");
const KEY = Buffer.alloc(32, 17).toString("base64url");
const OTHER_KEY = Buffer.alloc(32, 23).toString("base64url");
const SERVER = "github";

let root: string;
const BACKEND_AUTH_FLOW_INVALIDATION_MIGRATION_CREATED_AT = 1_784_666_622_628;
let storagePath: string;
let firstStorage: HostStorage;
let secondStorage: HostStorage;
let firstRepository: BackendAuthFlowRepository;
let secondRepository: BackendAuthFlowRepository;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "caplets-backend-auth-flows-"));
  storagePath = join(root, "caplets.sqlite3");
  firstStorage = await createHostStorage({ type: "sqlite", path: storagePath });
  secondStorage = await createHostStorage({ type: "sqlite", path: storagePath });
  const options = { env: { CAPLETS_ENCRYPTION_KEY: KEY } };
  firstRepository = new BackendAuthFlowRepository(firstStorage.database, options);
  secondRepository = new BackendAuthFlowRepository(secondStorage.database, options);
});

afterEach(async () => {
  await Promise.allSettled([firstStorage.close(), secondStorage.close()]);
  rmSync(root, { recursive: true, force: true });
});

describe("durable backend auth flow storage", () => {
  it("persists encrypted state before returning and decrypts it across SQLite instances", async () => {
    const flowId = "flow_round_trip";
    const state = flowState(flowId, { pkceVerifier: "pkce-round-trip-secret" });

    const created = await firstRepository.create({
      flowId,
      server: SERVER,
      state,
      expiresAt: after(10_000),
      startingBackendAuthGeneration: 4,
      now: NOW,
    });

    expect(created).toEqual({
      flowId,
      server: SERVER,
      status: "pending",
      createdAt: NOW.toISOString(),
      expiresAt: after(10_000).toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(JSON.stringify(created)).not.toContain("pkce-round-trip-secret");
    expect(JSON.stringify(await secondRepository.list({ server: SERVER, now: NOW }))).not.toContain(
      "pkce-round-trip-secret",
    );
    const raw = await rawRow(flowId);
    expect(JSON.stringify(raw)).not.toContain("pkce-round-trip-secret");
    expect(raw.encryptedPayload).toMatchObject({
      version: 1,
      algorithm: "aes-256-gcm",
      nonce: expect.any(String),
      ciphertext: expect.any(String),
      authTag: expect.any(String),
    });

    const claimed = await secondRepository.claim({
      flowId,
      claimToken: "claim_round_trip",
      now: after(1_000),
    });
    expect(claimed).toMatchObject({
      acquired: true,
      claimToken: "claim_round_trip",
      startingBackendAuthGeneration: 4,
      state,
    });
  });

  it("atomically terminalizes only pre-migration in-flight flows", async () => {
    await rewindBackendAuthFlowInvalidationMigration();
    await firstRepository.create({
      flowId: "flow_migration_pending",
      server: SERVER,
      state: flowState("flow_migration_pending", { pkceVerifier: "pending-migration-secret" }),
      completionCorrelation: "correlation_migration_pending",
      startingBackendAuthGeneration: 3,
      expiresAt: after(100_000),
      now: NOW,
    });
    await firstRepository.create({
      flowId: "flow_migration_completing",
      server: SERVER,
      state: flowState("flow_migration_completing", {
        pkceVerifier: "completing-migration-secret",
      }),
      completionCorrelation: "correlation_migration_completing",
      startingBackendAuthGeneration: 4,
      expiresAt: after(100_000),
      now: NOW,
    });
    await expect(
      secondRepository.claim({
        flowId: "flow_migration_completing",
        claimToken: "claim_migration_completing",
        now: after(1_000),
      }),
    ).resolves.toMatchObject({ acquired: true });
    for (const status of ["completed", "expired", "failed", "unknown"] as const) {
      await createTerminalFlow(`flow_migration_${status}`, status);
    }

    const pendingPayload = (await rawRow("flow_migration_pending")).encryptedPayload;
    const completingPayload = (await rawRow("flow_migration_completing")).encryptedPayload;
    const terminalRows = Object.fromEntries(
      await Promise.all(
        ["completed", "expired", "failed", "unknown"].map(async (status) => {
          const flowId = `flow_migration_${status}`;
          return [flowId, await rawRow(flowId)] as const;
        }),
      ),
    );

    await migrateHostStorage({ type: "sqlite", path: storagePath });

    const pending = await rawRow("flow_migration_pending");
    expect(pending).toMatchObject({
      status: "failed",
      encryptedPayload: pendingPayload,
      startingBackendAuthGeneration: null,
      completionCorrelation: null,
      completedBackendAuthGeneration: null,
      claimToken: null,
      claimedAt: null,
      terminalAt: expect.any(String),
    });
    expect(pending.updatedAt).toBe(pending.terminalAt);
    expect(Number.isNaN(Date.parse(pending.terminalAt!))).toBe(false);

    const completing = await rawRow("flow_migration_completing");
    expect(completing).toMatchObject({
      status: "unknown",
      encryptedPayload: completingPayload,
      startingBackendAuthGeneration: null,
      completionCorrelation: null,
      completedBackendAuthGeneration: null,
      claimToken: null,
      claimedAt: null,
      terminalAt: expect.any(String),
    });
    expect(completing.updatedAt).toBe(completing.terminalAt);
    for (const [flowId, row] of Object.entries(terminalRows)) {
      expect(await rawRow(flowId)).toEqual(row);
    }

    await firstRepository.create({
      flowId: "flow_created_after_migration",
      server: SERVER,
      state: flowState("flow_created_after_migration"),
      expiresAt: after(100_000),
      now: after(2_000),
    });
    const postMigrationRow = await rawRow("flow_created_after_migration");
    await migrateHostStorage({ type: "sqlite", path: storagePath });
    expect(await rawRow("flow_created_after_migration")).toEqual(postMigrationRow);
    const postMigrationClaim = await secondRepository.claim({
      flowId: "flow_created_after_migration",
      claimToken: "claim_created_after_migration",
      now: after(3_000),
    });
    expect(postMigrationClaim).toMatchObject({ acquired: true });
    await expect(
      firstRepository.release({
        flowId: "flow_created_after_migration",
        claimToken: "claim_created_after_migration",
        now: after(4_000),
      }),
    ).resolves.toBe(true);
  });

  it("serializes a claim racing the in-flight invalidation migration", async () => {
    await rewindBackendAuthFlowInvalidationMigration();
    await firstRepository.create({
      flowId: "flow_migration_claim_race",
      server: SERVER,
      state: flowState("flow_migration_claim_race"),
      completionCorrelation: "correlation_migration_claim_race",
      expiresAt: after(100_000),
      now: NOW,
    });

    const [claim] = await Promise.all([
      secondRepository.claim({
        flowId: "flow_migration_claim_race",
        claimToken: "claim_migration_race",
        now: after(1_000),
      }),
      migrateHostStorage({ type: "sqlite", path: storagePath }),
    ]);

    const row = await rawRow("flow_migration_claim_race");
    expect(row.status === "failed" || row.status === "unknown").toBe(true);
    expect(row).toMatchObject({
      claimToken: null,
      claimedAt: null,
      completionCorrelation: null,
      terminalAt: expect.any(String),
    });
    expect(row.updatedAt).toBe(row.terminalAt);
    if (claim.acquired) {
      expect(row.status).toBe("unknown");
      await expect(
        firstRepository.release({
          flowId: "flow_migration_claim_race",
          claimToken: claim.claimToken,
          now: after(2_000),
        }),
      ).resolves.toBe(false);
    } else {
      expect(claim.reason).toBe("terminal");
      expect(row.status).toBe("failed");
    }
  });

  it("keeps SQLite flow encryption available through its local key file", async () => {
    const localKeyRoot = join(root, "local-flow-key");
    const repository = new BackendAuthFlowRepository(firstStorage.database, {
      root: localKeyRoot,
      env: {},
    });
    const flowId = "flow_local_key";

    await repository.create({
      flowId,
      server: SERVER,
      state: flowState(flowId),
      expiresAt: after(10_000),
      now: NOW,
    });

    expect(existsSync(join(localKeyRoot, "vault-key"))).toBe(true);
    await expect(
      repository.claim({ flowId, claimToken: "claim_local_key", now: after(1_000) }),
    ).resolves.toMatchObject({ acquired: true, state: flowState(flowId) });
  });

  it("fails closed with a wrong key, envelope version, or authenticated identity", async () => {
    await firstRepository.create({
      flowId: "flow_wrong_key",
      server: SERVER,
      state: flowState("flow_wrong_key", { pkceVerifier: "wrong-key-secret" }),
      expiresAt: after(10_000),
      now: NOW,
    });
    const wrongKeyRepository = new BackendAuthFlowRepository(secondStorage.database, {
      env: { CAPLETS_ENCRYPTION_KEY: OTHER_KEY },
    });
    await expect(
      wrongKeyRepository.claim({
        flowId: "flow_wrong_key",
        claimToken: "claim_wrong_key",
        now: after(1_000),
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await rawRow("flow_wrong_key")).toMatchObject({
      status: "pending",
      claimToken: null,
      claimedAt: null,
    });
    const retried = await firstRepository.claim({
      flowId: "flow_wrong_key",
      claimToken: "claim_correct_key",
      now: after(1_000),
    });
    expect(retried).toMatchObject({ acquired: true });
    await expect(
      firstRepository.release({
        flowId: "flow_wrong_key",
        claimToken: "claim_correct_key",
        now: after(1_000),
      }),
    ).resolves.toBe(true);

    await firstRepository.create({
      flowId: "flow_aad_source",
      server: SERVER,
      state: flowState("flow_aad_source", { pkceVerifier: "aad-source-secret" }),
      expiresAt: after(10_000),
      now: NOW,
    });
    await firstRepository.create({
      flowId: "flow_aad_target",
      server: SERVER,
      state: flowState("flow_aad_target", { pkceVerifier: "aad-target-secret" }),
      expiresAt: after(10_000),
      now: NOW,
    });
    if (firstStorage.database.dialect !== "sqlite") throw new Error("Expected SQLite storage.");
    const source = await rawRow("flow_aad_source");
    await firstStorage.database.db
      .update(sqlite.backendAuthFlows)
      .set({ encryptedPayload: source.encryptedPayload })
      .where(eq(sqlite.backendAuthFlows.flowId, "flow_aad_target"))
      .run();

    await expect(
      secondRepository.claim({
        flowId: "flow_aad_target",
        claimToken: "claim_aad_target",
        now: after(1_000),
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });

    await firstRepository.create({
      flowId: "flow_wrong_version",
      server: SERVER,
      state: flowState("flow_wrong_version"),
      expiresAt: after(10_000),
      now: NOW,
    });
    await firstStorage.database.db
      .update(sqlite.backendAuthFlows)
      .set({ envelopeVersion: 2 })
      .where(eq(sqlite.backendAuthFlows.flowId, "flow_wrong_version"))
      .run();
    await expect(
      secondRepository.claim({
        flowId: "flow_wrong_version",
        claimToken: "claim_wrong_version",
        now: after(1_000),
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });

    await firstRepository.create({
      flowId: "flow_wrong_server",
      server: SERVER,
      state: flowState("flow_wrong_server"),
      expiresAt: after(10_000),
      now: NOW,
    });
    await firstStorage.database.db
      .update(sqlite.backendAuthFlows)
      .set({ server: "other-server" })
      .where(eq(sqlite.backendAuthFlows.flowId, "flow_wrong_server"))
      .run();
    await expect(
      secondRepository.claim({
        flowId: "flow_wrong_server",
        claimToken: "claim_wrong_server",
        now: after(1_000),
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("atomically expires and scrubs a flow before a late claim", async () => {
    const flowId = "flow_expired";
    await firstRepository.create({
      flowId,
      server: SERVER,
      state: flowState(flowId, { pkceVerifier: "expired-secret" }),
      expiresAt: after(1_000),
      now: NOW,
    });

    await expect(
      secondRepository.claim({ flowId, claimToken: "claim_expired", now: after(1_001) }),
    ).resolves.toMatchObject({ acquired: false, reason: "expired" });
    expect(await rawRow(flowId)).toMatchObject({
      status: "expired",
      encryptedPayload: null,
      completionCorrelation: null,
      claimToken: null,
      claimedAt: null,
      terminalAt: after(1_001).toISOString(),
    });
  });

  it("allows exactly one concurrent claim and only releases its matching token", async () => {
    const flowId = "flow_concurrent";
    await firstRepository.create({
      flowId,
      server: SERVER,
      state: flowState(flowId),
      expiresAt: after(10_000),
      now: NOW,
    });

    const claims = await Promise.all([
      firstRepository.claim({ flowId, claimToken: "claim_first", now: after(1_000) }),
      secondRepository.claim({ flowId, claimToken: "claim_second", now: after(1_000) }),
    ]);
    expect(claims.filter((claim) => claim.acquired)).toHaveLength(1);
    expect(claims.filter((claim) => !claim.acquired)).toEqual([
      expect.objectContaining({ acquired: false, reason: "in_progress" }),
    ]);
    const winner = claims.find((claim) => claim.acquired);
    if (!winner?.acquired) throw new Error("Expected one acquired claim.");
    expect(winner.flow).toMatchObject({
      status: "completing",
      claimedAt: after(1_000).toISOString(),
    });

    await expect(
      secondRepository.heartbeat({
        flowId,
        claimToken: "claim_mismatch",
        now: after(1_500),
      }),
    ).resolves.toBe(false);
    await expect(
      firstRepository.heartbeat({
        flowId,
        claimToken: winner.claimToken,
        now: after(1_500),
      }),
    ).resolves.toBe(true);

    await expect(
      secondRepository.release({ flowId, claimToken: "claim_mismatch", now: after(2_000) }),
    ).resolves.toBe(false);
    await expect(
      firstRepository.release({ flowId, claimToken: winner.claimToken, now: after(2_000) }),
    ).resolves.toBe(true);
    await expect(
      secondRepository.claim({ flowId, claimToken: "claim_retry", now: after(3_000) }),
    ).resolves.toMatchObject({ acquired: true, claimToken: "claim_retry" });
  });

  it("guards finalization by claim and correlation then scrubs terminal secrets", async () => {
    const flowId = "flow_completed";
    await firstRepository.create({
      flowId,
      server: SERVER,
      state: flowState(flowId, { pkceVerifier: "terminal-secret" }),
      completionCorrelation: "correlation_completed",
      expiresAt: after(10_000),
      now: NOW,
    });
    const claimed = await secondRepository.claim({
      flowId,
      claimToken: "claim_completed",
      now: after(1_000),
    });
    if (!claimed.acquired) throw new Error("Expected flow claim.");

    await expect(
      firstRepository.finalize({
        flowId,
        claimToken: claimed.claimToken,
        completionCorrelation: "correlation_mismatch",
        backendAuthGeneration: 1,
        now: after(2_000),
      }),
    ).resolves.toBe(false);
    await expect(
      secondRepository.finalize({
        flowId,
        claimToken: claimed.claimToken,
        completionCorrelation: claimed.completionCorrelation,
        backendAuthGeneration: 5,
        now: after(2_000),
      }),
    ).resolves.toBe(true);

    const raw = await rawRow(flowId);
    expect(raw).toMatchObject({
      status: "completed",
      encryptedPayload: null,
      startingBackendAuthGeneration: null,
      completionCorrelation: null,
      claimToken: null,
      claimedAt: null,
      completedBackendAuthGeneration: 5,
      terminalAt: after(2_000).toISOString(),
    });
    expect(JSON.stringify(await firstRepository.get(flowId, after(3_000)))).not.toContain(
      "terminal-secret",
    );
  });

  it("atomically persists credentials and scrubs only the exact active claim", async () => {
    const flowId = "flow_atomic_completion";
    await firstRepository.create({
      flowId,
      server: SERVER,
      state: flowState(flowId),
      completionCorrelation: "correlation_atomic_completion",
      startingBackendAuthGeneration: 0,
      expiresAt: after(10_000),
      now: NOW,
    });
    const claim = await secondRepository.claim({
      flowId,
      claimToken: "claim_atomic_completion",
      now: after(1_000),
    });
    if (!claim.acquired) throw new Error("Expected active completion claim.");

    await expect(
      firstRepository.completeClaim({
        flowId,
        server: SERVER,
        claimToken: claim.claimToken,
        completionCorrelation: claim.completionCorrelation,
        expectedGeneration: 0,
        bundle: {
          server: SERVER,
          accessToken: "atomic-access-token",
          metadata: {
            backendAuthFlow: {
              flowId,
              completionCorrelation: claim.completionCorrelation,
            },
          },
        },
        now: after(2_000),
      }),
    ).resolves.toMatchObject({ generation: 1 });
    await expect(firstStorage.backendAuth.readTokenBundle(SERVER)).resolves.toMatchObject({
      generation: 1,
      bundle: { accessToken: "atomic-access-token" },
    });
    expect(await rawRow(flowId)).toMatchObject({
      status: "completed",
      encryptedPayload: null,
      startingBackendAuthGeneration: null,
      completionCorrelation: null,
      completedBackendAuthGeneration: 1,
      claimToken: null,
    });
  });

  it("does not mutate credentials after claim loss or expiry before persistence", async () => {
    await firstStorage.backendAuth.writeTokenBundle({
      server: SERVER,
      accessToken: "unchanged-access-token",
    });
    for (const [flowId, correlation] of [
      ["flow_lost_before_persist", "correlation_lost_before_persist"],
      ["flow_expired_before_persist", "correlation_expired_before_persist"],
    ] as const) {
      await firstRepository.create({
        flowId,
        server: SERVER,
        state: flowState(flowId, { startingBackendAuthGeneration: 1 }),
        completionCorrelation: correlation,
        startingBackendAuthGeneration: 1,
        expiresAt: after(3_000),
        now: NOW,
      });
      const claim = await firstRepository.claim({
        flowId,
        claimToken: `${flowId}_claim`,
        now: after(1_000),
      });
      if (!claim.acquired) throw new Error("Expected active completion claim.");
      if (flowId === "flow_lost_before_persist") {
        await firstRepository.release({
          flowId,
          claimToken: claim.claimToken,
          now: after(2_000),
        });
      }
      await expect(
        secondRepository.completeClaim({
          flowId,
          server: SERVER,
          claimToken: claim.claimToken,
          completionCorrelation: claim.completionCorrelation,
          expectedGeneration: 1,
          bundle: {
            server: SERVER,
            accessToken: `${flowId}-replacement-token`,
            metadata: {
              backendAuthFlow: {
                flowId,
                completionCorrelation: claim.completionCorrelation,
              },
            },
          },
          now: flowId === "flow_lost_before_persist" ? after(2_500) : after(3_001),
        }),
      ).rejects.toMatchObject({
        code: "AUTH_FAILED",
        details: { kind: "backend_auth_flow_claim_lost" },
      });
    }

    await expect(firstStorage.backendAuth.readTokenBundle(SERVER)).resolves.toMatchObject({
      generation: 1,
      bundle: { accessToken: "unchanged-access-token" },
    });
    expect(await rawRow("flow_expired_before_persist")).toMatchObject({
      status: "expired",
      encryptedPayload: null,
      claimToken: null,
    });
  });

  it("rolls back the credential write when terminal flow persistence fails", async () => {
    const flowId = "flow_atomic_rollback";
    await firstRepository.create({
      flowId,
      server: SERVER,
      state: flowState(flowId),
      completionCorrelation: "correlation_atomic_rollback",
      startingBackendAuthGeneration: 0,
      expiresAt: after(10_000),
      now: NOW,
    });
    const claim = await firstRepository.claim({
      flowId,
      claimToken: "claim_atomic_rollback",
      now: after(1_000),
    });
    if (!claim.acquired) throw new Error("Expected active completion claim.");
    if (firstStorage.database.dialect !== "sqlite") throw new Error("Expected SQLite storage.");
    await firstStorage.database.db.run(
      sql.raw(`
        create temp trigger fail_backend_auth_flow_completion
        before update on backend_auth_flows
        when new.status = 'completed'
        begin
          select raise(abort, 'forced completion failure');
        end
      `),
    );

    await expect(
      firstRepository.completeClaim({
        flowId,
        server: SERVER,
        claimToken: claim.claimToken,
        completionCorrelation: claim.completionCorrelation,
        expectedGeneration: 0,
        bundle: {
          server: SERVER,
          accessToken: "must-roll-back",
          metadata: {
            backendAuthFlow: {
              flowId,
              completionCorrelation: claim.completionCorrelation,
            },
          },
        },
        now: after(2_000),
      }),
    ).rejects.toThrow();
    await expect(firstStorage.backendAuth.readTokenBundle(SERVER)).resolves.toBeUndefined();
    expect(await rawRow(flowId)).toMatchObject({
      status: "completing",
      claimToken: claim.claimToken,
      completedBackendAuthGeneration: null,
    });
  });

  it("allows only one generation-zero flow to commit credentials", async () => {
    const claims = [];
    for (const suffix of ["first", "second"]) {
      const flowId = `flow_empty_generation_${suffix}`;
      await firstRepository.create({
        flowId,
        server: SERVER,
        state: flowState(flowId),
        completionCorrelation: `correlation_empty_generation_${suffix}`,
        startingBackendAuthGeneration: 0,
        expiresAt: after(10_000),
        now: NOW,
      });
      const claim = await firstRepository.claim({
        flowId,
        claimToken: `claim_empty_generation_${suffix}`,
        now: after(1_000),
      });
      if (!claim.acquired) throw new Error("Expected active completion claim.");
      claims.push(claim);
    }

    const completions = await Promise.allSettled(
      claims.map(
        async (claim, index) =>
          await (index === 0 ? firstRepository : secondRepository).completeClaim({
            flowId: claim.flow.flowId,
            server: SERVER,
            claimToken: claim.claimToken,
            completionCorrelation: claim.completionCorrelation,
            expectedGeneration: 0,
            bundle: {
              server: SERVER,
              accessToken: `empty-generation-token-${index}`,
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
    await expect(firstStorage.backendAuth.readTokenBundle(SERVER)).resolves.toMatchObject({
      generation: 1,
    });
  });

  it("terminalizes only a matching active claim as failed or explicitly unknown", async () => {
    const failedFlowId = "flow_terminal_failed";
    await createAndClaim(failedFlowId, "claim_terminal_failed", "correlation_terminal_failed");

    await expect(
      secondRepository.terminalizeClaim({
        flowId: failedFlowId,
        claimToken: "claim_terminal_mismatch",
        status: "failed",
        now: after(2_000),
      }),
    ).resolves.toBe(false);
    expect(await rawRow(failedFlowId)).toMatchObject({
      status: "completing",
      claimToken: "claim_terminal_failed",
      encryptedPayload: expect.any(Object),
      terminalAt: null,
    });

    await expect(
      firstRepository.terminalizeClaim({
        flowId: failedFlowId,
        claimToken: "claim_terminal_failed",
        status: "failed",
        now: after(2_000),
      }),
    ).resolves.toBe(true);
    expect(await rawRow(failedFlowId)).toMatchObject({
      status: "failed",
      expiresAt: after(10_000).toISOString(),
      encryptedPayload: null,
      startingBackendAuthGeneration: null,
      completionCorrelation: null,
      completedBackendAuthGeneration: null,
      claimToken: null,
      claimedAt: null,
      terminalAt: after(2_000).toISOString(),
    });
    await expect(
      secondRepository.claim({
        flowId: failedFlowId,
        claimToken: "claim_after_failed",
        now: after(3_000),
      }),
    ).resolves.toMatchObject({ acquired: false, reason: "terminal" });

    const unknownFlowId = "flow_terminal_unknown";
    await createAndClaim(unknownFlowId, "claim_terminal_unknown", "correlation_terminal_unknown");
    await expect(
      secondRepository.terminalizeClaim({
        flowId: unknownFlowId,
        claimToken: "claim_terminal_unknown",
        status: "unknown",
        now: after(2_000),
      }),
    ).resolves.toBe(true);
    expect(await rawRow(unknownFlowId)).toMatchObject({
      status: "unknown",
      encryptedPayload: null,
      completionCorrelation: null,
      claimToken: null,
      terminalAt: after(2_000).toISOString(),
    });
  });

  it("reconciles proven completion and marks unprovable abandoned work unknown", async () => {
    await createAndClaim("flow_reconciled", "claim_reconciled", "correlation_reconciled");
    await expect(
      firstRepository.reconcileAbandoned({
        flowId: "flow_reconciled",
        abandonedBefore: after(500),
        observedCompletionCorrelation: "correlation_reconciled",
        observedBackendAuthGeneration: 7,
        now: after(2_000),
      }),
    ).resolves.toBeUndefined();
    await expect(
      secondRepository.reconcileAbandoned({
        flowId: "flow_reconciled",
        abandonedBefore: after(1_000),
        observedCompletionCorrelation: "correlation_reconciled",
        observedBackendAuthGeneration: 7,
        now: after(2_000),
      }),
    ).resolves.toMatchObject({ status: "completed" });

    await createAndClaim("flow_unknown", "claim_unknown", "correlation_unknown");
    await expect(
      firstRepository.reconcileAbandoned({
        flowId: "flow_unknown",
        abandonedBefore: after(1_000),
        now: after(2_000),
      }),
    ).resolves.toMatchObject({ status: "unknown" });
    expect(await rawRow("flow_unknown")).toMatchObject({
      status: "unknown",
      encryptedPayload: null,
      completionCorrelation: null,
      claimToken: null,
      completedBackendAuthGeneration: null,
    });
    await expect(
      secondRepository.claim({
        flowId: "flow_unknown",
        claimToken: "claim_after_unknown",
        now: after(3_000),
      }),
    ).resolves.toMatchObject({ acquired: false, reason: "terminal" });
  });

  it("prunes terminal rows with a safe bounded batch and leaves pending work", async () => {
    for (const flowId of ["flow_prune_1", "flow_prune_2", "flow_prune_3"]) {
      await firstRepository.create({
        flowId,
        server: SERVER,
        state: flowState(flowId),
        expiresAt: after(1_000),
        now: NOW,
      });
      await firstRepository.expire(flowId, after(2_000));
    }
    await firstRepository.create({
      flowId: "flow_keep_pending",
      server: SERVER,
      state: flowState("flow_keep_pending"),
      expiresAt: after(100_000),
      now: NOW,
    });

    await expect(
      firstRepository.prune({ now: after(3_000), retentionMs: 0, limit: 2 }),
    ).resolves.toBe(2);
    await expect(
      secondRepository.prune({ now: after(3_000), retentionMs: 0, limit: 2 }),
    ).resolves.toBe(1);
    await expect(firstRepository.get("flow_keep_pending", after(3_000))).resolves.toMatchObject({
      status: "pending",
    });
    await expect(firstRepository.prune({ limit: 1_001 })).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
  });

  it("traverses stable filtered flow pages and validates page keys", async () => {
    const definitions = [
      { flowId: "flow_a", server: SERVER, now: NOW },
      { flowId: "flow_A", server: SERVER, now: NOW },
      { flowId: "flow_other", server: "gitlab", now: NOW },
      { flowId: "flow_later", server: SERVER, now: after(1) },
    ];
    for (const definition of definitions) {
      await firstRepository.create({
        ...definition,
        state: flowState(definition.flowId, {
          server: definition.server,
          createdAt: definition.now.toISOString(),
          expiresAt: after(10_000).toISOString(),
        }),
        expiresAt: after(10_000),
      });
    }

    const firstPage = await secondRepository.listPage({ server: SERVER, now: NOW, limit: 1 });
    expect(firstPage.items.map((flow) => flow.flowId)).toEqual(["flow_A"]);
    expect(firstPage.nextKey).toEqual({
      server: SERVER,
      createdAt: NOW.toISOString(),
      flowId: "flow_A",
    });
    const secondPage = await secondRepository.listPage({
      server: SERVER,
      now: NOW,
      limit: 1,
      after: firstPage.nextKey,
    });
    expect(secondPage.items.map((flow) => flow.flowId)).toEqual(["flow_a"]);

    await firstRepository.claim({
      flowId: "flow_a",
      claimToken: "claim_flow_a",
      now: after(2),
    });
    const pendingIds: string[] = [];
    let afterKey: { server: string; createdAt: string; flowId: string } | undefined;
    do {
      const page = await secondRepository.listPage({
        server: SERVER,
        status: "pending",
        now: after(2),
        limit: 1,
        ...(afterKey ? { after: afterKey } : {}),
      });
      pendingIds.push(...page.items.map((flow) => flow.flowId));
      afterKey = page.nextKey;
    } while (afterKey);
    expect(pendingIds).toEqual(["flow_A", "flow_later"]);

    const allIds: string[] = [];
    afterKey = undefined;
    do {
      const page = await secondRepository.listPage({
        now: after(2),
        limit: 1,
        ...(afterKey ? { after: afterKey } : {}),
      });
      allIds.push(...page.items.map((flow) => flow.flowId));
      afterKey = page.nextKey;
    } while (afterKey);
    expect(allIds).toEqual(["flow_A", "flow_a", "flow_other", "flow_later"]);
    await expect(
      secondRepository.listPage({
        server: SERVER,
        status: "expired",
        now: after(20_000),
        limit: 10,
      }),
    ).resolves.toMatchObject({
      items: [
        { flowId: "flow_A", server: SERVER, status: "expired" },
        { flowId: "flow_a", server: SERVER, status: "expired" },
        { flowId: "flow_later", server: SERVER, status: "expired" },
      ],
    });

    await expect(
      secondRepository.listPage({
        server: SERVER,
        limit: 1,
        after: {
          server: "gitlab",
          createdAt: NOW.toISOString(),
          flowId: "flow_other",
        },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(
      secondRepository.listPage({
        limit: 1,
        after: { server: SERVER, createdAt: "not-a-timestamp", flowId: "flow_A" },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("rejects executable or non-JSON state before persistence", async () => {
    const state = {
      ...flowState("flow_function"),
      complete: () => undefined,
    };
    await expect(
      firstRepository.create({
        flowId: "flow_function",
        server: SERVER,
        state,
        expiresAt: after(10_000),
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    expect(await rawRows()).toEqual([]);
  });
});

async function rewindBackendAuthFlowInvalidationMigration(): Promise<void> {
  if (firstStorage.database.dialect !== "sqlite") throw new Error("Expected SQLite storage.");
  await firstStorage.database.db.run(
    sql`DELETE FROM caplets_migrations
        WHERE created_at >= ${BACKEND_AUTH_FLOW_INVALIDATION_MIGRATION_CREATED_AT}`,
  );
  await firstStorage.database.db
    .update(sqlite.capletsSchema)
    .set({ version: 17 })
    .where(eq(sqlite.capletsSchema.singleton, 1))
    .run();
}

async function createTerminalFlow(
  flowId: string,
  status: "completed" | "expired" | "failed" | "unknown",
): Promise<void> {
  await firstRepository.create({
    flowId,
    server: SERVER,
    state: flowState(flowId),
    completionCorrelation: `correlation_${flowId}`,
    startingBackendAuthGeneration: 0,
    expiresAt: after(100_000),
    now: NOW,
  });
  if (status === "expired") {
    await firstRepository.expire(flowId, after(100_001));
    return;
  }
  const claim = await firstRepository.claim({
    flowId,
    claimToken: `claim_${flowId}`,
    now: after(1_000),
  });
  if (!claim.acquired) throw new Error(`Could not claim ${flowId}.`);
  if (status === "completed") {
    await firstRepository.finalize({
      flowId,
      claimToken: claim.claimToken,
      completionCorrelation: claim.completionCorrelation,
      backendAuthGeneration: 1,
      now: after(2_000),
    });
    return;
  }
  await firstRepository.terminalizeClaim({
    flowId,
    claimToken: claim.claimToken,
    status,
    now: after(2_000),
  });
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
    stateVerifier: "state-secret",
    pkceVerifier: "pkce-secret",
    configurationFingerprint: "configuration-fingerprint",
    startingBackendAuthGeneration: 0,
    authorizationEndpoint: "https://oauth.example/authorize",
    tokenEndpoint: "https://oauth.example/token",
    clientId: "test-client",
    allowLoopbackHttp: false,
    createdAt: NOW.toISOString(),
    expiresAt: after(10_000).toISOString(),
    ...overrides,
  };
}

function after(milliseconds: number): Date {
  return new Date(NOW.getTime() + milliseconds);
}

async function rawRow(flowId: string) {
  if (firstStorage.database.dialect !== "sqlite") throw new Error("Expected SQLite storage.");
  const row = await firstStorage.database.db
    .select()
    .from(sqlite.backendAuthFlows)
    .where(eq(sqlite.backendAuthFlows.flowId, flowId))
    .get();
  if (!row) throw new Error(`Missing backend auth flow ${flowId}.`);
  return row;
}

function rawRows() {
  if (firstStorage.database.dialect !== "sqlite") throw new Error("Expected SQLite storage.");
  return firstStorage.database.db.select().from(sqlite.backendAuthFlows).all();
}

async function createAndClaim(
  flowId: string,
  claimToken: string,
  correlation: string,
): Promise<void> {
  await firstRepository.create({
    flowId,
    server: SERVER,
    state: flowState(flowId),
    completionCorrelation: correlation,
    expiresAt: after(10_000),
    now: NOW,
  });
  await firstRepository.claim({ flowId, claimToken, now: after(1_000) });
}
