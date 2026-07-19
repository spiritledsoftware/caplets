# Standalone Docker Compose Deployments

## Summary

Distribute Caplets Docker Compose deployments that run from a downloaded Compose file without a Git checkout, local image build, or bind-mounted repository scripts. The repository will provide three mutually exclusive, standalone deployment descriptors:

- `docker-compose.yml` for a convenient SQLite deployment;
- `docker-compose.postgres.yml` for a convenient, fresh PostgreSQL deployment using one database role and one password; and
- `docker-compose.postgres-hardened.yml` for a hardened single-Docker-host PostgreSQL reference using separate administrator, migrator, and runtime roles.

The runtime and one-shot PostgreSQL migration job use the same published Caplets image so their schema expectations cannot drift. All deployment helpers required by the PostgreSQL descriptors are packaged in that image.

## Goals

- Let a user download one Compose file and start the selected deployment without the Caplets source tree.
- Make each Compose file complete rather than layering the PostgreSQL topology over `docker-compose.yml`.
- Use published multi-architecture Caplets images by default while allowing full image-reference overrides.
- Preserve explicit, successful pre-start PostgreSQL migration gating.
- Provide a low-configuration PostgreSQL option with one user-managed password.
- Provide a separate hardened reference that demonstrates least-privilege database roles, file-backed secrets, network separation, and container restrictions.
- Publish the three Compose files as GitHub Release assets at the same release boundary as the Caplets image.
- Preserve a practical upgrade path for existing three-role PostgreSQL Compose deployments.

## Non-Goals

- Do not retain local `build:` sections in the distributed Compose files.
- Do not support combining the SQLite and PostgreSQL files as Compose overlays.
- Do not automatically convert an existing three-role PostgreSQL database into the convenience one-role topology.
- Do not make the convenience PostgreSQL topology a replacement for the broader separate-role architectural recommendation.
- Do not make the hardened descriptor a multi-host or universally sufficient production platform.
- Do not bundle TLS termination, certificate automation, centralized logging, monitoring, backup storage, restore automation, or a reverse proxy.
- Do not invent universal CPU or memory limits.
- Do not add a public Caplets CLI command for the supplied Compose topology's role provisioning.
- Do not add a separate migrator image.

## Deployment Artifact Contract

The three Compose files are alternatives. A user runs exactly one file for a Compose project. Combining them is unsupported.

The files do not set a top-level Compose project name. Normal directory-based naming and explicit `docker compose -p NAME` overrides remain available. This preserves multiple installations on one host and avoids silently redirecting existing project-scoped volumes.

All descriptors retain the existing `caplets` service name, `caplets-data` volume key, loopback HTTP binding default, configurable bind address and port, and runtime health check. PostgreSQL descriptors retain the `caplets-postgres`, `caplets-postgres-migrate`, and `caplets-postgres-data` names.

The convenience descriptors may load an optional `.env` file into the Caplets runtime for backend-specific environment configuration. The hardened descriptor does not pass an unrestricted `.env` into containers; it declares operational inputs explicitly and leaves additional backend credentials to Caplets Vault or an operator-owned Compose override.

## Published Caplets Image

`docker-compose.yml` and `docker-compose.postgres.yml` use:

```yaml
image: ${CAPLETS_IMAGE:-ghcr.io/spiritledsoftware/caplets:latest}
```

A user may set `CAPLETS_IMAGE` to a version tag, local tag, or digest. The PostgreSQL runtime and migration services must reference the same interpolation so one invocation cannot select different application versions.

The distributed files contain no `build:` section. A developer who needs a source build explicitly builds and selects it:

```sh
docker build -t caplets:local .
CAPLETS_IMAGE=caplets:local docker compose up
```

The hardened descriptor defaults to an exact Caplets version tag. The checked-in default is synchronized with the CLI/image package version during the Changesets versioning workflow, and each published release asset names the image version from that release. `CAPLETS_IMAGE` remains a full-reference override so operators may select a digest.

## SQLite Convenience Deployment

`docker-compose.yml` is a complete SQLite deployment containing the Caplets runtime service and `caplets-data` volume. It has no required configuration variables. It pulls the published Caplets image when that image is not already present and starts with the image's normal initialization and HTTP-serving behavior.

The default bind remains `127.0.0.1:5387`. `CAPLETS_BIND_ADDRESS`, `CAPLETS_PORT`, `CAPLETS_SERVER_URL`, and existing runtime settings remain explicit overrides.

## PostgreSQL Convenience Deployment

`docker-compose.postgres.yml` is a complete deployment containing PostgreSQL, the one-shot migration service, the Caplets runtime, `caplets-postgres-data`, and `caplets-data`.

It is intended for fresh deployments. It uses one PostgreSQL login role named `caplets` for database ownership, schema migration, and runtime access. This role owns the configured database and schema and therefore retains DDL and migration-metadata privileges at runtime. That is an explicit usability trade-off, not the hardened security boundary.

The only required credential is:

```text
CAPLETS_POSTGRES_PASSWORD
```

The PostgreSQL image defaults to the moving PostgreSQL 17 Bookworm tag and permits a full-reference override:

```yaml
image: ${CAPLETS_POSTGRES_IMAGE:-postgres:17-bookworm}
```

`CAPLETS_POSTGRES_DATABASE` and `CAPLETS_POSTGRES_SCHEMA` remain optional and default to `caplets`. PostgreSQL is not published to a host port. Its health check uses `pg_isready`.

The migration service waits for PostgreSQL health, renders an ephemeral mode-`0600` Caplets configuration, and runs the existing public command:

```sh
node dist/index.js storage schema-migrate
```

The runtime service starts only after the migration service exits successfully. A failed migration leaves runtime stopped and the failed one-shot container available for log inspection.

## Hardened PostgreSQL Reference

`docker-compose.postgres-hardened.yml` is a standalone, hardened single-Docker-host reference. It does not claim high availability or cover every production concern.

### Exact Images

The descriptor defaults to exact Caplets and PostgreSQL image versions rather than moving tags. The initial PostgreSQL default is `postgres:17.6-bookworm`; later patch upgrades are deliberate reviewed changes. `CAPLETS_IMAGE` and `CAPLETS_POSTGRES_IMAGE` may override either full image reference, including with a digest.

The Caplets exact default is updated automatically as part of package versioning so a release asset defaults to the Caplets image published in the same release.

### Roles And Secrets

The hardened topology retains fixed roles:

- `caplets_admin` initializes and administers the dedicated database;
- `caplets_migrator` owns the application schema and applies migrations; and
- `caplets_runtime` receives only runtime data access.

It requires three host-side secret files, configurable by explicit path variables and defaulting to documented files under `./secrets/`:

- administrator password;
- migrator password; and
- runtime password.

Compose mounts these through top-level `secrets`. PostgreSQL receives its administrator credential through `POSTGRES_PASSWORD_FILE`. A no-network, one-shot preparation service copies each source into a role-scoped Docker volume as a mode-`0400` file owned by the non-root Caplets user; this avoids depending on host and container UID equality for bind-mounted Compose secrets. The preparation service runs as root with only the `CHOWN`, `DAC_OVERRIDE`, and `FOWNER` capabilities, then exits. Migration mounts all three prepared volumes read-only, while runtime mounts only its runtime credential. Database credentials must not appear in container environment values or command arguments.

The one-shot migration service connects as administrator to idempotently create or reconcile the migrator/runtime roles, schema, passwords, ownership, default privileges, and database grants. It reconnects as migrator to apply the schema and then finalizes runtime grants. Administrator and migrator credentials never enter the runtime container.

Editing an administrator secret file cannot rotate the PostgreSQL administrator password by itself because the old password is needed to authenticate. Documentation must provide the explicit protected rotation procedure. Migrator and runtime credentials are reconciled after successful administrator authentication.

### Network Boundary

The hardened topology uses two networks:

- an internal database network shared by PostgreSQL, migrator, and runtime; and
- a runtime network attached only to Caplets to preserve outbound API access and the loopback-bound HTTP port.

PostgreSQL and the migration container have no general outbound network path. PostgreSQL has no published host port. Caplets binds to `127.0.0.1:5387` by default. Remote exposure and TLS belong to an operator-managed reverse proxy or private network outside this descriptor.

### Container Restrictions

The Caplets runtime and migration containers run as the image's non-root user with:

- a read-only root filesystem;
- a bounded writable temporary filesystem;
- writable `/data` only for the runtime service;
- all Linux capabilities dropped; and
- `no-new-privileges` enabled.

PostgreSQL retains the official image's required initialization privilege transition and writable paths. Additional PostgreSQL restrictions may be included only when first initialization and restart are verified with a fresh named volume. PostgreSQL receives a 60-second shutdown grace period.

All hardened services use bounded local Docker logs, initially `max-size: 10m` and `max-file: 3`. Operators may replace the log driver. The reference does not set CPU or memory limits because safe values are workload- and host-specific.

### Operational Contract

Schema migrations are forward-only. Changing an exact image pin requires a verified database backup first; rolling back a container image does not roll back the schema.

Backups and tested restores are mandatory for a real deployment, but the descriptor does not include a local backup sidecar. Backup destination, encryption, retention, off-host durability, and restore testing remain operator responsibilities.

The descriptor explicitly documents that it is single-host. A Docker named volume is not cross-host storage or a high-availability database design.

## Packaged PostgreSQL Deployment Helpers

The Caplets runtime image contains private deployment helpers for:

- rendering PostgreSQL Caplets configuration from environment or file-backed credentials;
- idempotently provisioning the hardened role/schema boundary; and
- finalizing runtime grants after migrations.

These helpers are a private container interface for the supplied deployment recipes, not public CLI commands. They validate PostgreSQL schema identifiers, avoid interpolating untrusted values as SQL identifiers, write generated configuration only to temporary mode-`0600` files, and never log connection strings or credentials.

The convenience migration path uses the renderer and existing `storage schema-migrate` command but does not provision or finalize separate roles. The hardened migration path provisions roles, renders the migrator configuration, invokes the same schema-migration command, and finalizes runtime grants.

The current bind-mounted `deploy/postgres/init-caplets-roles.sh` flow becomes obsolete. No Compose service may mount deployment scripts from the checkout.

## Existing Deployment Compatibility

Service names, volume keys, database/schema defaults, and hardened role names remain stable. Existing users of the current two-file, three-role overlay move to `docker-compose.postgres-hardened.yml` under the same Compose project name and reuse their existing volumes.

Before that cutover, existing environment password values are copied into the three hardened secret files. The provisioning job reconciles the existing roles and grants. The administrator secret must match the credential already stored in PostgreSQL.

The one-role convenience file is not an in-place upgrade target for those volumes. Documentation must warn that selecting it under the same Compose project name as an existing three-role deployment is unsupported. There is no automatic role collapse, ownership transfer, or password conversion.

## Release Distribution

The repository copies are the source for all three deployment descriptors. When the `caplets` CLI package and Docker image are published, the release workflow uploads these assets to the corresponding `caplets@VERSION` GitHub Release:

- `docker-compose.yml`;
- `docker-compose.postgres.yml`; and
- `docker-compose.postgres-hardened.yml`.

The documented convenience URLs are:

```text
https://github.com/spiritledsoftware/caplets/releases/latest/download/docker-compose.yml
https://github.com/spiritledsoftware/caplets/releases/latest/download/docker-compose.postgres.yml
https://github.com/spiritledsoftware/caplets/releases/latest/download/docker-compose.postgres-hardened.yml
```

Release-asset upload occurs only after the matching Caplets image is successfully published. Raw files from `main` are development sources, not the official atomic distribution boundary.

## Documentation And Architecture Records

Operational documentation must:

- present the three descriptors as alternatives;
- provide checkout-free download, configuration, validation, startup, health, logs, upgrade, and shutdown commands;
- state the one-role convenience trade-off prominently;
- describe hardened secret-file creation and permissions without publishing example secrets;
- explain the existing three-role cutover path;
- document administrator password rotation limitations;
- require backups and restore testing before hardened upgrades;
- state the single-host, no-bundled-TLS, and no-HA boundaries; and
- replace all instructions that combine the two existing files or use `up --build`.

A new ADR records that the bundled convenience PostgreSQL descriptor deliberately uses one owner role for lower operational friction, while hardened and externally managed deployments retain the separate-role recommendation from ADR 0004. This deployment decision does not add a product-domain glossary term to `CONTEXT.md`.

## Acceptance Criteria

1. Each Compose file validates independently and does not reference another Compose file.
2. A temporary directory containing only downloaded `docker-compose.yml` can start a healthy SQLite Caplets service without a Docker build.
3. A temporary directory containing only downloaded `docker-compose.postgres.yml` and one password can initialize fresh volumes, complete migration, and start a healthy PostgreSQL-backed Caplets service.
4. The convenience PostgreSQL database contains one application login role, `caplets`, used by migration and runtime.
5. A temporary directory containing only the hardened descriptor and three secret files can initialize fresh volumes, complete provisioning/migration, and start a healthy PostgreSQL-backed Caplets service.
6. Hardened runtime credentials cannot create or alter schema objects, mutate migration metadata, authenticate as administrator/migrator, or read secret files belonging only to those roles.
7. Hardened runtime retains the required CRUD and sequence privileges for ordinary Caplets operations.
8. PostgreSQL and migration services in the hardened topology have no published ports or general outbound network route; Caplets retains outbound access and binds HTTP to loopback by default.
9. Hardened Caplets containers run non-root with read-only roots, dropped capabilities, `no-new-privileges`, and only their declared writable mounts.
10. Migration failure prevents runtime startup in both PostgreSQL descriptors.
11. Existing three-role volumes start successfully through the hardened descriptor when supplied with their existing credentials and Compose project name.
12. The convenience descriptor refuses no credentials implicitly: absent required passwords or secret files fail during Compose validation or service startup with a specific error.
13. Runtime and migration resolve the same Caplets image reference in each PostgreSQL descriptor.
14. No distributed descriptor contains a local build context or checkout bind mount.
15. The release workflow uploads all three descriptors to the matching `caplets@VERSION` GitHub Release after publishing the image.
16. The hardened release asset defaults to that release's exact Caplets image version and an exact PostgreSQL patch version.
17. Repository documentation contains no remaining supported command that combines `docker-compose.yml` with `docker-compose.postgres.yml` or requires `up --build` for deployment.
18. Focused Compose configuration checks and end-to-end container smoke tests cover SQLite, convenience PostgreSQL, hardened fresh initialization, migration gating, and existing three-role compatibility.
