import { createHash } from "node:crypto";
import { stableJsonStringify } from "../../stable-json";
import { CANONICAL_MODEL_VERSION, type ControlPlaneEntityKind } from "../model";

export const LEGACY_MAPPING_VERSION = 1 as const;

export type LegacyDomain =
  | "oauth-token"
  | "remote-server-state"
  | "dashboard-session"
  | "remote-profile"
  | "remote-profile-credential"
  | "cloud-auth"
  | "vault-value"
  | "vault-grant"
  | "project-binding-workspace"
  | "project-binding-lease"
  | "project-binding-receipt"
  | "operator-activity"
  | "host-setting"
  | "host-authority"
  | "global-provenance";

export type LegacyFieldRule = {
  source: string;
  destination: string;
  presence: "required" | "optional";
  empty: "preserve" | "reject";
  category:
    | "identity"
    | "reference"
    | "clock"
    | "authority"
    | "version"
    | "encryption"
    | "ownership"
    | "value"
    | "extensible-map"
    | "repeating-child";
};

export type LegacyDomainManifest = {
  domain: LegacyDomain;
  canonicalKind: ControlPlaneEntityKind;
  identityFields: readonly string[];
  fields: readonly LegacyFieldRule[];
  malformedPolicy: "quarantine";
  unknownFieldPolicy: "quarantine";
};

const required = (
  source: string,
  destination: string,
  category: LegacyFieldRule["category"],
): LegacyFieldRule => ({ source, destination, presence: "required", empty: "reject", category });
const optional = (
  source: string,
  destination: string,
  category: LegacyFieldRule["category"],
  empty: LegacyFieldRule["empty"] = "preserve",
): LegacyFieldRule => ({ source, destination, presence: "optional", empty, category });

export const LEGACY_MAPPING_MANIFEST: {
  version: typeof LEGACY_MAPPING_VERSION;
  domains: readonly LegacyDomainManifest[];
} = {
  version: LEGACY_MAPPING_VERSION,
  domains: [
    {
      domain: "oauth-token",
      canonicalKind: "oauth-token",
      identityFields: ["serverName"],
      fields: [
        required("serverName", "identity.serverName", "identity"),
        required("accessToken", "fields.accessToken", "encryption"),
        optional("refreshToken", "fields.refreshToken", "encryption"),
        optional("tokenType", "fields.tokenType", "value"),
        optional("scope", "fields.scope", "repeating-child"),
        optional("expiresAt", "fields.expiresAt", "clock"),
        optional("version", "fields.version", "version"),
        optional("keyVersion", "fields.keyVersion", "encryption"),
        optional("ownerId", "fields.ownerId", "ownership"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "remote-server-state",
      canonicalKind: "client",
      identityFields: ["serverId"],
      fields: [
        required("serverId", "identity.serverId", "identity"),
        optional("version", "fields.version", "version"),
        optional("pairingCodes", "children.pairingCodes", "repeating-child"),
        optional("clients", "children.clients", "repeating-child"),
        optional("pendingLogins", "children.pendingApprovals", "repeating-child"),
        optional("supersededTokens", "children.supersededTokens", "repeating-child"),
        optional("encryptedReplayRecords", "children.encryptedReplayRecords", "encryption"),
        optional("authorityVersion", "fields.authorityVersion", "authority"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "dashboard-session",
      canonicalKind: "dashboard-session",
      identityFields: ["id"],
      fields: [
        required("id", "identity.id", "identity"),
        required("clientId", "fields.clientId", "reference"),
        required("createdAt", "fields.createdAt", "clock"),
        required("expiresAt", "fields.expiresAt", "clock"),
        optional("lastSeenAt", "fields.lastSeenAt", "clock"),
        optional("revokedAt", "fields.revokedAt", "clock"),
        optional("verifier", "fields.verifier", "encryption"),
        optional("version", "fields.version", "version"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "remote-profile",
      canonicalKind: "host-setting",
      identityFields: ["id"],
      fields: [
        required("id", "identity.id", "identity"),
        required("name", "fields.name", "value"),
        required("url", "fields.url", "value"),
        optional("selectedWorkspace", "fields.selectedWorkspace", "reference"),
        optional("createdAt", "fields.createdAt", "clock"),
        optional("updatedAt", "fields.updatedAt", "clock"),
        optional("ownerId", "fields.ownerId", "ownership"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "remote-profile-credential",
      canonicalKind: "credential",
      identityFields: ["profileId"],
      fields: [
        required("profileId", "identity.profileId", "identity"),
        required("credential", "fields.credential", "encryption"),
        optional("expiresAt", "fields.expiresAt", "clock"),
        optional("keyVersion", "fields.keyVersion", "encryption"),
        optional("ownerId", "fields.ownerId", "ownership"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "cloud-auth",
      canonicalKind: "credential",
      identityFields: ["profileId"],
      fields: [
        required("profileId", "identity.profileId", "identity"),
        required("accessToken", "fields.accessToken", "encryption"),
        optional("refreshToken", "fields.refreshToken", "encryption"),
        optional("expiresAt", "fields.expiresAt", "clock"),
        optional("workspace", "fields.workspace", "reference"),
        optional("version", "fields.version", "version"),
        optional("keyVersion", "fields.keyVersion", "encryption"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "vault-value",
      canonicalKind: "vault-value",
      identityFields: ["referenceName"],
      fields: [
        required("referenceName", "identity.referenceName", "identity"),
        required("version", "fields.recordVersion", "version"),
        required("ciphertext", "fields.ciphertext", "encryption"),
        required("iv", "fields.iv", "encryption"),
        optional("authTag", "fields.authTag", "encryption"),
        required("keyVersion", "fields.keyVersion", "encryption"),
        optional("aadVersion", "fields.aadVersion", "encryption"),
        optional("updatedAt", "fields.updatedAt", "clock"),
        optional("ownerId", "fields.ownerId", "ownership"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "vault-grant",
      canonicalKind: "vault-grant",
      identityFields: ["referenceName", "capletId", "originKind", "originPath"],
      fields: [
        required("referenceName", "identity.referenceName", "identity"),
        required("capletId", "identity.capletId", "reference"),
        required("originKind", "identity.originKind", "identity"),
        required("originPath", "identity.originPath", "identity"),
        required("storedKey", "fields.storedKey", "encryption"),
        optional("createdAt", "fields.createdAt", "clock"),
        optional("updatedAt", "fields.updatedAt", "clock"),
        optional("ownerId", "fields.ownerId", "ownership"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "project-binding-workspace",
      canonicalKind: "project-binding-workspace",
      identityFields: ["workspaceId"],
      fields: [
        required("workspaceId", "identity.workspaceId", "identity"),
        optional("projectId", "fields.projectId", "reference"),
        optional("state", "fields.state", "value"),
        optional("metadata", "fields.metadata", "extensible-map"),
        optional("createdAt", "fields.createdAt", "clock"),
        optional("updatedAt", "fields.updatedAt", "clock"),
        optional("version", "fields.version", "version"),
        optional("ownerId", "fields.ownerId", "ownership"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "project-binding-lease",
      canonicalKind: "project-binding-lease",
      identityFields: ["workspaceId", "leaseId"],
      fields: [
        required("workspaceId", "identity.workspaceId", "reference"),
        required("leaseId", "identity.leaseId", "identity"),
        required("holderId", "fields.holderId", "ownership"),
        required("expiresAt", "fields.expiresAt", "clock"),
        optional("fence", "fields.fence", "authority"),
        optional("createdAt", "fields.createdAt", "clock"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "project-binding-receipt",
      canonicalKind: "project-binding-receipt",
      identityFields: ["workspaceId", "receiptId"],
      fields: [
        required("workspaceId", "identity.workspaceId", "reference"),
        required("receiptId", "identity.receiptId", "identity"),
        required("status", "fields.status", "value"),
        optional("setupHash", "fields.setupHash", "reference"),
        optional("detail", "fields.detail", "extensible-map"),
        required("createdAt", "fields.createdAt", "clock"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "operator-activity",
      canonicalKind: "operator-activity",
      identityFields: ["id"],
      fields: [
        required("id", "identity.id", "identity"),
        required("timestamp", "fields.timestamp", "clock"),
        required("actor", "fields.actor", "ownership"),
        required("action", "fields.action", "value"),
        optional("target", "fields.target", "reference"),
        optional("details", "fields.redactedDetails", "extensible-map"),
        optional("authorityVersion", "fields.authorityVersion", "authority"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "host-setting",
      canonicalKind: "host-setting",
      identityFields: ["key"],
      fields: [
        required("key", "identity.key", "identity"),
        optional("value", "fields.value", "value"),
        optional("version", "fields.version", "version"),
        optional("updatedAt", "fields.updatedAt", "clock"),
        optional("ownerId", "fields.ownerId", "ownership"),
        optional("effective", "fields.effective", "authority"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "host-authority",
      canonicalKind: "authority-version",
      identityFields: ["logicalHostId", "storeId"],
      fields: [
        required("logicalHostId", "identity.logicalHostId", "identity"),
        required("storeId", "identity.storeId", "identity"),
        required("operationNamespace", "fields.operationNamespace", "authority"),
        required("state", "fields.state", "authority"),
        required("generation", "fields.generation", "version"),
        optional("transferId", "fields.transferId", "reference"),
        optional("updatedAt", "fields.updatedAt", "clock"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "global-provenance",
      canonicalKind: "caplet-provenance",
      identityFields: ["capletId"],
      fields: [
        required("capletId", "identity.capletId", "identity"),
        required("source", "fields.source", "value"),
        required("contentHash", "fields.contentHash", "reference"),
        optional("resolvedRevision", "fields.resolvedRevision", "reference"),
        optional("runtimeFingerprint", "fields.runtimeFingerprint", "reference"),
        optional("riskSummary", "fields.riskSummary", "extensible-map"),
        optional("installedAt", "fields.installedAt", "clock"),
        optional("version", "fields.version", "version"),
        optional("ownerId", "fields.ownerId", "ownership"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
  ],
};

export type LegacyCanonicalRecord = {
  modelVersion: typeof CANONICAL_MODEL_VERSION;
  kind: ControlPlaneEntityKind;
  identity: Record<string, unknown>;
  fields: Record<string, unknown>;
};

export type LegacyMappingResult =
  | {
      status: "accepted";
      domain: LegacyDomain;
      canonical: LegacyCanonicalRecord;
      fieldDestinations: Record<string, string>;
    }
  | {
      status: "quarantined";
      domain: LegacyDomain;
      reason:
        | "malformed-record"
        | "unsupported-field"
        | "missing-required-field"
        | "empty-required-field";
      sourcePath: string;
      rawDigest: string;
      fields: string[];
    };

export function mapLegacyRecord(
  domain: LegacyDomain,
  raw: unknown,
  source: { sourcePath: string },
): LegacyMappingResult {
  const manifest = LEGACY_MAPPING_MANIFEST.domains.find((candidate) => candidate.domain === domain);
  if (!manifest) throw new Error(`No legacy mapping manifest for ${domain}`);
  if (!isObject(raw)) return quarantine(domain, "malformed-record", source.sourcePath, raw);
  const bySource = Object.fromEntries(manifest.fields.map((field) => [field.source, field]));
  const unsupported = Object.keys(raw).filter((key) => !bySource[key]);
  if (unsupported.length) return quarantine(domain, "unsupported-field", source.sourcePath, raw);
  for (const rule of manifest.fields) {
    if (rule.presence === "required" && !(rule.source in raw))
      return quarantine(domain, "missing-required-field", source.sourcePath, raw);
    if (rule.empty === "reject" && (raw[rule.source] === "" || raw[rule.source] === null))
      return quarantine(domain, "empty-required-field", source.sourcePath, raw);
    if (rule.source in raw && !validLegacyField(rule, raw[rule.source])) {
      return quarantine(domain, "malformed-record", source.sourcePath, raw);
    }
  }
  const identity: Record<string, unknown> = {};
  const fields: Record<string, unknown> = {};
  const fieldDestinations: Record<string, string> = {};
  for (const [sourceField, value] of Object.entries(raw)) {
    const rule = bySource[sourceField]!;
    fieldDestinations[sourceField] = rule.destination;
    if (rule.destination.startsWith("identity."))
      identity[rule.destination.slice("identity.".length)] = value;
    else fields[rule.destination.replace(/^(?:fields|children)\./u, "")] = value;
  }
  return {
    status: "accepted",
    domain,
    canonical: {
      modelVersion: CANONICAL_MODEL_VERSION,
      kind: manifest.canonicalKind,
      identity,
      fields,
    },
    fieldDestinations,
  };
}

function validLegacyField(rule: LegacyFieldRule, value: unknown): boolean {
  if (value === undefined) return rule.presence === "optional";
  if (rule.category === "clock") {
    return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
  }
  if (rule.category === "version") {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  }
  if (rule.category === "identity") {
    return (
      (typeof value === "string" && value.length > 0) ||
      (typeof value === "number" && Number.isSafeInteger(value))
    );
  }
  if (rule.category === "extensible-map") return isObject(value);
  if (rule.category === "repeating-child") return Array.isArray(value) || isObject(value);
  if (rule.category === "encryption") {
    return (
      (typeof value === "string" && value.length > 0) ||
      (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
      isObject(value)
    );
  }
  return value !== undefined;
}

function quarantine(
  domain: LegacyDomain,
  reason: Extract<LegacyMappingResult, { status: "quarantined" }>["reason"],
  sourcePath: string,
  raw: unknown,
): LegacyMappingResult {
  const serialized = stableJsonStringify(raw);
  return {
    status: "quarantined",
    domain,
    reason,
    sourcePath,
    rawDigest: createHash("sha256").update(serialized).digest("hex"),
    fields: isObject(raw) ? Object.keys(raw).sort() : [],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
