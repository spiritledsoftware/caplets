# Plan 005: Bound and Expire HTTP Runtime Sessions

> Status: TODO
> Planned against: `ac12a174`
> Finding: #5 — MCP and fallback Attach sessions live until process shutdown
> Priority: P0
> Effort: M
> Fix risk: MEDIUM

## Why this matters

`createHttpServeApp` keeps MCP sessions in `sessions` and stack-chain fallback Attach sessions in `defaultAttachSessions` without idle timestamps or cardinality limits. Explicit Attach sessions already expire after ten minutes, but the other maps retain servers, listeners, Code Mode state, and downstream connections until restart. A credentialed client can create unbounded state by omitting/replacing MCP session IDs or varying `caplets-stack-chain`.

This plan applies one predictable lifecycle policy across all in-memory HTTP runtime sessions while preserving active requests and explicit close semantics.

## Scope

### In scope

- `packages/core/src/serve/http.ts`
- `packages/core/test/serve-http.test.ts`
- Any local test factory types required to observe close calls
- One patch changeset for `@caplets/core`

### Out of scope

- Durable dashboard sessions (stored separately)
- Project Binding lease policy, which already has a 60-second lease
- Code Mode's internal 32-session manager limit
- Cross-node session replication
- Rate limiting by IP/client identity

## Current state

At `packages/core/src/serve/http.ts:169-190`:

```ts
const ATTACH_SESSION_IDLE_TIMEOUT_MS = 10 * 60_000;
const ATTACH_SESSION_PRUNE_INTERVAL_MS = 60_000;
...
const sessions = new Map<string, HttpSession>();
const attachSessions = new Map<string, AttachSessionRecord>();
const defaultAttachSessions = new Map<string, HttpAttachSession>();
```

Only `attachSessions` records `lastUsedAt` and is pruned at `http.ts:1521-1528`. `sessions` is deleted only by transport close or process cleanup. `defaultAttachSessions` is keyed by untrusted stack-chain combinations and is closed only by `app.closeCapletsSessions()`.

## Required design

Use explicit records for every map:

```ts
type RuntimeSessionRecord<T> = {
  value: T;
  lastUsedAt: number;
  inFlight: number;
};
```

Policy:

- Idle timeout: retain the existing ten-minute value for explicit Attach, MCP, and default Attach sessions.
- Maximums: 128 MCP sessions, 128 explicit Attach sessions, and 64 fallback Attach sessions per HTTP app.
- Touch a record at request start and completion.
- Never prune `inFlight > 0`.
- On capacity, prune expired idle records first; if still full, reject new creation with a stable resource-exhausted response. Do not evict a live least-recently-used session silently.
- Closing a pruned MCP session must close its server/transport exactly once. Closing Attach variants must call `session.close()` exactly once.
- Pending fallback factory promises count toward the 64-entry limit and must be removed on resolve/reject.
- The prune timer continues to `unref()` and app shutdown awaits all started close operations.

Keep constants private unless an existing test-options seam already supports clock/limit injection. Prefer injecting `now`, limits, and intervals through `HttpServeIo` test-only options over fake timers that affect unrelated code.

## Implementation steps

### 1. Add lifecycle characterization tests

In `packages/core/test/serve-http.test.ts`, add fakes that count session creation, request handling, and close calls. Cover:

- an MCP session is reused and touched by its valid header;
- an explicit Attach session closes after idle timeout;
- a fallback Attach session closes after idle timeout;
- an in-flight session survives a prune tick and becomes eligible after completion;
- app shutdown closes each retained session once.

Run:

```sh
pnpm --filter @caplets/core test -- test/serve-http.test.ts
```

Expected before implementation: MCP/fallback idle-close tests fail.

### 2. Generalize record and close helpers

Replace raw map values with records. Add idempotent helpers for:

- `closeMcpSession(id, record)`
- `closeAttachSession(id, record)`
- `closeDefaultAttachSession(key, record)`

Delete from the map before awaiting close so a concurrent request cannot acquire a record being closed. Track close promises in a set so `closeCapletsSessions()` can await pruning work already underway.

Wrap handler dispatch in `withRuntimeSessionUse(record, operation)` using `try/finally` to maintain `inFlight` and timestamps.

Run the lifecycle tests. Expected: exit 0.

### 3. Enforce cardinality before creation

Add a pure `ensureRuntimeSessionCapacity` helper that:

1. calls the relevant prune function with the current clock;
2. counts active plus pending entries;
3. throws a stable `CapletsError` if the limit remains reached.

Map that error through existing MCP/Attach safe envelopes:

- MCP returns JSON-RPC error plus HTTP 429 or 503 consistently with SDK constraints;
- Attach returns the existing `{ ok: false, error: { code, message } }` shape.

Tests must create reduced-limit apps (for example limit 2) and prove the third active session is rejected, while an expired first session is closed and replaced.

Run the focused suite. Expected: exit 0.

### 4. Reconcile shutdown and timers

Update the shared prune timer to prune all four lifecycle families: explicit Attach, fallback Attach, MCP, and expired Project Binding. `closeCapletsSessions()` must:

- clear the timer;
- prevent new factories;
- close streams;
- await map records, pending factories that have started, and tracked prune closes with `Promise.allSettled`;
- clear all maps/sets.

Add a race test where shutdown occurs while a fallback factory resolves. Assert the new session is closed rather than inserted after shutdown.

Run:

```sh
pnpm --filter @caplets/core test -- test/serve-http.test.ts
pnpm typecheck
```

Expected: exit 0.

### 5. Record the contract

Add a patch changeset for `@caplets/core` describing bounded, idle-expiring HTTP runtime sessions. Then run:

```sh
pnpm format:check
pnpm lint
```

Expected: exit 0.

## Done criteria

- MCP, explicit Attach, and fallback Attach sessions have idle timestamps and hard cardinality limits.
- In-flight sessions are never pruned.
- Capacity exhaustion rejects creation instead of silently evicting active state.
- Timer pruning and app shutdown close resources exactly once, including factory/shutdown races.
- Existing Project Binding lease behavior is unchanged.
- Focused tests, format, lint, and type checks exit 0.

## Escape hatches

- If MCP SDK transport close requires a specific order between transport and server, preserve that order from its `onclose` path and add an idempotent owner helper; do not double-close.
- If the SDK mandates a particular HTTP status for session exhaustion, follow the SDK protocol and lock it in a test.
- If measured legitimate clients require more than the proposed defaults, STOP with observed concurrency and memory data rather than removing the bound.

## Maintenance note

Every app-owned session map needs an owner, idle policy, capacity policy, and idempotent close path. New session types must join the shared prune and shutdown lifecycle in the same change.
