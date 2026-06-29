import * as Sentry from "@sentry/browser";
import {
  attributedInstallCommand,
  buildWebEvent,
  bucketResultCount,
  bucketSearchTerm,
  classifyRouteFamily,
  filterSentryBrowserEvent,
  type WebEventName,
  type WebEventPropertySet,
  type WebEventProperties,
} from "@caplets/web-observability";
import posthog from "posthog-js";

const surface = "catalog";
const posthogToken = import.meta.env.PUBLIC_CAPLETS_POSTHOG_TOKEN;
const posthogHost = import.meta.env.PUBLIC_CAPLETS_POSTHOG_HOST;
const sentryDsn = import.meta.env.PUBLIC_CAPLETS_CATALOG_SENTRY_DSN;
const release = import.meta.env.PUBLIC_CAPLETS_RELEASE;
const environment = import.meta.env.PUBLIC_CAPLETS_ENVIRONMENT ?? import.meta.env.MODE;
let posthogEnabled = false;

if (posthogToken) {
  posthog.init(posthogToken, {
    api_host: posthogHost || "https://us.i.posthog.com",
    autocapture: false,
    capture_pageview: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_web_experiments: true,
    disable_persistence: true,
    persistence: "memory",
  });
  posthogEnabled = true;
}

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    release,
    environment,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend(event) {
      return filterSentryBrowserEvent(
        event as unknown as Record<string, unknown>,
      ) as unknown as typeof event;
    },
  });
}

const routeFamily = classifyRouteFamily(window.location.pathname);
captureCatalogEvent("caplets_site_pageview", {
  route_family: routeFamily,
  page_family: routeFamily,
  referrer_category: referrerCategory(document.referrer),
});

export function attributedCatalogCommand(command: string): string {
  return attributedInstallCommand(command, surface);
}

export function captureCatalogInstallCopy(): void {
  captureCatalogEvent("caplets_install_intent", {
    route_family: routeFamily,
    page_family: routeFamily,
    section_category: "install",
    install_intent_category: "copy",
    result_interaction_category: "copy_install",
  });
}

export function captureCatalogResultOpen(): void {
  captureCatalogEvent("caplets_site_intent", {
    route_family: routeFamily,
    page_family: routeFamily,
    section_category: "catalog",
    result_interaction_category: "open_detail",
  });
}

export function captureCatalogSearch(input: {
  query: string;
  resultCount: number;
  filterChanged?: "trust" | "setup" | "tag" | "reset" | undefined;
}): void {
  captureCatalogEvent("caplets_catalog_search", {
    route_family: "catalog",
    page_family: "catalog",
    section_category: "search",
    search_length_bucket: bucketSearchTerm(input.query),
    result_count_bucket: bucketResultCount(input.resultCount),
    filter_category: filterCategory(input.filterChanged),
    empty_state_category:
      input.resultCount > 0 ? "unknown" : input.query.trim() ? "no_results" : "no_query",
  });
}

function captureCatalogEvent(name: WebEventName, properties: WebEventPropertySet): void {
  if (!posthogEnabled) return;
  try {
    const event = buildWebEvent({
      name,
      properties: { surface, ...properties } as WebEventProperties<typeof name>,
    });
    posthog.capture(event.name, {
      ...event.properties,
      $process_person_profile: false,
      $geoip_disable: true,
    });
  } catch {
    // Analytics must never affect catalog behavior.
  }
}

function referrerCategory(referrer: string): WebEventPropertySet["referrer_category"] {
  if (!referrer) return "direct";
  try {
    const host = new URL(referrer).hostname;
    if (host.includes("google") || host.includes("bing") || host.includes("duckduckgo"))
      return "search";
    if (host.includes("github") || host.includes("x.com") || host.includes("twitter"))
      return "social";
    if (host.includes("docs.caplets")) return "docs";
    if (host.includes("catalog.caplets")) return "catalog";
  } catch {
    return "external";
  }
  return "external";
}

function filterCategory(
  changed: "trust" | "setup" | "tag" | "reset" | undefined,
): NonNullable<WebEventPropertySet["filter_category"]> {
  if (changed === "reset") return "clear";
  if (changed === "tag") return "tag";
  if (changed === "trust") return "source";
  if (changed === "setup") return "auth";
  return "unknown";
}
