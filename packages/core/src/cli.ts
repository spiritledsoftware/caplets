import { Command, CommanderError, Option } from "commander";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { version as packageJsonVersion } from "../package.json";
import {
  addCliCaplet,
  addGoogleDiscoveryCaplet,
  addGraphqlCaplet,
  addHttpCaplet,
  addMcpCaplet,
  addOpenApiCaplet,
} from "./cli/add";
import { buildCloudCapletBundle } from "./cli/cloud-add";
import {
  loginAuth,
  logoutAuth,
  formatAuthRows,
  listLocalAuthRowsFromRepository,
  localAuthTargets,
  refreshAuth,
  type AuthSource,
  type AuthStatusRow,
} from "./cli/auth";
import { cliCommands } from "./cli/commands";
import { codeModeTypesCli, runCodeModeCli, runCodeModeReplCli } from "./cli/code-mode";
import { initConfig } from "./cli/init";
import { doctorJsonReport, formatDoctorReport, type DoctorOptions } from "./cli/doctor";
import {
  completeCliWords,
  completionScript,
  completionShells,
  trailingSpaceCompletionToken,
  type CompletionShell,
} from "./cli/completion";
import { CloudAuthClient } from "./cloud-auth/client";
import { openBrowserUrl } from "./cloud-auth/open-url";
import { CapletsCloudClient } from "./cloud/client";
import {
  formatCapletList,
  formatConfigPaths,
  listCaplets,
  resolveCliConfigPaths,
} from "./cli/inspection";
import {
  formatVaultAccessGrant,
  formatVaultAccessList,
  formatVaultAccessRevoke,
  formatVaultDeleteStatus,
  formatVaultValueList,
  formatVaultValueStatus,
} from "./cli/vault";
import {
  installCaplets,
  indexInstalledCapletsFromLockfile,
  restoreCapletsFromLockfile,
  updateCapletsFromLockfile,
} from "./cli/install";
import type { CatalogIndexingResult } from "./catalog-indexing/payload";
import { readCapletsLockfile } from "./cli/lockfile";
import {
  formatSetupMenu,
  runInteractiveSetup,
  runSetup,
  type SetupCommandRunner,
  type SetupFormat,
  type SetupMcpOperations,
  type SetupOptions,
  type SetupPhaseOperations,
  type SetupPromptReader,
} from "./cli/setup";
import {
  type CapletsConfig,
  type ConfigSource,
  type ConfigWithSources,
  type LocalOverlayConfigWithSources,
  defaultUpdateCheckCacheDir,
  defaultUpdateCheckStateDir,
  defaultCapletsLockfilePath,
  formatVaultRecoveryCommand,
  loadGlobalServeDefaults,
  loadConfigWithSources,
  loadLocalOverlayConfigWithSources,
  loadLocalRuntimeConfig,
  resolveCapletsRoot,
  resolveConfigPath,
  resolveProjectCapletsRoot,
  resolveProjectConfigPath,
  resolveProjectLockfilePath,
  vaultBootstrapResolver,
} from "./config";
import { createCapletsEngine, type CapletsEngine } from "./engine";
import type { ControlPlaneSecurityRepository } from "./control-plane/security/repository";
import { CapletsError } from "./errors";
import { resolveAttachServeOptions, type AttachServeOptions } from "./attach/options";
import { attachResolvedCaplets } from "./attach/server";
import { attachProjectOnce } from "./project-binding/attach";
import { ProjectBindingError } from "./project-binding/errors";
import type { ProjectBindingWebSocketFactory } from "./project-binding/transport";
import { RemoteControlClient } from "./remote-control/client";
import type {
  RemoteCliArgumentsByCommand,
  RemoteCliCommand,
  TypedRemoteCliCommand,
} from "./remote-control/types";
import {
  cloudCredentialsFromRemoteProfile,
  createRemoteProfileStore,
  type FileRemoteProfileStore,
} from "./remote/profile-store";
import type { RemoteClientRole } from "./remote/server-credentials";
import { resolveRemoteSelection } from "./remote/selection";
import {
  hostedCloudWorkspaceFromRemoteUrl,
  isCapletsCloudUrl,
  normalizeRemoteProfileHostUrl,
  resolveRemoteMode,
} from "./remote/options";
import type { RemoteProfileCredential, RemoteProfileStatus } from "./remote/profiles";
import {
  daemonLogs,
  daemonStatus,
  followDaemonLogs,
  installDaemon,
  redactDaemonInstallResult,
  resolveDaemonPaths,
  restartDaemon,
  startDaemon,
  stopDaemon,
  uninstallDaemon,
  type DaemonInstallOptions,
  type DaemonLogStream,
  type DaemonOperationOptions,
} from "./daemon";
import { resolveServeOptions, serveResolvedCaplets, type ServeOptions } from "./serve";
import { defaultStorageStateDir, defaultTelemetryStateDir } from "./config/paths";
import { approvePendingLoginThroughHostLocalAuthority } from "./serve/host-local-credential-authority";
import { appendBasePath, healthUrlForBase } from "./server/options";
import {
  acknowledgeTelemetryAttributionClaim,
  claimTelemetryAttribution,
  deleteTelemetryIdentity,
  buildProductTelemetryEvent,
  buildReliabilityTelemetryEvent,
  createTelemetryDispatcher,
  durationBucket,
  maybePrintTelemetryNotice,
  readTelemetryDeliveryHealth,
  readTelemetryIdentity,
  readTelemetryNotice,
  releaseTelemetryAttributionClaim,
  resolveTelemetryState,
  rotateTelemetryIdentity,
  TelemetryDebugSink,
  type CommandFamily,
  type DiagnosticCategory,
  type TelemetryDispatcher,
  type TelemetryProperties,
  type TelemetrySurface,
  writeTelemetryAttribution,
} from "./telemetry";
import { maybePrintUpdateNotice } from "./update-check";
import { FileVaultStore, VAULT_MAX_VALUE_BYTES, validateVaultKeyName } from "./vault";
import type { VaultAccessGrantFilter } from "./vault";
import {
  createProductionControlPlane,
  createProductionCurrentHostOfflineTransferClient,
  runProductionControlPlaneOfflineMigration,
} from "./control-plane/production-runtime";
import { createControlPlaneService } from "./control-plane/service";
import type {
  ControlPlaneAuthorizationDecision,
  ControlPlaneAuthorizationRequest,
} from "./control-plane/authorization";
import type { InternalControlPlaneStorageMigrationService } from "./control-plane/service";
import {
  createCurrentHostManagementClient,
  type CurrentHostManagementClient,
} from "./current-host/client-operations";
import {
  createCurrentHostOperations,
  parseCurrentHostManagementMutation,
  parseCurrentHostOperationBinding,
  parseCurrentHostOfflineTransferConfirmation,
  parseCurrentHostOfflineTransferStartRequest,
  parseCurrentHostPortableOperation,
  trustedDevelopmentOperatorPrincipal,
  type CurrentHostManagementResource,
  type CurrentHostOfflineTransferClient,
  type CurrentHostOfflineTransferConfirmation,
  type CurrentHostOfflineTransferResult,
  type CurrentHostOfflineTransferPreview,
  type CurrentHostPortableOperation,
  type CurrentHostPortableOperationOutcome,
} from "./current-host/operations";
import { parsePortableArtifactReference } from "./media/artifacts";

export { initConfig, starterConfig } from "./cli/init";
export { installCaplets, normalizeGitRepo } from "./cli/install";
export {
  addCliCaplet,
  addGoogleDiscoveryCaplet,
  addGraphqlCaplet,
  addHttpCaplet,
  addMcpCaplet,
  addOpenApiCaplet,
} from "./cli/add";

type CliIO = {
  writeOut?: (value: string) => void;
  writeErr?: (value: string) => void;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  projectBindingWebSocketFactory?: ProjectBindingWebSocketFactory;
  authDir?: string;
  telemetryStateDir?: string;
  updateCheckCacheDir?: string;
  updateCheckStateDir?: string;
  stderrIsTTY?: boolean;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  telemetryDebugSink?: TelemetryDebugSink;
  version?: string;
  setExitCode?: (code: number) => void;
  maybePrintUpdateNotice?: () => Promise<void>;
  serve?: (options: ServeOptions) => Promise<void>;
  attachServe?: (options: AttachServeOptions) => Promise<void>;
  daemon?: DaemonOperationOptions;
  runSetupCommand?: SetupCommandRunner;
  setupOperations?: SetupPhaseOperations;
  mcpOperations?: SetupMcpOperations;
  readStdin?: () => Promise<string>;
  internalStorageMigration?: InternalControlPlaneStorageMigrationService;
  internalCurrentHostManagement?: CurrentHostManagementClient;
  internalCurrentHostOfflineTransfer?: CurrentHostOfflineTransferClient;
  internalDoctorRuntime?: NonNullable<DoctorOptions["effectiveRuntime"]>;
};

export async function runCli(args: string[], io: CliIO = {}): Promise<void> {
  let observedExitCode = 0;
  let updateNoticeHandled = false;
  const wrappedIo: CliIO = {
    ...io,
    setExitCode: (code) => {
      observedExitCode = code;
      if (io.setExitCode) {
        io.setExitCode(code);
      } else {
        process.exitCode = code;
      }
    },
  };
  wrappedIo.maybePrintUpdateNotice = async () => {
    if (updateNoticeHandled) return;
    updateNoticeHandled = true;
    await maybePrintUpdateNotice({
      args,
      env: wrappedIo.env,
      version: wrappedIo.version,
      fetcher: wrappedIo.fetch,
      signal: wrappedIo.signal,
      stderrIsTTY: wrappedIo.stderrIsTTY ?? process.stderr.isTTY === true,
      writeErr: wrappedIo.writeErr,
      cacheDir: wrappedIo.updateCheckCacheDir ?? defaultUpdateCheckCacheDir(wrappedIo.env),
      stateDir: wrappedIo.updateCheckStateDir ?? defaultUpdateCheckStateDir(wrappedIo.env),
      refreshForLater: shouldRefreshUpdateMetadataForLater(args),
    }).catch(() => undefined);
  };
  const program = createProgram(wrappedIo);
  const trackedCommand = telemetryCommandFamilyFromArgs(args);
  const startedAt = Date.now();
  const telemetryContext = telemetryContextForIo(wrappedIo);
  const dispatcher = createTelemetryDispatcher({
    stateDir: telemetryContext.stateDir,
  });
  try {
    if (args.length === 0) {
      program.outputHelp();
      return;
    }
    await program.parseAsync(["node", "caplets", ...args]);
    await wrappedIo.maybePrintUpdateNotice();
    if (trackedCommand) {
      await captureCliTelemetry(telemetryContext, {
        debugSink: wrappedIo.telemetryDebugSink,
        dispatcher,
        commandFamily: trackedCommand.commandFamily,
        surface: trackedCommand.surface,
        outcome: observedExitCode === 0 ? "success" : "failure",
        startedAt,
      });
    }
  } catch (error) {
    let normalizedError = error;
    let captureProductEvent = true;
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version" ||
        error.message === "(outputHelp)"
      ) {
        return;
      }
      normalizedError = new CapletsError("REQUEST_INVALID", error.message);
      captureProductEvent = false;
    }
    if (trackedCommand) {
      await captureCliTelemetry(telemetryContext, {
        debugSink: wrappedIo.telemetryDebugSink,
        dispatcher,
        commandFamily: trackedCommand.commandFamily,
        surface: trackedCommand.surface,
        outcome: "failure",
        startedAt,
        error: normalizedError,
        productEvent: captureProductEvent,
      }).catch(() => undefined);
    }
    throw normalizedError;
  } finally {
    await dispatcher.shutdown();
  }
}

function shouldRefreshUpdateMetadataForLater(args: string[]): boolean {
  const command = args[0];
  if (command === cliCommands.serve) return true;
  if (command !== cliCommands.attach) return false;
  return !args.some((arg) => arg === "--once");
}

function normalizeCompletionWords(words: string[]): string[] {
  return words.map((word) => (word === trailingSpaceCompletionToken ? "" : word));
}

type DaemonInstallCommandOptions = {
  host?: string;
  port?: string;
  path?: string;
  remoteStatePath?: string;
  upstreamUrl?: string;
  allowUnauthenticatedHttp?: boolean;
  trustProxy?: boolean;
  json?: boolean;
  reset?: boolean;
  env?: string[];
  unsetEnv?: string[];
  inheritEnv?: boolean;
  dryRun?: boolean;
  validate?: boolean;
  start?: boolean;
  restart?: boolean;
  noRestart?: boolean;
};

type DaemonCommandOptions = {
  json?: boolean;
};

type DaemonLogsCommandOptions = DaemonCommandOptions & {
  follow?: boolean;
  tail?: string;
  stream?: DaemonLogStream;
};

function addJsonOption(command: Command): Command {
  return command.option("--json", "print JSON output");
}

function addDaemonInstallOptions(command: Command): Command {
  return addJsonOption(command)
    .option("--host <host>", "HTTP bind host")
    .option("--port <port>", "HTTP bind port")
    .option("--path <path>", "HTTP service base path")
    .option("--remote-state-path <path>", "server-owned remote credential state directory")
    .option(
      "--upstream-url <url>",
      "upstream Caplets runtime URL to compose with this HTTP service",
    )
    .option(
      "--allow-unauthenticated-http",
      "allow unauthenticated HTTP serving on non-loopback hosts",
    )
    .option("--trust-proxy", "trust X-Forwarded-* headers from a reverse proxy")
    .option("--reset", "rebuild daemon configuration from defaults")
    .option("--env <KEY=VALUE>", "set an environment variable for the service", collectValues, [])
    .option(
      "--unset-env <KEY>",
      "remove an environment variable from the service",
      collectValues,
      [],
    )
    .option("--inherit-env", "run the service through the user's shell environment")
    .option("--no-inherit-env", "disable shell environment inheritance")
    .option("--dry-run", "preview actions without writing files or registering a service")
    .option("--no-validate", "skip temporary service command validation")
    .option("--start", "start the service after install")
    .option("--restart", "restart the service after install")
    .option("--no-restart", "do not restart a running service after updating config");
}

function addServeMigrationCommand(parent: Command, name: string, replacement: string): void {
  parent
    .command(name, { hidden: true })
    .allowUnknownOption(true)
    .action(() => {
      throw new CapletsError(
        "REQUEST_INVALID",
        `caplets serve ${name} has moved. Use ${replacement}.`,
      );
    });
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const HIDDEN_INPUT_PROMPT_LABELS = {
  vaultValue: "Value: ",
} as const;

export const readHiddenInputForTest = readHiddenInput;

type TelemetryCliContext = {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  configPath: string | undefined;
  projectConfigPath: string;
  stateDir: string;
  stderrIsTTY: boolean;
  writeErr: (value: string) => void;
};

function telemetryContextForIo(io: CliIO): TelemetryCliContext {
  const env = io.env ?? process.env;
  return {
    env,
    configPath: envConfigPath(env),
    projectConfigPath: envProjectConfigPath(env),
    stateDir: io.telemetryStateDir ?? defaultTelemetryStateDir(env),
    stderrIsTTY: io.stderrIsTTY ?? process.stderr.isTTY === true,
    writeErr: io.writeErr ?? ((value: string) => process.stderr.write(value)),
  };
}

function telemetryCommandFamilyFromArgs(
  args: string[],
): { commandFamily: CommandFamily; surface: TelemetrySurface } | undefined {
  const command = args[0];
  if (
    command === undefined ||
    command === "--help" ||
    command === "-h" ||
    command === "--version" ||
    command === "-V" ||
    command === cliCommands.telemetry ||
    command === cliCommands.completion ||
    command === cliCommands.completeHidden
  ) {
    return undefined;
  }
  if (command === cliCommands.serve) return { commandFamily: "serve", surface: "serve" };
  if (command === cliCommands.attach) return { commandFamily: "attach", surface: "attach" };
  if (command === cliCommands.daemon) return { commandFamily: "daemon", surface: "daemon" };
  if (command === cliCommands.codeMode) {
    return { commandFamily: "code_mode", surface: "code_mode" };
  }
  if (command === cliCommands.setup) return { commandFamily: "setup", surface: "cli" };
  if (command === cliCommands.init) return { commandFamily: "init", surface: "cli" };
  if (command === cliCommands.install) return { commandFamily: "install", surface: "cli" };
  if (command === cliCommands.update) return { commandFamily: "install", surface: "cli" };
  if (command === cliCommands.add) return { commandFamily: "add", surface: "cli" };
  if (command === cliCommands.doctor) return { commandFamily: "doctor", surface: "cli" };
  if (command === cliCommands.auth) return { commandFamily: "auth", surface: "cli" };
  if (command === cliCommands.remote || command === cliCommands.cloud) {
    return { commandFamily: "remote", surface: "cli" };
  }
  if (command === cliCommands.inspect) return { commandFamily: "inspect", surface: "cli" };
  if (command === cliCommands.checkBackend) return { commandFamily: "check", surface: "cli" };
  if (
    command === cliCommands.listTools ||
    command === cliCommands.searchTools ||
    command === cliCommands.getTool ||
    command === cliCommands.callTool
  ) {
    return { commandFamily: "tools", surface: "cli" };
  }
  if (
    command === cliCommands.listResources ||
    command === cliCommands.searchResources ||
    command === cliCommands.listResourceTemplates ||
    command === cliCommands.readResource
  ) {
    return { commandFamily: "resources", surface: "cli" };
  }
  if (
    command === cliCommands.listPrompts ||
    command === cliCommands.searchPrompts ||
    command === cliCommands.getPrompt
  ) {
    return { commandFamily: "prompts", surface: "cli" };
  }
  if (command === cliCommands.complete) return { commandFamily: "complete", surface: "cli" };
  return { commandFamily: "unknown", surface: "cli" };
}

function telemetryConfigForCli(context: TelemetryCliContext): Pick<CapletsConfig, "telemetry"> {
  try {
    return loadConfigWithSources(context.configPath, context.projectConfigPath, {
      vaultResolver: vaultBootstrapResolver,
    }).config;
  } catch (error) {
    if (error instanceof CapletsError && error.code !== "CONFIG_INVALID") {
      return {};
    }
    return telemetryOnlyConfigForCli(resolveConfigPath(context.configPath)) ?? { telemetry: false };
  }
}

function telemetryOnlyConfigForCli(path: string): Pick<CapletsConfig, "telemetry"> | undefined {
  try {
    const config = readUserConfigObject(path);
    return typeof config.telemetry === "boolean" ? { telemetry: config.telemetry } : undefined;
  } catch {
    return undefined;
  }
}

function maybePrintCliTelemetryNotice(
  context: TelemetryCliContext,
  surface: TelemetrySurface,
): void {
  const state = resolveTelemetryState({
    config: telemetryConfigForCli(context),
    env: context.env,
    stateDir: context.stateDir,
    surface,
    visibility: "visible",
    allowWithoutNotice: true,
    createIdentity: false,
  });
  if (state.status !== "enabled" || state.notice.shown) return;
  maybePrintTelemetryNotice({
    stateDir: context.stateDir,
    surface,
    stderrIsTTY: context.stderrIsTTY,
    writeErr: context.writeErr,
  });
}

async function captureCliTelemetry(
  context: TelemetryCliContext,
  options: {
    debugSink?: TelemetryDebugSink | undefined;
    dispatcher?: TelemetryDispatcher | undefined;
    commandFamily: CommandFamily;
    surface?: TelemetrySurface | undefined;
    outcome: "success" | "failure";
    startedAt: number;
    error?: unknown;
    productEvent?: boolean | undefined;
  },
): Promise<void> {
  try {
    maybePrintCliTelemetryNotice(context, options.surface ?? "cli");
  } catch {
    // Telemetry notice delivery is best-effort and must not affect command behavior.
  }
  const state = resolveTelemetryState({
    config: telemetryConfigForCli(context),
    env: context.env,
    stateDir: context.stateDir,
    surface: options.surface ?? "cli",
    visibility: "visible",
    debug: context.env.CAPLETS_TELEMETRY_DEBUG === "1",
  });
  if (state.status !== "enabled" && state.status !== "debug") return;
  const identity =
    state.status === "debug"
      ? readTelemetryIdentity({ stateDir: context.stateDir, create: false })
      : (state.identity ?? readTelemetryIdentity({ stateDir: context.stateDir, create: true }));
  if (options.productEvent !== false) {
    const attributionClaim =
      state.status === "enabled" && options.outcome === "success"
        ? claimTelemetryAttribution({ stateDir: context.stateDir, env: context.env })
        : undefined;
    try {
      const product = buildProductTelemetryEvent({
        name: "caplets_cli_command",
        distinctId: identity.id,
        properties: {
          package: "@caplets/core",
          version: packageJsonVersion,
          surface: options.surface ?? "cli",
          runtime_mode: runtimeModeForEnv(context.env),
          execution_context: state.executionContext,
          command_family: options.commandFamily,
          outcome: options.outcome,
          duration_bucket: durationBucket(Date.now() - options.startedAt),
          ...(attributionClaim
            ? {
                attribution_source: attributionClaim.attribution.source,
                attribution_intent: attributionClaim.attribution.intent,
                first_activation: true,
              }
            : {}),
        },
      });
      if (state.status === "debug") {
        options.debugSink?.capture("debug", product);
      } else {
        await (
          options.dispatcher ?? createTelemetryDispatcher({ stateDir: context.stateDir })
        ).capture(state, product);
        if (attributionClaim) {
          acknowledgeTelemetryAttributionClaim({
            stateDir: context.stateDir,
            env: context.env,
            claim: attributionClaim,
          });
        }
      }
    } catch (error) {
      if (attributionClaim) releaseTelemetryAttributionClaim(attributionClaim);
      throw error;
    }
  }

  if (options.outcome !== "failure") return;
  if (options.error === undefined) return;
  const reliability = buildReliabilityTelemetryEvent({
    name: "caplets_reliability_error",
    properties: {
      package: "@caplets/core",
      version: packageJsonVersion,
      surface: options.surface ?? "cli",
      runtime_mode: runtimeModeForEnv(context.env),
      command_family: options.commandFamily,
      error_code: errorCodeForTelemetry(options.error),
      diagnostic_category: diagnosticCategoryForError(options.error),
      os_family: platform(),
      arch: architectureForTelemetry(),
      node_major: Number(process.versions.node.split(".")[0] ?? 0),
    },
    error: options.error,
  });
  if (state.status === "debug") {
    options.debugSink?.capture("debug", reliability);
    return;
  }
  await (options.dispatcher ?? createTelemetryDispatcher({ stateDir: context.stateDir })).capture(
    state,
    reliability,
  );
}

function readUserConfigObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (error) {
    throw new CapletsError("CONFIG_INVALID", `Caplets config at ${path} is not valid JSON`, error);
  }
}

function runtimeModeForEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  const mode = env.CAPLETS_MODE;
  return mode === "remote" || mode === "cloud" || mode === "local" ? mode : "unknown";
}

const TELEMETRY_ARCHITECTURES = new Set([
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc",
  "ppc64",
  "riscv64",
  "s390",
  "s390x",
  "x64",
  "x32",
]);

function architectureForTelemetry(): NonNullable<TelemetryProperties["arch"]> {
  const value = arch();
  return TELEMETRY_ARCHITECTURES.has(value)
    ? (value as NonNullable<TelemetryProperties["arch"]>)
    : "unknown";
}

function errorCodeForTelemetry(error: unknown): string {
  if (error instanceof CapletsError) return error.code;
  return "UNKNOWN";
}

function diagnosticCategoryForError(error: unknown): DiagnosticCategory {
  if (!(error instanceof CapletsError)) return "unknown";
  if (error.code.startsWith("CONFIG")) return "config";
  if (error.code.startsWith("AUTH")) return "auth";
  if (error.code.includes("NETWORK") || error.code.includes("UNAVAILABLE")) return "network";
  if (error.code.includes("VALID") || error.code.includes("REQUEST")) return "validation";
  return "runtime";
}

function writeTelemetryConfig(path: string, enabled: boolean): void {
  const config = {
    ...readUserConfigObject(path),
    $schema: "https://caplets.dev/config.schema.json",
    telemetry: enabled,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function formatTelemetryStatus(context: TelemetryCliContext): string {
  const config = telemetryConfigForCli(context);
  const state = resolveTelemetryState({
    config,
    env: context.env,
    stateDir: context.stateDir,
    surface: "cli",
    visibility: "visible",
    createIdentity: false,
  });
  const notice = readTelemetryNotice({ stateDir: context.stateDir });
  const identity = readTelemetryIdentity({ stateDir: context.stateDir, create: false });
  const health = readTelemetryDeliveryHealth({ stateDir: context.stateDir });
  const lines = [
    `Telemetry: ${state.status}`,
    `Decision: ${state.decider}`,
    `Config: ${config.telemetry === false ? "disabled" : "enabled"}`,
    `Environment: ${context.env.CAPLETS_DISABLE_TELEMETRY === "1" ? "disabled" : "enabled"}`,
    `Notice shown: ${notice.shown ? `yes (${notice.surface})` : "no"}`,
    `Anonymous ID: ${identity.kind === "stable" ? "present" : "not stored"}`,
    `Delivery health: ${Object.keys(health).length === 0 ? "none" : JSON.stringify(health)}`,
    "Disable with CAPLETS_DISABLE_TELEMETRY=1 or `caplets telemetry disable`.",
  ];
  return `${lines.join("\n")}\n`;
}

function remoteProfileStore(
  authDir: string | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): FileRemoteProfileStore {
  return createRemoteProfileStore({ authDir, env });
}

function attachRemoteUrlFromArgs(
  positionalUrl: string | undefined,
  legacyRemoteUrl: string | undefined,
): string | undefined {
  if (positionalUrl && legacyRemoteUrl && positionalUrl !== legacyRemoteUrl) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Pass either attach URL or --remote-url, not both. Use caplets attach <url> for new configs.",
    );
  }
  return positionalUrl ?? legacyRemoteUrl;
}

function rejectAttachHttpServeFlags(options: {
  transport?: string;
  host?: string;
  port?: string;
  path?: string;
  allowUnauthenticatedHttp?: boolean;
  trustProxy?: boolean;
}): void {
  const invalid = [
    options.transport !== undefined ? "--transport" : undefined,
    options.host !== undefined ? "--host" : undefined,
    options.port !== undefined ? "--port" : undefined,
    options.path !== undefined ? "--path" : undefined,
    options.allowUnauthenticatedHttp === true ? "--allow-unauthenticated-http" : undefined,
    options.trustProxy === true ? "--trust-proxy" : undefined,
  ].filter((value): value is string => value !== undefined);
  if (invalid.length === 0) return;
  throw new CapletsError(
    "REQUEST_INVALID",
    `caplets attach is stdio-only; ${invalid.join(", ")} ${invalid.length === 1 ? "is" : "are"} no longer supported. Use caplets serve --transport http --upstream-url <url> to start an HTTP stacked runtime.`,
  );
}

function hiddenOption(flags: string, description: string): Option {
  return new Option(flags, description).hideHelp();
}

async function withRemoteCredentialAuthority<T>(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  operation: (authority: ControlPlaneSecurityRepository) => T | Promise<T>,
  sqliteLiveOperation?: ((stateRoot: string) => T | Promise<T>) | undefined,
): Promise<T> {
  const configPath = envConfigPath(env);
  const projectConfigPath = envProjectConfigPath(env);
  const config = loadLocalRuntimeConfig(resolveConfigPath(configPath), projectConfigPath, {
    vaultResolver: vaultBootstrapResolver,
  });
  if ((config.serve?.storage?.kind ?? "sqlite") === "sqlite" && sqliteLiveOperation) {
    return sqliteLiveOperation(
      resolve(config.serve?.storage?.stateRoot ?? defaultStorageStateDir(env)),
    );
  }

  const engine = await createCapletsEngine({
    ...(configPath ? { configPath } : {}),
    projectConfigPath,
    env,
    watch: false,
  });
  try {
    const authority = engine.controlPlaneSecurityRepository();
    if (!authority) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Activated SQL credential authority is unavailable.",
      );
    }
    return await operation(authority);
  } finally {
    await engine.close();
  }
}

async function withControlPlaneSecurity<T>(
  io: CliIO,
  operation: (security: ControlPlaneSecurityRepository, engine: CapletsEngine) => T | Promise<T>,
  liveOperation: "admin" | "auth" | "vault" = "vault",
): Promise<T> {
  const env = io.env ?? process.env;
  const configPath = envConfigPath(env);
  const engine = await createCapletsEngine({
    ...(configPath ? { configPath } : {}),
    ...(envProjectConfigPath(env) ? { projectConfigPath: envProjectConfigPath(env) } : {}),
    ...(io.authDir ? { authDir: io.authDir } : {}),
    env,
    watch: false,
    ...(io.writeErr ? { writeErr: io.writeErr } : {}),
  });
  try {
    await engine.requireLiveControlPlane(liveOperation);
    const security = engine.controlPlaneSecurityRepository();
    if (!security) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Activated SQL security authority is unavailable.",
      );
    }
    return await operation(security, engine);
  } finally {
    await engine.close();
  }
}

async function withCurrentHostManagement<T>(
  io: CliIO,
  operation: (client: CurrentHostManagementClient) => T | Promise<T>,
): Promise<T> {
  if (io.internalCurrentHostManagement) {
    return operation(io.internalCurrentHostManagement);
  }
  const env = io.env ?? process.env;
  const configPath = envConfigPath(env);
  const projectConfigPath = envProjectConfigPath(env);
  const production = await createProductionControlPlane({
    ...(configPath ? { configPath } : {}),
    ...(projectConfigPath ? { projectConfigPath } : {}),
    ...(io.authDir ? { authDir: io.authDir } : {}),
    env,
  });
  try {
    const principal = trustedDevelopmentOperatorPrincipal("http://localhost");
    const authorizeLocalHost = async (
      request: ControlPlaneAuthorizationRequest,
      requireLive: boolean,
    ): Promise<ControlPlaneAuthorizationDecision> => {
      if (request.actorId !== principal.clientId) {
        return { status: "denied", reason: "revoked" };
      }
      if (
        request.logicalHostId !== production.store.identity.logicalHostId ||
        request.storeId !== production.store.identity.storeId
      ) {
        return { status: "denied", reason: "target-mismatch" };
      }
      if (request.operationNamespace !== production.store.identity.operationNamespace) {
        return { status: "denied", reason: "namespace-mismatch" };
      }
      try {
        const writerFence = requireLive
          ? await production.activated.requireLive("admin")
          : production.activated.writerFenceForFinalGuard();
        return {
          status: "authorized",
          authorization: {
            ...production.store.identity,
            actorId: principal.clientId,
            role: "operator",
            securityEpoch: production.activated.current().securityEpoch,
            writerFence,
          },
        };
      } catch {
        return { status: "denied", reason: "unavailable" };
      }
    };
    const management = {
      ...production.management,
      storage: createControlPlaneService({
        store: production.store,
        authorization: {
          authorize: (request) => authorizeLocalHost(request, true),
          authorizeInTransaction: (_transaction, request) => authorizeLocalHost(request, false),
        },
      }),
    };
    const operations = createCurrentHostOperations({
      engine: { enabledServers: () => [] },
      activityLog: production.security,
      remoteCredentialRepository: production.security,
      remotePendingLoginRepository: production.security,
      vaultRepository: production.security,
      management,
      portable: production.portable,
      version: packageJsonVersion,
    });
    const client = createCurrentHostManagementClient({
      operations,
      principal,
      target: "global",
      identity: production.store.identity,
    });
    return await operation(client);
  } finally {
    await production.close();
  }
}

async function withCurrentHostOfflineTransfer<T>(
  io: CliIO,
  destinationConfigPath: string,
  operation: (client: CurrentHostOfflineTransferClient) => T | Promise<T>,
): Promise<T> {
  if (io.internalCurrentHostOfflineTransfer) {
    return operation(io.internalCurrentHostOfflineTransfer);
  }
  const env = io.env ?? process.env;
  const configPath = envConfigPath(env);
  const client = await createProductionCurrentHostOfflineTransferClient({
    ...(configPath ? { configPath } : {}),
    destinationConfigPath,
    ...(io.authDir ? { authDir: io.authDir } : {}),
    env,
  });
  try {
    return await operation(client);
  } finally {
    await client.close();
  }
}

function requireActivatedConfigWithSources(engine: CapletsEngine): ConfigWithSources {
  const snapshot = engine.currentControlPlaneRuntimeSnapshot();
  if (!snapshot) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Activated SQL runtime snapshot is unavailable.");
  }
  return snapshot.configWithSources;
}

function compactCloudCaplet(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    ...(typeof record.readinessState === "string" ? { readinessState: record.readinessState } : {}),
  };
}

function isProjectBindingWebSocketUnavailable(error: unknown): boolean {
  return (
    error instanceof CapletsError &&
    error.code === "SERVER_UNAVAILABLE" &&
    error.message.includes("Project Binding WebSocket unavailable")
  );
}

function isProjectBindingCliError(error: unknown): error is ProjectBindingError {
  return error instanceof ProjectBindingError;
}

function daemonInstallOptions(options: DaemonInstallCommandOptions): DaemonInstallOptions {
  return {
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.path !== undefined ? { path: options.path } : {}),
    ...(options.remoteStatePath !== undefined ? { remoteStatePath: options.remoteStatePath } : {}),
    ...(options.upstreamUrl !== undefined ? { upstreamUrl: options.upstreamUrl } : {}),
    ...(options.allowUnauthenticatedHttp !== undefined
      ? { allowUnauthenticatedHttp: options.allowUnauthenticatedHttp }
      : {}),
    ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
    ...(options.reset !== undefined ? { reset: options.reset } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.unsetEnv !== undefined ? { unsetEnv: options.unsetEnv } : {}),
    ...(options.inheritEnv !== undefined ? { inheritEnv: options.inheritEnv } : {}),
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
    ...(options.validate !== undefined ? { validate: options.validate } : {}),
    ...(options.start !== undefined ? { start: options.start } : {}),
    ...(options.restart === true ? { restart: true } : {}),
    ...(options.restart === false ? { noRestart: true } : {}),
    ...(options.noRestart !== undefined ? { noRestart: options.noRestart } : {}),
  };
}

async function waitForCloudLogin(
  client: CloudAuthClient,
  loginId: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  const timeoutMs = numberEnv(env.CAPLETS_CLOUD_AUTH_TIMEOUT_MS, 120_000);
  const intervalMs = numberEnv(env.CAPLETS_CLOUD_AUTH_POLL_INTERVAL_MS, 1_500);
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    const result = await client.pollLogin(loginId);
    if (result.status !== "pending" && result.status !== "workspace_selection_required") {
      return result;
    }
    await sleep(intervalMs);
  }
  return { status: "expired" as const, message: "Cloud Auth login timed out." };
}

async function loginCloudRemoteProfile(
  url: string,
  options: {
    workspace?: string;
    deviceName?: string;
    open?: boolean;
    json?: boolean;
  },
  store: FileRemoteProfileStore,
  io: {
    env: NodeJS.ProcessEnv | Record<string, string | undefined>;
    fetch?: typeof fetch;
    writeOut: (value: string) => void;
  },
): Promise<RemoteProfileStatus> {
  const client = new CloudAuthClient({ cloudUrl: url, ...(io.fetch ? { fetch: io.fetch } : {}) });
  const requestedWorkspace = options.workspace ?? hostedCloudWorkspaceFromRemoteUrl(url);
  const started = await client.startLogin({
    requestedWorkspace,
    deviceName: options.deviceName ?? io.env.CAPLETS_DEVICE_NAME ?? "Caplets CLI",
  });
  if (options.open !== false) await openBrowserUrl(started.loginUrl);
  if (!options.json) {
    io.writeOut(`Open ${started.loginUrl}\n`);
    io.writeOut(`Enter code ${started.userCode} if prompted.\n`);
  }

  const completed = await waitForCloudLogin(client, started.loginId, io.env);
  if (completed.status !== "completed") {
    throw new CapletsError("AUTH_FAILED", `Remote Login Cloud flow ${completed.status}.`);
  }
  const exchanged = await client.exchangeToken({
    loginId: started.loginId,
    oneTimeCode: completed.oneTimeCode,
  });
  return store.saveCloudProfile({
    hostUrl: exchanged.cloudUrl,
    workspaceId: exchanged.workspaceId,
    ...(exchanged.workspaceSlug ? { workspaceSlug: exchanged.workspaceSlug } : {}),
    clientLabel: exchanged.deviceName ?? options.deviceName ?? "Caplets CLI",
    credentials: {
      accessToken: exchanged.accessToken,
      refreshToken: exchanged.refreshToken ?? "",
      expiresAt: exchanged.expiresAt,
      scope: exchanged.scope,
      tokenType: exchanged.tokenType,
    },
  });
}

async function readHiddenInput(
  label: string,
  options: {
    input?: NodeJS.ReadableStream;
    output?: Pick<NodeJS.WriteStream, "write">;
  } = {},
): Promise<string> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  output.write(label);
  const hiddenOutput = new HiddenPromptOutput(output, { echoFirstChunk: false });
  const readline = createInterface({ input, output: hiddenOutput, terminal: true });
  try {
    return await readline.question("");
  } finally {
    readline.close();
    output.write("\n");
  }
}

class HiddenPromptOutput extends Writable {
  private wrotePrompt = false;

  constructor(
    private readonly output: Pick<NodeJS.WriteStream, "write">,
    private readonly options: { echoFirstChunk?: boolean } = { echoFirstChunk: true },
  ) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.options.echoFirstChunk !== false && !this.wrotePrompt) {
      this.output.write(chunk);
      this.wrotePrompt = true;
    }
    callback();
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

type RemoteLoginCredentialsResponse = {
  hostUrl?: string | undefined;
  clientId: string;
  clientLabel: string;
  accessToken: string;
  refreshToken: string;
  tokenType?: string | undefined;
  expiresAt?: string | undefined;
};

type PendingRemoteLoginStartResponse = {
  flowId: string;
  operatorCode: string;
  operatorCodeFingerprint?: string | undefined;
  approvalCommand?: string | undefined;
  pendingRefreshSecret: string;
  pendingCompletionSecret: string;
  codeExpiresAt: string;
  flowExpiresAt: string;
  intervalSeconds: number;
};

async function parseRemoteLoginCredentials(
  response: Response,
): Promise<RemoteLoginCredentialsResponse> {
  const parsed = await response.json();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CapletsError("DOWNSTREAM_PROTOCOL_ERROR", "Remote Login response must be an object.");
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.clientId !== "string" ||
    typeof record.accessToken !== "string" ||
    typeof record.refreshToken !== "string"
  ) {
    throw new CapletsError(
      "DOWNSTREAM_PROTOCOL_ERROR",
      "Remote Login response is missing credentials.",
    );
  }
  return {
    ...(typeof record.hostUrl === "string" ? { hostUrl: record.hostUrl } : {}),
    clientId: record.clientId,
    clientLabel: typeof record.clientLabel === "string" ? record.clientLabel : "Caplets CLI",
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    ...(typeof record.tokenType === "string" ? { tokenType: record.tokenType } : {}),
    ...(typeof record.expiresAt === "string" ? { expiresAt: record.expiresAt } : {}),
  };
}

async function parsePendingRemoteLoginStart(
  response: Response,
  options: { pendingCompletionSecret?: string | undefined } = {},
): Promise<PendingRemoteLoginStartResponse> {
  const parsed = await response.json();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CapletsError(
      "DOWNSTREAM_PROTOCOL_ERROR",
      "Pending Remote Login response must be an object.",
    );
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.flowId !== "string" ||
    typeof record.operatorCode !== "string" ||
    typeof record.pendingRefreshSecret !== "string" ||
    typeof record.codeExpiresAt !== "string" ||
    typeof record.flowExpiresAt !== "string"
  ) {
    throw new CapletsError(
      "DOWNSTREAM_PROTOCOL_ERROR",
      "Pending Remote Login response is missing pending material.",
    );
  }
  const pendingCompletionSecret =
    typeof record.pendingCompletionSecret === "string"
      ? record.pendingCompletionSecret
      : options.pendingCompletionSecret;
  if (!pendingCompletionSecret) {
    throw new CapletsError(
      "DOWNSTREAM_PROTOCOL_ERROR",
      "Pending Remote Login response is missing completion material.",
    );
  }
  return {
    flowId: record.flowId,
    operatorCode: record.operatorCode,
    ...(typeof record.operatorCodeFingerprint === "string"
      ? { operatorCodeFingerprint: record.operatorCodeFingerprint }
      : {}),
    ...(typeof record.approvalCommand === "string"
      ? { approvalCommand: record.approvalCommand }
      : {}),
    pendingRefreshSecret: record.pendingRefreshSecret,
    pendingCompletionSecret,
    codeExpiresAt: record.codeExpiresAt,
    flowExpiresAt: record.flowExpiresAt,
    intervalSeconds: typeof record.intervalSeconds === "number" ? record.intervalSeconds : 5,
  };
}

async function parsePendingRemoteLoginStatus(response: Response): Promise<string> {
  const parsed = await response.json();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CapletsError(
      "DOWNSTREAM_PROTOCOL_ERROR",
      "Pending Remote Login status response must be an object.",
    );
  }
  const status = (parsed as Record<string, unknown>).status;
  if (typeof status !== "string") {
    throw new CapletsError(
      "DOWNSTREAM_PROTOCOL_ERROR",
      "Pending Remote Login status response is missing status.",
    );
  }
  return status;
}

async function selfHostedPendingRemoteLogin(
  url: string,
  input: {
    clientLabel?: string | undefined;
    json?: boolean | undefined;
    fetch?: typeof fetch | undefined;
    signal?: AbortSignal | undefined;
    writeOut: (value: string) => void;
    env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  },
): Promise<RemoteLoginCredentialsResponse> {
  const fetchImpl = input.fetch ?? fetch;
  const baseUrl = new URL(normalizeRemoteProfileHostUrl(url));
  const startBody = input.clientLabel ? { clientLabel: input.clientLabel } : {};
  const start = await fetchImpl(appendBasePath(baseUrl, "v1/remote/login/start"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(startBody),
  });
  if (!start.ok) throw new CapletsError("AUTH_FAILED", "Remote Login pending start failed.");
  let pending = await parsePendingRemoteLoginStart(start);
  if (input.json) {
    input.writeOut(
      `${JSON.stringify({
        code: "pending_login_started",
        flowId: pending.flowId,
        operatorCode: pending.operatorCode,
        operatorCodeFingerprint: pending.operatorCodeFingerprint,
        codeExpiresAt: pending.codeExpiresAt,
        flowExpiresAt: pending.flowExpiresAt,
      })}\n`,
    );
  } else {
    input.writeOut(`Remote Login Code: ${pending.operatorCode}\n`);
    if (pending.operatorCodeFingerprint) {
      input.writeOut(`Code fingerprint: ${pending.operatorCodeFingerprint}\n`);
    }
    const approvalCommand =
      pending.approvalCommand ?? `caplets remote host approve ${pending.operatorCode} --yes`;
    input.writeOut(`Approve from the host with ${approvalCommand}\n`);
  }

  const intervalMs = numberEnv(
    input.env.CAPLETS_REMOTE_LOGIN_POLL_INTERVAL_MS,
    pending.intervalSeconds * 1_000,
  );
  try {
    while (true) {
      const poll = await fetchPendingRemoteLoginStatus(fetchImpl, baseUrl, pending, input.signal);
      if (!poll.ok) throw new CapletsError("AUTH_FAILED", "Remote Login pending poll failed.");
      const status = await parsePendingRemoteLoginStatus(poll);
      if (status === "approved") {
        if (input.json) {
          input.writeOut(
            `${JSON.stringify({ code: "pending_login_approved", flowId: pending.flowId })}\n`,
          );
        }
        break;
      }
      if (status !== "pending") {
        if (input.json) {
          input.writeOut(
            `${JSON.stringify({ code: `pending_login_${status}`, flowId: pending.flowId })}\n`,
          );
        }
        throw new CapletsError("AUTH_FAILED", `Remote Login pending flow ${status}.`);
      }
      if (Date.parse(pending.codeExpiresAt) <= Date.now()) {
        const refresh = await fetchImpl(appendBasePath(baseUrl, "v1/remote/login/refresh"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            flowId: pending.flowId,
            pendingRefreshSecret: pending.pendingRefreshSecret,
            pendingCompletionSecret: pending.pendingCompletionSecret,
          }),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        if (!refresh.ok) {
          const retryPoll = await fetchPendingRemoteLoginStatus(fetchImpl, baseUrl, pending);
          if (retryPoll.ok && (await parsePendingRemoteLoginStatus(retryPoll)) === "approved") {
            if (input.json) {
              input.writeOut(
                `${JSON.stringify({ code: "pending_login_approved", flowId: pending.flowId })}\n`,
              );
            }
            break;
          }
          throw new CapletsError("AUTH_FAILED", "Remote Login pending refresh failed.");
        }
        pending = await parsePendingRemoteLoginStart(refresh, {
          pendingCompletionSecret: pending.pendingCompletionSecret,
        });
        if (input.json) {
          input.writeOut(
            `${JSON.stringify({
              code: "pending_login_code_refreshed",
              flowId: pending.flowId,
              operatorCode: pending.operatorCode,
              operatorCodeFingerprint: pending.operatorCodeFingerprint,
              codeExpiresAt: pending.codeExpiresAt,
              flowExpiresAt: pending.flowExpiresAt,
            })}\n`,
          );
        } else {
          input.writeOut(`Remote Login Code refreshed: ${pending.operatorCode}\n`);
          if (pending.operatorCodeFingerprint) {
            input.writeOut(`Code fingerprint: ${pending.operatorCodeFingerprint}\n`);
          }
        }
      }
      await sleep(intervalMs, input.signal);
    }

    const complete = await completePendingRemoteLogin(fetchImpl, baseUrl, pending, input.signal);
    if (!complete.ok)
      throw new CapletsError("AUTH_FAILED", "Remote Login pending complete failed.");
    return parseRemoteLoginCredentials(complete);
  } catch (error) {
    if (input.signal?.aborted || isAbortError(error)) {
      await cancelPendingRemoteLogin(fetchImpl, baseUrl, pending);
      if (input.json) {
        input.writeOut(
          `${JSON.stringify({ code: "pending_login_cancelled", flowId: pending.flowId })}\n`,
        );
      }
      throw new CapletsError("REQUEST_INVALID", "Remote Login pending flow cancelled.");
    }
    throw error;
  }
}

async function completePendingRemoteLogin(
  fetchImpl: typeof fetch,
  baseUrl: URL,
  pending: PendingRemoteLoginStartResponse,
  signal?: AbortSignal | undefined,
): Promise<Response> {
  try {
    return await fetchImpl(
      appendBasePath(baseUrl, "v1/remote/login/complete"),
      pendingRemoteLoginCompletionRequest(pending, signal),
    );
  } catch {
    return fetchImpl(
      appendBasePath(baseUrl, "v1/remote/login/complete"),
      pendingRemoteLoginCompletionRequest(pending),
    );
  }
}

function pendingRemoteLoginCompletionRequest(
  pending: PendingRemoteLoginStartResponse,
  signal?: AbortSignal | undefined,
): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      flowId: pending.flowId,
      pendingCompletionSecret: pending.pendingCompletionSecret,
    }),
    ...(signal ? { signal } : {}),
  };
}

async function fetchPendingRemoteLoginStatus(
  fetchImpl: typeof fetch,
  baseUrl: URL,
  pending: PendingRemoteLoginStartResponse,
  signal?: AbortSignal | undefined,
): Promise<Response> {
  return fetchImpl(appendBasePath(baseUrl, "v1/remote/login/poll"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      flowId: pending.flowId,
      pendingCompletionSecret: pending.pendingCompletionSecret,
    }),
    ...(signal ? { signal } : {}),
  });
}

async function cancelPendingRemoteLogin(
  fetchImpl: typeof fetch,
  baseUrl: URL,
  pending: PendingRemoteLoginStartResponse,
): Promise<void> {
  await fetchImpl(appendBasePath(baseUrl, "v1/remote/login/cancel"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      flowId: pending.flowId,
      pendingCompletionSecret: pending.pendingCompletionSecret,
    }),
  }).catch(() => undefined);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError")
  );
}

async function revokeSelfHostedRemoteClient(
  remoteUrl: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const revokeUrl = appendBasePath(
    new URL(normalizeRemoteProfileHostUrl(remoteUrl)),
    "v1/remote/client",
  );
  await fetchImpl(revokeUrl, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function selfHostedLogoutAccessToken(
  remoteUrl: string,
  credential: RemoteProfileCredential & { accessToken: string },
  input: { authDir?: string | undefined; fetch?: typeof fetch | undefined },
  env: Record<string, string | undefined>,
): Promise<string> {
  const selection = await resolveRemoteSelection(
    {
      mode: "remote",
      remoteUrl,
      ...(input.authDir ? { authDir: input.authDir } : {}),
      ...(input.fetch ? { fetch: input.fetch } : {}),
    },
    env,
  );
  return selection.kind === "self_hosted_remote" && selection.remote.auth.type === "bearer"
    ? selection.remote.auth.token
    : credential.accessToken;
}

function writeRemoteStatus(
  status: RemoteProfileStatus | Record<string, unknown>,
  json: boolean,
  writeOut: (value: string) => void,
): void {
  if (json) {
    writeOut(`${JSON.stringify(status, null, 2)}\n`);
    return;
  }
  if (status.authenticated) {
    const workspace =
      typeof status.workspaceSlug === "string"
        ? ` workspace ${status.workspaceSlug}`
        : typeof status.workspaceId === "string"
          ? ` workspace ${status.workspaceId}`
          : "";
    writeOut(`Authenticated to ${status.hostUrl}${workspace}.\n`);
    return;
  }
  writeOut(`Not authenticated to ${status.hostUrl}.\n`);
}

async function loadCloudRemoteProfileCredentials(
  store: FileRemoteProfileStore,
  input: { cloudUrl: string; workspace?: string | undefined },
): Promise<{ status: RemoteProfileStatus; credential: RemoteProfileCredential }> {
  const status = await store.getCloudProfileStatus({
    hostUrl: input.cloudUrl,
    ...(input.workspace ? { workspace: input.workspace } : {}),
  });
  const credential = status ? await store.credentials.load(status.key) : undefined;
  if (!status || !credential?.accessToken) {
    throw new CapletsError("AUTH_REQUIRED", "Run caplets remote login <cloud-url> first.");
  }
  return { status, credential };
}

function defaultCloudUrl(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  cloudUrl?: string,
): string {
  return cloudUrl ?? env.CAPLETS_CLOUD_URL ?? "https://cloud.caplets.dev";
}

function terminalSafeText(value: string): string {
  let safe = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    safe += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? "?" : char;
  }
  return safe;
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

type SetupPromptHandle = {
  readPrompt: SetupPromptReader;
  close: () => void;
};

function createSetupPromptHandle(
  io: CliIO,
  writeOut: (value: string) => void,
): SetupPromptHandle | undefined {
  if (io.readStdin) {
    const readStdin = io.readStdin;
    let input: Promise<string> | undefined;
    let lines: string[] | undefined;
    let lineIndex = 0;
    return {
      readPrompt: async (prompt) => {
        writeOut(prompt);
        input ??= readStdin();
        lines ??= (await input).split(/\r?\n/u);
        return lines[lineIndex++] ?? "";
      },
      close: () => {},
    };
  }

  if (io.writeOut || io.writeErr || !process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return {
    readPrompt: (prompt) => readline.question(prompt),
    close: () => readline.close(),
  };
}

async function sleep(ms: number, signal?: AbortSignal | undefined): Promise<void> {
  if (ms <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, ms);
    const abort = () => done();
    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function cliInterruptSignal(existing: AbortSignal | undefined): {
  signal: AbortSignal | undefined;
  dispose: () => void;
} {
  if (existing) return { signal: existing, dispose: () => {} };
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    },
  };
}

export function createProgram(io: CliIO = {}): Command {
  const writeOut = io.writeOut ?? ((value: string) => process.stdout.write(value));
  const writeErr = io.writeErr ?? ((value: string) => process.stderr.write(value));
  const env = io.env ?? process.env;
  const currentConfigPath = () => envConfigPath(env);
  const currentServeDefaults = () => loadGlobalServeDefaults(env);
  const telemetryContext = (): TelemetryCliContext => ({
    env,
    configPath: currentConfigPath(),
    projectConfigPath: envProjectConfigPath(env),
    stateDir: io.telemetryStateDir ?? defaultTelemetryStateDir(env),
    stderrIsTTY: io.stderrIsTTY ?? process.stderr.isTTY === true,
    writeErr,
  });
  const printTelemetryNotice = (surface: TelemetrySurface) => {
    try {
      maybePrintCliTelemetryNotice(telemetryContext(), surface);
    } catch {
      // Telemetry notice delivery is best-effort and must not affect command behavior.
    }
  };
  const setExitCode =
    io.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  const executeOperationIo = (format: CliOutputFormat | undefined): ExecuteOperationIO => ({
    writeOut,
    writeErr,
    setExitCode,
    authDir: io.authDir,
    env,
    remote: remoteClientForCli(io),
    format,
    telemetryStateDir: telemetryContext().stateDir,
    telemetryDebugSink: io.telemetryDebugSink,
  });
  const program = new Command();

  program
    .name("caplets")
    .description("Progressive-disclosure gateway for MCP servers.")
    .version(io.version ?? packageJsonVersion)
    .exitOverride()
    .configureOutput({
      writeOut,
      writeErr,
      outputError: (value, write) => write(value),
    });

  const storageCommand = program
    .command("storage")
    .description("Manage the local SQL control-plane store.");
  storageCommand
    .command("migrate")
    .description("Run the global legacy migration while every replica is stopped.")
    .requiredOption("--global", "target the local global control plane")
    .requiredOption("--offline", "require the one-shot offline migration path")
    .action(async () => {
      if (io.internalStorageMigration) {
        await io.internalStorageMigration.migrate({ target: "global", mode: "offline" });
      } else {
        const configPath = envConfigPath(env);
        const projectConfigPath = envProjectConfigPath(env);
        await runProductionControlPlaneOfflineMigration({
          ...(configPath ? { configPath } : {}),
          ...(projectConfigPath ? { projectConfigPath } : {}),
          ...(io.authDir ? { authDir: io.authDir } : {}),
          env,
        });
      }
      writeOut("Global legacy storage migration complete.\n");
    });
  const offlineTransferCommand = storageCommand
    .command("transfer")
    .description("Transfer the offline global SQLite control plane to Postgres.");
  offlineTransferCommand
    .command("start")
    .description("Stage and verify an offline SQLite-to-Postgres transfer.")
    .requiredOption("--global", "target the local global control plane")
    .requiredOption("--offline", "require the offline transfer path")
    .requiredOption(
      "--destination-config <path>",
      "owner-private Postgres destination configuration",
    )
    .requiredOption("--request <json>", "non-secret transfer identity and descriptor request")
    .action(
      async (options: {
        global: true;
        offline: true;
        destinationConfig: string;
        request: string;
      }) => {
        const request = parseCurrentHostOfflineTransferStartRequest(
          parseOfflineTransferJson(options.request),
        );
        const result = await withCurrentHostOfflineTransfer(
          io,
          options.destinationConfig,
          (client) => client.start(request),
        );
        writeCurrentHostOfflineTransferOutput(writeOut, result);
      },
    );
  offlineTransferCommand
    .command("cutover")
    .description("Preview or confirm the one-way destination cutover.")
    .argument("<transfer-id>", "offline transfer identity")
    .requiredOption("--global", "target the local global control plane")
    .requiredOption("--offline", "require the offline transfer path")
    .requiredOption(
      "--destination-config <path>",
      "owner-private Postgres destination configuration",
    )
    .option("--preview", "create a fresh no-side-effect confirmation")
    .option("--confirmation <json>", "fresh confirmation JSON returned by --preview")
    .action(
      async (
        transferId: string,
        options: {
          global: true;
          offline: true;
          destinationConfig: string;
          preview?: boolean | undefined;
          confirmation?: string | undefined;
        },
      ) => {
        assertOfflineTransferConfirmationSelection(options);
        if (options.preview) {
          const preview = await withCurrentHostOfflineTransfer(
            io,
            options.destinationConfig,
            (client) => client.previewCutover(transferId),
          );
          writeCurrentHostOfflineTransferOutput(writeOut, preview);
          return;
        }
        assertInteractiveOfflineTransferConfirmation(io);
        const confirmation = parseOfflineTransferConfirmationJson(
          options.confirmation!,
          "cutover",
          transferId,
        );
        const result = await withCurrentHostOfflineTransfer(
          io,
          options.destinationConfig,
          (client) => client.cutover(transferId, confirmation),
        );
        writeCurrentHostOfflineTransferOutput(writeOut, result);
      },
    );
  offlineTransferCommand
    .command("rollback")
    .description("Rollback a transfer before durable destination activation.")
    .argument("<transfer-id>", "offline transfer identity")
    .requiredOption("--global", "target the local global control plane")
    .requiredOption("--offline", "require the offline transfer path")
    .requiredOption(
      "--destination-config <path>",
      "owner-private Postgres destination configuration",
    )
    .action(async (transferId: string, options: { destinationConfig: string }) => {
      const result = await withCurrentHostOfflineTransfer(io, options.destinationConfig, (client) =>
        client.rollback(transferId),
      );
      writeCurrentHostOfflineTransferOutput(writeOut, result);
    });
  offlineTransferCommand
    .command("finalize")
    .description("Preview or confirm roll-forward-only transfer finalization.")
    .argument("<transfer-id>", "offline transfer identity")
    .requiredOption("--global", "target the local global control plane")
    .requiredOption("--offline", "require the offline transfer path")
    .requiredOption(
      "--destination-config <path>",
      "owner-private Postgres destination configuration",
    )
    .option("--preview", "create a fresh no-side-effect confirmation")
    .option("--confirmation <json>", "fresh confirmation JSON returned by --preview")
    .action(
      async (
        transferId: string,
        options: {
          global: true;
          offline: true;
          destinationConfig: string;
          preview?: boolean | undefined;
          confirmation?: string | undefined;
        },
      ) => {
        assertOfflineTransferConfirmationSelection(options);
        if (options.preview) {
          const preview = await withCurrentHostOfflineTransfer(
            io,
            options.destinationConfig,
            (client) => client.previewFinalize(transferId),
          );
          writeCurrentHostOfflineTransferOutput(writeOut, preview);
          return;
        }
        assertInteractiveOfflineTransferConfirmation(io);
        const confirmation = parseOfflineTransferConfirmationJson(
          options.confirmation!,
          "finalize",
          transferId,
        );
        const result = await withCurrentHostOfflineTransfer(
          io,
          options.destinationConfig,
          (client) => client.finalize(transferId, confirmation),
        );
        writeCurrentHostOfflineTransferOutput(writeOut, result);
      },
    );

  const portableStorageCommand = storageCommand
    .command("portable")
    .description("Import, export, inspect, and activate portable Caplet artifacts.");
  portableStorageCommand
    .command("status")
    .description("Observe portable storage readiness without mutating it.")
    .option("--global", "target the local global control plane")
    .option("--remote", "target the selected authenticated remote host")
    .option("--json", "print stable JSON output")
    .action(async (options: PortableCommandOptions) => {
      const outcome = await executePortableCliOperation(io, { kind: "portable_status" }, options);
      writePortableStatus(writeOut, outcome, options.json ?? false);
    });
  portableStorageCommand
    .command("operation")
    .description(
      "Execute a typed portable import, activation, revalidation, export, or range operation.",
    )
    .argument("<json>", "portable Current Host operation JSON without binding")
    .option("--global", "target the local global control plane")
    .option("--remote", "target the selected authenticated remote host")
    .option("--operation-id <id>", "reuse the session or proposal operation identity")
    .option("--json", "print JSON output")
    .action(
      async (
        operationJson: string,
        options: PortableCommandOptions & { operationId?: string | undefined },
      ) => {
        const parsed = parseJsonArgument(operationJson);
        const outcome = await executePortableCliOperation(io, parsed, options);
        writePortableOperationOutcome(writeOut, setExitCode, outcome, options.json ?? false);
      },
    );
  portableStorageCommand
    .command("import")
    .description("Upload a local portable artifact and return an inert import preview.")
    .argument("<path>", "client-local portable artifact path")
    .option("--global", "target the local global control plane")
    .option("--remote", "target the selected authenticated remote host")
    .option("--collision-policy <policy>", "reject or replace", "reject")
    .option("--confirm-replacement", "confirm replacement consequences")
    .option("--json", "print JSON output")
    .action(
      async (
        path: string,
        options: PortableCommandOptions & {
          collisionPolicy: string;
          confirmReplacement?: boolean | undefined;
        },
      ) => {
        const outcome = await importPortableArtifactFromPath(io, path, options);
        writePortableOperationOutcome(writeOut, setExitCode, outcome, options.json ?? false);
      },
    );
  portableStorageCommand
    .command("export")
    .description("Export a SQL-owned Caplet to a client-local portable artifact.")
    .argument("<caplet-id>", "Caplet identity")
    .argument("<path>", "client-local output path")
    .option("--global", "target the local global control plane")
    .option("--remote", "target the selected authenticated remote host")
    .option("--underlying-sql", "export the explicit underlying SQL record")
    .option("--json", "print JSON output")
    .action(
      async (
        capletId: string,
        path: string,
        options: PortableCommandOptions & { underlyingSql?: boolean | undefined },
      ) => {
        const outcome = await exportPortableArtifactToPath(io, capletId, path, options);
        writeOut(
          `${JSON.stringify({
            kind: "portable_export_download",
            status: "written",
            artifact: outcome.artifact,
            artifactType: outcome.artifactType,
            path,
          })}\n`,
        );
      },
    );

  const currentHostStorageCommand = storageCommand
    .command("management")
    .description("Inspect and administer the local or authenticated remote SQL Current Host.");
  currentHostStorageCommand
    .command("list")
    .option("--global", "target the local global control plane")
    .option("--remote", "target the selected authenticated remote host")
    .option("--operation-id <id>", "caller-known operation identity")
    .requiredOption("--resource <resource>", "caplet or host-setting")
    .action(async (options: ManagementCommandOptions & { resource: string }) => {
      const resource = parseCurrentHostManagementResource(options.resource);
      const target = resolveCurrentHostManagementTarget(options);
      const outcome =
        target === "remote"
          ? await requestTypedRemote(io, "current_host_list", {
              resource,
              ...remoteManagementBindingArguments(
                { action: "list", resource },
                options.operationId,
              ),
            })
          : await withCurrentHostManagement(io, (client) => client.list(resource));
      writeCurrentHostManagementOutcome(writeOut, setExitCode, outcome, ["ok"]);
    });
  currentHostStorageCommand
    .command("inspect")
    .argument("<resource>", "caplet or host-setting")
    .argument("<id>", "resource identity")
    .option("--global", "target the local global control plane")
    .option("--remote", "target the selected authenticated remote host")
    .option("--operation-id <id>", "caller-known operation identity")
    .option("--underlying-sql", "inspect the explicit underlying SQL record")
    .action(
      async (
        resourceValue: string,
        id: string,
        options: ManagementCommandOptions & { underlyingSql?: boolean | undefined },
      ) => {
        const resource = parseCurrentHostManagementResource(resourceValue);
        const selector = options.underlyingSql ? "underlying-sql" : "effective";
        const target = resolveCurrentHostManagementTarget(options);
        const outcome =
          target === "remote"
            ? await requestTypedRemote(io, "current_host_inspect", {
                resource,
                id,
                selector,
                ...remoteManagementBindingArguments(
                  { action: "inspect", resource, id, selector },
                  options.operationId,
                ),
              })
            : await withCurrentHostManagement(io, (client) =>
                client.inspect(resource, id, selector),
              );
        writeCurrentHostManagementOutcome(writeOut, setExitCode, outcome, ["ok"]);
      },
    );
  currentHostStorageCommand
    .command("preview")
    .argument("<mutation>", "JSON Current Host management mutation")
    .option("--global", "target the local global control plane")
    .option("--remote", "target the selected authenticated remote host")
    .option("--operation-id <id>", "caller-known operation identity")
    .action(async (mutationJson: string, options: ManagementCommandOptions) => {
      const mutation = parseCurrentHostManagementMutation(parseJsonArgument(mutationJson));
      const target = resolveCurrentHostManagementTarget(options);
      const outcome =
        target === "remote"
          ? await requestTypedRemote(io, "current_host_preview", {
              mutation,
              ...remoteManagementBindingArguments(mutation, options.operationId),
            })
          : await withCurrentHostManagement(io, async (client) => {
              const binding = client.createBinding(mutation, { operationId: options.operationId });
              return client.preview(mutation, binding);
            });
      writeCurrentHostManagementOutcome(writeOut, setExitCode, outcome, ["preview"]);
    });
  currentHostStorageCommand
    .command("mutate")
    .argument("<mutation>", "JSON Current Host management mutation")
    .option("--global", "target the local global control plane")
    .option("--remote", "target the selected authenticated remote host")
    .option("--operation-id <id>", "caller-known operation identity")
    .action(async (mutationJson: string, options: ManagementCommandOptions) => {
      const mutation = parseCurrentHostManagementMutation(parseJsonArgument(mutationJson));
      const target = resolveCurrentHostManagementTarget(options);
      const outcome =
        target === "remote"
          ? await requestTypedRemote(io, "current_host_mutate", {
              mutation,
              ...remoteManagementBindingArguments(mutation, options.operationId),
            })
          : await withCurrentHostManagement(io, async (client) => {
              const binding = client.createBinding(mutation, { operationId: options.operationId });
              return client.mutate(mutation, binding);
            });
      writeCurrentHostManagementOutcome(writeOut, setExitCode, outcome, ["committed"]);
    });
  currentHostStorageCommand
    .command("status")
    .option("--global", "target the local global control plane")
    .option("--remote", "target the selected authenticated remote host")
    .option("--operation-id <id>", "caller-known operation identity")
    .action(async (options: ManagementCommandOptions) => {
      const target = resolveCurrentHostManagementTarget(options);
      const outcome =
        target === "remote"
          ? await requestTypedRemote(io, "current_host_status", {
              ...remoteManagementBindingArguments({ action: "status" }, options.operationId),
            })
          : await withCurrentHostManagement(io, (client) => client.status());
      writeCurrentHostManagementOutcome(writeOut, setExitCode, outcome, ["ok"]);
    });
  currentHostStorageCommand
    .command("lookup")
    .argument("<binding>", "JSON caller-known operation binding")
    .option("--global", "target the original local global control plane")
    .option("--remote", "target the original authenticated remote host")
    .action(async (bindingJson: string, options: ManagementCommandOptions) => {
      const target = resolveCurrentHostManagementTarget(options);
      const binding = parseCurrentHostOperationBinding(parseJsonArgument(bindingJson));
      if (binding.target !== target) {
        throw new CapletsError(
          "REQUEST_INVALID",
          `Current Host lookup requires the original ${target} target.`,
        );
      }
      const outcome =
        target === "remote"
          ? await requestTypedRemote(io, "current_host_operation_lookup", {
              binding,
            })
          : await withCurrentHostManagement(io, (client) => client.lookupOperation(binding));
      writeCurrentHostManagementOutcome(writeOut, setExitCode, outcome, [
        "committed",
        "not_committed",
      ]);
    });

  program
    .command(cliCommands.completion)
    .description("Print a shell completion script.")
    .argument("<shell>", "completion shell: bash, zsh, fish, powershell, or cmd")
    .action((shell: string) => {
      if (!completionShells.includes(shell as CompletionShell)) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "completion shell must be bash, zsh, fish, powershell, or cmd",
        );
      }
      writeOut(completionScript(shell as CompletionShell));
    });

  program
    .command(cliCommands.completeHidden, { hidden: true })
    .description("Internal shell completion endpoint.")
    .option("--shell <shell>", "completion shell")
    .allowUnknownOption(true)
    .argument("[words...]", "words to complete")
    .action(async (words: string[], options: { shell?: string }) => {
      const shell = completionShells.includes(options.shell as CompletionShell)
        ? (options.shell as CompletionShell)
        : "bash";
      const remote = remoteClientForCli(io);
      const configPath = currentConfigPath();
      const completionWords = normalizeCompletionWords(words);
      let suggestions: string[] = [];
      try {
        if (remote) {
          const localOverlay = loadLocalOverlayForCli(io, () => {});
          let localSuggestions: string[] = [];
          try {
            localSuggestions = await completeCliWordsLocally(completionWords, {
              ...(configPath ? { configPath } : {}),
              projectConfigPath: envProjectConfigPath(env),
              ...(io.authDir ? { authDir: io.authDir } : {}),
              env,
              config: localOverlay.config,
            });
          } catch {
            // A missing or quarantined local overlay must not hide a healthy remote completion.
          }
          const target = localShadowedCompletionTarget(completionWords, localOverlay.config);
          if (target) {
            suggestions = localSuggestions;
          } else {
            const remoteSuggestions = (await remote.request("complete_cli" as RemoteCliCommand, {
              shell,
              words: completionWords,
            })) as string[];
            suggestions = mergeCompletionSuggestions(localSuggestions, remoteSuggestions);
          }
        } else {
          suggestions = await completeCliWordsLocally(completionWords, {
            ...(configPath ? { configPath } : {}),
            projectConfigPath: envProjectConfigPath(env),
            ...(io.authDir ? { authDir: io.authDir } : {}),
            env,
          });
        }
      } catch {
        suggestions = remote
          ? []
          : await completeCliWords(completionWords, {
              ...(configPath ? { configPath } : {}),
              projectConfigPath: envProjectConfigPath(env),
            });
      }
      if (suggestions.length > 0) writeOut(`${suggestions.join("\n")}\n`);
    });

  const telemetry = program
    .command(cliCommands.telemetry)
    .description("Inspect and control anonymous Caplets telemetry.");

  telemetry
    .command("status")
    .description("Show anonymous telemetry status.")
    .action(() => {
      writeOut(formatTelemetryStatus(telemetryContext()));
    });

  telemetry
    .command("enable")
    .description("Enable anonymous telemetry in the user config.")
    .action(() => {
      const path = resolveConfigPath(currentConfigPath());
      writeTelemetryConfig(path, true);
      writeOut(`Enabled anonymous telemetry in ${path}.\n`);
      if (env.CAPLETS_DISABLE_TELEMETRY === "1") {
        writeOut("CAPLETS_DISABLE_TELEMETRY=1 still disables telemetry for this process.\n");
      }
    });

  telemetry
    .command("disable")
    .description("Disable anonymous telemetry in the user config.")
    .action(() => {
      const path = resolveConfigPath(currentConfigPath());
      writeTelemetryConfig(path, false);
      writeOut(`Disabled anonymous telemetry in ${path}.\n`);
    });

  telemetry
    .command("delete-id")
    .description("Delete the local anonymous telemetry ID.")
    .action(() => {
      deleteTelemetryIdentity({ stateDir: telemetryContext().stateDir });
      writeOut(
        "Deleted the local anonymous telemetry ID. This does not delete provider-side historical anonymous events; provider retention controls historical data.\n",
      );
    });

  telemetry
    .command("rotate-id")
    .description("Rotate the local anonymous telemetry ID.")
    .action(() => {
      rotateTelemetryIdentity({ stateDir: telemetryContext().stateDir });
      writeOut(
        "Rotated the local anonymous telemetry ID. This does not delete provider-side historical anonymous events; provider retention controls historical data.\n",
      );
    });

  telemetry
    .command("attribution")
    .description("Record a categorical install attribution marker.")
    .argument("<marker>", "install attribution marker")
    .action((marker: string) => {
      const attribution = writeTelemetryAttribution({
        stateDir: telemetryContext().stateDir,
        marker,
      });
      if (!attribution) {
        throw new CapletsError("REQUEST_INVALID", "Unknown install attribution marker.");
      }
    });

  telemetry
    .command("debug")
    .description("Run a Caplets command with local telemetry debug output.")
    .allowUnknownOption(true)
    .argument("[args...]", "Caplets command and arguments after --")
    .action(async (args: string[]) => {
      const nestedArgs = args[0] === "--" ? args.slice(1) : args;
      const sink = new TelemetryDebugSink();
      try {
        if (nestedArgs.length > 0) {
          await runCli(nestedArgs, {
            ...io,
            env: { ...env, CAPLETS_DISABLE_UPDATE_CHECK: "1", CAPLETS_TELEMETRY_DEBUG: "1" },
            telemetryDebugSink: sink,
            writeOut,
            writeErr,
          });
        }
      } finally {
        writeOut(`${JSON.stringify({ telemetryDebug: sink.toJSON() }, null, 2)}\n`);
      }
    });

  const codeMode = program
    .command(cliCommands.codeMode)
    .description("Run, inspect, and debug Caplets Code Mode.")
    .argument("[code]", "inline TypeScript code to run")
    .option("--file <path>", "read TypeScript code from a file relative to the current directory")
    .option("--session-id <id>", "optional Code Mode session identifier")
    .option("--recover <ref>", "recover a prior Code Mode REPL session when supported")
    .option("--timeout-ms <ms>", "execution timeout in milliseconds", parsePositiveInteger)
    .option("--json", "print the structured run envelope")
    .action(
      async (
        code: string | undefined,
        options: {
          file?: string;
          sessionId?: string;
          recover?: string;
          timeoutMs?: number;
          json?: boolean;
        },
      ) => {
        try {
          maybePrintCliTelemetryNotice(telemetryContext(), "code_mode");
        } catch {
          // Telemetry notice delivery is best-effort and must not affect Code Mode.
        }
        if (code === "repl" && options.file === undefined) {
          await runCodeModeReplCli({
            env,
            ...(currentConfigPath() ? { configPath: currentConfigPath() } : {}),
            projectConfigPath: envProjectConfigPath(env),
            ...(io.authDir ? { authDir: io.authDir } : {}),
            ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
            ...(options.recover === undefined ? {} : { recoveryRef: options.recover }),
            ...(options.json === undefined ? {} : { json: options.json }),
            writeOut,
            setExitCode,
          });
          return;
        }
        if (options.recover !== undefined) {
          await runCodeModeReplCli({
            env,
            ...(currentConfigPath() ? { configPath: currentConfigPath() } : {}),
            projectConfigPath: envProjectConfigPath(env),
            ...(io.authDir ? { authDir: io.authDir } : {}),
            ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
            recoveryRef: options.recover,
            ...(options.json === undefined ? {} : { json: options.json }),
            writeOut,
            setExitCode,
          });
          return;
        }
        await runCodeModeCli({
          env,
          ...(currentConfigPath() ? { configPath: currentConfigPath() } : {}),
          projectConfigPath: envProjectConfigPath(env),
          ...(io.authDir ? { authDir: io.authDir } : {}),
          telemetryStateDir: telemetryContext().stateDir,
          ...(code === undefined ? {} : { inlineCode: code }),
          ...(options.file === undefined ? {} : { file: options.file }),
          ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.json === undefined ? {} : { json: options.json }),
          ...(io.readStdin ? { readStdin: io.readStdin } : {}),
          writeOut,
          setExitCode,
        });
      },
    );
  codeMode
    .command("types")
    .description("Print the generated Code Mode TypeScript declarations.")
    .option("--json", "print declaration metadata as JSON")
    .action(
      async (options: { json?: boolean }, command: { parent?: { opts(): { json?: boolean } } }) => {
        const parentOptions = command.parent?.opts() ?? {};
        await codeModeTypesCli({
          env,
          ...(currentConfigPath() ? { configPath: currentConfigPath() } : {}),
          projectConfigPath: envProjectConfigPath(env),
          ...(io.authDir ? { authDir: io.authDir } : {}),
          telemetryStateDir: telemetryContext().stateDir,
          ...(options.json === undefined && parentOptions.json === undefined
            ? {}
            : { json: options.json ?? parentOptions.json }),
          writeOut,
        });
      },
    );

  const serve = program
    .command(cliCommands.serve)
    .description("Serve configured Caplets as an MCP server.")
    .option("--transport <transport>", "server transport: stdio or http")
    .option("--host <host>", "HTTP bind host")
    .option("--port <port>", "HTTP bind port")
    .option("--path <path>", "HTTP service base path")
    .option("--remote-state-path <path>", "server-owned remote credential state directory")
    .option(
      "--upstream-url <url>",
      "upstream Caplets runtime URL to compose with this HTTP service",
    )
    .option(
      "--allow-unauthenticated-http",
      "allow unauthenticated HTTP serving on non-loopback hosts",
    )
    .option("--trust-proxy", "trust X-Forwarded-* headers from a reverse proxy")
    .action(
      async (options: {
        transport?: string;
        host?: string;
        port?: string;
        path?: string;
        remoteStatePath?: string;
        upstreamUrl?: string;
        allowUnauthenticatedHttp?: boolean;
        trustProxy?: boolean;
      }) => {
        printTelemetryNotice("serve");
        const defaults = options.transport === "http" ? currentServeDefaults() : undefined;
        const resolved = resolveServeOptions(options, env, defaults);
        const configPath = currentConfigPath();
        const runner =
          io.serve ??
          ((serveOptions: ServeOptions) =>
            serveResolvedCaplets(
              serveOptions,
              {
                ...(configPath ? { configPath } : {}),
                projectConfigPath: envProjectConfigPath(env),
                ...(io.authDir ? { authDir: io.authDir } : {}),
                telemetryEnv: env,
                telemetryStateDir: io.telemetryStateDir ?? defaultTelemetryStateDir(env),
                telemetrySurface: "serve",
                telemetryVisibility: "visible",
                telemetryRuntimeMode: runtimeModeForEnv(env),
              },
              writeErr,
            ));
        await io.maybePrintUpdateNotice?.();
        await runner(resolved);
      },
    );

  const daemonOptions = (): DaemonOperationOptions => ({
    env,
    ...io.daemon,
  });

  for (const [name, replacement] of Object.entries({
    start: "caplets daemon start",
    stop: "caplets daemon stop",
    status: "caplets daemon status",
    restart: "caplets daemon restart",
    enable: "caplets daemon install",
    disable: "caplets daemon uninstall",
  })) {
    addServeMigrationCommand(serve, name, replacement);
  }

  const daemon = program
    .command(cliCommands.daemon)
    .description("Install and manage the default Caplets daemon.");

  addDaemonInstallOptions(
    daemon.command("install").description("Install or update the default Caplets daemon."),
  ).action(async (options: DaemonInstallCommandOptions) => {
    printTelemetryNotice("daemon");
    const prompt = options.json ? undefined : createSetupPromptHandle(io, writeOut);
    try {
      const result = await installDaemon(daemonInstallOptions(options), {
        ...daemonOptions(),
        ...(prompt
          ? { readPrompt: prompt.readPrompt, isInteractive: true }
          : { isInteractive: false }),
      });
      if (options.json) {
        writeOut(`${JSON.stringify(redactDaemonInstallResult(result), null, 2)}\n`);
        return;
      }
      if (result.dryRun) {
        writeOut(`Would install Caplets daemon using ${result.descriptor.kind}.\n`);
        return;
      }
      writeOut(`Installed Caplets daemon using ${result.descriptor.kind}.\n`);
    } finally {
      prompt?.close();
    }
  });

  addJsonOption(
    daemon
      .command("uninstall")
      .description("Uninstall the default Caplets daemon.")
      .option("--purge", "remove daemon config, state, and logs")
      .option("--dry-run", "preview uninstall actions without mutation"),
  ).action(async (options: { json?: boolean; purge?: boolean; dryRun?: boolean }) => {
    printTelemetryNotice("daemon");
    const result = await uninstallDaemon(
      { purge: options.purge === true, dryRun: options.dryRun === true },
      daemonOptions(),
    );
    if (options.json) {
      writeOut(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    writeOut(result.dryRun ? "Would uninstall Caplets daemon.\n" : "Uninstalled Caplets daemon.\n");
  });

  addJsonOption(daemon.command("start").description("Start the default Caplets daemon.")).action(
    async (options: DaemonCommandOptions) => {
      printTelemetryNotice("daemon");
      const result = await startDaemon(daemonOptions());
      if (options.json) {
        writeOut(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      writeOut(
        result.action === "restart" ? "Restarted Caplets daemon.\n" : "Started Caplets daemon.\n",
      );
    },
  );

  addJsonOption(
    daemon.command("restart").description("Restart the default Caplets daemon."),
  ).action(async (options: DaemonCommandOptions) => {
    printTelemetryNotice("daemon");
    const result = await restartDaemon(daemonOptions());
    if (options.json) {
      writeOut(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    writeOut("Restarted Caplets daemon.\n");
  });

  addJsonOption(daemon.command("stop").description("Stop the default Caplets daemon.")).action(
    async (options: DaemonCommandOptions) => {
      printTelemetryNotice("daemon");
      const result = await stopDaemon(daemonOptions());
      if (options.json) {
        writeOut(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }
      writeOut("Stopped Caplets daemon.\n");
    },
  );

  addJsonOption(
    daemon.command("status").description("Show the default Caplets daemon status."),
  ).action(async (options: DaemonCommandOptions) => {
    printTelemetryNotice("daemon");
    const status = await daemonStatus(daemonOptions());
    if (options.json) {
      writeOut(`${JSON.stringify(status, null, 2)}\n`);
      return;
    }
    writeOut(formatDaemonStatus(status));
  });

  addJsonOption(
    daemon
      .command("logs")
      .description("Show Caplets daemon logs.")
      .option("--follow", "follow appended log lines")
      .option("--tail <lines>", "show the last number of lines")
      .option("--stream <stream>", "log stream: stdout, stderr, or all"),
  ).action(async (options: DaemonLogsCommandOptions) => {
    printTelemetryNotice("daemon");
    const tail = options.tail === undefined ? 10 : parseNonNegativeInteger(options.tail, "--tail");
    const stream = parseLogStream(options.stream);
    if (options.follow) {
      const controller = new AbortController();
      await followDaemonLogs(resolveDaemonPaths(daemonOptions()), {
        stream,
        tail,
        signal: io.signal ?? controller.signal,
        write: (entry) => {
          if (options.json) {
            writeOut(`${JSON.stringify(entry)}\n`);
            return;
          }
          if ("type" in entry) return;
          writeOut(stream === "all" ? `[${entry.stream}] ${entry.line}\n` : `${entry.line}\n`);
        },
      });
      return;
    }
    const result = daemonLogs({ ...daemonOptions(), stream, tail });
    if (options.json) {
      writeOut(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (result.entries.length === 0) {
      writeOut(
        `No Caplets daemon logs found. Expected stdout at ${result.paths.stdoutLog} and stderr at ${result.paths.stderrLog}.\n`,
      );
      return;
    }
    for (const entry of result.entries) {
      writeOut(stream === "all" ? `[${entry.stream}] ${entry.line}\n` : `${entry.line}\n`);
    }
  });

  program
    .command(cliCommands.attach)
    .description("Start a remote-backed Caplets MCP server.")
    .argument("[url]", "remote Caplets service base URL")
    .addOption(hiddenOption("--transport <transport>", "server transport: stdio or http"))
    .addOption(hiddenOption("--host <host>", "HTTP bind host"))
    .addOption(hiddenOption("--port <port>", "HTTP bind port"))
    .addOption(hiddenOption("--path <path>", "HTTP service base path"))
    .addOption(
      new Option(
        "--remote-url <url>",
        "legacy alias for the remote Caplets service base URL",
      ).hideHelp(),
    )
    .option("--workspace <workspace>", "hosted Cloud workspace ID or slug")
    .addOption(
      hiddenOption(
        "--allow-unauthenticated-http",
        "allow unauthenticated HTTP serving on non-loopback hosts",
      ),
    )
    .addOption(hiddenOption("--trust-proxy", "trust X-Forwarded-* headers from a reverse proxy"))
    .option("--json", "print JSON status events")
    .option("--verbose", "print detailed attach diagnostics")
    .option("--once", "validate Project Binding once and exit")
    .option("--project-root <path>", "test-only project root override")
    .action(
      async (
        url: string | undefined,
        options: {
          remoteUrl?: string;
          transport?: string;
          host?: string;
          port?: string;
          path?: string;
          workspace?: string;
          allowUnauthenticatedHttp?: boolean;
          trustProxy?: boolean;
          json?: boolean;
          verbose?: boolean;
          once?: boolean;
          projectRoot?: string;
        },
      ) => {
        printTelemetryNotice("attach");
        try {
          rejectAttachHttpServeFlags(options);
          const remoteUrl = attachRemoteUrlFromArgs(url, options.remoteUrl);
          const attachOptions = {
            ...options,
            ...(remoteUrl ? { remoteUrl } : {}),
            ...(io.fetch ? { fetch: io.fetch } : {}),
            ...(io.authDir ? { authDir: io.authDir } : {}),
          };
          if (!options.once) {
            const resolved = await resolveAttachServeOptions(attachOptions, env);
            await io.maybePrintUpdateNotice?.();
            await (
              io.attachServe ??
              ((serveOptions) => attachResolvedCaplets(serveOptions, { writeErr }))
            )(resolved);
            return;
          }
          const result = await attachProjectOnce(attachOptions, env);
          if (options.json) {
            writeOut(`${JSON.stringify(result, null, 2)}\n`);
            return;
          }
          writeOut(`Project Binding available at ${result.webSocketUrl}.\n`);
        } catch (error) {
          if (options.json && isProjectBindingWebSocketUnavailable(error)) {
            writeOut(
              `${JSON.stringify(
                {
                  ok: false,
                  error: {
                    code: "PROJECT_BINDING_WEBSOCKET_UNAVAILABLE",
                    message: error instanceof Error ? error.message : String(error),
                  },
                },
                null,
                2,
              )}\n`,
            );
            setExitCode(1);
            return;
          }
          if (options.json && isProjectBindingCliError(error)) {
            writeOut(
              `${JSON.stringify(
                {
                  ok: false,
                  error: {
                    code: error.projectBindingCode,
                    message: error.message,
                    recoveryCommand: error.recoveryCommand,
                    requestId: error.requestId,
                  },
                },
                null,
                2,
              )}\n`,
            );
            setExitCode(1);
            return;
          }
          if (options.json && error instanceof CapletsError) {
            writeOut(
              `${JSON.stringify(
                {
                  ok: false,
                  error: {
                    code: error.code,
                    message: error.message,
                  },
                },
                null,
                2,
              )}\n`,
            );
            setExitCode(1);
            return;
          }
          throw error;
        }
      },
    );

  const remote = program.command(cliCommands.remote).description("Manage Caplets Remote Login.");
  remote
    .command("login")
    .description("Log this machine into a Caplets host.")
    .argument("<url>", "Caplets host URL")
    .option("--workspace <workspace>", "Cloud workspace ID or slug to select")
    .option("--client-label <label>", "client label for this machine")
    .option("--device-name <name>", "Cloud device label for this machine")
    .addOption(new Option("--code <code>", "legacy Pairing Code input").hideHelp())
    .addOption(new Option("--code-stdin", "legacy Pairing Code stdin input").hideHelp())
    .option("--no-open", "print the Cloud login URL without opening a browser")
    .option("--json", "print JSON output")
    .action(
      async (
        url: string,
        options: {
          workspace?: string;
          clientLabel?: string;
          deviceName?: string;
          code?: string;
          codeStdin?: boolean;
          open?: boolean;
          json?: boolean;
        },
      ) => {
        const store = remoteProfileStore(io.authDir, env);
        if (isCapletsCloudUrl(url)) {
          const status = await loginCloudRemoteProfile(url, options, store, {
            env,
            ...(io.fetch ? { fetch: io.fetch } : {}),
            writeOut,
          });
          writeRemoteStatus(status, options.json === true, writeOut);
          return;
        }

        if (options.code?.trim() || options.codeStdin) {
          throw new CapletsError(
            "REQUEST_INVALID",
            `Self-hosted Remote Login no longer accepts Pairing Codes. Run caplets remote login ${normalizeRemoteProfileHostUrl(url)} without --code and approve the pending login from the host.`,
          );
        }
        const interrupt = cliInterruptSignal(io.signal);
        let credentials: RemoteLoginCredentialsResponse;
        try {
          credentials = await selfHostedPendingRemoteLogin(url, {
            ...(options.clientLabel ? { clientLabel: options.clientLabel } : {}),
            json: options.json,
            ...(io.fetch ? { fetch: io.fetch } : {}),
            ...(interrupt.signal ? { signal: interrupt.signal } : {}),
            writeOut,
            env,
          });
        } finally {
          interrupt.dispose();
        }
        const status = await store.saveSelfHostedProfile({
          hostUrl: url,
          hostIdentity: normalizeRemoteProfileHostUrl(credentials.hostUrl ?? url),
          clientId: credentials.clientId,
          clientLabel: credentials.clientLabel,
          credentials: {
            accessToken: credentials.accessToken,
            refreshToken: credentials.refreshToken,
            tokenType: credentials.tokenType,
            expiresAt: credentials.expiresAt,
          },
        });
        if (options.json === true) {
          writeOut(`${JSON.stringify({ code: "remote_profile_saved", ...status })}\n`);
        } else {
          writeRemoteStatus(status, false, writeOut);
        }
      },
    );

  remote
    .command("status")
    .description("Show saved Remote Login status.")
    .argument("[url]", "Caplets host URL")
    .option("--workspace <workspace>", "Cloud workspace ID or slug")
    .option("--json", "print JSON output")
    .action(async (url: string | undefined, options: { workspace?: string; json?: boolean }) => {
      if (!url) {
        const store = remoteProfileStore(io.authDir, env);
        const profiles = await store.listProfileStatuses();
        if (options.json) {
          writeOut(`${JSON.stringify({ profiles }, null, 2)}\n`);
          return;
        }
        if (profiles.length === 0) {
          writeOut("No saved Remote Login profiles.\n");
          return;
        }
        for (const profile of profiles) {
          writeRemoteStatus(profile, false, writeOut);
        }
        return;
      }
      const store = remoteProfileStore(io.authDir, env);
      const normalizedHostUrl = normalizeRemoteProfileHostUrl(url);
      const status = isCapletsCloudUrl(url)
        ? await store.getCloudProfileStatus({ hostUrl: url, workspace: options.workspace })
        : await store.getSelfHostedProfileStatus({ hostUrl: url });
      writeRemoteStatus(
        status ?? {
          authenticated: false,
          status: "unauthenticated",
          hostUrl: normalizedHostUrl,
          kind: isCapletsCloudUrl(url) ? "cloud" : "self-hosted",
        },
        options.json === true,
        writeOut,
      );
    });

  remote
    .command("logout")
    .description("Remove saved Remote Login credentials for a host.")
    .argument("<url>", "Caplets host URL")
    .option("--workspace <workspace>", "Cloud workspace ID or slug")
    .option("--json", "print JSON output")
    .action(async (url: string, options: { workspace?: string; json?: boolean }) => {
      const store = remoteProfileStore(io.authDir, env);
      const status = isCapletsCloudUrl(url)
        ? await store.getCloudProfileStatus({ hostUrl: url, workspace: options.workspace })
        : await store.getSelfHostedProfileStatus({ hostUrl: url });
      const credential = status ? await store.credentials.load(status.key) : undefined;
      if (isCapletsCloudUrl(url) && credential?.refreshToken) {
        await new CloudAuthClient({
          cloudUrl: url,
          ...(io.fetch ? { fetch: io.fetch } : {}),
        })
          .logout(credential.refreshToken)
          .catch(() => undefined);
      }
      const storedAccessToken = credential?.accessToken;
      if (!isCapletsCloudUrl(url) && storedAccessToken) {
        const accessToken = await selfHostedLogoutAccessToken(
          url,
          { ...credential, accessToken: storedAccessToken },
          { authDir: io.authDir, ...(io.fetch ? { fetch: io.fetch } : {}) },
          env,
        ).catch(() => storedAccessToken);
        await revokeSelfHostedRemoteClient(url, accessToken, io.fetch).catch(() => undefined);
      }
      const removed = status
        ? isCapletsCloudUrl(url)
          ? await store.logoutCloudProfile({ hostUrl: url, workspace: options.workspace })
          : await store.logoutSelfHostedProfile({ hostUrl: url })
        : false;
      if (options.json) {
        writeOut(
          `${JSON.stringify({ loggedOut: removed, hostUrl: normalizeRemoteProfileHostUrl(url) }, null, 2)}\n`,
        );
        return;
      }
      writeOut(
        removed
          ? `Logged out of ${normalizeRemoteProfileHostUrl(url)}.\n`
          : `No Remote Login profile found for ${normalizeRemoteProfileHostUrl(url)}.\n`,
      );
    });

  const remoteHost = remote.command("host").description("Manage self-hosted remote credentials.");
  remoteHost
    .command("pair", { hidden: true })
    .description("Deprecated. Pairing Code bootstrap is no longer supported.")
    .option("--host-url <url>", "public Caplets host URL; defaults to CAPLETS_SERVER_URL")
    .option("--json", "print JSON output")
    .action(async (options: { hostUrl?: string; json?: boolean }) => {
      const hostUrl = options.hostUrl ?? env.CAPLETS_SERVER_URL;
      const guidance =
        "Self-hosted Pairing Code bootstrap is no longer supported. Run caplets remote login <url> from the client, then approve the pending login with caplets remote host logins and caplets remote host approve <code> from the host.";
      if (options.json) {
        writeOut(
          `${JSON.stringify(
            {
              supported: false,
              deprecated: true,
              ...(hostUrl ? { hostUrl: normalizeRemoteProfileHostUrl(hostUrl) } : {}),
              message: guidance,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      writeOut(`${guidance}\n`);
    });
  remoteHost
    .command("clients")
    .description("List paired self-hosted remote clients from server state.")
    .option("--json", "print JSON output")
    .action(async (options: { json?: boolean }) => {
      const clients = await withRemoteCredentialAuthority(env, (authority) =>
        authority.listClients(),
      );
      if (options.json) {
        writeOut(`${JSON.stringify({ clients }, null, 2)}\n`);
        return;
      }
      if (clients.length === 0) {
        writeOut("No paired remote clients.\n");
        return;
      }
      for (const client of clients) {
        writeOut(
          `${client.clientId}\t${client.role}\t${terminalSafeText(client.clientLabel)}\t${client.hostUrl}\t${client.revokedAt ? "revoked" : "active"}\n`,
        );
      }
    });
  remoteHost
    .command("logins")
    .description("List pending self-hosted Remote Login approvals from server state.")
    .option("--json", "print JSON output")
    .action(async (options: { json?: boolean }) => {
      const pendingLogins = await withRemoteCredentialAuthority(env, (authority) =>
        authority.listPendingLogins(),
      );
      if (options.json) {
        writeOut(`${JSON.stringify({ pendingLogins }, null, 2)}\n`);
        return;
      }
      if (pendingLogins.length === 0) {
        writeOut("No pending Remote Login approvals.\n");
        return;
      }
      for (const pending of pendingLogins) {
        writeOut(
          `${pending.flowId}\t${pending.operatorCodeFingerprint ?? "-"}\t${pending.requestedRole}\t${pending.grantedRole ?? "-"}\t${terminalSafeText(pending.clientLabel)}\t${pending.hostUrl}\t${pending.status}\n`,
        );
      }
    });
  remoteHost
    .command("approve")
    .description("Approve one pending self-hosted Remote Login code from server state.")
    .argument("<code>", "operator-visible Remote Login code")
    .option("--role <role>", "grant role override: access or operator", parseRemoteClientRole)
    .option("--yes", "approve without an interactive confirmation prompt")
    .option("--json", "print JSON output")
    .action(
      async (
        code: string,
        options: {
          role?: RemoteClientRole;
          yes?: boolean;
          json?: boolean;
        },
      ) => {
        if (!options.yes && !options.json) {
          throw new CapletsError("REQUEST_INVALID", "Use --yes to approve this pending login.");
        }
        const approved = await withRemoteCredentialAuthority(
          env,
          (authority) =>
            authority.approvePendingLogin({
              operatorCode: code,
              ...(options.role ? { grantedRole: options.role } : {}),
            }),
          (stateRoot) =>
            approvePendingLoginThroughHostLocalAuthority({
              stateRoot,
              operatorCode: code,
              ...(options.role ? { grantedRole: options.role } : {}),
              ...(io.fetch ? { fetch: io.fetch } : {}),
            }),
        );
        if (options.json) {
          writeOut(`${JSON.stringify(approved, null, 2)}\n`);
          return;
        }
        writeOut(`Approved pending Remote Login ${approved.flowId} as ${approved.grantedRole}.\n`);
      },
    );
  remoteHost
    .command("deny")
    .description("Deny one pending self-hosted Remote Login code from server state.")
    .argument("<code>", "operator-visible Remote Login code")
    .option("--json", "print JSON output")
    .action(async (code: string, options: { json?: boolean }) => {
      const denied = await withRemoteCredentialAuthority(env, (authority) =>
        authority.denyPendingLogin({ operatorCode: code }),
      );
      if (options.json) {
        writeOut(`${JSON.stringify(denied, null, 2)}\n`);
        return;
      }
      writeOut(`Denied pending Remote Login ${denied.flowId}.\n`);
    });
  remoteHost
    .command("revoke")
    .description("Revoke one paired self-hosted remote client from server state.")
    .argument("<client-id>", "remote client ID")
    .option("--json", "print JSON output")
    .action(async (clientId: string, options: { json?: boolean }) => {
      const revoked = await withRemoteCredentialAuthority(env, (authority) =>
        authority.revokeClient(clientId),
      );
      if (options.json) {
        writeOut(`${JSON.stringify({ revoked, clientId }, null, 2)}\n`);
        return;
      }
      writeOut(revoked ? `Revoked ${clientId}.\n` : `No remote client found for ${clientId}.\n`);
    });

  const cloud = program.command(cliCommands.cloud).description("Manage hosted Caplets Cloud.");
  const cloudAuth = cloud
    .command("auth")
    .description("Authenticate this Caplets client to hosted Caplets Cloud.");
  cloudAuth
    .command("login")
    .description("Log in to hosted Caplets Cloud.")
    .option("--cloud-url <url>", "hosted Caplets Cloud URL")
    .option("--workspace <workspace>", "workspace ID or slug to select")
    .option("--device-name <name>", "device label for this Cloud Auth credential")
    .option("--no-open", "print the login URL without opening a browser")
    .option("--json", "print JSON output")
    .action(
      async (options: {
        cloudUrl?: string;
        workspace?: string;
        deviceName?: string;
        open?: boolean;
        json?: boolean;
      }) => {
        const status = await loginCloudRemoteProfile(
          defaultCloudUrl(env, options.cloudUrl),
          options,
          remoteProfileStore(io.authDir, env),
          {
            env,
            ...(io.fetch ? { fetch: io.fetch } : {}),
            writeOut,
          },
        );
        writeRemoteStatus(status, options.json === true, writeOut);
      },
    );
  cloudAuth
    .command("status")
    .description("Show hosted Caplets Cloud authentication status.")
    .option("--cloud-url <url>", "hosted Caplets Cloud URL")
    .option("--workspace <workspace>", "workspace ID or slug")
    .option("--json", "print JSON output")
    .action(async (options: { cloudUrl?: string; workspace?: string; json?: boolean }) => {
      const cloudUrl = defaultCloudUrl(env, options.cloudUrl);
      const status = await remoteProfileStore(io.authDir, env).getCloudProfileStatus({
        hostUrl: cloudUrl,
        ...(options.workspace ? { workspace: options.workspace } : {}),
      });
      writeRemoteStatus(
        status ?? {
          authenticated: false,
          status: "unauthenticated",
          hostUrl: normalizeRemoteProfileHostUrl(cloudUrl),
          kind: "cloud",
        },
        options.json === true,
        writeOut,
      );
    });
  cloudAuth
    .command("logout")
    .description("Log out of hosted Caplets Cloud.")
    .option("--cloud-url <url>", "hosted Caplets Cloud URL")
    .option("--workspace <workspace>", "workspace ID or slug")
    .option("--json", "print JSON output")
    .action(async (options: { cloudUrl?: string; workspace?: string; json?: boolean }) => {
      const cloudUrl = defaultCloudUrl(env, options.cloudUrl);
      const store = remoteProfileStore(io.authDir, env);
      const status = await store.getCloudProfileStatus({
        hostUrl: cloudUrl,
        ...(options.workspace ? { workspace: options.workspace } : {}),
      });
      const credential = status ? await store.credentials.load(status.key) : undefined;
      if (credential?.refreshToken) {
        await new CloudAuthClient({
          cloudUrl,
          ...(io.fetch ? { fetch: io.fetch } : {}),
        })
          .logout(credential.refreshToken)
          .catch(() => undefined);
      }
      const removed = await store.logoutCloudProfile({
        hostUrl: cloudUrl,
        ...(options.workspace ? { workspace: options.workspace } : {}),
      });
      if (options.json) {
        writeOut(
          `${JSON.stringify({ loggedOut: removed, hostUrl: normalizeRemoteProfileHostUrl(cloudUrl) }, null, 2)}\n`,
        );
        return;
      }
      writeOut(
        removed
          ? `Logged out of ${normalizeRemoteProfileHostUrl(cloudUrl)}.\n`
          : `No Remote Login profile found for ${normalizeRemoteProfileHostUrl(cloudUrl)}.\n`,
      );
    });
  cloudAuth
    .command("workspaces")
    .description("List hosted Caplets Cloud workspaces.")
    .option("--cloud-url <url>", "hosted Caplets Cloud URL")
    .option("--json", "print JSON output")
    .action(async (options: { cloudUrl?: string; json?: boolean }) => {
      const store = remoteProfileStore(io.authDir, env);
      const cloudUrl = defaultCloudUrl(env, options.cloudUrl);
      const loaded = await store.getCloudProfileStatus({ hostUrl: cloudUrl });
      const credential = loaded ? await store.credentials.load(loaded.key) : undefined;
      const credentials =
        loaded && credential?.accessToken
          ? cloudCredentialsFromRemoteProfile(loaded, credential)
          : undefined;
      const workspaces = credentials
        ? (
            await new CloudAuthClient({
              cloudUrl: credentials.cloudUrl,
              ...(io.fetch ? { fetch: io.fetch } : {}),
            })
              .workspaces(credentials.accessToken)
              .catch(() => ({
                workspaces: [
                  {
                    workspaceId: credentials.workspaceId,
                    ...(credentials.workspaceSlug ? { slug: credentials.workspaceSlug } : {}),
                  },
                ],
              }))
          ).workspaces.map((workspace) => ({
            ...workspace,
            selected:
              workspace.workspaceId === credentials.workspaceId ||
              workspace.slug === credentials.workspaceSlug,
          }))
        : [];
      if (options.json) {
        writeOut(`${JSON.stringify({ workspaces }, null, 2)}\n`);
        return;
      }
      if (workspaces.length === 0) {
        writeOut(
          "No hosted Caplets Cloud workspaces available. Run caplets remote login <cloud-url>.\n",
        );
        return;
      }
      for (const workspace of workspaces) {
        writeOut(`${workspace.selected ? "* " : "  "}${workspace.slug ?? workspace.workspaceId}\n`);
      }
    });
  cloudAuth
    .command("switch")
    .description("Switch the hosted Caplets Cloud Selected Workspace.")
    .argument("<workspace>", "workspace ID or slug")
    .option("--cloud-url <url>", "hosted Caplets Cloud URL")
    .option("--json", "print JSON output")
    .action(async (workspace: string, options: { cloudUrl?: string; json?: boolean }) => {
      const store = remoteProfileStore(io.authDir, env);
      const cloudUrl = defaultCloudUrl(env, options.cloudUrl);
      const loaded = await loadCloudRemoteProfileCredentials(store, { cloudUrl });
      const credentials = cloudCredentialsFromRemoteProfile(loaded.status, loaded.credential);
      const client = new CloudAuthClient({
        cloudUrl: credentials.cloudUrl,
        ...(io.fetch ? { fetch: io.fetch } : {}),
      });
      const switched = await client.switchWorkspace({
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        workspace,
        deviceName: credentials.deviceName,
      });
      const status = await store.saveCloudProfile({
        hostUrl: credentials.cloudUrl,
        workspaceId: switched.workspaceId,
        ...(switched.workspaceSlug ? { workspaceSlug: switched.workspaceSlug } : {}),
        clientLabel: credentials.deviceName,
        credentials: {
          accessToken: switched.accessToken,
          refreshToken: switched.refreshToken ?? credentials.refreshToken,
          expiresAt: switched.expiresAt,
          scope: switched.scope,
          tokenType: switched.tokenType,
        },
      });
      writeRemoteStatus(status, options.json === true, writeOut);
    });

  cloud
    .command("add")
    .description("Upload local caplet-files to the selected hosted Caplets Cloud workspace.")
    .argument("[path]", "directory containing caplet-files", ".")
    .option("--cloud-url <url>", "hosted Caplets Cloud URL")
    .option("--workspace <workspace>", "workspace ID or slug")
    .option("--json", "print JSON output")
    .action(
      async (
        pathInput: string,
        options: { cloudUrl?: string; workspace?: string; json?: boolean },
      ) => {
        const cloudUrl = defaultCloudUrl(env, options.cloudUrl);
        const selection = await resolveRemoteSelection(
          {
            mode: "cloud",
            remoteUrl: cloudUrl,
            ...(options.workspace ? { workspace: options.workspace } : {}),
            ...(io.authDir ? { authDir: io.authDir } : {}),
            ...(io.fetch ? { fetch: io.fetch } : {}),
          },
          { ...env, CAPLETS_MODE: "cloud", CAPLETS_REMOTE_URL: cloudUrl },
        );
        if (selection.kind !== "hosted_cloud") {
          throw new CapletsError("REQUEST_INVALID", "caplets cloud add requires Caplets Cloud.");
        }
        const workspace = selection.selectedWorkspace;
        const bundle = buildCloudCapletBundle(pathInput);
        const result = await new CloudAuthClient({
          cloudUrl,
          ...(io.fetch ? { fetch: io.fetch } : {}),
        }).addCaplets({
          accessToken: selection.credentials.accessToken,
          workspace,
          bundle,
        });
        const caplets = result.caplets.map(compactCloudCaplet);
        if (options.json) {
          writeOut(`${JSON.stringify({ caplets, workspace }, null, 2)}\n`);
          return;
        }
        for (const caplet of caplets) {
          writeOut(`Added ${caplet.name ?? caplet.id ?? "Caplet"} to ${workspace}.\n`);
        }
      },
    );

  program
    .command(cliCommands.init)
    .description("Create a starter Caplets config file.")
    .option("--project", "create the project Caplets config")
    .option("-g, --global", "create the user Caplets config")
    .option("--remote", "create the remote Caplets config")
    .option("--force", "overwrite an existing config file")
    .action(async (options: MutationTargetOptions & { force?: boolean }) => {
      const target = resolveMutationTarget(options);
      if (target === "remote") {
        const remote = requireRemoteClientForTarget(io);
        const result = (await remote.request("init", {
          force: Boolean(options.force),
        })) as { path: string; remote: true };
        writeOut(`Created remote Caplets config at ${result.path}\n`);
        return;
      }
      const path = initConfig({
        path:
          target === "global" ? resolveConfigPath(currentConfigPath()) : envProjectConfigPath(env),
        force: Boolean(options.force),
      });
      writeOut(`Created ${localMutationTargetLabel(target)}Caplets config at ${path}\n`);
    });

  program
    .command(cliCommands.setup)
    .description("Install or configure an agent integration for Caplets.")
    .argument("[integration]", "integration: codex, claude-code, opencode, pi, or mcp-client")
    .option("--remote", "configure for a remote Caplets server")
    .option("--remote-url <url>", "remote Caplets service base URL")
    .option("--server-url <url>", "remote Caplets service base URL")
    .option("--output <path>", "config path to write for generic MCP setup")
    .option("--client <id>", "MCP client id to configure through add-mcp")
    .option("--dry-run", "print actions without running commands or writing files")
    .option("--yes", "approve Caplet setup commands for the exact current content hash")
    .option("--target <target>", "Caplet setup target: local, remote, or cloud", parseSetupTarget)
    .option("--format <format>", "output format: plain or json", parseSetupFormat)
    .action(
      async (
        integration: string | undefined,
        options: {
          remote?: boolean;
          remoteUrl?: string;
          serverUrl?: string;
          output?: string;
          client?: string;
          dryRun?: boolean;
          yes?: boolean;
          target?: "local" | "remote" | "cloud";
          format?: SetupFormat;
        },
      ) => {
        printTelemetryNotice("cli");
        const setupOptions: SetupOptions = { ...options, env };
        if (io.runSetupCommand) setupOptions.runCommand = io.runSetupCommand;
        if (io.setupOperations) setupOptions.setupOperations = io.setupOperations;
        if (io.mcpOperations) setupOptions.mcpOperations = io.mcpOperations;
        if (!integration) {
          const promptHandle = createSetupPromptHandle(io, writeOut);
          if (!promptHandle) {
            writeOut(formatSetupMenu());
            return;
          }
          try {
            writeOut(
              await runInteractiveSetup({
                ...setupOptions,
                readPrompt: promptHandle.readPrompt,
              }),
            );
          } finally {
            promptHandle.close();
          }
          return;
        }
        writeOut(await runSetup(integration, setupOptions));
      },
    );

  program
    .command(cliCommands.doctor)
    .description("Diagnose Caplets local, remote, and project-sync configuration.")
    .option("--json", "print JSON output")
    .option("--format <format>", "output format: plain, markdown, md, or json", parseOutputFormat)
    .action(async (options: { json?: boolean; format?: CliOutputFormat }) => {
      const format = options.format ?? (options.json ? "json" : "plain");
      const writeDoctorReport = async (doctorOptions: DoctorOptions) => {
        if (format === "json") {
          writeOut(`${JSON.stringify(await doctorJsonReport(doctorOptions), null, 2)}\n`);
          return;
        }
        writeOut(await formatDoctorReport(doctorOptions, format));
      };
      const commonDoctorOptions = {
        env,
        ...(io.fetch ? { fetch: io.fetch } : {}),
        ...(io.authDir ? { authDir: io.authDir } : {}),
        ...(io.daemon ? { daemon: io.daemon } : {}),
      };
      if (io.internalDoctorRuntime) {
        await writeDoctorReport({
          ...commonDoctorOptions,
          effectiveRuntime: io.internalDoctorRuntime,
        });
        return;
      }
      const configPath = currentConfigPath();
      const projectConfigPath = envProjectConfigPath(env);
      const engine = await createCapletsEngine({
        ...(configPath ? { configPath } : {}),
        ...(projectConfigPath ? { projectConfigPath } : {}),
        ...(io.authDir ? { authDir: io.authDir } : {}),
        env,
        watch: false,
        ...(io.writeErr ? { writeErr: io.writeErr } : {}),
      });
      try {
        await engine.requireLiveControlPlane("admin");
        const runtimeSnapshot = engine.currentControlPlaneRuntimeSnapshot();
        if (!runtimeSnapshot) {
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            "Activated SQL runtime snapshot is unavailable.",
          );
        }
        await writeDoctorReport({
          ...commonDoctorOptions,
          effectiveRuntime: {
            snapshot: runtimeSnapshot,
            exposure: (await engine.exposureProjection()).projection,
          },
        });
      } finally {
        await engine.close();
      }
    });

  const vault = program.command(cliCommands.vault).description("Manage Caplets Vault values.");

  vault
    .command("set")
    .description("Set a local/global Vault value.")
    .argument("<name>", "Vault key name")
    .option("-g, --global", "target the local/global Vault")
    .option("--remote", "target the selected remote Vault")
    .option("--force", "overwrite an existing Vault value")
    .option("--grant <capletId>", "grant this key to a configured Caplet after setting it")
    .option("--as <referenceName>", "reference name the Caplet uses in config")
    .option("--json", "print JSON output")
    .action(
      async (
        name: string,
        options: VaultTargetOptions & {
          force?: boolean;
          grant?: string;
          as?: string;
          json?: boolean;
        },
      ) => {
        const target = resolveMutationTarget(options, {
          allowedTargets: ["global", "remote"],
          defaultTarget: "global",
        });
        if (target === "remote") {
          const value = await readVaultValue(io);
          assertVaultTransportValueSize(value);
          const status = await remoteVaultSet(io, {
            name,
            value,
            force: Boolean(options.force),
            ...(options.grant ? { grant: options.grant } : {}),
            ...((options.as ?? options.grant) ? { referenceName: options.as ?? name } : {}),
          });
          if (options.json) {
            writeOut(`${JSON.stringify(status, null, 2)}\n`);
            return;
          }
          writeOut(`Set remote Vault key ${validateVaultKeyName(name)}.\n`);
          if (options.grant) {
            writeOut(
              `Granted remote Vault key ${validateVaultKeyName(name)} to ${options.grant} as ${validateVaultKeyName(options.as ?? name)}.\n`,
            );
          }
          return;
        }
        const value = await readVaultValue(io);
        const status = await withControlPlaneSecurity(io, (store, engine) => {
          const effectiveConfig = requireActivatedConfigWithSources(engine);
          return store.setWithGrant({
            key: name,
            value,
            force: Boolean(options.force),
            ...(options.grant
              ? {
                  grant: {
                    storedKey: name,
                    referenceName: options.as ?? name,
                    capletId: options.grant,
                    origin: resolveVaultAccessOrigin(options.grant, effectiveConfig),
                  },
                }
              : {}),
          });
        });
        if (options.json) {
          writeOut(`${JSON.stringify(status, null, 2)}\n`);
          return;
        }
        writeOut(`Set Vault key ${validateVaultKeyName(name)}.\n`);
        if (options.grant) {
          writeOut(
            `Granted Vault key ${validateVaultKeyName(name)} to ${options.grant} as ${validateVaultKeyName(options.as ?? name)}.\n`,
          );
        }
      },
    );

  vault
    .command("get")
    .description("Show local/global Vault metadata, or reveal with --show.")
    .argument("<name>", "Vault key name")
    .option("-g, --global", "target the local/global Vault")
    .option("--remote", "target the selected remote Vault")
    .option("--show", "reveal the raw Vault value")
    .option("--json", "print JSON output")
    .action(
      async (name: string, options: VaultTargetOptions & { show?: boolean; json?: boolean }) => {
        const target = resolveMutationTarget(options, {
          allowedTargets: ["global", "remote"],
          defaultTarget: "global",
        });
        if (target === "remote") {
          const result = await remoteVaultGet(io, { name, reveal: Boolean(options.show) });
          if (options.show) {
            const value =
              result && typeof result === "object" && "value" in result
                ? String((result as { value: unknown }).value)
                : "";
            writeOut(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${value}\n`);
            return;
          }
          writeOut(
            formatVaultValueStatus(
              result as ReturnType<FileVaultStore["getStatus"]>,
              Boolean(options.json),
            ),
          );
          return;
        }
        const result = await withControlPlaneSecurity(io, async (store) => {
          if (options.show) {
            return { key: name, value: await store.revealValue(name) };
          }
          return store.getStatus(name);
        });
        if (options.show) {
          const value = "value" in result ? result.value : "";
          writeOut(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${value}\n`);
          return;
        }
        writeOut(
          formatVaultValueStatus(
            result as Awaited<ReturnType<ControlPlaneSecurityRepository["getStatus"]>>,
            Boolean(options.json),
          ),
        );
      },
    );

  vault
    .command("list")
    .description("List local/global Vault keys without revealing values.")
    .option("-g, --global", "target the local/global Vault")
    .option("--remote", "target the selected remote Vault")
    .option("--json", "print JSON output")
    .action(async (options: VaultTargetOptions & { json?: boolean }) => {
      const target = resolveMutationTarget(options, {
        allowedTargets: ["global", "remote"],
        defaultTarget: "global",
      });
      if (target === "remote") {
        const result = await remoteVaultList(io);
        writeOut(
          formatVaultValueList(
            result as ReturnType<FileVaultStore["listValues"]>,
            Boolean(options.json),
          ),
        );
        return;
      }
      const result = await withControlPlaneSecurity(io, (store) => store.listValues());
      writeOut(formatVaultValueList(result, Boolean(options.json)));
    });

  vault
    .command("delete")
    .description("Delete a local/global Vault value without revealing it.")
    .argument("<name>", "Vault key name")
    .option("-g, --global", "target the local/global Vault")
    .option("--remote", "target the selected remote Vault")
    .option("--json", "print JSON output")
    .action(async (name: string, options: VaultTargetOptions & { json?: boolean }) => {
      const target = resolveMutationTarget(options, {
        allowedTargets: ["global", "remote"],
        defaultTarget: "global",
      });
      if (target === "remote") {
        const result = await remoteVaultDelete(io, name);
        writeOut(
          formatVaultDeleteStatus(
            result as ReturnType<FileVaultStore["delete"]>,
            Boolean(options.json),
          ),
        );
        return;
      }
      const result = await withControlPlaneSecurity(io, (store) => store.deleteValue(name));
      writeOut(formatVaultDeleteStatus(result, Boolean(options.json)));
    });

  const vaultAccess = vault.command("access").description("Manage Vault access grants.");

  vaultAccess
    .command("grant")
    .description("Grant a Vault key to a configured Caplet.")
    .argument("<name>", "stored Vault key name")
    .argument("<capletId>", "configured Caplet ID")
    .option("-g, --global", "target the local/global Vault")
    .option("--remote", "target the selected remote Vault")
    .option("--as <referenceName>", "reference name the Caplet uses in config")
    .option("--json", "print JSON output")
    .action(
      async (
        name: string,
        capletId: string,
        options: VaultTargetOptions & { as?: string; json?: boolean },
      ) => {
        const target = resolveMutationTarget(options, {
          allowedTargets: ["global", "remote"],
          defaultTarget: "global",
        });
        if (target === "remote") {
          const grant = await remoteVaultAccessGrant(io, {
            name,
            capletId,
            referenceName: options.as ?? name,
          });
          writeOut(
            formatVaultAccessGrant(
              grant as ReturnType<FileVaultStore["grantAccess"]>,
              Boolean(options.json),
            ),
          );
          return;
        }
        const grant = await withControlPlaneSecurity(io, (store, engine) =>
          store.grantAccess({
            storedKey: name,
            referenceName: options.as ?? name,
            capletId,
            origin: resolveVaultAccessOrigin(capletId, requireActivatedConfigWithSources(engine)),
          }),
        );
        writeOut(formatVaultAccessGrant(grant, Boolean(options.json)));
      },
    );

  vaultAccess
    .command("list")
    .description("List Vault access grants without revealing values.")
    .argument("[name]", "optional stored Vault key name")
    .argument("[capletId]", "optional configured Caplet ID")
    .option("-g, --global", "target the local/global Vault")
    .option("--remote", "target the selected remote Vault")
    .option("--caplet <capletId>", "filter by configured Caplet ID")
    .option("--json", "print JSON output")
    .action(
      async (
        name: string | undefined,
        capletId: string | undefined,
        options: VaultTargetOptions & { caplet?: string; json?: boolean },
      ) => {
        if (options.caplet && capletId && options.caplet !== capletId) {
          throw new CapletsError(
            "REQUEST_INVALID",
            "Use either positional capletId or --caplet, not both.",
          );
        }
        const capletFilter = options.caplet ?? capletId;
        const target = resolveMutationTarget(options, {
          allowedTargets: ["global", "remote"],
          defaultTarget: "global",
        });
        if (target === "remote") {
          const grants = await remoteVaultAccessList(io, {
            ...(name ? { name } : {}),
            ...(capletFilter ? { capletId: capletFilter } : {}),
          });
          writeOut(
            formatVaultAccessList(
              grants as ReturnType<FileVaultStore["listAccess"]>,
              Boolean(options.json),
            ),
          );
          return;
        }
        const grants = await withControlPlaneSecurity(io, (store) =>
          store.listAccess(vaultAccessFilter(name, capletFilter)),
        );
        writeOut(formatVaultAccessList(grants, Boolean(options.json)));
      },
    );

  vaultAccess
    .command("revoke")
    .description("Revoke Vault access grants.")
    .argument("<name>", "stored Vault key name")
    .argument("<capletId>", "configured Caplet ID")
    .option("-g, --global", "target the local/global Vault")
    .option("--remote", "target the selected remote Vault")
    .option("--as <referenceName>", "reference name the Caplet uses in config")
    .option("--json", "print JSON output")
    .action(
      async (
        name: string,
        capletId: string,
        options: VaultTargetOptions & { as?: string; json?: boolean },
      ) => {
        const target = resolveMutationTarget(options, {
          allowedTargets: ["global", "remote"],
          defaultTarget: "global",
        });
        if (target === "remote") {
          const revoked = await remoteVaultAccessRevoke(io, {
            name,
            capletId,
            ...(options.as ? { referenceName: options.as } : {}),
          });
          writeOut(
            formatVaultAccessRevoke(
              Array.isArray(revoked) ? revoked.length : 0,
              Boolean(options.json),
            ),
          );
          return;
        }
        const filter = vaultAccessFilter(name, capletId, options.as);
        const revoked = await withControlPlaneSecurity(io, (store) => store.revokeAccess(filter));
        writeOut(formatVaultAccessRevoke(revoked.length, Boolean(options.json)));
      },
    );

  program
    .command(cliCommands.list)
    .description("List configured Caplets.")
    .option("--all", "include disabled Caplets")
    .option("--json", "print JSON output")
    .option("--format <format>", "output format: plain, markdown, md, or json", parseOutputFormat)
    .action(async (options: { all?: boolean; json?: boolean; format?: CliOutputFormat }) => {
      const includeDisabled = Boolean(options.all);
      const remote = remoteClientForCli(io);
      if (remote) {
        const remoteRows = (await remote.request("list", { includeDisabled })) as CapletListRow[];
        const localOverlay = tryLoadLocalOverlayForCli(io, writeErr);
        const rows = mergeRemoteAndLocalRows(remoteRows, localOverlay, {
          includeDisabled,
          writeErr,
        });
        if (options.json || options.format === "json") {
          writeOut(`${JSON.stringify(rows, null, 2)}\n`);
          return;
        }
        writeOut(formatCapletList(rows, options.format ?? "plain"));
        return;
      }
      const config = loadConfigWithSources(currentConfigPath(), envProjectConfigPath(env), {
        vaultResolver: vaultBootstrapResolver,
      });
      const rows = listCaplets(config, { includeDisabled });
      if (options.json || options.format === "json") {
        writeOut(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      writeOut(formatCapletList(rows, options.format ?? "plain"));
    });

  program
    .command(cliCommands.install)
    .description("Install Caplets from a repo's caplets directory or restore from a lockfile.")
    .argument("[repo]", "local repo path, Git URL, or GitHub owner/repo")
    .argument("[caplets...]", "optional Caplet IDs to install")
    .option("--project", "install to the project Caplets root")
    .option("-g, --global", "install to the user Caplets root")
    .option("--remote", "install through remote control")
    .option("--force", "overwrite installed Caplets")
    .option("--json", "print JSON output")
    .action(
      async (
        repo: string | undefined,
        capletIds: string[],
        options: MutationTargetOptions & { force?: boolean; json?: boolean },
      ) => {
        const target = resolveMutationTarget(options);
        printTelemetryNotice("cli");
        const localLockfilePath =
          target === "remote"
            ? undefined
            : target === "global"
              ? defaultCapletsLockfilePath(env)
              : resolveProjectLockfilePath(process.cwd());
        const installSource =
          repo &&
          isInstallSourceArgument(repo, {
            allowImplicitLocalPath: target !== "remote",
            lockfilePath: localLockfilePath,
          })
            ? repo
            : undefined;
        const selectedCapletIds = repo && !installSource ? [repo, ...capletIds] : capletIds;
        if (target === "remote") {
          const remote = requireRemoteClientForTarget(io);
          const result = (await remote.request("install", {
            ...(installSource ? { repo: installSource } : {}),
            capletIds: selectedCapletIds,
            force: Boolean(options.force),
            ...(catalogIndexingDisabled(env) ? { disableCatalogIndexing: true } : {}),
          })) as {
            installed: Array<{
              id: string;
              destination: string;
              status?:
                | "installed"
                | "restored"
                | "updated"
                | "content_updated"
                | "noop"
                | undefined;
              catalogIndexing?: CatalogIndexingResult | undefined;
            }>;
          };
          if (options.json) {
            writeOut(`${JSON.stringify(installJsonResult(result.installed, target), null, 2)}\n`);
            return;
          }
          for (const caplet of result.installed) {
            const action = installStatusLabel(caplet.status, "Installed");
            writeOut(`${action} ${caplet.id} to remote ${caplet.destination}\n`);
            writeCatalogIndexingNotice(caplet.catalogIndexing, writeOut);
          }
          return;
        }
        const destinationRoot =
          target === "global"
            ? resolveCapletsRoot(resolveConfigPath(currentConfigPath()))
            : envProjectCapletsRoot(env);
        const lockfilePath = localLockfilePath ?? resolveProjectLockfilePath(process.cwd());
        if (!installSource) {
          const result = restoreCapletsFromLockfile({
            capletIds: selectedCapletIds,
            force: Boolean(options.force),
            destinationRoot,
            lockfilePath,
          });
          await attachCatalogIndexingResults(result.installed, env);
          attachVaultSetupResults(result.installed, io);
          if (options.json) {
            writeOut(`${JSON.stringify(installJsonResult(result.installed, target), null, 2)}\n`);
            return;
          }
          for (const caplet of result.installed) {
            writeOut(
              `${installStatusLabel(caplet.status, "Restored")} ${caplet.id} to ${localMutationTargetLabel(target)}${caplet.destination}\n`,
            );
            writeCatalogIndexingNotice(caplet.catalogIndexing, writeOut);
            writeVaultSetupNotice(caplet.vaultSetup, writeOut);
          }
          return;
        }
        const result = installCaplets(installSource, {
          capletIds: selectedCapletIds,
          force: Boolean(options.force),
          destinationRoot,
          lockfilePath,
        });
        await attachCatalogIndexingResults(result.installed, env);
        attachVaultSetupResults(result.installed, io);
        if (options.json) {
          writeOut(`${JSON.stringify(installJsonResult(result.installed, target), null, 2)}\n`);
          return;
        }
        for (const caplet of result.installed) {
          writeOut(
            `Installed ${caplet.id} to ${localMutationTargetLabel(target)}${caplet.destination}\n`,
          );
          writeCatalogIndexingNotice(caplet.catalogIndexing, writeOut);
          writeVaultSetupNotice(caplet.vaultSetup, writeOut);
        }
      },
    );

  program
    .command(cliCommands.update)
    .description("Update installed Caplets from the selected lockfile.")
    .argument("[caplets...]", "optional Caplet IDs to update")
    .option("--project", "update the project Caplets root")
    .option("-g, --global", "update the user Caplets root")
    .option("--remote", "update through remote control")
    .option("--force", "replace local modifications and risk-increasing changes")
    .option("--json", "print JSON output")
    .action(
      async (
        capletIds: string[],
        options: MutationTargetOptions & { force?: boolean; json?: boolean },
      ) => {
        const target = resolveMutationTarget(options);
        printTelemetryNotice("cli");
        if (target === "remote") {
          const remote = requireRemoteClientForTarget(io);
          const result = (await remote.request("update", {
            capletIds,
            force: Boolean(options.force),
            allowRiskIncrease: Boolean(options.force),
            ...(catalogIndexingDisabled(env) ? { disableCatalogIndexing: true } : {}),
          })) as {
            installed: Array<{
              id: string;
              destination: string;
              status?: string;
              catalogIndexing?: CatalogIndexingResult | undefined;
            }>;
          };
          if (options.json) {
            writeOut(`${JSON.stringify(installJsonResult(result.installed, target), null, 2)}\n`);
            return;
          }
          for (const caplet of result.installed) {
            writeOut(
              `${updateStatusLabel(caplet.status)} ${caplet.id} at remote ${caplet.destination}\n`,
            );
            writeCatalogIndexingNotice(caplet.catalogIndexing, writeOut);
          }
          return;
        }
        const destinationRoot =
          target === "global"
            ? resolveCapletsRoot(resolveConfigPath(currentConfigPath()))
            : envProjectCapletsRoot(env);
        const lockfilePath =
          target === "global"
            ? defaultCapletsLockfilePath(env)
            : resolveProjectLockfilePath(process.cwd());
        const result = updateCapletsFromLockfile({
          capletIds,
          force: Boolean(options.force),
          allowRiskIncrease: Boolean(options.force),
          destinationRoot,
          lockfilePath,
        });
        await attachCatalogIndexingResults(result.installed, env);
        attachVaultSetupResults(result.installed, io);
        if (options.json) {
          writeOut(`${JSON.stringify(installJsonResult(result.installed, target), null, 2)}\n`);
          return;
        }
        for (const caplet of result.installed) {
          writeOut(
            `${updateStatusLabel(caplet.status)} ${caplet.id} at ${localMutationTargetLabel(target)}${caplet.destination}\n`,
          );
          writeCatalogIndexingNotice(caplet.catalogIndexing, writeOut);
          writeVaultSetupNotice(caplet.vaultSetup, writeOut);
        }
      },
    );

  const add = program.command(cliCommands.add).description("Add generated Caplet files.");

  add
    .command("cli")
    .description("Add a CLI tools Caplet.")
    .argument("<id>", "Caplet ID/display seed")
    .option("--repo <path>", "repository path to inspect")
    .option("--include <items>", "comma-separated generators to include: git,gh,package")
    .option("--command <name>", "single CLI command template to generate")
    .option("--project", "write to the project Caplets root")
    .option("-g, --global", "write to the user Caplets root")
    .option("--remote", "add through remote control")
    .option("--print", "print generated Caplet text without writing a file")
    .option("--output <path>", "output path")
    .option("--force", "overwrite an existing destination file")
    .action(
      async (
        id: string,
        options: {
          repo?: string;
          include?: string;
          command?: string;
          global?: boolean;
          print?: boolean;
          output?: string;
          force?: boolean;
          project?: boolean;
          remote?: boolean;
        },
      ) => {
        const target = resolveMutationTarget(options);
        if (target === "remote") {
          const remote = requireRemoteClientForTarget(io);
          const result = await remote.request("add", {
            kind: "cli",
            id,
            options: remoteAddOptions(options),
          });
          writeAddResult(writeOut, "CLI", result as AddCliResult);
          return;
        }
        const result = addCliCaplet(id, {
          ...options,
          destinationRoot:
            target === "global"
              ? resolveCapletsRoot(resolveConfigPath(currentConfigPath()))
              : envProjectCapletsRoot(env),
        });
        if (result.path) {
          writeOut(`Wrote ${localMutationTargetLabel(target)}CLI Caplet to ${result.path}\n`);
          return;
        }
        writeOut(result.text);
      },
    );

  add
    .command("mcp")
    .description("Add an MCP backend Caplet.")
    .argument("<id>", "Caplet ID/display seed")
    .option("--command <name>", "stdio command")
    .option("--arg <value>", "stdio command argument", collect, [])
    .option("--cwd <path>", "stdio working directory")
    .option("--env <KEY=VALUE>", "stdio environment variable", collect, [])
    .option("--url <url>", "remote MCP server URL")
    .option("--transport <transport>", "remote transport: http or sse")
    .option("--token-env <ENV>", "bearer token environment variable reference")
    .option("--project", "write to the project Caplets root")
    .option("-g, --global", "write to the user Caplets root")
    .option("--remote", "add through remote control")
    .option("--print", "print generated Caplet text without writing a file")
    .option("--output <path>", "output path")
    .option("--force", "overwrite an existing destination file")
    .action(
      async (
        id: string,
        options: AddBackendCliOptions & {
          command?: string;
          arg?: string[];
          cwd?: string;
          env?: string[];
          url?: string;
          transport?: string;
          tokenEnv?: string;
        },
      ) => {
        const target = resolveMutationTarget(options);
        if (target === "remote") {
          const remote = requireRemoteClientForTarget(io);
          const result = await remote.request("add", {
            kind: "mcp",
            id,
            options: remoteAddOptions(options),
          });
          writeAddResult(writeOut, "MCP", result as AddCliResult);
          return;
        }
        const result = addMcpCaplet(id, {
          ...options,
          destinationRoot: addDestinationRoot(target, currentConfigPath(), env),
        });
        writeAddResult(writeOut, `${localMutationTargetLabel(target)}MCP`, result);
      },
    );

  add
    .command("openapi")
    .description("Add an OpenAPI backend Caplet.")
    .argument("<id>", "Caplet ID/display seed")
    .option("--spec <path-or-url>", "OpenAPI spec path or URL")
    .option("--base-url <url>", "request base URL override")
    .option("--token-env <ENV>", "bearer token environment variable reference")
    .option("--project", "write to the project Caplets root")
    .option("-g, --global", "write to the user Caplets root")
    .option("--remote", "add through remote control")
    .option("--print", "print generated Caplet text without writing a file")
    .option("--output <path>", "output path")
    .option("--force", "overwrite an existing destination file")
    .action(
      async (
        id: string,
        options: AddBackendCliOptions & { spec?: string; baseUrl?: string; tokenEnv?: string },
      ) => {
        const target = resolveMutationTarget(options);
        if (target === "remote") {
          const remote = requireRemoteClientForTarget(io);
          const result = await remote.request("add", {
            kind: "openapi",
            id,
            options: remoteAddOptions(options),
          });
          writeAddResult(writeOut, "OpenAPI", result as AddCliResult);
          return;
        }
        const result = addOpenApiCaplet(id, {
          ...options,
          destinationRoot: addDestinationRoot(target, currentConfigPath(), env),
        });
        writeAddResult(writeOut, `${localMutationTargetLabel(target)}OpenAPI`, result);
      },
    );

  add
    .command("google-discovery")
    .description("Add a Google Discovery API backend Caplet.")
    .argument("<id>", "Caplet ID/display seed")
    .option("--discovery <path-or-url>", "Google Discovery document path or URL")
    .option("--discovery-url <url>", "remote Google Discovery document URL")
    .option("--base-url <url>", "request base URL override")
    .option("--token-env <ENV>", "bearer token environment variable reference")
    .option("--project", "write to the project Caplets root")
    .option("-g, --global", "write to the user Caplets root")
    .option("--remote", "add through remote control")
    .option("--print", "print generated Caplet text without writing a file")
    .option("--output <path>", "output path")
    .option("--force", "overwrite an existing destination file")
    .action(
      async (
        id: string,
        options: AddBackendCliOptions & {
          discovery?: string;
          discoveryUrl?: string;
          baseUrl?: string;
          tokenEnv?: string;
        },
      ) => {
        const target = resolveMutationTarget(options);
        if (target === "remote") {
          const remote = requireRemoteClientForTarget(io);
          const result = await remote.request("add", {
            kind: "googleDiscovery",
            id,
            options: remoteAddOptions(options),
          });
          writeAddResult(writeOut, "Google Discovery", result as AddCliResult);
          return;
        }
        const result = addGoogleDiscoveryCaplet(id, {
          ...options,
          destinationRoot: addDestinationRoot(target, currentConfigPath(), env),
        });
        writeAddResult(writeOut, `${localMutationTargetLabel(target)}Google Discovery`, result);
      },
    );

  add
    .command("graphql")
    .description("Add a GraphQL backend Caplet.")
    .argument("<id>", "Caplet ID/display seed")
    .option("--endpoint-url <url>", "GraphQL endpoint URL")
    .option("--schema <path-or-url>", "GraphQL schema path or URL")
    .option("--introspection", "load schema through endpoint introspection")
    .option("--token-env <ENV>", "bearer token environment variable reference")
    .option("--project", "write to the project Caplets root")
    .option("-g, --global", "write to the user Caplets root")
    .option("--remote", "add through remote control")
    .option("--print", "print generated Caplet text without writing a file")
    .option("--output <path>", "output path")
    .option("--force", "overwrite an existing destination file")
    .action(
      async (
        id: string,
        options: AddBackendCliOptions & {
          endpointUrl?: string;
          schema?: string;
          introspection?: boolean;
          tokenEnv?: string;
        },
      ) => {
        const target = resolveMutationTarget(options);
        if (target === "remote") {
          const remote = requireRemoteClientForTarget(io);
          const result = await remote.request("add", {
            kind: "graphql",
            id,
            options: remoteAddOptions(options),
          });
          writeAddResult(writeOut, "GraphQL", result as AddCliResult);
          return;
        }
        const result = addGraphqlCaplet(id, {
          ...options,
          destinationRoot: addDestinationRoot(target, currentConfigPath(), env),
        });
        writeAddResult(writeOut, `${localMutationTargetLabel(target)}GraphQL`, result);
      },
    );

  add
    .command("http")
    .description("Add an HTTP actions backend Caplet.")
    .argument("<id>", "Caplet ID/display seed")
    .option("--base-url <url>", "HTTP API base URL")
    .option("--action <name:METHOD:/path>", "HTTP action", collect, [])
    .option("--token-env <ENV>", "bearer token environment variable reference")
    .option("--project", "write to the project Caplets root")
    .option("-g, --global", "write to the user Caplets root")
    .option("--remote", "add through remote control")
    .option("--print", "print generated Caplet text without writing a file")
    .option("--output <path>", "output path")
    .option("--force", "overwrite an existing destination file")
    .action(
      async (
        id: string,
        options: AddBackendCliOptions & { baseUrl?: string; action?: string[]; tokenEnv?: string },
      ) => {
        const target = resolveMutationTarget(options);
        if (target === "remote") {
          const remote = requireRemoteClientForTarget(io);
          const result = await remote.request("add", {
            kind: "http",
            id,
            options: remoteAddOptions(options),
          });
          writeAddResult(writeOut, "HTTP", result as AddCliResult);
          return;
        }
        const result = addHttpCaplet(id, {
          ...options,
          destinationRoot: addDestinationRoot(target, currentConfigPath(), env),
        });
        writeAddResult(writeOut, `${localMutationTargetLabel(target)}HTTP`, result);
      },
    );

  program
    .command(cliCommands.inspect)
    .description("Print a configured Caplet card.")
    .argument("<caplet>", "configured Caplet ID")
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(async (caplet: string, options: { format?: CliOutputFormat }) => {
      await executeOperation(caplet, { operation: "inspect" }, executeOperationIo(options.format));
    });

  program
    .command(cliCommands.checkBackend)
    .description("Check backend availability for a configured Caplet.")
    .argument("<caplet>", "configured Caplet ID")
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(async (caplet: string, options: { format?: CliOutputFormat }) => {
      await executeOperation(caplet, { operation: "check" }, executeOperationIo(options.format));
    });

  program
    .command(cliCommands.listTools)
    .description("List downstream tools for a configured Caplet.")
    .argument("<caplet>", "configured Caplet ID")
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(async (caplet: string, options: { format?: CliOutputFormat }) => {
      await executeOperation(caplet, { operation: "tools" }, executeOperationIo(options.format));
    });

  program
    .command(cliCommands.searchTools)
    .description("Search downstream tools for a configured Caplet.")
    .argument("<caplet>", "configured Caplet ID")
    .argument("<query>", "search query")
    .option("--limit <n>", "maximum number of tools to return", parsePositiveInteger)
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(
      async (
        caplet: string,
        query: string,
        options: { limit?: number; format?: CliOutputFormat },
      ) => {
        await executeOperation(
          caplet,
          options.limit === undefined
            ? { operation: "search_tools", query }
            : { operation: "search_tools", query, limit: options.limit },
          executeOperationIo(options.format),
        );
      },
    );

  program
    .command(cliCommands.getTool)
    .description("Print one downstream tool schema.")
    .argument("<caplet-or-target>", "Caplet ID or qualified <caplet.tool> target")
    .argument("[tool]", "downstream tool name when caplet is provided separately")
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(
      async (
        capletOrTarget: string,
        toolArgument: string | undefined,
        options: { format?: CliOutputFormat },
      ) => {
        const { caplet, tool } = parseQualifiedTarget(capletOrTarget, toolArgument);
        await executeOperation(
          caplet,
          { operation: "describe_tool", name: tool },
          executeOperationIo(options.format),
        );
      },
    );

  program
    .command(cliCommands.callTool)
    .description("Call one downstream tool.")
    .argument("<caplet-or-target>", "Caplet ID or qualified <caplet.tool> target")
    .argument("[tool]", "downstream tool name when caplet is provided separately")
    .option("--args <json-object>", "JSON object of downstream tool arguments")
    .option("--field <path>", "project a field from structured output", collect, [])
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(
      async (
        capletOrTarget: string,
        toolArgument: string | undefined,
        options: { args?: string; field?: string[]; format?: CliOutputFormat },
      ) => {
        const { caplet, tool } = parseQualifiedTarget(capletOrTarget, toolArgument);
        const request = {
          operation: "call_tool",
          name: tool,
          args: parseCallToolArgs(options.args),
          ...(options.field && options.field.length > 0 ? { fields: options.field } : {}),
        };
        await executeOperation(caplet, request, executeOperationIo(options.format));
      },
    );

  program
    .command(cliCommands.listResources)
    .description("List MCP resources for a configured MCP Caplet.")
    .argument("<caplet>")
    .option("--limit <n>", "maximum number of resources to return", parsePositiveInteger)
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(async (caplet: string, options: { limit?: number; format?: CliOutputFormat }) =>
      executeOperation(
        caplet,
        options.limit === undefined
          ? { operation: "resources" }
          : { operation: "resources", limit: options.limit },
        executeOperationIo(options.format),
      ),
    );
  program
    .command(cliCommands.searchResources)
    .description("Search MCP resources and resource templates for a configured MCP Caplet.")
    .argument("<caplet>")
    .argument("<query>")
    .option("--limit <n>", "maximum number of matches to return", parsePositiveInteger)
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(
      async (
        caplet: string,
        query: string,
        options: { limit?: number; format?: CliOutputFormat },
      ) =>
        executeOperation(
          caplet,
          options.limit === undefined
            ? { operation: "search_resources", query }
            : { operation: "search_resources", query, limit: options.limit },
          executeOperationIo(options.format),
        ),
    );
  program
    .command(cliCommands.listResourceTemplates)
    .description("List MCP resource templates for a configured MCP Caplet.")
    .argument("<caplet>")
    .option("--limit <n>", "maximum number of templates to return", parsePositiveInteger)
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(async (caplet: string, options: { limit?: number; format?: CliOutputFormat }) =>
      executeOperation(
        caplet,
        options.limit === undefined
          ? { operation: "resource_templates" }
          : { operation: "resource_templates", limit: options.limit },
        executeOperationIo(options.format),
      ),
    );
  program
    .command(cliCommands.readResource)
    .description("Read one MCP resource by URI.")
    .argument("<caplet>")
    .argument("<uri>")
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(async (caplet: string, uri: string, options: { format?: CliOutputFormat }) =>
      executeOperation(
        caplet,
        { operation: "read_resource", uri },
        executeOperationIo(options.format),
      ),
    );
  program
    .command(cliCommands.listPrompts)
    .description("List MCP prompts for a configured MCP Caplet.")
    .argument("<caplet>")
    .option("--limit <n>", "maximum number of prompts to return", parsePositiveInteger)
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(async (caplet: string, options: { limit?: number; format?: CliOutputFormat }) =>
      executeOperation(
        caplet,
        options.limit === undefined
          ? { operation: "prompts" }
          : { operation: "prompts", limit: options.limit },
        executeOperationIo(options.format),
      ),
    );
  program
    .command(cliCommands.searchPrompts)
    .description("Search MCP prompts for a configured MCP Caplet.")
    .argument("<caplet>")
    .argument("<query>")
    .option("--limit <n>", "maximum number of prompts to return", parsePositiveInteger)
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(
      async (
        caplet: string,
        query: string,
        options: { limit?: number; format?: CliOutputFormat },
      ) =>
        executeOperation(
          caplet,
          options.limit === undefined
            ? { operation: "search_prompts", query }
            : { operation: "search_prompts", query, limit: options.limit },
          executeOperationIo(options.format),
        ),
    );
  program
    .command(cliCommands.getPrompt)
    .description("Get one MCP prompt by name.")
    .argument("<caplet-or-target>", "MCP Caplet ID or qualified <caplet.prompt> target")
    .argument("[prompt]", "prompt name when caplet is provided separately")
    .option("--args <json-object>", "JSON object of prompt arguments")
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(
      async (
        capletOrTarget: string,
        promptArgument: string | undefined,
        options: { args?: string; format?: CliOutputFormat },
      ) => {
        const { caplet, tool: prompt } = parseQualifiedTarget(capletOrTarget, promptArgument);
        await executeOperation(
          caplet,
          {
            operation: "get_prompt",
            name: prompt,
            args: parseJsonObjectOption(options.args, "get-prompt --args"),
          },
          executeOperationIo(options.format),
        );
      },
    );
  program
    .command(cliCommands.complete)
    .description("Complete an MCP prompt or resource-template argument.")
    .argument("<caplet>")
    .requiredOption("--argument <name>", "argument name")
    .option("--value <value>", "argument prefix", "")
    .option("--prompt <name>", "prompt name to complete")
    .option("--resource-template <uri-template>", "resource template URI to complete")
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(
      async (
        caplet: string,
        options: {
          argument: string;
          value: string;
          prompt?: string;
          resourceTemplate?: string;
          format?: CliOutputFormat;
        },
      ) =>
        executeOperation(
          caplet,
          {
            operation: "complete",
            ref: completionRefFromOptions(options),
            argument: { name: options.argument, value: options.value },
          },
          executeOperationIo(options.format),
        ),
    );

  const config = program
    .command(cliCommands.config)
    .description("Inspect Caplets config locations.");

  config
    .command("path")
    .description("Print the effective user config path.")
    .action(() => {
      writeOut(`${resolveConfigPath(currentConfigPath())}\n`);
    });

  config
    .command("paths")
    .description("Print resolved Caplets config, root, and auth paths.")
    .option("--json", "print JSON output")
    .option("--format <format>", "output format: plain, markdown, md, or json", parseOutputFormat)
    .action((options: { json?: boolean; format?: CliOutputFormat }) => {
      const paths = resolveCliConfigPaths(
        currentConfigPath(),
        envProjectConfigPath(env),
        io.authDir,
      );
      if (options.json || options.format === "json") {
        writeOut(`${JSON.stringify(paths, null, 2)}\n`);
        return;
      }
      writeOut(formatConfigPaths(paths, options.format ?? "plain"));
    });

  const auth = program
    .command(cliCommands.auth)
    .description("Manage OAuth credentials for remote servers.");

  auth
    .command("login")
    .description("Authenticate a configured remote OAuth server.")
    .argument("<server>", "configured server ID")
    .option("--project", "authenticate using the project Caplets config")
    .option("-g, --global", "authenticate using the user Caplets config")
    .option("--remote", "authenticate using the remote server auth store")
    .option("--no-open", "print the authorization URL without opening a browser")
    .action(async (serverId: string, options: AuthTargetOptions & { open?: boolean }) => {
      const target = await resolveAuthTarget(serverId, options, io);
      if (target === "remote") {
        await remoteAuthLogin(
          requireRemoteClientForTarget(io),
          serverId,
          options.open !== false,
          writeOut,
        );
        return;
      }
      await withControlPlaneSecurity(
        io,
        async (security, engine) =>
          loginAuth(serverId, {
            noOpen: options.open === false,
            writeOut,
            writeErr,
            config: engine.currentConfig(),
            tokenRepository: security,
          }),
        "auth",
      );
    });

  auth
    .command("logout")
    .description("Delete stored OAuth credentials for a server.")
    .argument("<server>", "configured server ID")
    .option("--project", "delete credentials for the project Caplets config target")
    .option("-g, --global", "delete credentials for the user Caplets config target")
    .option("--remote", "delete credentials from the remote server auth store")
    .action(async (serverId: string, options: AuthTargetOptions) => {
      const target = await resolveAuthTarget(serverId, options, io);
      if (target === "remote") {
        const remote = requireRemoteClientForTarget(io);
        const result = (await remote.request("auth_logout", { server: serverId })) as {
          deleted: boolean;
        };
        writeOut(
          result.deleted
            ? `Deleted remote OAuth credentials for \`${serverId}\`.\n`
            : `No remote OAuth credentials found for \`${serverId}\`.\n`,
        );
        return;
      }
      await withControlPlaneSecurity(
        io,
        async (security, engine) =>
          logoutAuth(serverId, {
            writeOut,
            config: engine.currentConfig(),
            tokenRepository: security,
          }),
        "auth",
      );
    });

  auth
    .command("refresh")
    .description("Refresh stored OAuth credentials for a server.")
    .argument("<capletId>", "configured OAuth Caplet ID")
    .option("--project", "refresh credentials for the project Caplets config target")
    .option("-g, --global", "refresh credentials for the user Caplets config target")
    .option("--remote", "refresh credentials in the remote server auth store")
    .action(async (serverId: string, options: AuthTargetOptions) => {
      const target = await resolveAuthTarget(serverId, options, io);
      if (target === "remote") {
        const remote = requireRemoteClientForTarget(io);
        await remote.request("auth_refresh", { server: serverId });
        writeOut(`Refreshed remote OAuth credentials for \`${serverId}\`.\n`);
        return;
      }
      await withControlPlaneSecurity(
        io,
        async (security, engine) =>
          refreshAuth(serverId, {
            writeOut,
            config: engine.currentConfig(),
            tokenRepository: security,
          }),
        "auth",
      );
    });

  auth
    .command("list")
    .description("List servers with stored OAuth credentials.")
    .option("--json", "print JSON output")
    .option("--format <format>", "output format: plain, markdown, md, or json", parseOutputFormat)
    .option("--project", "list auth targets from the project Caplets config")
    .option("-g, --global", "list auth targets from the user Caplets config")
    .option("--remote", "list auth targets from the remote server auth store")
    .action(async (options: AuthTargetOptions & { json?: boolean; format?: CliOutputFormat }) => {
      const format =
        options.json || options.format === "json" ? "json" : (options.format ?? "plain");
      const target = parseAuthFlagTarget(options);
      const rows = await authListRowsForCli(target, io);
      if (format === "json") {
        writeOut(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      writeOut(formatAuthRows(rows, format));
    });

  return program;
}

function formatDaemonStatus(status: Awaited<ReturnType<typeof daemonStatus>>): string {
  if (!status.installed) return "Caplets daemon is not installed.\n";
  const lines = [
    `Caplets daemon is ${status.running ? "running" : "stopped"} (${status.nativeState}).`,
  ];
  if (status.health && !status.health.ok) {
    lines.push(
      `Health check failed for ${status.health.url}${status.health.status ? ` with HTTP ${status.health.status}` : ""}${status.health.error ? `: ${status.health.error}` : ""}.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function envConfigPath(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string | undefined {
  return env.CAPLETS_CONFIG?.trim() || undefined;
}

function remoteClientForCli(io: CliIO): RemoteControlClient | undefined {
  const env = io.env ?? process.env;
  if (resolveRemoteMode({}, env).mode !== "remote") {
    return undefined;
  }
  return new RemoteControlClient({
    resolve: async () => {
      const selection = await resolveRemoteSelection(
        {
          mode: "remote",
          ...(io.authDir ? { authDir: io.authDir } : {}),
          ...(io.fetch ? { fetch: io.fetch } : {}),
        },
        env,
      );
      if (selection.kind !== "self_hosted_remote") {
        throw new CapletsError(
          "REQUEST_INVALID",
          "--remote requires CAPLETS_MODE=remote and a self-hosted CAPLETS_REMOTE_URL",
        );
      }
      return {
        baseUrl: selection.remote.baseUrl,
        requestInit: selection.remote.requestInit,
        ...(selection.remote.fetch ? { fetch: selection.remote.fetch } : {}),
      };
    },
  });
}

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { stdio: "ignore", detached: true }).unref();
}

function remoteCommandForOperation(operation: unknown): RemoteCliCommand | undefined {
  switch (operation) {
    case "inspect":
    case "check":
    case "tools":
    case "search_tools":
    case "describe_tool":
    case "call_tool":
    case "resources":
    case "search_resources":
    case "resource_templates":
    case "read_resource":
    case "prompts":
    case "search_prompts":
    case "get_prompt":
    case "complete":
      return operation;
    default:
      return undefined;
  }
}

type AddBackendCliOptions = {
  global?: boolean;
  project?: boolean;
  remote?: boolean;
  print?: boolean;
  output?: string;
  force?: boolean;
};

type MutationTarget = "project" | "global" | "remote";
type AuthTarget = AuthSource;

type MutationTargetOptions = {
  project?: boolean;
  global?: boolean;
  remote?: boolean;
};

type AuthTargetOptions = MutationTargetOptions;

type VaultTargetOptions = {
  global?: boolean;
  remote?: boolean;
};

type VaultRemoteTarget =
  | { kind: "self_hosted"; client: RemoteControlClient }
  | { kind: "cloud"; client: CapletsCloudClient; workspace: string };

type AddCliResult = { path?: string; text: string; remote?: boolean };

function remoteAddOptions<T extends Record<string, unknown>>(
  options: T,
): Omit<T, "global" | "project" | "remote" | "print" | "output" | "destinationRoot"> {
  const { output, print, global, project, remote, destinationRoot, ...remoteOptions } = options;
  if (print) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "--print is not supported in remote mode; the server controls add output.",
    );
  }
  if (output !== undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "--output is not supported in remote mode; the server controls the add destination.",
    );
  }
  void global;
  void project;
  void remote;
  void destinationRoot;
  return remoteOptions;
}

function resolveMutationTarget(options: MutationTargetOptions): MutationTarget;
function resolveMutationTarget<T extends MutationTarget>(
  options: MutationTargetOptions,
  policy: {
    allowedTargets: readonly T[];
    defaultTarget: T;
    requireExplicit?: boolean | undefined;
  },
): T;
function resolveMutationTarget(
  options: MutationTargetOptions,
  policy: {
    allowedTargets: readonly MutationTarget[];
    defaultTarget: MutationTarget;
    requireExplicit?: boolean | undefined;
  } = {
    allowedTargets: ["project", "global", "remote"],
    defaultTarget: "project",
  },
): MutationTarget {
  const selected: Array<{ flag: string; target: MutationTarget }> = [];
  if (options.project) selected.push({ flag: "--project", target: "project" });
  if (options.global) selected.push({ flag: "--global", target: "global" });
  if (options.remote) selected.push({ flag: "--remote", target: "remote" });
  if (selected.length > 1) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Cannot combine mutation target flags: ${selected.map(({ flag }) => flag).join(", ")}`,
    );
  }
  const target = selected[0]?.target ?? policy.defaultTarget;
  if (policy.requireExplicit === true && selected.length === 0) {
    throw new CapletsError("REQUEST_INVALID", "This mutation requires an explicit target.");
  }
  if (!policy.allowedTargets.includes(target)) {
    throw new CapletsError("REQUEST_INVALID", `Mutation target ${target} is not supported.`);
  }
  return target;
}

function isInstallSourceArgument(
  value: string,
  options: { allowImplicitLocalPath?: boolean; lockfilePath?: string | undefined } = {},
): boolean {
  if (isExplicitLocalPath(value)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return true;
  if (/^[^@\s]+@[^:\s]+:.+/.test(value)) return true;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?(?:#[^\s#]+)?$/.test(value)) return true;
  return (
    options.allowImplicitLocalPath !== false &&
    existsSync(value) &&
    !lockfileContainsCapletId(options.lockfilePath, value)
  );
}

function isExplicitLocalPath(value: string): boolean {
  return isAbsolute(value) || /^\.{1,2}(?:[\\/]|$)/.test(value) || /[\\/]/.test(value);
}

function lockfileContainsCapletId(path: string | undefined, capletId: string): boolean {
  if (!path) return false;
  try {
    return readCapletsLockfile(path).entries.some((entry) => entry.id === capletId);
  } catch {
    return false;
  }
}

async function resolveVaultRemoteTarget(io: CliIO): Promise<VaultRemoteTarget> {
  const env = io.env ?? process.env;
  const mode = resolveRemoteMode({}, env).mode;
  if (mode === "remote") {
    return { kind: "self_hosted", client: requireRemoteClientForTarget(io) };
  }
  if (mode !== "cloud") {
    throw new CapletsError(
      "REQUEST_INVALID",
      "--remote requires CAPLETS_MODE=remote or CAPLETS_MODE=cloud and CAPLETS_REMOTE_URL",
    );
  }
  const selection = await resolveRemoteSelection(
    {
      mode: "cloud",
      ...(io.authDir ? { authDir: io.authDir } : {}),
      ...(io.fetch ? { fetch: io.fetch } : {}),
    },
    env,
  );
  if (selection.kind !== "hosted_cloud") {
    throw new CapletsError("REQUEST_INVALID", "--remote Vault target did not resolve to Cloud.");
  }
  return {
    kind: "cloud",
    workspace: selection.selectedWorkspace,
    client: new CapletsCloudClient({
      baseUrl: selection.remote.baseUrl,
      accessToken: selection.credentials.accessToken,
      ...(selection.remote.fetch ? { fetch: selection.remote.fetch } : {}),
    }),
  };
}

async function remoteVaultSet(
  io: CliIO,
  input: {
    name: string;
    value: string;
    force: boolean;
    grant?: string | undefined;
    referenceName?: string | undefined;
  },
): Promise<unknown> {
  const target = await resolveVaultRemoteTarget(io);
  if (target.kind === "self_hosted") return await target.client.request("vault_set", input);
  return await target.client.setVaultValue({ workspace: target.workspace, ...input });
}

async function remoteVaultGet(
  io: CliIO,
  input: { name: string; reveal: boolean },
): Promise<unknown> {
  const target = await resolveVaultRemoteTarget(io);
  if (target.kind === "self_hosted") {
    return await target.client.request("vault_get", {
      name: input.name,
      reveal: input.reveal,
    });
  }
  return await target.client.getVaultValue({
    workspace: target.workspace,
    name: input.name,
    reveal: input.reveal,
  });
}

async function remoteVaultList(io: CliIO): Promise<unknown> {
  const target = await resolveVaultRemoteTarget(io);
  if (target.kind === "self_hosted") return await target.client.request("vault_list", {});
  return await target.client.listVaultValues({ workspace: target.workspace });
}

async function remoteVaultDelete(io: CliIO, name: string): Promise<unknown> {
  const target = await resolveVaultRemoteTarget(io);
  if (target.kind === "self_hosted") return await target.client.request("vault_delete", { name });
  return await target.client.deleteVaultValue({ workspace: target.workspace, name });
}

async function remoteVaultAccessGrant(
  io: CliIO,
  input: { name: string; capletId: string; referenceName: string },
): Promise<unknown> {
  const target = await resolveVaultRemoteTarget(io);
  if (target.kind === "self_hosted")
    return await target.client.request("vault_access_grant", input);
  return await target.client.grantVaultAccess({ workspace: target.workspace, ...input });
}

async function remoteVaultAccessList(
  io: CliIO,
  input: { name?: string | undefined; capletId?: string | undefined },
): Promise<unknown> {
  const target = await resolveVaultRemoteTarget(io);
  if (target.kind === "self_hosted") {
    return await target.client.request("vault_access_list", input);
  }
  return await target.client.listVaultAccess({ workspace: target.workspace, ...input });
}

async function remoteVaultAccessRevoke(
  io: CliIO,
  input: { name: string; capletId: string; referenceName?: string | undefined },
): Promise<unknown> {
  const target = await resolveVaultRemoteTarget(io);
  if (target.kind === "self_hosted") {
    return await target.client.request("vault_access_revoke", input);
  }
  return await target.client.revokeVaultAccess({ workspace: target.workspace, ...input });
}

async function readVaultValue(io: CliIO): Promise<string> {
  let value: string;
  if (io.readStdin) {
    value = stripOneTrailingNewline(await io.readStdin());
  } else if (!process.stdin.isTTY && !io.writeOut && !io.writeErr) {
    value = stripOneTrailingNewline(await readAllStdin());
  } else if (io.writeOut || io.writeErr || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Vault value input is required. Run interactively or provide stdin.",
    );
  } else {
    value = await readHiddenInput(HIDDEN_INPUT_PROMPT_LABELS.vaultValue);
  }
  if (value.length === 0) {
    throw new CapletsError("REQUEST_INVALID", "Vault value input is required.");
  }
  return value;
}

function stripOneTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/u, "");
}

function assertVaultTransportValueSize(value: string): void {
  if (Buffer.byteLength(value, "utf8") > VAULT_MAX_VALUE_BYTES) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Vault values must be ${VAULT_MAX_VALUE_BYTES} bytes or smaller.`,
    );
  }
}

function resolveVaultAccessOrigin(capletId: string, config: ConfigWithSources): ConfigSource {
  const shadows = config.declaredShadows?.[capletId] ?? config.shadows[capletId];
  if (shadows?.length) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Caplet ${capletId} is shadowed in multiple config sources; resolve the active config before granting Vault access.`,
    );
  }
  const origin = config.declaredSources?.[capletId] ?? config.sources[capletId];
  if (!origin) {
    throw new CapletsError("SERVER_NOT_FOUND", `Caplet ${capletId} is not configured.`);
  }
  return origin;
}

function vaultAccessFilter(
  storedKey?: string,
  capletId?: string,
  referenceName?: string,
): VaultAccessGrantFilter {
  return {
    ...(storedKey ? { storedKey: validateVaultKeyName(storedKey) } : {}),
    ...(capletId ? { capletId } : {}),
    ...(referenceName ? { referenceName: validateVaultKeyName(referenceName) } : {}),
  };
}

function localMutationTargetLabel(target: Exclude<MutationTarget, "remote">): string {
  return `${target} `;
}

function installJsonResult(
  installed: Array<{
    id: string;
    destination: string;
    status?: string | undefined;
    hash?: string | undefined;
    lockfile?: string | undefined;
    source?: string | undefined;
    catalogIndexing?: CatalogIndexingResult | undefined;
    vaultSetup?: unknown;
  }>,
  target: MutationTarget,
) {
  return {
    target,
    entries: installed.map((entry) => ({
      id: entry.id,
      status: entry.status ?? "installed",
      destination: entry.destination,
      ...(entry.lockfile ? { lockfile: entry.lockfile } : {}),
      ...(entry.hash ? { hash: entry.hash } : {}),
      ...(entry.source ? { source: entry.source } : {}),
      ...(entry.catalogIndexing ? { catalogIndexing: entry.catalogIndexing } : {}),
      ...(entry.vaultSetup ? { vaultSetup: entry.vaultSetup } : {}),
    })),
  };
}

type VaultSetupStatus = {
  status: "ready" | "unresolved" | "unknown";
  recoveryCommands: string[];
  messages: string[];
};

async function attachCatalogIndexingResults(
  installed: Array<{
    id: string;
    lockfile?: string | undefined;
    catalogIndexing?: CatalogIndexingResult | undefined;
  }>,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Promise<void> {
  try {
    const results = await indexInstalledCapletsFromLockfile(installed, {
      disableCatalogIndexing: catalogIndexingDisabled(env),
    });
    for (const entry of installed) {
      entry.catalogIndexing = results.get(entry.id);
    }
  } catch {
    for (const entry of installed) {
      entry.catalogIndexing = { status: "unavailable", reason: "indexer_unavailable" };
    }
  }
}

function catalogIndexingDisabled(env: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  return env.CAPLETS_DISABLE_CATALOG_INDEXING === "1";
}

function writeCatalogIndexingNotice(
  result: CatalogIndexingResult | undefined,
  writeOut: (value: string) => void,
): void {
  if (!result) return;
  if (result.status === "accepted" || result.status === "counted") {
    writeOut(
      "Catalog indexing: public Caplet source and content metadata may appear on catalog.caplets.dev.\n",
    );
  } else if (result.status === "unavailable") {
    writeOut("Catalog indexing: skipped because the catalog indexer was unavailable.\n");
  }
}

function attachVaultSetupResults(
  installed: Array<{ id: string; vaultSetup?: unknown }>,
  io: CliIO,
): void {
  const statuses = vaultSetupStatusesForInstalled(
    installed.map((entry) => entry.id),
    io,
  );
  for (const entry of installed) {
    entry.vaultSetup = statuses.get(entry.id);
  }
}

function vaultSetupStatusesForInstalled(ids: string[], io: CliIO): Map<string, VaultSetupStatus> {
  const statuses = new Map<string, VaultSetupStatus>(
    ids.map((id) => [id, { status: "ready", recoveryCommands: [], messages: [] }]),
  );
  try {
    const env = io.env ?? process.env;
    const configPath = resolveConfigPath(envConfigPath(env));
    const projectConfigPath = envProjectConfigPath(env);
    const result = loadLocalOverlayConfigWithSources(configPath, projectConfigPath);
    if (
      result.warnings.some((warning) => warning.type === undefined && warning.recoverable !== true)
    ) {
      for (const status of statuses.values()) {
        status.status = "unknown";
      }
      return statuses;
    }
    for (const warning of result.warnings) {
      if (warning.type !== "vault-quarantine" || !statuses.has(warning.capletId)) continue;
      const status = statuses.get(warning.capletId);
      if (!status) continue;
      status.status = "unresolved";
      status.messages.push(warning.message);
      const command = formatVaultRecoveryCommand(warning);
      if (!status.recoveryCommands.includes(command)) {
        status.recoveryCommands.push(command);
      }
    }
  } catch {
    for (const status of statuses.values()) {
      status.status = "unknown";
    }
  }
  return statuses;
}

function writeVaultSetupNotice(result: unknown, writeOut: (value: string) => void): void {
  if (!isVaultSetupStatus(result) || result.status !== "unresolved") return;
  for (const command of result.recoveryCommands) {
    writeOut(`Vault setup: run \`${command}\`.\n`);
  }
}

function isVaultSetupStatus(value: unknown): value is VaultSetupStatus {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    Array.isArray((value as { recoveryCommands?: unknown }).recoveryCommands)
  );
}

function parseAuthFlagTarget(options: AuthTargetOptions): AuthTarget | undefined {
  const selected = [
    options.project ? "--project" : undefined,
    options.global ? "--global" : undefined,
    options.remote ? "--remote" : undefined,
  ].filter((value): value is string => value !== undefined);
  if (selected.length > 1) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Cannot combine auth target flags: ${selected.join(", ")}`,
    );
  }
  if (options.project) return "project";
  if (options.global) return "global";
  if (options.remote) return "remote";
  return undefined;
}

async function resolveAuthTarget(
  serverId: string,
  options: AuthTargetOptions,
  io: CliIO,
): Promise<AuthTarget> {
  const explicit = parseAuthFlagTarget(options);
  if (explicit === "remote") return explicit;

  const matches: AuthTarget[] = await withControlPlaneSecurity(
    io,
    (_security, engine) =>
      localAuthTargets({
        effectiveConfig: requireActivatedConfigWithSources(engine),
      })
        .filter((target) => target.server === serverId)
        .map((target) => target.source),
    "auth",
  );
  if (explicit) {
    if (matches.includes(explicit)) return explicit;
    throw new CapletsError(
      "SERVER_NOT_FOUND",
      `Server ${serverId} is not configured for OAuth in the ${explicit} scope`,
    );
  }

  const remote = remoteClientForCli(io);
  if (remote) {
    if (matches.length === 0) {
      matches.push("remote");
    } else if ((await remoteAuthRows(remote)).some((row) => row.server === serverId)) {
      matches.push("remote");
    }
  }

  const unique = [...new Set(matches)];
  if (unique.length === 1) return unique[0]!;
  if (unique.length > 1) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Auth target \`${serverId}\` exists in multiple scopes. Pass --project, --global, or --remote.`,
    );
  }
  throw new CapletsError("SERVER_NOT_FOUND", `Server ${serverId} is not configured for OAuth`);
}

async function authListRowsForCli(
  target: AuthTarget | undefined,
  io: CliIO,
): Promise<AuthStatusRow[]> {
  if (target === "remote") {
    return remoteAuthRows(requireRemoteClientForTarget(io));
  }
  const localRows = await withControlPlaneSecurity(
    io,
    (security, engine) =>
      listLocalAuthRowsFromRepository(
        {
          effectiveConfig: requireActivatedConfigWithSources(engine),
          ...(target ? { source: target } : {}),
        },
        security,
      ),
    "admin",
  );
  if (target) return localRows;
  const remote = remoteClientForCli(io);
  if (!remote) return localRows;
  return [...localRows, ...(await remoteAuthRows(remote))].sort((left, right) =>
    left.server.localeCompare(right.server),
  );
}

async function remoteAuthRows(remote: RemoteControlClient): Promise<AuthStatusRow[]> {
  const rows = (await remote.request("auth_list", {})) as AuthStatusRow[];
  return rows.map((row) => ({ ...row, source: "remote" }));
}

async function remoteAuthLogin(
  remote: RemoteControlClient,
  serverId: string,
  open: boolean,
  writeOut: (value: string) => void,
): Promise<void> {
  const started = (await remote.request("auth_login_start", { server: serverId })) as {
    server: string;
    flowId?: string;
    authorizationUrl?: string;
    authenticated?: boolean;
  };
  if (started.authorizationUrl) {
    writeOut(`Open this URL to authorize ${serverId}:\n${started.authorizationUrl}\n`);
    if (open) {
      await openBrowser(started.authorizationUrl);
    }
    writeOut(
      "Complete authentication in your browser. The server callback will store credentials.\n",
    );
    return;
  }
  if (started.authenticated) {
    writeOut(`Authenticated \`${serverId}\`.\n`);
  }
}

function requireRemoteClientForTarget(io: CliIO): RemoteControlClient {
  const remote = remoteClientForCli(io);
  if (!remote) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "--remote requires CAPLETS_MODE=remote and CAPLETS_REMOTE_URL",
    );
  }
  return remote;
}

function requestTypedRemote<TCommand extends TypedRemoteCliCommand>(
  io: CliIO,
  command: TCommand,
  argumentsValue: RemoteCliArgumentsByCommand[TCommand],
): Promise<unknown> {
  return requireRemoteClientForTarget(io).request(command, argumentsValue);
}

async function remotePortableStatusForCli(io: CliIO): Promise<CurrentHostPortableOperationOutcome> {
  const env = io.env ?? process.env;
  const selection = await resolveRemoteSelection(
    {
      mode: "remote",
      ...(io.authDir ? { authDir: io.authDir } : {}),
      ...(io.fetch ? { fetch: io.fetch } : {}),
    },
    env,
  );
  if (selection.kind !== "self_hosted_remote") {
    throw new CapletsError(
      "REQUEST_INVALID",
      "--remote requires CAPLETS_MODE=remote and a self-hosted CAPLETS_REMOTE_URL",
    );
  }
  const url = healthUrlForBase(selection.remote.baseUrl);
  url.searchParams.set("portable", "1");
  const { body: _body, ...requestInit } = selection.remote.requestInit;
  const response = await (selection.remote.fetch ?? fetch)(url, {
    ...requestInit,
    method: "GET",
  });
  if (!response.ok) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Remote portable status is unavailable.");
  }
  return parseRemotePortableOutcome(await response.json());
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CapletsError("REQUEST_INVALID", `Expected a positive integer, got ${value}`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new CapletsError("REQUEST_INVALID", `${label} must be a non-negative integer`);
  }
  return parsed;
}

function parseLogStream(value: string | undefined): DaemonLogStream {
  if (value === undefined || value === "all" || value === "stdout" || value === "stderr") {
    return value ?? "all";
  }
  throw new CapletsError("REQUEST_INVALID", "--stream must be stdout, stderr, or all");
}

function parseRemoteClientRole(value: string): RemoteClientRole {
  if (value === "access" || value === "operator") return value;
  throw new CapletsError("REQUEST_INVALID", "Remote client role must be access or operator.");
}

type CliOutputFormat = "markdown" | "plain" | "json";

function parseOutputFormat(value: string): CliOutputFormat {
  switch (value.toLocaleLowerCase()) {
    case "markdown":
    case "md":
      return "markdown";
    case "plain":
      return "plain";
    case "json":
      return "json";
    default:
      throw new CapletsError(
        "REQUEST_INVALID",
        `Expected output format markdown, md, plain, or json; got ${value}`,
      );
  }
}

function parseSetupFormat(value: string): SetupFormat {
  if (value === "plain" || value === "json") return value;
  throw new CapletsError("REQUEST_INVALID", "setup format must be plain or json");
}

function parseSetupTarget(value: string): "local" | "remote" | "cloud" {
  if (value === "local" || value === "remote" || value === "cloud") return value;
  throw new CapletsError("REQUEST_INVALID", "setup target must be local, remote, or cloud");
}

function parseQualifiedTarget(
  capletOrTarget: string,
  toolArgument?: string | undefined,
): { caplet: string; tool: string } {
  if (toolArgument !== undefined) {
    if (capletOrTarget.length === 0 || toolArgument.length === 0) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Expected target in the form <caplet> <tool> or <caplet>.<tool>",
      );
    }
    return { caplet: capletOrTarget, tool: toolArgument };
  }

  const dot = capletOrTarget.indexOf(".");
  if (dot <= 0 || dot === capletOrTarget.length - 1) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Expected target in the form <caplet> <tool> or <caplet>.<tool>",
    );
  }
  return { caplet: capletOrTarget.slice(0, dot), tool: capletOrTarget.slice(dot + 1) };
}

async function completeCliWordsLocally(
  words: string[],
  options: {
    configPath?: string | undefined;
    projectConfigPath?: string | undefined;
    authDir?: string | undefined;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    config?: CapletsConfig | undefined;
  },
): Promise<string[]> {
  const engine = await createCapletsEngine({
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.projectConfigPath ? { projectConfigPath: options.projectConfigPath } : {}),
    ...(options.authDir ? { authDir: options.authDir } : {}),
    env: options.env,
    watch: false,
  });
  try {
    return await engine.completeCliWords(words);
  } finally {
    await engine.close();
  }
}

function mergeCompletionSuggestions(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

function localShadowedCompletionTarget(words: string[], config: CapletsConfig): string | undefined {
  const command = words[0];
  const target = words[1];
  if (!command || !target || target.startsWith("-")) {
    return undefined;
  }
  const qualifiedCommands = new Set<string>([
    cliCommands.getTool,
    cliCommands.callTool,
    cliCommands.getPrompt,
  ]);
  const capletCommands = new Set<string>([
    cliCommands.inspect,
    cliCommands.checkBackend,
    cliCommands.listTools,
    cliCommands.searchTools,
    cliCommands.listResources,
    cliCommands.searchResources,
    cliCommands.listResourceTemplates,
    cliCommands.readResource,
    cliCommands.listPrompts,
    cliCommands.searchPrompts,
    cliCommands.complete,
  ]);
  const caplet = qualifiedCommands.has(command)
    ? target.slice(0, target.includes(".") ? target.indexOf(".") : target.length)
    : capletCommands.has(command)
      ? target
      : undefined;
  return caplet && hasEnabledCaplet(config, caplet) ? caplet : undefined;
}

function parseCallToolArgs(value: string | undefined): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new CapletsError("REQUEST_INVALID", "call-tool --args must be valid JSON", error);
  }
  if (!isPlainObject(parsed)) {
    throw new CapletsError("REQUEST_INVALID", "call-tool --args must be a JSON object");
  }
  return parsed;
}

function parseJsonObjectOption(value: string | undefined, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new CapletsError("REQUEST_INVALID", `${label} must be valid JSON`, error);
  }
  if (!isPlainObject(parsed)) {
    throw new CapletsError("REQUEST_INVALID", `${label} must be a JSON object`);
  }
  return parsed;
}

function completionRefFromOptions(options: { prompt?: string; resourceTemplate?: string }) {
  if (options.prompt && options.resourceTemplate) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "complete accepts either --prompt or --resource-template, not both",
    );
  }
  if (options.prompt) return { type: "prompt", name: options.prompt };
  if (options.resourceTemplate) return { type: "resourceTemplate", uri: options.resourceTemplate };
  throw new CapletsError("REQUEST_INVALID", "complete requires --prompt or --resource-template");
}

function installStatusLabel(
  status: string | undefined,
  defaultLabel: "Installed" | "Restored",
): string {
  if (status === "noop") return "Already installed";
  if (status === "content_updated") return "Content updated";
  if (status === "restored") return "Restored";
  return defaultLabel;
}

function updateStatusLabel(status: string | undefined): string {
  if (status === "noop") return "Already current";
  if (status === "content_updated") return "Content updated";
  return "Updated";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type ExecuteOperationIO = Required<Pick<CliIO, "writeOut" | "writeErr" | "setExitCode">> & {
  authDir?: string | undefined;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  remote?: RemoteControlClient | undefined;
  format?: CliOutputFormat | undefined;
  telemetryStateDir?: string | undefined;
  telemetryDebugSink?: TelemetryDebugSink | undefined;
};

type CapletListRow = ReturnType<typeof listCaplets>[number];

async function executeOperation(
  caplet: string,
  request: Record<string, unknown>,
  io: ExecuteOperationIO,
): Promise<void> {
  const command = remoteCommandForOperation(request.operation);
  if (io.remote && command) {
    const localOverlay = tryLoadLocalOverlayForCli(io, io.writeErr);
    if (localOverlay && hasEnabledCaplet(localOverlay.config, caplet)) {
      await executeLocalOperation(caplet, request, io);
      return;
    }
    const result = await io.remote.request(command, { caplet, request });
    const output = cliOutputForOperation(result, { ...request, caplet }, io.format ?? "markdown");
    io.writeOut(
      typeof output === "string" ? `${output}\n` : `${JSON.stringify(output, null, 2)}\n`,
    );
    if (isPlainObject(result) && result.isError === true) {
      io.setExitCode(1);
    }
    return;
  }

  await executeLocalOperation(caplet, request, io);
}

function loadLocalOverlayForCli(
  io: Pick<CliIO, "env">,
  writeErr: (value: string) => void,
): LocalOverlayConfigWithSources {
  const env = io.env ?? process.env;
  const overlay = loadLocalOverlayConfigWithSources(
    resolveConfigPath(envConfigPath(env)),
    envProjectConfigPath(env),
  );
  for (const warning of overlay.warnings) {
    writeErr(`Warning: ${warning.kind} at ${warning.path}: ${warning.message}\n`);
  }
  return overlay;
}

function tryLoadLocalOverlayForCli(
  io: Pick<CliIO, "env">,
  writeErr: (value: string) => void,
): LocalOverlayConfigWithSources | undefined {
  try {
    return loadLocalOverlayForCli(io, writeErr);
  } catch (error) {
    writeErr(`Warning: Could not load local Caplets overlay: ${formatErrorMessage(error)}\n`);
    return loadPartialLocalOverlayForCli(io, writeErr);
  }
}

function loadPartialLocalOverlayForCli(
  io: Pick<CliIO, "env">,
  writeErr: (value: string) => void,
): LocalOverlayConfigWithSources | undefined {
  const env = io.env ?? process.env;
  const configPath = resolveConfigPath(envConfigPath(env));
  const projectConfigPath = envProjectConfigPath(env);
  const absentProjectPath = join(dirname(configPath), ".caplets-overlay-recovery", "config.json");
  const absentGlobalPath = join(
    dirname(projectConfigPath),
    ".caplets-overlay-recovery",
    "config.json",
  );
  const globalOverlay = tryLoadPartialOverlayLayer(
    "global",
    configPath,
    absentProjectPath,
    writeErr,
  );
  const projectOverlay = tryLoadPartialOverlayLayer(
    "project",
    absentGlobalPath,
    projectConfigPath,
    writeErr,
  );

  if (!globalOverlay) {
    return projectOverlay;
  }
  if (!projectOverlay) {
    return globalOverlay;
  }
  return mergePartialLocalOverlays(globalOverlay, projectOverlay);
}

function tryLoadPartialOverlayLayer(
  label: "global" | "project",
  configPath: string,
  projectConfigPath: string,
  writeErr: (value: string) => void,
): LocalOverlayConfigWithSources | undefined {
  try {
    const overlay = loadLocalOverlayConfigWithSources(configPath, projectConfigPath);
    for (const warning of overlay.warnings) {
      writeErr(`Warning: ${warning.kind} at ${warning.path}: ${warning.message}\n`);
    }
    return overlay;
  } catch (error) {
    writeErr(`Warning: Could not load ${label} Caplets overlay: ${formatErrorMessage(error)}\n`);
    return undefined;
  }
}

function mergePartialLocalOverlays(
  globalOverlay: LocalOverlayConfigWithSources,
  projectOverlay: LocalOverlayConfigWithSources,
): LocalOverlayConfigWithSources {
  const config = { ...globalOverlay.config };
  const sources = { ...globalOverlay.sources };
  const shadows = { ...globalOverlay.shadows };

  for (const kind of capletConfigKinds) {
    config[kind] = { ...globalOverlay.config[kind] } as never;
  }
  for (const kind of capletConfigKinds) {
    for (const id of Object.keys(projectOverlay.config[kind])) {
      removeCapletFromPartialOverlay(config, sources, shadows, id);
      config[kind][id] = projectOverlay.config[kind][id] as never;
    }
  }
  for (const [id, source] of Object.entries(projectOverlay.sources)) {
    sources[id] = source;
  }
  for (const [id, shadowedSources] of Object.entries(projectOverlay.shadows)) {
    shadows[id] = [...(shadows[id] ?? []), ...shadowedSources];
  }

  return {
    config,
    sources,
    shadows,
    warnings: [...globalOverlay.warnings, ...projectOverlay.warnings],
    sourceFound: globalOverlay.sourceFound || projectOverlay.sourceFound,
  };
}

const capletConfigKinds = [
  "mcpServers",
  "openapiEndpoints",
  "googleDiscoveryApis",
  "graphqlEndpoints",
  "httpApis",
  "cliTools",
  "capletSets",
] as const;

function removeCapletFromPartialOverlay(
  config: CapletsConfig,
  sources: Record<string, ConfigSource>,
  shadows: Record<string, ConfigSource[]>,
  id: string,
): void {
  for (const kind of capletConfigKinds) {
    delete config[kind][id];
  }
  if (sources[id]) {
    shadows[id] = [...(shadows[id] ?? []), sources[id]];
  }
  delete sources[id];
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function envProjectConfigPath(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  return env.CAPLETS_PROJECT_CONFIG?.trim() || resolveProjectConfigPath();
}

function envProjectCapletsRoot(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string {
  const projectConfigPath = env.CAPLETS_PROJECT_CONFIG?.trim();
  return projectConfigPath ? dirname(projectConfigPath) : resolveProjectCapletsRoot();
}

function mergeRemoteAndLocalRows(
  remoteRows: CapletListRow[],
  localOverlay: LocalOverlayConfigWithSources | undefined,
  options: { includeDisabled: boolean; writeErr: (value: string) => void },
): CapletListRow[] {
  const rows = new Map<string, CapletListRow>();
  for (const row of remoteRows) {
    rows.set(row.server, { ...row, source: "remote" });
  }
  if (!localOverlay) {
    return [...rows.values()]
      .filter((row) => options.includeDisabled || !row.disabled)
      .sort((left, right) => left.server.localeCompare(right.server));
  }
  for (const row of listCaplets(localOverlay, { includeDisabled: true })) {
    const remote = rows.get(row.server);
    if (remote) {
      if (row.disabled) {
        continue;
      }
      if (remote.shadowing === "namespace") {
        options.writeErr(
          `Local Caplet '${row.server}' is exposed under a qualified ID because the remote Caplet uses namespace shadowing for that Caplet ID.\n`,
        );
        continue;
      }
      if (remote.shadowing !== "allow") {
        options.writeErr(
          `Local Caplet '${row.server}' is suppressed because the remote Caplet forbids shadowing that Caplet ID.\n`,
        );
        continue;
      }
      options.writeErr(
        `Warning: ${formatOverlaySource(row.source)} Caplet ${row.server} shadows remote Caplet\n`,
      );
    }
    rows.set(row.server, row);
  }
  return [...rows.values()]
    .filter((row) => options.includeDisabled || !row.disabled)
    .sort((left, right) => left.server.localeCompare(right.server));
}

function formatOverlaySource(kind: ConfigSource["kind"] | "remote" | "unknown"): string {
  if (kind.startsWith("project")) return "project";
  if (kind.startsWith("global")) return "global";
  return kind;
}

function hasEnabledCaplet(config: CapletsConfig, id: string): boolean {
  const caplet =
    config.mcpServers[id] ??
    config.openapiEndpoints[id] ??
    config.googleDiscoveryApis[id] ??
    config.graphqlEndpoints[id] ??
    config.httpApis[id] ??
    config.cliTools[id] ??
    config.capletSets[id];
  return Boolean(caplet && !caplet.disabled);
}

async function executeLocalOperation(
  caplet: string,
  request: Record<string, unknown>,
  io: ExecuteOperationIO,
): Promise<void> {
  const configPath = envConfigPath(io.env ?? process.env);
  const engine = await createCapletsEngine({
    ...(configPath ? { configPath } : {}),
    projectConfigPath: envProjectConfigPath(io.env ?? process.env),
    ...(io.authDir ? { authDir: io.authDir } : {}),
    env: io.env ?? process.env,
    watch: false,
    writeErr: io.writeErr,
    telemetryEnv: io.env ?? process.env,
    telemetryStateDir: io.telemetryStateDir ?? defaultTelemetryStateDir(io.env ?? process.env),
    telemetrySurface: "cli",
    telemetryVisibility: "visible",
    telemetryRuntimeMode: runtimeModeForEnv(io.env ?? process.env),
    telemetryDebugSink: io.telemetryDebugSink,
  });
  try {
    const result = await engine.execute(caplet, request);
    const output = cliOutputForOperation(result, { ...request, caplet }, io.format ?? "markdown");
    io.writeOut(
      typeof output === "string" ? `${output}\n` : `${JSON.stringify(output, null, 2)}\n`,
    );
    if (isPlainObject(result) && result.isError === true) {
      io.setExitCode(1);
    }
  } finally {
    await engine.close();
  }
}

function cliOutputForOperation(
  result: unknown,
  request: Record<string, unknown>,
  format: CliOutputFormat,
): unknown {
  if (format === "json" || !isPlainObject(result)) {
    return jsonPayloadForOperation(result, request.operation);
  }
  return format === "markdown"
    ? markdownSummaryForOperation(result, request)
    : plainSummaryForOperation(result, request);
}

function jsonPayloadForOperation(result: unknown, operation: unknown): unknown {
  if (operation === "call_tool" || !isPlainObject(result)) {
    return result;
  }
  const structuredContent = result.structuredContent;
  if (!isPlainObject(structuredContent) || !("result" in structuredContent)) {
    return result;
  }
  return structuredContent.result;
}

function markdownSummaryForOperation(result: unknown, request: Record<string, unknown>): string {
  const operation = request.operation;
  const payload = jsonPayloadForOperation(result, operation);
  if (!isPlainObject(payload)) {
    return String(payload);
  }
  const id = payloadId(payload);
  switch (operation) {
    case "inspect":
      return [
        `## Caplet \`${id}\``,
        "",
        `**Name:** ${String(payload.name ?? "Unnamed")}`,
        `**Description:** ${String(payload.description ?? "No description.")}`,
        payload.backend ? `**Backend:** ${backendType(payload.backend)}` : undefined,
        "",
        "Next:",
        `- List tools: \`caplets list-tools ${id}\``,
        `- Search tools: \`caplets search-tools ${id} <query>\``,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "check":
      return [
        `## Backend \`${id}\``,
        "",
        `- Status: ${String(payload.status ?? "unknown")}`,
        typeof payload.toolCount === "number" ? `- Tools: ${payload.toolCount}` : undefined,
        typeof payload.elapsedMs === "number" ? `- Elapsed: ${payload.elapsedMs}ms` : undefined,
        "",
        "Next:",
        `- List tools: \`caplets list-tools ${id}\``,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "tools": {
      const tools = pageItemsFromPayload(payload);
      return [
        `## Tools for \`${id}\``,
        "",
        `${tools.length} ${tools.length === 1 ? "tool" : "tools"} found.`,
        "",
        ...formatToolLines(tools, "markdown"),
        "",
        "Next:",
        `- Inspect a tool: \`caplets get-tool ${id}.<tool>\``,
        `- Call a tool: \`caplets call-tool ${id}.<tool> --args '{...}'\``,
        "- Machine output: add `--format json`",
      ].join("\n");
    }
    case "search_tools": {
      const tools = pageItemsFromPayload(payload);
      return [
        `## Matches for ${JSON.stringify(String(payload.query ?? ""))} in \`${id}\``,
        "",
        `${tools.length} ${tools.length === 1 ? "match" : "matches"} found.`,
        "",
        ...formatToolLines(tools, "markdown"),
        "",
        "Next:",
        tools.length > 0
          ? `- Inspect the first match: \`caplets get-tool ${id}.${firstToolName(tools) ?? "<tool>"}\``
          : `- Try a broader query or list tools: \`caplets list-tools ${id}\``,
      ].join("\n");
    }
    case "describe_tool": {
      const tool = isPlainObject(payload.tool) ? payload.tool : {};
      const target = `${id}.${String(tool.name ?? "<tool>")}`;
      return [
        `## Tool \`${target}\``,
        "",
        tool.description ? compactDescription(String(tool.description)) : undefined,
        "",
        "Input:",
        `- ${schemaSummary(tool.inputSchema)}`,
        "",
        "Output:",
        `- ${tool.outputSchema ? schemaSummary(tool.outputSchema) : "not declared"}`,
        "",
        "Next:",
        `- Call: \`caplets call-tool ${target} --args '{...}'\``,
        "- Full schema: add `--format json`",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    }
    case "call_tool": {
      const callTarget = `${String(request.caplet ?? "<caplet>")}.${String(request.name ?? "unknown")}`;
      return [
        `## Call \`${callTarget}\``,
        "",
        `- Status: ${payload.isError === true ? "failed" : "succeeded"}`,
        callStatusLine(payload) ? `- ${callStatusLine(payload)}` : undefined,
        `- Result: ${summarizeCallResult(payload)}`,
        "",
        "Use `--format json` to inspect the full structured result.",
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    }
    case "resources":
    case "search_resources": {
      const matches = pageItemsFromPayload(payload);
      return [
        `## MCP resources for \`${id}\``,
        "",
        `${matches.length} item${matches.length === 1 ? "" : "s"} found.`,
        "",
        ...formatResourceLines(matches, "markdown"),
      ].join("\n");
    }
    case "resource_templates": {
      const templates = pageItemsFromPayload(payload);
      return [
        `## MCP resource templates for \`${id}\``,
        "",
        ...formatResourceLines(templates, "markdown"),
      ].join("\n");
    }
    case "read_resource":
      return [
        `## Resource \`${String(request.uri ?? "")}\``,
        "",
        summarizeResourceRead(payload),
        "",
        "Use `--format json` to inspect all contents.",
      ].join("\n");
    case "prompts":
    case "search_prompts": {
      const prompts = pageItemsFromPayload(payload);
      return [`## MCP prompts for \`${id}\``, "", ...formatPromptLines(prompts, "markdown")].join(
        "\n",
      );
    }
    case "get_prompt":
      return [
        `## Prompt \`${String(request.caplet)}.${String(request.name)}\``,
        "",
        summarizePromptResult(payload),
        "",
        "Use `--format json` to inspect all messages.",
      ].join("\n");
    case "complete":
      return [`## Completion for \`${id}\``, "", summarizeCompletionResult(payload)].join("\n");
    default:
      return JSON.stringify(payload, null, 2);
  }
}

function plainSummaryForOperation(result: unknown, request: Record<string, unknown>): string {
  const operation = request.operation;
  const payload = jsonPayloadForOperation(result, operation);
  if (!isPlainObject(payload)) {
    return String(payload);
  }
  const id = payloadId(payload);
  switch (operation) {
    case "inspect":
      return [
        `Caplet: ${id}`,
        `Name: ${String(payload.name ?? "Unnamed")}`,
        `Description: ${String(payload.description ?? "No description.")}`,
        payload.backend ? `Backend: ${backendType(payload.backend)}` : undefined,
        `Next: caplets list-tools ${id} or caplets search-tools ${id} <query>`,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    case "check":
      return [
        `Backend: ${id} is ${String(payload.status ?? "unknown")}`,
        typeof payload.toolCount === "number" ? `Tools: ${payload.toolCount}` : undefined,
        typeof payload.elapsedMs === "number" ? `Elapsed: ${payload.elapsedMs}ms` : undefined,
        `Next: caplets list-tools ${id}`,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    case "tools": {
      const tools = pageItemsFromPayload(payload);
      return [
        `Tools for ${id} (${tools.length}):`,
        ...formatToolLines(tools, "plain"),
        `Next: caplets get-tool ${id}.<tool> or caplets call-tool ${id}.<tool> --args '{...}'`,
      ].join("\n");
    }
    case "search_tools": {
      const tools = pageItemsFromPayload(payload);
      return [
        `Matches for ${JSON.stringify(String(payload.query ?? ""))} in ${id} (${tools.length}):`,
        ...formatToolLines(tools, "plain"),
        tools.length > 0
          ? `Next: caplets get-tool ${id}.${firstToolName(tools) ?? "<tool>"}`
          : `Next: try caplets list-tools ${id} or a broader query.`,
      ].join("\n");
    }
    case "describe_tool": {
      const tool = isPlainObject(payload.tool) ? payload.tool : {};
      const target = `${id}.${String(tool.name ?? "<tool>")}`;
      return [
        `Tool: ${target}`,
        tool.description
          ? `Description: ${compactDescription(String(tool.description))}`
          : undefined,
        `Input: ${schemaSummary(tool.inputSchema)}`,
        `Output: ${tool.outputSchema ? schemaSummary(tool.outputSchema) : "not declared"}`,
        `Next: caplets call-tool ${target} --args '{...}'`,
        "Use --format json to inspect full schemas and descriptions.",
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    }
    case "call_tool": {
      const callTarget = `${String(request.caplet ?? "<caplet>")}.${String(request.name ?? "unknown")}`;
      return [
        `Call ${callTarget} ${payload.isError === true ? "failed" : "succeeded"}.`,
        callStatusLine(payload),
        `Result: ${summarizeCallResult(payload)}`,
        "Use --format json to inspect the full structured result.",
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    }
    case "resources":
    case "search_resources": {
      const matches = pageItemsFromPayload(payload);
      return [
        `MCP resources for ${id} (${matches.length}):`,
        ...formatResourceLines(matches, "plain"),
      ].join("\n");
    }
    case "resource_templates": {
      const templates = pageItemsFromPayload(payload);
      return [`MCP resource templates for ${id}:`, ...formatResourceLines(templates, "plain")].join(
        "\n",
      );
    }
    case "read_resource":
      return [
        `Resource ${String(request.uri ?? "")}`,
        summarizeResourceRead(payload),
        "Use --format json to inspect all contents.",
      ].join("\n");
    case "prompts":
    case "search_prompts": {
      const prompts = pageItemsFromPayload(payload);
      return [`MCP prompts for ${id}:`, ...formatPromptLines(prompts, "plain")].join("\n");
    }
    case "get_prompt":
      return [
        `Prompt ${String(request.caplet)}.${String(request.name)}`,
        summarizePromptResult(payload),
        "Use --format json to inspect all messages.",
      ].join("\n");
    case "complete":
      return [`Completion for ${id}`, summarizeCompletionResult(payload)].join("\n");
    default:
      return JSON.stringify(payload, null, 2);
  }
}

function payloadId(payload: Record<string, unknown>): string {
  return String(payload.id ?? payload.caplet ?? payload.server ?? "<caplet>");
}

function pageItemsFromPayload(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.items)) return payload.items;
  for (const key of ["tools", "resources", "resourceTemplates", "prompts", "matches"] as const) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function formatToolLines(tools: unknown[], format: "markdown" | "plain"): string[] {
  if (tools.length === 0) {
    return ["- none"];
  }
  return tools.map((tool) => {
    if (!isPlainObject(tool)) {
      return `- ${String(tool)}`;
    }
    const name = String(tool.tool ?? tool.name ?? "unknown");
    const displayName = format === "markdown" ? `\`${name}\`` : name;
    const flags = [
      tool.hasInputSchema ? "input" : undefined,
      tool.hasOutputSchema ? "output" : undefined,
    ]
      .filter(Boolean)
      .join(", ");
    const suffix = flags ? ` (${flags})` : "";
    return `- ${displayName}${suffix}${tool.description ? ` — ${compactDescription(String(tool.description))}` : ""}`;
  });
}

function formatResourceLines(resources: unknown[], format: "markdown" | "plain"): string[] {
  if (resources.length === 0) return ["- none"];
  return resources.map((resource) => {
    if (!isPlainObject(resource)) return `- ${String(resource)}`;
    const name = String(resource.uri ?? resource.uriTemplate ?? "unknown");
    const displayName = format === "markdown" ? `\`${name}\`` : name;
    const label = typeof resource.name === "string" ? ` (${resource.name})` : "";
    const kind = typeof resource.kind === "string" ? `${resource.kind}: ` : "";
    const description = resource.description
      ? ` — ${compactDescription(String(resource.description))}`
      : "";
    return `- ${kind}${displayName}${label}${description}`;
  });
}

function formatPromptLines(prompts: unknown[], format: "markdown" | "plain"): string[] {
  if (prompts.length === 0) return ["- none"];
  return prompts.map((prompt) => {
    if (!isPlainObject(prompt)) return `- ${String(prompt)}`;
    const name = String(prompt.prompt ?? prompt.name ?? "unknown");
    const displayName = format === "markdown" ? `\`${name}\`` : name;
    const args = Array.isArray(prompt.arguments) ? ` (${prompt.arguments.length} args)` : "";
    const description = prompt.description
      ? ` — ${compactDescription(String(prompt.description))}`
      : "";
    return `- ${displayName}${args}${description}`;
  });
}

function summarizeResourceRead(payload: Record<string, unknown>): string {
  const contents = Array.isArray(payload.contents) ? payload.contents : [];
  if (contents.length === 0) return "No contents returned.";
  const first = contents.find(isPlainObject);
  if (!first) return `${contents.length} content item${contents.length === 1 ? "" : "s"} returned.`;
  const value = typeof first.text === "string" ? first.text : first.blob;
  return (
    previewValue(value) ??
    `${contents.length} content item${contents.length === 1 ? "" : "s"} returned.`
  );
}

function summarizePromptResult(payload: Record<string, unknown>): string {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (messages.length === 0) return "No messages returned.";
  const first = messages.find(isPlainObject);
  if (!first) return `${messages.length} message${messages.length === 1 ? "" : "s"} returned.`;
  const content = isPlainObject(first.content) ? first.content : undefined;
  return (
    previewValue(content?.text ?? first.content) ??
    `${messages.length} message${messages.length === 1 ? "" : "s"} returned.`
  );
}

function summarizeCompletionResult(payload: Record<string, unknown>): string {
  const completion = isPlainObject(payload.completion) ? payload.completion : undefined;
  const values = Array.isArray(completion?.values) ? completion.values : [];
  if (values.length > 0) return values.map((value) => `- ${String(value)}`).join("\n");
  return previewValue(payload) ?? "No completions returned.";
}

function compactDescription(value: string): string {
  const firstParagraph = value.trim().split(/\n\s*\n/u)[0] ?? "";
  const firstSentence = firstParagraph.match(/^.*?(?:[.!?](?=\s|$)|$)/u)?.[0] ?? firstParagraph;
  const collapsed = firstSentence.replace(/\s+/gu, " ").trim();
  return collapsed.length > 140 ? `${collapsed.slice(0, 137).trimEnd()}...` : collapsed;
}

function firstToolName(tools: unknown[]): string | undefined {
  const first = tools[0];
  return isPlainObject(first) && typeof first.tool === "string" ? first.tool : undefined;
}

function backendType(value: unknown): string {
  return isPlainObject(value) && typeof value.type === "string" ? value.type : "unknown";
}

function callStatusLine(payload: Record<string, unknown>): string | undefined {
  const structured = isPlainObject(payload.structuredContent) ? payload.structuredContent : payload;
  return typeof structured.exitCode === "number" ? `Exit code: ${structured.exitCode}` : undefined;
}

function summarizeCallResult(payload: Record<string, unknown>): string {
  const structured = isPlainObject(payload.structuredContent) ? payload.structuredContent : payload;
  const preview = previewValue(preferredPreviewValue(structured));
  if (preview) {
    return preview;
  }
  const keys = Object.keys(structured).filter((key) => key !== "elapsedMs");
  return keys.length > 0 ? `structured keys: ${keys.join(", ")}` : "no structured content";
}

function preferredPreviewValue(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value;
  }
  if ("result" in value) {
    return value.result;
  }
  if ("json" in value) {
    return value.json;
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.stdout === "string" && value.stdout.trim()) {
    return value.stdout.trim();
  }
  return value;
}

function previewValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return truncatePreview(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return truncatePreview(JSON.stringify(value));
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).slice(0, 4);
    if (entries.length === 0) {
      return "empty object";
    }
    return truncatePreview(
      entries.map(([key, entryValue]) => `${key}: ${previewScalar(entryValue)}`).join(", "),
    );
  }
  return undefined;
}

function previewScalar(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(truncatePreview(value, 80));
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).slice(0, 3).join(", ")}${Object.keys(value).length > 3 ? ", ..." : ""}}`;
  }
  return typeof value;
}

function truncatePreview(value: string, maxLength = 180): string {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed.length > maxLength
    ? `${collapsed.slice(0, maxLength - 3).trimEnd()}...`
    : collapsed;
}

function schemaSummary(schema: unknown): string {
  if (!isPlainObject(schema)) {
    return "not declared";
  }
  const properties = isPlainObject(schema.properties) ? Object.keys(schema.properties) : [];
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];
  const parts = [
    typeof schema.type === "string" ? `type ${schema.type}` : undefined,
    properties.length > 0 ? `properties ${properties.join(", ")}` : "no declared properties",
    required.length > 0 ? `required ${required.join(", ")}` : "no required fields",
  ];
  return parts.filter((part): part is string => Boolean(part)).join("; ");
}

function addDestinationRoot(
  target: MutationTarget,
  configPath: string | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string {
  return target === "global"
    ? resolveCapletsRoot(resolveConfigPath(configPath))
    : envProjectCapletsRoot(env);
}

function writeAddResult(
  writeOut: (value: string) => void,
  label: string,
  result: AddCliResult,
): void {
  if (result.path) {
    writeOut(`Wrote ${result.remote ? "remote " : ""}${label} Caplet to ${result.path}\n`);
    return;
  }
  writeOut(result.text);
}

type CurrentHostOfflineTransferConfirmationAction = "cutover" | "finalize";

function assertOfflineTransferConfirmationSelection(options: {
  preview?: boolean | undefined;
  confirmation?: string | undefined;
}): void {
  if (Boolean(options.preview) === Boolean(options.confirmation)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Choose exactly one of --preview or --confirmation for this irreversible action.",
    );
  }
}

function assertInteractiveOfflineTransferConfirmation(io: CliIO): void {
  const stdinIsTTY = io.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdoutIsTTY = io.stdoutIsTTY ?? process.stdout.isTTY === true;
  if (!stdinIsTTY || !stdoutIsTTY) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Offline transfer cutover and finalization confirmations require an interactive terminal.",
    );
  }
}

function parseOfflineTransferJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new CapletsError("REQUEST_INVALID", "Offline transfer JSON is invalid.");
  }
}

function parseOfflineTransferConfirmationJson(
  value: string,
  expectedAction: CurrentHostOfflineTransferConfirmationAction,
  expectedTransferId: string,
): CurrentHostOfflineTransferConfirmation {
  const confirmation = parseCurrentHostOfflineTransferConfirmation(parseOfflineTransferJson(value));
  if (
    confirmation.action !== expectedAction ||
    confirmation.transferId !== expectedTransferId ||
    Date.parse(confirmation.expiresAt) <= Date.now()
  ) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Offline transfer confirmation is stale or mismatched.",
    );
  }
  return confirmation;
}

function writeCurrentHostOfflineTransferOutput(
  writeOut: (value: string) => void,
  value: CurrentHostOfflineTransferPreview | CurrentHostOfflineTransferResult,
): void {
  writeOut(`${JSON.stringify(value)}\n`);
}

type PortableCommandOptions = {
  global?: boolean | undefined;
  remote?: boolean | undefined;
  json?: boolean | undefined;
  operationId?: string | undefined;
};

type PortableOperationInput = CurrentHostPortableOperation extends infer TOperation
  ? TOperation extends CurrentHostPortableOperation
    ? Omit<TOperation, "binding">
    : never
  : never;

const PORTABLE_CHUNK_SIZE_BYTES = 1024 * 1024;
const PORTABLE_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function decodePortableBase64Chunk(
  value: unknown,
  code: "REQUEST_INVALID" | "INTERNAL_ERROR",
  message: string,
): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !PORTABLE_BASE64_PATTERN.test(value)
  ) {
    throw new CapletsError(code, message);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > PORTABLE_CHUNK_SIZE_BYTES || bytes.toString("base64") !== value) {
    throw new CapletsError(code, message);
  }
  return bytes;
}

function parseRemotePortableOutcome(value: unknown): CurrentHostPortableOperationOutcome {
  try {
    if (!isPlainObject(value) || !Object.hasOwn(value, "kind") || !Object.hasOwn(value, "status")) {
      throw new Error("invalid portable outcome");
    }
    if (value.kind === "portable_artifact_download_range") {
      remotePortableObject(value, [
        "kind",
        "status",
        "bytesBase64",
        "start",
        "endExclusive",
        "totalLength",
      ]);
      remotePortableEnum(value.status, ["ok"]);
      const start = remotePortableInteger(value.start);
      const endExclusive = remotePortableInteger(value.endExclusive);
      const totalLength = remotePortableInteger(value.totalLength);
      if (endExclusive <= start || endExclusive > totalLength) throw new Error("invalid range");
      const bytes = decodePortableBase64Chunk(
        value.bytesBase64,
        "INTERNAL_ERROR",
        "Remote portable range encoding is invalid.",
      );
      if (bytes.byteLength !== endExclusive - start) throw new Error("range length mismatch");
      return {
        kind: "portable_artifact_download_range",
        status: "ok",
        bytes,
        start,
        endExclusive,
        totalLength,
      };
    }
    assertRemotePortableOutcome(value);
    return value;
  } catch {
    throw new CapletsError(
      "INTERNAL_ERROR",
      "Remote portable operation returned an invalid outcome.",
    );
  }
}

function assertRemotePortableOutcome(
  value: unknown,
): asserts value is Exclude<
  CurrentHostPortableOperationOutcome,
  { kind: "portable_artifact_download_range" }
> {
  if (!isPlainObject(value) || !Object.hasOwn(value, "kind") || !Object.hasOwn(value, "status")) {
    throw new Error("invalid portable outcome");
  }
  switch (value.kind) {
    case "portable_status":
      remotePortableObject(value, ["kind", "status", "health", "guidanceCode"]);
      remotePortableEnum(value.status, ["live", "stale-read-only", "not-ready"]);
      remotePortableHealth(value.health);
      remotePortableText(value.guidanceCode);
      return;
    case "portable_import_session_create":
    case "portable_import_session_status":
    case "portable_import_session_append": {
      remotePortableObject(value, ["kind", "status", "session"]);
      const expectedStatus =
        value.kind === "portable_import_session_create"
          ? "created"
          : value.kind === "portable_import_session_status"
            ? "ok"
            : "accepted";
      remotePortableEnum(value.status, [expectedStatus]);
      remotePortableSession(value.session);
      return;
    }
    case "portable_import_session_finalize":
      remotePortableObject(value, ["kind", "status", "session", "artifact"]);
      remotePortableEnum(value.status, ["finalized"]);
      remotePortableSession(value.session);
      remotePortableArtifact(value.artifact);
      return;
    case "portable_import_preview":
      if (value.status === "previewed") {
        remotePortableObject(value, ["kind", "status", "proposal"]);
        remotePortableProposal(value.proposal);
      } else {
        remotePortableObject(value, ["kind", "status", "reason"]);
        remotePortableEnum(value.status, ["rejected"]);
        remotePortableRejectedReason(value.reason);
      }
      return;
    case "portable_import_activate":
      if (value.status === "committed") {
        remotePortableObject(value, ["kind", "status", "receipt", "caplet"]);
        remotePortableReceipt(value.receipt);
        remotePortableCaplet(value.caplet, true);
      } else {
        remotePortableObject(value, ["kind", "status", "reason"]);
        remotePortableEnum(value.status, ["rejected"]);
        remotePortableRejectedReason(value.reason);
      }
      return;
    case "portable_setup_revalidate":
      if (value.status === "committed") {
        remotePortableObject(value, ["kind", "status", "receipt", "caplet"]);
        remotePortableReceipt(value.receipt);
        remotePortableCaplet(value.caplet, false);
      } else {
        remotePortableObject(value, ["kind", "status", "reason"]);
        remotePortableEnum(value.status, ["rejected"]);
        remotePortableRejectedReason(value.reason);
      }
      return;
    case "portable_export_create":
      remotePortableObject(value, ["kind", "status", "artifact", "artifactType"]);
      remotePortableEnum(value.status, ["created"]);
      remotePortableArtifact(value.artifact);
      remotePortableEnum(value.artifactType, ["file", "bundle"]);
      return;
    default:
      throw new Error("unknown portable outcome");
  }
}

function remotePortableObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error("not an object");
  const allowed = [...required, ...optional];
  if (
    required.some((field) => !Object.hasOwn(value, field)) ||
    Object.keys(value).some((field) => !allowed.includes(field))
  ) {
    throw new Error("invalid fields");
  }
}

function remotePortableText(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value.includes("\0")
  ) {
    throw new Error("invalid text");
  }
}

function remotePortableEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error("invalid enum");
  }
}

function remotePortableInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid integer");
  }
  return value;
}

function remotePortableDigest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error("invalid digest");
  }
}

function remotePortableTimestamp(value: unknown): asserts value is string {
  remotePortableText(value);
  if (!Number.isFinite(Date.parse(value))) throw new Error("invalid timestamp");
}

function remotePortableReference(value: unknown): void {
  remotePortableObject(value, [
    "uri",
    "artifactId",
    "logicalHostId",
    "storeId",
    "providerIdentityId",
    "actorId",
    "operationId",
    "direction",
    "byteLength",
    "sha256",
    "mimeType",
    "expiresAt",
  ]);
  remotePortableText(value.uri);
  const parsed = parsePortableArtifactReference(value.uri);
  if (!isDeepStrictEqual(parsed, value)) throw new Error("inconsistent artifact reference");
}

function remotePortableArtifact(value: unknown): void {
  remotePortableObject(value, ["reference", "sha256", "byteLength", "mimeType"]);
  remotePortableReference(value.reference);
  remotePortableDigest(value.sha256);
  remotePortableInteger(value.byteLength);
  remotePortableText(value.mimeType);
  if (
    !isPlainObject(value.reference) ||
    value.sha256 !== value.reference.sha256 ||
    value.byteLength !== value.reference.byteLength ||
    value.mimeType !== value.reference.mimeType
  ) {
    throw new Error("inconsistent artifact");
  }
}

function remotePortableSession(value: unknown): void {
  remotePortableObject(
    value,
    [
      "sessionId",
      "artifactId",
      "actorId",
      "operationId",
      "direction",
      "state",
      "nextOffset",
      "expectedByteLength",
      "expectedSha256",
      "mimeType",
      "providerIdentityId",
      "expiresAt",
    ],
    ["finalizedAt", "revokedAt"],
  );
  for (const field of [
    "sessionId",
    "artifactId",
    "actorId",
    "operationId",
    "mimeType",
    "providerIdentityId",
  ]) {
    remotePortableText(value[field]);
  }
  remotePortableEnum(value.direction, ["upload", "download"]);
  remotePortableEnum(value.state, ["uploading", "finalized", "consumed", "revoked", "expired"]);
  remotePortableInteger(value.nextOffset);
  remotePortableInteger(value.expectedByteLength);
  remotePortableDigest(value.expectedSha256);
  remotePortableTimestamp(value.expiresAt);
  if (value.finalizedAt !== undefined) remotePortableTimestamp(value.finalizedAt);
  if (value.revokedAt !== undefined) remotePortableTimestamp(value.revokedAt);
}

function remotePortableProposal(value: unknown): void {
  remotePortableObject(
    value,
    [
      "proposalId",
      "artifactId",
      "actorId",
      "operationId",
      "capletId",
      "proposalHash",
      "expectedAuthorityGeneration",
      "expectedEffectiveGeneration",
      "expectedAggregateVersion",
      "expectedSecurityEpoch",
      "expectedRuntimeFingerprint",
      "collisionPolicy",
      "replacementConfirmed",
      "consequence",
      "differences",
      "setupDependencies",
      "state",
      "expiresAt",
    ],
    ["consumedAt"],
  );
  for (const field of [
    "proposalId",
    "artifactId",
    "actorId",
    "operationId",
    "capletId",
    "expectedRuntimeFingerprint",
  ]) {
    remotePortableText(value[field]);
  }
  remotePortableDigest(value.proposalHash);
  for (const field of [
    "expectedAuthorityGeneration",
    "expectedEffectiveGeneration",
    "expectedAggregateVersion",
    "expectedSecurityEpoch",
  ]) {
    remotePortableInteger(value[field]);
  }
  remotePortableEnum(value.collisionPolicy, ["reject", "replace"]);
  if (typeof value.replacementConfirmed !== "boolean") throw new Error("invalid confirmation");
  remotePortableEnum(value.consequence, [
    "effective-runtime-changes",
    "no-effective-change-while-shadowed",
  ]);
  if (!Array.isArray(value.differences) || !Array.isArray(value.setupDependencies)) {
    throw new Error("invalid proposal collections");
  }
  for (const difference of value.differences) {
    remotePortableObject(difference, ["field", "effect"], ["beforeHash", "afterHash"]);
    remotePortableText(difference.field);
    remotePortableEnum(difference.effect, ["added", "changed", "removed", "unchanged"]);
    if (difference.beforeHash !== undefined) remotePortableDigest(difference.beforeHash);
    if (difference.afterHash !== undefined) remotePortableDigest(difference.afterHash);
  }
  for (const dependency of value.setupDependencies) {
    remotePortableObject(dependency, ["name", "type", "status"]);
    remotePortableText(dependency.name);
    remotePortableEnum(dependency.type, ["local", "external", "unresolved-setup"]);
    remotePortableEnum(dependency.status, ["required", "satisfied"]);
  }
  remotePortableEnum(value.state, ["previewed", "consumed", "expired", "rejected"]);
  remotePortableTimestamp(value.expiresAt);
  if (value.consumedAt !== undefined) remotePortableTimestamp(value.consumedAt);
}

function remotePortableBinding(value: unknown): void {
  const parsed = parseCurrentHostOperationBinding(value);
  if (!isDeepStrictEqual(parsed, value)) throw new Error("invalid binding");
}

function remotePortableReceipt(value: unknown): void {
  remotePortableObject(
    value,
    ["status", "binding", "aggregateVersion", "authorityToken", "localApplication", "convergence"],
    ["management"],
  );
  remotePortableEnum(value.status, ["committed"]);
  remotePortableBinding(value.binding);
  remotePortableInteger(value.aggregateVersion);
  remotePortableObject(value.authorityToken, ["authorityGeneration", "effectiveGeneration"]);
  remotePortableInteger(value.authorityToken.authorityGeneration);
  remotePortableInteger(value.authorityToken.effectiveGeneration);
  remotePortableEnum(value.localApplication, ["applied", "pending", "not-applicable"]);
  remotePortableObject(value.convergence, ["kind"]);
  switch (value.convergence.kind) {
    case "single-node":
      break;
    case "pending":
    case "overdue":
      remotePortableObject(value.convergence, ["kind", "deadline", "requiredNodes"]);
      remotePortableTimestamp(value.convergence.deadline);
      remotePortableInteger(value.convergence.requiredNodes);
      break;
    case "converged":
      remotePortableObject(value.convergence, ["kind", "appliedNodes"]);
      remotePortableInteger(value.convergence.appliedNodes);
      break;
    default:
      throw new Error("invalid convergence");
  }
  if (value.management !== undefined) remotePortableManagementTarget(value.management);
}

function remotePortableManagementTarget(value: unknown): void {
  remotePortableObject(value, [
    "resource",
    "id",
    "selector",
    "owner",
    "source",
    "effective",
    "effectiveChanged",
    "shadowChain",
    "underlyingSqlAvailable",
    "consequence",
  ]);
  remotePortableEnum(value.resource, ["caplet", "host-setting"]);
  remotePortableText(value.id);
  remotePortableEnum(value.selector, ["effective", "underlying-sql"]);
  remotePortableEnum(value.owner, ["sql", "filesystem"]);
  if (!isPlainObject(value.source) || typeof value.source.kind !== "string") {
    throw new Error("invalid source");
  }
  for (const field of ["effective", "effectiveChanged", "underlyingSqlAvailable"]) {
    if (typeof value[field] !== "boolean") throw new Error("invalid management flag");
  }
  if (!Array.isArray(value.shadowChain)) throw new Error("invalid shadow chain");
  for (const layer of value.shadowChain) {
    remotePortableObject(layer, ["owner", "source"], ["provenance"]);
    remotePortableEnum(layer.owner, ["sql", "filesystem"]);
    if (!isPlainObject(layer.source) || typeof layer.source.kind !== "string") {
      throw new Error("invalid ownership source");
    }
    if (layer.provenance !== undefined && !isPlainObject(layer.provenance)) {
      throw new Error("invalid provenance");
    }
  }
  remotePortableEnum(value.consequence, [
    "effective-runtime-changes",
    "no-effective-change-while-shadowed",
  ]);
}

function remotePortableHealth(value: unknown): void {
  remotePortableObject(
    value,
    [
      "backend",
      "readiness",
      "connectivity",
      "migration",
      "authorityToken",
      "bootstrapCompatibility",
      "convergence",
      "guidanceCode",
    ],
    ["staleAgeMs"],
  );
  remotePortableEnum(value.backend, ["sqlite", "postgres"]);
  remotePortableEnum(value.readiness, ["ready", "not-ready", "stale-read-only"]);
  remotePortableEnum(value.connectivity, ["connected", "unavailable"]);
  remotePortableEnum(value.migration, ["current", "blocked"]);
  remotePortableObject(value.authorityToken, ["authorityGeneration", "effectiveGeneration"]);
  remotePortableInteger(value.authorityToken.authorityGeneration);
  remotePortableInteger(value.authorityToken.effectiveGeneration);
  remotePortableEnum(value.bootstrapCompatibility, ["current", "staged", "incompatible"]);
  remotePortableEnum(value.convergence, ["single-node", "within-budget", "pending", "overdue"]);
  remotePortableEnum(value.guidanceCode, [
    "ok",
    "storage-unavailable",
    "migration-required",
    "convergence-pending",
    "convergence-overdue",
    "bootstrap-incompatible",
  ]);
  if (value.staleAgeMs !== undefined) remotePortableInteger(value.staleAgeMs);
}

function remotePortableCaplet(value: unknown, includeSetupDependencies: boolean): void {
  remotePortableObject(
    value,
    includeSetupDependencies ? ["id", "activation", "setupDependencies"] : ["id", "activation"],
  );
  remotePortableText(value.id);
  remotePortableEnum(value.activation, [
    "active",
    "setup-required",
    "dormant-shadowed",
    "disabled",
  ]);
  if (includeSetupDependencies) {
    if (!Array.isArray(value.setupDependencies)) throw new Error("invalid setup dependencies");
    for (const dependency of value.setupDependencies) {
      remotePortableObject(dependency, ["name", "type", "status"]);
      remotePortableText(dependency.name);
      remotePortableEnum(dependency.type, ["local", "external", "unresolved-setup"]);
      remotePortableEnum(dependency.status, ["required", "satisfied"]);
    }
  }
}

function remotePortableRejectedReason(value: unknown): void {
  remotePortableEnum(value, [
    "filesystem-owned",
    "sql-collision",
    "invalid-artifact",
    "stale",
    "changed-bytes",
    "revoked-actor",
    "consumed",
    "expired",
    "replacement-unconfirmed",
    "collision",
    "stale-generation",
    "stale-caplet",
    "not-found",
    "proposal-mismatch",
    "wrong-actor",
    "wrong-operation",
    "setup-incomplete",
  ]);
}

async function importPortableArtifactFromPath(
  io: CliIO,
  path: string,
  options: PortableCommandOptions & {
    collisionPolicy: string;
    confirmReplacement?: boolean | undefined;
  },
): Promise<CurrentHostPortableOperationOutcome> {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 256 * 1024 * 1024) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Portable artifact must be a file between 1 byte and 256 MiB.",
    );
  }
  if (options.collisionPolicy !== "reject" && options.collisionPolicy !== "replace") {
    throw new CapletsError("REQUEST_INVALID", "collision policy must be reject or replace.");
  }
  const bytes = readFileSync(path);
  const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
  const created = await executePortableCliOperation(
    io,
    {
      kind: "portable_import_session_create",
      expectedByteLength: bytes.byteLength,
      expectedSha256: artifactSha256,
      mimeType: "application/vnd.caplets.portable+json",
    },
    options,
  );
  if (created.kind !== "portable_import_session_create") {
    throw new CapletsError(
      "INTERNAL_ERROR",
      "Portable upload session returned an invalid outcome.",
    );
  }
  const operationOptions = { ...options, operationId: created.session.operationId };
  for (let offset = 0; offset < bytes.byteLength; offset += PORTABLE_CHUNK_SIZE_BYTES) {
    const chunk = bytes.subarray(
      offset,
      Math.min(bytes.byteLength, offset + PORTABLE_CHUNK_SIZE_BYTES),
    );
    const appended = await executePortableCliOperation(
      io,
      {
        kind: "portable_import_session_append",
        sessionId: created.session.sessionId,
        offset,
        chunkSha256: createHash("sha256").update(chunk).digest("hex"),
        bytesBase64: chunk.toString("base64"),
      },
      operationOptions,
    );
    if (
      appended.kind !== "portable_import_session_append" ||
      appended.session.nextOffset !== offset + chunk.byteLength
    ) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Portable upload did not accept the next offset.",
      );
    }
  }
  const finalized = await executePortableCliOperation(
    io,
    {
      kind: "portable_import_session_finalize",
      sessionId: created.session.sessionId,
    },
    operationOptions,
  );
  if (finalized.kind !== "portable_import_session_finalize") {
    throw new CapletsError(
      "INTERNAL_ERROR",
      "Portable upload finalize returned an invalid outcome.",
    );
  }
  return executePortableCliOperation(
    io,
    {
      kind: "portable_import_preview",
      artifactReference: finalized.artifact.reference,
      collisionPolicy: options.collisionPolicy,
      replacementConfirmed: options.confirmReplacement ?? false,
    },
    operationOptions,
  );
}

async function exportPortableArtifactToPath(
  io: CliIO,
  capletId: string,
  path: string,
  options: PortableCommandOptions & { underlyingSql?: boolean | undefined },
): Promise<Extract<CurrentHostPortableOperationOutcome, { kind: "portable_export_create" }>> {
  const exported = await executePortableCliOperation(
    io,
    {
      kind: "portable_export_create",
      capletId,
      selector: options.underlyingSql ? "underlying-sql" : "effective",
    },
    options,
  );
  if (exported.kind !== "portable_export_create") {
    throw new CapletsError("INTERNAL_ERROR", "Portable export returned an invalid outcome.");
  }
  const chunks: Buffer[] = [];
  const operationOptions = {
    ...options,
    operationId: exported.artifact.reference.operationId,
  };
  for (let start = 0; start < exported.artifact.byteLength; start += PORTABLE_CHUNK_SIZE_BYTES) {
    const downloaded = await executePortableCliOperation(
      io,
      {
        kind: "portable_artifact_download_range",
        artifactReference: exported.artifact.reference,
        start,
        endExclusive: Math.min(exported.artifact.byteLength, start + PORTABLE_CHUNK_SIZE_BYTES),
      },
      operationOptions,
    );
    if (downloaded.kind !== "portable_artifact_download_range") {
      throw new CapletsError("INTERNAL_ERROR", "Portable download returned an invalid outcome.");
    }
    chunks.push(Buffer.from(downloaded.bytes));
  }
  const bytes = Buffer.concat(chunks);
  if (
    bytes.byteLength !== exported.artifact.byteLength ||
    createHash("sha256").update(bytes).digest("hex") !== exported.artifact.sha256
  ) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Portable download hash or length did not match.");
  }
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  return exported;
}
async function executePortableCliOperation(
  io: CliIO,
  value: unknown,
  options: PortableCommandOptions,
): Promise<CurrentHostPortableOperationOutcome> {
  if (options.global === options.remote) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Portable operations require exactly one of --global or --remote.",
    );
  }
  if (!isPlainObject(value) || Object.hasOwn(value, "binding")) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Portable operation JSON must be an object without binding.",
    );
  }
  if (options.remote) {
    if (value.kind === "portable_status") return remotePortableStatusForCli(io);
    const outcome = await requestTypedRemote(io, "current_host_portable", {
      operation: value,
      ...(options.operationId ? { operationId: options.operationId } : {}),
    });
    return parseRemotePortableOutcome(outcome);
  }

  return withCurrentHostManagement(io, (client) => {
    const normalized = normalizeLocalPortableOperation(value);
    const temporaryBinding = client.createBinding(
      normalized,
      options.operationId ? { operationId: options.operationId } : {},
    );
    const parsed = parseCurrentHostPortableOperation(normalized, { binding: temporaryBinding });
    const { binding: _binding, ...operation } = parsed;
    return client.executePortable(operation as PortableOperationInput, options.operationId);
  });
}

function normalizeLocalPortableOperation(
  operation: Record<string, unknown>,
): Record<string, unknown> {
  if (operation.kind !== "portable_import_session_append") return operation;
  const bytes = decodePortableBase64Chunk(
    operation.bytesBase64,
    "REQUEST_INVALID",
    "Portable artifact chunk encoding is invalid.",
  );
  const { bytesBase64: _encoded, ...fields } = operation;
  return { ...fields, bytes };
}

function writePortableStatus(
  writeOut: (value: string) => void,
  outcome: CurrentHostPortableOperationOutcome,
  json: boolean,
): void {
  if (outcome.kind !== "portable_status") {
    throw new CapletsError("INTERNAL_ERROR", "Portable status returned an invalid outcome.");
  }
  if (json) {
    writeOut(`${JSON.stringify(outcome)}\n`);
    return;
  }
  writeOut(
    [
      `Status: ${outcome.status}`,
      `Backend: ${outcome.health.backend}`,
      `Readiness: ${outcome.health.readiness}`,
      `Connectivity: ${outcome.health.connectivity}`,
      `Migration: ${outcome.health.migration}`,
      `Convergence: ${outcome.health.convergence}`,
      `Guidance: ${outcome.guidanceCode}`,
      "",
    ].join("\n"),
  );
}

function writePortableOperationOutcome(
  writeOut: (value: string) => void,
  setExitCode: (code: number) => void,
  outcome: CurrentHostPortableOperationOutcome,
  json: boolean,
): void {
  const rejected = "status" in outcome && outcome.status === "rejected";
  if (rejected) setExitCode(1);
  if (json || !rejected) {
    writeOut(`${JSON.stringify(outcome)}\n`);
    return;
  }
  const reason = "reason" in outcome ? outcome.reason : "blocked";
  writeOut(
    `Portable operation rejected: ${reason}. Run 'caplets storage portable status' for recovery guidance.\n`,
  );
}

type ManagementCommandOptions = {
  global?: boolean | undefined;
  remote?: boolean | undefined;
  operationId?: string | undefined;
};

function resolveCurrentHostManagementTarget(
  options: ManagementCommandOptions,
): "global" | "remote" {
  if (options.global === options.remote) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Current Host management requires exactly one of --global or --remote.",
    );
  }
  return options.remote ? "remote" : "global";
}

function remoteManagementBindingArguments(
  request: unknown,
  requestedOperationId?: string | undefined,
): { operationId: string; requestIdentity: string } {
  const operationId = requestedOperationId ?? `operation_${randomUUID()}`;
  if (!/^[A-Za-z0-9_-]{1,160}$/u.test(operationId)) {
    throw new CapletsError("REQUEST_INVALID", "Current Host operation ID is invalid.");
  }
  return {
    operationId,
    requestIdentity: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
  };
}

function writeCurrentHostManagementOutcome(
  writeOut: (value: string) => void,
  setExitCode: (code: number) => void,
  outcome: unknown,
  successfulStatuses: readonly string[],
): void {
  if (!isPlainObject(outcome) || typeof outcome.status !== "string") {
    throw new CapletsError(
      "INTERNAL_ERROR",
      "Current Host management returned an invalid outcome.",
    );
  }
  if (!successfulStatuses.includes(outcome.status)) setExitCode(1);
  writeOut(`${JSON.stringify(outcome)}\n`);
}

function parseCurrentHostManagementResource(value: string): CurrentHostManagementResource {
  if (value === "caplet" || value === "host-setting") return value;
  throw new CapletsError(
    "REQUEST_INVALID",
    "Current Host management resource must be caplet or host-setting.",
  );
}

function parseJsonArgument(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new CapletsError("REQUEST_INVALID", "Current Host management JSON is invalid.");
  }
}
