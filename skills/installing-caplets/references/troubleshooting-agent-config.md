# Troubleshooting Agent Configuration

Use this reference when Caplets CLI/daemon is healthy but the selected agent does not show Caplets tools, the MCP server is disconnected, native plugins are missing, or setup cannot write agent config.

## Diagnose

Start with the setup output and inspect only relevant config sections:

- MCP entries named `caplets`.
- Commands shaped as `caplets attach <url>`.
- Pi package/settings entries for `npm:@caplets/pi` or top-level `caplets` settings.
- OpenCode plugin entries for `@caplets/opencode`.

Run a dry-run for the selected target when possible:

```sh
caplets setup <target> --dry-run --format json
```

For generic MCP clients, use the exact client ID supported by `caplets setup mcp-client --client <id>` or write a fallback config:

```sh
caplets setup mcp-client --output ./caplets.mcp.json --dry-run --format json
```

## Fix patterns

- **Config write failed:** keep the daemon if it is healthy. Propose rerunning the integration-only setup for the chosen client.
- **Unsupported client ID:** do not invent IDs. Ask the user to choose a supported client or use `--output ./caplets.mcp.json` and import manually.
- **MCP server present but disconnected:** confirm the command is `caplets attach <url>`, the URL is reachable or logged in, and the client was restarted/reloaded.
- **Pi native tools missing:** confirm `caplets setup pi` or `pi install npm:@caplets/pi` occurred, then restart/reload Pi. Look for `caplets__code_mode` or a Caplets status widget when applicable.
- **OpenCode native tools missing:** confirm the plugin entry and restart OpenCode; newly added native tools may require restart.
- **PATH differs inside agent:** prefer daemon-first setup because the agent only launches `caplets attach`; if it still cannot find `caplets`, propose an absolute command path or fixing the agent launch environment.

## Approval boundary

Editing third-party agent config requires user approval unless the exact edit was already in the approved plan. Restart/reload instructions do not require approval.
