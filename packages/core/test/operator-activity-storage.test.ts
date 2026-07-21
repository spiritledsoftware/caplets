import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHostStorage } from "../src/storage";
import {
  OperatorActivityStore,
  type OperatorActivityPageKey,
} from "../src/storage/operator-activity";

describe("OperatorActivityStore", () => {
  it("appends and deterministically pages safe SQL activity across SQLite instances", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-operator-activity-"));
    const path = join(directory, "caplets.sqlite3");
    const firstStorage = await createHostStorage({ type: "sqlite", path });
    const secondStorage = await createHostStorage({ type: "sqlite", path });
    const first = new OperatorActivityStore(firstStorage.database);
    const second = new OperatorActivityStore(secondStorage.database);

    try {
      const oldest = await first.append({
        actorClientId: "operator-1",
        action: "vault_set",
        target: { type: "vault", id: "GH_TOKEN", label: "GitHub token" },
        metadata: {
          bytesWritten: 42,
          secretValue: "must-not-appear",
          note: "cap_remote_access_must-not-appear",
        },
        now: new Date("2026-07-18T10:00:00.000Z"),
      });
      const middle = await first.append({
        actorClientId: "operator-1",
        action: "caplet.install",
        outcome: "failure",
        target: { type: "installation", id: "installation-1" },
        now: new Date("2026-07-18T10:01:00.000Z"),
      });

      await expect(second.list()).resolves.toMatchObject({
        entries: [
          { id: middle.id, action: "caplet.install", outcome: "failure" },
          {
            id: oldest.id,
            action: "vault_set",
            outcome: "success",
            target: { type: "vault", id: "GH_TOKEN", label: "GitHub token" },
            metadata: { bytesWritten: 42 },
          },
        ],
      });

      const newest = await second.append({
        actorClientId: "operator-2",
        action: "vault_set",
        target: { type: "vault", id: "NPM_TOKEN" },
        now: new Date("2026-07-18T10:02:00.000Z"),
      });
      const firstPage = await first.list({ limit: 2 });
      expect(firstPage).toEqual({
        entries: [newest, middle],
        nextCursor: middle.id,
      });
      await expect(first.list({ limit: 2, after: firstPage.nextCursor })).resolves.toEqual({
        entries: [oldest],
      });
      await expect(first.list({ action: "vault_set" })).resolves.toEqual({
        entries: [newest, oldest],
      });
      await expect(first.list({ action: "caplet.install" })).resolves.toEqual({
        entries: [middle],
      });

      for (let index = 0; index < 501; index += 1) {
        await first.append({
          actorClientId: "bulk-operator",
          action: "bulk.activity",
          target: { type: "bulk", id: String(index) },
          now: new Date(1_000 + index),
        });
      }
      const boundedPage = await first.list({ limit: 10_000 });
      expect(boundedPage.entries).toEqual(expect.arrayContaining([newest, middle, oldest]));
      expect(boundedPage.entries).toHaveLength(500);
      expect((await first.list({ limit: 0 })).entries).toHaveLength(1);
    } finally {
      await secondStorage.close();
      await firstStorage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("traverses stable timestamp ties with bounded keyset pages and action filters", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-operator-activity-page-"));
    const path = join(directory, "caplets.sqlite3");
    const storage = await createHostStorage({ type: "sqlite", path });
    const activity = new OperatorActivityStore(storage.database);
    const tiedAt = "2026-07-20T12:00:00.000Z";
    const olderAt = "2026-07-20T11:59:00.000Z";
    const entries = [
      {
        id: "activity-c",
        createdAt: tiedAt,
        actorClientId: "operator-1",
        action: "vault_set",
        outcome: "success" as const,
        target: { type: "vault", id: "C" },
      },
      {
        id: "activity-b",
        createdAt: tiedAt,
        actorClientId: "operator-1",
        action: "catalog_updated",
        outcome: "success" as const,
        target: { type: "catalog", id: "B" },
      },
      {
        id: "activity-a",
        createdAt: tiedAt,
        actorClientId: "operator-1",
        action: "vault_set",
        outcome: "failure" as const,
        target: { type: "vault", id: "A" },
      },
      {
        id: "activity-z-older",
        createdAt: olderAt,
        actorClientId: "operator-1",
        action: "vault_set",
        outcome: "success" as const,
        target: { type: "vault", id: "Z" },
      },
    ];

    try {
      await activity.importLegacyEntries(entries);

      const traversed: string[] = [];
      let after: OperatorActivityPageKey | undefined;
      do {
        const page = await activity.listPage({ limit: 2, after });
        expect(page.items.length).toBeLessThanOrEqual(2);
        traversed.push(...page.items.map(({ id }) => id));
        after = page.nextKey;
      } while (after !== undefined);
      expect(traversed).toEqual(["activity-c", "activity-b", "activity-a", "activity-z-older"]);

      const ascending: string[] = [];
      after = undefined;
      do {
        const page = await activity.listPage({ limit: 2, sort: "asc", after });
        ascending.push(...page.items.map(({ id }) => id));
        after = page.nextKey;
      } while (after !== undefined);
      expect(ascending).toEqual(["activity-z-older", "activity-a", "activity-b", "activity-c"]);

      const filtered: string[] = [];
      after = undefined;
      do {
        const page = await activity.listPage({ action: "vault_set", limit: 1, after });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]?.action).toBe("vault_set");
        filtered.push(page.items[0]!.id);
        after = page.nextKey;
      } while (after !== undefined);
      expect(filtered).toEqual(["activity-c", "activity-a", "activity-z-older"]);
    } finally {
      await storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects invalid Operator Activity page limits", async () => {
    const storage = await createHostStorage({ type: "sqlite", path: ":memory:" });
    try {
      for (const limit of [0, 501, 1.5]) {
        await expect(storage.operatorActivity.listPage({ limit })).rejects.toMatchObject({
          code: "REQUEST_INVALID",
        });
      }
    } finally {
      await storage.close();
    }
  });
  it("persists only bounded nonempty action identifiers shared by the Admin filter", async () => {
    const storage = await createHostStorage({ type: "sqlite", path: ":memory:" });
    const input = {
      actorClientId: "operator-1",
      target: { type: "caplet_record", id: "record-1" },
    };
    try {
      await expect(
        storage.operatorActivity.append({ ...input, action: "backend_auth_flow_started" }),
      ).resolves.toMatchObject({ action: "backend_auth_flow_started" });
      await expect(
        storage.operatorActivity.append({ ...input, action: "caplet.rename" }),
      ).resolves.toMatchObject({ action: "caplet.rename" });
      await expect(
        storage.operatorActivity.append({ ...input, action: "a".repeat(128) }),
      ).resolves.toMatchObject({ action: "a".repeat(128) });
      for (const action of ["", "a".repeat(129), "invalid action"]) {
        await expect(storage.operatorActivity.append({ ...input, action })).rejects.toThrow(
          "Invalid Operator activity input.",
        );
      }
    } finally {
      await storage.close();
    }
  });
});
