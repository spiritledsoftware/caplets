# Caplets

Caplets is a progressive-disclosure gateway for Model Context Protocol (MCP) servers.

Instead of connecting an MCP client to many downstream servers and exposing every tool up
front, Caplets exposes one top-level tool per configured server. An agent first chooses a
capability domain, then asks Caplets to list, search, inspect, or call that server's
underlying tools.

This keeps the initial MCP tool list small, makes tool selection easier, and avoids
flattened tool-name collisions across servers.

## Inspiration

Caplets is a mashup of two ideas that work well separately but leave a gap together:
agent skills and MCP servers.

Agent skills are great at progressive disclosure. They show an agent a compact capability
card first, then let it read deeper instructions only when that skill is relevant. MCP
servers are great at live tool execution, but most clients expose their tools as one flat
list up front. That means a powerful MCP setup can flood the agent with every tool from
every server before it knows which capability area matters.

Caplets borrows the skill-shaped discovery model and applies it to MCP. Each downstream
server becomes a skill-like capability card first; its actual MCP tools stay hidden until
the agent chooses that server and asks to search, list, inspect, or call them.

## What It Does

- Reads downstream MCP server definitions from `~/.caplets/config.json`.
- Registers one generated MCP tool for each enabled server.
- Uses the configured server ID as the generated tool name.
- Uses the configured `name` and `description` as the capability card shown to agents.
- Starts downstream servers lazily when an operation needs them.
- Supports stdio, Streamable HTTP, and legacy HTTP+SSE downstream servers.
- Lets agents `list_tools`, `search_tools`, `get_tool`, and `call_tool` within one selected server namespace.
- Preserves downstream tool results instead of rewriting them into a custom format.
- Redacts secrets from structured errors.
- Supports static remote auth and OAuth token storage for remote servers.

## Install

Caplets requires Node.js 22 or newer.

```sh
pnpm add -g caplets
```

For local development from this repository:

```sh
pnpm install
pnpm build
```

## Configure

Create a starter `~/.caplets/config.json`:

```sh
caplets init
```

The generated config includes a disabled example server. Replace it with the MCP servers
you want Caplets to expose:

```json
{
  "$schema": "https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplets-config.schema.json",
  "version": 1,
  "defaultSearchLimit": 20,
  "maxSearchLimit": 50,
  "mcpServers": {
    "filesystem": {
      "name": "Project Files",
      "description": "Read, search, and edit local project files.",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/you/code"],
      "cwd": "/home/you/code",
      "startupTimeoutMs": 10000,
      "callTimeoutMs": 60000,
      "toolCacheTtlMs": 30000
    },
    "docs": {
      "name": "Hosted Docs",
      "description": "Search hosted product and API documentation.",
      "transport": "http",
      "url": "https://mcp.example.com/mcp",
      "auth": {
        "type": "bearer",
        "token": "$env:DOCS_MCP_TOKEN"
      }
    }
  }
}
```

The default config path can be overridden with `CAPLETS_CONFIG`:

```sh
CAPLETS_CONFIG=/path/to/config.json caplets init
CAPLETS_CONFIG=/path/to/config.json caplets serve
```

Caplets validates this file at startup. Config changes take effect after restarting the
Caplets MCP server.

The optional `$schema` field points editors at the generated JSON Schema in
[`schemas/caplets-config.schema.json`](schemas/caplets-config.schema.json). CI verifies that
the committed schema stays in sync with the Zod config validator.

`caplets init` refuses to overwrite an existing config. To intentionally replace the file:

```sh
caplets init --force
```

### Server IDs

Each key under `mcpServers` is the stable server ID. It becomes the generated MCP tool
name exactly, so keep it short and specific:

```json
{
  "mcpServers": {
    "linear": {
      "name": "Linear",
      "description": "Read and update Linear issues and projects.",
      "command": "npx",
      "args": ["-y", "linear-mcp-server"]
    }
  }
}
```

Server IDs must match `^[a-zA-Z0-9_-]{1,64}$`. Spaces, dots, slashes, colons, and
Unicode IDs are rejected.

### Stdio Servers

Use `command` for a local stdio MCP server. `args`, `env`, and `cwd` are optional.

```json
{
  "name": "Local Tools",
  "description": "Run local development tools through stdio.",
  "command": "node",
  "args": ["./server.mjs"],
  "env": {
    "API_TOKEN": "${API_TOKEN}"
  },
  "cwd": "/home/you/project"
}
```

### Remote Servers

Use `transport` and `url` for remote MCP servers.

```json
{
  "name": "Remote Docs",
  "description": "Search documentation from a remote MCP server.",
  "transport": "http",
  "url": "https://mcp.example.com/mcp",
  "auth": {
    "type": "headers",
    "headers": {
      "x-api-key": "$env:REMOTE_DOCS_API_KEY"
    }
  }
}
```

`transport` can be `http` for MCP Streamable HTTP or `sse` for legacy HTTP+SSE. Remote
URLs must use `https://`, except loopback development URLs such as `http://localhost`.

### Authentication

Remote servers can use:

- `{"type": "none"}`
- `{"type": "bearer", "token": "$env:TOKEN"}`
- `{"type": "headers", "headers": {"x-api-key": "$env:API_KEY"}}`
- `{"type": "oauth2", ...}`

For OAuth-backed remote servers, authenticate once with:

```sh
caplets auth login <server>
```

For headless terminals:

```sh
caplets auth login <server> --no-open
```

OAuth tokens are stored under `~/.caplets/auth/<server>.json` with owner-only file
permissions where the platform supports them. When an OAuth token expires, run
`caplets auth login <server>` again.

To inspect or remove stored OAuth credentials:

```sh
caplets auth list
caplets auth logout <server>
```

### Optional Server Settings

Every server can set:

- `startupTimeoutMs`: timeout for starting or checking the downstream server. Defaults to `10000`.
- `callTimeoutMs`: timeout for downstream tool calls. Defaults to `60000`.
- `toolCacheTtlMs`: how long downstream tool metadata stays fresh. Defaults to `30000`; `0` refreshes every time.
- `disabled`: omit the server from Caplets discovery. Defaults to `false`.

## Add Caplets To An MCP Client

Configure your MCP client to run Caplets as a stdio server:

```json
{
  "mcpServers": {
    "caplets": {
      "command": "caplets",
      "args": ["serve"]
    }
  }
}
```

If your client starts the configured command directly, `caplets` without arguments also
starts the MCP server. `serve` is explicit and recommended for clarity.

## How Agents Use It

Caplets initially exposes one MCP tool per enabled server. If the config has `filesystem`
and `docs`, the client sees two top-level tools: `filesystem` and `docs`.

Each generated server tool accepts an `operation`:

```json
{
  "operation": "list_tools"
}
```

Search within a selected server:

```json
{
  "operation": "search_tools",
  "query": "read file",
  "limit": 10
}
```

Inspect one exact downstream tool:

```json
{
  "operation": "get_tool",
  "tool": "read_file"
}
```

Call one exact downstream tool:

```json
{
  "operation": "call_tool",
  "tool": "read_file",
  "arguments": {
    "path": "/home/you/code/project/README.md"
  }
}
```

Available operations:

- `get_server`: return the configured capability card without starting the downstream server.
- `check_server`: start or connect to the downstream server and verify its tool list.
- `list_tools`: return compact downstream tool metadata.
- `search_tools`: search downstream tool names and descriptions within this server.
- `get_tool`: return full metadata for one exact downstream tool.
- `call_tool`: invoke one exact downstream tool with JSON object arguments.

Requests are strict: operation-specific extra fields are rejected, and `call_tool` requires
`arguments` to be a JSON object.

## Development

```sh
pnpm install
pnpm dev
```

Useful commands:

```sh
pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm schema:generate
pnpm schema:check
pnpm verify
```

`pnpm dev` rebuilds on source changes and restarts the local stdio MCP server from
`dist/index.js`. Use it for local development, not as the command configured in an MCP
client, because build logs are written to stdout.

## Product Notes

The product requirements document lives at
[`docs/product/caplets-progressive-mcp-disclosure-prd.md`](docs/product/caplets-progressive-mcp-disclosure-prd.md).
It describes the progressive MCP disclosure model, configuration rules, MVP tool surface,
security expectations, and non-goals.

Caplets intentionally does not provide a hosted service, GUI, cross-server flattened tool
search, automatic MCP client config import, or namespaced flattened tool IDs such as
`server.tool`.

Progressive disclosure is context management, not a security boundary. Caplets reduces the
tool surface shown to the agent up front, but downstream MCP servers remain responsible for
their own tool behavior and any client-side confirmations.

## Release Flow

User-facing changes should include a changeset:

```sh
pnpm changeset
```

Merging changesets to `main` lets the release workflow open a version PR. Merging that
version PR publishes the package to npm through trusted publishing.

## License

MIT
