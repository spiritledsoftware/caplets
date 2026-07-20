# Plan 009: Characterize Dashboard Mutations And CSRF Semantics

> Status: COMPLETE
> Planned against: `ac12a174`
> Finding: #9 — destructive browser flows lack end-to-end frontend contract coverage
> Priority: P1
> Effort: S
> Fix risk: LOW
> Required by: Plan 000
> Production prerequisite: [Plan 019](019-fix-dashboard-mutation-races.md) (COMPLETE)

## Why this matters

Plan 000 replaces dashboard transport paths and response types with the shared Admin API and a generated client. Before that migration, tests must lock the user-visible mutation, confirmation, invalidation, stale-response, and CSRF behavior without treating today's legacy URL spelling as permanent architecture.

Core HTTP tests protect server authorization. Existing dashboard tests deeply cover Vault reveal races but do not equivalently protect Remote Client role change/revoke and runtime restart.

Plan 009 remains characterization-only. Its rendered tests exposed production defects in safe-request CSRF handling, restart pending state, stale revoke protection, and successful-mutation completion ordering. Those source fixes are owned by completed [Plan 019](019-fix-dashboard-mutation-races.md), so this plan's no-production-source completion claim remains literal.

## Scope

### In scope

- `apps/dashboard/src/lib/api.test.ts`
- `apps/dashboard/src/components/DashboardApp.test.tsx`
- Test-only helpers in those files

### Out of scope

- Production dashboard changes
- Freezing legacy dashboard endpoint names or RPC response shapes
- Snapshotting copy, headings, or layout
- Browser E2E infrastructure
- Duplicating backend authorization tests

## Required coverage

### Transport ceremony

Exercise the current dashboard request Adapter with mocked `fetch` and an active session. Prove:

- safe GET omits `x-caplets-csrf`;
- every unsafe method used by the dashboard includes the current CSRF token exactly once;
- a session replacement uses the new token;
- no active session omits the header rather than reusing stale state;
- credentials and base-path behavior remain correct;
- abort reaches Fetch.

Assert method, safety class, and CSRF behavior. Keep exact legacy path assertions in one table so Plan 000 can replace that table with generated Admin operation IDs rather than rewriting component tests.

### Rendered mutation behavior

Using the existing real-component/mock-API conventions, cover:

1. Remote Client role change: confirmation where present, one semantic client call, no early success, visible refresh/invalidation after resolution, and rejection state.
2. Remote Client revoke: confirmation cannot be bypassed, acting-session termination is handled, stale responses cannot restore a revoked client, and rejection preserves usable state.
3. Runtime restart: one semantic call, no early toast, correct pending state, refresh/invalidation after success, and stable failure state.
4. Raw Vault Reveal: retain the existing confirmation, no persistence across navigation/refresh, timer expiry, and rejection behavior. Do not generalize this private ceremony into the shared Admin client.

Component tests mock named semantic client methods, not raw `fetch` or route strings. They assert observable calls/state/toasts, not implementation snapshots or prose.

### Migration handoff

Add a small test helper that classifies a request as safe/unsafe and allows the underlying operation identity to change. Plan 000 must update only the transport table and generated-client fixture while these rendered behavior tests remain unchanged. Record this requirement in test names or comments, not a separate framework abstraction.

## Implementation steps

1. Add transport CSRF/session/abort tests in `api.test.ts`.
2. Add role-change success/rejection and revoke confirmation/session-ended cases in `DashboardApp.test.tsx`.
3. Add runtime restart pending/success/rejection cases.
4. Verify existing Vault Reveal coverage includes navigation and timer cleanup; add only missing observable cases.
5. Run dashboard focused and package gates without production changes.

## Verification

```sh
pnpm --filter @caplets/dashboard test -- src/lib/api.test.ts src/components/DashboardApp.test.tsx
pnpm --filter @caplets/dashboard test
pnpm --filter @caplets/dashboard typecheck
pnpm format:check
pnpm lint
```

Expected: exit 0. If a new characterization test exposes a production defect, report it as a separate prerequisite rather than hiding a fix in this test-only plan.

## Completion criteria

- CSRF/session/abort behavior is covered at the transport Adapter.
- Role change, revoke, restart, and reveal protect success, pending, rejection, confirmation, and stale-response behavior where applicable.
- Component tests depend on semantic client methods rather than legacy paths.
- The one legacy transport table is explicitly replaceable by Plan 000's generated operation IDs.
- No production source or subjective copy snapshot is added.
- Focused/package tests, typecheck, format, and lint pass.

## Maintenance note

Every new destructive dashboard action needs one rendered success case, one rejection case, confirmation coverage when destructive, and transport-level CSRF coverage. Admin route tests alone do not protect browser wiring.
