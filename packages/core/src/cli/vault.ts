import { CapletsError } from "../errors";
import type {
  VaultAccessGrant,
  VaultAccessGrantFilter,
  VaultAccessGrantInput,
  VaultDeleteStatus,
  VaultValueStatus,
} from "../vault";
import type { CliAuthorityContext } from "./auth";

export type VaultCliStore = {
  set(
    key: string,
    value: string,
    options?: { force?: boolean | undefined; now?: Date | undefined },
  ): VaultValueStatus | Promise<VaultValueStatus>;
  getStatus(key: string): VaultValueStatus | Promise<VaultValueStatus>;
  listValues(): VaultValueStatus[] | Promise<VaultValueStatus[]>;
  resolveValue?(key: string): string | Promise<string>;
  delete(key: string): VaultDeleteStatus | Promise<VaultDeleteStatus>;
  grantAccess(input: VaultAccessGrantInput): VaultAccessGrant | Promise<VaultAccessGrant>;
  listAccess(filter?: VaultAccessGrantFilter): VaultAccessGrant[] | Promise<VaultAccessGrant[]>;
  revokeAccess(filter: VaultAccessGrantFilter): VaultAccessGrant[] | Promise<VaultAccessGrant[]>;
};

export type VaultSetCliOptions = {
  force?: boolean | undefined;
  now?: Date | undefined;
  grant?: string | undefined;
  referenceName?: string | undefined;
  authority?: CliAuthorityContext | undefined;
};

export async function setVaultValue(
  store: VaultCliStore | undefined,
  key: string,
  value: string,
  options: VaultSetCliOptions = {},
): Promise<VaultValueStatus> {
  const authority = options.authority;
  const hasGrant = options.grant !== undefined || options.referenceName !== undefined;
  if (authority && (authority.currentHost || hasGrant)) {
    const currentHost = authority.currentHost;
    if (!currentHost) {
      throw new CapletsError(
        "ASYNC_AUTHORITY_REQUIRED",
        "Shared Vault grants require the Current Host operations facade.",
      );
    }
    const principal = authority.principal;
    if (!principal) {
      throw new CapletsError(
        "AUTH_FAILED",
        "Shared Vault mutation requires an Operator principal.",
      );
    }
    const outcome = await currentHost.execute(principal, {
      kind: "vault_set",
      name: key,
      value,
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.grant === undefined ? {} : { grant: options.grant }),
      ...(options.referenceName === undefined ? {} : { referenceName: options.referenceName }),
    });
    if (outcome.kind !== "vault_set") {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Current Host Vault set returned an invalid result.",
      );
    }
    return outcome.status;
  }
  if (!store) {
    throw new CapletsError(
      "ASYNC_AUTHORITY_REQUIRED",
      "Vault commands require a resolved Vault store.",
    );
  }
  return await store.set(key, value, {
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export function getVaultValue(
  store: VaultCliStore,
  key: string,
  options: { reveal: true },
): Promise<{ key: string; value: string }>;
export function getVaultValue(
  store: VaultCliStore,
  key: string,
  options?: { reveal?: false | undefined },
): Promise<VaultValueStatus>;
export async function getVaultValue(
  store: VaultCliStore,
  key: string,
  options: { reveal?: boolean | undefined } = {},
): Promise<VaultValueStatus | { key: string; value: string }> {
  if (options.reveal) {
    if (!store.resolveValue) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Raw Vault reveal is available only for the local filesystem Vault.",
      );
    }
    return { key, value: await store.resolveValue(key) };
  }
  return await store.getStatus(key);
}

export async function listVaultValues(store: VaultCliStore): Promise<VaultValueStatus[]> {
  return await store.listValues();
}

export async function deleteVaultValue(
  store: VaultCliStore,
  key: string,
): Promise<VaultDeleteStatus> {
  return await store.delete(key);
}

export async function grantVaultAccess(
  store: VaultCliStore,
  input: VaultAccessGrantInput,
): Promise<VaultAccessGrant> {
  return await store.grantAccess(input);
}

export async function listVaultAccess(
  store: VaultCliStore,
  filter: VaultAccessGrantFilter = {},
): Promise<VaultAccessGrant[]> {
  return await store.listAccess(filter);
}

export async function revokeVaultAccess(
  store: VaultCliStore,
  filter: VaultAccessGrantFilter,
): Promise<VaultAccessGrant[]> {
  return await store.revokeAccess(filter);
}

export function formatVaultValueStatus(status: VaultValueStatus, json = false): string {
  if (json) return `${JSON.stringify(status, null, 2)}\n`;
  if (!status.present) return `Vault key ${status.key} is not set.\n`;
  return [
    `Vault key ${status.key} is set.`,
    status.valueBytes === undefined ? undefined : `Value bytes: ${status.valueBytes}`,
    status.updatedAt === undefined ? undefined : `Updated: ${status.updatedAt}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
    .concat("\n");
}

export function formatVaultValueList(statuses: VaultValueStatus[], json = false): string {
  if (json) return `${JSON.stringify(statuses, null, 2)}\n`;
  if (statuses.length === 0) return "No Vault keys set.\n";
  return `${statuses.map((status) => status.key).join("\n")}\n`;
}

export function formatVaultDeleteStatus(status: VaultDeleteStatus, json = false): string {
  if (json) return `${JSON.stringify(status, null, 2)}\n`;
  return status.deleted
    ? `Deleted Vault key ${status.key}. ${status.grantsRetained} access grant${status.grantsRetained === 1 ? "" : "s"} retained.\n`
    : `No Vault key ${status.key} found.\n`;
}

export function formatVaultAccessGrant(grant: VaultAccessGrant, json = false): string {
  if (json) return `${JSON.stringify(grant, null, 2)}\n`;
  return `Granted Vault key ${grant.storedKey} to ${grant.capletId} as ${grant.referenceName}.\n`;
}

export function formatVaultAccessList(grants: VaultAccessGrant[], json = false): string {
  if (json) return `${JSON.stringify(grants, null, 2)}\n`;
  if (grants.length === 0) return "No Vault access grants.\n";
  return `${grants
    .map((grant) => {
      const origin =
        grant.origin?.kind === "authority"
          ? ` (authority ${grant.origin.authorityId}/${grant.origin.recordId}@${grant.origin.generationId})`
          : grant.origin
            ? ` (${grant.origin.kind} ${grant.origin.path})`
            : "";
      return `${grant.storedKey} -> ${grant.capletId}:${grant.referenceName}${origin}`;
    })
    .join("\n")}\n`;
}

export function formatVaultAccessRevoke(count: number, json = false): string {
  if (json) return `${JSON.stringify({ revoked: count }, null, 2)}\n`;
  return `Revoked ${count} Vault access grant${count === 1 ? "" : "s"}.\n`;
}
