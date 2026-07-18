import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostStorage } from "../src/storage";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
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

describe("Caplet installation storage", () => {
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
          expectedGeneration: 3,
          operator,
        }),
      ).rejects.toMatchObject({ details: { kind: "stale_generation" } });
      const detached = await storage.installations.detach({
        capletId: "github",
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
});
