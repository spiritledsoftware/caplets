import type { ProjectBindingWebSocketFactory } from "@caplets/sdk/project-binding";
import { Command, CommanderError, Option } from "commander";
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { version as packageJsonVersion } from "../package.json";
import {
  addCliCaplet,
  addGoogleDiscoveryCaplet,
  addGraphqlCaplet,
  addHttpCaplet,
  addMcpCaplet,
  addOpenApiCaplet,
} from "./cli/add";
import {
  loginAuth,
  logoutAuth,
  formatAuthRows,
  listLocalAuthRows,
  localAuthConfigForTarget,
  localAuthTargets,
  refreshAuth,
  type AuthSource,
  type AuthStatusRow,
} from "./cli/auth";
import { cliCommands } from "./cli/commands";
import { codeModeTypesCli, runCodeModeCli, runCodeModeReplCli } from "./cli/code-mode";
import { initConfig } from "./cli/init";
import { doctorJsonReport, formatDoctorReport } from "./cli/doctor";
import {
  completeCliWords,
  completionScript,
  completionShells,
  trailingSpaceCompletionToken,
  type CompletionShell,
} from "./cli/completion";
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
} from "./install";
import type { CatalogIndexingResult } from "./catalog-indexing/payload";
import { readCapletsLockfile } from "./lockfile";
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
  type LocalOverlayConfigWithSources,
  defaultUpdateCheckCacheDir,
  defaultUpdateCheckStateDir,
  formatVaultRecoveryCommand,
  loadGlobalServeDefaults,
  loadConfigWithSources,
  loadConfigWithHostStorage,
  loadLocalOverlayConfigWithSources,
  loadHostStorageConfig,
  resolveCapletsRoot,
  resolveConfigPath,
  resolveProjectCapletsRoot,
  resolveProjectConfigPath,
  resolveProjectLockfilePath,
  vaultBootstrapResolver,
} from "./config";
import { CapletsEngine } from "./engine";
import { CapletsError } from "./errors";
import { resolveAttachServeOptions, type AttachServeOptions } from "./attach/options";
import { attachResolvedCaplets } from "./attach/server";
import { attachProjectOnce } from "./project-binding/attach";
import { ProjectBindingError } from "./project-binding/errors";
import { createSdkRemoteCapletsClient } from "./native/remote";
import { createRemoteAdminCommandAdapter } from "./remote-cli/admin";
import { createRemoteAttachCommandAdapter } from "./remote-cli/attach";
import { RemoteCliClient, type RemoteCliCommandAdapter } from "./remote-cli/client";
import { createRemotePublicAuthAdapter } from "./remote-cli/public-auth";
import { materializeRemoteBundleDownload, type RemoteBundleDownload } from "./remote-cli/bundle";
import type { RemoteCliCommand } from "./remote-cli/types";
import { createRemoteProfileStore, type FileRemoteProfileStore } from "./remote/profile-store";
import type { RemoteClientRole } from "./remote/server-credentials";
import { resolveRemoteSelection } from "./remote/selection";
import { resolveRemoteMode } from "./remote/options";
import { remoteProfileStatus, type RemoteProfileStatus } from "./remote/profiles";
import { canonicalizeCurrentHostOrigin } from "./current-host/origin";
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
import {
  defaultAuthDir,
  defaultCacheBaseDir,
  defaultCapletsLockfilePath,
  defaultStateBaseDir,
  defaultTelemetryStateDir,
} from "./config/paths";
import { currentHostV1Url } from "./current-host/topology";
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
import {
  VAULT_MAX_VALUE_BYTES,
  validateVaultKeyName,
  type VaultDeleteStatus,
  type VaultValueStatus,
} from "./vault";
import {
  createHostStorage,
  createHostStorageVaultResolver,
  migrateHostStorage,
  migrateLegacyHostState,
  type BackendAuthStateStore,
  type HostStorage,
  type RemoteSecurityStore,
  type StoredVaultGrant,
} from "./storage";
import { type CapletRecordView } from "./storage/caplet-records";
import {
  installSqlCatalogCaplets,
  inspectCapletBundleFiles,
  readCapletBundleFiles,
  updateSqlCatalogCaplets,
} from "./storage/catalog-lifecycle";

export { initConfig, starterConfig } from "./cli/init";
export { installCaplets, normalizeGitRepo } from "./install";
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
  remoteStatePath?: string;
  upstreamUrl?: string;
  allowUnauthenticatedHttp?: boolean;
  trustProxy?: boolean;
  adminUploadStagingDir?: string;
  adminUploadMaxConcurrent?: string;
  adminUploadMaxStagedBytes?: string;
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
    .option("--admin-upload-staging-dir <path>", "directory used to stage Admin API bundle uploads")
    .option(
      "--admin-upload-max-concurrent <count>",
      "maximum number of active Admin API bundle uploads",
    )
    .option(
      "--admin-upload-max-staged-bytes <bytes>",
      "maximum aggregate bytes reserved by staged Admin API bundle uploads",
    )
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
  if (command === cliCommands.remote) return { commandFamily: "remote", surface: "cli" };
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
  return mode === "remote" || mode === "local" ? mode : "unknown";
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
  allowUnauthenticatedHttp?: boolean;
  trustProxy?: boolean;
}): void {
  const invalid = [
    options.transport !== undefined ? "--transport" : undefined,
    options.host !== undefined ? "--host" : undefined,
    options.port !== undefined ? "--port" : undefined,
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

async function useRemoteSecurityStore<T>(
  statePath: string | undefined,
  configPath: string | undefined,
  run: (store: RemoteSecurityStore) => Promise<T>,
): Promise<T> {
  if (statePath !== undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "--state-path no longer selects server credential state; configure Authoritative Host State storage instead.",
    );
  }
  const storage = await createHostStorage(loadHostStorageConfig(configPath));
  try {
    return await run(storage.remoteSecurity);
  } finally {
    await storage.close();
  }
}
async function useBackendAuthStore<T>(
  configPath: string | undefined,
  run: (store: BackendAuthStateStore) => Promise<T>,
): Promise<T> {
  const storage = await createHostStorage(loadHostStorageConfig(configPath));
  try {
    return await run(storage.backendAuth);
  } finally {
    await storage.close();
  }
}
async function useConfiguredHostStorage<T>(
  configPath: string | undefined,
  run: (storage: HostStorage) => Promise<T>,
): Promise<T> {
  const storage = await createHostStorage(loadHostStorageConfig(configPath));
  try {
    return await run(storage);
  } finally {
    await storage.close();
  }
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
    ...(options.remoteStatePath !== undefined ? { remoteStatePath: options.remoteStatePath } : {}),
    ...(options.upstreamUrl !== undefined ? { upstreamUrl: options.upstreamUrl } : {}),
    ...(options.allowUnauthenticatedHttp !== undefined
      ? { allowUnauthenticatedHttp: options.allowUnauthenticatedHttp }
      : {}),
    ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
    ...(options.adminUploadStagingDir !== undefined
      ? { adminUploadStagingDir: options.adminUploadStagingDir }
      : {}),
    ...(options.adminUploadMaxConcurrent !== undefined
      ? { adminUploadMaxConcurrent: options.adminUploadMaxConcurrent }
      : {}),
    ...(options.adminUploadMaxStagedBytes !== undefined
      ? { adminUploadMaxStagedBytes: options.adminUploadMaxStagedBytes }
      : {}),
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
  hostIdentity?: string | undefined;
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
    ...(typeof record.origin === "string"
      ? { hostIdentity: record.origin }
      : typeof record.hostUrl === "string"
        ? { hostIdentity: record.hostUrl }
        : {}),
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

async function pendingRemoteLogin(
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
  const baseUrl = new URL(canonicalizeCurrentHostOrigin(url));
  const startBody = input.clientLabel ? { clientLabel: input.clientLabel } : {};
  const start = await fetchImpl(currentHostV1Url(baseUrl, "remoteLoginStart"), {
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
        const refresh = await fetchImpl(currentHostV1Url(baseUrl, "remoteLoginRefresh"), {
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
      currentHostV1Url(baseUrl, "remoteLoginComplete"),
      pendingRemoteLoginCompletionRequest(pending, signal),
    );
  } catch {
    return fetchImpl(
      currentHostV1Url(baseUrl, "remoteLoginComplete"),
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
  return fetchImpl(currentHostV1Url(baseUrl, "remoteLoginPoll"), {
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
  await fetchImpl(currentHostV1Url(baseUrl, "remoteLoginCancel"), {
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

async function revokeRemoteClient(
  remoteUrl: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const revokeUrl = currentHostV1Url(remoteUrl, "remoteClient");
  await fetchImpl(revokeUrl, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function refreshedRemoteAccessToken(
  remoteUrl: string,
  fallbackAccessToken: string,
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
  return selection.kind === "remote" && selection.remote.auth.type === "bearer"
    ? selection.remote.auth.token
    : fallbackAccessToken;
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
  const origin = typeof status.origin === "string" ? status.origin : "unknown Current Host";
  writeOut(
    status.authenticated
      ? `Authenticated Remote Profile for ${origin}.\n`
      : `No authenticated Remote Profile for ${origin}.\n`,
  );
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
          const localSuggestions = await completeCliWordsLocally(completionWords, {
            ...(configPath ? { configPath } : {}),
            projectConfigPath: envProjectConfigPath(env),
            ...(io.authDir ? { authDir: io.authDir } : {}),
            config: localOverlay.config,
          });
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
    .option("--admin-upload-staging-dir <path>", "directory used to stage Admin API bundle uploads")
    .option(
      "--admin-upload-max-concurrent <count>",
      "maximum number of active Admin API bundle uploads",
    )
    .option(
      "--admin-upload-max-staged-bytes <bytes>",
      "maximum aggregate bytes reserved by staged Admin API bundle uploads",
    )
    .action(
      async (options: {
        transport?: string;
        host?: string;
        port?: string;
        remoteStatePath?: string;
        upstreamUrl?: string;
        allowUnauthenticatedHttp?: boolean;
        trustProxy?: boolean;
        adminUploadStagingDir?: string;
        adminUploadMaxConcurrent?: string;
        adminUploadMaxStagedBytes?: string;
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
    .addOption(
      new Option(
        "--remote-url <url>",
        "legacy alias for the remote Caplets service base URL",
      ).hideHelp(),
    )
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

  const remote = program
    .command(cliCommands.remote)
    .description("Manage Current Host Remote Profiles.");
  remote
    .command("login")
    .description("Create a Remote Profile for a Current Host.")
    .argument("<origin>", "Current Host origin")
    .option("--client-label <label>", "client label for this machine")
    .option("--json", "print JSON output")
    .action(
      async (
        originInput: string,
        options: {
          clientLabel?: string;
          json?: boolean;
        },
      ) => {
        const origin = canonicalizeCurrentHostOrigin(originInput);
        const interrupt = cliInterruptSignal(io.signal);
        let credentials: RemoteLoginCredentialsResponse;
        try {
          credentials = await pendingRemoteLogin(origin, {
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
        const status = await remoteProfileStore(io.authDir, env).saveRemoteProfile({
          origin,
          ...(credentials.hostIdentity
            ? { hostIdentity: canonicalizeCurrentHostOrigin(credentials.hostIdentity) }
            : {}),
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
    .description("Show the Remote Profile status for a Current Host.")
    .argument("<origin>", "Current Host origin")
    .option("--json", "print JSON output")
    .action(async (originInput: string, options: { json?: boolean }) => {
      const origin = canonicalizeCurrentHostOrigin(originInput);
      const status =
        (await remoteProfileStore(io.authDir, env).getRemoteProfileStatus({ origin })) ??
        remoteProfileStatus({ origin });
      writeRemoteStatus(status, options.json === true, writeOut);
    });

  remote
    .command("list")
    .description("List saved Current Host Remote Profiles.")
    .option("--json", "print JSON output")
    .action(async (options: { json?: boolean }) => {
      const profiles = await remoteProfileStore(io.authDir, env).listRemoteProfileStatuses();
      if (options.json) {
        writeOut(`${JSON.stringify({ profiles }, null, 2)}\n`);
        return;
      }
      if (profiles.length === 0) {
        writeOut("No saved Remote Profiles.\n");
        return;
      }
      for (const profile of profiles) writeRemoteStatus(profile, false, writeOut);
    });

  remote
    .command("logout")
    .description("Remove the Remote Profile for a Current Host.")
    .argument("<origin>", "Current Host origin")
    .option("--json", "print JSON output")
    .action(async (originInput: string, options: { json?: boolean }) => {
      const origin = canonicalizeCurrentHostOrigin(originInput);
      const store = remoteProfileStore(io.authDir, env);
      const loaded = await store.refreshRemoteProfileIfNeeded({
        origin,
        needsRefresh: () => false,
        refresh: async () => {
          throw new CapletsError("AUTH_REFRESH_FAILED", "Unexpected Remote Profile refresh.");
        },
      });
      const storedAccessToken = loaded?.credential.accessToken;
      if (storedAccessToken) {
        const accessToken = await refreshedRemoteAccessToken(
          origin,
          storedAccessToken,
          { authDir: io.authDir, ...(io.fetch ? { fetch: io.fetch } : {}) },
          env,
        ).catch(() => storedAccessToken);
        await revokeRemoteClient(origin, accessToken, io.fetch).catch(() => undefined);
      }
      const removed = await store.logoutRemoteProfile({ origin });
      if (options.json) {
        writeOut(`${JSON.stringify({ loggedOut: removed, origin }, null, 2)}\n`);
        return;
      }
      writeOut(
        removed
          ? `Logged out Remote Profile for ${origin}.\n`
          : `No Remote Profile found for ${origin}.\n`,
      );
    });

  const remoteHost = remote.command("host").description("Manage Current Host remote credentials.");
  remoteHost
    .command("clients")
    .description("List paired Current Host remote clients from server state.")
    .option("--state-path <path>", "deprecated; Authoritative Host State uses SQL storage")
    .option("--json", "print JSON output")
    .action(async (options: { statePath?: string; json?: boolean }) => {
      const clients = await useRemoteSecurityStore(
        options.statePath,
        currentConfigPath(),
        async (store) => await store.listClients(),
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
    .description("List pending Current Host Remote Login approvals from server state.")
    .option("--state-path <path>", "deprecated; Authoritative Host State uses SQL storage")
    .option("--json", "print JSON output")
    .action(async (options: { statePath?: string; json?: boolean }) => {
      const pendingLogins = await useRemoteSecurityStore(
        options.statePath,
        currentConfigPath(),
        async (store) => await store.listPendingLogins(),
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
    .description("Approve one pending Current Host Remote Login code from server state.")
    .argument("<code>", "operator-visible Remote Login code")
    .option("--state-path <path>", "deprecated; Authoritative Host State uses SQL storage")
    .option("--role <role>", "grant role override: access or operator", parseRemoteClientRole)
    .option("--yes", "approve without an interactive confirmation prompt")
    .option("--json", "print JSON output")
    .action(
      async (
        code: string,
        options: { statePath?: string; role?: RemoteClientRole; yes?: boolean; json?: boolean },
      ) => {
        if (!options.yes && !options.json) {
          throw new CapletsError("REQUEST_INVALID", "Use --yes to approve this pending login.");
        }
        const approved = await useRemoteSecurityStore(
          options.statePath,
          currentConfigPath(),
          async (store) =>
            await store.approvePendingLogin({
              operatorClientId: "local_cli",
              operatorCode: code,
              ...(options.role ? { grantedRole: options.role } : {}),
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
    .description("Deny one pending Current Host Remote Login code from server state.")
    .argument("<code>", "operator-visible Remote Login code")
    .option("--state-path <path>", "deprecated; Authoritative Host State uses SQL storage")
    .option("--json", "print JSON output")
    .action(async (code: string, options: { statePath?: string; json?: boolean }) => {
      const denied = await useRemoteSecurityStore(
        options.statePath,
        currentConfigPath(),
        async (store) =>
          await store.denyPendingLogin({
            operatorClientId: "local_cli",
            operatorCode: code,
          }),
      );
      if (options.json) {
        writeOut(`${JSON.stringify(denied, null, 2)}\n`);
        return;
      }
      writeOut(`Denied pending Remote Login ${denied.flowId}.\n`);
    });
  remoteHost
    .command("revoke")
    .description("Revoke one paired Current Host remote client from server state.")
    .argument("<client-id>", "remote client ID")
    .option("--state-path <path>", "deprecated; Authoritative Host State uses SQL storage")
    .option("--json", "print JSON output")
    .action(async (clientId: string, options: { statePath?: string; json?: boolean }) => {
      const revoked = await useRemoteSecurityStore(
        options.statePath,
        currentConfigPath(),
        async (store) => await store.revokeClient({ operatorClientId: "local_cli", clientId }),
      );
      if (options.json) {
        writeOut(`${JSON.stringify({ revoked, clientId }, null, 2)}\n`);
        return;
      }
      writeOut(revoked ? `Revoked ${clientId}.\n` : `No remote client found for ${clientId}.\n`);
    });

  program
    .command(cliCommands.init)
    .description("Create a starter Caplets config file.")
    .option("--project", "create the project Caplets config")
    .option("-g, --global", "create the user Caplets config")
    .option("--remote", "create the remote Caplets config")
    .option("--force", "overwrite an existing config file")
    .action(async (options: MutationTargetOptions & { force?: boolean }) => {
      const target = parseMutationTarget(options);
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
      writeOut(`Created ${localMutationTargetLabel(target, io)}Caplets config at ${path}\n`);
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
    .option("--target <target>", "Caplet setup target: local or remote", parseSetupTarget)
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
          target?: "local" | "remote";
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
      const doctorOptions = {
        env,
        ...(io.fetch ? { fetch: io.fetch } : {}),
        ...(io.authDir ? { authDir: io.authDir } : {}),
        ...(io.daemon ? { daemon: io.daemon } : {}),
      };
      const format = options.format ?? (options.json ? "json" : "plain");
      if (format === "json") {
        writeOut(`${JSON.stringify(await doctorJsonReport(doctorOptions), null, 2)}\n`);
        return;
      }
      writeOut(await formatDoctorReport(doctorOptions, format));
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
        const target = parseVaultTarget(options);
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
        const grantOrigin = options.grant ? localVaultGrantOrigin(options.grant, env) : undefined;

        const value = await readVaultValue(io);
        await useConfiguredHostStorage(currentConfigPath(), async (storage) => {
          const existed = (await storage.vaultValues.getStatus(name)).present;
          const previousValue =
            existed && options.grant ? await storage.vaultValues.resolveValue(name) : undefined;
          const status = await storage.vaultValues.set(name, value, {
            force: Boolean(options.force),
            operatorClientId: "local_cli",
          });
          try {
            if (options.grant) {
              await storage.vaultGrants.grant({
                capletId: options.grant,
                vaultKey: name,
                referenceName: options.as ?? name,
                ...grantOrigin!,
                operator: { role: "operator", clientId: "local_cli" },
              });
            }
          } catch (error) {
            if (existed && previousValue !== undefined) {
              await storage.vaultValues.set(name, previousValue, {
                force: true,
                operatorClientId: "local_cli",
              });
            } else {
              await storage.vaultValues.delete(name, { operatorClientId: "local_cli" });
            }
            throw error;
          }
          await storage.invalidateConfig("local_cli");
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
        });
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
        const target = parseVaultTarget(options);
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
          writeOut(formatVaultValueStatus(result as VaultValueStatus, Boolean(options.json)));
          return;
        }
        await useConfiguredHostStorage(currentConfigPath(), async (storage) => {
          if (options.show) {
            const value = await storage.vaultValues.resolveValue(name);
            writeOut(
              options.json ? `${JSON.stringify({ key: name, value }, null, 2)}\n` : `${value}\n`,
            );
            return;
          }
          writeOut(
            formatVaultValueStatus(
              await storage.vaultValues.getStatus(name),
              Boolean(options.json),
            ),
          );
        });
      },
    );

  vault
    .command("list")
    .description("List local/global Vault keys without revealing values.")
    .option("-g, --global", "target the local/global Vault")
    .option("--remote", "target the selected remote Vault")
    .option("--json", "print JSON output")
    .action(async (options: VaultTargetOptions & { json?: boolean }) => {
      const target = parseVaultTarget(options);
      if (target === "remote") {
        const result = await remoteVaultList(io);
        writeOut(formatVaultValueList(result as VaultValueStatus[], Boolean(options.json)));
        return;
      }
      await useConfiguredHostStorage(currentConfigPath(), async (storage) => {
        writeOut(
          formatVaultValueList(await storage.vaultValues.listValues(), Boolean(options.json)),
        );
      });
    });

  vault
    .command("delete")
    .description("Delete a local/global Vault value without revealing it.")
    .argument("<name>", "Vault key name")
    .option("-g, --global", "target the local/global Vault")
    .option("--remote", "target the selected remote Vault")
    .option("--json", "print JSON output")
    .action(async (name: string, options: VaultTargetOptions & { json?: boolean }) => {
      const target = parseVaultTarget(options);
      if (target === "remote") {
        const result = await remoteVaultDelete(io, name);
        writeOut(formatVaultDeleteStatus(result as VaultDeleteStatus, Boolean(options.json)));
        return;
      }
      await useConfiguredHostStorage(currentConfigPath(), async (storage) => {
        const grantsRetained = (await storage.vaultGrants.list()).filter(
          (grant) => grant.vaultKey === validateVaultKeyName(name),
        ).length;
        const result = await storage.vaultValues.delete(name, {
          operatorClientId: "local_cli",
        });
        if (result.deleted) await storage.invalidateConfig("local_cli");
        writeOut(
          formatVaultDeleteStatus(
            { key: result.key, deleted: result.deleted, grantsRetained },
            Boolean(options.json),
          ),
        );
      });
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
        const target = parseVaultTarget(options);
        if (target === "remote") {
          const grant = await remoteVaultAccessGrant(io, {
            name,
            capletId,
            referenceName: options.as ?? name,
          });
          writeOut(
            formatVaultAccessGrant(
              grant as Parameters<typeof formatVaultAccessGrant>[0],
              Boolean(options.json),
            ),
          );
          return;
        }
        const grantOrigin = localVaultGrantOrigin(capletId, env);
        await useConfiguredHostStorage(currentConfigPath(), async (storage) => {
          await storage.vaultGrants.grant({
            capletId,
            vaultKey: name,
            referenceName: options.as ?? name,
            ...grantOrigin,
            operator: { role: "operator", clientId: "local_cli" },
          });
          const grant = (await storage.vaultGrants.list(capletId)).find(
            (candidate) =>
              candidate.vaultKey === validateVaultKeyName(name) &&
              candidate.referenceName === validateVaultKeyName(options.as ?? name) &&
              candidate.originKind === grantOrigin.originKind &&
              (candidate.originPath ?? undefined) === grantOrigin.originPath,
          );
          if (!grant) {
            throw new CapletsError("INTERNAL_ERROR", "Vault access grant could not be reloaded.");
          }
          await storage.invalidateConfig("local_cli");
          writeOut(formatVaultAccessGrant(storedVaultGrantForCli(grant), Boolean(options.json)));
        });
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
        const target = parseVaultTarget(options);
        if (target === "remote") {
          const grants = await remoteVaultAccessList(io, {
            ...(name ? { name } : {}),
            ...(capletFilter ? { capletId: capletFilter } : {}),
          });
          writeOut(
            formatVaultAccessList(
              grants as Parameters<typeof formatVaultAccessList>[0],
              Boolean(options.json),
            ),
          );
          return;
        }
        await useConfiguredHostStorage(currentConfigPath(), async (storage) => {
          const grants = (await storage.vaultGrants.list(capletFilter)).filter(
            (grant) => name === undefined || grant.vaultKey === validateVaultKeyName(name),
          );
          writeOut(
            formatVaultAccessList(grants.map(storedVaultGrantForCli), Boolean(options.json)),
          );
        });
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
        const target = parseVaultTarget(options);
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
        await useConfiguredHostStorage(currentConfigPath(), async (storage) => {
          const candidates = (await storage.vaultGrants.list(capletId)).filter(
            (grant) =>
              grant.vaultKey === validateVaultKeyName(name) &&
              (options.as === undefined || grant.referenceName === options.as),
          );
          let revoked = 0;
          for (const grant of candidates) {
            if (
              await storage.vaultGrants.revoke({
                capletId,
                vaultKey: grant.vaultKey,
                referenceName: grant.referenceName,
                operator: { role: "operator", clientId: "local_cli" },
              })
            ) {
              revoked += 1;
            }
          }
          if (revoked > 0) await storage.invalidateConfig("local_cli");
          writeOut(formatVaultAccessRevoke(revoked, Boolean(options.json)));
        });
      },
    );

  program
    .command(cliCommands.list)
    .description("List configured Caplets.")
    .option("--all", "include disabled Caplets")
    .option("--json", "print JSON output")
    .option("--format <format>", "output format: plain, markdown, md, or json", parseOutputFormat)
    .option("--stored", "show the Operator-only stored SQL view, including hidden records")
    .action(
      async (options: {
        all?: boolean;
        json?: boolean;
        format?: CliOutputFormat;
        stored?: boolean;
      }) => {
        const includeDisabled = Boolean(options.all);
        const remote = remoteClientForCli(io);
        if (options.stored) {
          if (remote) {
            throw new CapletsError(
              "REQUEST_INVALID",
              "Remote stored-record inspection is available through the remote Operator dashboard.",
            );
          }
          const rows = await useConfiguredHostStorage(currentConfigPath(), async (storage) => {
            const loaded = await loadConfigWithHostStorage(
              storage,
              currentConfigPath(),
              envProjectConfigPath(env),
              { vaultResolver: await createHostStorageVaultResolver(storage) },
            );
            return (
              await storage.caplets.listStored({
                role: "operator",
                clientId: "local_cli",
              })
            ).map((record) => {
              const source = loaded.sources[record.id];
              return {
                ...record,
                shadowed: source !== undefined && source.kind !== "stored-record",
                ...(source === undefined || source.kind === "stored-record"
                  ? {}
                  : { shadowSource: source }),
              };
            });
          });
          if (options.json || options.format === "json") {
            writeOut(`${JSON.stringify(rows, null, 2)}\n`);
            return;
          }
          writeOut(formatStoredCapletRows(rows, options.format ?? "plain"));
          return;
        }
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
        await useConfiguredHostStorage(currentConfigPath(), async (storage) => {
          const loaded = await loadConfigWithHostStorage(
            storage,
            currentConfigPath(),
            envProjectConfigPath(env),
            { vaultResolver: await createHostStorageVaultResolver(storage) },
          );
          const rows = listCaplets(loaded, { includeDisabled });
          if (options.json || options.format === "json") {
            writeOut(`${JSON.stringify(rows, null, 2)}\n`);
            return;
          }
          writeOut(formatCapletList(rows, options.format ?? "plain"));
        });
      },
    );

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
        printTelemetryNotice("cli");
        const target = parseCatalogLifecycleTarget(options);
        const localLockfilePath =
          target === "project" ? resolveProjectLockfilePath(process.cwd()) : undefined;
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
            writeOut(`${JSON.stringify(installJsonResult(result.installed), null, 2)}\n`);
            return;
          }
          for (const caplet of result.installed) {
            const action = installStatusLabel(caplet.status, "Installed");
            writeOut(`${action} ${caplet.id} to remote ${caplet.destination}\n`);
            writeCatalogIndexingNotice(caplet.catalogIndexing, writeOut);
          }
          return;
        }
        if (target === "global") {
          if (!installSource) {
            throw new CapletsError(
              "REQUEST_INVALID",
              "Global SQL catalog install requires a repository source.",
            );
          }
          const result = await useConfiguredHostStorage(currentConfigPath(), async (storage) =>
            installSqlCatalogCaplets({
              storage,
              operator: { clientId: "local_cli", role: "operator" },
              source: installSource,
              capletIds: selectedCapletIds,
              force: Boolean(options.force),
              disableCatalogIndexing: catalogIndexingDisabled(env),
            }),
          );
          attachVaultSetupResults(result.installed, io);
          if (options.json) {
            writeOut(`${JSON.stringify(installJsonResult(result.installed), null, 2)}\n`);
            return;
          }
          for (const caplet of result.installed) {
            writeOut(
              `${installStatusLabel(caplet.status, "Installed")} ${caplet.id} to ${caplet.destination}\n`,
            );
            writeCatalogIndexingNotice(caplet.catalogIndexing, writeOut);
            writeVaultSetupNotice(caplet.vaultSetup, writeOut);
          }
          return;
        }
        const destinationRoot = envProjectCapletsRoot(env);
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
            writeOut(`${JSON.stringify(installJsonResult(result.installed), null, 2)}\n`);
            return;
          }
          for (const caplet of result.installed) {
            writeOut(
              `${installStatusLabel(caplet.status, "Restored")} ${caplet.id} to ${localMutationTargetLabel(target, io)}${caplet.destination}\n`,
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
          writeOut(`${JSON.stringify(installJsonResult(result.installed), null, 2)}\n`);
          return;
        }
        for (const caplet of result.installed) {
          writeOut(
            `Installed ${caplet.id} to ${localMutationTargetLabel(target, io)}${caplet.destination}\n`,
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
        printTelemetryNotice("cli");
        const target = parseCatalogLifecycleTarget(options);
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
            writeOut(`${JSON.stringify(installJsonResult(result.installed), null, 2)}\n`);
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
        if (target === "global") {
          const result = await useConfiguredHostStorage(currentConfigPath(), async (storage) =>
            updateSqlCatalogCaplets({
              storage,
              operator: { clientId: "local_cli", role: "operator" },
              capletIds,
              force: Boolean(options.force),
              allowRiskIncrease: Boolean(options.force),
              disableCatalogIndexing: catalogIndexingDisabled(env),
            }),
          );
          attachVaultSetupResults(result.installed, io);
          if (options.json) {
            writeOut(`${JSON.stringify(installJsonResult(result.installed), null, 2)}\n`);
            return;
          }
          for (const caplet of result.installed) {
            writeOut(`${updateStatusLabel(caplet.status)} ${caplet.id} at ${caplet.destination}\n`);
            writeCatalogIndexingNotice(caplet.catalogIndexing, writeOut);
            writeVaultSetupNotice(caplet.vaultSetup, writeOut);
          }
          return;
        }
        const destinationRoot = envProjectCapletsRoot(env);
        const lockfilePath = resolveProjectLockfilePath(process.cwd());
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
          writeOut(`${JSON.stringify(installJsonResult(result.installed), null, 2)}\n`);
          return;
        }
        for (const caplet of result.installed) {
          writeOut(
            `${updateStatusLabel(caplet.status)} ${caplet.id} at ${localMutationTargetLabel(target, io)}${caplet.destination}\n`,
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
        const target = parseMutationTarget(options);
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
          writeOut(`Wrote ${localMutationTargetLabel(target, io)}CLI Caplet to ${result.path}\n`);
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
        const target = parseMutationTarget(options);
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
        writeAddResult(writeOut, `${localMutationTargetLabel(target, io)}MCP`, result);
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
        const target = parseMutationTarget(options);
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
        writeAddResult(writeOut, `${localMutationTargetLabel(target, io)}OpenAPI`, result);
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
        const target = parseMutationTarget(options);
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
        writeAddResult(writeOut, `${localMutationTargetLabel(target, io)}Google Discovery`, result);
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
        const target = parseMutationTarget(options);
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
        writeAddResult(writeOut, `${localMutationTargetLabel(target, io)}GraphQL`, result);
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
        const target = parseMutationTarget(options);
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
        writeAddResult(writeOut, `${localMutationTargetLabel(target, io)}HTTP`, result);
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
      const configPath = currentConfigPath();
      const projectConfigPath = envProjectConfigPath(env);
      const config = localAuthConfigForTarget({
        serverId,
        ...(io.authDir ? { authDir: io.authDir } : {}),
        ...(configPath ? { configPath } : {}),
        ...(projectConfigPath ? { projectConfigPath } : {}),
        source: target,
      });
      await useBackendAuthStore(configPath, async (authStore) => {
        await loginAuth(serverId, {
          authStore,
          noOpen: options.open === false,
          writeOut,
          writeErr,
          ...(configPath ? { configPath } : {}),
          config,
          ...(io.authDir ? { authDir: io.authDir } : {}),
        });
      });
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
      const configPath = currentConfigPath();
      const projectConfigPath = envProjectConfigPath(env);
      const config = localAuthConfigForTarget({
        serverId,
        ...(io.authDir ? { authDir: io.authDir } : {}),
        ...(configPath ? { configPath } : {}),
        ...(projectConfigPath ? { projectConfigPath } : {}),
        source: target,
      });
      await useBackendAuthStore(configPath, async (authStore) => {
        await logoutAuth(serverId, {
          authStore,
          writeOut,
          ...(configPath ? { configPath } : {}),
          config,
          ...(io.authDir ? { authDir: io.authDir } : {}),
        });
      });
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
      const configPath = currentConfigPath();
      const projectConfigPath = envProjectConfigPath(env);
      const config = localAuthConfigForTarget({
        serverId,
        ...(io.authDir ? { authDir: io.authDir } : {}),
        ...(configPath ? { configPath } : {}),
        ...(projectConfigPath ? { projectConfigPath } : {}),
        source: target,
      });
      await useBackendAuthStore(configPath, async (authStore) => {
        await refreshAuth(serverId, {
          authStore,
          writeOut,
          ...(configPath ? { configPath } : {}),
          config,
          ...(io.authDir ? { authDir: io.authDir } : {}),
        });
      });
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
      const configPath = currentConfigPath();
      const projectConfigPath = envProjectConfigPath(env);
      const format =
        options.json || options.format === "json" ? "json" : (options.format ?? "plain");
      const target = parseAuthFlagTarget(options);
      const rows = await authListRowsForCli(target, io, configPath, projectConfigPath);
      if (format === "json") {
        writeOut(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      writeOut(formatAuthRows(rows, format));
    });

  configureStorageCommands(program, {
    configPath: () => resolveConfigPath(currentConfigPath()),
    env,
    writeOut,
    io,
  });

  return program;
}
function configureStorageCommands(
  program: Command,
  context: {
    configPath: () => string;
    env: NodeJS.ProcessEnv | Record<string, string | undefined>;
    writeOut: (value: string) => void;
    io: CliIO;
  },
): void {
  const operator = { role: "operator" as const, clientId: "local_cli" };
  const storage = program.command("storage").description("Administer Authoritative Host State.");

  storage
    .command("status")
    .description("Inspect Authoritative Host State health and record counts.")
    .option("--json", "print JSON output")
    .action(async (options: { json?: boolean }) => {
      const status = await useConfiguredHostStorage(context.configPath(), async (hostStorage) => ({
        ...(await hostStorage.health()),
        records: (await hostStorage.caplets.list()).length,
        assetRows: await hostStorage.caplets.assetStats(),
      }));
      context.writeOut(
        options.json
          ? `${JSON.stringify(status, null, 2)}\n`
          : `Authoritative Host State: ${status.ready ? "ready" : "unavailable"} (${status.backend}, schema ${status.schemaVersion ?? "unknown"}, ${status.records} records).\n`,
      );
    });

  storage
    .command("schema-migrate")
    .description("Apply configured SQLite or PostgreSQL Authoritative Host State DDL.")
    .action(async () => {
      const config = loadHostStorageConfig(context.configPath());
      await migrateHostStorage(config);
      context.writeOut(`${JSON.stringify({ migrated: true, backend: config.type }, null, 2)}\n`);
    });

  storage
    .command("migrate-legacy")
    .description("Migrate verified legacy Host state into SQL storage.")
    .option("--caplets-root <path>", "tracked global Caplet installation root")
    .option("--lockfile <path>", "tracked global Caplet lockfile")
    .option("--dry-run", "verify migration inputs without writing or moving files")
    .option("--backup-root <path>", "timestamped backup destination")
    .option(
      "--operator-client <id>",
      "Operator Client identity for the migration audit",
      "cli-migration",
    )
    .action(
      async (options: {
        capletsRoot?: string;
        lockfile?: string;
        dryRun?: boolean;
        backupRoot?: string;
        operatorClient: string;
      }) => {
        const configPath = context.configPath();
        const capletsRoot = options.capletsRoot
          ? resolve(options.capletsRoot)
          : resolve(resolveCapletsRoot(configPath));
        const lockfilePath = options.lockfile
          ? resolve(options.lockfile)
          : defaultCapletsLockfilePath(context.env);
        const authDir = context.io.authDir ?? defaultAuthDir(context.env);
        const legacyVaultRoot = context.io.authDir
          ? join(authDir, "vault")
          : join(defaultStateBaseDir(context.env), "caplets", "vault");
        // Legacy remote credentials and dashboard activity intentionally share this directory;
        // each store owns a distinct file within it.
        const legacyHostAdminDir = join(authDir, "remote-server");
        const report = await migrateLegacyHostState({
          storage: loadHostStorageConfig(configPath),
          capletsRoot,
          lockfilePath,
          operatorClientId: options.operatorClient,
          backendAuthDir: authDir,
          legacyVaultRoot,
          legacyVaultEnv: context.env,
          targetVaultRoot: legacyVaultRoot,
          remoteSecurityDir: legacyHostAdminDir,
          setupStateDir: join(defaultCacheBaseDir(context.env), "caplets", "setup"),
          operatorActivityDir: legacyHostAdminDir,
          ...(options.backupRoot ? { backupRoot: options.backupRoot } : {}),
          dryRun: options.dryRun ?? false,
        });
        context.writeOut(`${JSON.stringify(report, null, 2)}\n`);
      },
    );

  const records = storage.command("records").description("Administer stored SQL Caplet Records.");

  records
    .command("list")
    .description("List stored SQL Caplet Records.")
    .requiredOption("--stored", "select the stored SQL view")
    .option("--remote [server]", "administer the selected remote Host")
    .action(async (options: StorageRemoteOptions) => {
      const remote = remoteClientForStorageOptions(context.io, options);
      const result = remote
        ? await remote.request("storage_records_list", {})
        : await useConfiguredHostStorage(context.configPath(), async (hostStorage) =>
            hostStorage.caplets.listStored(operator),
          );
      context.writeOut(`${JSON.stringify(result, null, 2)}\n`);
    });

  records
    .command("get")
    .description("Read one stored SQL Caplet Record.")
    .argument("<id>", "Caplet Record ID")
    .requiredOption("--stored", "select the stored SQL view")
    .option("--remote [server]", "administer the selected remote Host")
    .action(async (id: string, options: StorageRemoteOptions) => {
      const remote = remoteClientForStorageOptions(context.io, options);
      const record = remote
        ? parseRemoteStoredRecord(await remote.request("storage_records_get", { id }))
        : await useConfiguredHostStorage(context.configPath(), async (hostStorage) =>
            hostStorage.caplets.getStored(id, operator),
          );
      if (!record) throw new CapletsError("CONFIG_NOT_FOUND", `Caplet Record ${id} was not found.`);
      context.writeOut(`${JSON.stringify(record, null, 2)}\n`);
    });

  records
    .command("import")
    .description("Import a filesystem Caplet bundle as a new SQL record.")
    .argument("<bundle-path>", "directory bundle or CAPLET.md path")
    .option("--id <id>", "Caplet Record ID override")
    .option("--history-limit <n>", "retained revision count", parseStorageNonNegativeInteger)
    .option("--source-kind <kind>", "installation source kind")
    .option("--source-identity <identity>", "installation source identity")
    .option("--channel <channel>", "installation source channel")
    .option("--remote [server]", "administer the selected remote Host")
    .action(
      async (
        bundlePath: string,
        options: StorageRemoteOptions & {
          id?: string;
          historyLimit?: number;
          sourceKind?: string;
          sourceIdentity?: string;
          channel?: string;
        },
      ) => {
        const installation = installationSourceOptions(options);
        const remote = remoteClientForStorageOptions(context.io, options);
        let record: unknown;
        if (remote) {
          const bundle = inspectCapletBundleFiles(bundlePath);
          record = await remote.request("storage_records_import", {
            id: options.id ?? bundle.id,
            files: bundle.files,
            ...(options.historyLimit === undefined ? {} : { historyLimit: options.historyLimit }),
            ...installation,
          });
        } else {
          const bundle = readCapletBundleFiles(bundlePath);
          record = await useConfiguredHostStorage(context.configPath(), async (hostStorage) =>
            hostStorage.caplets.importBundle({
              id: options.id ?? bundle.id,
              files: bundle.files,
              operator,
              ...(options.historyLimit === undefined ? {} : { historyLimit: options.historyLimit }),
              ...(installation ? { installation } : {}),
            }),
          );
        }
        context.writeOut(`${JSON.stringify(record, null, 2)}\n`);
      },
    );

  records
    .command("update")
    .description("Replace a SQL Caplet Record with a complete filesystem bundle.")
    .argument("<id>", "Caplet Record ID")
    .argument("<bundle-path>", "directory bundle or CAPLET.md path")
    .requiredOption("--generation <n>", "observed record generation", parsePositiveInteger)
    .option("--detach-installation", "detach an active tracked installation before updating")
    .option("--remote [server]", "administer the selected remote Host")
    .action(
      async (
        id: string,
        bundlePath: string,
        options: StorageRemoteOptions & { generation: number; detachInstallation?: boolean },
      ) => {
        const remote = remoteClientForStorageOptions(context.io, options);
        let record: unknown;
        if (remote) {
          const bundle = inspectCapletBundleFiles(bundlePath);
          record = await remote.request("storage_records_update", {
            id,
            files: bundle.files,
            expectedGeneration: options.generation,
            ...(options.detachInstallation ? { detachInstallation: true } : {}),
          });
        } else {
          const bundle = readCapletBundleFiles(bundlePath);
          record = await useConfiguredHostStorage(context.configPath(), async (hostStorage) =>
            hostStorage.caplets.updateBundle({
              id,
              files: bundle.files,
              operator,
              expectedGeneration: options.generation,
              ...(options.detachInstallation ? { detachInstallation: true } : {}),
            }),
          );
        }
        context.writeOut(`${JSON.stringify(record, null, 2)}\n`);
      },
    );

  records
    .command("export")
    .description("Export a stored Caplet bundle to the filesystem.")
    .argument("<id>", "Caplet Record ID")
    .argument("<destination>", "export destination directory")
    .option("--revision <key>", "specific revision key")
    .option("--replace", "replace an existing destination")
    .option("--remote [server]", "administer the selected remote Host")
    .action(
      async (
        id: string,
        destination: string,
        options: StorageRemoteOptions & { revision?: string; replace?: boolean },
      ) => {
        const remote = remoteClientForStorageOptions(context.io, options);
        if (remote) {
          const result = await remote.request("storage_records_export", {
            id,
            ...(options.revision ? { revisionKey: options.revision } : {}),
          });
          const download = requireRemoteBundleDownload(result);
          await materializeRemoteBundleDownload({
            ...download,
            destination,
            ...(options.replace ? { replace: true } : {}),
          });
        } else {
          await useConfiguredHostStorage(context.configPath(), async (hostStorage) =>
            hostStorage.caplets.exportBundle(id, destination, {
              operator,
              ...(options.revision ? { revisionKey: options.revision } : {}),
              ...(options.replace ? { replace: true } : {}),
            }),
          );
        }
        context.writeOut(
          `${JSON.stringify({ exported: true, id, destination: resolve(destination) }, null, 2)}\n`,
        );
      },
    );

  records
    .command("revisions")
    .description("List retained revisions for a Caplet Record.")
    .argument("<id>", "Caplet Record ID")
    .option("--remote [server]", "administer the selected remote Host")
    .action(async (id: string, options: StorageRemoteOptions) => {
      const remote = remoteClientForStorageOptions(context.io, options);
      const revisions = remote
        ? await remote.request("storage_records_revisions", { id })
        : await useConfiguredHostStorage(context.configPath(), async (hostStorage) =>
            hostStorage.caplets.listRevisions(id, operator),
          );
      context.writeOut(`${JSON.stringify(revisions, null, 2)}\n`);
    });

  records
    .command("restore")
    .description("Restore a retained revision as a new current revision.")
    .argument("<id>", "Caplet Record ID")
    .argument("<revision>", "revision key")
    .requiredOption("--generation <n>", "observed record generation", parsePositiveInteger)
    .option("--remote [server]", "administer the selected remote Host")
    .action(
      async (
        id: string,
        revision: string,
        options: StorageRemoteOptions & { generation: number },
      ) => {
        const remote = remoteClientForStorageOptions(context.io, options);
        const record = remote
          ? await remote.request("storage_records_restore", {
              id,
              revisionKey: revision,
              expectedGeneration: options.generation,
            })
          : await useConfiguredHostStorage(context.configPath(), async (hostStorage) =>
              hostStorage.caplets.restoreRevision({
                id,
                revisionKey: revision,
                expectedGeneration: options.generation,
                operator,
              }),
            );
        context.writeOut(`${JSON.stringify(record, null, 2)}\n`);
      },
    );

  records
    .command("delete-revision")
    .description("Delete a retained revision.")
    .argument("<id>", "Caplet Record ID")
    .argument("<revision>", "revision key")
    .requiredOption("--generation <n>", "observed record generation", parsePositiveInteger)
    .option("--remote [server]", "administer the selected remote Host")
    .action(
      async (
        id: string,
        revision: string,
        options: StorageRemoteOptions & { generation: number },
      ) => {
        const remote = remoteClientForStorageOptions(context.io, options);
        const result = remote
          ? await remote.request("storage_records_delete_revision", {
              id,
              revisionKey: revision,
              expectedGeneration: options.generation,
            })
          : {
              deleted: true,
              record: await useConfiguredHostStorage(context.configPath(), async (hostStorage) =>
                hostStorage.caplets.deleteRevision({
                  id,
                  revisionKey: revision,
                  expectedGeneration: options.generation,
                  operator,
                }),
              ),
            };
        context.writeOut(`${JSON.stringify(result, null, 2)}\n`);
      },
    );

  records
    .command("retention")
    .description("Set retained revision count, or inherit the host default.")
    .argument("<id>", "Caplet Record ID")
    .argument("<limit>", "non-negative revision count or 'inherit'")
    .requiredOption("--generation <n>", "observed record generation", parsePositiveInteger)
    .option("--remote [server]", "administer the selected remote Host")
    .action(
      async (id: string, limit: string, options: StorageRemoteOptions & { generation: number }) => {
        const historyLimit = limit === "inherit" ? null : parseStorageNonNegativeInteger(limit);
        const remote = remoteClientForStorageOptions(context.io, options);
        const record = remote
          ? await remote.request("storage_records_retention", {
              id,
              historyLimit,
              expectedGeneration: options.generation,
            })
          : await useConfiguredHostStorage(context.configPath(), async (hostStorage) =>
              hostStorage.caplets.setRetention({
                id,
                historyLimit,
                expectedGeneration: options.generation,
                operator,
              }),
            );
        context.writeOut(`${JSON.stringify(record, null, 2)}\n`);
      },
    );

  records
    .command("rename")
    .description("Rename a Caplet Record.")
    .argument("<id>", "current Caplet Record ID")
    .argument("<new-id>", "new Caplet Record ID")
    .requiredOption("--generation <n>", "observed record generation", parsePositiveInteger)
    .option("--remote [server]", "administer the selected remote Host")
    .action(
      async (id: string, newId: string, options: StorageRemoteOptions & { generation: number }) => {
        const remote = remoteClientForStorageOptions(context.io, options);
        const record = remote
          ? await remote.request("storage_records_rename", {
              id,
              newId,
              expectedGeneration: options.generation,
            })
          : await useConfiguredHostStorage(context.configPath(), async (hostStorage) =>
              hostStorage.caplets.rename({
                id,
                newId,
                expectedGeneration: options.generation,
                operator,
              }),
            );
        context.writeOut(`${JSON.stringify(record, null, 2)}\n`);
      },
    );

  records
    .command("delete")
    .description("Hard-delete a Caplet Record and all retained revisions.")
    .argument("<id>", "Caplet Record ID")
    .requiredOption("--generation <n>", "observed record generation", parsePositiveInteger)
    .option("--remote [server]", "administer the selected remote Host")
    .action(async (id: string, options: StorageRemoteOptions & { generation: number }) => {
      const remote = remoteClientForStorageOptions(context.io, options);
      const result = remote
        ? await remote.request("storage_records_delete", {
            id,
            expectedGeneration: options.generation,
          })
        : await useConfiguredHostStorage(context.configPath(), async (hostStorage) => {
            await hostStorage.caplets.hardDelete({
              id,
              expectedGeneration: options.generation,
              operator,
            });
            return { deleted: true, id };
          });
      context.writeOut(`${JSON.stringify(result, null, 2)}\n`);
    });

  const installation = records
    .command("installation")
    .description("Administer Caplet installation provenance.");

  installation
    .command("status")
    .description("Inspect installation lifecycles and observations.")
    .argument("<id>", "Caplet Record ID")
    .option("--remote [server]", "administer the selected remote Host")
    .action(async (id: string, options: StorageRemoteOptions) => {
      const remote = remoteClientForStorageOptions(context.io, options);
      const result = remote
        ? await remote.request("storage_records_installation_status", { id })
        : await useConfiguredHostStorage(context.configPath(), async (hostStorage) => ({
            installations: await hostStorage.installations.list(id),
            observations: await hostStorage.installations.listObservations(id),
          }));
      context.writeOut(`${JSON.stringify(result, null, 2)}\n`);
    });

  installation
    .command("detach")
    .description("Detach the active installation lifecycle.")
    .argument("<id>", "Caplet Record ID")
    .requiredOption("--generation <n>", "observed installation generation", parsePositiveInteger)
    .option("--remote [server]", "administer the selected remote Host")
    .action(async (id: string, options: StorageRemoteOptions & { generation: number }) => {
      const remote = remoteClientForStorageOptions(context.io, options);
      const result = remote
        ? await remote.request("storage_records_installation_detach", {
            id,
            expectedGeneration: options.generation,
          })
        : await useConfiguredHostStorage(context.configPath(), async (hostStorage) => {
            const active = await hostStorage.installations.getActive(id);
            if (!active) return undefined;
            return await hostStorage.installations.detach({
              capletId: id,
              installationKey: active.installationKey,
              expectedGeneration: options.generation,
              operator,
            });
          });
      context.writeOut(`${JSON.stringify(result, null, 2)}\n`);
    });

  installation
    .command("observe")
    .description("Append an installation source observation.")
    .argument("<id>", "Caplet Record ID")
    .requiredOption("--generation <n>", "observed installation generation", parsePositiveInteger)
    .requiredOption(
      "--status <status>",
      "current, metadata-only, or source-unavailable",
      parseInstallationObservationStatus,
    )
    .option("--resolved-revision <revision>", "resolved source revision")
    .option("--content-hash <hash>", "resolved source content hash")
    .option("--risk-json <json>", "sanitized risk snapshot JSON")
    .option("--remote [server]", "administer the selected remote Host")
    .action(
      async (
        id: string,
        options: StorageRemoteOptions & {
          generation: number;
          status: "current" | "metadata-only" | "source-unavailable";
          resolvedRevision?: string;
          contentHash?: string;
          riskJson?: string;
        },
      ) => {
        const risk = options.riskJson ? parseStorageJsonObject(options.riskJson) : undefined;
        const remote = remoteClientForStorageOptions(context.io, options);
        const input = {
          id,
          expectedGeneration: options.generation,
          status: options.status,
          ...(options.resolvedRevision ? { resolvedRevision: options.resolvedRevision } : {}),
          ...(options.contentHash ? { contentHash: options.contentHash } : {}),
          ...(risk ? { risk } : {}),
        };
        const result = remote
          ? await remote.request("storage_records_installation_observe", input)
          : await useConfiguredHostStorage(context.configPath(), async (hostStorage) =>
              hostStorage.installations.appendObservation({
                capletId: id,
                expectedGeneration: options.generation,
                status: options.status,
                operator,
                ...(options.resolvedRevision ? { resolvedRevision: options.resolvedRevision } : {}),
                ...(options.contentHash ? { contentHash: options.contentHash } : {}),
                ...(risk ? { risk } : {}),
              }),
            );
        context.writeOut(`${JSON.stringify(result, null, 2)}\n`);
      },
    );

  installation
    .command("replace")
    .description("Replace the latest detached installation with a new active lifecycle.")
    .argument("<id>", "Caplet Record ID")
    .requiredOption(
      "--generation <n>",
      "observed detached installation generation",
      parsePositiveInteger,
    )
    .requiredOption("--source-kind <kind>", "replacement source kind")
    .requiredOption("--source-identity <identity>", "replacement source identity")
    .option("--channel <channel>", "replacement source channel")
    .option("--detached-installation <key>", "expected detached installation key")
    .option("--remote [server]", "administer the selected remote Host")
    .action(
      async (
        id: string,
        options: StorageRemoteOptions & {
          generation: number;
          sourceKind: string;
          sourceIdentity: string;
          channel?: string;
          detachedInstallation?: string;
        },
      ) => {
        const remote = remoteClientForStorageOptions(context.io, options);
        const result = remote
          ? await remote.request("storage_records_installation_replace", {
              id,
              expectedGeneration: options.generation,
              sourceKind: options.sourceKind,
              sourceIdentity: options.sourceIdentity,
              ...(options.channel ? { channel: options.channel } : {}),
              ...(options.detachedInstallation
                ? { detachedInstallationKey: options.detachedInstallation }
                : {}),
            })
          : await useConfiguredHostStorage(context.configPath(), async (hostStorage) =>
              hostStorage.installations.replaceDetached({
                capletId: id,
                expectedGeneration: options.generation,
                sourceKind: options.sourceKind,
                sourceIdentity: options.sourceIdentity,
                operator,
                ...(options.channel ? { channel: options.channel } : {}),
                ...(options.detachedInstallation
                  ? { detachedInstallationKey: options.detachedInstallation }
                  : {}),
              }),
            );
        context.writeOut(`${JSON.stringify(result, null, 2)}\n`);
      },
    );
}

type StorageRemoteOptions = {
  remote?: string | boolean | undefined;
};

function remoteClientForStorageOptions(
  io: CliIO,
  options: StorageRemoteOptions,
): RemoteCliCommandAdapter | undefined {
  if (options.remote === undefined || options.remote === false) return undefined;
  const remoteUrl = typeof options.remote === "string" ? options.remote : undefined;
  return requireRemoteClientForTarget(io, remoteUrl, true);
}

function requireRemoteBundleDownload(value: unknown): RemoteBundleDownload {
  if (
    !isCliRecord(value) ||
    !(value.body instanceof ReadableStream) ||
    typeof value.contentType !== "string"
  ) {
    throw new CapletsError(
      "DOWNSTREAM_PROTOCOL_ERROR",
      "Remote Caplet Bundle response is malformed.",
    );
  }
  return { body: value.body, contentType: value.contentType };
}

function parseRemoteStoredRecord(value: unknown): unknown {
  if (isCliRecord(value) && "record" in value) return value.record;
  if (isCliRecord(value) && "currentRevision" in value) return value;
  throw new CapletsError("REQUEST_INVALID", "Remote Caplet Record response is malformed.");
}

function isCliRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseStorageNonNegativeInteger(value: string): number {
  return parseNonNegativeInteger(value, "Storage value");
}

function parseInstallationObservationStatus(
  value: string,
): "current" | "metadata-only" | "source-unavailable" {
  if (value === "current" || value === "metadata-only" || value === "source-unavailable") {
    return value;
  }
  throw new CapletsError(
    "REQUEST_INVALID",
    `Installation observation status must be current, metadata-only, or source-unavailable; got ${value}`,
  );
}

function parseStorageJsonObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new CapletsError("REQUEST_INVALID", "Storage risk JSON must be valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CapletsError("REQUEST_INVALID", "Storage risk JSON must be an object.");
  }
  return parsed as Record<string, unknown>;
}

function installationSourceOptions(options: {
  sourceKind?: string;
  sourceIdentity?: string;
  channel?: string;
}):
  | {
      sourceKind: string;
      sourceIdentity: string;
      channel?: string;
    }
  | undefined {
  if (options.sourceKind === undefined && options.sourceIdentity === undefined) return undefined;
  if (!options.sourceKind || !options.sourceIdentity) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "--source-kind and --source-identity must be provided together.",
    );
  }
  return {
    sourceKind: options.sourceKind,
    sourceIdentity: options.sourceIdentity,
    ...(options.channel ? { channel: options.channel } : {}),
  };
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

function localVaultGrantOrigin(
  capletId: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): { originKind: ConfigSource["kind"]; originPath?: string } {
  const overlay = loadLocalOverlayConfigWithSources(
    resolveConfigPath(envConfigPath(env)),
    envProjectConfigPath(env),
    { vaultResolver: vaultBootstrapResolver },
  );
  const source = overlay.sources[capletId];
  if (!source) return { originKind: "stored-record" };
  if (overlay.shadows[capletId]?.length) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Caplet ${capletId} is shadowed in multiple config sources; resolve the active config before granting Vault access.`,
    );
  }
  return { originKind: source.kind, originPath: source.path };
}

function remoteClientForCli(
  io: CliIO,
  remoteUrl?: string | undefined,
  forceRemote = false,
): RemoteCliCommandAdapter | undefined {
  const env = io.env ?? process.env;
  if (!forceRemote && remoteUrl === undefined && resolveRemoteMode({}, env).mode !== "remote") {
    return undefined;
  }
  return new RemoteCliClient({
    resolve: async () => {
      const selection = await resolveRemoteSelection(
        {
          mode: "remote",
          ...(remoteUrl ? { remoteUrl } : {}),
          ...(io.authDir ? { authDir: io.authDir } : {}),
          ...(io.fetch ? { fetch: io.fetch } : {}),
        },
        env,
      );
      if (selection.kind !== "remote") {
        throw new CapletsError(
          "REQUEST_INVALID",
          "--remote requires a Current Host Remote Profile",
        );
      }
      return {
        baseUrl: selection.remote.baseUrl,
        attachUrl: selection.remote.attachUrl,
        requestInit: selection.remote.requestInit,
        ...(selection.remote.fetch ? { fetch: selection.remote.fetch } : {}),
      };
    },
    createAdmin: (resolved, bearerToken) =>
      createRemoteAdminCommandAdapter({
        baseUrl: resolved.baseUrl,
        bearerToken,
        ...(resolved.fetch ? { fetch: resolved.fetch } : {}),
      }),
    createAttach: (resolved) =>
      createRemoteAttachCommandAdapter({
        client: createSdkRemoteCapletsClient({
          origin: resolved.baseUrl,
          auth: { enabled: false, user: "caplets" },
          pollIntervalMs: 60_000,
          requestInit: resolved.requestInit,
          ...(resolved.fetch ? { fetch: resolved.fetch } : {}),
        }),
      }),
    createPublicAuth: createRemotePublicAuthAdapter,
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

type VaultTarget = "global" | "remote";

type VaultTargetOptions = {
  global?: boolean;
  remote?: boolean;
};

type VaultRemoteTarget = RemoteCliCommandAdapter;

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

function parseMutationTarget(options: MutationTargetOptions): MutationTarget {
  const selected = [
    options.project ? "--project" : undefined,
    options.global ? "--global" : undefined,
    options.remote ? "--remote" : undefined,
  ].filter((value): value is string => value !== undefined);
  if (selected.length > 1) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Cannot combine mutation target flags: ${selected.join(", ")}`,
    );
  }
  if (options.global) return "global";
  if (options.remote) return "remote";
  return "project";
}

function parseCatalogLifecycleTarget(options: MutationTargetOptions): MutationTarget {
  const selected = [
    options.project ? "--project" : undefined,
    options.global ? "--global" : undefined,
    options.remote ? "--remote" : undefined,
  ].filter((value): value is string => value !== undefined);
  const allowedRemoteGlobal = options.remote && options.global && !options.project;
  if (selected.length > 1 && !allowedRemoteGlobal) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Cannot combine mutation target flags: ${selected.join(", ")}`,
    );
  }
  if (options.remote) return "remote";
  if (options.global) return "global";
  return "project";
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

function parseVaultTarget(options: VaultTargetOptions): VaultTarget {
  const selected = [
    options.global ? "--global" : undefined,
    options.remote ? "--remote" : undefined,
  ].filter((value): value is string => value !== undefined);
  if (selected.length > 1) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Cannot combine Vault target flags: ${selected.join(", ")}`,
    );
  }
  if (options.remote) return "remote";
  return "global";
}

async function resolveVaultRemoteTarget(io: CliIO): Promise<VaultRemoteTarget> {
  const env = io.env ?? process.env;
  if (resolveRemoteMode({}, env).mode !== "remote") {
    throw new CapletsError(
      "REQUEST_INVALID",
      "--remote requires CAPLETS_MODE=remote and CAPLETS_REMOTE_URL",
    );
  }
  return requireRemoteClientForTarget(io);
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
  return await (await resolveVaultRemoteTarget(io)).request("vault_set", input);
}

async function remoteVaultGet(
  io: CliIO,
  input: { name: string; reveal: boolean },
): Promise<unknown> {
  return await (
    await resolveVaultRemoteTarget(io)
  ).request("vault_get", {
    name: input.name,
    reveal: input.reveal,
  });
}

async function remoteVaultList(io: CliIO): Promise<unknown> {
  return await (await resolveVaultRemoteTarget(io)).request("vault_list", {});
}

async function remoteVaultDelete(io: CliIO, name: string): Promise<unknown> {
  return await (await resolveVaultRemoteTarget(io)).request("vault_delete", { name });
}

async function remoteVaultAccessGrant(
  io: CliIO,
  input: { name: string; capletId: string; referenceName: string },
): Promise<unknown> {
  return await (await resolveVaultRemoteTarget(io)).request("vault_access_grant", input);
}

async function remoteVaultAccessList(
  io: CliIO,
  input: { name?: string | undefined; capletId?: string | undefined },
): Promise<unknown> {
  return await (await resolveVaultRemoteTarget(io)).request("vault_access_list", input);
}

async function remoteVaultAccessRevoke(
  io: CliIO,
  input: { name: string; capletId: string; referenceName?: string | undefined },
): Promise<unknown> {
  return await (await resolveVaultRemoteTarget(io)).request("vault_access_revoke", input);
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

function storedVaultGrantForCli(grant: StoredVaultGrant) {
  return {
    storedKey: grant.vaultKey,
    referenceName: grant.referenceName,
    capletId: grant.capletId,
    origin: {
      kind: grant.originKind,
      ...(grant.originPath === null ? {} : { path: grant.originPath }),
    },
    createdAt: grant.createdAt,
    updatedAt: grant.createdAt,
  };
}

type StoredCapletRow = CapletRecordView & {
  shadowed: boolean;
  shadowSource?: ConfigSource | undefined;
};

function formatStoredCapletRows(rows: StoredCapletRow[], format: CliOutputFormat): string {
  if (rows.length === 0) return "No stored SQL Caplet Records.\n";
  if (format === "markdown") {
    return [
      "| Caplet Record | Generation | Effective state |",
      "| --- | ---: | --- |",
      ...rows.map(
        (row) =>
          `| \`${row.id}\` | ${row.headGeneration} | ${
            row.shadowed ? `shadowed by ${row.shadowSource?.kind ?? "higher layer"}` : "effective"
          } |`,
      ),
      "",
    ].join("\n");
  }
  return `${rows
    .map(
      (row) =>
        `${row.id}\tgeneration ${row.headGeneration}\t${
          row.shadowed ? `shadowed by ${row.shadowSource?.kind ?? "higher layer"}` : "effective"
        }`,
    )
    .join("\n")}\n`;
}

function localMutationTargetLabel(target: Exclude<MutationTarget, "remote">, io: CliIO): string {
  return remoteClientForCli(io) ? `${target} ` : "";
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
) {
  return {
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
  if (explicit) return explicit;

  const env = io.env ?? process.env;
  const configPath = envConfigPath(env);
  const projectConfigPath = envProjectConfigPath(env);
  const matches: AuthTarget[] = localAuthTargets({
    ...(configPath ? { configPath } : {}),
    ...(projectConfigPath ? { projectConfigPath } : {}),
  })
    .filter((target) => target.server === serverId)
    .map((target) => target.source);

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
  configPath: string | undefined,
  projectConfigPath: string | undefined,
): Promise<AuthStatusRow[]> {
  if (target === "remote") {
    return remoteAuthRows(requireRemoteClientForTarget(io));
  }
  const localRows = await useBackendAuthStore(configPath, async (authStore) =>
    listLocalAuthRows({
      authStore,
      ...(configPath ? { configPath } : {}),
      ...(projectConfigPath ? { projectConfigPath } : {}),
      ...(io.authDir ? { authDir: io.authDir } : {}),
      ...(target ? { source: target } : {}),
    }),
  );
  if (target) return localRows;
  const remote = remoteClientForCli(io);
  if (!remote) return localRows;
  return [...localRows, ...(await remoteAuthRows(remote))].sort((left, right) =>
    left.server.localeCompare(right.server),
  );
}

async function remoteAuthRows(remote: RemoteCliCommandAdapter): Promise<AuthStatusRow[]> {
  const rows = (await remote.request("auth_list", {})) as AuthStatusRow[];
  return rows.map((row) => ({ ...row, source: "remote" }));
}

async function remoteAuthLogin(
  remote: RemoteCliCommandAdapter,
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

function requireRemoteClientForTarget(
  io: CliIO,
  remoteUrl?: string | undefined,
  forceRemote = false,
): RemoteCliCommandAdapter {
  const remote = remoteClientForCli(io, remoteUrl, forceRemote);
  if (!remote) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "--remote requires CAPLETS_MODE=remote and CAPLETS_REMOTE_URL",
    );
  }
  return remote;
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

function parseSetupTarget(value: string): "local" | "remote" {
  if (value === "local" || value === "remote") return value;
  throw new CapletsError("REQUEST_INVALID", "setup target must be local or remote");
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
    config?: CapletsConfig | undefined;
  },
): Promise<string[]> {
  const engine = options.config
    ? new CapletsEngine({
        configLoader: () => options.config as CapletsConfig,
        watch: false,
      })
    : await CapletsEngine.create({
        ...(options.configPath ? { configPath: options.configPath } : {}),
        ...(options.projectConfigPath ? { projectConfigPath: options.projectConfigPath } : {}),
        ...(options.authDir ? { authDir: options.authDir } : {}),
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
  remote?: RemoteCliCommandAdapter | undefined;
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
      await executeLocalOperation(caplet, request, io, localOverlay.config);
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
  config?: CapletsConfig,
): Promise<void> {
  const configPath = envConfigPath(io.env ?? process.env);
  const engine = config
    ? new CapletsEngine({
        configLoader: () => config,
        watch: false,
        writeErr: io.writeErr,
        telemetryEnv: io.env ?? process.env,
        telemetryStateDir: io.telemetryStateDir ?? defaultTelemetryStateDir(io.env ?? process.env),
        telemetrySurface: "cli",
        telemetryVisibility: "visible",
        telemetryRuntimeMode: runtimeModeForEnv(io.env ?? process.env),
        telemetryDebugSink: io.telemetryDebugSink,
      })
    : await CapletsEngine.create({
        ...(configPath ? { configPath } : {}),
        projectConfigPath: envProjectConfigPath(io.env ?? process.env),
        ...(io.authDir ? { authDir: io.authDir } : {}),
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
