import { Command, CommanderError } from "commander";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
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
import { buildCloudCapletBundle } from "./cli/cloud-add";
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
import { installCaplets } from "./cli/install";
import {
  formatSetupMenu,
  runInteractiveSetup,
  runSetup,
  type SetupCommandRunner,
  type SetupFormat,
  type SetupOptions,
  type SetupPromptReader,
} from "./cli/setup";
import {
  type CapletsConfig,
  type ConfigSource,
  type LocalOverlayConfigWithSources,
  loadConfigWithSources,
  loadLocalOverlayConfigWithSources,
  resolveCapletsRoot,
  resolveConfigPath,
  resolveProjectCapletsRoot,
  resolveProjectConfigPath,
  vaultBootstrapResolver,
} from "./config";
import { CapletsEngine } from "./engine";
import { CapletsError } from "./errors";
import { resolveAttachServeOptions, type AttachServeOptions } from "./attach/options";
import { attachResolvedCaplets } from "./attach/server";
import { attachProjectOnce } from "./project-binding/attach";
import { ProjectBindingError } from "./project-binding/errors";
import type { ProjectBindingWebSocketFactory } from "./project-binding/transport";
import { RemoteControlClient } from "./remote-control/client";
import type { RemoteCliCommand } from "./remote-control/types";
import {
  cloudCredentialsFromRemoteProfile,
  createRemoteProfileStore,
  type FileRemoteProfileStore,
} from "./remote/profile-store";
import { RemoteServerCredentialStore } from "./remote/server-credential-store";
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
import { DEFAULT_AUTH_DIR } from "./config/paths";
import { appendBasePath } from "./server/options";
import { FileVaultStore, VAULT_MAX_VALUE_BYTES, validateVaultKeyName } from "./vault";
import type { VaultAccessGrantFilter } from "./vault";

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
  version?: string;
  setExitCode?: (code: number) => void;
  serve?: (options: ServeOptions) => Promise<void>;
  attachServe?: (options: AttachServeOptions) => Promise<void>;
  daemon?: DaemonOperationOptions;
  runSetupCommand?: SetupCommandRunner;
  readStdin?: () => Promise<string>;
};

export async function runCli(args: string[], io: CliIO = {}): Promise<void> {
  const program = createProgram(io);
  try {
    if (args.length === 0) {
      program.outputHelp();
      return;
    }
    await program.parseAsync(["node", "caplets", ...args]);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version" ||
        error.message === "(outputHelp)"
      ) {
        return;
      }
      throw new CapletsError("REQUEST_INVALID", error.message);
    }
    throw error;
  }
}

function normalizeCompletionWords(words: string[]): string[] {
  return words.map((word) => (word === trailingSpaceCompletionToken ? "" : word));
}

type DaemonInstallCommandOptions = {
  host?: string;
  port?: string;
  path?: string;
  remoteStatePath?: string;
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

function remoteProfileStore(
  authDir: string | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): FileRemoteProfileStore {
  return createRemoteProfileStore({ authDir, env });
}

function remoteServerCredentialStore(
  statePath: string | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): RemoteServerCredentialStore {
  return new RemoteServerCredentialStore({
    dir:
      statePath ?? env.CAPLETS_REMOTE_SERVER_STATE_DIR ?? join(DEFAULT_AUTH_DIR, "remote-server"),
  });
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

async function pairingCodeFromOptions(
  options: { code?: string; codeStdin?: boolean },
  readStdin: (() => Promise<string>) | undefined,
  writeErr: (value: string) => void,
): Promise<string> {
  if (options.code?.trim()) {
    writeErr(
      "Warning: --code may store the Pairing Code in shell history; prefer the hidden prompt or --code-stdin for automation.\n",
    );
    return options.code.trim();
  }
  if (options.codeStdin) {
    const value = readStdin ? await readStdin() : await readAllStdin();
    const code = value.trim();
    if (code) return code;
    throw new CapletsError(
      "REQUEST_INVALID",
      "Pairing Code is required when --code-stdin is used.",
    );
  }
  const output = new HiddenPromptOutput(process.stdout);
  const readline = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const code = (await readline.question("Pairing Code: ")).trim();
    if (code) return code;
  } finally {
    readline.close();
    process.stdout.write("\n");
  }
  throw new CapletsError(
    "REQUEST_INVALID",
    "Pairing Code is required for self-hosted Remote Login.",
  );
}

class HiddenPromptOutput extends Writable {
  private wrotePrompt = false;

  constructor(private readonly output: NodeJS.WriteStream) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.wrotePrompt) {
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
  clientId: string;
  clientLabel: string;
  accessToken: string;
  refreshToken: string;
  tokenType?: string | undefined;
  expiresAt?: string | undefined;
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
    clientId: record.clientId,
    clientLabel: typeof record.clientLabel === "string" ? record.clientLabel : "Caplets CLI",
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    ...(typeof record.tokenType === "string" ? { tokenType: record.tokenType } : {}),
    ...(typeof record.expiresAt === "string" ? { expiresAt: record.expiresAt } : {}),
  };
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

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createProgram(io: CliIO = {}): Command {
  const writeOut = io.writeOut ?? ((value: string) => process.stdout.write(value));
  const writeErr = io.writeErr ?? ((value: string) => process.stderr.write(value));
  const env = io.env ?? process.env;
  const currentConfigPath = () => envConfigPath(env);
  const setExitCode =
    io.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
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
        allowUnauthenticatedHttp?: boolean;
        trustProxy?: boolean;
      }) => {
        const resolved = resolveServeOptions(options);
        const configPath = currentConfigPath();
        const runner =
          io.serve ??
          ((serveOptions: ServeOptions) =>
            serveResolvedCaplets(
              serveOptions,
              {
                ...(configPath ? { configPath } : {}),
                ...(io.authDir ? { authDir: io.authDir } : {}),
              },
              writeErr,
            ));
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
    const result = await restartDaemon(daemonOptions());
    if (options.json) {
      writeOut(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    writeOut("Restarted Caplets daemon.\n");
  });

  addJsonOption(daemon.command("stop").description("Stop the default Caplets daemon.")).action(
    async (options: DaemonCommandOptions) => {
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
    .option("--transport <transport>", "server transport: stdio or http")
    .option("--host <host>", "HTTP bind host")
    .option("--port <port>", "HTTP bind port")
    .option("--path <path>", "HTTP service base path")
    .option("--remote-url <url>", "remote Caplets service base URL")
    .option("--workspace <workspace>", "hosted Cloud workspace ID or slug")
    .option(
      "--allow-unauthenticated-http",
      "allow unauthenticated HTTP serving on non-loopback hosts",
    )
    .option("--trust-proxy", "trust X-Forwarded-* headers from a reverse proxy")
    .option("--json", "print JSON status events")
    .option("--verbose", "print detailed attach diagnostics")
    .option("--once", "validate Project Binding once and exit")
    .option("--project-root <path>", "test-only project root override")
    .action(
      async (options: {
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
      }) => {
        try {
          const attachOptions = {
            ...options,
            ...(io.fetch ? { fetch: io.fetch } : {}),
            ...(io.authDir ? { authDir: io.authDir } : {}),
          };
          if (!options.once) {
            const resolved = await resolveAttachServeOptions(attachOptions, env);
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
    .option("--code <code>", "Pairing Code for explicit noninteractive self-hosted login")
    .option("--code-stdin", "read the Pairing Code from stdin")
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

        const code = await pairingCodeFromOptions(options, io.readStdin, writeErr);
        const exchangeUrl = appendBasePath(
          new URL(normalizeRemoteProfileHostUrl(url)),
          "v1/remote/pairing/exchange",
        );
        const response = await (io.fetch ?? fetch)(exchangeUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            code,
            ...(options.clientLabel ? { clientLabel: options.clientLabel } : {}),
          }),
        });
        if (!response.ok) {
          throw new CapletsError("AUTH_FAILED", "Remote Login pairing exchange failed.");
        }
        const credentials = await parseRemoteLoginCredentials(response);
        const status = await store.saveSelfHostedProfile({
          hostUrl: url,
          clientId: credentials.clientId,
          clientLabel: credentials.clientLabel,
          credentials: {
            accessToken: credentials.accessToken,
            refreshToken: credentials.refreshToken,
            tokenType: credentials.tokenType,
            expiresAt: credentials.expiresAt,
          },
        });
        writeRemoteStatus(status, options.json === true, writeOut);
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
    .command("pair")
    .description("Create a short-lived self-hosted Pairing Code from the server environment.")
    .requiredOption("--host-url <url>", "public Caplets host URL")
    .option("--state-path <path>", "server-owned remote credential state directory")
    .option("--client-label <label>", "suggested client label")
    .option("--json", "print JSON output")
    .action(
      async (options: {
        hostUrl: string;
        statePath?: string;
        clientLabel?: string;
        json?: boolean;
      }) => {
        const issued = remoteServerCredentialStore(options.statePath, env).createPairingCode({
          hostUrl: options.hostUrl,
          ...(options.clientLabel ? { clientLabel: options.clientLabel } : {}),
        });
        if (options.json) {
          writeOut(`${JSON.stringify(issued, null, 2)}\n`);
          return;
        }
        writeOut(`Pairing Code: ${issued.code}\n`);
        writeOut(`Expires At: ${issued.expiresAt}\n`);
        writeOut(
          `Run caplets remote login ${normalizeRemoteProfileHostUrl(options.hostUrl)} and enter the Pairing Code when prompted.\n`,
        );
      },
    );
  remoteHost
    .command("clients")
    .description("List paired self-hosted remote clients from server state.")
    .option("--state-path <path>", "server-owned remote credential state directory")
    .option("--json", "print JSON output")
    .action((options: { statePath?: string; json?: boolean }) => {
      const clients = remoteServerCredentialStore(options.statePath, env).listClients();
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
          `${client.clientId}\t${terminalSafeText(client.clientLabel)}\t${client.hostUrl}\t${client.revokedAt ? "revoked" : "active"}\n`,
        );
      }
    });
  remoteHost
    .command("revoke")
    .description("Revoke one paired self-hosted remote client from server state.")
    .argument("<client-id>", "remote client ID")
    .option("--state-path <path>", "server-owned remote credential state directory")
    .option("--json", "print JSON output")
    .action((clientId: string, options: { statePath?: string; json?: boolean }) => {
      const revoked = remoteServerCredentialStore(options.statePath, env).revokeClient(clientId);
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
          dryRun?: boolean;
          yes?: boolean;
          target?: "local" | "remote" | "cloud";
          format?: SetupFormat;
        },
      ) => {
        const setupOptions: SetupOptions = { ...options, env };
        if (io.runSetupCommand) setupOptions.runCommand = io.runSetupCommand;
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
    .action(async (options: { json?: boolean }) => {
      if (options.json) {
        writeOut(
          `${JSON.stringify(
            await doctorJsonReport({ env, ...(io.daemon ? { daemon: io.daemon } : {}) }),
            null,
            2,
          )}\n`,
        );
        return;
      }
      writeOut(await formatDoctorReport({ env, ...(io.daemon ? { daemon: io.daemon } : {}) }));
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
        const value = await readVaultValue(io);
        const store = new FileVaultStore({ env });
        const existed = store.getStatus(name).present;
        const previousValue = existed && options.grant ? store.resolveValue(name) : undefined;
        const status = store.set(name, value, { force: Boolean(options.force) });
        try {
          if (options.grant) {
            const origin = resolveVaultAccessOrigin(options.grant, io);
            store.grantAccess({
              storedKey: name,
              referenceName: options.as ?? name,
              capletId: options.grant,
              origin,
            });
          }
        } catch (error) {
          if (existed && previousValue !== undefined) {
            store.set(name, previousValue, { force: true });
          } else {
            store.delete(name);
          }
          throw error;
        }
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
          writeOut(
            formatVaultValueStatus(
              result as ReturnType<FileVaultStore["getStatus"]>,
              Boolean(options.json),
            ),
          );
          return;
        }
        const store = new FileVaultStore({ env });
        if (options.show) {
          const value = store.resolveValue(name);
          writeOut(
            options.json ? `${JSON.stringify({ key: name, value }, null, 2)}\n` : `${value}\n`,
          );
          return;
        }
        writeOut(formatVaultValueStatus(store.getStatus(name), Boolean(options.json)));
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
        writeOut(
          formatVaultValueList(
            result as ReturnType<FileVaultStore["listValues"]>,
            Boolean(options.json),
          ),
        );
        return;
      }
      writeOut(
        formatVaultValueList(new FileVaultStore({ env }).listValues(), Boolean(options.json)),
      );
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
        writeOut(
          formatVaultDeleteStatus(
            result as ReturnType<FileVaultStore["delete"]>,
            Boolean(options.json),
          ),
        );
        return;
      }
      writeOut(
        formatVaultDeleteStatus(new FileVaultStore({ env }).delete(name), Boolean(options.json)),
      );
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
              grant as ReturnType<FileVaultStore["grantAccess"]>,
              Boolean(options.json),
            ),
          );
          return;
        }
        const origin = resolveVaultAccessOrigin(capletId, io);
        const grant = new FileVaultStore({ env }).grantAccess({
          storedKey: name,
          referenceName: options.as ?? name,
          capletId,
          origin,
        });
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
        const target = parseVaultTarget(options);
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
        writeOut(
          formatVaultAccessList(
            new FileVaultStore({ env }).listAccess(vaultAccessFilter(name, capletFilter)),
            Boolean(options.json),
          ),
        );
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
        const filter = vaultAccessFilter(name, capletId, options.as);
        const revoked = new FileVaultStore({ env }).revokeAccess(filter);
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
      const config = loadConfigWithSources(currentConfigPath(), envProjectConfigPath(env));
      const rows = listCaplets(config, { includeDisabled });
      if (options.json || options.format === "json") {
        writeOut(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      writeOut(formatCapletList(rows, options.format ?? "plain"));
    });

  program
    .command(cliCommands.install)
    .description("Install Caplets from a repo's caplets directory.")
    .argument("<repo>", "local repo path, Git URL, or GitHub owner/repo")
    .argument("[caplets...]", "optional Caplet IDs to install")
    .option("--project", "install to the project Caplets root")
    .option("-g, --global", "install to the user Caplets root")
    .option("--remote", "install through remote control")
    .option("--force", "overwrite installed Caplets")
    .action(
      async (
        repo: string,
        capletIds: string[],
        options: MutationTargetOptions & { force?: boolean },
      ) => {
        const target = parseMutationTarget(options);
        if (target === "remote") {
          const remote = requireRemoteClientForTarget(io);
          const result = (await remote.request("install", {
            repo,
            capletIds,
            force: Boolean(options.force),
          })) as { installed: Array<{ id: string; destination: string }> };
          for (const caplet of result.installed) {
            writeOut(`Installed ${caplet.id} to remote ${caplet.destination}\n`);
          }
          return;
        }
        const result = installCaplets(repo, {
          capletIds,
          force: Boolean(options.force),
          destinationRoot:
            target === "global"
              ? resolveCapletsRoot(resolveConfigPath(currentConfigPath()))
              : envProjectCapletsRoot(env),
        });
        for (const caplet of result.installed) {
          writeOut(
            `Installed ${caplet.id} to ${localMutationTargetLabel(target, io)}${caplet.destination}\n`,
          );
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
      await executeOperation(
        caplet,
        { operation: "inspect" },
        {
          writeOut,
          writeErr,
          setExitCode,
          authDir: io.authDir,
          env,
          remote: remoteClientForCli(io),
          format: options.format,
        },
      );
    });

  program
    .command(cliCommands.checkBackend)
    .description("Check backend availability for a configured Caplet.")
    .argument("<caplet>", "configured Caplet ID")
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(async (caplet: string, options: { format?: CliOutputFormat }) => {
      await executeOperation(
        caplet,
        { operation: "check" },
        {
          writeOut,
          writeErr,
          setExitCode,
          authDir: io.authDir,
          env,
          remote: remoteClientForCli(io),
          format: options.format,
        },
      );
    });

  program
    .command(cliCommands.listTools)
    .description("List downstream tools for a configured Caplet.")
    .argument("<caplet>", "configured Caplet ID")
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(async (caplet: string, options: { format?: CliOutputFormat }) => {
      await executeOperation(
        caplet,
        { operation: "tools" },
        {
          writeOut,
          writeErr,
          setExitCode,
          authDir: io.authDir,
          env,
          remote: remoteClientForCli(io),
          format: options.format,
        },
      );
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
          {
            writeOut,
            writeErr,
            setExitCode,
            authDir: io.authDir,
            env,
            remote: remoteClientForCli(io),
            format: options.format,
          },
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
          {
            writeOut,
            writeErr,
            setExitCode,
            authDir: io.authDir,
            env,
            remote: remoteClientForCli(io),
            format: options.format,
          },
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
        await executeOperation(caplet, request, {
          writeOut,
          writeErr,
          setExitCode,
          authDir: io.authDir,
          env,
          remote: remoteClientForCli(io),
          format: options.format,
        });
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
        {
          writeOut,
          writeErr,
          setExitCode,
          authDir: io.authDir,
          env,
          remote: remoteClientForCli(io),
          format: options.format,
        },
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
          {
            writeOut,
            writeErr,
            setExitCode,
            authDir: io.authDir,
            env,
            remote: remoteClientForCli(io),
            format: options.format,
          },
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
        {
          writeOut,
          writeErr,
          setExitCode,
          authDir: io.authDir,
          env,
          remote: remoteClientForCli(io),
          format: options.format,
        },
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
        {
          writeOut,
          writeErr,
          setExitCode,
          authDir: io.authDir,
          env,
          remote: remoteClientForCli(io),
          format: options.format,
        },
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
        {
          writeOut,
          writeErr,
          setExitCode,
          authDir: io.authDir,
          env,
          remote: remoteClientForCli(io),
          format: options.format,
        },
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
          {
            writeOut,
            writeErr,
            setExitCode,
            authDir: io.authDir,
            env,
            remote: remoteClientForCli(io),
            format: options.format,
          },
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
          {
            writeOut,
            writeErr,
            setExitCode,
            authDir: io.authDir,
            env,
            remote: remoteClientForCli(io),
            format: options.format,
          },
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
          {
            writeOut,
            writeErr,
            setExitCode,
            authDir: io.authDir,
            env,
            remote: remoteClientForCli(io),
            format: options.format,
          },
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
      await loginAuth(serverId, {
        noOpen: options.open === false,
        writeOut,
        writeErr,
        ...(configPath ? { configPath } : {}),
        ...(projectConfigPath ? { projectConfigPath } : {}),
        config: localAuthConfigForTarget({
          serverId,
          ...(configPath ? { configPath } : {}),
          ...(projectConfigPath ? { projectConfigPath } : {}),
          source: target,
        }),
        ...(io.authDir ? { authDir: io.authDir } : {}),
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
      logoutAuth(serverId, {
        writeOut,
        ...(configPath ? { configPath } : {}),
        config: localAuthConfigForTarget({
          serverId,
          ...(configPath ? { configPath } : {}),
          ...(projectConfigPath ? { projectConfigPath } : {}),
          source: target,
        }),
        ...(io.authDir ? { authDir: io.authDir } : {}),
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
      await refreshAuth(serverId, {
        writeOut,
        ...(configPath ? { configPath } : {}),
        config: localAuthConfigForTarget({
          serverId,
          ...(configPath ? { configPath } : {}),
          ...(projectConfigPath ? { projectConfigPath } : {}),
          source: target,
        }),
        ...(io.authDir ? { authDir: io.authDir } : {}),
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

type VaultTarget = "global" | "remote";

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
    const output = new HiddenPromptOutput(process.stdout);
    const readline = createInterface({ input: process.stdin, output, terminal: true });
    try {
      value = await readline.question("Vault value: ");
    } finally {
      readline.close();
      process.stdout.write("\n");
    }
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

function resolveVaultAccessOrigin(capletId: string, io: CliIO): ConfigSource {
  const env = io.env ?? process.env;
  const configPath = envConfigPath(env);
  const projectConfigPath = envProjectConfigPath(env);
  const overlay = loadLocalOverlayConfigWithSources(configPath, projectConfigPath, {
    vaultResolver: vaultBootstrapResolver,
  });
  if (overlay.shadows[capletId]?.length) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Caplet ${capletId} is shadowed in multiple config sources; resolve the active config before granting Vault access.`,
    );
  }
  const origin = overlay.sources[capletId];
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

function localMutationTargetLabel(target: Exclude<MutationTarget, "remote">, io: CliIO): string {
  return remoteClientForCli(io) ? `${target} ` : "";
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
  const localRows = listLocalAuthRows({
    ...(configPath ? { configPath } : {}),
    ...(projectConfigPath ? { projectConfigPath } : {}),
    ...(io.authDir ? { authDir: io.authDir } : {}),
    ...(target ? { source: target } : {}),
  });
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
    config?: CapletsConfig | undefined;
  },
): Promise<string[]> {
  const engine = new CapletsEngine({
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.projectConfigPath ? { projectConfigPath: options.projectConfigPath } : {}),
    ...(options.authDir ? { authDir: options.authDir } : {}),
    watch: false,
    ...(options.config ? { configLoader: () => options.config as CapletsConfig } : {}),
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type ExecuteOperationIO = Required<Pick<CliIO, "writeOut" | "writeErr" | "setExitCode">> & {
  authDir?: string | undefined;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  remote?: RemoteControlClient | undefined;
  format?: CliOutputFormat | undefined;
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
  const engine = new CapletsEngine({
    ...(configPath ? { configPath } : {}),
    projectConfigPath: envProjectConfigPath(io.env ?? process.env),
    ...(io.authDir ? { authDir: io.authDir } : {}),
    watch: false,
    writeErr: io.writeErr,
    ...(config ? { configLoader: () => config } : {}),
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
