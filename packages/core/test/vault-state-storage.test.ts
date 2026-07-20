import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createHostStorage, type HostStorage } from "../src/storage";
import { VaultStateStore } from "../src/storage/vault-state";
import { VaultGrantStore, type VaultGrantInput } from "../src/storage/vault-grants";
import { VaultValueStore } from "../src/storage/vault-values";
import type { HostDatabase } from "../src/storage/types";

type SqliteHostDatabase = Extract<HostDatabase, { dialect: "sqlite" }>;

type VaultStateFixture = {
  directory: string;
  storage: HostStorage;
  database: SqliteHostDatabase;
  state: VaultStateStore;
  values: VaultValueStore;
  grants: VaultGrantStore;
};

const operator = { clientId: "operator-vault-state", role: "operator" } as const;

function fileGrant(vaultKey: string, capletId: string): VaultGrantInput {
  return {
    capletId,
    vaultKey,
    referenceName: "TOKEN",
    originKind: "project-file",
    originPath: `/project/.caplets/${capletId}.md`,
    operator,
  };
}

async function openFixture(): Promise<VaultStateFixture> {
  const directory = mkdtempSync(join(tmpdir(), "caplets-vault-state-"));
  const storage = await createHostStorage({
    type: "sqlite",
    path: join(directory, "caplets.sqlite3"),
  });
  if (storage.database.dialect !== "sqlite") throw new Error("Expected SQLite storage");
  const database = storage.database;
  const options = {
    env: { CAPLETS_ENCRYPTION_KEY: Buffer.alloc(32, 29).toString("base64url") },
  };
  return {
    directory,
    storage,
    database,
    state: new VaultStateStore(database, options),
    values: new VaultValueStore(database, options),
    grants: new VaultGrantStore(database),
  };
}

async function closeFixture(fixture: VaultStateFixture): Promise<void> {
  await fixture.storage.close();
  rmSync(fixture.directory, { recursive: true, force: true });
}

describe("VaultStateStore", () => {
  it("rolls back a new value and its activity when grant insertion fails", async () => {
    const fixture = await openFixture();
    try {
      fixture.database.db.run(
        sql.raw(`
          create temp trigger fail_vault_grant_insert
          before insert on vault_access_grants
          begin
            select raise(abort, 'injected grant insertion failure');
          end
        `),
      );

      await expect(
        fixture.state.setValueAndGrant({
          key: "NEW_SECRET",
          value: "new-secret-value",
          force: false,
          grant: fileGrant("NEW_SECRET", "new-secret-caplet"),
          operatorClientId: operator.clientId,
        }),
      ).rejects.toThrow("injected grant insertion failure");

      await expect(fixture.values.getStatus("NEW_SECRET")).resolves.toEqual({
        key: "NEW_SECRET",
        present: false,
      });
      await expect(fixture.grants.list()).resolves.toEqual([]);
      await expect(fixture.storage.operatorActivity.list()).resolves.toEqual({
        entries: [],
      });
    } finally {
      fixture.database.db.run(sql.raw("drop trigger if exists fail_vault_grant_insert"));
      await closeFixture(fixture);
    }
  });

  it("rolls back an old value, grant, and all activity when grant activity fails", async () => {
    const fixture = await openFixture();
    try {
      await fixture.values.set("EXISTING_SECRET", "original-secret", {
        expectedGeneration: 0,
      });
      fixture.database.db.run(
        sql.raw(`
          create temp trigger fail_vault_grant_activity
          before insert on operator_activity
          when new.action = 'vault.grant'
          begin
            select raise(abort, 'injected grant activity failure');
          end
        `),
      );

      await expect(
        fixture.state.setValueAndGrant({
          key: "EXISTING_SECRET",
          value: "replacement-secret",
          force: true,
          grant: fileGrant("EXISTING_SECRET", "existing-secret-caplet"),
          operatorClientId: operator.clientId,
        }),
      ).rejects.toThrow("injected grant activity failure");

      await expect(fixture.values.resolveValue("EXISTING_SECRET")).resolves.toBe("original-secret");
      await expect(fixture.values.getStatus("EXISTING_SECRET")).resolves.toMatchObject({
        present: true,
        generation: 1,
      });
      await expect(fixture.grants.list()).resolves.toEqual([]);
      await expect(fixture.storage.operatorActivity.list()).resolves.toEqual({
        entries: [],
      });
    } finally {
      fixture.database.db.run(sql.raw("drop trigger if exists fail_vault_grant_activity"));
      await closeFixture(fixture);
    }
  });

  it("commits a value, grant, and both activity records with one timestamp", async () => {
    const fixture = await openFixture();
    try {
      const status = await fixture.state.setValueAndGrant({
        key: "COMMITTED_SECRET",
        value: "committed-secret",
        force: false,
        grant: fileGrant("COMMITTED_SECRET", "committed-secret-caplet"),
        operatorClientId: operator.clientId,
      });

      expect(status).toMatchObject({
        key: "COMMITTED_SECRET",
        present: true,
        generation: 1,
      });
      expect(status.createdAt).toBe(status.updatedAt);
      await expect(fixture.values.resolveValue("COMMITTED_SECRET")).resolves.toBe(
        "committed-secret",
      );
      await expect(fixture.grants.list("committed-secret-caplet")).resolves.toEqual([
        expect.objectContaining({
          capletId: "committed-secret-caplet",
          vaultKey: "COMMITTED_SECRET",
          referenceName: "TOKEN",
          createdBy: operator.clientId,
          createdAt: status.updatedAt,
        }),
      ]);

      const activity = (await fixture.storage.operatorActivity.list()).entries;
      expect(activity.map((entry) => entry.action).sort()).toEqual([
        "vault.grant",
        "vault_value_written",
      ]);
      expect(new Set(activity.map((entry) => entry.createdAt))).toEqual(
        new Set([status.updatedAt]),
      );
    } finally {
      await closeFixture(fixture);
    }
  });

  it("uses the same atomic path when no grant is requested", async () => {
    const fixture = await openFixture();
    try {
      await expect(
        fixture.state.setValueAndGrant({
          key: "VALUE_ONLY",
          value: "value-only-secret",
          force: false,
          operatorClientId: operator.clientId,
        }),
      ).resolves.toMatchObject({ key: "VALUE_ONLY", present: true, generation: 1 });

      await expect(fixture.values.resolveValue("VALUE_ONLY")).resolves.toBe("value-only-secret");
      await expect(fixture.grants.list()).resolves.toEqual([]);
      const activity = (await fixture.storage.operatorActivity.list()).entries;
      expect(activity).toHaveLength(1);
      expect(activity[0]).toMatchObject({
        actorClientId: operator.clientId,
        action: "vault_value_written",
        metadata: { generation: 1 },
      });
    } finally {
      await closeFixture(fixture);
    }
  });

  it("serializes competing writers without exposing a losing grant or activity", async () => {
    const fixture = await openFixture();
    try {
      const inputs = [
        {
          key: "RACE_SECRET",
          value: "first-race-secret",
          force: false,
          grant: fileGrant("RACE_SECRET", "first-race-caplet"),
          operatorClientId: operator.clientId,
        },
        {
          key: "RACE_SECRET",
          value: "second-race-secret",
          force: false,
          grant: fileGrant("RACE_SECRET", "second-race-caplet"),
          operatorClientId: operator.clientId,
        },
      ] as const;

      const results = await Promise.allSettled(
        inputs.map((input) => fixture.state.setValueAndGrant(input)),
      );
      const winnerIndex = results.findIndex((result) => result.status === "fulfilled");
      expect(winnerIndex).toBeGreaterThanOrEqual(0);
      if (winnerIndex < 0) throw new Error("Expected one successful Vault writer");
      const winner = results[winnerIndex];
      if (!winner || winner.status !== "fulfilled") {
        throw new Error("Expected a fulfilled Vault writer result");
      }
      expect(winner.value.generation).toBe(1);
      const loser = results[1 - winnerIndex];
      expect(loser?.status).toBe("rejected");
      if (!loser || loser.status !== "rejected") {
        throw new Error("Expected one rejected Vault writer");
      }
      expect(loser.reason).toMatchObject({ code: "CONFIG_EXISTS" });

      await expect(fixture.values.resolveValue("RACE_SECRET")).resolves.toBe(
        inputs[winnerIndex]!.value,
      );
      await expect(fixture.grants.list()).resolves.toEqual([
        expect.objectContaining({
          capletId: inputs[winnerIndex]!.grant.capletId,
          vaultKey: "RACE_SECRET",
        }),
      ]);
      const activity = (await fixture.storage.operatorActivity.list()).entries;
      expect(activity.map((entry) => entry.action).sort()).toEqual([
        "vault.grant",
        "vault_value_written",
      ]);
    } finally {
      await closeFixture(fixture);
    }
  });
});
