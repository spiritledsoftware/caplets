# @caplets/opencode

Native OpenCode plugin for Caplets.

This package exposes `caplets__code_mode` for Caplets Code Mode. Progressive exposure adds native OpenCode tools named `caplets__<id>`, and direct exposure adds operation-level tools named `caplets__<id>__<operation>`. It does not start the Caplets MCP server and does not edit `opencode.json`; prompt guidance is injected through OpenCode plugin hooks.

MCP-backed Caplets advertise resource, prompt, template, and completion operations in their generated schema; OpenAPI, GraphQL, HTTP, CLI, and Caplet-set backends remain tool/action-only.

Use `caplets__code_mode` for multi-step workflows that benefit from Code Mode: TypeScript with generated `caplets.<id>` handles, progressive discovery, downstream tool calls, filtering, joins, and compact synthesis in one native OpenCode call.

For adjacent workflows, omit top-level `sessionId` to start a fresh reusable Code Mode session, then pass the returned `meta.sessionId` as top-level `sessionId` on later calls that should reuse live helper functions, `var` bindings, and runtime state while the session remains available. Unknown or expired sessions fail before execution; use recovery metadata for audit or manual reconstruction rather than automatic replay.

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

## Remote Selection

By default the plugin reads local Caplets config. Use `CAPLETS_MODE` and `CAPLETS_REMOTE_*` to select local, self-hosted remote, or Caplets Cloud behavior:

```sh
CAPLETS_MODE=local opencode
CAPLETS_MODE=remote CAPLETS_REMOTE_URL=https://caplets.example.com/caplets opencode
CAPLETS_MODE=cloud CAPLETS_REMOTE_URL=https://cloud.caplets.dev opencode
```

Run `caplets cloud auth login` before Cloud mode. For authenticated self-hosted remotes, keep credentials in the environment:

```sh
CAPLETS_MODE=remote \
CAPLETS_REMOTE_URL=https://caplets.example.com/caplets \
CAPLETS_REMOTE_TOKEN=... \
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
        remote: {
          url: "https://caplets.example.com/caplets",
          user: "caplets",
          pollIntervalMs: 5_000,
        },
      },
    ],
  ],
};
```

Plugin config overrides environment variables. The explicit config shape is `{ mode, remote: { url, user, pollIntervalMs } }`. Prefer `CAPLETS_REMOTE_TOKEN` or `CAPLETS_REMOTE_PASSWORD` for self-hosted credentials unless your OpenCode setup provides secure secret storage.
