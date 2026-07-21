#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), "caplets-compose-smoke-"));
const image = process.env.CAPLETS_SMOKE_IMAGE || "caplets:compose-smoke";
const projects = [];
const prefix = `caplets-smoke-${process.pid}`;
const smokeEncryptionKey = Buffer.alloc(32, 63).toString("base64url");

try {
  if (!process.env.CAPLETS_SMOKE_IMAGE) {
    phase("Build Caplets image");
    docker(["build", "--tag", image, repoRoot], { stdio: "inherit" });
  }

  await smokeSqlite();
  await smokeConveniencePostgres();
  await smokeHardenedPostgres();
  smokeMigrationGates();
  await smokeLegacyCompatibility();
  console.log("Compose smoke deployments passed.");
} finally {
  for (const project of projects.reverse()) {
    compose(project, ["down", "--volumes", "--remove-orphans"], {
      allowFailure: true,
      stdio: "ignore",
    });
  }
  rmSync(root, { recursive: true, force: true });
}

async function smokeSqlite() {
  phase("SQLite standalone deployment");
  const project = fixture("sqlite", "docker-compose.yml");
  compose(project, ["config", "--quiet"]);
  compose(project, ["up", "-d", "--wait"], { stdio: "inherit" });
  assert.equal((await health(project)).backend, "sqlite");
}

async function smokeConveniencePostgres() {
  phase("Convenience PostgreSQL deployment");
  const env = {
    CAPLETS_POSTGRES_PASSWORD: "convenience-smoke-secret",
    CAPLETS_ENCRYPTION_KEY: smokeEncryptionKey,
  };
  const project = fixture("postgres", "docker-compose.postgres.yml", env);
  compose(project, ["config", "--quiet"]);
  compose(project, ["up", "-d", "--wait"], { stdio: "inherit" });
  assert.equal((await health(project)).backend, "postgres");
  const roles = compose(project, [
    "exec",
    "-T",
    "caplets-postgres",
    "psql",
    "--username",
    "caplets",
    "--dbname",
    "caplets",
    "--tuples-only",
    "--no-align",
    "--command",
    "SELECT r.rolname || ':' || r.rolsuper::text || ':' || r.rolcreatedb::text || ':' || r.rolcreaterole::text || ':' || r.rolreplication::text || ':' || r.rolbypassrls::text || ':' || pg_get_userbyid(d.datdba) || ':' || pg_get_userbyid(n.nspowner) FROM pg_roles r CROSS JOIN pg_database d CROSS JOIN pg_namespace n WHERE r.rolname='caplets' AND d.datname=current_database() AND n.nspname='caplets'",
  ]).trim();
  assert.equal(roles, "caplets:false:false:false:false:false:caplets:caplets");
  const bootstrapLogin = composeResult(project, [
    "exec",
    "-T",
    "-e",
    "PGPASSWORD=convenience-smoke-secret",
    "caplets-postgres",
    "psql",
    "--host",
    "caplets-postgres",
    "--username",
    "postgres",
    "--dbname",
    "caplets",
    "--command",
    "SELECT 1",
  ]);
  assert.notEqual(bootstrapLogin.status, 0);
  assert.match(bootstrapLogin.stderr, /password authentication failed/u);
  compose(project, ["run", "--rm", "--no-deps", "caplets-postgres-migrate"]);

  const missingPassword = fixture("postgres-missing", "docker-compose.postgres.yml", {
    CAPLETS_ENCRYPTION_KEY: smokeEncryptionKey,
  });
  const missingEnv = deploymentEnv({ CAPLETS_ENCRYPTION_KEY: smokeEncryptionKey });
  delete missingEnv.CAPLETS_POSTGRES_PASSWORD;
  const result = dockerResult(composeCommand(missingPassword, ["config", "--quiet"]), {
    cwd: missingPassword.directory,
    env: missingEnv,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CAPLETS_POSTGRES_PASSWORD/u);
}

async function smokeHardenedPostgres() {
  phase("Hardened PostgreSQL deployment");
  const project = hardenedFixture("hardened");
  compose(project, ["config", "--quiet"]);
  compose(project, ["up", "-d", "--wait"], { stdio: "inherit" });
  assert.equal((await health(project)).backend, "postgres");

  for (const service of [
    "caplets-postgres",
    "caplets-postgres-secrets",
    "caplets-postgres-migrate",
    "caplets",
  ]) {
    const logConfig = inspect(`${project.name}-${service}-1`).HostConfig.LogConfig;
    assert.equal(logConfig.Type, "local");
    assert.deepEqual(logConfig.Config, { "max-file": "3", "max-size": "10m" });
  }

  const runtime = inspect(`${project.name}-caplets-1`);
  assert.equal(runtime.Config.User, "node");
  assert.equal(runtime.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(runtime.HostConfig.CapDrop, ["ALL"]);
  assert.ok(runtime.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
  assert.deepEqual(Object.keys(runtime.NetworkSettings.Networks).sort(), [
    `${project.name}_database`,
    `${project.name}_runtime`,
  ]);
  assert.equal(inspectNetwork(`${project.name}_database`).Internal, true);

  const grants = compose(project, [
    "exec",
    "-T",
    "caplets-postgres",
    "psql",
    "--username",
    "caplets_admin",
    "--dbname",
    "caplets",
    "--tuples-only",
    "--no-align",
    "--command",
    "SELECT bool_and(has_table_privilege('caplets_runtime', c.oid, 'SELECT,INSERT,UPDATE,DELETE')) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='caplets' AND c.relkind='r' AND c.relname NOT IN ('caplets_migrations','caplets_schema')",
  ]).trim();
  assert.equal(grants, "t");

  const denied = composeResult(project, [
    "exec",
    "-T",
    "-e",
    "PGPASSWORD=runtime-smoke-secret",
    "caplets-postgres",
    "psql",
    "--host",
    "caplets-postgres",
    "--username",
    "caplets_runtime",
    "--dbname",
    "caplets",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    "CREATE TABLE caplets.runtime_forbidden(id integer)",
  ]);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /permission denied for schema caplets/u);
}

function smokeMigrationGates() {
  phase("PostgreSQL migration gates");
  const convenience = fixture("postgres-gate", "docker-compose.postgres.yml", {
    CAPLETS_POSTGRES_PASSWORD: "gate-smoke-secret",
    CAPLETS_POSTGRES_SCHEMA: "Invalid",
  });
  const convenienceResult = composeResult(convenience, ["up", "-d", "--wait"]);
  assert.notEqual(convenienceResult.status, 0);
  assert.equal(containerState(`${convenience.name}-caplets-1`), "created");

  const hardened = hardenedFixture("hardened-gate", { CAPLETS_POSTGRES_SCHEMA: "Invalid" });
  const hardenedResult = composeResult(hardened, ["up", "-d", "--wait"]);
  assert.notEqual(hardenedResult.status, 0);
  assert.equal(containerState(`${hardened.name}-caplets-1`), "created");
}

async function smokeLegacyCompatibility() {
  phase("Existing three-role deployment compatibility");
  const directory = join(root, "compat");
  mkdirSync(directory);
  writeFileSync(
    join(directory, "legacy.yml"),
    `services:\n  caplets-postgres:\n    image: postgres:17.6-bookworm\n    environment:\n      POSTGRES_DB: caplets\n      POSTGRES_USER: caplets_admin\n      POSTGRES_PASSWORD: legacy-admin-secret\n    volumes:\n      - caplets-postgres-data:/var/lib/postgresql/data\n    healthcheck:\n      test: [CMD-SHELL, "pg_isready --username caplets_admin --dbname caplets"]\n      interval: 2s\n      timeout: 5s\n      retries: 20\nvolumes:\n  caplets-postgres-data:\n`,
  );
  copyFileSync(
    join(repoRoot, "docker-compose.postgres-hardened.yml"),
    join(directory, "compose.yml"),
  );
  writeSecrets(directory, "legacy");
  const project = register({
    directory,
    env: deploymentEnv({ CAPLETS_PORT: "0" }),
    file: "compose.yml",
    name: `${prefix}-compat`,
  });
  const legacy = { ...project, file: "legacy.yml" };
  compose(legacy, ["up", "-d", "--wait"], { stdio: "inherit" });
  compose(legacy, [
    "exec",
    "-T",
    "caplets-postgres",
    "psql",
    "--username",
    "caplets_admin",
    "--dbname",
    "caplets",
    "--set",
    "ON_ERROR_STOP=1",
    "--command",
    legacyRoleSql(),
  ]);
  docker(
    [
      "run",
      "--rm",
      "--network",
      `${project.name}_default`,
      "--env",
      "CAPLETS_CONFIG=/tmp/caplets-migrator-config.json",
      "--env",
      "CAPLETS_POSTGRES_HOST=caplets-postgres",
      "--env",
      "CAPLETS_POSTGRES_DATABASE=caplets",
      "--env",
      "CAPLETS_POSTGRES_SCHEMA=caplets",
      "--env",
      "CAPLETS_POSTGRES_MIGRATOR_PASSWORD=legacy-migrator-secret",
      "--entrypoint",
      "/bin/sh",
      image,
      "-ec",
      "node /usr/local/lib/caplets/postgres/render-config.mjs migrator; node dist/index.js storage schema-migrate; node /usr/local/lib/caplets/postgres/finalize-runtime-grants.mjs",
    ],
    { stdio: "inherit" },
  );
  compose(legacy, ["down"]);
  compose(project, ["up", "-d", "--wait"], { stdio: "inherit" });
  assert.equal((await health(project)).backend, "postgres");
}

function fixture(label, source, overrides = {}) {
  const directory = join(root, label);
  mkdirSync(directory);
  copyFileSync(join(repoRoot, source), join(directory, "compose.yml"));
  return register({
    directory,
    env: deploymentEnv({ CAPLETS_PORT: "0", ...overrides }),
    file: "compose.yml",
    name: `${prefix}-${label}`,
  });
}

function hardenedFixture(label, overrides = {}) {
  const project = fixture(label, "docker-compose.postgres-hardened.yml", overrides);
  writeSecrets(project.directory, label.startsWith("compat") ? "legacy" : "smoke");
  return project;
}

function writeSecrets(directory, kind) {
  const values =
    kind === "legacy"
      ? ["legacy-admin-secret", "legacy-migrator-secret", "legacy-runtime-secret"]
      : ["admin-smoke-secret", "migrator-smoke-secret", "runtime-smoke-secret"];
  const secretDirectory = join(directory, "secrets");
  mkdirSync(secretDirectory, { recursive: true });
  for (const [name, value] of [
    ["postgres-admin-password", values[0]],
    ["postgres-migrator-password", values[1]],
    ["postgres-runtime-password", values[2]],
  ]) {
    const path = join(secretDirectory, name);
    writeFileSync(path, `${value}\n`);
    chmodSync(path, 0o600);
  }
}

function register(project) {
  projects.push(project);
  return project;
}

async function health(project) {
  const address = compose(project, ["port", "caplets", "5387"]).trim();
  const response = await fetch(`http://${address}/v1/healthz`);
  assert.equal(response.ok, true);
  const body = await response.json();
  assert.equal(body.ready, true);
  return body;
}

function compose(project, args, options = {}) {
  return docker(composeCommand(project, args), {
    cwd: project.directory,
    env: project.env,
    ...options,
  });
}

function composeResult(project, args) {
  return dockerResult(composeCommand(project, args), {
    cwd: project.directory,
    env: project.env,
  });
}

function composeCommand(project, args) {
  return ["compose", "-p", project.name, "-f", project.file, ...args];
}

function deploymentEnv(overrides) {
  return { ...process.env, CAPLETS_IMAGE: image, ...overrides };
}

function docker(args, options = {}) {
  try {
    return execFileSync("docker", args, {
      cwd: options.cwd || repoRoot,
      encoding: "utf8",
      env: options.env || process.env,
      stdio: options.stdio || "pipe",
    });
  } catch (error) {
    if (options.allowFailure) return "";
    throw error;
  }
}

function dockerResult(args, options = {}) {
  const result = spawnSync("docker", args, {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    env: options.env || process.env,
  });
  return {
    status: result.status,
    stderr: result.stderr || "",
    stdout: result.stdout || "",
  };
}

function inspect(container) {
  return JSON.parse(docker(["inspect", container]))[0];
}

function inspectNetwork(network) {
  return JSON.parse(docker(["network", "inspect", network]))[0];
}

function containerState(container) {
  return docker(["inspect", "--format", "{{.State.Status}}", container]).trim();
}

function phase(name) {
  console.log(`\n==> ${name}`);
}

function legacyRoleSql() {
  return `
REVOKE ALL ON DATABASE caplets FROM PUBLIC;
CREATE ROLE caplets_migrator LOGIN NOINHERIT PASSWORD 'legacy-migrator-secret';
CREATE ROLE caplets_runtime LOGIN NOINHERIT PASSWORD 'legacy-runtime-secret';
GRANT CONNECT, CREATE ON DATABASE caplets TO caplets_migrator;
GRANT CONNECT ON DATABASE caplets TO caplets_runtime;
CREATE SCHEMA caplets AUTHORIZATION caplets_migrator;
REVOKE ALL ON SCHEMA caplets FROM PUBLIC;
GRANT USAGE ON SCHEMA caplets TO caplets_runtime;
ALTER ROLE caplets_migrator IN DATABASE caplets SET search_path TO caplets;
ALTER ROLE caplets_runtime IN DATABASE caplets SET search_path TO caplets;
ALTER DEFAULT PRIVILEGES FOR ROLE caplets_migrator IN SCHEMA caplets GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO caplets_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE caplets_migrator IN SCHEMA caplets GRANT USAGE, SELECT ON SEQUENCES TO caplets_runtime;
`;
}
