---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Sourcegraph
description: Search and inspect code across Sourcegraph using its MCP endpoint for repository-aware coding workflows.
tags:
  - sourcegraph
  - code-search
  - mcp
catalog:
  icon: https://sourcegraph.com/favicon.ico
mcpServer:
  url: https://sourcegraph.com/.api/mcp
  auth:
    type: oauth2
---

# Sourcegraph

Use this Caplet when the agent needs broad code search, repository navigation, or cross-repository context from Sourcegraph.

## First Workflow

1. Start with a precise symbol, file path, package name, migration pattern, or repository filter.
2. Inspect representative matches before generalizing across repositories.
3. Use references and examples to guide local implementation, then verify against the target repo.
4. Bring back code-search evidence with enough source context for review or planning.

## Operate Carefully

- Sourcegraph answers are only as current as the indexed repositories.
- Do not use broad search as a substitute for reading the local repository when it is available.
- For self-managed Sourcegraph, make sure the runtime is pointed at the intended host before using private code search.
