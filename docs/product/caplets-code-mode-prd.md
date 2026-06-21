# Caplets Code Mode PRD

## Summary

Caplets gives coding agents a compact Code Mode surface for MCP servers, APIs, and commands. Each configured backend becomes a typed `caplets.<id>` handle that an agent can inspect, search, call, filter, join, and summarize inside one TypeScript workflow.

Progressive discovery remains available for clients or workflows that need visible wrapper tools, and direct exposure remains available for selected MCP resources, prompts, and tools. Code Mode is the default backend exposure because it keeps discovery, execution, filtering, and synthesis in one bounded agent call.

Source code is the source of truth. This PRD captures product intent and should be updated or deleted when it no longer matches `packages/core`, generated schemas, tests, and benchmark code.

## Problem

Large MCP and API setups give agents too much surface area too early:

- Flat tool lists inflate initial context and create duplicate names.
- Agents choose tools before they understand the capability domain.
- Multi-step discovery produces repeated model/tool round trips.
- Schema-less or generic outputs make agents over-carry raw payloads.
- Local, remote, Cloud, and native agent integrations need the same capability model.

Caplets should make backends usable as capability domains without hiding the exact operations, schemas, resources, prompts, results, or errors that agents need to complete work.

## Goals

- Make Code Mode the primary agent surface for configured backends.
- Preserve progressive discovery for clients and workflows that benefit from visible wrapper tools.
- Preserve direct MCP access for explicitly exposed tools, resources, resource templates, and prompts.
- Keep downstream calls lossless enough for agents to cite evidence and recover from errors.
- Keep secrets redacted while exposing enough auth and status detail for debugging.
- Support local, self-hosted remote, and hosted Cloud routes through the same capability semantics.
- Keep benchmark claims reproducible, with live results clearly marked as environment-dependent.

## Non-Goals

- Do not claim Code Mode is a sandbox security boundary.
- Do not flatten every downstream tool into the initial tool list by default.
- Do not make progressive discovery the product frame; it is one supported exposure mode.
- Do not require hosted Cloud for local Caplets usage.
- Do not expose arbitrary shell access through CLI-backed Caplets.
- Do not treat live benchmark runs as deterministic product claims.

## User Surfaces

### CLI

The `caplets` package installs the CLI. Important commands include:

- `caplets setup` for Codex, Claude Code, OpenCode, Pi, or generic MCP client setup.
- `caplets serve` for foreground stdio or HTTP MCP serving.
- `caplets daemon` for installing, starting, stopping, inspecting, tailing logs for, and uninstalling the default local HTTP service through the native per-user service manager.
- `caplets attach` for a remote-backed MCP server and Project Binding session.
- `caplets install` for shared Caplet files.
- `caplets add` for MCP, OpenAPI, GraphQL, HTTP, and CLI-backed Caplets.
- `caplets code-mode` and `caplets code-mode types` for Code Mode inspection and debugging.
- `caplets doctor` for config, auth, exposure, Code Mode, and Project Binding diagnostics.

### MCP Clients

`caplets serve` registers a `code_mode` MCP tool when any configured backend resolves to Code Mode exposure. Progressive wrapper tools and direct tools are registered only for Caplets whose exposure policy enables those surfaces.

`caplets daemon install` is the configuration mutation point for the long-running local HTTP service. It accepts the HTTP serve flags from `caplets serve` except `--transport`, supports explicit `--env` overrides and optional shell inheritance, and writes stdout/stderr logs that remain readable until purged.

### Native Integrations

OpenCode and Pi use the native service from `@caplets/core/native`. They expose `caplets__code_mode` for Code Mode, `caplets__<id>` tools for progressive exposure, and operation-level `caplets__<id>__<operation>` tools for direct exposure. Native integrations share the same local, remote, and Cloud selection rules as the CLI.

### Remote And Cloud

Self-hosted remotes and hosted Cloud use `caplets remote login <url>` to create a saved Remote Profile, then use `CAPLETS_MODE` with `CAPLETS_REMOTE_URL` as a non-secret selector. Project Binding connects a local project root to a remote runtime when Cloud or remote workflows need project-local files.

## Capability Model

Caplets load backends from user config, project config, and Markdown Caplet files. Backends currently include:

- MCP servers.
- OpenAPI endpoints.
- GraphQL endpoints.
- Explicit HTTP APIs.
- Curated CLI tools.
- Nested Caplet sets.

Each Caplet has stable identity, name, description, optional hints, source metadata, auth posture, and an exposure policy. Source precedence favors project-local Caplets over user/global Caplets, and inspection surfaces expose source and shadowing information.

## Code Mode Contract

Code Mode runs TypeScript with generated `caplets.<id>` handles. Handles expose:

- `inspect()` and `check()` for capability and readiness.
- `tools()` and `searchTools()` for discovery.
- `describeTool()` for exact schemas, call signatures, examples, and observed output shapes.
- `callTool()` for execution.
- MCP-only resource, template, prompt, and completion methods where supported.
- `caplets.debug.readLogs()` for stored Code Mode log inspection when available.
- `caplets.debug.readRecovery()` for redacted, bounded recovery summaries when the agent
  already has the session's `recoveryRef`.

The runtime also provides common JavaScript platform globals for data manipulation:
`atob`, `btoa`, a minimal `Buffer` subset, `structuredClone`, URL and text encoding
helpers, Web data objects (`Headers`, `Blob`, `File`, `FormData`, streams,
`AbortController`, `AbortSignal`, `Request`, `Response`), timers, microtasks, and crypto
randomness (`crypto.randomUUID()` and `crypto.getRandomValues(...)`). These are available
as runtime globals for JS muscle memory, but they are intentionally not enumerated in the
generated declaration payload or tool prompt so Code Mode keeps its context surface lean.

Agents should keep bulky discovery and raw payload handling inside the Code Mode script, then return compact decision-ready JSON with the evidence fields needed by the user.

Code Mode runs accept an optional `sessionId`. Omitting it creates a fresh QuickJS session;
successful fresh and reused runs return `meta.sessionId` so adjacent calls can reuse live
helpers, variables, and cached discovery state. Unknown or expired session IDs fail before
submitted code runs with structured session errors. Session heap state is intentionally not
durable across process restarts or TTL eviction, and ordinary `caplets code-mode ...` CLI
invocations remain one-shot unless a separate long-lived REPL command is implemented.

Recovery is reference-scoped, not broad lookup-based. Agents can read recovery history when
they possess the `recoveryRef` returned when the session was created, and a still-retained
journal may return that same reference when a known session ID was cleaned up by TTL,
compatibility eviction, or runtime restart while the retained journal remains readable.
Recovery summaries are redacted and bounded, and they help agents reconstruct setup code
manually. They do not restore heap, closures, timers, promises, or host handles. Unknown
session IDs do not upgrade into recovery references, and there is no recent-session lookup.

## Exposure Modes

The global default is `code_mode`. Per-Caplet exposure can override the default.

Supported exposure values are:

- `code_mode`
- `progressive`
- `direct`
- `progressive_and_code_mode`
- `direct_and_code_mode`

Progressive exposure registers one wrapper tool per Caplet and supports scoped operations such as `inspect`, `tools`, `search_tools`, `describe_tool`, and `call_tool`. Direct exposure registers downstream MCP tools, resources, resource templates, and prompts directly when discovery can resolve them safely.

## Trust And Safety

- Config and Caplet files are schema-validated.
- Backends enforce timeouts and bounded response sizes.
- CLI-backed Caplets spawn declared commands without shell interpolation.
- HTTP-like backends reject unsafe base URLs and redact configured secrets from errors.
- OAuth/OIDC tokens are stored outside config and loaded lazily.
- Project Binding sync filters deny dangerous directories, private keys, unsafe env files, caches, build outputs, and ignored files.
- Direct `fetch`, Node/process/module APIs, filesystem access, child processes, and direct network access are unavailable inside Code Mode; route I/O through Caplet handles.
- Progressive discovery and Code Mode are context-management tools, not permission boundaries.

## Evidence

The deterministic benchmark in `docs/benchmarks/coding-agent.md` remains the reproducible context-surface claim. It compares flat MCP exposure against Caplets capability exposure over local mock MCP metadata.

The same report includes a deterministic Code Mode workflow fixture showing fewer model/tool round trips than equivalent progressive sequences, with required evidence fields preserved.

Live Pi evals compare Caplets modes against vanilla MCP and Executor in opt-in, model-dependent runs. They are useful for product direction and regression discovery, but they are not deterministic release claims.

## Current Open Questions

- Which Code Mode result-shaping hints should become stable public contract versus internal prompt guidance?
- How much direct exposure should be enabled by default for clients that support resources and prompts well?
- Which Cloud runtime and Project Binding semantics should move from implementation detail to public product contract?
- Which historical benchmark suites should remain supported as long-term regression tests versus local research harnesses?
