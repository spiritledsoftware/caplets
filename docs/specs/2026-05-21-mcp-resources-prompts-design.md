# MCP Resources and Prompts in Caplets

## Status

Approved design direction from brainstorming. Implementation plan not yet written.

## Goal

Expand MCP-backed Caplets from a tool-only gateway into an MCP capability gateway that lets agents discover and use downstream tools, resources, resource templates, prompts, and completions while preserving Caplets' progressive-disclosure UX.

The design must keep non-MCP backends clean: OpenAPI, GraphQL, HTTP, CLI, and non-MCP Caplet set surfaces must not advertise MCP-specific resource, prompt, or completion operations.

## Non-goals

- Do not flatten downstream resources, prompts, or templates into Caplets' top-level `tools/list` response.
- Do not expose MCP-specific operations on OpenAPI, GraphQL, HTTP, or CLI-backed Caplets.
- Do not convert OpenAPI, GraphQL, HTTP, or CLI actions into synthetic MCP resources or prompts in this iteration.
- Do not implement a faithful raw MCP proxy mode in this iteration.
- Do not subscribe to resource content updates in the first implementation unless needed by the SDK cache-invalidation mechanism.
- Do not add roots, sampling, elicitation, logging, or task support in this iteration.

## Current state

Caplets currently exposes one generated top-level tool per enabled Caplet. Each generated tool uses a shared input schema with these operations:

- `get_caplet`
- `check_backend`
- `list_tools`
- `search_tools`
- `get_tool`
- `call_tool`

For MCP-backed Caplets, `DownstreamManager` connects through the MCP SDK and uses `listTools` and `callTool`. It caches only downstream tool metadata. It does not currently expose:

- `resources/list`
- `resources/templates/list`
- `resources/read`
- `prompts/list`
- `prompts/get`
- `completion/complete`
- downstream server instructions/version/capability metadata beyond what connection handling needs internally

## Design principles

1. **Progressive disclosure stays intact.** Caplets still exposes one top-level capability card per Caplet, not every downstream primitive.
2. **Schemas should teach the agent what is possible.** MCP-specific operations should appear only on MCP-backed Caplets.
3. **Downstream MCP remains the source of truth.** Caplets forwards resource, prompt, and completion semantics without inventing validation rules beyond request routing and strict wrapper-shape validation.
4. **Results should be preserved.** `read_resource`, `get_prompt`, and `complete` should return downstream-compatible result shapes with Caplets metadata added in `_meta.caplets`, mirroring `call_tool` behavior where practical.
5. **Capability absence should be explicit.** If an MCP server does not advertise resources, prompts, or completions, the corresponding operation returns a structured `UNSUPPORTED_CAPABILITY` error.

## Agent-facing operation surfaces

### Non-MCP-backed Caplets

OpenAPI, GraphQL, HTTP, CLI, and non-MCP Caplet surfaces keep the current operation set:

```ts
operation:
  | "get_caplet"
  | "check_backend"
  | "list_tools"
  | "search_tools"
  | "get_tool"
  | "call_tool";
```

Their generated input schema must not mention `list_resources`, `read_resource`, `list_prompts`, `get_prompt`, or `complete`.

### MCP-backed Caplets

MCP-backed Caplets expose the current tool operations plus MCP-native discovery and use operations:

```ts
operation:
  | "get_caplet"
  | "check_backend"
  | "list_tools"
  | "search_tools"
  | "get_tool"
  | "call_tool"
  | "list_resources"
  | "search_resources"
  | "list_resource_templates"
  | "read_resource"
  | "list_prompts"
  | "search_prompts"
  | "get_prompt"
  | "complete";
```

The generated tool description should mention this broader MCP capability only for MCP-backed Caplets. Non-MCP descriptions should continue to use the existing tool/action wording.

## Request schema

The current universal schema should become backend-aware schema generation.

Common fields remain:

- `operation`: required enum, generated per backend.
- `query`: required for search operations only.
- `limit`: optional for list/search operations where accepted.
- `tool`: exact downstream tool name for `get_tool` and `call_tool`.
- `arguments`: JSON object for `call_tool` and `get_prompt` arguments.
- `fields`: optional field selection for `call_tool` where currently supported.

New MCP-only fields:

- `uri`: exact resource URI for `read_resource`.
- `prompt`: exact downstream prompt name for `get_prompt`.
- `ref`: completion reference for `complete`; either a prompt reference or resource-template reference.
- `argument`: completion argument object for `complete`, with `name` and `value`.

Validation rules:

- Request validation remains strict: operation-specific extra fields are rejected.
- `list_resources`, `list_resource_templates`, and `list_prompts` accept optional `limit` only.
- `search_resources` and `search_prompts` require `query` and accept optional `limit`.
- `read_resource` requires `uri`.
- `get_prompt` requires `prompt`; `arguments` is optional and defaults to `{}`.
- `complete` requires `ref` and `argument`.
- Search/list limits reuse `maxSearchLimit` and `defaultSearchLimit`.
- `fields` remains valid only for `call_tool`.

## Resource operations

### `list_resources`

Calls downstream `resources/list`, paginating as needed until the requested limit is satisfied or no cursor remains. Returns compact resource metadata:

```json
{
  "id": "docs",
  "name": "Docs",
  "resources": [
    {
      "id": "docs",
      "uri": "file:///repo/README.md",
      "name": "README",
      "description": "Project README",
      "mimeType": "text/markdown"
    }
  ],
  "nextCursor": "..."
}
```

If `limit` truncates a page before consuming all downstream items, Caplets may omit `nextCursor` unless it can safely preserve downstream cursor semantics. The first implementation should prefer fetching full pages and slicing only the final result set for deterministic agent output.

### `search_resources`

Searches listed resources and resource templates with deterministic case-insensitive lexical matching over:

- `uri`
- `name`
- `description`
- `mimeType`

The result should identify whether each match is a concrete resource or a template.

### `list_resource_templates`

Calls downstream `resources/templates/list` and returns compact template metadata:

```json
{
  "id": "docs",
  "name": "Docs",
  "resourceTemplates": [
    {
      "id": "docs",
      "uriTemplate": "file:///repo/{path}",
      "name": "Repository file",
      "description": "Read a file by repository path",
      "mimeType": "text/plain"
    }
  ]
}
```

### `read_resource`

Calls downstream `resources/read` with the exact URI and returns the downstream result contents without lossy transformation. Caplets adds `_meta.caplets` with server ID, backend, operation, URI, status, and elapsed timing.

## Prompt operations

### `list_prompts`

Calls downstream `prompts/list`, paginating as needed until the requested limit is satisfied or no cursor remains. Returns compact prompt metadata:

```json
{
  "id": "linear",
  "name": "Linear",
  "prompts": [
    {
      "id": "linear",
      "prompt": "review_issue",
      "description": "Review a Linear issue before implementation",
      "arguments": [{ "name": "issueId", "description": "Linear issue ID", "required": true }]
    }
  ]
}
```

### `search_prompts`

Searches listed prompts with deterministic case-insensitive lexical matching over:

- prompt name
- prompt description
- argument names
- argument descriptions

### `get_prompt`

Calls downstream `prompts/get` with exact prompt name and optional arguments. Returns downstream prompt messages without lossy transformation and adds `_meta.caplets` with server ID, backend, operation, prompt name, status, and elapsed timing.

## Completion operation

### `complete`

For MCP-backed Caplets whose downstream server advertises completions, Caplets forwards `completion/complete`.

Example prompt completion request:

```json
{
  "operation": "complete",
  "ref": { "type": "prompt", "name": "review_issue" },
  "argument": { "name": "issueId", "value": "CAP-" }
}
```

Example resource-template completion request:

```json
{
  "operation": "complete",
  "ref": { "type": "resourceTemplate", "uri": "file:///repo/{path}" },
  "argument": { "name": "path", "value": "src/" }
}
```

Caplets returns the downstream completion result unchanged except for `_meta.caplets` metadata.

## Capability discovery and `get_caplet`

`get_caplet` should remain cheap and must not start the downstream server. It can report configured backend type and static Caplets metadata only.

After a backend has been checked or used, Caplets may include last-known observed MCP capability metadata in registry status or operation results, but it must not make `get_caplet` perform live probing.

For MCP-backed Caplets, `check_backend` should connect and report observed capabilities:

```json
{
  "id": "docs",
  "status": "available",
  "capabilities": {
    "tools": true,
    "resources": true,
    "resourceTemplates": true,
    "prompts": true,
    "completions": true
  },
  "toolCount": 12,
  "resourceCount": 4,
  "resourceTemplateCount": 2,
  "promptCount": 3,
  "elapsedMs": 42
}
```

Counts are best-effort. If a capability exists but counting fails, `check_backend` should still report the capability and include safe structured error details for the failed count.

## Caching and invalidation

Extend managed MCP connections to cache each list independently:

- tools
- resources
- resource templates
- prompts

Each cache entry should track `fetchedAt` and use the existing `toolCacheTtlMs` initially. A later config option may rename this to `metadataCacheTtlMs`; this design intentionally avoids a config migration in the first implementation.

When the SDK exposes list-changed callbacks or notifications, wire them to invalidate the relevant cache:

- `notifications/resources/list_changed` invalidates resource and resource-template caches.
- `notifications/prompts/list_changed` invalidates prompt caches.
- Existing or future tool-list notifications invalidate the tool cache.

If the server does not advertise list-changed support, rely on TTL.

## Backend abstraction

The existing backend adapter shape should split common tool operations from MCP-only operations.

Suggested internal types:

```ts
type ToolBackend = {
  check(config: never): Promise<unknown>;
  listTools(config: never): Promise<Tool[]>;
  getTool(config: never, toolName: string): Promise<Tool>;
  callTool(config: never, toolName: string, args: Record<string, unknown>): Promise<unknown>;
  compact(config: never, tool: Tool): unknown;
  search(config: never, tools: Tool[], query: string, limit: number): unknown[];
};

type McpCapabilityBackend = ToolBackend & {
  listResources(config: never, limit?: number): Promise<unknown>;
  searchResources(config: never, query: string, limit: number): Promise<unknown>;
  listResourceTemplates(config: never, limit?: number): Promise<unknown>;
  readResource(config: never, uri: string): Promise<unknown>;
  listPrompts(config: never, limit?: number): Promise<unknown>;
  searchPrompts(config: never, query: string, limit: number): Promise<unknown>;
  getPrompt(config: never, prompt: string, args: Record<string, unknown>): Promise<unknown>;
  complete(config: never, request: CompletionRequest): Promise<unknown>;
};
```

Only MCP-backed Caplets should resolve to `McpCapabilityBackend` for MCP-specific operations. Non-MCP backends should not need stub implementations for resources or prompts.

## Error handling

New structured errors:

- `UNSUPPORTED_OPERATION`: operation is not valid for command-semantic CLI/remote-control routing or for a stale client using an operation that the generated Caplet schema no longer advertises.
- `UNSUPPORTED_CAPABILITY`: backend is MCP, but the downstream server does not advertise the requested MCP capability.
- `RESOURCE_NOT_FOUND`: downstream resource read reports an absent URI or Caplets cannot resolve a listed resource when resolution is required.
- `PROMPT_NOT_FOUND`: requested prompt name is absent from fresh-enough prompt metadata.
- `DOWNSTREAM_RESOURCE_ERROR`: downstream `resources/read` fails.
- `DOWNSTREAM_PROMPT_ERROR`: downstream `prompts/get` fails.
- `DOWNSTREAM_COMPLETION_ERROR`: downstream `completion/complete` fails.

Timeouts use the existing startup timeout for list/check style operations and call timeout for read/get/complete style operations unless implementation discovers a stronger SDK convention.

All errors must pass through existing safe-error redaction before being surfaced.

## CLI behavior

Add direct CLI operation commands mirroring the agent-facing API:

```sh
caplets list-resources docs
caplets list-resource-templates docs
caplets read-resource docs file:///repo/README.md
caplets list-prompts linear
caplets get-prompt linear.review_issue --args '{"issueId":"CAP-123"}'
caplets complete linear --prompt review_issue --argument issueId --value CAP-
```

Remote mode should route these commands through the existing command-semantic remote control API, preserving server-owned state and never exposing downstream auth secrets.

Non-MCP backends should fail fast with a clear message if a user explicitly invokes one of these MCP-specific CLI commands against them.

## Native integrations

Pi and OpenCode native integrations should receive backend-specific schemas just like MCP clients. A native tool generated for an MCP-backed Caplet includes MCP resource/prompt/completion operations; a native tool generated for a non-MCP Caplet does not.

Prompt guidance should nudge agents toward the right primitive:

- Use tools for actions and side effects.
- Use resources for readable context and artifacts.
- Use prompts for reusable downstream workflows or prompt templates.
- Use completions when filling prompt or resource-template arguments.

## Testing strategy

Add deterministic fixtures for MCP servers that expose:

- tools only
- resources only
- resource templates only
- prompts only
- completions only
- tools, resources, templates, prompts, and completions together
- advertised capability with failing downstream request
- no advertised capability for requested MCP operation

Regression coverage should verify:

- Non-MCP generated schemas do not include MCP-specific operations.
- MCP generated schemas include resource, prompt, template, and completion operations.
- Strict operation-specific validation rejects extra fields.
- Resource and prompt list/search output is compact and deterministic.
- `read_resource`, `get_prompt`, and `complete` preserve downstream result shape and add Caplets metadata.
- Unsupported downstream capabilities return `UNSUPPORTED_CAPABILITY`.
- Missing prompt/resource cases return structured errors without forwarding unsafe guesses.
- Caches refresh according to TTL and invalidate on list-changed notifications where available.
- CLI commands work locally and through remote mode.
- Initial Caplets `tools/list` remains one top-level tool per enabled Caplet.

## Documentation updates

Update:

- `README.md`: explain MCP-backed Caplets can expose tools, resources, prompts, and completions behind one capability card.
- CLI help and examples for resource/prompt/completion commands.
- Native integration README files for Pi and OpenCode schema differences.
- Benchmark documentation only if the serialized initial tool schema size materially changes.

## Rollout plan

1. Introduce backend-aware generated operation schemas while preserving current behavior for all backends.
2. Add MCP resource and prompt list/read/get support in `DownstreamManager`.
3. Add search and compact metadata helpers for resources, templates, and prompts.
4. Add completion forwarding.
5. Add CLI and remote-control operation support.
6. Update native integrations to consume backend-specific schemas and descriptions.
7. Update documentation and benchmark expectations if needed.
