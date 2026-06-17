# Code Mode Platform API Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand Code Mode from a thin TypeScript runner into a browser-like, non-I/O JavaScript utility runtime with the Web and minimal Node compatibility APIs agents commonly expect.

**Architecture:** Keep QuickJS as the execution engine and keep all I/O routed through Caplet handles. Install supported APIs as real `globalThis` properties by combining bundled guest-side platform code with narrow host bridges for entropy and timers. Use packages for spec-heavy object models, self-shims for tiny compatibility APIs, and host bridges only where the host must provide time or secure randomness.

**Tech Stack:** TypeScript, QuickJS via `quickjs-emscripten`, Rolldown-generated guest runtime source, Vitest, pnpm 11.5.0, Node >=24.

---

## Global Constraints

- Use `pnpm` only.
- Do not expose `process`, `require`, filesystem, child process, direct network, or arbitrary imports inside Code Mode.
- Keep `fetch` unavailable for direct use; static analysis must still return `FETCH_UNAVAILABLE`.
- Supported platform APIs must be visible on both top-level bindings and `globalThis`.
- Code Mode remains a context-management runtime, not a sandbox security boundary.
- Runtime behavior and TypeScript declarations must stay in sync through checked generated files.
- Add a changeset because this is user-facing package behavior.

## Package And Bridge Decisions

| Surface                                                      | Decision                     | Package or bridge                                              |
| ------------------------------------------------------------ | ---------------------------- | -------------------------------------------------------------- |
| `atob`, `btoa`                                               | Self-shim                    | No package                                                     |
| Minimal `Buffer`                                             | Self-shim                    | No package; support only documented encoding helpers           |
| `URL`, `URLSearchParams`                                     | Local guest shims            | Package import rejected after QuickJS bundle testing           |
| `TextEncoder`, `TextDecoder`                                 | Local guest shims            | Package import rejected after QuickJS bundle testing           |
| `structuredClone`                                            | Package-backed guest global  | `@ungap/structured-clone`                                      |
| `Headers`                                                    | Package-backed guest global  | `headers-polyfill`                                             |
| `Blob`, `File`, `FormData`                                   | Package-backed guest globals | `formdata-node`                                                |
| `ReadableStream`, `WritableStream`, `TransformStream`        | Local guest shims            | Package import rejected after QuickJS runtime testing          |
| `AbortController`, `AbortSignal`                             | Self-shim                    | No package unless tests prove an EventTarget package is needed |
| `Request`, `Response`                                        | Self-shim data containers    | Built on `Headers`, `Blob`, and body helpers; no fetch stack   |
| `crypto.randomUUID`, `crypto.getRandomValues`                | Host bridge                  | Node `crypto` only behind narrow bridge functions              |
| `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval` | Host bridge                  | Host timers connected to QuickJS pending-deferred drain        |
| `queueMicrotask`                                             | Self-shim                    | `Promise.resolve().then(...)`                                  |

Packages researched and rejected for this plan: `buffer`, `abab`, `url-parse`, `text-encoding`, `core-js`, `uuid`, `nanoid`, `randombytes`, `crypto-browserify`, `@peculiar/webcrypto`, `timers-browserify`, `setimmediate`, `abort-controller`, `undici`, `cross-fetch`, `whatwg-fetch`, `@whatwg-node/fetch`, `formdata-polyfill`, and `fetch-blob`.

`whatwg-fetch` is intentionally rejected even for `Request` and `Response`: it is a browser `window.fetch`/XHR polyfill that mutates `globalThis.fetch` when absent, assumes browser primitives such as `XMLHttpRequest` and `FileReader` for important paths, and pulls the runtime toward network semantics that Code Mode must keep unavailable.

Task 3 amendment after controller adjudication: local shims are accepted for `TextEncoder`/`TextDecoder`, `URL`/`URLSearchParams`, and streams. The package-backed text import initializes `new TextDecoder(...)` before Code Mode can install a guest `TextDecoder`, `whatwg-url` inherits that early initialization problem, and the stream package path did not settle reliably inside the QuickJS guest runtime. These shims stay narrow and are covered by the public Code Mode platform contract tests.

Primary package sources used during planning:

- [npm: base64-js](https://www.npmjs.com/package/base64-js)
- [npm: buffer](https://www.npmjs.com/package/buffer)
- [npm: whatwg-url](https://www.npmjs.com/package/whatwg-url)
- [npm: @exodus/bytes](https://www.npmjs.com/package/@exodus/bytes)
- [npm: @ungap/structured-clone](https://www.npmjs.com/package/@ungap/structured-clone)
- [npm: headers-polyfill](https://www.npmjs.com/package/headers-polyfill)
- [npm: formdata-node](https://www.npmjs.com/package/formdata-node)
- [npm: web-streams-polyfill](https://www.npmjs.com/package/web-streams-polyfill)
- [npm: uuid](https://www.npmjs.com/package/uuid)
- [npm: nanoid](https://www.npmjs.com/package/nanoid)
- [npm: crypto-browserify](https://www.npmjs.com/package/crypto-browserify)
- [npm downloads API](https://api.npmjs.org/downloads/)

## File Structure Map

Create:

- `packages/core/src/code-mode/platform-entry.ts` - guest-side runtime entry bundled into a string and evaluated inside QuickJS before user code.
- `packages/core/src/code-mode/platform-runtime.generated.ts` - generated bundled guest runtime source. Do not edit by hand.
- `packages/core/src/code-mode/platform-host.ts` - host bridge installation for secure randomness and timers, plus cleanup.
- `scripts/generate-code-mode-platform-runtime.mjs` - bundles `platform-entry.ts` into `platform-runtime.generated.ts` and supports `--check`.
- `packages/core/test/code-mode-platform-api.test.ts` - runtime contract tests for all supported globals.
- `.changeset/code-mode-platform-apis.md` - release note for the expanded Code Mode runtime.

Modify:

- `package.json` - add platform runtime generation/check scripts to the existing Code Mode check path.
- `pnpm-lock.yaml` - update after adding dependencies.
- `packages/core/package.json` - add runtime dependencies for package-backed platform APIs.
- `packages/core/src/code-mode/sandbox.ts` - install host bridges, prepend generated guest runtime source, and dispose active timers/deferreds safely.
- `packages/core/src/code-mode/runtime-api.d.ts` - declare all supported platform globals.
- `packages/core/src/code-mode/runtime-api.generated.ts` - regenerate from `runtime-api.d.ts`.
- `packages/core/src/code-mode/diagnostics.ts` - remove duplicate ad hoc URL ambient declarations and keep fetch/import safety diagnostics authoritative.
- `packages/core/test/code-mode-diagnostics.test.ts` - cover the expanded TypeScript surface and fetch blocking.
- `packages/core/test/code-mode-declarations.test.ts` - ensure generated declarations include platform globals.
- `apps/docs/src/content/docs/code-mode.mdx` - document available platform APIs and unavailable direct I/O.
- `apps/docs/src/content/docs/reference/code-mode-api.mdx` - regenerate after runtime API declaration changes.
- `docs/architecture.md` - update Code Mode runtime contract.
- `docs/product/caplets-code-mode-prd.md` - update Code Mode contract.

## Implementation Tasks

### Task 1: Add Red Runtime Contract Tests

**Files:**

- Create: `packages/core/test/code-mode-platform-api.test.ts`
- Modify: none

**Interfaces:**

- Consumes: `runCodeMode(input)` from `packages/core/src/code-mode/runner.ts`.
- Produces: executable runtime contract for every platform API in this plan.

- [ ] **Step 1: Create the test file**

Add `packages/core/test/code-mode-platform-api.test.ts` with one helper `runPlatformCode(code: string)` that calls `runCodeMode` with a minimal fake `NativeCapletsService`, following the pattern in `packages/core/test/code-mode-runner.test.ts`.

Required tests:

- `exposes utility globals on globalThis`
- `supports base64 and minimal Buffer conversions`
- `supports URL and URLSearchParams`
- `supports text encoding and decoding`
- `supports crypto randomUUID and getRandomValues`
- `supports timers, intervals, and microtasks`
- `supports structuredClone`
- `supports Headers, Blob, File, FormData, streams, Request, and Response`
- `supports AbortController and AbortSignal`
- `keeps fetch unavailable for direct calls`
- `keeps Node and module globals unavailable`

The test scripts must return JSON-serializable values only. Assert exact values for deterministic APIs and shape/patterns for random APIs.

- [ ] **Step 2: Run the new test and confirm it fails**

Run: `pnpm --filter @caplets/core test -- test/code-mode-platform-api.test.ts`

Expected: FAIL with missing globals such as `btoa`, `URL`, `TextEncoder`, `crypto`, and stream constructors.

### Task 2: Add Generated Guest Platform Runtime Infrastructure

**Files:**

- Create: `packages/core/src/code-mode/platform-entry.ts`
- Create: `packages/core/src/code-mode/platform-runtime.generated.ts`
- Create: `scripts/generate-code-mode-platform-runtime.mjs`
- Modify: `package.json`
- Modify: `packages/core/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/core/src/code-mode/sandbox.ts`

**Interfaces:**

- Produces: `CODE_MODE_PLATFORM_RUNTIME_SOURCE: string` from `platform-runtime.generated.ts`.
- Produces: `platform-entry.ts` that installs guest-side globals onto `globalThis`.
- Consumes: `CODE_MODE_PLATFORM_RUNTIME_SOURCE` in `buildExecutionSource()`.

- [ ] **Step 1: Add dependencies**

Run:

```bash
pnpm add --filter @caplets/core whatwg-url @exodus/bytes @ungap/structured-clone headers-polyfill formdata-node web-streams-polyfill
```

Expected: `packages/core/package.json` and `pnpm-lock.yaml` are updated.

- [ ] **Step 2: Add the platform runtime generator**

Create `scripts/generate-code-mode-platform-runtime.mjs`.

The script must:

- Bundle `packages/core/src/code-mode/platform-entry.ts` with Rolldown.
- Output one IIFE/plain script string.
- Write `packages/core/src/code-mode/platform-runtime.generated.ts`.
- Support `--check` and fail if the generated file is stale.
- Externalize nothing from the guest bundle except built-in globals already available inside QuickJS.

- [ ] **Step 3: Add the generated source to the sandbox wrapper**

Modify `packages/core/src/code-mode/sandbox.ts` so `buildExecutionSource()` prepends `CODE_MODE_PLATFORM_RUNTIME_SOURCE` before user code and before the generated `caplets` handles. Move the existing lexical `console` and disabled `fetch` definitions into the platform runtime so they become true `globalThis` properties.

- [ ] **Step 4: Wire scripts into the existing Code Mode gate**

Modify root `package.json` so:

- `code-mode:generate-api` runs both runtime API generation and platform runtime generation.
- `code-mode:check-api` checks both generated files.

Run: `pnpm code-mode:generate-api && pnpm code-mode:check-api`

Expected: PASS.

### Task 3: Implement Package-Backed And Self-Shim Guest APIs

**Files:**

- Modify: `packages/core/src/code-mode/platform-entry.ts`
- Modify: `packages/core/src/code-mode/platform-runtime.generated.ts`
- Test: `packages/core/test/code-mode-platform-api.test.ts`

**Interfaces:**

- Produces globals: `atob`, `btoa`, `Buffer`, `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `structuredClone`, `Headers`, `Blob`, `File`, `FormData`, `ReadableStream`, `WritableStream`, `TransformStream`, `AbortController`, `AbortSignal`, `Request`, `Response`, `fetch`, `console`, `queueMicrotask`.

- [ ] **Step 1: Add global installation helper**

In `platform-entry.ts`, add a local `definePlatformGlobal(name, value)` helper that uses `Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })` only when the value is not already installed.

- [ ] **Step 2: Install package-backed globals**

Import and install:

```ts
import { URL, URLSearchParams } from "whatwg-url";
import { TextDecoder, TextEncoder } from "@exodus/bytes/encoding-lite.js";
import structuredClone from "@ungap/structured-clone";
import { Headers } from "headers-polyfill";
import { Blob, File, FormData } from "formdata-node";
import { ReadableStream, TransformStream, WritableStream } from "web-streams-polyfill";
```

If one import shape differs, fix the import in `platform-entry.ts` and keep the generated runtime check as the source of truth.

- [ ] **Step 3: Add small self-shims**

In `platform-entry.ts`, implement:

- `atob(input: string): string`
- `btoa(input: string): string`
- minimal `Buffer.from(input, encoding?)`
- `Buffer.isBuffer(value)`
- `Buffer.byteLength(input, encoding?)`
- `buffer.toString(encoding?)`
- `queueMicrotask(callback)`
- `AbortController` and `AbortSignal`
- data-only `Request` and `Response` wrappers
- disabled `fetch` that throws `Direct fetch is not available in Code Mode; use a Caplet instead.`
- `console` bridge that calls `__caplets_log`

Supported encodings for the Buffer subset: `utf8`, `utf-8`, `base64`, `base64url`, and `hex`. Unsupported encodings must throw `TypeError`.

- [ ] **Step 4: Generate and test**

Run:

```bash
pnpm code-mode:generate-api
pnpm --filter @caplets/core test -- test/code-mode-platform-api.test.ts
```

Expected: all non-crypto and non-timer tests pass; crypto/timer tests may still fail until Task 4.

### Task 4: Implement Host Bridges For Crypto And Timers

**Files:**

- Create: `packages/core/src/code-mode/platform-host.ts`
- Modify: `packages/core/src/code-mode/sandbox.ts`
- Modify: `packages/core/src/code-mode/platform-entry.ts`
- Modify: `packages/core/src/code-mode/platform-runtime.generated.ts`
- Test: `packages/core/test/code-mode-platform-api.test.ts`

**Interfaces:**

- Produces: `installCodeModePlatformHost(context, pendingDeferreds, options): { dispose(): void }`.
- Host bridge globals visible only to guest runtime internals:
  - `__caplets_platform_random_uuid(): string`
  - `__caplets_platform_random_values(length: number): number[]`
  - `__caplets_platform_sleep(timerId: number, delayMs: number): Promise<boolean>`
  - `__caplets_platform_clear_timer(timerId: number): boolean`

- [ ] **Step 1: Add crypto bridges**

In `platform-host.ts`, use `node:crypto` to implement UUID and random byte generation. In `platform-entry.ts`, install:

- `crypto.randomUUID()`
- `crypto.getRandomValues(typedArray)`

`getRandomValues` must reject non-integer typed arrays and arrays over 65,536 bytes with `TypeError` or `QuotaExceededError`.

- [ ] **Step 2: Add timer bridges**

In `platform-host.ts`, implement host-backed sleep promises that are tracked in the existing `pendingDeferreds` set and resolve `true` when fired or `false` when cleared.

In `platform-entry.ts`, implement:

- `setTimeout(callback, delay, ...args)`
- `clearTimeout(id)`
- `setInterval(callback, delay, ...args)`
- `clearInterval(id)`

Active intervals must keep Code Mode alive until cleared or until the overall Code Mode timeout fires. `dispose()` must clear all host timers.

- [ ] **Step 3: Run focused tests**

Run: `pnpm --filter @caplets/core test -- test/code-mode-platform-api.test.ts test/code-mode-runner.test.ts`

Expected: PASS.

### Task 5: Update TypeScript Declarations And Diagnostics

**Files:**

- Modify: `packages/core/src/code-mode/runtime-api.d.ts`
- Modify: `packages/core/src/code-mode/runtime-api.generated.ts`
- Modify: `packages/core/src/code-mode/diagnostics.ts`
- Modify: `packages/core/test/code-mode-diagnostics.test.ts`
- Modify: `packages/core/test/code-mode-declarations.test.ts`

**Interfaces:**

- Produces declaration coverage for every supported global.
- Preserves diagnostics for direct `fetch` and imports.

- [ ] **Step 1: Update runtime API declarations**

Add declarations for the exact supported API subset. Do not import DOM libs. Declare only the methods and properties supported by the runtime implementation.

Include a documented `fetch(...): Promise<never>` declaration so agents can inspect it, while preflight diagnostics still block direct calls.

- [ ] **Step 2: Remove duplicate ambient URL declarations**

Modify `packages/core/src/code-mode/diagnostics.ts` so `ambientDeclarations()` no longer separately declares `URL` and `URLSearchParams`. The generated runtime declaration must be the single source of truth.

- [ ] **Step 3: Add diagnostics tests**

Extend `packages/core/test/code-mode-diagnostics.test.ts` to assert:

- The supported globals type-check.
- `await fetch("https://example.com")` still produces `FETCH_UNAVAILABLE`.
- `await globalThis.fetch("https://example.com")` still produces `FETCH_UNAVAILABLE`.
- `import("node:fs")`, `process.cwd()`, and `require("fs")` remain blocked or unknown.

- [ ] **Step 4: Generate and check declarations**

Run:

```bash
pnpm code-mode:generate-api
pnpm code-mode:check-api
pnpm --filter @caplets/core test -- test/code-mode-diagnostics.test.ts test/code-mode-declarations.test.ts
```

Expected: PASS.

### Task 6: Update Docs And Release Notes

**Files:**

- Modify: `apps/docs/src/content/docs/code-mode.mdx`
- Modify: `apps/docs/src/content/docs/reference/code-mode-api.mdx`
- Modify: `docs/architecture.md`
- Modify: `docs/product/caplets-code-mode-prd.md`
- Create: `.changeset/code-mode-platform-apis.md`

**Interfaces:**

- Produces user-facing documentation of supported and intentionally unavailable APIs.

- [ ] **Step 1: Update Code Mode docs**

Document the platform API groups:

- Pure utility globals
- Web data model globals
- Timer and microtask globals
- Crypto randomness globals
- Explicitly unavailable Node and direct network APIs

State that `fetch` is intentionally unavailable and Caplet handles must be used for I/O.

- [ ] **Step 2: Regenerate reference docs if required**

Run: `pnpm docs:generate`

Expected: `apps/docs/src/content/docs/reference/code-mode-api.mdx` reflects `runtime-api.d.ts`.

- [ ] **Step 3: Add changeset**

Create `.changeset/code-mode-platform-apis.md`:

```md
---
"@caplets/core": minor
"caplets": minor
"@caplets/opencode": minor
"@caplets/pi": minor
---

Expand Code Mode with browser-like platform APIs for data manipulation, encoding, timers, crypto randomness, and web object compatibility while keeping direct network and Node APIs unavailable.
```

### Task 7: End-To-End Verification

**Files:**

- Modify only files already listed in earlier tasks.

**Interfaces:**

- Produces verified local Code Mode behavior through tests, CLI, and MCP smoke.

- [ ] **Step 1: Run focused core checks**

Run:

```bash
pnpm --filter @caplets/core test -- test/code-mode-platform-api.test.ts test/code-mode-runner.test.ts test/code-mode-diagnostics.test.ts test/code-mode-declarations.test.ts test/code-mode-cli.test.ts test/code-mode-mcp.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run generated-file checks**

Run:

```bash
pnpm code-mode:check-api
pnpm docs:check
```

Expected: PASS.

- [ ] **Step 3: Run CLI smoke**

Run:

```bash
pnpm --filter caplets build
node packages/cli/dist/index.js code-mode 'return { btoa: btoa("hi"), url: new URL("https://example.com/a?b=1").searchParams.get("b"), text: new TextDecoder().decode(new TextEncoder().encode("ok")), uuid: /^[0-9a-f-]{36}$/i.test(crypto.randomUUID()) }' --json
```

Expected JSON value:

```json
{
  "btoa": "aGk=",
  "url": "1",
  "text": "ok",
  "uuid": true
}
```

- [ ] **Step 4: Run local MCP smoke after restarting the local Caplets MCP server**

Use `caplets-local.code_mode` with the same probe from Step 3.

Expected: `ok: true` and the same values as the CLI smoke.

- [ ] **Step 5: Run the repo gate**

Run: `pnpm verify`

Expected: PASS through `format:check`, `lint`, `code-mode:check-api`, `schema:check`, `docs:check`, `typecheck`, `test`, `benchmark:check`, and `build`.

## Self-Review

- Spec coverage: every requested functional area has a decision and a task: base64/Buffer, URL, text encoding, crypto, timers, structured clone, headers, blob/file/form-data, streams, abort, request/response, declarations, docs, smoke, and release notes.
- Placeholder scan: no unresolved implementation markers or unsupported vague steps.
- Type consistency: generated runtime source is named `CODE_MODE_PLATFORM_RUNTIME_SOURCE`; host bridge installer is named `installCodeModePlatformHost`; runtime declarations are the single TypeScript source of truth.
