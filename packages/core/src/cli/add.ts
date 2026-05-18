import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, relative, resolve } from "node:path";
import { validateCapletFile } from "../caplet-files";
import { SERVER_ID_PATTERN } from "../config/validation";
import { CapletsError, toSafeError } from "../errors";
import { authorCliCaplet } from "./author";

type AddCliOptions = {
  repo?: string;
  include?: string;
  command?: string;
  output?: string;
  print?: boolean;
  force?: boolean;
  destinationRoot: string;
};

type AddDestinationOptions = {
  output?: string;
  print?: boolean;
  force?: boolean;
  destinationRoot: string;
};

type AddMcpOptions = AddDestinationOptions & {
  command?: string;
  arg?: string[];
  cwd?: string;
  env?: string[];
  url?: string;
  transport?: string;
  tokenEnv?: string;
};

type AddOpenApiOptions = AddDestinationOptions & {
  spec?: string;
  baseUrl?: string;
  tokenEnv?: string;
};

type AddGraphqlOptions = AddDestinationOptions & {
  endpointUrl?: string;
  schema?: string;
  introspection?: boolean;
  tokenEnv?: string;
};

type AddHttpOptions = AddDestinationOptions & {
  baseUrl?: string;
  action?: string[];
  tokenEnv?: string;
};

export function addCliCaplet(
  id: string,
  options: AddCliOptions,
): {
  path?: string;
  text: string;
} {
  assertValidCapletId(id);

  const text = authorCliCaplet(id, { ...options, output: "-" }).text;
  validateCapletText(text);

  if (options.print) {
    return { text };
  }

  const path = resolveAddOutputPath(id, options);

  writeCapletOutput(path, text, Boolean(options.force));
  return { path, text };
}

export function addMcpCaplet(id: string, options: AddMcpOptions): { path?: string; text: string } {
  const hasCommand = Boolean(options.command);
  const hasUrl = Boolean(options.url);
  if (hasCommand === hasUrl) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "MCP Caplet requires exactly one connection shape: --command or --url",
    );
  }
  if (options.transport && !hasUrl) {
    throw new CapletsError("REQUEST_INVALID", "--transport requires --url");
  }
  if (options.tokenEnv && !hasUrl) {
    throw new CapletsError("REQUEST_INVALID", "--token-env requires --url");
  }
  if (hasUrl && (options.arg?.length || options.cwd || options.env?.length)) {
    throw new CapletsError("REQUEST_INVALID", "--arg, --cwd, and --env require --command");
  }
  if (options.transport && options.transport !== "http" && options.transport !== "sse") {
    throw new CapletsError("REQUEST_INVALID", "--transport must be http or sse");
  }
  const fields: YamlField[] = hasCommand
    ? [
        ["transport", "stdio"],
        ["command", options.command],
        ["args", options.arg],
        ["cwd", options.cwd],
        ["env", parseEnv(options.env)],
      ]
    : [
        ["transport", options.transport ?? "http"],
        ["url", options.url],
        ["auth", authFromTokenEnv(options.tokenEnv)],
      ];
  return writeGeneratedCaplet(id, "MCP", "mcpServer", fields, options);
}

export function addOpenApiCaplet(
  id: string,
  options: AddOpenApiOptions,
): { path?: string; text: string } {
  if (!options.spec) {
    throw new CapletsError("REQUEST_INVALID", "OpenAPI Caplet requires --spec");
  }
  return writeGeneratedCaplet(
    id,
    "OpenAPI",
    "openapiEndpoint",
    [
      [isUrlLike(options.spec) ? "specUrl" : "specPath", options.spec],
      ["baseUrl", options.baseUrl],
      ["auth", authFromTokenEnv(options.tokenEnv) ?? { type: "none" }],
    ],
    options,
  );
}

export function addGraphqlCaplet(
  id: string,
  options: AddGraphqlOptions,
): { path?: string; text: string } {
  if (!options.endpointUrl) {
    throw new CapletsError("REQUEST_INVALID", "GraphQL Caplet requires --endpoint-url");
  }
  if (Boolean(options.schema) === Boolean(options.introspection)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "GraphQL Caplet requires exactly one of --schema or --introspection",
    );
  }
  const schemaField = options.schema
    ? ([isUrlLike(options.schema) ? "schemaUrl" : "schemaPath", options.schema] as YamlField)
    : (["introspection", true] as YamlField);
  return writeGeneratedCaplet(
    id,
    "GraphQL",
    "graphqlEndpoint",
    [
      ["endpointUrl", options.endpointUrl],
      schemaField,
      ["auth", authFromTokenEnv(options.tokenEnv) ?? { type: "none" }],
    ],
    options,
  );
}

export function addHttpCaplet(
  id: string,
  options: AddHttpOptions,
): { path?: string; text: string } {
  if (!options.baseUrl) {
    throw new CapletsError("REQUEST_INVALID", "HTTP Caplet requires --base-url");
  }
  const actions = parseActions(options.action);
  return writeGeneratedCaplet(
    id,
    "HTTP",
    "httpApi",
    [
      ["baseUrl", options.baseUrl],
      ["auth", authFromTokenEnv(options.tokenEnv) ?? { type: "none" }],
      ["actions", actions],
    ],
    options,
  );
}

export function assertValidCapletId(id: string): void {
  if (!SERVER_ID_PATTERN.test(id)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Invalid Caplet ID ${JSON.stringify(id)}; use 1-64 letters, numbers, underscores, or hyphens`,
    );
  }
}

function validateCapletText(text: string): void {
  const dir = mkdtempSync(join(tmpdir(), "caplets-add-"));
  const path = join(dir, "CAPLET.md");
  try {
    writeFileSync(path, text);
    validateCapletFile(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeGeneratedCaplet(
  id: string,
  label: string,
  backend: string,
  fields: YamlField[],
  options: AddDestinationOptions,
): { path?: string; text: string } {
  assertValidCapletId(id);
  const path = options.print
    ? resolvePrintOutputPath(id, options)
    : resolveAddOutputPath(id, options);
  const text = renderBackendCaplet(id, label, backend, renderLocalPaths(fields, dirname(path)));
  validateCapletText(text);
  if (options.print) {
    return { text };
  }
  writeCapletOutput(path, text, Boolean(options.force));
  return { path, text };
}

function writeCapletOutput(path: string, text: string, force: boolean): void {
  try {
    rejectUnsafeDestinationParents(path);
    mkdirSync(dirname(path), { recursive: true });
    rejectUnsafeDestinationParents(path);
    if (force) {
      removeExistingRegularFile(path);
    }
    writeFileNoFollow(path, text);
  } catch (error) {
    if (error instanceof CapletsError) {
      throw error;
    }
    if (isFsError(error, "EEXIST") || isFsError(error, "EISDIR") || isFsError(error, "ELOOP")) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Output path ${path} already exists`,
        toSafeError(error),
      );
    }
    throw new CapletsError(
      "CONFIG_INVALID",
      `Could not write Caplet file at ${path}`,
      toSafeError(error),
    );
  }
}

function removeExistingRegularFile(path: string): void {
  const stats = lstatIfExists(path);
  if (!stats) {
    return;
  }
  if (stats.isSymbolicLink()) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Caplet file at ${path} is a symlink; remove it before writing`,
    );
  }
  if (!stats.isFile()) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Caplet file at ${path} exists but is not a regular file; choose --output`,
    );
  }
  rmSync(path);
}

function writeFileNoFollow(path: string, text: string): void {
  const noFollowFlag = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag,
    0o600,
  );
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

function isFsError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function resolveAddOutputPath(id: string, options: AddDestinationOptions): string {
  if (options.output) {
    const outputStat = lstatIfExists(options.output);
    if (outputStat?.isSymbolicLink()) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Output path ${options.output} is a symlink; remove it before writing`,
      );
    }
    if (outputStat?.isDirectory()) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Output path ${options.output} is a directory; choose a file path`,
      );
    }
    if (outputStat && options.force && !outputStat.isFile()) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Output path ${options.output} exists but is not a regular file; choose a file path`,
      );
    }
    if (outputStat && !options.force) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Caplet file already exists at ${options.output}; pass --force to overwrite it`,
      );
    }
    return options.output;
  }

  const directoryPath = join(options.destinationRoot, id);
  const directoryStat = lstatIfExists(directoryPath);
  if (directoryStat) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Directory Caplet already exists at ${directoryPath}; remove it or choose --output`,
    );
  }

  const path = join(options.destinationRoot, `${id}.md`);
  const pathStat = lstatIfExists(path);
  if (pathStat?.isSymbolicLink()) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Caplet file at ${path} is a symlink; remove it before writing`,
    );
  }
  if (pathStat && !pathStat.isFile()) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Caplet file at ${path} exists but is not a regular file; choose --output`,
    );
  }
  if (pathStat && !options.force) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Caplet file already exists at ${path}; pass --force to overwrite it`,
    );
  }
  return path;
}

function resolvePrintOutputPath(id: string, options: AddDestinationOptions): string {
  return options.output ?? join(options.destinationRoot, `${id}.md`);
}

function renderLocalPaths(fields: YamlField[], outputDir: string): YamlField[] {
  return fields.map(([key, value]) => {
    if ((key !== "specPath" && key !== "schemaPath") || typeof value !== "string") {
      return [key, value];
    }
    return [key, localPathRelativeToOutput(value, outputDir)];
  });
}

function localPathRelativeToOutput(path: string, outputDir: string): string {
  const absolutePath = resolve(path);
  const rendered = relative(outputDir, resolve(path));
  if (rendered.startsWith("../..") || rendered.startsWith("..\\..")) {
    return absolutePath;
  }
  return rendered === "" ? "." : rendered;
}

function rejectUnsafeDestinationParents(path: string): void {
  const parent = dirname(resolve(path));
  const root = parse(parent).root;
  const segments = parent.slice(root.length).split(/[\\/]/).filter(Boolean);
  let current = root;

  for (const segment of segments) {
    current = join(current, segment);
    const stats = lstatIfExists(current);
    if (!stats) {
      return;
    }
    if (stats.isSymbolicLink()) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Output parent path ${current} is a symlink; remove it before writing`,
      );
    }
    if (!stats.isDirectory()) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Output parent path ${current} is not a directory; choose a file path`,
      );
    }
  }
}

function lstatIfExists(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isFsError(error, "ENOENT") || isFsError(error, "ENOTDIR")) {
      return undefined;
    }
    throw new CapletsError(
      "CONFIG_INVALID",
      `Could not inspect output path ${path}`,
      toSafeError(error),
    );
  }
}

type YamlField = [string, YamlValue | undefined];
type YamlValue = string | number | boolean | string[] | YamlObject;
type YamlObject = { [key: string]: YamlValue | undefined };

function renderBackendCaplet(
  id: string,
  label: string,
  backend: string,
  fields: YamlField[],
): string {
  const name = titleize(id);
  const description = `${label} backend Caplet generated by caplets add.`;
  const lines = [
    "---",
    "$schema: https://raw.githubusercontent.com/spiritledsoftware/caplets/main/schemas/caplet.schema.json",
    `name: ${yamlString(name)}`,
    `description: ${yamlString(description)}`,
    "tags:",
    `  - ${yamlString(label.toLowerCase())}`,
    `${backend}:`,
  ];
  for (const [key, value] of fields) {
    appendYaml(lines, key, value, 2);
  }
  lines.push("---", "", `# ${name}`, "", description, "");
  return lines.join("\n");
}

function appendYaml(
  lines: string[],
  key: string,
  value: YamlValue | undefined,
  indent: number,
): void {
  if (value === undefined) {
    return;
  }
  const padding = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return;
    }
    lines.push(`${padding}${key}:`);
    for (const entry of value) {
      lines.push(`${padding}  - ${yamlString(entry)}`);
    }
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, nested]) => nested !== undefined);
    if (entries.length === 0) {
      return;
    }
    lines.push(`${padding}${key}:`);
    for (const [nestedKey, nestedValue] of entries) {
      appendYaml(lines, nestedKey, nestedValue, indent + 2);
    }
    return;
  }
  lines.push(`${padding}${key}: ${typeof value === "string" ? yamlString(value) : String(value)}`);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function titleize(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function parseEnv(values: string[] | undefined): Record<string, string> | undefined {
  if (!values?.length) {
    return undefined;
  }
  const env: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0) {
      throw new CapletsError(
        "REQUEST_INVALID",
        `Invalid --env value ${JSON.stringify(value)}; use KEY=VALUE`,
      );
    }
    env[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return env;
}

function authFromTokenEnv(
  tokenEnv: string | undefined,
): { type: "bearer"; token: string } | undefined {
  if (!tokenEnv) {
    return undefined;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Invalid environment variable name ${JSON.stringify(tokenEnv)}`,
    );
  }
  return { type: "bearer", token: `$env:${tokenEnv}` };
}

function parseActions(
  values: string[] | undefined,
): Record<string, { method: string; path: string }> {
  if (!values?.length) {
    throw new CapletsError("REQUEST_INVALID", "HTTP Caplet requires at least one --action");
  }
  const actions: Record<string, { method: string; path: string }> = {};
  for (const value of values) {
    const match = /^([A-Za-z0-9_-]+):(GET|POST|PUT|PATCH|DELETE):(\/.*)$/.exec(value);
    if (!match) {
      throw new CapletsError(
        "REQUEST_INVALID",
        `Invalid --action value ${JSON.stringify(value)}; use name:METHOD:/path`,
      );
    }
    if (actions[match[1]!]) {
      throw new CapletsError(
        "REQUEST_INVALID",
        `Duplicate HTTP action name ${JSON.stringify(match[1])}`,
      );
    }
    actions[match[1]!] = { method: match[2]!, path: match[3]! };
  }
  return actions;
}

function isUrlLike(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
