import { describe, expect, it } from "vitest";
import { CloudAuthStore } from "../src/cloud-auth/store";
import { runCli } from "../src/cli";
import { hostedCredentials, tempCloudAuthPath } from "./fixtures/cloud-auth";

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
    expect(report).toContain("Cloud Auth");
    expect(report).toContain("Exposure");
    expect(report).toContain("Code Mode");
    expect(report).not.toContain("local presence");
  });

  it("shows remote client derived URLs and auth state", async () => {
    const out: string[] = [];

    await runCli(["doctor"], {
      env: {
        CAPLETS_REMOTE_URL: "https://cloud.caplets.dev/ws/ian",
        CAPLETS_REMOTE_TOKEN: "secret",
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
    expect(report).toContain("Auth: bearer");
    expect(report).not.toContain("secret");
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
      cloudAuth: { authenticated: false },
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
