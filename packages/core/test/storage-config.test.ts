import { describe, expect, it } from "vitest";
import { configJsonSchema, parseConfig, type PostgresStorageConfig } from "../src/config";
import { CapletsError } from "../src/errors";

const logicalHostId = "host_01J00000000000000000000000";
const storeId = "store_01J00000000000000000000000";

function postgresStorage(): PostgresStorageConfig {
  return {
    kind: "postgres" as const,
    stateRoot: "/var/lib/caplets/node",
    logicalHostId,
    expectedStoreId: storeId,
    processRole: "online" as const,
    connection: {
      tls: { mode: "verify-full" as const, serverName: "postgres.internal" },
      roles: {
        runtime: {
          role: "caplets_runtime",
          credential: { kind: "env" as const, name: "CAPLETS_PG_RUNTIME_URL" },
        },
        migrator: {
          role: "caplets_migrator",
          credential: { kind: "env" as const, name: "CAPLETS_PG_MIGRATOR_URL" },
        },
        maintenance: {
          role: "caplets_maintenance",
          credential: { kind: "file" as const, path: "/run/secrets/pg-maintenance" },
        },
      },
    },
    keyProviderManifest: "/run/secrets/caplets/online.manifest.json",
    artifacts: {
      kind: "s3" as const,
      endpoint: "https://objects.internal",
      region: "us-east-1",
      bucket: "caplets-control-plane",
      prefix: "hosts/current",
      canary: { kind: "env" as const, name: "CAPLETS_S3_CANARY" },
      credentials: {
        accessKeyId: { kind: "env" as const, name: "CAPLETS_S3_ACCESS_KEY_ID" },
        secretAccessKey: { kind: "file" as const, path: "/run/secrets/s3-secret-key" },
      },
    },
    migration: { designated: false },
    retention: { backupDays: 30 },
  };
}

describe("deployment-owned storage config", () => {
  it("keeps Postgres and S3 credentials as references in parsed public config", () => {
    process.env.CAPLETS_PG_RUNTIME_URL = "postgres://sentinel-runtime-secret";
    process.env.CAPLETS_S3_ACCESS_KEY_ID = "sentinel-s3-secret";

    const config = parseConfig({ serve: { storage: postgresStorage() } });

    expect(config.serve?.storage).toEqual(postgresStorage());
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain("sentinel-runtime-secret");
    expect(serialized).not.toContain("sentinel-s3-secret");
    expect(serialized).toContain("CAPLETS_PG_RUNTIME_URL");
  });

  it("accepts strict explicit SQLite paths without resolving key material", () => {
    const storage = {
      kind: "sqlite" as const,
      stateRoot: "/srv/caplets/state",
      databasePath: "/srv/caplets/state/control-plane.sqlite",
      keyProviderManifest: "/srv/caplets/state/key-provider/online.manifest.json",
      artifacts: { kind: "filesystem" as const, root: "/srv/caplets/state/artifacts" },
    };

    expect(parseConfig({ serve: { storage } }).serve?.storage).toEqual(storage);
  });

  it("rejects unknown keys, aliased roles, unsafe TLS, and local Postgres artifacts", () => {
    expect(() =>
      parseConfig({ serve: { storage: { ...postgresStorage(), password: "plaintext" } } }),
    ).toThrow(CapletsError);

    const aliased = postgresStorage();
    aliased.connection.roles.migrator = { ...aliased.connection.roles.runtime };
    expect(() => parseConfig({ serve: { storage: aliased } })).toThrow(CapletsError);

    const aliasedPaths = postgresStorage();
    aliasedPaths.connection.roles.runtime.credential = {
      kind: "file",
      path: "/run/secrets/roles/../shared",
    };
    aliasedPaths.connection.roles.migrator.credential = {
      kind: "file",
      path: "/run/secrets/shared",
    };
    expect(() => parseConfig({ serve: { storage: aliasedPaths } })).toThrow(CapletsError);

    const aliasedS3Credentials = postgresStorage();
    aliasedS3Credentials.artifacts.credentials.secretAccessKey =
      aliasedS3Credentials.artifacts.credentials.accessKeyId;
    expect(() => parseConfig({ serve: { storage: aliasedS3Credentials } })).toThrow(CapletsError);
    const aliasedCanary = postgresStorage();
    aliasedCanary.artifacts.canary = aliasedCanary.artifacts.credentials.accessKeyId;
    expect(() => parseConfig({ serve: { storage: aliasedCanary } })).toThrow(CapletsError);
    const crossAliasedSecret = postgresStorage();
    crossAliasedSecret.artifacts.canary = crossAliasedSecret.connection.roles.runtime.credential;
    expect(() => parseConfig({ serve: { storage: crossAliasedSecret } })).toThrow(CapletsError);

    expect(() =>
      parseConfig({
        serve: {
          storage: {
            ...postgresStorage(),
            connection: {
              ...postgresStorage().connection,
              tls: { mode: "insecure", serverName: "postgres.internal" },
            },
          },
        },
      }),
    ).toThrow(CapletsError);

    expect(() =>
      parseConfig({
        serve: {
          storage: {
            ...postgresStorage(),
            artifacts: { kind: "filesystem", root: "/tmp/artifacts" },
          },
        },
      }),
    ).toThrow(CapletsError);
  });

  it("publishes reference-only discriminated storage schema", () => {
    const schema = JSON.stringify(configJsonSchema());
    expect(schema).toContain('"storage"');
    expect(schema).toContain('"postgres"');
    expect(schema).toContain('"verify-full"');
    expect(schema).toContain('"keyProviderManifest"');
    expect(schema).not.toContain('"password"');
    expect(schema).not.toContain('"connectionString"');
  });
});
