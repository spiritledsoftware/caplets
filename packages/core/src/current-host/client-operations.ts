import { createHash, randomUUID } from "node:crypto";
import { roleChangeMetadata } from "../dashboard/activity-log";
import { CapletsError } from "../errors";
import { finalAuthorizeCurrentHostMutation } from "./operations";
import type {
  CurrentHostManagementInspectResult,
  CurrentHostManagementListResult,
  CurrentHostManagementMutation,
  CurrentHostManagementMutationResult,
  CurrentHostManagementPreviewResult,
  CurrentHostManagementResource,
  CurrentHostManagementStatusResult,
  CurrentHostOperation,
  CurrentHostOperationBinding,
  CurrentHostOperationLookupOutcome,
  CurrentHostOperationOutcome,
  CurrentHostOperatorPrincipal,
  CurrentHostOperations,
  CurrentHostOperationsDependencies,
} from "./operations";

type SummaryOperation = Extract<CurrentHostOperation, { kind: "summary" }>;
type ClientsListOutcome = Extract<CurrentHostOperationOutcome, { kind: "clients_list" }>;
type PendingLoginsListOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "pending_logins_list" }
>;
type PendingLoginApproveOperation = Extract<
  CurrentHostOperation,
  { kind: "pending_login_approve" }
>;
type PendingLoginApproveOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "pending_login_approve" }
>;
type PendingLoginDenyOperation = Extract<CurrentHostOperation, { kind: "pending_login_deny" }>;
type PendingLoginDenyOutcome = Extract<CurrentHostOperationOutcome, { kind: "pending_login_deny" }>;
type ClientRevokeOperation = Extract<CurrentHostOperation, { kind: "client_revoke" }>;
type ClientRevokeOutcome = Extract<CurrentHostOperationOutcome, { kind: "client_revoke" }>;
type ClientChangeRoleOperation = Extract<CurrentHostOperation, { kind: "client_change_role" }>;
type ClientChangeRoleOutcome = Extract<CurrentHostOperationOutcome, { kind: "client_change_role" }>;
type SummaryOutcome = Extract<CurrentHostOperationOutcome, { kind: "summary" }>;

/** Current Host client and Pending Remote Login administration behind the facade. */
export function createCurrentHostClientOperations(dependencies: CurrentHostOperationsDependencies) {
  return {
    summary: async (vaultCount: number, operation: SummaryOperation): Promise<SummaryOutcome> =>
      summaryOutcome(dependencies, vaultCount, operation),
    listClients: async (): Promise<ClientsListOutcome> => ({
      kind: "clients_list",
      clients: await listClientProjection(dependencies),
    }),
    listPendingLogins: async (): Promise<PendingLoginsListOutcome> => ({
      kind: "pending_logins_list",
      pendingLogins: (await pendingLoginProjection(dependencies)).filter(
        (login) => login.status === "pending" || login.status === "approved",
      ),
    }),
    approvePendingLogin: async (
      principal: CurrentHostOperatorPrincipal,
      operation: PendingLoginApproveOperation,
    ): Promise<PendingLoginApproveOutcome> =>
      pendingLoginApprovalOutcome(dependencies, principal, operation),
    denyPendingLogin: async (
      principal: CurrentHostOperatorPrincipal,
      operation: PendingLoginDenyOperation,
    ): Promise<PendingLoginDenyOutcome> =>
      pendingLoginDenialOutcome(dependencies, principal, operation),
    revokeClient: async (
      principal: CurrentHostOperatorPrincipal,
      operation: ClientRevokeOperation,
    ): Promise<ClientRevokeOutcome> => clientRevokeOutcome(dependencies, principal, operation),
    changeClientRole: async (
      principal: CurrentHostOperatorPrincipal,
      operation: ClientChangeRoleOperation,
    ): Promise<ClientChangeRoleOutcome> => clientRoleOutcome(dependencies, principal, operation),
  };
}

async function summaryOutcome(
  dependencies: CurrentHostOperationsDependencies,
  vaultCount: number,
  operation: SummaryOperation,
): Promise<SummaryOutcome> {
  const pendingLogins = await pendingLoginProjection(dependencies);
  const clients = await listClientProjection(dependencies);
  const pending = pendingLogins.filter((login) => login.status === "pending");
  return {
    kind: "summary",
    summary: {
      host: {
        current: true,
        baseUrl: operation.baseUrl,
        dashboardUrl: operation.dashboardUrl,
        version: dependencies.version,
        roleModel: "current-host",
      },
      attention: pending.map((login) => ({
        kind: "pending-login",
        severity: "warning",
        label: `${login.clientLabel} is waiting for ${login.requestedRole} approval`,
        href: `${operation.dashboardPath}#access`,
      })),
      sections: {
        caplets: {
          count: dependencies.engine.enabledServers().length,
          href: `${operation.dashboardPath}#caplets`,
        },
        catalog: { href: `${operation.dashboardPath}#catalog` },
        access: {
          clients: clients.length,
          pending: pending.length,
          href: `${operation.dashboardPath}#access`,
        },
        vault: { count: vaultCount, href: `${operation.dashboardPath}#vault` },
        projectBinding: {
          state: "disconnected",
          href: `${operation.dashboardPath}#project-binding`,
        },
        runtime: { status: "ok", href: `${operation.dashboardPath}#runtime` },
        logs: { href: `${operation.dashboardPath}#logs` },
        diagnostics: { href: `${operation.dashboardPath}#diagnostics` },
        activity: { href: `${operation.dashboardPath}#activity` },
        settings: { href: `${operation.dashboardPath}#settings` },
      },
    },
  };
}

async function pendingLoginApprovalOutcome(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  operation: PendingLoginApproveOperation,
): Promise<PendingLoginApproveOutcome> {
  const flowId = requiredPendingLoginFlowId(operation.flowId);
  if (operation.grantedRole !== undefined) assertRemoteClientRole(operation.grantedRole);
  const store = pendingLoginAuthority(dependencies);
  if (!store) {
    await appendFailureActivity(dependencies, principal, "pending_login_approved", {
      type: "pending_login",
      id: flowId,
    });
    return { kind: "pending_login_approve", status: "credential_store_unavailable" };
  }
  try {
    const finalAuthorization = finalAuthorizeCurrentHostMutation(principal);
    if (finalAuthorization instanceof Promise) await finalAuthorization;
    const pendingLogin = await store.approvePendingLoginFlow({
      flowId,
      ...(operation.grantedRole === undefined ? {} : { grantedRole: operation.grantedRole }),
    });
    await dependencies.activityLog.append({
      actorClientId: principal.clientId,
      action: "pending_login_approved",
      target: { type: "pending_login", id: pendingLogin.flowId },
      metadata: {
        requestedRole: pendingLogin.requestedRole,
        grantedRole: pendingLogin.grantedRole ?? pendingLogin.requestedRole,
      },
    });
    return { kind: "pending_login_approve", pendingLogin };
  } catch (error) {
    if (shouldRecordFailureActivity(error)) {
      await appendFailureActivity(dependencies, principal, "pending_login_approved", {
        type: "pending_login",
        id: flowId,
      });
    }
    throw error;
  }
}

async function pendingLoginDenialOutcome(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  operation: PendingLoginDenyOperation,
): Promise<PendingLoginDenyOutcome> {
  const flowId = requiredPendingLoginFlowId(operation.flowId);
  const store = pendingLoginAuthority(dependencies);
  if (!store) {
    await appendFailureActivity(dependencies, principal, "pending_login_denied", {
      type: "pending_login",
      id: flowId,
    });
    return { kind: "pending_login_deny", status: "credential_store_unavailable" };
  }
  try {
    const finalAuthorization = finalAuthorizeCurrentHostMutation(principal);
    if (finalAuthorization instanceof Promise) await finalAuthorization;
    const pendingLogin = await store.denyPendingLoginFlow({ flowId });
    await dependencies.activityLog.append({
      actorClientId: principal.clientId,
      action: "pending_login_denied",
      target: { type: "pending_login", id: pendingLogin.flowId },
      metadata: { requestedRole: pendingLogin.requestedRole },
    });
    return { kind: "pending_login_deny", pendingLogin };
  } catch (error) {
    if (shouldRecordFailureActivity(error)) {
      await appendFailureActivity(dependencies, principal, "pending_login_denied", {
        type: "pending_login",
        id: flowId,
      });
    }
    throw error;
  }
}

async function clientRevokeOutcome(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  operation: ClientRevokeOperation,
): Promise<ClientRevokeOutcome> {
  const clientId = requiredRemoteClientId(operation.clientId);
  const legacyStore = dependencies.remoteCredentialStore;
  const store = dependencies.remoteCredentialRepository ?? legacyStore;
  if (!store) {
    await appendFailureActivity(dependencies, principal, "remote_client_revoked", {
      type: "remote_client",
      id: clientId,
    });
    return { kind: "client_revoke", status: "credential_store_unavailable", clientId };
  }
  try {
    const finalAuthorization = finalAuthorizeCurrentHostMutation(principal);
    if (finalAuthorization instanceof Promise) await finalAuthorization;
    const revoked = dependencies.remoteCredentialRepository
      ? await dependencies.remoteCredentialRepository.revokeClient(clientId, {
          actorClientId: principal.clientId,
        })
      : await legacyStore!.revokeClient(clientId);
    if (revoked && legacyStore && !dependencies.remoteCredentialRepository) {
      await dependencies.activityLog.append({
        actorClientId: principal.clientId,
        action: "remote_client_revoked",
        target: { type: "remote_client", id: clientId },
      });
    }
    return {
      kind: "client_revoke",
      revoked,
      clientId,
      sessionEnded: revoked && clientId === principal.clientId,
    };
  } catch (error) {
    if (shouldRecordFailureActivity(error)) {
      await appendFailureActivity(dependencies, principal, "remote_client_revoked", {
        type: "remote_client",
        id: clientId,
      });
    }
    throw error;
  }
}

async function clientRoleOutcome(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  operation: ClientChangeRoleOperation,
): Promise<ClientChangeRoleOutcome> {
  const clientId = requiredRemoteClientId(operation.clientId);
  assertRemoteClientRole(operation.role);
  const legacyStore = dependencies.remoteCredentialStore;
  const store = dependencies.remoteCredentialRepository ?? legacyStore;
  if (!store) {
    await appendFailureActivity(dependencies, principal, "remote_client_role_changed", {
      type: "remote_client",
      id: clientId,
    });
    return { kind: "client_change_role", status: "credential_store_unavailable", clientId };
  }
  try {
    const previousLegacyClient = dependencies.remoteCredentialRepository
      ? undefined
      : (await listClientProjection(dependencies)).find(
          (candidate) => candidate.clientId === clientId,
        );
    const finalAuthorization = finalAuthorizeCurrentHostMutation(principal);
    if (finalAuthorization instanceof Promise) await finalAuthorization;
    const client = dependencies.remoteCredentialRepository
      ? await dependencies.remoteCredentialRepository.changeClientRole(clientId, operation.role, {
          actorClientId: principal.clientId,
        })
      : await legacyStore!.changeClientRole(clientId, operation.role);
    if (!client) {
      return { kind: "client_change_role", status: "not_found", clientId, sessionEnded: false };
    }
    const sessionEnded = client.clientId === principal.clientId && client.role !== "operator";
    if (legacyStore && !dependencies.remoteCredentialRepository) {
      await dependencies.activityLog.append({
        actorClientId: principal.clientId,
        action: "remote_client_role_changed",
        target: { type: "remote_client", id: client.clientId },
        metadata: roleChangeMetadata(previousLegacyClient?.role ?? client.role, client.role),
      });
    }
    return { kind: "client_change_role", status: "changed", client, sessionEnded };
  } catch (error) {
    if (shouldRecordFailureActivity(error)) {
      await appendFailureActivity(dependencies, principal, "remote_client_role_changed", {
        type: "remote_client",
        id: clientId,
      });
    }
    throw error;
  }
}

export interface CurrentHostManagementClient {
  readonly target: "global" | "remote";
  readonly identity: Readonly<{
    logicalHostId: string;
    storeId: string;
    operationNamespace: string;
  }>;
  createBinding(
    request: unknown,
    options?: Readonly<{
      operationId?: string | undefined;
      operationClass?: CurrentHostOperationBinding["operationClass"] | undefined;
    }>,
  ): CurrentHostOperationBinding;
  list(resource: CurrentHostManagementResource): Promise<CurrentHostManagementListResult>;
  inspect(
    resource: CurrentHostManagementResource,
    id: string,
    selector: "effective" | "underlying-sql",
  ): Promise<CurrentHostManagementInspectResult>;
  preview(
    mutation: CurrentHostManagementMutation,
    binding?: CurrentHostOperationBinding | undefined,
  ): Promise<CurrentHostManagementPreviewResult>;
  mutate(
    mutation: CurrentHostManagementMutation,
    binding?: CurrentHostOperationBinding | undefined,
  ): Promise<CurrentHostManagementMutationResult>;
  status(): Promise<CurrentHostManagementStatusResult>;
  lookupOperation(binding: CurrentHostOperationBinding): Promise<CurrentHostOperationLookupOutcome>;
}

export function createCurrentHostManagementClient(
  options: Readonly<{
    operations: CurrentHostOperations;
    principal: CurrentHostOperatorPrincipal;
    target: "global" | "remote";
    identity: CurrentHostManagementClient["identity"];
    allocateOperationId?: (() => string) | undefined;
  }>,
): CurrentHostManagementClient {
  const createBinding: CurrentHostManagementClient["createBinding"] = (
    request,
    bindingOptions = {},
  ) => ({
    operationId:
      bindingOptions.operationId ?? options.allocateOperationId?.() ?? `operation_${randomUUID()}`,
    target: options.target,
    ...options.identity,
    actorId: options.principal.clientId,
    requestIdentity: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
    operationClass: bindingOptions.operationClass ?? "logical-state",
  });
  return Object.freeze({
    target: options.target,
    identity: Object.freeze({ ...options.identity }),
    createBinding,
    list(resource: CurrentHostManagementResource) {
      return options.operations.list(options.principal, {
        binding: createBinding({ action: "list", resource }),
        resource,
      });
    },
    inspect(
      resource: CurrentHostManagementResource,
      id: string,
      selector: "effective" | "underlying-sql",
    ) {
      return options.operations.inspect(options.principal, {
        binding: createBinding({ action: "inspect", resource, id, selector }),
        resource,
        id,
        selector,
      });
    },
    preview(
      mutation: CurrentHostManagementMutation,
      binding: CurrentHostOperationBinding = createBinding(mutation),
    ) {
      return options.operations.preview(options.principal, { binding, mutation });
    },
    mutate(
      mutation: CurrentHostManagementMutation,
      binding: CurrentHostOperationBinding = createBinding(mutation),
    ) {
      return options.operations.mutate(options.principal, { binding, mutation });
    },
    status() {
      return options.operations.status(options.principal, createBinding({ action: "status" }));
    },
    lookupOperation(binding: CurrentHostOperationBinding) {
      return options.operations.lookupOperation(options.principal, binding);
    },
  });
}

function requiredRemoteClientId(value: unknown): string {
  if (typeof value === "string" && /^rcli_[A-Za-z0-9_-]{16}$/u.test(value)) return value;
  throw new CapletsError("REQUEST_INVALID", "Remote client ID is invalid.");
}

function requiredPendingLoginFlowId(value: unknown): string {
  if (typeof value === "string" && /^rlogin_[A-Za-z0-9_-]{16}$/u.test(value)) return value;
  throw new CapletsError("REQUEST_INVALID", "Pending login flow ID is invalid.");
}

function assertRemoteClientRole(value: unknown): asserts value is "access" | "operator" {
  if (value === "access" || value === "operator") return;
  throw new CapletsError("REQUEST_INVALID", "Remote client role is invalid.");
}

async function listClientProjection(dependencies: CurrentHostOperationsDependencies) {
  if (dependencies.remoteCredentialRepository) {
    return dependencies.remoteCredentialRepository.listClients();
  }
  return requireLegacyCredentialProjection(dependencies).listClients();
}

async function pendingLoginProjection(dependencies: CurrentHostOperationsDependencies) {
  const store = pendingLoginAuthority(dependencies);
  if (!store) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Current Host pending-login projections require live authority support.",
    );
  }
  return store.listPendingLogins();
}

function pendingLoginAuthority(dependencies: CurrentHostOperationsDependencies) {
  return dependencies.remotePendingLoginRepository ?? dependencies.remoteCredentialStore;
}

function requireLegacyCredentialProjection(
  dependencies: CurrentHostOperationsDependencies,
): NonNullable<CurrentHostOperationsDependencies["remoteCredentialStore"]> {
  if (dependencies.remoteCredentialStore) return dependencies.remoteCredentialStore;
  throw new CapletsError(
    "SERVER_UNAVAILABLE",
    "Current Host client projections require live SQL authority support.",
  );
}

function shouldRecordFailureActivity(error: unknown): boolean {
  return !(
    error instanceof CapletsError &&
    (error.code === "AUTH_FAILED" || error.code === "SERVER_UNAVAILABLE")
  );
}

async function appendFailureActivity(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  action:
    | "pending_login_approved"
    | "pending_login_denied"
    | "remote_client_revoked"
    | "remote_client_role_changed",
  target: { type: "pending_login" | "remote_client"; id: string },
): Promise<void> {
  await dependencies.activityLog.append({
    actorClientId: principal.clientId,
    action,
    outcome: "failure",
    target,
  });
}
