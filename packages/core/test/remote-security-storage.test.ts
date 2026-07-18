import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostStorage, type HostStorage } from "../src/storage";
import { RemoteSecurityStore } from "../src/storage/remote-security";
import * as sqlite from "../src/storage/schema/sqlite";

const hostUrl = "https://remote.example.test";
let storage: HostStorage;
let security: RemoteSecurityStore;

beforeEach(async () => {
  storage = await createHostStorage({ type: "sqlite", path: ":memory:" });
  security = new RemoteSecurityStore(storage.database);
});

afterEach(async () => {
  await storage.close();
});

describe("RemoteSecurityStore", () => {
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
