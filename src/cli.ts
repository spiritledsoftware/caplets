import { Command, CommanderError } from "commander";
import { version as packageJsonVersion } from "../package.json";
import { loginAuth, logoutAuth, listAuth } from "./cli/auth.js";
import { authorCliCaplet } from "./cli/author.js";
import { initConfig } from "./cli/init.js";
import {
  formatCapletList,
  formatConfigPaths,
  listCaplets,
  resolveCliConfigPaths,
} from "./cli/inspection.js";
import { installCaplets } from "./cli/install.js";
import { loadConfig, resolveCapletsRoot, resolveConfigPath } from "./config.js";
import { CapletsError } from "./errors.js";

export { initConfig, starterConfig } from "./cli/init.js";
export { installCaplets, normalizeGitRepo } from "./cli/install.js";

type CliIO = {
  writeOut?: (value: string) => void;
  writeErr?: (value: string) => void;
  authDir?: string;
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

  const author = program.command("author").description("Generate reviewable Caplet files.");

  author
    .command("cli")
    .description("Generate a CLI tools Caplet.")
    .argument("<id>", "Caplet ID/display seed")
    .option("--repo <path>", "repository path to inspect")
    .option("--include <items>", "comma-separated generators to include: git,gh,package")
    .option("--command <name>", "single CLI command template to generate")
    .option("--output <path>", "output path, or - for stdout", "-")
    .action(
      (
        id: string,
        options: {
          repo?: string;
          include?: string;
          command?: string;
          output?: string;
        },
      ) => {
        const result = authorCliCaplet(id, options);
        if (result.path) {
          writeOut(`Wrote CLI Caplet to ${result.path}\n`);
          return;
        }
        writeOut(result.text);
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
