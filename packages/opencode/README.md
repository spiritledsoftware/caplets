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

## Runtime Selection

`caplets setup opencode` installs the plugin and writes non-secret daemon defaults so the plugin connects to the local Caplets daemon by default. Use `CAPLETS_MODE`, `CAPLETS_DAEMON_URL`, and `CAPLETS_REMOTE_*` to select local in-process, daemon, self-hosted remote, or Caplets Cloud behavior:

```sh
CAPLETS_MODE=local opencode
CAPLETS_MODE=daemon CAPLETS_DAEMON_URL=http://127.0.0.1:5387/ opencode
CAPLETS_MODE=remote CAPLETS_REMOTE_URL=https://caplets.example.com/caplets opencode
CAPLETS_MODE=cloud CAPLETS_REMOTE_URL=https://cloud.caplets.dev opencode
```

Run `caplets remote login <url>` before remote or Cloud mode. Native integrations use the saved Remote Profile, so remote credentials do not belong in the environment:

```sh
caplets remote login https://caplets.example.com/caplets
CAPLETS_MODE=remote \
CAPLETS_REMOTE_URL=https://caplets.example.com/caplets \
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
          pollIntervalMs: 5_000,
        },
      },
    ],
  ],
};
```

Plugin config overrides environment variables and setup-written daemon defaults. The explicit config shape is `{ mode, daemon: { url, pollIntervalMs }, remote: { url, pollIntervalMs } }`; daemon mode is credential-free loopback, and remote credentials come from `caplets remote login <url>`.

## Anonymous Telemetry

Caplets native integrations share the core anonymous telemetry controls. Native-first runs do not
send telemetry until the CLI has recorded a visible telemetry notice. Disable telemetry with
top-level `"telemetry": false` in the user Caplets config or `CAPLETS_DISABLE_TELEMETRY=1`.
Telemetry never includes prompts, tool arguments, tool outputs, paths, URLs, hostnames, Caplet IDs,
credentials, tokens, raw env, Code Mode code, logs, raw error messages, or unsanitized stack traces.
