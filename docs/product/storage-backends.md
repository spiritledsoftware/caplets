# SQL Storage Backends

Caplets stores Current Host control-plane state in SQL while continuing to read Caplet files and deployment configuration from the filesystem. This document records the shipped ownership, configuration, availability, and recovery boundaries. Source code and the generated configuration schema remain authoritative.

## Authority and ownership

Three layers compose the effective runtime, from lowest to highest precedence:

1. SQL-owned Current Host records
2. host filesystem configuration and Caplet files
3. project filesystem configuration and Caplet files

The higher layer wins per Caplet or setting. A filesystem winner remains filesystem-owned: dashboard, local `--global`, and authenticated `--remote` Current Host operations must not silently rewrite it. An explicitly selected underlying SQL record may be inspected or mutated, but its effective result does not change while a filesystem layer shadows it. Unflagged project CLI operations continue to target project-owned files.

Storage selection itself is deployment-owned. Configure `serve.storage` only in the user/global config (normally `~/.config/caplets/config.json` on Unix-like systems). Project `serve` configuration is ignored with a warning, so a repository cannot select a database, credentials, keys, artifact provider, bind address, or auth posture.

Every node also has an owner-private filesystem bootstrap root. `authority.json` binds the local service identity; `storage-binding.json` binds backend, logical host, store, operation namespace, database identity, artifact identity/canary, and key-provider commitments. Caplets creates a descriptor only in a provably fresh, empty root. Missing descriptors in reused or partial state fail closed instead of creating a second authority.

Persist the complete bootstrap root. Do not copy individual files between hosts or reconstruct it from SQL credentials.

## SQLite: the default single-node backend

Omitting `serve.storage` selects SQLite. Defaults are under the platform state directory:

- Unix-like: `${XDG_STATE_HOME:-~/.local/state}/caplets/control-plane`
- Windows: `%LOCALAPPDATA%\caplets\control-plane` (falling back to `%USERPROFILE%\AppData\Local`)
- database: `<stateRoot>/control-plane.sqlite`
- artifacts: `<stateRoot>/artifacts`
- online key manifest: `<stateRoot>/key-provider/manifests/online.json`

A fresh root atomically creates the logical-host/store identity and the complete local `file-v1` key profile. SQLite uses an exclusive writer lock and is a single-node deployment; do not mount one database into multiple replicas.

An explicit equivalent configuration is:

```json
{
  "serve": {
    "storage": {
      "kind": "sqlite",
      "stateRoot": "/var/lib/caplets/control-plane",
      "databasePath": "/var/lib/caplets/control-plane/control-plane.sqlite",
      "artifacts": {
        "kind": "filesystem",
        "root": "/var/lib/caplets/control-plane/artifacts"
      }
    }
  }
}
```

All paths must be absolute, and the database and artifact roots must remain inside `stateRoot`. Do not set `keyProviderManifest` on a fresh SQLite root; bootstrap creates it. On an already bound root, an explicit manifest may select the existing compatible profile.

For containers, mount `/var/lib/caplets/control-plane` as one owner-private persistent volume. Replacing a container without that volume is replacement of local storage authority, not a restart.

## Postgres: one logical-host cluster

Postgres is a shared backend for replicas serving one logical Current Host. It requires a persistent owner-private `stateRoot` on every node, a pre-provisioned logical-host/store identity, three distinct database roles and connection strings, verified TLS, a compatible external `file-v1` key profile, and one shared S3-compatible artifact provider.

```json
{
  "serve": {
    "storage": {
      "kind": "postgres",
      "stateRoot": "/var/lib/caplets/control-plane",
      "logicalHostId": "host_0123456789ABCDEFGHJKMNPQRS",
      "expectedStoreId": "store_0123456789ABCDEFGHJKMNPQRS",
      "processRole": "online",
      "connection": {
        "tls": {
          "mode": "verify-full",
          "serverName": "postgres.internal.example",
          "ca": { "kind": "file", "path": "/run/secrets/postgres-ca.pem" }
        },
        "roles": {
          "runtime": {
            "role": "caplets_runtime",
            "credential": { "kind": "env", "name": "CAPLETS_POSTGRES_RUNTIME_URL" }
          },
          "migrator": {
            "role": "caplets_migrator",
            "credential": { "kind": "env", "name": "CAPLETS_POSTGRES_MIGRATOR_URL" }
          },
          "maintenance": {
            "role": "caplets_maintenance",
            "credential": { "kind": "env", "name": "CAPLETS_POSTGRES_MAINTENANCE_URL" }
          }
        }
      },
      "keyProviderManifest": "/run/secrets/caplets-keys/manifests/online.json",
      "artifacts": {
        "kind": "s3",
        "endpoint": "https://s3.internal.example",
        "region": "us-east-1",
        "bucket": "caplets-artifacts",
        "prefix": "current-host-a",
        "canary": { "kind": "env", "name": "CAPLETS_S3_CANARY" },
        "credentials": {
          "accessKeyId": { "kind": "env", "name": "CAPLETS_S3_ACCESS_KEY_ID" },
          "secretAccessKey": { "kind": "env", "name": "CAPLETS_S3_SECRET_ACCESS_KEY" }
        }
      },
      "migration": { "designated": false },
      "retention": { "backupDays": 30 }
    }
  }
}
```

Deployment secret references are either `{ "kind": "env", "name": "..." }` or `{ "kind": "file", "path": "/absolute/path" }`. Every role, TLS CA, S3 canary, and S3 credential must use a distinct reference. The S3 endpoint must be verified HTTPS without embedded credentials, query, or fragment. The provisioned canary value is a 64-character lowercase hexadecimal commitment shared by every node.

A serving process must use `processRole: "online"`. The runtime role must be least-privilege, non-administrative, unable to assume other roles, and distinct from the migrator and maintenance roles. One-shot migrator/maintenance startup requires `migration.designated: true`; ordinary `caplets serve` rejects those process roles. SQL schema, TLS peer/server name, database role, logical host, store, operation namespace, S3 identity/canary, and key commitments are verified before readiness.

Postgres artifact bytes never use node-local paths. All ready replicas use the same provider/bucket/prefix/logical-host/store identity, so upload, range read, consumption, and cleanup survive node replacement.

## Health and degraded operation

`GET /v1/healthz` returns only the redacted storage summary and uses HTTP 200 only for `readiness: "ready"`; other storage readiness states return 503. The dashboard storage-health endpoint uses the same field allowlist. Public fields are:

- `backend`: `sqlite` or `postgres`
- `readiness`: `ready`, `not-ready`, or `stale-read-only`
- `connectivity`: `connected` or `unavailable`
- `migration`: `current` or `blocked`
- `authorityToken`: numeric `authorityGeneration` and `effectiveGeneration`
- `bootstrapCompatibility`: `current`, `staged`, or `incompatible`
- optional `staleAgeMs`
- `convergence`: `single-node`, `within-budget`, `pending`, or `overdue`
- `guidanceCode`: `ok`, `storage-unavailable`, `migration-required`, `convergence-pending`, `convergence-overdue`, or `bootstrap-incompatible`

A warm process may serve bounded catalog/runtime-metadata reads from its last accepted snapshot as visibly `stale-read-only`. Authentication, administration, Project Binding, Attach, Vault, import/export, and mutation require live SQL authority and fail closed. Cold startup never serves a partial SQL state. A Postgres node that misses convergence loses readiness and write eligibility rather than serving stale authority.

Detailed store identity, bootstrap fingerprint, key compatibility, and ready/overdue node counts require a live-authorized Operator dashboard session. They are not included in the unauthenticated health response.

## Administration boundaries

- **Access Clients** may use MCP, Attach, and Project Binding. They do not receive Current Host administration.
- **Operator Clients** are a strict Access superset and may use `/v1/admin` plus the dashboard's authorized administration APIs.
- **MCP, Attach, Code Mode, OpenCode, and Pi/native tool projections** do not gain storage, backup, restore, key, import/export, or other administration tools.
- **Local `--global` operations** are trusted, destructive actions against this machine's global/Current Host scope. They are not a shortcut to a selected remote host. Use `--remote` for a paired remote target; it requires Operator authority for administration.
- Raw Vault Reveal remains a dashboard-only, human-confirmed, `no-store` action. Generic bearer administration rejects it.

## Legacy migration

### Automatic SQLite migration

Starting the SQL runtime through `caplets serve` (or the installed daemon) automatically initializes a fresh SQLite store when there is no reviewed legacy mutable authority. When reviewed legacy state exists, automatic migration is attempted only after strict source discovery, lockfile/path/hash validation, a migration election/mutex, platform exclusion, protected recovery backup, and credential protection.

Only strictly lockfile-tracked global Caplets and their installation provenance move into SQL. Untracked global files, Caplet configuration, project Caplets, and project lockfiles remain filesystem-owned. After validated activation, legacy mutable paths become protected recovery data and fail-closed tombstones.

If exclusion, manifests, hashes, key authority, or source scope cannot be proven, SQL authority is not activated. Stop every legacy replica and use the one-shot path.

### One-shot offline migration

```sh
caplets storage migrate --global --offline
```

Both flags are required. Stop every old replica first. The command never constructs an online runtime. For Postgres it selects the configured migrator and maintenance credentials one at a time, requires `migration.designated: true`, verifies old ready-node leases and writer fences are drained, runs schema migration under a durable drain, and then performs legacy initialization. A failed pre-activation attempt remains resumable or rolls back its inactive work; it must not publish partial SQL authority.

## Backup and recovery lifecycle

The released CLI currently exposes the one-shot legacy migration above. Protected backup, normal restore, catastrophic SQL-loss recovery, key maintenance, and bootstrap rolling activation are internal host-maintenance capabilities, deliberately not projected through MCP, Attach, native integrations, the dashboard, `/v1/admin`, or the package's public storage entrypoint. An operator deployment must invoke them through its trusted local orchestration integration; do not substitute ad-hoc database copies or invent shell commands.

### Protected backup

A protected backup uses a new data key and a versioned streaming AEAD envelope. The authenticated header binds logical host/store, source backend, schema and authority versions, entity manifest, and recovery-key reference. Each chunk binds its ordinal, length, prior digest, and header digest; a terminal manifest authenticates the complete stream. Wrapped key material and envelope bytes are written separately, then finalized in the durable backup inventory. A partial write is not a backup and must be reconciled from the lifecycle ledger.

Keep managed backup storage, the recovery wrap/unwrap authorities, and the Current Host store as separate failure domains. Deletion is complete only after durable intent, external absence verification, and a terminal receipt.

### Normal restore

Normal restore is an offline, confirmation-bound operation coordinated by `createNormalRestoreCoordinator(...).restore(confirmation)` internally:

1. fence every node and prove authentication fails closed;
2. preserve current non-restorable lifecycle ledgers and operation evidence;
3. authenticate and decrypt the selected backup;
4. stage historical domain rows into an inactive generation;
5. merge current backup/finalization/destruction/key-retirement knowledge, external destruction intents, consumed operation IDs, storage rescan results, and current retention cutoffs;
6. verify a durable readback of the inactive candidate;
7. atomically activate it under the expected authority/security generations; and
8. refresh keys/runtime before releasing the fence.

Normal restore preserves logical host, store ID, and operation namespace. It advances authority and security generations, invalidates pre-restore security authority, marks committed outcomes whose effects disappeared as superseded, and never resurrects data below current purge cutoffs. Before activation, failure discards the inactive candidate and releases the fence; after activation, recovery rolls forward.

### Catastrophic SQL-loss recovery

Catastrophic recovery is for loss of SQL authority, not ordinary rollback. The internal `createCatastrophicRecoveryCoordinator(...).recover(confirmation)` path requires:

- two owner-private checkpoint replicas;
- at least one checkpoint location outside both SQL and managed backup storage;
- the independently keyed `recovery-checkpoint` HMAC capability;
- the descriptor-selected authenticated checkpoint chain;
- complete backup/key/destruction inventory;
- proof that old authority and old join credentials are unusable; and
- a fresh, confirmation-bound destination.

Success creates a new store ID, operation namespace, authority generation, and security epoch; clears restored sessions, token families, approvals, roles, credentials, Project Binding leases, Vault grants, and old operation outcomes; writes a restored-SQL marker; and advances both external checkpoints before readiness. Old operation bindings resolve as `stale_namespace`, never as permission to replay. Missing/stale checkpoints, incomplete inventory, reachable old authority, or incomplete external destruction fail closed.

## Key rotation

Key rotation is a rolling internal maintenance sequence, not a manifest-file swap:

1. provision a compatible higher-generation `file-v1` provider bundle;
2. call `stageKeyVersion(purpose)` for each runtime purpose;
3. run `verifyKeyCanary(purpose, keyVersion)` on every ready node;
4. call `activateKeyVersion(purpose, keyVersion)` only after the ready cohort verifies the canary;
5. call `reencryptVaultValues()` and rewrite other live material under the active version;
6. advance purge watermarks and reconcile retained backup/destruction inventory;
7. obtain a fresh `rescanKeyRetirement(...)` preview; and
8. call `retireKeyVersion(...)` with the same live authority.

Retirement refuses active versions, live or undecryptable records, retained backups, tombstones, incomplete destruction receipts, insufficient watermarks, stale/expired previews, or stale authority. Keep decrypt-only keys until every retained backup and live record no longer depends on them.

## Rolling upgrade and rollback

Binary/schema/key/manifest compatibility is part of Postgres node admission. For a compatible binary rollout whose bootstrap fingerprint is unchanged, replace nodes gradually and require each node to become ready and converge before continuing.

For a bootstrap projection change, trusted local orchestration uses the internal maintenance coordinator:

1. `stageNextFingerprint(nextFingerprint)` while old authority remains active;
2. start new-image nodes; they remain not-ready while the staged fingerprint is not active;
3. drain old nodes and their writer fences;
4. run the one-shot migrator when a schema change is required; and
5. `activateNextFingerprint(nextFingerprint)` only after the old cohort is drained and the new cohort is compatible.

Before activation, `abortNextFingerprint(nextFingerprint)` preserves the old projection. After activation, recovery is roll-forward; use `reverseFingerprint(previousFingerprint)` only when the previous binary/schema/key/manifest range is still explicitly compatible. A database dump or image rollback alone must not bypass authority generation, migration drain, key, or manifest checks.

## Portable Caplet import/export

Portable Caplet envelopes are deterministic, versioned canonical JSON. They retain typed frontmatter, operator-facing Markdown, declared inputs, embedded assets, and relative references while rejecting credentials, authority tokens, database URLs, host paths, private keys, environment interpolation, unsafe links, symlinks/hardlinks/devices, path traversal/collisions, dangling references, and size-limit violations.

Import is a live-authorized administration mutation. It validates the complete envelope before reserving or staging artifacts, rejects filesystem-owned effective targets, requires explicit replacement for an existing SQL record, and leaves setup-dependent imports dormant until authorized setup and revalidation complete. Export is a live-authorized read of an explicitly identified SQL record and must not serialize host-owned secrets, resolved Vault values, credentials, authority, or materialized host paths. MCP, Attach, and native agent surfaces cannot import or export Current Host state.

The CLI exposes one low-level, typed operation surface:

```sh
caplets storage portable status --global [--json]
caplets storage portable status --remote [--json]
caplets storage portable operation '<operation JSON without binding>' --global [--operation-id <id>] [--json]
caplets storage portable operation '<operation JSON without binding>' --remote [--operation-id <id>] [--json]
```

Exactly one of `--global` or `--remote` is required. Operation JSON uses the exported `CurrentHostPortableOperation` kinds: `portable_import_session_create`, `portable_import_session_status`, `portable_import_session_append`, `portable_import_session_finalize`, `portable_import_preview`, `portable_import_activate`, `portable_setup_revalidate`, `portable_export_create`, or `portable_artifact_download_range`. Omit `binding`; the CLI creates it and optionally reuses `--operation-id`. For append, send the chunk as `bytesBase64`; local decoding is client-side.

`portable_status` is the only availability-independent observation, so a successfully observed `stale-read-only` result exits zero. Other operations require live authority. A rejected mutation exits one and prints recovery guidance. Local filesystem paths remain client-side; remote outcomes carry only artifact references or base64 payloads, never server filesystem paths.

## Offline SQLite-to-Postgres transfer boundary

Offline transfer is one-way: SQLite to a fresh Postgres destination. It is not online dual-write replication, Postgres-to-SQLite conversion, or a merge into an existing authoritative Postgres store.

Before cutover, every SQLite-serving process must be stopped, the source is fenced and sealed, a protected source backup is retained, destination identity/configuration is verified, and the transfer uses dedicated source/destination key capabilities rather than recovery unwrap authority. Canonical application-level manifests and semantic hashes must agree before the destination can activate.

Rollback is allowed only before durable destination activation and restores the exact sealed SQLite source while removing inactive destination work. Once destination authority is active, recovery is roll-forward only: retain the source backup and invalidation evidence, finish destination hydration/finalization, and never restart the sealed SQLite authority. Transfer preserves the logical host and source operation namespace but activates fresh destination authority/security generations and a destination store binding.

Run transfer only from a trusted local terminal:

```sh
caplets storage transfer start --global --offline --request '<SqlTransferStartRequest JSON>'
caplets storage transfer cutover <transfer-id> --global --offline --preview
caplets storage transfer cutover <transfer-id> --global --offline --confirmation '<confirmation JSON>'
caplets storage transfer rollback <transfer-id> --global --offline
caplets storage transfer finalize <transfer-id> --global --offline --preview
caplets storage transfer finalize <transfer-id> --global --offline --confirmation '<confirmation JSON>'
```

`--global` and `--offline` are required on every phase. Start accepts the complete typed request as JSON. Cutover and finalize are preview/execute pairs: use the fresh preview-issued confirmation JSON unchanged, and execute confirmation only with both stdin and stdout attached to a TTY. Receipts bind `target: "global"`, `mode: "offline"`, and `transport: "local"` and report the durable phase plus recovery guidance. Rollback is rejected after the durable destination-activation marker; from that point guidance is roll-forward only. These commands have no remote, MCP, Attach, or native exposure.
