# caplets

## 0.17.2

### Patch Changes

- a287e70: Fix local shell completion discovery for downstream tool names and support split `caplets get-tool <caplet> <tool>`, `caplets call-tool <caplet> <tool>`, and `caplets get-prompt <caplet> <prompt>` command forms while preserving existing qualified targets. Preserve the public `CAPLETS_SERVER_URL` origin for remote OAuth callback redirects.
- Updated dependencies [a287e70]
  - @caplets/core@0.18.2

## 0.17.1

### Patch Changes

- da9af23: Bump dependencies to latest
- Updated dependencies [da9af23]
  - @caplets/core@0.18.1

## 0.17.0

### Minor Changes

- b0862be: Add Bash, Zsh, Fish, PowerShell, and cmd shell completion generation plus config-aware and cache-backed downstream completion suggestions for the Caplets CLI.
- 010b07d: Expose MCP resources, resource templates, prompts, and completions through MCP-backed Caplets while keeping non-MCP backend schemas tool-only.

### Patch Changes

- Updated dependencies [b0862be]
- Updated dependencies [010b07d]
  - @caplets/core@0.18.0

## 0.16.0

### Minor Changes

- 30bbc44: Add unified server configuration with `CAPLETS_MODE` and `CAPLETS_SERVER_*`, plus remote CLI control support using service-base URL endpoint derivation for MCP, control, and health routes.

### Patch Changes

- Updated dependencies [30bbc44]
  - @caplets/core@0.17.0

## 0.15.0

### Minor Changes

- 9e3b6c5: Add `caplets serve` transport options, including opt-in Hono Streamable HTTP MCP serving with optional Basic Auth, health/info endpoints, and no-arg help behavior.

### Patch Changes

- 9e3b6c5: Add remote Caplets service support for native integrations, including remote-backed OpenCode and Pi native tools plus documentation for MCP-backed Codex and Claude Code remote connections.
- Updated dependencies [9e3b6c5]
- Updated dependencies [9e3b6c5]
  - @caplets/core@0.16.0

## 0.14.0

### Minor Changes

- 3765837: Improve Caplets agent-facing result metadata and rendering.

  Discovery operations now include Caplet metadata alongside `structuredContent.result`, direct `call_tool` results preserve the downstream shape while adding `_meta.caplets`, compact tool metadata includes stable schema hashes, and browser-style artifact links are surfaced as structured metadata. The Pi integration now renders concise Caplet-aware result summaries with artifact lines and truncated previews.

### Patch Changes

- Updated dependencies [3765837]
- Updated dependencies [3765837]
  - @caplets/core@0.15.0

## 0.13.0

### Minor Changes

- 8a46771: Add direct Caplets CLI operation commands such as `caplets call-tool <caplet.tool> --args '{...}'` and remove the redundant `check_mcp_server` generated operation in favor of `check_backend`.

## 0.12.7

### Patch Changes

- 43127ff: Fix package resolution for native extensions and modernize everything to typescript
- Updated dependencies [43127ff]
  - @caplets/core@0.13.1

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
