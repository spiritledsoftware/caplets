import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCapletFileDocument } from "../src/caplet-files";
import { createHostStorage } from "../src/storage";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Caplet Record storage", () => {
  it("persists structured frontmatter and body as a current revision", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-records-"));
    directories.push(directory);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(directory, "caplets.sqlite3"),
    });

    try {
      const created = await storage.caplets.importBundle({
        id: "github",
        operator: { clientId: "operator_test", role: "operator" },
        files: [
          {
            path: "CAPLET.md",
            executable: false,
            content: Buffer.from(
              `---
      +name: GitHub
      +description: Manage GitHub repositories and issues.
      +tags: [source-control, issues]
      +mcpServer:
      +  command: github-mcp
      +---
      +
      +# GitHub
      +
      +Operator notes.
      +`.replace(/^ {6}\+/gmu, ""),
            ),
          },
        ],
      });

      expect(created).toMatchObject({
        id: "github",
        headGeneration: 1,
        currentRevision: {
          sequence: 1,
          name: "GitHub",
          description: "Manage GitHub repositories and issues.",
          body: "\n# GitHub\n\nOperator notes.\n",
          tags: ["source-control", "issues"],
          backends: [{ family: "mcpServer", childId: null, config: { command: "github-mcp" } }],
          bundle: [],
        },
      });
      expect(created.recordKey).toMatch(/^[0-9a-f-]{36}$/u);
      await expect(storage.caplets.get("github")).resolves.toEqual(created);
    } finally {
      await storage.close();
    }
  });

  it("round-trips ordered backend children and deduplicated executable bundle assets", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-records-"));
    directories.push(directory);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(directory, "caplets.sqlite3"),
    });
    const sharedScript = Buffer.from("#!/bin/sh\necho ok\n");

    try {
      const first = await storage.caplets.importBundle({
        id: "sources",
        operator: { clientId: "operator_test", role: "operator" },
        files: [
          {
            path: "CAPLET.md",
            executable: false,
            content: Buffer.from(
              `---
      name: Sources
      description: Query source control and issue management systems.
      exposure: code_mode
      mcpServers:
        github:
          command: github-mcp
        linear:
          command: linear-mcp
      ---
      # Sources
      `.replace(/^ {6}/gmu, ""),
            ),
          },
          { path: "scripts/run.sh", executable: true, content: sharedScript },
          { path: "notes.txt", executable: false, content: Buffer.from("setup notes\n") },
        ],
      });
      await storage.caplets.importBundle({
        id: "runner",
        operator: { clientId: "operator_test", role: "operator" },
        files: [
          {
            path: "CAPLET.md",
            executable: false,
            content: Buffer.from(
              `---
      name: Runner
      description: Run the shared source control helper script.
      cliTools:
        actions:
          run:
            command: ./scripts/run.sh
      ---
      # Runner
      `.replace(/^ {6}/gmu, ""),
            ),
          },
          { path: "scripts/run.sh", executable: true, content: sharedScript },
        ],
      });

      expect(first.currentRevision).toMatchObject({
        content: { exposure: "code_mode" },
        backends: [
          { family: "mcpServers", childId: "github", config: { command: "github-mcp" } },
          { family: "mcpServers", childId: "linear", config: { command: "linear-mcp" } },
        ],
        bundle: [
          { path: "notes.txt", executable: false, size: 12 },
          { path: "scripts/run.sh", executable: true, size: sharedScript.byteLength },
        ],
      });
      await expect(storage.caplets.assetStats()).resolves.toEqual({ blobs: 2, entries: 3 });
      const destination = join(directory, "exports", "sources");
      await storage.caplets.exportBundle("sources", destination, {
        operator: { clientId: "operator_export", role: "operator" },
      });
      const exported = parseCapletFileDocument(
        join(destination, "CAPLET.md"),
        readFileSync(join(destination, "CAPLET.md"), "utf8"),
      );
      expect(exported).toMatchObject({
        frontmatter: {
          name: "Sources",
          description: "Query source control and issue management systems.",
          exposure: "code_mode",
          mcpServers: {
            github: { command: "github-mcp" },
            linear: { command: "linear-mcp" },
          },
        },
        body: "# Sources\n",
      });
      expect(readFileSync(join(destination, "scripts/run.sh"))).toEqual(sharedScript);
      expect(statSync(join(destination, "scripts/run.sh")).mode & 0o111).not.toBe(0);
      await expect(
        storage.caplets.exportBundle("sources", destination, {
          operator: { clientId: "operator_export", role: "operator" },
        }),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
      });
      await expect(
        storage.caplets.exportBundle("sources", destination, {
          operator: { clientId: "operator_export", role: "operator" },
          replace: true,
        }),
      ).resolves.toBe(undefined);
    } finally {
      await storage.close();
    }
  });

  it("rejects stale updates and prunes revisions to the configured retention count", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-records-"));
    directories.push(directory);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(directory, "caplets.sqlite3"),
    });
    const files = (name: string) => [
      {
        path: "CAPLET.md",
        executable: false,
        content: Buffer.from(`---
name: ${name}
description: Manage retained Caplet revision history safely.
mcpServer:
  command: history-mcp
---
# ${name}
`),
      },
    ];

    try {
      await storage.caplets.importBundle({
        id: "history",
        operator: { clientId: "operator_create", role: "operator" },
        historyLimit: 2,
        files: files("Revision One"),
      });
      const second = await storage.caplets.updateBundle({
        id: "history",
        operator: { clientId: "operator_update", role: "operator" },
        expectedGeneration: 1,
        files: files("Revision Two"),
      });
      expect(second).toMatchObject({
        headGeneration: 2,
        currentRevision: { sequence: 2, name: "Revision Two" },
      });
      await expect(
        storage.caplets.updateBundle({
          id: "history",
          operator: { clientId: "operator_stale", role: "operator" },
          expectedGeneration: 1,
          files: files("Stale Revision"),
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID", details: { kind: "stale_generation" } });
      const third = await storage.caplets.updateBundle({
        id: "history",
        operator: { clientId: "operator_update", role: "operator" },
        expectedGeneration: 2,
        files: files("Revision Three"),
      });
      await expect(
        storage.caplets.listRevisions("history", {
          clientId: "operator_history",
          role: "operator",
        }),
      ).resolves.toMatchObject([
        { sequence: 3, name: "Revision Three" },
        { sequence: 2, name: "Revision Two" },
      ]);
      await expect(
        storage.caplets.deleteRevision({
          id: "history",
          operator: { clientId: "operator_update", role: "operator" },
          revisionKey: third.currentRevision.revisionKey,
          expectedGeneration: 3,
        }),
      ).resolves.toMatchObject({
        headGeneration: 4,
        currentRevision: { sequence: 2, name: "Revision Two" },
      });
      const restored = await storage.caplets.restoreRevision({
        id: "history",
        operator: { clientId: "operator_restore", role: "operator" },
        revisionKey: second.currentRevision.revisionKey,
        expectedGeneration: 4,
      });
      expect(restored).toMatchObject({
        headGeneration: 5,
        currentRevision: { sequence: 5, name: "Revision Two" },
      });
      const retained = await storage.caplets.setRetention({
        id: "history",
        operator: { clientId: "operator_retention", role: "operator" },
        historyLimit: 1,
        expectedGeneration: 5,
      });
      expect(retained).toMatchObject({ headGeneration: 6, historyLimit: 1 });
      await expect(
        storage.caplets.listRevisions("history", {
          clientId: "operator_history",
          role: "operator",
        }),
      ).resolves.toHaveLength(1);
      const renamed = await storage.caplets.rename({
        id: "history",
        newId: "history-renamed",
        operator: { clientId: "operator_rename", role: "operator" },
        expectedGeneration: 6,
      });
      expect(renamed).toMatchObject({ id: "history-renamed", headGeneration: 7 });
      await storage.caplets.hardDelete({
        id: "history-renamed",
        operator: { clientId: "operator_delete", role: "operator" },
        expectedGeneration: 7,
      });
      await expect(storage.caplets.get("history-renamed")).resolves.toBeUndefined();
    } finally {
      await storage.close();
    }
  });

  it("imports a batch atomically when a later record collides", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-records-"));
    directories.push(directory);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(directory, "caplets.sqlite3"),
    });
    const input = (id: string) => ({
      id,
      operator: { clientId: "operator_import", role: "operator" as const },
      files: [
        {
          path: "CAPLET.md",
          executable: false,
          content: Buffer.from(
            `---
    name: ${id}
    description: Import ${id} through an atomic batch operation.
    mcpServer:
      command: ${id}-mcp
    ---
    # ${id}
    `.replace(/^ {4}/gmu, ""),
          ),
        },
      ],
    });

    try {
      await storage.caplets.importBundle(input("existing"));
      await expect(
        storage.caplets.importBundles([input("new-record"), input("existing")]),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      await expect(storage.caplets.get("new-record")).resolves.toBeUndefined();
      await expect(
        storage.caplets.importBundles([input("new-record"), input("second-record")]),
      ).resolves.toMatchObject([{ id: "new-record" }, { id: "second-record" }]);
    } finally {
      await storage.close();
    }
  });

  it("updates source-tracked records and preserves same-content provenance atomically", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-source-update-"));
    directories.push(directory);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(directory, "caplets.sqlite3"),
    });
    const operator = { clientId: "operator_source", role: "operator" } as const;
    const files = (name: string) => [
      {
        path: "CAPLET.md",
        executable: false,
        content: Buffer.from(`---
name: ${name}
description: Manage source-tracked Caplet updates transactionally.
mcpServer:
  command: source-mcp
---
# ${name}
`),
      },
    ];

    try {
      const created = await storage.caplets.importBundle({
        id: "tracked",
        files: files("Revision One"),
        historyLimit: 2,
        sourceRevision: "source-v1",
        sourceContentHash: "source-hash-v1",
        installation: {
          sourceKind: "catalog",
          sourceIdentity: "official/tracked",
          channel: "stable",
          risk: { level: "low" },
        },
        operator,
      });
      expect(await storage.installations.getLatestObservation("tracked")).toMatchObject({
        resolvedRevision: "source-v1",
        contentHash: "source-hash-v1",
        status: "current",
        risk: { level: "low" },
      });

      await expect(
        storage.caplets.updateFromSource({
          id: "tracked",
          files: files("Revision Two"),
          expectedGeneration: 0,
          expectedInstallationGeneration: 1,
          sourceRevision: "source-v2",
          sourceContentHash: "source-hash-v2",
          observationStatus: "current",
          risk: { level: "medium" },
          operator,
        }),
      ).rejects.toMatchObject({ details: { kind: "stale_generation" } });
      await expect(
        storage.caplets.updateFromSource({
          id: "tracked",
          files: files("Revision Two"),
          expectedGeneration: 1,
          expectedInstallationGeneration: 0,
          sourceRevision: "source-v2",
          sourceContentHash: "source-hash-v2",
          observationStatus: "current",
          risk: { level: "medium" },
          operator,
        }),
      ).rejects.toMatchObject({ details: { kind: "stale_generation" } });
      await expect(storage.installations.listObservations("tracked")).resolves.toHaveLength(1);
      await expect(storage.installations.getActive("tracked")).resolves.toMatchObject({
        generation: 1,
      });

      const changed = await storage.caplets.updateFromSource({
        id: "tracked",
        files: files("Revision Two"),
        expectedGeneration: 1,
        expectedInstallationGeneration: 1,
        sourceRevision: "source-v2",
        sourceContentHash: "source-hash-v2",
        observationStatus: "current",
        risk: { level: "medium" },
        operator,
      });
      expect(changed).toMatchObject({
        headGeneration: 2,
        currentRevision: { sequence: 2, name: "Revision Two" },
      });
      await expect(storage.installations.getActive("tracked")).resolves.toMatchObject({
        generation: 2,
      });
      await expect(storage.coordination.currentConfigGeneration()).resolves.toBe(2);

      const sameContent = await storage.caplets.updateFromSource({
        id: "tracked",
        files: files("Revision Two"),
        expectedGeneration: 2,
        expectedInstallationGeneration: 2,
        sourceRevision: "source-v2-metadata",
        sourceContentHash: "source-hash-v2",
        observationStatus: "metadata-only",
        risk: { level: "high" },
        operator,
      });
      expect(sameContent).toMatchObject({
        headGeneration: 3,
        currentRevision: {
          revisionKey: changed.currentRevision.revisionKey,
          sequence: 2,
        },
      });
      await expect(storage.caplets.listRevisions("tracked", operator)).resolves.toMatchObject([
        { sequence: 3, name: "Revision Two" },
        { sequence: 2, name: "Revision Two" },
      ]);
      await expect(storage.installations.getLatestObservation("tracked")).resolves.toMatchObject({
        resolvedRevision: "source-v2-metadata",
        status: "metadata-only",
        risk: { level: "high" },
      });
      await expect(storage.installations.getActive("tracked")).resolves.toMatchObject({
        generation: 3,
      });
      await expect(storage.coordination.currentConfigGeneration()).resolves.toBe(2);

      const noHistory = await storage.caplets.importBundle({
        id: "no-history",
        files: files("Unchanged"),
        historyLimit: 0,
        sourceRevision: "source-v1",
        sourceContentHash: "source-hash-v1",
        installation: {
          sourceKind: "catalog",
          sourceIdentity: "official/no-history",
          risk: null,
        },
        operator,
      });
      const observedOnly = await storage.caplets.updateFromSource({
        id: "no-history",
        files: files("Unchanged"),
        expectedGeneration: 1,
        expectedInstallationGeneration: 1,
        sourceRevision: "source-v1-metadata",
        sourceContentHash: "source-hash-v1",
        observationStatus: "metadata-only",
        operator,
      });
      expect(observedOnly).toMatchObject({
        headGeneration: 1,
        currentRevision: { revisionKey: noHistory.currentRevision.revisionKey },
      });
      await expect(storage.caplets.listRevisions("no-history", operator)).resolves.toHaveLength(1);
      await expect(storage.installations.listObservations("no-history")).resolves.toHaveLength(2);
      await expect(storage.installations.getActive("no-history")).resolves.toMatchObject({
        generation: 2,
      });

      expect((await storage.installations.listActivity()).map((entry) => entry.action)).toEqual(
        expect.arrayContaining(["caplet.source_update"]),
      );
      expect(created.recordKey).toBe(changed.recordKey);
    } finally {
      await storage.close();
    }
  });
});
