import { chmod, mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { createSqliteAuthority } from "../src/storage/sql/authority";
import { migrateSqliteDatabase } from "../src/storage/sql/migrate";
import type { AuthorityExport, AuthorityHead } from "../src/storage/types";

type Fixture = {
  root: string;
  sourceConfig: string;
  destinationConfig: string;
  restoreConfig: string;
  filesystemConfig: string;
  sourceDb: string;
  destinationDb: string;
  restoreDb: string;
  keyFile: string;
  sourceAuthorityId: string;
  destinationAuthorityId: string;
  namespace: string;
  providerCredential: string;
  vaultKey: string;
  keyMaterial: string;
  vaultSecret: string;
  oauthSecret: string;
  sessionSecret: string;
  snapshot: Record<string, unknown>;
};

type CliRun = {
  text: string;
  errorText: string;
  exitCode?: number;
};

type JsonRun = CliRun & {
  value: Record<string, unknown>;
};

const sourceAuthorityId = "current-host";
const destinationAuthorityId = "current-host";
const namespace = "default";

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "caplets-cli-storage-"));
  const sourceDb = join(root, "source", "authority.sqlite");
  const destinationDb = join(root, "destination", "authority.sqlite");
  const restoreDb = join(root, "restore", "authority.sqlite");
  const sourceConfig = join(root, "source", "config.json");
  const destinationConfig = join(root, "destination", "config.json");
  const restoreConfig = join(root, "restore", "config.json");
  const filesystemConfig = join(root, "filesystem", "config.json");
  const keyFile = join(root, "backup.key");
  const providerCredential =
    "postgres://provider-user:provider-password@db.example.invalid/authority";
  const vaultKey = Buffer.alloc(32, 7).toString("base64url");
  const keyMaterial = "external-backup-key-material";
  const vaultSecret = "plaintext-vault-secret";
  const oauthSecret = "plaintext-oauth-secret";
  const sessionSecret = "plaintext-session-secret";
  const snapshot: Record<string, unknown> = {
    config: {},
    caplets: {},
    vault: { tokenRecord: { token: vaultSecret, oauthSecret } },
    sessions: { active: { sessionToken: sessionSecret, revision: 1 } },
  };
  await migrateSqliteDatabase({
    databasePath: sourceDb,
    authorityId: sourceAuthorityId,
    namespace,
  });
  await migrateSqliteDatabase({
    databasePath: destinationDb,
    authorityId: destinationAuthorityId,
    namespace,
  });
  await migrateSqliteDatabase({
    databasePath: restoreDb,
    authorityId: sourceAuthorityId,
    namespace,
  });
  await mkdir(join(root, "filesystem"), { recursive: true });
  await writeFile(
    sourceConfig,
    `${JSON.stringify(
      {
        version: 1,
        storage: {
          provider: "sqlite",
          path: sourceDb,
          vaultKey: "env:CAPLETS_VAULT_KEY_BYTES",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    destinationConfig,
    `${JSON.stringify(
      {
        version: 1,
        storage: {
          provider: "sqlite",
          path: destinationDb,
          vaultKey: "env:CAPLETS_VAULT_KEY_BYTES",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    restoreConfig,
    `${JSON.stringify(
      {
        version: 1,
        storage: {
          provider: "sqlite",
          path: restoreDb,
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    filesystemConfig,
    `${JSON.stringify(
      {
        version: 1,
        storage: { provider: "filesystem", path: join(root, "filesystem", "state") },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(keyFile, keyMaterial, { mode: 0o600 });
  await chmod(keyFile, 0o600);

  const authority = await createSqliteAuthority({
    databasePath: sourceDb,
    authorityId: sourceAuthorityId,
    namespace,
    initialSnapshot: {},
  });
  try {
    const committed = await authority.commit({
      authorityId: sourceAuthorityId,
      currentHostId: "cli-test-host",
      principalId: "cli-test-operator",
      expectedGeneration: null,
      idempotencyKey: "seed-source",
      requestDigest: "seed-source-digest",
      command: { snapshot },
    });
    expect(committed.kind).toBe("committed");
  } finally {
    await authority.close();
  }

  return {
    root,
    sourceConfig,
    destinationConfig,
    restoreConfig,
    filesystemConfig,
    sourceDb,
    destinationDb,
    restoreDb,
    keyFile,
    sourceAuthorityId,
    destinationAuthorityId,
    namespace,
    providerCredential,
    vaultKey,
    keyMaterial,
    vaultSecret,
    oauthSecret,
    sessionSecret,
    snapshot,
  };
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}

function cliEnv(
  fixture: Fixture,
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CAPLETS_MODE: "local",
    CAPLETS_CONFIG: fixture.sourceConfig,
    CAPLETS_PROJECT_CONFIG: join(fixture.root, "project-config.json"),
    XDG_STATE_HOME: join(fixture.root, "state"),
    CAPLETS_PROVIDER_CONNECTION: fixture.providerCredential,
    CAPLETS_VAULT_KEY_BYTES: fixture.vaultKey,
    ...extra,
  };
}

async function runStorage(
  fixture: Fixture,
  args: string[],
  signal?: AbortSignal,
  envOverrides: Record<string, string | undefined> = {},
): Promise<CliRun> {
  const output: string[] = [];
  const errors: string[] = [];
  let exitCode: number | undefined;
  await runCli(args, {
    env: cliEnv(fixture, envOverrides),
    authDir: join(fixture.root, "auth"),
    ...(signal === undefined ? {} : { signal }),
    writeOut: (value) => output.push(value),
    writeErr: (value) => errors.push(value),
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  return {
    text: output.join(""),
    errorText: errors.join(""),
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

async function runStorageJson(
  fixture: Fixture,
  args: string[],
  signal?: AbortSignal,
  envOverrides: Record<string, string | undefined> = {},
): Promise<JsonRun> {
  const result = await runStorage(fixture, [...args, "--json"], signal, envOverrides);
  const value = JSON.parse(result.text) as Record<string, unknown>;
  return { ...result, value };
}

async function readSqliteExport(
  databasePath: string,
  authorityId: string,
  authorityNamespace: string,
): Promise<AuthorityExport> {
  const authority = await createSqliteAuthority({
    databasePath,
    authorityId,
    namespace: authorityNamespace,
  });
  try {
    return await authority.exportState();
  } finally {
    await authority.close();
  }
}

async function readSqliteHead(
  databasePath: string,
  authorityId: string,
  authorityNamespace: string,
): Promise<AuthorityHead | null> {
  const authority = await createSqliteAuthority({
    databasePath,
    authorityId,
    namespace: authorityNamespace,
  });
  try {
    return await authority.readHead();
  } finally {
    await authority.close();
  }
}

async function seedNonEmptySqlite(
  databasePath: string,
  authorityId: string,
  authorityNamespace: string,
): Promise<void> {
  const authority = await createSqliteAuthority({
    databasePath,
    authorityId,
    namespace: authorityNamespace,
  });
  try {
    const committed = await authority.commit({
      authorityId,
      currentHostId: "non-empty-host",
      principalId: "non-empty-operator",
      expectedGeneration: null,
      idempotencyKey: "non-empty-seed",
      requestDigest: "non-empty-seed",
      command: { snapshot: { config: { existing: true } } },
    });
    expect(committed.kind).toBe("committed");
  } finally {
    await authority.close();
  }
}

function expectSafeOutput(
  text: string,
  fixture: Fixture,
  options: { includeBackupPath?: boolean } = {},
): void {
  expect(text).not.toContain(fixture.providerCredential);
  expect(text).not.toContain(fixture.vaultKey);
  expect(text).not.toContain(fixture.keyMaterial);
  expect(text).not.toContain(fixture.vaultSecret);
  expect(text).not.toContain(fixture.oauthSecret);
  expect(text).not.toContain(fixture.sessionSecret);
  expect(text).not.toContain(fixture.sourceConfig);
  expect(text).not.toContain(fixture.sourceDb);
  if (!options.includeBackupPath) expect(text).not.toContain(fixture.root);
}

function expectJsonError(value: Record<string, unknown>, code: string): void {
  expect(value.error).toEqual(expect.objectContaining({ code }));
}

describe("storage lifecycle CLI", () => {
  it("runs inventory and fenced migration through Commander without mutating source/config state", async () => {
    const fixture = await makeFixture();
    try {
      const sourceConfigBefore = await readFile(fixture.sourceConfig);
      const destinationConfigBefore = await readFile(fixture.destinationConfig);
      const sourceExportBefore = await readSqliteExport(
        fixture.sourceDb,
        fixture.sourceAuthorityId,
        fixture.namespace,
      );

      const inventory = await runStorageJson(fixture, [
        "storage",
        "inventory",
        "--config",
        fixture.sourceConfig,
      ]);
      expect(inventory.value).toMatchObject({ kind: "inventory" });
      expect(inventory.value.inventory).toMatchObject({
        identity: {
          authorityId: fixture.sourceAuthorityId,
          provider: "sqlite",
          namespace: fixture.namespace,
        },
      });
      const inventoryOutput = inventory.text;
      expect(inventoryOutput).toContain("current-host");
      expect(inventoryOutput).toContain("vault");
      expectSafeOutput(inventoryOutput, fixture);
      const sourceFlagInventory = await runStorageJson(
        fixture,
        [
          "storage",
          "inventory",
          "--config",
          fixture.destinationConfig,
          "--source-config",
          fixture.sourceConfig,
        ],
        undefined,
        { CAPLETS_CONFIG: join(fixture.root, "missing-config.json") },
      );
      expect(sourceFlagInventory.value.inventory).toMatchObject({
        identity: { authorityId: fixture.sourceAuthorityId, provider: "sqlite" },
      });
      expectSafeOutput(sourceFlagInventory.text, fixture);

      const sourceProfileInventory = await runStorageJson(
        fixture,
        ["storage", "inventory", "--source-profile", "SOURCE_PROFILE"],
        undefined,
        {
          CAPLETS_CONFIG: join(fixture.root, "missing-config.json"),
          CAPLETS_STORAGE_PROFILE_SOURCE_PROFILE: fixture.sourceConfig,
        },
      );
      expect(sourceProfileInventory.value.inventory).toMatchObject({
        identity: { authorityId: fixture.sourceAuthorityId, provider: "sqlite" },
      });
      expectSafeOutput(sourceProfileInventory.text, fixture);

      for (const invalidProfile of ["", "lower", "WITH-HYPHEN", "ÜNICODE", "env:SOURCE"]) {
        const invalid = await runStorageJson(
          fixture,
          ["storage", "inventory", "--source-profile", invalidProfile],
          undefined,
          {
            CAPLETS_STORAGE_PROFILE_SOURCE: fixture.sourceConfig,
            CAPLETS_STORAGE_PROFILE_LOWER: fixture.sourceConfig,
          },
        );
        expectJsonError(invalid.value, "REQUEST_INVALID");
      }

      const legacyProfile = await runStorageJson(
        fixture,
        ["storage", "inventory", "--source-profile", "SOURCE_PROFILE"],
        undefined,
        { CAPLETS_AUTHORITY_PROFILE_SOURCE_PROFILE: fixture.sourceConfig },
      );
      expectJsonError(legacyProfile.value, "CONFIG_INVALID");

      const profileAuth = await runStorage(fixture, ["auth", "list", "--json"], undefined, {
        CAPLETS_CONFIG: join(fixture.root, "missing-config.json"),
        CAPLETS_STORAGE_PROFILE_SHARED: fixture.sourceConfig,
      });
      expect(JSON.parse(profileAuth.text)).toEqual([]);
      expectSafeOutput(profileAuth.text, fixture);

      await expect(
        runStorage(fixture, ["auth", "list", "--json"], undefined, {
          CAPLETS_CONFIG: join(fixture.root, "missing-config.json"),
          CAPLETS_STORAGE_PROFILE_ALPHA: fixture.sourceConfig,
          CAPLETS_STORAGE_PROFILE_BETA: fixture.destinationConfig,
        }),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      for (const malformedProfiles of [
        { CAPLETS_STORAGE_PROFILE_lower: fixture.sourceConfig },
        { CAPLETS_STORAGE_PROFILE_: fixture.sourceConfig },
        { CAPLETS_STORAGE_PROFILE_EMPTY: "" },
        { CAPLETS_STORAGE_PROFILE_BLANK: "   " },
      ]) {
        await expect(
          runStorage(fixture, ["auth", "list", "--json"], undefined, {
            CAPLETS_CONFIG: join(fixture.root, "missing-config.json"),
            ...malformedProfiles,
          }),
        ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      }

      const aliasedProfiles = await runStorageJson(
        fixture,
        [
          "storage",
          "migration",
          "dry-run",
          "--source-profile",
          "SOURCE",
          "--destination-profile",
          "DESTINATION",
        ],
        undefined,
        {
          CAPLETS_STORAGE_PROFILE_SOURCE: fixture.sourceConfig,
          CAPLETS_STORAGE_PROFILE_DESTINATION: fixture.sourceConfig,
        },
      );
      expectJsonError(aliasedProfiles.value, "REQUEST_INVALID");
      expect(aliasedProfiles.value.error).toEqual(
        expect.objectContaining({
          message: expect.stringContaining("different config paths or profiles"),
        }),
      );
      await expect(
        runStorage(fixture, [
          "storage",
          "migration",
          "dry-run",
          "--source-config",
          fixture.sourceConfig,
          "--destination-config",
          fixture.destinationConfig,
          "--target-namespace",
          "chosen",
        ]),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

      const inventoryHuman = await runStorage(fixture, [
        "storage",
        "inventory",
        "--config",
        fixture.sourceConfig,
      ]);
      expect(inventoryHuman.text).toContain("Storage inventory");
      expect(inventoryHuman.text).toContain("Source digest:");
      expectSafeOutput(inventoryHuman.text, fixture);

      const dryRun = await runStorageJson(fixture, [
        "storage",
        "migration",
        "dry-run",
        "--source-config",
        fixture.sourceConfig,
        "--destination-config",
        fixture.destinationConfig,
      ]);
      expect(dryRun.value).toMatchObject({ kind: "migration-dry-run" });
      expect(dryRun.value.inventory).toBeDefined();
      expect(dryRun.value.target).toMatchObject({
        authorityId: fixture.destinationAuthorityId,
        provider: "sqlite",
        namespace: fixture.namespace,
      });
      expect(
        await readSqliteHead(
          fixture.destinationDb,
          fixture.destinationAuthorityId,
          fixture.namespace,
        ),
      ).toBeNull();
      expect(await readFile(fixture.sourceConfig)).toEqual(sourceConfigBefore);
      expect(await readFile(fixture.destinationConfig)).toEqual(destinationConfigBefore);
      expect(
        await readSqliteExport(fixture.sourceDb, fixture.sourceAuthorityId, fixture.namespace),
      ).toEqual(sourceExportBefore);
      expectSafeOutput(dryRun.text, fixture);

      const applied = await runStorageJson(fixture, [
        "storage",
        "migration",
        "apply",
        "--source-config",
        fixture.sourceConfig,
        "--destination-config",
        fixture.destinationConfig,
      ]);
      expect(applied.value).toMatchObject({ kind: "migration-applied" });
      expect((applied.value.cutover as Record<string, unknown>).sequence).toBe(1);
      const targetHead = await readSqliteHead(
        fixture.destinationDb,
        fixture.destinationAuthorityId,
        fixture.namespace,
      );
      expect(targetHead).toEqual(
        expect.objectContaining({ sequence: 1, authorityId: fixture.destinationAuthorityId }),
      );
      expect(
        await readSqliteExport(fixture.sourceDb, fixture.sourceAuthorityId, fixture.namespace),
      ).toEqual(sourceExportBefore);
      expect(await readFile(fixture.sourceConfig)).toEqual(sourceConfigBefore);
      expect(await readFile(fixture.destinationConfig)).toEqual(destinationConfigBefore);
      expectSafeOutput(applied.text, fixture);

      const secondApply = await runStorageJson(fixture, [
        "storage",
        "migrate",
        "--apply",
        "--source-config",
        fixture.sourceConfig,
        "--destination-config",
        fixture.destinationConfig,
      ]);
      expectJsonError(secondApply.value, "CONFIG_EXISTS");
      expect(secondApply.exitCode).toBe(1);
      expectSafeOutput(secondApply.text, fixture);

      const afterErrorSource = await readSqliteExport(
        fixture.sourceDb,
        fixture.sourceAuthorityId,
        fixture.namespace,
      );
      expect(afterErrorSource).toEqual(sourceExportBefore);
      expect(
        await readSqliteHead(
          fixture.destinationDb,
          fixture.destinationAuthorityId,
          fixture.namespace,
        ),
      ).toEqual(targetHead);
    } finally {
      await cleanupFixture(fixture);
    }
  }, 30_000);

  it("creates, inspects, authenticates, and restores encrypted backups with deterministic rejection and cleanup", async () => {
    const fixture = await makeFixture();
    try {
      const backupPath = join(fixture.root, "backups", "source.backup");
      const created = await runStorageJson(fixture, [
        "storage",
        "backup",
        "create",
        "--config",
        fixture.sourceConfig,
        "--key-file",
        fixture.keyFile,
        "--output",
        backupPath,
      ]);
      expect(created.value).toMatchObject({ kind: "backup-created", bytes: expect.any(Number) });
      expect(created.value.header).toMatchObject({
        provider: "sqlite",
        authorityId: fixture.sourceAuthorityId,
        namespace: fixture.namespace,
        keyFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      expect(await stat(backupPath)).toMatchObject({ mode: expect.any(Number) });
      if (process.platform !== "win32") expect((await stat(backupPath)).mode & 0o077).toBe(0);
      expectSafeOutput(created.text, fixture, { includeBackupPath: true });

      const inspected = await runStorageJson(fixture, [
        "storage",
        "backup",
        "inspect-header",
        "--input",
        backupPath,
      ]);
      expect(inspected.value).toMatchObject({ kind: "backup-header" });
      expect((inspected.value.header as Record<string, unknown>).keyFingerprint).toEqual(
        (created.value.header as Record<string, unknown>).keyFingerprint,
      );
      expectSafeOutput(inspected.text, fixture);

      const grownBackupPath = join(fixture.root, "backups", "grown.backup");
      await writeFile(grownBackupPath, await readFile(backupPath), { mode: 0o600 });
      await truncate(grownBackupPath, 64 * 1024 * 1024 + 16 * 1024 + 1);
      const grownBackup = await runStorageJson(fixture, [
        "storage",
        "backup",
        "inspect-header",
        "--input",
        grownBackupPath,
      ]);
      expectJsonError(grownBackup.value, "CONFIG_INVALID");
      expect(grownBackup.exitCode).toBe(1);

      const competingOutput = join(fixture.root, "backups", "competing.backup");
      const competing = await Promise.all([
        runStorageJson(fixture, [
          "storage",
          "backup",
          "create",
          "--config",
          fixture.sourceConfig,
          "--key-file",
          fixture.keyFile,
          "--output",
          competingOutput,
        ]),
        runStorageJson(fixture, [
          "storage",
          "backup",
          "create",
          "--config",
          fixture.sourceConfig,
          "--key-file",
          fixture.keyFile,
          "--output",
          competingOutput,
        ]),
      ]);
      expect(competing.filter((result) => result.exitCode === undefined)).toHaveLength(1);
      expect(competing).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            value: expect.objectContaining({
              error: expect.objectContaining({ code: "CONFIG_EXISTS" }),
            }),
          }),
        ]),
      );

      const restoreBefore = await readSqliteHead(
        fixture.restoreDb,
        fixture.sourceAuthorityId,
        fixture.namespace,
      );
      expect(restoreBefore).toBeNull();
      const restored = await runStorageJson(fixture, [
        "storage",
        "backup",
        "restore",
        "--destination-config",
        fixture.restoreConfig,
        "--input",
        backupPath,
        "--key-ref",
        `file:${fixture.keyFile}`,
      ]);
      expect(restored.value).toMatchObject({ kind: "backup-restored" });
      const restoredHead = await readSqliteHead(
        fixture.restoreDb,
        fixture.sourceAuthorityId,
        fixture.namespace,
      );
      expect(restoredHead).toMatchObject({ sequence: 1, authorityId: fixture.sourceAuthorityId });
      expect(restoredHead?.id).toBe((created.value.header as Record<string, unknown>).generationId);
      expectSafeOutput(restored.text, fixture);

      const wrongKeyTargetDb = join(fixture.root, "wrong-key", "authority.sqlite");
      const wrongKeyConfig = join(fixture.root, "wrong-key", "config.json");
      await migrateSqliteDatabase({
        databasePath: wrongKeyTargetDb,
        authorityId: fixture.sourceAuthorityId,
        namespace,
      });
      await writeFile(
        wrongKeyConfig,
        `${JSON.stringify({ version: 1, storage: { provider: "sqlite", path: wrongKeyTargetDb } }, null, 2)}\n`,
      );
      const wrongKey = await runStorageJson(fixture, [
        "storage",
        "backup",
        "restore",
        "--destination-config",
        wrongKeyConfig,
        "--input",
        backupPath,
        "--key-env",
        "CAPLETS_WRONG_BACKUP_KEY",
      ]);
      expectJsonError(wrongKey.value, "AUTH_FAILED");
      expect(wrongKey.exitCode).toBe(1);
      expect(
        await readSqliteHead(wrongKeyTargetDb, fixture.sourceAuthorityId, namespace),
      ).toBeNull();
      expectSafeOutput(wrongKey.text, fixture);

      const missingKey = await runStorageJson(fixture, [
        "storage",
        "backup",
        "create",
        "--config",
        fixture.sourceConfig,
        "--key-env",
        "CAPLETS_MISSING_BACKUP_KEY",
        "--output",
        join(fixture.root, "missing-key.backup"),
      ]);
      expectJsonError(missingKey.value, "AUTH_FAILED");
      expectSafeOutput(missingKey.text, fixture);

      await chmod(fixture.keyFile, 0o644);
      const insecureKey = await runStorageJson(fixture, [
        "storage",
        "backup",
        "create",
        "--config",
        fixture.sourceConfig,
        "--key-file",
        fixture.keyFile,
        "--output",
        join(fixture.root, "insecure.backup"),
      ]);
      expectJsonError(insecureKey.value, "CONFIG_INVALID");
      expectSafeOutput(insecureKey.text, fixture);
      await chmod(fixture.keyFile, 0o600);

      const inlineKey = await runStorageJson(fixture, [
        "storage",
        "backup",
        "create",
        "--config",
        fixture.sourceConfig,
        "--key-ref",
        fixture.keyMaterial,
        "--output",
        join(fixture.root, "inline.backup"),
      ]);
      expectJsonError(inlineKey.value, "REQUEST_INVALID");
      expectSafeOutput(inlineKey.text, fixture);

      const corruptHeaderPath = join(fixture.root, "corrupt-header.backup");
      const corruptHeader = Buffer.from(await readFile(backupPath));
      corruptHeader[0] = (corruptHeader[0] ?? 0) ^ 0xff;
      await writeFile(corruptHeaderPath, corruptHeader, { mode: 0o600 });
      const corruptHeaderResult = await runStorageJson(fixture, [
        "storage",
        "backup",
        "inspect-header",
        "--input",
        corruptHeaderPath,
      ]);
      expectJsonError(corruptHeaderResult.value, "CONFIG_INVALID");
      expectSafeOutput(corruptHeaderResult.text, fixture);

      const corruptBodyTargetDb = join(fixture.root, "corrupt-body", "authority.sqlite");
      const corruptBodyConfig = join(fixture.root, "corrupt-body", "config.json");
      await migrateSqliteDatabase({
        databasePath: corruptBodyTargetDb,
        authorityId: fixture.sourceAuthorityId,
        namespace,
      });
      await writeFile(
        corruptBodyConfig,
        `${JSON.stringify({ version: 1, storage: { provider: "sqlite", path: corruptBodyTargetDb } }, null, 2)}\n`,
      );
      const corruptBodyPath = join(fixture.root, "corrupt-body.backup");
      const corruptBody = Buffer.from(await readFile(backupPath));
      const lastByteIndex = corruptBody.length - 1;
      corruptBody[lastByteIndex] = (corruptBody[lastByteIndex] ?? 0) ^ 0xff;
      await writeFile(corruptBodyPath, corruptBody, { mode: 0o600 });
      const corruptBodyResult = await runStorageJson(fixture, [
        "storage",
        "backup",
        "restore",
        "--destination-config",
        corruptBodyConfig,
        "--input",
        corruptBodyPath,
        "--key-file",
        fixture.keyFile,
      ]);
      expectJsonError(corruptBodyResult.value, "CONFIG_INVALID");
      expect(
        await readSqliteHead(corruptBodyTargetDb, fixture.sourceAuthorityId, namespace),
      ).toBeNull();
      expectSafeOutput(corruptBodyResult.text, fixture);

      const nonEmptyTargetDb = join(fixture.root, "non-empty", "authority.sqlite");
      const nonEmptyTargetConfig = join(fixture.root, "non-empty", "config.json");
      await migrateSqliteDatabase({
        databasePath: nonEmptyTargetDb,
        authorityId: fixture.sourceAuthorityId,
        namespace,
      });
      await writeFile(
        nonEmptyTargetConfig,
        `${JSON.stringify({ version: 1, storage: { provider: "sqlite", path: nonEmptyTargetDb } }, null, 2)}\n`,
      );
      await seedNonEmptySqlite(nonEmptyTargetDb, fixture.sourceAuthorityId, namespace);
      const nonEmpty = await runStorageJson(fixture, [
        "storage",
        "backup",
        "restore",
        "--destination-config",
        nonEmptyTargetConfig,
        "--input",
        backupPath,
        "--key-file",
        fixture.keyFile,
      ]);
      expectJsonError(nonEmpty.value, "CONFIG_EXISTS");
      expect(
        await readSqliteHead(nonEmptyTargetDb, fixture.sourceAuthorityId, namespace),
      ).toMatchObject({ sequence: 1 });
      expectSafeOutput(nonEmpty.text, fixture);

      const schemaMismatchTargetDb = join(fixture.root, "schema-mismatch", "authority.sqlite");
      const schemaMismatchConfig = join(fixture.root, "schema-mismatch", "config.json");
      await migrateSqliteDatabase({
        databasePath: schemaMismatchTargetDb,
        authorityId: fixture.sourceAuthorityId,
        namespace,
      });
      await writeFile(
        schemaMismatchConfig,
        `${JSON.stringify({ version: 1, storage: { provider: "sqlite", path: schemaMismatchTargetDb } }, null, 2)}\n`,
      );
      const schemaMismatch = await runStorageJson(fixture, [
        "storage",
        "backup",
        "restore",
        "--destination-config",
        schemaMismatchConfig,
        "--input",
        backupPath,
        "--key-file",
        fixture.keyFile,
        "--schema-version",
        "999",
      ]);
      expectJsonError(schemaMismatch.value, "CONFIG_INVALID");
      expect(
        await readSqliteHead(schemaMismatchTargetDb, fixture.sourceAuthorityId, namespace),
      ).toBeNull();
      expectSafeOutput(schemaMismatch.text, fixture);

      const providerMismatch = await runStorageJson(fixture, [
        "storage",
        "backup",
        "restore",
        "--destination-config",
        fixture.filesystemConfig,
        "--input",
        backupPath,
        "--key-file",
        fixture.keyFile,
      ]);
      expectJsonError(providerMismatch.value, "CONFIG_INVALID");
      expectSafeOutput(providerMismatch.text, fixture);
    } finally {
      await cleanupFixture(fixture);
    }
  }, 30_000);

  it("runs SQLite schema lifecycle, safely rejects unsupported providers, handles interruption, and completes storage paths", async () => {
    const fixture = await makeFixture();
    try {
      const status = await runStorageJson(fixture, [
        "storage",
        "schema",
        "status",
        "--config",
        fixture.sourceConfig,
      ]);
      expect(status.value).toMatchObject({
        kind: "schema-status",
        provider: "sqlite",
        authorityId: fixture.sourceAuthorityId,
        namespace: fixture.namespace,
        applied: 0,
        logicalSchemaVersion: 3,
      });
      expectSafeOutput(status.text, fixture);

      const migrated = await runStorageJson(fixture, [
        "storage",
        "provider",
        "schema",
        "migrate",
        "--config",
        fixture.sourceConfig,
      ]);
      expect(migrated.value).toMatchObject({
        kind: "schema-migrated",
        provider: "sqlite",
        applied: 0,
        logicalSchemaVersion: 3,
      });
      expectSafeOutput(migrated.text, fixture);

      const unsupported = await runStorageJson(fixture, [
        "storage",
        "schema",
        "status",
        "--config",
        fixture.filesystemConfig,
      ]);
      expectJsonError(unsupported.value, "UNSUPPORTED_OPERATION");
      expectSafeOutput(unsupported.text, fixture);

      const controller = new AbortController();
      controller.abort();
      const interrupted = await runStorageJson(
        fixture,
        ["storage", "inventory", "--config", fixture.sourceConfig],
        controller.signal,
      );
      expectJsonError(interrupted.value, "SERVER_UNAVAILABLE");
      expect(interrupted.exitCode).toBe(1);
      expectSafeOutput(interrupted.text, fixture);
      await expect(
        readSqliteExport(fixture.sourceDb, fixture.sourceAuthorityId, fixture.namespace),
      ).resolves.toBeDefined();

      const completionTop = await runStorage(fixture, [
        "__complete",
        "--shell",
        "bash",
        "storage",
        "",
      ]);
      expect(completionTop.text.split("\n")).toContain("inventory");
      expect(completionTop.text.split("\n")).toContain("migration");
      expect(completionTop.text.split("\n")).toContain("backup");
      expect(completionTop.text.split("\n")).toContain("schema");

      const completionNested = await runStorage(fixture, [
        "__complete",
        "--shell",
        "bash",
        "storage",
        "migration",
        "",
      ]);
      expect(completionNested.text.split("\n")).toEqual(
        expect.arrayContaining(["dry-run", "apply"]),
      );
      const completionBackup = await runStorage(fixture, [
        "__complete",
        "--shell",
        "bash",
        "storage",
        "backup",
        "",
      ]);
      expect(completionBackup.text.split("\n")).toEqual(
        expect.arrayContaining(["create", "inspect-header", "restore"]),
      );
      const completionSchema = await runStorage(fixture, [
        "__complete",
        "--shell",
        "bash",
        "storage",
        "schema",
        "",
      ]);
      expect(completionSchema.text.split("\n")).toEqual(
        expect.arrayContaining(["status", "migrate"]),
      );
    } finally {
      await cleanupFixture(fixture);
    }
  }, 30_000);
});
