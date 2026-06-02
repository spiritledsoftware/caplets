import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  type Stats,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { discoverCapletFiles, validateCapletFile } from "../caplet-files";
import { resolveProjectCapletsRoot } from "../config";
import { SERVER_ID_PATTERN } from "../config/validation";
import { CapletsError, toSafeError } from "../errors";

type InstallableCaplet = {
  id: string;
  source: string;
  destination: string;
  kind: "file" | "directory";
};

type InstallPlan = InstallableCaplet & {
  sourcePath: string;
  sourceBoundary: string;
};

export function installCaplets(
  repo: string,
  options: {
    capletIds?: string[];
    destinationRoot?: string;
    force?: boolean;
  } = {},
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
      throw new CapletsError(
        "CONFIG_NOT_FOUND",
        `Caplet ${missing.join(", ")} not found in ${sourceRoot}`,
      );
    }
    if (selected.length === 0) {
      throw new CapletsError("CONFIG_NOT_FOUND", `No Caplets found in ${sourceRoot}`);
    }
    rejectDuplicateSourceIds(selected);

    for (const caplet of selected) {
      validateCapletFile(caplet.path);
    }
    const installed = preflightInstallCaplets(selected, {
      destinationRoot,
      force: Boolean(options.force),
      repoRoot: source.repoRoot,
      sourceId: source.id,
    }).map((plan) => installOneCaplet(plan, { force: Boolean(options.force) }));
    return { installed };
  } finally {
    source.cleanup();
  }
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
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      candidates.push({ id, path: filePath });
    }

    const directoryPath = join(sourceRoot, id, "CAPLET.md");
    if (existsSync(directoryPath) && statSync(directoryPath).isFile()) {
      candidates.push({ id, path: directoryPath });
    }
  }
  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}

function resolveInstallSource(repo: string): { id: string; repoRoot: string; cleanup: () => void } {
  if (existsSync(repo) && statSync(repo).isDirectory()) {
    return { id: repo, repoRoot: repo, cleanup: () => {} };
  }

  const normalizedRepo = normalizeGitRepo(repo);
  const repoRoot = mkdtempSync(join(tmpdir(), "caplets-install-"));
  try {
    execFileSync("git", ["clone", "--depth", "1", "--", normalizedRepo, repoRoot], {
      stdio: "ignore",
      timeout: 60_000,
    });
    return {
      id: normalizedRepo,
      repoRoot,
      cleanup: () => removeInstallPath(repoRoot, `temporary install source ${repoRoot}`, true),
    };
  } catch (error) {
    removeInstallPath(repoRoot, `temporary install source ${repoRoot}`, true);
    throw new CapletsError("CONFIG_NOT_FOUND", `Could not clone repo ${repo}`, toSafeError(error));
  }
}

export function normalizeGitRepo(repo: string): string {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    const normalized = repo.endsWith(".git") ? repo.slice(0, -4) : repo;
    return `https://github.com/${normalized}.git`;
  }
  return repo;
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
    removeInstallPath(plan.destination, `existing Caplet destination ${plan.destination}`, false);
  }

  copyInstallPath(plan);
  return {
    id: plan.id,
    source: plan.source,
    destination: plan.destination,
    kind: plan.kind,
  };
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

function copyInstallPath(plan: InstallPlan): void {
  try {
    if (plan.kind === "directory") {
      copyDirectoryCaplet(plan.sourcePath, plan.destination, realpathSync(plan.sourceBoundary));
      return;
    }

    cpSync(plan.sourcePath, plan.destination, {
      recursive: false,
      force: false,
      errorOnExist: true,
    });
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
