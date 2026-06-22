import type { ConfigSourceKind } from "../config";

export const VAULT_MAX_VALUE_BYTES = 64 * 1024;

export type VaultConfigOrigin = {
  kind: ConfigSourceKind;
  path: string;
};

export type VaultKeySourceStatus =
  | { available: true; source: "env"; keyFile?: undefined }
  | { available: true; source: "file"; keyFile: string }
  | {
      available: false;
      source: "env" | "file";
      reason: "missing" | "invalid" | "unreadable" | "wrong-permissions" | "unsupported-version";
      keyFile?: string | undefined;
    };

export type VaultValueStatus = {
  key: string;
  present: boolean;
  valueBytes?: number | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export type VaultAccessGrant = {
  storedKey: string;
  referenceName: string;
  capletId: string;
  origin: VaultConfigOrigin;
  createdAt: string;
  updatedAt: string;
};

export type VaultAccessGrantInput = {
  storedKey: string;
  referenceName: string;
  capletId: string;
  origin: VaultConfigOrigin;
  now?: Date | undefined;
};

export type VaultAccessGrantFilter = {
  storedKey?: string | undefined;
  referenceName?: string | undefined;
  capletId?: string | undefined;
  origin?: VaultConfigOrigin | undefined;
};

export type VaultResolvedGrant =
  | { storedKey: string; value: string }
  | {
      reason: "ungranted";
      referenceName: string;
      capletId: string;
      origin: VaultConfigOrigin;
    }
  | {
      reason: "missing";
      storedKey: string;
      referenceName: string;
      capletId: string;
      origin: VaultConfigOrigin;
    };

export type VaultDeleteStatus = {
  key: string;
  deleted: boolean;
  grantsRetained: number;
};
