# Remote Caplets Service for Native Integrations Design

## Goal

Let Caplets integrations connect to a remote `caplets serve --transport http` service instead of always loading local Caplets config and backends. The first implementation should support all existing integration surfaces:

- OpenCode native plugin (`@caplets/opencode`) keeps native `caplets_<id>` tools.
- Pi native extension (`@caplets/pi`) keeps native `caplets_<id>` tools.
- Codex and Claude Code plugin artifacts can point at a remote MCP HTTP service instead of spawning local `caplets serve`.

The feature should build on the Hono Streamable HTTP server added for `caplets serve --transport http` and should not introduce a separate Caplets-specific HTTP API.

## Non-goals

- Do not add a hosted Caplets cloud service.
- Do not add OAuth client flows for connecting to the Caplets service in v1. Basic Auth and unauthenticated loopback development are enough.
- Do not remove local mode. Local mode remains the default unless remote configuration is present or explicitly selected.
- Do not flatten remote downstream tools directly into Codex/Claude plugin manifests. Codex/Claude remain MCP-backed.

## Configuration model

Remote client settings have three conceptual fields:

- `url`: full MCP endpoint URL, for example `http://127.0.0.1:5387/mcp` or `https://caplets.example.com/mcp`.
- `user`: Basic Auth user. Defaults to `caplets` when a password is present.
- `password`: Basic Auth password. If a user is explicitly provided without a password, configuration is invalid.

Universal environment variables:

- `CAPLETS_REMOTE_URL`
- `CAPLETS_REMOTE_USER`
- `CAPLETS_REMOTE_PASSWORD`
- `CAPLETS_NATIVE_MODE` with values `auto`, `local`, or `remote`

Resolution rules:

1. Integration-specific config overrides environment variables.
2. OpenCode integration-specific config is read from the plugin factory's second argument and translated into `NativeCapletsServiceOptions`.
3. Pi integration-specific config is read from package/extension args passed through Pi settings. The implementation should consume args passed by Pi rather than parsing settings files directly; examples use Pi's current documented user settings path (`~/.pi/agent/settings.json`) and should be adjusted if the active runtime path is `~/.pi/agents/settings.json`.
4. `CAPLETS_NATIVE_MODE=local` forces current local behavior and ignores remote URL variables.
5. `CAPLETS_NATIVE_MODE=remote` requires a remote URL.
6. `CAPLETS_NATIVE_MODE=auto` or unset uses remote mode when a remote URL is configured, otherwise local mode.
7. Remote URLs must be `https:` except loopback `http://localhost`, `http://127.0.0.1`, and `http://[::1]` for development.
8. Basic Auth is enabled only when a password is present. `user` without `password` fails fast with a clear error.

## Core architecture

Add a native service factory that chooses between local and remote implementations:

```ts
createNativeCapletsService(options?: NativeCapletsServiceOptions): NativeCapletsService
```

`NativeCapletsServiceOptions` gains:

```ts
type NativeCapletsServiceOptions = {
  mode?: "auto" | "local" | "remote";
  remote?: {
    url?: string;
    user?: string;
    password?: string;
    pollIntervalMs?: number;
    fetch?: typeof fetch;
  };
  // existing local options stay unchanged
};
```

The existing `DefaultNativeCapletsService` becomes the local implementation. A new `RemoteNativeCapletsService` uses MCP SDK client primitives:

- `Client` from `@modelcontextprotocol/sdk/client/index.js`
- `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk/client/streamableHttp.js`

Remote mode connects once, initializes MCP, lists remote tools, maps them to `NativeCapletTool`, and calls tools through `client.callTool()`.

## Tool mapping

The remote Caplets HTTP server already exposes one MCP tool per Caplet, with the Caplet ID as the MCP tool name. The remote native service maps each remote MCP tool to the same native shape local mode uses:

- `caplet`: remote MCP tool name
- `toolName`: `nativeCapletToolName(remoteTool.name)`, preserving `caplets_<id>` names
- `title`: remote MCP tool title when present, otherwise remote tool name
- `description`: remote MCP tool description, wrapped with native Caplets guidance where useful
- `promptGuidance`: generated guidance that says the tool is backed by the configured remote Caplets service

Execution passes the existing generated Caplets input schema through unchanged. Native integrations continue to pass parameters directly to `service.execute(capletId, params)`.

## Refresh and notifications

Remote mode should prefer live MCP notifications but always have a polling fallback.

1. On connect, call `listTools()` and notify listeners if the mapped tool list changed.
2. Register an MCP client `listChanged.tools.onChanged` handler when the server advertises tool-list-change notifications. The handler refreshes tools and notifies native listeners.
3. Also poll at a default interval, proposed `30_000ms`, to cover transports, proxies, or servers that do not deliver notifications reliably.
4. `reload()` manually refreshes the remote tool list and reconnects once if the session is closed or invalid.
5. `close()` stops polling, terminates the MCP session when possible, closes transport/client resources, and prevents further listener notifications.

OpenCode still cannot dynamically add newly discovered native tools after plugin load because its plugin API snapshots tools at load time. The remote service should still keep its internal list fresh so executions use current remote state, and the README should document that OpenCode restart may be needed for newly added or renamed Caplets. Pi can continue registering newly discovered tools during the current session.

## Error handling

Remote service errors should be explicit and agent-friendly:

- Missing remote URL in forced remote mode: configuration error before integration registration.
- Invalid URL or disallowed non-HTTPS URL: configuration error.
- User without password: configuration error.
- 401/403: auth error mentioning `CAPLETS_REMOTE_USER` and `CAPLETS_REMOTE_PASSWORD`.
- Connection failure: remote unavailable error including host and path but not credentials.
- Tool removed between list and call: normal Caplets-style structured tool error where possible, otherwise a clear remote tool-not-found error.
- Notification/poll refresh failure: keep last known-good tools, report through `writeErr`, and retry on the next poll/manual reload.

No logs may include Basic Auth credentials or full `Authorization` headers.

## Integration behavior

### OpenCode

`@caplets/opencode` should accept remote configuration through the plugin factory's second argument while preserving environment-variable fallback:

```ts
type CapletsOpenCodeConfig = {
  mode?: "auto" | "local" | "remote";
  remote?: {
    url?: string;
    user?: string;
    password?: string;
    pollIntervalMs?: number;
  };
};

const plugin: Plugin = async (_ctx, config?: CapletsOpenCodeConfig) => {
  const service = createNativeCapletsService(nativeOptionsFromOpenCodeConfig(config));
  // existing hook registration continues
};
```

OpenCode config values override environment variables. README examples should show both environment-variable configuration and second-argument/plugin configuration in whichever JSON/TypeScript shape OpenCode currently documents for plugin config. The second-argument config is the preferred non-secret location for `url`, `mode`, and `user`; `password` should still usually come from `CAPLETS_REMOTE_PASSWORD` unless OpenCode provides a secure secret mechanism.

```sh
CAPLETS_REMOTE_URL=http://127.0.0.1:5387/mcp opencode
CAPLETS_REMOTE_URL=https://caplets.example.com/mcp \
CAPLETS_REMOTE_USER=caplets \
CAPLETS_REMOTE_PASSWORD=... \
opencode
```

### Pi

`@caplets/pi` continues to accept an injected `service` for tests and advanced users. It should also accept native service options from Pi package/extension args loaded from Pi settings, so users can configure remote mode in Pi user settings without relying only on environment variables.

Example target shape:

```json
{
  "packages": [
    {
      "source": "npm:@caplets/pi",
      "args": {
        "mode": "remote",
        "remote": {
          "url": "https://caplets.example.com/mcp",
          "user": "caplets"
        }
      }
    }
  ]
}
```

Pi args override environment variables. As with OpenCode, `password` should normally come from `CAPLETS_REMOTE_PASSWORD` unless Pi adds a secure secret surface. The extension API should keep the current test seam by accepting `{ service }`, and it should merge that with `{ native?: NativeCapletsServiceOptions }` or `{ args?: NativeCapletsServiceOptions }` without breaking existing callers.

### Codex and Claude Code

The plugin artifacts remain MCP-backed. The default bundled `plugins/caplets/mcp.json` should continue to use local stdio for zero-config installs:

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

Add a documented remote variant users can copy into their agent config:

```json
{
  "mcpServers": {
    "caplets": {
      "url": "https://caplets.example.com/mcp",
      "headers": {
        "Authorization": "Basic ${CAPLETS_REMOTE_BASIC_AUTH}"
      }
    }
  }
}
```

Because Codex/Claude plugin manifest schemas may not support runtime environment interpolation in bundled MCP JSON consistently, v1 should document remote configuration rather than shipping secrets or a second remote-only plugin manifest. If both agents support local plugin config overrides, add examples there; otherwise keep the plugin artifact unchanged.

## Security

- Remote mode must never persist passwords unless the host integration explicitly provides secure storage later.
- Do not put passwords in plugin manifests.
- Prefer `https:` for non-loopback endpoints and reject non-loopback `http:`.
- Basic Auth should be created in memory per request using `requestInit.headers.Authorization` for the MCP HTTP transport.
- The default server remains loopback-only and unauthenticated unless explicitly configured otherwise.

## Testing plan

Core tests:

- Option resolution: env/config precedence, mode selection, URL validation, Basic Auth validation.
- Remote native service with a mocked MCP client/transport or local in-process Streamable HTTP test server:
  - lists remote Caplets as native tools
  - calls remote tools
  - handles tool-list-change notifications
  - polls as fallback
  - keeps last known-good tools on refresh failure
  - closes/terminates sessions cleanly

Integration tests:

- OpenCode passes second-argument plugin config into native service options, with config overriding env vars, and preserves native tool registration behavior.
- Pi passes settings/package args into native service options, with args overriding env vars, and keeps existing dynamic registration behavior.
- Codex/Claude plugin tests verify bundled local config remains valid and docs include remote config examples.

Verification:

- Focused package tests for core, opencode, pi, and plugin artifacts.
- `pnpm typecheck`
- `pnpm test`
- `pnpm verify`

## Implementation constraints

- Environment variables are required in v1, but OpenCode second-argument config and Pi settings/package args are also required integration config surfaces.
- Codex/Claude examples should avoid promising interpolation behavior that their current MCP config schemas do not support. Use agent-specific documented override mechanisms when available; otherwise document manual config edits.
- Poll interval defaults to 30 seconds and is configurable through core options. Add an environment override only if implementation finds a clear cross-agent need.
