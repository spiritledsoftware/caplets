import { assertWebEventSafeProperties } from "./privacy";

export type WebSurface = "landing" | "docs" | "catalog";
export type WebEventName =
  | "caplets_site_pageview"
  | "caplets_site_intent"
  | "caplets_catalog_search"
  | "caplets_install_intent";
export type RouteFamily = "home" | "docs" | "catalog" | "catalog_detail" | "privacy" | "other";
export type ReferrerCategory = "direct" | "search" | "social" | "docs" | "catalog" | "external";
export type ScrollDepthBucket = "lt_25" | "lt_50" | "lt_75" | "gte_75";
export type SearchLengthBucket = "empty" | "short" | "medium" | "long";
export type ResultCountBucket = "zero" | "one" | "few" | "many";

export type WebEventProperties = Partial<{
  surface: WebSurface;
  route_family: RouteFamily;
  page_family: RouteFamily;
  referrer_category: ReferrerCategory;
  section_category: "hero" | "install" | "docs" | "catalog" | "search" | "footer" | "unknown";
  navigation_path_category: "docs" | "catalog" | "home" | "external" | "unknown";
  outbound_action_category: "github" | "npm" | "docs" | "catalog" | "unknown";
  cta_category: "primary" | "secondary" | "install" | "docs" | "catalog" | "unknown";
  install_intent_category: "copy" | "run_marker" | "unknown";
  search_length_bucket: SearchLengthBucket;
  filter_category: "auth" | "source" | "tag" | "clear" | "unknown";
  result_interaction_category: "open_detail" | "copy_install" | "external" | "unknown";
  result_count_bucket: ResultCountBucket;
  empty_state_category: "no_results" | "no_query" | "unknown";
  scroll_depth_bucket: ScrollDepthBucket;
  repeated_intent_bucket: "first" | "repeat" | "many";
}>;

const WEB_EVENTS = new Set<WebEventName>([
  "caplets_site_pageview",
  "caplets_site_intent",
  "caplets_catalog_search",
  "caplets_install_intent",
]);

export type WebEvent = {
  name: WebEventName;
  properties: WebEventProperties;
};

export function buildWebEvent(input: {
  name: WebEventName;
  properties: WebEventProperties;
}): WebEvent {
  if (!WEB_EVENTS.has(input.name)) {
    throw new Error(`unknown web telemetry event: ${input.name}`);
  }
  assertWebEventSafeProperties(input.properties);
  return {
    name: input.name,
    properties: input.properties,
  };
}

export function classifyRouteFamily(pathname: string): RouteFamily {
  if (pathname === "/" || pathname === "") return "home";
  if (pathname.startsWith("/docs/privacy")) return "privacy";
  if (pathname.startsWith("/docs")) return "docs";
  if (pathname.startsWith("/caplets/")) return "catalog_detail";
  if (pathname.startsWith("/catalog") || pathname === "/caplets") return "catalog";
  return "other";
}

export function bucketSearchTerm(value: string): SearchLengthBucket {
  const length = value.trim().length;
  if (length === 0) return "empty";
  if (length < 4) return "short";
  if (length < 20) return "medium";
  return "long";
}

export function bucketResultCount(count: number): ResultCountBucket {
  if (!Number.isFinite(count) || count <= 0) return "zero";
  if (count === 1) return "one";
  if (count < 10) return "few";
  return "many";
}

export function bucketScrollDepth(percent: number): ScrollDepthBucket {
  if (!Number.isFinite(percent) || percent < 25) return "lt_25";
  if (percent < 50) return "lt_50";
  if (percent < 75) return "lt_75";
  return "gte_75";
}
