import type { WebEventProperties } from "./events";

const ALLOWED_WEB_KEYS = new Set([
  "surface",
  "route_family",
  "page_family",
  "referrer_category",
  "section_category",
  "navigation_path_category",
  "outbound_action_category",
  "cta_category",
  "install_intent_category",
  "search_length_bucket",
  "filter_category",
  "result_interaction_category",
  "result_count_bucket",
  "empty_state_category",
  "scroll_depth_bucket",
  "repeated_intent_bucket",
]);

const VALUE_ALLOWLISTS: Record<string, ReadonlySet<string>> = {
  surface: new Set(["landing", "docs", "catalog"]),
  route_family: new Set(["home", "docs", "catalog", "catalog_detail", "privacy", "other"]),
  page_family: new Set(["home", "docs", "catalog", "catalog_detail", "privacy", "other"]),
  referrer_category: new Set(["direct", "search", "social", "docs", "catalog", "external"]),
  section_category: new Set(["hero", "install", "docs", "catalog", "search", "footer", "unknown"]),
  navigation_path_category: new Set(["docs", "catalog", "home", "external", "unknown"]),
  outbound_action_category: new Set(["github", "npm", "docs", "catalog", "unknown"]),
  cta_category: new Set(["primary", "secondary", "install", "docs", "catalog", "unknown"]),
  install_intent_category: new Set(["copy", "run_marker", "unknown"]),
  search_length_bucket: new Set(["empty", "short", "medium", "long"]),
  filter_category: new Set(["auth", "source", "tag", "clear", "unknown"]),
  result_interaction_category: new Set(["open_detail", "copy_install", "external", "unknown"]),
  result_count_bucket: new Set(["zero", "one", "few", "many"]),
  empty_state_category: new Set(["no_results", "no_query", "unknown"]),
  scroll_depth_bucket: new Set(["lt_25", "lt_50", "lt_75", "gte_75"]),
  repeated_intent_bucket: new Set(["first", "repeat", "many"]),
};

const RAW_VALUE_PATTERNS = [
  /^https?:\/\//iu,
  /^\/[^/]/u,
  /[a-z0-9-]+\.[a-z]{2,}/iu,
  /(?:token|secret|key|password)=/iu,
  /^sk-[a-z0-9]/iu,
  /^gh[pousr]_[a-z0-9]/iu,
];

export function assertWebEventSafeProperties(
  properties: WebEventProperties & Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(properties)) {
    if (!ALLOWED_WEB_KEYS.has(key)) {
      throw new Error(`unknown web telemetry property: ${key}`);
    }
    if (typeof value !== "string") {
      throw new Error(`unsafe web telemetry property: ${key}`);
    }
    if (
      !VALUE_ALLOWLISTS[key]?.has(value) ||
      RAW_VALUE_PATTERNS.some((pattern) => pattern.test(value))
    ) {
      throw new Error(`unsafe web telemetry property: ${key}`);
    }
  }
}

export function filterPostHogProperties(input: Record<string, unknown>): WebEventProperties {
  const properties: WebEventProperties = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_WEB_KEYS.has(key) || typeof value !== "string") continue;
    try {
      assertWebEventSafeProperties({ [key]: value } as never);
      Object.assign(properties, { [key]: value });
    } catch {
      // Provider filters are defensive and should silently drop SDK-added raw fields.
    }
  }
  return properties;
}

export function filterSentryBrowserEvent(event: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  if (typeof event.release === "string") filtered.release = event.release;
  if (typeof event.environment === "string") filtered.environment = event.environment;
  if (event.level) filtered.level = event.level;
  if (event.exception) filtered.exception = event.exception;
  if (event.tags && typeof event.tags === "object" && !Array.isArray(event.tags)) {
    filtered.tags = filterSentryTags(event.tags as Record<string, unknown>);
  }
  return filtered;
}

function filterSentryTags(tags: Record<string, unknown>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (!ALLOWED_WEB_KEYS.has(key) || typeof value !== "string") continue;
    try {
      assertWebEventSafeProperties({ [key]: value } as never);
      filtered[key] = value;
    } catch {
      // Drop unsafe SDK or caller-provided tags.
    }
  }
  return filtered;
}
