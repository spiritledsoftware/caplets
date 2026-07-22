import { dashboardPath } from "@/lib/paths";

export type CatalogLocation = { mode: "list" } | { mode: "detail"; entryKey: string };

export type CatalogHistoryState = {
  catalogListHref: string;
};

export function catalogListHref(): string {
  return dashboardPath("catalog");
}

export function catalogDetailHref(entryKey: string): string {
  if (!isSafeEntryKey(entryKey)) {
    throw new TypeError("Catalog entryKey must be one safe encoded path segment.");
  }
  return dashboardPath(`catalog/${encodeURIComponent(entryKey)}`);
}

export function catalogLocationFromPath(pathname: string): CatalogLocation {
  const prefix = `${dashboardPath("catalog")}/`;
  if (!pathname.startsWith(prefix)) return { mode: "list" };

  const encodedEntryKey = pathname.slice(prefix.length);
  if (!encodedEntryKey || encodedEntryKey.includes("/")) return { mode: "list" };

  try {
    const entryKey = decodeURIComponent(encodedEntryKey);
    return isSafeEntryKey(entryKey) ? { mode: "detail", entryKey } : { mode: "list" };
  } catch {
    return { mode: "list" };
  }
}

function isSafeEntryKey(entryKey: string): boolean {
  return (
    entryKey.length > 0 &&
    entryKey !== "." &&
    entryKey !== ".." &&
    !entryKey.includes("/") &&
    !hasControlCharacter(entryKey)
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
