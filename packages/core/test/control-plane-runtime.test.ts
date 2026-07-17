import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MutableHostSettingSchema,
  runtimeFingerprintsForConfigLayers,
  type ConfigVaultResolver,
  type RuntimeConfigLayerInput,
} from "../src/config";
import { createBootstrapFingerprintSnapshot } from "../src/caplet-source/runtime-fingerprint";
import {
  composeControlPlaneRuntimeSnapshot,
  createControlPlaneRuntimeSnapshotLoader,
  resolveControlPlaneCapletMutationTarget,
  resolveControlPlaneHostSettingMutationTarget,
  type ControlPlaneRuntimeHydration,
  type ControlPlaneRuntimePrerequisites,
  type ControlPlaneRuntimeSnapshot,
  type ControlPlaneRuntimeSnapshotLoader,
} from "../src/control-plane/snapshot";
import {
  STORAGE_BENCHMARK_ENVELOPE,
  nearestRank,
} from "../src/control-plane/storage-benchmark-envelope";
import { createInternalCapletsEngine } from "../src/engine";
import { createInternalCapletsRuntime } from "../src/runtime";
import { createInternalCloudRuntimeAdapter } from "../src/cloud/runtime-adapter";
import { createInternalNativeCapletsService } from "../src/native/service";
import { dispatchRemoteCliRequest } from "../src/remote-control/dispatch";
import { createInternalStdioRuntime } from "../src/serve/stdio";
import { serveInternalHttp } from "../src/serve/http";
import { resolveServeOptions } from "../src/serve/options";
import { ServerRegistry } from "../src/registry";
import {
  type CanonicalCapletAggregate,
  validateCapletRelationalProjection,
} from "../src/control-plane/caplets/model";
import { encodePortableCaplet } from "../src/control-plane/caplets/portable-codec";
import { parseCanonicalHostSetting } from "../src/control-plane/model";
import type { ControlPlaneSnapshot, ControlPlaneStoreIdentity } from "../src/control-plane/types";

const identity: ControlPlaneStoreIdentity = {
  logicalHostId: "host_01J00000000000000000000000",
  storeId: "store_01J00000000000000000000000",
  operationNamespace: "operations_01J00000000000000000000000",
};

const runtimeAssetTempDirs: string[] = [];

afterEach(() => {
  for (const dir of runtimeAssetTempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.CAPLETS_U8_SPEC_PATH;
});

function httpAggregate(
  id: string,
  marker: string,
  activation: "active" | "setup-required" = "active",
): ControlPlaneSnapshot["caplets"][number] {
  const aggregate: CanonicalCapletAggregate = {
    modelVersion: 1,
    id,
    aggregateVersion: 1,
    ownership: "sql",
    activation,
    effective: activation === "active",
    portable: {
      portableVersion: 1,
      canonicalModelVersion: 1,
      id,
      name: `SQL ${marker}`,
      description: `SQL ${marker} capability description`,
      sourcePath: `${id}/CAPLET.md`,
      frontmatter: {
        source: { fixture: "u8", marker },
        backend: { kind: "http", config: { marker } },
        declaredInputs: [],
      },
      body: `# ${marker}\n`,
      assets: [],
      references: [],
    },
    installationProvenanceId: `provenance-${id}`,
    updateState: "current",
  };
  return {
    aggregate,
    projection: {
      capletId: id,
      sourceFrontmatter: { fixture: "u8", marker },
      body: aggregate.portable.body,
      backends: [
        {
          capletId: id,
          ordinal: 0,
          kind: "http",
          config: {
            baseUrl: `https://${marker}.example.test`,
            auth: { type: "none" },
            actions: { ping: { method: "GET", path: "/ping" } },
          },
        },
      ],
      assets: [],
      references: [],
      activationHistory: [
        {
          capletId: id,
          sequence: 1,
          from: "absent",
          to: activation,
          reason: "imported",
          actorId: "operator-1",
          aggregateVersion: 1,
          authorityVersion: 1,
          effectiveVersion: 1,
          occurredAt: "2026-07-15T00:00:00.000Z",
        },
      ],
    },
  };
}

function sqlSnapshot(
  caplets: ControlPlaneSnapshot["caplets"] = [httpAggregate("alpha", "sql")],
): ControlPlaneSnapshot {
  return {
    identity,
    versions: { authorityGeneration: 1, effectiveGeneration: 1, securityEpoch: 0 },
    caplets,
    hostSettings: [
      {
        version: 1,
        key: "telemetry",
        value: true,
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
      {
        version: 1,
        key: "options.defaultSearchLimit",
        value: 7,
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
      {
        version: 1,
        key: "native.daemon-url",
        value: { source: "setup", url: "http://127.0.0.1:7210/" },
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
    ],
    encodedBytes: 1,
    normalizedRows: caplets.length * 3 + 3,
  };
}

function prerequisites(
  backend: "sqlite" | "postgres",
  activation: ControlPlaneRuntimePrerequisites["activation"],
  authorityGeneration = 1,
): ControlPlaneRuntimePrerequisites {
  return {
    backend,
    identity,
    storage: { status: "verified" },
    migration: { status: "current" },
    keys: { status: "verified" },
    canary: { status: "verified" },
    schema: { status: "current", version: 1 },
    manifest: { status: "verified", version: 1 },
    compatibility: {
      status: "compatible",
      binaryVersion: "0.34.1",
      schemaVersion: 1,
      keyVersion: 1,
      manifestVersion: 1,
    },
    authority: { status: "active", authorityGeneration, securityEpoch: 0 },
    activation,
  };
}

function bootstrapFingerprintFor(
  filesystemLayers: readonly RuntimeConfigLayerInput[] = [],
  resolvedRuntimeInputs: unknown = {},
  hiddenCommitments: readonly string[] = [],
  providerVersions: Readonly<Record<string, string | number>> = {},
  vaultResolver?: ConfigVaultResolver,
): string {
  const declaredInputFingerprints = runtimeFingerprintsForConfigLayers(filesystemLayers, {
    vaultResolver,
  }).map((fingerprint) => fingerprint.artifactFingerprint);
  return createBootstrapFingerprintSnapshot({
    filesystemInputs: [
      ...filesystemLayers.map((layer) => layer.input),
      { declaredInputFingerprints },
    ],
    resolvedRuntimeInputs,
    hiddenCommitments,
    providerVersions,
  }).fingerprint;
}

const SQL_ONLY_BOOTSTRAP_FINGERPRINT = bootstrapFingerprintFor();

function hydration(
  backend: "sqlite" | "postgres" = "sqlite",
  activation: ControlPlaneRuntimePrerequisites["activation"] = {
    currentFingerprint: SQL_ONLY_BOOTSTRAP_FINGERPRINT,
  },
  snapshot = sqlSnapshot(),
): ControlPlaneRuntimeHydration {
  return {
    snapshot,
    prerequisites: prerequisites(backend, activation, snapshot.versions.authorityGeneration),
  };
}

const hostLayer: RuntimeConfigLayerInput = {
  input: {
    telemetry: false,
    defaultSearchLimit: 11,
    httpApis: {
      alpha: {
        name: "Host alpha",
        description: "Host alpha capability description",
        baseUrl: "https://host.example.test",
        auth: { type: "none" },
        actions: { ping: { method: "GET", path: "/ping" } },
      },
    },
  },
  source: { kind: "global-config", path: "/host/config.json" },
};

const projectLayer: RuntimeConfigLayerInput = {
  input: {
    options: { exposure: "direct" },
    httpApis: {
      alpha: {
        name: "Project alpha",
        description: "Project alpha capability description",
        baseUrl: "https://project.example.test",
        auth: { type: "none" },
        actions: { ping: { method: "GET", path: "/ping" } },
      },
    },
  },
  source: { kind: "project-config", path: "/project/caplets.json" },
};

function gatedRuntimeLoader(snapshot: ControlPlaneRuntimeSnapshot): {
  loader: ControlPlaneRuntimeSnapshotLoader;
  release(): void;
} {
  let release!: () => void;
  let current: ControlPlaneRuntimeSnapshot | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loader: ControlPlaneRuntimeSnapshotLoader = {
    initialize: async () => {
      await gate;
      current = snapshot;
      return snapshot;
    },
    reload: async () => {
      await gate;
      return snapshot;
    },
    commit: (next) => {
      current = next;
      return true;
    },
    current: () => current,
  };
  return { loader, release };
}

describe("U8 mutable host setting boundary", () => {
  it("accepts only telemetry, options.*, and namespaceAliases", () => {
    expect(MutableHostSettingSchema.parse({ key: "telemetry", value: false })).toEqual({
      key: "telemetry",
      value: false,
    });
    expect(
      MutableHostSettingSchema.parse({ key: "options.defaultSearchLimit", value: 9 }),
    ).toMatchObject({ key: "options.defaultSearchLimit", value: 9 });
    expect(
      MutableHostSettingSchema.parse({
        key: "namespaceAliases",
        value: { local: "local", upstreams: { cloud: "remote" } },
      }),
    ).toMatchObject({ key: "namespaceAliases" });
    for (const value of [
      { local: "duplicate", upstreams: { cloud: "duplicate" } },
      { upstreams: { cloud: "a".repeat(33) } },
    ]) {
      expect(() =>
        parseCanonicalHostSetting({
          version: 1,
          key: "namespaceAliases",
          value,
          updatedAt: "2026-07-15T00:00:00.000Z",
        }),
      ).toThrow(/namespace aliases/i);
    }

    for (const key of [
      "serve.port",
      "storage.kind",
      "database.url",
      "tls.ca",
      "keyProviderManifest",
      "mcpServers",
      "catalog",
      "tools",
      "project.path",
      "native.daemon-url",
    ]) {
      expect(() => MutableHostSettingSchema.parse({ key, value: "forbidden" })).toThrow();
    }
  });
});

describe("U8 layered runtime composition", () => {
  it("composes SQL -> host -> project per field and retains dormant SQL provenance", async () => {
    const resolvedRuntimeInputs = { region: "test" };
    const hiddenCommitments = ["a".repeat(64)];
    const providerVersions = { keys: 1 };
    const runtime = await composeControlPlaneRuntimeSnapshot({
      hydration: hydration(
        "sqlite",
        {
          currentFingerprint: bootstrapFingerprintFor(
            [hostLayer, projectLayer],
            resolvedRuntimeInputs,
            hiddenCommitments,
            providerVersions,
          ),
        },
        sqlSnapshot([
          httpAggregate("alpha", "sql"),
          httpAggregate("dormant", "dormant", "setup-required"),
        ]),
      ),
      filesystemLayers: [hostLayer, projectLayer],
      resolvedRuntimeInputs,
      hiddenCommitments,
      providerVersions,
    });

    expect(runtime.config.httpApis.alpha).toMatchObject({
      name: "Project alpha",
      baseUrl: "https://project.example.test",
    });
    expect(runtime.config.telemetry).toBe(false);
    expect(runtime.config.options.defaultSearchLimit).toBe(11);
    expect(runtime.config.options.exposure).toBe("direct");
    expect(runtime.caplets.alpha).toMatchObject({
      effective: false,
      owner: "filesystem",
      source: { kind: "project-config" },
      underlyingSql: { owner: "sql", source: { kind: "sql" } },
    });
    expect(runtime.caplets.alpha!.shadowChain.map((row) => row.source.kind)).toEqual([
      "sql",
      "global-config",
      "project-config",
    ]);
    const registry = new ServerRegistry(runtime.config, runtime.caplets);
    expect(registry.detail(runtime.config.httpApis.alpha!)).toMatchObject({
      owner: "filesystem",
      runtimeStatus: "effective",
      shadowed: true,
      provenance: { id: "provenance-alpha" },
    });
    registry.setStatus("alpha", "available");
    const refreshedRegistry = registry.withRuntimeMetadata(runtime.config, runtime.caplets);
    expect(refreshedRegistry.getStatus("alpha")).toBe("available");
    expect(runtime.config.httpApis.dormant).toBeUndefined();
    expect(runtime.caplets.dormant).toMatchObject({
      effective: false,
      owner: "sql",
      runtimeStatus: "dormant",
      source: { kind: "sql" },
      underlyingSql: {
        owner: "sql",
        provenance: { id: "provenance-dormant" },
      },
    });
    expect(resolveControlPlaneCapletMutationTarget(runtime, "dormant")).toMatchObject({
      status: "allowed",
      owner: "sql",
      effectiveChanged: true,
    });
    expect(
      resolveControlPlaneCapletMutationTarget(runtime, "alpha", { underlyingSql: true }),
    ).toMatchObject({ status: "allowed", owner: "sql", effectiveChanged: false });
    expect(resolveControlPlaneCapletMutationTarget(runtime, "alpha")).toMatchObject({
      status: "rejected",
      owner: "filesystem",
      source: { kind: "project-config" },
    });
    expect(resolveControlPlaneHostSettingMutationTarget(runtime, "telemetry")).toMatchObject({
      status: "rejected",
      owner: "filesystem",
      source: { kind: "global-config" },
    });
    expect(
      resolveControlPlaneHostSettingMutationTarget(runtime, "telemetry", {
        underlyingSql: true,
      }),
    ).toMatchObject({ status: "allowed", effectiveChanged: false, owner: "sql" });

    const reactivated = await composeControlPlaneRuntimeSnapshot({
      hydration: hydration("sqlite", {
        currentFingerprint: bootstrapFingerprintFor(
          [],
          resolvedRuntimeInputs,
          hiddenCommitments,
          providerVersions,
        ),
      }),
      filesystemLayers: [],
      resolvedRuntimeInputs,
      hiddenCommitments,
      providerVersions,
    });
    expect(reactivated.config.httpApis.alpha).toMatchObject({
      name: "SQL sql",
      baseUrl: "https://sql.example.test",
    });
    expect(reactivated.caplets.alpha).toMatchObject({ effective: true, owner: "sql" });
    expect(reactivated.config.telemetry).toBe(true);
    expect(reactivated.config.options.defaultSearchLimit).toBe(7);
    expect(
      runtime.sqlSnapshot.hostSettings.some((setting) => setting.key === "native.daemon-url"),
    ).toBe(true);
    expect(runtime.hostSettings["native.daemon-url"]).toBeUndefined();
  });

  it("treats namespace aliases as one owned setting and uses the supplied Vault resolver", async () => {
    const aliasSnapshot = {
      ...sqlSnapshot(),
      hostSettings: [
        ...sqlSnapshot().hostSettings,
        {
          version: 1 as const,
          key: "namespaceAliases" as const,
          value: { local: "local", upstreams: { sql: "sql" } },
          updatedAt: "2026-07-15T00:00:00.000Z",
        },
      ],
    };
    const filesystemLayers: RuntimeConfigLayerInput[] = [
      {
        input: {
          namespaceAliases: { upstreams: { project: "project" } },
          httpApis: {
            secure: {
              name: "Secure",
              description: "Secure capability description",
              baseUrl: "https://secure.example.test",
              auth: { type: "bearer", token: "$vault:SECURE_TOKEN" },
              actions: { ping: { method: "GET", path: "/ping" } },
            },
          },
        },
        source: { kind: "project-config", path: "/project/caplets.json" },
      },
    ];
    const currentFingerprint = bootstrapFingerprintFor(filesystemLayers);
    const runtime = await composeControlPlaneRuntimeSnapshot({
      hydration: hydration("sqlite", { currentFingerprint }, aliasSnapshot),
      filesystemLayers,
      resolvedRuntimeInputs: {},
      hiddenCommitments: [],
      providerVersions: {},
      vaultResolver: () => ({ storedKey: "SECURE_TOKEN", value: "resolved-token" }),
    });
    expect(runtime.config.namespaceAliases).toEqual({
      upstreams: { project: "project" },
    });
    expect(runtime.hostSettings.namespaceAliases).toMatchObject({
      owner: "filesystem",
      underlyingSql: { owner: "sql" },
    });
    expect(
      resolveControlPlaneHostSettingMutationTarget(runtime, "namespaceAliases", {
        underlyingSql: true,
      }),
    ).toMatchObject({ status: "allowed", effectiveChanged: false });
    expect(runtime.config.httpApis.secure?.auth).toEqual({
      type: "bearer",
      token: "resolved-token",
    });
  });

  it("requires canonical SQL local references to be materialized to absolute paths", async () => {
    const assetContent = new Uint8Array([123, 125]);
    const assetDir = mkdtempSync(join(tmpdir(), "caplets-u8-assets-"));
    runtimeAssetTempDirs.push(assetDir);
    const materializedAssetPath = join(assetDir, "openapi.json");
    writeFileSync(materializedAssetPath, assetContent);
    const secondAssetDir = mkdtempSync(join(tmpdir(), "caplets-u8-assets-"));
    runtimeAssetTempDirs.push(secondAssetDir);
    const secondMaterializedAssetPath = join(secondAssetDir, "openapi.json");
    writeFileSync(secondMaterializedAssetPath, assetContent);
    const base = httpAggregate("asset-backed", "asset");
    const assetBacked = {
      ...base,
      projection: {
        ...base.projection,
        backends: [
          {
            capletId: "asset-backed",
            ordinal: 0,
            kind: "openapi" as const,
            config: {
              specPath: "assets/openapi.json",
              auth: { type: "none" },
            },
          },
        ],
        references: [
          {
            capletId: "asset-backed",
            ordinal: 0,
            reference: {
              type: "local" as const,
              owner: "asset-backed",
              path: "assets/openapi.json",
            },
          },
        ],
        assets: [
          {
            capletId: "asset-backed",
            ordinal: 0,
            path: "assets/openapi.json",
            role: "openapi" as const,
            mediaType: "application/json",
            content: assetContent,
            contentHash: createHash("sha256").update(assetContent).digest("hex"),
          },
        ],
      },
    };
    const snapshot = sqlSnapshot([assetBacked]);
    const missingReferenceSnapshot = sqlSnapshot([
      {
        ...assetBacked,
        projection: { ...assetBacked.projection, references: [] },
      },
    ]);
    const danglingAssetSnapshot = sqlSnapshot([
      {
        ...assetBacked,
        projection: { ...assetBacked.projection, assets: [] },
      },
    ]);
    const undeclaredAbsoluteSnapshot = sqlSnapshot([
      {
        ...assetBacked,
        projection: {
          ...assetBacked.projection,
          references: [],
          assets: [],
          backends: assetBacked.projection.backends.map((backend) => ({
            ...backend,
            config: { specPath: "/etc/passwd", auth: { type: "none" } },
          })),
        },
      },
    ]);
    await expect(
      composeControlPlaneRuntimeSnapshot({
        hydration: hydration(
          "sqlite",
          { currentFingerprint: SQL_ONLY_BOOTSTRAP_FINGERPRINT },
          missingReferenceSnapshot,
        ),
        filesystemLayers: [],
        resolvedRuntimeInputs: {},
        hiddenCommitments: [],
        providerVersions: {},
        resolveSqlAssetPath: () => "/tmp/caplets-assets/openapi.json",
      }),
    ).rejects.toThrow(/unresolved local asset/i);
    await expect(
      composeControlPlaneRuntimeSnapshot({
        hydration: hydration(
          "sqlite",
          { currentFingerprint: SQL_ONLY_BOOTSTRAP_FINGERPRINT },
          danglingAssetSnapshot,
        ),
        filesystemLayers: [],
        resolvedRuntimeInputs: {},
        hiddenCommitments: [],
        providerVersions: {},
        resolveSqlAssetPath: () => materializedAssetPath,
      }),
    ).rejects.toThrow(/dangling local asset/i);
    await expect(
      composeControlPlaneRuntimeSnapshot({
        hydration: hydration(
          "sqlite",
          { currentFingerprint: SQL_ONLY_BOOTSTRAP_FINGERPRINT },
          undeclaredAbsoluteSnapshot,
        ),
        filesystemLayers: [],
        resolvedRuntimeInputs: {},
        hiddenCommitments: [],
        providerVersions: {},
        resolveSqlAssetPath: () => "/tmp/caplets-assets/openapi.json",
      }),
    ).rejects.toThrow(/unresolved local asset/i);
    await expect(
      composeControlPlaneRuntimeSnapshot({
        hydration: hydration(
          "sqlite",
          { currentFingerprint: SQL_ONLY_BOOTSTRAP_FINGERPRINT },
          snapshot,
        ),
        filesystemLayers: [],
        resolvedRuntimeInputs: {},
        hiddenCommitments: [],
        providerVersions: {},
      }),
    ).rejects.toThrow(/asset materialization/i);
    await expect(
      composeControlPlaneRuntimeSnapshot({
        hydration: hydration(
          "sqlite",
          { currentFingerprint: SQL_ONLY_BOOTSTRAP_FINGERPRINT },
          snapshot,
        ),
        filesystemLayers: [],
        resolvedRuntimeInputs: {},
        hiddenCommitments: [],
        providerVersions: {},
        resolveSqlAssetPath: () => "/tmp/../unconfined-openapi.json",
      }),
    ).rejects.toThrow(/unsafe path/i);
    const runtime = await composeControlPlaneRuntimeSnapshot({
      hydration: hydration(
        "sqlite",
        { currentFingerprint: SQL_ONLY_BOOTSTRAP_FINGERPRINT },
        snapshot,
      ),
      filesystemLayers: [],
      resolvedRuntimeInputs: {},
      hiddenCommitments: [],
      providerVersions: {},
      resolveSqlAssetPath: () => materializedAssetPath,
    });
    expect(runtime.config.openapiEndpoints["asset-backed"]?.specPath).toBe(materializedAssetPath);
    const runtimeAtSecondPath = await composeControlPlaneRuntimeSnapshot({
      hydration: hydration(
        "sqlite",
        { currentFingerprint: SQL_ONLY_BOOTSTRAP_FINGERPRINT },
        snapshot,
      ),
      filesystemLayers: [],
      resolvedRuntimeInputs: {},
      hiddenCommitments: [],
      providerVersions: {},
      resolveSqlAssetPath: () => secondMaterializedAssetPath,
    });
    expect(runtimeAtSecondPath.effectiveRuntimeFingerprint).toBe(
      runtime.effectiveRuntimeFingerprint,
    );
  });

  it("materializes a maximum-size SQL asset within the 1-second p99 budget", async () => {
    const assetContent = new Uint8Array(64 * 1024 * 1024);
    const assetHash = createHash("sha256").update(assetContent).digest("hex");
    const assetDir = mkdtempSync(join(tmpdir(), "caplets-u8-max-asset-"));
    runtimeAssetTempDirs.push(assetDir);
    const materializedAssetPath = join(assetDir, "openapi.json");
    writeFileSync(materializedAssetPath, assetContent);
    const base = httpAggregate("max-asset", "max-asset");
    const portableAssetContent = Buffer.from(assetContent).toString("base64");
    const snapshot = {
      ...sqlSnapshot([
        {
          ...base,
          aggregate: {
            ...base.aggregate,
            portable: {
              ...base.aggregate.portable,
              frontmatter: {
                ...base.aggregate.portable.frontmatter,
                backend: {
                  kind: "openapi",
                  config: {
                    specPath: "assets/openapi.json",
                    auth: { type: "none" },
                  },
                },
                declaredInputs: [
                  {
                    name: "openapi",
                    reference: { type: "local", path: "assets/openapi.json" },
                  },
                ],
              },
              assets: [
                {
                  path: "assets/openapi.json",
                  role: "openapi",
                  mediaType: "application/json",
                  encoding: "base64",
                  content: portableAssetContent,
                  contentHash: assetHash,
                  byteLength: assetContent.byteLength,
                },
              ],
              references: [
                {
                  type: "local",
                  owner: "max-asset",
                  path: "assets/openapi.json",
                },
              ],
            },
          },
          projection: {
            ...base.projection,
            backends: [
              {
                capletId: "max-asset",
                ordinal: 0,
                kind: "openapi" as const,
                config: {
                  specPath: "assets/openapi.json",
                  auth: { type: "none" },
                },
              },
            ],
            references: [
              {
                capletId: "max-asset",
                ordinal: 0,
                reference: {
                  type: "local" as const,
                  owner: "max-asset",
                  path: "assets/openapi.json",
                },
              },
            ],
            assets: [
              {
                capletId: "max-asset",
                ordinal: 0,
                path: "assets/openapi.json",
                role: "openapi" as const,
                mediaType: "application/json",
                content: assetContent,
                contentHash: assetHash,
              },
            ],
          },
        },
      ]),
      encodedBytes: assetContent.byteLength,
    };
    const maxAssetEntry = snapshot.caplets[0]!;
    encodePortableCaplet(maxAssetEntry.aggregate.portable);
    validateCapletRelationalProjection(maxAssetEntry.aggregate, maxAssetEntry.projection);
    const composeFixture = () =>
      composeControlPlaneRuntimeSnapshot({
        hydration: hydration(
          "sqlite",
          { currentFingerprint: SQL_ONLY_BOOTSTRAP_FINGERPRINT },
          { ...snapshot, caplets: [...snapshot.caplets] },
        ),
        filesystemLayers: [],
        resolvedRuntimeInputs: {},
        hiddenCommitments: [],
        providerVersions: {},
        resolveSqlAssetPath: () => materializedAssetPath,
      });
    const runP99Ms: number[] = [];
    for (let run = 0; run < STORAGE_BENCHMARK_ENVELOPE.independentRuns; run += 1) {
      for (let index = 0; index < STORAGE_BENCHMARK_ENVELOPE.warmupSamples; index += 1) {
        await composeFixture();
      }
      const samples: number[] = [];
      for (let index = 0; index < STORAGE_BENCHMARK_ENVELOPE.measuredSamplesPerRun; index += 1) {
        const started = performance.now();
        await composeFixture();
        samples.push(performance.now() - started);
      }
      runP99Ms.push(nearestRank(samples, 0.99));
    }
    const p99Ms = Math.max(...runP99Ms);
    if (process.env.CAPLETS_BENCHMARK_REPORT === "1") {
      process.stdout.write(
        `${JSON.stringify({
          fixture: "u8-sql-asset-materialization",
          runs: runP99Ms,
          samplesPerRun: STORAGE_BENCHMARK_ENVELOPE.measuredSamplesPerRun,
          p99Ms,
        })}\n`,
      );
    }
    expect(runP99Ms.every((runP99Ms) => runP99Ms <= 1_000)).toBe(true);
  }, 600_000);

  it("routes SQL and filesystem Vault references to their owning resolvers", async () => {
    const base = httpAggregate("sql-vault", "sql-vault");
    const sqlVault = {
      ...base,
      projection: {
        ...base.projection,
        backends: base.projection.backends.map((backend) => ({
          ...backend,
          config: {
            baseUrl: "https://sql-vault.example.test",
            auth: { type: "bearer", token: "$vault:SQL_TOKEN" },
            actions: { ping: { method: "GET", path: "/ping" } },
          },
        })),
      },
    };
    const filesystemLayer: RuntimeConfigLayerInput = {
      input: {
        httpApis: {
          filesystemVault: {
            name: "Filesystem Vault",
            description: "Filesystem-owned Vault resolver fixture",
            baseUrl: "https://filesystem-vault.example.test",
            auth: { type: "bearer", token: "$vault:FILESYSTEM_TOKEN" },
            actions: { ping: { method: "GET", path: "/ping" } },
          },
        },
      },
      source: { kind: "project-config", path: "/project/caplets.json" },
    };
    const filesystemVaultResolver: ConfigVaultResolver = (reference) => ({
      storedKey: reference.referenceName,
      value: `filesystem:${reference.referenceName}`,
    });
    const bootstrapFingerprint = bootstrapFingerprintFor(
      [filesystemLayer],
      {},
      [],
      {},
      filesystemVaultResolver,
    );
    const loader = createControlPlaneRuntimeSnapshotLoader({
      hydrate: async () =>
        hydration("sqlite", { currentFingerprint: bootstrapFingerprint }, sqlSnapshot([sqlVault])),
      loadFilesystemLayers: () => [filesystemLayer],
      resolvedRuntimeInputs: () => ({}),
      hiddenCommitments: () => [],
      providerVersions: () => ({}),
      vaultResolver: (reference) => ({
        storedKey: reference.referenceName,
        value: `sql:${reference.referenceName}`,
      }),
    });
    const runtime = await loader.initialize({
      vaultResolver: filesystemVaultResolver,
    });
    expect(runtime.config.httpApis["sql-vault"]?.auth).toEqual({
      type: "bearer",
      token: "sql:SQL_TOKEN",
    });
    expect(runtime.config.httpApis.filesystemVault?.auth).toEqual({
      type: "bearer",
      token: "filesystem:FILESYSTEM_TOKEN",
    });
    const changedSecretLoader = createControlPlaneRuntimeSnapshotLoader({
      hydrate: async () =>
        hydration("sqlite", { currentFingerprint: bootstrapFingerprint }, sqlSnapshot([sqlVault])),
      loadFilesystemLayers: () => [filesystemLayer],
      resolvedRuntimeInputs: () => ({}),
      hiddenCommitments: () => [],
      providerVersions: () => ({}),
      vaultResolver: (reference) => ({
        storedKey: reference.referenceName,
        value: `changed:${reference.referenceName}`,
      }),
    });
    const changedSecretRuntime = await changedSecretLoader.initialize({
      vaultResolver: filesystemVaultResolver,
    });
    expect(changedSecretRuntime.effectiveRuntimeFingerprint).not.toBe(
      runtime.effectiveRuntimeFingerprint,
    );
  });

  it("keeps bootstrap and effective fingerprints distinct and commits hidden inputs opaquely", async () => {
    const commitmentOne = "1".repeat(64);
    const commitmentTwo = "2".repeat(64);
    const first = createBootstrapFingerprintSnapshot({
      filesystemInputs: [hostLayer.input],
      resolvedRuntimeInputs: { endpoint: "https://one.example.test" },
      hiddenCommitments: [commitmentOne],
      providerVersions: { provider: 1 },
    });
    const resolvedDifference = createBootstrapFingerprintSnapshot({
      filesystemInputs: [hostLayer.input],
      resolvedRuntimeInputs: { endpoint: "https://two.example.test" },
      hiddenCommitments: [commitmentOne],
      providerVersions: { provider: 1 },
    });
    const secretDifference = createBootstrapFingerprintSnapshot({
      filesystemInputs: [hostLayer.input],
      resolvedRuntimeInputs: { endpoint: "https://one.example.test" },
      hiddenCommitments: [commitmentTwo],
      providerVersions: { provider: 1 },
    });
    const credentialA = createBootstrapFingerprintSnapshot({
      filesystemInputs: [],
      resolvedRuntimeInputs: { store: identity, database: { credentials: { password: "a" } } },
      hiddenCommitments: [],
      providerVersions: {},
    });
    const credentialB = createBootstrapFingerprintSnapshot({
      filesystemInputs: [],
      resolvedRuntimeInputs: { store: identity, database: { credentials: { password: "b" } } },
      hiddenCommitments: [],
      providerVersions: {},
    });
    const connectionA = createBootstrapFingerprintSnapshot({
      filesystemInputs: [],
      resolvedRuntimeInputs: {
        store: identity,
        postgresAdminUrl: "postgres://operator-a:secret-a@db.example.test/caplets",
      },
      hiddenCommitments: [],
      providerVersions: {},
    });
    const connectionB = createBootstrapFingerprintSnapshot({
      filesystemInputs: [],
      resolvedRuntimeInputs: {
        store: identity,
        postgresAdminUrl: "postgres://operator-b:secret-b@db.example.test/caplets",
      },
      hiddenCommitments: [],
      providerVersions: {},
    });
    expect(first.fingerprint).not.toBe(resolvedDifference.fingerprint);
    const nonSecretEnvA = createBootstrapFingerprintSnapshot({
      filesystemInputs: [{ mcpServers: { demo: { env: { REGION: "us-east-1" } } } }],
      resolvedRuntimeInputs: {},
      hiddenCommitments: [],
      providerVersions: {},
    });
    const nonSecretEnvB = createBootstrapFingerprintSnapshot({
      filesystemInputs: [{ mcpServers: { demo: { env: { REGION: "eu-west-1" } } } }],
      resolvedRuntimeInputs: {},
      hiddenCommitments: [],
      providerVersions: {},
    });
    const hiddenRuntimeA = createBootstrapFingerprintSnapshot({
      filesystemInputs: [
        {
          mcpServers: {
            demo: {
              env: { API_TOKEN: "token-a" },
              args: ["--token", "token-a"],
              url: "https://example.test/connect?X-Amz-Signature=signature-a",
            },
          },
        },
      ],
      resolvedRuntimeInputs: {},
      hiddenCommitments: [],
      providerVersions: {},
    });
    const hiddenRuntimeB = createBootstrapFingerprintSnapshot({
      filesystemInputs: [
        {
          mcpServers: {
            demo: {
              env: { API_TOKEN: "token-b" },
              args: ["--token", "token-b"],
              url: "https://example.test/connect?X-Amz-Signature=signature-b",
            },
          },
        },
      ],
      resolvedRuntimeInputs: {},
      hiddenCommitments: [],
      providerVersions: {},
    });
    expect(nonSecretEnvA.fingerprint).not.toBe(nonSecretEnvB.fingerprint);
    expect(hiddenRuntimeA.fingerprint).toBe(hiddenRuntimeB.fingerprint);
    const nonSecretArgsA = createBootstrapFingerprintSnapshot({
      filesystemInputs: [{ cliTools: { demo: { args: ["--region", "us-east-1"] } } }],
      resolvedRuntimeInputs: {},
      hiddenCommitments: [],
      providerVersions: {},
    });
    const nonSecretArgsB = createBootstrapFingerprintSnapshot({
      filesystemInputs: [{ cliTools: { demo: { args: ["--region", "eu-west-1"] } } }],
      resolvedRuntimeInputs: {},
      hiddenCommitments: [],
      providerVersions: {},
    });
    expect(nonSecretArgsA.fingerprint).not.toBe(nonSecretArgsB.fingerprint);
    expect(first.fingerprint).not.toBe(secretDifference.fingerprint);
    expect(credentialA.fingerprint).toBe(credentialB.fingerprint);
    expect(connectionA.fingerprint).toBe(connectionB.fingerprint);
    expect(JSON.stringify(first)).not.toContain(commitmentOne);
    expect(() =>
      createBootstrapFingerprintSnapshot({
        filesystemInputs: [],
        resolvedRuntimeInputs: {},
        hiddenCommitments: ["raw-secret"],
        providerVersions: {},
      }),
    ).toThrow(/opaque/i);
    expect(() =>
      createBootstrapFingerprintSnapshot({
        filesystemInputs: [{ name: "Cafe\u0301" }],
        resolvedRuntimeInputs: {},
        hiddenCommitments: [],
        providerVersions: {},
      }),
    ).toThrow(/NFC-normalized/i);

    const runtime = await composeControlPlaneRuntimeSnapshot({
      hydration: hydration(),
      filesystemLayers: [],
      resolvedRuntimeInputs: {},
      hiddenCommitments: [],
      providerVersions: {},
    });
    expect(runtime.effectiveRuntimeFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(runtime.bootstrapFingerprint).not.toBe(runtime.effectiveRuntimeFingerprint);
  });

  it("commits filesystem declared-input bytes into the bootstrap fingerprint", () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-u8-fingerprint-"));
    runtimeAssetTempDirs.push(dir);
    const specPath = join(dir, "openapi.json");
    process.env.CAPLETS_U8_SPEC_PATH = specPath;
    const layer: RuntimeConfigLayerInput = {
      input: {
        openapiEndpoints: {
          declaredInput: {
            name: "Declared input",
            description: "Declared input fingerprint fixture",
            specPath: "$env:CAPLETS_U8_SPEC_PATH",
            auth: { type: "none" },
          },
        },
      },
      source: { kind: "global-config", path: join(dir, "config.json") },
    };
    writeFileSync(specPath, "{}");
    const firstFingerprint = bootstrapFingerprintFor([layer]);
    writeFileSync(specPath, '{"changed":true}');
    const changedFingerprint = bootstrapFingerprintFor([layer]);
    expect(changedFingerprint).not.toBe(firstFingerprint);
  });

  it("atomically adopts changed SQLite fingerprints and leaves Postgres staged/not-ready", async () => {
    const candidate = bootstrapFingerprintFor([hostLayer]);
    const previous = "0".repeat(64);
    const adoptedSnapshot = {
      ...sqlSnapshot(),
      versions: { authorityGeneration: 2, effectiveGeneration: 1, securityEpoch: 0 },
    };
    const adopt = vi.fn(async () =>
      hydration("sqlite", { currentFingerprint: candidate }, adoptedSnapshot),
    );
    const adoptUnset = vi.fn(async () =>
      hydration("sqlite", { currentFingerprint: candidate }, sqlSnapshot()),
    );
    const adoptedUnset = await composeControlPlaneRuntimeSnapshot({
      hydration: hydration("sqlite", {}),
      filesystemLayers: [hostLayer],
      resolvedRuntimeInputs: {},
      hiddenCommitments: [],
      providerVersions: {},
      adoptSqliteBootstrapFingerprint: adoptUnset,
    });
    expect(adoptUnset).toHaveBeenCalledWith({
      nextFingerprint: candidate,
      expectedEffectiveRuntimeFingerprint: adoptedUnset.effectiveRuntimeFingerprint,
      expectedAuthorityGeneration: 1,
      expectedEffectiveGeneration: 1,
      expectedSecurityEpoch: 0,
    });
    expect(adoptedUnset.bootstrapFingerprint).toBe(candidate);

    const sqlite = await composeControlPlaneRuntimeSnapshot({
      hydration: hydration("sqlite", { currentFingerprint: previous }),
      filesystemLayers: [hostLayer],
      resolvedRuntimeInputs: {},
      hiddenCommitments: [],
      providerVersions: {},
      adoptSqliteBootstrapFingerprint: adopt,
    });
    expect(adopt).toHaveBeenCalledWith(
      expect.objectContaining({
        previousFingerprint: previous,
        nextFingerprint: candidate,
        expectedEffectiveRuntimeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        expectedAuthorityGeneration: 1,
      }),
    );
    expect(sqlite.authorityGeneration).toBe(2);
    expect(sqlite.bootstrapFingerprint).toBe(candidate);
    const changedAdopt = vi.fn(async () =>
      hydration(
        "sqlite",
        { currentFingerprint: candidate },
        {
          ...sqlSnapshot([httpAggregate("changed-during-adoption", "changed")]),
          versions: { authorityGeneration: 2, effectiveGeneration: 2, securityEpoch: 0 },
        },
      ),
    );
    await expect(
      composeControlPlaneRuntimeSnapshot({
        hydration: hydration("sqlite", { currentFingerprint: previous }),
        filesystemLayers: [hostLayer],
        resolvedRuntimeInputs: {},
        hiddenCommitments: [],
        providerVersions: {},
        adoptSqliteBootstrapFingerprint: changedAdopt,
      }),
    ).rejects.toThrow(/changed effective runtime content/i);

    const invalidAdopt = vi.fn(async () =>
      hydration("sqlite", { currentFingerprint: candidate }, adoptedSnapshot),
    );
    await expect(
      composeControlPlaneRuntimeSnapshot({
        hydration: hydration(
          "sqlite",
          { currentFingerprint: previous },
          sqlSnapshot([httpAggregate("duplicate", "one"), httpAggregate("duplicate", "two")]),
        ),
        filesystemLayers: [hostLayer],
        resolvedRuntimeInputs: {},
        hiddenCommitments: [],
        providerVersions: {},
        adoptSqliteBootstrapFingerprint: invalidAdopt,
      }),
    ).rejects.toThrow(/duplicated/i);
    expect(invalidAdopt).not.toHaveBeenCalled();

    await expect(
      composeControlPlaneRuntimeSnapshot({
        hydration: hydration("postgres", {
          currentFingerprint: previous,
          stagedNextFingerprint: candidate,
        }),
        filesystemLayers: [hostLayer],
        resolvedRuntimeInputs: {},
        hiddenCommitments: [],
        providerVersions: {},
      }),
    ).rejects.toThrow(/staged.*not ready/i);
    await expect(
      composeControlPlaneRuntimeSnapshot({
        hydration: hydration("postgres", { currentFingerprint: previous }),
        filesystemLayers: [hostLayer],
        resolvedRuntimeInputs: {},
        hiddenCommitments: [],
        providerVersions: {},
      }),
    ).rejects.toThrow(/bootstrap fingerprint/i);
  });

  it("rejects every readiness prerequisite before exposing a snapshot", async () => {
    const cases: Array<(value: ControlPlaneRuntimePrerequisites) => void> = [
      (value) => (value.storage = { status: "unverified" }),
      (value) => (value.migration = { status: "blocked" }),
      (value) => (value.keys = { status: "unverified" }),
      (value) => (value.canary = { status: "unverified" }),
      (value) => (value.schema = { status: "blocked", version: 1 }),
      (value) => (value.manifest = { status: "unverified", version: 1 }),
      (value) => (value.compatibility = { ...value.compatibility, status: "incompatible" }),
      (value) => (value.authority = { ...value.authority, status: "inactive" }),
      (value) => (value.identity = { ...identity, storeId: "store_other" }),
      (value) => (value.activation = {}),
    ];
    for (const mutate of cases) {
      const value = structuredClone(
        prerequisites("sqlite", { currentFingerprint: SQL_ONLY_BOOTSTRAP_FINGERPRINT }),
      );
      mutate(value);
      await expect(
        composeControlPlaneRuntimeSnapshot({
          hydration: { snapshot: sqlSnapshot(), prerequisites: value },
          filesystemLayers: [],
          resolvedRuntimeInputs: {},
          hiddenCommitments: [],
          providerVersions: {},
        }),
      ).rejects.toThrow();
    }
  });
});

describe("U8 awaited engine factory and atomic reload", () => {
  it("awaits hydration, swaps one complete generation, and preserves last-known-good on failure", async () => {
    let release!: () => void;
    let failReload = false;
    let layers: RuntimeConfigLayerInput[] = [];
    let currentFingerprint = SQL_ONLY_BOOTSTRAP_FINGERPRINT;
    let authorityGeneration = 1;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const currentSqlSnapshot = (): ControlPlaneSnapshot => ({
      ...sqlSnapshot(),
      versions: {
        ...sqlSnapshot().versions,
        authorityGeneration,
      },
    });
    const loader = createControlPlaneRuntimeSnapshotLoader({
      async hydrate() {
        await gate;
        if (failReload) throw new Error("reload hydration failed");
        return hydration("sqlite", { currentFingerprint }, currentSqlSnapshot());
      },
      async loadFilesystemLayers() {
        return layers;
      },
      resolvedRuntimeInputs: () => ({}),
      hiddenCommitments: () => [],
      providerVersions: () => ({}),
      async adoptSqliteBootstrapFingerprint(request) {
        currentFingerprint = request.nextFingerprint;
        authorityGeneration += 1;
        return hydration("sqlite", { currentFingerprint }, currentSqlSnapshot());
      },
    });
    let settled = false;
    const enginePromise = createInternalCapletsEngine({ watch: false }, loader).then((engine) => {
      settled = true;
      return engine;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    const engine = await enginePromise;
    expect(engine.currentConfig().httpApis.alpha?.name).toBe("SQL sql");

    const unchangedSnapshot = engine.currentControlPlaneRuntimeSnapshot();
    expect(await engine.reload()).toBe(true);
    expect(engine.currentControlPlaneRuntimeSnapshot()).toBe(unchangedSnapshot);

    layers = [projectLayer];
    expect(await engine.reload()).toBe(true);
    expect(engine.currentConfig().httpApis.alpha?.name).toBe("Project alpha");
    expect(engine.currentControlPlaneRuntimeSnapshot()?.authorityGeneration).toBe(2);
    const generation = engine.currentExposureGeneration();

    failReload = true;
    expect(await engine.reload()).toBe(false);
    expect(engine.currentConfig().httpApis.alpha?.name).toBe("Project alpha");
    expect(engine.currentExposureGeneration()).toBe(generation);
    await engine.close();
  });

  it("revalidates live SQL authority before dispatching any engine operation", async () => {
    const loader = createControlPlaneRuntimeSnapshotLoader({
      hydrate: async () =>
        hydration("sqlite", { currentFingerprint: SQL_ONLY_BOOTSTRAP_FINGERPRINT }),
      loadFilesystemLayers: () => [],
      resolvedRuntimeInputs: () => ({}),
      hiddenCommitments: () => [],
      providerVersions: () => ({}),
    });
    const snapshot = await loader.initialize();
    let revalidations = 0;
    const engine = await createInternalCapletsEngine(
      { watch: false },
      loader,
      snapshot,
      undefined,
      undefined,
      undefined,
      async () => {
        revalidations += 1;
        throw new Error("live authority revoked");
      },
    );

    await expect(engine.execute("missing", { operation: "check" })).resolves.toMatchObject({
      isError: true,
    });
    expect(revalidations).toBe(1);
    await engine.close();
  });

  it("rejects a superseded loader candidate instead of regressing a complete generation", async () => {
    let effectiveGeneration = 0;
    const loader = createControlPlaneRuntimeSnapshotLoader({
      async hydrate() {
        effectiveGeneration += 1;
        const snapshot = {
          ...sqlSnapshot(),
          versions: {
            ...sqlSnapshot().versions,
            effectiveGeneration,
          },
        };
        return hydration(
          "sqlite",
          { currentFingerprint: SQL_ONLY_BOOTSTRAP_FINGERPRINT },
          snapshot,
        );
      },
      loadFilesystemLayers: () => [],
      resolvedRuntimeInputs: () => ({}),
      hiddenCommitments: () => [],
      providerVersions: () => ({}),
    });
    await loader.initialize();
    const older = await loader.reload();
    const newer = await loader.reload();
    expect(loader.commit(newer)).toBe(true);
    expect(loader.commit(older)).toBe(false);
    expect(loader.current()?.effectiveGeneration).toBe(3);
    const highEffective = {
      ...loader.current()!,
      authorityGeneration: 60,
      effectiveGeneration: 60,
    };
    const restored = {
      ...highEffective,
      authorityGeneration: 61,
      effectiveGeneration: 40,
    };
    expect(loader.commit(highEffective)).toBe(true);
    expect(loader.commit(restored)).toBe(true);
    expect(loader.current()).toMatchObject({ authorityGeneration: 61, effectiveGeneration: 40 });
  });

  it("awaits hydration in runtime, cloud, native, remote, and serve factories", async () => {
    const snapshot = await composeControlPlaneRuntimeSnapshot({
      hydration: hydration(),
      filesystemLayers: [],
      resolvedRuntimeInputs: {},
      hiddenCommitments: [],
      providerVersions: {},
    });

    const runtimeGate = gatedRuntimeLoader(snapshot);
    let runtimeExposed = false;
    const runtimePending = createInternalCapletsRuntime({}, runtimeGate.loader).then((runtime) => {
      runtimeExposed = true;
      return runtime;
    });
    await Promise.resolve();
    expect(runtimeExposed).toBe(false);
    runtimeGate.release();
    const runtime = await runtimePending;
    await runtime.close();

    const cloudGate = gatedRuntimeLoader(snapshot);
    let cloudExposed = false;
    const cloudPending = createInternalCloudRuntimeAdapter(
      { runtimeId: "u8-cloud", executionKind: "cloud" },
      cloudGate.loader,
    ).then((adapter) => {
      cloudExposed = true;
      return adapter;
    });
    await Promise.resolve();
    expect(cloudExposed).toBe(false);
    cloudGate.release();
    const cloud = await cloudPending;
    await cloud.close();

    const nativeGate = gatedRuntimeLoader(snapshot);
    let nativeExposed = false;
    const nativePending = createInternalNativeCapletsService(
      { mode: "local" },
      nativeGate.loader,
    ).then((service) => {
      nativeExposed = true;
      return service;
    });
    await Promise.resolve();
    expect(nativeExposed).toBe(false);
    nativeGate.release();
    const native = await nativePending;
    await native.close();

    const nativeRemoteGate = gatedRuntimeLoader(snapshot);
    let nativeRemoteExposed = false;
    const nativeRemotePending = createInternalNativeCapletsService(
      { mode: "remote", remote: { url: "http://127.0.0.1:7341" } },
      nativeRemoteGate.loader,
    ).then((service) => {
      nativeRemoteExposed = true;
      return service;
    });
    await Promise.resolve();
    expect(nativeRemoteExposed).toBe(false);
    nativeRemoteGate.release();
    const nativeRemote = await nativeRemotePending;
    expect(nativeRemote.constructor.name).toBe("ProfileBackedNativeCapletsService");
    await nativeRemote.close();

    const remoteGate = gatedRuntimeLoader(snapshot);
    let remoteExposed = false;
    const remotePending = dispatchRemoteCliRequest(
      { command: "list", arguments: {} },
      {
        projectCapletsRoot: "/project/.caplets",
        internalRuntimeSnapshotLoader: remoteGate.loader,
      },
    ).then((response) => {
      remoteExposed = true;
      return response;
    });
    await Promise.resolve();
    expect(remoteExposed).toBe(false);
    remoteGate.release();
    await expect(remotePending).resolves.toMatchObject({ ok: true });

    const stdioGate = gatedRuntimeLoader(snapshot);
    let stdioRuntimeExposed = false;
    const stdioPending = createInternalStdioRuntime(
      { watch: false, signalHandling: false },
      stdioGate.loader,
    ).then((stdioRuntime) => {
      stdioRuntimeExposed = true;
      return stdioRuntime;
    });
    await Promise.resolve();
    expect(stdioRuntimeExposed).toBe(false);
    stdioGate.release();
    const stdioRuntime = await stdioPending;
    expect(stdioRuntime.engine.currentConfig().httpApis.alpha?.name).toBe("SQL sql");
    await stdioRuntime.session.close();
    await stdioRuntime.engine.close();

    const httpGate = gatedRuntimeLoader(snapshot);
    const resolvedHttp = resolveServeOptions({ transport: "http" });
    if (resolvedHttp.transport !== "http") throw new Error("Expected HTTP serve options");
    let httpExposed = false;
    void serveInternalHttp(resolvedHttp, { watch: false }, httpGate.loader).then(() => {
      httpExposed = true;
    });
    await Promise.resolve();
    expect(httpExposed).toBe(false);
  });

  it("composes the exact 2,000-Caplet U2 count within the 1-second p99 budget", async () => {
    const fixtureCount = STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets;
    const tags = Array.from(
      { length: 45 },
      (_, index) => `tag-${index.toString().padStart(2, "0")}`,
    );
    const withBody = (
      entry: ControlPlaneSnapshot["caplets"][number],
      body: string,
    ): ControlPlaneSnapshot["caplets"][number] => ({
      ...entry,
      aggregate: {
        ...entry.aggregate,
        portable: {
          ...entry.aggregate.portable,
          frontmatter: {
            ...entry.aggregate.portable.frontmatter,
            catalog: {
              displayName: entry.aggregate.portable.name,
              summary: "Full-envelope runtime fixture.",
              tags,
            },
          },
          body,
        },
      },
      projection: { ...entry.projection, body },
    });
    const baseCaplets = Array.from({ length: fixtureCount }, (_, index) =>
      withBody(
        httpAggregate(`caplet-${index.toString().padStart(4, "0")}`, `fixture-${index}`),
        "",
      ),
    );
    const baseBytes = baseCaplets.reduce(
      (total, { aggregate }) => total + encodePortableCaplet(aggregate.portable).byteLength,
      0,
    );
    const remainingBytes = STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes - baseBytes;
    expect(remainingBytes).toBeGreaterThan(0);
    const bodyBytes = Math.floor(remainingBytes / fixtureCount);
    const bodyRemainder = remainingBytes % fixtureCount;
    const caplets = baseCaplets.map((entry, index) =>
      withBody(entry, "x".repeat(bodyBytes + (index < bodyRemainder ? 1 : 0))),
    );
    const encodedBytes = caplets.reduce(
      (total, { aggregate }) => total + encodePortableCaplet(aggregate.portable).byteLength,
      0,
    );
    const normalizedRows = caplets.reduce((total) => total + 50, 0);
    expect(encodedBytes).toBe(STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes);
    expect(normalizedRows).toBe(STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows);
    const snapshot = {
      ...sqlSnapshot(caplets),
      hostSettings: [],
      normalizedRows,
      encodedBytes,
    };
    const filesystemLayers: RuntimeConfigLayerInput[] = (
      ["global-config", "project-config"] as const
    ).map((kind) => ({
      input: {
        httpApis: Object.fromEntries(
          caplets.map(({ aggregate }) => [
            aggregate.id,
            {
              name: `${kind} ${aggregate.id}`,
              description: `${kind} shadow for ${aggregate.id}`,
              baseUrl: `https://${aggregate.id}.${kind}.example.test`,
              auth: { type: "none" as const },
              actions: { ping: { method: "GET" as const, path: "/ping" } },
            },
          ]),
        ),
      },
      source: {
        kind,
        path: kind === "global-config" ? "/host/config.json" : "/project/caplets.json",
      },
    }));
    const bootstrapFingerprint = bootstrapFingerprintFor(filesystemLayers, {}, [], {});
    const composeFixture = () =>
      composeControlPlaneRuntimeSnapshot({
        hydration: hydration(
          "sqlite",
          { currentFingerprint: bootstrapFingerprint },
          {
            ...snapshot,
            caplets: [...snapshot.caplets],
            hostSettings: [...snapshot.hostSettings],
          },
        ),
        filesystemLayers,
        resolvedRuntimeInputs: {},
        hiddenCommitments: [],
        providerVersions: {},
      });
    const runP99Ms: number[] = [];
    for (let run = 0; run < STORAGE_BENCHMARK_ENVELOPE.independentRuns; run += 1) {
      for (let index = 0; index < STORAGE_BENCHMARK_ENVELOPE.warmupSamples; index += 1) {
        await composeFixture();
      }
      const samples: number[] = [];
      let composed: ControlPlaneRuntimeSnapshot | undefined;
      for (let index = 0; index < STORAGE_BENCHMARK_ENVELOPE.measuredSamplesPerRun; index += 1) {
        const started = performance.now();
        composed = await composeFixture();
        samples.push(performance.now() - started);
      }
      expect(Object.keys(composed?.caplets ?? {})).toHaveLength(fixtureCount);
      runP99Ms.push(nearestRank(samples, 0.99));
    }
    const p99Ms = Math.max(...runP99Ms);
    if (process.env.CAPLETS_BENCHMARK_REPORT === "1") {
      process.stdout.write(
        `${JSON.stringify({
          fixture: "u8-runtime-composition",
          runs: runP99Ms,
          samplesPerRun: STORAGE_BENCHMARK_ENVELOPE.measuredSamplesPerRun,
          p99Ms,
        })}\n`,
      );
    }
    expect(runP99Ms).toHaveLength(STORAGE_BENCHMARK_ENVELOPE.independentRuns);
    expect(runP99Ms.every((runP99Ms) => runP99Ms <= 1_000)).toBe(true);
  }, 600_000);
});
