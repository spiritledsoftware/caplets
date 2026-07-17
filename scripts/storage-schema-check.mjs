#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const drizzleRoot = join(repositoryRoot, "packages", "core", "drizzle");
const writeManifestChecksums = process.argv.includes("--write-manifest-checksums");
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--write-manifest-checksums");
if (unknownArguments.length > 0) throw new Error(`Unknown argument: ${unknownArguments.join(" ")}`);

const requiredBinaryVersions = await loadRequiredCoreBinaryVersions();
const histories = [];
for (const dialect of ["sqlite", "postgres"]) {
  histories.push(
    await validateHistory(join(drizzleRoot, dialect), dialect, requiredBinaryVersions),
  );
}
assertPairedHistories(histories[0], histories[1]);

const copiedRoot = await mkdtemp(join(tmpdir(), "caplets-storage-schema-"));
try {
  for (const dialect of ["sqlite", "postgres"]) {
    const source = join(drizzleRoot, dialect);
    const destination = join(copiedRoot, dialect);
    await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
    await assertIdenticalTrees(source, destination);
    await validateHistory(destination, dialect, requiredBinaryVersions);
  }
} finally {
  await rm(copiedRoot, { recursive: true, force: true });
}

process.stdout.write(
  `Storage schema check passed for SQLite and Postgres (${requiredBinaryVersions.join(", ")}).\n`,
);

async function validateHistory(directory, dialect, requiredVersions) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const unexpectedDirectories = entries
    .filter((entry) => entry.isDirectory() && entry.name !== "meta")
    .map((entry) => entry.name);
  if (unexpectedDirectories.length > 0) {
    const unexpected = unexpectedDirectories.join(", ");
    throw new Error(`${dialect} migration history has unexpected directories: ${unexpected}`);
  }
  const manifestFiles = files.filter((file) => file.endsWith(".manifest.json"));
  if (manifestFiles.length === 0) throw new Error(`${dialect} migration history has no manifests`);

  const journal = JSON.parse(await readFile(join(directory, "meta", "_journal.json"), "utf8"));
  if (!Array.isArray(journal.entries) || journal.entries.length !== manifestFiles.length) {
    throw new Error(`${dialect} migration journal and manifest counts disagree`);
  }
  const expectedJournalDialect = dialect === "postgres" ? "postgresql" : "sqlite";
  if (journal.dialect !== expectedJournalDialect) {
    throw new Error(`${dialect} migration journal declares the wrong dialect`);
  }

  const metaFiles = (await readdir(join(directory, "meta"), { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const snapshotFiles = metaFiles.filter((file) => file.endsWith("_snapshot.json"));
  const expectedMetaFiles = ["_journal.json", ...snapshotFiles].sort();
  if (JSON.stringify(metaFiles) !== JSON.stringify(expectedMetaFiles)) {
    throw new Error(`${dialect} migration metadata contains unreviewed assets`);
  }
  if (snapshotFiles.length !== manifestFiles.length) {
    throw new Error(`${dialect} migration snapshot and manifest counts disagree`);
  }

  const expectedFiles = new Set();
  const pairedShape = [];
  let previousDestination;
  let previousSnapshotId = "00000000-0000-0000-0000-000000000000";
  const snapshotIds = new Set();
  let previousJournalTime = -1;

  for (const [order, manifestFile] of manifestFiles.entries()) {
    const manifestPath = join(directory, manifestFile);
    const manifestText = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);
    if (
      manifest.formatVersion !== 1 ||
      manifest.dialect !== dialect ||
      manifest.order !== order ||
      manifestFile !== `${manifest.migrationId}.manifest.json`
    ) {
      throw new Error(`${dialect} migration manifest ${manifestFile} is malformed or out of order`);
    }
    if (previousDestination !== undefined && manifest.sourceSchemaVersion !== previousDestination) {
      throw new Error(
        `${dialect} migration schema chain is discontinuous at ${manifest.migrationId}`,
      );
    }
    previousDestination = manifest.destinationSchemaVersion;

    const { manifestSha256, ...unsignedManifest } = manifest;
    const calculatedManifestSha256 = sha256(stableJson(unsignedManifest));
    if (writeManifestChecksums && calculatedManifestSha256 !== manifestSha256) {
      const checksumPattern = /("manifestSha256"\s*:\s*")[a-f0-9]{64}(")/u;
      if (!checksumPattern.test(manifestText)) {
        throw new Error(`${dialect} migration manifest ${manifestFile} has no writable checksum`);
      }
      await writeFile(
        manifestPath,
        manifestText.replace(checksumPattern, `$1${calculatedManifestSha256}$2`),
        "utf8",
      );
      manifest.manifestSha256 = calculatedManifestSha256;
    } else if (calculatedManifestSha256 !== manifestSha256) {
      throw new Error(`${dialect} migration manifest ${manifestFile} checksum drift`);
    }

    for (const binaryVersion of requiredVersions) {
      if (!versionInRange(binaryVersion, manifest.compatibility?.binary)) {
        throw new Error(
          `${dialect} migration ${manifest.migrationId} excludes required binary ${binaryVersion}`,
        );
      }
    }

    expectedFiles.add(manifestFile);
    for (const asset of [manifest.sql, manifest.rollback?.down].filter(Boolean)) {
      if (!asset || !/^[a-zA-Z0-9_.-]+$/u.test(asset.file)) {
        throw new Error(`${dialect} migration ${manifest.migrationId} has an unsafe asset path`);
      }
      expectedFiles.add(asset.file);
      const assetBytes = await readFile(join(directory, asset.file));
      if (sha256(assetBytes) !== asset.sha256) {
        throw new Error(`${dialect} migration asset ${asset.file} checksum drift`);
      }
    }

    const journalEntry = journal.entries[order];
    if (
      journalEntry?.idx !== order ||
      journalEntry.tag !== manifest.migrationId ||
      journalEntry.breakpoints !== true ||
      !Number.isSafeInteger(journalEntry.when) ||
      journalEntry.when <= previousJournalTime
    ) {
      throw new Error(`${dialect} migration journal is inconsistent at order ${order}`);
    }
    previousJournalTime = journalEntry.when;

    const expectedSnapshotFile = `${order.toString().padStart(4, "0")}_snapshot.json`;
    if (snapshotFiles[order] !== expectedSnapshotFile) {
      throw new Error(`${dialect} migration snapshot ordering is inconsistent at order ${order}`);
    }
    const snapshot = JSON.parse(
      await readFile(join(directory, "meta", expectedSnapshotFile), "utf8"),
    );
    if (
      typeof snapshot.id !== "string" ||
      snapshot.id === "00000000-0000-0000-0000-000000000000" ||
      snapshot.prevId !== previousSnapshotId ||
      snapshot.dialect !== expectedJournalDialect
    ) {
      throw new Error(`${dialect} migration snapshot ancestry is inconsistent at order ${order}`);
    }
    if (snapshotIds.has(snapshot.id)) {
      throw new Error(`${dialect} migration snapshot id is duplicated at order ${order}`);
    }
    snapshotIds.add(snapshot.id);
    previousSnapshotId = snapshot.id;

    pairedShape.push({
      order: manifest.order,
      sourceSchemaVersion: manifest.sourceSchemaVersion,
      destinationSchemaVersion: manifest.destinationSchemaVersion,
      phase: manifest.phase,
      classification: manifest.classification,
      executionPolicy: manifest.executionPolicy,
      automatic: manifest.automatic,
      compatibility: manifest.compatibility,
      activationRequirements: manifest.activationRequirements,
      rollback: {
        mode: manifest.rollback?.mode,
        windowSeconds: manifest.rollback?.windowSeconds,
        hasDown: manifest.rollback?.down !== undefined,
        requiresVerifiedBackup: manifest.rollback?.requiresVerifiedBackup,
        requiredRetainedKeyVersions: manifest.rollback?.requiredRetainedKeyVersions,
        failurePolicy: manifest.rollback?.failurePolicy,
      },
    });
  }

  if (JSON.stringify(files) !== JSON.stringify([...expectedFiles].sort())) {
    throw new Error(`${dialect} migration history contains missing or unreviewed top-level assets`);
  }
  return { dialect, pairedShape };
}

function assertPairedHistories(sqlite, postgres) {
  if (stableJson(sqlite.pairedShape) !== stableJson(postgres.pairedShape)) {
    throw new Error("SQLite and Postgres migration histories are not paired");
  }
}

async function assertIdenticalTrees(source, destination) {
  const sourceFiles = await recursiveFiles(source);
  const destinationFiles = await recursiveFiles(destination);
  if (JSON.stringify(sourceFiles) !== JSON.stringify(destinationFiles)) {
    throw new Error(
      `Copied migration assets differ from source at ${relative(repositoryRoot, source)}`,
    );
  }
  for (const file of sourceFiles) {
    const [sourceBytes, destinationBytes] = await Promise.all([
      readFile(join(source, file)),
      readFile(join(destination, file)),
    ]);
    if (sha256(sourceBytes) !== sha256(destinationBytes)) {
      throw new Error(`Copied migration asset checksum drift: ${file}`);
    }
  }
}

async function recursiveFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await recursiveFiles(root, absolute)));
    else if (entry.isFile()) files.push(relative(root, absolute));
    else throw new Error(`Migration asset is not a regular file or directory: ${absolute}`);
  }
  return files;
}

async function loadRequiredCoreBinaryVersions() {
  const packageJson = JSON.parse(
    await readFile(join(repositoryRoot, "packages", "core", "package.json"), "utf8"),
  );
  const versions = new Set([packageJson.version]);
  const changesetDirectory = join(repositoryRoot, ".changeset");
  let bump;
  for (const file of await readdir(changesetDirectory)) {
    if (!file.endsWith(".md") || file === "README.md") continue;
    const contents = await readFile(join(changesetDirectory, file), "utf8");
    const match = contents.match(
      /^---\s*[\s\S]*?^"@caplets\/core":\s*(patch|minor|major)\s*$[\s\S]*?^---/mu,
    );
    if (match?.[1] && bumpRank(match[1]) > bumpRank(bump)) bump = match[1];
  }
  if (bump) versions.add(nextVersion(packageJson.version, bump));
  return [...versions];
}

function bumpRank(bump) {
  return bump === "major" ? 3 : bump === "minor" ? 2 : bump === "patch" ? 1 : 0;
}

function nextVersion(version, bump) {
  const parsed = parseVersion(version);
  if (bump === "major") return `${parsed.major + 1}.0.0`;
  if (bump === "minor") return `${parsed.major}.${parsed.minor + 1}.0`;
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

function versionInRange(version, range) {
  if (!range || typeof range.minimum !== "string" || typeof range.maximumExclusive !== "string") {
    return false;
  }
  return (
    compareVersions(version, range.minimum) >= 0 &&
    compareVersions(version, range.maximumExclusive) < 0
  );
}

function compareVersions(left, right) {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  return (
    leftVersion.major - rightVersion.major ||
    leftVersion.minor - rightVersion.minor ||
    leftVersion.patch - rightVersion.patch
  );
}

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
  if (!match) throw new Error(`Unsupported core version: ${version}`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
