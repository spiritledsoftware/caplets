import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeTokenBundle } from "../src/auth/store";
import { DashboardActivityLog } from "../src/dashboard/activity-log";
import { RemoteServerCredentialStore } from "../src/remote/server-credential-store";
import { FileVaultStore } from "../src/vault";
import { runCli } from "../src/cli";
import { installCaplets } from "../src/install";
import { hostConfigGenerations } from "../src/storage/schema/sqlite";
import { createHostStorage } from "../src/storage";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function caplet(command: string, body: string): string {
  return `---\nname: Stored CLI\ndescription: Stored record command fixture.\nmcpServer:\n  command: ${command}\n---\n# ${body}\n`;
}

function writeBundle(path: string, command: string, body: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "CAPLET.md"), caplet(command, body));
  writeFileSync(join(path, "support.txt"), `${body}\n`);
}

describe("stored Caplet Record CLI", () => {
  it("administers record revisions and installation lifecycles through configured SQL storage", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-storage-records-cli-"));
    directories.push(root);
    const databasePath = join(root, "state", "caplets.sqlite3");
    const configPath = join(root, "config.json");
    const firstBundle = join(root, "first");
    const secondBundle = join(root, "second");
    const exportPath = join(root, "exported");
    writeFileSync(configPath, JSON.stringify({ storage: { type: "sqlite", path: databasePath } }));
    writeBundle(firstBundle, "first-command", "First");
    writeBundle(secondBundle, "second-command", "Second");

    const invoke = async (args: string[]): Promise<unknown> => {
      const output: string[] = [];
      await runCli(args, {
        env: { CAPLETS_CONFIG: configPath },
        writeOut: (value) => output.push(value),
      });
      return JSON.parse(output.join("")) as unknown;
    };

    await expect(invoke(["storage", "schema-migrate"])).resolves.toEqual({
      migrated: true,
      backend: "sqlite",
    });
    await expect(invoke(["storage", "status", "--json"])).resolves.toMatchObject({
      backend: "sqlite",
      ready: true,
      records: 0,
    });
    await expect(invoke(["storage", "records", "list"])).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });

    const imported = (await invoke([
      "storage",
      "records",
      "import",
      firstBundle,
      "--id",
      "stored-cli",
      "--history-limit",
      "3",
      "--source-kind",
      "git",
      "--source-identity",
      "https://example.test/repository.git",
      "--channel",
      "main",
    ])) as { id: string; headGeneration: number; currentRevision: { revisionKey: string } };
    expect(imported).toMatchObject({ id: "stored-cli", headGeneration: 1 });
    await expect(invoke(["storage", "records", "list", "--stored"])).resolves.toMatchObject([
      { id: "stored-cli", headGeneration: 1 },
    ]);
    await expect(
      invoke(["storage", "records", "get", "stored-cli", "--stored"]),
    ).resolves.toMatchObject({
      id: "stored-cli",
      currentRevision: { body: "# First\n" },
    });
    await expect(invoke(["list", "--json"])).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ server: "stored-cli", source: "stored-record" }),
      ]),
    );
    const globalCapletsRoot = root;
    writeFileSync(
      join(globalCapletsRoot, "stored-cli.md"),
      caplet("shadow-command", "Global overlay"),
    );
    await expect(invoke(["list", "--stored", "--json"])).resolves.toMatchObject([
      {
        id: "stored-cli",
        shadowed: true,
        shadowSource: { kind: "global-file" },
      },
    ]);
    rmSync(join(globalCapletsRoot, "stored-cli.md"));

    const updated = (await invoke([
      "storage",
      "records",
      "update",
      "stored-cli",
      secondBundle,
      "--generation",
      "1",
      "--detach-installation",
    ])) as { headGeneration: number };
    expect(updated.headGeneration).toBe(2);
    await expect(
      invoke(["storage", "records", "update", "stored-cli", firstBundle, "--generation", "1"]),
    ).rejects.toMatchObject({ details: { kind: "stale_generation" } });

    const revisions = (await invoke(["storage", "records", "revisions", "stored-cli"])) as Array<{
      revisionKey: string;
      sequence: number;
    }>;
    expect(revisions.map(({ sequence }) => sequence)).toEqual([2, 1]);
    await invoke([
      "storage",
      "records",
      "export",
      "stored-cli",
      exportPath,
      "--revision",
      revisions[1]!.revisionKey,
    ]);
    expect(readFileSync(join(exportPath, "CAPLET.md"), "utf8")).toBe(
      caplet("first-command", "First"),
    );
    expect(readFileSync(join(exportPath, "support.txt"), "utf8")).toBe("First\n");

    const restored = (await invoke([
      "storage",
      "records",
      "restore",
      "stored-cli",
      revisions[1]!.revisionKey,
      "--generation",
      "2",
    ])) as { headGeneration: number; currentRevision: { body: string } };
    expect(restored).toMatchObject({ headGeneration: 3, currentRevision: { body: "# First\n" } });
    await expect(
      invoke([
        "storage",
        "records",
        "delete-revision",
        "stored-cli",
        revisions[0]!.revisionKey,
        "--generation",
        "3",
      ]),
    ).resolves.toMatchObject({ deleted: true, record: { headGeneration: 4 } });
    const retained = (await invoke([
      "storage",
      "records",
      "retention",
      "stored-cli",
      "1",
      "--generation",
      "4",
    ])) as { headGeneration: number; historyLimit: number };
    expect(retained).toMatchObject({ headGeneration: 5, historyLimit: 1 });
    const renamed = (await invoke([
      "storage",
      "records",
      "rename",
      "stored-cli",
      "renamed-cli",
      "--generation",
      "5",
    ])) as { id: string; headGeneration: number };
    expect(renamed).toMatchObject({ id: "renamed-cli", headGeneration: 6 });

    const installationStatus = (await invoke([
      "storage",
      "records",
      "installation",
      "status",
      "renamed-cli",
    ])) as { installations: Array<{ generation: number; status: string }> };
    expect(installationStatus.installations).toMatchObject([
      { generation: 2, status: "detached", sourceKind: "git" },
    ]);
    const replacement = (await invoke([
      "storage",
      "records",
      "installation",
      "replace",
      "renamed-cli",
      "--generation",
      "2",
      "--source-kind",
      "registry",
      "--source-identity",
      "official/renamed-cli",
    ])) as { generation: number; status: string };
    expect(replacement).toMatchObject({ generation: 1, status: "active" });
    await expect(
      invoke([
        "storage",
        "records",
        "installation",
        "observe",
        "renamed-cli",
        "--generation",
        "1",
        "--status",
        "current",
        "--resolved-revision",
        "rev-1",
        "--content-hash",
        "sha256:test",
        "--risk-json",
        '{"level":"low"}',
      ]),
    ).resolves.toMatchObject({ status: "current", risk: { level: "low" } });
    await expect(
      invoke(["storage", "records", "installation", "detach", "renamed-cli", "--generation", "2"]),
    ).resolves.toMatchObject({ status: "detached", generation: 3 });

    await expect(
      invoke(["storage", "records", "delete", "renamed-cli", "--generation", "6"]),
    ).resolves.toEqual({ deleted: true, id: "renamed-cli" });
    expect(existsSync(exportPath)).toBe(true);
    await expect(invoke(["storage", "records", "list", "--stored"])).resolves.toEqual([]);

    const storage = await createHostStorage({ type: "sqlite", path: databasePath });
    try {
      const activity = await storage.installations.listActivity();
      await expect(storage.coordination.currentConfigGeneration()).resolves.toBe(8);
      if (storage.database.dialect !== "sqlite") throw new Error("Expected SQLite test storage.");
      const invalidations = (
        await storage.database.db.select().from(hostConfigGenerations).all()
      ).filter(({ contentHash }) => contentHash.startsWith("mutation:"));
      expect(invalidations).toEqual([]);
      expect(activity.length).toBeGreaterThan(10);
      expect(activity.every((entry) => entry.operatorClientId === "local_cli")).toBe(true);
      expect(JSON.stringify(activity)).not.toContain("first-command");
      expect(JSON.stringify(activity)).not.toContain("second-command");
    } finally {
      await storage.close();
    }
  });

  it("uses platform paths to migrate standard legacy Host state by default", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-storage-migrate-legacy-cli-"));
    directories.push(root);
    const repository = join(root, "repository");
    const source = join(repository, "caplets", "legacy-cli");
    const capletsRoot = join(root, "config", "caplets");
    const stateBase = join(root, "legacy-state");
    const lockfilePath = join(stateBase, "caplets", "caplets.lock.json");
    const cacheBase = join(root, "legacy-cache");
    const authDir = join(stateBase, "caplets", "auth");
    const vaultRoot = join(stateBase, "caplets", "vault");
    const databasePath = join(root, "sql", "caplets.sqlite3");
    const configPath = join(capletsRoot, "config.json");
    const env = {
      CAPLETS_CONFIG: configPath,
      XDG_STATE_HOME: stateBase,
      XDG_CACHE_HOME: cacheBase,
    };
    mkdirSync(capletsRoot, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ storage: { type: "sqlite", path: databasePath } }));
    writeBundle(source, "legacy-command", "Legacy");
    installCaplets(repository, {
      capletIds: ["legacy-cli"],
      destinationRoot: capletsRoot,
      lockfilePath,
    });
    const overlayPath = join(capletsRoot, "overlay.md");
    writeFileSync(overlayPath, caplet("overlay-command", "Overlay"));
    writeTokenBundle(
      {
        server: "legacy-cli",
        authType: "oauth2",
        accessToken: "legacy-access-token",
      },
      authDir,
    );
    const remoteDir = join(authDir, "remote-server");
    const hostUrl = "https://host.example.test";
    const remoteNow = new Date();
    const remote = new RemoteServerCredentialStore({ dir: remoteDir });
    const usedPairing = remote.createPairingCode({
      hostUrl,
      clientLabel: "Migrated client",
      ttlMs: 60 * 60_000,
      now: remoteNow,
    });
    const remoteCredentials = remote.exchangePairingCode({
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
    const pendingLogin = remote.createPendingLogin({
      hostUrl,
      clientLabel: "Pending client",
      sourceHint: "migration-test",
      now: remoteNow,
    });
    const activity = new DashboardActivityLog({ dir: remoteDir }).append({
      actorClientId: "legacy_operator",
      action: "catalog_installed",
      target: { type: "catalog", id: "legacy-cli", label: "Legacy CLI" },
      metadata: { source: "legacy" },
      now: new Date("2026-07-18T10:04:00.000Z"),
    });
    const vault = new FileVaultStore({ root: vaultRoot, env });
    vault.set("LEGACY_TOKEN", "legacy-vault-value");
    vault.grantAccess({
      storedKey: "LEGACY_TOKEN",
      referenceName: "TOKEN",
      capletId: "legacy-cli",
      origin: {
        kind: "global-file",
        path: join(capletsRoot, "legacy-cli", "CAPLET.md"),
      },
    });
    vault.grantAccess({
      storedKey: "LEGACY_TOKEN",
      referenceName: "TOKEN",
      capletId: "overlay",
      origin: { kind: "global-file", path: overlayPath },
    });

    const expectedDomains = {
      backendAuthTokenBundles: 1,
      vaultValues: 1,
      vaultGrants: 2,
      remotePairingCodes: 2,
      remoteClients: 1,
      remotePendingLogins: 1,
      setupApprovals: 0,
      setupAttempts: 0,
      operatorActivityEntries: 1,
      dashboardSessions: "not_applicable_no_legacy_format",
      projectBindings: "not_applicable_no_legacy_format",
    };

    const output: string[] = [];
    await runCli(["storage", "migrate-legacy", "--dry-run"], {
      env,
      writeOut: (value) => output.push(value),
    });

    expect(JSON.parse(output.join(""))).toEqual({
      status: "verified",
      records: 1,
      installations: 1,
      backupPath: null,
      domains: expectedDomains,
    });
    expect(existsSync(join(capletsRoot, "legacy-cli", "CAPLET.md"))).toBe(true);
    expect(existsSync(lockfilePath)).toBe(true);

    const migratedOutput: string[] = [];
    await runCli(["storage", "migrate-legacy"], {
      env,
      writeOut: (value) => migratedOutput.push(value),
    });
    const migrated = JSON.parse(migratedOutput.join("")) as {
      backupPath: string;
    };
    expect(migrated).toEqual({
      status: "migrated",
      records: 1,
      installations: 1,
      backupPath: expect.any(String),
      domains: expectedDomains,
    });
    expect(existsSync(join(authDir, "legacy-cli.json"))).toBe(false);
    expect(existsSync(vault.valuePath("LEGACY_TOKEN"))).toBe(false);
    expect(existsSync(join(remoteDir, "remote-server-credentials.json"))).toBe(false);
    expect(existsSync(join(remoteDir, "dashboard-activity.jsonl"))).toBe(false);
    expect(existsSync(vault.paths.keyFile)).toBe(true);
    expect(existsSync(join(migrated.backupPath, "vault", "vault-key"))).toBe(true);
    expect(
      existsSync(join(migrated.backupPath, "remote-security", "remote-server-credentials.json")),
    ).toBe(true);
    expect(
      existsSync(join(migrated.backupPath, "operator-activity", "dashboard-activity.jsonl")),
    ).toBe(true);
    expect(existsSync(overlayPath)).toBe(true);

    const storage = await createHostStorage({ type: "sqlite", path: databasePath }, { vaultRoot });
    try {
      await expect(storage.backendAuth.readTokenBundle("legacy-cli")).resolves.toMatchObject({
        bundle: { accessToken: "legacy-access-token" },
      });
      await expect(storage.vaultValues.resolveValue("LEGACY_TOKEN")).resolves.toBe(
        "legacy-vault-value",
      );
      await expect(storage.vaultGrants.list()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            subjectKind: "record",
            capletId: "legacy-cli",
            originKind: "stored-record",
            originPath: null,
          }),
          expect.objectContaining({
            subjectKind: "file",
            capletId: "overlay",
            originKind: "global-file",
            originPath: overlayPath,
          }),
        ]),
      );
      await expect(
        storage.remoteSecurity.validateAccessToken({
          hostUrl,
          accessToken: remoteCredentials.accessToken,
        }),
      ).resolves.toMatchObject({ clientId: remoteCredentials.clientId, role: "access" });
      await expect(
        storage.remoteSecurity.pollPendingLogin({
          flowId: pendingLogin.flowId,
          pendingCompletionSecret: pendingLogin.pendingCompletionSecret,
        }),
      ).resolves.toEqual({ flowId: pendingLogin.flowId, status: "pending" });
      await expect(
        storage.remoteSecurity.exchangePairingCode({
          hostUrl,
          code: unusedPairing.code,
          clientLabel: "Post-migration client",
        }),
      ).resolves.toMatchObject({ hostUrl, role: "access" });
      await expect(storage.operatorActivity.list({ action: "catalog_installed" })).resolves.toEqual(
        {
          entries: [expect.objectContaining({ id: activity.id, actorClientId: "legacy_operator" })],
        },
      );
    } finally {
      await storage.close();
    }
  });
});
