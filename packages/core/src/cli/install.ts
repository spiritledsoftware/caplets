import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { discoverCapletFiles, validateCapletFile } from "../caplet-files";
import { resolveProjectCapletsRoot } from "../config";
import { SERVER_ID_PATTERN } from "../config/validation";
import { CapletsError, toSafeError } from "../errors";
import {
  readCapletsLockfile,
  validateLockfileDestination,
  writeCapletsLockfile,
  type CapletsLockEntry,
  type CapletsLockSource,
} from "./lockfile";

type InstallableCaplet = {
  id: string;
  source: string;
  destination: string;
  kind: "file" | "directory";
  hash?: string | undefined;
  status?: "installed" | "restored" | "updated" | "noop" | undefined;
  lockfile?: string | undefined;
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

export function installCaplets(
  repo: string,
  options: {
    capletIds?: string[];
    destinationRoot?: string;
    force?: boolean;
    lockfilePath?: string | undefined;
    now?: Date | undefined;
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
    const plans = preflightInstallCaplets(selected, {
      destinationRoot,
      force: Boolean(options.force),
      repoRoot: source.repoRoot,
      sourceId: source.id,
    });
    const installed = plans.map((plan) =>
      installOneCaplet(plan, { force: Boolean(options.force) }),
    );
    const installedWithHashes = installed.map((caplet) => ({
      ...caplet,
      hash: hashInstalledArtifact(caplet.destination),
      status: "installed" as const,
      ...(options.lockfilePath ? { lockfile: options.lockfilePath } : {}),
    }));
    if (options.lockfilePath) {
      updateLockfileAfterInstall(options.lockfilePath, plans, installedWithHashes, {
        source,
        now: options.now ?? new Date(),
      });
    }
    return { installed: options.lockfilePath ? installedWithHashes : installed };
  } finally {
    source.cleanup();
  }
}

export function restoreCapletsFromLockfile(options: {
  destinationRoot?: string;
  lockfilePath: string;
  force?: boolean;
  capletIds?: string[] | undefined;
  now?: Date | undefined;
}): { installed: InstallableCaplet[] } {
  const destinationRoot = options.destinationRoot ?? resolveProjectCapletsRoot();
  const lockfile = readCapletsLockfile(options.lockfilePath);
  const selectedIds = new Set(options.capletIds ?? []);
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
    throw new CapletsError(
      "CONFIG_NOT_FOUND",
      `No Caplets found in lockfile ${options.lockfilePath}`,
    );
  }

  const nextEntries = new Map(lockfile.entries.map((entry) => [entry.id, entry]));
  const results: InstallableCaplet[] = [];
  for (const entry of entries) {
    const destination = validateLockfileDestination(destinationRoot, entry.destination);
    const existing = lstatIfExists(destination);
    if (existing) {
      const currentHash = hashInstalledArtifact(destination);
      if (currentHash === entry.installedHash) {
        results.push({
          id: entry.id,
          source: lockSourceDisplay(entry.source),
          destination,
          kind: entry.kind,
          hash: currentHash,
          status: "noop",
          lockfile: options.lockfilePath,
        });
        continue;
      }
      if (!options.force) {
        throw new CapletsError(
          "CONFIG_EXISTS",
          `Caplet ${entry.id} has local modifications at ${destination}; pass --force to replace it`,
        );
      }
    }

    const lockedSource = resolveLockedSource(entry.source);
    try {
      const plan: InstallPlan = {
        id: entry.id,
        source: lockSourceDisplay(entry.source),
        sourcePath: lockedSource.sourcePath,
        sourceBoundary: dirname(lockedSource.sourcePath),
        destination,
        kind: entry.kind,
      };
      preflightInstallCaplets(
        [
          {
            id: entry.id,
            path:
              entry.kind === "directory"
                ? join(lockedSource.sourcePath, "CAPLET.md")
                : lockedSource.sourcePath,
          },
        ],
        {
          destinationRoot,
          force: true,
          repoRoot: lockedSource.repoRoot,
          sourceId: lockSourceDisplay(entry.source),
        },
      );
      installOneCaplet(plan, { force: true });
      const hash = hashInstalledArtifact(destination);
      if (hash !== entry.installedHash) {
        nextEntries.set(entry.id, {
          ...entry,
          installedHash: hash,
          updatedAt: (options.now ?? new Date()).toISOString(),
        });
        writeCapletsLockfile(options.lockfilePath, {
          version: 1,
          entries: [...nextEntries.values()],
        });
      }
      results.push({
        id: entry.id,
        source: lockSourceDisplay(entry.source),
        destination,
        kind: entry.kind,
        hash,
        status: "restored",
        lockfile: options.lockfilePath,
      });
    } finally {
      lockedSource.cleanup();
    }
  }
  return { installed: results };
}

export function updateCapletsFromLockfile(options: {
  destinationRoot?: string;
  lockfilePath: string;
  force?: boolean;
  capletIds?: string[] | undefined;
  now?: Date | undefined;
}): { installed: InstallableCaplet[] } {
  const destinationRoot = options.destinationRoot ?? resolveProjectCapletsRoot();
  const lockfile = readCapletsLockfile(options.lockfilePath);
  const selectedIds = new Set(options.capletIds ?? []);
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
    throw new CapletsError(
      "CONFIG_NOT_FOUND",
      `No Caplets found in lockfile ${options.lockfilePath}`,
    );
  }

  const nextEntries = new Map(lockfile.entries.map((entry) => [entry.id, entry]));
  const results: InstallableCaplet[] = [];
  for (const entry of entries) {
    const destination = validateLockfileDestination(destinationRoot, entry.destination);
    const existing = lstatIfExists(destination);
    if (existing) {
      const currentHash = hashInstalledArtifact(destination);
      if (currentHash !== entry.installedHash && !options.force) {
        throw new CapletsError(
          "CONFIG_EXISTS",
          `Caplet ${entry.id} has local modifications at ${destination}; pass --force to update it`,
        );
      }
    }

    const lockedSource = resolveLockedSource(entry.source, { useResolvedRevision: false });
    try {
      if (!existsSync(lockedSource.sourcePath)) {
        throw new CapletsError("CONFIG_NOT_FOUND", `Locked source for ${entry.id} is unavailable`);
      }
      const nextSource = refreshedLockSource(entry.source, lockedSource);
      const sourceHash =
        entry.kind === "directory"
          ? hashDirectoryCapletInstallSource(
              lockedSource.sourcePath,
              realpathSync(dirname(lockedSource.sourcePath)),
            )
          : hashInstalledArtifact(lockedSource.sourcePath);
      const nextRisk = riskSummaryForSourcePath(lockedSource.sourcePath);
      if (!options.force && riskIncrease(entry.risk, nextRisk)) {
        throw new CapletsError(
          "REQUEST_INVALID",
          `Caplet ${entry.id} update changes its risk profile; pass --force to update it`,
        );
      }
      if (existing && sourceHash === entry.installedHash && !options.force) {
        if (!sameLockSource(entry.source, nextSource)) {
          nextEntries.set(entry.id, {
            ...entry,
            source: nextSource,
            updatedAt: (options.now ?? new Date()).toISOString(),
          });
          writeCapletsLockfile(options.lockfilePath, {
            version: 1,
            entries: [...nextEntries.values()],
          });
        }
        results.push({
          id: entry.id,
          source: lockSourceDisplay(entry.source),
          destination,
          kind: entry.kind,
          hash: entry.installedHash,
          status: "noop",
          lockfile: options.lockfilePath,
        });
        continue;
      }

      const plan: InstallPlan = {
        id: entry.id,
        source: lockSourceDisplay(entry.source),
        sourcePath: lockedSource.sourcePath,
        sourceBoundary: dirname(lockedSource.sourcePath),
        destination,
        kind: entry.kind,
      };
      preflightInstallCaplets(
        [
          {
            id: entry.id,
            path:
              entry.kind === "directory"
                ? join(lockedSource.sourcePath, "CAPLET.md")
                : lockedSource.sourcePath,
          },
        ],
        {
          destinationRoot,
          force: true,
          repoRoot: lockedSource.repoRoot,
          sourceId: lockSourceDisplay(entry.source),
        },
      );
      installOneCaplet(plan, { force: true });
      const hash = hashInstalledArtifact(destination);
      const now = (options.now ?? new Date()).toISOString();
      nextEntries.set(entry.id, {
        ...entry,
        source: nextSource,
        installedHash: hash,
        updatedAt: now,
        risk: nextRisk,
      });
      writeCapletsLockfile(options.lockfilePath, {
        version: 1,
        entries: [...nextEntries.values()],
      });
      results.push({
        id: entry.id,
        source: lockSourceDisplay(entry.source),
        destination,
        kind: entry.kind,
        hash,
        status: "updated",
        lockfile: options.lockfilePath,
      });
    } finally {
      lockedSource.cleanup();
    }
  }
  return { installed: results };
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

function sameLockSource(left: CapletsLockSource, right: CapletsLockSource): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
  const repoRoot = mkdtempSync(join(tmpdir(), "caplets-install-"));
  try {
    execFileSync("git", ["clone", "--depth", "1", "--", normalizedRepo, repoRoot], {
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
    const resolvedRevision = gitRevision(repoRoot);
    return {
      id: normalizedRepo,
      repoRoot,
      sourceKind: "git",
      repository: normalizedRepo,
      resolvedRevision,
      cleanup: () => removeInstallPath(repoRoot, `temporary install source ${repoRoot}`, true),
    };
  } catch (error) {
    removeInstallPath(repoRoot, `temporary install source ${repoRoot}`, true);
    throw new CapletsError("CONFIG_NOT_FOUND", `Could not clone repo ${repo}`, toSafeError(error));
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
  const runtime = isRecord(frontmatter.runtime) ? frontmatter.runtime : undefined;
  const projectBindingRequired =
    isRecord(frontmatter.projectBinding) && frontmatter.projectBinding.required === true;
  const runtimeFeatures = Array.isArray(runtime?.features)
    ? runtime.features.filter((feature): feature is string => typeof feature === "string")
    : undefined;
  const mutating = capletCanMutate(frontmatter);
  const destructive = capletCanDestroy(frontmatter);
  return {
    backendFamilies: backendFamilies.length > 0 ? backendFamilies : ["unknown"],
    safety: derivedSafety({
      backendFamilies,
      auth,
      projectBindingRequired,
      runtimeFeatures: runtimeFeatures ?? [],
      mutating,
      destructive,
      frontmatter,
    }),
    projectBindingRequired,
    authScopes: Array.isArray(auth?.scopes)
      ? auth.scopes.filter((scope): scope is string => typeof scope === "string")
      : undefined,
    runtimeFeatures,
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
    ["openapi", "openapiEndpoint"],
    ["googleDiscovery", "googleDiscoveryApi"],
    ["graphql", "graphqlEndpoint"],
    ["http", "httpApi"],
    ["cli", "cliTools"],
    ["caplets", "capletSet"],
  ];
  return families.flatMap(([family, key]) => (frontmatter[key] === undefined ? [] : [family]));
}

function capletAuth(frontmatter: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const key of [
    "mcpServer",
    "openapiEndpoint",
    "googleDiscoveryApi",
    "graphqlEndpoint",
    "httpApi",
  ]) {
    const backend = frontmatter[key];
    if (isRecord(backend) && isRecord(backend.auth)) return backend.auth;
  }
  return undefined;
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
  return isRecord(mcpServer) && typeof mcpServer.command === "string";
}

function capletCanMutate(frontmatter: Record<string, unknown>): boolean {
  if (frontmatter.graphqlEndpoint !== undefined) return true;
  if (frontmatter.openapiEndpoint !== undefined || frontmatter.googleDiscoveryApi !== undefined) {
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

function hashDirectoryCapletInstallSource(path: string, sourceBoundary: string): string {
  const hash = createHash("sha256");
  hashDirectoryCapletInstallPath(path, "", hash, sourceBoundary);
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

function hashDirectoryCapletInstallPath(
  path: string,
  relativePath: string,
  hash: ReturnType<typeof createHash>,
  sourceBoundary: string,
  seenDirectories = new Set<string>(),
): void {
  const lstat = lstatSync(path);
  const resolvedPath = lstat.isSymbolicLink()
    ? resolveDirectoryCapletSymlink(path, sourceBoundary)
    : path;
  const stats = statSync(resolvedPath);
  if (stats.isDirectory()) {
    const realDirectory = realpathSync(resolvedPath);
    if (seenDirectories.has(realDirectory)) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Directory Caplet symlink ${path} creates a copy cycle`,
      );
    }
    hash.update(`dir\0${relativePath}\0`);
    const childSeenDirectories = new Set(seenDirectories);
    childSeenDirectories.add(realDirectory);
    for (const entry of readdirSync(resolvedPath).sort()) {
      hashDirectoryCapletInstallPath(
        join(resolvedPath, entry),
        relativePath ? `${relativePath}/${entry}` : entry,
        hash,
        sourceBoundary,
        childSeenDirectories,
      );
    }
    return;
  }
  const mode = stats.mode & 0o111 ? "executable" : "plain";
  hash.update(`file\0${relativePath}\0${mode}\0`);
  hash.update(readFileSync(resolvedPath));
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

    cpSync(plan.sourcePath, destination, {
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
