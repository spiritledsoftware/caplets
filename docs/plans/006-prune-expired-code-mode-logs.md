# Plan 006: Physically Prune Expired Code Mode Logs

> Status: TODO
> Planned against: `ac12a174`
> Finding: #6 — expired logs are hidden but retained on disk
> Priority: P0
> Effort: S
> Fix risk: LOW

## Why this matters

`CodeModeLogStore.read` treats expired references as absent, but the backing file remains on disk. On a long-running host, one-hour TTL therefore provides retrieval semantics but no storage-retention guarantee. Log text is redacted before storage, yet still contains operational detail and consumes unbounded disk.

This plan makes TTL a physical retention boundary without introducing a background daemon.

## Scope

### In scope

- `packages/core/src/code-mode/logs.ts`
- `packages/core/test/code-mode-logs.test.ts`
- One patch changeset for `@caplets/core`

### Out of scope

- Changing redaction patterns or the one-hour default TTL
- Remote/object-store log retention
- Operator audit logs
- A new global scheduler or database table

## Current state

The tests at `packages/core/test/code-mode-logs.test.ts:74-90` create a log with a one-millisecond TTL and assert `read` returns no entries after expiry. They then remove the whole temporary directory, so they do not assert that the expired log file itself disappeared.

`packages/core/src/code-mode/logs.ts` owns the directory, ref TTL, file naming, store, and read logic. Keep retention inside that module.

## Required design

Add two behaviors:

1. **Read-through deletion:** when `read(logRef)` identifies an expired entry, unlink its file before returning an empty result. Missing files remain a safe no-op.
2. **Opportunistic sweep:** before or after a successful `store`, scan only the direct log directory and delete expired well-formed log files. Throttle scans per store instance (for example once per minute) to avoid an O(file-count) directory walk on every run.

Safety rules:

- Only files matching the store's own exact filename grammar are candidates.
- Parse stored metadata with the existing safe parser; malformed or unrelated files are not deleted.
- Resolve candidate paths inside the configured log directory.
- Treat `ENOENT` as a race-safe success.
- A deletion failure must not make an otherwise valid Code Mode run fail; surface it only through an existing optional warning/log seam if one exists.
- Never follow symlinks outside the log directory. Use `lstat`/Dirent checks and skip non-regular files.

## Implementation steps

### 1. Strengthen retention tests

Extend `packages/core/test/code-mode-logs.test.ts` with:

- an expired `read` removes the exact backing file;
- a later `store` sweeps a different expired file that was never read;
- a fresh file remains;
- malformed JSON, unrelated filenames, directories, and symlinks are not deleted;
- concurrent read/sweep deletion tolerates `ENOENT`;
- sweep throttling avoids a second directory scan inside the throttle interval (inject `now` and filesystem operations if needed).

Assert observable files with `existsSync`/directory reads, not private method calls.

Run:

```sh
pnpm --filter @caplets/core test -- test/code-mode-logs.test.ts
```

Expected before implementation: physical deletion tests fail.

### 2. Implement safe deletion primitives

Add small private helpers:

```ts
isOwnedLogFilename(name: string): boolean
removeExpiredLog(path: string, now: Date): boolean
sweepExpiredLogs(now: Date): void
```

Reuse the same expiration calculation as `read`; do not create a second TTL interpretation. Prefer async filesystem methods only if the public store API is already async. Avoid blocking a hot path with repeated directory scans; the throttle is required.

Run the focused test. Expected: exit 0.

### 3. Verify runner integration

Run Code Mode runner tests to ensure opportunistic cleanup does not alter envelope/log-reference behavior:

```sh
pnpm --filter @caplets/core test -- test/code-mode-logs.test.ts test/code-mode-runner.test.ts
pnpm typecheck
```

Expected: exit 0.

### 4. Record the retention fix

Add a patch changeset for `@caplets/core` stating that expired local Code Mode log artifacts are physically removed. Then run:

```sh
pnpm format:check
pnpm lint
```

Expected: exit 0.

## Done criteria

- Reading an expired log reference removes its owned regular file.
- Stale unread logs are eventually removed by throttled opportunistic sweeps.
- Fresh, malformed, unrelated, directory, and symlink entries are preserved.
- Cleanup races and deletion failures do not fail Code Mode execution.
- Focused tests, format, lint, and type checks exit 0.

## Escape hatches

- If log filenames do not contain enough trusted information to identify candidates, parse file metadata but keep an exact prefix/suffix allowlist; do not delete every JSON file in the directory.
- If the log directory is shared across processes, retain race tolerance and never introduce an exclusive global lock solely for cleanup.
- If compliance requires deterministic cleanup at the exact TTL, STOP and propose a host-level scheduled retention service; opportunistic cleanup is intentionally eventual.

## Maintenance note

TTL-backed artifact stores must define both retrieval expiry and physical deletion. Future media/log stores should expose a safe prune operation and avoid assuming that hiding an expired reference frees storage.
