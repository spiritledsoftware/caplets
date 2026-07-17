import { afterEach, describe, expect, it, vi } from "vitest";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CloudAuthStore } from "../src/cloud-auth/store";
import { runCli as runCliCommand } from "../src/cli";
import { doctorJsonReport, formatDoctorReport } from "../src/cli/doctor";
import { hostedCredentials, tempCloudAuthPath } from "./fixtures/cloud-auth";
import { FileRemoteProfileStore } from "../src/remote/profile-store";
import * as configModule from "../src/config";
import type { VaultQuarantineOutcome } from "../src/config";
import type { ControlPlaneRuntimeSnapshot } from "../src/control-plane/snapshot";
import type { ExposureProjection } from "../src/exposure/projection";

const isolatedDoctorRoots: string[] = [];

afterEach(() => {
  for (const root of isolatedDoctorRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function runCli(
  args: string[],
  io: {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    authDir?: string;
    fetch?: typeof fetch;
    writeOut?: (value: string) => void;
    writeErr?: (value: string) => void;
  },
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "caplets-doctor-cli-isolated-"));
  isolatedDoctorRoots.push(root);
  const configPath = io.env?.CAPLETS_CONFIG ?? join(root, "config.json");
  const projectConfigPath = join(root, "project", ".caplets", "config.json");
  mkdirSync(dirname(projectConfigPath), { recursive: true });
  if (!io.env?.CAPLETS_CONFIG) {
    writeFileSync(
      configPath,
      JSON.stringify({
        serve: { storage: { kind: "sqlite", stateRoot: join(root, "sql") } },
        httpApis: {
          doctor_fixture: {
            name: "Doctor fixture",
            description: "Isolated activated doctor fixture.",
            baseUrl: "https://doctor.example",
            auth: { type: "none" },
            actions: { check: { method: "GET", path: "/healthz" } },
          },
        },
      }),
    );
    writeFileSync(projectConfigPath, "{}");
  } else {
    writeFileSync(projectConfigPath, "{}");
  }
  const effectiveConfig = configModule.parseConfig({
    options: {
      exposure: "progressive",
      exposureDiscoveryTimeoutMs: 5_000,
      exposureDiscoveryConcurrency: 4,
    },
    httpApis: {
      doctor_fixture: {
        name: "Doctor fixture",
        description: "Isolated activated doctor fixture.",
        baseUrl: "https://doctor.example",
        auth: { type: "none" },
        actions: { check: { method: "GET", path: "/healthz" } },
      },
    },
  });
  await runCliCommand(args, {
    ...io,
    env: {
      XDG_CONFIG_HOME: join(root, "config-home"),
      XDG_STATE_HOME: join(root, "state-home"),
      XDG_CACHE_HOME: join(root, "cache-home"),
      CAPLETS_CONFIG: configPath,
      CAPLETS_PROJECT_CONFIG: projectConfigPath,
      ...io.env,
    },
    internalDoctorRuntime: {
      snapshot: {
        config: effectiveConfig,
      } as unknown as ControlPlaneRuntimeSnapshot,
      exposure: {
        availability: { state: "ready" },
        entries: [],
        hiddenCaplets: [],
        routes: new Map(),
      } as ExposureProjection,
    },
  });
}

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
      projectBinding: {
        authMode: "hosted_cloud",
        sessionSupport: "unknown",
        recoveryCommand: "caplets attach --once",
      },
    });
  });

  it("supports shared format aliases", async () => {
    const jsonOut: string[] = [];
    const markdownOut: string[] = [];
    const plainOut: string[] = [];

    await runCli(["doctor", "--format", "json"], {
      env: {},
      writeOut: (value) => jsonOut.push(value),
    });
    await runCli(["doctor", "--format", "md"], {
      env: {},
      writeOut: (value) => markdownOut.push(value),
    });
    await runCli(["doctor", "--format", "plain"], {
      env: {},
      writeOut: (value) => plainOut.push(value),
    });

    expect(JSON.parse(jsonOut.join(""))).toMatchObject({
      server: { configured: false },
      remote: { configured: false },
    });
    expect(markdownOut.join("")).toContain("## Server hosting");
    expect(plainOut.join("")).toContain("Server hosting");
  }, 15_000);

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

  it("reports supported Project Binding sessions for authenticated self-hosted remotes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-doctor-self-hosted-"));
    const authDir = join(dir, "auth");
    const out: string[] = [];
    const requests: Array<{ method: string; path: string }> = [];
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
        fetch: async (url, init) => {
          requests.push({
            method: init?.method ?? "GET",
            path: new URL(String(url)).pathname,
          });
          if (String(url).endsWith("/v1/attach/project-bindings/sessions")) {
            return Response.json(
              { ok: false, error: { code: "REQUEST_INVALID" } },
              { status: 400 },
            );
          }
          return Response.json({ ok: true });
        },
        writeOut: (value) => out.push(value),
      });

      const report = out.join("");
      expect(report).toContain("Auth mode: self_hosted_remote");
      expect(report).toContain("Session support: supported");
      expect(report).toContain("Recovery: caplets attach --once");
      expect(report).not.toContain("Self-hosted Project Binding sessions are not implemented");
      expect(requests).toEqual([{ method: "POST", path: "/v1/attach/project-bindings/sessions" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats non-201 2xx self-hosted Project Binding probe responses as supported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-doctor-self-hosted-"));
    const authDir = join(dir, "auth");
    const out: string[] = [];
    try {
      await saveSelfHostedProfile(authDir);

      await runCli(["doctor", "--json"], {
        authDir,
        env: {
          CAPLETS_MODE: "remote",
          CAPLETS_REMOTE_URL: "http://127.0.0.1:5387",
          XDG_STATE_HOME: join(dir, "state"),
        },
        fetch: async () => new Response(null, { status: 204 }),
        writeOut: (value) => out.push(value),
      });

      expect(JSON.parse(out.join(""))).toMatchObject({
        projectBinding: {
          authMode: "self_hosted_remote",
          sessionSupport: "supported",
          lastUpgradeError: null,
          recoveryCommand: "caplets attach --once",
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces malformed Project Binding diagnostic session responses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-doctor-self-hosted-"));
    const authDir = join(dir, "auth");
    const out: string[] = [];
    try {
      await saveSelfHostedProfile(authDir);

      await runCli(["doctor", "--json"], {
        authDir,
        env: {
          CAPLETS_MODE: "remote",
          CAPLETS_REMOTE_URL: "http://127.0.0.1:5387",
          XDG_STATE_HOME: join(dir, "state"),
        },
        fetch: async () => Response.json({ binding: { bindingId: "binding_1" } }, { status: 201 }),
        writeOut: (value) => out.push(value),
      });

      expect(JSON.parse(out.join(""))).toMatchObject({
        projectBinding: {
          authMode: "self_hosted_remote",
          sessionSupport: "unknown",
          lastUpgradeError:
            "Project Binding diagnostic session response was missing bindingId or sessionId; cleanup was not attempted.",
          recoveryCommand: "caplets doctor",
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces Project Binding diagnostic session cleanup failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-doctor-self-hosted-"));
    const authDir = join(dir, "auth");
    const out: string[] = [];
    try {
      await saveSelfHostedProfile(authDir);

      await runCli(["doctor", "--json"], {
        authDir,
        env: {
          CAPLETS_MODE: "remote",
          CAPLETS_REMOTE_URL: "http://127.0.0.1:5387",
          XDG_STATE_HOME: join(dir, "state"),
        },
        fetch: async (url, init) => {
          if (init?.method === "DELETE") return Response.json({ ok: false }, { status: 503 });
          if (String(url).endsWith("/v1/attach/project-bindings/sessions")) {
            return Response.json(
              { binding: { bindingId: "binding_1" }, sessionId: "session_1" },
              { status: 201 },
            );
          }
          return Response.json({ ok: true });
        },
        writeOut: (value) => out.push(value),
      });

      expect(JSON.parse(out.join(""))).toMatchObject({
        projectBinding: {
          authMode: "self_hosted_remote",
          sessionSupport: "unknown",
          lastUpgradeError: "Project Binding diagnostic cleanup returned 503.",
          recoveryCommand: "caplets doctor",
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounds self-hosted Project Binding doctor probes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-doctor-self-hosted-"));
    const authDir = join(dir, "auth");
    try {
      await saveSelfHostedProfile(authDir);

      const report = await doctorJsonReport({
        authDir,
        env: {
          CAPLETS_MODE: "remote",
          CAPLETS_REMOTE_URL: "http://127.0.0.1:5387",
          XDG_STATE_HOME: join(dir, "state"),
        },
        projectBindingProbeTimeoutMs: 1,
        fetch: async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      });

      expect(report.projectBinding).toMatchObject({
        authMode: "self_hosted_remote",
        sessionSupport: "unknown",
        lastUpgradeError: "Project Binding session probe timed out after 1ms.",
        recoveryCommand: "caplets doctor",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires Remote Login before probing self-hosted Project Binding sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-doctor-self-hosted-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(configPath, "{}");

      await runCli(["doctor", "--json"], {
        authDir: join(dir, "auth"),
        env: {
          CAPLETS_MODE: "remote",
          CAPLETS_REMOTE_URL: "http://127.0.0.1:5387",
          CAPLETS_CONFIG: configPath,
          XDG_STATE_HOME: join(dir, "state"),
        },
        writeOut: (value) => out.push(value),
      });

      const report = JSON.parse(out.join(""));
      expect(report.remoteLogin).toMatchObject({
        kind: "self-hosted",
        authenticated: false,
      });
      expect(report.projectBinding).toMatchObject({
        authMode: "remote_login_required",
        sessionSupport: "unknown",
        recoveryCommand: "caplets remote login http://127.0.0.1:5387/",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports unsupported Project Binding sessions when an authenticated self-hosted remote lacks the route", async () => {
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

      await runCli(["doctor", "--json"], {
        authDir,
        env: {
          CAPLETS_MODE: "remote",
          CAPLETS_REMOTE_URL: "http://127.0.0.1:5387",
          XDG_STATE_HOME: join(dir, "state"),
        },
        fetch: async () => Response.json({ ok: false }, { status: 404 }),
        writeOut: (value) => out.push(value),
      });

      expect(JSON.parse(out.join(""))).toMatchObject({
        projectBinding: {
          authMode: "self_hosted_remote",
          sessionSupport: "unsupported",
          lastUpgradeError: "Project Binding session endpoint returned 404.",
          recoveryCommand: "Upgrade the remote Caplets service and rerun caplets doctor.",
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports unresolved local Vault references with repair commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-doctor-vault-"));
    const configPath = join(dir, "config.json");
    const projectConfigPath = join(dir, "project", ".caplets", "config.json");
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

      const doctorOptions = {
        env: {
          CAPLETS_CONFIG: configPath,
          CAPLETS_PROJECT_CONFIG: projectConfigPath,
          XDG_CONFIG_HOME: join(dir, "config-home"),
          XDG_STATE_HOME: join(dir, "state"),
          XDG_CACHE_HOME: join(dir, "cache-home"),
        },
        cwd: dir,
      };
      const report = await doctorJsonReport(doctorOptions);
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

      const plain = await formatDoctorReport(doctorOptions);
      expect(plain).toContain(
        "github: ungranted GH_TOKEN (caplets vault access grant GH_TOKEN github)",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("maps structured Vault outcomes into Doctor JSON and Markdown without warning parsing", async () => {
    const configPath = "/tmp/caplets-doctor-structured-config.json";
    const warnings: VaultQuarantineOutcome[] = [
      {
        type: "vault-quarantine",
        kind: "project-file" as const,
        path: "/tmp/caplets-project/.caplets/github/CAPLET.md",
        message: "Human wording and punctuation do not encode Vault facts",
        recoverable: true as const,
        capletId: "github",
        referencePath: "mcpServers.github.env.GH_TOKEN",
        referenceName: "GH_TOKEN",
        storedKey: "GH_TOKEN_PERSONAL",
        effectiveKey: "GH_TOKEN_PERSONAL",
        reason: "ungranted" as const,
        target: "remote" as const,
      },
      {
        type: "vault-quarantine",
        kind: "global-config" as const,
        path: configPath,
        message: "No regular-expression recovery data appears here",
        recoverable: true as const,
        capletId: "missing",
        referencePath: "mcpServers.missing.env.TOKEN",
        referenceName: "MISSING_TOKEN",
        effectiveKey: "MISSING_TOKEN",
        reason: "missing" as const,
        target: "global" as const,
      },
      {
        type: "vault-quarantine",
        kind: "project-config" as const,
        path: "/tmp/caplets-project/.caplets/config.json",
        message: "The value is intentionally omitted from this outcome",
        recoverable: true as const,
        capletId: "unavailable",
        referencePath: "mcpServers.unavailable.env.TOKEN",
        referenceName: "UNAVAILABLE_TOKEN",
        effectiveKey: "UNAVAILABLE_TOKEN",
        reason: "unavailable" as const,
        target: "global" as const,
      },
      {
        type: "vault-quarantine",
        kind: "global-file" as const,
        path: "/tmp/caplets-invalid.md",
        message: "The key-source wording is irrelevant to this diagnostic",
        recoverable: true as const,
        capletId: "invalid",
        referencePath: "mcpServers.invalid.env.TOKEN",
        referenceName: "invalid_key",
        effectiveKey: "invalid_key",
        reason: "invalid-key-source" as const,
        target: "global" as const,
      },
    ];
    const loader = vi.spyOn(configModule, "loadLocalOverlayConfigWithSources").mockReturnValue({
      config: configModule.parseConfig({}),
      sources: {},
      shadows: {},
      sourceFound: true,
      warnings,
    });
    try {
      const report = await doctorJsonReport({
        env: {
          CAPLETS_CONFIG: configPath,
          CAPLETS_PROJECT_CONFIG: "/tmp/caplets-project/.caplets/config.json",
        },
      });

      expect(report.vault).toEqual({
        ok: false,
        issues: [
          {
            capletId: "github",
            reason: "ungranted",
            key: "GH_TOKEN_PERSONAL",
            configPath: "/tmp/caplets-project/.caplets/github/CAPLET.md",
            referencePath: "mcpServers.github.env.GH_TOKEN",
            target: "remote",
            recoveryCommand:
              "caplets vault access grant GH_TOKEN_PERSONAL github --remote --as GH_TOKEN",
          },
          {
            capletId: "missing",
            reason: "missing",
            key: "MISSING_TOKEN",
            configPath,
            referencePath: "mcpServers.missing.env.TOKEN",
            target: "global",
            recoveryCommand: "caplets vault set MISSING_TOKEN",
          },
          {
            capletId: "unavailable",
            reason: "unavailable",
            key: "UNAVAILABLE_TOKEN",
            configPath: "/tmp/caplets-project/.caplets/config.json",
            referencePath: "mcpServers.unavailable.env.TOKEN",
            target: "global",
            recoveryCommand: "caplets vault access grant UNAVAILABLE_TOKEN unavailable",
          },
          {
            capletId: "invalid",
            reason: "invalid-key-source",
            key: "invalid_key",
            configPath: "/tmp/caplets-invalid.md",
            referencePath: "mcpServers.invalid.env.TOKEN",
            target: "global",
            recoveryCommand: "caplets doctor",
          },
        ],
      });
      expect(JSON.stringify(report.vault)).not.toContain("secret");
    } finally {
      loader.mockRestore();
    }
  });

  it("reports Vault loader failure without fabricating Doctor issues", async () => {
    const loader = vi
      .spyOn(configModule, "loadLocalOverlayConfigWithSources")
      .mockImplementation(() => {
        throw new Error("Vault overlay loader failed");
      });
    try {
      await expect(doctorJsonReport({ env: {} })).resolves.toMatchObject({
        vault: {
          ok: false,
          issues: [],
          message: "Vault overlay loader failed",
        },
      });
    } finally {
      loader.mockRestore();
    }
  });

  it("reports nonrecoverable best-effort overlay warnings as Vault loader failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-doctor-vault-loader-failure-"));
    const configPath = join(dir, "config.json");
    try {
      writeFileSync(configPath, "{ malformed JSON");

      await expect(
        doctorJsonReport({
          env: {
            CAPLETS_CONFIG: configPath,
            CAPLETS_PROJECT_CONFIG: join(dir, "project", ".caplets", "config.json"),
          },
        }),
      ).resolves.toMatchObject({
        vault: {
          ok: false,
          issues: [],
          message: expect.stringContaining("not valid JSON"),
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps Vault diagnostics OK for recoverable non-Vault overlay warnings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-doctor-vault-recoverable-warning-"));
    const configPath = join(dir, "config.json");
    const missingEnvName = "CAPLETS_U4_DOCTOR_RECOVERABLE_WARNING";
    const originalMissingEnv = process.env[missingEnvName];
    try {
      delete process.env[missingEnvName];
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            recoverable: {
              name: "Recoverable",
              description: "Only a missing environment variable.",
              command: "recoverable-mcp",
              env: { TOKEN: `$env:${missingEnvName}` },
            },
          },
        }),
      );

      await expect(
        doctorJsonReport({
          env: {
            CAPLETS_CONFIG: configPath,
            CAPLETS_PROJECT_CONFIG: join(dir, "project", ".caplets", "config.json"),
          },
        }),
      ).resolves.toMatchObject({
        vault: { ok: true, issues: [] },
      });
    } finally {
      if (originalMissingEnv === undefined) {
        delete process.env[missingEnvName];
      } else {
        process.env[missingEnvName] = originalMissingEnv;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports project-bound Caplets as missing session context in exposure diagnostics", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-doctor-project-binding-"));
    const configPath = join(dir, "config.json");
    const projectConfigPath = join(dir, "project", ".caplets", "config.json");
    try {
      mkdirSync(dirname(projectConfigPath), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          serve: { storage: { kind: "sqlite", stateRoot: join(dir, "sql") } },
          cliTools: {
            workspace: {
              name: "Workspace",
              description: "Project workspace tools.",
              projectBinding: { required: true },
              actions: {
                cwd: { command: process.execPath },
              },
            },
          },
        }),
      );
      writeFileSync(projectConfigPath, "{}");

      const report = await doctorJsonReport({
        env: {
          CAPLETS_CONFIG: configPath,
          CAPLETS_PROJECT_CONFIG: projectConfigPath,
          XDG_CONFIG_HOME: join(dir, "config-home"),
          XDG_STATE_HOME: join(dir, "state-home"),
          XDG_CACHE_HOME: join(dir, "cache-home"),
        },
        cwd: join(dir, "project"),
      });

      expect(report.exposure).toMatchObject({
        caplets: [
          expect.objectContaining({
            id: "workspace",
            callable: false,
            hiddenReason: "project_binding_missing_context",
          }),
        ],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("waits for resolved callable projection entries and excludes failed discovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-doctor-callable-projection-"));
    const configPath = join(dir, "config.json");
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          serve: { storage: { kind: "sqlite", stateRoot: join(dir, "sql") } },
          options: { exposureDiscoveryTimeoutMs: 100 },
          mcpServers: {
            github: {
              name: "GitHub",
              description: "GitHub repo operations.",
              command: "node",
              exposure: "code_mode",
            },
          },
          openapiEndpoints: {
            unavailable: {
              name: "Unavailable API",
              description: "An unavailable OpenAPI service.",
              specUrl: "http://127.0.0.1:1/openapi.json",
              auth: { type: "none" },
              exposure: "code_mode",
            },
          },
        }),
      );

      const report = await doctorJsonReport({
        env: {
          CAPLETS_CONFIG: configPath,
          CAPLETS_PROJECT_CONFIG: join(dir, "project", ".caplets", "config.json"),
          XDG_CONFIG_HOME: join(dir, "config-home"),
          XDG_STATE_HOME: join(dir, "state-home"),
          XDG_CACHE_HOME: join(dir, "cache-home"),
        },
      });

      expect(report.exposure).toMatchObject({
        callableNativeToolCount: 1,
      });
      expect(report.codeMode).toMatchObject({
        callableIndex: { ok: true, callableCount: 1 },
      });
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
  it("derives activated exposure options from the effective SQL snapshot without residue reads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-doctor-sql-authority-"));
    const configPath = join(dir, "config.json");
    const projectConfigPath = join(dir, "project", ".caplets", "config.json");
    mkdirSync(dirname(projectConfigPath), { recursive: true });
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          options: {
            exposure: "direct",
            exposureDiscoveryTimeoutMs: 321,
            exposureDiscoveryConcurrency: 7,
          },
          httpApis: {
            sql_api: {
              name: "SQL API",
              description: "Effective SQL authority.",
              baseUrl: "https://sql.example",
              auth: { type: "none" },
              actions: { list: { method: "GET", path: "/items" } },
            },
          },
        }),
      );
      writeFileSync(projectConfigPath, "{}");
      const config = configModule.loadConfig(configPath, projectConfigPath);
      writeFileSync(
        configPath,
        JSON.stringify({
          options: {
            exposure: "progressive",
            exposureDiscoveryTimeoutMs: 999,
            exposureDiscoveryConcurrency: 1,
          },
          httpApis: {
            residue: {
              name: "Filesystem residue",
              description: "Must not be authoritative.",
              baseUrl: "https://residue.invalid",
              auth: { type: "none" },
              actions: { list: { method: "GET", path: "/items" } },
            },
          },
        }),
      );
      const snapshot = {
        config,
        configWithSources: { config, sources: {}, shadows: {} },
      } as unknown as ControlPlaneRuntimeSnapshot;
      const exposure = {
        availability: { state: "ready" },
        entries: [
          {
            kind: "direct-tool",
            capletId: "sql_api",
            route: { kind: "direct-tool", capletId: "sql_api", downstreamName: "list" },
          },
        ],
        hiddenCaplets: [],
      } as unknown as ExposureProjection;

      const report = await doctorJsonReport({
        env: {
          CAPLETS_CONFIG: configPath,
          CAPLETS_PROJECT_CONFIG: projectConfigPath,
          XDG_CONFIG_HOME: join(dir, "config-home"),
          XDG_STATE_HOME: join(dir, "state-home"),
          XDG_CACHE_HOME: join(dir, "cache-home"),
        },
        cwd: join(dir, "project"),
        effectiveRuntime: { snapshot, exposure },
      });

      expect(report.exposure).toMatchObject({
        ok: true,
        default: "direct",
        discoveryTimeoutMs: 321,
        discoveryConcurrency: 7,
        callableNativeToolCount: 1,
        caplets: [expect.objectContaining({ id: "sql_api", callable: true })],
      });
      expect(JSON.stringify(report.exposure)).not.toContain("residue");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function saveSelfHostedProfile(authDir: string): Promise<void> {
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
}
