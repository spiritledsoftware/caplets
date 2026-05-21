# Completion Discovery Refactor Design

## Status

Planned design for follow-up implementation on `feat/cli-completions`.

## Goal

Make Caplets CLI completions architecturally correct and more useful by replacing duplicated command lists with shared command metadata, adding persistent discovery caching, and completing qualified downstream targets such as `caplets call-tool <server>.<tool>`.

## User intent

The completion feature should not be a thin static helper that drifts from the real CLI. It should feel intelligent:

- Top-level command completions must stay in sync with the Commander CLI.
- Qualified targets should complete backend IDs and known downstream names.
- Live downstream discovery is acceptable during completion when bounded by caching, timeouts, and quiet failure.
- Remote mode must continue using structured `/control` requests and server-owned state.

## Non-goals

- Do not execute arbitrary raw CLI strings over remote control.
- Do not add shell profile mutation, `postinstall`, or automatic shell startup edits.
- Do not cache secrets, auth headers, token values, env values, prompt arguments, resource contents, or downstream response payloads.
- Do not start browser/device login flows during completion.
- Do not print diagnostics during normal generated shell completion scripts. Generated scripts suppress stderr; explicit/debug invocations may expose hints later.

## Shared CLI command metadata

Add a shared metadata module for command names and static completion behavior. This module becomes the source of truth for completion-visible commands and subcommands.

Expected metadata shape:

```ts
export const cliCommandNames = [
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
] as const;
```

`completion.ts` must consume this metadata instead of owning a hand-maintained `topLevelCommands` copy. The existing test that compares `createProgram().commands` to top-level completion output remains as a regression guard.

## Completion configuration

Add a top-level `completion` config section:

```json
{
  "completion": {
    "discoveryTimeoutMs": 750,
    "overallTimeoutMs": 1500,
    "cacheTtlMs": 300000,
    "negativeCacheTtlMs": 30000
  }
}
```

Defaults:

- `discoveryTimeoutMs`: `750`
- `overallTimeoutMs`: `1500`
- `cacheTtlMs`: `300000` (5 minutes)
- `negativeCacheTtlMs`: `30000` (30 seconds)

Normal config precedence applies: user config plus project config merge through the existing config loader. Invalid values fail normal config validation. Completion runtime still returns no suggestions if config loading itself fails.

## Platform-native cache location

Store completion discovery cache under the platform cache directory, not config or state:

- Linux/Unix: `${XDG_CACHE_HOME}/caplets/completions` when `XDG_CACHE_HOME` is absolute, otherwise `~/.cache/caplets/completions`.
- macOS: `~/Library/Caches/caplets/completions`.
- Windows: `%LOCALAPPDATA%\caplets\cache\completions` when `LOCALAPPDATA` is absolute, otherwise `%USERPROFILE%\AppData\Local\caplets\cache\completions`.

This should be implemented alongside existing path helpers in `packages/core/src/config/paths.ts`.

## Cache contents and safety boundary

Cache only public, secret-free discovery metadata needed for completions:

- backend ID
- backend type
- kind: `tools`, `prompts`, `resources`, `resourceTemplates`
- candidate value: tool name, prompt name, resource URI, or resource template URI template
- optional public title/name/description if already returned by discovery and needed later
- `fetchedAt`, `expiresAt`, and config fingerprint
- negative-cache entries for auth-required, timeout, unavailable, or unsupported capability failures

Never cache:

- input arguments
- prompt argument values
- auth headers, bearer tokens, OAuth tokens, client secrets
- environment variable values
- command outputs
- resource contents
- arbitrary downstream response payloads

## Cache invalidation

Key cache entries by a stable secret-free completion fingerprint derived from:

- backend ID
- backend type
- discovery kind
- discovery-relevant backend config fields
- completion settings that affect discovery/cache behavior

Use secret-redacted fields only. Examples:

- MCP: transport, command, args, cwd, URL, startup timeout; do not include env values or auth secrets.
- OpenAPI: spec path/spec URL/base URL and configured auth type; do not include token/header values.
- GraphQL: endpoint URL, schema source, configured operation names; do not include auth values.
- HTTP: base URL and action names/paths/methods; do not include auth/header secrets.
- CLI: action names and command/args/cwd shape; do not include env values.
- Caplet sets: source path/repo/ref and nested config fingerprint when available.

If the fingerprint changes, old entries are misses. Prune expired and mismatched entries opportunistically.

## Discovery behavior

Completion uses stale-while-refresh semantics without detached background workers:

1. Fresh cache entry: return cached suggestions immediately.
2. Stale cache entry: attempt refresh within the overall budget; return fresh suggestions if refresh succeeds, otherwise return stale suggestions.
3. Missing cache entry: attempt live discovery within the budget; return discovered suggestions if it succeeds, otherwise return static/config fallback.
4. Negative-cache entry: do not retry until `negativeCacheTtlMs` expires; return static/config fallback or stale positive data if available.

All discovery failures are quiet for shell-facing completion. Generated shell scripts redirect stderr to null. A future explicit debug command may surface auth hints.

Completion may start normal MCP stdio processes because MCP discovery requires it, but it must not initiate interactive login, open a browser, prompt for credentials, or write auth state. Auth-required failures should become negative-cache entries and should not clear still-valid positive cache data.

## Qualified target completion contract

### Tools

For `call-tool` and `get-tool`:

- `caplets call-tool <TAB>` suggests enabled backend IDs with a trailing dot: `github.`, `repo.`.
- `caplets call-tool repo.<TAB>` suggests `repo.status`, `repo.build`, etc.
- `caplets call-tool gh.se<TAB>` filters by the full typed prefix.
- CLI and HTTP backends can provide config-defined action names without live probing.
- OpenAPI, GraphQL, MCP, and Caplet-set backends may use live discovery through the cache manager.
- Failures/timeouts degrade to `server.` suggestions or no extra target names.

### Prompts

For `get-prompt`:

- `caplets get-prompt <TAB>` suggests MCP backend IDs with trailing dots when prompts are possible.
- `caplets get-prompt docs.<TAB>` discovers/caches MCP prompt names and suggests `docs.promptName`.
- Non-MCP backends should not suggest prompt names.

### Resources and resource templates

For `read-resource`:

- The first positional argument remains the Caplet/backend ID and should complete enabled MCP backend IDs.
- The second positional argument should complete known/discovered resource URIs for the selected MCP backend.

For `complete`:

- The first positional argument completes enabled MCP backend IDs.
- When completing `--prompt`, suggest known/discovered prompt names for the selected backend.
- When completing `--resource-template`, suggest known/discovered resource template URI templates for the selected backend.
- Existing enum/static option completions continue to work.

## Remote mode

Remote mode keeps all Caplets state on the server. The local CLI must continue to call `/control` with `command: "complete_cli"`; it must not discover downstream backends locally when remote mode is active.

The remote Caplets server owns:

- config
- auth store
- downstream managers
- persistent completion cache
- live discovery and negative-cache decisions

Remote control responses return completion candidates only. They must not return secrets, cache internals, auth tokens, or raw downstream errors.

## Error handling

- `caplets completion <unknown-shell>` remains a normal `REQUEST_INVALID` error.
- `caplets __complete ...` remains best-effort and returns no candidates on malformed input, config load failure, cache failure, remote failure, downstream timeout, or unsupported context.
- Auth-required discovery returns stale cached results if present; otherwise static/config fallback.
- Normal generated shell completion suppresses stderr. If explicit/debug completion output is added later, auth-required diagnostics may recommend `caplets auth login <server>`.

## Documentation and release notes

Update README/package README to describe:

- completion scripts remain explicit install only
- completions may use cached live discovery
- discovery is bounded by configurable timeouts/TTLs
- cache location follows platform conventions
- auth-required backends may need `caplets auth login <server>` for richer completions

Update the existing completion changeset to mention command metadata, persistent cache, and downstream qualified target completions.

## Acceptance criteria

- Static top-level completion suggestions come from shared command metadata, not a private duplicate list in `completion.ts`.
- A test fails if registered Commander commands drift from completion-visible command metadata.
- `completion` config defaults parse and appear in generated schema.
- Cache path helpers return XDG/macOS/Windows-appropriate cache directories.
- Completion cache stores only secret-free candidate metadata and negative-cache state.
- `call-tool` / `get-tool` complete backend IDs and tool names using config plus cache-backed live discovery.
- `get-prompt` completes backend IDs and prompt names for MCP backends.
- `read-resource` completes backend IDs and resource URIs for MCP backends.
- `complete --prompt` and `complete --resource-template` complete prompt names and resource template URI templates.
- Remote completions route through `complete_cli` and use server-owned cache/discovery.
- Completion failures remain quiet under generated shell scripts.
- `pnpm verify` passes.
