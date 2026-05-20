import { Command, CommanderError } from "commander";
import { version as packageJsonVersion } from "../package.json";
import {
  addCliCaplet,
  addGraphqlCaplet,
  addHttpCaplet,
  addMcpCaplet,
  addOpenApiCaplet,
} from "./cli/add";
import { loginAuth, logoutAuth, listAuth } from "./cli/auth";
import { initConfig } from "./cli/init";
import {
  formatCapletList,
  formatConfigPaths,
  listCaplets,
  resolveCliConfigPaths,
} from "./cli/inspection";
import { installCaplets } from "./cli/install";
import {
  loadConfigWithSources,
  resolveCapletsRoot,
  resolveConfigPath,
  resolveProjectCapletsRoot,
} from "./config";
import { CapletsEngine } from "./engine";
import { CapletsError } from "./errors";
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

export function createProgram(io: CliIO = {}): Command {
  const writeOut = io.writeOut ?? ((value: string) => process.stdout.write(value));
  const writeErr = io.writeErr ?? ((value: string) => process.stderr.write(value));
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
    .command("serve")
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
    .action(
      async (options: {
        transport?: string;
        host?: string;
        port?: string;
        path?: string;
        user?: string;
        password?: string;
        allowUnauthenticatedHttp?: boolean;
      }) => {
        const resolved = resolveServeOptions(options);
        const configPath = envConfigPath();
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
    .option("--format <format>", "output format: plain, markdown, md, or json", parseOutputFormat)
    .action((options: { all?: boolean; json?: boolean; format?: CliOutputFormat }) => {
      const config = loadConfigWithSources(envConfigPath());
      const rows = listCaplets(config, { includeDisabled: Boolean(options.all) });
      if (options.json || options.format === "json") {
        writeOut(`${JSON.stringify(rows, null, 2)}\n`);
        return;
      }
      writeOut(formatCapletList(rows, options.format ?? "plain"));
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

  program
    .command("get-caplet")
    .description("Print a configured Caplet card.")
    .argument("<caplet>", "configured Caplet ID")
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(async (caplet: string, options: { format?: CliOutputFormat }) => {
      await executeOperation(
        caplet,
        { operation: "get_caplet" },
        { writeOut, writeErr, setExitCode, authDir: io.authDir, format: options.format },
      );
    });

  program
    .command("check-backend")
    .description("Check backend availability for a configured Caplet.")
    .argument("<caplet>", "configured Caplet ID")
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(async (caplet: string, options: { format?: CliOutputFormat }) => {
      await executeOperation(
        caplet,
        { operation: "check_backend" },
        { writeOut, writeErr, setExitCode, authDir: io.authDir, format: options.format },
      );
    });

  program
    .command("list-tools")
    .description("List downstream tools for a configured Caplet.")
    .argument("<caplet>", "configured Caplet ID")
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(async (caplet: string, options: { format?: CliOutputFormat }) => {
      await executeOperation(
        caplet,
        { operation: "list_tools" },
        { writeOut, writeErr, setExitCode, authDir: io.authDir, format: options.format },
      );
    });

  program
    .command("search-tools")
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
          { writeOut, writeErr, setExitCode, authDir: io.authDir, format: options.format },
        );
      },
    );

  program
    .command("get-tool")
    .description("Print one downstream tool schema.")
    .argument("<caplet.tool>", "qualified target, split on the first dot")
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(async (target: string, options: { format?: CliOutputFormat }) => {
      const { caplet, tool } = parseQualifiedTarget(target);
      await executeOperation(
        caplet,
        { operation: "get_tool", tool },
        { writeOut, writeErr, setExitCode, authDir: io.authDir, format: options.format },
      );
    });

  program
    .command("call-tool")
    .description("Call one downstream tool.")
    .argument("<caplet.tool>", "qualified target, split on the first dot")
    .option("--args <json-object>", "JSON object of downstream tool arguments")
    .option("--field <path>", "project a field from structured output", collect, [])
    .option("--format <format>", "output format: markdown, md, plain, or json", parseOutputFormat)
    .action(
      async (
        target: string,
        options: { args?: string; field?: string[]; format?: CliOutputFormat },
      ) => {
        const { caplet, tool } = parseQualifiedTarget(target);
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
          format: options.format,
        });
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
    .option("--format <format>", "output format: plain, markdown, md, or json", parseOutputFormat)
    .action((options: { json?: boolean; format?: CliOutputFormat }) => {
      const paths = resolveCliConfigPaths(envConfigPath(), io.authDir);
      if (options.json || options.format === "json") {
        writeOut(`${JSON.stringify(paths, null, 2)}\n`);
        return;
      }
      writeOut(formatConfigPaths(paths, options.format ?? "plain"));
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
    .option("--json", "print JSON output")
    .option("--format <format>", "output format: plain, markdown, md, or json", parseOutputFormat)
    .action((options: { json?: boolean; format?: CliOutputFormat }) => {
      const configPath = envConfigPath();
      const format =
        options.json || options.format === "json" ? "json" : (options.format ?? "plain");
      listAuth({
        writeOut,
        format,
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

function parseQualifiedTarget(target: string): { caplet: string; tool: string } {
  const dot = target.indexOf(".");
  if (dot <= 0 || dot === target.length - 1) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Expected qualified target in the form <caplet>.<tool>",
    );
  }
  return { caplet: target.slice(0, dot), tool: target.slice(dot + 1) };
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type ExecuteOperationIO = Required<Pick<CliIO, "writeOut" | "writeErr" | "setExitCode">> & {
  authDir?: string | undefined;
  format?: CliOutputFormat | undefined;
};

async function executeOperation(
  caplet: string,
  request: Record<string, unknown>,
  io: ExecuteOperationIO,
): Promise<void> {
  const configPath = envConfigPath();
  const engine = new CapletsEngine({
    ...(configPath ? { configPath } : {}),
    ...(io.authDir ? { authDir: io.authDir } : {}),
    watch: false,
    writeErr: io.writeErr,
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
    case "get_caplet":
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
    case "get_caplet":
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
