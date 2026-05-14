# Output Field Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `call_tool.fields` projection for MCP, OpenAPI, and HTTP tools only when the backend tool exposes an output schema.

**Architecture:** Keep field selection as a wrapper-layer post-call projection over `structuredContent`. Each backend exposes `outputSchema` metadata through normal `list_tools`/`get_tool` discovery. `call_tool.fields` is accepted by the static wrapper schema, but is only valid at runtime for non-GraphQL tools with output schemas.

**Tech Stack:** TypeScript, Zod, `@modelcontextprotocol/sdk`, Vitest, JSON Schema-style tool metadata.

---

## Decisions Locked

- `fields` is a top-level `call_tool` wrapper field, not part of downstream `arguments`.
- `fields` paths target `structuredContent`.
- HTTP/OpenAPI payload fields require explicit `body.` paths because those backends wrap responses in `{ status, statusText, headers, body }`.
- MCP paths target the downstream MCP `structuredContent` directly.
- GraphQL is excluded because GraphQL already has native selection sets.
- Missing output schema is a hard `REQUEST_INVALID` error, not a no-op.
- `list_tools`/`search_tools` compact output should include `hasOutputSchema`.
- `get_tool` should expose actual `outputSchema` where available.
- Projection should update both `structuredContent` and text `content` when the original result has JSON text generated from structured content.

---

## Files To Modify

- `src/tools.ts`: parse `fields`, validate operation-specific fields, route projection after backend calls.
- `src/downstream.ts`: expose `hasOutputSchema` in compact MCP tool metadata.
- `src/openapi.ts`: extract response schemas, attach `outputSchema`, include `hasOutputSchema`.
- `src/http-actions.ts`: add configured `outputSchema` support, attach it to tools, include `hasOutputSchema`.
- `src/config.ts`: add `outputSchema` to HTTP action config validation/type.
- `schemas/caplets-config.schema.json`: regenerate after config schema changes.
- `src/field-selection.ts`: implement schema-aware field path validation and projection.
- `test/field-selection.test.ts`: direct projection utility coverage.
- `test/tools.test.ts`: wrapper validation, projection routing, GraphQL rejection.
- `test/downstream.test.ts`: MCP fixture output schema discovery and filtering.
- `test/openapi.test.ts`: OpenAPI response schema extraction and filtering.
- `test/http-actions.test.ts`: HTTP configured output schema and filtering.
- `test/config.test.ts`: HTTP `outputSchema` config validation.
- `test/fixtures/stdio-server.mjs`: add `outputSchema` to `echo`.

---

## Public Request Shape

```json
{
  "operation": "call_tool",
  "tool": "read_items",
  "arguments": { "limit": 10 },
  "fields": ["body.items.title", "body.items.url"]
}
```

For MCP:

```json
{
  "operation": "call_tool",
  "tool": "search",
  "arguments": { "query": "mcp" },
  "fields": ["items.title", "items.url"]
}
```

Invalid for GraphQL:

```json
{
  "operation": "call_tool",
  "tool": "query_user",
  "arguments": { "id": "42" },
  "fields": ["body.data.user.name"]
}
```

Expected error:

```json
{
  "code": "REQUEST_INVALID",
  "message": "call_tool.fields is not supported for GraphQL-backed Caplets; select fields in the GraphQL operation document instead"
}
```

---

## Task 1: Add Field Selection Request Validation

**Files:**

- Modify: `src/tools.ts`
- Test: `test/tools.test.ts`

- [x] Add `fields` to `generatedToolInputSchema` as `z.array(z.string().min(1)).min(1).optional()`.
- [x] Update the description to say `fields` is only valid for `call_tool` after `get_tool` shows an `outputSchema`.
- [x] Change `validateOperationRequest` for `call_tool` from `allowed(["tool", "arguments"])` to `allowed(["tool", "arguments", "fields"])`.
- [x] Reject empty arrays and non-string path values through Zod.
- [x] Return `fields` in the required request type only when present.
- [x] Add tests that `call_tool` accepts `fields: ["body.name"]`, rejects `fields` for non-`call_tool` operations, rejects `fields: []`, and treats `arguments.fields` as downstream input.
- [x] Run `pnpm test test/tools.test.ts` and confirm the new tests pass.

---

## Task 2: Implement Schema-Aware Projection Utility

**Files:**

- Create: `src/field-selection.ts`
- Test: `test/field-selection.test.ts`

- [x] Write tests for object projection, array item projection, unknown schema paths, missing output schema, missing runtime values, and multiple nested selections.
- [x] Implement `projectStructuredContent(value, outputSchema, fields)`.
- [x] Validate paths against JSON Schema object `properties` and array `items`.
- [x] Omit selected runtime values that are absent.
- [x] Throw `CapletsError` with `REQUEST_INVALID` for missing schemas, non-object runtime content, or schema-disallowed fields.
- [x] Run `pnpm test test/field-selection.test.ts` and confirm it passes.

---

## Task 3: Expose Output Schema Metadata In Compact Tools

**Files:**

- Modify: `src/downstream.ts`
- Modify: `src/openapi.ts`
- Modify: `src/http-actions.ts`
- Test: `test/tools.test.ts`

- [x] Extend `CompactTool` with `hasOutputSchema: boolean`.
- [x] Update MCP, OpenAPI, GraphQL, and HTTP `compact()` implementations to return `hasOutputSchema: Boolean(tool.outputSchema)`.
- [x] Update compact tool test expectations.
- [x] Run `pnpm test test/tools.test.ts`.

---

## Task 4: Add MCP Projection

**Files:**

- Modify: `src/tools.ts`
- Modify: `test/fixtures/stdio-server.mjs`
- Test: `test/downstream.test.ts`
- Test: `test/tools.test.ts`

- [x] Add `outputSchema: z.object({ message: z.string() }).strict()` to the `echo` fixture tool.
- [x] In `handleServerTool`, when `parsed.fields` exists, reject GraphQL, fetch the selected tool metadata, require `tool.outputSchema`, call the backend, and project the result.
- [x] Add `projectCallToolResult()` in `src/tools.ts` or use a helper from `src/field-selection.ts`.
- [x] Preserve `isError` and other result properties.
- [x] Replace returned `content` with projected pretty JSON text.
- [x] Test MCP `echo` with `fields: ["message"]`.
- [x] Test missing output schema plus `fields` fails with `REQUEST_INVALID` before full output is returned.
- [x] Run `pnpm test test/downstream.test.ts test/tools.test.ts`.

---

## Task 5: Add OpenAPI Output Schema Extraction

**Files:**

- Modify: `src/openapi.ts`
- Test: `test/openapi.test.ts`

- [x] Extend `OpenApiOperation` with `outputSchema?: Record<string, unknown>`.
- [x] Extract the first `2xx` JSON response schema from OpenAPI operations.
- [x] Wrap the response body schema in the structured envelope schema for `{ status, statusText, headers, body }`.
- [x] Attach `outputSchema` in `toTool()` when available.
- [x] Test `get_tool` includes `outputSchema` for JSON response schema operations.
- [x] Test compact output says `hasOutputSchema: true`.
- [x] Test `call_tool.fields: ["body.name"]` returns only `{ body: { name: "Ada" } }`.
- [x] Test fields on an operation without response schema throws `REQUEST_INVALID`.
- [x] Run `pnpm test test/openapi.test.ts test/tools.test.ts`.

---

## Task 6: Add HTTP Action Output Schema Config

**Files:**

- Modify: `src/config.ts`
- Modify: `src/http-actions.ts`
- Test: `test/config.test.ts`
- Test: `test/http-actions.test.ts`
- Regenerate: `schemas/caplets-config.schema.json`

- [x] Add `outputSchema?: Record<string, unknown>` to `HttpActionConfig`.
- [x] Add `outputSchema` to `httpActionSchema` with description `JSON Schema for structuredContent returned by this action.`
- [x] Attach configured `outputSchema` in HTTP `toTool()` when available.
- [x] Add config parsing tests for HTTP action output schemas.
- [x] Add HTTP action tests for `get_tool`, compact metadata, and `call_tool.fields`.
- [x] Run `pnpm schema:generate`.
- [x] Run `pnpm test test/config.test.ts test/http-actions.test.ts`.

---

## Task 7: Add Shared Result Projection In Wrapper

**Files:**

- Modify: `src/tools.ts`
- Modify: `src/field-selection.ts`
- Test: `test/tools.test.ts`

- [x] Ensure result projection is centralized and shared by MCP, OpenAPI, and HTTP.
- [x] Ensure `fields` omitted keeps existing pass-through behavior unchanged.
- [x] Ensure GraphQL with `fields` fails with the planned error.
- [x] Ensure projection never mutates the original result.
- [x] Run `pnpm test test/tools.test.ts`.

---

## Task 8: Update Agent-Facing Descriptions

**Files:**

- Modify: `src/tools.ts`
- Modify: `src/registry.ts`
- Test: `test/tools.test.ts`
- Test: `test/registry.test.ts`

- [x] Update `fields` schema description.
- [x] Keep `arguments` warning about downstream inputs only inside `arguments`.
- [x] Update `capabilityDescription` to mention optional `fields` only after `get_tool` confirms `outputSchema` for a non-GraphQL tool.
- [x] Run `pnpm test test/tools.test.ts test/registry.test.ts`.

---

## Task 9: Verification

**Files:**

- All modified files

- [x] Run `pnpm test test/field-selection.test.ts test/tools.test.ts test/downstream.test.ts test/openapi.test.ts test/http-actions.test.ts test/config.test.ts`.
- [x] Run `pnpm verify`.
- [x] Fix any failures without weakening the feature contract.
- [x] Confirm `git status --short` only contains intended files.

---

## Risks And Guardrails

- Static wrapper input schema cannot truly hide `fields` per downstream tool. Runtime validation and discovery metadata are the correct enforcement points.
- OpenAPI response schema extraction should stay minimal: JSON `2xx` only, no content negotiation beyond `application/json`.
- GraphQL should remain rejected for `fields` to avoid competing with GraphQL selection sets.
- Do not support JSONPath, wildcards, computed selectors, array indexes, or aliases in the first implementation.
- Do not silently no-op when schema is absent because that can leak full responses.

---

## Acceptance Criteria

- `list_tools` and `search_tools` show `hasOutputSchema`.
- `get_tool` shows `outputSchema` for MCP tools that expose it.
- `get_tool` shows synthesized `outputSchema` for OpenAPI operations with JSON response schemas.
- `get_tool` shows configured `outputSchema` for HTTP actions.
- `call_tool.fields` filters `structuredContent` and text content for MCP, OpenAPI, and HTTP.
- `call_tool.fields` fails with `REQUEST_INVALID` for GraphQL.
- `call_tool.fields` fails with `REQUEST_INVALID` when no output schema exists.
- Existing `call_tool` behavior is unchanged when `fields` is omitted.
