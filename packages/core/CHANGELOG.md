# @caplets/core

## 0.38.0

### Minor Changes

- f5c4808: Support Bun 1.3.14 and newer as a Caplets process runtime while retaining Node.js 22 and newer as the default runtime. Use a cross-runtime asynchronous SQLite adapter, runtime-native HTTP and telemetry integrations, and release-blocking Node and Bun verification matrices.

### Patch Changes

- Updated dependencies [f5c4808]
  - @caplets/sdk@0.1.1

## 0.37.1

### Patch Changes

- 52cbc75: Resolve Vault grant targets from config and Caplet File sources, quarantine static Caplets with unresolved Vault references instead of blocking Host startup, and accept canonical-equivalent Caplets roots.

## 0.37.0

### Minor Changes

- 99396ff: Add the resource-oriented Current Host Admin API, public OpenAPI 3.1 document, and generated Fetch client. Launch `@caplets/sdk` 0.1.0 with ordered streaming bundle helpers and the browser-safe Project Binding coordinator. Model each Current Host as an HTTP(S) origin with fixed `/.well-known/caplets`, `/api`, `/mcp`, and `/dashboard` namespaces; require origin-only configuration; move public HTTP and Admin resources under `/api`; and remove path-prefix serving, the v1 Admin transport, legacy Caplets Cloud/hosted modes, route fallbacks, and JSON/base64 bundle transfer. Preserve exclusive bearer-or-dashboard-session authorization, CSRF protection, root-path dashboard cookie migration, durable backend OAuth flows, and atomic SQL-backed administration across Host Nodes.

### Patch Changes

- 99396ff: Commit SQL Vault value writes, optional access grants, one intent activity record, and one config generation atomically before activating the updated Host configuration.
- 99396ff: Bound non-MCP HTTP JSON request bodies and return `REQUEST_INVALID` for oversized input. MCP request parsing remains owned by the MCP SDK transport.
- 99396ff: Fix dashboard mutation refresh ordering so rejected work cannot suppress successful state, pending revokes cannot expose stale client data, and the latest successful completion controls the rendered Current Host data.
- 99396ff: Persist encrypted backend OAuth completion state in Authoritative Host Storage so callbacks can complete safely across Host Nodes.
- 99396ff: Cap Code Mode execution timeout requests at 120 seconds across MCP, native, CLI, remote, and direct library calls. Split longer work into bounded Code Mode calls.
- Updated dependencies [99396ff]
  - @caplets/sdk@0.1.0

## 0.36.2

### Patch Changes

- 10bb0c2: Persist top-level `let`, `const`, class, enum, namespace, and TypeScript declarations across reused Code Mode sessions with REPL-style redeclaration and failed-cell behavior.
- b57e0e4: Keep Code Mode diagnostics and sandbox transpilation working while the workspace compiles with TypeScript 7.

## 0.36.1

### Patch Changes

- b620ec5: **Required upgrade migration:** Hosts that ran `caplets@0.25.x` or earlier must stop every Caplets Host Node and run `caplets storage migrate-legacy --dry-run`, then `caplets storage migrate-legacy`, before restarting the daemon, running `caplets setup`, or serving requests. The migration now imports standard legacy auth, Vault, remote security, setup, Operator Activity, and tracked-Caplet state; preserves file-layer Vault grants and shared Vault key access; uses platform paths by default; and reports actionable missing tracked entries.

## 0.36.0

### Minor Changes

- 7dbfb74: Add authoritative SQLite and PostgreSQL host storage, relational Caplet Records with Markdown import/export, and SQL-backed host administration across CLI, HTTP, and remote-control surfaces.

  **Migration required for `caplets` CLI users:** Hosts that ran `caplets@0.25.x` or
  earlier must stop every Caplets Host Node and run
  `caplets storage migrate-legacy --dry-run`, then `caplets storage migrate-legacy`,
  before restarting. The SQL-backed runtime does not fall back to legacy Authoritative
  Host State.

## 0.35.0

### Minor Changes

- b165ac0: Make Caplet YAML frontmatter the sole runtime configuration contract while preserving the Markdown body as operator-facing README content for catalog rendering. Remove `body` from the exported runtime configuration types and backend projections, add semantic runtime fingerprints and no-op reload gating, and classify trusted README-only install changes as `content_updated` without setup approval or runtime churn.

  **Migration required:** `useWhen` and `avoidWhen` have been removed from Caplet and configured-action schemas. Move concise agent-facing capability context into `description`; move operator-only prerequisites, safety guidance, troubleshooting, and references into the Markdown body. Existing configuration that still declares either removed field is rejected.

## 0.34.1

### Patch Changes

- c466a18: Source the built-in dashboard catalog from the authenticated catalog API, load and search the complete compact index without the former result ceiling, and expose dedicated catalog detail routes with window-virtualized results. Revalidate catalog entries before typed-confirmation installs, keep missing or unreadable entries non-installable, remove the redundant source card and legacy in-page inspector, and isolate test lockfiles from the user's global Caplets state.

## 0.34.0

### Minor Changes

- 870a599: Unify HTTP-like non-inline results behind explicit local-artifact and remote-reference variants, preserve mixed MCP content blocks, and prevent hosted Adapters from exposing managed filesystem paths.

  GraphQL operation results now share the Media pipeline with a 1 MiB inline threshold and a 100 MiB artifact cap. Pi renders local artifact paths and remote artifact references according to the result variant.

  Replace `handleServerTool`'s positional manager arguments with a named backend runtime. External `@caplets/core` callers now construct that runtime with `createBackendOperationRuntime`; common backend operations dispatch through its `operations` Interface, while MCP-only resource, prompt, and completion methods remain on `runtime.mcp`.

  Make exposure projection the generation-bound callable-surface authority. MCP, Attach, and native adapters now render registration facts and Code Mode identities from the same projection, reject stale callbacks across reloads, discard out-of-order discovery, and keep hidden or unresolved Caplets out of declarations and execution allowlists.

  Concentrate Current Host administration behind one typed operations Interface shared by dashboard and Operator bearer adapters. Operator activity now records the real acting Client, exact Access and Operator route roles are enforced, both Client roles can revoke only their own credential, and self-revocation or demotion ends the acting dashboard session. Raw Vault Reveal remains dashboard-only and expires from browser memory.

  Give native Cloud and self-hosted Project Binding one lifecycle owner for accepted Caplet IDs, serialized updates, cleanup-last close, and atomic remote replacement while preserving their distinct failure policies. Self-hosted sockets now reauthorize durable Access Clients at execution time and serialize heartbeat, expiry, prune, end, and shutdown state so stale work cannot revive a terminal lease.

## 0.33.0

### Minor Changes

- 11c3710: Add the self-hosted Caplets Admin Dashboard with Operator Client sessions, role-gated admin routes, dashboard access/catalog/Vault/runtime APIs, redacted operator activity logging, and a static dashboard UI shell.

## 0.32.4

### Patch Changes

- 15e467e: Fix the published CLI startup path by externalizing jsonc-parser from the Node bundle and checking the built package can answer `caplets --version`.

## 0.32.3

### Patch Changes

- Support `caplets doctor --format json`, `--format md`, and `--format plain`.

## 0.32.2

### Patch Changes

- 1ecb13b: Centralize Caplets exposure projection rendering across attach, native, remote, and MCP surfaces.

## 0.32.1

### Patch Changes

- 73cc952: Promote daemon-first local setup. `caplets setup` now initializes config, starts or reuses the local daemon, verifies health before mutating integrations, and configures MCP clients as thin `caplets attach <local-daemon-url>` clients through the pinned `add-mcp` adapter.

  Add explicit native daemon mode and setup-written daemon defaults for OpenCode and Pi, while keeping remote/cloud setup on Remote Login and secret-free attach paths.

- 73cc952: Add top-level user `serve` config defaults for HTTP Caplets serving. Foreground `caplets serve --transport http` and daemon restarts can now reuse configured host, port, path, upstream URL, remote state path, public origins, proxy trust, and unauthenticated HTTP intent while project config ignores `serve` for security.

## 0.32.0

### Minor Changes

- b371d0b: Add multi-backend Markdown Caplet files that expand plural backend maps into parent-scoped runtime child handles.

## 0.31.1

### Patch Changes

- e517938: Add privacy-gated anonymous telemetry, Sentry source-map uploads for runtime packages, and observability wiring for the public sites.

## 0.31.0

### Minor Changes

- 988edbb: Add optional `catalog.icon` metadata to Caplet files and catalog entries so catalog surfaces can show provider icons.
- 988edbb: Add shared catalog primitives, official catalog generation, public catalog indexing statuses,
  and install-time Vault setup recovery metadata for Caplets install/update flows.

## 0.30.0

### Minor Changes

- 931f18e: Add lockfile-aware Caplet install, restore, and update workflows, including `caplets update`, JSON lifecycle output, remote-global catalog mutations, derived update risk checks, and new public catalog entries for browser, desktop, observability, and Google Workspace integrations.

## 0.29.3

### Patch Changes

- 75f4b64: Fix `caplets doctor` Project Binding diagnostics for authenticated self-hosted remotes so supported session routes are reported as supported instead of always unsupported.

## 0.29.2

### Patch Changes

- d5d776c: Preserve namespace shadowing across stacked attach manifests so re-attached Code Mode handles do not expose duplicate bare Caplet IDs.
- 27a9c96: Fix Project Binding for self-hosted and local project-bound Caplets.

## 0.29.1

### Patch Changes

- 470c825: Avoid wedging stacked remote execution when attach-session creation stalls, close late attach sessions after a timeout fallback, keep fresh self-hosted profiles from blocking behind refresh locks, report unsupported self-hosted Project Binding sessions clearly in doctor, and suppress unsupported Project Binding session warnings during self-hosted attach negotiation.

## 0.29.0

### Minor Changes

- f1a44c5: Add passive available-update detection for the Caplets CLI with cached public npm metadata, stderr-only human-facing notices, update-specific env controls, and strict suppression for protocol and machine-readable output paths.

### Patch Changes

- d5717b9: Keep MCP backend health checks available when a server supports resources but not resource templates.
- cc3d9f4: Keep daemon service descriptors pointed at the stable `caplets` command instead of pnpm's versioned package target so pnpm updates do not strand installed daemons on removed package paths.

## 0.28.1

### Patch Changes

- bf6930e: Add `--upstream-url` to `caplets daemon install` so managed HTTP daemons can run stacked Caplets runtimes.

## 0.28.0

### Minor Changes

- 5741c6c: Add opt-out anonymous telemetry controls, privacy-gated event builders, Sentry/PostHog provider adapters, CLI status/debug commands, and stderr-only first-run disclosure for eligible CLI/runtime commands.
- 0c83a7e: Add stacked remote runtimes with `caplets serve --transport http --upstream-url <url>`, make `caplets attach <url>` stdio-only, and carry per-session project context through attach/native remote sessions.

## 0.27.0

### Minor Changes

- 907dbd5: Add namespace shadowing policy support with source-level aliases and native remote/local qualified IDs.

### Patch Changes

- 907dbd5: Respect remote Caplet shadowing policy when merging local overlays into remote CLI list output.

## 0.26.1

### Patch Changes

- 16e97de: Make `caplets attach <url>` the primary remote attach command while keeping `--remote-url <url>` as a hidden compatibility alias.
- 16e97de: Label hidden CLI prompts without echoing entered secrets, and document the pending self-hosted Remote Login requirements and implementation plan.
- 16e97de: Replace self-hosted Remote Login's operator-minted Pairing Code bootstrap with a client-started pending login flow. The client now starts `caplets remote login <url>`, displays a short operator code, waits for server-local approval, rotates pre-login material while pending, and stores final Remote Profile credentials only after approval. Remote attach recovery now reports revoked self-hosted credentials and Cloud workspace ambiguity with stable recovery guidance, and public docs/examples show the pending-login approval sequence without remote secrets in agent configuration.

## 0.26.0

### Minor Changes

- a37e9a9: Add Caplets Vault for encrypted runtime-owned string values, `$vault:` config interpolation, access grants, CLI management, and GitHub catalog Vault setup.

## 0.25.1

### Patch Changes

- d812d42: Fix Linux daemon service unit generation so systemd accepts the daemon working directory path, and make daemon install/start health checks reject bind hosts that are not available on the local machine.

## 0.25.0

### Minor Changes

- 40f48b4: Move daemon lifecycle management from `caplets serve ...` to `caplets daemon ...`, with native per-user service manager support, install-time HTTP configuration, environment overrides, status, logs, and uninstall behavior.
- d4f76bc: Replace self-hosted remote env-token and Basic Auth setup with unified Remote Login profiles. Remote attach, hosted Cloud, OpenCode, and Pi now resolve Caplets-owned credentials from `caplets remote login <url>` and use `CAPLETS_REMOTE_URL` only as a non-secret selector.

### Patch Changes

- d4f76bc: Refresh native remote credentials before background polling, attach event reconnects, tool invokes, and stale-manifest retries so long-lived Remote Profile integrations do not reuse expired authorization headers.

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
