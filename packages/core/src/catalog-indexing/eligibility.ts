import {
  catalogEntryKey,
  normalizeCatalogSourceIdentity,
  type CatalogIndexingStatus,
} from "../catalog";
import type {
  CatalogIndexingCandidate,
  CatalogIndexingPayload,
  CatalogIndexingResult,
} from "./payload";

export type CatalogIndexingLockEntry = {
  id: string;
  source:
    | {
        type: "git";
        repository: string;
        path: string;
        resolvedRevision?: string | undefined;
      }
    | {
        type: "local";
        path?: string | undefined;
        portability?: string | undefined;
      };
  installedHash: string;
};

const officialRepository = "spiritledsoftware/caplets";

export function catalogIndexingPayloadForLockEntry(
  entry: CatalogIndexingLockEntry,
): CatalogIndexingPayload | CatalogIndexingResult {
  const candidate = catalogIndexingCandidateForLockEntry(entry);
  if ("status" in candidate) return candidate;
  return {
    source: candidate.source.repository,
    capletId: entry.id,
    sourcePath: candidate.sourcePath,
    resolvedRevision: candidate.resolvedRevision,
    contentHash: candidate.installedHash,
    entryKey: candidate.entryKey,
  };
}

export function catalogIndexingCandidateForLockEntry(
  entry: CatalogIndexingLockEntry,
): CatalogIndexingCandidate | CatalogIndexingResult {
  if (entry.source.type !== "git") {
    return skip("ineligible", "not_public");
  }
  const source = normalizeCatalogSourceIdentity(entry.source.repository);
  if (!source.eligible) {
    return skip("ineligible", source.reason);
  }
  if (source.source.repository === officialRepository) {
    return skip("already_current", "official_seed");
  }
  if (!entry.source.resolvedRevision) {
    return skip("revision_unavailable", "revision_unavailable");
  }
  const sourcePath = catalogSourcePathForLockPath(entry.source.path);
  const entryKey = catalogEntryKey({
    source: source.source,
    sourcePath,
    capletId: entry.id,
  });
  return {
    id: entry.id,
    source: source.source,
    sourcePath,
    resolvedRevision: entry.source.resolvedRevision,
    installedHash: entry.installedHash,
    entryKey,
  };
}

function catalogSourcePathForLockPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//u, "")
    .replace(/^caplets\//iu, "");
}

function skip(status: CatalogIndexingStatus, reason: string): CatalogIndexingResult {
  return { status, reason };
}
