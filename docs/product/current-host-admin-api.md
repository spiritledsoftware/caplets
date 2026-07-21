# Current Host Admin API

The Admin API is the versioned resource interface for administering the Current Host. The dashboard
and remote Operator clients use the same resource semantics; their authentication ceremonies remain
separate.

## Surfaces And Authority

- `/v2/admin` accepts the selected Remote Profile's paired Operator bearer credential.
- `/dashboard/api/v2` mounts the same relative resources behind dashboard cookie, session, origin,
  and CSRF checks.
- `/openapi.json` is the public, cacheable OpenAPI 3.1 description of canonical public v1 and v2 HTTP
  resources. MCP, duplicate dashboard mounts, dashboard cookie/session/CSRF ceremonies, and other
  browser-private routes are excluded.
- `/dashboard/api/private/vault-reveals` is the dashboard-only Raw Vault Reveal ceremony. It is
  excluded from the shared router, OpenAPI, and generated client.

Access Clients cannot invoke Admin resources. Both roles retain their existing MCP, Attach, Project
Binding, and credential-owner self-revocation authority. Development-unauthenticated serving is a
loopback-only trusted mode, not a bearer credential model.

## Resource Contract

Successful v2 requests return direct resource representations. Failures return
`application/problem+json` with RFC 9457 fields and a stable Caplets `code`; sensitive details are
redacted. Growable collections use opaque, filter-bound cursor pages.

Mutable resources publish strong opaque ETags. Creation requires `If-None-Match: *`; updates and
deletes require `If-Match`. Side-effecting POSTs require `Idempotency-Key`. Idempotency claims and
backend OAuth flows live in Authoritative Host State so nodes sharing that state preserve one
coherent result. An ambiguous abandoned side effect fails closed as an unknown outcome rather than
being executed again.

## Clients And Compatibility

`@caplets/sdk` is the independent public SDK generated from the canonical OpenAPI document. Its root
entrypoint is the browser/Node Fetch client plus ordered and streaming Caplet Bundle helpers;
`@caplets/sdk/project-binding` is the browser-safe fixed-v1 session coordinator; and
`@caplets/sdk/project-binding/node` computes marker-aware filesystem fingerprints. The coordinator
requires a caller-supplied fingerprint in browser-safe code.

Callers create isolated clients with an explicit absolute service root and optional caller-owned
static or async authentication; there is no shared mutable client or inferred endpoint. Project
Binding separately takes the exact `ws:` or `wss:` connect URL. Requests return fields without
throwing by default, with throwing available as an opt-in. Dashboard cookie/session/CSRF routes,
Raw Vault Reveal, MCP, and other browser-private routes are not SDK operations. Runtime tool,
resource, prompt, and completion operations continue through Attach instead of Admin.

`POST /v1/admin` remains as a frozen, deprecated compatibility Adapter for retained commands. It has
no scheduled sunset and receives no new operations. Remote `init` and `add` are local filesystem
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
