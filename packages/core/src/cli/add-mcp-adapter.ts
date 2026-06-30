import {
  agents,
  detectGlobalAgents as detectGlobalAddMcpAgents,
  detectProjectAgents as detectProjectAddMcpAgents,
  getAgentTypes,
  upsertServer,
  type AgentType,
  type InstallResult,
  type OptionalField,
} from "add-mcp";
import { CapletsError } from "../errors";

export type AddMcpClientId = AgentType;

export type AddMcpClient = {
  id: AddMcpClientId;
  displayName: string;
  configPath: string;
  projectConfigPath?: string;
  supportsStdio: boolean;
};

export type AddMcpDetectionOptions = {
  cwd?: string;
  global?: boolean;
};

export type UpsertCapletsMcpServerOptions = {
  clientId: string;
  daemonBaseUrl: string;
  cwd?: string;
  local?: boolean;
};

export type UpsertCapletsMcpServerResult = {
  clientId: AddMcpClientId;
  success: boolean;
  path: string;
  error?: string;
  droppedFields?: OptionalField[];
  extraPaths?: string[];
};

export function listSupportedAddMcpClients(): AddMcpClient[] {
  return getAgentTypes().map(addMcpClientForId);
}

export async function detectAddMcpClients(
  options: AddMcpDetectionOptions = {},
): Promise<AddMcpClient[]> {
  const detected = options.global
    ? await detectGlobalAddMcpAgents()
    : detectProjectAddMcpAgents(options.cwd);
  const detectedIds = new Set(detected);
  return listSupportedAddMcpClients().filter((client) => detectedIds.has(client.id));
}

export async function upsertCapletsMcpServer(
  options: UpsertCapletsMcpServerOptions,
): Promise<UpsertCapletsMcpServerResult> {
  const clientId = parseAddMcpClientId(options.clientId);
  const result = upsertServer(
    clientId,
    "caplets",
    {
      command: "caplets",
      args: ["attach", options.daemonBaseUrl],
    },
    {
      local: options.local ?? true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    },
  );
  return addMcpResult(clientId, result);
}

export function parseAddMcpClientId(value: string): AddMcpClientId {
  if ((getAgentTypes() as string[]).includes(value)) {
    return value as AddMcpClientId;
  }
  throw new CapletsError(
    "REQUEST_INVALID",
    `MCP client must be one of: ${getAgentTypes().join(", ")}`,
  );
}

function addMcpClientForId(id: AddMcpClientId): AddMcpClient {
  const agent = agents[id];
  return {
    id,
    displayName: agent.displayName,
    configPath: agent.configPath,
    ...(agent.localConfigPath ? { projectConfigPath: agent.localConfigPath } : {}),
    supportsStdio: agent.supportedTransports.includes("stdio"),
  };
}

function addMcpResult(
  clientId: AddMcpClientId,
  result: InstallResult,
): UpsertCapletsMcpServerResult {
  return {
    clientId,
    success: result.success,
    path: result.path,
    ...(result.error ? { error: result.error } : {}),
    ...(result.droppedFields?.length ? { droppedFields: result.droppedFields } : {}),
    ...(result.extraPaths?.length ? { extraPaths: result.extraPaths } : {}),
  };
}
