import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { FileRemoteProfileStore } from "../src/remote/profile-store";
import { RemoteServerCredentialStore } from "../src/remote/server-credential-store";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("caplets remote CLI", () => {
  it("logs into a self-hosted remote with a Pairing Code without storing the copied code", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const serverStateDir = tempDir("caplets-remote-cli-server-");
    const server = new RemoteServerCredentialStore({ dir: serverStateDir });
    const issued = server.createPairingCode({ hostUrl: "https://caplets.example.com/caplets" });
    const requests: Array<{ url: string; body: unknown }> = [];
    const out: string[] = [];
    const err: string[] = [];

    await runCli(
      [
        "remote",
        "login",
        "https://caplets.example.com/caplets",
        "--code",
        issued.code,
        "--client-label",
        "Test Device",
        "--json",
      ],
      {
        authDir,
        fetch: async (input, init) => {
          const body = JSON.parse(String(init?.body)) as { code: string };
          requests.push({ url: String(input), body });
          const credentials = server.exchangePairingCode({
            hostUrl: "https://caplets.example.com/caplets",
            code: body.code,
            clientLabel: "Test Device",
          });
          return Response.json(credentials);
        },
        writeOut: (value) => out.push(value),
        writeErr: (value) => err.push(value),
      },
    );

    expect(requests).toEqual([
      {
        url: "https://caplets.example.com/caplets/v1/remote/pairing/exchange",
        body: { code: issued.code, clientLabel: "Test Device" },
      },
    ]);
    expect(JSON.parse(out.join(""))).toMatchObject({
      authenticated: true,
      kind: "self-hosted",
      hostUrl: "https://caplets.example.com/caplets",
      clientId: expect.any(String),
      clientLabel: "Test Device",
    });
    expect(out.join("")).not.toContain(issued.code);
    expect(err.join("")).toContain("--code may store the Pairing Code in shell history");
    expect(err.join("")).not.toContain(issued.code);

    const statusOut: string[] = [];
    await runCli(["remote", "status", "https://caplets.example.com/caplets", "--json"], {
      authDir,
      writeOut: (value) => statusOut.push(value),
    });
    expect(JSON.parse(statusOut.join(""))).toMatchObject({
      authenticated: true,
      kind: "self-hosted",
      clientLabel: "Test Device",
    });
    expect(statusOut.join("")).not.toContain(issued.code);
  });

  it("logs out a stored self-hosted remote profile", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const issued = server.createPairingCode({ hostUrl: "https://caplets.example.com" });

    await runCli(["remote", "login", "https://caplets.example.com", "--code", issued.code], {
      authDir,
      fetch: async (_input, init) =>
        Response.json(
          server.exchangePairingCode({
            hostUrl: "https://caplets.example.com/",
            code: String(JSON.parse(String(init?.body)).code),
          }),
        ),
      writeOut: () => undefined,
    });

    const out: string[] = [];
    await runCli(["remote", "logout", "https://caplets.example.com"], {
      authDir,
      writeOut: (value) => out.push(value),
    });
    expect(out.join("")).toContain("Logged out");

    const statusOut: string[] = [];
    await runCli(["remote", "status", "https://caplets.example.com", "--json"], {
      authDir,
      writeOut: (value) => statusOut.push(value),
    });
    expect(JSON.parse(statusOut.join(""))).toEqual({
      authenticated: false,
      status: "unauthenticated",
      hostUrl: "https://caplets.example.com/",
      kind: "self-hosted",
    });
  });

  it("prints paired self-hosted client labels without terminal control bytes", async () => {
    const serverStateDir = tempDir("caplets-remote-cli-server-");
    const server = new RemoteServerCredentialStore({ dir: serverStateDir });
    const issued = server.createPairingCode({ hostUrl: "https://caplets.example.com" });
    server.exchangePairingCode({
      hostUrl: "https://caplets.example.com",
      code: issued.code,
      clientLabel: `Bad${String.fromCharCode(0x1b)}[31mName${String.fromCharCode(0x07)}`,
    });
    const out: string[] = [];

    await runCli(["remote", "host", "clients", "--state-path", serverStateDir], {
      writeOut: (value) => out.push(value),
    });

    expect(out.join("")).not.toContain(String.fromCharCode(0x1b));
    expect(out.join("")).not.toContain(String.fromCharCode(0x07));
    expect(out.join("")).toContain("Bad?[31mName?");
  });

  it("routes Cloud login through Remote Profiles instead of legacy Cloud Auth", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const responses = [
      Response.json({
        loginId: "login_123",
        loginUrl: "https://cloud.caplets.dev/cli-login/login_123",
        userCode: "ABCD-EFGH",
        expiresAt: "2026-06-19T12:10:00.000Z",
      }),
      Response.json({
        status: "completed",
        selectedWorkspace: { workspaceId: "workspace_team", slug: "team" },
        oneTimeCode: "one_time_code_secret",
      }),
      Response.json({
        status: "authenticated",
        cloudUrl: "https://cloud.caplets.dev",
        workspaceId: "workspace_team",
        workspaceSlug: "team",
        accessToken: "cap_access_secret",
        refreshToken: "cap_refresh_secret",
        expiresAt: "2099-06-19T13:00:00.000Z",
        scope: ["project_binding:read", "project_binding:write", "mcp:tools"],
        tokenType: "Bearer",
        credentialFamilyId: "family_123",
        deviceName: "Test Device",
      }),
    ];
    const out: string[] = [];

    await runCli(
      [
        "remote",
        "login",
        "https://cloud.caplets.dev",
        "--workspace",
        "team",
        "--no-open",
        "--json",
      ],
      {
        authDir,
        env: { CAPLETS_CLOUD_AUTH_POLL_INTERVAL_MS: "0" },
        fetch: async () => responses.shift() ?? Response.json({}, { status: 500 }),
        writeOut: (value) => out.push(value),
      },
    );

    expect(JSON.parse(out.join(""))).toMatchObject({
      authenticated: true,
      kind: "cloud",
      hostUrl: "https://cloud.caplets.dev/",
      workspaceId: "workspace_team",
      workspaceSlug: "team",
      selected: true,
    });
    expect(out.join("")).not.toContain("cap_access_secret");
    expect(out.join("")).not.toContain("cap_refresh_secret");

    const statusOut: string[] = [];
    await runCli(["remote", "status", "https://cloud.caplets.dev", "--json"], {
      authDir,
      writeOut: (value) => statusOut.push(value),
    });
    expect(JSON.parse(statusOut.join(""))).toMatchObject({
      authenticated: true,
      kind: "cloud",
      workspaceSlug: "team",
    });
  });

  it("lists saved Remote Profiles without requiring a host URL", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    await new FileRemoteProfileStore({
      root: join(authDir, "remote-profiles"),
    }).saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com/caplets",
      clientId: "rcli_123",
      clientLabel: "Test Device",
      credentials: {
        accessToken: "self-hosted-access",
        refreshToken: "self-hosted-refresh",
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
    });
    const out: string[] = [];

    await runCli(["remote", "status", "--json"], {
      authDir,
      writeOut: (value) => out.push(value),
    });

    expect(JSON.parse(out.join(""))).toMatchObject({
      profiles: [
        {
          authenticated: true,
          kind: "self-hosted",
          hostUrl: "https://caplets.example.com/caplets",
          clientLabel: "Test Device",
        },
      ],
    });
    expect(out.join("")).not.toContain("self-hosted-access");
    expect(out.join("")).not.toContain("self-hosted-refresh");
  });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
