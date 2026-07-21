import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachProjectOnce,
  attachProjectSession,
  resolveAttachOptions,
} from "../src/project-binding/attach";
import { runCli } from "../src/cli";
import { CloudAuthStore } from "../src/cloud-auth/store";
import { FileRemoteProfileStore } from "../src/remote/profile-store";
import type {
  ProjectBindingSocketEvent,
  ProjectBindingWebSocket,
} from "@caplets/sdk/project-binding";
import { hostedCredentials, tempCloudAuthPath } from "./fixtures/cloud-auth";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.useRealTimers();
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
    expect(out.join("")).toContain("--workspace <workspace>");
    expect(out.join("")).toContain("--once");
    expect(out.join("")).not.toContain("--user");
    expect(out.join("")).not.toContain("--password");
    expect(out.join("")).not.toContain("--token");
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
      authDir,
      selection: { kind: "self_hosted_remote" },
    });
  });

  it("rejects removed attach credential flags", async () => {
    await expect(
      runCli(["attach", "--remote-url", "https://caplets.example.com/caplets", "--user", "alice"], {
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
    ["--path", "/caplets"],
    ["--allow-unauthenticated-http"],
    ["--trust-proxy"],
  ])("rejects attach HTTP serving flag %s", async (...flag: string[]) => {
    await expect(
      runCli(["attach", "https://caplets.example.com/caplets", ...flag], {
        env: { CAPLETS_MODE: "remote" },
        attachServe: async () => undefined,
      } as never),
    ).rejects.toThrow(
      /caplets attach is stdio-only.*caplets serve --transport http --upstream-url/u,
    );
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

  it("accepts the remote URL as the primary positional attach argument", async () => {
    const served: unknown[] = [];
    const authDir = tempAuthDir();
    await saveSelfHostedProfile(authDir, "https://caplets.example.com/caplets");

    await runCli(["attach", "https://caplets.example.com/caplets"], {
      authDir,
      env: { CAPLETS_MODE: "remote" },
      attachServe: async (options: unknown) => {
        served.push(options);
      },
    } as never);

    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({
      selection: {
        kind: "self_hosted_remote",
        remote: { baseUrl: new URL("https://caplets.example.com/caplets") },
      },
    });
  });

  it("rejects conflicting positional and legacy attach remote URLs", async () => {
    await expect(
      runCli(
        [
          "attach",
          "https://caplets.example.com/caplets",
          "--remote-url",
          "https://other.example.com/caplets",
        ],
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
    const projectRoot = tempProjectRoot();
    writeFileSync(join(projectRoot, "project-file.txt"), "bound root file\n");
    await saveSelfHostedProfile(authDir, "https://caplets.example.com/caplets", "profile-token");
    const resolved = await resolveAttachOptions(
      {
        remoteUrl: "https://caplets.example.com/caplets",
        workspace: "workspace",
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
        baseUrl: new URL("https://caplets.example.com/caplets"),
        workspace: "workspace",
        auth: { type: "bearer", token: "profile-token" },
      },
    });
    expect(resolved.syncPolicy.totalBytes).toBeGreaterThan(0);
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

  it("pins the selected Cloud workspace and uses the fixed 15-second heartbeat", async () => {
    vi.useFakeTimers();
    const authDir = tempAuthDir();
    const store = new FileRemoteProfileStore({ root: join(authDir, "remote-profiles") });
    await store.saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev",
      workspaceId: "workspace_team",
      workspaceSlug: "team",
      credentials: {
        accessToken: "team-access",
        refreshToken: "team-refresh",
        expiresAt: "2999-01-01T00:00:00.000Z",
        scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
        tokenType: "Bearer",
      },
    });
    const controller = new AbortController();
    const requests: Array<{ path: string; body?: unknown }> = [];
    let switchedSelection = false;
    let projectFingerprint = "";
    let heartbeatEvents = 0;
    let resolveFirstHeartbeat!: () => void;
    const firstHeartbeat = new Promise<void>((resolve) => {
      resolveFirstHeartbeat = resolve;
    });
    const binding = () => ({
      bindingId: "binding_1",
      state: "attaching" as const,
      syncState: "pending" as const,
      projectFingerprint,
      serverProjectRoot: "/srv/repo",
      updatedAt: "2026-07-20T12:00:00.000Z",
      expiresAt: "2026-07-20T12:01:00.000Z",
    });

    const socket = new OpenProjectBindingSocket();
    const session = attachProjectSession(
      {
        authDir,
        remoteUrl: "https://cloud.caplets.dev",
        projectRoot: "/repo",
        fetch: async (input, init) => {
          const request = input instanceof Request ? input : new Request(input, init);
          const path = new URL(request.url).pathname;
          const body =
            request.method === "GET"
              ? undefined
              : await request
                  .clone()
                  .json()
                  .catch(() => undefined);
          requests.push({ path, ...(body !== undefined ? { body } : {}) });
          if (path.endsWith("/project-bindings/sessions")) {
            projectFingerprint =
              typeof body === "object" &&
              body !== null &&
              "projectFingerprint" in body &&
              typeof body.projectFingerprint === "string"
                ? body.projectFingerprint
                : "";
            if (!switchedSelection) {
              switchedSelection = true;
              await store.saveCloudProfile({
                hostUrl: "https://cloud.caplets.dev",
                workspaceId: "workspace_personal",
                workspaceSlug: "personal",
                credentials: {
                  accessToken: "personal-access",
                  refreshToken: "personal-refresh",
                  expiresAt: "2999-01-01T00:00:00.000Z",
                  scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
                  tokenType: "Bearer",
                },
              });
            }
            return Response.json({ binding: binding(), sessionId: "session_1" }, { status: 201 });
          }
          if (path.endsWith("/heartbeat")) {
            return Response.json({ ok: true, binding: binding() });
          }
          return Response.json({ ok: true, binding: binding() });
        },
      },
      { CAPLETS_MODE: "cloud" },
      {
        signal: controller.signal,
        webSocketFactory: () => socket,
        onEvent: (event) => {
          if (event.type !== "heartbeat") return;
          heartbeatEvents += 1;
          if (heartbeatEvents === 1) resolveFirstHeartbeat();
          if (heartbeatEvents === 2) socket.receiveEnded();
        },
      },
    );

    await firstHeartbeat;
    expect(requests.filter((request) => request.path.endsWith("/heartbeat"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(requests.filter((request) => request.path.endsWith("/heartbeat"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(session).resolves.toMatchObject({ ok: true, ended: true });

    expect(requests.filter((request) => request.path.endsWith("/heartbeat"))).toHaveLength(2);
    expect(requests.map((request) => request.path)).toEqual(
      expect.arrayContaining([
        "/v1/ws/team/attach/project-bindings/sessions",
        "/v1/ws/team/attach/project-bindings/binding_1/heartbeat",
      ]),
    );
    expect(requests.map((request) => request.path).join("\n")).not.toContain("/ws/personal/");
  });

  it("runs once from the CLI and reports WebSocket availability", async () => {
    const out: string[] = [];
    const cwd = process.cwd();
    const projectRoot = tempProjectRoot();

    try {
      process.chdir(projectRoot);
      const authDir = tempAuthDir();
      await saveSelfHostedProfile(authDir, "https://caplets.example.com/caplets");

      await runCli(["attach", "https://caplets.example.com/caplets", "--once"], {
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
        recoveryCommand: "caplets remote login <cloud-url>",
      },
    });
  });

  it("prints JSON recovery for revoked self-hosted credentials", async () => {
    const authDir = tempAuthDir();
    const out: string[] = [];
    let exitCode = 0;
    await new FileRemoteProfileStore({
      root: join(authDir, "remote-profiles"),
    }).saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com/caplets",
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
        CAPLETS_REMOTE_URL: "https://caplets.example.com/caplets",
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
        recoveryCommand: "caplets remote login https://caplets.example.com/caplets",
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
        recoveryCommand: "caplets remote login <cloud-url> --workspace <workspace>",
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

class OpenProjectBindingSocket implements ProjectBindingWebSocket {
  readonly readyState = 1;
  onopen: ((event: ProjectBindingSocketEvent) => void) | null = null;
  onmessage: ((event: ProjectBindingSocketEvent) => void) | null = null;
  onclose: ((event: ProjectBindingSocketEvent) => void) | null = null;
  onerror: ((event: ProjectBindingSocketEvent) => void) | null = null;

  send(data: string): void {
    const message = JSON.parse(data) as { type?: string; reason?: unknown };
    if (message.type === "end") {
      queueMicrotask(() => {
        this.onmessage?.({
          data: JSON.stringify({ type: "ended", reason: message.reason }),
        });
      });
    }
  }

  receiveEnded(): void {
    this.onmessage?.({
      data: JSON.stringify({
        type: "ended",
        reason: { code: "completed", message: "Session completed." },
      }),
    });
  }

  close(): void {}
}
