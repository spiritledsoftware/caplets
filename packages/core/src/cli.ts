import { Command, CommanderError } from "commander";
import { dirname, join } from "node:path";
import { version as packageJsonVersion } from "../package.json";
import {
  addCliCaplet,
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
  type AuthSource,
  type AuthStatusRow,
} from "./cli/auth";
import { cliCommands } from "./cli/commands";
import { initConfig } from "./cli/init";
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
import { installCaplets } from "./cli/install";
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
} from "./config";
import { CapletsEngine } from "./engine";
import { CapletsError } from "./errors";
import { RemoteControlClient } from "./remote-control/client";
import type { RemoteCliCommand } from "./remote-control/types";
import { resolveCapletsMode, resolveCapletsServer } from "./server/options";
import { resolveServeOptions, serveResolvedCaplets, type ServeOptions } from "./serve";

export { initConfig, starterConfig } from "./cli/init";
export { installCaplets, normalizeGitRepo } from "./cli/install";
export {
  addCliCaplet,
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
  authDir?: string;
  version?: string;
  setExitCode?: (code: number) => void;
  serve?: (options: ServeOptions) => Promise<void>;
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

  program
    .command(cliCommands.serve)
    .description("Serve configured Caplets as an MCP server.")
    .option("--transport <transport>", "server transport: stdio or http")
    .option("--host <host>", "HTTP bind host")
    .option("--port <port>", "HTTP bind port")
    .option("--path <path>", "HTTP service base path")
    .option("--user <user>", "HTTP Basic Auth username")
    .option("--password <password>", "HTTP Basic Auth password")
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
        user?: string;
        password?: string;
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
        { operation: "check_backend" },
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
        { operation: "list_tools" },
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
          { operation: "get_tool", tool },
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
          tool,
          arguments: parseCallToolArgs(options.args),
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
          ? { operation: "list_resources" }
          : { operation: "list_resources", limit: options.limit },
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
          ? { operation: "list_resource_templates" }
          : { operation: "list_resource_templates", limit: options.limit },
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
          ? { operation: "list_prompts" }
          : { operation: "list_prompts", limit: options.limit },
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
            prompt,
            arguments: parseJsonObjectOption(options.args, "get-prompt --args"),
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

function envConfigPath(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string | undefined {
  return env.CAPLETS_CONFIG?.trim() || undefined;
}

function remoteClientForCli(io: CliIO): RemoteControlClient | undefined {
  const env = io.env ?? process.env;
  if (resolveCapletsMode({}, env).mode !== "remote") {
    return undefined;
  }
  const server = resolveCapletsServer(io.fetch ? { fetch: io.fetch } : {}, env);
  return new RemoteControlClient(server);
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
    case "check_backend":
    case "list_tools":
    case "search_tools":
    case "get_tool":
    case "call_tool":
    case "list_resources":
    case "search_resources":
    case "list_resource_templates":
    case "read_resource":
    case "list_prompts":
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
      "--remote requires CAPLETS_MODE=remote and CAPLETS_SERVER_URL",
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
  };
}

const capletConfigKinds = [
  "mcpServers",
  "openapiEndpoints",
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
    case "check_backend":
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
    case "list_tools": {
      const tools = Array.isArray(payload.tools) ? payload.tools : [];
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
      const tools = Array.isArray(payload.tools) ? payload.tools : [];
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
    case "get_tool": {
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
      const callTarget = `${String(request.caplet ?? "<caplet>")}.${String(request.tool ?? "unknown")}`;
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
    case "list_resources":
    case "search_resources": {
      const resources = Array.isArray(payload.resources) ? payload.resources : [];
      const templates = Array.isArray(payload.resourceTemplates) ? payload.resourceTemplates : [];
      const matches = Array.isArray(payload.matches)
        ? payload.matches
        : [...resources, ...templates];
      return [
        `## MCP resources for \`${id}\``,
        "",
        `${matches.length} item${matches.length === 1 ? "" : "s"} found.`,
        "",
        ...formatResourceLines(matches, "markdown"),
      ].join("\n");
    }
    case "list_resource_templates": {
      const templates = Array.isArray(payload.resourceTemplates) ? payload.resourceTemplates : [];
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
    case "list_prompts":
    case "search_prompts": {
      const prompts = Array.isArray(payload.prompts) ? payload.prompts : [];
      return [`## MCP prompts for \`${id}\``, "", ...formatPromptLines(prompts, "markdown")].join(
        "\n",
      );
    }
    case "get_prompt":
      return [
        `## Prompt \`${String(request.caplet)}.${String(request.prompt)}\``,
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
    case "check_backend":
      return [
        `Backend: ${id} is ${String(payload.status ?? "unknown")}`,
        typeof payload.toolCount === "number" ? `Tools: ${payload.toolCount}` : undefined,
        typeof payload.elapsedMs === "number" ? `Elapsed: ${payload.elapsedMs}ms` : undefined,
        `Next: caplets list-tools ${id}`,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    case "list_tools": {
      const tools = Array.isArray(payload.tools) ? payload.tools : [];
      return [
        `Tools for ${id} (${tools.length}):`,
        ...formatToolLines(tools, "plain"),
        `Next: caplets get-tool ${id}.<tool> or caplets call-tool ${id}.<tool> --args '{...}'`,
      ].join("\n");
    }
    case "search_tools": {
      const tools = Array.isArray(payload.tools) ? payload.tools : [];
      return [
        `Matches for ${JSON.stringify(String(payload.query ?? ""))} in ${id} (${tools.length}):`,
        ...formatToolLines(tools, "plain"),
        tools.length > 0
          ? `Next: caplets get-tool ${id}.${firstToolName(tools) ?? "<tool>"}`
          : `Next: try caplets list-tools ${id} or a broader query.`,
      ].join("\n");
    }
    case "get_tool": {
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
      const callTarget = `${String(request.caplet ?? "<caplet>")}.${String(request.tool ?? "unknown")}`;
      return [
        `Call ${callTarget} ${payload.isError === true ? "failed" : "succeeded"}.`,
        callStatusLine(payload),
        `Result: ${summarizeCallResult(payload)}`,
        "Use --format json to inspect the full structured result.",
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    }
    case "list_resources":
    case "search_resources": {
      const resources = Array.isArray(payload.resources) ? payload.resources : [];
      const templates = Array.isArray(payload.resourceTemplates) ? payload.resourceTemplates : [];
      const matches = Array.isArray(payload.matches)
        ? payload.matches
        : [...resources, ...templates];
      return [
        `MCP resources for ${id} (${matches.length}):`,
        ...formatResourceLines(matches, "plain"),
      ].join("\n");
    }
    case "list_resource_templates": {
      const templates = Array.isArray(payload.resourceTemplates) ? payload.resourceTemplates : [];
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
    case "list_prompts":
    case "search_prompts": {
      const prompts = Array.isArray(payload.prompts) ? payload.prompts : [];
      return [`MCP prompts for ${id}:`, ...formatPromptLines(prompts, "plain")].join("\n");
    }
    case "get_prompt":
      return [
        `Prompt ${String(request.caplet)}.${String(request.prompt)}`,
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
