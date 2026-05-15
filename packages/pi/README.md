# @caplets/pi

Native Pi extension for Caplets.

This package exposes configured Caplets as native Pi tools named `caplets_<id>`. It does not start the Caplets MCP server. Pi prompt guidance is provided through `promptSnippet` and `promptGuidelines`.

## Install

Install the extension with Pi:

```sh
pi install npm:@caplets/pi
```

For package-manager based installs, install it in the same environment where Pi resolves extension packages:

```sh
npm install -g @caplets/pi
```

Or install it project-locally:

```sh
pnpm add -D @caplets/pi
```

The extension reads your existing Caplets configuration through `@caplets/core`; it does not create or mutate Pi config files.

New or removed Caplets are snapshotted at extension load. Restart Pi or reload extensions to refresh the native tool list.
