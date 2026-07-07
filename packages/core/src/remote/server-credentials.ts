export type RemoteClientRole = "access" | "operator";

export type IssuedRemoteClientCredentials = {
  hostUrl: string;
  clientId: string;
  clientLabel: string;
  role: RemoteClientRole;
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresAt: string;
  createdAt: string;
};

export type RemoteClientStatus = {
  clientId: string;
  clientLabel: string;
  role: RemoteClientRole;
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
  requestedRole: RemoteClientRole;
  grantedRole?: RemoteClientRole | undefined;
  operatorCodeFingerprint?: string | undefined;
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
