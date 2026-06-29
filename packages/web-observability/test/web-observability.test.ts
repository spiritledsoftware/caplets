import { describe, expect, it } from "vitest";
import {
  attributedInstallCommand,
  attributionMarkerForSurface,
  buildWebEvent,
  bucketResultCount,
  bucketScrollDepth,
  bucketSearchTerm,
  classifyRouteFamily,
  filterPostHogProperties,
  filterSentryBrowserEvent,
} from "../src/index";

describe("web observability contract", () => {
  it("builds categorical site and catalog events", () => {
    expect(
      buildWebEvent({
        name: "caplets_catalog_search",
        properties: {
          surface: "catalog",
          route_family: "catalog",
          search_length_bucket: bucketSearchTerm("google docs"),
          result_count_bucket: bucketResultCount(4),
          scroll_depth_bucket: bucketScrollDepth(80),
          empty_state_category: "unknown",
        },
      }),
    ).toEqual({
      name: "caplets_catalog_search",
      properties: {
        surface: "catalog",
        route_family: "catalog",
        search_length_bucket: "medium",
        result_count_bucket: "few",
        scroll_depth_bucket: "gte_75",
        empty_state_category: "unknown",
      },
    });
  });

  it("rejects raw URLs, selectors, and unknown web properties", () => {
    expect(() =>
      buildWebEvent({
        name: "caplets_site_pageview",
        properties: { route_family: "https://example.com/docs" } as never,
      }),
    ).toThrow(/unsafe web telemetry property/u);
    expect(() =>
      buildWebEvent({
        name: "caplets_site_pageview",
        properties: { dom_selector: "#install-button" } as never,
      }),
    ).toThrow(/unknown web telemetry property/u);
  });

  it("classifies routes without preserving raw URLs", () => {
    expect(classifyRouteFamily("/")).toBe("home");
    expect(classifyRouteFamily("/docs/privacy/indexing")).toBe("privacy");
    expect(classifyRouteFamily("/caplets/google-docs")).toBe("catalog_detail");
  });

  it("creates short nonsecret install attribution markers", () => {
    expect(attributionMarkerForSurface("landing")).toBe("landing_install");
    expect(attributedInstallCommand("pnpm dlx caplets setup", "docs")).toBe(
      "CAPLETS_INSTALL_ATTRIBUTION=docs_install pnpm dlx caplets setup",
    );
  });

  it("filters PostHog SDK properties down to allowed categories", () => {
    expect(
      filterPostHogProperties({
        surface: "landing",
        route_family: "home",
        $current_url: "https://caplets.ai/",
        distinct_id: "visitor-123",
        token: "secret",
      }),
    ).toEqual({ surface: "landing", route_family: "home" });
  });

  it("filters Sentry browser events without user, request body, analytics id, or extra payloads", () => {
    expect(
      filterSentryBrowserEvent({
        release: "landing@1",
        environment: "production",
        user: { id: "visitor-123" },
        request: { url: "https://caplets.ai/", data: "payload" },
        extra: { args: ["secret"] },
        tags: {
          surface: "landing",
          route_family: "home",
          unsafe: "https://example.com/raw",
        },
        exception: { values: [{ type: "Error", stacktrace: { frames: [] } }] },
      }),
    ).toEqual({
      release: "landing@1",
      environment: "production",
      tags: { surface: "landing", route_family: "home" },
      exception: { values: [{ type: "Error", stacktrace: { frames: [] } }] },
    });
  });
});
