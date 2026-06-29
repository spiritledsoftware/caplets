import * as Sentry from "@sentry/browser";
import {
  buildWebEvent,
  classifyRouteFamily,
  filterSentryBrowserEvent,
  type WebEventName,
  type WebEventProperties,
} from "@caplets/web-observability";
import posthog from "posthog-js";

const surface = "docs";
const posthogToken = import.meta.env.PUBLIC_CAPLETS_POSTHOG_TOKEN;
const posthogHost = import.meta.env.PUBLIC_CAPLETS_POSTHOG_HOST;
const sentryDsn = import.meta.env.PUBLIC_CAPLETS_DOCS_SENTRY_DSN;
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
captureDocsEvent("caplets_site_pageview", {
  route_family: routeFamily,
  page_family: routeFamily,
  referrer_category: referrerCategory(document.referrer),
});

document.addEventListener("click", (event) => {
  const link = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
  if (!link) return;
  const category = linkCategory(link);
  const installIntent = isInstallLink(link);
  if (category === "unknown" && !installIntent) return;
  captureDocsEvent(installIntent ? "caplets_install_intent" : "caplets_site_intent", {
    route_family: routeFamily,
    page_family: routeFamily,
    section_category: installIntent ? "install" : "docs",
    navigation_path_category:
      category === "docs" || category === "catalog"
        ? category
        : category === "github"
          ? "external"
          : "unknown",
    outbound_action_category: category,
    install_intent_category: installIntent ? "copy" : "unknown",
  });
});

function captureDocsEvent(name: WebEventName, properties: WebEventProperties): void {
  if (!posthogEnabled) return;
  try {
    const event = buildWebEvent({ name, properties: { surface, ...properties } });
    posthog.capture(event.name, {
      ...event.properties,
      $process_person_profile: false,
      $geoip_disable: true,
    });
  } catch {
    // Analytics must never affect docs behavior.
  }
}

function referrerCategory(referrer: string): WebEventProperties["referrer_category"] {
  if (!referrer) return "direct";
  try {
    const host = new URL(referrer).hostname;
    if (host.includes("google") || host.includes("bing") || host.includes("duckduckgo"))
      return "search";
    if (host.includes("github") || host.includes("x.com") || host.includes("twitter"))
      return "social";
    if (host.includes("catalog.caplets")) return "catalog";
    if (host.includes("docs.caplets")) return "docs";
  } catch {
    return "external";
  }
  return "external";
}

function linkCategory(
  link: HTMLAnchorElement,
): NonNullable<WebEventProperties["outbound_action_category"]> {
  const href = link.getAttribute("href") ?? "";
  if (href.includes("github.com")) return "github";
  if (href.includes("npmjs.com")) return "npm";
  if (href.startsWith("/") || href.includes("docs.caplets")) return "docs";
  if (href.includes("catalog.caplets")) return "catalog";
  return "unknown";
}

function isInstallLink(link: HTMLAnchorElement): boolean {
  const href = link.getAttribute("href") ?? "";
  const text = link.textContent?.toLowerCase() ?? "";
  return href.includes("/install") || text.includes("install") || text.includes("setup");
}
