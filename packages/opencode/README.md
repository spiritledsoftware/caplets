# @caplets/opencode

Native OpenCode plugin for Caplets.

This package exposes configured Caplets as native OpenCode tools named `caplets_<id>`. It does not start the Caplets MCP server and does not edit `opencode.json`; prompt guidance is injected through OpenCode plugin hooks.

MCP-backed Caplets advertise resource, prompt, template, and completion operations in their generated schema; OpenAPI, GraphQL, HTTP, CLI, and Caplet-set backends remain tool/action-only.

```jsonc
{
  "plugin": ["@caplets/opencode"],
}
```

The plugin hot reloads Caplets config and Caplet file edits for already-registered tools, so
existing native tools execute against the latest valid backend config and prompt guidance is
rebuilt from current Caplets state for the tools registered when the plugin loaded. OpenCode's
current plugin API snapshots `Hooks.tool` at plugin load, so adding, removing, or renaming native
tools still requires restarting OpenCode; newly added tools are not advertised until restart.

## Remote Caplets service

By default the plugin reads local Caplets config. To use a remote `caplets serve --transport http` service, set environment variables:

```sh
CAPLETS_MODE=remote CAPLETS_SERVER_URL=http://127.0.0.1:5387/caplets opencode
```

For authenticated remote services, keep the password in the environment:

```sh
CAPLETS_MODE=remote \
CAPLETS_SERVER_URL=https://caplets.example.com/caplets \
CAPLETS_SERVER_USER=caplets \
CAPLETS_SERVER_PASSWORD=... \
opencode
```

OpenCode plugin config can also pass non-secret settings as the plugin factory's second argument:

```ts
export default {
  plugin: [
    [
      "@caplets/opencode",
      {
        mode: "remote",
        server: {
          url: "https://caplets.example.com/caplets",
          user: "caplets",
        },
        remote: {
          pollIntervalMs: 5_000,
        },
      },
    ],
  ],
};
```

Plugin config overrides environment variables. The explicit config shape is `{ mode, server: { url, user }, remote: { pollIntervalMs } }`. Prefer `CAPLETS_SERVER_PASSWORD` for the Basic Auth password unless your OpenCode setup provides secure secret storage.
