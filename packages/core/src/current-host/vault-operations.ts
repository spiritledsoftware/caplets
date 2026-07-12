import {
  loadLocalOverlayConfigWithSources,
  vaultBootstrapResolver,
  vaultStoreForAuthDir,
} from "../config";
import { SERVER_ID_PATTERN } from "../config/validation";
import { CapletsError } from "../errors";
import {
  type VaultAdministrationStore,
  type VaultAccessGrantInput,
  type VaultMutationOptions,
  type VaultSetWithGrantResult,
  validateVaultKeyName,
} from "../vault";
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

export interface CurrentHostVaultOperations {
  valueCount(): Promise<number>;
  list(operation: VaultListOperation): Promise<VaultListOutcome>;
  get(operation: VaultGetOperation): Promise<VaultGetOutcome>;
  set(
    principal: CurrentHostOperatorPrincipal,
    operation: VaultSetOperation,
  ): Promise<VaultSetOutcome>;
  delete(
    principal: CurrentHostOperatorPrincipal,
    operation: VaultDeleteOperation,
  ): Promise<VaultDeleteOutcome>;
  grant(
    principal: CurrentHostOperatorPrincipal,
    operation: VaultAccessGrantOperation,
  ): Promise<VaultAccessGrantOutcome>;
  revoke(
    principal: CurrentHostOperatorPrincipal,
    operation: VaultAccessRevokeOperation,
  ): Promise<VaultAccessRevokeOutcome>;
  listAccess(operation: VaultAccessListOperation): Promise<VaultAccessListOutcome>;
}

/** Safe Vault administration implementation. Raw value reveal remains in the dashboard adapter. */
export function createCurrentHostVaultOperations(
  dependencies: CurrentHostOperationsDependencies,
): CurrentHostVaultOperations {
  const vault =
    dependencies.vaultStore ?? fileVaultAdministrationStore(dependencies.control?.authDir);
  return {
    valueCount: async (): Promise<number> => (await vault.listValues()).length,
    list: async (_operation: VaultListOperation): Promise<VaultListOutcome> => {
      const [values, grants] = await Promise.all([vault.listValues(), vault.listAccess()]);
      return {
        kind: "vault_list",
        values,
        grants: grants.map(redactedVaultGrant),
      };
    },
    get: async (operation: VaultGetOperation): Promise<VaultGetOutcome> => ({
      kind: "vault_get",
      status: await vault.getStatus(validateVaultKeyName(operation.name)),
    }),
    set: async (
      principal: CurrentHostOperatorPrincipal,
      operation: VaultSetOperation,
    ): Promise<VaultSetOutcome> => await vaultSetOutcome(dependencies, vault, principal, operation),
    delete: async (
      principal: CurrentHostOperatorPrincipal,
      operation: VaultDeleteOperation,
    ): Promise<VaultDeleteOutcome> =>
      await vaultDeleteOutcome(dependencies, vault, principal, operation),
    grant: async (
      principal: CurrentHostOperatorPrincipal,
      operation: VaultAccessGrantOperation,
    ): Promise<VaultAccessGrantOutcome> =>
      await vaultGrantOutcome(dependencies, vault, principal, operation),
    revoke: async (
      principal: CurrentHostOperatorPrincipal,
      operation: VaultAccessRevokeOperation,
    ): Promise<VaultAccessRevokeOutcome> =>
      await vaultRevokeOutcome(dependencies, vault, principal, operation),
    listAccess: async (operation: VaultAccessListOperation): Promise<VaultAccessListOutcome> => ({
      kind: "vault_access_list",
      grants: (
        await vault.listAccess({
          ...(operation.storedKey === undefined
            ? {}
            : { storedKey: validateVaultKeyName(operation.storedKey) }),
          ...(operation.capletId === undefined
            ? {}
            : { capletId: requiredCapletId(operation.capletId) }),
        })
      ).map(redactedVaultGrant),
    }),
  };
}
function fileVaultAdministrationStore(authDir: string | undefined): VaultAdministrationStore & {
  resolveValue(key: string): Promise<string>;
} {
  const file = vaultStoreForAuthDir(authDir);
  return {
    set: async (key, value, options) => file.set(key, value, options),
    getStatus: async (key) => file.getStatus(key),
    listValues: async () => file.listValues(),
    delete: async (key, _options) => file.delete(key),
    grantAccess: async (input, _options) => file.grantAccess(input),
    listAccess: async (filter) => file.listAccess(filter),
    revokeAccess: async (filter, _options) => file.revokeAccess(filter),
    resolveValue: async (key) => file.resolveValue(key),
  };
}

async function vaultSetOutcome(
  dependencies: CurrentHostOperationsDependencies,
  vault: VaultAdministrationStore,
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
    const mutationOptions: VaultMutationOptions = {
      force: operation.force ?? false,
      ...(operation.expectedGeneration === undefined
        ? {}
        : { expectedGeneration: operation.expectedGeneration }),
      ...(operation.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: operation.idempotencyKey }),
    };
    let status;
    let grant;
    let setWithGrantResult: VaultSetWithGrantResult | undefined;
    if (grantInput && vault.setWithGrant) {
      setWithGrantResult = await vault.setWithGrant(storedKey, operation.value, {
        ...mutationOptions,
        grant: grantInput,
      });
      status = setWithGrantResult.status;
      grant = setWithGrantResult.grant;
    } else {
      const existed = (await vault.getStatus(storedKey)).present;
      const rollbackVault = vault as VaultAdministrationStore & {
        resolveValue?: (key: string) => Promise<string>;
      };
      const previousValue =
        existed && grantInput && rollbackVault.resolveValue
          ? await rollbackVault.resolveValue(storedKey)
          : undefined;
      status = await vault.set(storedKey, operation.value, mutationOptions);
      try {
        grant = grantInput ? await vault.grantAccess(grantInput, mutationOptions) : undefined;
      } catch (error) {
        if (existed && previousValue !== undefined) {
          await vault.set(storedKey, previousValue, { ...mutationOptions, force: true });
        } else {
          await vault.delete(storedKey, mutationOptions);
        }
        throw error;
      }
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

async function vaultDeleteOutcome(
  dependencies: CurrentHostOperationsDependencies,
  vault: VaultAdministrationStore,
  principal: CurrentHostOperatorPrincipal,
  operation: VaultDeleteOperation,
): Promise<VaultDeleteOutcome> {
  const storedKey = validateVaultKeyName(operation.name);
  const mutationOptions: VaultMutationOptions = {
    ...(operation.expectedGeneration === undefined
      ? {}
      : { expectedGeneration: operation.expectedGeneration }),
    ...(operation.idempotencyKey === undefined ? {} : { idempotencyKey: operation.idempotencyKey }),
  };
  try {
    const deleted = await vault.delete(storedKey, mutationOptions);
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

async function vaultGrantOutcome(
  dependencies: CurrentHostOperationsDependencies,
  vault: VaultAdministrationStore,
  principal: CurrentHostOperatorPrincipal,
  operation: VaultAccessGrantOperation,
): Promise<VaultAccessGrantOutcome> {
  const storedKey = validateVaultKeyName(operation.storedKey);
  const referenceName = validateVaultKeyName(operation.referenceName);
  const capletId = requiredCapletId(operation.capletId);
  const mutationOptions: VaultMutationOptions = {
    ...(operation.expectedGeneration === undefined
      ? {}
      : { expectedGeneration: operation.expectedGeneration }),
    ...(operation.idempotencyKey === undefined ? {} : { idempotencyKey: operation.idempotencyKey }),
  };
  try {
    const grant = await vault.grantAccess(
      {
        storedKey,
        referenceName,
        capletId,
        origin: vaultAccessOrigin(capletId, dependencies),
      },
      mutationOptions,
    );
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

async function vaultRevokeOutcome(
  dependencies: CurrentHostOperationsDependencies,
  vault: VaultAdministrationStore,
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
  const mutationOptions: VaultMutationOptions = {
    ...(operation.expectedGeneration === undefined
      ? {}
      : { expectedGeneration: operation.expectedGeneration }),
    ...(operation.idempotencyKey === undefined ? {} : { idempotencyKey: operation.idempotencyKey }),
  };
  try {
    const revoked = await vault.revokeAccess(
      {
        storedKey,
        ...(referenceName === undefined ? {} : { referenceName }),
        ...(capletId === undefined ? {} : { capletId }),
      },
      mutationOptions,
    );
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
  if (dependencies.vaultStore && dependencies.activeGeneration) {
    if (dependencies.stagedProvenance?.[capletId]) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Shared Vault grants require authority-backed Caplet provenance.",
      );
    }
    const generation = dependencies.activeGeneration;
    const snapshot = isRecord(generation.snapshot) ? generation.snapshot : {};
    const records = isRecord(snapshot.caplets)
      ? Object.entries(snapshot.caplets)
      : isRecord(snapshot.records)
        ? Object.entries(snapshot.records)
        : [];
    const matching = records.find(
      ([id, record]) => id === capletId || (isRecord(record) && record.id === capletId),
    );
    const recordId = matching?.[0] ?? (isRecord(snapshot.config) ? "snapshot" : capletId);
    return {
      kind: "authority" as const,
      authorityId: generation.authorityId,
      recordId,
      generationId: generation.id,
    };
  }
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
