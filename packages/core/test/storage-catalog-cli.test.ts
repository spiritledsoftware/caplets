import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { defaultCapletsLockfilePath } from "../src/config";
import { createHostStorage } from "../src/storage";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function bundle(command: string): string {
  return `---\nname: SQL Catalog\ndescription: SQL catalog lifecycle fixture.\nmcpServer:\n  command: ${command}\n---\n# SQL Catalog\n`;
}

describe("global SQL catalog lifecycle", () => {
  it("installs and updates complete bundles without global Caplet files or lockfiles", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-storage-catalog-cli-"));
    directories.push(root);
    const configPath = join(root, "config", "config.json");
    const databasePath = join(root, "state", "caplets.sqlite3");
    const repository = join(root, "repository");
    const capletPath = join(repository, "caplets", "catalog-demo");
    mkdirSync(join(root, "config"), { recursive: true });
    mkdirSync(capletPath, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ storage: { type: "sqlite", path: databasePath } }));
    writeFileSync(join(capletPath, "CAPLET.md"), bundle("catalog-v1"));
    writeFileSync(join(capletPath, "support.txt"), "first support\n");
    const env = {
      CAPLETS_CONFIG: configPath,
      CAPLETS_DISABLE_CATALOG_INDEXING: "1",
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_STATE_HOME: join(root, "xdg-state"),
    };

    const run = async (args: string[]): Promise<string> => {
      const output: string[] = [];
      await runCli(args, { env, writeOut: (value) => output.push(value) });
      return output.join("");
    };
    const invoke = async (args: string[]): Promise<{ entries: Array<Record<string, unknown>> }> =>
      JSON.parse(await run(args)) as { entries: Array<Record<string, unknown>> };

    const installed = await invoke(["install", repository, "catalog-demo", "--global", "--json"]);
    expect(installed.entries).toMatchObject([
      {
        id: "catalog-demo",
        status: "installed",
        destination: "sql://caplet-records/catalog-demo",
        source: repository,
        catalogIndexing: { status: "ineligible", reason: "catalog_indexing_disabled" },
        vaultSetup: { status: "ready" },
      },
    ]);
    expect(existsSync(join(configPath, "..", "catalog-demo"))).toBe(false);
    expect(existsSync(join(configPath, "..", "catalog-demo.md"))).toBe(false);
    expect(existsSync(defaultCapletsLockfilePath(env))).toBe(false);

    const storage = await createHostStorage({ type: "sqlite", path: databasePath });
    let recordKey: string;
    let installationKey: string;
    try {
      const record = await storage.caplets.readBundle("catalog-demo", {
        operator: { clientId: "test_reader", role: "operator" },
      });
      const installation = await storage.installations.getActive("catalog-demo");
      const observation = await storage.installations.getLatestObservation("catalog-demo");
      expect(record?.record.headGeneration).toBe(1);
      expect(record?.files.map((file) => file.path)).toEqual(["CAPLET.md", "support.txt"]);
      expect(record?.files.find((file) => file.path === "support.txt")?.content.toString()).toBe(
        "first support\n",
      );
      expect(installation).toMatchObject({
        generation: 1,
        status: "active",
        sourceKind: "local",
        sourceIdentity: repository,
      });
      expect(observation).toMatchObject({
        status: "current",
        contentHash: expect.any(String),
        risk: { backendFamilies: ["mcp"] },
      });
      recordKey = record!.record.recordKey;
      installationKey = installation!.installationKey;
    } finally {
      await storage.close();
    }

    writeFileSync(join(capletPath, "CAPLET.md"), bundle("catalog-v2"));
    writeFileSync(join(capletPath, "support.txt"), "second support\n");
    const updated = await run(["update", "catalog-demo", "--global"]);
    expect(updated).toContain("Updated catalog-demo at sql://caplet-records/catalog-demo\n");

    const forced = await invoke([
      "install",
      repository,
      "catalog-demo",
      "--global",
      "--force",
      "--json",
    ]);
    expect(forced.entries).toMatchObject([{ id: "catalog-demo", status: "noop" }]);

    const finalStorage = await createHostStorage({ type: "sqlite", path: databasePath });
    try {
      const record = await finalStorage.caplets.readBundle("catalog-demo", {
        operator: { clientId: "test_reader", role: "operator" },
      });
      const installation = await finalStorage.installations.getActive("catalog-demo");
      expect(record?.record.recordKey).toBe(recordKey);
      expect(record?.record.headGeneration).toBe(3);
      expect(record?.files.find((file) => file.path === "support.txt")?.content.toString()).toBe(
        "second support\n",
      );
      expect(installation?.installationKey).toBe(installationKey);
      expect(installation?.generation).toBe(3);
      await expect(finalStorage.coordination.currentConfigGeneration()).resolves.toBeGreaterThan(0);
    } finally {
      await finalStorage.close();
    }
    expect(existsSync(join(configPath, "..", "catalog-demo"))).toBe(false);
    expect(existsSync(join(configPath, "..", "catalog-demo.md"))).toBe(false);
    expect(existsSync(defaultCapletsLockfilePath(env))).toBe(false);
  });
});
