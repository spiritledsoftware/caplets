# Caplets Architecture

Caplets is a Code Mode and capability gateway for coding agents. It turns configured backends into Caplet handles, optional progressive wrapper tools, and optional direct MCP surfaces.

Source code is authoritative. This document summarizes the architecture, but implementation details in `packages/core`, generated schemas, tests, and package entrypoints win when docs drift.

## Runtime Layers

### Configuration And Caplet Sources

The core config loader accepts user config, project config, and Markdown Caplet files. The schema source of truth is Zod in `packages/core/src/config.ts`, with generated JSON Schemas in `schemas/`.

Supported backend families are:

- `mcpServers`
- `openapiEndpoints`
- `graphqlEndpoints`
- `httpApis`
- `cliTools`
- `capletSets`

Project sources override user/global sources. Source-aware inspection reports where each Caplet came from and warns when one Caplet shadows another.

### Engine

`packages/core/src/engine.ts` owns the active config, backend managers, config reload behavior, and execution dispatch. Reload keeps the last known-good config if parsing or validation fails.

Backend managers provide a common shape for listing tools, searching tools, describing exact tools, calling tools, and checking readiness. MCP-backed Caplets additionally support resources, resource templates, prompts, and completion.

### Exposure Policy

`packages/core/src/exposure/policy.ts` resolves one exposure value into three booleans:

- `codeMode`
- `progressive`
- `direct`

The global default is `code_mode`. Per-Caplet config may choose `direct`, `progressive`, `code_mode`, `direct_and_code_mode`, or `progressive_and_code_mode`.

### MCP Server

`packages/core/src/serve/session.ts` registers the user-facing MCP surface.

- Code Mode exposure registers one `code_mode` tool that runs TypeScript against generated `caplets.<id>` handles.
- Progressive exposure registers one wrapper tool per Caplet.
- Direct exposure registers discovered downstream MCP tools, resources, resource templates, and prompts.

The HTTP server in `packages/core/src/serve/http.ts` exposes MCP, control, and health endpoints for self-hosting and remote clients. Stdio remains the local MCP transport for ordinary client config.

### Code Mode

Code Mode is implemented under `packages/core/src/code-mode/`.

The runtime generates TypeScript declarations from the current callable Caplets, statically checks the submitted script, runs it in the sandbox, bridges handle methods back to the native service, stores logs when configured, and returns JSON-serializable results with diagnostics.

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

### OpenAPI, GraphQL, And HTTP

OpenAPI, GraphQL, and HTTP backends expose explicit operation/action tools. They do not synthesize MCP resources or prompts. HTTP-like backends enforce safe URL handling, bounded response bodies, timeouts, and redacted errors.

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
