import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProgram } from "../src/cli";
import { completeCliWords, completionScript } from "../src/cli/completion";

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
  it("suggests top-level commands", () => {
    expect(completeCliWords([""])).toEqual(
      expect.arrayContaining(["add", "auth", "call-tool", "completion", "serve"]),
    );
  });

  it("keeps top-level command suggestions in sync with registered CLI commands", () => {
    const registeredCommands = createProgram()
      .commands.filter((command) => command.name() !== "__complete")
      .map((command) => command.name())
      .sort();

    expect(completeCliWords([""]).toSorted()).toEqual(registeredCommands);
  });

  it("suggests nested static subcommands and enum values", () => {
    expect(completeCliWords(["add", ""])).toEqual(["cli", "mcp", "openapi", "graphql", "http"]);
    expect(completeCliWords(["completion", ""])).toEqual([
      "bash",
      "zsh",
      "fish",
      "powershell",
      "cmd",
    ]);
    expect(completeCliWords(["serve", "--transport", ""])).toEqual(["stdio", "http"]);
    expect(completeCliWords(["call-tool", "github.search", "--format", ""])).toEqual([
      "markdown",
      "md",
      "plain",
      "json",
    ]);
  });

  it("suggests enabled Caplet IDs from local config", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-completion-"));
    dirs.push(dir);
    const configPath = join(dir, "config.json");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
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
      }),
    );

    expect(completeCliWords(["get-caplet", ""], { configPath })).toEqual(["github", "repo"]);
    expect(completeCliWords(["call-tool", "git"], { configPath })).toEqual(["github."]);
    expect(completeCliWords(["auth", "login", ""], { configPath })).toEqual(["github", "repo"]);
  });

  it("returns no suggestions instead of throwing when config loading fails", () => {
    expect(completeCliWords(["get-caplet", ""], { configPath: "/missing/config.json" })).toEqual(
      [],
    );
  });
});
