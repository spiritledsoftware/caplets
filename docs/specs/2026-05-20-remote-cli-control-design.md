# Remote CLI Control Service Design

## Goal

Let the `caplets` CLI operate against a remote `caplets serve --transport http` service when configured, so the remote server becomes the source of truth for Caplets config, Caplet files, installed Caplets, downstream auth, and command execution.

The feature should feel like a unified product surface rather than separate “native” and “remote” concepts. Users configure one mode and one server base URL, then the CLI, OpenCode integration, and Pi integration choose local or remote behavior consistently.

## Non-goals

- Do not expose CLI administration as ordinary MCP tools.
- Do not run raw shell command strings on the server.
- Do not preserve pre-1.0 compatibility for the current HTTP `--path` semantics.
- Do not make `serve`, `config path`, or `config paths` remote-control commands.
- Do not leak downstream OAuth tokens, Basic Auth credentials, or authorization headers through responses, logs, or errors.

## Unified environment interface

Use one environment variable interface for CLI and native integrations:

```sh
CAPLETS_MODE=auto      # auto, remote, or local
CAPLETS_SERVER_URL=http://127.0.0.1:5387/caplets
CAPLETS_SERVER_USER=caplets
CAPLETS_SERVER_PASSWORD=...
```

`CAPLETS_SERVER_URL` is the service base URL, including any deployment prefix. It is not the MCP endpoint URL.

Mode resolution:

1. `CAPLETS_MODE=auto` or unset uses remote mode when `CAPLETS_SERVER_URL` is set; otherwise local mode.
2. `CAPLETS_MODE=local` always uses local mode, even when server settings are present.
3. `CAPLETS_MODE=remote` requires `CAPLETS_SERVER_URL` and fails fast if missing.

Explicit host config/options still override environment config where integrations already support explicit options. The target model has no separate native-only mode namespace.

## HTTP service URL contract

`caplets serve --transport http` exposes a Caplets service rooted at `--path`.

Defaults:

```text
host: 127.0.0.1
port: 5387
path: /
```

Routes under the service base:

```text
GET  {base}/healthz
POST {base}/mcp
POST {base}/control
GET  {base}/control/auth/callback/:flowId   # browser OAuth callback for remote auth login
```

Examples:

```sh
caplets serve --transport http
# service base:     http://127.0.0.1:5387
# MCP endpoint:     http://127.0.0.1:5387/mcp
# control endpoint: http://127.0.0.1:5387/control
# health endpoint:  http://127.0.0.1:5387/healthz

caplets serve --transport http --path /caplets
# service base:     http://127.0.0.1:5387/caplets
# MCP endpoint:     http://127.0.0.1:5387/caplets/mcp
# control endpoint: http://127.0.0.1:5387/caplets/control
# health endpoint:  http://127.0.0.1:5387/caplets/healthz
```

`CAPLETS_SERVER_URL` uses the same base URL shape:

```text
CAPLETS_SERVER_URL=https://example.com/caplets
MCP endpoint:      https://example.com/caplets/mcp
Control endpoint:  https://example.com/caplets/control
Health endpoint:   https://example.com/caplets/healthz
```

`caplets serve --transport http` also reads the unified server variables as defaults:

- `CAPLETS_SERVER_URL` provides default host, port, and base path.
- `CAPLETS_SERVER_USER` provides the Basic Auth user.
- `CAPLETS_SERVER_PASSWORD` enables Basic Auth and provides the password.

Explicit `serve` flags override environment defaults.

## Architecture

Add a Remote CLI Control Service alongside the existing MCP HTTP service.

```text
Local shell
  caplets list
  caplets add mcp github ...
  caplets call-tool github.search_repositories ...
        │
        ▼
Remote CLI client
        │ HTTPS + auth
        ▼
caplets serve --transport http
  {base}/mcp      → agent-facing MCP tools
  {base}/control  → CLI-facing control API
        │
        ▼
Remote CapletsEngine + remote filesystem/config/auth store
```

The MCP endpoint remains agent-facing and only exposes configured Caplets. The control endpoint is authenticated and exposes structured CLI administration operations.

## State ownership

In remote mode, the server owns all Caplets state:

- Caplets config
- `.caplets` files
- installed Caplets
- downstream MCP/OpenAPI/GraphQL/HTTP/CLI backend definitions
- OAuth/token auth store
- reload/watch lifecycle

A remote CLI mutation changes server-side state only. It must not partially mutate local files. Successful mutation messages must explicitly say `remote` so users do not confuse server writes with local filesystem writes.

Examples:

```text
Installed github to remote /srv/caplets/.caplets/github
Wrote remote MCP Caplet to /srv/caplets/.caplets/github.md
Deleted remote OAuth credentials for `linear`.
```

## Remote control API

The control API is command-semantic, not a raw command executor.

```text
POST {base}/control
Authorization: Basic ...
Content-Type: application/json
```

Request envelope:

```ts
type RemoteCliRequest = {
  command:
    | "list"
    | "get_caplet"
    | "check_backend"
    | "list_tools"
    | "search_tools"
    | "get_tool"
    | "call_tool"
    | "init"
    | "add"
    | "install"
    | "auth_login_start"
    | "auth_login_complete"
    | "auth_logout"
    | "auth_list";
  arguments: Record<string, unknown>;
};
```

Response envelope:

```ts
type RemoteCliResponse =
  | {
      ok: true;
      result: unknown;
      warnings?: string[];
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        nextAction?: string;
      };
      warnings?: string[];
    };
```

The server dispatches to internal core functions such as `listCaplets`, `addMcpCaplet`, `installCaplets`, `CapletsEngine.execute`, and auth helpers. The server must not shell out to the `caplets` CLI.

The local CLI remains responsible for output formatting, so existing `--json`, `--format plain`, and markdown summaries stay consistent across local and remote modes.

## Command behavior

Remote-capable commands:

- `list`
- `get-caplet`
- `check-backend`
- `list-tools`
- `search-tools`
- `get-tool`
- `call-tool`
- `auth login`
- `auth logout`
- `auth list`
- `add cli|mcp|openapi|graphql|http`
- `install`
- `init` when remote mode is active or an explicit remote init flag is used

Local-only commands:

- `serve`
- `config path`
- `config paths`

`config path` and `config paths` describe the local CLI process and should not become remote-control commands. Remote server filesystem paths may appear in mutation responses as diagnostics, clearly labeled as remote paths.

## Auth behavior

Remote control authentication and downstream provider authentication are separate concerns.

- `CAPLETS_SERVER_USER` and `CAPLETS_SERVER_PASSWORD` authenticate the client to the remote Caplets control service.
- Downstream OAuth/token credentials for GitHub, Linear, GraphQL endpoints, and other backends live on the server.

Remote auth commands operate on the server-side auth store:

- `caplets auth list` shows server-side credential status.
- `caplets auth logout <server>` deletes server-side credentials.
- `caplets auth login <server>` starts and completes login for the server-side auth store.

Remote login should use a flow similar to:

1. Client calls `auth_login_start`.
2. Server creates the authorization flow, stores verifier/session state server-side, and returns an authorization URL plus flow ID.
3. Client opens or prints the authorization URL and waits/polls.
4. Callback or completion request reaches the remote server.
5. Server exchanges code/token and stores credentials in its auth store.
6. Client reports success without receiving tokens.

No control API response may include raw access tokens, refresh tokens, Basic Auth passwords, or full authorization headers.

## Security

- Reject non-loopback `http:` `CAPLETS_SERVER_URL`; require HTTPS except for `localhost`, `127.0.0.1`, and `::1` development URLs.
- Basic Auth over network deployments must be used only over HTTPS.
- Protect `/control` at least as strongly as `/mcp`; `/control` can mutate server state.
- Redact secrets in errors, warnings, logs, and test snapshots.
- Do not expose control commands as MCP tools.
- Do not accept raw shell command strings through the control API.

## Error handling

Remote CLI failures should be explicit and safe:

- `CAPLETS_MODE=remote` without `CAPLETS_SERVER_URL`: configuration error.
- Invalid server base URL: configuration error.
- Non-loopback `http:` URL: configuration error requiring HTTPS.
- Missing/invalid control credentials: “Remote Caplets control authentication failed.”
- Server unreachable: “Remote Caplets server unavailable at <safe base URL>.”
- Unknown or unsupported remote command: structured control error.
- Remote mutation failure: no local mutation, and output clearly identifies the remote operation that failed.

## Testing plan

Core tests:

- URL/base-path normalization for `CAPLETS_SERVER_URL`.
- `serve --path /caplets` mounts `/caplets/mcp`, `/caplets/control`, and `/caplets/healthz`.
- CLI mode resolution from `CAPLETS_MODE` and `CAPLETS_SERVER_URL`.
- `serve` defaults from `CAPLETS_SERVER_URL`, `CAPLETS_SERVER_USER`, and `CAPLETS_SERVER_PASSWORD`.
- Remote client command envelopes and Basic Auth headers.
- Control endpoint dispatch for read, execute, mutation, and auth commands.
- Server-side auth store behavior for remote `auth login`, `auth list`, and `auth logout`.
- No secret leakage in logs, errors, warnings, or responses.

End-to-end-style tests:

- Start an in-process HTTP app.
- Set `CAPLETS_MODE=remote` and `CAPLETS_SERVER_URL`.
- Run `caplets list`, `caplets add mcp`, `caplets call-tool`, and `caplets auth list` through remote mode.
- Assert server-side files/auth store change and local temp config remains unchanged.

Verification commands for implementation:

```sh
pnpm --filter @caplets/core test -- test/serve-http.test.ts test/cli.test.ts test/auth.test.ts
pnpm typecheck
pnpm test
pnpm verify
```
