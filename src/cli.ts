import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Command, CommanderError } from "commander";
import { version as packageJsonVersion } from "../package.json";
import {
  DEFAULT_AUTH_DIR,
  loadConfig,
  resolveCapletsRoot,
  resolveConfigPath,
  resolveProjectCapletsRoot,
  resolveProjectConfigPath,
  TRUST_PROJECT_CAPLETS_ENV,
  type CapletConfig,
  type CapletsConfig,
} from "./config.js";
import { CapletsError, toSafeError } from "./errors.js";
import type { ServerStatus } from "./registry.js";
import {
  deleteTokenBundle,
  isTokenBundleExpired,
  readTokenBundle,
  runGenericOAuthFlow,
  runOAuthFlow,
  type GenericAuthTarget,
} from "./auth.js";

type CliIO = {
  writeOut?: (value: string) => void;
  writeErr?: (value: string) => void;
  authDir?: string;
};

type CapletListRow = {
  server: string;
  backend: CapletConfig["backend"];
  name: string;
  description: string;
  disabled: boolean;
  status: ServerStatus;
};

type ConfigPaths = {
  userConfig: string;
  projectConfig: string;
  userRoot: string;
  projectRoot: string;
  authDir: string;
  envConfig: string | null;
  projectCapletsTrusted: boolean;
};

export async function runCli(args: string[], io: CliIO = {}): Promise<void> {
  const program = createProgram(io);
  try {
    await program.parseAsync(["node", "caplets", ...args]);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return;
      }
      throw new CapletsError("REQUEST_INVALID", error.message);
    }
    throw error;
  }
}

export function createProgram(io: CliIO = {}): Command {
  const writeOut = io.writeOut ?? ((value: string) => process.stdout.write(value));
  const writeErr = io.writeErr ?? ((value: string) => process.stderr.write(value));
  const program = new Command();

  program
    .name("caplets")
    .description("Progressive-disclosure gateway for MCP servers.")
    .version(packageJsonVersion)
    .exitOverride()
    .configureOutput({
      writeOut,
      writeErr,
      outputError: (value, write) => write(value),
    });

  program
    .command("init")
    .description("Create a starter Caplets config file.")
    .option("--force", "overwrite an existing config file")
    .action((options: { force?: boolean }) => {
      const configPath = envConfigPath();
      const path = initConfig({
        ...(configPath ? { path: configPath } : {}),
        force: Boolean(options.force),
      });
      writeOut(`Created Caplets config at ${path}\n`);
    });

  program
    .command("list")
    .description("List configured Caplets.")
    .option("--all", "include disabled Caplets")
    .option("--json", "print JSON output")
    .action((options: { all?: boolean; json?: boolean }) => {
      const config = loadConfig(envConfigPath());
      const rows = listCaplets(config, { includeDisabled: Boolean(options.all) });
      if (options.json) {
        writeOut(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      writeOut(formatCapletList(rows));
    });

  const config = program.command("config").description("Inspect Caplets config locations.");

  config
    .command("path")
    .description("Print the effective user config path.")
    .action(() => {
      writeOut(`${resolveConfigPath(envConfigPath())}\n`);
    });

  config
    .command("paths")
    .description("Print resolved Caplets config, root, and auth paths.")
    .option("--json", "print JSON output")
    .action((options: { json?: boolean }) => {
      const paths = resolveCliConfigPaths(io.authDir);
      if (options.json) {
        writeOut(`${JSON.stringify(paths, null, 2)}\n`);
        return;
      }
      writeOut(formatConfigPaths(paths));
    });

  const auth = program.command("auth").description("Manage OAuth credentials for remote servers.");

  auth
    .command("login")
    .description("Authenticate a configured remote OAuth server.")
    .argument("<server>", "configured server ID")
    .option("--no-open", "print the authorization URL without opening a browser")
    .action(async (serverId: string, options: { open?: boolean }) => {
      await loginAuth(serverId, {
        noOpen: options.open === false,
        writeOut,
        writeErr,
        ...(io.authDir ? { authDir: io.authDir } : {}),
      });
    });

  auth
    .command("logout")
    .description("Delete stored OAuth credentials for a server.")
    .argument("<server>", "configured server ID")
    .action((serverId: string) => {
      const target = findAuthTarget(serverId);
      assertLoginTarget(target, serverId);

      if (deleteTokenBundle(serverId, io.authDir)) {
        writeOut(`Deleted OAuth credentials for ${serverId}\n`);
      } else {
        writeOut(`No OAuth credentials found for ${serverId}\n`);
      }
    });

  auth
    .command("list")
    .description("List servers with stored OAuth credentials.")
    .action(() => {
      const config = loadConfig(envConfigPath());
      const servers = authTargets(config).sort((left, right) =>
        left.server.localeCompare(right.server),
      );

      if (servers.length === 0) {
        writeOut("No configured remote OAuth servers found.\n");
        return;
      }
      for (const server of servers) {
        const bundle = readTokenBundle(server.server, io.authDir);
        const status = !bundle
          ? "missing"
          : isTokenBundleExpired(bundle)
            ? "expired"
            : "authenticated";
        writeOut(
          [
            server.server,
            status,
            bundle?.expiresAt ? `expires ${bundle.expiresAt}` : undefined,
            bundle?.scope ? `scope ${bundle.scope}` : undefined,
          ]
            .filter(Boolean)
            .join("\t"),
        );
        writeOut("\n");
      }
    });

  return program;
}

function listCaplets(
  config: CapletsConfig,
  options: { includeDisabled: boolean },
): CapletListRow[] {
  const rows = allCaplets(config)
    .filter((server) => options.includeDisabled || !server.disabled)
    .map((server) => ({
      server: server.server,
      backend: server.backend,
      name: server.name,
      description: server.description,
      disabled: server.disabled,
      status: initialServerStatus(server),
    }));
  return rows.sort((left, right) => left.server.localeCompare(right.server));
}

function initialServerStatus(server: CapletConfig): ServerStatus {
  return server.disabled ? "disabled" : "not_started";
}

function allCaplets(config: CapletsConfig): CapletConfig[] {
  return [
    ...Object.values(config.mcpServers),
    ...Object.values(config.openapiEndpoints),
    ...Object.values(config.graphqlEndpoints),
  ];
}

function formatCapletList(rows: CapletListRow[]): string {
  if (rows.length === 0) {
    return "No configured Caplets found.\n";
  }

  return `${formatTable([
    ["server", "backend", "status", "name"],
    ...rows.map((row) => [row.server, row.backend, row.status, row.name]),
  ])}\n`;
}

function resolveCliConfigPaths(authDir?: string): ConfigPaths {
  const envConfig = envConfigPath();
  const configPath = resolveConfigPath(envConfig);
  return {
    userConfig: configPath,
    projectConfig: resolveProjectConfigPath(),
    userRoot: resolveCapletsRoot(configPath),
    projectRoot: resolveProjectCapletsRoot(),
    authDir: authDir ?? DEFAULT_AUTH_DIR,
    envConfig: envConfig ?? null,
    projectCapletsTrusted: isTrustedProjectCapletsEnabled(),
  };
}

function formatConfigPaths(paths: ConfigPaths): string {
  return (
    [
      `userConfig: ${paths.userConfig}`,
      `projectConfig: ${paths.projectConfig}`,
      `userRoot: ${paths.userRoot}`,
      `projectRoot: ${paths.projectRoot}`,
      `authDir: ${paths.authDir}`,
      `envConfig: ${paths.envConfig ?? "unset"}`,
      `projectCapletsTrusted: ${paths.projectCapletsTrusted}`,
    ].join("\n") + "\n"
  );
}

function isTrustedProjectCapletsEnabled(): boolean {
  const value = process.env[TRUST_PROJECT_CAPLETS_ENV];
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function formatTable(rows: string[][]): string {
  const firstRow = rows[0];
  if (!firstRow) {
    return "";
  }

  const widths = firstRow.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );

  return rows.map((row) => formatTableRow(row, widths)).join("\n");
}

function formatTableRow(row: string[], widths: number[]): string {
  return row
    .map((value, column) => {
      if (column === row.length - 1) {
        return value;
      }
      return value.padEnd((widths[column] ?? 0) + 2);
    })
    .join("")
    .trimEnd();
}

async function loginAuth(
  serverId: string,
  options: {
    noOpen: boolean;
    writeOut: (value: string) => void;
    writeErr: (value: string) => void;
    authDir?: string;
  },
): Promise<void> {
  const config = loadConfig(envConfigPath());
  const server = findAuthTarget(serverId, config);
  assertLoginTarget(server, serverId);

  try {
    const flowOptions = {
      noOpen: options.noOpen,
      ...(options.authDir ? { authDir: options.authDir } : {}),
      ...(options.noOpen ? { readManualInput: maybeReadManualInput } : {}),
      print: (line: string) => options.writeOut(`${line}\n`),
    };
    if (server.backend === "mcp") {
      await runOAuthFlow(server, flowOptions);
    } else {
      await runGenericOAuthFlow(server, flowOptions);
    }
    options.writeOut(`Authenticated ${serverId}\n`);
  } catch (error) {
    options.writeErr(`${JSON.stringify(toSafeError(error, "AUTH_FAILED"), null, 2)}\n`);
    process.exitCode = 1;
  }
}

type AuthTarget = ReturnType<typeof authTargets>[number];

function findAuthTarget(
  serverId: string,
  config = loadConfig(envConfigPath()),
): AuthTarget | undefined {
  return authTargets(config).find((server) => server.server === serverId);
}

function authTargets(config: ReturnType<typeof loadConfig>) {
  const graphqlEndpoints = (
    config as unknown as { graphqlEndpoints?: Record<string, GenericAuthTarget> }
  ).graphqlEndpoints;
  return [
    ...Object.values(config.mcpServers).filter(
      (server) =>
        server.transport !== "stdio" &&
        (server.auth?.type === "oauth2" || server.auth?.type === "oidc"),
    ),
    ...Object.values(config.openapiEndpoints).filter(
      (endpoint) => endpoint.auth?.type === "oauth2" || endpoint.auth?.type === "oidc",
    ),
    ...Object.values(graphqlEndpoints ?? {}).filter(
      (endpoint) => endpoint.auth?.type === "oauth2" || endpoint.auth?.type === "oidc",
    ),
  ];
}

function assertLoginTarget(
  target: AuthTarget | undefined,
  serverId: string,
): asserts target is AuthTarget {
  if (!target) {
    throw new CapletsError("SERVER_NOT_FOUND", `Server ${serverId} is not configured for OAuth`);
  }
  if ("disabled" in target && target.disabled) {
    throw new CapletsError("SERVER_UNAVAILABLE", `Server ${serverId} is disabled`);
  }
}

export function initConfig(options: { path?: string; force?: boolean } = {}): string {
  const path = resolveConfigPath(options.path);
  if (existsSync(path) && !options.force) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Caplets config already exists at ${path}; pass --force to overwrite it`,
    );
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${starterConfig()}\n`, {
    mode: 0o600,
    flag: options.force ? "w" : "wx",
  });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on platforms without POSIX permissions.
  }
  return path;
}

export function starterConfig(): string {
  return JSON.stringify(
    {
      $schema:
        "https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplets-config.schema.json",
      version: 1,
      defaultSearchLimit: 20,
      maxSearchLimit: 50,
      mcpServers: {
        example: {
          name: "Example MCP Server",
          description: "Replace this with a real MCP server and what agents should use it for.",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-everything"],
          disabled: true,
        },
      },
    },
    null,
    2,
  );
}

function envConfigPath(): string | undefined {
  return process.env.CAPLETS_CONFIG?.trim() || undefined;
}

async function maybeReadManualInput(): Promise<string | undefined> {
  if (!input.isTTY) {
    return undefined;
  }
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      "Paste callback URL or authorization code after completing authorization, or press Enter to wait for loopback callback: ",
    );
    return answer.trim() || undefined;
  } finally {
    rl.close();
  }
}
