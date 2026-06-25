import { createHash } from "node:crypto";
import { schemaHash } from "../schema-hash";
import { stableJsonStringify } from "../stable-json";
import type { CapletsEngine } from "../engine";
import { CapletsError, toSafeError } from "../errors";
import type { CapletShadowingPolicy } from "../config";
import {
  decodeDirectResourceUri,
  directResourceUriMatchesTemplate,
} from "../exposure/direct-names";
import type {
  CallableCaplet,
  DirectPromptRegistration,
  DirectResourceRegistration,
  DirectResourceTemplateRegistration,
  DirectToolRegistration,
  ExposureSnapshot,
} from "../exposure/discovery";
import { generatedToolInputJsonSchemaForCaplet } from "../generated-tool-input-schema";
import type { NativeCapletsService } from "../native/service";

export const CAPLETS_ATTACH_SESSION_HEADER = "caplets-attach-session-id";

export type AttachSessionMetadata = {
  projectRoot?: string | undefined;
  projectConfigPath?: string | undefined;
};

export type AttachExportKind =
  | "caplet"
  | "tool"
  | "resource"
  | "resourceTemplate"
  | "prompt"
  | "completion";

export type AttachInvokeRequest = {
  revision: string;
  kind: AttachExportKind;
  exportId: string;
  input: unknown;
};

export type AttachDiagnostic = {
  code: string;
  message: string;
  capletId?: string | undefined;
  details?: unknown;
};

export type AttachManifestExport = {
  stableId: string;
  exportId: string;
  kind: AttachExportKind;
  name?: string | undefined;
  uri?: string | undefined;
  uriTemplate?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  schemaHash: string | null;
  capletId: string;
  shadowing: CapletShadowingPolicy;
};

export type AttachProgressiveCapletExport = AttachManifestExport & {
  kind: "caplet";
  name: string;
};

export type AttachToolExport = AttachManifestExport & {
  kind: "tool";
  name: string;
  downstreamName: string;
};

export type AttachResourceExport = AttachManifestExport & {
  kind: "resource";
  uri: string;
  downstreamUri: string;
  mimeType?: string | undefined;
  size?: number | undefined;
};

export type AttachResourceTemplateExport = AttachManifestExport & {
  kind: "resourceTemplate";
  uriTemplate: string;
  downstreamUriTemplate: string;
  mimeType?: string | undefined;
};

export type AttachPromptExport = AttachManifestExport & {
  kind: "prompt";
  name: string;
  downstreamName: string;
};

export type AttachCompletionExport = AttachManifestExport & {
  kind: "completion";
  name: string;
};

export type AttachCodeModeCaplet = AttachManifestExport & {
  kind: "caplet";
  name: string;
};

export type AttachManifest = {
  version: 1;
  revision: string;
  generatedAt: string;
  caplets: AttachProgressiveCapletExport[];
  tools: AttachToolExport[];
  resources: AttachResourceExport[];
  resourceTemplates: AttachResourceTemplateExport[];
  prompts: AttachPromptExport[];
  completions: AttachCompletionExport[];
  codeModeCaplets: AttachCodeModeCaplet[];
  diagnostics: AttachDiagnostic[];
};

type AttachRoute =
  | { kind: "caplet"; capletId: string }
  | { kind: "tool"; capletId: string; downstreamName: string }
  | { kind: "resource"; capletId: string; downstreamUri: string }
  | { kind: "resourceTemplate"; capletId: string; downstreamUriTemplate: string }
  | { kind: "prompt"; capletId: string; downstreamName: string }
  | { kind: "completion"; capletId: string };

type AttachCapletWithShadowing = {
  shadowing?: CapletShadowingPolicy | undefined;
};

export type AttachProjection = {
  manifest: AttachManifest;
  routes: Map<string, AttachRoute>;
};

type AttachManifestProjectionInput = {
  caplets: Array<Omit<AttachProgressiveCapletExport, "exportId">>;
  tools: Array<Omit<AttachToolExport, "exportId">>;
  resources: Array<Omit<AttachResourceExport, "exportId">>;
  resourceTemplates: Array<Omit<AttachResourceTemplateExport, "exportId">>;
  prompts: Array<Omit<AttachPromptExport, "exportId">>;
  completions: Array<Omit<AttachCompletionExport, "exportId">>;
  codeModeCaplets: Array<Omit<AttachCodeModeCaplet, "exportId">>;
  diagnostics: AttachDiagnostic[];
};

export async function buildAttachProjection(engine: CapletsEngine): Promise<AttachProjection> {
  const snapshot = await engine.exposureSnapshot();
  const partial = sortAttachProjectionInput({
    caplets: snapshot.progressiveCaplets.map(progressiveCapletExport),
    tools: snapshot.directTools.map(toolExport),
    resources: snapshot.directResources.map(resourceExport),
    resourceTemplates: snapshot.directResourceTemplates.map(resourceTemplateExport),
    prompts: snapshot.directPrompts.map(promptExport),
    completions: completionExports(snapshot),
    codeModeCaplets: snapshot.codeModeCaplets.map(codeModeCapletExport),
    diagnostics: snapshot.hiddenCaplets.map(attachDiagnosticForHiddenCaplet),
  });
  const revision = revisionFor(partial);
  const manifest: AttachManifest = {
    version: 1,
    revision,
    generatedAt: new Date().toISOString(),
    ...withRevisionExportIds(revision, partial),
  };
  return {
    manifest,
    routes: routesFor(manifest),
  };
}

function attachDiagnosticForHiddenCaplet(hidden: ExposureSnapshot["hiddenCaplets"][number]) {
  return {
    code: `ATTACH_CAPLET_${hidden.reason.toUpperCase()}`,
    message: `Caplet ${hidden.capletId} is not exported: ${hidden.reason}.`,
    capletId: hidden.capletId,
    ...hiddenDiagnosticDetails(hidden),
  };
}

function hiddenDiagnosticDetails(
  hidden: ExposureSnapshot["hiddenCaplets"][number],
): Pick<AttachDiagnostic, "details"> {
  if (!hidden.error) return {};
  const details = hidden.error.details;
  if (!hidden.reason.startsWith("project_binding_")) {
    return { details: hidden.error };
  }
  const existing =
    isRecord(details) && isRecord(details.projectBinding) ? details.projectBinding : {};
  return {
    details: {
      projectBinding: {
        required: true,
        capability: "project_binding",
        version: 1,
        capletId: hidden.capletId,
        ...existing,
      },
    },
  };
}

export async function buildNativeAttachProjection(
  service: NativeCapletsService,
): Promise<AttachProjection> {
  const tools = service.listTools();
  const partial = sortAttachProjectionInput({
    caplets: nativeProgressiveCaplets(tools),
    tools: nativeDirectTools(tools),
    resources: [],
    resourceTemplates: [],
    prompts: [],
    completions: [],
    codeModeCaplets: nativeCodeModeCaplets(tools),
    diagnostics: [],
  });
  const revision = revisionFor(partial);
  const manifest: AttachManifest = {
    version: 1,
    revision,
    generatedAt: new Date().toISOString(),
    ...withRevisionExportIds(revision, partial),
  };
  return {
    manifest,
    routes: routesFor(manifest),
  };
}

function nativeProgressiveCaplets(
  tools: ReturnType<NativeCapletsService["listTools"]>,
): Array<Omit<AttachProgressiveCapletExport, "exportId">> {
  return tools
    .filter((tool) => tool.codeModeRun !== true && !nativeDirectToolOperation(tool))
    .map((tool) => ({
      stableId: `native:${tool.caplet}`,
      kind: "caplet" as const,
      name: tool.caplet,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
      schemaHash: schemaHash(tool.inputSchema ?? null),
      capletId: tool.caplet,
      shadowing: tool.shadowing ?? "forbid",
    }));
}

function nativeDirectTools(
  tools: ReturnType<NativeCapletsService["listTools"]>,
): Array<Omit<AttachToolExport, "exportId">> {
  return tools.flatMap((tool) => {
    const operation = nativeDirectToolOperation(tool);
    if (!operation || tool.codeModeRun === true || !tool.sourceCaplet) return [];
    return [
      {
        stableId: `native-tool:${tool.caplet}`,
        kind: "tool" as const,
        name: tool.caplet,
        downstreamName: operation,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
        schemaHash: schemaHash({ input: tool.inputSchema, output: tool.outputSchema }),
        capletId: tool.sourceCaplet,
        shadowing: tool.shadowing ?? "forbid",
      },
    ];
  });
}

function nativeDirectToolOperation(
  tool: ReturnType<NativeCapletsService["listTools"]>[number],
): string | undefined {
  if (!tool.sourceCaplet || !tool.caplet.startsWith(`${tool.sourceCaplet}__`)) {
    return undefined;
  }
  return tool.caplet.slice(tool.sourceCaplet.length + 2);
}

function nativeCodeModeCaplets(
  tools: ReturnType<NativeCapletsService["listTools"]>,
): Array<Omit<AttachCodeModeCaplet, "exportId">> {
  return tools.flatMap((tool) =>
    (tool.codeModeCaplets ?? []).map((caplet) => ({
      stableId: `native-code-mode:${caplet.id}`,
      kind: "caplet" as const,
      name: caplet.name,
      title: caplet.name,
      description: caplet.description,
      schemaHash: null,
      capletId: caplet.id,
      shadowing: caplet.shadowing ?? "forbid",
    })),
  );
}

export async function invokeNativeAttachExport(
  service: NativeCapletsService,
  projection: AttachProjection,
  request: AttachInvokeRequest,
): Promise<unknown> {
  if (request.revision !== projection.manifest.revision) {
    throw new CapletsError("ATTACH_MANIFEST_STALE", "Attach manifest revision is stale.");
  }
  const route = projection.routes.get(request.exportId);
  if (!route || route.kind !== request.kind) {
    throw new CapletsError("ATTACH_EXPORT_NOT_FOUND", "Attach export was not found.");
  }
  if (route.kind !== "caplet") {
    if (route.kind === "tool") {
      return await service.execute(`${route.capletId}__${route.downstreamName}`, request.input);
    }
    throw new CapletsError(
      "REQUEST_INVALID",
      "Native attach sessions only support Caplet and tool exports.",
    );
  }
  return await service.execute(route.capletId, request.input);
}

export async function invokeAttachExport(
  engine: CapletsEngine,
  projection: AttachProjection,
  request: AttachInvokeRequest,
): Promise<unknown> {
  if (request.revision !== projection.manifest.revision) {
    throw new CapletsError("ATTACH_MANIFEST_STALE", "Attach manifest revision is stale.");
  }
  const route = projection.routes.get(request.exportId);
  if (!route || route.kind !== request.kind) {
    throw new CapletsError("ATTACH_EXPORT_NOT_FOUND", "Attach export was not found.");
  }
  if (route.kind === "caplet") {
    return await engine.execute(route.capletId, request.input);
  }
  if (route.kind === "tool") {
    return await engine.executeDirectTool(
      route.capletId,
      route.downstreamName,
      isRecord(request.input) ? request.input : {},
    );
  }
  if (route.kind === "resource") {
    return await engine.readDirectResource(route.capletId, route.downstreamUri);
  }
  if (route.kind === "resourceTemplate") {
    const uri =
      isRecord(request.input) && typeof request.input.uri === "string"
        ? request.input.uri
        : undefined;
    if (!uri) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Attach resource template invoke requires input.uri.",
      );
    }
    const downstreamUri = downstreamResourceUri(route.capletId, uri);
    if (!directResourceUriMatchesTemplate(downstreamUri, route.downstreamUriTemplate)) {
      throw new CapletsError(
        "ATTACH_EXPORT_NOT_FOUND",
        "Attach resource URI does not match the exported resource template.",
      );
    }
    return await engine.readDirectResource(route.capletId, downstreamUri);
  }
  if (route.kind === "prompt") {
    return await engine.getDirectPrompt(
      route.capletId,
      route.downstreamName,
      isRecord(request.input) ? stringifyRecord(request.input) : {},
    );
  }
  if (route.kind === "completion") {
    return await engine.execute(route.capletId, {
      ...normalizeCompletionInput(projection.manifest, route.capletId, request.input),
      operation: "complete",
    });
  }
  throw new CapletsError(
    "REQUEST_INVALID",
    "Attach export kind is not invokable via /v1/attach/invoke.",
  );
}

export function attachErrorResponse(error: unknown): {
  status: 400 | 404 | 409 | 500;
  body: { ok: false; error: { code: string; message: string; details?: unknown } };
} {
  const safe = toSafeError(error, "INTERNAL_ERROR");
  const status =
    safe.code === "ATTACH_MANIFEST_STALE"
      ? 409
      : safe.code === "ATTACH_EXPORT_NOT_FOUND"
        ? 404
        : safe.code === "REQUEST_INVALID"
          ? 400
          : 500;
  return { status, body: { ok: false, error: safe } };
}

function progressiveCapletExport(
  entry: CallableCaplet,
): Omit<AttachProgressiveCapletExport, "exportId"> {
  const inputSchema = generatedToolInputJsonSchemaForCaplet(entry.caplet);
  return {
    stableId: `progressive:${entry.caplet.server}`,
    kind: "caplet",
    name: entry.caplet.server,
    title: entry.caplet.name,
    description: entry.caplet.description,
    inputSchema,
    schemaHash: schemaHash(inputSchema),
    capletId: entry.caplet.server,
    shadowing: shadowingPolicy(entry.caplet),
  };
}

function codeModeCapletExport(entry: CallableCaplet): Omit<AttachCodeModeCaplet, "exportId"> {
  return {
    stableId: `code_mode:${entry.caplet.server}`,
    kind: "caplet",
    name: entry.caplet.name,
    title: entry.caplet.name,
    description: entry.caplet.description,
    schemaHash: null,
    capletId: entry.caplet.server,
    shadowing: shadowingPolicy(entry.caplet),
  };
}

function toolExport(entry: DirectToolRegistration): Omit<AttachToolExport, "exportId"> {
  return {
    stableId: `tool:${entry.caplet.server}:${entry.downstreamName}`,
    kind: "tool",
    name: entry.name,
    downstreamName: entry.downstreamName,
    title: entry.tool.name,
    description: entry.tool.description,
    inputSchema: entry.tool.inputSchema,
    outputSchema: entry.tool.outputSchema,
    annotations: entry.tool.annotations,
    schemaHash: schemaHash({ input: entry.tool.inputSchema, output: entry.tool.outputSchema }),
    capletId: entry.caplet.server,
    shadowing: shadowingPolicy(entry.caplet),
  };
}

function resourceExport(entry: DirectResourceRegistration): Omit<AttachResourceExport, "exportId"> {
  return {
    stableId: `resource:${entry.caplet.server}:${entry.downstreamUri}`,
    kind: "resource",
    uri: entry.uri,
    downstreamUri: entry.downstreamUri,
    title: entry.resource.name,
    description: entry.resource.description,
    ...(entry.resource.mimeType ? { mimeType: entry.resource.mimeType } : {}),
    ...(typeof entry.resource.size === "number" ? { size: entry.resource.size } : {}),
    schemaHash: null,
    capletId: entry.caplet.server,
    shadowing: shadowingPolicy(entry.caplet),
  };
}

function resourceTemplateExport(
  entry: DirectResourceTemplateRegistration,
): Omit<AttachResourceTemplateExport, "exportId"> {
  return {
    stableId: `resourceTemplate:${entry.caplet.server}:${entry.downstreamUriTemplate}`,
    kind: "resourceTemplate",
    uriTemplate: entry.uriTemplate,
    downstreamUriTemplate: entry.downstreamUriTemplate,
    title: entry.resourceTemplate.name,
    description: entry.resourceTemplate.description,
    ...(entry.resourceTemplate.mimeType ? { mimeType: entry.resourceTemplate.mimeType } : {}),
    schemaHash: null,
    capletId: entry.caplet.server,
    shadowing: shadowingPolicy(entry.caplet),
  };
}

function promptExport(entry: DirectPromptRegistration): Omit<AttachPromptExport, "exportId"> {
  const inputSchema = { arguments: entry.prompt.arguments ?? [] };
  return {
    stableId: `prompt:${entry.caplet.server}:${entry.downstreamName}`,
    kind: "prompt",
    name: entry.name,
    downstreamName: entry.downstreamName,
    title: entry.prompt.name,
    description: entry.prompt.description,
    inputSchema,
    schemaHash: schemaHash(inputSchema),
    capletId: entry.caplet.server,
    shadowing: shadowingPolicy(entry.caplet),
  };
}

function completionExports(
  snapshot: ExposureSnapshot,
): Array<Omit<AttachCompletionExport, "exportId">> {
  const caplets = new Map(
    [...snapshot.directPrompts, ...snapshot.directResourceTemplates].map((entry) => [
      entry.caplet.server,
      entry.caplet,
    ]),
  );
  return [...caplets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([capletId, caplet]) => ({
      stableId: `completion:${capletId}`,
      kind: "completion",
      name: `${capletId}:complete`,
      title: "Complete",
      description: `MCP completion for ${capletId}.`,
      schemaHash: null,
      capletId,
      shadowing: shadowingPolicy(caplet),
    }));
}

function shadowingPolicy(caplet: AttachCapletWithShadowing): CapletShadowingPolicy {
  return caplet.shadowing ?? "forbid";
}

function sortAttachProjectionInput(
  partial: AttachManifestProjectionInput,
): AttachManifestProjectionInput {
  return {
    caplets: sortByStableId(partial.caplets),
    tools: sortByStableId(partial.tools),
    resources: sortByStableId(partial.resources),
    resourceTemplates: sortByStableId(partial.resourceTemplates),
    prompts: sortByStableId(partial.prompts),
    completions: sortByStableId(partial.completions),
    codeModeCaplets: sortByStableId(partial.codeModeCaplets),
    diagnostics: [...partial.diagnostics].sort((left, right) =>
      diagnosticSortKey(left).localeCompare(diagnosticSortKey(right)),
    ),
  };
}

function sortByStableId<T extends { stableId: string }>(entries: T[]): T[] {
  return [...entries].sort((left, right) => left.stableId.localeCompare(right.stableId));
}

function diagnosticSortKey(diagnostic: AttachDiagnostic): string {
  return stableJsonStringify({
    code: diagnostic.code,
    capletId: diagnostic.capletId ?? "",
    message: diagnostic.message,
  });
}

function revisionFor(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJsonStringify(value)).digest("hex")}`;
}

function withRevisionExportIds(
  revision: string,
  partial: AttachManifestProjectionInput,
): Omit<AttachManifest, "version" | "revision" | "generatedAt"> {
  return {
    ...partial,
    caplets: partial.caplets.map((entry) => withExportId(revision, entry)),
    tools: partial.tools.map((entry) => withExportId(revision, entry)),
    resources: partial.resources.map((entry) => withExportId(revision, entry)),
    resourceTemplates: partial.resourceTemplates.map((entry) => withExportId(revision, entry)),
    prompts: partial.prompts.map((entry) => withExportId(revision, entry)),
    completions: partial.completions.map((entry) => withExportId(revision, entry)),
    codeModeCaplets: partial.codeModeCaplets.map((entry) => withExportId(revision, entry)),
  };
}

function withExportId<T extends { stableId: string }>(
  revision: string,
  entry: T,
): T & { exportId: string } {
  return { ...entry, exportId: `${revision}:${entry.stableId}` };
}

function routesFor(manifest: AttachManifest): Map<string, AttachRoute> {
  const routes = new Map<string, AttachRoute>();
  for (const entry of manifest.caplets) {
    routes.set(entry.exportId, { kind: "caplet", capletId: entry.capletId });
  }
  for (const entry of manifest.tools) {
    routes.set(entry.exportId, {
      kind: "tool",
      capletId: entry.capletId,
      downstreamName: entry.downstreamName,
    });
  }
  for (const entry of manifest.resources) {
    routes.set(entry.exportId, {
      kind: "resource",
      capletId: entry.capletId,
      downstreamUri: entry.downstreamUri,
    });
  }
  for (const entry of manifest.resourceTemplates) {
    routes.set(entry.exportId, {
      kind: "resourceTemplate",
      capletId: entry.capletId,
      downstreamUriTemplate: entry.downstreamUriTemplate,
    });
  }
  for (const entry of manifest.prompts) {
    routes.set(entry.exportId, {
      kind: "prompt",
      capletId: entry.capletId,
      downstreamName: entry.downstreamName,
    });
  }
  for (const entry of manifest.completions) {
    routes.set(entry.exportId, { kind: "completion", capletId: entry.capletId });
  }
  for (const entry of manifest.codeModeCaplets) {
    routes.set(entry.exportId, { kind: "caplet", capletId: entry.capletId });
  }
  return routes;
}

function normalizeCompletionInput(
  manifest: AttachManifest,
  capletId: string,
  input: unknown,
): Record<string, unknown> {
  if (!isRecord(input)) return {};
  const ref = input.ref;
  if (!isRecord(ref)) return input;

  if (ref.type === "prompt" && typeof ref.name === "string") {
    const prompt = manifest.prompts.find(
      (entry) =>
        entry.capletId === capletId &&
        (entry.name === ref.name || entry.downstreamName === ref.name),
    );
    if (!prompt) return input;
    return { ...input, ref: { ...ref, name: prompt.downstreamName } };
  }

  if (ref.type === "resourceTemplate" && typeof ref.uri === "string") {
    const resourceTemplate = manifest.resourceTemplates.find(
      (entry) =>
        entry.capletId === capletId &&
        (entry.uriTemplate === ref.uri || entry.downstreamUriTemplate === ref.uri),
    );
    if (!resourceTemplate) return input;
    return { ...input, ref: { ...ref, uri: resourceTemplate.downstreamUriTemplate } };
  }

  return input;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringifyRecord(record: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    ]),
  );
}

function downstreamResourceUri(capletId: string, uri: string): string {
  if (!uri.startsWith("caplets://")) return uri;
  const decoded = decodeDirectResourceUri(uri);
  if (decoded.capletId !== capletId) {
    throw new CapletsError(
      "ATTACH_EXPORT_NOT_FOUND",
      "Attach resource template URI belongs to a different Caplet.",
    );
  }
  return decoded.downstreamUri;
}
