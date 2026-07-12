import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createConnection, createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createFilesystemAuthority } from "../packages/core/src/storage/filesystem-authority";
import {
  assembleCapletsHost,
  type PreparedRuntimeHost,
} from "../packages/core/src/storage/coordinator";
import { AuthorityRemoteServerCredentialStore } from "../packages/core/src/remote/server-credential-store";
import { LocalSetupStore } from "../packages/core/src/setup/local-store";
import {
  createPostgresAuthority,
  createSqliteAuthority,
} from "../packages/core/src/storage/sql/authority";
import { migratePostgresDatabase } from "../packages/core/src/storage/sql/migrate";
import { migrateAuthority } from "../packages/core/src/storage/migration";
import {
  createS3Authority,
  type S3CredentialIdentity,
} from "../packages/core/src/storage/s3-authority";
import type {
  AuthorityGenerationIdentity,
  WritableAuthority,
} from "../packages/core/src/storage/types";
import { runProviderContract } from "../packages/core/test/storage-provider-contract";

const FIXTURE_COMPOSE = resolve("packages/core/test/fixtures/storage/provider-matrix.compose.yml");
const MINIO_IMAGE = "minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
const POSTGRES_IMAGE = "postgres:18.1";
const MINIO_ACCESS_KEY = "caplets-u9-fixture";
const MINIO_SECRET_KEY = "caplets-u9-fixture-secret";
const MINIO_BUCKET = "caplets-u9";
const DEFAULT_DEADLINE_MS = 60_000;
const CHILD_DEADLINE_MS = 20_000;

type DeterministicProvider = "filesystem" | "sqlite" | "postgresql" | "minio";
type LiveProvider = "aws" | "r2";
type ProviderName = DeterministicProvider | LiveProvider;
type FixtureRuntime = {
  postgresUrl: string;
  minioEndpoint: string;
  env: NodeJS.ProcessEnv;
  ports: { postgres: number; minio: number };
};

type LiveProfile = {
  provider: LiveProvider;
  bucket: string;
  region: string;
  endpoint?: string;
  credentials: S3CredentialIdentity;
};

type ProviderSpec = {
  provider: ProviderName;
  authorityId: string;
  namespace: string;
  root?: string;
  databasePath?: string;
  connectionString?: string;
  profile?: LiveProfile | undefined;
  forcePathStyle?: boolean;
};

type ProviderTarget = {
  spec: ProviderSpec;
  authority: WritableAuthority<unknown, unknown>;
  version: string;
  makeReplica: () => Promise<WritableAuthority<unknown, unknown>>;
};

type CommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type Evidence = {
  commit: string;
  lock: string;
  runtime: { node: string; pnpm: string };
  providers: Record<string, string>;
  trace?: Record<"postgresql" | "minio", RuntimeTraceEvidence>;
  timestamp: string;
  result: "passed" | "failed" | "blocked";
};
type ChildTraceEvidence = {
  kind: "trace";
  role: "a" | "b";
  initialSequence: number;
  race: "committed" | "conflict";
  refreshedSequence: number;
  refreshedSnapshotParity: boolean;
  approvalGrantVisible: boolean;
  approvalRevokeVisible: boolean;
  sessionValidBeforeRevoke: boolean;
  sessionRevokedAfterRefresh: boolean;
  droppedHintConverged: boolean;
  outageLastKnownGood: boolean;
  outageDegraded: boolean;
  outageWriteRejected: boolean;
  recoveryHealthy: boolean;
  recoveryStatus: {
    connectivity: "healthy" | "degraded" | "unavailable";
    writable: boolean;
    refresh: "current" | "pending" | "failed";
    readiness: "cold" | "ready" | "failed" | "pending" | "shutdown";
    activeSequence: number | null;
    code?: string;
    lastErrorCode?: string;
  };
  replacementConverged: boolean;
  replacementSnapshotParity: boolean;
};

type RuntimeTraceEvidence = {
  processes: 2;
  initialSequence: number;
  committedRace: 1;
  conflictRace: 1;
  finalSequence: number;
  checks: {
    refreshedConvergence: boolean;
    approvalPropagation: boolean;
    sessionRevocationPropagation: boolean;
    droppedRefreshHint: boolean;
    outageLastKnownGood: boolean;
    outageRecovery: boolean;
    replicaReplacement: boolean;
  };
};
type S3SdkClient = {
  send(command: unknown): Promise<unknown>;
  destroy(): void;
};
type S3SdkCommand = new (input: Record<string, unknown>) => unknown;
type S3Sdk = {
  S3Client: new (options: Record<string, unknown>) => S3SdkClient;
  CreateBucketCommand: S3SdkCommand;
  ListObjectsV2Command: S3SdkCommand;
  DeleteObjectsCommand: S3SdkCommand;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  if (typeof error.code === "string") return error.code;
  return typeof error.name === "string" ? error.name : undefined;
}

function safeError(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("LIVE_CREDENTIALS_MISSING:"))
    return error.message;
  if (
    error instanceof Error &&
    (error.message.startsWith("FIXTURE_") ||
      error.message.startsWith("PROVIDER_") ||
      error.message.startsWith("two-process"))
  ) {
    return error.message;
  }
  const code = errorCode(error);
  if (code === "CONFIG_INVALID" && error instanceof Error)
    return `${code}:${error.message.replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 160)}`;
  if (code) return code;
  return error instanceof Error ? error.name : "UNKNOWN";
}
function sleep(milliseconds: number): Promise<void> {
  const { promise, resolve: resolvePromise } = Promise.withResolvers<void>();
  setTimeout(resolvePromise, milliseconds);
  return promise;
}

async function withDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  const { promise, resolve: resolvePromise, reject: rejectPromise } = Promise.withResolvers<T>();
  const timer = setTimeout(
    () => rejectPromise(new Error(`${label} deadline exceeded`)),
    milliseconds,
  );
  operation.then(
    (value) => {
      clearTimeout(timer);
      resolvePromise(value);
    },
    (error: unknown) => {
      clearTimeout(timer);
      rejectPromise(error);
    },
  );
  return promise;
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CommandResult> {
  const { promise, resolve: resolvePromise } = Promise.withResolvers<CommandResult>();
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const append = (current: string, chunk: Buffer): string => {
    const next = `${current}${chunk.toString("utf8")}`;
    return next.length > 32_000 ? next.slice(-32_000) : next;
  };
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = append(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = append(stderr, chunk);
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    resolvePromise({ code: null, signal: "SIGTERM", stdout, stderr });
  }, options.timeoutMs);
  child.once("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolvePromise({ code, signal, stdout, stderr });
  });
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolvePromise({ code: null, signal: null, stdout: "", stderr: error.name });
  });
  return promise;
}

async function freePort(): Promise<number> {
  const {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  } = Promise.withResolvers<number>();
  const server = createServer();
  server.once("error", rejectPromise);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      rejectPromise(new Error("could not allocate a local port"));
      return;
    }
    const port = address.port;
    server.close((error) => {
      if (error) rejectPromise(error);
      else resolvePromise(port);
    });
  });
  return promise;
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Keep polling until the finite startup deadline.
    }
    await sleep(200);
  }
  throw new Error("fixture health check timed out");
}
async function waitForTcp(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
    } = Promise.withResolvers<void>();
    const socket = createConnection({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise();
    });
    socket.once("error", (error) => {
      socket.destroy();
      rejectPromise(error);
    });
    try {
      await promise;
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error("fixture PostgreSQL health check timed out");
}

async function startFixtures(project: string): Promise<FixtureRuntime> {
  const postgresPort = await freePort();
  const minioPort = await freePort();
  const env = {
    ...process.env,
    CAPLETS_STORAGE_POSTGRES_PORT: String(postgresPort),
    CAPLETS_STORAGE_MINIO_PORT: String(minioPort),
    CAPLETS_STORAGE_MINIO_CONSOLE_PORT: String(await freePort()),
  };
  try {
    const result = await runProcess(
      "docker",
      ["compose", "-f", FIXTURE_COMPOSE, "-p", project, "up", "-d"],
      {
        env,
        timeoutMs: 90_000,
      },
    );
    if (result.code !== 0) throw new Error("FIXTURE_STARTUP_FAILED");
    const minioEndpoint = `http://127.0.0.1:${minioPort}`;
    await waitForHttp(`${minioEndpoint}/minio/health/ready`, 30_000);
    await waitForTcp("127.0.0.1", postgresPort, 30_000);
    return {
      postgresUrl: `postgres://caplets_u9:caplets_u9_fixture_secret@127.0.0.1:${postgresPort}/caplets`,
      minioEndpoint,
      env,
      ports: { postgres: postgresPort, minio: minioPort },
    };
  } catch (error) {
    await stopFixtures(project, env);
    throw error;
  }
}

async function stopFixtures(project: string, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runProcess(
    "docker",
    ["compose", "-f", FIXTURE_COMPOSE, "-p", project, "down", "--volumes", "--remove-orphans"],
    {
      env,
      timeoutMs: 60_000,
    },
  );
  if (result.code !== 0) throw new Error("FIXTURE_CLEANUP_FAILED");
}
async function createPostgresRestoreDatabase(
  project: string,
  env: NodeJS.ProcessEnv,
  database: string,
): Promise<void> {
  const result = await runProcess(
    "docker",
    [
      "compose",
      "-f",
      FIXTURE_COMPOSE,
      "-p",
      project,
      "exec",
      "-T",
      "-e",
      "PGPASSWORD=caplets_u9_fixture_secret",
      "caplets-u9-postgres",
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      "caplets_u9",
      "-d",
      "caplets",
      "-c",
      `CREATE DATABASE "${database}"`,
    ],
    { env, timeoutMs: 15_000 },
  );
  if (result.code !== 0 && !result.stderr.includes("already exists"))
    throw new Error("POSTGRES_RESTORE_DB_FAILED");
}

function loadS3Sdk(): S3Sdk {
  // The root package intentionally does not own the AWS SDK dependency. Resolve
  // the already-pinned core dependency without adding a second package graph.
  const require = createRequire(import.meta.url);
  const loaded: unknown = require("../packages/core/node_modules/@aws-sdk/client-s3");
  if (!isRecord(loaded)) throw new Error("AWS SDK dependency is unavailable");
  const S3Client = loaded.S3Client;
  const CreateBucketCommand = loaded.CreateBucketCommand;
  const ListObjectsV2Command = loaded.ListObjectsV2Command;
  const DeleteObjectsCommand = loaded.DeleteObjectsCommand;
  if (
    typeof S3Client !== "function" ||
    typeof CreateBucketCommand !== "function" ||
    typeof ListObjectsV2Command !== "function" ||
    typeof DeleteObjectsCommand !== "function"
  ) {
    throw new Error("AWS SDK dependency is incomplete");
  }
  return {
    S3Client: S3Client as S3Sdk["S3Client"],
    CreateBucketCommand: CreateBucketCommand as S3SdkCommand,
    ListObjectsV2Command: ListObjectsV2Command as S3SdkCommand,
    DeleteObjectsCommand: DeleteObjectsCommand as S3SdkCommand,
  };
}

async function ensureBucket(
  profile: { bucket: string; region: string; endpoint?: string; credentials: S3CredentialIdentity },
  forcePathStyle = false,
): Promise<void> {
  const sdk = loadS3Sdk();
  const client = new sdk.S3Client({
    region: profile.region,
    ...(profile.endpoint ? { endpoint: profile.endpoint } : {}),
    forcePathStyle,
    credentials: profile.credentials,
  });
  try {
    await client.send(new sdk.CreateBucketCommand({ Bucket: profile.bucket }));
  } catch (error) {
    const code = errorCode(error);
    if (code !== "BucketAlreadyOwnedByYou" && code !== "BucketAlreadyExists") throw error;
  } finally {
    client.destroy();
  }
}

async function cleanupBucket(
  profile: { bucket: string; region: string; endpoint?: string; credentials: S3CredentialIdentity },
  prefix: string,
  forcePathStyle = false,
): Promise<void> {
  const sdk = loadS3Sdk();
  const client = new sdk.S3Client({
    region: profile.region,
    ...(profile.endpoint ? { endpoint: profile.endpoint } : {}),
    forcePathStyle,
    credentials: profile.credentials,
  });
  try {
    let token: string | undefined;
    do {
      const listed = await client.send(
        new sdk.ListObjectsV2Command({
          Bucket: profile.bucket,
          Prefix: `${prefix}/`,
          ContinuationToken: token,
        }),
      );
      if (!isRecord(listed)) break;
      const contents = Array.isArray(listed.Contents) ? listed.Contents : [];
      const objects = contents.flatMap((value) => {
        if (!isRecord(value) || typeof value.Key !== "string") return [];
        return [{ Key: value.Key }];
      });
      if (objects.length > 0)
        await client.send(
          new sdk.DeleteObjectsCommand({
            Bucket: profile.bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
      token =
        typeof listed.NextContinuationToken === "string" ? listed.NextContinuationToken : undefined;
    } while (token);
  } finally {
    client.destroy();
  }
}

function liveProfile(provider: LiveProvider): LiveProfile {
  const prefix = provider.toUpperCase();
  const bucket = process.env[`CAPLETS_STORAGE_${prefix}_BUCKET`];
  const accessKeyId = process.env[`CAPLETS_STORAGE_${prefix}_ACCESS_KEY_ID`];
  const secretAccessKey = process.env[`CAPLETS_STORAGE_${prefix}_SECRET_ACCESS_KEY`];
  const endpoint = process.env[`CAPLETS_STORAGE_${prefix}_ENDPOINT`];
  const region =
    process.env[`CAPLETS_STORAGE_${prefix}_REGION`] ?? (provider === "r2" ? "auto" : "us-east-1");
  const missing: string[] = [];
  if (!bucket) missing.push(`CAPLETS_STORAGE_${prefix}_BUCKET`);
  if (!accessKeyId) missing.push(`CAPLETS_STORAGE_${prefix}_ACCESS_KEY_ID`);
  if (!secretAccessKey) missing.push(`CAPLETS_STORAGE_${prefix}_SECRET_ACCESS_KEY`);
  if (provider === "r2" && !endpoint) missing.push(`CAPLETS_STORAGE_${prefix}_ENDPOINT`);
  if (missing.length > 0)
    throw new Error(`LIVE_CREDENTIALS_MISSING:${provider}:${missing.join(",")}`);
  const sessionToken = process.env[`CAPLETS_STORAGE_${prefix}_SESSION_TOKEN`];
  const credentials: S3CredentialIdentity = {
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    ...(sessionToken ? { sessionToken } : {}),
  };
  return {
    provider,
    bucket: bucket!,
    region,
    ...(endpoint ? { endpoint } : {}),
    credentials,
  };
}

async function openAuthority(
  spec: ProviderSpec,
  options: { verifySchema?: boolean } = {},
): Promise<WritableAuthority<unknown, unknown>> {
  const base = {
    authorityId: spec.authorityId,
    namespace: spec.namespace,
    maintenanceLeaseMs: 300,
    maintenanceRenewIntervalMs: 100,
  } as const;
  if (spec.provider === "filesystem") {
    return await createFilesystemAuthority({ ...base, root: spec.root! });
  }
  if (spec.provider === "sqlite") {
    return await createSqliteAuthority({
      ...base,
      databasePath: spec.databasePath!,
      verifySchema: options.verifySchema ?? false,
      busyTimeoutMs: 5_000,
    });
  }
  if (spec.provider === "postgresql") {
    return await createPostgresAuthority({
      ...base,
      connectionString: spec.connectionString!,
      verifySchema: options.verifySchema ?? true,
      maxConnections: 4,
      connectTimeoutSeconds: 5,
      statementTimeoutMs: 5_000,
      lockTimeoutMs: 2_000,
    });
  }
  const profile = spec.profile!;
  return await createS3Authority({
    ...base,
    bucket: profile.bucket,
    region: profile.region,
    ...(profile.endpoint ? { endpoint: profile.endpoint } : {}),
    forcePathStyle: spec.forcePathStyle ?? false,
    credentials: profile.credentials,
    requestTimeoutMs: 5_000,
    candidateTtlMs: 5_000,
  });
}

async function createTarget(
  spec: ProviderSpec,
  options: { verifySchema?: boolean } = {},
): Promise<ProviderTarget> {
  if (spec.provider === "postgresql" && options.verifySchema === false) {
    await migratePostgresDatabase({
      connectionString: spec.connectionString!,
      authorityId: spec.authorityId,
      namespace: spec.namespace,
      lockTimeoutMs: 2_000,
      statementTimeoutMs: 5_000,
    });
  }
  const authority = await openAuthority(spec, options);
  const version =
    spec.provider === "postgresql"
      ? POSTGRES_IMAGE
      : spec.provider === "minio"
        ? MINIO_IMAGE
        : spec.provider;
  return {
    spec,
    authority,
    version,
    makeReplica: async () => await openAuthority(spec, { verifySchema: true }),
  };
}
function restoreSpecFor(spec: ProviderSpec): ProviderSpec | undefined {
  if (spec.provider === "filesystem" && spec.root) return { ...spec, root: `${spec.root}-restore` };
  if (spec.provider === "sqlite" && spec.databasePath)
    return { ...spec, databasePath: `${spec.databasePath}.restore` };
  return undefined;
}
async function openRestoreAuthority(
  spec: ProviderSpec,
): Promise<WritableAuthority<unknown, unknown>> {
  if (spec.provider === "postgresql")
    return (await createTarget(spec, { verifySchema: false })).authority;
  return await openAuthority(spec, { verifySchema: false });
}

function parseLiveTargets(args: string[]): LiveProvider[] {
  const flag = args.find((arg) => arg.startsWith("--live="));
  if (!flag) return [];
  const values = flag
    .slice("--live=".length)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowed: LiveProvider[] = ["aws", "r2"];
  for (const value of values)
    if (!allowed.includes(value as LiveProvider)) throw new Error(`LIVE_TARGET_INVALID:${value}`);
  return [...new Set(values as LiveProvider[])];
}

function parseFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await sleep(50);
    }
  }
  throw new Error("two-process readiness deadline exceeded");
}

async function setFixtureService(
  project: string,
  env: NodeJS.ProcessEnv,
  provider: "postgresql" | "minio",
  action: "stop" | "start",
): Promise<void> {
  const service = provider === "postgresql" ? "caplets-u9-postgres" : "caplets-u9-minio";
  const result = await runProcess(
    "docker",
    ["compose", "-f", FIXTURE_COMPOSE, "-p", project, action, service],
    { env, timeoutMs: 30_000 },
  );
  if (result.code !== 0) throw new Error(`FIXTURE_${action.toUpperCase()}_FAILED`);
}

async function waitForFixtureRecovery(
  fixture: FixtureRuntime,
  provider: "postgresql" | "minio",
): Promise<void> {
  if (provider === "postgresql") {
    await waitForTcp("127.0.0.1", fixture.ports.postgres, 30_000);
    return;
  }
  await waitForHttp(`${fixture.minioEndpoint}/minio/health/ready`, 30_000);
}

async function waitForAuthorityHealthy(
  authority: WritableAuthority<unknown, unknown>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await authority.health().catch(() => undefined);
    if (health?.connectivity === "healthy" && health.writable) return;
    await sleep(100);
  }
  throw new Error("two-process provider recovery deadline exceeded");
}

async function waitForProviderRecovery(spec: ProviderSpec, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let probe: WritableAuthority<unknown, unknown> | undefined;
    try {
      probe = await openAuthority(spec, { verifySchema: false });
      await waitForAuthorityHealthy(probe, Math.min(2_000, timeoutMs));
      return;
    } catch {
      await sleep(100);
    } finally {
      if (probe) await probe.close().catch(() => undefined);
    }
  }
  throw new Error("two-process provider recovery deadline exceeded");
}

async function waitForFixtureUnavailable(
  fixture: FixtureRuntime,
  provider: "postgresql" | "minio",
): Promise<void> {
  const deadline = Date.now() + 10_000;
  if (provider === "minio") {
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${fixture.minioEndpoint}/minio/health/ready`, {
          signal: AbortSignal.timeout(500),
        });
        if (!response.ok) return;
      } catch {
        return;
      }
      await sleep(100);
    }
    throw new Error("fixture MinIO outage was not observed");
  }
  while (Date.now() < deadline) {
    const { promise, resolve: resolvePromise } = Promise.withResolvers<boolean>();
    const socket = createConnection({ host: "127.0.0.1", port: fixture.ports.postgres });
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolvePromise(true);
    });
    if (await promise) return;
    await sleep(100);
  }
  throw new Error("fixture PostgreSQL outage was not observed");
}

function childArgs(spec: ProviderSpec, barrier: string, role: "a" | "b"): string[] {
  return [
    "--import",
    "tsx",
    fileURLToPath(import.meta.url),
    "--child",
    `--provider=${spec.provider}`,
    `--authority-id=${spec.authorityId}`,
    `--namespace=${spec.namespace}`,
    `--barrier=${barrier}`,
    `--role=${role}`,
    ...(spec.root ? [`--root=${spec.root}`] : []),
    ...(spec.databasePath ? [`--database-path=${spec.databasePath}`] : []),
  ];
}

async function spawnChild(
  spec: ProviderSpec,
  barrier: string,
  role: "a" | "b",
  env: NodeJS.ProcessEnv,
): Promise<{ process: ChildProcess; result: Promise<CommandResult> }> {
  const child = spawn(process.execPath, childArgs(spec, barrier, role), {
    cwd: resolve("."),
    env: {
      ...env,
      U9_POSTGRES_URL: spec.connectionString ?? "",
      U9_S3_BUCKET: spec.profile?.bucket ?? "",
      U9_S3_REGION: spec.profile?.region ?? "",
      U9_S3_ENDPOINT: spec.profile?.endpoint ?? "",
      U9_S3_ACCESS_KEY_ID: spec.profile?.credentials.accessKeyId ?? "",
      U9_S3_SECRET_ACCESS_KEY: spec.profile?.credentials.secretAccessKey ?? "",
      U9_S3_SESSION_TOKEN: spec.profile?.credentials.sessionToken ?? "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { promise, resolve: resolvePromise } = Promise.withResolvers<CommandResult>();
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString("utf8")}`.slice(-8_000);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_000);
  });
  child.once("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  child.once("error", () => resolvePromise({ code: null, signal: null, stdout, stderr }));
  return { process: child, result: promise };
}

function generationIdentity(value: {
  authorityId: string;
  id: string;
  sequence: number;
  predecessorId: string | null;
}): AuthorityGenerationIdentity {
  return {
    authorityId: value.authorityId,
    id: value.id,
    sequence: value.sequence,
    predecessorId: value.predecessorId,
  };
}

function hostGeneration(host: PreparedRuntimeHost): AuthorityGenerationIdentity {
  const generation = host.view.authorityGeneration;
  if (!generation) throw new Error("CHILD_RUNTIME_GENERATION_MISSING");
  return generationIdentity(generation);
}

function hostSnapshot(host: PreparedRuntimeHost): Record<string, unknown> {
  const snapshot = host.view.authorityGeneration?.snapshot;
  if (!isRecord(snapshot)) throw new Error("CHILD_RUNTIME_SNAPSHOT_INVALID");
  return { ...snapshot };
}

async function waitForActiveSequence(
  host: PreparedRuntimeHost,
  sequence: number,
  options: { refresh: boolean; timeoutMs: number; healthy?: boolean },
): Promise<boolean> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    if (options.refresh) await host.refresh().catch(() => false);
    const active = await host.health().catch(() => undefined);
    if (
      active?.activeGeneration?.sequence === sequence &&
      (!options.healthy || (active.connectivity === "healthy" && active.writable))
    ) {
      return true;
    }
    await sleep(50);
  }
  return false;
}

function semanticTraceEnvelope(
  authorityId: string,
  expectedGeneration: AuthorityGenerationIdentity,
  currentHostId: string,
  idempotencyKey: string,
  snapshot: Record<string, unknown>,
) {
  return {
    authorityId,
    currentHostId,
    principalId: currentHostId,
    expectedGeneration,
    idempotencyKey,
    requestDigest: idempotencyKey,
    command: { kind: "replace_snapshot", snapshot },
  };
}

function parseChildTrace(result: CommandResult, role: "a" | "b"): ChildTraceEvidence {
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  if (result.code !== 0) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && parsed.kind === "error" && typeof parsed.code === "string") {
        throw new Error(`two-process child failed:${parsed.code}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("two-process child failed:"))
        throw error;
    }
    const diagnostic = result.stderr
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0)
      ?.replace(/[^A-Za-z0-9_.:-]/gu, "_")
      .slice(0, 160);
    throw new Error(
      `two-process child failed:${result.code ?? "null"}:${result.signal ?? "none"}:${diagnostic ?? "no-stderr"}`,
    );
  }
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      !isRecord(parsed) ||
      parsed.kind !== "trace" ||
      parsed.role !== role ||
      typeof parsed.initialSequence !== "number" ||
      typeof parsed.refreshedSequence !== "number"
    ) {
      throw new Error("invalid child trace");
    }
    return parsed as unknown as ChildTraceEvidence;
  } catch {
    throw new Error("two-process child trace missing");
  }
}

async function runTwoProcessTrace(
  target: ProviderTarget,
  fixture: FixtureRuntime,
  project: string,
): Promise<RuntimeTraceEvidence> {
  if (target.spec.provider !== "postgresql" && target.spec.provider !== "minio") {
    throw new Error("two-process provider is not deterministic");
  }
  const before = await target.authority.readHead();
  if (!before) throw new Error("two-process head missing");
  const barrier = join(tmpdir(), `caplets-u9-barrier-${process.pid}-${randomUUID()}`);
  const readyA = `${barrier}.a`;
  const readyB = `${barrier}.b`;
  const go = `${barrier}.go`;
  const raceReadyA = `${barrier}.race-ready-a`;
  const raceReadyB = `${barrier}.race-ready-b`;
  const approvalReady = `${barrier}.approval-ready`;
  const approvalRead = `${barrier}.approval-read`;
  const approvalRevoked = `${barrier}.approval-revoked`;
  const remoteReady = `${barrier}.remote-ready`;
  const remoteValidated = `${barrier}.remote-validated`;
  const remoteRevoked = `${barrier}.remote-revoked`;
  const hintDropped = `${barrier}.hint-dropped`;
  const outageReadyA = `${barrier}.outage-ready-a`;
  const outageReadyB = `${barrier}.outage-ready-b`;
  const outage = `${barrier}.outage`;
  const outageDoneA = `${barrier}.outage-done-a`;
  const outageDoneB = `${barrier}.outage-done-b`;
  const recovery = `${barrier}.recovery`;
  const credentials = `${barrier}.credentials.json`;
  const children = await Promise.all([
    spawnChild(target.spec, barrier, "a", fixture.env),
    spawnChild(target.spec, barrier, "b", fixture.env),
  ]);
  let outageStopped = false;
  const temporaryFiles = [
    readyA,
    readyB,
    go,
    raceReadyA,
    raceReadyB,
    approvalReady,
    approvalRead,
    approvalRevoked,
    remoteReady,
    remoteValidated,
    remoteRevoked,
    hintDropped,
    outageReadyA,
    outageReadyB,
    outage,
    outageDoneA,
    outageDoneB,
    recovery,
    credentials,
  ];
  try {
    await withDeadline(
      Promise.all([waitForFile(readyA, CHILD_DEADLINE_MS), waitForFile(readyB, CHILD_DEADLINE_MS)]),
      CHILD_DEADLINE_MS,
      "two-process readiness",
    );
    await writeFile(go, "go", { mode: 0o600 });
    try {
      await withDeadline(
        Promise.all([
          waitForFile(outageReadyA, DEFAULT_DEADLINE_MS),
          waitForFile(outageReadyB, DEFAULT_DEADLINE_MS),
        ]),
        DEFAULT_DEADLINE_MS,
        "two-process outage readiness",
      );
    } catch {
      const readinessFiles = [
        approvalReady,
        approvalRead,
        approvalRevoked,
        remoteReady,
        remoteValidated,
        remoteRevoked,
        hintDropped,
        outageReadyA,
        outageReadyB,
      ];
      const readiness = await Promise.all(
        readinessFiles.map(async (path) => {
          try {
            await access(path);
            return "1";
          } catch {
            return "0";
          }
        }),
      );
      const childDiagnostics = await Promise.all(
        children.map(async (child) => {
          const result = await Promise.race([child.result, sleep(250).then(() => undefined)]);
          if (!result) return "running";
          const line = result.stdout.trim().split("\n").at(-1) ?? "";
          return line.replace(/[^A-Za-z0-9_.:{},"[\]-]/gu, "_").slice(0, 180);
        }),
      );
      throw new Error(
        `two-process outage readiness deadline exceeded:${readiness.join("")}:${childDiagnostics.join(
          "|",
        )}`,
      );
    }
    await setFixtureService(project, fixture.env, target.spec.provider, "stop");
    outageStopped = true;
    await waitForFixtureUnavailable(fixture, target.spec.provider);
    await writeFile(outage, "outage", { mode: 0o600 });
    await withDeadline(
      Promise.all([
        waitForFile(outageDoneA, CHILD_DEADLINE_MS),
        waitForFile(outageDoneB, CHILD_DEADLINE_MS),
      ]),
      CHILD_DEADLINE_MS,
      "two-process outage",
    );
    await setFixtureService(project, fixture.env, target.spec.provider, "start");
    outageStopped = false;
    await waitForFixtureRecovery(fixture, target.spec.provider);
    await waitForProviderRecovery(target.spec, DEFAULT_DEADLINE_MS);
    await writeFile(recovery, "recovery", { mode: 0o600 });
    const results = await withDeadline(
      Promise.all(children.map((child) => child.result)),
      DEFAULT_DEADLINE_MS,
      "two-process runtime trace",
    );
    const resultA = results[0];
    const resultB = results[1];
    if (!resultA || !resultB) throw new Error("two-process child result missing");
    const traceA = parseChildTrace(resultA, "a");
    const traceB = parseChildTrace(resultB, "b");
    const traces = [traceA, traceB];
    const committedRace = traces.filter((trace) => trace.race === "committed").length;
    const conflictRace = traces.filter((trace) => trace.race === "conflict").length;
    if (committedRace !== 1 || conflictRace !== 1)
      throw new Error("two-process conditional race did not produce one commit and one conflict");
    const refreshedSequence = traceA.refreshedSequence;
    if (
      traces.some(
        (trace) =>
          trace.initialSequence !== before.sequence ||
          trace.refreshedSequence !== refreshedSequence,
      )
    ) {
      throw new Error("two-process convergence sequence invalid");
    }
    const after = await target.authority.readHead();
    if (!after || after.sequence < refreshedSequence)
      throw new Error("two-process final generation missing");
    const checks = {
      refreshedConvergence: traces.every(
        (trace) => trace.refreshedSequence === refreshedSequence && trace.refreshedSnapshotParity,
      ),
      approvalPropagation: traces.every(
        (trace) => trace.approvalGrantVisible && trace.approvalRevokeVisible,
      ),
      sessionRevocationPropagation: traces.every(
        (trace) => trace.sessionValidBeforeRevoke && trace.sessionRevokedAfterRefresh,
      ),
      droppedRefreshHint: traces.every((trace) => trace.droppedHintConverged),
      outageLastKnownGood: traces.every(
        (trace) => trace.outageLastKnownGood && trace.outageDegraded && trace.outageWriteRejected,
      ),
      outageRecovery: traces.every((trace) => trace.recoveryHealthy),
      replicaReplacement: traces.every(
        (trace) => trace.replacementConverged && trace.replacementSnapshotParity,
      ),
    };
    const failedChecks = Object.entries(checks)
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (failedChecks.length > 0) {
      const recoveryEvidence = traces.map((trace) => ({
        role: trace.role,
        recoveryHealthy: trace.recoveryHealthy,
        recoveryStatus: trace.recoveryStatus,
        outageLastKnownGood: trace.outageLastKnownGood,
        outageDegraded: trace.outageDegraded,
        droppedHintConverged: trace.droppedHintConverged,
      }));
      throw new Error(
        `two-process ${target.spec.provider} runtime trace assertion failed:${failedChecks.join(
          ",",
        )}:${JSON.stringify(recoveryEvidence)}`,
      );
    }
    return {
      processes: 2,
      initialSequence: before.sequence,
      committedRace,
      conflictRace,
      finalSequence: after.sequence,
      checks,
    };
  } finally {
    if (outageStopped) {
      await setFixtureService(project, fixture.env, target.spec.provider, "start").catch(
        () => undefined,
      );
      await waitForFixtureRecovery(fixture, target.spec.provider).catch(() => undefined);
    }
    for (const child of children) child.process.kill("SIGTERM");
    await Promise.allSettled(children.map((child) => child.result));
    await Promise.all(temporaryFiles.map((path) => rm(path, { force: true })));
  }
}

async function runChild(args: string[]): Promise<void> {
  const provider = parseFlag(args, "provider") as ProviderName | undefined;
  const authorityId = parseFlag(args, "authority-id");
  const namespace = parseFlag(args, "namespace");
  const barrier = parseFlag(args, "barrier");
  const role = parseFlag(args, "role");
  if (!provider || !authorityId || !namespace || !barrier || (role !== "a" && role !== "b"))
    throw new Error("CHILD_CONFIG_INVALID");
  const root = parseFlag(args, "root");
  const databasePath = parseFlag(args, "database-path");
  const connectionString = process.env.U9_POSTGRES_URL;
  const spec: ProviderSpec = { provider, authorityId, namespace };
  if (root) spec.root = root;
  if (databasePath) spec.databasePath = databasePath;
  if (provider === "postgresql") {
    if (!connectionString) throw new Error("CHILD_POSTGRES_URL_MISSING");
    spec.connectionString = connectionString;
  }
  if (provider === "minio") {
    const bucket = process.env.U9_S3_BUCKET;
    const accessKeyId = process.env.U9_S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.U9_S3_SECRET_ACCESS_KEY;
    if (!bucket || !accessKeyId || !secretAccessKey) throw new Error("CHILD_S3_PROFILE_MISSING");
    spec.profile = {
      provider: "r2",
      bucket,
      region: process.env.U9_S3_REGION ?? "us-east-1",
      ...(process.env.U9_S3_ENDPOINT ? { endpoint: process.env.U9_S3_ENDPOINT } : {}),
      credentials: {
        accessKeyId,
        secretAccessKey,
        ...(process.env.U9_S3_SESSION_TOKEN
          ? { sessionToken: process.env.U9_S3_SESSION_TOKEN }
          : {}),
      },
    };
    spec.forcePathStyle = true;
  }
  let authority: WritableAuthority<unknown, unknown> | undefined;
  let host: PreparedRuntimeHost | undefined;
  const encryptionKey = new Uint8Array(32).fill(17);
  const now = () => new Date("2026-07-01T00:00:00.000Z");
  const trace: ChildTraceEvidence = {
    kind: "trace",
    role,
    initialSequence: 0,
    race: "conflict",
    refreshedSequence: 0,
    refreshedSnapshotParity: false,
    approvalGrantVisible: false,
    approvalRevokeVisible: false,
    sessionValidBeforeRevoke: false,
    sessionRevokedAfterRefresh: false,
    droppedHintConverged: false,
    outageLastKnownGood: false,
    outageDegraded: false,
    outageWriteRejected: false,
    recoveryHealthy: false,
    recoveryStatus: {
      connectivity: "unavailable",
      writable: false,
      refresh: "failed",
      readiness: "cold",
      activeSequence: null,
    },
    replacementConverged: false,
    replacementSnapshotParity: false,
  };
  try {
    authority = await openAuthority(spec, { verifySchema: true });
    host = await assembleCapletsHost({
      authority,
      configPath: join(tmpdir(), `caplets-u9-child-${process.pid}-${role}.json`),
      pollIntervalMs: 100,
      readDeadlineMs: 2_000,
      activationDeadlineMs: 2_000,
    });
    const initial = hostGeneration(host);
    trace.initialSequence = initial.sequence;
    await writeFile(`${barrier}.${role}`, "ready", { mode: 0o600 });
    await waitForFile(`${barrier}.go`, CHILD_DEADLINE_MS);
    const raceResult = await host.commit(
      semanticTraceEnvelope(authorityId, initial, `u9-child-${role}`, `u9-child-${role}-race`, {
        ...hostSnapshot(host),
        [`u9-race-${role}`]: true,
      }),
    );
    if (raceResult.kind !== "committed" && raceResult.kind !== "conflict")
      throw new Error("two-process race returned non-terminal result");
    trace.race = raceResult.kind;
    if (
      !(await waitForActiveSequence(host, initial.sequence + 1, {
        refresh: true,
        timeoutMs: CHILD_DEADLINE_MS,
      }))
    ) {
      throw new Error("two-process refresh did not activate race generation");
    }
    trace.refreshedSequence = hostGeneration(host).sequence;
    const refreshedHead = await authority.readHead();
    if (!refreshedHead) throw new Error("two-process refreshed head missing");
    const refreshedGeneration = await authority.readGeneration(refreshedHead.id);
    trace.refreshedSnapshotParity =
      JSON.stringify(refreshedGeneration.snapshot) === JSON.stringify(hostSnapshot(host));
    await writeFile(`${barrier}.race-ready-${role}`, "ready", { mode: 0o600 });
    await waitForFile(`${barrier}.race-ready-${role === "a" ? "b" : "a"}`, CHILD_DEADLINE_MS);

    const setup = new LocalSetupStore({
      authority,
      authorityId,
      currentHostId: `u9-setup-${role}`,
      principalId: `u9-setup-${role}`,
      now,
    });
    const setupInput = {
      projectFingerprint: "u9-project",
      capletId: "u9-caplet",
      contentHash: "u9-content-hash",
      targetKind: "local_host" as const,
      actor: "automation" as const,
      approvedAt: now().toISOString(),
    };
    if (role === "a") {
      const granted = await setup.approve(setupInput);
      trace.approvalGrantVisible = granted.decision === "grant";
      await writeFile(`${barrier}.approval-ready`, "grant", { mode: 0o600 });
      await waitForFile(`${barrier}.approval-read`, CHILD_DEADLINE_MS);
      const revoked = await setup.revoke(setupInput);
      trace.approvalRevokeVisible = revoked.decision === "revoke";
      await writeFile(`${barrier}.approval-revoked`, "revoke", { mode: 0o600 });
    } else {
      await waitForFile(`${barrier}.approval-ready`, CHILD_DEADLINE_MS);
      await host.refresh();
      const granted = await setup.getApproval(
        "u9-project",
        "u9-caplet",
        "u9-content-hash",
        "local_host",
      );
      trace.approvalGrantVisible = granted?.decision === "grant";
      await writeFile(`${barrier}.approval-read`, "read", { mode: 0o600 });
      await waitForFile(`${barrier}.approval-revoked`, CHILD_DEADLINE_MS);
      await host.refresh();
      const revoked = await setup.getApproval(
        "u9-project",
        "u9-caplet",
        "u9-content-hash",
        "local_host",
      );
      trace.approvalRevokeVisible = revoked?.decision === "revoke";
    }

    const remote = new AuthorityRemoteServerCredentialStore({
      authority,
      authorityId,
      currentHostId: `u9-remote-${role}`,
      principalId: `u9-remote-${role}`,
      encryptionKey,
    });
    const hostUrl = "https://u9.invalid";
    if (role === "a") {
      const pending = await remote.createPendingLogin({
        hostUrl,
        requestedRole: "operator",
        clientLabel: "u9-replica",
        clientFingerprint: "u9-fingerprint",
        sourceHint: "u9-source",
        idempotencyKey: "u9-child-pending-create",
        now: now(),
      });
      const refreshed = await remote.refreshPendingLogin({
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
        pendingRefreshSecret: pending.pendingRefreshSecret,
        idempotencyKey: "u9-child-pending-refresh",
        now: now(),
      });
      const replayed = await remote.refreshPendingLogin({
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
        pendingRefreshSecret: pending.pendingRefreshSecret,
        idempotencyKey: "u9-child-pending-refresh-replay",
        now: now(),
      });
      if (replayed.operatorCode !== refreshed.operatorCode)
        throw new Error("two-process pending refresh replay changed response");
      await remote.approvePendingLogin({
        operatorCode: refreshed.operatorCode,
        grantedRole: "operator",
        idempotencyKey: "u9-child-pending-approve",
        now: now(),
      });
      const issued = await remote.completePendingLogin({
        flowId: pending.flowId,
        pendingCompletionSecret: pending.pendingCompletionSecret,
        hostUrl,
        requiredRole: "operator",
        idempotencyKey: "u9-child-pending-complete",
        now: now(),
      });
      await remote.validateAccessToken({
        hostUrl,
        accessToken: issued.accessToken,
        now: now(),
      });
      trace.sessionValidBeforeRevoke = true;
      await writeFile(
        `${barrier}.credentials.json`,
        JSON.stringify({ accessToken: issued.accessToken, clientId: issued.clientId }),
        { mode: 0o600 },
      );
      await writeFile(`${barrier}.remote-ready`, "ready", { mode: 0o600 });
      await waitForFile(`${barrier}.remote-validated`, CHILD_DEADLINE_MS);
      const revoked = await remote.revokeClient(issued.clientId, now(), {
        idempotencyKey: "u9-child-client-revoke",
      });
      if (!revoked) throw new Error("two-process session revoke did not apply");
      await host.refresh();
      try {
        await remote.validateAccessToken({
          hostUrl,
          accessToken: issued.accessToken,
          now: now(),
        });
      } catch {
        trace.sessionRevokedAfterRefresh = true;
      }
      await writeFile(`${barrier}.remote-revoked`, "revoked", { mode: 0o600 });
    } else {
      await waitForFile(`${barrier}.remote-ready`, CHILD_DEADLINE_MS);
      const encoded = JSON.parse(await readFile(`${barrier}.credentials.json`, "utf8")) as unknown;
      if (!isRecord(encoded) || typeof encoded.accessToken !== "string")
        throw new Error("two-process credential handoff invalid");
      await remote.validateAccessToken({
        hostUrl,
        accessToken: encoded.accessToken,
        now: now(),
      });
      trace.sessionValidBeforeRevoke = true;
      await writeFile(`${barrier}.remote-validated`, "valid", { mode: 0o600 });
      await waitForFile(`${barrier}.remote-revoked`, CHILD_DEADLINE_MS);
      await host.refresh();
      try {
        await remote.validateAccessToken({
          hostUrl,
          accessToken: encoded.accessToken,
          now: now(),
        });
      } catch {
        trace.sessionRevokedAfterRefresh = true;
      }
    }

    if (role === "a") {
      const hintHead = await authority.readHead();
      if (!hintHead) throw new Error("two-process hint head missing");
      const hintGeneration = await authority.readGeneration(hintHead.id);
      if (!isRecord(hintGeneration.snapshot)) throw new Error("two-process hint snapshot invalid");
      const hintResult = await host.commit(
        semanticTraceEnvelope(
          authorityId,
          generationIdentity(hintHead),
          `u9-child-${role}`,
          `u9-child-${role}-dropped-hint`,
          { ...hintGeneration.snapshot, "u9-dropped-refresh-hint": true },
        ),
      );
      if (hintResult.kind !== "committed") throw new Error("two-process hint commit did not win");
      await writeFile(
        `${barrier}.hint-dropped`,
        JSON.stringify({ sequence: hintResult.generation.sequence }),
        { mode: 0o600 },
      );
    }
    await waitForFile(`${barrier}.hint-dropped`, CHILD_DEADLINE_MS);
    const hint = JSON.parse(await readFile(`${barrier}.hint-dropped`, "utf8")) as unknown;
    if (!isRecord(hint) || typeof hint.sequence !== "number")
      throw new Error("two-process hint marker invalid");
    trace.droppedHintConverged = await waitForActiveSequence(host, hint.sequence, {
      refresh: role === "a",
      timeoutMs: DEFAULT_DEADLINE_MS,
    });
    await writeFile(`${barrier}.outage-ready-${role}`, "ready", { mode: 0o600 });
    await waitForFile(`${barrier}.outage`, DEFAULT_DEADLINE_MS);
    const lastKnownGood = hostGeneration(host);
    await host.refresh().catch(() => false);
    const outageHealth = await host.health();
    const afterOutage = hostGeneration(host);
    trace.outageLastKnownGood =
      afterOutage.id === lastKnownGood.id && afterOutage.sequence === lastKnownGood.sequence;
    trace.outageDegraded =
      outageHealth.connectivity === "degraded" &&
      outageHealth.readiness === "ready" &&
      outageHealth.activeGeneration?.id === lastKnownGood.id;
    try {
      await host.commit(
        semanticTraceEnvelope(
          authorityId,
          lastKnownGood,
          `u9-child-${role}`,
          `u9-child-${role}-outage-write`,
          { ...hostSnapshot(host), "u9-outage-write": true },
        ),
      );
    } catch {
      trace.outageWriteRejected = true;
    }
    await writeFile(`${barrier}.outage-done-${role}`, "done", { mode: 0o600 });
    await waitForFile(`${barrier}.recovery`, DEFAULT_DEADLINE_MS);
    await waitForActiveSequence(host, lastKnownGood.sequence, {
      refresh: true,
      healthy: true,
      timeoutMs: DEFAULT_DEADLINE_MS,
    });
    const recoveryHealth = await host.health();
    trace.recoveryHealthy =
      recoveryHealth.connectivity === "healthy" &&
      recoveryHealth.writable &&
      recoveryHealth.readiness === "ready" &&
      hostGeneration(host).id === lastKnownGood.id;
    trace.recoveryStatus = {
      connectivity: recoveryHealth.connectivity,
      writable: recoveryHealth.writable,
      refresh: recoveryHealth.refresh,
      readiness: recoveryHealth.readiness,
      activeSequence: recoveryHealth.activeGeneration?.sequence ?? null,
      ...(recoveryHealth.code ? { code: recoveryHealth.code } : {}),
      ...(recoveryHealth.lastError?.code ? { lastErrorCode: recoveryHealth.lastError.code } : {}),
    };

    const replacementSequence = hostGeneration(host).sequence;
    await host.close();
    host = undefined;
    authority = await openAuthority(spec, { verifySchema: true });
    host = await assembleCapletsHost({
      authority,
      configPath: join(tmpdir(), `caplets-u9-child-${process.pid}-${role}-replacement.json`),
      pollIntervalMs: 100,
      readDeadlineMs: 2_000,
      activationDeadlineMs: 2_000,
    });
    const replacement = hostGeneration(host);
    trace.replacementConverged = replacement.sequence === replacementSequence;
    const replacementHead = await authority.readHead();
    if (!replacementHead) throw new Error("two-process replacement head missing");
    const replacementGeneration = await authority.readGeneration(replacementHead.id);
    trace.replacementSnapshotParity =
      JSON.stringify(replacementGeneration.snapshot) ===
      JSON.stringify(host.view.authorityGeneration?.snapshot);
    process.stdout.write(`${JSON.stringify(trace)}\n`);
  } finally {
    if (host) await host.close().catch(() => undefined);
    else if (authority) await authority.close().catch(() => undefined);
  }
}

async function gitMetadata(): Promise<{ commit: string; lock: string; pnpm: string }> {
  const git = await runProcess("git", ["rev-parse", "HEAD"], { timeoutMs: 2_000 });
  const commit = git.code === 0 ? git.stdout.trim().slice(0, 40) : "unknown";
  let lock = "unknown";
  try {
    lock = createHash("sha256")
      .update(await readFile("pnpm-lock.yaml"))
      .digest("hex")
      .slice(0, 16);
  } catch {
    // Keep evidence finite when the lockfile is unavailable.
  }
  const pnpm = await runProcess("pnpm", ["--version"], { timeoutMs: 2_000 });
  return { commit, lock, pnpm: pnpm.code === 0 ? pnpm.stdout.trim() : "unknown" };
}

async function runMatrix(live: LiveProvider[]): Promise<Evidence> {
  const metadata = await gitMetadata();
  const runId = `u9-${process.pid}-${randomUUID().slice(0, 12)}`.toLowerCase();
  const workRoot = await mkdtemp(join(tmpdir(), `caplets-${runId}-`));
  const project = `caplets-${runId}`.slice(0, 56);
  let fixture: FixtureRuntime | undefined;
  const providerVersions: Record<string, string> = {};
  const runtimeTraces: Partial<Record<"postgresql" | "minio", RuntimeTraceEvidence>> = {};
  const targets: ProviderTarget[] = [];
  const restoreProfiles: Array<{
    profile: NonNullable<ProviderSpec["profile"]>;
    namespace: string;
    forcePathStyle: boolean;
  }> = [];
  let evidence: Evidence | undefined;
  let cleanupFailure: Error | undefined;
  try {
    fixture = await startFixtures(project);
    await ensureBucket(
      {
        bucket: MINIO_BUCKET,
        region: "us-east-1",
        endpoint: fixture.minioEndpoint,
        credentials: { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY },
      },
      true,
    );
    const deterministicSpecs: ProviderSpec[] = [
      {
        provider: "filesystem",
        authorityId: `${runId}-filesystem`,
        namespace: `${runId}-filesystem`,
        root: join(workRoot, "filesystem"),
      },
      {
        provider: "sqlite",
        authorityId: `${runId}-sqlite`,
        namespace: `${runId}-sqlite`,
        databasePath: join(workRoot, "sqlite", "authority.db"),
      },
      {
        provider: "postgresql",
        authorityId: `${runId}-postgresql`,
        namespace: `${runId}-postgresql`,
        connectionString: fixture.postgresUrl,
      },
      {
        provider: "minio",
        authorityId: `${runId}-minio`,
        namespace: `${runId}-minio`,
        profile: {
          provider: "r2",
          bucket: MINIO_BUCKET,
          region: "us-east-1",
          endpoint: fixture.minioEndpoint,
          credentials: { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY },
        },
        forcePathStyle: true,
      },
    ];
    for (const spec of deterministicSpecs) {
      const target = await createTarget(spec, { verifySchema: false });
      targets.push(target);
      providerVersions[spec.provider] = target.version;
      let restoreSpec = restoreSpecFor(spec);
      if (spec.provider === "postgresql" && spec.connectionString) {
        const database = `${runId.replaceAll("-", "_")}_restore`;
        await createPostgresRestoreDatabase(project, fixture.env, database);
        restoreSpec = {
          ...spec,
          connectionString: spec.connectionString.replace(/\/[^/]+$/u, `/${database}`),
        };
      }
      if (spec.provider === "minio" && spec.profile) {
        const restoreBucket = `${MINIO_BUCKET}-${runId.slice(-12)}-restore`;
        const restoreProfile = { ...spec.profile, bucket: restoreBucket };
        await ensureBucket(restoreProfile, true);
        restoreProfiles.push({
          profile: restoreProfile,
          namespace: spec.namespace,
          forcePathStyle: true,
        });
        restoreSpec = { ...spec, profile: restoreProfile };
      }
      await withDeadline(
        runProviderContract({
          authority: target.authority,
          authorityId: spec.authorityId,
          namespace: spec.namespace,
          provider: spec.provider,
          ...(spec.provider === "minio" ? { authorityProvider: "s3" } : {}),
          makeReplica: target.makeReplica,
          ...(restoreSpec
            ? { makeRestoreTarget: async () => await openRestoreAuthority(restoreSpec) }
            : {}),
        }),
        DEFAULT_DEADLINE_MS,
        `${spec.provider} contract`,
      );
      if (fixture && (spec.provider === "postgresql" || spec.provider === "minio")) {
        runtimeTraces[spec.provider] = await runTwoProcessTrace(target, fixture, project);
      }
    }
    const filesystemTarget = targets.find((target) => target.spec.provider === "filesystem");
    if (filesystemTarget && filesystemTarget.spec.root) {
      const migrationSpec: ProviderSpec = {
        provider: "sqlite",
        authorityId: filesystemTarget.spec.authorityId,
        namespace: filesystemTarget.spec.namespace,
        databasePath: join(workRoot, "migration", "authority.db"),
      };
      const migrationTarget = await createTarget(migrationSpec, { verifySchema: false });
      targets.push(migrationTarget);
      const migration = await withDeadline(
        migrateAuthority({
          source: filesystemTarget.authority,
          target: migrationTarget.authority,
          owner: `${runId}-migration`,
        }),
        DEFAULT_DEADLINE_MS,
        "filesystem-to-sqlite migration",
      );
      if (migration.kind !== "applied") throw new Error("MIGRATION_DID_NOT_APPLY");
    }
    for (const provider of live) {
      const profile = liveProfile(provider);
      await ensureBucket(profile);
      const spec: ProviderSpec = {
        provider,
        authorityId: `${runId}-${provider}`,
        namespace: `${runId}-${provider}`,
        profile,
      };
      const target = await createTarget(spec, { verifySchema: true });
      targets.push(target);
      await withDeadline(
        runProviderContract({
          authority: target.authority,
          authorityId: spec.authorityId,
          namespace: spec.namespace,
          provider,
          authorityProvider: "s3",
          makeReplica: target.makeReplica,
        }),
        DEFAULT_DEADLINE_MS,
        `${provider} contract`,
      );
    }
    const trace = {
      postgresql: runtimeTraces.postgresql,
      minio: runtimeTraces.minio,
    };
    if (!trace.postgresql || !trace.minio) throw new Error("PROVIDER_RUNTIME_TRACE_MISSING");
    evidence = {
      commit: metadata.commit,
      lock: metadata.lock,
      runtime: { node: process.version, pnpm: metadata.pnpm },
      providers: providerVersions,
      trace: { postgresql: trace.postgresql, minio: trace.minio },
      timestamp: new Date().toISOString(),
      result: "passed",
    };
  } finally {
    for (const restore of restoreProfiles.reverse()) {
      try {
        await cleanupBucket(restore.profile, restore.namespace, restore.forcePathStyle);
      } catch (error) {
        cleanupFailure =
          error instanceof Error ? error : new Error("PROVIDER_RESTORE_CLEANUP_FAILED");
      }
    }
    for (const target of targets.reverse()) {
      try {
        if (target.spec.profile)
          await cleanupBucket(
            target.spec.profile,
            target.spec.namespace,
            target.spec.forcePathStyle ?? false,
          );
      } catch (error) {
        cleanupFailure = error instanceof Error ? error : new Error("PROVIDER_CLEANUP_FAILED");
      }
      try {
        await target.authority.close();
      } catch (error) {
        cleanupFailure = error instanceof Error ? error : new Error("PROVIDER_CLOSE_FAILED");
      }
    }
    if (fixture) {
      try {
        await stopFixtures(project, fixture.env);
      } catch (error) {
        cleanupFailure = error instanceof Error ? error : new Error("FIXTURE_CLEANUP_FAILED");
      }
    }
    await rm(workRoot, { recursive: true, force: true });
  }
  if (cleanupFailure) throw cleanupFailure;
  if (!evidence) throw new Error("PROVIDER_MATRIX_EVIDENCE_MISSING");
  return evidence;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--child")) {
    try {
      await runChild(args);
    } catch (error) {
      const code = safeError(error);
      const detail =
        error instanceof Error && /^(?:ReferenceError|TypeError)$/u.test(code)
          ? `${code}:${error.message.replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 160)}`
          : code;
      process.stdout.write(`${JSON.stringify({ kind: "error", code: detail })}\n`);
      process.exitCode = 1;
    }
    return;
  }
  const live = parseLiveTargets(args);
  const metadata = await gitMetadata();
  try {
    const missing: string[] = [];
    for (const provider of live) {
      try {
        liveProfile(provider);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("LIVE_CREDENTIALS_MISSING:")) {
          missing.push(error.message);
          continue;
        }
        throw error;
      }
    }
    if (missing.length > 0) throw new Error(missing.join("|"));
    const evidence = await runMatrix(live);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch (error) {
    const code = safeError(error);
    const blocked = code.startsWith("LIVE_CREDENTIALS_MISSING") || code === "UNKNOWN";
    const evidence: Evidence = {
      commit: metadata.commit,
      lock: metadata.lock,
      runtime: { node: process.version, pnpm: metadata.pnpm },
      providers: live.length > 0 ? { requestedLive: live.join(",") } : {},
      timestamp: new Date().toISOString(),
      result: blocked ? "blocked" : "failed",
    };
    process.stderr.write(`storage provider matrix ${evidence.result}: ${code}\n`);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    process.exitCode = 1;
  }
}

if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  await main();
}

export { liveProfile, parseLiveTargets, runMatrix };
