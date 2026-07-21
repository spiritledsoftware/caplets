# Plan 016: Add First-Class Caplet Authoring Preflight

> Status: TODO
> Planned against: `ac12a174`
> Direction option: #1 — first-class authoring preflight
> Priority: Product bet
> Effort: M
> Fix risk: MEDIUM

## Why this matters

Tool builders are a primary audience, but the public lifecycle validates Caplets mainly while adding/installing them. Authors need one local, non-mutating command that exercises the canonical parser, bundle boundaries, local references, runtime route planning, and static readiness before publication. Without it, each catalog contributor or internal author reconstructs checks from schemas and failed installs.

This plan ships a static preflight only. It does not start backends or require Vault values.

## Scope

### In scope

- `packages/core/src/caplet-source/parse.ts` and existing filesystem/snapshot sources by reuse
- A new internal authoring validation module under `packages/core/src/caplet-source/`
- `packages/core/src/cli.ts`
- `packages/core/src/cli/commands.ts`
- CLI completion/reference docs generated from source
- Focused parser/CLI tests
- Changesets for `@caplets/core` and `caplets` as release policy requires

### Out of scope

- Publishing to the catalog
- Starting or health-checking MCP/API/CLI backends
- Resolving or revealing Vault values
- Granting Project Binding or remote access
- A web authoring UI
- Trust/risk certification badges

## Current state and canonical seams

`parseCapletSource` at `packages/core/src/caplet-source/parse.ts:49-177` already:

- loads the file map through `loadCapletFilesFromMap`;
- runs canonical config parsing;
- plans hosted runtime routes;
- computes declared-input fingerprints;
- reports missing/unreadable/out-of-root local references.

`FilesystemCapletSource` at `caplet-source/filesystem.ts:11-86` safely roots reads and rejects escapes. Caplet Record import has stricter bundle count/size/path checks in `storage/caplet-records.ts`; preflight must reuse or extract those validations rather than creating weaker limits.

CLI command names and completion inventory live in `packages/core/src/cli/commands.ts`. CLI docs are generated and checked by `pnpm docs:check`.

## Public contract

Add:

```sh
caplets validate <path> [--json]
```

- `<path>` may be a Caplet source directory or a `CAPLET.md`/top-level Markdown Caplet file. A file input uses its containing directory as the source root but validates only the selected Caplet family; it must not accidentally validate unrelated sibling Caplets.
- The command performs no writes and starts no processes.
- Human output groups errors/warnings by path and ends with a one-line summary.
- `--json` writes exactly one JSON object to stdout; diagnostics/progress go to stderr only.
- Exit 0: valid, including warnings.
- Exit 1: authoring validation errors.
- Commander usage/configuration errors retain the CLI's existing exit behavior.

Versioned JSON shape:

```ts
type CapletValidationReport = {
  schemaVersion: 1;
  ok: boolean;
  sourceRoot: string;
  caplets: Array<{
    id: string;
    sourcePath: string;
    backend: string;
    runtimeRoute: string;
    setupRequired: boolean;
    authRequired: boolean;
    projectBindingRequired: boolean;
  }>;
  warnings: Array<{ code: string; path?: string; message: string }>;
  errors: Array<{ code: string; path?: string; message: string }>;
};
```

Paths in JSON are normalized relative paths, never absolute private filesystem paths.

## Validation phases

1. **Source selection:** path exists, file/directory semantics, no escape/symlink traversal.
2. **Canonical parse:** frontmatter/schema/backend/child naming through `parseCapletSource`.
3. **Bundle safety:** file count, per-file bytes, total bytes, normalized paths, duplicate/case-collision policy, executable metadata. Extract a pure validator from Caplet Record import if needed.
4. **Declared inputs:** all referenced scripts/specs exist, stay within root, and are readable.
5. **Static runtime readiness:** report route, setup/auth/Project Binding requirements and obviously unavailable local executable paths. Do not probe networks or require secrets.

Diagnostics need stable codes; messages can evolve. Reuse `CapletsError` codes where meaningful but keep authoring-specific codes such as `source_missing`, `bundle_too_large`, `reference_missing`, and `executable_unavailable`.

## Implementation steps

### 1. Specify report behavior in tests

Add core tests with fixture directories for:

- valid single Caplet;
- valid parent/child Caplets;
- missing referenced OpenAPI/GraphQL/script file;
- traversal/symlink escape;
- duplicate/invalid bundle path;
- bundle limit breach using injected small limits (do not allocate 256 MiB);
- file input with unrelated invalid sibling Caplet;
- warning-only valid result;
- normalized non-secret JSON paths.

Run:

```sh
pnpm --filter @caplets/core test -- test/caplet-source.test.ts test/cli.test.ts
```

Expected before implementation: CLI/report tests fail.

### 2. Extract pure bundle validation

Refactor `prepareBundle` validation from `storage/caplet-records.ts` into a pure, storage-neutral helper that accepts source file metadata and injectable limits. Both record import and authoring preflight must call it. Preserve record import error behavior.

Do not read every file twice: source enumeration should capture byte lengths/content needed by parse and bundle checks once.

Run Caplet Record and source tests. Expected: existing import behavior remains green.

### 3. Build the authoring validator

Compose source selection, `FilesystemCapletSource`, `parseCapletSource`, pure bundle checks, and static readiness into one exported internal function returning `CapletValidationReport`. Sort caplets and diagnostics deterministically.

For a file input, introduce a filtered source view rather than copying to a temporary directory. Preserve declared-input resolution relative to the containing directory.

Run source tests. Expected: exit 0.

### 4. Add CLI command and output

Register `validate` in `cliCommands`, `topLevelCommandNames`, Commander setup, completion, and dispatch. Follow existing `--json` command behavior: stdout contains structured result only. Human formatting should be concise and actionable without locking prose in tests.

Add CLI process tests for exit codes, JSON schema shape, no writes, and stdout/stderr separation. Do not assert exact help paragraphs.

Run:

```sh
pnpm --filter @caplets/core test -- test/cli.test.ts test/cli-completion.test.ts test/caplet-source.test.ts
```

Expected: exit 0.

### 5. Generate docs and smoke test

Update generated CLI reference through its source pipeline:

```sh
pnpm docs:generate
pnpm docs:check
pnpm build
node packages/cli/dist/index.js validate caplets/github --json
```

Expected: generated docs are current; smoke output is one valid report object and exit 0 for a committed Caplet fixture.

Add appropriate changesets. Then run format, lint, and typecheck.

## Done criteria

- One non-mutating command validates file or directory sources through canonical parser and bundle rules.
- Record import and preflight share bundle validation.
- JSON output is versioned, deterministic, path-safe, and stdout-clean.
- Exit codes distinguish valid from invalid authoring input.
- No backend starts, Vault resolution, grants, or network probes occur.
- Focused tests, generated docs check, format, lint, typecheck, build, and CLI smoke pass.

## Escape hatches

- If single-file selection cannot identify its parent/child family unambiguously, STOP and require a directory rather than validating unrelated siblings or inventing selection rules.
- If static executable readiness would require shell/path mutation or process execution, report it as an informational requirement; do not turn static preflight into a health check.
- If extracted bundle rules expose incompatible filesystem vs SQL limits, STOP and define which constraints publication/import must share before shipping the command.

## Maintenance note

Every authoring rule that can block add/install/publication should have one stable diagnostic code and run through this preflight. The command is the contract; catalog UI and future editor integrations should consume its JSON rather than reimplement validation.
