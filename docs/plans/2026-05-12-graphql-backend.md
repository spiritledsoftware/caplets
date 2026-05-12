# GraphQL Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native GraphQL backend to Caplets, with OAuth/OIDC discovery support shared by GraphQL and OpenAPI.

**Architecture:** Caplets gains a third backend family, `graphql`, alongside MCP and OpenAPI. GraphQL endpoints expose the same Caplet wrapper operations and use either configured GraphQL documents or generated tools from schema root fields. Auth is generalized so `caplets auth login/list/logout` works for OAuth/OIDC MCP, OpenAPI, and GraphQL Caplets.

**Tech Stack:** TypeScript ESM, Node.js 22+, `@modelcontextprotocol/sdk`, GraphQL.js, Zod, Vitest, rolldown, oxfmt, oxlint.

---

## Task 1: Add GraphQL Config And Caplet File Support

**Files:**

- Modify: `package.json`
- Modify: `src/config.ts`
- Modify: `src/caplet-files.ts`
- Modify: `src/registry.ts`
- Modify: `scripts/generate-config-schema.ts`
- Modify: `schemas/caplets-config.schema.json`
- Modify: `schemas/caplet.schema.json`
- Test: `test/config.test.ts`
- Test: `test/registry.test.ts`

- [x] Add `graphql` as a runtime dependency.
- [x] Add top-level `graphqlEndpoints` config keyed by Caplet ID.
- [x] Add Markdown frontmatter key `graphqlEndpoint`.
- [x] Validate exactly one GraphQL schema source: `schemaPath`, `schemaUrl`, or `introspection: true`.
- [x] Add optional `operations` map, where each operation has exactly one of `document` or `documentPath`, plus optional `operationName` and `description`.
- [x] Support GraphQL auth types `none`, `bearer`, `headers`, `oauth2`, and `oidc`.
- [x] Extend OpenAPI auth to support `oauth2` and `oidc`.
- [x] Reject duplicate Caplet IDs across `mcpServers`, `openapiEndpoints`, and `graphqlEndpoints`.
- [x] Reject untrusted project `graphqlEndpoints`, matching OpenAPI project-config safety.
- [x] Update safe `get_caplet` detail and capability descriptions for GraphQL.
- [x] Regenerate committed JSON schemas.

## Task 2: Generalize OAuth/OIDC Auth

**Files:**

- Modify: `src/auth.ts`
- Modify: `src/cli.ts`
- Modify: `src/downstream.ts`
- Modify: `src/openapi.ts`
- Test: `test/auth.test.ts`
- Test: `test/cli.test.ts`
- Test: `test/openapi.test.ts`

- [x] Add shared auth target typing for MCP remote servers, OpenAPI endpoints, and GraphQL endpoints.
- [x] Keep existing MCP SDK OAuth flow for MCP remote servers.
- [x] Add generic authorization-code-with-PKCE OAuth/OIDC flow for OpenAPI and GraphQL.
- [x] Support OAuth Protected Resource Metadata discovery (`/.well-known/oauth-protected-resource`).
- [x] Support OAuth Authorization Server Metadata discovery (`/.well-known/oauth-authorization-server`).
- [x] Support OIDC discovery fallback (`/.well-known/openid-configuration`).
- [x] Support dynamic client registration when `registration_endpoint` is advertised and no `clientId` is configured.
- [x] For `auth.type: "oidc"`, include `openid` and default scopes to `openid profile email` unless scopes are configured.
- [x] Store access tokens, refresh tokens, optional ID tokens, expiry, scope, issuer, subject, discovered metadata, and dynamic client info in token bundles.
- [x] Ensure `caplets auth login/list/logout <caplet>` finds OAuth/OIDC MCP, OpenAPI, and GraphQL Caplets without printing secrets.
- [x] Apply OAuth/OIDC access tokens to OpenAPI requests and remote spec loading.

## Task 3: Implement GraphQL Manager

**Files:**

- Create: `src/graphql.ts`
- Modify: `src/tools.ts`
- Modify: `src/index.ts`
- Test: `test/graphql.test.ts`
- Test: `test/tools.test.ts`

- [x] Load schemas from SDL files, introspection JSON files, remote schema files, or endpoint introspection.
- [x] Validate configured GraphQL documents using GraphQL.js `parse` and `validate`.
- [x] Convert configured operations into MCP-style tool metadata.
- [x] When `operations` is omitted or empty, auto-generate tools from root `Query` and `Mutation` fields.
- [x] Name auto-generated tools `query_<field>` and `mutation_<field>`.
- [x] Generate bounded scalar-leaf selection sets with `__typename`, skipping nested fields that require arguments.
- [x] Use default selection depth `2`; reject values above `5`.
- [x] Convert GraphQL variables and auto-generated root field arguments into JSON Schema input schemas.
- [x] Execute GraphQL calls with POST `{ query, variables, operationName }`.
- [x] Return structured HTTP/GraphQL responses and mark `isError` for non-2xx HTTP responses or GraphQL `errors`.
- [x] Add read-only annotations for query tools and destructive annotations for mutation tools.
- [x] Enforce HTTPS except loopback, redirect rejection, request timeouts, response-size limits, and redacted auth failures.

## Task 4: Documentation And Verification

**Files:**

- Modify: `README.md`
- Modify: `docs/product/caplets-progressive-mcp-disclosure-prd.md`
- Modify: `docs/plans/2026-05-12-graphql-backend.md`

- [x] Document `graphqlEndpoints` JSON config and `graphqlEndpoint` Caplet files.
- [x] Document configured-operation and auto-generated GraphQL modes.
- [x] Document OAuth/OIDC discovery and `caplets auth` support across backends.
- [x] Run `pnpm install`.
- [x] Run `pnpm schema:generate`.
- [x] Run `pnpm verify`.

## Assumptions

- Auto-generation includes queries and mutations by default when no operations are configured.
- Auto-generated tools use generated selection sets only; callers do not pass custom `selectionSet` in v1.
- Configured GraphQL `call_tool.arguments` is the variables object directly.
- Auto-generated GraphQL `call_tool.arguments` is the root field arguments object directly.
- GraphQL subscriptions are out of scope for v1.
- `oidc` means browser authorization-code flow with PKCE plus OIDC discovery and ID token storage.
- Caplets stores OIDC ID tokens for identity/status, but downstream OpenAPI/GraphQL calls use access tokens by default.
