import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHostStorage } from "../src/storage";
import { VaultValueStore } from "../src/storage/vault-values";
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

      await expect(
        first.set("API_TOKEN", plaintext, {
          expectedGeneration: 0,
          operatorClientId: "operator-1",
          now: new Date("2026-07-18T10:00:00.000Z"),
        }),
      ).resolves.toEqual({
        key: "API_TOKEN",
        present: true,
        generation: 1,
        valueBytes: Buffer.byteLength(plaintext),
        createdAt: "2026-07-18T10:00:00.000Z",
        updatedAt: "2026-07-18T10:00:00.000Z",
      });

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

      await expect(
        second.set("API_TOKEN", rotatedPlaintext, {
          force: true,
          expectedGeneration: 1,
          operatorClientId: "operator-2",
          now: new Date("2026-07-18T10:01:00.000Z"),
        }),
      ).resolves.toMatchObject({
        key: "API_TOKEN",
        present: true,
        generation: 2,
        createdAt: "2026-07-18T10:00:00.000Z",
        updatedAt: "2026-07-18T10:01:00.000Z",
      });
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
});
