import {
  normalizeCatalogSourceIdentity,
  type CatalogIndexingEligibility,
} from "@caplets/core/catalog";

export function publicCatalogSourceEligibility(source: unknown): CatalogIndexingEligibility {
  if (typeof source !== "string") {
    return { eligible: false, reason: "unsupported_source", redactedSource: "[redacted]" };
  }
  return normalizeCatalogSourceIdentity(source);
}
