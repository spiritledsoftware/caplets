# caplets

## 0.24.0

### Minor Changes

- 931f18e: Add lockfile-aware Caplet install, restore, and update workflows, including `caplets update`, JSON lifecycle output, remote-global catalog mutations, derived update risk checks, and new public catalog entries for browser, desktop, observability, and Google Workspace integrations.

### Patch Changes

- Updated dependencies [931f18e]
  - @caplets/core@0.30.0

## 0.23.3

### Patch Changes

- 75f4b64: Fix `caplets doctor` Project Binding diagnostics for authenticated self-hosted remotes so supported session routes are reported as supported instead of always unsupported.
- Updated dependencies [75f4b64]
  - @caplets/core@0.29.3

## 0.23.2

### Patch Changes

- d5d776c: Preserve namespace shadowing across stacked attach manifests so re-attached Code Mode handles do not expose duplicate bare Caplet IDs.
- Updated dependencies [d5d776c]
- Updated dependencies [27a9c96]
  - @caplets/core@0.29.2

## 0.23.1

### Patch Changes

- 470c825: Avoid wedging stacked remote execution when attach-session creation stalls, close late attach sessions after a timeout fallback, keep fresh self-hosted profiles from blocking behind refresh locks, report unsupported self-hosted Project Binding sessions clearly in doctor, and suppress unsupported Project Binding session warnings during self-hosted attach negotiation.
- Updated dependencies [470c825]
  - @caplets/core@0.29.1

## 0.23.0

### Minor Changes

- f1a44c5: Add passive available-update detection for the Caplets CLI with cached public npm metadata, stderr-only human-facing notices, update-specific env controls, and strict suppression for protocol and machine-readable output paths.

### Patch Changes

- d5717b9: Keep MCP backend health checks available when a server supports resources but not resource templates.
- cc3d9f4: Keep daemon service descriptors pointed at the stable `caplets` command instead of pnpm's versioned package target so pnpm updates do not strand installed daemons on removed package paths.
- Updated dependencies [f1a44c5]
- Updated dependencies [d5717b9]
- Updated dependencies [cc3d9f4]
  - @caplets/core@0.29.0

## 0.22.1

### Patch Changes

- Updated dependencies [bf6930e]
  - @caplets/core@0.28.1

## 0.22.0

### Minor Changes

- 5741c6c: Add opt-out anonymous telemetry controls, privacy-gated event builders, Sentry/PostHog provider adapters, CLI status/debug commands, and stderr-only first-run disclosure for eligible CLI/runtime commands.
- 0c83a7e: Add stacked remote runtimes with `caplets serve --transport http --upstream-url <url>`, make `caplets attach <url>` stdio-only, and carry per-session project context through attach/native remote sessions.

### Patch Changes

- Updated dependencies [5741c6c]
- Updated dependencies [0c83a7e]
  - @caplets/core@0.28.0

## 0.21.2

### Patch Changes

- 907dbd5: Respect remote Caplet shadowing policy when merging local overlays into remote CLI list output.
- Updated dependencies [907dbd5]
- Updated dependencies [907dbd5]
  - @caplets/core@0.27.0

## 0.21.1

### Patch Changes

- 16e97de: Make `caplets attach <url>` the primary remote attach command while keeping `--remote-url <url>` as a hidden compatibility alias.
- 16e97de: Label hidden CLI prompts without echoing entered secrets, and document the pending self-hosted Remote Login requirements and implementation plan.
- 16e97de: Replace self-hosted Remote Login's operator-minted Pairing Code bootstrap with a client-started pending login flow. The client now starts `caplets remote login <url>`, displays a short operator code, waits for server-local approval, rotates pre-login material while pending, and stores final Remote Profile credentials only after approval. Remote attach recovery now reports revoked self-hosted credentials and Cloud workspace ambiguity with stable recovery guidance, and public docs/examples show the pending-login approval sequence without remote secrets in agent configuration.
- Updated dependencies [16e97de]
- Updated dependencies [16e97de]
- Updated dependencies [16e97de]
  - @caplets/core@0.26.1

## 0.21.0

### Minor Changes

- a37e9a9: Add Caplets Vault for encrypted runtime-owned string values, `$vault:` config interpolation, access grants, CLI management, and GitHub catalog Vault setup.

### Patch Changes

- Updated dependencies [a37e9a9]
  - @caplets/core@0.26.0

## 0.20.1

### Patch Changes

- Updated dependencies [d812d42]
  - @caplets/core@0.25.1

## 0.20.0

### Minor Changes

- d4f76bc: Replace self-hosted remote env-token and Basic Auth setup with unified Remote Login profiles. Remote attach, hosted Cloud, OpenCode, and Pi now resolve Caplets-owned credentials from `caplets remote login <url>` and use `CAPLETS_REMOTE_URL` only as a non-secret selector.

### Patch Changes

- Updated dependencies [d4f76bc]
- Updated dependencies [40f48b4]
- Updated dependencies [d4f76bc]
  - @caplets/core@0.25.0

## 0.19.2

### Patch Changes

- Updated dependencies [473e7b0]
  - @caplets/core@0.24.1

## 0.19.1

### Patch Changes

- 6201153: Expand the Code Mode tool contract with optional `sessionId` reuse, `meta.sessionId` run metadata, and recovery history lookup through `recoveryRef`.

  Sessions are live reuse affordances for iterative Code Mode runs; this does not provide durable heap persistence across host restarts.

  OpenCode now accepts the optional `sessionId` argument on Code Mode tools so agents can reuse live sessions there too.

  Native integrations and remote CLI control now use `CAPLETS_REMOTE_*` exclusively for attach/client behavior. `CAPLETS_SERVER_*` remains reserved for serving/self-hosting configuration.

- Updated dependencies [6201153]
  - @caplets/core@0.24.0

## 0.19.0

### Minor Changes

- efed480: Expand Code Mode with browser-like platform APIs for data manipulation, encoding, timers, crypto randomness, and web object compatibility while keeping direct network and Node APIs unavailable.
- efed480: Add Google Discovery API Caplets with inferred OAuth scopes, operation filters, media upload/download handling, and shared HTTP-like media artifacts.

### Patch Changes

- efed480: Add stdlib to code_mode sandbox
- Updated dependencies [efed480]
- Updated dependencies [efed480]
- Updated dependencies [efed480]
  - @caplets/core@0.23.0

## 0.18.6

### Patch Changes

- Updated dependencies [522ffe0]
  - @caplets/core@0.22.0

## 0.18.5

### Patch Changes

- d7942f0: Preserve the caller's Caplets config paths when running `caplets attach` so local overlay handles come from the intended `CAPLETS_CONFIG` instead of the default user config. Local overlay Code Mode handles now execute locally when attached to a remote service.
- Updated dependencies [d7942f0]
  - @caplets/core@0.21.1

## 0.18.4

### Patch Changes

- 8f45f5c: Bump dependencies
- 8f45f5c: Publish the generated config and Caplet frontmatter schemas from caplets.dev and use those URLs in generated starter files.
- Updated dependencies [8f45f5c]
- Updated dependencies [8f45f5c]
- Updated dependencies [8f45f5c]
  - @caplets/core@0.21.0

## 0.18.3

### Patch Changes

- Updated dependencies [aa0bbf8]
  - @caplets/core@0.20.2

## 0.18.2

### Patch Changes

- 8833a75: Refresh expired downstream OAuth/OIDC tokens before calling MCP, OpenAPI, GraphQL, and HTTP backends, persisting rotated credentials when providers return them.
- Updated dependencies [8833a75]
  - @caplets/core@0.20.1

## 0.18.1

### Patch Changes

- e4400d8: Update `caplets setup` to prompt for integrations when run interactively, and update Codex and Claude Code setup to configure standard MCP servers through each harness instead of removed plugin marketplace commands.
- Updated dependencies [e4400d8]
- Updated dependencies [e4400d8]
- Updated dependencies [e4400d8]
  - @caplets/core@0.20.0

## 0.18.0

### Minor Changes

- e388a49: Make `caplets attach` the remote-backed MCP server command, add Cloud-aware `CAPLETS_MODE` resolution, keep OpenCode and Pi on the shared resolver, and remove Codex/Claude plugin artifacts in favor of manual MCP configuration.

### Patch Changes

- Updated dependencies [e388a49]
  - @caplets/core@0.19.0

## 0.17.9

### Patch Changes

- 9d28137: Add `caplets setup` to install or configure supported agent integrations.
- Updated dependencies [9d28137]
  - @caplets/core@0.18.9

## 0.17.8

### Patch Changes

- 100a9bb: Add landing page and bump dependencies
- Updated dependencies [100a9bb]
  - @caplets/core@0.18.8

## 0.17.7

### Patch Changes

- Updated dependencies [b33dc00]
- Updated dependencies [b33dc00]
  - @caplets/core@0.18.7

## 0.17.6

### Patch Changes

- 7644d07: Update dependencies
- 7644d07: Add a polished LSP registry Caplet backed by `language-server-mcp` and include it in the coding-agent toolkit examples.
- Updated dependencies [7644d07]
  - @caplets/core@0.18.6

## 0.17.5

### Patch Changes

- ffa8a4f: Keep console logs from leaking into native integrations
- Updated dependencies [ffa8a4f]
  - @caplets/core@0.18.5

## 0.17.4

### Patch Changes

- 88c2557: Layer remote mode with user-global and project-local Caplets. Local project Caplets now shadow global and remote Caplets, local overlays load best-effort with warnings, mutation commands support explicit project/global/remote targets, and auth commands require explicit scope when local and remote IDs are ambiguous.
- Updated dependencies [88c2557]
  - @caplets/core@0.18.4

## 0.17.3

### Patch Changes

- 65914fb: Add a coding-agent showcase Caplet set with ast-grep, OSV, npm, PyPI, DeepWiki, Sourcegraph, and Playwright examples.

  Directory Caplet installs now safely materialize internal symlinked children so registry Caplet sets can share canonical source manifests without breaking selected installs. OpenAPI-backed Caplets now support static `Accept` header defaults while continuing to reject caller-supplied managed headers.

- Updated dependencies [65914fb]
  - @caplets/core@0.18.3

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
