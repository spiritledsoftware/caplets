import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHostStorage, createHostStorageVaultResolver } from "../src/storage";
import { operatorActivity } from "../src/storage/schema/sqlite";

const operator = { clientId: "operator-1", role: "operator" } as const;

function capletDocument(): Buffer {
  return Buffer.from(`---
name: Shared
description: Shared fixture.
mcpServer:
  command: shared-mcp
  env:
    TOKEN: \${vault.TOKEN}
---
# Shared
`);
}

describe("VaultGrantStore", () => {
  it("isolates record and filesystem grants by immutable subject and exact active origin", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-vault-grants-"));
    const firstPath = join(directory, "global", "shared", "CAPLET.md");
    const secondPath = join(directory, "project", "shared", "CAPLET.md");
    const storage = await createHostStorage(
      { type: "sqlite", path: join(directory, "caplets.sqlite3") },
      { vaultRoot: join(directory, "vault") },
    );

    try {
      await storage.caplets.importBundle({
        id: "shared",
        operator,
        files: [{ path: "CAPLET.md", content: capletDocument(), executable: false }],
      });
      await storage.vaultValues.set("RECORD_TOKEN", "record-secret");
      await storage.vaultValues.set("FILE_TOKEN", "file-secret");
      await storage.vaultValues.set("ROTATED_FILE_TOKEN", "rotated-file-secret");

      await storage.vaultGrants.grant({
        capletId: "shared",
        vaultKey: "RECORD_TOKEN",
        referenceName: "TOKEN",
        originKind: "stored-record",
        operator,
      });
      await storage.vaultGrants.grant({
        capletId: "shared",
        vaultKey: "FILE_TOKEN",
        referenceName: "TOKEN",
        originKind: "global-file",
        originPath: firstPath,
        operator,
      });
      await storage.vaultGrants.grant({
        capletId: "shared",
        vaultKey: "FILE_TOKEN",
        referenceName: "TOKEN",
        originKind: "project-file",
        originPath: secondPath,
        operator,
      });

      const initialGrants = await storage.vaultGrants.list("shared");
      expect(initialGrants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            subjectKind: "record",
            recordKey: (await storage.caplets.get("shared"))?.recordKey,
            capletId: "shared",
            vaultKey: "RECORD_TOKEN",
            referenceName: "TOKEN",
          }),
          expect.objectContaining({
            subjectKind: "file",
            recordKey: null,
            capletId: "shared",
            originKind: "global-file",
            originPath: firstPath,
          }),
          expect.objectContaining({
            subjectKind: "file",
            recordKey: null,
            capletId: "shared",
            originKind: "project-file",
            originPath: secondPath,
          }),
        ]),
      );

      let resolver = await createHostStorageVaultResolver(storage);
      expect(
        resolver({
          capletId: "shared",
          referenceName: "TOKEN",
          origin: { kind: "stored-record", path: "sql:shared" },
          path: "mcpServers.shared.env.TOKEN",
        }),
      ).toEqual({ storedKey: "RECORD_TOKEN", value: "record-secret" });
      expect(
        resolver({
          capletId: "shared",
          referenceName: "TOKEN",
          origin: { kind: "global-file", path: firstPath },
          path: "mcpServers.shared.env.TOKEN",
        }),
      ).toEqual({ storedKey: "FILE_TOKEN", value: "file-secret" });
      expect(
        resolver({
          capletId: "shared",
          referenceName: "TOKEN",
          origin: { kind: "global-file", path: secondPath },
          path: "mcpServers.shared.env.TOKEN",
        }),
      ).toMatchObject({ reason: "ungranted" });
      expect(
        resolver({
          capletId: "shared",
          referenceName: "TOKEN",
          origin: { kind: "project-file", path: firstPath },
          path: "mcpServers.shared.env.TOKEN",
        }),
      ).toMatchObject({ reason: "ungranted" });

      await storage.vaultGrants.grant({
        capletId: "shared",
        vaultKey: "ROTATED_FILE_TOKEN",
        referenceName: "TOKEN",
        originKind: "global-file",
        originPath: firstPath,
        operator,
      });
      expect(
        (await storage.vaultGrants.list("shared")).filter(
          (grant) => grant.originKind === "global-file" && grant.originPath === firstPath,
        ),
      ).toEqual([
        expect.objectContaining({ vaultKey: "ROTATED_FILE_TOKEN", referenceName: "TOKEN" }),
      ]);

      const renamed = await storage.caplets.rename({
        id: "shared",
        newId: "renamed",
        expectedGeneration: 1,
        operator,
      });
      expect(await storage.vaultGrants.list("renamed")).toEqual([
        expect.objectContaining({ subjectKind: "record", vaultKey: "RECORD_TOKEN" }),
      ]);
      resolver = await createHostStorageVaultResolver(storage);
      expect(
        resolver({
          capletId: "renamed",
          referenceName: "TOKEN",
          origin: { kind: "stored-record", path: "sql:renamed" },
          path: "mcpServers.renamed.env.TOKEN",
        }),
      ).toEqual({ storedKey: "RECORD_TOKEN", value: "record-secret" });
      expect(
        resolver({
          capletId: "renamed",
          referenceName: "TOKEN",
          origin: { kind: "global-file", path: firstPath },
          path: "mcpServers.renamed.env.TOKEN",
        }),
      ).toMatchObject({ reason: "ungranted" });

      await storage.caplets.hardDelete({
        id: "renamed",
        expectedGeneration: renamed.headGeneration,
        operator,
      });
      await storage.caplets.importBundle({
        id: "renamed",
        operator,
        files: [{ path: "CAPLET.md", content: capletDocument(), executable: false }],
      });
      expect(await storage.vaultGrants.list("renamed")).toEqual([]);

      await expect(
        storage.vaultGrants.revoke({
          capletId: "shared",
          vaultKey: "ROTATED_FILE_TOKEN",
          referenceName: "TOKEN",
          originKind: "global-file",
          originPath: firstPath,
          operator,
        }),
      ).resolves.toBe(true);
      expect(await storage.vaultGrants.list("shared")).toEqual([
        expect.objectContaining({ originKind: "project-file", originPath: secondPath }),
      ]);

      if (storage.database.dialect !== "sqlite") throw new Error("Expected SQLite storage");
      const activities = storage.database.db
        .select()
        .from(operatorActivity)
        .all()
        .filter((entry) => entry.targetKind === "vault_grant");
      expect(activities).toHaveLength(5);
      const activityPayload = JSON.stringify(activities);
      expect(activityPayload).not.toContain(firstPath);
      expect(activityPayload).not.toContain(secondPath);
      expect(activityPayload).not.toContain("record-secret");
      expect(activityPayload).not.toContain("file-secret");
      expect(activityPayload).not.toContain("rotated-file-secret");
    } finally {
      await storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
