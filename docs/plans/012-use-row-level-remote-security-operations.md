# Plan 012: Use Row-Level Remote Security Operations

> Status: TODO
> Planned against: `ac12a174`
> Finding: #11 — normalized tables are read and rewritten as one aggregate document
> Priority: P1
> Effort: L
> Fix risk: HIGH
> Depends on: Plans 000 and 003

## Why this matters

Remote security already has normalized tables and unique indexes, but `RemoteSecurityStore` reconstructs every pairing code, client, token family, superseded token, and pending login into one `RemoteSecurityState` for most operations. Mutations then delete all six tables and reinsert the aggregate under a PostgreSQL advisory lock. Token validation scans clients in memory, and unrelated client operations serialize globally. Cost and lock contention grow with the entire host population.

This plan keeps the existing schema and public behavior but makes indexed rows authoritative at the operation seam. The aggregate loader/saver remains only for legacy migration and parity verification until those paths are separately retired.

Plan 000 adds stable administrative mutation generations so `/v2/admin/remote-clients/{clientId}` and `/remote-login-requests/{flowId}` can enforce `If-Match`. This plan must preserve those generations while replacing aggregate rewrites; access-validation touches must not advance an administrative mutation generation.

## Scope

### In scope

- `packages/core/src/storage/remote-security.ts`
- Existing SQLite/PostgreSQL schema indexes and Plan 000 mutation-version fields, only where query/contract evidence requires them
- `packages/core/test/remote-security-storage.test.ts`
- `packages/core/test/remote-security-storage.postgres.test.ts`
- Relevant portions of `host-storage-domain-parity.postgres.test.ts`
- One patch changeset for `@caplets/core` if externally observable errors/timing change

### Out of scope

- Changing token formats, hashes, encryption, roles, TTLs, quotas, replay windows, or error text
- Replacing the normalized schema
- Deleting legacy import/verify support
- Admin API route, DTO, ETag encoding, or generated-client redesign
- Removing all PostgreSQL locks without concurrency proof

## Current state

`remote-security.ts:889-938` loads six complete tables. `assembleState` joins them in memory. `saveSqliteState` and `savePostgresState` at lines 1041-1103 delete all rows and insert the rebuilt aggregate. `lockPostgresRemoteSecurity` uses one global advisory transaction lock:

```ts
await database.execute(sql`select pg_advisory_xact_lock(hashtextextended('remote_security', 0))`);
```

The schema already provides:

- unique `remote_clients.access_token_hash`;
- unique token-family client and refresh-hash indexes;
- foreign-key cascades for token families/superseded tokens;
- primary keys for client, flow, code, and family identities.

Do not create a second schema beside this one.

## Required design

Refactor one operation family at a time behind the unchanged `RemoteSecurityStore` public API.

### Query rules

- Access-token validation: `WHERE access_token_hash = ?`, then role/expiry/revocation checks and targeted `last_used_at` update.
- Refresh: locate active family by `refresh_token_hash`; check superseded hashes by indexed token hash; lock the client/family rows; rotate only that family and its bounded superseded rows.
- Client list/get/role/revoke: select/update by `client_id`; revocation updates client/family and activity in one transaction.
- Pairing codes: select/update by code ID/secret fingerprint and delete only expired/used rows covered by retention.
- Pending logins: select/update by `flow_id`, operator-code hash, completion hash, or refresh hash as appropriate; preserve per-source quota checks with targeted aggregate counts.

### Concurrency rules

- SQLite: use the existing transaction boundary per mutation.
- PostgreSQL: use `SELECT ... FOR UPDATE` on the affected client/family/flow/code rows. Use a narrowly keyed advisory lock only for absence-sensitive creation/quota checks where no row exists to lock.
- Keep one captured `now` per operation.
- Token rotation, replay record, and activity write commit atomically.
- Preserve constant-time secret hash comparisons where the code currently uses them. Indexed lookup by a cryptographic hash is acceptable; never index raw tokens.
- Cleanup uses targeted `DELETE ... WHERE expires_at < ?` and bounded superseded-token retention queries.

### Migration rule

`load*State`, `assembleState`, `relationalValues`, and `save*State` may remain for legacy import/verification only. Add a comment and tests preventing normal runtime methods from calling full-table save.

## Implementation steps

### 1. Build a behavior/concurrency characterization matrix

Before refactoring, enumerate every public `RemoteSecurityStore` method and map existing SQLite/PostgreSQL tests for:

- success;
- expiry;
- role authorization;
- replay/idempotency;
- quota;
- revocation;
- concurrent refresh/completion;
- operator activity.

Add missing behavior tests before changing SQL. In particular add:

- two clients validating concurrently do not block/delete each other;
- refresh rotation races produce the existing one-winner/replay result;
- role change and access validation race has no unauthorized success after commit;
- pending-flow quota under concurrent creation remains bounded;
- a mutation preserves unrelated rows byte-for-byte/field-for-field.
- administrative mutation generation advances exactly once on role/revoke or pending-state transition, is checked atomically, and does not advance on access-validation/last-used touches;

Run SQLite and required PostgreSQL suites:

```sh
pnpm --filter @caplets/core test -- test/remote-security-storage.test.ts
CAPLETS_REQUIRE_TEST_POSTGRES=1 CAPLETS_TEST_POSTGRES_URL="$CAPLETS_TEST_POSTGRES_URL" \
  pnpm --filter @caplets/core test -- test/remote-security-storage.postgres.test.ts
```

Expected baseline: all characterization tests pass before the refactor. If not, split the discovered correctness defect into a preceding plan.

### 2. Add private row repository helpers

Within `remote-security.ts` (or one adjacent internal module if size materially improves), add dialect-paired helpers for single-row reads/writes. Match the repository's pattern of explicit `Sqlite...Database` and `Postgres...Database` aliases; avoid a generic ORM abstraction that hides sync/async differences.

Start with read-only methods: access validation lookup, cursor-page clients list/detail, and cursor-page pending-login list/detail. Validate row parsing with the existing `parseRole`/`parsePendingStatus` helpers. Preserve Plan 000's stable sort keys and filter-bound cursor inputs; do not reconstruct all rows before paging.

Run both suites. Expected: unchanged results.

### 3. Convert client/access operations

Refactor in this order:

1. `validateAccessToken`
2. `listClients`
3. `changeClientRole`
4. `revokeClient`
5. pairing-code exchange/client creation
6. refresh-token rotation and replay

For every administrative mutation, compare the supplied mutation generation and advance it in the same transaction as the row change and operator activity. Access-token validation may update last-used metadata without changing that generation. Delete the full-state `update` call only after all methods in that family use row operations.

Add a test-only query tracer or database wrapper that fails if a converted method issues an unqualified `DELETE` against any remote-security table. Do not assert source text.

Run both suites after each family. Expected: exit 0.

### 4. Convert pending-login operations

Refactor create, cursor-page/detail reads, poll, refresh, operator approve/deny, cancel, and complete. Preserve:

- 64 global active-flow limit;
- 8 active flows per source;
- operator-code and flow TTLs;
- completion/pending-refresh replay encryption;
- terminal retention;
- bounded superseded hashes.

Use SQL `COUNT`/targeted predicates for quota. Serialize concurrent absence-sensitive quota creation with a scoped lock. Add PostgreSQL tests proving 9 concurrent same-source creations yield at most 8 active flows.

Run both suites. Expected: exit 0.

### 5. Isolate aggregate migration paths

After all runtime methods are converted:

- rename aggregate helpers to include `LegacyMigration`/`Snapshot` in their names;
- make normal operations unable to call `save*State`;
- preserve `importLegacy...` and `verifyLegacy...` behavior;
- document why the remaining global lock exists only on snapshot migration.

Run:

```sh
pnpm --filter @caplets/core test -- test/remote-security-storage.test.ts test/legacy-migration.test.ts
CAPLETS_REQUIRE_TEST_POSTGRES=1 CAPLETS_TEST_POSTGRES_URL="$CAPLETS_TEST_POSTGRES_URL" \
  pnpm --filter @caplets/core test -- test/remote-security-storage.postgres.test.ts test/host-storage-domain-parity.postgres.test.ts
```

Expected: exit 0 with no skips in the PostgreSQL command.

### 6. Measure query shape and finish

Add a deterministic benchmark/test fixture with at least 1,000 clients and pending rows. Assert query count/affected-row shape for access validation and role change remains constant as unrelated row count grows. Do not assert wall-clock milliseconds in CI.

Run:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm --filter @caplets/core test
```

Add a patch changeset only if public behavior or errors changed; otherwise mark the PR `no changeset` per repository policy.

## Done criteria

- Normal access validation performs indexed lookup and targeted touch, not six full-table reads.
- Normal mutations never delete/reinsert unrelated remote-security rows.
- PostgreSQL locks affected rows or narrowly keyed creation domains, not one global remote-security lock for every action.
- Legacy snapshot import/verify remains correct and is the only aggregate path.
- All replay, quota, expiry, role, activity, and concurrency contracts pass on SQLite and PostgreSQL.
- Plan 000 ETag/precondition behavior remains correct because row mutations compare and advance administrative generations atomically while incidental touches do not.
- Query-shape proof is cardinality-independent.
- Format, lint, typecheck, and focused/full core tests exit 0.

## Escape hatches

- If any public method depends on a cross-table invariant that cannot be maintained with row locks, retain a scoped transaction/advisory lock for that invariant and document the exact key. Do not fall back to full-table rewrite.
- If a required lookup lacks an index, capture `EXPLAIN` on both dialects before adding one. Add matching SQLite/PostgreSQL schema and migration changes together.
- If behavior differs between current SQLite and PostgreSQL aggregate paths, STOP and resolve which is authoritative before refactoring.
- If test data reveals raw token storage/indexing, stop and treat it as a separate security incident; never migrate raw tokens into indexes.

## Maintenance note

The schema is relational; runtime code should preserve that depth. Future remote-security fields need targeted row ownership, indexes for hot lookups, transaction invariants, and both-dialect concurrency tests—not additions to a process-wide aggregate rewrite.
