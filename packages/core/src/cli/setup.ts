import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { CapletsError } from "../errors";
import { isCapletsCloudUrl } from "../remote/options";
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

export type SetupOptions = {
  remote?: boolean;
  remoteUrl?: string;
  serverUrl?: string;
  output?: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  format?: SetupFormat;
  runCommand?: SetupCommandRunner;
  yes?: boolean;
  target?: SetupTargetOption;
};

export type InteractiveSetupOptions = SetupOptions & {
  readPrompt: SetupPromptReader;
};

type SetupAction =
  | { type: "command"; label: string; command: string; args: string[] }
  | { type: "writeFile"; label: string; path: string; content: string };

type SetupActionResult = {
  label: string;
  command?: string;
  path?: string;
  status: "planned" | "completed";
};

type SetupResult = {
  integration: SetupIntegrationId;
  name: string;
  mode: "local" | "remote";
  targetKind: SetupTargetKind;
  dryRun: boolean;
  actions: SetupActionResult[];
  nextSteps: string[];
};

const localMcpConfig = `{
  "mcpServers": {
    "caplets": {
      "command": "caplets",
      "args": ["serve"]
    }
  }
}
`;

export function formatSetupMenu(): string {
  return [
    "Usage: caplets setup [integration]",
    "",
    "Supported integrations:",
    "  codex        Add Caplets to Codex MCP config",
    "  claude-code  Add Caplets to Claude Code MCP config",
    "  opencode     Run OpenCode native plugin install",
    "  pi           Run Pi extension install",
    "  mcp-client   Write a generic MCP client config with --output",
    "",
    "Examples:",
    "  caplets setup",
    "  caplets setup codex",
    "  caplets setup opencode --dry-run",
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
    if (integration === "mcp-client" && !setupOptions.output) {
      const output = nonEmpty(
        await options.readPrompt("Path to write generic MCP config (--output): "),
      );
      if (!output) {
        throw new CapletsError("REQUEST_INVALID", "mcp-client setup requires an output path");
      }
      setupOptions.output = output;
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
  const definition = setupDefinition(id, options);
  const actions: SetupActionResult[] = [];
  const runner = options.runCommand ?? defaultSetupCommandRunner;

  for (const action of definition.actions) {
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

  return {
    integration: id,
    name: definition.name,
    mode: isRemoteSetup(options) ? "remote" : "local",
    targetKind: resolveSetupTargetKind(options),
    dryRun: Boolean(options.dryRun),
    actions,
    nextSteps: definition.nextSteps,
  };
}

function setupDefinition(
  id: SetupIntegrationId,
  options: SetupOptions,
): { name: string; actions: SetupAction[]; nextSteps: string[] } {
  if (isRemoteSetup(options)) return remoteSetupDefinition(id, options);

  switch (id) {
    case "codex":
      return {
        name: "Codex",
        actions: [
          {
            type: "command",
            label: "Add Caplets MCP server to Codex",
            command: "codex",
            args: codexMcpAddArgs(["serve"]),
          },
        ],
        nextSteps: [
          "In Codex, run /mcp to confirm the caplets server is connected.",
          "Try a premade Caplet: caplets install spiritledsoftware/caplets github",
          'Ask Codex: codex "try using the github caplet"',
        ],
      };
    case "claude-code":
      return {
        name: "Claude Code",
        actions: [
          {
            type: "command",
            label: "Add Caplets MCP server to Claude Code",
            command: "claude",
            args: claudeMcpAddArgs(["serve"]),
          },
        ],
        nextSteps: [
          "In Claude Code, run /mcp to confirm the caplets server is connected.",
          "Try a premade Caplet: caplets install spiritledsoftware/caplets github",
        ],
      };
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
      if (!options.output) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "caplets setup mcp-client requires --output <path> because MCP clients do not share one config path",
        );
      }
      return {
        name: "Any MCP client",
        actions: [
          {
            type: "writeFile",
            label: "Write generic MCP stdio config",
            path: options.output,
            content: localMcpConfig,
          },
        ],
        nextSteps: ["Import the written MCP config into your MCP client."],
      };
  }
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
