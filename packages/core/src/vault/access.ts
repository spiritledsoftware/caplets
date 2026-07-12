import { CapletsError } from "../errors";
import { validateVaultKeyName } from "./keys";
import type {
  VaultAccessGrant,
  VaultAccessGrantFilter,
  VaultAccessGrantInput,
  VaultConfigOrigin,
} from "./types";

export function normalizeVaultGrant(input: VaultAccessGrantInput): VaultAccessGrant {
  const now = (input.now ?? new Date()).toISOString();
  return {
    storedKey: validateVaultKeyName(input.storedKey),
    referenceName: validateVaultKeyName(input.referenceName),
    capletId: validateCapletId(input.capletId),
    origin: normalizeOrigin(input.origin),
    createdAt: now,
    updatedAt: now,
  };
}

export function upsertVaultGrant(
  grants: VaultAccessGrant[],
  input: VaultAccessGrantInput,
): VaultAccessGrant[] {
  const next = normalizeVaultGrant(input);
  return [
    ...grants.filter((grant) => !sameGrantIdentity(grant, next)),
    {
      ...next,
      createdAt:
        grants.find((grant) => sameGrantIdentity(grant, next))?.createdAt ?? next.createdAt,
    },
  ].sort(compareGrants);
}

export function filterVaultGrants(
  grants: VaultAccessGrant[],
  filter: VaultAccessGrantFilter = {},
): VaultAccessGrant[] {
  return grants.filter((grant) => {
    if (filter.storedKey !== undefined && grant.storedKey !== filter.storedKey) return false;
    if (filter.referenceName !== undefined && grant.referenceName !== filter.referenceName) {
      return false;
    }
    if (filter.capletId !== undefined && grant.capletId !== filter.capletId) return false;
    if (filter.origin !== undefined && !sameOrigin(grant.origin, filter.origin)) return false;
    return true;
  });
}

export function sameOrigin(left: VaultConfigOrigin, right: VaultConfigOrigin): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "authority" && right.kind === "authority") {
    // Generation IDs describe the snapshot that supplied a record; grant
    // identity follows the stable authority record across generations.
    return left.authorityId === right.authorityId && left.recordId === right.recordId;
  }
  if (left.kind === "authority" || right.kind === "authority") return false;
  return (left.identity ?? left.path) === (right.identity ?? right.path);
}

function sameGrantIdentity(left: VaultAccessGrant, right: VaultAccessGrant): boolean {
  return (
    left.referenceName === right.referenceName &&
    left.capletId === right.capletId &&
    sameOrigin(left.origin, right.origin)
  );
}

function normalizeOrigin(origin: VaultConfigOrigin): VaultConfigOrigin {
  if (origin.kind === "authority") {
    if (!origin.authorityId || !origin.recordId || !origin.generationId) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Vault access grants require authority provenance.",
      );
    }
    return { ...origin };
  }
  if (!origin.path) {
    throw new CapletsError("REQUEST_INVALID", "Vault access grants require a config origin path.");
  }
  return {
    kind: origin.kind,
    path: origin.path,
    ...(origin.identity ? { identity: origin.identity } : {}),
  };
}

function validateCapletId(capletId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(capletId)) {
    throw new CapletsError("REQUEST_INVALID", "Vault access grants require a valid Caplet ID.");
  }
  return capletId;
}

function compareGrants(left: VaultAccessGrant, right: VaultAccessGrant): number {
  const leftIdentity =
    left.origin.kind === "authority"
      ? `${left.origin.authorityId}:${left.origin.recordId}:${left.origin.generationId}`
      : (left.origin.identity ?? left.origin.path);
  const rightIdentity =
    right.origin.kind === "authority"
      ? `${right.origin.authorityId}:${right.origin.recordId}:${right.origin.generationId}`
      : (right.origin.identity ?? right.origin.path);
  return (
    left.capletId.localeCompare(right.capletId) ||
    left.referenceName.localeCompare(right.referenceName) ||
    left.storedKey.localeCompare(right.storedKey) ||
    left.origin.kind.localeCompare(right.origin.kind) ||
    leftIdentity.localeCompare(rightIdentity)
  );
}
