#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const matrix = JSON.parse(await readFile(join(root, "storage/package-matrix.json"), "utf8"));
const requestedId = argumentValue("--tuple") ?? process.env.CAPLETS_STORAGE_TUPLE_ID;
const runtimeKind = process.env.CAPLETS_STORAGE_RUNTIME ?? (process.versions.bun ? "bun" : "node");
const runtimeVersion =
  process.env.CAPLETS_STORAGE_RUNTIME_VERSION ??
  (runtimeKind === "bun" ? process.versions.bun : process.versions.node);
const libc = detectLibc();
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
  const helperFixture = await createPackagedHelperFixture(join(temporary, "windows-helper"));
  const packed = spawnSync(
    packageManager,
    ["--filter", "@caplets/core", "pack", "--pack-destination", temporary],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CAPLETS_REQUIRE_WINDOWS_EXCLUSION_HELPER: "1",
        CAPLETS_WINDOWS_HELPER_ARTIFACT_ROOT: helperFixture.root,
        CAPLETS_WINDOWS_HELPER_PUBLISHER: helperFixture.publisher,
        CAPLETS_WINDOWS_HELPER_TEST_FIXTURE: "1",
      },
      shell: process.platform === "win32",
    },
  );
  if (packed.error) throw packed.error;
  if (packed.status !== 0) {
    if (packed.stdout) process.stderr.write(packed.stdout);
    if (packed.stderr) process.stderr.write(packed.stderr);
    throw new Error("core package packing failed");
  }
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
    packageManager,
    ["--dir", installRoot, "add", join(temporary, archive), "--config.minimum-release-age=0"],
    root,
    process.platform === "win32",
  );
  result.checks.install = { status: "pass" };
  const installedCoreRoot = join(installRoot, "node_modules", "@caplets", "core");
  const installedDistRoot = join(installedCoreRoot, "dist");
  const installedBundles = (await readdir(installedDistRoot, { recursive: true }))
    .filter((path) => path.endsWith(".js"))
    .map((path) => join(installedDistRoot, path));
  const resolverInsideDistNative = (
    await Promise.all(installedBundles.map((path) => readFile(path, "utf8")))
  ).some((source) => source.includes("../../native/windows-exclusion-helper/manifest.json"));
  if (!resolverInsideDistNative) {
    throw new Error("packed Windows exclusion helper manifest resolver escapes dist/native");
  }

  const installedHelperRoot = join(installedCoreRoot, "dist", "native", "windows-exclusion-helper");
  const installedManifest = JSON.parse(
    await readFile(join(installedHelperRoot, "manifest.json"), "utf8"),
  );
  const installedArtifact = installedManifest.architectures?.["win32-x64"];
  if (
    installedArtifact?.publisher !== helperFixture.publisher ||
    installedArtifact.sha256 !== helperFixture.sha256 ||
    createHash("sha256")
      .update(await readFile(join(installedHelperRoot, installedArtifact.file)))
      .digest("hex") !== helperFixture.sha256
  ) {
    throw new Error("packed Windows exclusion helper manifest is invalid");
  }
  result.checks.windowsHelper = {
    status: "pass",
    architectures: ["win32-x64"],
    checksum: true,
    publisherManifest: true,
    resolverInsideDistNative: true,
  };

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
  const unsupported = matrix.unsupported.find(
    (tuple) =>
      matchesRuntime(tuple.runtime) &&
      matchesOperatingSystem(tuple.os) &&
      matchesArchitecture(tuple.arch),
  );
  const localAlternatives = matrix.supported
    .filter(
      (tuple) =>
        (tuple.runtime === runtimeKind || (runtimeKind === "node" && tuple.runtime === "docker")) &&
        tuple.os === process.platform &&
        tuple.arch === process.arch &&
        tuple.libc === libc,
    )
    .map((tuple) => tuple.id);
  const prefix = id
    ? `tuple ${id} is not present in the supported package matrix`
    : `detected runtime tuple ${runtimeKind}-${runtimeVersion}-${process.platform}-${process.arch}-${libc} is unsupported`;
  const reason = unsupported?.reason ?? "this runtime/version tuple has no release-blocking proof";
  const guidance =
    unsupported?.guidance ??
    (localAlternatives.length > 0
      ? `Use a declared tuple: ${localAlternatives.join(", ")}`
      : "Use a declared Node 22/24 or Bun runtime and platform tuple");
  return `${prefix}: ${reason}. ${guidance}. See storage/package-matrix.json`;
}

function detectLibc() {
  if (process.platform !== "linux") return "system";
  const report = process.report?.getReport?.();
  return report?.header?.glibcVersionRuntime ? "glibc" : "musl";
}

function matchesRuntime(runtime = "any") {
  return runtime === "any" || runtime === runtimeKind;
}

function matchesOperatingSystem(os) {
  if (os === "any") return true;
  if (os === "linux-musl") return process.platform === "linux" && libc === "musl";
  return os === process.platform;
}

function matchesArchitecture(architecture) {
  if (architecture === "any") return true;
  if (architecture === "32-bit") return process.arch === "ia32" || process.arch === "arm";
  return architecture.split("/").includes(process.arch);
}

async function createPackagedHelperFixture(directory) {
  const publisher = "CN=Caplets Exclusion Test Publisher";
  const file = "caplets-windows-exclusion-helper-win32-x64.exe";
  const bytes = Buffer.from("caplets-reviewed-windows-helper-package-fixture-v1", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, file), bytes);
  await writeFile(
    join(directory, "manifest.json"),
    `${JSON.stringify({
      version: 1,
      protocolVersion: 1,
      architectures: { "win32-x64": { file, sha256, publisher } },
    })}\n`,
  );
  await writeFile(
    join(directory, "signature-evidence.json"),
    `${JSON.stringify({ [file]: { status: "Valid", publisher, sha256 } })}\n`,
  );
  return { root: directory, publisher, sha256 };
}

function run(command, args, cwd, shell = false) {
  const child = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env, shell });
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
const registries = await Promise.all(
  ["sqlite", "postgres"].map((dialect) => loadMigrationRegistry({ dialect })),
);
if (
  registries.some(
    (registry) =>
      registry.migrations.length === 0 ||
      registry.migrations.some(
        (migration) =>
          !migration.sql ||
          (migration.manifest.rollback.mode === "down" && !migration.downSql),
      ),
  )
) {
  throw new Error("packed migration history is incomplete");
}
const migrationShapes = registries.map((registry) =>
  registry.migrations.map((migration) => ({
    order: migration.manifest.order,
    sourceSchemaVersion: migration.manifest.sourceSchemaVersion,
    destinationSchemaVersion: migration.manifest.destinationSchemaVersion,
    phase: migration.manifest.phase,
    classification: migration.manifest.classification,
    executionPolicy: migration.manifest.executionPolicy,
    automatic: migration.manifest.automatic,
    rollbackMode: migration.manifest.rollback.mode,
  })),
);
if (JSON.stringify(migrationShapes[0]) !== JSON.stringify(migrationShapes[1])) {
  throw new Error("packed SQLite and Postgres migration histories are not paired");
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
