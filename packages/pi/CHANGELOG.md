# @caplets/pi

## 0.9.1

### Patch Changes

- Updated dependencies [bf6930e]
  - @caplets/core@0.28.1

## 0.9.0

### Minor Changes

- 5741c6c: Add opt-out anonymous telemetry controls, privacy-gated event builders, Sentry/PostHog provider adapters, CLI status/debug commands, and stderr-only first-run disclosure for eligible CLI/runtime commands.

### Patch Changes

- Updated dependencies [5741c6c]
- Updated dependencies [0c83a7e]
  - @caplets/core@0.28.0

## 0.8.4

### Patch Changes

- Updated dependencies [907dbd5]
- Updated dependencies [907dbd5]
  - @caplets/core@0.27.0

## 0.8.3

### Patch Changes

- Updated dependencies [16e97de]
- Updated dependencies [16e97de]
- Updated dependencies [16e97de]
  - @caplets/core@0.26.1

## 0.8.2

### Patch Changes

- Updated dependencies [a37e9a9]
  - @caplets/core@0.26.0

## 0.8.1

### Patch Changes

- Updated dependencies [d812d42]
  - @caplets/core@0.25.1

## 0.8.0

### Minor Changes

- d4f76bc: Replace self-hosted remote env-token and Basic Auth setup with unified Remote Login profiles. Remote attach, hosted Cloud, OpenCode, and Pi now resolve Caplets-owned credentials from `caplets remote login <url>` and use `CAPLETS_REMOTE_URL` only as a non-secret selector.

### Patch Changes

- Updated dependencies [d4f76bc]
- Updated dependencies [40f48b4]
- Updated dependencies [d4f76bc]
  - @caplets/core@0.25.0

## 0.7.2

### Patch Changes

- Updated dependencies [473e7b0]
  - @caplets/core@0.24.1

## 0.7.1

### Patch Changes

- 6201153: Expand the Code Mode tool contract with optional `sessionId` reuse, `meta.sessionId` run metadata, and recovery history lookup through `recoveryRef`.

  Sessions are live reuse affordances for iterative Code Mode runs; this does not provide durable heap persistence across host restarts.

  OpenCode now accepts the optional `sessionId` argument on Code Mode tools so agents can reuse live sessions there too.

  Native integrations and remote CLI control now use `CAPLETS_REMOTE_*` exclusively for attach/client behavior. `CAPLETS_SERVER_*` remains reserved for serving/self-hosting configuration.

- Updated dependencies [6201153]
  - @caplets/core@0.24.0

## 0.7.0

### Minor Changes

- efed480: Expand Code Mode with browser-like platform APIs for data manipulation, encoding, timers, crypto randomness, and web object compatibility while keeping direct network and Node APIs unavailable.
- efed480: Add Google Discovery API Caplets with inferred OAuth scopes, operation filters, media upload/download handling, and shared HTTP-like media artifacts.

### Patch Changes

- efed480: Add stdlib to code_mode sandbox
- Updated dependencies [efed480]
- Updated dependencies [efed480]
- Updated dependencies [efed480]
  - @caplets/core@0.23.0

## 0.6.6

### Patch Changes

- Updated dependencies [522ffe0]
  - @caplets/core@0.22.0

## 0.6.5

### Patch Changes

- Updated dependencies [d7942f0]
  - @caplets/core@0.21.1

## 0.6.4

### Patch Changes

- 8f45f5c: Bump dependencies
- Updated dependencies [8f45f5c]
- Updated dependencies [8f45f5c]
- Updated dependencies [8f45f5c]
  - @caplets/core@0.21.0

## 0.6.3

### Patch Changes

- Updated dependencies [aa0bbf8]
  - @caplets/core@0.20.2

## 0.6.2

### Patch Changes

- 8833a75: Refresh expired downstream OAuth/OIDC tokens before calling MCP, OpenAPI, GraphQL, and HTTP backends, persisting rotated credentials when providers return them.
- Updated dependencies [8833a75]
  - @caplets/core@0.20.1

## 0.6.1

### Patch Changes

- Updated dependencies [e4400d8]
- Updated dependencies [e4400d8]
- Updated dependencies [e4400d8]
  - @caplets/core@0.20.0

## 0.6.0

### Minor Changes

- e388a49: Make `caplets attach` the remote-backed MCP server command, add Cloud-aware `CAPLETS_MODE` resolution, keep OpenCode and Pi on the shared resolver, and remove Codex/Claude plugin artifacts in favor of manual MCP configuration.

### Patch Changes

- Updated dependencies [e388a49]
  - @caplets/core@0.19.0

## 0.5.9

### Patch Changes

- 9d28137: Add `caplets setup` to install or configure supported agent integrations.
- Updated dependencies [9d28137]
  - @caplets/core@0.18.9

## 0.5.8

### Patch Changes

- 100a9bb: Add landing page and bump dependencies
- Updated dependencies [100a9bb]
  - @caplets/core@0.18.8

## 0.5.7

### Patch Changes

- b33dc00: Render structured Caplets results as lossless Markdown content while preserving canonical structuredContent.
- Updated dependencies [b33dc00]
- Updated dependencies [b33dc00]
  - @caplets/core@0.18.7

## 0.5.6

### Patch Changes

- 7644d07: Update dependencies
- Updated dependencies [7644d07]
  - @caplets/core@0.18.6

## 0.5.5

### Patch Changes

- ffa8a4f: Keep console logs from leaking into native integrations
- Updated dependencies [ffa8a4f]
  - @caplets/core@0.18.5

## 0.5.4

### Patch Changes

- 88c2557: Layer remote mode with user-global and project-local Caplets. Local project Caplets now shadow global and remote Caplets, local overlays load best-effort with warnings, mutation commands support explicit project/global/remote targets, and auth commands require explicit scope when local and remote IDs are ambiguous.
- Updated dependencies [88c2557]
  - @caplets/core@0.18.4

## 0.5.3

### Patch Changes

- Updated dependencies [65914fb]
  - @caplets/core@0.18.3

## 0.5.2

### Patch Changes

- Updated dependencies [a287e70]
  - @caplets/core@0.18.2

## 0.5.1

### Patch Changes

- da9af23: Bump dependencies to latest
- Updated dependencies [da9af23]
  - @caplets/core@0.18.1

## 0.5.0

### Minor Changes

- 010b07d: Expose MCP resources, resource templates, prompts, and completions through MCP-backed Caplets while keeping non-MCP backend schemas tool-only.

### Patch Changes

- Updated dependencies [b0862be]
- Updated dependencies [010b07d]
  - @caplets/core@0.18.0

## 0.4.1

### Patch Changes

- dd56fd0: Fix pi peer dependency resolution

## 0.4.0

### Minor Changes

- 30bbc44: Add unified server configuration with `CAPLETS_MODE` and `CAPLETS_SERVER_*`, plus remote CLI control support using service-base URL endpoint derivation for MCP, control, and health routes.

### Patch Changes

- Updated dependencies [30bbc44]
  - @caplets/core@0.17.0

## 0.3.0

### Minor Changes

- 9e3b6c5: Add remote Caplets service support for native integrations, including remote-backed OpenCode and Pi native tools plus documentation for MCP-backed Codex and Claude Code remote connections.

### Patch Changes

- Updated dependencies [9e3b6c5]
- Updated dependencies [9e3b6c5]
  - @caplets/core@0.16.0

## 0.2.0

### Minor Changes

- 3765837: Improve Caplets agent-facing result metadata and rendering.

  Discovery operations now include Caplet metadata alongside `structuredContent.result`, direct `call_tool` results preserve the downstream shape while adding `_meta.caplets`, compact tool metadata includes stable schema hashes, and browser-style artifact links are surfaced as structured metadata. The Pi integration now renders concise Caplet-aware result summaries with artifact lines and truncated previews.

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

- 5bfb950: Improve Pi caplet extension registration by using the generated core input schema, declaring the built extension in the package manifest, deferring active-tool synchronization until session start, and adding compact tool call/result rendering.
- Updated dependencies [c349e62]
  - @caplets/core@0.13.0

## 0.1.4

### Patch Changes

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
