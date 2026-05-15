# Native Agent Caplet Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native OpenCode and Pi Caplets extensions that expose Caplets as native agent tools with prompt guidance, without requiring agents to access Caplets through MCP.

**Architecture:** Factor the existing Caplets operation runtime into a reusable in-process service, then publish two separate workspace packages: `@caplets/opencode` and `@caplets/pi`. Each adapter snapshots configured Caplets at extension/plugin load, registers one prefixed native tool per Caplet (`caplets_<id>`), executes through the shared service, and injects system/prompt guidance through native prompt hooks rather than editing user config.

**Tech Stack:** TypeScript ESM, Node.js 22+, pnpm workspace, rolldown, Vitest, Zod, TypeBox for Pi schemas, `@opencode-ai/plugin`, `@earendil-works/pi-coding-agent`, existing Caplets backend managers.

---

## Decisions From Architecture Grill

- Native adapters register **one native tool per Caplet**, not one generic dispatch tool.
- Native adapters use a **shared in-process runtime library**, not a child `caplets` CLI process.
- OpenCode and Pi adapters are **separate npm packages** in the same repo workspace.
- Package names use the `@caplets/*` scope for non-CLI packages: `@caplets/opencode` and `@caplets/pi`.
- Native tool names are **prefixed** as `caplets_<capletId>` to avoid overriding built-in agent tools.
- Tool registration is **snapshot-at-load** for v1. New/removed Caplets require reloading the agent/plugin.
- Prompt guidance uses **existing Caplet metadata plus shared system guidance**. Do not add new Caplet frontmatter fields in v1.
- OpenCode prompt guidance must use plugin hooks. Do not edit user `opencode.json`.
- Pi prompt guidance should use `promptSnippet` and `promptGuidelines` on registered tools.

---

## Current Code Context

- `src/tools.ts` already owns the Caplets operation contract: `get_caplet`, `check_backend`, `check_mcp_server`, `list_tools`, `search_tools`, `get_tool`, and `call_tool`.
- `src/tools.ts` already delegates execution to `DownstreamManager`, `OpenApiManager`, `GraphQLManager`, `HttpActionManager`, and `CliToolsManager`.
- `src/runtime.ts` couples that operation handling to MCP registration through `McpServer.registerTool`.
- `src/registry.ts` already exposes safe Caplet summaries/details and `capabilityDescription`.
- `src/generated-tool-input-schema.mjs` already defines the operation schema and user-facing field descriptions.
- `benchmarks/lib/opencode-runner.mjs` and `benchmarks/lib/pi-runner.mjs` only exercise MCP modes today.

The smallest correct change is to extract the non-MCP execution path into a native service and make MCP runtime plus native adapters consume the same operation handler.

---

## Target File Structure

### Root Package

- Modify: `package.json`
  - Add workspace-aware scripts.
  - Add package exports for `caplets/native`.
  - Keep the existing `caplets` CLI bin unchanged.
- Create: `pnpm-workspace.yaml`
  - Include `.` and `packages/*`.
- Modify: `rolldown.config.ts`
  - Build both `src/index.ts` and `src/native.ts` as ESM outputs.
- Create: `src/native.ts`
  - Public native service export surface for adapter packages.
- Create: `src/native/service.ts`
  - Shared in-process Caplets service that owns registry/managers and calls `handleServerTool`.
- Create: `src/native/tools.ts`
  - Native tool naming, prompt text, schema shape, and result formatting helpers.
- Test: `test/native.test.ts`
  - Core native service behavior independent from OpenCode/Pi.

### OpenCode Adapter Package

- Create: `packages/caplets-opencode/package.json`
- Create: `packages/caplets-opencode/rolldown.config.ts`
- Create: `packages/caplets-opencode/tsconfig.json`
- Create: `packages/caplets-opencode/src/index.ts`
  - OpenCode plugin entrypoint.
- Create: `packages/caplets-opencode/src/schema.ts`
  - Zod/OpenCode tool schema adapter.
- Create: `packages/caplets-opencode/README.md`
  - Installation and config-free plugin usage.
- Test: `packages/caplets-opencode/test/opencode.test.ts`

### Pi Adapter Package

- Create: `packages/caplets-pi/package.json`
- Create: `packages/caplets-pi/rolldown.config.ts`
- Create: `packages/caplets-pi/tsconfig.json`
- Create: `packages/caplets-pi/src/index.ts`
  - Pi extension entrypoint.
- Create: `packages/caplets-pi/src/schema.ts`
  - TypeBox schema adapter.
- Create: `packages/caplets-pi/README.md`
  - Installation and extension usage.
- Test: `packages/caplets-pi/test/pi.test.ts`

### Documentation And Benchmarks

- Modify: `README.md`
  - Add native adapter section after MCP install/config docs.
- Modify: `docs/benchmarks/coding-agent.md`
  - Document that existing benchmark is MCP-mode only until native benchmark modes are added.
- Modify: `benchmarks/lib/opencode-runner.mjs`
  - Add `native-caplets` mode in a later task after adapter package exists.
- Modify: `benchmarks/lib/pi-runner.mjs`
  - Add `native-caplets` mode in a later task after adapter package exists.
- Modify: `test/benchmark.test.ts`
  - Assert native benchmark config generation shape.

---

## Public Native API

Add this API as `caplets/native` from the root `caplets` package.

```ts
export type NativeCapletsServiceOptions = {
  configPath?: string;
  projectConfigPath?: string;
  authDir?: string;
};

export type NativeCapletTool = {
  caplet: string;
  toolName: string;
  title: string;
  description: string;
  promptGuidance: string[];
};

export type NativeCapletsService = {
  listTools(): NativeCapletTool[];
  execute(capletId: string, request: unknown): Promise<unknown>;
  close(): Promise<void>;
};

export function createNativeCapletsService(
  options?: NativeCapletsServiceOptions,
): NativeCapletsService;

export function nativeCapletToolName(capletId: string): string;

export function nativeCapletsSystemGuidance(toolNames: string[]): string;
```

Service behavior:

- Load Caplets config once at construction using existing `loadConfig` path rules.
- Snapshot enabled Caplets for `listTools()`.
- Use `ServerRegistry` plus existing backend managers exactly like MCP runtime.
- Reuse `handleServerTool()` for operation validation/execution.
- Return the same structured values and errors the MCP runtime returns, but adapters can format for their host tool APIs.
- Close downstream MCP processes via `DownstreamManager.close()` when the adapter process/session shuts down.
- Do not start or probe backends during `listTools()`.
- Do not expose local source paths, env values, tokens, headers, raw command args beyond existing safe `get_caplet` metadata.

Native tool naming:

```ts
export function nativeCapletToolName(capletId: string): string {
  return `caplets_${capletId.replace(/-/g, "_")}`;
}
```

This keeps current Caplet IDs unchanged internally while avoiding OpenCode/Pi tool-name collisions. Because existing `SERVER_ID_PATTERN` allows hyphens, the native name normalizes `-` to `_` for broader agent tool compatibility.

---

## Prompt Guidance Contract

The adapters should inject one shared system guidance block and per-tool descriptions.

Shared guidance:

```md
## Caplets Native Tools

Caplets tools are native wrappers around configured Caplet backends. Each tool is named `caplets_<id>` and represents one capability domain.

Recommended flow:

1. Call the relevant `caplets_<id>` tool with `operation: "get_caplet"` to read the full Caplet card.
2. Call `check_backend` or `check_mcp_server` only when availability is uncertain.
3. Use `search_tools` or `list_tools` to discover the selected Caplet's downstream operations.
4. Use `get_tool` before `call_tool` when argument or output schema is unclear.
5. For `call_tool`, put downstream inputs only inside the top-level `arguments` object.
6. Do not invent downstream tool names; execute only exact names returned by `list_tools`, `search_tools`, or `get_tool`.
```

Per-tool prompt guidance:

- Start from existing `capabilityDescription(caplet)`.
- Replace examples of direct tool names with the native prefixed name where needed.
- Preserve Caplet `name`, `description`, `tags`, and Markdown body behavior.
- Do not add new Caplet schema fields for prompt guidance in v1.

OpenCode guidance:

- Register native tools through the plugin `tool` map.
- Inject shared system guidance through OpenCode's `experimental.chat.system.transform` hook.
- Do not edit `opencode.json`, agent prompts, or user config files.

Pi guidance:

- Register tools with `promptSnippet` and `promptGuidelines`.
- Every `promptGuidelines` bullet must explicitly name the tool, e.g. `Use caplets_github ...`, because Pi appends bullets flat to its Guidelines section.

---

## Task 1: Workspace And Build Layout

**Files:**

- Create: `pnpm-workspace.yaml`
- Modify: `package.json`
- Modify: `rolldown.config.ts`

- [ ] Create `pnpm-workspace.yaml`.

```yaml
packages:
  - "."
  - "packages/*"
```

- [ ] Update root `package.json` scripts.

Expected script shape:

```json
{
  "scripts": {
    "build": "pnpm build:core && pnpm --filter @caplets/opencode build && pnpm --filter @caplets/pi build",
    "build:core": "rolldown -c",
    "build:watch": "rolldown -c --watch",
    "prepack": "pnpm build:core",
    "verify": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm schema:check && pnpm test && pnpm benchmark:check && pnpm build"
  }
}
```

Keep existing scripts not shown here unchanged.

- [ ] Add root package export for native API.

Expected export shape:

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./native": "./dist/native.js"
  }
}
```

- [ ] Update `rolldown.config.ts` to emit both CLI and native entrypoints.

Expected config shape:

```ts
import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    index: "src/index.ts",
    native: "src/native.ts",
  },
  output: {
    dir: "./dist",
    format: "esm",
    banner: (chunk) => (chunk.name === "index" ? "#!/usr/bin/env node" : ""),
  },
  platform: "node",
});
```

- [ ] Run `pnpm build:core`.

Expected: build succeeds and emits `dist/index.js` plus `dist/native.js`.

---

## Task 2: Native Service Core

**Files:**

- Create: `src/native.ts`
- Create: `src/native/service.ts`
- Create: `src/native/tools.ts`
- Test: `test/native.test.ts`

- [ ] Write failing tests for native tool listing and prefixed naming in `test/native.test.ts`.

Test coverage:

- `createNativeCapletsService({ configPath })` reads an existing Caplets config.
- `listTools()` returns enabled Caplets only.
- Native tool names are `caplets_<id>` and convert hyphens to underscores.
- Tool descriptions include the existing Caplet capability card.
- `listTools()` does not start downstream MCP servers.

- [ ] Write failing tests for native execution.

Test coverage:

- `execute("alpha", { operation: "get_caplet" })` returns the same safe detail shape as `ServerRegistry.detail()`.
- `execute("alpha", { operation: "search_tools", query: "x" })` delegates to the same backend manager path used by MCP runtime.
- Invalid operation returns the same structured error result shape as MCP runtime.
- `close()` closes downstream processes without throwing when nothing has started.

- [ ] Implement `src/native/tools.ts`.

Implementation responsibilities:

- `nativeCapletToolName(capletId)`.
- `nativeCapletsSystemGuidance(toolNames)`.
- `nativeCapletPromptGuidance(toolName, caplet)`.
- `nativeCapletToolDescription(caplet)` using existing `capabilityDescription(caplet)`.

- [ ] Implement `src/native/service.ts`.

Implementation responsibilities:

- Instantiate `ServerRegistry`, `DownstreamManager`, `OpenApiManager`, `GraphQLManager`, `HttpActionManager`, and `CliToolsManager` exactly once.
- Expose `listTools()`, `execute(capletId, request)`, and `close()`.
- Call `handleServerTool()` for execution.
- Catch errors and return `errorResult(error)` for adapter consistency.
- Keep service construction free of MCP SDK server registration.

- [ ] Implement `src/native.ts` as the public export barrel.

Expected exports:

```ts
export {
  createNativeCapletsService,
  type NativeCapletsService,
  type NativeCapletsServiceOptions,
  type NativeCapletTool,
} from "./native/service.js";
export { nativeCapletToolName, nativeCapletsSystemGuidance } from "./native/tools.js";
export { generatedToolInputSchema } from "./tools.js";
export { generatedToolInputJsonSchema } from "./generated-tool-input-schema.mjs";
```

- [ ] Run `pnpm test -- test/native.test.ts`.

Expected: native service tests pass.

- [ ] Run `pnpm typecheck`.

Expected: no TypeScript errors.

---

## Task 3: OpenCode Adapter Package

**Files:**

- Create: `packages/caplets-opencode/package.json`
- Create: `packages/caplets-opencode/rolldown.config.ts`
- Create: `packages/caplets-opencode/tsconfig.json`
- Create: `packages/caplets-opencode/src/schema.ts`
- Create: `packages/caplets-opencode/src/index.ts`
- Create: `packages/caplets-opencode/README.md`
- Test: `packages/caplets-opencode/test/opencode.test.ts`

- [ ] Create `packages/caplets-opencode/package.json`.

Expected shape:

```json
{
  "name": "@caplets/opencode",
  "version": "0.0.0",
  "description": "Native OpenCode plugin for Caplets.",
  "type": "module",
  "main": "dist/index.js",
  "exports": {
    ".": "./dist/index.js"
  },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "rolldown -c"
  },
  "dependencies": {
    "caplets": "workspace:*",
    "@opencode-ai/plugin": "^0.0.0"
  },
  "peerDependencies": {
    "@opencode-ai/plugin": ">=0"
  }
}
```

During implementation, replace `^0.0.0` with the current compatible `@opencode-ai/plugin` version resolved by `pnpm add -F @caplets/opencode @opencode-ai/plugin`.

- [ ] Create package build config mirroring the root ESM Node build without a shebang.

- [ ] Implement `src/schema.ts`.

Implementation responsibilities:

- Convert the existing generated operation schema into OpenCode `tool.schema` fields.
- Keep `operation` enum values identical to `operations` in `src/generated-tool-input-schema.mjs`.
- Keep `arguments` as a JSON object for `call_tool` only.
- Keep optional `fields` as string array.

- [ ] Implement `src/index.ts` OpenCode plugin.

Behavior:

- Export a default OpenCode plugin function.
- Create one native service at plugin load.
- Build a tool record from `service.listTools()`.
- Each key is the native prefixed `toolName`.
- Each tool executes `service.execute(capletId, args)` and returns text suitable for OpenCode.
- Add an `experimental.chat.system.transform` hook that pushes `nativeCapletsSystemGuidance(toolNames)` into `output.system`.
- Do not write files or mutate OpenCode config.

- [ ] Write `packages/caplets-opencode/test/opencode.test.ts`.

Test coverage:

- Plugin returns one OpenCode tool per enabled Caplet.
- Tool keys are prefixed and hyphen-normalized.
- Tool descriptions include Caplet name and operation guidance.
- Tool execution delegates to `service.execute()` with the original Caplet ID.
- The system transform hook appends Caplets guidance and names registered native tools.

- [ ] Add README usage docs.

Required documentation:

- Install package.
- Register plugin using OpenCode's plugin mechanism.
- State that no MCP server is required for this mode.
- State that the plugin does not edit `opencode.json`.
- Show the `caplets_<id>` naming convention.

- [ ] Run `pnpm --filter @caplets/opencode build`.

Expected: adapter package builds successfully.

- [ ] Run `pnpm test -- packages/caplets-opencode/test/opencode.test.ts`.

Expected: OpenCode adapter tests pass.

---

## Task 4: Pi Adapter Package

**Files:**

- Create: `packages/caplets-pi/package.json`
- Create: `packages/caplets-pi/rolldown.config.ts`
- Create: `packages/caplets-pi/tsconfig.json`
- Create: `packages/caplets-pi/src/schema.ts`
- Create: `packages/caplets-pi/src/index.ts`
- Create: `packages/caplets-pi/README.md`
- Test: `packages/caplets-pi/test/pi.test.ts`

- [ ] Create `packages/caplets-pi/package.json`.

Expected shape:

```json
{
  "name": "@caplets/pi",
  "version": "0.0.0",
  "description": "Native Pi extension for Caplets.",
  "type": "module",
  "main": "dist/index.js",
  "exports": {
    ".": "./dist/index.js"
  },
  "files": ["dist", "README.md"],
  "scripts": {
    "build": "rolldown -c"
  },
  "dependencies": {
    "caplets": "workspace:*",
    "typebox": "^1.0.0",
    "@earendil-works/pi-coding-agent": "^0.0.0"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">=0"
  }
}
```

During implementation, replace placeholder versions with the current compatible versions resolved through package installation.

- [ ] Implement `src/schema.ts`.

Implementation responsibilities:

- Build a TypeBox schema matching the Caplets operation request shape.
- Use string literal union for `operation`.
- Keep optional fields aligned with `generatedToolInputDescriptions`.
- Preserve strict object behavior where Pi supports it.

- [ ] Implement `src/index.ts` Pi extension.

Behavior:

- Export Pi's default extension function.
- Create one native service at extension load.
- Register one Pi tool per `service.listTools()` entry.
- Use `name: tool.toolName`, `label: tool.title`, `description: tool.description`.
- Set `promptSnippet` to a one-line Caplets capability summary.
- Set `promptGuidelines` to bullets that explicitly name the tool.
- `execute()` calls `service.execute(capletId, params)`.
- Return Pi-compatible `{ content, details }`, with `details.result` carrying structured result data when available.
- Attach a best-effort process shutdown handler that calls `service.close()` once.

- [ ] Write `packages/caplets-pi/test/pi.test.ts`.

Test coverage:

- Extension registers one tool per enabled Caplet.
- Tool names are prefixed and hyphen-normalized.
- `promptGuidelines` explicitly include each native tool name.
- Execution delegates to `service.execute()` with original Caplet ID.
- Returned result includes LLM-readable text and details.

- [ ] Add README usage docs.

Required documentation:

- Install package.
- Register or load extension using Pi's extension mechanism.
- State that no MCP server is required for this mode.
- Show `caplets_<id>` naming.
- Explain that new Caplets require `/reload` or restarting Pi for v1.

- [ ] Run `pnpm --filter @caplets/pi build`.

Expected: adapter package builds successfully.

- [ ] Run `pnpm test -- packages/caplets-pi/test/pi.test.ts`.

Expected: Pi adapter tests pass.

---

## Task 5: Root Tests And Type Safety

**Files:**

- Modify: `test/tools.test.ts` if schema expectations need native export coverage.
- Modify: `test/registry.test.ts` only if prompt helper behavior moves.
- Modify: `test/runtime.test.ts` only if refactoring changes MCP runtime construction.

- [ ] Add tests proving existing MCP runtime behavior is unchanged.

Coverage:

- `CapletsRuntime.registeredToolIds()` still returns raw Caplet IDs, not prefixed native names.
- MCP generated tool descriptions still use existing `capabilityDescription()` output.
- MCP operation validation remains strict.

- [ ] Add tests proving native naming does not leak into MCP mode.

Expected:

- MCP tool name remains `github`.
- Native tool name is `caplets_github`.

- [ ] Run focused tests.

Commands:

```sh
pnpm test -- test/native.test.ts test/runtime.test.ts test/tools.test.ts
pnpm test -- packages/caplets-opencode/test/opencode.test.ts packages/caplets-pi/test/pi.test.ts
```

Expected: all focused tests pass.

---

## Task 6: Native Benchmark Modes

**Files:**

- Modify: `benchmarks/lib/opencode-runner.mjs`
- Modify: `benchmarks/lib/pi-runner.mjs`
- Modify: `benchmarks/live-config/opencode/README.md`
- Modify: `benchmarks/live-config/pi/README.md`
- Modify: `test/benchmark.test.ts`

- [ ] Add OpenCode `native-caplets` mode.

Expected behavior:

- Existing `direct-flat` and `caplets` modes remain unchanged.
- `native-caplets` config loads `@caplets/opencode` as a plugin instead of registering the Caplets MCP server.
- The generated Caplets config file is still written for the native service to read.
- The runner sets `CAPLETS_CONFIG` to the generated config path.
- The runner does not expose mock servers directly through MCP in native mode.

- [ ] Add Pi `native-caplets` mode.

Expected behavior:

- Existing `direct-flat`, `pi-proxy`, and `caplets` modes remain unchanged.
- `native-caplets` config loads `@caplets/pi` as an extension instead of registering the Caplets MCP server.
- The generated Caplets config file is still written for the native service to read.
- The runner sets `CAPLETS_CONFIG` to the generated config path.

- [ ] Update benchmark tests.

Coverage:

- `OPENCODE_CONFIG_MODES` includes `native-caplets`.
- `PI_CONFIG_MODES` includes `native-caplets`.
- Native configs do not include a Caplets MCP server entry.
- Native configs preserve generated Caplets config support files.

- [ ] Update live benchmark docs.

Docs must state:

- `caplets` mode means Caplets over MCP.
- `native-caplets` mode means native adapter package.
- Live native modes require the adapter package to be built.

- [ ] Run benchmark tests.

Command:

```sh
pnpm test -- test/benchmark.test.ts
```

Expected: benchmark config tests pass.

---

## Task 7: Documentation And Install UX

**Files:**

- Modify: `README.md`
- Create or modify: `docs/native-adapters.md`
- Modify: `package.json`

- [ ] Add README native adapter section.

Required content:

- Explain the three exposure modes: direct downstream MCP, Caplets MCP gateway, native Caplets adapter.
- Explain why native adapters exist: lower adapter overhead, native prompt hooks, no MCP server process for Caplets itself.
- State that downstream MCP backends may still be used by Caplets internally; “native” means the agent-to-Caplets boundary is native.
- Show native tool naming: `caplets_<id>`.
- State that v1 snapshots Caplets at plugin/extension load.

- [ ] Add `docs/native-adapters.md`.

Required sections:

- Architecture diagram in text form.
- OpenCode install/use.
- Pi install/use.
- Security model.
- Prompt guidance behavior.
- Troubleshooting.

- [ ] Add package release notes.

If this repo uses Changesets at implementation time, add a changeset that describes:

- `caplets`: adds native runtime export.
- `@caplets/opencode`: initial native OpenCode adapter.
- `@caplets/pi`: initial native Pi adapter.

- [ ] Run docs-related checks.

Command:

```sh
pnpm format:check
```

Expected: markdown formatting passes.

---

## Task 8: Full Verification

**Files:**

- All touched files.

- [ ] Install dependencies after adding workspace packages.

Command:

```sh
pnpm install
```

Expected: lockfile updates only for intentional workspace/package dependencies.

- [ ] Run formatting.

Command:

```sh
pnpm format:check
```

Expected: pass.

- [ ] Run lint.

Command:

```sh
pnpm lint
```

Expected: pass.

- [ ] Run typecheck.

Command:

```sh
pnpm typecheck
```

Expected: pass across root and packages.

- [ ] Run schema drift check.

Command:

```sh
pnpm schema:check
```

Expected: pass. No Caplet schema changes should be needed for this feature.

- [ ] Run tests.

Command:

```sh
pnpm test
```

Expected: pass.

- [ ] Run deterministic benchmark check.

Command:

```sh
pnpm benchmark:check
```

Expected: pass.

- [ ] Run full build.

Command:

```sh
pnpm build
```

Expected: root package plus both native adapter packages build successfully.

- [ ] Run full verification.

Command:

```sh
pnpm verify
```

Expected: pass.

---

## Security And Safety Requirements

- Native adapters must not expose secrets in tool descriptions, system guidance, errors, or details.
- Native adapters must not write or modify user OpenCode/Pi config.
- Native adapters must preserve existing Caplets trust rules for project `.caplets` files.
- Native adapters must preserve existing OAuth/auth store behavior.
- OpenCode native tools must not override built-in tools because names are prefixed.
- Pi guidelines must explicitly name each tool to avoid ambiguous prompt bullets.
- Adapter package tests must include a secret-looking config value and assert it is absent from tool descriptions and `get_caplet` detail.

---

## Residual Risks

- OpenCode prompt hook APIs are experimental. The implementation must pin tests to the actual installed `@opencode-ai/plugin` types and fail fast if `experimental.chat.system.transform` changes.
- Pi extension APIs may differ by installed version. Keep the Pi adapter package peer range explicit once the implementation resolves the current package version.
- Snapshot-at-load means users must reload to see newly added Caplets. This is deliberate for v1 and must be documented clearly.
- Native adapters reduce the agent-to-Caplets MCP boundary, but MCP-backed Caplets still start downstream MCP servers internally when selected.

---

## Completion Criteria

- `caplets/native` exports a stable in-process service used by both adapters.
- `@caplets/opencode` builds and registers prefixed native Caplet tools plus system prompt guidance through hooks.
- `@caplets/pi` builds and registers prefixed native Caplet tools plus Pi prompt snippets/guidelines.
- Existing MCP behavior remains unchanged.
- Docs clearly distinguish MCP gateway mode from native adapter mode.
- `pnpm verify` passes.
