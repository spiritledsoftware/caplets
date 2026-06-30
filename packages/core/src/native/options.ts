import { CapletsError } from "../errors";
import {
  isCapletsCloudUrl,
  resolveCapletsRemote,
  resolveHostedCloudRemote,
  resolveRemoteMode,
  type CapletsRemoteAuth,
  type CapletsRemoteEnv,
} from "../remote/options";
import { isLoopbackHost } from "../server/options";

type CapletsMode = "auto" | "local" | "remote" | "cloud" | "daemon";

export type NativeCapletsMode = CapletsMode;

export type NativeRemoteCapletsOptions = {
  url?: string;
  workspace?: string;
  fetch?: typeof fetch;
  requestHeaders?: Record<string, string>;
  pollIntervalMs?: number;
  cloud?: NativeCloudPresenceInput;
};

export type NativeDaemonCapletsOptions = {
  url?: string;
  fetch?: typeof fetch;
  requestHeaders?: Record<string, string>;
  pollIntervalMs?: number;
};

export type NativeCloudPresenceInput = {
  url?: string;
  accessToken?: string;
  workspaceId?: string;
  projectRoot?: string;
  heartbeatIntervalMs?: number;
};

export type NativeCapletsServiceResolutionInput = {
  mode?: NativeCapletsMode;
  remote?: NativeRemoteCapletsOptions;
  daemon?: NativeDaemonCapletsOptions;
};

export type NativeCapletsEnv = CapletsRemoteEnv &
  Partial<
    Record<
      | "CAPLETS_MODE"
      | "CAPLETS_CLOUD_URL"
      | "CAPLETS_CLOUD_TOKEN"
      | "CAPLETS_CLOUD_WORKSPACE_ID"
      | "CAPLETS_PROJECT_ROOT"
      | "CAPLETS_DAEMON_URL",
      string
    >
  >;

const NATIVE_RUNTIME_SELECTION_ENV_KEYS: Array<keyof NativeCapletsEnv> = [
  "CAPLETS_MODE",
  "CAPLETS_REMOTE_URL",
  "CAPLETS_DAEMON_URL",
  "CAPLETS_CLOUD_URL",
  "CAPLETS_CLOUD_TOKEN",
  "CAPLETS_CLOUD_WORKSPACE_ID",
];

export function hasNativeRuntimeSelectionEnv(env: NativeCapletsEnv = process.env): boolean {
  return NATIVE_RUNTIME_SELECTION_ENV_KEYS.some((key) => Boolean(env[key]?.trim()));
}

export type NativeRemoteAuthOptions =
  | { enabled: false; user: string }
  | { enabled: true; user: string; password: string };

export type ResolvedNativeCapletsServiceOptions =
  | { mode: "local" }
  | {
      mode: "remote" | "cloud" | "daemon";
      remote: {
        url: URL;
        auth: NativeRemoteAuthOptions;
        pollIntervalMs: number;
        requestInit: RequestInit;
        cloud?: ResolvedNativeCloudPresenceOptions;
        fetch?: typeof fetch;
      };
    };

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000;

export function resolveNativeCapletsServiceOptions(
  input: NativeCapletsServiceResolutionInput = {},
  env: NativeCapletsEnv = process.env,
): ResolvedNativeCapletsServiceOptions {
  const explicitMode = input.mode ?? env.CAPLETS_MODE;
  const daemonUrl = input.daemon?.url ?? env.CAPLETS_DAEMON_URL;
  if (explicitMode === "daemon") {
    return resolveNativeDaemonOptions(input, env);
  }
  if ((explicitMode === undefined || explicitMode === "auto") && daemonUrl?.trim()) {
    return resolveNativeDaemonOptions(input, env);
  }

  const mode = resolveRemoteMode(
    {
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.remote?.url ? { remoteUrl: input.remote.url } : {}),
    },
    env,
  );
  if (mode.mode === "local") {
    return { mode: "local" };
  }

  const remoteFetch = input.remote?.fetch;
  const server =
    mode.mode === "cloud"
      ? resolveNativeHostedCloudRemoteOrPlaceholder(
          input.remote?.url ?? env.CAPLETS_REMOTE_URL ?? "",
          optionalWorkspace(input, env).workspace,
          remoteFetch,
        )
      : resolveCapletsRemote(
          {
            ...(input.remote?.url ? { url: input.remote.url } : {}),
            ...(input.remote?.workspace ? { workspace: input.remote.workspace } : {}),
            ...(remoteFetch ? { fetch: remoteFetch } : {}),
          },
          env,
        );

  const cloud = resolveNativeCloudPresence(input.remote?.cloud, env);
  const requestInit =
    mode.mode === "cloud" && cloud
      ? { headers: { Authorization: `Bearer ${cloud.accessToken}` } }
      : server.requestInit;
  return {
    mode: mode.mode,
    remote: {
      url: server.attachUrl,
      auth: nativeAuthFromRemoteAuth(server.auth),
      pollIntervalMs: parsePollInterval(input.remote?.pollIntervalMs),
      requestInit: withRequestHeaders(requestInit, input.remote?.requestHeaders),
      ...(cloud ? { cloud } : {}),
      ...(server.fetch ? { fetch: server.fetch } : {}),
    },
  };
}

function resolveNativeDaemonOptions(
  input: NativeCapletsServiceResolutionInput,
  env: NativeCapletsEnv,
): ResolvedNativeCapletsServiceOptions {
  const daemonUrl = input.daemon?.url ?? env.CAPLETS_DAEMON_URL;
  if (!daemonUrl) {
    throw new CapletsError("REQUEST_INVALID", "Native daemon mode requires daemon.url.");
  }
  const server = resolveCapletsRemote(
    {
      url: daemonUrl,
      ...(input.daemon?.fetch ? { fetch: input.daemon.fetch } : {}),
    },
    {},
  );
  if (server.baseUrl.protocol !== "http:" || !isLoopbackHost(server.baseUrl.hostname)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Native daemon mode requires a loopback HTTP daemon URL.",
    );
  }
  return {
    mode: "daemon",
    remote: {
      url: server.attachUrl,
      auth: nativeAuthFromRemoteAuth(server.auth),
      pollIntervalMs: parsePollInterval(input.daemon?.pollIntervalMs),
      requestInit: withRequestHeaders(server.requestInit, input.daemon?.requestHeaders),
      ...(server.fetch ? { fetch: server.fetch } : {}),
    },
  };
}

function withRequestHeaders(
  requestInit: RequestInit,
  requestHeaders: Record<string, string> | undefined,
): RequestInit {
  if (!requestHeaders) return requestInit;
  const headers = new Headers(requestInit.headers);
  for (const [name, value] of Object.entries(requestHeaders)) {
    headers.set(name, value);
  }
  return { ...requestInit, headers };
}

function resolveNativeHostedCloudRemote(
  url: string,
  workspace: string | undefined,
  fetch: typeof globalThis.fetch | undefined,
): ReturnType<typeof resolveHostedCloudRemote> {
  return resolveHostedCloudRemote({
    url,
    ...(workspace ? { workspace } : {}),
    ...(fetch ? { fetch } : {}),
  });
}

function resolveNativeHostedCloudRemoteOrPlaceholder(
  url: string,
  workspace: string | undefined,
  fetch: typeof globalThis.fetch | undefined,
): ReturnType<typeof resolveHostedCloudRemote> {
  if (!isCapletsCloudUrl(url)) {
    throw new CapletsError("REQUEST_INVALID", "CAPLETS_MODE=cloud requires Caplets Cloud.");
  }
  if (workspace) return resolveNativeHostedCloudRemote(url, workspace, fetch);
  return resolveCapletsRemote({ url, ...(fetch ? { fetch } : {}) }, {});
}

function optionalWorkspace(
  input: NativeCapletsServiceResolutionInput,
  env: NativeCapletsEnv,
): { workspace?: string } {
  const workspace =
    input.remote?.cloud?.workspaceId ??
    input.remote?.workspace ??
    env.CAPLETS_REMOTE_WORKSPACE ??
    env.CAPLETS_CLOUD_WORKSPACE_ID;
  return workspace ? { workspace } : {};
}

function nativeAuthFromRemoteAuth(auth: CapletsRemoteAuth): NativeRemoteAuthOptions {
  if (auth.type === "none") {
    return { enabled: false, user: auth.user };
  }
  return { enabled: false, user: "caplets" };
}

function parsePollInterval(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_POLL_INTERVAL_MS;
  }
  if (!Number.isInteger(value) || value < 1_000) {
    throw new CapletsError("REQUEST_INVALID", "remote.pollIntervalMs must be an integer >= 1000.");
  }
  return value;
}

export type ResolvedNativeCloudPresenceOptions = {
  url: URL;
  accessToken: string;
  workspaceId: string;
  projectRoot?: string;
  heartbeatIntervalMs: number;
};

function resolveNativeCloudPresence(
  input: NativeCloudPresenceInput | undefined,
  env: NativeCapletsEnv,
): ResolvedNativeCloudPresenceOptions | undefined {
  const url = input?.url ?? env.CAPLETS_CLOUD_URL;
  const accessToken = input?.accessToken ?? env.CAPLETS_CLOUD_TOKEN;
  const workspaceId = input?.workspaceId ?? env.CAPLETS_CLOUD_WORKSPACE_ID;
  if (!url && !accessToken && !workspaceId && !input?.projectRoot) {
    return undefined;
  }
  if (!url || !accessToken || !workspaceId) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Cloud presence requires CAPLETS_CLOUD_URL, CAPLETS_CLOUD_TOKEN, and CAPLETS_CLOUD_WORKSPACE_ID.",
    );
  }
  return {
    url: new URL(url),
    accessToken,
    workspaceId,
    ...((input?.projectRoot ?? env.CAPLETS_PROJECT_ROOT)
      ? { projectRoot: input?.projectRoot ?? env.CAPLETS_PROJECT_ROOT }
      : {}),
    heartbeatIntervalMs: parsePresenceHeartbeatInterval(input?.heartbeatIntervalMs),
  };
}

function parsePresenceHeartbeatInterval(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_PRESENCE_HEARTBEAT_INTERVAL_MS;
  }
  if (!Number.isInteger(value) || value < 1_000) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "cloud.heartbeatIntervalMs must be an integer >= 1000.",
    );
  }
  return value;
}
