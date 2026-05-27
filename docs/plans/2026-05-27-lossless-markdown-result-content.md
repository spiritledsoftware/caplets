# Lossless Markdown Result Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Caplets-generated tool result expose the same untruncated data in both `structuredContent` and agent/human-readable Markdown `content`.

**Architecture:** Add one shared lossless Markdown renderer in `@caplets/core`, then route every Caplets-generated result shape through backend-aware renderers. Keep `structuredContent` canonical and unchanged; make `content` a complete Markdown projection of that same data instead of a compact preview. Preserve downstream MCP-authored content, but append a complete structured-content Markdown section when downstream `structuredContent` would otherwise be invisible to content-only clients.

**Tech Stack:** TypeScript, MCP SDK `CallToolResult`, Vitest, pnpm, existing Caplets core/pi/opencode packages.

---

## Scope And Decisions

- The core MCP Markdown renderer must not truncate `content`. Existing backend read limits such as HTTP `maxResponseBytes` and CLI `maxOutputBytes` still bound what Caplets receives from downstream systems; the Markdown renderer must not apply any additional truncation.
- `structuredContent` remains the canonical machine-readable object and must not be removed or compacted.
- `content` must contain all data from `structuredContent` in Markdown form for Caplets-generated results.
- Use backend-aware Markdown for known shapes: HTTP/OpenAPI, GraphQL, CLI, discovery/listing, tools, errors, and generic structured results.
- Nested API data stays in fenced JSON blocks. Do not recursively turn arbitrary object keys into headings.
- MCP downstream `content` should be preserved when meaningful. If downstream returns `structuredContent`, append a Markdown rendering of that structured data so content-only MCP clients still see it.
- Pi and OpenCode native integrations should consume the same core Markdown renderer for agent-visible payloads instead of maintaining local lossy formatting.
- Pi UI rendering is a separate display concern: collapsed tool results must stay short/truncated, and expanded results opened with `ctrl+o` must show the full Markdown content.

## File Structure

- Modify `packages/core/src/result-content.ts`
  - Replace compact preview behavior with lossless Markdown rendering helpers.
  - Keep `compactJsonText()` and `compactText()` only if still used by other UI preview code.
  - Export `markdownStructuredContent()`, `markdownCallToolResultContent()`, and `hasRenderableStructuredContent()`.
- Modify `packages/core/src/index.ts`
  - Export the result-content Markdown helpers for native integrations.
- Modify `packages/core/src/tools.ts`
  - Use Markdown `content` in `jsonResult()` discovery operations.
  - Regenerate/append Markdown `content` in `annotateCallToolResult()` after metadata is known.
  - Use Markdown `content` for field-selected results.
- Modify generated backends:
  - `packages/core/src/http-actions.ts`
  - `packages/core/src/openapi.ts`
  - `packages/core/src/graphql.ts`
  - `packages/core/src/cli-tools.ts`
  - Each manager should return Markdown content for direct manager calls as well as the shared wrapper path.
- Modify `packages/core/src/errors.ts`
  - Render safe errors as complete Markdown while keeping `structuredContent.error` unchanged.
- Modify native integrations:
  - `packages/pi/src/index.ts`
  - `packages/opencode/src/hooks.ts`
  - Prefer core Markdown projection of structured results.
- Modify tests:
  - `packages/core/test/result-content.test.ts`
  - `packages/core/test/http-actions.test.ts`
  - `packages/core/test/openapi.test.ts`
  - `packages/core/test/graphql.test.ts`
  - `packages/core/test/cli-tools.test.ts`
  - `packages/core/test/tools.test.ts`
  - `packages/core/test/downstream.test.ts`
  - `packages/core/test/field-selection.test.ts`
  - `packages/pi/test/pi.test.ts`
  - `packages/opencode/test/opencode.test.ts`
- Add a changeset because this changes user-visible MCP result content:
  - `.changeset/lossless-markdown-results.md`

---

## Markdown Format Contract

### HTTP and OpenAPI

````md
# OSV Vulnerabilities call_tool query_purl

## Response

- **Status:** `200 OK`
- **Elapsed:** `84 ms`

## Headers

```json
{
  "content-type": "application/json"
}
```
````

## Body

```json
{
  "vulns": []
}
```

````

### GraphQL

```md
# GitHub GraphQL call_tool viewer

## Response

- **Status:** `200 OK`

## Data

```json
{
  "viewer": {
    "login": "octocat"
  }
}
````

## Headers

```json
{
  "content-type": "application/json"
}
```

## Full Body

```json
{
  "data": {
    "viewer": {
      "login": "octocat"
    }
  }
}
```

````

### CLI

```md
# Repo CLI call_tool search

## Command Result

- **Exit code:** `0`
- **Elapsed:** `52 ms`

## stdout

```text
matched line 1
matched line 2
````

## stderr

_No stderr._

````

When CLI output mode is JSON and parsing succeeds, include the parsed `json` field too:

```md
## Parsed JSON

```json
{
  "matches": []
}
````

````

### Discovery and generated JSON results

```md
# OSV Vulnerabilities list_tools

## Tools

1. `query_purl` — Read-only OSV query for vulnerabilities affecting one package URL.
2. `query_version` — Query vulnerabilities for one package version.

## Full Result

```json
{
  "id": "osv",
  "name": "OSV Vulnerabilities",
  "tools": []
}
````

## Caplets Metadata

```json
{
  "id": "osv",
  "name": "OSV Vulnerabilities",
  "backend": "http",
  "operation": "list_tools",
  "status": "ok"
}
```

````

### MCP downstream with both content and structured content

```md
# Browser call_tool browser_snapshot

<downstream text content preserved exactly>

---

## Structured Content

```json
{
  "snapshot": "Page title: Example"
}
````

````

### Error result

```md
# Error

## REQUEST_INVALID

Generated server tool request is invalid.

## Details

```json
{
  "code": "REQUEST_INVALID",
  "message": "Generated server tool request is invalid",
  "details": []
}
````

````

---

### Task 1: Add Lossless Markdown Renderer Tests

**Files:**
- Modify: `packages/core/test/result-content.test.ts`

- [ ] **Step 1: Replace compact-preview expectations with lossless Markdown expectations**

Update the import at the top of `packages/core/test/result-content.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  compactJsonText,
  hasRenderableStructuredContent,
  markdownCallToolResultContent,
  markdownStructuredContent,
} from "../src/result-content";
````

Replace the existing compact HTTP preview test with these tests:

````ts
it("renders HTTP-like structured content as complete Markdown", () => {
  const content = markdownStructuredContent(
    {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: { vulns: [] },
      elapsedMs: 12,
    },
    {
      title: "OSV Vulnerabilities call_tool query_purl",
      backend: "http",
      operation: "call_tool",
      tool: "query_purl",
    },
  );

  expect(content).toEqual([
    {
      type: "text",
      text: [
        "# OSV Vulnerabilities call_tool query_purl",
        "",
        "## Response",
        "",
        "- **Status:** `200 OK`",
        "- **Elapsed:** `12 ms`",
        "",
        "## Headers",
        "",
        "```json",
        '{\n  "content-type": "application/json"\n}',
        "```",
        "",
        "## Body",
        "",
        "```json",
        '{\n  "vulns": []\n}',
        "```",
      ].join("\n"),
    },
  ]);
});

it("renders GraphQL body data and full body without losing fields", () => {
  const text = markdownStructuredContent(
    {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: { data: { viewer: { login: "octocat" } } },
    },
    { title: "GitHub GraphQL call_tool viewer", backend: "graphql" },
  )[0]!.text;

  expect(text).toContain("# GitHub GraphQL call_tool viewer");
  expect(text).toContain("## Data");
  expect(text).toContain('"viewer": {');
  expect(text).toContain("## Full Body");
  expect(text).toContain("## Headers");
});

it("renders CLI stdout stderr and parsed JSON without truncation", () => {
  const text = markdownStructuredContent(
    {
      exitCode: 0,
      stdout: '{"matches":[]}',
      stderr: "",
      elapsedMs: 52,
      json: { matches: [] },
    },
    { title: "Repo CLI call_tool search", backend: "cli" },
  )[0]!.text;

  expect(text).toContain("# Repo CLI call_tool search");
  expect(text).toContain("## Command Result");
  expect(text).toContain("- **Exit code:** `0`");
  expect(text).toContain("## stdout");
  expect(text).toContain('{"matches":[]}');
  expect(text).toContain("## stderr\n\n_No stderr._");
  expect(text).toContain("## Parsed JSON");
  expect(text).toContain('"matches": []');
});

it("renders discovery result lists and metadata", () => {
  const text = markdownStructuredContent(
    {
      caplets: {
        id: "osv",
        name: "OSV Vulnerabilities",
        backend: "http",
        operation: "list_tools",
        status: "ok",
      },
      result: {
        id: "osv",
        name: "OSV Vulnerabilities",
        tools: [
          {
            id: "osv",
            tool: "query_purl",
            description: "Query vulnerabilities by package URL.",
            hasInputSchema: true,
            hasOutputSchema: false,
          },
        ],
      },
    },
    { title: "OSV Vulnerabilities list_tools", operation: "list_tools" },
  )[0]!.text;

  expect(text).toContain("# OSV Vulnerabilities list_tools");
  expect(text).toContain("## Tools");
  expect(text).toContain("1. `query_purl` — Query vulnerabilities by package URL.");
  expect(text).toContain("## Full Result");
  expect(text).toContain("## Caplets Metadata");
  expect(text).toContain('"operation": "list_tools"');
});

it("preserves downstream text and appends structured content for MCP results", () => {
  const content = markdownCallToolResultContent(
    {
      content: [{ type: "text", text: "Downstream text" }],
      structuredContent: { snapshot: { title: "Example" } },
    },
    { title: "Browser call_tool browser_snapshot", backend: "mcp" },
  );

  expect(content).toEqual([
    {
      type: "text",
      text: [
        "# Browser call_tool browser_snapshot",
        "",
        "Downstream text",
        "",
        "---",
        "",
        "## Structured Content",
        "",
        "```json",
        '{\n  "snapshot": {\n    "title": "Example"\n  }\n}',
        "```",
      ].join("\n"),
    },
  ]);
});

it("detects renderable structured content while ignoring metadata-only objects", () => {
  expect(hasRenderableStructuredContent({ body: { ok: true } })).toBe(true);
  expect(hasRenderableStructuredContent({ caplets: { status: "ok" } })).toBe(false);
  expect(hasRenderableStructuredContent(undefined)).toBe(false);
});
````

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
pnpm --filter @caplets/core test -- test/result-content.test.ts
```

Expected: FAIL because `markdownStructuredContent`, `markdownCallToolResultContent`, and `hasRenderableStructuredContent` are not implemented yet, and existing compact content does not match the new Markdown contract.

---

### Task 2: Implement Shared Lossless Markdown Renderer

**Files:**

- Modify: `packages/core/src/result-content.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/result-content.test.ts`

- [ ] **Step 1: Implement renderer types and public helpers**

Replace the compact summary functions in `packages/core/src/result-content.ts` with this structure while keeping `compactJsonText()` and `compactText()` for UI preview callers that still need compact strings:

```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types";

export type TextContentBlock = { type: "text"; text: string };

export type ResultMarkdownContext = {
  title?: string | undefined;
  backend?: string | undefined;
  operation?: string | undefined;
  tool?: string | undefined;
  uri?: string | undefined;
  prompt?: string | undefined;
  fields?: string[] | undefined;
  isError?: boolean | undefined;
};

export function structuredOnlyContent(): [] {
  return [];
}

export function textContent(text: string): TextContentBlock[] {
  return text ? [{ type: "text", text }] : [];
}

export function compactJsonText(value: unknown, maxLength = 600): string {
  return compactText(JSON.stringify(value) ?? String(value), maxLength);
}

export function compactText(value: string, maxLength = 600): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed.length > maxLength
    ? `${collapsed.slice(0, maxLength - 1).trimEnd()}…`
    : collapsed;
}

export function markdownStructuredContent(
  value: unknown,
  context: ResultMarkdownContext = {},
): TextContentBlock[] {
  return textContent(renderStructuredMarkdown(value, context));
}

export function markdownCallToolResultContent(
  result: CallToolResult,
  context: ResultMarkdownContext = {},
): TextContentBlock[] {
  if (result.isError === true && !hasRenderableStructuredContent(result.structuredContent)) {
    return textContent(renderTextBlocksWithTitle(result.content, context));
  }

  const structuredContent = result.structuredContent;
  const downstreamText = textBlocksToString(result.content);
  const hasStructured = hasRenderableStructuredContent(structuredContent);

  if (context.backend === "mcp" && downstreamText && hasStructured) {
    return textContent(
      [
        markdownTitle(context),
        "",
        downstreamText,
        "",
        "---",
        "",
        "## Structured Content",
        "",
        jsonFence(structuredContent),
      ].join("\n"),
    );
  }

  if (hasStructured) {
    return markdownStructuredContent(structuredContent, context);
  }

  if (downstreamText) {
    return textContent(renderTextBlocksWithTitle(result.content, context));
  }

  return textContent(renderStructuredMarkdown(result, context));
}

export function compactStructuredContent(
  value: unknown,
  context: ResultMarkdownContext = {},
): TextContentBlock[] {
  return markdownStructuredContent(value, context);
}

export function compactCallToolResultContent(
  result: CallToolResult,
  context: ResultMarkdownContext = {},
): TextContentBlock[] {
  return markdownCallToolResultContent(result, context);
}

export function hasRenderableStructuredContent(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(value).some((key) => key !== "caplets" && key !== "elapsedMs");
}
```

Add these private rendering helpers below the public functions:

```ts
function renderStructuredMarkdown(value: unknown, context: ResultMarkdownContext): string {
  const title = markdownTitle(context);
  if (isDiscoveryWrapper(value)) {
    return renderDiscoveryWrapper(value, context, title);
  }
  if (context.isError || isErrorStructuredContent(value)) {
    return renderErrorMarkdown(value, title);
  }
  if (context.backend === "cli" || isCliResult(value)) {
    return renderCliMarkdown(value, title);
  }
  if (context.backend === "graphql" || isGraphQlHttpResult(value)) {
    return renderGraphQlMarkdown(value, title);
  }
  if (context.backend === "http" || context.backend === "openapi" || isHttpLikeResult(value)) {
    return renderHttpMarkdown(value, title);
  }
  return [title, "", "## Result", "", jsonFence(value)].join("\n");
}

function markdownTitle(context: ResultMarkdownContext): string {
  if (context.title) {
    return `# ${context.title}`;
  }
  const parts = [context.operation, context.tool ?? context.uri ?? context.prompt].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? `# ${parts.join(" ")}` : "# Result";
}

function renderHttpMarkdown(value: unknown, title: string): string {
  const record = asRecord(value);
  const lines = [title, "", "## Response", ""];
  const status = typeof record.status === "number" ? record.status : undefined;
  const statusText = typeof record.statusText === "string" ? record.statusText : undefined;
  if (status !== undefined || statusText) {
    lines.push(`- **Status:** \`${[status, statusText].filter(Boolean).join(" ")}\``);
  }
  if (typeof record.elapsedMs === "number") {
    lines.push(`- **Elapsed:** \`${record.elapsedMs} ms\``);
  }
  lines.push("", "## Headers", "", jsonFence(record.headers ?? {}), "", "## Body", "");
  lines.push(renderBodyValue(record.body));
  const additional = omitKeys(record, ["status", "statusText", "headers", "body", "elapsedMs"]);
  if (Object.keys(additional).length > 0) {
    lines.push("", "## Additional Fields", "", jsonFence(additional));
  }
  return lines.join("\n");
}

function renderGraphQlMarkdown(value: unknown, title: string): string {
  const record = asRecord(value);
  const body = asRecord(record.body);
  if (!body || (!("data" in body) && !("errors" in body))) {
    return renderHttpMarkdown(value, title);
  }

  const lines = [title, "", "## Response", ""];
  const status = typeof record.status === "number" ? record.status : undefined;
  const statusText = typeof record.statusText === "string" ? record.statusText : undefined;
  if (status !== undefined || statusText) {
    lines.push(`- **Status:** \`${[status, statusText].filter(Boolean).join(" ")}\``);
  }
  if (typeof record.elapsedMs === "number") {
    lines.push(`- **Elapsed:** \`${record.elapsedMs} ms\``);
  }
  if ("data" in body) {
    lines.push("", "## Data", "", jsonFence(body.data));
  }
  if ("errors" in body) {
    lines.push("", "## Errors", "", jsonFence(body.errors));
  }
  lines.push("", "## Headers", "", jsonFence(record.headers ?? {}));
  lines.push("", "## Full Body", "", jsonFence(record.body));
  const additional = omitKeys(record, ["status", "statusText", "headers", "body", "elapsedMs"]);
  if (Object.keys(additional).length > 0) {
    lines.push("", "## Additional Fields", "", jsonFence(additional));
  }
  return lines.join("\n");
}

function renderCliMarkdown(value: unknown, title: string): string {
  const record = asRecord(value);
  const lines = [title, "", "## Command Result", ""];
  if ("exitCode" in record) {
    lines.push(`- **Exit code:** \`${String(record.exitCode)}\``);
  }
  if ("signal" in record) {
    lines.push(`- **Signal:** \`${String(record.signal)}\``);
  }
  if (typeof record.elapsedMs === "number") {
    lines.push(`- **Elapsed:** \`${record.elapsedMs} ms\``);
  }
  lines.push("", "## stdout", "", textFenceOrEmpty(record.stdout, "No stdout."));
  lines.push("", "## stderr", "", textFenceOrEmpty(record.stderr, "No stderr."));
  if ("json" in record) {
    lines.push("", "## Parsed JSON", "", jsonFence(record.json));
  }
  if ("jsonParseError" in record) {
    lines.push("", "## JSON Parse Error", "", jsonFence(record.jsonParseError));
  }
  const additional = omitKeys(record, [
    "exitCode",
    "signal",
    "stdout",
    "stderr",
    "elapsedMs",
    "json",
    "jsonParseError",
  ]);
  if (Object.keys(additional).length > 0) {
    lines.push("", "## Additional Fields", "", jsonFence(additional));
  }
  return lines.join("\n");
}

function renderDiscoveryWrapper(
  value: { result: unknown; caplets?: unknown },
  context: ResultMarkdownContext,
  title: string,
): string {
  const result = asRecord(value.result);
  const lines = [title, ""];
  if (context.operation === "list_tools" || context.operation === "search_tools") {
    lines.push("## Tools", "", renderNamedList(arrayValue(result?.tools), "tool"), "");
  } else if (context.operation === "list_resources" || context.operation === "search_resources") {
    lines.push(
      "## Resources",
      "",
      renderNamedList(arrayValue(result?.resources ?? result?.matches), "uri"),
      "",
    );
  } else if (context.operation === "list_resource_templates") {
    lines.push(
      "## Resource Templates",
      "",
      renderNamedList(arrayValue(result?.resourceTemplates), "uriTemplate"),
      "",
    );
  } else if (context.operation === "list_prompts" || context.operation === "search_prompts") {
    lines.push("## Prompts", "", renderNamedList(arrayValue(result?.prompts), "prompt"), "");
  } else if (context.operation === "get_tool") {
    lines.push("## Tool", "", renderToolSummary(asRecord(result?.tool)), "");
  } else if (context.operation === "check_backend") {
    lines.push("## Backend Status", "", renderBackendStatus(result), "");
  } else if (context.operation === "get_caplet") {
    lines.push("## Caplet", "", renderCapletSummary(result), "");
  }
  lines.push("## Full Result", "", jsonFence(value.result));
  if (value.caplets !== undefined) {
    lines.push("", "## Caplets Metadata", "", jsonFence(value.caplets));
  }
  return lines.join("\n");
}

function renderErrorMarkdown(value: unknown, title: string): string {
  const error = asRecord(asRecord(value)?.error) ?? asRecord(value);
  const code = typeof error?.code === "string" ? error.code : "Error";
  const message = typeof error?.message === "string" ? error.message : "Tool call failed.";
  return [
    title === "# Result" ? "# Error" : title,
    "",
    `## ${code}`,
    "",
    message,
    "",
    "## Details",
    "",
    jsonFence(error ?? value),
  ].join("\n");
}
```

Add these lower-level helpers to the bottom of `packages/core/src/result-content.ts`:

````ts
function isDiscoveryWrapper(value: unknown): value is { result: unknown; caplets?: unknown } {
  return isRecord(value) && "result" in value;
}

function isErrorStructuredContent(value: unknown): boolean {
  return isRecord(value) && "error" in value;
}

function isHttpLikeResult(value: unknown): boolean {
  return isRecord(value) && ("status" in value || "statusText" in value || "body" in value);
}

function isGraphQlHttpResult(value: unknown): boolean {
  if (!isHttpLikeResult(value)) {
    return false;
  }
  const body = asRecord((value as Record<string, unknown>).body);
  return Boolean(body && ("data" in body || "errors" in body));
}

function isCliResult(value: unknown): boolean {
  return isRecord(value) && ("exitCode" in value || "stdout" in value || "stderr" in value);
}

function renderBodyValue(value: unknown): string {
  if (value === undefined) {
    return "_No response body._";
  }
  if (typeof value === "string") {
    return textFenceOrEmpty(value, "No response body.");
  }
  return jsonFence(value);
}

function textFenceOrEmpty(value: unknown, emptyMessage: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return `_${emptyMessage}_`;
  }
  return ["```text", escapeCodeFence(value), "```"].join("\n");
}

function jsonFence(value: unknown): string {
  return ["```json", escapeCodeFence(JSON.stringify(value, null, 2) ?? "null"), "```"].join("\n");
}

function escapeCodeFence(value: string): string {
  return value.replace(/```/gu, "`\u200b``");
}

function textBlocksToString(content: CallToolResult["content"] | undefined): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((item): item is { type: "text"; text: string } =>
      Boolean(
        item && typeof item === "object" && item.type === "text" && typeof item.text === "string",
      ),
    )
    .map((item) => item.text)
    .filter(Boolean)
    .join("\n");
}

function renderTextBlocksWithTitle(
  content: CallToolResult["content"] | undefined,
  context: ResultMarkdownContext,
): string {
  const text = textBlocksToString(content);
  return text ? [markdownTitle(context), "", text].join("\n") : markdownTitle(context);
}

function renderNamedList(items: unknown[], nameKey: string): string {
  if (items.length === 0) {
    return "_No items._";
  }
  return items
    .map((item, index) => {
      const record = asRecord(item);
      const name =
        stringValue(record?.[nameKey]) ?? stringValue(record?.name) ?? `Item ${index + 1}`;
      const description = stringValue(record?.description);
      return description
        ? `${index + 1}. \`${name}\` — ${description}`
        : `${index + 1}. \`${name}\``;
    })
    .join("\n");
}

function renderToolSummary(tool: Record<string, unknown> | undefined): string {
  if (!tool) {
    return "_Tool details unavailable._";
  }
  const lines = [];
  const name = stringValue(tool.name);
  const description = stringValue(tool.description);
  if (name) lines.push(`- **Name:** \`${name}\``);
  if (description) lines.push(`- **Description:** ${description}`);
  if (tool.inputSchema !== undefined)
    lines.push("", "### Input Schema", "", jsonFence(tool.inputSchema));
  if (tool.outputSchema !== undefined)
    lines.push("", "### Output Schema", "", jsonFence(tool.outputSchema));
  if (tool.annotations !== undefined)
    lines.push("", "### Annotations", "", jsonFence(tool.annotations));
  return lines.length > 0 ? lines.join("\n") : jsonFence(tool);
}

function renderBackendStatus(result: Record<string, unknown> | undefined): string {
  if (!result) {
    return "_Backend status unavailable._";
  }
  const lines = [];
  for (const key of [
    "id",
    "status",
    "toolCount",
    "resourceCount",
    "resourceTemplateCount",
    "promptCount",
    "elapsedMs",
  ]) {
    if (result[key] !== undefined) {
      const label = key === "elapsedMs" ? "Elapsed" : humanizeKey(key);
      const suffix = key === "elapsedMs" ? " ms" : "";
      lines.push(`- **${label}:** \`${String(result[key])}${suffix}\``);
    }
  }
  if (result.error !== undefined) {
    lines.push("", "### Error", "", jsonFence(result.error));
  }
  return lines.length > 0 ? lines.join("\n") : jsonFence(result);
}

function renderCapletSummary(result: Record<string, unknown> | undefined): string {
  if (!result) {
    return "_Caplet details unavailable._";
  }
  const lines = [];
  for (const key of ["id", "name", "description"]) {
    if (result[key] !== undefined) {
      lines.push(`- **${humanizeKey(key)}:** ${String(result[key])}`);
    }
  }
  const backend = asRecord(result.backend);
  if (backend?.type !== undefined) {
    lines.push(`- **Backend:** \`${String(backend.type)}\``);
  }
  return lines.length > 0 ? lines.join("\n") : jsonFence(result);
}

function omitKeys(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const omitted = new Set(keys);
  return Object.fromEntries(Object.entries(record).filter(([key]) => !omitted.has(key)));
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function humanizeKey(key: string): string {
  return key.replace(/([A-Z])/gu, " $1").replace(/^./u, (char) => char.toUpperCase());
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
````

- [ ] **Step 2: Export helpers from core package index**

Add this export to `packages/core/src/index.ts`:

```ts
export {
  hasRenderableStructuredContent,
  markdownCallToolResultContent,
  markdownStructuredContent,
} from "./result-content";
export type { ResultMarkdownContext } from "./result-content";
```

- [ ] **Step 3: Run the focused renderer test**

Run:

```bash
pnpm --filter @caplets/core test -- test/result-content.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit renderer foundation**

```bash
git add packages/core/src/result-content.ts packages/core/src/index.ts packages/core/test/result-content.test.ts
git commit -m "feat(core): render structured results as markdown content"
```

---

### Task 3: Wire Markdown Content Through Core Tool Wrappers

**Files:**

- Modify: `packages/core/src/tools.ts`
- Modify: `packages/core/test/tools.test.ts`
- Modify: `packages/core/test/field-selection.test.ts`

- [ ] **Step 1: Add failing wrapper tests**

In `packages/core/test/tools.test.ts`, update expectations that currently assert compact strings such as `"body"` or compact JSON previews. Add this test near existing OpenAPI/HTTP projection tests:

```ts
it("renders field-selected call_tool results as complete Markdown", async () => {
  const result = await handleServerTool(
    openApiServer,
    { operation: "call_tool", tool: "getUser", arguments: { id: "42" }, fields: ["body.name"] },
    openApiRegistry,
    downstream,
    openapi,
  );

  expect(result).toMatchObject({
    structuredContent: { body: { name: "Ada" } },
  });
  expect(result.content[0].text).toContain("# OpenAPI call_tool getUser");
  expect(result.content[0].text).toContain("## Body");
  expect(result.content[0].text).toContain('"name": "Ada"');
});
```

If the local fixture title is not `OpenAPI`, use the existing server name from that test file in the expectation.

- [ ] **Step 2: Run wrapper tests to verify failure**

Run:

```bash
pnpm --filter @caplets/core test -- test/tools.test.ts test/field-selection.test.ts
```

Expected: FAIL because `jsonResult()`, `annotateCallToolResult()`, and field selection still use compact content or preserve compact backend content.

- [ ] **Step 3: Import Markdown helpers in `packages/core/src/tools.ts`**

Replace the existing result-content import:

```ts
import { compactStructuredContent } from "./result-content";
```

with:

```ts
import {
  markdownCallToolResultContent,
  markdownStructuredContent,
  type ResultMarkdownContext,
} from "./result-content";
```

- [ ] **Step 4: Add metadata-to-context helper**

Add this helper below `metadataFor()` in `packages/core/src/tools.ts`:

```ts
function markdownContextFor(metadata: CapletResultMetadata): ResultMarkdownContext {
  return {
    title: [metadata.name, metadata.operation, metadata.tool ?? metadata.uri ?? metadata.prompt]
      .filter(Boolean)
      .join(" "),
    backend: metadata.backend,
    operation: metadata.operation,
    ...(metadata.tool ? { tool: metadata.tool } : {}),
    ...(metadata.uri ? { uri: metadata.uri } : {}),
    ...(metadata.prompt ? { prompt: metadata.prompt } : {}),
  };
}
```

- [ ] **Step 5: Update `jsonResult()` to render Markdown content**

Replace the `jsonResult()` implementation with:

```ts
export function jsonResult(value: unknown, metadata?: CapletResultMetadata): CallToolResult {
  const structuredContent = {
    ...(metadata === undefined ? {} : { caplets: metadata }),
    result: value as Record<string, unknown>,
  };
  return {
    content: markdownStructuredContent(
      structuredContent,
      metadata ? markdownContextFor(metadata) : { title: "Result" },
    ),
    structuredContent,
  };
}
```

- [ ] **Step 6: Update `annotateCallToolResult()` to produce final Markdown after metadata exists**

Inside `annotateCallToolResult()`, replace the return object with:

```ts
const annotatedResult = {
  ...result,
  content: markdownCallToolResultContent(
    result as CallToolResult,
    markdownContextFor(annotatedMetadata),
  ),
  _meta: {
    ...(isPlainObject(existingMeta) ? existingMeta : {}),
    caplets: annotatedMetadata,
  },
};

return annotatedResult as T & CallToolResult;
```

Keep the existing `existingMeta`, `artifacts`, and `annotatedMetadata` computation above this replacement unchanged.

- [ ] **Step 7: Update `projectCallToolResult()` signature and content rendering**

Change the function signature to:

```ts
export function projectCallToolResult<T extends object>(
  result: T,
  outputSchema: unknown,
  fields: string[],
  context: ResultMarkdownContext = {},
): T & CallToolResult {
```

Replace the projected return block with:

```ts
return {
  ...result,
  content: markdownStructuredContent(projected, context),
  structuredContent: projected,
} as T & CallToolResult;
```

In `handleServerTool()` field-selection branch, compute metadata once and pass it to projection:

```ts
const metadata = metadataFor(server, "call_tool", parsed.tool, startedAt);
const result = projectCallToolResult(
  await backend.callTool(server as never, parsed.tool, parsed.arguments),
  tool.outputSchema,
  parsed.fields,
  markdownContextFor(metadata),
);
return annotateCallToolResult(result, metadata);
```

- [ ] **Step 8: Run wrapper tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/tools.test.ts test/field-selection.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit wrapper wiring**

```bash
git add packages/core/src/tools.ts packages/core/test/tools.test.ts packages/core/test/field-selection.test.ts
git commit -m "feat(core): render wrapped caplet results as markdown"
```

---

### Task 4: Wire HTTP and OpenAPI Backends

**Files:**

- Modify: `packages/core/src/http-actions.ts`
- Modify: `packages/core/src/openapi.ts`
- Modify: `packages/core/test/http-actions.test.ts`
- Modify: `packages/core/test/openapi.test.ts`

- [ ] **Step 1: Add failing HTTP action expectations**

In `packages/core/test/http-actions.test.ts`, update the successful call test to assert Markdown content and unchanged structured content:

```ts
expect(result.structuredContent).toMatchObject({
  status: 200,
  statusText: "OK",
  body: { ok: true },
});
expect(result.content[0].text).toContain("## Response");
expect(result.content[0].text).toContain("- **Status:** `200 OK`");
expect(result.content[0].text).toContain("## Body");
expect(result.content[0].text).toContain('"ok": true');
```

Update the forbidden/non-2xx assertion to ensure error bodies remain visible:

```ts
expect(forbidden.structuredContent).toMatchObject({
  status: 403,
  statusText: "Forbidden",
  body: { error: "denied" },
});
expect(forbidden.content[0].text).toContain("- **Status:** `403 Forbidden`");
expect(forbidden.content[0].text).toContain('"error": "denied"');
```

- [ ] **Step 2: Add failing OpenAPI expectations**

In `packages/core/test/openapi.test.ts`, update one successful call assertion:

```ts
expect(result.structuredContent).toMatchObject({
  status: 200,
  body: { name: "Ada" },
});
expect(result.content[0].text).toContain("## Response");
expect(result.content[0].text).toContain("## Headers");
expect(result.content[0].text).toContain("## Body");
expect(result.content[0].text).toContain('"name": "Ada"');
```

- [ ] **Step 3: Run backend tests to verify failure**

Run:

```bash
pnpm --filter @caplets/core test -- test/http-actions.test.ts test/openapi.test.ts
```

Expected: FAIL because direct manager calls still return compact content.

- [ ] **Step 4: Update HTTP actions manager**

In `packages/core/src/http-actions.ts`, replace the result-content import with:

```ts
import { markdownStructuredContent } from "./result-content";
```

Replace the `content` field in `callTool()` with:

```ts
        content: markdownStructuredContent(parsed, {
          title: `${api.name} call_tool ${toolName}`,
          backend: "http",
          operation: "call_tool",
          tool: toolName,
        }),
```

- [ ] **Step 5: Update OpenAPI manager**

In `packages/core/src/openapi.ts`, replace the result-content import with:

```ts
import { markdownStructuredContent } from "./result-content";
```

Replace the `content` field in `callTool()` with:

```ts
        content: markdownStructuredContent(parsed, {
          title: `${endpoint.name} call_tool ${toolName}`,
          backend: "openapi",
          operation: "call_tool",
          tool: toolName,
        }),
```

- [ ] **Step 6: Run HTTP/OpenAPI tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/http-actions.test.ts test/openapi.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit HTTP/OpenAPI formatting**

```bash
git add packages/core/src/http-actions.ts packages/core/src/openapi.ts packages/core/test/http-actions.test.ts packages/core/test/openapi.test.ts
git commit -m "feat(core): render http results as markdown content"
```

---

### Task 5: Wire GraphQL and CLI Backends

**Files:**

- Modify: `packages/core/src/graphql.ts`
- Modify: `packages/core/src/cli-tools.ts`
- Modify: `packages/core/test/graphql.test.ts`
- Modify: `packages/core/test/cli-tools.test.ts`

- [ ] **Step 1: Add failing GraphQL assertions**

In `packages/core/test/graphql.test.ts`, update one successful operation assertion:

```ts
expect(result.structuredContent).toMatchObject({
  status: 200,
  body: { data: { viewer: { login: "octocat" } } },
});
expect(result.content[0].text).toContain("## Data");
expect(result.content[0].text).toContain('"viewer": {');
expect(result.content[0].text).toContain("## Full Body");
```

For an errors response test, add:

```ts
expect(result.content[0].text).toContain("## Errors");
expect(result.content[0].text).toContain('"message"');
```

- [ ] **Step 2: Add failing CLI assertions**

In `packages/core/test/cli-tools.test.ts`, update a successful text-output call assertion:

```ts
expect(result.structuredContent).toMatchObject({
  exitCode: 0,
  stdout: expect.stringContaining("hello"),
  stderr: "",
});
expect(result.content[0].text).toContain("## Command Result");
expect(result.content[0].text).toContain("- **Exit code:** `0`");
expect(result.content[0].text).toContain("## stdout");
expect(result.content[0].text).toContain("hello");
expect(result.content[0].text).toContain("## stderr\n\n_No stderr._");
```

For a JSON-output CLI action test, add:

```ts
expect(result.structuredContent).toMatchObject({ json: { ok: true } });
expect(result.content[0].text).toContain("## Parsed JSON");
expect(result.content[0].text).toContain('"ok": true');
```

- [ ] **Step 3: Run backend tests to verify failure**

Run:

```bash
pnpm --filter @caplets/core test -- test/graphql.test.ts test/cli-tools.test.ts
```

Expected: FAIL because GraphQL and CLI direct managers still return compact content.

- [ ] **Step 4: Update GraphQL manager**

In `packages/core/src/graphql.ts`, replace the result-content import with:

```ts
import { markdownStructuredContent } from "./result-content";
```

Replace the `content` field in `callTool()` with:

```ts
        content: markdownStructuredContent(result, {
          title: `${endpoint.name} call_tool ${toolName}`,
          backend: "graphql",
          operation: "call_tool",
          tool: toolName,
        }),
```

- [ ] **Step 5: Update CLI tools manager**

In `packages/core/src/cli-tools.ts`, replace the result-content import with:

```ts
import { markdownStructuredContent } from "./result-content";
```

Replace the `content` field in `callTool()` with:

```ts
        content: markdownStructuredContent(structured, {
          title: `${config.name} call_tool ${toolName}`,
          backend: "cli",
          operation: "call_tool",
          tool: toolName,
        }),
```

- [ ] **Step 6: Run GraphQL/CLI tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/graphql.test.ts test/cli-tools.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit GraphQL/CLI formatting**

```bash
git add packages/core/src/graphql.ts packages/core/src/cli-tools.ts packages/core/test/graphql.test.ts packages/core/test/cli-tools.test.ts
git commit -m "feat(core): render graphql and cli results as markdown content"
```

---

### Task 6: Render Safe Error Results as Complete Markdown

**Files:**

- Modify: `packages/core/src/errors.ts`
- Modify: `packages/core/test/tools.test.ts`

- [ ] **Step 1: Add failing error-result assertion**

In the core test file that already asserts generated error results, update the expectation to require Markdown details:

```ts
expect(result.isError).toBe(true);
expect(result.structuredContent).toMatchObject({
  error: {
    code: "REQUEST_INVALID",
    message: expect.any(String),
  },
});
expect(result.content[0].text).toContain("# Error");
expect(result.content[0].text).toContain("## REQUEST_INVALID");
expect(result.content[0].text).toContain("## Details");
expect(result.content[0].text).toContain('"code": "REQUEST_INVALID"');
```

- [ ] **Step 2: Run error-related tests to verify failure**

Run:

```bash
pnpm --filter @caplets/core test -- test/tools.test.ts
```

Expected: FAIL because `errorResult()` still returns one-line text.

- [ ] **Step 3: Update `errorResult()`**

In `packages/core/src/errors.ts`, import the Markdown helper:

```ts
import { markdownStructuredContent } from "./result-content";
```

Replace the `errorResult()` return object with:

```ts
export function errorResult(error: unknown, fallback?: CapletsErrorCode) {
  const safe = toSafeError(error, fallback);
  const structuredContent = { error: safe };
  return {
    isError: true,
    content: markdownStructuredContent(structuredContent, {
      title: "Error",
      isError: true,
    }),
    structuredContent,
  };
}
```

- [ ] **Step 4: Run error-related tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/tools.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit error formatting**

```bash
git add packages/core/src/errors.ts packages/core/test/tools.test.ts
git commit -m "feat(core): render error results as markdown content"
```

---

### Task 7: Preserve Downstream MCP Content and Append Structured Content

**Files:**

- Modify: `packages/core/test/downstream.test.ts`
- Modify: `packages/core/test/tools.test.ts`
- Modify: `packages/core/src/tools.ts`

- [ ] **Step 1: Add failing downstream MCP wrapper test**

In `packages/core/test/tools.test.ts`, add a test using the existing mock downstream manager pattern:

```ts
it("preserves MCP downstream text and appends downstream structuredContent", async () => {
  const downstream = mockDownstreamCallResult({
    content: [{ type: "text", text: "Downstream authored response" }],
    structuredContent: { answer: { value: 42 } },
  });

  const result = await handleServerTool(
    mcpServer,
    { operation: "call_tool", tool: "answer", arguments: {} },
    registry,
    downstream,
  );

  expect(result.structuredContent).toEqual({ answer: { value: 42 } });
  expect(result.content[0].text).toContain("Downstream authored response");
  expect(result.content[0].text).toContain("## Structured Content");
  expect(result.content[0].text).toContain('"value": 42');
});
```

Use the actual mock helper names already present in `packages/core/test/tools.test.ts`; keep the expected behavior exactly as shown.

- [ ] **Step 2: Run MCP wrapper tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/tools.test.ts test/downstream.test.ts
```

Expected: PASS if Task 3 already routes `annotateCallToolResult()` through `markdownCallToolResultContent()`; otherwise FAIL and fix `annotateCallToolResult()` to use the Task 3 code exactly.

- [ ] **Step 3: Commit downstream MCP behavior**

```bash
git add packages/core/src/tools.ts packages/core/test/tools.test.ts packages/core/test/downstream.test.ts
git commit -m "feat(core): expose downstream structured content in markdown"
```

---

### Task 8: Update Pi Native Integration to Use Core Markdown and Keep UI Preview Truncated

**Files:**

- Modify: `packages/pi/src/index.ts`
- Modify: `packages/pi/test/pi.test.ts`

- [ ] **Step 1: Add failing Pi agent-content and renderer tests**

Update the previously added structured body visibility test in `packages/pi/test/pi.test.ts` to assert the agent-visible payload is full Markdown, not raw JSON-only content:

```ts
expect(result?.content[0]?.text).toContain("# OSV Vulnerabilities call_tool query_purl");
expect(result?.content[0]?.text).toContain("## Body");
expect(result?.content[0]?.text).toContain('"vulns": []');
```

Add a long-field value to the mocked structured body so the collapsed renderer can prove truncation without losing expanded content:

```ts
const longAdvisory = "A".repeat(400);
service.execute.mockResolvedValueOnce({
  content: [{ type: "text", text: "status 200; OK; body" }],
  structuredContent: {
    status: 200,
    statusText: "OK",
    body: {
      vulns: [
        {
          id: "GHSA-test",
          summary: longAdvisory,
        },
      ],
    },
  },
  _meta: {
    caplets: {
      name: "OSV Vulnerabilities",
      operation: "call_tool",
      tool: "query_purl",
      status: "ok",
    },
  },
});
```

Assert collapsed rendering is short and does not dump the full Markdown body:

```ts
const collapsed = renderText(
  registered[0]?.renderResult(result!, { expanded: false, isPartial: false }, plainTheme),
);
expect(collapsed).toContain("✓ OSV Vulnerabilities call_tool query_purl complete");
expect(collapsed.length).toBeLessThan(260);
expect(collapsed).not.toContain(longAdvisory);
expect(collapsed).toContain("ctrl+o to expand");
```

Assert expanded rendering, opened by `ctrl+o`, displays the full Markdown content:

```ts
const expanded = renderText(
  registered[0]?.renderResult(result!, { expanded: true, isPartial: false }, plainTheme),
);
expect(expanded).toContain("✓ OSV Vulnerabilities call_tool query_purl complete");
expect(expanded).toContain("## Body");
expect(expanded).toContain('"id": "GHSA-test"');
expect(expanded).toContain(longAdvisory);
expect(expanded).toContain("ctrl+o to collapse");
```

- [ ] **Step 2: Run Pi tests to verify failure**

Run:

```bash
pnpm --filter @caplets/pi test -- test/pi.test.ts
```

Expected: FAIL because Pi currently serializes structured content as raw pretty JSON or uses local logic rather than the core Markdown renderer. If the collapsed-renderer assertions already pass, keep them as regression coverage while fixing the agent-visible Markdown branch.

- [ ] **Step 3: Import core Markdown helpers in Pi**

In `packages/pi/src/index.ts`, add this import:

```ts
import {
  hasRenderableStructuredContent,
  markdownStructuredContent,
  type ResultMarkdownContext,
} from "@caplets/core";
```

- [ ] **Step 4: Add Pi context builder**

Add this helper near `capletsMetadata()`:

```ts
function piMarkdownContext(details: unknown): ResultMarkdownContext {
  const metadata = capletsMetadata(details);
  if (!metadata) {
    return { title: "Result" };
  }
  return {
    title: [metadata.name, metadata.operation, metadata.tool].filter(Boolean).join(" "),
    operation: metadata.operation,
    tool: metadata.tool,
  };
}
```

- [ ] **Step 5: Update `agentContent()` without changing collapsed/expanded UI semantics**

Replace the structured-content branch in `agentContent()` with:

```ts
const structured = objectProperty(result, "structuredContent");
if (hasRenderableStructuredContent(structured)) {
  return markdownStructuredContent(structured, piMarkdownContext({ result }));
}
```

Keep the existing fallback that returns downstream text content or JSON stringification for non-structured results.

Do not make `renderResult()` print full content in the collapsed state. Its current split must remain:

```ts
if (expanded) {
  const output = resultFullContent(result.content);
  // render full output
}

const preview = resultPreview(result.details, result.content);
// render short preview only
```

If the Markdown result makes collapsed previews too noisy, adjust only `resultPreview()`/`compactText()` limits or summary logic so collapsed output stays short while `resultFullContent()` remains complete.

- [ ] **Step 6: Run Pi tests**

Run:

```bash
pnpm --filter @caplets/pi test -- test/pi.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Pi integration**

```bash
git add packages/pi/src/index.ts packages/pi/test/pi.test.ts
git commit -m "feat(pi): show structured caplet results as expandable markdown"
```

---

### Task 9: Update OpenCode Native Integration to Use Core Markdown

**Files:**

- Modify: `packages/opencode/src/hooks.ts`
- Modify: `packages/opencode/test/opencode.test.ts`

- [ ] **Step 1: Add failing OpenCode Markdown test**

Update the existing OpenCode structured body visibility test in `packages/opencode/test/opencode.test.ts`:

```ts
expect(result).toContain("# OSV Vulnerabilities call_tool query_purl");
expect(result).toContain("## Body");
expect(result).toContain('"vulns": []');
```

- [ ] **Step 2: Run OpenCode tests to verify failure**

Run:

```bash
pnpm --filter @caplets/opencode test -- test/opencode.test.ts
```

Expected: FAIL because OpenCode currently returns raw JSON for structured content or compact text.

- [ ] **Step 3: Import core Markdown helpers**

In `packages/opencode/src/hooks.ts`, keep native service imports on the native subpath and import Markdown helpers from the core root export:

```ts
import { nativeCapletsSystemGuidance, type NativeCapletsService } from "@caplets/core/native";
import { hasRenderableStructuredContent, markdownStructuredContent } from "@caplets/core";
```

- [ ] **Step 4: Update `compactOpenCodeResult()`**

Replace the structured-content branch with:

```ts
const structuredContent = objectProperty(result, "structuredContent");
if (hasRenderableStructuredContent(structuredContent)) {
  return markdownStructuredContent(structuredContent, { title: "Result" })[0]?.text ?? "# Result";
}
```

If the result includes `_meta.caplets`, build a title before calling `markdownStructuredContent()`:

```ts
const metadata = objectProperty(objectProperty(result, "_meta"), "caplets");
const title = [
  stringProperty(metadata, "name"),
  stringProperty(metadata, "operation"),
  stringProperty(metadata, "tool"),
]
  .filter(Boolean)
  .join(" ");
```

Then pass:

```ts
{ title: title || "Result", operation: stringProperty(metadata, "operation"), tool: stringProperty(metadata, "tool") }
```

- [ ] **Step 5: Run OpenCode tests**

Run:

```bash
pnpm --filter @caplets/opencode test -- test/opencode.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit OpenCode integration**

```bash
git add packages/opencode/src/hooks.ts packages/opencode/test/opencode.test.ts
git commit -m "feat(opencode): show structured caplet results as markdown"
```

---

### Task 10: Add Changeset and Run Full Verification

**Files:**

- Create: `.changeset/lossless-markdown-results.md`
- Modify: `docs/benchmarks/coding-agent.md` only if benchmark verification reports it stale

- [ ] **Step 1: Create a changeset**

Run:

```bash
pnpm changeset
```

Select packages:

```text
@caplets/core: patch
@caplets/pi: patch
@caplets/opencode: patch
```

Use this summary:

```md
Render structured Caplets results as lossless Markdown content while preserving canonical structuredContent.
```

If interactive Changesets is unavailable, create a changeset file manually with a unique filename:

```md
---
"@caplets/core": patch
"@caplets/pi": patch
"@caplets/opencode": patch
---

Render structured Caplets results as lossless Markdown content while preserving canonical structuredContent.
```

- [ ] **Step 2: Run focused package tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/result-content.test.ts test/http-actions.test.ts test/openapi.test.ts test/graphql.test.ts test/cli-tools.test.ts test/tools.test.ts test/downstream.test.ts test/field-selection.test.ts
pnpm --filter @caplets/pi test -- test/pi.test.ts
pnpm --filter @caplets/opencode test -- test/opencode.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 3: Run formatting and typechecks**

Run:

```bash
pnpm format:check
pnpm --filter @caplets/core typecheck
pnpm --filter @caplets/pi typecheck
pnpm --filter @caplets/opencode typecheck
```

Expected: all commands exit 0.

- [ ] **Step 4: Run full verification gate**

Run:

```bash
pnpm verify
```

Expected: `format:check`, `lint`, `typecheck`, `schema:check`, `test`, `benchmark:check`, and `build` all pass.

- [ ] **Step 5: Commit final verification changes**

```bash
git add .changeset packages/core packages/pi packages/opencode docs/benchmarks/coding-agent.md
git commit -m "feat: render caplet result content as markdown"
```

Only include `docs/benchmarks/coding-agent.md` if `pnpm verify` or `pnpm benchmark` updates it.

---

## Self-Review Checklist

- Every Caplets-generated `structuredContent` path has a complete Markdown `content` path.
- No renderer-level truncation exists.
- HTTP/OpenAPI body data appears fully in `content`.
- GraphQL data/errors and full body appear fully in `content`.
- CLI stdout/stderr and parsed JSON appear fully in `content`.
- Discovery/list operations include readable lists plus full JSON result and Caplets metadata.
- Error content includes the full safe error object.
- Downstream MCP content is preserved, and downstream structured content is appended when present.
- Pi and OpenCode use shared core Markdown rendering.
- All changed behavior is covered by failing-first tests.
- Full verification passes before claiming implementation complete.
