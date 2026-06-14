import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeCapletsService } from "../native/service";
import { findProjectRoot, fingerprintProjectRoot } from "../cloud/project-root";
import {
  CloudAuthStore,
  redactedCloudAuthStatus,
  type CloudAuthCredentials,
} from "../cloud-auth/store";
import { projectBindingWorkspacePaths } from "../project-binding/workspaces";
import {
  resolveCapletsRemote,
  resolveHostedCloudRemote,
  resolveRemoteMode,
} from "../remote/options";
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
import { loadConfig, type CapletConfig } from "../config";
import { resolveExposure } from "../exposure/policy";

export type DoctorOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  cwd?: string;
  syncStatus?: MutagenProjectSyncDoctorData;
  cloudAuthStore?: CloudAuthStore;
  observedOutputShapeCacheDir?: string;
};

export type DoctorJsonReport = {
  server: Record<string, unknown>;
  remote: Record<string, unknown>;
  projectBinding: Record<string, unknown>;
  sync: Record<string, unknown>;
  daemon: Record<string, unknown>;
  cloudAuth: Record<string, unknown>;
  exposure: Record<string, unknown>;
  codeMode: Record<string, unknown>;
};

export async function doctorJsonReport(options: DoctorOptions = {}): Promise<DoctorJsonReport> {
  const env = options.env ?? process.env;
  const root = findProjectRoot(options.cwd ?? process.cwd());
  const projectFingerprint = fingerprintProjectRoot(root);
  const paths = projectBindingWorkspacePaths(projectFingerprint, { env });
  const credentials = await (options.cloudAuthStore ?? new CloudAuthStore({ env })).load();
  const server = resolveServerSection(env);
  const remote = resolveRemoteSection(env, credentials);

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
    exposure: await resolveExposureSection(env),
    codeMode: await resolveCodeModeSection(options, env),
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
      auth: server.auth.enabled ? "basic" : "none",
    };
  } catch {
    return { configured: false };
  }
}

function resolveRemoteSection(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  credentials?: CloudAuthCredentials | null,
) {
  try {
    const mode = resolveRemoteMode({}, env);
    const remote =
      mode.mode === "cloud"
        ? resolveHostedCloudRemote(hostedCloudDoctorInput(credentials), env)
        : resolveCapletsRemote({}, env);
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

function hostedCloudDoctorInput(credentials?: CloudAuthCredentials | null) {
  if (!credentials?.accessToken) return {};
  const workspace = credentials.workspaceSlug ?? credentials.workspaceId;
  return {
    token: credentials.accessToken,
    ...(workspace ? { workspace } : {}),
  };
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

function allCaplets(config: { [key: string]: unknown }): CapletConfig[] {
  const typed = config as {
    mcpServers?: Record<string, CapletConfig>;
    openapiEndpoints?: Record<string, CapletConfig>;
    graphqlEndpoints?: Record<string, CapletConfig>;
    httpApis?: Record<string, CapletConfig>;
    cliTools?: Record<string, CapletConfig>;
    capletSets?: Record<string, CapletConfig>;
  };
  return [
    ...Object.values(typed.mcpServers ?? {}),
    ...Object.values(typed.openapiEndpoints ?? {}),
    ...Object.values(typed.graphqlEndpoints ?? {}),
    ...Object.values(typed.httpApis ?? {}),
    ...Object.values(typed.cliTools ?? {}),
    ...Object.values(typed.capletSets ?? {}),
  ];
}

function hiddenReasonFor(caplet: CapletConfig): string {
  if (caplet.disabled) return "disabled";
  if (caplet.setup) return "setup_required";
  if (caplet.projectBinding?.required) return "project_binding_required";
  return "not_exposed";
}
