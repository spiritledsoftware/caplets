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
type VaultValuesPageOperation = Extract<CurrentHostOperation, { kind: "vault_values_page" }>;
type VaultDeleteOperation = Extract<CurrentHostOperation, { kind: "vault_delete" }>;
type VaultAccessGrantOperation = Extract<CurrentHostOperation, { kind: "vault_access_grant" }>;
type VaultAccessRevokeOperation = Extract<CurrentHostOperation, { kind: "vault_access_revoke" }>;
type VaultAccessListOperation = Extract<CurrentHostOperation, { kind: "vault_access_list" }>;
type VaultGrantsPageOperation = Extract<CurrentHostOperation, { kind: "vault_grants_page" }>;
type VaultSetOutcome = Extract<CurrentHostOperationOutcome, { kind: "vault_set" }>;
type VaultListOutcome = Extract<CurrentHostOperationOutcome, { kind: "vault_list" }>;
type VaultGetOutcome = Extract<CurrentHostOperationOutcome, { kind: "vault_get" }>;
type VaultValuesPageOutcome = Extract<CurrentHostOperationOutcome, { kind: "vault_values_page" }>;
type VaultDeleteOutcome = Extract<CurrentHostOperationOutcome, { kind: "vault_delete" }>;
type VaultAccessGrantOutcome = Extract<CurrentHostOperationOutcome, { kind: "vault_access_grant" }>;
type VaultAccessRevokeOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "vault_access_revoke" }
>;
type VaultAccessListOutcome = Extract<CurrentHostOperationOutcome, { kind: "vault_access_list" }>;
type VaultGrantsPageOutcome = Extract<CurrentHostOperationOutcome, { kind: "vault_grants_page" }>;

/** Safe Vault administration implementation. Raw value reveal remains in the dashboard adapter. */
export function createCurrentHostVaultOperations(dependencies: CurrentHostOperationsDependencies) {
  const sqlValues = dependencies.vaultValues;
  const sqlGrants = dependencies.vaultGrants;
  const sqlState = dependencies.vaultState;
  if (Boolean(sqlValues) !== Boolean(sqlGrants) || Boolean(sqlValues) !== Boolean(sqlState)) {
    throw new CapletsError(
      "INTERNAL_ERROR",
      "SQL Vault values, grants, and the atomic state coordinator must be configured together.",
    );
  }
  const fileVault = sqlValues ? undefined : vaultStoreForAuthDir(dependencies.control?.authDir);

  return {
    valueCount: async (): Promise<number> =>
      sqlValues ? await sqlValues.countValues() : fileVault!.listValues().length,
    list: async (_operation: VaultListOperation): Promise<VaultListOutcome> => ({
      kind: "vault_list",
      values: sqlValues ? await sqlValues.listValues() : fileVault!.listValues(),
      grants:
        sqlGrants && sqlValues
          ? (await sqlGrants.list()).map(redactedSqlVaultGrant)
          : fileVault!.listAccess().map(redactedVaultGrant),
    }),
    listValuesPage: async (
      operation: VaultValuesPageOperation,
    ): Promise<VaultValuesPageOutcome> => {
      if (!sqlValues) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "Authoritative Vault value state is unavailable.",
        );
      }
      return {
        kind: "vault_values_page",
        page: await sqlValues.listValuesPage({
          limit: operation.limit,
          sort: operation.sort,
          ...(operation.after === undefined ? {} : { after: operation.after }),
        }),
      };
    },
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
    listAccess: async (operation: VaultAccessListOperation): Promise<VaultAccessListOutcome> => {
      let grants: CurrentHostVaultAccessGrant[];
      if (
        operation.storedKey !== undefined &&
        operation.capletId !== undefined &&
        operation.referenceName !== undefined
      ) {
        const capletId = requiredCapletId(operation.capletId);
        const storedKey = validateVaultKeyName(operation.storedKey);
        const referenceName = validateVaultKeyName(operation.referenceName);
        const origin = vaultAccessOrigin(capletId, dependencies);
        if (sqlGrants) {
          const grant = await sqlGrants.get({
            capletId,
            vaultKey: storedKey,
            referenceName,
            originKind: origin.kind,
            originPath: origin.path,
          });
          grants = grant === undefined ? [] : [redactedSqlVaultGrant(grant)];
        } else {
          grants = fileVault!
            .listAccess({ storedKey, capletId, referenceName, origin })
            .slice(0, 1)
            .map(redactedVaultGrant);
        }
      } else {
        grants = sqlGrants
          ? (
              await sqlGrants.list(
                operation.capletId,
                activeVaultGrantOrigins(dependencies, operation.capletId),
              )
            )
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
              .map(redactedVaultGrant);
      }
      return { kind: "vault_access_list", grants };
    },
    listGrantsPage: async (
      operation: VaultGrantsPageOperation,
    ): Promise<VaultGrantsPageOutcome> => {
      if (!sqlGrants) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "Authoritative Vault grant state is unavailable.",
        );
      }
      const page = await sqlGrants.listPage({
        limit: operation.limit,
        sort: operation.sort,
        ...(operation.after === undefined ? {} : { after: operation.after }),
        ...(operation.storedKey === undefined ? {} : { vaultKey: operation.storedKey }),
        ...(operation.capletId === undefined ? {} : { capletId: operation.capletId }),
        activeOrigins: activeVaultGrantOrigins(dependencies, operation.capletId),
      });
      return {
        kind: "vault_grants_page",
        page: {
          items: page.items.map(redactedSqlVaultGrant),
          ...(page.nextKey === undefined ? {} : { nextKey: page.nextKey }),
        },
      };
    },
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
  const force = operation.force ?? false;
  const valueCreateOnly =
    operation.createOnly ?? (operation.expectedGeneration === undefined ? !force : undefined);
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
          ...(operation.expectedGrantResourceVersion === undefined
            ? { createOnly: operation.grantCreateOnly ?? valueCreateOnly ?? true }
            : {}),
          ...(operation.expectedGrantResourceVersion === undefined
            ? {}
            : { expectedResourceVersion: operation.expectedGrantResourceVersion }),
        };
  if (!state) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Atomic Vault state is unavailable.");
  }
  const status = await state.setValueAndGrant({
    key: storedKey,
    value: operation.value,
    force,
    ...(valueCreateOnly === undefined ? {} : { createOnly: valueCreateOnly }),
    ...(operation.expectedGeneration === undefined
      ? {}
      : { expectedGeneration: operation.expectedGeneration }),
    ...(grant === undefined ? {} : { grant }),
    ...(operation.grantCreateOnly === undefined
      ? {}
      : { grantCreateOnly: operation.grantCreateOnly }),
    operatorClientId: principal.clientId,
  });
  await dependencies.activateConfig?.();
  return { kind: "vault_set", status };
}

async function sqlVaultDeleteOutcome(
  dependencies: CurrentHostOperationsDependencies,
  values: VaultValueRepository,
  grants: VaultGrantStore,
  principal: CurrentHostOperatorPrincipal,
  operation: VaultDeleteOperation,
): Promise<VaultDeleteOutcome> {
  const storedKey = validateVaultKeyName(operation.name);
  const retained = await grants.countByVaultKey(storedKey);
  const deleted = await values.delete(storedKey, {
    expectedGeneration: operation.expectedGeneration,
    operatorClientId: principal.clientId,
  });
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
    ...(operation.expectedResourceVersion === undefined
      ? { createOnly: operation.createOnly ?? false }
      : { expectedResourceVersion: operation.expectedResourceVersion }),
    operator: sqlOperator(principal),
  });
  const grant = await grants.get({
    capletId,
    vaultKey: storedKey,
    referenceName,
    originKind: origin.kind,
    originPath: origin.path,
  });
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
  if (
    operation.expectedResourceVersion !== undefined &&
    (capletId === undefined || referenceName === undefined)
  ) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Conditional Vault grant revoke requires Caplet ID and reference name.",
    );
  }
  const revoked: StoredVaultGrant[] = [];
  if (
    operation.expectedResourceVersion !== undefined &&
    capletId !== undefined &&
    referenceName !== undefined
  ) {
    const origin = vaultAccessOrigin(capletId, dependencies);
    const candidate = await grants.get({
      capletId,
      vaultKey: storedKey,
      referenceName,
      originKind: origin.kind,
      originPath: origin.path,
    });
    const removed = await grants.revoke({
      capletId,
      vaultKey: storedKey,
      referenceName,
      originKind: origin.kind,
      originPath: origin.path,
      expectedResourceVersion: operation.expectedResourceVersion,
      operator: sqlOperator(principal),
    });
    if (removed && candidate) revoked.push(candidate);
  } else {
    const candidates = await grants.listMatching({
      vaultKey: storedKey,
      ...(capletId === undefined ? {} : { capletId }),
      ...(referenceName === undefined ? {} : { referenceName }),
    });
    for (const grant of candidates) {
      const removed = await grants.revoke({
        capletId: grant.capletId,
        vaultKey: grant.vaultKey,
        referenceName: grant.referenceName,
        originKind: grant.originKind,
        ...(grant.originPath === null ? {} : { originPath: grant.originPath }),
        operator: sqlOperator(principal),
      });
      if (removed) revoked.push(grant);
    }
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
    resourceVersion: grant.resourceVersion,
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
    (operation.capletId === undefined || grant.capletId === requiredCapletId(operation.capletId)) &&
    (operation.referenceName === undefined ||
      grant.referenceName === validateVaultKeyName(operation.referenceName))
  );
}

function sqlOperator(principal: CurrentHostOperatorPrincipal) {
  return { role: "operator" as const, clientId: principal.clientId };
}

async function vaultSetOutcome(
  dependencies: CurrentHostOperationsDependencies,
  vault: FileVaultStore,
  principal: CurrentHostOperatorPrincipal,
  operation: VaultSetOperation,
): Promise<VaultSetOutcome> {
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
    await dependencies.activityLog.append({
      actorClientId: principal.clientId,
      action: "vault_set",
      target: { type: "vault", id: status.key },
      metadata: { bytesWritten: status.valueBytes ?? null },
    });
    if (grant) {
      await dependencies.activityLog.append({
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
    await appendFailureActivity(dependencies, principal, "vault_set", {
      type: "vault",
      id: storedKey,
    });
    throw error;
  }
}

async function vaultDeleteOutcome(
  dependencies: CurrentHostOperationsDependencies,
  vault: FileVaultStore,
  principal: CurrentHostOperatorPrincipal,
  operation: VaultDeleteOperation,
): Promise<VaultDeleteOutcome> {
  const storedKey = validateVaultKeyName(operation.name);
  try {
    const deleted = vault.delete(storedKey);
    await dependencies.activityLog.append({
      actorClientId: principal.clientId,
      action: "vault_deleted",
      target: { type: "vault", id: deleted.key },
      metadata: { deleted: deleted.deleted, grantsRetained: deleted.grantsRetained },
    });
    return { kind: "vault_delete", deleted };
  } catch (error) {
    await appendFailureActivity(dependencies, principal, "vault_deleted", {
      type: "vault",
      id: storedKey,
    });
    throw error;
  }
}

async function vaultGrantOutcome(
  dependencies: CurrentHostOperationsDependencies,
  vault: FileVaultStore,
  principal: CurrentHostOperatorPrincipal,
  operation: VaultAccessGrantOperation,
): Promise<VaultAccessGrantOutcome> {
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
    await dependencies.activityLog.append({
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
    await appendFailureActivity(dependencies, principal, "vault_grant_added", {
      type: "vault",
      id: storedKey,
    });
    throw error;
  }
}

async function vaultRevokeOutcome(
  dependencies: CurrentHostOperationsDependencies,
  vault: FileVaultStore,
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
  try {
    const revoked = vault.revokeAccess({
      storedKey,
      ...(referenceName === undefined ? {} : { referenceName }),
      ...(capletId === undefined ? {} : { capletId }),
    });
    for (const grant of revoked) {
      await dependencies.activityLog.append({
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
    await appendFailureActivity(dependencies, principal, "vault_grant_revoked", {
      type: "vault",
      id: storedKey,
    });
    throw error;
  }
}
function activeVaultGrantOrigins(
  dependencies: CurrentHostOperationsDependencies,
  capletId?: string,
) {
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
  return Object.entries(overlay.sources)
    .filter(([configuredCapletId]) => capletId === undefined || configuredCapletId === capletId)
    .map(([configuredCapletId, origin]) => ({
      capletId: configuredCapletId,
      originKind: origin.kind,
      originPath: origin.path,
    }));
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

async function appendFailureActivity(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  action: "vault_set" | "vault_deleted" | "vault_grant_added" | "vault_grant_revoked",
  target: { type: "vault"; id: string },
): Promise<void> {
  await dependencies.activityLog.append({
    actorClientId: principal.clientId,
    action,
    outcome: "failure",
    target,
  });
}
