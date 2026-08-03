import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { isCancel, multiselect } from "@clack/prompts";
import { canonicalizeCurrentHostOrigin } from "../current-host/origin";
import { loadConfig, resolveConfigPath, resolveProjectConfigPath } from "../config";
import { daemonClientBaseUrl, daemonStatus, installDaemon } from "../daemon";
import type { DaemonConfig, DaemonOperationOptions } from "../daemon/types";
import { CapletsError } from "../errors";
import { isLoopbackCurrentHostHostname } from "../current-host/origin";
import {
  detectAddMcpClients,
  listSupportedAddMcpClients,
  upsertCapletsMcpServer,
  type AddMcpClient,
} from "./add-mcp-adapter";
import { isNativeSetupIntegrationId, type SetupIntegrationId } from "./setup-integrations";
import { nativeDefaultsPath, writeNativeDefaults } from "../native/user-settings";
import { initConfig } from "./init";
import { runCapletSetupCli } from "./setup-caplet";
import { isSetupTargetKind, type SetupTargetKind } from "../setup/types";

const execFileAsync = promisify(execFile);
export type SetupFormat = "plain" | "json";
export type SetupTargetOption = SetupTargetKind | "local" | "remote";

export type SetupCommandResult = {
  stdout: string;
  stderr: string;
};

export type SetupCommandRunner = (command: string, args: string[]) => Promise<SetupCommandResult>;
export type SetupPromptReader = (prompt: string) => Promise<string>;

export type SetupPhaseStatus = "planned" | "completed" | "reused";

export type SetupPhaseResult = {
  phase: "config" | "daemon" | "integration";
  label: string;
  status: SetupPhaseStatus;
  path?: string;
  daemonBaseUrl?: string;
  message?: string;
};

export type SetupPhaseContext = {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
};

export type SetupPhaseOperations = {
  ensureUserConfig?: (context: SetupPhaseContext) => Promise<SetupPhaseResult> | SetupPhaseResult;
  ensureDaemon?: (context: SetupPhaseContext) => Promise<SetupPhaseResult> | SetupPhaseResult;
};

export type SetupMcpClient = AddMcpClient;

export type SetupMcpUpsertOptions = {
  clientId: string;
  daemonBaseUrl: string;
  local: boolean;
};

export type SetupMcpUpsertResult = {
  clientId: string;
  success: boolean;
  path: string;
  error?: string;
  droppedFields?: string[];
  extraPaths?: string[];
};

export type SetupMcpOperations = {
  listSupportedClients?: () => SetupMcpClient[];
  detectClients?: () => Promise<SetupMcpClient[]> | SetupMcpClient[];
  upsertServer?: (
    options: SetupMcpUpsertOptions,
  ) => Promise<SetupMcpUpsertResult> | SetupMcpUpsertResult;
};

export type SetupOptions = {
  remote?: boolean;
  remoteUrl?: string;
  serverUrl?: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  format?: SetupFormat;
  runCommand?: SetupCommandRunner;
  setupOperations?: SetupPhaseOperations;
  mcpOperations?: SetupMcpOperations;
  nativeDefaultsPath?: string;
  yes?: boolean;
  target?: SetupTargetOption;
};

export type InteractiveSetupOptions = SetupOptions & {
  selectIntegrations?: SetupIntegrationSelector;
};

export type SetupIntegrationChoice = {
  id: SetupIntegrationId;
  displayName: string;
  detected: boolean;
  native: boolean;
};

export type SetupIntegrationSelector = (
  choices: readonly SetupIntegrationChoice[],
) => Promise<readonly SetupIntegrationId[]>;

type SetupAction =
  | { type: "command"; label: string; command: string; args: string[] }
  | {
      type: "mcpClient";
      label: string;
      clientId: string;
      clientName: string;
      daemonBaseUrl: string;
      path: string;
      scope: "project" | "global";
    }
  | { type: "nativeDefaults"; label: string; daemonBaseUrl: string; path?: string };

type SetupActionResult = {
  label: string;
  command?: string;
  path?: string;
  status: "planned" | "completed";
  clientId?: string;
  clientName?: string;
  scope?: "project" | "global";
  droppedFields?: string[];
  extraPaths?: string[];
};

type SetupResult = {
  integration: SetupIntegrationId;
  name: string;
  mode: "local" | "remote";
  targetKind: SetupTargetKind;
  dryRun: boolean;
  phases: SetupPhaseResult[];
  actions: SetupActionResult[];
  nextSteps: string[];
};

/** Formats the direct integration choices accepted by `caplets setup`. */
export function formatSetupMenu(): string {
  const integrations = listSupportedAddMcpClients()
    .filter((client) => client.supportsStdio)
    .map((client) => {
      const setupType = client.id === "opencode" ? "native integration" : "MCP through add-mcp";
      return `  ${client.id.padEnd(19)} ${client.displayName} (${setupType})`;
    });

  return [
    "Usage: caplets setup [integration]",
    "",
    "Daemon-first local setup initializes Caplets config, starts or reuses the local daemon,",
    "then configures the selected integration.",
    "",
    "Supported integrations:",
    ...integrations,
    `  ${"pi".padEnd(19)} Pi (native integration)`,
    "",
    "Interactive setup lists detected add-mcp clients first, then all other supported clients.",
    "Use the arrow keys to move, Space to select, and Enter to run setup once.",
    "",
    "Remote setup:",
    "  Use --remote-url <origin> (or --server-url <origin>) to configure remote attach.",
    "",
    "Examples:",
    "  caplets setup",
    "  caplets setup cursor",
    "  caplets setup opencode --dry-run",
    "  caplets setup zed --remote-url https://caplets.example.com",
    "",
  ].join("\n");
}

/** Runs interactive setup for one or more detected or supported integrations. */
export async function runInteractiveSetup(options: InteractiveSetupOptions): Promise<string> {
  if (options.format === "json") {
    throw new CapletsError(
      "REQUEST_INVALID",
      "interactive caplets setup only supports plain output; pass an integration with --format json",
    );
  }

  const choices = await interactiveSetupChoices(options);
  const selected = options.selectIntegrations
    ? await options.selectIntegrations(choices)
    : await promptForSetupIntegrations(choices);
  const chunks: string[] = [];

  for (const integration of selected) {
    chunks.push(await runSetup(integration, options));
  }

  return chunks.join("\n");
}

async function promptForSetupIntegrations(
  choices: readonly SetupIntegrationChoice[],
): Promise<readonly SetupIntegrationId[]> {
  const cursorAt = choices.find((choice) => choice.detected)?.id;
  const selected = await multiselect<SetupIntegrationId>({
    message: "Select integrations",
    options: choices.map((choice) => ({
      value: choice.id,
      label: choice.displayName,
      hint: setupIntegrationChoiceHint(choice),
    })),
    required: true,
    showInstructions: true,
    withGuide: false,
    ...(cursorAt ? { cursorAt } : {}),
  });
  if (isCancel(selected)) {
    throw new CapletsError("REQUEST_INVALID", "setup cancelled");
  }
  return selected;
}

function setupIntegrationChoiceHint(choice: SetupIntegrationChoice): string {
  return [choice.id, choice.detected ? "detected" : undefined, choice.native ? "native" : undefined]
    .filter((detail): detail is string => detail !== undefined)
    .join(", ");
}

/** Sets up a direct integration or delegates an unknown name to Caplet setup metadata. */
export async function runSetup(integration: string, options: SetupOptions = {}): Promise<string> {
  const setupIntegration = resolveSetupIntegrationId(integration, options);
  if (!setupIntegration) {
    return await runCapletSetupCli(integration, {
      ...(options.yes === undefined ? {} : { yes: options.yes }),
      target: resolveSetupTargetKind(options),
      ...(options.env?.CAPLETS_CONFIG ? { configPath: options.env.CAPLETS_CONFIG } : {}),
      ...(options.env?.CAPLETS_PROJECT_CONFIG
        ? { projectConfigPath: options.env.CAPLETS_PROJECT_CONFIG }
        : {}),
      ...(options.remote === undefined && !isRemoteSetup(options)
        ? {}
        : { remote: isRemoteSetup(options) }),
    });
  }
  const result = await executeSetup(setupIntegration, options);
  if (options.format === "json") return `${JSON.stringify(result, null, 2)}\n`;
  return formatSetupResult(result);
}

async function executeSetup(id: SetupIntegrationId, options: SetupOptions): Promise<SetupResult> {
  const targetKind = resolveSetupTargetKind(options);
  setupDefinition(id, options, "http://127.0.0.1:5387/");
  const runner = options.runCommand ?? defaultSetupCommandRunner;
  const phases: SetupPhaseResult[] = [];
  let daemonBaseUrl: string | undefined;

  if (!isRemoteSetup(options)) {
    if (options.dryRun) {
      const planned = plannedLocalSetupPhases(options);
      phases.push(planned.config, planned.daemon);
      daemonBaseUrl = planned.daemon.daemonBaseUrl;
    } else {
      phases.push(await ensureUserConfigPhase(options));
      const daemonPhase = await ensureDaemonPhase(options);
      daemonBaseUrl = daemonPhase.daemonBaseUrl;
      phases.push(daemonPhase);
    }
  }

  const definition = setupDefinition(id, options, daemonBaseUrl);
  const actions: SetupActionResult[] = [];

  for (const action of definition.actions) {
    if (action.type === "mcpClient") {
      const commandText = formatCommand("caplets", ["attach", action.daemonBaseUrl]);
      if (options.dryRun) {
        actions.push({
          label: action.label,
          command: commandText,
          path: action.path,
          status: "planned",
          clientId: action.clientId,
          clientName: action.clientName,
          scope: action.scope,
        });
        continue;
      }
      const result = await mcpOperations(options).upsertServer({
        clientId: action.clientId,
        daemonBaseUrl: action.daemonBaseUrl,
        local: action.scope === "project",
      });
      if (!result.success) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          `Failed to configure ${action.clientName} MCP config${
            result.error ? `: ${result.error}` : ""
          }. The Caplets daemon is still ready; rerun caplets setup ${action.clientId} to retry.`,
        );
      }
      actions.push({
        label: action.label,
        command: commandText,
        path: result.path,
        status: "completed",
        clientId: action.clientId,
        clientName: action.clientName,
        scope: action.scope,
        ...(result.droppedFields?.length ? { droppedFields: result.droppedFields } : {}),
        ...(result.extraPaths?.length ? { extraPaths: result.extraPaths } : {}),
      });
      continue;
    }

    if (action.type === "nativeDefaults") {
      const path = action.path ?? nativeDefaultsPathForSetup(options);
      if (!options.dryRun) {
        writeNativeDefaults(
          { source: "setup", daemon: { url: action.daemonBaseUrl } },
          { path, env: setupEnv(options) },
        );
      }
      actions.push({
        label: action.label,
        path,
        status: options.dryRun ? "planned" : "completed",
      });
      continue;
    }

    if (action.type === "command") {
      const commandText = formatCommand(action.command, action.args);
      if (!options.dryRun) {
        try {
          await runner(action.command, action.args);
        } catch (error) {
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            `Setup action failed: ${commandText}${error instanceof Error ? `: ${error.message}` : ""}`,
          );
        }
      }
      actions.push({
        label: action.label,
        command: commandText,
        status: options.dryRun ? "planned" : "completed",
      });
      continue;
    }
  }

  phases.push({
    phase: "integration",
    label: `Configure ${definition.name}`,
    status: options.dryRun ? "planned" : "completed",
    message: `${actions.length} setup action${actions.length === 1 ? "" : "s"}`,
  });

  return {
    integration: id,
    name: definition.name,
    mode: isRemoteSetup(options) ? "remote" : "local",
    targetKind,
    dryRun: Boolean(options.dryRun),
    phases,
    actions,
    nextSteps: definition.nextSteps,
  };
}

function plannedLocalSetupPhases(options: SetupOptions): {
  config: SetupPhaseResult;
  daemon: SetupPhaseResult;
} {
  return {
    config: {
      phase: "config",
      label: "Initialize user Caplets config",
      status: "planned",
      path: userConfigPath(setupEnv(options)),
    },
    daemon: {
      phase: "daemon",
      label: "Start local Caplets daemon",
      status: "planned",
      daemonBaseUrl: "http://127.0.0.1:5387/",
      message: "install/start/reuse default daemon and verify health",
    },
  };
}

async function ensureUserConfigPhase(options: SetupOptions): Promise<SetupPhaseResult> {
  const operation = options.setupOperations?.ensureUserConfig ?? defaultEnsureUserConfig;
  return await operation({ env: setupEnv(options) });
}

async function ensureDaemonPhase(options: SetupOptions): Promise<SetupPhaseResult> {
  const operation = options.setupOperations?.ensureDaemon ?? defaultEnsureDaemon;
  try {
    const phase = await operation({ env: setupEnv(options) });
    if (!phase.daemonBaseUrl) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Caplets daemon setup did not return a daemon URL.",
      );
    }
    return phase;
  } catch (error) {
    if (error instanceof CapletsError) throw error;
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      `Caplets daemon setup failed before integration config mutation${
        error instanceof Error ? `: ${error.message}` : ""
      }`,
    );
  }
}

function defaultEnsureUserConfig(context: SetupPhaseContext): SetupPhaseResult {
  const path = userConfigPath(context.env);
  if (!existsSync(path)) {
    initConfig({ path });
    loadConfig(path, projectConfigPath(context.env));
    return {
      phase: "config",
      label: "Initialize user Caplets config",
      status: "completed",
      path,
      message: "created user config",
    };
  }

  loadConfig(path, projectConfigPath(context.env));
  return {
    phase: "config",
    label: "Initialize user Caplets config",
    status: "reused",
    path,
    message: "existing user config is valid",
  };
}

async function defaultEnsureDaemon(context: SetupPhaseContext): Promise<SetupPhaseResult> {
  const operation = daemonOperationOptions(context.env);
  const status = await daemonStatus(operation);
  if (status.config) assertCredentialFreeLocalSetupDaemonHost(status.config);
  if (status.installed && status.running && status.health?.ok && status.config) {
    if (!isCredentialFreeLocalSetupDaemon(status.config)) {
      return await installCredentialFreeLocalSetupDaemon(operation);
    }
    return {
      phase: "daemon",
      label: "Reuse local Caplets daemon",
      status: "reused",
      daemonBaseUrl: daemonClientBaseUrl(status.config).toString(),
      message: "existing daemon is healthy",
    };
  }

  return await installCredentialFreeLocalSetupDaemon(operation);
}

async function installCredentialFreeLocalSetupDaemon(
  operation: DaemonOperationOptions,
): Promise<SetupPhaseResult> {
  const result = await installDaemon(
    { start: true, host: "127.0.0.1", allowUnauthenticatedHttp: true },
    operation,
  );
  const config = result.status.config ?? result.config;
  assertCredentialFreeLocalSetupDaemonHost(config);
  const health = result.status.health ?? result.validation;
  if (!result.status.running || health?.ok !== true) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      `Caplets daemon health verification failed${health?.error ? `: ${health.error}` : ""}`,
    );
  }

  return {
    phase: "daemon",
    label: "Start local Caplets daemon",
    status: "completed",
    daemonBaseUrl: daemonClientBaseUrl(config).toString(),
    message: result.plannedActions.join(", "),
  };
}

function isCredentialFreeLocalSetupDaemon(config: Pick<DaemonConfig, "serve">): boolean {
  return (
    config.serve.allowUnauthenticatedHttp === true &&
    config.serve.auth.type === "development_unauthenticated"
  );
}

function assertCredentialFreeLocalSetupDaemonHost(config: Pick<DaemonConfig, "serve">): void {
  if (!isLoopbackCurrentHostHostname(config.serve.host)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `caplets setup cannot configure credential-free local attach for daemon host ${config.serve.host}. Reinstall the local daemon on 127.0.0.1 or use remote setup.`,
    );
  }
}

function setupEnv(options: SetupOptions): NodeJS.ProcessEnv | Record<string, string | undefined> {
  return options.env ?? process.env;
}

function daemonOperationOptions(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): DaemonOperationOptions {
  return {
    env,
    healthTimeoutMs: 10_000,
    healthIntervalMs: 200,
  };
}

function userConfigPath(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  return resolveConfigPath(nonEmpty(env.CAPLETS_CONFIG));
}

function projectConfigPath(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  return nonEmpty(env.CAPLETS_PROJECT_CONFIG) ?? resolveProjectConfigPath();
}

function nativeDefaultsPathForSetup(options: SetupOptions): string {
  return nativeDefaultsPath({
    ...(options.nativeDefaultsPath ? { path: options.nativeDefaultsPath } : {}),
    env: setupEnv(options),
  });
}

function setupDefinition(
  id: SetupIntegrationId,
  options: SetupOptions,
  daemonBaseUrl: string | undefined,
): { name: string; actions: SetupAction[]; nextSteps: string[] } {
  if (isRemoteSetup(options)) return remoteSetupDefinition(id, options);
  const localDaemonBaseUrl = daemonBaseUrl ?? "http://127.0.0.1:5387/";

  if (!isNativeSetupIntegrationId(id)) {
    return mcpClientSetupDefinition(id, localDaemonBaseUrl, options);
  }

  if (id === "opencode") {
    return {
      name: "OpenCode",
      actions: [
        {
          type: "command",
          label: "Install OpenCode Caplets plugin globally",
          command: "opencode",
          args: ["plugin", "@caplets/opencode", "--global"],
        },
        {
          type: "nativeDefaults",
          label: "Write Caplets native daemon defaults",
          daemonBaseUrl: localDaemonBaseUrl,
          ...(options.nativeDefaultsPath ? { path: options.nativeDefaultsPath } : {}),
        },
      ],
      nextSteps: [
        "OpenCode reads local Caplets config and exposes native caplets_<id> tools.",
        "Try a premade Caplet: caplets install spiritledsoftware/caplets github",
      ],
    };
  }

  return {
    name: "Pi",
    actions: [
      {
        type: "command",
        label: "Install Pi Caplets extension",
        command: "pi",
        args: ["install", "npm:@caplets/pi"],
      },
      {
        type: "nativeDefaults",
        label: "Write Caplets native daemon defaults",
        daemonBaseUrl: localDaemonBaseUrl,
        ...(options.nativeDefaultsPath ? { path: options.nativeDefaultsPath } : {}),
      },
    ],
    nextSteps: [
      "Pi reads local Caplets config and exposes native tools.",
      "Try a premade Caplet: caplets install spiritledsoftware/caplets github",
    ],
  };
}

function mcpClientSetupDefinition(
  clientId: string,
  daemonBaseUrl: string,
  options: SetupOptions,
): { name: string; actions: SetupAction[]; nextSteps: string[] } {
  const client = resolveSetupMcpClient(clientId, options);
  const scope = client.projectConfigPath ? "project" : "global";
  const path = client.projectConfigPath ?? client.configPath;
  const connectionStep = isRemoteSetup(options)
    ? `Run caplets remote login ${daemonBaseUrl} before using this MCP config.`
    : `Caplets daemon is ready at ${daemonBaseUrl}; ${client.displayName} runs caplets attach as a thin client.`;
  return {
    name: client.displayName,
    actions: [
      {
        type: "mcpClient",
        label: `Add Caplets MCP server to ${client.displayName}`,
        clientId: client.id,
        clientName: client.displayName,
        daemonBaseUrl,
        path,
        scope,
      },
    ],
    nextSteps: [
      connectionStep,
      `Restart or reload ${client.displayName} and confirm the caplets MCP server is connected.`,
      "Try a premade Caplet: caplets install spiritledsoftware/caplets github",
    ],
  };
}

function resolveSetupMcpClient(clientId: string, options: SetupOptions): SetupMcpClient {
  const clients = mcpOperations(options).listSupportedClients();
  const client = clients.find((entry) => entry.id === clientId);
  if (!client) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `MCP client must be one of: ${clients.map((entry) => entry.id).join(", ")}`,
    );
  }
  if (!client.supportsStdio) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `${client.displayName} does not support stdio MCP servers through add-mcp.`,
    );
  }
  return client;
}

async function interactiveSetupChoices(options: SetupOptions): Promise<SetupIntegrationChoice[]> {
  const operations = mcpOperations(options);
  const detectedIds = new Set(
    (await operations.detectClients())
      .filter((client) => client.supportsStdio)
      .map((client) => client.id),
  );
  const supported = operations.listSupportedClients().filter((client) => client.supportsStdio);
  const choices: SetupIntegrationChoice[] = supported.map((client) => ({
    id: client.id,
    displayName: client.displayName,
    detected: detectedIds.has(client.id),
    native: client.id === "opencode",
  }));
  if (!choices.some((choice) => choice.id === "opencode")) {
    choices.push({
      id: "opencode",
      displayName: "OpenCode",
      detected: detectedIds.has("opencode"),
      native: true,
    });
  }

  return [
    ...choices.filter((choice) => choice.detected),
    ...choices.filter((choice) => !choice.detected),
    { id: "pi", displayName: "Pi", detected: false, native: true },
  ];
}

function mcpOperations(options: SetupOptions): Required<SetupMcpOperations> {
  return {
    listSupportedClients: options.mcpOperations?.listSupportedClients ?? listSupportedAddMcpClients,
    detectClients: options.mcpOperations?.detectClients ?? detectAddMcpClients,
    upsertServer: options.mcpOperations?.upsertServer ?? upsertCapletsMcpServer,
  };
}

function remoteSetupDefinition(
  id: SetupIntegrationId,
  options: SetupOptions,
): { name: string; actions: SetupAction[]; nextSteps: string[] } {
  const serverUrl = canonicalizeCurrentHostOrigin(
    nonEmpty(options.remoteUrl) ??
      nonEmpty(options.serverUrl) ??
      nonEmpty(options.env?.CAPLETS_REMOTE_URL) ??
      "https://caplets.example.com",
  );

  if (id === "opencode") {
    return {
      name: "OpenCode",
      actions: [
        {
          type: "command",
          label: "Install OpenCode Caplets plugin globally",
          command: "opencode",
          args: ["plugin", "@caplets/opencode", "--global"],
        },
      ],
      nextSteps: [
        `Run caplets remote login ${serverUrl} before starting OpenCode.`,
        `Run OpenCode with CAPLETS_MODE=remote and CAPLETS_REMOTE_URL=${serverUrl}.`,
      ],
    };
  }

  if (id === "pi") {
    return {
      name: "Pi",
      actions: [
        {
          type: "command",
          label: "Install Pi Caplets extension",
          command: "pi",
          args: ["install", "npm:@caplets/pi"],
        },
      ],
      nextSteps: [
        `Run caplets remote login ${serverUrl} before starting Pi.`,
        `Start Pi with CAPLETS_MODE=remote and CAPLETS_REMOTE_URL=${serverUrl}.`,
      ],
    };
  }

  return mcpClientSetupDefinition(id, serverUrl, options);
}

function resolveSetupIntegrationId(
  value: string,
  options: SetupOptions,
): SetupIntegrationId | undefined {
  if (isNativeSetupIntegrationId(value)) return value;
  return mcpOperations(options)
    .listSupportedClients()
    .find((client) => client.id === value)?.id;
}

async function defaultSetupCommandRunner(
  command: string,
  args: string[],
): Promise<SetupCommandResult> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    encoding: "utf8",
    windowsHide: true,
  });
  return { stdout, stderr };
}

function formatSetupResult(result: SetupResult): string {
  const lines = [
    `${result.dryRun ? "Dry run" : "Completed"} ${result.name} setup (${result.mode}, ${result.targetKind})`,
    "",
  ];
  for (const phase of result.phases) {
    const details = phase.daemonBaseUrl ?? phase.path ?? phase.message;
    lines.push(`- ${phase.status} ${phase.phase}: ${phase.label}${details ? ` (${details})` : ""}`);
  }
  for (const action of result.actions) {
    if (action.clientId) {
      const clientName = action.clientName ?? action.label;
      const scope = action.scope ? ` (${action.scope})` : "";
      const path = action.path ? ` at ${action.path}` : "";
      lines.push(`- ${action.status}: configured ${clientName} MCP client${scope}${path}`);
      if (action.command) lines.push(`  command: ${action.command}`);
      if (action.droppedFields?.length) {
        lines.push(`  add-mcp dropped unsupported fields: ${action.droppedFields.join(", ")}`);
      }
      if (action.extraPaths?.length) {
        lines.push(`  add-mcp additional paths: ${action.extraPaths.join(", ")}`);
      }
      continue;
    }
    if (action.command) lines.push(`- ${action.status}: ${action.command}`);
    if (action.path) lines.push(`- ${action.status}: wrote ${action.path}`);
  }
  if (result.nextSteps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of result.nextSteps) lines.push(`- ${step}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isRemoteSetup(options: SetupOptions): boolean {
  if (options.remote !== undefined) return options.remote;
  return (
    nonEmpty(options.remoteUrl) !== undefined ||
    nonEmpty(options.serverUrl) !== undefined ||
    options.target === "remote" ||
    options.target === "remote_host"
  );
}

function resolveSetupTargetKind(options: SetupOptions): SetupTargetKind {
  if (options.target !== undefined) {
    if (isSetupTargetKind(options.target)) return options.target;
    if (options.target === "local") return "local_host";
    if (options.target === "remote") return "remote_host";
    throw new CapletsError(
      "REQUEST_INVALID",
      "setup target must be one of: local_host, remote_host",
    );
  }
  return isRemoteSetup(options) ? "remote_host" : "local_host";
}
