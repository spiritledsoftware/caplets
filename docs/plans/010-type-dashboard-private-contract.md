# Plan 010: Type Dashboard-Private HTTP Contracts

> Status: TODO
> Planned against: `ac12a174`
> Finding: #13 — browser-private projections and frontend response types can drift silently
> Priority: P1
> Effort: S
> Fix risk: LOW
> Depends on: Plans 000, 009, and 021

## Why this matters

Plan 000 replaces shared Current Host resources with the OpenAPI/HeyAPI Caplets SDK client. Dashboard login/session ceremony and Raw Vault Reveal intentionally remain browser-private and excluded from the public root OpenAPI document. Those residual routes still need one compiler-linked contract; otherwise removing the old generic `dashboardApi<T>` only moves unchecked casts to the private path.

This plan types the small private boundary without creating a second public API or pulling server runtime modules into the browser.

## Scope

### In scope

- Browser-private dashboard login start/poll/complete and active-session/logout contracts
- `/dashboard/api/private/vault-reveals`
- One type-only contract module under `packages/core/src/dashboard/`
- Server response conformance at the private route handlers
- A small path-aware private dashboard client
- Core/dashboard type and behavior tests
- A patch changeset only if a new public `@caplets/core` export is required

### Out of scope

- Canonical `/v2/admin` resources; Plan 021's generated Caplets SDK transport owns them
- Adding private routes to `/openapi.json`
- Changing login, cookie, CSRF, reveal confirmation, expiry, or redaction behavior
- Dashboard loading/caching; Plan 011 owns it
- UI redesign or copy snapshots

## Required design

Create an exact contract map keyed by private operation name. Each entry fixes method, path parameters, request body, success response, and expected safe error shape. DTOs are JSON-safe and model real optionality only.

The authoritative source stays beside core's private route projections. Dashboard imports it with `import type`; no Node-only module or Zod runtime enters the browser bundle. The private client exposes named methods rather than a caller-selected generic:

```ts
type DashboardPrivateApiContract = {
  loginStart: { method: "POST"; request: LoginStartRequest; response: LoginStartResponse };
  loginPoll: { method: "POST"; request: LoginPollRequest; response: LoginPollResponse };
  loginComplete: { method: "POST"; request: LoginCompleteRequest; response: SessionResponse };
  session: { method: "GET"; response: SessionResponse };
  logout: { method: "POST"; response: LogoutResponse };
  revealVaultValue: {
    method: "POST";
    request: RevealVaultValueRequest;
    response: RevealVaultValueResponse;
  };
};
```

Use actual route inventory at execution; do not invent an operation absent from the running server. If poll/complete responses are discriminated, preserve each state as a discriminated union rather than optional fields.

Private unsafe calls continue through the existing dashboard CSRF/session Adapter. Reveal responses remain `Cache-Control: no-store`, exist only in ephemeral component state, and never enter a generic cache.

## Implementation steps

1. Inventory private routes left after Plan 000 and add failing type fixtures for one nullable/discriminated response.
2. Add the core type-only contract and package export if needed.
3. Type each core private route projection with `satisfies` or an exact helper; reject excess fields at compile time.
4. Replace residual generic casts in the dashboard with named private client methods.
5. Update Plan 009 transport fixtures while preserving all rendered behavior tests.
6. Add one server/client compatibility test for every private operation and a build assertion that the browser bundle does not import core server code or Zod through this subpath.

Do not generate a second OpenAPI document for private routes. Do not add a generalized endpoint framework for six operations.

## Verification

```sh
pnpm --filter @caplets/core test -- test/serve-http.test.ts
pnpm --filter @caplets/dashboard test -- src/lib/api.test.ts src/components/DashboardApp.test.tsx
pnpm --filter @caplets/core typecheck
pnpm --filter @caplets/dashboard typecheck
pnpm --filter @caplets/dashboard build
pnpm format:check
pnpm lint
```

## Completion criteria

- Shared Admin resources use only Plan 000's generated client.
- Every remaining dashboard-private route has one exact type-only contract and named client method.
- Server projections and browser consumers compile against the same DTOs.
- No generic caller-selected response cast remains.
- Private routes remain absent from root OpenAPI and generated HeyAPI artifacts.
- Login/session/CSRF/reveal behavior from Plan 009 is unchanged.
- Focused tests, typechecks, dashboard build, format, and lint pass.

## Maintenance note

New Current Host resources belong in the canonical Admin API. A dashboard-private contract is justified only for browser ceremony that cannot be shared with Operator bearer clients.
