# MCP-Backed Caplet Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add skill-like Markdown Caplet files while keeping every Caplet backed by exactly one MCP server.

**Architecture:** Caplets remain executable MCP capability wrappers, not standalone skills. Existing `config.json` entries are normalized into Caplets, and Markdown files add richer capability cards with required `mcpServer` frontmatter. Runtime operations become Caplet-first: `get_caplet` and `check_mcp_server` replace `get_server` and `check_server`.

**Tech Stack:** TypeScript ESM, Node.js 22+, `@modelcontextprotocol/sdk`, Zod, `vfile-matter`, Vitest, rolldown, oxfmt, oxlint.

---

## Task 1: Add Caplet File Loading

**Files:**

- Modify: `package.json`
- Modify: `src/config.ts`
- Create: `src/caplet-files.ts`
- Test: `test/config.test.ts`

- [x] Add the `vfile-matter` runtime dependency.
- [x] Create a Caplet frontmatter schema that requires fenced YAML frontmatter with `name`, `description`, and `mcpServer`.
- [x] Discover top-level `*.md` files and one-level `*/CAPLET.md` files under both the user Caplets directory and project `.caplets` directory.
- [x] Derive IDs from paths: `github.md` -> `github`, `linear/CAPLET.md` -> `linear`.
- [x] Reject duplicate Caplet IDs within the same root.
- [x] Normalize Caplet files into the existing `mcpServers` map shape, with `name` and `description` outside `mcpServer`.
- [x] Merge source precedence as user config, user Caplet files, project config, trusted project Caplet files.
- [x] Preserve Markdown body and `tags` on normalized Caplet config.
- [x] Add tests for loading top-level and directory Caplets, project override precedence, same-ID config override, missing `mcpServer`, and duplicate IDs.

## Task 2: Rename Runtime Operations To Caplet-First Language

**Files:**

- Modify: `src/tools.ts`
- Modify: `src/registry.ts`
- Modify: `src/index.ts`
- Test: `test/tools.test.ts`
- Test: `test/registry.test.ts`
- Test: `test/benchmark.test.ts`

- [x] Rename operation `get_server` to `get_caplet`.
- [x] Rename operation `check_server` to `check_mcp_server`.
- [x] Do not keep compatibility aliases for old operation names.
- [x] Update request validation, operation descriptions, examples, errors, and tests.
- [x] Return full Caplet detail from `get_caplet`, including `caplet`, `name`, `description`, optional `tags`, optional `body`, and safe `mcpServer` metadata. Do not expose local source paths.
- [x] Ensure `get_caplet` does not start or probe the downstream MCP server.
- [x] Keep `list_tools`, `search_tools`, `get_tool`, and `call_tool` behavior unchanged.

## Task 3: Add Caplet Schema Generation

**Files:**

- Modify: `src/config.ts`
- Modify: `scripts/generate-config-schema.ts`
- Create: `schemas/caplet.schema.json`
- Test: `test/config.test.ts`

- [x] Export a generated JSON Schema for Caplet frontmatter.
- [x] Update schema generation/checking to maintain both `schemas/caplets-config.schema.json` and `schemas/caplet.schema.json`.
- [x] Add a drift test for the committed Caplet schema.
- [x] Run schema generation after implementation.

## Task 4: Update CLI Starters And Documentation

**Files:**

- Modify: `src/cli.ts`
- Modify: `README.md`
- Modify: `docs/product/caplets-progressive-mcp-disclosure-prd.md`
- Test: `test/cli.test.ts`

- [x] Keep `caplets init` writing the existing plain `config.json` starter.
- [x] Add README documentation for Markdown Caplet files and directory Caplets.
- [x] Document that every Caplet file must include `mcpServer`; serverless Caplets are out of scope.
- [x] Update documented operations to `get_caplet` and `check_mcp_server`.
- [x] Ensure CLI tests still validate starter config behavior.

## Task 5: Verification And Final Review

**Files:**

- All touched files.

- [x] Run `pnpm install` if the lockfile needs the new `vfile-matter` dependency.
- [x] Run `pnpm format:check`.
- [x] Run `pnpm lint`.
- [x] Run `pnpm typecheck`.
- [x] Run `pnpm schema:check`.
- [x] Run `pnpm test`.
- [x] Run `pnpm build`.
- [x] Perform a final review for secret leakage in `get_caplet` safe backend metadata.
