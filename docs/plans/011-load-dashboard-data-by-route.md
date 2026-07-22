# Plan 011: Load Admin Resources By Route And Mutation Impact

> Status: TODO
> Planned against: `ac12a174`
> Finding: #10 — every route and mutation reloads the full dashboard resource set
> Priority: P1
> Effort: M
> Fix risk: MEDIUM
> Depends on: Plans 000, 009, and 010

## Why this matters

`DashboardApp.refresh()` currently launches the full dashboard request set on initial load and after most mutations. Plan 000 changes those requests to cursor-based generated Admin operations, but intentionally may preserve broad refresh behavior during the transport migration. Revalidating every collection would continue multiplying session validation, database reads, cursor first-page work, and browser state churn.

The dashboard should request only the Admin resources rendered by the active route and invalidate only resources affected by a mutation.

## Scope

### In scope

- `apps/dashboard/src/components/DashboardApp.tsx`
- A dashboard-local resource loader/hook
- Generated Admin SDK call integration
- Private contract integration only where the active route needs it
- Dashboard component/resource-loader tests

### Out of scope

- Backend aggregate endpoints
- Changes to canonical Admin route/DTO shapes
- Caching across browser reloads, sessions, or users
- Service workers, React Query, or another state-management dependency
- Removing genuine Overview data
- Caching Raw Vault Reveal

## Required design

Define resources by stable Admin `operationId`/domain identity, not URL strings:

```ts
type DashboardResource =
  | "host"
  | "caplets"
  | "catalogUpdateCandidates"
  | "remoteClients"
  | "remoteLoginRequests"
  | "vaultValues"
  | "vaultGrants"
  | "runtime"
  | "diagnostics"
  | "activity"
  | "logs"
  | "projectBinding";
```

Use execution-time generated operation names and actual visible routes; the example is not a fixture.

Rules:

1. `resourcesByRoute` declares the exact first pages/detail resources needed to render each route and shell.
2. Each resource owns independent `idle | loading | ready | error` state, data, cursor state, generation, and stale flag.
3. Navigation aborts obsolete requests, loads missing/stale resources for the next route, and cannot let an old response overwrite a new session or generation.
4. Returning to a route may render cached in-session data while revalidating only resources marked stale.
5. Cursor pages append only when their normalized filter/sort identity matches; a filter change clears prior pages and cursors.
6. Mutation definitions declare exact invalidations. Role change/revoke invalidates client and host views; Vault mutation invalidates relevant value/grant and host views; catalog install/update invalidates Caplets, update candidates, and affected catalog/install views; runtime restart invalidates runtime/diagnostics.
7. A mutation generates one idempotency key per user intent and retains it for transport retries. UI revalidation uses new GET requests, not the mutation key.
8. Success is announced after visible invalidated resources revalidate. Invisible resources remain stale until visited.
9. 412 refreshes the affected stable detail and asks the user to retry; it does not silently replay a mutation with a new ETag.
10. An idempotency `unknown` Problem Details response shows the reconciliation state/links; it does not announce failure or retry automatically.
11. Raw Vault Reveal bypasses the resource cache and is cleared by its existing timer, navigation, session change, and unmount rules.
12. Overview may still need many resources. Preserve what it visibly renders.

Keep the loader local and boring. Do not wrap the generated SDK in a second generic data-fetching framework.

## Implementation steps

1. Add failing request-set tests for `/dashboard/access`, `/dashboard/vault`, `/dashboard/runtime`, a Catalog route, and Overview. Assert semantic operation sets, not Promise order or raw paths.
2. Add the resource state machine with per-resource generations, abort controllers, first-page cursor identity, and session reset.
3. Replace broad initial refresh with route requirements.
4. Add an explicit mutation-to-invalidation map and migrate every mutation.
5. Cover navigation races, session replacement, partial failures, pagination, 412 refresh guidance, idempotency unknown reconciliation, and private reveal exclusion.
6. Delete the old all-resource `refresh()` and duplicated loading/error flags.

## Verification

```sh
pnpm --filter @caplets/dashboard test -- src/components/DashboardApp.test.tsx
pnpm --filter @caplets/dashboard test
pnpm --filter @caplets/dashboard typecheck
pnpm --filter @caplets/dashboard build
pnpm format:check
pnpm lint
```

Browser smoke against a built server:

- load Access and observe only shell + remote-client/login operations;
- navigate to Vault and observe only missing Vault resources;
- mutate one grant and observe only declared visible invalidations;
- navigate rapidly and confirm stale responses do not flash;
- paginate a collection, change filters, and confirm pages do not mix;
- trigger a synthetic 412 and idempotency-unknown response and confirm no silent mutation replay;
- reveal a Vault value, navigate, and confirm it is gone.

## Completion criteria

- Narrow routes no longer load the full Admin resource set.
- Every mutation declares invalidations and retry identity explicitly.
- Independent resource failures do not erase unrelated state.
- Cursor/filter/session generations prevent stale mixing.
- ETag and idempotency conflicts produce explicit safe UI states.
- Raw Vault Reveal never enters shared resource state.
- Old broad refresh code is deleted.
- Tests, typecheck, build, browser smoke, format, and lint pass.

## Maintenance note

Every dashboard page declares what it reads; every mutation declares what it invalidates. New routes and actions update those maps and add one semantic request-set assertion.
