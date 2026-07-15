import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapSqliteFileV1,
  fileV1CompatibilityCommitment,
  loadFileV1KeyProvider,
} from "../src/control-plane/key-provider/file-v1";
import {
  FILE_V1_PURPOSES,
  fileV1CompatibilityManifestCommitment,
  manifestForProfile,
  parseFileV1Manifest,
} from "../src/control-plane/key-provider/manifest";

const logicalHostId = "host_01J00000000000000000000000";
const storeId = "store_01J00000000000000000000000";
const roots: string[] = [];

function stateRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), "caplets-file-v1-"));
  roots.push(parent);
  return join(parent, "state");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("file-v1 key provider", () => {
  it("rejects caller-forged freshness claims for preexisting roots", async () => {
    const root = stateRoot();
    mkdirSync(root, { mode: 0o700 });
    await expect(
      bootstrapSqliteFileV1({
        root,
        logicalHostId,
        storeId,
        secureRoot: { path: root, fresh: true },
      }),
    ).rejects.toThrow(/provably fresh/i);
  });

  it("atomically bootstraps every purpose and disjoint process profiles on a fresh root", async () => {
    const root = stateRoot();
    const bootstrap = await bootstrapSqliteFileV1({ root, logicalHostId, storeId });
    const inventory = parseFileV1Manifest(readFileSync(bootstrap.inventoryManifestPath, "utf8"));

    expect(inventory.entries.map((entry) => entry.purpose).sort()).toEqual(
      [...FILE_V1_PURPOSES].sort(),
    );
    expect(Object.keys(bootstrap.profileManifestPaths).sort()).toEqual([
      "backup-writer",
      "maintenance",
      "migrator",
      "offline-recovery",
      "online",
      "transfer-destination",
      "transfer-source",
    ]);

    const online = await loadFileV1KeyProvider({
      manifestPath: bootstrap.profileManifestPaths.online,
      expectedLogicalHostId: logicalHostId,
      expectedStoreId: storeId,
      expectedProfile: "online",
    });
    expect(online.hasCapability("credential-verifier", "compute")).toBe(true);
    expect(online.hasCapability("backup-recovery", "unwrap")).toBe(false);
    expect(() =>
      online.decrypt("backup-recovery", 1, Buffer.alloc(1), Buffer.alloc(12), Buffer.alloc(16)),
    ).toThrow(/operation/i);

    const recovery = await loadFileV1KeyProvider({
      manifestPath: bootstrap.profileManifestPaths["offline-recovery"],
      expectedLogicalHostId: logicalHostId,
      expectedStoreId: storeId,
      expectedProfile: "offline-recovery",
    });
    expect(recovery.hasCapability("backup-recovery", "unwrap")).toBe(true);
    expect(recovery.hasCapability("credential-verifier", "verify")).toBe(false);

    const [backupWriter, transferSource, transferDestination] = await Promise.all([
      loadFileV1KeyProvider({
        manifestPath: bootstrap.profileManifestPaths["backup-writer"],
        expectedLogicalHostId: logicalHostId,
        expectedStoreId: storeId,
        expectedProfile: "backup-writer",
      }),
      loadFileV1KeyProvider({
        manifestPath: bootstrap.profileManifestPaths["transfer-source"],
        expectedLogicalHostId: logicalHostId,
        expectedStoreId: storeId,
        expectedProfile: "transfer-source",
      }),
      loadFileV1KeyProvider({
        manifestPath: bootstrap.profileManifestPaths["transfer-destination"],
        expectedLogicalHostId: logicalHostId,
        expectedStoreId: storeId,
        expectedProfile: "transfer-destination",
      }),
    ]);
    expect(backupWriter.hasCapability("backup-wrap", "wrap")).toBe(true);
    expect(backupWriter.hasCapability("backup-recovery", "unwrap")).toBe(false);
    expect(transferSource.hasCapability("transfer", "decrypt")).toBe(true);
    expect(transferSource.hasCapability("transfer", "encrypt")).toBe(false);
    expect(transferDestination.hasCapability("transfer", "encrypt")).toBe(true);
    expect(transferDestination.hasCapability("credential-verifier", "verify")).toBe(false);

    const verifier = online.compute("credential-verifier", Buffer.from("credential"));
    expect(
      online.verify(
        "credential-verifier",
        verifier.keyVersion,
        Buffer.from("credential"),
        verifier.bytes,
      ),
    ).toBe(true);
    expect(
      online.verify(
        "credential-verifier",
        verifier.keyVersion,
        Buffer.from("other"),
        verifier.bytes,
      ),
    ).toBe(false);

    const iv = randomBytes(12);
    const transfer = transferDestination.encrypt("transfer", Buffer.from("portable"), iv);
    expect(
      transferSource
        .decrypt(
          "transfer",
          transfer.keyVersion,
          transfer.ciphertext,
          iv,
          transfer.authenticationTag,
        )
        .toString(),
    ).toBe("portable");
    const wrapped = backupWriter.wrap("backup-wrap", Buffer.from("data-key"));
    expect(recovery.unwrap("backup-recovery", wrapped.keyVersion, wrapped.bytes).toString()).toBe(
      "data-key",
    );
    const maintenance = await loadFileV1KeyProvider({
      manifestPath: bootstrap.profileManifestPaths.maintenance,
      expectedLogicalHostId: logicalHostId,
      expectedStoreId: storeId,
      expectedProfile: "maintenance",
    });
    expect(fileV1CompatibilityCommitment(maintenance)).toEqual(
      fileV1CompatibilityCommitment(online),
    );
    expect(() => online.manifest.entries[0]!.operations.push("wrap")).toThrow();
  });

  it("requires explicit retirement evidence before bounding live profile versions", async () => {
    const root = stateRoot();
    const bootstrap = await bootstrapSqliteFileV1({ root, logicalHostId, storeId });
    const base = parseFileV1Manifest(readFileSync(bootstrap.inventoryManifestPath, "utf8"));
    const active = base.entries.find((entry) => entry.purpose === "active-record");
    const activeKey = base.compatibilityKeys.find((key) => key.purpose === "active-record");
    if (!active || !activeKey) throw new Error("active-record key missing");
    const addedEntries = [2, 3, 4].map((keyVersion) => ({
      ...active,
      keyId: `key_01J0000000000000000000000${keyVersion}`,
      keyVersion,
      file: `keys/active-record-v${keyVersion}.key`,
    }));
    const addedKeys = addedEntries.map((entry, index) => ({
      ...activeKey,
      keyId: entry.keyId,
      keyVersion: entry.keyVersion,
      commitment: `${index + 1}`.repeat(64),
    }));
    const compatibilityKeys = [
      ...base.compatibilityKeys.filter((key) => key !== activeKey),
      ...addedKeys,
    ];
    const inventory = {
      ...base,
      compatibilityKeys,
      compatibilityCommitment: fileV1CompatibilityManifestCommitment(compatibilityKeys),
      entries: [...base.entries, ...addedEntries],
    };

    expect(() => manifestForProfile(inventory, "online")).toThrow(/retirement evidence/i);
    expect(
      manifestForProfile(inventory, "online", {
        retiredVersions: { "active-record": [1] },
      }).entries.filter((entry) => entry.purpose === "active-record"),
    ).toHaveLength(3);
  });

  it("leaves no published manifest after a create fault and never replaces committed material", async () => {
    const root = stateRoot();
    await expect(
      bootstrapSqliteFileV1({ root, logicalHostId, storeId, faultAfterWrites: 3 }),
    ).rejects.toThrow(/injected/i);
    expect(existsSync(join(root, "key-provider"))).toBe(false);

    await expect(bootstrapSqliteFileV1({ root, logicalHostId, storeId })).rejects.toThrow(
      /fresh|partial/i,
    );

    const secondRoot = stateRoot();
    const bootstrap = await bootstrapSqliteFileV1({ root: secondRoot, logicalHostId, storeId });
    const before = readFileSync(bootstrap.inventoryManifestPath);
    await expect(
      bootstrapSqliteFileV1({ root: secondRoot, logicalHostId, storeId }),
    ).rejects.toThrow(/exists|fresh/i);
    expect(readFileSync(bootstrap.inventoryManifestPath)).toEqual(before);
  });

  it("rejects symlinked manifests, foreign bindings, rollback, algorithms, purposes, and key sizes", async () => {
    const root = stateRoot();
    const bootstrap = await bootstrapSqliteFileV1({ root, logicalHostId, storeId });
    const onlinePath = bootstrap.profileManifestPaths.online;
    const linkedPath = join(dirname(onlinePath), "linked.json");
    symlinkSync(onlinePath, linkedPath);

    await expect(
      loadFileV1KeyProvider({
        manifestPath: linkedPath,
        expectedLogicalHostId: logicalHostId,
        expectedStoreId: storeId,
        expectedProfile: "online",
      }),
    ).rejects.toThrow(/regular|symlink/i);

    const manifest = JSON.parse(readFileSync(onlinePath, "utf8")) as {
      version: number;
      generation: number;
      entries: Array<{ purpose: string; algorithm: string; file: string }>;
    };
    await expect(
      loadFileV1KeyProvider({
        manifestPath: onlinePath,
        expectedLogicalHostId: logicalHostId,
        expectedStoreId: "store_01J11111111111111111111111",
        expectedProfile: "online",
      }),
    ).rejects.toThrow(/binding/i);
    await expect(
      loadFileV1KeyProvider({
        manifestPath: onlinePath,
        expectedLogicalHostId: logicalHostId,
        expectedStoreId: storeId,
        expectedProfile: "online",
        minimumGeneration: manifest.generation + 1,
      }),
    ).rejects.toThrow(/rollback/i);

    const mutatedPath = join(dirname(onlinePath), "mutated.json");
    const mutated = structuredClone(manifest);
    mutated.entries[0]!.algorithm = "AES-128-GCM";
    writeFileSync(mutatedPath, JSON.stringify(mutated), { mode: 0o600 });
    await expect(
      loadFileV1KeyProvider({
        manifestPath: mutatedPath,
        expectedLogicalHostId: logicalHostId,
        expectedStoreId: storeId,
        expectedProfile: "online",
      }),
    ).rejects.toThrow(/algorithm/i);

    const unsupportedVersion = structuredClone(manifest);
    unsupportedVersion.version = 2;
    writeFileSync(mutatedPath, JSON.stringify(unsupportedVersion), { mode: 0o600 });
    await expect(
      loadFileV1KeyProvider({
        manifestPath: mutatedPath,
        expectedLogicalHostId: logicalHostId,
        expectedStoreId: storeId,
        expectedProfile: "online",
      }),
    ).rejects.toThrow(/version/i);

    const wrongPurpose = structuredClone(manifest);
    wrongPurpose.entries[0]!.purpose = "undeclared";
    writeFileSync(mutatedPath, JSON.stringify(wrongPurpose), { mode: 0o600 });
    await expect(
      loadFileV1KeyProvider({
        manifestPath: mutatedPath,
        expectedLogicalHostId: logicalHostId,
        expectedStoreId: storeId,
        expectedProfile: "online",
      }),
    ).rejects.toThrow(/purpose/i);

    const aliased = structuredClone(manifest);
    aliased.entries[1]!.file = aliased.entries[0]!.file;
    writeFileSync(mutatedPath, JSON.stringify(aliased), { mode: 0o600 });
    await expect(
      loadFileV1KeyProvider({
        manifestPath: mutatedPath,
        expectedLogicalHostId: logicalHostId,
        expectedStoreId: storeId,
        expectedProfile: "online",
      }),
    ).rejects.toThrow(/duplicate/i);

    const inventory = JSON.parse(readFileSync(bootstrap.inventoryManifestPath, "utf8")) as {
      entries: Array<{ purpose: string; file: string }>;
    };
    const backupManifest = JSON.parse(
      readFileSync(bootstrap.profileManifestPaths["backup-writer"], "utf8"),
    ) as typeof manifest;
    backupManifest.entries[0]!.file = inventory.entries.find(
      (entry) => entry.purpose === "backup-recovery",
    )!.file;
    writeFileSync(mutatedPath, JSON.stringify(backupManifest), { mode: 0o600 });
    await expect(
      loadFileV1KeyProvider({
        manifestPath: mutatedPath,
        expectedLogicalHostId: logicalHostId,
        expectedStoreId: storeId,
        expectedProfile: "backup-writer",
      }),
    ).rejects.toThrow(/private/i);

    const shortKeyPath = join(dirname(onlinePath), manifest.entries[0]!.file);
    writeFileSync(shortKeyPath, Buffer.alloc(16));
    chmodSync(shortKeyPath, 0o600);
    await expect(
      loadFileV1KeyProvider({
        manifestPath: onlinePath,
        expectedLogicalHostId: logicalHostId,
        expectedStoreId: storeId,
        expectedProfile: "online",
      }),
    ).rejects.toThrow(/size/i);
  });

  it("rejects foreign-owned key metadata through the bounded file seam", async () => {
    const root = stateRoot();
    const bootstrap = await bootstrapSqliteFileV1({ root, logicalHostId, storeId });
    const copy = join(dirname(bootstrap.inventoryManifestPath), "copy.json");
    cpSync(bootstrap.inventoryManifestPath, copy);
    chmodSync(copy, 0o600);

    await expect(
      loadFileV1KeyProvider({
        manifestPath: copy,
        expectedLogicalHostId: logicalHostId,
        expectedStoreId: storeId,
        expectedProfile: "inventory",
        expectedUid: process.getuid!() + 1,
      }),
    ).rejects.toThrow(/owner/i);
  });
});
