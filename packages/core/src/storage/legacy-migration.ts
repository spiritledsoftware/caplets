import { createHash, type Hash } from "node:crypto";
import {
  constants as fsConstants,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  readLegacyOAuthTokenBundleSnapshot,
  type LegacyOAuthTokenBundleSnapshot,
} from "../auth/store";
import { readCapletsLockfile, validateLockfileDestination } from "../lockfile";
import { DashboardActivityLog, type DashboardActivityEntry } from "../dashboard/activity-log";
import { CapletsError } from "../errors";
import {
  RemoteServerCredentialStore,
  type RemoteServerCredentialState,
} from "../remote/server-credential-store";
import { LocalSetupStore, type LegacySetupMigrationSnapshot } from "../setup/local-store";
import { FileVaultStore, type LegacyVaultMigrationSnapshot } from "../vault";
import type { ImportCapletBundleInput } from "./caplet-records";
import type { OperatorPrincipal } from "./installations";
import { createHostStorage, type HostStorage } from "./database";
import type { LegacyVaultGrantImport } from "./vault-grants";
import type {
  HostDatabaseTransaction,
  HostStorageConfig,
  PostgresHostTransaction,
  SqliteHostTransaction,
} from "./types";

export type LegacyMigrationOptions = {
  storage: HostStorageConfig;
  capletsRoot: string;
  lockfilePath: string;
  operatorClientId: string;
  backupRoot?: string | undefined;
  dryRun?: boolean | undefined;
  backendAuthDir?: string | undefined;
  legacyVaultRoot?: string | undefined;
  legacyVaultEnv?: Record<string, string | undefined> | undefined;
  targetVaultRoot?: string | undefined;
  remoteSecurityDir?: string | undefined;
  setupStateDir?: string | undefined;
  operatorActivityDir?: string | undefined;
};

export type LegacyMigrationDomainReport = {
  backendAuthTokenBundles: number;
  vaultValues: number;
  vaultGrants: number;
  remotePairingCodes: number;
  remoteClients: number;
  remotePendingLogins: number;
  setupApprovals: number;
  setupAttempts: number;
  operatorActivityEntries: number;
  dashboardSessions: "not_applicable_no_legacy_format";
  projectBindings: "not_applicable_no_legacy_format";
};

export type LegacyMigrationReport = {
  status: "verified" | "migrated";
  records: number;
  installations: number;
  backupPath: string | null;
  domains?: LegacyMigrationDomainReport | undefined;
};

type PlannedArtifact = {
  id: string;
  destination: string;
  installedHash: string;
  sourceKind: string;
  sourceIdentity: string;
  files: Array<{ path: string; content: Buffer; executable: boolean }>;
};

type BackupMove = {
  source: string;
  target: string;
  preserveSource?: boolean | undefined;
};

type PlannedLegacyState = {
  artifacts: PlannedArtifact[];
  backendAuth: LegacyOAuthTokenBundleSnapshot;
  vault: LegacyVaultMigrationSnapshot;
  vaultGrants: LegacyVaultGrantImport[];
  remoteSecurity: RemoteServerCredentialState;
  setup: LegacySetupMigrationSnapshot;
  operatorActivity: DashboardActivityEntry[];
  backupMoves: BackupMove[];
  includeDomainReport: boolean;
};

const EMPTY_BACKEND_AUTH: LegacyOAuthTokenBundleSnapshot = { bundles: [], sourcePaths: [] };
const EMPTY_VAULT: LegacyVaultMigrationSnapshot = { values: [], grants: [], sourcePaths: [] };
const EMPTY_REMOTE_SECURITY: RemoteServerCredentialState = {
  version: 1,
  pairingCodes: [],
  pendingLogins: [],
  clients: [],
};
const EMPTY_SETUP: LegacySetupMigrationSnapshot = {
  approvals: [],
  attempts: [],
  sourcePaths: [],
};

export async function migrateLegacyHostState(
  options: LegacyMigrationOptions,
): Promise<LegacyMigrationReport> {
  const lockPath = `${options.lockfilePath}.migration.lock`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  let lock: number;
  try {
    lock = openSync(lockPath, "wx", 0o600);
  } catch {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Legacy migration is already active or left a stale lock at ${lockPath}.`,
    );
  }

  let storage: HostStorage | undefined;
  try {
    const backupPath =
      options.backupRoot ??
      join(dirname(options.lockfilePath), "migration-backups", timestampForPath(new Date()));
    const plan = planLegacyState(options, backupPath);
    storage = await createHostStorage(
      options.storage,
      options.targetVaultRoot === undefined ? {} : { vaultRoot: options.targetVaultRoot },
    );
    if (
      options.legacyVaultRoot !== undefined &&
      options.targetVaultRoot === undefined &&
      resolve(storage.vaultValues.root) === resolve(options.legacyVaultRoot)
    ) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Legacy and SQL Vault key roots must be different during migration.",
      );
    }
    if ((await storage.coordination.activeNodeCount()) > 0) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Stop every Host Node before migrating legacy filesystem state.",
      );
    }

    const pending: PlannedArtifact[] = [];
    for (const artifact of plan.artifacts) {
      const existing = await storage.caplets.get(artifact.id);
      if (!existing) {
        pending.push(artifact);
        continue;
      }
      if (existing.currentRevision.sourceContentHash !== artifact.installedHash) {
        throw new CapletsError(
          "CONFIG_EXISTS",
          `Caplet Record ${artifact.id} conflicts with the tracked filesystem artifact.`,
        );
      }
      const installation = await storage.installations.getActive(artifact.id);
      if (!installation || installation.sourceIdentity !== artifact.sourceIdentity) {
        throw new CapletsError(
          "CONFIG_EXISTS",
          `Caplet installation ${artifact.id} conflicts with the tracked filesystem artifact.`,
        );
      }
    }

    const operator = { clientId: options.operatorClientId, role: "operator" as const };
    await storage.backendAuth.assertLegacyBundlesImportable(plan.backendAuth.bundles);
    await storage.vaultValues.assertLegacyValuesImportable(plan.vault.values);
    await storage.remoteSecurity.assertLegacySnapshotImportable(plan.remoteSecurity);
    await storage.setupState.assertLegacySnapshotImportable(plan.setup);
    await storage.operatorActivity.assertLegacyEntriesImportable(plan.operatorActivity);
    await storage.vaultGrants.assertLegacyGrantsImportable(
      await vaultGrantsAvailableBeforeImport(storage, plan.vaultGrants),
      operator,
    );

    if (options.dryRun) {
      return reportForPlan("verified", null, plan);
    }

    const pendingBundles = pending.map(
      (artifact): ImportCapletBundleInput => ({
        id: artifact.id,
        operator,
        files: artifact.files,
        sourceContentHash: artifact.installedHash,
        installation: {
          sourceKind: artifact.sourceKind,
          sourceIdentity: artifact.sourceIdentity,
        },
      }),
    );
    await storage.caplets.prepareBundleAssetsForImport(pendingBundles);
    const transactionStorage = storage;

    if (storage.database.dialect === "sqlite") {
      await storage.database.db.transaction(
        async (transaction) =>
          await importAndVerifyLegacySqlite(
            transactionStorage,
            transaction,
            pendingBundles,
            plan,
            operator,
          ),
      );
    } else {
      await storage.database.db.transaction(
        async (transaction) =>
          await importAndVerifyLegacyPostgres(
            transactionStorage,
            transaction,
            pendingBundles,
            plan,
            operator,
          ),
      );
    }

    moveLegacyArtifactsToBackup(plan.backupMoves);
    return reportForPlan("migrated", backupPath, plan);
  } finally {
    await storage?.close();
    closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

async function importAndVerifyLegacySqlite(
  storage: HostStorage,
  transaction: SqliteHostTransaction,
  pendingBundles: ImportCapletBundleInput[],
  plan: PlannedLegacyState,
  operator: OperatorPrincipal,
): Promise<void> {
  const adapter = { dialect: "sqlite", db: transaction } as const;
  await storage.caplets.importBundlesInTransaction(pendingBundles, adapter);
  await storage.backendAuth.importLegacyBundlesInTransaction(plan.backendAuth.bundles, adapter);
  await storage.vaultValues.importLegacyValuesInTransaction(plan.vault.values, adapter);
  await storage.vaultGrants.importLegacyGrantsInTransaction(plan.vaultGrants, operator, adapter);
  await storage.remoteSecurity.importLegacySnapshotInTransaction(plan.remoteSecurity, adapter);
  await storage.setupState.importLegacySnapshotInTransaction(plan.setup, adapter);
  await storage.operatorActivity.importLegacyEntriesInTransaction(plan.operatorActivity, adapter);

  await verifyImportedArtifactsSqlite(storage, plan.artifacts, adapter);
  await storage.backendAuth.verifyLegacyBundlesInTransaction(plan.backendAuth.bundles, adapter);
  await storage.vaultValues.verifyLegacyValuesInTransaction(plan.vault.values, adapter);
  await storage.vaultGrants.verifyLegacyGrantsInTransaction(plan.vaultGrants, operator, adapter);
  await storage.remoteSecurity.verifyLegacySnapshotInTransaction(plan.remoteSecurity, adapter);
  await storage.setupState.verifyLegacySnapshotInTransaction(plan.setup, adapter);
  await storage.operatorActivity.verifyLegacyEntriesInTransaction(plan.operatorActivity, adapter);
}

async function importAndVerifyLegacyPostgres(
  storage: HostStorage,
  transaction: PostgresHostTransaction,
  pendingBundles: ImportCapletBundleInput[],
  plan: PlannedLegacyState,
  operator: OperatorPrincipal,
): Promise<void> {
  const adapter = { dialect: "postgres", db: transaction } as const;
  await storage.caplets.importBundlesInTransaction(pendingBundles, adapter);
  await storage.backendAuth.importLegacyBundlesInTransaction(plan.backendAuth.bundles, adapter);
  await storage.vaultValues.importLegacyValuesInTransaction(plan.vault.values, adapter);
  await storage.vaultGrants.importLegacyGrantsInTransaction(plan.vaultGrants, operator, adapter);
  await storage.remoteSecurity.importLegacySnapshotInTransaction(plan.remoteSecurity, adapter);
  await storage.setupState.importLegacySnapshotInTransaction(plan.setup, adapter);
  await storage.operatorActivity.importLegacyEntriesInTransaction(plan.operatorActivity, adapter);

  await verifyImportedArtifactsPostgres(storage, plan.artifacts, adapter);
  await storage.backendAuth.verifyLegacyBundlesInTransaction(plan.backendAuth.bundles, adapter);
  await storage.vaultValues.verifyLegacyValuesInTransaction(plan.vault.values, adapter);
  await storage.vaultGrants.verifyLegacyGrantsInTransaction(plan.vaultGrants, operator, adapter);
  await storage.remoteSecurity.verifyLegacySnapshotInTransaction(plan.remoteSecurity, adapter);
  await storage.setupState.verifyLegacySnapshotInTransaction(plan.setup, adapter);
  await storage.operatorActivity.verifyLegacyEntriesInTransaction(plan.operatorActivity, adapter);
}

function planLegacyState(options: LegacyMigrationOptions, backupPath: string): PlannedLegacyState {
  const backupMoves: BackupMove[] = [];
  const capletsBackupRoot = join(backupPath, "caplets");
  const capletsBackupLockfile = join(backupPath, "caplets.lock.json");
  const capletsFromBackup = !existsSync(options.lockfilePath) && existsSync(capletsBackupLockfile);
  const artifacts = planArtifacts(
    capletsFromBackup ? capletsBackupRoot : options.capletsRoot,
    capletsFromBackup ? capletsBackupLockfile : options.lockfilePath,
  );
  if (!capletsFromBackup) {
    for (const artifact of artifacts) {
      backupMoves.push({
        source: artifact.destination,
        target: join(
          capletsBackupRoot,
          portableRelative(resolve(options.capletsRoot), artifact.destination),
        ),
      });
    }
    backupMoves.push({ source: options.lockfilePath, target: capletsBackupLockfile });
  }

  const backendAuth = options.backendAuthDir
    ? snapshotWithBackupFallback(
        () => readLegacyOAuthTokenBundleSnapshot(options.backendAuthDir as string),
        () => readLegacyOAuthTokenBundleSnapshot(join(backupPath, "backend-auth")),
        (snapshot) => snapshot.sourcePaths.length === 0,
      )
    : { snapshot: EMPTY_BACKEND_AUTH, fromBackup: false };
  if (!backendAuth.fromBackup && options.backendAuthDir) {
    appendFileBackupMoves(
      backupMoves,
      backendAuth.snapshot.sourcePaths,
      options.backendAuthDir,
      join(backupPath, "backend-auth"),
    );
  }

  const vault = options.legacyVaultRoot
    ? snapshotWithBackupFallback(
        () =>
          new FileVaultStore({
            root: options.legacyVaultRoot,
            env: options.legacyVaultEnv,
          }).exportForMigration(),
        () =>
          new FileVaultStore({
            root: join(backupPath, "vault"),
            env: options.legacyVaultEnv,
          }).exportForMigration(),
        (snapshot) => snapshot.sourcePaths.length === 0,
      )
    : { snapshot: EMPTY_VAULT, fromBackup: false };
  if (!vault.fromBackup && options.legacyVaultRoot) {
    appendFileBackupMoves(
      backupMoves,
      vault.snapshot.sourcePaths,
      options.legacyVaultRoot,
      join(backupPath, "vault"),
      resolve(options.targetVaultRoot ?? "") === resolve(options.legacyVaultRoot)
        ? resolve(join(options.legacyVaultRoot, "vault-key"))
        : undefined,
    );
  }
  const vaultGrants = plannedVaultGrants(vault.snapshot, artifacts);

  const remoteSecurity = options.remoteSecurityDir
    ? snapshotWithBackupFallback(
        () =>
          new RemoteServerCredentialStore({
            dir: options.remoteSecurityDir as string,
          }).exportForMigration(),
        () =>
          new RemoteServerCredentialStore({
            dir: join(backupPath, "remote-security"),
          }).exportForMigration(),
        (snapshot) => snapshot.sourcePaths.length === 0,
      )
    : { snapshot: { state: EMPTY_REMOTE_SECURITY, sourcePaths: [] }, fromBackup: false };
  if (!remoteSecurity.fromBackup && options.remoteSecurityDir) {
    appendFileBackupMoves(
      backupMoves,
      remoteSecurity.snapshot.sourcePaths,
      options.remoteSecurityDir,
      join(backupPath, "remote-security"),
    );
  }

  const setup = options.setupStateDir
    ? snapshotWithBackupFallback(
        () =>
          new LocalSetupStore({ baseDir: options.setupStateDir as string }).exportForMigration(),
        () =>
          new LocalSetupStore({ baseDir: join(backupPath, "setup-state") }).exportForMigration(),
        (snapshot) => snapshot.sourcePaths.length === 0,
      )
    : { snapshot: EMPTY_SETUP, fromBackup: false };
  if (!setup.fromBackup && options.setupStateDir) {
    appendFileBackupMoves(
      backupMoves,
      setup.snapshot.sourcePaths,
      options.setupStateDir,
      join(backupPath, "setup-state"),
    );
  }

  const operatorActivity = options.operatorActivityDir
    ? snapshotWithBackupFallback(
        () =>
          new DashboardActivityLog({
            dir: options.operatorActivityDir as string,
          }).exportForMigration(),
        () =>
          new DashboardActivityLog({
            dir: join(backupPath, "operator-activity"),
          }).exportForMigration(),
        (snapshot) => snapshot.sourcePaths.length === 0,
      )
    : { snapshot: { entries: [], sourcePaths: [] }, fromBackup: false };
  if (!operatorActivity.fromBackup && options.operatorActivityDir) {
    appendFileBackupMoves(
      backupMoves,
      operatorActivity.snapshot.sourcePaths,
      options.operatorActivityDir,
      join(backupPath, "operator-activity"),
    );
  }

  return {
    artifacts,
    backendAuth: backendAuth.snapshot,
    vault: vault.snapshot,
    vaultGrants,
    remoteSecurity: remoteSecurity.snapshot.state,
    setup: setup.snapshot,
    operatorActivity: operatorActivity.snapshot.entries,
    backupMoves,
    includeDomainReport: Boolean(
      options.backendAuthDir ||
      options.legacyVaultRoot ||
      options.remoteSecurityDir ||
      options.setupStateDir ||
      options.operatorActivityDir,
    ),
  };
}

function snapshotWithBackupFallback<T>(
  source: () => T,
  backup: () => T,
  empty: (snapshot: T) => boolean,
): { snapshot: T; fromBackup: boolean } {
  const sourceSnapshot = source();
  if (!empty(sourceSnapshot)) return { snapshot: sourceSnapshot, fromBackup: false };
  const backupSnapshot = backup();
  return empty(backupSnapshot)
    ? { snapshot: sourceSnapshot, fromBackup: false }
    : { snapshot: backupSnapshot, fromBackup: true };
}

function appendFileBackupMoves(
  moves: BackupMove[],
  sourcePaths: string[],
  sourceRoot: string,
  backupRoot: string,
  preservedSource?: string,
): void {
  const resolvedRoot = resolve(sourceRoot);
  for (const source of sourcePaths) {
    const resolvedSource = resolve(source);
    moves.push({
      source,
      target: join(backupRoot, portableRelative(resolvedRoot, resolvedSource)),
      ...(preservedSource === resolvedSource ? { preserveSource: true } : {}),
    });
  }
}

function plannedVaultGrants(
  snapshot: LegacyVaultMigrationSnapshot,
  artifacts: PlannedArtifact[],
): LegacyVaultGrantImport[] {
  const trackedGlobalIds = new Set(artifacts.map((artifact) => artifact.id));
  const identities = new Set<string>();
  return snapshot.grants.map((grant) => {
    const storedRecord =
      grant.origin.kind === "global-file" && trackedGlobalIds.has(grant.capletId);
    const originKind = storedRecord ? "stored-record" : grant.origin.kind;
    const originPath = storedRecord ? null : grant.origin.path;
    const identity = JSON.stringify([grant.capletId, originKind, originPath, grant.referenceName]);
    if (identities.has(identity)) {
      throw new CapletsError("CONFIG_INVALID", "Legacy Vault grants contain duplicate subjects.");
    }
    identities.add(identity);
    return {
      capletId: grant.capletId,
      vaultKey: grant.storedKey,
      referenceName: grant.referenceName,
      originKind,
      originPath,
      createdAt: grant.createdAt,
    };
  });
}

async function vaultGrantsAvailableBeforeImport(
  storage: HostStorage,
  grants: LegacyVaultGrantImport[],
): Promise<LegacyVaultGrantImport[]> {
  // Stored-record grants for records in this migration become importable only after those
  // records are inserted in the transaction.
  const available: LegacyVaultGrantImport[] = [];
  for (const grant of grants) {
    if (grant.originKind !== "stored-record" || (await storage.caplets.get(grant.capletId))) {
      available.push(grant);
    }
  }
  return available;
}

function reportForPlan(
  status: LegacyMigrationReport["status"],
  backupPath: string | null,
  plan: PlannedLegacyState,
): LegacyMigrationReport {
  const report: LegacyMigrationReport = {
    status,
    records: plan.artifacts.length,
    installations: plan.artifacts.length,
    backupPath,
  };
  if (plan.includeDomainReport) {
    report.domains = {
      backendAuthTokenBundles: plan.backendAuth.bundles.length,
      vaultValues: plan.vault.values.length,
      vaultGrants: plan.vaultGrants.length,
      remotePairingCodes: plan.remoteSecurity.pairingCodes.length,
      remoteClients: plan.remoteSecurity.clients.length,
      remotePendingLogins: plan.remoteSecurity.pendingLogins.length,
      setupApprovals: plan.setup.approvals.length,
      setupAttempts: plan.setup.attempts.length,
      operatorActivityEntries: plan.operatorActivity.length,
      dashboardSessions: "not_applicable_no_legacy_format",
      projectBindings: "not_applicable_no_legacy_format",
    };
  }
  return report;
}

function planArtifacts(capletsRoot: string, lockfilePath: string): PlannedArtifact[] {
  const lockfile = readCapletsLockfile(lockfilePath);
  return lockfile.entries.map((entry) => {
    const destination = validateLockfileDestination(capletsRoot, entry.destination);
    if (!existsSync(destination)) {
      throw new CapletsError(
        "CONFIG_NOT_FOUND",
        `Tracked Caplet ${entry.id} is missing at ${destination}. Restore it or remove its stale entry from ${lockfilePath} before migration.`,
      );
    }
    const stats = lstatSync(destination);
    if (
      (entry.kind === "file" && !stats.isFile()) ||
      (entry.kind === "directory" && !stats.isDirectory())
    ) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Tracked Caplet ${entry.id} does not match lockfile kind ${entry.kind}.`,
      );
    }
    const installedHash = hashInstalledArtifact(destination);
    if (installedHash !== entry.installedHash) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Tracked Caplet ${entry.id} differs from its lockfile; restore or update it before migration.`,
      );
    }
    return {
      id: entry.id,
      destination,
      installedHash,
      sourceKind: entry.source.type,
      sourceIdentity: JSON.stringify(entry.source),
      files:
        entry.kind === "file"
          ? [fileInput(destination, "CAPLET.md")]
          : collectBundleFiles(destination),
    };
  });
}

function collectBundleFiles(root: string): PlannedArtifact["files"] {
  if (!existsSync(join(root, "CAPLET.md"))) {
    throw new CapletsError("CONFIG_INVALID", `Tracked Caplet bundle ${root} has no CAPLET.md.`);
  }
  const files: PlannedArtifact["files"] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        throw new CapletsError(
          "CONFIG_INVALID",
          `Tracked Caplet bundle ${root} contains an unsupported symbolic link.`,
        );
      }
      if (stats.isDirectory()) visit(path);
      else if (stats.isFile()) files.push(fileInput(path, portableRelative(root, path)));
    }
  };
  visit(root);
  return files;
}

function fileInput(path: string, bundlePath: string): PlannedArtifact["files"][number] {
  const stats = lstatSync(path);
  return {
    path: bundlePath,
    content: readFileSync(path),
    executable: (stats.mode & 0o111) !== 0,
  };
}

function portableRelative(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  if (value === ".." || value.startsWith("../")) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Legacy migration source escaped its configured root.",
    );
  }
  return value;
}

function hashInstalledArtifact(path: string): string {
  const hash = createHash("sha256");
  hashPath(path, "", hash);
  return `sha256:${hash.digest("hex")}`;
}

function hashPath(path: string, relativePath: string, hash: Hash): void {
  const stats = lstatSync(path);
  const mode = stats.mode & 0o111 ? "executable" : "plain";
  if (stats.isDirectory()) {
    hash.update(`dir\0${relativePath}\0`);
    for (const entry of readdirSync(path).sort()) {
      hashPath(join(path, entry), relativePath ? `${relativePath}/${entry}` : entry, hash);
    }
    return;
  }
  if (stats.isSymbolicLink()) {
    hash.update(`symlink\0${relativePath}\0${readlinkSync(path)}\0`);
    return;
  }
  hash.update(`file\0${relativePath}\0${mode}\0`);
  hash.update(readFileSync(path));
  hash.update("\0");
}

async function verifyImportedArtifactsSqlite(
  storage: HostStorage,
  artifacts: PlannedArtifact[],
  transaction: Extract<HostDatabaseTransaction, { dialect: "sqlite" }>,
): Promise<void> {
  for (const artifact of artifacts) {
    const record = await storage.caplets.getInTransaction(artifact.id, transaction);
    if (record?.currentRevision.sourceContentHash !== artifact.installedHash) {
      throw new CapletsError(
        "INTERNAL_ERROR",
        `Caplet Record ${artifact.id} failed post-migration verification.`,
      );
    }
    const installation = await storage.installations.getActiveInTransaction(
      artifact.id,
      transaction,
    );
    if (!installation || installation.sourceIdentity !== artifact.sourceIdentity) {
      throw new CapletsError(
        "INTERNAL_ERROR",
        `Caplet installation ${artifact.id} failed post-migration verification.`,
      );
    }
  }
}

async function verifyImportedArtifactsPostgres(
  storage: HostStorage,
  artifacts: PlannedArtifact[],
  transaction: Extract<HostDatabaseTransaction, { dialect: "postgres" }>,
): Promise<void> {
  for (const artifact of artifacts) {
    const record = await storage.caplets.getInTransaction(artifact.id, transaction);
    if (record?.currentRevision.sourceContentHash !== artifact.installedHash) {
      throw new CapletsError(
        "INTERNAL_ERROR",
        `Caplet Record ${artifact.id} failed post-migration verification.`,
      );
    }
    const installation = await storage.installations.getActiveInTransaction(
      artifact.id,
      transaction,
    );
    if (!installation || installation.sourceIdentity !== artifact.sourceIdentity) {
      throw new CapletsError(
        "INTERNAL_ERROR",
        `Caplet installation ${artifact.id} failed post-migration verification.`,
      );
    }
  }
}

function moveLegacyArtifactsToBackup(moves: BackupMove[]): void {
  const uniqueSources = new Set<string>();
  const uniqueTargets = new Set<string>();
  for (const move of moves) {
    const source = resolve(move.source);
    const target = resolve(move.target);
    if (!existsSync(source)) {
      throw new CapletsError(
        "CONFIG_NOT_FOUND",
        `Legacy migration source ${basename(source)} disappeared before backup.`,
      );
    }
    if (uniqueSources.has(source) || uniqueTargets.has(target) || existsSync(target)) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Legacy migration backup target for ${basename(source)} already exists.`,
      );
    }
    uniqueSources.add(source);
    uniqueTargets.add(target);
  }

  const completed: BackupMove[] = [];
  try {
    for (const move of moves) {
      mkdirSync(dirname(move.target), { recursive: true, mode: 0o700 });
      if (move.preserveSource) {
        copyFileSync(move.source, move.target, fsConstants.COPYFILE_EXCL);
      } else {
        renameSync(move.source, move.target);
      }
      completed.push(move);
    }
  } catch (error) {
    for (const entry of completed.reverse()) {
      if (!existsSync(entry.target)) continue;
      if (entry.preserveSource) {
        rmSync(entry.target, { force: true });
      } else {
        mkdirSync(dirname(entry.source), { recursive: true, mode: 0o700 });
        renameSync(entry.target, entry.source);
      }
    }
    throw error;
  }
}

function timestampForPath(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}
