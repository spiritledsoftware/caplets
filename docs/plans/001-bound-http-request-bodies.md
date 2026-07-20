# Plan 001: Bound HTTP Request Bodies Before JSON Parsing

> Status: COMPLETE
> Planned against: `ac12a174`
> Finding: #1 — unbounded request-body buffering
> Priority: P0
> Effort: S
> Fix risk: LOW

## Why this matters

`packages/core/src/serve/http.ts` passes request-body promises directly to JSON parsers on public login, authenticated control, attach, Project Binding, dashboard, and MCP-adjacent routes. An unauthenticated or low-privilege caller can therefore force the Node process to buffer arbitrarily large JSON before semantic validation runs. `apps/catalog/src/lib/ingest.ts` already shows the repository's preferred boundary: reject an oversized `content-length`, then stream and count bytes so chunked requests cannot bypass the limit.

This plan adds transport-level byte ceilings. It must not shrink the existing semantic Caplet bundle limits or change successful response envelopes.

## Coordination with Plan 000

This plan lands before Plan 000 and establishes the bounded JSON reader that the OpenAPI-backed routes must invoke before Zod parsing. It continues to protect frozen `/v1/admin`, including its retained JSON/base64 bundle commands. Plan 000 separately owns v2 manifest-first multipart admission, staging, and streaming limits; do not add Busboy or the v2 bundle media contract here.

## Scope

### In scope

- `packages/core/src/serve/http.ts`
- A new focused helper under `packages/core/src/serve/` only if extracting it keeps `http.ts` readable
- `packages/core/test/serve-http.test.ts`
- `packages/core/package.json` only if a new exported constant is required
- One patch changeset for `@caplets/core`

### Out of scope

- MCP SDK transport internals after the request has entered `StreamableHTTPServerTransport`
- Per-field validation or schema redesign
- Rate limiting, IP blocking, reverse-proxy configuration, or compressed-body support
- Reducing `CapletRecordStore`'s 2,048-file, 64 MiB per-file, or 256 MiB total bundle limits

## Current state and exemplars

`packages/core/src/serve/http.ts` currently parses bodies without a byte guard:

```ts
const parsed = await parseJsonObject(c.req.json(), "Dashboard login start request");
```

The same pattern appears for stored Caplet import/update, pending login, remote control, attach invocation, Project Binding sessions, Vault mutations, and catalog mutations.

`apps/catalog/src/lib/ingest.ts:48-57` is the behavior to match:

```ts
const contentLengthHeader = request.headers.get("content-length");
const contentLength = contentLengthHeader ? Number(contentLengthHeader) : undefined;
if (
  contentLength !== undefined &&
  (!Number.isSafeInteger(contentLength) || contentLength > maxBodyBytes)
) {
  throw new Error("request_body_too_large");
}
const body = JSON.parse(await readLimitedRequestText(request, maxBodyBytes));
```

The helper later reads `request.body` incrementally and cancels once accumulated bytes exceed the ceiling. Preserve that two-layer defense.

The downstream bundle ceiling is defined at `packages/core/src/storage/caplet-records.ts:181-214`:

```ts
const MAX_BUNDLE_FILES = 2_048;
const MAX_BUNDLE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_TOTAL_BYTES = 256 * 1024 * 1024;
```

## Required design

Add one transport helper with this contract:

```ts
async function readLimitedJsonObject(
  request: Request,
  label: string,
  maxBytes: number,
): Promise<Record<string, unknown>>;
```

It must:

1. Reject malformed, negative, non-integer, or over-limit `content-length` before reading the stream.
2. Read `request.body` through a reader, count raw bytes, cancel on overflow, and never concatenate more than `maxBytes`.
3. Fall back to bounded `request.arrayBuffer()` only when `body` is absent and the platform has already materialized a body.
4. Decode UTF-8 with a fatal `TextDecoder`; invalid UTF-8 is `REQUEST_INVALID`.
5. Parse JSON once, then reuse the existing `parseJsonObject` object-shape validation.
6. Throw a `CapletsError("REQUEST_INVALID", ...)` with a stable public message for malformed JSON and a distinct stable public message for oversized input. Do not include body content.

Define named limits near the other HTTP constants:

- `AUTH_REQUEST_MAX_BYTES = 64 * 1024` for login start/poll/complete/cancel/refresh and callback metadata.
- `CONTROL_REQUEST_MAX_BYTES = 1024 * 1024` for ordinary dashboard, frozen remote-control, Project Binding metadata, and administrative JSON mutations.
- `ATTACH_INVOKE_REQUEST_MAX_BYTES = 16 * 1024 * 1024` for tool invocation arguments.
- `LEGACY_CAPLET_BUNDLE_REQUEST_MAX_BYTES`: apply only to retained `/v1/admin` JSON/base64 import and update. Derive it from the authoritative bundle total ceiling plus base64 expansion and a measured metadata allowance. Export the bundle total constant from `caplet-records.ts` rather than duplicating `256 * 1024 * 1024`; a legal legacy bundle must fit.

Do not silently route every endpoint through the largest limit.

## Implementation steps

### 1. Add failing helper-level tests

In `packages/core/test/serve-http.test.ts`, add tests using a `ReadableStream` with no `content-length`:

- JSON exactly at the selected small limit reaches semantic parsing.
- JSON one byte over the limit returns the existing safe error envelope and never pulls a trailing sentinel chunk.
- An oversized `content-length` is rejected before the stream's first `pull`.
- Invalid UTF-8 and malformed JSON return `REQUEST_INVALID` without echoing input.

Use the existing app construction helpers and cleanup convention (`await app.closeCapletsSessions(); await engine.close();`). Do not test helper source text.

Run:

```sh
pnpm --filter @caplets/core test -- test/serve-http.test.ts
```

Expected before implementation: new tests fail because the body is fully consumed or the expected bounded error is absent.

### 2. Implement the bounded reader

Add the helper in `serve/http.ts` or `serve/request-body.ts`. If extracted, keep it internal; no package export is needed. Use Web Streams and `TextDecoder`, not Node-only stream adapters, so Hono's request contract remains portable.

Replace every direct non-MCP `c.req.json()` in `serve/http.ts` with the bounded helper and assign the narrowest category above. Ensure future `@hono/zod-openapi` validators introduced by Plan 000 run only after the same limit has wrapped or consumed the stream. For parsers that currently accept `Promise<unknown>`, either pass `Promise.resolve(parsed)` temporarily or, preferably, change the local parser to accept `unknown`; do not create two JSON parses.

Run:

```sh
pnpm --filter @caplets/core test -- test/serve-http.test.ts
```

Expected: all new boundary tests and existing HTTP route tests pass.

### 3. Cover representative route classes

Add table-driven route tests for at least:

- unauthenticated pending-login start (`AUTH_REQUEST_MAX_BYTES`),
- authenticated dashboard mutation (`CONTROL_REQUEST_MAX_BYTES`),
- attach invoke (`ATTACH_INVOKE_REQUEST_MAX_BYTES`),
- frozen v1 stored Caplet import (`LEGACY_CAPLET_BUNDLE_REQUEST_MAX_BYTES`).

Each test should verify both the HTTP status/error code and that an in-limit request still reaches the existing handler. Do not build a brittle test for every route string.

Run:

```sh
pnpm --filter @caplets/core test -- test/serve-http.test.ts
pnpm typecheck
```

Expected: exit 0.

### 4. Document the user-visible ceiling

Add a patch changeset for `@caplets/core` stating that HTTP JSON bodies are now bounded and oversized requests return `REQUEST_INVALID`. Do not document internal constant names in public docs.

Run:

```sh
pnpm format:check
pnpm lint
```

Expected: exit 0.

## Done criteria

- No `c.req.json()` remains in `packages/core/src/serve/http.ts` outside a deliberate, documented MCP transport pass-through.
- Chunked bodies cannot bypass limits.
- Legal maximum legacy JSON/base64 Caplet bundles are not rejected by the transport limit before storage validation.
- Oversized input is rejected without body reflection and without reading trailing chunks.
- `pnpm --filter @caplets/core test -- test/serve-http.test.ts`, `pnpm typecheck`, `pnpm format:check`, and `pnpm lint` all exit 0.
- The diff contains no proxy, compression, rate-limit, or unrelated HTTP refactor.

## Escape hatches

- If Hono has already consumed the request body before these handlers, STOP and report the middleware or adapter that does so; do not add a misleading post-buffer length check.
- If legal stored-bundle JSON can exceed the computed base64 allowance, measure the actual serializer used by dashboard/CLI import and adjust from evidence; do not lower storage semantics.
- If the MCP SDK owns parsing for `paths.mcp`, leave that route untouched and state the boundary explicitly in the changeset.
- If Plan 000 has already landed, retain this helper for JSON routes and frozen v1 only; do not route multipart through a text decoder.

## Maintenance note

Every new JSON route must choose a named request class and apply its byte guard before Zod or JSON parsing. Reviewers should reject unguarded `c.req.json()` additions because semantic schema validation does not bound transport memory. V2 bundle routes follow Plan 000's separate streaming multipart contract.
