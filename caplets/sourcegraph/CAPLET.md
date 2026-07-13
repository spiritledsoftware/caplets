---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: Sourcegraph
description: Search and inspect code across Sourcegraph using its MCP endpoint for repository-aware coding workflows.
avoidWhen: Read the local repository directly when it is available.
tags:
  - sourcegraph
  - code-search
  - mcp
catalog:
  icon: https://sourcegraph.com/.assets/img/sourcegraph-mark.svg
mcpServer:
  url: https://sourcegraph.com/.api/mcp
  auth:
    type: oauth2
---

# Sourcegraph

## Search scope

Build queries around a precise symbol, file path, package name, migration pattern, or repository filter. Inspect representative matches before drawing conclusions across repositories, and retain enough surrounding source context for review.

## Using search evidence

Sourcegraph references and examples can inform local implementation or planning, but they should be verified against the target repository. Results are only as current as the indexed revision.

## Host and privacy boundary

For self-managed Sourcegraph, configure the runtime for the intended host before searching private code. Confirm that the connected instance and repository scope are appropriate for the code being investigated.
