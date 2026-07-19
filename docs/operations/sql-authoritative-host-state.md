# SQL Authoritative Host State Operations

Caplets stores host-owned records in exactly one SQL backend. SQLite is the default for a single
Host Node. PostgreSQL supports several Host Nodes for one logical host. There is no PostgreSQL to
SQLite fallback, SQLite write buffer, dual write, or built-in backend copier.

Run storage administration as a server-local operator and keep every Host Node stopped whenever a
procedure below says the operation is offline.

> **Required for upgrades to `caplets@0.26.0` or later:** If the host ran
> `caplets@0.25.x` or earlier, complete the
> [offline legacy filesystem migration](#offline-legacy-filesystem-migration) before
> restarting the daemon, running `caplets setup`, or serving requests. Caplets does not
> automatically migrate or fall back to legacy Authoritative Host State.

## SQLite

### Location and configuration

With no `storage` field, Caplets uses SQLite at:

| Environment                       | Default database                                           |
| --------------------------------- | ---------------------------------------------------------- |
| Linux/macOS                       | `${XDG_STATE_HOME:-$HOME/.local/state}/caplets.sqlite3`    |
| Windows                           | `%LOCALAPPDATA%\caplets.sqlite3`                           |
| Docker Compose in this repository | `/data/state/caplets.sqlite3` in the `caplets-data` volume |

An explicit global config path overrides the database location:

```json
{
  "version": 1,
  "storage": {
    "type": "sqlite",
    "path": "/srv/caplets/state/host.sqlite3"
  }
}
```

The global config owns this setting; project config cannot override it. On startup, SQLite enables
foreign keys, WAL journaling, full synchronous writes, and a busy timeout. Ordered migrations run
before SQLite serves. A failed migration rolls back and prevents startup; a binary that sees a newer
unknown schema also fails closed.

Check the configured backend, released schema version, Caplet Record count, and asset health:

```sh
caplets storage status --json
```

### Backup

Stop the daemon and every foreground Host Node first. `sqlite3 .backup` produces one consistent
file even if WAL sidecars remain from the last run:

```sh
set -eu
DB=${XDG_STATE_HOME:-"$HOME/.local/state"}/caplets.sqlite3
BACKUP="/srv/backups/caplets-$(date -u +%Y%m%dT%H%M%SZ).sqlite3"
umask 077
sqlite3 "$DB" ".backup '$BACKUP'"
sqlite3 "$BACKUP" 'PRAGMA integrity_check; PRAGMA foreign_key_check;'
```

The first result must be `ok`; `foreign_key_check` must print no rows. Store the backup on different
durable media and record the Caplets release and `schemaVersion` beside it. If `storage.assets.type`
is `s3`, also take a versioned snapshot of the configured bucket/prefix at the same offline point.
SQL-backed asset payloads are already inside the SQLite backup. Back up node-local media artifacts
separately if they matter; SQL does not make their bytes durable.

### Restore

1. Stop every Host Node.
2. Preserve the failed/current database and any `-wal`/`-shm` sidecars for diagnosis.
3. Restore the database to the exact configured path with owner-only permissions. Restore the
   matching object-store snapshot when S3 assets were in use.
4. Remove stale SQLite `-wal` and `-shm` files only after preserving them and only while no process
   has the database open.
5. Start one node and require both `caplets storage status --json` and `/v1/healthz` to report ready
   before returning traffic.

```sh
set -eu
DB=${XDG_STATE_HOME:-"$HOME/.local/state"}/caplets.sqlite3
install -m 600 /srv/backups/caplets-YYYYMMDDTHHMMSSZ.sqlite3 "$DB"
sqlite3 "$DB" 'PRAGMA integrity_check; PRAGMA foreign_key_check;'
caplets storage status --json
```

Do not restore a database whose schema is newer than the running Caplets release.

## PostgreSQL

### One schema is one logical host

One PostgreSQL schema represents one logical Caplets host and one stable host identity. Multiple
logical hosts may share a database only when each has a separate schema and separate credentials.
Do not put a tenant/host discriminator into Caplets tables and do not point two logical hosts at the
same schema.

All nodes for one host need the same global storage configuration:

```json
{
  "version": 1,
  "storage": {
    "type": "postgres",
    "connectionString": "postgresql://caplets_runtime:<injected-password>@db.example:5432/caplets",
    "schema": "caplets_prod"
  }
}
```

The database URL is a bootstrap secret: the database must open before Caplets Vault can be read.
Render the global config from a deployment secret, mount a secret-generated file, or use an
orchestrator secret mechanism. Do not commit the rendered URL, log it, or place it in a Caplets Vault
reference. The config file itself does not define `CAPLETS_STORAGE_*` environment mappings.

The schema name defaults to `caplets` and must match `^[a-z_][a-z0-9_]{0,62}$`. Every connection
sets that schema as its PostgreSQL `search_path`.

### Separate migration and runtime roles

PostgreSQL runtime startup never applies DDL. An explicit, one-shot job must run:

```sh
caplets storage schema-migrate
```

Use a DDL-capable migrator URL for that job. Runtime nodes use a different DML-only URL and start
only after the job exits successfully. The hardened Compose reference reconciles this boundary with
the packaged `deploy/postgres/provision-roles.mjs` helper; substitute identifiers through your
provisioning tool rather than interpolating untrusted strings into SQL:

```sql
REVOKE ALL ON DATABASE caplets FROM PUBLIC;

CREATE ROLE caplets_migrator LOGIN NOINHERIT PASSWORD '<deployment-secret>';
CREATE ROLE caplets_runtime LOGIN NOINHERIT PASSWORD '<different-deployment-secret>';

GRANT CONNECT, CREATE ON DATABASE caplets TO caplets_migrator;
GRANT CONNECT ON DATABASE caplets TO caplets_runtime;

CREATE SCHEMA caplets_prod AUTHORIZATION caplets_migrator;
REVOKE ALL ON SCHEMA caplets_prod FROM PUBLIC;
GRANT USAGE ON SCHEMA caplets_prod TO caplets_runtime;

ALTER ROLE caplets_migrator IN DATABASE caplets SET search_path TO caplets_prod;
ALTER ROLE caplets_runtime IN DATABASE caplets SET search_path TO caplets_prod;

ALTER DEFAULT PRIVILEGES FOR ROLE caplets_migrator IN SCHEMA caplets_prod
  REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE caplets_migrator IN SCHEMA caplets_prod
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO caplets_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE caplets_migrator IN SCHEMA caplets_prod
  REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE caplets_migrator IN SCHEMA caplets_prod
  GRANT USAGE, SELECT ON SEQUENCES TO caplets_runtime;
```

After every migration, revoke runtime writes to the migration control tables while preserving the
schema marker read required by health checks:

```sql
REVOKE ALL ON TABLE
  caplets_prod.caplets_migrations,
  caplets_prod.caplets_schema
FROM caplets_runtime;
GRANT SELECT ON TABLE caplets_prod.caplets_schema TO caplets_runtime;
```

Default privileges apply again when future migration objects are created, so finalizing runtime
grants is part of every one-shot migration job. The hardened Compose deployment runs the packaged
`finalize-runtime-grants.mjs` helper after `schema-migrate`.

`LISTEN`/`NOTIFY` and advisory-lock functions do not require table ownership. Do not grant the
runtime role `CREATE`, `TRUNCATE`, schema ownership, role administration, or migration credentials.
Default privileges are attached to objects subsequently created by `caplets_migrator`; if an
administrator or another owner creates an object, explicitly repair its ownership/grants before
runtime starts. Rotate migrator and runtime credentials independently.

The PostgreSQL documentation defines the relevant
[`GRANT`](https://www.postgresql.org/docs/17/sql-grant.html),
[`ALTER DEFAULT PRIVILEGES`](https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html),
and [schema/search-path](https://www.postgresql.org/docs/17/ddl-schemas.html) behavior.

### Standalone Docker Compose deployments

The release publishes three alternative, standalone deployment descriptors. Download and run
exactly one; do not combine them as overlays:

```sh
curl -fLO https://github.com/spiritledsoftware/caplets/releases/latest/download/docker-compose.yml
curl -fLO https://github.com/spiritledsoftware/caplets/releases/latest/download/docker-compose.postgres.yml
curl -fLO https://github.com/spiritledsoftware/caplets/releases/latest/download/docker-compose.postgres-hardened.yml
```

The release assets use published Caplets images and contain no local build context or checkout bind
mount. Set `CAPLETS_IMAGE` to use a version, digest, or explicitly built local image.

#### SQLite convenience deployment

`docker-compose.yml` needs no required environment variables:

```sh
docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml up -d --wait
```

It binds `127.0.0.1:5387` and persists config, state, and SQLite data in `caplets-data`.

#### PostgreSQL convenience deployment

`docker-compose.postgres.yml` is for fresh deployments. It deliberately uses one `caplets` owner
role for initialization, migration, and runtime access. The runtime credential can therefore apply
DDL and modify migration metadata; use the hardened deployment when that boundary is unacceptable.
The one-shot provisioning helper creates that non-superuser owner, then replaces the bootstrap
`postgres` password with a discarded random value so the runtime credential cannot authenticate as
the cluster superuser.

Create one owner-only password file for Compose interpolation, then start the standalone topology:

```sh
umask 077
printf 'CAPLETS_POSTGRES_PASSWORD=%s\n' "$(openssl rand -base64 32)" > .env
chmod 600 .env
docker compose -f docker-compose.postgres.yml config --quiet
docker compose -f docker-compose.postgres.yml up -d --wait
```

The PostgreSQL image defaults to `postgres:17-bookworm`. Set `CAPLETS_POSTGRES_IMAGE` to select a
different full image reference. The migration job must complete successfully before runtime starts.

Do not point this file at a volume initialized by the former three-role overlay.

#### Hardened PostgreSQL reference

`docker-compose.postgres-hardened.yml` is a hardened single-Docker-host reference, not a
high-availability topology. It retains separate administrator, migrator, and runtime roles, exact
image defaults, file-backed secrets, an internal database network, read-only non-root Caplets
containers, dropped capabilities, bounded logs, and a 60-second PostgreSQL shutdown grace period.

Create three owner-only host secret files:

```sh
mkdir -p secrets
chmod 700 secrets
umask 077
openssl rand -base64 32 > secrets/postgres-admin-password
openssl rand -base64 32 > secrets/postgres-migrator-password
openssl rand -base64 32 > secrets/postgres-runtime-password
chmod 600 secrets/postgres-*-password
docker compose -f docker-compose.postgres-hardened.yml config --quiet
docker compose -f docker-compose.postgres-hardened.yml up -d --wait
```

The short-lived `caplets-postgres-secrets` service copies each Compose secret into a role-scoped
Docker volume owned by the non-root Caplets user. Runtime mounts only the runtime credential.
PostgreSQL and the migration service attach only to the internal database network; runtime also
attaches to an egress network. PostgreSQL has no published host port, and Caplets binds loopback by
default. Put remote access and TLS behind an operator-managed reverse proxy or private network.

Existing users of the former two-file, three-role overlay can reuse its project-scoped volumes:

1. Keep the same Compose project name or `-p` value.
2. Copy the existing administrator, migrator, and runtime password values into the three secret
   files above instead of generating replacements.
3. Stop the old overlay without `--volumes`.
4. Start only `docker-compose.postgres-hardened.yml`.

The administrator secret must match the credential already stored in PostgreSQL. Changing its file
cannot rotate that credential because the old value is needed to authenticate. Rotate it over the
container's protected loopback connection, then replace the file and recreate the affected services
in this order:

```sh
set -eu
new_admin_secret=$(mktemp secrets/postgres-admin-password.XXXXXX)
chmod 600 "$new_admin_secret"
openssl rand -base64 32 > "$new_admin_secret"
new_admin_password=$(cat "$new_admin_secret")

docker compose -f docker-compose.postgres-hardened.yml exec -T caplets-postgres \
  sh -ec 'export PGPASSWORD="$(cat /run/secrets/caplets_postgres_admin_password)"
    exec psql --no-psqlrc --host 127.0.0.1 --username caplets_admin \
      --dbname "$POSTGRES_DB" --set=ON_ERROR_STOP=1' <<SQL
\set new_password '$new_admin_password'
ALTER ROLE caplets_admin PASSWORD :'new_password';
SQL

mv "$new_admin_secret" secrets/postgres-admin-password
chmod 600 secrets/postgres-admin-password
unset new_admin_password
docker compose -f docker-compose.postgres-hardened.yml up -d --wait --no-deps --force-recreate caplets-postgres
docker compose -f docker-compose.postgres-hardened.yml up --no-deps --force-recreate caplets-postgres-secrets
docker compose -f docker-compose.postgres-hardened.yml up --no-deps --force-recreate caplets-postgres-migrate
docker compose -f docker-compose.postgres-hardened.yml up -d --wait --no-deps --force-recreate caplets
```

The running container authenticates with the old mounted secret; the new value travels on standard
input rather than in command arguments. Recreating PostgreSQL remounts the replaced secret file
before another rotation is attempted. If authentication fails, the active secret file is unchanged
and the staged `postgres-admin-password.*` file contains the unused replacement. Migrator and runtime
passwords are reconciled by the pre-start job.

#### Operations and upgrades

Check readiness and inspect logs:

```sh
curl --fail http://127.0.0.1:5387/v1/healthz
docker compose -f <selected-compose-file> logs --tail 100
```

Stop containers while preserving data:

```sh
docker compose -f <selected-compose-file> down
```

For convenience deployments, pull the selected moving image before recreating services:

```sh
docker compose -f <selected-compose-file> pull
docker compose -f <selected-compose-file> up -d --wait
```

The hardened file defaults to exact image versions. Before changing either image reference, take a
database backup, verify a restore, update the exact tag or digest, and rerun `up -d --wait`. Schema
migrations are forward-only; rolling back a container image does not roll back the schema.

The supplied topology does not provide backups, certificate management, monitoring, or arbitrary
resource limits. Treat `caplets-data` and `caplets-postgres-data` as single-host Docker volumes, not
cross-host or high-availability storage.

### Readiness and fail-closed behavior

`GET /v1/healthz` is the readiness probe and returns HTTP 503 when the host is not ready. PostgreSQL
readiness requires:

- authoritative database connectivity and the exact released schema version;
- successful host/node identity registration;
- no global Caplet File manifest conflict;
- no keyed runtime-affecting configuration fingerprint conflict;
- a valid current SQL snapshot; and
- object-store connectivity when current Caplet bundle assets require it.

An absent/outdated PostgreSQL schema is not auto-migrated. A newer unknown schema also fails closed.
If PostgreSQL becomes unavailable, SQL-dependent requests return retryable unavailable errors; nodes
do not keep serving stale SQL Caplets or stale security state. A committed mutation invalidates other
nodes through PostgreSQL notification, with host-generation polling as fallback; the default
cross-node convergence bound is five seconds.

Liveness must be a separate process/container check if an orchestrator needs to distinguish “process
running” from “safe to receive traffic.” Do not replace readiness with a TCP-only database check.

## Cluster runtime parity and node-local state

### Global Caplet Files

Global Caplet Files remain authoritative overlays and therefore must have the same manifest on every
node in one PostgreSQL host. Mount the same immutable release/config volume or deploy byte-identical
files to every node. Resolved runtime-affecting global configuration must also be identical, including
resolved environment values. Caplets compares a keyed fingerprint without storing or logging those
values. Listen addresses, logs, and process-local options are excluded; project files are
session/project-scoped and excluded.

A manifest or fingerprint mismatch fails readiness. Do not drain that protection by routing traffic
to a disagreeing node anyway.

### Code Mode affinity

Live Code Mode Sessions and heap objects are node-local. Use connection/session affinity for a live
session. Losing its owning node loses closures, objects, timers, and handles; SQL does not reconstruct
them. Follow the existing Code Mode recovery guidance and replay only operations the operator/agent
has determined are safe. New work may start a fresh session on a healthy node.

### Project Binding loss and rebind

Workspace bytes remain on the owning node. PostgreSQL durably coordinates binding leases,
manifests/revisions, and readiness metadata, not workspace content. When an owning node is lost,
affected Caplets are quarantined rather than silently routed to another node. The client must rebind
to a healthy node and fully resynchronize before those Caplets become ready. Do not clear quarantine
or mark a binding ready without the resync.

Node-local media artifacts likewise require owner routing/affinity and are lost with local storage.
Use S3-compatible artifact storage when artifacts must survive node loss or be read from any node.

## Caplet asset object storage

The default bundle asset payload store is content-addressed SQL storage. To move bundle assets to an
S3-compatible backend, configure the common `storage.assets` field:

```json
{
  "version": 1,
  "storage": {
    "type": "postgres",
    "connectionString": "postgresql://caplets_runtime:<injected-password>@db.example:5432/caplets",
    "schema": "caplets_prod",
    "assets": {
      "type": "s3",
      "endpoint": "https://objects.example.com",
      "region": "us-east-1",
      "bucket": "caplets-production",
      "prefix": "host-a",
      "forcePathStyle": false
    }
  }
}
```

`endpoint`, `prefix`, and `forcePathStyle` are optional. `region` and `bucket` are required. Prefer
workload identity/the AWS SDK credential chain; otherwise render both `accessKeyId` and
`secretAccessKey` from deployment secrets. These are database-bootstrap peers and cannot come from
Caplets Vault.

Uploads are staged and read-back hash-verified before SQL references them. SQL reference deletion
precedes retryable object deletion; leased garbage collection removes unreferenced objects only
after its safety grace period. Give every node the same bucket/prefix and credentials. Back up and
restore SQL plus the matching object version set as one recovery point.

Object-store failure makes storage unhealthy when a current Caplet bundle needs an object. The
Caplet is quarantined; missing bytes are never replaced with empty content. Optional media-artifact
storage can be degraded independently only when a configured local fallback is valid.

## Offline legacy filesystem migration

This migration moves tracked global Caplets, backend auth tokens, Vault values and grants,
remote-client security state, setup state, Operator Activity Log entries, and the old global
lockfile into the selected SQL backend. Untracked global Caplet Files remain in place as
authoritative overlays. There is no dual write and no destructive migration at first startup.

> **This is a required, one-time upgrade step.** Skipping it can make existing backend
> credentials, Vault values and grants, remote clients, setup history, Operator Activity,
> and tracked global Caplets appear missing. Fresh hosts that never ran a version before
> 0.26.0 do not need it.

1. Stop every Host Node (or enter exclusive maintenance).
2. Back up every legacy state root, the selected SQL database, and the object prefix.
3. Verify with a dry run. The command uses the platform global-config directory and global
   lockfile path by default; use `--caplets-root` or `--lockfile` only for nonstandard paths:

   ```sh
   caplets storage migrate-legacy --dry-run
   ```

4. Resolve every missing artifact, hash/provenance mismatch, ID collision, or validation failure.
5. Run the same command without `--dry-run`:

   ```sh
   caplets storage migrate-legacy
   ```

The command takes an exclusive migration lock, imports all applicable domains transactionally,
compares counts/content hashes, and only after commit moves migrated files and the old lockfile into
a timestamped backup. A shared Vault encryption key remains active and is copied into the backup.
Record the printed backup path. Restart only after `caplets storage status --json` is ready. After
cutover the legacy stores are not a fallback.

## Offline SQLite-to-PostgreSQL transfer

Caplets intentionally has no built-in backend copier. The following external recipe pins the
official pgloader image by immutable manifest digest:

```text
ghcr.io/dimitri/pgloader@sha256:f4d2e2d7229980516da69b1eb73d9e11f97fb567fce7421f5a0bc70cbe6c76bf
```

That artifact reports `pgloader 3.6.10~devel` and identifies official source revision
[`1c8e2e6d7b2f474191c0c63214f75bfcc329e604`](https://github.com/dimitri/pgloader/tree/1c8e2e6d7b2f474191c0c63214f75bfcc329e604).
The digest, rather than mutable `latest`, is the executable version pin. Rehearse the exact Caplets
release, data volume, architecture, network path, and object store against a disposable target
first.

The exact options below are source-verified against the pinned revision's official
[SQLite loader reference](https://github.com/dimitri/pgloader/blob/1c8e2e6d7b2f474191c0c63214f75bfcc329e604/docs/ref/sqlite.rst):

- `data only`, `include no drop`, `no truncate`, and `reset no sequences` constrain the run to row
  copy without target drop/truncate/sequence changes;
- `create no tables` is deliberately **not** used: the official reference says that option removes
  and reinstalls target constraints/indexes, which is not a DML-only transfer;
- `no foreign keys` prevents pgloader from dropping/recreating the already migrated foreign keys;
- `INCLUDING ONLY TABLE NAMES LIKE` selects one table per command so the verifier can execute tables
  in the SQLite foreign-key graph's topological order while target constraints stay enabled;
- `ALTER SCHEMA 'public' RENAME TO ...` maps SQLite's source catalog to the pre-migrated host schema;
  the pinned
  [SQLite command grammar](https://github.com/dimitri/pgloader/blob/1c8e2e6d7b2f474191c0c63214f75bfcc329e604/src/parsers/command-sqlite.lisp)
  accepts the foreign-key, filter, and common schema clauses; and
- `EXCLUDING TABLE NAMES LIKE` omits backend-specific migration metadata already created by the
  PostgreSQL migration job.

The image metadata and digest come from pgloader's official
[container publishing workflow](https://github.com/dimitri/pgloader/blob/1c8e2e6d7b2f474191c0c63214f75bfcc329e604/.github/workflows/docker-publish.yml).

### 1. Freeze and back up

- Run the same released Caplets version on source and target tooling.
- Stop **all** source Host Nodes and keep writers stopped through verification/cutover.
- Create and integrity-check a SQLite `.backup` as described above.
- Snapshot the S3 bucket/prefix and node-local artifacts when used.
- Preserve the original global config unchanged for rollback.

### 2. Prepare a fresh target

Create a new, otherwise unused PostgreSQL schema. Run `caplets storage schema-migrate` with its
migrator URL. Never point the runtime at it yet. Use the DML-only runtime role for the transfer; its
`current_schema()` must be the target schema.

Require equal released schema markers:

```sh
sqlite3 "$SQLITE_BACKUP" \
  'SELECT version FROM caplets_schema WHERE singleton = 1;'
psql "$CAPLETS_POSTGRES_RUNTIME_URL" -X -qAt -v ON_ERROR_STOP=1 \
  -c 'SELECT current_schema(), version FROM caplets_schema WHERE singleton = 1;'
```

Abort unless versions are present and equal, `current_schema()` is the intended one, source/target
application table sets match, and every target application table is empty. `caplets_schema` and
`caplets_migrations` are target migration metadata, not copied application data.

### 3. Transfer data only

Create the load file in a mode-`0700` temporary directory, with a mode-`0600` file, and delete it on
exit because it contains the target URL. Use one command of this form per application table, ordered
by the source SQLite foreign-key graph. `scripts/verify-sqlite-postgres-transfer.sh` derives that
order from `pragma_foreign_key_list` and generates the complete file:

```lisp
LOAD DATABASE
     FROM sqlite:///work/source.sqlite3
     INTO postgresql://caplets_runtime:PERCENT_ENCODED_PASSWORD@127.0.0.1:5432/caplets

 WITH data only,
      include no drop,
      no truncate,
      reset no sequences,
      no foreign keys,
      downcase identifiers

 INCLUDING ONLY TABLE NAMES LIKE 'ONE_TABLE_FROM_FK_ORDER'
 ALTER SCHEMA 'public' RENAME TO 'caplets_prod'
 EXCLUDING TABLE NAMES LIKE 'caplets_migrations', 'caplets_schema';
```

Copy the offline backup into `$TRANSFER_WORK`; pgloader's SQLite client needs that disposable copy's
directory writable for SQLite sidecars. The original backup remains untouched and the mode-`0700`
work directory is deleted after the run:

```sh
docker run --rm --network host \
  --mount type=bind,src="$TRANSFER_WORK",dst=/work \
  ghcr.io/dimitri/pgloader@sha256:f4d2e2d7229980516da69b1eb73d9e11f97fb567fce7421f5a0bc70cbe6c76bf \
  pgloader /work/sqlite-data-only.load
```

Do not combine all tables into one parallel COPY and do not add `disable triggers`: child tables may
race their parents, while disabled triggers can leave invalid data. The verifier instead preserves
and exercises target foreign keys throughout the dependency-ordered COPY. Do not retry into a
partially loaded schema; if pgloader fails, drop/recreate the disposable target schema, rerun the
Caplets migration job, and start again.

### 4. Verify while still offline

`scripts/verify-sqlite-postgres-transfer.sh` performs the guarded empty-target check, pinned transfer,
per-table row counts, SQLite integrity/foreign-key checks, PostgreSQL constraint checks, and durable
content-hash projections for revisions, asset bytes/keys, bundle entries, and installation
observations. It requires `sqlite3`, Docker (also used for a pinned `psql` client when no local
client is installed), a stopped source, and a newly migrated disposable target:

```sh
CAPLETS_SQL_TRANSFER_CONFIRM=offline-empty-target \
CAPLETS_SQLITE_SNAPSHOT=/srv/backups/caplets.sqlite3 \
CAPLETS_TEST_POSTGRES_URL="$CAPLETS_POSTGRES_RUNTIME_URL" \
CAPLETS_POSTGRES_SCHEMA=caplets_prod \
./scripts/verify-sqlite-postgres-transfer.sh
```

The current released schema owns no PostgreSQL sequences. The verifier asserts that. If a future
released schema introduces an identity/sequence, stop and use that release's documented reset
procedure with the migrator role, then prove the next generated value is above the imported maximum.
Do not guess or rely on pgloader's generic reset against a pre-migrated schema.

Finally run Caplets' own health check with the target runtime configuration, including real object
store credentials:

```sh
caplets storage status --json
```

For the hardened Compose reference before runtime cutover:

```sh
docker compose -f docker-compose.postgres-hardened.yml run --rm --no-deps caplets \
  /bin/sh -ec 'node /usr/local/lib/caplets/postgres/render-config.mjs runtime && node dist/index.js storage status --json'
```

Require ready database/schema health, expected Caplet Record and asset counts, object-store
connectivity, no missing current bundle object, and successful read/export smoke checks for critical
Caplets.

### 5. Cut over atomically

1. Keep source nodes stopped.
2. Render a new owner-only global config selecting the verified PostgreSQL schema/runtime URL.
3. Atomically rename it over the global config on the same filesystem, or atomically promote the
   orchestrator release/secret version.
4. Start one node; require storage status and `/v1/healthz` readiness. Confirm global-file manifest
   parity and critical read-only Caplet operations.
5. Start remaining nodes and only then move traffic.
6. Retain the untouched SQLite backup/config and object snapshot for the rollback window.

### Rollback

Stop every PostgreSQL-backed node before rollback. Atomically restore the saved SQLite global config
and database file plus its matching object snapshot, then start one SQLite node and verify storage
status/readiness before restoring traffic. Do not merge writes made after PostgreSQL cutover back into
SQLite. If PostgreSQL accepted writes, rollback loses them; either accept that recovery point or
repair PostgreSQL and roll forward. Keep the failed target schema isolated for diagnosis rather than
reusing it for another transfer.
