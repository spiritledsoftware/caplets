---
"@caplets/core": patch
---

Bound non-MCP HTTP JSON request bodies and return `REQUEST_INVALID` for oversized input. MCP request parsing remains owned by the MCP SDK transport.
