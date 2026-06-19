import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachProjectOnce, resolveAttachOptions } from "../src/project-binding/attach";
import { runCli } from "../src/cli";
import { CloudAuthStore } from "../src/cloud-auth/store";
import { FileRemoteProfileStore } from "../src/remote/profile-store";
import { hostedCredentials, tempCloudAuthPath } from "./fixtures/cloud-auth";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("caplets attach CLI", () => {
  it("shows attach help", async () => {
    const out: string[] = [];

    await runCli(["attach", "--help"], { writeOut: (value) => out.push(value) });

    expect(out.join("")).toContain("Start a remote-backed Caplets MCP server.");
    expect(out.join("")).toContain("--transport <transport>");
    expect(out.join("")).toContain("--remote-url <url>");
    expect(out.join("")).toContain("--workspace <workspace>");
    expect(out.join("")).toContain("--once");
  });

  it("runs attach as a stdio MCP server by default", async () => {
    const served: unknown[] = [];
    const authDir = tempAuthDir();
    await saveSelfHostedProfile(authDir, "https://caplets.example.com/caplets");
    await runCli(["attach"], {
      authDir,
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_REMOTE_URL: "https://caplets.example.com/caplets",
      },
      attachServe: async (options: unknown) => {
        served.push(options);
      },
    } as never);

    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({
      transport: "stdio",
      selection: { kind: "self_hosted_remote" },
    });
  });

  it("ignores legacy attach Basic Auth flags and uses the stored Remote Profile", async () => {
    const served: unknown[] = [];
    const authDir = tempAuthDir();
    await saveSelfHostedProfile(authDir, "https://caplets.example.com/caplets", "profile-token");
    await runCli(
      [
        "attach",
        "--remote-url",
        "https://caplets.example.com/caplets",
        "--user",
        "alice",
        "--password",
        "secret",
      ],
      {
        authDir,
        env: { CAPLETS_MODE: "remote" },
        attachServe: async (options: unknown) => {
          served.push(options);
        },
      } as never,
    );

    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({
      transport: "stdio",
      selection: {
        remote: {
          auth: { type: "bearer", token: "profile-token" },
        },
      },
    });
  });

  it("passes local overlay config paths into attach serving", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-attach-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "local.json");
    const projectConfigPath = join(dir, "project.json");
    const served: unknown[] = [];
    const authDir = tempAuthDir();
    await saveSelfHostedProfile(authDir, "https://caplets.example.com/caplets");

    await runCli(["attach", "--remote-url", "https://caplets.example.com/caplets"], {
      authDir,
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_CONFIG: configPath,
        CAPLETS_PROJECT_CONFIG: projectConfigPath,
      },
      attachServe: async (options: unknown) => {
        served.push(options);
      },
    } as never);

    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({
      configPath,
      projectConfigPath,
    });
  });

  it("uses attach --project-root for the default local overlay project config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-attach-project-root-"));
    tempDirs.push(dir);
    const projectRoot = join(dir, "checkout");
    const configPath = join(dir, "local.json");
    const served: unknown[] = [];
    const authDir = tempAuthDir();
    await saveSelfHostedProfile(authDir, "https://caplets.example.com/caplets");

    await runCli(
      [
        "attach",
        "--remote-url",
        "https://caplets.example.com/caplets",
        "--project-root",
        projectRoot,
      ],
      {
        authDir,
        env: {
          CAPLETS_MODE: "remote",
          CAPLETS_CONFIG: configPath,
        },
        attachServe: async (options: unknown) => {
          served.push(options);
        },
      } as never,
    );

    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({
      configPath,
      projectRoot,
      projectConfigPath: join(projectRoot, ".caplets", "config.json"),
    });
  });

  it("rejects attach server in local mode", async () => {
    await expect(
      runCli(["attach"], {
        env: { CAPLETS_MODE: "local" },
        attachServe: async () => undefined,
      } as never),
    ).rejects.toThrow(/use caplets serve for local-only MCP/u);
  });

  it("resolves attach options from flags, env, and the caller cwd", async () => {
    const authDir = tempAuthDir();
    await saveSelfHostedProfile(authDir, "https://caplets.example.com/caplets", "profile-token");
    const resolved = await resolveAttachOptions(
      {
        remoteUrl: "https://caplets.example.com/caplets",
        workspace: "workspace",
        once: true,
        projectRoot: "/repo",
        authDir,
      },
      { CAPLETS_REMOTE_URL: "https://env.example.com" },
    );

    expect(resolved).toMatchObject({
      projectRoot: "/repo",
      once: true,
      remote: {
        baseUrl: new URL("https://caplets.example.com/caplets"),
        workspace: "workspace",
        auth: { type: "bearer", token: "profile-token" },
      },
    });
  });

  it("reports WebSocket upgrade failures clearly in once mode", async () => {
    const authDir = tempAuthDir();
    await saveSelfHostedProfile(authDir, "https://caplets.example.com/caplets");
    await expect(
      attachProjectOnce({
        projectRoot: "/repo",
        remoteUrl: "https://caplets.example.com/caplets",
        authDir,
        fetch: async () => new Response("upgrade blocked", { status: 426 }),
      }),
    ).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
      message: expect.stringContaining("Project Binding WebSocket unavailable"),
    });
  });

  it("probes the HTTP equivalent of the Project Binding WebSocket URL", async () => {
    let requestedUrl: string | undefined;
    const authDir = tempAuthDir();
    await saveSelfHostedProfile(authDir, "http://127.0.0.1:8787/caplets");

    await expect(
      attachProjectOnce({
        projectRoot: "/repo",
        remoteUrl: "http://127.0.0.1:8787/caplets",
        authDir,
        fetch: async (url) => {
          requestedUrl = String(url);
          return Response.json({ error: "websocket_upgrade_required" }, { status: 426 });
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      webSocketUrl: "ws://127.0.0.1:8787/caplets/v1/attach/project-bindings/connect",
    });
    expect(requestedUrl).toBe("http://127.0.0.1:8787/caplets/v1/attach/project-bindings/connect");
  });

  it("probes the Cloud control route when given a copied Cloud MCP endpoint", async () => {
    const path = tempCloudAuthPath();
    await new CloudAuthStore({ path }).save(
      hostedCredentials({
        cloudUrl: "https://cloud.pr-2.preview.caplets.dev",
        workspaceSlug: "personal-c9b49d",
      }),
    );
    let requestedUrl: string | undefined;

    await expect(
      attachProjectOnce(
        {
          projectRoot: "/repo",
          remoteUrl: "https://cloud.pr-2.preview.caplets.dev/ws/personal-c9b49d/mcp",
          fetch: async (url) => {
            requestedUrl = String(url);
            expect(String(url)).not.toContain("/ws/personal-c9b49d/api/project-bindings");
            return Response.json({ error: "websocket_upgrade_required" }, { status: 426 });
          },
        },
        {
          CAPLETS_MODE: "cloud",
          CAPLETS_CLOUD_AUTH_PATH: path,
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      webSocketUrl:
        "wss://cloud.pr-2.preview.caplets.dev/v1/ws/personal-c9b49d/attach/project-bindings/connect",
    });
    expect(requestedUrl).toBe(
      "https://cloud.pr-2.preview.caplets.dev/v1/ws/personal-c9b49d/attach/project-bindings/connect",
    );
  });

  it("runs once from the CLI and reports WebSocket availability", async () => {
    const out: string[] = [];
    const cwd = process.cwd();
    const projectRoot = tempProjectRoot();

    try {
      process.chdir(projectRoot);
      const authDir = tempAuthDir();
      await saveSelfHostedProfile(authDir, "https://caplets.example.com/caplets");

      await runCli(["attach", "--remote-url", "https://caplets.example.com/caplets", "--once"], {
        authDir,
        fetch: async () => Response.json({ error: "websocket_upgrade_required" }, { status: 426 }),
        writeOut: (value) => out.push(value),
      });
    } finally {
      process.chdir(cwd);
    }

    expect(out.join("")).toContain(
      "Project Binding available at wss://caplets.example.com/caplets/v1/attach/project-bindings/connect.",
    );
  });

  it("keeps attach --once as the finite Project Binding smoke path", async () => {
    const out: string[] = [];
    const authDir = tempAuthDir();
    await saveSelfHostedProfile(authDir, "https://caplets.example.com/caplets");
    await runCli(["attach", "--once", "--remote-url", "https://caplets.example.com/caplets"], {
      authDir,
      fetch: async () => Response.json({ error: "websocket_upgrade_required" }, { status: 426 }),
      writeOut: (value) => out.push(value),
    });
    expect(out.join("")).toContain("Project Binding available at");
  });

  it("prints structured JSON for CLI WebSocket failures", async () => {
    const out: string[] = [];
    let exitCode = 0;
    const cwd = process.cwd();
    const projectRoot = tempProjectRoot();

    try {
      process.chdir(projectRoot);
      const authDir = tempAuthDir();
      await saveSelfHostedProfile(authDir, "https://caplets.example.com/caplets");

      await runCli(
        ["attach", "--remote-url", "https://caplets.example.com/caplets", "--once", "--json"],
        {
          authDir,
          fetch: async () => new Response("upgrade blocked", { status: 426 }),
          writeOut: (value) => out.push(value),
          setExitCode: (code) => {
            exitCode = code;
          },
        },
      );
    } finally {
      process.chdir(cwd);
    }

    expect(exitCode).toBe(1);
    expect(JSON.parse(out.join(""))).toMatchObject({
      ok: false,
      error: { code: "PROJECT_BINDING_WEBSOCKET_UNAVAILABLE" },
    });
  });

  it("prints JSON error for attach --once when cloud auth is missing", async () => {
    const out: string[] = [];
    let exitCode = 0;
    await runCli(["attach", "--once", "--json"], {
      env: {
        CAPLETS_MODE: "cloud",
        CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
        CAPLETS_CLOUD_AUTH_PATH: tempCloudAuthPath(),
      },
      writeOut: (value) => out.push(value),
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(out.join(""))).toMatchObject({
      error: {
        code: "cloud_auth_required",
        recoveryCommand: "caplets cloud auth login",
      },
    });
  });

  it("rejects attach --workspace when it differs from the saved Selected Workspace", async () => {
    const path = tempCloudAuthPath();
    const out: string[] = [];
    let exitCode = 0;
    await new CloudAuthStore({ path }).save(hostedCredentials({ workspaceSlug: "personal" }));

    await runCli(["attach", "--workspace", "team", "--once", "--json", "--project-root", "/repo"], {
      env: {
        CAPLETS_MODE: "cloud",
        CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
        CAPLETS_CLOUD_AUTH_PATH: path,
      },
      writeOut: (value) => out.push(value),
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(out[0] ?? "{}")).toMatchObject({
      error: {
        code: "workspace_switch_required",
        recoveryCommand: "caplets cloud auth switch <workspace>",
      },
    });
  });

  it("does not print a first-time project sync approval prompt", async () => {
    const path = tempCloudAuthPath();
    const out: string[] = [];
    await new CloudAuthStore({ path }).save(hostedCredentials());

    await runCli(["attach", "--once", "--json", "--project-root", "/repo"], {
      env: {
        CAPLETS_MODE: "cloud",
        CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
        CAPLETS_CLOUD_AUTH_PATH: path,
      },
      fetch: async () => Response.json({ error: "websocket_upgrade_required" }, { status: 426 }),
      writeOut: (value) => out.push(value),
    });

    expect(out.join("")).not.toMatch(/approve|approval|confirm/i);
  });
});

function tempProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "caplets-attach-cli-"));
  tempDirs.push(root);
  return root;
}

function tempAuthDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "caplets-attach-auth-"));
  tempDirs.push(dir);
  return dir;
}

async function saveSelfHostedProfile(
  authDir: string,
  hostUrl: string,
  accessToken = "profile-access-token",
): Promise<void> {
  await new FileRemoteProfileStore({
    root: join(authDir, "remote-profiles"),
  }).saveSelfHostedProfile({
    hostUrl,
    clientId: "rcli_123",
    clientLabel: "Test Device",
    credentials: {
      accessToken,
      refreshToken: "profile-refresh-token",
      tokenType: "Bearer",
      expiresAt: "2999-01-01T00:00:00.000Z",
    },
  });
}
