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

export async function getCatalogEntry(
  entryKey: string,
  env: CatalogStoreEnv = {},
): Promise<CatalogEntryRecord | undefined> {
  return (await listCatalogEntries(env)).find((entry) => entry.entryKey === entryKey);
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
