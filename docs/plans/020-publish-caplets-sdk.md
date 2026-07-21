# Plan 020: Publish The Caplets SDK And Complete The Client Cutover

> Status: COMPLETE
> Planned against: `5853e5ad` plus the staged Plan 000 implementation
> Direction: replace `@caplets/core/admin-client` with one public Caplets SDK
> Priority: P0
> Effort: XL
> Fix risk: HIGH
> Integration point: execute on the Plan 000 branch after the canonical HTTP contract exists and before Plan 000 review, changeset validation, or commit
> Decision context: ADR 0007 and the Plan 000 decisions, amended by this plan

> **Pre-release integration:** This completed plan remains authoritative for the `@caplets/sdk` package seam, generated-operation discipline, streaming helpers, Project Binding coordinator, and caller cutover. After [Plan 022](022-remove-legacy-caplets-cloud.md) removes Legacy Caplets Cloud, [Plan 023](023-use-fixed-origin-protocol-namespaces.md) regenerates the SDK for the fixed origin-root route map and replaces this plan's root OpenAPI location, prefixed service-root inputs, Cloud workspace-path accommodation, and frozen v1 Admin surface before the first release. Old paths and client fallbacks do not survive.

## Executor instructions

Follow this plan in order. Use red-green TDD at the package interface, generated-contract, Project Binding protocol, and consumer seams. Run each focused command before moving on. Do not reset, discard, or overwrite unrelated staged or untracked work.

Start with:

```sh
git rev-parse --short HEAD
git status --short
git diff --stat 5853e5ad -- \
  package.json pnpm-workspace.yaml turbo.json openapi-ts.config.ts \
  packages/core packages/sdk apps/dashboard scripts tools schemas docs .changeset
```

The plan was written while Plan 000 was staged but not committed. If the Plan 000 work has since been committed, rebase the path references onto that commit and continue only if the contracts below still match. If the current tree has neither the staged Plan 000 implementation nor an equivalent committed implementation, stop: this SDK cannot be generated from the pre-Plan-000 HTTP contract.

## Why this matters

The staged generator already consumes the canonical root OpenAPI document, which currently describes 61 paths and 75 operations across discovery, Remote Login, Attach, Project Binding, frozen v1 Admin, and v2 Admin. The generated code is nevertheless owned and published as `@caplets/core/admin-client`. That name understates its scope, and installing it pulls in a server/runtime package containing database, AWS, MCP, Hono, and native runtime dependencies that an HTTP client does not need.

A public `@caplets/sdk` package gives browser and Node 22 callers one typed client for Caplets public server protocols. The package remains Fetch-first and generated from the server contract, while small curated Modules preserve the HTTP semantics that HeyAPI cannot safely implement by itself: ordered streaming Caplet Bundles and the versioned Attach Project Binding WebSocket session.

This is a clean pre-release cutover inside Plan 000. `@caplets/core/admin-client` must not become a second public interface.

## Fixed decisions

1. The package is `@caplets/sdk` under `packages/sdk`, not `apps/sdk`. Apps in this repository are private deployed applications; public reusable packages live under `packages/`.
2. The initial published SDK version is `0.1.0`, versioned independently from core and the CLI. Follow the repository's new-package Changesets precedent: source `package.json` starts at `0.0.0` and the launch changeset applies a `minor` bump.
3. `@caplets/sdk` is an independent ESM leaf package. It has no runtime dependency on `@caplets/core` or `caplets`.
4. The canonical source is `schemas/caplets-http.openapi.json`, generated from route-local Zod/OpenAPI definitions. The npm package ships generated JavaScript and declarations, not a copied OpenAPI JSON export.
5. The root SDK covers every canonical public HTTP route in `/openapi.json`: service/version discovery, health, Remote Login and credential self-service, Attach, Project Binding HTTP controls, frozen v1 Admin, and v2 Admin.
6. MCP, dashboard cookie/session/CSRF routes, Raw Vault Reveal, and other browser-private routes remain excluded.
7. The generated operation and type names are public semver surface. OpenAPI `operationId` and named schema changes require compatibility review and an appropriate SDK changeset.
8. Callers create isolated clients. There is no global mutable singleton.
9. `createClient` requires an absolute Caplets service-root `baseUrl`, including any deployment prefix. It does not infer roots from MCP, dashboard, Attach, or Cloud URLs.
10. `auth` is optional and caller-owned. It may be a static bearer token or HeyAPI's async token provider. The SDK does not persist credentials, run Remote Login polling, or own refresh policy.
11. `fetch` is optional and defaults to `globalThis.fetch`. The root package and `@caplets/sdk/project-binding` support modern browsers and Node 22 without Node built-ins.
12. Generated operations default to `responseStyle: "fields"` and `throwOnError: false`; callers may opt into throwing per client or operation.
13. Ordered bundle FormData, streaming upload, unbuffered download, and cancellation helpers remain curated root exports because raw generation does not preserve those contracts.
14. The full Project Binding coordinator is exported only from `@caplets/sdk/project-binding`. It is not a generated HTTP operation and is not re-exported from the package root.
15. The filesystem fingerprint helper is exported only from `@caplets/sdk/project-binding/node`. The browser-safe coordinator requires a caller-supplied `projectFingerprint`.
16. Project Binding WebSocket protocol `caplets.project-binding.v1` becomes a documented, validated public contract. Its message schemas are authoritative Zod schemas in core and named components in the canonical OpenAPI document, even though OpenAPI does not model the channel lifecycle.
17. The coordinator requires the exact `ws:` or `wss:` Project Binding connect URL. It derives the sibling session, heartbeat, and terminal HTTP URLs from that URL, which supports self-hosted prefixes, proxies, and existing Cloud workspace paths without embedding Cloud discovery policy.
18. Project Binding timing is protocol policy, not caller configuration: dual HTTP/WebSocket heartbeat every 15 seconds, one reconnect after an unexpected close, and bounded guarded finalization. Do not publish heartbeat/retry tuning knobs.
19. Session events use an `onEvent` callback plus one terminal promise. If the callback throws, the coordinator finalizes and reports that failure.
20. The coordinator follows fields-by-default failure semantics and supports `throwOnError: true`. Abort is a typed failure outcome after cleanup, not a successful terminal result.
21. Finalization is attempted exactly once. Preserve the initiating failure and attach a safe secondary cleanup failure; a cleanup failure becomes primary only when no earlier failure exists.
22. Migrate every repository caller and remove the core generated HTTP client source, export, bundle entry, aliases, and generated-internal imports. Leave no compatibility alias.
23. Full public documentation is required: package README, docs-site page/navigation, root README, architecture/product/Project Binding docs, glossary, ADR/Plan notes, contributor package map, and release changeset.

## Current state to preserve or correct

### Generated client ownership is wrong, but generation scope is already broad

- `scripts/generate-openapi.ts:11-14` writes `schemas/caplets-http.openapi.json` and generates into `packages/core/src/admin-client/generated` using `tools/admin-client-generator` and root `openapi-ts.config.ts`.
- `packages/core/src/admin-client/generated/index.ts` exports all generated public operations, including `getServiceDiscovery`, Remote Login, Attach, Project Binding, v1 Admin, and v2 Admin.
- `packages/core/src/admin-client/index.ts` adds isolated `createClient` and operation-local Caplet Bundle helpers.
- `packages/core/package.json:86-89` and `packages/core/rolldown.config.ts:31` publish and bundle `./admin-client`.
- `scripts/admin-client-artifacts.test.ts` already protects client isolation, browser safety, unbuffered bundle streams, and manifest-first FormData. Move and deepen this behavior; do not replace it with source-text-only tests.

### Current consumers bypass a real package seam

- `apps/dashboard/src/lib/api.ts:1-77` imports the generated Admin operations and types from `@caplets/core/admin-client`.
- Dashboard Astro, TypeScript, and Vitest configs alias that specifier directly to core source. Replace these aliases with a declared `@caplets/sdk: workspace:*` dependency.
- `packages/core/src/remote-cli/admin.ts` imports the public wrapper and also reaches into `../admin-client/generated/types.gen`. The SDK root must export every type needed by this caller so no consumer imports generated internals.
- `packages/core/src/remote-cli/public-auth.ts` imports generated SDK/client internals directly. Migrate it to root `@caplets/sdk` exports.

### Project Binding runtime and the staged OpenAPI contract disagree

Correct this before treating the SDK as public:

- Runtime session creation in `packages/core/src/serve/http.ts:1326-1439` accepts `projectRoot` plus optional `projectFingerprint`, derives its own server workspace fingerprint, and returns `{ binding, sessionId }`.
- Runtime heartbeat in `packages/core/src/serve/http.ts:1455-1492` accepts `{ sessionId, state, syncState }` and returns `{ ok, binding }`.
- Staged OpenAPI schemas in `packages/core/src/admin-api/openapi.ts:824-837` instead describe `serverWorkspaceFingerprint` on creation and `{ generation, projectFingerprint }` on heartbeat. Several Project Binding successes use generic `resourceSchema` or untyped success responses.
- Runtime v1 Project Binding errors are legacy envelopes, while the generic route helper currently advertises Problem Details. Preserve v1 wire compatibility and describe the actual envelope unless a separately approved migration changes it.
- `packages/core/src/serve/http.ts:2950-2973` manually parses client socket messages; `packages/core/src/project-binding/session.ts:347-358` trusts server messages after checking only the discriminant. Replace both with the same versioned schema semantics and explicit rejection behavior.

### Existing coordinator behavior is the implementation seed, not the target interface

`packages/core/src/project-binding/session.ts` already coordinates session creation, WebSocket authentication, heartbeats, one reconnect, and cleanup. It currently:

- imports Node `Buffer` and filesystem fingerprinting;
- accepts `ResolvedCapletsRemote` and a remote resolver rather than an SDK client plus explicit endpoint;
- exposes `heartbeatIntervalMs`;
- throws on failure;
- can let cleanup mask the initiating failure;
- does not validate all inbound message fields.

Extract the state machine, but implement the fixed public interface and finalization rules in this plan rather than copying those defects.

## Public package interface

### Root export: `@caplets/sdk`

The public entry contains:

- `createClient`;
- `Client`, `CapletsClientConfig`, `Auth`, and the selected HeyAPI request/result types needed by callers;
- all generated operation functions and generated request/response/schema types;
- current bundle helpers and their public types.

Target factory shape:

```ts
export type CapletsClientConfig = Omit<Config, "baseUrl"> & {
  baseUrl: string;
};

export function createClient(config: CapletsClientConfig): Client;
```

`createClient` validates an absolute `http:` or `https:` service root, applies `{ responseStyle: "fields", throwOnError: false }` before caller overrides, and delegates to the generated client factory. `auth` and `fetch` stay optional through `Config`.

Expected usage:

```ts
import { createClient, getServiceDiscovery } from "@caplets/sdk";

const client = createClient({
  baseUrl: "https://host.example/caplets",
  auth: () => credentialStore.current(),
});

const result = await getServiceDiscovery({ client });
if (result.error) {
  // Inspect the typed error and optional Response.
}
```

Do not add a bound namespace facade, global `client.setConfig()` singleton, credential store, retry policy, endpoint inference, or a second factory name.

### Project Binding export: `@caplets/sdk/project-binding`

Target input:

```ts
export type RunProjectBindingSessionInput<ThrowOnError extends boolean = false> = {
  client: Client;
  webSocketUrl: string | URL;
  projectRoot: string;
  projectFingerprint: string;
  signal?: AbortSignal;
  onEvent?: (event: ProjectBindingSessionEvent) => void;
  webSocketFactory?: ProjectBindingWebSocketFactory;
  throwOnError?: ThrowOnError;
};
```

Do not expose heartbeat interval, retry count, retry delay, credential, workspace, or separate sibling endpoint fields.

Success data contains:

```ts
type ProjectBindingSessionData = {
  bindingId: string;
  sessionId: string;
  projectRoot: string;
  projectFingerprint: string;
  webSocketUrl: string;
  ended: true;
};
```

Default result mirrors HeyAPI fields style:

```ts
type ProjectBindingSessionResult =
  | { data: ProjectBindingSessionData; error: undefined }
  | { data: undefined; error: ProjectBindingSessionError };
```

With `throwOnError: true`, resolve the data directly and reject with `ProjectBindingSessionError` on failure.

`ProjectBindingSessionError` must distinguish at least `http`, `protocol`, `socket`, `callback`, `aborted`, and `cleanup`. It may carry a safe HTTP Problem/legacy error projection and optional `response`. It must not place a bearer token, WebSocket bearer subprotocol, raw request headers, or arbitrary response body in its message. Its optional cleanup detail is secondary and safe to log.

Events remain the existing semantic set: `state`, `ready`, `reconnecting`, `heartbeat`, and `ended`. Publish exact discriminated unions and validate all inbound server messages before emitting them.

### Node export: `@caplets/sdk/project-binding/node`

Move the established marker-aware `fingerprintProjectRoot(root)` implementation from `packages/core/src/cloud/project-root.ts`. This subpath may use `node:crypto`, `node:fs`, and `node:path`; neither the root nor `@caplets/sdk/project-binding` may import it.

Keep `findProjectRoot` in core unless a separate decision moves general project discovery. Core callers may import the SDK Node helper directly.

## Project Binding v1 protocol contract

### Negotiation and authentication

Every socket opens with `caplets.project-binding.v1` in `Sec-WebSocket-Protocol`. When the isolated client's auth provider returns a token, add `caplets.bearer.<base64url-utf8-token>` as a second protocol. Use Web APIs in the browser-safe Module; do not use `Buffer`. Never put the token in the URL, an event, an error message, or logs.

Resolve the auth provider on the initial open and again on the one reconnect. HTTP sibling calls use the same client so its async auth provider is resolved per request.

### Authoritative schemas

Create a focused core protocol module, for example `packages/core/src/project-binding/protocol.ts`, containing strict Zod schemas and inferred types for:

- `ProjectBindingSocketClientMessage` (`heartbeat` and `end`);
- `ProjectBindingSocketServerMessage` (`state`, `ready`, `blocked`, and `ended`);
- binding state, sync state, and terminal reason;
- HTTP session request/response;
- HTTP heartbeat request/response;
- HTTP session/status/delete responses and the actual v1 error envelope.

Reuse those schemas in server request/message parsing and register named OpenAPI components from the same source. Do not maintain separate hand-written server unions beside the Zod schemas.

HeyAPI must generate the public HTTP/component types into the SDK. The SDK's runtime WebSocket validator may be a small browser-safe validator, but it must be checked against the authoritative core Zod schemas with shared valid/invalid fixtures so drift fails `pnpm openapi:check` or an SDK contract test. Do not hand-edit generated files.

Update the `101` description: OpenAPI still does not model WebSocket sequencing, but the named message schemas and `caplets.project-binding.v1` documentation are public contract material.

### Lifecycle and finalization

Implement this fixed state machine:

1. Validate the service client, explicit `ws:`/`wss:` connect URL, project root, and fingerprint before network activity.
2. Derive `sessions`, `{bindingId}/heartbeat`, and `{bindingId}/session` sibling HTTP URLs by replacing the final `connect` path segment. Preserve deployment prefixes; clear irrelevant query/hash values.
3. Create the HTTP session, validate the complete response, then open the socket with `bindingId`, `sessionId`, and `projectFingerprint` query parameters.
4. Validate every socket message. A malformed, unknown, or session-mismatched message is a protocol failure; do not ignore it.
5. Send one immediate heartbeat after open, then both WebSocket and HTTP heartbeats every 15 seconds.
6. After one unexpected reconnectable socket close/error, emit `reconnecting`, resolve fresh auth, and reconnect once. A second close is terminal.
7. `blocked` and `ended` server messages are terminal. Emit one `ended` event.
8. Abort, callback failure, protocol failure, heartbeat failure, or socket exhaustion enters one guarded finalizer.
9. When an open socket can carry an `end` message, send it and wait a bounded internal interval for the server `ended` acknowledgement. Otherwise use the HTTP DELETE sibling as fallback. A missing/already-terminal session after this client created it counts as finalized; authorization or server failures do not.
10. Close listeners, timers, and sockets exactly once. Do not leave a timer, pending listener, or unhandled rejection after the terminal promise settles.
11. Preserve the initiating error. Attach a safe cleanup error as secondary detail. If no initiating error exists and cleanup fails, report `cleanup` as primary.
12. With no failure, return success only after remote terminal state is confirmed. With abort, return/throw the typed `aborted` failure after finalization.

The bounded acknowledgement/finalization timeout is an internal protocol constant, not a public option. Use a value consistent with current server response behavior and cover it with fake timers.

## Scope

### Create

- `packages/sdk/package.json`
- `packages/sdk/README.md`
- `packages/sdk/rolldown.config.ts`
- `packages/sdk/tsconfig.json`
- `packages/sdk/tsconfig.build.json`
- `packages/sdk/vitest.config.ts`
- `packages/sdk/src/index.ts`
- `packages/sdk/src/generated/**` (generated only)
- `packages/sdk/src/project-binding/index.ts`
- `packages/sdk/src/project-binding/session.ts`
- `packages/sdk/src/project-binding/protocol.ts` or equivalent browser-safe validator
- `packages/sdk/src/project-binding/transport.ts`
- `packages/sdk/src/project-binding/node.ts` or an equivalent Node-only entry
- `packages/sdk/test/client.test.ts`
- `packages/sdk/test/bundles.test.ts`
- `packages/sdk/test/project-binding.test.ts`
- `packages/sdk/test/package-exports.test.ts`
- `apps/docs/src/content/docs/sdk.mdx`

Use fewer source files if the resulting Modules remain cohesive; do not create one-file wrappers around generated functions.

### Modify or rename

- `package.json`, `pnpm-lock.yaml`, and `turbo.json` only as required for workspace scripts/build dependencies
- `openapi-ts.config.ts`
- `tools/admin-client-generator/` -> a clearly named SDK generator workspace
- `scripts/generate-openapi.ts`
- `scripts/admin-client-artifacts.test.ts` -> SDK artifact/contract test naming
- `schemas/caplets-http.openapi.json` through `pnpm openapi:generate` only
- `packages/core/package.json`, `rolldown.config.ts`, and relevant build/type configuration
- `packages/core/src/admin-api/openapi.ts`
- `packages/core/src/project-binding/` protocol, attach Adapter, session/transport ownership, and tests
- `packages/core/src/serve/http.ts` Project Binding parsing/responses only
- `packages/core/src/remote-cli/` SDK imports
- `packages/core/src/cloud/project-root.ts` fingerprint ownership only
- `packages/core/src/index.ts` client-side Project Binding exports only
- `packages/core/test/admin-api-openapi.test.ts`, `project-binding-session.test.ts`, Project Binding route tests, package-boundary tests, and focused remote CLI tests
- `apps/dashboard/package.json`, `src/lib/api.ts`, and source-alias configuration
- `apps/docs/astro.config.mjs`
- `AGENTS.md`, `CONTEXT.md`, `README.md`
- `docs/adr/0007-resource-oriented-admin-api.md`
- `docs/architecture.md`
- `docs/plans/000-migrate-admin-api.md`
- `docs/product/current-host-admin-api.md`
- `apps/docs/src/content/docs/project-binding.mdx` and `remote-attach.mdx`
- `.changeset/current-host-admin-api.md`

### Remove after all callers migrate

- `packages/core/src/admin-client/**`
- `@caplets/core/admin-client` from core package exports and Rolldown inputs
- dashboard aliases for `@caplets/core/admin-client`
- direct imports of SDK generated internals
- core's duplicate client-side Project Binding session/transport implementation after the SDK Module is proven

### Out of scope

- MCP client support or MCP schemas in OpenAPI
- dashboard-private cookie/session route generation or Raw Vault Reveal
- a managed credential store, Remote Login polling workflow, or token refresh scheduler
- a bound/namespaced facade over generated operations
- CommonJS builds or support below Node 22
- an AsyncAPI toolchain
- shipping `openapi.json` in the npm package
- changing Admin resource semantics, bundle limits, idempotency, ETags, or pagination
- visual dashboard changes
- hosted Cloud endpoint discovery or workspace-selection policy
- a compatibility re-export from `@caplets/core/admin-client`
- unrelated Project Binding sync, Mutagen, workspace storage, or server lease policy

## Commands

| Purpose                        | Command                                                                                                                                                                     | Expected on success                                                                           |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Install after manifests change | `pnpm install --frozen-lockfile=false`                                                                                                                                      | exit 0; lockfile records `@caplets/sdk` workspace edges and exactly pinned generator packages |
| Generate contract              | `pnpm openapi:generate`                                                                                                                                                     | exit 0; canonical schema and SDK generated sources updated                                    |
| Check contract drift           | `pnpm openapi:check`                                                                                                                                                        | exit 0; no stale schema/client artifacts                                                      |
| SDK test                       | `pnpm --filter @caplets/sdk test`                                                                                                                                           | exit 0; all SDK tests pass                                                                    |
| SDK typecheck                  | `pnpm --filter @caplets/sdk typecheck`                                                                                                                                      | exit 0; no diagnostics                                                                        |
| SDK build                      | `pnpm --filter @caplets/sdk build`                                                                                                                                          | exit 0; all three exports have JavaScript and declarations                                    |
| Core focused tests             | `pnpm --filter @caplets/core test -- test/admin-api-openapi.test.ts test/project-binding-session.test.ts test/project-binding-routes.test.ts test/remote-cli-admin.test.ts` | exit 0                                                                                        |
| Core typecheck                 | `pnpm --filter @caplets/core typecheck`                                                                                                                                     | exit 0                                                                                        |
| Dashboard tests                | `pnpm --filter @caplets/dashboard test`                                                                                                                                     | exit 0                                                                                        |
| Dashboard build                | `pnpm --filter @caplets/dashboard build`                                                                                                                                    | exit 0                                                                                        |
| Public docs                    | `pnpm docs:check && pnpm --filter @caplets/docs build`                                                                                                                      | exit 0                                                                                        |
| Release metadata               | `pnpm changeset status --since=origin/main`                                                                                                                                 | reports `@caplets/sdk` at minor and the Plan 000 package bumps at their intended levels       |
| Full gate                      | `pnpm verify`                                                                                                                                                               | exit 0                                                                                        |

If a focused test filename differs after current branch drift, use the package's existing Vitest command with the exact replacement file. Do not silently omit the behavior.

## Implementation steps

### 1. Lock the package and contract seams with failing tests

Before moving generated code, add SDK package-interface tests that initially fail and specify:

- package name, versioning source (`0.0.0` + minor launch changeset), public access, ESM, Node >=22;
- exports `.`, `./project-binding`, and `./project-binding/node`, each with JavaScript and declaration targets;
- root and Project Binding browser bundles contain no `node:` imports, `Buffer`, `process`, or global mutable client;
- Node-only fingerprint code is unreachable from the two browser-safe exports;
- `createClient` requires and preserves an isolated service root, defaults to fields/non-throwing behavior, permits no auth, and supports static/async auth;
- two clients cannot cross endpoint, token, headers, interceptors, or Fetch adapters;
- representative operations from every family are root exports: discovery, Remote Login, Attach, Project Binding HTTP, v1 Admin, and v2 Admin;
- no package export exposes generated filesystem paths such as `/generated/*`.

Add/extend a generated-contract test that asserts all current canonical operation IDs are represented without pinning editorial descriptions. It should compare OpenAPI operation IDs to the generated root export contract rather than maintaining a second handwritten list.

**Verify red**:

```sh
pnpm --filter @caplets/sdk test
```

Expected: fail because the package/exports do not exist.

### 2. Make Project Binding HTTP and WebSocket schemas authoritative

Write failing core tests first for the runtime/OpenAPI discrepancies listed above. Cover:

- exact session request/response fields;
- exact heartbeat request/response fields;
- status/session/delete success and error envelopes;
- required caller `projectFingerprint` with no server-filesystem fallback;
- strict client and server WebSocket message variants;
- rejection/close of unknown discriminants, missing fields, invalid state/sync state, mismatched IDs, and malformed terminal reasons;
- named OpenAPI components for both socket directions;
- `caplets.project-binding.v1` in the connect-route documentation;
- v1 errors modeled as their actual compatibility envelope rather than an incorrect Problem type.

Extract strict Zod schemas into the focused protocol module and use them in both route registration and runtime parsing. Keep `serve/http.ts` responsible for authentication, WebSocket ownership, and session orchestration, not schema reconstruction.

Do not change the route paths or the established client/server message meanings. If runtime and established CLI behavior disagree beyond the known schema drift, stop and report the extra wire change before choosing one.

**Verify**:

```sh
pnpm --filter @caplets/core test -- test/admin-api-openapi.test.ts test/project-binding-routes.test.ts
pnpm openapi:generate
pnpm openapi:check
```

Expected: exit 0; generated types describe the runtime Project Binding contract and named v1 message schemas.

### 3. Create the independently buildable SDK package and retarget generation

Create `packages/sdk` using published package conventions from `packages/core` and `packages/opencode`:

- source version `0.0.0`;
- public `publishConfig`;
- `files: ["dist", "README.md"]`;
- explicit `types` and `default` conditions for all three exports;
- Rolldown ESM builds for browser-safe root/project-binding and Node-only fingerprint entry;
- declaration-only TypeScript build with paths matching package exports;
- package-level `build`, `clean`, `prepack`, `test`, and `typecheck` scripts.

Retarget the pinned HeyAPI generator to `packages/sdk/src/generated`. Rename Admin-specific generator workspace/env/test labels to SDK terminology. Keep `@hey-api/openapi-ts` and its isolated TypeScript compiler exactly pinned; do not move those dependencies into the SDK runtime manifest.

The generation check must regenerate into a temporary directory, format it, and byte/directory compare it with checked artifacts. Generated files stay marked as generated and are never hand-edited.

Update root `openapi:check` to run the renamed SDK contract test.

**Verify**:

```sh
pnpm install --frozen-lockfile=false
pnpm openapi:generate
pnpm openapi:check
pnpm --filter @caplets/sdk typecheck
pnpm --filter @caplets/sdk build
```

Expected: exit 0; `packages/sdk/dist` contains working root, Project Binding, and Node entrypoints and declarations.

### 4. Implement the root SDK and streaming HTTP helpers

Move the current client wrapper and bundle helpers into the SDK root, then deepen their tests:

- required absolute `http:`/`https:` service root, including path-prefix behavior;
- optional auth and Fetch;
- fields/non-throwing defaults with explicit override tests;
- representative public unauthenticated and bearer operations;
- caller FormData order and Fetch-owned multipart boundary;
- Node/Web `ReadableStream` upload with `duplex: "half"` only where required;
- current and immutable-revision downloads return the original response body stream without `arrayBuffer`, `blob`, `formData`, `json`, or `text` consumption;
- cancellation calls the underlying iterator/stream cancellation once;
- no aggregate bundle buffering or avoidable `Blob`/`Buffer` copies;
- all remote CLI DTOs currently imported from generated internals are public root type exports.

Do not add convenience wrappers for ordinary generated JSON operations.

**Verify**:

```sh
pnpm --filter @caplets/sdk test -- test/client.test.ts test/bundles.test.ts
pnpm openapi:check
```

Expected: exit 0.

### 5. Implement the Project Binding SDK Module test-first

Model tests on `packages/core/test/project-binding-session.test.ts`, but assert the new public interface and stronger invariants. Required cases:

1. create -> open -> ready -> immediate dual heartbeat -> graceful terminal acknowledgement;
2. no bearer token appears in URL, events, or errors;
3. static and async auth providers produce the version plus bearer subprotocols, and reconnect resolves fresh auth;
4. self-hosted prefixed and Cloud workspace URLs derive the correct HTTP siblings without endpoint guessing;
5. one unexpected close reconnects once; the second is terminal;
6. strict rejection of malformed/unknown/session-mismatched server messages;
7. callback exception enters finalization and is the primary failure;
8. abort enters finalization and returns `aborted` in fields mode;
9. `throwOnError: true` rejects with the typed error;
10. heartbeat failure clears timers/listeners and finalizes;
11. finalization is single-flight under simultaneous abort, socket close, and heartbeat failure;
12. WebSocket `end` acknowledgement avoids redundant DELETE;
13. missing/terminal fallback DELETE is accepted as finalized, while auth/5xx cleanup failure is retained as safe secondary detail;
14. primary failure is never masked by cleanup failure;
15. successful completion waits for confirmed remote terminal state;
16. Node fingerprint output matches the existing marker-aware fixtures exactly;
17. browser-safe exports build without Node shims.

Use fake timers for the fixed 15-second heartbeat and bounded finalization timeout. Keep the timing constants internal.

Use a guarded finalizer promise rather than boolean flags spread across event branches. Remove every installed listener in both `addEventListener` and `on*` fallback modes.

**Verify**:

```sh
pnpm --filter @caplets/sdk test -- test/project-binding.test.ts
pnpm --filter @caplets/sdk typecheck
pnpm --filter @caplets/sdk build
```

Expected: exit 0; no open handles or unhandled rejections.

### 6. Migrate core and dashboard consumers, then delete the old client

Add `@caplets/sdk: workspace:*` where used.

Core migration:

- remote Admin and public-auth Adapters import only public SDK exports;
- the higher-level `attachProjectSession` keeps core's remote selection, gitignore bootstrap, and sync policy, but creates an isolated SDK client, supplies the explicit WebSocket URL and Node fingerprint, calls the SDK coordinator with `throwOnError: true`, and preserves the CLI-facing success/error behavior;
- token refresh is expressed through the client's async auth provider, not a second credential field in the coordinator;
- move internal core uses of `fingerprintProjectRoot` to the SDK Node subpath while leaving `findProjectRoot` in core;
- remove duplicate client-side session/transport code and obsolete core root exports; do not remove server-side Project Binding state, workspace, sync, or lease Modules.

Dashboard migration:

- import generated operations/types and bundle helpers from `@caplets/sdk`;
- preserve its dashboard-local Fetch Adapter that rewrites canonical `/v2/admin` paths to `/dashboard/api/v2`, attaches active CSRF only to unsafe methods, and uses same-origin credentials;
- remove Astro/Vitest/TypeScript aliases to core source;
- add the real workspace dependency and let Turbo build order follow package dependencies.

> Superseded transport note: Plan 021 removes the dashboard-path rewrite. The dashboard now
> configures this generated client with the injected service root and calls canonical `/v2/admin`
> directly.

Delete `packages/core/src/admin-client`, the core export, and the core Rolldown input only after searches show no callers.

Required absence checks:

```sh
rg '@caplets/core/admin-client|src/admin-client|\.\./admin-client|admin-client/generated' \
  apps packages scripts tools README.md docs
```

Expected: no matches except historical text deliberately quoted in Plan 020. Use the repository Grep tool rather than shell `rg` when executing in an agent harness that provides one.

**Verify**:

```sh
pnpm --filter @caplets/core typecheck
pnpm --filter @caplets/core test -- test/project-binding-session.test.ts test/remote-cli-admin.test.ts
pnpm --filter @caplets/dashboard test
pnpm --filter @caplets/dashboard build
pnpm --filter @caplets/core test -- test/package-boundaries.test.ts
```

Expected: exit 0; dashboard and core resolve the package rather than source aliases.

### 7. Prove public contract parity beyond Admin

Admin-focused tests are insufficient for a package claiming the whole public server contract. Add a focused runtime/OpenAPI matrix that exercises representative success, auth rejection, malformed input, and media types for every non-Admin family:

- root, v1, and v2 discovery plus health;
- Remote Login start/poll/refresh/complete/cancel and credential self-service;
- Attach session/manifest/invoke/SSE lifecycle;
- Project Binding HTTP controls and WebSocket v1;
- frozen v1 Admin deprecation/compatibility.

The test should verify operation ID, method, path, security, request media, success status/media, and actual error envelope. Do not snapshot the entire OpenAPI document or editorial descriptions. Keep existing stronger Admin route tests.

Add a built-artifact smoke that imports only published SDK entrypoints, starts the built server with isolated temporary SQLite state, and proves:

1. root discovery through the SDK;
2. one authenticated or verified-development Attach operation;
3. one Admin read;
4. one Project Binding session reaching `ready`, aborting, finalizing, and leaving no active lease;
5. root and Project Binding browser-safe entries load without Node polyfills.

Never use production credentials or persisted user state.

**Verify**:

```sh
pnpm openapi:check
pnpm --filter @caplets/core test -- test/admin-api-openapi.test.ts test/serve-http.test.ts
pnpm --filter @caplets/sdk test
pnpm --filter @caplets/sdk build
pnpm --filter caplets build
```

Expected: exit 0 and smoke output proves all five observations.

### 8. Write public documentation and release metadata

Documentation must use the canonical term **Caplets SDK**:

> The typed browser and Node 22 client Module for the canonical public Caplets HTTP API and the versioned Attach Project Binding WebSocket session protocol. It excludes MCP and dashboard-private authentication ceremonies.

Update:

- `CONTEXT.md` with the term only, no implementation details;
- `AGENTS.md` package map with `packages/sdk` ownership and generation commands;
- root `README.md` installation/one isolated-client example and links;
- `packages/sdk/README.md` with install, service-root semantics, unauthenticated/static/async auth, fields vs throws, family imports, streaming bundles, Project Binding/browser/Node examples, exclusions, and compatibility policy;
- docs site `sdk.mdx` and sidebar;
- Project Binding docs with v1 negotiation, endpoint input, fingerprint split, events, failure/finalization behavior, and credential secrecy;
- Remote Attach docs with the SDK relationship but no managed-login claim;
- architecture and Current Host Admin product docs, replacing `@caplets/core/admin-client` ownership;
- ADR 0007 and Plan 000 notes to record one public SDK, named WebSocket schemas, and the pre-release clean cutover;
- Plan 000 status only after all SDK done criteria pass.

Do not add tests for exact marketing prose. `docs:check` and the docs build protect navigation, links, and generated references.

Release metadata:

- add `"@caplets/sdk": minor` to `.changeset/current-host-admin-api.md` so `0.0.0` launches as `0.1.0`;
- retain appropriate Plan 000 bumps for `@caplets/core` and `caplets`;
- describe the whole public SDK, generated HTTP coverage, streaming helpers, Project Binding v1, and removal of the unreleased core generated HTTP client path;
- do not create a second SDK-only changeset for the same launch.

**Verify**:

```sh
pnpm docs:check
pnpm --filter @caplets/docs build
pnpm changeset status --since=origin/main
```

Expected: exit 0; the SDK is a minor launch and docs contain no live references to `@caplets/core/admin-client` outside historical plan context.

### 9. Finish with focused gates, full verification, review, and one migration commit

Run focused checks while implementing, then exactly one full repository gate at the end:

```sh
pnpm format:check
pnpm lint
pnpm openapi:check
pnpm --filter @caplets/sdk typecheck
pnpm --filter @caplets/sdk test
pnpm --filter @caplets/sdk build
pnpm --filter @caplets/core typecheck
pnpm --filter @caplets/core test
pnpm --filter @caplets/dashboard test
pnpm --filter @caplets/dashboard build
pnpm docs:check
pnpm changeset status --since=origin/main
pnpm verify
```

Expected: every command exits 0. `pnpm verify` must include SDK typecheck/test/build through workspace discovery.

Then run the repository's two-axis code review against `ac12a174` or the agreed Plan 000 fixed point:

- Standards: repository rules and judgement-call code smells;
- Spec: Plan 000, ADR 0007, and every fixed decision/done criterion in Plan 020.

Resolve every finding, rerun the affected focused gate, rerun `pnpm verify` if any behavioral/generated/package change followed the last full gate, then commit the complete Plan 000 migration. Do not commit Plan 020 implementation separately from the migration unless the operator revises the delivery decision.

## Test plan summary

Keep tests only when they protect observable behavior or generated/public artifacts:

- SDK public imports, package exports, runtime isolation, and browser/Node separation;
- deterministic OpenAPI -> generated SDK drift;
- representative generated operations across every public family;
- bundle order, streaming, cancellation, and no buffering;
- Project Binding v1 schemas, auth secrecy, state transitions, races, reconnect, finalization, and failures;
- server runtime/OpenAPI parity for non-Admin routes;
- dashboard and CLI behavior through the new package seam;
- built package/server end-to-end smoke.

Do not add tests that only assert package description text, README prose, exact docs headlines, generated source substrings already protected by generation checks, or importability without exercising behavior.

## Done criteria

All must hold:

- [x] `packages/sdk` is a publishable independent ESM package with source version `0.0.0` and a minor launch changeset to `0.1.0`.
- [x] Root, Project Binding, and Node-only exports have JavaScript and declaration outputs.
- [x] Root SDK exposes all canonical generated public HTTP operations/types and required streaming helpers.
- [x] Client instances require a service root, are isolated, allow optional caller auth/Fetch, and default to fields/non-throwing behavior.
- [x] Generated operation/schema names are checked public surface and generated files are current.
- [x] MCP, dashboard-private routes, Raw Vault Reveal, and OpenAPI JSON are absent from SDK exports.
- [x] Project Binding v1 message and HTTP schemas match runtime behavior and are named canonical components.
- [x] The Project Binding coordinator supports browser and Node 22, explicit WebSocket endpoints, caller fingerprints, async auth, fixed dual heartbeat, one reconnect, strict validation, callback events, typed fields/throw failures, and guarded exactly-once finalization.
- [x] Node fingerprint output preserves existing marker-aware behavior.
- [x] No credential appears in Project Binding URLs, events, errors, logs, fixtures, or docs.
- [x] Core and dashboard consumers import public SDK exports; no caller imports generated internals.
- [x] `packages/core/src/admin-client`, its export/bundle entry, and dashboard source aliases are removed with no compatibility alias.
- [x] Non-Admin server runtime/OpenAPI parity is covered by focused tests.
- [x] Built SDK and server pass discovery, Attach, Admin, and Project Binding smoke paths.
- [x] Package, public docs, architecture, glossary, ADR, Plan 000, contributor map, and changeset all describe the same scope.
- [x] Focused package/core/dashboard/docs/OpenAPI gates pass.
- [x] `pnpm changeset status --since=origin/main` reports the intended release set.
- [x] `pnpm verify` exits 0.
- [x] Two-axis review has no unresolved findings.
- [x] The completed migration is committed only after all criteria pass.

## STOP conditions

Stop and report; do not improvise if:

- Plan 000's canonical root OpenAPI source is absent or materially different from the current 61-path/75-operation public contract.
- `@caplets/sdk` is no longer available in the npm scope.
- HeyAPI cannot generate the named Project Binding component types without exposing private routes or requiring hand-edits to generated files. Report the generator limitation; do not add AsyncAPI or a second generator without a decision.
- Correcting Project Binding schemas requires a wire break beyond requiring the already-documented fingerprint and accurately modeling current bodies/responses.
- A browser-safe Project Binding implementation requires a Node polyfill or imports `@caplets/core`.
- The workspace dependency graph becomes cyclic. Do not restore source aliases or make the SDK depend on core to force the build through.
- Cloud support would require endpoint/workspace discovery inside the SDK. Keep the explicit WebSocket URL interface and report the missing caller input.
- Cleanup cannot be made single-flight without changing server lease/terminal semantics outside this plan.
- Generated type changes rename existing operations for reasons unrelated to the corrected contract. Pin/reconcile the generator before publishing.
- A focused verification fails twice after a local correction, or the full gate exposes unrelated working-tree changes that would be overwritten.
- Any test, fixture, artifact, error, or documentation contains a real credential. Delete the artifact, rotate the credential, and fix the leak before continuing.

## Maintenance notes

- The SDK version is independent from server packages. Release it only when the public generated contract, package interface, bundle helpers, or Project Binding protocol changes.
- Changing an OpenAPI `operationId`, named schema, generated output shape, package export, or Project Binding event/error union is a source-compatibility decision even when the wire path is unchanged.
- Changing Project Binding messages requires updating core Zod schemas, named OpenAPI components, SDK validators/types, protocol docs, parity fixtures, and the negotiated subprotocol version when compatibility breaks.
- Keep endpoint discovery, credential persistence, and Remote Login orchestration outside the SDK until separate product decisions establish those Modules.
- Reviewers should scrutinize auth-provider reuse, token redaction, browser bundle boundaries, abort/heartbeat/socket races, single-flight finalization, and generated artifact determinism.
