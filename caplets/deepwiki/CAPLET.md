---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: DeepWiki
description: Query repository-focused documentation and codebase explanations through DeepWiki's MCP service.
tags:
  - docs
  - code
  - mcp
catalog:
  icon: https://deepwiki.com/favicon.ico
mcpServer:
  url: https://mcp.deepwiki.com/mcp
---

# DeepWiki

## Research guidance

DeepWiki is most useful for a specific repository, subsystem, file, or concept. Focused questions produce more actionable architecture facts, terminology, and code pointers than broad requests about an entire project.

## Verification

DeepWiki provides orientation rather than final proof for code changes. Verify critical claims against source code or official documentation, and re-check version-sensitive details against the current upstream repository when correctness matters.
