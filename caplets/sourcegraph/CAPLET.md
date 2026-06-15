---
# yaml-language-server: $schema=https://caplets.dev/caplet-frontmatter.schema.json
name: Sourcegraph
description: Search and inspect code across Sourcegraph using its MCP endpoint for repository-aware coding workflows.
tags:
  - sourcegraph
  - code-search
  - mcp
mcpServer:
  transport: http
  url: https://sourcegraph.com/.api/mcp
  auth:
    type: oauth2
---

# Sourcegraph

Use this Caplet when the agent needs broad code search, repository navigation, or cross-repository
context from Sourcegraph.

## Good Fits

- Find examples of an API, class, or migration pattern across indexed repositories.
- Trace references before changing shared interfaces.
- Compare implementations across services or packages.
- Gather code-search evidence for debugging, review, or planning.

## Setup

This Caplet targets Sourcegraph Cloud at `https://sourcegraph.com/.api/mcp` and uses OAuth.

Self-managed Sourcegraph users should change the URL to
`https://<sourcegraph-host>/.api/mcp`. OAuth/DCR support or access-token headers depend on the
instance setup, so configure authentication to match your deployment.
