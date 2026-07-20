# Plan 003: Run PostgreSQL Host-State Contracts in CI

> Status: COMPLETE
> Planned against: `ac12a174`
> Finding: #4 — PostgreSQL contract suites silently skip without an environment variable
> Priority: P0
> Effort: M
> Fix risk: LOW

## Why this matters

PostgreSQL is the documented multi-node authoritative backend, but four contract suites select `it.skip` when `CAPLETS_TEST_POSTGRES_URL` is absent. The normal CI matrix and `pnpm verify` provide no PostgreSQL service or URL, so destructive migration, concurrency, token, Vault, and Project Binding regressions can merge while SQLite remains green.

This plan adds one explicit PostgreSQL contract job. It does not make every Node-version matrix leg pay the database cost.

## Scope

### In scope

- `.github/workflows/ci.yml`
- The four PostgreSQL-gated core test files only if readiness or isolation defects surface
- `packages/core/test/host-storage-domain-parity.postgres.test.ts`
- `packages/core/test/caplet-record-storage.postgres.test.ts`
- `packages/core/test/remote-security-storage.postgres.test.ts`
- PostgreSQL sections in `packages/core/test/host-storage.test.ts`

### Out of scope

- Production Compose topology, role separation, or deployment migrations
- Adding PostgreSQL to every Node 22/24 quality-gate matrix leg
- Changing test semantics merely to make CI pass
- Running opt-in live benchmarks

## Current state

Each suite gates itself this way:

```ts
const connectionString = process.env.CAPLETS_TEST_POSTGRES_URL;
const postgresIt = connectionString ? it : it.skip;
```

The gated files are:

1. `packages/core/test/caplet-record-storage.postgres.test.ts`
2. `packages/core/test/host-storage-domain-parity.postgres.test.ts`
3. `packages/core/test/remote-security-storage.postgres.test.ts`
4. `packages/core/test/host-storage.test.ts`

`.github/workflows/ci.yml` currently runs `pnpm verify` in a Node 22/24 matrix without a PostgreSQL service.

The suites already create unique schemas and clean them in `afterEach`; preserve that isolation pattern.

## Required design

Add a separate `postgres-contracts` job using Node 24 and a pinned PostgreSQL 17 image. Use service health checks and a non-secret test-only credential. Set:

```yaml
env:
  CAPLETS_TEST_POSTGRES_URL: postgresql://postgres:postgres@127.0.0.1:5432/caplets_test
```

The job must run only the four gated files, not a second full `pnpm verify`. Keep the existing quality matrix unchanged.

## Implementation steps

### 1. Prove the current skip

Run locally without the environment variable:

```sh
pnpm --filter @caplets/core test -- \
  test/caplet-record-storage.postgres.test.ts \
  test/host-storage-domain-parity.postgres.test.ts \
  test/remote-security-storage.postgres.test.ts \
  test/host-storage.test.ts
```

Expected: PostgreSQL-specific cases report skipped. Record the count in the PR description, not in source.

### 2. Add the CI service job

In `.github/workflows/ci.yml`, add `postgres-contracts` with:

- `runs-on: ubuntu-latest`
- the same checkout, pnpm, and Node setup versions as the quality job
- PostgreSQL service image `postgres:17` pinned consistently with deployment support
- `POSTGRES_DB=caplets_test`, `POSTGRES_USER=postgres`, `POSTGRES_PASSWORD=postgres`
- `pg_isready` health checks
- `pnpm install --frozen-lockfile`
- one focused `pnpm --filter @caplets/core test -- ...` invocation listing all four files

Do not expose the test password as a repository secret; it is local to the ephemeral service network.

Run:

```sh
pnpm format:check
pnpm lint
```

Expected: exit 0.

### 3. Ensure failures cannot masquerade as skips

Add a small test-environment assertion inside each dedicated `.postgres.test.ts` file only if Vitest still reports all cases skipped in the CI job despite the URL. Prefer a single helper imported by those files if one exists. Do not make ordinary local `pnpm test` fail when PostgreSQL is intentionally absent.

The CI command itself must fail if zero PostgreSQL tests execute. The least brittle implementation is a job step after Vitest that checks a machine-readable Vitest report generated for this job. If introducing a reporter would complicate local scripts, split the gated mode with an environment variable such as `CAPLETS_REQUIRE_TEST_POSTGRES=1`: test files throw at module load when that flag is set and the URL is missing.

Set both variables in CI:

```yaml
CAPLETS_REQUIRE_TEST_POSTGRES: "1"
CAPLETS_TEST_POSTGRES_URL: ...
```

Run the focused command against a local or containerized PostgreSQL instance. Expected: all cases execute and pass.

### 4. Exercise the workflow contract

Push a branch and inspect the PR checks. The `postgres-contracts` check must be required or visibly separate from `quality (22)` and `quality (24)`. Capture its successful run URL in the PR description.

Local static verification:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
```

Expected: exit 0.

No changeset is required; this changes CI coverage only.

## Done criteria

- CI provisions PostgreSQL 17 and runs all four gated suites on every pull request and `main` push.
- The job fails rather than skipping when its PostgreSQL URL is absent or unusable.
- Ordinary local `pnpm test` still permits PostgreSQL tests to skip when the require flag is absent.
- Unique-schema cleanup remains intact; concurrent tests do not share schema names.
- A real PR run of `postgres-contracts` succeeds.
- Formatting, lint, and type checks exit 0.

## Escape hatches

- If GitHub service containers do not expose PostgreSQL before tests, fix the health check/readiness wait; do not add arbitrary sleeps.
- If a test fails because it relied on local PostgreSQL superuser state beyond schema creation/drop, STOP and report that hidden prerequisite. Do not grant production-like broad privileges without design review.
- If CI time grows materially, shard the four files within this job; do not remove coverage or move it to a non-required schedule.

## Maintenance note

Any new `CAPLETS_TEST_POSTGRES_URL`-gated test file must be appended to this job in the same PR. The require flag is the guard against a green job that executed nothing.
