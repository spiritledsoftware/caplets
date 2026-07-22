# Plan 015: Separate Compact Catalog Reads from Full Content

> Status: TODO
> Planned against: `ac12a174`
> Finding: #15 — catalog list/search parses full community Markdown content
> Priority: P1
> Effort: M
> Fix risk: MEDIUM

## Why this matters

Catalog list/search requests need metadata and install counts, but `listCatalogEntries` selects every community `entry_json`, parses it into a full `CatalogEntry`, and only then discards `contentMarkdown` in `listCompactCatalogEntries`. Detail lookup likewise loads all entries and searches in memory. As community indexing grows, D1 bytes, JSON parse cost, and Worker memory scale with full content for every list request.

This plan adds an explicit compact read model while retaining full content for detail pages.

## Scope

### In scope

- `apps/catalog/migrations/` with a new monotonic migration
- `apps/catalog/src/lib/catalog-store.ts`
- Catalog ingest/write path that persists community entries
- Catalog API/store tests
- Optional generated catalog seed/index writer if it writes D1 rows

### Out of scope

- Search ranking redesign
- External search service
- Official catalog Markdown format or Caplet runtime semantics
- Removing `contentMarkdown` from detail responses
- Changing install-count behavior

## Current state

`apps/catalog/src/lib/catalog-store.ts:16-55` calls `readCommunityEntries`, combines with official entries, and returns full records. `listCompactCatalogEntries` then maps each record to omit `contentMarkdown`. `getCatalogEntry` calls the full list and finds by key.

`readCommunityEntries` at `catalog-store.ts:83-94` executes:

```ts
select entry_json as entryJson from catalog_entries
```

and parses every complete `CatalogEntry`.

`apps/catalog/migrations/0001_catalog.sql:7-16` stores one `entry_json` text blob plus indexed repository metadata.

## Required design

Add a nullable `summary_json` column to `catalog_entries` through `0002_catalog-entry-summary.sql` and backfill existing rows with SQLite JSON functions:

```sql
alter table catalog_entries add column summary_json text;
update catalog_entries
set summary_json = json_remove(entry_json, '$.contentMarkdown')
where summary_json is null;
```

Verify Cloudflare D1 supports the required JSON function before relying on it. If not, use a one-time application migration script that is idempotent and separately invoked by deployment; do not leave old rows permanently on the slow path.

Write-path rule: every community insert/update stores `entry_json` and `summary_json` from the same parsed `CatalogEntry` in one statement/transaction.

Read-path rule:

- `listCompactCatalogEntries`: select/parse only `summary_json` plus count/suppression overlays.
- `getCatalogEntry(entryKey)`: select one full `entry_json` by primary key, then merge official/community precedence and overlays without loading unrelated entries.
- Official entries may remain in the generated in-memory module; map them to compact form without cloning full Markdown strings unnecessarily.
- If a legacy row has `summary_json IS NULL`, fail a deployment check or perform a bounded repair; do not silently parse every full row on every request.

Define a durable `CompactCatalogEntry` type at the store/API seam instead of `Omit<CatalogEntryRecord, "contentMarkdown">` if that makes accidental full-content reads harder.

## Implementation steps

### 1. Add query-shape characterization tests

In `apps/catalog/test/`, add D1 fakes/fixtures that record SQL and returned columns. Prove:

- compact list result excludes `contentMarkdown`;
- list query does not select `entry_json` after migration;
- detail query filters by `entry_key` and returns full content;
- suppression, official/community precedence, count overlays, and ranking remain unchanged;
- malformed `summary_json` fails safely and identifies the row without exposing content.

Use behavior/query-column assertions, not source-text matching.

Run:

```sh
pnpm --filter @caplets/catalog test
```

Expected before implementation: compact list obtains full `entry_json`, and detail reads all rows.

### 2. Add and test migration 0002

Create the migration with backfill. Test it against a temporary SQLite/D1-compatible database populated from the 0001 schema:

- old full rows gain a valid summary;
- summary contains all compact API fields and no `contentMarkdown`;
- migration is run exactly once through normal migration tooling;
- new nullable column does not break rollback/read during a staggered deploy.

If repository migration tests have no D1 executor, add the smallest existing-tool harness; do not introduce a second migration framework.

### 3. Update community write paths

Locate every insert/upsert of `catalog_entries`. Build `summary_json` from a typed compact projection in application code, not ad hoc JSON deletion strings in multiple callers. Persist full and compact JSON together.

Add tests proving an update changes both projections and that a failed write cannot leave them divergent.

Run catalog tests. Expected: exit 0.

### 4. Split list and detail repositories

Implement:

```ts
listCompactCatalogEntries(env): Promise<CompactCatalogEntryRecord[]>
getCatalogEntry(entryKey, env): Promise<CatalogEntryRecord | undefined>
```

Do not implement compact list by calling the full list. For detail, query one community row and compare with the one official entry for the key. Preserve suppression and install-count display.

Update API routes to call the narrow method they need. Delete the old full-list helper if no caller genuinely needs all content.

Run:

```sh
pnpm --filter @caplets/catalog test
pnpm --filter @caplets/catalog typecheck
```

Expected: exit 0.

### 5. Verify deployed query behavior

Run the catalog locally with a fixture containing many large `contentMarkdown` values. Request compact list/search and one detail. Observe D1 query logs or fake metrics:

- compact path transfers summary bytes only;
- detail path transfers one full row;
- response JSON remains compatible.

Then run:

```sh
pnpm format:check
pnpm lint
pnpm build
```

Expected: exit 0.

No package changeset is required for the private catalog app unless a public core type changes.

## Done criteria

- Compact list/search never selects or parses community `entry_json`.
- Detail lookup reads at most the requested community row.
- Existing rows are backfilled; new writes update full and compact projections atomically.
- Suppression, ranking, precedence, counts, and response shape remain covered.
- Migration, catalog tests/typecheck, format, lint, and build exit 0.
- Browser/API smoke confirms compact and detail paths.

## Escape hatches

- If D1 lacks `json_remove`, STOP and provide an idempotent deploy-time backfill command with row counts and retry behavior. Do not depend on a perpetual request-time fallback.
- If official/community precedence permits multiple community rows per logical entry, resolve that invariant before changing detail lookup; do not assume primary-key uniqueness beyond schema evidence.
- If API clients depend on an undocumented full-content list field, treat that as a compatibility decision and add an explicit full-detail endpoint rather than retaining accidental overfetch.

## Maintenance note

Full Markdown is detail data. New catalog list/search features should extend the compact projection and backfill it in the same migration; they must not reintroduce full-row scans.
