import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli";
import {
  completeCliWords,
  completionScript,
  trailingSpaceCompletionToken,
} from "../src/cli/completion";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CLI completion scripts", () => {
  it("emits Bash, Zsh, Fish, PowerShell, and cmd scripts that call caplets __complete", () => {
    expect(completionScript("bash")).toContain("caplets __complete --shell bash");
    expect(completionScript("bash")).toContain("2>/dev/null");
    expect(completionScript("bash")).toContain(
      "complete -o default -F _caplets_completions caplets",
    );
    expect(completionScript("zsh")).toContain("#compdef caplets");
    expect(completionScript("zsh")).toContain("caplets __complete --shell zsh");
    expect(completionScript("zsh")).toContain("2>/dev/null");
    expect(completionScript("fish")).toContain("complete -c caplets");
    expect(completionScript("fish")).toContain("caplets __complete --shell fish");
    expect(completionScript("fish")).toContain("2>/dev/null");
    expect(completionScript("powershell")).toContain("Register-ArgumentCompleter");
    expect(completionScript("powershell")).toContain("caplets __complete --shell powershell");
    expect(completionScript("powershell")).toContain(trailingSpaceCompletionToken);
    expect(completionScript("powershell")).not.toContain("$tokens += ''");
    expect(completionScript("powershell")).toContain("2>$null");
    expect(completionScript("cmd")).toContain("doskey caplets-complete=");
    expect(completionScript("cmd")).toContain("caplets __complete --shell cmd");
    expect(completionScript("cmd")).toContain("2^>nul");
    expect(completionScript("cmd")).not.toContain("doskey caplets=caplets");
  });

  it("rejects unknown shells for explicit script generation", () => {
    expect(() => completionScript("xonsh" as never)).toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }),
    );
  });
});

describe("CLI completion resolver", () => {
  it("suggests top-level commands", async () => {
    await expect(completeCliWords([""])).resolves.toEqual(
      expect.arrayContaining(["add", "auth", "call-tool", "completion", "serve"]),
    );
  });

  it("keeps top-level command suggestions in sync with registered CLI commands", async () => {
    const registeredCommands = createProgram()
      .commands.filter((command) => command.name() !== "__complete")
      .map((command) => command.name())
      .sort();
    expect((await completeCliWords([""])).toSorted()).toEqual(registeredCommands);
  });

  it("suggests nested static subcommands and enum values", async () => {
    await expect(completeCliWords(["add", ""])).resolves.toEqual([
      "cli",
      "mcp",
      "openapi",
      "graphql",
      "http",
    ]);
    await expect(completeCliWords(["completion", ""])).resolves.toEqual([
      "bash",
      "zsh",
      "fish",
      "powershell",
      "cmd",
    ]);
    await expect(completeCliWords(["serve", "--transport", ""])).resolves.toEqual([
      "stdio",
      "http",
    ]);
    await expect(completeCliWords(["call-tool", "github.search", "--format", ""])).resolves.toEqual(
      ["markdown", "md", "plain", "json"],
    );
  });

  it("suggests enabled Caplet IDs from local config", async () => {
    const { dir, configPath } = writeCompletionConfig({
      mcpServers: {
        github: { name: "GitHub", description: "Use GitHub project tools.", command: "node" },
        disabled: {
          name: "Disabled",
          description: "Disabled test Caplet entry.",
          command: "node",
          disabled: true,
        },
      },
      cliTools: {
        repo: {
          name: "Repo",
          description: "Run repository maintenance commands.",
          actions: {
            status: {
              description: "Print repository status.",
              command: process.execPath,
              args: ["--version"],
            },
          },
        },
      },
    });
    dirs.push(dir);

    await expect(completeCliWords(["inspect", ""], { configPath })).resolves.toEqual([
      "github",
      "repo",
    ]);
    await expect(completeCliWords(["call-tool", "git"], { configPath })).resolves.toEqual([
      "github",
    ]);
    await expect(completeCliWords(["auth", "login", ""], { configPath })).resolves.toEqual([
      "github",
      "repo",
    ]);
  });

  it("limits prompt and resource contexts to MCP Caplet IDs", async () => {
    const { dir, configPath } = writeCompletionConfig({
      mcpServers: {
        docs: {
          name: "Docs",
          description: "Documentation MCP completion server.",
          command: "node",
        },
      },
      httpApis: {
        status_api: {
          name: "Status API",
          description: "Check service status through HTTP actions.",
          baseUrl: "https://api.example.com",
          auth: { type: "none" },
          actions: { check: { method: "GET", path: "/status" } },
        },
      },
      cliTools: {
        repo: {
          name: "Repo",
          description: "Run repository maintenance commands.",
          actions: { status: { command: process.execPath, args: ["--version"] } },
        },
      },
    });
    dirs.push(dir);

    await expect(completeCliWords(["get-prompt", ""], { configPath })).resolves.toEqual(["docs"]);
    await expect(completeCliWords(["read-resource", ""], { configPath })).resolves.toEqual([
      "docs",
    ]);
    await expect(completeCliWords(["complete", ""], { configPath })).resolves.toEqual(["docs"]);
  });

  it("suggests config-defined tool names for qualified CLI and HTTP targets", async () => {
    const { dir, configPath } = writeCompletionConfig({
      cliTools: {
        repo: {
          name: "Repo",
          description: "Run repository maintenance commands.",
          actions: {
            status: {
              description: "Print repository status.",
              command: process.execPath,
              args: ["--version"],
            },
            build: {
              description: "Build the repository.",
              command: process.execPath,
              args: ["--version"],
            },
          },
        },
      },
      httpApis: {
        status_api: {
          name: "Status API",
          description: "Check service status through HTTP actions.",
          baseUrl: "https://api.example.com",
          auth: { type: "none" },
          actions: { check: { method: "GET", path: "/status" } },
        },
      },
    });
    dirs.push(dir);

    await expect(completeCliWords(["call-tool", ""], { configPath })).resolves.toEqual([
      "repo",
      "status_api",
    ]);
    await expect(completeCliWords(["call-tool", "repo", ""], { configPath })).resolves.toEqual([
      "status",
      "build",
    ]);
    await expect(completeCliWords(["get-tool", "status_api", ""], { configPath })).resolves.toEqual(
      ["check"],
    );
    await expect(completeCliWords(["call-tool", "repo."], { configPath })).resolves.toEqual([
      "repo.status",
      "repo.build",
    ]);
    await expect(completeCliWords(["get-tool", "status_api."], { configPath })).resolves.toEqual([
      "status_api.check",
    ]);
  });

  it("does not discover tool names when completing option flags after a split target", async () => {
    const { dir, configPath } = writeCompletionConfig({
      mcpServers: {
        repo: {
          name: "Repo",
          description: "Repository MCP server for completion tests.",
          command: "node",
        },
      },
    });
    dirs.push(dir);
    const listTools = vi.fn(async () => [{ name: "status" }]);

    await expect(
      completeCliWords(["call-tool", "repo", "--format"], {
        configPath,
        managers: { listTools },
      }),
    ).resolves.toEqual([]);
    expect(listTools).not.toHaveBeenCalled();
  });

  it("uses cached discovered tool names when live discovery times out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-completion-cache-"));
    dirs.push(dir);
    const { configPath } = writeMcpConfig(dir, "github");

    await completeCliWords(["call-tool", "github."], {
      configPath,
      cacheDir: dir,
      managers: { listTools: async () => [{ name: "search" }] },
      completion: {
        discoveryTimeoutMs: 10,
        overallTimeoutMs: 20,
        cacheTtlMs: 0,
        negativeCacheTtlMs: 30_000,
      },
    });

    await expect(
      completeCliWords(["call-tool", "github."], {
        configPath,
        cacheDir: dir,
        managers: { listTools: async () => await new Promise(() => {}) },
        completion: {
          discoveryTimeoutMs: 10,
          overallTimeoutMs: 20,
          cacheTtlMs: 0,
          negativeCacheTtlMs: 30_000,
        },
      }),
    ).resolves.toEqual(["github.search"]);
  });

  it("does not call a failing manager again while negative cache is fresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-completion-cache-"));
    dirs.push(dir);
    const { configPath } = writeMcpConfig(dir, "github");
    const listTools = vi.fn(async () => {
      throw new Error("unavailable");
    });

    await expect(
      completeCliWords(["call-tool", "github."], {
        configPath,
        cacheDir: dir,
        managers: { listTools },
      }),
    ).resolves.toEqual([]);
    await expect(
      completeCliWords(["call-tool", "github."], {
        configPath,
        cacheDir: dir,
        managers: { listTools },
      }),
    ).resolves.toEqual([]);
    expect(listTools).toHaveBeenCalledTimes(1);
  });

  it("uses negative cache TTL for unsupported live discovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-completion-cache-"));
    dirs.push(dir);
    const { configPath } = writeMcpConfig(dir, "github");
    const listPrompts = vi.fn(async () => [{ name: "summarize" }]);

    await expect(
      completeCliWords(["get-prompt", "github."], {
        configPath,
        cacheDir: dir,
        completion: {
          discoveryTimeoutMs: 750,
          overallTimeoutMs: 1500,
          cacheTtlMs: 300_000,
          negativeCacheTtlMs: 30_000,
        },
      }),
    ).resolves.toEqual([]);

    await expect(
      completeCliWords(["get-prompt", "github."], {
        configPath,
        cacheDir: dir,
        managers: { listPrompts },
        completion: {
          discoveryTimeoutMs: 750,
          overallTimeoutMs: 1500,
          cacheTtlMs: 300_000,
          negativeCacheTtlMs: 30_000,
        },
      }),
    ).resolves.toEqual([]);
    expect(listPrompts).not.toHaveBeenCalled();
  });

  it("invalidates cached completions when HTTP action discovery shape changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-completion-cache-"));
    dirs.push(dir);
    const firstConfig = writeCompletionConfigInDir(dir, {
      httpApis: {
        status_api: {
          name: "Status API",
          description: "Check service status through HTTP actions.",
          baseUrl: "https://api.example.com",
          auth: { type: "none" },
          actions: { check: { method: "GET", path: "/status" } },
        },
      },
    });
    await expect(
      completeCliWords(["call-tool", "status_api."], { configPath: firstConfig, cacheDir: dir }),
    ).resolves.toEqual(["status_api.check"]);

    const secondConfig = writeCompletionConfigInDir(dir, {
      httpApis: {
        status_api: {
          name: "Status API",
          description: "Check service status through HTTP actions.",
          baseUrl: "https://api.example.com",
          auth: { type: "none" },
          actions: { check_status: { method: "POST", path: "/status/check" } },
        },
      },
    });
    await expect(
      completeCliWords(["call-tool", "status_api."], { configPath: secondConfig, cacheDir: dir }),
    ).resolves.toEqual(["status_api.check_status"]);
  });

  it("suggests resource URIs for read-resource after a selected backend", async () => {
    const { dir, configPath } = writeMcpConfigWithDir("docs");
    dirs.push(dir);
    await expect(
      completeCliWords(["read-resource", "docs", "file://"], {
        configPath,
        managers: { listResources: async () => [{ uri: "file:///repo/README.md" }] },
      }),
    ).resolves.toEqual(["file:///repo/README.md"]);
  });

  it("suggests prompt and resource-template option values for complete", async () => {
    const { dir, configPath } = writeMcpConfigWithDir("docs");
    dirs.push(dir);
    await expect(
      completeCliWords(["complete", "docs", "--prompt", ""], {
        configPath,
        managers: { listPrompts: async () => [{ name: "summarize" }] },
      }),
    ).resolves.toEqual(["summarize"]);
    await expect(
      completeCliWords(["complete", "docs", "--resource-template", "file://"], {
        configPath,
        managers: { listResourceTemplates: async () => [{ uriTemplate: "file:///repo/{path}" }] },
      }),
    ).resolves.toEqual(["file:///repo/{path}"]);
  });

  it("suggests split and dotted prompt targets", async () => {
    const { dir, configPath } = writeMcpConfigWithDir("docs");
    dirs.push(dir);

    await expect(
      completeCliWords(["get-prompt", "docs", ""], {
        configPath,
        managers: { listPrompts: async () => [{ name: "summarize" }] },
      }),
    ).resolves.toEqual(["summarize"]);
    await expect(
      completeCliWords(["get-prompt", "docs."], {
        configPath,
        managers: { listPrompts: async () => [{ name: "summarize" }] },
      }),
    ).resolves.toEqual(["docs.summarize"]);
  });

  it("returns no suggestions instead of throwing when config loading fails", async () => {
    await expect(
      completeCliWords(["inspect", ""], { configPath: "/missing/config.json" }),
    ).resolves.toEqual([]);
  });
});

function writeCompletionConfig(config: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "caplets-completion-"));
  const configPath = writeCompletionConfigInDir(dir, config);
  return { dir, configPath };
}

function writeCompletionConfigInDir(dir: string, config: Record<string, unknown>) {
  const configPath = join(dir, "config.json");
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

function writeMcpConfig(dir: string, server: string) {
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        [server]: {
          name: server,
          description: `${server} MCP server for completion tests.`,
          command: "node",
        },
      },
    }),
  );
  return { dir, configPath };
}

function writeMcpConfigWithDir(server: string) {
  const dir = mkdtempSync(join(tmpdir(), "caplets-completion-"));
  return writeMcpConfig(dir, server);
}
