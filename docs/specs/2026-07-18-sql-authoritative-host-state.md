# SQL Authoritative Host State And Caplet Records

## Summary

Replace Caplets' correctness-bearing host filesystem stores with one SQL storage backend. SQLite is the default for standard single-node installations. PostgreSQL supports multiple Host Nodes that together represent one logical Caplets host.

Caplet Files remain first-class filesystem sources. SQL adds a structured Caplet Record model rather than storing Markdown as a document blob. Project and global Caplet File layers may shadow SQL records without modifying them, and Caplets can import and export canonical Markdown bundles across project, global, and remote targets.

## Goals

- Make Authoritative Host State coherent across multiple server nodes.
- Use SQLite without external services for the standard local installation.
- Support PostgreSQL clusters with explicit consistency, migration, readiness, and failure contracts.
- Store Caplet identity, human metadata, body, tags, backend children, history, and installation provenance as structured data.
- Preserve complete Caplet bundles, including scripts and auxiliary files, across SQL import and export.
- Preserve project and global Caplet Files as authoritative live layers.
- Replace the global Caplets Lockfile with relational Caplet Installation provenance.
- Keep project installs filesystem-backed and keep the project Caplets Lockfile.
- Provide safe, atomic, Operator-only import, export, history, restore, detach, and deletion operations.

## Non-Goals

- Do not retain the filesystem as an alternative authoritative host-state backend.
- Do not dual-write or automatically fail over between SQLite and PostgreSQL.
- Do not make live Code Mode heap state durable or portable between Host Nodes.
- Do not put synchronized project workspace contents, caches, telemetry, daemon files, or ordinary node-local artifacts in SQL.
- Do not provide multi-tenant host tables in one PostgreSQL schema.
- Do not ship a built-in SQLite-to-PostgreSQL data copier.
- Do not preserve original YAML comments, formatting, key order, or symlink identity during round-trip export.
- Do not add a persisted collaborative Caplet draft workflow.
- Do not reject or encrypt literal secrets found in otherwise valid Caplet frontmatter. Public guidance continues to prefer environment and Vault references.

## Domain Model

### Authoritative Host State

Authoritative Host State is correctness-bearing state that every Host Node must observe coherently:

- Caplet Records, Caplet Revisions, Caplet Installations, and current-head metadata
- content-addressed Caplet bundle metadata and payload references
- backend OAuth/OIDC token state and other server-owned backend auth state
- encrypted Vault values and Vault Access Grants
- remote-client, token-family, Pairing Code, and Pending Remote Login state
- dashboard sessions
- Caplet setup approvals, attempts, retention, and retry state
- Project Binding leases, revisions, readiness, and coordination metadata
- Operator Activity Log entries
- host identity, schema version, node registrations, configuration generations, leases, and maintenance cursors

The following remain outside Authoritative Host State:

- client-owned Remote Profiles and client credential stores
- anonymous telemetry state, update checks, completion caches, and observed-output-shape caches
- native service descriptors, daemon logs, and native service-manager state
- live Code Mode Sessions and heap objects
- Code Mode logs and Recovery Journals unless a later decision promotes them into host-owned shared state
- synchronized Project Binding workspace files
- media artifact bytes when local or object artifact storage is configured
- Vault key material and storage/object-store bootstrap credentials

### Caplet Record

A Caplet Record is the SQL-resident parent entity for one Caplet authoring/install unit. It has:

- an immutable internal record key
- a unique, editable Caplet ID used for runtime identity and export directory naming
- a monotonically changing head generation for optimistic concurrency
- one selected current Caplet Revision
- host-default or per-record revision-retention policy
- created, updated, and actor metadata

The Caplet ID is stable record metadata outside revision content. Renaming it does not rewrite historical revisions, change the immutable record key, or transfer Vault authority to another record. Exporting or restoring any revision uses the record's current Caplet ID.

A Multi-Backend Caplet File remains one Caplet Record. Its backend children are separate ordered rows with child IDs unique inside the parent. The runtime continues to derive expanded runtime Caplets through the existing Caplet parser and configuration model.

### Caplet Revision

A Caplet Revision is an immutable, complete, validated version of a record's structured Caplet content and Caplet Bundle Snapshot. Partial field writes never become current.

Every successful content change creates a revision and selects it as current. A source update whose resolved source revision changed but whose bundle content did not may create a provenance-distinct non-current revision only when revision history is enabled.

History is off by default. Global host configuration may enable a retained revision count, and an individual Caplet Record may override it. The count includes every retained revision, including the current revision and non-current provenance-only revisions. The current revision is never pruned; a limit of one means current only.

Users may:

- delete a historical revision
- delete the current revision, which promotes the newest remaining revision
- delete the sole revision, which removes the Caplet Record
- restore an older revision by creating a new current revision
- hard-delete a Caplet Record, all revisions, all installation lifecycles, and all now-unreferenced bundle entries

The Operator Activity Log survives a hard-delete but contains only sanitized mutation metadata, not removed Caplet content.

### Caplet Installation

A Caplet Installation is a provenance-bearing lifecycle connecting a Caplet Record to an external repository/path and update channel. It records source identity, tracked channel, resolved source observations, status, detach metadata, and operator metadata. Each installed Caplet Revision records the resolved source revision, content hash, and risk snapshot that produced it.

Only one Caplet Installation lifecycle may be active for a record. Detaching ends update tracking but retains the lifecycle. Explicitly replacing a detached install creates a new active lifecycle while retaining the old detached lifecycle and Caplet history.

A manual import over an actively installed record fails unless the operator explicitly detaches the source. If an upstream Caplet disappears, update retains the current record, reports the source as unavailable, and offers an explicit detach path; it never deletes or silently detaches the Caplet.

### Effective Caplet

Caplet resolution uses this precedence, highest first:

1. project Caplet File layer
2. global Caplet File layer
3. SQL Caplet Record layer
4. existing global JSON executable-backend config

Project JSON config retains its current restrictions and cannot introduce executable backend maps.

A higher layer shadows a lower layer without writing to it. Deleting a shadowing file reveals the lower SQL record. Ordinary runtime, CLI list/inspect, and dashboard views show only the Effective Caplet. A filesystem Effective Caplet appears read-only in the dashboard, with editing controls disabled. The dashboard does not show the hidden SQL record.

Operator-only commands and APIs may request the stored SQL view explicitly. CLI surfaces use `--stored` and must report whether the record is currently shadowed.

## Logical SQL Model

SQLite and PostgreSQL implement one logical schema. PostgreSQL may use native `jsonb` and `bytea`; SQLite may use canonical JSON text and BLOB storage. Application validation remains authoritative for typed JSON in both backends.

The logical Caplet model requires at least:

- `caplet_records`: immutable key, current Caplet ID, current revision, head generation, retention override, lifecycle metadata
- `caplet_revisions`: immutable revision key/sequence, record key, name, description, Markdown body, schema/export metadata, validated top-level typed subsections, content hash, source provenance, actor, timestamps
- `caplet_tags`: revision-to-tag rows
- `caplet_backends`: revision-to-backend-child rows, backend family, optional child ID, ordering, and validated backend-specific typed JSON
- `caplet_bundle_entries`: revision, normalized relative path, content hash, media type, size, and executable bit
- `caplet_asset_blobs`: content hash, size, and SQL payload or object-storage key/status
- `caplet_installations`: source identity, tracked channel, active/detached status, timestamps, and operator metadata
- `caplet_installation_observations`: resolved source revision, content hash, risk snapshot, check status, and timestamps

Other Authoritative Host State uses domain-specific tables rather than one generic key/value or JSON-document table. Security and coordination transitions must retain their existing invariants, including compare-and-swap token rotation, stale-token detection, session expiry, setup retry limits, Vault encryption, and Project Binding lease ownership.

Rows may contain validated typed JSON where a nested backend-specific shape is expected to evolve. Whole Caplet Markdown documents, whole lockfile entries, and whole host-state files are not stored as opaque JSON/blob records.

## Caplet Bundle Snapshot

`CAPLET.md` is parsed into structured Caplet Record fields and exact Markdown body text; its original raw YAML document is not retained. Every auxiliary regular file in the directory bundle is retained, whether or not frontmatter currently references it.

Import normalizes and validates every bundle entry:

- relative paths only
- no traversal or platform-absolute paths
- regular files only in the persisted snapshot
- safe in-bundle symlinks are materialized as regular-file content
- escaping, broken, cyclic, or unsupported links fail the import
- device, socket, FIFO, and other special files fail the import
- executable intent is retained as a portable executable bit

Default limits are:

- 2,048 auxiliary files per bundle
- 64 MiB per auxiliary file
- 256 MiB total auxiliary bytes per bundle
- the existing Caplet Markdown size/body limits remain unchanged

All limits are host-configurable. Import streams and validates data before commit and identifies the path that exceeded a limit.

### Asset Payloads

The default asset payload store is content-addressed SQL storage. Bundle-entry rows reference a shared payload by cryptographic content hash, so identical assets and retained revisions do not duplicate bytes.

Operators may configure an S3-compatible asset backend with endpoint, region, bucket, prefix, path-style behavior, and bootstrap credentials. Object upload is staged and hash-verified before a SQL revision may reference it. A failed SQL commit may leave an unreferenced object, which leased garbage collection removes only after a safety grace period. Deleting a record or revision removes references first; object deletion remains retryable and idempotent.

Media artifacts use a separate object namespace and retention policy. Object storage is recommended for cluster-safe media artifacts. Node-local artifacts remain allowed with affinity/owner routing and are lost when their node or local storage is lost.

## Storage Configuration

Global Caplets config selects the storage backend and nonsecret options. Project config cannot select or override host storage.

SQLite is the default when no backend is configured. Its database lives under the Caplets-owned state directory unless an explicit path is configured. SQLite startup enables the durability, foreign-key, busy-timeout, and concurrency settings required by the implementation.

PostgreSQL configuration selects one schema for one logical Caplets host. Several hosts may share a database only by using separate schemas and credentials. Multi-host/tenant keys inside application tables are out of scope.

Database and S3 credentials are bootstrap inputs. They come from environment or deployment secret-file references, not Caplets Vault references, because the database must open before the Vault can be read. Plain literal values remain valid user input when the existing global-config policy permits them, but documentation recommends deployment secret injection.

A host selects exactly one backend. It never:

- falls back from PostgreSQL to SQLite
- uses SQLite as a PostgreSQL write buffer
- dual-writes legacy files and SQL
- splits domain stores across independently selected backends

All config-loading APIs become asynchronous. Pure parsing and validation may remain internally synchronous, but every public config/runtime assembly caller awaits the selected backend and the resolved source layers. Engines receive complete immutable snapshots; requests do not perform blocking network I/O.

## Mutations And Concurrency

All complete Caplet candidates validate before becoming durable. Frontmatter, body, backend children, bundle paths, asset hashes, source provenance, and retention effects commit atomically.

Every mutable SQL record exposes a head generation. Update, rename, delete, revision delete, restore, detach, and replace operations require the generation observed by the caller. A stale generation returns a conflict and never overwrites another operator's change.

Batch import is all-or-nothing. A validation error, existing-ID collision, stale generation, object-staging failure, or authorization failure leaves every target record unchanged.

Operator mutations that also require an Operator Activity Log entry append that sanitized entry in the same SQL transaction whenever both records use SQL. External object writes use staged-before-commit semantics instead of pretending SQL and object storage share a distributed transaction.

## Import And Export

Import and export follow the existing target model:

- project target: filesystem Caplet bundles and project Caplets Lockfile
- global target: the configured local host SQL backend
- remote target: the selected remote host SQL backend through its authenticated admin API

The default mutation target remains project. Global and remote add/install/import/update/delete operations mutate Caplet Records. Explicit print/output generation remains a filesystem operation.

### Import

- A missing Caplet ID creates a record.
- An existing ID fails by default.
- Explicit update requires the observed head generation and creates a new revision.
- Updating an actively source-tracked install with local Markdown additionally requires explicit source detachment.
- A directory containing several Caplets commits as one transaction or not at all.
- Literal secret-bearing fields accepted by the current Caplet schema are preserved as authored.

### Export

Export produces a deterministic semantic projection, not a byte-perfect source restoration:

- always writes `<id>/CAPLET.md`
- writes canonical YAML frontmatter from validated structured data
- preserves exact stored Markdown body text
- writes normalized auxiliary regular files and executable intent
- does not recreate YAML comments, formatting, key order, or symlinks
- exports current revision by default and accepts an explicit retained revision
- fails if the destination directory exists unless replace is explicit
- explicit replace stages a sibling directory and atomically swaps it, so stale files cannot survive

Export and history operations are Operator-only because valid frontmatter may contain literal credentials.

## Install And Update Lifecycle

Project catalog installs keep their filesystem destination and project `.caplets.lock.json` behavior.

Global and remote catalog installs create or update Caplet Records and relational Caplet Installations. The global filesystem lockfile is retired after verified migration. Restore and update read SQL provenance rather than serializing lockfile entries into JSON columns.

A content-changing update creates and selects a new current revision. If the resolved source revision changes while Caplet content does not:

- with history enabled, create a provenance-distinct non-current revision that counts toward retention
- with history disabled, update installation observation metadata without retaining a Caplet Revision

If the source no longer contains the Caplet, retain the current record, report `source unavailable`, and offer an explicit detach operation/flag.

Replacing a detached Caplet is explicit. It preserves the record identity and retained revisions, creates a new current revision, retains the old detached Installation lifecycle, and creates one new active lifecycle.

## Authorization And Audit

Only a server-local operator or Operator Client may:

- inspect stored or shadowed SQL records
- import or export records/bundles
- list or delete revisions
- restore revisions
- change retention
- rename, detach, replace, delete, or hard-delete records/installations

Access Clients continue to see only agent-safe Effective Caplet capability surfaces. They cannot read raw structured config, history, bundle assets, literal secrets, or inactive fallback records.

Storage-scoped reads that can reveal raw config and every mutation append sanitized Operator Activity Log entries. Raw Caplet content, body, asset bytes, database URLs, object-store credentials, Vault values, tokens, and filesystem paths never enter activity metadata.

SQL Vault Access Grants bind to the immutable Caplet Record key and reference name. Renaming the Caplet ID preserves grants; deleting and recreating the same ID does not inherit grants from the deleted record. File-layer grants retain their existing origin-path identity.

## Distributed Consistency

PostgreSQL mode uses risk-tiered consistency.

Security and coordination operations read and mutate PostgreSQL transactionally, including:

- remote credential validation, refresh rotation, revocation, and pending login
- dashboard session validation
- Vault value/grant reads and mutations
- setup approval and retry state
- Project Binding lease/revision transitions
- record mutation generations and installation ownership

Caplet/config reads use immutable per-node snapshots. A committed SQL Caplet mutation is visible immediately to the writing node. Other healthy nodes invalidate through database notification and poll a host generation as a fallback. The documented default cross-node convergence bound is five seconds. Requests already in flight retain the snapshot with which they started.

A dropped notification cannot cause indefinite staleness. If the database is unavailable, Host Nodes fail readiness and SQL-dependent host/capability requests return a retryable unavailable error. They do not continue serving stale SQL Caplets or security state.

## Cluster Contract

One PostgreSQL schema represents one logical Caplets host with one stable host identity. Every Host Node registers an ephemeral node identity and heartbeat.

### Runtime Parity

Global Caplet Files remain authoritative, so every node must expose an identical global Caplet File manifest. Nodes also compute a deterministic keyed fingerprint of resolved runtime-affecting global configuration, including resolved environment values without storing or logging those values. Node-local listen, log, and process options are excluded.

Manifest or runtime-fingerprint disagreement fails readiness. Project Caplet Files are session/project-scoped and are not part of the global cluster fingerprint.

### Node-Local Runtime State

Live Code Mode Sessions remain node-local and require connection/session affinity. Losing the owning node loses live heap state and follows existing recovery behavior; SQL does not claim to restore closures, objects, timers, or handles.

Project Binding workspace content remains node-local. PostgreSQL stores binding leases, manifests/revisions, and readiness metadata. Losing the owning node quarantines affected Caplets until the client rebinds and resynchronizes on another node.

Node-local media artifacts require affinity/owner routing. S3-compatible artifact storage is recommended when artifacts must survive node loss or be readable from any node.

### Maintenance

Revision pruning, expired-state cleanup, installation checks, activity retention, object garbage collection, and other recurring maintenance use short database-backed leases/advisory locks and idempotent bounded batches. Any healthy Host Node may acquire a job; another may continue after lease expiry. Lease time uses database time where possible.

## Schema And Data Migration

### New And Upgraded SQLite Hosts

New installations create SQLite automatically. Ordered SQLite schema migrations run under an exclusive migration transaction before the host serves. A migration failure rolls back and prevents startup. A binary encountering a newer unknown schema fails closed.

Existing filesystem-backed hosts do not migrate destructively on first startup. An explicit offline migration command must:

1. require the daemon/host to be stopped or in exclusive maintenance mode
2. support a dry run
3. acquire an exclusive migration lock
4. validate legacy Authoritative Host State
5. verify every global-lockfile artifact and its recorded hash/provenance
6. import all SQL state transactionally
7. compare migrated counts and content hashes
8. move only migrated state files, tracked global artifacts, and the old global lockfile to a timestamped backup after commit
9. leave untracked global Caplet Files in place as authoritative overlays
10. print the backup location and restart/cutover instructions

There is no dual-write transition. After cutover, migrated legacy stores are not read as fallback state.

### PostgreSQL Deployments

PostgreSQL schema migration is an explicit deployment job that must succeed before any Host Node starts. Kubernetes, Docker Compose, and other deployment examples must model this dependency.

The migration job uses a DDL-capable migrator role. Runtime nodes use a separate least-privilege role limited to the configured schema's required DML, sequences, notifications, and advisory locks. Runtime startup refuses an absent or outdated schema and fails closed against a newer unknown schema.

### SQLite To PostgreSQL

Caplets does not ship a built-in backend copier. Operator documentation must provide a version-pinned, tested offline recipe using an external migration tool, including:

- stopping the host
- backing up SQLite and any object storage
- applying the target PostgreSQL schema with the migration job
- copying every authoritative table and payload
- resetting sequences/identities where required
- comparing row counts and content hashes
- running integrity/foreign-key checks
- switching global storage config only after verification
- rollback instructions that restore the untouched SQLite configuration and backup

Illustrative, unverified dump/load snippets do not satisfy this requirement.

## Health And Readiness

Liveness reports whether the process is running. Readiness additionally requires:

- authoritative database connectivity
- exact supported schema version
- successful host identity registration
- no global-file manifest conflict
- no keyed runtime-fingerprint conflict
- object-store connectivity when configured for required Caplet assets
- a valid current SQL snapshot

A missing optional media-artifact object store may degrade artifact health without making unrelated capabilities ready if local artifact fallback is configured. A missing object containing a current Caplet bundle asset quarantines the affected Caplet and makes storage health unhealthy; it never substitutes empty content.

## Required User Surfaces

The completed feature must expose:

- storage status and health for SQLite/PostgreSQL/object storage
- PostgreSQL schema migration command suitable for deployment jobs
- explicit offline legacy-filesystem migration with dry run
- project/global/remote targets for add, install, import, update, export, and delete
- `--stored` operator views for hidden SQL records
- revision list, export, restore, delete, retention, and hard-delete operations
- installation status, detach, source-unavailable handling, and detached replacement
- deterministic plain and JSON conflict/error outputs with record generation and shadow source
- dashboard read-only filesystem Caplets and editable effective SQL Caplets

## Acceptance Criteria

1. A new unconfigured single-node host creates and uses SQLite for all Authoritative Host State.
2. A host cannot start with two authoritative backends, an unsupported schema, or an unavailable configured database.
3. PostgreSQL nodes sharing one schema observe transactional security state and converge Caplet snapshots within the documented healthy bound.
4. Database loss fails readiness and does not serve stale SQL Caplets or revoked security state.
5. Project files shadow global files, global files shadow SQL records, and deleting a file reveals the lower record without mutating it.
6. Cluster nodes with different global file manifests or resolved runtime fingerprints fail readiness.
7. Dashboard and normal list views show only the Effective Caplet; filesystem Caplets are read-only; Operator-only `--stored` views can address hidden SQL records.
8. Caplet Markdown is decomposed into structured relational data and exact body text; whole Markdown documents and lockfile entries are not stored as opaque records.
9. Multi-Backend Caplet Files retain one parent identity and round-trip as one bundle.
10. Entire bounded auxiliary bundles round-trip semantically, including executable intent; unsafe links and special files fail before commit.
11. SQL and S3 asset stores verify content hashes, deduplicate payloads, and never expose a revision before all required content is durable.
12. Concurrent stale mutations fail without lost updates.
13. Batch import either commits every Caplet or none.
14. Export is deterministic, always produces directory bundles, and never leaves stale destination files after explicit replacement.
15. Revision retention, current promotion, sole-revision deletion, restore, specific deletion, and hard-delete follow the defined lifecycle.
16. Global and remote install/update use relational Caplet Installations; project install/update keep the project lockfile.
17. Manual overwrite of a tracked install requires explicit detach; detached replacement creates a new Installation lifecycle.
18. Operator-only raw record/history/export operations are activity-logged and never available to Access Clients.
19. Vault grants survive record rename through immutable record identity and never transfer through Caplet ID reuse.
20. Existing filesystem state migrates only through the explicit verified offline path and remains recoverable from its timestamped backup.
21. SQLite schema migration is transactional; PostgreSQL deployment examples require the migration job and separate database roles.
22. The documented external SQLite-to-PostgreSQL recipe is executed and verified against the released schema before publication.
23. Live Code Mode and Project Binding behavior under node affinity, node loss, and rebind is documented and observable.
24. Leased maintenance is idempotent across concurrent Host Nodes and safe for external object deletion.
