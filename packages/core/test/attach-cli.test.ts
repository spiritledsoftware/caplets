import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachProjectOnce, resolveAttachOptions } from "../src/project-binding/attach";
import { runCli } from "../src/cli";
import { FileRemoteProfileStore } from "../src/remote/profile-store";

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
    expect(out.join("")).toContain("Usage: caplets attach [options] [url]");
    expect(out.join("")).not.toContain("--transport <transport>");
    expect(out.join("")).not.toContain("--host <host>");
    expect(out.join("")).not.toContain("--port <port>");
    expect(out.join("")).not.toContain("--path <path>");
    expect(out.join("")).not.toContain("--allow-unauthenticated-http");
    expect(out.join("")).not.toContain("--trust-proxy");
    expect(out.join("")).not.toContain("--remote-url <url>");
    expect(out.join("")).toContain("--once");
    expect(out.join("")).not.toContain("--user");
    expect(out.join("")).not.toContain("--password");
    expect(out.join("")).not.toContain("--token");
  });

  it("runs attach as a stdio MCP server by default", async () => {
    const served: unknown[] = [];
    const authDir = tempAuthDir();
    await saveRemoteProfileFixture(authDir, "https://caplets.example.com");
    await runCli(["attach"], {
      authDir,
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_REMOTE_URL: "https://caplets.example.com",
      },
      attachServe: async (options: unknown) => {
        served.push(options);
      },
    } as never);

    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({
      transport: "stdio",
      authDir,
      selection: { kind: "remote" },
    });
  });

  it("rejects removed attach credential flags", async () => {
    await expect(
      runCli(["attach", "--remote-url", "https://caplets.example.com", "--user", "alice"], {
        env: { CAPLETS_MODE: "remote" },
        attachServe: async () => undefined,
      } as never),
    ).rejects.toThrow(/unknown option '--user'/u);
  });

  it.each([
    ["--transport", "http"],
    ["--transport", "stdio"],
    ["--host", "127.0.0.1"],
    ["--port", "5387"],
    ["--allow-unauthenticated-http"],
    ["--trust-proxy"],
  ])("rejects attach HTTP serving flag %s", async (...flag: string[]) => {
    await expect(
      runCli(["attach", "https://caplets.example.com", ...flag], {
        env: { CAPLETS_MODE: "remote" },
        attachServe: async () => undefined,
      } as never),
    ).rejects.toThrow(
      /caplets attach is stdio-only.*caplets serve --transport http --upstream-url/u,
    );
  });

  it("does not register the removed --path option", async () => {
    await expect(
      runCli(["attach", "https://caplets.example.com", "--path", "/caplets"], {
        env: { CAPLETS_MODE: "remote" },
        attachServe: async () => undefined,
      } as never),
    ).rejects.toThrow(/unknown option '--path'/u);
  });

  it("passes local overlay config paths into attach serving", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-attach-config-"));
    tempDirs.push(dir);
    const configPath = join(dir, "local.json");
    const projectConfigPath = join(dir, "project.json");
    const served: unknown[] = [];
    const authDir = tempAuthDir();
    await saveRemoteProfileFixture(authDir, "https://caplets.example.com");

    await runCli(["attach", "--remote-url", "https://caplets.example.com"], {
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

  it("accepts the remote URL as the primary positional attach argument", async () => {
    const served: unknown[] = [];
    const authDir = tempAuthDir();
    await saveRemoteProfileFixture(authDir, "https://caplets.example.com");

    await runCli(["attach", "https://caplets.example.com"], {
      authDir,
      env: { CAPLETS_MODE: "remote" },
      attachServe: async (options: unknown) => {
        served.push(options);
      },
    } as never);

    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({
      selection: {
        kind: "remote",
        remote: { baseUrl: new URL("https://caplets.example.com") },
      },
    });
  });

  it("rejects conflicting positional and legacy attach remote URLs", async () => {
    await expect(
      runCli(
        ["attach", "https://caplets.example.com", "--remote-url", "https://other.example.com"],
        {
          env: { CAPLETS_MODE: "remote" },
          attachServe: async () => undefined,
        } as never,
      ),
    ).rejects.toThrow(/Pass either attach URL or --remote-url, not both/u);
  });

  it("uses attach --project-root for the default local overlay project config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-attach-project-root-"));
    tempDirs.push(dir);
    const projectRoot = join(dir, "checkout");
    const configPath = join(dir, "local.json");
    const served: unknown[] = [];
    const authDir = tempAuthDir();
    await saveRemoteProfileFixture(authDir, "https://caplets.example.com");

    await runCli(
      ["attach", "--remote-url", "https://caplets.example.com", "--project-root", projectRoot],
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
    const projectRoot = tempProjectRoot();
    writeFileSync(join(projectRoot, "project-file.txt"), "bound root file\n");
    await saveRemoteProfileFixture(authDir, "https://caplets.example.com", "profile-token");
    const resolved = await resolveAttachOptions(
      {
        remoteUrl: "https://caplets.example.com",
        once: true,
        projectRoot,
        authDir,
      },
      { CAPLETS_REMOTE_URL: "https://env.example.com" },
    );

    expect(resolved).toMatchObject({
      projectRoot,
      once: true,
      remote: {
        baseUrl: new URL("https://caplets.example.com"),
        auth: { type: "bearer", token: "profile-token" },
      },
    });
    expect(resolved.syncPolicy.totalBytes).toBeGreaterThan(0);
  });

  it("reports WebSocket upgrade failures clearly in once mode", async () => {
    const authDir = tempAuthDir();
    await saveRemoteProfileFixture(authDir, "https://caplets.example.com");
    await expect(
      attachProjectOnce({
        projectRoot: "/repo",
        remoteUrl: "https://caplets.example.com",
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
    await saveRemoteProfileFixture(authDir, "http://127.0.0.1:8787");

    await expect(
      attachProjectOnce({
        projectRoot: "/repo",
        remoteUrl: "http://127.0.0.1:8787",
        authDir,
        fetch: async (url) => {
          requestedUrl = String(url);
          return Response.json({ error: "websocket_upgrade_required" }, { status: 426 });
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      webSocketUrl: "ws://127.0.0.1:8787/api/v1/attach/project-bindings/connect",
    });
    expect(requestedUrl).toBe("http://127.0.0.1:8787/api/v1/attach/project-bindings/connect");
  });

  it("treats a former Cloud hostname as an ordinary Current Host origin", async () => {
    const authDir = tempAuthDir();
    await saveRemoteProfileFixture(authDir, "https://cloud.pr-2.preview.caplets.dev");
    let requestedUrl: string | undefined;

    await expect(
      attachProjectOnce(
        {
          authDir,
          projectRoot: "/repo",
          remoteUrl: "https://cloud.pr-2.preview.caplets.dev",
          fetch: async (url) => {
            requestedUrl = String(url);
            return Response.json({ error: "websocket_upgrade_required" }, { status: 426 });
          },
        },
        { CAPLETS_MODE: "remote" },
      ),
    ).resolves.toMatchObject({
      ok: true,
      webSocketUrl: "wss://cloud.pr-2.preview.caplets.dev/api/v1/attach/project-bindings/connect",
    });
    expect(requestedUrl).toBe(
      "https://cloud.pr-2.preview.caplets.dev/api/v1/attach/project-bindings/connect",
    );
  });

  it("runs once from the CLI and reports WebSocket availability", async () => {
    const out: string[] = [];
    const cwd = process.cwd();
    const projectRoot = tempProjectRoot();

    try {
      process.chdir(projectRoot);
      const authDir = tempAuthDir();
      await saveRemoteProfileFixture(authDir, "https://caplets.example.com");

      await runCli(["attach", "https://caplets.example.com", "--once"], {
        authDir,
        fetch: async () => Response.json({ error: "websocket_upgrade_required" }, { status: 426 }),
        writeOut: (value) => out.push(value),
      });
    } finally {
      process.chdir(cwd);
    }

    expect(out.join("")).toContain(
      "Project Binding available at wss://caplets.example.com/api/v1/attach/project-bindings/connect.",
    );
  });

  it("prints structured JSON for CLI WebSocket failures", async () => {
    const out: string[] = [];
    let exitCode = 0;
    const cwd = process.cwd();
    const projectRoot = tempProjectRoot();

    try {
      process.chdir(projectRoot);
      const authDir = tempAuthDir();
      await saveRemoteProfileFixture(authDir, "https://caplets.example.com");

      await runCli(["attach", "--remote-url", "https://caplets.example.com", "--once", "--json"], {
        authDir,
        fetch: async () => new Response("upgrade blocked", { status: 426 }),
        writeOut: (value) => out.push(value),
        setExitCode: (code) => {
          exitCode = code;
        },
      });
    } finally {
      process.chdir(cwd);
    }

    expect(exitCode).toBe(1);
    expect(JSON.parse(out.join(""))).toMatchObject({
      ok: false,
      error: { code: "PROJECT_BINDING_WEBSOCKET_UNAVAILABLE" },
    });
  });

  it("prints JSON recovery for revoked Remote Profile credentials", async () => {
    const authDir = tempAuthDir();
    const out: string[] = [];
    let exitCode = 0;
    await new FileRemoteProfileStore({
      root: join(authDir, "remote-profiles"),
    }).saveRemoteProfile({
      origin: "https://caplets.example.com",
      clientId: "rcli_123",
      clientLabel: "Test Device",
      credentials: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: "2026-06-19T00:00:00.000Z",
      },
    });

    await runCli(["attach", "--once", "--json"], {
      authDir,
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_REMOTE_URL: "https://caplets.example.com",
      },
      fetch: async () =>
        Response.json(
          { error: { code: "AUTH_FAILED", message: "Remote client credential has been revoked." } },
          { status: 401 },
        ),
      writeOut: (value) => out.push(value),
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(out.join(""))).toMatchObject({
      error: {
        code: "remote_credentials_revoked",
        recoveryCommand: "caplets remote login https://caplets.example.com",
      },
    });
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

async function saveRemoteProfileFixture(
  authDir: string,
  origin: string,
  accessToken = "profile-access-token",
): Promise<void> {
  await new FileRemoteProfileStore({
    root: join(authDir, "remote-profiles"),
  }).saveRemoteProfile({
    origin,
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
