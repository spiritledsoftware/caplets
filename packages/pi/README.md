# @caplets/pi

Native Pi extension for Caplets.

This package exposes `caplets__code_mode` for Caplets Code Mode. Progressive exposure adds native Pi tools named `caplets__<id>`, and direct exposure adds operation-level tools named `caplets__<id>__<operation>`. It does not start the Caplets MCP server. Pi prompt guidance is provided through `promptSnippet` and `promptGuidelines`.

MCP-backed Caplets advertise resource, prompt, template, and completion operations in their generated schema; OpenAPI, GraphQL, HTTP, CLI, and Caplet-set backends remain tool/action-only.

## Install

Install the extension with Pi:

```sh
pi install npm:@caplets/pi
```

For package-manager-based installs, install it in the same environment where Pi resolves extension packages:

```sh
npm install -g @caplets/pi
```

Or install it project-locally:

```sh
pnpm add -D @caplets/pi
```

The extension reads your existing Caplets configuration through `@caplets/core`; it does not create or mutate Pi config files.

The extension hot reloads Caplets config and Caplet file edits. Existing tools execute against
the latest valid backend config. Newly added Caplets are registered in the current Pi session;
removed or disabled Caplets are deactivated with Pi's active-tool APIs when available. If Pi is
running without `getActiveTools()` / `setActiveTools()`, stale tools may remain registered until
Pi reloads extensions or restarts, but calls to removed Caplets return Caplets' normal structured
"server not found" error.

## Remote Selection

By default the extension uses the local Caplets native service. Use `CAPLETS_MODE` and `CAPLETS_REMOTE_*` to select local, self-hosted remote, or Caplets Cloud behavior:

```sh
CAPLETS_MODE=local pi
CAPLETS_MODE=remote CAPLETS_REMOTE_URL=https://caplets.example.com/caplets pi
CAPLETS_MODE=cloud CAPLETS_REMOTE_URL=https://cloud.caplets.dev pi
```

Run `caplets remote login <url>` before remote or Cloud mode. Native integrations use the saved Remote Profile, so remote credentials do not belong in environment variables or Pi settings.

Pi currently calls extension factories with the Pi API only, so this extension reads its remote
settings from the top-level `caplets` key in `~/.pi/agent/settings.json` when no programmatic
options are supplied:

```json
{
  "packages": ["npm:@caplets/pi"],
  "caplets": {
    "mode": "remote",
    "remote": {
      "url": "https://caplets.example.com/caplets",
      "pollIntervalMs": 5000
    },
    "statusWidget": true,
    "nerdFontIcons": true
  }
}
```

Only this top-level `caplets` settings form is read from Pi settings. Object package entries
with `args` or `native` are ignored.

When remote mode is active, Pi shows a compact footer status such as `󰖟 caplets ✓` or
`󰖟 caplets ×`. Set `"statusWidget": false` under top-level `caplets` to hide it, or
`"nerdFontIcons": false` to use plain `caplets ✓` / `caplets ×` text.
Programmatic or inline embedding can pass explicit native options with the exported factory
helper instead of relying on Pi package-loader args:

```ts
import { createCapletsPiExtension } from "@caplets/pi";

export default createCapletsPiExtension({
  args: {
    mode: "remote",
    remote: {
      url: "https://caplets.example.com/caplets",
      pollIntervalMs: 5_000,
    },
  },
});
```

The explicit config shape is `{ mode, remote: { url, pollIntervalMs } }`. Credentials come from
`caplets remote login <url>`, not settings files or source code.
