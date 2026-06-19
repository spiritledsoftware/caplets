import { dirname, join } from "node:path";
import { CloudAuthClient } from "../cloud-auth/client";
import { CloudAuthStore, type CloudAuthCredentials } from "../cloud-auth/store";
import { HOSTED_CLOUD_AUTH_SCOPES } from "../cloud-auth/types";
import { DEFAULT_AUTH_DIR } from "../config/paths";
import { CapletsError } from "../errors";
import { ProjectBindingError, projectBindingError } from "../project-binding/errors";
import {
  hostedCloudWorkspaceFromRemoteUrl,
  normalizeRemoteProfileHostUrl,
  resolveCapletsRemote,
  resolveHostedCloudRemote,
  resolveRemoteMode,
  type ResolvedCapletsRemote,
} from "./options";
import { FileRemoteProfileStore } from "./profile-store";
import { remoteProfileKey } from "./profiles";

export type RemoteSelectionInput = {
  mode?: string;
  remoteUrl?: string;
  workspace?: string;
  fetch?: typeof fetch;
  authDir?: string;
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
    const remoteUrl = input.remoteUrl ?? env.CAPLETS_REMOTE_URL;
    if (!remoteUrl) {
      throw new CapletsError("REQUEST_INVALID", "CAPLETS_REMOTE_URL or remoteUrl is required.");
    }
    const store = remoteProfileStore(input.authDir, env);
    const status = await store.getSelfHostedProfileStatus({ hostUrl: remoteUrl });
    const credential = status
      ? await store.credentials.load(
          remoteProfileKey({
            kind: "self-hosted",
            hostUrl: normalizeRemoteProfileHostUrl(remoteUrl),
          }),
        )
      : undefined;
    if (!status || !credential?.accessToken) {
      const normalizedUrl = normalizeRemoteProfileHostUrl(remoteUrl);
      throw new ProjectBindingError({
        code: "remote_credentials_required",
        message: `Remote Login required for ${normalizedUrl}.`,
        recoveryCommand: `caplets remote login ${normalizedUrl}`,
      });
    }
    return {
      kind: "self_hosted_remote",
      remote: resolveCapletsRemote(
        {
          url: remoteUrl,
          token: credential.accessToken,
          ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
          ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
        },
        {},
      ),
    };
  }

  const store = remoteProfileStore(input.authDir, env);
  const remoteUrl = input.remoteUrl ?? env.CAPLETS_REMOTE_URL;
  if (!remoteUrl) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "CAPLETS_MODE=cloud requires CAPLETS_REMOTE_URL or remoteUrl.",
    );
  }
  const workspaceFromRemoteUrl = hostedCloudWorkspaceFromRemoteUrl(remoteUrl);
  let status = await store.getCloudProfileStatus({
    hostUrl: normalizeRemoteProfileHostUrl(remoteUrl),
    workspace: workspaceFromRemoteUrl,
  });
  if (!status && workspaceFromRemoteUrl) {
    status = await store.getCloudProfileStatus({
      hostUrl: normalizeRemoteProfileHostUrl(remoteUrl),
    });
  }
  let credential = status ? await store.credentials.load(status.key) : undefined;
  if (!status || !credential?.accessToken) {
    throw projectBindingError("cloud_auth_required");
  }
  let credentials: CloudAuthCredentials = cloudCredentialsFromProfile(status, credential);

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
    status = await store.saveCloudProfile({
      hostUrl: credentials.cloudUrl,
      workspaceId: credentials.workspaceId,
      ...(credentials.workspaceSlug ? { workspaceSlug: credentials.workspaceSlug } : {}),
      clientLabel: credentials.deviceName,
      credentials: {
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt,
        scope: credentials.scope,
        tokenType: credentials.tokenType,
      },
    });
    credential = await store.credentials.load(status.key);
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
  const missingScope = requiredHostedCloudAttachScopes().find(
    (scope) => !credentials.scope?.includes(scope),
  );
  if (missingScope) {
    throw projectBindingError(
      "cloud_auth_required",
      `Hosted Cloud attach requires Cloud Auth scope ${missingScope}. Run caplets remote login ${credentials.cloudUrl} again.`,
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
      url: remote.baseUrl,
      accessToken: credentials.accessToken,
      workspaceId: credentials.workspaceId,
    },
  };
}

function remoteProfileStore(
  authDir: string | undefined,
  env: Record<string, string | undefined>,
): FileRemoteProfileStore {
  const root = join(
    authDir ??
      (env.CAPLETS_CLOUD_AUTH_PATH ? dirname(env.CAPLETS_CLOUD_AUTH_PATH) : DEFAULT_AUTH_DIR),
    "remote-profiles",
  );
  return new FileRemoteProfileStore({
    root,
    legacyCloudAuthStore: new CloudAuthStore({ env }),
  });
}

function cloudCredentialsFromProfile(
  status: {
    hostUrl: string;
    workspaceId?: string | undefined;
    workspaceSlug?: string | undefined;
    clientLabel?: string | undefined;
  },
  credential: {
    accessToken?: string | undefined;
    refreshToken?: string | undefined;
    expiresAt?: string | undefined;
    scope?: string[] | undefined;
    tokenType?: string | undefined;
  },
): CloudAuthCredentials {
  return {
    version: 2,
    cloudUrl: status.hostUrl,
    workspaceId: status.workspaceId ?? "",
    ...(status.workspaceSlug ? { workspaceSlug: status.workspaceSlug } : {}),
    accessToken: credential.accessToken ?? "",
    refreshToken: credential.refreshToken ?? "",
    expiresAt: credential.expiresAt ?? new Date(0).toISOString(),
    scope: credential.scope,
    tokenType: credential.tokenType,
    deviceName: status.clientLabel,
  };
}

function credentialsNeedRefresh(credentials: { expiresAt: string }): boolean {
  const expiresAt = Date.parse(credentials.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60_000;
}

function requiredHostedCloudAttachScopes(): string[] {
  return HOSTED_CLOUD_AUTH_SCOPES.filter((scope) => scope !== "mcp:tools");
}
