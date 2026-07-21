import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCurrentHostOperations,
  type CurrentHostOperationsDependencies,
  type CurrentHostOperation,
  type CurrentHostPrincipal,
  type CurrentHostProjectBindingSnapshot,
  type CurrentHostRuntimeSnapshot,
} from "../src/current-host/operations";
import { createHostStorage } from "../src/storage";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const principal = {
  clientId: "rcli_abcdefghijklmnop",
  hostUrl: "https://caplets.example.com/",
  role: "operator" as const,
};

const engine: CurrentHostOperationsDependencies["engine"] = {
  enabledServers: () => [],
};

describe("Current Host canonical resource operations", () => {
  it("uses stable Operator Activity keys instead of the legacy cursor API", async () => {
    const page = {
      items: [
        {
          id: "activity-1",
          createdAt: "2026-07-20T00:00:00.000Z",
          actorClientId: principal.clientId,
          action: "caplet.rename",
          outcome: "success" as const,
          target: { type: "caplet_record", id: "record-1" },
        },
      ],
      nextKey: { createdAt: "2026-07-20T00:00:00.000Z", activityKey: "activity-1" },
    };
    const listPage = vi.fn().mockResolvedValue(page);
    const legacyList = vi.fn();
    const operations = createCurrentHostOperations({
      engine,
      activityLog: { append: vi.fn(), list: legacyList, listPage },
      version: "test-version",
    });

    await expect(
      operations.execute(principal, {
        kind: "activity_page",
        limit: 25,
        sort: "asc",
        after: page.nextKey,
        action: "caplet.rename",
      }),
    ).resolves.toEqual({ kind: "activity_page", page });
    expect(listPage).toHaveBeenCalledWith({
      limit: 25,
      sort: "asc",
      after: page.nextKey,
      action: "caplet.rename",
    });
    expect(legacyList).not.toHaveBeenCalled();
  });

  it("returns remote details and authoritative replacement generations for guarded mutations", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-current-host-remote-resources-"));
    roots.push(root);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(root, "host.sqlite3"),
    });
    try {
      const pairing = await storage.remoteSecurity.createPairingCode({
        hostUrl: principal.hostUrl,
        clientLabel: "Remote client",
      });
      const client = await storage.remoteSecurity.exchangePairingCode({
        hostUrl: principal.hostUrl,
        code: pairing.code,
        clientLabel: "Remote client",
      });
      const approvedFlow = await storage.remoteSecurity.createPendingLogin({
        hostUrl: principal.hostUrl,
        requestedRole: "access",
        clientLabel: "Approved request",
      });
      const deniedFlow = await storage.remoteSecurity.createPendingLogin({
        hostUrl: principal.hostUrl,
        requestedRole: "access",
        clientLabel: "Denied request",
      });
      const operations = createCurrentHostOperations({
        engine,
        activityLog: storage.operatorActivity,
        remoteCredentialStore: storage.remoteSecurity,
        version: "test-version",
      });
      const listClients = vi
        .spyOn(storage.remoteSecurity, "listClients")
        .mockRejectedValue(new Error("canonical single-client lookup must not list"));
      const listPendingLogins = vi
        .spyOn(storage.remoteSecurity, "listPendingLogins")
        .mockRejectedValue(new Error("canonical single-login lookup must not list"));

      await expect(
        operations.execute(principal, { kind: "remote_client_get", clientId: client.clientId }),
      ).resolves.toMatchObject({
        kind: "remote_client_get",
        status: "found",
        client: { clientId: client.clientId, generation: 1 },
      });
      await expect(
        operations.execute(principal, {
          kind: "remote_login_request_get",
          flowId: approvedFlow.flowId,
        }),
      ).resolves.toMatchObject({
        kind: "remote_login_request_get",
        status: "found",
        pendingLogin: { flowId: approvedFlow.flowId, generation: 1 },
      });

      const changed = await operations.execute(principal, {
        kind: "client_change_role",
        clientId: client.clientId,
        role: "operator",
        expectedGeneration: 1,
      });
      expect(changed).toMatchObject({
        kind: "client_change_role",
        status: "changed",
        client: { role: "operator", generation: 2 },
      });
      await expect(
        operations.execute(principal, {
          kind: "client_change_role",
          clientId: client.clientId,
          role: "access",
          expectedGeneration: 1,
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID", details: { kind: "stale_generation" } });
      await expect(
        operations.execute(principal, {
          kind: "client_revoke",
          clientId: client.clientId,
          expectedGeneration: 2,
        }),
      ).resolves.toMatchObject({
        kind: "client_revoke",
        status: "revoked",
        client: { clientId: client.clientId, generation: 3 },
      });
      await expect(
        operations.execute(principal, {
          kind: "pending_login_approve",
          flowId: approvedFlow.flowId,
          expectedGeneration: 1,
        }),
      ).resolves.toMatchObject({
        kind: "pending_login_approve",
        pendingLogin: { status: "approved", generation: 2 },
      });
      await expect(
        operations.execute(principal, {
          kind: "pending_login_deny",
          flowId: deniedFlow.flowId,
          expectedGeneration: 1,
        }),
      ).resolves.toMatchObject({
        kind: "pending_login_deny",
        pendingLogin: { status: "denied", generation: 2 },
      });
      await expect(
        operations.execute(principal, {
          kind: "remote_client_get",
          clientId: "rcli_0000000000000000",
        }),
      ).resolves.toEqual({
        kind: "remote_client_get",
        status: "not_found",
        clientId: "rcli_0000000000000000",
      });
      await expect(
        operations.execute(principal, {
          kind: "remote_login_request_get",
          flowId: "rlogin_0000000000000000",
        }),
      ).resolves.toEqual({
        kind: "remote_login_request_get",
        status: "not_found",
        flowId: "rlogin_0000000000000000",
      });
      expect(listClients).not.toHaveBeenCalled();
      expect(listPendingLogins).not.toHaveBeenCalled();
      const mutationActivity = (
        await storage.operatorActivity.listPage({ limit: 10 })
      ).items.filter((entry) =>
        [
          "remote_client_role_changed",
          "remote_client_revoked",
          "remote_pending_login_approved",
          "remote_pending_login_denied",
        ].includes(entry.action),
      );
      expect(mutationActivity).toHaveLength(4);
    } finally {
      await storage.close();
    }
  });

  it("fails canonical dependencies closed and rejects Access before any resource read", async () => {
    const listPage = vi.fn();
    const operations = createCurrentHostOperations({
      engine,
      activityLog: {
        append: vi.fn(),
        list: vi.fn().mockReturnValue({ entries: [] }),
        listPage,
      },
      version: "test-version",
    });
    const dependencyOperations: CurrentHostOperation[] = [
      { kind: "remote_client_get", clientId: "rcli_0000000000000000" },
      { kind: "remote_login_request_get", flowId: "rlogin_0000000000000000" },
      { kind: "stored_caplets_page", limit: 10, sort: "asc" },
      { kind: "stored_caplet_bundle_get", id: "missing" },
      { kind: "stored_caplet_installations_page", id: "missing", limit: 10, sort: "asc" },
      { kind: "stored_caplet_installation_status", id: "missing" },
    ];
    for (const operation of dependencyOperations) {
      await expect(operations.execute(principal, operation)).rejects.toMatchObject({
        code: "SERVER_UNAVAILABLE",
      });
    }

    const access: CurrentHostPrincipal = { ...principal, role: "access" };
    const accessOperations: CurrentHostOperation[] = [
      { kind: "activity_page", limit: 10, sort: "asc" },
      { kind: "catalog_entries_page", source: "official", limit: 10, sort: "asc" },
      ...dependencyOperations,
    ];
    for (const operation of accessOperations) {
      await expect(operations.execute(access, operation)).rejects.toMatchObject({
        code: "AUTH_FAILED",
      });
    }
    expect(listPage).not.toHaveBeenCalled();
  });

  it("projects supplied runtime, log, and Project Binding owner state", async () => {
    const logPage = {
      items: [
        {
          timestamp: "2026-07-20T12:00:00.000Z",
          level: "error" as const,
          message: "Runtime storage probe failed.",
          source: "runtime",
        },
      ],
      nextKey: {
        timestamp: "2026-07-20T12:00:00.000Z",
        logKey: "runtime-1",
      },
    };
    const runtimeState = {
      read: vi.fn().mockResolvedValue({ status: "error", reason: "database_unavailable" }),
    };
    const logState = {
      listPage: vi.fn().mockResolvedValue(logPage),
    };
    const projectBindingState = {
      read: vi.fn().mockResolvedValue({
        state: "connected",
        affectedCaplets: ["workspace"],
        actions: [],
      }),
    };
    const operations = createCurrentHostOperations({
      engine,
      activityLog: { append: vi.fn(), list: vi.fn().mockReturnValue({ entries: [] }) },
      runtimeState,
      logState,
      projectBindingState,
      version: "test-version",
    });

    await expect(
      operations.execute(principal, {
        kind: "logs",
        sort: "desc",
        limit: 25,
        after: logPage.nextKey,
      }),
    ).resolves.toEqual({ kind: "logs", page: logPage });
    expect(logState.listPage).toHaveBeenCalledWith({
      sort: "desc",
      limit: 25,
      after: logPage.nextKey,
    });
    await expect(
      operations.execute(principal, {
        kind: "runtime",
        baseUrl: "https://caplets.example.com/",
        bind: "127.0.0.1:3000",
      }),
    ).resolves.toMatchObject({
      runtime: { status: "error", reason: "database_unavailable" },
    });
    await expect(operations.execute(principal, { kind: "diagnostics" })).resolves.toEqual({
      kind: "diagnostics",
      status: "error",
      diagnostics: [{ id: "runtime", status: "error", detail: "database_unavailable" }],
      checks: [{ id: "runtime", status: "error", detail: "database_unavailable" }],
    });
    await expect(operations.execute(principal, { kind: "runtime_event" })).resolves.toEqual({
      kind: "runtime_event",
      event: {
        type: "runtime_health",
        runtime: {
          status: "error",
          version: "test-version",
          reason: "database_unavailable",
        },
        projectBinding: { state: "connected" },
      },
    });
    await expect(operations.execute(principal, { kind: "project_binding" })).resolves.toEqual({
      kind: "project_binding",
      projectBinding: {
        state: "connected",
        affectedCaplets: ["workspace"],
        actions: [],
      },
    });
    await expect(
      operations.execute(principal, {
        kind: "summary",
        baseUrl: "https://caplets.example.com/",
        dashboardUrl: "https://caplets.example.com/dashboard",
        dashboardPath: "/dashboard",
      }),
    ).resolves.toMatchObject({
      summary: {
        sections: {
          runtime: { status: "error" },
          projectBinding: { state: "connected" },
        },
      },
    });
  });

  it("fails unavailable Host state owners closed instead of fabricating healthy state", async () => {
    const operations = createCurrentHostOperations({
      engine,
      activityLog: { append: vi.fn(), list: vi.fn().mockReturnValue({ entries: [] }) },
      version: "test-version",
    });

    for (const operation of [
      { kind: "logs", sort: "asc" },
      {
        kind: "runtime",
        baseUrl: "https://caplets.example.com/",
        bind: "127.0.0.1:3000",
      },
      {
        kind: "summary",
        baseUrl: "https://caplets.example.com/",
        dashboardUrl: "https://caplets.example.com/dashboard",
        dashboardPath: "/dashboard",
      },
      { kind: "diagnostics" },
      { kind: "runtime_event" },
      { kind: "project_binding" },
    ] satisfies CurrentHostOperation[]) {
      await expect(operations.execute(principal, operation)).rejects.toMatchObject({
        code: "SERVER_UNAVAILABLE",
      });
    }
  });

  it("returns independent runtime event snapshots for SSE adapters", async () => {
    const operations = createCurrentHostOperations({
      engine,
      activityLog: { append: vi.fn(), list: vi.fn().mockReturnValue({ entries: [] }) },
      runtimeState: { read: () => ({ status: "ok" }) },
      projectBindingState: {
        read: () => ({ state: "disconnected", affectedCaplets: [], actions: [] }),
      },
      version: "test-version",
    });
    const first = await operations.execute(principal, { kind: "runtime_event" });
    const second = await operations.execute(principal, { kind: "runtime_event" });

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.event).not.toBe(second.event);
  });
  it("coalesces authoritative Host changes and releases subscriptions on cancel and close", async () => {
    let runtimeSnapshot: CurrentHostRuntimeSnapshot = { status: "ok" };
    let projectBindingSnapshot: CurrentHostProjectBindingSnapshot = {
      state: "disconnected",
      affectedCaplets: [],
      actions: [],
    };
    const runtimeListeners = new Set<() => void>();
    const projectBindingListeners = new Set<() => void>();
    const runtimeRead = vi.fn(async () => runtimeSnapshot);
    const projectBindingRead = vi.fn(async () => projectBindingSnapshot);
    const operations = createCurrentHostOperations({
      engine,
      activityLog: { append: vi.fn(), list: vi.fn().mockReturnValue({ entries: [] }) },
      runtimeState: {
        read: runtimeRead,
        subscribe(listener) {
          runtimeListeners.add(listener);
          return () => runtimeListeners.delete(listener);
        },
      },
      projectBindingState: {
        read: projectBindingRead,
        subscribe(listener) {
          projectBindingListeners.add(listener);
          return () => projectBindingListeners.delete(listener);
        },
      },
      version: "test-version",
    });

    const reader = operations.runtimeEvents(principal).getReader();
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: {
        type: "runtime_health",
        runtime: { status: "ok", version: "test-version" },
        projectBinding: { state: "disconnected" },
      },
    });
    expect(runtimeListeners.size).toBe(1);
    expect(projectBindingListeners.size).toBe(1);

    let unchangedSettled = false;
    const nextEvent = reader.read().finally(() => {
      unchangedSettled = true;
    });
    for (const listener of projectBindingListeners) listener();
    await vi.waitFor(() => expect(projectBindingRead).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(unchangedSettled).toBe(false);
    projectBindingSnapshot = {
      state: "connected",
      affectedCaplets: ["workspace"],
      actions: [],
    };
    for (const listener of projectBindingListeners) listener();
    await expect(nextEvent).resolves.toMatchObject({
      done: false,
      value: { projectBinding: { state: "connected" } },
    });

    for (let index = 0; index < 1_000; index += 1) {
      runtimeSnapshot = { status: "error", reason: `change-${index}` };
      for (const listener of runtimeListeners) listener();
    }
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: {
        runtime: { status: "error", reason: "change-0" },
        projectBinding: { state: "connected" },
      },
    });
    await expect(reader.read()).resolves.toMatchObject({
      done: false,
      value: {
        runtime: { status: "error", reason: "change-999" },
        projectBinding: { state: "connected" },
      },
    });
    expect(runtimeRead).toHaveBeenCalledTimes(5);
    expect(projectBindingRead).toHaveBeenCalledTimes(5);

    await reader.cancel("disconnect");
    expect(runtimeListeners.size).toBe(0);
    expect(projectBindingListeners.size).toBe(0);

    const closingReader = operations.runtimeEvents(principal).getReader();
    await closingReader.read();
    operations.close();
    await expect(closingReader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(runtimeListeners.size).toBe(0);
    expect(projectBindingListeners.size).toBe(0);
  });
});
