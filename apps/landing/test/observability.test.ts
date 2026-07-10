// @vitest-environment happy-dom

import type * as WebObservabilityModule from "@caplets/web-observability";
import { beforeEach, describe, expect, it, vi } from "vitest";

const posthogCapture = vi.hoisted(() => vi.fn());
const posthogInit = vi.hoisted(() => vi.fn());
const posthogSanitizer = vi.hoisted(() => vi.fn());

vi.mock("posthog-js", () => ({
  default: { capture: posthogCapture, init: posthogInit },
}));

vi.mock("@sentry/browser", () => ({ init: vi.fn() }));

vi.mock("@caplets/web-observability", async (importOriginal) => {
  const actual = await importOriginal<typeof WebObservabilityModule>();
  return { ...actual, sanitizePostHogCapture: posthogSanitizer };
});

describe("landing observability", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/");
    document.body.innerHTML = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    vi.unstubAllEnvs();
    posthogCapture.mockReset();
    posthogInit.mockReset();
    posthogSanitizer.mockReset();
    const actual = await vi.importActual<typeof WebObservabilityModule>(
      "@caplets/web-observability",
    );
    posthogSanitizer.mockImplementation(actual.sanitizePostHogCapture);
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

  it("does not initialize or capture when the PostHog env is absent", async () => {
    await expect(import("../src/scripts/observability")).resolves.toBeDefined();

    expect(posthogInit).not.toHaveBeenCalled();
    expect(posthogCapture).not.toHaveBeenCalled();
  });

  it("installs privacy options and the shared final hook during initial initialization", async () => {
    vi.stubEnv("PUBLIC_CAPLETS_POSTHOG_TOKEN", "phc_test");

    await import("../src/scripts/observability");

    expect(posthogInit).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({
        api_host: "https://us.i.posthog.com",
        advanced_disable_flags: true,
        autocapture: false,
        capture_pageview: false,
        disable_persistence: true,
        disable_session_recording: true,
        disable_surveys: true,
        disable_web_experiments: true,
        person_profiles: "never",
        persistence: "memory",
        save_campaign_params: false,
        save_referrer: false,
        before_send: expect.any(Function),
      }),
    );
    const options = posthogInit.mock.calls[0]?.[1] as {
      before_send: (payload: unknown) => unknown;
    };

    expect(
      options.before_send({
        uuid: "0189d14f-4f1a-7000-8000-000000000001",
        event: "caplets_site_pageview",
        timestamp: new Date("2026-07-10T12:00:00.000Z"),
        properties: {
          token: "phc_test",
          distinct_id: "anonymous-browser-identity",
          $device_id: "anonymous-browser-identity",
          $is_identified: false,
          surface: "landing",
          route_family: "home",
          page_family: "home",
          referrer_category: "direct",
          $current_url: "https://caplets.dev/?secret=value",
          $set: { email: "person@example.com" },
          unknown_application_property: "not allowed",
        },
        $set: { email: "person@example.com" },
      }),
    ).toEqual({
      uuid: "0189d14f-4f1a-7000-8000-000000000001",
      event: "caplets_site_pageview",
      timestamp: new Date("2026-07-10T12:00:00.000Z"),
      properties: {
        token: "phc_test",
        distinct_id: "anonymous-browser-identity",
        surface: "landing",
        route_family: "home",
        page_family: "home",
        referrer_category: "direct",
        $process_person_profile: false,
        $geoip_disable: true,
      },
    });
  });

  it("leaves analytics disabled while listener registration continues when init throws", async () => {
    vi.stubEnv("PUBLIC_CAPLETS_POSTHOG_TOKEN", "phc_test");
    posthogInit.mockImplementationOnce(() => {
      throw new Error("init failure");
    });
    const addEventListener = vi.spyOn(document, "addEventListener");

    await expect(import("../src/scripts/observability")).resolves.toBeDefined();

    expect(posthogCapture).not.toHaveBeenCalled();
    expect(addEventListener).toHaveBeenCalledWith("click", expect.any(Function));
  });

  it("returns null from the installed hook when the injected sanitizer throws", async () => {
    vi.stubEnv("PUBLIC_CAPLETS_POSTHOG_TOKEN", "phc_test");
    posthogSanitizer.mockImplementation(() => {
      throw new Error("hook failure");
    });

    await import("../src/scripts/observability");

    const options = posthogInit.mock.calls[0]?.[1] as {
      before_send: (payload: unknown) => unknown;
    };
    expect(() => options.before_send({})).not.toThrow();
    expect(options.before_send({})).toBeNull();
  });

  it("swallows capture failure while link interaction continues", async () => {
    vi.stubEnv("PUBLIC_CAPLETS_POSTHOG_TOKEN", "phc_test");
    posthogCapture.mockImplementation(() => {
      throw new Error("capture failure");
    });
    document.body.innerHTML = `<main><a href="/docs/">Read docs</a></main>`;

    await expect(import("../src/scripts/observability")).resolves.toBeDefined();
    expect(() =>
      document.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    ).not.toThrow();
  });

  it("classifies /caplets links as categorical catalog navigation", async () => {
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
