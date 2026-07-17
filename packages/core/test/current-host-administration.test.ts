import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allocateCurrentHostOperationBinding,
  createCurrentHostOperationIndeterminateOutcome,
  createCurrentHostOperations,
  recoverCurrentHostOperation,
  reserveCurrentHostOperationLookup,
  toCurrentHostSafeError,
  validateCurrentHostConfirmation,
  type CurrentHostOperationOutcome,
  type CurrentHostOperationReservationState,
  type CurrentHostPrincipal,
} from "../src/current-host/operations";
import type { PersistGlobalCatalogChangeInput } from "../src/current-host/catalog-operations";
import { DashboardActivityLog } from "../src/dashboard/activity-log";
import { CapletsEngine } from "../src/engine";
import { CapletsError } from "../src/errors";
import { RemoteServerCredentialStore } from "../src/remote/server-credential-store";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Current Host administration operations", () => {
  it("returns the safe Current Host read model, catalog projections, activity, and runtime state", async () => {
    const setup = testOperations();
    try {
      await setup.operations.execute(setup.principal, {
        kind: "vault_set",
        name: "GH_TOKEN",
        value: "summary_secret",
      });
      const summary: Extract<CurrentHostOperationOutcome, { kind: "summary" }> =
        await setup.operations.execute(setup.principal, {
          kind: "summary",
          baseUrl: setup.principal.hostUrl,
          dashboardUrl: `${setup.principal.hostUrl}dashboard`,
          dashboardPath: "/dashboard",
        });
      const caplets: Extract<CurrentHostOperationOutcome, { kind: "caplets_list" }> =
        await setup.operations.execute(setup.principal, { kind: "caplets_list" });
      const activity = await setup.operations.execute(setup.principal, {
        kind: "activity_list",
        limit: 1,
      });
      const runtime: Extract<CurrentHostOperationOutcome, { kind: "runtime" }> =
        await setup.operations.execute(setup.principal, {
          kind: "runtime",
          baseUrl: setup.principal.hostUrl,
          bind: "127.0.0.1:5387",
          publicOrigin: null,
        });
      const logs = await setup.operations.execute(setup.principal, { kind: "logs", limit: 5 });
      const diagnostics = await setup.operations.execute(setup.principal, { kind: "diagnostics" });
      const event = await setup.operations.execute(setup.principal, { kind: "runtime_event" });
      const binding = await setup.operations.execute(setup.principal, { kind: "project_binding" });

      expect(summary).toEqual(
        expect.objectContaining({
          kind: "summary",
          summary: expect.objectContaining({
            host: expect.objectContaining({ current: true, version: "test-version" }),
            sections: expect.objectContaining({ vault: expect.objectContaining({ count: 1 }) }),
          }),
        }),
      );
      expect(caplets).toEqual(
        expect.objectContaining({
          kind: "caplets_list",
          caplets: [expect.objectContaining({ id: "status" })],
        }),
      );
      expect(activity).toEqual(
        expect.objectContaining({
          kind: "activity_list",
          activity: expect.objectContaining({
            entries: [expect.objectContaining({ action: "vault_set" })],
          }),
        }),
      );
      expect(runtime).toEqual(
        expect.objectContaining({
          kind: "runtime",
          runtime: expect.objectContaining({ bind: "127.0.0.1:5387" }),
        }),
      );
      expect(logs).toEqual({ kind: "logs", entries: [], limit: 5, truncated: false });
      expect(diagnostics).toEqual(expect.objectContaining({ kind: "diagnostics", status: "ok" }));
      expect(event).toEqual(expect.objectContaining({ kind: "runtime_event" }));
      expect(binding).toEqual(expect.objectContaining({ kind: "project_binding" }));
      const serialized = JSON.stringify({
        summary,
        caplets,
        activity,
        runtime,
        logs,
        diagnostics,
        event,
        binding,
      });
      expect(serialized).not.toContain("summary_secret");
      expect(serialized).not.toContain(setup.configPath);
    } finally {
      await setup.engine.close();
    }
  });

  it("writes activated Vault operations only through the injected SQL repository", async () => {
    const setup = testOperations();
    const setWithGrant = vi.fn(async ({ key, value }: { key: string; value: string }) => ({
      key,
      present: true as const,
      valueBytes: Buffer.byteLength(value),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }));
    const loadRuntimeSnapshot = vi.fn(async () => ({
      caplets: {
        status: {
          id: "status",
          owner: "sql",
          source: { kind: "sql", path: "" },
          effective: true,
          runtimeStatus: "effective",
          shadowChain: [],
        },
      },
    }));
    const operations = createCurrentHostOperations({
      engine: setup.engine,
      activityLog: setup.activity,
      remoteCredentialStore: setup.store,
      vaultRepository: {
        setWithGrant,
        getStatus: vi.fn(),
        listValues: vi.fn(async () => []),
        revealValue: vi.fn(),
        deleteValue: vi.fn(),
        grantAccess: vi.fn(),
        listAccess: vi.fn(async () => []),
        revokeAccess: vi.fn(),
        resolveGrantedValue: vi.fn(),
      },
      management: {
        storage: {} as never,
        loadRuntimeSnapshot: loadRuntimeSnapshot as never,
      },
      version: "test-version",
    });

    await expect(
      operations.execute(setup.principal, {
        kind: "vault_set",
        name: "SQL_ONLY",
        value: "sql-authority",
        grant: "status",
        referenceName: "API_TOKEN",
      }),
    ).resolves.toMatchObject({
      kind: "vault_set",
      status: { key: "SQL_ONLY", present: true },
    });
    expect(setWithGrant).toHaveBeenCalledOnce();
    expect(loadRuntimeSnapshot).toHaveBeenCalledOnce();
    expect(setWithGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        grant: expect.objectContaining({
          capletId: "status",
          origin: { kind: "sql", path: "" },
        }),
      }),
      { actorClientId: setup.principal.clientId },
    );
    await setup.engine.close();
  });

  it("does not fall back to filesystem Caplet origins when SQL authority is unavailable", async () => {
    const setup = testOperations();
    const setWithGrant = vi.fn();
    const operations = createCurrentHostOperations({
      engine: setup.engine,
      activityLog: setup.activity,
      vaultRepository: {
        setWithGrant,
        getStatus: vi.fn(),
        listValues: vi.fn(async () => []),
        revealValue: vi.fn(),
        deleteValue: vi.fn(),
        grantAccess: vi.fn(),
        listAccess: vi.fn(async () => []),
        revokeAccess: vi.fn(),
        resolveGrantedValue: vi.fn(),
      },
      management: {
        storage: {} as never,
        loadRuntimeSnapshot: vi.fn(async () => {
          throw new CapletsError("SERVER_UNAVAILABLE", "SQL authority unavailable");
        }),
      },
      version: "test-version",
    });

    await expect(
      operations.execute(setup.principal, {
        kind: "vault_set",
        name: "SQL_ONLY",
        value: "must-not-persist",
        grant: "status",
      }),
    ).rejects.toMatchObject({ code: "SERVER_UNAVAILABLE" });
    expect(setWithGrant).not.toHaveBeenCalled();
    await setup.engine.close();
  });

  it("prefers injected SQL client authority over a legacy credential store", async () => {
    const setup = testOperations();
    const legacyRevoke = vi.spyOn(setup.store, "revokeClient");
    const sqlRevoke = vi.fn(async () => true);
    const operations = createCurrentHostOperations({
      engine: setup.engine,
      activityLog: setup.activity,
      remoteCredentialStore: setup.store,
      remoteCredentialRepository: {
        issueClient: vi.fn(),
        validateAccessToken: vi.fn(),
        refreshClientCredentials: vi.fn(),
        revokeClient: sqlRevoke,
        changeClientRole: vi.fn(),
        createPendingApproval: vi.fn(),
        resolvePendingApproval: vi.fn(),
        invalidatePendingApprovalsForMigration: vi.fn(),
        listClients: vi.fn(async () => [
          {
            clientId: setup.principal.clientId,
            clientLabel: setup.principal.clientLabel ?? "SQL client",
            hostUrl: setup.principal.hostUrl,
            role: "operator" as const,
            createdAt: new Date(0).toISOString(),
          },
        ]),
      },
      version: "test-version",
    });

    await expect(
      operations.execute(setup.principal, {
        kind: "client_revoke",
        clientId: setup.principal.clientId,
      }),
    ).resolves.toMatchObject({ kind: "client_revoke", revoked: true, sessionEnded: true });
    expect(sqlRevoke).toHaveBeenCalledWith(setup.principal.clientId, {
      actorClientId: setup.principal.clientId,
    });
    expect(legacyRevoke).not.toHaveBeenCalled();
    await setup.engine.close();
  });

  it("shares catalog installation and update policy with actor-attributed activity", async () => {
    const setup = testOperations();
    try {
      const source = catalogSource(setup.root);
      const catalog = await setup.operations.execute(setup.principal, {
        kind: "catalog_search",
        source,
      });
      if (catalog.kind !== "catalog_search") throw new Error("Expected catalog search outcome.");
      const entryKey = catalog.entries.find((entry) => entry.id === "sample")?.entryKey;
      if (!entryKey) throw new Error("Expected sample catalog entry.");
      const installed = await setup.operations.execute(setup.principal, {
        kind: "catalog_install",
        source,
        entryKey,
        disableCatalogIndexing: true,
      });
      const updates = await setup.operations.execute(setup.principal, { kind: "catalog_updates" });
      const updated = await setup.operations.execute(setup.principal, {
        kind: "catalog_update",
        capletIds: ["sample"],
        allowRiskIncrease: true,
        disableCatalogIndexing: true,
      });

      expect(installed).toEqual(
        expect.objectContaining({
          kind: "catalog_install",
          installed: [expect.objectContaining({ id: "sample" })],
        }),
      );
      expect(updates).toEqual(
        expect.objectContaining({
          kind: "catalog_updates",
          updates: [expect.objectContaining({ id: "sample", status: "locked" })],
        }),
      );
      expect(updated).toEqual(
        expect.objectContaining({
          kind: "catalog_update",
          installed: [expect.objectContaining({ id: "sample" })],
        }),
      );
      expect(setup.persistGlobalCatalogChange).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          action: "install",
          artifacts: [
            expect.objectContaining({
              portable: expect.objectContaining({ id: "sample" }),
              provenance: expect.objectContaining({ sourceKind: "local" }),
            }),
          ],
        }),
      );
      expect(setup.loadGlobalCatalogProvenance).toHaveBeenCalledWith(["sample"]);
      expect(setup.persistGlobalCatalogChange).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          action: "update",
          artifacts: [
            expect.objectContaining({
              portable: expect.objectContaining({ id: "sample" }),
            }),
          ],
        }),
      );
      expect(existsSync(join(setup.globalCapletsRoot, "sample.md"))).toBe(false);
      expect(existsSync(setup.globalLockfilePath)).toBe(false);
      const entries = setup.activity.list().entries;
      expect(entries.filter((entry) => entry.action === "catalog_installed")).toEqual([
        expect.objectContaining({
          actorClientId: setup.principal.clientId,
          target: { type: "catalog", id: "sample" },
        }),
      ]);
      expect(entries.filter((entry) => entry.action === "catalog_updated")).toEqual([
        expect.objectContaining({
          actorClientId: setup.principal.clientId,
          target: { type: "catalog", id: "sample" },
        }),
      ]);
      expect(JSON.stringify(entries)).not.toContain(source);
    } finally {
      await setup.engine.close();
    }
  });

  it("records every requested catalog target when a batch update fails", async () => {
    const setup = testOperations();
    try {
      await expect(
        setup.operations.execute(setup.principal, {
          kind: "catalog_update",
          capletIds: ["alpha", "beta"],
          disableCatalogIndexing: true,
        }),
      ).rejects.toBeDefined();
      const targets = setup.activity
        .list()
        .entries.filter((entry) => entry.action === "catalog_updated")
        .map((entry) => entry.target);
      expect(targets).toHaveLength(2);
      expect(targets).toEqual(
        expect.arrayContaining([
          { type: "catalog", id: "alpha" },
          { type: "catalog", id: "beta" },
        ]),
      );
    } finally {
      await setup.engine.close();
    }
  });

  it("redacts credential assignments and filesystem paths from classified failures", () => {
    const safe = toCurrentHostSafeError(
      new CapletsError(
        "CONFIG_NOT_FOUND",
        'Clone failed password=hunter2 "client_secret":"opaque" Authorization: Bearer transport-token /tmp/private C:\\Users\\operator\\private',
      ),
    );

    expect(safe).toEqual({
      code: "CONFIG_NOT_FOUND",
      message:
        'Clone failed password=[REDACTED] "client_secret":"[REDACTED]" Authorization: Bearer [REDACTED] [REDACTED] [REDACTED]',
    });
  });

  it("rejects an Access principal before reading or mutating administration state", async () => {
    const setup = testOperations();
    const accessPrincipal: CurrentHostPrincipal = {
      clientId: setup.principal.clientId,
      hostUrl: setup.principal.hostUrl,
      role: "access",
    };
    try {
      await expect(
        setup.operations.execute(accessPrincipal, { kind: "clients_list" }),
      ).rejects.toMatchObject({ code: "AUTH_FAILED" });
      expect(setup.activity.list().entries).toEqual([]);
    } finally {
      await setup.engine.close();
    }
  });
  it("accepts canonical remote principals but rejects malformed and unminted principals before mutation", async () => {
    const setup = testOperations();
    const malformedPrincipals = [
      JSON.parse(
        '{"clientId":"client-not-canonical","hostUrl":"http://127.0.0.1:5387/","role":"operator"}',
      ),
      JSON.parse('{"clientId":"rcli_abcdefghijklmnop","hostUrl":"not-a-url","role":"operator"}'),
      JSON.parse(
        '{"clientId":"rcli_abcdefghijklmnop","hostUrl":"file:///tmp/caplets","role":"operator"}',
      ),
      JSON.parse(
        '{"clientId":"rcli_abcdefghijklmnop","hostUrl":"http://127.0.0.1:5387/","role":"access"}',
      ),
      JSON.parse('{"hostUrl":"http://127.0.0.1:5387/","role":"operator"}'),
      JSON.parse('{"clientId":"rcli_abcdefghijklmnop","role":"operator"}'),
      JSON.parse(
        '{"clientId":"development_unauthenticated","clientLabel":"<untrusted actor>","hostUrl":"http://127.0.0.1:5387/","role":"operator"}',
      ),
    ];
    const canonicalPrincipal: CurrentHostPrincipal = {
      clientId: "rcli_abcdefghijklmnop",
      hostUrl: "https://127.0.0.1:5387/",
      role: "operator",
    };
    try {
      await expect(
        setup.operations.execute(canonicalPrincipal, { kind: "vault_list" }),
      ).resolves.toEqual({
        kind: "vault_list",
        values: [],
        grants: [],
      });
      for (const principal of malformedPrincipals) {
        await expect(
          setup.operations.execute(principal, {
            kind: "vault_set",
            name: "GH_TOKEN",
            value: "malformed_principal_secret",
          }),
        ).rejects.toMatchObject({ code: "AUTH_FAILED" });
      }
      await expect(
        setup.operations.execute(setup.principal, { kind: "vault_list" }),
      ).resolves.toEqual({
        kind: "vault_list",
        values: [],
        grants: [],
      });
      expect(setup.activity.list().entries).toEqual([]);
    } finally {
      await setup.engine.close();
    }
  });

  it("moves Pending Remote Login and client mutations behind actor-specific outcomes", async () => {
    const setup = testOperations();
    try {
      const pending = setup.store.createPendingLogin({
        hostUrl: setup.principal.hostUrl,
        requestedRole: "access",
        clientLabel: "Tablet",
      });
      const approved = await setup.operations.execute(setup.principal, {
        kind: "pending_login_approve",
        flowId: pending.flowId,
        grantedRole: "operator",
      });
      const other = issueOperator(setup.store, "Second Operator");
      const otherRevoked = await setup.operations.execute(setup.principal, {
        kind: "client_revoke",
        clientId: other.clientId,
      });
      const missing = await setup.operations.execute(setup.principal, {
        kind: "client_change_role",
        clientId: "rcli_abcdefghijklmnop",
        role: "access",
      });
      const selfDemoted = await setup.operations.execute(setup.principal, {
        kind: "client_change_role",
        clientId: setup.principal.clientId,
        role: "access",
      });

      expect(approved).toEqual(
        expect.objectContaining({
          kind: "pending_login_approve",
          pendingLogin: expect.objectContaining({ flowId: pending.flowId, status: "approved" }),
        }),
      );
      expect(otherRevoked).toEqual({
        kind: "client_revoke",
        revoked: true,
        clientId: other.clientId,
        sessionEnded: false,
      });
      expect(missing).toEqual({
        kind: "client_change_role",
        status: "not_found",
        clientId: "rcli_abcdefghijklmnop",
        sessionEnded: false,
      });
      expect(selfDemoted).toEqual(
        expect.objectContaining({
          kind: "client_change_role",
          status: "changed",
          client: expect.objectContaining({ role: "access" }),
          sessionEnded: true,
        }),
      );
      const entries = setup.activity.list().entries;
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "pending_login_approved",
            actorClientId: setup.principal.clientId,
          }),
          expect.objectContaining({
            action: "remote_client_revoked",
            actorClientId: setup.principal.clientId,
          }),
          expect.objectContaining({
            action: "remote_client_role_changed",
            actorClientId: setup.principal.clientId,
            metadata: { fromRole: "operator", toRole: "access" },
          }),
        ]),
      );
      expect(JSON.stringify(entries)).not.toContain(pending.operatorCode);
      expect(JSON.stringify(entries)).not.toContain(pending.pendingCompletionSecret);
    } finally {
      await setup.engine.close();
    }
  });

  it("keeps Vault safe, server-derived, atomic, and redacted", async () => {
    const setup = testOperations();
    const secret = "vault_lifecycle_secret";
    try {
      await setup.operations.execute(setup.principal, {
        kind: "vault_set",
        name: "GH_TOKEN",
        value: secret,
      });
      const status = await setup.operations.execute(setup.principal, {
        kind: "vault_get",
        name: "GH_TOKEN",
      });
      const granted = await setup.operations.execute(setup.principal, {
        kind: "vault_access_grant",
        storedKey: "GH_TOKEN",
        referenceName: "API_TOKEN",
        capletId: "status",
      });
      const listed = await setup.operations.execute(setup.principal, { kind: "vault_access_list" });
      const revoked = await setup.operations.execute(setup.principal, {
        kind: "vault_access_revoke",
        storedKey: "GH_TOKEN",
        referenceName: "API_TOKEN",
        capletId: "status",
      });
      const deleted = await setup.operations.execute(setup.principal, {
        kind: "vault_delete",
        name: "GH_TOKEN",
      });

      expect(status).toEqual(
        expect.objectContaining({
          kind: "vault_get",
          status: {
            key: "GH_TOKEN",
            present: true,
            valueBytes: secret.length,
            createdAt: expect.any(String),
            updatedAt: expect.any(String),
          },
        }),
      );
      expect(granted).toEqual(
        expect.objectContaining({
          kind: "vault_access_grant",
          grant: expect.objectContaining({ origin: { kind: "global-config" } }),
        }),
      );
      expect(listed).toEqual(
        expect.objectContaining({
          kind: "vault_access_list",
          grants: [expect.objectContaining({ storedKey: "GH_TOKEN" })],
        }),
      );
      expect(revoked).toEqual(
        expect.objectContaining({
          kind: "vault_access_revoke",
          revoked: [expect.objectContaining({ storedKey: "GH_TOKEN" })],
        }),
      );
      expect(deleted).toEqual(
        expect.objectContaining({
          kind: "vault_delete",
          deleted: expect.objectContaining({ deleted: true }),
        }),
      );
      const serialized = JSON.stringify({
        status,
        granted,
        listed,
        revoked,
        deleted,
        activity: setup.activity.list(),
      });
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(setup.configPath);
    } finally {
      await setup.engine.close();
    }
  });

  it("records one success for both halves of a successful Vault set-and-grant", async () => {
    const setup = testOperations();
    try {
      await setup.operations.execute(setup.principal, {
        kind: "vault_set",
        name: "GH_TOKEN",
        value: "set_and_grant_secret",
        grant: "status",
        referenceName: "API_TOKEN",
      });

      const entries = setup.activity.list().entries;
      expect(entries.filter((entry) => entry.action === "vault_set")).toEqual([
        expect.objectContaining({
          actorClientId: setup.principal.clientId,
          outcome: "success",
        }),
      ]);
      expect(entries.filter((entry) => entry.action === "vault_grant_added")).toEqual([
        expect.objectContaining({
          actorClientId: setup.principal.clientId,
          outcome: "success",
          metadata: expect.objectContaining({ referenceName: "API_TOKEN", capletId: "status" }),
        }),
      ]);
      expect(entries).toHaveLength(2);
    } finally {
      await setup.engine.close();
    }
  });

  it("rolls back a failed set-and-grant and records only a redacted failure", async () => {
    const setup = testOperations();
    try {
      await expect(
        setup.operations.execute(setup.principal, {
          kind: "vault_set",
          name: "GH_TOKEN",
          value: "rollback_secret",
          grant: "missing_caplet",
        }),
      ).rejects.toMatchObject({ code: "SERVER_NOT_FOUND" });
      await expect(
        setup.operations.execute(setup.principal, { kind: "vault_list" }),
      ).resolves.toEqual({
        kind: "vault_list",
        values: [],
        grants: [],
      });
      const entries = setup.activity.list().entries;
      expect(entries).toEqual([
        expect.objectContaining({
          action: "vault_set",
          actorClientId: setup.principal.clientId,
          outcome: "failure",
        }),
      ]);
      expect(JSON.stringify(entries)).not.toContain("rollback_secret");
    } finally {
      await setup.engine.close();
    }
  });

  it("rejects credential-shaped identifiers without echoing them into outcomes or activity", async () => {
    const setup = testOperations();
    const credentialShapedIds = [
      "cap_remote_access_sensitive",
      "cap_remote_refresh_sensitive",
      "cap_pending_complete_sensitive",
      "cap_login_sensitive",
      "cap_pair_sensitive",
    ];
    try {
      for (const identifier of credentialShapedIds) {
        await expect(
          setup.operations.execute(setup.principal, {
            kind: "client_revoke",
            clientId: identifier,
          }),
        ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
        await expect(
          setup.operations.execute(setup.principal, {
            kind: "client_change_role",
            clientId: identifier,
            role: "access",
          }),
        ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
        await expect(
          setup.operations.execute(setup.principal, {
            kind: "pending_login_deny",
            flowId: identifier,
          }),
        ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
      }
      const serializedActivity = JSON.stringify(setup.activity.list());
      for (const identifier of credentialShapedIds)
        expect(serializedActivity).not.toContain(identifier);
    } finally {
      await setup.engine.close();
    }
  });
  it("retains the caller-known binding and returns a committed receipt without redispatch", async () => {
    const binding = allocateCurrentHostOperationBinding(
      {
        target: "remote",
        logicalHostId: "host_01J00000000000000000000000",
        storeId: "store_01J00000000000000000000000",
        operationNamespace: "operations_01J00000000000000000000000",
        actorId: "rcli_abcdefghijklmnop",
        requestIdentity: "request-sha256",
        operationClass: "logical-state",
      },
      () => "operation_01J00000000000000000000000",
    );
    const receipt = {
      status: "committed" as const,
      binding,
      aggregateVersion: 7,
      authorityToken: { authorityGeneration: 2, effectiveGeneration: 5 },
      localApplication: "applied" as const,
      convergence: { kind: "single-node" as const },
    };
    const lookedUp: string[] = [];
    const recovered = await recoverCurrentHostOperation(
      createCurrentHostOperationIndeterminateOutcome(binding),
      {
        lookupOrReserveNotCommitted(original) {
          lookedUp.push(original.operationId);
          return Promise.resolve({ status: "committed", receipt });
        },
      },
      () => {
        throw new Error("committed lookup must not allocate or redispatch");
      },
    );

    expect(lookedUp).toEqual([binding.operationId]);
    expect(recovered).toEqual({ kind: "return-receipt", receipt });
  });

  it.each(["unknown", "unavailable", "stale_namespace"] as const)(
    "keeps a %s lookup outcome non-retryable under the original operation ID",
    async (status) => {
      const binding = allocateCurrentHostOperationBinding(
        {
          target: "global",
          logicalHostId: "host_01J00000000000000000000000",
          storeId: "store_01J00000000000000000000000",
          operationNamespace: "operations_01J00000000000000000000000",
          actorId: "local-owner",
          requestIdentity: "request-sha256",
          operationClass: "logical-state",
        },
        () => "operation_01J00000000000000000000000",
      );
      let allocated = false;
      const recovered = await recoverCurrentHostOperation(
        createCurrentHostOperationIndeterminateOutcome(binding),
        {
          lookupOrReserveNotCommitted() {
            return Promise.resolve({ status, binding });
          },
        },
        () => {
          allocated = true;
          return "operation_01J11111111111111111111111";
        },
      );

      expect(recovered).toEqual({ kind: "not-retryable", outcome: { status, binding } });
      expect(allocated).toBe(false);
    },
  );

  it("permits a new caller-known ID only after an atomic not-committed reservation", async () => {
    const binding = allocateCurrentHostOperationBinding(
      {
        target: "global",
        logicalHostId: "host_01J00000000000000000000000",
        storeId: "store_01J00000000000000000000000",
        operationNamespace: "operations_01J00000000000000000000000",
        actorId: "local-owner",
        requestIdentity: "request-sha256",
        operationClass: "logical-state",
      },
      () => "operation_01J00000000000000000000000",
    );
    const recovered = await recoverCurrentHostOperation(
      createCurrentHostOperationIndeterminateOutcome(binding),
      {
        lookupOrReserveNotCommitted() {
          return Promise.resolve({
            status: "not_committed",
            binding,
            retryReservationId: "reservation_01J00000000000000000000000",
          });
        },
      },
      () => "operation_01J11111111111111111111111",
    );

    expect(recovered).toEqual({
      kind: "resubmit",
      priorOperationId: binding.operationId,
      retryReservationId: "reservation_01J00000000000000000000000",
      binding: {
        ...binding,
        operationId: "operation_01J11111111111111111111111",
      },
    });
  });

  it("atomically makes a lookup win against a paused dispatch and preserves committed restore results", () => {
    const binding = allocateCurrentHostOperationBinding(
      {
        target: "global",
        logicalHostId: "host_01J00000000000000000000000",
        storeId: "store_01J00000000000000000000000",
        operationNamespace: "operations_01J00000000000000000000000",
        actorId: "local-owner",
        requestIdentity: "request-sha256",
        operationClass: "logical-state",
      },
      () => "operation_01J00000000000000000000000",
    );
    const inFlight: CurrentHostOperationReservationState = { status: "in_flight", binding };
    const lookupWon = reserveCurrentHostOperationLookup(
      inFlight,
      () => "reservation_01J00000000000000000000000",
    );
    expect(lookupWon.outcome.status).toBe("not_committed");
    expect(lookupWon.state.status).toBe("retry_reserved");
    expect(lookupWon.state.status === "retry_reserved" && lookupWon.state.canOriginalCommit).toBe(
      false,
    );

    const committed: CurrentHostOperationReservationState = {
      status: "committed",
      receipt: {
        status: "committed",
        binding,
        aggregateVersion: 1,
        authorityToken: { authorityGeneration: 1, effectiveGeneration: 1 },
        localApplication: "applied",
        convergence: { kind: "single-node" },
      },
    };
    expect(reserveCurrentHostOperationLookup(committed, () => "unused")).toEqual({
      state: committed,
      outcome: { status: "committed", receipt: committed.receipt },
    });
  });

  it("rejects stale or mismatched irreversible-action confirmation without consuming it", () => {
    const confirmation = {
      version: 1 as const,
      tokenId: "confirmation_01J00000000000000000000000",
      action: "key-retirement",
      logicalHostId: "host_01J00000000000000000000000",
      storeId: "store_01J00000000000000000000000",
      authorityToken: { authorityGeneration: 2, effectiveGeneration: 5 },
      affectedVersions: ["key-v1"],
      expiresAt: "2026-07-14T12:05:00.000Z",
      consequences: ["Retired keys cannot decrypt active records."],
      consumed: false as const,
    };

    expect(() =>
      validateCurrentHostConfirmation(
        confirmation,
        {
          action: "key-retirement",
          logicalHostId: confirmation.logicalHostId,
          storeId: confirmation.storeId,
          authorityToken: confirmation.authorityToken,
          affectedVersions: ["key-v2"],
        },
        new Date("2026-07-14T12:00:00.000Z"),
      ),
    ).toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
    expect(confirmation.consumed).toBe(false);
  });
});

function testOperations() {
  const root = tempDir("caplets-current-host-operations-");
  const userRoot = join(root, "user");
  const projectRoot = join(root, "project", ".caplets");
  const authDir = join(root, "auth");
  const globalCapletsRoot = join(root, "global-caplets");
  const globalLockfilePath = join(root, "remote-state", "caplets.lock.json");
  mkdirSync(userRoot, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(authDir, { recursive: true });
  mkdirSync(globalCapletsRoot, { recursive: true });
  const configPath = join(userRoot, "config.json");
  const projectConfigPath = join(projectRoot, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      httpApis: {
        status: {
          name: "Status",
          description: "Status API.",
          baseUrl: "http://127.0.0.1:1",
          auth: { type: "none" },
          actions: { check: { method: "GET", path: "/check" } },
        },
      },
    }),
  );
  const engine = CapletsEngine.unactivatedForTests({ configPath, projectConfigPath, watch: false });
  const store = new RemoteServerCredentialStore({ dir: join(root, "remote-state") });
  const operator = issueOperator(store, "Direct Operator");
  const activity = new DashboardActivityLog({ dir: join(root, "activity") });
  let globalCatalogEntries: PersistGlobalCatalogChangeInput["artifacts"][number]["lockEntry"][] =
    [];
  const loadGlobalCatalogProvenance = vi.fn(async (capletIds: readonly string[] | undefined) => {
    const selected = capletIds === undefined ? undefined : new Set(capletIds);
    return globalCatalogEntries.filter((entry) => selected === undefined || selected.has(entry.id));
  });
  const persistGlobalCatalogChange = vi.fn(async (input: PersistGlobalCatalogChangeInput) => {
    const changed = new Set(input.artifacts.map((artifact) => artifact.lockEntry.id));
    globalCatalogEntries = [
      ...globalCatalogEntries.filter((entry) => !changed.has(entry.id)),
      ...input.artifacts.map((artifact) => artifact.lockEntry),
    ];
    return {
      installed: input.artifacts.map((artifact) => ({
        ...artifact.installed,
        destination: `sql:${artifact.installed.id}`,
      })),
    };
  });
  const operations = createCurrentHostOperations({
    engine,
    control: { configPath, projectConfigPath, authDir, globalCapletsRoot, globalLockfilePath },
    activityLog: activity,
    remoteCredentialStore: store,
    loadGlobalCatalogProvenance,
    persistGlobalCatalogChange,
    version: "test-version",
  });
  return {
    root,
    configPath,
    engine,
    store,
    activity,
    globalCapletsRoot,
    globalLockfilePath,
    loadGlobalCatalogProvenance,
    persistGlobalCatalogChange,
    operations,
    principal: {
      clientId: operator.clientId,
      clientLabel: operator.clientLabel,
      hostUrl: operator.hostUrl,
      role: "operator" as const,
    },
  };
}

function issueOperator(store: RemoteServerCredentialStore, clientLabel: string) {
  const pending = store.createPendingLogin({
    hostUrl: "http://127.0.0.1:5387/",
    requestedRole: "operator",
    clientLabel,
  });
  store.approvePendingLogin({ operatorCode: pending.operatorCode });
  return store.completePendingLogin({
    hostUrl: "http://127.0.0.1:5387/",
    flowId: pending.flowId,
    pendingCompletionSecret: pending.pendingCompletionSecret,
  });
}

function catalogSource(root: string): string {
  const source = join(root, "catalog-source");
  const caplets = join(source, "caplets");
  mkdirSync(caplets, { recursive: true });
  writeFileSync(
    join(caplets, "sample.md"),
    [
      "---",
      "name: Sample",
      "description: Sample Caplet.",
      "httpApi:",
      "  baseUrl: http://127.0.0.1:1",
      "  auth:",
      "    type: none",
      "  actions:",
      "    check:",
      "      method: GET",
      "      path: /check",
      "---",
      "",
      "# Sample",
      "",
    ].join("\n"),
  );
  return source;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
