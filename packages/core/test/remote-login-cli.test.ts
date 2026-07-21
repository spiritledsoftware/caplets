import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { FileRemoteProfileStore } from "../src/remote/profile-store";
import { RemoteServerCredentialStore } from "../src/remote/server-credential-store";
import { createHostStorage, type HostStorage, type RemoteSecurityStore } from "../src/storage";

const dirs: string[] = [];
const storages = new Set<HostStorage>();

afterEach(async () => {
  await Promise.all([...storages].map(async (storage) => await storage.close()));
  storages.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("caplets remote CLI", () => {
  it("exposes only pending Remote Login options", async () => {
    const out: string[] = [];

    await runCli(["remote", "login", "--help"], {
      writeOut: (value) => out.push(value),
    });

    expect(out.join("")).not.toContain("--code");
    expect(out.join("")).not.toContain("Pairing Code");
  });

  it("logs into a Current Host through pending Remote Login approval", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const requests: string[] = [];
    const out: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;

    await runCli(
      ["remote", "login", "https://caplets.example.com", "--client-label", "Test Device", "--json"],
      {
        authDir,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          requests.push(url.pathname);
          const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
          if (url.pathname.endsWith("/api/v1/remote/login/start")) {
            pending = server.createPendingLogin({
              hostUrl: "https://caplets.example.com",
              clientLabel: body.clientLabel,
            });
            return Response.json(pending);
          }
          if (url.pathname.endsWith("/api/v1/remote/login/poll")) {
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
          if (url.pathname.endsWith("/api/v1/remote/login/complete")) {
            const flowId = body.flowId;
            const pendingCompletionSecret = body.pendingCompletionSecret;
            if (!flowId || !pendingCompletionSecret)
              throw new Error("missing pending complete body");
            return Response.json(
              server.completePendingLogin({
                hostUrl: "https://caplets.example.com",
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
      "/api/v1/remote/login/start",
      "/api/v1/remote/login/poll",
      "/api/v1/remote/login/complete",
    ]);
    expect(JSON.parse(out.at(-1) ?? "{}")).toMatchObject({
      authenticated: true,
      key: "remote:https://caplets.example.com",
      origin: "https://caplets.example.com",
      clientLabel: "Test Device",
    });
    expect(out.join("")).not.toContain(pending?.pendingRefreshSecret ?? "missing");
    expect(out.join("")).not.toContain(pending?.pendingCompletionSecret ?? "missing");
  });

  it("persists the Current Host identity reported by Remote Login", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const out: string[] = [];

    await runCli(["remote", "login", "http://127.0.0.1:5387", "--json"], {
      authDir,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
        if (url.pathname.endsWith("/api/v1/remote/login/start")) {
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
        if (url.pathname.endsWith("/api/v1/remote/login/poll")) {
          expect(body).toMatchObject({
            flowId: "rlogin_123",
            pendingCompletionSecret: "cap_pending_complete_secret",
          });
          return Response.json({ flowId: "rlogin_123", status: "approved" });
        }
        if (url.pathname.endsWith("/api/v1/remote/login/complete")) {
          return Response.json({
            hostUrl: "https://caplets.example.com",
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
      origin: "http://127.0.0.1:5387",
      hostIdentity: "https://caplets.example.com",
      clientId: "rcli_123",
    });
  });

  it("emits stable JSON events for pending remote login", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const out: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;

    await runCli(["remote", "login", "https://caplets.example.com", "--json"], {
      authDir,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
        if (url.pathname.endsWith("/api/v1/remote/login/start")) {
          pending = server.createPendingLogin({ hostUrl: "https://caplets.example.com" });
          return Response.json(pending);
        }
        if (url.pathname.endsWith("/api/v1/remote/login/poll")) {
          if (!pending) throw new Error("missing pending flow");
          const flowId = body.flowId;
          const pendingCompletionSecret = body.pendingCompletionSecret;
          if (!flowId || !pendingCompletionSecret) throw new Error("missing pending poll body");
          server.approvePendingLogin({ operatorCode: pending.operatorCode });
          return Response.json(server.pollPendingLogin({ flowId, pendingCompletionSecret }));
        }
        if (url.pathname.endsWith("/api/v1/remote/login/complete")) {
          const flowId = body.flowId;
          const pendingCompletionSecret = body.pendingCompletionSecret;
          if (!flowId || !pendingCompletionSecret) throw new Error("missing pending complete body");
          return Response.json(
            server.completePendingLogin({
              hostUrl: "https://caplets.example.com",
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
    let serverApprovalCommand = "";

    await runCli(["remote", "login", "https://caplets.example.com"], {
      authDir,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
        if (url.pathname.endsWith("/api/v1/remote/login/start")) {
          pending = server.createPendingLogin({ hostUrl: "https://caplets.example.com" });
          serverApprovalCommand = [
            "sudo -u caplets caplets remote host approve",
            pending.operatorCode,
            "--yes",
          ].join(" ");
          return Response.json({ ...pending, approvalCommand: serverApprovalCommand });
        }
        if (url.pathname.endsWith("/api/v1/remote/login/poll")) {
          if (!pending) throw new Error("missing pending flow");
          const flowId = body.flowId;
          const pendingCompletionSecret = body.pendingCompletionSecret;
          if (!flowId || !pendingCompletionSecret) throw new Error("missing pending poll body");
          server.approvePendingLogin({ operatorCode: pending.operatorCode });
          return Response.json(server.pollPendingLogin({ flowId, pendingCompletionSecret }));
        }
        if (url.pathname.endsWith("/api/v1/remote/login/complete")) {
          const flowId = body.flowId;
          const pendingCompletionSecret = body.pendingCompletionSecret;
          if (!flowId || !pendingCompletionSecret) throw new Error("missing pending complete body");
          return Response.json(
            server.completePendingLogin({
              hostUrl: "https://caplets.example.com",
              flowId,
              pendingCompletionSecret,
            }),
          );
        }
        throw new Error(`unexpected request ${url.pathname}`);
      },
      writeOut: (value) => out.push(value),
    });

    expect(out.join("")).toContain(`Approve from the host with ${serverApprovalCommand}`);
    expect(out.join("")).not.toContain(
      `Approve from the host with caplets remote host approve ${pending?.operatorCode} --yes\n`,
    );
    expect(out.join("")).toContain(`Code fingerprint: ${pending?.operatorCodeFingerprint}`);
  });

  it("polls for approval before refreshing an expired visible pending code", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const requests: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;

    await runCli(["remote", "login", "https://caplets.example.com", "--json"], {
      authDir,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push(url.pathname);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
        if (url.pathname.endsWith("/api/v1/remote/login/start")) {
          pending = server.createPendingLogin({ hostUrl: "https://caplets.example.com" });
          return Response.json({
            ...pending,
            codeExpiresAt: new Date(Date.now() - 1).toISOString(),
          });
        }
        if (url.pathname.endsWith("/api/v1/remote/login/poll")) {
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
        if (url.pathname.endsWith("/api/v1/remote/login/complete")) {
          if (!pending) throw new Error("missing pending flow");
          const flowId = body.flowId;
          const pendingCompletionSecret = body.pendingCompletionSecret;
          if (!flowId || !pendingCompletionSecret) throw new Error("missing pending complete body");
          return Response.json(
            server.completePendingLogin({
              hostUrl: "https://caplets.example.com",
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
      "/api/v1/remote/login/start",
      "/api/v1/remote/login/poll",
      "/api/v1/remote/login/complete",
    ]);
  });

  it("observes approval if a pending code is approved between poll and refresh", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const requests: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;

    await runCli(["remote", "login", "https://caplets.example.com", "--json"], {
      authDir,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push(url.pathname);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
        if (url.pathname.endsWith("/api/v1/remote/login/start")) {
          pending = server.createPendingLogin({ hostUrl: "https://caplets.example.com" });
          return Response.json({
            ...pending,
            codeExpiresAt: new Date(Date.now() - 1).toISOString(),
          });
        }
        if (url.pathname.endsWith("/api/v1/remote/login/poll")) {
          if (!pending) throw new Error("missing pending flow");
          const flowId = body.flowId;
          const pendingCompletionSecret = body.pendingCompletionSecret;
          if (!flowId || !pendingCompletionSecret) throw new Error("missing pending poll body");
          return Response.json(server.pollPendingLogin({ flowId, pendingCompletionSecret }));
        }
        if (url.pathname.endsWith("/api/v1/remote/login/refresh")) {
          if (!pending) throw new Error("missing pending flow");
          server.approvePendingLogin({ operatorCode: pending.operatorCode });
          return Response.json({ error: { code: "AUTH_FAILED" } }, { status: 401 });
        }
        if (url.pathname.endsWith("/api/v1/remote/login/complete")) {
          if (!pending) throw new Error("missing pending flow");
          const flowId = body.flowId;
          const pendingCompletionSecret = body.pendingCompletionSecret;
          if (!flowId || !pendingCompletionSecret) throw new Error("missing pending complete body");
          return Response.json(
            server.completePendingLogin({
              hostUrl: "https://caplets.example.com",
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
      "/api/v1/remote/login/start",
      "/api/v1/remote/login/poll",
      "/api/v1/remote/login/refresh",
      "/api/v1/remote/login/poll",
      "/api/v1/remote/login/complete",
    ]);
  });

  it("cancels pending remote login on process interrupt without a test signal", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const requests: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;

    await expect(
      runCli(["remote", "login", "https://caplets.example.com", "--json"], {
        authDir,
        env: { CAPLETS_REMOTE_LOGIN_POLL_INTERVAL_MS: "10000" },
        fetch: async (input, init) => {
          const url = new URL(String(input));
          requests.push(url.pathname);
          const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
          if (url.pathname.endsWith("/api/v1/remote/login/start")) {
            pending = server.createPendingLogin({ hostUrl: "https://caplets.example.com" });
            queueMicrotask(() => {
              process.emit("SIGINT", "SIGINT");
            });
            return Response.json(pending);
          }
          if (url.pathname.endsWith("/api/v1/remote/login/cancel")) {
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
      "/api/v1/remote/login/start",
      "/api/v1/remote/login/poll",
      "/api/v1/remote/login/cancel",
    ]);
  });

  it("cancels pending remote login when an in-flight poll is aborted", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const controller = new AbortController();
    const requests: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;

    await expect(
      runCli(["remote", "login", "https://caplets.example.com", "--json"], {
        authDir,
        signal: controller.signal,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          requests.push(url.pathname);
          const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
          if (url.pathname.endsWith("/api/v1/remote/login/start")) {
            pending = server.createPendingLogin({ hostUrl: "https://caplets.example.com" });
            return Response.json(pending);
          }
          if (url.pathname.endsWith("/api/v1/remote/login/poll")) {
            controller.abort();
            throw new DOMException("aborted", "AbortError");
          }
          if (url.pathname.endsWith("/api/v1/remote/login/cancel")) {
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
      "/api/v1/remote/login/start",
      "/api/v1/remote/login/poll",
      "/api/v1/remote/login/cancel",
    ]);
  });

  it("keeps login start outside abort handling until cancellation material is available", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const controller = new AbortController();
    const requests: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;

    await expect(
      runCli(["remote", "login", "https://caplets.example.com", "--json"], {
        authDir,
        signal: controller.signal,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          requests.push(url.pathname);
          const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
          if (url.pathname.endsWith("/api/v1/remote/login/start")) {
            pending = server.createPendingLogin({ hostUrl: "https://caplets.example.com" });
            controller.abort();
            if (init?.signal) throw new DOMException("aborted", "AbortError");
            return Response.json(pending);
          }
          if (url.pathname.endsWith("/api/v1/remote/login/poll")) {
            throw new DOMException("aborted", "AbortError");
          }
          if (url.pathname.endsWith("/api/v1/remote/login/cancel")) {
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
      "/api/v1/remote/login/start",
      "/api/v1/remote/login/poll",
      "/api/v1/remote/login/cancel",
    ]);
  });

  it("retries pending remote login completion after a lost response", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const requests: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;
    let completeAttempts = 0;

    await runCli(["remote", "login", "https://caplets.example.com", "--json"], {
      authDir,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push(url.pathname);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
        if (url.pathname.endsWith("/api/v1/remote/login/start")) {
          pending = server.createPendingLogin({ hostUrl: "https://caplets.example.com" });
          return Response.json(pending);
        }
        if (url.pathname.endsWith("/api/v1/remote/login/poll")) {
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
        if (url.pathname.endsWith("/api/v1/remote/login/complete")) {
          if (!pending) throw new Error("missing pending flow");
          const flowId = body.flowId;
          const pendingCompletionSecret = body.pendingCompletionSecret;
          if (!flowId || !pendingCompletionSecret) throw new Error("missing pending complete body");
          completeAttempts += 1;
          const credentials = server.completePendingLogin({
            hostUrl: "https://caplets.example.com",
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
      "/api/v1/remote/login/start",
      "/api/v1/remote/login/poll",
      "/api/v1/remote/login/complete",
      "/api/v1/remote/login/complete",
    ]);
    const status = await new FileRemoteProfileStore({
      root: join(authDir, "remote-profiles"),
    }).getRemoteProfileStatus({ origin: "https://caplets.example.com" });
    expect(status?.authenticated).toBe(true);
  });

  it("refreshes the visible pending login code during delayed approval", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const requests: string[] = [];
    const out: string[] = [];
    let pending: ReturnType<RemoteServerCredentialStore["createPendingLogin"]> | undefined;
    let pollCount = 0;

    await runCli(["remote", "login", "https://caplets.example.com", "--json"], {
      authDir,
      env: { CAPLETS_REMOTE_LOGIN_POLL_INTERVAL_MS: "0" },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push(url.pathname);
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
        if (url.pathname.endsWith("/api/v1/remote/login/start")) {
          pending = server.createPendingLogin({ hostUrl: "https://caplets.example.com" });
          return Response.json({
            ...pending,
            codeExpiresAt: new Date(Date.now() - 1).toISOString(),
          });
        }
        if (url.pathname.endsWith("/api/v1/remote/login/refresh")) {
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
        if (url.pathname.endsWith("/api/v1/remote/login/poll")) {
          if (!pending) throw new Error("missing pending flow");
          const flowId = body.flowId;
          const pendingCompletionSecret = body.pendingCompletionSecret;
          if (!flowId || !pendingCompletionSecret) throw new Error("missing pending poll body");
          pollCount += 1;
          if (pollCount > 1) server.approvePendingLogin({ operatorCode: pending.operatorCode });
          return Response.json(server.pollPendingLogin({ flowId, pendingCompletionSecret }));
        }
        if (url.pathname.endsWith("/api/v1/remote/login/complete")) {
          if (!pending) throw new Error("missing pending flow");
          const flowId = body.flowId;
          const pendingCompletionSecret = body.pendingCompletionSecret;
          if (!flowId || !pendingCompletionSecret) throw new Error("missing pending complete body");
          return Response.json(
            server.completePendingLogin({
              hostUrl: "https://caplets.example.com",
              flowId,
              pendingCompletionSecret,
            }),
          );
        }
        throw new Error(`unexpected request ${url.pathname}`);
      },
      writeOut: (value) => out.push(value),
    });

    expect(requests).toContain("/api/v1/remote/login/refresh");
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
      runCli(["remote", "login", "https://caplets.example.com", "--json"], {
        authDir,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
          if (url.pathname.endsWith("/api/v1/remote/login/start")) {
            pending = server.createPendingLogin({ hostUrl: "https://caplets.example.com" });
            server.denyPendingLogin({ operatorCode: pending.operatorCode });
            return Response.json(pending);
          }
          if (url.pathname.endsWith("/api/v1/remote/login/poll")) {
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
      runCli(["remote", "login", "https://caplets.example.com", "--json"], {
        authDir,
        signal: controller.signal,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          requests.push(url.pathname);
          const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};
          if (url.pathname.endsWith("/api/v1/remote/login/start")) {
            pending = server.createPendingLogin({ hostUrl: "https://caplets.example.com" });
            controller.abort();
            return Response.json(pending);
          }
          if (url.pathname.endsWith("/api/v1/remote/login/cancel")) {
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
      "/api/v1/remote/login/start",
      "/api/v1/remote/login/poll",
      "/api/v1/remote/login/cancel",
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

  it("logs out a stored Current Host Remote Profile", async () => {
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
    }).saveRemoteProfile({
      origin: "https://caplets.example.com",
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
        expect(String(input)).toBe("https://caplets.example.com/api/v1/remote/client");
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
      key: "remote:https://caplets.example.com",
      origin: "https://caplets.example.com",
    });
  });

  it("refreshes expired Current Host credentials before logout revoke", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const server = new RemoteServerCredentialStore({ dir: tempDir("caplets-remote-cli-server-") });
    const issued = server.createPairingCode({ hostUrl: "https://caplets.example.com" });
    const credentials = server.exchangePairingCode({
      hostUrl: "https://caplets.example.com/",
      code: issued.code,
    });
    await new FileRemoteProfileStore({
      root: join(authDir, "remote-profiles"),
    }).saveRemoteProfile({
      origin: "https://caplets.example.com",
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
        if (url.pathname.endsWith("/api/v1/remote/refresh")) {
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
      { path: "/api/v1/remote/refresh", authorization: null },
      {
        path: "/api/v1/remote/client",
        authorization: expect.stringMatching(/^Bearer (?!expired-access-token)/u),
      },
    ]);
  });

  it("prints paired Current Host client labels without terminal control bytes", async () => {
    const { env, store } = await remoteSecurityFixture();
    const issued = await store.createPairingCode({ hostUrl: "https://caplets.example.com" });
    await store.exchangePairingCode({
      hostUrl: "https://caplets.example.com",
      code: issued.code,
      clientLabel: `Bad${String.fromCharCode(0x1b)}[31mName${String.fromCharCode(0x07)}`,
    });
    const out: string[] = [];

    await runCli(["remote", "host", "clients"], {
      env,
      writeOut: (value) => out.push(value),
    });

    expect(out.join("")).not.toContain(String.fromCharCode(0x1b));
    expect(out.join("")).not.toContain(String.fromCharCode(0x07));
    expect(out.join("")).toContain("Bad?[31mName?");
  });

  it("lists and approves pending Current Host logins from server state", async () => {
    const { env, store } = await remoteSecurityFixture();
    const pending = await store.createPendingLogin({
      hostUrl: "https://caplets.example.com",
      clientLabel: `Bad${String.fromCharCode(0x1b)}[31mDevice`,
      clientFingerprint: "fp_test",
      sourceHint: "127.0.0.1",
    });
    const listOut: string[] = [];

    await runCli(["remote", "host", "logins", "--json"], {
      env,
      writeOut: (value) => listOut.push(value),
    });

    expect(JSON.parse(listOut.join(""))).toMatchObject({
      pendingLogins: [
        {
          flowId: pending.flowId,
          status: "pending",
          requestedRole: "access",
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
    await runCli(["remote", "host", "logins"], {
      env,
      writeOut: (value) => plainListOut.push(value),
    });
    expect(plainListOut.join("")).toContain(pending.operatorCodeFingerprint);
    expect(plainListOut.join("")).not.toContain(pending.operatorCode);

    const approveOut: string[] = [];
    await runCli(["remote", "host", "approve", pending.operatorCode, "--yes", "--json"], {
      env,
      writeOut: (value) => approveOut.push(value),
    });

    expect(JSON.parse(approveOut.join(""))).toMatchObject({
      flowId: pending.flowId,
      status: "approved",
      requestedRole: "access",
      grantedRole: "access",
      clientLabel: `Bad${String.fromCharCode(0x1b)}[31mDevice`,
    });
    expect(
      await store.completePendingLogin({
        hostUrl: "https://caplets.example.com",
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
      }),
    ).toMatchObject({ clientLabel: `Bad${String.fromCharCode(0x1b)}[31mDevice`, role: "access" });
  });

  it("allows host approval to override requested login roles", async () => {
    const { env, store } = await remoteSecurityFixture();
    const pending = await store.createPendingLogin({
      hostUrl: "https://caplets.example.com",
      requestedRole: "operator",
      clientLabel: "Dashboard",
    });
    const approveOut: string[] = [];

    await runCli(
      ["remote", "host", "approve", pending.operatorCode, "--role", "access", "--yes", "--json"],
      { env, writeOut: (value) => approveOut.push(value) },
    );

    expect(JSON.parse(approveOut.join(""))).toMatchObject({
      flowId: pending.flowId,
      requestedRole: "operator",
      grantedRole: "access",
    });
    expect(
      await store.completePendingLogin({
        hostUrl: "https://caplets.example.com",
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
      }),
    ).toMatchObject({ role: "access" });
  });

  it("treats a former product hostname as an ordinary Current Host origin", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    const requests: string[] = [];
    const out: string[] = [];

    await runCli(["remote", "login", "https://cloud.caplets.dev", "--json"], {
      authDir,
      fetch: async (input) => {
        const url = new URL(String(input));
        requests.push(url.pathname);
        if (url.pathname === "/api/v1/remote/login/start") {
          return Response.json({
            flowId: "rlogin_former_host",
            operatorCode: "cap_login_former_host",
            pendingRefreshSecret: "cap_pending_refresh_secret",
            pendingCompletionSecret: "cap_pending_complete_secret",
            codeExpiresAt: "2999-01-01T00:00:00.000Z",
            flowExpiresAt: "2999-01-02T00:00:00.000Z",
            intervalSeconds: 0,
          });
        }
        if (url.pathname === "/api/v1/remote/login/poll") {
          return Response.json({ status: "approved" });
        }
        if (url.pathname === "/api/v1/remote/login/complete") {
          return Response.json({
            origin: "https://cloud.caplets.dev",
            clientId: "rcli_former_host",
            clientLabel: "Former Host",
            accessToken: "access-secret",
            refreshToken: "refresh-secret",
          });
        }
        throw new Error(`unexpected request ${url.pathname}`);
      },
      writeOut: (value) => out.push(value),
    });

    expect(requests).toEqual([
      "/api/v1/remote/login/start",
      "/api/v1/remote/login/poll",
      "/api/v1/remote/login/complete",
    ]);
    expect(JSON.parse(out.at(-1) ?? "{}")).toMatchObject({
      authenticated: true,
      key: "remote:https://cloud.caplets.dev",
      origin: "https://cloud.caplets.dev",
    });
    expect(out.join("")).not.toContain("access-secret");
    expect(out.join("")).not.toContain("refresh-secret");
  });

  it("lists saved Remote Profiles without requiring an origin", async () => {
    const authDir = tempDir("caplets-remote-cli-auth-");
    await new FileRemoteProfileStore({
      root: join(authDir, "remote-profiles"),
    }).saveRemoteProfile({
      origin: "https://caplets.example.com",
      clientId: "rcli_123",
      clientLabel: "Test Device",
      credentials: {
        accessToken: "remote-access",
        refreshToken: "remote-refresh",
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
    });
    const out: string[] = [];

    await runCli(["remote", "list", "--json"], {
      authDir,
      writeOut: (value) => out.push(value),
    });

    expect(JSON.parse(out.join(""))).toMatchObject({
      profiles: [
        {
          authenticated: true,
          key: "remote:https://caplets.example.com",
          origin: "https://caplets.example.com",
          clientLabel: "Test Device",
        },
      ],
    });
    expect(out.join("")).not.toContain("remote-access");
    expect(out.join("")).not.toContain("remote-refresh");
  });
});

async function remoteSecurityFixture(): Promise<{
  env: { CAPLETS_CONFIG: string };
  store: RemoteSecurityStore;
}> {
  const root = tempDir("caplets-remote-cli-server-");
  const databasePath = join(root, "host.sqlite3");
  const configPath = join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({ storage: { type: "sqlite", path: databasePath } }));
  const storage = await createHostStorage({ type: "sqlite", path: databasePath });
  storages.add(storage);
  return { env: { CAPLETS_CONFIG: configPath }, store: storage.remoteSecurity };
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
