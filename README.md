# Caplets

Caplets is a progressive-disclosure gateway for Model Context Protocol (MCP) servers,
native OpenAPI endpoints, native GraphQL endpoints, and explicitly configured HTTP APIs.

Instead of connecting an MCP client to many downstream servers or HTTP APIs and exposing
every operation up front, Caplets exposes one top-level tool per configured capability.
An agent first chooses a capability domain, then asks Caplets to list, search, inspect,
or call that backend's underlying tools or operations.

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

- Reads downstream MCP server definitions, native OpenAPI endpoint definitions, native GraphQL endpoint definitions, and explicit HTTP API action definitions from the user config file.
- Registers one generated MCP tool for each enabled MCP server, OpenAPI endpoint, GraphQL endpoint, or HTTP API.
- Uses the configured server ID as the generated tool name.
- Uses the configured `name` and `description` as the capability card shown to agents.
- Starts downstream MCP servers and loads OpenAPI specs lazily when an operation needs them.
- Supports stdio, Streamable HTTP, and legacy HTTP+SSE downstream servers.
- Lets agents `list_tools`, `search_tools`, `get_tool`, and `call_tool` within one selected Caplet namespace.
- Converts OpenAPI operations into MCP-style tool metadata and executes HTTP calls directly.
- Converts configured GraphQL operations into MCP-style tool metadata, and can auto-generate GraphQL tools from schema root query and mutation fields.
- Converts explicitly configured HTTP actions into MCP-style tool metadata and executes HTTP calls directly.
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

Create a starter user config at `${XDG_CONFIG_HOME:-~/.config}/caplets/config.json` on Unix-like platforms or `%APPDATA%\caplets\config.json` on Windows:

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
  },
  "openapiEndpoints": {
    "users": {
      "name": "Users API",
      "description": "Manage users through the internal HTTP API.",
      "specPath": "./openapi.json",
      "baseUrl": "https://api.example.com",
      "auth": {
        "type": "bearer",
        "token": "$env:USERS_API_TOKEN"
      }
    }
  },
  "graphqlEndpoints": {
    "catalog": {
      "name": "Catalog GraphQL",
      "description": "Query and update catalog records through GraphQL.",
      "endpointUrl": "https://api.example.com/graphql",
      "introspection": true,
      "auth": {
        "type": "oidc",
        "issuer": "https://login.example.com"
      }
    }
  },
  "httpApis": {
    "status": {
      "name": "Status API",
      "description": "Read deployment status from a simple HTTP API.",
      "baseUrl": "https://api.example.com",
      "auth": { "type": "none" },
      "actions": {
        "get_status": {
          "method": "GET",
          "path": "/status/{service}",
          "description": "Fetch status for one service.",
          "inputSchema": {
            "type": "object",
            "properties": { "service": { "type": "string" } },
            "required": ["service"]
          }
        }
      }
    }
  }
}
```

The default config path is `${XDG_CONFIG_HOME:-~/.config}/caplets/config.json` on Unix-like platforms and `%APPDATA%\caplets\config.json` on Windows. It can be overridden with `CAPLETS_CONFIG`:

```sh
CAPLETS_CONFIG=/path/to/config.json caplets init
CAPLETS_CONFIG=/path/to/config.json caplets serve
```

Inspect the installed CLI version and resolved config locations:

```sh
caplets --version
caplets config path
caplets config paths
caplets config paths --json
```

Caplets validates this file at startup and hot reloads config changes while `caplets serve`
is running. Invalid edits are ignored until fixed, so the MCP server keeps serving the last
known-good config instead of dropping every tool because of a transient JSON or validation
error.

The optional `$schema` field points editors at the generated JSON Schema in
[`schemas/caplets-config.schema.json`](schemas/caplets-config.schema.json). CI verifies that
the committed schema stays in sync with the Zod config validator.

### Caplet Files

For richer skill-like cards, add Markdown Caplet files beside `config.json`. Every Caplet
file must include exactly one executable backend: `mcpServer`, `openapiEndpoint`,
`graphqlEndpoint`, or `httpApi`;
serverless Caplets are intentionally out of scope.

Top-level files derive the Caplet ID from the filename:

```md
---
$schema: https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplet.schema.json
name: GitHub
description: Interact with GitHub repositories, issues, and pull requests.
tags:
  - code
  - review
mcpServer:
  command: npx
  args: ["-y", "github-mcp-server"]
---

# GitHub

Use this Caplet for repository, issue, pull request, and code review workflows.
```

OpenAPI-backed Caplet files use `openapiEndpoint`:

```md
---
name: Users API
description: Manage users through the internal HTTP API.
openapiEndpoint:
  specPath: ./openapi.json
  baseUrl: https://api.example.com
  auth:
    type: bearer
    token: $env:USERS_API_TOKEN
---

# Users API
```

GraphQL-backed Caplet files use `graphqlEndpoint`:

```md
---
name: Catalog GraphQL
description: Query and update catalog records through GraphQL.
graphqlEndpoint:
  endpointUrl: https://api.example.com/graphql
  schemaPath: ./schema.graphql
  auth:
    type: oidc
    issuer: https://login.example.com
---

# Catalog GraphQL
```

HTTP action Caplet files use `httpApi`:

```md
---
name: Status API
description: Read deployment status from a simple HTTP API.
httpApi:
  baseUrl: https://api.example.com
  auth:
    type: none
  actions:
    get_status:
      method: GET
      path: /status/{service}
      description: Fetch status for one service.
      inputSchema:
        type: object
        properties:
          service:
            type: string
        required: [service]
---

# Status API
```

Top-level files derive their Caplet ID from the filename. Directory-style Caplets use
`linear/CAPLET.md`, which is exposed as `linear`; sibling files can be referenced with
normal Markdown links from `CAPLET.md`.

This repository includes polished working examples under [`caplets/`](caplets/):

- `github`: GitHub's official MCP server container, using `GITHUB_PERSONAL_ACCESS_TOKEN`.
- `linear`: Linear's hosted OAuth MCP endpoint.
- `context7`: Context7 documentation lookup through `@upstash/context7-mcp`.

Install every example from a repo's `caplets/` directory:

```sh
caplets install spiritledsoftware/caplets
```

Install one or more individual Caplets by ID:

```sh
caplets install spiritledsoftware/caplets github
caplets install spiritledsoftware/caplets github linear
```

`caplets install` accepts a GitHub `owner/repo` shorthand, a Git URL, or a local repository path.
It installs into your user Caplets root, which is `${XDG_CONFIG_HOME:-~/.config}/caplets` on Unix-like platforms,
`%APPDATA%\caplets` on Windows, or the parent directory of `CAPLETS_CONFIG` when that environment variable is set.
Existing Caplets are not overwritten unless `--force` is passed.

On Unix-like platforms, relative `XDG_CONFIG_HOME` and `XDG_STATE_HOME` values are ignored.

Caplets always loads user Caplet files from the user Caplets root. Project `./.caplets/config.json`
is still loaded as project config, but project Markdown Caplet files are executable
configuration and are ignored unless explicitly trusted:

```sh
CAPLETS_TRUST_PROJECT_CAPLETS=1 caplets serve
```

Later sources override earlier ones in this order: user `config.json`, user Caplet files,
project `config.json`, and, only when trusted, project Caplet files.

`caplets init` refuses to overwrite an existing config. To intentionally replace the file:

```sh
caplets init --force
```

### Caplet IDs

Each key under `mcpServers`, `openapiEndpoints`, `graphqlEndpoints`, or `httpApis` is the
stable Caplet ID. It becomes the generated MCP tool name exactly, so keep it short and specific:

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

Caplet IDs must match `^[a-zA-Z0-9_-]{1,64}$` and must be unique across `mcpServers`,
`openapiEndpoints`, `graphqlEndpoints`, and `httpApis`. Spaces, dots, slashes, colons, and Unicode IDs are rejected.

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

### OpenAPI Endpoints

Use `openapiEndpoints` for native HTTP APIs described by OpenAPI 3 specs. Each entry
points at one spec through either `specPath` or `specUrl`, and may override the request
base URL with `baseUrl`.

```json
{
  "name": "Users API",
  "description": "Manage users through the internal HTTP API.",
  "specPath": "./openapi.json",
  "baseUrl": "https://api.example.com",
  "auth": { "type": "none" }
}
```

OpenAPI auth is explicit and supports:

- `{"type": "none"}`
- `{"type": "bearer", "token": "$env:TOKEN"}`
- `{"type": "headers", "headers": {"x-api-key": "$env:API_KEY"}}`
- `{"type": "oauth2", ...}`
- `{"type": "oidc", ...}`

OpenAPI `call_tool.arguments` uses grouped HTTP inputs:

```json
{
  "operation": "call_tool",
  "tool": "GET /users/{id}",
  "arguments": {
    "path": { "id": "42" },
    "query": { "active": true },
    "body": { "name": "Ada" }
  }
}
```

Every OpenAPI endpoint can set:

- `requestTimeoutMs`: timeout for HTTP calls. Defaults to `60000`.
- `operationCacheTtlMs`: how long OpenAPI operation metadata stays fresh. Defaults to `30000`; `0` refreshes every time.
- `disabled`: omit the endpoint from Caplets discovery. Defaults to `false`.

### GraphQL Endpoints

Use `graphqlEndpoints` for native GraphQL APIs. Each entry points at a GraphQL HTTP
endpoint and exactly one schema source: `schemaPath`, `schemaUrl`, or `introspection: true`.

```json
{
  "name": "Catalog GraphQL",
  "description": "Query and update catalog records through GraphQL.",
  "endpointUrl": "https://api.example.com/graphql",
  "schemaPath": "./schema.graphql",
  "auth": { "type": "oidc", "issuer": "https://login.example.com" },
  "operations": {
    "product": {
      "document": "query Product($id: ID!) { product(id: $id) { id name } }",
      "operationName": "Product",
      "description": "Fetch a product by ID."
    }
  }
}
```

When `operations` is omitted or empty, Caplets auto-generates tools from schema root
fields: `query_<field>` and `mutation_<field>`. Generated tools use bounded scalar
selection sets and pass `call_tool.arguments` directly as GraphQL variables/root-field
arguments.

Every GraphQL endpoint can set:

- `requestTimeoutMs`: timeout for HTTP calls. Defaults to `60000`.
- `operationCacheTtlMs`: how long GraphQL operation metadata stays fresh. Defaults to `30000`; `0` refreshes every time.
- `selectionDepth`: maximum depth for generated selection sets. Defaults to `2`; maximum `5`.
- `disabled`: omit the endpoint from Caplets discovery. Defaults to `false`.

### HTTP APIs

Use `httpApis` for simple HTTP APIs that do not have an OpenAPI spec. Each action is an
explicitly configured tool; Caplets does not discover routes, import curl commands, or execute
shell snippets.

```json
{
  "name": "Status API",
  "description": "Read and update deployment status through HTTP actions.",
  "baseUrl": "https://api.example.com",
  "auth": { "type": "bearer", "token": "$env:STATUS_API_TOKEN" },
  "maxResponseBytes": 1000000,
  "actions": {
    "get_status": {
      "method": "GET",
      "path": "/status/{service}",
      "description": "Fetch status for one service.",
      "inputSchema": {
        "type": "object",
        "properties": { "service": { "type": "string" }, "verbose": { "type": "boolean" } },
        "required": ["service"]
      },
      "query": { "verbose": "$input.verbose" }
    },
    "set_status": {
      "method": "POST",
      "path": "/status/{service}",
      "jsonBody": { "state": "$input.state", "note": "$input.note" }
    }
  }
}
```

HTTP API actions support `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`. `baseUrl` must be HTTPS
except loopback URLs, must not include credentials, query, or fragment, and action `path` values
must start with `/` and be URL paths that cannot change origin or escape the base URL path.

Action mappings can set `query`, `headers`, and `jsonBody`. `query` and `headers` must resolve
to object maps whose values are strings, numbers, or booleans. `jsonBody` may use literals,
nested arrays/objects, `$input.field` references, or `$input` for the whole argument object.
Path placeholders such as `{service}` are read directly from `call_tool.arguments` and URL-encoded.
Configured action headers cannot set managed headers such as `authorization`, `host`,
`content-length`, `connection`, or `content-type`; JSON bodies set `content-type` automatically.

HTTP API auth supports `none`, `bearer`, `headers`, `oauth2`, and `oidc`, matching OpenAPI and
GraphQL. Responses are returned as structured content with `status`, `statusText`, safe headers,
parsed `body` when present, and `elapsedMs`; non-2xx responses set `isError`, redirects are rejected,
timeouts are enforced, response bodies are capped by `maxResponseBytes` (default `1000000`), and
errors redact secrets.

### Authentication

Remote servers can use:

- `{"type": "none"}`
- `{"type": "bearer", "token": "$env:TOKEN"}`
- `{"type": "headers", "headers": {"x-api-key": "$env:API_KEY"}}`
- `{"type": "oauth2", ...}`
- `{"type": "oidc", ...}`

For OAuth/OIDC-backed MCP, OpenAPI, GraphQL, and HTTP API Caplets, authenticate once with:

```sh
caplets auth login <server>
```

For headless terminals:

```sh
caplets auth login <server> --no-open
```

OAuth/OIDC tokens are stored under `${XDG_STATE_HOME:-~/.local/state}/caplets/auth/<server>.json`
on Unix-like platforms and `%LOCALAPPDATA%\caplets\auth\<server>.json` on Windows.
Token files use owner-only file permissions where the platform supports them. Caplets supports
well-known OAuth/OIDC discovery and dynamic client registration when advertised. When a token expires,
run `caplets auth login <server>` again.

To inspect or remove stored OAuth credentials:

```sh
caplets auth list
caplets auth logout <server>
```

To list configured Caplets without starting downstream backends:

```sh
caplets list
caplets list --all
caplets list --json
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

`caplets serve` watches the effective user config, project config, user Caplet files, and
trusted project Caplet files. Adding, editing, disabling, or removing a Caplet updates the
top-level MCP tool list without restarting Caplets. When an MCP-backed Caplet changes or is
removed, Caplets closes only that affected downstream connection; unrelated Caplets and
their downstream connections keep running.

## How Agents Use It

Caplets initially exposes one MCP tool per enabled Caplet. If the config has `filesystem`,
`docs`, and `users`, the client sees three top-level tools: `filesystem`, `docs`, and
`users`.

Each generated Caplet tool accepts an `operation`:

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

- `get_caplet`: return the configured capability card without starting the downstream server.
- `check_backend`: verify the selected backend, whether MCP, OpenAPI, or GraphQL.
- `check_mcp_server`: start or connect to an MCP server and verify its tool list.
- `list_tools`: return compact downstream tool metadata.
- `search_tools`: search downstream tool names and descriptions within this Caplet.
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

`pnpm dev` rebuilds Caplets source changes and restarts the local stdio MCP server from
`dist/index.js`. Use it for local development, not as the command configured in an MCP
client, because build logs are written to stdout. Runtime config hot reload is built into
normal `caplets serve` and does not require `pnpm dev`.

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
