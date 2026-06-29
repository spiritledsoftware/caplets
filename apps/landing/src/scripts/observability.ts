import * as Sentry from "@sentry/browser";
import {
  attributedInstallCommand,
  buildWebEvent,
  classifyRouteFamily,
  filterSentryBrowserEvent,
  type WebEventName,
  type WebEventPropertySet,
  type WebEventProperties,
} from "@caplets/web-observability";
import posthog from "posthog-js";

const surface = "landing";
const posthogToken = import.meta.env.PUBLIC_CAPLETS_POSTHOG_TOKEN;
const posthogHost = import.meta.env.PUBLIC_CAPLETS_POSTHOG_HOST;
const sentryDsn = import.meta.env.PUBLIC_CAPLETS_LANDING_SENTRY_DSN;
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

captureLandingEvent("caplets_site_pageview", {
  route_family: classifyRouteFamily(window.location.pathname),
  page_family: "home",
  referrer_category: referrerCategory(document.referrer),
});

document.addEventListener("click", (event) => {
  const link = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
  if (!link) return;
  const category = linkCategory(link);
  if (category === "unknown") return;
  captureLandingEvent("caplets_site_intent", {
    route_family: "home",
    section_category: sectionCategory(link),
    navigation_path_category:
      category === "docs" || category === "catalog"
        ? category
        : category === "github"
          ? "external"
          : "unknown",
    outbound_action_category: category,
    cta_category: ctaCategory(link),
  });
});

export function attributedLandingCommand(command: string): string {
  return attributedInstallCommand(command, surface);
}

export function captureLandingInstallCopy(): void {
  captureLandingEvent("caplets_install_intent", {
    route_family: "home",
    section_category: "install",
    install_intent_category: "copy",
  });
}

function captureLandingEvent(name: WebEventName, properties: WebEventPropertySet): void {
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
    // Analytics must never affect site behavior.
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

function linkCategory(
  link: HTMLAnchorElement,
): NonNullable<WebEventPropertySet["outbound_action_category"]> {
  const href = link.getAttribute("href") ?? "";
  if (href.includes("github.com")) return "github";
  if (href.includes("npmjs.com")) return "npm";
  if (href.startsWith("/docs") || href.includes("docs.caplets")) return "docs";
  if (
    href.startsWith("/catalog") ||
    href === "/caplets" ||
    href.startsWith("/caplets/") ||
    href.includes("catalog.caplets")
  ) {
    return "catalog";
  }
  return "unknown";
}

function sectionCategory(
  element: HTMLElement,
): NonNullable<WebEventPropertySet["section_category"]> {
  const section = element.closest<HTMLElement>("section, header, footer");
  if (section?.tagName.toLowerCase() === "footer") return "footer";
  const text = `${section?.id ?? ""} ${section?.className ?? ""}`.toLowerCase();
  if (text.includes("hero")) return "hero";
  if (text.includes("install") || text.includes("activation")) return "install";
  if (text.includes("docs")) return "docs";
  if (text.includes("catalog")) return "catalog";
  return "unknown";
}

function ctaCategory(element: HTMLElement): NonNullable<WebEventPropertySet["cta_category"]> {
  const text = element.textContent?.toLowerCase() ?? "";
  if (text.includes("install") || text.includes("copy")) return "install";
  if (text.includes("docs")) return "docs";
  if (text.includes("catalog")) return "catalog";
  return element.closest("main") ? "secondary" : "primary";
}
