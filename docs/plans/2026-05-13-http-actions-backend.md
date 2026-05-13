# HTTP Actions Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native HTTP actions backend for non-OpenAPI APIs, where each Caplet exposes explicitly configured HTTP actions as discoverable tools.

**Architecture:** Caplets gains a fourth backend family, `http`, alongside MCP, OpenAPI, and GraphQL. HTTP action Caplets define a `baseUrl`, auth, timeout/output limits, and a map of named actions. Each action becomes one MCP-style tool. Calls build an HTTP request from structured argument mappings, execute it directly, and return structured status, headers, body, and timing data.

**Tech Stack:** TypeScript ESM, Node.js 22+, `@modelcontextprotocol/sdk`, Zod, Vitest, rolldown, oxfmt, oxlint.

---

## Task 1: Add HTTP Actions Config And Caplet File Support

**Files:**

- Modify: `src/config.ts`
- Modify: `src/caplet-files.ts`
- Modify: `scripts/generate-config-schema.ts` if needed
- Modify: `schemas/caplets-config.schema.json`
- Modify: `schemas/caplet.schema.json`
- Test: `test/config.test.ts`

- [x] Add `HttpApiConfig` and `HttpActionConfig` types.
- [x] Add top-level `httpApis` config keyed by Caplet ID.
- [x] Add Markdown frontmatter key `httpApi`.
- [x] Keep v1 explicit-config-only: no discovery, imports, or manifests.
- [x] Require `baseUrl`, `auth`, and at least one action.
- [x] Support auth types `none`, `bearer`, `headers`, `oauth2`, and `oidc`, matching OpenAPI/GraphQL.
- [x] Validate HTTPS except loopback for `baseUrl`.
- [x] Reject duplicate Caplet IDs across `mcpServers`, `openapiEndpoints`, `graphqlEndpoints`, and `httpApis`.
- [x] Reject untrusted project `httpApis`, matching OpenAPI/GraphQL project-config safety.
- [x] Normalize relative Caplet/config local paths only where needed; HTTP paths are URL paths, not filesystem paths.
- [x] Regenerate committed JSON schemas.

## Task 2: Implement HTTP Actions Manager

**Files:**

- Create: `src/http-actions.ts`
- Modify: `src/tools.ts`
- Modify: `src/registry.ts`
- Modify: `src/runtime.ts`
- Test: `test/http-actions.test.ts`
- Test: `test/tools.test.ts`
- Test: `test/registry.test.ts`
- Test: `test/runtime.test.ts`

- [x] Create `HttpActionManager` with `checkApi`, `listTools`, `getTool`, `callTool`, `compact`, `search`, and `invalidate` methods.
- [x] Convert configured actions into MCP-style tools using each action's `inputSchema`.
- [x] Support HTTP methods `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`.
- [x] Build URLs from `baseUrl` plus action `path`, preserving origin and rejecting origin changes.
- [x] Resolve `{field}` path placeholders from `call_tool.arguments` and URL-encode values.
- [x] Support `query`, `headers`, and `jsonBody` mappings.
- [x] Support mapping values as literals, nested arrays/objects, `$input.field` references, and `$input` for the full argument object.
- [x] Reject forbidden request headers such as `authorization`, `host`, `content-length`, `connection`, and `content-type` when user-configured headers would conflict with managed headers.
- [x] Apply static bearer/header auth and generic OAuth/OIDC headers.
- [x] Reject redirects.
- [x] Enforce request timeouts and maximum response byte limits.
- [x] Return structured `{ status, statusText, headers, body, elapsedMs }` responses and mark `isError` for non-2xx status.
- [x] Redact secrets from errors.
- [x] Route `backend: "http"` through generated Caplet operations.
- [x] Add safe registry detail for HTTP APIs without exposing `baseUrl`, auth, or sensitive mappings.
- [x] Include HTTP APIs in runtime registration, reload comparison, and cache invalidation.

## Task 3: Documentation And Verification

**Files:**

- Modify: `README.md`
- Modify: `docs/product/caplets-progressive-mcp-disclosure-prd.md`
- Modify: `docs/plans/2026-05-13-http-actions-backend.md`

- [x] Document `httpApis` JSON config and `httpApi` Caplet files.
- [x] Document explicit action configuration, request mappings, auth support, and safety constraints.
- [x] Document response shape and error behavior.
- [x] Run `pnpm schema:generate`.
- [x] Run `pnpm format:check`.
- [x] Run `pnpm lint`.
- [x] Run `pnpm typecheck`.
- [x] Run `pnpm schema:check`.
- [x] Run `pnpm test`.
- [x] Run `pnpm build`.

## Assumptions

- The top-level config key is `httpApis` and Caplet file key is `httpApi`.
- Runtime backend discriminator is `backend: "http"`.
- `check_backend` validates configured actions and returns a tool count without making network calls.
- v1 does not support action discovery, imports, manifests, raw shell/curl execution, form bodies, file upload, streaming, cookies, or custom redirect following.
- `inputSchema` defaults to `{ "type": "object", "additionalProperties": true }` when omitted.
- JSON request bodies set `content-type: application/json` automatically when `jsonBody` is configured.
- HTTP response parsing matches OpenAPI behavior: JSON content is parsed as JSON; other content is text.
