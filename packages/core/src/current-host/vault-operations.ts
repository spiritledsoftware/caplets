import {
  loadLocalOverlayConfigWithSources,
  vaultBootstrapResolver,
  vaultStoreForAuthDir,
} from "../config";
import { SERVER_ID_PATTERN } from "../config/validation";
import { CapletsError } from "../errors";
import { FileVaultStore, validateVaultKeyName, type VaultAccessGrantInput } from "../vault";
import type { StoredVaultGrant, VaultGrantInput, VaultGrantStore } from "../storage/vault-grants";
import type { VaultStateStore } from "../storage/vault-state";
import type { VaultValueRepository } from "../storage/vault-values";
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
  const sqlValues = dependencies.vaultValues;
  const sqlGrants = dependencies.vaultGrants;
  const sqlState = dependencies.vaultState;
  if (Boolean(sqlValues) !== Boolean(sqlGrants)) {
    throw new CapletsError(
      "INTERNAL_ERROR",
      "SQL Vault values and grants must be configured together.",
    );
  }
  const fileVault = sqlValues ? undefined : vaultStoreForAuthDir(dependencies.control?.authDir);

  return {
    valueCount: async (): Promise<number> =>
      sqlValues ? (await sqlValues.listValues()).length : fileVault!.listValues().length,
    list: async (_operation: VaultListOperation): Promise<VaultListOutcome> => ({
      kind: "vault_list",
      values: sqlValues ? await sqlValues.listValues() : fileVault!.listValues(),
      grants:
        sqlGrants && sqlValues
          ? (await sqlGrants.list()).map(redactedSqlVaultGrant)
          : fileVault!.listAccess().map(redactedVaultGrant),
    }),
    get: async (operation: VaultGetOperation): Promise<VaultGetOutcome> => ({
      kind: "vault_get",
      status: sqlValues
        ? await sqlValues.getStatus(validateVaultKeyName(operation.name))
        : fileVault!.getStatus(validateVaultKeyName(operation.name)),
    }),
    set: async (
      principal: CurrentHostOperatorPrincipal,
      operation: VaultSetOperation,
    ): Promise<VaultSetOutcome> =>
      sqlValues && sqlGrants
        ? await sqlVaultSetOutcome(
            dependencies,
            sqlValues,
            sqlGrants,
            sqlState,
            principal,
            operation,
          )
        : vaultSetOutcome(dependencies, fileVault!, principal, operation),
    delete: async (
      principal: CurrentHostOperatorPrincipal,
      operation: VaultDeleteOperation,
    ): Promise<VaultDeleteOutcome> =>
      sqlValues && sqlGrants
        ? await sqlVaultDeleteOutcome(dependencies, sqlValues, sqlGrants, principal, operation)
        : vaultDeleteOutcome(dependencies, fileVault!, principal, operation),
    grant: async (
      principal: CurrentHostOperatorPrincipal,
      operation: VaultAccessGrantOperation,
    ): Promise<VaultAccessGrantOutcome> =>
      sqlGrants
        ? await sqlVaultGrantOutcome(dependencies, sqlGrants, principal, operation)
        : vaultGrantOutcome(dependencies, fileVault!, principal, operation),
    revoke: async (
      principal: CurrentHostOperatorPrincipal,
      operation: VaultAccessRevokeOperation,
    ): Promise<VaultAccessRevokeOutcome> =>
      sqlGrants
        ? await sqlVaultRevokeOutcome(dependencies, sqlGrants, principal, operation)
        : vaultRevokeOutcome(dependencies, fileVault!, principal, operation),
    listAccess: async (operation: VaultAccessListOperation): Promise<VaultAccessListOutcome> => ({
      kind: "vault_access_list",
      grants: sqlGrants
        ? (await sqlGrants.list(operation.capletId))
            .filter((grant) => sqlGrantMatches(grant, operation))
            .map(redactedSqlVaultGrant)
        : fileVault!
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

async function sqlVaultSetOutcome(
  dependencies: CurrentHostOperationsDependencies,
  values: VaultValueRepository,
  grants: VaultGrantStore,
  state: VaultStateStore | undefined,
  principal: CurrentHostOperatorPrincipal,
  operation: VaultSetOperation,
): Promise<VaultSetOutcome> {
  const storedKey = validateVaultKeyName(operation.name);
  const capletId = operation.grant === undefined ? undefined : requiredCapletId(operation.grant);
  const referenceName =
    capletId === undefined ? undefined : validateVaultKeyName(operation.referenceName ?? storedKey);
  const origin = capletId === undefined ? undefined : vaultAccessOrigin(capletId, dependencies);
  const grant: VaultGrantInput | undefined =
    capletId === undefined || referenceName === undefined || origin === undefined
      ? undefined
      : {
          capletId,
          vaultKey: storedKey,
          referenceName,
          originKind: origin.kind,
          originPath: origin.path,
          operator: sqlOperator(principal),
        };
  const force = operation.force ?? false;
  const status = state
    ? await state.setValueAndGrant({
        key: storedKey,
        value: operation.value,
        force,
        ...(grant === undefined ? {} : { grant }),
        operatorClientId: principal.clientId,
      })
    : await setValueAndGrantWithRepositories(values, grants, {
        key: storedKey,
        value: operation.value,
        force,
        grant,
        operatorClientId: principal.clientId,
      });
  await dependencies.invalidateConfig?.(principal.clientId);
  return { kind: "vault_set", status };
}

async function setValueAndGrantWithRepositories(
  values: VaultValueRepository,
  grants: VaultGrantStore,
  input: {
    key: string;
    value: string;
    force: boolean;
    grant: VaultGrantInput | undefined;
    operatorClientId: string;
  },
) {
  const status = await values.set(input.key, input.value, {
    force: input.force,
    operatorClientId: input.operatorClientId,
  });
  if (input.grant) await grants.grant(input.grant);
  return status;
}

async function sqlVaultDeleteOutcome(
  dependencies: CurrentHostOperationsDependencies,
  values: VaultValueRepository,
  grants: VaultGrantStore,
  principal: CurrentHostOperatorPrincipal,
  operation: VaultDeleteOperation,
): Promise<VaultDeleteOutcome> {
  const storedKey = validateVaultKeyName(operation.name);
  const retained = (await grants.list()).filter((grant) => grant.vaultKey === storedKey).length;
  const deleted = await values.delete(storedKey, { operatorClientId: principal.clientId });
  if (deleted.deleted) await dependencies.invalidateConfig?.(principal.clientId);
  return {
    kind: "vault_delete",
    deleted: { key: storedKey, deleted: deleted.deleted, grantsRetained: retained },
  };
}

async function sqlVaultGrantOutcome(
  dependencies: CurrentHostOperationsDependencies,
  grants: VaultGrantStore,
  principal: CurrentHostOperatorPrincipal,
  operation: VaultAccessGrantOperation,
): Promise<VaultAccessGrantOutcome> {
  const storedKey = validateVaultKeyName(operation.storedKey);
  const referenceName = validateVaultKeyName(operation.referenceName);
  const capletId = requiredCapletId(operation.capletId);
  const origin = vaultAccessOrigin(capletId, dependencies);
  await grants.grant({
    capletId,
    vaultKey: storedKey,
    referenceName,
    originKind: origin.kind,
    originPath: origin.path,
    operator: sqlOperator(principal),
  });
  const grant = (await grants.list(capletId)).find(
    (candidate) => candidate.vaultKey === storedKey && candidate.referenceName === referenceName,
  );
  if (!grant) {
    throw new CapletsError("INTERNAL_ERROR", "Stored Vault access grant could not be reloaded.");
  }
  await dependencies.invalidateConfig?.(principal.clientId);
  return { kind: "vault_access_grant", grant: redactedSqlVaultGrant(grant) };
}

async function sqlVaultRevokeOutcome(
  dependencies: CurrentHostOperationsDependencies,
  grants: VaultGrantStore,
  principal: CurrentHostOperatorPrincipal,
  operation: VaultAccessRevokeOperation,
): Promise<VaultAccessRevokeOutcome> {
  const storedKey = validateVaultKeyName(operation.storedKey);
  const referenceName =
    operation.referenceName === undefined
      ? undefined
      : validateVaultKeyName(operation.referenceName);
  const capletId =
    operation.capletId === undefined ? undefined : requiredCapletId(operation.capletId);
  const candidates = (await grants.list(capletId)).filter(
    (grant) =>
      grant.vaultKey === storedKey &&
      (referenceName === undefined || grant.referenceName === referenceName),
  );
  const revoked: StoredVaultGrant[] = [];
  for (const grant of candidates) {
    const removed = await grants.revoke({
      capletId: grant.capletId,
      vaultKey: grant.vaultKey,
      referenceName: grant.referenceName,
      operator: sqlOperator(principal),
    });
    if (removed) revoked.push(grant);
  }
  if (revoked.length > 0) await dependencies.invalidateConfig?.(principal.clientId);
  return { kind: "vault_access_revoke", revoked: revoked.map(redactedSqlVaultGrant) };
}

function redactedSqlVaultGrant(grant: StoredVaultGrant): CurrentHostVaultAccessGrant {
  return {
    storedKey: grant.vaultKey,
    referenceName: grant.referenceName,
    capletId: grant.capletId,
    origin: { kind: grant.originKind },
    createdAt: grant.createdAt,
    updatedAt: grant.createdAt,
  };
}

function sqlGrantMatches(grant: StoredVaultGrant, operation: VaultAccessListOperation): boolean {
  if (
    operation.storedKey !== undefined &&
    grant.vaultKey !== validateVaultKeyName(operation.storedKey)
  ) {
    return false;
  }
  return (
    operation.capletId === undefined || grant.capletId === requiredCapletId(operation.capletId)
  );
}

function sqlOperator(principal: CurrentHostOperatorPrincipal) {
  return { role: "operator" as const, clientId: principal.clientId };
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
