import { refreshOAuthTokenBundle } from "../auth";
import {
  isTokenBundleExpired,
  type StoredOAuthTokenBundle,
  type StoredOAuthTokenBundleView,
} from "../auth/store";
import { assertLoginTarget, findAuthTarget, listAuthRows, resolveAuthTarget } from "../cli/auth";
import {
  loadConfig,
  loadConfigWithSources,
  vaultBootstrapResolver,
  vaultResolverForAuthDir,
} from "../config";
import { CapletsError } from "../errors";
import { RemoteAuthFlowCoordinator } from "../remote-control/auth-flow";
import type { BackendAuthMutationOptions, BackendAuthStateStore } from "../storage/backend-auth";
import { createHostStorageVaultResolver } from "../storage/vault-resolver";
import type {
  CurrentHostBackendAuthConnection,
  CurrentHostOperation,
  CurrentHostOperationOutcome,
  CurrentHostOperatorPrincipal,
  CurrentHostOperationsDependencies,
} from "./operations";

type ConnectionsPageOperation = Extract<
  CurrentHostOperation,
  { kind: "backend_auth_connections_page" }
>;
type ConnectionsPageOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "backend_auth_connections_page" }
>;
type ConfiguredStatusesOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "backend_auth_configured_statuses" }
>;
type ConnectionGetOperation = Extract<
  CurrentHostOperation,
  { kind: "backend_auth_connection_get" }
>;
type ConnectionGetOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "backend_auth_connection_get" }
>;
type ConnectionDeleteOperation = Extract<
  CurrentHostOperation,
  { kind: "backend_auth_connection_delete" }
>;
type ConnectionDeleteOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "backend_auth_connection_delete" }
>;
type ConnectionDeleteIfPresentOperation = Extract<
  CurrentHostOperation,
  { kind: "backend_auth_connection_delete_if_present" }
>;
type ConnectionDeleteIfPresentOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "backend_auth_connection_delete_if_present" }
>;
type FlowStartOperation = Extract<CurrentHostOperation, { kind: "backend_auth_flow_start" }>;
type FlowStartOutcome = Extract<CurrentHostOperationOutcome, { kind: "backend_auth_flow_start" }>;
type LegacyFlowStartOperation = Extract<
  CurrentHostOperation,
  { kind: "backend_auth_legacy_flow_start" }
>;
type LegacyFlowStartOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "backend_auth_legacy_flow_start" }
>;
type FlowGetOperation = Extract<CurrentHostOperation, { kind: "backend_auth_flow_get" }>;
type FlowGetOutcome = Extract<CurrentHostOperationOutcome, { kind: "backend_auth_flow_get" }>;
type CallbackCompleteOperation = Extract<
  CurrentHostOperation,
  { kind: "backend_auth_flow_callback_complete" }
>;
type CallbackCompleteOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "backend_auth_flow_callback_complete" }
>;
type RefreshOperation = Extract<CurrentHostOperation, { kind: "backend_auth_refresh" }>;
type RefreshOutcome = Extract<CurrentHostOperationOutcome, { kind: "backend_auth_refresh" }>;

export type CurrentHostBackendAuthOperations = {
  listConnectionsPage(operation: ConnectionsPageOperation): Promise<ConnectionsPageOutcome>;
  listConfiguredStatuses(): Promise<ConfiguredStatusesOutcome>;
  getConnection(operation: ConnectionGetOperation): Promise<ConnectionGetOutcome>;
  deleteConnection(
    principal: CurrentHostOperatorPrincipal,
    operation: ConnectionDeleteOperation,
  ): Promise<ConnectionDeleteOutcome>;
  deleteConnectionIfPresent(
    principal: CurrentHostOperatorPrincipal,
    operation: ConnectionDeleteIfPresentOperation,
  ): Promise<ConnectionDeleteIfPresentOutcome>;
  startFlow(
    principal: CurrentHostOperatorPrincipal,
    operation: FlowStartOperation,
  ): Promise<FlowStartOutcome>;
  startLegacyFlow(
    principal: CurrentHostOperatorPrincipal,
    operation: LegacyFlowStartOperation,
  ): Promise<LegacyFlowStartOutcome>;
  getFlow(operation: FlowGetOperation): Promise<FlowGetOutcome>;
  completeCallback(operation: CallbackCompleteOperation): Promise<CallbackCompleteOutcome>;
  refreshConnection(
    principal: CurrentHostOperatorPrincipal,
    operation: RefreshOperation,
  ): Promise<RefreshOutcome>;
};

export function createCurrentHostBackendAuthOperations(
  dependencies: CurrentHostOperationsDependencies,
): CurrentHostBackendAuthOperations {
  const authStore = dependencies.backendAuthStore ?? dependencies.catalogStorage?.backendAuth;
  const requiredAuthStore = () => {
    if (!authStore) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Authoritative backend auth storage is unavailable.",
      );
    }
    return authStore;
  };
  const flowRepository =
    dependencies.backendAuthFlows ?? dependencies.catalogStorage?.backendAuthFlows;
  const requiredFlowRepository = () => {
    if (!flowRepository) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Authoritative backend auth flow storage is unavailable.",
      );
    }
    return flowRepository;
  };
  const resolveTarget = async (server: string) => {
    const vaultResolver = dependencies.catalogStorage
      ? await createHostStorageVaultResolver(dependencies.catalogStorage)
      : vaultResolverForAuthDir(dependencies.control?.authDir);
    const config = loadConfigWithSources(
      dependencies.control?.configPath,
      dependencies.control?.projectConfigPath,
      { vaultResolver },
    ).config;
    const target = await resolveAuthTarget(server, config, requiredAuthStore());
    assertLoginTarget(target, server);
    return target;
  };
  const startFlowWithCallback = async (
    principal: CurrentHostOperatorPrincipal,
    server: string,
    callbackBaseUrl: string,
    callbackUrl: (flowId: string) => string,
  ) => {
    const normalizedBaseUrl = callbackBaseUrl.endsWith("/")
      ? callbackBaseUrl
      : `${callbackBaseUrl}/`;
    const result = await new RemoteAuthFlowCoordinator({
      repository: requiredFlowRepository(),
      authStore: requiredAuthStore(),
      resolveTarget,
      operatorClientId: principal.clientId,
      callbackUrl,
    }).start({
      server,
      callbackBaseUrl: normalizedBaseUrl,
    });
    await dependencies.activityLog.append({
      actorClientId: principal.clientId,
      action: "backend_auth_flow_started",
      target: { type: "backend_auth", id: server },
      metadata: { authenticated: "authenticated" in result && result.authenticated },
    });
    return result;
  };

  return {
    async listConnectionsPage(
      operation: ConnectionsPageOperation,
    ): Promise<ConnectionsPageOutcome> {
      const page = await requiredAuthStore().listConnectionsPage({
        limit: operation.limit,
        sort: operation.sort,
        ...(operation.after ? { after: operation.after } : {}),
      });
      return {
        kind: "backend_auth_connections_page",
        page: {
          items: page.items.map(connectionProjection),
          ...(page.nextKey ? { nextKey: page.nextKey } : {}),
        },
      };
    },
    async listConfiguredStatuses(): Promise<ConfiguredStatusesOutcome> {
      const rows = await listAuthRows({
        authStore: requiredAuthStore(),
        ...(dependencies.control?.configPath
          ? { configPath: dependencies.control.configPath }
          : {}),
        ...(dependencies.control?.authDir ? { authDir: dependencies.control.authDir } : {}),
      });
      return { kind: "backend_auth_configured_statuses", rows };
    },
    async getConnection(operation: ConnectionGetOperation): Promise<ConnectionGetOutcome> {
      const stored = await requiredAuthStore().readTokenBundle(operation.server);
      if (!stored) {
        throw new CapletsError(
          "SERVER_NOT_FOUND",
          `Backend auth connection ${operation.server} was not found.`,
        );
      }
      return {
        kind: "backend_auth_connection_get",
        connection: connectionProjection(stored),
      };
    },
    async deleteConnection(
      principal,
      operation: ConnectionDeleteOperation,
    ): Promise<ConnectionDeleteOutcome> {
      const deleted = await requiredAuthStore().deleteTokenBundle(operation.server, {
        expectedGeneration: operation.expectedGeneration,
        operatorClientId: principal.clientId,
      });
      if (deleted) await dependencies.invalidateConfig?.(principal.clientId);
      return {
        kind: "backend_auth_connection_delete",
        server: operation.server,
        deleted,
      };
    },
    async deleteConnectionIfPresent(
      principal,
      operation: ConnectionDeleteIfPresentOperation,
    ): Promise<ConnectionDeleteIfPresentOutcome> {
      const config = loadConfig(dependencies.control?.configPath, undefined, {
        vaultResolver: vaultBootstrapResolver,
      });
      assertLoginTarget(findAuthTarget(operation.server, config), operation.server);
      const store = requiredAuthStore();
      const current = await store.readTokenBundle(operation.server);
      const deleted = current
        ? await store.deleteTokenBundle(operation.server, {
            expectedGeneration: current.generation,
            operatorClientId: principal.clientId,
          })
        : false;
      if (deleted) await dependencies.invalidateConfig?.(principal.clientId);
      return {
        kind: "backend_auth_connection_delete_if_present",
        server: operation.server,
        deleted,
      };
    },
    async startFlow(principal, operation: FlowStartOperation): Promise<FlowStartOutcome> {
      if (!dependencies.backendAuthCallbackBaseUrl) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "Backend auth callback configuration is unavailable.",
        );
      }
      const callbackBaseUrl = dependencies.backendAuthCallbackBaseUrl.endsWith("/")
        ? dependencies.backendAuthCallbackBaseUrl
        : `${dependencies.backendAuthCallbackBaseUrl}/`;
      const result = await startFlowWithCallback(
        principal,
        operation.server,
        callbackBaseUrl,
        (flowId) => new URL(`backend-auth-flows/${flowId}/callback`, callbackBaseUrl).toString(),
      );
      return { kind: "backend_auth_flow_start", ...result };
    },
    async startLegacyFlow(
      principal,
      operation: LegacyFlowStartOperation,
    ): Promise<LegacyFlowStartOutcome> {
      const callbackBaseUrl = operation.callbackBaseUrl.endsWith("/")
        ? operation.callbackBaseUrl
        : `${operation.callbackBaseUrl}/`;
      const result = await startFlowWithCallback(
        principal,
        operation.server,
        callbackBaseUrl,
        (flowId) => new URL(`auth/callback/${flowId}`, callbackBaseUrl).toString(),
      );
      return { kind: "backend_auth_legacy_flow_start", ...result };
    },
    async getFlow(operation: FlowGetOperation): Promise<FlowGetOutcome> {
      const flow = await requiredFlowRepository().get(operation.flowId);
      if (!flow) {
        throw new CapletsError(
          "SERVER_NOT_FOUND",
          `Backend auth flow ${operation.flowId} was not found.`,
        );
      }
      return { kind: "backend_auth_flow_get", flow };
    },
    async completeCallback(operation: CallbackCompleteOperation): Promise<CallbackCompleteOutcome> {
      const result = await new RemoteAuthFlowCoordinator({
        repository: requiredFlowRepository(),
        authStore: requiredAuthStore(),
        resolveTarget,
      }).complete(operation.flowId, operation.callbackUrl);
      await dependencies.invalidateConfig?.("backend_auth_callback");
      return { kind: "backend_auth_flow_callback_complete", ...result };
    },
    async refreshConnection(principal, operation: RefreshOperation): Promise<RefreshOutcome> {
      const store = requiredAuthStore();
      const guardedStore = backendAuthStoreForRefresh(store, principal.clientId, operation);
      await guardedStore.readTokenBundle(operation.server);
      const target = await resolveTarget(operation.server);
      await refreshOAuthTokenBundle(target, guardedStore);
      const stored = await store.readTokenBundle(operation.server);
      if (!stored) {
        throw new CapletsError(
          "INTERNAL_ERROR",
          `Backend auth connection ${operation.server} disappeared after refresh.`,
        );
      }
      await dependencies.invalidateConfig?.(principal.clientId);
      return {
        kind: "backend_auth_refresh",
        connection: connectionProjection(stored),
      };
    },
  };
}

function backendAuthStoreForRefresh(
  authStore: BackendAuthStateStore,
  operatorClientId: string,
  operation: RefreshOperation,
): BackendAuthStateStore {
  return new Proxy(authStore, {
    get(target, property) {
      if (property === "readTokenBundle") {
        return async (server: string) => {
          const stored = await target.readTokenBundle(server);
          if (server === operation.server) {
            assertExpectedGeneration(stored?.generation ?? 0, operation.expectedGeneration);
          }
          return stored;
        };
      }
      if (property === "writeTokenBundle") {
        return async (bundle: StoredOAuthTokenBundle, options: BackendAuthMutationOptions = {}) =>
          await target.writeTokenBundle(bundle, {
            ...options,
            expectedGeneration: operation.expectedGeneration,
            operatorClientId,
          });
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function assertExpectedGeneration(currentGeneration: number, expectedGeneration: number): void {
  if (currentGeneration === expectedGeneration) return;
  throw new CapletsError(
    "REQUEST_INVALID",
    "Authoritative Host State changed after it was read; reload and retry.",
    {
      kind: "stale_generation",
      expectedGeneration,
      currentGeneration,
    },
  );
}

function connectionProjection(
  stored: StoredOAuthTokenBundleView,
): CurrentHostBackendAuthConnection {
  const { bundle, generation } = stored;
  return {
    server: bundle.server,
    generation,
    status: isTokenBundleExpired(bundle) ? "expired" : "authenticated",
    ...(bundle.authType ? { authType: bundle.authType } : {}),
    ...(bundle.expiresAt ? { expiresAt: bundle.expiresAt } : {}),
    ...(bundle.scope ? { scope: bundle.scope } : {}),
  };
}
