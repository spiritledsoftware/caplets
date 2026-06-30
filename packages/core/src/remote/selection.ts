import { CloudAuthClient } from "../cloud-auth/client";
import type { CloudAuthCredentials } from "../cloud-auth/store";
import { HOSTED_CLOUD_AUTH_SCOPES } from "../cloud-auth/types";
import { CapletsError } from "../errors";
import { ProjectBindingError, projectBindingError } from "../project-binding/errors";
import { appendBasePath, isLoopbackHost, parseServerBaseUrl } from "../server/options";
import {
  hostedCloudWorkspaceFromRemoteUrl,
  normalizeRemoteProfileHostUrl,
  resolveCapletsRemote,
  resolveHostedCloudRemote,
  resolveRemoteMode,
  type ResolvedCapletsRemote,
} from "./options";
import { cloudCredentialsFromRemoteProfile, createRemoteProfileStore } from "./profile-store";

const SELF_HOSTED_REFRESH_TIMEOUT_MS = 15_000;

export type RemoteSelectionInput = {
  mode?: string;
  remoteUrl?: string;
  workspace?: string;
  fetch?: typeof fetch;
  authDir?: string;
};

export type ResolvedRemoteSelection =
  | {
      kind: "local_daemon";
      remote: ResolvedCapletsRemote;
    }
  | {
      kind: "self_hosted_remote";
      remote: ResolvedCapletsRemote;
      credentialExpiresAt?: string | undefined;
    }
  | {
      kind: "hosted_cloud";
      remote: ResolvedCapletsRemote;
      selectedWorkspace: string;
      credentials: CloudAuthCredentials;
      credentialExpiresAt?: string | undefined;
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
    if (isLocalDaemonRemoteUrl(remoteUrl)) {
      return {
        kind: "local_daemon",
        remote: resolveCapletsRemote(
          {
            url: remoteUrl,
            ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
          },
          {},
        ),
      };
    }
    const store = createRemoteProfileStore({ authDir: input.authDir, env });
    const refreshed = await store.refreshSelfHostedProfileIfNeeded({
      hostUrl: remoteUrl,
      needsRefresh: (credential) =>
        credentialsNeedRefresh({ expiresAt: credential.expiresAt ?? "" }),
      refresh: async (status, credential) => {
        if (!credential.refreshToken || !status.clientId) {
          throw remoteLoginRequired(remoteUrl);
        }
        const refreshed = await refreshSelfHostedCredentials(
          remoteUrl,
          credential.refreshToken,
          input.fetch ? { fetch: input.fetch } : {},
        );
        return {
          hostUrl: refreshed.hostUrl ?? remoteUrl,
          clientId: refreshed.clientId,
          clientLabel: refreshed.clientLabel ?? status.clientLabel,
          credentials: {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
            tokenType: refreshed.tokenType,
          },
        };
      },
    });
    const credential = refreshed?.credential;
    if (!credential?.accessToken) {
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
        env,
      ),
      ...(credential.expiresAt ? { credentialExpiresAt: credential.expiresAt } : {}),
    };
  }

  const store = createRemoteProfileStore({ authDir: input.authDir, env });
  const remoteUrl = input.remoteUrl ?? env.CAPLETS_REMOTE_URL;
  if (!remoteUrl) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "CAPLETS_MODE=cloud requires CAPLETS_REMOTE_URL or remoteUrl.",
    );
  }
  const workspaceFromRemoteUrl = hostedCloudWorkspaceFromRemoteUrl(remoteUrl);
  const explicitWorkspace =
    input.workspace ?? (workspaceFromRemoteUrl ? undefined : env.CAPLETS_REMOTE_WORKSPACE);
  const profileWorkspace = workspaceFromRemoteUrl ?? explicitWorkspace;
  const normalizedRemoteUrl = normalizeRemoteProfileHostUrl(remoteUrl);
  let status = await getCloudProfileStatusForSelection(store, {
    hostUrl: normalizedRemoteUrl,
    workspace: profileWorkspace,
  });
  if (!status && profileWorkspace) {
    status = await getCloudProfileStatusForSelection(store, {
      hostUrl: normalizedRemoteUrl,
    });
  }
  let credential = status ? await store.credentials.load(status.key) : undefined;
  if (!status || !credential?.accessToken) {
    throw projectBindingError("cloud_auth_required");
  }
  let credentials: CloudAuthCredentials = cloudCredentialsFromRemoteProfile(status, credential);

  if (credentialsNeedRefresh(credentials)) {
    const refreshed = await store.refreshCloudProfileIfNeeded({
      hostUrl: normalizedRemoteUrl,
      workspace: profileWorkspace,
      needsRefresh: (candidate) => credentialsNeedRefresh({ expiresAt: candidate.expiresAt ?? "" }),
      refresh: async (candidateStatus, candidateCredential) => {
        const candidateCredentials = cloudCredentialsFromRemoteProfile(
          candidateStatus,
          candidateCredential,
        );
        if (!candidateCredentials.refreshToken) {
          throw projectBindingError("cloud_auth_required");
        }
        const refreshedCredentials = await new CloudAuthClient({
          cloudUrl: candidateCredentials.cloudUrl,
          ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
        }).refresh({ refreshToken: candidateCredentials.refreshToken });
        const nextCredentials = {
          ...candidateCredentials,
          ...refreshedCredentials,
          refreshToken: refreshedCredentials.refreshToken ?? candidateCredentials.refreshToken,
          createdAt: candidateCredentials.createdAt,
          lastRefreshAt: new Date().toISOString(),
        };
        return {
          hostUrl: nextCredentials.cloudUrl,
          workspaceId: nextCredentials.workspaceId,
          ...(nextCredentials.workspaceSlug
            ? { workspaceSlug: nextCredentials.workspaceSlug }
            : {}),
          clientLabel: nextCredentials.deviceName,
          credentials: {
            accessToken: nextCredentials.accessToken,
            refreshToken: nextCredentials.refreshToken,
            expiresAt: nextCredentials.expiresAt,
            scope: nextCredentials.scope,
            tokenType: nextCredentials.tokenType,
          },
        };
      },
    });
    if (!refreshed?.credential?.accessToken) {
      throw projectBindingError("cloud_auth_required");
    }
    status = refreshed.status;
    credential = refreshed.credential;
    credentials = cloudCredentialsFromRemoteProfile(status, credential);
  }

  const selectedWorkspace = credentials.workspaceSlug ?? credentials.workspaceId;
  if (
    explicitWorkspace &&
    explicitWorkspace !== credentials.workspaceId &&
    explicitWorkspace !== credentials.workspaceSlug
  ) {
    throw projectBindingError(
      "workspace_switch_required",
      `Requested workspace ${explicitWorkspace} differs from saved Selected Workspace ${selectedWorkspace}.`,
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
    credentialExpiresAt: credentials.expiresAt,
    cloudPresence: {
      url: remote.baseUrl,
      accessToken: credentials.accessToken,
      workspaceId: credentials.workspaceId,
    },
  };
}

function isLocalDaemonRemoteUrl(value: string): boolean {
  const url = parseServerBaseUrl(value);
  return url.protocol === "http:" && isLoopbackHost(url.hostname);
}

function credentialsNeedRefresh(credentials: { expiresAt: string }): boolean {
  const expiresAt = Date.parse(credentials.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now() + 60_000;
}

type SelfHostedRefreshCredentials = {
  hostUrl?: string | undefined;
  clientId: string;
  clientLabel?: string | undefined;
  accessToken: string;
  refreshToken: string;
  tokenType?: string | undefined;
  expiresAt?: string | undefined;
};

async function refreshSelfHostedCredentials(
  remoteUrl: string,
  refreshToken: string,
  options: { fetch?: typeof fetch },
): Promise<SelfHostedRefreshCredentials> {
  const refreshUrl = appendBasePath(
    new URL(normalizeRemoteProfileHostUrl(remoteUrl)),
    "v1/remote/refresh",
  );
  const response = await fetchSelfHostedRefresh(refreshUrl, refreshToken, options);
  if (!response.ok) {
    throw await selfHostedRefreshError(remoteUrl, response);
  }
  return parseSelfHostedRefreshCredentials(response);
}

async function selfHostedRefreshError(remoteUrl: string, response: Response): Promise<Error> {
  const summary = await parseSelfHostedRefreshError(response);
  if (
    response.status === 401 ||
    summary?.code === "AUTH_FAILED" ||
    summary?.code === "REMOTE_CREDENTIALS_REVOKED"
  ) {
    return selfHostedRefreshLooksRevoked(summary)
      ? remoteLoginRevoked(remoteUrl)
      : remoteLoginRequired(remoteUrl);
  }
  if (response.status === 503 || summary?.code === "SERVER_UNAVAILABLE") {
    return new CapletsError(
      "SERVER_UNAVAILABLE",
      summary?.message ?? "Remote credential refresh is temporarily unavailable.",
    );
  }
  return new CapletsError(
    "AUTH_REFRESH_FAILED",
    summary?.message ?? `Remote credential refresh failed with HTTP ${response.status}.`,
  );
}

async function parseSelfHostedRefreshError(
  response: Response,
): Promise<{ code?: string | undefined; message?: string | undefined } | undefined> {
  const parsed = await response
    .clone()
    .json()
    .catch(() => undefined);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const error = (parsed as Record<string, unknown>).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const record = error as Record<string, unknown>;
  return {
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
  };
}

async function fetchSelfHostedRefresh(
  refreshUrl: URL,
  refreshToken: string,
  options: { fetch?: typeof fetch },
): Promise<Response> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const refresh = (options.fetch ?? fetch)(refreshUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
      signal: controller.signal,
    });
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new CapletsError("SERVER_UNAVAILABLE", "Remote credential refresh timed out."));
      }, SELF_HOSTED_REFRESH_TIMEOUT_MS);
    });
    return await Promise.race([refresh, timedOut]);
  } catch (error) {
    if (error instanceof CapletsError) throw error;
    throw new CapletsError("SERVER_UNAVAILABLE", "Remote credential refresh failed.");
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function remoteLoginRequired(remoteUrl: string): ProjectBindingError {
  return new ProjectBindingError({
    code: "remote_credentials_required",
    message: `Remote Login required for ${normalizeRemoteProfileHostUrl(remoteUrl)}.`,
    recoveryCommand: `caplets remote login ${normalizeRemoteProfileHostUrl(remoteUrl)}`,
  });
}

function remoteLoginRevoked(remoteUrl: string): ProjectBindingError {
  const normalizedUrl = normalizeRemoteProfileHostUrl(remoteUrl);
  return new ProjectBindingError({
    code: "remote_credentials_revoked",
    message: `Remote credentials for ${normalizedUrl} were revoked or rejected. Run Remote Login again and ask the server operator to approve the pending login.`,
    recoveryCommand: `caplets remote login ${normalizedUrl}`,
  });
}

function selfHostedRefreshLooksRevoked(
  summary: { code?: string | undefined; message?: string | undefined } | undefined,
): boolean {
  if (summary?.code === "REMOTE_CREDENTIALS_REVOKED") return true;
  return /revoked|rejected|stale/iu.test(summary?.message ?? "");
}

async function getCloudProfileStatusForSelection(
  store: ReturnType<typeof createRemoteProfileStore>,
  input: { hostUrl: string; workspace?: string | undefined },
): Promise<
  Awaited<ReturnType<ReturnType<typeof createRemoteProfileStore>["getCloudProfileStatus"]>>
> {
  try {
    return await store.getCloudProfileStatus(input);
  } catch (error) {
    if (isCloudWorkspaceAmbiguity(error)) {
      throw projectBindingError(
        "workspace_switch_required",
        "Cloud Remote Profile requires a selected or explicit workspace.",
      );
    }
    throw error;
  }
}

function isCloudWorkspaceAmbiguity(error: unknown): boolean {
  const details = error instanceof CapletsError ? error.details : undefined;
  return (
    error instanceof CapletsError &&
    error.code === "REQUEST_INVALID" &&
    typeof details === "object" &&
    details !== null &&
    !Array.isArray(details) &&
    (details as Record<string, unknown>).reason === "cloud_workspace_ambiguous"
  );
}

async function parseSelfHostedRefreshCredentials(
  response: Response,
): Promise<SelfHostedRefreshCredentials> {
  const parsed = await response.json();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CapletsError(
      "DOWNSTREAM_PROTOCOL_ERROR",
      "Remote refresh response must be an object.",
    );
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.clientId !== "string" ||
    typeof record.accessToken !== "string" ||
    typeof record.refreshToken !== "string"
  ) {
    throw new CapletsError(
      "DOWNSTREAM_PROTOCOL_ERROR",
      "Remote refresh response is missing credentials.",
    );
  }
  return {
    ...(typeof record.hostUrl === "string" ? { hostUrl: record.hostUrl } : {}),
    clientId: record.clientId,
    ...(typeof record.clientLabel === "string" ? { clientLabel: record.clientLabel } : {}),
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    ...(typeof record.tokenType === "string" ? { tokenType: record.tokenType } : {}),
    ...(typeof record.expiresAt === "string" ? { expiresAt: record.expiresAt } : {}),
  };
}

function requiredHostedCloudAttachScopes(): string[] {
  return HOSTED_CLOUD_AUTH_SCOPES.filter((scope) => scope !== "mcp:tools");
}
