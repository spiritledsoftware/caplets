import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInteractiveSetup, runSetup, type SetupMcpUpsertOptions } from "../src/cli/setup";
import { capletSetupContentHash } from "../src/setup/hash";
import { LocalSetupStore } from "../src/setup/local-store";
import { runCapletSetup, type SetupSpawn } from "../src/setup/runner";
import type { SetupAttempt, SetupTargetKind } from "../src/setup/types";

describe("setup runner", () => {
  afterEach(() => {
    vi.doUnmock("../src/daemon");
  });

  it("accepts only local_host, remote_host, and hosted_sandbox setup targets", async () => {
    const accepted: SetupTargetKind[] = ["local_host", "remote_host", "hosted_sandbox"];
    expect([...accepted].sort()).toEqual(["hosted_sandbox", "local_host", "remote_host"]);

    for (const targetKind of accepted) {
      await expect(
        runCapletSetup({
          projectFingerprint: "project",
          capletId: "ast-grep",
          contentHash: "hash",
          targetKind,
          actor: "cli-yes",
          approved: true,
          setup: { commands: [] },
          store: memoryStore(),
          spawn: successfulSpawn(),
        }),
      ).resolves.toEqual([]);
    }
  });

  it.each(["local", "remote_server", "hosted_container"])(
    "rejects legacy stored setup target %s",
    async (targetKind) => {
      await expect(
        runCapletSetup({
          projectFingerprint: "project",
          capletId: "ast-grep",
          contentHash: "hash",
          targetKind: targetKind as SetupTargetKind,
          actor: "cli-yes",
          approved: true,
          setup: { commands: [] },
          store: memoryStore(),
          spawn: successfulSpawn(),
        }),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
        message: "setup target must be one of: local_host, remote_host, hosted_sandbox",
      });
    },
  );

  it("uses only persistence-eligible producer fingerprints for setup identity", () => {
    expect(
      capletSetupContentHash({
        fingerprint: "stable-runtime-fingerprint",
        persistenceEligible: true,
        valid: true,
      }),
    ).toBe("stable-runtime-fingerprint");
    expect(
      capletSetupContentHash({
        fingerprint: "must-not-persist",
        persistenceEligible: false,
        valid: true,
      }),
    ).toBe("live-only");
    expect(
      capletSetupContentHash({
        fingerprint: "invalid-runtime-fingerprint",
        persistenceEligible: true,
        valid: false,
      }),
    ).toBe("live-only");
    expect(capletSetupContentHash(undefined)).toBe("live-only");
  });

  it("requires approval before commands run", async () => {
    const store = memoryStore();
    await expect(
      runCapletSetup({
        projectFingerprint: "project",
        capletId: "ast-grep",
        contentHash: "hash",
        targetKind: "local_host",
        actor: "cli-interactive",
        approved: false,
        setup: { commands: [{ label: "Install", command: "npm" }] },
        store,
        spawn: successfulSpawn(),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    expect(store.attempts).toEqual([]);
  });

  it("records successful setup and verify attempts without executing real package managers", async () => {
    const store = memoryStore();
    const attempts = await runCapletSetup({
      projectFingerprint: "project",
      capletId: "ast-grep",
      contentHash: "hash",
      targetKind: "local_host",
      actor: "cli-yes",
      approved: true,
      setup: {
        commands: [{ label: "Install", command: "npm", args: ["install"] }],
        verify: [{ label: "Verify", command: "ast-grep-mcp", args: ["--help"] }],
      },
      store,
      spawn: successfulSpawn(),
    });
    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["succeeded", "succeeded"]);
    expect(attempts[0]?.actor).toBe("cli-yes");
    expect(attempts[0]?.projectFingerprint).toBe("project");
    expect(store.attempts).toHaveLength(2);
  });

  it("leaves status failed when verify fails", async () => {
    const store = memoryStore();
    const attempts = await runCapletSetup({
      projectFingerprint: "project",
      capletId: "ast-grep",
      contentHash: "hash",
      targetKind: "local_host",
      actor: "cli-yes",
      approved: true,
      setup: {
        commands: [{ label: "Install", command: "npm" }],
        verify: [{ label: "Verify", command: "ast-grep-mcp" }],
      },
      store,
      spawn: async (command) => ({
        exitCode: command === "ast-grep-mcp" ? 1 : 0,
        stdout: "",
        stderr: "missing",
        durationMs: 1,
      }),
    });
    expect(attempts.at(-1)).toMatchObject({ phase: "verify", status: "failed" });
  });

  it("caps output and redacts secret-looking env values", async () => {
    const store = memoryStore();
    const attempts = await runCapletSetup({
      projectFingerprint: "project",
      capletId: "secret",
      contentHash: "hash",
      targetKind: "local_host",
      actor: "cli-yes",
      approved: true,
      setup: {
        commands: [
          {
            label: "Install",
            command: "echo",
            env: { API_TOKEN: "super-secret-value" },
            maxOutputBytes: 12,
          },
        ],
      },
      store,
      spawn: async () => ({
        exitCode: 0,
        stdout: "super-secret-value with trailing data",
        stderr: "",
        durationMs: 1,
      }),
    });
    expect(attempts[0]?.stdout).toBe("[REDACTED] w");
    expect(attempts[0]?.redacted).toBe(true);
  });

  it("keys approvals by project fingerprint, caplet, content hash, and target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-setup-store-"));
    try {
      const store = new LocalSetupStore({ baseDir: dir });
      await store.approve({
        projectFingerprint: "project-a",
        capletId: "ast-grep",
        contentHash: "hash",
        targetKind: "remote_host",
        actor: "cli-yes",
        approvedAt: "2026-06-02T12:00:00.000Z",
      });

      await expect(
        store.getApproval("project-a", "ast-grep", "hash", "remote_host"),
      ).resolves.toMatchObject({ projectFingerprint: "project-a" });
      await expect(
        store.getApproval("project-b", "ast-grep", "hash", "remote_host"),
      ).resolves.toBeUndefined();
      await expect(
        store.getApproval("project-a", "ast-grep", "hash", "local_host"),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps local attempts to the free retention window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-setup-store-"));
    try {
      const store = new LocalSetupStore({ baseDir: dir, maxAttempts: 3, retentionDays: 7 });
      for (let index = 0; index < 5; index += 1) {
        await store.recordAttempt({
          ...attempt(index),
          capletId: "ast-grep",
        });
      }
      const attempts = await store.listAttempts("project", "ast-grep");
      expect(attempts).toHaveLength(3);
      expect(attempts.map((entry) => entry.commandLabel)).toEqual(["2", "3", "4"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps attempt retention scoped to a project fingerprint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-setup-store-"));
    try {
      const store = new LocalSetupStore({ baseDir: dir, maxAttempts: 3, retentionDays: 7 });
      await store.recordAttempt({
        ...attempt(0),
        projectFingerprint: "project-a",
        commandLabel: "a",
      });
      await store.recordAttempt({
        ...attempt(1),
        projectFingerprint: "project-b",
        commandLabel: "b",
      });

      await expect(store.listAttempts("project-a", "ast-grep")).resolves.toMatchObject([
        { projectFingerprint: "project-a", commandLabel: "a" },
      ]);
      await expect(store.listAttempts("project-b", "ast-grep")).resolves.toMatchObject([
        { projectFingerprint: "project-b", commandLabel: "b" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates user config before daemon setup and reports daemon-backed JSON phases", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-first-setup-"));
    const configPath = join(dir, "config.json");
    const upserts: unknown[] = [];
    try {
      const result = JSON.parse(
        await runSetup("codex", {
          format: "json",
          env: { CAPLETS_CONFIG: configPath },
          mcpOperations: {
            listSupportedClients: () => fakeMcpClients(),
            upsertServer: async (options) => {
              upserts.push(options);
              return { clientId: "codex", success: true, path: join(dir, "codex.toml") };
            },
          },
          setupOperations: {
            ensureDaemon: async () => {
              expect(existsSync(configPath)).toBe(true);
              return {
                phase: "daemon",
                label: "Start local Caplets daemon",
                status: "completed",
                daemonBaseUrl: "http://127.0.0.1:5387/caplets",
                message: "daemon is healthy",
              };
            },
          },
        }),
      );

      expect(result.phases).toMatchObject([
        { phase: "config", status: "completed", path: configPath },
        { phase: "daemon", status: "completed", daemonBaseUrl: "http://127.0.0.1:5387/caplets" },
        { phase: "integration", status: "completed" },
      ]);
      expect(upserts).toEqual([
        { clientId: "codex", daemonBaseUrl: "http://127.0.0.1:5387/caplets", local: true },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs default local setup daemons as credential-free loopback services", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-local-daemon-auth-"));
    const daemon = mockDaemonModule();
    daemon.daemonStatus.mockResolvedValueOnce({ installed: false, running: false });
    daemon.installDaemon.mockResolvedValueOnce(
      daemonInstallResult({
        allowUnauthenticatedHttp: true,
        auth: { type: "development_unauthenticated" },
      }),
    );
    vi.resetModules();
    vi.doMock("../src/daemon", () => daemon);
    const { runSetup: mockedRunSetup } = await import("../src/cli/setup");
    try {
      await mockedRunSetup("mcp-client", {
        client: "zed",
        env: { CAPLETS_CONFIG: join(dir, "config.json") },
        mcpOperations: {
          listSupportedClients: () => fakeMcpClients(),
          upsertServer: async () => ({
            clientId: "zed",
            success: true,
            path: join(dir, "zed.json"),
          }),
        },
      });

      expect(daemon.installDaemon).toHaveBeenCalledWith(
        expect.objectContaining({
          start: true,
          host: "127.0.0.1",
          allowUnauthenticatedHttp: true,
        }),
        expect.anything(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores unsafe global serve defaults when preparing local setup daemons", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-local-daemon-global-defaults-"));
    const configPath = join(dir, "config.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          noop: {
            name: "Noop",
            description: "A harmless placeholder MCP server.",
            command: "node",
          },
        },
        serve: { host: "0.0.0.0", allowUnauthenticatedHttp: false },
      }),
    );
    const daemon = mockDaemonModule();
    daemon.daemonStatus.mockResolvedValueOnce({ installed: false, running: false });
    daemon.installDaemon.mockResolvedValueOnce(
      daemonInstallResult({
        allowUnauthenticatedHttp: true,
        auth: { type: "development_unauthenticated" },
      }),
    );
    const upserts: SetupMcpUpsertOptions[] = [];
    vi.resetModules();
    vi.doMock("../src/daemon", () => daemon);
    const { runSetup: mockedRunSetup } = await import("../src/cli/setup");
    try {
      await mockedRunSetup("mcp-client", {
        client: "zed",
        env: { CAPLETS_CONFIG: configPath },
        mcpOperations: {
          listSupportedClients: () => fakeMcpClients(),
          upsertServer: async (options) => {
            upserts.push(options);
            return { clientId: "zed", success: true, path: join(dir, "zed.json") };
          },
        },
      });

      expect(daemon.installDaemon).toHaveBeenCalledWith(
        expect.objectContaining({
          start: true,
          host: "127.0.0.1",
          allowUnauthenticatedHttp: true,
        }),
        expect.anything(),
      );
      expect(upserts).toEqual([
        { clientId: "zed", daemonBaseUrl: "http://127.0.0.1:5387/caplets", local: true },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updates healthy loopback daemons before local setup when they still require remote credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-local-daemon-repair-auth-"));
    const daemon = mockDaemonModule();
    daemon.daemonStatus.mockResolvedValueOnce({
      installed: true,
      running: true,
      health: { ok: true },
      config: daemonConfig({
        allowUnauthenticatedHttp: false,
        auth: { type: "remote_credentials" },
      }),
    });
    daemon.installDaemon.mockResolvedValueOnce(
      daemonInstallResult({
        allowUnauthenticatedHttp: true,
        auth: { type: "development_unauthenticated" },
      }),
    );
    vi.resetModules();
    vi.doMock("../src/daemon", () => daemon);
    const { runSetup: mockedRunSetup } = await import("../src/cli/setup");
    try {
      const result = JSON.parse(
        await mockedRunSetup("mcp-client", {
          client: "zed",
          format: "json",
          env: { CAPLETS_CONFIG: join(dir, "config.json") },
          mcpOperations: {
            listSupportedClients: () => fakeMcpClients(),
            upsertServer: async () => ({
              clientId: "zed",
              success: true,
              path: join(dir, "zed.json"),
            }),
          },
        }),
      );

      expect(daemon.installDaemon).toHaveBeenCalledWith(
        expect.objectContaining({
          start: true,
          host: "127.0.0.1",
          allowUnauthenticatedHttp: true,
        }),
        expect.anything(),
      );
      expect(result.phases).toMatchObject([
        { phase: "config", status: "completed" },
        { phase: "daemon", status: "completed", daemonBaseUrl: "http://127.0.0.1:5387/caplets" },
        { phase: "integration", status: "completed" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects existing non-loopback daemons before making local setup credential-free", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-local-daemon-network-auth-"));
    const daemon = mockDaemonModule();
    daemon.daemonStatus.mockResolvedValueOnce({
      installed: true,
      running: true,
      health: { ok: true },
      config: daemonConfig({
        host: "0.0.0.0",
        allowUnauthenticatedHttp: false,
        auth: { type: "remote_credentials" },
      }),
    });
    vi.resetModules();
    vi.doMock("../src/daemon", () => daemon);
    const { runSetup: mockedRunSetup } = await import("../src/cli/setup");
    try {
      await expect(
        mockedRunSetup("mcp-client", {
          client: "zed",
          env: { CAPLETS_CONFIG: join(dir, "config.json") },
          mcpOperations: {
            listSupportedClients: () => fakeMcpClients(),
            upsertServer: async () => ({
              clientId: "zed",
              success: true,
              path: join(dir, "zed.json"),
            }),
          },
        }),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
        message: expect.stringContaining("cannot configure credential-free local attach"),
      });
      expect(daemon.installDaemon).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails before daemon or integration work when an existing user config is invalid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-first-invalid-config-"));
    const configPath = join(dir, "config.json");
    const commands: Array<{ command: string; args: string[] }> = [];
    let daemonCalled = false;
    let upsertCalled = false;
    try {
      writeFileSync(configPath, "{ not json");

      await expect(
        runSetup("codex", {
          env: { CAPLETS_CONFIG: configPath },
          mcpOperations: {
            listSupportedClients: () => fakeMcpClients(),
            upsertServer: async () => {
              upsertCalled = true;
              return { clientId: "codex", success: true, path: join(dir, "codex.toml") };
            },
          },
          runCommand: async (command, args) => {
            commands.push({ command, args });
            return { stdout: "", stderr: "" };
          },
          setupOperations: {
            ensureDaemon: async () => {
              daemonCalled = true;
              return {
                phase: "daemon",
                label: "Start local Caplets daemon",
                status: "completed",
                daemonBaseUrl: "http://127.0.0.1:5387/caplets",
              };
            },
          },
        }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(daemonCalled).toBe(false);
      expect(upsertCalled).toBe(false);
      expect(commands).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates the working tree project config before daemon or integration work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-first-project-config-"));
    const configPath = join(dir, "user-config.json");
    const projectDir = join(dir, "project");
    const projectConfigPath = join(projectDir, ".caplets", "config.json");
    const previousCwd = process.cwd();
    let daemonCalled = false;
    let upsertCalled = false;
    try {
      writeFileSync(configPath, "{}\n");
      mkdirSync(dirname(projectConfigPath), { recursive: true });
      writeFileSync(projectConfigPath, "{ not json");
      process.chdir(projectDir);

      await expect(
        runSetup("codex", {
          env: { CAPLETS_CONFIG: configPath },
          mcpOperations: {
            listSupportedClients: () => fakeMcpClients(),
            upsertServer: async () => {
              upsertCalled = true;
              return { clientId: "codex", success: true, path: join(dir, "codex.toml") };
            },
          },
          setupOperations: {
            ensureDaemon: async () => {
              daemonCalled = true;
              return {
                phase: "daemon",
                label: "Start local Caplets daemon",
                status: "completed",
                daemonBaseUrl: "http://127.0.0.1:5387/caplets",
              };
            },
          },
        }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });

      expect(daemonCalled).toBe(false);
      expect(upsertCalled).toBe(false);
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("validates the working tree project config during first-run setup before daemon work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-first-new-user-project-config-"));
    const configPath = join(dir, "user-config.json");
    const projectDir = join(dir, "project");
    const projectConfigPath = join(projectDir, ".caplets", "config.json");
    const previousCwd = process.cwd();
    let daemonCalled = false;
    let upsertCalled = false;
    try {
      mkdirSync(dirname(projectConfigPath), { recursive: true });
      writeFileSync(projectConfigPath, "{ not json");
      process.chdir(projectDir);

      await expect(
        runSetup("codex", {
          env: { CAPLETS_CONFIG: configPath },
          mcpOperations: {
            listSupportedClients: () => fakeMcpClients(),
            upsertServer: async () => {
              upsertCalled = true;
              return { clientId: "codex", success: true, path: join(dir, "codex.toml") };
            },
          },
          setupOperations: {
            ensureDaemon: async () => {
              daemonCalled = true;
              return {
                phase: "daemon",
                label: "Start local Caplets daemon",
                status: "completed",
                daemonBaseUrl: "http://127.0.0.1:5387/caplets",
              };
            },
          },
        }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });

      expect(daemonCalled).toBe(false);
      expect(upsertCalled).toBe(false);
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid integration options before config or daemon phases", async () => {
    let configCalled = false;
    let daemonCalled = false;

    await expect(
      runSetup("mcp-client", {
        setupOperations: {
          ensureUserConfig: () => {
            configCalled = true;
            return {
              phase: "config",
              label: "Initialize user Caplets config",
              status: "completed",
            };
          },
          ensureDaemon: () => {
            daemonCalled = true;
            return {
              phase: "daemon",
              label: "Start local Caplets daemon",
              status: "completed",
              daemonBaseUrl: "http://127.0.0.1:5387/caplets",
            };
          },
        },
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

    expect(configCalled).toBe(false);
    expect(daemonCalled).toBe(false);
  });

  it("reports daemon failure and does not call integration writers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-first-daemon-failure-"));
    const configPath = join(dir, "config.json");
    const commands: Array<{ command: string; args: string[] }> = [];
    let upsertCalled = false;
    try {
      await expect(
        runSetup("codex", {
          env: { CAPLETS_CONFIG: configPath },
          mcpOperations: {
            listSupportedClients: () => fakeMcpClients(),
            upsertServer: async () => {
              upsertCalled = true;
              return { clientId: "codex", success: true, path: join(dir, "codex.toml") };
            },
          },
          runCommand: async (command, args) => {
            commands.push({ command, args });
            return { stdout: "", stderr: "" };
          },
          setupOperations: {
            ensureDaemon: async () => {
              throw new Error("daemon health probe failed");
            },
          },
        }),
      ).rejects.toMatchObject({
        code: "SERVER_UNAVAILABLE",
        message: expect.stringContaining("daemon health probe failed"),
      });
      expect(commands).toEqual([]);
      expect(upsertCalled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dry-runs local setup phases without writes, daemon operations, or integration mutation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-first-dry-run-"));
    const configPath = join(dir, "config.json");
    const commands: Array<{ command: string; args: string[] }> = [];
    let daemonCalled = false;
    let upsertCalled = false;
    try {
      const result = JSON.parse(
        await runSetup("codex", {
          dryRun: true,
          format: "json",
          env: { CAPLETS_CONFIG: configPath },
          mcpOperations: {
            listSupportedClients: () => fakeMcpClients(),
            upsertServer: async () => {
              upsertCalled = true;
              return { clientId: "codex", success: true, path: join(dir, "codex.toml") };
            },
          },
          runCommand: async (command, args) => {
            commands.push({ command, args });
            return { stdout: "", stderr: "" };
          },
          setupOperations: {
            ensureDaemon: async () => {
              daemonCalled = true;
              return {
                phase: "daemon",
                label: "Start local Caplets daemon",
                status: "completed",
                daemonBaseUrl: "http://127.0.0.1:5387/caplets",
              };
            },
          },
        }),
      );

      expect(existsSync(configPath)).toBe(false);
      expect(daemonCalled).toBe(false);
      expect(upsertCalled).toBe(false);
      expect(commands).toEqual([]);
      expect(result.phases).toMatchObject([
        { phase: "config", status: "planned", path: configPath },
        { phase: "daemon", status: "planned" },
        { phase: "integration", status: "planned" },
      ]);
      expect(result.actions[0]).toMatchObject({ status: "planned" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("native setup installs the plugin and writes daemon defaults", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-native-setup-defaults-"));
    const daemonBaseUrl = "http://127.0.0.1:5387/caplets";
    const commands: Array<{ command: string; args: string[] }> = [];
    const defaultsPath = join(dir, "native-defaults.json");
    try {
      const result = JSON.parse(
        await runSetup("opencode", {
          format: "json",
          env: { CAPLETS_CONFIG: join(dir, "config.json") },
          nativeDefaultsPath: defaultsPath,
          runCommand: async (command, args) => {
            commands.push({ command, args });
            return { stdout: "", stderr: "" };
          },
          setupOperations: fakeSetupPhases(daemonBaseUrl),
        }),
      );

      expect(commands).toEqual([
        { command: "opencode", args: ["plugin", "@caplets/opencode", "--global"] },
      ]);
      expect(JSON.parse(readFileSync(defaultsPath, "utf8"))).toMatchObject({
        version: 1,
        source: "setup",
        daemon: { url: daemonBaseUrl },
      });
      expect(result.actions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "completed", path: defaultsPath }),
        ]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports healthy existing daemon reuse before integration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-daemon-first-reuse-"));
    const configPath = join(dir, "config.json");
    try {
      const result = JSON.parse(
        await runSetup("codex", {
          format: "json",
          env: { CAPLETS_CONFIG: configPath },
          mcpOperations: {
            listSupportedClients: () => fakeMcpClients(),
            upsertServer: async () => ({
              clientId: "codex",
              success: true,
              path: join(dir, "codex.toml"),
            }),
          },
          setupOperations: {
            ensureDaemon: async () => ({
              phase: "daemon",
              label: "Reuse local Caplets daemon",
              status: "reused",
              daemonBaseUrl: "http://127.0.0.1:5387/caplets",
            }),
          },
        }),
      );

      expect(result.phases).toMatchObject([
        { phase: "config", status: "completed" },
        { phase: "daemon", status: "reused", daemonBaseUrl: "http://127.0.0.1:5387/caplets" },
        { phase: "integration", status: "completed" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses neutral setup target names in CLI setup copy", async () => {
    const local = await runSetup("opencode", {
      target: "local_host",
      dryRun: true,
      format: "json",
    });
    expect(JSON.parse(local)).toMatchObject({ targetKind: "local_host" });

    const remoteServer = await runSetup("opencode", {
      remote: true,
      target: "remote_host",
      dryRun: true,
      format: "json",
    });
    expect(JSON.parse(remoteServer)).toMatchObject({ targetKind: "remote_host" });

    const hostedContainer = await runSetup("opencode", {
      target: "hosted_sandbox",
      dryRun: true,
      format: "json",
    });
    expect(JSON.parse(hostedContainer)).toMatchObject({ targetKind: "hosted_sandbox" });
  });

  it.each(["remote", "cloud", "hosted_worker"])(
    "serializes legacy CLI setup alias %s to a semantic target",
    async (target) => {
      const result = await runSetup("opencode", {
        target: target as "remote" | "cloud" | "hosted_worker",
        dryRun: true,
        format: "json",
      });
      expect(JSON.parse(result).targetKind).toBe(
        target === "remote" ? "remote_host" : "hosted_sandbox",
      );
    },
  );

  it("configures a targeted add-mcp client with daemon attach and no credential env", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-mcp-target-"));
    const daemonBaseUrl = "http://127.0.0.1:5387/caplets";
    const upserts: unknown[] = [];
    try {
      const result = JSON.parse(
        await runSetup("mcp-client", {
          client: "zed",
          format: "json",
          env: {
            CAPLETS_CONFIG: join(dir, "config.json"),
            CAPLETS_REMOTE_TOKEN: "must-not-leak",
            VAULT_PASSWORD: "must-not-leak",
          },
          setupOperations: fakeSetupPhases(daemonBaseUrl),
          mcpOperations: {
            listSupportedClients: () => fakeMcpClients(),
            upsertServer: async (options) => {
              upserts.push(options);
              return { clientId: "zed", success: true, path: join(dir, "zed.json") };
            },
          },
        }),
      );

      expect(upserts).toEqual([{ clientId: "zed", daemonBaseUrl, local: true }]);
      expect(JSON.stringify(upserts)).not.toContain("must-not-leak");
      expect(result.actions).toMatchObject([
        {
          status: "completed",
          clientId: "zed",
          command: "caplets attach http://127.0.0.1:5387/caplets",
          path: join(dir, "zed.json"),
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters detected MCP clients to stdio-capable choices before prompting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-mcp-detected-stdio-"));
    const daemonBaseUrl = "http://127.0.0.1:5387/caplets";
    const clients = [
      {
        id: "vscode",
        displayName: "VS Code",
        configPath: join(dir, "vscode.json"),
        supportsStdio: false,
      },
      {
        id: "zed",
        displayName: "Zed",
        configPath: join(dir, "zed.json"),
        supportsStdio: true,
      },
    ];
    const prompts: string[] = [];
    const upserts: unknown[] = [];
    try {
      await runInteractiveSetup({
        env: { CAPLETS_CONFIG: join(dir, "config.json") },
        setupOperations: fakeSetupPhases(daemonBaseUrl),
        mcpOperations: {
          listSupportedClients: () => clients,
          detectClients: () => clients,
          upsertServer: async (options) => {
            upserts.push(options);
            return { clientId: "zed", success: true, path: join(dir, "zed.json") };
          },
        },
        readPrompt: async (prompt) => {
          prompts.push(prompt);
          return prompts.length === 1 ? "mcp-client" : "";
        },
      });

      expect(prompts[1]).toContain("Zed (zed)");
      expect(prompts[1]).not.toContain("VS Code (vscode)");
      expect(upserts).toEqual([{ clientId: "zed", daemonBaseUrl, local: true }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps codex as a compatibility alias for the add-mcp adapter", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-mcp-codex-"));
    const daemonBaseUrl = "http://127.0.0.1:5387/caplets";
    const upserts: unknown[] = [];
    const commands: unknown[] = [];
    try {
      await runSetup("codex", {
        env: { CAPLETS_CONFIG: join(dir, "config.json") },
        runCommand: async (command, args) => {
          commands.push({ command, args });
          return { stdout: "", stderr: "" };
        },
        setupOperations: fakeSetupPhases(daemonBaseUrl),
        mcpOperations: {
          listSupportedClients: () => fakeMcpClients(),
          upsertServer: async (options) => {
            upserts.push(options);
            return { clientId: "codex", success: true, path: join(dir, "codex.toml") };
          },
        },
      });

      expect(commands).toEqual([]);
      expect(upserts).toEqual([{ clientId: "codex", daemonBaseUrl, local: true }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dry-runs targeted add-mcp client setup without mutating adapter state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-mcp-dry-run-"));
    let upsertCalled = false;
    try {
      const result = JSON.parse(
        await runSetup("mcp-client", {
          client: "zed",
          dryRun: true,
          format: "json",
          env: { CAPLETS_CONFIG: join(dir, "config.json") },
          mcpOperations: {
            listSupportedClients: () => fakeMcpClients(),
            upsertServer: async () => {
              upsertCalled = true;
              return { clientId: "zed", success: true, path: join(dir, "zed.json") };
            },
          },
        }),
      );

      expect(upsertCalled).toBe(false);
      expect(result.actions).toMatchObject([
        {
          status: "planned",
          clientId: "zed",
          path: "/project/.zed/settings.json",
          scope: "project",
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces selected MCP client, scope, path, and adapter warnings in plain output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-mcp-plain-warning-"));
    try {
      const output = await runSetup("mcp-client", {
        client: "zed",
        env: { CAPLETS_CONFIG: join(dir, "config.json") },
        setupOperations: fakeSetupPhases("http://127.0.0.1:5387/caplets"),
        mcpOperations: {
          listSupportedClients: () => fakeMcpClients(),
          upsertServer: async () => ({
            clientId: "zed",
            success: true,
            path: join(dir, "zed.json"),
            droppedFields: ["headers"],
            extraPaths: [join(dir, "backup.json")],
          }),
        },
      });

      expect(output).toContain("configured Zed MCP client (project)");
      expect(output).toContain(`at ${join(dir, "zed.json")}`);
      expect(output).toContain("command: caplets attach http://127.0.0.1:5387/caplets");
      expect(output).toContain("dropped unsupported fields: headers");
      expect(output).toContain(`additional paths: ${join(dir, "backup.json")}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces add-mcp dropped fields and extra paths in JSON output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-mcp-warning-"));
    try {
      const result = JSON.parse(
        await runSetup("mcp-client", {
          client: "zed",
          format: "json",
          env: { CAPLETS_CONFIG: join(dir, "config.json") },
          setupOperations: fakeSetupPhases("http://127.0.0.1:5387/caplets"),
          mcpOperations: {
            listSupportedClients: () => fakeMcpClients(),
            upsertServer: async () => ({
              clientId: "zed",
              success: true,
              path: join(dir, "zed.json"),
              droppedFields: ["headers"],
              extraPaths: [join(dir, "backup.json")],
            }),
          },
        }),
      );

      expect(result.actions[0]).toMatchObject({
        droppedFields: ["headers"],
        extraPaths: [join(dir, "backup.json")],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records setup hash and runtime features without requiring project output retention", async () => {
    const store = memoryStore();
    const attempts = await runCapletSetup({
      projectFingerprint: "project",
      capletId: "browser",
      contentHash: "content",
      setupHash: "setup",
      targetKind: "hosted_sandbox",
      runtimeFeatures: ["browser"],
      actor: "cli-yes",
      approved: true,
      setup: { commands: [{ label: "Install", command: "npx", args: ["playwright", "install"] }] },
      store,
      spawn: successfulSpawn(),
    });

    expect(attempts[0]).toMatchObject({
      setupHash: "setup",
      runtimeFeatures: ["browser"],
      targetKind: "hosted_sandbox",
    });
  });

  it("rejects non-project setup commands that run inside a synced project workspace", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "caplets-project-"));
    try {
      await expect(
        runCapletSetup({
          capletId: "global-tool",
          contentHash: "hash",
          targetKind: "local_host",
          actor: "cli-yes",
          approved: true,
          projectWorkspacePath: projectRoot,
          projectBindingRequired: false,
          setup: {
            commands: [{ label: "Install", command: "npm", cwd: join(projectRoot, "tools") }],
          },
          store: memoryStore(),
          spawn: successfulSpawn(),
        }),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
        message: expect.stringContaining("Non-project setup cannot run inside project workspace"),
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

function fakeSetupPhases(daemonBaseUrl: string) {
  return {
    ensureDaemon: async () => ({
      phase: "daemon" as const,
      label: "Reuse local Caplets daemon",
      status: "reused" as const,
      daemonBaseUrl,
    }),
  };
}

function fakeMcpClients() {
  return [
    {
      id: "codex",
      displayName: "Codex",
      configPath: "/home/user/.codex/config.toml",
      projectConfigPath: "/project/.codex/config.toml",
      supportsStdio: true,
    },
    {
      id: "claude-code",
      displayName: "Claude Code",
      configPath: "/home/user/.claude.json",
      projectConfigPath: "/project/.claude.json",
      supportsStdio: true,
    },
    {
      id: "zed",
      displayName: "Zed",
      configPath: "/home/user/.config/zed/settings.json",
      projectConfigPath: "/project/.zed/settings.json",
      supportsStdio: true,
    },
  ];
}

function mockDaemonModule() {
  return {
    daemonStatus: vi.fn(),
    installDaemon: vi.fn(),
    daemonClientBaseUrl: vi.fn(
      (config: { serve: { host: string; port: number; path: string } }) =>
        new URL(`http://${config.serve.host}:${config.serve.port}${config.serve.path}`),
    ),
  };
}

function daemonInstallResult(serve: {
  host?: string;
  allowUnauthenticatedHttp: boolean;
  auth: { type: "development_unauthenticated" | "remote_credentials" };
}) {
  const config = daemonConfig(serve);
  return {
    status: { running: true, health: { ok: true }, config },
    config,
    validation: { ok: true },
    plannedActions: ["install", "start"],
  };
}

function daemonConfig(serve: {
  host?: string;
  allowUnauthenticatedHttp: boolean;
  auth: { type: "development_unauthenticated" | "remote_credentials" };
}) {
  return {
    version: 1,
    id: "default",
    serve: {
      transport: "http",
      host: "127.0.0.1",
      port: 5387,
      path: "/caplets",
      loopback: true,
      warnUnauthenticatedNetwork: false,
      trustProxy: false,
      ...serve,
    },
  };
}

function successfulSpawn(): SetupSpawn {
  return async () => ({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 });
}

function memoryStore() {
  const attempts: SetupAttempt[] = [];
  return {
    attempts,
    retention: () => ({ maxAttempts: 3, days: 7 }),
    recordAttempt: async (attempt: SetupAttempt) => {
      attempts.push(attempt);
    },
  };
}

function attempt(index: number): SetupAttempt {
  return {
    attemptId: `attempt-${index}`,
    projectFingerprint: "project",
    capletId: "ast-grep",
    contentHash: "hash",
    setupHash: "hash",
    targetKind: "local_host",
    runtimeFeatures: [],
    actor: "cli-yes",
    status: "succeeded",
    phase: "commands",
    commandLabel: String(index),
    argv: ["true"],
    exitCode: 0,
    durationMs: 1,
    startedAt: new Date(Date.now() + index).toISOString(),
    finishedAt: new Date(Date.now() + index).toISOString(),
    stdout: "",
    stderr: "",
    redacted: false,
    retention: { maxAttempts: 3, days: 7 },
  };
}
