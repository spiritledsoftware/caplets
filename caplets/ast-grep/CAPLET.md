---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: ast-grep
description: Search, scan, test, rewrite, and scaffold ast-grep rules through curated MCP tools.
tags:
  - mcp
  - code
  - search
projectBinding:
  required: true
mcpServer:
  command: npx
  args: [-y, ast-grep-mcp@latest]
---

# AST Grep

Use this Caplet to expose ast-grep's structural search, scan, rule testing, rewrite, and scaffold workflows without giving an agent unrestricted shell access.

The manifest uses the full `ast-grep-mcp` MCP server.

Project Binding is required because ast-grep reads and may rewrite files in the attached repository. The bound root defines the workspace that search and rewrite operations are allowed to target.

## Safety

Read-only search, scan, and normal test actions set `readOnlyHint: true`. Apply-all rewrite, snapshot-update, and scaffolding actions set `destructiveHint: true` because they can modify files.
