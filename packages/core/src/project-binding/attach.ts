import { existsSync } from "node:fs";
import { CapletsError } from "../errors";
import { CloudAuthClient } from "../cloud-auth/client";
import { CloudAuthStore } from "../cloud-auth/store";
import { resolveCapletsRemote, type ResolvedCapletsRemote } from "../remote/options";
import { projectBindingError, ProjectBindingError } from "./errors";
import { bootstrapProjectBindingGitignore } from "./gitignore";
import { runProjectBindingSession, type ProjectBindingSessionEvent } from "./session";
import { buildProjectSyncManifest } from "./sync-filter";
import { enforceProjectSyncSizeLimits, type ProjectSyncTier } from "./sync-size";
import type { ProjectBindingWebSocketFactory } from "./transport";

export type RawAttachOptions = {
  remoteUrl?: string;
  user?: string;
  password?: string;
  token?: string;
  workspace?: string;
  json?: boolean;
  verbose?: boolean;
  once?: boolean;
  projectRoot?: string;
  fetch?: typeof fetch;
};

export type ResolvedAttachOptions = {
  projectRoot: string;
  json: boolean;
  verbose: boolean;
  once: boolean;
  remote: ResolvedCapletsRemote;
  authMode: "self_hosted_remote" | "hosted_cloud";
  selectedWorkspace?: string | undefined;
};

export function resolveAttachOptions(
  raw: RawAttachOptions = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedAttachOptions {
  const remoteInput = {
    ...(raw.remoteUrl !== undefined ? { url: raw.remoteUrl } : {}),
    ...(raw.user !== undefined ? { user: raw.user } : {}),
    ...(raw.password !== undefined ? { password: raw.password } : {}),
    ...(raw.token !== undefined ? { token: raw.token } : {}),
    ...(raw.workspace !== undefined ? { workspace: raw.workspace } : {}),
    ...(raw.fetch !== undefined ? { fetch: raw.fetch } : {}),
  };
  return {
    projectRoot: raw.projectRoot ?? process.cwd(),
    json: raw.json === true,
    verbose: raw.verbose === true,
    once: raw.once === true,
    remote: resolveCapletsRemote(remoteInput, env),
    authMode: "self_hosted_remote",
    ...(remoteInput.workspace ? { selectedWorkspace: remoteInput.workspace } : {}),
  };
}

export async function attachProjectOnce(
  raw: RawAttachOptions = {},
  env: Record<string, string | undefined> = process.env,
): Promise<{ ok: true; projectRoot: string; webSocketUrl: string }> {
  const resolved = await resolveAttachOptionsForRun({ ...raw, once: true }, env);
  bootstrapProjectBindingGitignore(resolved.projectRoot);
  preflightProjectSync(resolved.projectRoot, hostedTier(env));
  const response = await (resolved.remote.fetch ?? fetch)(projectBindingProbeUrl(resolved.remote), {
    ...resolved.remote.requestInit,
    method: "GET",
  });
  if (response.status !== 101 && !(await isWebSocketUpgradeRequired(response))) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      `Project Binding WebSocket unavailable at ${resolved.remote.projectBindingWebSocketUrl}. Run caplets doctor for details.`,
    );
  }
  return {
    ok: true,
    projectRoot: resolved.projectRoot,
    webSocketUrl: resolved.remote.projectBindingWebSocketUrl.toString(),
  };
}

export type AttachSessionEvent = ProjectBindingSessionEvent;

export async function attachProjectSession(
  raw: RawAttachOptions = {},
  env: Record<string, string | undefined> = process.env,
  options: {
    heartbeatIntervalMs?: number | undefined;
    signal?: AbortSignal | undefined;
    webSocketFactory?: ProjectBindingWebSocketFactory | undefined;
    onEvent?: (event: AttachSessionEvent) => void;
  } = {},
) {
  const resolved = await resolveAttachOptionsForRun(raw, env);
  bootstrapProjectBindingGitignore(resolved.projectRoot);
  preflightProjectSync(resolved.projectRoot, hostedTier(env));
  return await runProjectBindingSession({
    projectRoot: resolved.projectRoot,
    remote: resolved.remote,
    fetch: resolved.remote.fetch,
    signal: options.signal,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    webSocketFactory: options.webSocketFactory,
    onEvent: options.onEvent,
  });
}

export async function resolveAttachOptionsForRun(
  raw: RawAttachOptions = {},
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedAttachOptions> {
  if (hasExplicitRemote(raw, env)) return resolveAttachOptions(raw, env);

  const store = new CloudAuthStore({ env });
  let credentials = await store.load();
  if (!credentials?.accessToken) throw projectBindingError("cloud_auth_required");
  if (credentialsNeedRefresh(credentials)) {
    if (!credentials.refreshToken) throw projectBindingError("cloud_auth_required");
    const refreshed = await new CloudAuthClient({
      cloudUrl: credentials.cloudUrl,
      ...(raw.fetch !== undefined ? { fetch: raw.fetch } : {}),
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
  const selected = credentials.workspaceSlug ?? credentials.workspaceId;
  if (
    raw.workspace &&
    raw.workspace !== credentials.workspaceId &&
    raw.workspace !== credentials.workspaceSlug
  ) {
    throw projectBindingError(
      "workspace_switch_required",
      `Requested workspace ${raw.workspace} differs from saved Selected Workspace ${selected}.`,
    );
  }

  const remote = resolveCapletsRemote(
    {
      url: credentials.cloudUrl,
      token: credentials.accessToken,
      workspace: selected,
      ...(raw.fetch !== undefined ? { fetch: raw.fetch } : {}),
    },
    {},
  );
  return {
    projectRoot: raw.projectRoot ?? process.cwd(),
    json: raw.json === true,
    verbose: raw.verbose === true,
    once: raw.once === true,
    remote,
    authMode: "hosted_cloud",
    selectedWorkspace: selected,
  };
}

function projectBindingProbeUrl(remote: ResolvedCapletsRemote): URL {
  const url = new URL(remote.projectBindingWebSocketUrl);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  return url;
}

async function isWebSocketUpgradeRequired(response: Response): Promise<boolean> {
  if (response.status !== 426) return false;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return false;
  const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
  return body?.error === "websocket_upgrade_required";
}

function hasExplicitRemote(
  raw: RawAttachOptions,
  env: Record<string, string | undefined>,
): boolean {
  return Boolean(
    raw.remoteUrl ??
    raw.user ??
    raw.password ??
    raw.token ??
    env.CAPLETS_REMOTE_URL ??
    env.CAPLETS_REMOTE_TOKEN ??
    env.CAPLETS_REMOTE_USER ??
    env.CAPLETS_REMOTE_PASSWORD,
  );
}

function preflightProjectSync(projectRoot: string, tier: ProjectSyncTier): void {
  if (!existsSync(projectRoot)) return;
  const manifest = buildProjectSyncManifest({ projectRoot });
  const size = enforceProjectSyncSizeLimits({ tier, files: manifest.files });
  if (!size.ok) {
    throw new ProjectBindingError({
      code: size.code,
      message: "Project sync size exceeds the selected workspace policy.",
      recoveryCommand: size.recoveryCommand,
    });
  }
}

function hostedTier(env: Record<string, string | undefined>): ProjectSyncTier {
  const value = env.CAPLETS_CLOUD_TIER?.toLowerCase();
  return value === "plus" || value === "pro" || value === "enterprise" ? value : "free";
}

function credentialsNeedRefresh(credentials: { expiresAt: string }): boolean {
  const expiresAt = Date.parse(credentials.expiresAt);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt <= Date.now() + 60_000;
}
