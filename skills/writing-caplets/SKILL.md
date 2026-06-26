---
name: writing-caplets
description: Use when creating, updating, reviewing, or validating Caplet files, prebuilt catalog entries, setup/auth metadata, Project Binding declarations, Vault references, runtime requirements, or public install-ready Caplets.
---

# Writing Caplets

## Core Rule

Write Caplets from the schema and nearby examples first, not from memory. Inspect `schemas/caplet.schema.json`, `apps/docs/src/content/docs/reference/caplet-files.mdx`, and similar files under `caplets/` before editing.

Use `skills/caplets` for executing configured Caplets. This skill is for authoring and review.

## Authoring Workflow

1. Pick the backend family that matches the real integration: `mcpServer`, `openapiEndpoint`, `googleDiscoveryApi`, `graphqlEndpoint`, `httpApi`, `cliTools`, or `capletSet`.
2. Keep checked-in entries public-safe: no tokens, credential-bearing URLs, private provider IDs, browser profiles, user home paths, local absolute paths, or account-specific values.
3. Use `$vault:NAME` or `${vault:NAME}` for secrets that the runtime should resolve. Use `$env:NAME` only for non-secret machine-local paths or toggles.
4. Add `projectBinding.required: true` when the Caplet reads, searches, executes, or mutates project files. Explain in the body why the bound root is needed.
5. Add `setup.commands` and `setup.verify` when the backend needs local binaries, browser dependencies, generated specs, or provider setup.
6. Add `runtime.features` only for real runtime requirements such as `browser` or `docker`.
7. Keep the body useful to agents: when to use it, setup, safety, scope notes, and one or two concrete workflows.

## Catalog-Grade Checklist

- Description says what the Caplet lets an agent do, not how the backend is implemented.
- Tags are searchable and not noisy.
- Auth scopes are least-privilege and documented in the body.
- Mutating or destructive capabilities are called out in prose, auth scopes, CLI annotations, or narrowed operation filters.
- Local-control Caplets make risk obvious without adding install-time confirmation.
- Bundled reference files are relative, necessary, and parse under the schema.
- Project-bound entries do not hardcode local absolute paths.

## Validation

Run the narrowest relevant checks after edits:

```sh
pnpm --filter @caplets/core test -- test/caplet-files.test.ts test/catalog-vault.test.ts test/exposure-discovery.test.ts test/config.test.ts test/config-validation.test.ts
pnpm schema:check
pnpm docs:check
```

When schema source changes, run `pnpm schema:generate` and `pnpm docs:generate` before checks.

## Common Mistakes

| Mistake                                                   | Fix                                                                                                       |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Copying a personal config directly                        | Replace paths, profile names, tokens, and account IDs with Vault/env placeholders or public defaults.     |
| Marking a provider ready without a public validation path | Keep it out of the prebuilt catalog until the endpoint, auth model, and validation command are confirmed. |
| Omitting Project Binding for repo tools                   | Add `projectBinding.required: true` and explain the bound-root dependency.                                |
| Hiding risky local control in a toolkit                   | Keep high-risk local-control entries explicit unless the grouping clearly promises that capability.       |
