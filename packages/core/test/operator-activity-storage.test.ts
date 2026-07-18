import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHostStorage } from "../src/storage";
import { OperatorActivityStore } from "../src/storage/operator-activity";

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
});
