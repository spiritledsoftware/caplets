import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardApi } from "./api";

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
});
