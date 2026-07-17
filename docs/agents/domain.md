# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Layout

This is a single-context repo.

- Read root `CONTEXT.md` for Caplets product vocabulary and domain language.
- Read relevant ADRs in `docs/adr/` before changing areas covered by an architectural decision.
- If a future `CONTEXT-MAP.md` appears, treat that as a signal that the repo has moved to a multi-context layout and update this file.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`** entries that touch the area you're about to work in.
- **`STRATEGY.md`** when deciding whether proposed work fits the current product direction.
- **`CONCEPTS.md`** when orienting to shared project vocabulary.
- **`docs/solutions/`** when implementing, debugging, or making decisions in an area with documented prior solutions.

If any optional file does not exist in a checkout, proceed silently. Do not suggest creating it upfront; producer workflows create or update these docs when terms, strategy, or decisions are actually resolved.

## Use the glossary's vocabulary

When your output names a domain concept in an issue title, refactor proposal, hypothesis, test name, or implementation plan, use the terms defined in `CONTEXT.md` and `CONCEPTS.md`. Do not drift to synonyms those docs explicitly avoid.

If the concept you need is not in the glossary yet, either reconsider whether you are inventing language the project does not use, or note the gap for a vocabulary/documentation pass.

## SQL storage vocabulary

Use these terms consistently when working on the Current Host control plane:

- **SQL Control Plane Store** — the canonical SQL-owned state for one Current Host. Avoid “the config database”: filesystem configuration still composes above SQL.
- **filesystem bootstrap authority** — the owner-private local descriptor and storage binding that pin a service process to its backend, logical host, store, operation namespace, artifact provider, and key commitments. Database credentials alone do not recreate it.
- **logical Current Host** — one host identity that may be served by one SQLite process or a Postgres replica cluster. Avoid calling each Postgres replica a host.
- **storage authority** — the currently active store binding plus authority/security generations and writer fence. Avoid using “database connectivity” as a synonym; connectivity can exist while authority is not ready.
- **effective record** — the highest-precedence SQL/host-filesystem/project-filesystem value used by the runtime.
- **underlying SQL record** — a SQL-owned record that remains explicitly inspectable and administrable while a filesystem record shadows it. Mutating it may have no effective-runtime consequence.
- **protected backup** — an authenticated, encrypted recovery envelope with durable inventory and separate wrapped-key material. Avoid “database dump”.
- **normal restore** — confirmation-bound recovery into the same store and operation namespace with newer authority/security generations.
- **catastrophic recovery** — recovery after SQL authority loss using external authenticated checkpoints; it creates a new store, operation namespace, and security epoch.
- **offline backend transfer** — the one-way, fenced SQLite-to-Postgres authority handoff. It is not replication, dual write, or Postgres-to-SQLite migration.
- **portable Caplet** — a deterministic host-neutral Caplet envelope or reconstructed Caplet File/bundle. It excludes resolved secrets, credentials, authority, and materialized host paths.

When describing precedence, write it explicitly as **SQL → host filesystem → project filesystem**, with the rightmost matching layer effective. Do not say “SQL replaces config files.”

When describing degraded operation, distinguish:

- **ready** — live storage authority is compatible and converged;
- **stale-read-only** — a warm process may serve only bounded catalog/runtime-metadata reads from its last accepted snapshot; and
- **not-ready** — no admissible serving authority exists.

Access Client, Operator Client, local `--global`, and trusted local maintenance are separate authority boundaries. MCP, Attach, Code Mode, and native integrations are agent/runtime adapters, not administration identities.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001 (Code Mode default exposure), but worth reopening because..._
