# ADR 0001: Make Code Mode The Default Backend Exposure

## Status

Accepted

## Context

Early Caplets work centered on progressive disclosure: show one capability card first, then let the agent inspect and call downstream operations through scoped wrapper tools. That model reduced flat tool-list bloat, but larger workflows still required repeated model/tool round trips for discovery, schema inspection, execution, filtering, and synthesis.

The current implementation supports multiple exposure modes and defaults global config to `code_mode`. The landing page, benchmark report, native integrations, and runtime code all treat Code Mode as the main path for agents using configured backends.

Source code remains the source of truth for behavior. This ADR records the decision and rationale, not a substitute for `packages/core` or generated schemas.

## Decision

Code Mode is the default backend exposure for Caplets.

Configured backends should enter the primary agent surface as generated `caplets.<id>` handles inside a Code Mode TypeScript script. Agents should perform discovery, exact schema inspection, tool calls, filtering, joins, and compact synthesis inside that script.

Code Mode executions may opt into a live REPL session by passing a `sessionId` returned in tool metadata. Session reuse is an affordance for iterative work against the same generated declarations and platform runtime; the live heap is process-local and not durable persistence. Recovery history is exposed through opaque `recoveryRef` metadata so agents can inspect recent runs without treating session state as a stored source of truth.

Progressive wrapper tools remain supported through the `progressive` and `progressive_and_code_mode` exposure modes. Direct MCP exposure remains supported through `direct` and `direct_and_code_mode` when the downstream surface should be registered directly.

Code Mode is not a security boundary. Backends still define the capability surface, and hosts remain responsible for process isolation, credentials, policy, and transport-level trust decisions.

## Consequences

- Product docs should describe Caplets as Code Mode first, not only as a progressive disclosure gateway.
- Progressive disclosure remains an implementation and compatibility model, but not the primary product frame.
- Benchmarks should report Code Mode separately from progressive modes.
- Agent guidance should prefer compact one-pass Code Mode scripts for multi-step work.
- Session metadata should be documented as optional live reuse state, not as a durable workspace or database.
- Long-lived docs should preserve progressive exposure details as an alternate mode, not as the main PRD.

## Evidence

- `packages/core/src/config.ts` defaults `options.exposure` to `code_mode`.
- `packages/core/src/serve/session.ts` registers a `code_mode` MCP tool when Code Mode Caplets are callable.
- `packages/core/src/native/tools.ts` defines `caplets__code_mode` for native integrations.
- `docs/benchmarks/coding-agent.md` records deterministic Code Mode workflow results and live benchmark guidance.
- `apps/landing/src/pages/index.astro` presents Code Mode as the primary evaluated mode.
