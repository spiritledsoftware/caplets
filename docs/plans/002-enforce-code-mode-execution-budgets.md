# Plan 002: Enforce a Hard Code Mode Execution Budget

> Status: TODO
> Planned against: `ac12a174`
> Finding: #2 — caller-selected timeouts can approach `Number.MAX_SAFE_INTEGER`
> Priority: P0
> Effort: M
> Fix risk: MEDIUM

## Why this matters

Code Mode runs QuickJS synchronously on the Node host thread. The public schema accepts any positive integer `timeoutMs`, while `runCodeMode` defaults `maxTimeoutMs` to `Number.MAX_SAFE_INTEGER`. A valid Access Client can therefore request an effectively unbounded CPU-bound evaluation and block MCP, dashboard, health, and Project Binding handling. Session-count limits do not help because one synchronous evaluator can monopolize the event loop.

The fix is a central absolute ceiling that every MCP, native, CLI, and remote call path inherits. Per-host policy may lower the ceiling but must never raise it.

## Scope

### In scope

- `packages/core/src/code-mode/tool.ts`
- `packages/core/src/code-mode/runner.ts`
- `packages/core/src/code-mode/sandbox.ts` only if required to prove interruption
- MCP/native/CLI adapters only where they currently override or omit policy
- Code Mode tests under `packages/core/test/`
- Generated Code Mode API only if its source declaration changes
- One patch changeset for `@caplets/core`

### Out of scope

- Replacing QuickJS, worker-thread isolation, process isolation, or distributed scheduling
- Changing the 32-session count or 64 MiB QuickJS heap ceiling
- Backend-call cancellation guarantees after a downstream server has accepted work
- A new public configuration field in this plan

## Current state

`packages/core/src/code-mode/tool.ts:7-15` accepts an unbounded positive integer:

```ts
export const codeModeRunInputSchema = z.object({
  code: z.string().describe("TypeScript Code Mode source to execute."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional execution timeout in milliseconds."),
});
```

`packages/core/src/code-mode/runner.ts:20-42` makes the policy ineffective unless a caller remembers to supply `maxTimeoutMs`:

```ts
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_TIMEOUT_MS = Number.MAX_SAFE_INTEGER;
...
const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
const maxTimeoutMs = input.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
```

`packages/core/src/serve/session.ts:303-326` passes the requested timeout but no maximum. Native and CLI call sites likewise invoke `runCodeMode` directly.

## Required design

Define and export from `runner.ts`:

```ts
export const ABSOLUTE_MAX_CODE_MODE_TIMEOUT_MS = 120_000;
```

Policy rules:

1. The effective maximum is `min(input.maxTimeoutMs ?? ABSOLUTE_MAX_CODE_MODE_TIMEOUT_MS, ABSOLUTE_MAX_CODE_MODE_TIMEOUT_MS)`.
2. `input.maxTimeoutMs` remains an internal downward override for tests/embedders; values above the absolute ceiling cannot weaken policy.
3. `timeoutMs > effectiveMax` returns the existing structured `TIMEOUT_POLICY_EXCEEDED` diagnostic before TypeScript diagnosis or sandbox allocation.
4. The public Zod schema adds `.max(ABSOLUTE_MAX_CODE_MODE_TIMEOUT_MS)` so malformed public calls fail as `REQUEST_INVALID`; direct library callers retain the runner-level defense.
5. Omitted `timeoutMs` remains 10 seconds.
6. The envelope's `meta.maxTimeoutMs` reports the effective maximum, not the caller's attempted override.

Keep the absolute constant in one source file and import it into `tool.ts`; do not duplicate `120_000`.

## Implementation steps

### 1. Write policy regression tests

Extend the existing Code Mode runner, MCP, native, CLI, and session tests. At minimum prove:

- omitted timeout still yields 10,000 ms in metadata;
- exactly 120,000 ms is accepted;
- 120,001 ms is rejected by the public schema;
- a direct `runCodeMode({ timeoutMs: 120_001 })` returns `TIMEOUT_POLICY_EXCEEDED`;
- `runCodeMode({ timeoutMs: 120_001, maxTimeoutMs: Number.MAX_SAFE_INTEGER })` is still rejected;
- a lower `maxTimeoutMs` still wins;
- the sandbox factory is not called for rejected policy input.

Use fake sandboxes for boundary tests. Do not wait two minutes in the test suite.

Run:

```sh
pnpm --filter @caplets/core test -- test/code-mode-runner.test.ts test/code-mode-mcp.test.ts test/code-mode-session.test.ts
```

Expected before implementation: at least the over-absolute tests fail.

### 2. Centralize the effective maximum

Implement the constant and a small pure helper such as `effectiveCodeModeMaxTimeoutMs`. Apply it before declaration generation or sandbox work. Import the constant in `tool.ts` and add the schema maximum.

Do not rely solely on Zod: `runCodeMode` is also a library/native seam.

Run the focused tests above. Expected: exit 0.

### 3. Verify every adapter inherits policy

Search all `runCodeMode(` call sites. For each, confirm it either:

- omits `maxTimeoutMs` and inherits the absolute maximum, or
- supplies a lower maximum for a narrower surface.

Do not add adapter-local copies of the ceiling. Add one representative adapter test for CLI/native if current coverage does not exercise the shared runner's rejection envelope.

Run:

```sh
pnpm --filter @caplets/core test -- test/code-mode-cli.test.ts test/native.test.ts test/native-remote.test.ts
pnpm typecheck
```

Expected: exit 0.

### 4. Regenerate API artifacts only if required

If the generated Code Mode declaration includes the timeout documentation, update the source declaration and run:

```sh
pnpm code-mode:generate-api
pnpm code-mode:check-api
```

If no generated source changed, do not churn generated files.

### 5. Record the contract change

Add a patch changeset for `@caplets/core` explaining that Code Mode timeout requests are capped at 120 seconds. Include the recovery: split long work into bounded calls.

Run:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
```

Expected: exit 0.

## Done criteria

- No public or direct `runCodeMode` call can exceed 120,000 ms by supplying `timeoutMs` or `maxTimeoutMs`.
- Omitted timeout behavior remains 10 seconds.
- Rejection occurs before sandbox creation.
- Existing structured error/envelope behavior is preserved.
- Focused Code Mode, CLI, native, format, lint, and type checks exit 0.
- The changeset names the new ceiling and recovery behavior.

## Escape hatches

- If a committed benchmark or product spec requires a single Code Mode call longer than 120 seconds, STOP and report the task, measured duration, and why it cannot be chunked. Do not silently raise or bypass the ceiling.
- If QuickJS interruption does not occur at the configured timeout for synchronous loops, STOP and isolate that sandbox defect as a separate blocker; schema caps without enforcement are insufficient.
- If a hosted runtime already imposes a lower contract, retain the lower bound on that surface.

## Maintenance note

Any future configurable Code Mode budget must be a downward host policy layered under this absolute ceiling. Changing the absolute value is a security and compatibility decision requiring benchmarks and a changeset.
