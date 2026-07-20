import { CapletsError } from "../errors";
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
import type { HostDatabase } from "./types";

export type SetVaultValueAndGrantInput = {
  key: string;
  value: string;
  force: boolean;
  grant?: VaultGrantInput | undefined;
  operatorClientId: string;
};

export class VaultStateStore {
  private readonly options: ResolvedVaultValueStoreOptions;

  constructor(
    private readonly database: HostDatabase,
    options: VaultValueStoreOptions = {},
  ) {
    this.options = resolveVaultValueStoreOptions(options);
  }

  async setValueAndGrant(
    input: SetVaultValueAndGrantInput,
  ): Promise<Extract<VaultValueRecordStatus, { present: true }>> {
    const preparedGrant = input.grant ? prepareVaultGrant(input.grant) : undefined;
    const preparedValue = prepareVaultValueSet(
      input.key,
      input.value,
      {
        force: input.force,
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
        (transaction) => {
          const status = setPreparedVaultValueSqlite(transaction, preparedValue);
          if (preparedGrant) {
            grantPreparedVaultSqlite(transaction, preparedGrant, status.updatedAt);
          }
          return status;
        },
        { behavior: "immediate" },
      );
    }

    return await this.database.db.transaction(async (transaction) => {
      const status = await setPreparedVaultValuePostgres(transaction, preparedValue);
      if (preparedGrant) {
        await grantPreparedVaultPostgres(transaction, preparedGrant, status.updatedAt);
      }
      return status;
    });
  }
}
