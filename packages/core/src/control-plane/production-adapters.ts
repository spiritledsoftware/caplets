import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { CapletsError } from "../errors";
import type { LocalAuthorityOwner } from "../current-host/authority";
import { artifactProviderCanaryKey } from "./artifacts/provider";
import { S3ArtifactProvider, type S3CommandClient } from "./artifacts/s3";
import { createDarwinSecureFilesystemAdapter } from "./native/darwin-secure-filesystem";
import { createWindowsSecureFilesystemAdapter } from "./native/windows-secure-filesystem";
import type { SecureFilesystemOptions } from "./secure-state";
import {
  normalizedPostgresConnectionReference,
  type PostgresVerificationRequest,
  type PostgresVerificationResult,
  type S3CanaryVerificationRequest,
  type S3CanaryVerificationResult,
} from "./storage-config";

const require = createRequire(import.meta.url);
const DEFAULT_ADAPTER_DEADLINE_MS = 2_000;

type QueryResult = Readonly<{ rows: readonly Readonly<Record<string, unknown>>[] }>;
type ProductionPostgresClient = Readonly<{
  query(sql: string, parameters?: readonly unknown[]): Promise<QueryResult>;
  release(): void;
}>;
type ProductionPostgresPool = Readonly<{
  connect(): Promise<ProductionPostgresClient>;
  end(): Promise<void>;
}>;
type ProductionPostgresPoolConstructor = new (
  configuration: Readonly<Record<string, unknown>>,
) => ProductionPostgresPool;

export type ProductionStorageAdapterOptions = Readonly<{
  deadlineMs?: number | undefined;
  postgresPool?: ProductionPostgresPoolConstructor | undefined;
  s3Client?: ((configuration: S3ClientConfig) => S3CommandClient) | undefined;
}>;

export type ProductionSecureFilesystemOptions = Readonly<{
  expectedOwner: LocalAuthorityOwner;
  filesystem: SecureFilesystemOptions;
}>;

export async function createProductionSecureFilesystemOptions(): Promise<ProductionSecureFilesystemOptions> {
  if (process.platform === "win32") {
    const windows = await createWindowsSecureFilesystemAdapter();
    return {
      expectedOwner: { kind: "windows", sid: windows.expectedServiceSid },
      filesystem: {
        platform: "win32",
        expectedServiceSid: windows.expectedServiceSid,
        nativeAdapter: windows.nativeAdapter,
        verifyWindowsDacl: windows.verifyWindowsDacl,
      },
    };
  }
  const uid = process.getuid?.();
  if (uid === undefined || (process.platform !== "linux" && process.platform !== "darwin")) {
    throw new CapletsError("AUTH_FAILED", "Secure filesystem platform authority is unavailable.");
  }
  return {
    expectedOwner: { kind: "posix", uid },
    filesystem: {
      platform: process.platform,
      expectedUid: uid,
      ...(process.platform === "darwin"
        ? { nativeAdapter: createDarwinSecureFilesystemAdapter() }
        : {}),
    },
  };
}

export function createProductionPostgresVerifier(
  options: ProductionStorageAdapterOptions = {},
): (request: PostgresVerificationRequest) => Promise<PostgresVerificationResult> {
  const deadlineMs = validatedDeadline(options.deadlineMs);
  const Pool = options.postgresPool ?? loadPostgresPool();
  return async (request) => {
    const url = normalizedPostgresConnectionReference(
      request.connectionString,
      request.role,
      request.tls.serverName,
    );
    const pool = new Pool({
      connectionString: url.href,
      max: 1,
      connectionTimeoutMillis: deadlineMs,
      query_timeout: deadlineMs,
      statement_timeout: deadlineMs,
      ssl: {
        rejectUnauthorized: true,
        servername: request.tls.serverName,
        ...(request.tls.ca === undefined ? {} : { ca: request.tls.ca }),
      },
    });
    let client: ProductionPostgresClient | undefined;
    try {
      client = await withAdapterDeadline(pool.connect(), deadlineMs);
      const identity = singleRow(
        await withAdapterDeadline(
          client.query(
            `SELECT logical_host_id AS "logicalHostId", store_id AS "storeId"
             FROM caplets.__caplets_storage_identity_v1 WHERE singleton = 1`,
          ),
          deadlineMs,
        ),
        "Postgres storage identity",
      );
      const role = singleRow(
        await withAdapterDeadline(
          client.query(
            `SELECT current_user AS "databaseRole", rolsuper AS superuser,
                    rolcreatedb AS "createDatabase", rolcreaterole AS "createRole",
                    rolreplication AS replication, rolbypassrls AS "bypassRowLevelSecurity"
             FROM pg_catalog.pg_roles WHERE rolname = current_user`,
          ),
          deadlineMs,
        ),
        "Postgres role identity",
      );
      const authority = singleRow(
        await withAdapterDeadline(
          client.query(
            `WITH active_role AS (
               SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user
             ), caplets_namespace AS (
               SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = 'caplets'
             )
             SELECT
               EXISTS (
                 SELECT 1 FROM pg_catalog.pg_database database, active_role
                 WHERE database.datname = current_database() AND database.datdba = active_role.oid
               ) AS "ownsDatabase",
               EXISTS (
                 SELECT 1 FROM pg_catalog.pg_namespace namespace, active_role
                 WHERE namespace.nspname = 'caplets' AND namespace.nspowner = active_role.oid
               ) AS "ownsSchema",
               (
                 EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_class relation, caplets_namespace, active_role
                   WHERE relation.relnamespace = caplets_namespace.oid
                     AND relation.relowner = active_role.oid
                 )
                 OR EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_proc function, caplets_namespace, active_role
                   WHERE function.pronamespace = caplets_namespace.oid
                     AND function.proowner = active_role.oid
                 )
                 OR EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_type type, caplets_namespace, active_role
                   WHERE type.typnamespace = caplets_namespace.oid
                     AND type.typowner = active_role.oid
                 )
               ) AS "ownsControlPlaneObject",
               COALESCE(
                 pg_catalog.has_database_privilege(current_user, current_database(), 'CREATE'),
                 false
               ) AS "canCreateInDatabase",
               COALESCE(
                 pg_catalog.has_schema_privilege(
                   current_user,
                   pg_catalog.to_regnamespace('caplets'),
                   'CREATE'
                 ),
                 false
               ) AS "canCreateInSchema"`,
          ),
          deadlineMs,
        ),
        "Postgres role authority",
      );
      if (
        request.roleKind !== "migrator" &&
        [
          "ownsDatabase",
          "ownsSchema",
          "ownsControlPlaneObject",
          "canCreateInDatabase",
          "canCreateInSchema",
        ].some((capability) => booleanValue(authority[capability], capability))
      ) {
        throw new CapletsError(
          "AUTH_FAILED",
          "Postgres runtime or maintenance role retains owner or DDL authority.",
        );
      }
      const inherited = await withAdapterDeadline(
        client.query(
          `SELECT inherited.rolname AS role
           FROM pg_catalog.pg_auth_members membership
           JOIN pg_catalog.pg_roles member ON member.oid = membership.member
           JOIN pg_catalog.pg_roles inherited ON inherited.oid = membership.roleid
           WHERE member.rolname = current_user ORDER BY inherited.rolname`,
        ),
        deadlineMs,
      );
      const namespaceResult = await withAdapterDeadline(
        client.query(
          `SELECT namespace_id AS "operationNamespace"
           FROM caplets.cp_operation_namespace
           WHERE logical_host_id = $1 AND store_id = $2 AND state = 'active'
           ORDER BY generation DESC LIMIT 1`,
          [identity.logicalHostId, identity.storeId],
        ),
        deadlineMs,
      );
      if (namespaceResult.rows.length > 1) {
        throw new Error("Postgres operation namespace is ambiguous");
      }
      const namespace = namespaceResult.rows[0];
      const database = singleRow(
        await withAdapterDeadline(
          client.query(
            `SELECT current_database() AS database, oid::text AS oid
             FROM pg_catalog.pg_database WHERE datname = current_database()`,
          ),
          deadlineMs,
        ),
        "Postgres database identity",
      );
      const inheritedRoles = inherited.rows.map((row) => stringValue(row.role, "inherited role"));
      return Object.freeze({
        logicalHostId: stringValue(identity.logicalHostId, "logical host"),
        storeId: stringValue(identity.storeId, "store"),
        tlsPeerServerName: request.tls.serverName,
        databaseRole: stringValue(role.databaseRole, "database role"),
        canSetRole: inheritedRoles.length > 0,
        inheritedRoles,
        privileges: Object.freeze({
          superuser: booleanValue(role.superuser, "superuser"),
          createDatabase: booleanValue(role.createDatabase, "create database"),
          createRole: booleanValue(role.createRole, "create role"),
          replication: booleanValue(role.replication, "replication"),
          bypassRowLevelSecurity: booleanValue(
            role.bypassRowLevelSecurity,
            "bypass row-level security",
          ),
        }),
        ...(namespace
          ? {
              operationNamespace: stringValue(namespace.operationNamespace, "operation namespace"),
            }
          : {}),
        databaseIdentity: createHash("sha256")
          .update(
            [
              stringValue(identity.logicalHostId, "logical host"),
              stringValue(identity.storeId, "store"),
              stringValue(database.database, "database"),
              stringValue(database.oid, "database oid"),
            ].join("\u001f"),
          )
          .digest("hex"),
      });
    } catch {
      throw new CapletsError("AUTH_FAILED", "Postgres identity verification failed.");
    } finally {
      client?.release();
      await pool.end().catch(() => undefined);
    }
  };
}

export function createProductionS3ArtifactProvider(
  request: S3CanaryVerificationRequest,
  options: ProductionStorageAdapterOptions = {},
): Readonly<{ provider: S3ArtifactProvider; close(): void }> {
  const deadlineMs = validatedDeadline(options.deadlineMs);
  const { client, close } = createProductionS3Client(request, options, deadlineMs);
  return {
    provider: new S3ArtifactProvider(client, {
      bucket: request.bucket,
      prefix: request.prefix,
      identity: request.identity,
    }),
    close,
  };
}

export function createProductionS3CanaryVerifier(
  options: ProductionStorageAdapterOptions = {},
): (request: S3CanaryVerificationRequest) => Promise<S3CanaryVerificationResult> {
  const deadlineMs = validatedDeadline(options.deadlineMs);
  return async (request) => {
    const { client, close } = createProductionS3Client(request, options, deadlineMs);
    try {
      await client.send(new HeadBucketCommand({ Bucket: request.bucket }));
      const canaryKey = artifactProviderCanaryKey(request.identity);
      if (!request.createIfMissing) {
        await client.send(new HeadObjectCommand({ Bucket: request.bucket, Key: canaryKey }));
      }
      const provider = new S3ArtifactProvider(client, {
        bucket: request.bucket,
        prefix: request.prefix,
        identity: request.identity,
      });
      await provider.verifyCanary(request.expectedCanary);
      return Object.freeze({ identity: request.identity, matches: true });
    } catch {
      throw new CapletsError("AUTH_FAILED", "S3 artifact compatibility verification failed.");
    } finally {
      close();
    }
  };
}

function createProductionS3Client(
  request: S3CanaryVerificationRequest,
  options: ProductionStorageAdapterOptions,
  deadlineMs: number,
): Readonly<{ client: S3CommandClient; close(): void }> {
  const configuration: S3ClientConfig = {
    endpoint: request.endpoint,
    region: request.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: request.accessKeyId,
      secretAccessKey: request.secretAccessKey,
    },
  };
  const rawClient = options.s3Client?.(configuration) ?? new S3Client(configuration);
  const client: S3CommandClient = {
    send(command) {
      if (rawClient instanceof S3Client) {
        return rawClient.send(command as never, {
          abortSignal: AbortSignal.timeout(deadlineMs),
        });
      }
      return withAdapterDeadline(rawClient.send(command), deadlineMs);
    },
  };
  return {
    client,
    close() {
      if (rawClient instanceof S3Client) rawClient.destroy();
    },
  };
}

function loadPostgresPool(): ProductionPostgresPoolConstructor {
  const moduleValue: unknown = require("pg");
  if (!moduleValue || typeof moduleValue !== "object" || !("Pool" in moduleValue)) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Postgres driver is unavailable.");
  }
  return moduleValue.Pool as ProductionPostgresPoolConstructor;
}

function singleRow(result: QueryResult, label: string): Readonly<Record<string, unknown>> {
  if (result.rows.length !== 1) {
    throw new CapletsError("AUTH_FAILED", `${label} is unavailable.`);
  }
  return result.rows[0]!;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CapletsError("AUTH_FAILED", `Postgres ${label} is invalid.`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new CapletsError("AUTH_FAILED", `Postgres ${label} capability is invalid.`);
  }
  return value;
}

function validatedDeadline(value: number | undefined): number {
  const deadline = value ?? DEFAULT_ADAPTER_DEADLINE_MS;
  if (!Number.isSafeInteger(deadline) || deadline <= 0 || deadline > 5_000) {
    throw new CapletsError("CONFIG_INVALID", "Storage adapter deadline is invalid.");
  }
  return deadline;
}

async function withAdapterDeadline<T>(operation: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = Promise.withResolvers<never>();
  try {
    timer = setTimeout(
      () =>
        deadline.reject(new CapletsError("SERVER_UNAVAILABLE", "Storage verification timed out.")),
      deadlineMs,
    );
    timer.unref();
    return await Promise.race([operation, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}
