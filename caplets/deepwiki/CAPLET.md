---
# yaml-language-server: $schema=https://caplets.dev/caplet-frontmatter.schema.json
name: DeepWiki
description: Query repository-focused documentation and codebase explanations through DeepWiki's MCP service.
tags:
  - docs
  - code
  - mcp
mcpServer:
  transport: http
  url: https://mcp.deepwiki.com/mcp
  auth:
    type: none
---

# DeepWiki

Use this Caplet when the agent needs repository documentation, architecture explanations, or codebase
context from DeepWiki before making implementation decisions.

## Good Fits

- Research how an unfamiliar open source repository is structured.
- Find documentation-backed explanations for framework, package, or service behavior.
- Cross-check implementation details before modifying code that depends on another project.
- Summarize repository concepts for planning, code review, or onboarding notes.

## Setup

This Caplet uses the hosted DeepWiki MCP endpoint at `https://mcp.deepwiki.com/mcp` with no
configured authentication. Hosted endpoint availability may depend on DeepWiki's current MCP service.
