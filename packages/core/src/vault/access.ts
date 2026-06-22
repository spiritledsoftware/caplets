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
  return left.kind === right.kind && left.path === right.path;
}

function sameGrantIdentity(left: VaultAccessGrant, right: VaultAccessGrant): boolean {
  return (
    left.referenceName === right.referenceName &&
    left.capletId === right.capletId &&
    sameOrigin(left.origin, right.origin)
  );
}

function normalizeOrigin(origin: VaultConfigOrigin): VaultConfigOrigin {
  if (!origin.path) {
    throw new CapletsError("REQUEST_INVALID", "Vault access grants require a config origin path.");
  }
  return { kind: origin.kind, path: origin.path };
}

function validateCapletId(capletId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(capletId)) {
    throw new CapletsError("REQUEST_INVALID", "Vault access grants require a valid Caplet ID.");
  }
  return capletId;
}

function compareGrants(left: VaultAccessGrant, right: VaultAccessGrant): number {
  return (
    left.capletId.localeCompare(right.capletId) ||
    left.referenceName.localeCompare(right.referenceName) ||
    left.storedKey.localeCompare(right.storedKey) ||
    left.origin.kind.localeCompare(right.origin.kind) ||
    left.origin.path.localeCompare(right.origin.path)
  );
}
