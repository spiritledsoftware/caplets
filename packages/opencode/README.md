# @caplets/opencode

Native OpenCode plugin for Caplets.

This package exposes configured Caplets as native OpenCode tools named `caplets_<id>`. It does not start the Caplets MCP server and does not edit `opencode.json`; prompt guidance is injected through OpenCode plugin hooks.

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
