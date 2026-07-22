import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterEach, expect, it } from "vitest";
import { createHostStorage, migrateHostStorage } from "../src/storage";
import { RemoteSecurityStore } from "../src/storage/remote-security";
import * as postgres from "../src/storage/schema/postgres";

const postgresUrl = process.env.CAPLETS_TEST_POSTGRES_URL;
if (process.env.CAPLETS_REQUIRE_TEST_POSTGRES === "1" && !postgresUrl) {
  throw new Error("CAPLETS_TEST_POSTGRES_URL is required when CAPLETS_REQUIRE_TEST_POSTGRES=1.");
}
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

postgresIt("pages and filters remote security rows identically on PostgreSQL", async () => {
  const schema = `caplets_remote_security_page_${randomUUID().replaceAll("-", "")}`;
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
    const now = new Date();
    const clients = [];
    for (const clientLabel of ["Access", "Operator", "Revoked"]) {
      const pairing = await security.createPairingCode({ hostUrl, clientLabel, now });
      clients.push(await security.exchangePairingCode({ hostUrl, code: pairing.code, now }));
    }
    await security.changeClientRole({
      operatorClientId: clients[0]!.clientId,
      clientId: clients[1]!.clientId,
      role: "operator",
      now,
    });
    await security.revokeClient({
      operatorClientId: clients[1]!.clientId,
      clientId: clients[2]!.clientId,
      now,
    });
    const expectedClientIds = clients.map((client) => client.clientId).sort();

    const firstClients = await security.listClientsPage({ limit: 2 });
    const secondClients = await security.listClientsPage({
      limit: 2,
      after: firstClients.nextKey,
    });
    const operators = await security.listClientsPage({ limit: 10, role: "operator" });
    const revoked = await security.listClientsPage({ limit: 10, revoked: true });

    expect(
      [...firstClients.items, ...secondClients.items].map((client) => client.clientId),
    ).toEqual(expectedClientIds);
    expect(operators.items.map((client) => client.clientId)).toEqual([clients[1]!.clientId]);
    expect(revoked.items.map((client) => client.clientId)).toEqual([clients[2]!.clientId]);
    await expect(security.countClients()).resolves.toBe(3);
    await expect(security.getClient(clients[1]!.clientId)).resolves.toMatchObject({
      clientId: clients[1]!.clientId,
      generation: 2,
    });
    await expect(security.getClient("rcli_missing")).resolves.toBeUndefined();

    const flows = await Promise.all(
      ["Pending", "Denied", "Cancelled"].map((clientLabel) =>
        security.createPendingLogin({ hostUrl, clientLabel, now }),
      ),
    );
    await security.denyPendingLoginFlow({
      operatorClientId: clients[1]!.clientId,
      flowId: flows[1]!.flowId,
      now,
    });
    await security.cancelPendingLogin({
      flowId: flows[2]!.flowId,
      pendingCompletionSecret: flows[2]!.pendingCompletionSecret,
      now,
    });
    const expectedFlowIds = flows.map((flow) => flow.flowId).sort();

    const firstFlows = await security.listPendingLoginsPage({ limit: 2 });
    const secondFlows = await security.listPendingLoginsPage({
      limit: 2,
      after: firstFlows.nextKey,
    });
    const filtered = await security.listPendingLoginsPage({
      limit: 10,
      statuses: ["denied", "pending", "denied"],
    });

    expect([...firstFlows.items, ...secondFlows.items].map((flow) => flow.flowId)).toEqual(
      expectedFlowIds,
    );
    expect(filtered.items.map((flow) => flow.status).sort()).toEqual(["denied", "pending"]);
    await expect(security.countPendingLogins(["pending"])).resolves.toBe(1);
    await expect(security.countPendingLogins(["denied", "pending", "denied"])).resolves.toBe(2);
    await expect(security.getPendingLogin(flows[0]!.flowId, now)).resolves.toMatchObject({
      flowId: flows[0]!.flowId,
      status: "pending",
      generation: 1,
    });
    await expect(security.getPendingLogin("rlogin_missing", now)).resolves.toBeUndefined();
    const expiring = await security.createPendingLogin({
      hostUrl,
      clientLabel: "Expiring",
      now: new Date(now.getTime() - 25 * 60 * 60_000),
    });
    await expect(security.getPendingLogin(expiring.flowId, now)).resolves.toMatchObject({
      flowId: expiring.flowId,
      status: "expired",
      generation: 2,
    });
  } finally {
    await storage.close();
  }
});

postgresIt("uses bytewise mixed-case remote security cursors on PostgreSQL", async () => {
  const schema = `caplets_remote_collate_${randomUUID().replaceAll("-", "")}`;
  schemas.push(schema);
  const config = {
    type: "postgres" as const,
    connectionString: postgresUrl!,
    schema,
  };
  await migrateHostStorage(config);
  const storage = await createHostStorage(config);
  try {
    if (storage.database.dialect !== "postgres") {
      throw new Error("Expected PostgreSQL test storage.");
    }
    const security = new RemoteSecurityStore(storage.database);
    const hostUrl = "https://remote.example.test";
    const createdAt = "2026-07-20T00:00:00.000Z";
    const clientIds = ["rcli_Z", "rcli_a", "rcli_zz"];
    await storage.database.db.insert(postgres.remoteClients).values(
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
    );
    const flowIds = ["rlogin_Z", "rlogin_a", "rlogin_zz"];
    await storage.database.db.insert(postgres.remotePendingLogins).values(
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
    );

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
  } finally {
    await storage.close();
  }
});

postgresIt("enforces remote generation CAS parity on PostgreSQL", async () => {
  const schema = `caplets_remote_security_cas_${randomUUID().replaceAll("-", "")}`;
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
    const client = await security.exchangePairingCode({ hostUrl, code: pairing.code });
    expect(await security.listClients()).toEqual([
      expect.objectContaining({ clientId: client.clientId, generation: 1 }),
    ]);

    const attempts = await Promise.allSettled([
      security.changeClientRole({
        operatorClientId: "rcli_admin",
        clientId: client.clientId,
        role: "operator",
        expectedGeneration: 1,
      }),
      security.revokeClient({
        operatorClientId: "rcli_admin",
        clientId: client.clientId,
        expectedGeneration: 1,
      }),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await security.listClients()).toEqual([
      expect.objectContaining({ clientId: client.clientId, generation: 2 }),
    ]);

    const pending = await security.createPendingLogin({ hostUrl });
    await expect(
      security.approvePendingLoginFlow({
        operatorClientId: "rcli_admin",
        flowId: pending.flowId,
        expectedGeneration: 1,
      }),
    ).resolves.toMatchObject({ status: "approved", generation: 2 });
  } finally {
    await storage.close();
  }
});
