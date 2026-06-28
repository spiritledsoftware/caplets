---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Context7
description: Fetch current library and framework documentation through Context7 before using version-sensitive APIs.
tags:
  - docs
  - libraries
  - frameworks
  - api-reference
catalog:
  icon: https://context7.com/favicon.ico
mcpServer:
  url: https://mcp.context7.com/mcp/oauth
  auth:
    type: oauth2
---

# Context7

Use this Caplet when the agent needs current library, SDK, framework, CLI, or cloud-service documentation before writing code or giving technical instructions.

## First Workflow

1. Name the package, framework, SDK, or service as specifically as possible.
2. Ask for the current API, config, migration, or example relevant to the task.
3. Cross-check returned guidance against project-local versions, types, and tests before editing code.
4. Cite or summarize only the documentation details needed for the implementation decision.

## Operate Carefully

- Prefer primary docs and version-specific examples over generic snippets when implementation risk is high.
- Do not use documentation lookup as a substitute for reading the local codebase, lockfile, generated types, or failing tests.
- Avoid broad documentation searches when a package name, version, or API symbol is already known.
