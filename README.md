<div align="center">
  <img src="docs/assets/caplets-icon.png" alt="Caplets logo" width="120" height="120" />

  <h1>Caplets</h1>

  <p>
    <strong>Give your agent capabilities, not giant tool walls.</strong><br />
    Caplets wraps MCP servers, APIs, and commands behind focused capability cards.
  </p>

  <p>
    <a href="https://www.npmjs.com/package/caplets"><img alt="npm" src="https://img.shields.io/npm/v/caplets?style=flat-square&color=E0582F" /></a>
    <a href="https://github.com/spiritledsoftware/caplets/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/spiritledsoftware/caplets/ci.yml?branch=main&style=flat-square&label=ci&color=E0582F" /></a>
    <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-F6E8C8?style=flat-square&labelColor=1F2018" /></a>
  </p>

  <p>
    <a href="https://caplets.dev"><strong>caplets.dev</strong></a>
    ·
    <a href="https://docs.caplets.dev"><strong>docs.caplets.dev</strong></a>
    ·
    <a href="https://catalog.caplets.dev"><strong>catalog.caplets.dev</strong></a>
  </p>
</div>

---

Caplets gives coding agents a Code Mode surface for MCP servers, APIs, and commands. Instead
of exposing every downstream operation as a giant tool list, each backend becomes a typed
`caplets.<id>` handle the agent can inspect, search, call, filter, join, and summarize inside
one compact workflow.

Progressive discovery is still available when you want visible wrapper tools, but Code Mode is
the default exposure for configured backends.

Caplets can wrap:

- MCP servers
- OpenAPI, GraphQL, and simple HTTP APIs
- Curated repository CLI commands
- Shared Caplet files from this repo's `caplets/` catalog

## Quick Start

Full setup and configuration docs are available at [docs.caplets.dev](https://docs.caplets.dev/).

Install the CLI and wire it into your agent:

```sh
npm install -g caplets
caplets setup
```

Install a no-auth example Caplet and try it from your agent:

```sh
caplets install spiritledsoftware/caplets osv
```

Installs write a lockfile. Run `caplets install` with no source argument to restore the
selected project or global lockfile, and run `caplets update` to refresh tracked Caplets:

```sh
caplets install
caplets update osv
```

`caplets setup` is the recommended local path. It creates or reuses your Caplets config,
starts the local Caplets daemon, and configures the agent as a thin client that runs
`caplets attach <local-daemon-url>`. The daemon owns backend execution, environment,
Vault values, reloads, and health while the agent config stays stable and secret-free.

Manual daemon-backed MCP config looks like this:

```json
{
  "mcpServers": {
    "caplets": {
      "command": "caplets",
      "args": ["attach", "<local-daemon-url>"]
    }
  }
}
```

You can put HTTP serve defaults in your user Caplets config when you run a foreground
HTTP server or want daemon restarts to reuse a non-default port, path, upstream, or public
origin. These defaults live under top-level `serve`, are ignored from project config for
security, and lose to command flags and environment variables:

```json
{
  "serve": {
    "host": "127.0.0.1",
    "port": 5387,
    "publicOrigins": ["https://caplets.example.com"]
  }
}
```

`serve.publicOrigins` are full origins used for public request identity, not host-only
allowlists. `caplets setup` still prepares a credential-free loopback daemon before
mutating agent config, even if your user `serve` defaults describe a broader HTTP runtime.

## Use Caplets

Add your own capability sources:

```sh
caplets add mcp docs --command npx --arg -y --arg @upstash/context7-mcp
caplets add openapi users --spec ./openapi.json --base-url https://api.example.com
caplets add graphql catalog --endpoint-url https://api.example.com/graphql --schema ./schema.graphql
caplets add http status-api --base-url https://api.example.com --action get_status:GET:/status/{service}
caplets add cli repo-tools --repo . --include git,gh,package
```

Inspect and call them from the CLI:

```sh
caplets list
caplets inspect osv
caplets search-tools osv vulnerability
caplets get-tool osv query_package_version
caplets call-tool osv query_package_version --args '{"name":"react","ecosystem":"npm","version":"18.2.0"}'
```

MCP-backed Caplets also support resources, resource templates, prompts, and argument
completion. Direct CLI commands print Markdown by default; pass `--format json` for
machine-readable output. In agent sessions, Code Mode keeps the same operations behind typed
handles so discovery, execution, filtering, and synthesis can happen in one call.

## Agent Surfaces

Caplets' default local agent setup is daemon-first. `caplets setup` initializes user
configuration, installs or starts the local Caplets daemon, checks health, and then
configures the selected agent as a thin attach/native client. This avoids relying on
each MCP client to inherit the same shell environment as your terminal; backend
execution happens in the Caplets daemon instead.

| Agent                                     | Recommended local setup                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Codex, Claude Code, and other MCP clients | `caplets setup` or `caplets setup mcp-client --client codex` for an explicit add-mcp client target                          |
| OpenCode                                  | `caplets setup opencode` or [`@caplets/opencode`](https://github.com/spiritledsoftware/caplets/tree/main/packages/opencode) |
| Pi                                        | `caplets setup pi` or [`@caplets/pi`](https://github.com/spiritledsoftware/caplets/tree/main/packages/pi)                   |

For MCP clients, setup uses the `add-mcp` client catalog under the hood and writes a
Caplets server command shaped like this:

```toml
[mcp_servers.caplets]
command = "caplets"
args = ["attach", "<local-daemon-url>"]
```

```json
{
  "mcpServers": {
    "caplets": {
      "command": "caplets",
      "args": ["attach", "<local-daemon-url>"]
    }
  }
}
```

For a remote or Cloud-backed MCP server, keep the same thin-client shape and point
`caplets attach` at the remote URL after Remote Login:

```toml
[mcp_servers.caplets]
command = "caplets"
args = ["attach", "https://caplets.example.com/caplets"]
```

```json
{
  "mcpServers": {
    "caplets": {
      "command": "caplets",
      "args": ["attach", "https://caplets.example.com/caplets"]
    }
  }
}
```

`caplets attach <url>` is always the stdio client command for MCP configs. As an
advanced manual fallback, you can still run a foreground HTTP runtime yourself, for
example to compose local/project Caplets with an upstream host:

```sh
caplets serve --transport http --upstream-url https://caplets.example.com/caplets
```

Then point agents at that local runtime with `caplets attach <local-runtime-url>`.

Native integrations expose `caplets__code_mode` for multi-step TypeScript workflows over
generated `caplets.<id>` handles. Progressive exposure adds `caplets__<id>` tools; direct
exposure adds operation-level tools such as `caplets__<id>__<operation>`. `caplets setup`
writes non-secret daemon defaults for OpenCode and Pi; explicit plugin settings still win.

Remote mode uses Remote Login for both self-hosted Caplets and Caplets Cloud. Trust the
host once, then launch attach or a native integration with only non-secret selectors:

```sh
caplets remote login https://caplets.example.com/caplets
caplets attach https://caplets.example.com/caplets

caplets remote login https://cloud.caplets.dev
CAPLETS_MODE=cloud CAPLETS_REMOTE_URL=https://cloud.caplets.dev opencode
```

## Caplets Vault

Caplets Vault stores secret-like string values in the runtime that uses them, encrypted at rest for
local/global Caplets and owned by the selected remote runtime for `--remote` operations. Reference
Vault values in config with `$vault:NAME` or `${vault:NAME}`.

```sh
caplets vault set GH_TOKEN --grant github
caplets vault get GH_TOKEN
caplets vault get GH_TOKEN --show
```

Use `--remote` when the Caplet runs in a self-hosted remote or hosted Cloud runtime:

```sh
caplets vault set GH_TOKEN --remote --grant github
caplets vault access grant GH_TOKEN github --remote
```

Vault values are not exposed through Code Mode, progressive tools, or native agent APIs. Unset or
ungranted Vault references quarantine only the affected Caplet and appear in `caplets doctor`.

## Anonymous Telemetry

Caplets collects opt-out anonymous telemetry for product usage and reliability. The first eligible
interactive CLI run writes a notice to stderr only, including both disable controls:

```sh
CAPLETS_DISABLE_TELEMETRY=1 caplets serve
caplets telemetry disable
```

Use `caplets telemetry status`, `enable`, `disable`, `rotate-id`, `delete-id`, and `debug` to
inspect or control local telemetry. Caplets never collects raw config, prompts, Code Mode code, tool
arguments, tool outputs, logs, file paths, URLs, hostnames, Caplet IDs, credentials, tokens, raw
environment variables, raw error messages, or unsanitized stack traces. Rotating or deleting the
local anonymous ID does not delete provider-side historical anonymous events; provider retention
controls historical data.

## Available Update Detection

Caplets can passively check public npm metadata for the published `caplets` CLI package and print a
short stderr-only notice when a newer eligible version is already cached. The notice preserves stdout
for MCP stdio, JSON output, shell completion, help, and version commands.

Set `CAPLETS_DISABLE_UPDATE_CHECK=1` to disable both passive notices and outbound update metadata
lookups. This control is independent from anonymous telemetry controls.

Default stdio `caplets serve` and `caplets attach` sessions stay quiet. Set
`CAPLETS_UPDATE_NOTICE_STDERR=1` only for a foreground host where stderr is visible to the user and
separate from protocol stdout.

## Benchmark

The deterministic benchmark compares flat MCP exposure with Caplets over the same mock
servers:

| Initial surface         |    Direct MCP |      Caplets |     Reduction |
| ----------------------- | ------------: | -----------: | ------------: |
| Visible tools           |           215 |            7 |   96.7% fewer |
| Serialized payload      |  63,250 bytes | 12,720 bytes | 79.9% smaller |
| Approx. context surface | 15,813 tokens | 3,180 tokens |  12,633 fewer |

The landing-page live Pi eval reports Caplets Code Mode passing the same 10/10 real-world
large MCP tasks as direct MCP and Executor.sh while using 72.0% fewer request + output
tokens than direct vanilla MCP. Live runs are model- and environment-dependent; the
deterministic benchmark is the reproducible claim.

See [docs/benchmarks/coding-agent.md](https://github.com/spiritledsoftware/caplets/blob/main/docs/benchmarks/coding-agent.md) for methodology and reproduction commands.
See [GitHub Releases](https://github.com/spiritledsoftware/caplets/releases) for public release notes.

## Repository

This monorepo uses pnpm. Published packages support Node.js `>=22`; CI verifies
that support floor and the current Node.js LTS, while owned runtime images use current LTS.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

Useful focused checks:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm benchmark:check
pnpm build
```

Package map:

- `packages/core` - runtime, config, Code Mode, backends, MCP server, remote attach
- `packages/cli` - published `caplets` binary
- `packages/opencode` - native OpenCode plugin
- `packages/pi` - native Pi extension
- `packages/benchmarks` - deterministic and opt-in live benchmarks
- `apps/landing` - public site at `caplets.dev`
- `apps/docs` - public docs site at `docs.caplets.dev`

Long-lived docs:

- [Available Update Detection](https://github.com/spiritledsoftware/caplets/blob/main/docs/product/available-update-detection.md)
- [Code Mode PRD](https://github.com/spiritledsoftware/caplets/blob/main/docs/product/caplets-code-mode-prd.md)
- [Caplets Vault](https://github.com/spiritledsoftware/caplets/blob/main/docs/product/caplets-vault.md)
- [Architecture](https://github.com/spiritledsoftware/caplets/blob/main/docs/architecture.md)
- [ADR 0001: Code Mode default exposure](https://github.com/spiritledsoftware/caplets/blob/main/docs/adr/0001-code-mode-default-exposure.md)
- [Benchmark methodology](https://github.com/spiritledsoftware/caplets/blob/main/docs/benchmarks/coding-agent.md)
- [Native integrations](https://github.com/spiritledsoftware/caplets/blob/main/docs/native-integrations.md)
- [Project Binding](https://github.com/spiritledsoftware/caplets/blob/main/docs/project-binding.md)

## License

MIT
