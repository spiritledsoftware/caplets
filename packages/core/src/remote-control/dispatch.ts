import { randomUUID } from "node:crypto";
import {
  addCliCaplet,
  addGoogleDiscoveryCaplet,
  addGraphqlCaplet,
  addHttpCaplet,
  addMcpCaplet,
  addOpenApiCaplet,
} from "./../cli/add";
import {
  assertLoginTarget,
  listAuthRows,
  logoutAuthResult,
  refreshAuthResult,
  resolveAuthTarget,
} from "./../cli/auth";
import { completionShells, type CompletionShell } from "./../cli/completion";
import { initConfig } from "./../cli/init";
import { listCaplets } from "./../cli/inspection";
import { loadConfigWithSources, vaultBootstrapResolver, vaultResolverForAuthDir } from "../config";
import type { AuthorityCapletRecord } from "../storage/bundle-cache";
import type { AuthorityGenerationIdentity } from "../storage/types";
import { CapletsEngine, type CapletsEngineOptions } from "../engine";
import { CapletsError, toSafeError } from "../errors";
import { startGenericOAuthFlow, startOAuthFlow } from "../auth";
import type { RemoteAuthFlowStore } from "./auth-flow";
import {
  toCurrentHostSafeError,
  type CurrentHostOperatorPrincipal,
  type CurrentHostOperations,
  type CurrentHostRuntime,
} from "../current-host/operations";
import type { RemoteCliRequest, RemoteCliResponse } from "./types";

export type RemoteControlDispatchContext = CapletsEngineOptions & {
  projectCapletsRoot: string;
  globalCapletsRoot?: string | undefined;
  globalLockfilePath?: string | undefined;
  authFlowStore?: RemoteAuthFlowStore;
  controlCallbackBaseUrl?: string;
  runtime?: CurrentHostRuntime | undefined;
};

type AddKind =
  | "cli"
  | "mcp"
  | "openapi"
  | "google-discovery"
  | "googleDiscovery"
  | "graphql"
  | "http";

const ENGINE_COMMANDS = new Set<RemoteCliRequest["command"]>([
  "inspect",
  "check",
  "tools",
  "search_tools",
  "describe_tool",
  "call_tool",
  "resources",
  "search_resources",
  "resource_templates",
  "read_resource",
  "prompts",
  "search_prompts",
  "get_prompt",
  "complete",
]);

type CurrentHostRemoteAdministration = {
  operations: CurrentHostOperations;
  principal: CurrentHostOperatorPrincipal;
};

export async function dispatchRemoteCliRequest(
  request: RemoteCliRequest,
  context: RemoteControlDispatchContext,
  currentHostAdministration?: CurrentHostRemoteAdministration | undefined,
): Promise<RemoteCliResponse> {
  try {
    const result = await dispatch(request, context, currentHostAdministration);
    return { ok: true, result };
  } catch (error) {
    const currentHostOperation = isCurrentHostAdministrationCommand(request.command);
    const safe = currentHostOperation ? toCurrentHostSafeError(error) : toSafeError(error);
    const action = nextAction(safe.details);
    return {
      ok: false,
      error: {
        code: safe.code,
        message: currentHostOperation ? safe.message : redactControlErrorMessage(safe.message),
        ...(action ? { nextAction: action } : {}),
      },
    };
  }
}

async function dispatch(
  request: RemoteCliRequest,
  context: RemoteControlDispatchContext,
  currentHostAdministration?: CurrentHostRemoteAdministration | undefined,
) {
  assertObject(request, "remote control request");
  assertObject(request.arguments, "remote control request arguments");

  if (request.command === "list") {
    const administration = currentHostAdministration;
    if (administration) {
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "caplets_list",
      });
      return { remote: true, caplets: outcome.caplets };
    }
    const config = loadConfigWithSources(context.configPath, context.projectConfigPath, {
      vaultResolver: vaultBootstrapResolver,
    });
    return listCaplets(config, {
      includeDisabled: optionalBoolean(request.arguments, "includeDisabled") ?? false,
    });
  }

  if (request.command === "status") {
    const administration = requireCurrentHostAdministration(currentHostAdministration);
    const diagnostics = await administration.operations.execute(administration.principal, {
      kind: "diagnostics",
    });
    return { remote: true, status: diagnostics.status, health: diagnostics.health };
  }

  if (request.command === "execute") {
    const caplet = requiredString(request.arguments, "caplet");
    const toolRequest = requiredExecuteRequest(request.arguments);
    const lease = context.runtime?.retain();
    const engine = lease?.view.engine ?? new CapletsEngine(context);
    try {
      return await engine.execute(caplet, toolRequest);
    } finally {
      if (lease) lease.release();
      else await engine.close();
    }
  }

  if (ENGINE_COMMANDS.has(request.command)) {
    const caplet = requiredString(request.arguments, "caplet");
    const toolRequest = requiredEngineRequest(request.arguments, request.command);
    const lease = context.runtime?.retain();
    const engine = lease?.view.engine ?? new CapletsEngine(context);
    try {
      return await engine.execute(caplet, toolRequest);
    } finally {
      if (lease) lease.release();
      else await engine.close();
    }
  }

  if (request.command === "init") {
    return {
      remote: true,
      path: initConfig({
        ...optionalProp("path", context.configPath),
        ...optionalProp("force", optionalBoolean(request.arguments, "force")),
      }),
    };
  }

  if (request.command === "add") {
    return dispatchAdd(request.arguments, context);
  }

  if (request.command === "install") {
    const administration = requireCurrentHostAdministration(currentHostAdministration);
    const repo = optionalString(request.arguments, "repo");
    const outcome = await administration.operations.execute(administration.principal, {
      kind: "catalog_install",
      ...(repo ? { repo } : {}),
      ...optionalProp("capletIds", optionalStringArray(request.arguments, "capletIds")),
      ...optionalProp("force", optionalBoolean(request.arguments, "force")),
      ...optionalProp(
        "disableCatalogIndexing",
        optionalBoolean(request.arguments, "disableCatalogIndexing"),
      ),
    });
    return { remote: true, installed: outcome.installed };
  }

  if (request.command === "update") {
    const administration = requireCurrentHostAdministration(currentHostAdministration);
    const outcome = await administration.operations.execute(administration.principal, {
      kind: "catalog_update",
      ...optionalProp("capletIds", optionalStringArray(request.arguments, "capletIds")),
      ...optionalProp("force", optionalBoolean(request.arguments, "force")),
      ...optionalProp("allowRiskIncrease", optionalBoolean(request.arguments, "allowRiskIncrease")),
      ...optionalProp(
        "disableCatalogIndexing",
        optionalBoolean(request.arguments, "disableCatalogIndexing"),
      ),
    });
    return { remote: true, installed: outcome.installed };
  }

  if (
    request.command === "caplet_create" ||
    request.command === "caplet_update" ||
    request.command === "caplet_delete" ||
    request.command === "settings_get" ||
    request.command === "settings_update" ||
    request.command === "setup_grant" ||
    request.command === "setup_revoke"
  ) {
    return await dispatchCurrentHostMutation(
      request,
      requireCurrentHostAdministration(currentHostAdministration),
    );
  }

  if (request.command === "complete_cli") {
    const shell = optionalString(request.arguments, "shell") ?? "bash";
    if (!completionShells.includes(shell as CompletionShell)) return [];
    const lease = context.runtime?.retain();
    const engine = lease?.view.engine ?? new CapletsEngine(context);
    try {
      return await engine.completeCliWords(optionalStringArray(request.arguments, "words") ?? [""]);
    } finally {
      if (lease) lease.release();
      else await engine.close();
    }
  }

  if (request.command === "auth_list") {
    return listAuthRows({
      ...optionalProp("configPath", context.configPath),
      ...optionalProp("authDir", context.authDir),
    });
  }

  if (request.command.startsWith("vault_")) {
    if (
      request.command === "vault_get" &&
      (optionalBoolean(request.arguments, "reveal") ?? false)
    ) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Self-hosted remote Vault reveal is not supported through remote control.",
      );
    }
    return await dispatchCurrentHostVault(
      request,
      requireCurrentHostAdministration(currentHostAdministration),
    );
  }

  if (request.command === "auth_logout") {
    return logoutAuthResult(requiredString(request.arguments, "server"), {
      ...optionalProp("configPath", context.configPath),
      ...optionalProp("authDir", context.authDir),
    });
  }

  if (request.command === "auth_refresh") {
    return refreshAuthResult(requiredString(request.arguments, "server"), {
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
function isCurrentHostAdministrationCommand(command: unknown): boolean {
  return (
    command === "install" ||
    command === "update" ||
    command === "status" ||
    command === "list" ||
    command === "execute" ||
    command === "caplet_create" ||
    command === "caplet_update" ||
    command === "caplet_delete" ||
    command === "settings_get" ||
    command === "settings_update" ||
    command === "setup_grant" ||
    command === "setup_revoke" ||
    String(command).startsWith("vault_")
  );
}

async function dispatchCurrentHostMutation(
  request: RemoteCliRequest,
  administration: CurrentHostRemoteAdministration,
): Promise<unknown> {
  const args = request.arguments;
  const common = {
    ...optionalProp("expectedGeneration", optionalGeneration(args, "expectedGeneration")),
    ...optionalProp("idempotencyKey", optionalString(args, "idempotencyKey")),
  };
  switch (request.command) {
    case "caplet_create": {
      const record = authorityRecordArgument(args, "record");
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "caplet_create",
        record,
        ...common,
      });
      return { remote: true, outcome };
    }
    case "caplet_update": {
      const record = authorityRecordArgument(args, "record");
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "caplet_update",
        id: requiredString(args, "id"),
        record,
        ...common,
      });
      return { remote: true, outcome };
    }
    case "caplet_delete": {
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "caplet_delete",
        id: requiredString(args, "id"),
        ...common,
      });
      return { remote: true, outcome };
    }
    case "settings_get":
      return {
        remote: true,
        ...(await administration.operations.execute(administration.principal, {
          kind: "settings_get",
        })),
      };
    case "settings_update":
      return {
        remote: true,
        ...(await administration.operations.execute(administration.principal, {
          kind: "settings_update",
          settings: optionalObject(args, "settings"),
          ...common,
        })),
      };
    case "setup_grant":
    case "setup_revoke":
      return {
        remote: true,
        ...(await administration.operations.execute(administration.principal, {
          kind: request.command,
          capletId: requiredString(args, "capletId"),
          contentHash: requiredString(args, "contentHash"),
          targetKind: requiredSetupTarget(args, "targetKind"),
          ...optionalProp("projectFingerprint", optionalString(args, "projectFingerprint")),
          ...optionalProp("actor", optionalSetupActor(args, "actor")),
          ...common,
        })),
      };
    default:
      throw new CapletsError(
        "UNKNOWN_OPERATION",
        `Unsupported Current Host command ${request.command}`,
      );
  }
}
function requireCurrentHostAdministration(
  administration: CurrentHostRemoteAdministration | undefined,
): CurrentHostRemoteAdministration {
  if (administration) return administration;
  throw new CapletsError(
    "AUTH_FAILED",
    "Current Host administration requires an Operator principal.",
  );
}

async function dispatchCurrentHostVault(
  request: RemoteCliRequest,
  administration: CurrentHostRemoteAdministration,
) {
  switch (request.command) {
    case "vault_set": {
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "vault_set",
        name: requiredString(request.arguments, "name"),
        value: requiredString(request.arguments, "value"),
        ...optionalProp("grant", optionalString(request.arguments, "grant")),
        ...optionalProp("referenceName", optionalString(request.arguments, "referenceName")),
        ...optionalProp("force", optionalBoolean(request.arguments, "force")),
      });
      return { remote: true, ...outcome.status };
    }
    case "vault_list": {
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "vault_list",
      });
      return outcome.values;
    }
    case "vault_get": {
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "vault_get",
        name: requiredString(request.arguments, "name"),
      });
      return outcome.status;
    }
    case "vault_delete": {
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "vault_delete",
        name: requiredString(request.arguments, "name"),
      });
      return outcome.deleted;
    }
    case "vault_access_grant": {
      const storedKey = requiredString(request.arguments, "name");
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "vault_access_grant",
        storedKey,
        referenceName: optionalString(request.arguments, "referenceName") ?? storedKey,
        capletId: requiredString(request.arguments, "capletId"),
      });
      return outcome.grant;
    }
    case "vault_access_revoke": {
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "vault_access_revoke",
        storedKey: requiredString(request.arguments, "name"),
        capletId: requiredString(request.arguments, "capletId"),
        ...optionalProp("referenceName", optionalString(request.arguments, "referenceName")),
      });
      return outcome.revoked;
    }
    case "vault_access_list": {
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "vault_access_list",
        ...optionalProp("storedKey", optionalString(request.arguments, "name")),
        ...optionalProp("capletId", optionalString(request.arguments, "capletId")),
      });
      return outcome.grants;
    }
    default:
      throw new CapletsError(
        "UNKNOWN_OPERATION",
        `Unsupported remote control command ${request.command}`,
      );
  }
}

async function startRemoteAuthLogin(serverId: string, context: RemoteControlDispatchContext) {
  if (!context.authFlowStore || !context.controlCallbackBaseUrl) {
    throw new CapletsError("REQUEST_INVALID", "Remote auth login is not available on this server");
  }
  const config = loadConfigWithSources(context.configPath, context.projectConfigPath, {
    vaultResolver: vaultResolverForAuthDir(context.authDir),
  }).config;
  const target = await resolveAuthTarget(serverId, config, context.authDir);
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
  if (!started.authorizationUrl) {
    return { server: serverId, authenticated: true };
  }
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
  context.authFlowStore?.delete(flowId);
  await flow.complete(callbackUrl);
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
    case "google-discovery":
    case "googleDiscovery":
      return {
        remote: true,
        label: "Google Discovery",
        ...addGoogleDiscoveryCaplet(id, {
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
        "add.kind must be cli, mcp, openapi, google-discovery, googleDiscovery, graphql, or http",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CapletsError("REQUEST_INVALID", `${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new CapletsError("REQUEST_INVALID", `${key} must be a string`);
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

function requiredExecuteRequest(args: Record<string, unknown>): Record<string, unknown> {
  const request = optionalObject(args, "request");
  if (typeof request.operation !== "string") request.operation = "call_tool";
  return request;
}

function authorityRecordArgument(
  args: Record<string, unknown>,
  key: string,
): AuthorityCapletRecord {
  const value = args[key];
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new CapletsError("REQUEST_INVALID", `${key} must be an authority Caplet record.`);
  }
  return { ...value, id: value.id };
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
    case "google-discovery":
    case "googleDiscovery":
      return pickOptions(options, {
        discovery: "string",
        discoveryUrl: "string",
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

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
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

function optionalGeneration(
  args: Record<string, unknown>,
  key: string,
): AuthorityGenerationIdentity | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.authorityId !== "string" ||
    typeof value.id !== "string" ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    (value.predecessorId !== null && typeof value.predecessorId !== "string")
  ) {
    throw new CapletsError("REQUEST_INVALID", `${key} must be an Authority Generation identity.`);
  }
  return {
    authorityId: value.authorityId,
    id: value.id,
    sequence: value.sequence,
    predecessorId: value.predecessorId,
  };
}

function requiredSetupTarget(
  args: Record<string, unknown>,
  key: string,
): "local_host" | "remote_host" | "hosted_sandbox" {
  const value = requiredString(args, key);
  if (value === "local_host" || value === "remote_host" || value === "hosted_sandbox") return value;
  throw new CapletsError("REQUEST_INVALID", `${key} must be a valid setup target.`);
}

function optionalSetupActor(
  args: Record<string, unknown>,
  key: string,
): "cli-interactive" | "cli-yes" | "ui" | "automation" | undefined {
  const value = optionalString(args, key);
  if (value === undefined) return undefined;
  if (
    value === "cli-interactive" ||
    value === "cli-yes" ||
    value === "ui" ||
    value === "automation"
  )
    return value;
  throw new CapletsError("REQUEST_INVALID", `${key} must be a valid setup actor.`);
}

function nextAction(details: unknown): string | undefined {
  if (details && typeof details === "object" && "nextAction" in details) {
    const value = (details as { nextAction?: unknown }).nextAction;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function redactControlErrorMessage(message: string): string {
  return message
    .replace(
      /(["'])(authorization|(?:access[_-]?)?token|refresh(?:[_-]?token)?|password|client[_-]?secret|clientsecret|api[-_]?key|apikey|secret|credential|code)\1\s*:\s*(["'])(?:\\.|[^\\])*?\3/giu,
      "$1$2$1:$3[REDACTED]$3",
    )
    .replace(/\b(authorization\s*:\s*(?:basic|bearer)\s+)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(
      /\b((?:access[_-]?)?token|refresh(?:[_-]?token)?|password|client[_-]?secret|clientsecret|api[-_]?key|apikey|secret|credential|code)(\s*[=:]\s*)[^\s,;]+/giu,
      "$1$2[REDACTED]",
    );
}
