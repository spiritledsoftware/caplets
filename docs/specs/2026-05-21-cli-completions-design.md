# CLI Completions for the Caplets npm Package

## Status

Planned design for implementation on `feat/cli-completions`.

## Goal

Add first-class shell completion support to the `caplets` npm CLI so users can install Bash, Zsh, or Fish completions and get useful static and config-aware suggestions without shell startup side effects.

## Non-goals

- Do not mutate `.bashrc`, `.zshrc`, Fish config, or system completion directories during `npm install`.
- Do not add a `postinstall` script.
- Do not run downstream MCP servers, OpenAPI clients, GraphQL introspection, HTTP requests, or user CLI tools during tab completion.
- Do not complete secret values, token values, OAuth callback URLs, or raw environment variable contents.
- Do not add raw remote shell command execution for remote completions.

## User-facing commands

Caplets should expose a public completion script generator:

```sh
caplets completion bash
caplets completion zsh
caplets completion fish
```

The command writes the requested shell script to stdout. Users install it using shell-native mechanisms:

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

Caplets should also expose a hidden machine-facing command used only by generated scripts:

```sh
caplets __complete --shell bash -- get-caplet ""
```

`__complete` prints newline-separated candidates to stdout and remains quiet on recoverable errors. It should be hidden from normal help output.

## Completion scope

### Static completions

Complete known command names, subcommands, options, and enum values:

- Top-level commands: `serve`, `init`, `list`, `install`, `add`, direct operation commands, `config`, `auth`, and `completion`.
- `add` subcommands: `cli`, `mcp`, `openapi`, `graphql`, `http`.
- `config` subcommands: `path`, `paths`.
- `auth` subcommands: `login`, `logout`, `list`.
- Shells for `completion`: `bash`, `zsh`, `fish`.
- Format values: `markdown`, `md`, `plain`, `json`.
- Serve transports: `stdio`, `http`.
- Remote MCP transports for `add mcp --transport`: `http`, `sse`.
- CLI generator includes for `add cli --include`: `git`, `gh`, `package`.

### Config-aware completions

Complete enabled configured Caplet IDs from the active Caplets config for commands whose next positional argument is a Caplet ID:

- `get-caplet`
- `check-backend`
- `list-tools`
- `search-tools`
- `list-resources`
- `search-resources`
- `list-resource-templates`
- `read-resource`
- `list-prompts`
- `search-prompts`
- `complete`

Complete enabled configured Caplet IDs plus a trailing dot for commands whose next positional argument is a qualified target:

- `get-tool`
- `call-tool`
- `get-prompt`

Example:

```sh
caplets call-tool git<TAB>
# suggests: github.
```

The first implementation intentionally does not complete downstream tool, prompt, or resource names because doing so would require probing downstream systems during tab completion. A future opt-in enhancement can complete cached downstream names if Caplets persists a safe metadata cache.

Complete configured Caplet/server IDs for auth commands:

- `auth login`
- `auth logout`

### Remote mode completions

When CLI remote mode is active, completions must use the command-semantic remote control API, not raw CLI string execution. Add a remote control command such as `complete_cli` that accepts the completion words and returns newline-safe suggestions from the server-owned config.

Remote completions must not expose secrets. They should return only public command names, option names, enum values, and configured Caplet IDs.

## Architecture

Add a focused completion module under `packages/core/src/cli/completion.ts`.

Responsibilities:

- Generate shell scripts for Bash, Zsh, and Fish.
- Resolve newline-separated completion suggestions for `__complete`.
- Load local config only when a command position needs config-aware suggestions.
- Accept a remote completion callback so `__complete` can delegate to `/control` in remote mode.
- Keep all completion errors quiet by returning no suggestions, except invalid explicit `caplets completion <shell>` invocations, which should fail with `REQUEST_INVALID`.

`packages/core/src/cli.ts` wires public and hidden commands into the existing Commander program. The generated shell scripts call `caplets __complete`, not Commander internals.

Remote control adds one structured command, `complete_cli`, which reuses the same resolver on the server side with server-owned config paths.

## Output contract

`__complete` output is newline-separated plain text:

```text
get-caplet
list-tools
call-tool
```

No descriptions are required in the first implementation. Shell-specific escaping belongs in the generated shell functions; suggestion values themselves should not contain newlines.

## Error handling

- `caplets completion <unknown-shell>` fails with `REQUEST_INVALID` and a clear message listing `bash`, `zsh`, and `fish`.
- `caplets __complete ...` returns no suggestions for malformed words, unreadable config, remote failures, or unsupported command contexts.
- Completion generation must not set process exit code on best-effort dynamic lookup failures.

## Documentation

Update the root README and CLI package README with:

- Supported shells.
- Install snippets for Bash, Zsh, and Fish.
- Note that npm install does not modify shell startup files.
- Note that completions are static plus config-aware and do not probe downstream services.

## Release notes

Add a changeset for the `caplets` package because this introduces a user-facing CLI command. If implementation touches exported core types, include `@caplets/core` in the same changeset.

## Acceptance criteria

- `caplets completion bash`, `zsh`, and `fish` emit shell-specific scripts that invoke `caplets __complete`.
- `caplets __complete --shell bash -- ""` suggests top-level commands.
- `caplets __complete --shell bash -- add ""` suggests add subcommands.
- `caplets __complete --shell bash -- get-caplet ""` suggests enabled Caplet IDs from local config.
- `caplets __complete --shell bash -- call-tool github` suggests `github.` when `github` is configured.
- Remote mode routes `__complete` to `/control` with a structured `complete_cli` command.
- `pnpm verify` passes.
