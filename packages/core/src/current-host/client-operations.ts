import { roleChangeMetadata } from "../dashboard/activity-log";
import { CapletsError } from "../errors";
import { RemoteServerCredentialStore } from "../remote/server-credential-store";
import type { RemotePendingLoginStatus } from "../remote/server-credentials";
import { remoteClientById, RemoteSecurityStore } from "../storage/remote-security";
import type {
  CurrentHostOperation,
  CurrentHostOperationOutcome,
  CurrentHostOperatorPrincipal,
  CurrentHostOperationsDependencies,
} from "./operations";

/** Maximum number of actionable entries returned by the Current Host summary. */
const CURRENT_HOST_SUMMARY_ATTENTION_LIMIT = 10;

type SummaryOperation = Extract<CurrentHostOperation, { kind: "summary" }>;
type ClientsListOutcome = Extract<CurrentHostOperationOutcome, { kind: "clients_list" }>;
type RemoteClientsPageOperation = Extract<CurrentHostOperation, { kind: "remote_clients_page" }>;
type RemoteClientsPageOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "remote_clients_page" }
>;
type RemoteClientGetOperation = Extract<CurrentHostOperation, { kind: "remote_client_get" }>;
type RemoteClientGetOutcome = Extract<CurrentHostOperationOutcome, { kind: "remote_client_get" }>;
type PendingLoginsListOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "pending_logins_list" }
>;
type RemoteLoginRequestsPageOperation = Extract<
  CurrentHostOperation,
  { kind: "remote_login_requests_page" }
>;
type RemoteLoginRequestsPageOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "remote_login_requests_page" }
>;
type RemoteLoginRequestGetOperation = Extract<
  CurrentHostOperation,
  { kind: "remote_login_request_get" }
>;
type RemoteLoginRequestGetOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "remote_login_request_get" }
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
    listClientsPage: async (
      operation: RemoteClientsPageOperation,
    ): Promise<RemoteClientsPageOutcome> => {
      const store = authoritativeRemoteSecurityStore(dependencies);
      return {
        kind: "remote_clients_page",
        page: await store.listClientsPage({
          limit: operation.limit,
          sort: operation.sort,
          ...(operation.after === undefined ? {} : { after: operation.after }),
          ...(operation.role === undefined ? {} : { role: operation.role }),
          ...(operation.revoked === undefined ? {} : { revoked: operation.revoked }),
        }),
      };
    },
    getClient: async (operation: RemoteClientGetOperation): Promise<RemoteClientGetOutcome> => {
      const clientId = requiredRemoteClientId(operation.clientId);
      const client = await authoritativeRemoteSecurityStore(dependencies).getClient(clientId);
      return client
        ? { kind: "remote_client_get", status: "found", client }
        : { kind: "remote_client_get", status: "not_found", clientId };
    },
    listPendingLogins: async (): Promise<PendingLoginsListOutcome> => ({
      kind: "pending_logins_list",
      pendingLogins: ((await dependencies.remoteCredentialStore?.listPendingLogins()) ?? []).filter(
        (login) => login.status === "pending" || login.status === "approved",
      ),
    }),
    listPendingLoginsPage: async (
      operation: RemoteLoginRequestsPageOperation,
    ): Promise<RemoteLoginRequestsPageOutcome> => {
      const store = authoritativeRemoteSecurityStore(dependencies);
      return {
        kind: "remote_login_requests_page",
        page: await store.listPendingLoginsPage({
          limit: operation.limit,
          sort: operation.sort,
          ...(operation.after === undefined ? {} : { after: operation.after }),
          ...(operation.statuses === undefined ? {} : { statuses: operation.statuses }),
        }),
      };
    },
    getPendingLogin: async (
      operation: RemoteLoginRequestGetOperation,
    ): Promise<RemoteLoginRequestGetOutcome> => {
      const flowId = requiredPendingLoginFlowId(operation.flowId);
      const pendingLogin =
        await authoritativeRemoteSecurityStore(dependencies).getPendingLogin(flowId);
      return pendingLogin
        ? { kind: "remote_login_request_get", status: "found", pendingLogin }
        : { kind: "remote_login_request_get", status: "not_found", flowId };
    },
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
  if (!dependencies.runtimeState) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Authoritative runtime state is unavailable.");
  }
  if (!dependencies.projectBindingState) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Authoritative Project Binding state is unavailable.",
    );
  }
  const [runtime, projectBinding] = await Promise.all([
    dependencies.runtimeState.read(),
    dependencies.projectBindingState.read(),
  ]);
  const credentialStore = dependencies.remoteCredentialStore;
  let clientCount = 0;
  let pendingCount = 0;
  let pending: RemotePendingLoginStatus[] = [];
  if (credentialStore instanceof RemoteSecurityStore) {
    const [clients, pendingTotal, pendingPage] = await Promise.all([
      credentialStore.countClients(),
      credentialStore.countPendingLogins(["pending"]),
      credentialStore.listPendingLoginsPage({
        limit: CURRENT_HOST_SUMMARY_ATTENTION_LIMIT,
        statuses: ["pending"],
      }),
    ]);
    clientCount = clients;
    pendingCount = pendingTotal;
    pending = pendingPage.items;
  } else if (credentialStore) {
    [clientCount, pendingCount, pending] = await Promise.all([
      credentialStore.countClients(),
      credentialStore.countPendingLogins(["pending"]),
      credentialStore.listPendingLoginsBounded(CURRENT_HOST_SUMMARY_ATTENTION_LIMIT, ["pending"]),
    ]);
  }
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
          clients: clientCount,
          pending: pendingCount,
          href: `${operation.dashboardPath}#access`,
        },
        vault: { count: vaultCount, href: `${operation.dashboardPath}#vault` },
        projectBinding: {
          state: projectBinding.state,
          href: `${operation.dashboardPath}#project-binding`,
        },
        runtime: { status: runtime.status, href: `${operation.dashboardPath}#runtime` },
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
  const store =
    operation.expectedGeneration === undefined
      ? dependencies.remoteCredentialStore
      : authoritativeRemoteSecurityStore(dependencies);
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
            ...(operation.expectedGeneration === undefined
              ? {}
              : { expectedGeneration: operation.expectedGeneration }),
          })
        : store.approvePendingLoginFlow({
            flowId,
            ...(operation.grantedRole === undefined ? {} : { grantedRole: operation.grantedRole }),
          });
    if (!(store instanceof RemoteSecurityStore)) {
      dependencies.activityLog.append({
        actorClientId: principal.clientId,
        action: "pending_login_approved",
        target: { type: "pending_login", id: pendingLogin.flowId },
        metadata: {
          requestedRole: pendingLogin.requestedRole,
          grantedRole: pendingLogin.grantedRole ?? pendingLogin.requestedRole,
        },
      });
    }
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
  const store =
    operation.expectedGeneration === undefined
      ? dependencies.remoteCredentialStore
      : authoritativeRemoteSecurityStore(dependencies);
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
        ? await store.denyPendingLoginFlow({
            operatorClientId: principal.clientId,
            flowId,
            ...(operation.expectedGeneration === undefined
              ? {}
              : { expectedGeneration: operation.expectedGeneration }),
          })
        : store.denyPendingLoginFlow({ flowId });
    if (!(store instanceof RemoteSecurityStore)) {
      dependencies.activityLog.append({
        actorClientId: principal.clientId,
        action: "pending_login_denied",
        target: { type: "pending_login", id: pendingLogin.flowId },
        metadata: { requestedRole: pendingLogin.requestedRole },
      });
    }
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
  if (operation.expectedGeneration !== undefined) {
    const store = authoritativeRemoteSecurityStore(dependencies);
    const client = await store.revokeClient({
      operatorClientId: principal.clientId,
      clientId,
      expectedGeneration: operation.expectedGeneration,
    });
    if (!client) {
      return { kind: "client_revoke", status: "not_found", clientId, sessionEnded: false };
    }
    return {
      kind: "client_revoke",
      status: "revoked",
      client,
      sessionEnded: clientId === principal.clientId,
    };
  }
  const store = dependencies.remoteCredentialStore;
  if (!store) {
    appendFailureActivity(dependencies, principal, "remote_client_revoked", {
      type: "remote_client",
      id: clientId,
    });
    return { kind: "client_revoke", status: "credential_store_unavailable", clientId };
  }
  try {
    const client = await remoteClientById(store, clientId);
    const revoked =
      store instanceof RemoteServerCredentialStore
        ? store.revokeClient(clientId)
        : await store.revokeClient({ operatorClientId: principal.clientId, clientId });
    if (revoked && !client?.revokedAt && !(store instanceof RemoteSecurityStore)) {
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
  if (operation.expectedGeneration !== undefined) {
    const client = await authoritativeRemoteSecurityStore(dependencies).changeClientRole({
      operatorClientId: principal.clientId,
      clientId,
      role: operation.role,
      expectedGeneration: operation.expectedGeneration,
    });
    if (!client) {
      return { kind: "client_change_role", status: "not_found", clientId, sessionEnded: false };
    }
    return {
      kind: "client_change_role",
      status: "changed",
      client,
      sessionEnded: client.clientId === principal.clientId && client.role !== "operator",
    };
  }
  const store = dependencies.remoteCredentialStore;
  if (!store) {
    appendFailureActivity(dependencies, principal, "remote_client_role_changed", {
      type: "remote_client",
      id: clientId,
    });
    return { kind: "client_change_role", status: "credential_store_unavailable", clientId };
  }
  try {
    const before = await remoteClientById(store, clientId);
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
    if (!(store instanceof RemoteSecurityStore)) {
      dependencies.activityLog.append({
        actorClientId: principal.clientId,
        action: "remote_client_role_changed",
        target: { type: "remote_client", id: client.clientId },
        metadata: roleChangeMetadata(before?.role ?? client.role, client.role),
      });
    }
    return { kind: "client_change_role", status: "changed", client, sessionEnded };
  } catch (error) {
    appendFailureActivity(dependencies, principal, "remote_client_role_changed", {
      type: "remote_client",
      id: clientId,
    });
    throw error;
  }
}

function authoritativeRemoteSecurityStore(
  dependencies: CurrentHostOperationsDependencies,
): RemoteSecurityStore {
  if (dependencies.remoteCredentialStore instanceof RemoteSecurityStore) {
    return dependencies.remoteCredentialStore;
  }
  throw new CapletsError(
    "SERVER_UNAVAILABLE",
    "Authoritative remote security state is unavailable.",
  );
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
