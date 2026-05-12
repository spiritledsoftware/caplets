---
"caplets": patch
---

Load project config from `./.caplets/config.json` alongside user config, with project values taking precedence while preserving user-only servers. Fix OAuth login token exchange for clients with secret authentication, and clarify generated Caplets tool descriptions so downstream tool inputs are passed under `call_tool.arguments`.
