---
title: Code Mode REPL Sessions Use Live State Plus Recovery Journals
date: 2026-06-18
category: architecture-patterns
module: Code Mode
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when:
  - "Adding reusable execution state to Code Mode or another agent-facing runtime"
  - "A live runtime can disappear before the agent conversation or task context does"
  - "Recovery must help agents reconstruct setup without restoring private heap state"
tags: [code-mode, sessions, recovery-journal, diagnostics, mcp]
---

# Code Mode REPL Sessions Use Live State Plus Recovery Journals

## Context

Code Mode started as a one-shot TypeScript execution surface: each call built declarations, ran diagnostics, created a fresh QuickJS sandbox, and returned one JSON-serializable result. That kept execution bounded, but it forced agents to repeat setup code, rediscover tool descriptors, and redefine helpers across adjacent calls.

The solved design adds REPL-style reuse without promising durable heap persistence. Omitting `sessionId` creates a fresh live session and returns `meta.sessionId`; passing that ID reuses the same live QuickJS heap while it remains compatible and unexpired. When the heap is gone, Code Mode fails before execution and, when retained history exists for that known session, points the agent at a redacted recovery journal. Session history confirmed that this distinction was deliberate: durable heap snapshots were researched and rejected, while expiring call journals were chosen as the reconstruction and audit mechanism.

## Guidance

Separate three concepts that are easy to collapse into one:

- Live session state: the in-process heap where variables, functions, and cached discovery results exist.
- Session identity: the short-lived handle agents pass back as `sessionId` to request reuse.
- Recovery history: a retained, redacted journal of setup-like calls that helps an agent reconstruct state after the live heap is gone.

The runtime contract should be conservative:

```ts
// First call creates reusable live state.
const first = await codeMode({
  code: "function summarize(tool) { return tool.name } return { ready: true }",
});

// Adjacent call reuses that state.
const second = await codeMode({
  sessionId: first.meta.sessionId,
  code: "return summarize({ name: 'searchTools' })",
});
```

Unknown, expired, or compatibility-mismatched sessions should not silently create a replacement under the requested ID. The submitted code probably depends on state that no longer exists, so the safe behavior is `SESSION_NOT_FOUND` before execution. A fresh session is requested by omitting `sessionId`.

Recovery should be capability-scoped instead of lookup-scoped. Return a `recoveryRef` when a session is created and allow `caplets.debug.readRecovery()` only for callers that already possess that reference. If a known session ID is later cleaned up and its journal is still retained, the error metadata can return the same recovery reference. Unknown IDs must not become a way to enumerate or discover recovery history.

Persist journal lookup metadata carefully:

```ts
type StoredRecoveryJournal = {
  sessionIdHash: string;
  recoveryRefHashes: string[];
  entries: RedactedJournalEntry[];
};
```

Do not persist raw `sessionId` values or raw `recoveryRef` values. The final fix used keyed session hashes and deterministic recovery-reference derivation from a journal key plus secret, which let a fresh request-scoped journal store recover known retained sessions without turning the state directory into a credential store.

Diagnostics must be session-aware too. A REPL that preserves `helper()` at runtime but runs TypeScript diagnostics against only the current cell will block or warn incorrectly on the next cell. Store ambient declarations for successful cells in the session manager, pass that diagnostics session into later checks, and record only successful cells so rejected code does not poison future diagnostics.

## Why This Matters

Agents need reusable workflows, not just reusable JavaScript heaps. The useful product behavior is "define the workflow once, call it repeatedly while nearby context is alive, and recover the setup steps if the runtime goes away." Trying to persist the full heap creates a harder security and correctness problem: closures, capabilities, host bridges, QuickJS version details, and private runtime objects do not have a stable, safe restore contract.

The recovery journal also gives reviewable auditability. During final review, the highest-value findings all came from treating stale sessions as security and contract boundaries rather than convenience cases:

- Expired sessions originally returned plain not-found errors even when retained journals existed.
- Compatibility invalidation risked running code in a new empty session under a stale ID.
- One-shot CLI execution accepted `--session-id` even though there was no long-lived CLI REPL process to reuse.
- Diagnostics had a session-state helper but the public runner did not use it.
- The first stale-session recovery fix worked only when the same journal store object was reused; MCP/native request paths construct fresh stores, so lookup had to be persisted by keyed metadata.

Those findings are the pattern: every public surface must either reuse the exact live state or fail before execution with reconstructable context. Anything in between makes agents believe their workflow state exists when it does not.

## When to Apply

- Use this pattern when an agent-facing tool adds named reusable execution state.
- Use it when the agent conversation may outlive the process, MCP connection, or runtime TTL.
- Use it when repeated setup is valuable but durable heap snapshots would persist too much authority or implementation detail.
- Do not use session IDs as recovery credentials; keep recovery references separate and capability-scoped.

## Examples

Regression coverage should include the product contract, not just low-level session-manager behavior:

```ts
it("rejects a stale session without running submitted code", async () => {
  const created = await runCodeMode({ code: "var count = 1; return count" });
  const staleId = created.meta.sessionId;

  expireLiveSession(staleId);

  const reused = await runCodeMode({
    sessionId: staleId,
    code: "count += 1; return count",
  });

  expect(reused.ok).toBe(false);
  expect(reused.error.code).toBe("SESSION_NOT_FOUND");
  expect(sideEffectsFromSubmittedCode()).toEqual([]);
});
```

```ts
it("uses successful prior cells for reused-session diagnostics", async () => {
  const first = await runCodeMode({
    code: "function helper() { return 42 } return helper()",
  });

  const second = await runCodeMode({
    sessionId: first.meta.sessionId,
    code: "return helper()",
  });

  expect(second.diagnostics).not.toContainEqual(
    expect.objectContaining({ message: expect.stringContaining("Cannot find name 'helper'") }),
  );
});
```

Session history also surfaced a later diagnostics edge: persisted `var` types must not serialize references to local-only types that later diagnostics cannot see. When recording ambient declarations from successful cells, validate that persisted declaration text is self-contained enough for future diagnostics, and prefer a safe fallback type over an invalid or misleading declaration.

## Related

- [Code Mode architecture](../../architecture.md#code-mode)
- [Caplets Code Mode PRD](../../product/caplets-code-mode-prd.md#code-mode-contract)
