import { CapletsError } from "../errors";
import {
  resolveCapletsRemote,
  resolveHostedCloudRemote,
  resolveRemoteMode,
  type CapletsRemoteAuth,
  type CapletsRemoteEnv,
  type CapletsRemoteInput,
} from "../remote/options";

type CapletsMode = "auto" | "local" | "remote" | "cloud";

export type NativeCapletsMode = CapletsMode;

export type NativeRemoteCapletsOptions = CapletsRemoteInput & {
  pollIntervalMs?: number;
  cloud?: NativeCloudPresenceInput;
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
};

export type NativeCapletsEnv = CapletsRemoteEnv &
  Partial<
    Record<
      | "CAPLETS_CLOUD_URL"
      | "CAPLETS_CLOUD_TOKEN"
      | "CAPLETS_CLOUD_WORKSPACE_ID"
      | "CAPLETS_PROJECT_ROOT",
      string
    >
  >;

export type NativeRemoteAuthOptions =
  | { enabled: false; user: string }
  | { enabled: true; user: string; password: string };

export type ResolvedNativeCapletsServiceOptions =
  | { mode: "local" }
  | {
      mode: "remote" | "cloud";
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
      ? resolveNativeHostedCloudRemote(
          input.remote?.url ?? env.CAPLETS_REMOTE_URL ?? "",
          optionalWorkspace(input, env).workspace,
          remoteFetch,
        )
      : resolveCapletsRemote(input.remote, env);

  const cloud = resolveNativeCloudPresence(input.remote?.cloud, env);
  return {
    mode: mode.mode,
    remote: {
      url: server.attachUrl,
      auth: nativeAuthFromRemoteAuth(server.auth),
      pollIntervalMs: parsePollInterval(input.remote?.pollIntervalMs),
      requestInit:
        mode.mode === "cloud" && cloud
          ? { headers: { Authorization: `Bearer ${cloud.accessToken}` } }
          : server.requestInit,
      ...(cloud ? { cloud } : {}),
      ...(server.fetch ? { fetch: server.fetch } : {}),
    },
  };
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
