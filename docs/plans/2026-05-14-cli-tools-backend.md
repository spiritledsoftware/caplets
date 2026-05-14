# CLI Tools Backend For Caplets

## Summary

Add a fifth backend, `cliTools`, that exposes curated command-line workflows as typed Caplets tools. Runtime execution is deterministic and shell-free: Caplets maps declared JSON inputs into `spawn(command, args)` calls, returns bounded structured results, and never exposes arbitrary bash.

Also add `caplets author cli` to generate reviewable CLI Caplet manifests from repo/package metadata and curated templates for `git`, `gh`, and the detected package manager. Generation prints to stdout by default.

## Key Changes

- Add `cliTools` to config and Caplet frontmatter alongside `mcpServers`, `openapiEndpoints`, `graphqlEndpoints`, and `httpApis`.
- Use an `actions` map shape, mirroring `httpApis.actions`:
  - action key is the downstream tool name.
  - each action supports `description`, `inputSchema`, optional `outputSchema`, `command`, `args`, `env`, `cwd`, `timeoutMs`, `maxOutputBytes`, `output`, and MCP annotations.
- Execute with `spawn(command, args)` only; no shell mode in v1.
- Support `$input.foo` interpolation inside argv/env/cwd strings.
- Apply basic runtime input validation for required fields and primitive JSON Schema types before spawning.
- Default limits: `timeoutMs: 60000`, `maxOutputBytes: 1000000`, configurable at Caplet and action level.
- Return CLI results as structured content:
  - `{ exitCode, stdout, stderr, elapsedMs }`
  - `isError: true` for non-zero exits.
  - optional stdout JSON parsing when `output.type: "json"` is declared.
- `check_backend` validates manifest shape, cwd/env resolution, command availability, and tool count without running configured actions.
- `list_tools`, `search_tools`, `get_tool`, `call_tool`, and field selection should work consistently with existing backends.
- Load user-root CLI Caplets normally; load project `.caplets` CLI Caplets only under the existing `CAPLETS_TRUST_PROJECT_CAPLETS` gate.

## Authoring UX

- Add `caplets author cli <id>` with scriptable flags:
  - `--repo <path>` to inspect a repository.
  - `--include git,gh,package` to choose generators/templates.
  - `--command <name>` for single-CLI generation.
  - `--output -` by default, with explicit file output supported.
- Heuristic generator only in v1; no OpenAI/API/agent dependency.
- Repo workflow generation should inspect package scripts and lockfiles, then generate safe tools such as test, lint, typecheck, build, repo status, changed files, and PR status when applicable.
- Single-CLI templates should cover `git`, `gh`, and detected package manager commands.
- Generated manifests must be explicit Markdown Caplet files with `cliTools`, not hidden runtime state.

## Docs And Examples

- Update README config docs, Caplet file docs, generated schemas, and backend operation docs.
- Add real bundled CLI examples under `caplets/`, focused on repo maintenance and GitHub workflows.
- Examples should be safe/read-oriented by default; mutating actions must carry clear annotations such as `readOnlyHint: false` and `destructiveHint` where appropriate.

## Test Plan

- Config tests for `cliTools`, duplicate IDs across all five backend maps, Caplet frontmatter loading, project trust behavior, defaults, limits, and invalid command/action shapes.
- CLI manager tests for list/search/get/call, input interpolation, basic validation, JSON output parsing, non-zero exit handling, timeout handling, output byte limits, command-not-found errors, cwd/env behavior, and secret redaction.
- Runtime/registry tests for `cliTools` registration, `check_backend`, reload invalidation, and `caplets list`.
- Authoring tests for stdout output, explicit output path, package-script detection, `git`/`gh` templates, package manager detection, and generated Caplet validation.
- Schema check, typecheck, focused tests, full `pnpm verify`.

## Assumptions

- V1 intentionally excludes shell snippets, conditional argv construction, full JSON Schema validation, LLM-assisted generation, and automatic installation into the user Caplets root.
- Complex workflows should be modeled as package scripts or wrapper executables, then called through typed `cliTools` actions.
- Caplets surfaces risk annotations but does not block declared mutating tools at runtime; client approval remains outside Caplets.
