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

Use this Caplet when the agent needs repository-level explanations or architecture context for an unfamiliar codebase before making implementation decisions.

## First Workflow

1. Ask about a specific repository, subsystem, file, or concept rather than the whole project.
2. Use DeepWiki to build orientation, then verify critical claims against source code or official docs.
3. Bring back concise architecture facts, terminology, and code pointers that affect the task.

## Operate Carefully

- Treat DeepWiki as a research and orientation source, not final proof for code changes.
- Do not use it when the local repository is already available and direct code search or tests can answer the question.
- Re-check version-sensitive details against the current upstream repository when correctness matters.
