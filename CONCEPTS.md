# Concepts

Shared domain vocabulary for this project -- entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Caplets Runtime

### Caplet

A configured capability surface that exposes a backend to agents through a stable handle, progressive wrapper tools, or direct tool operations.

### Caplets Daemon

A per-user native service managed by `caplets daemon` that runs local HTTP `caplets serve` through the operating system service manager.

The Caplets Daemon is installed and updated through an install-time service contract. Runtime lifecycle commands operate on the installed service rather than changing its persisted serve or environment configuration.

### Install-Time Service Contract

The persisted daemon agreement that defines what command runs, which environment model applies, which native service identity owns it, and how updates become active.

### Native Service Manager

The operating system facility that owns per-user service registration and lifecycle for the Caplets Daemon.

### Service Descriptor

The native service-manager artifact that declares how the Caplets Daemon should be launched and supervised.

## Code Mode

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

## Remote Attach

### Remote Login

The provider-neutral flow that trusts a local Caplets client to a Caplets host, whether the host is self-hosted or Caplets Cloud.

Remote Login stores host credentials in Caplets-owned credential storage so agent configs can launch `caplets attach --remote-url ...` without carrying remote secrets.

### Pairing Code

A short-lived, one-time code minted by a self-hosted Caplets host and exchanged by a client during Remote Login.

Pairing Codes are bootstrap material only. They are not reusable client credentials.

### Remote Profile

The stored local record for a trusted Caplets host, including the normalized host URL, host kind, selected workspace when applicable, and redacted credential status.
