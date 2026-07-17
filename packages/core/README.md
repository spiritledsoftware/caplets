# @caplets/core

Core runtime library for Caplets Code Mode, MCP/Attach serving, native integrations, and the SQLite/Postgres Current Host control plane.

## Install

```sh
pnpm add @caplets/core
```

Node 22 or newer and Bun 1 or newer are declared package engines. Native storage support is narrower; use the release-blocking matrix below.

## Primary entrypoints

- `@caplets/core` — `CapletsRuntime`, CLI construction, configuration parsing, serving, Code Mode, and Project Binding APIs
- `@caplets/core/native` — native integration service APIs
- `@caplets/core/control-plane/model` — canonical control-plane model
- `@caplets/core/control-plane/storage` — storage configuration, provider, key-manifest, and bootstrap contracts
- `@caplets/core/control-plane/runtime` — SQL/filesystem runtime snapshot composition
- `@caplets/core/control-plane/schema/sqlite` and `/postgres` — paired dialect schemas
- `@caplets/core/control-plane/dialect/sqlite`, `/postgres`, and `/migrations` — transactional dialect and checked migration contracts
- `@caplets/core/control-plane/caplets` — canonical and portable Caplet contracts

The package includes both checked migration trees in `dist/control-plane/migrations/`, the native `better-sqlite3` dependency, Postgres and S3 clients, and the supported Windows exclusion helper artifacts.

## Storage configuration

Storage is selected by the user/global config's `serve.storage`. Project `serve` configuration is ignored for security.

Omitting `serve.storage` selects owner-private, single-node SQLite under the platform state directory. Persist the complete `caplets/control-plane` directory, including the database, artifacts, key profiles, `authority.json`, and `storage-binding.json`.

Postgres requires an explicit `stateRoot`, `logicalHostId`, `expectedStoreId`, `processRole`, verified-TLS connection settings with distinct runtime/migrator/maintenance role credentials, an external `file-v1` key-provider manifest, a shared verified-HTTPS S3-compatible artifact provider, migration designation, and backup retention. A serving process must use `processRole: "online"`; one-shot operational roles are never admitted to ordinary serving.

See the repository's `docs/product/storage-backends.md` for the exact configuration shape, health semantics, authority boundaries, and recovery procedures.

## Runtime and platform matrix

`storage/package-matrix.json` in the repository is the source of truth for release-blocking tuples. Published storage support is:

- Node 22 and Node 24 on glibc Linux x64/arm64
- Node 22 and Node 24 on macOS x64/arm64
- Node 22 and Node 24 on Windows x64
- Bun on glibc Linux x64
- Bun on macOS arm64
- the Node 24 Bookworm container on x64/arm64

Unsupported tuples fail with actionable guidance rather than attempting an unverified native load:

- musl/Alpine Linux, both x64 and arm64
- Windows arm64
- Bun on Windows
- every 32-bit target

Use a supported Node 22/24 glibc Linux, macOS, or Windows x64 deployment, or Bun on Linux x64/macOS arm64. For containers, use the declared Node 24 Bookworm image instead of Alpine.

## Storage release checks

From a repository checkout, using pnpm:

```sh
pnpm storage:package:check
pnpm storage:platform:check
pnpm storage:windows-helper:publish-check
```

`pnpm storage:package:check` packs `@caplets/core` and checks drivers, migrations, artifacts, and supported runtime tuples. `pnpm storage:platform:check` exercises platform exclusion behavior. The publish check rejects a missing, unsigned, wrong-publisher, or checksum-mismatched Windows helper.

## Administration boundary

MCP, Attach, Code Mode, and native integrations are runtime surfaces, not control-plane administration APIs. Access Clients may use MCP, Attach, and Project Binding. Operator Clients may additionally use authorized Current Host administration. Protected backup/restore, catastrophic recovery, key rotation, and rolling bootstrap activation remain trusted local orchestration capabilities and are not package-level agent tools.

The executable CLI is published separately as `caplets`. The exact shipped one-shot legacy migration command is:

```sh
caplets storage migrate --global --offline
```

Stop every legacy replica before running it. Both flags are required.
