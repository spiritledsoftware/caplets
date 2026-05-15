# Project-First Caplets Add Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make project-local Caplets the default workflow by removing the project trust gate, making `add` and `install` write to `./.caplets` by default, and exposing source/shadowing information clearly.

**Architecture:** Treat project `.caplets` as first-class project configuration loaded from the current working directory only. Project sources override global/user sources, but `caplets list` exposes source and shadowing information so users can see when project-local capabilities replace global ones. Keep generated Caplets as Markdown files and route all new scaffolding through `caplets add`.

**Tech Stack:** TypeScript, Commander, Zod, Markdown Caplet files, Vitest, Node.js fs/path APIs.

---

## Decisions Locked

- Project Caplets load by default; remove `CAPLETS_TRUST_PROJECT_CAPLETS`.
- Project scope is current working directory only; do not walk parents or Git roots in v1.
- Project sources override global/user sources when IDs collide.
- `caplets list` shows source by default and warns when a Caplet shadows another source.
- `caplets add` and `caplets install` are project-first by default.
- `-g, --global` writes to the user Caplets root.
- `caplets add` replaces the public `caplets author cli` flow; keep `author cli` only as a temporary deprecated alias if compatibility is low-cost.
- Generated Caplets are Markdown files, not direct edits to `config.json`.

---

## Files To Modify

- `src/config/paths.ts`: remove project trust env constant and make project path helpers unconditional.
- `src/config.ts`: always load project Caplet files; add source/shadow metadata loader while keeping `loadConfig()` compatibility.
- `src/caplet-files.ts`: expose text validation for generated Caplet manifests if needed.
- `src/runtime.ts`: always watch project `.caplets`; remove trust checks from watched paths.
- `src/cli.ts`: add `add` commands, update `install` with `-g/--global`, keep/deprecate `author cli` if practical.
- `src/cli/install.ts`: support project-first destination selection.
- `src/cli/inspection.ts`: include source metadata and shadow warnings.
- `src/cli/author.ts` and/or new `src/cli/add.ts`: generate Caplet Markdown for CLI, MCP, OpenAPI, GraphQL, and HTTP.
- `test/config-paths.test.ts`: update removed trust behavior.
- `test/config.test.ts`: project loading, project override, and source/shadow metadata tests.
- `test/runtime.test.ts`: watcher behavior without trust gate.
- `test/cli.test.ts`: list source/warnings, install destination, add command wiring.
- `test/author-cli.test.ts` or new `test/add.test.ts`: add command generation and validation tests.
- `README.md`: document project-first add/install, removed trust gate, and source/shadowing behavior.

---

## Task 1: Remove Project Trust Gate

**Files:**

- Modify: `src/config/paths.ts`
- Modify: `src/config.ts`
- Modify: `src/runtime.ts`
- Test: `test/config-paths.test.ts`
- Test: `test/config.test.ts`
- Test: `test/runtime.test.ts`

- [ ] Remove `TRUST_PROJECT_CAPLETS_ENV` exports and all `isTrustedEnvEnabled()` usage related to project Caplet loading.
- [ ] Make `loadConfig(configPath, projectConfigPath)` always load project Markdown Caplet files from `resolveProjectCapletsRoot()`.
- [ ] Keep project config loading from `./.caplets/config.json` unchanged.
- [ ] Update runtime watcher setup so project `.caplets` is always included in watched paths.
- [ ] Remove tests that assert project Markdown files are ignored without env trust.
- [ ] Add tests that project Markdown files load without setting any environment variable.
- [ ] Run `pnpm test test/config-paths.test.ts test/config.test.ts test/runtime.test.ts`.

---

## Task 2: Add Source And Shadow Metadata

**Files:**

- Modify: `src/config.ts`
- Modify: `src/caplet-files.ts` if source paths need to be returned from file discovery.
- Test: `test/config.test.ts`

- [ ] Add source metadata types: `global-config`, `global-file`, `project-config`, and `project-file`.
- [ ] Add a loader such as `loadConfigWithSources()` that returns `{ config, sources, shadows }`.
- [ ] Keep `loadConfig()` as a wrapper returning only `config` so runtime behavior remains compatible.
- [ ] Track the winning source kind and path for each final Caplet ID.
- [ ] Track shadowed entries when a later source overrides an earlier source.
- [ ] Preserve the existing source precedence order: global config, global files, project config, project files.
- [ ] Add tests proving project files override global files.
- [ ] Add tests proving `sources` points at the winning project path and `shadows` includes the global path.
- [ ] Run `pnpm test test/config.test.ts`.

---

## Task 3: Update `caplets list` Source UX

**Files:**

- Modify: `src/cli/inspection.ts`
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts`

- [ ] Change `caplets list` to use `loadConfigWithSources()`.
- [ ] Add a `source` column to human table output.
- [ ] Append short warning lines for shadowed Caplets, for example: `Warning: project Caplet GitHub shadows global Caplet at /path/to/github.md`.
- [ ] Add `source`, `path`, and `shadows` fields to `caplets list --json` output.
- [ ] Keep disabled filtering behavior unchanged.
- [ ] Add tests for human source output.
- [ ] Add tests for JSON source/shadow output.
- [ ] Run `pnpm test test/cli.test.ts`.

---

## Task 4: Make `caplets install` Project-First

**Files:**

- Modify: `src/cli.ts`
- Modify: `src/cli/install.ts`
- Test: `test/cli.test.ts`

- [ ] Add `-g, --global` to `caplets install`.
- [ ] Make default destination `resolveProjectCapletsRoot()`.
- [ ] Use `resolveCapletsRoot(resolveConfigPath(envConfigPath()))` only when `--global` is passed.
- [ ] Preserve `--force` behavior.
- [ ] Ensure project `.caplets` is created when missing.
- [ ] Update install output text only if needed to make project/global destination clear.
- [ ] Add tests that default install writes under `./.caplets`.
- [ ] Add tests that `--global` writes under the user Caplets root.
- [ ] Run `pnpm test test/cli.test.ts`.

---

## Task 5: Add `caplets add cli`

**Files:**

- Modify: `src/cli.ts`
- Modify: `src/cli/author.ts` or create `src/cli/add.ts`
- Test: `test/author-cli.test.ts`
- Test: `test/cli.test.ts`

- [ ] Add public command `caplets add cli <id>` using the existing CLI Caplet generator.
- [ ] Make default output project `.caplets/<id>.md`.
- [ ] Add `-g, --global` for user root output.
- [ ] Add `--print` for stdout-only review.
- [ ] Add `--output <path>` for explicit file output.
- [ ] Add `--force` to overwrite existing destination files.
- [ ] Validate generated Caplet text before writing.
- [ ] Keep `caplets author cli` as a deprecated alias that prints a warning to stderr, unless keeping it creates excessive complexity.
- [ ] Add tests for default project write, global write, print mode, output mode, and overwrite protection.
- [ ] Run `pnpm test test/author-cli.test.ts test/cli.test.ts`.

---

## Task 6: Extend `caplets add` For MCP, OpenAPI, GraphQL, And HTTP

**Files:**

- Modify: `src/cli.ts`
- Modify: `src/cli/author.ts` or create focused modules under `src/cli/add/`
- Test: `test/author-cli.test.ts` or `test/add.test.ts`
- Test: `test/cli.test.ts`

- [ ] Add `caplets add mcp <id>` supporting stdio via `--command`, repeated `--arg`, optional `--cwd`, optional `--env KEY=VALUE`, and remote via `--url --transport http|sse`.
- [ ] Add `caplets add openapi <id>` supporting `--spec <path-or-url>`, optional `--base-url`, and auth flags.
- [ ] Add `caplets add graphql <id>` supporting `--endpoint-url` and exactly one of `--schema <path-or-url>` or `--introspection`.
- [ ] Add `caplets add http <id>` supporting `--base-url` and repeated `--action <name:METHOD:/path>`.
- [ ] Share destination behavior with `add cli`: project default, `--global`, `--print`, `--output`, `--force`.
- [ ] Never embed raw bearer tokens; render `$env:ENV_NAME` from a `--token-env <ENV>` option.
- [ ] Validate generated Caplet text before printing or writing.
- [ ] Add tests for valid generation for each backend.
- [ ] Add tests for invalid connection shape, invalid action syntax, invalid schema/introspection combination, and overwrite protection.
- [ ] Run `pnpm test test/author-cli.test.ts test/cli.test.ts` or the new focused test file.

---

## Task 7: Documentation And Verification

**Files:**

- Modify: `README.md`
- Modify: tests as needed.

- [ ] Replace `caplets author cli` documentation with `caplets add cli`.
- [ ] Document `caplets add mcp`, `add openapi`, `add graphql`, and `add http`.
- [ ] Document that `caplets add` and `caplets install` write to `./.caplets` by default.
- [ ] Document `-g, --global` for user-level writes.
- [ ] Remove `CAPLETS_TRUST_PROJECT_CAPLETS` documentation.
- [ ] Document project override precedence and `caplets list` shadow warnings.
- [ ] Run targeted tests for changed areas.
- [ ] Run full verification: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm schema:check && pnpm test && pnpm build`.

---

## Out Of Scope

- Parent-directory or Git-root `.caplets` discovery.
- Remote marketplace search.
- AI-assisted generation.
- Live backend checks during `caplets add`.
- Direct edits to `config.json` from `caplets add`.
- Removing `caplets install` repo support.
