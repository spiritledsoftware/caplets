import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CLI_PACKAGE_NAME = "caplets";
export const CORE_PACKAGE_NAME = "@caplets/core";
export const OPENCODE_PACKAGE_NAME = "@caplets/opencode";
export const PI_PACKAGE_NAME = "@caplets/pi";
const fingerprintPattern = /^[0-9a-f]{64}$/;
const safeRunIdentityPattern = /^[a-z0-9][a-z0-9._-]*$/;
const ignoredFingerprintDirectories = new Set([
  ".astro",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

export function createStagingTag(fingerprint, runIdentity) {
  if (typeof fingerprint !== "string" || !fingerprintPattern.test(fingerprint)) {
    throw new Error(
      "A lowercase 64-character SHA-256 fingerprint is required to build a staging tag.",
    );
  }
  if (typeof runIdentity !== "string" || !safeRunIdentityPattern.test(runIdentity)) {
    throw new Error("A nonempty npm-safe run identity is required to build a staging tag.");
  }
  return `dev-staged-${fingerprint}-${runIdentity}`;
}

const rootFingerprintFiles = [
  "package.json",
  ".changeset/config.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.json",
  "scripts/dev-snapshot-release.mjs",
  "scripts/runtime-sentry-rolldown.ts",
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
      packages: [...names].sort(),
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
  const releaseSeeds = directPublicReleases.map((release) => release.name);
  if (releaseSeeds.includes(CLI_PACKAGE_NAME) && publicByName.has(CORE_PACKAGE_NAME)) {
    releaseSeeds.push(CORE_PACKAGE_NAME);
  }
  const closureNames = expandPublicReleaseClosure(releaseSeeds, manifests);
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
function releaseChangesetIds(release) {
  const changesets = Array.isArray(release.changesets) ? release.changesets : [];
  return [...new Set(changesets.filter((id) => typeof id === "string"))].sort();
}

function relevantChangesetIds(manifest) {
  return [...new Set(manifest.releases.flatMap(releaseChangesetIds))].sort();
}

function collectRelevantChangesetFiles(manifest, root) {
  const relevantChangesets = new Set(relevantChangesetIds(manifest));
  return listChangesetFiles(root).filter((file) =>
    relevantChangesets.has(file.slice(".changeset/".length, -".md".length)),
  );
}

function canonicalReleaseIntent(manifest) {
  return manifest.releases
    .map((release) => ({
      name: release.name,
      oldVersion: release.oldVersion ?? null,
      newVersion: release.newVersion ?? null,
      type: release.type ?? null,
      direct: release.direct === true,
      changesets: releaseChangesetIds(release),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function hashFile(path, hash) {
  hash.update(readFileSync(path));
}

function isTestFile(name) {
  return /(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$/.test(name);
}

function walkFiles(path, files) {
  if (!existsSync(path)) return;
  const stats = statSync(path);
  if (stats.isFile()) {
    if (!isTestFile(path.split(sep).at(-1))) files.push(path);
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      (ignoredFingerprintDirectories.has(entry.name) ||
        entry.name === "test" ||
        entry.name === "tests" ||
        entry.name === "__tests__")
    ) {
      continue;
    }
    if (entry.isFile() && isTestFile(entry.name)) continue;
    walkFiles(join(path, entry.name), files);
  }
}

export function collectRelevantFingerprintFiles(manifest, root = repoRoot) {
  const files = [];
  for (const relativePath of collectRelevantChangesetFiles(manifest, root)) {
    files.push(join(root, relativePath));
  }
  for (const relativePath of rootFingerprintFiles) {
    const absolutePath = join(root, relativePath);
    if (existsSync(absolutePath)) files.push(absolutePath);
  }
  for (const release of manifest.releases) {
    walkFiles(join(root, release.directory), files);
  }
  if (manifest.releases.some((release) => release.name === CORE_PACKAGE_NAME)) {
    walkFiles(join(root, "apps", "dashboard"), files);
  }
  if (manifest.releases.some((release) => release.name === CLI_PACKAGE_NAME)) {
    const readme = join(root, "README.md");
    if (existsSync(readme)) files.push(readme);
  }
  return [...new Set(files)].sort();
}

export function computeRelevantFingerprint(manifest, root = repoRoot) {
  const hash = createHash("sha256");
  const files = collectRelevantFingerprintFiles(manifest, root);
  hash.update(JSON.stringify(canonicalReleaseIntent(manifest)));
  hash.update("\0");
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
    changesetFiles: collectRelevantChangesetFiles(manifest, root),
  };
}

export function patchSnapshotConfig(root = repoRoot) {
  const config = readJson(join(root, ".changeset", "config.json"));
  return {
    ...config,
    snapshot: {
      ...config.snapshot,
      useCalculatedVersion: true,
      prereleaseTemplate: "{tag}-{commit}-{datetime}",
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
  const snapshotSuffix = snapshotManifest.releases
    .map((release) => {
      const version = publicPackages.get(release.name)?.version;
      const plannedVersion = release.newVersion;
      if (typeof version !== "string" || typeof plannedVersion !== "string") return undefined;
      const prefix = `${plannedVersion}-`;
      return version.startsWith(prefix) ? version.slice(prefix.length) : undefined;
    })
    .find(Boolean);
  return {
    ...snapshotManifest,
    releases: snapshotManifest.releases.map((release) => {
      const version = publicPackages.get(release.name)?.version;
      if (typeof version !== "string") return release;
      if (version !== release.newVersion) {
        return { ...release, newVersion: version };
      }
      if (!snapshotSuffix) {
        throw new Error(`Could not derive a snapshot suffix for closure package ${release.name}.`);
      }
      return { ...release, newVersion: `${version}-${snapshotSuffix}` };
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

const dependencySectionNames = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function snapshotReleaseMap(snapshotManifest) {
  if (!Array.isArray(snapshotManifest?.releases)) {
    throw new Error("Snapshot manifest releases must be an array.");
  }
  const versions = new Map();
  for (const release of snapshotManifest.releases) {
    if (
      !isRecord(release) ||
      typeof release.name !== "string" ||
      release.name.length === 0 ||
      typeof release.newVersion !== "string" ||
      release.newVersion.length === 0 ||
      versions.has(release.name)
    ) {
      throw new Error("Snapshot manifest contains an invalid release entry.");
    }
    versions.set(release.name, release.newVersion);
  }
  return versions;
}

function validateSnapshotIdentity(snapshotManifest) {
  if (!isRecord(snapshotManifest) || !fingerprintPattern.test(snapshotManifest.fingerprint)) {
    throw new Error("Snapshot manifest requires a lowercase 64-character fingerprint.");
  }
  if (
    typeof snapshotManifest.sourceCommit !== "string" ||
    snapshotManifest.sourceCommit.length === 0
  ) {
    throw new Error("Snapshot manifest requires a source commit.");
  }
  if (typeof snapshotManifest.stagingTag !== "string") {
    throw new Error("Snapshot manifest requires a staging tag.");
  }
  const prefix = `dev-staged-${snapshotManifest.fingerprint}-`;
  const runIdentity = snapshotManifest.stagingTag.slice(prefix.length);
  if (
    !snapshotManifest.stagingTag.startsWith(prefix) ||
    createStagingTag(snapshotManifest.fingerprint, runIdentity) !== snapshotManifest.stagingTag
  ) {
    throw new Error("Snapshot manifest has an invalid staging tag.");
  }
}

export function stampSnapshotMetadata(snapshotManifest, root = repoRoot) {
  validateSnapshotIdentity(snapshotManifest);
  const releaseVersions = snapshotReleaseMap(snapshotManifest);
  const metadata = {
    schema: 1,
    fingerprint: snapshotManifest.fingerprint,
    sourceCommit: snapshotManifest.sourceCommit,
    stagingTag: snapshotManifest.stagingTag,
    releases: Object.fromEntries(releaseVersions),
  };
  const publicPackages = new Map(
    listPublicPublishablePackages(root).map((entry) => [entry.name, entry]),
  );
  for (const release of snapshotManifest.releases) {
    const entry = publicPackages.get(release.name);
    if (!entry) {
      throw new Error(`Missing public package metadata for ${release.name}.`);
    }
    writeJson(entry.path, {
      ...readJson(entry.path),
      capletsSnapshot: metadata,
    });
  }
  return metadata;
}

function readPackument(packuments, packageName) {
  const packument = packuments?.[packageName];
  if (!isRecord(packument)) {
    throw new Error(`Missing registry packument for ${packageName}.`);
  }
  return packument;
}

function readDistTags(packument, packageName) {
  const tags = packument["dist-tags"];
  if (!isRecord(tags)) {
    throw new Error(`Registry packument for ${packageName} has invalid dist-tags.`);
  }
  return tags;
}

function isSha512Integrity(integrity) {
  if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) return false;
  const digest = integrity.slice("sha512-".length);
  if (!/^[A-Za-z0-9+/]{86}==$/.test(digest)) return false;
  try {
    const bytes = Buffer.from(digest, "base64");
    return bytes.length === 64 && bytes.toString("base64") === digest;
  } catch {
    return false;
  }
}

function isTarballUrl(tarball) {
  if (typeof tarball !== "string") return false;
  try {
    const url = new URL(tarball);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function assertExactReleaseMap(releases, expectedVersions, packageName) {
  if (!isRecord(releases)) {
    throw new Error(`Registry metadata for ${packageName} has an invalid release map.`);
  }
  const expectedNames = [...expectedVersions.keys()].sort();
  const actualNames = Object.keys(releases).sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(`Registry metadata for ${packageName} has a mismatched release map.`);
  }
  for (const [name, version] of expectedVersions) {
    if (releases[name] !== version) {
      throw new Error(`Registry metadata for ${packageName} has a mismatched release map.`);
    }
  }
}

function readStagingTags(packument, packageName, fingerprint) {
  const prefix = `dev-staged-${fingerprint}-`;
  return new Set(
    Object.keys(readDistTags(packument, packageName)).filter((tag) => tag.startsWith(prefix)),
  );
}

function validateRegistryGeneration(snapshotManifest, packuments, stagingTag) {
  const releases = snapshotManifest.releases;
  const versionByName = new Map();
  const recordsByName = new Map();
  const artifactsByName = new Map();
  let sourceCommit;

  for (const release of releases) {
    const packument = readPackument(packuments, release.name);
    const tags = readDistTags(packument, release.name);
    const version = tags[stagingTag];
    if (typeof version !== "string" || version.length === 0) {
      throw new Error(`Staging tag ${stagingTag} has no exact version for ${release.name}.`);
    }
    const versions = packument.versions;
    const record = isRecord(versions) ? versions[version] : undefined;
    if (!isRecord(record) || record.name !== release.name || record.version !== version) {
      throw new Error(`Registry version identity does not match ${release.name}@${version}.`);
    }
    const metadata = record.capletsSnapshot;
    if (
      !isRecord(metadata) ||
      metadata.schema !== 1 ||
      metadata.fingerprint !== snapshotManifest.fingerprint ||
      metadata.stagingTag !== stagingTag ||
      typeof metadata.sourceCommit !== "string" ||
      metadata.sourceCommit.length === 0
    ) {
      throw new Error(`Registry snapshot metadata does not match ${release.name}@${version}.`);
    }
    if (sourceCommit === undefined) {
      sourceCommit = metadata.sourceCommit;
    } else if (sourceCommit !== metadata.sourceCommit) {
      throw new Error(
        `Registry snapshot metadata has inconsistent source commits for ${stagingTag}.`,
      );
    }
    const dist = record.dist;
    if (!isRecord(dist) || !isSha512Integrity(dist.integrity) || !isTarballUrl(dist.tarball)) {
      throw new Error(`Registry artifact metadata is invalid for ${release.name}@${version}.`);
    }
    versionByName.set(release.name, version);
    recordsByName.set(release.name, record);
    artifactsByName.set(release.name, {
      integrity: dist.integrity,
      tarball: dist.tarball,
      metadata,
    });
  }

  for (const release of releases) {
    const { metadata } = artifactsByName.get(release.name);
    assertExactReleaseMap(metadata.releases, versionByName, release.name);
    const record = recordsByName.get(release.name);
    for (const sectionName of dependencySectionNames) {
      const dependencies = record[sectionName];
      if (dependencies === undefined) continue;
      if (!isRecord(dependencies)) {
        throw new Error(`Registry dependency metadata is invalid for ${release.name}.`);
      }
      for (const [dependencyName, expectedVersion] of versionByName) {
        if (dependencyName === release.name || !Object.hasOwn(dependencies, dependencyName))
          continue;
        if (dependencies[dependencyName] !== expectedVersion) {
          throw new Error(
            `Registry dependency metadata does not match ${release.name} ${sectionName}.${dependencyName}.`,
          );
        }
      }
    }
  }

  return {
    stagingTag,
    sourceCommit,
    versionByName,
    artifactsByName,
  };
}

function hydrateRegistryManifest(snapshotManifest, generation) {
  return {
    ...snapshotManifest,
    sourceCommit: generation.sourceCommit,
    stagingTag: generation.stagingTag,
    releases: snapshotManifest.releases.map((release) => ({
      ...release,
      newVersion: generation.versionByName.get(release.name),
      integrity: generation.artifactsByName.get(release.name).integrity,
      tarball: generation.artifactsByName.get(release.name).tarball,
    })),
  };
}

export function classifyRegistrySnapshot(snapshotManifest, packuments) {
  validateSnapshotIdentity(snapshotManifest);
  const releaseVersions = snapshotReleaseMap(snapshotManifest);
  if (releaseVersions.size === 0) {
    return {
      action: "fresh",
      stagingTag: snapshotManifest.stagingTag,
      manifest: snapshotManifest,
    };
  }

  const tagsByName = new Map();
  for (const release of snapshotManifest.releases) {
    tagsByName.set(
      release.name,
      readStagingTags(
        readPackument(packuments, release.name),
        release.name,
        snapshotManifest.fingerprint,
      ),
    );
  }
  const allTags = new Set([...tagsByName.values()].flatMap((tags) => [...tags]));
  const completeTags = [...allTags]
    .filter((tag) => [...tagsByName.values()].every((tags) => tags.has(tag)))
    .sort();
  const generations = completeTags.map((tag) => {
    const prefix = `dev-staged-${snapshotManifest.fingerprint}-`;
    const runIdentity = tag.slice(prefix.length);
    createStagingTag(snapshotManifest.fingerprint, runIdentity);
    return validateRegistryGeneration(snapshotManifest, packuments, tag);
  });

  if (generations.length === 0) {
    return {
      action: "fresh",
      stagingTag: snapshotManifest.stagingTag,
      manifest: snapshotManifest,
    };
  }

  const matchingDevGenerations = generations.filter((generation) =>
    snapshotManifest.releases.every(
      (release) =>
        readDistTags(readPackument(packuments, release.name), release.name).dev ===
        generation.versionByName.get(release.name),
    ),
  );
  if (matchingDevGenerations.length === 1) {
    const generation = matchingDevGenerations[0];
    return {
      action: "skip-promoted",
      stagingTag: generation.stagingTag,
      manifest: hydrateRegistryManifest(snapshotManifest, generation),
    };
  }
  if (generations.length > 1) {
    throw new Error(
      `Multiple complete registry staging generations match fingerprint ${snapshotManifest.fingerprint}.`,
    );
  }

  const generation = generations[0];
  const devMatches = snapshotManifest.releases.map(
    (release) =>
      readDistTags(readPackument(packuments, release.name), release.name).dev ===
      generation.versionByName.get(release.name),
  );
  if (devMatches.some(Boolean)) {
    throw new Error(
      `Registry dev tags partially promote staging generation ${generation.stagingTag}.`,
    );
  }
  return {
    action: "reuse-staged",
    stagingTag: generation.stagingTag,
    manifest: hydrateRegistryManifest(snapshotManifest, generation),
  };
}

export async function fetchPublicPackument(packageName, fetchImplementation = globalThis.fetch) {
  if (typeof fetchImplementation !== "function") {
    throw new Error("A fetch implementation is required to read the public npm registry.");
  }
  const response = await fetchImplementation(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
    { headers: { Accept: "application/json", "Cache-Control": "no-cache" } },
  );
  if (!response?.ok) {
    if (response?.status === 404) {
      return { "dist-tags": {}, versions: {} };
    }
    throw new Error(
      `Could not read public registry packument for ${packageName}: ${response?.status}.`,
    );
  }
  const packument = await response.json();
  if (!isRecord(packument)) {
    throw new Error(`Public registry packument for ${packageName} is invalid.`);
  }
  return packument;
}

function recoverySignature(recovery) {
  return JSON.stringify({
    action: recovery.action,
    stagingTag: recovery.stagingTag,
    fingerprint: recovery.manifest.fingerprint,
    sourceCommit: recovery.manifest.sourceCommit,
    releases: recovery.manifest.releases.map((release) => ({
      name: release.name,
      newVersion: release.newVersion,
      integrity: release.integrity,
      tarball: release.tarball,
    })),
  });
}

export async function recoverSnapshotManifest(snapshotManifest, options = {}) {
  const maxAttempts = Number.isInteger(options.maxAttempts)
    ? Math.min(Math.max(options.maxAttempts, 2), 24)
    : 24;
  const pollIntervalMs =
    typeof options.pollIntervalMs === "number" && Number.isFinite(options.pollIntervalMs)
      ? Math.min(Math.max(options.pollIntervalMs, 0), 5_000)
      : 5_000;
  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  const requiredAction = options.requiredAction;
  if (
    requiredAction !== undefined &&
    requiredAction !== "fresh" &&
    requiredAction !== "reuse-staged" &&
    requiredAction !== "skip-promoted"
  ) {
    throw new Error(`Unsupported required registry snapshot action: ${String(requiredAction)}.`);
  }
  let previousSignature;
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const packuments = Object.fromEntries(
        await Promise.all(
          snapshotManifest.releases.map(async (release) => [
            release.name,
            await fetchPublicPackument(release.name, fetchImplementation),
          ]),
        ),
      );
      const recovery = classifyRegistrySnapshot(snapshotManifest, packuments);
      if (requiredAction && recovery.action !== requiredAction) {
        previousSignature = undefined;
        lastError = new Error(
          `Public registry snapshot action is ${recovery.action}, expected ${requiredAction}.`,
        );
      } else {
        const signature = recoverySignature(recovery);
        if (signature === previousSignature) return recovery;
        previousSignature = signature;
        lastError = undefined;
      }
    } catch (error) {
      previousSignature = undefined;
      lastError = error;
    }
    if (attempt + 1 < maxAttempts && pollIntervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
  if (lastError) throw lastError;
  throw new Error("Public registry snapshot state did not stabilize.");
}

export function parseArgs(argv) {
  const [subcommand = "status", ...rest] = argv;
  const options = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (typeof option !== "string" || !option.startsWith("--")) {
      throw new Error(`Unexpected argument: ${String(option)}.`);
    }
    const equalsIndex = option.indexOf("=");
    const key = option.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    const value = equalsIndex === -1 ? rest[index + 1] : option.slice(equalsIndex + 1);
    if (!key || typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw new Error(`Option ${option} requires a value.`);
    }
    if (options.has(key)) {
      throw new Error(`Option --${key} was provided more than once.`);
    }
    options.set(key, value);
    if (equalsIndex === -1) index += 1;
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

function assertAllowedOptions(subcommand, options, allowed) {
  const unknownOptions = [...options.keys()].filter((option) => !allowed.has(option));
  if (unknownOptions.length > 0) {
    throw new Error(
      `Unknown option${unknownOptions.length === 1 ? "" : "s"} for ${subcommand}: ${unknownOptions
        .map((option) => `--${option}`)
        .join(", ")}.`,
    );
  }
}

function printJson(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function runCli(argv = process.argv.slice(2)) {
  const { subcommand, options } = parseArgs(argv);
  if (subcommand === "status") {
    assertAllowedOptions(
      subcommand,
      options,
      new Set(["status-file", "output", "root", "source-commit", "run-identity"]),
    );
    const statusFile = ensureOption(options, "status-file");
    const output = options.get("output");
    const root = options.get("root") ? resolve(options.get("root")) : repoRoot;
    const sourceCommit = options.get("source-commit") ?? process.env.GITHUB_SHA;
    const runIdentity =
      options.get("run-identity") ??
      (process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
        : undefined);
    if (!sourceCommit) throw new Error("Missing required --source-commit option.");
    if (!runIdentity) throw new Error("Missing required --run-identity option.");
    const fingerprinted = withFingerprint(
      deriveChangesetManifest(readJson(statusFile), { repoRoot: root }),
      root,
    );
    const manifest = {
      ...fingerprinted,
      sourceCommit,
      stagingTag: createStagingTag(fingerprinted.fingerprint, runIdentity),
    };
    if (output) writeJson(output, manifest);
    return manifest;
  }
  if (subcommand === "stamp-metadata") {
    assertAllowedOptions(subcommand, options, new Set(["manifest", "root"]));
    const manifestFile = ensureOption(options, "manifest");
    const root = options.get("root") ? resolve(options.get("root")) : repoRoot;
    const metadata = stampSnapshotMetadata(readJson(manifestFile), root);
    return { ok: true, metadata };
  }
  if (subcommand === "recover-manifest") {
    assertAllowedOptions(subcommand, options, new Set(["manifest", "output"]));
    const manifestFile = ensureOption(options, "manifest");
    const output = ensureOption(options, "output");
    const recovery = await recoverSnapshotManifest(readJson(manifestFile));
    const manifest = {
      ...recovery.manifest,
      recoveryAction: recovery.action,
    };
    writeJson(output, manifest);
    return manifest;
  }
  if (subcommand === "patch-snapshot-config") {
    assertAllowedOptions(subcommand, options, new Set(["root"]));
    return writePatchedSnapshotConfig(
      options.get("root") ? resolve(options.get("root")) : repoRoot,
    );
  }
  if (subcommand === "refresh-manifest") {
    assertAllowedOptions(subcommand, options, new Set(["manifest", "output", "root"]));
    const manifestFile = ensureOption(options, "manifest");
    const output = options.get("output") ?? manifestFile;
    const root = options.get("root") ? resolve(options.get("root")) : repoRoot;
    const refreshed = refreshSnapshotManifestVersions(readJson(manifestFile), root);
    writeJson(output, refreshed);
    return refreshed;
  }
  if (subcommand === "rewrite-closure") {
    assertAllowedOptions(subcommand, options, new Set(["manifest", "root"]));
    const manifestFile = ensureOption(options, "manifest");
    const root = options.get("root") ? resolve(options.get("root")) : repoRoot;
    const manifest = readJson(manifestFile);
    rewriteClosureManifests(manifest, root);
    const failures = assertRewrittenClosure(manifest, root);
    if (failures.length > 0) {
      throw new Error(`Closure rewrite failed:\n- ${failures.join("\n- ")}`);
    }
    return { ok: true, rewritten: manifest.releases.map((release) => release.name) };
  }
  throw new Error(`Unknown subcommand: ${subcommand}`);
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  try {
    printJson(await runCli());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
