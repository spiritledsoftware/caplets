---
# yaml-language-server: $schema=https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplet.schema.json
name: ast-grep
description: Search, scan, test, rewrite, and scaffold ast-grep rules through curated MCP tools.
tags:
  - mcp
  - code
  - search
mcpServer:
  command: npx
  args: [-y, ast-grep-mcp]
---

# ast-grep MCP

Use this Caplet to expose ast-grep's structural search, scan, rule testing, rewrite, and scaffold workflows without giving an agent unrestricted shell access.

The manifest uses the full `ast-grep-mcp` MCP server.

## Safety

Read-only search, scan, and normal test actions set `readOnlyHint: true`. Apply-all rewrite, snapshot-update, and scaffolding actions set `destructiveHint: true` because they can modify files.
