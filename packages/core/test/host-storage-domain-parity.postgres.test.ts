import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import type { StoredOAuthTokenBundle } from "../src/auth/store";
import { DashboardSessionStore } from "../src/dashboard/session-store";
import { DASHBOARD_SESSION_COOKIE } from "../src/dashboard/types";
import {
  createHostStorage,
  migrateHostStorage,
  type HostStorage,
  type PostgresHostStorageConfig,
} from "../src/storage";
import type { SetupAttempt } from "../src/setup/types";

const connectionString = process.env.CAPLETS_TEST_POSTGRES_URL;
const postgresIt = connectionString ? it : it.skip;
const schemas = new Set<string>();
const storages = new Set<HostStorage>();
const originalEncryptionKey = process.env.CAPLETS_ENCRYPTION_KEY;

const operator = { clientId: "operator-postgres", role: "operator" } as const;

async function openPair(domain: string): Promise<{
  schema: string;
  first: HostStorage;
  second: HostStorage;
}> {
  const schema = `caplets_pg_${domain}_${randomUUID().replaceAll("-", "")}`;
  schemas.add(schema);
  const config: PostgresHostStorageConfig = {
    type: "postgres",
    connectionString: connectionString!,
    schema,
  };
  await migrateHostStorage(config);
  const first = await createHostStorage(config);
  storages.add(first);
  const second = await createHostStorage(config);
  storages.add(second);
  return { schema, first, second };
}

afterEach(async () => {
  if (originalEncryptionKey === undefined) delete process.env.CAPLETS_ENCRYPTION_KEY;
  else process.env.CAPLETS_ENCRYPTION_KEY = originalEncryptionKey;

  await Promise.allSettled([...storages].map(async (storage) => await storage.close()));
  storages.clear();
  if (!connectionString || schemas.size === 0) return;

  const pool = new Pool({ connectionString });
  try {
    for (const schema of schemas) {
      await pool.query(`drop schema if exists "${schema}" cascade`);
    }
  } finally {
    schemas.clear();
    await pool.end();
  }
});

postgresIt(
  "keeps backend auth CAS, ordering, deletion, and activity secret-safe on PostgreSQL",
  async () => {
    const { first, second } = await openPair("auth");
    const accessToken = "postgres-plain-access-token";
    const refreshToken = "postgres-plain-refresh-token";
    const bundle: StoredOAuthTokenBundle = {
      server: "beta",
      authType: "oauth2",
      accessToken,
      refreshToken,
      clientId: "client-1",
      clientSecret: "postgres-plain-client-secret",
      protectedResourceOrigin: "https://api.example.test",
    };

    await expect(
      first.backendAuth.writeTokenBundle(bundle, { operatorClientId: operator.clientId }),
    ).resolves.toEqual({ bundle, generation: 1 });
    await second.backendAuth.writeTokenBundle({ server: "alpha", accessToken: "alpha-secret" });

    await expect(second.backendAuth.readTokenBundle("beta")).resolves.toEqual({
      bundle,
      generation: 1,
    });
    await expect(first.backendAuth.listTokenBundles()).resolves.toEqual([
      { bundle: { server: "alpha", accessToken: "alpha-secret" }, generation: 1 },
      { bundle, generation: 1 },
    ]);

    const rotated = { ...bundle, accessToken: "postgres-rotated-access-token" };
    await expect(
      second.backendAuth.writeTokenBundle(rotated, {
        expectedGeneration: 1,
        operatorClientId: operator.clientId,
      }),
    ).resolves.toEqual({ bundle: rotated, generation: 2 });
    await expect(
      first.backendAuth.writeTokenBundle(bundle, { expectedGeneration: 1 }),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      details: { kind: "stale_generation", expectedGeneration: 1, currentGeneration: 2 },
    });

    await expect(
      second.backendAuth.deleteTokenBundle("alpha", { expectedGeneration: 1 }),
    ).resolves.toBe(true);
    await expect(first.backendAuth.readTokenBundle("alpha")).resolves.toBeUndefined();
    await expect(first.backendAuth.deleteTokenBundle("alpha")).resolves.toBe(false);

    const activityPayload = JSON.stringify((await first.operatorActivity.list()).entries);
    for (const secret of [
      accessToken,
      refreshToken,
      bundle.clientSecret!,
      "alpha-secret",
      rotated.accessToken,
    ]) {
      expect(activityPayload).not.toContain(secret);
    }
  },
);

postgresIt(
  "keeps Vault values and file grants coherent, encrypted, and revocable on PostgreSQL",
  async () => {
    process.env.CAPLETS_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64url");
    const { schema, first, second } = await openPair("vault");
    const plaintext = "postgres-vault-plaintext";
    const rotatedPlaintext = "postgres-vault-rotated";

    await expect(
      first.vaultValues.set("API_TOKEN", plaintext, {
        expectedGeneration: 0,
        operatorClientId: operator.clientId,
      }),
    ).resolves.toMatchObject({ key: "API_TOKEN", present: true, generation: 1 });
    await expect(second.vaultValues.resolveValue("API_TOKEN")).resolves.toBe(plaintext);
    await expect(second.vaultValues.set("API_TOKEN", "collision-secret")).rejects.toMatchObject({
      code: "CONFIG_EXISTS",
    });
    await expect(
      second.vaultValues.set("API_TOKEN", rotatedPlaintext, {
        force: true,
        expectedGeneration: 1,
        operatorClientId: operator.clientId,
      }),
    ).resolves.toMatchObject({ generation: 2 });
    await expect(
      first.vaultValues.set("API_TOKEN", "stale-secret", {
        force: true,
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      details: { kind: "stale_generation", expectedGeneration: 1, currentGeneration: 2 },
    });
    await expect(first.vaultValues.listValues()).resolves.toEqual([
      expect.objectContaining({ key: "API_TOKEN", present: true, generation: 2 }),
    ]);

    const pool = new Pool({ connectionString: connectionString! });
    try {
      const columns = await pool.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema = $1 and table_name = 'vault_values'",
        [schema],
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual(
        expect.arrayContaining(["ciphertext", "nonce", "auth_tag"]),
      );
      expect(columns.rows.map((row) => row.column_name)).not.toContain("value");
      const encrypted = await pool.query<{ ciphertext_safe: boolean }>(
        `select position($1 in ciphertext) = 0 as ciphertext_safe from "${schema}".vault_values where vault_key = 'API_TOKEN'`,
        [rotatedPlaintext],
      );
      expect(encrypted.rows).toEqual([{ ciphertext_safe: true }]);
    } finally {
      await pool.end();
    }

    await first.vaultValues.set("GRANT_A", "grant-secret-a", { expectedGeneration: 0 });
    await first.vaultValues.set("GRANT_B", "grant-secret-b", { expectedGeneration: 0 });
    const originPath = "/project/.caplets/shared.md";
    await first.vaultGrants.grant({
      capletId: "shared",
      vaultKey: "GRANT_A",
      referenceName: "TOKEN",
      originKind: "project-file",
      originPath,
      operator,
    });
    await second.vaultGrants.grant({
      capletId: "shared",
      vaultKey: "GRANT_B",
      referenceName: "TOKEN",
      originKind: "project-file",
      originPath,
      operator,
    });
    await expect(first.vaultGrants.list("shared")).resolves.toEqual([
      expect.objectContaining({
        subjectKind: "file",
        capletId: "shared",
        vaultKey: "GRANT_B",
        referenceName: "TOKEN",
        originKind: "project-file",
        originPath,
      }),
    ]);
    const revoke = {
      capletId: "shared",
      vaultKey: "GRANT_B",
      referenceName: "TOKEN",
      originKind: "project-file" as const,
      originPath,
      operator,
    };
    await expect(second.vaultGrants.revoke(revoke)).resolves.toBe(true);
    await expect(first.vaultGrants.revoke(revoke)).resolves.toBe(false);
    await expect(second.vaultGrants.list("shared")).resolves.toEqual([]);

    await expect(
      second.vaultValues.delete("API_TOKEN", {
        expectedGeneration: 1,
        operatorClientId: operator.clientId,
      }),
    ).rejects.toMatchObject({ details: { kind: "stale_generation" } });
    await expect(
      first.vaultValues.delete("API_TOKEN", {
        expectedGeneration: 2,
        operatorClientId: operator.clientId,
      }),
    ).resolves.toEqual({ key: "API_TOKEN", deleted: true, generation: 2 });
    await expect(second.vaultValues.resolveValue("API_TOKEN")).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });

    const activityPayload = JSON.stringify((await first.operatorActivity.list()).entries);
    for (const secret of [
      plaintext,
      rotatedPlaintext,
      "collision-secret",
      "stale-secret",
      "grant-secret-a",
      "grant-secret-b",
    ]) {
      expect(activityPayload).not.toContain(secret);
    }
    expect(activityPayload).not.toContain(originPath);
  },
);

postgresIt(
  "creates, validates, expires, and deletes dashboard sessions across PostgreSQL instances",
  async () => {
    const { first, second } = await openPair("dashboard");
    const firstStore = new DashboardSessionStore({
      repository: first.dashboardSessions,
      validateOperatorClient: async (clientId) => clientId === operator.clientId,
    });
    const secondStore = new DashboardSessionStore({
      repository: second.dashboardSessions,
      validateOperatorClient: async (clientId) => clientId === operator.clientId,
    });
    const now = new Date("2026-07-18T12:00:00.000Z");
    const created = await firstStore.create({ operatorClientId: operator.clientId, now });
    const persisted = await second.dashboardSessions.get(created.session.sessionId);
    expect(persisted).toMatchObject({
      ...created.session,
      secretHash: expect.any(String),
    });
    const cookieSecret = created.cookieValue.split(".", 2)[1]!;
    expect(JSON.stringify(persisted)).not.toContain(cookieSecret);
    await expect(second.dashboardSessions.create(persisted!)).resolves.toBe(false);

    const touchedAt = new Date(now.getTime() + 30_000);
    await expect(
      secondStore.validate({
        cookieHeader: `${DASHBOARD_SESSION_COOKIE}=${created.cookieValue}`,
        csrfToken: created.session.csrfToken,
        requireCsrf: true,
        now: touchedAt,
      }),
    ).resolves.toEqual({ ...created.session, lastUsedAt: touchedAt.toISOString() });
    await expect(
      firstStore.validate({
        cookieHeader: `${DASHBOARD_SESSION_COOKIE}=${created.cookieValue}`,
        csrfToken: "wrong-csrf",
        requireCsrf: true,
        now: new Date(touchedAt.getTime() + 1_000),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

    await expect(
      firstStore.validate({
        cookieHeader: `${DASHBOARD_SESSION_COOKIE}=${created.cookieValue}`,
        now: new Date(now.getTime() + 13 * 60 * 60_000),
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(second.dashboardSessions.get(created.session.sessionId)).resolves.toBeUndefined();

    const logout = await secondStore.create({
      operatorClientId: operator.clientId,
      now: new Date(now.getTime() + 14 * 60 * 60_000),
    });
    const cookie = `${DASHBOARD_SESSION_COOKIE}=${logout.cookieValue}`;
    await expect(firstStore.delete(cookie)).resolves.toBe(true);
    await expect(secondStore.delete(cookie)).resolves.toBe(false);
  },
);

postgresIt(
  "shares setup approvals and attempt CAS, retention, and clearing on PostgreSQL",
  async () => {
    const { first, second } = await openPair("setup");
    const now = new Date();
    const approval = {
      projectFingerprint: "project-postgres",
      capletId: "ast-grep",
      contentHash: "sha256:postgres-content",
      targetKind: "remote_host" as const,
      approvedAt: now.toISOString(),
      actor: "ui" as const,
    };
    await expect(
      first.setupState.approve(approval, { operatorClientId: operator.clientId }),
    ).resolves.toEqual(approval);
    await expect(
      second.setupState.getApproval(
        approval.projectFingerprint,
        approval.capletId,
        approval.contentHash,
        approval.targetKind,
      ),
    ).resolves.toEqual(approval);
    await expect(
      second.setupState.approve({ ...approval, actor: "automation" }, { expectedGeneration: 0 }),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      details: expect.objectContaining({ kind: "stale_generation" }),
    });

    const firstAttempt = setupAttempt("attempt-1", now);
    const secondAttempt = setupAttempt("attempt-2", new Date(now.getTime() + 1));
    await first.setupState.recordAttempt(firstAttempt, {
      operatorClientId: operator.clientId,
    });
    await second.setupState.recordAttempt(secondAttempt, {
      expectedGeneration: 1,
      operatorClientId: operator.clientId,
    });
    await expect(
      first.setupState.recordAttempt(setupAttempt("attempt-stale", now), {
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({ details: expect.objectContaining({ kind: "stale_generation" }) });
    await expect(
      second.setupState.listAttempts(approval.projectFingerprint, approval.capletId),
    ).resolves.toEqual([firstAttempt, secondAttempt]);
    await expect(
      first.setupState.getAttempt(approval.projectFingerprint, approval.capletId, "attempt-2"),
    ).resolves.toEqual(secondAttempt);
    await expect(
      second.setupState.clearAttempts(approval.projectFingerprint, approval.capletId, {
        expectedGeneration: 2,
        operatorClientId: operator.clientId,
      }),
    ).resolves.toBe(true);
    await expect(
      first.setupState.listAttempts(approval.projectFingerprint, approval.capletId),
    ).resolves.toEqual([]);
    await expect(
      first.setupState.clearAttempts(approval.projectFingerprint, approval.capletId),
    ).resolves.toBe(false);
  },
);

postgresIt(
  "fences Project Binding ownership, uniqueness, CAS, end, and lease expiry on PostgreSQL",
  async () => {
    const { first, second } = await openPair("binding");
    const input = {
      bindingId: "binding-postgres",
      sessionId: "session-a",
      projectFingerprint: "sha256:postgres-project",
      projectRoot: "/client/project",
      serverProjectRoot: "/host/project",
      ownerNodeId: "node-a",
    };
    const created = await first.projectBindings.create(input);
    expect(created).toMatchObject({ generation: 1, state: "attaching", active: true });
    await expect(second.projectBindings.create(input)).rejects.toMatchObject({
      code: "CONFIG_EXISTS",
    });
    await expect(second.projectBindings.get(input.bindingId)).resolves.toEqual(created);
    await expect(first.projectBindings.list()).resolves.toEqual([created]);

    const ready = await second.projectBindings.heartbeat({
      bindingId: input.bindingId,
      ownerNodeId: input.ownerNodeId,
      sessionId: input.sessionId,
      expectedGeneration: created.generation,
      state: "ready",
      syncState: "idle",
    });
    expect(ready).toMatchObject({ generation: 2, readiness: "ready" });
    await expect(
      first.projectBindings.heartbeat({
        bindingId: input.bindingId,
        ownerNodeId: input.ownerNodeId,
        expectedGeneration: created.generation,
        state: "degraded",
        syncState: "failed",
      }),
    ).rejects.toMatchObject({ details: expect.objectContaining({ kind: "stale_generation" }) });

    const ended = await first.projectBindings.end({
      bindingId: input.bindingId,
      ownerNodeId: input.ownerNodeId,
      expectedGeneration: ready.generation,
    });
    expect(ended).toMatchObject({ generation: 3, state: "ended", active: false });

    const expiring = await first.projectBindings.create({
      ...input,
      bindingId: "binding-expiring",
      sessionId: "session-expiring",
      leaseTtlMs: 0.001,
    });
    await expect(
      second.projectBindings.heartbeat({
        bindingId: expiring.bindingId,
        ownerNodeId: expiring.ownerNodeId,
        expectedGeneration: expiring.generation,
        state: "ready",
        syncState: "idle",
      }),
    ).rejects.toMatchObject({ projectBindingCode: "lease_expired" });
  },
);

postgresIt("appends, filters, and pages redacted Operator Activity on PostgreSQL", async () => {
  const { first, second } = await openPair("activity");
  const oldest = await first.operatorActivity.append({
    actorClientId: operator.clientId,
    action: "vault_set",
    target: { type: "vault", id: "API_TOKEN", label: "API token" },
    metadata: {
      bytesWritten: 23,
      secretValue: "activity-secret-must-not-appear",
      note: "cap_remote_access_activity-secret",
    },
    now: new Date("2026-07-18T10:00:00.000Z"),
  });
  const newest = await second.operatorActivity.append({
    actorClientId: "operator-peer",
    action: "caplet.install",
    outcome: "failure",
    target: { type: "installation", id: "installation-1" },
    now: new Date("2026-07-18T10:01:00.000Z"),
  });

  await expect(first.operatorActivity.list({ limit: 1 })).resolves.toEqual({
    entries: [newest],
    nextCursor: newest.id,
  });
  await expect(second.operatorActivity.list({ limit: 1, after: newest.id })).resolves.toEqual({
    entries: [oldest],
  });
  await expect(first.operatorActivity.list({ action: "vault_set" })).resolves.toEqual({
    entries: [oldest],
  });
  expect(JSON.stringify((await second.operatorActivity.list()).entries)).not.toContain(
    "activity-secret",
  );
});

postgresIt(
  "shares host identity, enforces node parity, notifies peers, and fences expired leases",
  async () => {
    const { first, second } = await openPair("coordination");
    const farPast = new Date("1900-01-01T00:00:00.000Z");
    const farFuture = new Date("2999-01-01T00:00:00.000Z");
    const nodeA = await first.coordination.registerNode({
      nodeId: "node-a",
      globalFileManifest: "manifest-a",
      runtimeFingerprint: "runtime-a",
      now: farPast,
    });
    const nodeB = await second.coordination.registerNode({
      nodeId: "node-b",
      globalFileManifest: "manifest-a",
      runtimeFingerprint: "runtime-a",
      now: farFuture,
    });
    expect(nodeB).toMatchObject({ hostId: nodeA.hostId, ready: true, conflict: null });
    await expect(first.coordination.activeNodeCount(60_000)).resolves.toBe(2);
    await expect(
      second.coordination.heartbeat({
        nodeId: "node-b",
        globalFileManifest: "manifest-b",
        runtimeFingerprint: "runtime-a",
        now: farPast,
      }),
    ).resolves.toMatchObject({ ready: false, conflict: "global_file_manifest" });
    await expect(
      second.coordination.heartbeat({
        nodeId: "node-b",
        globalFileManifest: "manifest-a",
        runtimeFingerprint: "runtime-b",
        now: farFuture,
      }),
    ).resolves.toMatchObject({ ready: false, conflict: "runtime_fingerprint" });
    await expect(second.coordination.nodeReady("node-b")).resolves.toBe(false);
    await expect(
      second.coordination.heartbeat({
        nodeId: "node-b",
        globalFileManifest: "manifest-a",
        runtimeFingerprint: "runtime-a",
        now: farPast,
      }),
    ).resolves.toMatchObject({ ready: true, conflict: null });

    const generationRead = Promise.withResolvers<void>();
    const currentConfigGeneration = first.coordination.currentConfigGeneration.bind(
      first.coordination,
    );
    const currentGenerationSpy = vi
      .spyOn(first.coordination, "currentConfigGeneration")
      .mockImplementation(async () => {
        const generation = await currentConfigGeneration();
        generationRead.resolve();
        return generation;
      });
    const wait = first.coordination.waitForConfigGeneration(0, { pollIntervalMs: 10_000 });
    await generationRead.promise;
    await expect(second.coordination.publishConfigGeneration("config-a", "node-b")).resolves.toBe(
      1,
    );
    await expect(wait).resolves.toBe(1);
    currentGenerationSpy.mockRestore();
    await expect(first.coordination.currentConfigGeneration()).resolves.toBe(1);

    const authority = new Pool({ connectionString });
    const leaseTtlMs = 250;
    try {
      const beforeAcquire = (
        await authority.query<{ now: Date }>("select clock_timestamp() as now")
      ).rows[0]!.now;
      const leaseA = await first.coordination.acquireLease({
        leaseName: "asset-gc",
        ownerNodeId: "node-a",
        ttlMs: leaseTtlMs,
        now: farPast,
      });
      const afterAcquire = (await authority.query<{ now: Date }>("select clock_timestamp() as now"))
        .rows[0]!.now;
      expect(leaseA).toMatchObject({ ownerNodeId: "node-a", fencingToken: 1 });
      expect(Date.parse(leaseA!.expiresAt)).toBeGreaterThanOrEqual(
        beforeAcquire.getTime() + leaseTtlMs,
      );
      expect(Date.parse(leaseA!.expiresAt)).toBeLessThanOrEqual(
        afterAcquire.getTime() + leaseTtlMs,
      );
      await expect(
        second.coordination.acquireLease({
          leaseName: "asset-gc",
          ownerNodeId: "node-b",
          ttlMs: leaseTtlMs,
          now: farFuture,
        }),
      ).resolves.toBeUndefined();

      const beforeRenew = (await authority.query<{ now: Date }>("select clock_timestamp() as now"))
        .rows[0]!.now;
      const renewed = await first.coordination.acquireLease({
        leaseName: "asset-gc",
        ownerNodeId: "node-a",
        ttlMs: leaseTtlMs,
        now: farFuture,
      });
      const afterRenew = (await authority.query<{ now: Date }>("select clock_timestamp() as now"))
        .rows[0]!.now;
      expect(renewed).toMatchObject({ ownerNodeId: "node-a", fencingToken: 2 });
      expect(Date.parse(renewed!.expiresAt)).toBeGreaterThanOrEqual(
        beforeRenew.getTime() + leaseTtlMs,
      );
      expect(Date.parse(renewed!.expiresAt)).toBeLessThanOrEqual(afterRenew.getTime() + leaseTtlMs);
      await expect(
        first.coordination.checkpointLease({
          leaseName: "asset-gc",
          ownerNodeId: "node-a",
          fencingToken: 2,
          cursor: "batch-1",
          now: farFuture,
        }),
      ).resolves.toBeUndefined();

      await authority.query("select pg_sleep(0.3)");
      const leaseB = await second.coordination.acquireLease({
        leaseName: "asset-gc",
        ownerNodeId: "node-b",
        ttlMs: leaseTtlMs,
        now: farFuture,
      });
      expect(leaseB).toMatchObject({ ownerNodeId: "node-b", fencingToken: 3 });
      await expect(
        first.coordination.checkpointLease({
          leaseName: "asset-gc",
          ownerNodeId: "node-a",
          fencingToken: 2,
          cursor: "stale",
          now: farPast,
        }),
      ).rejects.toMatchObject({ details: { kind: "stale_lease" } });
      await expect(
        second.coordination.checkpointLease({
          leaseName: "asset-gc",
          ownerNodeId: "node-b",
          fencingToken: 3,
          cursor: "batch-2",
          now: farFuture,
        }),
      ).resolves.toBeUndefined();
    } finally {
      await authority.end();
    }

    await second.coordination.unregisterNode("node-b");
    await expect(first.coordination.nodeReady("node-b")).resolves.toBe(false);
    await expect(first.coordination.activeNodeCount(60_000)).resolves.toBe(1);
  },
);

postgresIt("serializes concurrent node heartbeats without deadlocks", async () => {
  const { first, second } = await openPair("heartbeat_race");
  const input = {
    globalFileManifest: "manifest",
    runtimeFingerprint: "runtime",
  };
  await first.coordination.registerNode({ ...input, nodeId: "node-a" });
  await second.coordination.registerNode({ ...input, nodeId: "node-b" });

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await expect(
      Promise.all([
        first.coordination.heartbeat({ ...input, nodeId: "node-a" }),
        second.coordination.heartbeat({ ...input, nodeId: "node-b" }),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ nodeId: "node-a", ready: true }),
      expect.objectContaining({ nodeId: "node-b", ready: true }),
    ]);
  }
});

function setupAttempt(attemptId: string, now: Date): SetupAttempt {
  return {
    attemptId,
    projectFingerprint: "project-postgres",
    capletId: "ast-grep",
    contentHash: "sha256:postgres-content",
    targetKind: "remote_host",
    actor: "automation",
    status: "succeeded",
    phase: "commands",
    commandLabel: attemptId,
    argv: ["echo", attemptId],
    exitCode: 0,
    durationMs: 1,
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    stdout: "ok",
    stderr: "",
    redacted: true,
    retention: { maxAttempts: 3, days: 7 },
  };
}
