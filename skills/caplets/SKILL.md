---
name: caplets
description: Use Caplets for any task that needs external tools, integrations, APIs, docs, repositories, project systems, MCP servers, OpenAPI, GraphQL, HTTP endpoints, or curated CLI commands exposed through Caplets. Invoke this before searching for or calling downstream tools so you can discover capability domains with progressive disclosure instead of loading a flat tool wall.
when_to_use: Trigger when the user asks to use an integration, inspect available tools, call a configured service, query docs, work with GitHub/Linear/Context7 or other installed Caplets, access an MCP/OpenAPI/GraphQL/HTTP backend, run curated repository commands, or when a task appears to need a tool that is not directly visible in the current tool list. Do not use for ordinary local code edits that only need built-in file, shell, or search tools.
---

# Caplets

Use Caplets before searching for or calling downstream tools that may be exposed through configured Caplets backends, including MCP servers, OpenAPI services, GraphQL endpoints, HTTP tools, documentation services, project-management systems, source-control services, or curated CLI commands.

Caplets exposes progressive discovery operations instead of flattening every downstream tool into the agent context. Start with the configured capability domain, inspect only what you need, then call the specific downstream tool.

## Trigger Heuristics

- Use this skill when the user mentions Caplets, configured tools, MCP, OpenAPI, GraphQL, HTTP tools, docs, GitHub, Linear, Context7, project systems, source-control systems, or other installed integration domains.
- Use this skill when the task needs a capability that may exist behind Caplets but is not directly available as a top-level tool.
- Use this skill before broad tool discovery so you can search Caplets capability domains first.
- Skip this skill for normal local code edits, file reads, shell commands, or repository searches that do not need an external or configured Caplets backend.

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
