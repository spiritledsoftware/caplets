import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeRecoveredDashboardManagementOperations,
  dashboardApi,
  dashboardManagementMutation,
  dashboardStorageHealth,
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

  it("reads redacted health from the availability-independent service route", async () => {
    setDashboardPath("/tenant/tools/dashboard/runtime");
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          backend: "postgres",
          authorityToken: { authorityGeneration: 3, effectiveGeneration: 5 },
          readiness: "stale-read-only",
          connectivity: "unavailable",
          migration: "current",
          bootstrapCompatibility: "current",
          convergence: "overdue",
          staleAgeMs: 1_000,
          guidanceCode: "storage-unavailable",
        },
        { status: 503 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(dashboardStorageHealth()).resolves.toMatchObject({
      backend: "postgres",
      readiness: "stale-read-only",
      connectivity: "unavailable",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/tenant/tools/v1/healthz",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("accepts ready authority during a staged bootstrap with pending convergence", async () => {
    setDashboardPath("/dashboard/runtime");
    const health = {
      backend: "postgres",
      authorityToken: { authorityGeneration: 9, effectiveGeneration: 15 },
      readiness: "ready",
      connectivity: "connected",
      migration: "current",
      bootstrapCompatibility: "staged",
      convergence: "pending",
      guidanceCode: "convergence-pending",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(health)),
    );

    await expect(dashboardStorageHealth()).resolves.toEqual(health);
  });

  it.each([
    ["an unrecognized JSON body", () => Response.json({ status: "unavailable" }, { status: 503 })],
    ["an empty body", () => new Response(null, { status: 503 })],
    ["a non-JSON body", () => new Response("upstream unavailable", { status: 503 })],
    ["a malformed success body", () => Response.json({ status: "ok" }, { status: 200 })],
  ])("fails closed for %s from the health route", async (_description, response) => {
    setDashboardPath("/dashboard");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response()),
    );

    await expect(dashboardStorageHealth()).resolves.toMatchObject({
      readiness: "not-ready",
      connectivity: "unavailable",
      guidanceCode: "storage-unavailable",
    });
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

  it("preserves typed 403, 409, and 503 lookup bodies as original-target outcomes", async () => {
    setDashboardPath("/dashboard");
    const storage = memoryStorage();
    vi.stubGlobal("localStorage", storage);
    setDashboardSession({
      sessionId: "session-u10",
      operatorClientId: "operator-u10",
      csrfToken: "csrf-u10",
    });
    const operations = [
      {
        operationId: "operation-dashboard-403-u10",
        requestIdentity: "request-dashboard-403-u10",
        binding: {
          operationId: "operation-dashboard-403-u10",
          target: "global" as const,
          logicalHostId: "host-dashboard-u10",
          storeId: "store-dashboard-u10",
          operationNamespace: "namespace-dashboard-u10",
          actorId: "operator-u10",
          requestIdentity: "request-dashboard-403-u10",
          operationClass: "logical-state" as const,
        },
        mutation: {
          kind: "host-setting-set" as const,
          key: "telemetry",
          value: false,
          selector: "underlying-sql" as const,
        },
      },
      {
        operationId: "operation-dashboard-409-u10",
        requestIdentity: "request-dashboard-409-u10",
        binding: {
          operationId: "operation-dashboard-409-u10",
          target: "global" as const,
          logicalHostId: "host-dashboard-u10",
          storeId: "store-dashboard-u10",
          operationNamespace: "namespace-dashboard-u10",
          actorId: "operator-u10",
          requestIdentity: "request-dashboard-409-u10",
          operationClass: "logical-state" as const,
        },
        mutation: {
          kind: "host-setting-set" as const,
          key: "telemetry",
          value: false,
          selector: "underlying-sql" as const,
        },
      },
      {
        operationId: "operation-dashboard-503-u10",
        requestIdentity: "request-dashboard-503-u10",
        binding: {
          operationId: "operation-dashboard-503-u10",
          target: "global" as const,
          logicalHostId: "host-dashboard-u10",
          storeId: "store-dashboard-u10",
          operationNamespace: "namespace-dashboard-u10",
          actorId: "operator-u10",
          requestIdentity: "request-dashboard-503-u10",
          operationClass: "logical-state" as const,
        },
        mutation: {
          kind: "host-setting-set" as const,
          key: "telemetry",
          value: false,
          selector: "underlying-sql" as const,
        },
      },
    ];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("response dropped"))
      .mockRejectedValueOnce(new TypeError("response dropped"))
      .mockRejectedValueOnce(new TypeError("response dropped"))
      .mockResolvedValueOnce(
        Response.json(
          { status: "wrong_target", message: "Original target denied the lookup." },
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { status: "stale_namespace", message: "Original namespace is stale." },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { status: "unavailable", message: "Original target is unavailable." },
          { status: 503 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    for (const operation of operations) {
      await dashboardManagementMutation(operation.mutation, operation);
    }

    await expect(recoverDashboardManagementOperations()).resolves.toEqual([
      expect.objectContaining({
        status: "wrong_target",
        message: "Original target denied the lookup.",
        httpStatus: 403,
        retryAllowed: false,
        guidance: "lookup-original-target",
        operation: expect.objectContaining({
          operationId: "operation-dashboard-403-u10",
          target: expect.objectContaining({ id: "telemetry" }),
        }),
      }),
      expect.objectContaining({
        status: "stale_namespace",
        message: "Original namespace is stale.",
        httpStatus: 409,
        retryAllowed: false,
        guidance: "lookup-original-target",
        operation: expect.objectContaining({
          operationId: "operation-dashboard-409-u10",
          target: expect.objectContaining({ id: "telemetry" }),
        }),
      }),
      expect.objectContaining({
        status: "unavailable",
        message: "Original target is unavailable.",
        httpStatus: 503,
        retryAllowed: false,
        guidance: "lookup-original-target",
        operation: expect.objectContaining({
          operationId: "operation-dashboard-503-u10",
          target: expect.objectContaining({ id: "telemetry" }),
        }),
      }),
    ]);
    expect(pendingManagementOperations()).toHaveLength(3);
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
