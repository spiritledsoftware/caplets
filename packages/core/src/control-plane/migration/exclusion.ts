import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { CapletsError } from "../../errors";
import { scanLinuxRelocatedHandles } from "./exclusion/linux";
import { scanMacosRelocatedHandles } from "./exclusion/macos";
import {
  openWindowsExclusionHelper,
  type WindowsArtifactLocation,
  type WindowsHelperLease,
} from "./exclusion/windows";

export type LegacyMutablePath = {
  relativePath: string;
  kind: "file" | "directory";
};

export type LegacyOfflineSourcePath = {
  sourcePath: string;
  logicalPath: string;
  kind: "file" | "directory";
};

export type RelocatedPathIdentity = {
  relativePath: string;
  kind: "file" | "directory";
  device: string;
  inode: string;
};

export type PlatformExclusionEvidence = {
  platform: "linux" | "darwin" | "win32";
  coverage: "proven";
  gates: readonly string[];
  scannedProcesses: number;
  scannedHandles: number;
  helper?: {
    architecture: string;
    sha256: string;
    publisher: string;
  };
};

export type LinuxExclusionOptions = {
  /** Test-only process table fixture; production coverage always uses /proc. */
  procRootForTests?: string;
  proof: { kind: "automatic" } | { kind: "offline"; allReplicasStopped: true };
};

export type MacosExclusionOptions = {
  proof: { kind: "automatic" } | { kind: "offline"; allReplicasStopped: true };
};

export type WindowsExclusionOptions = {
  expectedOwnerSid: string;
  expectedServices: readonly { name: string; sid: string }[];
  proof: { kind: "automatic" } | { kind: "offline"; allReplicasStopped: true };
};

export type AcquireLegacyMigrationExclusionOptions = {
  sourceBoundaryPath: string;
  /**
   * Offline multi-root sealing is not yet implemented. Supplying any additional
   * roots refuses rather than claiming coverage for only the primary boundary.
   */
  additionalSourceBoundaryPaths?: readonly string[];
  /**
   * Exact mutable paths in the real legacy multi-root layout. This is accepted
   * only by the privileged offline one-shot after all legacy replicas stop.
   */
  offlineSourcePaths?: readonly LegacyOfflineSourcePath[];
  mutablePaths: readonly LegacyMutablePath[];
  mode: "automatic" | "offline";
  platform?: NodeJS.Platform;
  platformOptions?: {
    linux?: LinuxExclusionOptions;
    macos?: MacosExclusionOptions;
    windows?: WindowsExclusionOptions;
  };
  hooks?: LegacyExclusionHooks;
};

export type LegacyExclusionHooks = {
  afterSourceRelocated?: (context: { sealedSourcePath: string }) => void | Promise<void>;
  afterTombstonesPublished?: (context: { sealedSourcePath: string }) => void | Promise<void>;
  afterInitialScan?: (context: { sealedSourcePath: string }) => void | Promise<void>;
  afterRollbackSourceRestored?: () => void | Promise<void>;
  afterRollbackTombstonesRemoved?: () => void | Promise<void>;
  afterActivationJournalDurable?: (context: { sealedSourcePath: string }) => void | Promise<void>;
};

export type LegacyExclusionState = "acquired" | "rolled-back" | "activated";

export type LegacyMigrationExclusion = {
  readonly sealedSource: {
    path: string;
    manifestSha256: string;
    identities: readonly RelocatedPathIdentity[];
    sources: readonly {
      logicalPath: string;
      path: string;
      kind: "file" | "directory";
      identities: readonly RelocatedPathIdentity[];
    }[];
  };
  readonly tombstonePaths: readonly string[];
  readonly initialEvidence: PlatformExclusionEvidence;
  readonly state: LegacyExclusionState;
  verifyFinalScanAndRehash(): Promise<{
    manifestSha256: string;
    platformEvidence: PlatformExclusionEvidence;
  }>;
  rollbackBeforeActivation(): Promise<void>;
  completeActivation(input: { protectedRecoveryDurable: true }): Promise<void>;
  release(): Promise<void>;
};

type PathSnapshot = RelocatedPathIdentity & {
  mode: number;
  size: number;
  linkCount: number;
  contentSha256?: string;
};

type ExclusionJournalPhase =
  | "prepared"
  | "relocated"
  | "tombstones-published"
  | "recovery-durable"
  | "activation-cleanup";

type ExclusionJournal = {
  version: 1;
  phase: ExclusionJournalPhase;
  sourceBoundaryPath: string;
  mutablePaths: LegacyMutablePath[];
  sealedSourcePath: string;
  tombstoneStagingPath: string;
  recoverySnapshotPath: string;
  snapshots?: PathSnapshot[];
  tombstoneSnapshots?: PathSnapshot[];
};

type PosixAcquisition = {
  sourceBoundaryPath: string;
  mutablePaths: LegacyMutablePath[];
  sealedSourcePath: string;
  recoverySnapshotPath: string;
  tombstoneStagingPath: string;
  tombstonePaths: string[];
  snapshots: PathSnapshot[];
  tombstoneSnapshots: PathSnapshot[];
  manifestSha256: string;
  evidence: PlatformExclusionEvidence;
  options: AcquireLegacyMigrationExclusionOptions;
  journalPath: string;
};
type PreparedPosixBoundary = {
  sourceBoundaryPath: string;
  mutablePaths: LegacyMutablePath[];
  sealedSourcePath: string;
  tombstoneStagingPath: string;
  recoverySnapshotPath: string;
  journalPath: string;
  rollbackSnapshots: PathSnapshot[] | undefined;
};

export async function acquireLegacyMigrationExclusion(
  options: AcquireLegacyMigrationExclusionOptions,
): Promise<LegacyMigrationExclusion> {
  if (options.offlineSourcePaths?.length) {
    if (options.mode !== "offline") {
      refuse("Automatic migration requires one dedicated legacy rename boundary.");
    }
    if (options.additionalSourceBoundaryPaths?.length) {
      refuse("Offline source paths cannot be combined with legacy boundary aliases.");
    }
    const platform = options.platform ?? process.platform;
    if (platform === "win32") {
      refuse("Offline real-layout sealing is provided by the Windows exclusion helper.");
    }
    if (platform !== "linux" && platform !== "darwin") {
      refuse("Legacy migration exclusion is unavailable on this platform.");
    }
    return acquireOfflineSourcePaths(options, platform);
  }
  if (options.additionalSourceBoundaryPaths?.length) {
    refuse("Offline multi-root legacy sealing is unsupported; no exclusion was acquired.");
  }
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return acquireWindows(options);
  if (platform !== "linux" && platform !== "darwin") {
    refuse("Legacy migration exclusion is unavailable on this platform.");
  }

  let prepared: PreparedPosixBoundary;
  try {
    prepared = await preparePosixBoundary(options);
  } catch (error) {
    throw exclusionError(error);
  }
  let acquisition: PosixAcquisition | undefined;
  try {
    acquisition = await relocateAndScanPosix(options, prepared, platform);
    return createPosixLease(acquisition, platform);
  } catch (error) {
    if (acquisition) {
      await rollbackPosix(acquisition).catch(() => {
        throw new CapletsError(
          "INTERNAL_ERROR",
          "Legacy migration exclusion failed and exact rollback could not be completed.",
        );
      });
    } else if (await pathExists(prepared.sealedSourcePath)) {
      const partial = await recoverPartialAcquisition(options, prepared, platform).catch(
        () => undefined,
      );
      if (!partial) {
        throw new CapletsError(
          "INTERNAL_ERROR",
          "Legacy migration exclusion failed and exact rollback could not be completed.",
        );
      }
      await rollbackPosix(partial).catch(() => {
        throw new CapletsError(
          "INTERNAL_ERROR",
          "Legacy migration exclusion failed and exact rollback could not be completed.",
        );
      });
    }
    throw exclusionError(error);
  }
}
export async function acquireLegacyMigrationExclusionWithWindowsArtifactForTests(
  options: AcquireLegacyMigrationExclusionOptions,
  artifacts: WindowsArtifactLocation,
): Promise<LegacyMigrationExclusion> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32")
    refuse("The Windows exclusion fixture is unavailable on this platform.");
  return acquireWindows(options, artifacts);
}

async function preparePosixBoundary(
  options: AcquireLegacyMigrationExclusionOptions,
): Promise<PreparedPosixBoundary> {
  const sourceBoundaryPath = resolve(options.sourceBoundaryPath);
  const sourceParent = await lstat(dirname(sourceBoundaryPath), { bigint: true }).catch(
    () => undefined,
  );
  if (
    !sourceParent?.isDirectory() ||
    sourceParent.isSymbolicLink() ||
    (Number(sourceParent.mode) & 0o077) !== 0 ||
    (typeof process.getuid === "function" && Number(sourceParent.uid) !== process.getuid())
  ) {
    refuse("The legacy boundary parent must be an owner-private journal location.");
  }
  const journalPath = exclusionJournalPath(sourceBoundaryPath);
  await reconcileExclusionJournal(journalPath, options);
  if (dirname(sourceBoundaryPath) === sourceBoundaryPath) {
    refuse("The mutable legacy source must use a dedicated non-root rename boundary.");
  }
  const boundary = await lstat(sourceBoundaryPath, { bigint: true }).catch(() => undefined);
  if (!boundary?.isDirectory() || boundary.isSymbolicLink()) {
    refuse("The mutable legacy source must be a dedicated no-follow directory boundary.");
  }
  if ((Number(boundary.mode) & 0o077) !== 0) {
    refuse("The mutable legacy boundary must be owner-private.");
  }
  if (typeof process.getuid === "function" && Number(boundary.uid) !== process.getuid()) {
    refuse("The mutable legacy boundary owner does not match the migration process.");
  }

  const mutablePaths = validateMutablePaths(options.mutablePaths);
  const entries = await readdir(sourceBoundaryPath, { withFileTypes: true });
  if (
    entries.length !== mutablePaths.length ||
    entries.some((entry) => !mutablePaths.some((path) => path.relativePath === entry.name))
  ) {
    refuse("The dedicated legacy boundary contains untracked or incomplete mutable state.");
  }
  for (const mutablePath of mutablePaths) {
    const metadata = await lstat(join(sourceBoundaryPath, mutablePath.relativePath));
    if (
      metadata.isSymbolicLink() ||
      (mutablePath.kind === "file" ? !metadata.isFile() : !metadata.isDirectory())
    ) {
      refuse("A declared legacy mutable path did not match its reviewed type.");
    }
  }
  await enumeratePathSnapshots(sourceBoundaryPath, false);

  const nonce = randomBytes(24).toString("hex");
  const prepared: PreparedPosixBoundary = {
    sourceBoundaryPath,
    mutablePaths,
    sealedSourcePath: join(dirname(sourceBoundaryPath), `.caplets-sealed-${nonce}`),
    tombstoneStagingPath: join(dirname(sourceBoundaryPath), `.caplets-tombstones-${nonce}`),
    recoverySnapshotPath: join(dirname(sourceBoundaryPath), `.caplets-recovery-${nonce}`),
    journalPath,
    rollbackSnapshots: undefined,
  };
  await writeExclusionJournal(prepared, "prepared");
  return prepared;
}

async function relocateAndScanPosix(
  options: AcquireLegacyMigrationExclusionOptions,
  prepared: PreparedPosixBoundary,
  platform: "linux" | "darwin",
): Promise<PosixAcquisition> {
  await rename(prepared.sourceBoundaryPath, prepared.sealedSourcePath);
  await syncDirectory(dirname(prepared.sourceBoundaryPath));
  await writeExclusionJournal(prepared, "relocated");
  await options.hooks?.afterSourceRelocated?.({ sealedSourcePath: prepared.sealedSourcePath });

  await createTombstoneBoundary(prepared);
  await options.hooks?.afterTombstonesPublished?.({ sealedSourcePath: prepared.sealedSourcePath });
  const tombstoneSnapshots = await enumeratePathSnapshots(prepared.sourceBoundaryPath, true);
  await writeExclusionJournal(prepared, "tombstones-published", { tombstoneSnapshots });

  const snapshots = await enumeratePathSnapshots(prepared.sealedSourcePath, false);
  prepared.rollbackSnapshots = snapshots;
  const identities = snapshots.map(({ relativePath, kind, device, inode }) => ({
    relativePath,
    kind,
    device,
    inode,
  }));
  const evidence = await scanPlatform(platform, {
    sealedBoundaryPath: prepared.sealedSourcePath,
    identities,
    mode: options.mode,
    options,
  });
  await options.hooks?.afterInitialScan?.({ sealedSourcePath: prepared.sealedSourcePath });

  await createRecoverySnapshot(prepared.sealedSourcePath, prepared.recoverySnapshotPath, snapshots);
  const recoverySnapshots = await enumeratePathSnapshots(prepared.recoverySnapshotPath, true);
  const sourceBeforeSeal = await enumeratePathSnapshots(prepared.sealedSourcePath, true);
  const manifestSha256 = hashSnapshots(sourceBeforeSeal);
  if (!sameSnapshotContents(sourceBeforeSeal, recoverySnapshots)) {
    refuse("The relocated legacy source changed while its recovery snapshot was sealed.");
  }
  await writeExclusionJournal(prepared, "recovery-durable", {
    snapshots: sourceBeforeSeal,
    tombstoneSnapshots,
  });
  await makeSourceReadOnly(prepared.sealedSourcePath, sourceBeforeSeal);
  const sealedSnapshots = await enumeratePathSnapshots(prepared.sealedSourcePath, true);
  if (
    !sameSnapshotContents(sealedSnapshots, recoverySnapshots) ||
    !sameSnapshotIdentities(sealedSnapshots, sourceBeforeSeal) ||
    !hasSealedModes(sealedSnapshots, sourceBeforeSeal)
  ) {
    refuse("The relocated legacy source changed before immutable sealing completed.");
  }

  return {
    sourceBoundaryPath: prepared.sourceBoundaryPath,
    mutablePaths: prepared.mutablePaths,
    sealedSourcePath: prepared.sealedSourcePath,
    recoverySnapshotPath: prepared.recoverySnapshotPath,
    tombstoneStagingPath: prepared.tombstoneStagingPath,
    tombstonePaths: prepared.mutablePaths.map((path) =>
      join(prepared.sourceBoundaryPath, path.relativePath),
    ),
    tombstoneSnapshots,
    snapshots: sourceBeforeSeal,
    manifestSha256,
    evidence,
    options,
    journalPath: prepared.journalPath,
  };
}

async function recoverPartialAcquisition(
  options: AcquireLegacyMigrationExclusionOptions,
  prepared: PreparedPosixBoundary,
  platform: "linux" | "darwin",
): Promise<PosixAcquisition> {
  const recoveryComplete = await pathExists(prepared.recoverySnapshotPath);
  const sourceMetadata =
    prepared.rollbackSnapshots ?? (await enumeratePathSnapshots(prepared.sealedSourcePath, false));
  const snapshots = recoveryComplete
    ? mergeSnapshotContents(
        sourceMetadata,
        await enumeratePathSnapshots(prepared.recoverySnapshotPath, true),
      )
    : sourceMetadata;
  const identities = snapshots.map(({ relativePath, kind, device, inode }) => ({
    relativePath,
    kind,
    device,
    inode,
  }));
  return {
    sourceBoundaryPath: prepared.sourceBoundaryPath,
    mutablePaths: prepared.mutablePaths,
    sealedSourcePath: prepared.sealedSourcePath,
    recoverySnapshotPath: prepared.recoverySnapshotPath,
    tombstoneStagingPath: prepared.tombstoneStagingPath,
    tombstonePaths: prepared.mutablePaths.map((path) =>
      join(prepared.sourceBoundaryPath, path.relativePath),
    ),
    tombstoneSnapshots: (await pathExists(prepared.sourceBoundaryPath))
      ? await enumeratePathSnapshots(prepared.sourceBoundaryPath, true)
      : [],
    snapshots,
    manifestSha256: hashSnapshots(snapshots),
    evidence: {
      platform,
      coverage: "proven",
      gates: ["rollback-only"],
      scannedProcesses: 0,
      scannedHandles: identities.length,
    },
    options,
    journalPath: prepared.journalPath,
  };
}

function createPosixLease(
  acquisition: PosixAcquisition,
  platform: "linux" | "darwin",
): LegacyMigrationExclusion {
  let state: LegacyExclusionState = "acquired";
  return {
    sealedSource: {
      path: acquisition.sealedSourcePath,
      manifestSha256: acquisition.manifestSha256,
      identities: acquisition.snapshots.map(({ relativePath, kind, device, inode }) => ({
        relativePath,
        kind,
        device,
        inode,
      })),
      sources: [
        {
          logicalPath: ".",
          path: acquisition.sealedSourcePath,
          kind: "directory",
          identities: acquisition.snapshots.map(({ relativePath, kind, device, inode }) => ({
            relativePath,
            kind,
            device,
            inode,
          })),
        },
      ],
    },
    tombstonePaths: acquisition.tombstonePaths,
    initialEvidence: acquisition.evidence,
    get state() {
      return state;
    },
    async verifyFinalScanAndRehash() {
      if (state !== "acquired") refuse("Legacy migration exclusion is no longer active.");
      return verifyPosixFinal(acquisition, platform);
    },
    async rollbackBeforeActivation() {
      if (state === "rolled-back") return;
      if (state !== "acquired")
        refuse("Activated legacy migration exclusion cannot be rolled back.");
      await rollbackPosix(acquisition).catch((error: unknown) => {
        throw exclusionError(error, "INTERNAL_ERROR");
      });
      state = "rolled-back";
    },
    async completeActivation(input) {
      if (state !== "acquired") refuse("Legacy migration exclusion is no longer active.");
      if (input.protectedRecoveryDurable !== true) {
        refuse("Protected recovery must be durable before migration activation completes.");
      }
      await this.verifyFinalScanAndRehash();
      try {
        await writeExclusionJournal(acquisition, "activation-cleanup", {
          snapshots: acquisition.snapshots,
          tombstoneSnapshots: acquisition.tombstoneSnapshots,
        });
        await acquisition.options.hooks?.afterActivationJournalDurable?.({
          sealedSourcePath: acquisition.sealedSourcePath,
        });
        await makeSourceWritable(acquisition.sealedSourcePath, acquisition.snapshots);
        await rm(acquisition.sealedSourcePath, { recursive: true, force: true });
        await rm(acquisition.recoverySnapshotPath, { recursive: true, force: true });
        await syncDirectory(dirname(acquisition.sourceBoundaryPath));
        await removeExclusionJournal(acquisition.journalPath);
        state = "activated";
      } catch (error) {
        throw exclusionError(error, "INTERNAL_ERROR");
      }
    },
    async release() {
      if (state === "acquired") {
        refuse("Legacy migration exclusion must be activated or rolled back before release.");
      }
    },
  };
}
async function verifyPosixFinal(
  acquisition: PosixAcquisition,
  platform: "linux" | "darwin",
): Promise<{
  manifestSha256: string;
  platformEvidence: PlatformExclusionEvidence;
}> {
  try {
    const identities = acquisition.snapshots.map(({ relativePath, kind, device, inode }) => ({
      relativePath,
      kind,
      device,
      inode,
    }));
    const platformEvidence = await scanPlatform(platform, {
      sealedBoundaryPath: acquisition.sealedSourcePath,
      identities,
      mode: acquisition.options.mode,
      options: acquisition.options,
    });
    const tombstones = await enumeratePathSnapshots(acquisition.sourceBoundaryPath, true);
    if (
      !sameSnapshotContents(tombstones, acquisition.tombstoneSnapshots) ||
      !sameSnapshotIdentities(tombstones, acquisition.tombstoneSnapshots)
    ) {
      refuse("The exact legacy tombstone boundary changed before activation.");
    }
    const current = await enumeratePathSnapshots(acquisition.sealedSourcePath, true);
    if (
      !sameSnapshotContents(current, acquisition.snapshots) ||
      !sameSnapshotIdentities(current, acquisition.snapshots) ||
      !hasSealedModes(current, acquisition.snapshots)
    ) {
      refuse("The sealed legacy source changed after process exclusion.");
    }
    return { manifestSha256: acquisition.manifestSha256, platformEvidence };
  } catch (error) {
    throw exclusionError(error);
  }
}

async function acquireWindows(
  options: AcquireLegacyMigrationExclusionOptions,
  artifacts?: WindowsArtifactLocation,
): Promise<LegacyMigrationExclusion> {
  const windows = options.platformOptions?.windows;
  if (!windows) refuse("Windows exclusion helper configuration is required.");
  const helper = await openWindowsExclusionHelper({
    options,
    windows,
    ...(artifacts ? { artifacts } : {}),
  });
  return createWindowsLease(helper);
}

function createWindowsLease(helper: WindowsHelperLease): LegacyMigrationExclusion {
  let state: LegacyExclusionState = "acquired";
  return {
    sealedSource: {
      path: helper.sealedSourcePath,
      manifestSha256: helper.manifestSha256,
      identities: helper.identities,
      sources: [
        {
          logicalPath: ".",
          path: helper.sealedSourcePath,
          kind: "directory",
          identities: helper.identities,
        },
      ],
    },
    tombstonePaths: helper.tombstonePaths,
    initialEvidence: helper.evidence,
    get state() {
      return state;
    },
    async verifyFinalScanAndRehash() {
      if (state !== "acquired") refuse("Legacy migration exclusion is no longer active.");
      const verified = await helper.verify();
      if (verified.manifestSha256 !== helper.manifestSha256) {
        refuse("The sealed legacy source changed after process exclusion.");
      }
      return {
        manifestSha256: verified.manifestSha256,
        platformEvidence: verified.evidence,
      };
    },
    async rollbackBeforeActivation() {
      if (state === "rolled-back") return;
      if (state !== "acquired")
        refuse("Activated legacy migration exclusion cannot be rolled back.");
      await helper.rollback();
      state = "rolled-back";
    },
    async completeActivation(input) {
      if (state !== "acquired" || input.protectedRecoveryDurable !== true) {
        refuse("Protected recovery must be durable before migration activation completes.");
      }
      await this.verifyFinalScanAndRehash();
      await helper.complete();
      state = "activated";
    },
    async release() {
      if (state === "acquired") {
        refuse("Legacy migration exclusion must be activated or rolled back before release.");
      }
      await helper.close();
    },
  };
}

async function createTombstoneBoundary(prepared: PreparedPosixBoundary): Promise<void> {
  await mkdir(prepared.tombstoneStagingPath, { mode: 0o700 });
  for (const mutablePath of prepared.mutablePaths) {
    const path = join(prepared.tombstoneStagingPath, mutablePath.relativePath);
    if (mutablePath.kind === "file") {
      await mkdir(path, { mode: 0o700 });
      await syncDirectory(path);
    } else {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile("caplets legacy migration tombstone\n");
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  await syncDirectory(prepared.tombstoneStagingPath);
  await rename(prepared.tombstoneStagingPath, prepared.sourceBoundaryPath);
  await syncDirectory(dirname(prepared.sourceBoundaryPath));
}

function exclusionJournalPath(sourceBoundaryPath: string): string {
  const name = createHash("sha256").update(sourceBoundaryPath).digest("hex").slice(0, 32);
  return join(dirname(sourceBoundaryPath), `.caplets-exclusion-${name}.journal`);
}

async function writeExclusionJournal(
  input: {
    sourceBoundaryPath: string;
    mutablePaths: LegacyMutablePath[];
    sealedSourcePath: string;
    tombstoneStagingPath: string;
    recoverySnapshotPath: string;
    journalPath: string;
  },
  phase: ExclusionJournalPhase,
  state: Pick<ExclusionJournal, "snapshots" | "tombstoneSnapshots"> = {},
): Promise<void> {
  const journal: ExclusionJournal = {
    version: 1,
    phase,
    sourceBoundaryPath: input.sourceBoundaryPath,
    mutablePaths: input.mutablePaths,
    sealedSourcePath: input.sealedSourcePath,
    tombstoneStagingPath: input.tombstoneStagingPath,
    recoverySnapshotPath: input.recoverySnapshotPath,
    ...state,
  };
  const temporaryPath = `${input.journalPath}.${randomBytes(16).toString("hex")}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(journal)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, input.journalPath);
    await syncDirectory(dirname(input.journalPath));
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function removeExclusionJournal(journalPath: string): Promise<void> {
  await rm(journalPath, { force: true });
  await syncDirectory(dirname(journalPath));
}

async function reconcileExclusionJournal(
  journalPath: string,
  options: AcquireLegacyMigrationExclusionOptions,
): Promise<void> {
  const metadata = await lstat(journalPath, { bigint: true }).catch((error: unknown) => {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  });
  if (!metadata) return;
  if (!metadata.isFile() || metadata.isSymbolicLink() || (Number(metadata.mode) & 0o077) !== 0) {
    refuse("The legacy exclusion journal is not an owner-private regular file.");
  }
  const journal = parseExclusionJournal(await readFile(journalPath, "utf8"), options, journalPath);
  const sealedExists = await pathExists(journal.sealedSourcePath);

  if (journal.phase === "activation-cleanup") {
    if (!journal.tombstoneSnapshots) {
      throw new CapletsError(
        "INTERNAL_ERROR",
        "Activated exclusion cleanup journal is incomplete.",
      );
    }
    const tombstones = await enumeratePathSnapshots(journal.sourceBoundaryPath, true);
    if (
      !sameSnapshotContents(tombstones, journal.tombstoneSnapshots) ||
      !sameSnapshotIdentities(tombstones, journal.tombstoneSnapshots)
    ) {
      refuse("Activated legacy tombstones changed before cleanup reconciliation.");
    }
    if (sealedExists) {
      if (!journal.snapshots) {
        throw new CapletsError(
          "INTERNAL_ERROR",
          "Activated exclusion cleanup journal is incomplete.",
        );
      }
      await makeSourceWritable(journal.sealedSourcePath, journal.snapshots);
      await rm(journal.sealedSourcePath, { recursive: true });
    }
    await rm(journal.recoverySnapshotPath, { recursive: true, force: true });
    await rm(journal.tombstoneStagingPath, { recursive: true, force: true });
    await syncDirectory(dirname(journal.sourceBoundaryPath));
    await removeExclusionJournal(journalPath);
    refuse("A previous migration activation was reconciled; the legacy namespace remains closed.");
  }

  if (!sealedExists) {
    if (journal.phase !== "prepared" || !(await pathExists(journal.sourceBoundaryPath))) {
      throw new CapletsError("INTERNAL_ERROR", "Legacy exclusion journal state is irreconcilable.");
    }
    await rm(journal.recoverySnapshotPath, { recursive: true, force: true });
    await rm(journal.tombstoneStagingPath, { recursive: true, force: true });
    await removeExclusionJournal(journalPath);
    return;
  }

  const snapshots =
    journal.snapshots ?? (await enumeratePathSnapshots(journal.sealedSourcePath, true));
  await rollbackPosix({
    sourceBoundaryPath: journal.sourceBoundaryPath,
    mutablePaths: journal.mutablePaths,
    sealedSourcePath: journal.sealedSourcePath,
    tombstoneStagingPath: journal.tombstoneStagingPath,
    recoverySnapshotPath: journal.recoverySnapshotPath,
    tombstonePaths: journal.mutablePaths.map((path) =>
      join(journal.sourceBoundaryPath, path.relativePath),
    ),
    snapshots,
    tombstoneSnapshots: journal.tombstoneSnapshots ?? [],
    manifestSha256: hashSnapshots(snapshots),
    evidence: {
      platform: options.platform === "darwin" ? "darwin" : "linux",
      coverage: "proven",
      gates: ["restart-reconciliation"],
      scannedProcesses: 0,
      scannedHandles: 0,
    },
    options,
    journalPath,
  });
}

function parseExclusionJournal(
  bytes: string,
  options: AcquireLegacyMigrationExclusionOptions,
  journalPath: string,
): ExclusionJournal {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    refuse("The legacy exclusion journal is malformed.");
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    ![
      "prepared",
      "relocated",
      "tombstones-published",
      "recovery-durable",
      "activation-cleanup",
    ].includes(String(value.phase)) ||
    typeof value.sourceBoundaryPath !== "string" ||
    typeof value.sealedSourcePath !== "string" ||
    typeof value.tombstoneStagingPath !== "string" ||
    typeof value.recoverySnapshotPath !== "string" ||
    !Array.isArray(value.mutablePaths) ||
    !value.mutablePaths.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.relativePath === "string" &&
        (entry.kind === "file" || entry.kind === "directory"),
    )
  ) {
    refuse("The legacy exclusion journal is malformed.");
  }
  const sourceBoundaryPath = resolve(options.sourceBoundaryPath);
  const parent = dirname(sourceBoundaryPath);
  const mutablePaths = validateMutablePaths(options.mutablePaths);
  const storedMutablePaths = validateMutablePaths(value.mutablePaths as LegacyMutablePath[]);
  if (
    value.sourceBoundaryPath !== sourceBoundaryPath ||
    journalPath !== exclusionJournalPath(sourceBoundaryPath) ||
    JSON.stringify(storedMutablePaths) !== JSON.stringify(mutablePaths) ||
    !isJournalArtifact(value.sealedSourcePath, parent, ".caplets-sealed-") ||
    !isJournalArtifact(value.tombstoneStagingPath, parent, ".caplets-tombstones-") ||
    !isJournalArtifact(value.recoverySnapshotPath, parent, ".caplets-recovery-")
  ) {
    refuse("The legacy exclusion journal does not match this migration boundary.");
  }
  return {
    version: 1,
    phase: value.phase as ExclusionJournalPhase,
    sourceBoundaryPath,
    mutablePaths,
    sealedSourcePath: value.sealedSourcePath,
    tombstoneStagingPath: value.tombstoneStagingPath,
    recoverySnapshotPath: value.recoverySnapshotPath,
    ...(value.snapshots !== undefined ? { snapshots: parseJournalSnapshots(value.snapshots) } : {}),
    ...(value.tombstoneSnapshots !== undefined
      ? { tombstoneSnapshots: parseJournalSnapshots(value.tombstoneSnapshots) }
      : {}),
  };
}

function parseJournalSnapshots(value: unknown): PathSnapshot[] {
  if (!Array.isArray(value)) refuse("The legacy exclusion journal snapshots are malformed.");
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.relativePath !== "string" ||
      (entry.kind !== "file" && entry.kind !== "directory") ||
      typeof entry.device !== "string" ||
      typeof entry.inode !== "string" ||
      typeof entry.mode !== "number" ||
      typeof entry.size !== "number" ||
      typeof entry.linkCount !== "number" ||
      (entry.contentSha256 !== undefined &&
        (typeof entry.contentSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry.contentSha256)))
    ) {
      refuse("The legacy exclusion journal snapshots are malformed.");
    }
    return entry as PathSnapshot;
  });
}

function isJournalArtifact(path: string, parent: string, prefix: string): boolean {
  return (
    dirname(path) === parent &&
    basename(path).startsWith(prefix) &&
    /^[a-f0-9]{48}$/u.test(basename(path).slice(prefix.length))
  );
}

async function enumeratePathSnapshots(
  root: string,
  hashContents: boolean,
): Promise<PathSnapshot[]> {
  const snapshots: PathSnapshot[] = [];
  const rootMetadata = await lstat(root, { bigint: true });
  const rootDevice = rootMetadata.dev;
  await visit(root, "");
  return snapshots.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  async function visit(path: string, relativePath: string): Promise<void> {
    const metadata = await lstat(path, { bigint: true });
    if (
      metadata.isSymbolicLink() ||
      (!metadata.isFile() && !metadata.isDirectory()) ||
      metadata.dev !== rootDevice ||
      (metadata.isFile() && metadata.nlink !== 1n)
    ) {
      refuse(
        "The legacy boundary contains a link, aliased file, cross-device entry, or unsupported file type.",
      );
    }
    const kind = metadata.isDirectory() ? "directory" : "file";
    const snapshot: PathSnapshot = {
      relativePath: relativePath || ".",
      kind,
      device: String(metadata.dev),
      inode: String(metadata.ino),
      mode: Number(metadata.mode) & 0o777,
      size: Number(metadata.size),
      linkCount: Number(metadata.nlink),
    };
    if (kind === "file" && hashContents) {
      snapshot.contentSha256 = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    }
    snapshots.push(snapshot);
    if (kind === "directory") {
      const entries = await readdir(path, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        await visit(
          join(path, entry.name),
          relativePath ? join(relativePath, entry.name) : entry.name,
        );
      }
    }
  }
}

async function createRecoverySnapshot(
  sourceRoot: string,
  snapshotRoot: string,
  snapshots: readonly PathSnapshot[],
): Promise<void> {
  const stagingRoot = `${snapshotRoot}.staging`;
  await mkdir(stagingRoot, { mode: 0o700 });
  try {
    for (const snapshot of snapshots) {
      if (snapshot.relativePath === ".") continue;
      const source = join(sourceRoot, snapshot.relativePath);
      const target = join(stagingRoot, snapshot.relativePath);
      if (snapshot.kind === "directory") {
        await mkdir(target, { mode: 0o700 });
      } else {
        await copyFile(source, target);
        await chmod(target, 0o600);
        const handle = await open(target, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    }
    for (const snapshot of [...snapshots].reverse()) {
      if (snapshot.kind !== "directory") continue;
      await syncDirectory(
        snapshot.relativePath === "." ? stagingRoot : join(stagingRoot, snapshot.relativePath),
      );
    }
    await rename(stagingRoot, snapshotRoot);
    await syncDirectory(dirname(snapshotRoot));
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function makeSourceReadOnly(root: string, snapshots: readonly PathSnapshot[]): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    const path = snapshot.relativePath === "." ? root : join(root, snapshot.relativePath);
    if (snapshot.kind === "directory") {
      await chmod(path, 0o500);
    } else {
      await chmod(path, snapshot.mode & 0o111 ? 0o500 : 0o400);
    }
  }
}
async function makeSourceWritable(root: string, snapshots: readonly PathSnapshot[]): Promise<void> {
  for (const snapshot of snapshots.filter((entry) => entry.kind === "directory")) {
    const path = snapshot.relativePath === "." ? root : join(root, snapshot.relativePath);
    await chmod(path, 0o700);
  }
  for (const snapshot of snapshots.filter((entry) => entry.kind === "file")) {
    await chmod(join(root, snapshot.relativePath), 0o600);
  }
}

async function rollbackPosix(acquisition: PosixAcquisition): Promise<void> {
  await repairSealedSource(acquisition);
  const parent = dirname(acquisition.sourceBoundaryPath);
  const tombstoneStash = join(
    parent,
    `.caplets-rollback-tombstones-${randomBytes(24).toString("hex")}`,
  );
  if (await pathExists(acquisition.sourceBoundaryPath)) {
    await rename(acquisition.sourceBoundaryPath, tombstoneStash);
    await syncDirectory(parent);
  }
  try {
    await rename(acquisition.sealedSourcePath, acquisition.sourceBoundaryPath);
    await syncDirectory(parent);
  } catch (error) {
    if (await pathExists(tombstoneStash)) {
      await rename(tombstoneStash, acquisition.sourceBoundaryPath).catch(() => undefined);
      await syncDirectory(parent).catch(() => undefined);
    }
    throw error;
  }
  await acquisition.options.hooks?.afterRollbackSourceRestored?.();
  await rm(tombstoneStash, { recursive: true, force: true });
  await rm(acquisition.recoverySnapshotPath, { recursive: true, force: true });
  await syncDirectory(parent);
  await acquisition.options.hooks?.afterRollbackTombstonesRemoved?.();
  await removeExclusionJournal(acquisition.journalPath);
}

async function repairSealedSource(acquisition: PosixAcquisition): Promise<void> {
  if (!(await pathExists(acquisition.recoverySnapshotPath))) {
    for (const snapshot of acquisition.snapshots) {
      const path =
        snapshot.relativePath === "."
          ? acquisition.sealedSourcePath
          : join(acquisition.sealedSourcePath, snapshot.relativePath);
      await chmod(path, snapshot.mode);
    }
    return;
  }

  await makeSourceWritable(acquisition.sealedSourcePath, acquisition.snapshots);
  const expected = new Set(acquisition.snapshots.map((snapshot) => snapshot.relativePath));
  const current = await enumeratePathSnapshots(acquisition.sealedSourcePath, false);
  for (const snapshot of [...current].reverse()) {
    if (snapshot.relativePath === "." || expected.has(snapshot.relativePath)) continue;
    await rm(join(acquisition.sealedSourcePath, snapshot.relativePath), {
      recursive: true,
      force: true,
    });
  }
  for (const snapshot of acquisition.snapshots) {
    const target =
      snapshot.relativePath === "."
        ? acquisition.sealedSourcePath
        : join(acquisition.sealedSourcePath, snapshot.relativePath);
    const source =
      snapshot.relativePath === "."
        ? acquisition.recoverySnapshotPath
        : join(acquisition.recoverySnapshotPath, snapshot.relativePath);
    if (snapshot.kind === "directory") {
      await mkdir(target, { recursive: true, mode: 0o700 });
      await chmod(target, 0o700);
    } else {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
      const handle = await open(target, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  for (const snapshot of [...acquisition.snapshots].reverse()) {
    const target =
      snapshot.relativePath === "."
        ? acquisition.sealedSourcePath
        : join(acquisition.sealedSourcePath, snapshot.relativePath);
    await chmod(target, snapshot.mode);
  }
  const repaired = await enumeratePathSnapshots(acquisition.sealedSourcePath, true);
  if (
    !sameSnapshotContents(repaired, acquisition.snapshots) ||
    !sameSnapshotIdentities(repaired, acquisition.snapshots) ||
    !hasOriginalModes(repaired, acquisition.snapshots)
  ) {
    refuse("The exact legacy source could not be restored before tombstone removal.");
  }
}

async function scanPlatform(
  platform: "linux" | "darwin",
  input: {
    sealedBoundaryPath: string;
    identities: readonly RelocatedPathIdentity[];
    mode: "automatic" | "offline";
    options: AcquireLegacyMigrationExclusionOptions;
  },
): Promise<PlatformExclusionEvidence> {
  if (platform === "linux") {
    return scanLinuxRelocatedHandles({
      sealedBoundaryPath: input.sealedBoundaryPath,
      identities: input.identities,
      mode: input.mode,
      ...(input.options.platformOptions?.linux
        ? { options: input.options.platformOptions.linux }
        : {}),
    });
  }
  return scanMacosRelocatedHandles({
    sealedBoundaryPath: input.sealedBoundaryPath,
    identities: input.identities,
    mode: input.mode,
    ...(input.options.platformOptions?.macos
      ? { options: input.options.platformOptions.macos }
      : {}),
  });
}
type OfflinePathAcquisition = {
  sourcePath: string;
  logicalPath: string;
  kind: "file" | "directory";
  sealedContainerPath: string;
  sealedPayloadPath: string;
  recoverySnapshotPath: string;
  tombstoneStagingPath: string;
  journalPath: string;
  snapshots: PathSnapshot[];
  tombstoneSnapshots: PathSnapshot[];
  options: AcquireLegacyMigrationExclusionOptions;
};

type OfflinePathJournal = {
  version: 2;
  phase: ExclusionJournalPhase;
  sourcePath: string;
  logicalPath: string;
  kind: "file" | "directory";
  sealedContainerPath: string;
  recoverySnapshotPath: string;
  tombstoneStagingPath: string;
  snapshots?: PathSnapshot[];
  tombstoneSnapshots?: PathSnapshot[];
};

async function acquireOfflineSourcePaths(
  options: AcquireLegacyMigrationExclusionOptions,
  platform: "linux" | "darwin",
): Promise<LegacyMigrationExclusion> {
  const sources = validateOfflineSourcePaths(options.offlineSourcePaths ?? []);
  const activationCommitted = (
    await Promise.all(
      sources.map((source) =>
        offlineJournalClaimsActivation(offlineJournalPath(source.sourcePath)),
      ),
    )
  ).some(Boolean);
  if (activationCommitted) {
    for (const source of sources) {
      await reconcileOfflineJournal(offlineJournalPath(source.sourcePath), options, source, true);
    }
    refuse(
      "A previous offline migration activation was reconciled; every legacy namespace remains closed.",
    );
  }
  const acquisitions: OfflinePathAcquisition[] = [];
  try {
    for (const source of sources) {
      acquisitions.push(await prepareOfflinePath(options, source));
    }
    await options.hooks?.afterSourceRelocated?.({
      sealedSourcePath: acquisitions[0]?.sealedContainerPath ?? "",
    });
    await options.hooks?.afterTombstonesPublished?.({
      sealedSourcePath: acquisitions[0]?.sealedContainerPath ?? "",
    });
    const initialEvidence = await scanOfflinePaths(acquisitions, platform);
    await options.hooks?.afterInitialScan?.({
      sealedSourcePath: acquisitions[0]?.sealedContainerPath ?? "",
    });
    for (const acquisition of acquisitions) await sealOfflinePath(acquisition);
    return createOfflineLease(acquisitions, platform, initialEvidence);
  } catch (error) {
    await rollbackOfflinePaths(acquisitions).catch(() => {
      throw new CapletsError(
        "INTERNAL_ERROR",
        "Legacy migration exclusion failed and exact multi-root rollback could not be completed.",
      );
    });
    throw exclusionError(error);
  }
}

async function prepareOfflinePath(
  options: AcquireLegacyMigrationExclusionOptions,
  source: LegacyOfflineSourcePath,
): Promise<OfflinePathAcquisition> {
  const sourcePath = resolve(source.sourcePath);
  const parent = dirname(sourcePath);
  const parentMetadata = await lstat(parent, { bigint: true }).catch(() => undefined);
  if (
    !parentMetadata?.isDirectory() ||
    parentMetadata.isSymbolicLink() ||
    (Number(parentMetadata.mode) & 0o077) !== 0 ||
    (typeof process.getuid === "function" && Number(parentMetadata.uid) !== process.getuid())
  ) {
    refuse("Every offline legacy source parent must be an owner-private journal location.");
  }
  const journalPath = offlineJournalPath(sourcePath);
  await reconcileOfflineJournal(journalPath, options, source);
  const metadata = await lstat(sourcePath, { bigint: true }).catch(() => undefined);
  if (
    !metadata ||
    metadata.isSymbolicLink() ||
    (source.kind === "file" ? !metadata.isFile() : !metadata.isDirectory()) ||
    (typeof process.getuid === "function" && Number(metadata.uid) !== process.getuid())
  ) {
    refuse("An offline legacy source did not match its reviewed owner and type.");
  }
  await enumeratePathSnapshots(sourcePath, false);
  const nonce = randomBytes(24).toString("hex");
  const sealedContainerPath = join(parent, `.caplets-sealed-${nonce}`);
  const acquisition: OfflinePathAcquisition = {
    sourcePath,
    logicalPath: source.logicalPath,
    kind: source.kind,
    sealedContainerPath,
    sealedPayloadPath: join(sealedContainerPath, "payload"),
    recoverySnapshotPath: join(parent, `.caplets-recovery-${nonce}`),
    tombstoneStagingPath: join(parent, `.caplets-tombstone-${nonce}`),
    journalPath,
    snapshots: [],
    tombstoneSnapshots: [],
    options,
  };
  await writeOfflineJournal(acquisition, "prepared");
  try {
    await mkdir(sealedContainerPath, { mode: 0o700 });
    await rename(sourcePath, acquisition.sealedPayloadPath);
    await syncDirectory(parent);
    await writeOfflineJournal(acquisition, "relocated");
    await createOfflineTombstone(acquisition);
    acquisition.tombstoneSnapshots = await enumeratePathSnapshots(sourcePath, true);
    await writeOfflineJournal(acquisition, "tombstones-published");
    return acquisition;
  } catch (error) {
    if (await pathExists(acquisition.sealedPayloadPath)) {
      await rollbackOfflinePaths([acquisition]);
    } else {
      await rm(acquisition.sealedContainerPath, { recursive: true, force: true });
      await rm(acquisition.tombstoneStagingPath, { recursive: true, force: true });
      await removeExclusionJournal(acquisition.journalPath);
    }
    throw error;
  }
}

async function createOfflineTombstone(acquisition: OfflinePathAcquisition): Promise<void> {
  if (acquisition.kind === "file") {
    await mkdir(acquisition.tombstoneStagingPath, { mode: 0o700 });
    await syncDirectory(acquisition.tombstoneStagingPath);
  } else {
    const handle = await open(acquisition.tombstoneStagingPath, "wx", 0o600);
    try {
      await handle.writeFile("caplets legacy migration tombstone\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await rename(acquisition.tombstoneStagingPath, acquisition.sourcePath);
  await syncDirectory(dirname(acquisition.sourcePath));
}

async function sealOfflinePath(acquisition: OfflinePathAcquisition): Promise<void> {
  const snapshots = await enumeratePathSnapshots(acquisition.sealedContainerPath, false);
  await createRecoverySnapshot(
    acquisition.sealedContainerPath,
    acquisition.recoverySnapshotPath,
    snapshots,
  );
  const recovery = await enumeratePathSnapshots(acquisition.recoverySnapshotPath, true);
  const source = await enumeratePathSnapshots(acquisition.sealedContainerPath, true);
  if (!sameSnapshotContents(source, recovery)) {
    refuse("A relocated offline legacy source changed while recovery was sealed.");
  }
  acquisition.snapshots = source;
  await writeOfflineJournal(acquisition, "recovery-durable");
  await makeSourceReadOnly(acquisition.sealedContainerPath, source);
  const sealed = await enumeratePathSnapshots(acquisition.sealedContainerPath, true);
  if (
    !sameSnapshotContents(sealed, source) ||
    !sameSnapshotIdentities(sealed, source) ||
    !hasSealedModes(sealed, source)
  ) {
    refuse("A relocated offline legacy source changed before immutable sealing completed.");
  }
}

function createOfflineLease(
  acquisitions: OfflinePathAcquisition[],
  platform: "linux" | "darwin",
  initialEvidence: PlatformExclusionEvidence,
): LegacyMigrationExclusion {
  let state: LegacyExclusionState = "acquired";
  const sources = acquisitions.map(offlineSealedSource);
  const identities = sources.flatMap((source) => source.identities);
  const manifestSha256 = hashOfflineAcquisitions(acquisitions);
  return {
    sealedSource: {
      path: acquisitions[0]?.sealedContainerPath ?? "",
      manifestSha256,
      identities,
      sources,
    },
    tombstonePaths: acquisitions.map((entry) => entry.sourcePath),
    initialEvidence,
    get state() {
      return state;
    },
    async verifyFinalScanAndRehash() {
      if (state !== "acquired") refuse("Legacy migration exclusion is no longer active.");
      const platformEvidence = await scanOfflinePaths(acquisitions, platform);
      for (const acquisition of acquisitions) {
        const tombstone = await enumeratePathSnapshots(acquisition.sourcePath, true);
        const current = await enumeratePathSnapshots(acquisition.sealedContainerPath, true);
        if (
          !sameSnapshotContents(tombstone, acquisition.tombstoneSnapshots) ||
          !sameSnapshotIdentities(tombstone, acquisition.tombstoneSnapshots) ||
          !sameSnapshotContents(current, acquisition.snapshots) ||
          !sameSnapshotIdentities(current, acquisition.snapshots) ||
          !hasSealedModes(current, acquisition.snapshots)
        ) {
          refuse("The exact offline legacy source or tombstone changed before activation.");
        }
      }
      const currentManifest = hashOfflineAcquisitions(acquisitions);
      if (currentManifest !== manifestSha256) {
        refuse("The sealed offline legacy source mapping changed after process exclusion.");
      }
      return { manifestSha256, platformEvidence };
    },
    async rollbackBeforeActivation() {
      if (state === "rolled-back") return;
      if (state !== "acquired")
        refuse("Activated legacy migration exclusion cannot be rolled back.");
      await rollbackOfflinePaths(acquisitions);
      state = "rolled-back";
    },
    async completeActivation(input) {
      if (state !== "acquired" || input.protectedRecoveryDurable !== true) {
        refuse("Protected recovery must be durable before migration activation completes.");
      }
      await this.verifyFinalScanAndRehash();
      for (const acquisition of acquisitions) {
        await writeOfflineJournal(acquisition, "activation-cleanup");
      }
      await acquisitions[0]?.options.hooks?.afterActivationJournalDurable?.({
        sealedSourcePath: acquisitions[0]?.sealedContainerPath ?? "",
      });
      for (const acquisition of acquisitions) {
        await makeSourceWritable(acquisition.sealedContainerPath, acquisition.snapshots);
        await rm(acquisition.sealedContainerPath, { recursive: true, force: true });
        await rm(acquisition.recoverySnapshotPath, { recursive: true, force: true });
        await syncDirectory(dirname(acquisition.sourcePath));
        await removeExclusionJournal(acquisition.journalPath);
      }
      state = "activated";
    },
    async release() {
      if (state === "acquired") {
        refuse("Legacy migration exclusion must be activated or rolled back before release.");
      }
    },
  };
}

function offlineSealedSource(acquisition: OfflinePathAcquisition): {
  logicalPath: string;
  path: string;
  kind: "file" | "directory";
  identities: RelocatedPathIdentity[];
} {
  return {
    logicalPath: acquisition.logicalPath,
    kind: acquisition.kind,
    path: acquisition.sealedPayloadPath,
    identities: acquisition.snapshots
      .filter((snapshot) => snapshot.relativePath !== ".")
      .map((snapshot) => ({
        relativePath:
          snapshot.relativePath === "payload"
            ? acquisition.logicalPath
            : join(acquisition.logicalPath, relative("payload", snapshot.relativePath)),
        kind: snapshot.kind,
        device: snapshot.device,
        inode: snapshot.inode,
      })),
  };
}

async function scanOfflinePaths(
  acquisitions: readonly OfflinePathAcquisition[],
  platform: "linux" | "darwin",
): Promise<PlatformExclusionEvidence> {
  const evidence: PlatformExclusionEvidence[] = [];
  for (const acquisition of acquisitions) {
    const snapshots = await enumeratePathSnapshots(acquisition.sealedContainerPath, false);
    const identities = snapshots
      .filter((snapshot) => snapshot.relativePath !== ".")
      .map(({ relativePath, kind, device, inode }) => ({ relativePath, kind, device, inode }));
    evidence.push(
      await scanPlatform(platform, {
        sealedBoundaryPath: acquisition.sealedContainerPath,
        identities,
        mode: acquisition.options.mode,
        options: acquisition.options,
      }),
    );
  }
  return {
    platform,
    coverage: "proven",
    gates: [...new Set(evidence.flatMap((entry) => entry.gates))],
    scannedProcesses: evidence.reduce((total, entry) => total + entry.scannedProcesses, 0),
    scannedHandles: evidence.reduce((total, entry) => total + entry.scannedHandles, 0),
  };
}

async function rollbackOfflinePaths(
  acquisitions: readonly OfflinePathAcquisition[],
): Promise<void> {
  const reversed = [...acquisitions].reverse();
  for (const acquisition of reversed) await repairOfflineSource(acquisition);

  const tombstoneStashes = new Map<OfflinePathAcquisition, string>();
  const restored: OfflinePathAcquisition[] = [];
  try {
    for (const acquisition of reversed) {
      const parent = dirname(acquisition.sourcePath);
      const tombstoneStash = join(
        parent,
        `.caplets-rollback-tombstone-${randomBytes(24).toString("hex")}`,
      );
      if (await pathExists(acquisition.sourcePath)) {
        await rename(acquisition.sourcePath, tombstoneStash);
        await syncDirectory(parent);
        tombstoneStashes.set(acquisition, tombstoneStash);
      }
      await rename(acquisition.sealedPayloadPath, acquisition.sourcePath);
      await syncDirectory(parent);
      restored.push(acquisition);
    }
  } catch (error) {
    for (const acquisition of [...restored].reverse()) {
      await rename(acquisition.sourcePath, acquisition.sealedPayloadPath).catch(() => undefined);
      const stash = tombstoneStashes.get(acquisition);
      if (stash) await rename(stash, acquisition.sourcePath).catch(() => undefined);
      await syncDirectory(dirname(acquisition.sourcePath)).catch(() => undefined);
    }
    const pending = reversed.find((acquisition) => !restored.includes(acquisition));
    const pendingStash = pending && tombstoneStashes.get(pending);
    if (pending && pendingStash && !(await pathExists(pending.sourcePath))) {
      await rename(pendingStash, pending.sourcePath).catch(() => undefined);
      await syncDirectory(dirname(pending.sourcePath)).catch(() => undefined);
    }
    throw error;
  }

  if (restored.length > 0) {
    await acquisitions[0]?.options.hooks?.afterRollbackSourceRestored?.();
  }
  for (const acquisition of reversed) {
    const parent = dirname(acquisition.sourcePath);
    const tombstoneStash = tombstoneStashes.get(acquisition);
    if (tombstoneStash) await rm(tombstoneStash, { recursive: true, force: true });
    await rm(acquisition.sealedContainerPath, { recursive: true, force: true });
    await rm(acquisition.recoverySnapshotPath, { recursive: true, force: true });
    await syncDirectory(parent);
    await removeExclusionJournal(acquisition.journalPath);
  }
  if (restored.length > 0) {
    await acquisitions[0]?.options.hooks?.afterRollbackTombstonesRemoved?.();
  }
}

async function repairOfflineSource(acquisition: OfflinePathAcquisition): Promise<void> {
  if (acquisition.snapshots.length === 0) {
    acquisition.snapshots = await enumeratePathSnapshots(acquisition.sealedContainerPath, false);
  }
  if (!(await pathExists(acquisition.recoverySnapshotPath))) {
    await makeSourceWritable(acquisition.sealedContainerPath, acquisition.snapshots);
    for (const snapshot of [...acquisition.snapshots].reverse()) {
      const path =
        snapshot.relativePath === "."
          ? acquisition.sealedContainerPath
          : join(acquisition.sealedContainerPath, snapshot.relativePath);
      await chmod(path, snapshot.mode);
    }
    return;
  }
  const recovery = await enumeratePathSnapshots(acquisition.recoverySnapshotPath, true);
  acquisition.snapshots = mergeSnapshotContents(acquisition.snapshots, recovery);
  await makeSourceWritable(acquisition.sealedContainerPath, acquisition.snapshots);
  const expected = new Set(acquisition.snapshots.map((snapshot) => snapshot.relativePath));
  const current = await enumeratePathSnapshots(acquisition.sealedContainerPath, false);
  for (const snapshot of [...current].reverse()) {
    if (snapshot.relativePath === "." || expected.has(snapshot.relativePath)) continue;
    await rm(join(acquisition.sealedContainerPath, snapshot.relativePath), {
      recursive: true,
      force: true,
    });
  }
  for (const snapshot of acquisition.snapshots) {
    if (snapshot.relativePath === ".") continue;
    const target = join(acquisition.sealedContainerPath, snapshot.relativePath);
    const source = join(acquisition.recoverySnapshotPath, snapshot.relativePath);
    if (snapshot.kind === "directory") {
      await mkdir(target, { recursive: true, mode: 0o700 });
    } else {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
      const handle = await open(target, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  for (const snapshot of [...acquisition.snapshots].reverse()) {
    const target =
      snapshot.relativePath === "."
        ? acquisition.sealedContainerPath
        : join(acquisition.sealedContainerPath, snapshot.relativePath);
    await chmod(target, snapshot.mode);
  }
}

function hashOfflineAcquisitions(acquisitions: readonly OfflinePathAcquisition[]): string {
  const hash = createHash("sha256");
  for (const acquisition of [...acquisitions].sort((a, b) =>
    a.logicalPath.localeCompare(b.logicalPath),
  )) {
    hash.update(`${acquisition.logicalPath}\0${acquisition.kind}\0`);
    hash.update(hashSnapshots(acquisition.snapshots));
  }
  return hash.digest("hex");
}

function validateOfflineSourcePaths(
  sources: readonly LegacyOfflineSourcePath[],
): LegacyOfflineSourcePath[] {
  if (sources.length === 0) refuse("At least one reviewed offline legacy source is required.");
  const normalized = sources.map((source) => ({
    sourcePath: resolve(source.sourcePath),
    logicalPath: source.logicalPath.split(/[\\/]/u).join("/"),
    kind: source.kind,
  }));
  for (const [index, source] of normalized.entries()) {
    if (
      !source.logicalPath ||
      isAbsolute(source.logicalPath) ||
      source.logicalPath === "." ||
      source.logicalPath.split("/").some((part) => !part || part === "." || part === "..") ||
      (source.kind !== "file" && source.kind !== "directory") ||
      normalized.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          (other.sourcePath === source.sourcePath ||
            pathContains(source.sourcePath, other.sourcePath) ||
            pathContains(other.sourcePath, source.sourcePath) ||
            other.logicalPath === source.logicalPath ||
            other.logicalPath.startsWith(`${source.logicalPath}/`) ||
            source.logicalPath.startsWith(`${other.logicalPath}/`)),
      )
    ) {
      refuse("Offline legacy sources must be unique, non-overlapping physical and logical paths.");
    }
  }
  return normalized.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
}

function pathContains(parent: string, child: string): boolean {
  const nested = relative(parent, child);
  return nested !== "" && nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
}

function offlineJournalPath(sourcePath: string): string {
  const name = createHash("sha256").update(sourcePath).digest("hex").slice(0, 32);
  return join(dirname(sourcePath), `.caplets-offline-exclusion-${name}.journal`);
}

async function writeOfflineJournal(
  acquisition: OfflinePathAcquisition,
  phase: ExclusionJournalPhase,
): Promise<void> {
  const journal: OfflinePathJournal = {
    version: 2,
    phase,
    sourcePath: acquisition.sourcePath,
    logicalPath: acquisition.logicalPath,
    kind: acquisition.kind,
    sealedContainerPath: acquisition.sealedContainerPath,
    recoverySnapshotPath: acquisition.recoverySnapshotPath,
    tombstoneStagingPath: acquisition.tombstoneStagingPath,
    ...(acquisition.snapshots.length > 0 ? { snapshots: acquisition.snapshots } : {}),
    ...(acquisition.tombstoneSnapshots.length > 0
      ? { tombstoneSnapshots: acquisition.tombstoneSnapshots }
      : {}),
  };
  const temporaryPath = `${acquisition.journalPath}.${randomBytes(16).toString("hex")}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(journal)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, acquisition.journalPath);
  await syncDirectory(dirname(acquisition.journalPath));
}

async function offlineJournalClaimsActivation(journalPath: string): Promise<boolean> {
  if (!(await pathExists(journalPath))) return false;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(journalPath, "utf8"));
  } catch {
    refuse("An offline exclusion journal is malformed.");
  }
  return isRecord(value) && value.version === 2 && value.phase === "activation-cleanup";
}

async function reconcileOfflineJournal(
  journalPath: string,
  options: AcquireLegacyMigrationExclusionOptions,
  source: LegacyOfflineSourcePath,
  completeCommittedActivation = false,
): Promise<void> {
  if (!(await pathExists(journalPath))) return;
  const metadata = await lstat(journalPath, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || (Number(metadata.mode) & 0o077) !== 0) {
    refuse("An offline exclusion journal is not an owner-private regular file.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(journalPath, "utf8"));
  } catch {
    refuse("An offline exclusion journal is malformed.");
  }
  if (
    !isRecord(raw) ||
    raw.version !== 2 ||
    typeof raw.phase !== "string" ||
    ![
      "prepared",
      "relocated",
      "tombstones-published",
      "recovery-durable",
      "activation-cleanup",
    ].includes(raw.phase) ||
    raw.sourcePath !== resolve(source.sourcePath) ||
    raw.logicalPath !== source.logicalPath ||
    raw.kind !== source.kind ||
    typeof raw.sealedContainerPath !== "string" ||
    typeof raw.recoverySnapshotPath !== "string" ||
    typeof raw.tombstoneStagingPath !== "string"
  ) {
    refuse("An offline exclusion journal does not match the reviewed source mapping.");
  }
  const parent = dirname(resolve(source.sourcePath));
  if (
    !isJournalArtifact(raw.sealedContainerPath, parent, ".caplets-sealed-") ||
    !isJournalArtifact(raw.recoverySnapshotPath, parent, ".caplets-recovery-") ||
    !isJournalArtifact(raw.tombstoneStagingPath, parent, ".caplets-tombstone-")
  ) {
    refuse("An offline exclusion journal contains an unsafe artifact path.");
  }
  const acquisition: OfflinePathAcquisition = {
    sourcePath: resolve(source.sourcePath),
    logicalPath: source.logicalPath,
    kind: source.kind,
    sealedContainerPath: raw.sealedContainerPath,
    sealedPayloadPath: join(raw.sealedContainerPath, "payload"),
    recoverySnapshotPath: raw.recoverySnapshotPath,
    tombstoneStagingPath: raw.tombstoneStagingPath,
    journalPath,
    snapshots: raw.snapshots === undefined ? [] : parseJournalSnapshots(raw.snapshots),
    tombstoneSnapshots:
      raw.tombstoneSnapshots === undefined ? [] : parseJournalSnapshots(raw.tombstoneSnapshots),
    options,
  };
  if (raw.phase === "activation-cleanup" || completeCommittedActivation) {
    if (acquisition.tombstoneSnapshots.length === 0) {
      throw new CapletsError(
        "INTERNAL_ERROR",
        "Activated offline exclusion journal is incomplete.",
      );
    }
    const tombstone = await enumeratePathSnapshots(acquisition.sourcePath, true);
    if (
      !sameSnapshotContents(tombstone, acquisition.tombstoneSnapshots) ||
      !sameSnapshotIdentities(tombstone, acquisition.tombstoneSnapshots)
    ) {
      refuse("Activated offline legacy tombstones changed before cleanup reconciliation.");
    }
    if (await pathExists(acquisition.sealedContainerPath)) {
      const snapshots =
        acquisition.snapshots.length > 0
          ? acquisition.snapshots
          : await enumeratePathSnapshots(acquisition.sealedContainerPath, false);
      await makeSourceWritable(acquisition.sealedContainerPath, snapshots);
      await rm(acquisition.sealedContainerPath, { recursive: true, force: true });
    }
    await rm(acquisition.recoverySnapshotPath, { recursive: true, force: true });
    await rm(acquisition.tombstoneStagingPath, { recursive: true, force: true });
    await removeExclusionJournal(journalPath);
    return;
  }
  if (await pathExists(acquisition.sealedContainerPath)) {
    await rollbackOfflinePaths([acquisition]);
    return;
  }
  if (raw.phase !== "prepared" || !(await pathExists(acquisition.sourcePath))) {
    throw new CapletsError("INTERNAL_ERROR", "Offline exclusion journal state is irreconcilable.");
  }
  await rm(acquisition.tombstoneStagingPath, { recursive: true, force: true });
  await removeExclusionJournal(journalPath);
}

function validateMutablePaths(paths: readonly LegacyMutablePath[]): LegacyMutablePath[] {
  if (paths.length === 0) refuse("At least one reviewed mutable legacy path is required.");
  const normalized: LegacyMutablePath[] = [];
  for (const path of paths) {
    if (
      !path.relativePath ||
      path.relativePath !== basename(path.relativePath) ||
      path.relativePath === "." ||
      path.relativePath === ".." ||
      path.relativePath.includes(sep) ||
      (path.kind !== "file" && path.kind !== "directory") ||
      normalized.some((entry) => entry.relativePath === path.relativePath)
    ) {
      refuse("Legacy mutable paths must be unique top-level entries in the dedicated boundary.");
    }
    normalized.push({ relativePath: path.relativePath, kind: path.kind });
  }
  return normalized.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function mergeSnapshotContents(
  metadata: readonly PathSnapshot[],
  contents: readonly PathSnapshot[],
): PathSnapshot[] {
  if (!sameSnapshotContents(metadata, contents, true)) {
    refuse("The protected recovery snapshot does not match the relocated source structure.");
  }
  return metadata.map((snapshot, index) => ({
    ...snapshot,
    ...(contents[index]?.contentSha256 ? { contentSha256: contents[index].contentSha256 } : {}),
  }));
}

function sameSnapshotIdentities(
  left: readonly PathSnapshot[],
  right: readonly PathSnapshot[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const expected = right[index];
      return (
        expected !== undefined &&
        entry.relativePath === expected.relativePath &&
        entry.kind === expected.kind &&
        entry.device === expected.device &&
        entry.inode === expected.inode &&
        entry.linkCount === expected.linkCount
      );
    })
  );
}

function hasSealedModes(
  actual: readonly PathSnapshot[],
  original: readonly PathSnapshot[],
): boolean {
  return actual.every((entry, index) => {
    const source = original[index];
    const expected =
      entry.kind === "directory" ? 0o500 : source && source.mode & 0o111 ? 0o500 : 0o400;
    return entry.mode === expected;
  });
}

function hasOriginalModes(
  actual: readonly PathSnapshot[],
  original: readonly PathSnapshot[],
): boolean {
  return actual.every((entry, index) => entry.mode === original[index]?.mode);
}

function sameSnapshotContents(
  left: readonly PathSnapshot[],
  right: readonly PathSnapshot[],
  structureOnly = false,
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const expected = right[index];
    return (
      expected !== undefined &&
      entry.relativePath === expected.relativePath &&
      entry.kind === expected.kind &&
      (entry.kind === "directory" || entry.size === expected.size) &&
      (structureOnly || entry.contentSha256 === expected.contentSha256)
    );
  });
}

function hashSnapshots(snapshots: readonly PathSnapshot[]): string {
  const hash = createHash("sha256");
  for (const snapshot of snapshots) {
    hash.update(
      `${snapshot.relativePath}\0${snapshot.kind}\0${snapshot.mode}\0${snapshot.linkCount}\0${snapshot.kind === "file" ? snapshot.size : 0}\0${snapshot.contentSha256 ?? ""}\0`,
    );
  }
  return hash.digest("hex");
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exclusionError(
  error: unknown,
  code: "REQUEST_INVALID" | "INTERNAL_ERROR" = "REQUEST_INVALID",
): CapletsError {
  return error instanceof CapletsError
    ? error
    : new CapletsError(code, "Legacy migration exclusion could not be completed safely.");
}

function refuse(message: string): never {
  throw new CapletsError("REQUEST_INVALID", message);
}
