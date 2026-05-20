import {
  addCliCaplet,
  addGraphqlCaplet,
  addHttpCaplet,
  addMcpCaplet,
  addOpenApiCaplet,
} from "./../cli/add";
import { initConfig } from "./../cli/init";
import { installCaplets } from "./../cli/install";
import { listCaplets } from "./../cli/inspection";
import { loadConfigWithSources } from "../config";
import { CapletsEngine, type CapletsEngineOptions } from "../engine";
import { CapletsError, toSafeError } from "../errors";
import type { RemoteCliRequest, RemoteCliResponse } from "./types";

export type RemoteControlDispatchContext = CapletsEngineOptions & { projectCapletsRoot: string };

type AddKind = "cli" | "mcp" | "openapi" | "graphql" | "http";

const ENGINE_COMMANDS = new Set<RemoteCliRequest["command"]>([
  "get_caplet",
  "check_backend",
  "list_tools",
  "search_tools",
  "get_tool",
  "call_tool",
]);

export async function dispatchRemoteCliRequest(
  request: RemoteCliRequest,
  context: RemoteControlDispatchContext,
): Promise<RemoteCliResponse> {
  try {
    const result = await dispatch(request, context);
    return { ok: true, result };
  } catch (error) {
    const safe = toSafeError(error);
    const action = nextAction(safe.details);
    return {
      ok: false,
      error: {
        code: safe.code,
        message: safe.message,
        ...(action ? { nextAction: action } : {}),
      },
    };
  }
}

async function dispatch(request: RemoteCliRequest, context: RemoteControlDispatchContext) {
  assertObject(request, "remote control request");
  assertObject(request.arguments, "remote control request arguments");

  if (request.command === "list") {
    const config = loadConfigWithSources(context.configPath, context.projectConfigPath);
    return listCaplets(config, {
      includeDisabled: optionalBoolean(request.arguments, "includeDisabled"),
    });
  }

  if (ENGINE_COMMANDS.has(request.command)) {
    const caplet = requiredString(request.arguments, "caplet");
    const { caplet: _caplet, ...toolRequest } = request.arguments;
    const engine = new CapletsEngine(context);
    try {
      return await engine.execute(caplet, { ...toolRequest, operation: request.command });
    } finally {
      await engine.close();
    }
  }

  if (request.command === "init") {
    return {
      remote: true,
      path: initConfig({
        ...optionalProp("path", context.configPath),
        force: optionalBoolean(request.arguments, "force"),
      }),
    };
  }

  if (request.command === "add") {
    return dispatchAdd(request.arguments, context);
  }

  if (request.command === "install") {
    return {
      remote: true,
      ...installCaplets(requiredString(request.arguments, "repo"), {
        ...optionalProp("capletIds", optionalStringArray(request.arguments, "capletIds")),
        destinationRoot: context.projectCapletsRoot,
        force: optionalBoolean(request.arguments, "force"),
      }),
    };
  }

  throw new CapletsError(
    "UNKNOWN_OPERATION",
    `Unsupported remote control command ${request.command}`,
  );
}

function dispatchAdd(args: Record<string, unknown>, context: RemoteControlDispatchContext) {
  const kind = requiredString(args, "kind") as AddKind;
  const id = requiredString(args, "id");
  const options = optionalObject(args, "options");
  switch (kind) {
    case "cli":
      return {
        remote: true,
        label: "CLI",
        ...addCliCaplet(id, {
          ...options,
          destinationRoot: context.projectCapletsRoot,
          print: false,
        }),
      };
    case "mcp":
      return {
        remote: true,
        label: "MCP",
        ...addMcpCaplet(id, {
          ...options,
          destinationRoot: context.projectCapletsRoot,
          print: false,
        }),
      };
    case "openapi":
      return {
        remote: true,
        label: "OpenAPI",
        ...addOpenApiCaplet(id, {
          ...options,
          destinationRoot: context.projectCapletsRoot,
          print: false,
        }),
      };
    case "graphql":
      return {
        remote: true,
        label: "GraphQL",
        ...addGraphqlCaplet(id, {
          ...options,
          destinationRoot: context.projectCapletsRoot,
          print: false,
        }),
      };
    case "http":
      return {
        remote: true,
        label: "HTTP",
        ...addHttpCaplet(id, {
          ...options,
          destinationRoot: context.projectCapletsRoot,
          print: false,
        }),
      };
    default:
      throw new CapletsError(
        "REQUEST_INVALID",
        "add.kind must be cli, mcp, openapi, graphql, or http",
      );
  }
}

function optionalProp<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Record<Key, Value> | {} {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>);
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CapletsError("REQUEST_INVALID", `${label} must be an object`);
  }
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CapletsError("REQUEST_INVALID", `${key} must be a non-empty string`);
  }
  return value;
}

function optionalObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (value === undefined) {
    return {};
  }
  assertObject(value, key);
  return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new CapletsError("REQUEST_INVALID", `${key} must be a boolean`);
  }
  return value;
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new CapletsError("REQUEST_INVALID", `${key} must be an array of strings`);
  }
  return value;
}

function nextAction(details: unknown): string | undefined {
  if (details && typeof details === "object" && "nextAction" in details) {
    const value = (details as { nextAction?: unknown }).nextAction;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}
