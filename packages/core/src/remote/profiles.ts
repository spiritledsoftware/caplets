import { canonicalizeCurrentHostOrigin } from "../current-host/origin";

export type RemoteProfileKeyInput = {
  origin: string;
};

export type RemoteProfileCredential = {
  accessToken?: string | undefined;
  refreshToken?: string | undefined;
  tokenType?: string | undefined;
  expiresAt?: string | undefined;
  scope?: string[] | undefined;
  clientSecret?: string | undefined;
  pairingCode?: string | undefined;
};

export type RemoteProfileStatusInput = {
  origin: string;
  hostIdentity?: string | undefined;
  key?: string | undefined;
  clientId?: string | undefined;
  clientLabel?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  credential?: RemoteProfileCredential | undefined;
};

export type RemoteProfileStatus = {
  authenticated: boolean;
  key: string;
  origin: string;
  hostIdentity?: string | undefined;
  clientId?: string | undefined;
  clientLabel?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  expiresAt?: string | undefined;
  scope?: string[] | undefined;
  tokenType?: string | undefined;
};

export function remoteProfileKey(input: RemoteProfileKeyInput): string {
  return `remote:${canonicalizeCurrentHostOrigin(input.origin)}`;
}

export function remoteProfileStatus(input: RemoteProfileStatusInput): RemoteProfileStatus {
  const origin = canonicalizeCurrentHostOrigin(input.origin);
  return {
    authenticated: Boolean(input.credential?.accessToken),
    key: input.key ?? remoteProfileKey({ origin }),
    origin,
    ...(input.hostIdentity ? { hostIdentity: input.hostIdentity } : {}),
    ...(input.clientId ? { clientId: input.clientId } : {}),
    ...(input.clientLabel ? { clientLabel: input.clientLabel } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    ...(input.credential?.expiresAt ? { expiresAt: input.credential.expiresAt } : {}),
    ...(input.credential?.scope ? { scope: input.credential.scope } : {}),
    ...(input.credential?.tokenType ? { tokenType: input.credential.tokenType } : {}),
  };
}
