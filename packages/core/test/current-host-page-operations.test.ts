import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCurrentHostOperations,
  type CurrentHostOperationsDependencies,
  type CurrentHostPrincipal,
} from "../src/current-host/operations";
import { RemoteServerCredentialStore } from "../src/remote/server-credential-store";
import { createHostStorage } from "../src/storage";

const roots: string[] = [];
const principal = {
  clientId: "rcli_abcdefghijklmnop",
  hostUrl: "https://caplets.example.com/",
  role: "operator" as const,
};

const activityLog: CurrentHostOperationsDependencies["activityLog"] = {
  append: () => undefined,
  list: () => ({ entries: [] }),
};

const engine: CurrentHostOperationsDependencies["engine"] = {
  enabledServers: () => [],
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Current Host keyset page operations", () => {
  it("forwards normalized filters to authoritative repositories and traverses bounded safe pages", async () => {
    const root = temporaryRoot();
    const storage = await createHostStorage(
      { type: "sqlite", path: join(root, "host.sqlite3") },
      { vaultRoot: join(root, "vault") },
    );
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "project", ".caplets", "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          status: {
            name: "Status",
            description: "Status tools",
            command: "status-server",
          },
        },
      }),
    );
    try {
      const clientDates = [0, 1, 2].map((offset) => new Date(Date.UTC(2026, 0, 1, 0, offset)));
      const clients = await Promise.all(
        clientDates.map(async (now, offset) => {
          const pairing = await storage.remoteSecurity.createPairingCode({
            hostUrl: principal.hostUrl,
            clientLabel: `Client ${offset}`,
            now,
          });
          return await storage.remoteSecurity.exchangePairingCode({
            hostUrl: principal.hostUrl,
            code: pairing.code,
            clientLabel: `Client ${offset}`,
            now,
          });
        }),
      );
      await storage.remoteSecurity.revokeClient({
        operatorClientId: principal.clientId,
        clientId: clients[2]!.clientId,
        now: new Date(Date.UTC(2026, 0, 2)),
      });

      const loginDates = [0, 1, 2].map((offset) => new Date(Date.UTC(2030, 0, 3, 0, offset)));
      const logins = await Promise.all(
        loginDates.map(
          async (now, offset) =>
            await storage.remoteSecurity.createPendingLogin({
              hostUrl: principal.hostUrl,
              clientLabel: `Login ${offset}`,
              requestedRole: "access",
              now,
            }),
        ),
      );
      await storage.remoteSecurity.approvePendingLoginFlow({
        operatorClientId: principal.clientId,
        flowId: logins[1]!.flowId,
        now: new Date(Date.UTC(2030, 0, 3, 0, 5)),
      });
      await storage.remoteSecurity.denyPendingLoginFlow({
        operatorClientId: principal.clientId,
        flowId: logins[2]!.flowId,
        now: new Date(Date.UTC(2030, 0, 3, 0, 5)),
      });

      for (const key of ["ALPHA", "BETA", "GAMMA"]) {
        await storage.vaultValues.set(key, `${key.toLowerCase()}-secret`, {
          operatorClientId: principal.clientId,
        });
      }
      for (const referenceName of ["FIRST", "SECOND", "THIRD"]) {
        await storage.vaultGrants.grant({
          capletId: "status",
          vaultKey: "ALPHA",
          referenceName,
          originKind: "global-config",
          originPath: configPath,
          operator: principal,
        });
      }

      const legacyClients = vi.spyOn(storage.remoteSecurity, "listClients");
      const legacyLogins = vi.spyOn(storage.remoteSecurity, "listPendingLogins");
      const legacyValues = vi.spyOn(storage.vaultValues, "listValues");
      const legacyGrants = vi.spyOn(storage.vaultGrants, "list");
      const clientsPage = vi.spyOn(storage.remoteSecurity, "listClientsPage");
      const loginsPage = vi.spyOn(storage.remoteSecurity, "listPendingLoginsPage");
      const valuesPage = vi.spyOn(storage.vaultValues, "listValuesPage");
      const grantsPage = vi.spyOn(storage.vaultGrants, "listPage");
      const operations = createCurrentHostOperations({
        engine,
        activityLog,
        control: { configPath, projectConfigPath, authDir: join(root, "vault") },
        remoteCredentialStore: storage.remoteSecurity,
        vaultValues: storage.vaultValues,
        vaultGrants: storage.vaultGrants,
        version: "test-version",
      });

      const firstClients = await operations.execute(principal, {
        kind: "remote_clients_page",
        limit: 1,
        sort: "asc",
        role: "access",
        revoked: false,
      });
      const secondClients = await operations.execute(principal, {
        kind: "remote_clients_page",
        limit: 1,
        sort: "asc",
        after: firstClients.page.nextKey,
        role: "access",
        revoked: false,
      });
      expect(firstClients.page).toEqual({
        items: [expect.objectContaining({ clientId: clients[0]!.clientId, role: "access" })],
        nextKey: {
          createdAt: clientDates[0]!.toISOString(),
          clientId: clients[0]!.clientId,
        },
      });
      expect(secondClients.page).toEqual({
        items: [expect.objectContaining({ clientId: clients[1]!.clientId, role: "access" })],
      });
      expect(clientsPage).toHaveBeenNthCalledWith(1, {
        limit: 1,
        sort: "asc",
        role: "access",
        revoked: false,
      });
      expect(clientsPage).toHaveBeenNthCalledWith(2, {
        limit: 1,
        sort: "asc",
        after: firstClients.page.nextKey,
        role: "access",
        revoked: false,
      });
      expect(clientsPage).toHaveBeenCalledTimes(2);

      const firstLogins = await operations.execute(principal, {
        kind: "remote_login_requests_page",
        limit: 1,
        sort: "asc",
        statuses: ["approved", "pending"],
      });
      const secondLogins = await operations.execute(principal, {
        kind: "remote_login_requests_page",
        limit: 1,
        sort: "asc",
        after: firstLogins.page.nextKey,
        statuses: ["approved", "pending"],
      });
      expect(firstLogins.page).toEqual({
        items: [expect.objectContaining({ flowId: logins[0]!.flowId, status: "pending" })],
        nextKey: { createdAt: loginDates[0]!.toISOString(), flowId: logins[0]!.flowId },
      });
      expect(secondLogins.page).toEqual({
        items: [expect.objectContaining({ flowId: logins[1]!.flowId, status: "approved" })],
      });
      expect(loginsPage).toHaveBeenNthCalledWith(1, {
        limit: 1,
        sort: "asc",
        statuses: ["approved", "pending"],
      });
      expect(loginsPage).toHaveBeenNthCalledWith(2, {
        limit: 1,
        sort: "asc",
        after: firstLogins.page.nextKey,
        statuses: ["approved", "pending"],
      });
      expect(loginsPage).toHaveBeenCalledTimes(2);

      const firstValues = await operations.execute(principal, {
        kind: "vault_values_page",
        limit: 2,
        sort: "asc",
      });
      const secondValues = await operations.execute(principal, {
        kind: "vault_values_page",
        limit: 2,
        sort: "asc",
        after: firstValues.page.nextKey,
      });
      expect(firstValues.page).toEqual({
        items: [
          expect.objectContaining({ key: "ALPHA", present: true }),
          expect.objectContaining({ key: "BETA", present: true }),
        ],
        nextKey: { vaultKey: "BETA" },
      });
      expect(secondValues.page).toEqual({
        items: [expect.objectContaining({ key: "GAMMA", present: true })],
      });
      expect(valuesPage).toHaveBeenNthCalledWith(1, { limit: 2, sort: "asc" });
      expect(valuesPage).toHaveBeenNthCalledWith(2, {
        limit: 2,
        sort: "asc",
        after: firstValues.page.nextKey,
      });
      expect(valuesPage).toHaveBeenCalledTimes(2);

      const firstGrants = await operations.execute(principal, {
        kind: "vault_grants_page",
        limit: 2,
        sort: "asc",
        storedKey: "ALPHA",
        capletId: "status",
      });
      const secondGrants = await operations.execute(principal, {
        kind: "vault_grants_page",
        limit: 2,
        sort: "asc",
        after: firstGrants.page.nextKey,
        storedKey: "ALPHA",
        capletId: "status",
      });
      expect(firstGrants.page).toEqual({
        items: [
          expect.objectContaining({ storedKey: "ALPHA", referenceName: "FIRST" }),
          expect.objectContaining({ storedKey: "ALPHA", referenceName: "SECOND" }),
        ],
        nextKey: expect.objectContaining({ subjectKind: "file", referenceName: "SECOND" }),
      });
      expect(secondGrants.page).toEqual({
        items: [expect.objectContaining({ storedKey: "ALPHA", referenceName: "THIRD" })],
      });
      expect(grantsPage).toHaveBeenNthCalledWith(1, {
        limit: 2,
        sort: "asc",
        vaultKey: "ALPHA",
        capletId: "status",
        activeOrigins: [
          { capletId: "status", originKind: "global-config", originPath: configPath },
        ],
      });
      expect(grantsPage).toHaveBeenNthCalledWith(2, {
        limit: 2,
        sort: "asc",
        after: firstGrants.page.nextKey,
        vaultKey: "ALPHA",
        capletId: "status",
        activeOrigins: [
          { capletId: "status", originKind: "global-config", originPath: configPath },
        ],
      });
      expect(grantsPage).toHaveBeenCalledTimes(2);
      expect(JSON.stringify([firstValues, secondValues, firstGrants, secondGrants])).not.toContain(
        "secret",
      );
      expect(firstGrants.page.items[0]).not.toHaveProperty("originPath");
      expect(firstGrants.page.items[0]).not.toHaveProperty("createdBy");
      expect(firstGrants.page.items[0]).not.toHaveProperty("recordKey");
      expect(legacyClients).not.toHaveBeenCalled();
      expect(legacyLogins).not.toHaveBeenCalled();
      expect(legacyValues).not.toHaveBeenCalled();
      expect(legacyGrants).not.toHaveBeenCalled();
    } finally {
      await storage.close();
    }
  });

  it("keeps the host summary bounded while reporting complete SQL-backed totals", async () => {
    const root = temporaryRoot();
    const storage = await createHostStorage(
      { type: "sqlite", path: join(root, "host.sqlite3") },
      { vaultRoot: join(root, "vault") },
    );
    try {
      for (let index = 0; index < 13; index += 1) {
        const pairing = await storage.remoteSecurity.createPairingCode({
          hostUrl: principal.hostUrl,
          clientLabel: `Client ${index}`,
        });
        await storage.remoteSecurity.exchangePairingCode({
          hostUrl: principal.hostUrl,
          code: pairing.code,
          clientLabel: `Client ${index}`,
        });
        await storage.remoteSecurity.createPendingLogin({
          hostUrl: principal.hostUrl,
          clientLabel: `Pending ${index}`,
          requestedRole: "access",
        });
        await storage.vaultValues.set(`SUMMARY_${index}`, `secret-${index}`, {
          operatorClientId: principal.clientId,
        });
      }

      const legacyClients = vi.spyOn(storage.remoteSecurity, "listClients");
      const legacyLogins = vi.spyOn(storage.remoteSecurity, "listPendingLogins");
      const pendingPage = vi.spyOn(storage.remoteSecurity, "listPendingLoginsPage");
      const clientCount = vi.spyOn(storage.remoteSecurity, "countClients");
      const pendingCount = vi.spyOn(storage.remoteSecurity, "countPendingLogins");
      const legacyValues = vi.spyOn(storage.vaultValues, "listValues");
      const valueCount = vi.spyOn(storage.vaultValues, "countValues");
      const operations = createCurrentHostOperations({
        engine,
        activityLog,
        runtimeState: { read: () => ({ status: "ok" }) },
        projectBindingState: {
          read: () => ({ state: "disconnected", affectedCaplets: [], actions: [] }),
        },
        remoteCredentialStore: storage.remoteSecurity,
        vaultValues: storage.vaultValues,
        vaultGrants: storage.vaultGrants,
        version: "test-version",
      });

      const result = await operations.execute(principal, {
        kind: "summary",
        baseUrl: principal.hostUrl,
        dashboardUrl: `${principal.hostUrl}dashboard`,
        dashboardPath: "/dashboard",
      });

      expect(result.summary.sections.access).toEqual(
        expect.objectContaining({ clients: 13, pending: 13 }),
      );
      expect(result.summary.sections.vault).toEqual(expect.objectContaining({ count: 13 }));
      expect(result.summary.attention).toHaveLength(10);
      expect(pendingPage).toHaveBeenCalledOnce();
      expect(pendingPage).toHaveBeenCalledWith({ limit: 10, statuses: ["pending"] });
      expect(clientCount).toHaveBeenCalledOnce();
      expect(pendingCount).toHaveBeenCalledOnce();
      expect(pendingCount).toHaveBeenCalledWith(["pending"]);
      expect(valueCount).toHaveBeenCalledOnce();
      expect(legacyClients).not.toHaveBeenCalled();
      expect(legacyLogins).not.toHaveBeenCalled();
      expect(legacyValues).not.toHaveBeenCalled();
    } finally {
      await storage.close();
    }
  });

  it("rejects Access principals before page reads", async () => {
    const root = temporaryRoot();
    const storage = await createHostStorage({ type: "sqlite", path: join(root, "host.sqlite3") });
    try {
      const pageRead = vi.spyOn(storage.remoteSecurity, "listClientsPage");
      const operations = createCurrentHostOperations({
        engine,
        activityLog,
        remoteCredentialStore: storage.remoteSecurity,
        version: "test-version",
      });
      const accessPrincipal: CurrentHostPrincipal = { ...principal, role: "access" };

      await expect(
        operations.execute(accessPrincipal, {
          kind: "remote_clients_page",
          limit: 10,
          sort: "asc",
        }),
      ).rejects.toMatchObject({ code: "AUTH_FAILED" });
      expect(pageRead).not.toHaveBeenCalled();
    } finally {
      await storage.close();
    }
  });

  it("fails page operations when authoritative SQL repositories are unavailable", async () => {
    const root = temporaryRoot();
    const legacy = new RemoteServerCredentialStore({ dir: join(root, "remote-security") });
    const operations = createCurrentHostOperations({
      engine,
      activityLog,
      control: { authDir: join(root, "vault") },
      remoteCredentialStore: legacy,
      version: "test-version",
    });

    for (const operation of [
      { kind: "remote_clients_page", limit: 10, sort: "asc" },
      { kind: "remote_login_requests_page", limit: 10, sort: "asc" },
      { kind: "vault_values_page", limit: 10, sort: "asc" },
      { kind: "vault_grants_page", limit: 10, sort: "asc" },
    ] as const) {
      await expect(operations.execute(principal, operation)).rejects.toMatchObject({
        code: "SERVER_UNAVAILABLE",
      });
    }
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "caplets-current-host-pages-"));
  roots.push(root);
  return root;
}
