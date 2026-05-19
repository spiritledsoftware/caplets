import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
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
import { writeTokenBundle } from "../src/auth";

describe("cli init", () => {
  const originalConfigPath = process.env.CAPLETS_CONFIG;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalConfigPath === undefined) {
      delete process.env.CAPLETS_CONFIG;
    } else {
      process.env.CAPLETS_CONFIG = originalConfigPath;
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

  it("uses CAPLETS_CONFIG when run through the CLI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-init-"));
    const path = join(dir, "custom.json");
    const out: string[] = [];
    try {
      process.env.CAPLETS_CONFIG = path;

      await runCli(["init"], { writeOut: (value) => out.push(value) });

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

  it("lists enabled Caplets by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-list-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeInspectionConfig(configPath);
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["list"], { writeOut: (value) => out.push(value) });

      const text = out.join("");
      expect(text).toContain("Configured Caplets (3)");
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

      await runCli(["list", "--json"], { writeOut: (value) => out.push(value) });

      expect(JSON.parse(out.join(""))).toEqual([
        expect.objectContaining({
          server: "github",
          source: "project-file",
          path: projectCapletPath,
          shadows: [{ kind: "global-config", path: configPath }],
        }),
      ]);
    } finally {
      process.chdir(cwd);
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

      await runCli(["get-caplet", "local", "--format", "json"], {
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
      expect(results[2].tools).toHaveLength(3);
      expect(results[3]).toMatchObject({ query: "echo" });
      expect(results[3].tools).toHaveLength(1);
      expect(results[4].tool.name).toBe("echo_json");
      expect(results[5].structuredContent).toEqual({ json: { message: "hello" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints agent-first summaries by default for direct Caplet operation commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-call-summary-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeCliOperationConfig(configPath);
      process.env.CAPLETS_CONFIG = configPath;

      await runCli(["get-caplet", "local"], { writeOut: (value) => out.push(value) });
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

      await runCli(["get-caplet", "local", "--format", "plain"], {
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

      await runCli(["add", "cli", "repo-tools", "--repo", repo, "--include", "package"], {
        writeOut: (value) => out.push(value),
      });

      const output = join(projectRoot, ".caplets", "repo-tools.md");
      expect(readFileSync(output, "utf8")).toContain("package_test:");
      expect(out.join("")).toBe(`Wrote CLI Caplet to ${output}\n`);
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

  it("prints added MCP and OpenAPI backend Caplets", async () => {
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

    expect(out.join("\n")).toContain("mcpServer:");
    expect(out.join("\n")).toContain('transport: "sse"');
    expect(out.join("\n")).toContain('token: "$env:MCP_TOKEN"');
    expect(out.join("\n")).toContain("openapiEndpoint:");
    expect(out.join("\n")).toContain('baseUrl: "https://api.example.com/v1"');
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

      await runCli(["install", repo, "github"], { writeOut: (value) => out.push(value) });

      expect(existsSync(join(projectRoot, ".caplets", "github", "CAPLET.md"))).toBe(true);
      expect(existsSync(join(projectRoot, ".caplets", "filesystem.md"))).toBe(false);
      expect(out.join("")).toBe(`Installed github to ${join(projectRoot, ".caplets", "github")}\n`);
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
        "remote\n  Status: authenticated\n  Expires: 2999-01-01T00:00:00.000Z\n  Scope: mcp:tools",
      );
      expect(text).toContain("expired\n  Status: expired\n  Expires: 2000-01-01T00:00:00.000Z");
      expect(text).toContain("users\n  Status: missing");
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
      expect(JSON.parse(out.join(""))).toEqual([{ server: "catalog", status: "missing" }]);
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
