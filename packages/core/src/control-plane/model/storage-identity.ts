export const STORAGE_IDENTITY_TABLE = "__caplets_storage_identity_v1" as const;
const STORAGE_IDENTITY_FIELDS: Readonly<Record<string, true>> = {
  singleton: true,
  logicalHostId: true,
  storeId: true,
};
const STORAGE_IDENTITY_STRING_FIELDS = ["logicalHostId", "storeId"] as const;

/** Exact logical/store parent row established by U2's singleton identity table. */
export type ControlPlaneStorageIdentityV1 = {
  singleton: 1;
  logicalHostId: string;
  storeId: string;
};

/** Canonical store-root state; deployment/backend/key configuration is deliberately excluded. */
export type ControlPlaneStoreRootV1 = {
  modelVersion: 1;
  logicalHostId: string;
  storeId: string;
  operationNamespace: string;
  authorityVersion: number;
  effectiveVersion: number;
  securityVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type StoreScopedIdentity = {
  logicalHostId: string;
  storeId: string;
};

export function assertControlPlaneStorageIdentity(
  value: unknown,
): asserts value is ControlPlaneStorageIdentityV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Storage identity must be an object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (!STORAGE_IDENTITY_FIELDS[key]) throw new Error(`Unsupported storage identity field ${key}`);
  for (const key of Object.keys(STORAGE_IDENTITY_FIELDS))
    if (!(key in record)) throw new Error(`Missing storage identity field ${key}`);
  if (record.singleton !== 1) throw new Error("Storage identity singleton is invalid");
  for (const key of STORAGE_IDENTITY_STRING_FIELDS) {
    if (typeof record[key] !== "string" || record[key].length === 0)
      throw new Error(`Storage identity ${key} is invalid`);
  }
}

export function assertControlPlaneStoreRoot(value: ControlPlaneStoreRootV1): void {
  if (value.modelVersion !== 1) throw new Error("Unsupported store-root model version");
  assertStoreScopedIdentity(
    { singleton: 1, logicalHostId: value.logicalHostId, storeId: value.storeId },
    value,
  );
  for (const [name, version] of Object.entries({
    authorityVersion: value.authorityVersion,
    effectiveVersion: value.effectiveVersion,
    securityVersion: value.securityVersion,
  })) {
    if (!Number.isSafeInteger(version) || version < 0)
      throw new Error(`Store-root ${name} is invalid`);
  }
  if (
    !value.operationNamespace ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(Date.parse(value.updatedAt))
  )
    throw new Error("Store-root namespace or clocks are invalid");
}

export function assertStoreScopedIdentity(
  parent: ControlPlaneStorageIdentityV1,
  child: StoreScopedIdentity,
): void {
  if (parent.logicalHostId !== child.logicalHostId || parent.storeId !== child.storeId) {
    throw new Error("Control-plane entity does not belong to the bound storage identity");
  }
}
