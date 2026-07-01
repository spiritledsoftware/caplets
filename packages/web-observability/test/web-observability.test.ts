import { describe, expect, it } from "vitest";
import {
  attributedInstallCommand,
  attributionMarkerForSurface,
  buildWebEvent,
  bucketResultCount,
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
          page_family: "catalog",
          section_category: "search",
          search_length_bucket: bucketSearchTerm("google docs"),
          result_count_bucket: bucketResultCount(4),
          filter_category: "unknown",
          empty_state_category: "unknown",
        },
      }),
    ).toEqual({
      name: "caplets_catalog_search",
      properties: {
        surface: "catalog",
        route_family: "catalog",
        page_family: "catalog",
        section_category: "search",
        search_length_bucket: "medium",
        result_count_bucket: "few",
        filter_category: "unknown",
        empty_state_category: "unknown",
      },
    });
    expect(
      buildWebEvent({
        name: "caplets_site_intent",
        properties: {
          surface: "landing",
          route_family: "blog",
          page_family: "blog",
          section_category: "blog",
          navigation_path_category: "blog",
          outbound_action_category: "blog",
          cta_category: "blog",
        } as never,
      }),
    ).toEqual({
      name: "caplets_site_intent",
      properties: {
        surface: "landing",
        route_family: "blog",
        page_family: "blog",
        section_category: "blog",
        navigation_path_category: "blog",
        outbound_action_category: "blog",
        cta_category: "blog",
      },
    });
  });

  it("rejects event-specific property mixes at the shared boundary", () => {
    expect(() =>
      buildWebEvent({
        name: "caplets_catalog_search",
        properties: {
          surface: "catalog",
          route_family: "catalog",
          page_family: "catalog",
          section_category: "search",
          cta_category: "install",
        } as never,
      }),
    ).toThrow(/web telemetry property .* is not allowed/u);

    expect(() =>
      buildWebEvent({
        name: "caplets_catalog_search",
        properties: {
          surface: "catalog",
          route_family: "catalog",
          page_family: "catalog",
          section_category: "search",
          result_count_bucket: "few",
          filter_category: "unknown",
          empty_state_category: "unknown",
        } as never,
      }),
    ).toThrow(/missing web telemetry property: search_length_bucket/u);
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
    expect(classifyRouteFamily("/blog")).toBe("blog");
    expect(classifyRouteFamily("/blog/why-giant-mcp-tool-walls-dont-scale")).toBe("blog");
    expect(classifyRouteFamily("/caplets/google-docs")).toBe("catalog_detail");
  });

  it("creates short nonsecret install attribution markers", () => {
    expect(attributionMarkerForSurface("landing")).toBe("landing_install");
    expect(attributedInstallCommand("pnpm dlx caplets setup", "docs")).toBe(
      "pnpm dlx caplets telemetry attribution docs_install\npnpm dlx caplets setup",
    );
    expect(
      attributedInstallCommand("caplets install spiritledsoftware/caplets osv", "catalog"),
    ).toBe(
      "caplets telemetry attribution catalog_install\ncaplets install spiritledsoftware/caplets osv",
    );
    expect(
      attributedInstallCommand("caplets telemetry attribution docs_install\ncaplets setup", "docs"),
    ).toBe("caplets telemetry attribution docs_install\ncaplets setup");
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

  it("filters Sentry browser events without raw messages, urls, user, request, or extra payloads", () => {
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
        exception: {
          values: [
            {
              type: "Error",
              value: "fetch failed for https://example.com/?token=secret",
              stacktrace: {
                frames: [
                  {
                    filename: "https://caplets.ai/assets/app.js?token=secret",
                    function: "handleClick",
                    lineno: 12,
                    colno: 3,
                    vars: { token: "secret" },
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toEqual({
      release: "landing@1",
      environment: "production",
      tags: { surface: "landing", route_family: "home" },
      exception: {
        values: [
          {
            type: "Error",
            stacktrace: {
              frames: [{ filename: "app.js", function: "handleClick", lineno: 12, colno: 3 }],
            },
          },
        ],
      },
    });
  });
});
