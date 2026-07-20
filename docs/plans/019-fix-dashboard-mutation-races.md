# Plan 019: Fix Dashboard Mutation Races

> Status: COMPLETE
> Finding: production defects exposed by Plan 009 dashboard characterization
> Priority: P1
> Effort: S
> Fix risk: MEDIUM
> Required by: Plans 000 and 009

## Why this matters

Dashboard mutations refresh a shared rendered snapshot. Ordering that snapshot by action start time lets a rejected later-started action suppress an older successful refresh, and lets an earlier-started action that commits last lose to a mutation that completed first. The browser must order successful mutations by completion while retaining the stronger revoke rule that stale pre-revoke data cannot restore a revoked client.

Plan 009 remains characterization-only. This completed prerequisite owns the production fixes its tests exposed.

## Scope

### In scope

- Safe-method CSRF header selection in the dashboard request Adapter
- Runtime restart pending admission, presentation, and cleanup
- Global successful-mutation refresh ordering
- Stale Remote Client revoke protection
- Rendered regression coverage for both mutation race directions
- A patch changeset for the dashboard behavior embedded in `@caplets/core`

### Out of scope

- Admin endpoint migration or legacy endpoint changes
- Generated Admin client work
- Dashboard copy or layout redesign
- Changes to Raw Vault Reveal's private generation guard

## Completed behavior

### Safe GET CSRF

The request Adapter normalizes the method and omits `x-caplets-csrf` for GET, HEAD, and OPTIONS. Unsafe methods still read the active session at request time and send its current token once. Session replacement and clearing therefore cannot leak a stale token into a later request.

### Runtime restart pending state

A ref and rendered state owned by the route-stable `DashboardApp` synchronously admit only one restart intent before the confirmation awaits and keep the control disabled for the full pending interval, including navigation away from and back to Runtime. The `finally` path clears both the ref and state after cancellation, success, or rejection, preserving the existing success and error toasts without allowing a duplicate semantic restart.

### Stale revoke protection

Starting a client revoke raises a separate refresh barrier without advancing successful-mutation freshness. Pre-revoke snapshots wait behind that barrier while the revoke is pending. A rejected revoke releases them to apply normally; a successful revoke first advances the shared completion revision, then releases them so they are discarded before the revoke refresh renders the client absent.

### Completion-order freshness

Rejected callbacks and `ACTION_DISCARDED` outcomes return without advancing the successful-mutation revision. Consequently, a newer-started rejection cannot suppress an older successful refresh. Among successful callbacks, the callback that completes later receives the later revision even when it started first; its refresh is the authoritative rendered result. Toast and unauthorized-session behavior remain unchanged, and success is still reported only when that mutation's refresh applies.

## Focused verification

`apps/dashboard/src/lib/api.test.ts` covers safe and unsafe method classification, active/replaced/cleared sessions, mounted base paths, credentials, and abort forwarding.

`apps/dashboard/src/components/DashboardApp.test.tsx` renders and checks:

- restart pending state across Runtime page remounts, success refresh, rejection cleanup, and one semantic call;
- a stale role-change refresh resolving after revoke without restoring the client;
- a stale role-change refresh held during a pending revoke, then applied after that revoke rejects;
- an older successful refresh surviving a newer-started rejection;
- two successful actions completing opposite their start order, with final controls reflecting completion order.

The focused verification commands are:

```sh
pnpm --filter @caplets/dashboard test -- src/lib/api.test.ts src/components/DashboardApp.test.tsx
pnpm --filter @caplets/dashboard typecheck
```

Plan 000's integration gate reruns the full dashboard suite after the generated-client migration.

## Completion criteria

- Failed, unauthorized, and discarded work does not advance successful-mutation freshness.
- A later successful completion owns the rendered snapshot regardless of start order.
- A pending revoke cannot expose stale pre-revoke data, a rejected revoke does not suppress an older success, and a successful revoke prevents that data from restoring the client.
- Route-stable restart pending state and cleanup prevent duplicate restart submissions, including across dashboard navigation.
- Plan 009 contains characterization only and links this production prerequisite.
- The built dashboard behavior has a patch release note for `@caplets/core`.
