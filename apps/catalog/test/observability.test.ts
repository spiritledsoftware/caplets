// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("catalog observability", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("adds categorical attribution to copied catalog install commands", async () => {
    document.body.innerHTML = `
      <button data-copy-command="caplets add npm"></button>
      <div data-copy-status></div>
    `;

    await import("../src/scripts/copy");
    document.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "CAPLETS_INSTALL_ATTRIBUTION=catalog_install caplets add npm",
    );
  });

  it("loads browser observability without provider env", async () => {
    await expect(import("../src/scripts/observability")).resolves.toBeDefined();
  });

  it("sends catalog worker errors as sanitized Sentry envelopes", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000001" });
    const { captureCatalogServerError } = await import("../src/lib/server-observability");

    await captureCatalogServerError(new Error("raw /home/alex/secret"), {
      CAPLETS_CATALOG_SENTRY_DSN: "https://public@example.ingest.sentry.io/123",
      PUBLIC_CAPLETS_ENVIRONMENT: "production",
      PUBLIC_CAPLETS_RELEASE: "sites@test",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://example.ingest.sentry.io/api/123/envelope/",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/x-sentry-envelope" },
      }),
    );
    const body = String(fetch.mock.calls[0]?.[1]?.body);
    expect(body).toContain('"surface":"catalog"');
    expect(body).toContain('"release":"sites@test"');
    expect(body).not.toContain("raw /home/alex/secret");
  });
});
