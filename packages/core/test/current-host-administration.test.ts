import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { AuthorityVaultStore } from "../src/vault";
import { FilesystemAuthority } from "../src/storage/filesystem-authority";

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

  it("rejects a caplet update when the envelope id differs from record.id", async () => {
    const setup = testOperations();
    try {
      await expect(
        setup.operations.execute(setup.principal, {
          kind: "caplet_update",
          id: "different-id",
          record: { id: "status", config: { mcpServers: {} } },
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    } finally {
      await setup.engine.close();
    }
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

  it("routes shared Current Host Vault set-and-grant through one authority generation and replica reads", async () => {
    const setup = testOperations();
    const authorityRoot = tempDir("caplets-current-host-shared-vault-");
    const authority = new FilesystemAuthority({ root: authorityRoot, authorityId: "shared-vault" });
    const key = Buffer.alloc(32, 11).toString("base64url");
    let replica: FilesystemAuthority | undefined;
    try {
      await authority.initialize();
      const seeded = await authority.commit({
        authorityId: "shared-vault",
        currentHostId: "seed",
        principalId: "seed",
        expectedGeneration: null,
        idempotencyKey: "seed",
        requestDigest: "seed",
        command: {
          kind: "replace_snapshot",
          snapshot: { caplets: { status: { id: "status" } } },
        },
      });
      if (seeded.kind !== "committed") throw new Error("Expected shared Vault seed generation.");
      const activeGeneration = await authority.readGeneration(seeded.generation.id);
      const sharedStore = new AuthorityVaultStore({
        authority,
        authorityId: "shared-vault",
        currentHostId: "current-host-a",
        key,
      });
      const activity = new DashboardActivityLog({ dir: join(setup.root, "shared-activity") });
      const operations = createCurrentHostOperations({
        engine: setup.engine,
        control: {
          configPath: setup.configPath,
          projectConfigPath: join(setup.root, "project", ".caplets", "config.json"),
          authDir: join(setup.root, "auth"),
          authorityId: "shared-vault",
          currentHostId: "current-host-a",
        },
        vaultStore: sharedStore,
        activeGeneration,
        activityLog: activity,
        version: "test-version",
      });
      const before = await authority.readHead();
      const set = await operations.execute(setup.principal, {
        kind: "vault_set",
        name: "GH_TOKEN",
        value: "shared_authority_secret",
        grant: "status",
        referenceName: "API_TOKEN",
      });
      expect(set).toEqual(
        expect.objectContaining({
          kind: "vault_set",
          status: expect.objectContaining({ key: "GH_TOKEN", present: true }),
        }),
      );
      const after = await authority.readHead();
      expect(after?.sequence).toBe((before?.sequence ?? 0) + 1);
      expect(existsSync(join(setup.root, "auth", "vault"))).toBe(false);

      replica = new FilesystemAuthority({ root: authorityRoot, authorityId: "shared-vault" });
      await replica.initialize();
      const replicaHead = await replica.readHead();
      if (!replicaHead) throw new Error("Expected replica Vault head.");
      const replicaStore = new AuthorityVaultStore({
        authority: replica,
        authorityId: "shared-vault",
        currentHostId: "current-host-b",
        key,
      });
      const replicaOperations = createCurrentHostOperations({
        engine: setup.engine,
        control: {
          configPath: setup.configPath,
          projectConfigPath: join(setup.root, "project", ".caplets", "config.json"),
          authDir: join(setup.root, "auth"),
          authorityId: "shared-vault",
          currentHostId: "current-host-b",
        },
        vaultStore: replicaStore,
        activeGeneration: await replica.readGeneration(replicaHead.id),
        activityLog: new DashboardActivityLog({ dir: join(setup.root, "replica-activity") }),
        version: "test-version",
      });
      await expect(
        replicaOperations.execute(setup.principal, { kind: "vault_list" }),
      ).resolves.toEqual({
        kind: "vault_list",
        values: [expect.objectContaining({ key: "GH_TOKEN", present: true })],
        grants: [
          expect.objectContaining({
            storedKey: "GH_TOKEN",
            referenceName: "API_TOKEN",
            capletId: "status",
            origin: { kind: "authority" },
          }),
        ],
      });
      await expect(
        replicaOperations.execute(setup.principal, { kind: "vault_get", name: "GH_TOKEN" }),
      ).resolves.toEqual({
        kind: "vault_get",
        status: expect.objectContaining({ key: "GH_TOKEN", present: true }),
      });
    } finally {
      await replica?.close();
      await authority.close();
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
