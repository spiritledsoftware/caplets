# LSP Registry Caplet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `caplets/lsp` a polished registry Caplet backed by `language-server-mcp`, included in examples, toolkit, tests, and release notes.

**Architecture:** Keep `lsp` as a directory-style MCP Caplet that launches `npx -y language-server-mcp`. Add documentation in the Caplet card and README, include it in the `coding-agent-toolkit` via source symlink, and extend repository example config tests to validate it loads without live MCP startup.

**Tech Stack:** Markdown Caplet frontmatter, Caplets repository example loader, Vitest, pnpm, Changesets.

---

## File Structure

- Modify `caplets/lsp/CAPLET.md`: polished manifest description/tags and complete usage/safety/examples body.
- Create symlink `caplets/coding-agent-toolkit/caplets/lsp -> ../../lsp`: toolkit child pointing to the canonical top-level LSP Caplet.
- Modify `README.md`: add `lsp` to the polished examples list.
- Modify `packages/core/test/config.test.ts`: add `config.mcpServers.lsp` assertion in the existing showcase Caplets test.
- Create `.changeset/lsp-registry-caplet.md`: patch changeset for the user-facing `caplets` package examples/toolkit update.

---

### Task 1: Add failing config coverage for the LSP Caplet

**Files:**

- Modify: `packages/core/test/config.test.ts`
- Test: `packages/core/test/config.test.ts`

- [ ] **Step 1: Write the failing test assertion**

In `packages/core/test/config.test.ts`, find the existing assertion block:

```ts
      expect(config.mcpServers.playwright).toMatchObject({
        server: "playwright",
        name: "Playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp@0.0.75", "--headless"],
      });
      expect(config.capletSets["coding-agent-toolkit"]).toMatchObject({
```

Replace it with:

```ts
      expect(config.mcpServers.playwright).toMatchObject({
        server: "playwright",
        name: "Playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp@0.0.75", "--headless"],
      });
      expect(config.mcpServers.lsp).toMatchObject({
        server: "lsp",
        name: "LSP",
        command: "npx",
        args: ["-y", "language-server-mcp"],
      });
      expect(config.capletSets["coding-agent-toolkit"]).toMatchObject({
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```sh
pnpm --filter @caplets/core test -- test/config.test.ts
```

Expected: FAIL because the current `caplets/lsp/CAPLET.md` manifest name is `lsp`, so `name: "LSP"` does not match yet.

- [ ] **Step 3: Commit failing test**

```sh
git add packages/core/test/config.test.ts
git commit -m "test: cover lsp registry caplet loading"
```

---

### Task 2: Polish the LSP Caplet card

**Files:**

- Modify: `caplets/lsp/CAPLET.md`
- Test: `packages/core/test/config.test.ts`

- [ ] **Step 1: Replace the Caplet card**

Replace the entire contents of `caplets/lsp/CAPLET.md` with:

````markdown
---
# yaml-language-server: $schema=https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplet.schema.json
name: LSP
description: Language Server Protocol tools for project-aware code intelligence through language-server-mcp.
tags:
  - mcp
  - code
  - lsp
  - language-server
  - diagnostics
mcpServer:
  command: npx
  args: [-y, language-server-mcp]
---

# LSP

Use this Caplet to expose Language Server Protocol capabilities through `language-server-mcp` without handing every language-server operation to an agent up front.

The server runs over stdio, starts local language servers lazily, and gives agents project-aware code intelligence for repositories that have LSP configuration or supported built-in language servers.

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
````

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

````

- [ ] **Step 2: Run test to verify it passes**

Run:

```sh
pnpm --filter @caplets/core test -- test/config.test.ts
````

Expected: PASS. The new manifest name is `LSP`, and the backend command remains `npx -y language-server-mcp`.

- [ ] **Step 3: Commit Caplet card**

```sh
git add caplets/lsp/CAPLET.md
git commit -m "docs: polish lsp registry caplet"
```

---

### Task 3: Add LSP to the coding-agent toolkit

**Files:**

- Create symlink: `caplets/coding-agent-toolkit/caplets/lsp -> ../../lsp`
- Test: `packages/core/test/cli.test.ts`
- Test: `packages/core/test/config.test.ts`

- [ ] **Step 1: Create the source-tree symlink**

Run:

```sh
ln -s ../../lsp caplets/coding-agent-toolkit/caplets/lsp
```

Verify:

```sh
readlink caplets/coding-agent-toolkit/caplets/lsp
```

Expected output:

```text
../../lsp
```

- [ ] **Step 2: Run toolkit-related tests**

Run:

```sh
pnpm --filter @caplets/core test -- test/config.test.ts test/cli.test.ts
```

Expected: PASS. Existing CapletSet loading and symlink materialization tests continue to pass with the additional child symlink.

- [ ] **Step 3: Commit toolkit inclusion**

```sh
git add caplets/coding-agent-toolkit/caplets/lsp
git commit -m "docs: add lsp to coding agent toolkit"
```

---

### Task 4: Document LSP in repository examples

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Add README example bullet**

In `README.md`, find:

```markdown
- `sourcegraph`: Cross-repository code search and navigation through Sourcegraph MCP.
- `playwright`: Headless browser automation for frontend inspection and testing through Playwright MCP.
- `coding-agent-toolkit`: A CapletSet that bundles high-value coding-agent examples; source children are symlinks to canonical top-level examples and installed copies are materialized as self-contained files/directories.
```

Replace it with:

```markdown
- `sourcegraph`: Cross-repository code search and navigation through Sourcegraph MCP.
- `playwright`: Headless browser automation for frontend inspection and testing through Playwright MCP.
- `lsp`: Language Server Protocol-backed code intelligence through `language-server-mcp`.
- `coding-agent-toolkit`: A CapletSet that bundles high-value coding-agent examples; source children are symlinks to canonical top-level examples and installed copies are materialized as self-contained files/directories.
```

- [ ] **Step 2: Run docs formatting check**

Run:

```sh
pnpm format:check
```

Expected: PASS.

- [ ] **Step 3: Commit README update**

```sh
git add README.md
git commit -m "docs: list lsp registry example"
```

---

### Task 5: Add changeset and final verification

**Files:**

- Create: `.changeset/lsp-registry-caplet.md`
- Test: repository checks

- [ ] **Step 1: Create changeset**

Create `.changeset/lsp-registry-caplet.md` with:

```markdown
---
"caplets": patch
---

Add a polished LSP registry Caplet backed by `language-server-mcp` and include it in the coding-agent toolkit examples.
```

- [ ] **Step 2: Run focused checks**

Run:

```sh
pnpm --filter @caplets/core test -- test/config.test.ts test/cli.test.ts
pnpm format:check
pnpm lint
```

Expected: all commands PASS.

- [ ] **Step 3: Run full verification**

Run:

```sh
pnpm verify
```

Expected: PASS for formatting, lint, typecheck, schema check, tests, benchmark check, and build.

- [ ] **Step 4: Commit changeset**

```sh
git add .changeset/lsp-registry-caplet.md
git commit -m "chore: add lsp registry caplet changeset"
```

---

## Self-Review Notes

- Spec coverage: the plan expands `caplets/lsp/CAPLET.md`, keeps `npx -y language-server-mcp`, adds setup/safety/examples, updates README, adds toolkit symlink, extends config tests, and creates a changeset.
- Placeholder scan: no placeholder tasks remain; each step includes exact file paths, commands, and expected outcomes.
- Type/signature consistency: expected `config.mcpServers.lsp` fields match the planned frontmatter: `server: "lsp"`, `name: "LSP"`, `command: "npx"`, and `args: ["-y", "language-server-mcp"]`.
