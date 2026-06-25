import { existsSync } from "node:fs";
import { CapletsError } from "../errors";
import type { ResolvedCapletsRemote } from "../remote/options";
import { resolveRemoteSelection } from "../remote/selection";
import { ProjectBindingError } from "./errors";
import { bootstrapProjectBindingGitignore } from "./gitignore";
import { buildMutagenSyncPolicy, type MutagenSyncPolicy } from "./mutagen";
import { runProjectBindingSession, type ProjectBindingSessionEvent } from "./session";
import { buildProjectSyncManifest } from "./sync-filter";
import { enforceProjectSyncSizeLimits, type ProjectSyncTier } from "./sync-size";
import type { ProjectBindingWebSocketFactory } from "./transport";

export type RawAttachOptions = {
  remoteUrl?: string;
  workspace?: string;
  json?: boolean;
  verbose?: boolean;
  once?: boolean;
  projectRoot?: string;
  fetch?: typeof fetch;
  authDir?: string;
};

export type ResolvedAttachOptions = {
  projectRoot: string;
  json: boolean;
  verbose: boolean;
  once: boolean;
  remote: ResolvedCapletsRemote;
  authMode: "self_hosted_remote" | "hosted_cloud";
  syncPolicy: MutagenSyncPolicy;
  selectedWorkspace?: string | undefined;
};

export async function resolveAttachOptions(
  raw: RawAttachOptions = {},
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedAttachOptions> {
  return await resolveAttachOptionsForRun(raw, env);
}

export async function resolveAttachOptionsForRun(
  raw: RawAttachOptions = {},
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedAttachOptions> {
  const remoteInput = {
    ...(raw.remoteUrl !== undefined ? { remoteUrl: raw.remoteUrl } : {}),
    ...(raw.workspace !== undefined ? { workspace: raw.workspace } : {}),
    ...(raw.fetch !== undefined ? { fetch: raw.fetch } : {}),
    ...(raw.authDir !== undefined ? { authDir: raw.authDir } : {}),
  };
  const selection = await resolveRemoteSelection(remoteInput, env);
  const projectRoot = raw.projectRoot ?? process.cwd();
  return {
    projectRoot,
    json: raw.json === true,
    verbose: raw.verbose === true,
    once: raw.once === true,
    remote: selection.remote,
    authMode: selection.kind,
    syncPolicy: preflightProjectSync(projectRoot, hostedTier(env)),
    ...(selection.kind === "hosted_cloud"
      ? { selectedWorkspace: selection.selectedWorkspace }
      : raw.workspace
        ? { selectedWorkspace: raw.workspace }
        : {}),
  };
}

export async function attachProjectOnce(
  raw: RawAttachOptions = {},
  env: Record<string, string | undefined> = process.env,
): Promise<{ ok: true; projectRoot: string; webSocketUrl: string }> {
  const resolved = await resolveAttachOptionsForRun({ ...raw, once: true }, env);
  bootstrapProjectBindingGitignore(resolved.projectRoot);
  assertSyncPolicy(resolved.syncPolicy);
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
  const pinnedRaw = resolved.selectedWorkspace
    ? { ...raw, workspace: resolved.selectedWorkspace }
    : raw;
  bootstrapProjectBindingGitignore(resolved.projectRoot);
  assertSyncPolicy(resolved.syncPolicy);
  return await runProjectBindingSession({
    projectRoot: resolved.projectRoot,
    remote: resolved.remote,
    remoteResolver: async () => (await resolveAttachOptionsForRun(pinnedRaw, env)).remote,
    fetch: resolved.remote.fetch,
    signal: options.signal,
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    webSocketFactory: options.webSocketFactory,
    onEvent: options.onEvent,
  });
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

function preflightProjectSync(projectRoot: string, tier: ProjectSyncTier): MutagenSyncPolicy {
  if (!existsSync(projectRoot)) {
    return {
      ok: true,
      ignore: [],
      exclusionSummary: [],
      totalBytes: 0,
      maxSingleFileBytes: 0,
      maxProjectBytes: 0,
    };
  }
  const manifest = buildProjectSyncManifest({ projectRoot });
  const size = enforceProjectSyncSizeLimits({ tier, files: manifest.files });
  return buildMutagenSyncPolicy({ manifest, size });
}

function assertSyncPolicy(policy: MutagenSyncPolicy): void {
  if (!policy.ok) {
    throw new ProjectBindingError({
      code: "sync_size_limit_exceeded",
      message: policy.publicMessage,
      recoveryCommand: policy.recoveryCommand,
    });
  }
}

function hostedTier(env: Record<string, string | undefined>): ProjectSyncTier {
  const value = env.CAPLETS_CLOUD_TIER?.toLowerCase();
  return value === "plus" || value === "pro" || value === "enterprise" ? value : "free";
}
