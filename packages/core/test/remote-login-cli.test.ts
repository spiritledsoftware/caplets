import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
  it("reports migration guidance instead of minting Pairing Codes", async () => {
    const serverStateDir = tempDir("caplets-remote-cli-server-");
    const out: string[] = [];

    await runCli(
      [
        "remote",
        "host",
        "pair",
        "--host-url",
        "https://caplets.example.com/caplets",
        "--state-path",
        serverStateDir,
        "--json",
      ],
      { writeOut: (value) => out.push(value) },
    );

    expect(JSON.parse(out.join(""))).toMatchObject({
      supported: false,
      deprecated: true,
      hostUrl: "https://caplets.example.com/caplets",
      message: expect.stringContaining("Pairing Code bootstrap is no longer supported"),
    });
    expect(out.join("")).not.toContain("cap_pair_");
    expect(existsSync(join(serverStateDir, "remote-server-credentials.json"))).toBe(false);
  });

  it("hides legacy Pairing Code login flags from help", async () => {
    const out: string[] = [];

    await runCli(["remote", "login", "--help"], {
      writeOut: (value) => out.push(value),
    });

    expect(out.join("")).not.toContain("--code");
    expect(out.join("")).not.toContain("Pairing Code");
  });

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

  it("persists server-reported self-hosted host identity after pending login", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const out: string[] = [];

    await runCli(["remote", "login", "http://127.0.0.1:5387/caplets", "--json"], {
      authDir,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
        if (url.pathname.endsWith("/v1/remote/login/start")) {
          return Response.json({
            flowId: "rlogin_123",
            operatorCode: "cap_login_123",
            operatorCodeFingerprint: "abc12345",
            pendingRefreshSecret: "cap_pending_refresh_secret",
            pendingCompletionSecret: "cap_pending_complete_secret",
            codeExpiresAt: "2999-01-01T00:00:00.000Z",
            flowExpiresAt: "2999-01-02T00:00:00.000Z",
            intervalSeconds: 5,
          });
        }
        if (url.pathname.endsWith("/v1/remote/login/poll")) {
          expect(body).toMatchObject({
            flowId: "rlogin_123",
            pendingCompletionSecret: "cap_pending_complete_secret",
          });
          return Response.json({ flowId: "rlogin_123", status: "approved" });
        }
        if (url.pathname.endsWith("/v1/remote/login/complete")) {
          return Response.json({
            hostUrl: "https://caplets.example.com/caplets",
            clientId: "rcli_123",
            clientLabel: "Server Device",
            accessToken: "access-token",
            refreshToken: "refresh-token",
            tokenType: "Bearer",
            expiresAt: "2999-01-01T00:00:00.000Z",
          });
        }
        throw new Error(`unexpected request ${url.pathname}`);
      },
      writeOut: (value) => out.push(value),
    });

    expect(JSON.parse(out.at(-1) ?? "{}")).toMatchObject({
      hostUrl: "http://127.0.0.1:5387/caplets",
      hostIdentity: "https://caplets.example.com/caplets",
      clientId: "rcli_123",
    });
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

  it("prints an approvable host command for interactive pending remote login", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const out: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;

    await runCli(["remote", "login", "https://caplets.example.com/caplets"], {
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

    expect(out.join("")).toContain(
      `Approve from the host with caplets remote host approve ${pending?.operatorCode} --yes`,
    );
    expect(out.join("")).toContain(`Code fingerprint: ${pending?.operatorCodeFingerprint}`);
  });

  it("polls for approval before refreshing an expired visible pending code", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const requests: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;

    await runCli(["remote", "login", "https://caplets.example.com/caplets", "--json"], {
      authDir,
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
      writeOut: () => undefined,
    });

    expect(requests).toEqual([
      "/caplets/v1/remote/login/start",
      "/caplets/v1/remote/login/poll",
      "/caplets/v1/remote/login/complete",
    ]);
  });

  it("observes approval if a pending code is approved between poll and refresh", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const requests: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;

    await runCli(["remote", "login", "https://caplets.example.com/caplets", "--json"], {
      authDir,
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
        if (url.pathname.endsWith("/v1/remote/login/poll")) {
          if (!pending) throw new Error("missing pending flow");
          const flowId = body.flowId;
          const pendingCompletionSecret = body.pendingCompletionSecret;
          if (!flowId || !pendingCompletionSecret) throw new Error("missing pending poll body");
          return Response.json(server.pollPendingLogin({ flowId, pendingCompletionSecret }));
        }
        if (url.pathname.endsWith("/v1/remote/login/refresh")) {
          if (!pending) throw new Error("missing pending flow");
          server.approvePendingLogin({ operatorCode: pending.operatorCode });
          return Response.json({ error: { code: "AUTH_FAILED" } }, { status: 401 });
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
      writeOut: () => undefined,
    });

    expect(requests).toEqual([
      "/caplets/v1/remote/login/start",
      "/caplets/v1/remote/login/poll",
      "/caplets/v1/remote/login/refresh",
      "/caplets/v1/remote/login/poll",
      "/caplets/v1/remote/login/complete",
    ]);
  });

  it("cancels pending remote login on process interrupt without a test signal", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const requests: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;

    await expect(
      runCli(["remote", "login", "https://caplets.example.com/caplets", "--json"], {
        authDir,
        env: { CAPLETS_REMOTE_LOGIN_POLL_INTERVAL_MS: "10000" },
        fetch: async (input, init) => {
          const url = new URL(String(input));
          requests.push(url.pathname);
          const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
          if (url.pathname.endsWith("/v1/remote/login/start")) {
            pending = server.createPendingLogin({ hostUrl: "https://caplets.example.com/caplets" });
            queueMicrotask(() => {
              process.emit("SIGINT", "SIGINT");
            });
            return Response.json(pending);
          }
          if (url.pathname.endsWith("/v1/remote/login/cancel")) {
            if (!pending) throw new Error("missing pending flow");
            const flowId = body.flowId;
            const pendingCompletionSecret = body.pendingCompletionSecret;
            if (!flowId || !pendingCompletionSecret) throw new Error("missing pending cancel body");
            return Response.json(
              server.cancelPendingLogin({
                flowId,
                pendingCompletionSecret,
              }),
            );
          }
          throw new Error(`unexpected request ${url.pathname}`);
        },
        writeOut: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: "Remote Login pending flow cancelled.",
    });

    expect(requests).toEqual([
      "/caplets/v1/remote/login/start",
      "/caplets/v1/remote/login/poll",
      "/caplets/v1/remote/login/cancel",
    ]);
  });

  it("cancels pending remote login when an in-flight poll is aborted", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const controller = new AbortController();
    const requests: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;

    await expect(
      runCli(["remote", "login", "https://caplets.example.com/caplets", "--json"], {
        authDir,
        signal: controller.signal,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          requests.push(url.pathname);
          const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
          if (url.pathname.endsWith("/v1/remote/login/start")) {
            pending = server.createPendingLogin({ hostUrl: "https://caplets.example.com/caplets" });
            return Response.json(pending);
          }
          if (url.pathname.endsWith("/v1/remote/login/poll")) {
            controller.abort();
            throw new DOMException("aborted", "AbortError");
          }
          if (url.pathname.endsWith("/v1/remote/login/cancel")) {
            if (!pending) throw new Error("missing pending flow");
            const flowId = body.flowId;
            const pendingCompletionSecret = body.pendingCompletionSecret;
            if (!flowId || !pendingCompletionSecret) throw new Error("missing pending cancel body");
            return Response.json(server.cancelPendingLogin({ flowId, pendingCompletionSecret }));
          }
          throw new Error(`unexpected request ${url.pathname}`);
        },
        writeOut: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: "Remote Login pending flow cancelled.",
    });

    expect(requests).toEqual([
      "/caplets/v1/remote/login/start",
      "/caplets/v1/remote/login/poll",
      "/caplets/v1/remote/login/cancel",
    ]);
  });

  it("keeps login start outside abort handling until cancellation material is available", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const controller = new AbortController();
    const requests: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;

    await expect(
      runCli(["remote", "login", "https://caplets.example.com/caplets", "--json"], {
        authDir,
        signal: controller.signal,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          requests.push(url.pathname);
          const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
          if (url.pathname.endsWith("/v1/remote/login/start")) {
            pending = server.createPendingLogin({ hostUrl: "https://caplets.example.com/caplets" });
            controller.abort();
            if (init?.signal) throw new DOMException("aborted", "AbortError");
            return Response.json(pending);
          }
          if (url.pathname.endsWith("/v1/remote/login/poll")) {
            throw new DOMException("aborted", "AbortError");
          }
          if (url.pathname.endsWith("/v1/remote/login/cancel")) {
            if (!pending) throw new Error("missing pending flow");
            const flowId = body.flowId;
            const pendingCompletionSecret = body.pendingCompletionSecret;
            if (!flowId || !pendingCompletionSecret) throw new Error("missing pending cancel body");
            return Response.json(server.cancelPendingLogin({ flowId, pendingCompletionSecret }));
          }
          throw new Error(`unexpected request ${url.pathname}`);
        },
        writeOut: () => undefined,
      }),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: "Remote Login pending flow cancelled.",
    });

    expect(requests).toEqual([
      "/caplets/v1/remote/login/start",
      "/caplets/v1/remote/login/poll",
      "/caplets/v1/remote/login/cancel",
    ]);
  });

  it("retries pending remote login completion after a lost response", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const requests: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;
    let completeAttempts = 0;

    await runCli(["remote", "login", "https://caplets.example.com/caplets", "--json"], {
      authDir,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push(url.pathname);
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
          return Response.json(
            server.pollPendingLogin({
              flowId,
              pendingCompletionSecret,
            }),
          );
        }
        if (url.pathname.endsWith("/v1/remote/login/complete")) {
          if (!pending) throw new Error("missing pending flow");
          const flowId = body.flowId;
          const pendingCompletionSecret = body.pendingCompletionSecret;
          if (!flowId || !pendingCompletionSecret) throw new Error("missing pending complete body");
          completeAttempts += 1;
          const credentials = server.completePendingLogin({
            hostUrl: "https://caplets.example.com/caplets",
            flowId,
            pendingCompletionSecret,
          });
          if (completeAttempts === 1) throw new TypeError("socket closed");
          return Response.json(credentials);
        }
        throw new Error(`unexpected request ${url.pathname}`);
      },
      writeOut: () => undefined,
    });

    expect(completeAttempts).toBe(2);
    expect(requests).toEqual([
      "/caplets/v1/remote/login/start",
      "/caplets/v1/remote/login/poll",
      "/caplets/v1/remote/login/complete",
      "/caplets/v1/remote/login/complete",
    ]);
    const status = await new FileRemoteProfileStore({
      root: join(authDir, "remote-profiles"),
    }).getSelfHostedProfileStatus({ hostUrl: "https://caplets.example.com/caplets" });
    expect(status?.authenticated).toBe(true);
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

  it("cancels pending remote login when the CLI signal is aborted", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const controller = new AbortController();
    const requests: string[] = [];
    const out: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;

    await expect(
      runCli(["remote", "login", "https://caplets.example.com/caplets", "--json"], {
        authDir,
        signal: controller.signal,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          requests.push(url.pathname);
          const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
          if (url.pathname.endsWith("/v1/remote/login/start")) {
            pending = server.createPendingLogin({ hostUrl: "https://caplets.example.com/caplets" });
            controller.abort();
            return Response.json(pending);
          }
          if (url.pathname.endsWith("/v1/remote/login/cancel")) {
            if (!pending) throw new Error("missing pending flow");
            const flowId = body.flowId;
            const pendingCompletionSecret = body.pendingCompletionSecret;
            if (!flowId || !pendingCompletionSecret) throw new Error("missing pending cancel body");
            return Response.json(server.cancelPendingLogin({ flowId, pendingCompletionSecret }));
          }
          throw new Error(`unexpected request ${url.pathname}`);
        },
        writeOut: (value) => out.push(value),
      }),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: "Remote Login pending flow cancelled.",
    });

    expect(requests).toEqual([
      "/caplets/v1/remote/login/start",
      "/caplets/v1/remote/login/poll",
      "/caplets/v1/remote/login/cancel",
    ]);
    const events = out
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { code: string });
    expect(events.map((event) => event.code)).toEqual([
      "pending_login_started",
      "pending_login_cancelled",
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
          operatorCodeFingerprint: pending.operatorCodeFingerprint,
          clientLabel: `Bad${String.fromCharCode(0x1b)}[31mDevice`,
          clientFingerprint: "fp_test",
          sourceHint: "127.0.0.1",
        },
      ],
    });
    expect(listOut.join("")).not.toContain(pending.pendingRefreshSecret);
    expect(listOut.join("")).not.toContain(pending.pendingCompletionSecret);
    const plainListOut: string[] = [];
    await runCli(["remote", "host", "logins", "--state-path", serverStateDir], {
      writeOut: (value) => plainListOut.push(value),
    });
    expect(plainListOut.join("")).toContain(pending.operatorCodeFingerprint);
    expect(plainListOut.join("")).not.toContain(pending.operatorCode);

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

  it("lists multiple Cloud workspace profiles through remote status", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const store = new FileRemoteProfileStore({ root: join(authDir, "remote-profiles") });
    await store.saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev",
      workspaceId: "workspace_alpha",
      workspaceSlug: "alpha",
      credentials: {
        accessToken: "alpha-access",
        refreshToken: "alpha-refresh",
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
    });
    await store.saveCloudProfile({
      hostUrl: "https://cloud.caplets.dev",
      workspaceId: "workspace_beta",
      workspaceSlug: "beta",
      credentials: {
        accessToken: "beta-access",
        refreshToken: "beta-refresh",
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
          kind: "cloud",
          hostUrl: "https://cloud.caplets.dev/",
          workspaceSlug: "alpha",
          selected: false,
        },
        {
          kind: "cloud",
          hostUrl: "https://cloud.caplets.dev/",
          workspaceSlug: "beta",
          selected: true,
        },
      ],
    });
    expect(out.join("")).not.toContain("alpha-access");
    expect(out.join("")).not.toContain("beta-refresh");
  });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
