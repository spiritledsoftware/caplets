# @caplets/core

## 0.24.1

### Patch Changes

- 473e7b0: Keep local overlay startup alive when a Caplet references a missing environment variable by skipping only the affected Caplet and warning with the missing variable and config path.

## 0.24.0

### Minor Changes

- 6201153: Expand the Code Mode tool contract with optional `sessionId` reuse, `meta.sessionId` run metadata, and recovery history lookup through `recoveryRef`.

  Sessions are live reuse affordances for iterative Code Mode runs; this does not provide durable heap persistence across host restarts.

  OpenCode now accepts the optional `sessionId` argument on Code Mode tools so agents can reuse live sessions there too.

  Native integrations and remote CLI control now use `CAPLETS_REMOTE_*` exclusively for attach/client behavior. `CAPLETS_SERVER_*` remains reserved for serving/self-hosting configuration.

## 0.23.0

### Minor Changes

- efed480: Expand Code Mode with browser-like platform APIs for data manipulation, encoding, timers, crypto randomness, and web object compatibility while keeping direct network and Node APIs unavailable.
- efed480: Add Google Discovery API Caplets with inferred OAuth scopes, operation filters, media upload/download handling, and shared HTTP-like media artifacts.
- efed480: Add stdlib to code_mode sandbox

## 0.22.0

### Minor Changes

- 522ffe0: Add remote attach URL configuration and update the native remote attach flow.

## 0.21.1

### Patch Changes

- d7942f0: Preserve the caller's Caplets config paths when running `caplets attach` so local overlay handles come from the intended `CAPLETS_CONFIG` instead of the default user config. Local overlay Code Mode handles now execute locally when attached to a remote service.

## 0.21.0

### Minor Changes

- 8f45f5c: Bump dependencies
- 8f45f5c: Replace unversioned self-hosted HTTP routes with the `/v1` service surface and add the Caplets attach manifest/invoke API for native and attach clients.

### Patch Changes

- 8f45f5c: Publish the generated config and Caplet frontmatter schemas from caplets.dev and use those URLs in generated starter files.

## 0.20.2

### Patch Changes

- aa0bbf8: Fix oauth and oidc state handling. Fix remote server allowed hosts.

## 0.20.1

### Patch Changes

- 8833a75: Refresh expired downstream OAuth/OIDC tokens before calling MCP, OpenAPI, GraphQL, and HTTP backends, persisting rotated credentials when providers return them.

## 0.20.0

### Minor Changes

- e4400d8: Make Code Mode the default Caplets exposure mode. Configs that omit `options.exposure` now expose `code_mode` by default; progressive wrapper tools remain available by setting `options.exposure` to `progressive` or `progressive_and_code_mode`.

### Patch Changes

- e4400d8: Update `caplets setup` to prompt for integrations when run interactively, and update Codex and Claude Code setup to configure standard MCP servers through each harness instead of removed plugin marketplace commands.
- e4400d8: Publish the expanded Core package surface needed by hosted Cloud and native agent
  integrations, including Code Mode entrypoints, observed output shape utilities,
  project binding exports, redaction/stable JSON helpers, runtime-plan resource
  helpers, native `caplets__<capletId>` / `caplets__code_mode` tool naming, and
  cloud attach URL normalization.

## 0.19.0

### Minor Changes

- e388a49: Make `caplets attach` the remote-backed MCP server command, add Cloud-aware `CAPLETS_MODE` resolution, keep OpenCode and Pi on the shared resolver, and remove Codex/Claude plugin artifacts in favor of manual MCP configuration.

## 0.18.9

### Patch Changes

- 9d28137: Add `caplets setup` to install or configure supported agent integrations.

## 0.18.8

### Patch Changes

- 100a9bb: Add landing page and bump dependencies

## 0.18.7

### Patch Changes

- b33dc00: Fix missing http response body in tool result content
- b33dc00: Render structured Caplets results as lossless Markdown content while preserving canonical structuredContent.

## 0.18.6

### Patch Changes

- 7644d07: Update dependencies

## 0.18.5

### Patch Changes

- ffa8a4f: Keep console logs from leaking into native integrations

## 0.18.4

### Patch Changes

- 88c2557: Layer remote mode with user-global and project-local Caplets. Local project Caplets now shadow global and remote Caplets, local overlays load best-effort with warnings, mutation commands support explicit project/global/remote targets, and auth commands require explicit scope when local and remote IDs are ambiguous.

## 0.18.3

### Patch Changes

- 65914fb: Add a coding-agent showcase Caplet set with ast-grep, OSV, npm, PyPI, DeepWiki, Sourcegraph, and Playwright examples.

  Directory Caplet installs now safely materialize internal symlinked children so registry Caplet sets can share canonical source manifests without breaking selected installs. OpenAPI-backed Caplets now support static `Accept` header defaults while continuing to reject caller-supplied managed headers.

## 0.18.2

### Patch Changes

- a287e70: Fix local shell completion discovery for downstream tool names and support split `caplets get-tool <caplet> <tool>`, `caplets call-tool <caplet> <tool>`, and `caplets get-prompt <caplet> <prompt>` command forms while preserving existing qualified targets. Preserve the public `CAPLETS_SERVER_URL` origin for remote OAuth callback redirects.

## 0.18.1

### Patch Changes

- da9af23: Bump dependencies to latest

## 0.18.0

### Minor Changes

- b0862be: Add Bash, Zsh, Fish, PowerShell, and cmd shell completion generation plus config-aware and cache-backed downstream completion suggestions for the Caplets CLI.
- 010b07d: Expose MCP resources, resource templates, prompts, and completions through MCP-backed Caplets while keeping non-MCP backend schemas tool-only.

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
