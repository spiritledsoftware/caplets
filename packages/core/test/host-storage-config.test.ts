import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadConfigWithHostStorage,
  loadConfigWithSources,
  resolveCapletsRoot,
} from "../src/config";
import { CapletsEngine } from "../src/engine";
import { createHostStorage } from "../src/storage";
import { hostNodes } from "../src/storage/schema/sqlite";

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

  it("quarantines unresolved global config Caplets during Host startup", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-host-vault-quarantine-"));
    directories.push(root);
    const databasePath = join(root, "caplets.sqlite3");
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "project", ".caplets", "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        storage: { type: "sqlite", path: databasePath },
        mcpServers: {
          github: {
            name: "GitHub",
            description: "Inspect and manage GitHub repositories.",
            url: "https://api.githubcopilot.com/mcp",
            auth: { type: "bearer", token: "$vault:GH_TOKEN" },
          },
        },
      }),
    );
    const storage = await createHostStorage({ type: "sqlite", path: databasePath });
    await storage.vaultGrants.grant({
      capletId: "github",
      vaultKey: "GH_TOKEN",
      referenceName: "GH_TOKEN",
      originKind: "global-config",
      originPath: configPath,
      operator: { role: "operator", clientId: "test" },
    });
    await storage.close();
    const errors: string[] = [];

    const engine = await CapletsEngine.create({
      configPath,
      projectConfigPath,
      watch: false,
      vaultRecoveryTarget: "remote",
      writeErr: (value) => errors.push(value),
    });
    try {
      expect(engine.enabledServers()).toEqual([]);
      expect(errors.join("")).toContain("Caplet github references missing Vault key GH_TOKEN");
      expect(errors.join("")).toContain("--remote");
    } finally {
      await engine.close();
    }
  });

  it("does not reactivate a shadowed Caplet when its override is quarantined", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-host-vault-shadow-quarantine-"));
    directories.push(root);
    const databasePath = join(root, "caplets.sqlite3");
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "project", ".caplets", "config.json");
    const projectCapletDir = join(dirname(projectConfigPath), "github");
    mkdirSync(projectCapletDir, { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        storage: { type: "sqlite", path: databasePath },
        mcpServers: {
          github: {
            name: "Global GitHub",
            description: "Global GitHub tools.",
            command: "global-github",
          },
          healthy: {
            name: "Healthy",
            description: "Healthy tools.",
            command: "healthy",
          },
        },
      }),
    );
    writeFileSync(
      join(projectCapletDir, "CAPLET.md"),
      [
        "---",
        "name: Project GitHub",
        "description: Project GitHub tools.",
        "mcpServer:",
        "  transport: http",
        "  url: https://api.githubcopilot.com/mcp",
        "  auth:",
        "    type: bearer",
        "    token: $vault:GH_TOKEN",
        "---",
        "",
      ].join("\n"),
    );
    const errors: string[] = [];

    const engine = await CapletsEngine.create({
      configPath,
      projectConfigPath,
      watch: false,
      writeErr: (value) => errors.push(value),
    });
    try {
      expect(engine.currentConfig().mcpServers.github).toBeUndefined();
      expect(engine.currentConfig().mcpServers.healthy?.command).toBe("healthy");
      expect(errors.join("")).toContain("Caplet github references ungranted Vault key GH_TOKEN");
    } finally {
      await engine.close();
    }
  });

  it("persists keyed runtime parity while manifesting only global Caplet Files", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-cluster-parity-"));
    directories.push(root);
    const databasePath = join(root, "caplets.sqlite3");
    const previousStateHome = process.env.XDG_STATE_HOME;
    const previousEncryptionKey = process.env.CAPLETS_ENCRYPTION_KEY;
    process.env.XDG_STATE_HOME = join(root, "state");
    process.env.CAPLETS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64url");
    const engines: CapletsEngine[] = [];
    const writeNode = (
      name: string,
      port: number,
      command: string,
      runtimeOptions: Record<string, unknown> = {},
    ) => {
      const nodeRoot = join(root, name);
      const configPath = join(nodeRoot, "config.json");
      const projectConfigPath = join(nodeRoot, "project", ".caplets", "config.json");
      mkdirSync(nodeRoot, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          storage: { type: "sqlite", path: databasePath },
          serve: { host: "127.0.0.1", port },
          ...runtimeOptions,
        }),
      );
      writeFileSync(join(nodeRoot, "github.md"), caplet(command));
      return { configPath, projectConfigPath, watch: false as const };
    };
    const firstNode = writeNode("node-a", 4101, "shared-command");
    const localConfigChanged = writeNode("node-b", 4102, "shared-command");
    const runtimeConfigChanged = writeNode("node-d", 4104, "shared-command", {
      defaultSearchLimit: 10,
    });
    const capletFileChanged = writeNode("node-c", 4103, "changed-command");
    const inspector = await createHostStorage({ type: "sqlite", path: databasePath });
    if (inspector.database.dialect !== "sqlite") throw new Error("Expected SQLite storage");
    const sqliteDatabase = inspector.database;
    const persistedNodes = () => sqliteDatabase.db.select().from(hostNodes).all();

    try {
      const first = await CapletsEngine.create(firstNode);
      engines.push(first);
      const [firstPersisted] = await persistedNodes();
      expect(firstPersisted?.runtimeFingerprint).toMatch(/^hmac-sha256:[a-f0-9]{64}$/u);
      expect(firstPersisted?.runtimeFingerprint).not.toBe(
        loadConfigWithSources(firstNode.configPath, firstNode.projectConfigPath).runtimeFingerprint
          ?.hostConfigurationFingerprint,
      );

      const sameKeyAndConfig = await CapletsEngine.create(firstNode);
      engines.push(sameKeyAndConfig);
      expect(await persistedNodes()).toHaveLength(2);
      expect(
        (await persistedNodes()).every(
          (node) =>
            node.globalFileManifest === firstPersisted?.globalFileManifest &&
            node.runtimeFingerprint === firstPersisted?.runtimeFingerprint,
        ),
      ).toBe(true);

      const nodeWithLocalConfigChange = await CapletsEngine.create(localConfigChanged);
      engines.push(nodeWithLocalConfigChange);
      const afterLocalConfigChange = await persistedNodes();
      expect(afterLocalConfigChange).toHaveLength(3);
      expect(
        afterLocalConfigChange.every(
          (node) =>
            node.globalFileManifest === firstPersisted?.globalFileManifest &&
            node.runtimeFingerprint === firstPersisted?.runtimeFingerprint,
        ),
      ).toBe(true);

      await expect(CapletsEngine.create(runtimeConfigChanged)).rejects.toMatchObject({
        details: { conflict: "runtime_fingerprint" },
      });
      expect(new Set((await persistedNodes()).map((node) => node.runtimeFingerprint))).toHaveLength(
        2,
      );

      process.env.CAPLETS_ENCRYPTION_KEY = Buffer.alloc(32, 2).toString("base64url");
      await expect(CapletsEngine.create(firstNode)).rejects.toMatchObject({
        details: { conflict: "runtime_fingerprint" },
      });
      const sameManifest = (await persistedNodes()).filter(
        (node) => node.globalFileManifest === firstPersisted?.globalFileManifest,
      );
      expect(sameManifest).toHaveLength(5);
      expect(new Set(sameManifest.map((node) => node.runtimeFingerprint))).toHaveLength(3);

      process.env.CAPLETS_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64url");
      await expect(CapletsEngine.create(capletFileChanged)).rejects.toMatchObject({
        details: { conflict: "global_file_manifest" },
      });
      expect(new Set((await persistedNodes()).map((node) => node.globalFileManifest))).toHaveLength(
        2,
      );
    } finally {
      await inspector.close();
      await Promise.all(engines.map(async (engine) => await engine.close()));
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
      if (previousEncryptionKey === undefined) delete process.env.CAPLETS_ENCRYPTION_KEY;
      else process.env.CAPLETS_ENCRYPTION_KEY = previousEncryptionKey;
    }
  });

  it("keeps project overlays out of heartbeat parity and refreshes global parity on reload", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-parity-reload-"));
    directories.push(root);
    const databasePath = join(root, "caplets.sqlite3");
    const configPath = join(root, "config.json");
    const globalFilePath = join(root, "github.md");
    const projectConfigPath = join(root, "project", ".caplets", "config.json");
    const projectFilePath = join(dirname(projectConfigPath), "github.md");
    const previousStateHome = process.env.XDG_STATE_HOME;
    const previousEncryptionKey = process.env.CAPLETS_ENCRYPTION_KEY;
    process.env.XDG_STATE_HOME = join(root, "state");
    process.env.CAPLETS_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64url");
    mkdirSync(dirname(projectFilePath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ storage: { type: "sqlite", path: databasePath } }));
    writeFileSync(globalFilePath, caplet("global-v1"));
    writeFileSync(projectFilePath, caplet("project-v1"));
    const engine = await CapletsEngine.create({ configPath, projectConfigPath, watch: false });
    const inspector = await createHostStorage({ type: "sqlite", path: databasePath });
    if (inspector.database.dialect !== "sqlite") throw new Error("Expected SQLite storage");
    const sqliteDatabase = inspector.database;

    try {
      const initial = await sqliteDatabase.db.select().from(hostNodes).get();
      expect(initial?.runtimeFingerprint).toMatch(/^hmac-sha256:[a-f0-9]{64}$/u);
      await expect
        .poll(async () => (await sqliteDatabase.db.select().from(hostNodes).get())?.heartbeatAt, {
          timeout: 2_500,
          interval: 50,
        })
        .not.toBe(initial?.heartbeatAt);
      expect((await sqliteDatabase.db.select().from(hostNodes).get())?.runtimeFingerprint).toBe(
        initial?.runtimeFingerprint,
      );

      writeFileSync(projectFilePath, caplet("project-v2"));
      await expect(engine.reload()).resolves.toBe(true);
      expect(engine.currentConfig().mcpServers.github?.command).toBe("project-v2");
      expect(await sqliteDatabase.db.select().from(hostNodes).get()).toMatchObject({
        globalFileManifest: initial?.globalFileManifest,
        runtimeFingerprint: initial?.runtimeFingerprint,
      });

      writeFileSync(
        configPath,
        JSON.stringify({
          storage: { type: "sqlite", path: databasePath },
          defaultSearchLimit: 10,
        }),
      );
      await expect(engine.reload()).resolves.toBe(true);
      expect(engine.currentConfig().mcpServers.github?.command).toBe("project-v2");
      const afterGlobalReload = await sqliteDatabase.db.select().from(hostNodes).get();
      expect(afterGlobalReload?.globalFileManifest).toBe(initial?.globalFileManifest);
      expect(afterGlobalReload?.runtimeFingerprint).not.toBe(initial?.runtimeFingerprint);
    } finally {
      await engine.close();
      await inspector.close();
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
      if (previousEncryptionKey === undefined) delete process.env.CAPLETS_ENCRYPTION_KEY;
      else process.env.CAPLETS_ENCRYPTION_KEY = previousEncryptionKey;
    }
  });
  it("isolates peer runtime materializations while converging committed records", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-sql-convergence-"));
    directories.push(root);
    const databasePath = join(root, "caplets.sqlite3");
    const configPath = join(root, "config.json");
    const projectConfigPath = join(root, "project", ".caplets", "config.json");
    const stateHome = join(root, "state");
    const previousStateHome = process.env.XDG_STATE_HOME;
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

    process.env.XDG_STATE_HOME = stateHome;
    const engines: CapletsEngine[] = [];
    let writer: Awaited<ReturnType<typeof createHostStorage>> | undefined;
    try {
      const first = await CapletsEngine.create({ configPath, projectConfigPath, watch: false });
      engines.push(first);
      const second = await CapletsEngine.create({ configPath, projectConfigPath, watch: false });
      engines.push(second);
      const cacheRoot = join(stateHome, "record-caplets");
      const runtimeCaches = readdirSync(cacheRoot, { withFileTypes: true }).filter((entry) =>
        entry.isDirectory(),
      );
      expect(runtimeCaches).toHaveLength(2);
      for (const cache of runtimeCaches) {
        expect(existsSync(join(cacheRoot, cache.name, "github", "CAPLET.md"))).toBe(true);
      }

      writer = await createHostStorage({ type: "sqlite", path: databasePath });
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
      await writer?.close();
      for (const engine of engines.reverse()) await engine.close();
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
    }
  }, 8_000);
});
