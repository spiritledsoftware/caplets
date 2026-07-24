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
import { VAULT_MAX_VALUE_BYTES } from "../src/vault";
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
  it("rejects an invalid value before changing authoritative state", async () => {
    const fixture = await openFixture();
    try {
      await expect(
        fixture.state.setValueAndGrant({
          key: "INVALID_VALUE",
          value: "x".repeat(VAULT_MAX_VALUE_BYTES + 1),
          force: false,
          createOnly: true,
          grant: { ...fileGrant("INVALID_VALUE", "invalid-value-caplet"), createOnly: true },
          operatorClientId: operator.clientId,
        }),
      ).rejects.toMatchObject({ code: "REQUEST_INVALID" });

      await expect(fixture.values.getStatus("INVALID_VALUE")).resolves.toEqual({
        key: "INVALID_VALUE",
        present: false,
      });
      await expect(fixture.grants.list()).resolves.toEqual([]);
      await expect(fixture.storage.operatorActivity.list()).resolves.toEqual({ entries: [] });
      await expect(fixture.storage.coordination.currentConfigGeneration()).resolves.toBe(0);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rolls back a new value and its activity when grant insertion fails", async () => {
    const fixture = await openFixture();
    try {
      await fixture.database.db.run(
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
      ).rejects.toThrow();

      await expect(fixture.values.getStatus("NEW_SECRET")).resolves.toEqual({
        key: "NEW_SECRET",
        present: false,
      });
      await expect(fixture.grants.list()).resolves.toEqual([]);
      await expect(fixture.storage.operatorActivity.list()).resolves.toEqual({
        entries: [],
      });
      await expect(fixture.storage.coordination.currentConfigGeneration()).resolves.toBe(0);
    } finally {
      await fixture.database.db.run(sql.raw("drop trigger if exists fail_vault_grant_insert"));
      await closeFixture(fixture);
    }
  });

  it("rolls back value, grant, and config publication when intent activity fails", async () => {
    const fixture = await openFixture();
    try {
      await fixture.values.set("EXISTING_SECRET", "original-secret", {
        createOnly: true,
      });
      await fixture.database.db.run(
        sql.raw(`
          create temp trigger fail_vault_set_activity
          before insert on operator_activity
          when new.action = 'vault.set'
          begin
            select raise(abort, 'injected vault set activity failure');
          end
        `),
      );

      await expect(
        fixture.state.setValueAndGrant({
          key: "EXISTING_SECRET",
          value: "replacement-secret",
          force: true,
          expectedGeneration: 1,
          grant: {
            ...fileGrant("EXISTING_SECRET", "existing-secret-caplet"),
            createOnly: true,
          },
          operatorClientId: operator.clientId,
        }),
      ).rejects.toThrow();

      await expect(fixture.values.resolveValue("EXISTING_SECRET")).resolves.toBe("original-secret");
      await expect(fixture.values.getStatus("EXISTING_SECRET")).resolves.toMatchObject({
        present: true,
        generation: 1,
      });
      await expect(fixture.grants.list()).resolves.toEqual([]);
      await expect(fixture.storage.operatorActivity.list()).resolves.toEqual({
        entries: [],
      });
      await expect(fixture.storage.coordination.currentConfigGeneration()).resolves.toBe(0);
    } finally {
      await fixture.database.db.run(sql.raw("drop trigger if exists fail_vault_set_activity"));
      await closeFixture(fixture);
    }
  });

  it("rolls value, grant, and activity back when config publication fails", async () => {
    const fixture = await openFixture();
    try {
      await fixture.values.set("EXISTING_SECRET", "original-secret", {
        createOnly: true,
      });
      await fixture.database.db.run(
        sql.raw(`
          create temp trigger fail_vault_config_publication
          before insert on host_config_generations
          begin
            select raise(abort, 'injected config publication failure');
          end
        `),
      );

      await expect(
        fixture.state.setValueAndGrant({
          key: "EXISTING_SECRET",
          value: "replacement-secret",
          force: true,
          expectedGeneration: 1,
          grant: fileGrant("EXISTING_SECRET", "config-failure-caplet"),
          operatorClientId: operator.clientId,
        }),
      ).rejects.toThrow();

      await expect(fixture.values.resolveValue("EXISTING_SECRET")).resolves.toBe("original-secret");
      await expect(fixture.values.getStatus("EXISTING_SECRET")).resolves.toMatchObject({
        present: true,
        generation: 1,
      });
      await expect(fixture.grants.list()).resolves.toEqual([]);
      await expect(fixture.storage.operatorActivity.list()).resolves.toEqual({ entries: [] });
      await expect(fixture.storage.coordination.currentConfigGeneration()).resolves.toBe(0);
    } finally {
      await fixture.database.db.run(
        sql.raw("drop trigger if exists fail_vault_config_publication"),
      );
      await closeFixture(fixture);
    }
  });

  it("commits a value, grant, one intent activity, and one config generation", async () => {
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
          resourceVersion: expect.any(String),
        }),
      ]);

      await expect(fixture.storage.operatorActivity.list()).resolves.toEqual({
        entries: [
          expect.objectContaining({
            actorClientId: operator.clientId,
            action: "vault.set",
            target: { type: "vault_value", id: "COMMITTED_SECRET" },
            metadata: expect.objectContaining({ generation: 1, grant: true }),
            createdAt: status.updatedAt,
          }),
        ],
      });
      await expect(fixture.storage.coordination.currentConfigGeneration()).resolves.toBe(1);
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
        action: "vault.set",
        metadata: { generation: 1, grant: false },
      });
      await expect(fixture.storage.coordination.currentConfigGeneration()).resolves.toBe(1);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("serializes competing writers without exposing a losing grant or activity", async () => {
    const fixture = await openFixture();
    try {
      await fixture.values.set("RACE_SECRET", "original-race-secret", { createOnly: true });
      const inputs = [
        {
          key: "RACE_SECRET",
          value: "first-race-secret",
          force: false,
          expectedGeneration: 1,
          grant: {
            ...fileGrant("RACE_SECRET", "first-race-caplet"),
            createOnly: true,
          },
          operatorClientId: operator.clientId,
        },
        {
          key: "RACE_SECRET",
          value: "second-race-secret",
          force: false,
          expectedGeneration: 1,
          grant: {
            ...fileGrant("RACE_SECRET", "second-race-caplet"),
            createOnly: true,
          },
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
      expect(winner.value.generation).toBe(2);
      const loser = results[1 - winnerIndex];
      expect(loser?.status).toBe("rejected");
      if (!loser || loser.status !== "rejected") {
        throw new Error("Expected one rejected Vault writer");
      }
      expect(loser.reason).toMatchObject({
        code: "REQUEST_INVALID",
        details: { kind: "stale_generation", expectedGeneration: 1, currentGeneration: 2 },
      });

      await expect(fixture.values.resolveValue("RACE_SECRET")).resolves.toBe(
        inputs[winnerIndex]!.value,
      );
      await expect(fixture.grants.list()).resolves.toEqual([
        expect.objectContaining({
          capletId: inputs[winnerIndex]!.grant.capletId,
          vaultKey: "RACE_SECRET",
        }),
      ]);
      await expect(fixture.storage.operatorActivity.list()).resolves.toEqual({
        entries: [expect.objectContaining({ action: "vault.set" })],
      });
      await expect(fixture.storage.coordination.currentConfigGeneration()).resolves.toBe(1);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("rolls back a value update when a create-only grant appears before the atomic write", async () => {
    const fixture = await openFixture();
    try {
      await fixture.values.set("GRANT_RACE_SECRET", "original-secret", { createOnly: true });
      await fixture.grants.grant(fileGrant("GRANT_RACE_SECRET", "grant-race-caplet"));
      const [winner] = await fixture.grants.list("grant-race-caplet");
      if (!winner) throw new Error("Expected the concurrently created Vault grant");

      await expect(
        fixture.state.setValueAndGrant({
          key: "GRANT_RACE_SECRET",
          value: "losing-replacement-secret",
          force: true,
          expectedGeneration: 1,
          grant: fileGrant("GRANT_RACE_SECRET", "grant-race-caplet"),
          grantCreateOnly: true,
          operatorClientId: operator.clientId,
        }),
      ).rejects.toMatchObject({ code: "CONFIG_EXISTS" });

      await expect(fixture.values.resolveValue("GRANT_RACE_SECRET")).resolves.toBe(
        "original-secret",
      );
      await expect(fixture.values.getStatus("GRANT_RACE_SECRET")).resolves.toMatchObject({
        present: true,
        generation: 1,
      });
      await expect(fixture.grants.list("grant-race-caplet")).resolves.toEqual([
        expect.objectContaining({ resourceVersion: winner.resourceVersion }),
      ]);
    } finally {
      await closeFixture(fixture);
    }
  });

  it("advances value and grant versions once and rejects stale versions without partial state", async () => {
    const fixture = await openFixture();
    try {
      const firstStatus = await fixture.state.setValueAndGrant({
        key: "VERSIONED_SECRET",
        value: "first-version",
        force: false,
        createOnly: true,
        grant: {
          ...fileGrant("VERSIONED_SECRET", "versioned-caplet"),
          createOnly: true,
        },
        operatorClientId: operator.clientId,
      });
      const [firstGrant] = await fixture.grants.list("versioned-caplet");
      if (!firstGrant) throw new Error("Expected the first committed Vault grant");

      const secondStatus = await fixture.state.setValueAndGrant({
        key: "VERSIONED_SECRET",
        value: "second-version",
        force: true,
        expectedGeneration: 1,
        grant: {
          ...fileGrant("VERSIONED_SECRET", "versioned-caplet"),
          expectedResourceVersion: firstGrant.resourceVersion,
        },
        operatorClientId: operator.clientId,
      });
      const [secondGrant] = await fixture.grants.list("versioned-caplet");
      if (!secondGrant) throw new Error("Expected the second committed Vault grant");

      expect(firstStatus.generation).toBe(1);
      expect(secondStatus.generation).toBe(2);
      expect(secondGrant.resourceVersion).not.toBe(firstGrant.resourceVersion);
      await expect(fixture.storage.coordination.currentConfigGeneration()).resolves.toBe(2);

      await expect(
        fixture.state.setValueAndGrant({
          key: "VERSIONED_SECRET",
          value: "stale-value-generation",
          force: true,
          expectedGeneration: 1,
          grant: {
            ...fileGrant("VERSIONED_SECRET", "versioned-caplet"),
            expectedResourceVersion: secondGrant.resourceVersion,
          },
          operatorClientId: operator.clientId,
        }),
      ).rejects.toMatchObject({
        details: { kind: "stale_generation", expectedGeneration: 1, currentGeneration: 2 },
      });

      await expect(
        fixture.state.setValueAndGrant({
          key: "VERSIONED_SECRET",
          value: "stale-grant-version",
          force: true,
          expectedGeneration: 2,
          grant: {
            ...fileGrant("VERSIONED_SECRET", "versioned-caplet"),
            expectedResourceVersion: firstGrant.resourceVersion,
          },
          operatorClientId: operator.clientId,
        }),
      ).rejects.toMatchObject({
        details: {
          kind: "stale_generation",
          expectedResourceVersion: firstGrant.resourceVersion,
        },
      });

      await expect(fixture.values.resolveValue("VERSIONED_SECRET")).resolves.toBe("second-version");
      await expect(fixture.values.getStatus("VERSIONED_SECRET")).resolves.toMatchObject({
        present: true,
        generation: 2,
      });
      await expect(fixture.grants.list("versioned-caplet")).resolves.toEqual([
        expect.objectContaining({ resourceVersion: secondGrant.resourceVersion }),
      ]);
      await expect(fixture.storage.operatorActivity.list()).resolves.toEqual({
        entries: [
          expect.objectContaining({ action: "vault.set", metadata: expect.any(Object) }),
          expect.objectContaining({ action: "vault.set", metadata: expect.any(Object) }),
        ],
      });
      await expect(fixture.storage.coordination.currentConfigGeneration()).resolves.toBe(2);
    } finally {
      await closeFixture(fixture);
    }
  });
});
