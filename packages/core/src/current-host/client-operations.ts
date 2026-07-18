import { roleChangeMetadata } from "../dashboard/activity-log";
import { CapletsError } from "../errors";
import { RemoteServerCredentialStore } from "../remote/server-credential-store";
import { RemoteSecurityStore } from "../storage/remote-security";
import type {
  CurrentHostOperation,
  CurrentHostOperationOutcome,
  CurrentHostOperatorPrincipal,
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
      await summaryOutcome(dependencies, vaultCount, operation),
    listClients: async (): Promise<ClientsListOutcome> => ({
      kind: "clients_list",
      clients: (await dependencies.remoteCredentialStore?.listClients()) ?? [],
    }),
    listPendingLogins: async (): Promise<PendingLoginsListOutcome> => ({
      kind: "pending_logins_list",
      pendingLogins: ((await dependencies.remoteCredentialStore?.listPendingLogins()) ?? []).filter(
        (login) => login.status === "pending" || login.status === "approved",
      ),
    }),
    approvePendingLogin: async (
      principal: CurrentHostOperatorPrincipal,
      operation: PendingLoginApproveOperation,
    ): Promise<PendingLoginApproveOutcome> =>
      await pendingLoginApprovalOutcome(dependencies, principal, operation),
    denyPendingLogin: async (
      principal: CurrentHostOperatorPrincipal,
      operation: PendingLoginDenyOperation,
    ): Promise<PendingLoginDenyOutcome> =>
      await pendingLoginDenialOutcome(dependencies, principal, operation),
    revokeClient: async (
      principal: CurrentHostOperatorPrincipal,
      operation: ClientRevokeOperation,
    ): Promise<ClientRevokeOutcome> =>
      await clientRevokeOutcome(dependencies, principal, operation),
    changeClientRole: async (
      principal: CurrentHostOperatorPrincipal,
      operation: ClientChangeRoleOperation,
    ): Promise<ClientChangeRoleOutcome> =>
      await clientRoleOutcome(dependencies, principal, operation),
  };
}

async function summaryOutcome(
  dependencies: CurrentHostOperationsDependencies,
  vaultCount: number,
  operation: SummaryOperation,
): Promise<SummaryOutcome> {
  const pendingLogins = (await dependencies.remoteCredentialStore?.listPendingLogins()) ?? [];
  const clients = (await dependencies.remoteCredentialStore?.listClients()) ?? [];
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
  const store = dependencies.remoteCredentialStore;
  if (!store) {
    appendFailureActivity(dependencies, principal, "pending_login_approved", {
      type: "pending_login",
      id: flowId,
    });
    return { kind: "pending_login_approve", status: "credential_store_unavailable" };
  }
  try {
    const pendingLogin =
      store instanceof RemoteSecurityStore
        ? await store.approvePendingLoginFlow({
            operatorClientId: principal.clientId,
            flowId,
            ...(operation.grantedRole === undefined ? {} : { grantedRole: operation.grantedRole }),
          })
        : store.approvePendingLoginFlow({
            flowId,
            ...(operation.grantedRole === undefined ? {} : { grantedRole: operation.grantedRole }),
          });
    dependencies.activityLog.append({
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
    appendFailureActivity(dependencies, principal, "pending_login_approved", {
      type: "pending_login",
      id: flowId,
    });
    throw error;
  }
}

async function pendingLoginDenialOutcome(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  operation: PendingLoginDenyOperation,
): Promise<PendingLoginDenyOutcome> {
  const flowId = requiredPendingLoginFlowId(operation.flowId);
  const store = dependencies.remoteCredentialStore;
  if (!store) {
    appendFailureActivity(dependencies, principal, "pending_login_denied", {
      type: "pending_login",
      id: flowId,
    });
    return { kind: "pending_login_deny", status: "credential_store_unavailable" };
  }
  try {
    const pendingLogin =
      store instanceof RemoteSecurityStore
        ? await store.denyPendingLoginFlow({ operatorClientId: principal.clientId, flowId })
        : store.denyPendingLoginFlow({ flowId });
    dependencies.activityLog.append({
      actorClientId: principal.clientId,
      action: "pending_login_denied",
      target: { type: "pending_login", id: pendingLogin.flowId },
      metadata: { requestedRole: pendingLogin.requestedRole },
    });
    return { kind: "pending_login_deny", pendingLogin };
  } catch (error) {
    appendFailureActivity(dependencies, principal, "pending_login_denied", {
      type: "pending_login",
      id: flowId,
    });
    throw error;
  }
}

async function clientRevokeOutcome(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  operation: ClientRevokeOperation,
): Promise<ClientRevokeOutcome> {
  const clientId = requiredRemoteClientId(operation.clientId);
  const store = dependencies.remoteCredentialStore;
  if (!store) {
    appendFailureActivity(dependencies, principal, "remote_client_revoked", {
      type: "remote_client",
      id: clientId,
    });
    return { kind: "client_revoke", status: "credential_store_unavailable", clientId };
  }
  try {
    const client = (await store.listClients()).find((candidate) => candidate.clientId === clientId);
    const revoked =
      store instanceof RemoteServerCredentialStore
        ? store.revokeClient(clientId)
        : await store.revokeClient({ operatorClientId: principal.clientId, clientId });
    if (revoked && !client?.revokedAt) {
      dependencies.activityLog.append({
        actorClientId: principal.clientId,
        action: "remote_client_revoked",
        target: { type: "remote_client", id: clientId },
        metadata: { role: client?.role ?? null },
      });
    }
    return {
      kind: "client_revoke",
      revoked,
      clientId,
      sessionEnded: revoked && clientId === principal.clientId,
    };
  } catch (error) {
    appendFailureActivity(dependencies, principal, "remote_client_revoked", {
      type: "remote_client",
      id: clientId,
    });
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
  const store = dependencies.remoteCredentialStore;
  if (!store) {
    appendFailureActivity(dependencies, principal, "remote_client_role_changed", {
      type: "remote_client",
      id: clientId,
    });
    return { kind: "client_change_role", status: "credential_store_unavailable", clientId };
  }
  try {
    const before = (await store.listClients()).find((candidate) => candidate.clientId === clientId);
    const client =
      store instanceof RemoteServerCredentialStore
        ? store.changeClientRole(clientId, operation.role)
        : await store.changeClientRole({
            operatorClientId: principal.clientId,
            clientId,
            role: operation.role,
          });
    if (!client) {
      return { kind: "client_change_role", status: "not_found", clientId, sessionEnded: false };
    }
    const sessionEnded = client.clientId === principal.clientId && client.role !== "operator";
    dependencies.activityLog.append({
      actorClientId: principal.clientId,
      action: "remote_client_role_changed",
      target: { type: "remote_client", id: client.clientId },
      metadata: roleChangeMetadata(before?.role ?? client.role, client.role),
    });
    return { kind: "client_change_role", status: "changed", client, sessionEnded };
  } catch (error) {
    appendFailureActivity(dependencies, principal, "remote_client_role_changed", {
      type: "remote_client",
      id: clientId,
    });
    throw error;
  }
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

function appendFailureActivity(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  action:
    | "pending_login_approved"
    | "pending_login_denied"
    | "remote_client_revoked"
    | "remote_client_role_changed",
  target: { type: "pending_login" | "remote_client"; id: string },
): void {
  dependencies.activityLog.append({
    actorClientId: principal.clientId,
    action,
    outcome: "failure",
    target,
  });
}
