# Self-hosting with composable shared storage

This guide is for operators running one Caplets deployment on one host or across several
runtime replicas. The deployment has **exactly one Writable Authority** for dashboard-managed
mutable state. Immutable Caplets supplied with the image or a read-only mount remain **Staged
Filesystem Sources** and compose with that authority; they are never a second writable store.

The authority stores the committed Current Host state (authority-managed Caplets, settings, Vault
ciphertext and grants, access state, setup approvals, sessions, activity, and receipts). Every
successful mutation publishes one complete Authority Generation. Replicas load complete generations
and expose them through their own runtime Exposure Generation. There is no live bidirectional
synchronization and no hot provider switch.

## Support and evidence boundary

The supported provider kinds are the four values in the generated config schema:

- `filesystem` — the default local authority; no network service is required.
- `sqlite` — a local Drizzle-backed SQLite authority for a single host. Do not put one SQLite
  file on a shared network filesystem or use it as a multi-replica coordination service.
- `postgresql` — the Drizzle-backed SQL authority for replicas that need a networked database.
  The deterministic provider fixture uses PostgreSQL **18.1**.
- `s3` — an S3-compatible authority using conditional object writes and ETags. The deterministic
  local fixture uses the digest-pinned MinIO image
  `docker.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936`.

The repository contains deterministic filesystem, SQLite, SQL migration, and S3 protocol tests,
and provider runs record the PostgreSQL and MinIO fixture versions. Credentialed AWS S3 and
Cloudflare R2 runs are separate live gates. Unless the release evidence names the account,
prefix, commit, and result, do **not** describe AWS or R2 as live-validated support. The S3
implementation is intentionally provider-neutral: AWS/R2/MinIO must each pass the same capability
probe and conditional-generation trace before being treated as validated in a deployment.

## Choose storage before deploying

Choose one provider for the lifetime of a deployment. The table describes the intended boundary,
not a promise that an arbitrary service with a compatible product name has passed the suite.

| Storage       | Choose it when                                                                            | Prerequisites and limits                                                                                                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filesystem    | One process or one host owns mutable state and you want the smallest setup.               | A writable Caplets directory. Omit `path` to use `<global-config-dir>/caplets`; a relative path resolves against the declaring global config. No shared network filesystem is required.                                                                                             |
| SQLite        | One host needs transactional durable state without a database service.                    | A local persistent regular file, writable by the runtime user. The package uses `better-sqlite3` **12.11.1**, Drizzle ORM **0.45.2**, and SQLite WAL/transaction semantics. SQLite requires Node, not Bun, and is not a cross-replica coordinator.                                  |
| PostgreSQL    | Multiple replicas must share one network store.                                           | A dedicated database/connection for this deployment on a PostgreSQL major exercised by the pinned provider matrix; the deterministic fixture is PostgreSQL **18.1**. The package uses `postgres` **3.4.9** and Drizzle ORM **0.45.2**. Apply the packaged logical migrations first. |
| S3-compatible | The deployment already has object storage and needs a provider-independent network store. | A distinct bucket/root path for this deployment, with `GetObject`, `PutObject`, `DeleteObject`, prefix listing, and conditional create/replace with ETags. Set `endpoint` and `forcePathStyle` for non-AWS endpoints. Live AWS/R2 compatibility remains an evidence gate.           |

All published packages require Node.js `>=22`. Install the published package on the target OS so
native `better-sqlite3` is built for that OS/architecture. The core package keeps provider
modules and native drivers lazy: a filesystem deployment does not need a database or object-store
service, while the selected SQL/S3 driver must be available when that provider is opened.

## Bootstrap and source inventory

The provider-shaped `storage` object is infrastructure-owned and is read only from the global
config (normally `$XDG_CONFIG_HOME/caplets/config.json`). A project config
(`.caplets/config.json`) must not define `storage`; loading one fails closed. Project config and
project Caplet files are staged inputs, not dashboard-owned state.

Every input path has one source owner. The normal inventory is:

- global config and the global storage directory: `authority`;
- project `.caplets/config.json` and project Caplet files mounted with the image: `staged`;
- active transport/workspace artifacts: `replica-local` or `client-local`;
- an explicitly selected migration source: `migration-input`.

Do not mount the same path into two owner classes. Inventory and migration inspect typed domains
and redacted digests; they do not sweep arbitrary JSON, export provider credentials, or copy
staged files. Inspect the source before changing storage:

```sh
caplets storage inventory --format json
```

Use the generated schema at `schemas/caplets-config.schema.json` (or
`https://caplets.dev/config.schema.json`) while editing global config. The four storage forms are:

### Filesystem

```json
{
  "version": 1,
  "storage": {
    "provider": "filesystem",
    "path": "/var/lib/caplets",
    "pollIntervalMs": 2500,
    "vaultKey": "env:CAPLETS_VAULT_KEY"
  }
}
```

`path` is optional. Omit it to use `<global-config-dir>/caplets`; a relative path resolves against
the global config that declares it. Keep the storage directory writable and staged project mounts
read-only.

### SQLite

```json
{
  "version": 1,
  "storage": {
    "provider": "sqlite",
    "path": "/var/lib/caplets/caplets.sqlite",
    "pollIntervalMs": 2500,
    "vaultKey": "env:CAPLETS_VAULT_KEY"
  }
}
```

Use a local persistent volume. Network/protocol paths are rejected, and SQLite is not a
multi-replica coordination service.

### PostgreSQL

```json
{
  "version": 1,
  "storage": {
    "provider": "postgresql",
    "connection": "env:CAPLETS_POSTGRES_URL",
    "pollIntervalMs": 2500,
    "vaultKey": "env:CAPLETS_VAULT_KEY"
  }
}
```

`connection` is the secret reference to the DSN; do not put a DSN or password in the JSON. Give
each deployment a dedicated PostgreSQL database/connection rather than a configurable storage
namespace. Run schema setup and status before starting replicas:

```sh
caplets storage schema migrate --config /etc/caplets/config.json
caplets storage schema status --config /etc/caplets/config.json --format json
```

### S3-compatible storage

```json
{
  "version": 1,
  "storage": {
    "provider": "s3",
    "bucket": "caplets-state",
    "region": "us-east-1",
    "path": "production/caplets",
    "credentials": "env:CAPLETS_S3_CREDENTIALS",
    "endpoint": "http://minio:9000",
    "forcePathStyle": true,
    "pollIntervalMs": 2500,
    "vaultKey": "env:CAPLETS_VAULT_KEY"
  }
}
```

`path` is the deployment's physical root, not a lifecycle namespace. Omitted or empty means
`.caplets/`; `team/project` becomes `team/project/.caplets/`. Give every deployment a distinct
bucket/root path. Omitting `credentials` deliberately uses the runtime's workload identity.
`CAPLETS_S3_CREDENTIALS`, when used, resolves to JSON containing `accessKeyId`,
`secretAccessKey`, and optionally `sessionToken`. Do not treat the provider's object layout as a
user contract.

## Secret references and Vault key continuity

`connection`, S3 `credentials`, and `vaultKey` are literal storage-bootstrap references, not
ordinary Caplet `$vault:` substitutions. The default runtime resolves `env:NAME` or a bare
environment-variable name. Server-local storage commands additionally resolve `vault:NAME` and
private `file:/…` references. A declared but missing or empty reference fails; never put a DSN,
S3 credential JSON, or Vault key bytes inline in config.

Use deployment-native injection for storage credentials and one stable Vault encryption key
reference on every replica. Resolved credentials and key bytes are not part of `CapletsConfig`,
Authority Generations, health output, diagnostics, logs, backups, or migration archives. Changing
the Vault key is not a hot rotation procedure and can make existing ciphertext unreadable.

Backup encryption uses a separate external key. Supply exactly one `--key-file`, `--key-env`,
`--key-vault`, or `--key-ref file:...|env:...|vault:...`; the key itself is never written to the
backup.

## Docker deployment examples

The repository's image defaults to Node 24, `XDG_CONFIG_HOME=/data/config`,
`XDG_STATE_HOME=/data/state`, and HTTP on port 5387. Build or pull the image, then provide the
same global config and staged bytes to every replica:

```sh
docker build -t caplets:local .
docker run --rm \
  -p 5387:5387 \
  -v "$PWD/data:/data" \
  -v "$PWD/staged/.caplets:/app/.caplets:ro" \
  --env-file .env \
  caplets:local
```

The staged mount must contain only read-only project config/Caplet files; keep the global storage
config under `/data/config/caplets/config.json`. For PostgreSQL, put the DSN and Vault key in the
container environment and use a persistent `/data` volume only for local state and caches; the
PostgreSQL service holds shared storage:

```sh
docker run --rm \
  -p 5387:5387 \
  -v caplets-data:/data \
  -v "$PWD/staged/.caplets:/app/.caplets:ro" \
  --env-file .env \
  --network caplets-net \
  caplets:local
```

Prefer Docker/Compose secrets or an orchestrator secret reference over inline `-e` values. For
MinIO, use the pinned image from the evidence section, expose its S3 endpoint only on the private
network, and set `endpoint` plus `forcePathStyle: true` in the global storage config. Do not
interpret a local MinIO run as AWS or R2 validation.

## Storage dashboard and generation flow

The Admin Dashboard manages Current Host storage, not raw provider tables. It can create, update,
and delete storage-managed Caplets, change permitted settings, manage Vault metadata and grants,
approve/revoke access, and install catalog Caplets. Each mutation carries the expected internal
Authority Generation and an idempotency key.

Staged entries are visibly read-only. Their IDs are reserved: dashboard create, install, update,
and delete operations that target a staged ID fail with source information instead of shadowing or
editing the staged definition. A non-colliding authority mutation commits one complete generation;
replicas refresh it without a process restart. A stale expected generation returns a conflict and
must be retried from the current dashboard view, not force-written.

The Storage dashboard distinguishes these states:

- **active/current:** storage is reachable and the active generation is current;
- **pending:** a committed head is observed but the complete generation has not activated yet;
- **degraded:** an already active generation remains available, but refresh or storage access
  failed; reads/execution may continue from last-known-good while writes are rejected;
- **unavailable/failed:** no valid generation is available or startup validation failed; startup
  fails closed rather than exposing only staged files;
- **read-only:** health reports `writable: false`; repair storage or the deployment before retrying
  mutations.

`connectivity`, `writable`, and `refresh` are independent fields. Do not infer that a reachable
provider is writable, or that a committed head is already exposed. Polling is bounded by the
configured interval (at most 2.5 seconds) plus finite read/activation deadlines; a local commit
also requests an immediate refresh.

## Inventory, migration, backup, restore, and cutover

Lifecycle commands are server-local and explicit. They never edit the source config, copy staged
files into shared storage, or synchronize two writable providers. Profile names are canonical
uppercase identifiers: for example, `--source-profile SOURCE_PROFILE` resolves
`CAPLETS_STORAGE_PROFILE_SOURCE_PROFILE`. Legacy Authority-prefixed profile variables are not
accepted, and there is no public target-namespace option.

1. **Inventory.** Run `caplets storage inventory --format json`; review typed domains, schema/head,
   generation identity, counts, exclusions, and redacted digests. Unknown or malformed host-owned
   records block apply.
2. **Dry-run.** Select source and destination configs/profiles that resolve to distinct physical
   stores. The destination must be empty and remain an unselected candidate until publish. Preview
   staged-ID collisions, provenance conversion, external-key fingerprints, and source digest:

   ```sh
   caplets storage migration dry-run \
     --source-config /etc/caplets/old-config.json \
     --destination-config /etc/caplets/new-config.json \
     --format json
   ```

   `caplets storage migrate` is an alternative spelling and requires exactly one explicit
   `--dry-run` or `--apply` intent.

3. **Fence and apply.** Stop all serving writers (or prove the source is read-only), acquire the
   provider-backed maintenance fence, recheck the complete source digest, and apply the reviewed
   plan exactly once:

   ```sh
   caplets storage migration apply \
     --source-config /etc/caplets/old-config.json \
     --destination-config /etc/caplets/new-config.json \
     --format json
   ```

   A raced writer, changed source digest, ambiguous grant mapping, non-empty target, staged-ID
   collision, or failed behavioral read-back invalidates the staging and publishes nothing.

4. **Verify.** Read the destination through the normal adapter, run `caplets storage inventory`
   and (for SQL) `caplets storage schema status`, then retain the cutover coordinates and
   generation identity in the deployment record.
5. **Cut over.** Redeploy/restart every replica with the new global storage config and the same
   staged bytes. There is no in-process provider switch and no hot synchronization between old and
   new stores.

Create an encrypted backup before a risky migration and restore only to a physically distinct,
empty, unselected destination store:

```sh
caplets storage backup create \
  --config /etc/caplets/config.json \
  --output /secure/caplets.authority.backup \
  --key-ref env:CAPLETS_BACKUP_KEY

caplets storage backup inspect-header \
  --input /secure/caplets.authority.backup --format json

caplets storage backup restore \
  --destination-config /etc/caplets/recovery-config.json \
  --input /secure/caplets.authority.backup \
  --key-ref env:CAPLETS_BACKUP_KEY \
  --format json
```

The authenticated backup preserves the generation, provenance, encrypted Vault values/grants,
access state, receipts, and auxiliary watermark. It excludes credentials, key bytes, staged files,
logs, journals, temporary artifacts, and rebuildable caches. Wrong keys, corrupt headers/bodies,
provider/schema mismatch, interruption, or a non-empty target fail closed.

### Rollback

Keep the old source store untouched until destination verification and cutover are complete. If
the new store fails before cutover, discard its unselected destination and continue serving the
old store. If failure occurs after cutover, stop writers, restore the last verified backup to a
distinct empty rollback store (or restore the old store from its own backup), verify through its
normal adapter, and redeploy all replicas to the rollback config. Do not run both stores as
writers, merge generations manually, or delete the old source before the rollback window closes.

## Failure recovery checklist

- **Fresh startup cannot reach configured storage:** fix credentials/network/schema and restart. If
  no valid generation has been loaded, Caplets fails closed and does not silently serve staged
  files alone.
- **Storage outage after activation:** preserve the last-known-good generation, reject writes, and
  monitor degraded/read-only health. Restore connectivity, then wait for a successful refresh; do
  not edit provider records by hand.
- **Pending or stale generation:** compare the internal authority ID, sequence, predecessor, digest,
  and staged fingerprint. A regressed/equal head or digest mismatch is rejected; repair storage or
  restore a verified backup.
- **Concurrent dashboard mutation:** use the current generation and a new idempotency key. A replay
  with the same key and payload is safe; reusing a key for a different payload is rejected.
- **Migration fence held after an interrupted command:** inspect the provider health/lease owner,
  let the finite lease expire or release it with the owning lifecycle command, then rerun inventory
  and dry-run. Never remove lease rows manually.
- **Staged collision:** rename the staged ID in source control or remove the storage-managed record
  in a reviewed migration; the dashboard cannot override a staged ID.

## Provider compatibility caveats

### S3-compatible endpoints

The authority stores immutable generation objects and conditionally advances a small head object.
A service must preserve the required ETag/conditional semantics for `PutObject` create/replace,
`GetObject`, `DeleteObject`, and prefix listing, and must return enough information to resolve an
ambiguous write by read-back. The capability probe rejects endpoints that ignore preconditions or
do not return usable ETags.

- **AWS S3:** use the bucket's region and ordinary virtual-host addressing unless your endpoint
  requires otherwise. This repository has no credentialed live AWS result in this document; use a
  release evidence record before claiming AWS support.
- **Cloudflare R2:** use the account S3 endpoint and region `auto`; give the deployment a distinct
  bucket/root path. This repository has no credentialed live R2 result in this document; use a
  release evidence record before claiming R2 support.
- **MinIO:** set the private endpoint and usually `forcePathStyle: true`. The deterministic fixture
  is the digest-pinned image named above. A passing local fixture/conformance run proves the
  protocol trace under that fixture, not every MinIO deployment or AWS/R2 behavior.

Do not rely on bucket listing as a transaction, provider-specific record layouts, or last-writer-
wins behavior. Conditional head updates and immutable generations are the consistency boundary.

### PostgreSQL

Use the PostgreSQL major exercised by the pinned provider runner; the deterministic fixture for
this release is PostgreSQL 18.1. The runtime uses the `postgres` 3.4.9 client and Drizzle ORM
0.45.2. Provide the runtime role with only the authority schema's DML rights; run schema migration
with a controlled maintenance identity, then verify status. Give unrelated Current Hosts distinct
PostgreSQL databases/connections.

### SQLite and filesystem

SQLite uses WAL, busy timeouts, and the native backup API through `better-sqlite3` 12.11.1. Keep
the file local and persistent, and back it up through Caplets lifecycle commands rather than copying
live WAL files. Filesystem storage uses atomic generation publication and a maintenance fence;
keep its storage directory writable and staged source directories immutable.

## Evidence commands

Use the focused commands below when qualifying a deployment or release. They exercise the contract
without requiring provider-internal table/object knowledge:

```sh
pnpm schema:check
pnpm --filter @caplets/core test -- \
  test/storage-contract.test.ts \
  test/storage-composition.test.ts \
  test/storage-filesystem-authority.test.ts \
  test/storage-sqlite-authority.test.ts \
  test/storage-sql-migrations.test.ts \
  test/storage-s3-authority.test.ts \
  test/storage-s3-conformance.test.ts
```

The PostgreSQL authority tests require an explicit `TEST_POSTGRES_URL`; the S3 live profiles
require explicit `CAPLETS_STORAGE_LIVE_*` credentials and isolated prefixes. Missing credentials
must leave those live tests skipped or fail the release gate, never turn deterministic evidence
into an unqualified AWS/R2 claim.
