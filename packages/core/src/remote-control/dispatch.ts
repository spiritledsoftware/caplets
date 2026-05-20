import { randomUUID } from "node:crypto";
import {
  addCliCaplet,
  addGraphqlCaplet,
  addHttpCaplet,
  addMcpCaplet,
  addOpenApiCaplet,
} from "./../cli/add";
import { assertLoginTarget, findAuthTarget, listAuthRows, logoutAuthResult } from "./../cli/auth";
import { initConfig } from "./../cli/init";
import { installCaplets } from "./../cli/install";
import { listCaplets } from "./../cli/inspection";
import { loadConfigWithSources } from "../config";
import { CapletsEngine, type CapletsEngineOptions } from "../engine";
import { CapletsError, toSafeError } from "../errors";
import { startGenericOAuthFlow, startOAuthFlow } from "../auth";
import { RemoteAuthFlowStore } from "./auth-flow";
import type { RemoteCliRequest, RemoteCliResponse } from "./types";

export type RemoteControlDispatchContext = CapletsEngineOptions & {
  projectCapletsRoot: string;
  authFlowStore?: RemoteAuthFlowStore;
  controlCallbackBaseUrl?: string;
};

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
    const toolRequest = requiredEngineRequest(request.arguments, request.command);
    const engine = new CapletsEngine(context);
    try {
      return await engine.execute(caplet, toolRequest);
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

  if (request.command === "auth_list") {
    return listAuthRows({
      ...optionalProp("configPath", context.configPath),
      ...optionalProp("authDir", context.authDir),
    });
  }

  if (request.command === "auth_logout") {
    return logoutAuthResult(requiredString(request.arguments, "server"), {
      ...optionalProp("configPath", context.configPath),
      ...optionalProp("authDir", context.authDir),
    });
  }

  if (request.command === "auth_login_start") {
    return startRemoteAuthLogin(requiredString(request.arguments, "server"), context);
  }

  if (request.command === "auth_login_complete") {
    return completeRemoteAuthLogin(
      requiredString(request.arguments, "flowId"),
      requiredString(request.arguments, "callbackUrl"),
      context,
    );
  }

  throw new CapletsError(
    "UNKNOWN_OPERATION",
    `Unsupported remote control command ${request.command}`,
  );
}

async function startRemoteAuthLogin(serverId: string, context: RemoteControlDispatchContext) {
  if (!context.authFlowStore || !context.controlCallbackBaseUrl) {
    throw new CapletsError("REQUEST_INVALID", "Remote auth login is not available on this server");
  }
  const config = loadConfigWithSources(context.configPath, context.projectConfigPath).config;
  const target = findAuthTarget(serverId, config);
  assertLoginTarget(target, serverId);
  const flowId = randomUUID();
  const baseUrl = context.controlCallbackBaseUrl.endsWith("/")
    ? context.controlCallbackBaseUrl
    : `${context.controlCallbackBaseUrl}/`;
  const redirectUri = new URL(`auth/callback/${flowId}`, baseUrl).toString();
  const started =
    target.backend === "mcp"
      ? await startOAuthFlow(target, {
          redirectUri,
          ...optionalProp("authDir", context.authDir),
        })
      : await startGenericOAuthFlow(target, {
          redirectUri,
          ...optionalProp("authDir", context.authDir),
        });
  const flow = context.authFlowStore.create(
    {
      server: serverId,
      authorizationUrl: started.authorizationUrl,
      complete: started.complete,
    },
    flowId,
  );
  return { server: serverId, flowId: flow.id, authorizationUrl: flow.authorizationUrl };
}

async function completeRemoteAuthLogin(
  flowId: string,
  callbackUrl: string,
  context: RemoteControlDispatchContext,
) {
  const flow = context.authFlowStore?.get(flowId);
  if (!flow) {
    throw new CapletsError("REQUEST_INVALID", `Unknown auth flow ${flowId}`);
  }
  await flow.complete(callbackUrl);
  context.authFlowStore?.delete(flowId);
  return { server: flow.server, authenticated: true };
}

function dispatchAdd(args: Record<string, unknown>, context: RemoteControlDispatchContext) {
  const kind = requiredString(args, "kind") as AddKind;
  const id = requiredString(args, "id");
  const options = remoteAddOptions(kind, optionalObject(args, "options"));
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

function requiredEngineRequest(
  args: Record<string, unknown>,
  command: RemoteCliRequest["command"],
): Record<string, unknown> {
  const toolRequest = optionalObject(args, "request");
  if (typeof toolRequest.operation !== "string") {
    throw new CapletsError("REQUEST_INVALID", "request.operation must be a string");
  }
  if (toolRequest.operation !== command) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `request.operation must match remote command ${command}`,
    );
  }
  return toolRequest;
}

function remoteAddOptions(
  kind: AddKind,
  options: Record<string, unknown>,
): Record<string, unknown> {
  rejectServerOwnedAddOptions(options);
  switch (kind) {
    case "cli":
      return pickOptions(options, {
        repo: "string",
        include: "string",
        command: "string",
        force: "boolean",
      });
    case "mcp":
      return pickOptions(options, {
        command: "string",
        arg: "string-array",
        cwd: "string",
        env: "string-array",
        url: "string",
        transport: "string",
        tokenEnv: "string",
        force: "boolean",
      });
    case "openapi":
      return pickOptions(options, {
        spec: "string",
        baseUrl: "string",
        tokenEnv: "string",
        force: "boolean",
      });
    case "graphql":
      return pickOptions(options, {
        endpointUrl: "string",
        schema: "string",
        introspection: "boolean",
        tokenEnv: "string",
        force: "boolean",
      });
    case "http":
      return pickOptions(options, {
        baseUrl: "string",
        action: "string-array",
        tokenEnv: "string",
        force: "boolean",
      });
    default:
      return options;
  }
}

type RemoteAddOptionType = "string" | "boolean" | "string-array";

function pickOptions(
  options: Record<string, unknown>,
  schema: Record<string, RemoteAddOptionType>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(schema)) {
    const value = options[key];
    if (value === undefined) {
      continue;
    }
    validateOptionType(key, value, type);
    next[key] = value;
  }
  return next;
}

function rejectServerOwnedAddOptions(options: Record<string, unknown>): void {
  if ("output" in options) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Remote add output is not supported remotely; the server owns destinationRoot and output path selection",
    );
  }
  for (const key of ["destinationRoot", "print"]) {
    if (key in options) {
      throw new CapletsError(
        "REQUEST_INVALID",
        `Remote add ${key} is not supported remotely; the server owns destinationRoot and print behavior`,
      );
    }
  }
}

function validateOptionType(key: string, value: unknown, type: RemoteAddOptionType): void {
  if (type === "string" && typeof value !== "string") {
    throw new CapletsError("REQUEST_INVALID", `add.options.${key} must be a string`);
  }
  if (type === "boolean" && typeof value !== "boolean") {
    throw new CapletsError("REQUEST_INVALID", `add.options.${key} must be a boolean`);
  }
  if (type === "string-array") {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
      throw new CapletsError("REQUEST_INVALID", `add.options.${key} must be an array of strings`);
    }
  }
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
