import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeTokenBundle, type StoredOAuthTokenBundle } from "../src/auth/store";
import { installCaplets } from "../src/install";
import { DashboardActivityLog } from "../src/dashboard/activity-log";
import { RemoteServerCredentialStore } from "../src/remote/server-credential-store";
import { LocalSetupStore } from "../src/setup/local-store";
import type { SetupAttempt } from "../src/setup/types";
import { createHostStorage } from "../src/storage";
import {
  migrateLegacyHostState,
  type LegacyMigrationOptions,
} from "../src/storage/legacy-migration";
import { OperatorActivityStore } from "../src/storage/operator-activity";
import { FileVaultStore } from "../src/vault";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function document(): string {
  return `---
name: GitHub
description: Manage GitHub repositories.
mcpServers:
  github:
    command: github-mcp
---

# GitHub

Operator notes.
`;
}

type FullLegacyFixture = {
  root: string;
  options: LegacyMigrationOptions;
  capletsRoot: string;
  lockfilePath: string;
  databasePath: string;
  authDir: string;
  vaultRoot: string;
  remoteDir: string;
  setupDir: string;
  activityDir: string;
  backupRoot: string;
  authBundle: StoredOAuthTokenBundle;
  vaultPlaintext: string;
  hostUrl: string;
  remoteAccessToken: string;
  remoteClientId: string;
  pendingFlowId: string;
  pendingCompletionSecret: string;
  unusedPairingCode: string;
  setupAttempt: SetupAttempt;
  activityId: string;
};

async function createFullLegacyFixture(): Promise<FullLegacyFixture> {
  const root = mkdtempSync(join(tmpdir(), "caplets-full-legacy-migration-"));
  directories.push(root);
  const repository = join(root, "repository");
  const source = join(repository, "caplets", "github");
  const capletsRoot = join(root, "host", "caplets");
  const lockfilePath = join(root, "host", "caplets.lock.json");
  const databasePath = join(root, "sql", "caplets.sqlite3");
  const authDir = join(root, "legacy", "auth");
  const vaultRoot = join(root, "legacy", "vault");
  const remoteDir = join(root, "legacy", "remote");
  const setupDir = join(root, "legacy", "setup");
  const activityDir = join(root, "legacy", "activity");
  const targetVaultRoot = join(root, "sql", "vault");
  const backupRoot = join(root, "backup");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "CAPLET.md"), document());
  writeFileSync(join(source, "script.sh"), "#!/bin/sh\necho github\n", { mode: 0o755 });
  installCaplets(repository, {
    capletIds: ["github"],
    destinationRoot: capletsRoot,
    lockfilePath,
  });

  const authBundle: StoredOAuthTokenBundle = {
    server: "github",
    authType: "oauth2",
    accessToken: "legacy_oauth_access_secret",
    refreshToken: "legacy_oauth_refresh_secret",
    tokenType: "Bearer",
    expiresAt: "2099-07-18T00:00:00.000Z",
    metadata: { audience: "github" },
  };
  writeTokenBundle(authBundle, authDir);

  const vaultPlaintext = "legacy_vault_plaintext_secret";
  const vault = new FileVaultStore({ root: vaultRoot, env: {} });
  vault.set("GITHUB_TOKEN", vaultPlaintext, { now: new Date("2026-07-18T10:00:00.000Z") });
  vault.grantAccess({
    storedKey: "GITHUB_TOKEN",
    referenceName: "TOKEN",
    capletId: "github",
    origin: { kind: "global-file", path: join(capletsRoot, "github", "CAPLET.md") },
    now: new Date("2026-07-18T10:01:00.000Z"),
  });

  const hostUrl = "https://host.example.test/caplets";
  const remoteNow = new Date();
  const remote = new RemoteServerCredentialStore({ dir: remoteDir });
  const usedPairing = remote.createPairingCode({
    hostUrl,
    clientLabel: "Migrated client",
    ttlMs: 60 * 60_000,
    now: remoteNow,
  });
  const credentials = remote.exchangePairingCode({
    hostUrl,
    code: usedPairing.code,
    clientLabel: "Migrated client",
    now: remoteNow,
  });
  const unusedPairing = remote.createPairingCode({
    hostUrl,
    clientLabel: "Pair after migration",
    ttlMs: 60 * 60_000,
    now: remoteNow,
  });
  const pending = remote.createPendingLogin({
    hostUrl,
    clientLabel: "Pending client",
    sourceHint: "migration-test",
    now: remoteNow,
  });

  const setup = new LocalSetupStore({
    baseDir: setupDir,
    now: () => new Date("2026-07-18T10:10:00.000Z"),
  });
  await setup.approve({
    projectFingerprint: "project-fingerprint",
    capletId: "github",
    contentHash: "sha256:setup-content",
    targetKind: "local_host",
    approvedAt: "2026-07-18T10:02:00.000Z",
    actor: "automation",
  });
  const setupAttempt: SetupAttempt = {
    attemptId: "setup-attempt-legacy",
    projectFingerprint: "project-fingerprint",
    capletId: "github",
    contentHash: "sha256:setup-content",
    setupHash: "sha256:setup-plan",
    targetKind: "local_host",
    actor: "automation",
    status: "succeeded",
    phase: "verify",
    commandLabel: "verify installation",
    argv: ["verify"],
    exitCode: 0,
    durationMs: 12,
    startedAt: "2026-07-18T10:03:00.000Z",
    finishedAt: "2026-07-18T10:03:01.000Z",
    stdout: "[redacted]",
    stderr: "",
    redacted: true,
    retention: { maxAttempts: 3, days: 7 },
  };
  await setup.recordAttempt(setupAttempt);

  const activity = new DashboardActivityLog({ dir: activityDir }).append({
    actorClientId: "legacy_operator",
    action: "catalog_installed",
    target: { type: "catalog", id: "github", label: "GitHub" },
    metadata: { source: "legacy" },
    now: new Date("2026-07-18T10:04:00.000Z"),
  });

  return {
    root,
    options: {
      storage: { type: "sqlite", path: databasePath },
      capletsRoot,
      lockfilePath,
      operatorClientId: "operator_migration",
      backupRoot,
      backendAuthDir: authDir,
      legacyVaultRoot: vaultRoot,
      targetVaultRoot,
      remoteSecurityDir: remoteDir,
      setupStateDir: setupDir,
      operatorActivityDir: activityDir,
    },
    capletsRoot,
    lockfilePath,
    databasePath,
    authDir,
    vaultRoot,
    remoteDir,
    setupDir,
    activityDir,
    backupRoot,
    authBundle,
    vaultPlaintext,
    hostUrl,
    remoteAccessToken: credentials.accessToken,
    remoteClientId: credentials.clientId,
    pendingFlowId: pending.flowId,
    pendingCompletionSecret: pending.pendingCompletionSecret,
    unusedPairingCode: unusedPairing.code,
    setupAttempt,
    activityId: activity.id,
  };
}

function expectedDomainReport() {
  return {
    backendAuthTokenBundles: 1,
    vaultValues: 1,
    vaultGrants: 1,
    remotePairingCodes: 2,
    remoteClients: 1,
    remotePendingLogins: 1,
    setupApprovals: 1,
    setupAttempts: 1,
    operatorActivityEntries: 1,
    dashboardSessions: "not_applicable_no_legacy_format",
    projectBindings: "not_applicable_no_legacy_format",
  };
}

describe("legacy host-state migration", () => {
  it("verifies tracked artifacts, imports provenance, and preserves a recoverable backup", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-legacy-migration-"));
    directories.push(root);
    const repository = join(root, "repository");
    const source = join(repository, "caplets", "github");
    const capletsRoot = join(root, "host", "caplets");
    const lockfilePath = join(root, "host", "caplets.lock.json");
    const backupRoot = join(root, "backup");
    const databasePath = join(root, "host", "caplets.sqlite3");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "CAPLET.md"), document());
    writeFileSync(join(source, "script.sh"), "#!/bin/sh\necho github\n", { mode: 0o755 });
    installCaplets(repository, {
      capletIds: ["github"],
      destinationRoot: capletsRoot,
      lockfilePath,
    });
    writeFileSync(join(capletsRoot, "untracked.md"), document().replaceAll("github", "local"));

    const report = await migrateLegacyHostState({
      storage: { type: "sqlite", path: databasePath },
      capletsRoot,
      lockfilePath,
      operatorClientId: "operator_migration",
      backupRoot,
    });

    expect(report).toEqual({
      status: "migrated",
      records: 1,
      installations: 1,
      backupPath: backupRoot,
    });
    expect(existsSync(join(capletsRoot, "github"))).toBe(false);
    expect(existsSync(join(capletsRoot, "untracked.md"))).toBe(true);
    expect(existsSync(join(backupRoot, "caplets", "github", "CAPLET.md"))).toBe(true);
    expect(existsSync(join(backupRoot, "caplets.lock.json"))).toBe(true);

    const storage = await createHostStorage({ type: "sqlite", path: databasePath });
    try {
      const record = await storage.caplets.get("github");
      expect(record?.currentRevision.sourceContentHash).toMatch(/^sha256:/);
      expect(record?.currentRevision.bundle.map((entry) => entry.path)).toEqual(["script.sh"]);
      await expect(storage.installations.getActive("github")).resolves.toMatchObject({
        sourceKind: "local",
        status: "active",
      });
      await expect(storage.installations.listActivity()).resolves.toMatchObject([
        {
          operatorClientId: "operator_migration",
          action: "caplet.import",
          outcome: "succeeded",
        },
      ]);
    } finally {
      await storage.close();
    }
  });

  it("identifies the missing tracked path and stale lockfile during migration", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-legacy-migration-missing-"));
    directories.push(root);
    const repository = join(root, "repository");
    const source = join(repository, "caplets", "sample");
    const capletsRoot = join(root, "host", "caplets");
    const lockfilePath = join(root, "host", "caplets.lock.json");
    const destination = join(capletsRoot, "sample");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "CAPLET.md"), document());
    installCaplets(repository, {
      capletIds: ["sample"],
      destinationRoot: capletsRoot,
      lockfilePath,
    });
    rmSync(destination, { recursive: true, force: true });

    await expect(
      migrateLegacyHostState({
        storage: { type: "sqlite", path: join(root, "host", "caplets.sqlite3") },
        capletsRoot,
        lockfilePath,
        operatorClientId: "operator_migration",
      }),
    ).rejects.toMatchObject({
      code: "CONFIG_NOT_FOUND",
      message: `Tracked Caplet sample is missing at ${destination}. Restore it or remove its stale entry from ${lockfilePath} before migration.`,
    });
  });

  it("dry-runs every applicable legacy domain without SQL state writes or source moves", async () => {
    const fixture = await createFullLegacyFixture();
    const report = await migrateLegacyHostState({ ...fixture.options, dryRun: true });

    expect(report).toEqual({
      status: "verified",
      records: 1,
      installations: 1,
      backupPath: null,
      domains: expectedDomainReport(),
    });
    expect(JSON.stringify(report)).not.toContain("secret");
    expect(existsSync(join(fixture.capletsRoot, "github", "CAPLET.md"))).toBe(true);
    expect(existsSync(fixture.lockfilePath)).toBe(true);
    expect(existsSync(join(fixture.authDir, "github.json"))).toBe(true);
    expect(existsSync(join(fixture.vaultRoot, "values", "GITHUB_TOKEN.json"))).toBe(true);
    expect(existsSync(join(fixture.remoteDir, "remote-server-credentials.json"))).toBe(true);
    expect(existsSync(join(fixture.setupDir, "approvals.json"))).toBe(true);
    expect(existsSync(join(fixture.activityDir, "dashboard-activity.jsonl"))).toBe(true);
    expect(existsSync(fixture.backupRoot)).toBe(false);

    const storage = await createHostStorage(
      { type: "sqlite", path: fixture.databasePath },
      { vaultRoot: fixture.options.targetVaultRoot },
    );
    try {
      await expect(storage.caplets.list()).resolves.toEqual([]);
      await expect(storage.backendAuth.listTokenBundles()).resolves.toEqual([]);
      await expect(storage.vaultValues.listValues()).resolves.toEqual([]);
      await expect(storage.remoteSecurity.listClients()).resolves.toEqual([]);
      await expect(
        storage.setupState.getApproval(
          "project-fingerprint",
          "github",
          "sha256:setup-content",
          "local_host",
        ),
      ).resolves.toBeUndefined();
      await expect(storage.operatorActivity.list()).resolves.toEqual({ entries: [] });
    } finally {
      await storage.close();
    }
  });

  it("refuses non-identical target state without moving any source", async () => {
    const fixture = await createFullLegacyFixture();
    const storage = await createHostStorage({ type: "sqlite", path: fixture.databasePath });
    try {
      await storage.backendAuth.writeTokenBundle({
        ...fixture.authBundle,
        accessToken: "different_target_secret",
      });
    } finally {
      await storage.close();
    }

    await expect(migrateLegacyHostState(fixture.options)).rejects.toMatchObject({
      code: "CONFIG_EXISTS",
    });
    expect(existsSync(join(fixture.capletsRoot, "github", "CAPLET.md"))).toBe(true);
    expect(existsSync(fixture.lockfilePath)).toBe(true);
    expect(existsSync(join(fixture.authDir, "github.json"))).toBe(true);
    expect(existsSync(join(fixture.vaultRoot, "values", "GITHUB_TOKEN.json"))).toBe(true);
    expect(existsSync(join(fixture.remoteDir, "remote-server-credentials.json"))).toBe(true);
    expect(existsSync(fixture.backupRoot)).toBe(false);
  });

  it("rolls every imported SQL domain back when a late domain fails, then resumes", async () => {
    const fixture = await createFullLegacyFixture();
    const failure = vi
      .spyOn(OperatorActivityStore.prototype, "importLegacyEntriesInTransaction")
      .mockImplementationOnce(() => {
        throw new Error("injected late-domain import failure");
      });

    await expect(migrateLegacyHostState(fixture.options)).rejects.toThrow(
      "injected late-domain import failure",
    );
    failure.mockRestore();

    const storage = await createHostStorage(
      { type: "sqlite", path: fixture.databasePath },
      { vaultRoot: fixture.options.targetVaultRoot },
    );
    try {
      await expect(storage.caplets.get("github")).resolves.toBeUndefined();
      await expect(storage.installations.getActive("github")).resolves.toBeUndefined();
      await expect(storage.backendAuth.readTokenBundle("github")).resolves.toBeUndefined();
      await expect(storage.vaultValues.getStatus("GITHUB_TOKEN")).resolves.toEqual({
        key: "GITHUB_TOKEN",
        present: false,
      });
      await expect(storage.vaultGrants.list()).resolves.toEqual([]);
      await expect(storage.remoteSecurity.dumpForTest()).resolves.toMatchObject({
        pairingCodes: [],
        pendingLogins: [],
        clients: [],
      });
      await expect(
        storage.setupState.getApproval(
          "project-fingerprint",
          "github",
          "sha256:setup-content",
          "local_host",
        ),
      ).resolves.toBeUndefined();
      await expect(
        storage.setupState.getAttempt(
          "project-fingerprint",
          "github",
          fixture.setupAttempt.attemptId,
        ),
      ).resolves.toBeUndefined();
      await expect(storage.operatorActivity.list()).resolves.toEqual({ entries: [] });
    } finally {
      await storage.close();
    }

    await expect(migrateLegacyHostState(fixture.options)).resolves.toMatchObject({
      status: "migrated",
      domains: expectedDomainReport(),
    });
  });

  it("rolls every source move back when backup fails and resumes from imported SQL", async () => {
    const fixture = await createFullLegacyFixture();
    mkdirSync(fixture.backupRoot, { recursive: true });
    const blocker = join(fixture.backupRoot, "backend-auth");
    writeFileSync(blocker, "not a directory");

    await expect(migrateLegacyHostState(fixture.options)).rejects.toBeDefined();
    expect(existsSync(join(fixture.capletsRoot, "github", "CAPLET.md"))).toBe(true);
    expect(existsSync(fixture.lockfilePath)).toBe(true);
    expect(existsSync(join(fixture.authDir, "github.json"))).toBe(true);
    expect(existsSync(join(fixture.vaultRoot, "values", "GITHUB_TOKEN.json"))).toBe(true);
    expect(existsSync(join(fixture.remoteDir, "remote-server-credentials.json"))).toBe(true);
    expect(existsSync(join(fixture.setupDir, "approvals.json"))).toBe(true);
    expect(existsSync(join(fixture.activityDir, "dashboard-activity.jsonl"))).toBe(true);
    expect(existsSync(join(fixture.backupRoot, "caplets", "github"))).toBe(false);
    expect(existsSync(join(fixture.backupRoot, "caplets.lock.json"))).toBe(false);

    rmSync(blocker);
    await expect(migrateLegacyHostState(fixture.options)).resolves.toMatchObject({
      status: "migrated",
      domains: expectedDomainReport(),
    });
  });

  it("migrates, verifies, backs up, reruns safely, and preserves behavioral security state", async () => {
    const fixture = await createFullLegacyFixture();
    const report = await migrateLegacyHostState(fixture.options);

    expect(report).toEqual({
      status: "migrated",
      records: 1,
      installations: 1,
      backupPath: fixture.backupRoot,
      domains: expectedDomainReport(),
    });
    expect(JSON.stringify(report)).not.toContain("secret");
    expect(existsSync(join(fixture.capletsRoot, "github"))).toBe(false);
    expect(existsSync(fixture.lockfilePath)).toBe(false);
    expect(existsSync(join(fixture.authDir, "github.json"))).toBe(false);
    expect(existsSync(join(fixture.vaultRoot, "values", "GITHUB_TOKEN.json"))).toBe(false);
    expect(existsSync(join(fixture.remoteDir, "remote-server-credentials.json"))).toBe(false);
    expect(existsSync(join(fixture.setupDir, "approvals.json"))).toBe(false);
    expect(existsSync(join(fixture.activityDir, "dashboard-activity.jsonl"))).toBe(false);
    expect(existsSync(join(fixture.backupRoot, "caplets", "github", "CAPLET.md"))).toBe(true);
    expect(existsSync(join(fixture.backupRoot, "backend-auth", "github.json"))).toBe(true);
    expect(existsSync(join(fixture.backupRoot, "vault", "values", "GITHUB_TOKEN.json"))).toBe(true);
    expect(
      existsSync(join(fixture.backupRoot, "remote-security", "remote-server-credentials.json")),
    ).toBe(true);
    expect(existsSync(join(fixture.backupRoot, "setup-state", "approvals.json"))).toBe(true);
    expect(
      existsSync(join(fixture.backupRoot, "operator-activity", "dashboard-activity.jsonl")),
    ).toBe(true);

    await expect(migrateLegacyHostState(fixture.options)).resolves.toEqual(report);

    const storage = await createHostStorage(
      { type: "sqlite", path: fixture.databasePath },
      { vaultRoot: fixture.options.targetVaultRoot },
    );
    try {
      await expect(storage.backendAuth.readTokenBundle("github")).resolves.toMatchObject({
        bundle: fixture.authBundle,
        generation: 1,
      });
      await expect(storage.vaultValues.resolveValue("GITHUB_TOKEN")).resolves.toBe(
        fixture.vaultPlaintext,
      );
      await expect(storage.vaultGrants.list("github")).resolves.toContainEqual(
        expect.objectContaining({
          subjectKind: "record",
          capletId: "github",
          vaultKey: "GITHUB_TOKEN",
          referenceName: "TOKEN",
          originKind: "stored-record",
          originPath: null,
        }),
      );
      await expect(
        storage.remoteSecurity.validateAccessToken({
          hostUrl: fixture.hostUrl,
          accessToken: fixture.remoteAccessToken,
        }),
      ).resolves.toMatchObject({ clientId: fixture.remoteClientId, role: "access" });
      await expect(
        storage.remoteSecurity.pollPendingLogin({
          flowId: fixture.pendingFlowId,
          pendingCompletionSecret: fixture.pendingCompletionSecret,
        }),
      ).resolves.toEqual({ flowId: fixture.pendingFlowId, status: "pending" });
      await expect(
        storage.remoteSecurity.exchangePairingCode({
          hostUrl: fixture.hostUrl,
          code: fixture.unusedPairingCode,
          clientLabel: "Post-migration client",
        }),
      ).resolves.toMatchObject({ hostUrl: fixture.hostUrl, role: "access" });
      await expect(
        storage.setupState.getApproval(
          "project-fingerprint",
          "github",
          "sha256:setup-content",
          "local_host",
        ),
      ).resolves.toMatchObject({ actor: "automation" });
      await expect(
        storage.setupState.getAttempt(
          "project-fingerprint",
          "github",
          fixture.setupAttempt.attemptId,
        ),
      ).resolves.toEqual(fixture.setupAttempt);
      await expect(storage.operatorActivity.list({ action: "catalog_installed" })).resolves.toEqual(
        {
          entries: [
            expect.objectContaining({ id: fixture.activityId, actorClientId: "legacy_operator" }),
          ],
        },
      );
    } finally {
      await storage.close();
    }
  });
});
