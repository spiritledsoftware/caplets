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
    window.history.pushState({}, "", "/");
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

  it("can copy raw prompt text without command attribution", async () => {
    document.body.innerHTML = `
      <button data-copy-value="Read this setup skill" data-copy-label="setup prompt" data-copy-attribution="false"></button>
      <div data-copy-status></div>
    `;

    await import("../src/scripts/copy");
    document.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("Read this setup skill");
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

  it("keeps the source route family when navigating from home to blog", async () => {
    vi.stubEnv("PUBLIC_CAPLETS_POSTHOG_TOKEN", "phc_test");
    document.body.innerHTML = `<main><a href="/blog/why-giant-mcp-tool-walls-dont-scale/">Read blog</a></main>`;

    await import("../src/scripts/observability");
    posthogCapture.mockClear();
    document.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(posthogCapture).toHaveBeenCalledWith(
      "caplets_site_intent",
      expect.objectContaining({
        route_family: "home",
        page_family: "home",
        navigation_path_category: "blog",
        outbound_action_category: "blog",
        cta_category: "blog",
      }),
    );
  });
});
