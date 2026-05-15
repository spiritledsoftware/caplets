# @caplets/opencode

## 0.1.4

### Patch Changes

- e9dd9e8: Fix monorepo package entrypoints so the CLI resolves MCP SDK subpaths on Node ESM, reports the CLI package version, and the OpenCode plugin exposes only its default plugin export.
- Updated dependencies [e9dd9e8]
  - @caplets/core@0.12.2

## 0.1.3

### Patch Changes

- 864feaf: Native integrations now share the hot-reload runtime so existing native tools execute against
  the latest valid Caplets config; Pi can register newly added Caplet tools and deactivate stale
  ones at runtime when its active-tool APIs are available.
- Updated dependencies [864feaf]
  - @caplets/core@0.12.1

## 0.1.2

### Patch Changes

- fac459f: Add repository metadata required for npm trusted publishing.

## 0.1.1

### Patch Changes

- 4988e28: Fix npm publishing for public scoped integration packages.

## 0.1.0

### Minor Changes

- aa7d09d: Split Caplets into a pnpm monorepo with a reusable `@caplets/core` runtime package and keep the existing `caplets` CLI package as the published command-line entrypoint.

  Add native agent integrations for OpenCode and Pi that expose configured Caplets as prefixed native tools while reusing the same Caplets config and backend execution runtime.

### Patch Changes

- Updated dependencies [aa7d09d]
  - @caplets/core@0.12.0
