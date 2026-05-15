---
name: caplets
description: Use Caplets when you need to inspect and call configured capability domains without loading every downstream MCP, OpenAPI, GraphQL, HTTP, or CLI tool up front.
---

# Caplets

Use Caplets when a task benefits from tools exposed through configured Caplets backends, including MCP servers, OpenAPI services, GraphQL endpoints, HTTP tools, or CLI commands.

Caplets exposes progressive discovery operations instead of flattening every downstream tool into the agent context. Start narrow, inspect only what you need, then call the specific downstream tool.

## Workflow

1. Read the caplet card with `get_caplet` when you need to understand what a configured Caplet provides.
2. Check backend availability with `check_mcp_server`, `check_backend`, or the equivalent operation before relying on a backend.
3. Discover tools with `list_tools` or `search_tools`.
4. Inspect a downstream tool schema with `get_tool` before calling it.
5. Call downstream tools with `call_tool`, putting downstream inputs inside the top-level `arguments` object.

## Guidance

- Prefer `search_tools` when you know the capability you need.
- Prefer `list_tools` when exploring a small or unfamiliar Caplet.
- Keep downstream arguments nested under `arguments`; do not put downstream fields at the top level.
- Request only the output fields needed when the Caplet supports field selection.
- Treat Caplet backends as live integrations: handle unavailable services, auth failures, validation errors, and partial responses explicitly.
- Avoid loading broad tool lists unless the user task requires exploration.

## Example

```json
{
  "operation": "call_tool",
  "tool": "example_tool",
  "arguments": {
    "query": "what the user needs"
  }
}
```
