# Token-Efficient Caplets Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce redundant token output across Caplets discovery, invocation, native Pi/OpenCode adapters, and benchmarks while preserving machine-readable results and compatibility with MCP-shaped tool responses.

**Architecture:** Centralize result serialization decisions in small core helpers, then update each backend and adapter to avoid echoing the same payload in both human text and structured data. Keep detailed structured objects available in `structuredContent`/adapter `details`, but make visible `content` concise, purposeful, and bounded by default. Add tests that assert redundant JSON payloads are not emitted and benchmarks that measure runtime/discovery result surfaces, not only initial tool metadata.

**Tech Stack:** TypeScript, MCP SDK `CallToolResult`, Zod, Vitest, pnpm, existing Caplets core/pi/opencode packages.

---

## Scope And Constraints

- Do not remove `structuredContent`; agents and adapters rely on it for reliable machine-readable data.
- Keep MCP result shape valid by continuing to return a `content` array, but make it empty or minimal for structured-only operations where tests confirm the SDK accepts it.
- Preserve full downstream text content for MCP-backed `call_tool` unless a new explicit compacting layer applies at the Pi/OpenCode adapter boundary.
- Avoid changing external downstream tool behavior. Caplets should not silently mutate downstream MCP `content`, except where Caplets itself generated redundant JSON text for HTTP/OpenAPI/GraphQL/CLI/field-selection/error results.
- Keep CLI default human summaries useful; JSON mode can remain complete because users explicitly request machine output from the CLI.
- Use `pnpm` only.

## File Structure

- Modify `packages/core/src/tools.ts`
  - Replace `jsonResult()` placeholder text with compact structured-only content.
  - Replace field-selection text duplication with a compact summary.
  - Keep metadata extraction and annotation behavior intact.
- Create `packages/core/src/result-content.ts`
  - Own shared helpers for compact MCP content blocks: structured-only notices, compact JSON summaries, and bounded text previews.
- Modify `packages/core/src/errors.ts`
  - Use compact error text while keeping `structuredContent.error` complete.
- Modify `packages/core/src/http-actions.ts`
  - Return compact generated text for HTTP action results instead of pretty-printing the full structured object.
- Modify `packages/core/src/openapi.ts`
  - Return compact generated text for OpenAPI action results instead of pretty-printing the full structured object.
- Modify `packages/core/src/graphql.ts`
  - Return compact generated text for GraphQL action results instead of pretty-printing the full structured object.
- Modify `packages/core/src/cli-tools.ts`
  - Return compact generated text for CLI action results instead of pretty-printing stdout/stderr structured object.
- Modify `packages/core/src/capability-description.ts`
  - Split long repeated workflow guidance from per-tool capability description.
- Modify `packages/core/src/native/tools.ts`
  - Move repeated workflow guidance into one global system guidance block and make per-tool prompt guidance one line.
- Modify `packages/core/src/runtime.ts`
  - Use concise per-tool MCP descriptions and rely on generated input schema for operation details.
- Modify `packages/core/src/generated-tool-input-schema.ts`
  - Shorten schema field descriptions while retaining critical constraints.
- Modify `packages/core/src/downstream.ts`, `packages/core/src/http-actions.ts`, `packages/core/src/openapi.ts`, `packages/core/src/graphql.ts`, `packages/core/src/cli-tools.ts`, `packages/core/src/caplet-sets.ts`
  - Make `compact()` truly compact by default and reserve verbose annotations/schema hashes for `get_tool` or a new optional discovery verbosity flag.
- Modify `packages/core/src/registry.ts`
  - Reduce `get_caplet` detail duplication and do not include full Markdown body by default.
- Modify `packages/pi/src/index.ts`
  - Stop serializing the full result into visible tool `content`; store it in `details.result` and produce a short preview string.
- Modify `packages/opencode/src/hooks.ts`
  - Return short human text for structured Caplets results; stringify full result only when no structured summary is available.
- Modify tests:
  - `packages/core/test/tools.test.ts`
  - `packages/core/test/http-actions.test.ts`
  - `packages/core/test/openapi.test.ts`
  - `packages/core/test/graphql.test.ts`
  - `packages/core/test/cli-tools.test.ts`
  - `packages/core/test/registry.test.ts`
  - `packages/core/test/downstream.test.ts`
  - `packages/pi/test/pi.test.ts`
  - `packages/opencode/test/opencode.test.ts`
- Modify benchmarks:
  - `packages/benchmarks/lib/surface.ts`
  - `packages/benchmarks/test/benchmark.test.ts`
  - `docs/benchmarks/coding-agent.md` via `pnpm benchmark`

---

### Task 1: Add Shared Compact Result Content Helpers

**Files:**

- Create: `packages/core/src/result-content.ts`
- Test: `packages/core/test/tools.test.ts`

- [ ] **Step 1: Create failing tests for compact structured-only results**

Add these test cases to `packages/core/test/tools.test.ts` near the existing `jsonResult` tests:

```ts
it("returns structured-only discovery results without duplicating the payload as text", () => {
  const result = jsonResult({
    server: "browser",
    tools: [{ tool: "browser_click" }],
  });

  expect(result.content).toEqual([]);
  expect(result.structuredContent).toEqual({
    result: { server: "browser", tools: [{ tool: "browser_click" }] },
  });
  expect(JSON.stringify(result.content)).not.toContain("browser_click");
});

it("returns metadata in structured discovery results without human placeholder text", async () => {
  const registry = registryForBrowserAndStealth();
  const result = await handleServerTool(
    registry.require("browser"),
    { operation: "list_tools" },
    registry,
    mockDownstream([{ name: "browser_click", inputSchema: { type: "object" } }]),
  );

  expect(result.content).toEqual([]);
  expect(result.structuredContent?.caplets).toMatchObject({
    caplet: "browser",
    name: "Browser",
    operation: "list_tools",
  });
  expect(result.structuredContent?.result).toMatchObject({
    server: "browser",
    tools: [{ tool: "browser_click" }],
  });
});
```

If helper names in the current test file differ, reuse the existing local registry/downstream setup already used by nearby tests instead of creating new fixtures.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --filter @caplets/core test -- test/tools.test.ts
```

Expected: FAIL because `jsonResult()` currently returns a text content block containing `result available in structuredContent.result`.

- [ ] **Step 3: Create `packages/core/src/result-content.ts`**

Write this file:

```ts
import type { CallToolResult } from "@modelcontextprotocol/sdk/types";

export type TextContentBlock = { type: "text"; text: string };

export function structuredOnlyContent(): [] {
  return [];
}

export function textContent(text: string): TextContentBlock[] {
  return text ? [{ type: "text", text }] : [];
}

export function compactJsonText(value: unknown, maxLength = 600): string {
  return compactText(JSON.stringify(value), maxLength);
}

export function compactText(value: string, maxLength = 600): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed.length > maxLength
    ? `${collapsed.slice(0, maxLength - 1).trimEnd()}…`
    : collapsed;
}

export function resultKeys(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "scalar result";
  }
  const keys = Object.keys(value).filter((key) => key !== "elapsedMs");
  return keys.length > 0 ? `structured keys: ${keys.join(", ")}` : "empty structured result";
}

export function statusSummary(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return compactJsonText(value);
  }
  const record = value as Record<string, unknown>;
  const status = typeof record.status === "number" ? `status ${record.status}` : undefined;
  const statusText =
    typeof record.statusText === "string" && record.statusText ? record.statusText : undefined;
  const exitCode = typeof record.exitCode === "number" ? `exit ${record.exitCode}` : undefined;
  const body = "body" in record ? "body" : undefined;
  const json = "json" in record ? "json" : undefined;
  const stdout = typeof record.stdout === "string" && record.stdout ? "stdout" : undefined;
  const stderr = typeof record.stderr === "string" && record.stderr ? "stderr" : undefined;
  return (
    [status, statusText, exitCode, body, json, stdout, stderr]
      .filter((part): part is string => Boolean(part))
      .join("; ") || resultKeys(record)
  );
}

export function compactStructuredContent(value: unknown): TextContentBlock[] {
  return textContent(statusSummary(value));
}

export function compactCallToolResultContent(result: CallToolResult): TextContentBlock[] {
  if (result.isError === true) {
    return textContent("downstream tool returned an error");
  }
  return compactStructuredContent(result.structuredContent);
}
```

- [ ] **Step 4: Update `jsonResult()` to use structured-only content**

In `packages/core/src/tools.ts`, import the helper:

```ts
import { structuredOnlyContent } from "./result-content";
```

Replace `jsonResult()` with:

```ts
export function jsonResult(value: unknown, metadata?: CapletResultMetadata): CallToolResult {
  return {
    content: structuredOnlyContent(),
    structuredContent: {
      ...(metadata === undefined ? {} : { caplets: metadata }),
      result: value as Record<string, unknown>,
    },
  };
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/tools.test.ts
```

Expected: PASS for the new tests, with failures only where old tests still expect placeholder text.

- [ ] **Step 6: Update old placeholder expectations**

In `packages/core/test/tools.test.ts`, replace expectations like:

```ts
expect(result.content).toEqual([
  { type: "text", text: "Result available in structuredContent.result." },
]);
```

with:

```ts
expect(result.content).toEqual([]);
```

For Caplet-specific list tests, replace expectations like:

```ts
expect(browser.content).toEqual([
  {
    type: "text",
    text: "Browser list_tools result available in structuredContent.result.",
  },
]);
```

with:

```ts
expect(browser.content).toEqual([]);
```

- [ ] **Step 7: Run focused tests again**

Run:

```bash
pnpm --filter @caplets/core test -- test/tools.test.ts
```

Expected: PASS.

---

### Task 2: Remove Generated JSON Text Duplication From Non-MCP Backends

**Files:**

- Modify: `packages/core/src/http-actions.ts`
- Modify: `packages/core/src/openapi.ts`
- Modify: `packages/core/src/graphql.ts`
- Modify: `packages/core/src/cli-tools.ts`
- Test: `packages/core/test/http-actions.test.ts`
- Test: `packages/core/test/openapi.test.ts`
- Test: `packages/core/test/graphql.test.ts`
- Test: `packages/core/test/cli-tools.test.ts`

- [ ] **Step 1: Add focused assertions that generated text is compact**

In each backend test file, update one successful call assertion to check that `content[0].text` is not the full pretty JSON.

For HTTP/OpenAPI/GraphQL tests, use this pattern:

```ts
expect(result.structuredContent).toMatchObject({
  status: 200,
  body: { ok: true },
});
expect(result.content).toEqual([{ type: "text", text: "status 200; OK; body" }]);
expect(result.content[0]?.text).not.toContain('"body"');
```

For CLI tests, use this pattern:

```ts
expect(result.structuredContent).toMatchObject({
  exitCode: 0,
  stdout: "hello\n",
});
expect(result.content).toEqual([{ type: "text", text: "exit 0; stdout" }]);
expect(result.content[0]?.text).not.toContain('"stdout"');
```

Use the actual status text in existing test responses. If the test server returns an empty status text, expect `status 200; body` instead.

- [ ] **Step 2: Run backend focused tests and verify failure**

Run:

```bash
pnpm --filter @caplets/core test -- test/http-actions.test.ts test/openapi.test.ts test/graphql.test.ts test/cli-tools.test.ts
```

Expected: FAIL because these backends currently set `content[0].text` to `JSON.stringify(structured, null, 2)`.

- [ ] **Step 3: Update backend imports**

Add this import to each modified backend file:

```ts
import { compactStructuredContent } from "./result-content";
```

- [ ] **Step 4: Replace duplicated JSON content in HTTP actions**

In `packages/core/src/http-actions.ts`, replace:

```ts
return {
  content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
  structuredContent: parsed,
  isError: !response.ok,
};
```

with:

```ts
return {
  content: compactStructuredContent(parsed),
  structuredContent: parsed,
  isError: !response.ok,
};
```

- [ ] **Step 5: Replace duplicated JSON content in OpenAPI**

In `packages/core/src/openapi.ts`, replace:

```ts
return {
  content: [
    {
      type: "text",
      text: JSON.stringify(parsed, null, 2),
    },
  ],
  structuredContent: parsed as Record<string, unknown>,
  isError: response.ok ? false : true,
};
```

with:

```ts
return {
  content: compactStructuredContent(parsed),
  structuredContent: parsed as Record<string, unknown>,
  isError: response.ok ? false : true,
};
```

- [ ] **Step 6: Replace duplicated JSON content in GraphQL**

In `packages/core/src/graphql.ts`, replace:

```ts
return {
  content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  structuredContent: result,
  isError:
    !response.ok ||
    Boolean(body && typeof body === "object" && "errors" in body && (body as any).errors),
};
```

with:

```ts
return {
  content: compactStructuredContent(result),
  structuredContent: result,
  isError:
    !response.ok ||
    Boolean(body && typeof body === "object" && "errors" in body && (body as any).errors),
};
```

- [ ] **Step 7: Replace duplicated JSON content in CLI tools**

In `packages/core/src/cli-tools.ts`, replace:

```ts
return {
  content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
  structuredContent: structured,
  isError: result.exitCode !== 0,
};
```

with:

```ts
return {
  content: compactStructuredContent(structured),
  structuredContent: structured,
  isError: result.exitCode !== 0,
};
```

- [ ] **Step 8: Run backend focused tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/http-actions.test.ts test/openapi.test.ts test/graphql.test.ts test/cli-tools.test.ts
```

Expected: PASS after updating exact expected compact strings.

---

### Task 3: Make Field Selection And Error Results Compact

**Files:**

- Modify: `packages/core/src/tools.ts`
- Modify: `packages/core/src/errors.ts`
- Test: `packages/core/test/tools.test.ts`
- Test: `packages/core/test/redaction.test.ts`

- [ ] **Step 1: Add failing tests for projected content**

In `packages/core/test/tools.test.ts`, update field-selection tests that currently expect pretty JSON text. Replace assertions like:

```ts
expect(result.content).toEqual([{ type: "text", text: '{\n  "message": "ok"\n}' }]);
```

with:

```ts
expect(result.content).toEqual([{ type: "text", text: "structured keys: message" }]);
expect(result.structuredContent).toEqual({ message: "ok" });
```

For nested body projection, use:

```ts
expect(result.content).toEqual([{ type: "text", text: "structured keys: body" }]);
expect(result.structuredContent).toEqual({ body: { name: "Ada" } });
```

- [ ] **Step 2: Add failing test for compact error content**

In `packages/core/test/tools.test.ts`, add:

```ts
it("returns compact error text while preserving structured error details", () => {
  const result = errorResult(new CapletsError("REQUEST_INVALID", "Bad input", { field: "query" }));

  expect(result.content).toEqual([{ type: "text", text: "REQUEST_INVALID: Bad input" }]);
  expect(result.structuredContent).toEqual({
    error: {
      code: "REQUEST_INVALID",
      message: "Bad input",
      details: { field: "query" },
    },
  });
});
```

Import `CapletsError` and `errorResult` if the file does not already import them.

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```bash
pnpm --filter @caplets/core test -- test/tools.test.ts test/redaction.test.ts
```

Expected: FAIL because projected and error content currently contains full JSON text.

- [ ] **Step 4: Update `projectCallToolResult()`**

In `packages/core/src/tools.ts`, import:

```ts
import { compactStructuredContent, structuredOnlyContent } from "./result-content";
```

If `structuredOnlyContent` is already imported from Task 1, add only `compactStructuredContent`.

Replace this block in `projectCallToolResult()`:

```ts
return {
  ...result,
  content: [
    {
      type: "text",
      text: JSON.stringify(projected, null, 2),
    },
  ],
  structuredContent: projected,
} as T & CallToolResult;
```

with:

```ts
return {
  ...result,
  content: compactStructuredContent(projected),
  structuredContent: projected,
} as T & CallToolResult;
```

- [ ] **Step 5: Update `errorResult()`**

In `packages/core/src/errors.ts`, replace:

```ts
export function errorResult(error: unknown, fallback?: CapletsErrorCode) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(toSafeError(error, fallback), null, 2),
      },
    ],
    structuredContent: {
      error: toSafeError(error, fallback),
    },
  };
}
```

with:

```ts
export function errorResult(error: unknown, fallback?: CapletsErrorCode) {
  const safe = toSafeError(error, fallback);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `${safe.code}: ${safe.message}`,
      },
    ],
    structuredContent: {
      error: safe,
    },
  };
}
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/tools.test.ts test/redaction.test.ts
```

Expected: PASS after updating old JSON-text expectations.

---

### Task 4: Reduce Repeated Tool Description And Prompt Guidance

**Files:**

- Modify: `packages/core/src/capability-description.ts`
- Modify: `packages/core/src/native/tools.ts`
- Modify: `packages/core/src/runtime.ts`
- Test: `packages/core/test/registry.test.ts`
- Test: `packages/core/test/runtime.test.ts`
- Test: `packages/pi/test/pi.test.ts`
- Test: `packages/opencode/test/opencode.test.ts`

- [ ] **Step 1: Add target tests for shorter descriptions**

In `packages/core/test/registry.test.ts`, replace assertions that require full repeated workflow text with:

```ts
expect(description).toContain("Enabled Caplet");
expect(description).toContain("Use get_caplet for details when needed.");
expect(description).not.toContain("Recommended flow:");
expect(description).not.toContain("After get_tool shows outputSchema");
```

In Pi/OpenCode tests that inspect descriptions, add:

```ts
expect(registered[0]?.description.length).toBeLessThan(350);
expect(registered[0]?.description).not.toContain("Recommended flow:");
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm --filter @caplets/core test -- test/registry.test.ts test/runtime.test.ts
pnpm --filter @caplets/pi test -- test/pi.test.ts
pnpm --filter @caplets/opencode test -- test/opencode.test.ts
```

Expected: FAIL because descriptions currently include the repeated progressive-discovery workflow.

- [ ] **Step 3: Replace `capabilityDescription()` with a concise per-tool description**

In `packages/core/src/capability-description.ts`, replace the current function with:

```ts
import type { CapletConfig } from "./config";

export function capabilityDescription(server: CapletConfig): string {
  return [
    `${server.name} Caplet.`,
    server.description,
    "Use get_caplet for details when needed; use search_tools or list_tools to discover downstream operations.",
  ]
    .filter(Boolean)
    .join(" ");
}
```

- [ ] **Step 4: Centralize the long workflow in global native guidance only**

In `packages/core/src/native/tools.ts`, replace `nativeCapletPromptGuidance()` with:

```ts
export function nativeCapletPromptGuidance(toolName: string, caplet: CapletConfig): string[] {
  return [`Use ${toolName} for the ${caplet.name} Caplet capability domain.`];
}
```

Keep `nativeCapletsSystemGuidance()` as the single location for the detailed workflow, but shorten it by replacing the current numbered list with:

```ts
return [
  "## Caplets Native Tools",
  "",
  "Caplets tools expose configured capability domains through progressive discovery.",
  "",
  "Available Caplets native tools:",
  tools,
  "",
  "Flow: get_caplet when the domain is unfamiliar; search_tools or list_tools to find exact downstream names; get_tool only when schemas are unclear; call_tool with downstream inputs inside arguments.",
  "Use fields on call_tool when a non-GraphQL downstream outputSchema allows selecting only needed structured paths.",
].join("\n");
```

- [ ] **Step 5: Keep runtime descriptions concise**

No separate implementation is needed in `packages/core/src/runtime.ts` if it imports `capabilityDescription()`. Verify registered tool descriptions become concise through existing calls at `registerCapletTool()` and `tool.update()`.

- [ ] **Step 6: Update tests that expected old prose**

Update any failing assertions that contain exact old workflow strings. Use concise expectations:

```ts
expect(description).toContain("Use get_caplet for details when needed");
expect(description).not.toContain("Recommended flow:");
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/registry.test.ts test/runtime.test.ts
pnpm --filter @caplets/pi test -- test/pi.test.ts
pnpm --filter @caplets/opencode test -- test/opencode.test.ts
```

Expected: PASS.

---

### Task 5: Shorten Generated Input Schema Descriptions

**Files:**

- Modify: `packages/core/src/generated-tool-input-schema.ts`
- Test: `packages/core/test/tools.test.ts`
- Test: `packages/pi/test/pi.test.ts`
- Test: `packages/opencode/test/opencode.test.ts`

- [ ] **Step 1: Add schema-size regression test**

In `packages/core/test/tools.test.ts`, add:

```ts
it("keeps generated Caplets wrapper input schema descriptions compact", () => {
  const schema = generatedToolInputJsonSchema();
  const serialized = JSON.stringify(schema);
  const descriptionBytes = Object.values(schema.properties).reduce(
    (total, property) =>
      total +
      Buffer.byteLength(typeof property.description === "string" ? property.description : ""),
    0,
  );

  expect(Buffer.byteLength(serialized)).toBeLessThan(1200);
  expect(descriptionBytes).toBeLessThan(700);
});
```

Import `generatedToolInputJsonSchema` if needed.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm --filter @caplets/core test -- test/tools.test.ts
```

Expected: FAIL because current schema descriptions are about 1.3 KB by themselves.

- [ ] **Step 3: Replace verbose generated descriptions**

In `packages/core/src/generated-tool-input-schema.ts`, replace `generatedToolInputDescriptions` with:

```ts
export const generatedToolInputDescriptions = {
  operation:
    "Wrapper operation: get_caplet, check_backend, list_tools, search_tools, get_tool, or call_tool.",
  query: "Required for search_tools only.",
  limit: "Optional search_tools result limit.",
  tool: "Exact downstream tool name for get_tool or call_tool.",
  arguments: "Required JSON object for call_tool downstream inputs.",
  fields: "Optional call_tool structured output paths when outputSchema allows it.",
} as const;
```

- [ ] **Step 4: Update tests with old exact description expectations**

Replace expectations containing the old examples with compact expectations:

```ts
expect(schema.properties.operation.description).toContain("Wrapper operation");
expect(schema.properties.arguments.description).toContain("downstream inputs");
```

- [ ] **Step 5: Run adapter tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/tools.test.ts
pnpm --filter @caplets/pi test -- test/pi.test.ts
pnpm --filter @caplets/opencode test -- test/opencode.test.ts
```

Expected: PASS.

---

### Task 6: Make `list_tools` Compact By Default

**Files:**

- Modify: `packages/core/src/downstream.ts`
- Modify: `packages/core/src/http-actions.ts`
- Modify: `packages/core/src/openapi.ts`
- Modify: `packages/core/src/graphql.ts`
- Modify: `packages/core/src/cli-tools.ts`
- Modify: `packages/core/src/caplet-sets.ts`
- Test: `packages/core/test/downstream.test.ts`
- Test: `packages/core/test/tools.test.ts`
- Test: backend tests listed in Task 2

- [ ] **Step 1: Add compact-list assertions**

In `packages/core/test/downstream.test.ts`, update compact tool expectations to:

```ts
expect(first).toEqual({
  server: "alpha",
  tool: "example_tool",
  description: "Example tool description.",
  hasInputSchema: true,
  hasOutputSchema: false,
});
expect(first).not.toHaveProperty("annotations");
expect(first).not.toHaveProperty("inputSchemaHash");
expect(first).not.toHaveProperty("outputSchemaHash");
```

In `packages/core/test/tools.test.ts`, update list-tools expected output similarly.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm --filter @caplets/core test -- test/downstream.test.ts test/tools.test.ts
```

Expected: FAIL because compact tools currently include annotations and schema hashes.

- [ ] **Step 3: Update `CompactTool` type**

In `packages/core/src/downstream.ts`, replace:

```ts
export type CompactTool = {
  server: string;
  tool: string;
  description?: string;
  annotations?: unknown;
  hasInputSchema: boolean;
  hasOutputSchema: boolean;
  inputSchemaHash: string | null;
  outputSchemaHash: string | null;
};
```

with:

```ts
export type CompactTool = {
  server: string;
  tool: string;
  description?: string;
  hasInputSchema: boolean;
  hasOutputSchema: boolean;
};
```

- [ ] **Step 4: Replace all compact implementations**

In each manager `compact()` method, replace the return object with this shape:

```ts
return {
  server: server.server,
  tool: tool.name,
  ...(tool.description ? { description: tool.description } : {}),
  hasInputSchema: Boolean(tool.inputSchema),
  hasOutputSchema: Boolean(tool.outputSchema),
};
```

Use the local config variable name in each file:

- `server.server` in `DownstreamManager`
- `endpoint.server` in `OpenApiManager` and `GraphQLManager`
- `api.server` in `HttpActionManager`
- `config.server` in `CliToolsManager` and `CapletSetManager`

- [ ] **Step 5: Remove now-unused `schemaHash` imports**

Remove `import { schemaHash } from "./schema-hash";` from files where it only supported compact list hashes.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/downstream.test.ts test/tools.test.ts test/http-actions.test.ts test/openapi.test.ts test/graphql.test.ts test/cli-tools.test.ts test/caplet-sets.test.ts
```

Expected: PASS after updating expected compact tool objects.

---

### Task 7: Reduce `get_caplet` Detail Duplication

**Files:**

- Modify: `packages/core/src/registry.ts`
- Test: `packages/core/test/registry.test.ts`
- Test: `packages/core/test/tools.test.ts`

- [ ] **Step 1: Add concise `get_caplet` tests**

In `packages/core/test/registry.test.ts`, add or update assertions:

```ts
const detail = registry.detail(config.mcpServers.enabled!);
expect(detail).toMatchObject({
  caplet: "enabled",
  name: "Enabled",
  description: "Enabled Caplet description.",
  backend: {
    type: "mcp",
    transport: "stdio",
    disabled: false,
  },
});
expect(detail).not.toHaveProperty("mcpServer");
expect(detail).not.toHaveProperty("body");
```

If an existing fixture expects a body, assert that `body` is not included by default.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm --filter @caplets/core test -- test/registry.test.ts test/tools.test.ts
```

Expected: FAIL because MCP detail currently duplicates backend data in `mcpServer`, and Markdown body may be included.

- [ ] **Step 3: Remove `mcpServer` from the public detail type**

In `packages/core/src/registry.ts`, remove the `mcpServer?: { ... }` field from `CapletServerDetail`.

- [ ] **Step 4: Remove default body and MCP duplication from `detail()`**

Replace the `detail()` return object with:

```ts
return {
  caplet: server.server,
  name: server.name,
  description: server.description,
  ...(server.tags ? { tags: server.tags } : {}),
  backend,
};
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/registry.test.ts test/tools.test.ts
```

Expected: PASS after updating any expected snapshots or objects.

---

### Task 8: Make Pi Adapter Visible Content Concise

**Files:**

- Modify: `packages/pi/src/index.ts`
- Test: `packages/pi/test/pi.test.ts`

- [ ] **Step 1: Add Pi adapter tests for concise visible content**

In `packages/pi/test/pi.test.ts`, add:

```ts
it("stores full Caplets result in details while returning compact visible content", async () => {
  const service = mockService([
    {
      caplet: "context7",
      toolName: "caplets_context7",
      title: "Context7",
      description: "Context7 Caplet",
      promptGuidance: ["Use caplets_context7 for Context7."],
    },
  ]);
  const fullResult = {
    content: [{ type: "text", text: "very long docs" }],
    structuredContent: { result: { tools: [{ tool: "resolve-library-id" }] } },
  };
  service.execute.mockResolvedValueOnce(fullResult);
  const registered: RegisteredTool[] = [];

  capletsPiExtension(
    {
      registerTool: (definition) => registered.push(definition as unknown as RegisteredTool),
    },
    { service },
  );

  const result = await registered[0]?.execute("call-1", {
    operation: "list_tools",
  });

  expect(result?.content[0]?.text).toBe("structured keys: result");
  expect(result?.content[0]?.text).not.toContain("resolve-library-id");
  expect(result?.details).toEqual({ result: fullResult });
});
```

- [ ] **Step 2: Run Pi tests and verify failure**

Run:

```bash
pnpm --filter @caplets/pi test -- test/pi.test.ts
```

Expected: FAIL because `execute()` currently serializes the entire result into visible content.

- [ ] **Step 3: Add local compact serializer in Pi adapter**

In `packages/pi/src/index.ts`, replace `serializeResult()` with:

```ts
function serializeResult(result: unknown): {
  text: string;
  serializationError?: string;
} {
  try {
    return { text: compactResultText(result) };
  } catch (error) {
    const serializationError = error instanceof Error ? error.message : String(error);
    return {
      text: `[Serialization error: ${serializationError}]`,
      serializationError,
    };
  }
}

function compactResultText(result: unknown): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return String(result ?? "null");
  }
  const structured = objectProperty(result, "structuredContent");
  if (structured) {
    const keys = Object.keys(structured).filter((key) => key !== "caplets");
    return keys.length ? `structured keys: ${keys.join(", ")}` : "structured result";
  }
  const content = arrayProperty(result, "content")
    .filter((item) => stringProperty(item, "type") === "text")
    .map((item) => stringProperty(item, "text"))
    .filter((text): text is string => Boolean(text));
  if (content.length > 0) {
    return content.join("\n").replace(/\s+/gu, " ").trim().slice(0, 600);
  }
  return "Caplets result";
}
```

Keep the existing `details: { result }` behavior unchanged.

- [ ] **Step 4: Update old Pi tests that expected full JSON content**

Replace assertions that expect serialized JSON in `result.content[0].text` with concise text expectations. For `undefined`, keep:

```ts
expect(result?.content[0]?.text).toBe("null");
```

For structured results, use:

```ts
expect(result?.content[0]?.text).toContain("structured keys:");
expect(result?.details.result).toEqual(fullResult);
```

- [ ] **Step 5: Run Pi tests**

Run:

```bash
pnpm --filter @caplets/pi test -- test/pi.test.ts
```

Expected: PASS.

---

### Task 9: Make OpenCode Adapter Visible Content Concise

**Files:**

- Modify: `packages/opencode/src/hooks.ts`
- Test: `packages/opencode/test/opencode.test.ts`

- [ ] **Step 1: Add OpenCode concise output test**

In `packages/opencode/test/opencode.test.ts`, add:

```ts
it("returns compact text for structured Caplets results", async () => {
  const service = mockService([
    {
      caplet: "linear",
      toolName: "caplets_linear",
      title: "Linear",
      description: "Linear Caplet",
      promptGuidance: ["Use caplets_linear for Linear."],
    },
  ]);
  service.execute.mockResolvedValueOnce({
    content: [{ type: "text", text: "large downstream result" }],
    structuredContent: { result: { issues: [{ id: "LIN-1" }] } },
  });

  const hooks = await createCapletsOpenCodeHooks(service);
  const output = await hooks.tool.caplets_linear.execute({
    operation: "list_tools",
  });

  expect(output).toBe("structured keys: result");
  expect(output).not.toContain("LIN-1");
});
```

Use the exact mock helper names already present in the file.

- [ ] **Step 2: Run OpenCode tests and verify failure**

Run:

```bash
pnpm --filter @caplets/opencode test -- test/opencode.test.ts
```

Expected: FAIL because OpenCode currently returns full pretty JSON for non-string results.

- [ ] **Step 3: Add compact result helper in OpenCode hooks**

In `packages/opencode/src/hooks.ts`, replace the `execute` body with:

```ts
async execute(args) {
  const result = await service.execute(caplet.caplet, args);
  return compactOpenCodeResult(result);
},
```

Add this helper below `createCapletsOpenCodeHooks()`:

```ts
function compactOpenCodeResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return String(result ?? "null");
  }
  const structured = (result as Record<string, unknown>).structuredContent;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    const keys = Object.keys(structured).filter((key) => key !== "caplets");
    return keys.length ? `structured keys: ${keys.join(", ")}` : "structured result";
  }
  const content = (result as Record<string, unknown>).content;
  if (Array.isArray(content)) {
    const text = content
      .filter((item): item is { type: string; text: string } =>
        Boolean(
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          (item as any).type === "text" &&
          typeof (item as any).text === "string",
        ),
      )
      .map((item) => item.text)
      .join("\n")
      .replace(/\s+/gu, " ")
      .trim();
    if (text) return text.length > 600 ? `${text.slice(0, 599).trimEnd()}…` : text;
  }
  return "Caplets result";
}
```

- [ ] **Step 4: Run OpenCode tests**

Run:

```bash
pnpm --filter @caplets/opencode test -- test/opencode.test.ts
```

Expected: PASS.

---

### Task 10: Add Bounded Output Options For Generated HTTP And CLI Backends

**Files:**

- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/http-actions.ts`
- Modify: `packages/core/src/openapi.ts`
- Modify: `packages/core/src/graphql.ts`
- Modify: `packages/core/src/cli-tools.ts`
- Test: `packages/core/test/config.test.ts`
- Test: `packages/core/test/http-actions.test.ts`
- Test: `packages/core/test/openapi.test.ts`
- Test: `packages/core/test/graphql.test.ts`
- Test: `packages/core/test/cli-tools.test.ts`
- Generated: `schemas/caplets-config.schema.json`

- [ ] **Step 1: Add config tests for smaller defaults**

In `packages/core/test/config.test.ts`, update default expectations:

```ts
expect(config.httpApis.api?.maxResponseBytes).toBe(200_000);
expect(config.cliTools.repo?.maxOutputBytes).toBe(200_000);
```

Add a test that explicit large values still work:

```ts
it("allows explicit larger response and CLI output byte limits", () => {
  const config = loadConfigFromObject({
    version: 1,
    httpApis: {
      api: {
        name: "API",
        description: "HTTP API description.",
        baseUrl: "https://example.com",
        auth: { type: "none" },
        maxResponseBytes: 1_000_000,
        actions: {
          ping: { method: "GET", path: "/ping" },
        },
      },
    },
    cliTools: {
      repo: {
        name: "Repo",
        description: "Repository CLI description.",
        maxOutputBytes: 1_000_000,
        actions: {
          status: { command: "git", args: ["status"] },
        },
      },
    },
  });

  expect(config.httpApis.api?.maxResponseBytes).toBe(1_000_000);
  expect(config.cliTools.repo?.maxOutputBytes).toBe(1_000_000);
});
```

Use the existing config test helper names in the file.

- [ ] **Step 2: Run config tests and verify failure**

Run:

```bash
pnpm --filter @caplets/core test -- test/config.test.ts
```

Expected: FAIL because defaults are currently 1 MB.

- [ ] **Step 3: Lower default byte limits in config**

In `packages/core/src/config.ts`, replace both `.default(1_000_000)` for HTTP `maxResponseBytes` and CLI `maxOutputBytes` with:

```ts
.default(200_000)
```

- [ ] **Step 4: Add truncation marker to generated compact content**

In `packages/core/src/result-content.ts`, add:

```ts
export function byteLimitHint(maxBytes: number): string {
  return `response body limit ${maxBytes} bytes`;
}
```

Do not add this hint to every successful response. Use it only in errors or summaries when a limit was hit. Existing `readLimitedText()` already throws when the limit is exceeded, so no backend code change is needed beyond defaults unless tests require exact error messages.

- [ ] **Step 5: Regenerate schema**

Run:

```bash
pnpm schema:generate
```

Expected: `schemas/caplets-config.schema.json` updates default values for HTTP and CLI byte limits.

- [ ] **Step 6: Run focused backend/config tests**

Run:

```bash
pnpm --filter @caplets/core test -- test/config.test.ts test/http-actions.test.ts test/openapi.test.ts test/graphql.test.ts test/cli-tools.test.ts
pnpm schema:check
```

Expected: PASS.

---

### Task 11: Expand Benchmarks To Cover Runtime Result Surfaces

**Files:**

- Modify: `packages/benchmarks/lib/surface.ts`
- Modify: `packages/benchmarks/test/benchmark.test.ts`
- Generated: `docs/benchmarks/coding-agent.md`

- [ ] **Step 1: Add benchmark expectations for runtime duplication**

In `packages/benchmarks/test/benchmark.test.ts`, add assertions after the existing surface benchmark checks:

```ts
expect(result.runtime).toMatchObject({
  duplicatedStructuredContentBytes: expect.any(Number),
  compactStructuredContentBytes: expect.any(Number),
});
expect(result.runtime.compactStructuredContentBytes).toBeLessThan(
  result.runtime.duplicatedStructuredContentBytes,
);
expect(result.runtime.compactReduction).toBeGreaterThan(0.5);
```

- [ ] **Step 2: Run benchmark tests and verify failure**

Run:

```bash
pnpm --filter @caplets/benchmarks test -- test/benchmark.test.ts
```

Expected: FAIL because `runtime` benchmark data does not exist.

- [ ] **Step 3: Add runtime surface stats**

In `packages/benchmarks/lib/surface.ts`, add this function near `surfaceStats()`:

```ts
function runtimeResultStats() {
  const structured = {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
    body: {
      items: Array.from({ length: 20 }, (_, index) => ({
        id: `item-${index}`,
        title: `Example item ${index}`,
        description:
          "Representative downstream payload content used for token surface measurement.",
      })),
    },
    elapsedMs: 42,
  };
  const duplicated = {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
  const compact = {
    content: [{ type: "text", text: "status 200; OK; body" }],
    structuredContent: structured,
  };
  const duplicatedBytes = Buffer.byteLength(JSON.stringify(duplicated), "utf8");
  const compactBytes = Buffer.byteLength(JSON.stringify(compact), "utf8");
  return {
    duplicatedStructuredContentBytes: duplicatedBytes,
    compactStructuredContentBytes: compactBytes,
    compactReduction: 1 - compactBytes / duplicatedBytes,
    compactReductionPercent: percent(1 - compactBytes / duplicatedBytes),
  };
}
```

In `computeSurfaceBenchmark()`, add:

```ts
const runtime = runtimeResultStats();
```

and include it in the returned object:

```ts
runtime,
```

- [ ] **Step 4: Update markdown report**

In `renderMarkdownReport()`, add this section after the deterministic initial payload results:

```md
## Runtime Result Duplication Check

Generated structured backend results previously duplicated the same payload as both text content and structured content. The compact representation reduces the representative runtime result from ${result.runtime.duplicatedStructuredContentBytes} bytes to ${result.runtime.compactStructuredContentBytes} bytes, ${result.runtime.compactReductionPercent} fewer.
```

- [ ] **Step 5: Run benchmark generation**

Run:

```bash
pnpm benchmark
pnpm benchmark:check
pnpm --filter @caplets/benchmarks test -- test/benchmark.test.ts
```

Expected: PASS and `docs/benchmarks/coding-agent.md` updated.

---

### Task 12: Full Verification And Cleanup

**Files:**

- All modified files from Tasks 1-11

- [ ] **Step 1: Run LSP diagnostics before the full build**

Run via the harness diagnostic tool on:

```text
packages/core/src
packages/pi/src
packages/opencode/src
packages/benchmarks/lib
```

Expected: no TypeScript errors.

- [ ] **Step 2: Run format check**

Run:

```bash
pnpm format:check
```

Expected: PASS. If it fails, run `pnpm format`, inspect changes, then re-run `pnpm format:check`.

- [ ] **Step 3: Run lint**

Run:

```bash
pnpm lint
```

Expected: PASS.

- [ ] **Step 4: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 5: Run schema check**

Run:

```bash
pnpm schema:check
```

Expected: PASS.

- [ ] **Step 6: Run all tests**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 7: Run benchmark check**

Run:

```bash
pnpm benchmark:check
```

Expected: PASS.

- [ ] **Step 8: Run build**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 9: Run full verify gate**

Run:

```bash
pnpm verify
```

Expected: PASS.

---

## Self-Review

**Spec coverage:**

- Discovery `content` plus `structuredContent` waste is covered by Tasks 1 and 3.
- HTTP/OpenAPI/GraphQL/CLI generated result duplication is covered by Task 2.
- Pi adapter full-result serialization is covered by Task 8.
- OpenCode adapter full-result serialization is covered by Task 9.
- Repeated caplet workflow instructions and prompt guidance are covered by Task 4.
- Verbose generated input schema descriptions are covered by Task 5.
- Large `list_tools` compact payloads are covered by Task 6.
- `get_caplet` body and MCP backend duplication are covered by Task 7.
- Large generated output defaults are covered by Task 10.
- Benchmark blind spot is covered by Task 11.
- Full verification is covered by Task 12.

**Placeholder scan:** This plan contains no `TBD`, no `TODO`, and no steps that defer implementation decisions without concrete commands or code.

**Type consistency:** New helper names are consistent across tasks: `structuredOnlyContent`, `compactStructuredContent`, `compactText`, `compactJsonText`, `statusSummary`, and `resultKeys`. The plan uses existing result fields `content`, `structuredContent`, `isError`, and `_meta.caplets` without renaming them.
