---
# yaml-language-server: $schema=https://caplets.dev/caplet.schema.json
name: LSP
description: Language Server Protocol tools for project-aware code intelligence through language-server-mcp.
tags:
  - mcp
  - code
  - lsp
  - language-server
  - diagnostics
projectBinding:
  required: true
mcpServer:
  command: npx
  args: [-y, language-server-mcp@latest]
---

# LSP

## Inspection and Edits

Diagnostics, hover or type information, and definition lookup provide a focused starting point for a specific file and symbol. References and symbols show the blast radius of a refactor. Code actions, formatting, and rename operations can be reviewed as proposed edits before application, with source and tests used to validate behavior-sensitive conclusions.

## Project Context

Project Binding is required. LSP operations depend on a trustworthy bound project root for workspace-relative files, language-server startup, diagnostics, and edit containment.

File-targeted paths must resolve inside the bound workspace. A `serverId` disambiguates files handled by multiple language servers and is required for some applied edits.

## Safe Operation and Lifecycle

`language-server-mcp` uses conservative defaults for file modification and process execution:

- Edit-producing tools return edits without writing unless `apply: true` is supplied.
- When multiple matching LSP servers could produce edits, `apply: true` also requires `serverId`.
- Applied edits remain inside the workspace root unless the downstream server enables `security.allowExternalFiles: true`.
- `workspace/executeCommand` is enabled by default. Operators can disable it globally or restrict it with per-server command allowlists.
- LSP servers start lazily on first use and stop after an idle timeout by default.
