# Plan 000: Migrate Current Host Administration To A Resource API

> Status: COMPLETE
> Planned against: `ac12a174`
> Direction: replace transport-owned admin RPC with one versioned Admin API
> Priority: P0
> Effort: XL
> Fix risk: HIGH
> Depends on: Plans 001, 003, 004, 007, and 009
> Decision: ADR 0007
> Completion slice: [Plan 020](020-publish-caplets-sdk.md)

## Why this matters

`POST /v1/admin` multiplexes runtime execution, host administration, backend auth, Vault, catalog, and Caplet Record commands through one `RemoteCliRequest`. The route always returns an RPC envelope, most argument schemas are reconstructed manually, large bundles are JSON/base64, and CLI and dashboard clients maintain separate path and response knowledge. Policy has already moved toward `CurrentHostOperations`, but backend auth and full-bundle storage still bypass that Module.

The target is one deep administrative Interface with two authentication Adapters. Operator bearer clients use `/v2/admin`; the dashboard uses the same relative resources at `/dashboard/api/v2` with cookie, session, and CSRF protection. Runtime discovery and execution stay on Attach. The root OpenAPI document and generated clients make the network contract explicit without making Hono types the public client contract.

This plan is an end-to-end migration. It does not remove `/v1/admin`; it leaves a frozen compatibility Adapter over the new semantic seams.

## Prerequisites

Complete these plans first:

- **001:** bound current JSON bodies, including legacy v1 JSON/base64 requests.
- **003:** run SQLite/PostgreSQL contract coverage in CI before adding authoritative tables and row versions.
- **004:** make Vault set-and-grant atomic before publishing it as a v2 resource mutation.
- **007:** persist encrypted backend OAuth flows and establish claim/commit/release completion semantics.
- **009:** characterize dashboard mutation, confirmation, error, and CSRF behavior before changing its transport client.

If any prerequisite is not green on the implementation branch, stop. Do not fold its unfinished behavior into this already broad migration.

## Fixed decisions

1. `CurrentHostOperations` owns Current Host administration policy. HTTP handlers authenticate, validate, map protocol semantics, invoke the Module, and serialize.
2. Canonical Operator bearer routes mount at `/v2/admin`. The same relative routes mount at `/dashboard/api/v2` behind dashboard session and CSRF middleware.
3. Access Clients remain limited to MCP, Attach, Project Binding, and credential-owner self-revocation. Operator authority is required for both Admin mounts.
4. Runtime tool/resource/prompt discovery and execution use Attach, not Admin resources.
5. Remote `init` and `add` become local-only. V2 has no equivalents; v1 rejects them when v2 launches.
6. Raw Vault Reveal moves to `/dashboard/api/private/vault-reveals`; it is excluded from the Admin router, root OpenAPI document, and generated Admin client.
7. V2 success bodies are direct resource representations. Errors use `application/problem+json` with RFC 9457 fields and a stable `code` extension.
8. Malformed protocol input returns 400. A decoded representation that violates Caplet domain rules returns 422.
9. Mutable resources expose strong opaque ETags. Creation uses `If-None-Match: *`; mutation and deletion require `If-Match`; missing preconditions return 428 and stale validators return 412.
10. PATCH uses `application/merge-patch+json` with strict, resource-specific schemas.
11. Growable collections return `{ items, nextCursor? }` with opaque filter-bound cursors, default limit 100, and maximum 500.
12. Side-effecting POSTs require `Idempotency-Key`. Abandoned claims fail closed as an unknown outcome and are never reclaimed for automatic re-execution.
13. Full bundles upload as manifest-first ordered `multipart/form-data` and download as streaming `multipart/mixed`.
14. `/v1/admin` remains indefinitely as deprecated, frozen compatibility. It receives no new commands and has no `Sunset` date.
15. A public cacheable `/openapi.json` describes every canonical public v1 and v2 HTTP API except MCP. Browser-internal duplicate mounts, login/session ceremony, private Vault Reveal, static files, and WebSocket message schemas are excluded.
16. `@hono/zod-openapi` route definitions and Zod schemas are the OpenAPI source. Exactly pinned HeyAPI packages generate the Fetch SDK after the required acceptance spike.

## Scope

### In scope

- `packages/core/src/current-host/` semantic operations and outcomes
- `packages/core/src/serve/http.ts`, `serve/options.ts`, and path/version discovery helpers
- New focused Admin API contract/router/problem/pagination/conditional/idempotency/upload modules under `packages/core/src/admin-api/`
- `packages/core/src/remote-control/` as the frozen v1 compatibility Adapter
- `packages/core/src/storage/` tables, migrations, row versions, idempotency, bundle-source ingestion, and streaming object-store writes
- `packages/core/src/auth.ts` integration with the durable flow coordinator established by Plan 007
- `packages/core/src/cli.ts` and remote profile/client selection
- `apps/dashboard/src/lib/` and `DashboardApp.tsx` transport migration without visual redesign
- Root scripts, generated OpenAPI/HeyAPI artifacts, package exports, checks, and focused tests
- `CONTEXT.md`, `docs/architecture.md`, public Admin/remote CLI docs, generated CLI docs, and one release changeset

### Out of scope

- MCP protocol documentation in OpenAPI
- A new runtime execution API; Attach remains authoritative
- Async job infrastructure; catalog install/update, refresh, and restart retain synchronous behavior
- Hosted Cloud control-plane contracts
- Raw Vault Reveal over bearer auth
- Remote project filesystem mutation
- Token format, refresh-family, or credential-role redesign
- Replacing the dashboard state library or redesigning dashboard visuals
- Archive formats for Caplet Bundles
- Encrypting existing backend token bundles; Plan 007 encrypts pending flow state only

## Canonical Admin resources

The table lists paths relative to both Admin mounts. Stable `operationId` values must use an `adminV2` prefix so HeyAPI generation and compatibility checks can select them deterministically.

| Family            | Methods and relative paths                                                                                                                                                                                                      | Semantic owner                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Host              | `GET /host`, `GET /runtime`, `POST /runtime-restarts`, `GET /logs`, `GET /diagnostics`, `GET /project-binding`, `GET /events`, `GET /activity`                                                                                  | Current Host summary/runtime/activity operations    |
| Effective Caplets | `GET /caplets`                                                                                                                                                                                                                  | Effective Caplet projection                         |
| Catalog           | `GET /catalog/entries`, `GET /catalog/entries/{entryKey}`, `GET /catalog/update-candidates`, `POST /catalog/installations`, `POST /catalog/update-runs`                                                                         | Current Host catalog operations                     |
| Remote access     | `GET /remote-clients`, `GET/PATCH/DELETE /remote-clients/{clientId}`, `GET /remote-login-requests`, `GET/PATCH /remote-login-requests/{flowId}`                                                                                 | Current Host client operations                      |
| Backend auth      | `GET /backend-auth-connections`, `GET/DELETE /backend-auth-connections/{serverId}`, `POST /backend-auth-flows`, `GET /backend-auth-flows/{flowId}`, `GET /backend-auth-flows/{flowId}/callback`, `POST /backend-auth-refreshes` | Durable backend-auth flow and connection operations |
| Vault             | `GET /vault-values`, `GET/PUT/DELETE /vault-values/{storedKey}`, `GET /vault-grants`, `GET /vault-values/{storedKey}/grants`, `PUT/DELETE /vault-values/{storedKey}/grants/{capletId}/{referenceName}`                          | Current Host Vault operations                       |
| Caplet Records    | `GET /caplet-records`, `GET/PATCH/DELETE /caplet-records/{id}`, `GET/PUT /caplet-records/{id}/bundle`, revision/current-revision resources, installation resources, and installation-observation collection                     | Current Host record and installation operations     |

Caplet Record subresources are:

- `GET /caplet-records/{id}/revisions`
- `GET /caplet-records/{id}/revisions/{revisionKey}`
- `GET /caplet-records/{id}/revisions/{revisionKey}/bundle`
- `DELETE /caplet-records/{id}/revisions/{revisionKey}`
- `PUT /caplet-records/{id}/current-revision`
- `GET /caplet-records/{id}/installations`
- `GET/PUT/DELETE /caplet-records/{id}/installations/{installationKey}`
- `POST /caplet-records/{id}/installation-observations`

Rules:

- `PUT /caplet-records/{id}/bundle` creates with `If-None-Match: *` and updates with `If-Match`; successful creation returns 201 and `Location`, successful replacement returns 200.
- `PATCH /caplet-records/{id}` changes document, ID, or retention metadata. Rename returns the new `Location` and ETag.
- Bundle revision paths are immutable; their ETags derive from revision identity.
- The OAuth callback is the only unauthenticated Admin-family operation. Flow ID, provider state, expiry, and the Plan 007 durable claim are its authority. It returns `Cache-Control: no-store` and never reflects provider secrets.
- Dashboard-private routes are registered outside this table and outside the shared router.

Before implementation, enumerate every existing dashboard route and every `RemoteCliCommand`. Produce a checked test fixture mapping each command to exactly one destination: v2 resource, Attach, local-only rejection, frozen v1-only compatibility, or existing public auth/self-service route. An unmapped command is a blocker.

## HTTP contract

### Success and errors

- Return the resource or operation-result DTO directly; do not wrap v2 responses in `{ ok, result }` or `{ ok, data }`.
- Return RFC 9457 Problem Details with `type`, `title`, `status`, `detail`, `code`, and optional `nextAction` and `links` extensions. `detail` must pass existing Current Host redaction.
- Use 401 for missing/invalid authentication, 403 for insufficient role or CSRF, 404 for absent resources, 409 for state conflicts or idempotency in-progress/unknown, 412 for stale conditions, 413 for byte/count limits, 415 for unsupported media types, 422 for domain-invalid representations, 428 for missing preconditions, 503 for unavailable authoritative dependencies, and 504 for existing bounded timeouts.
- Do not expose Zod internals, SQL details, filesystem paths, callback secrets, tokens, or raw downstream messages.
- Sensitive authenticated responses use `Cache-Control: no-store`. `/openapi.json` is the cacheable exception.

### Pagination

Introduce one cursor page schema and per-resource cursor codecs. Cursors are base64url-encoded opaque values bound to route, normalized filters, sort direction, and the last stable key. Invalid or cross-filter cursors return 400. Storage queries must use keyset predicates and deterministic tie-breakers; do not fetch all rows and slice in memory.

The generated CLI helper may auto-page only when the CLI command promises a complete list. Dashboard loaders request bounded pages explicitly.

### Conditional requests

Add administrative mutation generations where storage does not already expose one. Generations increment only for authoritative mutation, not incidental access-touch timestamps. Derive opaque ETags through one helper; clients must not parse them back into generations.

Collection projections may include volatile observations, but mutations first fetch the stable detail resource and use its response ETag. Every mutation path has tests for 428, 412, success with the current ETag, and the replacement ETag.

### Idempotency

Add a bounded Authoritative Host State repository keyed by `(principalClientId, operationId, idempotencyKey)` with request hash, state, timestamps, owner claim, final status/content type/safe response, and expiry. Requirements:

1. Authenticate and fully validate before claiming a key.
2. Canonicalize method, path parameters, normalized query, media type, and validated body into the request hash.
3. Same key and hash replays the finalized response. Same key with a different hash returns 409.
4. A live claim returns 409 with `Retry-After`. The worker heartbeats while semantic work runs.
5. A stale claim atomically becomes `unknown`; it is never reclaimed. The response includes reconciliation links to the affected resources.
6. Once claimed, client disconnect does not cancel semantic execution or guarded finalization. Process death is the only expected unknown-outcome path.
7. Cache final responses only after endpoint execution begins, including safe domain failures. Authentication and validation failures are not cached.
8. Bound keys to 128 visible ASCII characters, final bodies to 1 MiB, retention to 24 hours, and stored rows per principal. Prune opportunistically and through the existing host maintenance seam.
9. Exercise claim/finalize/stale races against SQLite and PostgreSQL. No check-then-insert sequence may sit outside a transaction.

## Root OpenAPI and generated client

Convert canonical non-MCP public HTTP registrations to `@hono/zod-openapi` route definitions. Existing v1 behavior may continue to call existing parsers during migration, but route definitions, security schemes, parameters, media types, and responses must describe the real contract. The root document includes:

- service/version discovery and health;
- public Remote Login, refresh, completion/cancel, and credential-owner self-revoke;
- Attach HTTP manifest/session/invoke/event routes;
- Project Binding HTTP routes and the WebSocket HTTP upgrade response, without claiming to model WebSocket messages;
- deprecated frozen `POST /v1/admin`, with a discriminated request union for accepted commands and legacy response envelopes;
- canonical `/v2/admin` resources.

It excludes MCP, dashboard static assets, dashboard login/session endpoints, `/dashboard/api/v2`, `/dashboard/api/private/*`, and WebSocket message payloads.

Generate OpenAPI 3.1 deterministically to `schemas/caplets-http.openapi.json` and serve the same document at the service-root `/openapi.json`. Use a relative server URL, a deterministic strong ETag, conditional GET, and revalidation cache headers. Host/proxy headers must not alter generated content.

Add `openapi:generate` and `openapi:check`; the check regenerates and fails on drift. Add it to `pnpm verify` before typecheck. Validate unique operation IDs, `$ref` resolution, declared security, documented success/error media types, exclusion rules, and exact agreement between the checked artifact and runtime response.

Pin exact compatible versions of `@hono/zod-openapi`, `@hey-api/openapi-ts`, the HeyAPI Fetch client/plugins, and `@fastify/busboy`. Before adopting generated output, run a disposable acceptance spike proving:

- a generated/customized operation serializes the JSON manifest first and repeated `file` parts in declared order;
- browser and Node clients do not set a boundary-less `Content-Type`;
- bundle export exposes the original `ReadableStream` and does not call `arrayBuffer`, `blob`, `text`, or `json`;
- Problem Details errors remain typed;
- separate Fetch client instances can inject CSRF/session or bearer credentials without global mutable configuration.

If either streaming proof fails, keep HeyAPI for standard operations and add operation-local serializer/parser hooks. Do not handwrite a second general Admin client.

Generate checked client artifacts under a browser-safe `@caplets/core` subpath. Keep generated files isolated from handwritten authentication/base-URL adapters and add a staleness check. Stable operation IDs, not generated function spelling, are the compatibility anchor.

## Streaming Caplet Bundles

### Upload contract

`PUT /caplet-records/{id}/bundle` accepts `multipart/form-data` with:

1. exactly one first field named `manifest`, containing bounded JSON;
2. an ordered `files` array in the manifest; each entry declares normalized logical path, exact byte size, SHA-256, and executable intent;
3. exactly one subsequent field named `file` per manifest entry, in the same order.

Part filenames are informational and ignored. Logical paths come only from the manifest and pass the canonical Caplet Bundle path/case-collision validator. Reject unknown fields, files before the manifest, duplicate manifests, missing/extra files, size/hash mismatch, invalid executable metadata, duplicate paths, special-file intent, and any trailing part.

Use `@fastify/busboy` over `Readable.fromWeb(c.req.raw.body)`. Configure explicit field-name, field-size, field-count, file-size, file-count, part-count, header-pair, and header-size limits. Retain the existing semantic ceilings: 2,048 files, one 64 MiB `CAPLET.md` document, and up to 256 MiB of auxiliary files. With the bounded manifest and bounded multipart framing, the enforced legal one-upload capacity is 369,283,314 bytes (about 352.2 MiB). Reject oversized `Content-Length` before reading and count actual streamed bytes so chunked bodies cannot bypass the ceiling.

### Staging and admission

Create a process-owned `mkdtemp` root under a configurable upload staging directory, then a mode-0700 request directory and mode-0600 random/indexed files. Never use logical paths as staging paths and never set staged executable bits. Stream each part through byte-count and SHA-256 verification into an exclusive file.

Default to one active bundle upload per Host Node. Add configurable concurrency and aggregate staged-byte quotas, but configuration must be able to admit one legal maximum bundle. Reserve capacity before reading; reject excess work with 429 and `Retry-After` rather than queueing open request bodies.

Use the deployment precedence already established for serve options: CLI option, environment, `serve` config, then default. Default beneath `os.tmpdir()`. Document `emptyDir` with `sizeLimit` for Kubernetes and an equivalent bounded ephemeral mount for containers. A process removes its request directories in `finally` and its process root on graceful shutdown. It must not scan or delete another process's staging root; crash residue is left to the ephemeral volume lifecycle.

Abort, parser error, limit event, hash mismatch, client disconnect before semantic claim, storage failure, and response failure all close streams and remove request files. Tests inject small limits; a separate smoke scenario uses large generated files and observes bounded RSS.

### Storage seam

Replace the Buffer-only bundle input at the source of the problem. Introduce an internal reopenable file source with logical metadata, known byte length/hash, and `open(): ReadableStream<Uint8Array>`. Provide Buffer and staged-file adapters. Storage revalidates paths, sizes, and hashes; it never trusts transport verification.

Refactor Caplet Record import/update so it does not build one `Buffer[]` for the whole bundle:

- inspect and validate sources incrementally;
- buffer only bounded `CAPLET.md` and, for SQL blob insertion, one legal file at a time;
- stream object-store uploads with declared length and checksum verification;
- preserve transaction, revision, installation, activity, cleanup, and post-commit activation semantics;
- expose a streaming bundle reader for HTTP export while retaining bounded materialization helpers for local callers that require them.

`GET` bundle responses use `multipart/mixed`: a bounded JSON manifest first, then binary parts in manifest order. Generate a safe boundary, preserve per-file hashes/sizes/executable intent, support revision exports, set `Content-Disposition: attachment` with a sanitized name, and cancel the active storage stream when the response consumer disconnects.

## Semantic Module deepening

Move full-bundle, revision, retention, rename, installation, backend-auth connection/flow, and required versioned client/login operations behind `CurrentHostOperations`. Split the union into adjacent family modules if compile or navigation cost warrants it, but retain one public `execute(principal, operation)` Interface and one outcome family.

The Module owns:

- Operator authorization invariants and actor identity;
- safe validation and redaction;
- activity records;
- config activation after committed mutation;
- session termination results after revoke/demotion;
- catalog provenance/risk behavior;
- optimistic concurrency and domain conflicts.

The HTTP Adapter owns media types, headers/statuses, pagination parameter decoding, CSRF/bearer ceremony, and Problem Details projection. It never receives actor identity from request data and never calls `HostStorage` directly.

## Router and authentication structure

Create the shared route registrations once and instantiate them with two principal providers:

- bearer Adapter: validate the active Remote Client, require exact Operator role, retain the validated principal;
- dashboard Adapter: validate dashboard session/backing Operator Client, enforce CSRF on unsafe methods, expire the cookie when semantic outcomes end the acting session;
- trusted development principal: preserve the existing verified-loopback-only rule.

Do not branch between bearer and cookie auth inside handlers. Do not register Raw Vault Reveal in the shared router. Keep credential-owner self-revoke role-neutral on its existing public route.

Break `serve/http.ts` into composition and protocol seams rather than adding another route cluster to the monolith. Preserve MCP SDK ownership of MCP body parsing.

## Client and compatibility migration

### Dashboard

Replace generic caller-selected response casts with the generated Admin SDK for shared resources. Use a dashboard-local client instance whose request Adapter supplies the session cookie and current CSRF token; generate a fresh idempotency key per user intent and retain it across transport retries. Preserve current UI behavior, confirmations, toasts, stale-response guards, and session invalidation. Move Raw Vault Reveal to its private path without putting it in the generated client.

Plan 011 remains the follow-up for route-aware loading. Plan 000 may preserve the current broad refresh behavior while changing its transport.

### Remote CLI

Resolve version discovery first. Prefer `/v2/admin` when advertised; fall back to frozen `/v1/admin` for older hosts. Map commands as follows:

- install/update, backend auth, Vault, and Caplet Record administration use the generated Admin SDK;
- runtime inspect/check/list/tool/resource/prompt/complete operations use existing Attach/native client seams;
- remote `init` and `add` fail locally with migration guidance;
- completion composes local static completions with Admin/Attach discovery instead of calling `complete_cli` on v2;
- bundle import/export stream from/to files and never encode/decode a whole JSON/base64 bundle.

Keep Remote Profile selection, refresh credentials, safe terminal output, and local/project overlay behavior intact.

### Frozen v1 Adapter

Retain `POST /v1/admin` and its safe `{ ok, result }` / `{ ok: false, error }` envelopes. Mark the OpenAPI operation deprecated and return `Deprecation: true` plus a migration `Link`; do not emit `Sunset` without a date.

Freeze the command union. Translate administrative commands to the same semantic Module, runtime commands to Attach execution seams, and unsupported remote `init`/`add` to the legacy safe error envelope. Do not add v2 capabilities to v1. Add parity tests for every accepted command family and explicit rejection tests for removed filesystem commands.

## Implementation sequence

1. **Drift and contract inventory.** Re-read current route registrations, command union/dispatch, dashboard callers, remote CLI callers, storage limits, and both-dialect schemas. Build the exhaustive destination fixture and run prerequisite gates.
2. **Acceptance spikes.** Prove HeyAPI ordered upload/unbuffered download and Busboy/Hono stream ownership in disposable tests. Remove spike artifacts after recording the result in Plan 000's implementation notes.
3. **Contract foundation.** Add Zod schemas, Problem Details, pagination, ETag helpers, root OpenAPI generation/checking, and documentation-only definitions for existing public routes without changing behavior.
4. **Authoritative state.** Add row versions and the idempotency repository/migrations with SQLite/PostgreSQL concurrency tests. Integrate Plan 007's durable backend-auth flow repository.
5. **Deepen Current Host operations.** Move storage/backend-auth orchestration and activity/config activation behind the Module; delete direct transport-to-store paths.
6. **Stream bundles.** Add reopenable source ingestion, object-store/SQL incremental handling, upload admission/staging/parser, multipart export, and streaming smoke evidence.
7. **Register v2 twice.** Mount canonical bearer and dashboard routers with distinct auth middleware and shared relative handlers. Move private reveal separately.
8. **Generate and migrate clients.** Generate HeyAPI artifacts, migrate dashboard and CLI by command family, and add version-discovery fallback.
9. **Freeze v1.** Reduce dispatch to compatibility mapping, reject remote filesystem commands, add deprecation headers, and delete obsolete encoders/decoders only where no v1 contract still needs them.
10. **Documentation and release.** Update architecture/product/CLI docs, root schema references, container staging examples, changesets, and affected plans. Run all focused and full gates.

Do not combine steps 4-9 into one unreviewable edit. Each step must leave focused tests green, but the branch is not releasable until the end-to-end smoke scenarios pass.

### Implementation notes

- The Plan 007 prerequisite now exposes backend OAuth through `RemoteAuthFlowCoordinator` and the repository-backed `HostStorage.backendAuthFlows` API. V1 start and callback routes are Adapters over the same durable start, claim, credential-write, and guarded-finalize path; acquired completion work is not owned by the browser connection.
- This prerequisite integration does not complete Plan 000. Required PostgreSQL coverage and the built-server, two-Host-Node OAuth smoke remain Plan 000 launch verification.
- [Plan 019](019-fix-dashboard-mutation-races.md) separately completes the production fixes exposed by Plan 009's characterization coverage: safe-GET CSRF handling, restart pending cleanup, stale-revoke protection, and successful-mutation completion ordering. Plan 009 therefore remains test-only while Plan 000 inherits the corrected behavior.

## Required verification

### Contract and authorization

- Root OpenAPI artifact and runtime response are byte-equivalent after canonical serialization; conditional GET returns 304.
- The document includes canonical public v1/v2 HTTP paths, excludes MCP and browser-internal paths, has unique stable operation IDs, and generates the checked HeyAPI client without drift.
- Access credentials fail all Admin routes. Operator bearer and dashboard session produce equivalent domain outcomes for one read and mutation in every resource family.
- Dashboard unsafe methods require CSRF. Bearer methods do not accept dashboard cookies as authority.
- Raw Vault Reveal is reachable only through the private dashboard ceremony and returns `no-store`.

### HTTP behavior

- Representative routes prove direct success DTOs and safe Problem Details for 400, 401, 403, 404, 409, 412, 413, 415, 422, 428, and 503.
- Every mutable family proves current/stale/missing conditional requests and returns replacement ETags.
- Cursor tests cover stable ordering, filter binding, inserts/deletes between pages, invalid cursors, and max limits without full-table materialization.
- Idempotency tests cover concurrent equal keys, key/hash mismatch, replay after lost response, live claim, disconnect with guarded finalization, stale claim to unknown, retention pruning, and both SQL dialects.

### Bundle behavior

- Reject oversized declared and chunked bodies, oversized manifest/header/file/count/total limits, file-before-manifest, unknown/duplicate parts, invalid paths, hash/size mismatch, missing/extra files, and parser aborts.
- Every failure removes staged files and releases admission capacity.
- Legal multipart upload creates and conditionally replaces a record; activation and activity occur once.
- Multipart export streams manifest and files in order, preserves executable intent/hashes, supports historical revision, and cancels storage reads on disconnect.
- A child-process smoke imports and exports a generated multi-file large bundle while sampled RSS remains bounded to baseline plus parser buffers and one legal SQL file, not total bundle plus base64 copies.

### Compatibility

- A new CLI uses v2 against a new host and v1 against a legacy-host fixture.
- A legacy CLI can use every retained v1 command family against a new host; v1 `init`/`add` return explicit safe migration errors.
- Runtime CLI operations execute through Attach, not Admin.
- Dashboard behavior characterized by Plan 009 remains intact after the generated-client migration.

Run focused gates while implementing, then:

```sh
pnpm schema:check
pnpm openapi:check
pnpm code-mode:check-api
pnpm --filter @caplets/core test
pnpm --filter @caplets/dashboard test
pnpm --filter @caplets/core typecheck
pnpm --filter @caplets/dashboard typecheck
pnpm build
pnpm verify
```

Run required PostgreSQL commands with `CAPLETS_REQUIRE_TEST_POSTGRES=1` and the CI test URL; no relevant suite may skip.

Smoke a built server, not a test handler:

1. fetch `/openapi.json` unauthenticated and regenerate the client;
2. pair Access and Operator clients and prove the role matrix;
3. perform one conditional/idempotent mutation through bearer and dashboard mounts;
4. upload and export a large bundle while observing staging cleanup and process RSS;
5. complete backend OAuth through a different Host Node than the start request;
6. invoke one retained v1 command and one rejected filesystem command;
7. invoke one runtime operation through Attach.

## Completion criteria

- Every legacy command and dashboard operation has one documented destination with no transport-owned policy.
- Both Admin mounts share route schemas and handlers but not authentication ceremony.
- Root OpenAPI and HeyAPI artifacts are generated, checked, public, cacheable, and accurate.
- V2 uses direct resources, Problem Details, cursor pages, conditional requests, and durable idempotency as specified.
- Bundle transport and storage no longer materialize a whole JSON/base64 bundle in memory.
- Backend OAuth completion and idempotency are coherent across Host Nodes and fail closed on ambiguous ownership.
- V1 is frozen, deprecated, compatible for retained commands, and rejects remote filesystem mutation.
- Raw Vault Reveal, Access authority, and actor attribution boundaries remain intact.
- Focused tests, PostgreSQL contracts, smoke scenarios, build, and `pnpm verify` pass.
- A release changeset describes the new v2 Admin API, generated client, v1 deprecation, remote `init`/`add` rejection, and bundle wire change.

## Escape hatches

- If the HeyAPI spike buffers `multipart/mixed` or cannot preserve ordered upload parts, keep generated standard operations and implement only those operation-local hooks; do not abandon the root OpenAPI contract.
- If Hono or middleware has already consumed a multipart body, stop and move limiting/parsing before that consumer. A post-buffer size check is not containment.
- If legal bundle metadata cannot fit 16 MiB, measure the canonical manifest and path limits before adjusting. Do not reduce storage semantics.
- If PostgreSQL migrations or concurrency suites cannot run, mark the plan BLOCKED. Do not ship SQLite-only authoritative state.
- If an existing command cannot be assigned without changing authority, record the conflict and amend ADR 0007 before implementation.
- If an external side effect cannot be reconciled after an idempotency owner crash, retain the `unknown` fail-closed outcome; never silently re-execute.

## Maintenance note

New Current Host capabilities begin as semantic operations and canonical v2 resources. They receive Zod/OpenAPI definitions, Problem Details, authorization, conditional/idempotency policy, generated-client coverage, and both authentication-Adapter tests in the same change. They are never added to frozen v1.

## Implementation notes

- `@hono/zod-openapi` `1.2.0`, `@hey-api/openapi-ts` `0.99.0`, `busboy` `1.6.0`, and
  `@types/busboy` `1.5.4` are pinned exactly. Route-local schemas generate the checked root document
  and staged generated HTTP client. Plan 020 publishes that full public contract as `@caplets/sdk`.
- One `ADMIN_V2_ROUTE_DEFINITIONS` table drives OpenAPI and both shared-router mounts. The
  Operator bearer Adapter validates the selected paired Remote Profile; the dashboard Adapter
  supplies cookie, session, origin, and CSRF authority. No separate Admin token was introduced.
- The acceptance spikes proved Fetch-owned ordered FormData and unbuffered response streams.
  Generated standard operations remain authoritative; operation-local hooks provide reopenable
  file-backed multipart uploads and streaming multipart downloads without a second general client.
- Busboy owns admitted upload streams before body parsing. Reopenable Buffer and staged-file sources
  feed incremental SQL/object-store ingestion, while multipart exports propagate cancellation to
  their active source.
- Idempotency, row generations, backend OAuth claims, and activity records use Authoritative Host
  State with SQLite/PostgreSQL parity. Current Host semantic operations own policy and persistence;
  HTTP and legacy command Adapters only authenticate, validate, translate, and serialize.
- The frozen command-destination fixture maps retained v1 administration to Current Host operations,
  runtime commands to Attach, and `init`/`add` to explicit local-only rejection. New CLI discovery
  selects v2 only from an explicit matching advertisement and falls back only to a definitive
  v1-only host.
- Compose deployments stage Admin uploads at `/data/state/caplets/admin-uploads` rather than the
  hardened 64 MiB `/tmp` tmpfs. The default one-upload aggregate admission limit is 369,283,314
  bytes (about 352.2 MiB), covering one 64 MiB `CAPLET.md` document, up to 256 MiB of auxiliary
  files, a bounded manifest, and bounded multipart framing.
- Plan 020's pre-release cutover is implemented. `@caplets/sdk` now owns the independent generated
  public HTTP client and root streaming bundle helpers; browser-safe `@caplets/sdk/project-binding`
  owns the fixed v1 coordinator, and `@caplets/sdk/project-binding/node` owns marker-aware filesystem
  fingerprints.
- Dashboard and core/CLI callers now create isolated SDK clients with their own explicit service or
  WebSocket roots and caller-owned authentication. The unreleased core Admin-client source/export,
  generated-internal imports, aliases, and duplicate client-side Project Binding implementation are
  removed. Final focused, PostgreSQL, smoke, generated-artifact, full-repository, and two-axis
  review gates pass.
