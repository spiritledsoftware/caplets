import { dashboardBasePath, dashboardPath } from "@/lib/paths";

export type CapletsLocation = { mode: "list" } | { mode: "detail"; capletId: string };

export type CapletsHistoryState = {
  capletsListHref: string;
};

export function capletsListHref(pathname?: string): string {
  return dashboardPath("caplets", pathname);
}

export function capletDetailHref(capletId: string, pathname?: string): string {
  return dashboardPath(`caplets/${encodeURIComponent(capletId)}`, pathname);
}

export function capletsLocationFromPath(pathname: string): CapletsLocation {
  const basePath = dashboardBasePath(pathname);
  const normalizedPathname = pathname.replace(/\/+$/u, "");
  const relativePath = normalizedPathname.startsWith(basePath)
    ? normalizedPathname.slice(basePath.length)
    : normalizedPathname;
  const segments = relativePath.replace(/^\/+|\/+$/gu, "").split("/");

  if (segments[0] !== "caplets" || segments.length !== 2 || !segments[1]) {
    return { mode: "list" };
  }

  try {
    const capletId = decodeURIComponent(segments[1]);
    return isSafeCapletId(capletId) ? { mode: "detail", capletId } : { mode: "list" };
  } catch {
    return { mode: "list" };
  }
}

export function safeCapletsReturnHref(candidate: string, fallback: string): string {
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return fallback;

  try {
    const parsed = new URL(candidate, "https://caplets.invalid");
    const location = capletsLocationFromPath(parsed.pathname);
    const canonicalPath =
      location.mode === "detail"
        ? capletDetailHref(location.capletId, fallback)
        : capletsListHref(fallback);
    return parsed.pathname === canonicalPath
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}

function isSafeCapletId(capletId: string): boolean {
  return (
    capletId.length > 0 &&
    !hasControlCharacter(capletId) &&
    !capletId.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
