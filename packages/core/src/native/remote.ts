import { CapletsError } from "../errors";
import {
  decodeDirectResourceUri,
  directResourceUriMatchesTemplate,
} from "../exposure/direct-names";
import { generatedToolInputJsonSchemaForCaplet, operations } from "../generated-tool-input-schema";
import type { AttachCodeModeCaplet, AttachManifest, AttachManifestExport } from "../attach/api";
import { CodeModeJournalStore } from "../code-mode/journal";
import { runCodeMode } from "../code-mode/runner";
import { CodeModeSessionManager } from "../code-mode/sessions";
import {
  generateCodeModeDeclarations,
  generateCodeModeRunToolDescription,
} from "../code-mode/declarations";
import {
  codeModeRunInputJsonSchema,
  codeModeRunInputSchema,
  emptyCodeModeRunMeta,
} from "../code-mode/tool";
import type { ResolvedNativeCapletsServiceOptions } from "./options";
import type {
  NativeCapletsService,
  NativeCapletsToolsChangedListener,
  NativeCapletTool,
} from "./service";
import {
  nativeCapletToolName,
  nativeCodeModePromptGuidance,
  nativeCodeModeToolId,
  nativeCodeModeToolName,
} from "./tools";

export type RemoteCapletsTool = {
  name: string;
  capletId?: string | undefined;
  sourceCapletId?: string | undefined;
  shadowing?: "forbid" | "allow" | undefined;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  codeModeRun?: boolean | undefined;
  codeModeCaplets?: AttachCodeModeCaplet[] | undefined;
};

export type RemoteCapletsClient = {
  listTools(): Promise<RemoteCapletsTool[]>;
  callTool(name: string, args: unknown): Promise<unknown>;
  onToolsChanged(listener: () => void): () => void;
  close(): Promise<void>;
};

export type RemoteCapletsClientOptions = ResolvedNativeCapletsServiceOptions & {
  mode: "remote" | "cloud";
};

export type SdkRemoteCapletsClientOptions = RemoteCapletsClientOptions["remote"] & {
  resolveRuntimeOptions?: () => Promise<RemoteCapletsClientOptions["remote"]>;
};

export type RemoteNativeCapletsServiceOptions = {
  client: RemoteCapletsClient;
  clientFactory?: () => RemoteCapletsClient;
  pollIntervalMs: number;
  authKind?: "self_hosted_remote" | "hosted_cloud";
  writeErr?: (value: string) => void;
};

export function createSdkRemoteCapletsClient(
  options: SdkRemoteCapletsClientOptions,
): RemoteCapletsClient {
  const listeners = new Set<() => void>();
  let manifest: AttachManifest | undefined;
  let exportByName = new Map<string, AttachManifestExport>();
  let eventsAbort: AbortController | undefined;
  let eventsStartInFlight: Promise<void> | undefined;
  let eventsReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const resolveRuntimeOptions = async (): Promise<RemoteCapletsClientOptions["remote"]> => {
    return options.resolveRuntimeOptions ? await options.resolveRuntimeOptions() : options;
  };

  const fetchFor = (runtimeOptions: RemoteCapletsClientOptions["remote"]): typeof fetch =>
    runtimeOptions.fetch ?? fetch;

  const fetchCurrentManifest = async (): Promise<AttachManifest> => {
    const runtimeOptions = await resolveRuntimeOptions();
    return await fetchAttachManifest(
      runtimeOptions.url,
      runtimeOptions.requestInit,
      fetchFor(runtimeOptions),
    );
  };

  const invokeCurrentExport = async (body: {
    revision: string;
    kind: string;
    exportId: string;
    input: unknown;
  }): Promise<unknown> => {
    const runtimeOptions = await resolveRuntimeOptions();
    return await invokeAttachExport(
      runtimeOptions.url,
      runtimeOptions.requestInit,
      fetchFor(runtimeOptions),
      body,
    );
  };

  const clearEventsReconnectTimer = () => {
    if (eventsReconnectTimer) {
      clearTimeout(eventsReconnectTimer);
      eventsReconnectTimer = undefined;
    }
  };

  const scheduleEventsReconnect = () => {
    if (closed || listeners.size === 0) return;
    clearEventsReconnectTimer();
    eventsReconnectTimer = setTimeout(() => {
      eventsReconnectTimer = undefined;
      startEvents();
    }, 1_000);
  };

  const startEventsNow = async () => {
    try {
      const runtimeOptions = await resolveRuntimeOptions();
      if (closed || eventsAbort || listeners.size === 0) return;
      eventsAbort = startAttachEvents(
        runtimeOptions.url,
        runtimeOptions.requestInit,
        fetchFor(runtimeOptions),
        listeners,
        (closedAbort, retry) => {
          if (eventsAbort !== closedAbort) return;
          eventsAbort = undefined;
          if (!retry || closedAbort.signal.aborted || listeners.size === 0) return;
          scheduleEventsReconnect();
        },
      );
    } catch {
      scheduleEventsReconnect();
    }
  };

  const startEvents = () => {
    if (closed || eventsAbort || eventsStartInFlight || listeners.size === 0) return;
    const start = startEventsNow();
    eventsStartInFlight = start;
    void start.finally(() => {
      if (eventsStartInFlight === start) {
        eventsStartInFlight = undefined;
      }
    });
  };

  return {
    async listTools() {
      manifest = await fetchCurrentManifest();
      exportByName = exportMapFor(manifest);
      return toolsFromManifest(manifest);
    },
    async callTool(name, args) {
      if (!manifest) {
        manifest = await fetchCurrentManifest();
        exportByName = exportMapFor(manifest);
      }
      const invokeWithStaleRetry = async (
        entry: AttachManifestExport,
        input: unknown,
      ): Promise<unknown> => {
        try {
          return await invokeCurrentExport({
            revision: manifest!.revision,
            kind: entry.kind,
            exportId: entry.exportId,
            input,
          });
        } catch (error) {
          if (!isAttachManifestStale(error)) throw error;
          const nextManifest = await fetchCurrentManifest();
          const nextEntry = compatibleExport(nextManifest, entry);
          manifest = nextManifest;
          exportByName = exportMapFor(nextManifest);
          if (!nextEntry) {
            throw new CapletsError(
              "ATTACH_EXPORT_NOT_FOUND",
              "Attach export changed after manifest refresh; refetch the manifest before retrying.",
            );
          }
          return await invokeCurrentExport({
            revision: nextManifest.revision,
            kind: nextEntry.kind,
            exportId: nextEntry.exportId,
            input,
          });
        }
      };
      const directTool = manifest.tools.find((entry) => entry.name === name);
      if (directTool) return await invokeWithStaleRetry(directTool, args ?? {});
      const primitive = await callPrimitiveExport(manifest, name, args, invokeWithStaleRetry);
      if (primitive.handled) return primitive.result;
      const entry = exportByName.get(name);
      if (!entry) {
        throw new CapletsError("ATTACH_EXPORT_NOT_FOUND", `Attach export ${name} was not found.`);
      }
      return await invokeWithStaleRetry(entry, args ?? {});
    },
    onToolsChanged(listener) {
      listeners.add(listener);
      startEvents();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          clearEventsReconnectTimer();
          eventsAbort?.abort();
          eventsAbort = undefined;
        }
      };
    },
    async close() {
      closed = true;
      clearEventsReconnectTimer();
      eventsAbort?.abort();
      eventsAbort = undefined;
      listeners.clear();
    },
  };
}

export class RemoteNativeCapletsService implements NativeCapletsService {
  private tools: NativeCapletTool[] = [];
  private toolRoutes = new Map<string, string>();
  private readonly listeners = new Set<NativeCapletsToolsChangedListener>();
  private readonly clientFactory: () => RemoteCapletsClient;
  private client: RemoteCapletsClient;
  private unsubscribeRemote: () => void;
  private readonly pollTimer: ReturnType<typeof setInterval>;
  private readonly codeModeSessions = new CodeModeSessionManager();
  private closed = false;
  private resetInFlight: Promise<boolean> | undefined;

  constructor(private readonly options: RemoteNativeCapletsServiceOptions) {
    this.client = options.client;
    this.clientFactory = options.clientFactory ?? (() => options.client);
    this.unsubscribeRemote = this.subscribeRemote(this.client);
    this.pollTimer = setInterval(() => {
      void this.reload();
    }, options.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  listTools(): NativeCapletTool[] {
    return [...this.tools];
  }

  async execute(capletId: string, request: unknown): Promise<unknown> {
    if (capletId === nativeCodeModeToolId) {
      return await executeCodeModeRunRemote(this, request, this.codeModeSessions);
    }
    const remoteToolId = this.toolRoutes.get(capletId) ?? capletId;
    try {
      return await this.client.callTool(remoteToolId, request);
    } catch (error) {
      if (isAuthFailure(error)) {
        throw remoteAuthError(this.options.authKind ?? "self_hosted_remote");
      }
      if (isSessionFailure(error)) {
        if (!(await this.resetClient()) || this.closed) {
          throw error;
        }
        try {
          return await this.client.callTool(remoteToolId, request);
        } catch (retryError) {
          if (isAuthFailure(retryError)) {
            throw remoteAuthError(this.options.authKind ?? "self_hosted_remote");
          }
          throw retryError;
        }
      }
      throw error;
    }
  }

  codeModeService(): NativeCapletsService {
    return {
      listTools: () => remoteCodeModeCallableNativeTools(this.listTools()),
      execute: async (capletId, request) => await this.execute(capletId, request),
      codeModeService: () => this.codeModeService(),
      reload: async () => await this.reload(),
      onToolsChanged: () => () => undefined,
      close: async () => undefined,
    };
  }

  async reload(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    try {
      await this.reloadFromClient();
      return true;
    } catch (error) {
      if (isSessionFailure(error)) {
        try {
          if (!(await this.resetClient()) || this.closed) {
            return false;
          }
          await this.reloadFromClient();
          return !this.closed;
        } catch (retryError) {
          this.warn(`Could not reload remote Caplets tools: ${errorMessage(retryError)}\n`);
          return false;
        }
      }
      this.warn(`Could not reload remote Caplets tools: ${errorMessage(error)}\n`);
      return false;
    }
  }

  onToolsChanged(listener: NativeCapletsToolsChangedListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.pollTimer);
    this.codeModeSessions.close();
    this.unsubscribeRemote();
    this.listeners.clear();
    await this.client.close();
  }

  private async reloadFromClient(): Promise<void> {
    const remoteTools = await this.client.listTools();
    const tools = remoteTools.map(remoteToolToNativeTool);
    const changed = JSON.stringify(tools) !== JSON.stringify(this.tools);
    this.tools = tools;
    this.toolRoutes = new Map(remoteTools.map((tool) => [nativeToolRouteId(tool), tool.name]));
    if (changed) {
      this.emitToolsChanged();
    }
  }

  private subscribeRemote(client: RemoteCapletsClient): () => void {
    return client.onToolsChanged(() => {
      void this.reload();
    });
  }

  private async resetClient(): Promise<boolean> {
    if (this.resetInFlight) {
      return await this.resetInFlight;
    }
    this.resetInFlight = this.doResetClient();
    try {
      return await this.resetInFlight;
    } finally {
      this.resetInFlight = undefined;
    }
  }

  private async doResetClient(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    this.unsubscribeRemote();
    await this.client.close().catch(() => undefined);
    if (this.closed) {
      return false;
    }
    const nextClient = this.clientFactory();
    if (this.closed) {
      await nextClient.close().catch(() => undefined);
      return false;
    }
    this.client = nextClient;
    this.unsubscribeRemote = this.subscribeRemote(this.client);
    return true;
  }

  private emitToolsChanged(): void {
    const tools = this.listTools();
    for (const listener of this.listeners) {
      listener(tools);
    }
  }

  private warn(message: string): void {
    this.options.writeErr?.(message);
  }
}

function remoteToolToNativeTool(tool: RemoteCapletsTool): NativeCapletTool {
  const capletId = nativeToolRouteId(tool);
  const sourceCaplet = tool.sourceCapletId ?? tool.capletId;
  const toolName = tool.codeModeRun ? nativeCodeModeToolName : nativeCapletToolName(capletId);
  const inputSchema = isPlainObject(tool.inputSchema)
    ? tool.inputSchema
    : generatedToolInputJsonSchemaForCaplet({ backend: "tool" });
  const operationNames =
    tool.sourceCapletId === undefined && !tool.codeModeRun
      ? operationNamesFromSchema(inputSchema)
      : undefined;
  const description = tool.codeModeRun ? remoteCodeModeToolDescription(tool) : tool.description;
  return {
    caplet: capletId,
    ...(sourceCaplet && sourceCaplet !== capletId ? { sourceCaplet } : {}),
    ...(tool.shadowing ? { shadowing: tool.shadowing } : {}),
    toolName,
    title: tool.title ?? capletId,
    description: [
      description ?? "Remote Caplets tool.",
      "",
      `Native tool name: ${toolName}`,
      `Remote Caplet ID: ${capletId}`,
    ].join("\n"),
    promptGuidance: tool.codeModeRun
      ? nativeCodeModePromptGuidance()
      : [`Use ${toolName} through the remote Caplets service.`],
    ...(tool.codeModeRun || capletId === nativeCodeModeToolId ? { codeModeRun: true } : {}),
    ...(tool.codeModeCaplets
      ? {
          codeModeCaplets: tool.codeModeCaplets.map((caplet) => ({
            id: caplet.capletId,
            name: caplet.name,
            description: caplet.description ?? "",
            shadowing: caplet.shadowing,
          })),
        }
      : {}),
    inputSchema,
    ...(isPlainObject(tool.outputSchema) ? { outputSchema: tool.outputSchema } : {}),
    ...(isPlainObject(tool.annotations) ? { annotations: tool.annotations } : {}),
    ...(operationNames ? { operationNames } : {}),
  };
}

function remoteCodeModeToolDescription(tool: RemoteCapletsTool): string | undefined {
  if (!tool.codeModeCaplets || tool.codeModeCaplets.length === 0) return tool.description;
  const declaration = generateCodeModeDeclarations({
    caplets: tool.codeModeCaplets.map((caplet) => ({
      id: caplet.capletId,
      name: caplet.name,
      description: caplet.description ?? "",
      shadowing: caplet.shadowing,
    })),
  });
  return generateCodeModeRunToolDescription(declaration);
}

function remoteCodeModeCallableNativeTools(tools: NativeCapletTool[]): NativeCapletTool[] {
  const codeModeCaplets = tools.flatMap((tool) => tool.codeModeCaplets ?? []);
  const hasExplicitCodeModeManifest = tools.some((tool) => tool.codeModeCaplets !== undefined);
  if (codeModeCaplets.length === 0) {
    return hasExplicitCodeModeManifest ? [] : tools.filter((tool) => tool.codeModeRun !== true);
  }
  const byId = new Map(tools.map((tool) => [tool.caplet, tool]));
  return codeModeCaplets.map((caplet) => {
    const tool = byId.get(caplet.id);
    return {
      caplet: caplet.id,
      toolName: tool?.toolName ?? nativeCapletToolName(caplet.id),
      title: caplet.name,
      description: caplet.description,
      ...(caplet.shadowing ? { shadowing: caplet.shadowing } : {}),
      ...(caplet.useWhen ? { useWhen: caplet.useWhen } : {}),
      ...(caplet.avoidWhen ? { avoidWhen: caplet.avoidWhen } : {}),
      promptGuidance: tool?.promptGuidance ?? [],
    };
  });
}

function nativeToolRouteId(tool: RemoteCapletsTool): string {
  return tool.codeModeRun ? nativeCodeModeToolId : tool.name;
}

async function fetchAttachManifest(
  attachUrl: URL,
  requestInit: RequestInit | undefined,
  fetchImpl: typeof fetch,
): Promise<AttachManifest> {
  const response = await fetchImpl(new URL("manifest", slashUrl(attachUrl)), {
    ...requestInit,
    method: "GET",
  });
  if (!response.ok) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      `Caplets attach manifest returned HTTP ${response.status}.`,
    );
  }
  return (await response.json()) as AttachManifest;
}

async function invokeAttachExport(
  attachUrl: URL,
  requestInit: RequestInit | undefined,
  fetchImpl: typeof fetch,
  body: { revision: string; kind: string; exportId: string; input: unknown },
): Promise<unknown> {
  const headers = new Headers(requestInit?.headers);
  headers.set("content-type", "application/json");
  const response = await fetchImpl(new URL("invoke", slashUrl(attachUrl)), {
    ...requestInit,
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let payload: unknown;
  try {
    payload = (await response.json()) as unknown;
  } catch (error) {
    if (!response.ok) {
      throw attachPayloadError(
        { error: { message: `Caplets attach invoke returned HTTP ${response.status}.` } },
        response.status,
      );
    }
    throw error;
  }
  if (!response.ok) {
    throw attachPayloadError(payload, response.status);
  }
  if (isPlainObject(payload) && payload.ok === true && "data" in payload) {
    return payload.data;
  }
  return payload;
}

async function callPrimitiveExport(
  manifest: AttachManifest,
  name: string,
  args: unknown,
  invoke: (entry: AttachManifestExport, input: unknown) => Promise<unknown>,
): Promise<{ handled: false } | { handled: true; result: unknown }> {
  const primitive = primitiveRoute(name);
  if (!primitive) return { handled: false };
  const input = isPlainObject(args) ? args : {};
  const { capletId, operation } = primitive;
  if (operation === "list_resources") {
    const resources = manifest.resources.filter((entry) => entry.capletId === capletId);
    if (resources.length === 0) return { handled: false };
    return {
      handled: true,
      result: {
        items: resources.map((entry) => ({
          uri: entry.uri,
          name: entry.title,
          description: entry.description,
          ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
          ...(typeof entry.size === "number" ? { size: entry.size } : {}),
        })),
      },
    };
  }
  if (operation === "list_resource_templates") {
    const resourceTemplates = manifest.resourceTemplates.filter(
      (entry) => entry.capletId === capletId,
    );
    if (resourceTemplates.length === 0) return { handled: false };
    return {
      handled: true,
      result: {
        items: resourceTemplates.map((entry) => ({
          uriTemplate: entry.uriTemplate,
          name: entry.title,
          description: entry.description,
          ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
        })),
      },
    };
  }
  if (operation === "list_prompts") {
    const prompts = manifest.prompts.filter((entry) => entry.capletId === capletId);
    if (prompts.length === 0) return { handled: false };
    return {
      handled: true,
      result: {
        items: prompts.map((entry) => ({
          name: entry.name,
          title: entry.title,
          description: entry.description,
          ...promptArguments(entry.inputSchema),
        })),
      },
    };
  }

  const entry = primitiveExport(manifest, capletId, operation, input);
  if (!entry) return { handled: false };
  return {
    handled: true,
    result: await invoke(entry, primitiveInvokeInput(capletId, operation, input)),
  };
}

function primitiveRoute(name: string): { capletId: string; operation: string } | undefined {
  for (const operation of [
    "list_resource_templates",
    "list_resources",
    "read_resource",
    "list_prompts",
    "get_prompt",
    "complete",
  ]) {
    const suffix = `__${operation}`;
    if (name.endsWith(suffix)) return { capletId: name.slice(0, -suffix.length), operation };
  }
  return undefined;
}

function primitiveExport(
  manifest: AttachManifest,
  capletId: string,
  operation: string,
  input: Record<string, unknown>,
): AttachManifestExport | undefined {
  if (operation === "read_resource") {
    const uri = typeof input.uri === "string" ? input.uri : "";
    const resource = manifest.resources.find(
      (entry) => entry.capletId === capletId && (entry.uri === uri || entry.downstreamUri === uri),
    );
    if (resource) return resource;

    const downstreamUri = downstreamResourceUri(capletId, uri);
    return manifest.resourceTemplates.find(
      (entry) =>
        entry.capletId === capletId &&
        directResourceUriMatchesTemplate(downstreamUri, entry.downstreamUriTemplate),
    );
  }
  if (operation === "get_prompt") {
    const name = typeof input.name === "string" ? input.name : "";
    return manifest.prompts.find(
      (entry) =>
        entry.capletId === capletId && (entry.name === name || entry.downstreamName === name),
    );
  }
  if (operation === "complete") {
    return manifest.completions.find((entry) => entry.capletId === capletId);
  }
  return undefined;
}

function primitiveInvokeInput(
  capletId: string,
  operation: string,
  input: Record<string, unknown>,
): unknown {
  if (operation === "read_resource") {
    const uri = typeof input.uri === "string" ? input.uri : "";
    return { ...input, uri: downstreamResourceUri(capletId, uri) };
  }
  if (operation === "get_prompt") return input.args ?? {};
  return input;
}

function toolsFromManifest(manifest: AttachManifest): RemoteCapletsTool[] {
  const codeModeCaplets = manifest.codeModeCaplets ?? [];
  const codeModeMarker = attachCodeModeMarker(codeModeCaplets);
  const codeModeShadowing: "forbid" | "allow" = codeModeCaplets.some(
    (entry) => entry.shadowing === "forbid",
  )
    ? "forbid"
    : "allow";
  return [
    ...manifest.caplets.map((entry) => ({
      name: entry.capletId,
      capletId: entry.capletId,
      title: entry.title ?? entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
      shadowing: entry.shadowing,
      ...codeModeMarker,
    })),
    ...manifest.tools.map((entry) => ({
      name: entry.name,
      capletId: entry.capletId,
      sourceCapletId: entry.capletId,
      title: entry.title ?? entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
      outputSchema: entry.outputSchema,
      annotations: entry.annotations,
      shadowing: entry.shadowing,
      ...codeModeMarker,
    })),
    ...primitiveToolsFromManifest(manifest, codeModeMarker),
    ...(codeModeCaplets.length > 0
      ? [
          {
            name: nativeCodeModeToolId,
            capletId: nativeCodeModeToolId,
            title: "Code Mode",
            description: "Remote Caplets available to locally-run attached Code Mode.",
            codeModeRun: true,
            codeModeCaplets,
            shadowing: codeModeShadowing,
            inputSchema: codeModeRunInputJsonSchema(),
          },
        ]
      : []),
  ];
}

function attachCodeModeMarker(
  codeModeCaplets: AttachCodeModeCaplet[] = [],
): Pick<RemoteCapletsTool, "codeModeCaplets"> | Record<string, never> {
  return codeModeCaplets.length === 0 ? { codeModeCaplets: [] } : {};
}

function primitiveToolsFromManifest(
  manifest: AttachManifest,
  codeModeMarker: Pick<RemoteCapletsTool, "codeModeCaplets"> | Record<string, never>,
): RemoteCapletsTool[] {
  const directToolNames = new Set(manifest.tools.map((entry) => entry.name));
  const byCaplet = new Map<
    string,
    {
      resources: boolean;
      resourceTemplates: boolean;
      prompts: boolean;
      completions: boolean;
      shadowing: "forbid" | "allow";
    }
  >();
  const entryFor = (capletId: string, shadowing: "forbid" | "allow") => {
    const existing = byCaplet.get(capletId);
    if (existing) {
      if (shadowing === "forbid") existing.shadowing = "forbid";
      return existing;
    }
    const next = {
      resources: false,
      resourceTemplates: false,
      prompts: false,
      completions: false,
      shadowing,
    };
    byCaplet.set(capletId, next);
    return next;
  };
  for (const entry of manifest.resources)
    entryFor(entry.capletId, entry.shadowing).resources = true;
  for (const entry of manifest.resourceTemplates)
    entryFor(entry.capletId, entry.shadowing).resourceTemplates = true;
  for (const entry of manifest.prompts) entryFor(entry.capletId, entry.shadowing).prompts = true;
  for (const entry of manifest.completions)
    entryFor(entry.capletId, entry.shadowing).completions = true;

  const tools: RemoteCapletsTool[] = [];
  const addPrimitiveTool = (capletId: string, operation: string, shadowing: "forbid" | "allow") => {
    const name = `${capletId}__${operation}`;
    if (directToolNames.has(name)) return;
    tools.push(primitiveTool(capletId, operation, shadowing, codeModeMarker));
  };
  for (const [capletId, flags] of byCaplet) {
    if (flags.resources) {
      addPrimitiveTool(capletId, "list_resources", flags.shadowing);
      addPrimitiveTool(capletId, "read_resource", flags.shadowing);
    }
    if (flags.resourceTemplates) {
      addPrimitiveTool(capletId, "list_resource_templates", flags.shadowing);
      addPrimitiveTool(capletId, "read_resource", flags.shadowing);
    }
    if (flags.prompts) {
      addPrimitiveTool(capletId, "list_prompts", flags.shadowing);
      addPrimitiveTool(capletId, "get_prompt", flags.shadowing);
    }
    if (flags.completions) {
      addPrimitiveTool(capletId, "complete", flags.shadowing);
    }
  }
  return [...new Map(tools.map((tool) => [tool.name, tool])).values()];
}

function primitiveTool(
  capletId: string,
  operation: string,
  shadowing: "forbid" | "allow",
  codeModeMarker: Pick<RemoteCapletsTool, "codeModeCaplets"> | Record<string, never>,
): RemoteCapletsTool {
  return {
    name: `${capletId}__${operation}`,
    capletId,
    sourceCapletId: capletId,
    title: operation,
    description: `MCP ${operation.replace(/_/g, " ")}.`,
    inputSchema: primitiveInputSchema(operation),
    shadowing,
    ...codeModeMarker,
  };
}

function primitiveInputSchema(operation: string): Record<string, unknown> {
  if (operation === "read_resource") {
    return {
      type: "object",
      properties: { uri: { type: "string" } },
      required: ["uri"],
      additionalProperties: false,
    };
  }
  if (operation === "get_prompt") {
    return {
      type: "object",
      properties: {
        name: { type: "string" },
        args: { type: "object", additionalProperties: true },
      },
      required: ["name"],
      additionalProperties: false,
    };
  }
  if (operation === "complete") {
    return {
      type: "object",
      properties: {
        ref: { type: "object", additionalProperties: true },
        argument: { type: "object", additionalProperties: true },
      },
      required: ["ref", "argument"],
      additionalProperties: false,
    };
  }
  return { type: "object", additionalProperties: false };
}

function exportMapFor(manifest: AttachManifest): Map<string, AttachManifestExport> {
  const mapped = new Map<string, AttachManifestExport>();
  const setIfAbsent = (key: string, entry: AttachManifestExport) => {
    if (!mapped.has(key)) mapped.set(key, entry);
  };
  for (const entry of manifest.caplets) {
    mapped.set(entry.capletId, entry);
    mapped.set(entry.name, entry);
  }
  for (const entry of manifest.tools) {
    mapped.set(entry.name, entry);
  }
  for (const entry of manifest.codeModeCaplets ?? []) {
    setIfAbsent(entry.capletId, entry);
    setIfAbsent(entry.name, entry);
  }
  return mapped;
}

function slashUrl(url: URL): URL {
  const next = new URL(url);
  next.pathname = next.pathname.endsWith("/") ? next.pathname : `${next.pathname}/`;
  return next;
}

function attachPayloadError(payload: unknown, status: number): Error {
  const error = isPlainObject(payload) && isPlainObject(payload.error) ? payload.error : undefined;
  const message =
    typeof error?.message === "string"
      ? error.message
      : `Caplets attach invoke returned HTTP ${status}.`;
  const thrown = new Error(message) as Error & { status?: number; code?: unknown };
  thrown.status = status;
  if (error && "code" in error) thrown.code = error.code;
  return thrown;
}

function isAttachManifestStale(error: unknown): boolean {
  return isPlainObject(error) && error.code === "ATTACH_MANIFEST_STALE";
}

function startAttachEvents(
  attachUrl: URL,
  requestInit: RequestInit | undefined,
  fetchImpl: typeof fetch,
  listeners: Set<() => void>,
  onClose: (abort: AbortController, retry: boolean) => void,
): AbortController {
  const abort = new AbortController();
  let retry = true;
  void (async () => {
    try {
      const response = await fetchImpl(new URL("events", slashUrl(attachUrl)), {
        ...requestInit,
        method: "GET",
        signal: abort.signal,
      });
      if (!response.ok) {
        retry = false;
        return;
      }
      if (!response.body) {
        retry = false;
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!abort.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          if (!event.includes("event: manifest_changed")) continue;
          for (const listener of listeners) listener();
        }
      }
    } catch {
      // Polling remains the fallback when the event stream is unavailable.
    } finally {
      onClose(abort, retry);
    }
  })();
  return abort;
}

async function executeCodeModeRunRemote(
  service: NativeCapletsService,
  request: unknown,
  sessionManager?: CodeModeSessionManager,
): Promise<unknown> {
  const parsed = codeModeRunInputSchema.safeParse(request);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "REQUEST_INVALID",
        message: "Code Mode run input is invalid.",
        details: parsed.error.issues,
      },
      diagnostics: [],
      logs: { entries: [], truncated: false, stored: false },
      meta: emptyCodeModeRunMeta(),
    };
  }
  return await runCodeMode({
    code: parsed.data.code,
    service,
    ...(parsed.data.timeoutMs === undefined ? {} : { timeoutMs: parsed.data.timeoutMs }),
    ...(parsed.data.sessionId === undefined ? {} : { sessionId: parsed.data.sessionId }),
    runtimeScope: process.env.CAPLETS_MODE?.trim() || "remote",
    journalStore: new CodeModeJournalStore(),
    ...(sessionManager === undefined ? {} : { sessionManager }),
  });
}

function compatibleExport(
  manifest: AttachManifest,
  previous: AttachManifestExport,
): AttachManifestExport | undefined {
  const next = [
    ...manifest.caplets,
    ...manifest.tools,
    ...manifest.resources,
    ...manifest.resourceTemplates,
    ...manifest.prompts,
    ...manifest.completions,
    ...(manifest.codeModeCaplets ?? []),
  ].find((entry) => entry.stableId === previous.stableId);
  if (!next) return undefined;
  if (next.kind !== previous.kind) return undefined;
  if (next.schemaHash !== previous.schemaHash) return undefined;
  return next;
}

function promptArguments(inputSchema: unknown): { arguments: unknown[] } | Record<string, never> {
  if (!isPlainObject(inputSchema) || !Array.isArray(inputSchema.arguments)) return {};
  return { arguments: inputSchema.arguments };
}

function downstreamResourceUri(capletId: string, uri: string): string {
  if (!uri.startsWith("caplets://")) return uri;
  const decoded = decodeDirectResourceUri(uri);
  if (decoded.capletId !== capletId) {
    throw new CapletsError(
      "ATTACH_EXPORT_NOT_FOUND",
      "Attach resource URI belongs to a different Caplet.",
    );
  }
  return decoded.downstreamUri;
}

function operationNamesFromSchema(schema: Record<string, unknown>): string[] {
  const properties = schema.properties;
  if (!isPlainObject(properties)) return [...operations];
  const operation = properties.operation;
  if (!isPlainObject(operation) || !Array.isArray(operation.enum)) return [...operations];
  return operation.enum.filter((value): value is string => typeof value === "string");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function remoteAuthError(kind: "self_hosted_remote" | "hosted_cloud"): CapletsError {
  return new CapletsError(
    "AUTH_FAILED",
    kind === "hosted_cloud"
      ? "Caplets Cloud authentication failed; run caplets remote login <cloud-url>."
      : "Remote Caplets authentication failed; run caplets remote login <url>.",
  );
}

function isSessionFailure(error: unknown): boolean {
  const candidate = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  if (candidate.status === 408 || candidate.statusCode === 408) return true;
  if (
    typeof candidate.code === "string" &&
    /^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|SESSION_EXPIRED|SESSION_CLOSED|TRANSPORT_CLOSED)$/u.test(
      candidate.code,
    )
  ) {
    return true;
  }
  const message = errorMessage(error).toLowerCase();
  return /\b(invalid session|session (closed|expired|not found)|transport (connection )?closed|connection closed|closed connection|server unavailable|connection reset|econnreset|econnrefused)\b/u.test(
    message,
  );
}

function isAuthFailure(error: unknown): boolean {
  const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  const status = typeof candidate?.status === "number" ? candidate.status : undefined;
  const statusCode = typeof candidate?.statusCode === "number" ? candidate.statusCode : undefined;
  const code = typeof candidate?.code === "number" ? candidate.code : undefined;
  if (
    status === 401 ||
    status === 403 ||
    statusCode === 401 ||
    statusCode === 403 ||
    code === 401 ||
    code === 403
  ) {
    return true;
  }
  return /\b(401|403|unauthorized|forbidden)\b/iu.test(errorMessage(error));
}
