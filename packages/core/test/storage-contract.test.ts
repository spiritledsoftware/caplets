import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAuthorityBootstrap } from "../src/config";
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

describe("authority bootstrap", () => {
  it("loads authority only from global config and keeps resolved secrets outside effective config", () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-authority-"));
    const globalPath = join(root, "config.json");
    const projectPath = join(root, "project", ".caplets", "config.json");
    mkdirSync(join(root, "project", ".caplets"), { recursive: true });
    writeFileSync(
      globalPath,
      JSON.stringify({
        version: 1,
        authority: {
          provider: "s3",
          authorityId: "host-a",
          namespace: "prod",
          bucket: "bucket",
          region: "auto",
          credentialRef: "env:AUTH",
          vaultKeyRef: "env:VAULT",
        },
      }),
    );
    writeFileSync(projectPath, JSON.stringify({ version: 1 }));
    const loaded = loadAuthorityBootstrap(globalPath, { AUTH: "secret", VAULT: "key" }, undefined, {
      projectPath,
    });
    expect(loaded.bootstrap).not.toHaveProperty("credential");
    expect(loaded.secrets).toEqual({ credential: "secret", vaultKey: "key" });
    expect(
      loaded.inventory.entries.every(
        (entry, index, all) =>
          all.findIndex((candidate) => candidate.path === entry.path) === index,
      ),
    ).toBe(true);
    expect(loaded.inventory.entries.some((entry) => entry.owner === "authority")).toBe(true);
    expect(loaded.inventory.entries.some((entry) => entry.owner === "staged")).toBe(true);
  });

  it("rejects project authority and duplicate source ownership", () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-authority-"));
    const globalPath = join(root, "config.json");
    const projectPath = join(root, ".caplets", "config.json");
    mkdirSync(join(root, ".caplets"), { recursive: true });
    writeFileSync(globalPath, JSON.stringify({ version: 1 }));
    writeFileSync(
      projectPath,
      JSON.stringify({ version: 1, authority: { provider: "filesystem", authorityId: "bad" } }),
    );
    expect(() => loadAuthorityBootstrap(globalPath, {}, () => undefined, { projectPath })).toThrow(
      /must not define/,
    );
    writeFileSync(projectPath, JSON.stringify({ version: 1 }));
    expect(() =>
      loadAuthorityBootstrap(globalPath, {}, () => undefined, {
        projectPath,
        stagedPaths: [globalPath],
      }),
    ).toThrow(/duplicate ownership/);
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
