import { describe, expect, it } from "vitest";
import { dirname } from "node:path";
import { CloudAuthStore } from "../src/cloud-auth/store";
import { runCli } from "../src/cli";
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

    expect(JSON.parse(out.join(""))).toMatchObject({
      server: { configured: true },
      remote: { configured: true },
      projectBinding: { state: "not_attached" },
      sync: { state: "idle" },
      daemon: { running: false },
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
