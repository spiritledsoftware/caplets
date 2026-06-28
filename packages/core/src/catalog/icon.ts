import { normalizeCatalogId, normalizeCatalogPath } from "./source";
import type { CatalogIcon, CatalogSourceIdentity, CatalogTrustLevel } from "./types";

type CatalogIconReference =
  | {
      type: "url";
      url: string;
    }
  | {
      type: "bundled";
      path: string;
    };

const imageExtensionPattern = /\.(?:svg|png|jpe?g|webp|gif|ico)$/iu;

export function isSafeCatalogIconValue(value: string): boolean {
  return catalogIconReferenceFromValue(value) !== undefined;
}

export function catalogIconReferenceFromValue(value: unknown): CatalogIconReference | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const urlReference = remoteIconReference(trimmed);
  if (urlReference) return urlReference;

  const bundledPath = bundledIconPath(trimmed);
  return bundledPath ? { type: "bundled", path: bundledPath } : undefined;
}

export function resolveCatalogIcon(input: {
  id: string;
  source: CatalogSourceIdentity;
  sourcePath: string;
  trustLevel: CatalogTrustLevel;
  resolvedRevision?: string | undefined;
  reference?: CatalogIconReference | undefined;
}): CatalogIcon | undefined {
  const reference = input.reference;
  if (!reference) return undefined;
  if (reference.type === "url") return { type: "url", url: reference.url };

  const sourceRelativePath = sourceRelativeBundledPath(input.sourcePath, reference.path);
  if (!sourceRelativePath) return undefined;

  if (input.trustLevel === "official" && input.source.repository === "spiritledsoftware/caplets") {
    return {
      type: "bundled",
      path: reference.path,
      url: officialCatalogIconUrl(input.id, reference.path),
    };
  }

  if (input.source.provider !== "github" || !input.resolvedRevision) return undefined;
  return {
    type: "bundled",
    path: reference.path,
    url: `https://raw.githubusercontent.com/${input.source.owner}/${input.source.repo}/${encodeURIComponent(input.resolvedRevision)}/${encodePath(sourceRelativePath)}`,
  };
}

export function officialCatalogIconUrl(capletId: string, iconPath: string): string {
  return `/catalog-icons/official/${encodeURIComponent(normalizeCatalogId(capletId))}/${encodeURIComponent(iconFileName(iconPath))}`;
}

export function sourceRelativeBundledPath(
  sourcePath: string,
  bundledIconPath: string,
): string | undefined {
  const normalizedSourcePath = normalizeCatalogPath(sourcePath);
  const normalizedIconPath = bundledIconPath.replace(/\\/g, "/").replace(/^\.\//u, "");
  const sourceDir = normalizedSourcePath.split("/").slice(0, -1).join("/");
  const sourceRelative = normalizeCatalogPath(
    [sourceDir, normalizedIconPath].filter(Boolean).join("/"),
  );
  if (!sourceRelative || sourceRelative.startsWith("../")) return undefined;
  return sourceRelative;
}

function remoteIconReference(value: string): CatalogIconReference | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  if (url.search || url.hash) return undefined;
  if (isPrivateHost(url.hostname.toLowerCase())) return undefined;
  if (!imageExtensionPattern.test(url.pathname)) return undefined;
  return { type: "url", url: url.href };
}

function bundledIconPath(value: string): string | undefined {
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value)) {
    return undefined;
  }
  if (value.startsWith("http:") || value.startsWith("https:")) return undefined;
  if (value.includes("?") || value.includes("#")) return undefined;
  const normalized = value.replace(/^\.\//u, "");
  const segments = normalized.split("/");
  if (
    !segments.length ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  if (!imageExtensionPattern.test(normalized)) return undefined;
  return normalized;
}

function iconFileName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "icon";
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function isPrivateHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return true;
  }
  if (
    hostname.startsWith("127.") ||
    hostname.startsWith("10.") ||
    hostname.startsWith("192.168.")
  ) {
    return true;
  }
  const match172 = /^172\.(\d{1,3})\./u.exec(hostname);
  return Boolean(match172?.[1] && Number(match172[1]) >= 16 && Number(match172[1]) <= 31);
}
