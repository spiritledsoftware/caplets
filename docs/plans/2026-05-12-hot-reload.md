# Hot Reload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make normal `caplets serve` reload config and Caplet file changes without restarting the Caplets MCP process.

**Architecture:** Introduce an in-process runtime controller that owns the MCP server, registered top-level tool handles, the current registry, backend managers, and filesystem watchers. Reloads parse the effective config exactly as startup does, update registered MCP tools through `RegisteredTool` handles, invalidate only affected backend caches, and keep the last known-good config active when a reload fails.

**Tech Stack:** TypeScript, Node.js `fs.watch`, `@modelcontextprotocol/sdk` `McpServer.registerTool`, Vitest.

---

### Task 1: Runtime Controller

**Files:**

- Create: `src/runtime.ts`
- Modify: `src/index.ts`
- Test: `test/runtime.test.ts`

- [ ] Add `CapletsRuntime` that creates `McpServer`, `ServerRegistry`, `DownstreamManager`, `OpenApiManager`, and `GraphQLManager`.
- [ ] Track registered top-level Caplet tools in a `Map<string, RegisteredTool>`.
- [ ] Register initial enabled Caplets during startup.
- [ ] Keep `src/index.ts` as a small CLI/server entrypoint.

### Task 2: Reload Reconciliation

**Files:**

- Modify: `src/runtime.ts`
- Modify: `src/downstream.ts`
- Modify: `src/openapi.ts`
- Modify: `src/graphql.ts`
- Test: `test/runtime.test.ts`, `test/downstream.test.ts`, `test/openapi.test.ts`, `test/graphql.test.ts`

- [ ] On reload, call existing `loadConfig()` with the same resolved paths used at startup.
- [ ] Add new Caplets with `registerTool`.
- [ ] Update existing Caplets with `RegisteredTool.update`.
- [ ] Remove missing or disabled Caplets with `RegisteredTool.remove`.
- [ ] Add `DownstreamManager.closeServer(serverId)`.
- [ ] Add `OpenApiManager.invalidate(serverId)` and `GraphQLManager.invalidate(serverId)`.
- [ ] Invalidate or close only backends whose normalized config changed.
- [ ] Keep serving the previous registry and tools if reload parsing or validation fails.

### Task 3: Filesystem Watching

**Files:**

- Modify: `src/runtime.ts`
- Test: `test/runtime.test.ts`

- [ ] Watch the effective user config file, project config file, user Caplets root, and trusted project Caplets root.
- [ ] Use dependency-free `fs.watch` with a 250 ms debounce.
- [ ] Watch directories so new, renamed, and deleted Markdown Caplet files are detected.
- [ ] Recreate watchers after every successful reload because roots can change with `CAPLETS_CONFIG`.
- [ ] Close all watchers during runtime shutdown.

### Task 4: Documentation

**Files:**

- Modify: `README.md`

- [ ] Document that `caplets serve` hot reloads config and Caplet file changes by default.
- [ ] Document last known-good behavior for invalid edits.
- [ ] Document that changed or removed MCP-backed Caplets close only their affected downstream connection.
- [ ] Keep `pnpm dev` documented as source rebuild/restart tooling, separate from runtime config hot reload.

### Task 5: Verification

**Files:**

- Modify tests as needed.

- [ ] Run targeted tests for runtime reload and manager invalidation.
- [ ] Run `pnpm format:check`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm schema:check`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm build`.
