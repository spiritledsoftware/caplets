# caplets

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
