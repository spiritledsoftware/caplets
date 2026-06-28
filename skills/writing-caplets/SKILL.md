---
name: writing-caplets
description: Use when creating, updating, reviewing, or validating Caplet files in any project or user environment, including Caplet manifests, agent-facing Caplet bodies, setup/auth metadata, Project Binding declarations, Vault references, runtime requirements, Caplet sets, or install-ready Caplets for private or public use.
---

# Writing Caplets

## Core Rule

Write Caplets from the active schema, local conventions, and nearby examples first, not from memory.

Treat the YAML frontmatter as the machine contract and the Markdown body as the agent operating guide. The body should help an agent decide when and how to use the Caplet; it should not read like an installer README.

Before editing, discover the user's environment:

1. Find the target Caplet file or intended destination. Common names include `CAPLET.md`, `caplet.md`, files under a `caplets/` directory, or entries in a Caplet set.
2. Look for a local schema reference in the file. If none is present, prefer the public schema URL `https://caplets.dev/caplet.schema.json` when adding editor metadata.
3. Read nearby Caplets, project docs, or config files to match naming, auth, setup, and install conventions.
4. Use the repository's own package manager, scripts, and docs for validation when they exist. Do not assume this is the Caplets source repository.

## Authoring Workflow

1. Clarify the integration goal: what the agent should be able to inspect, search, call, automate, or summarize.
2. Pick the backend family that matches the strongest real interface, such as `mcpServer`, `openapiEndpoint`, `googleDiscoveryApi`, `graphqlEndpoint`, `httpApi`, `cliTools`, or `capletSet`.
   - Prefer OpenAPI, GraphQL, Google Discovery, or explicit HTTP actions when the provider has a stable API contract that Caplets can filter into a compact workflow.
   - Prefer MCP when the provider's MCP server is the official curated agent surface or handles workflow/auth better than the raw API.
   - Prefer CLI/local backends when the capability is inherently local or project-bound.
   - Do not choose MCP only because an MCP server exists.
3. Keep checked-in Caplets safe for their audience:
   - For public Caplets, never include tokens, credential-bearing URLs, private provider IDs, browser profiles, user home paths, local absolute paths, or account-specific values.
   - For private Caplets, still isolate secrets and account-specific values so the Caplet can be reviewed and moved safely.
4. Use `$vault:NAME` or `${vault:NAME}` for secrets the runtime should resolve. Use `$env:NAME` only for non-secret machine-local paths, feature flags, or runtime toggles.
5. Add `projectBinding.required: true` when the Caplet reads, searches, executes against, or mutates project files. Explain in the body why the bound project root is required.
6. Add `setup.commands` and `setup.verify` when the backend needs local binaries, browser dependencies, generated specs, provider setup, or a repeatable readiness check.
7. Add `runtime.features` only for real runtime requirements such as `browser` or `docker`.
8. Add optional `catalog.icon` only when it improves public catalog presentation:
   - Use a safe HTTPS image URL or a bundled image path relative to the Caplet directory.
   - Prefer a real provider, project, or capability icon from a license-safe public source when publishing public Caplets.
   - Do not use catalog metadata to imply trust, safety, setup readiness, endorsement, or runtime behavior.
9. Write the Markdown body for agents that will use the Caplet:
   - Lead with when to use the Caplet and the first workflow to try.
   - Explain how to narrow queries, inspect before mutating, interpret results, and recover from common ambiguity.
   - Include provider-specific caveats and "avoid when" guidance when misuse is likely.
   - Mention setup only as runtime readiness context for the agent; keep installation instructions, auth wiring, command names, and verification commands in structured metadata when the schema supports them.
   - Keep the body short enough to behave like a skill, not a provider README.

## Body Shape

Use this shape unless nearby Caplets establish a stronger local convention:

```markdown
# Provider or Capability

Use this Caplet when ...

## First Workflow

1. Start by ...
2. Narrow by ...
3. Only mutate when ...

## Operate Carefully

- Prefer read-only inspection before writes.
- Confirm identifiers before mutating provider or local state.
- Avoid this Caplet when ...
```

Do not use the body as the primary place for install commands, setup command transcripts, endpoint setup instructions, or catalog marketing. The catalog site and installer should derive those from frontmatter and source metadata.

## Review Checklist

- Description says what the Caplet lets an agent do, not how the backend is implemented.
- Tags are searchable and not noisy.
- Auth scopes and credential expectations are least-privilege and represented in metadata when possible; the body explains operational caution, not secret setup mechanics.
- Mutating or destructive capabilities are called out in prose, auth scopes, CLI annotations, narrowed operation filters, or setup notes.
- Local-control Caplets make risk obvious without hiding it inside a broad toolkit.
- The Markdown body reads like agent-facing operating guidance rather than installer-facing documentation.
- The body has a clear first workflow, read-before-write guidance, and misuse boundaries.
- Catalog icon metadata is optional presentation metadata and uses a safe public URL or bundled relative asset path when present.
- Bundled reference files use relative paths, are necessary for the integration, and resolve from the installed Caplet location.
- Project-bound Caplets do not hardcode local absolute paths.
- Public Caplets do not rely on private machines, private browser profiles, unshared config files, or account-specific defaults.
- Caplet sets are self-contained enough that installed copies do not depend on source-repository-only symlinks or layout assumptions unless documented.

## Validation

Use the narrowest validation available in the user's environment:

- If a local schema or editor schema is available, validate the manifest against it.
- If a project provides package scripts, run the focused script that checks Caplets or generated schemas.
- If the Caplets CLI is installed, use its inspection, check, setup, or doctor commands that match the user's goal.
- If the Caplet declares setup commands, verify they are safe, idempotent where possible, and paired with a non-destructive readiness check.
- If no automated validation exists, manually check schema shape, paths, Vault/env placeholders, project binding, setup/readiness, and public-safety assumptions.

When working inside a repository that owns a Caplets schema or generated docs, use that repository's documented generation/check commands before finishing. Do not assume command names.

## Common Mistakes

| Mistake                                            | Fix                                                                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Copying a personal config directly                 | Replace paths, profile names, tokens, and account IDs with Vault/env placeholders or public defaults.       |
| Marking a provider ready without a validation path | Keep readiness conservative until the endpoint, auth model, and validation command are confirmed.           |
| Omitting Project Binding for repo tools            | Add `projectBinding.required: true` and explain the bound-root dependency.                                  |
| Hiding risky local control in a toolkit            | Keep high-risk local-control entries explicit unless the grouping clearly promises that capability.         |
| Assuming repo-local scripts exist                  | Discover and use the user's actual scripts, CLI, schema, and docs instead of hardcoding Caplets-repo paths. |
