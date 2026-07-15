import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeRecoveredDashboardManagementOperations,
  dashboardApi,
  dashboardManagementMutation,
  pendingManagementOperations,
  recoverDashboardManagementOperations,
  setDashboardSession,
} from "./api";

function setDashboardPath(pathname: string) {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { pathname },
  });
}

function setDashboardBaseMeta(content: string) {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      querySelector: (selector: string) =>
        selector === 'meta[name="caplets-dashboard-base-path"]' ? { content } : null,
    },
  });
}

describe("dashboardApi", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "location");
    vi.unstubAllGlobals();
    setDashboardSession(undefined);
  });

  it("derives API URLs from the mounted dashboard base path", async () => {
    setDashboardPath("/tenant/tools/dashboard/access");
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await dashboardApi("session");

    expect(fetchMock).toHaveBeenCalledWith(
      "/tenant/tools/dashboard/api/session",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("trusts an explicit dashboard base path without requiring a dashboard segment", async () => {
    setDashboardPath("/tenant/admin/access");
    setDashboardBaseMeta("/tenant/admin/");
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await dashboardApi("/session/");

    expect(fetchMock).toHaveBeenCalledWith(
      "/tenant/admin/api/session",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("supports an explicit site-root dashboard mount", async () => {
    setDashboardPath("/access");
    setDashboardBaseMeta("/");
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await dashboardApi("session");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("surfaces nested structured error messages", async () => {
    setDashboardPath("/dashboard");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "NOPE", message: "Nested failure" } }), {
            status: 400,
            statusText: "Bad Request",
          }),
      ),
    );

    await expect(dashboardApi("session")).rejects.toMatchObject({
      name: "DashboardApiError",
      status: 400,
      message: "Nested failure",
    });
  });

  it("recovers a dropped mutation response by lookup without persisting the mutation value", async () => {
    setDashboardPath("/dashboard");
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    setDashboardSession({
      sessionId: "session-u9",
      operatorClientId: "operator-u9",
      csrfToken: "csrf-u9",
    });
    const binding = {
      operationId: "operation-dashboard-drop-u9",
      target: "global" as const,
      logicalHostId: "host-dashboard-u9",
      storeId: "store-dashboard-u9",
      operationNamespace: "namespace-dashboard-u9",
      actorId: "operator-u9",
      requestIdentity: "f".repeat(64),
      operationClass: "logical-state" as const,
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          status: "preview",
          binding,
          authorityToken: { authorityGeneration: 4, effectiveGeneration: 7 },
        }),
      )
      .mockRejectedValueOnce(new TypeError("response dropped"))
      .mockResolvedValueOnce(
        Response.json({
          status: "committed",
          receipt: { status: "committed", binding, aggregateVersion: 2 },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const operation = {
      operationId: "operation-dashboard-drop-u9",
      requestIdentity: "request-dashboard-drop-u9",
      mutation: {
        kind: "host-setting-set" as const,
        key: "telemetry",
        value: "cap_remote_access_must_not_persist",
        selector: "underlying-sql" as const,
      },
    };

    await expect(dashboardManagementMutation(operation.mutation, operation)).resolves.toMatchObject(
      {
        status: "unknown",
        retryAllowed: false,
        guidance: "lookup-original-target",
        operation: {
          operationId: operation.operationId,
          target: {
            resource: "host-setting",
            id: "telemetry",
            selector: "underlying-sql",
          },
        },
      },
    );
    const persisted = storage.values().join("");
    expect(persisted).not.toContain("cap_remote_access_must_not_persist");
    expect(persisted).not.toContain('"mutation"');
    expect(pendingManagementOperations()).toHaveLength(1);

    await expect(recoverDashboardManagementOperations()).resolves.toEqual([
      expect.objectContaining({ status: "committed" }),
    ]);
    expect(pendingManagementOperations()).toEqual([]);
    await expect(recoverDashboardManagementOperations()).resolves.toEqual([
      expect.objectContaining({ status: "committed" }),
    ]);
    acknowledgeRecoveredDashboardManagementOperations();
    await expect(recoverDashboardManagementOperations()).resolves.toEqual([]);
    const lookupInit = fetchMock.mock.calls[2]?.[1];
    expect(JSON.parse(String(lookupInit?.body))).toEqual({ binding });
  });

  it("retains target-bound recovery state for an ambiguous 5xx mutation response", async () => {
    setDashboardPath("/dashboard");
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    setDashboardSession({
      sessionId: "session-u9",
      operatorClientId: "operator-u9",
      csrfToken: "csrf-u9",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        Response.json(
          { error: { code: "SERVER_UNAVAILABLE", message: "Gateway timeout" } },
          {
            status: 504,
          },
        ),
      ),
    );
    const binding = {
      operationId: "operation-dashboard-504-u9",
      target: "global" as const,
      logicalHostId: "host-dashboard-u9",
      storeId: "store-dashboard-u9",
      operationNamespace: "namespace-dashboard-u9",
      actorId: "operator-u9",
      requestIdentity: "request-dashboard-504-u9",
      operationClass: "logical-state" as const,
    };
    const operation = {
      operationId: binding.operationId,
      requestIdentity: binding.requestIdentity,
      binding,
      mutation: {
        kind: "host-setting-set" as const,
        key: "telemetry",
        value: false,
        selector: "underlying-sql" as const,
      },
    };

    await expect(dashboardManagementMutation(operation.mutation, operation)).resolves.toMatchObject(
      {
        status: "unknown",
        operation: { binding },
        retryAllowed: false,
      },
    );
    expect(pendingManagementOperations()).toEqual([
      expect.objectContaining({ binding, operationId: binding.operationId }),
    ]);
  });
});

function memoryStorage(): Storage & { values(): string[] } {
  const valuesByKey = new Map<string, string>();
  return {
    get length() {
      return valuesByKey.size;
    },
    clear() {
      valuesByKey.clear();
    },
    getItem(key) {
      return valuesByKey.get(key) ?? null;
    },
    key(index) {
      return [...valuesByKey.keys()][index] ?? null;
    },
    removeItem(key) {
      valuesByKey.delete(key);
    },
    setItem(key, value) {
      valuesByKey.set(key, value);
    },
    values() {
      return [...valuesByKey.values()];
    },
  };
}
