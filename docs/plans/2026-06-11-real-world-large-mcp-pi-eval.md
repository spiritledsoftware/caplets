# Real World Large MCP Pi Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `mcp-real-world-large` Pi eval suite that compares Caplets against vanilla MCP with a large stack of real MCP servers instead of benchmark MCP fixture servers.

**Architecture:** Keep the existing `benchmark:live:pi-eval` command and mode matrix. Add a suite-level real-server profile that builds the same MCP server map for Caplets and `pi-mcp-adapter`, with a seeded temporary workspace for local servers and clear env preflight for authenticated services.

**Tech Stack:** TypeScript, Vitest, Pi eval harness, Caplets MCP config, `pi-mcp-adapter`, real MCP servers for GitHub, Context7, DeepWiki, Git, Filesystem, Playwright, ast-grep, language-server, and DuckDuckGo.

---

### Task 1: Add Real MCP Suite Metadata

**Files:**

- Modify: `core/packages/benchmarks/lib/pi-eval/suites.ts`
- Modify: `core/packages/benchmarks/test/benchmark.test.ts`

- [ ] Add `mcp-real-world-large` to `PI_EVAL_SUITE_IDS`.
- [ ] Extend `PiEvalSuite` with optional `requiredEnv` and `realMcpServers`.
- [ ] Define `realWorldLargeServers = ["github", "context7", "deepwiki", "git", "filesystem", "playwright", "ast_grep", "language_server", "duckduckgo"]`.
- [ ] Set `requiredEnv: ["GH_TOKEN", "CONTEXT7_API_KEY"]`.
- [ ] Add tests that `parsePiEvalArgs(["--task-suite", "mcp-real-world-large"])` selects the new default tasks and `resolvePiEvalSuite("mcp-real-world-large")` exposes the real-server metadata.

### Task 2: Generate Real MCP Configs For Caplets And Vanilla

**Files:**

- Modify: `core/packages/benchmarks/lib/pi-eval/config.ts`
- Modify: `core/packages/benchmarks/run-pi-eval.ts`
- Modify: `core/packages/benchmarks/test/benchmark.test.ts`

- [ ] Add an optional `mcpServers` input to `createCapletsPiEvalRunConfig`, `createVanillaMcpPiEvalRunConfig`, and `createVanillaMcpAdapterConfig`.
- [ ] When `mcpServers` is supplied, do not copy a fixture server and do not call `createBenchmarkFixtureMcpServers`.
- [ ] Pass `candidateWorkspace` and `suite.realMcpServers` into `createPiEvalRunConfig`.
- [ ] Validate `suite.requiredEnv` before starting jobs.
- [ ] Include `realMcpServers` in the report suite metadata.
- [ ] Add tests proving the same real server map is used by Caplets and vanilla, and missing required env fails clearly.

### Task 3: Add Real World Workspace And Tasks

**Files:**

- Create: `core/packages/benchmarks/fixtures/mcp-real-world-large-workspace/package.json`
- Create: `core/packages/benchmarks/fixtures/mcp-real-world-large-workspace/tsconfig.json`
- Create: `core/packages/benchmarks/fixtures/mcp-real-world-large-workspace/src/release-risk.ts`
- Create: `core/packages/benchmarks/fixtures/mcp-real-world-large-workspace/src/feature-flags.ts`
- Create: `core/packages/benchmarks/fixtures/mcp-real-world-large-workspace/docs/runbook.md`
- Create: `core/packages/benchmarks/fixtures/mcp-real-world-large-workspace/docs/dependency-upgrade.md`
- Create: `core/packages/benchmarks/fixtures/mcp-real-world-large-workspace/web/index.html`
- Create: `core/packages/benchmarks/fixtures/mcp-real-world-large-workspace/.lsp-mcp.jsonc`
- Create: `core/packages/benchmarks/fixtures/mcp-real-world-large/tasks.json`

- [ ] Seed a small but realistic TypeScript workspace for local Git, Filesystem, ast-grep, LSP, and Playwright.
- [ ] Add five tasks that require cross-server evidence:
  - `real-release-risk-brief`
  - `dependency-docs-migration-check`
  - `code-navigation-impact-brief`
  - `browser-runbook-verification`
  - `public-repo-architecture-scout`
- [ ] Keep prompts read-only and require the same final JSON shape as the existing MCP tool-use suites.

### Task 4: Verify

**Files:**

- Modify as needed from prior tasks.

- [ ] Run `pnpm --filter @caplets/benchmarks test -- test/benchmark.test.ts`.
- [ ] Run `pnpm --filter @caplets/benchmarks typecheck`.
- [ ] Run `pnpm --filter @caplets/benchmarks benchmark:check` if the focused checks pass.
