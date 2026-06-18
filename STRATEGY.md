---
name: Caplets
last_updated: 2026-06-17
---

# Caplets Strategy

## Target problem

Coding agents get slower, more expensive, and less reliable when real backend surfaces are exposed as flat tool lists: large MCP/API setups flood context with hundreds of operations, create duplicate generic names, and force repeated model/tool round trips for discovery, schema inspection, execution, and synthesis. The hard part is preserving exact backend power, auth state, schemas, resources, prompts, results, and errors across local, remote, Cloud, and native agent setups without making the agent reason over the whole tool wall up front.

## Our approach

Caplets wins by being a Code Mode-first capability layer for coding agents, not a general tool catalog. It turns heterogeneous backends into typed, scoped handles so agents can discover, inspect, execute, filter, and summarize with a small decision surface, while preserving exact backend semantics and keeping auth, direct I/O, and project-local context behind Caplet-controlled boundaries.

## Who it's for

**Primary:** Agent power-users/builders - They're hiring Caplets to turn sprawling MCP/API/CLI surfaces into typed capabilities their coding agents can inspect, call, filter, and synthesize without a giant tool wall.

## Key metrics

- **Initial tool surface compression** - Reduction in initially visible tools, serialized payload bytes, approximate context tokens, and duplicate top-level names versus direct flat MCP; measured by `pnpm benchmark:check`.
- **Code Mode workflow efficiency** - Reduction in model/tool round trips, external calls, and payload tokens while preserving required evidence fields; measured by deterministic Code Mode benchmark fixtures.
- **Live task parity at lower token cost** - Live eval pass rate must match baselines before claiming token efficiency, then compare request+output tokens and tool-surface tokens.
- **Release readiness** - Full verification, CI, changeset, release, and deploy paths pass for package-impacting work; measured through `pnpm verify` and GitHub workflows.
- **Runtime diagnosability and health** - Users and agents can verify server health, remote auth, Project Binding state, exposure readiness, and Code Mode health through finite diagnostics; measured through `caplets doctor`, `/v1/healthz`, and `caplets attach --once`.

## Tracks

### Capability backends and shared contracts

Expand and harden backend families, auth, schemas, media artifacts, and Caplet source handling so many tool ecosystems can enter Caplets as focused capability domains.

_Why it serves the approach:_ The product only works if heterogeneous MCP/API/CLI surfaces keep their fidelity while presenting as inspectable Caplets instead of a flat tool wall.

### Code Mode runtime and native agent surfaces

Make Code Mode the dependable default surface across MCP clients, OpenCode, and Pi, with typed handles, lean generated declarations, persistent workflow affordances, and practical non-I/O platform globals.

_Why it serves the approach:_ Code Mode is the mechanism that lets agents discover, call, filter, join, and summarize in one bounded workflow while keeping direct I/O and raw tool sprawl out of the prompt.

### Remote runtime and Project Binding

Make local, self-hosted remote, and Cloud-backed execution behave as one capability model, with attach, workspace routing, auth refresh, diagnostics, and safe project sync.

_Why it serves the approach:_ The same Caplet semantics need to survive where the work runs; remote and Cloud only help if project files, credentials, attach state, and recovery paths remain explicit and trustworthy.

### Public proof, docs, and release confidence

Keep public docs, generated references, landing proof, deterministic benchmarks, and repo verification aligned with implementation truth.

_Why it serves the approach:_ Caplets asks users to trust a smaller visible surface, so public claims need reproducible evidence and drift checks.

## Not working on

- Flattening every downstream tool into the initial tool list by default.
- Making progressive discovery the main product frame; it remains a supported mode.
- Requiring hosted Cloud for local usage.
- Exposing arbitrary shell access or direct Code Mode host/network access.
- Treating live benchmark runs as deterministic product claims.
- Returning binary or oversized media inline as blobs or base64.

## Marketing

**One-liner:** Give your agent capabilities, not giant tool walls.

**Key message:** Caplets turns MCP servers, APIs, and commands into focused capability handles for compact coding-agent workflows. The proof point is not just that Caplets connects to more backends; it is that agents can complete real multi-step backend work with a smaller decision surface, fewer round trips, and claims that are checked against reproducible benchmarks.
