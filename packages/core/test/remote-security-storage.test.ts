import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostStorage, type HostStorage } from "../src/storage";
import { RemoteSecurityStore } from "../src/storage/remote-security";
import * as sqlite from "../src/storage/schema/sqlite";

const hostUrl = "https://remote.example.test";
let storage: HostStorage;
let security: RemoteSecurityStore;

async function createClient(clientLabel: string, now: Date) {
  const pairing = await security.createPairingCode({ hostUrl, clientLabel, now });
  return await security.exchangePairingCode({ hostUrl, code: pairing.code, now });
}

beforeEach(async () => {
  storage = await createHostStorage({ type: "sqlite", path: ":memory:" });
  security = new RemoteSecurityStore(storage.database);
});

afterEach(async () => {
  await storage.close();
});

describe("RemoteSecurityStore", () => {
  it("traverses remote clients with tied timestamps by client ID", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const clients = await Promise.all([
      createClient("One", now),
      createClient("Two", now),
      createClient("Three", now),
    ]);
    const expectedIds = clients.map((client) => client.clientId).sort();

    const first = await security.listClientsPage({ limit: 2 });
    const second = await security.listClientsPage({ limit: 2, after: first.nextKey });

    expect(first.items.map((client) => client.clientId)).toEqual(expectedIds.slice(0, 2));
    expect(first.nextKey).toEqual({
      createdAt: now.toISOString(),
      clientId: expectedIds[1],
    });
    expect(second.items.map((client) => client.clientId)).toEqual(expectedIds.slice(2));
    expect(second.nextKey).toBeUndefined();
  });

  it("uses bytewise mixed-case tie-breakers for client and pending-login cursors", async () => {
    if (storage.database.dialect !== "sqlite") throw new Error("Expected SQLite test storage.");
    const createdAt = "2026-07-20T00:00:00.000Z";
    const clientIds = ["rcli_Z", "rcli_a", "rcli_zz"];
    storage.database.db
      .insert(sqlite.remoteClients)
      .values(
        clientIds.map((clientId, index) => ({
          clientId,
          clientLabel: clientId,
          role: "access",
          hostUrl,
          accessTokenHash: `access-hash-${index}`,
          accessExpiresAt: "2099-01-01T00:00:00.000Z",
          generation: 1,
          createdAt,
        })),
      )
      .run();
    const flowIds = ["rlogin_Z", "rlogin_a", "rlogin_zz"];
    storage.database.db
      .insert(sqlite.remotePendingLogins)
      .values(
        flowIds.map((flowId, index) => ({
          flowId,
          hostUrl,
          operatorCodeHash: `operator-hash-${index}`,
          pendingRefreshHash: `pending-refresh-hash-${index}`,
          pendingCompletionHash: `pending-completion-hash-${index}`,
          clientLabel: flowId,
          requestedRole: "access",
          createdAt,
          codeExpiresAt: "2099-01-01T00:00:00.000Z",
          flowExpiresAt: "2099-01-01T00:00:00.000Z",
          generation: 1,
          status: "pending",
        })),
      )
      .run();

    const firstClient = await security.listClientsPage({ limit: 1 });
    const secondClient = await security.listClientsPage({
      limit: 1,
      after: firstClient.nextKey,
    });
    const thirdClient = await security.listClientsPage({
      limit: 1,
      after: secondClient.nextKey,
    });
    expect([
      firstClient.items[0]?.clientId,
      secondClient.items[0]?.clientId,
      thirdClient.items[0]?.clientId,
    ]).toEqual(clientIds);
    expect(thirdClient.nextKey).toBeUndefined();

    const firstFlow = await security.listPendingLoginsPage({ limit: 1 });
    const secondFlow = await security.listPendingLoginsPage({
      limit: 1,
      after: firstFlow.nextKey,
    });
    const thirdFlow = await security.listPendingLoginsPage({
      limit: 1,
      after: secondFlow.nextKey,
    });
    expect([
      firstFlow.items[0]?.flowId,
      secondFlow.items[0]?.flowId,
      thirdFlow.items[0]?.flowId,
    ]).toEqual(flowIds);
    expect(thirdFlow.nextKey).toBeUndefined();

    const firstClientDesc = await security.listClientsPage({ limit: 1, sort: "desc" });
    const secondClientDesc = await security.listClientsPage({
      limit: 1,
      sort: "desc",
      after: firstClientDesc.nextKey,
    });
    const thirdClientDesc = await security.listClientsPage({
      limit: 1,
      sort: "desc",
      after: secondClientDesc.nextKey,
    });
    expect([
      firstClientDesc.items[0]?.clientId,
      secondClientDesc.items[0]?.clientId,
      thirdClientDesc.items[0]?.clientId,
    ]).toEqual([...clientIds].reverse());

    const firstFlowDesc = await security.listPendingLoginsPage({ limit: 1, sort: "desc" });
    const secondFlowDesc = await security.listPendingLoginsPage({
      limit: 1,
      sort: "desc",
      after: firstFlowDesc.nextKey,
    });
    const thirdFlowDesc = await security.listPendingLoginsPage({
      limit: 1,
      sort: "desc",
      after: secondFlowDesc.nextKey,
    });
    expect([
      firstFlowDesc.items[0]?.flowId,
      secondFlowDesc.items[0]?.flowId,
      thirdFlowDesc.items[0]?.flowId,
    ]).toEqual([...flowIds].reverse());
  });

  it("looks up one client without using the full-list compatibility adapter", async () => {
    const issued = await createClient("Direct lookup", new Date("2026-07-20T01:00:00.000Z"));
    const listClients = vi
      .spyOn(security, "listClients")
      .mockRejectedValue(new Error("full-list lookup must not run"));

    await expect(security.getClient(issued.clientId)).resolves.toMatchObject({
      clientId: issued.clientId,
      clientLabel: "Direct lookup",
      generation: 1,
    });
    await expect(security.getClient("rcli_missing")).resolves.toBeUndefined();
    expect(listClients).not.toHaveBeenCalled();
  });

  it("looks up and expires one pending login without using the full-list adapter", async () => {
    const createdAt = new Date("2026-07-20T02:00:00.000Z");
    const recent = await security.createPendingLogin({
      hostUrl,
      clientLabel: "Recent",
      now: createdAt,
    });
    const old = await security.createPendingLogin({
      hostUrl,
      clientLabel: "Old",
      now: new Date(createdAt.getTime() - 49 * 60 * 60_000),
    });
    const listPendingLogins = vi
      .spyOn(security, "listPendingLogins")
      .mockRejectedValue(new Error("full-list lookup must not run"));
    const lookupAt = new Date(createdAt.getTime() + 25 * 60 * 60_000);

    await expect(security.getPendingLogin(recent.flowId, lookupAt)).resolves.toMatchObject({
      flowId: recent.flowId,
      status: "expired",
      generation: 2,
    });
    await expect(security.getPendingLogin(old.flowId, lookupAt)).resolves.toBeUndefined();
    await expect(security.getPendingLogin("rlogin_missing", lookupAt)).resolves.toBeUndefined();
    expect(listPendingLogins).not.toHaveBeenCalled();
  });

  it("bounds and filters safe client projections without changing stored state", async () => {
    const now = new Date("2026-01-02T00:00:00.000Z");
    const [access, operator, revoked, other] = await Promise.all([
      createClient("Access", now),
      createClient("Operator", now),
      createClient("Revoked", now),
      createClient("Other", now),
    ]);
    await security.changeClientRole({
      operatorClientId: access.clientId,
      clientId: operator.clientId,
      role: "operator",
      now,
    });
    await security.revokeClient({
      operatorClientId: operator.clientId,
      clientId: revoked.clientId,
      now,
    });
    const before = await security.dumpForTest();

    const bounded = await security.listClientsPage({ limit: 2 });
    const operators = await security.listClientsPage({ limit: 10, role: "operator" });
    const revokedClients = await security.listClientsPage({ limit: 10, revoked: true });
    const activeClients = await security.listClientsPage({ limit: 10, revoked: false });

    expect(bounded.items).toHaveLength(2);
    expect(bounded.nextKey).toBeDefined();
    expect(bounded.items[0]).not.toHaveProperty("accessTokenHash");
    expect(operators.items.map((client) => client.clientId)).toEqual([operator.clientId]);
    expect(revokedClients.items.map((client) => client.clientId)).toEqual([revoked.clientId]);
    expect(activeClients.items.map((client) => client.clientId).sort()).toEqual(
      [access.clientId, operator.clientId, other.clientId].sort(),
    );
    expect(await security.dumpForTest()).toEqual(before);
    await expect(security.countClients()).resolves.toBe(4);
  });

  it("rejects invalid remote security page limits", async () => {
    await expect(security.listClientsPage({ limit: 0 })).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
    await expect(security.listClientsPage({ limit: 501 })).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
    await expect(security.listPendingLoginsPage({ limit: 1.5 })).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
  });

  it("traverses tied pending logins and normalizes status filters", async () => {
    const now = new Date();
    const flows = await Promise.all(
      ["Pending", "Approved", "Denied", "Cancelled"].map((clientLabel) =>
        security.createPendingLogin({ hostUrl, clientLabel, now }),
      ),
    );
    await security.approvePendingLoginFlow({
      operatorClientId: "rcli_admin",
      flowId: flows[1]!.flowId,
      now,
    });
    await security.denyPendingLoginFlow({
      operatorClientId: "rcli_admin",
      flowId: flows[2]!.flowId,
      now,
    });
    await security.cancelPendingLogin({
      flowId: flows[3]!.flowId,
      pendingCompletionSecret: flows[3]!.pendingCompletionSecret,
      now,
    });
    const expectedIds = flows.map((flow) => flow.flowId).sort();
    const before = await security.dumpForTest();

    const first = await security.listPendingLoginsPage({ limit: 2 });
    const second = await security.listPendingLoginsPage({ limit: 2, after: first.nextKey });
    const filtered = await security.listPendingLoginsPage({
      limit: 10,
      statuses: ["pending", "denied", "pending"],
    });

    expect([...first.items, ...second.items].map((flow) => flow.flowId)).toEqual(expectedIds);
    expect(first.nextKey).toEqual({
      createdAt: now.toISOString(),
      flowId: expectedIds[1],
    });
    expect(second.nextKey).toBeUndefined();
    expect(filtered.items.map((flow) => flow.status).sort()).toEqual(["denied", "pending"]);
    await expect(security.countPendingLogins(["pending"])).resolves.toBe(1);
    await expect(security.countPendingLogins(["denied", "pending", "denied"])).resolves.toBe(2);
    expect(await security.dumpForTest()).toEqual(before);
  });

  it("expires and removes pending logins before selecting a page", async () => {
    const now = new Date();
    const recentExpired = await security.createPendingLogin({
      hostUrl,
      clientLabel: "Recently expired",
      now: new Date(now.getTime() - 25 * 60 * 60_000),
    });
    const oldExpired = await security.createPendingLogin({
      hostUrl,
      clientLabel: "Old expired",
      now: new Date(now.getTime() - 49 * 60 * 60_000),
    });
    const oldDenied = await security.createPendingLogin({
      hostUrl,
      clientLabel: "Old denied",
      now: new Date(now.getTime() - 50 * 60 * 60_000),
    });
    await security.denyPendingLoginFlow({
      operatorClientId: "rcli_admin",
      flowId: oldDenied.flowId,
      now: new Date(now.getTime() - 50 * 60 * 60_000),
    });

    const page = await security.listPendingLoginsPage({ limit: 10 });

    expect(page.items).toEqual([
      expect.objectContaining({
        flowId: recentExpired.flowId,
        status: "expired",
        generation: 2,
      }),
    ]);
    expect(page.items.map((flow) => flow.flowId)).not.toContain(oldExpired.flowId);
    expect(page.items.map((flow) => flow.flowId)).not.toContain(oldDenied.flowId);
  });

  it("exchanges a pairing code exactly once under concurrent requests", async () => {
    const pairing = await security.createPairingCode({ hostUrl });

    const attempts = await Promise.allSettled([
      security.exchangePairingCode({ hostUrl, code: pairing.code }),
      security.exchangePairingCode({ hostUrl, code: pairing.code }),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await security.listClients()).toHaveLength(1);
    if (storage.database.dialect !== "sqlite") throw new Error("Expected SQLite test storage.");
    expect(storage.database.db.select().from(sqlite.remoteClients).all()).toHaveLength(1);
    expect(storage.database.db.select().from(sqlite.remotePairingCodes).all()[0]?.usedAt).toEqual(
      expect.any(String),
    );
  });

  it("rotates refresh material and revokes the family after replay outside the grace window", async () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const pairing = await security.createPairingCode({ hostUrl, now });
    const issued = await security.exchangePairingCode({ hostUrl, code: pairing.code, now });
    const rotated = await security.refreshClientCredentials({
      hostUrl,
      refreshToken: issued.refreshToken,
      now,
    });

    await expect(
      security.refreshClientCredentials({
        hostUrl,
        refreshToken: issued.refreshToken,
        now: new Date(now.getTime() + 30_001),
      }),
    ).rejects.toMatchObject({ code: "REMOTE_CREDENTIALS_REVOKED" });
    await expect(
      security.validateAccessToken({ hostUrl, accessToken: rotated.accessToken, now }),
    ).rejects.toMatchObject({ code: "REMOTE_CREDENTIALS_REVOKED" });
  });

  it("approves and completes a pending login with idempotent completion replay", async () => {
    const pending = await security.createPendingLogin({
      hostUrl,
      requestedRole: "operator",
      clientLabel: "CLI",
    });

    const approved = await security.approvePendingLogin({
      operatorClientId: "rcli_admin",
      operatorCode: pending.operatorCode,
    });
    const credentials = await security.completePendingLogin({
      flowId: pending.flowId,
      pendingCompletionSecret: pending.pendingCompletionSecret,
      hostUrl,
      requiredRole: "operator",
    });
    const replayed = await security.completePendingLogin({
      flowId: pending.flowId,
      pendingCompletionSecret: pending.pendingCompletionSecret,
      hostUrl,
      requiredRole: "operator",
    });

    expect(approved).toMatchObject({ status: "approved", grantedRole: "operator" });
    expect(replayed).toEqual(credentials);
    await expect(
      security.pollPendingLogin({
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
      }),
    ).resolves.toEqual({ flowId: pending.flowId, status: "exchanged" });
  });

  it("serializes concurrent refresh rotation without issuing two live descendants", async () => {
    const pairing = await security.createPairingCode({ hostUrl });
    const issued = await security.exchangePairingCode({ hostUrl, code: pairing.code });

    const attempts = await Promise.allSettled([
      security.refreshClientCredentials({ hostUrl, refreshToken: issued.refreshToken }),
      security.refreshClientCredentials({ hostUrl, refreshToken: issued.refreshToken }),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await security.listClients()).toHaveLength(1);
  });

  it("projects generations and atomically rejects stale concurrent remote client mutations", async () => {
    const issued = await createClient("CAS client", new Date("2026-01-03T00:00:00.000Z"));
    const initial = (await security.listClients()).find(
      (client) => client.clientId === issued.clientId,
    );
    expect(initial).toMatchObject({ clientId: issued.clientId, generation: 1 });
    expect(initial).not.toHaveProperty("accessTokenHash");
    expect(initial).not.toHaveProperty("refreshTokenHash");

    const attempts = await Promise.allSettled([
      security.changeClientRole({
        operatorClientId: "rcli_admin",
        clientId: issued.clientId,
        role: "operator",
        expectedGeneration: 1,
      }),
      security.revokeClient({
        operatorClientId: "rcli_admin",
        clientId: issued.clientId,
        expectedGeneration: 1,
      }),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: {
        code: "REQUEST_INVALID",
        details: {
          kind: "stale_generation",
          expectedGeneration: 1,
          currentGeneration: 2,
        },
      },
    });
    const afterRace = (await security.listClients()).find(
      (client) => client.clientId === issued.clientId,
    );
    expect(afterRace).toMatchObject({ generation: 2 });

    await expect(
      security.changeClientRole({
        operatorClientId: "rcli_admin",
        clientId: issued.clientId,
        role: afterRace?.role === "operator" ? "access" : "operator",
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({
      details: { kind: "stale_generation", currentGeneration: 2 },
    });
    expect(
      (await security.listClients()).find((client) => client.clientId === issued.clientId),
    ).toEqual(afterRace);
    const exact = await createClient("Exact increments", new Date("2026-01-03T01:00:00.000Z"));
    await security.refreshClientCredentials({
      hostUrl,
      refreshToken: exact.refreshToken,
      now: new Date("2026-01-03T01:01:00.000Z"),
    });
    expect(
      (await security.listClients()).find((client) => client.clientId === exact.clientId),
    ).toMatchObject({ generation: 2 });
    await expect(
      security.changeClientRole({
        operatorClientId: "rcli_admin",
        clientId: exact.clientId,
        role: "operator",
        expectedGeneration: 2,
      }),
    ).resolves.toMatchObject({ generation: 3 });
    await expect(
      security.revokeClient({
        operatorClientId: "rcli_admin",
        clientId: exact.clientId,
        expectedGeneration: 3,
      }),
    ).resolves.toMatchObject({ generation: 4 });
    await expect(
      security.revokeClient({
        operatorClientId: "rcli_admin",
        clientId: exact.clientId,
        expectedGeneration: 4,
      }),
    ).resolves.toMatchObject({ generation: 4 });
  });

  it("increments pending login generations exactly once per visible transition", async () => {
    const now = new Date("2026-01-04T00:00:00.000Z");
    const pending = await security.createPendingLogin({ hostUrl, now });
    expect((await security.listPendingLogins(now))[0]).toMatchObject({
      flowId: pending.flowId,
      status: "pending",
      generation: 1,
    });

    const refreshed = await security.refreshPendingLogin({
      flowId: pending.flowId,
      pendingCompletionSecret: pending.pendingCompletionSecret,
      pendingRefreshSecret: pending.pendingRefreshSecret,
      expectedGeneration: 1,
      now,
    });
    expect(refreshed).toMatchObject({ flowId: pending.flowId, generation: 2 });

    const approved = await security.approvePendingLoginFlow({
      operatorClientId: "rcli_admin",
      flowId: pending.flowId,
      expectedGeneration: 2,
      now,
    });
    expect(approved).toMatchObject({ status: "approved", generation: 3 });

    await expect(
      security.denyPendingLoginFlow({
        operatorClientId: "rcli_admin",
        flowId: pending.flowId,
        expectedGeneration: 2,
        now,
      }),
    ).rejects.toMatchObject({
      details: { kind: "stale_generation", currentGeneration: 3 },
    });

    const credentials = await security.completePendingLogin({
      flowId: pending.flowId,
      pendingCompletionSecret: pending.pendingCompletionSecret,
      hostUrl,
      expectedGeneration: 3,
      now,
    });
    expect(credentials.pendingLoginGeneration).toBe(4);
    expect(
      (await security.listPendingLogins(now)).find((flow) => flow.flowId === pending.flowId),
    ).toMatchObject({ status: "exchanged", generation: 4 });
    expect(
      (await security.listClients()).find((client) => client.clientId === credentials.clientId),
    ).toMatchObject({ generation: 1 });

    const cancelled = await security.createPendingLogin({ hostUrl, now });
    await expect(
      security.cancelPendingLogin({
        flowId: cancelled.flowId,
        pendingCompletionSecret: cancelled.pendingCompletionSecret,
        expectedGeneration: 1,
        now,
      }),
    ).resolves.toEqual({
      flowId: cancelled.flowId,
      status: "cancelled",
      generation: 2,
    });

    const denied = await security.createPendingLogin({ hostUrl, now });
    await expect(
      security.denyPendingLoginFlow({
        operatorClientId: "rcli_admin",
        flowId: denied.flowId,
        expectedGeneration: 1,
        now,
      }),
    ).resolves.toMatchObject({ status: "denied", generation: 2 });
  });

  it("records approve, deny, revoke, and role changes in their state transactions", async () => {
    const approvedFlow = await security.createPendingLogin({ hostUrl });
    await security.approvePendingLogin({
      operatorClientId: "rcli_admin",
      operatorCode: approvedFlow.operatorCode,
    });
    const credentials = await security.completePendingLogin({
      flowId: approvedFlow.flowId,
      pendingCompletionSecret: approvedFlow.pendingCompletionSecret,
      hostUrl,
    });
    await security.changeClientRole({
      operatorClientId: "rcli_admin",
      clientId: credentials.clientId,
      role: "operator",
    });
    await security.revokeClient({ operatorClientId: "rcli_admin", clientId: credentials.clientId });
    const deniedFlow = await security.createPendingLogin({ hostUrl });
    await security.denyPendingLogin({
      operatorClientId: "rcli_admin",
      operatorCode: deniedFlow.operatorCode,
    });

    if (storage.database.dialect !== "sqlite") throw new Error("Expected SQLite test storage.");
    const activities = storage.database.db
      .select()
      .from(sqlite.operatorActivity)
      .where(eq(sqlite.operatorActivity.operatorClientId, "rcli_admin"))
      .all();
    expect(activities.map((activity) => activity.action)).toEqual([
      "remote_pending_login_approved",
      "remote_client_role_changed",
      "remote_client_revoked",
      "remote_pending_login_denied",
    ]);
    expect(activities.every((activity) => activity.outcome === "succeeded")).toBe(true);
  });
});
