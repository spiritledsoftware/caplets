# @caplets/core

## 0.14.0

### Minor Changes

- 8a46771: Add direct Caplets CLI operation commands such as `caplets call-tool <caplet.tool> --args '{...}'` and remove the redundant `check_mcp_server` generated operation in favor of `check_backend`.

## 0.13.1

### Patch Changes

- 43127ff: Fix package resolution for native extensions and modernize everything to typescript

## 0.13.0

### Minor Changes

- c349e62: Add the `capletSets` backend for nested Caplets collections.

## 0.12.2

### Patch Changes

- e9dd9e8: Fix monorepo package entrypoints so the CLI resolves MCP SDK subpaths on Node ESM, reports the CLI package version, and the OpenCode plugin exposes only its default plugin export.

## 0.12.1

### Patch Changes

- 864feaf: Native integrations now share the hot-reload runtime so existing native tools execute against
  the latest valid Caplets config; Pi can register newly added Caplet tools and deactivate stale
  ones at runtime when its active-tool APIs are available.

## 0.12.0

### Minor Changes

- aa7d09d: Split Caplets into a pnpm monorepo with a reusable `@caplets/core` runtime package and keep the existing `caplets` CLI package as the published command-line entrypoint.

  Add native agent integrations for OpenCode and Pi that expose configured Caplets as prefixed native tools while reusing the same Caplets config and backend execution runtime.
