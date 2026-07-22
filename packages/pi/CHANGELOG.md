# @caplets/pi

## 0.9.21

### Patch Changes

- 99396ff: Add the resource-oriented Current Host Admin API, public OpenAPI 3.1 document, and generated Fetch client. Launch `@caplets/sdk` 0.1.0 with ordered streaming bundle helpers and the browser-safe Project Binding coordinator. Model each Current Host as an HTTP(S) origin with fixed `/.well-known/caplets`, `/api`, `/mcp`, and `/dashboard` namespaces; require origin-only configuration; move public HTTP and Admin resources under `/api`; and remove path-prefix serving, the v1 Admin transport, legacy Caplets Cloud/hosted modes, route fallbacks, and JSON/base64 bundle transfer. Preserve exclusive bearer-or-dashboard-session authorization, CSRF protection, root-path dashboard cookie migration, durable backend OAuth flows, and atomic SQL-backed administration across Host Nodes.
- Updated dependencies [99396ff]
- Updated dependencies [99396ff]
- Updated dependencies [99396ff]
- Updated dependencies [99396ff]
- Updated dependencies [99396ff]
- Updated dependencies [99396ff]
  - @caplets/core@0.37.0

## 0.9.20

### Patch Changes

- Updated dependencies [10bb0c2]
- Updated dependencies [b57e0e4]
  - @caplets/core@0.36.2

## 0.9.19

### Patch Changes

- Updated dependencies [b620ec5]
  - @caplets/core@0.36.1

## 0.9.18

### Patch Changes

- Updated dependencies [7dbfb74]
  - @caplets/core@0.36.0

## 0.9.17

### Patch Changes

- Updated dependencies [b165ac0]
  - @caplets/core@0.35.0

## 0.9.16

### Patch Changes

- Updated dependencies [c466a18]
  - @caplets/core@0.34.1

## 0.9.15

### Patch Changes

- 870a599: Unify HTTP-like non-inline results behind explicit local-artifact and remote-reference variants, preserve mixed MCP content blocks, and prevent hosted Adapters from exposing managed filesystem paths.

  GraphQL operation results now share the Media pipeline with a 1 MiB inline threshold and a 100 MiB artifact cap. Pi renders local artifact paths and remote artifact references according to the result variant.

  Replace `handleServerTool`'s positional manager arguments with a named backend runtime. External `@caplets/core` callers now construct that runtime with `createBackendOperationRuntime`; common backend operations dispatch through its `operations` Interface, while MCP-only resource, prompt, and completion methods remain on `runtime.mcp`.

  Make exposure projection the generation-bound callable-surface authority. MCP, Attach, and native adapters now render registration facts and Code Mode identities from the same projection, reject stale callbacks across reloads, discard out-of-order discovery, and keep hidden or unresolved Caplets out of declarations and execution allowlists.

  Concentrate Current Host administration behind one typed operations Interface shared by dashboard and Operator bearer adapters. Operator activity now records the real acting Client, exact Access and Operator route roles are enforced, both Client roles can revoke only their own credential, and self-revocation or demotion ends the acting dashboard session. Raw Vault Reveal remains dashboard-only and expires from browser memory.

  Give native Cloud and self-hosted Project Binding one lifecycle owner for accepted Caplet IDs, serialized updates, cleanup-last close, and atomic remote replacement while preserving their distinct failure policies. Self-hosted sockets now reauthorize durable Access Clients at execution time and serialize heartbeat, expiry, prune, end, and shutdown state so stale work cannot revive a terminal lease.

- Updated dependencies [870a599]
  - @caplets/core@0.34.0

## 0.9.14

### Patch Changes

- Updated dependencies [11c3710]
  - @caplets/core@0.33.0

## 0.9.13

### Patch Changes

- 15e467e: Fix the published CLI startup path by externalizing jsonc-parser from the Node bundle and checking the built package can answer `caplets --version`.
- Updated dependencies [15e467e]
  - @caplets/core@0.32.4

## 0.9.12

### Patch Changes

- Updated dependencies
  - @caplets/core@0.32.3

## 0.9.11

### Patch Changes

- Updated dependencies [1ecb13b]
  - @caplets/core@0.32.2

## 0.9.10

### Patch Changes

- 73cc952: Promote daemon-first local setup. `caplets setup` now initializes config, starts or reuses the local daemon, verifies health before mutating integrations, and configures MCP clients as thin `caplets attach <local-daemon-url>` clients through the pinned `add-mcp` adapter.

  Add explicit native daemon mode and setup-written daemon defaults for OpenCode and Pi, while keeping remote/cloud setup on Remote Login and secret-free attach paths.

- Updated dependencies [73cc952]
- Updated dependencies [73cc952]
  - @caplets/core@0.32.1

## 0.9.9

### Patch Changes

- Updated dependencies [b371d0b]
  - @caplets/core@0.32.0

## 0.9.8

### Patch Changes

- e517938: Add privacy-gated anonymous telemetry, Sentry source-map uploads for runtime packages, and observability wiring for the public sites.
- Updated dependencies [e517938]
  - @caplets/core@0.31.1

## 0.9.7

### Patch Changes

- Updated dependencies [988edbb]
- Updated dependencies [988edbb]
  - @caplets/core@0.31.0

## 0.9.6

### Patch Changes

- Updated dependencies [931f18e]
  - @caplets/core@0.30.0

## 0.9.5

### Patch Changes

- Updated dependencies [75f4b64]
  - @caplets/core@0.29.3

## 0.9.4

### Patch Changes

- Updated dependencies [d5d776c]
- Updated dependencies [27a9c96]
  - @caplets/core@0.29.2

## 0.9.3

### Patch Changes

- Updated dependencies [470c825]
  - @caplets/core@0.29.1

## 0.9.2

### Patch Changes

- Updated dependencies [f1a44c5]
- Updated dependencies [d5717b9]
- Updated dependencies [cc3d9f4]
  - @caplets/core@0.29.0

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
