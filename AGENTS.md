# AGENTS.md

## Commands

- Use `pnpm` only; the repo pins `pnpm@11.0.9` and requires Node `>=22` while CI runs Node 24.
- Install with `pnpm install --frozen-lockfile` when matching CI.
- Full local gate and pre-push hook: `pnpm verify` (`format:check -> lint -> typecheck -> schema:check -> test -> benchmark:check -> build`).
- Fast focused checks: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- Run one package: `pnpm --filter @caplets/core test`, `pnpm --filter caplets build`, or replace the filter with `@caplets/opencode`, `@caplets/pi`, `@caplets/benchmarks`.
- Run one Vitest file by passing it after the package script, e.g. `pnpm --filter @caplets/core test -- test/config.test.ts`.
- Dev server: `pnpm dev` builds/watches `@caplets/core` and restarts `packages/cli/dist/index.js`; run `pnpm build` first if CLI dist output is missing.

## Package Map

- `packages/core` is the runtime/library source: config parsing, schema generation, MCP/OpenAPI/GraphQL/HTTP/CLI backends, native service exports.
- `packages/cli` publishes the `caplets` binary and delegates almost all behavior to `@caplets/core`; `serve`/no arg starts the stdio MCP server.
- `packages/opencode` and `packages/pi` are native agent integrations that wrap `@caplets/core/native`; keep integration-specific schema/adapter code there.
- `packages/benchmarks` owns deterministic and opt-in live coding-agent benchmarks; deterministic benchmark docs are generated from `pnpm benchmark`.

## Generated And Checked Files

- Config schema source of truth is Zod in `packages/core/src/config.ts`; update `schemas/caplets-config.schema.json` with `pnpm schema:generate` and verify with `pnpm schema:check`.
- `pnpm benchmark` updates `docs/benchmarks/coding-agent.md`; `pnpm benchmark:check` fails if the committed report is stale.
- Live benchmarks are opt-in only: build first, then run `CAPLETS_BENCH_LIVE=1 pnpm benchmark:live:opencode` or `CAPLETS_BENCH_LIVE=1 pnpm benchmark:live:pi`; results are local/model-dependent and not deterministic product claims.

## Config And Runtime Gotchas

- Default user config path is resolved by core; tests commonly override with `CAPLETS_CONFIG`.
- Project config lives at `.caplets/config.json` and executable project config is intentionally restricted unless `CAPLETS_TRUST_PROJECT_CAPLETS` is enabled.
- Runtime config reload keeps the last known-good config on parse/validation errors; do not change this behavior without updating reload tests.
- Caplet tool names come from configured server IDs and expose progressive discovery operations (`get_caplet`, `list_tools`/`search_tools`, `get_tool`, `call_tool`) rather than flattening downstream tools.

## PR And Release Checks

- CI runs `pnpm verify` plus `pnpm changeset status --since=origin/main` on PRs unless the PR has the `no changeset` label.
- User-facing package changes usually need a changeset; current versioning is handled by Changesets and `pnpm version-packages`/`pnpm release`.
- Pre-commit only runs `pnpm lint-staged` (`oxfmt --check` and `oxlint` on staged JS/TS/config/docs files); pre-push runs the full `pnpm verify`.
