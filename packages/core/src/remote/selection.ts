import { canonicalizeCurrentHostOrigin } from "../current-host/origin";
import { currentHostV1Url } from "../current-host/topology";
import { daemonClientBaseUrl } from "../daemon/client-url";
import { readDaemonConfig } from "../daemon/config";
import { createNativeDaemonManager } from "../daemon/manager";
import { resolveDaemonPaths } from "../daemon/paths";
import type { DaemonConfig, DaemonOperationOptions } from "../daemon/types";
import { CapletsError } from "../errors";
import { ProjectBindingError } from "../project-binding/errors";
import { resolveCapletsRemote, resolveRemoteMode, type ResolvedCapletsRemote } from "./options";
import { createRemoteProfileStore } from "./profile-store";

const REMOTE_REFRESH_TIMEOUT_MS = 15_000;

export type RemoteSelectionInput = {
  mode?: string;
  remoteUrl?: string;
  fetch?: typeof fetch;
  authDir?: string;
};

type RemoteSelectionDependencies = {
  daemon?: Omit<DaemonOperationOptions, "env" | "fetch">;
};

export type ResolvedRemoteSelection =
  | {
      kind: "local_daemon";
      remote: ResolvedCapletsRemote;
    }
  | {
      kind: "remote";
      remote: ResolvedCapletsRemote;
      credentialExpiresAt?: string | undefined;
    };

export async function resolveRemoteSelection(
  input: RemoteSelectionInput = {},
  env: Record<string, string | undefined> = process.env,
  dependencies: RemoteSelectionDependencies = {},
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

  const remoteUrl = input.remoteUrl ?? env.CAPLETS_REMOTE_URL;
  if (!remoteUrl) {
    throw new CapletsError("REQUEST_INVALID", "CAPLETS_REMOTE_URL or remoteUrl is required.");
  }
  const origin = canonicalizeCurrentHostOrigin(remoteUrl);
  const localDaemonFallback = isLoopbackHttpOrigin(origin);
  const store = createRemoteProfileStore({ authDir: input.authDir, env });
  const refreshed = await store.refreshRemoteProfileIfNeeded({
    origin,
    needsRefresh: (credential) => credentialsNeedRefresh(credential.expiresAt),
    refresh: async (status, credential) => {
      if (!credential.refreshToken) throw remoteLoginRequired(origin);
      const next = await refreshRemoteCredentials(
        origin,
        credential.refreshToken,
        input.fetch ? { fetch: input.fetch } : {},
      );
      return {
        origin: next.hostUrl ?? origin,
        clientId: next.clientId,
        clientLabel: next.clientLabel ?? status.clientLabel,
        credentials: {
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
          expiresAt: next.expiresAt,
          tokenType: next.tokenType,
        },
      };
    },
  });
  const credential = refreshed?.credential;
  if (!credential?.accessToken) {
    if (
      localDaemonFallback &&
      !refreshed &&
      (await isSetupValidatedLocalDaemon(origin, input, env, dependencies))
    ) {
      return localDaemonRemoteSelection(origin, input.fetch);
    }
    throw remoteLoginRequired(origin);
  }

  return {
    kind: "remote",
    remote: resolveCapletsRemote(
      {
        url: origin,
        token: credential.accessToken,
        ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
      },
      {},
    ),
    ...(credential.expiresAt ? { credentialExpiresAt: credential.expiresAt } : {}),
  };
}

function localDaemonRemoteSelection(
  origin: string,
  fetch: typeof globalThis.fetch | undefined,
): ResolvedRemoteSelection {
  return {
    kind: "local_daemon",
    remote: resolveCapletsRemote(
      {
        url: origin,
        ...(fetch !== undefined ? { fetch } : {}),
      },
      {},
    ),
  };
}

function isLoopbackHttpOrigin(value: string): boolean {
  const url = new URL(value);
  return url.protocol === "http:";
}

async function isSetupValidatedLocalDaemon(
  origin: string,
  input: RemoteSelectionInput,
  env: Record<string, string | undefined>,
  dependencies: RemoteSelectionDependencies,
): Promise<boolean> {
  try {
    const daemonOptions: DaemonOperationOptions = {
      ...dependencies.daemon,
      env,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    };
    const paths = resolveDaemonPaths(daemonOptions);
    const config = readDaemonConfig(paths);
    if (!config) return false;
    const daemonOrigin = canonicalizeCurrentHostOrigin(daemonClientBaseUrl(config).href);
    if (daemonOrigin !== origin) return false;
    const native = await (daemonOptions.manager ?? createNativeDaemonManager(daemonOptions)).status(
      config,
      paths,
    );
    if (!native.running) return false;
    return await isDaemonHealthOk(config, origin, input.fetch);
  } catch {
    return false;
  }
}

async function isDaemonHealthOk(
  _config: Pick<DaemonConfig, "serve">,
  origin: string,
  fetchInput: typeof globalThis.fetch | undefined,
): Promise<boolean> {
  const fetchImpl = fetchInput ?? globalThis.fetch;
  if (!fetchImpl) return false;
  try {
    const { healthUrl } = resolveCapletsRemote({ url: origin }, {});
    const response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function credentialsNeedRefresh(expiresAt: string | undefined): boolean {
  if (!expiresAt) return false;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed <= Date.now() + 60_000;
}

type RemoteRefreshCredentials = {
  hostUrl?: string | undefined;
  clientId: string;
  clientLabel?: string | undefined;
  accessToken: string;
  refreshToken: string;
  tokenType?: string | undefined;
  expiresAt?: string | undefined;
};

async function refreshRemoteCredentials(
  origin: string,
  refreshToken: string,
  options: { fetch?: typeof fetch },
): Promise<RemoteRefreshCredentials> {
  const response = await fetchRemoteRefresh(
    currentHostV1Url(origin, "remoteRefresh"),
    refreshToken,
    options,
  );
  if (!response.ok) throw await remoteRefreshError(origin, response);
  return await parseRemoteRefreshCredentials(response);
}

async function remoteRefreshError(origin: string, response: Response): Promise<Error> {
  const summary = await parseRemoteRefreshError(response);
  if (
    response.status === 401 ||
    summary?.code === "AUTH_FAILED" ||
    summary?.code === "REMOTE_CREDENTIALS_REVOKED"
  ) {
    return remoteRefreshLooksRevoked(summary)
      ? remoteLoginRevoked(origin)
      : remoteLoginRequired(origin);
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

async function parseRemoteRefreshError(
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

async function fetchRemoteRefresh(
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
      }, REMOTE_REFRESH_TIMEOUT_MS);
    });
    return await Promise.race([refresh, timedOut]);
  } catch (error) {
    if (error instanceof CapletsError) throw error;
    throw new CapletsError("SERVER_UNAVAILABLE", "Remote credential refresh failed.");
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function remoteLoginRequired(origin: string): ProjectBindingError {
  return new ProjectBindingError({
    code: "remote_credentials_required",
    message: `Remote Login required for ${origin}.`,
    recoveryCommand: `caplets remote login ${origin}`,
  });
}

function remoteLoginRevoked(origin: string): ProjectBindingError {
  return new ProjectBindingError({
    code: "remote_credentials_revoked",
    message: `Remote credentials for ${origin} were revoked or rejected. Run Remote Login again and ask the server operator to approve the pending login.`,
    recoveryCommand: `caplets remote login ${origin}`,
  });
}

function remoteRefreshLooksRevoked(
  summary: { code?: string | undefined; message?: string | undefined } | undefined,
): boolean {
  if (summary?.code === "REMOTE_CREDENTIALS_REVOKED") return true;
  return /revoked|rejected|stale/iu.test(summary?.message ?? "");
}

async function parseRemoteRefreshCredentials(
  response: Response,
): Promise<RemoteRefreshCredentials> {
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
