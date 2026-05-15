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
