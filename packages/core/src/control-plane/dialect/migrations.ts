import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { satisfies } from "semver";
import { z } from "zod";
import { stableJsonStringify } from "../../stable-json";

export type SqlDialect = "sqlite" | "postgres";
export type MigrationClassification =
  | "compatible-expand"
  | "compatible-backfill"
  | "incompatible-contract"
  | "finalization";
export type MigrationExecutionPolicy = "automatic-compatible" | "host-admin";

type NumericRange = { minimum: number; maximum: number };
type BinaryRange = { minimum: string; maximumExclusive: string };

export type MigrationManifest = {
  formatVersion: 1;
  migrationId: string;
  order: number;
  dialect: SqlDialect;
  sourceSchemaVersion: number;
  destinationSchemaVersion: number;
  phase: "expand" | "backfill" | "contract" | "finalization";
  classification: MigrationClassification;
  executionPolicy: MigrationExecutionPolicy;
  automatic: boolean;
  sql: { file: string; sha256: string };
  compatibility: {
    binary: BinaryRange;
    schema: NumericRange;
    key: NumericRange;
    manifest: NumericRange;
  };
  activationRequirements: {
    verifiedSchemaAwareBackup: boolean;
    oldNodesDrained: boolean;
    retainedKeyVersions: number[];
    declaredSchemaAuthority: "migration-registry";
  };
  rollback: {
    mode: "down" | "restore" | "none";
    windowSeconds: number;
    down?: { file: string; sha256: string } | undefined;
    requiresVerifiedBackup: boolean;
    requiredRetainedKeyVersions: number[];
    failurePolicy: "fail-closed-single-schema-authority";
  };
  manifestSha256: string;
};

const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const assetSchema = z
  .object({ file: z.string().regex(/^[a-zA-Z0-9_.-]+$/u), sha256: checksumSchema })
  .strict();
const numericRangeSchema = z
  .object({ minimum: z.number().int().nonnegative(), maximum: z.number().int().nonnegative() })
  .strict();
const migrationManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    migrationId: z.string().min(1),
    order: z.number().int().nonnegative(),
    dialect: z.enum(["sqlite", "postgres"]),
    sourceSchemaVersion: z.number().int().nonnegative(),
    destinationSchemaVersion: z.number().int().nonnegative(),
    phase: z.enum(["expand", "backfill", "contract", "finalization"]),
    classification: z.enum([
      "compatible-expand",
      "compatible-backfill",
      "incompatible-contract",
      "finalization",
    ]),
    executionPolicy: z.enum(["automatic-compatible", "host-admin"]),
    automatic: z.boolean(),
    sql: assetSchema,
    compatibility: z
      .object({
        binary: z
          .object({ minimum: z.string().min(1), maximumExclusive: z.string().min(1) })
          .strict(),
        schema: numericRangeSchema,
        key: numericRangeSchema,
        manifest: numericRangeSchema,
      })
      .strict(),
    activationRequirements: z
      .object({
        verifiedSchemaAwareBackup: z.boolean(),
        oldNodesDrained: z.boolean(),
        retainedKeyVersions: z.array(z.number().int().nonnegative()),
        declaredSchemaAuthority: z.literal("migration-registry"),
      })
      .strict(),
    rollback: z
      .object({
        mode: z.enum(["down", "restore", "none"]),
        windowSeconds: z.number().int().positive(),
        down: assetSchema.optional(),
        requiresVerifiedBackup: z.boolean(),
        requiredRetainedKeyVersions: z.array(z.number().int().nonnegative()),
        failurePolicy: z.literal("fail-closed-single-schema-authority"),
      })
      .strict(),
    manifestSha256: checksumSchema,
  })
  .strict();

export type LoadedMigration = {
  manifest: MigrationManifest;
  sql: string;
  downSql?: string | undefined;
};

export type LoadedMigrationRegistry = {
  dialect: SqlDialect;
  assetDirectory: string;
  migrations: readonly LoadedMigration[];
};

export type MigrationEnvironment = {
  binaryVersion: string;
  supportedSchemaVersion: number;
  keyVersion: number;
  manifestVersion: number;
  verifiedSchemaAwareBackup: boolean;
  oldNodesDrained: boolean;
  retainedKeyVersions: readonly number[];
  hostAdministrator: boolean;
  now?: Date | undefined;
};

export type AppliedMigration = {
  migrationId: string;
  sqlSha256: string;
  manifestSha256: string;
  destinationSchemaVersion: number;
  appliedAt: string;
};

export async function loadMigrationRegistry(options: {
  dialect: SqlDialect;
  assetRoot?: URL | string | undefined;
}): Promise<LoadedMigrationRegistry> {
  const assetDirectory = migrationAssetDirectory(options);
  const directoryPath = fileURLToPath(assetDirectory);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const manifestFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".manifest.json"))
    .map((entry) => entry.name)
    .sort();
  if (manifestFiles.length === 0)
    throw new Error(`No packaged ${options.dialect} migrations found`);

  const migrations: LoadedMigration[] = [];
  for (const manifestFile of manifestFiles) {
    const manifestPath = new URL(manifestFile, assetDirectory);
    const raw: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    const manifest = parseManifest(raw, options.dialect, manifestFile);
    const { manifestSha256: storedManifestChecksum, ...unsigned } = manifest;
    const manifestChecksum = sha256(stableJsonStringify(unsigned));
    if (manifestChecksum !== storedManifestChecksum) {
      throw new Error(`Migration manifest checksum drift: ${manifest.migrationId}`);
    }
    const sql = await loadChecksummedAsset(assetDirectory, manifest.sql, manifest.migrationId);
    let downSql: string | undefined;
    if (manifest.rollback.down) {
      downSql = await loadChecksummedAsset(
        assetDirectory,
        manifest.rollback.down,
        `${manifest.migrationId} rollback`,
      );
    }
    migrations.push({ manifest, sql, ...(downSql === undefined ? {} : { downSql }) });
  }

  migrations.sort((left, right) => left.manifest.order - right.manifest.order);
  for (const [index, migration] of migrations.entries()) {
    if (migration.manifest.order !== index) {
      throw new Error(`Migration order is not contiguous at ${migration.manifest.migrationId}`);
    }
    const previous = migrations[index - 1];
    if (
      previous &&
      previous.manifest.destinationSchemaVersion !== migration.manifest.sourceSchemaVersion
    ) {
      throw new Error(
        `Migration schema chain is discontinuous at ${migration.manifest.migrationId}`,
      );
    }
  }
  return { dialect: options.dialect, assetDirectory: directoryPath, migrations };
}

export function assertMigrationEnvironment(
  registry: LoadedMigrationRegistry,
  environment: MigrationEnvironment,
): void {
  if (
    !Number.isSafeInteger(environment.supportedSchemaVersion) ||
    environment.supportedSchemaVersion < 0
  ) {
    throw new Error("Supported schema version is invalid");
  }
  const retainedKeys = new Set(environment.retainedKeyVersions);
  for (const migration of registry.migrations) {
    const compatibility = migration.manifest.compatibility;
    if (
      !satisfies(
        environment.binaryVersion,
        `>=${compatibility.binary.minimum} <${compatibility.binary.maximumExclusive}`,
      )
    ) {
      throw new Error(`Binary version is incompatible with ${migration.manifest.migrationId}`);
    }
    assertInRange(
      environment.supportedSchemaVersion,
      compatibility.schema,
      "schema",
      migration.manifest.migrationId,
    );
    assertInRange(environment.keyVersion, compatibility.key, "key", migration.manifest.migrationId);
    assertInRange(
      environment.manifestVersion,
      compatibility.manifest,
      "manifest",
      migration.manifest.migrationId,
    );
    for (const keyVersion of migration.manifest.activationRequirements.retainedKeyVersions) {
      if (!retainedKeys.has(keyVersion)) {
        throw new Error(`Required retained key ${keyVersion} is unavailable`);
      }
    }
    if (
      migration.manifest.activationRequirements.verifiedSchemaAwareBackup &&
      !environment.verifiedSchemaAwareBackup
    ) {
      throw new Error(`Migration ${migration.manifest.migrationId} requires a verified backup`);
    }
    if (migration.manifest.activationRequirements.oldNodesDrained && !environment.oldNodesDrained) {
      throw new Error(`Migration ${migration.manifest.migrationId} requires old-node drain`);
    }
    const administratorOnly =
      migration.manifest.executionPolicy === "host-admin" ||
      migration.manifest.classification === "incompatible-contract" ||
      migration.manifest.classification === "finalization";
    if (administratorOnly && !environment.hostAdministrator) {
      throw new Error(`Migration ${migration.manifest.migrationId} requires host administration`);
    }
    if (migration.manifest.automatic && administratorOnly) {
      throw new Error(
        `Administrator migration ${migration.manifest.migrationId} cannot be automatic`,
      );
    }
  }
}

export function planPendingMigrations(
  registry: LoadedMigrationRegistry,
  applied: readonly AppliedMigration[],
  environment: MigrationEnvironment,
): readonly LoadedMigration[] {
  assertMigrationEnvironment(registry, environment);
  if (applied.length > registry.migrations.length) {
    throw new Error("Database schema is newer than this binary");
  }
  for (const [index, record] of applied.entries()) {
    const known = registry.migrations[index];
    if (!known || known.manifest.migrationId !== record.migrationId) {
      throw new Error(`Unknown or out-of-order applied migration ${record.migrationId}`);
    }
    if (
      known.manifest.sql.sha256 !== record.sqlSha256 ||
      known.manifest.manifestSha256 !== record.manifestSha256
    ) {
      throw new Error(`Applied migration checksum drift: ${record.migrationId}`);
    }
    if (known.manifest.destinationSchemaVersion !== record.destinationSchemaVersion) {
      throw new Error(`Applied migration schema version drift: ${record.migrationId}`);
    }
  }
  const pending = registry.migrations.slice(applied.length);
  for (const migration of pending) {
    if (!migration.manifest.automatic && !environment.hostAdministrator) {
      throw new Error(
        `Pending migration ${migration.manifest.migrationId} requires host administration`,
      );
    }
  }
  return pending;
}

export function assertRollbackAllowed(
  migration: LoadedMigration,
  appliedAt: string,
  environment: MigrationEnvironment,
): void {
  const appliedAtMs = Date.parse(appliedAt);
  if (!Number.isFinite(appliedAtMs)) throw new Error("Applied migration clock is invalid");
  const rollback = migration.manifest.rollback;
  if (rollback.mode === "none") throw new Error("Migration has no rollback path");
  if (rollback.mode === "down" && !migration.downSql)
    throw new Error("Migration down SQL is unavailable");
  const now = environment.now ?? new Date();
  if (now.getTime() > appliedAtMs + rollback.windowSeconds * 1000) {
    throw new Error(`Rollback window expired for ${migration.manifest.migrationId}`);
  }
  if (rollback.requiresVerifiedBackup && !environment.verifiedSchemaAwareBackup) {
    throw new Error(`Rollback for ${migration.manifest.migrationId} requires a verified backup`);
  }
  const retainedKeys = new Set(environment.retainedKeyVersions);
  for (const keyVersion of rollback.requiredRetainedKeyVersions) {
    if (!retainedKeys.has(keyVersion)) throw new Error(`Rollback key ${keyVersion} is unavailable`);
  }
}

function migrationAssetDirectory(options: {
  dialect: SqlDialect;
  assetRoot?: URL | string | undefined;
}): URL {
  if (options.assetRoot === undefined) {
    return new URL(`../migrations/${options.dialect}/`, import.meta.url);
  }
  const root =
    typeof options.assetRoot === "string"
      ? pathToFileURL(`${options.assetRoot.replace(/\/$/u, "")}/`)
      : new URL(
          options.assetRoot.href.endsWith("/")
            ? options.assetRoot.href
            : `${options.assetRoot.href}/`,
        );
  return new URL(`${options.dialect}/`, root);
}

async function loadChecksummedAsset(
  directory: URL,
  asset: { file: string; sha256: string },
  label: string,
): Promise<string> {
  if (!/^[a-zA-Z0-9_.-]+$/u.test(asset.file))
    throw new Error(`Unsafe migration asset path for ${label}`);
  const content = await readFile(new URL(asset.file, directory), "utf8");
  if (sha256(content) !== asset.sha256) throw new Error(`Migration asset checksum drift: ${label}`);
  return content;
}

function parseManifest(value: unknown, dialect: SqlDialect, file: string): MigrationManifest {
  const manifest: MigrationManifest = migrationManifestSchema.parse(value);
  if (
    manifest.dialect !== dialect ||
    !file.startsWith(`${manifest.migrationId}.`) ||
    manifest.compatibility.schema.minimum > manifest.compatibility.schema.maximum ||
    manifest.compatibility.key.minimum > manifest.compatibility.key.maximum ||
    manifest.compatibility.manifest.minimum > manifest.compatibility.manifest.maximum
  ) {
    throw new Error(`Migration manifest ${file} is incompatible or malformed`);
  }
  const automaticClassifications: readonly MigrationClassification[] = [
    "compatible-expand",
    "compatible-backfill",
  ];
  const administratorClassification =
    manifest.classification === "incompatible-contract" ||
    manifest.classification === "finalization";
  if (
    manifest.automatic !== (manifest.executionPolicy === "automatic-compatible") ||
    (manifest.automatic && !automaticClassifications.includes(manifest.classification)) ||
    (administratorClassification &&
      (manifest.automatic ||
        manifest.executionPolicy !== "host-admin" ||
        !manifest.activationRequirements.verifiedSchemaAwareBackup ||
        !manifest.activationRequirements.oldNodesDrained)) ||
    (manifest.rollback.mode === "down" && !manifest.rollback.down) ||
    (manifest.rollback.mode === "restore" && !manifest.rollback.requiresVerifiedBackup)
  ) {
    throw new Error(`Migration manifest ${file} has an unsafe execution policy`);
  }
  return manifest;
}

function assertInRange(
  value: number,
  range: NumericRange,
  label: string,
  migrationId: string,
): void {
  if (!Number.isSafeInteger(value) || value < range.minimum || value > range.maximum) {
    throw new Error(`${label} version is incompatible with ${migrationId}`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
