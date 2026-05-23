# Coding Agent Showcase Caplets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add high-value premade Caplets for coding agents covering HTTP, OpenAPI, MCP, CLI, and CapletSet backends while intentionally skipping GraphQL for now.

**Architecture:** Add top-level registry Caplets for OSV, npm, PyPI, DeepWiki, Sourcegraph, and Playwright. Add a `coding-agent-toolkit` CapletSet whose nested child entries are symlinks to the canonical top-level examples, and update install behavior so selected directory Caplet installs materialize internal symlinks as real files/directories.

**Tech Stack:** Caplets Markdown manifests, local and remote OpenAPI YAML specs, HTTP action backend, OpenAPI backend, MCP backend, CapletSet backend, Node `fs.cpSync`, Vitest.

---

## Scope

- Add `osv` using `httpApi`.
- Add `npm` using `openapiEndpoint.specUrl` pointed at npm's published OpenAPI YAML.
- Add `pypi` using `openapiEndpoint` and a curated local `pypi.openapi.yaml`.
- Add `deepwiki`, `sourcegraph`, and `playwright` using `mcpServer`.
- Add `coding-agent-toolkit` using `capletSet` with symlinked child Caplets.
- Preserve canonical GitHub as `github` MCP and do not add GitHub REST/GraphQL.
- Skip GraphQL-backed showcase examples for now.

## Files

- Modify: `packages/core/src/cli/install.ts` to dereference symlinks when copying directory Caplets.
- Modify: `packages/core/test/cli.test.ts` to verify selected installs of symlinked toolkit children are self-contained.
- Create: `caplets/osv/CAPLET.md`.
- Create: `caplets/npm/CAPLET.md`.
- Create: `caplets/pypi/CAPLET.md` and `caplets/pypi/pypi.openapi.yaml`.
- Create: `caplets/deepwiki/CAPLET.md`.
- Create: `caplets/sourcegraph/CAPLET.md`.
- Create: `caplets/playwright/CAPLET.md`.
- Create: `caplets/coding-agent-toolkit/CAPLET.md` and symlinks under `caplets/coding-agent-toolkit/caplets/`.
- Modify: `packages/core/test/config.test.ts` to assert the new repository examples load.
- Modify: `README.md` to list the new examples and clarify toolkit behavior.

## Task 1: Symlink Materialization In Selected Directory Installs

**Files:**

- Modify: `packages/core/src/cli/install.ts`
- Modify: `packages/core/test/cli.test.ts`

- [ ] **Step 1: Add a failing install test**

Add a test near the existing install tests that creates `caplets/osv/CAPLET.md`, `caplets/coding-agent-toolkit/CAPLET.md`, and a symlink `caplets/coding-agent-toolkit/caplets/osv -> ../../osv`. Run `installCaplets(repo, { capletIds: ["coding-agent-toolkit"], destinationRoot })` and assert `destinationRoot/coding-agent-toolkit/caplets/osv/CAPLET.md` exists and `lstatSync(destinationRoot/coding-agent-toolkit/caplets/osv).isSymbolicLink()` is `false`.

- [ ] **Step 2: Run the focused test and observe failure**

Run: `CAPLETS_MODE=local pnpm --filter @caplets/core test test/cli.test.ts`

Expected before implementation: the new assertion fails because copied child entries remain symlinks or selected install is not self-contained.

- [ ] **Step 3: Implement symlink materialization**

In `copyInstallPath`, call `cpSync` with `dereference: plan.kind === "directory"` so symlinks inside directory Caplets are copied as their targets while file Caplet behavior remains unchanged.

- [ ] **Step 4: Run the focused test again**

Run: `CAPLETS_MODE=local pnpm --filter @caplets/core test test/cli.test.ts`

Expected: PASS.

## Task 2: OSV HTTP Caplet

**Files:**

- Create: `caplets/osv/CAPLET.md`

- [ ] **Step 1: Add OSV manifest**

Create an HTTP Caplet named `OSV Vulnerabilities` with `baseUrl: https://api.osv.dev`, `auth: { type: none }`, and actions:

- `query_package_version`: `POST /v1/query`, body with `package.name`, `package.ecosystem`, `version`, optional `page_token`.
- `query_purl`: `POST /v1/query`, body with `package.purl`, optional `page_token`.
- `query_commit`: `POST /v1/query`, body with `commit`, optional `page_token`.
- `query_batch`: `POST /v1/querybatch`, body `queries: $input.queries`.
- `get_vulnerability`: `GET /v1/vulns/{id}`.
  Mark every action read-only.

- [ ] **Step 2: Run focused config test**

Run: `CAPLETS_MODE=local pnpm --filter @caplets/core test test/config.test.ts`

Expected: PASS once loadability assertions are updated in Task 7; before Task 7, this at minimum must not introduce parse errors.

## Task 3: NPM OpenAPI Caplet

**Files:**

- Create: `caplets/npm/CAPLET.md`

- [ ] **Step 1: Add npm Caplet manifest**

Create `caplets/npm/CAPLET.md` with `openapiEndpoint.specUrl` pointed at npm's published OpenAPI YAML, `auth.type: none`, and docs explaining that the spec is loaded remotely.

## Task 4: PyPI OpenAPI Caplet

**Files:**

- Create: `caplets/pypi/CAPLET.md`
- Create: `caplets/pypi/pypi.openapi.yaml`

- [ ] **Step 1: Add curated PyPI OpenAPI spec**

Create a small OpenAPI 3.0.3 spec with `servers: [{ url: https://pypi.org }]` and operations:

- `GET /pypi/{project}/json` for latest project JSON metadata.
- `GET /pypi/{project}/{version}/json` for release-specific JSON metadata.
- `GET /simple/{project}/` with `Accept: application/vnd.pypi.simple.v1+json` header parameter for Simple API JSON project detail.
  Use operation IDs `get_project`, `get_release`, and `get_simple_project`.

- [ ] **Step 2: Add PyPI Caplet manifest**

Create `caplets/pypi/CAPLET.md` with `openapiEndpoint.specPath: ./pypi.openapi.yaml`, `auth.type: none`, and docs explaining JSON API and Simple API coverage.

## Task 5: MCP Caplets

**Files:**

- Create: `caplets/deepwiki/CAPLET.md`
- Create: `caplets/sourcegraph/CAPLET.md`
- Create: `caplets/playwright/CAPLET.md`

- [ ] **Step 1: Add DeepWiki MCP Caplet**

Create a DeepWiki MCP Caplet using the best known MCP connection from repository conventions. If no public endpoint is documented, use `url: https://mcp.deepwiki.com/mcp` with `transport: http` and document that hosted endpoint availability may depend on DeepWiki's current MCP service.

- [ ] **Step 2: Add Sourcegraph MCP Caplet**

Create Sourcegraph MCP with `url: https://sourcegraph.com/.api/mcp`, `transport: http`, and `auth.type: oauth2`. Document that self-managed users should change the host to `https://<sourcegraph-host>/.api/mcp` and may use access-token headers if their instance does not support OAuth/DCR.

- [ ] **Step 3: Add Playwright MCP Caplet**

Create Playwright MCP using stdio: `command: npx`, args `-y`, `@playwright/mcp@latest`, `--headless`. Document that removing `--headless` enables a visible browser and that advanced users can use a config file.

## Task 6: Symlinked Coding Agent Toolkit CapletSet

**Files:**

- Create: `caplets/coding-agent-toolkit/CAPLET.md`
- Create symlinks under: `caplets/coding-agent-toolkit/caplets/`

- [ ] **Step 1: Add toolkit manifest**

Create `caplets/coding-agent-toolkit/CAPLET.md` with `capletSet.capletsRoot: ./caplets`, tags `coding-agent`, `toolkit`, `caplets`, and body explaining the toolkit is symlink-backed in the source repository but materialized when installed.

- [ ] **Step 2: Add child symlinks**

Create symlinks:

- `ast-grep -> ../../ast-grep`
- `repo-cli -> ../../repo-cli`
- `osv -> ../../osv`
- `npm -> ../../npm`
- `pypi -> ../../pypi`
- `deepwiki -> ../../deepwiki`
- `sourcegraph -> ../../sourcegraph`
- `playwright -> ../../playwright`

## Task 7: Repository Docs And Loadability Tests

**Files:**

- Modify: `packages/core/test/config.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Extend repository example loadability assertions**

Assert that `config.httpApis.osv`, `config.openapiEndpoints.npm`, `config.openapiEndpoints.pypi`, `config.mcpServers.deepwiki`, `config.mcpServers.sourcegraph`, `config.mcpServers.playwright`, and `config.capletSets["coding-agent-toolkit"]` load with representative fields.

- [ ] **Step 2: Update README example list**

Add bullets for `osv`, `npm`, `pypi`, `deepwiki`, `sourcegraph`, `playwright`, and `coding-agent-toolkit`. Note that GraphQL is intentionally not included in this showcase batch.

- [ ] **Step 3: Run focused tests**

Run: `CAPLETS_MODE=local pnpm --filter @caplets/core test test/config.test.ts test/cli.test.ts`

Expected: PASS.

## Task 8: Final Verification

**Files:**

- Verify all changed files.

- [ ] **Step 1: Run format check**

Run: `pnpm format:check`

Expected: PASS.

- [ ] **Step 2: Run schema check**

Run: `pnpm schema:check`

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 4: Run focused tests**

Run: `CAPLETS_MODE=local pnpm --filter @caplets/core test test/config.test.ts test/cli.test.ts`

Expected: PASS.

- [ ] **Step 5: Inspect diff and symlinks**

Run: `git status --short` and inspect the diff for the changed files. Confirm toolkit child entries are symlinks in the source repo and materialized by install tests.

## Self-Review

- Spec coverage: Covers the final approved list, skips GraphQL, keeps GitHub consolidated, and handles symlinked toolkit install behavior.
- Placeholder scan: No placeholders or TBDs remain.
- Type consistency: Uses existing `mcpServer`, `httpApi`, `openapiEndpoint`, `capletSet`, `inputSchema`, `jsonBody`, and `annotations` frontmatter fields.
