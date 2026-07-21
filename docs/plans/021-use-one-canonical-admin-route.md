# Plan 021: Use One Canonical Admin Route

> Status: IN PROGRESS
> Decision: ADR 0008
> Priority: P1
> Effort: L
> Fix risk: HIGH
> Depends on: Plans 000, 009, and 020

> **Pre-release integration:** This in-progress plan remains authoritative for exclusive credential-mode selection, dashboard-session same-origin and CSRF policy, one request authority, mutation finalization, and the one-time dashboard-cookie migration. After [Plan 022](022-remove-legacy-caplets-cloud.md) removes Legacy Caplets Cloud, [Plan 023](023-use-fixed-origin-protocol-namespaces.md) relocates the canonical Admin tree to `/api/v2/admin/*` and replaces this plan's service-root route locations, root OpenAPI location, deployment-prefix support, and frozen v1 Admin assumptions before the first release. Every old route is deleted without an alias, redirect, or fallback.

## Why this matters

Plan 000 delivered one Admin resource contract through two HTTP mounts: Operator bearers call `/v2/admin`, while the dashboard rewrites the same generated operations to `/dashboard/api/v2`. The handlers and semantic operations are shared, but the duplicate mount still creates two route identities, two discovery stories, two authentication compositions, extra dashboard URL rewriting, and a permanent opportunity for authorization behavior to drift.

ADR 0008 reverses ADR 0007's separate-mount decision before the v2 contract is released. Ordinary dashboard administration must call the canonical service-root `/v2/admin` tree directly. The route must select exactly one credential mode, preserve the stronger browser session and CSRF ceremony, and leave Raw Vault Reveal and session lifecycle ceremonies private.

This is a security-sensitive clean cutover. An invalid bearer must never fall through to a valid cookie, a session cookie must never authorize non-Admin bearer surfaces, and widening the cookie Path must not accidentally publish dashboard-private operations.

## Fixed decisions

1. `/v2/admin` is the only ordinary v2 Admin resource tree.
2. Any `Authorization` header selects bearer mode exclusively. Invalid bearer credentials fail without cookie fallback.
3. With no `Authorization` header, a `caplets_dashboard_session` cookie selects dashboard-session mode.
4. Session-authenticated requests are same-origin. Unsafe methods additionally require the current `X-Caplets-CSRF` value.
5. Verified-loopback `development_unauthenticated` mode is available only when neither supported credential is present.
6. The selected mode yields one request authority: an Operator principal plus an optional mode-specific post-mutation finalizer. Resource handlers do not branch on authentication mode.
7. Dashboard login, session restore, logout, and Raw Vault Reveal remain under unversioned `/dashboard/api/*` paths. They stay outside public OpenAPI and generated SDK operations.
8. The dashboard session cookie is host-only, HttpOnly, SameSite=Lax, and scoped to the configured service-root path.
9. Existing dashboard-path cookies migrate through session restore. The response expires the old path and reissues the same valid session credential at the service root.
10. The server injects the configured service-root path into dashboard HTML. The dashboard uses it for canonical Admin requests under deployment prefixes.
11. Public OpenAPI documents bearer and dashboard-session cookie authentication as alternatives. Unsafe Admin operations also document an optional `X-Caplets-CSRF` header whose runtime requirement is conditional on cookie mode.
12. No `/dashboard/api/v2` alias, redirect, deprecation route, or SDK facade survives the cutover.

## Scope

### In scope

- One canonical Admin route registration
- Explicit bearer/session/development credential selection
- Same-origin enforcement for dashboard-session requests
- Conditional CSRF enforcement on unsafe Admin methods
- Request-scoped mutation finalization for session-ending operations
- Service-root cookie issuance, migration, expiry, and rollback compatibility
- Dashboard HTML service-root metadata
- Dashboard generated-client transport cutover
- OpenAPI security alternatives and conditional CSRF documentation
- Generated OpenAPI and `@caplets/sdk` artifact refresh
- Removal of the duplicate service path, tests, helpers, and documentation
- Focused browser, HTTP, generated-contract, and full repository verification

### Out of scope

- Moving login, restore, logout, or Raw Vault Reveal into `/v2/admin`
- Bearer access to Raw Vault Reveal
- Dashboard sessions on MCP, Attach, Project Binding, Remote Login, or v1 Admin routes
- Cross-origin dashboard hosting or credentialed CORS
- A public dashboard-session convenience client in `@caplets/sdk`
- Changes to Remote Profile token formats or role semantics
- New session storage, database migrations, session-secret rotation, or timeout changes
- Removal of frozen `/v1/admin`
- Compatibility behavior at `/dashboard/api/v2`

## Current seams and drift checks

Before implementation, change this plan to `IN PROGRESS`, record `git rev-parse --short HEAD`, and confirm these contracts still exist:

- `packages/core/src/serve/http.ts`
  - `bearerAdminPrincipal`
  - `dashboardAdminPrincipal`
  - `operatorAdminV2RouteAuth`
  - two `createAdminV2Router(...)` compositions
  - `ServicePaths.dashboardV2`
  - dashboard login, session, logout, and private reveal routes
- `packages/core/src/admin-api/router.ts`
  - `AdminV2PrincipalProvider`
  - `CreateAdminV2RouterOptions.mutationResponseHeaders`
- `packages/core/src/admin-api/openapi.ts`
  - bearer-only default Admin security
  - `createRootOpenApiDocument()`
- `packages/core/src/dashboard/auth.ts`
  - cookie serializers parameterized by one path
- `packages/core/src/dashboard/session-store.ts`
  - durable session validation and Operator-client revalidation
- `packages/core/src/dashboard/routes.ts`
  - static HTML response ownership
- `apps/dashboard/src/components/DashboardHead.astro`
  - dashboard-base metadata
- `apps/dashboard/src/lib/api.ts`
  - generated Fetch Adapter rewriting `/v2/admin` to `/dashboard/api/v2`
- `apps/dashboard/src/lib/paths.ts`
  - deployment-prefix inference rooted at the dashboard path
- `scripts/generate-openapi.ts`
  - canonical OpenAPI and SDK artifact generation

Run these inventory checks:

```sh
rg -n 'dashboardV2|/dashboard/api/v2|dashboardAdminPrincipal|operatorAdminV2RouteAuth' packages apps scripts docs README.md CONTEXT.md
rg -n 'principalProvider|mutationResponseHeaders' packages/core/src packages/core/test
rg -n 'securitySchemes|bearerAuth|X-Caplets-CSRF' packages/core/src/admin-api packages/core/test/admin-api-openapi.test.ts
pnpm openapi:check
pnpm --filter @caplets/core test -- test/dashboard-session.test.ts test/admin-api-router.test.ts test/admin-api-openapi.test.ts
pnpm --filter @caplets/dashboard test -- src/lib/api.test.ts src/components/DashboardApp.test.tsx
```

Stop and mark the plan `STALE` if the Admin router is no longer mounted twice, the dashboard no longer consumes `@caplets/sdk`, the session store no longer validates the backing Operator Client, or generated artifacts are no longer owned by `scripts/generate-openapi.ts`.

## Target route map

| Route family                                    | Authentication                                       | OpenAPI / SDK                | Notes                                                    |
| ----------------------------------------------- | ---------------------------------------------------- | ---------------------------- | -------------------------------------------------------- |
| `/v2/admin/*`                                   | Operator bearer **or** same-origin dashboard session | Public                       | One resource tree and one handler registration           |
| `/v2/admin/backend-auth-flows/:flowId/callback` | Existing one-time OAuth callback state               | Public callback operation    | Do not force bearer/session auth onto provider callbacks |
| `/dashboard/api/login/*`                        | Existing pending-login ceremony                      | Private                      | Retains host protection and bounded bodies               |
| `/dashboard/api/session`                        | Dashboard session                                    | Private                      | Migrates cookie Path on successful restore               |
| `/dashboard/api/logout`                         | Dashboard session + CSRF                             | Private                      | Expires both current and legacy cookie paths             |
| `/dashboard/api/private/vault-reveals`          | Dashboard session + CSRF + confirmation              | Private                      | Never bearer-enabled or added to OpenAPI                 |
| `/dashboard/api/v2/*`                           | None                                                 | None                         | Unregistered; returns ordinary 404                       |
| `/v1/admin`                                     | Existing frozen v1 policy                            | Existing deprecated contract | Unchanged                                                |

All paths are relative to the configured service root. With `--base-path /tenant/tools`, for example, the canonical Admin path is `/tenant/tools/v2/admin`, the dashboard is `/tenant/tools/dashboard`, and private session restore remains `/tenant/tools/dashboard/api/session`.

## Authentication contract

### Credential selection

Select a mode before validating either credential:

```text
if request.headers.has("Authorization"):
  bearer mode
else if Cookie contains the caplets_dashboard_session name, even when malformed:
  dashboard-session mode
else if verified-loopback development_unauthenticated is configured:
  development mode
else:
  unauthenticated
```

Presence, not successful parsing, owns precedence. This prevents downgrade behavior.

| Inputs                                                            | Selected mode       | Result                                      |
| ----------------------------------------------------------------- | ------------------- | ------------------------------------------- |
| Valid Operator bearer, any cookie                                 | Bearer              | Operator principal; cookie and CSRF ignored |
| Valid Access bearer, valid session cookie                         | Bearer              | 403 Problem; no cookie fallback             |
| Missing/malformed/expired bearer, valid session cookie            | Bearer              | 401 Problem; no cookie fallback             |
| Empty `Authorization`, valid session cookie                       | Bearer              | 401 Problem; no cookie fallback             |
| No `Authorization`, valid session cookie, same-origin             | Session             | Operator principal                          |
| No `Authorization`, malformed/expired session cookie              | Session             | 401 Problem; no development fallback        |
| No supported credential, production auth                          | None                | 401 Problem                                 |
| No supported credential, verified loopback development mode       | Development         | Trusted development Operator principal      |
| Credential-free development request that is not verified loopback | Development attempt | 403 Problem                                 |

Retain `application/problem+json`, `Cache-Control: no-store`, and the existing stable `AUTH_REQUIRED` / `AUTH_FAILED` mapping. Do not return raw token, cookie, CSRF, session, or store diagnostics.

### Same-origin session policy

Apply browser provenance checks whenever a dashboard session authenticates a request, including private session/reveal/logout routes:

1. Compute the expected public origin through the existing trusted `publicOrigin` / `trustProxy` path; never trust arbitrary forwarded headers outside that policy.
2. If `Origin` is present, require an exact scheme/host/port match.
3. If `Sec-Fetch-Site` is present, require `same-origin`; reject `same-site`, `cross-site`, and `none` for API requests.
4. Require at least one accepted browser provenance signal. Cookie-only non-browser requests without `Origin` or `Sec-Fetch-Site` do not gain dashboard-session authority.
5. If both headers are present, both must pass.
6. Do not add CORS headers or preflight support for credentialed cross-origin callers.

Use a small pure predicate with table-driven tests. The production caller supplies only trusted expected-origin data.

### Conditional CSRF policy

Treat `GET`, `HEAD`, and `OPTIONS` as safe. For every other Admin method:

- session mode requires `X-Caplets-CSRF` to equal the current durable session value;
- bearer and development modes ignore the header and do not gain or lose authority from it;
- missing or stale session CSRF returns the existing 403 Problem before body parsing or semantic execution.

The private logout and Raw Vault Reveal routes retain the same unsafe-method rule and their current response/redaction behavior.

## Request authority and handler seam

Replace the principal-only provider plus router-wide mutation callback with a request-scoped authority contract in `packages/core/src/admin-api/router.ts`:

```ts
type AdminV2RequestAuthority = {
  principal: CurrentHostOperatorPrincipal;
  finalizeMutation?: (input: {
    operationId: string;
    outcome: Readonly<SemanticOutcome>;
  }) => Headers | Promise<Headers | undefined> | undefined;
};

type AdminV2AuthorityProvider = (
  request: Request,
  context: { readonly mutates: boolean },
) => AdminV2RequestAuthority | Promise<AdminV2RequestAuthority>;
```

The exact exported names may follow local naming, but preserve these invariants:

- The router resolves authority once per matched request.
- Validation, idempotency principal scoping, semantic execution, and activity attribution use `authority.principal` only.
- Resource handlers never inspect cookies, bearer headers, origin headers, or the selected mode.
- Only session mode supplies a finalizer.
- The finalizer runs only after a committed successful semantic mutation and only when the outcome has `sessionEnded === true`.
- Cleanup failure is reported through the existing safe error channel and must not replace a committed mutation response.
- Bearer and development requests never delete dashboard sessions or emit dashboard cookie headers.
- Finalizer headers support repeated `Set-Cookie` values; do not collapse them into `Record<string, string>`.
- Idempotency replay and failure behavior remain unchanged. Do not cache secrets or mode-specific cookie values in durable idempotency bodies.

Keep credential selection and same-origin checks in a focused Admin HTTP helper (for example `packages/core/src/admin-api/auth.ts`) and compose store/network dependencies in `serve/http.ts`. Do not create a second route router or mode-specific handler family.

## Cookie path and migration contract

### New issuance

Every new dashboard login issues:

```text
caplets_dashboard_session=<opaque>; Path=<service root>; HttpOnly; SameSite=Lax[; Secure]
```

`Secure` continues to use the existing trusted request/public-origin policy. Do not add `Domain`; the cookie remains host-only. Normalize the service-root path once: `/` stays `/`, and non-root paths have one leading slash and no trailing slash.

### Restore migration

A browser with the old `Path=<service root>/dashboard` cookie can still reach `/dashboard/api/session`. After successful durable validation, that response must:

1. preserve the existing session row, secret, CSRF value, absolute expiry, and response body;
2. append an expired cookie for the legacy dashboard path;
3. append the valid cookie value at the service-root path;
4. set `Cache-Control: no-store`;
5. avoid placing the cookie value in JSON, logs, errors, or activity metadata.

Reissuing changes cookie scope, not session identity or timeout semantics. The dashboard must complete restore before issuing Admin resource requests, so an old path-scoped cookie is migrated before `/v2/admin` is called.

### Logout and session-ending mutations

Successful logout, self-revoke, and self-demotion must:

- delete the durable dashboard session using the exact authenticated session;
- expire both service-root and legacy dashboard-path cookies with repeated `Set-Cookie` headers;
- preserve the committed Admin success response if best-effort cookie/session cleanup reporting fails;
- make subsequent canonical Admin and private restore requests fail authentication.

Revoking or demoting a different client does not end the acting dashboard session. A bearer actor never runs dashboard-session finalization, even when its own Remote Client mutation ends bearer authority.

A rollback to the prior server remains viable: a service-root cookie is also sent to the nested legacy dashboard path and uses the same cookie name and value format.

## Service-root bootstrap contract

Add a dedicated dashboard metadata value such as:

```html
<meta name="caplets-service-root-path" content="__CAPLETS_SERVICE_ROOT_PATH__" />
```

The existing dashboard-base metadata continues to own UI and private ceremony URLs. It must not be overloaded as the canonical service root.

`packages/core/src/dashboard/routes.ts` must inject the normalized `ServicePaths.base` value into HTML responses only:

- replace one exact build sentinel, not arbitrary user-controlled HTML;
- HTML-escape the trusted configured path before insertion;
- leave hashed JavaScript, CSS, icons, and other binary/static assets byte-for-byte untouched;
- keep HTML `no-store` and immutable asset caching unchanged;
- inject the same value into the unbuilt fallback shell;
- avoid a stale `Content-Length` after substitution.

The dashboard reads the injected path at request time and resolves it against `globalThis.location.origin`. The generated Admin Fetch Adapter keeps same-origin credentials, validates that generated operations remain under canonical `/v2/admin`, and prefixes them with the injected service root. It no longer rewrites to a dashboard API alias.

Examples:

| Page URL                                     | Injected service root | Generated Admin URL                       |
| -------------------------------------------- | --------------------- | ----------------------------------------- |
| `https://host/dashboard/access`              | `/`                   | `https://host/v2/admin/host`              |
| `https://host/tenant/tools/dashboard/access` | `/tenant/tools`       | `https://host/tenant/tools/v2/admin/host` |
| `http://127.0.0.1:5387/dashboard`            | `/`                   | `http://127.0.0.1:5387/v2/admin/host`     |

Private helpers continue to derive `/dashboard/api/login/*`, `/dashboard/api/session`, `/dashboard/api/logout`, and `/dashboard/api/private/*` from the dashboard base.

## OpenAPI and generated SDK contract

In `packages/core/src/admin-api/openapi.ts`:

1. Keep `bearerAuth` unchanged for existing bearer-only non-Admin surfaces.
2. Register `dashboardSession` as `type: apiKey`, `in: cookie`, `name: caplets_dashboard_session`.
3. Give protected Admin operations OR security:

   ```yaml
   security:
     - bearerAuth: []
     - dashboardSession: []
   ```

4. Keep the public backend OAuth callback operation unauthenticated.
5. Add a reusable optional `X-Caplets-CSRF` request-header schema to unsafe Admin operations only. Its description must say it is mandatory when `dashboardSession` is selected and ignored for bearer authentication.
6. Keep 401 and 403 Problem responses on every protected Admin operation.
7. Keep the relative server URL and deterministic document generation; request Host/proxy headers must not alter the artifact.
8. Do not add private dashboard ceremony paths to the document.

Run `pnpm openapi:generate`, inspect the generated auth metadata and operation inputs, and retain only generator-owned changes under `schemas/` and `packages/sdk/src/generated/`. The generated SDK must not attempt to synthesize or expose an HttpOnly cookie. Browser cookie transport remains Fetch `credentials: "same-origin"`; public bearer callers keep supplying auth through isolated SDK clients.

Do not create `createDashboardClient`, dashboard login methods, Raw Vault Reveal methods, or another generated client package.

## Implementation sequence

Follow red-green TDD at the public HTTP, generated contract, and browser Fetch seams. Keep each slice focused and run its test file before proceeding.

### 1. Freeze credential precedence and canonical route behavior

Add failing cases in `packages/core/test/dashboard-session.test.ts` (and a focused pure-helper test if a new auth helper is introduced) for:

- session GET succeeds at `/v2/admin/host` with same-origin provenance;
- `/dashboard/api/v2/host` returns 404;
- valid bearer plus invalid cookie uses bearer;
- invalid/malformed/empty bearer plus valid cookie returns 401 without fallback;
- Access bearer plus valid cookie returns 403 without fallback;
- malformed session cookie does not reach development fallback;
- credential-free verified loopback development request still succeeds;
- same-site/cross-site/mismatched-origin and provenance-free cookie requests fail;
- safe session reads need no CSRF;
- unsafe session mutations reject missing/stale CSRF before semantic execution;
- bearer mutations ignore an arbitrary CSRF header.

Implement the pure mode selector, same-origin predicate, request authority, and one canonical router composition. Delete `operatorAdminV2RouteAuth`, `bearerAdminPrincipal`, and `dashboardAdminPrincipal` only after their policy is represented once in the new provider.

Run:

```sh
pnpm --filter @caplets/core test -- test/dashboard-session.test.ts test/admin-api-router.test.ts
pnpm --filter @caplets/core typecheck
```

### 2. Preserve request-scoped session finalization

Add failing integration cases for:

- session-authenticated self-revoke;
- session-authenticated self-demotion;
- mutation of another client;
- bearer self-revoke with no dashboard cookie finalizer;
- cleanup failure after committed success;
- repeated `Set-Cookie` preservation.

Deepen the router authority seam and move the existing `sessionEnded` cleanup into the selected session authority. Do not infer mode later from request headers.

Run:

```sh
pnpm --filter @caplets/core test -- test/dashboard-session.test.ts test/admin-api-router.test.ts test/dashboard-activity.test.ts
pnpm --filter @caplets/core typecheck
```

### 3. Change cookie scope and migrate installed sessions

Add failing serializer/session tests for root and prefixed service roots, Secure behavior, restore migration, duplicate-path expiry, logout, self-revoke, self-demotion, and rollback-compatible parsing.

Update `packages/core/src/dashboard/auth.ts`, the login/session/logout composition, and the session authority finalizer. Use append semantics for repeated `Set-Cookie`. Do not regenerate session secrets or write new session rows during restore.

Run:

```sh
pnpm --filter @caplets/core test -- test/dashboard-session-store.test.ts test/dashboard-session.test.ts
pnpm --filter @caplets/core typecheck
```

### 4. Inject service-root metadata and cut over the browser client

Add failing tests in:

- `packages/core/test/dashboard-static.test.ts` for HTML-only prefix injection and unchanged assets;
- `apps/dashboard/src/lib/api.test.ts` for root/prefixed canonical URLs, same-origin credentials, safe/unsafe CSRF, and escape rejection;
- `apps/dashboard/src/components/DashboardApp.test.tsx` for restore-before-Admin behavior and session-ended UI state.

Update `DashboardHead.astro`, `paths.ts`, and `api.ts`. Preserve the generated operations and existing dashboard domain wrappers; remove only alias path rewriting. Private ceremony functions must continue using dashboard-private URLs.

Run:

```sh
pnpm --filter @caplets/core test -- test/dashboard-static.test.ts test/dashboard-ui.test.ts
pnpm --filter @caplets/dashboard test -- src/lib/api.test.ts src/components/DashboardApp.test.tsx
pnpm --filter @caplets/dashboard typecheck
```

### 5. Remove the duplicate mount and migrate integration fixtures

Delete `ServicePaths.dashboardV2` and the second `createAdminV2Router(...)` registration. Update dashboard integration helpers and direct requests in:

- `packages/core/test/dashboard-api.test.ts`
- `packages/core/test/dashboard-activity.test.ts`
- `packages/core/test/dashboard-catalog.test.ts`
- `packages/core/test/dashboard-runtime.test.ts`
- `packages/core/test/dashboard-session.test.ts`
- `packages/core/test/dashboard-vault.test.ts`
- `packages/core/test/serve-http.test.ts`
- relevant Admin router location/reconciliation tests

Do not mechanically change private login/session/logout/reveal paths. Retain one explicit legacy-path 404 assertion.

Run:

```sh
pnpm --filter @caplets/core test -- test/dashboard-api.test.ts test/dashboard-activity.test.ts test/dashboard-catalog.test.ts test/dashboard-runtime.test.ts test/dashboard-session.test.ts test/dashboard-vault.test.ts test/serve-http.test.ts test/admin-api-router.test.ts
pnpm --filter @caplets/core typecheck
```

### 6. Publish the dual-auth canonical contract

Add OpenAPI assertions before changing the document:

- every protected `/v2/admin` operation has bearer-or-cookie security;
- unsafe operations expose optional `X-Caplets-CSRF` with conditional semantics;
- safe operations do not advertise CSRF;
- callback security remains empty;
- no `/dashboard/api/v2` or private dashboard path appears;
- cookie scheme name and location are exact;
- generated document remains deterministic and runtime `/openapi.json` parity remains green.

Regenerate OpenAPI and SDK output, inspect HeyAPI's auth handling, and update dashboard imports/types only if generation changes them.

Run:

```sh
pnpm --filter @caplets/core test -- test/admin-api-openapi.test.ts test/serve-http.test.ts
pnpm openapi:generate
pnpm openapi:check
pnpm --filter @caplets/sdk build
pnpm --filter @caplets/sdk test
pnpm typecheck
```

### 7. Update durable documentation and release metadata

After behavior and generated artifacts are green:

- update `CONTEXT.md` so Admin API means one canonical resource URL with distinct credential modes;
- update `README.md`, `docs/architecture.md`, and `docs/product/current-host-admin-api.md`;
- update `packages/sdk/README.md` and `apps/docs/src/content/docs/sdk.mdx` where dashboard transport or authentication is described;
- update pending Plan 010 so dashboard-private contracts exclude the canonical Admin tree rather than a duplicate mount;
- retain Plans 000 and 020 as historical implementation records;
- retain ADR 0007 with `Status: superseded by ADR 0008`;
- update the existing unreleased `.changeset/current-host-admin-api.md` instead of adding a second version bump;
- mark this plan `COMPLETE` only after all acceptance checks pass.

Run:

```sh
pnpm docs:check
pnpm changeset status --since=origin/main
```

## Verification matrix

### Focused HTTP and security checks

```sh
pnpm --filter @caplets/core test -- \
  test/admin-api-router.test.ts \
  test/admin-api-openapi.test.ts \
  test/dashboard-session-store.test.ts \
  test/dashboard-session.test.ts \
  test/dashboard-api.test.ts \
  test/dashboard-activity.test.ts \
  test/dashboard-catalog.test.ts \
  test/dashboard-runtime.test.ts \
  test/dashboard-vault.test.ts \
  test/dashboard-static.test.ts \
  test/serve-http.test.ts
```

### Dashboard and SDK checks

```sh
pnpm --filter @caplets/dashboard test -- src/lib/api.test.ts src/components/DashboardApp.test.tsx
pnpm --filter @caplets/dashboard typecheck
pnpm --filter @caplets/sdk test
pnpm --filter @caplets/sdk typecheck
pnpm openapi:check
```

### Runtime smoke

Build first, then exercise one real server under a non-root base path:

1. Open `/tenant/tools/dashboard` in Chromium.
2. Complete or seed the existing Operator login ceremony.
3. Observe successful session restore and two cookie migration headers when starting from a legacy dashboard-path cookie.
4. Confirm the browser requests `/tenant/tools/v2/admin/host`, never `/tenant/tools/dashboard/api/v2/host`.
5. Confirm GET has no CSRF header and an unsafe mutation has exactly one current CSRF header.
6. Confirm Raw Vault Reveal still calls `/tenant/tools/dashboard/api/private/vault-reveals` and is absent from the SDK/OpenAPI.
7. Confirm a cross-origin browser request cannot use the session.
8. Confirm logout and self-demotion/revoke clear the UI session and make the next canonical request return 401.
9. Confirm direct `/tenant/tools/dashboard/api/v2/host` returns 404.
10. Repeat the URL/cookie assertions with service root `/` to catch double-slash and root-Path defects.

Capture request URLs, statuses, response media types, and cookie attributes. Do not capture credential values.

### Full gate and review

```sh
pnpm verify
```

Run the repository code-review workflow against the implementation base. Review security/standards and this plan independently. Resolve every actionable finding, rerun the affected focused checks, then rerun `pnpm verify` once if fixes changed behavior or generated artifacts.

## Machine-checkable acceptance criteria

- Exactly one ordinary Admin router is registered.
- `/v2/admin` accepts valid Operator bearer or same-origin dashboard-session authority.
- Any `Authorization` header prevents cookie and development fallback.
- Session-cookie presence prevents development fallback even when malformed.
- Access bearer credentials cannot invoke Admin resources.
- Session-authenticated requests reject mismatched browser provenance.
- Session unsafe methods require current CSRF; safe methods do not.
- Bearer requests ignore cookie and CSRF inputs.
- Resource handlers consume one Operator principal and contain no mode branches.
- Session mutation finalization is request-scoped and preserves repeated cookie headers.
- New login cookies use the configured service-root Path.
- Restore migrates legacy dashboard-path cookies without changing session identity.
- Logout and acting-session revoke/demotion delete the durable session and expire both cookie paths.
- Dashboard HTML receives the configured service-root metadata; non-HTML assets are unchanged.
- Dashboard generated operations target the prefixed canonical `/v2/admin` path with same-origin credentials.
- Login/session/logout and Raw Vault Reveal remain private under `/dashboard/api/*`.
- `/dashboard/api/v2/*` has no alias and returns 404.
- OpenAPI expresses bearer OR cookie security and conditional unsafe-method CSRF.
- Generated OpenAPI and SDK artifacts are current.
- Root and non-root deployment-prefix tests pass.
- Current product, architecture, SDK, plan-index, and release docs describe one canonical route.
- Focused suites, runtime/browser smoke, code review, and `pnpm verify` pass.

## Failure and rollback notes

The highest-risk failures are credential downgrade, cookie shadowing during Path migration, collapsed `Set-Cookie` headers, false same-origin decisions behind trusted proxies, session cleanup after committed mutations, generated-client cookie handling, and stale deployment-prefix metadata. Each has a focused pre-implementation regression above.

There is no feature flag and no compatibility alias. Roll back the release as one unit if canonical cookie authentication fails in production. Service-root cookies remain readable by the prior nested dashboard routes, so the cookie format itself does not block rollback. Do not respond by restoring `/dashboard/api/v2` as an emergency permanent alias; diagnose the selector, cookie, origin, or injected-root defect at its owning seam.
