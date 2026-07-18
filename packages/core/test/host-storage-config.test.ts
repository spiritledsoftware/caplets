import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfigWithHostStorage, resolveCapletsRoot } from "../src/config";
import { CapletsEngine } from "../src/engine";
import { createHostStorage } from "../src/storage";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function caplet(command: string): string {
  return `---
name: GitHub
description: Manage GitHub repositories from the selected source.
mcpServer:
  command: ${command}
---
# GitHub
`;
}

describe("stored Caplet source", () => {
  it("resolves project files over global files over stored records", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-layers-"));
    directories.push(root);
    const userConfigPath = join(root, "user", "config.json");
    const globalFilePath = join(resolveCapletsRoot(userConfigPath), "github.md");
    const projectConfigPath = join(root, "project", ".caplets", "config.json");
    const projectFilePath = join(dirname(projectConfigPath), "github.md");
    mkdirSync(dirname(userConfigPath), { recursive: true });
    mkdirSync(dirname(globalFilePath), { recursive: true });
    mkdirSync(dirname(projectConfigPath), { recursive: true });
    writeFileSync(userConfigPath, "{}");
    writeFileSync(projectConfigPath, "{}");
    writeFileSync(globalFilePath, caplet("global-github"));
    writeFileSync(projectFilePath, caplet("project-github"));
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(root, "caplets.sqlite3"),
    });

    try {
      await storage.caplets.importBundle({
        id: "github",
        operator: { clientId: "operator_import", role: "operator" },
        files: [
          {
            path: "CAPLET.md",
            executable: false,
            content: Buffer.from(caplet("stored-github")),
          },
        ],
      });
      const options = { recordCacheRoot: join(root, "record-cache") };
      const project = await loadConfigWithHostStorage(
        storage,
        userConfigPath,
        projectConfigPath,
        options,
      );
      expect(project.config.mcpServers.github?.command).toBe("project-github");
      expect(project.sources.github?.kind).toBe("project-file");
      expect(project.shadows.github?.map((source) => source.kind)).toEqual([
        "stored-record",
        "global-file",
      ]);
      await expect(storage.caplets.list()).resolves.toMatchObject([
        {
          id: "github",
          currentRevision: {
            backends: [{ family: "mcpServer", config: { command: "stored-github" } }],
          },
        },
      ]);

      rmSync(projectFilePath);
      const global = await loadConfigWithHostStorage(
        storage,
        userConfigPath,
        projectConfigPath,
        options,
      );
      expect(global.config.mcpServers.github?.command).toBe("global-github");
      expect(global.sources.github?.kind).toBe("global-file");

      rmSync(globalFilePath);
      const stored = await loadConfigWithHostStorage(
        storage,
        userConfigPath,
        projectConfigPath,
        options,
      );
      expect(stored.config.mcpServers.github?.command).toBe("stored-github");
      expect(stored.sources.github?.kind).toBe("stored-record");
      const engine = new CapletsEngine({
        initialConfig: stored.config,
        hostStorage: storage,
        watch: false,
      });
      await storage.close();
      const outcome = (await engine.execute("github", {
        operation: "list_tools",
      })) as { structuredContent?: { error?: unknown } };
      expect(outcome.structuredContent?.error).toMatchObject({
        code: "SERVER_UNAVAILABLE",
      });
      await engine.close();
    } finally {
      await storage.close();
    }
  });

  it("starts from SQLite-backed Caplet Records without filesystem Caplet files", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-sql-runtime-"));
    directories.push(root);
    const databasePath = join(root, "caplets.sqlite3");
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "project", ".caplets", "config.json");
    writeFileSync(configPath, JSON.stringify({ storage: { type: "sqlite", path: databasePath } }));
    const storage = await createHostStorage({ type: "sqlite", path: databasePath });
    await storage.caplets.importBundle({
      id: "github",
      operator: { clientId: "operator_import", role: "operator" },
      files: [
        {
          path: "CAPLET.md",
          executable: false,
          content: Buffer.from(caplet("stored-github")),
        },
      ],
    });
    await storage.close();

    const engine = await CapletsEngine.create({
      configPath,
      projectConfigPath,
      watch: false,
    });
    try {
      expect(engine.currentConfig().mcpServers.github?.command).toBe("stored-github");
    } finally {
      await engine.close();
    }
  });

  it("converges peer engine snapshots after a committed record generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-sql-convergence-"));
    directories.push(root);
    const databasePath = join(root, "caplets.sqlite3");
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "project", ".caplets", "config.json");
    writeFileSync(configPath, JSON.stringify({ storage: { type: "sqlite", path: databasePath } }));
    const seed = await createHostStorage({ type: "sqlite", path: databasePath });
    await seed.caplets.importBundle({
      id: "github",
      operator: { clientId: "operator_import", role: "operator" },
      files: [
        {
          path: "CAPLET.md",
          executable: false,
          content: Buffer.from(caplet("stored-v1")),
        },
      ],
    });
    await seed.close();
    const first = await CapletsEngine.create({ configPath, projectConfigPath, watch: false });
    const second = await CapletsEngine.create({ configPath, projectConfigPath, watch: false });
    const writer = await createHostStorage({ type: "sqlite", path: databasePath });
    try {
      await writer.caplets.updateBundle({
        id: "github",
        operator: { clientId: "operator_update", role: "operator" },
        expectedGeneration: 1,
        files: [
          {
            path: "CAPLET.md",
            executable: false,
            content: Buffer.from(caplet("stored-v2")),
          },
        ],
      });
      await expect
        .poll(() => second.currentConfig().mcpServers.github?.command, {
          timeout: 6_000,
          interval: 100,
        })
        .toBe("stored-v2");
      expect(first.currentConfig().mcpServers.github?.command).toBe("stored-v2");
    } finally {
      await writer.close();
      await first.close();
      await second.close();
    }
  }, 8_000);
});
