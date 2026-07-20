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
import { CapletsEngine, type CapletsEngineOptions } from "../engine";
import { CapletsError, toSafeError } from "../errors";
import { RemoteAuthFlowCoordinator } from "./auth-flow";
import {
  toCurrentHostSafeError,
  type CurrentHostOperatorPrincipal,
  type CurrentHostOperations,
} from "../current-host/operations";
import type { RemoteCapletBundleFile, RemoteCliRequest, RemoteCliResponse } from "./types";
import type { BackendAuthStateStore } from "../storage/backend-auth";
import type { HostStorage } from "../storage/database";
import type { BackendAuthFlowRepository } from "../storage/backend-auth-flows";
import { createHostStorageVaultResolver } from "../storage/vault-resolver";
import {
  MAX_BUNDLE_FILES,
  MAX_BUNDLE_FILE_BYTES,
  MAX_BUNDLE_TOTAL_BYTES,
  type CapletBundleInputFile,
} from "../storage/caplet-records";

export type RemoteControlDispatchContext = CapletsEngineOptions & {
  projectCapletsRoot: string;
  globalCapletsRoot?: string | undefined;
  globalLockfilePath?: string | undefined;
  backendAuthFlows?: BackendAuthFlowRepository;
  controlCallbackBaseUrl?: string;
  backendAuthStore?: BackendAuthStateStore;
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

const STORAGE_RECORD_COMMAND_PREFIX = "storage_records_";
const MAX_REMOTE_BUNDLE_FILES = MAX_BUNDLE_FILES + 1;
// This is the authoritative UTF-8 size of the canonical import/update envelope after base64
// payloads are replaced with empty strings. decodeBundleFiles enforces it before each decode.
export const LEGACY_BUNDLE_SERIALIZED_METADATA_MAX_BYTES = 16 * 1024 * 1024;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

type RemoteBundleMetadataFile = Pick<RemoteCapletBundleFile, "path" | "executable">;

// Splitting bytes across files can add one padded quartet per populated file. This returns
// the exact maximum for a total byte count distributed across at most fileCount files.
export function maximumBase64EncodedBytes(totalBytes: number, fileCount: number): number {
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < 0 ||
    !Number.isSafeInteger(fileCount) ||
    fileCount < 0 ||
    (totalBytes > 0 && fileCount === 0)
  ) {
    throw new RangeError("totalBytes and fileCount must describe a bounded file set.");
  }
  const populatedFiles = Math.min(totalBytes, fileCount);
  const encodedBytes = 4 * (populatedFiles + Math.floor((totalBytes - populatedFiles) / 3));
  if (!Number.isSafeInteger(encodedBytes)) {
    throw new RangeError("The encoded bundle size exceeds the safe integer range.");
  }
  return encodedBytes;
}

const MAX_REMOTE_BUNDLE_FILE_BASE64_BYTES = maximumBase64EncodedBytes(MAX_BUNDLE_FILE_BYTES, 1);

export function remoteBundleSerializedMetadataBytes(
  command: string,
  args: Readonly<Record<string, unknown>>,
  files: readonly RemoteBundleMetadataFile[],
): number {
  const serialized = JSON.stringify({
    command,
    arguments: {
      ...args,
      files: files.map((file) => ({
        path: file.path,
        contentBase64: "",
        executable: file.executable,
      })),
    },
  });
  return Buffer.byteLength(serialized);
}

function remoteBundleFileSerializedMetadataBytes(file: RemoteBundleMetadataFile): number {
  const serialized = JSON.stringify({
    path: file.path,
    contentBase64: "",
    executable: file.executable,
  });
  return Buffer.byteLength(serialized);
}

type CurrentHostRemoteAdministration = {
  operations: CurrentHostOperations;
  principal: CurrentHostOperatorPrincipal;
  storage?: HostStorage | undefined;
  activateConfig?: (() => Promise<void>) | undefined;
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
    const config = loadConfigWithSources(context.configPath, context.projectConfigPath, {
      vaultResolver: vaultBootstrapResolver,
    });
    return listCaplets(config, {
      includeDisabled: optionalBoolean(request.arguments, "includeDisabled") ?? false,
    });
  }

  if (ENGINE_COMMANDS.has(request.command)) {
    const caplet = requiredString(request.arguments, "caplet");
    const toolRequest = requiredEngineRequest(request.arguments, request.command);
    const engine = await CapletsEngine.create(context);
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
    const engine = await CapletsEngine.create(context);
    try {
      return await engine.completeCliWords(optionalStringArray(request.arguments, "words") ?? [""]);
    } finally {
      await engine.close();
    }
  }

  if (request.command === "auth_list") {
    return listAuthRows({
      authStore: requireBackendAuthStore(context),
      ...optionalProp("configPath", context.configPath),
      ...optionalProp("authDir", context.authDir),
    });
  }

  if (request.command.startsWith(STORAGE_RECORD_COMMAND_PREFIX)) {
    return await dispatchCurrentHostStorage(
      request,
      requireCurrentHostAdministration(currentHostAdministration),
    );
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
      authStore: requireBackendAuthStore(context),
      ...optionalProp("configPath", context.configPath),
      ...optionalProp("authDir", context.authDir),
    });
  }

  if (request.command === "auth_refresh") {
    return refreshAuthResult(requiredString(request.arguments, "server"), {
      authStore: requireBackendAuthStore(context),
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
    String(command).startsWith("vault_") ||
    String(command).startsWith(STORAGE_RECORD_COMMAND_PREFIX)
  );
}

function requireCurrentHostAdministration(
  administration: CurrentHostRemoteAdministration | undefined,
): CurrentHostRemoteAdministration {
  if (administration?.principal.role === "operator" && administration.principal.clientId.trim()) {
    return administration;
  }
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

async function dispatchCurrentHostStorage(
  request: RemoteCliRequest,
  administration: CurrentHostRemoteAdministration,
) {
  const storage = administration.storage;
  if (!storage) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Authoritative Host State storage is unavailable.",
    );
  }
  const operator = {
    role: "operator" as const,
    clientId: administration.principal.clientId,
  };
  const args = request.arguments;
  const activate = async (): Promise<void> => {
    await administration.activateConfig?.();
  };

  switch (request.command) {
    case "storage_records_list":
      assertOnlyKeys(args, []);
      return await storage.caplets.listStored(operator);
    case "storage_records_get": {
      assertOnlyKeys(args, ["id"]);
      return encodeBundleResult(
        await storage.caplets.readBundle(requiredString(args, "id"), { operator }),
      );
    }
    case "storage_records_import": {
      assertOnlyKeys(args, [
        "id",
        "files",
        "historyLimit",
        "sourceKind",
        "sourceIdentity",
        "channel",
      ]);
      const sourceKind = optionalString(args, "sourceKind");
      const sourceIdentity = optionalString(args, "sourceIdentity");
      const installation =
        sourceKind === undefined && sourceIdentity === undefined
          ? undefined
          : {
              sourceKind: requirePairedString(
                sourceKind,
                "sourceKind",
                sourceIdentity,
                "sourceIdentity",
              ),
              sourceIdentity: requirePairedString(
                sourceIdentity,
                "sourceIdentity",
                sourceKind,
                "sourceKind",
              ),
              ...optionalProp("channel", optionalString(args, "channel")),
            };
      const record = await storage.caplets.importBundle({
        id: requiredString(args, "id"),
        files: decodeBundleFiles(request),
        operator,
        ...optionalProp("historyLimit", optionalNonNegativeInteger(args, "historyLimit")),
        ...(installation ? { installation } : {}),
      });
      await activate();
      return record;
    }
    case "storage_records_update": {
      assertOnlyKeys(args, ["id", "files", "expectedGeneration", "detachInstallation"]);
      const record = await storage.caplets.updateBundle({
        id: requiredString(args, "id"),
        files: decodeBundleFiles(request),
        expectedGeneration: requiredPositiveInteger(args, "expectedGeneration"),
        operator,
        ...optionalProp("detachInstallation", optionalBoolean(args, "detachInstallation")),
      });
      await activate();
      return record;
    }
    case "storage_records_export": {
      assertOnlyKeys(args, ["id", "revisionKey"]);
      return encodeBundleResult(
        await storage.caplets.readBundle(requiredString(args, "id"), {
          operator,
          ...optionalProp("revisionKey", optionalString(args, "revisionKey")),
        }),
      );
    }
    case "storage_records_revisions":
      assertOnlyKeys(args, ["id"]);
      return await storage.caplets.listRevisions(requiredString(args, "id"), operator);
    case "storage_records_restore": {
      assertOnlyKeys(args, ["id", "revisionKey", "expectedGeneration"]);
      const record = await storage.caplets.restoreRevision({
        id: requiredString(args, "id"),
        revisionKey: requiredString(args, "revisionKey"),
        expectedGeneration: requiredPositiveInteger(args, "expectedGeneration"),
        operator,
      });
      await activate();
      return record;
    }
    case "storage_records_delete_revision": {
      assertOnlyKeys(args, ["id", "revisionKey", "expectedGeneration"]);
      const record = await storage.caplets.deleteRevision({
        id: requiredString(args, "id"),
        revisionKey: requiredString(args, "revisionKey"),
        expectedGeneration: requiredPositiveInteger(args, "expectedGeneration"),
        operator,
      });
      await activate();
      return { deleted: true, record };
    }
    case "storage_records_retention": {
      assertOnlyKeys(args, ["id", "historyLimit", "expectedGeneration"]);
      const record = await storage.caplets.setRetention({
        id: requiredString(args, "id"),
        historyLimit: requiredNullableNonNegativeInteger(args, "historyLimit"),
        expectedGeneration: requiredPositiveInteger(args, "expectedGeneration"),
        operator,
      });
      await activate();
      return record;
    }
    case "storage_records_rename": {
      assertOnlyKeys(args, ["id", "newId", "expectedGeneration"]);
      const record = await storage.caplets.rename({
        id: requiredString(args, "id"),
        newId: requiredString(args, "newId"),
        expectedGeneration: requiredPositiveInteger(args, "expectedGeneration"),
        operator,
      });
      await activate();
      return record;
    }
    case "storage_records_delete": {
      assertOnlyKeys(args, ["id", "expectedGeneration"]);
      const id = requiredString(args, "id");
      await storage.caplets.hardDelete({
        id,
        expectedGeneration: requiredPositiveInteger(args, "expectedGeneration"),
        operator,
      });
      await activate();
      return { deleted: true, id };
    }
    case "storage_records_installation_status": {
      assertOnlyKeys(args, ["id"]);
      const id = requiredString(args, "id");
      return {
        installations: await storage.installations.list(id),
        observations: await storage.installations.listObservations(id),
      };
    }
    case "storage_records_installation_detach":
      assertOnlyKeys(args, ["id", "expectedGeneration"]);
      return await storage.installations.detach({
        capletId: requiredString(args, "id"),
        expectedGeneration: requiredPositiveInteger(args, "expectedGeneration"),
        operator,
      });
    case "storage_records_installation_observe":
      assertOnlyKeys(args, [
        "id",
        "expectedGeneration",
        "status",
        "resolvedRevision",
        "contentHash",
        "risk",
      ]);
      return await storage.installations.appendObservation({
        capletId: requiredString(args, "id"),
        expectedGeneration: requiredPositiveInteger(args, "expectedGeneration"),
        status: requiredInstallationObservationStatus(args, "status"),
        operator,
        ...optionalProp("resolvedRevision", optionalString(args, "resolvedRevision")),
        ...optionalProp("contentHash", optionalString(args, "contentHash")),
        ...optionalProp("risk", optionalRecord(args, "risk")),
      });
    case "storage_records_installation_replace":
      assertOnlyKeys(args, [
        "id",
        "expectedGeneration",
        "sourceKind",
        "sourceIdentity",
        "channel",
        "detachedInstallationKey",
      ]);
      return await storage.installations.replaceDetached({
        capletId: requiredString(args, "id"),
        expectedGeneration: requiredPositiveInteger(args, "expectedGeneration"),
        sourceKind: requiredString(args, "sourceKind"),
        sourceIdentity: requiredString(args, "sourceIdentity"),
        operator,
        ...optionalProp("channel", optionalString(args, "channel")),
        ...optionalProp("detachedInstallationKey", optionalString(args, "detachedInstallationKey")),
      });
    default:
      throw new CapletsError(
        "UNKNOWN_OPERATION",
        `Unsupported remote control command ${request.command}`,
      );
  }
}

function requireBackendAuthStore(context: RemoteControlDispatchContext) {
  const authStore = context.backendAuthStore ?? context.hostStorage?.backendAuth;
  if (!authStore) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Authoritative backend auth storage is unavailable.",
    );
  }
  return authStore;
}

async function startRemoteAuthLogin(serverId: string, context: RemoteControlDispatchContext) {
  if (!context.controlCallbackBaseUrl) {
    throw new CapletsError("REQUEST_INVALID", "Remote auth login is not available on this server");
  }
  return await remoteAuthFlowCoordinator(context).start({
    server: serverId,
    callbackBaseUrl: context.controlCallbackBaseUrl,
  });
}

async function completeRemoteAuthLogin(
  flowId: string,
  callbackUrl: string,
  context: RemoteControlDispatchContext,
) {
  return await remoteAuthFlowCoordinator(context).complete(flowId, callbackUrl);
}

function remoteAuthFlowCoordinator(
  context: RemoteControlDispatchContext,
): RemoteAuthFlowCoordinator {
  const repository = context.backendAuthFlows ?? context.hostStorage?.backendAuthFlows;
  if (!repository) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Authoritative backend auth flow storage is unavailable.",
    );
  }
  const authStore = requireBackendAuthStore(context);
  return new RemoteAuthFlowCoordinator({
    repository,
    authStore,
    operatorClientId: "remote_cli",
    resolveTarget: async (serverId) => {
      const vaultResolver = context.hostStorage
        ? await createHostStorageVaultResolver(context.hostStorage)
        : vaultResolverForAuthDir(context.authDir);
      const config = loadConfigWithSources(context.configPath, context.projectConfigPath, {
        vaultResolver,
      }).config;
      const target = await resolveAuthTarget(serverId, config, authStore);
      assertLoginTarget(target, serverId);
      return target;
    },
  });
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

function assertOnlyKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new CapletsError("REQUEST_INVALID", `Unexpected remote storage argument ${key}.`);
    }
  }
}

function requiredPositiveInteger(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new CapletsError("REQUEST_INVALID", `${key} must be a positive integer`);
  }
  return value as number;
}

function optionalNonNegativeInteger(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new CapletsError("REQUEST_INVALID", `${key} must be a non-negative integer`);
  }
  return value as number;
}

function requiredNullableNonNegativeInteger(
  args: Record<string, unknown>,
  key: string,
): number | null {
  if (args[key] === null) return null;
  const value = optionalNonNegativeInteger(args, key);
  if (value === undefined) {
    throw new CapletsError("REQUEST_INVALID", `${key} is required`);
  }
  return value;
}

function optionalRecord(
  args: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  assertObject(value, key);
  return value;
}

function requirePairedString(
  value: string | undefined,
  key: string,
  paired: string | undefined,
  pairedKey: string,
): string {
  if (value !== undefined && paired !== undefined) return value;
  throw new CapletsError("REQUEST_INVALID", `${key} and ${pairedKey} must be provided together`);
}

function requiredInstallationObservationStatus(
  args: Record<string, unknown>,
  key: string,
): "current" | "metadata-only" | "source-unavailable" {
  const value = requiredString(args, key);
  if (value === "current" || value === "metadata-only" || value === "source-unavailable") {
    return value;
  }
  throw new CapletsError(
    "REQUEST_INVALID",
    `${key} must be current, metadata-only, or source-unavailable`,
  );
}

function decodeBundleFiles(request: RemoteCliRequest): CapletBundleInputFile[] {
  const value = request.arguments.files;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REMOTE_BUNDLE_FILES) {
    throw new CapletsError("REQUEST_INVALID", "Remote Caplet bundle file list is invalid.");
  }
  const files: CapletBundleInputFile[] = [];
  let totalBytes = 0;
  let metadataBytes = remoteBundleSerializedMetadataBytes(request.command, request.arguments, []);
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    assertObject(item, "Remote Caplet bundle file");
    assertOnlyKeys(item, ["path", "contentBase64", "executable"]);
    const path = requiredString(item, "path");
    if (typeof item.executable !== "boolean") {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Remote Caplet bundle executable intent must be boolean.",
      );
    }
    metadataBytes += index === 0 ? 0 : 1;
    metadataBytes += remoteBundleFileSerializedMetadataBytes({
      path,
      executable: item.executable,
    });
    if (metadataBytes > LEGACY_BUNDLE_SERIALIZED_METADATA_MAX_BYTES) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Remote Caplet bundle metadata exceeds the byte limit.",
      );
    }
    const contentBase64 = item.contentBase64;
    if (
      typeof contentBase64 !== "string" ||
      contentBase64.length > MAX_REMOTE_BUNDLE_FILE_BASE64_BYTES ||
      !BASE64_PATTERN.test(contentBase64)
    ) {
      throw new CapletsError("REQUEST_INVALID", "Remote Caplet bundle file content is invalid.");
    }
    const content = Buffer.from(contentBase64, "base64");
    if (
      content.byteLength > MAX_BUNDLE_FILE_BYTES ||
      content.toString("base64") !== contentBase64
    ) {
      throw new CapletsError("REQUEST_INVALID", "Remote Caplet bundle file content is invalid.");
    }
    totalBytes += content.byteLength;
    if (totalBytes > MAX_BUNDLE_TOTAL_BYTES) {
      throw new CapletsError("REQUEST_INVALID", "Remote Caplet bundle exceeds the byte limit.");
    }
    files.push({ path, content, executable: item.executable });
  }
  return files;
}

function encodeBundleResult(result: { record: unknown; files: CapletBundleInputFile[] }): {
  record: unknown;
  files: RemoteCapletBundleFile[];
} {
  return {
    record: result.record,
    files: result.files.map((file) => ({
      path: file.path,
      contentBase64: file.content.toString("base64"),
      executable: file.executable,
    })),
  };
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
