export type CatalogCompactEntry = {
  entryKey: string;
  id: string;
  name: string;
  description: string;
  tags: string[];
  trustLevel: string;
  setupReadiness: string;
  installCommand: {
    text: string;
    copyable: boolean;
  };
  icon?: {
    type: "url" | "bundled";
    url: string;
    path?: string;
  };
  warnings?: Array<{
    code: string;
    severity: "info" | "caution" | "danger";
    label: string;
    message: string;
  }>;
  installCount?: number;
  rankScore?: number;
  installCountDisplay?: string;
  authReadiness?: string;
  projectBindingReadiness?: string;
  source?: { repository?: string };
  workflow?: { label?: string; kind?: string };
};

export type CatalogCompactResponse = {
  version?: number;
  view?: "compact";
  entries?: CatalogCompactEntry[];
  error?: string;
};

export type CatalogDiscoveryState = {
  query: string;
  scope: string;
  setup: string;
  tag: string;
  sort: "rank" | "name";
};

export const defaultCatalogState: CatalogDiscoveryState = {
  query: "",
  scope: "all",
  setup: "all",
  tag: "all",
  sort: "rank",
};

const scopes: Record<string, true> = { all: true, official: true, community: true };
const setups: Record<string, true> = { all: true, ready: true, required: true, unknown: true };
const catalogKeys = ["q", "scope", "setup", "tag", "sort"] as const;

export function catalogTags(entries: CatalogCompactEntry[]): string[] {
  return [...new Set(entries.flatMap((entry) => entry.tags ?? []))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export function catalogStateFromLocation(
  location: Pick<Location, "search"> | undefined = typeof window === "undefined"
    ? undefined
    : window.location,
): CatalogDiscoveryState {
  return parseCatalogState(new URLSearchParams(location?.search ?? ""));
}

export function parseCatalogState(
  params: URLSearchParams,
  tags: readonly string[] = [],
): CatalogDiscoveryState {
  const scope = params.get("scope") ?? "all";
  const setup = params.get("setup") ?? "all";
  const requestedTag = params.get("tag") ?? "all";
  const tag =
    requestedTag === "all"
      ? "all"
      : (tags.find((candidate) => candidate.toLowerCase() === requestedTag.toLowerCase()) ?? "all");
  return {
    query: params.get("q")?.trim() ?? "",
    scope: scopes[scope] ? scope : "all",
    setup: setups[setup] ? setup : "all",
    tag,
    sort: params.get("sort") === "name" ? "name" : "rank",
  };
}

export function serializeCatalogState(state: CatalogDiscoveryState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.query.trim()) params.set("q", state.query.trim());
  if (state.scope !== "all") params.set("scope", state.scope);
  if (state.setup !== "all") params.set("setup", state.setup);
  if (state.tag !== "all") params.set("tag", state.tag);
  if (state.sort !== "rank") params.set("sort", state.sort);
  return params;
}

export function updateCatalogUrl(href: string, state: CatalogDiscoveryState): string {
  const url = new URL(href, "https://dashboard.invalid");
  for (const key of catalogKeys) url.searchParams.delete(key);
  for (const [key, value] of serializeCatalogState(state)) url.searchParams.set(key, value);
  const query = url.searchParams.toString();
  return `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
}

export function filterCatalogEntries(
  entries: CatalogCompactEntry[],
  state: CatalogDiscoveryState,
): CatalogCompactEntry[] {
  const query = state.query.trim().toLowerCase();
  const normalizedQuery = normalize(query);
  const tag = state.tag.trim().toLowerCase();
  const normalizedTag = normalize(tag);
  return entries
    .filter((entry) => {
      const searchable = [
        entry.name,
        entry.description,
        ...(entry.tags ?? []),
        entry.source?.repository ?? "",
        entry.workflow?.label ?? "",
        entry.installCommand.text,
      ]
        .join(" ")
        .toLowerCase();
      return (
        (!query || searchable.includes(query) || normalize(searchable).includes(normalizedQuery)) &&
        (state.scope === "all" || entry.trustLevel === state.scope) &&
        (state.setup === "all" || entry.setupReadiness === state.setup) &&
        (tag === "all" ||
          entry.tags.some((value) => {
            const lower = value.toLowerCase();
            return lower === tag || lower.includes(tag) || normalize(lower).includes(normalizedTag);
          }))
      );
    })
    .sort((left, right) => {
      if (state.sort === "name") return left.name.localeCompare(right.name);
      const rank =
        (right.rankScore ?? right.installCount ?? 0) - (left.rankScore ?? left.installCount ?? 0);
      return rank || left.name.localeCompare(right.name);
    });
}

function normalize(value: string): string {
  return value.replace(/[^a-z0-9]+/gu, " ").trim();
}
