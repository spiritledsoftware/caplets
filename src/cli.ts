import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Command, CommanderError } from "commander";
import { version as packageJsonVersion } from "../package.json";
import { discoverCapletFiles, loadCapletFiles } from "./caplet-files.js";
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

type InstallableCaplet = {
  id: string;
  source: string;
  destination: string;
  kind: "file" | "directory";
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

  program
    .command("install")
    .description("Install Caplets from a repo's caplets directory.")
    .argument("<repo>", "local repo path, Git URL, or GitHub owner/repo")
    .argument("[caplets...]", "optional Caplet IDs to install")
    .option("--force", "overwrite installed Caplets")
    .action((repo: string, capletIds: string[], options: { force?: boolean }) => {
      const result = installCaplets(repo, {
        capletIds,
        force: Boolean(options.force),
        destinationRoot: resolveCapletsRoot(resolveConfigPath(envConfigPath())),
      });
      for (const caplet of result.installed) {
        writeOut(`Installed ${caplet.id} to ${caplet.destination}\n`);
      }
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

export function installCaplets(
  repo: string,
  options: {
    capletIds?: string[];
    destinationRoot?: string;
    force?: boolean;
  } = {},
): { installed: InstallableCaplet[] } {
  const source = resolveInstallSource(repo);
  try {
    const sourceRoot = join(source.repoRoot, "caplets");
    if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
      throw new CapletsError("CONFIG_NOT_FOUND", `No caplets directory found at ${sourceRoot}`);
    }

    const selectedIds = new Set(options.capletIds ?? []);
    const destinationRoot = options.destinationRoot ?? resolveCapletsRoot(resolveConfigPath());
    const available = discoverCapletFiles(sourceRoot);
    const selected =
      selectedIds.size === 0 ? available : available.filter((caplet) => selectedIds.has(caplet.id));
    const missing = [...selectedIds].filter((id) => !available.some((caplet) => caplet.id === id));
    if (missing.length > 0) {
      throw new CapletsError(
        "CONFIG_NOT_FOUND",
        `Caplet ${missing.join(", ")} not found in ${sourceRoot}`,
      );
    }
    if (selected.length === 0) {
      throw new CapletsError("CONFIG_NOT_FOUND", `No Caplets found in ${sourceRoot}`);
    }

    loadCapletFiles(sourceRoot);
    mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });

    const installed = selected.map((caplet) =>
      installOneCaplet(caplet, { destinationRoot, force: Boolean(options.force) }),
    );
    return { installed };
  } finally {
    source.cleanup();
  }
}

function resolveInstallSource(repo: string): { repoRoot: string; cleanup: () => void } {
  if (existsSync(repo) && statSync(repo).isDirectory()) {
    return { repoRoot: repo, cleanup: () => {} };
  }

  const repoRoot = mkdtempSync(join(tmpdir(), "caplets-install-"));
  try {
    execFileSync("git", ["clone", "--depth", "1", normalizeGitRepo(repo), repoRoot], {
      stdio: "ignore",
    });
    return {
      repoRoot,
      cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(repoRoot, { recursive: true, force: true });
    throw new CapletsError("CONFIG_NOT_FOUND", `Could not clone repo ${repo}`, toSafeError(error));
  }
}

function normalizeGitRepo(repo: string): string {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return `https://github.com/${repo}.git`;
  }
  return repo;
}

function installOneCaplet(
  caplet: { id: string; path: string },
  options: { destinationRoot: string; force: boolean },
): InstallableCaplet {
  const isDirectory = basename(caplet.path) === "CAPLET.md";
  const source = isDirectory ? dirname(caplet.path) : caplet.path;
  const destination = isDirectory
    ? join(options.destinationRoot, caplet.id)
    : join(options.destinationRoot, `${caplet.id}.md`);

  if (existsSync(destination)) {
    if (!options.force) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Caplet ${caplet.id} already exists at ${destination}; pass --force to overwrite it`,
      );
    }
    rmSync(destination, { recursive: true, force: true });
  }

  cpSync(source, destination, { recursive: isDirectory, force: false, errorOnExist: true });
  return {
    id: caplet.id,
    source,
    destination,
    kind: isDirectory ? "directory" : "file",
  };
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
