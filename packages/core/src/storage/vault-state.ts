import { createHash, randomUUID } from "node:crypto";
import { CapletsError } from "../errors";
import { advancePostgresConfigGeneration, advanceSqliteConfigGeneration } from "./coordination";
import {
  grantPreparedVaultPostgres,
  grantPreparedVaultSqlite,
  prepareVaultGrant,
  type VaultGrantInput,
} from "./vault-grants";
import {
  prepareVaultValueSet,
  resolveVaultValueStoreOptions,
  setPreparedVaultValuePostgres,
  setPreparedVaultValueSqlite,
  type ResolvedVaultValueStoreOptions,
  type VaultValueRecordStatus,
  type VaultValueStoreOptions,
} from "./vault-values";
import * as postgres from "./schema/postgres";
import * as sqlite from "./schema/sqlite";
import type { HostDatabase } from "./types";

export type SetVaultValueAndGrantInput = {
  key: string;
  value: string;
  force: boolean;
  createOnly?: boolean | undefined;
  expectedGeneration?: number | undefined;
  grant?: VaultGrantInput | undefined;
  grantCreateOnly?: boolean | undefined;
  operatorClientId: string;
};

type PresentVaultValueStatus = Extract<VaultValueRecordStatus, { present: true }>;

export class VaultStateStore {
  private readonly options: ResolvedVaultValueStoreOptions;

  constructor(
    private readonly database: HostDatabase,
    options: VaultValueStoreOptions = {},
  ) {
    this.options = resolveVaultValueStoreOptions(options);
  }

  async setValueAndGrant(input: SetVaultValueAndGrantInput): Promise<PresentVaultValueStatus> {
    const grantInput =
      input.grant === undefined || input.grantCreateOnly === undefined
        ? input.grant
        : { ...input.grant, createOnly: input.grantCreateOnly };
    const preparedGrant = grantInput ? prepareVaultGrant(grantInput) : undefined;
    const preparedValue = prepareVaultValueSet(
      input.key,
      input.value,
      {
        force: input.force,
        createOnly: input.createOnly,
        expectedGeneration: input.expectedGeneration,
        operatorClientId: input.operatorClientId,
      },
      this.options,
    );
    if (preparedGrant && preparedGrant.input.vaultKey !== preparedValue.key) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Vault grant key must match the value being written.",
      );
    }
    if (preparedGrant && preparedGrant.operatorId !== input.operatorClientId) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Vault value and grant operator clients must match.",
      );
    }

    if (this.database.dialect === "sqlite") {
      return this.database.db.transaction(
        async (transaction) => {
          const status = await setPreparedVaultValueSqlite(transaction, preparedValue, false);
          const grantResourceVersion = preparedGrant
            ? await grantPreparedVaultSqlite(transaction, preparedGrant, status.updatedAt, false)
            : undefined;
          await transaction
            .insert(sqlite.operatorActivity)
            .values(
              vaultSetActivity(
                preparedValue.key,
                status.generation,
                grantResourceVersion,
                input.operatorClientId,
                status.updatedAt,
              ),
            )
            .run();
          await advanceSqliteConfigGeneration(
            transaction,
            vaultConfigHash(preparedValue.key, status.generation, grantResourceVersion),
            input.operatorClientId,
          );
          return status;
        },
        { behavior: "immediate" },
      );
    }

    return await this.database.db.transaction(async (transaction) => {
      const status = await setPreparedVaultValuePostgres(transaction, preparedValue, false);
      const grantResourceVersion = preparedGrant
        ? await grantPreparedVaultPostgres(transaction, preparedGrant, status.updatedAt, false)
        : undefined;
      await transaction
        .insert(postgres.operatorActivity)
        .values(
          vaultSetActivity(
            preparedValue.key,
            status.generation,
            grantResourceVersion,
            input.operatorClientId,
            status.updatedAt,
          ),
        );
      await advancePostgresConfigGeneration(
        transaction,
        vaultConfigHash(preparedValue.key, status.generation, grantResourceVersion),
        input.operatorClientId,
      );
      return status;
    });
  }
}

function vaultSetActivity(
  key: string,
  generation: number,
  grantResourceVersion: string | undefined,
  operatorClientId: string,
  createdAt: string,
) {
  return {
    activityKey: randomUUID(),
    operatorClientId,
    action: "vault.set",
    targetKind: "vault_value",
    targetKey: key,
    outcome: "succeeded",
    metadata: {
      generation,
      grant: grantResourceVersion !== undefined,
      ...(grantResourceVersion === undefined ? {} : { grantResourceVersion }),
    },
    createdAt,
  };
}

function vaultConfigHash(
  key: string,
  generation: number,
  grantResourceVersion: string | undefined,
): string {
  return createHash("sha256")
    .update(JSON.stringify(["vault.set", key, generation, grantResourceVersion ?? null]))
    .digest("hex");
}
