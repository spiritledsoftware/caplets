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

export type ValidatedRemoteClient = RemoteClientStatus & {
  tokenType: "Bearer";
};
