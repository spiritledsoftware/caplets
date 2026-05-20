# @caplets/core

## 0.17.0

### Minor Changes

- 30bbc44: Add unified server configuration with `CAPLETS_MODE` and `CAPLETS_SERVER_*`, plus remote CLI control support using service-base URL endpoint derivation for MCP, control, and health routes.

## 0.16.0

### Minor Changes

- 9e3b6c5: Add `caplets serve` transport options, including opt-in Hono Streamable HTTP MCP serving with optional Basic Auth, health/info endpoints, and no-arg help behavior.
- 9e3b6c5: Add remote Caplets service support for native integrations, including remote-backed OpenCode and Pi native tools plus documentation for MCP-backed Codex and Claude Code remote connections.

## 0.15.0

### Minor Changes

- 3765837: Improve Caplets agent-facing result metadata and rendering.

  Discovery operations now include Caplet metadata alongside `structuredContent.result`, direct `call_tool` results preserve the downstream shape while adding `_meta.caplets`, compact tool metadata includes stable schema hashes, and browser-style artifact links are surfaced as structured metadata. The Pi integration now renders concise Caplet-aware result summaries with artifact lines and truncated previews.

### Patch Changes

- 3765837: Build and publish TypeScript declaration files for core package consumers.

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
