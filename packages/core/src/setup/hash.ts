import type { CapletRuntimeFingerprint } from "../caplet-source/runtime-fingerprint";

export const LIVE_ONLY_SETUP_CONTENT_HASH = "live-only";

export function capletSetupContentHash(
  runtimeFingerprint:
    | Pick<CapletRuntimeFingerprint, "fingerprint" | "persistenceEligible" | "valid">
    | undefined,
): string {
  return runtimeFingerprint?.valid === true && runtimeFingerprint.persistenceEligible === true
    ? runtimeFingerprint.fingerprint
    : LIVE_ONLY_SETUP_CONTENT_HASH;
}
