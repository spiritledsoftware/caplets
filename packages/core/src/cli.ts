import { Command, CommanderError } from "commander";
import { version as packageJsonVersion } from "../package.json";
import {
  addCliCaplet,
  addGraphqlCaplet,
  addHttpCaplet,
  addMcpCaplet,
  addOpenApiCaplet,
} from "./cli/add.js";
import { loginAuth, logoutAuth, listAuth } from "./cli/auth.js";
import { initConfig } from "./cli/init.js";
import {
  formatCapletList,
  formatConfigPaths,
  listCaplets,
  resolveCliConfigPaths,
} from "./cli/inspection.js";
import { installCaplets } from "./cli/install.js";
import {
  loadConfigWithSources,
  resolveCapletsRoot,
  resolveConfigPath,
  resolveProjectCapletsRoot,
} from "./config.js";
import { CapletsError } from "./errors.js";

export { initConfig, starterConfig } from "./cli/init.js";
export { installCaplets, normalizeGitRepo } from "./cli/install.js";
export {
  addCliCaplet,
  addGraphqlCaplet,
  addHttpCaplet,
  addMcpCaplet,
  addOpenApiCaplet,
} from "./cli/add.js";

type CliIO = {
  writeOut?: (value: string) => void;
  writeErr?: (value: string) => void;
  authDir?: string;
  version?: string;
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
    .version(io.version ?? packageJsonVersion)
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
      const config = loadConfigWithSources(envConfigPath());
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
    .option("-g, --global", "install to the user Caplets root")
    .option("--force", "overwrite installed Caplets")
    .action((repo: string, capletIds: string[], options: { global?: boolean; force?: boolean }) => {
      const result = installCaplets(repo, {
        capletIds,
        force: Boolean(options.force),
        destinationRoot: options.global
          ? resolveCapletsRoot(resolveConfigPath(envConfigPath()))
          : resolveProjectCapletsRoot(),
      });
      for (const caplet of result.installed) {
        writeOut(`Installed ${caplet.id} to ${caplet.destination}\n`);
      }
    });

  const add = program.command("add").description("Add generated Caplet files.");

  add
    .command("cli")
    .description("Add a CLI tools Caplet.")
    .argument("<id>", "Caplet ID/display seed")
    .option("--repo <path>", "repository path to inspect")
    .option("--include <items>", "comma-separated generators to include: git,gh,package")
    .option("--command <name>", "single CLI command template to generate")
    .option("-g, --global", "write to the user Caplets root")
    .option("--print", "print generated Caplet text without writing a file")
    .option("--output <path>", "output path")
    .option("--force", "overwrite an existing destination file")
    .action(
      (
        id: string,
        options: {
          repo?: string;
          include?: string;
          command?: string;
          global?: boolean;
          print?: boolean;
          output?: string;
          force?: boolean;
        },
      ) => {
        const result = addCliCaplet(id, {
          ...options,
          destinationRoot: options.global
            ? resolveCapletsRoot(resolveConfigPath(envConfigPath()))
            : resolveProjectCapletsRoot(),
        });
        if (result.path) {
          writeOut(`Wrote CLI Caplet to ${result.path}\n`);
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
    .option("-g, --global", "write to the user Caplets root")
    .option("--print", "print generated Caplet text without writing a file")
    .option("--output <path>", "output path")
    .option("--force", "overwrite an existing destination file")
    .action(
      (
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
        const result = addMcpCaplet(id, {
          ...options,
          destinationRoot: addDestinationRoot(options),
        });
        writeAddResult(writeOut, "MCP", result);
      },
    );

  add
    .command("openapi")
    .description("Add an OpenAPI backend Caplet.")
    .argument("<id>", "Caplet ID/display seed")
    .option("--spec <path-or-url>", "OpenAPI spec path or URL")
    .option("--base-url <url>", "request base URL override")
    .option("--token-env <ENV>", "bearer token environment variable reference")
    .option("-g, --global", "write to the user Caplets root")
    .option("--print", "print generated Caplet text without writing a file")
    .option("--output <path>", "output path")
    .option("--force", "overwrite an existing destination file")
    .action(
      (
        id: string,
        options: AddBackendCliOptions & { spec?: string; baseUrl?: string; tokenEnv?: string },
      ) => {
        const result = addOpenApiCaplet(id, {
          ...options,
          destinationRoot: addDestinationRoot(options),
        });
        writeAddResult(writeOut, "OpenAPI", result);
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
    .option("-g, --global", "write to the user Caplets root")
    .option("--print", "print generated Caplet text without writing a file")
    .option("--output <path>", "output path")
    .option("--force", "overwrite an existing destination file")
    .action(
      (
        id: string,
        options: AddBackendCliOptions & {
          endpointUrl?: string;
          schema?: string;
          introspection?: boolean;
          tokenEnv?: string;
        },
      ) => {
        const result = addGraphqlCaplet(id, {
          ...options,
          destinationRoot: addDestinationRoot(options),
        });
        writeAddResult(writeOut, "GraphQL", result);
      },
    );

  add
    .command("http")
    .description("Add an HTTP actions backend Caplet.")
    .argument("<id>", "Caplet ID/display seed")
    .option("--base-url <url>", "HTTP API base URL")
    .option("--action <name:METHOD:/path>", "HTTP action", collect, [])
    .option("--token-env <ENV>", "bearer token environment variable reference")
    .option("-g, --global", "write to the user Caplets root")
    .option("--print", "print generated Caplet text without writing a file")
    .option("--output <path>", "output path")
    .option("--force", "overwrite an existing destination file")
    .action(
      (
        id: string,
        options: AddBackendCliOptions & { baseUrl?: string; action?: string[]; tokenEnv?: string },
      ) => {
        const result = addHttpCaplet(id, {
          ...options,
          destinationRoot: addDestinationRoot(options),
        });
        writeAddResult(writeOut, "HTTP", result);
      },
    );

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
      const paths = resolveCliConfigPaths(envConfigPath(), io.authDir);
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
      const configPath = envConfigPath();
      await loginAuth(serverId, {
        noOpen: options.open === false,
        writeOut,
        writeErr,
        ...(configPath ? { configPath } : {}),
        ...(io.authDir ? { authDir: io.authDir } : {}),
      });
    });

  auth
    .command("logout")
    .description("Delete stored OAuth credentials for a server.")
    .argument("<server>", "configured server ID")
    .action((serverId: string) => {
      const configPath = envConfigPath();
      logoutAuth(serverId, {
        writeOut,
        ...(configPath ? { configPath } : {}),
        ...(io.authDir ? { authDir: io.authDir } : {}),
      });
    });

  auth
    .command("list")
    .description("List servers with stored OAuth credentials.")
    .action(() => {
      const configPath = envConfigPath();
      listAuth({
        writeOut,
        ...(configPath ? { configPath } : {}),
        ...(io.authDir ? { authDir: io.authDir } : {}),
      });
    });

  return program;
}

function envConfigPath(): string | undefined {
  return process.env.CAPLETS_CONFIG?.trim() || undefined;
}

type AddBackendCliOptions = {
  global?: boolean;
  print?: boolean;
  output?: string;
  force?: boolean;
};

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function addDestinationRoot(options: { global?: boolean }): string {
  return options.global
    ? resolveCapletsRoot(resolveConfigPath(envConfigPath()))
    : resolveProjectCapletsRoot();
}

function writeAddResult(
  writeOut: (value: string) => void,
  label: string,
  result: { path?: string; text: string },
): void {
  if (result.path) {
    writeOut(`Wrote ${label} Caplet to ${result.path}\n`);
    return;
  }
  writeOut(result.text);
}
