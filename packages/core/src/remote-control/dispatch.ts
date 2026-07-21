import { completionShells, type CompletionShell } from "./../cli/completion";
import { CapletsEngine, type CapletsEngineOptions } from "../engine";
import { buildAttachProjection, invokeAttachExport, type AttachProjection } from "../attach/api";
import {
  capletRowsFromAttachManifest,
  completionSuggestionsFromAttachManifest,
} from "../remote-cli/attach";
import { CapletsError, toSafeError } from "../errors";
import {
  toCurrentHostSafeError,
  type CurrentHostOperatorPrincipal,
  type CurrentHostOperations,
} from "../current-host/operations";
import type { RemoteCapletBundleFile, RemoteCliRequest, RemoteCliResponse } from "./types";
import {
  MAX_BUNDLE_FILES,
  MAX_BUNDLE_FILE_BYTES,
  MAX_BUNDLE_TOTAL_BYTES,
  type CapletBundleInputFile,
} from "../storage/caplet-records";
import {
  bufferBundleFileSource,
  readVerifiedBundleFile,
  type ReopenableBundleFileSource,
} from "../storage/bundle-source";

export type RemoteControlDispatchContext = CapletsEngineOptions & {
  projectCapletsRoot: string;
  globalCapletsRoot?: string | undefined;
  globalLockfilePath?: string | undefined;
  controlCallbackBaseUrl?: string;
  attachEngine?: CapletsEngine | undefined;
};

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
  principal?: CurrentHostOperatorPrincipal | undefined;
};

type CurrentHostOperatorAdministration = {
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
        message: currentHostOperation
          ? frozenV1CurrentHostErrorMessage(request.command, safe.code, safe.message)
          : redactControlErrorMessage(safe.message),
        ...(action ? { nextAction: action } : {}),
      },
    };
  }
}
function frozenV1CurrentHostErrorMessage(command: unknown, code: string, message: string): string {
  return String(command).startsWith(STORAGE_RECORD_COMMAND_PREFIX) && code === "SERVER_UNAVAILABLE"
    ? "Authoritative Host State storage is unavailable."
    : message;
}

async function dispatch(
  request: RemoteCliRequest,
  context: RemoteControlDispatchContext,
  currentHostAdministration?: CurrentHostRemoteAdministration | undefined,
) {
  assertObject(request, "remote control request");
  assertObject(request.arguments, "remote control request arguments");
  if (request.command === "init" || request.command === "add") {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Remote ${request.command} is local-only. Run caplets ${request.command} on the machine whose files should change.`,
    );
  }
  if (request.command === "list") {
    optionalBoolean(request.arguments, "includeDisabled");
    return await withAttachProjection(context, async (_engine, projection) =>
      capletRowsFromAttachManifest(projection.manifest),
    );
  }
  if (ENGINE_COMMANDS.has(request.command)) {
    const caplet = requiredString(request.arguments, "caplet");
    const input = requiredEngineRequest(request.arguments, request.command);
    return await withAttachProjection(context, async (engine, projection) => {
      const exported = projection.manifest.caplets.find((entry) => entry.capletId === caplet);
      if (!exported) {
        throw new CapletsError(
          "ATTACH_EXPORT_NOT_FOUND",
          "The requested Attach Caplet is not exported.",
        );
      }
      return await invokeAttachExport(engine, projection, {
        revision: projection.manifest.revision,
        kind: "caplet",
        exportId: exported.exportId,
        input,
      });
    });
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
    return await withAttachProjection(context, async (_engine, projection) =>
      completionSuggestionsFromAttachManifest(projection.manifest, request.arguments),
    );
  }

  if (request.command.startsWith("auth_")) {
    return await dispatchCurrentHostAuth(request, context, currentHostAdministration);
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

  throw new CapletsError(
    "UNKNOWN_OPERATION",
    `Unsupported remote control command ${request.command}`,
  );
}

async function withAttachProjection<Result>(
  context: RemoteControlDispatchContext,
  operation: (engine: CapletsEngine, projection: AttachProjection) => Promise<Result>,
): Promise<Result> {
  if (context.attachEngine) {
    return await operation(context.attachEngine, await buildAttachProjection(context.attachEngine));
  }
  const engine = await CapletsEngine.create(context);
  try {
    return await operation(engine, await buildAttachProjection(engine));
  } finally {
    await engine.close();
  }
}

function isCurrentHostAdministrationCommand(command: unknown): boolean {
  return (
    command === "install" ||
    command === "update" ||
    String(command).startsWith("auth_") ||
    String(command).startsWith("vault_") ||
    String(command).startsWith(STORAGE_RECORD_COMMAND_PREFIX)
  );
}

function requireCurrentHostAdministration(
  administration: CurrentHostRemoteAdministration | undefined,
): CurrentHostOperatorAdministration {
  if (administration?.principal?.role === "operator" && administration.principal.clientId.trim()) {
    return { operations: administration.operations, principal: administration.principal };
  }
  throw new CapletsError(
    "AUTH_FAILED",
    "Current Host administration requires an Operator principal.",
  );
}

function requireCurrentHostOperations(
  administration: CurrentHostRemoteAdministration | undefined,
): CurrentHostOperations {
  if (administration) return administration.operations;
  throw new CapletsError("SERVER_UNAVAILABLE", "Current Host operations are unavailable.");
}

async function dispatchCurrentHostAuth(
  request: RemoteCliRequest,
  context: RemoteControlDispatchContext,
  currentHostAdministration: CurrentHostRemoteAdministration | undefined,
) {
  if (request.command === "auth_login_complete") {
    const flowId = requiredString(request.arguments, "flowId");
    const outcome = await requireCurrentHostOperations(currentHostAdministration).execute(
      { role: "backend_auth_callback", flowId },
      {
        kind: "backend_auth_flow_callback_complete",
        flowId,
        callbackUrl: requiredString(request.arguments, "callbackUrl"),
      },
    );
    return { server: outcome.server, authenticated: outcome.authenticated };
  }

  const administration = requireCurrentHostAdministration(currentHostAdministration);
  switch (request.command) {
    case "auth_list": {
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "backend_auth_configured_statuses",
      });
      return outcome.rows;
    }
    case "auth_logout": {
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "backend_auth_connection_delete_if_present",
        server: requiredString(request.arguments, "server"),
      });
      return { server: outcome.server, deleted: outcome.deleted };
    }
    case "auth_refresh": {
      const server = requiredString(request.arguments, "server");
      const current = await administration.operations.execute(administration.principal, {
        kind: "backend_auth_connection_get",
        server,
      });
      await administration.operations.execute(administration.principal, {
        kind: "backend_auth_refresh",
        server,
        expectedGeneration: current.connection.generation,
      });
      return { server };
    }
    case "auth_login_start": {
      if (!context.controlCallbackBaseUrl) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Remote auth login is not available on this server",
        );
      }
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "backend_auth_legacy_flow_start",
        server: requiredString(request.arguments, "server"),
        callbackBaseUrl: context.controlCallbackBaseUrl,
      });
      return "authenticated" in outcome
        ? { server: outcome.server, authenticated: outcome.authenticated }
        : {
            server: outcome.server,
            flowId: outcome.flowId,
            authorizationUrl: outcome.authorizationUrl,
          };
    }
    default:
      throw new CapletsError(
        "UNKNOWN_OPERATION",
        `Unsupported remote control command ${request.command}`,
      );
  }
}

async function dispatchCurrentHostVault(
  request: RemoteCliRequest,
  administration: CurrentHostOperatorAdministration,
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
  administration: CurrentHostOperatorAdministration,
) {
  const args = request.arguments;
  switch (request.command) {
    case "storage_records_list": {
      assertOnlyKeys(args, []);
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "stored_caplets_list",
      });
      return outcome.records;
    }
    case "storage_records_get": {
      assertOnlyKeys(args, ["id"]);
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "stored_caplet_bundle_get",
        id: requiredString(args, "id"),
      });
      return await encodeBundleSourcesResult(outcome);
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
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "stored_caplet_bundle_import",
        id: requiredString(args, "id"),
        sources: decodeBundleFiles(request).map(bufferBundleFileSource),
        ...optionalProp("historyLimit", optionalNonNegativeInteger(args, "historyLimit")),
        ...(installation ? { installation } : {}),
      });
      return outcome.record;
    }
    case "storage_records_update": {
      assertOnlyKeys(args, ["id", "files", "expectedGeneration", "detachInstallation"]);
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "stored_caplet_bundle_update",
        id: requiredString(args, "id"),
        sources: decodeBundleFiles(request).map(bufferBundleFileSource),
        expectedGeneration: requiredPositiveInteger(args, "expectedGeneration"),
        ...optionalProp("detachInstallation", optionalBoolean(args, "detachInstallation")),
      });
      return outcome.record;
    }
    case "storage_records_export": {
      assertOnlyKeys(args, ["id", "revisionKey"]);
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "stored_caplet_bundle_get",
        id: requiredString(args, "id"),
        ...optionalProp("revisionKey", optionalString(args, "revisionKey")),
      });
      return await encodeBundleSourcesResult(outcome);
    }
    case "storage_records_revisions": {
      assertOnlyKeys(args, ["id"]);
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "stored_caplet_revisions",
        id: requiredString(args, "id"),
      });
      return outcome.revisions;
    }
    case "storage_records_restore": {
      assertOnlyKeys(args, ["id", "revisionKey", "expectedGeneration"]);
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "stored_caplet_restore_revision",
        id: requiredString(args, "id"),
        revisionKey: requiredString(args, "revisionKey"),
        expectedGeneration: requiredPositiveInteger(args, "expectedGeneration"),
      });
      return outcome.record;
    }
    case "storage_records_delete_revision": {
      assertOnlyKeys(args, ["id", "revisionKey", "expectedGeneration"]);
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "stored_caplet_delete_revision",
        id: requiredString(args, "id"),
        revisionKey: requiredString(args, "revisionKey"),
        expectedGeneration: requiredPositiveInteger(args, "expectedGeneration"),
      });
      return { deleted: true, record: outcome.record };
    }
    case "storage_records_retention": {
      assertOnlyKeys(args, ["id", "historyLimit", "expectedGeneration"]);
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "stored_caplet_update",
        id: requiredString(args, "id"),
        historyLimit: requiredNullableNonNegativeInteger(args, "historyLimit"),
        expectedGeneration: requiredPositiveInteger(args, "expectedGeneration"),
      });
      return outcome.record;
    }
    case "storage_records_rename": {
      assertOnlyKeys(args, ["id", "newId", "expectedGeneration"]);
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "stored_caplet_update",
        id: requiredString(args, "id"),
        newId: requiredString(args, "newId"),
        expectedGeneration: requiredPositiveInteger(args, "expectedGeneration"),
      });
      return outcome.record;
    }
    case "storage_records_delete": {
      assertOnlyKeys(args, ["id", "expectedGeneration"]);
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "stored_caplet_delete",
        id: requiredString(args, "id"),
        expectedGeneration: requiredPositiveInteger(args, "expectedGeneration"),
      });
      return { deleted: outcome.deleted, id: outcome.id };
    }
    case "storage_records_installation_status": {
      assertOnlyKeys(args, ["id"]);
      const outcome = await currentHostInstallationStatus(
        administration,
        requiredString(args, "id"),
      );
      return {
        installations: outcome.installations,
        observations: outcome.observations,
      };
    }
    case "storage_records_installation_detach": {
      assertOnlyKeys(args, ["id", "expectedGeneration"]);
      const id = requiredString(args, "id");
      const current = (await currentHostInstallationStatus(administration, id)).installations.find(
        (installation) => installation.status === "active",
      );
      if (!current) {
        throw new CapletsError("REQUEST_INVALID", `Caplet ${id} has no active installation.`);
      }
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "stored_caplet_installation_delete",
        id,
        installationKey: current.installationKey,
        expectedGeneration: requiredPositiveInteger(args, "expectedGeneration"),
      });
      return outcome.status === "detached" ? outcome.installation : undefined;
    }
    case "storage_records_installation_observe": {
      assertOnlyKeys(args, [
        "id",
        "expectedGeneration",
        "status",
        "resolvedRevision",
        "contentHash",
        "risk",
      ]);
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "stored_caplet_installation_observe",
        id: requiredString(args, "id"),
        expectedGeneration: requiredPositiveInteger(args, "expectedGeneration"),
        status: requiredInstallationObservationStatus(args, "status"),
        ...optionalProp("resolvedRevision", optionalString(args, "resolvedRevision")),
        ...optionalProp("contentHash", optionalString(args, "contentHash")),
        ...optionalProp("risk", optionalRecord(args, "risk")),
      });
      return outcome.observation;
    }
    case "storage_records_installation_replace": {
      assertOnlyKeys(args, [
        "id",
        "expectedGeneration",
        "sourceKind",
        "sourceIdentity",
        "channel",
        "detachedInstallationKey",
      ]);
      const id = requiredString(args, "id");
      const requestedKey = optionalString(args, "detachedInstallationKey");
      const detached = (await currentHostInstallationStatus(administration, id)).installations.find(
        (installation) =>
          installation.status === "detached" &&
          (requestedKey === undefined || installation.installationKey === requestedKey),
      );
      if (!detached) {
        throw new CapletsError("REQUEST_INVALID", `Caplet ${id} has no detached installation.`);
      }
      const outcome = await administration.operations.execute(administration.principal, {
        kind: "stored_caplet_installation_put",
        id,
        installationKey: detached.installationKey,
        expectedGeneration: requiredPositiveInteger(args, "expectedGeneration"),
        sourceKind: requiredString(args, "sourceKind"),
        sourceIdentity: requiredString(args, "sourceIdentity"),
        ...optionalProp("channel", optionalString(args, "channel")),
      });
      if (outcome.status !== "replaced") {
        throw new CapletsError("REQUEST_INVALID", `Caplet ${id} has no detached installation.`);
      }
      return outcome.installation;
    }
    default:
      throw new CapletsError(
        "UNKNOWN_OPERATION",
        `Unsupported remote control command ${request.command}`,
      );
  }
}

async function currentHostInstallationStatus(
  administration: CurrentHostOperatorAdministration,
  id: string,
) {
  return await administration.operations.execute(administration.principal, {
    kind: "stored_caplet_installation_status",
    id,
  });
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

async function encodeBundleSourcesResult(result: {
  record: unknown;
  sources: ReopenableBundleFileSource[];
}): Promise<{ record: unknown; files: RemoteCapletBundleFile[] }> {
  return {
    record: result.record,
    files: await Promise.all(
      result.sources.map(async (source) => ({
        path: source.path,
        contentBase64: (
          await readVerifiedBundleFile(source, { maxBytes: MAX_BUNDLE_FILE_BYTES })
        ).toString("base64"),
        executable: source.executable,
      })),
    ),
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
