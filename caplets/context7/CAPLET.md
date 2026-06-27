---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Context7 Documentation
description: Fetch current library and framework documentation through Context7 before using version-sensitive APIs.
tags:
  - docs
  - libraries
  - frameworks
  - api-reference
mcpServer:
  url: https://mcp.context7.com/mcp/oauth
  auth:
    type: oauth2
---

# Context7 Documentation

Use this Caplet when the agent needs up-to-date library, SDK, framework, CLI, or cloud-service
documentation before writing code or giving technical instructions.

## Good Fits

- Check current API signatures for fast-moving JavaScript, TypeScript, Python, or cloud libraries.
- Look up migration notes before changing framework configuration.
- Retrieve official examples for a specific package version.
- Resolve uncertainty about CLI flags, config files, or SDK initialization.

## Use Carefully

- Prefer primary documentation over snippets when implementation risk is high.
- Record the library or package name clearly before searching.
- Do not use this as a substitute for project-local types and tests.
