import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCurrentHostOperations,
  toCurrentHostSafeError,
  type CurrentHostOperationOutcome,
  type CurrentHostPrincipal,
} from "../src/current-host/operations";
import { DashboardActivityLog } from "../src/dashboard/activity-log";
import { CapletsEngine } from "../src/engine";
import { CapletsError } from "../src/errors";
import { RemoteServerCredentialStore } from "../src/remote/server-credential-store";
import { createHostStorage } from "../src/storage";

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
      const logs = await setup.operations.execute(setup.principal, {
        kind: "logs",
        sort: "asc",
        limit: 5,
        after: {
          timestamp: "2026-07-20T12:00:00.000Z",
          logKey: "daemon-0002",
        },
      });
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
      expect(logs).toEqual({ kind: "logs", page: { items: [] } });
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

  it("administers stored Caplet revisions through the operator surface", async () => {
    const root = tempDir("caplets-current-host-records-");
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "project", ".caplets", "config.json");
    const authDir = join(root, "auth");
    const globalCapletsRoot = join(root, "global-caplets");
    const globalLockfilePath = join(root, "remote-state", "caplets.lock.json");
    const databasePath = join(root, "host.sqlite3");
    mkdirSync(join(root, "project", ".caplets"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        storage: { type: "sqlite", path: databasePath },
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
    const storage = await createHostStorage({ type: "sqlite", path: databasePath });
    const engine = new CapletsEngine({
      configPath,
      projectConfigPath,
      hostStorage: storage,
      watch: false,
    });
    const credentials = new RemoteServerCredentialStore({ dir: join(root, "remote-state") });
    const issued = issueOperator(credentials, "Stored Caplet Operator");
    const activity = new DashboardActivityLog({ dir: join(root, "activity") });
    const operations = createCurrentHostOperations({
      engine,
      control: { configPath, projectConfigPath, authDir, globalCapletsRoot, globalLockfilePath },
      activityLog: activity,
      remoteCredentialStore: credentials,
      capletRecords: storage.caplets,
      invalidateConfig: async (actor) => {
        await storage.invalidateConfig(actor);
        await engine.reload();
      },
      version: "test-version",
    });
    const principal = {
      clientId: issued.clientId,
      clientLabel: issued.clientLabel,
      hostUrl: issued.hostUrl,
      role: "operator" as const,
    };

    try {
      const imported = await operations.execute(principal, {
        kind: "stored_caplet_import",
        id: "stored",
        document: storedDocument("first"),
        historyLimit: 3,
      });
      if (imported.kind !== "stored_caplet_import") throw new Error("Expected stored import.");
      const updated = await operations.execute(principal, {
        kind: "stored_caplet_update",
        id: "stored",
        document: storedDocument("second"),
        expectedGeneration: imported.record.headGeneration,
      });
      if (updated.kind !== "stored_caplet_update") throw new Error("Expected stored update.");
      const revisions = await operations.execute(principal, {
        kind: "stored_caplet_revisions",
        id: "stored",
      });
      if (revisions.kind !== "stored_caplet_revisions") throw new Error("Expected revisions.");
      expect(revisions.revisions).toHaveLength(2);
      const restored = await operations.execute(principal, {
        kind: "stored_caplet_restore_revision",
        id: "stored",
        revisionKey: revisions.revisions[1]!.revisionKey,
        expectedGeneration: updated.record.headGeneration,
      });
      if (restored.kind !== "stored_caplet_restore_revision") {
        throw new Error("Expected revision restore.");
      }
      const read = await operations.execute(principal, {
        kind: "stored_caplet_get",
        id: "stored",
      });
      expect(read).toMatchObject({
        kind: "stored_caplet_get",
        record: { id: "stored", headGeneration: restored.record.headGeneration },
        document: expect.stringContaining("command: first"),
      });
      await operations.execute(principal, {
        kind: "stored_caplet_delete",
        id: "stored",
        expectedGeneration: restored.record.headGeneration,
      });
      await expect(operations.execute(principal, { kind: "stored_caplets_list" })).resolves.toEqual(
        { kind: "stored_caplets_list", records: [] },
      );
      expect(
        (await storage.installations.listActivity()).map((entry) => entry.operatorClientId),
      ).toEqual(expect.arrayContaining([principal.clientId]));
    } finally {
      await engine.close();
      await storage.close();
    }
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

  it("rolls authoritative SQL Vault state back when grant insertion fails", async () => {
    let activationCalls = 0;
    const setup = await sqlTestOperations(async () => {
      activationCalls += 1;
    });
    if (setup.storage.database.dialect !== "sqlite") throw new Error("Expected SQLite storage");
    try {
      setup.storage.database.db.run(
        sql.raw(`
          create temp trigger fail_current_host_vault_grant
          before insert on vault_access_grants
          begin
            select raise(abort, 'injected current-host grant failure');
          end
        `),
      );

      await expect(
        setup.operations.execute(setup.principal, {
          kind: "vault_set",
          name: "SQL_TOKEN",
          value: "rolled_back_sql_secret",
          grant: "status",
          referenceName: "API_TOKEN",
          createOnly: true,
        }),
      ).rejects.toThrow("injected current-host grant failure");

      await expect(setup.storage.vaultValues.getStatus("SQL_TOKEN")).resolves.toEqual({
        key: "SQL_TOKEN",
        present: false,
      });
      await expect(setup.storage.vaultGrants.list()).resolves.toEqual([]);
      await expect(setup.storage.operatorActivity.list()).resolves.toEqual({ entries: [] });
      await expect(setup.storage.coordination.currentConfigGeneration()).resolves.toBe(0);
      expect(activationCalls).toBe(0);
    } finally {
      setup.storage.database.db.run(
        sql.raw("drop trigger if exists fail_current_host_vault_grant"),
      );
      await setup.engine.close();
      await setup.storage.close();
    }
  });

  it("propagates config activation failure after committing SQL Vault state", async () => {
    const activationFailure = new CapletsError(
      "SERVER_UNAVAILABLE",
      "Injected config activation failure.",
    );
    let activationCalls = 0;
    const setup = await sqlTestOperations(async () => {
      activationCalls += 1;
      throw activationFailure;
    });
    try {
      await expect(
        setup.operations.execute(setup.principal, {
          kind: "vault_set",
          name: "SQL_TOKEN",
          value: "committed_sql_secret",
          grant: "status",
          referenceName: "API_TOKEN",
          createOnly: true,
        }),
      ).rejects.toBe(activationFailure);

      await expect(setup.storage.vaultValues.resolveValue("SQL_TOKEN")).resolves.toBe(
        "committed_sql_secret",
      );
      await expect(setup.storage.vaultGrants.list("status")).resolves.toEqual([
        expect.objectContaining({
          capletId: "status",
          vaultKey: "SQL_TOKEN",
          referenceName: "API_TOKEN",
          createdBy: setup.principal.clientId,
        }),
      ]);
      await expect(setup.storage.operatorActivity.list()).resolves.toEqual({
        entries: [expect.objectContaining({ action: "vault.set" })],
      });
      await expect(setup.storage.coordination.currentConfigGeneration()).resolves.toBe(1);
      expect(activationCalls).toBe(1);
    } finally {
      await setup.engine.close();
      await setup.storage.close();
    }
  });

  it("threads create-only and expected versions through SQL Vault mutations", async () => {
    let activationCalls = 0;
    const setup = await sqlTestOperations(async () => {
      activationCalls += 1;
    });
    try {
      await expect(
        setup.operations.execute(setup.principal, {
          kind: "vault_set",
          name: "CONDITIONAL_TOKEN",
          value: "first_conditional_secret",
          createOnly: true,
        }),
      ).resolves.toMatchObject({
        kind: "vault_set",
        status: { present: true, generation: 1 },
      });
      await expect(
        setup.operations.execute(setup.principal, {
          kind: "vault_set",
          name: "CONDITIONAL_TOKEN",
          value: "must_not_replace",
          createOnly: true,
        }),
      ).rejects.toMatchObject({ code: "CONFIG_EXISTS" });
      await expect(
        setup.operations.execute(setup.principal, {
          kind: "vault_set",
          name: "CONDITIONAL_TOKEN",
          value: "second_conditional_secret",
          expectedGeneration: 1,
        }),
      ).resolves.toMatchObject({
        kind: "vault_set",
        status: { present: true, generation: 2 },
      });
      await expect(
        setup.operations.execute(setup.principal, {
          kind: "vault_set",
          name: "CONDITIONAL_TOKEN",
          value: "stale_conditional_secret",
          expectedGeneration: 1,
        }),
      ).rejects.toMatchObject({
        details: { kind: "stale_generation", expectedGeneration: 1, currentGeneration: 2 },
      });
      expect(activationCalls).toBe(2);

      const createdGrant = await setup.operations.execute(setup.principal, {
        kind: "vault_access_grant",
        storedKey: "CONDITIONAL_TOKEN",
        referenceName: "API_TOKEN",
        capletId: "status",
        createOnly: true,
      });
      const firstResourceVersion = createdGrant.grant.resourceVersion;
      expect(firstResourceVersion).toEqual(expect.any(String));
      await expect(
        setup.operations.execute(setup.principal, {
          kind: "vault_access_grant",
          storedKey: "CONDITIONAL_TOKEN",
          referenceName: "API_TOKEN",
          capletId: "status",
          createOnly: true,
        }),
      ).rejects.toMatchObject({ code: "CONFIG_EXISTS" });

      const updatedGrant = await setup.operations.execute(setup.principal, {
        kind: "vault_access_grant",
        storedKey: "CONDITIONAL_TOKEN",
        referenceName: "API_TOKEN",
        capletId: "status",
        expectedResourceVersion: firstResourceVersion,
      });
      const secondResourceVersion = updatedGrant.grant.resourceVersion;
      expect(secondResourceVersion).toEqual(expect.any(String));
      expect(secondResourceVersion).not.toBe(firstResourceVersion);
      await expect(
        setup.operations.execute(setup.principal, {
          kind: "vault_access_grant",
          storedKey: "CONDITIONAL_TOKEN",
          referenceName: "API_TOKEN",
          capletId: "status",
          expectedResourceVersion: firstResourceVersion,
        }),
      ).rejects.toMatchObject({
        details: { kind: "stale_generation", expectedResourceVersion: firstResourceVersion },
      });
      await expect(
        setup.operations.execute(setup.principal, {
          kind: "vault_set",
          name: "CONDITIONAL_TOKEN",
          value: "must_not_replace_during_grant_race",
          expectedGeneration: 2,
          grant: "status",
          referenceName: "API_TOKEN",
          grantCreateOnly: true,
        }),
      ).rejects.toMatchObject({ code: "CONFIG_EXISTS" });
      await expect(
        setup.operations.execute(setup.principal, {
          kind: "vault_get",
          name: "CONDITIONAL_TOKEN",
        }),
      ).resolves.toMatchObject({
        kind: "vault_get",
        status: { present: true, generation: 2 },
      });
      await expect(
        setup.operations.execute(setup.principal, {
          kind: "vault_access_revoke",
          storedKey: "CONDITIONAL_TOKEN",
          referenceName: "API_TOKEN",
          capletId: "status",
          expectedResourceVersion: firstResourceVersion,
        }),
      ).rejects.toMatchObject({
        details: { kind: "stale_generation", expectedResourceVersion: firstResourceVersion },
      });
      await expect(
        setup.operations.execute(setup.principal, {
          kind: "vault_access_revoke",
          storedKey: "CONDITIONAL_TOKEN",
          referenceName: "API_TOKEN",
          capletId: "status",
          expectedResourceVersion: secondResourceVersion,
        }),
      ).resolves.toMatchObject({
        kind: "vault_access_revoke",
        revoked: [expect.objectContaining({ resourceVersion: secondResourceVersion })],
      });

      await expect(
        setup.operations.execute(setup.principal, {
          kind: "vault_delete",
          name: "CONDITIONAL_TOKEN",
          expectedGeneration: 1,
        }),
      ).rejects.toMatchObject({
        details: { kind: "stale_generation", expectedGeneration: 1, currentGeneration: 2 },
      });
      await expect(
        setup.operations.execute(setup.principal, {
          kind: "vault_delete",
          name: "CONDITIONAL_TOKEN",
          expectedGeneration: 2,
        }),
      ).resolves.toMatchObject({
        kind: "vault_delete",
        deleted: { deleted: true },
      });
    } finally {
      await setup.engine.close();
      await setup.storage.close();
    }
  });

  it("resolves exact Vault grant details against the Caplet's current configured origin", async () => {
    const setup = await sqlTestOperations(async () => undefined);
    try {
      await setup.operations.execute(setup.principal, {
        kind: "vault_access_grant",
        storedKey: "ORIGIN_TOKEN",
        referenceName: "API_TOKEN",
        capletId: "status",
      });
      const movedCapletRoot = join(setup.userRoot, "status");
      mkdirSync(movedCapletRoot, { recursive: true });
      writeFileSync(
        join(movedCapletRoot, "CAPLET.md"),
        [
          "---",
          "name: Status",
          "description: Status API.",
          "mcpServer:",
          "  command: status-mcp",
          "---",
          "# Status",
        ].join("\n"),
      );
      await expect(
        setup.operations.execute(setup.principal, {
          kind: "vault_grants_page",
          limit: 1,
          sort: "asc",
          storedKey: "ORIGIN_TOKEN",
          capletId: "status",
        }),
      ).resolves.toEqual({
        kind: "vault_grants_page",
        page: { items: [] },
      });
      writeFileSync(setup.configPath, JSON.stringify({}));
      await setup.operations.execute(setup.principal, {
        kind: "vault_access_grant",
        storedKey: "ORIGIN_TOKEN",
        referenceName: "API_TOKEN",
        capletId: "status",
      });

      const detail = await setup.operations.execute(setup.principal, {
        kind: "vault_access_list",
        storedKey: "ORIGIN_TOKEN",
        capletId: "status",
        referenceName: "API_TOKEN",
      });
      expect(detail).toEqual({
        kind: "vault_access_list",
        grants: [expect.objectContaining({ origin: { kind: "global-file" } })],
      });
      await expect(
        setup.operations.execute(setup.principal, {
          kind: "vault_grants_page",
          limit: 1,
          sort: "asc",
          storedKey: "ORIGIN_TOKEN",
          capletId: "status",
        }),
      ).resolves.toEqual({
        kind: "vault_grants_page",
        page: {
          items: [expect.objectContaining({ origin: { kind: "global-file" } })],
        },
      });
      const resourceVersion = detail.grants[0]?.resourceVersion;
      if (!resourceVersion) throw new Error("Expected the current grant resource version.");
      await expect(
        setup.operations.execute(setup.principal, {
          kind: "vault_access_revoke",
          storedKey: "ORIGIN_TOKEN",
          capletId: "status",
          referenceName: "API_TOKEN",
          expectedResourceVersion: resourceVersion,
        }),
      ).resolves.toEqual({
        kind: "vault_access_revoke",
        revoked: [expect.objectContaining({ origin: { kind: "global-file" } })],
      });
      await expect(setup.storage.vaultGrants.list("status")).resolves.toEqual([
        expect.objectContaining({ originKind: "global-config" }),
      ]);
    } finally {
      await setup.engine.close();
      await setup.storage.close();
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
  const engine = new CapletsEngine({ configPath, projectConfigPath, watch: false });
  const store = new RemoteServerCredentialStore({ dir: join(root, "remote-state") });
  const operator = issueOperator(store, "Direct Operator");
  const activity = new DashboardActivityLog({ dir: join(root, "activity") });
  const operations = createCurrentHostOperations({
    engine,
    control: { configPath, projectConfigPath, authDir, globalCapletsRoot, globalLockfilePath },
    activityLog: activity,
    runtimeState: {
      read: async () => {
        const readiness = await engine.readiness();
        if (readiness.ready) return { status: "ok" };
        return {
          status: "error",
          ...(readiness.reason === undefined ? {} : { reason: readiness.reason }),
        };
      },
    },
    logState: { listPage: () => ({ items: [] }) },
    projectBindingState: {
      read: () => ({
        state: "disconnected",
        affectedCaplets: [],
        actions: [],
      }),
    },
    remoteCredentialStore: store,
    version: "test-version",
  });
  return {
    root,
    configPath,
    engine,
    store,
    activity,
    operations,
    principal: {
      clientId: operator.clientId,
      clientLabel: operator.clientLabel,
      hostUrl: operator.hostUrl,
      role: "operator" as const,
    },
  };
}

async function sqlTestOperations(activateConfig: () => Promise<void>) {
  const root = tempDir("caplets-current-host-sql-operations-");
  const userRoot = join(root, "user");
  const projectRoot = join(root, "project", ".caplets");
  const authDir = join(root, "auth");
  const globalCapletsRoot = join(root, "global-caplets");
  const globalLockfilePath = join(root, "remote-state", "caplets.lock.json");
  const databasePath = join(root, "host.sqlite3");
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
  const storage = await createHostStorage(
    { type: "sqlite", path: databasePath },
    { vaultRoot: join(root, "vault") },
  );
  const engine = new CapletsEngine({ configPath, projectConfigPath, watch: false });
  const credentials = new RemoteServerCredentialStore({ dir: join(root, "remote-state") });
  const operator = issueOperator(credentials, "SQL Operator");
  const activity = new DashboardActivityLog({ dir: join(root, "activity") });
  const operations = createCurrentHostOperations({
    engine,
    control: { configPath, projectConfigPath, authDir, globalCapletsRoot, globalLockfilePath },
    activityLog: activity,
    remoteCredentialStore: credentials,
    vaultGrants: storage.vaultGrants,
    vaultValues: storage.vaultValues,
    vaultState: storage.vaultState,
    activateConfig,
    version: "test-version",
  });
  return {
    engine,
    storage,
    operations,
    configPath,
    projectConfigPath,
    userRoot,
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

function storedDocument(command: string): string {
  return [
    "---",
    "name: Stored",
    "description: Stored Caplet administration fixture.",
    "mcpServer:",
    `  command: ${command}`,
    "---",
    "",
    "# Stored",
    "",
  ].join("\n");
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
