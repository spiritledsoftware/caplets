import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedMutagenProjectSync } from "../src/project-binding/mutagen";
import { ProjectBindingWorkspaceStore } from "../src/project-binding/workspaces";
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

  it("preserves local overlay shadowing while remote-only Caplets execute remotely", async () => {
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
      server: { url: "http://127.0.0.1:5387" },
      remoteClientFactory: vi.fn(() => remoteClient),
      configPath,
      projectConfigPath,
    });

    await service.reload();
    expect(configuredCapletTitles(service.listTools())).toEqual([
      ["deploy", "Remote Deploy"],
      ["build", "Local Build"],
    ]);

    await expect(service.execute("build", { operation: "inspect" })).resolves.toMatchObject({
      content: expect.any(Array),
    });
    await expect(service.execute("deploy", { input: true })).resolves.toEqual({
      name: "deploy",
      args: { input: true },
    });
    expect(remoteClient.callTool).toHaveBeenCalledTimes(1);
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
  return tools.filter((tool) => tool.caplet !== "run").map((tool) => [tool.caplet, tool.title]);
}
