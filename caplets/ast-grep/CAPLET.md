---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: ast-grep
description: Search, scan, test, rewrite, and scaffold ast-grep rules through curated MCP tools.
tags:
  - mcp
  - code
  - search
catalog:
  icon: https://ast-grep.github.io/logo.svg
projectBinding:
  required: true
mcpServer:
  command: npx
  args: [-y, ast-grep-mcp@latest]
---

# AST Grep

## Safe Operation

- Project Binding is required because ast-grep reads and may rewrite files in the attached repository.
- Begin with read-only structural searches or scans, and inspect several matches to verify that a pattern selects the intended syntax.
- Test rewrite rules against narrow targets before applying them broadly.
- Treat apply-all rewrites, snapshot updates, and scaffolding as destructive operations. Review the pattern and target scope first.
- Scaffolding is intended for durable ast-grep rules that belong in the project.
