export type IssuedRemoteClientCredentials = {
  hostUrl: string;
  clientId: string;
  clientLabel: string;
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresAt: string;
  createdAt: string;
};

export type RemoteClientStatus = {
  clientId: string;
  clientLabel: string;
  hostUrl: string;
  createdAt: string;
  lastUsedAt?: string | undefined;
  revokedAt?: string | undefined;
};

export type RemotePendingLoginState =
  | "pending"
  | "approved"
  | "denied"
  | "cancelled"
  | "expired"
  | "exchanged";

export type RemotePendingLoginStatus = {
  flowId: string;
  hostUrl: string;
  hostIdentity?: string | undefined;
  status: RemotePendingLoginState;
  clientLabel: string;
  clientFingerprint?: string | undefined;
  sourceHint?: string | undefined;
  createdAt: string;
  codeExpiresAt: string;
  flowExpiresAt: string;
  approvedAt?: string | undefined;
  deniedAt?: string | undefined;
  cancelledAt?: string | undefined;
  exchangedAt?: string | undefined;
};

export type ValidatedRemoteClient = RemoteClientStatus & {
  tokenType: "Bearer";
};
