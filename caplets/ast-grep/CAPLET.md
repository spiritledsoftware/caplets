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

Use this Caplet when lexical search is too weak and the agent needs syntax-aware code search, rule testing, or controlled rewrites inside the bound repository.

## First Workflow

1. Start with read-only structural search or scan operations to prove the pattern matches the intended syntax.
2. Inspect several matches before proposing a rewrite rule.
3. Test rewrite rules against narrow targets before applying them broadly.
4. Use scaffold operations only when the user wants durable ast-grep rules added to the project.

## Operate Carefully

- Project Binding is required because ast-grep reads and may rewrite files in the attached repository.
- Treat apply-all rewrites, snapshot updates, and scaffolding as destructive; show the intended pattern and target scope before using them.
- Prefer ordinary text search or LSP when the task is about names, references, or type information rather than syntax structure.
