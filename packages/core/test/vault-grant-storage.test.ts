import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createHostStorage,
  createHostStorageVaultResolver,
  migrateHostStorage,
  type HostStorage,
} from "../src/storage";
import { operatorActivity } from "../src/storage/schema/sqlite";

const operator = { clientId: "operator-1", role: "operator" } as const;
const postgresUrl = process.env.CAPLETS_TEST_POSTGRES_URL;
if (process.env.CAPLETS_REQUIRE_TEST_POSTGRES === "1" && !postgresUrl) {
  throw new Error("CAPLETS_TEST_POSTGRES_URL is required when CAPLETS_REQUIRE_TEST_POSTGRES=1.");
}
const postgresIt = postgresUrl ? it : it.skip;

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
      const activities = (await storage.database.db.select().from(operatorActivity).all()).filter(
        (entry) => entry.targetKind === "vault_grant",
      );
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
  it("uses opaque grant versions to reject stale revoke after delete and recreate", async () => {
    const storage = await createHostStorage({ type: "sqlite", path: ":memory:" });
    const input = {
      capletId: "shared",
      vaultKey: "TOKEN",
      referenceName: "TOKEN",
      originKind: "global-file" as const,
      originPath: "/global/shared/CAPLET.md",
      operator,
    };
    try {
      const firstVersion = await storage.vaultGrants.grant({ ...input, createOnly: true });
      expect(firstVersion).toEqual(expect.any(String));
      expect(firstVersion).not.toContain(input.vaultKey);
      expect(await storage.vaultGrants.list("shared")).toEqual([
        expect.objectContaining({ resourceVersion: firstVersion }),
      ]);

      await expect(storage.vaultGrants.grant({ ...input, createOnly: true })).rejects.toMatchObject(
        { code: "CONFIG_EXISTS" },
      );

      await expect(
        storage.vaultGrants.grant({
          ...input,
          expectedResourceVersion: "stale-resource-version",
        }),
      ).rejects.toMatchObject({
        details: {
          kind: "stale_generation",
          expectedResourceVersion: "stale-resource-version",
        },
      });
      const replacementVersion = await storage.vaultGrants.grant({
        ...input,
        expectedResourceVersion: firstVersion,
      });
      expect(replacementVersion).not.toBe(firstVersion);
      expect(await storage.vaultGrants.list("shared")).toEqual([
        expect.objectContaining({ resourceVersion: replacementVersion }),
      ]);

      await expect(
        storage.vaultGrants.revoke({
          ...input,
          expectedResourceVersion: "stale-resource-version",
        }),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
        details: {
          kind: "stale_generation",
          expectedResourceVersion: "stale-resource-version",
        },
      });
      expect(await storage.vaultGrants.list("shared")).toEqual([
        expect.objectContaining({ resourceVersion: replacementVersion }),
      ]);

      await expect(
        storage.vaultGrants.revoke({ ...input, expectedResourceVersion: replacementVersion }),
      ).resolves.toBe(true);
      const recreatedVersion = await storage.vaultGrants.grant(input);
      expect(recreatedVersion).not.toBe(replacementVersion);

      await expect(
        storage.vaultGrants.revoke({ ...input, expectedResourceVersion: replacementVersion }),
      ).rejects.toMatchObject({
        details: { kind: "stale_generation", expectedResourceVersion: replacementVersion },
      });
      expect(await storage.vaultGrants.list("shared")).toEqual([
        expect.objectContaining({ resourceVersion: recreatedVersion }),
      ]);
    } finally {
      await storage.close();
    }
  });

  it("traverses and filters Vault grants in bounded composite-key pages", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-vault-grant-pages-"));
    const storage = await createHostStorage(
      { type: "sqlite", path: join(directory, "caplets.sqlite3") },
      { vaultRoot: join(directory, "vault") },
    );

    try {
      for (const id of ["alpha", "Beta"]) {
        await storage.caplets.importBundle({
          id,
          operator,
          files: [{ path: "CAPLET.md", content: capletDocument(), executable: false }],
        });
      }
      for (const key of ["ALPHA_TOKEN", "BETA_TOKEN", "FILTER_TOKEN"]) {
        await storage.vaultValues.set(key, `${key}-secret`);
      }
      const grants = [
        {
          capletId: "alpha",
          vaultKey: "ALPHA_TOKEN",
          referenceName: "a_file",
          originKind: "global-file" as const,
          originPath: "/alpha/CAPLET.md",
          operator,
        },
        {
          capletId: "alpha",
          vaultKey: "FILTER_TOKEN",
          referenceName: "Z_FILE",
          originKind: "global-file" as const,
          originPath: "/alpha/CAPLET.md",
          operator,
        },
        {
          capletId: "Beta",
          vaultKey: "FILTER_TOKEN",
          referenceName: "FILE_C",
          originKind: "project-file" as const,
          originPath: "/Beta/CAPLET.md",
          operator,
        },
        {
          capletId: "alpha",
          vaultKey: "FILTER_TOKEN",
          referenceName: "record_a",
          originKind: "stored-record" as const,
          operator,
        },
        {
          capletId: "alpha",
          vaultKey: "BETA_TOKEN",
          referenceName: "RECORD_B",
          originKind: "stored-record" as const,
          operator,
        },
        {
          capletId: "Beta",
          vaultKey: "FILTER_TOKEN",
          referenceName: "RECORD_C",
          originKind: "stored-record" as const,
          operator,
        },
      ];
      for (const grant of grants.reverse()) await storage.vaultGrants.grant(grant);
      await expect(storage.vaultGrants.countByVaultKey("FILTER_TOKEN")).resolves.toBe(4);
      await expect(storage.vaultGrants.countByVaultKey("MISSING_TOKEN")).resolves.toBe(0);
      await expect(
        storage.vaultGrants.get({
          capletId: "alpha",
          vaultKey: "FILTER_TOKEN",
          referenceName: "Z_FILE",
          originKind: "global-file",
          originPath: "/alpha/CAPLET.md",
        }),
      ).resolves.toMatchObject({
        capletId: "alpha",
        vaultKey: "FILTER_TOKEN",
        referenceName: "Z_FILE",
      });
      await expect(
        storage.vaultGrants.get({
          capletId: "alpha",
          vaultKey: "FILTER_TOKEN",
          referenceName: "Z_FILE",
          originKind: "global-file",
          originPath: "/wrong/CAPLET.md",
        }),
      ).resolves.toBeUndefined();
      await expect(
        storage.vaultGrants.listMatching({
          capletId: "alpha",
          vaultKey: "FILTER_TOKEN",
          referenceName: "record_a",
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          subjectKind: "record",
          capletId: "alpha",
          referenceName: "record_a",
        }),
      ]);

      const traverse = async (
        filters: {
          vaultKey?: string;
          capletId?: string;
          sort?: "asc" | "desc";
          activeOrigins?: readonly {
            capletId: string;
            originKind: "stored-record" | "global-file" | "project-file";
            originPath?: string;
          }[];
        } = {},
        limit = 2,
      ) => {
        const items = [];
        let after:
          | {
              subjectKind: "record" | "file";
              subjectKey: string;
              referenceName: string;
            }
          | undefined;
        do {
          const page = await storage.vaultGrants.listPage({ ...filters, limit, after });
          items.push(...page.items);
          after = page.nextKey;
        } while (after !== undefined);
        return items;
      };
      const identity = (grant: { capletId: string; referenceName: string; vaultKey: string }) =>
        `${grant.capletId}:${grant.referenceName}:${grant.vaultKey}`;

      const all = await traverse();
      expect(all.map(identity)).toEqual((await traverse()).map(identity));
      expect((await traverse({ sort: "desc" })).map(identity)).toEqual(all.map(identity).reverse());
      expect(new Set(all.map(identity))).toEqual(
        new Set([
          "alpha:a_file:ALPHA_TOKEN",
          "alpha:Z_FILE:FILTER_TOKEN",
          "Beta:FILE_C:FILTER_TOKEN",
          "alpha:record_a:FILTER_TOKEN",
          "alpha:RECORD_B:BETA_TOKEN",
          "Beta:RECORD_C:FILTER_TOKEN",
        ]),
      );
      expect(all.filter(({ subjectKind }) => subjectKind === "file").map(identity)).toEqual([
        "Beta:FILE_C:FILTER_TOKEN",
        "alpha:Z_FILE:FILTER_TOKEN",
        "alpha:a_file:ALPHA_TOKEN",
      ]);
      const alphaRecordReferences = all
        .filter(({ subjectKind, capletId }) => subjectKind === "record" && capletId === "alpha")
        .map(({ referenceName }) => referenceName);
      expect(alphaRecordReferences).toEqual(["RECORD_B", "record_a"]);

      expect((await traverse({ capletId: "alpha" }, 1)).map(identity)).toEqual([
        "alpha:Z_FILE:FILTER_TOKEN",
        "alpha:a_file:ALPHA_TOKEN",
        "alpha:RECORD_B:BETA_TOKEN",
        "alpha:record_a:FILTER_TOKEN",
      ]);
      expect(new Set((await traverse({ vaultKey: "FILTER_TOKEN" }, 1)).map(identity))).toEqual(
        new Set([
          "alpha:Z_FILE:FILTER_TOKEN",
          "Beta:FILE_C:FILTER_TOKEN",
          "alpha:record_a:FILTER_TOKEN",
          "Beta:RECORD_C:FILTER_TOKEN",
        ]),
      );
      expect(
        (await traverse({ capletId: "alpha", vaultKey: "FILTER_TOKEN" }, 1)).map(identity),
      ).toEqual(["alpha:Z_FILE:FILTER_TOKEN", "alpha:record_a:FILTER_TOKEN"]);
      const activeOnly = await traverse(
        {
          activeOrigins: [
            {
              capletId: "alpha",
              originKind: "global-file",
              originPath: "/alpha/CAPLET.md",
            },
            { capletId: "Beta", originKind: "stored-record" },
          ],
        },
        1,
      );
      expect(activeOnly.map(identity)).toEqual([
        "alpha:Z_FILE:FILTER_TOKEN",
        "alpha:a_file:ALPHA_TOKEN",
        "Beta:RECORD_C:FILTER_TOKEN",
      ]);
      await expect(storage.vaultGrants.listPage({ limit: 1, activeOrigins: [] })).resolves.toEqual({
        items: [],
      });
      await expect(
        storage.vaultGrants.listPage({
          limit: 1,
          activeOrigins: Array.from({ length: 2_050 }, (_, index) => ({
            capletId: `configured-${index}`,
            originKind: "global-file",
            originPath: `/configured/${index}/CAPLET.md`,
          })),
        }),
      ).resolves.toEqual({ items: [] });

      await expect(
        storage.vaultGrants.listPage({
          limit: 2,
          after: { subjectKind: "record", subjectKey: "\uffff", referenceName: "\uffff" },
        }),
      ).resolves.toEqual({ items: [] });
      for (const limit of [0, 501, 1.5]) {
        await expect(storage.vaultGrants.listPage({ limit })).rejects.toMatchObject({
          code: "REQUEST_INVALID",
        });
      }
      await expect(storage.vaultGrants.listPage({ limit: 2, capletId: " " })).rejects.toMatchObject(
        { code: "REQUEST_INVALID" },
      );
      await expect(storage.vaultGrants.listPage({ limit: 2, vaultKey: " " })).rejects.toMatchObject(
        { code: "REQUEST_INVALID" },
      );
    } finally {
      await storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  postgresIt("matches composite traversal and filters on PostgreSQL", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-vault-grant-pages-postgres-"));
    const schema = `caplets_vault_grant_pages_${randomUUID().replaceAll("-", "")}`;
    const config = {
      type: "postgres" as const,
      connectionString: postgresUrl!,
      schema,
    };
    let storage: HostStorage | undefined;

    try {
      await migrateHostStorage(config);
      storage = await createHostStorage(config, { vaultRoot: join(directory, "vault") });
      for (const id of ["alpha", "Beta"]) {
        await storage.caplets.importBundle({
          id,
          operator,
          files: [{ path: "CAPLET.md", content: capletDocument(), executable: false }],
        });
      }
      for (const key of ["POSTGRES_A", "POSTGRES_B"]) {
        await storage.vaultValues.set(key, `${key}-secret`, { createOnly: true });
      }
      await storage.vaultGrants.grant({
        capletId: "alpha",
        vaultKey: "POSTGRES_A",
        referenceName: "FILE_A",
        originKind: "global-file",
        originPath: "/alpha/CAPLET.md",
        createOnly: true,
        operator,
      });
      await storage.vaultGrants.grant({
        capletId: "alpha",
        vaultKey: "POSTGRES_B",
        referenceName: "file_a",
        originKind: "global-file",
        originPath: "/alpha/CAPLET.md",
        createOnly: true,
        operator,
      });
      await storage.vaultGrants.grant({
        capletId: "Beta",
        vaultKey: "POSTGRES_B",
        referenceName: "FILE_B",
        originKind: "global-file",
        originPath: "/Beta/CAPLET.md",
        createOnly: true,
        operator,
      });
      await storage.vaultGrants.grant({
        capletId: "alpha",
        vaultKey: "POSTGRES_B",
        referenceName: "RECORD_A",
        originKind: "stored-record",
        createOnly: true,
        operator,
      });
      await expect(storage.vaultGrants.countByVaultKey("POSTGRES_B")).resolves.toBe(3);
      await expect(
        storage.vaultGrants.get({
          capletId: "alpha",
          vaultKey: "POSTGRES_B",
          referenceName: "file_a",
          originKind: "global-file",
          originPath: "/alpha/CAPLET.md",
        }),
      ).resolves.toMatchObject({
        capletId: "alpha",
        referenceName: "file_a",
      });
      await expect(
        storage.vaultGrants.listMatching({
          vaultKey: "POSTGRES_B",
          referenceName: "file_a",
        }),
      ).resolves.toEqual([expect.objectContaining({ capletId: "alpha", referenceName: "file_a" })]);

      const raceInput = {
        capletId: "alpha",
        vaultKey: "POSTGRES_A",
        referenceName: "RACE",
        originKind: "global-file" as const,
        originPath: "/alpha/CAPLET.md",
        createOnly: true,
        operator,
      };
      const raceResults = await Promise.allSettled([
        storage.vaultGrants.grant(raceInput),
        storage.vaultGrants.grant(raceInput),
      ]);
      expect(raceResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(raceResults.filter((result) => result.status === "rejected")).toEqual([
        expect.objectContaining({
          reason: expect.objectContaining({ code: "CONFIG_EXISTS" }),
        }),
      ]);
      const raceWinner = raceResults.find((result) => result.status === "fulfilled");
      if (!raceWinner || raceWinner.status !== "fulfilled") {
        throw new Error("Expected one PostgreSQL create-only grant winner");
      }
      await expect(
        storage.vaultGrants.revoke({
          ...raceInput,
          expectedResourceVersion: raceWinner.value,
        }),
      ).resolves.toBe(true);

      const references: string[] = [];
      let after:
        | {
            subjectKind: "record" | "file";
            subjectKey: string;
            referenceName: string;
          }
        | undefined;
      do {
        const page = await storage.vaultGrants.listPage({ limit: 1, after });
        references.push(...page.items.map(({ referenceName }) => referenceName));
        after = page.nextKey;
      } while (after !== undefined);
      expect(references).toEqual(["FILE_B", "FILE_A", "file_a", "RECORD_A"]);
      await expect(
        storage.vaultGrants.listPage({ limit: 2, capletId: "alpha", vaultKey: "POSTGRES_B" }),
      ).resolves.toEqual({
        items: [
          expect.objectContaining({ referenceName: "file_a", capletId: "alpha" }),
          expect.objectContaining({ referenceName: "RECORD_A", capletId: "alpha" }),
        ],
      });
      const activeFirst = await storage.vaultGrants.listPage({
        limit: 1,
        activeOrigins: [
          { capletId: "alpha", originKind: "stored-record" },
          {
            capletId: "Beta",
            originKind: "global-file",
            originPath: "/Beta/CAPLET.md",
          },
        ],
      });
      if (!activeFirst.nextKey) throw new Error("Expected an active-origin PostgreSQL cursor.");
      const activeSecond = await storage.vaultGrants.listPage({
        limit: 1,
        after: activeFirst.nextKey,
        activeOrigins: [
          { capletId: "alpha", originKind: "stored-record" },
          {
            capletId: "Beta",
            originKind: "global-file",
            originPath: "/Beta/CAPLET.md",
          },
        ],
      });
      expect(
        [...activeFirst.items, ...activeSecond.items].map(({ referenceName }) => referenceName),
      ).toEqual(["FILE_B", "RECORD_A"]);
      await expect(storage.vaultGrants.listPage({ limit: 1, activeOrigins: [] })).resolves.toEqual({
        items: [],
      });
      const fileGrant = (await storage.vaultGrants.list("alpha")).find(
        (grant) => grant.referenceName === "FILE_A",
      );
      expect(fileGrant?.resourceVersion).toEqual(expect.any(String));
      await expect(
        storage.vaultGrants.grant({
          capletId: "alpha",
          vaultKey: "POSTGRES_A",
          referenceName: "FILE_A",
          originKind: "global-file",
          originPath: "/alpha/CAPLET.md",
          expectedResourceVersion: "stale-resource-version",
          operator,
        }),
      ).rejects.toMatchObject({ details: { kind: "stale_generation" } });
      const updatedFileGrantVersion = await storage.vaultGrants.grant({
        capletId: "alpha",
        vaultKey: "POSTGRES_A",
        referenceName: "FILE_A",
        originKind: "global-file",
        originPath: "/alpha/CAPLET.md",
        expectedResourceVersion: fileGrant!.resourceVersion,
        operator,
      });
      expect(updatedFileGrantVersion).not.toBe(fileGrant!.resourceVersion);
      await expect(
        storage.vaultGrants.revoke({
          capletId: "alpha",
          vaultKey: "POSTGRES_A",
          referenceName: "FILE_A",
          originKind: "global-file",
          originPath: "/alpha/CAPLET.md",
          expectedResourceVersion: "stale-resource-version",
          operator,
        }),
      ).rejects.toMatchObject({ details: { kind: "stale_generation" } });
      await expect(
        storage.vaultGrants.revoke({
          capletId: "alpha",
          vaultKey: "POSTGRES_A",
          referenceName: "FILE_A",
          originKind: "global-file",
          originPath: "/alpha/CAPLET.md",
          expectedResourceVersion: updatedFileGrantVersion,
          operator,
        }),
      ).resolves.toBe(true);
      const recreatedVersion = await storage.vaultGrants.grant({
        capletId: "alpha",
        vaultKey: "POSTGRES_A",
        referenceName: "FILE_A",
        originKind: "global-file",
        originPath: "/alpha/CAPLET.md",
        createOnly: true,
        operator,
      });
      expect(recreatedVersion).not.toBe(fileGrant!.resourceVersion);
      await expect(
        storage.vaultGrants.revoke({
          capletId: "alpha",
          vaultKey: "POSTGRES_A",
          referenceName: "FILE_A",
          originKind: "global-file",
          originPath: "/alpha/CAPLET.md",
          expectedResourceVersion: fileGrant!.resourceVersion,
          operator,
        }),
      ).rejects.toMatchObject({ details: { kind: "stale_generation" } });
    } finally {
      await storage?.close();
      const pool = new Pool({ connectionString: postgresUrl! });
      try {
        await pool.query(`drop schema if exists "${schema}" cascade`);
      } finally {
        await pool.end();
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
