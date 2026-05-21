# CLI Completions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Bash, Zsh, and Fish completion support to the `caplets` npm CLI with static command/option suggestions and safe config-aware Caplet ID suggestions.

**Architecture:** Put completion script generation and completion resolution in a focused core module, then wire it into the existing Commander CLI through a public `completion` command and hidden `__complete` command. Remote mode uses the structured `/control` API with a `complete_cli` command so completion remains server-owned and never executes raw CLI strings remotely.

**Tech Stack:** TypeScript, Commander, Vitest, Caplets remote control, pnpm 11.0.9.

---

## Scope and constraints

- Use `pnpm` only.
- Implement completion support in `@caplets/core` because `packages/cli` delegates CLI behavior to core.
- Support `bash`, `zsh`, and `fish`.
- Do not add npm `postinstall` behavior.
- Do not edit user shell startup files automatically.
- Do not start downstream MCP servers, run OpenAPI/GraphQL/HTTP calls, or execute configured CLI tools while completing.
- Keep completion failures quiet for `__complete`; explicit `completion <shell>` errors may fail clearly.
- Remote mode must use command-semantic `/control`, not raw command strings.
- Add a changeset because this is a user-facing CLI feature.

## File structure

- Create `packages/core/src/cli/completion.ts`
  - Own supported shell names, static completion tables, shell script generation, and completion resolution.
- Modify `packages/core/src/cli.ts`
  - Add `completion <shell>` and hidden `__complete` commands.
  - Route hidden completion to remote mode when applicable.
- Modify `packages/core/src/remote-control/types.ts`
  - Add `complete_cli` to `RemoteCliCommand`.
- Modify `packages/core/src/remote-control/dispatch.ts`
  - Dispatch `complete_cli` using server-owned config and the shared completion resolver.
- Add `packages/core/test/cli-completion.test.ts`
  - Test shell script emission and local resolver behavior.
- Modify `packages/core/test/cli-remote.test.ts`
  - Test remote-mode hidden completion routing.
- Modify `packages/core/test/remote-control-dispatch.test.ts`
  - Test server-side `complete_cli` dispatch.
- Modify `README.md` and `packages/cli/README.md`
  - Document completion installation snippets.
- Add `.changeset/cli-completions.md`
  - Release note for `caplets`; include `@caplets/core` if exported APIs are changed.

---

### Task 1: Add completion resolver and script generator

**Files:**

- Create: `packages/core/src/cli/completion.ts`
- Test: `packages/core/test/cli-completion.test.ts`

- [ ] **Step 1: Write failing resolver and script tests**

Create `packages/core/test/cli-completion.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { completeCliWords, completionScript } from "../src/cli/completion";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CLI completion scripts", () => {
  it("emits Bash, Zsh, and Fish scripts that call caplets __complete", () => {
    expect(completionScript("bash")).toContain("caplets __complete --shell bash");
    expect(completionScript("bash")).toContain(
      "complete -o default -F _caplets_completions caplets",
    );

    expect(completionScript("zsh")).toContain("#compdef caplets");
    expect(completionScript("zsh")).toContain("caplets __complete --shell zsh");

    expect(completionScript("fish")).toContain("complete -c caplets");
    expect(completionScript("fish")).toContain("caplets __complete --shell fish");
  });

  it("rejects unknown shells for explicit script generation", () => {
    expect(() => completionScript("powershell" as never)).toThrow(
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

  it("suggests nested static subcommands and enum values", () => {
    expect(completeCliWords(["add", ""])).toEqual(["cli", "mcp", "openapi", "graphql", "http"]);
    expect(completeCliWords(["completion", ""])).toEqual(["bash", "zsh", "fish"]);
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
          github: { name: "GitHub", description: "GitHub", command: "node" },
          disabled: { name: "Disabled", description: "Disabled", command: "node", disabled: true },
        },
        cliTools: {
          repo: { name: "Repo", description: "Repo", actions: {} },
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
```

- [ ] **Step 2: Run focused tests to verify red**

Run:

```sh
pnpm --filter @caplets/core test -- test/cli-completion.test.ts
```

Expected: FAIL because `packages/core/src/cli/completion.ts` does not exist.

- [ ] **Step 3: Implement completion module**

Create `packages/core/src/cli/completion.ts`:

```ts
import { loadConfigWithSources } from "../config";
import { CapletsError } from "../errors";
import { listCaplets } from "./inspection";

export const completionShells = ["bash", "zsh", "fish"] as const;
export type CompletionShell = (typeof completionShells)[number];

export type CompletionOptions = {
  configPath?: string;
  projectConfigPath?: string;
};

const topLevelCommands = [
  "serve",
  "init",
  "list",
  "install",
  "add",
  "get-caplet",
  "check-backend",
  "list-tools",
  "search-tools",
  "get-tool",
  "call-tool",
  "list-resources",
  "search-resources",
  "list-resource-templates",
  "read-resource",
  "list-prompts",
  "search-prompts",
  "get-prompt",
  "complete",
  "config",
  "auth",
  "completion",
];

const subcommands: Record<string, string[]> = {
  add: ["cli", "mcp", "openapi", "graphql", "http"],
  auth: ["login", "logout", "list"],
  completion: ["bash", "zsh", "fish"],
  config: ["path", "paths"],
};

const optionValueSuggestions: Record<string, Record<string, string[]>> = {
  "*": {
    "--format": ["markdown", "md", "plain", "json"],
  },
  serve: {
    "--transport": ["stdio", "http"],
  },
  "add:mcp": {
    "--transport": ["http", "sse"],
  },
  "add:cli": {
    "--include": ["git", "gh", "package"],
  },
};

const capletIdCommands = new Set([
  "get-caplet",
  "check-backend",
  "list-tools",
  "search-tools",
  "list-resources",
  "search-resources",
  "list-resource-templates",
  "read-resource",
  "list-prompts",
  "search-prompts",
  "complete",
]);

const qualifiedTargetCommands = new Set(["get-tool", "call-tool", "get-prompt"]);

export function completionScript(shell: CompletionShell): string {
  switch (shell) {
    case "bash":
      return bashCompletionScript();
    case "zsh":
      return zshCompletionScript();
    case "fish":
      return fishCompletionScript();
    default:
      throw new CapletsError("REQUEST_INVALID", "completion shell must be bash, zsh, or fish");
  }
}

export function completeCliWords(words: string[], options: CompletionOptions = {}): string[] {
  try {
    const normalized = words.length === 0 ? [""] : words;
    const current = normalized.at(-1) ?? "";
    const previous = normalized.at(-2);
    const command = normalized[0] ?? "";
    const subcommand = normalized[1] ?? "";

    const optionValues = suggestionsForOptionValue(command, subcommand, previous);
    if (optionValues) return prefixFilter(optionValues, current);

    if (normalized.length === 1) return prefixFilter(topLevelCommands, current);

    if (normalized.length === 2 && subcommands[command]) {
      return prefixFilter(subcommands[command], current);
    }

    if (normalized.length === 2 && capletIdCommands.has(command)) {
      return prefixFilter(configuredCapletIds(options), current);
    }

    if (normalized.length === 2 && qualifiedTargetCommands.has(command)) {
      return prefixFilter(
        configuredCapletIds(options).map((id) => `${id}.`),
        current,
      );
    }

    if (command === "auth" && ["login", "logout"].includes(subcommand) && normalized.length === 3) {
      return prefixFilter(configuredCapletIds(options), current);
    }

    return [];
  } catch {
    return [];
  }
}

function suggestionsForOptionValue(
  command: string,
  subcommand: string,
  previous: string | undefined,
): string[] | undefined {
  if (!previous) return undefined;
  return (
    optionValueSuggestions[`${command}:${subcommand}`]?.[previous] ??
    optionValueSuggestions[command]?.[previous] ??
    optionValueSuggestions["*"]?.[previous]
  );
}

function configuredCapletIds(options: CompletionOptions): string[] {
  const loaded = loadConfigWithSources(options.configPath, options.projectConfigPath);
  return listCaplets(loaded, { includeDisabled: false }).map((row) => row.server);
}

function prefixFilter(values: string[], prefix: string): string[] {
  return values.filter((value) => value.startsWith(prefix));
}

function bashCompletionScript(): string {
  return `# caplets bash completion
_caplets_completions() {
  local IFS=$'\\n'
  COMPREPLY=( $(caplets __complete --shell bash -- "${COMP_WORDS[@]:1}") )
}
complete -o default -F _caplets_completions caplets
`;
}

function zshCompletionScript(): string {
  return `#compdef caplets
_caplets() {
  local -a suggestions
  suggestions=("${(@f)$(caplets __complete --shell zsh -- "${words[@]:1}")}")
  compadd -- $suggestions
}
_caplets "$@"
`;
}

function fishCompletionScript(): string {
  return `# caplets fish completion
function __caplets_complete
  set -l tokens (commandline -opc)
  set -l current (commandline -ct)
  caplets __complete --shell fish -- $tokens[2..-1] $current
end
complete -c caplets -f -a '(__caplets_complete)'
`;
}
```

- [ ] **Step 4: Run focused tests to verify green**

Run:

```sh
pnpm --filter @caplets/core test -- test/cli-completion.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit resolver module**

```sh
git add packages/core/src/cli/completion.ts packages/core/test/cli-completion.test.ts
git commit -m "feat(cli): add completion resolver"
```

---

### Task 2: Wire public and hidden CLI commands

**Files:**

- Modify: `packages/core/src/cli.ts`
- Test: `packages/core/test/cli.test.ts`

- [ ] **Step 1: Write failing CLI command tests**

Add this `describe` block to `packages/core/test/cli.test.ts` before helper functions:

```ts
describe("cli completion commands", () => {
  it("prints completion scripts", async () => {
    const out: string[] = [];

    await runCli(["completion", "bash"], { writeOut: (value) => out.push(value) });

    expect(out.join("")).toContain("caplets __complete --shell bash");
    expect(out.join("")).toContain("complete -o default -F _caplets_completions caplets");
  });

  it("runs the hidden completion endpoint", async () => {
    const out: string[] = [];

    await runCli(["__complete", "--shell", "bash", "--", "add", ""], {
      writeOut: (value) => out.push(value),
    });

    expect(out.join("").split("\n").filter(Boolean)).toEqual([
      "cli",
      "mcp",
      "openapi",
      "graphql",
      "http",
    ]);
  });

  it("uses configured Caplet IDs in local completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-cli-completion-"));
    const configPath = join(dir, "config.json");
    const out: string[] = [];
    try {
      writeInspectionConfig(configPath);
      await runCli(["__complete", "--shell", "bash", "--", "get-caplet", ""], {
        env: { CAPLETS_CONFIG: configPath },
        writeOut: (value) => out.push(value),
      });

      expect(out.join("").split("\n").filter(Boolean)).toEqual(["catalog", "filesystem", "users"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run focused tests to verify red**

Run:

```sh
pnpm --filter @caplets/core test -- test/cli.test.ts
```

Expected: FAIL because `completion` and `__complete` commands are not registered.

- [ ] **Step 3: Import completion helpers**

Modify the imports near the top of `packages/core/src/cli.ts`:

```ts
import {
  completeCliWords,
  completionScript,
  completionShells,
  type CompletionShell,
} from "./cli/completion";
```

- [ ] **Step 4: Register `completion` and `__complete` commands**

Add these commands in `createProgram()` after the base `program` configuration and before `serve`:

```ts
program
  .command("completion")
  .description("Print a shell completion script.")
  .argument("<shell>", "completion shell: bash, zsh, or fish")
  .action((shell: string) => {
    if (!completionShells.includes(shell as CompletionShell)) {
      throw new CapletsError("REQUEST_INVALID", "completion shell must be bash, zsh, or fish");
    }
    writeOut(completionScript(shell as CompletionShell));
  });

program
  .command("__complete")
  .description("Internal shell completion endpoint.")
  .hideHelp()
  .option("--shell <shell>", "completion shell")
  .allowUnknownOption(true)
  .argument("[words...]", "words to complete")
  .action(async (words: string[], options: { shell?: string }) => {
    const shell = completionShells.includes(options.shell as CompletionShell)
      ? (options.shell as CompletionShell)
      : "bash";
    const remote = remoteClientForCli(io);
    const suggestions = remote
      ? ((await remote.request("complete_cli", { shell, words })) as string[])
      : completeCliWords(words, { configPath: currentConfigPath() });
    if (suggestions.length > 0) writeOut(`${suggestions.join("\n")}\n`);
  });
```

- [ ] **Step 5: Run focused tests to verify green**

Run:

```sh
pnpm --filter @caplets/core test -- test/cli.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit CLI wiring**

```sh
git add packages/core/src/cli.ts packages/core/test/cli.test.ts
git commit -m "feat(cli): expose shell completion commands"
```

---

### Task 3: Add structured remote completion support

**Files:**

- Modify: `packages/core/src/remote-control/types.ts`
- Modify: `packages/core/src/remote-control/dispatch.ts`
- Test: `packages/core/test/remote-control-dispatch.test.ts`
- Test: `packages/core/test/cli-remote.test.ts`

- [ ] **Step 1: Write failing remote dispatch test**

Add to `packages/core/test/remote-control-dispatch.test.ts`:

```ts
it("dispatches complete_cli using server-owned config", async () => {
  const context = testContext();
  writeFileSync(
    context.configPath,
    JSON.stringify({
      mcpServers: {
        github: { name: "GitHub", description: "GitHub", command: "node" },
      },
      httpApis: {
        users: {
          name: "Users",
          description: "Users",
          baseUrl: "https://api.example.com",
          actions: {},
        },
      },
    }),
  );

  const response = await dispatchRemoteCliRequest(
    { command: "complete_cli", arguments: { shell: "bash", words: ["get-caplet", ""] } },
    context,
  );

  expect(response).toEqual({ ok: true, result: ["github", "users"] });
});
```

- [ ] **Step 2: Write failing remote CLI routing test**

Add to `packages/core/test/cli-remote.test.ts` inside `describe("remote CLI routing", ...)`:

```ts
it("routes hidden completion through remote control in remote mode", async () => {
  const requests: unknown[] = [];
  const out: string[] = [];
  const fetch = vi.fn(async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")));
    return Response.json({ ok: true, result: ["github", "linear"] });
  });

  await runCli(["__complete", "--shell", "bash", "--", "get-caplet", ""], {
    env: {
      CAPLETS_MODE: "remote",
      CAPLETS_SERVER_URL: "http://127.0.0.1:5387/caplets",
    },
    fetch,
    writeOut: (value) => out.push(value),
  });

  expect(requests).toEqual([
    { command: "complete_cli", arguments: { shell: "bash", words: ["get-caplet", ""] } },
  ]);
  expect(out.join("")).toBe("github\nlinear\n");
});
```

- [ ] **Step 3: Run focused tests to verify red**

Run:

```sh
pnpm --filter @caplets/core test -- test/remote-control-dispatch.test.ts test/cli-remote.test.ts
```

Expected: FAIL because `complete_cli` is not a valid remote command.

- [ ] **Step 4: Add remote command type**

Modify `packages/core/src/remote-control/types.ts` by adding `"complete_cli"` to `RemoteCliCommand` after `"install"`:

```ts
  | "complete_cli"
```

- [ ] **Step 5: Dispatch remote completion**

Modify `packages/core/src/remote-control/dispatch.ts` imports:

```ts
import { completeCliWords, completionShells, type CompletionShell } from "./../cli/completion";
```

Add this branch after the `install` branch and before auth branches:

```ts
if (request.command === "complete_cli") {
  const shell = optionalString(request.arguments, "shell") ?? "bash";
  if (!completionShells.includes(shell as CompletionShell)) return [];
  return completeCliWords(optionalStringArray(request.arguments, "words") ?? [""], {
    configPath: context.configPath,
    projectConfigPath: context.projectConfigPath,
  });
}
```

- [ ] **Step 6: Run focused tests to verify green**

Run:

```sh
pnpm --filter @caplets/core test -- test/remote-control-dispatch.test.ts test/cli-remote.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit remote support**

```sh
git add packages/core/src/remote-control/types.ts packages/core/src/remote-control/dispatch.ts packages/core/test/remote-control-dispatch.test.ts packages/core/test/cli-remote.test.ts
git commit -m "feat(cli): route completions through remote control"
```

---

### Task 4: Document npm package installation flow

**Files:**

- Modify: `README.md`
- Modify: `packages/cli/README.md`
- Create: `.changeset/cli-completions.md`

- [ ] **Step 1: Update README completion docs**

Add this section after the direct CLI operation examples in `README.md`:

````md
### Shell completions

The npm package ships shell completion generators for Bash, Zsh, and Fish. Installation is explicit: `npm install -g caplets` does not modify shell startup files or system completion directories.

```sh
# Bash
mkdir -p ~/.local/share/bash-completion/completions
caplets completion bash > ~/.local/share/bash-completion/completions/caplets

# Zsh
mkdir -p ~/.zsh/completions
caplets completion zsh > ~/.zsh/completions/_caplets

# Fish
mkdir -p ~/.config/fish/completions
caplets completion fish > ~/.config/fish/completions/caplets.fish
```
````

Completions include command names, options, common enum values, and configured Caplet IDs. They do not probe downstream MCP servers, HTTP APIs, GraphQL endpoints, OpenAPI specs, or configured CLI tools during tab completion.

- [ ] **Step 2: Ensure package README mirrors root README**

Because `packages/cli` copies the root README in `prepack`, either let the root README flow through unchanged or add the same section to `packages/cli/README.md` if the file is currently committed separately.

- [ ] **Step 3: Add changeset**

Create `.changeset/cli-completions.md`:

```md
---
"caplets": minor
"@caplets/core": minor
---

Add Bash, Zsh, and Fish shell completion generation plus config-aware completion suggestions for the Caplets CLI.
```

- [ ] **Step 4: Run docs-sensitive checks**

Run:

```sh
pnpm format:check
pnpm --filter caplets test
```

Expected: both commands pass.

- [ ] **Step 5: Commit docs and changeset**

```sh
git add README.md packages/cli/README.md .changeset/cli-completions.md
git commit -m "docs(cli): document shell completions"
```

---

### Task 5: Full verification and final cleanup

**Files:**

- Verify all changed files.

- [ ] **Step 1: Run full repository verification**

Run:

```sh
pnpm verify
```

Expected: format, lint, typecheck, schema check, tests, benchmark check, and build all pass.

- [ ] **Step 2: Inspect final diff**

Run:

```sh
git status --short
git diff --stat
```

Expected: only intended completion, docs, tests, and changeset files are modified.

- [ ] **Step 3: Commit any verification fixes**

If verification required fixes, commit them:

```sh
git add <fixed-files>
git commit -m "fix(cli): polish shell completions"
```

- [ ] **Step 4: Push branch**

Run:

```sh
git push -u origin feat/cli-completions
```

Expected: branch pushes successfully.

---

## Self-review checklist

- Spec coverage: covers public completion generation, hidden resolver, static suggestions, config-aware suggestions, remote mode, docs, and changeset.
- Placeholder scan: no `TBD` or open implementation decisions remain.
- Type consistency: plan uses `CompletionShell`, `completeCliWords`, `completionScript`, and `complete_cli` consistently across core CLI and remote control.
- Risk check: plan explicitly avoids npm postinstall side effects and live downstream probing during completion.
