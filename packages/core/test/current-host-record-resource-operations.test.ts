import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCurrentHostOperations } from "../src/current-host/operations";
import { createAdminV2Router } from "../src/admin-api/router";
import { AdminBundleUploadAdmissionController } from "../src/admin-api/bundle-upload-admission";
import type { ReopenableBundleFileSource } from "../src/storage/bundle-source";
import { createHostStorage } from "../src/storage";
import type { HostStorage } from "../src/storage/database";

const roots: string[] = [];
const principal = {
  clientId: "rcli_abcdefghijklmnop",
  hostUrl: "https://caplets.example.com/",
  role: "operator" as const,
};

const document = (command: string) =>
  [
    "---",
    "name: Stored",
    "description: Streaming record fixture.",
    "tags:",
    "  - streaming",
    "mcpServer:",
    `  command: ${command}`,
    "---",
    "",
    "# Stored",
    "",
  ].join("\n");

function source(path: string, content: string): ReopenableBundleFileSource {
  const bytes = new TextEncoder().encode(content);
  return {
    path,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    executable: false,
    open: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, Math.max(1, Math.floor(bytes.byteLength / 2))));
          controller.enqueue(bytes.subarray(Math.max(1, Math.floor(bytes.byteLength / 2))));
          controller.close();
        },
      }),
  };
}

function setupOperations(storage: HostStorage, activateConfig = vi.fn()) {
  return {
    activateConfig,
    operations: createCurrentHostOperations({
      engine: { enabledServers: () => [] },
      activityLog: storage.operatorActivity,
      capletRecords: storage.caplets,
      capletInstallations: storage.installations,
      activateConfig,
      version: "test-version",
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Current Host Caplet Record resources", () => {
  it("streams bundle sources through guarded record, revision, and patch operations", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-current-host-record-resources-"));
    roots.push(root);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(root, "host.sqlite3"),
    });
    const importBuffered = vi.spyOn(storage.caplets, "importBundle");
    const updateBuffered = vi.spyOn(storage.caplets, "updateBundle");
    const readBuffered = vi.spyOn(storage.caplets, "readBundle");
    const { operations, activateConfig } = setupOperations(storage);
    try {
      const imported = await operations.execute(principal, {
        kind: "stored_caplet_bundle_import",
        id: "alpha",
        sources: [source("CAPLET.md", document("first")), source("notes.txt", "one")],
        historyLimit: 4,
      });
      expect(imported).toMatchObject({
        kind: "stored_caplet_bundle_import",
        record: { id: "alpha", headGeneration: 1 },
      });
      await expect(
        operations.execute(principal, {
          kind: "stored_caplets_page",
          limit: 1,
          sort: "asc",
          tag: "streaming",
          search: "stored",
        }),
      ).resolves.toMatchObject({
        kind: "stored_caplets_page",
        page: { items: [{ id: "alpha", headGeneration: 1 }] },
      });
      await expect(
        operations.execute(principal, { kind: "stored_caplet_get", id: "alpha" }),
      ).resolves.toMatchObject({
        kind: "stored_caplet_get",
        record: { id: "alpha", headGeneration: 1 },
        document: expect.stringContaining("command: first"),
      });

      const documentPatched = await operations.execute(principal, {
        kind: "stored_caplet_update",
        id: "alpha",
        document: document("second"),
        expectedGeneration: 1,
      });
      expect(documentPatched).toMatchObject({ record: { id: "alpha", headGeneration: 2 } });
      await expect(
        operations.execute(principal, {
          kind: "stored_caplet_update",
          id: "alpha",
          newId: "stale",
          expectedGeneration: 1,
        }),
      ).rejects.toMatchObject({ details: { kind: "stale_generation" } });
      const renamed = await operations.execute(principal, {
        kind: "stored_caplet_update",
        id: "alpha",
        newId: "beta",
        expectedGeneration: 2,
      });
      expect(renamed).toMatchObject({ record: { id: "beta", headGeneration: 3 } });
      const retained = await operations.execute(principal, {
        kind: "stored_caplet_update",
        id: "beta",
        historyLimit: 3,
        expectedGeneration: 3,
      });
      expect(retained).toMatchObject({ record: { id: "beta", headGeneration: 4 } });
      await expect(
        operations.execute(principal, {
          kind: "stored_caplet_update",
          id: "beta",
          document: document("invalid"),
          historyLimit: 2,
          expectedGeneration: 4,
        } as never),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

      const revisions = await operations.execute(principal, {
        kind: "stored_caplet_revisions_page",
        id: "beta",
        limit: 1,
        sort: "asc",
      });
      expect(revisions.page.items).toHaveLength(1);
      expect(revisions.page.nextKey).toBeDefined();
      const revisionKey = revisions.page.items[0]!.revisionKey;
      await expect(
        operations.execute(principal, {
          kind: "stored_caplet_get",
          id: "beta",
          revisionKey,
        }),
      ).resolves.toMatchObject({
        kind: "stored_caplet_get",
        record: { currentRevision: { revisionKey } },
      });
      const bundle = await operations.execute(principal, {
        kind: "stored_caplet_bundle_get",
        id: "beta",
        revisionKey,
      });
      expect(bundle).toMatchObject({
        kind: "stored_caplet_bundle_get",
        record: { currentRevision: { revisionKey } },
      });
      expect(bundle.sources.map((item) => item.path).sort()).toEqual(["CAPLET.md", "notes.txt"]);

      const updatedBundle = await operations.execute(principal, {
        kind: "stored_caplet_bundle_update",
        id: "beta",
        expectedGeneration: 4,
        sources: [source("CAPLET.md", document("third")), source("notes.txt", "two")],
      });
      expect(updatedBundle).toMatchObject({ record: { id: "beta", headGeneration: 5 } });
      expect(activateConfig).toHaveBeenCalledTimes(5);
      expect(await storage.coordination.currentConfigGeneration()).toBe(4);
      const mutationActivity = (
        await storage.operatorActivity.listPage({ limit: 50 })
      ).items.filter((entry) =>
        ["caplet.import", "caplet.update", "caplet.rename", "caplet.retention_set"].includes(
          entry.action,
        ),
      );
      expect(mutationActivity).toHaveLength(5);
      expect(importBuffered).not.toHaveBeenCalled();
      expect(updateBuffered).not.toHaveBeenCalled();
      expect(readBuffered).not.toHaveBeenCalled();
    } finally {
      await storage.close();
    }
  });

  it("keeps record pages and mutation results bounded while detail and bundle routes stay complete", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-current-host-record-summary-"));
    roots.push(root);
    const storage = await createHostStorage({ type: "sqlite", path: join(root, "host.sqlite3") });
    const { operations } = setupOperations(storage);
    const largeDocument = `${document("bounded")}${"x".repeat(48 * 1024)}`;
    const metadataHeavySources = Array.from({ length: 1_200 }, (_, index) =>
      source(`${String(index).padStart(4, "0")}-${"x".repeat(900)}.txt`, ""),
    );
    try {
      const imported = await operations.execute(principal, {
        kind: "stored_caplet_bundle_import",
        id: "bounded",
        sources: [
          source("CAPLET.md", largeDocument),
          source("payload.txt", "full payload"),
          ...metadataHeavySources,
        ],
      });
      expect(imported.record.currentRevision.body).toContain("x".repeat(1_024));
      expect(imported.record.currentRevision.bundle).toHaveLength(1_201);
      expect(Buffer.byteLength(JSON.stringify(imported.record))).toBeGreaterThan(1024 * 1024);

      const page = await operations.execute(principal, {
        kind: "stored_caplets_page",
        limit: 500,
        sort: "asc",
      });
      expect(page.page.items).toEqual([
        {
          recordKey: imported.record.recordKey,
          id: "bounded",
          headGeneration: 1,
          historyLimit: null,
          createdAt: imported.record.createdAt,
          updatedAt: imported.record.updatedAt,
          currentRevision: {
            revisionKey: imported.record.currentRevision.revisionKey,
            sequence: 1,
            name: "Stored",
            createdAt: imported.record.currentRevision.createdAt,
          },
        },
      ]);
      expect(page.page.items[0]!.currentRevision).not.toHaveProperty("body");
      expect(page.page.items[0]!.currentRevision).not.toHaveProperty("content");
      expect(page.page.items[0]!.currentRevision).not.toHaveProperty("backends");
      expect(page.page.items[0]!.currentRevision).not.toHaveProperty("bundle");

      const detail = await operations.execute(principal, {
        kind: "stored_caplet_get",
        id: "bounded",
      });
      expect(detail.document).toBe(largeDocument);
      expect(detail.record.currentRevision.body).toContain("x".repeat(1_024));
      expect(detail.record.currentRevision.backends).toHaveLength(1);
      expect(detail.record.currentRevision.bundle).toHaveLength(1_201);
      expect(detail.record.currentRevision.bundle).toContainEqual(
        expect.objectContaining({ path: "payload.txt", size: 12 }),
      );

      const streamed = await operations.execute(principal, {
        kind: "stored_caplet_bundle_get",
        id: "bounded",
      });
      expect(streamed.sources).toHaveLength(1_202);
      expect(streamed.sources[0]).toMatchObject({
        path: "CAPLET.md",
        size: Buffer.byteLength(largeDocument),
      });
      expect(streamed.sources).toContainEqual(expect.objectContaining({ path: "payload.txt" }));

      for (const operation of [
        { kind: "stored_caplet_get", id: "absent" },
        { kind: "stored_caplet_bundle_get", id: "absent" },
        { kind: "stored_caplet_get", id: "bounded", revisionKey: "absent-revision" },
        { kind: "stored_caplet_bundle_get", id: "bounded", revisionKey: "absent-revision" },
      ] as const) {
        await expect(operations.execute(principal, operation)).rejects.toMatchObject({
          code: "SERVER_NOT_FOUND",
        });
      }

      const app = createAdminV2Router({
        operations,
        principalProvider: async () => principal,
        idempotencyStore: storage.idempotency,
        host: {
          baseUrl: "https://host.example",
          dashboardUrl: "https://host.example/dashboard",
          dashboardPath: "/dashboard",
          bind: "127.0.0.1:5387",
        },
      });
      const listResponse = await app.request("https://host.example/caplet-records?limit=500");
      expect(listResponse.status).toBe(200);
      const listBody = await listResponse.text();
      expect(Buffer.byteLength(listBody)).toBeLessThan(4 * 1024);
      expect(listBody).not.toContain("payload.txt");

      const currentResponse = await app.request("https://host.example/caplet-records/bounded");
      expect(currentResponse.status).toBe(200);
      expect(Buffer.byteLength(await currentResponse.clone().text())).toBeGreaterThan(1024 * 1024);
      const currentEtag = currentResponse.headers.get("etag");
      expect(currentEtag).toMatch(/^"[A-Za-z0-9_-]+"$/u);
      const firstMutation = await app.request("https://host.example/caplet-records/bounded", {
        method: "PATCH",
        headers: {
          "content-type": "application/merge-patch+json",
          "Idempotency-Key": "bounded-record-mutation",
          "If-Match": currentEtag!,
        },
        body: JSON.stringify({ historyLimit: 2 }),
      });
      expect(firstMutation.status).toBe(200);
      const firstMutationBody = await firstMutation.text();
      expect(Buffer.byteLength(firstMutationBody)).toBeLessThan(4 * 1024);
      expect(JSON.parse(firstMutationBody)).toEqual(
        expect.objectContaining({
          id: "bounded",
          headGeneration: 2,
          currentRevision: {
            revisionKey: imported.record.currentRevision.revisionKey,
            sequence: 1,
            name: "Stored",
            createdAt: imported.record.currentRevision.createdAt,
          },
        }),
      );
      expect(firstMutationBody).not.toContain("payload.txt");
      const replay = await app.request("https://host.example/caplet-records/bounded", {
        method: "PATCH",
        headers: {
          "content-type": "application/merge-patch+json",
          "Idempotency-Key": "bounded-record-mutation",
          "If-Match": currentEtag!,
        },
        body: JSON.stringify({ historyLimit: 2 }),
      });
      expect(replay.status).toBe(200);
      expect(replay.headers.get("idempotency-replayed")).toBe("true");
      await expect(replay.text()).resolves.toBe(firstMutationBody);

      for (const path of [
        "/caplet-records/absent",
        "/caplet-records/absent/bundle",
        "/caplet-records/bounded/revisions/absent-revision",
        "/caplet-records/bounded/revisions/absent-revision/bundle",
      ]) {
        const response = await app.request(`https://host.example${path}`);
        expect(response.status, path).toBe(404);
        await expect(response.json()).resolves.toMatchObject({
          status: 404,
          code: "SERVER_NOT_FOUND",
        });
      }
    } finally {
      await storage.close();
    }
  });

  it("cancels a failed source and retains a committed mutation when activation fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-current-host-record-cleanup-"));
    roots.push(root);
    const storage = await createHostStorage({ type: "sqlite", path: join(root, "host.sqlite3") });
    let cancelled = 0;
    const badSource: ReopenableBundleFileSource = {
      path: "CAPLET.md",
      size: 1,
      sha256: "0".repeat(64),
      executable: false,
      open: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2]));
          },
          cancel() {
            cancelled += 1;
          },
        }),
    };
    const activationFailure = new Error("activation failed");
    const activateConfig = vi.fn();
    const { operations } = setupOperations(storage, activateConfig);
    try {
      await expect(
        operations.execute(principal, {
          kind: "stored_caplet_bundle_import",
          id: "bad",
          sources: [badSource],
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
      expect(cancelled).toBe(1);
      expect(activateConfig).not.toHaveBeenCalled();

      const imported = await operations.execute(principal, {
        kind: "stored_caplet_bundle_import",
        id: "committed",
        sources: [source("CAPLET.md", document("first"))],
      });
      activateConfig.mockRejectedValueOnce(activationFailure);
      await expect(
        operations.execute(principal, {
          kind: "stored_caplet_update",
          id: "committed",
          historyLimit: 2,
          expectedGeneration: imported.record.headGeneration,
        }),
      ).rejects.toBe(activationFailure);
      await expect(storage.caplets.get("committed")).resolves.toMatchObject({
        historyLimit: 2,
        headGeneration: 2,
      });
      expect(activateConfig).toHaveBeenCalledTimes(2);
    } finally {
      await storage.close();
    }
  });

  it("creates exact installation paths and activates only after create and replace commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-current-host-installation-put-"));
    roots.push(root);
    const storage = await createHostStorage({ type: "sqlite", path: join(root, "host.sqlite3") });
    const committedStates: Array<{ key: string; status: string }> = [];
    const activateConfig = vi.fn(async () => {
      const active = await storage.installations.getActive("installed");
      const latest = await storage.installations.getLatest("installed");
      const visible = active ?? latest;
      if (visible) committedStates.push({ key: visible.installationKey, status: visible.status });
    });
    const { operations } = setupOperations(storage, activateConfig);
    try {
      await operations.execute(principal, {
        kind: "stored_caplet_bundle_import",
        id: "installed",
        sources: [source("CAPLET.md", document("first"))],
      });
      activateConfig.mockClear();
      committedStates.length = 0;

      const created = await operations.execute(principal, {
        kind: "stored_caplet_installation_put",
        id: "installed",
        installationKey: "installation_path_key",
        createOnly: true,
        sourceKind: "git",
        sourceIdentity: "https://example.com/caplets.git",
        channel: "stable",
      });
      expect(created).toMatchObject({
        kind: "stored_caplet_installation_put",
        status: "created",
        installation: {
          installationKey: "installation_path_key",
          capletId: "installed",
          status: "active",
          generation: 1,
        },
      });
      expect(committedStates).toEqual([{ key: "installation_path_key", status: "active" }]);

      await operations.execute(principal, {
        kind: "stored_caplet_installation_delete",
        id: "installed",
        installationKey: "installation_path_key",
        expectedGeneration: 1,
      });
      committedStates.length = 0;
      activateConfig.mockClear();

      const replaced = await operations.execute(principal, {
        kind: "stored_caplet_installation_put",
        id: "installed",
        installationKey: "installation_path_key",
        expectedGeneration: 2,
        sourceKind: "git",
        sourceIdentity: "https://example.com/caplets-v2.git",
      });
      expect(replaced).toMatchObject({
        kind: "stored_caplet_installation_put",
        status: "replaced",
        installation: { capletId: "installed", status: "active", generation: 1 },
      });
      if (replaced.status !== "replaced") throw new Error("Expected installation replacement.");
      expect(replaced.installation.installationKey).not.toBe("installation_path_key");
      expect(committedStates).toEqual([
        { key: replaced.installation.installationKey, status: "active" },
      ]);
      expect(activateConfig).toHaveBeenCalledTimes(1);
    } finally {
      await storage.close();
    }
  });

  it("threads observation sort and cursors through semantic operations", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-current-host-observation-pages-"));
    roots.push(root);
    const storage = await createHostStorage({ type: "sqlite", path: join(root, "host.sqlite3") });
    const { operations } = setupOperations(storage);
    try {
      await operations.execute(principal, {
        kind: "stored_caplet_bundle_import",
        id: "observed",
        sources: [source("CAPLET.md", document("first"))],
      });
      await operations.execute(principal, {
        kind: "stored_caplet_installation_put",
        id: "observed",
        installationKey: "installation_observed",
        createOnly: true,
        sourceKind: "git",
        sourceIdentity: "https://example.com/caplets.git",
      });

      const observations = [];
      for (let generation = 1; generation <= 3; generation += 1) {
        const outcome = await operations.execute(principal, {
          kind: "stored_caplet_installation_observe",
          id: "observed",
          expectedGeneration: generation,
          status: "metadata-only",
          resolvedRevision: `revision-${generation}`,
        });
        observations.push(outcome.observation.observationKey);
      }

      const ascendingFirst = await operations.execute(principal, {
        kind: "stored_caplet_installation_observations_page",
        id: "observed",
        limit: 2,
        sort: "asc",
      });
      const ascendingSecond = await operations.execute(principal, {
        kind: "stored_caplet_installation_observations_page",
        id: "observed",
        limit: 2,
        sort: "asc",
        after: ascendingFirst.page.nextKey,
      });
      expect([...ascendingFirst.page.items, ...ascendingSecond.page.items]).toEqual(
        observations.map((observationKey) => expect.objectContaining({ observationKey })),
      );

      const descendingFirst = await operations.execute(principal, {
        kind: "stored_caplet_installation_observations_page",
        id: "observed",
        limit: 2,
        sort: "desc",
      });
      const descendingSecond = await operations.execute(principal, {
        kind: "stored_caplet_installation_observations_page",
        id: "observed",
        limit: 2,
        sort: "desc",
        after: descendingFirst.page.nextKey,
      });
      expect([...descendingFirst.page.items, ...descendingSecond.page.items]).toEqual(
        [...observations]
          .reverse()
          .map((observationKey) => expect.objectContaining({ observationKey })),
      );

      await expect(
        operations.execute(principal, {
          kind: "stored_caplet_installation_observations_page",
          id: "missing",
          limit: 2,
          sort: "asc",
        }),
      ).rejects.toMatchObject({ code: "CONFIG_NOT_FOUND" });
    } finally {
      await storage.close();
    }
  });

  it("binds installation path keys and returns guarded installation replacements", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-current-host-installations-"));
    roots.push(root);
    const storage = await createHostStorage({ type: "sqlite", path: join(root, "host.sqlite3") });
    const { operations, activateConfig } = setupOperations(storage);
    try {
      await operations.execute(principal, {
        kind: "stored_caplet_bundle_import",
        id: "installed",
        sources: [source("CAPLET.md", document("first"))],
        sourceRevision: "revision-1",
        sourceContentHash: "content-1",
        installation: {
          sourceKind: "git",
          sourceIdentity: "https://example.com/caplets.git",
        },
      });
      const page = await operations.execute(principal, {
        kind: "stored_caplet_installations_page",
        id: "installed",
        limit: 1,
        sort: "asc",
      });
      const original = page.page.items[0]!;
      await expect(
        operations.execute(principal, {
          kind: "stored_caplet_installation_get",
          id: "installed",
          installationKey: original.installationKey,
        }),
      ).resolves.toMatchObject({
        kind: "stored_caplet_installation_get",
        status: "found",
        installation: { installationKey: original.installationKey, generation: 1 },
      });
      await expect(
        operations.execute(principal, {
          kind: "stored_caplet_installation_get",
          id: "other",
          installationKey: original.installationKey,
        }),
      ).resolves.toEqual({
        kind: "stored_caplet_installation_get",
        status: "not_found",
        id: "other",
        installationKey: original.installationKey,
      });

      const detached = await operations.execute(principal, {
        kind: "stored_caplet_installation_delete",
        id: "installed",
        installationKey: original.installationKey,
        expectedGeneration: 1,
      });
      expect(detached).toMatchObject({
        kind: "stored_caplet_installation_delete",
        status: "detached",
        installation: {
          installationKey: original.installationKey,
          generation: 2,
          status: "detached",
        },
      });
      await expect(
        operations.execute(principal, {
          kind: "stored_caplet_installation_delete",
          id: "installed",
          installationKey: original.installationKey,
          expectedGeneration: 1,
        }),
      ).rejects.toMatchObject({ details: { kind: "stale_generation" } });

      const replaced = await operations.execute(principal, {
        kind: "stored_caplet_installation_put",
        id: "installed",
        installationKey: original.installationKey,
        expectedGeneration: 2,
        sourceKind: "git",
        sourceIdentity: "https://example.com/caplets-v2.git",
        channel: "stable",
      });
      if (replaced.status !== "replaced") throw new Error("Expected installation replacement.");
      expect(replaced).toMatchObject({
        kind: "stored_caplet_installation_put",
        status: "replaced",
        installation: {
          capletId: "installed",
          generation: 1,
          status: "active",
          sourceIdentity: "https://example.com/caplets-v2.git",
        },
      });
      await expect(
        operations.execute(principal, {
          kind: "stored_caplet_installation_get",
          id: "installed",
        }),
      ).resolves.toMatchObject({
        kind: "stored_caplet_installation_get",
        status: "found",
        installation: {
          installationKey: replaced.installation.installationKey,
          generation: 1,
          status: "active",
        },
      });
      const observed = await operations.execute(principal, {
        kind: "stored_caplet_installation_observe",
        id: "installed",
        expectedGeneration: 1,
        status: "current",
        resolvedRevision: "revision-2",
        contentHash: "content-2",
      });
      expect(observed).toMatchObject({
        kind: "stored_caplet_installation_observe",
        observation: { status: "current", resolvedRevision: "revision-2" },
        installation: { generation: 2 },
      });
      await expect(
        operations.execute(principal, {
          kind: "stored_caplet_installation_status",
          id: "installed",
        }),
      ).resolves.toMatchObject({
        kind: "stored_caplet_installation_status",
        installations: [
          { installationKey: replaced.installation.installationKey, status: "active" },
          { installationKey: original.installationKey, status: "detached" },
        ],
        observations: [
          { installationKey: replaced.installation.installationKey, status: "current" },
        ],
      });
      await expect(
        operations.execute(principal, {
          kind: "stored_caplet_installation_observe",
          id: "installed",
          expectedGeneration: 1,
          status: "current",
        }),
      ).rejects.toMatchObject({ details: { kind: "stale_generation" } });
      expect(await storage.coordination.currentConfigGeneration()).toBe(3);
      const mutationActivity = (
        await storage.operatorActivity.listPage({ limit: 20 })
      ).items.filter((entry) =>
        [
          "caplet.import",
          "caplet.detach",
          "caplet.replace_installation",
          "caplet.observe_source",
        ].includes(entry.action),
      );
      expect(mutationActivity).toHaveLength(4);
      expect(activateConfig).toHaveBeenCalledTimes(3);
    } finally {
      await storage.close();
    }
  });

  it("returns and durably replays an exact 412 when bundle create-only targets an existing Record", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-existing-record-bundle-"));
    roots.push(root);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(root, "host.sqlite3"),
    });
    const admission = new AdminBundleUploadAdmissionController({ stagingDir: root });
    const { operations, activateConfig } = setupOperations(storage);
    const file = Buffer.from(document("replacement"));
    const manifest = {
      version: 1,
      files: [
        {
          path: "CAPLET.md",
          size: file.byteLength,
          sha256: createHash("sha256").update(file).digest("hex"),
          executable: false,
        },
      ],
    };
    const boundary = "existing-record-bundle";
    const upload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\n\r\n${JSON.stringify(manifest)}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ignored"\r\n` +
          "Content-Type: application/octet-stream\r\n\r\n",
      ),
      file,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const requestHeaders = {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(upload.byteLength),
      "Idempotency-Key": "existing-record-bundle",
      "If-None-Match": "*",
    };

    try {
      await storage.caplets.importBundle({
        id: "existing",
        operator: { clientId: "fixture", role: "operator" },
        files: [
          {
            path: "CAPLET.md",
            content: Buffer.from(document("original")),
            executable: false,
          },
        ],
      });
      const app = createAdminV2Router({
        operations,
        principalProvider: async () => principal,
        idempotencyStore: storage.idempotency,
        bundleUploadAdmission: admission,
        host: {
          baseUrl: "https://host.example",
          dashboardUrl: "https://host.example/dashboard",
          dashboardPath: "/dashboard",
          bind: "127.0.0.1:5387",
        },
      });
      const first = await app.request("https://host.example/caplet-records/existing/bundle", {
        method: "PUT",
        headers: requestHeaders,
        body: upload,
      });
      const firstBody = await first.text();
      const replay = await app.request("https://host.example/caplet-records/existing/bundle", {
        method: "PUT",
        headers: requestHeaders,
        body: upload,
      });
      const expectedProblem = {
        type: "urn:caplets:problem:precondition-failed",
        title: "Precondition failed",
        status: 412,
        detail: "The resource was created before this create-only mutation committed.",
        code: "PRECONDITION_FAILED",
      };

      expect(first.status).toBe(412);
      expect(first.headers.get("content-type")).toBe("application/problem+json");
      expect(JSON.parse(firstBody)).toEqual(expectedProblem);
      expect(replay.status).toBe(412);
      expect(replay.headers.get("content-type")).toBe("application/problem+json");
      expect(replay.headers.get("idempotency-replayed")).toBe("true");
      expect(await replay.json()).toEqual(expectedProblem);
      await expect(storage.caplets.get("existing")).resolves.toMatchObject({
        id: "existing",
        headGeneration: 1,
        currentRevision: { name: "Stored" },
      });
      expect(activateConfig).not.toHaveBeenCalled();
    } finally {
      await admission.close();
      await storage.close();
    }
  });
});
