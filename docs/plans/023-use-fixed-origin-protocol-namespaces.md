# Plan 023: Use Fixed-Origin Protocol Namespaces

> Status: DONE
> Planned against: `ac12a174`
> Direction: make a Current Host an origin with fixed, disjoint protocol namespaces
> Priority: P0
> Effort: XL
> Fix risk: HIGH
> Depends on: Plans 000, 020, 021, and 022
> Release gate: **REQUIRED BEFORE THE FIRST PUBLIC RELEASE**

## Why this matters

The current HTTP interface treats a Current Host URL as a configurable service-root URL. `serve.path`, `--path`, and URL-path-preserving helpers can move every protocol beneath an arbitrary prefix. MCP, the public HTTP API, dashboard pages, dashboard-private ceremonies, generated SDK operations, CLI adapters, native/daemon clients, and deployment health checks consequently reconstruct related paths in different modules. The same origin may also mean a Current Host, a particular MCP endpoint, or an old hosted workspace URL depending on the caller.

That is too much interface for callers and too little locality for maintainers. A Current Host must have one meaning: an HTTP(S) **Current Host Origin**. Protocols then occupy fixed, disjoint **Protocol Namespaces** on that origin. This cutover creates one deep route-topology Module whose small interface owns those namespace roots, strict path construction, and origin validation. Server composition, OpenAPI, generated clients, handwritten clients, the dashboard, native/daemon adapters, and deployments consume that seam instead of independently appending strings.

This is a clean P0 pre-release cutover. There are no aliases, redirects from old protocol paths, negotiated versions, path-prefix fallbacks, or legacy v1 Admin adapter. Old clients fail visibly with 404 rather than appearing to work against a subtly different contract.

## Prerequisites and release rule

Complete these plans first:

- [Plan 000](000-migrate-admin-api.md): authoritative v2 Admin resource semantics.
- [Plan 020](020-publish-caplets-sdk.md): independently published generated SDK package.
- [Plan 021](021-use-one-canonical-admin-route.md): one Admin route with exclusive bearer/session credential selection.
- [Plan 022](022-remove-legacy-caplets-cloud.md): remove hosted/Cloud modes while preserving generic Current Host remotes and unrelated Cloudflare/Alchemy deployment infrastructure.

Do not begin this plan with any prerequisite incomplete on the implementation branch. Do not release a package, container, CLI, SDK, dashboard, or native artifact after Plans 000–022 but before this plan is complete. Plan 000's frozen v1 Admin compatibility and Plans 020/021's service-root/base-path support are historical decisions superseded by this final pre-release cutover.

## Fixed vocabulary and invariants

### Current Host Origin

A **Current Host Origin** is the canonical `URL.origin` of a Current Host:

```text
https://host.example
https://host.example:8443
http://127.0.0.1:5387   # loopback development only
```

It has a scheme, host, and optional port. It has no username, password, non-root path, query, or fragment. Input ending in the URL root slash is accepted and normalized to `URL.origin`; any non-root pathname is rejected, not trimmed. HTTPS remains mandatory except for the existing loopback-development allowance. Remote profile values, SDK `baseUrl`, CLI URL arguments, `CAPLETS_SERVER_URL`, public origins, host identity, and credential audience all use this definition.

`baseUrl` in public types and prose means the Current Host Origin. Remove the ambiguous terms _service root_, _base path_, _host URL with path_, and _endpoint URL_ when they refer to the host as a whole.

### Protocol Namespace

A **Protocol Namespace** is a fixed origin-root path allocated to one protocol interface. The namespace is not configuration and cannot be relocated by a caller, reverse-proxy prefix, deployment setting, or SDK base URL.

| Namespace              | Owner               | Included interface                                                      |
| ---------------------- | ------------------- | ----------------------------------------------------------------------- |
| `/.well-known/caplets` | Caplets discovery   | Minimal cross-protocol link document                                    |
| `/api`                 | Caplets HTTP API    | API discovery, OpenAPI, v1 non-Admin HTTP resources, v2 Admin resources |
| `/mcp`                 | MCP Streamable HTTP | Exact unversioned MCP endpoint                                          |
| `/dashboard`           | Dashboard           | Browser pages, dashboard assets, and dashboard-private ceremonies       |

The namespaces are disjoint. MCP is not an API-version child. Dashboard-private routes are not Admin aliases. Well-known discovery is not an OpenAPI operation. No protocol is mounted at `/tenant/tools`, `/v1` at the origin root, or another configurable prefix.

### Strict path matching

- Every path in this plan is origin-relative and begins with exactly one `/`.
- Canonical paths have no trailing slash. `/dashboard/`, `/api/`, `/api/v1/`, `/mcp/`, and resource slash variants return ordinary 404.
- Percent-encoded or multiply slashed forms do not normalize into a canonical route.
- Old and slash-variant paths are not redirected and do not emit deprecation headers.
- Unsupported methods on a canonical path return 405 with `Allow`; an unknown, old, malformed, or slash-variant path returns 404 with `application/json`, `Cache-Control: no-store`, and exactly `{ "error": "not_found" }`.
- Query strings do not change route identity. Handlers continue to validate only their declared query fields.

## Source-evidence inventory and drift checks

Before implementation, change this plan to `IN PROGRESS`, record the actual short commit, and confirm the following evidence still exists. Mark the plan `STALE` if the topology, generated-artifact ownership, or prerequisite contracts have materially changed.

| Area                | Current evidence at `ac12a174`                                                                                                                                                                                                                                                                                | Required disposition                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Server topology     | `packages/core/src/serve/http.ts` has `routePath`, `ServicePaths`, and parameterized `servicePaths(base)`; it mounts discovery, OpenAPI, health, dashboard, remote login, `/v1/mcp`, Attach, project binding, `/v1/admin`, and `/v2/admin`.                                                                   | Replace the parameterized prefix graph with the fixed topology seam and the matrix below.                                        |
| Serve configuration | `packages/core/src/serve/options.ts` exposes `RawServeOptions.path`, `HttpServeOptions.path`, `--path` error labels, `CAPLETS_SERVER_URL` pathname fallback, and normalization. `packages/core/src/config.ts` accepts `serve.path`.                                                                           | Delete path configuration and reject non-origin server URLs.                                                                     |
| CLI/daemon          | `packages/core/src/cli.ts` declares visible and hidden `--path` options and appends `v1/remote/*`; `packages/core/src/daemon/client-url.ts`, `daemon/process.ts`, `daemon/index.ts`, and `daemon/validation.ts` carry `serve.path`.                                                                           | Remove the option/state and consume fixed route builders.                                                                        |
| Handwritten clients | `packages/core/src/server/options.ts` and `remote/options.ts` preserve a URL pathname and append `v1/mcp`, `v1/attach`, `v1/admin`, and `v1/healthz`. Project Binding and Remote Login add further literals.                                                                                                  | Parse an origin once; derive only fixed canonical paths; delete control/v1 Admin fallbacks.                                      |
| MCP                 | `packages/core/src/serve/http.ts` mounts `app.all(paths.mcp)` and composes `@hono/mcp` `StreamableHTTPTransport` sessions.                                                                                                                                                                                    | Mount the same protocol semantics only at `/mcp`; make supported methods and session failures explicit.                          |
| Public API/OpenAPI  | `packages/core/src/admin-api/openapi.ts` registers `/`, `/v1`, `/v2`, `/v1/healthz`, Remote Login, Attach, Project Binding, frozen `/v1/admin`, and `/v2/admin/*`; its server URL is the configurable service root. `openapi-representation.ts` owns deterministic bytes/ETag.                                | Retarget public paths under `/api`, delete v1 Admin and `/api/v2` discovery, keep deterministic representation behavior.         |
| Generation/SDK      | `scripts/generate-openapi.ts` writes `schemas/caplets-http.openapi.json` and `packages/sdk/src/generated/`; generated operation paths are `/v1/*` and `/v2/admin/*`. `packages/sdk/src/index.ts` accepts path-bearing `baseUrl`.                                                                              | Generate `/api/*`, remove v1 Admin types/functions, and require an origin.                                                       |
| Dashboard           | `apps/dashboard/src/lib/paths.ts` reads injected service-root metadata; `api.ts` prefixes/restricts generated `/v2/admin`; `packages/core/src/dashboard/routes.ts` rewrites root `/_astro/*` references and injects the service root.                                                                         | Remove service-root inference; use current origin, `/api/v2/admin`, `/dashboard/api`, and `/dashboard/_astro`.                   |
| OAuth/cookies       | `serve/http.ts` exposes both v2 and legacy v1 backend-auth callbacks. `storage/backend-auth-flows.ts` persists pending/completing claims. Dashboard cookies already migrate from dashboard Path to service-root Path.                                                                                         | Keep only the new callback; atomically terminalize pre-cutover flows; retain session identity while fixing cookie Path to `/`.   |
| Native              | `packages/core/src/native/options.ts`, `native/remote.ts`, `native/service.ts`, and native tests compose or consume Current Host URLs and legacy client adapters.                                                                                                                                             | Make every Current Host input an origin and remove v1 Admin fallback.                                                            |
| Deployment          | `Dockerfile` and compose files use origin-shaped `CAPLETS_SERVER_URL` but probe `/v1/healthz`. Config examples and generated references still describe a serve path.                                                                                                                                          | Probe `/api/v1/healthz`; remove path configuration from examples/schemas. Preserve unrelated Alchemy/Cloudflare deployment code. |
| Verification        | `serve-http.test.ts`, `serve-options.test.ts`, `server-options.test.ts`, `remote-options.test.ts`, `dashboard-static.test.ts`, `dashboard-session.test.ts`, `admin-api-openapi.test.ts`, `public-v1-openapi-runtime-parity.test.ts`, SDK tests, and `scripts/check-package-runtime.mjs` pin the old topology. | Convert them to positive canonical and negative old/slash-path contracts.                                                        |

Run the inventory before editing:

```sh
git rev-parse --short HEAD
rg -n 'servicePaths|routePath|basePath|service root|serve\.path|--path' packages apps scripts docs README.md CONTEXT.md config.example.json
rg -n '(/v1/mcp|/v1/admin|/v1/attach|/v1/healthz|/v2/admin|/openapi\.json|/_astro)' packages apps scripts schemas Dockerfile docker-compose*.yml docs README.md CONTEXT.md
rg -n 'controlUrl|mcpUrl|attachUrl|healthUrl|projectBindingWebSocketUrl|appendBasePath' packages/core packages/sdk
pnpm openapi:check
```

Stop rather than improvising if Plan 021's exclusive Admin credential selection is absent, Plan 022 has not removed hosted modes, OpenAPI no longer owns SDK generation, the dashboard no longer consumes `@caplets/sdk`, or MCP is no longer Streamable HTTP.

## Exact route, authentication, and exposure matrix

### Top-level routes

| Method and canonical path              | Authentication                                                                | Exposure                 | Cache / response                                                                      | OpenAPI / SDK                                       |
| -------------------------------------- | ----------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `GET /`                                | Public                                                                        | Browser entry            | `302 Found`, `Location: /dashboard`, `Cache-Control: no-store`; no HTML/body contract | Excluded                                            |
| `GET /.well-known/caplets`             | Public                                                                        | Cross-protocol discovery | Deterministic JSON, strong ETag, revalidation cache contract below                    | Excluded from both                                  |
| `GET /api`                             | Public                                                                        | API discovery            | JSON, `Cache-Control: no-store`                                                       | Included in OpenAPI and SDK                         |
| `GET /api/openapi.json`                | Public                                                                        | OpenAPI 3.1 artifact     | Deterministic bytes, strong ETag, conditional 304                                     | The serving route itself is excluded from paths/SDK |
| `GET /api/v1`                          | Public                                                                        | v1 API discovery         | JSON, `Cache-Control: no-store`                                                       | Included                                            |
| `/api/v1/*` listed below               | Per operation                                                                 | Public HTTP API          | Existing operation semantics at new path                                              | Included except WebSocket messages                  |
| `/api/v2/admin/*` listed by Plan 000   | Per Plan 021                                                                  | Public Admin HTTP API    | Existing v2 resource semantics at new path                                            | Included                                            |
| `POST`, `GET`, `DELETE /mcp`           | Access or Operator bearer; verified-loopback development mode when configured | MCP only                 | Streamable HTTP contract below                                                        | Excluded from both                                  |
| `GET /dashboard` and listed page paths | Public                                                                        | Browser UI               | HTML `Cache-Control: no-store`                                                        | Excluded from both                                  |
| `GET /dashboard/_astro/{asset}`        | Public                                                                        | Hashed dashboard assets  | Existing content type; `public, max-age=31536000, immutable`                          | Excluded from both                                  |
| `/dashboard/api/*` listed below        | Dashboard ceremony/session authority                                          | Browser-private          | `Cache-Control: no-store` for sensitive responses                                     | Excluded from both                                  |

`HEAD` mirrors each canonical public `GET` response's status and headers with no body. No wildcard registration may make an unlisted protocol route valid. In particular, there is no `GET /api/v2`, no ordinary resource at `/api/v2/admin`, and no root landing document.

### v1 public HTTP routes under `/api`

This is the complete surviving v1 route set. Plan 023 moves it; it does not redesign its bodies.

| Method and canonical path                                    | Authority / protection                                   | Notes                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /api/v1/healthz`                                        | Public                                                   | Existing readiness body and 200/503 behavior.                               |
| `POST /api/v1/remote/login/start`                            | Public pending-login ceremony + existing host protection | Bounded JSON.                                                               |
| `POST /api/v1/remote/login/poll`                             | Pending completion secret + existing host protection     | No bearer requirement.                                                      |
| `POST /api/v1/remote/login/refresh`                          | Pending refresh credential + existing host protection    | No bearer requirement.                                                      |
| `POST /api/v1/remote/login/complete`                         | Pending completion secret + existing host protection     | Issues client credentials.                                                  |
| `POST /api/v1/remote/login/cancel`                           | Pending completion secret + existing host protection     | Terminalizes the pending login.                                             |
| `POST /api/v1/remote/refresh`                                | Refresh-token family authority                           | Existing rotation/replay semantics.                                         |
| `DELETE /api/v1/remote/client`                               | Valid Access or Operator bearer                          | Credential-owner self-revocation only.                                      |
| `POST /api/v1/attach/sessions`                               | Access or Operator bearer + existing host protection     | Mounted only when the configured runtime supports explicit Attach sessions. |
| `DELETE /api/v1/attach/sessions/{sessionId}`                 | Access or Operator bearer + existing host protection     | Owner-scoped existing semantics.                                            |
| `GET /api/v1/attach/manifest`                                | Access or Operator bearer + existing host protection     | Existing default/explicit Attach session selection.                         |
| `GET /api/v1/attach/events`                                  | Access or Operator bearer + existing host protection     | Existing SSE and bounded-session behavior.                                  |
| `POST /api/v1/attach/invoke`                                 | Access or Operator bearer + existing host protection     | Existing bounded request and export semantics.                              |
| `GET /api/v1/attach/project-bindings/connect`                | Access or Operator bearer                                | HTTP WebSocket upgrade using `caplets.project-binding.v1`.                  |
| `POST /api/v1/attach/project-bindings/sessions`              | Access or Operator bearer                                | Existing binding creation semantics.                                        |
| `GET /api/v1/attach/project-bindings/{bindingId}/status`     | Access or Operator bearer                                | Existing owner-scoped status.                                               |
| `GET /api/v1/attach/project-bindings/{bindingId}/session`    | Access or Operator bearer                                | Existing owner-scoped session.                                              |
| `POST /api/v1/attach/project-bindings/{bindingId}/heartbeat` | Access or Operator bearer                                | Existing lease/heartbeat contract.                                          |
| `DELETE /api/v1/attach/project-bindings/{bindingId}/session` | Access or Operator bearer                                | Existing guarded finalization.                                              |

Delete `POST /v1/remote/pairing/exchange` and its already-unsupported server fallback rather than relocating it. Delete `POST /v1/admin`, `/v1/admin/auth/callback/{flowId}`, the v1 command router/client/envelopes, its OpenAPI union, generated SDK operation/types, CLI/native fallback selection, deprecation middleware, and legacy JSON/base64 bundle request ceiling. No v1 Admin behavior remains at `/api/v1/admin`.

### v2 Admin routes

Every Plan 000 Admin relative resource moves unchanged from `/v2/admin/{relative}` to `/api/v2/admin/{relative}`. This includes Host, runtime, catalog, remote clients/login requests, backend auth, Vault, Caplet Records, bundles, installations, observations, activity, and events. Use Plan 000's canonical resource table and route-definition inventory as the exhaustive relative-path list; a fixture must prove every `ADMIN_V2_ROUTE_DEFINITION` is mounted exactly once beneath `/api/v2/admin`.

Authentication remains exactly Plan 021's exclusive selection:

1. Presence of any `Authorization` header selects bearer mode; invalid/empty/Access bearer fails with no cookie or development fallback.
2. Otherwise, presence of `caplets_dashboard_session` selects same-origin dashboard-session mode; malformed/expired cookies fail with no development fallback.
3. Otherwise, verified-loopback `development_unauthenticated` may select development authority when configured.
4. Unsafe session-authenticated operations require the current `X-Caplets-CSRF`; safe methods do not. Bearer/development modes ignore CSRF.
5. Resource handlers receive one Operator principal and do not branch on credential mode.

The only public callback is:

```text
GET /api/v2/admin/backend-auth-flows/{flowId}/callback
```

It retains Plan 007's one-time flow ID, provider state, expiry, claim/commit/release authority and `Cache-Control: no-store`; it must not be forced through bearer/session auth. Raw Vault Reveal remains browser-private and is never mounted here.

### Dashboard routes

Canonical page routes are:

```text
/dashboard
/dashboard/caplets
/dashboard/catalog
/dashboard/catalog/{entryKey}
/dashboard/stored-caplets
/dashboard/vault
/dashboard/access
/dashboard/activity
/dashboard/runtime
/dashboard/settings
```

`entryKey` is one encoded path segment and cannot decode to a slash, `.` or `..`. Astro must build with `/dashboard` as its fixed base so hashed assets resolve only beneath `/dashboard/_astro/*`; root `/_astro/*` is deleted. Public files referenced by the UI also live beneath `/dashboard/*`, not at the origin root. The server must reserve `/dashboard/api` before the static/SPA fallback so an unknown private route cannot return HTML.

Dashboard-private routes remain:

| Method and path                             | Authority                                                 | Contract                                                    |
| ------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| `POST /dashboard/api/login/start`           | Public pending-login ceremony + host protection           | Existing bounded body and approval response.                |
| `POST /dashboard/api/login/poll`            | Pending completion secret + host protection               | Existing response.                                          |
| `POST /dashboard/api/login/complete`        | Pending completion secret + host protection               | Creates durable dashboard session; issues root-Path cookie. |
| `GET /dashboard/api/session`                | Same-origin dashboard session                             | Restores and, when needed, migrates the cookie.             |
| `POST /dashboard/api/logout`                | Same-origin dashboard session + CSRF                      | Deletes exact durable session and expires cookies.          |
| `POST /dashboard/api/private/vault-reveals` | Same-origin dashboard session + CSRF + exact confirmation | Existing no-store secret response; never bearer-enabled.    |

Ordinary dashboard administration calls generated SDK operations at `/api/v2/admin/*` with same-origin credentials. There is no `/dashboard/api/v2`, `/dashboard/api/admin`, or browser-only Admin route alias.

## Well-known contract

`GET /.well-known/caplets` returns exactly this logical document:

```json
{
  "schemaVersion": 1,
  "links": {
    "api": "/api",
    "openapi": "/api/openapi.json",
    "mcp": "/mcp",
    "dashboard": "/dashboard"
  }
}
```

Requirements:

- Serialize deterministic UTF-8 JSON with one canonical key order and one terminal newline. Do not include request Host, proxy headers, deployment prefix, version, auth mode, or an absolute URL.
- Every link is an origin-relative URI reference. A client resolves it against the Current Host Origin it already holds.
- Return `Content-Type: application/json; charset=utf-8` and `Cache-Control: public, max-age=0, must-revalidate`.
- Derive a deterministic strong opaque ETag from the exact bytes through the same representation helper used by OpenAPI; clients must not parse the validator.
- `If-None-Match` uses the existing list/weak-comparison handling and returns 304 with no body while retaining `ETag`, `Cache-Control`, and `Content-Type`.
- `HEAD` returns the GET headers with no body.
- The route and schema are intentionally outside OpenAPI and `@caplets/sdk`. Its purpose is cross-protocol bootstrap, not another generated HTTP resource.

## API discovery and OpenAPI contract

### Discovery documents

`GET /api` returns this API-only shape:

```json
{
  "name": "caplets",
  "protocol": "caplets-http",
  "schemaVersion": 1,
  "links": {
    "self": "/api",
    "openapi": "/api/openapi.json",
    "v1": "/api/v1",
    "admin": "/api/v2/admin/host"
  }
}
```

`GET /api/v1` preserves the existing version-discovery meaning but emits only canonical paths:

```json
{
  "version": 1,
  "path": "/api/v1",
  "links": {
    "health": "/api/v1/healthz",
    "attachManifest": "/api/v1/attach/manifest",
    "attachEvents": "/api/v1/attach/events",
    "attachInvoke": "/api/v1/attach/invoke"
  }
}
```

When explicit Attach sessions are mounted, add `"attachSessions": "/api/v1/attach/sessions"`. Do not put Admin v1 or MCP links in the v1 document. The `/api` document describes only the public HTTP API and its versions; `/.well-known/caplets` alone owns cross-protocol MCP and dashboard discovery. Discovery responses are public, deterministic for one server composition, and `Cache-Control: no-store`; they contain no absolute/current-request origin.

### OpenAPI boundary

The checked OpenAPI 3.1 artifact and runtime `/api/openapi.json` bytes must agree exactly. The document uses `servers: [{ "url": "/" }]`, and every operation path includes its canonical `/api` prefix. It includes:

- `GET /api` and `GET /api/v1` discovery;
- `/api/v1/healthz`;
- surviving Remote Login/refresh/self-revoke operations;
- Attach and Project Binding HTTP operations, including the HTTP 101 upgrade response but not WebSocket message transport;
- every `/api/v2/admin/*` resource and the public OAuth callback.

It excludes:

- `/` and `/.well-known/caplets`;
- `/api/openapi.json` itself;
- MCP and all MCP message/session semantics;
- deleted v1 Admin and pairing fallback;
- dashboard pages/assets/private ceremonies;
- WebSocket message payloads as HTTP operations.

Retain deterministic generation, unique stable operation IDs, `$ref` validation, security/media-type assertions, relative server URL, strong ETag, and `public, max-age=0, must-revalidate`. Request Host/proxy headers must never change document bytes. Regenerate both `schemas/caplets-http.openapi.json` and generator-owned `packages/sdk/src/generated/`; never hand-edit either.

## Exact `/mcp` Streamable HTTP contract

`/mcp` is the sole MCP URL. It uses the existing MCP SDK Streamable HTTP transport and server session Module; Plan 023 changes topology, not MCP message semantics.

- `POST /mcp` accepts MCP JSON-RPC client messages with `Content-Type: application/json` and protocol-compatible `Accept` values. A valid `initialize` without `Mcp-Session-Id` creates a session, connects one server, and returns the transport-selected JSON or SSE response with the new opaque `Mcp-Session-Id`. A non-initialize request without a session does not leave a retained session.
- `POST /mcp` with a known `Mcp-Session-Id` sends subsequent messages to exactly that session. Unknown/expired IDs return the existing MCP JSON-RPC session-not-found error with status 404.
- `GET /mcp` requires a known `Mcp-Session-Id` and opens/resumes the transport's server-to-client SSE stream. Missing session ID is the transport's JSON-RPC bad-request response with status 400; unknown ID is 404.
- `DELETE /mcp` requires a known `Mcp-Session-Id`, terminates that transport session, invokes server cleanup once, and makes later requests with the ID return 404. Missing ID is 400.
- Enforce the MCP SDK's `MCP-Protocol-Version`, JSON-RPC, `Origin`, DNS-rebinding, content-type, Accept, and resumability rules rather than duplicating a partial parser. Preserve `Last-Event-ID` behavior supported by the selected transport.
- Access and Operator bearers may use MCP. Missing/invalid credentials return 401 and an insufficient role returns 403 under remote-credential auth. Verified-loopback development-unauthenticated behavior remains limited to its existing mode.
- Graceful HTTP shutdown closes every MCP server/transport and clears session state. Idle/session bounds remain owned by their existing plan; this cutover must not weaken them.
- Other methods on `/mcp` return 405. `/mcp/`, `/api/mcp`, `/api/v1/mcp`, `/v1/mcp`, and any configured-prefix form return 404.
- MCP remains absent from OpenAPI and generated SDK operations. Well-known and API discovery only link to it.

Add transport-level cases for initialize, POST/GET/DELETE with a session, missing/unknown session, protocol/content negotiation, auth, exact cleanup count, strict slash rejection, and shutdown.

## Central route-topology seam

Replace `servicePaths(base)`, `routePath`, scattered literal appends, and dashboard service-root inference with a focused pure Module, for example `packages/core/src/http/current-host-topology.ts`. Exact names may follow repository naming, but its interface must expose only:

1. immutable fixed namespace/path constants for well-known, API roots, MCP, dashboard, assets, and private dashboard roots;
2. strict named builders for surviving v1 leaf paths, Admin relative paths, and Project Binding parameter paths;
3. Current Host Origin parsing/normalization and origin-relative URL resolution;
4. route classification needed to keep dashboard static fallback and protocol 404/405 behavior disjoint.

The interface must not accept a base path. Do not expose a generic `appendPath(origin, string)` that lets every caller rebuild topology. Admin relative resources remain owned by `ADMIN_V2_ROUTE_DEFINITIONS`; the topology Module supplies the one Admin namespace mount. OpenAPI route definitions are authoritative for public HTTP leaves, while the topology Module is authoritative for namespace placement. Generation carries those paths into the SDK; generated files do not become a second source.

Server composition and tests cross the same seam. Add a checked route-manifest assertion comparing:

- registered public API methods/paths;
- OpenAPI methods/paths;
- generated SDK operation paths;
- explicit exclusions (well-known, MCP, dashboard, WebSocket messages);
- the fixed negative old/slash-path fixture.

This concentrates route change and verification in one place. Do not create separate server, CLI, SDK, and dashboard topology tables.

## Configuration and client migration contract

### Remove path-prefix serving

Delete, rather than deprecate:

- CLI/daemon/native `--path` options, including hidden forwarding forms;
- `RawServeOptions.path`, `HttpServeOptions.path`, `ServeConfig.path`, defaults, normalization, validation, generated config schema, examples, docs, and tests;
- daemon process args/config snapshots/validation URLs that carry the path;
- service-root metadata injection and all base-path-aware route/static helpers;
- reverse-proxy-prefix examples and deployment variables.

After cutover:

- `--path` is an unknown option and exits nonzero.
- `serve.path` is an unknown key in the strict config schema and returns the normal `CONFIG_INVALID` diagnostic. It is never silently ignored.
- `CAPLETS_SERVER_URL=https://host.example/prefix`, SDK `baseUrl`, remote profile URLs, native URLs, and CLI URL arguments with non-root paths fail before network I/O with an actionable origin-only error.
- A root slash input normalizes to `https://host.example`, not a path-bearing identity.
- A reverse proxy must expose the canonical origin-root namespaces. Prefix-only hosting is unsupported.

Do not change outbound backend configuration such as HTTP action `baseUrl` plus action `path`, OpenAPI backend operation URLs, Google Discovery URLs, or other third-party URL resolution. Those are not Current Host topology.

### SDK and handwritten clients

- `@caplets/sdk` `createClient({ baseUrl })` requires a Current Host Origin and rejects a non-root path. Rename internal `serviceRoot` variables and diagnostics to `currentHostOrigin` without adding a compatibility option.
- Generated operations use `/api`, `/api/v1/*`, and `/api/v2/admin/*`. Remove every v1 Admin export/type/operation; keep no handwritten facade.
- The SDK remains isolated per client and preserves auth/streaming/error behavior from Plan 020.
- CLI remote login, refresh, Attach, Project Binding HTTP/WebSocket, Admin adapters, and discovery use the topology seam or generated SDK. Delete retry/fallback code that probes old `/v1`, `/v2`, Cloud workspace, or configured-prefix paths.
- Native and daemon clients use the same origin parser and fixed builders. No adapter may catch canonical 404 and retry a legacy route.
- Remote profiles contain a generic Current Host Origin after Plan 022. Profile writes are atomic. Profile reads reject surviving path-bearing values with a remediation message; do not guess that the last segment was a protocol endpoint.

### Dashboard cookie migration retained

Fix new dashboard session cookies at `Path=/`, host-only, HttpOnly, SameSite=Lax, and conditionally Secure under the existing trusted-origin policy. Preserve the cookie name, opaque value format, durable session row, CSRF value, absolute expiry, and Plan 021's request-scoped session finalizer.

`GET /dashboard/api/session` must continue the one-time migration from an existing `Path=/dashboard` cookie: validate the exact durable session, reissue the same credential at `Path=/`, expire `Path=/dashboard`, and return the unchanged session representation with `Cache-Control: no-store`. Login issues root Path directly. Logout and acting-session revoke/demotion delete the durable session and expire both `/` and `/dashboard` paths using repeated `Set-Cookie` headers.

A cookie scoped under an arbitrary removed custom prefix cannot be sent to `/dashboard/api/session` and is not recoverable server-side. Because this is a pre-release cutover, do not preserve prefix routes to rescue it. Document the failure as requiring a fresh dashboard login. Keep rollback compatibility for root cookies: they are also sent to `/dashboard` on an older Plan 021 server.

### OAuth in-flight invalidation

Old backend OAuth provider redirects target deleted callback paths, so no pre-cutover flow may remain retryable.

Add one SQLite/PostgreSQL schema migration that atomically terminalizes rows existing at migration time:

- `pending` backend-auth flows become `failed`;
- `completing` backend-auth flows become `unknown`, because provider exchange/commit outcome may be uncertain;
- terminal rows remain unchanged;
- terminal timestamps/update timestamps are set consistently and claim credentials are cleared according to the repository's terminal-state invariant;
- encrypted payloads remain protected and are pruned by existing retention.

The migration must be idempotent and must not affect flows created after it. A callback at any old path returns 404. A callback for a terminalized flow at the new path returns the existing safe terminal/not-found Problem without token/provider diagnostics. Dashboard/CLI list views tell the operator to start a new backend-auth flow. Exercise the migration and a claim/migration race against both database dialects; do not implement a startup `list` plus per-row loop.

## Clean cutover and failure behavior

| Situation                                                                | Required result                                                                     |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Old SDK/CLI calls `/v1/*`, `/v2/admin/*`, or `/openapi.json`             | 404; no redirect, deprecation response, or retry by new clients.                    |
| Caller supplies Current Host URL with `/tenant/tools` or a protocol leaf | Local `REQUEST_INVALID`/`TypeError` before network I/O; message requires an origin. |
| Existing config contains `serve.path`                                    | Strict configuration failure; operator removes the key.                             |
| Operator passes `--path`                                                 | CLI unknown-option failure.                                                         |
| Reverse proxy exposes only a prefix                                      | Health/client smoke fails; deployment must expose fixed origin-root namespaces.     |
| Old in-flight backend OAuth callback arrives                             | Old path 404; migrated flow is terminal; user starts a new flow.                    |
| Existing root/dashboard-path cookie                                      | Restore preserves session and migrates/refreshes root Path as specified.            |
| Existing custom-prefix cookie                                            | Cannot be observed at canonical route; fresh dashboard login required.              |
| Unknown dashboard API route                                              | JSON 404, never SPA HTML.                                                           |
| Slash variant of any canonical route                                     | JSON 404 with no redirect.                                                          |
| Generated and runtime route sets drift                                   | `openapi:check` or route-manifest test fails.                                       |
| Canonical API method is unsupported                                      | 405 with exact `Allow`; no fallback.                                                |

Deploy the server, checked OpenAPI, SDK, CLI/native packages, dashboard assets, and deployment probes as one release train. Since this is pre-release, do not add dual-read/dual-route periods, feature flags, environment toggles, telemetry compatibility branches, or rollback aliases. Database migrations remain forward-only; rollback requires restoring the previous binary while accepting that in-flight OAuth flows were terminalized.

## Implementation order: vertical slices

Keep each slice end-to-end across its affected server, client, and focused tests. Start with failing public-interface tests. Do not postpone all consumers until after a server-only rewrite.

### 1. Lock vocabulary, origin parsing, and topology with failing tests

Add a focused topology test and convert origin parser tests to assert:

- the four fixed namespaces and all named roots;
- origin normalization for HTTPS, ports, IPv6, and loopback HTTP;
- rejection of credentials, non-root paths, query, fragment, non-HTTP schemes, and non-loopback HTTP;
- strict old/slash/multi-slash/encoded-path negatives;
- no topology interface accepts a prefix.

Introduce the fixed topology Module and replace `servicePaths(base)` at the server composition seam. Do not yet retain compatibility constants.

```sh
pnpm --filter @caplets/core test -- test/server-options.test.ts test/serve-options.test.ts test/serve-http.test.ts
pnpm --filter @caplets/core typecheck
```

### 2. Cut over discovery, configuration, and basic server topology

Write failing HTTP cases for root 302, exact well-known schema/ETag/304/HEAD, `/api` and `/api/v1` discovery, canonical health, strict 404s, and canonical 405. Delete `--path`/`serve.path` through CLI, config, daemon, native, and generated schema inputs. Ensure outbound backend base URLs are unchanged.

```sh
pnpm --filter @caplets/core test -- \
  test/serve-http.test.ts \
  test/serve-options.test.ts \
  test/server-options.test.ts \
  test/serve-daemon.test.ts \
  test/native-options.test.ts
pnpm schema:generate
pnpm schema:check
pnpm --filter @caplets/core typecheck
```

### 3. Move the surviving v1 public routes and their clients

For each exact v1 row, first add a canonical positive case and old/slash negative case. Move Remote Login, refresh/self-revoke, Attach, SSE, and Project Binding HTTP/WebSocket under `/api/v1`. Update CLI, remote selection, Project Binding SDK subpath, native/daemon clients, and URL fixtures in the same slice. Delete pairing fallback and every old-route retry.

```sh
pnpm --filter @caplets/core test -- \
  test/serve-http.test.ts \
  test/public-v1-openapi-runtime-parity.test.ts \
  test/remote-login-cli.test.ts \
  test/remote-options.test.ts \
  test/remote-cli-public-auth.test.ts \
  test/remote-cli-attach.test.ts \
  test/remote-cli-discovery.test.ts \
  test/native-remote.test.ts
pnpm --filter @caplets/sdk test -- test/project-binding.test.ts test/project-binding-node.test.ts test/server-sent-events.test.ts
```

### 4. Move MCP to exact `/mcp`

Add the Streamable HTTP/session/auth cases specified above, then mount only `/mcp`. Update setup output and every MCP configuration writer to emit `origin + /mcp`. Delete `/v1/mcp` construction and path-bearing endpoint acceptance.

```sh
pnpm --filter @caplets/core test -- test/serve-session.test.ts test/serve-http.test.ts test/attach-server.test.ts test/remote-options.test.ts
pnpm --filter @caplets/core typecheck
```

### 5. Move Admin v2 and delete Admin v1

First make route/auth/router tests expect `/api/v2/admin`. Preserve Plan 021 credential precedence, CSRF, same-origin checks, idempotency, ETags, pagination, streaming bundles, and callback exception. Delete the v1 server router, command dispatch exposure, legacy callback, v1 client/envelopes, OpenAPI union, SDK facade, CLI/native fallback, deprecation headers, and base64 bundle transport ceiling. A checked command/destination fixture must have no `frozen v1 compatibility` destination after deletion.

```sh
pnpm --filter @caplets/core test -- \
  test/admin-api-router.test.ts \
  test/dashboard-session.test.ts \
  test/serve-http.test.ts \
  test/remote-cli-admin.test.ts \
  test/remote-control-dispatch.test.ts \
  test/remote-control-client.test.ts \
  test/remote-cli-bundle.test.ts
pnpm --filter @caplets/core typecheck
```

### 6. Invalidate OAuth flows and retain dashboard sessions

Add migration-contract tests for pending/completing/terminal flows and SQLite/PostgreSQL race behavior before creating the migration. Add HTTP cases for new callback success, old callback 404, terminalized flow safety, root-Path issuance, `/dashboard`-Path restore migration, logout, self-revoke/demotion, and custom-prefix-cookie failure documentation.

```sh
pnpm --filter @caplets/core test -- \
  test/backend-auth-flow-storage.test.ts \
  test/backend-auth-flow-storage.postgres.test.ts \
  test/current-host-backend-auth-operations.test.ts \
  test/dashboard-session-store.test.ts \
  test/dashboard-session.test.ts
pnpm postgres:contracts
pnpm storage:check
```

### 7. Fix dashboard pages, assets, and clients

Configure Astro's fixed `/dashboard` base. Remove service-root metadata and inference. Make generated Admin requests resolve against `globalThis.location.origin` at `/api/v2/admin`; keep private helpers under `/dashboard/api`. Test the exact page list, catalog detail safety, `/dashboard/_astro` immutability, root-asset 404, private JSON 404, restore-before-Admin ordering, CSRF, and session-ended UI behavior.

```sh
pnpm --filter @caplets/core test -- test/dashboard-static.test.ts test/dashboard-session.test.ts test/dashboard-ui.test.ts
pnpm --filter @caplets/dashboard test -- \
  src/lib/api.test.ts \
  src/components/DashboardApp.test.tsx \
  src/components/catalog/catalog-route.test.ts
pnpm --filter @caplets/dashboard typecheck
pnpm --filter @caplets/dashboard build
```

### 8. Retarget OpenAPI and generated SDK as one artifact slice

Add route-manifest and OpenAPI assertions first. Prefix all included public operations with `/api`, delete v1 Admin and `/api/v2` discovery, keep exclusions exact, and retain root-relative `servers`. Regenerate schema and SDK. Update SDK package tests for origin-only clients, complete operation representation, browser safety, streaming bundles, SSE, and removal of v1 Admin symbols.

```sh
pnpm --filter @caplets/core test -- test/admin-api-openapi.test.ts test/public-v1-openapi-runtime-parity.test.ts test/serve-http.test.ts
pnpm openapi:generate
pnpm openapi:check
pnpm --filter @caplets/sdk test
pnpm --filter @caplets/sdk typecheck
pnpm --filter @caplets/sdk build
```

### 9. Finish CLI/native/deploy/docs migration and remove obsolete code

Search again for old literals and base-path vocabulary. Update built runtime smoke, Docker/compose health checks, examples, generated CLI/config references, public SDK/Attach/Project Binding/dashboard docs, `README.md`, `CONTEXT.md`, and architecture/domain vocabulary. Preserve dated plans/changelogs as history and preserve unrelated Alchemy/Cloudflare deployment infrastructure. Update the existing unreleased changeset rather than adding overlapping package bumps.

```sh
rg -n 'servicePaths|service root|base path|serve\.path|--path|/v1/mcp|/v1/admin|/v1/attach|/v1/healthz|/v2/admin|/openapi\.json|/_astro' packages apps scripts schemas Dockerfile docker-compose*.yml config.example.json docs README.md CONTEXT.md
pnpm docs:generate
pnpm docs:check
pnpm compose:check
pnpm changeset status --since=origin/main
```

Classify every remaining match. Generated migration history and dated plans may describe old behavior as history. Active source, tests, generated current reference, examples, deployment probes, and public docs may not.

## Focused verification matrix

### Core HTTP/topology/security

```sh
pnpm --filter @caplets/core test -- \
  test/serve-http.test.ts \
  test/serve-session.test.ts \
  test/serve-options.test.ts \
  test/server-options.test.ts \
  test/admin-api-router.test.ts \
  test/admin-api-openapi.test.ts \
  test/public-v1-openapi-runtime-parity.test.ts \
  test/dashboard-static.test.ts \
  test/dashboard-session.test.ts \
  test/current-host-backend-auth-operations.test.ts
```

Expected: canonical positives pass; all listed old and trailing-slash paths return 404; Admin auth behavior is unchanged apart from the namespace.

### CLI/native/storage

```sh
pnpm --filter @caplets/core test -- \
  test/cli-remote.test.ts \
  test/remote-login-cli.test.ts \
  test/remote-options.test.ts \
  test/remote-profiles.test.ts \
  test/remote-selection.test.ts \
  test/remote-cli-admin.test.ts \
  test/remote-cli-attach.test.ts \
  test/native-options.test.ts \
  test/native-remote.test.ts \
  test/serve-daemon.test.ts \
  test/backend-auth-flow-storage.test.ts \
  test/backend-auth-flow-storage.postgres.test.ts
pnpm postgres:contracts
```

Expected: all clients accept origins only, emit canonical paths only, and never retry old routes; OAuth migration semantics agree across dialects.

### Dashboard, SDK, and generated artifacts

```sh
pnpm --filter @caplets/dashboard test
pnpm --filter @caplets/dashboard typecheck
pnpm --filter @caplets/dashboard build
pnpm --filter @caplets/sdk test
pnpm --filter @caplets/sdk typecheck
pnpm --filter @caplets/sdk build
pnpm openapi:check
pnpm schema:check
```

Expected: dashboard pages/assets/private paths are disjoint, SDK uses `/api/*`, v1 Admin symbols are absent, and generated artifacts have no drift.

## End-to-end release smoke

Build the actual release artifacts, then start one real server at `http://127.0.0.1:5387` with authentication enabled and no path option.

1. `GET /` returns 302 with exactly `Location: /dashboard`.
2. `GET /.well-known/caplets` matches the exact schema and links. Repeat with `If-None-Match`; observe 304 and the required headers.
3. `GET /api` and `/api/v1` contain only origin-relative canonical links. `GET /api/openapi.json` equals the checked artifact and returns 304 conditionally.
4. Complete Remote Login against `/api/v1/remote/login/*`; use the credential for Attach manifest/invoke/events and a Project Binding create/connect/heartbeat/delete cycle under `/api/v1/attach/*`.
5. Initialize MCP at `/mcp`, exchange a message, open/resume GET streaming as supported, DELETE the session, and confirm subsequent use returns 404.
6. Use a bearer SDK client against the Current Host Origin to read `/api/v2/admin/host` and perform one conditional/idempotent mutation.
7. Open `/dashboard`, restore/login, and confirm all hashed assets load from `/dashboard/_astro/*`; no request uses root `/_astro`, `/v2/admin`, or a service prefix.
8. Confirm dashboard reads `/api/v2/admin/*`, unsafe operations send exactly one current CSRF header, and Raw Vault Reveal stays at `/dashboard/api/private/vault-reveals`.
9. Seed a legacy `/dashboard`-Path cookie, restore it without changing session identity, and observe root reissue plus legacy expiry. Confirm logout expires both paths.
10. Seed pre-migration pending and completing OAuth flows in both dialect smoke fixtures, apply migration, and observe `failed`/`unknown`; complete a new flow only at the new callback.
11. Probe every old namespace and representative slash variant below; each returns the exact JSON 404 and no `Location`, `Deprecation`, or successor header.
12. Build and run the container/compose health probe; observe `/api/v1/healthz` and no dependency on `--path`.

Minimum negative fixture:

```text
/openapi.json
/v1
/v1/healthz
/v1/remote/login/start
/v1/attach/manifest
/v1/admin
/v1/admin/auth/callback/example
/v1/mcp
/v2
/v2/admin/host
/api/
/api/v1/
/api/v1/admin
/api/v2
/api/v2/admin/host/
/mcp/
/dashboard/
/dashboard/api/v2/host
/_astro/example.js
/tenant/tools/api
/tenant/tools/mcp
/tenant/tools/dashboard
```

Capture paths, methods, statuses, media types, cache headers, ETags, redirect location, WebSocket protocol, and cookie attributes. Never capture tokens, cookie values, OAuth codes/state, Vault values, or provider errors.

Run the built-package and deployment smokes:

```sh
pnpm build
pnpm compose:smoke
```

Update `scripts/check-package-runtime.mjs` so its built-artifact assertions cover root redirect, well-known/OpenAPI conditional requests, canonical SDK Attach/Admin operations, Project Binding WebSocket, exact MCP, and representative old-route 404s.

## Risks and controls

| Risk                                                            | Control                                                                                                                          |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Partial server/client cutover creates false failures            | One release train; route-manifest agreement; no compatibility retry.                                                             |
| Generic string helpers recreate path drift                      | One fixed topology seam with named builders; generated SDK paths flow from OpenAPI.                                              |
| Reverse proxy still publishes a prefix                          | Origin-root deployment smoke and explicit configuration failure.                                                                 |
| Strict slash behavior is weakened by framework/static fallback  | Explicit strict router configuration plus negative fixture across every namespace.                                               |
| Dashboard static fallback captures private/unknown paths        | Register/reserve `/dashboard/api` first and test JSON 404 rather than HTML.                                                      |
| MCP behavior changes while moving paths                         | Delegate protocol semantics to the same transport; transport-level session lifecycle tests.                                      |
| v1 Admin survives through generated or native code              | Symbol/literal search, OpenAPI operation-set comparison, SDK package test, deletion of fallback adapters.                        |
| OAuth callback cutover leaves retryable stale flows             | Atomic dialect migration: pending→failed, completing→unknown; old callback 404.                                                  |
| Cookie Path change logs users out                               | Preserve root cookie contract and `/dashboard` migration; document unrecoverable custom-prefix cookies.                          |
| OpenAPI gains private or non-HTTP routes                        | Exact inclusion/exclusion assertions and runtime artifact parity.                                                                |
| Origin validation accidentally affects third-party backend URLs | Scope parser to Current Host inputs; retain outbound backend URL tests.                                                          |
| Plan 022 removal is partially undone                            | No Cloud/hosted modes or workspace paths; preserve only generic Current Host remote support and unrelated deploy infrastructure. |

## Machine-checkable acceptance criteria

- A Current Host is represented everywhere by an HTTP(S) origin; non-root path inputs fail before network I/O.
- No source/config/generated schema exposes `--path` or `serve.path`.
- One topology Module owns fixed namespaces and accepts no prefix.
- `GET /` returns 302 to `/dashboard` with no-store.
- `/.well-known/caplets` matches the exact schema, origin-relative links, deterministic bytes, strong ETag, cache headers, HEAD, and conditional 304 contract; it is absent from OpenAPI/SDK.
- `/api` and `/api/v1` match the exact discovery contracts.
- Runtime `/api/openapi.json` bytes equal the checked OpenAPI artifact.
- OpenAPI contains exactly the included `/api/*` operations and none of the excluded protocols/private paths.
- Every surviving v1 operation is mounted only at its `/api/v1/*` path.
- Every v2 Admin route is mounted exactly once beneath `/api/v2/admin`; Plan 021 auth/CSRF precedence remains green.
- `/mcp` alone implements the specified Streamable HTTP POST/GET/DELETE and session cleanup contract.
- Dashboard pages are under `/dashboard`, hashed assets under `/dashboard/_astro`, private ceremonies under `/dashboard/api`, and Admin calls under `/api/v2/admin`.
- New dashboard cookies use `Path=/`; existing `/dashboard` cookies migrate without session identity/CSRF/expiry changes.
- Pre-cutover OAuth `pending` rows become `failed`; `completing` rows become `unknown` atomically in SQLite and PostgreSQL.
- v1 Admin server/client/OpenAPI/SDK/CLI/native code and legacy base64 request ceiling are deleted.
- Old, configured-prefix, and trailing-slash paths in the negative fixture return exact 404 with no alias/redirect/fallback.
- SDK, CLI, native, daemon, dashboard, built-package smoke, Docker/compose health checks, generated docs, and public docs use only canonical origin-root paths.
- No active source or current generated artifact contains an unexplained old topology literal.
- `pnpm verify`, built-package smoke, compose smoke, and the manual browser/MCP/OAuth scenario pass.
- This plan is marked `DONE` before any public release.

## Final gate and review

```sh
pnpm verify
```

Run the repository code-review workflow against the implementation base with standards/security and this plan reviewed independently. Resolve every actionable finding, rerun the affected focused checks, regenerate only from authoritative sources, and rerun `pnpm verify` once after the final behavioral or generated-artifact change.

## Completion notes

> Completed and verified by the implementation agent.

- Completed date: 2026-07-20
- Implementation commit/range: `c5058527^..4518a04`
- Prerequisite completion evidence (000/020/021/022): Plan 000 and Plan 020 completion records are filled; Plan 021's canonical authorization/finalization contract is integrated with its route-location criteria intentionally superseded here; Plan 022's completion record and deletion/preservation evidence are filled.
- Topology/OpenAPI/SDK route-manifest evidence: built-package checks proved exact origin-root discovery, strong ETags/304, checked OpenAPI byte parity, canonical SDK responses, `/api/v1` Attach, `/api/v2/admin`, `/mcp`, `/dashboard`, and exact 404 behavior for old, prefixed, and trailing-slash paths.
- Focused core/CLI/native/storage command results: focused core Admin, HTTP, storage, Remote Profile, CLI, Opencode, and Pi checks passed; required PostgreSQL contracts passed 11 files and 63 tests.
- Dashboard/SDK/generated command results: dashboard typecheck/build and browser smoke passed; SDK build/artifact tests, OpenAPI generation check, config schema check, Code Mode generated-API checks, and generated docs checks passed.
- Built-package and compose smoke evidence: `node scripts/check-package-runtime.mjs` passed the full two-Host-Node scenario including bounded 197,132,428-byte bundle upload/download; `pnpm compose:smoke` passed SQLite, convenience PostgreSQL, hardened PostgreSQL, migration-gate, and compatibility deployments.
- Manual browser/MCP/OAuth/negative-path evidence: an authorized browser session rendered the canonical dashboard and Stored Caplets route; built smoke covered Streamable HTTP MCP lifecycle, cross-node OAuth completion/replay, Project Binding, and exact no-store 404 responses for removed routes.
- `pnpm verify` result: passed on 2026-07-20; 212 Vitest files passed, 8 skipped, with 2,996 tests passed and 46 skipped, followed by benchmark and full build/package smoke success.
- Review findings and resolutions: final independent standards/security and Plan 000/022/023 spec reviews reported no findings after bounded-streaming, SQL persistence, Docker state-classification, and multi-node cache/startup fixes.
- Changeset/release metadata: `.changeset/current-host-admin-api.md` covers the public origin-root, Admin API, SDK, Cloud-removal, and v1-removal cutover.
- Deviations from this plan: none.
