import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { discoverCapletFiles, validateCapletFile } from "../caplet-files.js";
import { resolveCapletsRoot, resolveConfigPath } from "../config.js";
import { CapletsError, toSafeError } from "../errors.js";

type InstallableCaplet = {
  id: string;
  source: string;
  destination: string;
  kind: "file" | "directory";
};

type InstallPlan = InstallableCaplet & {
  sourcePath: string;
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
    const destinationRoot = options.destinationRoot ?? resolveCapletsRoot(resolveConfigPath());
    const available = discoverCapletFiles(sourceRoot);
    const selected =
      selectedIds.size === 0 ? available : available.filter((caplet) => selectedIds.has(caplet.id));
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
      cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(repoRoot, { recursive: true, force: true });
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
  for (const plan of plans) {
    if (existsSync(plan.destination) && !options.force) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Caplet ${plan.id} already exists at ${plan.destination}; pass --force to overwrite it`,
      );
    }
  }

  const writableRoot = nearestExistingParent(options.destinationRoot);
  accessSync(writableRoot, constants.W_OK);
  for (const plan of plans) {
    const destinationParent = existsSync(plan.destination)
      ? dirname(plan.destination)
      : nearestExistingParent(dirname(plan.destination));
    accessSync(destinationParent, constants.W_OK);
  }

  mkdirSync(options.destinationRoot, { recursive: true, mode: 0o700 });
  return plans;
}

function installPlan(
  caplet: { id: string; path: string },
  options: { destinationRoot: string; repoRoot: string; sourceId: string },
): InstallPlan {
  const isDirectory = basename(caplet.path) === "CAPLET.md";
  const sourcePath = isDirectory ? dirname(caplet.path) : caplet.path;
  const sourcePathRelative = relative(options.repoRoot, sourcePath);
  const destination = isDirectory
    ? join(options.destinationRoot, caplet.id)
    : join(options.destinationRoot, `${caplet.id}.md`);

  return {
    id: caplet.id,
    source: `${options.sourceId}#${sourcePathRelative}`,
    sourcePath,
    destination,
    kind: isDirectory ? "directory" : "file",
  };
}

function installOneCaplet(plan: InstallPlan, options: { force: boolean }): InstallableCaplet {
  if (existsSync(plan.destination)) {
    if (!options.force) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Caplet ${plan.id} already exists at ${plan.destination}; pass --force to overwrite it`,
      );
    }
    rmSync(plan.destination, { recursive: true, force: true });
  }

  cpSync(plan.sourcePath, plan.destination, {
    recursive: plan.kind === "directory",
    force: false,
    errorOnExist: true,
  });
  return {
    id: plan.id,
    source: plan.source,
    destination: plan.destination,
    kind: plan.kind,
  };
}

function nearestExistingParent(path: string): string {
  if (existsSync(path)) {
    return path;
  }
  const parent = dirname(path);
  if (parent === path) {
    return parent;
  }
  return nearestExistingParent(parent);
}
