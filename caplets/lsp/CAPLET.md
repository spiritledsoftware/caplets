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

Use this Caplet when the agent needs project-aware code intelligence from language servers: definitions, references, diagnostics, hover/type information, symbols, formatting, code actions, or rename edits.

## First Workflow

1. Start with diagnostics, hover/type information, or definition lookup for the exact file and symbol involved.
2. Use references and symbols to understand blast radius before refactoring.
3. Request code actions, formatting, or rename edits as proposals first; apply edits only when the target server and file scope are clear.
4. Cross-check language-server results against tests and source when the answer affects behavior.

## Project Context

Project Binding is required because all useful LSP operations need a trustworthy bound project root for workspace-relative files, language-server startup, diagnostics, and edit containment.

For file-targeted tools, use paths that resolve inside the bound workspace. Include a `serverId` when more than one language server could handle the file or when applying edits.

## Operate Carefully

`language-server-mcp` defaults to conservative behavior for file modification and process execution:

- Edit-producing tools return edits by default and do not write files unless `apply: true` is passed.
- `apply: true` requires `serverId` when more than one matching LSP server would produce edits.
- Applied edits are restricted to the workspace root unless the downstream server is configured with `security.allowExternalFiles: true`.
- `workspace/executeCommand` is enabled by default, but can be disabled globally or restricted with per-server command allowlists.
- LSP servers start lazily on first use and stop after an idle timeout by default.
- Prefer ast-grep or text search for syntax-pattern searches that do not need language-server semantics.
