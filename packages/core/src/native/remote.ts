import { CapletsError } from "../errors";
import { generatedToolInputJsonSchemaForCaplet, operations } from "../generated-tool-input-schema";
import type { AttachCodeModeCaplet, AttachManifest, AttachManifestExport } from "../attach/api";
import type { ResolvedNativeCapletsServiceOptions } from "./options";
import type {
  NativeCapletsService,
  NativeCapletsToolsChangedListener,
  NativeCapletTool,
} from "./service";
import { nativeCapletToolName, nativeCodeModeToolId, nativeCodeModeToolName } from "./tools";

export type RemoteCapletsTool = {
  name: string;
  capletId?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema?: unknown;
  outputSchema?: unknown;
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

export type RemoteNativeCapletsServiceOptions = {
  client: RemoteCapletsClient;
  clientFactory?: () => RemoteCapletsClient;
  pollIntervalMs: number;
  authKind?: "self_hosted_remote" | "hosted_cloud";
  writeErr?: (value: string) => void;
};

export function createSdkRemoteCapletsClient(
  options: RemoteCapletsClientOptions["remote"],
): RemoteCapletsClient {
  const fetchImpl = options.fetch ?? fetch;
  const listeners = new Set<() => void>();
  let manifest: AttachManifest | undefined;
  let exportByName = new Map<string, AttachManifestExport>();

  return {
    async listTools() {
      manifest = await fetchAttachManifest(options.url, options.requestInit, fetchImpl);
      exportByName = exportMapFor(manifest);
      return toolsFromManifest(manifest);
    },
    async callTool(name, args) {
      if (!manifest) {
        manifest = await fetchAttachManifest(options.url, options.requestInit, fetchImpl);
        exportByName = exportMapFor(manifest);
      }
      const entry = exportByName.get(name);
      if (!entry) {
        throw new CapletsError("ATTACH_EXPORT_NOT_FOUND", `Attach export ${name} was not found.`);
      }
      try {
        return await invokeAttachExport(options.url, options.requestInit, fetchImpl, {
          revision: manifest.revision,
          kind: entry.kind,
          exportId: entry.exportId,
          input: args ?? {},
        });
      } catch (error) {
        if (!isAttachManifestStale(error)) throw error;
        const nextManifest = await fetchAttachManifest(options.url, options.requestInit, fetchImpl);
        const nextEntry = compatibleExport(nextManifest, entry);
        manifest = nextManifest;
        exportByName = exportMapFor(nextManifest);
        if (!nextEntry) throw error;
        return await invokeAttachExport(options.url, options.requestInit, fetchImpl, {
          revision: nextManifest.revision,
          kind: nextEntry.kind,
          exportId: nextEntry.exportId,
          input: args ?? {},
        });
      }
    },
    onToolsChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      listeners.clear();
    },
  };
}

export class RemoteNativeCapletsService implements NativeCapletsService {
  private tools: NativeCapletTool[] = [];
  private readonly listeners = new Set<NativeCapletsToolsChangedListener>();
  private readonly clientFactory: () => RemoteCapletsClient;
  private client: RemoteCapletsClient;
  private unsubscribeRemote: () => void;
  private readonly pollTimer: ReturnType<typeof setInterval>;
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
    try {
      return await this.client.callTool(capletId, request);
    } catch (error) {
      if (isAuthFailure(error)) {
        throw remoteAuthError(this.options.authKind ?? "self_hosted_remote");
      }
      if (isSessionFailure(error)) {
        if (!(await this.resetClient()) || this.closed) {
          throw error;
        }
        try {
          return await this.client.callTool(capletId, request);
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
    this.unsubscribeRemote();
    this.listeners.clear();
    await this.client.close();
  }

  private async reloadFromClient(): Promise<void> {
    const tools = (await this.client.listTools()).map(remoteToolToNativeTool);
    const changed = JSON.stringify(tools) !== JSON.stringify(this.tools);
    this.tools = tools;
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
  const capletId = tool.capletId ?? tool.name;
  const toolName = tool.codeModeRun ? nativeCodeModeToolName : nativeCapletToolName(capletId);
  const inputSchema = isPlainObject(tool.inputSchema)
    ? tool.inputSchema
    : generatedToolInputJsonSchemaForCaplet({ backend: "tool" });
  return {
    caplet: capletId,
    toolName,
    title: tool.title ?? capletId,
    description: [
      tool.description ?? "Remote Caplets tool.",
      "",
      `Native tool name: ${toolName}`,
      `Remote Caplet ID: ${capletId}`,
    ].join("\n"),
    promptGuidance: [`Use ${toolName} through the remote Caplets service.`],
    ...(tool.codeModeRun || capletId === nativeCodeModeToolId ? { codeModeRun: true } : {}),
    ...(tool.codeModeCaplets
      ? {
          codeModeCaplets: tool.codeModeCaplets.map((caplet) => ({
            id: caplet.capletId,
            name: caplet.name,
            description: caplet.description ?? "",
          })),
        }
      : {}),
    inputSchema,
    ...(isPlainObject(tool.outputSchema) ? { outputSchema: tool.outputSchema } : {}),
    operationNames: operationNamesFromSchema(inputSchema),
  };
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
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    throw attachPayloadError(payload, response.status);
  }
  if (isPlainObject(payload) && payload.ok === true && "data" in payload) {
    return payload.data;
  }
  return payload;
}

function toolsFromManifest(manifest: AttachManifest): RemoteCapletsTool[] {
  return [
    ...manifest.caplets.map((entry) => ({
      name: entry.capletId,
      capletId: entry.capletId,
      title: entry.title ?? entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
    })),
    ...manifest.tools.map((entry) => ({
      name: entry.name,
      capletId: entry.name,
      title: entry.title ?? entry.name,
      description: entry.description,
      inputSchema: entry.inputSchema,
      outputSchema: entry.outputSchema,
    })),
    ...(manifest.codeModeCaplets.length > 0
      ? [
          {
            name: nativeCodeModeToolId,
            capletId: nativeCodeModeToolId,
            title: "Code Mode",
            description: "Remote Caplets available to locally-run attached Code Mode.",
            codeModeRun: true,
            codeModeCaplets: manifest.codeModeCaplets,
          },
        ]
      : []),
  ];
}

function exportMapFor(manifest: AttachManifest): Map<string, AttachManifestExport> {
  const entries: AttachManifestExport[] = [
    ...manifest.caplets,
    ...manifest.tools,
    ...manifest.resources,
    ...manifest.resourceTemplates,
    ...manifest.prompts,
    ...manifest.completions,
    ...manifest.codeModeCaplets,
  ];
  return new Map(
    entries.flatMap((entry) => {
      const names = [entry.capletId];
      if ("name" in entry && typeof entry.name === "string") names.push(entry.name);
      return names.map((name) => [name, entry] as const);
    }),
  );
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
  return (
    isPlainObject(error) &&
    (error.code === "ATTACH_MANIFEST_STALE" ||
      (typeof error.message === "string" && error.message.includes("stale")))
  );
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
    ...manifest.codeModeCaplets,
  ].find((entry) => entry.stableId === previous.stableId);
  if (!next) return undefined;
  if (next.kind !== previous.kind) return undefined;
  if (next.schemaHash !== previous.schemaHash) return undefined;
  return next;
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
      ? "Caplets Cloud authentication failed; run caplets cloud auth login."
      : "Remote Caplets authentication failed; check CAPLETS_REMOTE_TOKEN or CAPLETS_REMOTE_USER and CAPLETS_REMOTE_PASSWORD.",
  );
}

function isSessionFailure(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return /session|transport|connection|connect|closed|invalid/u.test(message);
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
