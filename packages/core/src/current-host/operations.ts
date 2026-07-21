import type { CatalogCompactEntry, CatalogEntry } from "../catalog";
import type { AuthStatusRow } from "../cli/auth";
import type {
  DashboardActivityAction,
  ListDashboardActivityInput,
} from "../dashboard/activity-log";
import type { CapletsEngine } from "../engine";
import { CapletsError, toSafeError, type SafeErrorSummary } from "../errors";
import type { RemoteServerCredentialStore } from "../remote/server-credential-store";
import type { VaultGrantPageKey, VaultGrantStore } from "../storage/vault-grants";
import type {
  AppendOperatorActivityInput,
  ListOperatorActivityPageInput,
  OperatorActivityEntry,
  OperatorActivityPageKey,
} from "../storage/operator-activity";
import type { KeysetSortDirection, StorageKeysetPage } from "../storage/keyset-page";
import type {
  PendingLoginPageKey,
  RemoteClientPageKey,
  RemoteSecurityStore,
} from "../storage/remote-security";
import type { BackendAuthConnectionPageKey, BackendAuthStateStore } from "../storage/backend-auth";
import type { BackendAuthFlowRepository, BackendAuthFlowView } from "../storage/backend-auth-flows";
import type {
  VaultValuePageKey,
  VaultValueRecordStatus,
  VaultValueRepository,
} from "../storage/vault-values";
import type { VaultStateStore } from "../storage/vault-state";
import type {
  CapletRecordPageKey,
  CapletRecordStore,
  CapletRecordSummaryView,
  CapletRecordView,
  CapletRevisionPageKey,
  CapletRevisionSummaryView,
} from "../storage/caplet-records";
import type { ReopenableBundleFileSource } from "../storage/bundle-source";
import type {
  CapletInstallationObservationStatus,
  CapletInstallationObservationView,
  CapletInstallationObservationPageKey,
  CapletInstallationPageKey,
  CapletInstallationStore,
  CapletInstallationView,
} from "../storage/installations";
import type { HostStorage } from "../storage/database";
import type {
  RemoteClientRole,
  RemoteClientStatus,
  RemotePendingLoginState,
  RemotePendingLoginStatus,
} from "../remote/server-credentials";
import type { VaultDeleteStatus, VaultValueStatus } from "../vault";
import {
  type CurrentHostCatalogInstallResult as CatalogInstallResult,
  type CurrentHostInstalledCapletProjection as InstalledCapletProjection,
  type CurrentHostInstalledCatalogCaplet as InstalledCatalogCaplet,
  type CurrentHostSetupAction as SetupAction,
} from "./catalog";
import { createCurrentHostCatalogOperations } from "./catalog-operations";
import { createCurrentHostClientOperations } from "./client-operations";
import { createCurrentHostRecordOperations } from "./record-operations";
import {
  createCurrentHostInstallationOperations,
  type CurrentHostInstallationOperations,
} from "./installation-operations";
import { createCurrentHostVaultOperations } from "./vault-operations";
import {
  createCurrentHostBackendAuthOperations,
  type CurrentHostBackendAuthOperations,
} from "./backend-auth-operations";

const TRUSTED_DEVELOPMENT_PRINCIPAL = Symbol("trusted-development-principal");

export type CurrentHostAuthenticatedPrincipal = {
  clientId: string;
  clientLabel?: string | undefined;
  hostUrl: string;
  role: RemoteClientRole;
};

export type CurrentHostBackendAuthCallbackPrincipal = {
  role: "backend_auth_callback";
  flowId: string;
};

export type CurrentHostPrincipal =
  | CurrentHostAuthenticatedPrincipal
  | CurrentHostBackendAuthCallbackPrincipal;

export type CurrentHostOperatorPrincipal = CurrentHostAuthenticatedPrincipal & {
  role: "operator";
  [TRUSTED_DEVELOPMENT_PRINCIPAL]?: true;
};

export function trustedDevelopmentOperatorPrincipal(hostUrl: string): CurrentHostOperatorPrincipal {
  if (!isHttpUrl(hostUrl)) {
    throw new CapletsError("AUTH_FAILED", "Current Host administration requires a valid host URL.");
  }
  return {
    clientId: "development_unauthenticated",
    hostUrl,
    role: "operator",
    [TRUSTED_DEVELOPMENT_PRINCIPAL]: true,
  };
}

export function toCurrentHostSafeError(error: unknown): SafeErrorSummary {
  const safe =
    error instanceof CapletsError
      ? toSafeError(error, error.code)
      : toSafeError(
          new CapletsError("INTERNAL_ERROR", "Current Host administration failed."),
          "INTERNAL_ERROR",
        );
  return {
    ...safe,
    message: redactCurrentHostErrorMessage(safe.message),
  };
}

function redactCurrentHostErrorMessage(message: string): string {
  return message
    .replace(/\b(?:https?|file):\/\/[^\s,;)"']+/giu, "[REDACTED]")
    .replace(
      /(["'])(authorization|(?:access[_-]?)?token|refresh(?:[_-]?token)?|password|client[_-]?secret|clientsecret|api[-_]?key|apikey|secret|credential|code)\1\s*:\s*(["'])(?:\\.|[^\\])*?\3/giu,
      "$1$2$1:$3[REDACTED]$3",
    )
    .replace(/\b(authorization\s*:\s*(?:basic|bearer)\s+)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(
      /\b((?:access[_-]?)?token|refresh(?:[_-]?token)?|password|client[_-]?secret|clientsecret|api[-_]?key|apikey|secret|credential|code)(\s*[=:]\s*)[^\s,;]+/giu,
      "$1$2[REDACTED]",
    )
    .replace(/(^|[\s("'])\/[^\s,;:)"]+/gu, "$1[REDACTED]")
    .replace(/\b[A-Za-z]:\\[^\s,;")]+/gu, "[REDACTED]");
}

export type CurrentHostControlContext = {
  configPath?: string | undefined;
  projectConfigPath?: string | undefined;
  authDir?: string | undefined;
  globalCapletsRoot?: string | undefined;
  globalLockfilePath?: string | undefined;
};
export type CurrentHostCapletPageKey = { id: string };
export type CurrentHostCatalogEntryPageKey = { entryKey: string };
export type CurrentHostCatalogUpdateCandidatePageKey = { id: string };
export type CurrentHostLogPageKey = { timestamp: string; logKey: string };
export type CurrentHostLogEntry = {
  timestamp: string;
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  message: string;
  source?: string | undefined;
};

export type CurrentHostRuntimeSnapshot =
  | { status: "ok" }
  | { status: "error"; reason?: string | undefined };

export type CurrentHostStateChangeListener = () => void;

export type CurrentHostRuntimeStateOwner = {
  read(): CurrentHostRuntimeSnapshot | Promise<CurrentHostRuntimeSnapshot>;
  subscribe?(listener: CurrentHostStateChangeListener): () => void;
};

export type CurrentHostLogStateOwner = {
  listPage(input: {
    sort: KeysetSortDirection;
    limit?: number | undefined;
    after?: CurrentHostLogPageKey | undefined;
  }):
    | StorageKeysetPage<CurrentHostLogEntry, CurrentHostLogPageKey>
    | Promise<StorageKeysetPage<CurrentHostLogEntry, CurrentHostLogPageKey>>;
};

export type CurrentHostProjectBindingAction = {
  id: string;
  label: string;
  enabled: boolean;
  reason?: string | undefined;
};

export type CurrentHostProjectBindingSnapshot = {
  state: "connected" | "disconnected";
  affectedCaplets: string[];
  actions: CurrentHostProjectBindingAction[];
};

export type CurrentHostProjectBindingStateOwner = {
  read(): CurrentHostProjectBindingSnapshot | Promise<CurrentHostProjectBindingSnapshot>;
  subscribe?(listener: CurrentHostStateChangeListener): () => void;
};

export type CurrentHostBundleInstallationInput = {
  sourceKind: string;
  sourceIdentity: string;
  channel?: string | undefined;
  risk?: Record<string, unknown> | null | undefined;
};

export type CurrentHostOperation =
  | {
      kind: "summary";
      baseUrl: string;
      dashboardUrl: string;
      dashboardPath: string;
    }
  | { kind: "caplets_list" }
  | {
      kind: "caplets_page";
      limit: number;
      sort: KeysetSortDirection;
      after?: CurrentHostCapletPageKey | undefined;
    }
  | {
      kind: "catalog_search";
      source: string;
      query?: string | undefined;
      limit?: number | undefined;
    }
  | {
      kind: "catalog_entries_page";
      source: string;
      query?: string | undefined;
      limit: number;
      sort: KeysetSortDirection;
      after?: CurrentHostCatalogEntryPageKey | undefined;
    }
  | { kind: "catalog_index"; source: string }
  | { kind: "catalog_detail"; source: string; entryKey: string }
  | { kind: "catalog_updates" }
  | {
      kind: "catalog_update_candidates_page";
      limit: number;
      sort: KeysetSortDirection;
      after?: CurrentHostCatalogUpdateCandidatePageKey | undefined;
    }
  | {
      kind: "catalog_install";
      /** A dashboard catalog source. When present, it also determines setup actions. */
      source?: string | undefined;
      /** Stable catalog identity. Requires source and is independently re-resolved before install. */
      entryKey?: string | undefined;
      /** A bearer-compatible repository source. Omit to restore the server lockfile. */
      repo?: string | undefined;
      capletIds?: string[] | undefined;
      force?: boolean | undefined;
      disableCatalogIndexing?: boolean | undefined;
    }
  | {
      kind: "catalog_update";
      capletIds?: string[] | undefined;
      force?: boolean | undefined;
      allowRiskIncrease?: boolean | undefined;
      disableCatalogIndexing?: boolean | undefined;
    }
  | { kind: "clients_list" }
  | {
      kind: "remote_clients_page";
      limit: number;
      sort: KeysetSortDirection;
      after?: RemoteClientPageKey | undefined;
      role?: RemoteClientRole | undefined;
      revoked?: boolean | undefined;
    }
  | { kind: "remote_client_get"; clientId: string }
  | {
      kind: "backend_auth_connections_page";
      limit: number;
      sort: KeysetSortDirection;
      after?: BackendAuthConnectionPageKey | undefined;
    }
  | { kind: "backend_auth_configured_statuses" }
  | { kind: "backend_auth_connection_get"; server: string }
  | {
      kind: "backend_auth_connection_delete";
      server: string;
      expectedGeneration: number;
    }
  | { kind: "backend_auth_connection_delete_if_present"; server: string }
  | { kind: "backend_auth_flow_start"; server: string }
  | { kind: "backend_auth_legacy_flow_start"; server: string; callbackBaseUrl: string }
  | { kind: "backend_auth_flow_get"; flowId: string }
  | {
      kind: "backend_auth_flow_callback_complete";
      flowId: string;
      callbackUrl: string;
    }
  | {
      kind: "backend_auth_refresh";
      server: string;
      expectedGeneration: number;
    }
  | { kind: "pending_logins_list" }
  | {
      kind: "remote_login_requests_page";
      limit: number;
      sort: KeysetSortDirection;
      after?: PendingLoginPageKey | undefined;
      statuses?: RemotePendingLoginState[] | undefined;
    }
  | { kind: "remote_login_request_get"; flowId: string }
  | {
      kind: "pending_login_approve";
      flowId: string;
      grantedRole?: RemoteClientRole | undefined;
      expectedGeneration?: number | undefined;
    }
  | { kind: "pending_login_deny"; flowId: string; expectedGeneration?: number | undefined }
  | { kind: "client_revoke"; clientId: string; expectedGeneration?: number | undefined }
  | {
      kind: "client_change_role";
      clientId: string;
      role: RemoteClientRole;
      expectedGeneration?: number | undefined;
    }
  | {
      kind: "activity_list";
      limit?: number | undefined;
      after?: string | undefined;
      action?: DashboardActivityAction | undefined;
    }
  | {
      kind: "activity_page";
      limit: number;
      sort: KeysetSortDirection;
      after?: OperatorActivityPageKey | undefined;
      action?: string | undefined;
    }
  | {
      kind: "vault_set";
      name: string;
      value: string;
      grant?: string | undefined;
      referenceName?: string | undefined;
      force?: boolean | undefined;
      createOnly?: boolean | undefined;
      expectedGeneration?: number | undefined;
      expectedGrantResourceVersion?: string | undefined;
      grantCreateOnly?: boolean | undefined;
    }
  | { kind: "vault_list" }
  | {
      kind: "vault_values_page";
      limit: number;
      sort: KeysetSortDirection;
      after?: VaultValuePageKey | undefined;
    }
  | { kind: "vault_get"; name: string }
  | { kind: "vault_delete"; name: string; expectedGeneration?: number | undefined }
  | {
      kind: "vault_access_grant";
      storedKey: string;
      referenceName: string;
      capletId: string;
      createOnly?: boolean | undefined;
      expectedResourceVersion?: string | undefined;
    }
  | {
      kind: "vault_access_revoke";
      storedKey: string;
      referenceName?: string | undefined;
      capletId?: string | undefined;
      expectedResourceVersion?: string | undefined;
    }
  | {
      kind: "vault_access_list";
      storedKey?: string | undefined;
      capletId?: string | undefined;
      referenceName?: string | undefined;
    }
  | {
      kind: "vault_grants_page";
      limit: number;
      sort: KeysetSortDirection;
      after?: VaultGrantPageKey | undefined;
      storedKey?: string | undefined;
      capletId?: string | undefined;
    }
  | { kind: "stored_caplets_list" }
  | {
      kind: "stored_caplets_page";
      limit: number;
      sort: KeysetSortDirection;
      after?: CapletRecordPageKey | undefined;
      source?: string | undefined;
      status?: "active" | "detached" | undefined;
      tag?: string | undefined;
      search?: string | undefined;
    }
  | { kind: "stored_caplet_get"; id: string; revisionKey?: string | undefined }
  | {
      kind: "stored_caplet_bundle_get";
      id: string;
      revisionKey?: string | undefined;
    }
  | {
      kind: "stored_caplet_import";
      id: string;
      document: string;
      historyLimit?: number | undefined;
    }
  | {
      kind: "stored_caplet_bundle_import";
      id: string;
      sources: readonly ReopenableBundleFileSource[];
      historyLimit?: number | undefined;
      sourceRevision?: string | undefined;
      sourceContentHash?: string | undefined;
      installation?: CurrentHostBundleInstallationInput | undefined;
    }
  | {
      kind: "stored_caplet_update";
      id: string;
      document?: string | undefined;
      newId?: string | undefined;
      historyLimit?: number | null | undefined;
      expectedGeneration: number;
    }
  | {
      kind: "stored_caplet_bundle_update";
      id: string;
      sources: readonly ReopenableBundleFileSource[];
      expectedGeneration: number;
      historyLimit?: number | undefined;
      sourceRevision?: string | undefined;
      sourceContentHash?: string | undefined;
      installation?: CurrentHostBundleInstallationInput | undefined;
      detachInstallation?: boolean | undefined;
    }
  | { kind: "stored_caplet_delete"; id: string; expectedGeneration: number }
  | { kind: "stored_caplet_revisions"; id: string }
  | {
      kind: "stored_caplet_revisions_page";
      id: string;
      limit: number;
      sort: KeysetSortDirection;
      after?: CapletRevisionPageKey | undefined;
    }
  | {
      kind: "stored_caplet_restore_revision";
      id: string;
      revisionKey: string;
      expectedGeneration: number;
    }
  | {
      kind: "stored_caplet_delete_revision";
      id: string;
      revisionKey: string;
      expectedGeneration: number;
    }
  | {
      kind: "stored_caplet_installations_page";
      id: string;
      limit: number;
      sort: KeysetSortDirection;
      after?: CapletInstallationPageKey | undefined;
    }
  | {
      kind: "stored_caplet_installation_observations_page";
      id: string;
      limit: number;
      sort: KeysetSortDirection;
      after?: CapletInstallationObservationPageKey | undefined;
    }
  | { kind: "stored_caplet_installation_status"; id: string }
  | {
      kind: "stored_caplet_installation_get";
      id: string;
      installationKey?: string | undefined;
    }
  | {
      kind: "stored_caplet_installation_put";
      id: string;
      installationKey: string;
      createOnly: true;
      sourceKind: string;
      sourceIdentity: string;
      channel?: string | undefined;
    }
  | {
      kind: "stored_caplet_installation_put";
      id: string;
      installationKey: string;
      createOnly?: false | undefined;
      expectedGeneration: number;
      sourceKind: string;
      sourceIdentity: string;
      channel?: string | undefined;
    }
  | {
      kind: "stored_caplet_installation_delete";
      id: string;
      installationKey: string;
      expectedGeneration: number;
    }
  | {
      kind: "stored_caplet_installation_observe";
      id: string;
      expectedGeneration: number;
      status: CapletInstallationObservationStatus;
      resolvedRevision?: string | null | undefined;
      contentHash?: string | null | undefined;
      risk?: Record<string, unknown> | null | undefined;
    }
  | {
      kind: "runtime";
      baseUrl: string;
      bind: string;
      publicOrigin?: string | null | undefined;
    }
  | { kind: "runtime_restart" }
  | {
      kind: "logs";
      limit?: number | undefined;
      sort: KeysetSortDirection;
      after?: CurrentHostLogPageKey | undefined;
    }
  | { kind: "diagnostics" }
  | { kind: "runtime_event" }
  | { kind: "project_binding" };

export type CurrentHostVaultAccessGrant = {
  storedKey: string;
  referenceName: string;
  capletId: string;
  origin: { kind: string };
  resourceVersion?: string | undefined;
  createdAt: string;
  updatedAt: string;
};

export type CurrentHostSetupAction = SetupAction;
export type CurrentHostInstalledCaplet = InstalledCapletProjection;
export type CurrentHostInstalledCatalogCaplet = InstalledCatalogCaplet;
export type CurrentHostCatalogInstallResult = CatalogInstallResult;

export type CurrentHostSummarySections = {
  caplets: { count: number; href: string };
  catalog: { href: string };
  access: { clients: number; pending: number; href: string };
  vault: { count: number; href: string };
  projectBinding: { state: CurrentHostProjectBindingSnapshot["state"]; href: string };
  runtime: { status: CurrentHostRuntimeSnapshot["status"]; href: string };
  logs: { href: string };
  diagnostics: { href: string };
  activity: { href: string };
  settings: { href: string };
};

export type CurrentHostSummary = {
  host: {
    current: true;
    baseUrl: string;
    dashboardUrl: string;
    version: string;
    roleModel: "current-host";
  };
  attention: Array<{
    kind: "pending-login";
    severity: "warning";
    label: string;
    href: string;
  }>;
  sections: CurrentHostSummarySections;
};

export type CurrentHostBackendAuthConnection = {
  server: string;
  generation: number;
  status: "expired" | "authenticated";
  authType?: "oauth2" | "oidc" | undefined;
  expiresAt?: string | undefined;
  scope?: string | undefined;
};

export type CurrentHostActivityPage = {
  entries: OperatorActivityEntry[];
  nextCursor?: string | undefined;
};

export type CurrentHostOperationOutcome =
  | { kind: "summary"; summary: CurrentHostSummary }
  | { kind: "caplets_list"; caplets: CurrentHostInstalledCaplet[] }
  | {
      kind: "caplets_page";
      page: StorageKeysetPage<CurrentHostInstalledCaplet, CurrentHostCapletPageKey>;
    }
  | { kind: "catalog_search"; entries: CatalogEntry[] }
  | { kind: "catalog_index"; entries: CatalogCompactEntry[] }
  | {
      kind: "catalog_entries_page";
      page: StorageKeysetPage<CatalogCompactEntry, CurrentHostCatalogEntryPageKey>;
    }
  | {
      kind: "catalog_detail";
      entry: CatalogEntry;
      setupActions: CurrentHostSetupAction[];
      projectScopedInstallAvailable: false;
    }
  | { kind: "catalog_updates"; updates: Array<{ id: string; status: "locked"; risk: unknown }> }
  | {
      kind: "catalog_update_candidates_page";
      page: StorageKeysetPage<
        { id: string; status: "locked"; risk: unknown },
        CurrentHostCatalogUpdateCandidatePageKey
      >;
    }
  | {
      kind: "catalog_install";
      installed: CurrentHostInstalledCatalogCaplet[];
      setupActions: CurrentHostSetupAction[];
    }
  | {
      kind: "catalog_update";
      installed: CurrentHostInstalledCatalogCaplet[];
      setupActions: CurrentHostSetupAction[];
    }
  | { kind: "clients_list"; clients: RemoteClientStatus[] }
  | { kind: "pending_logins_list"; pendingLogins: RemotePendingLoginStatus[] }
  | {
      kind: "remote_clients_page";
      page: StorageKeysetPage<RemoteClientStatus, RemoteClientPageKey>;
    }
  | {
      kind: "remote_client_get";
      status: "found";
      client: RemoteClientStatus;
    }
  | {
      kind: "remote_client_get";
      status: "not_found";
      clientId: string;
    }
  | {
      kind: "backend_auth_connections_page";
      page: StorageKeysetPage<CurrentHostBackendAuthConnection, BackendAuthConnectionPageKey>;
    }
  | { kind: "backend_auth_configured_statuses"; rows: AuthStatusRow[] }
  | {
      kind: "backend_auth_connection_get";
      connection: CurrentHostBackendAuthConnection;
    }
  | {
      kind: "backend_auth_connection_delete";
      server: string;
      deleted: boolean;
    }
  | {
      kind: "backend_auth_connection_delete_if_present";
      server: string;
      deleted: boolean;
    }
  | (
      | {
          kind: "backend_auth_flow_start";
          server: string;
          authenticated: true;
        }
      | {
          kind: "backend_auth_flow_start";
          server: string;
          flowId: string;
          authorizationUrl: string;
        }
    )
  | (
      | {
          kind: "backend_auth_legacy_flow_start";
          server: string;
          authenticated: true;
        }
      | {
          kind: "backend_auth_legacy_flow_start";
          server: string;
          flowId: string;
          authorizationUrl: string;
        }
    )
  | { kind: "backend_auth_flow_get"; flow: BackendAuthFlowView }
  | {
      kind: "backend_auth_flow_callback_complete";
      server: string;
      authenticated: true;
    }
  | {
      kind: "backend_auth_refresh";
      connection: CurrentHostBackendAuthConnection;
    }
  | {
      kind: "remote_login_requests_page";
      page: StorageKeysetPage<RemotePendingLoginStatus, PendingLoginPageKey>;
    }
  | {
      kind: "remote_login_request_get";
      status: "found";
      pendingLogin: RemotePendingLoginStatus;
    }
  | {
      kind: "remote_login_request_get";
      status: "not_found";
      flowId: string;
    }
  | {
      kind: "pending_login_approve";
      pendingLogin: RemotePendingLoginStatus;
    }
  | {
      kind: "pending_login_approve";
      status: "credential_store_unavailable";
    }
  | {
      kind: "pending_login_deny";
      pendingLogin: RemotePendingLoginStatus;
    }
  | {
      kind: "pending_login_deny";
      status: "credential_store_unavailable";
    }
  | { kind: "client_revoke"; revoked: boolean; clientId: string; sessionEnded: boolean }
  | { kind: "client_revoke"; status: "credential_store_unavailable"; clientId: string }
  | {
      kind: "client_revoke";
      status: "revoked";
      client: RemoteClientStatus;
      sessionEnded: boolean;
    }
  | {
      kind: "client_revoke";
      status: "not_found";
      clientId: string;
      sessionEnded: false;
    }
  | {
      kind: "client_change_role";
      status: "not_found";
      clientId: string;
      sessionEnded: false;
    }
  | {
      kind: "client_change_role";
      status: "changed";
      client: RemoteClientStatus;
      sessionEnded: boolean;
    }
  | { kind: "client_change_role"; status: "credential_store_unavailable"; clientId: string }
  | { kind: "activity_list"; activity: CurrentHostActivityPage }
  | {
      kind: "activity_page";
      page: StorageKeysetPage<OperatorActivityEntry, OperatorActivityPageKey>;
    }
  | { kind: "vault_set"; status: VaultValueStatus }
  | {
      kind: "vault_list";
      values: VaultValueStatus[];
      grants: CurrentHostVaultAccessGrant[];
    }
  | {
      kind: "vault_values_page";
      page: StorageKeysetPage<
        Extract<VaultValueRecordStatus, { present: true }>,
        VaultValuePageKey
      >;
    }
  | { kind: "vault_get"; status: VaultValueStatus }
  | { kind: "vault_delete"; deleted: VaultDeleteStatus }
  | { kind: "vault_access_grant"; grant: CurrentHostVaultAccessGrant }
  | { kind: "vault_access_revoke"; revoked: CurrentHostVaultAccessGrant[] }
  | { kind: "vault_access_list"; grants: CurrentHostVaultAccessGrant[] }
  | {
      kind: "vault_grants_page";
      page: StorageKeysetPage<CurrentHostVaultAccessGrant, VaultGrantPageKey>;
    }
  | { kind: "stored_caplets_list"; records: CapletRecordView[] }
  | {
      kind: "stored_caplets_page";
      page: StorageKeysetPage<CapletRecordSummaryView, CapletRecordPageKey>;
    }
  | {
      kind: "stored_caplet_get";
      record: CapletRecordView;
      document: string;
    }
  | {
      kind: "stored_caplet_bundle_get";
      record: CapletRecordView;
      sources: ReopenableBundleFileSource[];
    }
  | { kind: "stored_caplet_import"; record: CapletRecordView }
  | { kind: "stored_caplet_bundle_import"; record: CapletRecordView }
  | { kind: "stored_caplet_update"; record: CapletRecordView }
  | { kind: "stored_caplet_bundle_update"; record: CapletRecordView }
  | { kind: "stored_caplet_delete"; deleted: true; id: string }
  | {
      kind: "stored_caplet_revisions";
      revisions: Array<{ revisionKey: string; sequence: number; name: string }>;
    }
  | {
      kind: "stored_caplet_revisions_page";
      page: StorageKeysetPage<CapletRevisionSummaryView, CapletRevisionPageKey>;
    }
  | { kind: "stored_caplet_restore_revision"; record: CapletRecordView }
  | {
      kind: "stored_caplet_delete_revision";
      record?: CapletRecordView | undefined;
    }
  | {
      kind: "stored_caplet_installations_page";
      page: StorageKeysetPage<CapletInstallationView, CapletInstallationPageKey>;
    }
  | {
      kind: "stored_caplet_installation_observations_page";
      page: StorageKeysetPage<
        CapletInstallationObservationView,
        CapletInstallationObservationPageKey
      >;
    }
  | {
      kind: "stored_caplet_installation_status";
      installations: CapletInstallationView[];
      observations: CapletInstallationObservationView[];
    }
  | {
      kind: "stored_caplet_installation_get";
      status: "found";
      installation: CapletInstallationView;
    }
  | {
      kind: "stored_caplet_installation_get";
      status: "not_found";
      id: string;
      installationKey?: string | undefined;
    }
  | {
      kind: "stored_caplet_installation_put";
      status: "created";
      installation: CapletInstallationView;
    }
  | {
      kind: "stored_caplet_installation_put";
      status: "replaced";
      installation: CapletInstallationView;
    }
  | {
      kind: "stored_caplet_installation_put";
      status: "not_found";
      id: string;
      installationKey: string;
    }
  | {
      kind: "stored_caplet_installation_delete";
      status: "detached";
      installation: CapletInstallationView;
    }
  | {
      kind: "stored_caplet_installation_delete";
      status: "not_found";
      id: string;
      installationKey: string;
    }
  | {
      kind: "stored_caplet_installation_observe";
      observation: CapletInstallationObservationView;
      installation: CapletInstallationView;
    }
  | {
      kind: "runtime";
      runtime: {
        status: CurrentHostRuntimeSnapshot["status"];
        version: string;
        bind: string;
        baseUrl: string;
        publicOrigin: string | null;
        reason?: string | undefined;
      };
      daemon: { restartAvailable: false; stopAvailable: false; uninstallAvailable: false };
    }
  | { kind: "runtime_restart"; restartAvailable: false; reason: "daemon_manager_unavailable" }
  | {
      kind: "logs";
      page: StorageKeysetPage<CurrentHostLogEntry, CurrentHostLogPageKey>;
    }
  | {
      kind: "diagnostics";
      status: CurrentHostRuntimeSnapshot["status"];
      diagnostics: Array<{
        id: string;
        status: "ok" | "warning" | "error";
        detail?: string | undefined;
      }>;
      checks: Array<{
        id: string;
        status: "ok" | "warning" | "error";
        detail?: string | undefined;
      }>;
    }
  | {
      kind: "runtime_event";
      event: CurrentHostRuntimeEvent;
    }
  | {
      kind: "project_binding";
      projectBinding: CurrentHostProjectBindingSnapshot;
    };

/** The outcome family determined by a semantic Current Host operation's discriminant. */
export type CurrentHostOperationOutcomeFor<TOperation extends CurrentHostOperation> = Extract<
  CurrentHostOperationOutcome,
  { kind: TOperation["kind"] }
>;

export type CurrentHostRuntimeEvent = {
  type: "runtime_health";
  runtime: {
    status: CurrentHostRuntimeSnapshot["status"];
    version: string;
    reason?: string | undefined;
  };
  projectBinding: { state: CurrentHostProjectBindingSnapshot["state"] };
};

/**
 * The single app-scoped Current Host administration boundary. Adapters authenticate
 * and serialize; this Module owns safe administration policy and outcomes.
 */
export interface CurrentHostOperations {
  execute<const TOperation extends CurrentHostOperation>(
    principal: CurrentHostPrincipal,
    operation: TOperation,
  ): Promise<CurrentHostOperationOutcomeFor<TOperation>>;
  runtimeEvents(principal: CurrentHostPrincipal): ReadableStream<CurrentHostRuntimeEvent>;
  close(): void;
}

export type CurrentHostActivityStore = {
  append(input: AppendOperatorActivityInput): unknown | Promise<unknown>;
  list(
    input?: ListDashboardActivityInput,
  ): CurrentHostActivityPage | Promise<CurrentHostActivityPage>;
  listPage?(
    input?: ListOperatorActivityPageInput,
  ): Promise<StorageKeysetPage<OperatorActivityEntry, OperatorActivityPageKey>>;
};

export type CurrentHostOperationsDependencies = {
  engine: Pick<CapletsEngine, "enabledServers">;
  control?: CurrentHostControlContext | undefined;
  activityLog: CurrentHostActivityStore;
  runtimeState?: CurrentHostRuntimeStateOwner | undefined;
  logState?: CurrentHostLogStateOwner | undefined;
  projectBindingState?: CurrentHostProjectBindingStateOwner | undefined;
  remoteCredentialStore?: RemoteServerCredentialStore | RemoteSecurityStore | undefined;
  capletRecords?: CapletRecordStore | undefined;
  capletInstallations?: CapletInstallationStore | undefined;
  backendAuthStore?: BackendAuthStateStore | undefined;
  backendAuthFlows?: BackendAuthFlowRepository | undefined;
  backendAuthCallbackBaseUrl?: string | undefined;
  invalidateConfig?: ((operatorClientId: string) => Promise<void>) | undefined;
  activateConfig?: (() => Promise<void>) | undefined;
  catalogStorage?: HostStorage | undefined;
  vaultGrants?: VaultGrantStore | undefined;
  vaultValues?: VaultValueRepository | undefined;
  vaultState?: VaultStateStore | undefined;
  version: string;
};

export function createCurrentHostOperations(
  dependencies: CurrentHostOperationsDependencies,
): CurrentHostOperations {
  const catalog = createCurrentHostCatalogOperations(dependencies);
  const clients = createCurrentHostClientOperations(dependencies);
  const vault = createCurrentHostVaultOperations(dependencies);
  const records = createCurrentHostRecordOperations(dependencies);
  const installations = createCurrentHostInstallationOperations(dependencies);
  const backendAuth = createCurrentHostBackendAuthOperations(dependencies);
  const runtimeEventStreams = createCurrentHostRuntimeEventStreams(dependencies);

  return {
    async execute<const TOperation extends CurrentHostOperation>(
      principal: CurrentHostPrincipal,
      operation: TOperation,
    ): Promise<CurrentHostOperationOutcomeFor<TOperation>> {
      if (operation.kind === "backend_auth_flow_callback_complete") {
        assertBackendAuthCallbackPrincipal(principal, operation.flowId);
        const outcome = await backendAuth.completeCallback(operation);
        return outcome as CurrentHostOperationOutcomeFor<TOperation>;
      }
      assertOperatorPrincipal(principal);
      const outcome = await executeCurrentHostOperation(
        dependencies,
        catalog,
        clients,
        vault,
        records,
        installations,
        backendAuth,
        principal,
        operation,
      );
      return outcome as CurrentHostOperationOutcomeFor<TOperation>;
    },
    runtimeEvents(principal: CurrentHostPrincipal): ReadableStream<CurrentHostRuntimeEvent> {
      assertOperatorPrincipal(principal);
      return runtimeEventStreams.open();
    },
    close(): void {
      runtimeEventStreams.close();
    },
  };
}

type CurrentHostRuntimeEventStreamSubscription = {
  refresh(): void;
  close(): void;
};

function createCurrentHostRuntimeEventStreams(dependencies: CurrentHostOperationsDependencies): {
  open(): ReadableStream<CurrentHostRuntimeEvent>;
  close(): void;
} {
  const subscriptions = new Set<CurrentHostRuntimeEventStreamSubscription>();
  let sourceUnsubscribers: Array<() => void> = [];
  let closed = false;

  const stopSourceSubscriptions = (): void => {
    for (const unsubscribe of sourceUnsubscribers.splice(0)) unsubscribe();
  };

  const remove = (subscription: CurrentHostRuntimeEventStreamSubscription): void => {
    subscriptions.delete(subscription);
    if (subscriptions.size === 0) stopSourceSubscriptions();
  };

  const startSourceSubscriptions = (): void => {
    if (sourceUnsubscribers.length > 0) return;
    const runtimeState = requiredRuntimeState(dependencies);
    const projectBindingState = requiredProjectBindingState(dependencies);
    if (!runtimeState.subscribe || !projectBindingState.subscribe) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Authoritative Current Host event subscriptions are unavailable.",
      );
    }
    const refresh = (): void => {
      for (const subscription of subscriptions) subscription.refresh();
    };
    const nextUnsubscribers: Array<() => void> = [];
    try {
      nextUnsubscribers.push(runtimeState.subscribe(refresh));
      nextUnsubscribers.push(projectBindingState.subscribe(refresh));
      sourceUnsubscribers = nextUnsubscribers;
    } catch (error) {
      for (const unsubscribe of nextUnsubscribers) unsubscribe();
      throw error;
    }
  };

  const open = (): ReadableStream<CurrentHostRuntimeEvent> => {
    if (closed) {
      throw new CapletsError("SERVER_UNAVAILABLE", "Current Host event streaming is closed.");
    }
    let controller: ReadableStreamDefaultController<CurrentHostRuntimeEvent> | undefined;
    let latest: CurrentHostRuntimeEvent | undefined;
    let lastEmitted: CurrentHostRuntimeEvent | undefined;
    let refreshPending = false;
    let refreshInFlight = false;
    let streamClosed = false;

    const flush = (): void => {
      if (
        streamClosed ||
        controller === undefined ||
        latest === undefined ||
        controller.desiredSize === null ||
        controller.desiredSize <= 0
      ) {
        return;
      }
      const event = latest;
      latest = undefined;
      if (lastEmitted && currentHostRuntimeEventsEqual(lastEmitted, event)) return;
      lastEmitted = event;
      controller.enqueue(event);
    };

    const cleanup = (): void => {
      if (streamClosed) return;
      streamClosed = true;
      remove(subscription);
    };

    const refresh = (): void => {
      if (streamClosed) return;
      refreshPending = true;
      if (refreshInFlight) return;
      refreshInFlight = true;
      void (async () => {
        try {
          while (refreshPending && !streamClosed) {
            refreshPending = false;
            latest = await readCurrentHostRuntimeEvent(dependencies);
            flush();
          }
        } catch (error) {
          if (!streamClosed) {
            cleanup();
            controller?.error(error);
          }
        } finally {
          refreshInFlight = false;
          if (refreshPending && !streamClosed) refresh();
        }
      })();
    };

    const subscription: CurrentHostRuntimeEventStreamSubscription = {
      refresh,
      close() {
        if (streamClosed) return;
        cleanup();
        controller?.close();
      },
    };

    return new ReadableStream<CurrentHostRuntimeEvent>({
      start(nextController) {
        controller = nextController;
        subscriptions.add(subscription);
        try {
          startSourceSubscriptions();
          refresh();
        } catch (error) {
          cleanup();
          controller.error(error);
        }
      },
      pull() {
        flush();
      },
      cancel() {
        cleanup();
      },
    });
  };

  return {
    open,
    close() {
      if (closed) return;
      closed = true;
      stopSourceSubscriptions();
      for (const subscription of subscriptions) subscription.close();
    },
  };
}

function currentHostRuntimeEventsEqual(
  left: CurrentHostRuntimeEvent,
  right: CurrentHostRuntimeEvent,
): boolean {
  return (
    left.runtime.status === right.runtime.status &&
    left.runtime.version === right.runtime.version &&
    left.runtime.reason === right.runtime.reason &&
    left.projectBinding.state === right.projectBinding.state
  );
}

type CurrentHostOperatorOperation = Exclude<
  CurrentHostOperation,
  { kind: "backend_auth_flow_callback_complete" }
>;

async function executeCurrentHostOperation(
  dependencies: CurrentHostOperationsDependencies,
  catalog: ReturnType<typeof createCurrentHostCatalogOperations>,
  clients: ReturnType<typeof createCurrentHostClientOperations>,
  vault: ReturnType<typeof createCurrentHostVaultOperations>,
  records: ReturnType<typeof createCurrentHostRecordOperations>,
  installations: CurrentHostInstallationOperations,
  backendAuth: CurrentHostBackendAuthOperations,
  principal: CurrentHostOperatorPrincipal,
  operation: CurrentHostOperatorOperation,
): Promise<CurrentHostOperationOutcome> {
  switch (operation.kind) {
    case "summary":
      return clients.summary(await vault.valueCount(), operation);
    case "caplets_list":
      return catalog.capletsList(operation);
    case "caplets_page":
      return catalog.capletsPage(operation);
    case "catalog_search":
      return await catalog.search(operation);
    case "catalog_entries_page":
      return await catalog.entriesPage(operation);
    case "catalog_index":
      return await catalog.index(operation);
    case "catalog_detail":
      return await catalog.detail(operation);
    case "catalog_updates":
      return catalog.updates(operation);
    case "catalog_update_candidates_page":
      return catalog.updateCandidatesPage(operation);
    case "catalog_install":
      return await catalog.install(principal, operation);
    case "catalog_update":
      return await catalog.update(principal, operation);
    case "clients_list":
      return await clients.listClients();
    case "remote_clients_page":
      return await clients.listClientsPage(operation);
    case "remote_client_get":
      return await clients.getClient(operation);
    case "backend_auth_connections_page":
      return await backendAuth.listConnectionsPage(operation);
    case "backend_auth_configured_statuses":
      return await backendAuth.listConfiguredStatuses();
    case "backend_auth_connection_get":
      return await backendAuth.getConnection(operation);
    case "backend_auth_connection_delete":
      return await backendAuth.deleteConnection(principal, operation);
    case "backend_auth_connection_delete_if_present":
      return await backendAuth.deleteConnectionIfPresent(principal, operation);
    case "backend_auth_flow_start":
      return await backendAuth.startFlow(principal, operation);
    case "backend_auth_legacy_flow_start":
      return await backendAuth.startLegacyFlow(principal, operation);
    case "backend_auth_flow_get":
      return await backendAuth.getFlow(operation);
    case "backend_auth_refresh":
      return await backendAuth.refreshConnection(principal, operation);
    case "pending_logins_list":
      return await clients.listPendingLogins();
    case "remote_login_requests_page":
      return await clients.listPendingLoginsPage(operation);
    case "remote_login_request_get":
      return await clients.getPendingLogin(operation);
    case "pending_login_approve":
      return await clients.approvePendingLogin(principal, operation);
    case "pending_login_deny":
      return await clients.denyPendingLogin(principal, operation);
    case "client_revoke":
      return await clients.revokeClient(principal, operation);
    case "client_change_role":
      return await clients.changeClientRole(principal, operation);
    case "activity_list":
      return { kind: "activity_list", activity: await dependencies.activityLog.list(operation) };
    case "activity_page":
      if (!dependencies.activityLog.listPage) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "Authoritative Operator Activity storage is unavailable.",
        );
      }
      return {
        kind: "activity_page",
        page: await dependencies.activityLog.listPage({
          limit: operation.limit,
          sort: operation.sort,
          ...(operation.after === undefined ? {} : { after: operation.after }),
          ...(operation.action === undefined ? {} : { action: operation.action }),
        }),
      };
    case "vault_set":
      return await vault.set(principal, operation);
    case "vault_list":
      return await vault.list(operation);
    case "vault_values_page":
      return await vault.listValuesPage(operation);
    case "vault_get":
      return await vault.get(operation);
    case "vault_delete":
      return await vault.delete(principal, operation);
    case "vault_access_grant":
      return await vault.grant(principal, operation);
    case "vault_access_revoke":
      return await vault.revoke(principal, operation);
    case "vault_access_list":
      return await vault.listAccess(operation);
    case "vault_grants_page":
      return await vault.listGrantsPage(operation);
    case "stored_caplets_list":
      return await records.list(principal);
    case "stored_caplet_get":
      return await records.get(principal, operation);
    case "stored_caplets_page":
      return await records.page(operation);
    case "stored_caplet_import":
      return await records.import(principal, operation);
    case "stored_caplet_bundle_get":
      return await records.bundleGet(principal, operation);
    case "stored_caplet_update":
      return await records.update(principal, operation);
    case "stored_caplet_bundle_import":
      return await records.bundleImport(principal, operation);
    case "stored_caplet_delete":
      return await records.delete(principal, operation);
    case "stored_caplet_bundle_update":
      return await records.bundleUpdate(principal, operation);
    case "stored_caplet_revisions":
      return await records.revisions(principal, operation);
    case "stored_caplet_restore_revision":
      return await records.restoreRevision(principal, operation);
    case "stored_caplet_revisions_page":
      return await records.revisionsPage(principal, operation);
    case "stored_caplet_delete_revision":
      return await records.deleteRevision(principal, operation);
    case "stored_caplet_installations_page":
      return await installations.page(operation);
    case "stored_caplet_installation_observations_page":
      return await installations.observationsPage(operation);
    case "stored_caplet_installation_status":
      return await installations.status(operation);
    case "stored_caplet_installation_get":
      return await installations.get(operation);
    case "stored_caplet_installation_put":
      return await installations.put(principal, operation);
    case "stored_caplet_installation_delete":
      return await installations.delete(principal, operation);
    case "stored_caplet_installation_observe":
      return await installations.observe(principal, operation);
    case "runtime": {
      const runtime = await requiredRuntimeState(dependencies).read();
      return {
        kind: "runtime",
        runtime: {
          status: runtime.status,
          version: dependencies.version,
          bind: operation.bind,
          baseUrl: operation.baseUrl,
          publicOrigin: operation.publicOrigin ?? null,
          ...(runtime.status === "error" && runtime.reason !== undefined
            ? { reason: runtime.reason }
            : {}),
        },
        daemon: { restartAvailable: false, stopAvailable: false, uninstallAvailable: false },
      };
    }
    case "runtime_restart":
      await dependencies.activityLog.append({
        actorClientId: principal.clientId,
        action: "runtime_restart_requested",
        outcome: "failure",
        target: { type: "runtime", id: "current-host" },
        metadata: { reason: "daemon_manager_unavailable" },
      });
      return {
        kind: "runtime_restart",
        restartAvailable: false,
        reason: "daemon_manager_unavailable",
      };
    case "logs": {
      const page = await requiredLogState(dependencies).listPage({
        sort: operation.sort,
        ...(operation.limit === undefined ? {} : { limit: operation.limit }),
        ...(operation.after === undefined ? {} : { after: operation.after }),
      });
      return { kind: "logs", page };
    }
    case "diagnostics": {
      const runtime = await requiredRuntimeState(dependencies).read();
      const runtimeCheck = {
        id: "runtime",
        status: runtime.status,
        ...(runtime.status === "error" && runtime.reason !== undefined
          ? { detail: runtime.reason }
          : {}),
      };
      return {
        kind: "diagnostics",
        status: runtime.status,
        diagnostics: runtime.status === "error" ? [runtimeCheck] : [],
        checks: [runtimeCheck],
      };
    }
    case "runtime_event":
      return {
        kind: "runtime_event",
        event: await readCurrentHostRuntimeEvent(dependencies),
      };
    case "project_binding":
      return {
        kind: "project_binding",
        projectBinding: await requiredProjectBindingState(dependencies).read(),
      };
    default:
      return assertNever(operation);
  }
}

async function readCurrentHostRuntimeEvent(
  dependencies: CurrentHostOperationsDependencies,
): Promise<CurrentHostRuntimeEvent> {
  const [runtime, projectBinding] = await Promise.all([
    requiredRuntimeState(dependencies).read(),
    requiredProjectBindingState(dependencies).read(),
  ]);
  return {
    type: "runtime_health",
    runtime: {
      status: runtime.status,
      version: dependencies.version,
      ...(runtime.status === "error" && runtime.reason !== undefined
        ? { reason: runtime.reason }
        : {}),
    },
    projectBinding: { state: projectBinding.state },
  };
}

function requiredRuntimeState(
  dependencies: CurrentHostOperationsDependencies,
): CurrentHostRuntimeStateOwner {
  if (!dependencies.runtimeState) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Authoritative runtime state is unavailable.");
  }
  return dependencies.runtimeState;
}

function requiredLogState(
  dependencies: CurrentHostOperationsDependencies,
): CurrentHostLogStateOwner {
  if (!dependencies.logState) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Authoritative Current Host logs are unavailable.",
    );
  }
  return dependencies.logState;
}

function requiredProjectBindingState(
  dependencies: CurrentHostOperationsDependencies,
): CurrentHostProjectBindingStateOwner {
  if (!dependencies.projectBindingState) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Authoritative Project Binding state is unavailable.",
    );
  }
  return dependencies.projectBindingState;
}

function assertBackendAuthCallbackPrincipal(
  principal: unknown,
  flowId: string,
): asserts principal is CurrentHostBackendAuthCallbackPrincipal {
  if (
    !isRecord(principal) ||
    principal.role !== "backend_auth_callback" ||
    principal.flowId !== flowId ||
    Object.keys(principal).some((key) => key !== "role" && key !== "flowId")
  ) {
    throw new CapletsError(
      "AUTH_FAILED",
      "Backend auth callback completion requires matching opaque flow state.",
    );
  }
}

function assertOperatorPrincipal(
  principal: unknown,
): asserts principal is CurrentHostOperatorPrincipal {
  if (
    !isRecord(principal) ||
    principal.role !== "operator" ||
    (principal.clientId !== "development_unauthenticated" &&
      (typeof principal.clientId !== "string" ||
        !/^rcli_[A-Za-z0-9_-]{16}$/u.test(principal.clientId))) ||
    (principal.clientId === "development_unauthenticated" &&
      Reflect.get(principal, TRUSTED_DEVELOPMENT_PRINCIPAL) !== true) ||
    typeof principal.hostUrl !== "string" ||
    !isHttpUrl(principal.hostUrl) ||
    (principal.clientLabel !== undefined && typeof principal.clientLabel !== "string")
  ) {
    throw new CapletsError(
      "AUTH_FAILED",
      "Current Host administration requires an Operator principal.",
    );
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new CapletsError(
    "UNKNOWN_OPERATION",
    `Unsupported Current Host operation ${String(value)}`,
  );
}
