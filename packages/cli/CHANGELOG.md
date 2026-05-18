# caplets

## 0.12.6

### Patch Changes

- Updated dependencies [c349e62]
  - @caplets/core@0.13.0

## 0.12.5

### Patch Changes

- a615ee5: Fix Codex plugin marketplace installation by using the supported `plugins/caplets` local plugin source layout with bundled skills and shared MCP config.

## 0.12.4

### Patch Changes

- ddfe906: Refresh the README header, add the Caplets icon artwork, and update plugin metadata with the new icon and brand color.

## 0.12.3

### Patch Changes

- e9dd9e8: Fix monorepo package entrypoints so the CLI resolves MCP SDK subpaths on Node ESM, reports the CLI package version, and the OpenCode plugin exposes only its default plugin export.
- Updated dependencies [e9dd9e8]
  - @caplets/core@0.12.2

## 0.12.2

### Patch Changes

- 6da71be: Add root-level Codex and Claude Code plugin artifacts that package Caplets MCP server configuration and shared agent skill guidance.

## 0.12.1

### Patch Changes

- Updated dependencies [864feaf]
  - @caplets/core@0.12.1

## 0.12.0

### Minor Changes

- aa7d09d: Split Caplets into a pnpm monorepo with a reusable `@caplets/core` runtime package and keep the existing `caplets` CLI package as the published command-line entrypoint.

  Add native agent integrations for OpenCode and Pi that expose configured Caplets as prefixed native tools while reusing the same Caplets config and backend execution runtime.

### Patch Changes

- Updated dependencies [aa7d09d]
  - @caplets/core@0.12.0
