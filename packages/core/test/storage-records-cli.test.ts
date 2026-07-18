import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
      const invalidations = storage.database.db
        .select()
        .from(hostConfigGenerations)
        .all()
        .filter(({ contentHash }) => contentHash.startsWith("mutation:"));
      expect(invalidations).toEqual([]);
      expect(activity.length).toBeGreaterThan(10);
      expect(activity.every((entry) => entry.operatorClientId === "local_cli")).toBe(true);
      expect(JSON.stringify(activity)).not.toContain("first-command");
      expect(JSON.stringify(activity)).not.toContain("second-command");
    } finally {
      await storage.close();
    }
  });

  it("requires explicit legacy Caplet paths for storage migrate-legacy", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-storage-migrate-legacy-cli-"));
    directories.push(root);
    const repository = join(root, "repository");
    const source = join(repository, "caplets", "legacy-cli");
    const capletsRoot = join(root, "legacy-host", "caplets");
    const lockfilePath = join(root, "legacy-host", "caplets.lock.json");
    const databasePath = join(root, "state", "caplets.sqlite3");
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ storage: { type: "sqlite", path: databasePath } }));
    writeBundle(source, "legacy-command", "Legacy");
    installCaplets(repository, {
      capletIds: ["legacy-cli"],
      destinationRoot: capletsRoot,
      lockfilePath,
    });

    const output: string[] = [];
    await runCli(
      [
        "storage",
        "migrate-legacy",
        "--caplets-root",
        capletsRoot,
        "--lockfile",
        lockfilePath,
        "--dry-run",
      ],
      {
        env: { CAPLETS_CONFIG: configPath },
        writeOut: (value) => output.push(value),
      },
    );

    expect(JSON.parse(output.join(""))).toEqual({
      status: "verified",
      records: 1,
      installations: 1,
      backupPath: null,
    });
    expect(existsSync(join(capletsRoot, "legacy-cli", "CAPLET.md"))).toBe(true);
    expect(existsSync(lockfilePath)).toBe(true);
  });
});
