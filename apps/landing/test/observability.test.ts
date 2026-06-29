// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const posthogCapture = vi.hoisted(() => vi.fn());
const posthogInit = vi.hoisted(() => vi.fn());

vi.mock("posthog-js", () => ({
  default: { capture: posthogCapture, init: posthogInit },
}));

vi.mock("@sentry/browser", () => ({ init: vi.fn() }));

describe("landing observability", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    vi.unstubAllEnvs();
    posthogCapture.mockClear();
    posthogInit.mockClear();
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  it("adds only categorical attribution to copied commands", async () => {
    document.body.innerHTML = `
      <button data-copy-value="pnpm dlx caplets setup" data-copy-label="install command"></button>
      <div data-copy-status></div>
    `;

    await import("../src/scripts/copy");
    document.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "pnpm dlx caplets telemetry attribution landing_install\npnpm dlx caplets setup",
    );
  });

  it("loads without initializing providers when env is absent", async () => {
    await expect(import("../src/scripts/observability")).resolves.toBeDefined();
  });

  it("classifies /caplets links as catalog navigation", async () => {
    vi.stubEnv("PUBLIC_CAPLETS_POSTHOG_TOKEN", "phc_test");
    document.body.innerHTML = `<main><a href="/caplets/osv/">Browse catalog</a></main>`;

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
