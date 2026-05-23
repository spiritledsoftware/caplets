# ast-grep Premade Caplet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a premade `ast-grep` Caplet under `caplets/` that exposes ast-grep's agent-useful CLI capabilities through the Caplets CLI backend.

**Architecture:** Implement a static Markdown Caplet manifest at `caplets/ast-grep/CAPLET.md` using explicit `cliTools.actions`, matching existing premade examples such as `repo-cli` and `github-cli`. The Caplet uses the `ast-grep` executable, not `sg`, and exposes bounded request/response actions instead of arbitrary command passthrough.

**Tech Stack:** Caplets Markdown manifests, YAML frontmatter, `cliTools`, ast-grep CLI, Vitest config loader tests, README documentation.

---

## Scope

- Include: `version`, one-off `run` search/debug/rewrite-apply actions, `scan` diagnostics/report/rewrite-apply actions, `test` rule-test/snapshot-update actions, and `new` scaffolding actions.
- Exclude: help actions, shell-completion actions, `ast-grep lsp`, and interactive flows. Help and completions are not useful to agents once the Caplet action specs are explicit. LSP and interactive flows are long-running or TTY-oriented, while the CLI backend is request/response-oriented.
- Safety: read-only search/scan/test actions set `readOnlyHint: true`; rewrite apply-all, snapshot update, and scaffolding actions set `destructiveHint: true`.
- Path limitation: path-oriented actions accept one `path` per call because CLI backend interpolation substitutes primitive values, not argv arrays.

## File Structure

- Create: `caplets/ast-grep/CAPLET.md`
  - Owns metadata, ast-grep CLI actions, schemas, annotations, and usage notes.
- Modify: `packages/core/test/config.test.ts`
  - Extends repository example loadability coverage with representative ast-grep CLI action assertions.
- Modify: `README.md`
  - Adds ast-grep to the premade Caplet list.

## Task 1: Add ast-grep Caplet Manifest

**Files:**

- Create: `caplets/ast-grep/CAPLET.md`

- [ ] **Step 1: Create `caplets/ast-grep/CAPLET.md`**

Create a directory-style Caplet with frontmatter containing:

```yaml
$schema: https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplet.schema.json
name: ast-grep CLI
description: Search, scan, test, rewrite, and scaffold ast-grep rules through curated CLI tools.
tags:
  - cli
  - code
  - search
cliTools:
  timeoutMs: 120000
  maxOutputBytes: 1000000
  actions:
    version: ...
    run_pattern_text: ...
    run_pattern_json: ...
    run_pattern_debug_query: ...
    run_pattern_with_context: ...
    run_pattern_with_globs_json: ...
    run_rewrite_apply_all: ...
    scan_project: ...
    scan_project_json: ...
    scan_project_sarif: ...
    scan_project_github: ...
    scan_with_config_json: ...
    scan_rule_json: ...
    scan_inline_rules_json: ...
    scan_filter_json: ...
    scan_inspect_summary: ...
    scan_rewrite_apply_all: ...
    test_rules: ...
    test_rules_with_config: ...
    test_rules_filter: ...
    test_rules_skip_snapshots: ...
    test_rules_update_snapshots: ...
    new_project_yes: ...
    new_rule_yes: ...
    new_test_yes: ...
    new_util_yes: ...
```

Use `command: ast-grep` for every action. Do not use `sg`.

Use `output: { type: json }` for compact JSON and SARIF-producing actions.

Use action-level `cwd: $input.cwd` for `new_*_yes` actions instead of `--base-dir`, because current ast-grep CLI help does not reliably expose `--base-dir`.

- [ ] **Step 2: Add user-facing notes**

After frontmatter, document:

```md
# ast-grep CLI

Use this Caplet to expose ast-grep's structural search, scan, rule testing, rewrite, and scaffold workflows without giving an agent unrestricted shell access.

The manifest uses the full `ast-grep` executable instead of `sg` because `sg` can collide with the Linux `setgroups` command. Install ast-grep separately with npm, Cargo, Homebrew, or another supported package manager before using these tools.

Path-oriented actions intentionally accept one `path` argument per call because the CLI backend interpolates primitive arguments, not path arrays.

The `ast-grep lsp` server is intentionally not exposed. The LSP command is a long-running server process, while the Caplets CLI backend is designed for bounded request/response tool calls.

Interactive ast-grep workflows are not exposed for the same reason; use non-interactive apply-all rewrite and snapshot-update actions when file changes are intended.
```

- [ ] **Step 3: Validate the manifest loads**

Run: `CAPLETS_MODE=local pnpm --filter @caplets/core test test/config.test.ts`

Expected: PASS.

## Task 2: Assert ast-grep Is Loaded As A CLI Example

**Files:**

- Modify: `packages/core/test/config.test.ts`

- [ ] **Step 1: Extend `keeps repository example Caplets loadable`**

Add an expectation for `config.cliTools["ast-grep"]` that verifies:

```ts
expect(config.cliTools["ast-grep"]).toMatchObject({
  server: "ast-grep",
  name: "ast-grep CLI",
  actions: {
    run_pattern_json: {
      command: "ast-grep",
      args: [
        "run",
        "--pattern",
        "$input.pattern",
        "--lang",
        "$input.lang",
        "--json=compact",
        "--color",
        "never",
        "$input.path",
      ],
      output: { type: "json" },
      annotations: { readOnlyHint: true },
    },
    run_rewrite_apply_all: {
      command: "ast-grep",
      annotations: { destructiveHint: true },
    },
    new_rule_yes: {
      command: "ast-grep",
      cwd: expect.stringMatching(/caplets[/\\]ast-grep[/\\]\$input\.cwd$/),
      annotations: { destructiveHint: true },
    },
  },
});
```

- [ ] **Step 2: Run focused test**

Run: `CAPLETS_MODE=local pnpm --filter @caplets/core test test/config.test.ts`

Expected: PASS.

## Task 3: Document ast-grep In The Premade Caplet List

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Add ast-grep to the example list**

In the list under `This repository includes polished working examples under [caplets/](caplets/):`, add:

```md
- `ast-grep`: Structural code search, scan, rewrite, rule testing, and scaffolding through the `ast-grep` CLI.
```

- [ ] **Step 2: Run formatting check**

Run: `pnpm format:check README.md caplets/ast-grep/CAPLET.md docs/plans/2026-05-23-ast-grep-premade-caplet.md packages/core/test/config.test.ts`

Expected: PASS.

## Task 4: Final Verification

**Files:**

- Verify: `caplets/ast-grep/CAPLET.md`
- Verify: `packages/core/test/config.test.ts`
- Verify: `README.md`
- Verify: `docs/plans/2026-05-23-ast-grep-premade-caplet.md`

- [ ] **Step 1: Run schema validation**

Run: `pnpm schema:check`

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 3: Run focused tests**

Run: `CAPLETS_MODE=local pnpm --filter @caplets/core test test/config.test.ts`

Expected: PASS.

- [ ] **Step 4: Inspect final diff**

Run: `git diff -- caplets/ast-grep/CAPLET.md packages/core/test/config.test.ts README.md docs/plans/2026-05-23-ast-grep-premade-caplet.md`

Expected: Diff contains only the ast-grep premade Caplet, its focused test assertion, README list entry, and this plan.

## Self-Review

- Spec coverage: This plan covers the premade manifest, agent-useful ast-grep command groups, destructive/read-only annotations, excluded help/completion/LSP/interactive flows, README documentation, and focused validation.
- Placeholder scan: No placeholders, TBDs, or incomplete steps remain.
- Type consistency: The plan uses existing `cliTools.actions`, `inputSchema`, `output`, `cwd`, and `annotations` fields from the repository's CLI backend schema.
