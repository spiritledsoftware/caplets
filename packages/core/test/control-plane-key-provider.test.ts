import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootstrapSqliteFileV1,
  computeFileV1ShortCodeVerifier,
  fileV1AssociatedData,
  fileV1TransferAssociatedData,
  hashFileV1HighEntropyVerifier,
  loadFileV1KeyProvider,
  type FileV1KeyProvider,
  verifyFileV1ShortCode,
} from "../src/control-plane/key-provider/file-v1";
import {
  FILE_V1_PROFILE_CAPABILITIES,
  FILE_V1_PURPOSES,
  type FileV1Operation,
  type FileV1Profile,
  type FileV1Purpose,
} from "../src/control-plane/key-provider/manifest";
import { assertSqlVaultKeyProvider } from "../src/vault/keys";

const logicalHostId = "host_01J00000000000000000000000";
const storeId = "store_01J00000000000000000000000";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function providers() {
  const parent = await mkdtemp(join(tmpdir(), "caplets-u6-provider-"));
  roots.push(parent);
  const bootstrap = await bootstrapSqliteFileV1({
    root: join(parent, "state"),
    logicalHostId,
    storeId,
  });
  const load = (profile: keyof typeof bootstrap.profileManifestPaths) =>
    loadFileV1KeyProvider({
      manifestPath: bootstrap.profileManifestPaths[profile],
      expectedLogicalHostId: logicalHostId,
      expectedStoreId: storeId,
      expectedProfile: profile,
    });
  const [
    online,
    migrator,
    backupWriter,
    offlineRecovery,
    maintenance,
    transferSource,
    transferDestination,
  ] = await Promise.all([
    load("online"),
    load("migrator"),
    load("backup-writer"),
    load("offline-recovery"),
    load("maintenance"),
    load("transfer-source"),
    load("transfer-destination"),
  ]);
  return {
    bootstrap,
    online,
    migrator,
    backupWriter,
    offlineRecovery,
    maintenance,
    transferSource,
    transferDestination,
  };
}

const fileV1Operations: readonly FileV1Operation[] = [
  "encrypt",
  "decrypt",
  "compute",
  "verify",
  "wrap",
  "unwrap",
];

function invokeForbidden(
  provider: FileV1KeyProvider,
  purpose: FileV1Purpose,
  operation: FileV1Operation,
): void {
  const bytes = Buffer.alloc(32);
  const nonce = Buffer.alloc(12);
  const authTag = Buffer.alloc(16);
  switch (operation) {
    case "encrypt":
      provider.encrypt(purpose, bytes, nonce);
      return;
    case "decrypt":
      provider.decrypt(purpose, 1, bytes, nonce, authTag);
      return;
    case "compute":
      provider.compute(purpose, bytes);
      return;
    case "verify":
      provider.verify(purpose, 1, bytes, bytes);
      return;
    case "wrap":
      provider.wrap(purpose, bytes);
      return;
    case "unwrap":
      provider.unwrap(purpose, 1, bytes);
  }
}

describe("control-plane file-v1 enforcement", () => {
  it("binds encryption and both verifier classes to store, purpose, record, and key version", async () => {
    const test = await providers();
    assertSqlVaultKeyProvider(test.online, { logicalHostId, storeId });
    expect(() =>
      assertSqlVaultKeyProvider(test.online, {
        logicalHostId,
        storeId: "store_01J00000000000000000000001",
      }),
    ).toThrow(/online file-v1/u);
    const sentinel = "u6-file-v1-sentinel-0123456789abcdef";
    const binding = {
      logicalHostId,
      storeId,
      purpose: "active-record" as const,
      recordId: "oauth-token:u6",
    };
    const nonce = randomBytes(12);
    const encrypted = test.online.encrypt(
      "active-record",
      Buffer.from(sentinel),
      nonce,
      fileV1AssociatedData(binding),
    );
    expect(
      test.online
        .decrypt(
          "active-record",
          encrypted.keyVersion,
          encrypted.ciphertext,
          nonce,
          encrypted.authenticationTag,
          fileV1AssociatedData(binding),
        )
        .toString(),
    ).toBe(sentinel);
    expect(() =>
      test.online.decrypt(
        "active-record",
        encrypted.keyVersion,
        encrypted.ciphertext,
        nonce,
        encrypted.authenticationTag,
        fileV1AssociatedData({ ...binding, storeId: "store_01J00000000000000000000001" }),
      ),
    ).toThrow();
    expect(() =>
      test.online.decrypt(
        "vault-record",
        encrypted.keyVersion,
        encrypted.ciphertext,
        nonce,
        encrypted.authenticationTag,
        fileV1AssociatedData({ ...binding, purpose: "vault-record", recordId: "vault:u6" }),
      ),
    ).toThrow();

    const highEntropy = hashFileV1HighEntropyVerifier({
      logicalHostId,
      storeId,
      purpose: "credential-verifier",
      recordId: "remote-refresh:u6",
      secret: sentinel,
    });
    expect(highEntropy.includes(Buffer.from(sentinel))).toBe(false);
    expect(highEntropy).not.toEqual(
      hashFileV1HighEntropyVerifier({
        logicalHostId,
        storeId: "store_01J00000000000000000000001",
        purpose: "credential-verifier",
        recordId: "remote-refresh:u6",
        secret: sentinel,
      }),
    );

    const shortCode = computeFileV1ShortCodeVerifier(test.online, {
      logicalHostId,
      storeId,
      purpose: "credential-verifier",
      recordId: "pending-approval:u6",
      code: "A1B2C3D4",
    });
    expect(shortCode).toMatchObject({ algorithm: "HMAC-SHA-256", verifierVersion: 1 });
    expect(
      verifyFileV1ShortCode(test.online, {
        logicalHostId,
        storeId,
        purpose: "credential-verifier",
        recordId: "pending-approval:u6",
        code: "A1B2C3D4",
        keyVersion: shortCode.keyVersion,
        expected: shortCode.bytes,
      }),
    ).toBe(true);
    expect(
      verifyFileV1ShortCode(test.online, {
        logicalHostId,
        storeId,
        purpose: "credential-verifier",
        recordId: "pending-approval:other",
        code: "A1B2C3D4",
        keyVersion: shortCode.keyVersion,
        expected: shortCode.bytes,
      }),
    ).toBe(false);
    expect(await readFile(test.bootstrap.profileManifestPaths.online, "utf8")).not.toContain(
      sentinel,
    );
  });

  it("enforces online, backup, offline-recovery, maintenance, and transfer capability boundaries", async () => {
    const test = await providers();
    const profileProviders = [
      ["online", test.online],
      ["migrator", test.migrator],
      ["maintenance", test.maintenance],
      ["backup-writer", test.backupWriter],
      ["offline-recovery", test.offlineRecovery],
      ["transfer-source", test.transferSource],
      ["transfer-destination", test.transferDestination],
    ] as const satisfies readonly (readonly [
      Exclude<FileV1Profile, "inventory">,
      FileV1KeyProvider,
    ])[];
    for (const [profile, provider] of profileProviders) {
      const capabilities = FILE_V1_PROFILE_CAPABILITIES[profile];
      for (const purpose of FILE_V1_PURPOSES) {
        for (const operation of fileV1Operations) {
          const allowed = capabilities.some(
            (capability) =>
              capability.purpose === purpose && capability.operations.includes(operation),
          );
          expect(
            provider.hasCapability(purpose, operation),
            `${profile}:${purpose}:${operation}`,
          ).toBe(allowed);
          if (!allowed) {
            expect(
              () => invokeForbidden(provider, purpose, operation),
              `${profile}:${purpose}:${operation}`,
            ).toThrow(/operation/u);
          }
        }
      }
    }
    expect(test.online.hasCapability("backup-recovery", "unwrap")).toBe(false);
    expect(test.backupWriter.hasCapability("active-record", "encrypt")).toBe(false);
    expect(test.offlineRecovery.hasCapability("active-record", "decrypt")).toBe(false);
    expect(test.maintenance.manifest.entries).toEqual([]);
    expect(test.transferSource.hasCapability("credential-verifier", "verify")).toBe(false);
    expect(test.transferDestination.hasCapability("recovery-checkpoint", "compute")).toBe(false);

    expect(() => test.online.unwrap("backup-recovery", 1, Buffer.alloc(32))).toThrow(/operation/u);
    expect(() =>
      test.backupWriter.encrypt("active-record", Buffer.alloc(1), Buffer.alloc(12)),
    ).toThrow(/operation/u);
    expect(() =>
      test.offlineRecovery.decrypt(
        "active-record",
        1,
        Buffer.alloc(1),
        Buffer.alloc(12),
        Buffer.alloc(16),
      ),
    ).toThrow(/operation/u);
    expect(() => test.maintenance.compute("credential-verifier", Buffer.alloc(1))).toThrow(
      /operation/u,
    );
    expect(() =>
      test.transferSource.verify("credential-verifier", 1, Buffer.alloc(1), Buffer.alloc(32)),
    ).toThrow(/operation/u);
    expect(() => test.transferSource.compute("recovery-checkpoint", Buffer.alloc(1))).toThrow(
      /operation/u,
    );
    expect(() => test.transferDestination.compute("credential-verifier", Buffer.alloc(1))).toThrow(
      /operation/u,
    );

    const portable = Buffer.from("portable-u6");
    const nonce = randomBytes(12);
    const transferBinding = fileV1TransferAssociatedData({
      logicalHostId,
      storeId,
      transferId: "transfer_01J00000000000000000000000",
      direction: "source-to-destination",
      recordId: "portable-caplet:u6",
    });
    const transferred = test.transferDestination.encrypt(
      "transfer",
      portable,
      nonce,
      transferBinding,
    );
    expect(
      test.transferSource
        .decrypt(
          "transfer",
          transferred.keyVersion,
          transferred.ciphertext,
          nonce,
          transferred.authenticationTag,
          transferBinding,
        )
        .toString(),
    ).toBe("portable-u6");
    expect(() =>
      test.transferSource.decrypt(
        "transfer",
        transferred.keyVersion,
        transferred.ciphertext,
        nonce,
        transferred.authenticationTag,
        fileV1TransferAssociatedData({
          logicalHostId,
          storeId,
          transferId: "transfer_01J00000000000000000000001",
          direction: "source-to-destination",
          recordId: "portable-caplet:u6",
        }),
      ),
    ).toThrow();
    expect(() => test.transferSource.encrypt("transfer", portable, nonce)).toThrow(/operation/u);
    expect(() =>
      test.transferDestination.decrypt(
        "transfer",
        transferred.keyVersion,
        transferred.ciphertext,
        nonce,
        transferred.authenticationTag,
      ),
    ).toThrow(/operation/u);

    const wrapped = test.backupWriter.wrap("backup-wrap", Buffer.from("backup-key-u6"));
    expect(
      test.offlineRecovery.unwrap("backup-recovery", wrapped.keyVersion, wrapped.bytes).toString(),
    ).toBe("backup-key-u6");
    expect(() =>
      test.backupWriter.unwrap("backup-recovery", wrapped.keyVersion, wrapped.bytes),
    ).toThrow(/operation/u);
    expect(() => test.online.unwrap("backup-recovery", wrapped.keyVersion, wrapped.bytes)).toThrow(
      /operation/u,
    );
    expect(() =>
      assertSqlVaultKeyProvider(test.offlineRecovery, { logicalHostId, storeId }),
    ).toThrow(/online file-v1/u);
    await expect(
      loadFileV1KeyProvider({
        manifestPath: test.bootstrap.profileManifestPaths.online,
        expectedLogicalHostId: logicalHostId,
        expectedStoreId: storeId,
        expectedProfile: "migrator",
      }),
    ).rejects.toThrow(/profile/u);
  });
});
