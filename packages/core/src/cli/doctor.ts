import { findProjectRoot, fingerprintProjectRoot } from "../cloud/project-root";
import { CloudAuthStore, redactedCloudAuthStatus } from "../cloud-auth/store";
import { projectBindingWorkspacePaths } from "../project-binding/workspaces";
import { resolveCapletsRemote } from "../remote/options";
import { resolveCapletsServer } from "../server/options";
import type { MutagenProjectSyncDoctorData } from "../project-binding/mutagen";

export type DoctorOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  cwd?: string;
  syncStatus?: MutagenProjectSyncDoctorData;
  cloudAuthStore?: CloudAuthStore;
};

export type DoctorJsonReport = {
  server: Record<string, unknown>;
  remote: Record<string, unknown>;
  projectBinding: Record<string, unknown>;
  sync: Record<string, unknown>;
  daemon: Record<string, unknown>;
  cloudAuth: Record<string, unknown>;
};

export async function doctorJsonReport(options: DoctorOptions = {}): Promise<DoctorJsonReport> {
  const env = options.env ?? process.env;
  const root = findProjectRoot(options.cwd ?? process.cwd());
  const projectFingerprint = fingerprintProjectRoot(root);
  const paths = projectBindingWorkspacePaths(projectFingerprint, { env });
  const server = resolveServerSection(env);
  const remote = resolveRemoteSection(env);
  const credentials = await (options.cloudAuthStore ?? new CloudAuthStore({ env })).load();

  return {
    server,
    remote,
    projectBinding: {
      state: "not_attached",
      projectRoot: root,
      projectFingerprint,
      workspacePath: paths.project,
      authMode: credentials
        ? "hosted_cloud"
        : remote.configured
          ? "self_hosted_remote"
          : "unconfigured",
      selectedWorkspace:
        credentials?.workspaceSlug ?? credentials?.workspaceId ?? remote.workspace ?? null,
      webSocketUrl: remote.webSocketUrl,
      lease: null,
      lastUpgradeError: null,
      recoveryCommand:
        credentials || remote.configured ? "caplets attach --once" : "caplets cloud auth login",
    },
    sync: {
      state: options.syncStatus?.state ?? "idle",
      diagnosticCode: options.syncStatus?.diagnosticCode ?? null,
      mutagenBinary: options.syncStatus?.mutagenBinary ?? "mutagen",
      mutagenVersion: options.syncStatus?.mutagenVersion ?? null,
      lastCommand: options.syncStatus?.lastCommand ?? null,
    },
    daemon: {
      configured: false,
      running: false,
    },
    cloudAuth: redactedCloudAuthStatus(credentials),
  };
}

export async function formatDoctorReport(options: DoctorOptions = {}): Promise<string> {
  const report = await doctorJsonReport(options);
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
    `  Recovery: ${report.projectBinding.recoveryCommand}`,
    "",
    "Project sync",
    `  State: ${report.sync.state}`,
    `  Mutagen: ${report.sync.mutagenVersion ?? report.sync.mutagenBinary}`,
    ...(report.sync.diagnosticCode ? [`  Diagnostic: ${report.sync.diagnosticCode}`] : []),
    "",
    "Daemon",
    `  Running: ${yesNo(Boolean(report.daemon.running))}`,
    "",
    "Cloud Auth",
    `  Authenticated: ${yesNo(Boolean(report.cloudAuth.authenticated))}`,
    ...(report.cloudAuth.cloudUrl ? [`  Cloud URL: ${report.cloudAuth.cloudUrl}`] : []),
    ...(report.cloudAuth.workspaceSlug || report.cloudAuth.workspaceId
      ? [`  Selected Workspace: ${report.cloudAuth.workspaceSlug ?? report.cloudAuth.workspaceId}`]
      : []),
  ];
  return `${lines.join("\n")}\n`;
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
      auth: server.auth.enabled ? "basic" : "none",
    };
  } catch {
    return { configured: false };
  }
}

function resolveRemoteSection(env: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  try {
    const remote = resolveCapletsRemote({}, env);
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

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}
