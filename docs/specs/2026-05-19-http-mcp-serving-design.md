# HTTP MCP Serving via `caplets serve`

## Status

Approved design from grilling session. Implementation plan included in this PR stack.

## Goal

Add opt-in HTTP MCP serving to `caplets serve` while preserving stdio serving as the default explicit serve transport. HTTP mode should expose Caplets over modern MCP Streamable HTTP using Hono and `@hono/mcp`, with optional Basic Auth, safe localhost defaults, and clean session/shutdown handling.

## Non-goals

- Do not make HTTP the default transport.
- Do not support deprecated HTTP+SSE endpoints in v1.
- Do not allow unauthenticated non-loopback HTTP serving unless the operator explicitly opts in.
- Do not keep no-arg `caplets` as an implicit MCP stdio server.

## CLI behavior

```sh
caplets
# prints help and exits 0

caplets serve
# serves MCP over stdio

caplets serve --transport stdio
# same as above

caplets serve --transport http
# serves MCP over Streamable HTTP at http://127.0.0.1:5387/mcp
```

Serve options:

```text
--transport <stdio/http>
--host <host>       # HTTP only, default 127.0.0.1
--port <port>       # HTTP only, default 5387
--path <path>       # HTTP only, default /mcp
--user <user>       # HTTP only, optional; defaults to env or caplets when password is set
--password <pass>   # HTTP only, optional; enables Basic Auth
--allow-unauthenticated-http  # HTTP only, required for unauthenticated non-loopback serving
```

Validation rules:

- Unknown transport errors.
- Port must be a valid TCP port.
- Path must start with `/`, contain no query string or fragment, and normalize trailing slashes except for root.
- `--host`, `--port`, `--path`, `--user`, `--password`, and `--allow-unauthenticated-http` are invalid with stdio transport.
- `caplets` with no arguments prints help and exits successfully.
- `caplets serve` remains quiet in stdio mode to preserve MCP framing.

## HTTP serving behavior

HTTP mode uses Hono, `@hono/node-server`, and `@hono/mcp` `StreamableHTTPTransport`.

Required direct dependencies in `@caplets/core`:

```json
{
  "@hono/mcp": "^0.3.0",
  "@hono/node-server": "^1.19.9",
  "hono": "^4.11.5"
}
```

Endpoints:

```text
GET /                 -> info JSON, unauthenticated
GET /healthz          -> health JSON, unauthenticated
GET/POST/DELETE /mcp  -> MCP Streamable HTTP, Basic Auth protected when enabled
```

`GET /` returns informational JSON similar to:

```json
{
  "name": "caplets",
  "transport": "http",
  "mcp": "/mcp",
  "health": "/healthz",
  "auth": { "type": "basic", "enabled": true }
}
```

`GET /healthz` returns:

```json
{
  "status": "ok",
  "transport": "http",
  "mcpPath": "/mcp"
}
```

Only the exact normalized MCP path handles MCP requests. For example, when `--path /mcp`, `/mcp/foo` returns 404.

## Basic Auth

Basic Auth is optional and applies only to the MCP path.

Credential resolution:

- Effective user is `--user`, else `CAPLETS_SERVER_USER`, else `caplets`.
- Effective password is `--password`, else `CAPLETS_SERVER_PASSWORD`.
- Auth is enabled only when an effective password exists.
- If an explicit user is provided via `--user` or `CAPLETS_SERVER_USER` but no password exists, fail fast with a clear error asking for `--password` or `CAPLETS_SERVER_PASSWORD`.
- Never log the password.

Non-loopback and wildcard hosts may run without authentication only when the operator explicitly passes `--allow-unauthenticated-http`; otherwise HTTP startup must fail fast. When explicit unauthenticated non-loopback serving is allowed, startup must still warn.

## DNS rebinding protection

The Hono MCP transport should enable DNS rebinding protection for loopback hosts: `127.0.0.1`, `localhost`, and `::1`.

For loopback serving, configure `StreamableHTTPTransport` with:

- `enableDnsRebindingProtection: true`
- `allowedHosts` containing the expected loopback host and host-with-port values.
- `allowedOrigins` for matching localhost origins when practical.

For non-loopback hosts, do not enable strict host validation by default. Require Basic Auth unless `--allow-unauthenticated-http` is present, and warn when explicit unauthenticated non-loopback serving is used.

## Session model

Use modern Streamable HTTP only.

- Initial `POST` to the MCP path without `Mcp-Session-Id` creates a session.
- Each session gets a random ID from `crypto.randomUUID()`.
- Each session owns one `@hono/mcp` `StreamableHTTPTransport` and one MCP server instance.
- Later `GET`, `POST`, and `DELETE` requests with `Mcp-Session-Id` route to the matching session.
- Missing or unknown session IDs return JSON-RPC-style errors consistent with MCP transport behavior.
- `DELETE` closes the session, removes it from the session map, and closes its server/transport.
- Global shutdown closes all active sessions.

## Runtime architecture

Refactor the current runtime shape into reusable pieces:

1. **Shared engine owner**
   - One `CapletsEngine` owns config loading, file watching, reload serialization, backend managers, auth dir, and last-known-good config.

2. **MCP session wrapper**
   - Creates an `McpServer`, registers Caplet tools from the shared engine's current config, and subscribes to engine reload events.
   - Reconciles tools on reload.
   - Connects to exactly one MCP transport.

3. **Stdio serving**
   - Creates one shared engine, one MCP session wrapper, and one `StdioServerTransport`.

4. **HTTP serving**
   - Creates one shared engine.
   - Creates one MCP session wrapper per Hono MCP session.
   - Shares tool registration and reload reconciliation logic with stdio.

This respects the MCP SDK constraint that a protocol/server instance connects to only one transport, while avoiding duplicate config watchers and backend managers per HTTP client.

## Startup and shutdown

HTTP startup logs go to stderr, not stdout:

```text
Caplets MCP HTTP server listening on http://127.0.0.1:5387/mcp
Health check: http://127.0.0.1:5387/healthz
Basic Auth: enabled (user: caplets)
```

If HTTP listens on a non-loopback or wildcard host without auth, also print a warning to stderr.

Shutdown behavior:

- Handle `SIGINT` and `SIGTERM` in serve mode.
- Stop accepting new HTTP connections.
- Close all active MCP sessions.
- Close the shared Caplets engine and downstream connections.
- Exit `130` on `SIGINT` and `143` on `SIGTERM`.
- If cleanup fails, log the error to stderr and still exit.

## Implementation touchpoints

Likely files:

- `packages/cli/src/index.ts`
  - Remove special-casing for no args and `serve`; always delegate to `runCli`.

- `packages/core/src/cli.ts`
  - Add Commander `serve` command.
  - Add no-arg help behavior.
  - Parse and validate serve options.
  - Wire signal handling for serve mode.

- New core serve modules, likely:
  - `packages/core/src/serve/options.ts`
  - `packages/core/src/serve/stdio.ts`
  - `packages/core/src/serve/http.ts`
  - `packages/core/src/serve/session.ts`

- `packages/core/src/runtime.ts`
  - Keep as compatibility wrapper or refactor to use the shared session helper.

- `packages/core/package.json`
  - Add Hono dependencies.

## Testing plan

CLI/options tests:

- `caplets` with no args prints help and does not serve.
- `serve` defaults to stdio.
- `serve --transport http` parses defaults: host `127.0.0.1`, port `5387`, path `/mcp`.
- Invalid transport, port, and path error.
- HTTP-only options with stdio error.
- Auth resolution from flags/env/default user works.

HTTP integration tests:

- `GET /` returns info JSON.
- `GET /healthz` returns health JSON.
- Basic Auth blocks MCP path when password is configured.
- MCP initialize/list-tools works over Streamable HTTP.
- Session cleanup works on `DELETE` or transport close.

Verification commands:

```sh
pnpm --filter @caplets/core test -- test/<new-serve-tests>.test.ts
pnpm --filter @caplets/core typecheck
pnpm typecheck
pnpm test
pnpm verify
```

## References

- Hono MCP README: <https://github.com/honojs/middleware/tree/main/packages/mcp>
- Hono MCP docs: <https://honohub.dev/docs/hono-mcp>
- Hono MCP stateful docs: <https://honohub.dev/docs/hono-mcp/stateful>
