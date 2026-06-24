# AGENTS.md

## Commands

- Use `pnpm` only; the repo pins `pnpm@11.7.0` and requires Node `>=22`.
- Install with `pnpm install --frozen-lockfile` when matching CI.
- Full local gate and pre-push hook: `pnpm verify` (`format:check -> lint -> code-mode:check-api -> schema:check -> docs:check -> typecheck -> test -> benchmark:check -> build`).
- Fast focused checks: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Run one package: `pnpm --filter @caplets/core test`, `pnpm --filter caplets build`, or replace the filter with `@caplets/opencode`, `@caplets/pi`, `@caplets/benchmarks`.
- Run one Vitest file by passing it after the package script, e.g. `pnpm --filter @caplets/core test -- test/config.test.ts`.
- Dev server: `pnpm dev` builds/watches `@caplets/core` and restarts `packages/cli/dist/index.js`; run `pnpm build` first if CLI dist output is missing.

## Package Map

- `packages/core` is the runtime/library source: config parsing, schema generation, MCP/OpenAPI/GraphQL/HTTP/CLI backends, native service exports.
- `packages/cli` publishes the `caplets` binary and delegates almost all behavior to `@caplets/core`; `caplets serve` starts the MCP server, while no args print help.
- `packages/opencode` and `packages/pi` are native agent integrations that wrap `@caplets/core/native`; keep integration-specific schema/adapter code there.
- `packages/benchmarks` owns deterministic and opt-in live coding-agent benchmarks; deterministic benchmark docs are generated from `pnpm benchmark`.

## Agent skills

- Issues and PRDs live in GitHub Issues for `spiritledsoftware/caplets`; use `gh` with `--repo spiritledsoftware/caplets`. Details: `docs/agents/issue-tracker.md`.
- Triage labels are documented in `docs/agents/triage-labels.md`; current live labels include `question` for `needs-info` and `wontfix` for `wontfix`.
- This is a single-context repo. Start with `CONTEXT.md`, relevant ADRs in `docs/adr/`, and `docs/agents/domain.md`; use `STRATEGY.md`, `CONCEPTS.md`, and `docs/solutions/` when the task touches product direction, vocabulary, or documented patterns.

## Docs And Generated Files

- Source code is authoritative. Keep durable product docs in `docs/product/`, architecture docs in `docs/`, ADRs in `docs/adr/`, specs/plans in `docs/specs/` or `docs/plans/`, and solution patterns in `docs/solutions/`.
- Avoid committing short-lived plans unless explicitly requested. Do not use `docs/superpowers/` in this repo.
- Config schema source: `packages/core/src/config.ts`. Generate with `pnpm schema:generate`; check with `pnpm schema:check`.
- Code Mode API sources: `packages/core/src/code-mode/runtime-api.d.ts` and `packages/core/src/code-mode/platform-entry.ts`. Generate with `pnpm code-mode:generate-api`; check with `pnpm code-mode:check-api`.
- Benchmark report: `pnpm benchmark` updates `docs/benchmarks/coding-agent.md`; `pnpm benchmark:check` checks staleness.
- Live benchmarks are opt-in and local/model-dependent: build first, then run `CAPLETS_BENCH_LIVE=1 pnpm benchmark:live:opencode`, `CAPLETS_BENCH_LIVE=1 pnpm benchmark:live:pi`, or `CAPLETS_BENCH_LIVE=1 pnpm benchmark:live:pi-eval`.

## Config And Runtime Gotchas

- Default user config path is resolved by core; tests commonly override with `CAPLETS_CONFIG`.
- Project config lives at `.caplets/config.json`; project Markdown Caplet files load by default, while executable backend maps in project config are intentionally rejected.
- Runtime config reload keeps the last known-good config on parse/validation errors; do not change this behavior without updating reload tests.
- Caplet tool names come from configured server IDs and expose progressive discovery operations (`get_caplet`, `list_tools`/`search_tools`, `get_tool`, `call_tool`) rather than flattening downstream tools.

## PR And Release Checks

- CI runs `pnpm verify` plus `pnpm changeset status --since=origin/main` on PRs unless the PR has the `no changeset` label.
- User-facing package changes usually need a changeset; current versioning is handled by Changesets and `pnpm version-packages`/`pnpm release`.
- Pre-commit only runs `pnpm lint-staged` (`oxfmt --check` and `oxlint` on staged JS/TS/config/docs files); pre-push runs the full `pnpm verify`.
- Alchemy deploy workflows are in `.github/workflows/deploy.yml` and `.github/workflows/pr-preview-deploy.yml`; check `alchemy.run.ts` and `infra/` before changing deploy behavior.
