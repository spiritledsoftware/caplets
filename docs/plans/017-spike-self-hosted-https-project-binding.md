# Plan 017: Spike Self-Hosted HTTPS Project Binding for Native Adapters

> Status: TODO
> Planned against: `ac12a174`
> Direction option: #2 — Project Binding for self-hosted HTTPS
> Priority: Product bet
> Effort: M for spike; implementation estimate required from spike
> Fix risk: HIGH

## Why this matters

Native OpenCode/Pi integrations can pass local project context to Cloud and loopback daemon modes, but generic self-hosted HTTPS remotes deliberately fall back without Project Binding. Public docs state that limitation. The repository has Project Binding REST/WebSocket protocol, workspace/lease stores, sync filtering, size policy, and a `ManagedMutagenProjectSync` primitive, but the native HTTPS lifecycle does not compose them end to end.

This spike must produce an implementation-ready protocol design and measured proof before enabling the feature. The hard questions are trust, sync ownership, remote workspace addressing, credential refresh, lease/cancellation races, and cleanup.

## Scope

### In scope

- Read-only/prototype analysis of:
  - `packages/core/src/native/service.ts`
  - `packages/core/src/project-binding/`
  - `packages/core/src/serve/http.ts` Project Binding routes
  - remote credential/profile resolution
- A durable design spec at `docs/specs/<date>-self-hosted-https-project-binding.md`
- Disposable test/prototype code only if removed before final diff
- Sequence diagrams, threat model, state machine, API changes, rollout gates, and implementation work breakdown

### Out of scope

- Enabling generic self-hosted HTTPS binding in production
- Changing the documented limitation before implementation lands
- Hosted Cloud control-plane design
- Replacing Mutagen
- Sending arbitrary project files through ordinary MCP/attach request bodies

## Current evidence

`packages/core/src/native/service.ts:1571-1613` creates `RemoteProjectBindingSessionManager` only when a project root exists and the remote URL is loopback. Otherwise it writes:

```ts
Remote project binding unavailable; continuing without project context.
```

That manager (`native/service.ts:1616-1875`) creates/heartbeats/deletes REST sessions and always reports `syncState: "idle"`; it does not run project sync.

`project-binding/attach.ts` resolves auth modes, builds a filtered manifest/size policy, and runs a REST/WebSocket session. `project-binding/session.ts:74-260` manages connection/heartbeat/reconnect/terminal cleanup but does not invoke `ManagedMutagenProjectSync`. `project-binding/mutagen.ts:183-358` can create, inspect, and terminate a named sync, yet has no production caller in core. Server workspaces and leases live in `project-binding/workspaces.ts` and `serve/http.ts`.

This missing orchestration is the spike's subject; do not assume one existing class can simply be reused.

## Questions the spec must answer

1. **Trust:** Which remote role may request Project Binding? How is the server identity pinned, and can a compromised server redirect Mutagen to an arbitrary endpoint/path?
2. **Endpoint addressing:** What exact `serverProjectRoot`/Mutagen endpoint does the server return? Is it reachable from the native client without SSH credentials?
3. **Sync ownership:** Does the native client, self-hosted server, or an external sidecar run Mutagen? Which side has local/remote filesystem access?
4. **Protocol:** How do REST session creation, WebSocket state, sync start/ready/failure, heartbeat, and termination order?
5. **Credential refresh:** How does a long-lived session update bearer credentials without creating a second binding or dropping sync?
6. **Failure semantics:** What happens on WebSocket loss, token revocation, lease expiry, Mutagen conflict, process exit, host restart, and client crash?
7. **Policy:** Which `.capletsignore`/denylist/size tier applies to self-hosted mode? How are excluded/private files reported without leaking paths?
8. **Execution:** How does remote Code Mode receive the authoritative synchronized root and prove fingerprint/generation before enabling a Project-Binding-required Caplet?
9. **Cleanup:** Which owner terminates sync and deletes workspace data? What is the idempotent recovery path after ambiguous termination?
10. **Compatibility:** How do older hosts/clients signal `UNSUPPORTED_CAPABILITY` and preserve today's fallback?

## Required deliverable structure

The spec must contain:

- Problem/non-goals
- Existing component inventory with exact symbols
- Proposed trust boundary and threat model
- Chosen sync topology plus at least two rejected alternatives
- Versioned wire additions with request/response examples containing no secrets
- Client/server state machines
- Sequence diagrams for start, ready, credential refresh, reconnect, and close
- Lease/cleanup invariants
- Error/recovery matrix using existing `ProjectBindingErrorCode` where possible
- Backward-compatible capability negotiation
- Test strategy (unit, fake transport, real loopback HTTPS, optional Mutagen smoke)
- Observability/doctor requirements
- Rollout stages and rollback
- File-by-file implementation slices with dependencies and coarse effort
- Explicit open questions; zero silent assumptions

## Spike steps

### 1. Trace the existing end-to-end protocols

Map native remote selection, attach sessions, Project Binding REST/WebSocket routes, server workspace creation, execution-context lookup, and cleanup. For each state field (`state`, `syncState`, fingerprint, generation, lease expiry), name its writer and reader.

Run existing tests as a baseline:

```sh
pnpm --filter @caplets/core test -- test/native.test.ts test/native-remote.test.ts test/project-binding.test.ts test/serve-http.test.ts
```

Expected: exit 0.

### 2. Prove or disprove a viable sync topology

Build a disposable local experiment with:

- a TLS Caplets server using remote credentials;
- a native-client fixture with a temporary project;
- a server-owned temporary workspace;
- injected/fake `MutagenProcessRunner` first, then real Mutagen only if available.

The experiment must show how the client learns a safe sync destination and how the server observes the synchronized fingerprint. Capture sanitized events/timings in the spec. Delete prototype code/artifacts before finishing unless a reusable fake-transport test is explicitly part of the approved design.

If no secure reachable topology exists without new credentials/sidecar infrastructure, say so and recommend deferring the feature.

### 3. Threat-model the chosen design

Cover malicious server responses, path traversal, shell argument injection, credential exposure in process lists, symlink races, over-size projects, reconnect replay, lease takeover, stale workspace execution, and cleanup after client death. Reuse existing manifest denylist/size/quarantine rules; identify gaps rather than hand-waving them.

### 4. Specify state and wire contracts

Write exact additions, for example a capability descriptor and server-selected opaque sync endpoint. Every client-supplied path remains a local label/fingerprint; the server owns its workspace path. Mutagen arguments must be structured values, never shell command strings.

Specify guarded transitions and ownership tokens for start/ready/close. Closing and credential refresh are concurrency-sensitive; include race tables.

### 5. Produce implementation slices and decision

End the spec with one verdict:

- `PROCEED`: secure topology proven; list ordered implementation slices and acceptance gates.
- `BLOCKED`: name the missing server/network/auth primitive and the smallest prerequisite project.
- `DEFER`: value does not justify operational/security cost; retain documented fallback.

Run:

```sh
pnpm format:check
pnpm lint
pnpm docs:check
```

Expected: exit 0. No changeset is required for a spec-only spike.

## Done criteria

- The spec answers all ten questions or explicitly marks a blocker with evidence.
- A sanitized local experiment proves the chosen topology or disproves feasibility.
- Trust, lifecycle, cancellation, lease, and cleanup races are explicit.
- Backward compatibility preserves current fallback on unsupported hosts.
- The final verdict and ordered file-level implementation slices are unambiguous.
- Final diff contains the spec only (plus an intentionally reusable test harness if justified), no partially enabled feature.
- Format, lint, docs check, and baseline focused tests pass.

## Escape hatches

- If the sync endpoint requires exposing SSH/private credentials to the client or process list, choose another topology or return `BLOCKED`; do not weaken credential boundaries.
- If server and client cannot agree on an execution fingerprint before a required Caplet runs, do not enable binding optimistically.
- If real Mutagen is unavailable, a fake-runner experiment may prove state orchestration but the verdict must require a later opt-in live smoke before implementation release.

## Maintenance note

Do not turn the current loopback-only fallback into a broad URL exception. Self-hosted HTTPS Project Binding is a protocol and lifecycle feature, not a conditional branch.
