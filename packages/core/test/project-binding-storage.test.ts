import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostStorage } from "../src/storage/database";
import { ProjectBindingStore } from "../src/storage/project-bindings";
import * as sqlite from "../src/storage/schema/sqlite";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQL Project Binding metadata", () => {
  it("creates, heartbeats, quarantines, and explicitly rebinds with CAS fencing", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-project-binding-state-"));
    directories.push(root);
    const firstStorage = await createHostStorage({
      type: "sqlite",
      path: join(root, "caplets.sqlite3"),
    });
    let now = new Date("2026-07-18T12:00:00.000Z");
    const first = new ProjectBindingStore(firstStorage.database, {
      now: () => now,
      leaseTtlMs: 60_000,
    });
    const second = new ProjectBindingStore(firstStorage.database, {
      now: () => now,
      leaseTtlMs: 60_000,
    });

    try {
      const created = await first.create({
        bindingId: "binding-1",
        sessionId: "session-1",
        projectFingerprint: "sha256:project",
        projectRoot: "/client/project",
        serverProjectRoot: "/host/workspaces/project",
        ownerNodeId: "node-a",
      });
      expect(created).toMatchObject({
        bindingId: "binding-1",
        ownerNodeId: "node-a",
        generation: 1,
        revision: 1,
        state: "attaching",
        readiness: "not_ready",
        active: true,
      });

      now = new Date("2026-07-18T12:00:10.000Z");
      const ready = await second.heartbeat({
        bindingId: "binding-1",
        ownerNodeId: "node-a",
        sessionId: "session-1",
        expectedGeneration: created.generation,
        state: "ready",
        syncState: "idle",
      });
      expect(ready).toMatchObject({
        generation: 2,
        revision: 2,
        state: "ready",
        readiness: "ready",
        lastHeartbeatAt: now.toISOString(),
      });
      expect(Date.parse(ready.expiresAt)).toBe(now.getTime() + 60_000);

      await expect(
        first.heartbeat({
          bindingId: "binding-1",
          ownerNodeId: "node-a",
          expectedGeneration: 1,
          state: "degraded",
          syncState: "failed",
        }),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
        details: expect.objectContaining({ kind: "stale_generation" }),
      });

      now = new Date("2026-07-18T12:00:20.000Z");
      const quarantined = await first.quarantineOwnerLoss({
        bindingId: "binding-1",
        ownerNodeId: "node-a",
        expectedGeneration: ready.generation,
      });
      expect(quarantined).toMatchObject({
        ownerNodeId: "node-a",
        generation: 3,
        revision: 3,
        state: "offline",
        readiness: "quarantined",
        active: false,
        quarantineReason: "owner_lost",
        quarantinedAt: now.toISOString(),
      });

      await expect(
        second.rebind({
          bindingId: "binding-1",
          expectedGeneration: ready.generation,
          newOwnerNodeId: "node-b",
          operatorClientId: "operator-1",
        }),
      ).rejects.toMatchObject({
        code: "REQUEST_INVALID",
        details: expect.objectContaining({ kind: "stale_generation" }),
      });

      now = new Date("2026-07-18T12:00:30.000Z");
      const rebound = await second.rebind({
        bindingId: "binding-1",
        expectedGeneration: quarantined.generation,
        newOwnerNodeId: "node-b",
        sessionId: "session-2",
        operatorClientId: "operator-1",
      });
      expect(rebound).toMatchObject({
        ownerNodeId: "node-b",
        sessionId: "session-2",
        generation: 4,
        revision: 4,
        state: "attaching",
        syncState: "pending",
        readiness: "not_ready",
        active: true,
      });
      expect(rebound).not.toHaveProperty("quarantinedAt");
      expect(rebound).not.toHaveProperty("quarantineReason");

      await expect(
        first.heartbeat({
          bindingId: "binding-1",
          ownerNodeId: "node-a",
          expectedGeneration: rebound.generation,
          state: "ready",
          syncState: "idle",
        }),
      ).rejects.toMatchObject({ code: "AUTH_FAILED" });
      await expect(first.get("binding-1")).resolves.toEqual(rebound);

      const activity = await firstStorage.installations.listActivity();
      expect(activity).toMatchObject([
        {
          operatorClientId: "operator-1",
          action: "project_binding.rebind",
          targetKind: "project_binding",
          targetKey: "binding-1",
        },
      ]);

      const expiring = await first.create({
        bindingId: "binding-expiring",
        sessionId: "session-expiring",
        projectFingerprint: "sha256:expiring",
        projectRoot: "/client/expiring",
        serverProjectRoot: "/host/workspaces/expiring",
        ownerNodeId: "node-a",
        leaseTtlMs: 1_000,
      });
      now = new Date(now.getTime() + 1_001);
      await expect(
        second.heartbeat({
          bindingId: expiring.bindingId,
          ownerNodeId: expiring.ownerNodeId,
          expectedGeneration: expiring.generation,
          state: "ready",
          syncState: "idle",
        }),
      ).rejects.toMatchObject({
        projectBindingCode: "lease_expired",
      });
      if (firstStorage.database.dialect !== "sqlite") {
        throw new Error("Expected SQLite storage.");
      }
      expect(
        await firstStorage.database.db.select().from(sqlite.projectBindings).all(),
      ).toHaveLength(2);
    } finally {
      await firstStorage.close();
    }
  });
  it("reports whether an unexpired active lease exists at a point in time", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-project-binding-active-"));
    directories.push(root);
    const storage = await createHostStorage({
      type: "sqlite",
      path: join(root, "caplets.sqlite3"),
    });
    let now = new Date("2026-07-18T12:00:00.000Z");
    const bindings = new ProjectBindingStore(storage.database, {
      now: () => now,
      leaseTtlMs: 1_000,
    });

    try {
      const expired = await bindings.create({
        bindingId: "binding-expired",
        sessionId: "session-expired",
        projectFingerprint: "sha256:expired",
        projectRoot: "/client/expired",
        serverProjectRoot: "/host/expired",
        ownerNodeId: "node-a",
      });
      expect(await bindings.existsActive(now)).toBe(true);
      expect(await bindings.existsActive(new Date(expired.expiresAt))).toBe(false);

      now = new Date("2026-07-18T12:01:00.000Z");
      const active = await bindings.create({
        bindingId: "binding-active",
        sessionId: "session-active",
        projectFingerprint: "sha256:active",
        projectRoot: "/client/active",
        serverProjectRoot: "/host/active",
        ownerNodeId: "node-a",
      });
      expect(await bindings.existsActive(now)).toBe(true);

      await bindings.end({
        bindingId: active.bindingId,
        ownerNodeId: active.ownerNodeId,
        expectedGeneration: active.generation,
      });
      expect(await bindings.existsActive(now)).toBe(false);
    } finally {
      await storage.close();
    }
  });
});
