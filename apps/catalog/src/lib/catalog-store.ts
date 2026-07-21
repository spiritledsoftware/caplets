import { formatCatalogInstallCount, type CatalogEntry } from "@caplets/core/catalog";
import type { D1Database } from "@cloudflare/workers-types";
import officialEntries from "../data/official-catalog.json";
import { rankInstallCount } from "./counts";

export type CatalogEntryRecord = CatalogEntry & {
  installCount: number;
  installCountDisplay: string;
  rankScore: number;
};

export type CatalogStoreEnv = {
  CATALOG_DB?: D1Database | undefined;
};

export type CatalogPageOptions = {
  limit: number;
  sort: "asc" | "desc";
  query?: string | undefined;
  after?: string | undefined;
};

export type CompactCatalogPage = {
  entries: Array<Omit<CatalogEntryRecord, "contentMarkdown">>;
  nextEntryKey?: string | undefined;
};

export async function listCatalogEntries(env: CatalogStoreEnv = {}): Promise<CatalogEntryRecord[]> {
  const db = env.CATALOG_DB;
  let overlays = new Map<string, number>();
  let suppressed = new Set<string>();
  let communityEntries: CatalogEntry[] = [];
  if (db) {
    try {
      [overlays, suppressed, communityEntries] = await Promise.all([
        readCountOverlays(db),
        readSuppressedEntryKeys(db),
        readCommunityEntries(db),
      ]);
    } catch {
      overlays = new Map<string, number>();
      suppressed = new Set<string>();
      communityEntries = [];
    }
  }
  return [...(officialEntries as CatalogEntry[]), ...communityEntries]
    .filter((entry) => !suppressed.has(entry.entryKey))
    .map((entry) => withCount(entry, overlays.get(entry.entryKey) ?? 0))
    .sort((left, right) => {
      const rank = right.rankScore - left.rankScore;
      return rank === 0 ? left.name.localeCompare(right.name) : rank;
    });
}

export async function listCompactCatalogEntries(
  env: CatalogStoreEnv = {},
): Promise<Array<Omit<CatalogEntryRecord, "contentMarkdown">>> {
  return (await listCatalogEntries(env)).map(
    ({ contentMarkdown: _contentMarkdown, ...entry }) => entry,
  );
}

export async function listCompactCatalogEntriesPage(
  options: CatalogPageOptions,
  env: CatalogStoreEnv = {},
): Promise<CompactCatalogPage> {
  const limit = catalogPageLimit(options.limit);
  const normalized = {
    ...options,
    limit,
    query: normalizeQuery(options.query),
  };
  const official = await readOfficialPageCandidates(normalized, env.CATALOG_DB);
  const community = env.CATALOG_DB
    ? await readCommunityPageCandidates(env.CATALOG_DB, normalized)
    : [];
  const candidates = mergeCatalogCandidates(official, community, normalized.sort, limit + 1);
  const entries = candidates.slice(0, limit);
  return candidates.length > limit
    ? { entries, nextEntryKey: entries[entries.length - 1]!.entryKey }
    : { entries };
}

export async function getCatalogEntry(
  entryKey: string,
  env: CatalogStoreEnv = {},
): Promise<CatalogEntryRecord | undefined> {
  return (await listCatalogEntries(env)).find((entry) => entry.entryKey === entryKey);
}

type CompactCatalogEntryRecord = Omit<CatalogEntryRecord, "contentMarkdown">;
type NormalizedCatalogPageOptions = CatalogPageOptions & { query: string | undefined };
type CommunityPageRow = {
  entryKey: string;
  entryJson: string;
  installCount: number;
};

async function readOfficialPageCandidates(
  options: NormalizedCatalogPageOptions,
  db: D1Database | undefined,
): Promise<CompactCatalogEntryRecord[]> {
  const direction = options.sort === "asc" ? 1 : -1;
  const ordered = [...(officialEntries as CatalogEntry[])].sort(
    (left, right) => direction * compareEntryKeys(left.entryKey, right.entryKey),
  );
  const entries: CompactCatalogEntryRecord[] = [];
  for (const entry of ordered) {
    if (
      options.after !== undefined &&
      direction * compareEntryKeys(entry.entryKey, options.after) <= 0
    ) {
      continue;
    }
    if (!matchesCatalogQuery(entry, options.query)) continue;
    const decoration = db
      ? await readOfficialDecoration(db, entry.entryKey).catch(() => ({
          installCount: 0,
          suppressed: false,
        }))
      : { installCount: 0, suppressed: false };
    if (decoration.suppressed) continue;
    entries.push(compactWithCount(entry, decoration.installCount));
    if (entries.length === options.limit + 1) break;
  }
  return entries;
}

async function readOfficialDecoration(
  db: D1Database,
  entryKey: string,
): Promise<{ installCount: number; suppressed: boolean }> {
  const row = await db
    .prepare(
      `select
         coalesce((select install_count from catalog_counts where entry_key = ?), 0)
           as installCount,
         exists(select 1 from catalog_suppressions where entry_key = ?) as suppressed`,
    )
    .bind(entryKey, entryKey)
    .first<{ installCount: number; suppressed: number }>();
  return {
    installCount: Number(row?.installCount) || 0,
    suppressed: Number(row?.suppressed) === 1,
  };
}

async function readCommunityPageCandidates(
  db: D1Database,
  options: NormalizedCatalogPageOptions,
): Promise<CompactCatalogEntryRecord[]> {
  const entries: CompactCatalogEntryRecord[] = [];
  const comparator = options.sort === "asc" ? ">" : "<";
  const order = options.sort === "asc" ? "asc" : "desc";
  const batchSize = Math.max(100, Math.min(500, options.limit + 1));
  let cursor = options.after;
  try {
    while (entries.length < options.limit + 1) {
      const cursorPredicate = cursor === undefined ? "" : `and e.entry_key ${comparator} ?`;
      const statement = db.prepare(
        `select
           e.entry_key as entryKey,
           e.entry_json as entryJson,
           coalesce(c.install_count, 0) as installCount
         from catalog_entries e
         left join catalog_counts c on c.entry_key = e.entry_key
         left join catalog_suppressions s on s.entry_key = e.entry_key
         where s.entry_key is null ${cursorPredicate}
         order by e.entry_key ${order}
         limit ?`,
      );
      const result =
        cursor === undefined
          ? await statement.bind(batchSize).all<CommunityPageRow>()
          : await statement.bind(cursor, batchSize).all<CommunityPageRow>();
      const rows = result.results ?? [];
      if (rows.length === 0) break;
      for (const row of rows) {
        const entry = parseCommunityEntry(row);
        if (!entry || !matchesCatalogQuery(entry, options.query)) continue;
        entries.push(compactWithCount(entry, Number(row.installCount) || 0));
        if (entries.length === options.limit + 1) break;
      }
      cursor = rows[rows.length - 1]!.entryKey;
      if (rows.length < batchSize) break;
    }
  } catch {
    return [];
  }
  return entries;
}

function parseCommunityEntry(row: CommunityPageRow): CatalogEntry | undefined {
  try {
    const entry = JSON.parse(row.entryJson) as CatalogEntry;
    return entry.trustLevel === "community" && entry.entryKey === row.entryKey ? entry : undefined;
  } catch {
    return undefined;
  }
}

function mergeCatalogCandidates(
  left: readonly CompactCatalogEntryRecord[],
  right: readonly CompactCatalogEntryRecord[],
  sort: CatalogPageOptions["sort"],
  maximum: number,
): CompactCatalogEntryRecord[] {
  const direction = sort === "asc" ? 1 : -1;
  const merged: CompactCatalogEntryRecord[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (merged.length < maximum && (leftIndex < left.length || rightIndex < right.length)) {
    const leftEntry = left[leftIndex];
    const rightEntry = right[rightIndex];
    if (
      rightEntry === undefined ||
      (leftEntry !== undefined &&
        direction * compareEntryKeys(leftEntry.entryKey, rightEntry.entryKey) <= 0)
    ) {
      merged.push(leftEntry!);
      leftIndex += 1;
    } else {
      merged.push(rightEntry);
      rightIndex += 1;
    }
  }
  return merged;
}

function compactWithCount(entry: CatalogEntry, installCount: number): CompactCatalogEntryRecord {
  const { contentMarkdown: _contentMarkdown, ...compact } = withCount(entry, installCount);
  return compact;
}

function matchesCatalogQuery(entry: CatalogEntry, query: string | undefined): boolean {
  return (
    query === undefined ||
    [entry.id, entry.name, entry.description, ...entry.tags]
      .join("\n")
      .toLowerCase()
      .includes(query)
  );
}

function normalizeQuery(query: string | undefined): string | undefined {
  const normalized = query?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function catalogPageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new TypeError("Catalog page limit must be an integer between 1 and 500.");
  }
  return limit;
}

function compareEntryKeys(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function withCount(entry: CatalogEntry, installCount: number): CatalogEntryRecord {
  return {
    ...entry,
    installCount,
    installCountDisplay: formatCatalogInstallCount(installCount),
    rankScore: rankInstallCount(installCount),
  };
}

async function readCountOverlays(db: D1Database): Promise<Map<string, number>> {
  const result = await db
    .prepare("select entry_key as entryKey, install_count as installCount from catalog_counts")
    .all<{ entryKey: string; installCount: number }>();
  return new Map(
    (result.results ?? []).map((row) => [row.entryKey, Number(row.installCount) || 0]),
  );
}

async function readSuppressedEntryKeys(db: D1Database): Promise<Set<string>> {
  const result = await db.prepare("select entry_key as entryKey from catalog_suppressions").all<{
    entryKey: string;
  }>();
  return new Set((result.results ?? []).map((row) => row.entryKey));
}

async function readCommunityEntries(db: D1Database): Promise<CatalogEntry[]> {
  const result = await db.prepare("select entry_json as entryJson from catalog_entries").all<{
    entryJson: string;
  }>();
  return (result.results ?? []).flatMap((row) => {
    try {
      const parsed = JSON.parse(row.entryJson) as CatalogEntry;
      return parsed.trustLevel === "community" ? [parsed] : [];
    } catch {
      return [];
    }
  });
}
