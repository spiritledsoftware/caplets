# Caplets Architecture

Caplets is a Code Mode and capability gateway for coding agents. It turns configured backends into Caplet handles, optional progressive wrapper tools, and optional direct MCP surfaces.

Source code is authoritative. This document summarizes the architecture, but implementation details in `packages/core`, generated schemas, tests, and package entrypoints win when docs drift.

## Runtime Layers

### Configuration And Caplet Sources

The core config loader accepts user config, project config, and Markdown Caplet files. The schema source of truth is Zod in `packages/core/src/config.ts`, with generated JSON Schemas in `schemas/`.

Supported backend families are:

- `mcpServers`
- `openapiEndpoints`
- `googleDiscoveryApis`
- `graphqlEndpoints`
- `httpApis`
- `cliTools`
- `capletSets`

Project sources override user/global sources. Source-aware inspection reports where each Caplet came from and warns when one Caplet shadows another.

### Engine

`packages/core/src/engine.ts` owns the active config, backend managers, config reload behavior, and execution dispatch. Reload keeps the last known-good config if parsing or validation fails.

Backend managers provide a common shape for listing tools, searching tools, describing exact tools, calling tools, and checking readiness. MCP-backed Caplets additionally support resources, resource templates, prompts, and completion.

### Exposure Policy And Projection

`packages/core/src/exposure/policy.ts` resolves one exposure value into three booleans:

- `codeMode`
- `progressive`
- `direct`

The global default is `code_mode`. Per-Caplet config may choose `direct`, `progressive`, `code_mode`, `direct_and_code_mode`, or `progressive_and_code_mode`.

`packages/core/src/exposure/projection.ts` turns resolved discovery snapshots and attach manifests into the Caplets exposure projection: the adapter-neutral, registration-ready view of Code Mode handles, progressive tools, direct downstream operations, direct MCP surfaces, schemas, prompt arguments, resource metadata, route descriptors, hidden diagnostic breadcrumbs, and local/remote merge outcomes. MCP serving, native integrations, and attach/remote clients render this projection; they do not re-own exposure identity, namespace shadowing, registration facts, or hidden-Caplet policy.

The engine tags each projection with the config generation captured before discovery. Adapters publish only a projection that still matches the current generation, discard out-of-order discovery, and reject callbacks rendered from an older generation. Until initial or refreshed discovery resolves, Code Mode declarations and native execution allowlists fail closed rather than falling back to configured Caplet IDs.

### MCP Server

`packages/core/src/serve/session.ts` registers the user-facing MCP surface.

- Code Mode exposure registers one `code_mode` tool that runs TypeScript against generated `caplets.<id>` handles.
- Progressive exposure registers one wrapper tool per Caplet.
- Direct exposure registers discovered downstream MCP tools, resources, resource templates, and prompts.

The HTTP server in `packages/core/src/serve/http.ts` exposes versioned MCP, attach, admin, and health endpoints for self-hosting and remote clients. Stdio remains the local MCP transport for ordinary client config.

`/v1/mcp` is the configured agent-facing MCP surface. It honors exposure policy, so a default `code_mode` server can expose only the `code_mode` tool to ordinary MCP clients.

`/v1/attach` is the Caplets runtime attach API. Attached clients read `/v1/attach/manifest`, subscribe to `/v1/attach/events`, and invoke revision-scoped exports through `/v1/attach/invoke` before merging remote projections with local/project overlays.

### Caplets Daemon

`packages/core/src/daemon/` owns the default per-user daemon lifecycle. `caplets daemon install` persists HTTP `caplets serve` configuration, explicit service environment variables, optional shell inheritance intent, user-only log paths, and native service descriptors under the `daemon/default` identity. Runtime lifecycle commands (`start`, `restart`, `stop`, `status`, `logs`, and `uninstall`) read that installed service state instead of accepting serve flags.

Top-level user `serve` config supplies optional HTTP defaults for foreground serve and daemon-managed serve. CLI flags and environment variables win over user config, and explicit daemon install settings win over later user-default changes. `caplets daemon restart` re-resolves user `serve` defaults for fields that were not explicit in the installed daemon config. Project config strips `serve` because repositories must not control a developer's local bind address, auth posture, or public origins.

The daemon uses the native per-user service manager for the host platform: launchd UserAgents on macOS, `systemd --user` services on Linux, and current-user Windows Scheduled Tasks on Windows. There is no detached-process fallback when a native manager is unavailable. Foreground `caplets serve` remains stdio/HTTP serving only.

### Code Mode

Code Mode is implemented under `packages/core/src/code-mode/`.

The runtime generates TypeScript declarations from the current callable Caplets, statically checks the submitted script, runs it in the sandbox, bridges handle methods back to the native service, stores logs when configured, and returns JSON-serializable results with diagnostics.

Code Mode supports optional live sessions. A run without `sessionId` creates a fresh QuickJS
heap and returns `meta.sessionId`; a run with a known live `sessionId` reuses that heap for
adjacent calls. Unknown or expired session IDs are rejected before user code executes.
Session heaps are runtime memory only and disappear on process restart or TTL eviction.

Recovery history is keyed by `recoveryRef`, which is returned in creation metadata when
available. `caplets.debug.readRecovery()` reads redacted, bounded summaries for agents that
already have that reference. A still-retained journal can also return the same reference when
a known session ID was evicted by TTL, compatibility invalidation, or runtime restart while
the journal remains readable. It is a setup-code reconstruction aid, not heap restoration, and
unknown session IDs do not become recovery lookup paths.

Code Mode installs a browser-like, non-I/O platform surface as runtime globals for common JavaScript data shaping: base64 helpers, a minimal `Buffer` subset, `structuredClone`, URL and text encoding helpers, Web data containers such as `Headers`, `Blob`, `File`, `FormData`, streams, abort signals, `Request`/`Response`, timers, microtasks, and crypto randomness. These globals are intentionally omitted from generated Code Mode TypeScript declarations and tool prompts so the declaration payload stays focused on Caplet handles, debug helpers, and `console`.

Direct I/O remains routed through Caplet handles. `fetch` is intentionally unavailable, and Code Mode does not expose Node process, module loading, filesystem, child process, or direct network APIs.

The intended agent pattern is one compact script:

1. choose handles
2. inspect or check only when useful
3. search for candidate operations
4. describe exact operations when schemas are needed
5. call tools
6. filter, join, and summarize inside the script
7. return compact decision-ready evidence

### Native Service

`packages/core/src/native/service.ts` powers OpenCode and Pi. It uses the same engine and exposure policy as MCP serving, then exposes native tools with agent-specific prompt guidance.

`caplets__code_mode` is the native Code Mode entrypoint. `caplets__<id>` tools exist for progressive exposure. Direct native exposure registers operation-level tools named `caplets__<id>__<operation>`.

### Remote Control

Remote control under `packages/core/src/remote-control/` lets CLI and native integrations operate against a self-hosted or Cloud Caplets service. Remote mode uses server-owned config, auth, and execution, with local/project overlays where supported.

### Project Binding

Project Binding under `packages/core/src/project-binding/` connects a local project root to a remote runtime. The foreground attach loop owns session state, heartbeat, reconnect behavior, sync preflight, and terminal recovery commands.

`docs/project-binding.md` is the living operational contract for Project Binding.

## Backend Contracts

### MCP

MCP-backed Caplets preserve downstream tool results and expose resources, templates, prompts, and completion when the downstream server supports them. Direct exposure can register those downstream surfaces directly.

### OpenAPI, Google Discovery, GraphQL, And HTTP

OpenAPI, Google Discovery, GraphQL, and HTTP backends expose explicit operation/action tools. They do not synthesize MCP resources or prompts. HTTP-like backends enforce safe URL handling, bounded response bodies, timeouts, and redacted errors.

Google Discovery backends load local or remote Google Discovery documents, infer request base URLs from the document unless overridden, expose filtered Discovery methods as tools, and infer OAuth scopes from the exposed operation set. Google media downloads and oversized or binary HTTP-like responses are written as Caplets media artifacts under the configured artifact root instead of being forced inline.

HTTP-like backend results cross one internal Media contract. Small textual or JSON bodies use the `inline` variant. Non-inline results use `local-artifact` only when the host explicitly exposes its Caplets-managed artifact filesystem; remote and hosted boundaries use `remote-reference`, which carries an artifact URI and never filesystem path semantics. Backend managers produce this contract, while terminal, MCP, Attach, native, and browser Adapters own their local presentation.

Each configurable HTTP-like backend retains its configured maximum response size as a hard failure cap. The shared HTTP reader's default remains 1 MiB. GraphQL operation results use the same 1 MiB inline threshold and a separate 100 MiB artifact cap; GraphQL schema and introspection remain bounded-text control paths.

### CLI Tools

CLI-backed Caplets expose curated actions only. Actions spawn declared commands and args without shell interpolation. Inputs are validated before spawn, and outputs are bounded.

### Caplet Sets

Caplet sets expose another Caplets collection as a nested backend. This lets a team or repository share a Caplet catalog without flattening every child backend into the parent config.

## Auth And Secrets

Auth supports none, bearer, headers, OAuth2, and OIDC where the backend family supports them. OAuth/OIDC state is stored outside config. Errors and diagnostics redact configured secrets.

Cloud Auth stores hosted credentials and a selected workspace. `caplets attach` refreshes expired hosted credentials before creating Binding Sessions and fails closed when refresh credentials are revoked.

## Distribution And Deployment

The public CLI package is `caplets`. The native packages are `@caplets/opencode` and `@caplets/pi`.

The repo includes a source-build `Dockerfile` and `docker-compose.yml` for self-hosting the HTTP service. Release workflows publish npm packages and can publish the service image.

## Benchmark Architecture

`packages/benchmarks` owns deterministic and opt-in live benchmarks.

- Deterministic benchmarks are stable, credential-free, and committed through `docs/benchmarks/coding-agent.md`.
- Live benchmarks require local agents, credentials, selected models, and explicit `CAPLETS_BENCH_LIVE=1`.
- Pi eval modes include Code Mode, progressive Code Mode, direct Code Mode, vanilla MCP, and Executor MCP competitors.

Benchmark output is product evidence, not runtime configuration truth. Runtime truth lives in `packages/core`.
