# CLI Integration Setup Implementation Plan

> Superseded for remote/server environment naming: current client integrations use `CAPLETS_REMOTE_*`, while the process hosting `caplets serve --transport http` uses `CAPLETS_SERVER_*`. This plan remains historical implementation context.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a quick `caplets setup` CLI command that actually installs or configures supported agent integrations, with `--dry-run` available for preview.

**Architecture:** Add an integration setup executor in `packages/core/src/cli/setup.ts` that models each setup as a list of concrete actions. Wire it into the existing Commander CLI in `packages/core/src/cli.ts`, inject the command runner for tests, and keep external mutations limited to explicit agent setup commands or explicit output paths.

**Tech Stack:** TypeScript, Commander, Node `child_process.execFile`, Vitest, existing Caplets CLI helpers, `pnpm` verification.

---

## Command Design

The command should be:

```bash
caplets setup [integration]
```

Supported integrations:

- `codex`
- `claude-code`
- `opencode`
- `pi`
- `mcp-client`

Options:

- `--remote`: configure the integration for a remote Caplets HTTP server where supported.
- `--server-url <url>`: remote Caplets service base URL, defaulting to `CAPLETS_SERVER_URL` when present, otherwise `https://caplets.example.com/caplets`.
- `--output <path>`: write generic MCP client config to a file. Required for `mcp-client`, because there is no universal MCP client config path.
- `--dry-run`: print the exact actions without executing commands or writing files.
- `--format <format>`: `plain` or `json`; default `plain`.

Default behavior is mutating for concrete integrations. `caplets setup codex` runs Codex plugin commands. `caplets setup opencode` runs OpenCode's plugin installer. The command should fail if a required external binary is unavailable and should show the exact failed action.

Known executable command shapes, verified locally where available:

```bash
codex plugin marketplace add spiritledsoftware/caplets
codex plugin add caplets@caplets
opencode plugin @caplets/opencode --global
pi install npm:@caplets/pi
```

Claude Code is not installed in this environment, but existing repo docs use:

```bash
claude plugin marketplace add spiritledsoftware/caplets
claude plugin install caplets@caplets
```

Out of scope for this first implementation:

- Editing arbitrary unknown MCP client config files without `--output`.
- Detecting every possible agent install location.
- Managing secrets.
- Starting or daemonizing `caplets serve`.

## File Structure

- Create: `packages/core/src/cli/setup.ts`
  - Owns supported integration IDs.
  - Owns setup action modeling.
  - Executes external commands through an injected runner.
  - Writes generic MCP config files only when `--output` is provided.
  - Formats execution results for plain and JSON output.
- Modify: `packages/core/src/cli/commands.ts`
  - Adds `setup` to `cliCommands`.
  - Adds `setup` to `topLevelCommandNames`.
  - Adds setup integration completions to `cliSubcommands`.
- Modify: `packages/core/src/cli.ts`
  - Extends `CliIO` with an optional setup command runner.
  - Imports setup helpers.
  - Adds the Commander command.
- Modify: `packages/core/src/cli/completion.ts`
  - Adds `setup --format` value completion.
- Test: `packages/core/test/cli.test.ts`
  - Adds setup execution tests with injected command runners.
- Test: `packages/core/test/cli-completion.test.ts`
  - Adds completion tests for `setup`.
- Modify: `README.md` and `packages/cli/README.md`
  - Documents that `caplets setup` performs setup, and that `--dry-run` previews actions.
- Create: `.changeset/quick-setup-cli.md`
  - Patch release for `@caplets/core` and `caplets`, because this adds a user-facing CLI command exported through the published CLI package.

## Task 1: Add Failing Setup Execution Tests

**Files:**

- Test: `packages/core/test/cli.test.ts`
- Later create: `packages/core/src/cli/setup.ts`

- [ ] **Step 1: Write failing tests for menu, Codex execution, and dry-run**

Add this block near existing CLI command tests in `packages/core/test/cli.test.ts`:

```ts
describe("cli setup", () => {
  it("prints supported integrations when no integration is provided", async () => {
    const out: string[] = [];

    await runCli(["setup"], { writeOut: (value) => out.push(value) });

    const text = out.join("");
    expect(text).toContain("Usage: caplets setup <integration>");
    expect(text).toContain("codex");
    expect(text).toContain("claude-code");
    expect(text).toContain("opencode");
    expect(text).toContain("pi");
    expect(text).toContain("mcp-client");
    expect(text).toContain("--dry-run");
  });

  it("runs Codex setup commands", async () => {
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
      { command: "codex", args: ["plugin", "marketplace", "add", "spiritledsoftware/caplets"] },
      { command: "codex", args: ["plugin", "add", "caplets@caplets"] },
    ]);
    expect(out.join("")).toContain("Completed Codex setup");
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
    expect(out.join("")).toContain("codex plugin marketplace add spiritledsoftware/caplets");
    expect(out.join("")).toContain("codex plugin add caplets@caplets");
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --filter @caplets/core test -- test/cli.test.ts
```

Expected before implementation: tests fail because `setup` is an unknown command and `runSetupCommand` is not part of `CliIO`.

## Task 2: Implement Setup Action Model and Local Execution

**Files:**

- Create: `packages/core/src/cli/setup.ts`
- Modify: `packages/core/src/cli/commands.ts`
- Modify: `packages/core/src/cli.ts`

- [ ] **Step 1: Add command constants**

In `packages/core/src/cli/commands.ts`, add `setup`:

```ts
export const cliCommands = {
  completion: "completion",
  completeHidden: "__complete",
  serve: "serve",
  init: "init",
  setup: "setup",
  list: "list",
  install: "install",
  add: "add",
  inspect: "inspect",
  checkBackend: "check-backend",
  listTools: "list-tools",
  searchTools: "search-tools",
  getTool: "get-tool",
  callTool: "call-tool",
  listResources: "list-resources",
  searchResources: "search-resources",
  listResourceTemplates: "list-resource-templates",
  readResource: "read-resource",
  listPrompts: "list-prompts",
  searchPrompts: "search-prompts",
  getPrompt: "get-prompt",
  complete: "complete",
  config: "config",
  auth: "auth",
} as const;
```

Also insert `cliCommands.setup` in `topLevelCommandNames` after `init`, and add:

```ts
[cliCommands.setup]: ["codex", "claude-code", "opencode", "pi", "mcp-client"],
```

to `cliSubcommands`.

- [ ] **Step 2: Create setup executor**

Create `packages/core/src/cli/setup.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { CapletsError } from "../errors";

const execFileAsync = promisify(execFile);

export const setupIntegrationIds = [
  "codex",
  "claude-code",
  "opencode",
  "pi",
  "mcp-client",
] as const;

export type SetupIntegrationId = (typeof setupIntegrationIds)[number];
export type SetupFormat = "plain" | "json";

export type SetupCommandResult = {
  stdout: string;
  stderr: string;
};

export type SetupCommandRunner = (command: string, args: string[]) => Promise<SetupCommandResult>;

export type SetupOptions = {
  remote?: boolean;
  serverUrl?: string;
  output?: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  format?: SetupFormat;
  runCommand?: SetupCommandRunner;
};

type SetupAction =
  | { type: "command"; label: string; command: string; args: string[] }
  | { type: "writeFile"; label: string; path: string; content: string };

type SetupActionResult = {
  label: string;
  command?: string;
  path?: string;
  status: "planned" | "completed";
};

type SetupResult = {
  integration: SetupIntegrationId;
  name: string;
  mode: "local" | "remote";
  dryRun: boolean;
  actions: SetupActionResult[];
  nextSteps: string[];
};

const localMcpConfig = `{
  "mcpServers": {
    "caplets": {
      "command": "caplets",
      "args": ["serve"]
    }
  }
}
`;

export function formatSetupMenu(): string {
  return [
    "Usage: caplets setup <integration>",
    "",
    "Supported integrations:",
    "  codex        Run Codex plugin marketplace and plugin install commands",
    "  claude-code  Run Claude Code plugin marketplace and plugin install commands",
    "  opencode     Run OpenCode native plugin install",
    "  pi           Run Pi extension install",
    "  mcp-client   Write a generic MCP client config with --output",
    "",
    "Examples:",
    "  caplets setup codex",
    "  caplets setup opencode --dry-run",
    "  caplets setup mcp-client --output ./caplets.mcp.json",
    "",
  ].join("\n");
}

export async function runSetup(integration: string, options: SetupOptions = {}): Promise<string> {
  const result = await executeSetup(integration, options);
  if (options.format === "json") return `${JSON.stringify(result, null, 2)}\n`;
  return formatSetupResult(result);
}

async function executeSetup(integration: string, options: SetupOptions): Promise<SetupResult> {
  const id = parseSetupIntegrationId(integration);
  const definition = setupDefinition(id, options);
  const actions: SetupActionResult[] = [];
  const runner = options.runCommand ?? defaultSetupCommandRunner;

  for (const action of definition.actions) {
    if (action.type === "command") {
      const commandText = formatCommand(action.command, action.args);
      if (!options.dryRun) {
        try {
          await runner(action.command, action.args);
        } catch (error) {
          throw new CapletsError(
            "REQUEST_FAILED",
            `Setup action failed: ${commandText}${error instanceof Error ? `: ${error.message}` : ""}`,
          );
        }
      }
      actions.push({
        label: action.label,
        command: commandText,
        status: options.dryRun ? "planned" : "completed",
      });
      continue;
    }

    if (!options.dryRun) {
      mkdirSync(dirname(action.path), { recursive: true });
      writeFileSync(action.path, action.content, { flag: "wx", mode: 0o600 });
    }
    actions.push({
      label: action.label,
      path: action.path,
      status: options.dryRun ? "planned" : "completed",
    });
  }

  return {
    integration: id,
    name: definition.name,
    mode: options.remote ? "remote" : "local",
    dryRun: Boolean(options.dryRun),
    actions,
    nextSteps: definition.nextSteps,
  };
}

function setupDefinition(
  id: SetupIntegrationId,
  options: SetupOptions,
): { name: string; actions: SetupAction[]; nextSteps: string[] } {
  if (options.remote) return remoteSetupDefinition(id, options);

  switch (id) {
    case "codex":
      return {
        name: "Codex",
        actions: [
          {
            type: "command",
            label: "Add Caplets marketplace to Codex",
            command: "codex",
            args: ["plugin", "marketplace", "add", "spiritledsoftware/caplets"],
          },
          {
            type: "command",
            label: "Install Caplets Codex plugin",
            command: "codex",
            args: ["plugin", "add", "caplets@caplets"],
          },
        ],
        nextSteps: [
          "Try a premade Caplet: caplets install spiritledsoftware/caplets github",
          'Ask Codex: codex "try using the github caplet"',
        ],
      };
    case "claude-code":
      return {
        name: "Claude Code",
        actions: [
          {
            type: "command",
            label: "Add Caplets marketplace to Claude Code",
            command: "claude",
            args: ["plugin", "marketplace", "add", "spiritledsoftware/caplets"],
          },
          {
            type: "command",
            label: "Install Caplets Claude Code plugin",
            command: "claude",
            args: ["plugin", "install", "caplets@caplets"],
          },
        ],
        nextSteps: [
          "Restart Claude Code if it was already running.",
          "Try a premade Caplet: caplets install spiritledsoftware/caplets github",
        ],
      };
    case "opencode":
      return {
        name: "OpenCode",
        actions: [
          {
            type: "command",
            label: "Install OpenCode Caplets plugin globally",
            command: "opencode",
            args: ["plugin", "@caplets/opencode", "--global"],
          },
        ],
        nextSteps: [
          "OpenCode reads local Caplets config and exposes native caplets_<id> tools.",
          "Try a premade Caplet: caplets install spiritledsoftware/caplets github",
        ],
      };
    case "pi":
      return {
        name: "Pi",
        actions: [
          {
            type: "command",
            label: "Install Pi Caplets extension",
            command: "pi",
            args: ["install", "npm:@caplets/pi"],
          },
        ],
        nextSteps: [
          "Pi reads local Caplets config and exposes native tools.",
          "Try a premade Caplet: caplets install spiritledsoftware/caplets github",
        ],
      };
    case "mcp-client":
      if (!options.output) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "caplets setup mcp-client requires --output <path> because MCP clients do not share one config path",
        );
      }
      return {
        name: "Any MCP client",
        actions: [
          {
            type: "writeFile",
            label: "Write generic MCP stdio config",
            path: options.output,
            content: localMcpConfig,
          },
        ],
        nextSteps: ["Import the written MCP config into your MCP client."],
      };
  }
}

function remoteSetupDefinition(
  id: SetupIntegrationId,
  options: SetupOptions,
): { name: string; actions: SetupAction[]; nextSteps: string[] } {
  const serverUrl =
    nonEmpty(options.serverUrl) ??
    nonEmpty(options.env?.CAPLETS_SERVER_URL) ??
    "https://caplets.example.com/caplets";

  if (id === "opencode") {
    return {
      name: "OpenCode",
      actions: [
        {
          type: "command",
          label: "Install OpenCode Caplets plugin globally",
          command: "opencode",
          args: ["plugin", "@caplets/opencode", "--global"],
        },
      ],
      nextSteps: [
        `Run OpenCode with CAPLETS_MODE=remote and CAPLETS_SERVER_URL=${serverUrl}.`,
        "Keep CAPLETS_SERVER_PASSWORD in your shell or secret manager.",
      ],
    };
  }

  if (id === "pi") {
    return {
      name: "Pi",
      actions: [
        {
          type: "command",
          label: "Install Pi Caplets extension",
          command: "pi",
          args: ["install", "npm:@caplets/pi"],
        },
      ],
      nextSteps: [
        `Start Pi with CAPLETS_MODE=remote and CAPLETS_SERVER_URL=${serverUrl}.`,
        "Keep CAPLETS_SERVER_PASSWORD in your shell or secret manager.",
      ],
    };
  }

  if (!options.output) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "remote MCP-backed setup requires --output <path> so Caplets can write a client config without guessing your agent's secret storage",
    );
  }

  return {
    name: id === "codex" ? "Codex" : id === "claude-code" ? "Claude Code" : "Any MCP client",
    actions: [
      {
        type: "writeFile",
        label: "Write remote MCP config",
        path: options.output,
        content: `${JSON.stringify({ mcpServers: { caplets: { url: `${serverUrl.replace(/\/$/, "")}/mcp` } } }, null, 2)}\n`,
      },
    ],
    nextSteps: [
      "Add Basic Auth credentials through your agent's secret mechanism.",
      "Do not hardcode CAPLETS_SERVER_PASSWORD in a committed config file.",
    ],
  };
}

function parseSetupIntegrationId(value: string): SetupIntegrationId {
  if (setupIntegrationIds.includes(value as SetupIntegrationId)) {
    return value as SetupIntegrationId;
  }
  throw new CapletsError(
    "REQUEST_INVALID",
    `setup integration must be one of: ${setupIntegrationIds.join(", ")}`,
  );
}

async function defaultSetupCommandRunner(
  command: string,
  args: string[],
): Promise<SetupCommandResult> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    encoding: "utf8",
    windowsHide: true,
  });
  return { stdout, stderr };
}

function formatSetupResult(result: SetupResult): string {
  const lines = [
    `${result.dryRun ? "Dry run" : "Completed"} ${result.name} setup (${result.mode})`,
    "",
  ];
  for (const action of result.actions) {
    if (action.command) lines.push(`- ${action.status}: ${action.command}`);
    if (action.path) lines.push(`- ${action.status}: wrote ${action.path}`);
  }
  if (result.nextSteps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of result.nextSteps) lines.push(`- ${step}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
```

- [ ] **Step 3: Wire Commander and injected runner**

In `packages/core/src/cli.ts`, import:

```ts
import { runSetup, type SetupCommandRunner, type SetupFormat } from "./cli/setup";
```

Extend `CliIO`:

```ts
type CliIO = {
  writeOut?: (value: string) => void;
  writeErr?: (value: string) => void;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  fetch?: typeof fetch;
  authDir?: string;
  version?: string;
  setExitCode?: (code: number) => void;
  serve?: (options: ServeOptions) => Promise<void>;
  runSetupCommand?: SetupCommandRunner;
};
```

Add this command after `init`:

```ts
program
  .command(cliCommands.setup)
  .description("Install or configure an agent integration for Caplets.")
  .argument("[integration]", "integration: codex, claude-code, opencode, pi, or mcp-client")
  .option("--remote", "configure for a remote Caplets server")
  .option("--server-url <url>", "remote Caplets service base URL")
  .option("--output <path>", "config path to write for generic MCP setup")
  .option("--dry-run", "print actions without running commands or writing files")
  .option("--format <format>", "output format: plain or json", parseSetupFormat)
  .action(
    async (
      integration: string | undefined,
      options: {
        remote?: boolean;
        serverUrl?: string;
        output?: string;
        dryRun?: boolean;
        format?: SetupFormat;
      },
    ) => {
      if (!integration) {
        writeOut(formatSetupMenu());
        return;
      }
      writeOut(
        await runSetup(integration, {
          ...options,
          env,
          runCommand: io.runSetupCommand,
        }),
      );
    },
  );
```

Keep `formatSetupMenu` imported:

```ts
import { formatSetupMenu, runSetup, type SetupCommandRunner, type SetupFormat } from "./cli/setup";
```

Add this helper near existing parse helpers:

```ts
function parseSetupFormat(value: string): SetupFormat {
  if (value === "plain" || value === "json") return value;
  throw new CapletsError("REQUEST_INVALID", "setup format must be plain or json");
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm --filter @caplets/core test -- test/cli.test.ts
```

Expected: the new setup tests pass.

## Task 3: Add File Write, Remote, JSON, and Failure Coverage

**Files:**

- Modify: `packages/core/test/cli.test.ts`
- Modify: `packages/core/src/cli/setup.ts`

- [ ] **Step 1: Write failing tests for generic config writing and invalid generic setup**

Add:

```ts
it("writes a generic MCP client config when output is provided", async () => {
  const dir = mkdtempSync(join(tmpdir(), "caplets-setup-mcp-"));
  const output = join(dir, "caplets.mcp.json");
  const out: string[] = [];
  try {
    await runCli(["setup", "mcp-client", "--output", output], {
      writeOut: (value) => out.push(value),
    });

    expect(readFileSync(output, "utf8")).toContain('"command": "caplets"');
    expect(readFileSync(output, "utf8")).toContain('"args": ["serve"]');
    expect(out.join("")).toContain("Completed Any MCP client setup");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("rejects generic MCP client setup without output", async () => {
  await expect(runCli(["setup", "mcp-client"], { writeErr: () => {} })).rejects.toThrow(
    expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
  );
});
```

- [ ] **Step 2: Write failing tests for remote JSON and command failure**

Add:

```ts
it("runs remote OpenCode setup and reports JSON output", async () => {
  const out: string[] = [];
  const commands: Array<{ command: string; args: string[] }> = [];

  await runCli(["setup", "opencode", "--remote", "--format", "json"], {
    writeOut: (value) => out.push(value),
    runSetupCommand: async (command, args) => {
      commands.push({ command, args });
      return { stdout: "", stderr: "" };
    },
  });

  const parsed = JSON.parse(out.join(""));
  expect(commands).toEqual([
    { command: "opencode", args: ["plugin", "@caplets/opencode", "--global"] },
  ]);
  expect(parsed).toMatchObject({
    integration: "opencode",
    name: "OpenCode",
    mode: "remote",
    dryRun: false,
  });
});

it("wraps setup command failures with the failed command", async () => {
  await expect(
    runCli(["setup", "codex"], {
      writeErr: () => {},
      runSetupCommand: async () => {
        throw new Error("missing binary");
      },
    }),
  ).rejects.toThrow(
    expect.objectContaining({
      code: "REQUEST_FAILED",
      message: expect.stringContaining("codex plugin marketplace add spiritledsoftware/caplets"),
    }) as CapletsError,
  );
});
```

- [ ] **Step 3: Run focused tests and verify failure before implementation**

Run:

```bash
pnpm --filter @caplets/core test -- test/cli.test.ts
```

Expected before Task 2 implementation: failures identify missing setup behavior. Expected after Task 2 implementation: all setup tests pass.

## Task 4: Add Completion Coverage

**Files:**

- Modify: `packages/core/test/cli-completion.test.ts`
- Modify: `packages/core/src/cli/commands.ts`
- Modify: `packages/core/src/cli/completion.ts`

- [ ] **Step 1: Write failing completion tests**

Add tests to `packages/core/test/cli-completion.test.ts`:

```ts
it("suggests setup as a top-level command", async () => {
  await expect(completeCliWords(["set"])).resolves.toContain("setup");
});

it("suggests setup integrations", async () => {
  await expect(completeCliWords(["setup", ""])).resolves.toEqual([
    "codex",
    "claude-code",
    "opencode",
    "pi",
    "mcp-client",
  ]);
});

it("suggests setup formats", async () => {
  await expect(completeCliWords(["setup", "codex", "--format", ""])).resolves.toEqual([
    "plain",
    "json",
  ]);
});
```

- [ ] **Step 2: Run completion tests and verify failure**

Run:

```bash
pnpm --filter @caplets/core test -- test/cli-completion.test.ts
```

Expected before implementation: `setup` and setup format suggestions are missing.

- [ ] **Step 3: Add setup completion values**

In `packages/core/src/cli/completion.ts`, update `optionValueSuggestions`:

```ts
const optionValueSuggestions: Record<string, Record<string, string[]>> = {
  "*": { "--format": ["markdown", "md", "plain", "json"] },
  setup: { "--format": ["plain", "json"] },
  serve: { "--transport": ["stdio", "http"] },
  "add:mcp": { "--transport": ["http", "sse"] },
  "add:cli": { "--include": ["git", "gh", "package"] },
};
```

The `cliSubcommands` update from Task 2 supplies integration suggestions.

- [ ] **Step 4: Run completion tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/cli-completion.test.ts
```

Expected: completion tests pass.

## Task 5: Document Mutating Setup

**Files:**

- Modify: `README.md`
- Modify: `packages/cli/README.md`

- [ ] **Step 1: Add setup command documentation**

In both README files, near the existing integration table, add:

````md
### Quick integration setup

Use `caplets setup` to install or configure an agent integration:

```bash
caplets setup codex
caplets setup claude-code
caplets setup opencode
caplets setup pi
caplets setup mcp-client --output ./caplets.mcp.json
```

Preview actions before changing anything:

```bash
caplets setup codex --dry-run
```

For native integrations that should connect to a remote Caplets HTTP service:

```bash
caplets setup opencode --remote --server-url https://caplets.example.com/caplets
```

`caplets setup` runs the supported agent installer commands or writes the explicit config path you pass with `--output`. It does not store secrets, edit unknown MCP client config locations, or start `caplets serve`.
````

- [ ] **Step 2: Run docs-sensitive checks**

Run:

```bash
pnpm format:check
```

Expected: formatting passes.

## Task 6: Add Changeset

**Files:**

- Create: `.changeset/quick-setup-cli.md`

- [ ] **Step 1: Add a changeset**

Create `.changeset/quick-setup-cli.md`:

```md
---
"@caplets/core": patch
"caplets": patch
---

Add `caplets setup` to install or configure supported agent integrations.
```

- [ ] **Step 2: Run focused package checks**

Run:

```bash
pnpm --filter @caplets/core test -- test/cli.test.ts test/cli-completion.test.ts
pnpm --filter @caplets/core typecheck
```

Expected: tests and typecheck pass.

## Task 7: Full Verification

**Files:**

- All changed files.

- [ ] **Step 1: Run the full gate**

Run:

```bash
pnpm verify
```

Expected:

- format check passes.
- lint passes.
- typecheck passes.
- schema check passes.
- Vitest passes.
- benchmark check passes.
- build passes.

- [ ] **Step 2: Inspect final diff**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors. Changed files should be limited to CLI setup implementation, tests, docs, and changeset, plus pre-existing unrelated work that should not be reverted.

## Self-Review

Spec coverage:

- Setup performs real actions by default: covered by Tasks 1-3.
- Dry-run preview: covered by Task 1.
- Codex, Claude Code, OpenCode, Pi, and generic MCP client surfaces: covered by Task 2.
- Generic MCP client safety through explicit `--output`: covered by Task 3.
- Remote setup mode: covered by Tasks 2-3.
- Completion support: covered by Task 4.
- Documentation: covered by Task 5.
- Release metadata: covered by Task 6.
- Verification: covered by Task 7.

Placeholder scan:

- No unresolved implementation placeholders remain.
- Every implementation step includes concrete file paths and code shapes.

Type consistency:

- `SetupIntegrationId`, `SetupFormat`, `SetupCommandRunner`, and `SetupCommandResult` are introduced before use.
- Commander wiring uses `runSetup`, `formatSetupMenu`, and `parseSetupFormat` exactly as defined.
