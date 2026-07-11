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

describe("docs observability", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    posthogCapture.mockReset();
    posthogInit.mockReset();
    posthogSanitizer.mockReset();
    const actual = await vi.importActual<typeof WebObservabilityModule>(
      "@caplets/web-observability",
    );
    posthogSanitizer.mockImplementation(actual.sanitizePostHogCapture);
    document.body.innerHTML = "";
  });

  it("does not initialize or capture without provider env while navigation listeners load", async () => {
    document.body.innerHTML = `<a href="/install/">Install</a>`;
    const addEventListener = vi.spyOn(document, "addEventListener");

    await expect(import("../src/scripts/observability")).resolves.toBeDefined();
    document.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(posthogInit).not.toHaveBeenCalled();
    expect(posthogCapture).not.toHaveBeenCalled();
    expect(addEventListener).toHaveBeenCalledWith("click", expect.any(Function));
  });

  it("installs privacy options and sanitizes the final augmented envelope", async () => {
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
        uuid: "0189d14f-4f1a-7000-8000-000000000002",
        event: "caplets_site_pageview",
        timestamp: new Date("2026-07-10T12:00:00.000Z"),
        properties: {
          token: "phc_test",
          distinct_id: "anonymous-browser-identity",
          $device_id: "anonymous-browser-identity",
          $is_identified: false,
          surface: "docs",
          route_family: "docs",
          page_family: "docs",
          referrer_category: "direct",
          $referrer: "https://search.example/?query=secret",
          $set_once: { email: "person@example.com" },
          unknown_application_property: "not allowed",
        },
      }),
    ).toEqual({
      uuid: "0189d14f-4f1a-7000-8000-000000000002",
      event: "caplets_site_pageview",
      timestamp: new Date("2026-07-10T12:00:00.000Z"),
      properties: {
        token: "phc_test",
        distinct_id: "anonymous-browser-identity",
        surface: "docs",
        route_family: "docs",
        page_family: "docs",
        referrer_category: "direct",
        $process_person_profile: false,
        $geoip_disable: true,
      },
    });
  });

  it("keeps listener registration active when init throws", async () => {
    vi.stubEnv("PUBLIC_CAPLETS_POSTHOG_TOKEN", "phc_test");
    posthogInit.mockImplementationOnce(() => {
      throw new Error("init failure");
    });
    const addEventListener = vi.spyOn(document, "addEventListener");

    await expect(import("../src/scripts/observability")).resolves.toBeDefined();

    expect(posthogCapture).not.toHaveBeenCalled();
    expect(addEventListener).toHaveBeenCalledWith("click", expect.any(Function));
  });

  it("returns null from its installed hook when the injected sanitizer throws", async () => {
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

  it("swallows capture failure while navigation continues", async () => {
    vi.stubEnv("PUBLIC_CAPLETS_POSTHOG_TOKEN", "phc_test");
    posthogCapture.mockImplementation(() => {
      throw new Error("capture failure");
    });
    document.body.innerHTML = `<a href="/caplets/osv/">Open catalog</a>`;

    await expect(import("../src/scripts/observability")).resolves.toBeDefined();
    expect(() =>
      document.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    ).not.toThrow();
  });

  it("classifies root-relative catalog links as categorical catalog intent", async () => {
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
