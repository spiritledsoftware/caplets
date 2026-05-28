# MCP Resources and Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MCP resource, resource-template, prompt, and completion support to MCP-backed Caplets while keeping non-MCP backends tool-only.

**Architecture:** Generate backend-aware Caplet operation schemas, route MCP-only operations only for `backend: "mcp"`, and extend `DownstreamManager` to cache and forward MCP resources/prompts/completions through the existing managed MCP connection. CLI, remote control, Pi, and OpenCode consume the same backend-aware operation model so agents are not invited to call MCP-specific operations on OpenAPI, GraphQL, HTTP, CLI, or Caplet-set backends.

**Tech Stack:** TypeScript, Zod 4, MCP SDK 1.29, Commander, Vitest, Pi/OpenCode native adapters, pnpm 11.0.9.

---

## Scope and constraints

- Use `pnpm` only.
- Preserve one top-level Caplets tool per enabled Caplet.
- Do not flatten downstream resources/prompts into Caplets `tools/list`.
- Do not expose MCP-only operation names in generated schemas for non-MCP backends.
- Keep `get_caplet` non-probing; live MCP capability observation belongs in `check_backend` and operation results.
- Use command-semantic remote control via `/control`; do not add raw CLI-string execution.
- Keep remote mode server-owned for config, Caplet files, and downstream auth secrets.
- Add a changeset because the generated tool schema, CLI surface, and package docs are user-facing.

## File structure

- Modify `packages/core/src/generated-tool-input-schema.ts`
  - Own backend-aware operation arrays, field descriptions, JSON Schema generation, and Zod schema generation.
- Modify `packages/core/src/tools.ts`
  - Validate requests with the selected Caplet backend, dispatch MCP-only operations, and annotate resource/prompt/completion results.
- Modify `packages/core/src/downstream.ts`
  - Add MCP resource, resource-template, prompt, completion, capability, cache, compact, and search methods.
- Modify `packages/core/src/errors.ts`
  - Add `UNSUPPORTED_OPERATION`, `UNSUPPORTED_CAPABILITY`, `RESOURCE_NOT_FOUND`, `PROMPT_NOT_FOUND`, `DOWNSTREAM_RESOURCE_ERROR`, `DOWNSTREAM_PROMPT_ERROR`, and `DOWNSTREAM_COMPLETION_ERROR`.
- Modify `packages/core/src/capability-description.ts`
  - Describe MCP-backed Caplets as tools/resources/prompts/completions; keep non-MCP descriptions tool-oriented.
- Modify `packages/core/src/serve/session.ts`
  - Register and update each Caplet tool with its backend-specific input schema.
- Modify `packages/core/src/native/service.ts`
  - Include backend-aware schema metadata in `NativeCapletTool`.
- Modify `packages/core/src/native/tools.ts`
  - Add MCP-specific guidance only for MCP-backed Caplets.
- Modify `packages/core/src/native/remote.ts`
  - Preserve remote tool input schema metadata when available from remote MCP `tools/list`.
- Modify `packages/pi/src/index.ts`
  - Use each native Caplet tool's JSON Schema instead of the global schema.
- Modify `packages/opencode/src/schema.ts` and `packages/opencode/src/hooks.ts`
  - Generate OpenCode argument schemas from each native Caplet tool's operation set.
- Modify `packages/core/src/cli.ts`
  - Add resource/prompt/completion commands, remote routing, and human summaries.
- Modify `packages/core/src/remote-control/types.ts` and `packages/core/src/remote-control/dispatch.ts`
  - Add command-semantic remote operation names and request validation.
- Modify `README.md`, `packages/cli/README.md`, `packages/pi/README.md`, and `packages/opencode/README.md`.
- Add `.changeset/mcp-resources-prompts.md` for `@caplets/core`, `caplets`, `@caplets/pi`, and `@caplets/opencode`.
- Modify tests:
  - `packages/core/test/tools.test.ts`
  - `packages/core/test/downstream.test.ts`
  - `packages/core/test/serve-session.test.ts`
  - `packages/core/test/cli.test.ts`
  - `packages/core/test/cli-remote.test.ts`
  - `packages/core/test/remote-control-dispatch.test.ts`
  - `packages/core/test/native-remote.test.ts`
  - `packages/pi/test/pi.test.ts`
  - `packages/opencode/test/opencode.test.ts`

---

### Task 1: Add backend-aware generated schemas and validation

**Files:**

- Modify: `packages/core/src/generated-tool-input-schema.ts`
- Modify: `packages/core/src/tools.ts`
- Modify: `packages/core/src/errors.ts`
- Test: `packages/core/test/tools.test.ts`

- [ ] **Step 1: Write failing schema and validation tests**

Add these tests to `packages/core/test/tools.test.ts` inside `describe("generated tool request validation", ...)`:

```ts
import {
  generatedToolInputJsonSchemaForCaplet,
  generatedToolInputSchemaForCaplet,
  mcpOperations,
  operations,
} from "../src/generated-tool-input-schema";

it("generates tool-only schemas for non-MCP Caplets", () => {
  const nonMcp = generatedToolInputJsonSchemaForCaplet({ backend: "http" });
  expect(nonMcp.properties.operation.enum).toEqual(operations);
  expect(nonMcp.properties.operation.enum).not.toContain("list_resources");
  expect(nonMcp.properties).not.toHaveProperty("uri");
  expect(nonMcp.properties).not.toHaveProperty("prompt");
  expect(nonMcp.properties).not.toHaveProperty("ref");
  expect(nonMcp.properties).not.toHaveProperty("argument");
});

it("generates MCP capability schemas only for MCP Caplets", () => {
  const mcp = generatedToolInputJsonSchemaForCaplet({ backend: "mcp" });
  expect(mcp.properties.operation.enum).toEqual(mcpOperations);
  expect(mcp.properties.operation.enum).toContain("list_resources");
  expect(mcp.properties.operation.enum).toContain("get_prompt");
  expect(mcp.properties.operation.enum).toContain("complete");
  expect(mcp.properties).toHaveProperty("uri");
  expect(mcp.properties).toHaveProperty("prompt");
  expect(mcp.properties).toHaveProperty("ref");
  expect(mcp.properties).toHaveProperty("argument");
});

it("validates MCP-only operation request shapes for MCP backends", () => {
  expect(
    validateOperationRequest({ operation: "read_resource", uri: "file:///x" }, 50, "mcp"),
  ).toEqual({ operation: "read_resource", uri: "file:///x" });
  expect(
    validateOperationRequest({ operation: "get_prompt", prompt: "review" }, 50, "mcp"),
  ).toEqual({ operation: "get_prompt", prompt: "review", arguments: {} });
  expect(
    validateOperationRequest(
      {
        operation: "complete",
        ref: { type: "prompt", name: "review" },
        argument: { name: "issueId", value: "CAP-" },
      },
      50,
      "mcp",
    ),
  ).toEqual({
    operation: "complete",
    ref: { type: "prompt", name: "review" },
    argument: { name: "issueId", value: "CAP-" },
  });
});

it("rejects MCP-only operations for non-MCP backends", () => {
  expect(() => validateOperationRequest({ operation: "list_resources" }, 50, "http")).toThrow(
    expect.objectContaining({ code: "UNSUPPORTED_OPERATION" }),
  );
});

it("rejects operation-specific extra fields for MCP-only operations", () => {
  expect(() =>
    validateOperationRequest({ operation: "list_resources", tool: "x" }, 50, "mcp"),
  ).toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }));
  expect(() =>
    validateOperationRequest(
      { operation: "get_prompt", prompt: "x", fields: ["message"] },
      50,
      "mcp",
    ),
  ).toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }));
  expect(() =>
    validateOperationRequest(
      { operation: "complete", ref: { type: "prompt", name: "x" } },
      50,
      "mcp",
    ),
  ).toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }));
});
```

- [ ] **Step 2: Run focused tests to verify red**

Run:

```sh
pnpm --filter @caplets/core test -- test/tools.test.ts
```

Expected: FAIL because `generatedToolInputJsonSchemaForCaplet`, `generatedToolInputSchemaForCaplet`, `mcpOperations`, new errors, and the third `validateOperationRequest` parameter do not exist.

- [ ] **Step 3: Add error codes**

Modify `packages/core/src/errors.ts` by inserting the new codes before `UNSUPPORTED_TRANSPORT`:

```ts
  "UNSUPPORTED_OPERATION",
  "UNSUPPORTED_CAPABILITY",
  "RESOURCE_NOT_FOUND",
  "PROMPT_NOT_FOUND",
  "DOWNSTREAM_RESOURCE_ERROR",
  "DOWNSTREAM_PROMPT_ERROR",
  "DOWNSTREAM_COMPLETION_ERROR",
```

- [ ] **Step 4: Implement backend-aware schema exports**

Replace `packages/core/src/generated-tool-input-schema.ts` with this shape, preserving the exported `operations`, `generatedToolInputDescriptions`, `generatedToolInputJsonSchema()`, and adding MCP-aware exports:

```ts
import { z } from "zod";

export const operations = [
  "get_caplet",
  "check_backend",
  "list_tools",
  "search_tools",
  "get_tool",
  "call_tool",
] as const;

export const mcpOperations = [
  ...operations,
  "list_resources",
  "search_resources",
  "list_resource_templates",
  "read_resource",
  "list_prompts",
  "search_prompts",
  "get_prompt",
  "complete",
] as const;

export type GeneratedOperation = (typeof operations)[number];
export type GeneratedMcpOperation = (typeof mcpOperations)[number];
export type CapletSchemaBackend = { backend: string };

export const generatedToolInputDescriptions = {
  operation:
    "Wrapper operation. Non-MCP Caplets expose tool operations only; MCP Caplets also expose resources, prompts, and completions.",
  query: "Required for search operations only.",
  limit: "Optional list/search result limit.",
  tool: "Exact downstream tool name for get_tool or call_tool.",
  arguments: "JSON object for call_tool inputs or get_prompt arguments.",
  fields: "Optional call_tool structured output paths when outputSchema allows it.",
  uri: "Exact downstream resource URI for read_resource.",
  prompt: "Exact downstream prompt name for get_prompt.",
  ref: "Completion target reference for complete.",
  argument: "Completion argument object for complete.",
} as const;

export const completionRefSchema = z.union([
  z.object({ type: z.literal("prompt"), name: z.string().min(1) }).strict(),
  z.object({ type: z.literal("resourceTemplate"), uri: z.string().min(1) }).strict(),
]);

export const completionArgumentSchema = z
  .object({ name: z.string().min(1), value: z.string() })
  .strict();

const baseShape = {
  query: z.string().optional().describe(generatedToolInputDescriptions.query),
  limit: z.number().int().positive().optional().describe(generatedToolInputDescriptions.limit),
  tool: z.string().optional().describe(generatedToolInputDescriptions.tool),
  arguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(generatedToolInputDescriptions.arguments),
  fields: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(generatedToolInputDescriptions.fields),
};

export function generatedToolInputSchemaForCaplet(caplet: CapletSchemaBackend) {
  const operationValues = caplet.backend === "mcp" ? mcpOperations : operations;
  return z
    .object({
      operation: z.enum(operationValues).describe(generatedToolInputDescriptions.operation),
      ...baseShape,
      ...(caplet.backend === "mcp"
        ? {
            uri: z.string().optional().describe(generatedToolInputDescriptions.uri),
            prompt: z.string().optional().describe(generatedToolInputDescriptions.prompt),
            ref: completionRefSchema.optional().describe(generatedToolInputDescriptions.ref),
            argument: completionArgumentSchema
              .optional()
              .describe(generatedToolInputDescriptions.argument),
          }
        : {}),
    })
    .strict();
}

export const generatedToolInputSchema = generatedToolInputSchemaForCaplet({ backend: "tool" });

export function generatedToolInputJsonSchemaForCaplet(caplet: CapletSchemaBackend) {
  const mcp = caplet.backend === "mcp";
  return {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: mcp ? mcpOperations : operations,
        description: generatedToolInputDescriptions.operation,
      },
      query: { type: "string", description: generatedToolInputDescriptions.query },
      limit: { type: "integer", minimum: 1, description: generatedToolInputDescriptions.limit },
      tool: { type: "string", description: generatedToolInputDescriptions.tool },
      arguments: { type: "object", description: generatedToolInputDescriptions.arguments },
      fields: {
        type: "array",
        items: { type: "string", minLength: 1 },
        minItems: 1,
        description: generatedToolInputDescriptions.fields,
      },
      ...(mcp
        ? {
            uri: { type: "string", description: generatedToolInputDescriptions.uri },
            prompt: { type: "string", description: generatedToolInputDescriptions.prompt },
            ref: {
              oneOf: [
                {
                  type: "object",
                  properties: { type: { const: "prompt" }, name: { type: "string", minLength: 1 } },
                  required: ["type", "name"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    type: { const: "resourceTemplate" },
                    uri: { type: "string", minLength: 1 },
                  },
                  required: ["type", "uri"],
                  additionalProperties: false,
                },
              ],
              description: generatedToolInputDescriptions.ref,
            },
            argument: {
              type: "object",
              properties: { name: { type: "string", minLength: 1 }, value: { type: "string" } },
              required: ["name", "value"],
              additionalProperties: false,
              description: generatedToolInputDescriptions.argument,
            },
          }
        : {}),
    },
    required: ["operation"],
    additionalProperties: false,
  } as const;
}

export function generatedToolInputJsonSchema() {
  return generatedToolInputJsonSchemaForCaplet({ backend: "tool" });
}
```

- [ ] **Step 5: Extend `validateOperationRequest`**

Modify `packages/core/src/tools.ts` so `handleServerTool` passes `server.backend` and `validateOperationRequest` accepts backend:

```ts
const parsed = validateOperationRequest(
  request,
  registry.config.options.maxSearchLimit,
  server.backend,
);
```

Update the function signature and parsing start:

```ts
export function validateOperationRequest(
  request: unknown,
  maxSearchLimit: number,
  backend: string = "tool",
): RequiredOperationRequest {
  const result = generatedToolInputSchemaForCaplet({ backend }).safeParse(request);
  if (
    request &&
    typeof request === "object" &&
    "operation" in request &&
    typeof (request as { operation?: unknown }).operation === "string" &&
    !mcpOperations.includes((request as { operation: string }).operation as never)
  ) {
    throw new CapletsError(
      "UNKNOWN_OPERATION",
      `Unknown operation: ${(request as { operation: string }).operation}`,
    );
  }
  if (
    request &&
    typeof request === "object" &&
    "operation" in request &&
    typeof (request as { operation?: unknown }).operation === "string" &&
    backend !== "mcp" &&
    mcpOperations.includes((request as { operation: string }).operation as never) &&
    !operations.includes((request as { operation: string }).operation as never)
  ) {
    throw new CapletsError(
      "UNSUPPORTED_OPERATION",
      `${(request as { operation: string }).operation} is only available for MCP-backed Caplets`,
    );
  }
  if (!result.success) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Generated server tool request is invalid",
      result.error.issues,
    );
  }
  const value = result.data;
  // keep existing allowed() helper and existing operation cases, then add the MCP-only cases below
}
```

Add operation cases after `call_tool`:

```ts
case "list_resources":
case "list_resource_templates":
case "list_prompts":
  allowed(["limit"]);
  if (value.limit !== undefined && value.limit > maxSearchLimit) {
    throw new CapletsError("REQUEST_INVALID", `${value.operation} limit must be <= ${maxSearchLimit}`);
  }
  return value.limit === undefined ? { operation: value.operation } : { operation: value.operation, limit: value.limit };
case "search_resources":
case "search_prompts":
  allowed(["query", "limit"]);
  if (!value.query) throw new CapletsError("REQUEST_INVALID", `${value.operation} requires query`);
  if (value.limit !== undefined && value.limit > maxSearchLimit) {
    throw new CapletsError("REQUEST_INVALID", `${value.operation} limit must be <= ${maxSearchLimit}`);
  }
  return value.limit === undefined
    ? { operation: value.operation, query: value.query }
    : { operation: value.operation, query: value.query, limit: value.limit };
case "read_resource":
  allowed(["uri"]);
  if (!value.uri) throw new CapletsError("REQUEST_INVALID", "read_resource requires uri");
  return { operation: "read_resource", uri: value.uri };
case "get_prompt":
  allowed(["prompt", "arguments"]);
  if (!value.prompt) throw new CapletsError("REQUEST_INVALID", "get_prompt requires prompt");
  if (value.arguments !== undefined && !isPlainObject(value.arguments)) {
    throw new CapletsError("REQUEST_INVALID", "get_prompt.arguments must be a JSON object");
  }
  return { operation: "get_prompt", prompt: value.prompt, arguments: value.arguments ?? {} };
case "complete":
  allowed(["ref", "argument"]);
  if (!value.ref) throw new CapletsError("REQUEST_INVALID", "complete requires ref");
  if (!value.argument) throw new CapletsError("REQUEST_INVALID", "complete requires argument");
  return { operation: "complete", ref: value.ref, argument: value.argument };
```

Extend `RequiredOperationRequest` with exact union members:

```ts
  | { operation: "list_resources" | "list_resource_templates" | "list_prompts"; limit?: number }
  | { operation: "search_resources" | "search_prompts"; query: string; limit?: number }
  | { operation: "read_resource"; uri: string }
  | { operation: "get_prompt"; prompt: string; arguments: Record<string, unknown> }
  | {
      operation: "complete";
      ref: { type: "prompt"; name: string } | { type: "resourceTemplate"; uri: string };
      argument: { name: string; value: string };
    };
```

- [ ] **Step 6: Run schema tests to verify green**

Run:

```sh
pnpm --filter @caplets/core test -- test/tools.test.ts
```

Expected: PASS for validation tests; handler tests may still fail for unimplemented MCP operation dispatch if tests were added beyond this task.

- [ ] **Step 7: Commit Task 1**

```sh
git add packages/core/src/generated-tool-input-schema.ts packages/core/src/tools.ts packages/core/src/errors.ts packages/core/test/tools.test.ts
git commit -m "feat(core): add backend-aware Caplet operation schemas"
```

---

### Task 2: Wire backend-specific schemas into MCP serving and native integrations

**Files:**

- Modify: `packages/core/src/capability-description.ts`
- Modify: `packages/core/src/serve/session.ts`
- Modify: `packages/core/src/native/service.ts`
- Modify: `packages/core/src/native/tools.ts`
- Modify: `packages/core/src/native/remote.ts`
- Modify: `packages/pi/src/index.ts`
- Modify: `packages/opencode/src/schema.ts`
- Modify: `packages/opencode/src/hooks.ts`
- Test: `packages/core/test/serve-session.test.ts`
- Test: `packages/core/test/native-remote.test.ts`
- Test: `packages/pi/test/pi.test.ts`
- Test: `packages/opencode/test/opencode.test.ts`

- [ ] **Step 1: Write failing MCP session schema tests**

Add to `packages/core/test/serve-session.test.ts`:

```ts
it("registers MCP Caplets with MCP-only operations and non-MCP Caplets without them", async () => {
  const { dir, configPath, projectConfigPath } = tempConfig({
    mcpServers: {
      docs: { name: "Docs", description: "Read docs.", command: "node" },
    },
    httpApis: {
      status: {
        name: "Status",
        description: "Check status.",
        baseUrl: "http://127.0.0.1:1",
        auth: { type: "none" },
        actions: { check: { method: "GET", path: "/status" } },
      },
    },
  });
  dirs.push(dir);
  const engine = new CapletsEngine({ configPath, projectConfigPath, watch: false });
  const server = mockServer();
  const session = new CapletsMcpSession(engine, { server });

  const docsOptions = server.registerTool.mock.calls.find(([name]) => name === "docs")?.[1];
  const statusOptions = server.registerTool.mock.calls.find(([name]) => name === "status")?.[1];
  expect(docsOptions.inputSchema.shape.operation.options).toContain("list_resources");
  expect(docsOptions.description).toContain("resources");
  expect(statusOptions.inputSchema.shape.operation.options).not.toContain("list_resources");
  expect(statusOptions.description).not.toContain("read_resource");

  await session.close();
  await engine.close();
});
```

Update `mockServer()` in the same file so `registerTool` records the options argument:

```ts
registerTool: vi.fn((name: string, _options: unknown) => {
```

- [ ] **Step 2: Write failing native adapter tests**

Add to `packages/core/test/native-remote.test.ts`:

```ts
it("preserves remote input schema metadata on native tools", async () => {
  const schema = {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["get_caplet", "list_resources"] },
    },
    required: ["operation"],
  };
  const fixture = client([
    { name: "docs", title: "Docs", description: "Docs", inputSchema: schema } as never,
  ]);
  const service = new RemoteNativeCapletsService({ client: fixture.api, pollIntervalMs: 60_000 });
  await service.reload();
  expect(service.listTools()[0]?.inputSchema).toEqual(schema);
  await service.close();
});
```

Add a Pi test near existing tool registration tests in `packages/pi/test/pi.test.ts`:

```ts
it("registers each Caplet with its native input schema", async () => {
  const schema = {
    type: "object",
    properties: { operation: { type: "string", enum: ["get_caplet", "list_resources"] } },
    required: ["operation"],
  };
  const service = mockService([
    {
      caplet: "docs",
      toolName: "caplets_docs",
      title: "Docs",
      description: "Docs",
      promptGuidance: [],
      inputSchema: schema,
    },
  ]);
  const pi = mockPi();
  await createCapletsPiExtension({ service })(pi);
  expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ parameters: schema }));
});
```

Add an OpenCode test near schema/tool tests in `packages/opencode/test/opencode.test.ts`:

```ts
it("builds OpenCode args from the Caplet operation set", async () => {
  const service = mockService([
    {
      caplet: "docs",
      toolName: "caplets_docs",
      title: "Docs",
      description: "Docs",
      promptGuidance: [],
      operationNames: ["get_caplet", "list_resources"],
    },
  ]);
  const hooks = await createCapletsOpenCodeHooks(service);
  expect(Object.keys(hooks.tool ?? {})).toEqual(["caplets_docs"]);
  expect(service.listTools()[0]?.operationNames).toEqual(["get_caplet", "list_resources"]);
});
```

- [ ] **Step 3: Run focused tests to verify red**

Run:

```sh
pnpm --filter @caplets/core test -- test/serve-session.test.ts test/native-remote.test.ts
pnpm --filter @caplets/pi test -- test/pi.test.ts
pnpm --filter @caplets/opencode test -- test/opencode.test.ts
```

Expected: FAIL because registered tools still use the global schema and native tools do not carry schema metadata.

- [ ] **Step 4: Update capability descriptions**

Change `packages/core/src/capability-description.ts`:

```ts
import type { CapletConfig } from "./config";

export function capabilityDescription(server: CapletConfig): string {
  return [
    `${server.name} Caplet.`,
    server.description,
    server.backend === "mcp"
      ? "Use get_caplet for details; use tools for actions, resources for readable context, prompts for reusable workflows, and complete for prompt/resource-template arguments."
      : "Use get_caplet for details when needed; use search_tools or list_tools to discover downstream operations.",
  ]
    .filter(Boolean)
    .join(" ");
}
```

- [ ] **Step 5: Register backend-specific MCP tool schemas**

In `packages/core/src/serve/session.ts`, import `generatedToolInputSchemaForCaplet` instead of `generatedToolInputSchema`. In both `tool.update()` and `registerTool()`, pass the backend-aware input schema:

```ts
inputSchema: generatedToolInputSchemaForCaplet(caplet),
```

For `tool.update`, include the field with title, description, callback, and enabled:

```ts
tool.update({
  title: caplet.name,
  description: capabilityDescription(caplet),
  inputSchema: generatedToolInputSchemaForCaplet(caplet),
  callback: async (request) => this.handleTool(serverId, request),
  enabled: true,
});
```

- [ ] **Step 6: Add native schema fields**

Modify `NativeCapletTool` in `packages/core/src/native/service.ts`:

```ts
export type NativeCapletTool = {
  caplet: string;
  toolName: string;
  title: string;
  description: string;
  promptGuidance: string[];
  inputSchema: ReturnType<typeof generatedToolInputJsonSchemaForCaplet>;
  operationNames: string[];
};
```

Import schema helpers and populate local native tools:

```ts
import { generatedToolInputJsonSchemaForCaplet } from "../generated-tool-input-schema";

const inputSchema = generatedToolInputJsonSchemaForCaplet(caplet);
return {
  caplet: caplet.server,
  toolName,
  title: caplet.name,
  description: nativeCapletToolDescription(toolName, caplet),
  promptGuidance: nativeCapletPromptGuidance(toolName, caplet),
  inputSchema,
  operationNames: [...inputSchema.properties.operation.enum],
};
```

- [ ] **Step 7: Update native prompt guidance**

Modify `packages/core/src/native/tools.ts`:

```ts
export function nativeCapletsSystemGuidance(toolNames: string[]): string {
  const tools = toolNames.length > 0 ? toolNames.map((tool) => `- ${tool}`).join("\n") : "- none";
  return [
    "## Caplets Native Tools",
    "",
    "Caplets tools expose configured capability domains through progressive discovery.",
    "",
    "Available Caplets native tools:",
    tools,
    "",
    "Flow: get_caplet when the domain is unfamiliar; use search_tools/list_tools for actions; MCP-backed Caplets may also expose resources, prompts, and completions in their tool schema.",
    "Use fields on call_tool when a non-GraphQL downstream outputSchema allows selecting only needed structured paths.",
  ].join("\n");
}

export function nativeCapletPromptGuidance(toolName: string, caplet: CapletConfig): string[] {
  return caplet.backend === "mcp"
    ? [
        `Use ${toolName} for the ${caplet.name} Caplet capability domain.`,
        "Prefer resources for readable context, prompts for reusable workflows, and tools for actions.",
      ]
    : [`Use ${toolName} for the ${caplet.name} Caplet capability domain.`];
}
```

- [ ] **Step 8: Preserve schema metadata for remote native tools**

Modify `packages/core/src/native/remote.ts`:

```ts
export type RemoteCapletsTool = {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema?: unknown;
};
```

In `createSdkRemoteCapletsClient().listTools()` include `inputSchema`:

```ts
...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
```

In `remoteToolToNativeTool`, derive operation names:

```ts
const inputSchema = isPlainObject(tool.inputSchema)
  ? tool.inputSchema
  : generatedToolInputJsonSchemaForCaplet({ backend: "tool" });
const operationNames = operationNamesFromSchema(inputSchema);
```

Add helpers:

```ts
function operationNamesFromSchema(schema: Record<string, unknown>): string[] {
  const properties = schema.properties;
  if (!isPlainObject(properties)) return [...operations];
  const operation = properties.operation;
  if (!isPlainObject(operation) || !Array.isArray(operation.enum)) return [...operations];
  return operation.enum.filter((value): value is string => typeof value === "string");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
```

Return `inputSchema` and `operationNames` from `remoteToolToNativeTool`.

- [ ] **Step 9: Use native schemas in Pi and OpenCode**

In `packages/pi/src/index.ts`, remove the import of `generatedToolInputJsonSchema` and change `createPiTool`:

```ts
parameters: caplet.inputSchema as ToolDefinition["parameters"],
```

In `packages/opencode/src/schema.ts`, replace the fixed schema helper with:

```ts
import { tool } from "@opencode-ai/plugin";
import { operations } from "@caplets/core/generated-tool-input-schema";

export function capletsOpenCodeArgs(operationNames: string[] = [...operations]) {
  const enumValues = operationNames.length > 0 ? operationNames : [...operations];
  return {
    operation: tool.schema.enum(enumValues as [string, ...string[]]),
    query: tool.schema.string().optional(),
    limit: tool.schema.number().int().positive().optional(),
    tool: tool.schema.string().optional(),
    arguments: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional(),
    fields: tool.schema.array(tool.schema.string().min(1)).min(1).optional(),
    uri: tool.schema.string().optional(),
    prompt: tool.schema.string().optional(),
    ref: tool.schema.unknown().optional(),
    argument: tool.schema.unknown().optional(),
  };
}
```

In `packages/opencode/src/hooks.ts`, call:

```ts
args: capletsOpenCodeArgs(caplet.operationNames),
```

- [ ] **Step 10: Run native and session tests to verify green**

Run:

```sh
pnpm --filter @caplets/core test -- test/serve-session.test.ts test/native-remote.test.ts
pnpm --filter @caplets/pi test -- test/pi.test.ts
pnpm --filter @caplets/opencode test -- test/opencode.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit Task 2**

```sh
git add packages/core/src/capability-description.ts packages/core/src/serve/session.ts packages/core/src/native/service.ts packages/core/src/native/tools.ts packages/core/src/native/remote.ts packages/pi/src/index.ts packages/opencode/src/schema.ts packages/opencode/src/hooks.ts packages/core/test/serve-session.test.ts packages/core/test/native-remote.test.ts packages/pi/test/pi.test.ts packages/opencode/test/opencode.test.ts
git commit -m "feat(core): expose backend-specific Caplet schemas"
```

---

### Task 3: Add MCP resources, prompts, completions, and cache handling to DownstreamManager

**Files:**

- Modify: `packages/core/src/downstream.ts`
- Modify: `packages/core/test/fixtures/stdio-server.ts`
- Test: `packages/core/test/downstream.test.ts`

- [ ] **Step 1: Extend the stdio MCP fixture**

Modify `packages/core/test/fixtures/stdio-server.ts` to import `ResourceTemplate` and register resource/prompt capabilities:

```ts
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp";
```

Append before `await server.connect(...)`:

```ts
server.registerResource(
  "README",
  "file:///repo/README.md",
  { description: "Project README", mimeType: "text/markdown" },
  async (uri) => ({
    contents: [{ uri: uri.href, text: "# Fixture README", mimeType: "text/markdown" }],
  }),
);

server.registerResource(
  "Repository file",
  new ResourceTemplate("file:///repo/{path}", {
    list: async () => ({
      resources: [
        { uri: "file:///repo/src/index.ts", name: "src/index.ts", mimeType: "text/typescript" },
      ],
    }),
    complete: {
      path: (value) => ["README.md", "src/index.ts"].filter((path) => path.startsWith(value)),
    },
  }),
  { description: "Read a repository file", mimeType: "text/plain" },
  async (uri) => ({
    contents: [{ uri: uri.href, text: `content:${uri.href}`, mimeType: "text/plain" }],
  }),
);

server.registerPrompt(
  "review_issue",
  {
    description: "Review an issue before implementation.",
    argsSchema: { issueId: z.string().describe("Issue ID") },
  },
  ({ issueId }) => ({
    messages: [{ role: "user", content: { type: "text", text: `Review ${issueId}` } }],
  }),
);
```

- [ ] **Step 2: Write failing downstream tests**

Add to `packages/core/test/downstream.test.ts`:

```ts
it("lists, searches, and reads MCP resources and templates", async () => {
  const fixture = join(fixturesDir, "stdio-server.ts");
  const config = parseConfig({
    mcpServers: {
      fixture: {
        name: "Fixture",
        description: "Fixture server.",
        command: "pnpm",
        args: ["exec", "tsx", fixture],
      },
    },
  });
  const manager = new DownstreamManager(new ServerRegistry(config));
  const server = config.mcpServers.fixture!;
  try {
    const resources = await manager.listResources(server);
    expect(resources.map((resource) => resource.uri)).toContain("file:///repo/README.md");
    expect(manager.searchResources(server, resources, "readme", 10)).toEqual([
      expect.objectContaining({ kind: "resource", uri: "file:///repo/README.md" }),
    ]);

    const templates = await manager.listResourceTemplates(server);
    expect(templates).toEqual([expect.objectContaining({ uriTemplate: "file:///repo/{path}" })]);

    const read = await manager.readResource(server, "file:///repo/README.md");
    expect(read).toMatchObject({
      contents: [{ uri: "file:///repo/README.md", text: "# Fixture README" }],
    });
  } finally {
    await manager.close();
  }
});

it("lists, searches, gets prompts, and forwards completions", async () => {
  const fixture = join(fixturesDir, "stdio-server.ts");
  const config = parseConfig({
    mcpServers: {
      fixture: {
        name: "Fixture",
        description: "Fixture server.",
        command: "pnpm",
        args: ["exec", "tsx", fixture],
      },
    },
  });
  const manager = new DownstreamManager(new ServerRegistry(config));
  const server = config.mcpServers.fixture!;
  try {
    const prompts = await manager.listPrompts(server);
    expect(prompts).toEqual([expect.objectContaining({ name: "review_issue" })]);
    expect(manager.searchPrompts(server, prompts, "issue", 10)).toEqual([
      expect.objectContaining({ prompt: "review_issue" }),
    ]);

    const prompt = await manager.getPrompt(server, "review_issue", { issueId: "CAP-123" });
    expect(prompt).toMatchObject({
      messages: [{ role: "user", content: { text: "Review CAP-123" } }],
    });

    const completion = await manager.complete(server, {
      ref: { type: "resourceTemplate", uri: "file:///repo/{path}" },
      argument: { name: "path", value: "src/" },
    });
    expect(completion).toMatchObject({ completion: { values: ["src/index.ts"] } });
  } finally {
    await manager.close();
  }
});

it("returns UNSUPPORTED_CAPABILITY when the server does not advertise resources", async () => {
  const config = parseConfig({
    mcpServers: { empty: { name: "Empty", description: "No resources.", command: "node" } },
  });
  const server = config.mcpServers.empty!;
  const manager = new DownstreamManager(new ServerRegistry(config));
  vi.spyOn(manager as never, "connect").mockResolvedValue({
    client: { getServerCapabilities: () => ({ tools: {} }) },
  } as never);
  await expect(manager.listResources(server)).rejects.toMatchObject({
    code: "UNSUPPORTED_CAPABILITY",
  });
});
```

- [ ] **Step 3: Run downstream tests to verify red**

Run:

```sh
pnpm --filter @caplets/core test -- test/downstream.test.ts
```

Expected: FAIL because `DownstreamManager` has no resource/prompt/completion methods.

- [ ] **Step 4: Add MCP imports, cache fields, and compact types**

Modify `packages/core/src/downstream.ts` imports:

```ts
import {
  CompatibilityCallToolResultSchema,
  CompleteResultSchema,
  type CompleteRequestParams,
  ListPromptsResultSchema,
  ListResourceTemplatesResultSchema,
  ListResourcesResultSchema,
  PromptListChangedNotificationSchema,
  type Prompt,
  ReadResourceResultSchema,
  ResourceListChangedNotificationSchema,
  type Resource,
  type ResourceTemplate as McpResourceTemplate,
  ToolListChangedNotificationSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types";
```

Extend `ManagedConnection`:

```ts
  resources?: Resource[];
  resourcesFetchedAt?: number;
  resourceTemplates?: McpResourceTemplate[];
  resourceTemplatesFetchedAt?: number;
  prompts?: Prompt[];
  promptsFetchedAt?: number;
```

Add compact types near `CompactTool`:

```ts
export type CompactResource = {
  id: string;
  kind: "resource";
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  size?: number;
};
export type CompactResourceTemplate = {
  id: string;
  kind: "resourceTemplate";
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
};
export type CompactPrompt = {
  id: string;
  prompt: string;
  description?: string;
  arguments?: Prompt["arguments"];
};
```

- [ ] **Step 5: Add notification-based invalidation**

Inside `connect()` before `await client.connect(...)`, register handlers:

```ts
client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
  connection.tools = undefined;
  connection.toolsFetchedAt = undefined;
});
client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
  connection.resources = undefined;
  connection.resourcesFetchedAt = undefined;
  connection.resourceTemplates = undefined;
  connection.resourceTemplatesFetchedAt = undefined;
});
client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
  connection.prompts = undefined;
  connection.promptsFetchedAt = undefined;
});
```

- [ ] **Step 6: Add capability assertion helpers**

Add helpers in `DownstreamManager`:

```ts
private async assertCapability(server: CapletServerConfig, capability: "resources" | "prompts" | "completions"): Promise<ManagedConnection> {
  const connection = await this.connect(server);
  const capabilities = connection.client.getServerCapabilities();
  if (!capabilities?.[capability]) {
    throw new CapletsError(
      "UNSUPPORTED_CAPABILITY",
      `${server.server} does not advertise MCP ${capability}`,
      { server: server.server, capability },
    );
  }
  return connection;
}

private isCacheFresh(fetchedAt: number | undefined, ttlMs: number): boolean {
  return fetchedAt !== undefined && ttlMs > 0 && Date.now() - fetchedAt <= ttlMs;
}
```

- [ ] **Step 7: Implement list/read/get/complete methods**

Add public methods to `DownstreamManager`:

```ts
async listResources(server: CapletServerConfig, force = false): Promise<Resource[]> {
  const connection = await this.assertCapability(server, "resources");
  if (!force && connection.resources && this.isCacheFresh(connection.resourcesFetchedAt, server.toolCacheTtlMs)) {
    return connection.resources;
  }
  const resources: Resource[] = [];
  let cursor: string | undefined;
  do {
    const result = await connection.client.listResources(cursor ? { cursor } : undefined, { timeout: server.startupTimeoutMs });
    resources.push(...(result.resources ?? []));
    cursor = result.nextCursor;
  } while (cursor);
  connection.resources = resources;
  connection.resourcesFetchedAt = Date.now();
  return resources;
}

async listResourceTemplates(server: CapletServerConfig, force = false): Promise<McpResourceTemplate[]> {
  const connection = await this.assertCapability(server, "resources");
  if (!force && connection.resourceTemplates && this.isCacheFresh(connection.resourceTemplatesFetchedAt, server.toolCacheTtlMs)) {
    return connection.resourceTemplates;
  }
  const templates: McpResourceTemplate[] = [];
  let cursor: string | undefined;
  do {
    const result = await connection.client.listResourceTemplates(cursor ? { cursor } : undefined, { timeout: server.startupTimeoutMs });
    templates.push(...(result.resourceTemplates ?? []));
    cursor = result.nextCursor;
  } while (cursor);
  connection.resourceTemplates = templates;
  connection.resourceTemplatesFetchedAt = Date.now();
  return templates;
}

async readResource(server: CapletServerConfig, uri: string) {
  const connection = await this.assertCapability(server, "resources");
  try {
    return await connection.client.readResource({ uri }, { timeout: server.callTimeoutMs });
  } catch (error) {
    throw new CapletsError("DOWNSTREAM_RESOURCE_ERROR", `Downstream resource read failed for ${server.server}/${uri}`, toSafeError(error));
  }
}

async listPrompts(server: CapletServerConfig, force = false): Promise<Prompt[]> {
  const connection = await this.assertCapability(server, "prompts");
  if (!force && connection.prompts && this.isCacheFresh(connection.promptsFetchedAt, server.toolCacheTtlMs)) {
    return connection.prompts;
  }
  const prompts: Prompt[] = [];
  let cursor: string | undefined;
  do {
    const result = await connection.client.listPrompts(cursor ? { cursor } : undefined, { timeout: server.startupTimeoutMs });
    prompts.push(...(result.prompts ?? []));
    cursor = result.nextCursor;
  } while (cursor);
  connection.prompts = prompts;
  connection.promptsFetchedAt = Date.now();
  return prompts;
}

async getPrompt(server: CapletServerConfig, promptName: string, args: Record<string, unknown>) {
  const prompts = await this.listPrompts(server);
  if (!prompts.some((prompt) => prompt.name === promptName)) {
    throw new CapletsError("PROMPT_NOT_FOUND", `Prompt ${promptName} was not found on ${server.server}`);
  }
  const connection = await this.assertCapability(server, "prompts");
  try {
    return await connection.client.getPrompt({ name: promptName, arguments: stringifyPromptArgs(args) }, { timeout: server.callTimeoutMs });
  } catch (error) {
    throw new CapletsError("DOWNSTREAM_PROMPT_ERROR", `Downstream prompt failed for ${server.server}/${promptName}`, toSafeError(error));
  }
}

async complete(server: CapletServerConfig, request: { ref: { type: "prompt"; name: string } | { type: "resourceTemplate"; uri: string }; argument: { name: string; value: string } }) {
  const connection = await this.assertCapability(server, "completions");
  const params: CompleteRequestParams = {
    ref: request.ref.type === "prompt" ? { type: "ref/prompt", name: request.ref.name } : { type: "ref/resource", uri: request.ref.uri },
    argument: request.argument,
  };
  try {
    return await connection.client.complete(params, { timeout: server.callTimeoutMs });
  } catch (error) {
    throw new CapletsError("DOWNSTREAM_COMPLETION_ERROR", `Downstream completion failed for ${server.server}`, toSafeError(error));
  }
}
```

Add helper:

```ts
function stringifyPromptArgs(args: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
}
```

- [ ] **Step 8: Add compact and search helpers**

Add methods:

```ts
compactResource(server: CapletServerConfig, resource: Resource): CompactResource {
  return {
    id: server.server,
    kind: "resource",
    uri: resource.uri,
    ...(resource.name ? { name: resource.name } : {}),
    ...(resource.description ? { description: resource.description } : {}),
    ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
    ...(typeof resource.size === "number" ? { size: resource.size } : {}),
  };
}

compactResourceTemplate(server: CapletServerConfig, template: McpResourceTemplate): CompactResourceTemplate {
  return {
    id: server.server,
    kind: "resourceTemplate",
    uriTemplate: template.uriTemplate,
    ...(template.name ? { name: template.name } : {}),
    ...(template.description ? { description: template.description } : {}),
    ...(template.mimeType ? { mimeType: template.mimeType } : {}),
  };
}

compactPrompt(server: CapletServerConfig, prompt: Prompt): CompactPrompt {
  return {
    id: server.server,
    prompt: prompt.name,
    ...(prompt.description ? { description: prompt.description } : {}),
    ...(prompt.arguments ? { arguments: prompt.arguments } : {}),
  };
}

searchResources(server: CapletServerConfig, resources: Resource[], query: string, limit: number): Array<CompactResource | CompactResourceTemplate> {
  const lower = query.toLocaleLowerCase();
  return resources
    .map((resource) => this.compactResource(server, resource))
    .filter((resource) => [resource.uri, resource.name, resource.description, resource.mimeType].some((value) => value?.toLocaleLowerCase().includes(lower)))
    .slice(0, limit);
}

searchResourceTemplates(server: CapletServerConfig, templates: McpResourceTemplate[], query: string, limit: number): CompactResourceTemplate[] {
  const lower = query.toLocaleLowerCase();
  return templates
    .map((template) => this.compactResourceTemplate(server, template))
    .filter((template) => [template.uriTemplate, template.name, template.description, template.mimeType].some((value) => value?.toLocaleLowerCase().includes(lower)))
    .slice(0, limit);
}

searchPrompts(server: CapletServerConfig, prompts: Prompt[], query: string, limit: number): CompactPrompt[] {
  const lower = query.toLocaleLowerCase();
  return prompts
    .map((prompt) => this.compactPrompt(server, prompt))
    .filter((prompt) => [prompt.prompt, prompt.description, ...(prompt.arguments ?? []).flatMap((arg) => [arg.name, arg.description])].some((value) => value?.toLocaleLowerCase().includes(lower)))
    .slice(0, limit);
}
```

- [ ] **Step 9: Enrich `checkServer` with MCP capabilities and counts**

Change `checkServer` so it still refreshes tools and additionally reports best-effort counts:

```ts
const connection = await this.connect(server);
const capabilities = connection.client.getServerCapabilities() ?? {};
const tools = await this.refreshTools(server, true);
const result = {
  id: server.server,
  status: "available",
  capabilities: {
    tools: Boolean(capabilities.tools),
    resources: Boolean(capabilities.resources),
    resourceTemplates: Boolean(capabilities.resources),
    prompts: Boolean(capabilities.prompts),
    completions: Boolean(capabilities.completions),
  },
  toolCount: tools.length,
  elapsedMs: Date.now() - startedAt,
};
if (capabilities.resources) {
  Object.assign(result, {
    resourceCount: (await this.listResources(server, true)).length,
    resourceTemplateCount: (await this.listResourceTemplates(server, true)).length,
  });
}
if (capabilities.prompts) {
  Object.assign(result, { promptCount: (await this.listPrompts(server, true)).length });
}
return result;
```

- [ ] **Step 10: Run downstream tests to verify green**

Run:

```sh
pnpm --filter @caplets/core test -- test/downstream.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit Task 3**

```sh
git add packages/core/src/downstream.ts packages/core/test/fixtures/stdio-server.ts packages/core/test/downstream.test.ts
git commit -m "feat(core): add MCP resource and prompt forwarding"
```

---

### Task 4: Dispatch MCP operations through generated Caplet tools

**Files:**

- Modify: `packages/core/src/tools.ts`
- Test: `packages/core/test/tools.test.ts`

- [ ] **Step 1: Write failing handler tests**

Add to `packages/core/test/tools.test.ts` inside `describe("generated tool handlers", ...)`:

```ts
it("lists and searches MCP resources through handleServerTool", async () => {
  const downstream = {
    listResources: vi.fn().mockResolvedValue([
      {
        uri: "file:///repo/README.md",
        name: "README",
        description: "Docs",
        mimeType: "text/markdown",
      },
    ]),
    listResourceTemplates: vi
      .fn()
      .mockResolvedValue([
        { uriTemplate: "file:///repo/{path}", name: "File", description: "Repo file" },
      ]),
    compactResource: (_server: unknown, resource: unknown) => ({
      id: "alpha",
      kind: "resource",
      ...(resource as object),
    }),
    compactResourceTemplate: (_server: unknown, template: unknown) => ({
      id: "alpha",
      kind: "resourceTemplate",
      ...(template as object),
    }),
    searchResources: vi.fn((_server, resources) =>
      resources.map((resource: unknown) => ({
        id: "alpha",
        kind: "resource",
        ...(resource as object),
      })),
    ),
    searchResourceTemplates: vi.fn((_server, templates) =>
      templates.map((template: unknown) => ({
        id: "alpha",
        kind: "resourceTemplate",
        ...(template as object),
      })),
    ),
  } as unknown as DownstreamManager;

  const listed = (await handleServerTool(
    server,
    { operation: "list_resources" },
    registry,
    downstream,
  )) as any;
  expect(listed.structuredContent.result.resources).toEqual([
    expect.objectContaining({ uri: "file:///repo/README.md" }),
  ]);
  expect(listed.structuredContent.result.resourceTemplates).toEqual([
    expect.objectContaining({ uriTemplate: "file:///repo/{path}" }),
  ]);

  const searched = (await handleServerTool(
    server,
    { operation: "search_resources", query: "readme" },
    registry,
    downstream,
  )) as any;
  expect(searched.structuredContent.result.matches).toEqual([
    expect.objectContaining({ kind: "resource" }),
    expect.objectContaining({ kind: "resourceTemplate" }),
  ]);
});

it("reads resources, gets prompts, and completes with Caplets metadata", async () => {
  const downstream = {
    readResource: vi
      .fn()
      .mockResolvedValue({ contents: [{ uri: "file:///repo/README.md", text: "hello" }] }),
    getPrompt: vi.fn().mockResolvedValue({
      messages: [{ role: "user", content: { type: "text", text: "Review CAP-1" } }],
    }),
    complete: vi.fn().mockResolvedValue({ completion: { values: ["CAP-1"] } }),
  } as unknown as DownstreamManager;

  const read = (await handleServerTool(
    server,
    { operation: "read_resource", uri: "file:///repo/README.md" },
    registry,
    downstream,
  )) as any;
  expect(read.contents[0].text).toBe("hello");
  expect(read._meta.caplets).toMatchObject({
    operation: "read_resource",
    uri: "file:///repo/README.md",
  });

  const prompt = (await handleServerTool(
    server,
    { operation: "get_prompt", prompt: "review_issue", arguments: { issueId: "CAP-1" } },
    registry,
    downstream,
  )) as any;
  expect(prompt.messages[0].content.text).toBe("Review CAP-1");
  expect(prompt._meta.caplets).toMatchObject({ operation: "get_prompt", prompt: "review_issue" });

  const completion = (await handleServerTool(
    server,
    {
      operation: "complete",
      ref: { type: "prompt", name: "review_issue" },
      argument: { name: "issueId", value: "CAP-" },
    },
    registry,
    downstream,
  )) as any;
  expect(completion.completion.values).toEqual(["CAP-1"]);
  expect(completion._meta.caplets).toMatchObject({ operation: "complete" });
});
```

- [ ] **Step 2: Run handler tests to verify red**

Run:

```sh
pnpm --filter @caplets/core test -- test/tools.test.ts
```

Expected: FAIL because `handleServerTool` does not dispatch MCP-only operations and metadata type lacks `uri`/`prompt`.

- [ ] **Step 3: Extend metadata**

In `packages/core/src/tools.ts`, update `CapletResultMetadata`:

```ts
  uri?: string;
  prompt?: string;
```

Update `metadataFor` signature:

```ts
export function metadataFor(
  server: CapletConfig,
  operation: RequiredOperationRequest["operation"],
  target?: string | { tool?: string; uri?: string; prompt?: string },
  startedAt?: number,
): CapletResultMetadata {
  const targetFields = typeof target === "string" ? { tool: target } : (target ?? {});
  return {
    id: server.server,
    name: server.name,
    backend: server.backend,
    operation,
    ...targetFields,
    status: "ok",
    ...(startedAt === undefined ? {} : { elapsedMs: Date.now() - startedAt }),
  };
}
```

Add a generic annotation helper:

```ts
export function annotateMcpResult<T extends object>(result: T, metadata: CapletResultMetadata): T {
  const existingMeta = (result as { _meta?: unknown })._meta;
  return {
    ...result,
    _meta: {
      ...(isPlainObject(existingMeta) ? existingMeta : {}),
      caplets: metadata,
    },
  };
}
```

- [ ] **Step 4: Dispatch MCP-only operations**

Add switch cases in `handleServerTool` after `call_tool`:

```ts
case "list_resources": {
  const backend = mcpBackendFor(server, downstream);
  const resources = await backend.listResources(server as never);
  const templates = await backend.listResourceTemplates(server as never);
  const limit = parsed.limit ?? resources.length + templates.length;
  return jsonResult(
    {
      id: server.server,
      name: server.name,
      resources: resources.slice(0, limit).map((resource) => backend.compactResource(server as never, resource)),
      resourceTemplates: templates.slice(0, Math.max(0, limit - resources.length)).map((template) => backend.compactResourceTemplate(server as never, template)),
    },
    metadataFor(server, "list_resources", undefined, startedAt),
  );
}
case "search_resources": {
  const backend = mcpBackendFor(server, downstream);
  const resources = await backend.listResources(server as never);
  const templates = await backend.listResourceTemplates(server as never);
  const limit = parsed.limit ?? registry.config.options.defaultSearchLimit;
  const resourceMatches = backend.searchResources(server as never, resources, parsed.query, limit);
  const templateMatches = backend.searchResourceTemplates(server as never, templates, parsed.query, Math.max(0, limit - resourceMatches.length));
  return jsonResult({ id: server.server, name: server.name, query: parsed.query, matches: [...resourceMatches, ...templateMatches] }, metadataFor(server, "search_resources", undefined, startedAt));
}
case "list_resource_templates": {
  const backend = mcpBackendFor(server, downstream);
  const templates = await backend.listResourceTemplates(server as never);
  const limit = parsed.limit ?? templates.length;
  return jsonResult({ id: server.server, name: server.name, resourceTemplates: templates.slice(0, limit).map((template) => backend.compactResourceTemplate(server as never, template)) }, metadataFor(server, "list_resource_templates", undefined, startedAt));
}
case "read_resource": {
  const result = await mcpBackendFor(server, downstream).readResource(server as never, parsed.uri);
  return annotateMcpResult(result, metadataFor(server, "read_resource", { uri: parsed.uri }, startedAt));
}
case "list_prompts": {
  const backend = mcpBackendFor(server, downstream);
  const prompts = await backend.listPrompts(server as never);
  const limit = parsed.limit ?? prompts.length;
  return jsonResult({ id: server.server, name: server.name, prompts: prompts.slice(0, limit).map((prompt) => backend.compactPrompt(server as never, prompt)) }, metadataFor(server, "list_prompts", undefined, startedAt));
}
case "search_prompts": {
  const backend = mcpBackendFor(server, downstream);
  const prompts = await backend.listPrompts(server as never);
  const limit = parsed.limit ?? registry.config.options.defaultSearchLimit;
  return jsonResult({ id: server.server, name: server.name, query: parsed.query, prompts: backend.searchPrompts(server as never, prompts, parsed.query, limit) }, metadataFor(server, "search_prompts", undefined, startedAt));
}
case "get_prompt": {
  const result = await mcpBackendFor(server, downstream).getPrompt(server as never, parsed.prompt, parsed.arguments);
  return annotateMcpResult(result, metadataFor(server, "get_prompt", { prompt: parsed.prompt }, startedAt));
}
case "complete": {
  const result = await mcpBackendFor(server, downstream).complete(server as never, { ref: parsed.ref, argument: parsed.argument });
  return annotateMcpResult(result, metadataFor(server, "complete", undefined, startedAt));
}
```

Add helper near `backendFor`:

```ts
function mcpBackendFor(server: CapletConfig, downstream: DownstreamManager) {
  if (server.backend !== "mcp") {
    throw new CapletsError(
      "UNSUPPORTED_OPERATION",
      "MCP resource, prompt, and completion operations require an MCP-backed Caplet",
    );
  }
  return downstream;
}
```

- [ ] **Step 5: Run tools tests to verify green**

Run:

```sh
pnpm --filter @caplets/core test -- test/tools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```sh
git add packages/core/src/tools.ts packages/core/test/tools.test.ts
git commit -m "feat(core): dispatch MCP resources and prompts"
```

---

### Task 5: Add CLI and remote-control operation support

**Files:**

- Modify: `packages/core/src/cli.ts`
- Modify: `packages/core/src/remote-control/types.ts`
- Modify: `packages/core/src/remote-control/dispatch.ts`
- Test: `packages/core/test/cli.test.ts`
- Test: `packages/core/test/cli-remote.test.ts`
- Test: `packages/core/test/remote-control-dispatch.test.ts`

- [ ] **Step 1: Write failing CLI routing tests**

Add to `packages/core/test/cli-remote.test.ts`:

```ts
it("routes read-resource through remote control", async () => {
  const requests: unknown[] = [];
  const out: string[] = [];
  const fetch = vi.fn(async (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    requests.push({ url: String(url), body: init?.body });
    return Response.json({
      ok: true,
      result: { contents: [{ uri: "file:///repo/README.md", text: "hello" }] },
    });
  });

  await runCli(["read-resource", "docs", "file:///repo/README.md", "--format", "json"], {
    env: { CAPLETS_MODE: "remote", CAPLETS_SERVER_URL: "http://127.0.0.1:5387/caplets" },
    fetch,
    writeOut: (value) => out.push(value),
  });

  expect(requests).toEqual([
    {
      url: "http://127.0.0.1:5387/caplets/control",
      body: JSON.stringify({
        command: "read_resource",
        arguments: {
          caplet: "docs",
          request: { operation: "read_resource", uri: "file:///repo/README.md" },
        },
      }),
    },
  ]);
  expect(JSON.parse(out.join(""))).toEqual({
    contents: [{ uri: "file:///repo/README.md", text: "hello" }],
  });
});
```

Add to `packages/core/test/remote-control-dispatch.test.ts`:

```ts
it("accepts new MCP engine commands through remote dispatch", async () => {
  const context = testContext({
    mcpServers: { docs: { name: "Docs", description: "Docs.", command: "node" } },
  });
  const response = await dispatchRemoteCliRequest(
    {
      command: "list_resources",
      arguments: { caplet: "docs", request: { operation: "list_resources" } },
    },
    context,
  );
  expect(response).toMatchObject({
    ok: false,
    error: { code: expect.stringMatching(/SERVER_|UNSUPPORTED_|DOWNSTREAM_/u) },
  });
});
```

- [ ] **Step 2: Write failing local CLI command tests**

Add to `packages/core/test/cli.test.ts`:

```ts
it("prints help with MCP resource and prompt commands", async () => {
  const out: string[] = [];
  await runCli(["--help"], {
    writeOut: (value) => out.push(value),
    writeErr: (value) => out.push(value),
  });
  const text = out.join("");
  expect(text).toContain("list-resources");
  expect(text).toContain("read-resource");
  expect(text).toContain("list-prompts");
  expect(text).toContain("get-prompt");
  expect(text).toContain("complete");
});
```

- [ ] **Step 3: Run CLI tests to verify red**

Run:

```sh
pnpm --filter @caplets/core test -- test/cli.test.ts test/cli-remote.test.ts test/remote-control-dispatch.test.ts
```

Expected: FAIL because commands and remote command names do not exist.

- [ ] **Step 4: Extend remote-control command types and dispatch set**

In `packages/core/src/remote-control/types.ts`, add these to `RemoteCliCommand` after `call_tool`:

```ts
  | "list_resources"
  | "search_resources"
  | "list_resource_templates"
  | "read_resource"
  | "list_prompts"
  | "search_prompts"
  | "get_prompt"
  | "complete"
```

In `packages/core/src/remote-control/dispatch.ts`, add the same strings to `ENGINE_COMMANDS`.

- [ ] **Step 5: Route new operations from CLI remote mode**

In `packages/core/src/cli.ts`, extend `remoteCommandForOperation` switch:

```ts
    case "list_resources":
    case "search_resources":
    case "list_resource_templates":
    case "read_resource":
    case "list_prompts":
    case "search_prompts":
    case "get_prompt":
    case "complete":
      return operation;
```

- [ ] **Step 6: Add CLI commands**

In `packages/core/src/cli.ts`, add commands after `call-tool`:

```ts
program
  .command("list-resources")
  .description("List MCP resources for a configured MCP Caplet.")
  .argument("<caplet>")
  .option("--limit <n>", "maximum number of resources to return", parsePositiveInteger)
  .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
  .action(async (caplet: string, options: { limit?: number; format?: CliOutputFormat }) => {
    await executeOperation(
      caplet,
      options.limit === undefined
        ? { operation: "list_resources" }
        : { operation: "list_resources", limit: options.limit },
      {
        writeOut,
        writeErr,
        setExitCode,
        authDir: io.authDir,
        env,
        remote: remoteClientForCli(io),
        format: options.format,
      },
    );
  });

program
  .command("search-resources")
  .description("Search MCP resources and resource templates for a configured MCP Caplet.")
  .argument("<caplet>")
  .argument("<query>")
  .option("--limit <n>", "maximum number of matches to return", parsePositiveInteger)
  .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
  .action(
    async (
      caplet: string,
      query: string,
      options: { limit?: number; format?: CliOutputFormat },
    ) => {
      await executeOperation(
        caplet,
        options.limit === undefined
          ? { operation: "search_resources", query }
          : { operation: "search_resources", query, limit: options.limit },
        {
          writeOut,
          writeErr,
          setExitCode,
          authDir: io.authDir,
          env,
          remote: remoteClientForCli(io),
          format: options.format,
        },
      );
    },
  );

program
  .command("list-resource-templates")
  .description("List MCP resource templates for a configured MCP Caplet.")
  .argument("<caplet>")
  .option("--limit <n>", "maximum number of templates to return", parsePositiveInteger)
  .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
  .action(async (caplet: string, options: { limit?: number; format?: CliOutputFormat }) => {
    await executeOperation(
      caplet,
      options.limit === undefined
        ? { operation: "list_resource_templates" }
        : { operation: "list_resource_templates", limit: options.limit },
      {
        writeOut,
        writeErr,
        setExitCode,
        authDir: io.authDir,
        env,
        remote: remoteClientForCli(io),
        format: options.format,
      },
    );
  });

program
  .command("read-resource")
  .description("Read one MCP resource by URI.")
  .argument("<caplet>")
  .argument("<uri>")
  .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
  .action(async (caplet: string, uri: string, options: { format?: CliOutputFormat }) => {
    await executeOperation(
      caplet,
      { operation: "read_resource", uri },
      {
        writeOut,
        writeErr,
        setExitCode,
        authDir: io.authDir,
        env,
        remote: remoteClientForCli(io),
        format: options.format,
      },
    );
  });

program
  .command("list-prompts")
  .description("List MCP prompts for a configured MCP Caplet.")
  .argument("<caplet>")
  .option("--limit <n>", "maximum number of prompts to return", parsePositiveInteger)
  .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
  .action(async (caplet: string, options: { limit?: number; format?: CliOutputFormat }) => {
    await executeOperation(
      caplet,
      options.limit === undefined
        ? { operation: "list_prompts" }
        : { operation: "list_prompts", limit: options.limit },
      {
        writeOut,
        writeErr,
        setExitCode,
        authDir: io.authDir,
        env,
        remote: remoteClientForCli(io),
        format: options.format,
      },
    );
  });

program
  .command("search-prompts")
  .description("Search MCP prompts for a configured MCP Caplet.")
  .argument("<caplet>")
  .argument("<query>")
  .option("--limit <n>", "maximum number of prompts to return", parsePositiveInteger)
  .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
  .action(
    async (
      caplet: string,
      query: string,
      options: { limit?: number; format?: CliOutputFormat },
    ) => {
      await executeOperation(
        caplet,
        options.limit === undefined
          ? { operation: "search_prompts", query }
          : { operation: "search_prompts", query, limit: options.limit },
        {
          writeOut,
          writeErr,
          setExitCode,
          authDir: io.authDir,
          env,
          remote: remoteClientForCli(io),
          format: options.format,
        },
      );
    },
  );

program
  .command("get-prompt")
  .description("Get one MCP prompt by name.")
  .argument("<caplet.prompt>", "qualified target, split on the first dot")
  .option("--args <json-object>", "JSON object of prompt arguments")
  .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
  .action(async (target: string, options: { args?: string; format?: CliOutputFormat }) => {
    const { caplet, tool: prompt } = parseQualifiedTarget(target);
    await executeOperation(
      caplet,
      {
        operation: "get_prompt",
        prompt,
        arguments: parseJsonObjectOption(options.args, "get-prompt --args"),
      },
      {
        writeOut,
        writeErr,
        setExitCode,
        authDir: io.authDir,
        env,
        remote: remoteClientForCli(io),
        format: options.format,
      },
    );
  });

program
  .command("complete")
  .description("Complete an MCP prompt or resource-template argument.")
  .argument("<caplet>")
  .requiredOption("--argument <name>", "argument name")
  .option("--value <value>", "argument prefix", "")
  .option("--prompt <name>", "prompt name to complete")
  .option("--resource-template <uri-template>", "resource template URI to complete")
  .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
  .action(
    async (
      caplet: string,
      options: {
        argument: string;
        value: string;
        prompt?: string;
        resourceTemplate?: string;
        format?: CliOutputFormat;
      },
    ) => {
      const ref = completionRefFromOptions(options);
      await executeOperation(
        caplet,
        { operation: "complete", ref, argument: { name: options.argument, value: options.value } },
        {
          writeOut,
          writeErr,
          setExitCode,
          authDir: io.authDir,
          env,
          remote: remoteClientForCli(io),
          format: options.format,
        },
      );
    },
  );
```

Add helpers:

```ts
function parseJsonObjectOption(value: string | undefined, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new CapletsError("REQUEST_INVALID", `${label} must be valid JSON`, error);
  }
  if (!isPlainObject(parsed)) {
    throw new CapletsError("REQUEST_INVALID", `${label} must be a JSON object`);
  }
  return parsed;
}

function completionRefFromOptions(options: { prompt?: string; resourceTemplate?: string }) {
  if (options.prompt && options.resourceTemplate) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "complete accepts either --prompt or --resource-template, not both",
    );
  }
  if (options.prompt) return { type: "prompt", name: options.prompt };
  if (options.resourceTemplate) return { type: "resourceTemplate", uri: options.resourceTemplate };
  throw new CapletsError("REQUEST_INVALID", "complete requires --prompt or --resource-template");
}
```

- [ ] **Step 7: Add CLI human summaries**

Extend `markdownSummaryForOperation` and `plainSummaryForOperation` with cases for the new operations. Use these concrete summaries:

```ts
case "list_resources":
case "search_resources": {
  const resources = Array.isArray(payload.resources) ? payload.resources : [];
  const templates = Array.isArray(payload.resourceTemplates) ? payload.resourceTemplates : [];
  const matches = Array.isArray(payload.matches) ? payload.matches : [...resources, ...templates];
  return [`## MCP resources for \`${id}\``, "", `${matches.length} item${matches.length === 1 ? "" : "s"} found.`, "", ...formatResourceLines(matches, "markdown")].join("\n");
}
case "list_resource_templates": {
  const templates = Array.isArray(payload.resourceTemplates) ? payload.resourceTemplates : [];
  return [`## MCP resource templates for \`${id}\``, "", ...formatResourceLines(templates, "markdown")].join("\n");
}
case "read_resource":
  return [`## Resource \`${String(request.uri ?? "") }\``, "", summarizeResourceRead(payload), "", "Use `--format json` to inspect all contents."].join("\n");
case "list_prompts":
case "search_prompts": {
  const prompts = Array.isArray(payload.prompts) ? payload.prompts : [];
  return [`## MCP prompts for \`${id}\``, "", ...formatPromptLines(prompts, "markdown")].join("\n");
}
case "get_prompt":
  return [`## Prompt \`${String(request.caplet)}.${String(request.prompt)}\``, "", summarizePromptResult(payload), "", "Use `--format json` to inspect all messages."].join("\n");
case "complete":
  return [`## Completion for \`${id}\``, "", summarizeCompletionResult(payload)].join("\n");
```

Add `formatResourceLines`, `formatPromptLines`, `summarizeResourceRead`, `summarizePromptResult`, and `summarizeCompletionResult` below `formatToolLines`; each should use `compactDescription` and `previewValue` already present in the file.

- [ ] **Step 8: Run CLI and remote-control tests to verify green**

Run:

```sh
pnpm --filter @caplets/core test -- test/cli.test.ts test/cli-remote.test.ts test/remote-control-dispatch.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 5**

```sh
git add packages/core/src/cli.ts packages/core/src/remote-control/types.ts packages/core/src/remote-control/dispatch.ts packages/core/test/cli.test.ts packages/core/test/cli-remote.test.ts packages/core/test/remote-control-dispatch.test.ts
git commit -m "feat(cli): add MCP resource and prompt commands"
```

---

### Task 6: Update docs, changeset, and benchmarks if the surface changed

**Files:**

- Modify: `README.md`
- Modify: `packages/cli/README.md` if present
- Modify: `packages/pi/README.md`
- Modify: `packages/opencode/README.md`
- Create: `.changeset/mcp-resources-prompts.md`
- Modify: `docs/benchmarks/coding-agent.md` only if `pnpm benchmark:check` reports drift.

- [ ] **Step 1: Document the new MCP capability model**

In `README.md`, update the first description of scoped operations to mention MCP-only resources/prompts/completions:

```md
For MCP-backed Caplets, the scoped operation set also includes resource discovery/reading, prompt listing/rendering, resource-template discovery, and completion for prompt or template arguments. Non-MCP backends continue to expose only tool/action operations.
```

Add examples near the CLI examples:

```sh
caplets list-resources docs
caplets read-resource docs file:///repo/README.md
caplets list-prompts linear
caplets get-prompt linear.review_issue --args '{"issueId":"CAP-123"}'
caplets complete docs --resource-template 'file:///repo/{path}' --argument path --value src/
```

In package READMEs that exist, add one sentence:

```md
MCP-backed Caplets advertise resource, prompt, template, and completion operations in their generated schema; OpenAPI, GraphQL, HTTP, CLI, and Caplet-set backends remain tool/action-only.
```

- [ ] **Step 2: Add a changeset**

Create `.changeset/mcp-resources-prompts.md`:

```md
---
"@caplets/core": minor
"caplets": minor
"@caplets/pi": minor
"@caplets/opencode": minor
---

Expose MCP resources, resource templates, prompts, and completions through MCP-backed Caplets while keeping non-MCP backend schemas tool-only.
```

- [ ] **Step 3: Run formatting and benchmark check**

Run:

```sh
pnpm format:check
pnpm benchmark:check
```

Expected: PASS, or `pnpm benchmark:check` fails only because `docs/benchmarks/coding-agent.md` needs regeneration.

- [ ] **Step 4: Regenerate benchmark docs only on benchmark drift**

If Step 3 reports benchmark documentation drift, run:

```sh
pnpm benchmark
pnpm benchmark:check
```

Expected: PASS and `docs/benchmarks/coding-agent.md` is modified.

- [ ] **Step 5: Commit Task 6**

```sh
git add README.md packages/core/README.md packages/cli/README.md packages/pi/README.md packages/opencode/README.md .changeset docs/benchmarks/coding-agent.md
git commit -m "docs: describe MCP resource and prompt support"
```

If a listed README or benchmark file does not exist or was not modified, omit that path from `git add`.

---

### Task 7: Full verification and cleanup

**Files:**

- No planned source edits unless verification exposes a failure.

- [ ] **Step 1: Run focused tests**

Run:

```sh
pnpm --filter @caplets/core test -- test/tools.test.ts test/downstream.test.ts test/serve-session.test.ts test/cli.test.ts test/cli-remote.test.ts test/remote-control-dispatch.test.ts test/native-remote.test.ts
pnpm --filter @caplets/pi test -- test/pi.test.ts
pnpm --filter @caplets/opencode test -- test/opencode.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```sh
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run the full repository gate**

Run:

```sh
pnpm verify
```

Expected: PASS. This runs format, lint, typecheck, schema check, tests, benchmark check, and build.

- [ ] **Step 4: Commit verification fixes if any were required**

If Step 1, 2, or 3 required source fixes, inspect the changed files and commit only the verification fixes:

```sh
git status --short
git add packages/core/src packages/core/test packages/pi/src packages/pi/test packages/opencode/src packages/opencode/test README.md packages/cli/README.md packages/pi/README.md packages/opencode/README.md .changeset docs/benchmarks/coding-agent.md
git commit -m "fix: stabilize MCP resource and prompt support"
```

If no files changed after verification, do not create a commit. If `git status --short` shows unrelated files, do not add them.

- [ ] **Step 5: Report final status**

Collect:

```sh
git status --short
git log --oneline -5
```

Expected: only unrelated local files remain unstaged; implementation commits are present.

---

## Self-review checklist

- Spec coverage:
  - Backend-aware schemas: Task 1 and Task 2.
  - MCP resource/template list, search, and read: Task 3 and Task 4.
  - MCP prompt list, search, and get: Task 3 and Task 4.
  - MCP completion: Task 3 and Task 4.
  - Non-MCP backends do not advertise MCP operations: Task 1 and Task 2.
  - CLI and remote-control support: Task 5.
  - Native integration support: Task 2.
  - Docs and changeset: Task 6.
  - Verification: Task 7.
- Placeholder scan: no placeholder sections are intentionally left for the implementer.
- Type consistency:
  - User-facing completion refs use `{ type: "prompt", name }` and `{ type: "resourceTemplate", uri }`.
  - Downstream MCP SDK refs are converted to `{ type: "ref/prompt", name }` and `{ type: "ref/resource", uri }` in `DownstreamManager.complete`.
  - `operationNames` come from `inputSchema.properties.operation.enum`.
  - Remote-control commands exactly match operation names for engine-routed operations.
