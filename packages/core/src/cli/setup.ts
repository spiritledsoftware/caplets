import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { loadConfig, resolveConfigPath, resolveProjectConfigPath } from "../config";
import { daemonClientBaseUrl, daemonStatus, installDaemon } from "../daemon";
import type { DaemonOperationOptions } from "../daemon/types";
import { CapletsError } from "../errors";
import { isCapletsCloudUrl } from "../remote/options";
import {
  detectAddMcpClients,
  listSupportedAddMcpClients,
  upsertCapletsMcpServer,
  type AddMcpClient,
} from "./add-mcp-adapter";
import { initConfig } from "./init";
import { runCapletSetupCli } from "./setup-caplet";
import { isSetupTargetKind, type SetupTargetKind } from "../setup/types";

const execFileAsync = promisify(execFile);

export const setupIntegrationIds = [
  "codex",
  "claude-code",
  "opencode",
  "pi",
  "mcp-client",
] as const;

export type SetupIntegrationId = (typeof setupIntegrationIds)[number];
export type SetupFormat = "plain" | "json";
export type SetupTargetOption = SetupTargetKind | "local" | "remote" | "cloud" | "hosted_worker";

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

export type SetupMcpClient = Omit<AddMcpClient, "id"> & { id: string };

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
  output?: string;
  client?: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  format?: SetupFormat;
  runCommand?: SetupCommandRunner;
  setupOperations?: SetupPhaseOperations;
  mcpOperations?: SetupMcpOperations;
  yes?: boolean;
  target?: SetupTargetOption;
};

export type InteractiveSetupOptions = SetupOptions & {
  readPrompt: SetupPromptReader;
};

type SetupAction =
  | { type: "command"; label: string; command: string; args: string[] }
  | { type: "writeFile"; label: string; path: string; content: string }
  | {
      type: "mcpClient";
      label: string;
      clientId: string;
      clientName: string;
      daemonBaseUrl: string;
      path: string;
      scope: "project" | "global";
    };

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

function localMcpConfig(daemonBaseUrl: string): string {
  return `${JSON.stringify(
    {
      mcpServers: {
        caplets: {
          command: "caplets",
          args: ["attach", daemonBaseUrl],
        },
      },
    },
    null,
    2,
  )}
`;
}

export function formatSetupMenu(): string {
  return [
    "Usage: caplets setup [integration]",
    "",
    "Supported integrations:",
    "  codex        Add Caplets to Codex MCP config",
    "  claude-code  Add Caplets to Claude Code MCP config",
    "  opencode     Run OpenCode native plugin install",
    "  pi           Run Pi extension install",
    "  mcp-client   Add Caplets to any supported MCP client with --client",
    "",
    "Examples:",
    "  caplets setup",
    "  caplets setup codex",
    "  caplets setup opencode --dry-run",
    "  caplets setup mcp-client --client codex",
    "  caplets setup mcp-client --output ./caplets.mcp.json",
    "",
  ].join("\n");
}

export function formatSetupPrompt(): string {
  return [
    "Select integrations to set up:",
    "  1. Codex",
    "  2. Claude Code",
    "  3. OpenCode",
    "  4. Pi",
    "  5. Any MCP client",
    "",
    "Enter numbers, ids, or all, separated by commas (default: codex): ",
  ].join("\n");
}

export async function runInteractiveSetup(options: InteractiveSetupOptions): Promise<string> {
  if (options.format === "json") {
    throw new CapletsError(
      "REQUEST_INVALID",
      "interactive caplets setup only supports plain output; pass an integration with --format json",
    );
  }

  const selected = parseInteractiveSetupSelection(await options.readPrompt(formatSetupPrompt()));
  const chunks: string[] = [];

  for (const integration of selected) {
    const setupOptions: SetupOptions = { ...options };
    if (integration === "mcp-client" && !setupOptions.output && !setupOptions.client) {
      setupOptions.client = await promptForMcpClient(setupOptions, options.readPrompt);
    }
    chunks.push(await runSetup(integration, setupOptions));
  }

  return chunks.join("\n");
}

export async function runSetup(integration: string, options: SetupOptions = {}): Promise<string> {
  if (!setupIntegrationIds.includes(integration as SetupIntegrationId)) {
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
  const result = await executeSetup(integration, options);
  if (options.format === "json") return `${JSON.stringify(result, null, 2)}\n`;
  return formatSetupResult(result);
}

async function executeSetup(integration: string, options: SetupOptions): Promise<SetupResult> {
  const id = parseSetupIntegrationId(integration);
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
        local: true,
      });
      if (!result.success) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          `Failed to configure ${action.clientName} MCP config${
            result.error ? `: ${result.error}` : ""
          }. The Caplets daemon is still ready; rerun caplets setup mcp-client --client ${action.clientId} to retry.`,
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

    if (!options.dryRun) {
      try {
        mkdirSync(dirname(action.path), { recursive: true });
        writeFileSync(action.path, action.content, { flag: "wx", mode: 0o600 });
      } catch (error) {
        throw new CapletsError(
          "CONFIG_INVALID",
          `Setup action failed: write ${action.path}${error instanceof Error ? `: ${error.message}` : ""}`,
        );
      }
    }
    actions.push({
      label: action.label,
      path: action.path,
      status: options.dryRun ? "planned" : "completed",
    });
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
    targetKind: resolveSetupTargetKind(options),
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
  if (status.installed && status.running && status.health?.ok && status.config) {
    return {
      phase: "daemon",
      label: "Reuse local Caplets daemon",
      status: "reused",
      daemonBaseUrl: daemonClientBaseUrl(status.config).toString(),
      message: "existing daemon is healthy",
    };
  }

  const result = await installDaemon({ start: true }, operation);
  const config = result.status.config ?? result.config;
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
  return (
    nonEmpty(env.CAPLETS_PROJECT_CONFIG) ?? resolveProjectConfigPath(dirname(userConfigPath(env)))
  );
}

function setupDefinition(
  id: SetupIntegrationId,
  options: SetupOptions,
  daemonBaseUrl: string | undefined,
): { name: string; actions: SetupAction[]; nextSteps: string[] } {
  if (isRemoteSetup(options)) return remoteSetupDefinition(id, options);
  const localDaemonBaseUrl = daemonBaseUrl ?? "http://127.0.0.1:5387/";

  switch (id) {
    case "codex":
      return mcpClientSetupDefinition("codex", "Codex", localDaemonBaseUrl, options);
    case "claude-code":
      return mcpClientSetupDefinition("claude-code", "Claude Code", localDaemonBaseUrl, options);
    case "opencode":
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
          "OpenCode reads local Caplets config and exposes native caplets_<id> tools.",
          "Try a premade Caplet: caplets install spiritledsoftware/caplets github",
        ],
      };
    case "pi":
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
          "Pi reads local Caplets config and exposes native tools.",
          "Try a premade Caplet: caplets install spiritledsoftware/caplets github",
        ],
      };
    case "mcp-client":
      if (options.client) {
        return mcpClientSetupDefinition(options.client, "MCP client", localDaemonBaseUrl, options);
      }
      if (!options.output) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "caplets setup mcp-client requires --client <id> or --output <path>",
        );
      }
      return {
        name: "Any MCP client",
        actions: [
          {
            type: "writeFile",
            label: "Write generic MCP stdio config",
            path: options.output,
            content: localMcpConfig(localDaemonBaseUrl),
          },
        ],
        nextSteps: ["Import the written MCP config into your MCP client."],
      };
  }
}

function mcpClientSetupDefinition(
  clientId: string,
  fallbackName: string,
  daemonBaseUrl: string,
  options: SetupOptions,
): { name: string; actions: SetupAction[]; nextSteps: string[] } {
  const client = resolveSetupMcpClient(clientId, options);
  const scope = client.projectConfigPath ? "project" : "global";
  const path = client.projectConfigPath ?? client.configPath;
  const name = fallbackName === "MCP client" ? client.displayName : fallbackName;
  return {
    name,
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
      `Caplets daemon is ready at ${daemonBaseUrl}; ${client.displayName} runs caplets attach as a thin client.`,
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

async function promptForMcpClient(
  options: SetupOptions,
  readPrompt: SetupPromptReader,
): Promise<string> {
  const operations = mcpOperations(options);
  const detected = await operations.detectClients();
  const supported = operations.listSupportedClients().filter((client) => client.supportsStdio);
  const primary = detected.length > 0 ? detected : supported;
  const answer = nonEmpty(await readPrompt(formatMcpClientPrompt(primary, detected.length > 0)));
  if (answer && isShowAllMcpClientsAnswer(answer)) {
    return parseMcpClientPromptAnswer(
      nonEmpty(await readPrompt(formatMcpClientPrompt(supported, false))) ?? "",
      supported,
    );
  }
  return parseMcpClientPromptAnswer(answer ?? primary[0]?.id ?? "", primary);
}

function formatMcpClientPrompt(clients: SetupMcpClient[], detected: boolean): string {
  const lines = [
    detected ? "Detected MCP clients:" : "Supported MCP clients:",
    ...clients.map(
      (client, index) =>
        `  ${index + 1}. ${client.displayName} (${client.id}) -> ${
          client.projectConfigPath ?? client.configPath
        }`,
    ),
  ];
  if (detected) lines.push("  all. Show all supported MCP clients");
  lines.push("", "Enter MCP client id or number: ");
  return lines.join("\n");
}

function parseMcpClientPromptAnswer(answer: string, clients: SetupMcpClient[]): string {
  const normalized = answer.trim();
  const byIndex = Number(normalized);
  if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= clients.length) {
    return clients[byIndex - 1]!.id;
  }
  const client = clients.find(
    (entry) =>
      entry.id === normalized || entry.displayName.toLowerCase() === normalized.toLowerCase(),
  );
  if (client) return client.id;
  throw new CapletsError("REQUEST_INVALID", `unknown MCP client selection: ${answer || "<empty>"}`);
}

function isShowAllMcpClientsAnswer(answer: string): boolean {
  return ["all", "a", "show all", "show-all"].includes(answer.trim().toLowerCase());
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
  const serverUrl =
    nonEmpty(options.remoteUrl) ??
    nonEmpty(options.serverUrl) ??
    nonEmpty(options.env?.CAPLETS_REMOTE_URL) ??
    "https://caplets.example.com/caplets";
  const mode = isCapletsCloudUrl(serverUrl) ? "cloud" : "remote";

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
        `Run OpenCode with CAPLETS_MODE=${mode} and CAPLETS_REMOTE_URL=${serverUrl}.`,
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
        `Start Pi with CAPLETS_MODE=${mode} and CAPLETS_REMOTE_URL=${serverUrl}.`,
      ],
    };
  }

  if (id === "codex") {
    return {
      name: "Codex",
      actions: [
        {
          type: "command",
          label: "Add remote-backed Caplets MCP server to Codex",
          command: "codex",
          args: codexMcpAddArgs(["attach", serverUrl]),
        },
      ],
      nextSteps: [
        `Run caplets remote login ${serverUrl} before using this MCP config.`,
        "In Codex, run /mcp to confirm the caplets server is connected.",
      ],
    };
  }

  if (id === "claude-code") {
    return {
      name: "Claude Code",
      actions: [
        {
          type: "command",
          label: "Add remote-backed Caplets MCP server to Claude Code",
          command: "claude",
          args: claudeMcpAddArgs(["attach", serverUrl]),
        },
      ],
      nextSteps: [
        `Run caplets remote login ${serverUrl} before using this MCP config.`,
        "In Claude Code, run /mcp to confirm the caplets server is connected.",
      ],
    };
  }

  if (!options.output) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "remote MCP-backed setup requires --output <path> so Caplets can write a client config without guessing your agent's secret storage",
    );
  }

  return {
    name: "Any MCP client",
    actions: [
      {
        type: "writeFile",
        label: "Write remote MCP config",
        path: options.output,
        content: `${JSON.stringify(
          {
            mcpServers: {
              caplets: {
                command: "caplets",
                args: ["attach", serverUrl],
              },
            },
          },
          null,
          2,
        )}\n`,
      },
    ],
    nextSteps: [
      `Run caplets remote login ${serverUrl} before using this MCP config.`,
      "Import the written MCP config into your MCP client.",
    ],
  };
}

function parseSetupIntegrationId(value: string): SetupIntegrationId {
  if (setupIntegrationIds.includes(value as SetupIntegrationId)) {
    return value as SetupIntegrationId;
  }
  throw new CapletsError(
    "REQUEST_INVALID",
    `setup integration must be one of: ${setupIntegrationIds.join(", ")}`,
  );
}

function parseInteractiveSetupSelection(value: string): SetupIntegrationId[] {
  const rawSelections = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const selections = rawSelections.length > 0 ? rawSelections : ["codex"];
  const ids = selections.flatMap((selection) =>
    normalizedInteractiveSetupToken(selection) === "all"
      ? setupIntegrationIds
      : [parseInteractiveSetupToken(selection)],
  );
  return [...new Set(ids)];
}

function parseInteractiveSetupToken(value: string): SetupIntegrationId {
  const normalized = normalizedInteractiveSetupToken(value);
  if (normalized === "1" || normalized === "codex") return "codex";
  if (
    normalized === "2" ||
    normalized === "claude" ||
    normalized === "claude-code" ||
    normalized === "claudecode"
  ) {
    return "claude-code";
  }
  if (normalized === "3" || normalized === "opencode" || normalized === "open-code") {
    return "opencode";
  }
  if (normalized === "4" || normalized === "pi") return "pi";
  if (
    normalized === "5" ||
    normalized === "mcp" ||
    normalized === "mcp-client" ||
    normalized === "any-mcp-client" ||
    normalized === "generic" ||
    normalized === "generic-mcp"
  ) {
    return "mcp-client";
  }
  throw new CapletsError("REQUEST_INVALID", `unknown setup integration selection: ${value}`);
}

function normalizedInteractiveSetupToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-");
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

function codexMcpAddArgs(capletsArgs: string[]): string[] {
  return ["mcp", "add", "caplets", "--", "caplets", ...capletsArgs];
}

function claudeMcpAddArgs(capletsArgs: string[]): string[] {
  return [
    "mcp",
    "add",
    "--transport",
    "stdio",
    "--scope",
    "user",
    "caplets",
    "--",
    "caplets",
    ...capletsArgs,
  ];
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isRemoteSetup(options: SetupOptions): boolean {
  return Boolean(options.remote ?? nonEmpty(options.remoteUrl) ?? nonEmpty(options.serverUrl));
}

function resolveSetupTargetKind(options: SetupOptions): SetupTargetKind {
  if (options.target !== undefined) {
    if (isSetupTargetKind(options.target)) return options.target;
    if (options.target === "local") return "local_host";
    if (options.target === "remote") return "remote_host";
    if (options.target === "cloud" || options.target === "hosted_worker") return "hosted_sandbox";
    throw new CapletsError(
      "REQUEST_INVALID",
      "setup target must be one of: local_host, remote_host, hosted_sandbox",
    );
  }
  return isRemoteSetup(options) ? "remote_host" : "local_host";
}
