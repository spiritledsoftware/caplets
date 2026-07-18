import type { ConfigVaultResolver } from "../config";
import type { HostStorage } from "./database";

export async function createHostStorageVaultResolver(
  storage: HostStorage,
): Promise<ConfigVaultResolver> {
  const grants = await storage.vaultGrants.list();
  const grantedKeys = new Set(grants.map((grant) => grant.vaultKey));
  const presentKeys = new Set((await storage.vaultValues.listValues()).map((value) => value.key));
  const values = new Map<string, string>();
  const unavailable = new Set<string>();
  for (const storedKey of grantedKeys) {
    if (!presentKeys.has(storedKey)) continue;
    try {
      values.set(storedKey, await storage.vaultValues.resolveValue(storedKey));
    } catch {
      unavailable.add(storedKey);
    }
  }

  return (reference) => {
    const grant = grants.find((candidate) => {
      if (
        candidate.capletId !== reference.capletId ||
        candidate.referenceName !== reference.referenceName
      ) {
        return false;
      }
      return candidate.subjectKind === "record"
        ? reference.origin.kind === "stored-record"
        : candidate.originKind === reference.origin.kind &&
            candidate.originPath === reference.origin.path;
    });
    if (!grant) {
      return {
        reason: "ungranted",
        referenceName: reference.referenceName,
        capletId: reference.capletId,
        origin: reference.origin,
      };
    }
    const value = values.get(grant.vaultKey);
    if (value !== undefined) return { storedKey: grant.vaultKey, value };
    return {
      reason: unavailable.has(grant.vaultKey) ? "invalid-key-source" : "missing",
      storedKey: grant.vaultKey,
      referenceName: reference.referenceName,
      capletId: reference.capletId,
      origin: reference.origin,
    };
  };
}
