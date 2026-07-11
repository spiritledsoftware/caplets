// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWebEvent,
  capturePostHogEvent,
  createPostHogBeforeSend,
  sanitizePostHogCapture,
} from "../src/index";

const transportFetch = vi.fn();
const storageEntries = new Map<string, string>();
const browserStorage = {
  clear(): void {
    storageEntries.clear();
  },
  getItem(key: string): string | null {
    return storageEntries.get(key) ?? null;
  },
  key(index: number): string | null {
    return [...storageEntries.keys()][index] ?? null;
  },
  get length(): number {
    return storageEntries.size;
  },
  removeItem(key: string): void {
    storageEntries.delete(key);
  },
  setItem(key: string, value: string): void {
    storageEntries.set(key, value);
  },
};

type MutableCaptureResult = {
  uuid: unknown;
  event: unknown;
  properties: Record<string, unknown>;
  timestamp?: unknown;
  [key: string]: unknown;
};

function posthog13950CaptureResult(): MutableCaptureResult {
  return {
    uuid: "0189d14f-4f1a-7000-8000-000000000001",
    event: "caplets_catalog_search",
    timestamp: new Date("2026-07-10T12:00:00.000Z"),
    properties: {
      token: "phc_public_project_token",
      distinct_id: "anonymous-browser-identity",
      $is_identified: false,
      surface: "catalog",
      route_family: "catalog",
      page_family: "catalog",
      section_category: "search",
      search_length_bucket: "medium",
      filter_category: "tag",
      result_count_bucket: "few",
      empty_state_category: "unknown",
      $process_person_profile: true,
      $geoip_disable: false,
      $current_url: "https://catalog.caplets.dev/caplets?query=secret",
      $initial_current_url: "https://catalog.caplets.dev/?utm_source=search",
      $referrer: "https://search.example/?query=caplets",
      $referring_domain: "search.example",
      $title: "Private search title",
      $set: { email: "person@example.com" },
      $set_once: { plan: "team" },
      $unset: ["person_property"],
      $user_id: "known-user",
      $device_id: "anonymous-browser-identity",
      $session_id: "session-identity",
      $lib: "web",
      $lib_version: "captured-sdk-version",
      $future_sdk_property: "not implicitly allowed",
      unknown_application_property: "not allowed",
    },
    $set: { email: "person@example.com" },
    $set_once: { plan: "team" },
    $unset: ["person_property"],
    arbitrary_top_level: "not allowed",
  };
}

function sanitizedCatalogSearch() {
  return {
    uuid: "0189d14f-4f1a-7000-8000-000000000001",
    event: "caplets_catalog_search",
    timestamp: new Date("2026-07-10T12:00:00.000Z"),
    properties: {
      token: "phc_public_project_token",
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
  };
}

describe("PostHog final transport contract", () => {
  beforeEach(() => {
    transportFetch.mockReset();
    transportFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    browserStorage.clear();
    vi.stubGlobal("localStorage", browserStorage);
    vi.stubGlobal("sessionStorage", browserStorage);
    vi.stubGlobal("fetch", transportFetch);
    vi.stubGlobal("XMLHttpRequest", undefined);
    Object.defineProperty(window, "fetch", { configurable: true, value: transportFetch });
    Object.defineProperty(window, "localStorage", { configurable: true, value: browserStorage });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: browserStorage });
    Object.defineProperty(window, "XMLHttpRequest", { configurable: true, value: undefined });
  });

  afterEach(() => {
    browserStorage.clear();
    vi.unstubAllGlobals();
  });

  it("reconstructs the exact allowed final CaptureResult envelope", () => {
    expect(sanitizePostHogCapture(posthog13950CaptureResult())).toEqual(sanitizedCatalogSearch());
  });
  it("serializes an unmocked named SDK instance through the final hook without a flags request", async () => {
    // The SDK snapshots browser transports at module evaluation, so import it after interception.
    const { default: posthog } = await import("../../../apps/landing/node_modules/posthog-js");
    const receivedByHook: unknown[] = [];
    const beforeSend = createPostHogBeforeSend();

    const instance = posthog.init(
      "phc_public_project_token",
      {
        api_host: "https://posthog.transport.test",
        advanced_disable_flags: true,
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        capture_performance: false,
        disable_compression: true,
        disable_persistence: true,
        disable_session_recording: true,
        disable_surveys: true,
        disable_web_experiments: true,
        opt_out_useragent_filter: true,
        person_profiles: "never",
        persistence: "memory",
        request_batching: false,
        save_campaign_params: false,
        save_referrer: false,
        before_send(payload: unknown) {
          receivedByHook.push(payload);
          return beforeSend(payload);
        },
      },
      "u6_posthog_provider_contract",
    );
    expect(instance.__loaded).toBe(true);
    expect(instance.config.request_batching).toBe(false);
    expect(instance.has_opted_out_capturing()).toBe(false);
    instance.identify("known-user");
    expect(instance.get_distinct_id()).not.toBe("known-user");

    const event = buildWebEvent({
      name: "caplets_catalog_search",
      properties: {
        surface: "catalog",
        route_family: "catalog",
        page_family: "catalog",
        section_category: "search",
        search_length_bucket: "medium",
        filter_category: "tag",
        result_count_bucket: "few",
        empty_state_category: "unknown",
      },
    });

    instance.capture(
      event.name,
      {
        ...event.properties,
        $current_url: "https://catalog.caplets.dev/caplets?query=secret",
        $set: { email: "person@example.com" },
        unknown_application_property: "not allowed",
      },
      { $set: { email: "person@example.com" } },
    );

    await vi.waitFor(() => expect(receivedByHook).toHaveLength(1));

    await vi.waitFor(() => expect(transportFetch).toHaveBeenCalled());

    const request = transportFetch.mock.calls.find(([url]) => String(url).includes("/e/"));
    const requestUrls = transportFetch.mock.calls.map(([url]) => String(url));
    const augmentedProperties = (
      receivedByHook.at(-1) as { properties?: Record<string, unknown> } | undefined
    )?.properties;
    expect(request).toBeDefined();
    expect(requestUrls.some((url) => url.includes("/flags"))).toBe(false);
    expect(augmentedProperties).toMatchObject({ $is_identified: false });
    expect(augmentedProperties?.distinct_id).toBe(augmentedProperties?.$device_id);

    const body = JSON.parse(String(request?.[1]?.body)) as {
      event: string;
      properties: Record<string, unknown>;
      uuid: string;
    };
    expect(body.event).toBe(event.name);
    expect(body.uuid).toEqual(expect.any(String));
    expect(body.properties).toMatchObject({
      token: "phc_public_project_token",
      distinct_id: expect.any(String),
      $process_person_profile: false,
      $geoip_disable: true,
    });
    expect(body.properties.distinct_id).not.toBe("known-user");
    expect(body.properties).not.toHaveProperty("$current_url");
    expect(body.properties).not.toHaveProperty("$set");
    expect(body.properties).not.toHaveProperty("$device_id");
    expect(body.properties).not.toHaveProperty("unknown_application_property");
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a non-string uuid", { ...posthog13950CaptureResult(), uuid: 1 }],
    ["an empty uuid", { ...posthog13950CaptureResult(), uuid: "" }],
    ["a non-object properties value", { ...posthog13950CaptureResult(), properties: [] }],
    [
      "a missing provider token",
      {
        ...posthog13950CaptureResult(),
        properties: { ...posthog13950CaptureResult().properties, token: "" },
      },
    ],
    [
      "a missing anonymous transport identity",
      {
        ...posthog13950CaptureResult(),
        properties: { ...posthog13950CaptureResult().properties, distinct_id: "" },
      },
    ],
    ["an invalid timestamp", { ...posthog13950CaptureResult(), timestamp: "not-a-date" }],
  ])("drops malformed payloads without throwing: %s", (_label, payload) => {
    expect(() => sanitizePostHogCapture(payload)).not.toThrow();
    expect(sanitizePostHogCapture(payload)).toBeNull();
  });

  it("fails closed on arbitrary or URL-shaped event names", () => {
    const rawUrlEvent = posthog13950CaptureResult();
    rawUrlEvent.event = "https://private.example/path?token=secret";
    const arbitraryEvent = posthog13950CaptureResult();
    arbitraryEvent.event = "unapproved_event";

    expect(sanitizePostHogCapture(rawUrlEvent)).toBeNull();
    expect(sanitizePostHogCapture(arbitraryEvent)).toBeNull();
  });

  it("drops identified, unverified, or device-mismatched final envelopes", () => {
    const identified = posthog13950CaptureResult();
    identified.properties.$is_identified = true;
    const unverified = posthog13950CaptureResult();
    delete unverified.properties.$is_identified;
    const malformedIdentificationState = posthog13950CaptureResult();
    malformedIdentificationState.properties.$is_identified = "false";
    const deviceMismatch = posthog13950CaptureResult();
    deviceMismatch.properties.$device_id = "different-device-identity";

    expect(sanitizePostHogCapture(identified)).toBeNull();
    expect(sanitizePostHogCapture(unverified)).toBeNull();
    expect(sanitizePostHogCapture(malformedIdentificationState)).toBeNull();
    expect(sanitizePostHogCapture(deviceMismatch)).toBeNull();
  });

  it("forces profile and GeoIP controls across malformed incoming flag values", () => {
    for (const processPersonProfile of [undefined, true, "false", 0, {}]) {
      const payload = posthog13950CaptureResult();
      payload.properties.$process_person_profile = processPersonProfile;
      const sanitized = sanitizePostHogCapture(payload);
      expect(sanitized?.properties.$process_person_profile).toBe(false);
    }

    for (const geoipDisable of [undefined, false, "true", 1, []]) {
      const payload = posthog13950CaptureResult();
      payload.properties.$geoip_disable = geoipDisable;
      const sanitized = sanitizePostHogCapture(payload);
      expect(sanitized?.properties.$geoip_disable).toBe(true);
    }
  });

  it("omits unknown SDK fields and categorical values with nested shapes", () => {
    const payload = posthog13950CaptureResult();
    payload.properties.scroll_depth_bucket = ["gte_75"];
    payload.properties.unknown_object = { source: "raw" };
    payload.properties.$future_sdk_property = { raw: true };

    const sanitized = sanitizePostHogCapture(payload);

    expect(sanitized).toEqual(sanitizedCatalogSearch());
    expect(sanitized?.properties).not.toHaveProperty("scroll_depth_bucket");
    expect(sanitized?.properties).not.toHaveProperty("unknown_object");
    expect(sanitized?.properties).not.toHaveProperty("$future_sdk_property");
  });

  it("drops an event when a required categorical property has a nested shape", () => {
    const payload = posthog13950CaptureResult();
    payload.properties.surface = ["catalog"];

    expect(sanitizePostHogCapture(payload)).toBeNull();
  });

  it("contains injected final-hook failures and app-supplied capture failures", () => {
    const beforeSend = createPostHogBeforeSend(() => {
      throw new Error("sanitizer failure");
    });
    const event = buildWebEvent({
      name: "caplets_site_pageview",
      properties: {
        surface: "landing",
        route_family: "home",
        page_family: "home",
        referrer_category: "direct",
      },
    });
    const received: Array<[string, unknown]> = [];

    expect(beforeSend(posthog13950CaptureResult())).toBeNull();
    capturePostHogEvent(
      {
        capture(name, properties) {
          received.push([name, properties]);
        },
      },
      event,
    );
    expect(received).toEqual([[event.name, event.properties]]);
    expect(() =>
      capturePostHogEvent(
        {
          capture() {
            throw new Error("capture failure");
          },
        },
        event,
      ),
    ).not.toThrow();
  });
});
