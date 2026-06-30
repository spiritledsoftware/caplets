# Concepts

Shared domain vocabulary for this project -- entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Caplets Runtime

### Caplet

A configured capability surface that exposes a backend to agents through a stable handle, progressive wrapper tools, or direct tool operations.

### Prebuilt Caplets Catalog

The repo-owned collection of installable Caplet files under `caplets/`.

The Prebuilt Caplets Catalog is curated as a Code Mode-first capability catalog, not a generic marketplace. Catalog entries should be install-ready when promoted, with setup, auth, validation, safety, and Project Binding metadata appropriate to the backend.

Install-ready catalog entries have an explicit verification status, a reproducible validation path, and a named primary Code Mode workflow. Unverified entries may exist as drafts or recipes, but they do not count as install-ready catalog coverage.

### Catalog Search Site

The public search surface for installable Caplets at `catalog.caplets.dev`.

The Catalog Search Site is separate from the landing page and docs site. It indexes official Caplets from this repo and community Caplets discovered through public external installs, with search, readable Caplet content, source labels, install-count popularity signals, warnings, and inspection-first copyable install commands as the primary user flow.

### Public Catalog Indexing Signal

The public-source install signal that lets `catalog.caplets.dev` discover and rank community Caplets.

Public Catalog Indexing is not ordinary anonymous telemetry. It may publish public Caplet content, normalized install command, source identity needed to reproduce install, and aggregate install count; it must not publish installer identity, private source URLs, local paths, config, credentials, prompts, tool arguments, tool outputs, or hostnames. Catalog install counts are popularity and ranking signals, not safety signals, and public entries can be suppressed when automatic indexing creates stale, abusive, leaked, or high-risk catalog records.

### Catalog-Grade Caplet

A Caplet that is ready to live in the Prebuilt Caplets Catalog.

Catalog-Grade Caplets include enough frontmatter, setup or verification guidance, auth handling, least-privilege scope notes, safety notes, Code Mode workflow guidance, and local/project/runtime metadata for agents to use them without rediscovering private assumptions from the author's environment.

### Multi-Backend Caplet File

A Markdown Caplet file that describes one provider-scale capability while declaring multiple child backend entries in frontmatter.

Multi-Backend Caplet Files are for suites such as Google Workspace where one catalog card, install unit, setup flow, auth story, and operating guide should expand into several stable runtime child Caplets. They compile into the existing backend maps rather than introducing a new runtime backend kind.

### Catalog Presentation Metadata

Optional Caplet frontmatter that improves how a Caplet appears in public catalog surfaces without changing runtime behavior, trust, safety status, ranking, or install readiness.

In v1, Catalog Presentation Metadata is limited to `catalog.icon`, which may identify a safe HTTPS icon URL or a bundled icon path relative to the Caplet directory.

### Caplets Lockfile

A `caplets.lock.json` file that records installed catalog Caplets, their source repository, source path, destination, tracked source channel, resolved revision when available, content hash, and portability status.

Caplets Lockfiles let `caplets install`, no-argument install restore, and `caplets update` manage installed Caplets from recorded provenance rather than from copied files alone. Project installs use `./.caplets.lock.json`; global installs use the target machine's Caplets state directory.

Caplets Lockfiles are share-safe and integrity-aware. They strip credential-bearing source URLs, prefer project-relative paths where possible, verify recorded content before restore, and fail closed when local-source entries are unavailable or marked non-portable.

### Namespace Shadowing Policy

A Caplet shadowing policy where a local/upstream ID collision exposes both Caplets under qualified namespace IDs and removes the ambiguous bare ID.

Namespace Shadowing is collision-only: non-colliding Caplets keep their normal IDs, while colliding Caplets use explicit, hash-suffixed runtime labels such as `remote-a1b2` and `local-9f3c` before the double-underscore Caplet ID separator. Runtime labels may have configured aliases, but aliases replace the namespace label instead of creating duplicate handles. Hash suffixes must be small, stable, and derived from durable source identity; unresolved generated-ID collisions fail closed with diagnostics rather than falling back to forbidden shadowing behavior.

### Caplets Daemon

A per-user native service managed by `caplets daemon` that runs local HTTP `caplets serve` through the operating system service manager.

The Caplets Daemon is installed and updated through an install-time service contract. Runtime lifecycle commands operate on the installed service rather than changing its persisted serve or environment configuration.

### Daemon-First Setup

The local onboarding path where `caplets setup` prepares the user config and a healthy Caplets Daemon before configuring agent integrations.

Daemon-First Setup points MCP clients at `caplets attach <local-daemon-url>` and points native integrations at the local daemon runtime, so backend execution uses the daemon-owned environment instead of depending on MCP client environment passthrough.

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

### Project Binding

A session-scoped connection between a local project root and a Caplets runtime so project-bound Caplets can run against the same project the user is editing.

Project Binding is not synonymous with file sync. Local-only runtimes use it as project context for local execution, while remote or stacked runtimes also use it to decide when project files must be propagated upstream.

### Project Binding Quarantine

The session-scoped state where Caplets with failed required Project Binding are withheld from callable surfaces after retry.

Project Binding Quarantine applies to affected Caplets rather than the whole runtime. Unrelated local and upstream Caplets can remain available while diagnostics report which Caplets were withheld and why.

### Available Update Detection

The passive CLI behavior that checks whether a newer published `caplets` CLI version is available and reports it through a best-effort stderr-only notice when stderr is an eligible human-facing notice channel.

Available Update Detection preserves stdout contracts for protocols, JSON output, shell completion, help, and version commands, and suppresses passive notices by default in CI, non-interactive automation, daemon-managed services, native integrations, and default stdio `serve` or `attach` sessions. In v1, stdio-backed `serve` and `attach` are notice-eligible only when `CAPLETS_UPDATE_NOTICE_STDERR=1` explicitly marks the current foreground invocation's stderr as notice-safe.

### MCP Resource

A concrete read-only content item exposed by an MCP backend, identified by a URI and optionally accompanied by metadata such as a name or media type.

### MCP Resource Template

A templated MCP resource URI that describes a family of readable resources rather than one concrete item.

MCP Resource Templates are distinct from MCP Resources: a backend can support concrete resources without supporting templates, so runtime health and discovery should treat template listing as optional.

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

### Anonymous Telemetry

Opt-out Caplets usage and reliability reporting that uses a stable anonymous installation ID and categorical metadata only.

Anonymous Telemetry is split by purpose: PostHog receives product usage events, while Sentry receives sanitized reliability events. It must not collect raw config, prompts, Code Mode code, tool arguments, tool outputs, paths, URLs, hostnames, Caplet IDs, credentials, or unsanitized error payloads.

### Telemetry Observability Loop

The combined PostHog and Sentry feedback loop that connects public-site intent, runtime usage, provider delivery health, and debuggable release errors into maintainable product readouts.

Telemetry Observability Loop keeps PostHog as the usage and conversion system, keeps Sentry as the reliability system, and preserves Anonymous Telemetry boundaries by separating public catalog indexing and avoiding known-user attribution.

### Anonymous Install Attribution

A short nonsecret categorical marker generated from public-site install intent and optionally reported by the CLI on first activation.

Anonymous Install Attribution connects landing, docs, and catalog intent to activation readouts without carrying browser visitor identities, account identities, raw source URLs, or hidden user identifiers into runtime telemetry.

## Remote Attach

### Remote Attach

The process where a local agent-facing Caplets runtime connects to a trusted Caplets host and exposes that host's capabilities through local or native agent integrations.

Remote Attach uses Remote Profiles for trust and credentials. Long-lived attach traffic treats credentials as refreshable runtime state rather than fixed startup state.

### Stacked Remote Runtime

A local HTTP Caplets runtime that serves local Caplets while composing an upstream Caplets host through a configured upstream URL.

Stacked Remote Runtime keeps project context session-scoped. `caplets attach` supplies the project root for a client session, while the long-running runtime owns env, Remote Profile, Project Binding, health, and composition behavior.

### Public Origin

An externally meaningful origin for a Caplets HTTP serve process.

Public Origins participate in host/audience identity for HTTP serve, Remote Login, and attach routes. They are not a project-controlled allowlist or a general network authorization policy.

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
