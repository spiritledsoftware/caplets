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
  listLocalAuthRowsFromRepository,
  logoutAuthResult,
  refreshAuthResult,
  resolveAuthTarget,
} from "./../cli/auth";
import { completionShells, type CompletionShell } from "./../cli/completion";
import { initConfig } from "./../cli/init";
import { listCaplets } from "./../cli/inspection";
import { loadConfigWithSources, vaultBootstrapResolver, vaultResolverForAuthDir } from "../config";
import {
  CapletsEngine,
  createCapletsEngine,
  createInternalCapletsEngine,
  type CapletsEngineOptions,
} from "../engine";
import { CapletsError, toSafeError } from "../errors";
import type {
  ControlPlaneRuntimeSnapshot,
  ControlPlaneRuntimeSnapshotLoader,
} from "../control-plane/snapshot";
import { startGenericOAuthFlow, startOAuthFlow } from "../auth";
import type { AuthTokenRepository } from "../auth/store";
import type { RemoteAuthFlowStore } from "./auth-flow";
import {
  parseCurrentHostManagementMutation,
  parseCurrentHostOperationBinding,
  toCurrentHostSafeError,
  type CurrentHostManagementResource,
  type CurrentHostOperatorPrincipal,
  type CurrentHostOperations,
} from "../current-host/operations";
import type { RemoteCliRequest, RemoteCliResponse } from "./types";

export type RemoteControlDispatchContext = CapletsEngineOptions & {
  projectCapletsRoot: string;
  globalCapletsRoot?: string | undefined;
  globalLockfilePath?: string | undefined;
  authFlowStore?: RemoteAuthFlowStore;
  controlCallbackBaseUrl?: string;
  internalRuntimeSnapshotLoader?: ControlPlaneRuntimeSnapshotLoader | undefined;
  engine?: CapletsEngine | undefined;
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
  let initializedRuntime: ControlPlaneRuntimeSnapshot | undefined;
  const initializeRuntime = async (
    liveOperation?: Parameters<CapletsEngine["requireLiveControlPlane"]>[0],
  ) => {
    if (context.engine) {
      const snapshot = context.engine.currentControlPlaneRuntimeSnapshot();
      if (snapshot && liveOperation) {
        await context.engine.requireLiveControlPlane(liveOperation);
      }
      return snapshot;
    }
    if (initializedRuntime || !context.internalRuntimeSnapshotLoader) {
      return initializedRuntime;
    }
    initializedRuntime = await context.internalRuntimeSnapshotLoader.initialize({
      vaultResolver: vaultResolverForAuthDir(context.authDir),
    });
    return initializedRuntime;
  };

  if (request.command.startsWith("current_host_")) {
    return dispatchCurrentHostManagement(
      request,
      requireCurrentHostAdministration(currentHostAdministration),
    );
  }

  if (request.command === "list") {
    const runtime = await initializeRuntime("admin");
    const config =
      runtime?.configWithSources ??
      loadConfigWithSources(context.configPath, context.projectConfigPath, {
        vaultResolver: vaultBootstrapResolver,
      });
    return listCaplets(config, {
      includeDisabled: optionalBoolean(request.arguments, "includeDisabled") ?? false,
    });
  }

  if (ENGINE_COMMANDS.has(request.command)) {
    const caplet = requiredString(request.arguments, "caplet");
    const toolRequest = requiredEngineRequest(request.arguments, request.command);
    await initializeRuntime();
    const engine = await createDispatchEngine(context, initializedRuntime);
    try {
      return await engine.execute(caplet, toolRequest);
    } finally {
      if (engine !== context.engine) await engine.close();
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

  if (request.command === "complete_cli") {
    const shell = optionalString(request.arguments, "shell") ?? "bash";
    if (!completionShells.includes(shell as CompletionShell)) return [];
    const engine = await createDispatchEngine(context, initializedRuntime);
    try {
      return await engine.completeCliWords(optionalStringArray(request.arguments, "words") ?? [""]);
    } finally {
      if (engine !== context.engine) await engine.close();
    }
  }

  if (request.command === "auth_list") {
    const runtime = await initializeRuntime("auth");
    const repository = activatedAuthRepository(context, runtime);
    if (runtime && repository) {
      return listLocalAuthRowsFromRepository(
        { effectiveConfig: runtime.configWithSources },
        repository,
      );
    }
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
    const runtime = await initializeRuntime("auth");
    const repository = activatedAuthRepository(context, runtime);
    return logoutAuthResult(requiredString(request.arguments, "server"), {
      ...optionalProp("configPath", context.configPath),
      ...optionalProp("authDir", context.authDir),
      ...(runtime ? { config: runtime.config } : {}),
      ...(repository ? { tokenRepository: repository } : {}),
    });
  }

  if (request.command === "auth_refresh") {
    const runtime = await initializeRuntime("auth");
    const repository = activatedAuthRepository(context, runtime);
    return refreshAuthResult(requiredString(request.arguments, "server"), {
      ...optionalProp("configPath", context.configPath),
      ...optionalProp("authDir", context.authDir),
      ...(runtime ? { config: runtime.config } : {}),
      ...(repository ? { tokenRepository: repository } : {}),
    });
  }

  if (request.command === "auth_login_start") {
    const runtime = await initializeRuntime("auth");
    return startRemoteAuthLogin(
      requiredString(request.arguments, "server"),
      context,
      runtime,
      activatedAuthRepository(context, runtime),
    );
  }

  if (request.command === "auth_login_complete") {
    if (context.engine?.currentControlPlaneRuntimeSnapshot()) {
      await context.engine.requireLiveControlPlane("auth");
    }
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

async function createDispatchEngine(
  context: RemoteControlDispatchContext,
  initializedRuntime: ControlPlaneRuntimeSnapshot | undefined,
): Promise<CapletsEngine> {
  const { engine, internalRuntimeSnapshotLoader, ...engineOptions } = context;
  if (engine) return engine;
  if (!internalRuntimeSnapshotLoader) return createCapletsEngine(engineOptions);
  if (!initializedRuntime) {
    throw new CapletsError("SERVER_UNAVAILABLE", "Control-plane runtime was not initialized");
  }
  return createInternalCapletsEngine(
    engineOptions,
    internalRuntimeSnapshotLoader,
    initializedRuntime,
  );
}

function isCurrentHostAdministrationCommand(command: unknown): boolean {
  return (
    command === "install" ||
    command === "update" ||
    String(command).startsWith("vault_") ||
    String(command).startsWith("current_host_")
  );
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

async function dispatchCurrentHostManagement(
  request: RemoteCliRequest,
  administration: CurrentHostRemoteAdministration,
) {
  const binding = parseCurrentHostOperationBinding(request.arguments.binding);
  switch (request.command) {
    case "current_host_list":
      return administration.operations.list(administration.principal, {
        binding,
        resource: requiredManagementResource(request.arguments, "resource"),
      });
    case "current_host_inspect":
      return administration.operations.inspect(administration.principal, {
        binding,
        resource: requiredManagementResource(request.arguments, "resource"),
        id: requiredString(request.arguments, "id"),
        selector: requiredManagementSelector(request.arguments, "selector"),
      });
    case "current_host_preview":
      return administration.operations.preview(administration.principal, {
        binding,
        mutation: parseCurrentHostManagementMutation(request.arguments.mutation),
      });
    case "current_host_mutate":
      return administration.operations.mutate(administration.principal, {
        binding,
        mutation: parseCurrentHostManagementMutation(request.arguments.mutation),
      });
    case "current_host_status":
      return administration.operations.status(administration.principal, binding);
    case "current_host_operation_lookup":
      return administration.operations.lookupOperation(administration.principal, binding);
    default:
      throw new CapletsError(
        "UNKNOWN_OPERATION",
        `Unsupported remote Current Host command ${request.command}`,
      );
  }
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

function activatedAuthRepository(
  context: RemoteControlDispatchContext,
  runtime: ControlPlaneRuntimeSnapshot | undefined,
): AuthTokenRepository | undefined {
  if (!runtime) return undefined;
  const repository = context.engine?.controlPlaneSecurityRepository();
  if (repository) return repository;
  throw new CapletsError(
    "SERVER_UNAVAILABLE",
    "Activated SQL credential authority is unavailable.",
  );
}

async function startRemoteAuthLogin(
  serverId: string,
  context: RemoteControlDispatchContext,
  runtime: ControlPlaneRuntimeSnapshot | undefined,
  tokenRepository: AuthTokenRepository | undefined,
) {
  if (!context.authFlowStore || !context.controlCallbackBaseUrl) {
    throw new CapletsError("REQUEST_INVALID", "Remote auth login is not available on this server");
  }
  const config =
    runtime?.config ??
    loadConfigWithSources(context.configPath, context.projectConfigPath, {
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
          ...(tokenRepository ? { tokenRepository } : {}),
        })
      : await startGenericOAuthFlow(target, {
          redirectUri,
          ...optionalProp("authDir", context.authDir),
          ...(tokenRepository ? { tokenRepository } : {}),
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

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CapletsError("REQUEST_INVALID", `${key} must be a non-empty string`);
  }
  return value;
}

function requiredManagementResource(
  args: Record<string, unknown>,
  key: string,
): CurrentHostManagementResource {
  const value = requiredString(args, key);
  if (value === "caplet" || value === "host-setting") return value;
  throw new CapletsError("REQUEST_INVALID", `${key} must be caplet or host-setting`);
}

function requiredManagementSelector(
  args: Record<string, unknown>,
  key: string,
): "effective" | "underlying-sql" {
  const value = requiredString(args, key);
  if (value === "effective" || value === "underlying-sql") return value;
  throw new CapletsError("REQUEST_INVALID", `${key} must be effective or underlying-sql`);
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
