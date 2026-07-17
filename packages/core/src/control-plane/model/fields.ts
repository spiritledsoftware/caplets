import { CANONICAL_MODEL_VERSION, type ControlPlaneEntityKind } from "./index";

export type CanonicalFieldType =
  | "id"
  | "string"
  | "timestamp"
  | "version"
  | "boolean"
  | "hash"
  | "bytes"
  | "json";
export type CanonicalFieldDefinition = {
  name: string;
  type: CanonicalFieldType;
  required: boolean;
  repeating?: boolean;
};

const field = (
  name: string,
  type: CanonicalFieldType,
  required = true,
  repeating = false,
): CanonicalFieldDefinition => ({
  name,
  type,
  required,
  ...(repeating ? { repeating: true } : {}),
});
const id = (name: string, required = true): CanonicalFieldDefinition => field(name, "id", required);
const text = (name: string, required = true): CanonicalFieldDefinition =>
  field(name, "string", required);
const clock = (name: string, required = true): CanonicalFieldDefinition =>
  field(name, "timestamp", required);
const version = (name: string, required = true): CanonicalFieldDefinition =>
  field(name, "version", required);
const json = (name: string, required = false): CanonicalFieldDefinition =>
  field(name, "json", required);

const COMMON_FIELDS: readonly CanonicalFieldDefinition[] = [
  version("modelVersion"),
  id("id"),
  id("logicalHostId"),
  id("storeId"),
  clock("createdAt"),
  clock("updatedAt"),
  version("aggregateVersion"),
  version("authorityVersion"),
  version("effectiveVersion"),
  version("securityVersion"),
];

export const CANONICAL_FIELD_CHECKLIST: Record<
  ControlPlaneEntityKind,
  readonly CanonicalFieldDefinition[]
> = {
  "host-setting": [
    text("key"),
    json("value", true),
    text("ownership"),
    text("activation"),
    field("effective", "boolean"),
    id("provenanceId"),
    text("provenanceSourceKind"),
    json("provenanceSource", true),
    field("provenanceContentHash", "hash"),
    field("provenanceRuntimeFingerprint", "hash", false),
    clock("provenanceInstalledAt", false),
    text("provenanceResolvedRevision", false),
    json("provenanceRiskSummary"),
    id("provenanceOwnerId", false),
  ],
  caplet: [
    text("name"),
    text("description"),
    text("ownership"),
    text("activation"),
    field("effective", "boolean"),
    text("updateState"),
    id("portableAggregateId"),
    id("installationProvenanceId", false),
  ],
  "caplet-provenance": [
    id("capletId"),
    text("sourceKind"),
    json("source", true),
    field("contentHash", "hash"),
    field("runtimeFingerprint", "hash", false),
    clock("installedAt", false),
    text("resolvedRevision", false),
    json("riskSummary"),
    id("ownerId", false),
  ],
  "operation-namespace": [
    id("namespaceId"),
    version("generation"),
    text("state"),
    id("replacedBy", false),
    clock("replacedAt", false),
  ],
  "operation-reservation": [
    id("operationId"),
    id("namespaceId"),
    text("target"),
    id("actorId"),
    field("requestHash", "hash"),
    text("state"),
    clock("reservedAt"),
    clock("committedAt", false),
  ],
  "operation-outcome": [
    id("operationId"),
    text("operationClass"),
    field("requestHash", "hash"),
    field("receiptHash", "hash"),
    json("receipt", true),
    version("resultAggregateVersion"),
    version("resultAuthorityVersion"),
    version("resultEffectiveVersion"),
    text("convergenceClass"),
  ],
  "operation-tombstone": [
    id("operationId"),
    id("namespaceId"),
    text("target"),
    field("requestHash", "hash"),
    text("reason"),
    clock("consumedAt"),
  ],
  confirmation: [
    id("confirmationId"),
    text("action"),
    text("authorityToken"),
    field("inventoryHash", "hash"),
    json("affectedInventory", true),
    clock("expiresAt"),
    text("consequences"),
    text("state"),
    clock("consumedAt", false),
  ],
  "oauth-token": [
    text("serverName"),
    id("ownerId", false),
    field("accessCiphertext", "bytes"),
    field("nonce", "bytes"),
    field("authTag", "bytes"),
    field("refreshCiphertext", "bytes", false),
    text("authType", false),
    field("idTokenCiphertext", "bytes", false),
    text("issuer", false),
    text("subject", false),
    id("clientId", false),
    field("clientSecretCiphertext", "bytes", false),
    text("protectedResourceOrigin", false),
    json("metadata"),
    text("tokenType", false),
    json("scope"),
    clock("expiresAt", false),
    version("keyVersion"),
    version("recordVersion"),
    text("algorithm"),
    version("aadVersion"),
  ],
  client: [
    id("clientId"),
    text("role"),
    text("status"),
    text("hostUrl"),
    text("clientLabel"),
    id("ownerId", false),
    clock("lastAuthenticatedAt", false),
    clock("revokedAt", false),
  ],
  credential: [
    id("credentialId"),
    id("clientId", false),
    text("purpose"),
    text("protection"),
    field("verifierOrCiphertext", "bytes"),
    text("algorithm"),
    version("verifierVersion"),
    field("accessCiphertext", "bytes", false),
    field("refreshCiphertext", "bytes", false),
    text("workspace", false),
    version("recordVersion", false),
    id("ownerId", false),
    version("keyVersion"),
    clock("expiresAt", false),
    id("refreshFamilyId", false),
    clock("consumedAt", false),
  ],
  "pending-approval": [
    id("approvalId"),
    id("clientId", false),
    field("verifier", "bytes"),
    text("purpose"),
    text("algorithm"),
    version("verifierVersion"),
    version("keyVersion"),
    text("requestedRole", false),
    text("grantedRole", false),
    text("hostUrl", false),
    text("clientLabel", false),
    id("actorId", false),
    text("state"),
    clock("expiresAt"),
    clock("consumedAt", false),
  ],
  "dashboard-session": [
    id("sessionId"),
    id("clientId"),
    field("verifier", "bytes"),
    text("algorithm"),
    version("verifierVersion"),
    version("keyVersion"),
    field("csrfVerifier", "bytes"),
    text("csrfAlgorithm"),
    version("csrfKeyVersion"),
    clock("absoluteExpiresAt"),
    clock("idleExpiresAt"),
    clock("expiresAt"),
    clock("lastSeenAt", false),
    clock("revokedAt", false),
  ],
  "project-binding-workspace": [
    id("workspaceId"),
    id("projectId", false),
    id("ownerId"),
    text("state"),
    json("metadata"),
    version("workspaceVersion"),
  ],
  "project-binding-lease": [
    id("workspaceId"),
    id("leaseId"),
    id("holderId"),
    version("fence"),
    clock("expiresAt"),
  ],
  "project-binding-receipt": [
    id("workspaceId"),
    id("receiptId"),
    field("setupHash", "hash", false),
    text("status"),
    json("detail"),
    clock("completedAt"),
  ],
  "setup-approval": [
    id("approvalId"),
    text("projectFingerprint"),
    id("capletId"),
    text("contentHash"),
    text("targetKind"),
    text("actor"),
    clock("approvedAt"),
  ],
  "setup-execution": [
    id("executionId"),
    text("projectFingerprint"),
    id("capletId"),
    text("contentHash"),
    field("setupHash", "hash", false),
    text("targetKind"),
    id("leaseId"),
    clock("reservedAt"),
    clock("expiresAt"),
    text("state"),
  ],
  "setup-attempt": [
    id("attemptId"),
    text("projectFingerprint"),
    id("capletId"),
    text("contentHash"),
    field("setupHash", "hash", false),
    text("targetKind"),
    text("status"),
    json("detail", true),
    clock("finishedAt"),
  ],
  "vault-value": [
    text("referenceName"),
    version("recordVersion"),
    text("algorithm"),
    field("ciphertext", "bytes"),
    field("nonce", "bytes"),
    field("authTag", "bytes"),
    version("valueBytes"),
    version("keyVersion"),
    version("aadVersion", false),
    id("ownerId", false),
  ],
  "vault-grant": [
    text("referenceName"),
    id("capletId"),
    json("origin", true),
    text("storedKey"),
    text("scope", false),
    id("ownerId", false),
  ],
  "operator-activity": [
    id("activityId"),
    id("actorId"),
    text("action"),
    text("outcome"),
    json("target", true),
    json("redactedDetail"),
    clock("occurredAt"),
    clock("expiresAt"),
  ],
  "authority-version": [
    version("generation"),
    text("bindingState"),
    text("authorityToken"),
    id("operationNamespace"),
    id("transferId", false),
  ],
  "effective-version": [
    version("generation"),
    field("snapshotHash", "hash"),
    text("appliedToken"),
    clock("publishedAt"),
  ],
  "security-version": [
    version("epoch"),
    version("minimumKeyVersion"),
    version("revocationWatermark"),
    clock("advancedAt"),
  ],
  "key-inventory": [
    text("provider"),
    id("keyId"),
    text("purpose"),
    text("algorithm"),
    version("keyVersion"),
    text("state"),
    json("verifiedNodeIds", true),
    version("purgeWatermark"),
    clock("activatedAt"),
    clock("decryptOnlyAt", false),
    clock("retiredAt", false),
    clock("destroyedAt", false),
    id("destructionId", false),
  ],
  "key-canary": [
    text("purpose"),
    text("algorithm"),
    version("keyVersion"),
    text("protection"),
    field("labelHash", "hash"),
    version("aadVersion"),
    field("nonce", "bytes", false),
    field("ciphertext", "bytes", false),
    field("authTag", "bytes", false),
    field("verifier", "bytes", false),
    text("state"),
  ],
  "cluster-node-lease": [
    id("nodeId"),
    field("bootstrapFingerprint", "hash"),
    json("compatibility", true),
    clock("heartbeatAt"),
    clock("expiresAt"),
    text("state"),
  ],
  "writer-fence": [
    id("leaseId"),
    version("writerEpoch"),
    version("authorityGeneration"),
    clock("expiresAt"),
    text("state"),
  ],
  "snapshot-envelope": [
    id("envelopeId"),
    version("capletCount"),
    version("normalizedRowCount"),
    version("encodedByteCount"),
  ],
  migration: [
    id("migrationId"),
    text("source"),
    text("destination"),
    text("phase"),
    field("manifestHash", "hash"),
    field("checksum", "hash"),
    json("compatibility", true),
    json("stateDocument"),
    clock("activatedAt", false),
  ],
  backup: [
    id("backupId"),
    text("providerIdentity"),
    text("sourceIdentity"),
    text("sourceProfile"),
    field("manifestHash", "hash"),
    version("keyVersion"),
    text("keyPurpose"),
    text("keyAlgorithm"),
    text("unwrapIdentity"),
    clock("retentionUntil"),
    text("state"),
    clock("destroyedAt", false),
    id("destructionId", false),
    json("stateDocument"),
  ],
  recovery: [
    id("recoveryId"),
    id("backupId"),
    text("phase"),
    version("invalidatedAuthorityGeneration"),
    field("validationHash", "hash", false),
    clock("activatedAt", false),
    json("stateDocument"),
  ],
  retention: [
    id("retentionId"),
    text("resourceKind"),
    id("resourceId"),
    text("policy"),
    version("purgeWatermark"),
    clock("retainUntil"),
    clock("destroyedAt", false),
  ],
  "external-destruction": [
    id("destructionId"),
    text("providerIdentity"),
    text("phase"),
    field("inventoryHash", "hash"),
    id("confirmationId"),
    text("intent"),
    json("receipt"),
    clock("completedAt", false),
  ],
  "recovery-checkpoint": [
    id("checkpointId"),
    id("namespaceId"),
    version("authorityGeneration"),
    field("manifestHash", "hash"),
    text("replacementReason"),
    clock("checkpointedAt"),
    json("stateDocument"),
  ],
  quarantine: [
    id("quarantineId"),
    text("sourceDomain"),
    text("sourcePath"),
    field("rawDigest", "hash"),
    text("reason"),
    clock("observedAt"),
    text("disposition"),
  ],
};

export function canonicalFields(kind: ControlPlaneEntityKind): readonly CanonicalFieldDefinition[] {
  return [...COMMON_FIELDS, ...CANONICAL_FIELD_CHECKLIST[kind]];
}

export function validateCanonicalEntityShape(kind: ControlPlaneEntityKind, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${kind} must be an object`);
  const record = value as Record<string, unknown>;
  const definitions = canonicalFields(kind);
  const allowed = new Set(definitions.map((definition) => definition.name));
  for (const key of Object.keys(record))
    if (!allowed.has(key)) throw new Error(`Unsupported ${kind} field ${key}`);
  for (const definition of definitions) {
    if (definition.required && !(definition.name in record))
      throw new Error(`Missing ${kind} field ${definition.name}`);
    if (definition.name in record && !validFieldValue(definition, record[definition.name]))
      throw new Error(`Invalid ${kind} field ${definition.name}`);
  }
  if (record.modelVersion !== CANONICAL_MODEL_VERSION)
    throw new Error(`Unsupported ${kind} model version`);
}

function validFieldValue(definition: CanonicalFieldDefinition, value: unknown): boolean {
  if (definition.repeating) return Array.isArray(value);
  if (definition.type === "version")
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (definition.type === "timestamp")
    return typeof value === "string" && Number.isFinite(Date.parse(value));
  if (definition.type === "boolean") return typeof value === "boolean";
  if (definition.type === "json") return value !== undefined;
  if (definition.type === "bytes") return value instanceof Uint8Array && value.byteLength > 0;
  if (definition.type === "hash") return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  return typeof value === "string" && value.length > 0;
}
