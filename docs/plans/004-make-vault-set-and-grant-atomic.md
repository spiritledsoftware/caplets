# Plan 004: Make SQL Vault Set-and-Grant Atomic

> Status: COMPLETE
> Planned against: `ac12a174`
> Finding: #3 — compensation can leave a new grant attached to an older value
> Priority: P0
> Effort: M
> Fix risk: HIGH
> Depends on: Plan 003
> Required by: Plan 000

## Why this matters

`vault set NAME VALUE --grant CAPLET` is one operator intent but the SQL implementation performs value mutation and grant creation as separate transactions. If grant creation commits and later config activation fails, compensation restores or deletes only the value. The surviving grant can expose a restored older secret under the new authorization. Concurrent writers also make compensation generation-sensitive and hard to reason about.

The database must commit the value row, grant row, and their activity records atomically. Runtime config invalidation remains post-commit and must not roll committed authoritative state backward.

Plan 000 publishes this intent through conditional Vault resources. Keep the transaction coordinator transport-neutral: the Admin Adapter maps ETags to mutation generations, while this operation compares and advances value/grant generations in the same transaction.

## Scope

### In scope

- `packages/core/src/current-host/vault-operations.ts`
- `packages/core/src/storage/vault-values.ts`
- `packages/core/src/storage/vault-grants.ts`
- A small storage coordinator under `packages/core/src/storage/` if needed
- `packages/core/src/storage/index.ts` and `current-host/operations.ts` dependency wiring
- SQLite and PostgreSQL Vault/current-host tests
- One patch changeset for `@caplets/core`

### Out of scope

- File-backed Vault behavior
- Raw Vault reveal policy
- Key rotation or encryption-format changes
- Atomicity between SQL commit and in-memory runtime activation; that boundary is handled by last-known-good reload semantics
- Automatically deleting grants when a value is deleted (current product semantics retain them)

## Current state

`packages/core/src/current-host/vault-operations.ts:114-164` currently:

1. reads previous status/value;
2. calls `values.set(...)`;
3. calls `grants.grant(...)`;
4. calls `invalidateConfig(...)`;
5. on any failure after grant begins, restores or deletes only the value.

Both stores already accept `HostDatabase` and contain dialect-specific transactional helpers. `VaultGrantStore` exposes migration-in-transaction methods (`vault-grants.ts:136-146`), which is the repository pattern to follow. `BackendAuthStateStore` likewise branches once on dialect and performs mutation plus operator activity in one transaction.

## Required design

Introduce a narrow SQL-only operation, preferably on a new `VaultStateStore`, with this contract:

```ts
type SetVaultValueAndGrantInput = {
  key: string;
  value: string;
  force: boolean;
  createOnly?: boolean;
  expectedGeneration?: number;
  grant?: VaultGrantInput;
  operatorClientId: string;
};

setValueAndGrant(
  input: SetVaultValueAndGrantInput,
): Promise<Extract<VaultValueRecordStatus, { present: true }>>;
```

Rules:

1. Validate key, value, grant origin, Caplet ID, reference name, and operator before starting the transaction.
2. Encrypt the value before opening the transaction when safe; do not hold a PostgreSQL transaction while doing file/key I/O.
3. In one SQLite/PostgreSQL transaction, enforce force/generation semantics, upsert the value, insert/upsert the grant if present, advance the affected mutation generations exactly once, append one `vault.set` intent activity entry, and publish one config generation.
4. Any grant, activity, or config-publication failure rolls back the value and every other write from the intent.
5. The coordinator is wired from the same `HostDatabase` and key options as `VaultValueStore`; never introspect another store's private database.
6. Config activation runs once after commit. If activation fails, propagate the existing safe error and keep committed authoritative state. Do not compensate or publish a second generation.
7. Operations without `grant` still use the same atomic storage path so behavior cannot diverge.

Avoid widening `VaultValueRepository` with grant-specific responsibilities. Add a separate optional dependency to `CurrentHostOperationsDependencies`, while preserving fake repository tests that inject only value/grant interfaces.

## Implementation steps

### 1. Add characterization and failure-injection tests

In SQLite tests, add an injected failure at grant insertion/activity time and assert:

- no new value row exists when the key was absent;
- the old generation/value remains when the key existed;
- no grant row exists;
- no successful `vault_set` or `vault_grant` activity row exists.

Add a second test where `invalidateConfig` fails after commit. Assert the new value and grant both remain committed and the operation reports the activation failure. This locks the SQL/runtime boundary.

Mirror the atomic rollback test in the PostgreSQL parity suite enabled by Plan 003.

Run:

```sh
pnpm --filter @caplets/core test -- test/vault-value-storage.test.ts test/vault-grant-storage.test.ts test/host-storage-domain-parity.postgres.test.ts
```

Expected before implementation: the combined operation cannot satisfy the injected-grant rollback contract.

### 2. Add transaction-capable storage primitives

Refactor the existing private dialect functions so value upsert and grant insert can run against either a root database or a transaction database. Match the existing type aliases in `vault-values.ts` and `vault-grants.ts`; do not duplicate SQL.

Build the coordinator around `HostDatabase.transaction`:

- SQLite callback is synchronous; no `await` inside it.
- PostgreSQL callback is async and awaits every statement.
- Activity rows use one captured timestamp and the existing action names/metadata.

Run the storage tests. Expected: rollback and success cases pass for SQLite.

### 3. Wire current-host operations to the coordinator

Construct the coordinator in `createHostStorage` next to `vaultValues` and `vaultGrants`, then expose it as a named Host Storage service. Add it as an optional dependency in `CurrentHostOperationsDependencies` so unit fakes remain possible.

Replace `sqlVaultSetOutcome`'s read/set/grant/compensate sequence with one coordinator call. Delete the obsolete compensation code and previous plaintext read. Keep file Vault code unchanged.

Run:

```sh
pnpm --filter @caplets/core test -- test/current-host-administration.test.ts test/vault-value-storage.test.ts test/vault-grant-storage.test.ts
```

Expected: exit 0.

### 4. Verify concurrency and PostgreSQL parity

Add a race test with two set-and-grant attempts on the same key using expected/force semantics. Assert each observed grant is associated only with a committed generation and that no partial activity survives.

Run with PostgreSQL:

```sh
CAPLETS_REQUIRE_TEST_POSTGRES=1 \
CAPLETS_TEST_POSTGRES_URL="$CAPLETS_TEST_POSTGRES_URL" \
pnpm --filter @caplets/core test -- test/host-storage-domain-parity.postgres.test.ts
```

Expected: exit 0 with no skipped PostgreSQL cases.

### 5. Record and verify

Add a patch changeset for `@caplets/core` describing atomic SQL Vault value/grant commits. Then run:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
```

Expected: exit 0.

## Done criteria

- SQL value, optional grant, and activity mutations share one database transaction on both dialects.
- Grant failure cannot leave a value or activity change.
- Config activation failure does not trigger destructive SQL compensation.
- File Vault behavior and grant-retention-on-delete semantics are unchanged.
- SQLite and required PostgreSQL failure-injection/concurrency tests pass.
- Focused tests, format, lint, and type checks exit 0.

## Escape hatches

- If encryption currently requires a database read inside `values.set`, refactor only enough to separate deterministic preparation from transactional persistence; do not weaken encryption or hold the transaction during interactive/file operations.
- If SQLite's synchronous transaction API cannot call an introduced async helper, create explicit sync/async dialect functions as existing stores do. Do not use an un-awaited Promise inside SQLite transactions.
- If `invalidateConfig` is expected by a newer spec to roll back authoritative state, STOP and surface that conflicting contract; cross-resource rollback cannot be implemented safely as compensation.

## Implementation notes (2026-07-20)

- Added `VaultStateStore.setValueAndGrant`, accepting mutually exclusive value `createOnly`/`expectedGeneration` conditions and the grant's mutually exclusive `createOnly`/`expectedResourceVersion` conditions. Validation and Vault key I/O occur before the transaction; authenticated encryption occurs after reading and locking the current value row.
- SQLite uses one `IMMEDIATE` write transaction. PostgreSQL uses one transaction, the existing same-key advisory lock and row lock for the value, grant CAS/upsert constraints, and the config-generation advisory lock.
- Each successful intent commits the value generation, optional fresh grant resource version, one `vault.set` Operator Activity row, and one config generation. Value, grant, activity, and config-publication failures roll every write back.
- Current Host invokes the coordinator once and activates the committed configuration afterward. Activation failure retains authoritative SQL state and is propagated without inverse writes.
- Focused SQLite and required PostgreSQL runs cover validation failure, grant failure, activity failure, config-publication failure, create-only conflicts, stale value/grant versions, concurrent same-key writers, version increments, one activity/config generation, and activation-after-commit retention.
- Verification: the focused SQLite/PostgreSQL matrix passed 42 tests; `pnpm storage:check` and the `@caplets/core` typecheck passed.

## Maintenance note

Future multi-entity Host State commands should enter through a storage-level transaction coordinator. Current-host adapters may orchestrate validation and activation, but must not emulate transactions with inverse writes.
