import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  linkSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  discoverCapletFiles,
  loadCapletFilesFromMap,
  loadCapletFilesWithPaths,
  validateCapletFile,
} from "../caplet-files";
import type { CapletFileConfig } from "../caplet-files";
import {
  createMemoryDeclaredInputReader,
  createRuntimeFingerprintSnapshot,
  type RuntimeFingerprintSnapshot,
} from "../caplet-source";
import { parseConfig } from "../config-runtime";
import { resolveProjectCapletsRoot } from "../config";
import { SERVER_ID_PATTERN } from "../config/validation";
import { CapletsError, toSafeError } from "../errors";
import type { CatalogIndexingResult } from "../catalog-indexing/payload";
import { catalogIndexingPayloadForLockEntry } from "../catalog-indexing/eligibility";
import {
  catalogAuthRequiredFromFrontmatter,
  catalogIconFromFrontmatter,
  catalogMutatesExternalStateFromFrontmatter,
  catalogProjectBindingRequiredFromFrontmatter,
  catalogSetupRequiredFromFrontmatter,
  catalogStringArrayFromFrontmatter,
  catalogStringFromFrontmatter,
  catalogUsesLocalControlFromFrontmatter,
  catalogWorkflowSummaryFromFrontmatter,
  catalogWorkflowSummaryForBackendFamily,
  createCatalogEntry,
  normalizeCatalogSourceIdentity,
  type CatalogEntry,
  type CatalogEntryChild,
  type CatalogWorkflowSummary,
} from "../catalog";
import {
  replaceCapletsLockfileTemporary,
  parseCapletsLockfile,
  readCapletsLockfile,
  validateLockfileDestination,
  writeCapletsLockfile,
  writeCapletsLockfileAtomically,
  writeCapletsLockfileTemporary,
  type CapletsLockEntry,
  type CapletsLockRuntimeFingerprint,
  type CapletsLockSource,
  type CapletsLockfile,
} from "./lockfile";

export type InstallableCaplet = {
  id: string;
  source: string;
  destination: string;
  kind: "file" | "directory";
  hash?: string | undefined;
  status?: "installed" | "restored" | "updated" | "content_updated" | "noop" | undefined;
  lockfile?: string | undefined;
  catalogIndexing?: CatalogIndexingResult | undefined;
  vaultSetup?: unknown;
};

type InstallPlan = InstallableCaplet & {
  sourcePath: string;
  sourceBoundary: string;
};

type LockedSourceResolution = {
  sourcePath: string;
  repoRoot: string;
  resolvedRevision?: string | undefined;
  cleanup: () => void;
};

export type CapletTransactionPhase =
  | "prepared"
  | "staged"
  | "backup_created"
  | "destination_replaced"
  | "lock_temporary_written"
  | "lock_replaced";

export type InstallTransactionDependencies = {
  writeLockfileTemporary?: (path: string, lockfile: CapletsLockfile, temporaryPath: string) => void;
  replaceLockfileTemporary?: (path: string, temporaryPath: string) => void;
  cleanupTransaction?: () => void;
  onTransactionPhase?: (phase: CapletTransactionPhase) => "interrupt" | void;
};

type CapletArtifactTransactionJournal = {
  version: 1;
  entryId: string;
  destination: string;
  hadDestination: boolean;
  beforeEntry: CapletsLockEntry;
  afterEntry: CapletsLockEntry;
  beforeHash?: string | undefined;
  afterHash: string;
  phase: CapletTransactionPhase;
};

type CandidateArtifact = {
  plan: InstallPlan;
  transactionPaths: CapletTransactionPaths;
  stagedPath: string;
  artifactHash: string;
  runtimeSnapshot: RuntimeFingerprintSnapshot;
  risk: CapletsLockEntry["risk"];
};

type InstallCapletsOptions = {
  capletIds?: string[];
  destinationRoot?: string;
  force?: boolean;
  lockfilePath?: string | undefined;
  now?: Date | undefined;
};

export function installCaplets(
  repo: string,
  options: InstallCapletsOptions = {},
): { installed: InstallableCaplet[] } {
  return options.lockfilePath
    ? withLockfileTransaction(options.lockfilePath, () => installCapletsUnlocked(repo, options))
    : installCapletsUnlocked(repo, options);
}

function installCapletsUnlocked(
  repo: string,
  options: InstallCapletsOptions = {},
): { installed: InstallableCaplet[] } {
  const source = resolveInstallSource(repo);
  try {
    const sourceRoot = join(source.repoRoot, "caplets");
    if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
      throw new CapletsError("CONFIG_NOT_FOUND", `No caplets directory found at ${sourceRoot}`);
    }

    const selectedIds = new Set(options.capletIds ?? []);
    const destinationRoot = options.destinationRoot ?? resolveProjectCapletsRoot();
    const available =
      selectedIds.size === 0
        ? discoverCapletFiles(sourceRoot)
        : discoverSelectedCapletFiles(sourceRoot, selectedIds);
    const selected = available.filter(
      (caplet) => selectedIds.size === 0 || selectedIds.has(caplet.id),
    );
    const missing = [...selectedIds].filter((id) => !available.some((caplet) => caplet.id === id));
    if (missing.length > 0) {
      const childGuidance = selectedChildInstallGuidance(sourceRoot, missing);
      throw new CapletsError(
        "CONFIG_NOT_FOUND",
        childGuidance ?? `Caplet ${missing.join(", ")} not found in ${sourceRoot}`,
      );
    }
    if (selected.length === 0) {
      throw new CapletsError("CONFIG_NOT_FOUND", `No Caplets found in ${sourceRoot}`);
    }
    rejectDuplicateSourceIds(selected);

    for (const caplet of selected) {
      validateCapletFile(caplet.path);
    }
    const plans = preflightInstallCaplets(selected, {
      destinationRoot,
      force: Boolean(options.force),
      repoRoot: source.repoRoot,
      sourceId: source.id,
    });
    const now = options.now ?? new Date();
    const installed: InstallableCaplet[] = [];
    for (const plan of plans) {
      const caplet = installOneCaplet(plan, { force: Boolean(options.force) });
      const installedWithHash = {
        ...caplet,
        hash: hashInstalledArtifact(caplet.destination),
        status: "installed" as const,
        ...(options.lockfilePath ? { lockfile: options.lockfilePath } : {}),
      };
      installed.push(options.lockfilePath ? installedWithHash : caplet);
      if (options.lockfilePath) {
        updateLockfileAfterInstall(options.lockfilePath, [plan], [installedWithHash], {
          source,
          now,
        });
      }
    }
    return { installed };
  } finally {
    source.cleanup();
  }
}

type TransactionLockMetadata = {
  pid: number;
  acquiredAt: string;
  ownerToken: string;
};

function withLockfileTransaction<T>(lockfilePath: string, operation: () => T): T {
  const path = `${lockfilePath}.transaction.lock`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const owner: TransactionLockMetadata = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    ownerToken: randomUUID(),
  };
  const recoveryPath = recoverDeadTransactionLock(path, owner);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(owner)}\n`);
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      rmSync(path, { force: true });
    }
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Another Caplets install, restore, or update holds ${path}; if no operation is running, remove the lock and retry`,
      toSafeError(error),
    );
  } finally {
    if (recoveryPath) rmSync(recoveryPath, { force: true });
  }
  try {
    return operation();
  } finally {
    closeSync(descriptor);
    const currentOwner = readTransactionLockMetadata(path);
    if (currentOwner?.ownerToken === owner.ownerToken) rmSync(path, { force: true });
  }
}

function recoverDeadTransactionLock(
  path: string,
  recoveringOwner: TransactionLockMetadata,
): string | undefined {
  if (!existsSync(path)) return undefined;
  const existingOwner = readTransactionLockMetadata(path);
  if (!existingOwner || !isDeadProcess(existingOwner.pid)) return undefined;

  const recoveryPath = `${path}.recovery`;
  if (existsSync(recoveryPath)) {
    const recoveryOwner = readTransactionLockMetadata(recoveryPath);
    if (!recoveryOwner || !isDeadProcess(recoveryOwner.pid)) return undefined;
    rmSync(recoveryPath, { force: true });
  }

  try {
    linkSync(path, recoveryPath);
  } catch {
    return undefined;
  }
  try {
    const claimedOwner = readTransactionLockMetadata(recoveryPath);
    if (!claimedOwner || !isDeadProcess(claimedOwner.pid)) return undefined;
    writeFileSync(recoveryPath, `${JSON.stringify(recoveringOwner)}\n`, { mode: 0o600 });
    const lockStats = lstatSync(path);
    const recoveryStats = lstatSync(recoveryPath);
    if (lockStats.dev !== recoveryStats.dev || lockStats.ino !== recoveryStats.ino) {
      return undefined;
    }
    rmSync(path);
    return recoveryPath;
  } finally {
    if (existsSync(path)) rmSync(recoveryPath, { force: true });
  }
}

function readTransactionLockMetadata(path: string): TransactionLockMetadata | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      !isRecord(value) ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      typeof value.acquiredAt !== "string"
    ) {
      return undefined;
    }
    return {
      pid: value.pid as number,
      acquiredAt: value.acquiredAt,
      ownerToken: typeof value.ownerToken === "string" ? value.ownerToken : "",
    };
  } catch {
    return undefined;
  }
}

function isDeadProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

type RestoreCapletsOptions = {
  destinationRoot?: string;
  lockfilePath: string;
  force?: boolean;
  capletIds?: string[] | undefined;
  now?: Date | undefined;
};

export function restoreCapletsFromLockfile(
  options: RestoreCapletsOptions,
  dependencies: InstallTransactionDependencies = {},
): { installed: InstallableCaplet[] } {
  return withLockfileTransaction(options.lockfilePath, () =>
    restoreCapletsFromLockfileUnlocked(options, dependencies),
  );
}

function restoreCapletsFromLockfileUnlocked(
  options: RestoreCapletsOptions,
  dependencies: InstallTransactionDependencies,
): { installed: InstallableCaplet[] } {
  const destinationRoot = options.destinationRoot ?? resolveProjectCapletsRoot();
  recoverInterruptedCapletTransactions({
    lockfilePath: options.lockfilePath,
    destinationRoot,
    dependencies,
  });
  const lockfile = readCapletsLockfile(options.lockfilePath);
  const entries = selectedLockEntries(lockfile, options.capletIds, options.lockfilePath);
  const nextEntries = new Map(lockfile.entries.map((entry) => [entry.id, entry]));
  const results: InstallableCaplet[] = [];
  for (const entry of entries) {
    const destination = validateLockfileDestination(destinationRoot, entry.destination);
    const existing = lstatIfExists(destination);
    const currentHash = existing ? hashInstalledArtifact(destination) : undefined;
    if (currentHash !== undefined) {
      if (currentHash !== entry.installedHash && !options.force) {
        throw new CapletsError(
          "CONFIG_EXISTS",
          `Caplet ${entry.id} has local modifications at ${destination}; pass --force to replace it`,
        );
      }
    }

    const lockedSource = resolveLockedSource(entry.source);
    let candidate: CandidateArtifact | undefined;
    try {
      const plan = lockedInstallPlan(entry, destination, lockedSource);
      candidate = stageAndValidateCandidate(plan, options.lockfilePath);
      const runtimeFingerprint = runtimeFingerprintForPersistence(candidate.runtimeSnapshot);
      const prospective = {
        ...entry,
        installedHash: candidate.artifactHash,
        risk: candidate.risk,
        ...(runtimeFingerprint ? { runtimeFingerprint } : { runtimeFingerprint: undefined }),
      };
      const lockChanged = !sameLockEntryExceptUpdatedAt(entry, prospective);
      const afterEntry: CapletsLockEntry = {
        ...prospective,
        updatedAt: lockChanged ? (options.now ?? new Date()).toISOString() : entry.updatedAt,
      };
      const status =
        currentHash === entry.installedHash && candidate.artifactHash === entry.installedHash
          ? "noop"
          : "restored";
      if (status === "noop" && !lockChanged) {
        removeInstallPath(candidate.stagedPath, `staged Caplet ${entry.id}`, true);
      } else {
        const updatedEntries = new Map(nextEntries);
        updatedEntries.set(entry.id, afterEntry);
        const committingCandidate = candidate;
        candidate = undefined;
        commitStagedCapletAndLock({
          lockfilePath: options.lockfilePath,
          currentLockfile: { version: 1, entries: [...updatedEntries.values()] },
          beforeEntry: entry,
          afterEntry,
          candidate: committingCandidate,
          replaceDestination: status !== "noop",
          dependencies,
        });
        nextEntries.set(entry.id, afterEntry);
        candidate = committingCandidate;
      }
      results.push({
        id: entry.id,
        source: lockSourceDisplay(entry.source),
        destination,
        kind: entry.kind,
        hash: candidate.artifactHash,
        status,
        lockfile: options.lockfilePath,
      });
      candidate = undefined;
    } finally {
      if (candidate) {
        removeInstallPath(candidate.stagedPath, `staged Caplet ${entry.id}`, true);
      }
      lockedSource.cleanup();
    }
  }
  return { installed: results };
}

type UpdateCapletsOptions = {
  destinationRoot?: string;
  lockfilePath: string;
  force?: boolean;
  allowRiskIncrease?: boolean;
  capletIds?: string[] | undefined;
  now?: Date | undefined;
};

export function updateCapletsFromLockfile(
  options: UpdateCapletsOptions,
  dependencies: InstallTransactionDependencies = {},
): { installed: InstallableCaplet[] } {
  return withLockfileTransaction(options.lockfilePath, () =>
    updateCapletsFromLockfileUnlocked(options, dependencies),
  );
}

function updateCapletsFromLockfileUnlocked(
  options: UpdateCapletsOptions,
  dependencies: InstallTransactionDependencies,
): { installed: InstallableCaplet[] } {
  const destinationRoot = options.destinationRoot ?? resolveProjectCapletsRoot();
  recoverInterruptedCapletTransactions({
    lockfilePath: options.lockfilePath,
    destinationRoot,
    dependencies,
  });
  const lockfile = readCapletsLockfile(options.lockfilePath);
  const entries = selectedLockEntries(lockfile, options.capletIds, options.lockfilePath);
  const allowRiskIncrease = options.allowRiskIncrease ?? options.force ?? false;
  const nextEntries = new Map(lockfile.entries.map((entry) => [entry.id, entry]));
  const results: InstallableCaplet[] = [];
  for (const entry of entries) {
    const destination = validateLockfileDestination(destinationRoot, entry.destination);
    const existing = lstatIfExists(destination);
    const currentHash = existing ? hashInstalledArtifact(destination) : undefined;
    if (currentHash !== undefined) {
      if (currentHash !== entry.installedHash && !options.force) {
        throw new CapletsError(
          "CONFIG_EXISTS",
          `Caplet ${entry.id} has local modifications at ${destination}; pass --force to update it`,
        );
      }
    }

    const lockedSource = resolveLockedSource(entry.source, { useResolvedRevision: false });
    let candidate: CandidateArtifact | undefined;
    try {
      if (!existsSync(lockedSource.sourcePath)) {
        throw new CapletsError("CONFIG_NOT_FOUND", `Locked source for ${entry.id} is unavailable`);
      }
      const nextSource = refreshedLockSource(entry.source, lockedSource);
      const plan = lockedInstallPlan(entry, destination, lockedSource);
      candidate = stageAndValidateCandidate(plan, options.lockfilePath);
      const runtimeFingerprint = runtimeFingerprintForPersistence(candidate.runtimeSnapshot);
      const prospective = {
        ...entry,
        source: nextSource,
        installedHash: candidate.artifactHash,
        risk: candidate.risk,
        ...(runtimeFingerprint ? { runtimeFingerprint } : { runtimeFingerprint: undefined }),
      };
      const lockChanged = !sameLockEntryExceptUpdatedAt(entry, prospective);
      const afterEntry: CapletsLockEntry = {
        ...prospective,
        updatedAt: lockChanged ? (options.now ?? new Date()).toISOString() : entry.updatedAt,
      };

      let status: "noop" | "content_updated" | "updated";
      if (currentHash === entry.installedHash && candidate.artifactHash === entry.installedHash) {
        status = "noop";
      } else {
        const installedFingerprint = existing
          ? fingerprintInstalledArtifact(entry, destination).artifactFingerprint
          : undefined;
        status =
          installedFingerprint !== undefined &&
          installedFingerprint === candidate.runtimeSnapshot.artifactFingerprint
            ? "content_updated"
            : "updated";
        if (
          status === "updated" &&
          !allowRiskIncrease &&
          riskIncrease(entry.risk, candidate.risk)
        ) {
          throw new CapletsError(
            "REQUEST_INVALID",
            `Caplet ${entry.id} update changes its risk profile; pass --force to update it`,
          );
        }
      }

      if (status === "noop" && !lockChanged) {
        removeInstallPath(candidate.stagedPath, `staged Caplet ${entry.id}`, true);
      } else {
        const updatedEntries = new Map(nextEntries);
        updatedEntries.set(entry.id, afterEntry);
        const committingCandidate = candidate;
        candidate = undefined;
        commitStagedCapletAndLock({
          lockfilePath: options.lockfilePath,
          currentLockfile: { version: 1, entries: [...updatedEntries.values()] },
          beforeEntry: entry,
          afterEntry,
          candidate: committingCandidate,
          replaceDestination: status !== "noop",
          dependencies,
        });
        nextEntries.set(entry.id, afterEntry);
        candidate = committingCandidate;
      }
      results.push({
        id: entry.id,
        source: lockSourceDisplay(entry.source),
        destination,
        kind: entry.kind,
        hash: candidate.artifactHash,
        status,
        lockfile: options.lockfilePath,
      });
      candidate = undefined;
    } finally {
      if (candidate) {
        removeInstallPath(candidate.stagedPath, `staged Caplet ${entry.id}`, true);
      }
      lockedSource.cleanup();
    }
  }
  return { installed: results };
}
function selectedLockEntries(
  lockfile: CapletsLockfile,
  capletIds: string[] | undefined,
  lockfilePath: string,
): CapletsLockEntry[] {
  const selectedIds = new Set(capletIds ?? []);
  const entries = lockfile.entries.filter(
    (entry) => selectedIds.size === 0 || selectedIds.has(entry.id),
  );
  const missing = [...selectedIds].filter(
    (id) => !lockfile.entries.some((entry) => entry.id === id),
  );
  if (missing.length > 0) {
    throw new CapletsError(
      "CONFIG_NOT_FOUND",
      `Caplet ${missing.join(", ")} not found in lockfile`,
    );
  }
  if (entries.length === 0) {
    throw new CapletsError("CONFIG_NOT_FOUND", `No Caplets found in lockfile ${lockfilePath}`);
  }
  return entries;
}

function lockedInstallPlan(
  entry: CapletsLockEntry,
  destination: string,
  lockedSource: LockedSourceResolution,
): InstallPlan {
  return {
    id: entry.id,
    source: lockSourceDisplay(entry.source),
    sourcePath: lockedSource.sourcePath,
    sourceBoundary: dirname(lockedSource.sourcePath),
    destination,
    kind: entry.kind,
  };
}

function stageAndValidateCandidate(plan: InstallPlan, lockfilePath: string): CandidateArtifact {
  rejectUnsafeInstallParents(plan.destination);
  makeInstallDirectory(dirname(plan.destination));
  const paths = transactionPaths(lockfilePath, plan.destination, plan.id);
  removeInstallPath(paths.stagedPath, `stale staged Caplet ${plan.id}`, true);
  try {
    copyInstallPath(plan, paths.stagedPath);
    const runtimeSnapshot = fingerprintArtifact(plan.id, plan.kind, paths.stagedPath);
    const artifactHash = hashInstalledArtifact(paths.stagedPath);
    return {
      plan,
      transactionPaths: paths,
      stagedPath: paths.stagedPath,
      artifactHash,
      runtimeSnapshot,
      risk: riskSummaryForSourcePath(paths.stagedPath),
    };
  } catch (error) {
    removeInstallPath(paths.stagedPath, `staged Caplet ${plan.id}`, true);
    if (error instanceof CapletsError) throw error;
    throw new CapletsError(
      "CONFIG_INVALID",
      `Could not validate staged Caplet ${plan.id}`,
      toSafeError(error),
    );
  }
}

function fingerprintInstalledArtifact(
  entry: CapletsLockEntry,
  destination: string,
): RuntimeFingerprintSnapshot {
  return fingerprintArtifact(entry.id, entry.kind, destination);
}

function fingerprintArtifact(
  id: string,
  kind: "file" | "directory",
  artifactPath: string,
): RuntimeFingerprintSnapshot {
  const files: Array<{ path: string; content: string }> = [];
  if (kind === "file") {
    files.push({ path: `${id}.md`, content: readFileSync(artifactPath, "utf8") });
  } else {
    collectArtifactFiles(artifactPath, artifactPath, files);
  }
  const configFiles =
    kind === "file"
      ? files
      : files.filter(
          (file) => file.path === "CAPLET.md" || /(?:^|\/)[^/]+\/CAPLET\.md$/u.test(file.path),
        );
  const loaded = loadCapletFilesFromMap({ files: configFiles });
  if (!loaded) {
    throw new CapletsError("CONFIG_INVALID", `Staged Caplet ${id} has no loadable CAPLET.md`);
  }
  const config = parseConfig({ version: 1, ...loaded.config });
  const contents = Object.fromEntries(files.map((file) => [file.path, file.content]));
  return createRuntimeFingerprintSnapshot({
    config,
    provenance: Object.fromEntries(
      Object.entries(loaded.paths).map(([runtimeId, sourcePath]) => [
        runtimeId,
        {
          parentId: loaded.metadata?.[runtimeId]?.parentId ?? id,
          ...(loaded.metadata?.[runtimeId]?.childId
            ? { childId: loaded.metadata[runtimeId]?.childId }
            : {}),
          sourcePath,
        },
      ]),
    ),
    reader: createMemoryDeclaredInputReader(contents),
  });
}

function collectArtifactFiles(
  root: string,
  current: string,
  files: Array<{ path: string; content: string }>,
): void {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      collectArtifactFiles(root, path, files);
    } else if (entry.isFile()) {
      files.push({
        path: relative(root, path).split(sep).join("/"),
        content: readFileSync(path, "utf8"),
      });
    }
  }
}

function runtimeFingerprintForPersistence(
  snapshot: RuntimeFingerprintSnapshot,
): CapletsLockRuntimeFingerprint | undefined {
  return snapshot.valid && snapshot.persistenceEligible
    ? { version: 1, artifactFingerprint: snapshot.artifactFingerprint }
    : undefined;
}

function sameLockEntryExceptUpdatedAt(
  left: CapletsLockEntry,
  right: Omit<CapletsLockEntry, "updatedAt"> & { updatedAt?: string },
): boolean {
  const { updatedAt: _leftUpdatedAt, ...leftComparable } = left;
  const { updatedAt: _rightUpdatedAt, ...rightComparable } = right;
  return JSON.stringify(leftComparable) === JSON.stringify(rightComparable);
}

type CapletTransactionPaths = {
  journalPath: string;
  journalTemporaryPath: string;
  stagedPath: string;
  backupPath: string;
  lockTemporaryPath: string;
};

type CommitStagedCapletInput = {
  lockfilePath: string;
  currentLockfile: CapletsLockfile;
  beforeEntry: CapletsLockEntry;
  afterEntry: CapletsLockEntry;
  candidate: CandidateArtifact;
  replaceDestination: boolean;
  dependencies: InstallTransactionDependencies;
};

function transactionPaths(
  lockfilePath: string,
  destination: string,
  id: string,
): CapletTransactionPaths {
  if (!SERVER_ID_PATTERN.test(id)) {
    throw new CapletsError("CONFIG_INVALID", `Invalid Caplet transaction ID ${id}`);
  }
  const lockName = basename(lockfilePath || "caplets.lock.json");
  const destinationName = basename(destination);
  return {
    journalPath: join(dirname(lockfilePath), `.${lockName}.caplet-txn-${id}.json`),
    journalTemporaryPath: join(dirname(lockfilePath), `.${lockName}.caplet-txn-${id}.json.tmp`),
    stagedPath: join(dirname(destination), `.${destinationName}.caplet-txn-${id}.stage`),
    backupPath: join(dirname(destination), `.${destinationName}.caplet-txn-${id}.backup`),
    lockTemporaryPath: join(dirname(lockfilePath), `.${lockName}.caplet-txn-${id}.lock.tmp`),
  };
}

class CapletTransactionInterruption extends Error {}

function persistTransactionPhase(
  journal: CapletArtifactTransactionJournal,
  paths: CapletTransactionPaths,
  phase: CapletTransactionPhase,
  dependencies: InstallTransactionDependencies,
): void {
  journal.phase = phase;
  writeFileSync(paths.journalTemporaryPath, `${JSON.stringify(journal, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(paths.journalTemporaryPath, paths.journalPath);
  if (dependencies.onTransactionPhase?.(phase) === "interrupt") {
    throw new CapletTransactionInterruption(`Interrupted after ${phase}`);
  }
}

function commitStagedCapletAndLock(input: CommitStagedCapletInput): void {
  const paths = input.candidate.transactionPaths;
  const existing = lstatIfExists(input.candidate.plan.destination);
  const journal: CapletArtifactTransactionJournal = {
    version: 1,
    entryId: input.afterEntry.id,
    destination: input.afterEntry.destination,
    hadDestination: Boolean(existing),
    beforeEntry: input.beforeEntry,
    afterEntry: input.afterEntry,
    ...(existing ? { beforeHash: hashInstalledArtifact(input.candidate.plan.destination) } : {}),
    afterHash: input.candidate.artifactHash,
    phase: "prepared",
  };
  try {
    persistTransactionPhase(journal, paths, "prepared", input.dependencies);
    persistTransactionPhase(journal, paths, "staged", input.dependencies);
    if (input.replaceDestination) {
      removeInstallPath(paths.backupPath, `stale Caplet backup ${input.afterEntry.id}`, true);
      if (existing) {
        renameSync(input.candidate.plan.destination, paths.backupPath);
        persistTransactionPhase(journal, paths, "backup_created", input.dependencies);
      }
      renameSync(paths.stagedPath, input.candidate.plan.destination);
      persistTransactionPhase(journal, paths, "destination_replaced", input.dependencies);
    } else {
      removeInstallPath(paths.stagedPath, `staged Caplet ${input.afterEntry.id}`, true);
    }
    const writeLockfileTemporary =
      input.dependencies.writeLockfileTemporary ?? writeCapletsLockfileTemporary;
    writeLockfileTemporary(input.lockfilePath, input.currentLockfile, paths.lockTemporaryPath);
    persistTransactionPhase(journal, paths, "lock_temporary_written", input.dependencies);
    const replaceLockfileTemporary =
      input.dependencies.replaceLockfileTemporary ?? replaceCapletsLockfileTemporary;
    replaceLockfileTemporary(input.lockfilePath, paths.lockTemporaryPath);
    persistTransactionPhase(journal, paths, "lock_replaced", input.dependencies);
  } catch (error) {
    if (error instanceof CapletTransactionInterruption) throw error;
    try {
      rollbackCapletArtifactTransaction(input, journal, paths);
    } catch (rollbackError) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Could not roll back Caplet transaction ${input.afterEntry.id}`,
        toSafeError(rollbackError),
      );
    }
    if (error instanceof CapletsError) throw error;
    throw new CapletsError(
      "CONFIG_INVALID",
      `Could not commit Caplet transaction ${input.afterEntry.id}`,
      toSafeError(error),
    );
  }
  try {
    if (input.dependencies.cleanupTransaction) {
      input.dependencies.cleanupTransaction();
    } else {
      cleanupTransactionPaths(paths);
    }
  } catch {
    // The new artifact and lock are committed. Leave the journal for recovery to clean up.
  }
}

function rollbackCapletArtifactTransaction(
  input: CommitStagedCapletInput,
  journal: CapletArtifactTransactionJournal,
  paths: CapletTransactionPaths,
): void {
  const destination = input.candidate.plan.destination;
  const destinationHash = existsSync(destination) ? hashInstalledArtifact(destination) : undefined;
  const backupHash = existsSync(paths.backupPath)
    ? hashInstalledArtifact(paths.backupPath)
    : undefined;
  const currentLockfile = readCapletsLockfile(input.lockfilePath);
  const current = currentLockfile.entries.find((entry) => entry.id === journal.entryId);
  const lockIsBefore = sameLockEntry(current, journal.beforeEntry);
  const lockIsAfter = sameLockEntry(current, journal.afterEntry);

  if (
    (backupHash !== undefined &&
      !transactionPhaseMayHaveStarted(journal.phase, "backup_created")) ||
    (destinationHash === journal.afterHash &&
      !transactionPhaseMayHaveStarted(journal.phase, "destination_replaced") &&
      !(
        !journal.hadDestination && transactionPhaseMayHaveStarted(journal.phase, "backup_created")
      )) ||
    (lockIsAfter && !transactionPhaseMayHaveStarted(journal.phase, "lock_replaced"))
  ) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Caplet transaction ${journal.entryId} reached an impossible rollback state`,
    );
  }

  if (lockIsAfter && destinationHash === journal.afterHash) {
    cleanupTransactionPaths(paths);
    return;
  }

  if (backupHash === journal.beforeHash && journal.beforeHash !== undefined) {
    removeInstallPath(destination, `uncommitted Caplet ${journal.entryId}`, true);
    renameSync(paths.backupPath, destination);
  } else if (
    !journal.hadDestination &&
    (destinationHash === undefined || destinationHash === journal.afterHash)
  ) {
    removeInstallPath(destination, `uncommitted Caplet ${journal.entryId}`, true);
  } else if (destinationHash !== journal.beforeHash) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Artifact changed during rollback for ${journal.entryId}`,
    );
  }

  if (lockIsAfter) {
    const entries = currentLockfile.entries.map((entry) =>
      entry.id === journal.entryId ? journal.beforeEntry : entry,
    );
    writeCapletsLockfileAtomically(input.lockfilePath, { version: 1, entries });
  } else if (!lockIsBefore) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Lock entry changed during rollback for ${journal.entryId}`,
    );
  }
  cleanupTransactionPaths(paths);
}

function transactionPhaseMayHaveStarted(
  persisted: CapletTransactionPhase,
  target: CapletTransactionPhase,
): boolean {
  const phases: CapletTransactionPhase[] = [
    "prepared",
    "staged",
    "backup_created",
    "destination_replaced",
    "lock_temporary_written",
    "lock_replaced",
  ];
  return phases.indexOf(persisted) + 1 >= phases.indexOf(target);
}

function recoverInterruptedCapletTransactions(input: {
  lockfilePath: string;
  destinationRoot: string;
  dependencies: InstallTransactionDependencies;
}): void {
  const lockDirectory = dirname(input.lockfilePath);
  if (!existsSync(lockDirectory)) return;
  const prefix = `.${basename(input.lockfilePath)}.caplet-txn-`;
  const journals = readdirSync(lockDirectory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort();
  for (const name of journals) {
    const journalPath = join(lockDirectory, name);
    let journalValue: unknown;
    try {
      journalValue = JSON.parse(readFileSync(journalPath, "utf8"));
    } catch (error) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Invalid Caplet transaction journal ${journalPath}`,
        toSafeError(error),
      );
    }
    const journal = parseTransactionJournal(journalValue, journalPath);
    const destination = validateLockfileDestination(input.destinationRoot, journal.destination);
    const paths = transactionPaths(input.lockfilePath, destination, journal.entryId);
    if (paths.journalPath !== journalPath) {
      throw new CapletsError("CONFIG_INVALID", `Invalid Caplet transaction journal ${journalPath}`);
    }
    const lockfile = readCapletsLockfile(input.lockfilePath);
    const currentEntry = lockfile.entries.find((entry) => entry.id === journal.entryId);
    const destinationHash = existsSync(destination)
      ? hashInstalledArtifact(destination)
      : undefined;
    const backupHash = existsSync(paths.backupPath)
      ? hashInstalledArtifact(paths.backupPath)
      : undefined;
    const lockIsBefore = sameLockEntry(currentEntry, journal.beforeEntry);
    const lockIsAfter = sameLockEntry(currentEntry, journal.afterEntry);

    if (lockIsAfter && destinationHash === journal.afterHash) {
      cleanupTransactionPaths(paths);
      continue;
    }
    if (lockIsBefore && destinationHash === journal.afterHash) {
      const entries = lockfile.entries.map((entry) =>
        entry.id === journal.entryId ? journal.afterEntry : entry,
      );
      writeCapletsLockfileAtomically(
        input.lockfilePath,
        { version: 1, entries },
        paths.lockTemporaryPath,
      );
      cleanupTransactionPaths(paths);
      continue;
    }
    if (lockIsAfter && destinationHash === journal.beforeHash) {
      const entries = lockfile.entries.map((entry) =>
        entry.id === journal.entryId ? journal.beforeEntry : entry,
      );
      writeCapletsLockfileAtomically(
        input.lockfilePath,
        { version: 1, entries },
        paths.lockTemporaryPath,
      );
      cleanupTransactionPaths(paths);
      continue;
    }
    if (
      lockIsBefore &&
      (destinationHash === journal.beforeHash ||
        (!journal.hadDestination && destinationHash === undefined))
    ) {
      cleanupTransactionPaths(paths);
      continue;
    }
    if (
      lockIsBefore &&
      destinationHash === undefined &&
      journal.beforeHash !== undefined &&
      backupHash === journal.beforeHash
    ) {
      renameSync(paths.backupPath, destination);
      cleanupTransactionPaths(paths);
      continue;
    }
    throw new CapletsError(
      "CONFIG_INVALID",
      `Caplet transaction ${journal.entryId} does not match its artifact and lock baselines`,
    );
  }
}

function parseTransactionJournal(value: unknown, path: string): CapletArtifactTransactionJournal {
  if (!isRecord(value) || value.version !== 1) {
    throw new CapletsError("CONFIG_INVALID", `Invalid Caplet transaction journal ${path}`);
  }
  const entryId = typeof value.entryId === "string" ? value.entryId : "";
  const destination = typeof value.destination === "string" ? value.destination : "";
  const phase = value.phase;
  const phases: CapletTransactionPhase[] = [
    "prepared",
    "staged",
    "backup_created",
    "destination_replaced",
    "lock_temporary_written",
    "lock_replaced",
  ];
  if (
    !SERVER_ID_PATTERN.test(entryId) ||
    destination.length === 0 ||
    typeof value.hadDestination !== "boolean" ||
    typeof value.afterHash !== "string" ||
    value.afterHash.length === 0 ||
    !phases.includes(phase as CapletTransactionPhase)
  ) {
    throw new CapletsError("CONFIG_INVALID", `Invalid Caplet transaction journal ${path}`);
  }
  const beforeEntry = parseCapletsLockfile({
    version: 1,
    entries: [value.beforeEntry],
  }).entries[0];
  const afterEntry = parseCapletsLockfile({
    version: 1,
    entries: [value.afterEntry],
  }).entries[0];
  if (
    !beforeEntry ||
    !afterEntry ||
    beforeEntry.id !== entryId ||
    afterEntry.id !== entryId ||
    beforeEntry.destination !== destination ||
    afterEntry.destination !== destination
  ) {
    throw new CapletsError("CONFIG_INVALID", `Invalid Caplet transaction journal ${path}`);
  }
  const beforeHash =
    value.beforeHash === undefined
      ? undefined
      : typeof value.beforeHash === "string"
        ? value.beforeHash
        : null;
  if (
    beforeHash === null ||
    (value.hadDestination && (!beforeHash || beforeHash.length === 0)) ||
    (!value.hadDestination && beforeHash !== undefined)
  ) {
    throw new CapletsError("CONFIG_INVALID", `Invalid Caplet transaction journal ${path}`);
  }
  return {
    version: 1,
    entryId,
    destination,
    hadDestination: value.hadDestination,
    beforeEntry,
    afterEntry,
    ...(beforeHash ? { beforeHash } : {}),
    afterHash: value.afterHash,
    phase: phase as CapletTransactionPhase,
  };
}

function sameLockEntry(left: CapletsLockEntry | undefined, right: CapletsLockEntry): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function cleanupTransactionPaths(paths: CapletTransactionPaths): void {
  removeInstallPath(paths.stagedPath, `transaction stage ${paths.stagedPath}`, true);
  removeInstallPath(paths.backupPath, `transaction backup ${paths.backupPath}`, true);
  rmSync(paths.lockTemporaryPath, { force: true });
  rmSync(paths.journalTemporaryPath, { force: true });
  rmSync(paths.journalPath, { force: true });
}

export async function indexInstalledCapletsFromLockfile(
  installed: Array<{ id: string; destination?: string | undefined; lockfile?: string | undefined }>,
  options: {
    disableCatalogIndexing?: boolean | undefined;
    endpoint?: string | undefined;
    fetch?: typeof fetch | undefined;
  } = {},
): Promise<Map<string, CatalogIndexingResult>> {
  const byLockfile = new Map<string, Set<string>>();
  if (options.disableCatalogIndexing || process.env.CAPLETS_DISABLE_CATALOG_INDEXING === "1") {
    return new Map(
      installed.map((entry) => [
        entry.id,
        { status: "ineligible", reason: "catalog_indexing_disabled" },
      ]),
    );
  }
  for (const entry of installed) {
    if (!entry.lockfile) continue;
    byLockfile.set(entry.lockfile, (byLockfile.get(entry.lockfile) ?? new Set()).add(entry.id));
  }

  const results = new Map<string, CatalogIndexingResult>();
  for (const [lockfilePath, ids] of byLockfile) {
    let lockfile: ReturnType<typeof readCapletsLockfile>;
    try {
      lockfile = readCapletsLockfile(lockfilePath);
    } catch {
      for (const id of ids) {
        results.set(id, { status: "unavailable", reason: "lockfile_unavailable" });
      }
      continue;
    }
    const destinations = new Map(
      installed
        .filter((candidate) => candidate.lockfile === lockfilePath && candidate.destination)
        .map((candidate) => [candidate.id, candidate.destination!]),
    );
    const indexed = await Promise.all(
      lockfile.entries
        .filter((candidate) => ids.has(candidate.id))
        .map(async (entry) => {
          const payload = catalogIndexingPayloadForLockEntry(entry);
          if ("status" in payload) {
            return [entry.id, payload] as const;
          }
          payload.entry = catalogEntryForInstalledLockEntry(
            entry,
            destinations.get(entry.id),
            payload.sourcePath,
          );
          return [entry.id, await submitCatalogIndexingPayload(payload, options)] as const;
        }),
    );
    for (const [id, result] of indexed) {
      results.set(id, result);
    }
  }
  return results;
}

async function submitCatalogIndexingPayload(
  payload: {
    source: string;
    capletId: string;
    sourcePath: string;
    resolvedRevision?: string | undefined;
    contentHash?: string | undefined;
    entryKey: string;
    entry?: CatalogEntry | undefined;
  },
  options: {
    endpoint?: string | undefined;
    fetch?: typeof fetch | undefined;
  },
): Promise<CatalogIndexingResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    return { status: "unavailable", entryKey: payload.entryKey, reason: "fetch_unavailable" };
  }
  const endpoint =
    options.endpoint ??
    process.env.CAPLETS_CATALOG_INDEX_URL ??
    "https://catalog.caplets.dev/api/v1/catalog/install-signals";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { status: "unavailable", entryKey: payload.entryKey, reason: "indexer_unavailable" };
    }
    const parsed = (await response.json().catch(() => undefined)) as
      | { result?: CatalogIndexingResult }
      | undefined;
    return parsed?.result?.status
      ? { ...parsed.result, entryKey: parsed.result.entryKey ?? payload.entryKey }
      : { status: "accepted", entryKey: payload.entryKey };
  } catch {
    return { status: "unavailable", entryKey: payload.entryKey, reason: "indexer_unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

function catalogEntryForInstalledLockEntry(
  entry: CapletsLockEntry,
  destination: string | undefined,
  sourcePath: string,
): CatalogEntry | undefined {
  if (entry.source.type !== "git" || !destination) return undefined;
  const source = normalizeCatalogSourceIdentity(entry.source.repository);
  if (!source.eligible) return undefined;
  try {
    const capletFile = lstatSync(destination).isDirectory()
      ? join(destination, "CAPLET.md")
      : destination;
    const contentMarkdown = readFileSync(capletFile, "utf8");
    const frontmatter = readCapletFrontmatterFromText(contentMarkdown);
    return createCatalogEntry({
      id: entry.id,
      name: catalogStringFromFrontmatter(frontmatter.name) ?? entry.id,
      description:
        catalogStringFromFrontmatter(frontmatter.description) ?? `Community Caplet ${entry.id}.`,
      source: source.source,
      sourcePath,
      trustLevel: "community",
      resolvedRevision: entry.source.resolvedRevision,
      indexedContentHash: entry.installedHash,
      contentMarkdown,
      icon: catalogIconFromFrontmatter(frontmatter, {
        id: entry.id,
        source: source.source,
        sourcePath,
        trustLevel: "community",
        resolvedRevision: entry.source.resolvedRevision,
      }),
      tags: catalogStringArrayFromFrontmatter(frontmatter.tags),
      useWhen: catalogStringFromFrontmatter(frontmatter.useWhen),
      avoidWhen: catalogStringFromFrontmatter(frontmatter.avoidWhen),
      setupRequired: catalogSetupRequiredFromFrontmatter(frontmatter),
      authRequired: catalogAuthRequiredFromFrontmatter(frontmatter),
      projectBindingRequired: catalogProjectBindingRequiredFromFrontmatter(frontmatter),
      workflow: catalogWorkflowSummaryFromFrontmatter(
        frontmatter,
        workflowSummaryFromRisk(entry.risk),
      ),
      mutatesExternalState: catalogMutatesExternalStateFromFrontmatter(frontmatter),
      localControl: catalogUsesLocalControlFromFrontmatter(frontmatter),
      children: catalogChildrenForInstalledLockEntry(entry, destination),
    });
  } catch {
    return undefined;
  }
}

function catalogChildrenForInstalledLockEntry(
  entry: CapletsLockEntry,
  destination: string,
): CatalogEntryChild[] | undefined {
  try {
    const loaded = loadCapletFilesWithPaths(dirname(destination));
    const children = Object.entries(loaded?.metadata ?? {}).flatMap(([id, metadata]) => {
      if (metadata.parentId !== entry.id || !metadata.childId) {
        return [];
      }
      const config = capletConfigForMetadata(loaded?.config, metadata.backend, id);
      return [
        {
          id,
          childId: metadata.childId,
          name: catalogStringFromFrontmatter(config?.name) ?? metadata.childId,
          backend: metadata.backend,
          workflow: catalogWorkflowSummaryForBackendFamily(metadata.backend) ?? {
            kind: "unknown",
            label: "Unknown" as const,
          },
        },
      ];
    });
    return children.length > 0
      ? children.sort((left, right) => left.id.localeCompare(right.id))
      : undefined;
  } catch {
    return undefined;
  }
}

function capletConfigForMetadata(
  config: CapletFileConfig | undefined,
  backend: string,
  id: string,
): Record<string, unknown> | undefined {
  const mapKey = {
    mcp: "mcpServers",
    openapi: "openapiEndpoints",
    googleDiscovery: "googleDiscoveryApis",
    graphql: "graphqlEndpoints",
    http: "httpApis",
    cli: "cliTools",
    caplets: "capletSets",
  }[backend];
  if (!mapKey) return undefined;
  const backends = config?.[mapKey as keyof NonNullable<typeof config>];
  const value = isRecord(backends) ? backends[id] : undefined;
  return isRecord(value) ? value : undefined;
}

function workflowSummaryFromRisk(risk: CapletsLockEntry["risk"]): CatalogWorkflowSummary {
  return (
    catalogWorkflowSummaryForBackendFamily(risk.backendFamilies[0]) ?? {
      kind: "set",
      label: "Caplet",
    }
  );
}

function refreshedLockSource(
  source: CapletsLockSource,
  lockedSource: LockedSourceResolution,
): CapletsLockSource {
  if (source.type === "git") {
    return {
      ...source,
      ...(lockedSource.resolvedRevision ? { resolvedRevision: lockedSource.resolvedRevision } : {}),
    };
  }
  return {
    ...source,
    ...localGitInfo(lockedSource.repoRoot),
  };
}

function discoverSelectedCapletFiles(
  sourceRoot: string,
  selectedIds: Set<string>,
): Array<{ id: string; path: string }> {
  const candidates: Array<{ id: string; path: string }> = [];
  for (const id of selectedIds) {
    if (!SERVER_ID_PATTERN.test(id)) {
      continue;
    }

    const filePath = join(sourceRoot, `${id}.md`);
    const fileStats = lstatIfExists(filePath);
    if (fileStats?.isSymbolicLink()) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Caplet source ${filePath} must not be a symbolic link`,
      );
    }
    if (fileStats?.isFile()) {
      candidates.push({ id, path: filePath });
    }

    const directoryPath = join(sourceRoot, id, "CAPLET.md");
    const directoryStats = lstatIfExists(directoryPath);
    if (directoryStats?.isSymbolicLink()) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Caplet source ${directoryPath} must not be a symbolic link`,
      );
    }
    if (directoryStats?.isFile()) {
      candidates.push({ id, path: directoryPath });
    }
  }
  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}

function selectedChildInstallGuidance(
  sourceRoot: string,
  missingIds: string[],
): string | undefined {
  let loaded: ReturnType<typeof loadCapletFilesWithPaths>;
  try {
    loaded = loadCapletFilesWithPaths(sourceRoot);
  } catch {
    return undefined;
  }
  if (!loaded?.metadata) {
    return undefined;
  }

  const matches = missingIds.flatMap((id) => {
    const metadata = loaded?.metadata?.[id];
    return metadata?.childId
      ? [{ id, parentId: metadata.parentId, childId: metadata.childId }]
      : [];
  });
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length === 1 && missingIds.length === 1) {
    const match = matches[0]!;
    return `Caplet ${match.id} is a runtime child of ${match.parentId}; install parent Caplet ${match.parentId} instead.`;
  }
  const matchedIds = new Set(matches.map((match) => match.id));
  const unmatched = missingIds.filter((id) => !matchedIds.has(id));
  const missingSuffix =
    unmatched.length > 0 ? ` Also not found: ${unmatched.join(", ")} in ${sourceRoot}.` : "";
  return `Caplet child IDs are runtime-only and cannot be installed directly: ${matches
    .map((match) => `${match.id} -> ${match.parentId}`)
    .join(", ")}. Install the parent Caplet ID instead.${missingSuffix}`;
}

function resolveInstallSource(repo: string): {
  id: string;
  repoRoot: string;
  cleanup: () => void;
  sourceKind: "local" | "git";
  repository?: string | undefined;
  resolvedRevision?: string | undefined;
} {
  if (existsSync(repo) && statSync(repo).isDirectory()) {
    return { id: repo, repoRoot: repo, cleanup: () => {}, sourceKind: "local" };
  }

  const normalizedRepo = normalizeGitRepo(repo);
  const installSource = splitInstallSourceRef(normalizedRepo);
  const repoRoot = mkdtempSync(join(tmpdir(), "caplets-install-"));
  try {
    cloneInstallSource(installSource, repoRoot);
    const resolvedRevision = gitRevision(repoRoot);
    return {
      id: installSource.repository,
      repoRoot,
      sourceKind: "git",
      repository: installSource.repository,
      resolvedRevision,
      cleanup: () => removeInstallPath(repoRoot, `temporary install source ${repoRoot}`, true),
    };
  } catch (error) {
    removeInstallPath(repoRoot, `temporary install source ${repoRoot}`, true);
    throw new CapletsError("CONFIG_NOT_FOUND", `Could not clone repo ${repo}`, toSafeError(error));
  }
}

function cloneInstallSource(
  source: { repository: string; ref?: string | undefined },
  repoRoot: string,
): void {
  rejectOptionLikeInstallSourceRef(source.ref);
  if (!source.ref) {
    execFileSync("git", ["clone", "--depth", "1", "--", source.repository, repoRoot], {
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
    return;
  }

  try {
    execFileSync("git", ["init", repoRoot], {
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
    execFileSync("git", ["remote", "add", "origin", source.repository], {
      cwd: repoRoot,
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
    execFileSync("git", ["fetch", "--depth", "1", "origin", source.ref], {
      cwd: repoRoot,
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
    execFileSync("git", ["checkout", "--detach", "FETCH_HEAD"], {
      cwd: repoRoot,
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
  } catch {
    rmSync(repoRoot, { recursive: true, force: true });
    mkdirSync(repoRoot, { recursive: true });
    execFileSync("git", ["clone", "--", source.repository, repoRoot], {
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
    execFileSync("git", ["checkout", "--detach", source.ref], {
      cwd: repoRoot,
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
  }
}

function rejectOptionLikeInstallSourceRef(ref: string | undefined): void {
  if (ref?.startsWith("-")) {
    throw new CapletsError("CONFIG_NOT_FOUND", "Install source refs cannot start with '-'.");
  }
}

function updateLockfileAfterInstall(
  lockfilePath: string,
  plans: InstallPlan[],
  installed: InstallableCaplet[],
  options: {
    source: ReturnType<typeof resolveInstallSource>;
    now: Date;
  },
): void {
  const existing = existsSync(lockfilePath)
    ? readCapletsLockfile(lockfilePath)
    : { version: 1 as const, entries: [] };
  const installedById = new Map(installed.map((caplet) => [caplet.id, caplet]));
  const next = new Map(existing.entries.map((entry) => [entry.id, entry]));
  for (const plan of plans) {
    const caplet = installedById.get(plan.id);
    if (!caplet?.hash) continue;
    const now = options.now.toISOString();
    const previous = next.get(plan.id);
    next.set(plan.id, {
      id: plan.id,
      destination: destinationDisplay(plan, caplet.destination),
      kind: plan.kind,
      source: lockSourceForPlan(plan, options.source),
      installedHash: caplet.hash,
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
      risk: riskSummaryForSourcePath(plan.sourcePath),
    });
  }
  writeCapletsLockfile(lockfilePath, { version: 1, entries: [...next.values()] });
}

function destinationDisplay(plan: InstallPlan, destination: string): string {
  return plan.kind === "file" ? `${plan.id}.md` : basename(destination);
}

function lockSourceForPlan(
  plan: InstallPlan,
  source: ReturnType<typeof resolveInstallSource>,
): CapletsLockSource {
  const sourcePath = relative(source.repoRoot, plan.sourcePath).replace(/\\/g, "/");
  if (source.sourceKind === "git") {
    return {
      type: "git",
      repository: source.repository ?? source.id,
      path: sourcePath,
      trackedRef: "HEAD",
      resolvedRevision: source.resolvedRevision,
      portability: "portable",
    };
  }
  return {
    type: "local",
    path: plan.sourcePath,
    portability: "non_portable",
    ...localGitInfo(source.repoRoot),
  };
}

function resolveLockedSource(
  source: CapletsLockSource,
  options: { useResolvedRevision?: boolean } = {},
): LockedSourceResolution {
  const useResolvedRevision = options.useResolvedRevision ?? true;
  if (source.type === "local") {
    if (!existsSync(source.path)) {
      throw new CapletsError(
        "CONFIG_NOT_FOUND",
        `Locked local source ${source.path} is unavailable`,
      );
    }
    const repoRoot = inferLocalRepoRoot(source.path);
    return {
      sourcePath: source.path,
      repoRoot,
      resolvedRevision: gitRevision(repoRoot),
      cleanup: () => {},
    };
  }
  const repoRoot = mkdtempSync(join(tmpdir(), "caplets-restore-"));
  try {
    execFileSync("git", ["clone", "--", source.repository, repoRoot], {
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
    if (useResolvedRevision && source.resolvedRevision) {
      execFileSync("git", ["checkout", "--detach", source.resolvedRevision], {
        cwd: repoRoot,
        env: externalGitEnv(),
        stdio: "ignore",
        timeout: 60_000,
      });
    } else if (!useResolvedRevision && source.trackedRef && source.trackedRef !== "HEAD") {
      checkoutTrackedRef(repoRoot, source.trackedRef);
    }
    return {
      sourcePath: join(repoRoot, source.path),
      repoRoot,
      resolvedRevision: gitRevision(repoRoot),
      cleanup: () => removeInstallPath(repoRoot, `temporary restore source ${repoRoot}`, true),
    };
  } catch (error) {
    removeInstallPath(repoRoot, `temporary restore source ${repoRoot}`, true);
    throw new CapletsError(
      "CONFIG_NOT_FOUND",
      `Could not restore locked source ${source.repository}`,
      toSafeError(error),
    );
  }
}

function checkoutTrackedRef(repoRoot: string, trackedRef: string): void {
  try {
    execFileSync("git", ["checkout", "--detach", trackedRef], {
      cwd: repoRoot,
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
  } catch {
    execFileSync("git", ["checkout", "--detach", `origin/${trackedRef}`], {
      cwd: repoRoot,
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
  }
}

function riskSummaryForSourcePath(sourcePath: string): CapletsLockEntry["risk"] {
  const frontmatter = readCapletFrontmatter(sourcePath);
  const backendFamilies = capletBackendFamilies(frontmatter);
  const auth = capletAuth(frontmatter);
  const authScopes = capletAuthScopes(frontmatter);
  const runtime = isRecord(frontmatter.runtime) ? frontmatter.runtime : undefined;
  const projectBindingRequired =
    (isRecord(frontmatter.projectBinding) && frontmatter.projectBinding.required === true) ||
    capletPluralBackends(frontmatter).some(hasProjectBinding);
  const runtimeFeatures = [
    ...(Array.isArray(runtime?.features)
      ? runtime.features.filter((feature): feature is string => typeof feature === "string")
      : []),
    ...capletPluralBackends(frontmatter).flatMap((backend) => runtimeFeaturesForBackend(backend)),
  ];
  const mutating = capletCanMutate(frontmatter);
  const destructive = capletCanDestroy(frontmatter);
  return {
    backendFamilies: backendFamilies.length > 0 ? backendFamilies : ["unknown"],
    safety: derivedSafety({
      backendFamilies,
      auth,
      projectBindingRequired,
      runtimeFeatures,
      mutating,
      destructive,
      frontmatter,
    }),
    projectBindingRequired,
    authScopes: authScopes.length > 0 ? authScopes : undefined,
    runtimeFeatures: runtimeFeatures.length > 0 ? [...new Set(runtimeFeatures)] : undefined,
    mutating,
    destructive,
    bodyHash: hashInstalledArtifact(sourcePath),
  };
}

function riskIncrease(current: CapletsLockEntry["risk"], next: CapletsLockEntry["risk"]): boolean {
  if (current.safety === "unknown" || next.safety === "unknown") return true;
  if (riskRank(next.safety) > riskRank(current.safety)) return true;
  if (!current.projectBindingRequired && next.projectBindingRequired) return true;
  if (!current.mutating && next.mutating) return true;
  if (!current.destructive && next.destructive) return true;
  if (!isSubset(current.authScopes ?? [], next.authScopes ?? [])) return true;
  if (!isSubset(current.runtimeFeatures ?? [], next.runtimeFeatures ?? [])) return true;
  return false;
}

function readCapletFrontmatter(sourcePath: string): Record<string, unknown> {
  const capletFile = lstatSync(sourcePath).isDirectory()
    ? join(sourcePath, "CAPLET.md")
    : sourcePath;
  const text = readFileSync(capletFile, "utf8");
  return readCapletFrontmatterFromText(text);
}

function readCapletFrontmatterFromText(text: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  if (!match) return {};
  const yaml = match[1];
  if (yaml === undefined) return {};
  const parsed = parseYaml(yaml);
  return isRecord(parsed) ? parsed : {};
}

function capletBackendFamilies(frontmatter: Record<string, unknown>): string[] {
  const families: Array<readonly [string, string]> = [
    ["mcp", "mcpServer"],
    ["mcp", "mcpServers"],
    ["openapi", "openapiEndpoint"],
    ["openapi", "openapiEndpoints"],
    ["googleDiscovery", "googleDiscoveryApi"],
    ["googleDiscovery", "googleDiscoveryApis"],
    ["graphql", "graphqlEndpoint"],
    ["graphql", "graphqlEndpoints"],
    ["http", "httpApi"],
    ["http", "httpApis"],
    ["cli", "cliTools"],
    ["caplets", "capletSet"],
    ["caplets", "capletSets"],
  ];
  return [
    ...new Set(
      families.flatMap(([family, key]) => (frontmatter[key] === undefined ? [] : [family])),
    ),
  ];
}

function capletAuth(frontmatter: Record<string, unknown>): Record<string, unknown> | undefined {
  const blocks = capletAuthBlocks(frontmatter);
  return blocks.find((auth) => auth.type !== "none") ?? blocks[0];
}

function capletAuthScopes(frontmatter: Record<string, unknown>): string[] {
  return [
    ...new Set(
      capletAuthBlocks(frontmatter).flatMap((auth) =>
        Array.isArray(auth.scopes)
          ? auth.scopes.filter((scope): scope is string => typeof scope === "string")
          : [],
      ),
    ),
  ];
}

function capletAuthBlocks(frontmatter: Record<string, unknown>): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  if (isRecord(frontmatter.auth)) blocks.push(frontmatter.auth);
  for (const key of [
    "mcpServer",
    "openapiEndpoint",
    "googleDiscoveryApi",
    "graphqlEndpoint",
    "httpApi",
  ]) {
    const backend = frontmatter[key];
    if (isRecord(backend) && isRecord(backend.auth)) blocks.push(backend.auth);
  }
  for (const key of [
    "mcpServers",
    "openapiEndpoints",
    "googleDiscoveryApis",
    "graphqlEndpoints",
    "httpApis",
  ]) {
    for (const backend of capletPluralBackendValues(frontmatter[key])) {
      if (isRecord(backend.auth)) blocks.push(backend.auth);
    }
  }
  return blocks;
}

function derivedSafety(input: {
  backendFamilies: string[];
  auth: Record<string, unknown> | undefined;
  projectBindingRequired: boolean;
  runtimeFeatures: string[];
  mutating: boolean;
  destructive: boolean;
  frontmatter: Record<string, unknown>;
}): CapletsLockEntry["risk"]["safety"] {
  if (
    input.projectBindingRequired ||
    input.runtimeFeatures.length > 0 ||
    input.backendFamilies.includes("cli") ||
    isLocalMcpServer(input.frontmatter)
  ) {
    return "local_control";
  }
  if (
    input.destructive ||
    input.mutating ||
    input.auth !== undefined ||
    input.backendFamilies.some((family) =>
      ["openapi", "googleDiscovery", "graphql", "http"].includes(family),
    )
  ) {
    return "mutating_saas";
  }
  return "standard";
}

function isLocalMcpServer(frontmatter: Record<string, unknown>): boolean {
  const mcpServer = frontmatter.mcpServer;
  return (
    (isRecord(mcpServer) && typeof mcpServer.command === "string") ||
    capletPluralBackendValues(frontmatter.mcpServers).some(
      (server) => typeof server.command === "string",
    )
  );
}

function capletCanMutate(frontmatter: Record<string, unknown>): boolean {
  if (frontmatter.graphqlEndpoint !== undefined || frontmatter.graphqlEndpoints !== undefined) {
    return true;
  }
  if (
    frontmatter.openapiEndpoint !== undefined ||
    frontmatter.googleDiscoveryApi !== undefined ||
    frontmatter.openapiEndpoints !== undefined ||
    frontmatter.googleDiscoveryApis !== undefined
  ) {
    return true;
  }
  const httpApi = frontmatter.httpApi;
  if (isRecord(httpApi) && isRecord(httpApi.actions)) {
    return Object.values(httpApi.actions).some((action) => {
      if (!isRecord(action)) return false;
      return typeof action.method === "string" && action.method.toUpperCase() !== "GET";
    });
  }
  if (isRecord(frontmatter.cliTools) && isRecord(frontmatter.cliTools.actions)) {
    return Object.values(frontmatter.cliTools.actions).some((action) => {
      if (!isRecord(action) || !isRecord(action.annotations)) return true;
      return action.annotations.readOnlyHint !== true;
    });
  }
  for (const httpApi of capletPluralBackendValues(frontmatter.httpApis)) {
    if (isRecord(httpApi.actions)) {
      const mutates = Object.values(httpApi.actions).some((action) => {
        if (!isRecord(action)) return false;
        return typeof action.method === "string" && action.method.toUpperCase() !== "GET";
      });
      if (mutates) return true;
    }
  }
  if (isRecord(frontmatter.cliTools) && !isRecord(frontmatter.cliTools.actions)) {
    return capletPluralBackendValues(frontmatter.cliTools).some((cliTools) => {
      if (!isRecord(cliTools.actions)) return false;
      return Object.values(cliTools.actions).some((action) => {
        if (!isRecord(action) || !isRecord(action.annotations)) return true;
        return action.annotations.readOnlyHint !== true;
      });
    });
  }
  return false;
}

function capletCanDestroy(frontmatter: Record<string, unknown>): boolean {
  const httpApi = frontmatter.httpApi;
  if (isRecord(httpApi) && isRecord(httpApi.actions)) {
    return Object.values(httpApi.actions).some(
      (action) =>
        isRecord(action) &&
        typeof action.method === "string" &&
        action.method.toUpperCase() === "DELETE",
    );
  }
  if (isRecord(frontmatter.cliTools) && isRecord(frontmatter.cliTools.actions)) {
    return Object.values(frontmatter.cliTools.actions).some(
      (action) =>
        isRecord(action) &&
        isRecord(action.annotations) &&
        action.annotations.destructiveHint === true,
    );
  }
  for (const httpApi of capletPluralBackendValues(frontmatter.httpApis)) {
    if (isRecord(httpApi.actions)) {
      const destroys = Object.values(httpApi.actions).some(
        (action) =>
          isRecord(action) &&
          typeof action.method === "string" &&
          action.method.toUpperCase() === "DELETE",
      );
      if (destroys) return true;
    }
  }
  if (isRecord(frontmatter.cliTools) && !isRecord(frontmatter.cliTools.actions)) {
    return capletPluralBackendValues(frontmatter.cliTools).some((cliTools) => {
      if (!isRecord(cliTools.actions)) return false;
      return Object.values(cliTools.actions).some(
        (action) =>
          isRecord(action) &&
          isRecord(action.annotations) &&
          action.annotations.destructiveHint === true,
      );
    });
  }
  return false;
}

function riskRank(value: CapletsLockEntry["risk"]["safety"]): number {
  switch (value) {
    case "standard":
      return 0;
    case "mutating_saas":
      return 1;
    case "local_control":
      return 2;
    case "unknown":
      return 3;
  }
}

function isSubset(previous: string[], next: string[]): boolean {
  const previousValues = new Set(previous);
  return next.every((value) => previousValues.has(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function capletPluralBackendValues(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  return Object.values(value).filter(isRecord);
}

function capletPluralBackends(frontmatter: Record<string, unknown>): Record<string, unknown>[] {
  return [
    ...capletPluralBackendValues(frontmatter.mcpServers),
    ...capletPluralBackendValues(frontmatter.openapiEndpoints),
    ...capletPluralBackendValues(frontmatter.googleDiscoveryApis),
    ...capletPluralBackendValues(frontmatter.graphqlEndpoints),
    ...capletPluralBackendValues(frontmatter.httpApis),
    ...(isRecord(frontmatter.cliTools) && !isRecord(frontmatter.cliTools.actions)
      ? capletPluralBackendValues(frontmatter.cliTools)
      : []),
    ...capletPluralBackendValues(frontmatter.capletSets),
  ];
}

function hasProjectBinding(value: Record<string, unknown>): boolean {
  return isRecord(value.projectBinding) && value.projectBinding.required === true;
}

function runtimeFeaturesForBackend(value: Record<string, unknown>): string[] {
  const runtime = isRecord(value.runtime) ? value.runtime : undefined;
  return Array.isArray(runtime?.features)
    ? runtime.features.filter((feature): feature is string => typeof feature === "string")
    : [];
}

function lockSourceDisplay(source: CapletsLockSource): string {
  return source.type === "git" ? `${source.repository}#${source.path}` : `${source.path}`;
}

function inferLocalRepoRoot(sourcePath: string): string {
  const marker = `${sep}caplets${sep}`;
  const index = sourcePath.lastIndexOf(marker);
  return index === -1 ? dirname(sourcePath) : sourcePath.slice(0, index);
}

function hashInstalledArtifact(path: string): string {
  const hash = createHash("sha256");
  hashPath(path, "", hash);
  return `sha256:${hash.digest("hex")}`;
}

function hashPath(path: string, relativePath: string, hash: ReturnType<typeof createHash>): void {
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

function gitRevision(repoRoot: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: externalGitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
  } catch {
    return undefined;
  }
}

function localGitInfo(repoRoot: string): Partial<Extract<CapletsLockSource, { type: "local" }>> {
  const gitRevisionValue = gitRevision(repoRoot);
  const dirty = gitDirty(repoRoot);
  try {
    const gitRepository = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: externalGitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    return {
      ...(gitRepository ? { gitRepository } : {}),
      ...(gitRevisionValue ? { gitRevision: gitRevisionValue } : {}),
      ...(dirty === undefined ? {} : { dirty }),
    };
  } catch {
    return {
      ...(gitRevisionValue ? { gitRevision: gitRevisionValue } : {}),
      ...(dirty === undefined ? {} : { dirty }),
    };
  }
}

function gitDirty(repoRoot: string): boolean | undefined {
  if (!gitRevision(repoRoot)) return undefined;
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: externalGitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    return status.trim().length > 0;
  } catch {
    return undefined;
  }
}

function externalGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

export function normalizeGitRepo(repo: string): string {
  const source = splitInstallSourceRef(repo);
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(source.repository)) {
    const normalized = source.repository.endsWith(".git")
      ? source.repository.slice(0, -4)
      : source.repository;
    return withInstallSourceRef(`https://github.com/${normalized}.git`, source.ref);
  }
  return repo;
}

function splitInstallSourceRef(repo: string): { repository: string; ref?: string | undefined } {
  const index = repo.lastIndexOf("#");
  if (index <= 0 || index === repo.length - 1) return { repository: repo };
  return { repository: repo.slice(0, index), ref: repo.slice(index + 1) };
}

function withInstallSourceRef(repository: string, ref: string | undefined): string {
  return ref ? `${repository}#${ref}` : repository;
}

function preflightInstallCaplets(
  caplets: Array<{ id: string; path: string }>,
  options: { destinationRoot: string; force: boolean; repoRoot: string; sourceId: string },
): InstallPlan[] {
  const plans = caplets.map((caplet) => installPlan(caplet, options));
  rejectUnsafeInstallParents(options.destinationRoot);
  rejectUnsafeInstallRoot(options.destinationRoot);
  for (const plan of plans) {
    rejectUnsafeInstallParents(plan.destination);
    rejectUnsafeInstallDestination(plan, options.force);
    rejectCrossKindDestinationCollision(plan, options.destinationRoot);
  }

  const writableRoot = nearestExistingParent(options.destinationRoot);
  ensureWritable(writableRoot, `install destination parent ${writableRoot}`);
  for (const plan of plans) {
    const destinationParent = lstatIfExists(plan.destination)
      ? dirname(plan.destination)
      : nearestExistingParent(dirname(plan.destination));
    ensureWritable(destinationParent, `install destination parent ${destinationParent}`);
  }

  makeInstallDirectory(options.destinationRoot);
  return plans;
}

function rejectUnsafeInstallRoot(destinationRoot: string): void {
  const stats = lstatIfExists(destinationRoot);
  if (!stats) {
    return;
  }
  if (stats.isSymbolicLink()) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Install destination ${destinationRoot} already exists and is a symlink`,
    );
  }
  if (!stats.isDirectory()) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Install destination ${destinationRoot} already exists and is not a directory`,
    );
  }
}

function rejectUnsafeInstallParents(path: string): void {
  const parent = dirname(resolve(path));
  const root = parse(parent).root;
  const segments = parent.slice(root.length).split(/[\\/]/).filter(Boolean);
  let current = root;

  for (const segment of segments) {
    current = join(current, segment);
    const stats = lstatIfExists(current);
    if (!stats) {
      return;
    }
    if (stats.isSymbolicLink()) {
      if (isDarwinSystemAliasSymlink(current)) continue;
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Install destination parent ${current} is a symlink; remove it before installing`,
      );
    }
    if (!stats.isDirectory()) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Install destination parent ${current} is not a directory; choose another destination`,
      );
    }
  }
}

function isDarwinSystemAliasSymlink(path: string): boolean {
  if (process.platform !== "darwin") return false;
  if (path !== "/var" && path !== "/tmp") return false;
  try {
    return realpathSync(path) === `/private${path}`;
  } catch {
    return false;
  }
}

function rejectUnsafeInstallDestination(plan: InstallPlan, force: boolean): void {
  const stats = lstatIfExists(plan.destination);
  if (!stats) {
    return;
  }

  rejectSymlinkDestination(plan.id, plan.destination, stats);
  if (plan.kind === "file" && !stats.isFile()) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Cannot install file Caplet ${plan.id}; destination already exists and is not a file at ${plan.destination}`,
    );
  }
  if (plan.kind === "directory" && !stats.isDirectory()) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Cannot install directory Caplet ${plan.id}; destination already exists and is not a directory at ${plan.destination}`,
    );
  }
  if (!force) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Caplet ${plan.id} already exists at ${plan.destination}; pass --force to overwrite it`,
    );
  }
}

function rejectDuplicateSourceIds(caplets: Array<{ id: string; path: string }>): void {
  const byId = new Map<string, string>();
  for (const caplet of caplets) {
    const existing = byId.get(caplet.id);
    if (existing) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Source repo contains multiple Caplets with ID ${caplet.id}: ${existing} and ${caplet.path}`,
      );
    }
    byId.set(caplet.id, caplet.path);
  }
}

function rejectCrossKindDestinationCollision(plan: InstallPlan, destinationRoot: string): void {
  if (plan.kind === "file") {
    const directoryPath = join(destinationRoot, plan.id);
    const directoryCapletPath = join(directoryPath, "CAPLET.md");
    const directoryStats = lstatIfExists(directoryPath);
    const directoryCapletStats = lstatIfExists(directoryCapletPath);
    rejectSymlinkDestination(plan.id, directoryPath, directoryStats);
    rejectSymlinkDestination(plan.id, directoryCapletPath, directoryCapletStats);
    if (directoryStats || directoryCapletStats) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Cannot install file Caplet ${plan.id}; directory Caplet destination already exists at ${directoryPath}`,
      );
    }
    return;
  }

  const filePath = join(destinationRoot, `${plan.id}.md`);
  const fileStats = lstatIfExists(filePath);
  rejectSymlinkDestination(plan.id, filePath, fileStats);
  if (fileStats) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Cannot install directory Caplet ${plan.id}; file Caplet destination already exists at ${filePath}`,
    );
  }
}

function installPlan(
  caplet: { id: string; path: string },
  options: { destinationRoot: string; repoRoot: string; sourceId: string },
): InstallPlan {
  const isDirectory = basename(caplet.path) === "CAPLET.md";
  const sourcePath = isDirectory ? dirname(caplet.path) : caplet.path;
  const sourceBoundary = dirname(sourcePath);
  const sourcePathRelative = relative(options.repoRoot, sourcePath);
  const destination = isDirectory
    ? join(options.destinationRoot, caplet.id)
    : join(options.destinationRoot, `${caplet.id}.md`);

  return {
    id: caplet.id,
    source: `${options.sourceId}#${sourcePathRelative}`,
    sourcePath,
    sourceBoundary,
    destination,
    kind: isDirectory ? "directory" : "file",
  };
}

function installOneCaplet(plan: InstallPlan, options: { force: boolean }): InstallableCaplet {
  const stats = lstatIfExists(plan.destination);
  if (stats) {
    rejectSymlinkDestination(plan.id, plan.destination, stats);
    if (!options.force || (plan.kind === "file" && !stats.isFile())) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Caplet ${plan.id} already exists at ${plan.destination}; pass --force to overwrite it`,
      );
    }
    if (plan.kind === "directory" && !stats.isDirectory()) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Caplet ${plan.id} already exists at ${plan.destination}; pass --force to overwrite it`,
      );
    }
  }

  replaceInstallPath(plan, Boolean(stats));
  return {
    id: plan.id,
    source: plan.source,
    destination: plan.destination,
    kind: plan.kind,
  };
}

function replaceInstallPath(plan: InstallPlan, hasExistingDestination: boolean): void {
  const stagedPath = uniqueSiblingPath(plan.destination, ".tmp");
  const backupPath = uniqueSiblingPath(plan.destination, ".old");
  try {
    copyInstallPath(plan, stagedPath);
    if (!hasExistingDestination) {
      renameSync(stagedPath, plan.destination);
      return;
    }

    renameSync(plan.destination, backupPath);
    try {
      renameSync(stagedPath, plan.destination);
    } catch (error) {
      try {
        renameSync(backupPath, plan.destination);
      } catch (restoreError) {
        throw new CapletsError(
          "CONFIG_INVALID",
          `Could not restore existing Caplet destination ${plan.destination}`,
          toSafeError(restoreError),
        );
      }
      throw error;
    }
    removeInstallPath(backupPath, `previous Caplet destination ${backupPath}`, true);
  } catch (error) {
    removeInstallPath(stagedPath, `staged Caplet destination ${stagedPath}`, true);
    if (error instanceof CapletsError) {
      throw error;
    }
    throw new CapletsError(
      "CONFIG_INVALID",
      `Could not install Caplet ${plan.id} to ${plan.destination}`,
      toSafeError(error),
    );
  }
}

function uniqueSiblingPath(path: string, suffix: string): string {
  const parent = dirname(path);
  const name = basename(path);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = join(parent, `.${name}${suffix}-${process.pid}-${Date.now()}-${attempt}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new CapletsError("CONFIG_EXISTS", `Could not allocate staging path for ${path}`);
}

function rejectSymlinkDestination(id: string, path: string, stats: Stats | undefined): void {
  if (stats?.isSymbolicLink()) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Cannot install Caplet ${id}; destination is a symlink at ${path}`,
    );
  }
}

function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isFsError(error, "ENOENT")) {
      return undefined;
    }
    throw new CapletsError(
      "CONFIG_INVALID",
      `Could not inspect install destination ${path}`,
      toSafeError(error),
    );
  }
}

function ensureWritable(path: string, label: string): void {
  try {
    accessSync(path, constants.W_OK);
  } catch (error) {
    throw new CapletsError("CONFIG_INVALID", `Cannot write to ${label}`, toSafeError(error));
  }
}

function makeInstallDirectory(path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (isFsError(error, "EEXIST")) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Install destination ${path} already exists and is not a directory`,
        toSafeError(error),
      );
    }
    throw new CapletsError(
      "CONFIG_INVALID",
      `Could not create install destination ${path}`,
      toSafeError(error),
    );
  }
}

function removeInstallPath(path: string, label: string, force: boolean): void {
  try {
    rmSync(path, { recursive: true, force });
  } catch (error) {
    throw new CapletsError("CONFIG_INVALID", `Could not remove ${label}`, toSafeError(error));
  }
}

function copyInstallPath(plan: InstallPlan, destination: string): void {
  try {
    if (plan.kind === "directory") {
      copyDirectoryCaplet(plan.sourcePath, destination, realpathSync(plan.sourceBoundary));
      return;
    }

    const sourceStats = lstatSync(plan.sourcePath);
    if (!sourceStats.isFile()) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `File Caplet source ${plan.sourcePath} must be a regular file`,
      );
    }
    copyFileSync(plan.sourcePath, destination, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error instanceof CapletsError) {
      throw error;
    }
    if (isFsError(error, "EEXIST") || isFsError(error, "EISDIR")) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Caplet ${plan.id} already exists at ${plan.destination}; pass --force to overwrite it`,
        toSafeError(error),
      );
    }
    throw new CapletsError(
      "CONFIG_INVALID",
      `Could not install Caplet ${plan.id} to ${plan.destination}`,
      toSafeError(error),
    );
  }
}

function copyDirectoryCaplet(
  source: string,
  destination: string,
  sourceBoundary: string,
  seenDirectories = new Set<string>(),
): void {
  const lstat = lstatSync(source);
  const resolvedSource = lstat.isSymbolicLink()
    ? resolveDirectoryCapletSymlink(source, sourceBoundary)
    : source;
  const stats = statSync(resolvedSource);
  if (stats.isDirectory()) {
    const realDirectory = realpathSync(resolvedSource);
    if (seenDirectories.has(realDirectory)) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Directory Caplet symlink ${source} creates a copy cycle`,
      );
    }
    const childSeenDirectories = new Set(seenDirectories);
    childSeenDirectories.add(realDirectory);
    mkdirSync(destination);
    for (const entry of readdirSync(resolvedSource)) {
      copyDirectoryCaplet(
        join(resolvedSource, entry),
        join(destination, entry),
        sourceBoundary,
        childSeenDirectories,
      );
    }
    return;
  }

  copyFileSync(resolvedSource, destination);
}

function resolveDirectoryCapletSymlink(source: string, sourceBoundary: string): string {
  const target = readlinkSync(source);
  const targetPath = isAbsolute(target) ? target : resolve(dirname(source), target);
  const resolvedTarget = realpathSync(targetPath);
  if (resolvedTarget !== sourceBoundary && !resolvedTarget.startsWith(`${sourceBoundary}${sep}`)) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Directory Caplet symlink ${source} resolves outside source Caplets boundary`,
    );
  }
  return resolvedTarget;
}

function isFsError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function nearestExistingParent(path: string): string {
  if (lstatIfExists(path)) {
    return path;
  }
  const parent = dirname(path);
  if (parent === path) {
    return parent;
  }
  return nearestExistingParent(parent);
}
