# @caplets/pi

Native Pi extension for Caplets.

This package exposes configured Caplets as native Pi tools named `caplets_<id>`. It does not start the Caplets MCP server. Pi prompt guidance is provided through `promptSnippet` and `promptGuidelines`.

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

## Remote Caplets service

By default the extension uses the local Caplets native service. To connect Pi to a remote
`caplets serve --transport http` service, prefer environment variables for connection details,
especially the password:

```sh
export CAPLETS_REMOTE_URL="https://caplets.example.com/mcp"
export CAPLETS_REMOTE_USER="caplets"
export CAPLETS_REMOTE_PASSWORD # set in your shell or secret manager
```

Pi currently calls extension factories with the Pi API only, so this extension reads its remote
settings from the top-level `caplets` key in `~/.pi/agent/settings.json` when no programmatic
options are supplied:

```json
{
  "packages": ["npm:@caplets/pi"],
  "caplets": {
    "mode": "remote",
    "remote": {
      "url": "https://caplets.example.com/mcp",
      "user": "caplets"
    }
  }
}
```

Only this top-level `caplets` settings form is read from Pi settings. Object package entries
with `args` or `native` are ignored.
Programmatic or inline embedding can pass explicit native options with the exported factory
helper instead of relying on Pi package-loader args:

```ts
import { createCapletsPiExtension } from "@caplets/pi";

export default createCapletsPiExtension({
  args: {
    mode: "remote",
    remote: {
      url: "https://caplets.example.com/mcp",
      user: "caplets",
    },
  },
});
```

Prefer environment variables for `CAPLETS_REMOTE_PASSWORD` rather than storing passwords in
settings files or source code.
