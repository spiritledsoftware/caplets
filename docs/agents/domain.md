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

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001 (Code Mode default exposure), but worth reopening because..._

## Composable Shared Storage Terms

Use these terms exactly when describing the shared-storage runtime and operator lifecycle:

### Writable Authority

The single provider that owns dashboard-managed mutable Current Host state for one deployment.
Supported kinds are filesystem, SQLite, PostgreSQL, and S3-compatible object storage. A deployment
has one Writable Authority; Staged Filesystem Sources are read-only inputs, not additional writable
providers.

### Authority Generation

A complete, committed revision published by the Writable Authority. It has an ordered identity,
predecessor, schema version, digest, provider provenance, and snapshot. Compare-and-swap
administration and idempotency receipts are evaluated against this durable generation.

### Exposure Generation

The local runtime activation counter for an immutable prepared view. It changes when a replica
activates a new Authority Generation and is deliberately distinct from the provider's durable
Authority Generation identity.

### Staged Filesystem Source

An immutable Caplet source supplied with a runtime image or mounted path. It composes with the
Writable Authority, reserves its Caplet IDs against dashboard create/install/update/delete, and is
never synchronized through the authority.

### Source Ownership

The classification that assigns every input path to one owner: `authority`, `staged`,
`replica-local`, `client-local`, or `migration-input`. Duplicate ownership is invalid; lifecycle
inventory and migration use ownership to prevent accidental copying or two writable peers.

### Stable Origin

The durable, path-independent provenance used to identify an authority-managed record across
replicas, remounted staged files, backups, and migrations. It uses authority identity, record
identity, and generation context rather than treating a local filesystem path as a grant or
record identity.

### Maintenance Fence

A provider-backed, owner-scoped lease held during migration or restore. It verifies the source is
stopped/read-only and rejects unowned writes until the finite lease expires or its owner releases
it.

### Lifecycle Cutover

The explicit operator transition from one authority to another: typed inventory, dry-run, fenced
apply, destination behavioral verification, recorded coordinates, and redeploy/restart. Lifecycle
Cutover does not hot-switch a running process or synchronize old and new authorities.
