import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stableWorkflowPath = ".github/workflows/release.yml";
const devWorkflowPath = ".github/workflows/dev-snapshot-release.yml";

export const CLI_PACKAGE_NAME = "caplets";
export const CORE_PACKAGE_NAME = "@caplets/core";
export const OPENCODE_PACKAGE_NAME = "@caplets/opencode";
export const PI_PACKAGE_NAME = "@caplets/pi";
export function createStagingTag(runIdentifier) {
  if (!runIdentifier || typeof runIdentifier !== "string") {
    throw new Error("A run identifier is required to build a staging tag.");
  }
  return `dev-staged-${runIdentifier}`;
}

const rootFingerprintFiles = [
  "package.json",
  ".changeset/config.json",
  stableWorkflowPath,
  devWorkflowPath,
  "scripts/check-package-runtime.mjs",
  "scripts/dev-snapshot-release.mjs",
  "scripts/check-dev-snapshot-bootstrap.mjs",
];

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function discoverWorkspacePackageManifests(root = repoRoot) {
  const manifests = [];
  for (const workspaceRoot of ["packages", "apps"]) {
    const base = join(root, workspaceRoot);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(base, entry.name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = readJson(manifestPath);
      manifests.push({
        name: manifest.name,
        version: manifest.version,
        private: manifest.private === true,
        publishAccess: manifest.publishConfig?.access,
        path: manifestPath,
        directory: relative(root, dirname(manifestPath)).split(sep).join("/"),
        manifest,
      });
    }
  }
  return manifests;
}

export function isPublicPublishableManifest(entry) {
  return Boolean(entry?.name) && entry.private !== true && entry.publishAccess === "public";
}

export function listPublicPublishablePackages(root = repoRoot) {
  return discoverWorkspacePackageManifests(root).filter(isPublicPublishableManifest);
}

export function buildWorkspaceDependencyGraph(manifests) {
  const names = new Set(manifests.map((entry) => entry.name));
  const dependents = new Map();
  for (const entry of manifests) {
    dependents.set(entry.name, new Set());
  }
  for (const entry of manifests) {
    const dependencySections = [
      entry.manifest.dependencies ?? {},
      entry.manifest.devDependencies ?? {},
      entry.manifest.optionalDependencies ?? {},
      entry.manifest.peerDependencies ?? {},
    ];
    for (const deps of dependencySections) {
      for (const [dependencyName, dependencyRange] of Object.entries(deps)) {
        if (!names.has(dependencyName)) continue;
        if (typeof dependencyRange !== "string") continue;
        if (!dependencyRange.startsWith("workspace:")) continue;
        dependents.get(dependencyName)?.add(entry.name);
      }
    }
  }
  return dependents;
}

export function expandPublicReleaseClosure(releaseNames, manifests) {
  const publicManifests = manifests.filter(isPublicPublishableManifest);
  const dependents = buildWorkspaceDependencyGraph(publicManifests);
  const queue = [...new Set(releaseNames.filter((name) => dependents.has(name)))];
  const visited = new Set(queue);
  while (queue.length > 0) {
    const current = queue.shift();
    for (const dependent of dependents.get(current) ?? []) {
      if (visited.has(dependent)) continue;
      visited.add(dependent);
      queue.push(dependent);
    }
  }
  return [...visited].sort();
}

export function chooseValidationMode(releaseNames) {
  const names = new Set(releaseNames);
  if (names.has(CLI_PACKAGE_NAME) || names.has(CORE_PACKAGE_NAME)) {
    return {
      kind: "cli-bootstrap",
      packages: [CLI_PACKAGE_NAME, CORE_PACKAGE_NAME].filter((name) => names.has(name)),
    };
  }
  return {
    kind: "package-only",
    packages: [...names].sort(),
  };
}

export function toSnapshotVersion(baseVersion, commit, timestamp) {
  return `${baseVersion}-dev-${commit}-${timestamp}`;
}

export function deriveChangesetManifest(statusJson, options = {}) {
  const manifests =
    options.manifests ?? listPublicPublishablePackages(options.repoRoot ?? repoRoot);
  const statusReleases = Array.isArray(statusJson?.releases) ? statusJson.releases : [];
  const publicByName = new Map(manifests.map((entry) => [entry.name, entry]));
  const directPublicReleases = statusReleases.filter(
    (release) => release?.type && release.type !== "none" && publicByName.has(release.name),
  );
  const closureNames = expandPublicReleaseClosure(
    directPublicReleases.map((release) => release.name),
    manifests,
  );
  const releases = closureNames.map((name) => {
    const manifestEntry = publicByName.get(name);
    const release = statusReleases.find((candidate) => candidate.name === name);
    return {
      name,
      directory: manifestEntry.directory,
      oldVersion: release?.oldVersion ?? manifestEntry.version,
      newVersion: release?.newVersion ?? manifestEntry.version,
      type:
        release?.type ??
        (directPublicReleases.some((entry) => entry.name === name) ? "unknown" : "patch"),
      changesets: release?.changesets ?? [],
      direct: directPublicReleases.some((entry) => entry.name === name),
    };
  });
  const validation = chooseValidationMode(closureNames);
  return {
    hasPublicReleases: releases.length > 0,
    releases,
    validation,
  };
}

export function listChangesetFiles(root = repoRoot) {
  const directory = join(root, ".changeset");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .map((name) => `.changeset/${name}`)
    .sort();
}

function hashFile(path, hash) {
  hash.update(readFileSync(path));
}

function walkFiles(path, files) {
  if (!existsSync(path)) return;
  const stats = statSync(path);
  if (stats.isFile()) {
    files.push(path);
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    walkFiles(join(path, entry.name), files);
  }
}

export function collectRelevantFingerprintFiles(manifest, root = repoRoot) {
  const files = [];
  for (const relativePath of rootFingerprintFiles) {
    const absolutePath = join(root, relativePath);
    if (existsSync(absolutePath)) files.push(absolutePath);
  }
  for (const release of manifest.releases) {
    walkFiles(join(root, release.directory), files);
  }
  for (const changesetFile of listChangesetFiles(root)) {
    files.push(join(root, changesetFile));
  }
  return [...new Set(files)].sort();
}

export function computeRelevantFingerprint(manifest, root = repoRoot) {
  const hash = createHash("sha256");
  const files = collectRelevantFingerprintFiles(manifest, root);
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update("\0");
    hashFile(file, hash);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function withFingerprint(manifest, root = repoRoot) {
  return {
    ...manifest,
    fingerprint: computeRelevantFingerprint(manifest, root),
    changesetFiles: listChangesetFiles(root),
  };
}

export function patchSnapshotConfig(root = repoRoot) {
  const config = readJson(join(root, ".changeset", "config.json"));
  return {
    ...config,
    snapshot: {
      ...config.snapshot,
      useCalculatedVersion: true,
      prereleaseTemplate: "dev-{commit}-{datetime}",
    },
  };
}

export function writePatchedSnapshotConfig(root = repoRoot) {
  const patched = patchSnapshotConfig(root);
  writeJson(join(root, ".changeset", "config.json"), patched);
  return patched;
}

export function refreshSnapshotManifestVersions(snapshotManifest, root = repoRoot) {
  const publicPackages = new Map(
    listPublicPublishablePackages(root).map((entry) => [entry.name, readJson(entry.path)]),
  );
  return {
    ...snapshotManifest,
    releases: snapshotManifest.releases.map((release) => {
      const manifest = publicPackages.get(release.name);
      return {
        ...release,
        newVersion: typeof manifest?.version === "string" ? manifest.version : release.newVersion,
      };
    }),
  };
}

export function rewriteClosureManifests(snapshotManifest, root = repoRoot) {
  const publicPackages = new Map(
    listPublicPublishablePackages(root).map((entry) => [entry.name, entry]),
  );
  const versionByName = new Map(
    snapshotManifest.releases.map((release) => [release.name, release.newVersion]),
  );
  for (const release of snapshotManifest.releases) {
    const entry = publicPackages.get(release.name);
    if (!entry) continue;
    const nextManifest = structuredClone(entry.manifest);
    nextManifest.version = release.newVersion;
    for (const sectionName of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const section = nextManifest[sectionName];
      if (!section || typeof section !== "object") continue;
      for (const [dependencyName, dependencyVersion] of Object.entries(section)) {
        if (!versionByName.has(dependencyName)) continue;
        if (typeof dependencyVersion !== "string") continue;
        section[dependencyName] = versionByName.get(dependencyName);
      }
    }
    writeJson(entry.path, nextManifest);
  }
}

export function assertRewrittenClosure(snapshotManifest, root = repoRoot) {
  const publicPackages = new Map(
    listPublicPublishablePackages(root).map((entry) => [entry.name, entry]),
  );
  const versionByName = new Map(
    snapshotManifest.releases.map((release) => [release.name, release.newVersion]),
  );
  const failures = [];
  for (const release of snapshotManifest.releases) {
    const entry = publicPackages.get(release.name);
    if (!entry) {
      failures.push(`Missing public package metadata for ${release.name}.`);
      continue;
    }
    const manifest = readJson(entry.path);
    if (manifest.version !== release.newVersion) {
      failures.push(
        `${release.name} version is ${manifest.version}, expected ${release.newVersion}.`,
      );
    }
    for (const sectionName of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      const section = manifest[sectionName] ?? {};
      for (const [dependencyName, expectedVersion] of versionByName) {
        if (section[dependencyName] === undefined) continue;
        if (section[dependencyName] !== expectedVersion) {
          failures.push(
            `${release.name} ${sectionName}.${dependencyName} is ${section[dependencyName]}, expected ${expectedVersion}.`,
          );
        }
      }
    }
  }
  return failures;
}

export function parseArgs(argv) {
  const [subcommand = "status", ...rest] = argv;
  const options = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key.startsWith("--")) continue;
    options.set(key.slice(2), value ?? "true");
    index += 1;
  }
  return { subcommand, options };
}

function ensureOption(options, key) {
  const value = options.get(key);
  if (!value) {
    throw new Error(`Missing required --${key} option.`);
  }
  return value;
}

function printJson(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const { subcommand, options } = parseArgs(process.argv.slice(2));
  try {
    if (subcommand === "status") {
      const statusFile = ensureOption(options, "status-file");
      const output = options.get("output");
      const manifest = withFingerprint(deriveChangesetManifest(readJson(statusFile)));
      if (output) writeJson(output, manifest);
      printJson(manifest);
    } else if (subcommand === "patch-snapshot-config") {
      const result = writePatchedSnapshotConfig(
        options.get("root") ? resolve(options.get("root")) : repoRoot,
      );
      printJson(result);
    } else if (subcommand === "refresh-manifest") {
      const manifestFile = ensureOption(options, "manifest");
      const output = options.get("output") ?? manifestFile;
      const root = options.get("root") ? resolve(options.get("root")) : repoRoot;
      const refreshed = refreshSnapshotManifestVersions(readJson(manifestFile), root);
      writeJson(output, refreshed);
      printJson(refreshed);
    } else if (subcommand === "rewrite-closure") {
      const manifestFile = ensureOption(options, "manifest");
      const root = options.get("root") ? resolve(options.get("root")) : repoRoot;
      const manifest = readJson(manifestFile);
      rewriteClosureManifests(manifest, root);
      const failures = assertRewrittenClosure(manifest, root);
      if (failures.length > 0) {
        throw new Error(`Closure rewrite failed:\n- ${failures.join("\n- ")}`);
      }
      printJson({ ok: true, rewritten: manifest.releases.map((release) => release.name) });
    } else {
      throw new Error(`Unknown subcommand: ${subcommand}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
