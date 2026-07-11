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
  route_family: new Set(["home", "docs", "catalog", "catalog_detail", "privacy", "blog", "other"]),
  page_family: new Set(["home", "docs", "catalog", "catalog_detail", "privacy", "blog", "other"]),
  referrer_category: new Set(["direct", "search", "social", "docs", "catalog", "external"]),
  section_category: new Set([
    "hero",
    "install",
    "docs",
    "catalog",
    "blog",
    "search",
    "footer",
    "unknown",
  ]),
  navigation_path_category: new Set(["docs", "catalog", "blog", "home", "external", "unknown"]),
  outbound_action_category: new Set(["github", "npm", "docs", "catalog", "blog", "unknown"]),
  cta_category: new Set(["primary", "secondary", "install", "docs", "catalog", "blog", "unknown"]),
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

export function assertWebEventSafeProperties(properties: Record<string, unknown>): void {
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

export function filterSentryBrowserEvent(event: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  if (typeof event.release === "string") filtered.release = event.release;
  if (typeof event.environment === "string") filtered.environment = event.environment;
  if (event.level) filtered.level = event.level;
  const exception = sanitizeBrowserException(event.exception);
  if (exception) filtered.exception = exception;
  if (event.tags && typeof event.tags === "object" && !Array.isArray(event.tags)) {
    filtered.tags = filterSentryTags(event.tags as Record<string, unknown>);
  }
  return filtered;
}

function sanitizeBrowserException(value: unknown):
  | {
      values: Array<{
        type: string;
        stacktrace: { frames: SanitizedBrowserFrame[] };
      }>;
    }
  | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const values = (value as { values?: unknown }).values;
  if (!Array.isArray(values)) return undefined;
  for (const entry of values) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as { type?: unknown; stacktrace?: unknown };
    const type =
      typeof record.type === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(record.type)
        ? record.type
        : "Error";
    const stacktrace = record.stacktrace;
    if (!stacktrace || typeof stacktrace !== "object" || Array.isArray(stacktrace)) continue;
    const frames = (stacktrace as { frames?: unknown }).frames;
    if (!Array.isArray(frames)) continue;
    const sanitizedFrames = frames.flatMap(sanitizeBrowserFrame).slice(-20);
    return { values: [{ type, stacktrace: { frames: sanitizedFrames } }] };
  }
  return undefined;
}

type SanitizedBrowserFrame = {
  filename: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
};

function sanitizeBrowserFrame(value: unknown): SanitizedBrowserFrame[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const filename =
    typeof record.filename === "string" ? sanitizeBrowserFilename(record.filename) : undefined;
  if (!filename) return [];
  const functionName =
    typeof record.function === "string" ? sanitizeBrowserFunction(record.function) : undefined;
  const lineno = typeof record.lineno === "number" ? safeFrameNumber(record.lineno) : undefined;
  const colno = typeof record.colno === "number" ? safeFrameNumber(record.colno) : undefined;
  return [
    {
      filename,
      ...(functionName ? { function: functionName } : {}),
      ...(lineno ? { lineno } : {}),
      ...(colno ? { colno } : {}),
      ...(typeof record.in_app === "boolean" ? { in_app: record.in_app } : {}),
    },
  ];
}

function sanitizeBrowserFilename(value: string): string | undefined {
  let normalized = value.replaceAll("\\", "/");
  try {
    const url = new URL(normalized);
    normalized = url.pathname;
  } catch {
    normalized = normalized.replace(/^file:\/\//u, "");
  }
  const workspace = workspaceSafePath(normalized);
  if (workspace) return workspace;
  const basename = normalized.split("/").filter(Boolean).at(-1);
  if (!basename || !/^[A-Za-z0-9@._:-]{1,120}$/u.test(basename)) return undefined;
  return basename;
}

function workspaceSafePath(value: string): string | undefined {
  const match = value.match(/(?:^|\/)((?:packages|apps)\/.+)$/u);
  const path = match?.[1];
  if (!path) return undefined;
  const segments = path.split("/");
  if (!segments.every((segment) => /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/u.test(segment))) {
    return undefined;
  }
  return path;
}

function sanitizeBrowserFunction(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || RAW_VALUE_PATTERNS.some((pattern) => pattern.test(trimmed))) return undefined;
  return /^[A-Za-z0-9_$.[\]<>:/ -]{1,120}$/u.test(trimmed) ? trimmed : undefined;
}

function safeFrameNumber(value: number): number | undefined {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function filterSentryTags(tags: Record<string, unknown>): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (!ALLOWED_WEB_KEYS.has(key) || typeof value !== "string") continue;
    try {
      assertWebEventSafeProperties({ [key]: value });
      filtered[key] = value;
    } catch {
      // Drop unsafe SDK or caller-provided tags.
    }
  }
  return filtered;
}
