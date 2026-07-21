import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostStorage, migrateHostStorage, type HostStorage } from "../src/storage";

const directories: string[] = [];
const postgresUrl = process.env.CAPLETS_TEST_POSTGRES_URL;
if (process.env.CAPLETS_REQUIRE_TEST_POSTGRES === "1" && !postgresUrl) {
  throw new Error("CAPLETS_TEST_POSTGRES_URL is required when CAPLETS_REQUIRE_TEST_POSTGRES=1.");
}
const postgresIt = postgresUrl ? it : it.skip;
const postgresSchemas: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  if (!postgresUrl || postgresSchemas.length === 0) return;
  const pool = new Pool({ connectionString: postgresUrl });
  try {
    for (const schema of postgresSchemas.splice(0)) {
      await pool.query(`drop schema if exists "${schema}" cascade`);
    }
  } finally {
    await pool.end();
  }
});

function document(): Buffer {
  return Buffer.from(`---
name: GitHub
description: Manage GitHub repositories.
mcpServer:
  command: github-mcp
---
# GitHub
`);
}

const operator = { clientId: "operator-client", role: "operator" } as const;

async function createInstallationHistory(
  storage: HostStorage,
  capletId: string,
  count: number,
): Promise<string[]> {
  await storage.caplets.importBundle({
    id: capletId,
    operator,
    files: [{ path: "CAPLET.md", content: document(), executable: false }],
  });
  let current = await storage.installations.install({
    capletId,
    sourceKind: "catalog",
    sourceIdentity: `official/${capletId}/0`,
    operator,
  });
  const keys = [current.installationKey];
  for (let index = 1; index < count; index += 1) {
    const detached = await storage.installations.detach({
      capletId,
      installationKey: current.installationKey,
      expectedGeneration: current.generation,
      operator,
    });
    current = await storage.installations.replaceDetached({
      capletId,
      detachedInstallationKey: detached!.installationKey,
      expectedGeneration: detached!.generation,
      sourceKind: "catalog",
      sourceIdentity: `official/${capletId}/${index}`,
      operator,
    });
    keys.push(current.installationKey);
  }
  return keys;
}

describe("Caplet installation storage", () => {
  it("creates an installation at a caller-supplied key without changing generated-key callers", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-installation-explicit-key-"));
    directories.push(root);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(root, "caplets.sqlite3"),
    });
    try {
      await storage.caplets.importBundle({
        id: "github",
        operator,
        files: [{ path: "CAPLET.md", content: document(), executable: false }],
      });
      await storage.caplets.importBundle({
        id: "gitlab",
        operator,
        files: [{ path: "CAPLET.md", content: document(), executable: false }],
      });

      const explicit = await storage.installations.install({
        capletId: "github",
        installationKey: "installation_explicit",
        sourceKind: "catalog",
        sourceIdentity: "official/github",
        operator,
      });
      expect(explicit).toMatchObject({
        installationKey: "installation_explicit",
        capletId: "github",
        generation: 1,
        status: "active",
      });
      await expect(storage.installations.getByKey("installation_explicit")).resolves.toMatchObject({
        capletId: "github",
      });

      const generated = await storage.installations.install({
        capletId: "gitlab",
        sourceKind: "catalog",
        sourceIdentity: "official/gitlab",
        operator,
      });
      expect(generated.installationKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      await storage.close();
    }
  });
  it("rejects missing records and installation-key collisions without partial writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-installation-collisions-"));
    directories.push(root);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(root, "caplets.sqlite3"),
    });
    try {
      await expect(
        storage.installations.install({
          capletId: "missing",
          installationKey: "installation_missing",
          sourceKind: "catalog",
          sourceIdentity: "official/missing",
          operator,
        }),
      ).rejects.toMatchObject({ code: "CONFIG_NOT_FOUND" });
      await expect(storage.installations.getByKey("installation_missing")).resolves.toBeUndefined();

      for (const id of ["github", "gitlab"]) {
        await storage.caplets.importBundle({
          id,
          operator,
          files: [{ path: "CAPLET.md", content: document(), executable: false }],
        });
      }
      await storage.installations.install({
        capletId: "github",
        installationKey: "installation_shared",
        sourceKind: "catalog",
        sourceIdentity: "official/github",
        operator,
      });
      await expect(
        storage.installations.install({
          capletId: "gitlab",
          installationKey: "installation_shared",
          sourceKind: "catalog",
          sourceIdentity: "official/gitlab",
          operator,
        }),
      ).rejects.toMatchObject({ code: "CONFIG_EXISTS" });
      await expect(storage.installations.getActive("gitlab")).resolves.toBeUndefined();

      await expect(
        storage.installations.install({
          capletId: "github",
          installationKey: "installation_second",
          sourceKind: "catalog",
          sourceIdentity: "community/github",
          operator,
        }),
      ).rejects.toMatchObject({ code: "CONFIG_EXISTS" });
      await expect(storage.installations.getByKey("installation_second")).resolves.toBeUndefined();
    } finally {
      await storage.close();
    }
  });

  it("tracks provenance, requires an Operator Client, and audits detach", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-installations-"));
    directories.push(root);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(root, "caplets.sqlite3"),
    });
    try {
      await expect(
        storage.caplets.importBundle({
          id: "forbidden",
          operator: { clientId: "access-client", role: "access" },
          files: [{ path: "CAPLET.md", content: document(), executable: false }],
        }),
      ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      await storage.caplets.importBundle({
        id: "github",
        operator: { clientId: "operator-import", role: "operator" },
        files: [{ path: "CAPLET.md", content: document(), executable: false }],
      });
      await expect(
        storage.vaultGrants.grant({
          capletId: "github",
          vaultKey: "github-token",
          originKind: "stored-record",
          operator: { clientId: "access-client", role: "access" },
        }),
      ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
      await storage.vaultGrants.grant({
        capletId: "github",
        vaultKey: "github-token",
        originKind: "stored-record",
        operator: { clientId: "operator-client", role: "operator" },
      });
      const [grantBeforeUpdate] = await storage.vaultGrants.list("github");
      expect(grantBeforeUpdate?.recordKey).toBe((await storage.caplets.get("github"))?.recordKey);
      await expect(
        storage.installations.install({
          capletId: "github",
          sourceKind: "catalog",
          sourceIdentity: "official/github",
          channel: "stable",
          operator: { clientId: "access-client", role: "access" },
        }),
      ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });

      const installed = await storage.installations.install({
        capletId: "github",
        sourceKind: "catalog",
        sourceIdentity: "official/github",
        channel: "stable",
        operator: { clientId: "operator-client", role: "operator" },
      });
      expect(installed).toMatchObject({
        capletId: "github",
        generation: 1,
        status: "active",
        sourceKind: "catalog",
        sourceIdentity: "official/github",
        channel: "stable",
      });
      await expect(
        storage.installations.detach({
          capletId: "github",
          installationKey: installed.installationKey,
          expectedGeneration: 0,
          operator: { clientId: "operator-client", role: "operator" },
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

      await expect(
        storage.caplets.updateBundle({
          id: "github",
          operator: { clientId: "operator-client", role: "operator" },
          expectedGeneration: 1,
          files: [{ path: "CAPLET.md", content: document(), executable: false }],
        }),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
        details: { kind: "tracked_installation" },
      });
      await storage.caplets.updateBundle({
        id: "github",
        operator: { clientId: "operator-client", role: "operator" },
        expectedGeneration: 1,
        detachInstallation: true,
        files: [{ path: "CAPLET.md", content: document(), executable: false }],
      });
      await expect(storage.installations.getActive("github")).resolves.toBeUndefined();
      await expect(storage.vaultGrants.list("github")).resolves.toMatchObject([
        { recordKey: grantBeforeUpdate?.recordKey, vaultKey: "github-token" },
      ]);
      const actions = (await storage.installations.listActivity()).map((entry) => entry.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          "caplet.import",
          "caplet.install",
          "caplet.detach_for_overwrite",
          "caplet.update",
        ]),
      );
    } finally {
      await storage.close();
    }
  });

  it("retains unavailable sources and explicitly replaces detached installations", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-installation-lifecycle-"));
    directories.push(root);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(root, "caplets.sqlite3"),
    });
    const operator = { clientId: "operator-client", role: "operator" } as const;
    try {
      await storage.caplets.importBundle({
        id: "github",
        operator,
        files: [{ path: "CAPLET.md", content: document(), executable: false }],
      });
      await expect(storage.coordination.currentConfigGeneration()).resolves.toBe(1);
      const recordBefore = await storage.caplets.get("github");
      const installed = await storage.installations.install({
        capletId: "github",
        sourceKind: "catalog",
        sourceIdentity: "official/github",
        channel: "stable",
        operator,
      });
      await expect(storage.coordination.currentConfigGeneration()).resolves.toBe(2);

      await storage.installations.appendObservation({
        capletId: "github",
        expectedGeneration: 1,
        status: "current",
        resolvedRevision: "v1.0.0",
        contentHash: "content-v1",
        risk: { level: "low" },
        operator,
      });
      await storage.installations.appendObservation({
        capletId: "github",
        expectedGeneration: 2,
        status: "metadata-only",
        resolvedRevision: "v1.1.0",
        risk: { level: "medium" },
        operator,
      });
      await expect(
        storage.installations.appendObservation({
          capletId: "github",
          expectedGeneration: 2,
          status: "source-unavailable",
          operator,
        }),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
        details: { kind: "stale_generation" },
      });
      await storage.installations.appendObservation({
        capletId: "github",
        expectedGeneration: 3,
        status: "source-unavailable",
        operator,
      });

      const retained = await storage.installations.getActive("github");
      expect(retained).toMatchObject({
        installationKey: installed.installationKey,
        recordKey: installed.recordKey,
        generation: 4,
        status: "active",
      });
      expect((await storage.caplets.get("github"))?.recordKey).toBe(recordBefore?.recordKey);
      await expect(storage.installations.getLatestObservation("github")).resolves.toMatchObject({
        status: "source-unavailable",
        resolvedRevision: null,
        contentHash: null,
      });
      const observations = await storage.installations.listObservations("github");
      expect(observations.map((observation) => observation.status)).toEqual([
        "source-unavailable",
        "metadata-only",
        "current",
      ]);
      expect(observations[0]!.observedAt > observations[1]!.observedAt).toBe(true);
      expect(observations[1]!.observedAt > observations[2]!.observedAt).toBe(true);
      await expect(storage.coordination.currentConfigGeneration()).resolves.toBe(2);

      await expect(
        storage.installations.detach({
          capletId: "github",
          installationKey: installed.installationKey,
          expectedGeneration: 3,
          operator,
        }),
      ).rejects.toMatchObject({ details: { kind: "stale_generation" } });
      const detached = await storage.installations.detach({
        capletId: "github",
        installationKey: installed.installationKey,
        expectedGeneration: 4,
        operator,
      });
      expect(detached).toMatchObject({
        installationKey: installed.installationKey,
        generation: 5,
        status: "detached",
      });
      await expect(storage.coordination.currentConfigGeneration()).resolves.toBe(3);
      await expect(
        storage.installations.install({
          capletId: "github",
          sourceKind: "catalog",
          sourceIdentity: "community/github",
          operator,
        }),
      ).rejects.toMatchObject({
        details: { kind: "detached_installation_replacement_required" },
      });
      await expect(
        storage.installations.replaceDetached({
          capletId: "github",
          detachedInstallationKey: installed.installationKey,
          expectedGeneration: 4,
          sourceKind: "catalog",
          sourceIdentity: "community/github",
          operator,
        }),
      ).rejects.toMatchObject({ details: { kind: "stale_generation" } });

      const replacement = await storage.installations.replaceDetached({
        capletId: "github",
        detachedInstallationKey: installed.installationKey,
        expectedGeneration: 5,
        sourceKind: "catalog",
        sourceIdentity: "community/github",
        channel: "stable",
        operator,
      });
      expect(replacement).toMatchObject({ generation: 1, status: "active" });
      expect(replacement.installationKey).not.toBe(installed.installationKey);
      for (let generation = 1; generation < 5; generation += 1) {
        await storage.installations.appendObservation({
          capletId: "github",
          expectedGeneration: generation,
          status: "current",
          operator,
        });
      }
      const historicalDelete = await storage.installations.detach({
        capletId: "github",
        installationKey: installed.installationKey,
        expectedGeneration: 5,
        operator,
      });
      expect(historicalDelete).toMatchObject({
        installationKey: installed.installationKey,
        generation: 5,
        status: "detached",
      });
      await expect(storage.installations.getActive("github")).resolves.toMatchObject({
        installationKey: replacement.installationKey,
        generation: 5,
        status: "active",
      });
      await expect(storage.coordination.currentConfigGeneration()).resolves.toBe(4);
      await expect(storage.installations.list("github")).resolves.toMatchObject([
        { installationKey: replacement.installationKey, status: "active" },
        { installationKey: installed.installationKey, status: "detached" },
      ]);
      expect((await storage.installations.listActivity()).map((entry) => entry.action)).toEqual(
        expect.arrayContaining([
          "caplet.observe_source",
          "caplet.detach",
          "caplet.replace_installation",
        ]),
      );
    } finally {
      await storage.close();
    }
  });

  it("traverses installation pages with stable ties and parent filtering", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-installation-pages-"));
    directories.push(root);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(root, "caplets.sqlite3"),
    });
    try {
      const githubKeys = await createInstallationHistory(storage, "github", 5);
      const gitlabKeys = await createInstallationHistory(storage, "gitlab", 2);
      if (storage.database.dialect !== "sqlite") throw new Error("Expected SQLite storage.");
      storage.database.db.run(sql`
        update caplet_installations
        set updated_at = '2026-07-20T12:00:00.000Z'
        where record_key = (
          select record_key from caplet_records where caplet_id = 'github'
        )
      `);

      const expectedKeys = githubKeys.toSorted().reverse();
      const first = await storage.installations.listPage("github", { limit: 2 });
      expect(first.items.map((item) => item.installationKey)).toEqual(expectedKeys.slice(0, 2));
      expect(first.nextKey).toEqual({
        updatedAt: "2026-07-20T12:00:00.000Z",
        installationKey: expectedKeys[1],
      });

      const second = await storage.installations.listPage("github", {
        limit: 2,
        after: first.nextKey,
      });
      const third = await storage.installations.listPage("github", {
        limit: 2,
        after: second.nextKey,
      });
      expect(
        [...first.items, ...second.items, ...third.items].map((item) => item.installationKey),
      ).toEqual(expectedKeys);
      expect(second.nextKey).toEqual({
        updatedAt: "2026-07-20T12:00:00.000Z",
        installationKey: expectedKeys[3],
      });
      expect(third.nextKey).toBeUndefined();
      const ascendingKeys: string[] = [];
      let ascendingAfter: typeof first.nextKey;
      do {
        const page = await storage.installations.listPage("github", {
          limit: 2,
          sort: "asc",
          after: ascendingAfter,
        });
        ascendingKeys.push(...page.items.map((item) => item.installationKey));
        ascendingAfter = page.nextKey;
      } while (ascendingAfter !== undefined);
      expect(ascendingKeys).toEqual(expectedKeys.toReversed());
      expect(
        [...first.items, ...second.items, ...third.items].some((item) =>
          gitlabKeys.includes(item.installationKey),
        ),
      ).toBe(false);
      await expect(storage.installations.listPage("missing", { limit: 2 })).rejects.toMatchObject({
        code: "CONFIG_NOT_FOUND",
      });
      await expect(storage.installations.listPage("github", { limit: 0 })).rejects.toMatchObject({
        code: "REQUEST_INVALID",
      });
    } finally {
      await storage.close();
    }
  });

  it("continues an installation traversal when a newer installation is added", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-installation-page-mutation-"));
    directories.push(root);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(root, "caplets.sqlite3"),
    });
    try {
      await createInstallationHistory(storage, "github", 5);
      const initial = await storage.installations.list("github");
      const first = await storage.installations.listPage("github", { limit: 2 });
      expect(first.items).toEqual(initial.slice(0, 2));

      const mutationTime = new Date(Date.now() + 1_000);
      vi.useFakeTimers();
      vi.setSystemTime(mutationTime);
      const replacement = await (async () => {
        try {
          const current = await storage.installations.getActive("github");
          const detached = await storage.installations.detach({
            capletId: "github",
            installationKey: current!.installationKey,
            expectedGeneration: current!.generation,
            operator,
          });
          return await storage.installations.replaceDetached({
            capletId: "github",
            detachedInstallationKey: detached!.installationKey,
            expectedGeneration: detached!.generation,
            sourceKind: "catalog",
            sourceIdentity: "official/github/newer",
            operator,
          });
        } finally {
          vi.useRealTimers();
        }
      })();

      const second = await storage.installations.listPage("github", {
        limit: 2,
        after: first.nextKey,
      });
      const third = await storage.installations.listPage("github", {
        limit: 2,
        after: second.nextKey,
      });
      const traversed = [...first.items, ...second.items, ...third.items].map(
        (item) => item.installationKey,
      );
      expect(traversed).toEqual(initial.map((item) => item.installationKey));
      expect(new Set(traversed).size).toBe(initial.length);
      expect(traversed).not.toContain(replacement.installationKey);
      expect(third.nextKey).toBeUndefined();
    } finally {
      await storage.close();
    }
  });
  it("pages latest-installation observations in either sort direction", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-installation-observation-pages-"));
    directories.push(root);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(root, "caplets.sqlite3"),
    });
    try {
      const [oldInstallationKey] = await createInstallationHistory(storage, "github", 1);
      if (oldInstallationKey === undefined) throw new Error("Expected historical installation.");
      const oldObservation = await storage.installations.appendObservation({
        capletId: "github",
        expectedGeneration: 1,
        status: "current",
        resolvedRevision: "old",
        operator,
      });
      const detached = await storage.installations.detach({
        capletId: "github",
        installationKey: oldInstallationKey,
        expectedGeneration: 2,
        operator,
      });
      const current = await storage.installations.replaceDetached({
        capletId: "github",
        detachedInstallationKey: detached!.installationKey,
        expectedGeneration: detached!.generation,
        sourceKind: "catalog",
        sourceIdentity: "official/github/current",
        operator,
      });

      const observations = [];
      for (let index = 0; index < 5; index += 1) {
        observations.push(
          await storage.installations.appendObservation({
            capletId: "github",
            expectedGeneration: index + 1,
            status: "current",
            resolvedRevision: `current-${index}`,
            operator,
          }),
        );
      }
      await createInstallationHistory(storage, "gitlab", 1);
      const gitlabObservation = await storage.installations.appendObservation({
        capletId: "gitlab",
        expectedGeneration: 1,
        status: "metadata-only",
        operator,
      });

      if (storage.database.dialect !== "sqlite") throw new Error("Expected SQLite storage.");
      storage.database.db.run(sql`
        update caplet_installation_observations
        set observed_at = '2026-07-20T12:00:00.000Z'
        where installation_key = ${current.installationKey}
      `);

      const ascendingKeys = observations
        .map((observation) => observation.observationKey)
        .toSorted();
      const ascendingFirst = await storage.installations.listObservationsPage("github", {
        limit: 2,
      });
      const ascendingSecond = await storage.installations.listObservationsPage("github", {
        limit: 2,
        after: ascendingFirst.nextKey,
      });
      const ascendingThird = await storage.installations.listObservationsPage("github", {
        limit: 2,
        after: ascendingSecond.nextKey,
      });
      const ascendingTraversal = [
        ...ascendingFirst.items,
        ...ascendingSecond.items,
        ...ascendingThird.items,
      ].map((item) => item.observationKey);
      expect(ascendingTraversal).toEqual(ascendingKeys);
      expect(new Set(ascendingTraversal).size).toBe(ascendingKeys.length);
      expect(ascendingThird.nextKey).toBeUndefined();

      const descendingKeys = [...ascendingKeys].reverse();
      const descendingFirst = await storage.installations.listObservationsPage("github", {
        limit: 2,
        sort: "desc",
      });
      const descendingSecond = await storage.installations.listObservationsPage("github", {
        limit: 2,
        sort: "desc",
        after: descendingFirst.nextKey,
      });
      const descendingThird = await storage.installations.listObservationsPage("github", {
        limit: 2,
        sort: "desc",
        after: descendingSecond.nextKey,
      });
      const descendingTraversal = [
        ...descendingFirst.items,
        ...descendingSecond.items,
        ...descendingThird.items,
      ].map((item) => item.observationKey);
      expect(descendingTraversal).toEqual(descendingKeys);
      expect(new Set(descendingTraversal).size).toBe(descendingKeys.length);
      expect(descendingTraversal).not.toContain(oldObservation.observationKey);
      expect(descendingTraversal).not.toContain(gitlabObservation.observationKey);
      expect(
        descendingFirst.items.every((item) => item.installationKey === current.installationKey),
      ).toBe(true);
      expect(
        descendingFirst.items.some((item) => item.installationKey === oldInstallationKey),
      ).toBe(false);
      expect(descendingThird.nextKey).toBeUndefined();

      await expect(
        storage.installations.listObservationsPage("missing", { limit: 2 }),
      ).rejects.toMatchObject({ code: "CONFIG_NOT_FOUND" });
      await expect(
        storage.installations.listObservationsPage("github", { limit: 501 }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    } finally {
      await storage.close();
    }
  });

  postgresIt("keeps installation keyset pages identical on PostgreSQL", async () => {
    const schema = `caplets_installation_pages_${randomUUID().replaceAll("-", "")}`;
    postgresSchemas.push(schema);
    const config = {
      type: "postgres" as const,
      connectionString: postgresUrl!,
      schema,
    };
    await migrateHostStorage(config);
    const storage = await createHostStorage(config);
    try {
      const installationKeys = await createInstallationHistory(storage, "github-pages", 5);
      const otherInstallationKeys = await createInstallationHistory(storage, "gitlab-pages", 2);
      if (storage.database.dialect !== "postgres") throw new Error("Expected PostgreSQL storage.");
      await storage.database.db.execute(sql`
        update caplet_installations
        set updated_at = '2026-07-20T12:00:00.000Z'
        where record_key = (
          select record_key from caplet_records where caplet_id = 'github-pages'
        )
      `);

      const expectedInstallationKeys = installationKeys.toSorted().reverse();
      const installationFirst = await storage.installations.listPage("github-pages", {
        limit: 2,
      });
      const installationSecond = await storage.installations.listPage("github-pages", {
        limit: 2,
        after: installationFirst.nextKey,
      });
      const installationThird = await storage.installations.listPage("github-pages", {
        limit: 2,
        after: installationSecond.nextKey,
      });
      const traversedInstallationKeys = [
        ...installationFirst.items,
        ...installationSecond.items,
        ...installationThird.items,
      ].map((item) => item.installationKey);
      expect(traversedInstallationKeys).toEqual(expectedInstallationKeys);
      expect(new Set(traversedInstallationKeys).size).toBe(expectedInstallationKeys.length);
      expect(traversedInstallationKeys.some((key) => otherInstallationKeys.includes(key))).toBe(
        false,
      );
      expect(installationThird.nextKey).toBeUndefined();

      const [observationInstallationKey] = await createInstallationHistory(
        storage,
        "github-observations",
        1,
      );
      const observationKeys = [];
      for (let index = 0; index < 4; index += 1) {
        observationKeys.push(
          (
            await storage.installations.appendObservation({
              capletId: "github-observations",
              expectedGeneration: index + 1,
              status: "current",
              resolvedRevision: `revision-${index}`,
              operator,
            })
          ).observationKey,
        );
      }
      await createInstallationHistory(storage, "gitlab-observations", 1);
      const otherObservation = await storage.installations.appendObservation({
        capletId: "gitlab-observations",
        expectedGeneration: 1,
        status: "metadata-only",
        operator,
      });
      await storage.database.db.execute(sql`
        update caplet_installation_observations
        set observed_at = '2026-07-20T12:00:00.000Z'
        where installation_key = ${observationInstallationKey}
      `);

      const ascendingObservationKeys = observationKeys.toSorted();
      const ascendingObservationFirst = await storage.installations.listObservationsPage(
        "github-observations",
        { limit: 2 },
      );
      const ascendingObservationSecond = await storage.installations.listObservationsPage(
        "github-observations",
        { limit: 2, after: ascendingObservationFirst.nextKey },
      );
      const ascendingTraversal = [
        ...ascendingObservationFirst.items,
        ...ascendingObservationSecond.items,
      ].map((item) => item.observationKey);
      expect(ascendingTraversal).toEqual(ascendingObservationKeys);
      expect(new Set(ascendingTraversal).size).toBe(ascendingObservationKeys.length);
      expect(ascendingTraversal).not.toContain(otherObservation.observationKey);
      expect(ascendingObservationSecond.nextKey).toBeUndefined();

      const descendingObservationKeys = [...ascendingObservationKeys].reverse();
      const descendingObservationFirst = await storage.installations.listObservationsPage(
        "github-observations",
        { limit: 2, sort: "desc" },
      );
      const descendingObservationSecond = await storage.installations.listObservationsPage(
        "github-observations",
        { limit: 2, sort: "desc", after: descendingObservationFirst.nextKey },
      );
      const descendingTraversal = [
        ...descendingObservationFirst.items,
        ...descendingObservationSecond.items,
      ].map((item) => item.observationKey);
      expect(descendingTraversal).toEqual(descendingObservationKeys);
      expect(new Set(descendingTraversal).size).toBe(descendingObservationKeys.length);
      expect(descendingTraversal).not.toContain(otherObservation.observationKey);
      expect(descendingObservationSecond.nextKey).toBeUndefined();

      await expect(
        storage.installations.listObservationsPage("missing", { limit: 2 }),
      ).rejects.toMatchObject({ code: "CONFIG_NOT_FOUND" });
    } finally {
      await storage.close();
    }
  });
});
