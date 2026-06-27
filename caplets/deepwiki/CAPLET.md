---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: DeepWiki
description: Query repository-focused documentation and codebase explanations through DeepWiki's MCP service.
tags:
  - docs
  - code
  - mcp
mcpServer:
  url: https://mcp.deepwiki.com/mcp
---

# DeepWiki

Use this Caplet when the agent needs repository documentation, architecture explanations, or codebase
context from DeepWiki before making implementation decisions.

## Good Fits

- Research how an unfamiliar open source repository is structured.
- Find documentation-backed explanations for framework, package, or service behavior.
- Cross-check implementation details before modifying code that depends on another project.
- Summarize repository concepts for planning, code review, or onboarding notes.
