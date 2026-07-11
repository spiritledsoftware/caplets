import {
  loadLocalOverlayConfigWithSources,
  vaultBootstrapResolver,
  vaultStoreForAuthDir,
} from "../config";
import { SERVER_ID_PATTERN } from "../config/validation";
import { CapletsError } from "../errors";
import { FileVaultStore, validateVaultKeyName, type VaultAccessGrantInput } from "../vault";
import type {
  CurrentHostOperation,
  CurrentHostOperationOutcome,
  CurrentHostOperatorPrincipal,
  CurrentHostOperationsDependencies,
  CurrentHostVaultAccessGrant,
} from "./operations";

type VaultSetOperation = Extract<CurrentHostOperation, { kind: "vault_set" }>;
type VaultListOperation = Extract<CurrentHostOperation, { kind: "vault_list" }>;
type VaultGetOperation = Extract<CurrentHostOperation, { kind: "vault_get" }>;
type VaultDeleteOperation = Extract<CurrentHostOperation, { kind: "vault_delete" }>;
type VaultAccessGrantOperation = Extract<CurrentHostOperation, { kind: "vault_access_grant" }>;
type VaultAccessRevokeOperation = Extract<CurrentHostOperation, { kind: "vault_access_revoke" }>;
type VaultAccessListOperation = Extract<CurrentHostOperation, { kind: "vault_access_list" }>;
type VaultSetOutcome = Extract<CurrentHostOperationOutcome, { kind: "vault_set" }>;
type VaultListOutcome = Extract<CurrentHostOperationOutcome, { kind: "vault_list" }>;
type VaultGetOutcome = Extract<CurrentHostOperationOutcome, { kind: "vault_get" }>;
type VaultDeleteOutcome = Extract<CurrentHostOperationOutcome, { kind: "vault_delete" }>;
type VaultAccessGrantOutcome = Extract<CurrentHostOperationOutcome, { kind: "vault_access_grant" }>;
type VaultAccessRevokeOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "vault_access_revoke" }
>;
type VaultAccessListOutcome = Extract<CurrentHostOperationOutcome, { kind: "vault_access_list" }>;

/** Safe Vault administration implementation. Raw value reveal remains in the dashboard adapter. */
export function createCurrentHostVaultOperations(dependencies: CurrentHostOperationsDependencies) {
  const vault = vaultStoreForAuthDir(dependencies.control?.authDir);

  return {
    valueCount: (): number => vault.listValues().length,
    list: (_operation: VaultListOperation): VaultListOutcome => ({
      kind: "vault_list",
      values: vault.listValues(),
      grants: vault.listAccess().map(redactedVaultGrant),
    }),
    get: (operation: VaultGetOperation): VaultGetOutcome => ({
      kind: "vault_get",
      status: vault.getStatus(validateVaultKeyName(operation.name)),
    }),
    set: (principal: CurrentHostOperatorPrincipal, operation: VaultSetOperation): VaultSetOutcome =>
      vaultSetOutcome(dependencies, vault, principal, operation),
    delete: (
      principal: CurrentHostOperatorPrincipal,
      operation: VaultDeleteOperation,
    ): VaultDeleteOutcome => vaultDeleteOutcome(dependencies, vault, principal, operation),
    grant: (
      principal: CurrentHostOperatorPrincipal,
      operation: VaultAccessGrantOperation,
    ): VaultAccessGrantOutcome => vaultGrantOutcome(dependencies, vault, principal, operation),
    revoke: (
      principal: CurrentHostOperatorPrincipal,
      operation: VaultAccessRevokeOperation,
    ): VaultAccessRevokeOutcome => vaultRevokeOutcome(dependencies, vault, principal, operation),
    listAccess: (operation: VaultAccessListOperation): VaultAccessListOutcome => ({
      kind: "vault_access_list",
      grants: vault
        .listAccess({
          ...(operation.storedKey === undefined
            ? {}
            : { storedKey: validateVaultKeyName(operation.storedKey) }),
          ...(operation.capletId === undefined
            ? {}
            : { capletId: requiredCapletId(operation.capletId) }),
        })
        .map(redactedVaultGrant),
    }),
  };
}

function vaultSetOutcome(
  dependencies: CurrentHostOperationsDependencies,
  vault: FileVaultStore,
  principal: CurrentHostOperatorPrincipal,
  operation: VaultSetOperation,
): VaultSetOutcome {
  const storedKey = validateVaultKeyName(operation.name);
  const capletId = operation.grant === undefined ? undefined : requiredCapletId(operation.grant);
  const referenceName =
    capletId === undefined
      ? undefined
      : validateVaultKeyName(
          operation.referenceName === undefined ? storedKey : operation.referenceName,
        );
  try {
    const grantInput =
      capletId === undefined || referenceName === undefined
        ? undefined
        : ({
            storedKey,
            referenceName,
            capletId,
            origin: vaultAccessOrigin(capletId, dependencies),
          } satisfies VaultAccessGrantInput);
    const existed = vault.getStatus(storedKey).present;
    const previousValue = existed && grantInput ? vault.resolveValue(storedKey) : undefined;
    const status = vault.set(storedKey, operation.value, { force: operation.force ?? false });
    let grant;
    try {
      grant = grantInput ? vault.grantAccess(grantInput) : undefined;
    } catch (error) {
      if (existed && previousValue !== undefined) {
        vault.set(storedKey, previousValue, { force: true });
      } else {
        vault.delete(storedKey);
      }
      throw error;
    }
    dependencies.activityLog.append({
      actorClientId: principal.clientId,
      action: "vault_set",
      target: { type: "vault", id: status.key },
      metadata: { bytesWritten: status.valueBytes ?? null },
    });
    if (grant) {
      dependencies.activityLog.append({
        actorClientId: principal.clientId,
        action: "vault_grant_added",
        target: { type: "vault", id: grant.storedKey },
        metadata: {
          referenceName: grant.referenceName,
          capletId: grant.capletId,
          originKind: grant.origin.kind,
        },
      });
    }
    return { kind: "vault_set", status };
  } catch (error) {
    appendFailureActivity(dependencies, principal, "vault_set", { type: "vault", id: storedKey });
    throw error;
  }
}

function vaultDeleteOutcome(
  dependencies: CurrentHostOperationsDependencies,
  vault: FileVaultStore,
  principal: CurrentHostOperatorPrincipal,
  operation: VaultDeleteOperation,
): VaultDeleteOutcome {
  const storedKey = validateVaultKeyName(operation.name);
  try {
    const deleted = vault.delete(storedKey);
    dependencies.activityLog.append({
      actorClientId: principal.clientId,
      action: "vault_deleted",
      target: { type: "vault", id: deleted.key },
      metadata: { deleted: deleted.deleted, grantsRetained: deleted.grantsRetained },
    });
    return { kind: "vault_delete", deleted };
  } catch (error) {
    appendFailureActivity(dependencies, principal, "vault_deleted", {
      type: "vault",
      id: storedKey,
    });
    throw error;
  }
}

function vaultGrantOutcome(
  dependencies: CurrentHostOperationsDependencies,
  vault: FileVaultStore,
  principal: CurrentHostOperatorPrincipal,
  operation: VaultAccessGrantOperation,
): VaultAccessGrantOutcome {
  const storedKey = validateVaultKeyName(operation.storedKey);
  const referenceName = validateVaultKeyName(operation.referenceName);
  const capletId = requiredCapletId(operation.capletId);
  try {
    const grant = vault.grantAccess({
      storedKey,
      referenceName,
      capletId,
      origin: vaultAccessOrigin(capletId, dependencies),
    });
    dependencies.activityLog.append({
      actorClientId: principal.clientId,
      action: "vault_grant_added",
      target: { type: "vault", id: grant.storedKey },
      metadata: {
        referenceName: grant.referenceName,
        capletId: grant.capletId,
        originKind: grant.origin.kind,
      },
    });
    return { kind: "vault_access_grant", grant: redactedVaultGrant(grant) };
  } catch (error) {
    appendFailureActivity(dependencies, principal, "vault_grant_added", {
      type: "vault",
      id: storedKey,
    });
    throw error;
  }
}

function vaultRevokeOutcome(
  dependencies: CurrentHostOperationsDependencies,
  vault: FileVaultStore,
  principal: CurrentHostOperatorPrincipal,
  operation: VaultAccessRevokeOperation,
): VaultAccessRevokeOutcome {
  const storedKey = validateVaultKeyName(operation.storedKey);
  const referenceName =
    operation.referenceName === undefined
      ? undefined
      : validateVaultKeyName(operation.referenceName);
  const capletId =
    operation.capletId === undefined ? undefined : requiredCapletId(operation.capletId);
  try {
    const revoked = vault.revokeAccess({
      storedKey,
      ...(referenceName === undefined ? {} : { referenceName }),
      ...(capletId === undefined ? {} : { capletId }),
    });
    for (const grant of revoked) {
      dependencies.activityLog.append({
        actorClientId: principal.clientId,
        action: "vault_grant_revoked",
        target: { type: "vault", id: grant.storedKey },
        metadata: {
          referenceName: grant.referenceName,
          capletId: grant.capletId,
          originKind: grant.origin.kind,
        },
      });
    }
    return { kind: "vault_access_revoke", revoked: revoked.map(redactedVaultGrant) };
  } catch (error) {
    appendFailureActivity(dependencies, principal, "vault_grant_revoked", {
      type: "vault",
      id: storedKey,
    });
    throw error;
  }
}

function vaultAccessOrigin(capletId: string, dependencies: CurrentHostOperationsDependencies) {
  const control = dependencies.control;
  if (!control) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Vault access grants require server control context.",
    );
  }
  const overlay = loadLocalOverlayConfigWithSources(control.configPath, control.projectConfigPath, {
    vaultResolver: vaultBootstrapResolver,
  });
  const origin = overlay.sources[capletId];
  if (!origin) throw new CapletsError("SERVER_NOT_FOUND", `Caplet ${capletId} is not configured.`);
  if (overlay.shadows[capletId]?.length) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Caplet ${capletId} is shadowed in multiple config sources; resolve the active config before granting Vault access.`,
    );
  }
  return origin;
}

function requiredCapletId(value: unknown): string {
  if (typeof value === "string" && SERVER_ID_PATTERN.test(value)) return value;
  throw new CapletsError("REQUEST_INVALID", "Caplet ID is invalid.");
}

function redactedVaultGrant(grant: {
  storedKey: string;
  referenceName: string;
  capletId: string;
  origin: { kind: string };
  createdAt: string;
  updatedAt: string;
}): CurrentHostVaultAccessGrant {
  return {
    storedKey: grant.storedKey,
    referenceName: grant.referenceName,
    capletId: grant.capletId,
    origin: { kind: grant.origin.kind },
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
  };
}

function appendFailureActivity(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  action: "vault_set" | "vault_deleted" | "vault_grant_added" | "vault_grant_revoked",
  target: { type: "vault"; id: string },
): void {
  dependencies.activityLog.append({
    actorClientId: principal.clientId,
    action,
    outcome: "failure",
    target,
  });
}
