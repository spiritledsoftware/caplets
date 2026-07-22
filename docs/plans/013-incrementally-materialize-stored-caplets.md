# Plan 013: Incrementally Materialize Stored Caplets

> Status: TODO
> Planned against: `ac12a174`
> Finding: #12 — startup rebuilds every stored bundle twice
> Priority: P1
> Effort: L
> Fix risk: HIGH
> Depends on: Plan 000

## Why this matters

`CapletsEngine.create` loads effective config, then loads a parity config. Each call to `loadConfigWithHostStorage` lists every SQL Caplet Record, fetches and verifies every bundle asset, writes a full staging tree, and atomically replaces the cache. Startup cost is proportional to all bundle bytes twice even when no record changed. Vault-triggered config activation repeats the same pattern.

The cache should be a derived, content-addressed projection: unchanged authoritative revisions require no blob reads or rewrites, while changed revisions materialize atomically and retain file-layer precedence.

Plan 000 replaces Buffer-only bundle reads with metadata descriptors and reopenable streaming file sources for Admin upload/export. This plan must deepen that seam rather than restore a payload-bearing `get` path or introduce a second descriptor model.

## Scope

### In scope

- `packages/core/src/config.ts`
- `packages/core/src/engine.ts`
- `packages/core/src/storage/caplet-records.ts` and Plan 000's bundle descriptor/source interfaces
- New internal cache-manifest types/helpers under `packages/core/src/`
- `packages/core/test/host-storage-config.test.ts`
- Caplet Record storage tests where metadata is extended
- One patch changeset for `@caplets/core`

### Out of scope

- Making SQL records override global/project Caplet files (ADR 0005 forbids this)
- Treating the derived cache as authoritative
- Skipping hash verification for newly fetched blobs
- Changing object-store layout or garbage collection
- Sharing mutable cache state across logical hosts with different storage databases

## Current state

`packages/core/src/config.ts:1914-1916` always calls `materializeStoredCaplets`. That function creates a new staging directory, calls `materializeRuntimeBundle` for every record, swaps it into place, and deletes the backup.

`CapletsEngine.create` at `engine.ts:190-203` invokes this once for the initial config and again through `parityConfigLoader`.

Before implementation, re-read Plan 000's resulting `CapletRecordStore` descriptor and streaming-reader methods. The current `materializeRuntimeBundle` loads every payload for every current revision; this plan must consume metadata first and open only changed revision sources.

## Required design

Use an authoritative runtime projection descriptor:

```ts
type StoredCapletRuntimeDescriptor = {
  id: string;
  recordKey: string;
  revisionKey: string;
  contentHash: string;
  files: Array<{ path: string; hash: string; size: number; executable: boolean }>;
};
```

Use Plan 000's metadata-only storage read, extending it only where the runtime projection needs additional identity. It must return descriptors without payload bytes. Compute a deterministic cache generation hash from sorted descriptors.

Cache layout under the existing `recordCacheRoot` parent:

```text
record-caplets/
  <effective CAPLET trees consumed by current loader>
  .caplets-manifest.json
.record-caplets-objects/
  <descriptor-generation-or-revision-key>/...
```

Rules:

1. If the active manifest's storage identity and generation hash match descriptors and all referenced owned files exist with expected size/mode, return without staging or payload reads.
2. For a changed descriptor, materialize an immutable revision directory once, opening/verifying only its missing streaming file sources.
3. Build the active staging tree using hard links from immutable revision files where supported; fall back to verified copies on cross-device/unsupported errors.
4. `CAPLET.md` and metadata are included in the descriptor fingerprint.
5. Atomically swap the active tree as today. Write the manifest inside staging before rename.
6. Never trust manifest paths: validate normalized bundle paths and ensure all resolved paths remain within owned roots.
7. A corrupt/missing immutable file invalidates only that revision and causes re-fetch/verification.
8. Failed rebuild leaves last-known-good active tree intact and removes incomplete staging/revision directories.
9. Multiple calls in one process for the same root coalesce behind one in-flight promise; concurrent processes use a bounded filesystem lock or generation-specific immutable directories plus atomic winner semantics.
10. Storage identity prevents reusing a manifest from a different SQLite path/PostgreSQL host/schema.

Do not use symlinked Caplet directories: the existing filesystem discovery intentionally ignores symlinks.

## Implementation steps

### 1. Add descriptor and no-op characterization tests

Extend `host-storage-config.test.ts` with a fake `StoredCapletSource` that records descriptor reads, payload materializations, and file writes. Cover:

- first load materializes all records;
- immediate second load performs descriptor read only and no payload materialization;
- changing one revision materializes only that record;
- deleting/corrupting one cached file rematerializes only that revision;
- deleting a record removes it from the active tree;
- global/project file precedence over SQL record remains unchanged;
- failed changed-record materialization leaves the previous active tree usable.

Run:

```sh
pnpm --filter @caplets/core test -- test/host-storage-config.test.ts
```

Expected before implementation: the second load materializes every record again.

### 2. Add metadata-only storage descriptors

In `CapletRecordStore`, reuse or extend Plan 000's metadata-only record/current-revision/bundle query without loading `caplet_asset_blobs.payload`. Do not add a parallel descriptor query and do not call a compatibility helper that materializes all files.

Include a stable storage identity from Host Storage configuration, not credentials. For PostgreSQL, hash normalized host/database/schema identity; never write passwords to the manifest.

Add storage tests that inspect query results and ensure descriptor reads do not request payload columns. Use a query wrapper/spy, not source-text assertions.

Run:

```sh
pnpm --filter @caplets/core test -- test/caplet-record-storage.test.ts test/caplet-record-storage.postgres.test.ts
```

Expected: exit 0 (PostgreSQL may require Plan 003's environment).

### 3. Implement immutable revision materialization

Refactor `materializeRuntimeBundle` so it accepts the known descriptor and opens Plan 000's streaming revision files one at a time, without re-reading metadata or collecting a bundle-wide Buffer array. It must independently verify hashes and sizes while writing. Materialize into a unique temp sibling, fsync/close as existing conventions require, then rename to the immutable target. If another process won the rename, verify the winner and discard the temp tree.

Preserve executable mode bits through hard link/copy behavior. Never mutate an immutable revision directory after publication.

Run storage and host-config tests. Expected: exit 0.

### 4. Build and validate active manifests

Add a versioned manifest with:

- schema version;
- storage identity hash;
- generation hash;
- sorted record descriptors or references sufficient to verify active entries.

Parse it defensively. Unknown version, invalid JSON, path escape, identity mismatch, missing file, size mismatch, or mode mismatch triggers a rebuild, not host failure, unless authoritative rematerialization also fails.

Implement unchanged fast path and changed-only staging. Keep current backup restoration behavior.

Add malicious/corrupt manifest tests, including `../` paths and symlink entries. Expected: safe rebuild; no external file reads/deletes.

### 5. Coalesce engine loads

Ensure the initial config and parity config share the same completed materialization generation. The simplest correct behavior is the manifest fast path; an in-process coordinator can remove even the second descriptor read. Do not cache across a storage mutation without generation comparison.

Add an engine-create test proving one payload materialization pass, then reload tests proving changed records are picked up and last-known-good config survives failures.

Run:

```sh
pnpm --filter @caplets/core test -- test/host-storage-config.test.ts test/engine.test.ts
pnpm typecheck
```

Expected: exit 0.

### 6. Retain and prune immutable revisions safely

After successful active swap, remove unreferenced immutable revision directories older than a safety age. Never delete a directory referenced by the active manifest or an in-progress staging build. Cleanup failure is non-fatal and logged without secrets.

Add tests for current/old/in-progress directories.

### 7. Record and verify

Add a patch changeset for `@caplets/core` describing faster stored-Caplet startup/reload with unchanged precedence. Run:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm --filter @caplets/core test
pnpm build
```

Expected: exit 0.

## Done criteria

- Two unchanged loads fetch descriptors but no bundle payload twice; engine creation performs one materialization pass.
- One revision change reads/writes only that revision.
- Active tree swaps atomically and preserves last-known-good behavior.
- Cache corruption/path escapes/symlinks cause safe rematerialization and cannot access outside owned roots.
- File-layer precedence from ADR 0005 remains unchanged.
- SQLite and PostgreSQL/object-store paths retain hash verification.
- Runtime materialization consumes Plan 000's descriptor/source seam and never reconstructs a whole bundle in memory.
- Focused/full core tests, format, lint, typecheck, and build exit 0.

## Escape hatches

- If the current schema cannot produce a descriptor without payload reads, add a metadata-only query; do not cache based only on Caplet ID or updated timestamp.
- If hard links are unavailable, use verified copies but retain the unchanged-manifest no-op and changed-only payload reads.
- If multiple Host Nodes share the same local cache root, STOP and include host/storage identity in root ownership before enabling cleanup.
- If cache generation changes can race authoritative config reload across processes, preserve atomic generation directories and never mutate a published active tree in place.

## Maintenance note

The derived filesystem tree is a cache projection, not a second source of truth. Any future revision field that affects runtime must enter the descriptor hash and manifest validation in the same change.
