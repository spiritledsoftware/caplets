---
"@caplets/core": patch
"caplets": patch
"@caplets/opencode": patch
"@caplets/pi": patch
---

Promote daemon-first local setup. `caplets setup` now initializes config, starts or reuses the local daemon, verifies health before mutating integrations, and configures MCP clients as thin `caplets attach <local-daemon-url>` clients through the pinned `add-mcp` adapter.

Add explicit native daemon mode and setup-written daemon defaults for OpenCode and Pi, while keeping remote/cloud setup on Remote Login and secret-free attach paths.
