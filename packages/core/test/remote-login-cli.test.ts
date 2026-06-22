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
  it("rejects legacy Pairing Code argv login with migration guidance", async () => {
    const issued = new RemoteServerCredentialStore({
      dir: tempDir("caplets-remote-cli-server-"),
    }).createPairingCode({ hostUrl: "https://caplets.example.com/caplets" });
    const requests: string[] = [];

    await expect(
      runCli(
        ["remote", "login", "https://caplets.example.com/caplets", "--code", issued.code, "--json"],
        {
          fetch: async (input) => {
            requests.push(String(input));
            return Response.json({});
          },
          writeErr: () => undefined,
        },
      ),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: expect.stringContaining(
        "Run caplets remote login https://caplets.example.com/caplets without --code",
      ),
    });
    expect(requests).toEqual([]);
  });

  it("logs into a self-hosted remote through pending login approval", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const requests: string[] = [];
    const out: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;

    await runCli(
      [
        "remote",
        "login",
        "https://caplets.example.com/caplets",
        "--client-label",
        "Test Device",
        "--json",
      ],
      {
        authDir,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          requests.push(url.pathname);
          const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
          if (url.pathname.endsWith("/v1/remote/login/start")) {
            pending = server.createPendingLogin({
              hostUrl: "https://caplets.example.com/caplets",
              clientLabel: body.clientLabel,
            });
            return Response.json(pending);
          }
          if (url.pathname.endsWith("/v1/remote/login/poll")) {
            if (!pending) throw new Error("missing pending flow");
            const flowId = body.flowId;
            const pendingCompletionSecret = body.pendingCompletionSecret;
            if (!flowId || !pendingCompletionSecret) throw new Error("missing pending poll body");
            server.approvePendingLogin({ operatorCode: pending.operatorCode });
            return Response.json(
              server.pollPendingLogin({
                flowId,
                pendingCompletionSecret,
              }),
            );
          }
          if (url.pathname.endsWith("/v1/remote/login/complete")) {
            const flowId = body.flowId;
            const pendingCompletionSecret = body.pendingCompletionSecret;
            if (!flowId || !pendingCompletionSecret)
              throw new Error("missing pending complete body");
            return Response.json(
              server.completePendingLogin({
                hostUrl: "https://caplets.example.com/caplets",
                flowId,
                pendingCompletionSecret,
              }),
            );
          }
          throw new Error(`unexpected request ${url.pathname}`);
        },
        writeOut: (value) => out.push(value),
      },
    );

    expect(requests).toEqual([
      "/caplets/v1/remote/login/start",
      "/caplets/v1/remote/login/poll",
      "/caplets/v1/remote/login/complete",
    ]);
    expect(JSON.parse(out.at(-1) ?? "{}")).toMatchObject({
      authenticated: true,
      kind: "self-hosted",
      hostUrl: "https://caplets.example.com/caplets",
      clientLabel: "Test Device",
    });
    expect(out.join("")).not.toContain(pending?.pendingRefreshSecret ?? "missing");
    expect(out.join("")).not.toContain(pending?.pendingCompletionSecret ?? "missing");
  });

  it("emits stable JSON events for pending remote login", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const out: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;

    await runCli(["remote", "login", "https://caplets.example.com/caplets", "--json"], {
      authDir,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
        if (url.pathname.endsWith("/v1/remote/login/start")) {
          pending = server.createPendingLogin({ hostUrl: "https://caplets.example.com/caplets" });
          return Response.json(pending);
        }
        if (url.pathname.endsWith("/v1/remote/login/poll")) {
          if (!pending) throw new Error("missing pending flow");
          const flowId = body.flowId;
          const pendingCompletionSecret = body.pendingCompletionSecret;
          if (!flowId || !pendingCompletionSecret) throw new Error("missing pending poll body");
          server.approvePendingLogin({ operatorCode: pending.operatorCode });
          return Response.json(server.pollPendingLogin({ flowId, pendingCompletionSecret }));
        }
        if (url.pathname.endsWith("/v1/remote/login/complete")) {
          const flowId = body.flowId;
          const pendingCompletionSecret = body.pendingCompletionSecret;
          if (!flowId || !pendingCompletionSecret) throw new Error("missing pending complete body");
          return Response.json(
            server.completePendingLogin({
              hostUrl: "https://caplets.example.com/caplets",
              flowId,
              pendingCompletionSecret,
            }),
          );
        }
        throw new Error(`unexpected request ${url.pathname}`);
      },
      writeOut: (value) => out.push(value),
    });

    const events = out
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { code: string });
    expect(events.map((event) => event.code)).toEqual([
      "pending_login_started",
      "pending_login_approved",
      "remote_profile_saved",
    ]);
    expect(out.join("")).not.toContain(pending?.pendingRefreshSecret ?? "missing");
    expect(out.join("")).not.toContain(pending?.pendingCompletionSecret ?? "missing");
  });

  it("refreshes the visible pending login code during delayed approval", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const requests: string[] = [];
    const out: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;
    let pollCount = 0;

    await runCli(["remote", "login", "https://caplets.example.com/caplets", "--json"], {
      authDir,
      env: { CAPLETS_REMOTE_LOGIN_POLL_INTERVAL_MS: "0" },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push(url.pathname);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
        if (url.pathname.endsWith("/v1/remote/login/start")) {
          pending = server.createPendingLogin({ hostUrl: "https://caplets.example.com/caplets" });
          return Response.json({
            ...pending,
            codeExpiresAt: new Date(Date.now() - 1).toISOString(),
          });
        }
        if (url.pathname.endsWith("/v1/remote/login/refresh")) {
          if (!pending) throw new Error("missing pending flow");
          const flowId = body.flowId;
          const pendingRefreshSecret = body.pendingRefreshSecret;
          const pendingCompletionSecret = body.pendingCompletionSecret;
          if (!flowId || !pendingRefreshSecret || !pendingCompletionSecret)
            throw new Error("missing pending refresh body");
          const refreshed = server.refreshPendingLogin({
            flowId,
            pendingRefreshSecret,
            pendingCompletionSecret,
          });
          pending = { ...refreshed, pendingCompletionSecret };
          return Response.json(pending);
        }
        if (url.pathname.endsWith("/v1/remote/login/poll")) {
          if (!pending) throw new Error("missing pending flow");
          const flowId = body.flowId;
          const pendingCompletionSecret = body.pendingCompletionSecret;
          if (!flowId || !pendingCompletionSecret) throw new Error("missing pending poll body");
          pollCount += 1;
          if (pollCount > 1) server.approvePendingLogin({ operatorCode: pending.operatorCode });
          return Response.json(server.pollPendingLogin({ flowId, pendingCompletionSecret }));
        }
        if (url.pathname.endsWith("/v1/remote/login/complete")) {
          if (!pending) throw new Error("missing pending flow");
          const flowId = body.flowId;
          const pendingCompletionSecret = body.pendingCompletionSecret;
          if (!flowId || !pendingCompletionSecret) throw new Error("missing pending complete body");
          return Response.json(
            server.completePendingLogin({
              hostUrl: "https://caplets.example.com/caplets",
              flowId,
              pendingCompletionSecret,
            }),
          );
        }
        throw new Error(`unexpected request ${url.pathname}`);
      },
      writeOut: (value) => out.push(value),
    });

    expect(requests).toContain("/caplets/v1/remote/login/refresh");
    const events = out
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { code: string });
    expect(events.map((event) => event.code)).toContain("pending_login_code_refreshed");
    expect(out.join("")).not.toContain(pending?.pendingRefreshSecret ?? "missing");
    expect(out.join("")).not.toContain(pending?.pendingCompletionSecret ?? "missing");
  });

  it("emits a stable JSON event when pending remote login is denied", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const out: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;

    await expect(
      runCli(["remote", "login", "https://caplets.example.com/caplets", "--json"], {
        authDir,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
          if (url.pathname.endsWith("/v1/remote/login/start")) {
            pending = server.createPendingLogin({ hostUrl: "https://caplets.example.com/caplets" });
            server.denyPendingLogin({ operatorCode: pending.operatorCode });
            return Response.json(pending);
          }
          if (url.pathname.endsWith("/v1/remote/login/poll")) {
            if (!pending) throw new Error("missing pending flow");
            const flowId = body.flowId;
            const pendingCompletionSecret = body.pendingCompletionSecret;
            if (!flowId || !pendingCompletionSecret) throw new Error("missing pending poll body");
            return Response.json(server.pollPendingLogin({ flowId, pendingCompletionSecret }));
          }
          throw new Error(`unexpected request ${url.pathname}`);
        },
        writeOut: (value) => out.push(value),
      }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });

    const events = out
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { code: string });
    expect(events.map((event) => event.code)).toEqual([
      "pending_login_started",
      "pending_login_denied",
    ]);
    expect(out.join("")).not.toContain(pending?.pendingRefreshSecret ?? "missing");
    expect(out.join("")).not.toContain(pending?.pendingCompletionSecret ?? "missing");
  });

  it("logs out a stored self-hosted remote profile", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const issued = server.createPairingCode({ hostUrl: "https://caplets.example.com" });
    const credentials = server.exchangePairingCode({
      hostUrl: "https://caplets.example.com/",
      code: issued.code,
    });
    let accessToken = "";
    accessToken = credentials.accessToken;
    await new FileRemoteProfileStore({
      root: join(authDir, "remote-profiles"),
    }).saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com",
      clientId: credentials.clientId,
      clientLabel: credentials.clientLabel,
      credentials: {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt,
      },
    });

    const out: string[] = [];
    await runCli(["remote", "logout", "https://caplets.example.com"], {
      authDir,
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://caplets.example.com/v1/remote/client");
        expect(init?.method).toBe("DELETE");
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
        const revoked = server.revokeClient(
          server.validateAccessToken({
            hostUrl: "https://caplets.example.com/",
            accessToken,
          }).clientId,
        );
        return Response.json({ revoked });
      },
      writeOut: (value) => out.push(value),
    });
    expect(out.join("")).toContain("Logged out");
    expect(() =>
      server.validateAccessToken({
        hostUrl: "https://caplets.example.com/",
        accessToken,
      }),
    ).toThrow(/revoked/u);

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

  it("refreshes expired self-hosted credentials before logout revoke", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const issued = server.createPairingCode({ hostUrl: "https://caplets.example.com" });
    const credentials = server.exchangePairingCode({
      hostUrl: "https://caplets.example.com/",
      code: issued.code,
    });
    await new FileRemoteProfileStore({
      root: join(authDir, "remote-profiles"),
    }).saveSelfHostedProfile({
      hostUrl: "https://caplets.example.com",
      clientId: credentials.clientId,
      clientLabel: credentials.clientLabel,
      credentials: {
        accessToken: "expired-access-token",
        refreshToken: credentials.refreshToken,
        expiresAt: "2026-06-19T00:00:00.000Z",
      },
    });
    const requests: Array<{ path: string; authorization?: string | null }> = [];

    await runCli(["remote", "logout", "https://caplets.example.com"], {
      authDir,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          path: url.pathname,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        if (url.pathname.endsWith("/v1/remote/refresh")) {
          const body = JSON.parse(String(init?.body)) as { refreshToken: string };
          return Response.json(
            server.refreshClientCredentials({
              hostUrl: "https://caplets.example.com/",
              refreshToken: body.refreshToken,
            }),
          );
        }
        const accessToken = new Headers(init?.headers)
          .get("authorization")
          ?.replace(/^Bearer /u, "");
        const clientId = server.validateAccessToken({
          hostUrl: "https://caplets.example.com/",
          accessToken: accessToken ?? "",
        }).clientId;
        return Response.json({ revoked: server.revokeClient(clientId) });
      },
      writeOut: () => undefined,
    });

    expect(requests).toEqual([
      { path: "/v1/remote/refresh", authorization: null },
      {
        path: "/v1/remote/client",
        authorization: expect.stringMatching(/^Bearer (?!expired-access-token)/u),
      },
    ]);
  });

  it("logs out a stored Cloud Remote Profile through Cloud logout", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    await new FileRemoteProfileStore({
      root: join(authDir, "remote-profiles"),
    }).saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev",
      workspaceId: "workspace_team",
      workspaceSlug: "team",
      credentials: {
        accessToken: "cloud-access",
        refreshToken: "cloud-refresh",
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
    });
    const requests: Array<{ url: string; body: unknown }> = [];

    await runCli(["remote", "logout", "https://cloud.caplets.dev", "--json"], {
      authDir,
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({});
      },
      writeOut: () => undefined,
    });

    expect(requests).toEqual([
      {
        url: "https://cloud.caplets.dev/api/cloud-client/logout",
        body: { refreshToken: "cloud-refresh" },
      },
    ]);
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

  it("lists and approves pending self-hosted logins from server state", async () => {
    const serverStateDir = tempDir("caplets-remote-cli-server-");
    const server = new RemoteServerCredentialStore({ dir: serverStateDir });
    const pending = server.createPendingLogin({
      hostUrl: "https://caplets.example.com",
      clientLabel: `Bad${String.fromCharCode(0x1b)}[31mDevice`,
      clientFingerprint: "fp_test",
      sourceHint: "127.0.0.1",
    });
    const listOut: string[] = [];

    await runCli(["remote", "host", "logins", "--state-path", serverStateDir, "--json"], {
      writeOut: (value) => listOut.push(value),
    });

    expect(JSON.parse(listOut.join(""))).toMatchObject({
      pendingLogins: [
        {
          flowId: pending.flowId,
          status: "pending",
          clientLabel: `Bad${String.fromCharCode(0x1b)}[31mDevice`,
          clientFingerprint: "fp_test",
          sourceHint: "127.0.0.1",
        },
      ],
    });
    expect(listOut.join("")).not.toContain(pending.pendingRefreshSecret);
    expect(listOut.join("")).not.toContain(pending.pendingCompletionSecret);

    const approveOut: string[] = [];
    await runCli(
      [
        "remote",
        "host",
        "approve",
        pending.operatorCode,
        "--state-path",
        serverStateDir,
        "--yes",
        "--json",
      ],
      { writeOut: (value) => approveOut.push(value) },
    );

    expect(JSON.parse(approveOut.join(""))).toMatchObject({
      flowId: pending.flowId,
      status: "approved",
      clientLabel: `Bad${String.fromCharCode(0x1b)}[31mDevice`,
    });
    expect(
      server.completePendingLogin({
        hostUrl: "https://caplets.example.com",
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
      }),
    ).toMatchObject({ clientLabel: `Bad${String.fromCharCode(0x1b)}[31mDevice` });
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
