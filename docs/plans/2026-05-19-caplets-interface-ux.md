# Caplets Interface UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the Caplets agent interface with only low-risk, feasible changes that preserve the current wrapper protocol.

**Architecture:** Keep `get_caplet`/`list_tools`/`get_tool`/`call_tool` unchanged. Add clearer Caplet identity in wrapper text and metadata, extract local artifact hints from downstream browser output, add schema fingerprints to compact tool metadata, and polish Pi rendering so large Caplet results stay readable.

**Tech Stack:** TypeScript, Zod, MCP `CallToolResult`, Vitest, native Caplets service, Pi native-tool integration.

---

## Why This Plan Exists

After using both the Browser and Stealth Browser Caplets against `http://localhost:4199`, the interface worked, but these practical pain points stood out:

- Browser and Stealth Browser expose identical downstream tool names, so results should identify the active Caplet more clearly.
- Screenshot responses report relative paths such as `./browser-caplet-localhost-4199.png` without enough artifact-context metadata.
- Two Caplets can expose identical downstream schemas, but agents have no lightweight way to recognize that known schemas match.
- Current discovery results use generic text like `Result available in structuredContent.result.`.
- The Pi wrapper serializes the whole result JSON in expanded mode, which is noisy for large snapshots and screenshots.
- The generated prompt guidance is correct but over-cautious; it nudges agents to rediscover familiar tools every time.

---

## Explicitly Out Of Scope

These ideas are feasible in theory but are not included because they add protocol complexity or compatibility risk:

- Fast-path `call_tool` requests without `operation`.
- A batched browser `run_flow` operation.
- Wrapping direct `call_tool` results in a new `structuredContent.result` envelope.
- Guaranteed absolute screenshot paths when the downstream MCP browser server only reports relative paths.
- Flattening downstream browser tools into separate native tools.

---

## Decisions Locked

- Keep existing operation names, request shapes, and behavior backward compatible.
- Do not require agents to change existing Caplets calls.
- Preserve direct `call_tool` pass-through shape: keep downstream `content`, `structuredContent`, `isError`, and `_meta` intact.
- Add Caplets metadata to direct `call_tool` results only under `_meta.caplets`.
- Add richer metadata to wrapper-generated discovery results under `structuredContent.caplets` while keeping `structuredContent.result` unchanged.
- Expose artifact paths as hints with explicit path-resolution status when absolute paths cannot be guaranteed.
- Treat schema fingerprints as hints for reuse, not as a replacement for `get_tool` when semantics are unclear.

---

## Files To Modify

- `packages/core/src/tools.ts`: annotate wrapper results, add artifact extraction, and improve wrapper text.
- `packages/core/src/downstream.ts`: add schema fingerprints to MCP compact metadata.
- `packages/core/src/openapi.ts`: add schema fingerprints to OpenAPI compact metadata.
- `packages/core/src/http-actions.ts`: add schema fingerprints to HTTP compact metadata.
- `packages/core/src/cli-tools.ts`: add schema fingerprints to CLI compact metadata.
- `packages/core/src/caplet-sets.ts`: add schema fingerprints to Caplet-set compact metadata.
- `packages/core/src/graphql.ts`: add schema fingerprints to GraphQL compact metadata.
- `packages/core/src/native/tools.ts`: update native system guidance and prompt guidance.
- `packages/pi/src/index.ts`: render concise Caplet summaries and artifact hints.
- `packages/core/test/tools.test.ts`: wrapper text, metadata, and artifact tests.
- Backend tests under `packages/core/test/`: compact metadata fingerprint tests.
- `packages/core/test/native.test.ts`: guidance tests.
- `packages/pi/test/pi.test.ts`: renderer tests.
- `README.md`: document the metadata, artifact, and schema-fingerprint improvements.

---

## Public Result Shape Additions

### Discovery operation metadata

Discovery operations keep the existing `structuredContent.result` shape and add Caplets metadata beside it:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Browser list_tools result available in structuredContent.result."
    }
  ],
  "structuredContent": {
    "caplets": {
      "caplet": "browser",
      "name": "Browser",
      "backend": "mcp",
      "operation": "list_tools",
      "status": "ok"
    },
    "result": {
      "server": "browser",
      "tools": []
    }
  }
}
```

### Direct `call_tool` metadata

Direct downstream results are not enveloped. Caplets metadata is attached under `_meta.caplets`:

```json
{
  "content": [{ "type": "text", "text": "...downstream output..." }],
  "structuredContent": { "ok": true },
  "_meta": {
    "caplets": {
      "caplet": "browser",
      "name": "Browser",
      "backend": "mcp",
      "operation": "call_tool",
      "tool": "browser_take_screenshot",
      "status": "ok",
      "artifacts": [
        {
          "kind": "screenshot",
          "displayPath": "./browser-caplet-localhost-4199.png",
          "pathResolution": "relative-to-mcp-server"
        }
      ]
    }
  }
}
```

### Compact schema fingerprints

Compact tool metadata gains stable schema hashes:

```json
{
  "server": "browser",
  "tool": "browser_navigate",
  "description": "Navigate to a URL",
  "hasInputSchema": true,
  "hasOutputSchema": false,
  "inputSchemaHash": "sha256:...",
  "outputSchemaHash": null
}
```

---

## Task 1: Add Shared Caplet Metadata Helpers

**Files:**

- Modify: `packages/core/src/tools.ts`
- Test: `packages/core/test/tools.test.ts`

- [ ] Add a `CapletResultMetadata` type with `caplet`, `name`, `backend`, `operation`, optional `tool`, `status`, optional `elapsedMs`, and optional `artifacts`.
- [ ] Add `metadataFor(server, operation, tool, startedAt)` to build metadata consistently.
- [ ] Add `jsonResult(value, metadata)` support while preserving the existing `structuredContent.result` field.
- [ ] Add `annotateCallToolResult(result, metadata)` that preserves downstream `content`, `structuredContent`, `isError`, and existing `_meta` fields.
- [ ] Ensure `annotateCallToolResult()` merges with an existing `_meta` object instead of replacing it.
- [ ] Add tests proving `get_caplet`, `list_tools`, and `get_tool` include `structuredContent.caplets` and keep `structuredContent.result` unchanged.
- [ ] Add tests proving direct `call_tool` results keep their original shape and receive `_meta.caplets`.
- [ ] Add tests proving downstream `_meta` values are preserved.
- [ ] Add tests proving `isError: true` downstream results are annotated but otherwise unchanged.
- [ ] Run `pnpm --filter @caplets/core test -- test/tools.test.ts`.

---

## Task 2: Improve Human-Readable Result Headers

**Files:**

- Modify: `packages/core/src/tools.ts`
- Modify: `packages/pi/src/index.ts`
- Test: `packages/core/test/tools.test.ts`
- Test: `packages/pi/test/pi.test.ts`

- [ ] Change discovery-operation text from `Result available in structuredContent.result.` to a Caplet-specific sentence such as `Browser list_tools result available in structuredContent.result.`.
- [ ] Keep discovery text short and do not inline large structured payloads.
- [ ] Update Pi `renderCall()` if needed so operation and downstream tool names remain visible for identical tool names across Caplets.
- [ ] Update Pi collapsed `renderResult()` to prefer `_meta.caplets` or `structuredContent.caplets` and render `✓ Browser call_tool browser_click complete` when metadata exists.
- [ ] Update Pi expanded `renderResult()` to show a concise metadata header before output.
- [ ] Add tests for Browser and Stealth Browser style names proving identical downstream tool names are disambiguated by Caplet title.
- [ ] Run `pnpm --filter @caplets/core test -- test/tools.test.ts` and `pnpm --filter @caplets/pi test`.

---

## Task 3: Add Artifact Metadata Extraction

**Files:**

- Modify: `packages/core/src/tools.ts`
- Test: `packages/core/test/tools.test.ts`

- [ ] Add an artifact extractor that scans downstream text content for local Markdown links emitted by MCP browser tools, for example `[Screenshot of viewport](./file.png)`.
- [ ] Ignore `http:`, `https:`, `mailto:`, and fragment-only links.
- [ ] Classify common artifacts by filename and surrounding text: `screenshot`, `snapshot`, `console-log`, `network-log`, and fallback `file`.
- [ ] Return artifact objects with `kind`, `displayPath`, and `pathResolution`.
- [ ] Use `pathResolution: "relative-to-mcp-server"` for relative paths unless core can reliably resolve the downstream output directory.
- [ ] Use `pathResolution: "absolute"` only for absolute local paths that already appear in downstream output.
- [ ] Attach extracted artifacts to `_meta.caplets.artifacts` on direct `call_tool` results.
- [ ] Add tests for screenshot links, snapshot links, console-log links, multiple artifacts, no artifacts, and external links.
- [ ] Run `pnpm --filter @caplets/core test -- test/tools.test.ts`.

---

## Task 4: Add Schema Fingerprints To Compact Tool Metadata

**Files:**

- Modify: `packages/core/src/downstream.ts`
- Modify: `packages/core/src/openapi.ts`
- Modify: `packages/core/src/http-actions.ts`
- Modify: `packages/core/src/cli-tools.ts`
- Modify: `packages/core/src/caplet-sets.ts`
- Modify: `packages/core/src/graphql.ts`
- Test: backend-specific test files under `packages/core/test/`

- [ ] Add a small stable JSON hashing utility for schema-like values using deterministic key ordering and SHA-256.
- [ ] Extend every backend compact tool shape with `inputSchemaHash` and `outputSchemaHash`.
- [ ] Return `null` for a missing schema so compact output has a stable shape.
- [ ] Keep full schemas available only through `get_tool`.
- [ ] Add tests proving two identical schemas produce identical hashes.
- [ ] Add tests proving object key order differences do not change hashes.
- [ ] Update existing compact metadata test expectations for all backend managers touched.
- [ ] Run focused backend tests, then `pnpm typecheck`.

---

## Task 5: Update Native Agent Guidance

**Files:**

- Modify: `packages/core/src/native/tools.ts`
- Test: `packages/core/test/native.test.ts`

- [ ] Update `nativeCapletsSystemGuidance()` so the recommended flow says `get_caplet` and `get_tool` are for unfamiliar or schema-unclear tools, not mandatory for every repeat use.
- [ ] Add guidance that schema hashes from `list_tools` can identify matching schemas across Caplets when the exact hash is already understood.
- [ ] Keep the warning that downstream inputs must stay inside `arguments`.
- [ ] Keep the warning that agents must not invent downstream tool names.
- [ ] Update `nativeCapletPromptGuidance()` to be less repetitive while preserving the safe discovery path.
- [ ] Add tests for revised guidance text.
- [ ] Run `pnpm --filter @caplets/core test -- test/native.test.ts`.

---

## Task 6: Polish Pi Rendering For Large Caplet Results

**Files:**

- Modify: `packages/pi/src/index.ts`
- Test: `packages/pi/test/pi.test.ts`

- [ ] Add a helper that extracts Caplets metadata from either `details.result._meta.caplets` or `details.result.structuredContent.caplets`.
- [ ] Update collapsed rendering to use metadata when present and keep the output one line.
- [ ] Update expanded rendering to show metadata, artifact lines, and then a concise output preview.
- [ ] Keep the full raw result available in `details.result` for inspection.
- [ ] Avoid dumping huge snapshot text before the useful summary.
- [ ] Add tests where result content contains a large snapshot to ensure collapsed output remains concise.
- [ ] Add tests where screenshot metadata renders a clear artifact line.
- [ ] Run `pnpm --filter @caplets/pi test`.

---

## Task 7: Documentation

**Files:**

- Modify: `README.md`

- [ ] Document that discovery results now include `structuredContent.caplets` metadata.
- [ ] Document that direct `call_tool` results keep their downstream shape and include `_meta.caplets` when possible.
- [ ] Document artifact metadata and path-resolution caveats.
- [ ] Document schema hashes as reuse hints, not as a replacement for `get_tool` when semantics are unclear.
- [ ] Document that the explicit progressive-discovery flow remains the safest first-use path.
- [ ] Run `pnpm format:check`.

---

## Task 8: Full Verification

**Files:**

- No direct source changes unless failures reveal missing updates.

- [ ] Run `pnpm format:check`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm build`.
- [ ] If schema generation changed checked files, run `pnpm schema:generate` and then `pnpm schema:check`.
- [ ] If benchmark docs are stale, run `pnpm benchmark` and then `pnpm benchmark:check`.
- [ ] Run `pnpm verify` before merging.

---

## Rollout Notes

- If adding `_meta.caplets` to direct `call_tool` results causes compatibility issues, keep metadata only for wrapper-generated operations and Pi rendering can fall back to call arguments.
- If artifact extraction produces false positives, restrict it to MCP Caplets whose downstream tool names start with `browser_`.
- If schema hashing changes compact output too much for snapshots/tests, ship hashes behind one shared compact helper and update all backend expectations together.
