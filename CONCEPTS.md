# Concepts

Shared domain vocabulary for this project -- entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Code Mode

### Caplet

A configured capability surface that exposes a backend to agents through a stable handle, progressive wrapper tools, or direct tool operations.

### Code Mode

The Caplets execution surface where an agent runs a bounded TypeScript workflow against generated Caplet handles and receives compact structured output.

### Code Mode Session

A reusable live Code Mode execution context that lets adjacent calls share variables, functions, and cached setup while the runtime remains alive and compatible.

Code Mode Sessions are intentionally runtime state, not durable saved workflows. A caller starts a fresh session by omitting the previous session handle rather than resetting or replacing it in place.

### Recovery Journal

A retained, redacted record of Code Mode calls for a session, used to help reconstruct setup after the live Code Mode Session is no longer available.

Recovery Journals support auditability and reconstruction, but they do not restore heap state. They store bounded setup evidence and avoid treating persisted runtime identifiers as reusable credentials.

### Recovery Reference

A capability-style reference that authorizes reading a Recovery Journal.

Recovery References are separate from session handles. Possessing a session handle may identify a live Code Mode Session, but reading retained recovery history requires the recovery-specific reference or a known cleaned-up session that can be mapped back to the same retained journal.

### Progressive Exposure

The Caplets exposure mode where agents discover and call backend operations through a small set of wrapper tools instead of receiving every downstream operation as a separate top-level tool.
