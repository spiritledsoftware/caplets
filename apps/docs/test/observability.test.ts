// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const posthogCapture = vi.hoisted(() => vi.fn());
const posthogInit = vi.hoisted(() => vi.fn());

vi.mock("posthog-js", () => ({
  default: { capture: posthogCapture, init: posthogInit },
}));

vi.mock("@sentry/browser", () => ({ init: vi.fn() }));

describe("docs observability", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    posthogCapture.mockClear();
    posthogInit.mockClear();
    document.body.innerHTML = "";
  });

  it("loads without provider env and handles navigation clicks", async () => {
    document.body.innerHTML = `<a href="/install/">Install</a>`;
    const addEventListener = vi.spyOn(document, "addEventListener");

    await expect(import("../src/scripts/observability")).resolves.toBeDefined();
    document.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(addEventListener).toHaveBeenCalledWith("click", expect.any(Function));
  });

  it("classifies root-relative catalog links as catalog intent", async () => {
    vi.stubEnv("PUBLIC_CAPLETS_POSTHOG_TOKEN", "phc_test");
    document.body.innerHTML = `<a href="/caplets/osv/">Open catalog</a>`;

    await import("../src/scripts/observability");
    posthogCapture.mockClear();
    document.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(posthogCapture).toHaveBeenCalledWith(
      "caplets_site_intent",
      expect.objectContaining({
        navigation_path_category: "catalog",
        outbound_action_category: "catalog",
      }),
    );
  });
});
