# Remote Local Interop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make remote mode use a merged Caplets view from the remote server, user-global local Caplets, and project local Caplets, with explicit write targets.

**Architecture:** Keep strict local-mode loading unchanged. Add best-effort local overlay loaders used only in remote-mode composition, then merge remote, global, and project layers by Caplet ID with higher-priority layers shadowing lower-priority layers. Mutations use explicit target flags so remote mode no longer silently sends local writes to the server.

**Tech Stack:** TypeScript, Vitest, Commander, MCP SDK remote client, existing CapletsEngine, pnpm.

**Final status:** Implemented. The checklist below is retained as the original execution plan; remote/local interop, target flags, auth disambiguation, documentation updates, and final review fixes are complete. Final review additionally confirmed local `caplets list` and `caplets config paths --json` honor `CAPLETS_PROJECT_CONFIG`.

---

## Resolved Decisions

- Remote mode read/execute surfaces use a merged view: remote server, user-global local, project local.
- Priority is ascending: remote < global local < project local.
- Higher-priority IDs shadow lower-priority IDs across backend types.
- Local overlay loading is best-effort in remote mode.
- Invalid local config warns and falls back to remaining valid layers.
- Invalid Caplet files warn and are skipped individually.
- A sibling directory Caplet `foo/CAPLET.md` wins over `foo.md`; warn that `foo.md` was shadowed.
- If the winning `CAPLET.md` is invalid, drop that ID from that layer rather than falling back to `foo.md`.
- Mutation target flags are shared: no flag and `--project` write project local, `--global` writes user-global local, `--remote` writes server remote.
- Auth commands use explicit target flags when IDs are ambiguous.

## Files

- Modify `packages/core/src/caplet-files.ts`: add best-effort Caplet file loading with per-file warnings and `CAPLET.md` duplicate precedence.
- Modify `packages/core/src/config.ts`: add best-effort local overlay config loading and source metadata support for remote rows.
- Modify `packages/core/src/engine.ts`: add a config-loader seam so remote-overlay local engines can use best-effort config without changing strict local mode.
- Modify `packages/core/src/native/service.ts`: return a composite remote/local service in remote mode instead of remote-only.
- Modify `packages/core/src/native/remote.ts`: keep remote service behavior, expose it for composition where needed.
- Modify `packages/core/src/cli.ts`: merge remote/local reads, route operations to local when shadowed, add mutation target flags.
- Modify `packages/core/src/cli/auth.ts`: add source-aware auth target resolution and ambiguity errors.
- Modify `packages/core/src/cli/init.ts`: support project-local init path.
- Modify `packages/core/src/cli/inspection.ts`: allow remote source rows and merged shadow warnings.
- Modify `packages/core/test/config.test.ts`: cover tolerant file loading and `CAPLET.md` precedence.
- Modify `packages/core/test/native-remote.test.ts`: cover composite remote/local native service shadowing.
- Modify `packages/core/test/cli-remote.test.ts`: cover merged list/execute behavior and mutation flags.
- Modify `packages/core/test/auth.test.ts`: cover auth ambiguity and target flags.
- Modify docs in `README.md` and `packages/cli/README.md`.

---

## Task 1: Best-Effort Caplet File Loading

- [ ] Add an exported loader named `loadCapletFilesWithPathsBestEffort(root)` that returns `{ config, paths, warnings } | undefined`.
- [ ] Preserve `loadCapletFilesWithPaths(root)` strict behavior for existing local mode.
- [ ] In best-effort mode, discover all candidate files and collect warnings instead of throwing for invalid files.
- [ ] If `foo.md` and `foo/CAPLET.md` both exist, select `foo/CAPLET.md` and warn that `foo.md` was shadowed.
- [ ] If the selected file is invalid, warn and skip only that file. Do not fall back to a shadowed sibling `foo.md`.
- [ ] If duplicate IDs remain after precedence rules, warn and skip that ID only.
- [ ] Add tests proving one invalid file does not prevent valid sibling Caplets from loading and proving `CAPLET.md` wins over `foo.md`.
- [ ] Run `pnpm --filter @caplets/core test -- test/config.test.ts`.

## Task 2: Best-Effort Overlay Config Loader

- [ ] Add a config helper, `loadLocalOverlayConfigWithSources(path, projectPath)`, that loads global config, global files, project config, and project files independently.
- [ ] Preserve strict `loadConfig` and `loadConfigWithSources` behavior.
- [ ] On invalid global config or project config, return a warning and ignore only that source.
- [ ] On invalid file-backed Caplets, use the Task 1 per-file warnings.
- [ ] Preserve existing source and shadow metadata for valid sources.
- [ ] Return an empty normalized config result when no valid local sources exist.
- [ ] Add tests for invalid config fallback, mixed valid/invalid layers, and shadow metadata.
- [ ] Run `pnpm --filter @caplets/core test -- test/config.test.ts`.

## Task 3: Composite Native Remote Service

- [ ] In `createNativeCapletsService`, remote mode should create both `RemoteNativeCapletsService` and a local overlay service using the best-effort config loader.
- [ ] Merge list tools in priority order: remote first, then global/project local; local tools with matching `caplet` IDs shadow remote tools.
- [ ] Execute local Caplet IDs locally and remote-only IDs remotely.
- [ ] Reload both sides and emit one merged tools-changed event when the merged set changes.
- [ ] Close both services idempotently.
- [ ] Preserve last known-good merged tools if a reload only produces warnings or fails unexpectedly.
- [ ] Add native remote tests for shadowing, local execution, remote fallback, reload events, and close behavior.
- [ ] Run `pnpm --filter @caplets/core test -- test/native-remote.test.ts`.

## Task 4: CLI Merged Read/Execute Routing

- [ ] For `list`, request remote rows and load local overlay rows, then merge by ID using remote < global < project precedence.
- [ ] Include shadow warnings for remote rows hidden by local rows.
- [ ] For `get-caplet`, `check-backend`, `list-tools`, `search-tools`, `get-tool`, `call-tool`, resources, prompts, and completion, check the local overlay first.
- [ ] If a local overlay contains the target ID, execute locally through a local `CapletsEngine` using best-effort overlay config.
- [ ] If no local overlay contains the target ID, route to remote control.
- [ ] Print local overlay warnings to stderr and continue.
- [ ] Preserve existing remote failure behavior for remote-only Caplets.
- [ ] Add CLI tests for merged list output, project shadowing of remote, global shadowing of remote, local execution, and remote fallback.
- [ ] Run `pnpm --filter @caplets/core test -- test/cli-remote.test.ts`.

## Task 5: Mutation Target Flags

- [ ] Add shared target parsing for `--project`, `--global`, and `--remote`.
- [ ] Reject combinations like `--project --global`, `--project --remote`, and `--global --remote`.
- [ ] Change `init` so no flag and `--project` create `./.caplets/config.json`.
- [ ] Make `init --global` create the user config.
- [ ] Make `init --remote` route to remote control.
- [ ] Make `add` and `install` default to project local even when `CAPLETS_MODE=remote`.
- [ ] Make `add --global` and `install --global` write user-global local.
- [ ] Make `add --remote` and `install --remote` route to remote control.
- [ ] Remove current behavior where remote mode automatically routes add/install/init remotely.
- [ ] Add CLI tests for each target and invalid target combinations.
- [ ] Run `pnpm --filter @caplets/core test -- test/cli-remote.test.ts`.

## Task 6: Auth Targeting And Ambiguity

- [ ] Add `--project`, `--global`, and `--remote` to `auth login`, `auth logout`, and `auth list`.
- [ ] With no flag, detect whether the requested ID appears in multiple scopes.
- [ ] If ambiguous, fail with a clear message telling the user to pass `--project`, `--global`, or `--remote`.
- [ ] `auth list` with no flag should show all available local and remote auth rows with a `source` field.
- [ ] `auth list --project`, `--global`, or `--remote` should show only that scope.
- [ ] Remote auth remains server-owned and uses existing remote control requests.
- [ ] Local auth continues using the existing local auth store keyed by server ID; flags disambiguate which Caplet config drives the auth flow.
- [ ] Add auth tests for ambiguity, target flags, source output, and remote requests.
- [ ] Run `pnpm --filter @caplets/core test -- test/auth.test.ts` and `pnpm --filter @caplets/core test -- test/cli-remote.test.ts`.

## Task 7: Docs

- [ ] Document the merged remote mode priority order.
- [ ] Document that local overlays are best-effort in remote mode.
- [ ] Document warnings and fallback behavior.
- [ ] Document mutation target flags and defaults.
- [ ] Document auth ambiguity and explicit target flags.
- [ ] Update `README.md` and `packages/cli/README.md`.

## Verification

- [ ] Run `pnpm --filter @caplets/core test -- test/config.test.ts`.
- [ ] Run `pnpm --filter @caplets/core test -- test/native-remote.test.ts`.
- [ ] Run `pnpm --filter @caplets/core test -- test/cli-remote.test.ts`.
- [ ] Run `pnpm --filter @caplets/core test -- test/auth.test.ts`.
- [ ] Run `pnpm --filter @caplets/core test`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm verify` before completion.
