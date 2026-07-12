import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, loadStorageBootstrap, loadResolvedStorageContext } from "../src/config";
import { CapletsEngine } from "../src/engine";
import {
  classifyGeneration,
  redactAuthorityDiagnostic,
  safeAuthorityHealth,
  validateAuthorityGeneration,
} from "../src/storage/conformance";
import {
  MAX_AUTHORITY_GENERATION_BYTES,
  MAX_SEMANTIC_COMMITS_PER_HOST_PER_MINUTE,
  MAX_SEMANTIC_COMMITS_PER_PRINCIPAL_PER_MINUTE,
  type AuthorityGeneration,
  type AuthorityHead,
} from "../src/storage/types";
import {
  AuthorityProviderRegistryMissError,
  createAuthority,
  createAuthorityWithBuiltinFallback,
  lookupAuthorityProvider,
  registerAuthorityProvider,
  registeredAuthorityProviders,
  type AuthorityProviderContext,
} from "../src/storage/factory";
import { FileVaultStore } from "../src/vault";
import * as coreApi from "../src/index";

describe("storage bootstrap", () => {
  it("loads global storage through secret-free public and resolved private projections", () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-storage-"));
    const globalPath = join(root, "config.json");
    const projectPath = join(root, "project", ".caplets", "config.json");
    mkdirSync(join(root, "project", ".caplets"), { recursive: true });
    writeFileSync(
      globalPath,
      JSON.stringify({
        version: 1,
        storage: {
          provider: "s3",
          bucket: "bucket",
          region: "auto",
          path: "prod",
          credentials: "env:AUTH",
          vaultKey: "env:VAULT",
        },
      }),
    );
    writeFileSync(projectPath, JSON.stringify({ version: 1 }));

    const publicLoaded = loadStorageBootstrap(
      globalPath,
      { AUTH: "secret", VAULT: "key" },
      undefined,
      {
        projectPath,
      },
    );
    expect(publicLoaded.bootstrap).toMatchObject({
      provider: "s3",
      bucket: "bucket",
      region: "auto",
      path: "prod",
      credentials: "env:AUTH",
      vaultKey: "env:VAULT",
    });
    expect(publicLoaded).not.toHaveProperty("secrets");
    expect(JSON.stringify(publicLoaded)).not.toContain("secret");

    const resolved = loadResolvedStorageContext(
      globalPath,
      { AUTH: "secret", VAULT: "key" },
      undefined,
      {
        projectPath,
      },
    );
    expect(resolved.secrets).toEqual({ credential: "secret", vaultKey: "key" });
    expect(resolved.inventory.entries.some((entry) => entry.owner === "authority")).toBe(true);
    expect(resolved.inventory.entries.some((entry) => entry.owner === "staged")).toBe(true);
  });

  it("accepts provider-shaped variants and defaults omitted storage to filesystem", () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-storage-shapes-"));
    const globalPath = join(root, "config.json");
    for (const storage of [
      undefined,
      { provider: "filesystem" },
      { provider: "filesystem", path: "./state" },
      { provider: "sqlite", path: "./state.sqlite" },
      { provider: "postgresql", connection: "env:PG" },
      { provider: "s3", bucket: "bucket", region: "auto" },
    ]) {
      writeFileSync(globalPath, JSON.stringify({ version: 1, ...(storage ? { storage } : {}) }));
      const loaded = loadStorageBootstrap(globalPath, { PG: "postgres://db" });
      expect(loaded.bootstrap.provider).toBe(storage?.provider ?? "filesystem");
    }
  });

  it("resolves explicit local storage paths absolutely against a relative declaring config path", () => {
    const absoluteRoot = mkdtempSync(join(tmpdir(), "caplets-storage-relative-config-"));
    const relativeRoot = relative(process.cwd(), absoluteRoot);
    const globalPath = join(relativeRoot, "config.json");
    try {
      for (const storage of [
        { provider: "filesystem", path: "./state" },
        { provider: "sqlite", path: "./state.sqlite" },
      ]) {
        writeFileSync(globalPath, JSON.stringify({ version: 1, storage }));
        const loaded = loadStorageBootstrap(globalPath);
        expect(loaded.bootstrap).toMatchObject({
          provider: storage.provider,
          path: resolve(dirname(globalPath), storage.path),
        });
      }

      writeFileSync(globalPath, JSON.stringify({ version: 1 }));
      expect(loadStorageBootstrap(globalPath).bootstrap).not.toHaveProperty("path");
    } finally {
      rmSync(absoluteRoot, { recursive: true, force: true });
    }
  });
  it("rejects staged ownership collisions with explicit local storage paths", () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-storage-local-collision-"));
    const globalPath = join(root, "config.json");
    const projectPath = join(root, "missing-project.json");
    for (const storage of [
      { provider: "filesystem", path: "./shared-state" },
      { provider: "sqlite", path: "./shared-state.sqlite" },
    ]) {
      writeFileSync(globalPath, JSON.stringify({ version: 1, storage }));
      expect(() =>
        loadResolvedStorageContext(globalPath, {}, undefined, {
          projectPath,
          stagedPaths: [resolve(root, storage.path)],
        }),
      ).toThrow(/duplicate ownership.*authority, staged/i);
    }
  });
  it("rejects legacy authority and every removed provider field", () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-storage-legacy-"));
    const globalPath = join(root, "config.json");
    const removed = [
      "authorityId",
      "namespace",
      "connectionRef",
      "credentialRef",
      "vaultKeyRef",
      "databasePath",
    ];
    writeFileSync(
      globalPath,
      JSON.stringify({ version: 1, authority: { provider: "filesystem" } }),
    );
    expect(() => loadStorageBootstrap(globalPath)).toThrow(/invalid/i);
    for (const field of removed) {
      writeFileSync(
        globalPath,
        JSON.stringify({ version: 1, storage: { provider: "filesystem", [field]: "legacy" } }),
      );
      expect(() => loadStorageBootstrap(globalPath)).toThrow(/invalid/i);
    }
  });

  it("rejects project storage and legacy authority", () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-storage-project-"));
    const globalPath = join(root, "config.json");
    const projectPath = join(root, ".caplets", "config.json");
    mkdirSync(join(root, ".caplets"), { recursive: true });
    writeFileSync(globalPath, JSON.stringify({ version: 1 }));
    for (const forbidden of [
      { storage: { provider: "filesystem" } },
      { authority: { provider: "filesystem" } },
    ]) {
      writeFileSync(projectPath, JSON.stringify({ version: 1, ...forbidden }));
      expect(() => loadStorageBootstrap(globalPath, {}, undefined, { projectPath })).toThrow(
        /must not define|cannot define|invalid/,
      );
    }
  });

  it("fails declared missing or empty secrets while omitted S3 credentials use workload identity", () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-storage-secrets-"));
    const globalPath = join(root, "config.json");
    const cases = [
      { storage: { provider: "postgresql", connection: "env:MISSING" }, env: {} },
      { storage: { provider: "postgresql", connection: "env:EMPTY" }, env: { EMPTY: "" } },
      {
        storage: { provider: "s3", bucket: "bucket", region: "auto", credentials: "env:EMPTY" },
        env: { EMPTY: "" },
      },
      {
        storage: { provider: "filesystem", vaultKey: "env:ZERO" },
        env: {},
        resolver: () => new Uint8Array(),
      },
    ];
    for (const { storage, env, resolver } of cases) {
      writeFileSync(globalPath, JSON.stringify({ version: 1, storage }));
      expect(() => loadResolvedStorageContext(globalPath, env, resolver)).toThrow(
        /reference|resolve|empty/i,
      );
    }
    writeFileSync(
      globalPath,
      JSON.stringify({ version: 1, storage: { provider: "s3", bucket: "bucket", region: "auto" } }),
    );
    expect(loadResolvedStorageContext(globalPath, {}).secrets).not.toHaveProperty("credential");
  });
  it("propagates invalid shared-storage secrets through synchronous runtime guards", () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-storage-sync-guard-"));
    const globalPath = join(root, "config.json");
    const projectPath = join(root, "missing-project.json");
    writeFileSync(
      globalPath,
      JSON.stringify({
        version: 1,
        storage: { provider: "postgresql", connection: "env:CAPLETS_TEST_MISSING_DSN" },
      }),
    );

    expect(() => loadConfig(globalPath, projectPath)).toThrow(/reference|resolve|empty/i);
    expect(
      () =>
        new CapletsEngine({
          configPath: globalPath,
          projectConfigPath: projectPath,
          watch: false,
        }),
    ).toThrow(/reference|resolve|empty/i);
  });

  it("exposes only the storage config API and explicit provider registry allowlist at package root", () => {
    expect(coreApi).toHaveProperty("loadStorageBootstrap");
    expect(coreApi).not.toHaveProperty("loadResolvedStorageContext");
    expect(coreApi).not.toHaveProperty("loadAuthorityBootstrap");
    expect(coreApi).toHaveProperty("lookupAuthorityProvider");
    expect(coreApi).toHaveProperty("registerAuthorityProvider");
    expect(coreApi).toHaveProperty("registeredAuthorityProviders");
    expect(coreApi).toHaveProperty("AuthorityProviderRegistryMissError");
    expect(coreApi).not.toHaveProperty("createAuthority");
    expect(coreApi).not.toHaveProperty("createAuthorityWithBuiltinFallback");
  });
});

describe("ordered generation contract", () => {
  const head: AuthorityHead = {
    authorityId: "a",
    id: "g2",
    sequence: 2,
    predecessorId: "g1",
    digest: "sha256:2",
  };
  const generation: AuthorityGeneration = {
    ...head,
    schemaVersion: 1,
    committedAt: "2026-01-01T00:00:00.000Z",
    provenance: { provider: "filesystem", namespace: "n" },
    snapshot: {},
  };

  it("distinguishes idempotent, advanced, and regressed observations", () => {
    expect(classifyGeneration(head, head).kind).toBe("unchanged");
    expect(
      classifyGeneration({ ...head, id: "g1", sequence: 1, predecessorId: null }, head).kind,
    ).toBe("advanced");
    expect(classifyGeneration({ ...head, sequence: 3 }, head)).toEqual({
      kind: "regression",
      reason: "sequence",
    });
    expect(classifyGeneration(head, { ...head, id: "other" })).toEqual({
      kind: "regression",
      reason: "identity",
    });
    expect(classifyGeneration(head, { ...head, authorityId: "other" })).toEqual({
      kind: "regression",
      reason: "authority",
    });
  });

  it("validates head identity, digest, and the provider-neutral size ceiling", () => {
    expect(() =>
      validateAuthorityGeneration(head, generation, MAX_AUTHORITY_GENERATION_BYTES),
    ).not.toThrow();
    expect(() =>
      validateAuthorityGeneration(head, { ...generation, digest: "corrupt" }, 1),
    ).toThrow(/does not match/);
    expect(() =>
      validateAuthorityGeneration(head, generation, MAX_AUTHORITY_GENERATION_BYTES + 1),
    ).toThrow(/64 MiB/);
  });
});

describe("safe provider-neutral surface", () => {
  it("redacts nested diagnostics and exposes orthogonal finite health", () => {
    expect(
      redactAuthorityDiagnostic({ dsn: "postgres://secret", nested: { token: "x" }, code: "DOWN" }),
    ).toEqual({ dsn: "[REDACTED]", nested: { token: "[REDACTED]" }, code: "DOWN" });
    const health = safeAuthorityHealth({
      provider: "postgresql",
      authorityId: "a",
      connectivity: "degraded",
      writable: false,
      activeGeneration: null,
      refresh: "failed",
      code: "UNREACHABLE",
    });
    expect(health).toEqual({
      provider: "postgresql",
      authorityId: "a",
      connectivity: "degraded",
      writable: false,
      activeGeneration: null,
      refresh: "failed",
      code: "UNREACHABLE",
    });
    expect(JSON.stringify(health)).not.toMatch(/postgres:|token|password/i);
  });

  it("publishes explicit rate semantics and rejects duplicate registration", () => {
    expect([
      MAX_SEMANTIC_COMMITS_PER_PRINCIPAL_PER_MINUTE,
      MAX_SEMANTIC_COMMITS_PER_HOST_PER_MINUTE,
    ]).toEqual([60, 300]);
    const factory = async () => ({}) as never;
    const unregister = registerAuthorityProvider("s3", factory);
    expect(registeredAuthorityProviders()).toContain("s3");
    expect(() => registerAuthorityProvider("s3", factory)).toThrow(/already registered/);
    unregister();
  });

  it("distinguishes a registry miss from a registered factory failure", async () => {
    const context: AuthorityProviderContext = {
      bootstrap: {
        provider: "s3",
        authorityId: "factory-test",
        namespace: "factory-test",
        pollIntervalMs: 1,
        bucket: "factory-test",
        region: "auto",
      },
      secrets: {},
    };
    const miss = lookupAuthorityProvider("s3");
    expect(miss).toEqual({ kind: "registry-miss", provider: "s3" });
    await expect(createAuthority(context)).rejects.toBeInstanceOf(
      AuthorityProviderRegistryMissError,
    );

    const factoryFailure = new Error("Authority provider s3 is not registered");
    const unregister = registerAuthorityProvider("s3", async () => {
      throw factoryFailure;
    });
    try {
      await expect(createAuthorityWithBuiltinFallback(context, "/tmp/config.json")).rejects.toBe(
        factoryFailure,
      );
    } finally {
      unregister();
    }
  });

  it("uses authority provenance as Vault grant identity without a fake path", () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-vault-authority-"));
    const store = new FileVaultStore({ root });
    store.grantAccess({
      storedKey: "TOKEN",
      referenceName: "TOKEN",
      capletId: "github",
      origin: { kind: "authority", authorityId: "a", recordId: "github", generationId: "g1" },
    });
    const [grant] = store.listAccess();
    expect(grant?.origin).toEqual({
      kind: "authority",
      authorityId: "a",
      recordId: "github",
      generationId: "g1",
    });
    expect(grant?.origin).not.toHaveProperty("path");
  });
});
