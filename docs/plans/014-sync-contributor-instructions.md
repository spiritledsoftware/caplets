# Plan 014: Synchronize Contributor Instructions with the Workspace

> Status: TODO
> Planned against: `ac12a174`
> Finding: #14 — contributor guidance names the wrong package manager and incomplete package map
> Priority: P1
> Effort: S
> Fix risk: LOW

## Why this matters

Root `package.json` pins `pnpm@11.9.0`, requires Node 22+, and declares `apps/*`, `packages/*`, and `tools/*` workspaces. Root `AGENTS.md` still names pnpm 11.7.0 and its expanded `pnpm verify` sequence omits the current `storage:check` and `compose:check` gates. Stale setup commands create lockfile churn and cause contributors to skip required verification.

This is a documentation synchronization task. It must not add tests that pin prose.

## Scope

### In scope

- Root `AGENTS.md`
- `README.md` contributor/setup sections only if they conflict
- `CONTRIBUTING.md` if present at execution time
- `docs/agents/` command/package guidance that duplicates the same facts

### Out of scope

- Product or marketing copy
- Package scripts, Node/pnpm versions, workspace layout, or CI behavior
- Exact-copy tests or snapshots
- Per-package READMEs unrelated to contributing

## Authoritative sources

Use these files as truth at execution time:

- root `package.json` for `packageManager`, `engines`, and scripts;
- `pnpm-workspace.yaml` for workspace roots;
- root `AGENTS.md` command list only after reconciling it against package scripts;
- `.github/workflows/ci.yml` for CI install/verification commands;
- `turbo.json` for build ordering that contributors need to know.

At plan time the authoritative values are pnpm 11.9.0, Node >=22, workspaces `apps/*`, `packages/*`, and `tools/*`, and `pnpm verify` includes both `storage:check` and `compose:check`.

## Required content

The updated guidance must state:

1. Use Corepack/pnpm only; do not use npm or Yarn to install/update dependencies.
2. Install with `pnpm install --frozen-lockfile` when matching CI.
3. Use `pnpm verify` for the full gate and list the existing focused package commands accurately.
4. Map active applications (`catalog`, `dashboard`, `docs`, `landing`, and any present at execution) separately from published/runtime packages.
5. Explain that `@caplets/core` build embeds dashboard output and Turbo orders dashboard before core; contributors should not invoke nested dashboard builds manually.
6. Identify optional PostgreSQL/live benchmark requirements without implying they run in ordinary local tests.
7. Keep issue/PRD and triage guidance aligned with `docs/agents/`.

Use concise command-first prose. Do not reproduce every package script.

## Implementation steps

### 1. Reconcile facts

Compare every version, command, package name, and directory named in contributor docs against the authoritative files above. Create a PR-description checklist of contradictions found. Do not infer unpublished workspaces from directories outside `pnpm-workspace.yaml`.

### 2. Update the smallest durable source set

Edit root `AGENTS.md` first. Update README/CONTRIBUTING/docs only where they independently state a conflicting fact. Prefer linking to one canonical section over maintaining duplicate package maps.

Do not add generated tables or a script that checks exact prose.

### 3. Validate every documented command

Run only non-mutating forms where appropriate:

```sh
pnpm --version
node --version
pnpm format:check
pnpm lint
pnpm typecheck
```

For filter examples, verify package names against package manifests. Do not run install solely to prove the command if dependencies are already present.

Expected: versions satisfy documented requirements and checks exit 0.

### 4. Human-readability review

Have a reviewer follow the instructions from a clean mental model and answer:

- Which package manager and Node version?
- What is the full gate?
- How do I test/build one package?
- Where do dashboard/catalog/docs/landing live?
- Which checks require PostgreSQL or live credentials?

If any answer requires repository knowledge not present in the guidance, tighten the relevant section.

No changeset is required; this is internal contributor documentation.

## Done criteria

- All contributor docs agree with root manifest, workspace config, CI, and Turbo graph.
- No install command uses npm/Yarn.
- Active apps and packages are not conflated.
- Optional PostgreSQL/live checks are clearly marked.
- No prose-locking tests or generated metadata fixtures are added.
- Format, lint, and type checks exit 0.

## Escape hatches

- If root sources disagree (for example `packageManager` differs from CI setup), STOP and report the operational conflict; do not choose one silently in docs.
- If `plans/` or `docs/plans/` contain historical commands, do not mass-edit archival plans. Scope updates to live contributor guidance.
- If a package appears in the filesystem but not `pnpm-workspace.yaml`, do not call it an active workspace without confirming ownership.

## Maintenance note

Version and command facts should have one canonical source and links elsewhere. Review contributor guidance whenever package manager, Node engine, workspace roots, or the `pnpm verify` pipeline changes.
