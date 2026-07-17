import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hashInstalledArtifact } from "../src/cli/install";
import { writeCapletsLockfile, type CapletsLockfile } from "../src/cli/lockfile";
import {
  readVerifiedLegacyMigrationSource,
  runLegacyControlPlaneInitialization,
  runFreshControlPlaneInitialization,
  type LegacyInitializationDestination,
  type LegacyInitializationFaultPoint,
  type LegacyMigrationExclusionLease,
  type LegacyInitializationEntity,
  type VerifiedLegacyRecord,
  type LegacyControlPlaneInitializationOptions,
  type LegacyMigrationMetadata,
  type U6ProtectedLegacyRecord,
  type LegacyDestinationOperation,
} from "../src/control-plane/migration/legacy";
import type { CapletsError } from "../src/errors";

describe("legacy control-plane migration source", () => {
  it("reads only tracked global Caplets and reviewed runtime sources without mutating excluded files", () => {
    const fixture = legacyFixture();
    try {
      const excludedBefore = new Map(
        fixture.excluded.map((path) => [
          path,
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        ]),
      );

      const source = readVerifiedLegacyMigrationSource({
        sealedRoot: fixture.root,
        globalCapletsRoot: "global-caplets",
        globalLockfilePath: "caplets.lock.json",
        reviewedSources: [
          { relativePath: "runtime/activity.json", domain: "operator-activity" },
          { relativePath: "runtime/authority.json", domain: "host-authority" },
        ],
        sealedSourceIdentities: legacySourceIdentities(),
      });

      expect(source.trackedCaplets.map(({ entry }) => entry.id)).toEqual(["tracked"]);
      expect(source.records.map(({ domain }) => domain)).toEqual([
        "operator-activity",
        "host-authority",
      ]);
      expect(source.quarantines).toEqual([]);
      expect(source.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(
        fixture.excluded.map((path) =>
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        ),
      ).toEqual([...excludedBefore.values()]);
    } finally {
      fixture.remove();
    }
  });

  it("reads one canonical logical source from separately sealed physical mappings", () => {
    const fixture = legacyFixture();
    try {
      const source = readVerifiedLegacyMigrationSource({
        sealedSourceMappings: [
          {
            logicalPath: "global-caplets/tracked.md",
            sealedPath: join(fixture.root, "global-caplets", "tracked.md"),
            kind: "file",
          },
          {
            logicalPath: "caplets.lock.json",
            sealedPath: join(fixture.root, "caplets.lock.json"),
            kind: "file",
          },
          {
            logicalPath: "runtime/activity.json",
            sealedPath: join(fixture.root, "runtime", "activity.json"),
            kind: "file",
          },
          {
            logicalPath: "runtime/authority.json",
            sealedPath: join(fixture.root, "runtime", "authority.json"),
            kind: "file",
          },
        ],
        globalCapletsRoot: "global-caplets",
        globalLockfilePath: "caplets.lock.json",
        reviewedSources: [
          { relativePath: "runtime/activity.json", domain: "operator-activity" },
          { relativePath: "runtime/authority.json", domain: "host-authority" },
        ],
        sealedSourceIdentities: [
          { relativePath: "global-caplets/tracked.md", kind: "file" },
          { relativePath: "caplets.lock.json", kind: "file" },
          { relativePath: "runtime/activity.json", kind: "file" },
          { relativePath: "runtime/authority.json", kind: "file" },
        ],
      });
      expect(source.trackedCaplets.map(({ entry }) => entry.id)).toEqual(["tracked"]);
      expect(source.records).toHaveLength(2);
    } finally {
      fixture.remove();
    }
  });

  it("hard-stops on changed identity, wrong kind, escaping paths, and malformed authority", () => {
    const fixture = legacyFixture();
    try {
      writeFileSync(join(fixture.root, "global-caplets", "tracked.md"), "changed\n");
      expect(() => verifiedSource(fixture.root)).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
      );

      writeFileSync(join(fixture.root, "global-caplets", "tracked.md"), fixture.trackedBytes);
      writeCapletsLockfile(join(fixture.root, "caplets.lock.json"), {
        ...fixture.lockfile,
        entries: [{ ...fixture.lockfile.entries[0]!, kind: "directory" }],
      });
      expect(() => verifiedSource(fixture.root)).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
      );

      writeCapletsLockfile(join(fixture.root, "caplets.lock.json"), fixture.lockfile);
      writeFileSync(
        join(fixture.root, "runtime", "authority.json"),
        JSON.stringify({ logicalHostId: "host-1", storeId: "store-1", unexpected: true }),
      );
      expect(() => verifiedSource(fixture.root)).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
      );

      writeFileSync(
        join(fixture.root, "runtime", "authority.json"),
        '{"logicalHostId":"host-1","storeId":"store-1","operationNamespace":"namespace-1","state":"active","state":"active","generation":4,"updatedAt":"2026-07-15T00:00:00.000Z"}',
      );
      expect(() => verifiedSource(fixture.root)).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
      );

      expect(() =>
        readVerifiedLegacyMigrationSource({
          sealedRoot: fixture.root,
          globalCapletsRoot: "../project-caplets",
          globalLockfilePath: "caplets.lock.json",
          reviewedSources: [],
          sealedSourceIdentities: legacySourceIdentities(),
        }),
      ).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError);
    } finally {
      fixture.remove();
    }
  });
  it("rejects invalid UTF-8, partial source review, and extra runtime sources", () => {
    const fixture = legacyFixture();
    try {
      writeFileSync(join(fixture.root, "runtime", "authority.json"), Buffer.from([0xff, 0xfe]));
      expect(() => verifiedSource(fixture.root)).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
      );

      writeFileSync(
        join(fixture.root, "runtime", "authority.json"),
        JSON.stringify({
          logicalHostId: "host-1",
          storeId: "store-1",
          operationNamespace: "namespace-1",
          state: "active",
          generation: 4,
          updatedAt: "2026-07-15T00:00:00.000Z",
        }),
      );
      const lockfilePath = join(fixture.root, "caplets.lock.json");
      const invalidLockfile = readFileSync(lockfilePath);
      const trackedIdOffset = invalidLockfile.indexOf(Buffer.from("tracked", "utf8"));
      if (trackedIdOffset < 0) throw new Error("fixture lock ID missing");
      invalidLockfile[trackedIdOffset] = 0xff;
      writeFileSync(lockfilePath, invalidLockfile);
      expect(() => verifiedSource(fixture.root)).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
      );
      writeCapletsLockfile(lockfilePath, fixture.lockfile);
      expect(() =>
        readVerifiedLegacyMigrationSource({
          sealedRoot: fixture.root,
          globalCapletsRoot: "global-caplets",
          globalLockfilePath: "caplets.lock.json",
          reviewedSources: [{ relativePath: "runtime/authority.json", domain: "host-authority" }],
          sealedSourceIdentities: legacySourceIdentities(),
        }),
      ).toThrow(expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError);

      writeFileSync(join(fixture.root, "runtime", "unclassified.json"), "{}");
      expect(() => verifiedSource(fixture.root)).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
      );
    } finally {
      fixture.remove();
    }
  });

  it("binds complete lock provenance and rejects duplicate destinations and source identities", () => {
    const fixture = legacyFixture();
    try {
      const original = verifiedSource(fixture.root).manifestSha256;
      const [entry] = fixture.lockfile.entries;
      if (!entry) throw new Error("fixture lock entry missing");
      if (entry.source.type !== "git") throw new Error("fixture source must be git");
      writeCapletsLockfile(join(fixture.root, "caplets.lock.json"), {
        version: 1,
        entries: [{ ...entry, source: { ...entry.source, resolvedRevision: "def456" } }],
      });
      expect(verifiedSource(fixture.root).manifestSha256).not.toBe(original);

      writeCapletsLockfile(join(fixture.root, "caplets.lock.json"), {
        version: 1,
        entries: [entry, { ...entry, id: "duplicate-destination" }],
      });
      expect(() => verifiedSource(fixture.root)).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
      );

      writeCapletsLockfile(join(fixture.root, "caplets.lock.json"), {
        version: 1,
        entries: [entry, { ...entry, id: "duplicate-source", destination: "other.md" }],
      });
      writeFileSync(join(fixture.root, "global-caplets", "other.md"), fixture.trackedBytes);
      expect(() => verifiedSource(fixture.root)).toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
      );
    } finally {
      fixture.remove();
    }
  });

  it("quarantines malformed non-authoritative activity with exact source bytes and audit provenance", () => {
    const fixture = legacyFixture();
    try {
      const activityPath = join(fixture.root, "runtime", "activity.json");
      const rawBytes = Buffer.from('{"id":"activity-1","unexpected":true}\n');
      writeFileSync(activityPath, rawBytes);

      const source = verifiedSource(fixture.root);

      expect(source.records.map(({ domain }) => domain)).toEqual(["host-authority"]);
      expect(source.quarantines).toHaveLength(1);
      expect(source.quarantines[0]).toMatchObject({
        domain: "operator-activity",
        sourcePath: "runtime/activity.json",
        recordIndex: 0,
        rawDigest: createHash("sha256").update(rawBytes).digest("hex"),
        reason: "unsupported-field",
      });
      expect(source.quarantines[0]?.sourceBytes).toEqual(rawBytes);
    } finally {
      fixture.remove();
    }
  });

  it("shares one quarantined source blob across multiple activity dispositions", () => {
    const fixture = legacyFixture();
    try {
      writeFileSync(
        join(fixture.root, "runtime", "activity.json"),
        '[{"id":"one","unexpected":true},{"id":"two","unexpected":true}]',
      );
      const source = verifiedSource(fixture.root);
      expect(source.quarantines).toHaveLength(2);
      expect(source.quarantines[0]?.sourceBytes).toBe(source.quarantines[1]?.sourceBytes);
    } finally {
      fixture.remove();
    }
  });
});

describe("legacy control-plane initialization state machine", () => {
  const preActivationFaults: readonly LegacyInitializationFaultPoint[] = [
    "after-process-handle-exclusion",
    "after-source-relocation",
    "after-tombstone-publication",
    "after-source-rehash",
    "after-backup-chunk",
    "after-schema",
    "after-entity-insert",
    "after-staged-commit",
    "after-invalidation",
    "after-verification",
  ];

  for (const backend of ["sqlite", "postgres"] as const) {
    it(`activates one verified ${backend} authority and retains tombstones`, async () => {
      const fixture = legacyFixture();
      const harness = initializationHarness(fixture.root, backend);
      try {
        await expect(runLegacyControlPlaneInitialization(harness.options)).resolves.toMatchObject({
          status: "migrated",
          backend,
        });
        expect(harness.destination.state).toBe("finalized");
        expect(harness.destination.activations).toBe(1);
        expect(harness.events.indexOf("protected")).toBeLessThan(
          harness.events.indexOf("destination:activate"),
        );
        expect(harness.destination.fencingTokens.length).toBeGreaterThan(0);
        expect(
          harness.destination.fencingTokens.every(
            (token) => token === (backend === "postgres" ? 40 : 0),
          ),
        ).toBe(true);
        expect(harness.exclusion.completed).toBe(true);
        expect(harness.exclusion.rolledBack).toBe(false);
      } finally {
        fixture.remove();
      }
    });

    it(`restores the exact sealed source and leaves ${backend} inactive for every pre-activation fault`, async () => {
      for (const faultPoint of preActivationFaults) {
        const fixture = legacyFixture();
        const harness = initializationHarness(fixture.root, backend, faultPoint);
        try {
          await expect(runLegacyControlPlaneInitialization(harness.options)).rejects.toThrow(
            `fault:${faultPoint}`,
          );
          expect(harness.destination.state).toBe("empty");
          expect(harness.destination.activations).toBe(0);
          expect(harness.exclusion.rolledBack).toBe(true);
          expect(harness.exclusion.completed).toBe(false);
          expect(harness.events.indexOf("destination:abort")).toBeLessThan(
            harness.events.indexOf("exclusion:rollback"),
          );
        } finally {
          fixture.remove();
        }
      }
    });
  }

  it("keeps non-elected Postgres replicas not-ready without touching legacy bytes", async () => {
    const fixture = legacyFixture();
    const harness = initializationHarness(fixture.root, "postgres");
    harness.options.election = { tryElect: async () => undefined };
    try {
      await expect(runLegacyControlPlaneInitialization(harness.options)).resolves.toEqual({
        status: "not-ready",
        backend: "postgres",
        reason: "migration-election",
      });
      expect(harness.events).toEqual([]);
      expect(harness.destination.state).toBe("empty");
    } finally {
      fixture.remove();
    }
  });

  it("uses identical semantics for the global-only offline fallback", async () => {
    const fixture = legacyFixture();
    const harness = initializationHarness(fixture.root, "postgres");
    harness.options.mode = "offline";
    try {
      await runLegacyControlPlaneInitialization(harness.options);
      expect(harness.exclusion.mode).toBe("offline");
      expect(harness.destination.activations).toBe(1);
    } finally {
      fixture.remove();
    }
  });
  it("resolves a lost activation acknowledgement without restoring old authority", async () => {
    const fixture = legacyFixture();
    const harness = initializationHarness(fixture.root, "sqlite");
    const activate = harness.destination.activateAuthority;
    harness.destination.activateAuthority = async (...args) => {
      await activate(...args);
      throw new Error("lost activation acknowledgement");
    };
    try {
      await expect(runLegacyControlPlaneInitialization(harness.options)).resolves.toMatchObject({
        status: "migrated",
      });
      expect(harness.destination.activations).toBe(1);
      expect(harness.exclusion.rolledBack).toBe(false);
    } finally {
      fixture.remove();
    }
  });

  it("adopts a finalized legacy migration on restart without activating authority twice", async () => {
    const fixture = legacyFixture();
    const harness = initializationHarness(fixture.root, "sqlite");
    try {
      await expect(runLegacyControlPlaneInitialization(harness.options)).resolves.toMatchObject({
        status: "migrated",
      });
      expect(harness.destination.state).toBe("finalized");
      await expect(runLegacyControlPlaneInitialization(harness.options)).resolves.toMatchObject({
        status: "already-migrated",
      });
      expect(harness.destination.activations).toBe(1);
    } finally {
      fixture.remove();
    }
  });

  it("resumes exclusion cleanup and finalization after activation", async () => {
    const fixture = legacyFixture();
    const harness = initializationHarness(
      fixture.root,
      "sqlite",
      "after-authority-token-activation",
    );
    try {
      await expect(runLegacyControlPlaneInitialization(harness.options)).rejects.toThrow(
        "fault:after-authority-token-activation",
      );
      expect(harness.destination.state).toBe("active");
      delete harness.options.fault;
      await expect(runLegacyControlPlaneInitialization(harness.options)).resolves.toMatchObject({
        status: "already-migrated",
      });
      expect(harness.exclusion.completed).toBe(true);
      expect(harness.destination.activations).toBe(1);
    } finally {
      fixture.remove();
    }
  });

  it("reconciles a partial protected backup before retrying migration", async () => {
    const fixture = legacyFixture();
    const harness = initializationHarness(fixture.root, "sqlite");
    let attempts = 0;
    let partialBackupPresent = false;
    harness.options.protectedRecovery = {
      protect: async () => {
        attempts += 1;
        if (attempts === 1) {
          partialBackupPresent = true;
          throw new Error("interrupted protected backup");
        }
        if (!partialBackupPresent) throw new Error("partial backup evidence was lost");
        partialBackupPresent = false;
        return { durable: true, bundleId: "bundle-after-reconciliation" };
      },
    };
    try {
      await expect(runLegacyControlPlaneInitialization(harness.options)).rejects.toThrow(
        "interrupted protected backup",
      );
      expect(harness.destination.state).toBe("empty");
      expect(harness.destination.activations).toBe(0);

      await expect(runLegacyControlPlaneInitialization(harness.options)).resolves.toMatchObject({
        status: "migrated",
      });
      expect(attempts).toBe(2);
      expect(partialBackupPresent).toBe(false);
      expect(harness.destination.activations).toBe(1);
    } finally {
      fixture.remove();
    }
  });

  it("rejects active or finalized state without bound recovery metadata", async () => {
    for (const state of ["active", "finalized"] as const) {
      const fixture = legacyFixture();
      const harness = initializationHarness(fixture.root, "sqlite");
      harness.destination.state = state;
      try {
        await expect(runLegacyControlPlaneInitialization(harness.options)).rejects.toThrow(
          expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
        );
        expect(harness.destination.state).toBe(state);
      } finally {
        fixture.remove();
      }
    }
  });

  it("rejects active metadata whose protected bundle provenance diverges", async () => {
    const fixture = legacyFixture();
    const harness = initializationHarness(
      fixture.root,
      "sqlite",
      "after-authority-token-activation",
    );
    try {
      await expect(runLegacyControlPlaneInitialization(harness.options)).rejects.toThrow(
        "fault:after-authority-token-activation",
      );
      const metadata = harness.destination.metadata;
      if (metadata?.kind !== "legacy") throw new Error("active legacy metadata missing");
      harness.destination.metadata = { ...metadata, protectedBundleId: "divergent-bundle" };
      delete harness.options.fault;
      await expect(runLegacyControlPlaneInitialization(harness.options)).rejects.toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
      );
      expect(harness.destination.state).toBe("active");
    } finally {
      fixture.remove();
    }
  });

  it("releases the mutex even when exclusion release fails", async () => {
    const fixture = legacyFixture();
    const harness = initializationHarness(fixture.root, "sqlite");
    let mutexReleased = false;
    harness.options.mutex = {
      acquire: async () => ({
        release: async () => {
          mutexReleased = true;
        },
      }),
    };
    Object.defineProperty(harness.exclusion, "release", {
      value: async () => {
        throw new Error("exclusion release failed");
      },
    });
    try {
      await expect(runLegacyControlPlaneInitialization(harness.options)).rejects.toThrow(
        expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
      );
      expect(mutexReleased).toBe(true);
    } finally {
      fixture.remove();
    }
  });

  it("stages credential material only after the injected U6 protector verifies it", async () => {
    const fixture = legacyFixture();
    const harness = initializationHarness(fixture.root, "sqlite");
    const sentinel = "plaintext-credential-sentinel";
    writeFileSync(
      join(fixture.root, "runtime", "credential.json"),
      JSON.stringify({ profileId: "profile-1", credential: sentinel }),
    );
    harness.sealedIdentities.push({
      relativePath: "runtime/credential.json",
      kind: "file",
    });
    const source = {
      ...harness.options.source,
      mutablePaths: [
        ...harness.options.source.mutablePaths,
        { relativePath: "runtime/credential.json", kind: "file" as const },
      ],
      reviewedSources: [
        ...harness.options.source.reviewedSources,
        {
          relativePath: "runtime/credential.json",
          domain: "remote-profile-credential" as const,
        },
      ],
    };
    try {
      await runLegacyControlPlaneInitialization({
        ...harness.options,
        source,
        credentialProtection: {
          protectAndVerify: async (record: VerifiedLegacyRecord) => ({
            ...record,
            canonical: {
              ...record.canonical,
              fields: {
                ...record.canonical.fields,
                verifierOrCiphertext: new TextEncoder().encode("u6-protected"),
              },
            },
            protection: { verifiedBy: "u6" as const, commitment: "credential-commitment" },
          }),
        },
      });
      const credential = harness.staged.find(
        (entity) =>
          entity.kind === "legacy-record" && entity.value.domain === "remote-profile-credential",
      );
      expect(credential?.kind).toBe("legacy-record");
      if (credential?.kind !== "legacy-record") throw new Error("credential was not staged");
      const protectedValue = credential.value.canonical.fields.verifierOrCiphertext;
      expect(protectedValue).toBeInstanceOf(Uint8Array);
      if (!(protectedValue instanceof Uint8Array)) throw new Error("credential is not bytes");
      expect(Buffer.from(protectedValue).toString("utf8")).toBe("u6-protected");
    } finally {
      fixture.remove();
    }
  });

  it("renews the Postgres election while protected recovery work is in flight", async () => {
    vi.useFakeTimers();
    const fixture = legacyFixture();
    const harness = initializationHarness(fixture.root, "postgres");
    let renewals = 0;
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    harness.options.election = {
      tryElect: async () => ({
        fencingToken: 41,
        renew: async () => {
          renewals += 1;
          return true;
        },
        release: async () => undefined,
      }),
    };
    harness.options.protectedRecovery = {
      protect: async () => {
        started.resolve();
        await finish.promise;
        return { durable: true, bundleId: "bundle-1" };
      },
    };
    try {
      const migration = runLegacyControlPlaneInitialization(harness.options);
      await started.promise;
      const beforeHeartbeat = renewals;
      await vi.advanceTimersByTimeAsync(5_001);
      expect(renewals).toBeGreaterThan(beforeHeartbeat);
      finish.resolve();
      await expect(migration).resolves.toMatchObject({ status: "migrated" });
    } finally {
      vi.useRealTimers();
      fixture.remove();
    }
  });

  it("fails closed when an elected Postgres fencing lease expires before destination work", async () => {
    const fixture = legacyFixture();
    const harness = initializationHarness(fixture.root, "postgres");
    let renewals = 0;
    Object.defineProperty(harness.options, "election", {
      value: {
        tryElect: async () => ({
          fencingToken: 41,
          renew: async () => {
            renewals += 1;
            return renewals < 3;
          },
          release: async () => undefined,
        }),
      },
    });
    try {
      await expect(runLegacyControlPlaneInitialization(harness.options)).rejects.toThrow(
        expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
      );
      expect(harness.destination.activations).toBe(0);
    } finally {
      fixture.remove();
    }
  });
});

for (const backend of ["sqlite", "postgres"] as const) {
  it(`initializes a fresh verified ${backend} authority without reading legacy files`, async () => {
    const fixture = legacyFixture();
    const harness = initializationHarness(fixture.root, backend);
    try {
      await expect(
        runFreshControlPlaneInitialization({
          backend,
          destination: harness.destination,
          election: harness.options.election,
          mutex: harness.options.mutex,
        }),
      ).resolves.toMatchObject({ status: "migrated", backend });
      expect(harness.destination.activations).toBe(1);
      expect(harness.events.some((event) => event.startsWith("exclusion:"))).toBe(false);
      expect(harness.events).not.toContain("protected");
    } finally {
      fixture.remove();
    }
  });
}
function verifiedSource(root: string) {
  return readVerifiedLegacyMigrationSource({
    sealedRoot: root,
    globalCapletsRoot: "global-caplets",
    globalLockfilePath: "caplets.lock.json",
    reviewedSources: [
      { relativePath: "runtime/activity.json", domain: "operator-activity" },
      { relativePath: "runtime/authority.json", domain: "host-authority" },
    ],
    sealedSourceIdentities: legacySourceIdentities(),
  });
}

function legacySourceIdentities() {
  return [
    { relativePath: "global-caplets", kind: "directory" as const },
    { relativePath: "caplets.lock.json", kind: "file" as const },
    { relativePath: "runtime/activity.json", kind: "file" as const },
    { relativePath: "runtime/authority.json", kind: "file" as const },
  ];
}

function legacyFixture() {
  const root = mkdtempSync(join(tmpdir(), "caplets-legacy-migration-"));
  const trackedBytes = "---\nid: tracked\n---\nTracked\n";
  mkdirSync(join(root, "global-caplets"), { recursive: true });
  mkdirSync(join(root, "project-caplets"), { recursive: true });
  mkdirSync(join(root, "runtime"), { recursive: true });
  const trackedPath = join(root, "global-caplets", "tracked.md");
  writeFileSync(trackedPath, trackedBytes);
  writeFileSync(join(root, "global-caplets", "bootstrap.md"), "bootstrap\n");
  writeFileSync(join(root, "config.json"), '{"mcpServers":{}}\n');
  writeFileSync(join(root, "project-caplets", "project.md"), "project\n");
  writeFileSync(join(root, "project-caplets", "caplets.lock.json"), '{"version":1}\n');
  writeFileSync(
    join(root, "runtime", "activity.json"),
    JSON.stringify({
      id: "activity-1",
      createdAt: "2026-07-15T00:00:00.000Z",
      actorClientId: "operator-1",
      action: "migration",
      outcome: "success",
      target: { kind: "host" },
    }),
  );
  writeFileSync(
    join(root, "runtime", "authority.json"),
    JSON.stringify({
      logicalHostId: "host-1",
      storeId: "store-1",
      operationNamespace: "namespace-1",
      state: "active",
      generation: 4,
      updatedAt: "2026-07-15T00:00:00.000Z",
    }),
  );
  const lockfile: CapletsLockfile = {
    version: 1,
    entries: [
      {
        id: "tracked",
        destination: "tracked.md",
        kind: "file",
        source: {
          type: "git",
          repository: "https://example.test/caplets.git",
          path: "caplets/tracked.md",
          resolvedRevision: "abc123",
          portability: "portable",
        },
        installedHash: hashInstalledArtifact(trackedPath),
        installedAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:00:00.000Z",
        risk: {
          backendFamilies: ["mcp"],
          safety: "standard",
          projectBindingRequired: false,
          mutating: false,
          destructive: false,
        },
      },
    ],
  };
  writeCapletsLockfile(join(root, "caplets.lock.json"), lockfile);
  return {
    root,
    trackedBytes,
    lockfile,
    excluded: [
      join(root, "global-caplets", "bootstrap.md"),
      join(root, "config.json"),
      join(root, "project-caplets", "project.md"),
      join(root, "project-caplets", "caplets.lock.json"),
    ],
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

function initializationHarness(
  root: string,
  backend: "sqlite" | "postgres",
  faultPoint?: LegacyInitializationFaultPoint,
) {
  const events: string[] = [];
  const sealedIdentities = legacySourceIdentities();
  const staged: LegacyInitializationEntity[] = [];
  const activationOutcomes = new Map<string, string>();
  const fencingTokens: number[] = [];
  const recordOperation = (operation: LegacyDestinationOperation) => {
    fencingTokens.push(operation.fencingToken);
  };
  const destination: LegacyInitializationDestination & {
    state: "empty" | "inactive" | "active" | "finalized";
    activations: number;
    metadata: LegacyMigrationMetadata | undefined;
    fencingTokens: number[];
  } = {
    backend,
    state: "empty",
    activations: 0,
    metadata: undefined,
    fencingTokens,
    inspect: async (operation) => {
      recordOperation(operation);
      return {
        state: destination.state,
        ...(destination.metadata ? { metadata: destination.metadata } : {}),
      };
    },
    assertCanInitialize: async ({ operation }) => {
      recordOperation(operation);
      if (destination.state !== "empty") throw new Error("destination is not empty");
    },
    beginInactive: async ({ operation, metadata }) => {
      recordOperation(operation);
      destination.state = "inactive";
      destination.metadata = metadata;
      events.push("destination:begin");
    },
    stageEntity: async ({ operation, entity }) => {
      recordOperation(operation);
      if (destination.state !== "inactive") throw new Error("not inactive");
      staged.push(entity);
    },
    commitInactive: async (operation) => {
      recordOperation(operation);
      events.push("destination:commit");
    },
    invalidateAuthority: async (operation) => {
      recordOperation(operation);
      events.push("destination:invalidate");
    },
    verifyInactive: async ({ operation }) => {
      recordOperation(operation);
      events.push("destination:verify");
    },
    activateAuthority: async ({ operation, metadata }) => {
      recordOperation(operation);
      destination.activations += 1;
      destination.state = "active";
      destination.metadata = metadata;
      activationOutcomes.set(metadata.activationId, "authority-1");
      events.push("destination:activate");
      return { authorityToken: "authority-1" };
    },
    resolveActivation: async ({ operation, activationId }) => {
      recordOperation(operation);
      const authorityToken = activationOutcomes.get(activationId);
      return authorityToken
        ? { status: "activated" as const, authorityToken }
        : { status: "not-activated" as const };
    },
    finalize: async ({ operation, metadata }) => {
      recordOperation(operation);
      if (destination.metadata?.activationId !== metadata.activationId) {
        throw new Error("finalization metadata diverged");
      }
      destination.state = "finalized";
      events.push("destination:finalize");
    },
    abortInactive: async (operation) => {
      recordOperation(operation);
      if (destination.state === "inactive") {
        destination.state = "empty";
        destination.metadata = undefined;
      }
      events.push("destination:abort");
    },
  };
  const exclusion: LegacyMigrationExclusionLease & {
    mode?: "automatic" | "offline";
    completed: boolean;
    rolledBack: boolean;
  } = {
    sealedSource: {
      path: root,
      manifestSha256: "sealed-manifest",
      cleanupId: "cleanup-1",
      identities: sealedIdentities,
    },
    tombstonePaths: [],
    initialEvidence: {},
    completed: false,
    rolledBack: false,
    verifyFinalScanAndRehash: async () => ({
      manifestSha256: "sealed-manifest",
      platformEvidence: {},
    }),
    rollbackBeforeActivation: async () => {
      exclusion.rolledBack = true;
      events.push("exclusion:rollback");
    },
    completeActivation: async () => {
      exclusion.completed = true;
      events.push("exclusion:complete");
    },
    release: async () => undefined,
  };
  const options: LegacyControlPlaneInitializationOptions = {
    backend,
    mode: "automatic",
    migrationId: "legacy-v1",
    source: {
      sourceBoundaryPath: root,
      mutablePaths: [
        { relativePath: "global-caplets", kind: "directory" },
        { relativePath: "caplets.lock.json", kind: "file" },
        { relativePath: "runtime/activity.json", kind: "file" },
        { relativePath: "runtime/authority.json", kind: "file" },
      ],
      globalCapletsRoot: "global-caplets",
      globalLockfilePath: "caplets.lock.json",
      reviewedSources: [
        { relativePath: "runtime/activity.json", domain: "operator-activity" },
        { relativePath: "runtime/authority.json", domain: "host-authority" },
      ],
    },
    destination,
    election: {
      tryElect: async () => ({
        fencingToken: 40,
        renew: async () => true,
        release: async () => undefined,
      }),
    },
    mutex: {
      acquire: async () => ({
        release: async () => undefined,
      }),
    },
    acquireExclusion: async (input) => {
      exclusion.mode = input.mode;
      events.push("exclusion:acquire");
      return exclusion;
    },
    resumePostActivation: async (metadata) => {
      await exclusion.completeActivation({ protectedRecoveryDurable: true, metadata });
    },
    protectedRecovery: {
      protect: async () => {
        events.push("protected");
        return { durable: true, bundleId: "bundle-1" };
      },
    },
    credentialProtection: {
      protectAndVerify: async (record): Promise<U6ProtectedLegacyRecord> => ({
        ...record,
        protection: {
          verifiedBy: "u6",
          commitment: `protected:${record.domain}:${record.recordIndex}`,
        },
      }),
    },
  };
  if (faultPoint) {
    options.fault = (point) => {
      if (point === faultPoint) throw new Error(`fault:${point}`);
    };
  }
  return { options, destination, exclusion, events, staged, sealedIdentities };
}
