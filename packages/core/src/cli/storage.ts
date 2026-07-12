import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import type BetterSqlite3 from "better-sqlite3";
import type postgres from "postgres";

import {
  loadAuthorityBootstrap,
  resolveConfigPath,
  resolveProjectConfigPath,
  vaultStoreForAuthDir,
  type AuthorityBootstrap,
  type AuthoritySecretResolver,
  type ResolvedAuthoritySecrets,
} from "../config";
import { CapletsError, toSafeError } from "../errors";
import {
  createAuthority as createRegisteredAuthority,
  type AuthorityProviderContext,
  type AuthorityProviderFactory,
} from "../storage/factory";
import type { MigrationResult as SchemaMigrationResult } from "../storage/sql/migrate";
import {
  createAuthorityBackup,
  readAuthorityBackupHeader,
  restoreAuthorityBackup,
  type BackupKeyMaterial,
} from "../storage/backup";
import {
  inventoryAuthority,
  migrateAuthority,
  type AuthorityInventory,
} from "../storage/migration";
import type { WritableAuthority } from "../storage/types";

type OutputFormat = "plain" | "markdown" | "json";
type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

type StorageCommandOptions = {
  config?: string;
  sourceConfig?: string;
  destinationConfig?: string;
  targetConfig?: string;
  profile?: string;
  sourceProfile?: string;
  destinationProfile?: string;
  targetProfile?: string;
  format?: OutputFormat;
  json?: boolean;
  knownDomain?: string[];
  dryRun?: boolean;
  apply?: boolean;
  targetNamespace?: string;
  schemaVersion?: number;
  output?: string;
  input?: string;
  force?: boolean;
  keyFile?: string;
  keyEnv?: string;
  keyVault?: string;
  keyRef?: string;
};

type AuthoritySelector = {
  configPath: string;
  bootstrap: AuthorityBootstrap;
  secrets: ResolvedAuthoritySecrets;
};

type ResolvedBackupKey = {
  material: BackupKeyMaterial;
  provenance: "file" | "env" | "vault";
};

type PostgresFactory = typeof postgres;
type BetterSqlite3Constructor = new (
  filename: string,
  options?: { readonly?: boolean; fileMustExist?: boolean; timeout?: number },
) => BetterSqlite3.Database;

export type StorageCliIO = {
  writeOut: (value: string) => void;
  writeErr?: (value: string) => void;
  setExitCode?: (code: number) => void;
  env?: Environment;
  authDir?: string;
  configPath?: string;
  projectConfigPath?: string;
  signal?: AbortSignal;
  /** Test and embedding seam; production uses the registered provider factory. */
  authorityFactory?: AuthorityProviderFactory;
};
export type StorageAuthoritySelector = AuthoritySelector;

export type StorageAuthorityHandle = StorageAuthoritySelector & {
  authority: WritableAuthority;
  close(): Promise<void>;
};

export function resolveStorageAuthoritySelector(io: StorageCliIO): StorageAuthoritySelector {
  return resolveConfigSelector({}, io, "authority");
}

export async function openStorageAuthority(
  io: StorageCliIO,
  selector = resolveStorageAuthoritySelector(io),
): Promise<StorageAuthorityHandle> {
  const authority = await openAuthority(selector, io);
  return {
    ...selector,
    authority,
    close: async () => await authority.close(),
  };
}

// Native better-sqlite3 and postgres packages expose CommonJS entry points.
const require = createRequire(import.meta.url);
const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

export function registerStorageCommands(program: Command, io: StorageCliIO): Command {
  const storage = program
    .command("storage")
    .description(
      "Manage server-local authority inventory, migration, backup, restore, and schema.",
    );

  const inventory = storage
    .command("inventory")
    .description("Inventory typed authority records without exporting secrets or source paths.");
  addConfigSelectorOptions(inventory);
  addOutputOptions(inventory).option(
    "--known-domain <domain>",
    "additional typed authority domain",
    collectValues,
    [],
  );
  inventory.action(async (options: StorageCommandOptions) => {
    await runStorageAction(io, outputFormat(options), async () => {
      const selector = resolveConfigSelector(options, io, "authority");
      return await withAuthorities(io, [selector], async ([source]) => ({
        kind: "inventory",
        inventory: await inventoryAuthority(
          source!.authority,
          options.knownDomain === undefined ? {} : { knownDomains: options.knownDomain },
        ),
      }));
    });
  });

  const migrate = storage
    .command("migrate")
    .description("Migrate one server-local authority to an empty authority with explicit intent.");
  addMigrationOptions(migrate);
  migrate.action(async (options: StorageCommandOptions) => {
    await runStorageAction(io, outputFormat(options), async () => {
      return await executeMigration(io, options);
    });
  });

  const migrationGroup = storage
    .command("migration")
    .description("Run migration with an explicit dry-run or apply subcommand.");
  const migrationDryRun = migrationGroup
    .command("dry-run")
    .description("Preview migration without publishing a destination generation.");
  addMigrationSelectorOptions(migrationDryRun);
  addOutputOptions(migrationDryRun);
  migrationDryRun.action(async (options: StorageCommandOptions) => {
    await runStorageAction(io, outputFormat(options), async () => {
      return await executeMigration(io, options, "dry-run");
    });
  });
  const migrationApply = migrationGroup
    .command("apply")
    .description("Apply a previously reviewed migration plan exactly once.");
  addMigrationSelectorOptions(migrationApply);
  addOutputOptions(migrationApply);
  migrationApply.action(async (options: StorageCommandOptions) => {
    await runStorageAction(io, outputFormat(options), async () => {
      return await executeMigration(io, options, "apply");
    });
  });

  const backup = storage
    .command("backup")
    .description("Create, inspect, and restore encrypted authority backups.");
  const backupCreate = backup
    .command("create")
    .description("Create an authenticated encrypted authority backup.");
  addConfigSelectorOptions(backupCreate);
  addKeyOptions(backupCreate);
  addOutputOptions(backupCreate);
  backupCreate
    .argument("[output]", "backup output path; prefer --output for scripts")
    .option("--output <path>", "backup output path")
    .option("--force", "replace an existing backup output");
  backupCreate.action(async (output: string | undefined, options: StorageCommandOptions) => {
    await runStorageAction(io, outputFormat(options), async () => {
      const selector = resolveConfigSelector(options, io, "authority");
      const outputPath = requirePath(options.output ?? output, "backup output");
      const key = await resolveBackupKey(options, io);
      return await withAuthorities(io, [selector], async ([source]) => {
        const backupResult = await createAuthorityBackup(source!.authority, { key: key.material });
        await writePrivateBytes(outputPath, backupResult.bytes, Boolean(options.force));
        return {
          kind: "backup-created",
          path: outputPath,
          bytes: backupResult.bytes.byteLength,
          header: backupResult.header,
          key: {
            provenance: key.provenance,
            keyFingerprint: backupResult.header.keyFingerprint,
          },
        };
      });
    });
  });

  const backupInspect = backup
    .command("inspect-header")
    .description("Inspect a backup's authenticated, non-secret header.");
  addOutputOptions(backupInspect);
  backupInspect
    .argument("[input]", "backup input path; prefer --input for scripts")
    .option("--input <path>", "backup input path");
  backupInspect.action(async (input: string | undefined, options: StorageCommandOptions) => {
    await runStorageAction(io, outputFormat(options), async () => {
      const inputPath = requirePath(options.input ?? input, "backup input");
      const bytes = await readBackupBytes(inputPath);
      return { kind: "backup-header", header: readAuthorityBackupHeader(bytes) };
    });
  });

  const backupRestore = backup
    .command("restore")
    .description("Restore an encrypted backup to an empty authority.");
  addConfigSelectorOptions(backupRestore, { destination: true });
  addKeyOptions(backupRestore);
  addOutputOptions(backupRestore);
  backupRestore
    .argument("[input]", "backup input path; prefer --input for scripts")
    .option("--input <path>", "backup input path")
    .option(
      "--schema-version <version>",
      "expected destination schema version",
      parsePositiveInteger,
    );
  backupRestore.action(async (input: string | undefined, options: StorageCommandOptions) => {
    await runStorageAction(io, outputFormat(options), async () => {
      const selector = resolveConfigSelector(options, io, "destination");
      const inputPath = requirePath(options.input ?? input, "backup input");
      const bytes = await readBackupBytes(inputPath);
      const header = readAuthorityBackupHeader(bytes);
      const key = await resolveBackupKey(options, io);
      return await withAuthorities(io, [selector], async ([target]) => {
        const restored = await restoreAuthorityBackup(target!.authority, bytes, {
          key: key.material,
          ...(options.schemaVersion === undefined
            ? {}
            : { expectedSchemaVersion: options.schemaVersion }),
        });
        return {
          kind: "backup-restored",
          generation: restored.generation,
          auxiliaryWatermark: restored.auxiliaryWatermark,
          key: { provenance: key.provenance, keyFingerprint: header.keyFingerprint },
        };
      });
    });
  });

  const provider = storage
    .command("provider")
    .description("Inspect and migrate provider-native schemas.");
  const providerSchema = provider
    .command("schema")
    .description("Manage a supported provider schema.");
  addSchemaCommands(providerSchema, io);

  // Keep a short spelling for operators and scripts.
  const schema = storage.command("schema").description("Manage a supported provider schema.");
  addSchemaCommands(schema, io);

  return storage;
}

function addSchemaCommands(parent: Command, io: StorageCliIO): void {
  const status = parent
    .command("status")
    .description("Verify provider schema history and logical version.");
  addConfigSelectorOptions(status);
  addOutputOptions(status);
  status.action(async (options: StorageCommandOptions) => {
    await runStorageAction(io, outputFormat(options), async () => {
      const selector = resolveConfigSelector(options, io, "authority");
      return await runSchemaLifecycle(selector, "status");
    });
  });

  const migrate = parent
    .command("migrate")
    .description("Apply pending provider schema migrations.");
  addConfigSelectorOptions(migrate);
  addOutputOptions(migrate);
  migrate.action(async (options: StorageCommandOptions) => {
    await runStorageAction(io, outputFormat(options), async () => {
      const selector = resolveConfigSelector(options, io, "authority");
      return await runSchemaLifecycle(selector, "migrate");
    });
  });
}

function addConfigSelectorOptions(command: Command, options: { destination?: boolean } = {}): void {
  command
    .option(
      "--config <path>",
      options.destination ? "destination authority config path" : "authority config path",
    )
    .option(
      options.destination ? "--destination-config <path>" : "--source-config <path>",
      options.destination ? "destination authority config path" : "source authority config path",
    )
    .option("--profile <ref>", "provider profile reference (never a credential value)")
    .option(
      options.destination ? "--target-profile <ref>" : "--source-profile <ref>",
      options.destination
        ? "destination provider profile reference"
        : "source provider profile reference",
    );
}

function addMigrationSelectorOptions(command: Command): void {
  command
    .option("--source-config <path>", "source authority config path")
    .option("--destination-config <path>", "destination authority config path")
    .option("--target-config <path>", "destination authority config path")
    .option("--source-profile <ref>", "source provider profile reference")
    .option("--destination-profile <ref>", "destination provider profile reference")
    .option("--target-profile <ref>", "destination provider profile reference")
    .option("--target-namespace <namespace>", "destination authority namespace")
    .option("--schema-version <version>", "target schema version", parsePositiveInteger)
    .option("--known-domain <domain>", "additional typed authority domain", collectValues, []);
}

function addMigrationOptions(command: Command): void {
  addMigrationSelectorOptions(command);
  command
    .option("--dry-run", "preview inventory and destination checks without publishing")
    .option("--apply", "publish the verified destination generation")
    .option("--format <format>", "output format: plain, markdown, md, or json", parseOutputFormat)
    .option("--json", "print JSON output");
}

function addKeyOptions(command: Command): void {
  command
    .option("--key-file <path>", "read the external encryption key from a private file")
    .option("--key-env <name>", "read the external encryption key from an environment variable")
    .option("--key-vault <name>", "read the external encryption key from a local Vault value")
    .option("--key-ref <ref>", "external key reference: file:<path>, env:<name>, or vault:<name>");
}

function addOutputOptions(command: Command): Command {
  return command
    .option("--json", "print JSON output")
    .option("--format <format>", "output format: plain, markdown, md, or json", parseOutputFormat);
}

async function executeMigration(
  io: StorageCliIO,
  options: StorageCommandOptions,
  forcedMode?: "dry-run" | "apply",
): Promise<Record<string, unknown>> {
  const explicitDryRun = Boolean(options.dryRun);
  const explicitApply = Boolean(options.apply);
  if (forcedMode === "dry-run" && explicitApply) {
    throw new CapletsError("REQUEST_INVALID", "migration dry-run cannot be combined with --apply");
  }
  if (forcedMode === "apply" && explicitDryRun) {
    throw new CapletsError("REQUEST_INVALID", "migration apply cannot be combined with --dry-run");
  }
  if (!forcedMode && explicitDryRun === explicitApply) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "migration requires exactly one explicit intent: --dry-run or --apply",
    );
  }
  const mode = forcedMode ?? (explicitDryRun ? "dry-run" : "apply");
  const source = resolveMigrationSelector(options, io, "source");
  const destination = resolveMigrationSelector(options, io, "destination");
  if (source.configPath === destination.configPath) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "migration source and destination must be different config paths or profiles",
    );
  }
  return await withAuthorities(
    io,
    [source, destination],
    async ([sourceHandle, destinationHandle]) => {
      const result = await migrateAuthority({
        source: sourceHandle!.authority,
        target: destinationHandle!.authority,
        dryRun: mode === "dry-run",
        ...(options.targetNamespace === undefined
          ? {}
          : { targetNamespace: options.targetNamespace }),
        ...(options.schemaVersion === undefined
          ? {}
          : { targetSchemaVersion: options.schemaVersion }),
        ...(options.knownDomain === undefined ? {} : { knownDomains: options.knownDomain }),
      });
      if (result.kind === "dry-run") {
        return {
          kind: "migration-dry-run",
          inventory: result.inventory,
          target: result.target,
          sourceDigest: result.sourceDigest,
        };
      }
      return { kind: "migration-applied", cutover: result.cutover };
    },
  );
}

async function runSchemaLifecycle(
  selector: AuthoritySelector,
  operation: "status" | "migrate",
): Promise<Record<string, unknown>> {
  const { bootstrap, secrets } = selector;
  if (bootstrap.provider === "sqlite") {
    const result =
      operation === "migrate"
        ? await (async () => {
            // Keep SQL dependencies out of the default CLI bundle until SQLite is selected.
            const { migrateSqliteDatabase } = await import("../storage/sql/migrate");
            return await migrateSqliteDatabase({
              databasePath: bootstrap.databasePath,
              authorityId: bootstrap.authorityId,
              namespace: bootstrap.namespace,
            });
          })()
        : await verifySqliteSchemaReadonly(
            bootstrap.databasePath,
            bootstrap.authorityId,
            bootstrap.namespace,
          );
    return schemaResult(bootstrap, operation, result);
  }
  if (bootstrap.provider === "postgresql") {
    const credential = secrets.credential;
    if (typeof credential !== "string" || credential.length === 0) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "PostgreSQL schema lifecycle requires a resolved connection credential",
      );
    }
    const result =
      operation === "migrate"
        ? await (async () => {
            // Keep SQL dependencies out of the default CLI bundle until PostgreSQL is selected.
            const { migratePostgresDatabase } = await import("../storage/sql/migrate");
            return await migratePostgresDatabase({
              connectionString: credential,
              authorityId: bootstrap.authorityId,
              namespace: bootstrap.namespace,
            });
          })()
        : await verifyPostgresSchemaReadonly(
            credential,
            bootstrap.authorityId,
            bootstrap.namespace,
          );
    return schemaResult(bootstrap, operation, result);
  }
  throw new CapletsError(
    "UNSUPPORTED_OPERATION",
    `Provider ${bootstrap.provider} does not expose a supported SQL schema lifecycle`,
  );
}

function schemaResult(
  bootstrap: AuthorityBootstrap,
  operation: "status" | "migrate",
  result: SchemaMigrationResult,
): Record<string, unknown> {
  return {
    kind: operation === "status" ? "schema-status" : "schema-migrated",
    provider: bootstrap.provider,
    authorityId: bootstrap.authorityId,
    namespace: bootstrap.namespace,
    applied: result.applied,
    logicalSchemaVersion: result.logicalSchemaVersion,
  };
}

async function verifySqliteSchemaReadonly(
  databasePath: string,
  authorityId: string,
  namespace: string,
): Promise<SchemaMigrationResult> {
  assertLocalSqlitePath(databasePath);
  const resolvedPath = resolve(databasePath);
  if (!existsSync(resolvedPath)) {
    throw new CapletsError("CONFIG_NOT_FOUND", "SQLite authority database was not found");
  }
  const BetterSqlite3 = loadBetterSqlite3();
  let db: BetterSqlite3.Database | undefined;
  try {
    db = new BetterSqlite3(resolvedPath, { readonly: true, fileMustExist: true });
    // Keep SQL dependencies out of the default CLI bundle until SQLite is selected.
    const { verifySqliteSchema } = await import("../storage/sql/migrate");
    return verifySqliteSchema(db, { authorityId, namespace });
  } catch (error) {
    if (error instanceof CapletsError) throw error;
    throw new CapletsError("CONFIG_INVALID", "SQLite schema status failed");
  } finally {
    db?.close();
  }
}

async function verifyPostgresSchemaReadonly(
  connectionString: string,
  authorityId: string,
  namespace: string,
): Promise<SchemaMigrationResult> {
  const client = loadPostgres()(connectionString, { max: 1, prepare: false });
  try {
    // Keep SQL dependencies out of the default CLI bundle until PostgreSQL is selected.
    const { verifyPostgresSchema } = await import("../storage/sql/migrate");
    return await verifyPostgresSchema(client, { authorityId, namespace });
  } finally {
    await client.end({ timeout: 2_000 });
  }
}

function resolveMigrationSelector(
  options: StorageCommandOptions,
  io: StorageCliIO,
  role: "source" | "destination",
): AuthoritySelector {
  const config =
    role === "source" ? options.sourceConfig : (options.destinationConfig ?? options.targetConfig);
  const profile =
    role === "source"
      ? options.sourceProfile
      : (options.destinationProfile ?? options.targetProfile);
  if (config === undefined && profile === undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `${role} migration authority requires an explicit config path or profile reference`,
    );
  }
  return resolveConfigSelector(
    {
      ...(config === undefined ? {} : { config }),
      ...(profile === undefined ? {} : { profile }),
    },
    io,
    role,
  );
}

function resolveConfigSelector(
  options: Pick<
    StorageCommandOptions,
    | "config"
    | "sourceConfig"
    | "destinationConfig"
    | "targetConfig"
    | "profile"
    | "sourceProfile"
    | "destinationProfile"
    | "targetProfile"
  >,
  io: StorageCliIO,
  role: "authority" | "source" | "destination",
): AuthoritySelector {
  const config =
    role === "source"
      ? (options.sourceConfig ?? options.config)
      : role === "destination"
        ? (options.destinationConfig ?? options.targetConfig ?? options.config)
        : (options.sourceConfig ?? options.config);
  const profile =
    role === "source"
      ? (options.sourceProfile ?? options.profile)
      : role === "destination"
        ? (options.destinationProfile ?? options.targetProfile ?? options.profile)
        : (options.sourceProfile ?? options.profile);
  if (config !== undefined && profile !== undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `${role} authority accepts either a config path or profile reference, not both`,
    );
  }
  const env = io.env ?? process.env;
  const selected =
    config ??
    (profile === undefined
      ? (io.configPath ?? resolveConfigPath(env.CAPLETS_CONFIG))
      : resolveProfileReference(profile, env));
  const configPath = resolve(selected);
  if (!existsSync(configPath))
    throw new CapletsError("CONFIG_NOT_FOUND", `${role} authority config was not found`);
  const loaded = loadAuthorityBootstrap(configPath, env, authoritySecretResolver(io), {
    projectPath: io.projectConfigPath ?? resolveProjectConfigPath(),
  });
  return { configPath, bootstrap: loaded.bootstrap, secrets: loaded.secrets };
}

function resolveProfileReference(profile: string, env: Environment): string {
  const trimmed = profile.trim();
  if (trimmed.length === 0)
    throw new CapletsError("REQUEST_INVALID", "provider profile reference cannot be empty");
  const envName = trimmed.startsWith("env:")
    ? trimmed.slice(4)
    : `CAPLETS_AUTHORITY_PROFILE_${trimmed.replace(/[^A-Za-z0-9_]/gu, "_").toUpperCase()}`;
  const resolved = env[envName];
  if (typeof resolved === "string" && resolved.trim().length > 0) return resolved;
  if (existsSync(trimmed)) return trimmed;
  throw new CapletsError(
    "CONFIG_INVALID",
    `provider profile reference ${trimmed} did not resolve to a config path`,
  );
}

async function withAuthorities<T>(
  io: StorageCliIO,
  selectors: AuthoritySelector[],
  action: (handles: { authority: WritableAuthority; selector: AuthoritySelector }[]) => Promise<T>,
): Promise<T> {
  const handles: { authority: WritableAuthority; selector: AuthoritySelector }[] = [];
  let closePromise: Promise<void> | undefined;
  const close = async () => {
    if (closePromise === undefined) {
      closePromise = Promise.allSettled(handles.map((handle) => handle.authority.close())).then(
        () => undefined,
      );
    }
    await closePromise;
  };
  const onAbort = () => {
    void close();
  };
  io.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    ensureNotAborted(io.signal);
    for (const selector of selectors) {
      const authority = await openAuthority(selector, io);
      handles.push({ authority, selector });
      ensureNotAborted(io.signal);
    }
    const result = await action(handles);
    ensureNotAborted(io.signal);
    return result;
  } finally {
    io.signal?.removeEventListener("abort", onAbort);
    await close();
  }
}

async function openAuthority(
  selector: AuthoritySelector,
  io: StorageCliIO,
): Promise<WritableAuthority> {
  const context: AuthorityProviderContext = {
    bootstrap: selector.bootstrap,
    secrets: selector.secrets,
  };
  if (io.authorityFactory !== undefined) return await io.authorityFactory(context);
  try {
    return await createRegisteredAuthority(context);
  } catch (error) {
    if (!(error instanceof CapletsError) || !error.message.includes("is not registered"))
      throw error;
    return await createBuiltinAuthority(selector.bootstrap, selector.secrets, selector.configPath);
  }
}

async function createBuiltinAuthority(
  bootstrap: AuthorityBootstrap,
  secrets: ResolvedAuthoritySecrets,
  configPath: string,
): Promise<WritableAuthority> {
  if (bootstrap.provider === "filesystem") {
    // Provider modules must load only after the configured provider is selected.
    const { createFilesystemAuthority } = await import("../storage/filesystem-authority");
    return await createFilesystemAuthority({
      root: resolve(dirname(configPath), "caplets"),
      authorityId: bootstrap.authorityId,
      namespace: bootstrap.namespace,
    });
  }
  if (bootstrap.provider === "sqlite") {
    // Provider modules must load only after the configured provider is selected.
    const { createSqliteAuthority } = await import("../storage/sql/authority");
    return await createSqliteAuthority({
      databasePath: bootstrap.databasePath,
      authorityId: bootstrap.authorityId,
      namespace: bootstrap.namespace,
    });
  }
  if (bootstrap.provider === "postgresql") {
    if (typeof secrets.credential !== "string") {
      throw new CapletsError(
        "CONFIG_INVALID",
        "PostgreSQL authority requires a resolved connection credential",
      );
    }
    // Provider modules must load only after the configured provider is selected.
    const { createPostgresAuthority } = await import("../storage/sql/authority");
    return await createPostgresAuthority({
      connectionString: secrets.credential,
      authorityId: bootstrap.authorityId,
      namespace: bootstrap.namespace,
    });
  }
  const credential = secrets.credential;
  // Provider modules must load only after the configured provider is selected.
  const { createS3Authority } = await import("../storage/s3-authority");
  return await createS3Authority({
    bucket: bootstrap.bucket,
    region: bootstrap.region,
    ...(bootstrap.endpoint === undefined ? {} : { endpoint: bootstrap.endpoint }),
    ...(bootstrap.forcePathStyle === undefined ? {} : { forcePathStyle: bootstrap.forcePathStyle }),
    ...(credential === undefined
      ? {}
      : { credentialProvider: () => parseS3Credential(credential) }),
    authorityId: bootstrap.authorityId,
    namespace: bootstrap.namespace,
  });
}

function authoritySecretResolver(io: StorageCliIO): AuthoritySecretResolver {
  const env = io.env ?? process.env;
  const vault = vaultStoreForAuthDir(io.authDir);
  return (reference: string) => {
    if (reference.startsWith("env:")) return env[reference.slice(4)];
    if (reference.startsWith("vault:")) return vault.resolveValue(reference.slice(6));
    if (reference.startsWith("file:")) return readPrivateReference(reference.slice(5));
    return env[reference];
  };
}

function readPrivateReference(path: string): string {
  const resolved = resolve(path);
  assertPrivateFile(resolved, "secret reference");
  return readFileSync(resolved, "utf8");
}

async function resolveBackupKey(
  options: StorageCommandOptions,
  io: StorageCliIO,
): Promise<ResolvedBackupKey> {
  const refs = [options.keyFile, options.keyEnv, options.keyVault, options.keyRef].filter(
    (value): value is string => value !== undefined,
  );
  if (refs.length !== 1) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "exactly one external key reference is required: --key-file, --key-env, --key-vault, or --key-ref",
    );
  }
  if (options.keyFile !== undefined) {
    return { material: await readKeyFile(options.keyFile), provenance: "file" };
  }
  if (options.keyEnv !== undefined) {
    const value = (io.env ?? process.env)[options.keyEnv];
    if (typeof value !== "string" || value.length === 0) {
      throw new CapletsError("AUTH_FAILED", "encryption key environment reference is missing");
    }
    return { material: Buffer.from(value, "utf8"), provenance: "env" };
  }
  if (options.keyVault !== undefined) {
    const value = vaultStoreForAuthDir(io.authDir).resolveValue(options.keyVault);
    if (value.length === 0)
      throw new CapletsError("AUTH_FAILED", "encryption key Vault value is empty");
    return { material: Buffer.from(value, "utf8"), provenance: "vault" };
  }
  const keyRef = options.keyRef!;
  const separator = keyRef.indexOf(":");
  const kind = separator > 0 ? keyRef.slice(0, separator) : "";
  const value = separator > 0 ? keyRef.slice(separator + 1) : "";
  if (kind === "file") return { material: await readKeyFile(value), provenance: "file" };
  if (kind === "env") {
    const envValue = (io.env ?? process.env)[value];
    if (typeof envValue !== "string" || envValue.length === 0) {
      throw new CapletsError("AUTH_FAILED", "encryption key environment reference is missing");
    }
    return { material: Buffer.from(envValue, "utf8"), provenance: "env" };
  }
  if (kind === "vault") {
    const vaultValue = vaultStoreForAuthDir(io.authDir).resolveValue(value);
    if (vaultValue.length === 0)
      throw new CapletsError("AUTH_FAILED", "encryption key Vault value is empty");
    return { material: Buffer.from(vaultValue, "utf8"), provenance: "vault" };
  }
  throw new CapletsError("REQUEST_INVALID", "--key-ref must use file:, env:, or vault: provenance");
}

async function readKeyFile(path: string): Promise<Buffer> {
  const resolved = resolve(path);
  assertPrivateFile(resolved, "encryption key file");
  const value = await readFile(resolved);
  if (value.byteLength === 0) throw new CapletsError("AUTH_FAILED", "encryption key file is empty");
  return value;
}

async function readBackupBytes(path: string): Promise<Uint8Array> {
  const resolved = resolve(path);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new CapletsError("CONFIG_NOT_FOUND", "backup input was not found");
  }
  if (!info.isFile())
    throw new CapletsError("CONFIG_INVALID", "backup input must be a regular file");
  if (info.size > MAX_BACKUP_BYTES + 16 * 1024) {
    throw new CapletsError("CONFIG_INVALID", "backup input exceeds the 64 MiB limit");
  }
  return await readFile(resolved);
}

async function writePrivateBytes(path: string, bytes: Uint8Array, force: boolean): Promise<void> {
  const resolved = resolve(path);
  if (existsSync(resolved) && !force) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      "backup output already exists; use --force to replace it",
    );
  }
  await mkdir(dirname(resolved), { recursive: true, mode: 0o700 });
  try {
    await chmod(dirname(resolved), 0o700);
  } catch {
    // Best effort on platforms without POSIX permissions.
  }
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    try {
      await chmod(temporary, 0o600);
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
    await rename(temporary, resolved);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function runStorageAction<T extends Record<string, unknown>>(
  io: StorageCliIO,
  format: OutputFormat,
  action: () => Promise<T>,
): Promise<void> {
  try {
    io.writeOut(renderStorageResult(await action(), format));
  } catch (error) {
    if (format === "json") {
      io.writeOut(`${JSON.stringify({ error: toSafeError(error) }, null, 2)}\n`);
      io.setExitCode?.(1);
      return;
    }
    throw error;
  }
}

function renderStorageResult(result: Record<string, unknown>, format: OutputFormat): string {
  if (format === "json") return `${JSON.stringify(result, null, 2)}\n`;
  if (format === "markdown") {
    return `## Caplets storage\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`;
  }
  return `${humanizeStorageResult(result)}\n`;
}

function humanizeStorageResult(result: Record<string, unknown>): string {
  const kind = typeof result.kind === "string" ? result.kind : "storage-result";
  if (kind === "inventory") {
    const inventory = result.inventory as AuthorityInventory;
    return [
      "Authority inventory",
      "",
      `Authority: ${inventory.identity.authorityId}`,
      `Provider: ${inventory.identity.provider}`,
      `Namespace: ${inventory.identity.namespace}`,
      `Schema version: ${inventory.schemaVersion}`,
      `Head: ${inventory.head.id} (${inventory.head.sequence})`,
      `Generation: ${inventory.generation.id}`,
      `Source digest: ${inventory.sourceDigest}`,
      "Domains:",
      ...inventory.domains.map(
        (domain) =>
          `  ${domain.name}: ${domain.count} (schema ${domain.schemaVersion}, ${domain.redactedDigest})`,
      ),
      "Exclusions:",
      ...inventory.exclusions.map((entry) => `  ${entry.kind}: ${entry.reason}`),
    ].join("\n");
  }
  if (kind === "migration-dry-run") {
    const target = result.target as Record<string, unknown>;
    return [
      "Migration dry-run",
      "",
      `Target: ${target.authorityId} (${target.provider}/${target.namespace})`,
      `Source digest: ${result.sourceDigest}`,
    ].join("\n");
  }
  if (kind === "migration-applied") {
    const cutover = result.cutover as Record<string, unknown>;
    return [
      "Migration applied",
      "",
      `Cutover authority: ${cutover.authorityId}`,
      `Generation: ${cutover.generationId}`,
      `Sequence: ${cutover.sequence}`,
      `Digest: ${cutover.digest}`,
    ].join("\n");
  }
  if (kind === "backup-created") {
    const key = result.key as Record<string, unknown>;
    return [
      "Backup created",
      "",
      `Output: ${result.path}`,
      `Bytes: ${result.bytes}`,
      `Key fingerprint: ${key.keyFingerprint}`,
    ].join("\n");
  }
  if (kind === "backup-header") {
    return [
      "Backup header",
      "",
      ...formatObjectLines(result.header as Record<string, unknown>),
    ].join("\n");
  }
  if (kind === "backup-restored") {
    const generation = result.generation as Record<string, unknown>;
    return [
      "Backup restored",
      "",
      `Generation: ${generation.id}`,
      `Auxiliary watermark: ${result.auxiliaryWatermark}`,
    ].join("\n");
  }
  if (kind === "schema-status" || kind === "schema-migrated") {
    return [
      kind === "schema-status" ? "Schema status" : "Schema migrated",
      "",
      ...formatObjectLines(result),
    ].join("\n");
  }
  return formatObjectLines(result).join("\n");
}

function formatObjectLines(value: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, nested]) => {
    if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
      return [
        `${prefix}${key}:`,
        ...formatObjectLines(nested as Record<string, unknown>, `${prefix}  `),
      ];
    }
    return [`${prefix}${key}: ${String(nested)}`];
  });
}

function outputFormat(options: StorageCommandOptions): OutputFormat {
  return options.json === true || options.format === "json" ? "json" : (options.format ?? "plain");
}

function parseOutputFormat(value: string): OutputFormat {
  if (value === "plain") return "plain";
  if (value === "json") return "json";
  if (value === "markdown" || value === "md") return "markdown";
  throw new CapletsError(
    "REQUEST_INVALID",
    "storage output format must be plain, markdown, md, or json",
  );
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new CapletsError("REQUEST_INVALID", "schema version must be a positive integer");
  }
  return parsed;
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function requirePath(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new CapletsError("REQUEST_INVALID", `${label} is required`);
  }
  return resolve(value);
}

function ensureNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted)
    throw new CapletsError("SERVER_UNAVAILABLE", "storage lifecycle operation was interrupted");
}

function assertPrivateFile(path: string, label: string): void {
  let info;
  try {
    info = statSync(path);
  } catch {
    throw new CapletsError("CONFIG_NOT_FOUND", `${label} was not found`);
  }
  if (!info.isFile()) throw new CapletsError("CONFIG_INVALID", `${label} must be a regular file`);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `${label} permissions must restrict access to the owner`,
    );
  }
}

function assertLocalSqlitePath(path: string): void {
  if (
    path !== ":memory:" &&
    (path.length === 0 ||
      path.includes("\0") ||
      path.startsWith("//") ||
      path.startsWith("\\\\") ||
      /^(?:file|https?|nfs|smb|cifs):\/\//iu.test(path))
  ) {
    throw new CapletsError("CONFIG_INVALID", "SQLite database path must be local");
  }
}

function loadBetterSqlite3(): BetterSqlite3Constructor {
  const loaded = require("better-sqlite3") as
    | { default?: BetterSqlite3Constructor }
    | BetterSqlite3Constructor;
  return typeof loaded === "function" ? loaded : loaded.default!;
}

function loadPostgres(): PostgresFactory {
  const loaded = require("postgres") as { default?: PostgresFactory } | PostgresFactory;
  return typeof loaded === "function" ? loaded : loaded.default!;
}

function parseS3Credential(value: string | Uint8Array): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
} {
  if (typeof value !== "string")
    throw new CapletsError("CONFIG_INVALID", "S3 credential is invalid");
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (typeof parsed.accessKeyId !== "string" || typeof parsed.secretAccessKey !== "string")
      throw new Error("invalid");
    return {
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey,
      ...(typeof parsed.sessionToken === "string" ? { sessionToken: parsed.sessionToken } : {}),
    };
  } catch {
    throw new CapletsError(
      "CONFIG_INVALID",
      "S3 credential must resolve to a JSON access key pair",
    );
  }
}
