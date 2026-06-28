import type { CatalogEntry, CatalogIndexingStatus, CatalogSourceIdentity } from "../catalog";

export type CatalogIndexingResult = {
  status: CatalogIndexingStatus;
  entryKey?: string | undefined;
  reason?: string | undefined;
};

export type CatalogIndexingPayload = {
  source: string;
  capletId: string;
  sourcePath: string;
  resolvedRevision?: string | undefined;
  contentHash?: string | undefined;
  entryKey: string;
  entry?: CatalogEntry | undefined;
};

export type CatalogIndexingCandidate = {
  id: string;
  source: CatalogSourceIdentity;
  sourcePath: string;
  resolvedRevision: string;
  installedHash: string;
  entryKey: string;
};
