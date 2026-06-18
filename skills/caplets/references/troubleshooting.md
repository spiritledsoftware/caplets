# Caplets CLI Troubleshooting

Use this only when the Code Mode heredoc fails because setup, config, auth, or agent registration is suspect.

## Smallest Local Checks

```sh
caplets doctor
caplets config path
caplets config paths
caplets list
```

`caplets doctor` is the first health signal. `config path` and `config paths` prove which user, project, root, and auth paths are active before editing config.

## Agent Registration

For Codex:

```sh
codex mcp list
codex mcp get caplets
```

For Claude Code:

```sh
claude mcp list
claude mcp get caplets
```

The command should usually be `caplets serve` or `npx --yes caplets serve`. Remote-backed setups may use `caplets attach`.

## Stdio Startup

Do not treat a bare `caplets serve` process as a health check. Stdio MCP servers stay open waiting for JSON-RPC, so a hanging process is normal.

If registration and config look correct but the client still cannot connect, probe the exact registered command with an `initialize` request and an external timeout:

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"caplets-smoke","version":"1.0.0"}}}' \
  | timeout 5s caplets serve
```

Adapt the command and environment from the agent registration output.

## Auth

```sh
caplets auth list
caplets auth login <caplet-id>
caplets auth refresh <caplet-id>
caplets doctor
```

For Google Discovery Caplets, rerun `caplets auth login <caplet-id>` after changing operation filters or scopes.
