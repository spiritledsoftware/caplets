# Concepts

Shared domain vocabulary for this project -- entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Caplets Runtime

### Caplet

A configured capability surface that exposes a backend to agents through a stable handle, progressive wrapper tools, or direct tool operations.

### Namespace Shadowing Policy

A Caplet shadowing policy where a local/upstream ID collision exposes both Caplets under qualified namespace IDs and removes the ambiguous bare ID.

Namespace Shadowing is collision-only: non-colliding Caplets keep their normal IDs, while colliding Caplets use explicit, hash-suffixed runtime labels such as `remote-a1b2` and `local-9f3c` before the double-underscore Caplet ID separator. Runtime labels may have configured aliases, but aliases replace the namespace label instead of creating duplicate handles. Hash suffixes must be small, stable, and derived from durable source identity; unresolved generated-ID collisions fail closed with diagnostics rather than falling back to forbidden shadowing behavior.

### Caplets Daemon

A per-user native service managed by `caplets daemon` that runs local HTTP `caplets serve` through the operating system service manager.

The Caplets Daemon is installed and updated through an install-time service contract. Runtime lifecycle commands operate on the installed service rather than changing its persisted serve or environment configuration.

### Caplets Vault

A runtime-owned encrypted string store whose values can be referenced from Caplets config with `$vault:NAME` or `${vault:NAME}`.

Caplets Vault replaces fragile agent-harness environment propagation for secret-like config values. Each runtime owns its own Vault store; local Caplets do not read, mirror, or forward remote or Cloud Vault values.

### Raw Vault Reveal

The explicit human-facing action that prints a Vault value in cleartext.

Raw Vault Reveal is separate from config interpolation and agent-facing runtime execution. Generic remote-control and agent surfaces must not treat caller-provided request fields as proof that a reveal is authorized.

### Vault Access Grant

The authorization record that lets a specific Caplet reference resolve a specific Vault key during runtime config interpolation.

Vault Access Grants are identified by Caplet ID, reference name, and config origin. The stored Vault key is mutable grant data so remapping a reference replaces the target key instead of leaving stale grants behind.

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

### Remote Attach

The process where a local agent-facing Caplets runtime connects to a trusted Caplets host and exposes that host's capabilities through local or native agent integrations.

Remote Attach uses Remote Profiles for trust and credentials. Long-lived attach traffic treats credentials as refreshable runtime state rather than fixed startup state.

### Stacked Remote Runtime

A local HTTP Caplets runtime that serves local Caplets while composing an upstream Caplets host through a configured upstream URL.

Stacked Remote Runtime keeps project context session-scoped. `caplets attach` supplies the project root for a client session, while the long-running runtime owns env, Remote Profile, Project Binding, health, and composition behavior.

### Remote Login

The provider-neutral flow that trusts a local Caplets client to a Caplets host, whether the host is self-hosted or Caplets Cloud.

Remote Login stores host credentials in Caplets-owned credential storage so agent configs can launch Remote Attach using stable host selectors without carrying remote secrets.

### Pending Remote Login

The self-hosted Remote Login state between client initiation and server-local operator approval or rejection.

A Pending Remote Login separates the operator-visible Pairing Code from client-held pending material. Approval alone does not create reusable attach credentials; the initiating client must still complete the flow with its possession proof before a Remote Profile can be stored.

### Pairing Code

A short-lived, operator-visible approval code for a pending self-hosted Remote Login flow.

Pairing Codes prove that a server-local operator approved a specific pending login. They are not reusable client credentials, attach bearer credentials, or the flow's longer-lived pre-login refresh material.

### Remote Profile

The stored local record for a trusted Caplets host, including the normalized host URL, host kind, selected workspace when applicable, and redacted credential status.

Remote Profiles are the source of truth for request credentials. Long-lived clients resolve current profile state when sending remote traffic instead of copying credentials into agent config or one-time startup state.
