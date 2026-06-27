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

Use this Caplet to expose Language Server Protocol capabilities through `language-server-mcp` without handing every language-server operation to an agent up front.

The server runs over stdio, starts local language servers lazily, and gives agents project-aware code intelligence for repositories that have LSP configuration or supported built-in language servers.

Project Binding is required because all useful LSP operations need a trustworthy bound project root for workspace-relative files, language-server startup, diagnostics, and edit containment.

## Good Fits

- Inspect hover/type information before editing unfamiliar code.
- Jump to definitions, declarations, implementations, and type definitions.
- Find references and document/workspace symbols during refactors.
- Read diagnostics from configured language servers before proposing fixes.
- Request formatting, code actions, rename edits, and workspace edits.
- Cross-check code review or planning assumptions with language-server-backed facts.

## Setup

Create a project-level `.lsp-mcp.jsonc` when the defaults are not enough:

```jsonc
{
  "lsp": {
    "servers": {
      "typescript": {
        "registry": "typescript",
      },
    },
  },
}
```

For file-targeted tools, pass absolute or workspace-relative paths that resolve inside the workspace. A typical request includes `workspaceRoot`, `filePath`, `line`, and `character`:

```json
{
  "workspaceRoot": "/absolute/path/to/project",
  "filePath": "/absolute/path/to/project/src/index.ts",
  "line": 3,
  "character": 12
}
```

`serverId` is optional for file-targeted tools. When omitted, `language-server-mcp` runs against configured or built-in servers whose language IDs or file extensions match the file. Add `"serverId": "typescript"` to force a specific server.

Built-in registry IDs include common servers such as `typescript`, `deno`, `eslint`, `json`, `pyright`, `gopls`, `rust`, `svelte`, `vue`, `yaml-ls`, `bash`, `clangd`, `lua-ls`, and `terraform`. Mason and nvim-lspconfig aliases such as `ts_ls`, `denols`, `yamlls`, `bashls`, `rust_analyzer`, and compatibility aliases such as `python`, `go`, and `yaml` are also accepted by the downstream server.

## Safety

`language-server-mcp` defaults to conservative behavior for file modification and process execution:

- Edit-producing tools return edits by default and do not write files unless `apply: true` is passed.
- `apply: true` requires `serverId` when more than one matching LSP server would produce edits.
- Applied edits are restricted to the workspace root unless the downstream server is configured with `security.allowExternalFiles: true`.
- `workspace/executeCommand` is enabled by default, but can be disabled globally or restricted with per-server command allowlists.
- LSP servers start lazily on first use and stop after an idle timeout by default.
- Managed downloads are available only for supported built-ins and can be disabled with `downloads.enabled: false`.

## Examples

Ask for hover information at a symbol:

```json
{
  "workspaceRoot": "/absolute/path/to/project",
  "filePath": "/absolute/path/to/project/src/index.ts",
  "line": 10,
  "character": 18,
  "serverId": "typescript"
}
```

Read diagnostics for a source file:

```json
{
  "workspaceRoot": "/absolute/path/to/project",
  "filePath": "/absolute/path/to/project/src/index.ts"
}
```

Request code actions without applying edits immediately:

```json
{
  "workspaceRoot": "/absolute/path/to/project",
  "filePath": "/absolute/path/to/project/src/index.ts",
  "range": {
    "start": { "line": 12, "character": 0 },
    "end": { "line": 12, "character": 24 }
  },
  "apply": false,
  "serverId": "typescript"
}
```
