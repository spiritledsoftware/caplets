# @caplets/opencode

Native OpenCode plugin for Caplets.

This package exposes configured Caplets as native OpenCode tools named `caplets_<id>`. It does not start the Caplets MCP server and does not edit `opencode.json`; prompt guidance is injected through OpenCode plugin hooks.

```jsonc
{
  "plugin": ["@caplets/opencode"],
}
```

New or removed Caplets are snapshotted at plugin load. Restart OpenCode to refresh the native tool list.
