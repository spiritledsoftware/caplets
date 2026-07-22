import { createClient } from "@caplets/sdk";
import {
  runProjectBindingSession,
  type ProjectBindingSessionEvent,
  type ProjectBindingWebSocketFactory,
} from "@caplets/sdk/project-binding";
import { fingerprintProjectRoot } from "@caplets/sdk/project-binding/node";
import { existsSync } from "node:fs";
import { CapletsError } from "../errors";
import type { ResolvedCapletsRemote } from "../remote/options";
import { resolveRemoteSelection } from "../remote/selection";
import { ProjectBindingError } from "./errors";
import { bootstrapProjectBindingGitignore } from "./gitignore";
import { buildMutagenSyncPolicy, type MutagenSyncPolicy } from "./mutagen";
import { buildProjectSyncManifest } from "./sync-filter";
import { enforceProjectSyncSizeLimits } from "./sync-size";

export type RawAttachOptions = {
  remoteUrl?: string;
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
  authMode: "local_daemon" | "remote";
  syncPolicy: MutagenSyncPolicy;
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
    authMode: selection.kind === "local_daemon" ? "local_daemon" : "remote",
    syncPolicy: preflightProjectSync(projectRoot),
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
    signal?: AbortSignal | undefined;
    webSocketFactory?: ProjectBindingWebSocketFactory | undefined;
    onEvent?: (event: AttachSessionEvent) => void;
  } = {},
) {
  const resolved = await resolveAttachOptionsForRun(raw, env);
  const resolveSessionRemote = async (): Promise<ResolvedCapletsRemote> =>
    resolved.authMode === "local_daemon"
      ? resolved.remote
      : (await resolveAttachOptionsForRun(raw, env)).remote;
  const headers = new Headers(resolved.remote.requestInit.headers);
  headers.delete("authorization");
  const client = createClient({
    baseUrl: resolved.remote.baseUrl.toString(),
    auth: async () => {
      const remote = await resolveSessionRemote();
      return remote.auth.type === "bearer" ? remote.auth.token : undefined;
    },
    fetch: resolved.remote.fetch ?? globalThis.fetch,
    headers,
  });

  bootstrapProjectBindingGitignore(resolved.projectRoot);
  assertSyncPolicy(resolved.syncPolicy);
  const session = await runProjectBindingSession({
    client,
    webSocketUrl: resolved.remote.projectBindingWebSocketUrl.toString(),
    projectRoot: resolved.projectRoot,
    projectFingerprint: fingerprintProjectRoot(resolved.projectRoot),
    throwOnError: true,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.webSocketFactory ? { webSocketFactory: options.webSocketFactory } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
  return { ok: true as const, ...session };
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

function preflightProjectSync(projectRoot: string): MutagenSyncPolicy {
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
  const size = enforceProjectSyncSizeLimits({ files: manifest.files });
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
