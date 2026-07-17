import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it } from "vitest";
import { createArtifactProviderIdentity } from "../src/control-plane/artifacts/provider";
import {
  createProductionPostgresVerifier,
  createProductionS3CanaryVerifier,
} from "../src/control-plane/production-adapters";

const s3Endpoint = process.env.CAPLETS_TEST_S3_ENDPOINT;
const clients: S3Client[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
});

describe("production storage verification adapters", () => {
  it("derives Postgres identity and least-privilege capability facts without returning credentials", async () => {
    const configurations: Readonly<Record<string, unknown>>[] = [];
    class Pool {
      constructor(configuration: Readonly<Record<string, unknown>>) {
        configurations.push(configuration);
      }
      async connect() {
        return {
          async query(sql: string) {
            if (sql.includes("__caplets_storage_identity_v1")) {
              return {
                rows: [
                  {
                    logicalHostId: "host_01J00000000000000000000000",
                    storeId: "store_01J00000000000000000000000",
                  },
                ],
              };
            }
            if (sql.includes("FROM pg_catalog.pg_roles WHERE")) {
              return {
                rows: [
                  {
                    databaseRole: "caplets_runtime",
                    superuser: false,
                    createDatabase: false,
                    createRole: false,
                    replication: false,
                    bypassRowLevelSecurity: false,
                  },
                ],
              };
            }
            if (sql.includes("pg_auth_members")) return { rows: [] };
            if (sql.includes("cp_operation_namespace")) {
              return { rows: [{ operationNamespace: "operations_01J00000000000000000000000" }] };
            }
            if (sql.includes("pg_catalog.pg_database")) {
              return { rows: [{ database: "caplets", oid: "16384" }] };
            }
            throw new Error("unexpected query");
          },
          release() {},
        };
      }
      async end() {}
    }
    const verify = createProductionPostgresVerifier({ postgresPool: Pool });
    const result = await verify({
      connectionString:
        "postgresql://caplets_runtime:highly-sensitive@db.example.test/caplets?sslmode=verify-full",
      tls: { mode: "verify-full", serverName: "db.example.test", ca: "test-ca" },
      role: "caplets_runtime",
    });

    expect(result).toMatchObject({
      logicalHostId: "host_01J00000000000000000000000",
      storeId: "store_01J00000000000000000000000",
      databaseRole: "caplets_runtime",
      canSetRole: false,
      inheritedRoles: [],
      privileges: {
        superuser: false,
        createDatabase: false,
        createRole: false,
        replication: false,
        bypassRowLevelSecurity: false,
      },
      operationNamespace: "operations_01J00000000000000000000000",
    });
    expect(result.databaseIdentity).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(result)).not.toContain("highly-sensitive");
    expect(configurations[0]?.connectionString).toBe(
      "postgresql://caplets_runtime:highly-sensitive@db.example.test/caplets",
    );
    expect(configurations[0]).toMatchObject({
      max: 1,
      connectionTimeoutMillis: 2_000,
      ssl: { rejectUnauthorized: true, servername: "db.example.test", ca: "test-ca" },
    });
  });

  it.skipIf(!s3Endpoint)(
    "verifies a real S3-compatible bucket and immutable provider canary",
    async () => {
      const credentials = { accessKeyId: "caplets-minio", secretAccessKey: "caplets-minio-secret" };
      const client = new S3Client({
        endpoint: s3Endpoint!,
        region: "us-east-1",
        forcePathStyle: true,
        credentials,
      });
      clients.push(client);
      const bucket = `caplets-u10-${process.pid}`;
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      const identity = createArtifactProviderIdentity({
        kind: "s3",
        provider: `${new URL(s3Endpoint!).origin}/${bucket}`,
        namespace: "control-plane",
        logicalHostId: "host_01J00000000000000000000000",
        storeId: "store_01J00000000000000000000000",
      });
      const verify = createProductionS3CanaryVerifier({ deadlineMs: 2_000 });
      const request = {
        endpoint: s3Endpoint!,
        region: "us-east-1",
        bucket,
        prefix: "control-plane",
        ...credentials,
        identity,
        expectedCanary: "a".repeat(64),
        createIfMissing: true,
      } as const;

      await expect(verify(request)).resolves.toEqual({ identity, matches: true });
      await expect(verify({ ...request, createIfMissing: false })).resolves.toEqual({
        identity,
        matches: true,
      });
      await expect(
        verify({ ...request, expectedCanary: "b".repeat(64), createIfMissing: false }),
      ).rejects.toMatchObject({
        code: "AUTH_FAILED",
        message: "S3 artifact compatibility verification failed.",
      });
    },
  );
});
