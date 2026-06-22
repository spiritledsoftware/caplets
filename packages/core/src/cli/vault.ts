import type { VaultAccessGrant, VaultDeleteStatus, VaultValueStatus } from "../vault";

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
      const origin = grant.origin ? ` (${grant.origin.kind} ${grant.origin.path})` : "";
      return `${grant.storedKey} -> ${grant.capletId}:${grant.referenceName}${origin}`;
    })
    .join("\n")}\n`;
}

export function formatVaultAccessRevoke(count: number, json = false): string {
  if (json) return `${JSON.stringify({ revoked: count }, null, 2)}\n`;
  return `Revoked ${count} Vault access grant${count === 1 ? "" : "s"}.\n`;
}
