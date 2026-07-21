import { describe, expect, it } from "vitest";

import {
  DASHBOARD_OPERATION_DESTINATIONS,
  REMOTE_CLI_DESTINATIONS,
} from "../src/admin-api/destinations";
import { ADMIN_V2_ROUTE_DEFINITIONS } from "../src/admin-api/openapi";
import { REMOTE_CLI_COMMAND_DESTINATIONS } from "../src/remote-control/types";

describe("Admin API migration destinations", () => {
  it("uses the production remote dispatcher destinations", () => {
    expect(REMOTE_CLI_DESTINATIONS).toBe(REMOTE_CLI_COMMAND_DESTINATIONS);
    expect(REMOTE_CLI_DESTINATIONS.complete_cli).toBe("attach");
    expect(REMOTE_CLI_DESTINATIONS.auth_login_complete).toBe("public_auth_self_service");
  });

  it("maps dashboard actions to canonical Admin operations", () => {
    const operationIds = new Set(
      ADMIN_V2_ROUTE_DEFINITIONS.map((definition) => definition.operationId),
    );

    for (const destination of Object.values(DASHBOARD_OPERATION_DESTINATIONS)) {
      if (destination.category === "admin-v2") {
        expect(operationIds, destination.operationId).toContain(destination.operationId);
      }
    }

    expect({
      summary: DASHBOARD_OPERATION_DESTINATIONS.summary,
      caplets: DASHBOARD_OPERATION_DESTINATIONS.caplets,
      createStoredCaplet: DASHBOARD_OPERATION_DESTINATIONS.createStoredCaplet,
      updateStoredCaplet: DASHBOARD_OPERATION_DESTINATIONS.updateStoredCaplet,
      restoreStoredCapletRevision: DASHBOARD_OPERATION_DESTINATIONS.restoreStoredCapletRevision,
      catalogSearch: DASHBOARD_OPERATION_DESTINATIONS.catalogSearch,
      catalogDetail: DASHBOARD_OPERATION_DESTINATIONS.catalogDetail,
      catalogUpdates: DASHBOARD_OPERATION_DESTINATIONS.catalogUpdates,
      accessClients: DASHBOARD_OPERATION_DESTINATIONS.accessClients,
      pendingLogins: DASHBOARD_OPERATION_DESTINATIONS.pendingLogins,
      approvePendingLogin: DASHBOARD_OPERATION_DESTINATIONS.approvePendingLogin,
      denyPendingLogin: DASHBOARD_OPERATION_DESTINATIONS.denyPendingLogin,
      revokeAccessClient: DASHBOARD_OPERATION_DESTINATIONS.revokeAccessClient,
      changeAccessClientRole: DASHBOARD_OPERATION_DESTINATIONS.changeAccessClientRole,
      activity: DASHBOARD_OPERATION_DESTINATIONS.activity,
      restartRuntime: DASHBOARD_OPERATION_DESTINATIONS.restartRuntime,
    }).toEqual({
      summary: { category: "admin-v2", operationId: "adminV2GetHost" },
      caplets: { category: "admin-v2", operationId: "adminV2ListEffectiveCaplets" },
      createStoredCaplet: {
        category: "admin-v2",
        operationId: "adminV2PutCapletRecordBundle",
      },
      updateStoredCaplet: {
        category: "admin-v2",
        operationId: "adminV2UpdateCapletRecord",
      },
      restoreStoredCapletRevision: {
        category: "admin-v2",
        operationId: "adminV2PutCapletRecordCurrentRevision",
      },
      catalogSearch: { category: "admin-v2", operationId: "adminV2ListCatalogEntries" },
      catalogDetail: { category: "admin-v2", operationId: "adminV2GetCatalogEntry" },
      catalogUpdates: {
        category: "admin-v2",
        operationId: "adminV2ListCatalogUpdateCandidates",
      },
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
      revokeAccessClient: {
        category: "admin-v2",
        operationId: "adminV2DeleteRemoteClient",
      },
      changeAccessClientRole: {
        category: "admin-v2",
        operationId: "adminV2UpdateRemoteClient",
      },
      activity: { category: "admin-v2", operationId: "adminV2ListActivity" },
      restartRuntime: {
        category: "admin-v2",
        operationId: "adminV2CreateRuntimeRestart",
      },
    });
  });
});
