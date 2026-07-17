import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { stableJsonStringify } from "../../stable-json";
import { CANONICAL_MODEL_VERSION, canonicalFields, type ControlPlaneEntityKind } from "../model";

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
  codec?: "utf8-bytes" | "base64url-bytes" | "daemon-url";
};

export type LegacyDomainManifest = {
  domain: LegacyDomain;
  canonicalKind: ControlPlaneEntityKind;
  identityFields: readonly string[];
  syntheticIdentity?: Readonly<Record<string, string>>;
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
const encoded = (
  source: string,
  destination: string,
  presence: LegacyFieldRule["presence"],
  codec: NonNullable<LegacyFieldRule["codec"]>,
): LegacyFieldRule => ({
  source,
  destination,
  presence,
  empty: presence === "required" ? "reject" : "preserve",
  category: "encryption",
  codec,
});

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
        required("server", "identity.serverName", "identity"),
        optional("authType", "fields.authType", "value"),
        encoded("accessToken", "fields.accessCiphertext", "required", "utf8-bytes"),
        encoded("refreshToken", "fields.refreshCiphertext", "optional", "utf8-bytes"),
        optional("tokenType", "fields.tokenType", "value"),
        optional("scope", "fields.scope", "value"),
        optional("expiresAt", "fields.expiresAt", "clock"),
        encoded("idToken", "fields.idTokenCiphertext", "optional", "utf8-bytes"),
        optional("issuer", "fields.issuer", "value"),
        optional("subject", "fields.subject", "value"),
        optional("clientId", "fields.clientId", "reference"),
        encoded("clientSecret", "fields.clientSecretCiphertext", "optional", "utf8-bytes"),
        optional("protectedResourceOrigin", "fields.protectedResourceOrigin", "value"),
        optional("metadata", "fields.metadata", "extensible-map"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "remote-server-state",
      canonicalKind: "client",
      identityFields: ["clientId"],
      fields: [
        required("serverId", "identity.clientId", "identity"),
        required("role", "fields.role", "value"),
        required("status", "fields.status", "value"),
        required("hostUrl", "fields.hostUrl", "value"),
        required("clientLabel", "fields.clientLabel", "value"),
        optional("lastAuthenticatedAt", "fields.lastAuthenticatedAt", "clock"),
        optional("revokedAt", "fields.revokedAt", "clock"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "dashboard-session",
      canonicalKind: "dashboard-session",
      identityFields: ["sessionId"],
      fields: [
        required("id", "identity.sessionId", "identity"),
        required("clientId", "fields.clientId", "reference"),
        required("createdAt", "fields.createdAt", "clock"),
        required("expiresAt", "fields.expiresAt", "clock"),
        required("absoluteExpiresAt", "fields.absoluteExpiresAt", "clock"),
        required("idleExpiresAt", "fields.idleExpiresAt", "clock"),
        optional("lastSeenAt", "fields.lastSeenAt", "clock"),
        encoded("verifier", "fields.verifier", "required", "utf8-bytes"),
        encoded("csrfVerifier", "fields.csrfVerifier", "required", "utf8-bytes"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "remote-profile",
      canonicalKind: "credential",
      identityFields: ["credentialId"],
      fields: [
        required("id", "identity.credentialId", "identity"),
        required("name", "fields.purpose", "value"),
        required("url", "fields.protection", "value"),
        optional("selectedWorkspace", "fields.workspace", "reference"),
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
      identityFields: ["credentialId"],
      fields: [
        required("profileId", "identity.credentialId", "identity"),
        encoded("credential", "fields.verifierOrCiphertext", "required", "utf8-bytes"),
        optional("expiresAt", "fields.expiresAt", "clock"),
        optional("keyVersion", "fields.keyVersion", "version"),
        optional("ownerId", "fields.ownerId", "ownership"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "cloud-auth",
      canonicalKind: "credential",
      identityFields: ["credentialId"],
      fields: [
        required("profileId", "identity.credentialId", "identity"),
        encoded("accessToken", "fields.accessCiphertext", "required", "utf8-bytes"),
        encoded("refreshToken", "fields.refreshCiphertext", "optional", "utf8-bytes"),
        optional("expiresAt", "fields.expiresAt", "clock"),
        optional("workspace", "fields.workspace", "reference"),
        optional("version", "fields.recordVersion", "version"),
        optional("keyVersion", "fields.keyVersion", "version"),
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
        required("algorithm", "fields.algorithm", "value"),
        encoded("nonce", "fields.nonce", "required", "base64url-bytes"),
        encoded("ciphertext", "fields.ciphertext", "required", "base64url-bytes"),
        encoded("authTag", "fields.authTag", "required", "base64url-bytes"),
        required("valueBytes", "fields.valueBytes", "version"),
        required("createdAt", "fields.createdAt", "clock"),
        required("updatedAt", "fields.updatedAt", "clock"),
        required("keyVersion", "fields.keyVersion", "version"),
        optional("ownerId", "fields.ownerId", "ownership"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "vault-grant",
      canonicalKind: "vault-grant",
      identityFields: ["referenceName", "capletId", "origin"],
      fields: [
        required("referenceName", "identity.referenceName", "identity"),
        required("capletId", "identity.capletId", "reference"),
        required("origin", "identity.origin", "extensible-map"),
        required("storedKey", "fields.storedKey", "value"),
        required("createdAt", "fields.createdAt", "clock"),
        required("updatedAt", "fields.updatedAt", "clock"),
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
        optional("version", "fields.workspaceVersion", "version"),
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
      identityFields: ["activityId"],
      fields: [
        required("id", "identity.activityId", "identity"),
        required("createdAt", "fields.occurredAt", "clock"),
        required("actorClientId", "fields.actorId", "ownership"),
        required("action", "fields.action", "value"),
        required("outcome", "fields.outcome", "value"),
        required("target", "fields.target", "extensible-map"),
        optional("metadata", "fields.redactedDetail", "extensible-map"),
      ],
      malformedPolicy: "quarantine",
      unknownFieldPolicy: "quarantine",
    },
    {
      domain: "host-setting",
      canonicalKind: "host-setting",
      identityFields: ["key"],
      syntheticIdentity: { key: "native.daemon-url" },
      fields: [
        required("version", "fields.aggregateVersion", "version"),
        required("source", "fields.value.source", "value"),
        { ...required("daemon", "fields.value.url", "extensible-map"), codec: "daemon-url" },
        required("updatedAt", "fields.updatedAt", "clock"),
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
        required("state", "fields.bindingState", "authority"),
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
        optional("version", "fields.aggregateVersion", "version"),
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

export const LEGACY_CHILD_GRAPH_DESTINATIONS: Readonly<Record<string, ControlPlaneEntityKind>> = {
  "children.pairingCodes": "credential",
  "children.clients": "client",
  "children.pendingApprovals": "pending-approval",
  "children.supersededTokens": "credential",
  "children.encryptedReplayRecords": "credential",
};

export function assertLegacyMappingManifestAligned(): void {
  for (const domain of LEGACY_MAPPING_MANIFEST.domains) {
    const fields = new Set(
      canonicalFields(domain.canonicalKind).map((definition) => definition.name),
    );
    const destinations = new Set<string>();
    for (const rule of domain.fields) {
      if (destinations.has(rule.destination)) {
        throw new Error(`Legacy ${domain.domain} destination ${rule.destination} is ambiguous`);
      }
      destinations.add(rule.destination);
      if (rule.destination.startsWith("children.")) {
        if (!LEGACY_CHILD_GRAPH_DESTINATIONS[rule.destination]) {
          throw new Error(
            `Legacy ${domain.domain} child destination ${rule.destination} is unknown`,
          );
        }
        continue;
      }
      const fieldName = rule.destination.replace(/^(?:identity|fields)\./u, "").split(".")[0]!;
      if (!fields.has(fieldName)) {
        throw new Error(`Legacy ${domain.domain} destination ${rule.destination} is not canonical`);
      }
    }
    const suppliedIdentity = new Set([
      ...Object.keys(domain.syntheticIdentity ?? {}),
      ...domain.fields
        .filter((rule) => rule.destination.startsWith("identity."))
        .map((rule) => rule.destination.slice("identity.".length)),
    ]);
    for (const identityField of domain.identityFields) {
      if (!suppliedIdentity.has(identityField)) {
        throw new Error(`Legacy ${domain.domain} identity ${identityField} has no source`);
      }
    }
  }
}

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
  const identity: Record<string, unknown> = { ...manifest.syntheticIdentity };
  const fields: Record<string, unknown> = {};
  const fieldDestinations: Record<string, string> = {};
  for (const [sourceField, value] of Object.entries(raw)) {
    const rule = bySource[sourceField]!;
    fieldDestinations[sourceField] = rule.destination;
    const decoded = decodeLegacyValue(rule, value);
    if (rule.destination.startsWith("identity.")) {
      identity[rule.destination.slice("identity.".length)] = decoded;
    } else {
      setLegacyDestination(
        fields,
        rule.destination.replace(/^(?:fields|children)\./u, ""),
        decoded,
      );
    }
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
function setLegacyDestination(
  target: Record<string, unknown>,
  destination: string,
  value: unknown,
): void {
  const path = destination.split(".");
  let current = target;
  for (const segment of path.slice(0, -1)) {
    const nested = current[segment];
    if (nested !== undefined && !isObject(nested)) {
      throw new Error(`Legacy destination ${destination} conflicts with another field`);
    }
    const next = nested ?? {};
    current[segment] = next;
    current = next as Record<string, unknown>;
  }
  current[path.at(-1)!] = value;
}

function decodeLegacyValue(rule: LegacyFieldRule, value: unknown): unknown {
  if (!rule.codec) return value;
  if (rule.codec === "daemon-url") {
    if (!isObject(value) || typeof value.url !== "string") {
      throw new Error(`Legacy ${rule.source} must contain a URL`);
    }
    return value.url;
  }
  if (typeof value !== "string") throw new Error(`Legacy ${rule.source} must be a string`);
  return rule.codec === "utf8-bytes"
    ? new TextEncoder().encode(value)
    : Uint8Array.from(Buffer.from(value, "base64url"));
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
