import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHostStorage } from "../src/storage";
import {
  prepareVaultValueSet,
  setPreparedVaultValueSqlite,
  VaultValueStore,
} from "../src/storage/vault-values";
import { operatorActivity, vaultValues } from "../src/storage/schema/sqlite";
import { VAULT_MAX_VALUE_BYTES } from "../src/vault";

describe("VaultValueStore", () => {
  it("keeps encrypted Vault values coherent, secret-safe, and fail-closed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-vault-values-"));
    const databasePath = join(directory, "caplets.sqlite3");
    const env = {
      CAPLETS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
    };
    const firstStorage = await createHostStorage({ type: "sqlite", path: databasePath });
    if (firstStorage.database.dialect !== "sqlite") throw new Error("Expected SQLite storage");
    const first = new VaultValueStore(firstStorage.database, { env });
    const second = new VaultValueStore(firstStorage.database, { env });
    const plaintext = "plain-text-vault-secret";
    const rotatedPlaintext = "rotated-vault-secret";

    try {
      await expect(first.getStatus("API_TOKEN")).resolves.toEqual({
        key: "API_TOKEN",
        present: false,
      });
      await expect(first.getStatus("invalid-name")).rejects.toMatchObject({
        code: "REQUEST_INVALID",
      });
      await expect(
        first.set("TOO_LARGE", "x".repeat(VAULT_MAX_VALUE_BYTES + 1)),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
      });

      const firstStatus = await first.set("API_TOKEN", plaintext, {
        expectedGeneration: 0,
        operatorClientId: "operator-1",
      });
      expect(firstStatus).toMatchObject({
        key: "API_TOKEN",
        present: true,
        generation: 1,
        valueBytes: Buffer.byteLength(plaintext),
      });
      expect(firstStatus.createdAt).toBe(firstStatus.updatedAt);

      const persisted = firstStorage.database.db.select().from(vaultValues).get();
      expect(persisted).toMatchObject({ vaultKey: "API_TOKEN", generation: 1 });
      expect(JSON.stringify(persisted)).not.toContain(plaintext);
      expect(persisted).not.toHaveProperty("value");

      await expect(second.resolveValue("API_TOKEN")).resolves.toBe(plaintext);
      await expect(second.getStatus("API_TOKEN")).resolves.toMatchObject({
        key: "API_TOKEN",
        present: true,
        generation: 1,
      });
      await expect(second.set("API_TOKEN", "collision-secret")).rejects.toMatchObject({
        code: "CONFIG_EXISTS",
      });
      await expect(second.resolveValue("API_TOKEN")).resolves.toBe(plaintext);

      const rotatedStatus = await second.set("API_TOKEN", rotatedPlaintext, {
        force: true,
        expectedGeneration: 1,
        operatorClientId: "operator-2",
      });
      expect(rotatedStatus).toMatchObject({
        key: "API_TOKEN",
        present: true,
        generation: 2,
        createdAt: firstStatus.createdAt,
      });
      expect(rotatedStatus.updatedAt >= firstStatus.updatedAt).toBe(true);
      await expect(
        first.set("API_TOKEN", "stale-secret", { force: true, expectedGeneration: 1 }),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
        details: {
          kind: "stale_generation",
          expectedGeneration: 1,
          currentGeneration: 2,
        },
      });
      await expect(first.resolveValue("API_TOKEN")).resolves.toBe(rotatedPlaintext);

      await first.set("ANOTHER_TOKEN", "another-secret", { expectedGeneration: 0 });
      await expect(second.listValues()).resolves.toEqual([
        expect.objectContaining({ key: "ANOTHER_TOKEN", present: true, generation: 1 }),
        expect.objectContaining({ key: "API_TOKEN", present: true, generation: 2 }),
      ]);

      await expect(
        second.delete("API_TOKEN", {
          expectedGeneration: 1,
          operatorClientId: "operator-2",
        }),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
        details: {
          kind: "stale_generation",
          expectedGeneration: 1,
          currentGeneration: 2,
        },
      });
      await expect(first.resolveValue("API_TOKEN")).resolves.toBe(rotatedPlaintext);

      await expect(
        second.delete("API_TOKEN", {
          expectedGeneration: 2,
          operatorClientId: "operator-2",
        }),
      ).resolves.toEqual({ key: "API_TOKEN", deleted: true, generation: 2 });
      await expect(first.getStatus("API_TOKEN")).resolves.toEqual({
        key: "API_TOKEN",
        present: false,
      });
      await expect(first.delete("API_TOKEN", { expectedGeneration: 0 })).resolves.toEqual({
        key: "API_TOKEN",
        deleted: false,
      });
      await expect(first.resolveValue("API_TOKEN")).rejects.toMatchObject({
        code: "CONFIG_INVALID",
      });

      firstStorage.database.db
        .insert(vaultValues)
        .values({
          vaultKey: "BROKEN_TOKEN",
          generation: 1,
          version: 1,
          algorithm: "aes-256-gcm",
          nonce: "not-valid-base64url!",
          ciphertext: plaintext,
          authTag: "invalid",
          valueBytes: plaintext.length,
          createdAt: "not-a-date",
          updatedAt: "not-a-date",
        })
        .run();
      await expect(second.getStatus("BROKEN_TOKEN")).rejects.toMatchObject({
        code: "CONFIG_INVALID",
      });
      await expect(second.resolveValue("BROKEN_TOKEN")).rejects.toMatchObject({
        code: "CONFIG_INVALID",
      });
      await expect(second.listValues()).rejects.toMatchObject({ code: "CONFIG_INVALID" });

      const activity = firstStorage.database.db.select().from(operatorActivity).all();
      expect(activity.map(({ action, metadata }) => ({ action, metadata }))).toEqual([
        { action: "vault_value_written", metadata: { generation: 1 } },
        { action: "vault_value_written", metadata: { generation: 2 } },
        { action: "vault_value_deleted", metadata: { generation: 2 } },
      ]);
      const activityPayload = JSON.stringify(activity);
      for (const secret of [plaintext, rotatedPlaintext, "collision-secret", "stale-secret"]) {
        expect(activityPayload).not.toContain(secret);
      }
    } finally {
      await firstStorage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("timestamps forced writers in serialization order rather than preparation order", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-vault-value-ordering-"));
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(directory, "caplets.sqlite3"),
    });
    if (storage.database.dialect !== "sqlite") throw new Error("Expected SQLite storage");
    const options = {
      env: { CAPLETS_ENCRYPTION_KEY: Buffer.alloc(32, 31).toString("base64url") },
    };
    const values = new VaultValueStore(storage.database, options);
    vi.useFakeTimers();

    try {
      vi.setSystemTime(new Date("2026-07-18T10:00:00.000Z"));
      const preparedFirst = prepareVaultValueSet(
        "ORDERED_SECRET",
        "prepared-first",
        { force: true, operatorClientId: "operator-first" },
        options,
      );
      vi.setSystemTime(new Date("2026-07-18T10:01:00.000Z"));
      const preparedSecond = prepareVaultValueSet(
        "ORDERED_SECRET",
        "prepared-second",
        { force: true, operatorClientId: "operator-second" },
        options,
      );

      vi.setSystemTime(new Date("2026-07-18T10:02:00.000Z"));
      const serializedFirst = storage.database.db.transaction(
        (transaction) => setPreparedVaultValueSqlite(transaction, preparedSecond),
        { behavior: "immediate" },
      );
      vi.setSystemTime(new Date("2026-07-18T10:03:00.000Z"));
      const serializedSecond = storage.database.db.transaction(
        (transaction) => setPreparedVaultValueSqlite(transaction, preparedFirst),
        { behavior: "immediate" },
      );

      expect(serializedFirst).toMatchObject({
        generation: 1,
        createdAt: "2026-07-18T10:02:00.000Z",
        updatedAt: "2026-07-18T10:02:00.000Z",
      });
      expect(serializedSecond).toMatchObject({
        generation: 2,
        createdAt: "2026-07-18T10:02:00.000Z",
        updatedAt: "2026-07-18T10:03:00.000Z",
      });
      await expect(values.getStatus("ORDERED_SECRET")).resolves.toEqual(serializedSecond);
      await expect(values.resolveValue("ORDERED_SECRET")).resolves.toBe("prepared-first");

      const activity = storage.database.db.select().from(operatorActivity).all();
      expect(
        activity
          .map((entry) => ({
            actor: entry.operatorClientId,
            timestamp: entry.createdAt,
          }))
          .sort((left, right) => left.actor.localeCompare(right.actor)),
      ).toEqual([
        {
          actor: "operator-first",
          timestamp: "2026-07-18T10:03:00.000Z",
        },
        {
          actor: "operator-second",
          timestamp: "2026-07-18T10:02:00.000Z",
        },
      ]);
    } finally {
      vi.useRealTimers();
      await storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("derives host runtime parity with the Vault encryption key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-runtime-fingerprint-"));
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(directory, "caplets.sqlite3"),
    });
    const firstKey = Buffer.alloc(32, 1);
    const secondKey = Buffer.alloc(32, 2);
    const first = new VaultValueStore(storage.database, {
      env: { CAPLETS_ENCRYPTION_KEY: firstKey.toString("base64url") },
    });
    const sameKey = new VaultValueStore(storage.database, {
      env: { CAPLETS_ENCRYPTION_KEY: firstKey.toString("base64url") },
    });
    const rotatedKey = new VaultValueStore(storage.database, {
      env: { CAPLETS_ENCRYPTION_KEY: secondKey.toString("base64url") },
    });
    const hostConfigurationFingerprint = "low-entropy-runtime-shape";

    try {
      const fingerprint = first.hostRuntimeFingerprint(hostConfigurationFingerprint);
      const expected = createHmac("sha256", firstKey)
        .update("caplets-host-runtime-fingerprint-v1")
        .update("\0")
        .update(hostConfigurationFingerprint)
        .digest("hex");

      expect(fingerprint).toBe(`hmac-sha256:${expected}`);
      expect(sameKey.hostRuntimeFingerprint(hostConfigurationFingerprint)).toBe(fingerprint);
      expect(rotatedKey.hostRuntimeFingerprint(hostConfigurationFingerprint)).not.toBe(fingerprint);
      expect(first.hostRuntimeFingerprint("changed-runtime-shape")).not.toBe(fingerprint);
      expect(fingerprint).not.toContain(hostConfigurationFingerprint);
    } finally {
      await storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
