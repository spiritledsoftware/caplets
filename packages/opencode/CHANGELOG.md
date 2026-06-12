# @caplets/opencode

## 0.5.1

### Patch Changes

- e4400d8: Package native Caplets Code Mode assets for OpenCode and cover `caplets__code_mode` registration.
- Updated dependencies [e4400d8]
- Updated dependencies [e4400d8]
- Updated dependencies [e4400d8]
  - @caplets/core@0.20.0

## 0.5.0

### Minor Changes

- e388a49: Make `caplets attach` the remote-backed MCP server command, add Cloud-aware `CAPLETS_MODE` resolution, keep OpenCode and Pi on the shared resolver, and remove Codex/Claude plugin artifacts in favor of manual MCP configuration.

### Patch Changes

- Updated dependencies [e388a49]
  - @caplets/core@0.19.0

## 0.4.9

### Patch Changes

- 9d28137: Add `caplets setup` to install or configure supported agent integrations.
- Updated dependencies [9d28137]
  - @caplets/core@0.18.9

## 0.4.8

### Patch Changes

- 100a9bb: Add landing page and bump dependencies
- Updated dependencies [100a9bb]
  - @caplets/core@0.18.8

## 0.4.7

### Patch Changes

- b33dc00: Render structured Caplets results as lossless Markdown content while preserving canonical structuredContent.
- Updated dependencies [b33dc00]
- Updated dependencies [b33dc00]
  - @caplets/core@0.18.7

## 0.4.6

### Patch Changes

- 7644d07: Update dependencies
- Updated dependencies [7644d07]
  - @caplets/core@0.18.6

## 0.4.5

### Patch Changes

- ffa8a4f: Keep console logs from leaking into native integrations
- Updated dependencies [ffa8a4f]
  - @caplets/core@0.18.5

## 0.4.4

### Patch Changes

- 88c2557: Layer remote mode with user-global and project-local Caplets. Local project Caplets now shadow global and remote Caplets, local overlays load best-effort with warnings, mutation commands support explicit project/global/remote targets, and auth commands require explicit scope when local and remote IDs are ambiguous.
- Updated dependencies [88c2557]
  - @caplets/core@0.18.4

## 0.4.3

### Patch Changes

- Updated dependencies [65914fb]
  - @caplets/core@0.18.3

## 0.4.2

### Patch Changes

- Updated dependencies [a287e70]
  - @caplets/core@0.18.2

## 0.4.1

### Patch Changes

- da9af23: Bump dependencies to latest
- Updated dependencies [da9af23]
  - @caplets/core@0.18.1

## 0.4.0

### Minor Changes

- 010b07d: Expose MCP resources, resource templates, prompts, and completions through MCP-backed Caplets while keeping non-MCP backend schemas tool-only.

### Patch Changes

- Updated dependencies [b0862be]
- Updated dependencies [010b07d]
  - @caplets/core@0.18.0

## 0.3.0

### Minor Changes

- 30bbc44: Add unified server configuration with `CAPLETS_MODE` and `CAPLETS_SERVER_*`, plus remote CLI control support using service-base URL endpoint derivation for MCP, control, and health routes.

### Patch Changes

- Updated dependencies [30bbc44]
  - @caplets/core@0.17.0

## 0.2.0

### Minor Changes

- 9e3b6c5: Add remote Caplets service support for native integrations, including remote-backed OpenCode and Pi native tools plus documentation for MCP-backed Codex and Claude Code remote connections.

### Patch Changes

- Updated dependencies [9e3b6c5]
- Updated dependencies [9e3b6c5]
  - @caplets/core@0.16.0

## 0.1.7

### Patch Changes

- Updated dependencies [3765837]
- Updated dependencies [3765837]
  - @caplets/core@0.15.0

## 0.1.6

### Patch Changes

- 43127ff: Fix package resolution for native extensions and modernize everything to typescript
- Updated dependencies [43127ff]
  - @caplets/core@0.13.1

## 0.1.5

### Patch Changes

- Updated dependencies [c349e62]
  - @caplets/core@0.13.0

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
