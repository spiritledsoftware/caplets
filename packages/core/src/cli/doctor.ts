import { fingerprintProjectRoot } from "@caplets/sdk/project-binding/node";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeCapletsService } from "../native/service";
import { findProjectRoot } from "../cloud/project-root";
import { CloudAuthStore } from "../cloud-auth/store";
import { projectBindingWorkspacePaths } from "../project-binding/workspaces";
import {
  hostedCloudWorkspaceFromRemoteUrl,
  isCapletsCloudUrl,
  normalizeRemoteProfileHostUrl,
  resolveCapletsRemote,
  resolveHostedCloudRemote,
  resolveRemoteMode,
  type ResolvedCapletsRemote,
} from "../remote/options";
import { createRemoteProfileStore } from "../remote/profile-store";
import type { RemoteProfileCredential, RemoteProfileStatus } from "../remote/profiles";
import { resolveCapletsServer } from "../server/options";
import type { MutagenProjectSyncDoctorData } from "../project-binding/mutagen";
import { generateCodeModeDeclarations } from "../code-mode/declarations";
import { diagnoseCodeModeTypeScript } from "../code-mode/diagnostics";
import { CodeModeLogStore } from "../code-mode/logs";
import { runCodeMode } from "../code-mode/runner";
import { listCodeModeCallableCaplets } from "../code-mode/api";
import {
  DEFAULT_OBSERVED_OUTPUT_SHAPE_CACHE_DIR,
  resolveConfigPath,
  resolveProjectConfigPath,
} from "../config/paths";
import { FileObservedOutputShapeStore } from "../observed-output-shapes";
import {
  formatVaultRecoveryCommand,
  loadConfig,
  loadLocalOverlayConfigWithSources,
  type CapletConfig,
  type VaultQuarantineOutcome,
} from "../config";
import { resolveExposure } from "../exposure/policy";
import { daemonStatus, type DaemonOperationOptions } from "../daemon";

const PROJECT_BINDING_DOCTOR_PROBE_TIMEOUT_MS = 5_000;

export type DoctorOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  cwd?: string;
  syncStatus?: MutagenProjectSyncDoctorData;
  cloudAuthStore?: CloudAuthStore;
  authDir?: string;
  observedOutputShapeCacheDir?: string;
  daemon?: DaemonOperationOptions;
  fetch?: typeof fetch;
  projectBindingProbeTimeoutMs?: number;
};

export type DoctorJsonReport = {
  server: Record<string, unknown>;
  remote: Record<string, unknown>;
  projectBinding: Record<string, unknown>;
  sync: Record<string, unknown>;
  daemon: Record<string, unknown>;
  remoteLogin: Record<string, unknown>;
  vault: Record<string, unknown>;
  exposure: Record<string, unknown>;
  codeMode: Record<string, unknown>;
};

export async function doctorJsonReport(options: DoctorOptions = {}): Promise<DoctorJsonReport> {
  const env = options.env ?? process.env;
  const root = findProjectRoot(options.cwd ?? process.cwd());
  const projectFingerprint = fingerprintProjectRoot(root);
  const paths = projectBindingWorkspacePaths(projectFingerprint, { env });
  const remoteLogin = await resolveRemoteLoginSection(options, env);
  const server = resolveServerSection(env);
  const remote = resolveRemoteSection(env, remoteLogin);
  const sessionSupport = await resolveProjectBindingSessionSupport(options, env, remoteLogin);

  return {
    server,
    remote,
    projectBinding: {
      state: "not_attached",
      projectRoot: root,
      projectFingerprint,
      workspacePath: paths.project,
      authMode: remoteLogin.authenticated
        ? remoteLogin.kind === "cloud"
          ? "hosted_cloud"
          : "self_hosted_remote"
        : remote.configured || remoteLogin.configured
          ? "remote_login_required"
          : "unconfigured",
      selectedWorkspace: remoteLogin.selectedWorkspace ?? remote.workspace ?? null,
      webSocketUrl: remote.webSocketUrl,
      sessionSupport: sessionSupport.value,
      lease: null,
      lastUpgradeError: sessionSupport.lastError,
      recoveryCommand: projectBindingRecovery(remoteLogin, remote, sessionSupport.value),
    },
    sync: {
      state: options.syncStatus?.state ?? "idle",
      diagnosticCode: options.syncStatus?.diagnosticCode ?? null,
      mutagenBinary: options.syncStatus?.mutagenBinary ?? "mutagen",
      mutagenVersion: options.syncStatus?.mutagenVersion ?? null,
      lastCommand: options.syncStatus?.lastCommand ?? null,
    },
    daemon: await resolveDaemonSection(env, options.daemon),
    remoteLogin: remoteLogin.report,
    vault: resolveVaultSection(env, root),
    exposure: await resolveExposureSection(env),
    codeMode: await resolveCodeModeSection(options, env),
  };
}

export async function formatDoctorReport(
  options: DoctorOptions = {},
  format: "plain" | "markdown" = "plain",
): Promise<string> {
  const report = await doctorJsonReport(options);
  if (format === "markdown") return formatDoctorMarkdownReport(report);

  const lines = [
    "Server hosting",
    `  Configured: ${yesNo(Boolean(report.server.configured))}`,
    ...(report.server.configured ? [`  Base URL: ${report.server.baseUrl}`] : []),
    "",
    "Remote client",
    `  Configured: ${yesNo(Boolean(report.remote.configured))}`,
    ...(report.remote.configured
      ? [
          `  MCP URL: ${report.remote.mcpUrl}`,
          `  Control URL: ${report.remote.controlUrl}`,
          `  Health URL: ${report.remote.healthUrl}`,
          `  WebSocket URL: ${report.remote.webSocketUrl}`,
          `  Auth: ${report.remote.auth}`,
        ]
      : []),
    "",
    "Project Binding",
    `  State: ${report.projectBinding.state}`,
    `  Project root: ${report.projectBinding.projectRoot}`,
    `  Project fingerprint: ${report.projectBinding.projectFingerprint}`,
    `  Workspace path: ${report.projectBinding.workspacePath}`,
    `  Auth mode: ${report.projectBinding.authMode}`,
    `  Selected Workspace: ${report.projectBinding.selectedWorkspace ?? "none"}`,
    `  Binding Session: ${report.projectBinding.state}`,
    ...(report.projectBinding.sessionSupport !== "unknown"
      ? [`  Session support: ${report.projectBinding.sessionSupport}`]
      : []),
    `  Recovery: ${report.projectBinding.recoveryCommand}`,
    "",
    "Project sync",
    `  State: ${report.sync.state}`,
    `  Mutagen: ${report.sync.mutagenVersion ?? report.sync.mutagenBinary}`,
    ...(report.sync.diagnosticCode ? [`  Diagnostic: ${report.sync.diagnosticCode}`] : []),
    "",
    "Daemon",
    `  Installed: ${yesNo(Boolean(report.daemon.installed))}`,
    `  Running: ${yesNo(Boolean(report.daemon.running))}`,
    ...(report.daemon.nativeState ? [`  Native state: ${report.daemon.nativeState}`] : []),
    ...(report.daemon.health ? [`  Health: ${doctorOk(report.daemon.health)}`] : []),
    "",
    "Remote Login",
    `  Configured: ${yesNo(Boolean(report.remoteLogin.configured))}`,
    `  Authenticated: ${yesNo(Boolean(report.remoteLogin.authenticated))}`,
    ...(report.remoteLogin.hostUrl ? [`  Host URL: ${report.remoteLogin.hostUrl}`] : []),
    ...(report.remoteLogin.kind ? [`  Kind: ${report.remoteLogin.kind}`] : []),
    ...(report.remoteLogin.workspaceSlug || report.remoteLogin.workspaceId
      ? [
          `  Selected Workspace: ${report.remoteLogin.workspaceSlug ?? report.remoteLogin.workspaceId}`,
        ]
      : []),
    ...(report.remoteLogin.clientId ? [`  Client: ${report.remoteLogin.clientId}`] : []),
    "",
    "Vault",
    `  OK: ${yesNo(Boolean(report.vault.ok))}`,
    ...(!report.vault.ok && typeof report.vault.message === "string"
      ? [`  Error: ${report.vault.message}`]
      : []),
    ...(Array.isArray(report.vault.issues)
      ? (report.vault.issues as Array<Record<string, unknown>>).map(
          (issue) => `  ${issue.capletId}: ${issue.reason} ${issue.key} (${issue.recoveryCommand})`,
        )
      : []),
    "",
    "Exposure",
    `  Default: ${report.exposure.default ?? "unknown"}`,
    `  Discovery timeout: ${report.exposure.discoveryTimeoutMs ?? "unknown"}ms`,
    `  Discovery concurrency: ${report.exposure.discoveryConcurrency ?? "unknown"}`,
    `  Callable native tools: ${report.exposure.callableNativeToolCount ?? 0}`,
    ...(Array.isArray(report.exposure.caplets)
      ? (report.exposure.caplets as Array<Record<string, unknown>>).map(
          (caplet) =>
            `  ${caplet.id}: ${caplet.exposure} (${caplet.callable ? "callable" : `hidden: ${caplet.hiddenReason}`})`,
        )
      : []),
    "",
    "Code Mode",
    `  Types generation: ${doctorOk(report.codeMode.typesGeneration)}`,
    `  Diagnostics: ${doctorOk(report.codeMode.diagnostics)}`,
    `  Sandbox smoke: ${doctorOk(report.codeMode.sandboxSmoke)}`,
    `  Log storage: ${doctorOk(report.codeMode.logStorage)}`,
    `  Callable index: ${doctorOk(report.codeMode.callableIndex)}`,
    `  Observed output shapes: ${doctorOk(report.codeMode.observedOutputShapes)}`,
    ...(observedOutputShapePath(report.codeMode.observedOutputShapes)
      ? [
          `  Observed output shape cache: ${observedOutputShapePath(report.codeMode.observedOutputShapes)}`,
        ]
      : []),
  ];
  return `${lines.join("\n")}\n`;
}

function formatDoctorMarkdownReport(report: DoctorJsonReport): string {
  const lines = [
    "# Caplets Doctor",
    "",
    "## Server hosting",
    `- Configured: ${yesNo(Boolean(report.server.configured))}`,
    ...(report.server.configured ? [`- Base URL: ${report.server.baseUrl}`] : []),
    "",
    "## Remote client",
    `- Configured: ${yesNo(Boolean(report.remote.configured))}`,
    ...(report.remote.configured
      ? [
          `- MCP URL: ${report.remote.mcpUrl}`,
          `- Control URL: ${report.remote.controlUrl}`,
          `- Health URL: ${report.remote.healthUrl}`,
          `- WebSocket URL: ${report.remote.webSocketUrl}`,
          `- Auth: ${report.remote.auth}`,
        ]
      : []),
    "",
    "## Project Binding",
    `- State: ${report.projectBinding.state}`,
    `- Project root: ${report.projectBinding.projectRoot}`,
    `- Project fingerprint: ${report.projectBinding.projectFingerprint}`,
    `- Workspace path: ${report.projectBinding.workspacePath}`,
    `- Auth mode: ${report.projectBinding.authMode}`,
    `- Selected Workspace: ${report.projectBinding.selectedWorkspace ?? "none"}`,
    `- Binding Session: ${report.projectBinding.state}`,
    ...(report.projectBinding.sessionSupport !== "unknown"
      ? [`- Session support: ${report.projectBinding.sessionSupport}`]
      : []),
    `- Recovery: ${report.projectBinding.recoveryCommand}`,
    "",
    "## Project sync",
    `- State: ${report.sync.state}`,
    `- Mutagen: ${report.sync.mutagenVersion ?? report.sync.mutagenBinary}`,
    ...(report.sync.diagnosticCode ? [`- Diagnostic: ${report.sync.diagnosticCode}`] : []),
    "",
    "## Daemon",
    `- Installed: ${yesNo(Boolean(report.daemon.installed))}`,
    `- Running: ${yesNo(Boolean(report.daemon.running))}`,
    ...(report.daemon.nativeState ? [`- Native state: ${report.daemon.nativeState}`] : []),
    ...(report.daemon.health ? [`- Health: ${doctorOk(report.daemon.health)}`] : []),
    "",
    "## Remote Login",
    `- Configured: ${yesNo(Boolean(report.remoteLogin.configured))}`,
    `- Authenticated: ${yesNo(Boolean(report.remoteLogin.authenticated))}`,
    ...(report.remoteLogin.hostUrl ? [`- Host URL: ${report.remoteLogin.hostUrl}`] : []),
    ...(report.remoteLogin.kind ? [`- Kind: ${report.remoteLogin.kind}`] : []),
    ...(report.remoteLogin.workspaceSlug || report.remoteLogin.workspaceId
      ? [
          `- Selected Workspace: ${report.remoteLogin.workspaceSlug ?? report.remoteLogin.workspaceId}`,
        ]
      : []),
    ...(report.remoteLogin.clientId ? [`- Client: ${report.remoteLogin.clientId}`] : []),
    "",
    "## Vault",
    `- OK: ${yesNo(Boolean(report.vault.ok))}`,
    ...(!report.vault.ok && typeof report.vault.message === "string"
      ? [`- Error: ${report.vault.message}`]
      : []),
    ...(Array.isArray(report.vault.issues)
      ? (report.vault.issues as Array<Record<string, unknown>>).map(
          (issue) => `- ${issue.capletId}: ${issue.reason} ${issue.key} (${issue.recoveryCommand})`,
        )
      : []),
    "",
    "## Exposure",
    `- Default: ${report.exposure.default ?? "unknown"}`,
    `- Discovery timeout: ${report.exposure.discoveryTimeoutMs ?? "unknown"}ms`,
    `- Discovery concurrency: ${report.exposure.discoveryConcurrency ?? "unknown"}`,
    `- Callable native tools: ${report.exposure.callableNativeToolCount ?? 0}`,
    ...(Array.isArray(report.exposure.caplets)
      ? (report.exposure.caplets as Array<Record<string, unknown>>).map(
          (caplet) =>
            `- ${caplet.id}: ${caplet.exposure} (${caplet.callable ? "callable" : `hidden: ${caplet.hiddenReason}`})`,
        )
      : []),
    "",
    "## Code Mode",
    `- Types generation: ${doctorOk(report.codeMode.typesGeneration)}`,
    `- Diagnostics: ${doctorOk(report.codeMode.diagnostics)}`,
    `- Sandbox smoke: ${doctorOk(report.codeMode.sandboxSmoke)}`,
    `- Log storage: ${doctorOk(report.codeMode.logStorage)}`,
    `- Callable index: ${doctorOk(report.codeMode.callableIndex)}`,
    `- Observed output shapes: ${doctorOk(report.codeMode.observedOutputShapes)}`,
    ...(observedOutputShapePath(report.codeMode.observedOutputShapes)
      ? [
          `- Observed output shape cache: ${observedOutputShapePath(report.codeMode.observedOutputShapes)}`,
        ]
      : []),
  ];
  return `${lines.join("\n")}\n`;
}

function resolveVaultSection(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  cwd: string = process.cwd(),
) {
  const configPath = env.CAPLETS_CONFIG?.trim() ? env.CAPLETS_CONFIG.trim() : resolveConfigPath();
  const projectConfigPath = env.CAPLETS_PROJECT_CONFIG?.trim()
    ? env.CAPLETS_PROJECT_CONFIG.trim()
    : resolveProjectConfigPath(cwd);
  try {
    const overlay = loadLocalOverlayConfigWithSources(configPath, projectConfigPath);
    const loaderFailure = overlay.warnings.find(
      (warning) => warning.type === undefined && warning.recoverable !== true,
    );
    if (loaderFailure) {
      return { ok: false, issues: [], message: loaderFailure.message };
    }
    const issues = overlay.warnings
      .filter((warning): warning is VaultQuarantineOutcome => warning.type === "vault-quarantine")
      .map((warning) => ({
        capletId: warning.capletId,
        reason: warning.reason,
        key: warning.effectiveKey,
        configPath: warning.path,
        referencePath: warning.referencePath,
        target: warning.target,
        recoveryCommand: formatVaultRecoveryCommand(warning),
      }));
    return { ok: issues.length === 0, issues };
  } catch (error) {
    return {
      ok: false,
      issues: [],
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function projectBindingRecovery(
  remoteLogin: DoctorRemoteLoginSection,
  remote: Record<string, unknown>,
  sessionSupport: ProjectBindingSessionSupport,
): string {
  if (remoteLogin.authenticated) {
    if (remoteLogin.kind === "cloud") return "caplets attach --once";
    if (sessionSupport === "supported") return "caplets attach --once";
    if (sessionSupport === "unsupported") {
      return "Upgrade the remote Caplets service and rerun caplets doctor.";
    }
    return "caplets doctor";
  }
  if (remote.configured || remoteLogin.configured) {
    return `caplets remote login ${remoteLogin.hostUrl ?? "<url>"}`;
  }
  return "caplets remote login <url>";
}

type ProjectBindingSessionSupport = "supported" | "unsupported" | "unknown";

async function resolveProjectBindingSessionSupport(
  options: DoctorOptions,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  remoteLogin: DoctorRemoteLoginSection,
): Promise<{ value: ProjectBindingSessionSupport; lastError: string | null }> {
  if (remoteLogin.kind !== "self-hosted") return { value: "unknown", lastError: null };
  if (!remoteLogin.authenticated || !remoteLogin.credential?.accessToken) {
    return { value: "unknown", lastError: null };
  }

  let remote: ResolvedCapletsRemote;
  try {
    remote = resolveCapletsRemote(selfHostedDoctorInput(remoteLogin), env);
  } catch (error) {
    return { value: "unknown", lastError: errorMessage(error) };
  }

  const fetchImpl = options.fetch ?? remote.fetch ?? fetch;
  const timeoutMs = options.projectBindingProbeTimeoutMs ?? PROJECT_BINDING_DOCTOR_PROBE_TIMEOUT_MS;
  const headers = new Headers(remote.requestInit.headers);
  headers.set("content-type", "application/json");
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      projectBindingSessionsUrl(remote),
      timeoutMs,
      {
        ...remote.requestInit,
        method: "POST",
        headers,
        body: JSON.stringify({ diagnosticProbe: true }),
      },
    );
    if (response.status === 201) {
      const created = await readDiagnosticSessionResponse(response);
      if (!created.ok) return { value: "unknown", lastError: created.error };
      const bindingId =
        typeof created.value.binding?.bindingId === "string"
          ? created.value.binding.bindingId
          : undefined;
      const sessionId =
        typeof created.value.sessionId === "string" ? created.value.sessionId : undefined;
      if (!bindingId || !sessionId) {
        return {
          value: "unknown",
          lastError:
            "Project Binding diagnostic session response was missing bindingId or sessionId; cleanup was not attempted.",
        };
      }
      const cleanupError = await endProjectBindingDiagnosticSession(
        fetchImpl,
        remote,
        bindingId,
        sessionId,
        timeoutMs,
      );
      if (cleanupError) {
        return { value: "unknown", lastError: cleanupError };
      }
      return { value: "supported", lastError: null };
    }
    if (response.status === 400) return { value: "supported", lastError: null };
    if (response.status >= 200 && response.status < 300) {
      return { value: "supported", lastError: null };
    }
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      return {
        value: "unsupported",
        lastError: `Project Binding session endpoint returned ${response.status}.`,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        value: "unknown",
        lastError: `Project Binding session probe was not authorized (${response.status}).`,
      };
    }
    return {
      value: "unknown",
      lastError: `Project Binding session probe returned ${response.status}.`,
    };
  } catch (error) {
    return { value: "unknown", lastError: errorMessage(error) };
  }
}

function projectBindingSessionsUrl(remote: ResolvedCapletsRemote): URL {
  return controlProjectBindingUrl(remote, "sessions");
}

async function readDiagnosticSessionResponse(response: Response): Promise<
  | {
      ok: true;
      value: {
        binding?: { bindingId?: unknown };
        sessionId?: unknown;
      };
    }
  | { ok: false; error: string }
> {
  try {
    return {
      ok: true,
      value: (await response.json()) as {
        binding?: { bindingId?: unknown };
        sessionId?: unknown;
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Project Binding diagnostic session response could not be parsed; cleanup was not attempted: ${errorMessage(error)}`,
    };
  }
}

async function endProjectBindingDiagnosticSession(
  fetchImpl: typeof fetch,
  remote: ResolvedCapletsRemote,
  bindingId: string,
  sessionId: string,
  timeoutMs: number,
): Promise<string | null> {
  const headers = new Headers(remote.requestInit.headers);
  headers.set("content-type", "application/json");
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      controlProjectBindingUrl(remote, `${encodeURIComponent(bindingId)}/session`),
      timeoutMs,
      {
        ...remote.requestInit,
        method: "DELETE",
        headers,
        body: JSON.stringify({
          sessionId,
          terminalReason: {
            code: "completed",
            message: "Project Binding diagnostic probe completed.",
          },
        }),
      },
    );
    return response.ok ? null : `Project Binding diagnostic cleanup returned ${response.status}.`;
  } catch (error) {
    return `Project Binding diagnostic cleanup failed: ${errorMessage(error)}`;
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: URL,
  timeoutMs: number,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(new Error(`Project Binding session probe timed out after ${timeoutMs}ms.`)),
    timeoutMs,
  );
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function controlProjectBindingUrl(remote: ResolvedCapletsRemote, suffix: string): URL {
  const url = new URL(remote.projectBindingWebSocketUrl);
  if (url.protocol === "wss:") url.protocol = "https:";
  if (url.protocol === "ws:") url.protocol = "http:";
  url.pathname = url.pathname.replace(/\/connect$/u, `/${suffix}`);
  url.search = "";
  url.hash = "";
  return url;
}

async function resolveDaemonSection(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  options: DaemonOperationOptions | undefined,
) {
  try {
    const status = await daemonStatus({ ...options, env });
    return {
      installed: status.installed,
      running: status.running,
      nativeState: status.nativeState,
      health: status.health ? { ok: status.health.ok, url: status.health.url } : null,
      logs: {
        stdout: status.paths.stdoutLog,
        stderr: status.paths.stderrLog,
      },
    };
  } catch (error) {
    return {
      installed: false,
      running: false,
      nativeState: "unknown",
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveExposureSection(env: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  const configPath = env.CAPLETS_CONFIG?.trim() ? env.CAPLETS_CONFIG.trim() : resolveConfigPath();
  const projectConfigPath = env.CAPLETS_PROJECT_CONFIG?.trim()
    ? env.CAPLETS_PROJECT_CONFIG.trim()
    : resolveProjectConfigPath();
  try {
    const config = loadConfig(configPath, projectConfigPath);
    const service = createNativeCapletsService({
      mode: "local",
      configPath,
      projectConfigPath,
      watch: false,
      writeErr: () => undefined,
    });
    try {
      await service.reload();
      const nativeTools = service.listTools();
      const callableIds = new Set(nativeTools.map((tool) => tool.caplet));
      return {
        ok: true,
        default: config.options.exposure,
        discoveryTimeoutMs: config.options.exposureDiscoveryTimeoutMs,
        discoveryConcurrency: config.options.exposureDiscoveryConcurrency,
        callableNativeToolCount: nativeTools.length,
        caplets: allCaplets(config).map((caplet) => {
          const exposure = resolveExposure(caplet.exposure, config.options.exposure);
          const callable =
            callableIds.has(caplet.server) ||
            [...callableIds].some((id) => id.startsWith(`${caplet.server}__`));
          return {
            id: caplet.server,
            exposure: exposure.value,
            callable,
            ...(callable ? {} : { hiddenReason: hiddenReasonFor(caplet) }),
          };
        }),
      };
    } finally {
      await service.close();
    }
  } catch (error) {
    return {
      ok: true,
      configLoaded: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveServerSection(env: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  try {
    const server = resolveCapletsServer({}, env);
    return {
      configured: true,
      baseUrl: server.baseUrl.href,
      mcpUrl: server.mcpUrl.href,
      controlUrl: server.controlUrl.href,
      healthUrl: server.healthUrl.href,
      auth: server.auth.type,
    };
  } catch {
    return { configured: false };
  }
}

type DoctorRemoteLoginSection = {
  report: Record<string, unknown>;
  configured: boolean;
  authenticated: boolean;
  kind?: "cloud" | "self-hosted" | undefined;
  hostUrl?: string | undefined;
  selectedWorkspace?: string | undefined;
  status?: RemoteProfileStatus | undefined;
  credential?: RemoteProfileCredential | undefined;
};

async function resolveRemoteLoginSection(
  options: DoctorOptions,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Promise<DoctorRemoteLoginSection> {
  const remoteUrl = env.CAPLETS_REMOTE_URL;
  if (!remoteUrl) {
    return {
      configured: false,
      authenticated: false,
      report: { configured: false, authenticated: false },
    };
  }
  const store = createRemoteProfileStore({
    authDir: options.authDir,
    env,
    ...(options.cloudAuthStore ? { legacyCloudAuthStore: options.cloudAuthStore } : {}),
  });
  let hostUrl: string | undefined;
  let status: RemoteProfileStatus | undefined;
  let statusError: string | undefined;
  try {
    hostUrl = normalizeRemoteProfileHostUrl(remoteUrl);
    status = isCapletsCloudUrl(remoteUrl)
      ? await store.getCloudProfileStatus({
          hostUrl,
          workspace: env.CAPLETS_REMOTE_WORKSPACE ?? hostedCloudWorkspaceFromRemoteUrl(remoteUrl),
        })
      : await store.getSelfHostedProfileStatus({ hostUrl });
  } catch (error) {
    statusError = error instanceof Error ? error.message : String(error);
  }
  const credential = status ? await store.credentials.load(status.key) : undefined;
  const selectedWorkspace = status?.workspaceSlug ?? status?.workspaceId;
  const report = {
    configured: true,
    authenticated: Boolean(status?.authenticated && credential?.accessToken),
    kind: isCapletsCloudUrl(remoteUrl) ? "cloud" : "self-hosted",
    ...(hostUrl ? { hostUrl } : {}),
    ...(status?.key ? { key: status.key } : {}),
    ...(status?.workspaceId ? { workspaceId: status.workspaceId } : {}),
    ...(status?.workspaceSlug ? { workspaceSlug: status.workspaceSlug } : {}),
    ...(status?.clientId ? { clientId: status.clientId } : {}),
    ...(status?.clientLabel ? { clientLabel: status.clientLabel } : {}),
    ...(status?.expiresAt ? { expiresAt: status.expiresAt } : {}),
    ...(status?.scope ? { scope: status.scope } : {}),
    ...(status?.tokenType ? { tokenType: status.tokenType } : {}),
    ...(statusError ? { error: statusError } : {}),
  };
  return {
    configured: true,
    authenticated: Boolean(status?.authenticated && credential?.accessToken),
    kind: isCapletsCloudUrl(remoteUrl) ? "cloud" : "self-hosted",
    hostUrl,
    selectedWorkspace,
    status,
    credential,
    report,
  };
}

function resolveRemoteSection(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  remoteLogin: DoctorRemoteLoginSection,
) {
  try {
    const mode = resolveRemoteMode({}, env);
    const remote =
      mode.mode === "cloud"
        ? resolveHostedCloudRemote(hostedCloudDoctorInput(remoteLogin), env)
        : resolveCapletsRemote(selfHostedDoctorInput(remoteLogin), env);
    return {
      configured: true,
      baseUrl: remote.baseUrl.href,
      mcpUrl: remote.mcpUrl.href,
      controlUrl: remote.controlUrl.href,
      healthUrl: remote.healthUrl.href,
      webSocketUrl: remote.projectBindingWebSocketUrl.href,
      auth: remote.auth.type,
      tokenPresent: remote.auth.type === "bearer",
      workspace: remote.workspace ?? null,
    };
  } catch {
    return { configured: false };
  }
}

function hostedCloudDoctorInput(remoteLogin: DoctorRemoteLoginSection) {
  if (!remoteLogin.credential?.accessToken) return {};
  const workspace = remoteLogin.selectedWorkspace;
  return {
    token: remoteLogin.credential.accessToken,
    ...(workspace ? { workspace } : {}),
  };
}

function selfHostedDoctorInput(remoteLogin: DoctorRemoteLoginSection) {
  if (!remoteLogin.credential?.accessToken) return {};
  return { token: remoteLogin.credential.accessToken };
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

async function resolveCodeModeSection(
  options: DoctorOptions,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const emptyDeclaration = generateCodeModeDeclarations({ caplets: [] });
  const diagnostics = diagnoseCodeModeTypeScript({
    declaration: emptyDeclaration,
    code: "return 1;",
  });
  const tempDir = mkdtempSync(join(tmpdir(), "caplets-code-mode-doctor-"));
  try {
    const logStore = new CodeModeLogStore({ stateDir: tempDir });
    const stored = await logStore.store([
      {
        level: "log",
        message: "doctor smoke",
        timestamp: new Date(0).toISOString(),
      },
    ]);
    const read = await logStore.read({ logRef: stored.logRef });
    const sandboxSmoke = await runCodeMode({
      code: "return 1;",
      service: emptyCodeModeDoctorService(),
      logStore,
    });
    return {
      typesGeneration: { ok: emptyDeclaration.includes("declare const caplets") },
      diagnostics: { ok: diagnostics.every((diagnostic) => diagnostic.severity !== "error") },
      sandboxSmoke: { ok: sandboxSmoke.ok },
      logStorage: { ok: read.entries.length === 1 },
      callableIndex: await resolveCallableIndexDoctor(env),
      observedOutputShapes: await resolveObservedOutputShapesDoctor(options),
    };
  } catch (error) {
    return {
      typesGeneration: { ok: true },
      diagnostics: { ok: diagnostics.every((diagnostic) => diagnostic.severity !== "error") },
      sandboxSmoke: { ok: false, error: error instanceof Error ? error.message : String(error) },
      logStorage: { ok: false, error: error instanceof Error ? error.message : String(error) },
      callableIndex: { ok: false, error: error instanceof Error ? error.message : String(error) },
      observedOutputShapes: await resolveObservedOutputShapesDoctor(options),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function resolveObservedOutputShapesDoctor(options: DoctorOptions) {
  const store = new FileObservedOutputShapeStore(
    options.observedOutputShapeCacheDir ?? DEFAULT_OBSERVED_OUTPUT_SHAPE_CACHE_DIR,
  );
  if (!store.health) return { ok: false, error: "store health unavailable" };
  const health = await store.health();
  return {
    ok: health.readable && health.writable,
    path: health.path,
    readable: health.readable,
    writable: health.writable,
    entryCount: health.entryCount ?? null,
    prune: health.prune ?? null,
    ...(health.error ? { error: health.error } : {}),
  };
}

async function resolveCallableIndexDoctor(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  try {
    const service = createNativeCapletsService({
      mode: "local",
      ...(env.CAPLETS_CONFIG?.trim() ? { configPath: env.CAPLETS_CONFIG.trim() } : {}),
      ...(env.CAPLETS_PROJECT_CONFIG?.trim()
        ? { projectConfigPath: env.CAPLETS_PROJECT_CONFIG.trim() }
        : {}),
      watch: false,
      writeErr: () => undefined,
    });
    try {
      await service.reload();
      return { ok: true, callableCount: listCodeModeCallableCaplets(service).length };
    } finally {
      await service.close();
    }
  } catch (error) {
    return {
      ok: true,
      callableCount: 0,
      configLoaded: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function emptyCodeModeDoctorService() {
  return {
    listTools: () => [],
    execute: async () => undefined,
    reload: async () => true,
    onToolsChanged: () => () => undefined,
    close: async () => undefined,
  };
}

function doctorOk(value: unknown): string {
  return value && typeof value === "object" && (value as { ok?: unknown }).ok === true
    ? "ok"
    : "failed";
}

function observedOutputShapePath(value: unknown): string | undefined {
  return value &&
    typeof value === "object" &&
    typeof (value as { path?: unknown }).path === "string"
    ? (value as { path: string }).path
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function allCaplets(config: { [key: string]: unknown }): CapletConfig[] {
  const typed = config as {
    mcpServers?: Record<string, CapletConfig>;
    openapiEndpoints?: Record<string, CapletConfig>;
    googleDiscoveryApis?: Record<string, CapletConfig>;
    graphqlEndpoints?: Record<string, CapletConfig>;
    httpApis?: Record<string, CapletConfig>;
    cliTools?: Record<string, CapletConfig>;
    capletSets?: Record<string, CapletConfig>;
  };
  return [
    ...Object.values(typed.mcpServers ?? {}),
    ...Object.values(typed.openapiEndpoints ?? {}),
    ...Object.values(typed.googleDiscoveryApis ?? {}),
    ...Object.values(typed.graphqlEndpoints ?? {}),
    ...Object.values(typed.httpApis ?? {}),
    ...Object.values(typed.cliTools ?? {}),
    ...Object.values(typed.capletSets ?? {}),
  ];
}

function hiddenReasonFor(caplet: CapletConfig): string {
  if (caplet.disabled) return "disabled";
  if (caplet.setup) return "setup_required";
  if (caplet.projectBinding?.required) return "project_binding_missing_context";
  return "not_exposed";
}
