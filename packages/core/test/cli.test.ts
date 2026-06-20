import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { version as packageJsonVersion } from "../package.json";
import { initConfig, installCaplets, normalizeGitRepo, runCli } from "../src/cli";
import { loadConfig, parseConfig } from "../src/config";
import type { CapletsError } from "../src/errors";
import { readTokenBundle, writeTokenBundle } from "../src/auth";
import { FileRemoteProfileStore } from "../src/remote/profile-store";

describe("cli init", () => {
  const originalMode = process.env.CAPLETS_MODE;
  const originalConfigPath = process.env.CAPLETS_CONFIG;
  const originalProjectConfigPath = process.env.CAPLETS_PROJECT_CONFIG;
  const originalServerUrl = process.env.CAPLETS_SERVER_URL;
  const originalServerUser = process.env.CAPLETS_SERVER_USER;
  const originalServerPassword = process.env.CAPLETS_SERVER_PASSWORD;

  beforeEach(() => {
    process.env.CAPLETS_MODE = "local";
    delete process.env.CAPLETS_CONFIG;
    delete process.env.CAPLETS_PROJECT_CONFIG;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalMode === undefined) {
      delete process.env.CAPLETS_MODE;
    } else {
      process.env.CAPLETS_MODE = originalMode;
    }
    if (originalConfigPath === undefined) {
      delete process.env.CAPLETS_CONFIG;
    } else {
      process.env.CAPLETS_CONFIG = originalConfigPath;
    }
    if (originalProjectConfigPath === undefined) {
      delete process.env.CAPLETS_PROJECT_CONFIG;
    } else {
      process.env.CAPLETS_PROJECT_CONFIG = originalProjectConfigPath;
    }
    if (originalServerUser === undefined) {
      delete process.env.CAPLETS_SERVER_USER;
    } else {
      process.env.CAPLETS_SERVER_USER = originalServerUser;
    }
    if (originalServerUrl === undefined) {
      delete process.env.CAPLETS_SERVER_URL;
    } else {
      process.env.CAPLETS_SERVER_URL = originalServerUrl;
    }
    if (originalServerPassword === undefined) {
      delete process.env.CAPLETS_SERVER_PASSWORD;
    } else {
      process.env.CAPLETS_SERVER_PASSWORD = originalServerPassword;
    }
  });

  it("writes a valid starter config and creates parent directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-init-"));
    const path = join(dir, "nested", "config.json");
    try {
      expect(initConfig({ path })).toBe(path);
      expect(existsSync(path)).toBe(true);

      const raw = readFileSync(path, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      const config = parseConfig(JSON.parse(raw));
      expect(config.mcpServers.example).toMatchObject({
        server: "example",
        name: "Example MCP Server",
        transport: "stdio",
        disabled: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not overwrite existing config unless forced", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-init-"));
    const path = join(dir, "config.json");
    try {
      writeFileSync(path, '{"existing":true}\n');

      expect(() => initConfig({ path })).toThrow(
        expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError,
      );
      expect(readFileSync(path, "utf8")).toBe('{"existing":true}\n');

      initConfig({ path, force: true });
      expect(JSON.parse(readFileSync(path, "utf8"))).toHaveProperty("mcpServers.example");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the project config by default when run through the CLI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-init-project-"));
    const projectRoot = join(dir, "project");
    const projectConfigPath = join(projectRoot, ".caplets", "config.json");
    const cwd = process.cwd();
    const out: string[] = [];
    try {
      mkdirSync(projectRoot, { recursive: true });
      process.chdir(projectRoot);
      const expectedConfigPath = join(process.cwd(), ".caplets", "config.json");

      await runCli(["init"], { writeOut: (value) => out.push(value) });

      expect(existsSync(projectConfigPath)).toBe(true);
      expect(out.join("")).toBe(`Created Caplets config at ${expectedConfigPath}\n`);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses CAPLETS_CONFIG with --global when run through the CLI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-init-"));
    const path = join(dir, "custom.json");
    const out: string[] = [];
    try {
      process.env.CAPLETS_CONFIG = path;

      await runCli(["init", "--global"], { writeOut: (value) => out.push(value) });

      expect(existsSync(path)).toBe(true);
      expect(out.join("")).toBe(`Created Caplets config at ${path}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported init arguments", async () => {
    await expect(runCli(["init", "--typo"], { writeErr: () => {} })).rejects.toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );
  });

  it("rejects the removed auth server alias", async () => {
    await expect(runCli(["auth", "remote"], { writeErr: () => {} })).rejects.toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );
  });

  it("rejects empty self-hosted remote login code from stdin", async () => {
    const fetchStub = vi.fn();

    await expect(
      runCli(["remote", "login", "https://caplets.example.com/caplets", "--code-stdin"], {
        readStdin: async () => " \n\t",
        fetch: fetchStub as unknown as typeof fetch,
        writeErr: () => {},
      }),
    ).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      message: "Pairing Code is required when --code-stdin is used.",
    } satisfies Partial<CapletsError>);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("prints parent command help without throwing", async () => {
    const out: string[] = [];

    await runCli(["config"], {
      writeOut: (value) => out.push(value),
      writeErr: (value) => out.push(value),
    });

    expect(out.join("")).toContain("Usage: caplets config");
    expect(out.join("")).toContain("Commands:");
  });

  it("prints the package version", async () => {
    const out: string[] = [];

    await runCli(["--version"], { writeOut: (value) => out.push(value) });

    expect(out.join("")).toBe(`${packageJsonVersion}\n`);
  });

  it("prints top-level help for no arguments", async () => {
    const out: string[] = [];

    await runCli([], {
      writeOut: (value) => out.push(value),
      writeErr: (value) => out.push(value),
    });

    expect(out.join("")).toContain("Usage: caplets");
    expect(out.join("")).toContain("Commands:");
    expect(out.join("")).toContain("serve");
  });

  it("describes the HTTP serve path as a service base path", async () => {
    const out: string[] = [];

    await runCli(["serve", "--help"], {
      writeOut: (value) => out.push(value),
      writeErr: (value) => out.push(value),
    });

    expect(out.join("")).toContain("HTTP service base path");
    expect(out.join("")).not.toContain("HTTP MCP endpoint path");
  });

  it("resolves serve defaults to stdio", async () => {
    const served: unknown[] = [];

    delete process.env.CAPLETS_SERVER_USER;
    delete process.env.CAPLETS_SERVER_PASSWORD;

    await runCli(["serve"], {
      writeOut: () => {},
      serve: async (options) => {
        served.push(options);
      },
    });

    expect(served).toEqual([{ transport: "stdio" }]);
  });

  it("resolves HTTP serve defaults", async () => {
    const served: unknown[] = [];

    delete process.env.CAPLETS_SERVER_URL;
    delete process.env.CAPLETS_SERVER_USER;
    delete process.env.CAPLETS_SERVER_PASSWORD;

    await runCli(["serve", "--transport", "http"], {
      writeOut: () => {},
      serve: async (options) => {
        served.push(options);
      },
    });

    expect(served).toEqual([
      expect.objectContaining({
        transport: "http",
        host: "127.0.0.1",
        port: 5387,
        path: "/",
        auth: { type: "remote_credentials" },
        remoteCredentialStateDir: expect.stringContaining("remote-server"),
      }),
    ]);
  });

  it("rejects HTTP-only serve options with stdio", async () => {
    await expect(
      runCli(["serve", "--transport", "stdio", "--port", "5387"], { writeErr: () => {} }),
    ).rejects.toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
  });

  it("lists enabled Caplets by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-list-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeInspectionConfig(configPath);
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["list"], { writeOut: (value) => out.push(value) });

      const text = out.join("");
      expect(text).toContain("Configured Caplets (4)");
      expect(text).toContain("Source:");
      expect(text).toContain("filesystem");
      expect(text).toContain("mcp");
      expect(text).toContain("not_started");
      expect(text).toContain("global-config");
      expect(text).toContain("Project Files");
      expect(text).toContain("users");
      expect(text).toContain("openapi");
      expect(text).toContain("catalog");
      expect(text).toContain("graphql");
      expect(text).toContain("drive");
      expect(text).toContain("googleDiscovery");
      expect(text).not.toContain("disabled_remote");
      expect(text).not.toContain("secret-access-token");
      expect(text).not.toContain("openapi-client");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can include disabled Caplets in the list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-list-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeInspectionConfig(configPath);
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["list", "--all"], { writeOut: (value) => out.push(value) });

      const text = out.join("");
      expect(text).toContain("disabled_remote");
      expect(text).toContain("disabled");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints listed Caplets as JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-list-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeInspectionConfig(configPath);
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["list", "--json"], { writeOut: (value) => out.push(value) });

      const rows = JSON.parse(out.join("")) as Array<{
        server: string;
        backend: string;
        name: string;
        description: string;
        disabled: boolean;
        status: string;
        source: string;
        path: string | null;
        shadows: Array<{ kind: string; path: string }>;
      }>;
      expect(rows).toEqual([
        expect.objectContaining({
          server: "catalog",
          backend: "graphql",
          disabled: false,
          status: "not_started",
          source: "global-config",
          path: configPath,
          shadows: [],
        }),
        expect.objectContaining({
          server: "drive",
          backend: "googleDiscovery",
          disabled: false,
          status: "not_started",
          source: "global-config",
          path: configPath,
          shadows: [],
        }),
        expect.objectContaining({
          server: "filesystem",
          backend: "mcp",
          disabled: false,
          status: "not_started",
          source: "global-config",
          path: configPath,
          shadows: [],
        }),
        expect.objectContaining({
          server: "users",
          backend: "openapi",
          disabled: false,
          status: "not_started",
          source: "global-config",
          path: configPath,
          shadows: [],
        }),
      ]);
      expect(out.join("")).not.toContain("secret-access-token");
      expect(out.join("")).not.toContain("openapi-client");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints source warnings when project Caplets shadow global Caplets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-list-sources-"));
    const cwd = process.cwd();
    const userRoot = join(dir, "user");
    const projectRoot = join(dir, "project");
    const configPath = join(userRoot, "config.json");
    const projectCapletPath = join(projectRoot, ".caplets", "github.md");
    const out: string[] = [];
    try {
      mkdirSync(userRoot, { recursive: true });
      mkdirSync(dirname(projectCapletPath), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            github: {
              name: "GitHub Global",
              description: "Use GitHub globally.",
              command: "global-github",
            },
          },
        }),
      );
      writeFileSync(
        projectCapletPath,
        [
          "---",
          "name: GitHub Project",
          "description: Use GitHub from this project.",
          "mcpServer:",
          "  command: project-github",
          "---",
          "# GitHub Project",
        ].join("\n"),
      );
      process.env.CAPLETS_CONFIG = configPath;
      process.chdir(projectRoot);

      await runCli(["list"], { writeOut: (value) => out.push(value) });

      const text = out.join("");
      expect(text).toContain("Configured Caplets (1)");
      expect(text).toContain("Source:");
      expect(text).toContain("github");
      expect(text).toContain("project-file");
      expect(text).toContain(
        `Warning: project Caplet github shadows global Caplet at ${configPath}`,
      );
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints JSON source and shadow metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-list-json-sources-"));
    const cwd = process.cwd();
    const userRoot = join(dir, "user");
    const projectRoot = join(dir, "project");
    const configPath = join(userRoot, "config.json");
    const projectCapletPath = join(projectRoot, ".caplets", "github.md");
    const out: string[] = [];
    try {
      mkdirSync(userRoot, { recursive: true });
      mkdirSync(dirname(projectCapletPath), { recursive: true });
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            github: {
              name: "GitHub Global",
              description: "Use GitHub globally.",
              command: "global-github",
            },
          },
        }),
      );
      writeFileSync(
        projectCapletPath,
        [
          "---",
          "name: GitHub Project",
          "description: Use GitHub from this project.",
          "mcpServer:",
          "  command: project-github",
          "---",
          "# GitHub Project",
        ].join("\n"),
      );
      process.env.CAPLETS_CONFIG = configPath;
      process.chdir(projectRoot);
      const expectedProjectCapletPath = join(process.cwd(), ".caplets", "github.md");

      await runCli(["list", "--json"], { writeOut: (value) => out.push(value) });

      expect(JSON.parse(out.join(""))).toEqual([
        expect.objectContaining({
          server: "github",
          source: "project-file",
          path: expectedProjectCapletPath,
          shadows: [{ kind: "global-config", path: configPath }],
        }),
      ]);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors CAPLETS_PROJECT_CONFIG when listing local Caplets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-list-project-env-"));
    const configPath = join(dir, "user", "config.json");
    const projectConfigPath = join(dir, "custom-project", "config.json");
    const out: string[] = [];
    try {
      mkdirSync(dirname(configPath), { recursive: true });
      mkdirSync(dirname(projectConfigPath), { recursive: true });
      writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
      writeFileSync(
        projectConfigPath,
        JSON.stringify({
          mcpServers: {
            project_env: {
              name: "Project Env",
              description: "Loaded from CAPLETS_PROJECT_CONFIG.",
              command: "project-env",
            },
          },
        }),
      );

      await runCli(["list", "--json"], {
        env: { CAPLETS_CONFIG: configPath, CAPLETS_PROJECT_CONFIG: projectConfigPath },
        writeOut: (value) => out.push(value),
      });

      expect(JSON.parse(out.join(""))).toEqual([
        expect.objectContaining({
          server: "project_env",
          source: "project-config",
          path: projectConfigPath,
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints the effective config path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-config-path-"));
    const configPath = join(dir, "custom.json");
    const out: string[] = [];
    try {
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["config", "path"], { writeOut: (value) => out.push(value) });

      expect(out.join("")).toBe(`${configPath}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints resolved config paths as JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-config-paths-"));
    const configPath = join(dir, "custom.json");
    const authDir = join(dir, "auth");
    const out: string[] = [];
    try {
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["config", "paths", "--json"], {
        writeOut: (value) => out.push(value),
        authDir,
      });

      expect(JSON.parse(out.join(""))).toEqual({
        userConfig: configPath,
        projectConfig: join(process.cwd(), ".caplets", "config.json"),
        userRoot: dir,
        stateRoot: dirname(authDir),
        projectRoot: join(process.cwd(), ".caplets"),
        authDir,
        envConfig: configPath,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors CAPLETS_PROJECT_CONFIG when printing resolved config paths as JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-config-paths-project-env-"));
    const configPath = join(dir, "user", "config.json");
    const projectConfigPath = join(dir, "custom-project", "config.json");
    const authDir = join(dir, "auth");
    const out: string[] = [];
    try {
      await runCli(["config", "paths", "--json"], {
        env: { CAPLETS_CONFIG: configPath, CAPLETS_PROJECT_CONFIG: projectConfigPath },
        writeOut: (value) => out.push(value),
        authDir,
      });

      expect(JSON.parse(out.join(""))).toMatchObject({
        userConfig: configPath,
        projectConfig: projectConfigPath,
        projectRoot: dirname(projectConfigPath),
        envConfig: configPath,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints resolved config paths for humans", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-config-paths-"));
    const configPath = join(dir, "custom.json");
    const authDir = join(dir, "state", "auth");
    const out: string[] = [];
    try {
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["config", "paths"], {
        writeOut: (value) => out.push(value),
        authDir,
      });

      expect(out.join("")).toBe(
        [
          "Caplets paths",
          "",
          `User config: ${configPath}`,
          `Project config: ${join(process.cwd(), ".caplets", "config.json")}`,
          `User root: ${dir}`,
          `State root: ${dirname(authDir)}`,
          `Project root: ${join(process.cwd(), ".caplets")}`,
          `Auth directory: ${authDir}`,
          `CAPLETS_CONFIG: ${configPath}`,
          "",
        ].join("\n"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("executes direct Caplet operation commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-call-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeCliOperationConfig(configPath);
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["inspect", "local", "--format", "json"], {
        writeOut: (value) => out.push(value),
      });
      await runCli(["check-backend", "local", "--format", "json"], {
        writeOut: (value) => out.push(value),
      });
      await runCli(["list-tools", "local", "--format", "json"], {
        writeOut: (value) => out.push(value),
      });
      await runCli(["search-tools", "local", "echo", "--limit", "1", "--format", "json"], {
        writeOut: (value) => out.push(value),
      });
      await runCli(["get-tool", "local.echo_json", "--format", "json"], {
        writeOut: (value) => out.push(value),
      });
      await runCli(
        [
          "call-tool",
          "local.echo_json",
          "--args",
          '{"message":"hello"}',
          "--field",
          "json.message",
          "--format",
          "json",
        ],
        { writeOut: (value) => out.push(value) },
      );

      const results = out.map((value) => JSON.parse(value));
      expect(results[0].id).toBe("local");
      expect(results[1]).toMatchObject({
        id: "local",
        status: "available",
        toolCount: 3,
      });
      expect(results[2].items).toHaveLength(3);
      expect(results[3]).toMatchObject({ query: "echo" });
      expect(results[3].items).toHaveLength(1);
      expect(results[4].tool.name).toBe("echo_json");
      expect(results[5].structuredContent).toEqual({ json: { message: "hello" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gets a CLI tool with split caplet and tool arguments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-cli-tool-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeCliOperationConfig(configPath);
      await runCli(["get-tool", "local", "echo_json", "--format", "json"], {
        env: { CAPLETS_CONFIG: configPath },
        writeOut: (value) => out.push(value),
      });

      expect(JSON.parse(out.join(""))).toMatchObject({ tool: { name: "echo_json" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("calls a CLI tool with split caplet and tool arguments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-cli-tool-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeCliOperationConfig(configPath);
      await runCli(
        [
          "call-tool",
          "local",
          "echo_json",
          "--args",
          JSON.stringify({ message: "hi" }),
          "--format",
          "json",
        ],
        {
          env: { CAPLETS_CONFIG: configPath },
          writeOut: (value) => out.push(value),
        },
      );

      expect(JSON.parse(out.join(""))).toMatchObject({
        structuredContent: { json: { message: "hi" } },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gets an MCP prompt with split caplet and prompt arguments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-remote-prompt-"));
    const authDir = join(dir, "auth");
    const requests: unknown[] = [];
    const out: string[] = [];
    const fetchMock = vi.fn(
      async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              description: "Review an issue.",
              messages: [{ role: "user", content: { type: "text", text: "Review CAP-123" } }],
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    );

    try {
      await new FileRemoteProfileStore({
        root: join(authDir, "remote-profiles"),
      }).saveSelfHostedProfile({
        hostUrl: "http://127.0.0.1:5387",
        clientId: "rcli_test",
        clientLabel: "Remote Prompt Test",
        credentials: {
          accessToken: "remote-profile-access-token",
          refreshToken: "remote-profile-refresh-token",
          tokenType: "Bearer",
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
      });
      await runCli(
        [
          "get-prompt",
          "linear",
          "review_issue",
          "--args",
          JSON.stringify({ issueId: "CAP-123" }),
          "--format",
          "json",
        ],
        {
          env: {
            CAPLETS_MODE: "remote",
            CAPLETS_REMOTE_URL: "http://127.0.0.1:5387",
            CAPLETS_CONFIG: join(dir, "missing-user-config.json"),
            CAPLETS_PROJECT_CONFIG: join(dir, "project", ".caplets", "config.json"),
          },
          authDir,
          fetch: fetchMock,
          writeOut: (value) => out.push(value),
        },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    expect(requests).toEqual([
      {
        command: "get_prompt",
        arguments: {
          caplet: "linear",
          request: {
            operation: "get_prompt",
            name: "review_issue",
            args: { issueId: "CAP-123" },
          },
        },
      },
    ]);
    expect(JSON.parse(out.join(""))).toMatchObject({ description: "Review an issue." });
  });

  it("prints agent-first summaries by default for direct Caplet operation commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-call-summary-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeCliOperationConfig(configPath);
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["inspect", "local"], { writeOut: (value) => out.push(value) });
      await runCli(["check-backend", "local"], { writeOut: (value) => out.push(value) });
      await runCli(["list-tools", "local"], { writeOut: (value) => out.push(value) });
      await runCli(["search-tools", "local", "echo", "--limit", "1"], {
        writeOut: (value) => out.push(value),
      });
      await runCli(["get-tool", "local.echo_json"], { writeOut: (value) => out.push(value) });
      await runCli(["call-tool", "local.no_args"], { writeOut: (value) => out.push(value) });

      expect(out.join("\n")).toContain("## Caplet `local`");
      expect(out.join("\n")).toContain("**Name:** Local CLI");
      expect(out.join("\n")).toContain("**Description:** Run local CLI tools.");
      expect(out.join("\n")).toContain("## Backend `local`");
      expect(out.join("\n")).toContain("- Status: available");
      expect(out.join("\n")).toContain("## Tools for `local`");
      expect(out.join("\n")).toContain("- `echo_json`");
      expect(out.join("\n")).toContain("Print JSON from the provided message");
      expect(out[2]).not.toContain("Second sentence should not appear");
      expect(out[3]).not.toContain("Second sentence should not appear");
      expect(out.join("\n")).toContain('## Matches for "echo" in `local`');
      expect(out.join("\n")).toContain("## Tool `local.echo_json`");
      expect(out.join("\n")).toContain("- type object; properties message; required message");
      expect(out.join("\n")).toContain("- type object; properties json; no required fields");
      expect(out.join("\n")).toContain("- Full schema: add `--format json`");
      expect(out.join("\n")).toContain("## Call `local.no_args`");
      expect(out.join("\n")).toContain("- Result: ok: true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports plain and md format aliases for direct Caplet operation commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-call-format-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeCliOperationConfig(configPath);
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["inspect", "local", "--format", "plain"], {
        writeOut: (value) => out.push(value),
      });
      await runCli(["list-tools", "local", "--format", "md"], {
        writeOut: (value) => out.push(value),
      });

      expect(out[0]).toContain("Caplet: local");
      expect(out[0]).not.toContain("## Caplet");
      expect(out[1]).toContain("## Tools for `local`");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults omitted call-tool args to an empty object", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-call-default-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeCliOperationConfig(configPath);
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["call-tool", "local.no_args", "--format", "json"], {
        writeOut: (value) => out.push(value),
      });

      expect(JSON.parse(out.join(""))).toMatchObject({
        isError: false,
        structuredContent: { json: { ok: true } },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets exit code for downstream tool errors after printing a default summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-call-error-summary-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    const exitCodes: number[] = [];
    try {
      writeCliOperationConfig(configPath);
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["call-tool", "local.fail"], {
        writeOut: (value) => out.push(value),
        setExitCode: (code) => exitCodes.push(code),
      });

      expect(out.join("")).toContain("## Call `local.fail`");
      expect(out.join("")).toContain("- Status: failed");
      expect(out.join("")).toContain("Exit code: 7");
      expect(out.join("")).toContain("- Result: out");
      expect(out.join("")).toContain("Use `--format json` to inspect the full structured result.");
      expect(exitCodes).toEqual([1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets exit code for downstream tool errors after printing JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-call-error-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    const exitCodes: number[] = [];
    try {
      writeCliOperationConfig(configPath);
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["call-tool", "local.fail", "--format", "json"], {
        writeOut: (value) => out.push(value),
        setExitCode: (code) => exitCodes.push(code),
      });

      expect(JSON.parse(out.join(""))).toMatchObject({ isError: true });
      expect(exitCodes).toEqual([1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid direct call syntax and arguments", async () => {
    await expect(runCli(["get-tool", "missingdot"], { writeErr: () => {} })).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
    await expect(
      runCli(["call-tool", "local.tool", "--args", "{"], { writeErr: () => {} }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(
      runCli(["call-tool", "local.tool", "--args", "[]"], { writeErr: () => {} }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(
      runCli(["list-tools", "local", "--format", "xml"], { writeErr: () => {} }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("installs all Caplets from a local repo caplets directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-"));
    const repo = join(dir, "repo");
    const cwd = process.cwd();
    const projectRoot = join(dir, "project");
    const configPath = join(dir, "user", "config.json");
    const out: string[] = [];
    try {
      writeInstallableRepo(repo);
      process.env.CAPLETS_CONFIG = configPath;
      mkdirSync(projectRoot, { recursive: true });
      process.chdir(projectRoot);

      await runCli(["install", repo], { writeOut: (value) => out.push(value) });

      expect(readFileSync(join(projectRoot, ".caplets", "filesystem.md"), "utf8")).toContain(
        "name: Project Files",
      );
      expect(readFileSync(join(projectRoot, ".caplets", "github", "CAPLET.md"), "utf8")).toContain(
        "name: GitHub",
      );
      expect(out.join("")).toContain("Installed filesystem");
      expect(out.join("")).toContain("Installed github");
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs all Caplets globally when requested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-global-"));
    const repo = join(dir, "repo");
    const projectRoot = join(dir, "project");
    const configPath = join(dir, "user", "config.json");
    const out: string[] = [];
    const cwd = process.cwd();
    try {
      writeInstallableRepo(repo);
      mkdirSync(projectRoot, { recursive: true });
      process.env.CAPLETS_CONFIG = configPath;
      process.chdir(projectRoot);

      await runCli(["install", "--global", repo], { writeOut: (value) => out.push(value) });

      expect(readFileSync(join(dir, "user", "filesystem.md"), "utf8")).toContain(
        "name: Project Files",
      );
      expect(readFileSync(join(dir, "user", "github", "CAPLET.md"), "utf8")).toContain(
        "name: GitHub",
      );
      expect(existsSync(join(projectRoot, ".caplets"))).toBe(false);
      expect(out.join("")).toContain(
        `Installed filesystem to ${join(dir, "user", "filesystem.md")}`,
      );
      expect(out.join("")).toContain(`Installed github to ${join(dir, "user", "github")}`);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds CLI Caplets to the project root by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-cli-"));
    const projectRoot = join(dir, "project");
    const repo = join(dir, "repo");
    const cwd = process.cwd();
    const out: string[] = [];
    try {
      writeCliRepo(repo);
      mkdirSync(projectRoot, { recursive: true });
      process.chdir(projectRoot);
      const expectedOutput = join(process.cwd(), ".caplets", "repo-tools.md");

      await runCli(["add", "cli", "repo-tools", "--repo", repo, "--include", "package"], {
        writeOut: (value) => out.push(value),
      });

      const output = join(projectRoot, ".caplets", "repo-tools.md");
      expect(readFileSync(output, "utf8")).toContain("package_test:");
      expect(out.join("")).toBe(`Wrote CLI Caplet to ${expectedOutput}\n`);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds CLI Caplets globally when requested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-cli-global-"));
    const projectRoot = join(dir, "project");
    const repo = join(dir, "repo");
    const configPath = join(dir, "user", "config.json");
    const cwd = process.cwd();
    try {
      writeCliRepo(repo);
      mkdirSync(projectRoot, { recursive: true });
      process.env.CAPLETS_CONFIG = configPath;
      process.chdir(projectRoot);

      await runCli(
        ["add", "cli", "repo-tools", "--repo", repo, "--include", "package", "--global"],
        {
          writeOut: () => {},
        },
      );

      expect(readFileSync(join(dir, "user", "repo-tools.md"), "utf8")).toContain("package_test:");
      expect(existsSync(join(projectRoot, ".caplets"))).toBe(false);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints added CLI Caplets without writing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-cli-print-"));
    const projectRoot = join(dir, "project");
    const repo = join(dir, "repo");
    const cwd = process.cwd();
    const out: string[] = [];
    try {
      writeCliRepo(repo);
      mkdirSync(projectRoot, { recursive: true });
      process.chdir(projectRoot);

      await runCli(
        ["add", "cli", "repo-tools", "--repo", repo, "--include", "package", "--print"],
        {
          writeOut: (value) => out.push(value),
        },
      );

      expect(out.join("")).toContain("cliTools:");
      expect(out.join("")).toContain("package_test:");
      expect(existsSync(join(projectRoot, ".caplets"))).toBe(false);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects added CLI Caplets when no package scripts produce actions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-cli-empty-"));
    const repo = join(dir, "repo");
    try {
      mkdirSync(repo, { recursive: true });
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", scripts: {} }));

      await expect(
        runCli(["add", "cli", "repo-tools", "--repo", repo, "--include", "package"], {
          writeOut: () => {},
          writeErr: () => {},
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints added MCP, OpenAPI, and Google Discovery backend Caplets", async () => {
    const out: string[] = [];

    await runCli(
      [
        "add",
        "mcp",
        "remote-tools",
        "--url",
        "https://mcp.example.com/mcp",
        "--transport",
        "sse",
        "--token-env",
        "MCP_TOKEN",
        "--print",
      ],
      { writeOut: (value) => out.push(value) },
    );
    await runCli(
      [
        "add",
        "openapi",
        "petstore",
        "--spec",
        "https://api.example.com/openapi.json",
        "--base-url",
        "https://api.example.com/v1",
        "--print",
      ],
      { writeOut: (value) => out.push(value) },
    );
    await runCli(
      [
        "add",
        "google-discovery",
        "drive",
        "--discovery-url",
        "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
        "--base-url",
        "https://www.googleapis.com/drive/v3",
        "--token-env",
        "GOOGLE_TOKEN",
        "--print",
      ],
      { writeOut: (value) => out.push(value) },
    );

    expect(out.join("\n")).toContain("mcpServer:");
    expect(out.join("\n")).toContain('transport: "sse"');
    expect(out.join("\n")).toContain('token: "$env:MCP_TOKEN"');
    expect(out.join("\n")).toContain("openapiEndpoint:");
    expect(out.join("\n")).toContain('baseUrl: "https://api.example.com/v1"');
    expect(out.join("\n")).toContain("googleDiscoveryApi:");
    expect(out.join("\n")).toContain(
      'discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"',
    );
    expect(out.join("\n")).toContain('token: "$env:GOOGLE_TOKEN"');
  });

  it("adds GraphQL and HTTP backend Caplets to the project root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-backends-"));
    const projectRoot = join(dir, "project");
    const cwd = process.cwd();
    try {
      mkdirSync(projectRoot, { recursive: true });
      process.chdir(projectRoot);

      await runCli(
        [
          "add",
          "graphql",
          "catalog",
          "--endpoint-url",
          "https://api.example.com/graphql",
          "--introspection",
        ],
        { writeOut: () => {} },
      );
      await runCli(
        [
          "add",
          "http",
          "status-api",
          "--base-url",
          "https://api.example.com",
          "--action",
          "get_status:GET:/status",
        ],
        { writeOut: () => {} },
      );

      expect(readFileSync(join(projectRoot, ".caplets", "catalog.md"), "utf8")).toContain(
        "graphqlEndpoint:",
      );
      expect(readFileSync(join(projectRoot, ".caplets", "status-api.md"), "utf8")).toContain(
        "httpApi:",
      );
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes OpenAPI local spec paths that load from the original project file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-openapi-path-"));
    const projectRoot = join(dir, "project");
    const cwd = process.cwd();
    try {
      mkdirSync(projectRoot, { recursive: true });
      writeFileSync(join(projectRoot, "openapi.json"), JSON.stringify({ openapi: "3.1.0" }));
      process.chdir(projectRoot);

      await runCli(["add", "openapi", "users", "--spec", "./openapi.json"], {
        writeOut: () => {},
      });

      const config = loadConfig(
        join(dir, "user", "config.json"),
        join(projectRoot, ".caplets", "config.json"),
      );
      expect(config.openapiEndpoints.users?.specPath).toBe(join(projectRoot, "openapi.json"));
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes Google Discovery local discovery paths that load from the original project file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-google-discovery-path-"));
    const projectRoot = join(dir, "project");
    const cwd = process.cwd();
    try {
      mkdirSync(projectRoot, { recursive: true });
      writeFileSync(
        join(projectRoot, "drive.discovery.json"),
        JSON.stringify({ kind: "discovery#restDescription", name: "drive", version: "v3" }),
      );
      process.chdir(projectRoot);

      await runCli(["add", "google-discovery", "drive", "--discovery", "./drive.discovery.json"], {
        writeOut: () => {},
      });

      const config = loadConfig(
        join(dir, "user", "config.json"),
        join(projectRoot, ".caplets", "config.json"),
      );
      expect(config.googleDiscoveryApis.drive?.discoveryPath).toBe(
        join(projectRoot, "drive.discovery.json"),
      );
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes Google Discovery env discovery URL references as URLs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-google-discovery-env-url-"));
    const projectRoot = join(dir, "project");
    const cwd = process.cwd();
    try {
      const out: string[] = [];
      mkdirSync(projectRoot, { recursive: true });
      process.chdir(projectRoot);

      await runCli(
        ["add", "google-discovery", "drive", "--discovery-url", "$env:DISCOVERY_URL", "--print"],
        {
          writeOut: (value) => out.push(value),
        },
      );

      const text = out.join("\n");
      expect(text).toContain('discoveryUrl: "$env:DISCOVERY_URL"');
      expect(text).not.toContain("discoveryPath:");
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes GraphQL local schema paths that load from the original project file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-graphql-path-"));
    const projectRoot = join(dir, "project");
    const cwd = process.cwd();
    try {
      mkdirSync(projectRoot, { recursive: true });
      writeFileSync(join(projectRoot, "schema.graphql"), "type Query { viewer: String }\n");
      process.chdir(projectRoot);

      await runCli(
        [
          "add",
          "graphql",
          "catalog",
          "--endpoint-url",
          "https://api.example.com/graphql",
          "--schema",
          "./schema.graphql",
        ],
        { writeOut: () => {} },
      );

      const config = loadConfig(
        join(dir, "user", "config.json"),
        join(projectRoot, ".caplets", "config.json"),
      );
      expect(config.graphqlEndpoints.catalog?.schemaPath).toBe(join(projectRoot, "schema.graphql"));
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid backend add options", async () => {
    await expect(
      runCli(
        [
          "add",
          "graphql",
          "bad-graphql",
          "--endpoint-url",
          "https://api.example.com/graphql",
          "--schema",
          "./schema.graphql",
          "--introspection",
          "--print",
        ],
        { writeOut: () => {}, writeErr: () => {} },
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);

    await expect(
      runCli(
        ["add", "http", "bad-http", "--base-url", "https://api.example.com", "--action", "bad"],
        { writeOut: () => {}, writeErr: () => {} },
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);

    await expect(
      runCli(
        [
          "add",
          "http",
          "duplicate-http",
          "--base-url",
          "https://api.example.com",
          "--action",
          "get_status:GET:/status",
          "--action",
          "get_status:POST:/status",
          "--print",
        ],
        { writeOut: () => {}, writeErr: () => {} },
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
  });

  it("adds CLI Caplets to an explicit output path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-cli-output-"));
    const repo = join(dir, "repo");
    const output = join(dir, "custom", "tools.md");
    try {
      writeCliRepo(repo);

      await runCli(
        ["add", "cli", "repo-tools", "--repo", repo, "--include", "package", "--output", output],
        { writeOut: () => {} },
      );

      expect(readFileSync(output, "utf8")).toContain("package_test:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a controlled error when an add output parent is a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-output-parent-file-"));
    const repo = join(dir, "repo");
    const parent = join(dir, "custom");
    const output = join(parent, "tools.md");
    try {
      writeCliRepo(repo);
      writeFileSync(parent, "not a directory\n");

      await expect(
        runCli(
          ["add", "cli", "repo-tools", "--repo", repo, "--include", "package", "--output", output],
          { writeOut: () => {}, writeErr: () => {} },
        ),
      ).rejects.toThrow(expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects explicit add output paths that are directories even with force", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-cli-output-dir-"));
    const repo = join(dir, "repo");
    const output = join(dir, "custom");
    try {
      writeCliRepo(repo);
      mkdirSync(output, { recursive: true });

      await expect(
        runCli(
          [
            "add",
            "cli",
            "repo-tools",
            "--repo",
            repo,
            "--include",
            "package",
            "--output",
            output,
            "--force",
          ],
          { writeOut: () => {}, writeErr: () => {} },
        ),
      ).rejects.toThrow(expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects explicit add output paths that are symlinks even with force", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-cli-output-symlink-"));
    const repo = join(dir, "repo");
    const target = join(dir, "outside.md");
    const output = join(dir, "custom", "tools.md");
    try {
      writeCliRepo(repo);
      writeFileSync(target, "protected\n");
      mkdirSync(join(dir, "custom"), { recursive: true });
      symlinkSync(target, output);

      await expect(
        runCli(
          [
            "add",
            "cli",
            "repo-tools",
            "--repo",
            repo,
            "--include",
            "package",
            "--output",
            output,
            "--force",
          ],
          { writeOut: () => {}, writeErr: () => {} },
        ),
      ).rejects.toThrow(expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError);
      expect(readFileSync(target, "utf8")).toBe("protected\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects explicit add output paths with symlinked parents", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-cli-output-parent-symlink-"));
    const repo = join(dir, "repo");
    const realParent = join(dir, "real-parent");
    const symlinkParent = join(dir, "custom");
    const output = join(symlinkParent, "tools.md");
    try {
      writeCliRepo(repo);
      mkdirSync(realParent, { recursive: true });
      symlinkSync(realParent, symlinkParent);

      await expect(
        runCli(
          ["add", "cli", "repo-tools", "--repo", repo, "--include", "package", "--output", output],
          { writeOut: () => {}, writeErr: () => {} },
        ),
      ).rejects.toThrow(expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError);
      expect(existsSync(join(realParent, "tools.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wraps unexpected lstat failures while inspecting add output paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-lstat-failure-"));
    const repo = join(dir, "repo");
    const output = join(dir, "a".repeat(300), "tools.md");
    try {
      writeCliRepo(repo);

      await expect(
        runCli(
          ["add", "cli", "repo-tools", "--repo", repo, "--include", "package", "--output", output],
          { writeOut: () => {}, writeErr: () => {} },
        ),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "CONFIG_INVALID",
          message: `Could not inspect output path ${output}`,
        }) as CapletsError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects default add output paths with a symlinked .caplets root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-cli-root-symlink-"));
    const projectRoot = join(dir, "project");
    const realRoot = join(dir, "real-caplets");
    const repo = join(dir, "repo");
    const cwd = process.cwd();
    try {
      writeCliRepo(repo);
      mkdirSync(projectRoot, { recursive: true });
      mkdirSync(realRoot, { recursive: true });
      symlinkSync(realRoot, join(projectRoot, ".caplets"));
      process.chdir(projectRoot);

      await expect(
        runCli(["add", "cli", "repo-tools", "--repo", repo, "--include", "package"], {
          writeOut: () => {},
          writeErr: () => {},
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError);
      expect(existsSync(join(realRoot, "repo-tools.md"))).toBe(false);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite added CLI Caplets without force", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-cli-overwrite-"));
    const projectRoot = join(dir, "project");
    const repo = join(dir, "repo");
    const cwd = process.cwd();
    try {
      writeCliRepo(repo);
      mkdirSync(projectRoot, { recursive: true });
      process.chdir(projectRoot);

      await runCli(["add", "cli", "repo-tools", "--repo", repo, "--include", "package"], {
        writeOut: () => {},
      });

      await expect(
        runCli(["add", "cli", "repo-tools", "--repo", repo, "--include", "package"], {
          writeOut: () => {},
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError);

      await runCli(
        ["add", "cli", "repo-tools", "--repo", repo, "--include", "package", "--force"],
        { writeOut: () => {} },
      );
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects default add output paths that are symlinks even with force", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-cli-default-symlink-"));
    const projectRoot = join(dir, "project");
    const repo = join(dir, "repo");
    const target = join(dir, "outside.md");
    const cwd = process.cwd();
    try {
      writeCliRepo(repo);
      mkdirSync(join(projectRoot, ".caplets"), { recursive: true });
      writeFileSync(target, "protected\n");
      symlinkSync(target, join(projectRoot, ".caplets", "repo-tools.md"));
      process.chdir(projectRoot);

      await expect(
        runCli(["add", "cli", "repo-tools", "--repo", repo, "--include", "package", "--force"], {
          writeOut: () => {},
          writeErr: () => {},
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError);
      expect(readFileSync(target, "utf8")).toBe("protected\n");
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses default add output when a directory Caplet exists for the same ID", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-directory-collision-"));
    const projectRoot = join(dir, "project");
    const repo = join(dir, "repo");
    const cwd = process.cwd();
    try {
      writeCliRepo(repo);
      mkdirSync(join(projectRoot, ".caplets", "repo-tools"), { recursive: true });
      writeFileSync(join(projectRoot, ".caplets", "repo-tools", "CAPLET.md"), "existing");
      process.chdir(projectRoot);

      await expect(
        runCli(["add", "cli", "repo-tools", "--repo", repo, "--include", "package", "--force"], {
          writeOut: () => {},
          writeErr: () => {},
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid add CLI Caplet IDs before deriving default destinations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-add-cli-invalid-"));
    const projectRoot = join(dir, "project");
    const repo = join(dir, "repo");
    const cwd = process.cwd();
    try {
      writeCliRepo(repo);
      mkdirSync(projectRoot, { recursive: true });
      process.chdir(projectRoot);

      await expect(
        runCli(["add", "cli", "bad name", "--repo", repo, "--include", "package"], {
          writeOut: () => {},
          writeErr: () => {},
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);
      await expect(
        runCli(["add", "cli", "../escape", "--repo", repo, "--include", "package"], {
          writeOut: () => {},
          writeErr: () => {},
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError);

      expect(existsSync(join(projectRoot, ".caplets"))).toBe(false);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not expose the removed author cli alias", async () => {
    await expect(runCli(["author", "cli", "repo-tools"], { writeErr: () => {} })).rejects.toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );
  });

  it("installs selected Caplets from a local repo caplets directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-"));
    const repo = join(dir, "repo");
    const cwd = process.cwd();
    const projectRoot = join(dir, "project");
    const configPath = join(dir, "user", "config.json");
    const out: string[] = [];
    try {
      writeInstallableRepo(repo);
      process.env.CAPLETS_CONFIG = configPath;
      mkdirSync(projectRoot, { recursive: true });
      process.chdir(projectRoot);
      const expectedDestination = join(process.cwd(), ".caplets", "github");

      await runCli(["install", repo, "github"], { writeOut: (value) => out.push(value) });

      expect(existsSync(join(projectRoot, ".caplets", "github", "CAPLET.md"))).toBe(true);
      expect(existsSync(join(projectRoot, ".caplets", "filesystem.md"))).toBe(false);
      expect(out.join("")).toBe(`Installed github to ${expectedDestination}\n`);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs a selected Caplet when an unrelated Caplet is invalid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-"));
    const repo = join(dir, "repo");
    const cwd = process.cwd();
    const projectRoot = join(dir, "project");
    const configPath = join(dir, "user", "config.json");
    try {
      writeInstallableRepo(repo);
      writeFileSync(join(repo, "caplets", "broken.md"), "not frontmatter\n");
      process.env.CAPLETS_CONFIG = configPath;
      mkdirSync(projectRoot, { recursive: true });
      process.chdir(projectRoot);

      await runCli(["install", repo, "github"], { writeOut: () => {} });

      expect(existsSync(join(projectRoot, ".caplets", "github", "CAPLET.md"))).toBe(true);
      expect(existsSync(join(projectRoot, ".caplets", "broken.md"))).toBe(false);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs a selected Caplet when an unrelated Caplet filename has an invalid ID", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-"));
    const repo = join(dir, "repo");
    const cwd = process.cwd();
    const projectRoot = join(dir, "project");
    const configPath = join(dir, "user", "config.json");
    try {
      writeInstallableRepo(repo);
      writeFileSync(join(repo, "caplets", "api.v2.md"), "not frontmatter\n");
      process.env.CAPLETS_CONFIG = configPath;
      mkdirSync(projectRoot, { recursive: true });
      process.chdir(projectRoot);

      await runCli(["install", repo, "github"], { writeOut: () => {} });

      expect(existsSync(join(projectRoot, ".caplets", "github", "CAPLET.md"))).toBe(true);
      expect(existsSync(join(projectRoot, ".caplets", "api.v2.md"))).toBe(false);
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite installed Caplets without force", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-"));
    const repo = join(dir, "repo");
    const cwd = process.cwd();
    const projectRoot = join(dir, "project");
    const configPath = join(dir, "user", "config.json");
    try {
      writeInstallableRepo(repo);
      process.env.CAPLETS_CONFIG = configPath;
      mkdirSync(projectRoot, { recursive: true });
      process.chdir(projectRoot);

      await runCli(["install", repo, "github"], { writeOut: () => {} });

      await expect(runCli(["install", repo, "github"], { writeOut: () => {} })).rejects.toThrow(
        expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError,
      );

      await runCli(["install", repo, "github", "--force"], { writeOut: () => {} });
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses file-vs-directory install destination collisions even with force", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-cross-kind-"));
    const repo = join(dir, "repo");
    const destinationRoot = join(dir, "user");
    try {
      writeInstallableRepo(repo);
      mkdirSync(destinationRoot, { recursive: true });
      writeFileSync(join(destinationRoot, "github.md"), "existing\n");
      mkdirSync(join(destinationRoot, "filesystem"), { recursive: true });
      writeFileSync(join(destinationRoot, "filesystem", "CAPLET.md"), "existing\n");

      expect(() =>
        installCaplets(repo, { capletIds: ["github"], destinationRoot, force: true }),
      ).toThrow(expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError);
      expect(() =>
        installCaplets(repo, { capletIds: ["filesystem"], destinationRoot, force: true }),
      ).toThrow(expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError);
      expect(readFileSync(join(destinationRoot, "github.md"), "utf8")).toBe("existing\n");
      expect(readFileSync(join(destinationRoot, "filesystem", "CAPLET.md"), "utf8")).toBe(
        "existing\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("materializes internal symlinked children when installing a selected directory Caplet", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-symlinked-toolkit-"));
    const repo = join(dir, "repo");
    const capletsRoot = join(repo, "caplets");
    const destinationRoot = join(dir, "user");
    try {
      mkdirSync(join(capletsRoot, "osv"), { recursive: true });
      mkdirSync(join(capletsRoot, "coding-agent-toolkit", "caplets"), { recursive: true });
      writeFileSync(join(capletsRoot, "osv", "CAPLET.md"), capletFixture("OSV"));
      writeFileSync(
        join(capletsRoot, "coding-agent-toolkit", "CAPLET.md"),
        [
          "---",
          "name: Coding Agent Toolkit",
          "description: Test toolkit.",
          "capletSet:",
          "  capletsRoot: ./caplets",
          "---",
          "# Coding Agent Toolkit",
        ].join("\n"),
      );
      symlinkSync("../../osv", join(capletsRoot, "coding-agent-toolkit", "caplets", "osv"));

      const result = installCaplets(repo, { capletIds: ["coding-agent-toolkit"], destinationRoot });

      const installedChild = join(destinationRoot, "coding-agent-toolkit", "caplets", "osv");
      expect(result.installed).toEqual([
        expect.objectContaining({
          id: "coding-agent-toolkit",
          destination: join(destinationRoot, "coding-agent-toolkit"),
          kind: "directory",
        }),
      ]);
      expect(existsSync(join(installedChild, "CAPLET.md"))).toBe(true);
      expect(lstatSync(installedChild).isSymbolicLink()).toBe(false);
      expect(existsSync(join(destinationRoot, "osv"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects directory Caplet symlinks that resolve outside the source Caplets boundary", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-external-symlink-"));
    const repo = join(dir, "repo");
    const capletsRoot = join(repo, "caplets");
    const destinationRoot = join(dir, "user");
    try {
      mkdirSync(join(repo, "outside"), { recursive: true });
      mkdirSync(join(capletsRoot, "coding-agent-toolkit", "caplets"), { recursive: true });
      writeFileSync(join(repo, "outside", "CAPLET.md"), capletFixture("Outside"));
      writeFileSync(
        join(capletsRoot, "coding-agent-toolkit", "CAPLET.md"),
        [
          "---",
          "name: Coding Agent Toolkit",
          "description: Test toolkit.",
          "capletSet:",
          "  capletsRoot: ./caplets",
          "---",
          "# Coding Agent Toolkit",
        ].join("\n"),
      );
      symlinkSync(
        "../../../outside",
        join(capletsRoot, "coding-agent-toolkit", "caplets", "outside"),
      );

      expect(() =>
        installCaplets(repo, { capletIds: ["coding-agent-toolkit"], destinationRoot }),
      ).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses broken symlink file install destinations even with force", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-broken-file-symlink-"));
    const repo = join(dir, "repo");
    const destinationRoot = join(dir, "user");
    const destination = join(destinationRoot, "filesystem.md");
    try {
      writeInstallableRepo(repo);
      mkdirSync(destinationRoot, { recursive: true });
      symlinkSync(join(dir, "missing.md"), destination);

      expect(() =>
        installCaplets(repo, { capletIds: ["filesystem"], destinationRoot, force: true }),
      ).toThrow(expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses broken symlink directory install destinations even with force", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-broken-dir-symlink-"));
    const repo = join(dir, "repo");
    const destinationRoot = join(dir, "user");
    const destination = join(destinationRoot, "github");
    try {
      writeInstallableRepo(repo);
      mkdirSync(destinationRoot, { recursive: true });
      symlinkSync(join(dir, "missing-directory"), destination);

      expect(() =>
        installCaplets(repo, { capletIds: ["github"], destinationRoot, force: true }),
      ).toThrow(expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses symlink file-vs-directory install destination collisions even with force", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-cross-kind-symlink-"));
    const repo = join(dir, "repo");
    const destinationRoot = join(dir, "user");
    try {
      writeInstallableRepo(repo);
      mkdirSync(destinationRoot, { recursive: true });
      symlinkSync(join(dir, "missing.md"), join(destinationRoot, "github.md"));
      symlinkSync(join(dir, "missing-directory"), join(destinationRoot, "filesystem"));

      expect(() =>
        installCaplets(repo, { capletIds: ["github"], destinationRoot, force: true }),
      ).toThrow(expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError);
      expect(() =>
        installCaplets(repo, { capletIds: ["filesystem"], destinationRoot, force: true }),
      ).toThrow(expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a controlled error when the install destination root is a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-root-file-"));
    const repo = join(dir, "repo");
    const destinationRoot = join(dir, "user");
    try {
      writeInstallableRepo(repo);
      writeFileSync(destinationRoot, "not a directory\n");

      expect(() => installCaplets(repo, { capletIds: ["github"], destinationRoot })).toThrow(
        expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects install destination roots under symlinked parents", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-root-parent-symlink-"));
    const repo = join(dir, "repo");
    const realParent = join(dir, "real-parent");
    const symlinkParent = join(dir, "linked-parent");
    const destinationRoot = join(symlinkParent, ".caplets");
    try {
      writeInstallableRepo(repo);
      mkdirSync(realParent, { recursive: true });
      symlinkSync(realParent, symlinkParent);

      expect(() => installCaplets(repo, { capletIds: ["github"], destinationRoot })).toThrow(
        expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError,
      );
      expect(existsSync(join(realParent, ".caplets"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects nested install destinations under symlinked parents", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-nested-parent-symlink-"));
    const repo = join(dir, "repo");
    const destinationRoot = join(dir, "user");
    const realParent = join(dir, "real-parent");
    const symlinkParent = join(destinationRoot, "github");
    try {
      writeInstallableRepo(repo);
      mkdirSync(destinationRoot, { recursive: true });
      mkdirSync(realParent, { recursive: true });
      symlinkSync(realParent, symlinkParent);

      expect(() => installCaplets(repo, { capletIds: ["github"], destinationRoot })).toThrow(
        expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError,
      );
      expect(existsSync(join(realParent, "CAPLET.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate source IDs before all-install copies anything", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-duplicate-all-"));
    const repo = join(dir, "repo");
    const destinationRoot = join(dir, "user");
    try {
      writeInstallableRepo(repo);
      writeFileSync(join(repo, "caplets", "github.md"), capletFixture("GitHub File"));

      expect(() => installCaplets(repo, { destinationRoot })).toThrow(
        expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError,
      );
      expect(existsSync(join(destinationRoot, "filesystem.md"))).toBe(false);
      expect(existsSync(join(destinationRoot, "github"))).toBe(false);
      expect(existsSync(join(destinationRoot, "github.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate source IDs before selected-install copies anything", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-duplicate-selected-"));
    const repo = join(dir, "repo");
    const destinationRoot = join(dir, "user");
    try {
      writeInstallableRepo(repo);
      writeFileSync(join(repo, "caplets", "github.md"), capletFixture("GitHub File"));

      expect(() => installCaplets(repo, { capletIds: ["github"], destinationRoot })).toThrow(
        expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError,
      );
      expect(existsSync(join(destinationRoot, "github"))).toBe(false);
      expect(existsSync(join(destinationRoot, "github.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preflights selected installs before copying any Caplets", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-"));
    const repo = join(dir, "repo");
    const destinationRoot = join(dir, "user");
    try {
      writeInstallableRepo(repo);
      mkdirSync(join(destinationRoot, "github"), { recursive: true });
      writeFileSync(join(destinationRoot, "github", "CAPLET.md"), "existing\n");

      expect(() => installCaplets(repo, { destinationRoot })).toThrow(
        expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError,
      );

      expect(existsSync(join(destinationRoot, "filesystem.md"))).toBe(false);
      expect(readFileSync(join(destinationRoot, "github", "CAPLET.md"), "utf8")).toBe("existing\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns stable install source identifiers", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-"));
    const repo = join(dir, "repo");
    const destinationRoot = join(dir, "user");
    try {
      writeInstallableRepo(repo);

      const result = installCaplets(repo, { capletIds: ["github"], destinationRoot });

      expect(result.installed).toEqual([
        {
          id: "github",
          source: `${repo}#caplets/github`,
          destination: join(destinationRoot, "github"),
          kind: "directory",
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects selected Caplets that are not in the repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-install-"));
    const repo = join(dir, "repo");
    const configPath = join(dir, "user", "config.json");
    try {
      writeInstallableRepo(repo);
      process.env.CAPLETS_CONFIG = configPath;

      await expect(runCli(["install", repo, "missing"], { writeOut: () => {} })).rejects.toThrow(
        expect.objectContaining({ code: "CONFIG_NOT_FOUND" }) as CapletsError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normalizes GitHub shorthand repos without double appending git suffixes", () => {
    expect(normalizeGitRepo("spiritledsoftware/caplets")).toBe(
      "https://github.com/spiritledsoftware/caplets.git",
    );
    expect(normalizeGitRepo("spiritledsoftware/caplets.git")).toBe(
      "https://github.com/spiritledsoftware/caplets.git",
    );
    expect(normalizeGitRepo("https://github.com/spiritledsoftware/caplets.git")).toBe(
      "https://github.com/spiritledsoftware/caplets.git",
    );
  });

  it("lists configured OAuth servers without printing token values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    const authDir = join(dir, "auth");
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            remote: {
              name: "Remote",
              description: "A useful remote OAuth server.",
              transport: "http",
              url: "https://example.com/mcp",
              auth: { type: "oauth2", clientId: "client" },
            },
            expired: {
              name: "Expired",
              description: "Another useful remote OAuth server.",
              transport: "http",
              url: "https://expired.example.com/mcp",
              auth: { type: "oauth2", clientId: "client" },
            },
            stdio: {
              name: "Stdio",
              description: "A useful local server.",
              command: "node",
            },
          },
          openapiEndpoints: {
            users: {
              name: "Users API",
              description: "Manage users through the internal HTTP API.",
              specPath: "/tmp/users-openapi.json",
              auth: { type: "oauth2", clientId: "openapi-client" },
            },
          },
        }),
      );
      process.env.CAPLETS_CONFIG = configPath;
      writeTokenBundle(
        {
          server: "remote",
          accessToken: "secret-access-token",
          tokenType: "Bearer",
          expiresAt: "2999-01-01T00:00:00.000Z",
          scope: "mcp:tools",
        },
        authDir,
      );
      writeTokenBundle(
        {
          server: "expired",
          accessToken: "expired-secret-access-token",
          expiresAt: "2000-01-01T00:00:00.000Z",
        },
        authDir,
      );

      await runCli(["auth", "list"], { writeOut: (value) => out.push(value), authDir });

      const text = out.join("");
      expect(text).toContain(
        "remote\n  Status: authenticated\n  Source: global\n  Expires: 2999-01-01T00:00:00.000Z\n  Scope: mcp:tools",
      );
      expect(text).toContain(
        "expired\n  Status: expired\n  Source: global\n  Expires: 2000-01-01T00:00:00.000Z",
      );
      expect(text).toContain("users\n  Status: missing\n  Source: global");
      expect(text).not.toContain("stdio");
      expect(text).not.toContain("secret-access-token");
      expect(text).not.toContain("openapi-client");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists configured GraphQL OAuth endpoints", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          graphqlEndpoints: {
            catalog: {
              name: "Catalog",
              description: "Query catalog data through GraphQL.",
              endpointUrl: "https://api.example.com/graphql",
              introspection: true,
              auth: { type: "oauth2", issuer: "https://issuer.example" },
            },
          },
        }),
      );
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["auth", "list"], { writeOut: (value) => out.push(value) });

      expect(out.join("")).toContain("catalog\n  Status: missing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("formats OAuth auth targets as JSON when requested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-format-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          graphqlEndpoints: {
            catalog: {
              name: "Catalog",
              description: "Query catalog data through GraphQL.",
              endpointUrl: "https://api.example.com/graphql",
              introspection: true,
              auth: { type: "oauth2", issuer: "https://issuer.example" },
            },
          },
        }),
      );
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["auth", "list", "--format", "json"], {
        writeOut: (value) => out.push(value),
      });
      expect(JSON.parse(out.join(""))).toEqual([
        { server: "catalog", status: "missing", source: "global" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs out configured OAuth servers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    const authDir = join(dir, "auth");
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            remote: {
              name: "Remote",
              description: "A useful remote OAuth server.",
              transport: "http",
              url: "https://example.com/mcp",
              auth: { type: "oauth2", clientId: "client" },
            },
          },
        }),
      );
      process.env.CAPLETS_CONFIG = configPath;
      writeTokenBundle({ server: "remote", accessToken: "secret-access-token" }, authDir);

      await runCli(["auth", "logout", "remote"], {
        writeOut: (value) => out.push(value),
        authDir,
      });

      expect(out.join("")).toBe("Deleted OAuth credentials for `remote`.\n");
      out.length = 0;

      await runCli(["auth", "logout", "remote"], {
        writeOut: (value) => out.push(value),
        authDir,
      });

      expect(out.join("")).toBe("No OAuth credentials found for `remote`.\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes configured OAuth credentials on demand", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-refresh-cli-"));
    const authDir = join(dir, "auth");
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            remote: {
              name: "Remote",
              description: "A useful remote OAuth server.",
              transport: "http",
              url: "https://example.com/mcp",
              auth: {
                type: "oauth2",
                clientId: "client",
                tokenUrl: "https://auth.example.com/token",
              },
            },
          },
        }),
      );
      process.env.CAPLETS_CONFIG = configPath;
      writeTokenBundle(
        {
          server: "remote",
          authType: "oauth2",
          accessToken: "old-access-token",
          refreshToken: "old-refresh-token",
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
        authDir,
      );

      await runCli(["auth", "refresh", "remote"], {
        writeOut: (value) => out.push(value),
        authDir,
      });

      expect(out.join("")).toBe("Refreshed OAuth credentials for `remote`.\n");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://auth.example.com/token",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("grant_type=refresh_token"),
        }),
      );
      expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain(
        "refresh_token=old-refresh-token",
      );
      expect(readTokenBundle("remote", authDir)).toMatchObject({
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        tokenType: "Bearer",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes Google Discovery OAuth credentials with explicit scopes when discovery is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-google-refresh-cli-"));
    const authDir = join(dir, "auth");
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("discovery unavailable"))
      .mockResolvedValueOnce(
        Response.json({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          googleDiscoveryApis: {
            drive: {
              name: "Google Drive",
              description: "Access Google Drive files.",
              discoveryUrl: "https://discovery.example.invalid/drive/v3/rest",
              auth: {
                type: "oauth2",
                clientId: "client",
                tokenUrl: "https://auth.example.com/token",
                scopes: ["https://www.googleapis.com/auth/drive.readonly"],
              },
            },
          },
        }),
      );
      process.env.CAPLETS_CONFIG = configPath;
      writeTokenBundle(
        {
          server: "drive",
          authType: "oauth2",
          accessToken: "old-access-token",
          refreshToken: "old-refresh-token",
          expiresAt: "2999-01-01T00:00:00.000Z",
          metadata: {
            requestedScopes: ["https://www.googleapis.com/auth/drive.readonly"],
          },
        },
        authDir,
      );

      await runCli(["auth", "refresh", "drive"], {
        writeOut: (value) => out.push(value),
        authDir,
      });

      expect(out.join("")).toBe("Refreshed OAuth credentials for `drive`.\n");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://auth.example.com/token",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("refresh_token=old-refresh-token"),
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses Discovery-derived base URL for Google Discovery OAuth refresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-google-base-url-cli-"));
    const authDir = join(dir, "auth");
    const configPath = join(dir, "config.json");
    const discoveryPath = join(dir, "drive.discovery.json");
    const out: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    try {
      writeFileSync(
        discoveryPath,
        JSON.stringify({
          kind: "discovery#restDescription",
          baseUrl: "https://api.example.com/drive/v3/",
          resources: {
            files: {
              methods: {
                list: {
                  id: "drive.files.list",
                  path: "files",
                  httpMethod: "GET",
                  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
                },
              },
            },
          },
        }),
      );
      writeFileSync(
        configPath,
        JSON.stringify({
          googleDiscoveryApis: {
            drive: {
              name: "Google Drive",
              description: "Access Google Drive files.",
              discoveryPath,
              auth: {
                type: "oauth2",
                clientId: "client",
                tokenUrl: "https://auth.example.com/token",
              },
            },
          },
        }),
      );
      process.env.CAPLETS_CONFIG = configPath;
      writeTokenBundle(
        {
          server: "drive",
          authType: "oauth2",
          accessToken: "old-access-token",
          refreshToken: "old-refresh-token",
          expiresAt: "2999-01-01T00:00:00.000Z",
          protectedResourceOrigin: "https://api.example.com",
          metadata: {
            requestedScopes: ["https://www.googleapis.com/auth/drive.readonly"],
          },
        },
        authDir,
      );

      await runCli(["auth", "refresh", "drive"], {
        writeOut: (value) => out.push(value),
        authDir,
      });

      expect(out.join("")).toBe("Refreshed OAuth credentials for `drive`.\n");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://auth.example.com/token",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses Discovery-derived base URL for explicit Google Discovery OAuth scopes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-google-proxy-cli-"));
    const authDir = join(dir, "auth");
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          kind: "discovery#restDescription",
          baseUrl: "https://api.example.com/drive/v3/",
          resources: {
            files: {
              methods: {
                list: {
                  id: "drive.files.list",
                  path: "files",
                  httpMethod: "GET",
                },
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/drive.readonly",
        }),
      );
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          googleDiscoveryApis: {
            drive: {
              name: "Google Drive",
              description: "Access Google Drive files.",
              discoveryUrl: "https://discovery-proxy.example.com/drive/v3/rest",
              auth: {
                type: "oauth2",
                clientId: "client",
                tokenUrl: "https://auth.example.com/token",
                scopes: ["https://www.googleapis.com/auth/drive.readonly"],
              },
            },
          },
        }),
      );
      process.env.CAPLETS_CONFIG = configPath;
      writeTokenBundle(
        {
          server: "drive",
          authType: "oauth2",
          accessToken: "old-access-token",
          refreshToken: "old-refresh-token",
          expiresAt: "2999-01-01T00:00:00.000Z",
          protectedResourceOrigin: "https://api.example.com",
          scope: "https://www.googleapis.com/auth/drive.readonly",
        },
        authDir,
      );

      await runCli(["auth", "refresh", "drive"], {
        writeOut: (value) => out.push(value),
        authDir,
      });

      expect(out.join("")).toBe("Refreshed OAuth credentials for `drive`.\n");
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "https://discovery-proxy.example.com/drive/v3/rest",
        expect.anything(),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "https://auth.example.com/token",
        expect.objectContaining({ method: "POST" }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs out configured OpenAPI OAuth endpoints", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-auth-"));
    const authDir = join(dir, "auth");
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          openapiEndpoints: {
            users: {
              name: "Users API",
              description: "Manage users through the internal HTTP API.",
              specPath: "/tmp/users-openapi.json",
              auth: { type: "oidc", issuer: "https://issuer.example" },
            },
          },
        }),
      );
      process.env.CAPLETS_CONFIG = configPath;
      writeTokenBundle({ server: "users", accessToken: "secret-access-token" }, authDir);

      await runCli(["auth", "logout", "users"], {
        writeOut: (value) => out.push(value),
        authDir,
      });

      expect(out.join("")).toBe("Deleted OAuth credentials for `users`.\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cli setup", () => {
  it("prints supported integrations when no integration is provided", async () => {
    const out: string[] = [];

    await runCli(["setup"], { writeOut: (value) => out.push(value) });

    const text = out.join("");
    expect(text).toContain("Usage: caplets setup [integration]");
    expect(text).toContain("codex");
    expect(text).toContain("claude-code");
    expect(text).toContain("opencode");
    expect(text).toContain("pi");
    expect(text).toContain("mcp-client");
    expect(text).toContain("--dry-run");
    expect(text).not.toContain("plugin marketplace");
    expect(text).not.toContain("caplets@caplets");
  });

  it("resolves Google Discovery Caplets for Caplet setup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-setup-google-discovery-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          googleDiscoveryApis: {
            drive: {
              name: "Drive API",
              description: "Manage Drive files through Google Discovery.",
              discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
              auth: { type: "none" },
            },
          },
        }),
      );

      await runCli(["setup", "drive"], {
        env: { CAPLETS_CONFIG: configPath },
        writeOut: (value) => out.push(value),
      });

      expect(out.join("")).toBe("No setup metadata is defined for Drive API (drive).\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prompts for integrations when stdin is available", async () => {
    const out: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    await runCli(["setup"], {
      writeOut: (value) => out.push(value),
      readStdin: async () => "1, Claude Code\n",
      runSetupCommand: async (command, args) => {
        commands.push({ command, args });
        return { stdout: "", stderr: "" };
      },
    });

    expect(commands).toEqual([
      { command: "codex", args: ["mcp", "add", "caplets", "--", "caplets", "serve"] },
      {
        command: "claude",
        args: [
          "mcp",
          "add",
          "--transport",
          "stdio",
          "--scope",
          "user",
          "caplets",
          "--",
          "caplets",
          "serve",
        ],
      },
    ]);
    const text = out.join("");
    expect(text).toContain("Select integrations to set up:");
    expect(text).toContain("Completed Codex setup");
    expect(text).toContain("Completed Claude Code setup");
  });

  it("prompts for a generic MCP client output path during interactive setup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-setup-interactive-"));
    const output = join(dir, "caplets.mcp.json");
    const out: string[] = [];

    try {
      await runCli(["setup"], {
        writeOut: (value) => out.push(value),
        readStdin: async () => `Any MCP client\n${output}\n`,
      });

      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
        mcpServers: { caplets: { command: "caplets", args: ["serve"] } },
      });
      const text = out.join("");
      expect(text).toContain("Select integrations to set up:");
      expect(text).toContain("Path to write generic MCP config");
      expect(text).toContain(`completed: wrote ${output}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds Caplets to Codex MCP config", async () => {
    const out: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    await runCli(["setup", "codex"], {
      writeOut: (value) => out.push(value),
      runSetupCommand: async (command, args) => {
        commands.push({ command, args });
        return { stdout: "", stderr: "" };
      },
    });

    expect(commands).toEqual([
      { command: "codex", args: ["mcp", "add", "caplets", "--", "caplets", "serve"] },
    ]);
    expect(out.join("")).toContain("Completed Codex setup");
  });

  it("adds Caplets to Claude Code MCP config", async () => {
    const out: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    await runCli(["setup", "claude-code"], {
      writeOut: (value) => out.push(value),
      runSetupCommand: async (command, args) => {
        commands.push({ command, args });
        return { stdout: "", stderr: "" };
      },
    });

    expect(commands).toEqual([
      {
        command: "claude",
        args: [
          "mcp",
          "add",
          "--transport",
          "stdio",
          "--scope",
          "user",
          "caplets",
          "--",
          "caplets",
          "serve",
        ],
      },
    ]);
    expect(out.join("")).toContain("Completed Claude Code setup");
  });

  it("does not execute commands during dry-run", async () => {
    const out: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    await runCli(["setup", "codex", "--dry-run"], {
      writeOut: (value) => out.push(value),
      runSetupCommand: async (command, args) => {
        commands.push({ command, args });
        return { stdout: "", stderr: "" };
      },
    });

    expect(commands).toEqual([]);
    expect(out.join("")).toContain("Dry run");
    expect(out.join("")).toContain("codex mcp add caplets -- caplets serve");
    expect(out.join("")).not.toContain("plugin marketplace");
    expect(out.join("")).not.toContain("caplets@caplets");
  });

  it("writes a generic MCP client config when output is provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-setup-"));
    const output = join(dir, "nested", "caplets.mcp.json");
    const out: string[] = [];

    try {
      await runCli(["setup", "mcp-client", "--output", output], {
        writeOut: (value) => out.push(value),
      });

      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
        mcpServers: { caplets: { command: "caplets", args: ["serve"] } },
      });
      expect(out.join("")).toContain(`completed: wrote ${output}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects generic MCP client setup without output", async () => {
    await expect(runCli(["setup", "mcp-client"], { writeErr: () => {} })).rejects.toThrow(
      expect.objectContaining({
        code: "REQUEST_INVALID",
        message: expect.stringContaining("requires --output <path>"),
      }) as CapletsError,
    );
  });

  it("writes attach command config for remote generic MCP client setup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-setup-"));
    const output = join(dir, "caplets.remote.json");

    try {
      await runCli(
        [
          "setup",
          "mcp-client",
          "--remote-url",
          "https://caplets.example.test/caplets",
          "--output",
          output,
        ],
        { writeOut: () => {} },
      );

      expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
        mcpServers: {
          caplets: {
            command: "caplets",
            args: ["attach", "--remote-url", "https://caplets.example.test/caplets"],
          },
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs remote OpenCode setup and reports JSON output", async () => {
    const out: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    await runCli(
      [
        "setup",
        "opencode",
        "--remote",
        "--server-url",
        "https://caplets.example.test/caplets",
        "--format",
        "json",
      ],
      {
        writeOut: (value) => out.push(value),
        runSetupCommand: async (command, args) => {
          commands.push({ command, args });
          return { stdout: "", stderr: "" };
        },
      },
    );

    expect(commands).toEqual([
      { command: "opencode", args: ["plugin", "@caplets/opencode", "--global"] },
    ]);
    expect(JSON.parse(out.join(""))).toMatchObject({
      integration: "opencode",
      name: "OpenCode",
      mode: "remote",
      dryRun: false,
      actions: [
        {
          command: "opencode plugin @caplets/opencode --global",
          status: "completed",
        },
      ],
      nextSteps: [
        "Run caplets remote login https://caplets.example.test/caplets before starting OpenCode.",
        "Run OpenCode with CAPLETS_MODE=remote and CAPLETS_REMOTE_URL=https://caplets.example.test/caplets.",
      ],
    });
    expect(out.join("")).not.toContain("CAPLETS_REMOTE_TOKEN");
    expect(out.join("")).not.toContain("CAPLETS_REMOTE_PASSWORD");
  });

  it("uses cloud mode for Cloud OpenCode and Pi setup", async () => {
    const openCodeOut: string[] = [];
    const piOut: string[] = [];

    await runCli(
      ["setup", "opencode", "--remote-url", "https://cloud.caplets.dev", "--format", "json"],
      {
        writeOut: (value) => openCodeOut.push(value),
        runSetupCommand: async () => ({ stdout: "", stderr: "" }),
      },
    );
    await runCli(["setup", "pi", "--remote-url", "https://cloud.caplets.dev", "--format", "json"], {
      writeOut: (value) => piOut.push(value),
      runSetupCommand: async () => ({ stdout: "", stderr: "" }),
    });

    expect(JSON.parse(openCodeOut.join(""))).toMatchObject({
      nextSteps: [
        "Run caplets remote login https://cloud.caplets.dev before starting OpenCode.",
        "Run OpenCode with CAPLETS_MODE=cloud and CAPLETS_REMOTE_URL=https://cloud.caplets.dev.",
      ],
    });
    expect(JSON.parse(piOut.join(""))).toMatchObject({
      nextSteps: [
        "Run caplets remote login https://cloud.caplets.dev before starting Pi.",
        "Start Pi with CAPLETS_MODE=cloud and CAPLETS_REMOTE_URL=https://cloud.caplets.dev.",
      ],
    });
  });

  it("adds remote-backed Caplets to Codex MCP config", async () => {
    const out: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    await runCli(
      [
        "setup",
        "codex",
        "--remote-url",
        "https://caplets.example.test/caplets",
        "--format",
        "json",
      ],
      {
        writeOut: (value) => out.push(value),
        runSetupCommand: async (command, args) => {
          commands.push({ command, args });
          return { stdout: "", stderr: "" };
        },
      },
    );

    expect(commands).toEqual([
      {
        command: "codex",
        args: [
          "mcp",
          "add",
          "caplets",
          "--",
          "caplets",
          "attach",
          "--remote-url",
          "https://caplets.example.test/caplets",
        ],
      },
    ]);
    expect(JSON.parse(out.join(""))).toMatchObject({
      integration: "codex",
      name: "Codex",
      mode: "remote",
      dryRun: false,
      actions: [
        {
          command:
            "codex mcp add caplets -- caplets attach --remote-url https://caplets.example.test/caplets",
          status: "completed",
        },
      ],
      nextSteps: [
        "Run caplets remote login https://caplets.example.test/caplets before using this MCP config.",
        "In Codex, run /mcp to confirm the caplets server is connected.",
      ],
    });
    expect(out.join("")).not.toContain("CAPLETS_REMOTE_TOKEN");
    expect(out.join("")).not.toContain("CAPLETS_REMOTE_PASSWORD");
  });

  it("adds remote-backed Caplets to Claude Code MCP config", async () => {
    const out: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    await runCli(["setup", "claude-code", "--remote-url", "https://caplets.example.test/caplets"], {
      writeOut: (value) => out.push(value),
      runSetupCommand: async (command, args) => {
        commands.push({ command, args });
        return { stdout: "", stderr: "" };
      },
    });

    expect(commands).toEqual([
      {
        command: "claude",
        args: [
          "mcp",
          "add",
          "--transport",
          "stdio",
          "--scope",
          "user",
          "caplets",
          "--",
          "caplets",
          "attach",
          "--remote-url",
          "https://caplets.example.test/caplets",
        ],
      },
    ]);
    expect(out.join("")).toContain(
      "claude mcp add --transport stdio --scope user caplets -- caplets attach --remote-url https://caplets.example.test/caplets",
    );
  });

  it("keeps --server-url as a remote setup alias", async () => {
    const out: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    await runCli(["setup", "codex", "--server-url", "https://legacy.example.test/caplets"], {
      writeOut: (value) => out.push(value),
      runSetupCommand: async (command, args) => {
        commands.push({ command, args });
        return { stdout: "", stderr: "" };
      },
    });

    expect(commands).toEqual([
      {
        command: "codex",
        args: [
          "mcp",
          "add",
          "caplets",
          "--",
          "caplets",
          "attach",
          "--remote-url",
          "https://legacy.example.test/caplets",
        ],
      },
    ]);
    expect(out.join("")).toContain("Completed Codex setup (remote, remote_host)");
  });

  it("wraps setup command failures with the failed command", async () => {
    await expect(
      runCli(["setup", "codex"], {
        writeErr: () => {},
        runSetupCommand: async () => {
          throw new Error("missing codex binary");
        },
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        code: "SERVER_UNAVAILABLE",
        message: expect.stringContaining("codex mcp add caplets -- caplets serve"),
      }) as CapletsError,
    );
  });
});

describe("cli completion commands", () => {
  it("prints completion scripts", async () => {
    const out: string[] = [];

    await runCli(["completion", "bash"], { writeOut: (value) => out.push(value) });

    expect(out.join("")).toContain("caplets __complete --shell bash");
    expect(out.join("")).toContain("complete -o default -F _caplets_completions caplets");
  });

  it("runs the hidden completion endpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-cli-completion-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeInspectionConfig(configPath);

      await runCli(["__complete", "--shell", "bash", "--", "add", ""], {
        env: { CAPLETS_MODE: "local", CAPLETS_CONFIG: configPath },
        writeOut: (value) => out.push(value),
      });

      expect(out.join("").split("\n").filter(Boolean)).toEqual([
        "cli",
        "mcp",
        "openapi",
        "google-discovery",
        "graphql",
        "http",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps the PowerShell trailing-space sentinel before resolving completions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-cli-completion-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeInspectionConfig(configPath);
      await runCli(
        ["__complete", "--shell", "powershell", "--", "call-tool", "__CAPLETS_TRAILING_SPACE__"],
        {
          env: { CAPLETS_CONFIG: configPath },
          writeOut: (value) => out.push(value),
        },
      );

      expect(out.join("").split("\n").filter(Boolean)).toEqual([
        "catalog",
        "drive",
        "filesystem",
        "users",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses configured Caplet IDs in local completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-cli-completion-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeInspectionConfig(configPath);
      await runCli(["__complete", "--shell", "bash", "--", "inspect", ""], {
        env: { CAPLETS_CONFIG: configPath },
        writeOut: (value) => out.push(value),
      });

      expect(out.join("").split("\n").filter(Boolean)).toEqual([
        "catalog",
        "drive",
        "filesystem",
        "users",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses engine-backed discovery for local hidden tool completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-cli-completion-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeOpenApiCompletionConfig(configPath);
      await runCli(["__complete", "--shell", "bash", "--", "get-tool", "users."], {
        env: { CAPLETS_CONFIG: configPath },
        writeOut: (value) => out.push(value),
      });

      expect(out.join("").split("\n").filter(Boolean)).toEqual(["users.lookupUser"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function writeInspectionConfig(path: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        filesystem: {
          name: "Project Files",
          description: "Read and search local project files.",
          command: "node",
          env: {
            TOKEN: "secret-access-token",
          },
        },
        disabled_remote: {
          name: "Disabled Remote",
          description: "A disabled remote server for testing.",
          transport: "http",
          url: "https://disabled.example.com/mcp",
          disabled: true,
        },
      },
      openapiEndpoints: {
        users: {
          name: "Users API",
          description: "Manage users through the internal HTTP API.",
          specPath: "/tmp/users-openapi.json",
          auth: { type: "oauth2", clientId: "openapi-client" },
        },
      },
      googleDiscoveryApis: {
        drive: {
          name: "Drive API",
          description: "Manage Drive files through Google Discovery.",
          discoveryUrl: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
          auth: { type: "none" },
        },
      },
      graphqlEndpoints: {
        catalog: {
          name: "Catalog GraphQL",
          description: "Query and update catalog data through GraphQL.",
          endpointUrl: "https://api.example.com/graphql",
          schemaPath: "/tmp/catalog.graphql",
          auth: { type: "none" },
        },
      },
    }),
  );
}

function writeOpenApiCompletionConfig(path: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const specPath = join(dir, "openapi.json");
  writeFileSync(
    specPath,
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Users API", version: "1.0.0" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/users/{id}": {
          get: {
            operationId: "lookupUser",
            responses: { "200": { description: "OK" } },
          },
        },
      },
    }),
  );
  writeFileSync(
    path,
    JSON.stringify({
      openapiEndpoints: {
        users: {
          name: "Users API",
          description: "Manage users through OpenAPI.",
          specPath,
          auth: { type: "none" },
        },
      },
      completion: {
        discoveryTimeoutMs: 250,
        overallTimeoutMs: 500,
        cacheTtlMs: 0,
        negativeCacheTtlMs: 0,
      },
    }),
  );
}

function writeCliOperationConfig(path: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "tool.mjs");
  writeFileSync(
    script,
    [
      "const action = process.argv[2];",
      "const message = process.argv[3];",
      "if (action === 'fail') { console.log('out'); console.error('err'); process.exit(7); }",
      "if (action === 'no_args') { console.log(JSON.stringify({ ok: message === undefined })); process.exit(0); }",
      "console.log(JSON.stringify({ message }));",
    ].join("\n"),
  );
  writeFileSync(
    path,
    JSON.stringify({
      cliTools: {
        local: {
          name: "Local CLI",
          description: "Run local CLI tools.",
          actions: {
            echo_json: {
              description:
                "Print JSON from the provided message. Second sentence should not appear in list output because it is only for get-tool detail.",
              command: process.execPath,
              args: [script, "echo", "$input.message"],
              inputSchema: {
                type: "object",
                properties: { message: { type: "string" } },
                required: ["message"],
                additionalProperties: false,
              },
              output: { type: "json" },
              outputSchema: {
                type: "object",
                properties: {
                  json: {
                    type: "object",
                    properties: { message: { type: "string" } },
                  },
                },
              },
            },
            no_args: {
              command: process.execPath,
              args: [script, "no_args"],
              output: { type: "json" },
            },
            fail: { command: process.execPath, args: [script, "fail"] },
          },
        },
      },
    }),
  );
}

function writeInstallableRepo(repo: string): void {
  const root = join(repo, "caplets");
  mkdirSync(join(root, "github"), { recursive: true });
  writeFileSync(
    join(root, "filesystem.md"),
    [
      "---",
      "name: Project Files",
      "description: Read and search local project files.",
      "mcpServer:",
      "  command: npx",
      "  args:",
      "    - -y",
      "    - '@modelcontextprotocol/server-filesystem'",
      "    - .",
      "---",
      "# Project Files",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "github", "CAPLET.md"),
    [
      "---",
      "name: GitHub",
      "description: Work with GitHub repositories and pull requests.",
      "mcpServer:",
      "  command: npx",
      "  args:",
      "    - -y",
      "    - github-mcp-server",
      "---",
      "# GitHub",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "github", "README.md"),
    "Extra files are copied with directory Caplets.\n",
  );
}

function capletFixture(name: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: Test Caplet.",
    "mcpServer:",
    "  command: npx",
    "  args:",
    "    - -y",
    "    - test-server",
    "---",
    `# ${name}`,
  ].join("\n");
}

function writeCliRepo(repo: string): void {
  mkdirSync(repo, { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "fixture",
      packageManager: "pnpm@11.0.9",
      scripts: { test: "vitest run" },
    }),
  );
  writeFileSync(join(repo, "pnpm-lock.yaml"), "");
}
