# @caplets/core

`@caplets/core` is the Node runtime and typed administration substrate used by the `caplets`
CLI. It exposes the Caplets engine, MCP runtime, configuration parser, Code Mode API, source
composition, Writable Authority contract, and lifecycle helpers. The package is published with
its `README.md` and `dist` output; provider records are an implementation detail, not a public
persistence format.

## Runtime entry points

### Filesystem/local runtime

`CapletsRuntime` keeps the existing synchronous construction path for filesystem-only config:

```ts
import { CapletsRuntime } from "@caplets/core";

const runtime = new CapletsRuntime({
  configPath: "/etc/caplets/config.json",
  projectConfigPath: "/srv/caplets/.caplets/config.json",
});

await runtime.connect(transport);
// runtime.currentConfig(), runtime.registeredToolIds(), runtime.watchedPaths()
await runtime.close();
```

The constructor is intentionally not the shared-authority bootstrap. If the global config selects
SQLite, PostgreSQL, or S3, use an async host so provider connection, first-generation validation,
and immutable runtime activation happen before the runtime is exposed.

### Shared Writable Authority runtime

Use `createAsyncCapletsRuntime` for a complete runtime and `assembleCapletsHost` when an embedding
application wants the prepared host/coordinator without the MCP session wrapper:

```ts
import { createAsyncCapletsRuntime } from "@caplets/core";

const host = await createAsyncCapletsRuntime({
  configPath: "/etc/caplets/config.json",
  projectConfigPath: "/srv/caplets/.caplets/config.json",
  // `secretResolver` may resolve env:/vault: references without returning
  // credentials through public config or health output.
});

try {
  await host.runtime.connect(transport);
  const health = await host.health();
  // health.provider, health.activeGeneration, health.exposureGeneration,
  // health.connectivity, health.writable, health.refresh
} finally {
  await host.close();
}
```

`createAsyncCapletsRuntime` and `assembleCapletsHost` await the first valid complete Authority
Generation. Startup fails closed when a configured authority is unreachable, invalid, or has no
committed generation. After activation, the coordinator retains the last-known-good immutable
runtime view while a failed refresh reports degraded/read-only health.

`RuntimeEpochCoordinator` also exposes `refresh`, `refreshAtLeast`, `commit`, `health`, `retain`,
and `close`. A request/session should retain one `RuntimeEpochLease` and release it when finished;
retired views close only after their in-flight leases are released. Authority Generation and
Exposure Generation are separate: the former is the durable provider revision, while the latter
is the local activation counter for the runtime view.

## Authority contract and provider registration

The root export includes the provider-neutral types and helpers:

- `WritableAuthority` — `readHead`, `readGeneration`, semantic `commit`, auxiliary reads/writes,
  `health`, export/restore, optional maintenance fencing, and `close`.
- `AuthorityGeneration`, `AuthorityGenerationIdentity`, `AuthorityHead`, `AuthorityReceipt`, and
  `AuthorityCommitResult` — ordered generation/CAS/idempotency values.
- `AuthorityHealth` — orthogonal `connectivity`, `writable`, and `refresh` fields plus provider,
  authority ID, and active generation.
- The explicit provider-registration allowlist is `AuthorityProviderRegistryMissError`,
  `AuthorityProviderFactory`, `AuthorityProviderLookupResult`, `lookupAuthorityProvider`,
  `registerAuthorityProvider`, and `registeredAuthorityProviders`. Provider construction and
  resolved assembly context are not root exports.
- The composition layer (`composeRuntimeConfig`, `loadStagedFilesystemSource`, and
  `computeStagedFingerprint`) is internal to the root host assembly. It composes immutable staged
  inputs with one authority generation, preserves source provenance, and rejects staged/authority
  ID collisions.

`AuthorityProviderFactory` is the typed factory boundary used by `registerAuthorityProvider`.
Assembly supplies its internal normalized bootstrap and deployment-native resolved secrets;
callers do not select opaque authority IDs or namespaces. Resolved secret bytes do not belong in a
loaded bootstrap, config snapshot, generation, health object, diagnostics, or log.

Call `registerAuthorityProvider(kind, factory)` before host assembly when embedding or testing an
alternate factory for one of the four provider kinds. The function returns an unregister callback
for cleanup. A custom factory must preserve the same generation, CAS, idempotency, health,
maintenance-fence,
export/restore, and shutdown contract. Do not mix writable providers by domain.

Built-in providers use the same contract:

| Kind         | Runtime boundary                                                                         |
| ------------ | ---------------------------------------------------------------------------------------- |
| `filesystem` | Atomic local generation/head files and a persisted maintenance fence.                    |
| `sqlite`     | Drizzle SQLite schema with `better-sqlite3` and local WAL/transaction semantics.         |
| `postgresql` | Drizzle PostgreSQL schema with `postgres` transactions and a provider maintenance lease. |
| `s3`         | Immutable generation objects plus a conditional ETag-protected head object.              |

A Staged Filesystem Source is always read-only. It reserves its IDs against authority create,
install, update, and delete operations; the composition layer never silently shadows a staged
record with a dashboard record.

## Lazy provider and runtime requirements

Published core exports target Node.js `>=22` (the package also declares Bun for general Caplets
surfaces). Shared SQLite authority explicitly requires Node because it loads the native
`better-sqlite3` module. Install the package on the target OS/architecture so native dependencies
match the runtime.

Provider modules and drivers are externalized and loaded only after the selected provider is
known. A filesystem runtime does not open SQL or S3 clients. A selected provider still requires
its declared runtime dependency:

- `better-sqlite3` **12.11.1** for SQLite;
- `drizzle-orm` **0.45.2** for SQLite/PostgreSQL schema adapters;
- `postgres` **3.4.9** for PostgreSQL;
- `@aws-sdk/client-s3` **3.1085.0** for S3-compatible storage.

Do not deep-import internal provider modules from an application. Use the root exports and the
async host boundary. The package build keeps SQL dependencies out of the default CLI bundle until
SQLite or PostgreSQL is selected, and the S3 provider resolves request-time credentials through
the authority context.

## Configuration and source ownership

`loadStorageBootstrap` reads the global config's provider-shaped `storage` selection. `parseConfig`
and `loadConfigWithSources` remain available for ordinary filesystem configuration. Project config
cannot claim infrastructure-owned storage settings.

The four public forms are:

- `filesystem`: `{ "provider": "filesystem", "path"?: "…", "pollIntervalMs"?: 2500, "vaultKey"?: "env:…" }`;
- `sqlite`: `{ "provider": "sqlite", "path": "/var/lib/caplets/caplets.sqlite", "pollIntervalMs"?: 2500, "vaultKey"?: "env:…" }`;
- `postgresql`: `{ "provider": "postgresql", "connection": "env:CAPLETS_POSTGRES_URL", "pollIntervalMs"?: 2500, "vaultKey"?: "env:…" }`;
- `s3`: `{ "provider": "s3", "bucket": "caplets-state", "region": "us-east-1", "path"?: "production/caplets", "credentials"?: "env:CAPLETS_S3_CREDENTIALS", "endpoint"?: "…", "forcePathStyle"?: true, "pollIntervalMs"?: 2500, "vaultKey"?: "env:…" }`.

Filesystem `path` is optional and relative local paths resolve from the declaring global config.
SQLite requires a local persistent file and is not a multi-replica coordinator. Isolate each
PostgreSQL deployment with a dedicated database/connection and each S3 deployment with a distinct
bucket/root path. An omitted or empty S3 `path` uses `.caplets/`; omitting `credentials` uses
workload identity.

`connection`, `credentials`, and `vaultKey` are literal storage secret references, not inline
secrets or ordinary Caplet `$vault:` substitutions. The default runtime resolves `env:NAME` or a
bare environment-variable name; server-local storage commands additionally accept `vault:NAME`
and private `file:/…` references. `packages/core/src/config.ts` is authoritative. Configuration
schemas and references are generated outputs; run `pnpm schema:check` after changing that source.

## Lifecycle helpers

The root export includes typed, provider-neutral lifecycle operations:

- `inventoryAuthority` — inspect supported durable domains and redacted digests without sweeping
  arbitrary records;
- `migrateAuthority`, `runMigration`, and `createWritableAuthorityMigrationAdapter` — dry-run,
  fenced apply, destination verification, stable provenance conversion, and cutover coordinates;
- `createAuthorityBackup`, `readAuthorityBackupHeader`, `decodeAuthorityBackup`, and
  `restoreAuthorityBackup` — authenticated-header, encrypted-body backup/restore using an external
  key reference;
- `AuthorityInventory`, `MigrationResult`, `MigrationCutoverCoordinates`, `AuthorityBackup`,
  and related types for operator tooling.

Lifecycle operations are server-local. They require a stopped/read-only source, an empty and
unselected destination, an exclusive maintenance fence, source-digest revalidation, and normal-
adapter behavioral read-back. They do not hot-switch a running host or synchronize old and new
authorities.

## Contract boundary for embedders

Use the provider-neutral generation and Current Host operation seams rather than reading SQL rows,
object keys, filesystem generation directories, or dashboard internals. Preserve one Writable
Authority per Current Host, immutable staged input, expected-generation CAS, idempotency keys,
redacted errors, and explicit shutdown. Keep active MCP/Attach/Project Binding/Code Mode sessions
replica-local and use connection affinity when a deployment has more than one replica.
