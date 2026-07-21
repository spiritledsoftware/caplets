# Current Host Admin API

The Admin API is the canonical `/api/v2/admin/*` resource interface for administering the Current
Host. Remote Operator Clients and the same-origin dashboard use identical resource URLs and
semantics while retaining separate bearer and Dashboard Session Credential ceremonies.

## Protocol Namespaces And Authority

A Current Host URL is an origin: scheme, host, and optional port only. Its fixed namespaces are:

- `GET /` redirects to `/dashboard`.
- `/.well-known/caplets` publishes cross-protocol discovery with origin-relative links.
- `/api`, `/api/openapi.json`, `/api/v1/*`, and `/api/v2/admin/*` contain the public HTTP API.
- Exact `/mcp` contains Streamable HTTP MCP.
- `/dashboard` contains browser pages and assets, while `/dashboard/api/*` contains private browser
  ceremonies.

`/api/v2/admin/*` accepts either the selected Remote Profile's Operator bearer credential or a
same-origin Dashboard Session Credential. Any `Authorization` header selects bearer mode
exclusively and never falls back to a cookie. Without that header, the dashboard cookie selects
session mode; unsafe requests then require the current `X-Caplets-CSRF`. Access Clients cannot
invoke Admin resources. Both Access and Operator Clients retain their route-specific MCP, Attach,
Project Binding, and credential-owner self-revocation authority. Development-unauthenticated
serving is a loopback-only trusted mode, not a bearer credential model.

`/api/openapi.json` is the public, cacheable OpenAPI 3.1 description of canonical
`/api/v1/*` and `/api/v2/admin/*` HTTP resources. Well-known discovery, MCP, dashboard
login/session/logout, and other browser-private routes are excluded.

The public backend OAuth callback is
`GET /api/v2/admin/backend-auth-flows/{flowId}/callback`. It authenticates with the one-time flow ID,
provider state, and expiry rather than bearer or dashboard-session credentials, and returns
`Cache-Control: no-store`.

`/dashboard/api/private/vault-reveals` is the dashboard-only Raw Vault Reveal ceremony. It requires
the Dashboard Session Credential, current CSRF value, and exact confirmation, and returns
`Cache-Control: no-store`. It is excluded from the Admin router, OpenAPI, and generated client.

Dashboard login issues a host-only, HttpOnly, SameSite=Lax session cookie at `Path=/`. Session
restore migrates an existing `Path=/dashboard` cookie by validating the same durable session,
reissuing the same credential at the root path, and expiring the dashboard-path cookie without
changing session identity, CSRF value, or absolute expiry. Logout and acting-client demotion or
revocation expire both paths. A cookie scoped to an arbitrary removed custom prefix cannot reach
the canonical restore route and requires a fresh dashboard login.

## Resource Contract

Successful v2 requests return direct resource representations. Failures return
`application/problem+json` with RFC 9457 fields and a stable Caplets `code`; sensitive details are
redacted. Growable collections use opaque, filter-bound cursor pages.

Mutable resources publish strong opaque ETags. Creation requires `If-None-Match: *`; updates and
deletes require `If-Match`. Side-effecting POSTs require `Idempotency-Key`. Idempotency claims and
backend OAuth flows live in Authoritative Host State so nodes sharing that state preserve one
coherent result. An ambiguous abandoned side effect fails closed as an unknown outcome rather than
being executed again.

## Clients

`@caplets/sdk` is the independent public SDK generated from the canonical OpenAPI document. Its root
entrypoint is the browser/Node Fetch client plus ordered and streaming Caplet Bundle helpers;
`@caplets/sdk/project-binding` is the browser-safe fixed-v1 session coordinator; and
`@caplets/sdk/project-binding/node` computes marker-aware filesystem fingerprints. The coordinator
requires a caller-supplied fingerprint in browser-safe code.

Callers create isolated clients with an explicit Current Host Origin and optional caller-owned
static or async authentication; there is no shared mutable client or inferred endpoint. Current
Host inputs reject non-root paths, queries, fragments, and embedded credentials before network
access. Project Binding separately takes the exact
`wss://host.example/api/v1/attach/project-bindings/connect` URL. Requests return fields without throwing
by default, with throwing available as an opt-in.

The OpenAPI and generated client expose the dashboard-session security alternative and optional
CSRF header, but the SDK does not provide a login/session convenience facade.
Dashboard login/session/logout, Raw Vault Reveal, MCP, and other browser-private routes are not SDK
operations. Runtime tool, resource, prompt, and completion operations continue through
`/api/v1/attach/*` instead of Admin. There is no v1 Admin route or client facade, and clients do not
retry at another path or infer a deployment prefix. Remote `init` and `add` are local filesystem
operations and are rejected rather than forwarded.

## Bundle Transfer

Caplet bundles upload as ordered `multipart/form-data`: one bounded JSON manifest followed by the
manifest's file parts. Downloads stream as `multipart/mixed`. Paths, part order, file counts, byte
limits, sizes, and SHA-256 hashes are validated before Authoritative Host State is changed. Failed or
cancelled requests release admission capacity and remove staging files.

Uploads stage on disk instead of materializing a JSON/base64 bundle. `serve.adminUploadStagingDir`,
`serve.adminUploadMaxConcurrent`, and `serve.adminUploadMaxStagedBytes` control the directory and
admission limits; equivalent CLI flags and `CAPLETS_ADMIN_UPLOAD_*` environment variables take
precedence. The default quota for one active upload is 369,283,314 bytes (about 352.2 MiB), covering
one 64 MiB `CAPLET.md` document, up to 256 MiB of auxiliary files, a bounded manifest, and bounded
multipart framing. Container deployments must mount a writable staging path with at least that
capacity.
