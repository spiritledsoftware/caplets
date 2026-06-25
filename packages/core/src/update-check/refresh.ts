import { fetchPublicCapletsMetadata, UpdateRegistryError } from "./registry";
import {
  acquireUpdateRefreshLock,
  readUpdateMetadataCache,
  releaseUpdateRefreshLock,
  UPDATE_CHECK_CACHE_TTL_MS,
  UPDATE_CHECK_FETCH_TIMEOUT_MS,
  UPDATE_CHECK_MAX_RESPONSE_BYTES,
  UPDATE_CHECK_MAX_STALE_MS,
  UPDATE_CHECK_NEGATIVE_TTL_MS,
  UPDATE_CHECK_REGISTRY_URL,
  writeUpdateMetadataCache,
  type UpdateCheckPathsOptions,
  type UpdateMetadataCacheEntry,
} from "./state";

export type RefreshUpdateMetadataOptions = UpdateCheckPathsOptions & {
  fetcher?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
  now?: number | undefined;
  timeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
};

export async function refreshUpdateMetadata(
  options: RefreshUpdateMetadataOptions = {},
): Promise<"refreshed" | "skipped" | "failed"> {
  const now = options.now ?? Date.now();
  if (!acquireUpdateRefreshLock({ ...options, now })) return "skipped";

  try {
    const metadata = await fetchPublicCapletsMetadata({
      fetcher: options.fetcher,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? UPDATE_CHECK_FETCH_TIMEOUT_MS,
      maxResponseBytes: options.maxResponseBytes ?? UPDATE_CHECK_MAX_RESPONSE_BYTES,
    });
    const entry: UpdateMetadataCacheEntry = {
      status: "positive",
      fetchedAt: now,
      expiresAt: now + UPDATE_CHECK_CACHE_TTL_MS,
      staleUntil: now + UPDATE_CHECK_CACHE_TTL_MS + UPDATE_CHECK_MAX_STALE_MS,
      source: UPDATE_CHECK_REGISTRY_URL,
      metadata,
    };
    writeUpdateMetadataCache(entry, options);
    return "refreshed";
  } catch (error) {
    const existing = readUpdateMetadataCache({ ...options, now });
    if (existing?.status === "positive" && existing.usable) return "failed";
    writeUpdateMetadataCache(
      {
        status: "negative",
        fetchedAt: now,
        expiresAt: now + UPDATE_CHECK_NEGATIVE_TTL_MS,
        reason: error instanceof UpdateRegistryError ? error.reason : "error",
      },
      options,
    );
    return "failed";
  } finally {
    releaseUpdateRefreshLock(options);
  }
}
