import { REMOTE_CLI_COMMAND_DESTINATIONS } from "../remote-control/types";

export type AdminMigrationDestination =
  | { category: "admin-v2"; operationId: string }
  | { category: "dashboard-auth"; operation: string }
  | { category: "dashboard-private"; operation: "revealVaultValue" };

export const REMOTE_CLI_DESTINATIONS = REMOTE_CLI_COMMAND_DESTINATIONS;

export const DASHBOARD_OPERATION_DESTINATIONS = {
  loginStart: { category: "dashboard-auth", operation: "loginStart" },
  loginPoll: { category: "dashboard-auth", operation: "loginPoll" },
  loginComplete: { category: "dashboard-auth", operation: "loginComplete" },
  session: { category: "dashboard-auth", operation: "session" },
  summary: { category: "admin-v2", operationId: "adminV2GetHost" },
  caplets: { category: "admin-v2", operationId: "adminV2ListEffectiveCaplets" },
  storedCaplets: { category: "admin-v2", operationId: "adminV2ListCapletRecords" },
  createStoredCaplet: { category: "admin-v2", operationId: "adminV2PutCapletRecordBundle" },
  storedCaplet: { category: "admin-v2", operationId: "adminV2GetCapletRecord" },
  updateStoredCaplet: {
    category: "admin-v2",
    operationId: "adminV2UpdateCapletRecord",
  },
  deleteStoredCaplet: { category: "admin-v2", operationId: "adminV2DeleteCapletRecord" },
  storedCapletRevisions: {
    category: "admin-v2",
    operationId: "adminV2ListCapletRecordRevisions",
  },
  restoreStoredCapletRevision: {
    category: "admin-v2",
    operationId: "adminV2PutCapletRecordCurrentRevision",
  },
  deleteStoredCapletRevision: {
    category: "admin-v2",
    operationId: "adminV2DeleteCapletRecordRevision",
  },
  catalogSearch: { category: "admin-v2", operationId: "adminV2ListCatalogEntries" },
  catalogDetail: { category: "admin-v2", operationId: "adminV2GetCatalogEntry" },
  catalogUpdates: {
    category: "admin-v2",
    operationId: "adminV2ListCatalogUpdateCandidates",
  },
  catalogInstall: { category: "admin-v2", operationId: "adminV2InstallCatalogCaplets" },
  catalogUpdate: { category: "admin-v2", operationId: "adminV2UpdateCatalogCaplets" },
  accessClients: { category: "admin-v2", operationId: "adminV2ListRemoteClients" },
  pendingLogins: {
    category: "admin-v2",
    operationId: "adminV2ListRemoteLoginRequests",
  },
  approvePendingLogin: {
    category: "admin-v2",
    operationId: "adminV2UpdateRemoteLoginRequest",
  },
  denyPendingLogin: {
    category: "admin-v2",
    operationId: "adminV2UpdateRemoteLoginRequest",
  },
  revokeAccessClient: { category: "admin-v2", operationId: "adminV2DeleteRemoteClient" },
  changeAccessClientRole: {
    category: "admin-v2",
    operationId: "adminV2UpdateRemoteClient",
  },
  activity: { category: "admin-v2", operationId: "adminV2ListActivity" },
  vault: { category: "admin-v2", operationId: "adminV2ListVaultValues" },
  setVaultValue: { category: "admin-v2", operationId: "adminV2PutVaultValue" },
  deleteVaultValue: { category: "admin-v2", operationId: "adminV2DeleteVaultValue" },
  grantVaultAccess: { category: "admin-v2", operationId: "adminV2PutVaultGrant" },
  revokeVaultAccess: { category: "admin-v2", operationId: "adminV2RevokeVaultAccess" },
  revealVaultValue: { category: "dashboard-private", operation: "revealVaultValue" },
  runtime: { category: "admin-v2", operationId: "adminV2GetRuntime" },
  restartRuntime: { category: "admin-v2", operationId: "adminV2CreateRuntimeRestart" },
  logs: { category: "admin-v2", operationId: "adminV2ListLogs" },
  diagnostics: { category: "admin-v2", operationId: "adminV2GetDiagnostics" },
  events: { category: "admin-v2", operationId: "adminV2ListEvents" },
  projectBinding: { category: "admin-v2", operationId: "adminV2GetProjectBinding" },
  logout: { category: "dashboard-auth", operation: "logout" },
} as const satisfies Record<string, AdminMigrationDestination>;
