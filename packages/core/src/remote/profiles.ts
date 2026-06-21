import { CapletsError } from "../errors";
import { hostedCloudWorkspaceFromRemoteUrl, normalizeRemoteProfileHostUrl } from "./options";

export type RemoteProfileKind = "cloud" | "self-hosted";

export type RemoteProfileKeyInput = {
  kind: RemoteProfileKind;
  hostUrl: string;
  workspace?: string | undefined;
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
  kind: RemoteProfileKind;
  hostUrl: string;
  key?: string | undefined;
  workspaceId?: string | undefined;
  workspaceSlug?: string | undefined;
  clientId?: string | undefined;
  selected?: boolean | undefined;
  clientLabel?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  credential?: RemoteProfileCredential | undefined;
};

export type RemoteProfileStatus = {
  authenticated: boolean;
  kind: RemoteProfileKind;
  key: string;
  hostUrl: string;
  workspaceId?: string | undefined;
  workspaceSlug?: string | undefined;
  clientId?: string | undefined;
  selected: boolean;
  clientLabel?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  expiresAt?: string | undefined;
  scope?: string[] | undefined;
  tokenType?: string | undefined;
};

export function remoteProfileKey(input: RemoteProfileKeyInput): string {
  const hostUrl = normalizeRemoteProfileHostUrl(input.hostUrl);
  if (input.kind === "cloud") {
    const workspace = input.workspace ?? hostedCloudWorkspaceFromRemoteUrl(input.hostUrl);
    if (!workspace) {
      throw new CapletsError("REQUEST_INVALID", "Cloud Remote Profile requires a workspace.");
    }
    return `cloud:${hostUrl}:${workspace}`;
  }
  return `self-hosted:${hostUrl}`;
}

export function selectedWorkspaceKey(hostUrl: string): string {
  return `cloud:${normalizeRemoteProfileHostUrl(hostUrl)}:selected-workspace`;
}

export function remoteProfileStatus(input: RemoteProfileStatusInput): RemoteProfileStatus {
  const hostUrl = normalizeRemoteProfileHostUrl(input.hostUrl);
  const key =
    input.key ??
    remoteProfileKey({
      kind: input.kind,
      hostUrl,
      workspace: input.workspaceSlug ?? input.workspaceId,
    });
  const expiresAt = input.credential?.expiresAt;
  const expired = Number.isFinite(Date.parse(expiresAt ?? ""))
    ? Date.parse(expiresAt ?? "") <= Date.now()
    : false;
  const hasAccessToken = Boolean(input.credential?.accessToken);
  return {
    authenticated: hasAccessToken && !expired,
    kind: input.kind,
    key,
    hostUrl,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.workspaceSlug ? { workspaceSlug: input.workspaceSlug } : {}),
    ...(input.clientId ? { clientId: input.clientId } : {}),
    selected: Boolean(input.selected),
    ...(input.clientLabel ? { clientLabel: input.clientLabel } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(input.credential?.scope ? { scope: input.credential.scope } : {}),
    ...(input.credential?.tokenType ? { tokenType: input.credential.tokenType } : {}),
  };
}
