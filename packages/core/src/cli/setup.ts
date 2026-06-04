import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { CapletsError } from "../errors";
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

export type SetupOptions = {
  remote?: boolean;
  serverUrl?: string;
  output?: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  format?: SetupFormat;
  runCommand?: SetupCommandRunner;
  yes?: boolean;
  target?: SetupTargetOption;
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
    "Usage: caplets setup <integration>",
    "",
    "Supported integrations:",
    "  codex        Run Codex plugin marketplace and plugin install commands",
    "  claude-code  Run Claude Code plugin marketplace and plugin install commands",
    "  opencode     Run OpenCode native plugin install",
    "  pi           Run Pi extension install",
    "  mcp-client   Write a generic MCP client config with --output",
    "",
    "Examples:",
    "  caplets setup codex",
    "  caplets setup opencode --dry-run",
    "  caplets setup mcp-client --output ./caplets.mcp.json",
    "",
  ].join("\n");
}

export async function runSetup(integration: string, options: SetupOptions = {}): Promise<string> {
  if (!setupIntegrationIds.includes(integration as SetupIntegrationId)) {
    return await runCapletSetupCli(integration, {
      ...(options.yes === undefined ? {} : { yes: options.yes }),
      target: resolveSetupTargetKind(options),
      ...(options.remote === undefined ? {} : { remote: options.remote }),
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
    mode: options.remote ? "remote" : "local",
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
  if (options.remote) return remoteSetupDefinition(id, options);

  switch (id) {
    case "codex":
      return {
        name: "Codex",
        actions: [
          {
            type: "command",
            label: "Add Caplets marketplace to Codex",
            command: "codex",
            args: ["plugin", "marketplace", "add", "spiritledsoftware/caplets"],
          },
          {
            type: "command",
            label: "Install Caplets Codex plugin",
            command: "codex",
            args: ["plugin", "add", "caplets@caplets"],
          },
        ],
        nextSteps: [
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
            label: "Add Caplets marketplace to Claude Code",
            command: "claude",
            args: ["plugin", "marketplace", "add", "spiritledsoftware/caplets"],
          },
          {
            type: "command",
            label: "Install Caplets Claude Code plugin",
            command: "claude",
            args: ["plugin", "install", "caplets@caplets"],
          },
        ],
        nextSteps: [
          "Restart Claude Code if it was already running.",
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
    nonEmpty(options.serverUrl) ??
    nonEmpty(options.env?.CAPLETS_SERVER_URL) ??
    "https://caplets.example.com/caplets";

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
        `Run OpenCode with CAPLETS_MODE=remote and CAPLETS_SERVER_URL=${serverUrl}.`,
        "Keep CAPLETS_SERVER_PASSWORD in your shell or secret manager.",
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
        `Start Pi with CAPLETS_MODE=remote and CAPLETS_SERVER_URL=${serverUrl}.`,
        "Keep CAPLETS_SERVER_PASSWORD in your shell or secret manager.",
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
    name: id === "codex" ? "Codex" : id === "claude-code" ? "Claude Code" : "Any MCP client",
    actions: [
      {
        type: "writeFile",
        label: "Write remote MCP config",
        path: options.output,
        content: `${JSON.stringify(
          { mcpServers: { caplets: { url: `${serverUrl.replace(/\/$/, "")}/mcp` } } },
          null,
          2,
        )}\n`,
      },
    ],
    nextSteps: [
      "Add Basic Auth credentials through your agent's secret mechanism.",
      "Do not hardcode CAPLETS_SERVER_PASSWORD in a committed config file.",
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

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
  return options.remote ? "remote_host" : "local_host";
}
