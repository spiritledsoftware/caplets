export const CANONICAL_MODEL_VERSION = 1 as const;

export type CanonicalModelVersion = typeof CANONICAL_MODEL_VERSION;
export type IsoTimestamp = string;
export type ContentHash = string;
export type EntityId = string;

export type VersionVector = {
  aggregateVersion: number;
  authorityVersion: number;
  effectiveVersion: number;
  securityVersion: number;
};
export function assertVersionVector(value: VersionVector): void {
  for (const [name, version] of Object.entries(value)) {
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new Error(`${name} must be a non-negative safe integer`);
    }
  }
}

export type CanonicalRecord<
  K extends ControlPlaneEntityKind,
  F extends object = Record<string, unknown>,
> = {
  modelVersion: CanonicalModelVersion;
  kind: K;
  id: EntityId;
  logicalHostId: EntityId;
  storeId: EntityId;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  versions: VersionVector;
  fields: F;
};

export type ControlPlaneEntityKind =
  | "host-setting"
  | "caplet"
  | "caplet-provenance"
  | "operation-namespace"
  | "operation-reservation"
  | "operation-outcome"
  | "operation-tombstone"
  | "confirmation"
  | "oauth-token"
  | "client"
  | "credential"
  | "pending-approval"
  | "dashboard-session"
  | "project-binding-workspace"
  | "project-binding-lease"
  | "project-binding-receipt"
  | "vault-value"
  | "vault-grant"
  | "operator-activity"
  | "authority-version"
  | "effective-version"
  | "security-version"
  | "cluster-node-lease"
  | "writer-fence"
  | "migration"
  | "backup"
  | "recovery"
  | "retention"
  | "external-destruction"
  | "recovery-checkpoint"
  | "quarantine";

export type EntityInventoryEntry = {
  kind: ControlPlaneEntityKind;
  fieldCategories: readonly string[];
  mutable: boolean;
  securityCritical: boolean;
};

export const CONTROL_PLANE_ENTITY_INVENTORY: readonly EntityInventoryEntry[] = [
  {
    kind: "host-setting",
    fieldCategories: ["typed-value", "ownership", "dormant/effective"],
    mutable: true,
    securityCritical: false,
  },
  {
    kind: "caplet",
    fieldCategories: [
      "identity",
      "portable-aggregate",
      "update-state",
      "ownership",
      "dormant/effective",
    ],
    mutable: true,
    securityCritical: false,
  },
  {
    kind: "caplet-provenance",
    fieldCategories: ["source", "content-hash", "lockfile", "runtime-fingerprint"],
    mutable: false,
    securityCritical: false,
  },
  {
    kind: "operation-namespace",
    fieldCategories: ["logical-host", "store", "generation", "replacement"],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "operation-reservation",
    fieldCategories: ["operation-id", "target", "actor", "request-hash", "clock"],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "operation-outcome",
    fieldCategories: ["receipt", "operation-class", "aggregate-version", "tokens", "convergence"],
    mutable: false,
    securityCritical: true,
  },
  {
    kind: "operation-tombstone",
    fieldCategories: ["consumed-id", "authoritative-absence", "target-binding"],
    mutable: false,
    securityCritical: true,
  },
  {
    kind: "confirmation",
    fieldCategories: [
      "action",
      "authority-token",
      "inventory",
      "expiry",
      "consumption",
      "consequences",
    ],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "oauth-token",
    fieldCategories: ["subject", "ciphertext", "expiry", "key-version", "refresh-family"],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "client",
    fieldCategories: ["identity", "role", "status", "ownership"],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "credential",
    fieldCategories: ["verifier-or-ciphertext", "purpose", "key-version", "expiry", "replay"],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "pending-approval",
    fieldCategories: ["request", "verifier", "actor", "expiry", "consumption"],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "dashboard-session",
    fieldCategories: ["session-id", "client", "verifier", "expiry", "revocation"],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "project-binding-workspace",
    fieldCategories: ["workspace", "owner", "state", "version"],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "project-binding-lease",
    fieldCategories: ["workspace", "holder", "fence", "expiry"],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "project-binding-receipt",
    fieldCategories: ["workspace", "setup", "result", "clock"],
    mutable: false,
    securityCritical: true,
  },
  {
    kind: "vault-value",
    fieldCategories: ["reference", "ciphertext", "nonce", "tag", "key-version", "aad-version"],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "vault-grant",
    fieldCategories: ["reference", "caplet", "origin", "stored-key", "scope"],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "operator-activity",
    fieldCategories: ["actor", "action", "target", "redacted-detail", "clock"],
    mutable: false,
    securityCritical: true,
  },
  {
    kind: "authority-version",
    fieldCategories: ["generation", "binding", "state"],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "effective-version",
    fieldCategories: ["generation", "snapshot-hash", "applied-token"],
    mutable: true,
    securityCritical: false,
  },
  {
    kind: "security-version",
    fieldCategories: ["epoch", "key-floor", "revocation-watermark"],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "cluster-node-lease",
    fieldCategories: ["node", "bootstrap-fingerprint", "compatibility", "heartbeat", "expiry"],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "writer-fence",
    fieldCategories: ["lease", "epoch", "authority-generation", "expiry"],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "migration",
    fieldCategories: ["manifest", "source", "destination", "phase", "checksum", "compatibility"],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "backup",
    fieldCategories: [
      "provider",
      "immutable-source-identity",
      "encryption",
      "key-version",
      "retention",
    ],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "recovery",
    fieldCategories: ["backup", "authority-invalidation", "validation", "activation"],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "retention",
    fieldCategories: ["resource", "policy", "purge-watermark", "expiry"],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "external-destruction",
    fieldCategories: ["intent", "phase", "provider", "inventory", "receipt", "confirmation"],
    mutable: true,
    securityCritical: true,
  },
  {
    kind: "recovery-checkpoint",
    fieldCategories: ["namespace", "authority", "manifest", "catastrophic-replacement"],
    mutable: false,
    securityCritical: true,
  },
  {
    kind: "quarantine",
    fieldCategories: ["source", "raw-digest", "reason", "observed-at", "disposition"],
    mutable: true,
    securityCritical: true,
  },
] as const;

export type RelationalChecklistItem = {
  entity: ControlPlaneEntityKind;
  primaryKey: readonly string[];
  foreignKeys: readonly string[];
  uniqueKeys: readonly (readonly string[])[];
  invariants: readonly string[];
};

export const RELATIONAL_MODEL_CHECKLIST: readonly RelationalChecklistItem[] =
  CONTROL_PLANE_ENTITY_INVENTORY.map((entry) => ({
    entity: entry.kind,
    primaryKey: ["logicalHostId", "id"],
    foreignKeys: ["__caplets_storage_identity_v1(logicalHostId,storeId)"],
    uniqueKeys: [["logicalHostId", "id"]],
    invariants: [
      "model-version-checked",
      "authority-effective-security-versions-monotonic",
      ...(entry.kind === "caplet" || entry.kind === "host-setting"
        ? ["effective-and-dormant-distinct"]
        : []),
      ...(entry.securityCritical ? ["live-authority-required", "writer-fence-checked"] : []),
    ],
  }));

export type OperationReservation = {
  state: "reserved" | "committed";
  reservedAt: IsoTimestamp;
  committedAt?: IsoTimestamp;
  receiptHash?: ContentHash;
};

export type OperationTombstone = {
  reason: "authoritative-absence" | "superseded" | "namespace-replaced";
  consumedAt: IsoTimestamp;
};

export type OperationIdentity = {
  operationId: EntityId;
  namespaceId: EntityId;
  target: string;
  requestHash: ContentHash;
  reservation?: OperationReservation;
  tombstone?: OperationTombstone;
};

export type OperationLookupState =
  | "unseen"
  | "reserved"
  | "committed"
  | "not_committed"
  | "superseded"
  | "stale_namespace";

export function operationState(operation: OperationIdentity): OperationLookupState {
  if (operation.reservation && operation.tombstone)
    throw new Error("Operation cannot have both a reservation and tombstone");
  if (operation.reservation?.state === "committed") {
    if (!operation.reservation.committedAt || !operation.reservation.receiptHash)
      throw new Error("Committed operation requires receipt and commit clock");
    return "committed";
  }
  if (operation.reservation) return "reserved";
  if (operation.tombstone?.reason === "authoritative-absence") return "not_committed";
  if (operation.tombstone?.reason === "superseded") return "superseded";
  if (operation.tombstone?.reason === "namespace-replaced") return "stale_namespace";
  return "unseen";
}

type TransitionDomain =
  | "operation"
  | "authority"
  | "operation-namespace"
  | "confirmation"
  | "destruction"
  | "migration";

const ALLOWED_TRANSITIONS: Record<TransitionDomain, Record<string, readonly string[]>> = {
  operation: {
    unseen: ["reserved", "not_committed"],
    reserved: ["committed", "superseded"],
    committed: [],
    not_committed: [],
    superseded: [],
    stale_namespace: [],
  },
  authority: {
    unbound: ["active"],
    active: ["transfer-pending", "restored"],
    "transfer-pending": ["active", "replaced"],
    restored: ["active"],
    replaced: [],
  },
  "operation-namespace": { active: ["replaced"], replaced: [] },
  confirmation: {
    previewed: ["consumed", "expired", "invalidated"],
    consumed: [],
    expired: [],
    invalidated: [],
  },
  destruction: {
    intended: ["confirmed", "cancelled"],
    confirmed: ["in-progress"],
    "in-progress": ["completed", "failed"],
    failed: ["in-progress"],
    completed: [],
    cancelled: [],
  },
  migration: {
    discovered: ["staged", "rejected"],
    staged: ["verified", "failed"],
    verified: ["activated", "failed"],
    activated: ["finalized", "rolled-back"],
    failed: [],
    rejected: [],
    finalized: [],
    "rolled-back": [],
  },
};

export function assertControlPlaneTransition(
  domain: TransitionDomain,
  from: string,
  to: string,
): void {
  if (!ALLOWED_TRANSITIONS[domain][from]?.includes(to))
    throw new Error(`Invalid ${domain} transition: ${from} -> ${to}`);
}

export * from "./fields";
export * from "./storage-identity";
export * from "./host-settings";
