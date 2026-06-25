import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CloudAuthStore } from "../src/cloud-auth/store";
import { runCli } from "../src/cli";
import { doctorJsonReport } from "../src/cli/doctor";
import { hostedCredentials, tempCloudAuthPath } from "./fixtures/cloud-auth";
import { FileRemoteProfileStore } from "../src/remote/profile-store";

describe("caplets doctor", () => {
  it("shows sectioned local diagnostics without stale presence wording", async () => {
    const out: string[] = [];

    await runCli(["doctor"], {
      env: {},
      writeOut: (value) => out.push(value),
    });

    const report = out.join("");
    expect(report).toContain("Server hosting");
    expect(report).toContain("Remote client");
    expect(report).toContain("Project Binding");
    expect(report).toContain("Project sync");
    expect(report).toContain("Daemon");
    expect(report).toContain("Remote Login");
    expect(report).toContain("Exposure");
    expect(report).toContain("Code Mode");
    expect(report).not.toContain("local presence");
  });

  it("shows remote client derived URLs without env-token auth", async () => {
    const out: string[] = [];

    await runCli(["doctor"], {
      env: {
        CAPLETS_REMOTE_URL: "https://cloud.caplets.dev/ws/ian",
        CAPLETS_REMOTE_WORKSPACE: "ws_1",
      },
      writeOut: (value) => out.push(value),
    });

    const report = out.join("");
    expect(report).toContain("MCP URL: https://cloud.caplets.dev/v1/ws/ian/mcp");
    expect(report).toContain("Control URL: https://cloud.caplets.dev/v1/admin");
    expect(report).toContain("Health URL: https://cloud.caplets.dev/v1/healthz");
    expect(report).toContain(
      "WebSocket URL: wss://cloud.caplets.dev/v1/ws/ian/attach/project-bindings/connect",
    );
    expect(report).toContain("Auth: none");
    expect(report).toContain("Remote Login");
  });

  it("uses saved Cloud Auth workspace for bare hosted Cloud remote URLs", async () => {
    const path = tempCloudAuthPath();
    await new CloudAuthStore({ path }).save(
      hostedCredentials({
        accessToken: "cloud-access",
        workspaceSlug: "personal-c9b49d",
      }),
    );
    const out: string[] = [];

    await runCli(["doctor", "--json"], {
      env: {
        CAPLETS_MODE: "cloud",
        CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
        CAPLETS_CLOUD_AUTH_PATH: path,
      },
      writeOut: (value) => out.push(value),
    });

    expect(JSON.parse(out.join(""))).toMatchObject({
      remote: {
        configured: true,
        mcpUrl: "https://cloud.caplets.dev/v1/ws/personal-c9b49d/mcp",
        webSocketUrl:
          "wss://cloud.caplets.dev/v1/ws/personal-c9b49d/attach/project-bindings/connect",
        auth: "bearer",
        tokenPresent: true,
        workspace: "personal-c9b49d",
      },
      remoteLogin: {
        configured: true,
        authenticated: true,
        kind: "cloud",
        hostUrl: "https://cloud.caplets.dev/",
        workspaceSlug: "personal-c9b49d",
      },
    });
  });

  it("reports ambiguous Cloud Remote Profiles instead of throwing", async () => {
    const path = tempCloudAuthPath();
    const authDir = dirname(path);
    const store = new FileRemoteProfileStore({ root: `${authDir}/remote-profiles` });
    await store.saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev",
      workspaceId: "workspace_team",
      workspaceSlug: "team",
      credentials: {
        accessToken: "cloud-access",
        refreshToken: "cloud-refresh",
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
    });
    await store.clearSelectedCloudWorkspace("https://cloud.caplets.dev");
    const out: string[] = [];

    await runCli(["doctor", "--json"], {
      env: {
        CAPLETS_MODE: "cloud",
        CAPLETS_REMOTE_URL: "https://cloud.caplets.dev",
        CAPLETS_CLOUD_AUTH_PATH: path,
      },
      writeOut: (value) => out.push(value),
    });

    expect(JSON.parse(out.join(""))).toMatchObject({
      remoteLogin: {
        configured: true,
        authenticated: false,
        kind: "cloud",
        hostUrl: "https://cloud.caplets.dev/",
        error: "Cloud Remote Profile requires a selected or explicit workspace.",
      },
      projectBinding: {
        authMode: "remote_login_required",
      },
    });
  });

  it("reports malformed Remote Login URLs instead of throwing", async () => {
    const out: string[] = [];

    await runCli(["doctor", "--json"], {
      env: {
        CAPLETS_MODE: "remote",
        CAPLETS_REMOTE_URL: "http://example.com",
      },
      writeOut: (value) => out.push(value),
    });

    expect(JSON.parse(out.join(""))).toMatchObject({
      remoteLogin: {
        configured: true,
        authenticated: false,
        kind: "self-hosted",
        error: expect.any(String),
      },
    });
  });

  it("does not recommend Project Binding recovery for authenticated self-hosted remotes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-doctor-self-hosted-"));
    const authDir = join(dir, "auth");
    const out: string[] = [];
    try {
      await new FileRemoteProfileStore({
        root: join(authDir, "remote-profiles"),
      }).saveSelfHostedProfile({
        hostUrl: "http://127.0.0.1:5387",
        clientId: "rcli_test",
        credentials: {
          accessToken: "remote-access",
          refreshToken: "remote-refresh",
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
      });

      await runCli(["doctor"], {
        authDir,
        env: {
          CAPLETS_MODE: "remote",
          CAPLETS_REMOTE_URL: "http://127.0.0.1:5387",
          XDG_STATE_HOME: join(dir, "state"),
        },
        writeOut: (value) => out.push(value),
      });

      const report = out.join("");
      expect(report).toContain("Auth mode: self_hosted_remote");
      expect(report).toContain("Session support: unsupported");
      expect(report).toContain(
        "Recovery: Self-hosted Project Binding sessions are not implemented by this runtime.",
      );
      expect(report).not.toContain("Recovery: caplets attach --once");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports unresolved local Vault references with repair commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-doctor-vault-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    const plainOut: string[] = [];
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            github: {
              name: "GitHub",
              description: "GitHub tools.",
              command: "github-mcp",
              env: { GH_TOKEN: "$vault:GH_TOKEN" },
            },
          },
        }),
      );

      await runCli(["doctor", "--json"], {
        env: {
          CAPLETS_CONFIG: configPath,
          XDG_STATE_HOME: join(dir, "state"),
        },
        writeOut: (value) => out.push(value),
      });

      const report = JSON.parse(out.join(""));
      expect(report.vault).toMatchObject({
        ok: false,
        issues: [
          expect.objectContaining({
            key: "GH_TOKEN",
            capletId: "github",
            target: "global",
            recoveryCommand: "caplets vault access grant GH_TOKEN github",
          }),
        ],
      });
      expect(JSON.stringify(report.vault)).not.toContain("secret");

      await runCli(["doctor"], {
        env: {
          CAPLETS_CONFIG: configPath,
          XDG_STATE_HOME: join(dir, "state"),
        },
        writeOut: (value) => plainOut.push(value),
      });
      expect(plainOut.join("")).toContain(
        "github: ungranted GH_TOKEN (caplets vault access grant GH_TOKEN github)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors DoctorOptions.cwd when checking project Vault references", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-doctor-cwd-"));
    const configPath = join(dir, "config.json");
    const projectRoot = join(dir, "project");
    const projectCapletDir = join(projectRoot, ".caplets", "github");
    try {
      mkdirSync(projectCapletDir, { recursive: true });
      writeFileSync(configPath, "{}");
      writeFileSync(
        join(projectCapletDir, "CAPLET.md"),
        [
          "---",
          "name: GitHub",
          "description: GitHub tools.",
          "mcpServer:",
          "  transport: http",
          "  url: https://api.githubcopilot.com/mcp",
          "  auth:",
          "    type: bearer",
          "    token: $vault:GH_TOKEN",
          "---",
          "",
          "# GitHub",
          "",
        ].join("\n"),
      );

      const report = await doctorJsonReport({
        cwd: projectRoot,
        env: {
          CAPLETS_CONFIG: configPath,
          XDG_STATE_HOME: join(dir, "state"),
        },
      });

      expect(report.vault).toMatchObject({
        ok: false,
        issues: [
          expect.objectContaining({
            capletId: "github",
            key: "GH_TOKEN",
            recoveryCommand: "caplets vault access grant GH_TOKEN github",
          }),
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits JSON diagnostics with separate server, remote, binding, sync, daemon, and auth sections", async () => {
    const out: string[] = [];

    await runCli(["doctor", "--json"], {
      env: {
        CAPLETS_SERVER_URL: "http://127.0.0.1:5387/caplets",
        CAPLETS_REMOTE_URL: "https://cloud.caplets.dev/ws/ian",
        CAPLETS_CLOUD_AUTH_PATH: "/tmp/caplets-doctor-missing-auth.json",
      },
      writeOut: (value) => out.push(value),
    });

    const report = JSON.parse(out.join(""));
    expect(report).toMatchObject({
      server: { configured: true },
      remote: { configured: true },
      projectBinding: { state: "not_attached" },
      sync: { state: "idle" },
      daemon: { running: expect.any(Boolean) },
      remoteLogin: { configured: true, authenticated: false },
      exposure: { ok: true },
      codeMode: {
        typesGeneration: { ok: true },
        diagnostics: { ok: true },
        sandboxSmoke: { ok: true },
        logStorage: { ok: true },
        callableIndex: { ok: true },
        observedOutputShapes: { ok: true },
      },
    });
  });
});
