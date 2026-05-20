---
name: caplets
description: Use Caplets to discover and call configured external tools through progressive disclosure before using downstream MCP, API, or CLI capabilities.
when_to_use: Trigger when the user asks to use an integration, inspect available tools, call a configured service, query external information, access an MCP/OpenAPI/GraphQL/HTTP backend, run curated repository commands, or use a capability that may not appear as a direct top-level tool. Do not use for ordinary local code edits that only need built-in file, shell, or search tools.
---

# Caplets

Use Caplets before searching for or calling downstream tools exposed through configured Caplets backends, including MCP servers, OpenAPI services, GraphQL endpoints, HTTP endpoints, external information services, project systems, source-control systems, or curated CLI commands.

Caplets exposes progressive discovery operations instead of flattening every downstream tool into the agent context. Start with the configured capability domain, inspect only what you need, then call the specific downstream tool.

## Trigger Heuristics

- Use this skill when the user mentions Caplets, configured tools, MCP, OpenAPI, GraphQL, HTTP tools, external information, project systems, source-control systems, or other installed integration domains.
- Use this skill when the task needs a capability that may exist behind Caplets but is not directly available as a top-level tool.
- Use this skill before broad tool discovery so you can search Caplets capability domains first.
- Skip this skill for normal local code edits, file reads, shell commands, or repository searches that do not need an external or configured Caplets backend.

## Workflow

1. Read the caplet card with `get_caplet` when you need to understand what a configured Caplet provides.
2. Check backend availability with `check_backend` or the equivalent operation before relying on a backend.
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
- When Caplets is configured as a remote MCP HTTP service, treat connection/auth failures as remote-service issues and ask the user to verify `CAPLETS_SERVER_URL`, Basic Auth credentials, and that `caplets serve --transport http` is running.

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
