#!/usr/bin/env node
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const corePackagePath = join(root, "packages/core/package.json");
const coreRequire = createRequire(corePackagePath);
const selection = JSON.parse(await readFile(join(root, "storage/stack-selection.json"), "utf8"));
const envelope = JSON.parse(await readFile(join(root, "storage/benchmark-envelope.json"), "utf8"));
const corePackage = JSON.parse(await readFile(corePackagePath, "utf8"));
const result = {
  version: 1,
  gate: "storage-stack",
  tuple: `${process.release.name}-${process.versions.node}-${process.platform}-${process.arch}`,
  status: "pass",
  selected: {},
  checks: {},
  external: {},
  envelope,
  generatedAt: new Date().toISOString(),
};

try {
  for (const [name, expected] of Object.entries(selection.selected)) {
    const declared = corePackage.dependencies?.[name] ?? corePackage.devDependencies?.[name];
    if (declared !== expected)
      throw new Error(`${name} must be pinned to ${expected}, found ${declared}`);
    const installed = installedVersion(name);
    if (installed !== expected)
      throw new Error(`${name} resolved ${installed}, expected ${expected}`);
    result.selected[name] = { declared, installed };
  }
  const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
  const lockfile = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
  for (const override of selection.workspaceOverrides) {
    if (!workspace.includes(`"${override.package}": "${override.selected}"`)) {
      throw new Error(`workspace override for ${override.package}@${override.selected} is absent`);
    }
    if (!lockfile.includes(`'${override.package}@${override.selected}':`)) {
      throw new Error(`${override.package} override is not locked to ${override.selected}`);
    }
    result.selected[override.package] = {
      declaredOverride: override.selected,
      locked: override.selected,
    };
  }
  result.checks.pins = { status: "pass" };

  const bundler = await readFile(join(root, "packages/core/rolldown.config.ts"), "utf8");
  for (const external of ["better-sqlite3", '"pg"', "drizzle-orm", "@aws-sdk\\/client-s3"]) {
    if (!bundler.includes(external)) throw new Error(`Rolldown external ${external} is absent`);
  }
  result.checks.bundleExternals = { status: "pass" };

  const temporary = await mkdtemp(join(root, "packages/core/.storage-stack-"));
  try {
    const Database = coreRequire("better-sqlite3");
    const database = new Database(join(temporary, "stack.sqlite"));
    database.exec(
      "CREATE TABLE representative (id INTEGER PRIMARY KEY, label TEXT NOT NULL, payload BLOB NOT NULL)",
    );
    const transaction = database.transaction(() => {
      database
        .prepare("INSERT INTO representative (label, payload) VALUES (?, ?)")
        .run("bytes", Buffer.from([0, 1, 2, 255]));
      throw new Error("rollback-spike");
    });
    try {
      transaction();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "rollback-spike") throw error;
    }
    if (database.prepare("SELECT count(*) AS count FROM representative").get().count !== 0) {
      throw new Error("SQLite rollback did not restore the representative table");
    }
    database.exec("BEGIN EXCLUSIVE");
    database.exec("ROLLBACK");
    database.close();

    const { drizzle } = coreRequire("drizzle-orm/better-sqlite3");
    const { sqliteTable, integer, text, blob } = coreRequire("drizzle-orm/sqlite-core");
    const drizzleDatabase = new Database(join(temporary, "drizzle.sqlite"));
    const representative = sqliteTable("representative", {
      id: integer("id").primaryKey(),
      label: text("label").notNull(),
      payload: blob("payload").notNull(),
    });
    drizzleDatabase.exec(
      "CREATE TABLE representative (id INTEGER PRIMARY KEY, label TEXT NOT NULL, payload BLOB NOT NULL)",
    );
    const orm = drizzle(drizzleDatabase);
    orm
      .insert(representative)
      .values({ id: 1, label: "drizzle", payload: Buffer.from([4, 5, 6]) })
      .run();
    const row = orm.select().from(representative).get();
    if (row?.label !== "drizzle" || Buffer.from(row.payload).toString("hex") !== "040506") {
      throw new Error("Drizzle SQLite representative bytes round-trip failed");
    }
    drizzleDatabase.close();
    result.checks.drizzleKit = await checkDrizzleKitGeneration(temporary);
    result.checks.sqlite = { status: "pass", rollback: true, exclusiveLock: true, bytes: true };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  const pg = coreRequire("pg");
  const pgClient = new pg.Client({ connectionString: "postgres://invalid.invalid/caplets" });
  pgClient.end().catch(() => undefined);
  result.checks.pgLoad = { status: "pass" };
  await checkPostgres(pg, result);

  const aws = coreRequire("@aws-sdk/client-s3");
  const s3 = new aws.S3Client({
    endpoint: "https://objects.invalid",
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "explicit-access-key", secretAccessKey: "explicit-secret-key" },
  });
  const s3Commands = [
    new aws.PutObjectCommand({
      Bucket: "caplets",
      Key: "probe",
      Body: Buffer.from("probe"),
      IfNoneMatch: "*",
    }),
    new aws.HeadObjectCommand({ Bucket: "caplets", Key: "probe" }),
    new aws.GetObjectCommand({ Bucket: "caplets", Key: "probe", Range: "bytes=0-1" }),
    new aws.DeleteObjectCommand({ Bucket: "caplets", Key: "probe" }),
  ];
  if (s3Commands.length !== 4 || s3Commands[0].input.IfNoneMatch !== "*") {
    throw new Error("S3 conditional command construction failed");
  }
  s3.destroy();
  result.checks.s3ExplicitCredentials = { status: "pass", defaultCredentialChainUsed: false };
  await checkS3(aws, result);
} catch (error) {
  result.status = "fail";
  result.error = error instanceof Error ? error.message : "unknown stack gate failure";
}

await emitResult(result);
if (result.status !== "pass") process.exitCode = 1;

function installedVersion(name) {
  let entry = coreRequire.resolve(name);
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) {
      const packageJson = JSON.parse(readFileSync(candidate, "utf8"));
      if (packageJson.name === name) return packageJson.version;
    }
    directory = dirname(directory);
  }
  throw new Error(`Could not identify installed version for ${name}`);
}

async function checkPostgres(pg, target) {
  const connectionString = process.env.CAPLETS_TEST_POSTGRES_URL;
  if (!connectionString) {
    target.external.postgres = {
      status: "unavailable",
      reason: "CAPLETS_TEST_POSTGRES_URL is unset",
    };
    if (process.env.CAPLETS_REQUIRE_STORAGE_EXTERNAL === "1") {
      throw new Error("Real Postgres was required but CAPLETS_TEST_POSTGRES_URL is unset");
    }
    return;
  }
  const client = new pg.Client({
    connectionString,
    ssl: process.env.CAPLETS_TEST_POSTGRES_CA
      ? { rejectUnauthorized: true, ca: process.env.CAPLETS_TEST_POSTGRES_CA }
      : undefined,
  });
  try {
    await client.connect();
    const rollbackTable = `caplets_stack_${randomBytes(8).toString("hex")}`;
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [8342751]);
    await client.query(`CREATE TABLE ${rollbackTable} (payload bytea NOT NULL)`);
    await client.query(`INSERT INTO ${rollbackTable} (payload) VALUES ($1)`, [
      Buffer.from([4, 5, 6]),
    ]);
    const bytes = await client.query("SELECT $1::bytea AS payload", [Buffer.from([0, 1, 2, 255])]);
    if (Buffer.from(bytes.rows[0].payload).toString("hex") !== "000102ff") {
      throw new Error("Postgres bytea round-trip failed");
    }
    await client.query("ROLLBACK");
    const rolledBack = await client.query("SELECT to_regclass($1) AS table_name", [rollbackTable]);
    if (rolledBack.rows[0].table_name !== null) {
      throw new Error("Postgres transactional rollback did not remove the representative table");
    }
    target.external.postgres = {
      status: "pass",
      advisoryLock: true,
      transactionalRollback: true,
      bytes: true,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function checkS3(aws, target) {
  const endpoint = process.env.CAPLETS_TEST_S3_ENDPOINT;
  const bucket = process.env.CAPLETS_TEST_S3_BUCKET;
  const accessKeyId = process.env.CAPLETS_TEST_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.CAPLETS_TEST_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    target.external.s3 = {
      status: "unavailable",
      reason: "CAPLETS_TEST_S3_* fixture variables are incomplete",
    };
    if (process.env.CAPLETS_REQUIRE_STORAGE_EXTERNAL === "1") {
      throw new Error(
        "Real S3-compatible storage was required but fixture variables are incomplete",
      );
    }
    return;
  }
  const client = new aws.S3Client({
    endpoint,
    region: process.env.CAPLETS_TEST_S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  if (process.env.CAPLETS_TEST_S3_CREATE_BUCKET === "1") {
    await client.send(new aws.CreateBucketCommand({ Bucket: bucket }));
  }
  const key = `caplets-stack-check/${randomBytes(12).toString("hex")}`;
  const body = Buffer.from("0123456789");
  try {
    await client.send(
      new aws.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, IfNoneMatch: "*" }),
    );
    let immutableConflict = false;
    try {
      await client.send(
        new aws.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, IfNoneMatch: "*" }),
      );
    } catch (error) {
      const statusCode =
        error !== null && typeof error === "object" && "$metadata" in error
          ? error.$metadata?.httpStatusCode
          : undefined;
      if (statusCode === 409 || statusCode === 412) immutableConflict = true;
      else throw error;
    }
    if (!immutableConflict) throw new Error("S3-compatible conditional put replaced an object");
    const head = await client.send(new aws.HeadObjectCommand({ Bucket: bucket, Key: key }));
    const range = await client.send(
      new aws.GetObjectCommand({ Bucket: bucket, Key: key, Range: "bytes=2-5" }),
    );
    const rangeBytes = Buffer.from(await range.Body.transformToByteArray());
    if (head.ContentLength !== body.byteLength || rangeBytes.toString() !== "2345") {
      throw new Error("S3-compatible immutable/head/range behavior failed");
    }
    await client.send(new aws.DeleteObjectCommand({ Bucket: bucket, Key: key }));
    await client.send(new aws.DeleteObjectCommand({ Bucket: bucket, Key: key }));
    target.external.s3 = {
      status: "pass",
      conditionalPut: true,
      head: true,
      range: true,
      delete: true,
    };
  } finally {
    await client
      .send(new aws.DeleteObjectCommand({ Bucket: bucket, Key: key }))
      .catch(() => undefined);
    client.destroy();
  }
}

async function checkDrizzleKitGeneration(temporary) {
  const sqliteSchema = join(temporary, "sqlite-schema.ts");
  const postgresSchema = join(temporary, "postgres-schema.ts");
  const sqliteOutput = join(temporary, "drizzle-sqlite");
  const postgresOutput = join(temporary, "drizzle-postgres");
  await writeFile(
    sqliteSchema,
    [
      'import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";',
      'export const representative = sqliteTable("representative", {',
      '  id: integer("id").primaryKey(),',
      '  label: text("label").notNull(),',
      '  payload: blob("payload").notNull(),',
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    postgresSchema,
    [
      'import { customType, integer, pgTable, text } from "drizzle-orm/pg-core";',
      'const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });',
      'export const representative = pgTable("representative", {',
      '  id: integer("id").primaryKey(),',
      '  label: text("label").notNull(),',
      '  payload: bytea("payload").notNull(),',
      "});",
      "",
    ].join("\n"),
  );
  const configurations = [
    { dialect: "sqlite", schema: sqliteSchema, output: sqliteOutput },
    { dialect: "postgresql", schema: postgresSchema, output: postgresOutput },
  ];
  for (const configuration of configurations) {
    const configPath = join(temporary, `drizzle-${configuration.dialect}.config.ts`);
    await writeFile(
      configPath,
      `export default ${JSON.stringify({
        dialect: configuration.dialect,
        schema: configuration.schema,
        out: configuration.output,
      })};\n`,
    );
    const generated = spawnSync(
      "pnpm",
      [
        "--dir",
        join(root, "packages/core"),
        "exec",
        "drizzle-kit",
        "generate",
        "--config",
        configPath,
      ],
      { encoding: "utf8", env: { ...process.env, CI: "1" } },
    );
    if (generated.status !== 0) {
      throw new Error(
        `Drizzle Kit ${configuration.dialect} generation failed: ${generated.stderr}`,
      );
    }
  }
  const sqliteSql = await generatedSql(sqliteOutput);
  const postgresSql = await generatedSql(postgresOutput);
  if (!/CREATE TABLE [`"]representative[`"]/u.test(sqliteSql) || !/\bblob\b/iu.test(sqliteSql)) {
    throw new Error("Drizzle Kit SQLite schema generation did not preserve representative bytes");
  }
  if (
    !/CREATE TABLE [`"]representative[`"]/u.test(postgresSql) ||
    !/\bbytea\b/iu.test(postgresSql)
  ) {
    throw new Error("Drizzle Kit Postgres schema generation did not preserve representative bytes");
  }
  return { status: "pass", sqliteSchema: true, postgresSchema: true, customBytes: true };
}

async function generatedSql(directory) {
  const file = (await readdir(directory)).find((name) => name.endsWith(".sql"));
  if (!file) throw new Error(`Drizzle Kit generated no SQL in ${directory}`);
  return readFile(join(directory, file), "utf8");
}

async function emitResult(target) {
  const output = `${JSON.stringify(target, null, 2)}\n`;
  process.stdout.write(output);
  const resultDirectory = process.env.CAPLETS_STORAGE_RESULT_DIR;
  if (resultDirectory) {
    await mkdir(resultDirectory, { recursive: true });
    await writeFile(join(resultDirectory, `storage-stack-${target.tuple}.json`), output);
  }
}
