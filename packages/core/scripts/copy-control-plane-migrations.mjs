#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(packageRoot, "drizzle");
const destinationRoot = join(packageRoot, "dist", "control-plane", "migrations");
const checkOnly = process.argv.includes("--check-source");

for (const dialect of ["sqlite", "postgres"]) {
  await validateHistory(join(sourceRoot, dialect), dialect);
}

if (!checkOnly) {
  await rm(destinationRoot, { recursive: true, force: true });
  await mkdir(destinationRoot, { recursive: true });
  for (const dialect of ["sqlite", "postgres"]) {
    await cp(join(sourceRoot, dialect), join(destinationRoot, dialect), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    await validateHistory(join(destinationRoot, dialect), dialect);
  }
}

async function validateHistory(directory, dialect) {
  const entries = await readdir(directory, { withFileTypes: true });
  const manifests = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".manifest.json"))
    .map((entry) => entry.name)
    .sort();
  if (manifests.length === 0) throw new Error(`${dialect} migration history has no manifests`);
  const journal = JSON.parse(await readFile(join(directory, "meta", "_journal.json"), "utf8"));
  if (!Array.isArray(journal.entries) || journal.entries.length !== manifests.length) {
    throw new Error(`${dialect} migration journal and reviewed manifests disagree`);
  }
  const snapshots = (await readdir(join(directory, "meta"))).filter((file) =>
    file.endsWith("_snapshot.json"),
  );
  if (snapshots.length !== manifests.length) {
    throw new Error(`${dialect} migration snapshots and reviewed manifests disagree`);
  }
  for (const [order, manifestFile] of manifests.entries()) {
    const manifest = JSON.parse(await readFile(join(directory, manifestFile), "utf8"));
    if (
      manifest.formatVersion !== 1 ||
      manifest.dialect !== dialect ||
      manifest.order !== order ||
      manifestFile !== `${manifest.migrationId}.manifest.json`
    ) {
      throw new Error(`${dialect} migration manifest ${manifestFile} is malformed`);
    }
    const { manifestSha256, ...unsigned } = manifest;
    if (sha256(stableJson(unsigned)) !== manifestSha256) {
      throw new Error(`${dialect} migration manifest ${manifestFile} checksum drift`);
    }
    for (const asset of [manifest.sql, manifest.rollback?.down].filter(Boolean)) {
      if (!/^[a-zA-Z0-9_.-]+$/u.test(asset.file)) {
        throw new Error(`${dialect} migration manifest ${manifestFile} has an unsafe asset path`);
      }
      if (sha256(await readFile(join(directory, asset.file), "utf8")) !== asset.sha256) {
        throw new Error(`${dialect} migration asset ${asset.file} checksum drift`);
      }
    }
    if (
      manifest.executionPolicy === "automatic-compatible" &&
      !["compatible-expand", "compatible-backfill"].includes(manifest.classification)
    ) {
      throw new Error(
        `${dialect} migration ${manifest.migrationId} has an unsafe automatic policy`,
      );
    }
    if (
      ["incompatible-contract", "finalization"].includes(manifest.classification) &&
      (manifest.automatic ||
        manifest.executionPolicy !== "host-admin" ||
        !manifest.activationRequirements.verifiedSchemaAwareBackup ||
        !manifest.activationRequirements.oldNodesDrained)
    ) {
      throw new Error(`${dialect} migration ${manifest.migrationId} lacks contract safeguards`);
    }
  }
}

function stableJson(value) {
  if (Array.isArray(value))
    return JSON.stringify(value.map((item) => JSON.parse(stableJson(item))));
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = JSON.parse(stableJson(value[key]));
    return JSON.stringify(sorted);
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
