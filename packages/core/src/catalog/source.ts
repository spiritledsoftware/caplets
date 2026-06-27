import type {
  CatalogEntryKey,
  CatalogIndexingEligibility,
  CatalogIndexingIneligibleReason,
  CatalogSourceIdentity,
} from "./types";

const githubOwnerRepoPattern = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9._-]+$/iu;
const githubOwnerPattern = /^[a-z0-9][a-z0-9-]{0,38}$/iu;
const githubRepoPattern = /^[a-z0-9._-]+$/iu;

export function normalizeCatalogSourceIdentity(source: string): CatalogIndexingEligibility {
  const trimmed = source.trim();
  if (!trimmed) {
    return ineligible("empty_source");
  }
  if (looksLikeLocalPath(trimmed)) {
    return ineligible("local_path");
  }

  if (githubOwnerRepoPattern.test(trimmed)) {
    const [owner, repo] = trimmed.split("/");
    return eligibleGithub(owner, repo);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return ineligible("unsupported_source");
  }

  if (url.username || url.password) {
    return ineligible("credential_url");
  }
  const hostname = url.hostname.toLowerCase();
  if (isPrivateHost(hostname)) {
    return ineligible("private_host");
  }
  if (url.protocol !== "https:") {
    return ineligible("unsupported_source");
  }
  if (hostname !== "github.com") {
    return ineligible("unsupported_source");
  }

  if (url.search || url.hash) {
    return ineligible("unsupported_source");
  }

  const pathSegments = url.pathname.split("/").filter(Boolean);
  if (pathSegments.length !== 2) {
    return ineligible("unsupported_source");
  }
  const owner = pathSegments[0];
  const repoSegment = pathSegments[1];
  if (!owner || !repoSegment) {
    return ineligible("unsupported_source");
  }

  return eligibleGithub(owner, repoSegment.replace(/\.git$/iu, ""));
}

export function catalogEntryKey(input: {
  source: CatalogSourceIdentity;
  sourcePath: string;
  capletId: string;
}): CatalogEntryKey {
  return [
    input.source.provider,
    input.source.owner,
    input.source.repo,
    normalizeCatalogPath(input.sourcePath),
    normalizeCatalogId(input.capletId),
  ]
    .map(encodeURIComponent)
    .join(":");
}

export function normalizeCatalogPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\//u, "").toLowerCase();
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

export function normalizeCatalogId(id: string): string {
  return id.trim().toLowerCase();
}

function eligibleGithub(
  owner: string | undefined,
  repo: string | undefined,
): CatalogIndexingEligibility {
  const normalizedOwner = owner?.trim().toLowerCase();
  const normalizedRepo = repo
    ?.trim()
    .replace(/\.git$/iu, "")
    .toLowerCase();
  if (
    !normalizedOwner ||
    !normalizedRepo ||
    !githubOwnerPattern.test(normalizedOwner) ||
    !githubRepoPattern.test(normalizedRepo)
  ) {
    return ineligible("unsupported_source");
  }
  return {
    eligible: true,
    source: {
      provider: "github",
      owner: normalizedOwner,
      repo: normalizedRepo,
      repository: `${normalizedOwner}/${normalizedRepo}`,
      canonicalUrl: `https://github.com/${normalizedOwner}/${normalizedRepo}`,
    },
  };
}

function ineligible(reason: CatalogIndexingIneligibleReason): CatalogIndexingEligibility {
  return { eligible: false, reason, redactedSource: "[redacted]" };
}

function looksLikeLocalPath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.includes("\\")
  );
}

function isPrivateHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
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
