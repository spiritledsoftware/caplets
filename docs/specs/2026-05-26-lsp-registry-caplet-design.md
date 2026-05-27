# LSP Registry Caplet Design

## Goal

Make `caplets/lsp` a polished, first-class registry example that wraps `language-server-mcp` through Caplets' MCP backend and is discoverable in the repository examples, tests, and coding-agent toolkit.

## Context

The repository already has `caplets/lsp/CAPLET.md` with a valid minimal MCP manifest:

```yaml
name: lsp
description: Language Server Protocol
tags:
  - mcp
  - code
  - lsp
mcpServer:
  command: npx
  args: [-y, language-server-mcp]
```

The published `language-server-mcp` package exposes LSP capabilities over stdio, starts local language servers lazily, and supports tools such as hover, definitions, references, diagnostics, symbols, formatting, code actions, and workspace edits.

## Scope

In scope:

- Expand `caplets/lsp/CAPLET.md` from a stub into a polished Caplet card.
- Keep the backend as `npx -y language-server-mcp`.
- Improve the manifest description and tags for search and discovery.
- Add usage guidance for project configuration, server selection, file-targeted inputs, and safety defaults.
- Add `lsp` to the README example list.
- Add `lsp` to the `coding-agent-toolkit` CapletSet via a symlink to the canonical top-level example.
- Extend repository example tests so `lsp` is loaded and validated with the other showcase Caplets.
- Add a changeset for the user-facing registry/example update.

Out of scope:

- Creating a new `@caplets/lsp` package in the monorepo.
- Implementing new LSP functionality inside Caplets core.
- Replacing `language-server-mcp` or forking its tool surface.
- Adding project-specific `.lsp-mcp.jsonc` files to this repository.

## Architecture

`caplets/lsp` remains a directory-style Markdown Caplet with a single MCP backend. Caplets launches `language-server-mcp` over stdio with `npx`, then exposes it through the same progressive MCP operations as other MCP-backed Caplets: `check_backend`, `list_tools`, `search_tools`, `get_tool`, `call_tool`, resources, prompts, templates, and completion when supported by the downstream server.

The `coding-agent-toolkit` entry should include `lsp` as a source-tree symlink under `caplets/coding-agent-toolkit/caplets/lsp`. Existing install behavior materializes symlinked child Caplets as self-contained files/directories, so installed toolkit copies should not depend on the source repository symlink layout.

## Caplet content design

The `CAPLET.md` body should include these sections:

1. **Overview** — explain that the Caplet gives agents project-aware language intelligence through LSP without exposing every LSP tool directly up front.
2. **Good Fits** — hover/type info, go-to definition/declaration/implementation, references, diagnostics, symbols, formatting, code actions, rename/workspace edits, and language-server-backed code review/planning.
3. **Setup** — describe `.lsp-mcp.jsonc`, built-in registry IDs and aliases, optional `serverId`, `workspaceRoot`, `filePath`, `line`, and `character` inputs.
4. **Safety** — document edit-producing tools returning edits by default, explicit `apply: true`, workspace-root restrictions, multi-server `serverId` requirements for applied edits, `workspace/executeCommand` controls, lazy startup, idle shutdown, and managed download controls.
5. **Examples** — include concise JSON examples for hover and diagnostics/code actions that show the expected path-based inputs without hardcoding this repository's absolute paths.

## README design

Add `lsp` to the polished working examples list near the other code-focused MCP examples. The entry should make clear that it wraps `language-server-mcp` for LSP-backed code intelligence.

## Test design

Extend the existing showcase Caplets test in `packages/core/test/config.test.ts` so it asserts `config.mcpServers.lsp` loads with:

- `server: "lsp"`
- `name: "LSP"` or another intentionally chosen display name from the manifest
- `command: "npx"`
- `args: ["-y", "language-server-mcp"]`

The existing `validateCapletFile` and reference-file tests should continue to validate the expanded Caplet automatically. No network or live LSP server startup should be required for this test; it should only validate config loading from repository Caplet files.

## Release notes

Add a changeset for `caplets` because this changes the user-facing registry examples and the installable toolkit contents. The changeset should describe the new polished LSP example and toolkit inclusion.

## Risks and mitigations

- **Risk: users expect a package named `@caplets/lsp`.** Mitigation: documentation should describe this as a registry Caplet wrapping `language-server-mcp`, not as a monorepo package.
- **Risk: live LSP behavior depends on project configuration and installed language servers.** Mitigation: setup docs should point users to `.lsp-mcp.jsonc`, built-ins, aliases, and managed-download controls.
- **Risk: edit-producing tools can modify files.** Mitigation: safety docs must clearly state default return-edits behavior and the explicit requirements for applying edits.
- **Risk: toolkit symlink breaks installation.** Mitigation: rely on existing symlink materialization behavior and keep the symlink inside the `caplets/coding-agent-toolkit/caplets` tree.

## Verification

Run focused checks after implementation:

```sh
pnpm --filter @caplets/core test -- test/config.test.ts
pnpm format:check
pnpm lint
```

Run the full repository gate if focused checks pass:

```sh
pnpm verify
```
