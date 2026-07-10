import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedMutagenProjectSync } from "../src/project-binding/mutagen";
import { ProjectBindingWorkspaceStore } from "../src/project-binding/workspaces";
import type { ProjectBindingLease } from "../src/project-binding";
import { createNativeCapletsService } from "../src/native/service";
import type { RemoteCapletsClient } from "../src/native/remote";

const dirs: string[] = [];
const fixtureProjectRoot = resolve(import.meta.dirname, "fixtures/project-binding/project");

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Project Binding integration", () => {
  it("syncs an attached project into the self-hosted server workspace", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "caplets-project-binding-state-"));
    dirs.push(stateRoot);
    const workspaces = new ProjectBindingWorkspaceStore({ root: stateRoot });
    const workspace = await workspaces.ensureWorkspace({
      projectFingerprint: "sha256-fixture",
      projectRoot: fixtureProjectRoot,
    });
    const sync = new ManagedMutagenProjectSync({
      runner: async (_command, args) => {
        if (args[0] === "version") return { stdout: "Mutagen version 0.18.1\n", exitCode: 0 };
        if (args[0] === "sync" && args[1] === "create") {
          cpSync(fixtureProjectRoot, workspace.project, { recursive: true });
          return { stdout: "", exitCode: 0 };
        }
        if (args[0] === "sync" && args[1] === "list") {
          return {
            stdout: JSON.stringify([{ name: "caplets-bind_fixture", status: "ready" }]),
            exitCode: 0,
          };
        }
        return { stdout: "", exitCode: 0 };
      },
    });

    await sync.start({
      bindingId: "bind_fixture",
      localProjectRoot: fixtureProjectRoot,
      serverProjectRoot: workspace.project,
    });
    await sync.refresh({ bindingId: "bind_fixture" });

    expect(sync.snapshot()).toMatchObject({ state: "ready", bindingId: "bind_fixture" });
    expect(existsSync(join(workspace.project, "package.json"))).toBe(true);
    expect(readFileSync(join(workspace.project, "build.js"), "utf8")).toContain("process.cwd()");
  });

  it("reclaims a workspace after the server records its binding lease as terminal", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "caplets-project-binding-state-"));
    dirs.push(stateRoot);
    const now = new Date("2026-07-10T12:00:00.000Z");
    const workspaces = new ProjectBindingWorkspaceStore({
      root: stateRoot,
      now: () => now,
      inactiveWorkspaceTtlMs: 0,
    });
    const workspace = await workspaces.ensureWorkspace({
      projectFingerprint: "sha256-terminal",
      projectRoot: fixtureProjectRoot,
      lastActiveAt: now.toISOString(),
    });
    const lease: ProjectBindingLease = {
      bindingId: "bind_terminal",
      projectFingerprint: "sha256-terminal",
      state: "ended",
      active: false,
      updatedAt: now.toISOString(),
      expiresAt: now.toISOString(),
    };
    await workspaces.writeLease(lease);

    await expect(workspaces.cleanup()).resolves.toEqual({
      expiredLeases: [workspace.lease(lease.bindingId)],
      deletedWorkspaces: [workspace.root],
      retainedWorkspaces: [],
    });
    expect(existsSync(workspace.root)).toBe(false);
  });

  it("prunes an expired active restart lease while retaining a nonexpired active lease", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "caplets-project-binding-state-"));
    dirs.push(stateRoot);
    const now = new Date("2026-07-10T12:00:00.000Z");
    const workspaces = new ProjectBindingWorkspaceStore({
      root: stateRoot,
      now: () => now,
      inactiveWorkspaceTtlMs: 0,
    });
    const expired = await workspaces.ensureWorkspace({
      projectFingerprint: "sha256-expired-restart",
      projectRoot: fixtureProjectRoot,
      lastActiveAt: now.toISOString(),
    });
    const active = await workspaces.ensureWorkspace({
      projectFingerprint: "sha256-active-restart",
      projectRoot: fixtureProjectRoot,
      lastActiveAt: now.toISOString(),
    });
    await workspaces.writeLease({
      bindingId: "bind_expired_restart",
      projectFingerprint: "sha256-expired-restart",
      state: "ready",
      active: true,
      updatedAt: now.toISOString(),
      expiresAt: now.toISOString(),
    });
    await workspaces.writeLease({
      bindingId: "bind_active_restart",
      projectFingerprint: "sha256-active-restart",
      state: "ready",
      active: true,
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });

    await expect(workspaces.cleanup()).resolves.toEqual({
      expiredLeases: [expired.lease("bind_expired_restart")],
      deletedWorkspaces: [expired.root],
      retainedWorkspaces: [active.root],
    });
    expect(existsSync(expired.root)).toBe(false);
    await expect(workspaces.listLeases("sha256-active-restart")).resolves.toEqual([
      expect.objectContaining({ bindingId: "bind_active_restart", active: true }),
    ]);
  });

  it("isolates corrupt workspace JSON while reclaiming valid expired leases", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "caplets-project-binding-state-"));
    dirs.push(stateRoot);
    const now = new Date("2026-07-10T12:00:00.000Z");
    const workspaces = new ProjectBindingWorkspaceStore({
      root: stateRoot,
      now: () => now,
      inactiveWorkspaceTtlMs: 0,
    });
    const valid = await workspaces.ensureWorkspace({
      projectFingerprint: "sha256-valid-expired",
      projectRoot: fixtureProjectRoot,
      lastActiveAt: now.toISOString(),
    });
    await workspaces.writeLease({
      bindingId: "bind_valid_expired",
      projectFingerprint: "sha256-valid-expired",
      state: "ended",
      active: false,
      updatedAt: now.toISOString(),
      expiresAt: now.toISOString(),
    });
    const corrupt = await workspaces.ensureWorkspace({
      projectFingerprint: "sha256-corrupt",
      projectRoot: fixtureProjectRoot,
    });
    writeFileSync(corrupt.metadata, "{", "utf8");
    writeFileSync(corrupt.lease("bind_corrupt"), "{", "utf8");

    await expect(workspaces.listLeases("sha256-corrupt")).resolves.toEqual([]);
    await expect(workspaces.cleanup()).resolves.toEqual(
      expect.objectContaining({ expiredLeases: [valid.lease("bind_valid_expired")] }),
    );
    expect(existsSync(valid.root)).toBe(false);
  });

  it("atomically finalizes managed lease writes without leaving temporary entries", async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), "caplets-project-binding-state-"));
    dirs.push(stateRoot);
    const workspaces = new ProjectBindingWorkspaceStore({ root: stateRoot });
    const workspace = await workspaces.ensureWorkspace({
      projectFingerprint: "sha256-atomic",
      projectRoot: fixtureProjectRoot,
    });
    const lease: ProjectBindingLease = {
      bindingId: "bind_atomic",
      projectFingerprint: "sha256-atomic",
      state: "ready",
      active: true,
      updatedAt: "2026-07-10T12:00:00.000Z",
      expiresAt: "2026-07-10T12:01:00.000Z",
    };
    await workspaces.writeLease(lease);
    await workspaces.writeLease({ ...lease, state: "ended", active: false });

    await expect(workspaces.listLeases("sha256-atomic")).resolves.toEqual([
      expect.objectContaining({ bindingId: lease.bindingId, state: "ended", active: false }),
    ]);
    expect(JSON.parse(readFileSync(workspace.lease(lease.bindingId), "utf8"))).toMatchObject({
      state: "ended",
      active: false,
    });
    expect(readdirSync(workspace.leases)).toEqual([`${lease.bindingId}.json`]);
  });

  it("suppresses local overlay duplicates while remote-only Caplets execute remotely", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-project-binding-native-"));
    dirs.push(dir);
    const userDir = join(dir, "user");
    const projectDir = join(dir, "project", ".caplets");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    const configPath = join(userDir, "config.json");
    const projectConfigPath = join(projectDir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        options: { exposure: "progressive_and_code_mode" },
        mcpServers: {
          build: { name: "Local Build", description: "Local build.", command: process.execPath },
        },
      }),
      "utf8",
    );
    writeFileSync(projectConfigPath, JSON.stringify({}), "utf8");
    const remoteClient = remoteClientFixture([
      { name: "build", title: "Remote Build" },
      { name: "deploy", title: "Remote Deploy" },
    ]);
    const service = createNativeCapletsService({
      mode: "remote",
      remote: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => remoteClient),
      configPath,
      projectConfigPath,
    });

    await service.reload();
    expect(configuredCapletTitles(service.listTools())).toEqual([
      ["build", "Remote Build"],
      ["deploy", "Remote Deploy"],
    ]);

    await expect(service.execute("build", { input: true })).resolves.toEqual({
      name: "build",
      args: { input: true },
    });
    await expect(service.execute("deploy", { input: true })).resolves.toEqual({
      name: "deploy",
      args: { input: true },
    });
    expect(remoteClient.callTool).toHaveBeenCalledTimes(2);
    await service.close();
  });
});

function remoteClientFixture(
  tools: Array<{ name: string; title?: string | undefined; description?: string | undefined }>,
): RemoteCapletsClient {
  return {
    listTools: vi.fn(async () => tools),
    callTool: vi.fn(async (name: string, args: unknown) => ({ name, args })),
    onToolsChanged: vi.fn(() => () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function configuredCapletTitles(tools: Array<{ caplet: string; title: string }>): string[][] {
  return tools
    .filter((tool) => tool.caplet !== "code_mode")
    .map((tool) => [tool.caplet, tool.title]);
}
