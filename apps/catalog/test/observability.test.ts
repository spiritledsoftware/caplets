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

describe("catalog observability", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    posthogCapture.mockReset();
    posthogInit.mockReset();
    posthogSanitizer.mockReset();
    const actual = await vi.importActual<typeof WebObservabilityModule>(
      "@caplets/web-observability",
    );
    posthogSanitizer.mockImplementation(actual.sanitizePostHogCapture);
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
      "caplets telemetry attribution catalog_install\ncaplets add npm",
    );
  });

  it("does not initialize or capture catalog analytics without provider env", async () => {
    const { captureCatalogSearch } = await import("../src/scripts/observability");

    captureCatalogSearch({ query: "raw private search", resultCount: 0 });

    expect(posthogInit).not.toHaveBeenCalled();
    expect(posthogCapture).not.toHaveBeenCalled();
  });

  it("installs privacy options and sanitizes the final augmented catalog envelope", async () => {
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
        uuid: "0189d14f-4f1a-7000-8000-000000000003",
        event: "caplets_catalog_search",
        timestamp: new Date("2026-07-10T12:00:00.000Z"),
        properties: {
          token: "phc_test",
          distinct_id: "anonymous-browser-identity",
          $device_id: "anonymous-browser-identity",
          $is_identified: false,
          surface: "catalog",
          route_family: "catalog",
          page_family: "catalog",
          section_category: "search",
          search_length_bucket: "medium",
          filter_category: "tag",
          result_count_bucket: "few",
          empty_state_category: "unknown",
          $current_url: "https://catalog.caplets.dev/caplets?query=secret",
          $unset: ["person_property"],
          unknown_application_property: "not allowed",
        },
      }),
    ).toEqual({
      uuid: "0189d14f-4f1a-7000-8000-000000000003",
      event: "caplets_catalog_search",
      timestamp: new Date("2026-07-10T12:00:00.000Z"),
      properties: {
        token: "phc_test",
        distinct_id: "anonymous-browser-identity",
        surface: "catalog",
        route_family: "catalog",
        page_family: "catalog",
        section_category: "search",
        search_length_bucket: "medium",
        filter_category: "tag",
        result_count_bucket: "few",
        empty_state_category: "unknown",
        $process_person_profile: false,
        $geoip_disable: true,
      },
    });
  });

  it("keeps catalog entry points live when init throws", async () => {
    vi.stubEnv("PUBLIC_CAPLETS_POSTHOG_TOKEN", "phc_test");
    posthogInit.mockImplementationOnce(() => {
      throw new Error("init failure");
    });

    const { captureCatalogSearch } = await import("../src/scripts/observability");

    expect(() => captureCatalogSearch({ query: "search", resultCount: 1 })).not.toThrow();
    expect(posthogCapture).not.toHaveBeenCalled();
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

  it("swallows capture failure while catalog search continues", async () => {
    vi.stubEnv("PUBLIC_CAPLETS_POSTHOG_TOKEN", "phc_test");
    posthogCapture.mockImplementation(() => {
      throw new Error("capture failure");
    });

    const { captureCatalogSearch } = await import("../src/scripts/observability");

    expect(() =>
      captureCatalogSearch({ query: "raw private search", resultCount: 0, filterChanged: "tag" }),
    ).not.toThrow();
  });

  it("preserves categorical catalog search behavior", async () => {
    vi.stubEnv("PUBLIC_CAPLETS_POSTHOG_TOKEN", "phc_test");

    const { captureCatalogSearch } = await import("../src/scripts/observability");
    posthogCapture.mockClear();
    captureCatalogSearch({ query: "search", resultCount: 0, filterChanged: "tag" });

    expect(posthogCapture).toHaveBeenCalledWith("caplets_catalog_search", {
      surface: "catalog",
      route_family: "catalog",
      page_family: "catalog",
      section_category: "search",
      search_length_bucket: "medium",
      result_count_bucket: "zero",
      filter_category: "tag",
      empty_state_category: "no_results",
    });
  });

  it("sends catalog worker errors as sanitized Sentry envelopes", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-4000-8000-000000000001" });
    const { captureCatalogServerError } = await import("../src/lib/server-observability");

    await captureCatalogServerError(new Error("raw /home/alex/secret"), {
      CAPLETS_CATALOG_SENTRY_DSN: "https://public@example.ingest.sentry.io/sentry/123",
      PUBLIC_CAPLETS_ENVIRONMENT: "production",
      PUBLIC_CAPLETS_RELEASE: "sites@test",
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://example.ingest.sentry.io/sentry/api/123/envelope/",
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
