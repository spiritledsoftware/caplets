---
name: Caplets
last_updated: 2026-07-26
---

# Caplets Strategy

## Target problem

Coding agents stop where the repository ends. Users become the human integration layer: they carry issue context into the agent, inspect dashboards themselves, trigger operations, and update external systems after the code changes. Connecting more systems can then overwhelm the agent with flat tool lists, giant schemas, repeated auth setup, and extra model/tool round trips. The hard part is giving an agent broad, reusable capability access while preserving exact backend semantics and deliberate user control.

## Our approach

Caplets wins by being the capability layer for coding agents. It turns heterogeneous MCP servers, APIs, commands, and shared Caplet Files into intentionally exposed, reusable capabilities that an agent can select and combine for the current task. Code Mode is the default mechanism for keeping that Whole Stack focused: typed, scoped handles preserve backend fidelity while auth, direct I/O, and project-local context remain behind Caplet-controlled boundaries.

## Who it's for

**Primary:** Individual agent power users who want their coding agent to work across the systems surrounding the repository. **Expansion:** Teams that standardize and distribute approved Caplets. **Ecosystem:** Tool builders and community authors who publish reusable capability definitions.

## Key metrics

- **First Caplet execution** - The first successful backend operation executed through a configured Caplet. Landing clicks, catalog views, installation, and setup completion are funnel diagnostics, not execution.
- **Caplet Activation** - A first successful Caplet execution followed by connecting a capability from the user's own stack. Activation and retention cohorts use this complete milestone.
- **Whole Stack retention** - Repeat successful Caplet executions across backend families after Caplet Activation, indicating that users expanded into personally relevant work.
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

**Category:** The capability layer for coding agents.

**One-liner / headline:** Give your coding agent the whole stack.

**Profile description:** Turn MCP servers, APIs, and commands into reusable Caplets your coding agent can use across the work. You control access.

**Key message:** Caplets connects coding agents to intentionally exposed capabilities across the user's stack. A Caplet is reusable across supported agent environments and can be shared without transferring credentials. Agents compose Caplets for the task instead of requiring a fixed automation workflow. Code Mode tool-surface compression, fewer round trips, and benchmarked token reduction are technical proof—not the primary promise.

**Launch sequence:** Whole Stack promise → “MCP. APIs. Commands. All of it.” → human integration-layer problem → capability composition → agent portability → “Share capabilities, not secrets.” → issue-to-production example → Code Mode evidence → first Caplet activation.
