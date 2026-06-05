import { CloudAuthClient } from "../cloud-auth/client";
import { CloudAuthStore, type CloudAuthCredentials } from "../cloud-auth/store";
import { CapletsError } from "../errors";
import { projectBindingError } from "../project-binding/errors";
import {
  hostedCloudWorkspaceFromRemoteUrl,
  resolveCapletsRemote,
  resolveHostedCloudRemote,
  resolveRemoteMode,
  type ResolvedCapletsRemote,
} from "./options";

export type RemoteSelectionInput = {
  mode?: string;
  remoteUrl?: string;
  user?: string;
  password?: string;
  token?: string;
  workspace?: string;
  fetch?: typeof fetch;
};

export type ResolvedRemoteSelection =
  | {
      kind: "self_hosted_remote";
      remote: ResolvedCapletsRemote;
    }
  | {
      kind: "hosted_cloud";
      remote: ResolvedCapletsRemote;
      selectedWorkspace: string;
      credentials: CloudAuthCredentials;
      cloudPresence: {
        url: URL;
        accessToken: string;
        workspaceId: string;
      };
    };

export async function resolveRemoteSelection(
  input: RemoteSelectionInput = {},
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedRemoteSelection> {
  const modeValue = input.mode ?? env.CAPLETS_MODE;
  const mode = resolveRemoteMode(
    {
      ...(modeValue !== undefined ? { mode: modeValue } : {}),
      ...(input.remoteUrl !== undefined ? { remoteUrl: input.remoteUrl } : {}),
    },
    env,
  );

  if (mode.mode === "local") {
    throw new CapletsError(
      "REQUEST_INVALID",
      "caplets attach requires a remote upstream; set CAPLETS_REMOTE_URL or use caplets serve for local-only MCP.",
    );
  }

  if (mode.mode === "remote") {
    return {
      kind: "self_hosted_remote",
      remote: resolveCapletsRemote(
        {
          ...(input.remoteUrl !== undefined ? { url: input.remoteUrl } : {}),
          ...(input.user !== undefined ? { user: input.user } : {}),
          ...(input.password !== undefined ? { password: input.password } : {}),
          ...(input.token !== undefined ? { token: input.token } : {}),
          ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
          ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
        },
        env,
      ),
    };
  }

  const store = new CloudAuthStore({ env });
  let credentials = await store.load();
  if (!credentials?.accessToken) {
    throw projectBindingError("cloud_auth_required");
  }

  if (credentialsNeedRefresh(credentials)) {
    if (!credentials.refreshToken) {
      throw projectBindingError("cloud_auth_required");
    }
    const refreshed = await new CloudAuthClient({
      cloudUrl: credentials.cloudUrl,
      ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
    }).refresh({ refreshToken: credentials.refreshToken });
    credentials = {
      ...credentials,
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? credentials.refreshToken,
      createdAt: credentials.createdAt,
      lastRefreshAt: new Date().toISOString(),
    };
    await store.save(credentials);
  }

  const selectedWorkspace = credentials.workspaceSlug ?? credentials.workspaceId;
  if (
    input.workspace &&
    input.workspace !== credentials.workspaceId &&
    input.workspace !== credentials.workspaceSlug
  ) {
    throw projectBindingError(
      "workspace_switch_required",
      `Requested workspace ${input.workspace} differs from saved Selected Workspace ${selectedWorkspace}.`,
    );
  }

  const remoteUrl = input.remoteUrl ?? env.CAPLETS_REMOTE_URL ?? credentials.cloudUrl;
  const workspaceFromRemoteUrl = hostedCloudWorkspaceFromRemoteUrl(remoteUrl);
  if (
    workspaceFromRemoteUrl &&
    workspaceFromRemoteUrl !== credentials.workspaceSlug &&
    workspaceFromRemoteUrl !== credentials.workspaceId
  ) {
    throw projectBindingError(
      "workspace_switch_required",
      `Requested workspace ${workspaceFromRemoteUrl} differs from saved Selected Workspace ${selectedWorkspace}.`,
    );
  }
  const remote = resolveHostedCloudRemote(
    {
      url: remoteUrl,
      token: credentials.accessToken,
      workspace: selectedWorkspace,
      ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
    },
    {},
  );

  return {
    kind: "hosted_cloud",
    remote,
    selectedWorkspace,
    credentials,
    cloudPresence: {
      url: new URL(remoteUrl),
      accessToken: credentials.accessToken,
      workspaceId: credentials.workspaceId,
    },
  };
}

function credentialsNeedRefresh(credentials: { expiresAt: string }): boolean {
  const expiresAt = Date.parse(credentials.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60_000;
}
