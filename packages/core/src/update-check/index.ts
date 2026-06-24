export { isUpdateCheckDisabled, isUpdateNoticeStderrOptIn } from "./control";
export { classifyUpdateNoticeEligibility } from "./eligibility";
export { maybePrintUpdateNotice } from "./notice";
export { fetchPublicCapletsMetadata } from "./registry";
export { refreshUpdateMetadata } from "./refresh";
export {
  UPDATE_CHECK_ACCEPT_HEADER,
  UPDATE_CHECK_CACHE_TTL_MS,
  UPDATE_CHECK_FETCH_TIMEOUT_MS,
  UPDATE_CHECK_LOCK_TTL_MS,
  UPDATE_CHECK_MAX_RESPONSE_BYTES,
  UPDATE_CHECK_MAX_STALE_MS,
  UPDATE_CHECK_NEGATIVE_TTL_MS,
  UPDATE_CHECK_NOTICE_REPEAT_MS,
  UPDATE_CHECK_PACKAGE_NAME,
  UPDATE_CHECK_REGISTRY_URL,
  acquireUpdateRefreshLock,
  readUpdateMetadataCache,
  readUpdateNoticeState,
  recordUpdateNoticeShown,
  releaseUpdateRefreshLock,
  shouldShowUpdateNotice,
  updateCheckCacheDir,
  updateCheckStateDir,
  updateMetadataCachePath,
  updateNoticeStatePath,
  updateRefreshLockPath,
  writePrivateJson,
  writeUpdateMetadataCache,
} from "./state";
export { findAvailableUpdate } from "./version";
export type { PackageVersionMetadata } from "./version";
