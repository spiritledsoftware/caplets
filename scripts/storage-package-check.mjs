#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const matrix = JSON.parse(await readFile(join(root, "storage/package-matrix.json"), "utf8"));
const requestedId = argumentValue("--tuple") ?? process.env.CAPLETS_STORAGE_TUPLE_ID;
const runtimeKind = process.env.CAPLETS_STORAGE_RUNTIME ?? (process.versions.bun ? "bun" : "node");
const runtimeVersion =
  process.env.CAPLETS_STORAGE_RUNTIME_VERSION ??
  (runtimeKind === "bun" ? process.versions.bun : process.versions.node);
const libc = process.platform === "linux" ? "glibc" : "system";
const detected = matrix.supported.find(
  (tuple) =>
    tuple.runtime === runtimeKind &&
    tuple.version === runtimeVersion &&
    tuple.os === process.platform &&
    tuple.arch === process.arch &&
    tuple.libc === libc,
);
const selected = requestedId
  ? matrix.supported.find((tuple) => tuple.id === requestedId)
  : detected;
const result = {
  version: 1,
  gate: "storage-package",
  tuple:
    requestedId ??
    detected?.id ??
    `${runtimeKind}-${runtimeVersion}-${process.platform}-${process.arch}`,
  status: "fail",
  detected: {
    runtime: runtimeKind,
    version: runtimeVersion,
    os: process.platform,
    arch: process.arch,
    libc,
  },
  checks: {},
  generatedAt: new Date().toISOString(),
};

let temporary;
try {
  if (!selected) {
    throw new Error(unsupportedReason(requestedId));
  }
  if (
    (selected.runtime === "docker" ? "node" : selected.runtime) !== runtimeKind ||
    selected.version !== runtimeVersion ||
    selected.os !== process.platform ||
    selected.arch !== process.arch ||
    selected.libc !== libc
  ) {
    throw new Error(
      `tuple ${selected.id} is unavailable on detected ${runtimeKind}-${runtimeVersion}-${process.platform}-${process.arch}-${libc}`,
    );
  }
  result.checks.tuple = { status: "pass", manifestId: selected.id };

  temporary = await mkdtemp(join(tmpdir(), "caplets-storage-package-"));
  const packed = spawnSync(
    "pnpm",
    ["--filter", "@caplets/core", "pack", "--pack-destination", temporary],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  if (packed.status !== 0) throw new Error("core package packing failed");
  const archive = (await readdir(temporary)).find((name) => name.endsWith(".tgz"));
  if (!archive) throw new Error("core package archive was not produced");
  result.checks.pack = { status: "pass", archive: archive.replace(/\d+\.\d+\.\d+/u, "<version>") };

  const installRoot = join(temporary, "install");
  await mkdir(installRoot);
  await writeFile(
    join(installRoot, "package.json"),
    `${JSON.stringify({ name: "caplets-storage-package-smoke", private: true, type: "module" })}\n`,
  );
  await writeFile(
    join(installRoot, "pnpm-workspace.yaml"),
    `packages:
  - "."
allowBuilds:
  better-sqlite3: true
`,
  );
  run(
    "pnpm",
    ["--dir", installRoot, "add", join(temporary, archive), "--config.minimum-release-age=0"],
    root,
  );
  result.checks.install = { status: "pass" };

  const smokePath = join(installRoot, "smoke.mjs");
  await writeFile(smokePath, packageSmokeSource());
  const runtimeExecutable =
    process.env.CAPLETS_PACKAGE_RUNTIME_EXECUTABLE ||
    (runtimeKind === "bun" ? "bun" : process.execPath);
  run(runtimeExecutable, [smokePath], installRoot);
  result.checks.runtime = {
    status: "pass",
    nativeDriver: true,
    drizzle: true,
    pg: true,
    s3ExplicitCredentials: true,
    storageEntry: true,
    migrationAssets: true,
  };
  result.status = "pass";
} catch (error) {
  result.error = error instanceof Error ? error.message : "unknown package gate failure";
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}

await emitResult(result);
if (result.status !== "pass") process.exitCode = 1;

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function unsupportedReason(id) {
  if (id) return `tuple ${id} is not present in the supported package matrix`;
  const match = matrix.unsupported.find(
    (tuple) =>
      (tuple.os === process.platform ||
        tuple.os === "any" ||
        tuple.os.startsWith(`${process.platform}-`)) &&
      (tuple.arch === process.arch || tuple.arch === "32-bit" || tuple.arch.includes(process.arch)),
  );
  return match?.reason ?? "detected runtime tuple is unavailable and has no passing manifest";
}

function run(command, args, cwd) {
  const child = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (child.error) throw child.error;
  if (child.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed with exit ${child.status}`);
}

async function emitResult(target) {
  const output = `${JSON.stringify(target, null, 2)}\n`;
  process.stdout.write(output);
  const resultDirectory = process.env.CAPLETS_STORAGE_RESULT_DIR;
  if (resultDirectory) {
    await mkdir(resultDirectory, { recursive: true });
    await writeFile(join(resultDirectory, `storage-package-${target.tuple}.json`), output);
  }
}

function packageSmokeSource() {
  return String.raw`
import { createRequire } from "node:module";
import { loadMigrationRegistry } from "@caplets/core/control-plane/dialect/migrations";
import {
  S3ArtifactProvider,
  STORAGE_BENCHMARK_ENVELOPE,
  createArtifactProviderIdentity,
  nearestRank,
} from "@caplets/core/control-plane/storage";

if (STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets !== 2000 || nearestRank([1, 2, 3, 4], 0.75) !== 3) {
  throw new Error("packed storage fixture is invalid");
}
for (const dialect of ["sqlite", "postgres"]) {
  const registry = await loadMigrationRegistry({ dialect });
  if (registry.migrations.length !== 2 || registry.migrations.some((migration) => !migration.sql || !migration.downSql)) {
    throw new Error("packed " + dialect + " migration history is unavailable");
  }
}
const coreRequire = createRequire(import.meta.resolve("@caplets/core/control-plane/storage"));
const bunRuntime = Boolean(process.versions.bun);
const Database = bunRuntime
  ? (await import("bun:sqlite")).Database
  : coreRequire("better-sqlite3");
const { drizzle } = bunRuntime
  ? coreRequire("drizzle-orm/bun-sqlite")
  : coreRequire("drizzle-orm/better-sqlite3");
const { sqliteTable, integer, blob } = coreRequire("drizzle-orm/sqlite-core");
const database = new Database(":memory:");
database.exec("CREATE TABLE smoke (id INTEGER PRIMARY KEY, bytes BLOB NOT NULL)");
const smoke = sqliteTable("smoke", { id: integer("id").primaryKey(), bytes: blob("bytes").notNull() });
const orm = drizzle(database);
orm.insert(smoke).values({ id: 1, bytes: Buffer.from([0, 255]) }).run();
if (Buffer.from(orm.select().from(smoke).get().bytes).toString("hex") !== "00ff") {
  throw new Error("packed native/Drizzle bytes round-trip failed");
}
database.close();
const pg = coreRequire("pg");
const pgClient = new pg.Client({ connectionString: "postgres://invalid.invalid/caplets" });
await pgClient.end().catch(() => undefined);
const aws = coreRequire("@aws-sdk/client-s3");
const s3 = new aws.S3Client({
  endpoint: "https://objects.invalid",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "explicit-access-key", secretAccessKey: "explicit-secret-key" },
});
new aws.PutObjectCommand({ Bucket: "caplets", Key: "smoke", Body: Buffer.from("smoke"), IfNoneMatch: "*" });
new aws.HeadObjectCommand({ Bucket: "caplets", Key: "smoke" });
new aws.GetObjectCommand({ Bucket: "caplets", Key: "smoke", Range: "bytes=0-1" });
new aws.DeleteObjectCommand({ Bucket: "caplets", Key: "smoke" });
s3.destroy();
const identity = createArtifactProviderIdentity({
  kind: "s3",
  provider: "https://objects.invalid/caplets",
  namespace: "smoke",
  logicalHostId: "host_01J00000000000000000000000",
  storeId: "store_01J00000000000000000000000",
});
new S3ArtifactProvider({ send: async () => ({}) }, { bucket: "caplets", prefix: "smoke", identity });
process.stdout.write("storage-package-smoke-ok\n");
`;
}
