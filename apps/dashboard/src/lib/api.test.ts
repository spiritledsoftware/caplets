import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  DashboardApiError,
  adminV2CreateCapletRecordFromDocument,
  adminV2DeleteCapletRecordRevision,
  adminV2GetCapletRecordRevision,
  adminV2CreateRuntimeRestart,
  adminV2GetHost,
  adminV2ListCatalogEntries,
  adminV2GetRemoteClient,
  adminV2UpdateRemoteClient,
  createDashboardMutationIntent,
  revealVaultValue,
  completeDashboardLogin,
  logoutDashboardSession,
  pollDashboardLogin,
  restoreDashboardSession,
  startDashboardLogin,
  setDashboardSession,
} from "./api";

type FetchMock = Mock;

function setDashboardPath(pathname: string, origin = "https://current-host.example") {
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin, pathname },
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

function successfulFetch(body: unknown = { id: "host" }) {
  return vi.fn(async () => jsonResponse(body));
}

function observedRequest(fetchMock: FetchMock, call = 0) {
  const [input, init] = fetchMock.mock.calls[call] ?? [];
  if (!input) throw new Error(`Expected Fetch call ${call}.`);
  const request =
    input instanceof Request
      ? input
      : new Request(new URL(String(input), "http://test.invalid"), init);
  const headers = Array.from(request.headers.entries());
  return {
    cache: request.cache,
    credentials: request.credentials,
    csrfHeaders: headers.filter(([name]) => name.toLowerCase() === "x-caplets-csrf"),
    idempotencyHeaders: headers.filter(([name]) => name.toLowerCase() === "idempotency-key"),
    ifNoneMatchHeaders: headers.filter(([name]) => name.toLowerCase() === "if-none-match"),
    ifMatchHeaders: headers.filter(([name]) => name.toLowerCase() === "if-match"),
    parentIfMatchHeaders: headers.filter(
      ([name]) => name.toLowerCase() === "x-caplets-parent-if-match",
    ),
    method: request.method,
    url: request.url,
    pathname: new URL(request.url).pathname,
    search: new URL(request.url).search,
    signal: request.signal,
  };
}

const session = {
  sessionId: "session-id",
  operatorClientId: "operator-id",
  csrfToken: "active-token",
};

describe("generated dashboard Caplets SDK adapter", () => {
  afterEach(() => {
    setDashboardSession(undefined);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "location");
  });

  it("calls the canonical Admin namespace with cookies and no GET CSRF", async () => {
    setDashboardPath("/tenant/tools/dashboard/access");
    setDashboardSession(session);
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    await adminV2GetHost();

    expect(observedRequest(fetchMock)).toMatchObject({
      credentials: "same-origin",
      csrfHeaders: [],
      method: "GET",
      pathname: "/api/v2/admin/host",
    });
  });

  it("sends generated Admin requests to the Current Host origin with same-origin credentials", async () => {
    setDashboardPath("/dashboard/access", "https://current-host.example:9443");
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    await adminV2GetHost();

    expect(observedRequest(fetchMock)).toMatchObject({
      credentials: "same-origin",
      url: "https://current-host.example:9443/api/v2/admin/host",
    });
  });

  it("sends collection cursors with the stable catalog filters", async () => {
    setDashboardPath("/dashboard/catalog");
    const fetchMock = successfulFetch({ items: [] });
    vi.stubGlobal("fetch", fetchMock);

    await adminV2ListCatalogEntries({ cursor: "next-page" });

    expect(Object.fromEntries(new URLSearchParams(observedRequest(fetchMock).search))).toEqual({
      cursor: "next-page",
      limit: "500",
      sort: "desc",
      source: "official",
    });
  });

  it("never infers an Admin prefix from the dashboard pathname", async () => {
    setDashboardPath("/removed-prefix/dashboard/access");
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    await adminV2GetHost();

    expect(observedRequest(fetchMock).pathname).toBe("/api/v2/admin/host");
  });

  it("reads the current session token once for unsafe generated methods", async () => {
    setDashboardPath("/dashboard");
    const fetchMock = successfulFetch({ id: "restart" });
    vi.stubGlobal("fetch", fetchMock);
    setDashboardSession({ ...session, csrfToken: "old-token" });
    await adminV2CreateRuntimeRestart(createDashboardMutationIntent());
    setDashboardSession({ ...session, sessionId: "replacement", csrfToken: "new-token" });
    await adminV2CreateRuntimeRestart(createDashboardMutationIntent());
    setDashboardSession(undefined);
    await adminV2CreateRuntimeRestart(createDashboardMutationIntent());

    expect(observedRequest(fetchMock, 0).csrfHeaders).toEqual([["x-caplets-csrf", "old-token"]]);
    expect(observedRequest(fetchMock, 1).csrfHeaders).toEqual([["x-caplets-csrf", "new-token"]]);
    expect(observedRequest(fetchMock, 2).csrfHeaders).toEqual([]);
  });

  it("keeps one idempotency key for retries of one intent and creates a fresh key for a later intent", async () => {
    setDashboardPath("/dashboard");
    setDashboardSession(session);
    const fetchMock = successfulFetch({ id: "restart" });
    vi.stubGlobal("fetch", fetchMock);
    const firstIntent = createDashboardMutationIntent();

    await adminV2CreateRuntimeRestart(firstIntent);
    await adminV2CreateRuntimeRestart(firstIntent);
    await adminV2CreateRuntimeRestart(createDashboardMutationIntent());

    const first = observedRequest(fetchMock, 0).idempotencyHeaders;
    expect(first).toHaveLength(1);
    expect(observedRequest(fetchMock, 1).idempotencyHeaders).toEqual(first);
    expect(observedRequest(fetchMock, 2).idempotencyHeaders).not.toEqual(first);
  });

  it("creates a document bundle with If-None-Match rather than an invented legacy JSON endpoint", async () => {
    setDashboardPath("/dashboard/stored-caplets");
    setDashboardSession(session);
    let submitted: FormData | undefined;
    const fetchMock = vi.fn(async (request: Request) => {
      submitted = await request.clone().formData();
      return jsonResponse({ id: "alpha" }, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await adminV2CreateCapletRecordFromDocument(
      "alpha",
      "# Alpha\\n",
      createDashboardMutationIntent(),
      5,
    );

    expect(observedRequest(fetchMock)).toMatchObject({
      csrfHeaders: [["x-caplets-csrf", "active-token"]],
      ifNoneMatchHeaders: [["if-none-match", "*"]],
      method: "PUT",
      pathname: "/api/v2/admin/caplet-records/alpha/bundle",
    });
    expect(submitted?.getAll("file")).toHaveLength(1);
    expect(JSON.parse(String(submitted?.get("manifest")))).toMatchObject({
      version: 1,
      historyLimit: 5,
      files: [{ path: "CAPLET.md", size: 9, executable: false }],
    });
  });

  it("captures a detail ETag and submits the caller's current validator", async () => {
    setDashboardPath("/dashboard");
    setDashboardSession(session);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: "client-1" }, { headers: { etag: '"client-v2"' } }))
      .mockResolvedValueOnce(jsonResponse({ id: "client-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const detail = await adminV2GetRemoteClient("client-1");
    await adminV2UpdateRemoteClient(
      "client-1",
      { role: "access" },
      detail.etag,
      createDashboardMutationIntent(),
    );

    expect(detail.etag).toBe('"client-v2"');
    expect(observedRequest(fetchMock, 1).ifMatchHeaders).toEqual([["if-match", '"client-v2"']]);
  });

  it("deletes a revision with both its validator and the current parent validator", async () => {
    setDashboardPath("/dashboard");
    setDashboardSession(session);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ revisionKey: "rev-1" }, { headers: { etag: '"revision-v1"' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ record: null }));
    vi.stubGlobal("fetch", fetchMock);

    const revision = await adminV2GetCapletRecordRevision("record-1", "rev-1");
    await adminV2DeleteCapletRecordRevision(
      "record-1",
      "rev-1",
      revision.etag,
      '"record-v2"',
      createDashboardMutationIntent(),
    );

    expect(observedRequest(fetchMock, 1)).toMatchObject({
      ifMatchHeaders: [["if-match", '"revision-v1"']],
      parentIfMatchHeaders: [["x-caplets-parent-if-match", '"record-v2"']],
      method: "DELETE",
      pathname: "/api/v2/admin/caplet-records/record-1/revisions/rev-1",
    });
  });

  it("translates stale Problem Details without replacing the validator chosen by the caller", async () => {
    setDashboardPath("/dashboard");
    setDashboardSession(session);
    const problem = {
      type: "https://caplets.dev/problems/precondition-failed",
      title: "Precondition Failed",
      status: 412,
      detail: "The remote client changed after it was loaded.",
      code: "ADMIN_ETAG_STALE",
    };
    const fetchMock = vi.fn(async () => jsonResponse(problem, { status: 412 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      adminV2UpdateRemoteClient(
        "client-1",
        { role: "operator" },
        '"client-v1"',
        createDashboardMutationIntent(),
      ),
    ).rejects.toMatchObject({
      name: "DashboardApiError",
      status: 412,
      code: "ADMIN_ETAG_STALE",
      message: problem.detail,
      body: problem,
    });
    expect(observedRequest(fetchMock).ifMatchHeaders).toEqual([["if-match", '"client-v1"']]);
  });

  it("translates unauthorized Problem Details for session invalidation", async () => {
    setDashboardPath("/dashboard");
    const problem = {
      type: "https://caplets.dev/problems/unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Dashboard session expired.",
      code: "DASHBOARD_SESSION_INVALID",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(problem, { status: 401 })),
    );

    await expect(adminV2GetHost()).rejects.toEqual(
      expect.objectContaining<Partial<DashboardApiError>>({
        name: "DashboardApiError",
        status: 401,
        message: "Dashboard session expired.",
      }),
    );
  });

  it("forwards aborts through the generated client", async () => {
    setDashboardPath("/dashboard");
    const controller = new AbortController();
    const fetchMock = vi.fn((request: Request) => {
      return new Promise<Response>((_resolve, reject) => {
        if (request.signal.aborted) {
          reject(request.signal.reason);
          return;
        }
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = adminV2GetHost({ signal: controller.signal });
    controller.abort("cancelled");

    await expect(result).rejects.toMatchObject({
      body: "cancelled",
      message: "cancelled",
      status: 0,
    });
    expect(observedRequest(fetchMock).signal.aborted).toBe(true);
  });
});

describe("private Vault reveal transport", () => {
  afterEach(() => {
    setDashboardSession(undefined);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "location");
  });

  it("stays outside the generated Admin mount and consumes the response with no-store", async () => {
    setDashboardPath("/dashboard/vault");
    setDashboardSession(session);
    const fetchMock = successfulFetch({ value: "secret" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(revealVaultValue("TEST_SECRET", "reveal TEST_SECRET")).resolves.toEqual({
      value: "secret",
    });

    expect(observedRequest(fetchMock)).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      csrfHeaders: [["x-caplets-csrf", "active-token"]],
      method: "POST",
      pathname: "/dashboard/api/private/vault-reveals",
    });
  });
});

describe("handwritten dashboard session ceremony", () => {
  afterEach(() => {
    setDashboardSession(undefined);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "location");
  });

  it("keeps session restore safe and all private ceremonies in the fixed dashboard namespace", async () => {
    setDashboardPath("/tenant/dashboard/access");
    setDashboardSession(session);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ authenticated: true, session }))
      .mockResolvedValueOnce(
        jsonResponse({
          flowId: "flow-1",
          pendingCompletionSecret: "pending-secret",
          intervalSeconds: 5,
          approvalCommand: "caplets remote approve flow-1",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ status: "approved" }))
      .mockResolvedValueOnce(jsonResponse({ session }))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await restoreDashboardSession();
    const pending = await startDashboardLogin("Browser Dashboard");
    await pollDashboardLogin(pending.flowId, pending.pendingCompletionSecret);
    await completeDashboardLogin(pending.flowId, pending.pendingCompletionSecret);
    await logoutDashboardSession();

    expect(observedRequest(fetchMock, 0)).toMatchObject({
      csrfHeaders: [],
      method: "GET",
      pathname: "/dashboard/api/session",
    });
    expect(
      [1, 2, 3, 4].map((call) => ({
        csrf: observedRequest(fetchMock, call).csrfHeaders,
        method: observedRequest(fetchMock, call).method,
        pathname: observedRequest(fetchMock, call).pathname,
      })),
    ).toEqual([
      {
        csrf: [["x-caplets-csrf", "active-token"]],
        method: "POST",
        pathname: "/dashboard/api/login/start",
      },
      {
        csrf: [["x-caplets-csrf", "active-token"]],
        method: "POST",
        pathname: "/dashboard/api/login/poll",
      },
      {
        csrf: [["x-caplets-csrf", "active-token"]],
        method: "POST",
        pathname: "/dashboard/api/login/complete",
      },
      {
        csrf: [["x-caplets-csrf", "active-token"]],
        method: "POST",
        pathname: "/dashboard/api/logout",
      },
    ]);
  });
});
