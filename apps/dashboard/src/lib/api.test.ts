import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { dashboardApi, setDashboardSession } from "./api";

const LEGACY_TRANSPORT_OPERATIONS = {
  restoreSession: { method: "GET", path: "session", safety: "safe" },
  changeRemoteClientRole: {
    method: "POST",
    path: "access/clients/remote-client-id/role",
    safety: "unsafe",
  },
  updateStoredCaplet: {
    method: "PUT",
    path: "stored-caplets/example",
    safety: "unsafe",
  },
  deleteStoredCaplet: {
    method: "DELETE",
    path: "stored-caplets/example",
    safety: "unsafe",
  },
} as const;

type LegacyTransportOperation =
  (typeof LEGACY_TRANSPORT_OPERATIONS)[keyof typeof LEGACY_TRANSPORT_OPERATIONS];

type FetchMock = Mock<() => Promise<Response>>;

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

function successfulFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
}

function optionsFor(operation: LegacyTransportOperation, options: RequestInit = {}): RequestInit {
  return operation.method === "GET" ? options : { ...options, method: operation.method };
}

function observedRequest(fetchMock: FetchMock, call = 0) {
  const [url, options] = fetchMock.mock.calls[call] as unknown as [string, RequestInit];
  const method = String(options.method ?? "GET").toUpperCase();
  return {
    csrfHeaders: Array.from(new Headers(options.headers).entries()).filter(
      ([name]) => name.toLowerCase() === "x-caplets-csrf",
    ),
    method,
    safety: isSafeMethod(method) ? "safe" : "unsafe",
    signal: options.signal,
    url,
  };
}

function isSafeMethod(method: string) {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

describe("dashboardApi transport contract", () => {
  afterEach(() => {
    setDashboardSession(undefined);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "location");
  });

  it("keeps the replaceable legacy operation table's safe GET free of CSRF ceremony", async () => {
    setDashboardPath("/dashboard");
    setDashboardSession({
      sessionId: "session-id",
      operatorClientId: "operator-id",
      csrfToken: "active-token",
    });
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    const operation = LEGACY_TRANSPORT_OPERATIONS.restoreSession;

    await dashboardApi(operation.path, optionsFor(operation));

    expect(observedRequest(fetchMock)).toMatchObject({
      method: operation.method,
      safety: operation.safety,
      csrfHeaders: [],
      url: `/dashboard/api/${operation.path}`,
    });
  });

  it.each(
    Object.entries(LEGACY_TRANSPORT_OPERATIONS).filter(
      ([, operation]) => operation.safety === "unsafe",
    ),
  )("%s sends the active CSRF token once for its unsafe method", async (_name, operation) => {
    setDashboardPath("/dashboard");
    setDashboardSession({
      sessionId: "session-id",
      operatorClientId: "operator-id",
      csrfToken: "active-token",
    });
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    await dashboardApi(operation.path, optionsFor(operation));

    expect(observedRequest(fetchMock)).toMatchObject({
      method: operation.method,
      safety: operation.safety,
      csrfHeaders: [["x-caplets-csrf", "active-token"]],
      url: `/dashboard/api/${operation.path}`,
    });
  });

  it("uses a replacement session token for subsequent unsafe requests", async () => {
    setDashboardPath("/dashboard");
    const operation = LEGACY_TRANSPORT_OPERATIONS.changeRemoteClientRole;
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    setDashboardSession({
      sessionId: "old-session",
      operatorClientId: "operator-id",
      csrfToken: "old-token",
    });
    await dashboardApi(operation.path, optionsFor(operation));

    setDashboardSession({
      sessionId: "new-session",
      operatorClientId: "operator-id",
      csrfToken: "new-token",
    });
    await dashboardApi(operation.path, optionsFor(operation));

    expect(observedRequest(fetchMock, 0).csrfHeaders).toEqual([["x-caplets-csrf", "old-token"]]);
    expect(observedRequest(fetchMock, 1).csrfHeaders).toEqual([["x-caplets-csrf", "new-token"]]);
  });

  it("does not reuse a stale CSRF token after the session is cleared", async () => {
    setDashboardPath("/dashboard");
    setDashboardSession({
      sessionId: "ended-session",
      operatorClientId: "operator-id",
      csrfToken: "stale-token",
    });
    setDashboardSession(undefined);
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    const operation = LEGACY_TRANSPORT_OPERATIONS.deleteStoredCaplet;

    await dashboardApi(operation.path, optionsFor(operation));

    expect(observedRequest(fetchMock)).toMatchObject({
      method: operation.method,
      safety: operation.safety,
      csrfHeaders: [],
      url: `/dashboard/api/${operation.path}`,
    });
  });

  it("derives credentialed API URLs from the mounted dashboard base path", async () => {
    setDashboardPath("/tenant/tools/dashboard/access");
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    await dashboardApi(LEGACY_TRANSPORT_OPERATIONS.restoreSession.path);

    expect(fetchMock).toHaveBeenCalledWith(
      "/tenant/tools/dashboard/api/session",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("trusts an explicit dashboard base path without requiring a dashboard segment", async () => {
    setDashboardPath("/tenant/admin/access");
    setDashboardBaseMeta("/tenant/admin/");
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    await dashboardApi(`/${LEGACY_TRANSPORT_OPERATIONS.restoreSession.path}/`);

    expect(fetchMock).toHaveBeenCalledWith(
      "/tenant/admin/api/session",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("supports a credentialed site-root dashboard mount", async () => {
    setDashboardPath("/access");
    setDashboardBaseMeta("/");
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    await dashboardApi(LEGACY_TRANSPORT_OPERATIONS.restoreSession.path);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/session",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("forwards aborts to Fetch", async () => {
    setDashboardPath("/dashboard");
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, options?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = dashboardApi(LEGACY_TRANSPORT_OPERATIONS.restoreSession.path, {
      signal: controller.signal,
    });
    controller.abort();

    await expect(request).rejects.toBe(controller.signal.reason);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
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

    await expect(
      dashboardApi(LEGACY_TRANSPORT_OPERATIONS.restoreSession.path),
    ).rejects.toMatchObject({
      name: "DashboardApiError",
      status: 400,
      message: "Nested failure",
    });
  });
});
