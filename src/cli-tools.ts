import { constants, existsSync, accessSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import type { CompatibilityCallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CliToolActionConfig, CliToolsConfig } from "./config.js";
import type { CompactTool } from "./downstream.js";
import { CapletsError, toSafeError } from "./errors.js";
import type { ServerRegistry } from "./registry.js";

const DEFAULT_INPUT_SCHEMA = { type: "object", additionalProperties: true } as const;
type CliToolAction = CliToolActionConfig & { name: string };

export class CliToolsManager {
  constructor(private registry: ServerRegistry) {}

  updateRegistry(registry: ServerRegistry): void {
    this.registry = registry;
  }

  invalidate(_serverId: string): void {}

  async checkTools(config: CliToolsConfig): Promise<{
    server: string;
    status: string;
    toolCount?: number;
    elapsedMs: number;
    error?: unknown;
  }> {
    const startedAt = Date.now();
    try {
      for (const action of actionsFor(config)) {
        const cwd = interpolateString(action.cwd ?? config.cwd, {}, "cwd");
        if (cwd && !existsSync(cwd)) {
          throw new CapletsError(
            "CONFIG_INVALID",
            `CLI cwd does not exist for ${config.server}/${action.name}`,
          );
        }
        resolveCommandPath(action.command);
      }
      this.registry.setStatus(config.server, "available");
      return {
        server: config.server,
        status: "available",
        toolCount: Object.keys(config.actions).length,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (error) {
      const safe = toSafeError(error, "SERVER_UNAVAILABLE");
      this.registry.setStatus(config.server, "unavailable", safe);
      return {
        server: config.server,
        status: "unavailable",
        elapsedMs: Date.now() - startedAt,
        error: safe,
      };
    }
  }

  async listTools(config: CliToolsConfig): Promise<Tool[]> {
    return actionsFor(config).map((action) => this.toTool(action));
  }

  async getTool(config: CliToolsConfig, toolName: string): Promise<Tool> {
    return this.toTool(getAction(config, toolName));
  }

  async callTool(
    config: CliToolsConfig,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CompatibilityCallToolResult> {
    const action = getAction(config, toolName);
    validateInput(action, args);
    const execution = resolveExecution(config, action, args);
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), execution.timeoutMs);

    try {
      const result = await spawnCommand(execution, controller.signal, () => Date.now() - startedAt);
      const structured = parseStructuredResult(action, result);
      return {
        content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
        structuredContent: structured,
        isError: result.exitCode !== 0,
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw new CapletsError(
          "TOOL_CALL_TIMEOUT",
          `CLI tool timed out for ${config.server}/${toolName}`,
        );
      }
      if (error instanceof CapletsError) {
        throw error;
      }
      throw new CapletsError(
        "DOWNSTREAM_TOOL_ERROR",
        `CLI tool failed for ${config.server}/${toolName}`,
        toSafeError(error),
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  compact(config: CliToolsConfig, tool: Tool): CompactTool {
    return {
      server: config.server,
      tool: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      hasInputSchema: Boolean(tool.inputSchema),
      hasOutputSchema: Boolean(tool.outputSchema),
    };
  }

  search(config: CliToolsConfig, tools: Tool[], query: string, limit: number): CompactTool[] {
    const needle = query.toLocaleLowerCase();
    return tools
      .filter((tool) =>
        `${tool.name}\n${tool.description ?? ""}`.toLocaleLowerCase().includes(needle),
      )
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, limit)
      .map((tool) => this.compact(config, tool));
  }

  private toTool(action: CliToolAction): Tool {
    return {
      name: action.name,
      ...(action.description ? { description: action.description } : {}),
      inputSchema: (action.inputSchema ?? DEFAULT_INPUT_SCHEMA) as Tool["inputSchema"],
      ...(action.outputSchema ? { outputSchema: action.outputSchema as Tool["outputSchema"] } : {}),
      ...(action.annotations ? { annotations: action.annotations as Tool["annotations"] } : {}),
    };
  }
}

type Execution = {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
};

type SpawnResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
};

function actionsFor(config: CliToolsConfig): CliToolAction[] {
  return Object.entries(config.actions)
    .map(([name, action]) => ({ name, ...action }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function getAction(config: CliToolsConfig, toolName: string): CliToolAction {
  const actions = actionsFor(config);
  const action = actions.find((candidate) => candidate.name === toolName);
  if (!action) {
    throw new CapletsError("TOOL_NOT_FOUND", `Tool ${toolName} was not found on ${config.server}`, {
      server: config.server,
      tool: toolName,
      suggestions: actions
        .map((candidate) => candidate.name)
        .filter((name) => name.toLocaleLowerCase().includes(toolName.toLocaleLowerCase()[0] ?? ""))
        .slice(0, 5),
    });
  }
  return action;
}

function resolveExecution(
  config: CliToolsConfig,
  action: CliToolAction,
  input: Record<string, unknown>,
): Execution {
  const cwd = interpolateString(action.cwd ?? config.cwd, input, "cwd");
  if (cwd && !existsSync(cwd)) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `CLI cwd does not exist for ${config.server}/${action.name}`,
    );
  }
  const env = {
    ...process.env,
    ...resolveEnv(config.env, input),
    ...resolveEnv(action.env, input),
  };
  return {
    command: interpolateString(action.command, input, "command") ?? action.command,
    args: (action.args ?? []).map((arg, index) =>
      interpolateRequiredString(arg, input, `args.${index}`),
    ),
    ...(cwd ? { cwd } : {}),
    env,
    timeoutMs: action.timeoutMs ?? config.timeoutMs,
    maxOutputBytes: action.maxOutputBytes ?? config.maxOutputBytes,
  };
}

function resolveEnv(
  env: Record<string, string> | undefined,
  input: Record<string, unknown>,
): Record<string, string> {
  if (!env) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      interpolateRequiredString(value, input, `env.${key}`),
    ]),
  );
}

function interpolateString(
  value: string | undefined,
  input: Record<string, unknown>,
  field: string,
): string | undefined {
  return value === undefined ? undefined : interpolateRequiredString(value, input, field);
}

function interpolateRequiredString(
  value: string,
  input: Record<string, unknown>,
  field: string,
): string {
  return value.replace(/\$input(?:\.([A-Za-z0-9_.-]+))?/g, (_match, path: string | undefined) => {
    if (!path) {
      throw new CapletsError("REQUEST_INVALID", `CLI ${field} cannot interpolate $input directly`);
    }
    const selected = valueAtPath(input, path);
    if (selected === undefined || selected === null) {
      throw new CapletsError("REQUEST_INVALID", `CLI ${field} references missing input ${path}`);
    }
    if (
      typeof selected !== "string" &&
      typeof selected !== "number" &&
      typeof selected !== "boolean"
    ) {
      throw new CapletsError(
        "REQUEST_INVALID",
        `CLI ${field} input ${path} must be a string, number, or boolean`,
      );
    }
    return String(selected);
  });
}

function valueAtPath(input: Record<string, unknown>, path: string): unknown {
  let current: unknown = input;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function validateInput(action: CliToolAction, input: Record<string, unknown>): void {
  const schema = action.inputSchema;
  if (!schema) {
    return;
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key === "string" && input[key] === undefined) {
      throw new CapletsError("REQUEST_INVALID", `CLI tool ${action.name} requires input ${key}`);
    }
  }
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  for (const [key, property] of Object.entries(properties)) {
    if (input[key] === undefined || !isPlainObject(property) || typeof property.type !== "string") {
      continue;
    }
    if (!matchesJsonType(input[key], property.type)) {
      throw new CapletsError(
        "REQUEST_INVALID",
        `CLI tool ${action.name} input ${key} must be ${property.type}`,
      );
    }
  }
}

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
    case "integer":
      return typeof value === "number" && (type === "number" || Number.isInteger(value));
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function spawnCommand(
  execution: Execution,
  signal: AbortSignal,
  elapsedMs: () => number,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const child = spawn(execution.command, execution.args, {
      cwd: execution.cwd,
      env: execution.env,
      shell: false,
      signal,
      windowsHide: true,
    });
    child.on("error", reject);
    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > execution.maxOutputBytes) {
        child.kill();
        reject(new CapletsError("DOWNSTREAM_TOOL_ERROR", "CLI tool output exceeded byte limit"));
        return;
      }
      if (stream === "stdout") {
        stdout += chunk.toString("utf8");
      } else {
        stderr += chunk.toString("utf8");
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("close", (exitCode, childSignal) => {
      resolve({ exitCode, signal: childSignal, stdout, stderr, elapsedMs: elapsedMs() });
    });
  });
}

function parseStructuredResult(
  action: CliToolAction,
  result: SpawnResult,
): Record<string, unknown> {
  const structured: Record<string, unknown> = {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    elapsedMs: result.elapsedMs,
    ...(result.signal ? { signal: result.signal } : {}),
  };
  if (action.output?.type === "json" && result.stdout.trim()) {
    try {
      structured.json = JSON.parse(result.stdout);
    } catch (error) {
      throw new CapletsError(
        "DOWNSTREAM_PROTOCOL_ERROR",
        `CLI tool ${action.name} stdout was not valid JSON`,
        toSafeError(error),
      );
    }
  }
  return structured;
}

function resolveCommandPath(command: string): string {
  if (isAbsolute(command) || command.includes("/")) {
    assertExecutable(command);
    return command;
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = join(directory, command);
    if (isExecutable(candidate)) {
      return candidate;
    }
    if (process.platform === "win32") {
      for (const ext of (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")) {
        const windowsCandidate = join(directory, `${command}${ext.toLowerCase()}`);
        if (isExecutable(windowsCandidate)) {
          return windowsCandidate;
        }
      }
    }
  }
  throw new CapletsError("SERVER_UNAVAILABLE", `CLI command ${command} was not found on PATH`);
}

function assertExecutable(path: string): void {
  if (!isExecutable(path)) {
    throw new CapletsError("SERVER_UNAVAILABLE", `CLI command ${path} is not executable`);
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.toLowerCase().includes("abort"))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
