import { dashboardBasePath, dashboardPath } from "@/lib/paths";

export type CatalogLocation = { mode: "list" } | { mode: "detail"; entryKey: string };

export type CatalogHistoryState = {
  catalogListHref: string;
};

export function catalogListHref(pathname?: string): string {
  return dashboardPath("catalog", pathname);
}

export function catalogDetailHref(entryKey: string, pathname?: string): string {
  return dashboardPath(`catalog/${encodeURIComponent(entryKey)}`, pathname);
}

export function catalogLocationFromPath(pathname: string): CatalogLocation {
  const basePath = dashboardBasePath(pathname);
  const normalizedPathname = pathname.replace(/\/+$/u, "");
  const relativePath = normalizedPathname.startsWith(basePath)
    ? normalizedPathname.slice(basePath.length)
    : normalizedPathname;
  const segments = relativePath.replace(/^\/+|\/+$/gu, "").split("/");

  if (segments[0] !== "catalog" || segments.length !== 2 || !segments[1]) {
    return { mode: "list" };
  }

  try {
    const entryKey = decodeURIComponent(segments[1]);
    return isSafeEntryKey(entryKey) ? { mode: "detail", entryKey } : { mode: "list" };
  } catch {
    return { mode: "list" };
  }
}

function isSafeEntryKey(entryKey: string): boolean {
  return (
    entryKey.length > 0 &&
    !hasControlCharacter(entryKey) &&
    !entryKey.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
