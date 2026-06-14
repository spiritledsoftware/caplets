import { createHash } from "node:crypto";
import { schemaHash } from "../schema-hash";
import { stableJsonStringify } from "../stable-json";
import type { CapletsEngine } from "../engine";
import { CapletsError, toSafeError } from "../errors";
import { decodeDirectResourceUri } from "../exposure/direct-names";
import type {
  CallableCaplet,
  DirectPromptRegistration,
  DirectResourceRegistration,
  DirectResourceTemplateRegistration,
  DirectToolRegistration,
  ExposureSnapshot,
} from "../exposure/discovery";
import { generatedToolInputJsonSchemaForCaplet } from "../generated-tool-input-schema";

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
  schemaHash: string | null;
  capletId: string;
  shadowing: "forbid" | "allow";
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
};

export type AttachResourceTemplateExport = AttachManifestExport & {
  kind: "resourceTemplate";
  uriTemplate: string;
  downstreamUriTemplate: string;
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
  const partial: AttachManifestProjectionInput = {
    caplets: snapshot.progressiveCaplets.map(progressiveCapletExport),
    tools: snapshot.directTools.map(toolExport),
    resources: snapshot.directResources.map(resourceExport),
    resourceTemplates: snapshot.directResourceTemplates.map(resourceTemplateExport),
    prompts: snapshot.directPrompts.map(promptExport),
    completions: completionExports(snapshot),
    codeModeCaplets: snapshot.codeModeCaplets.map(codeModeCapletExport),
    diagnostics: snapshot.hiddenCaplets.map((hidden) => ({
      code: `ATTACH_CAPLET_${hidden.reason.toUpperCase()}`,
      message: `Caplet ${hidden.capletId} is not exported: ${hidden.reason}.`,
      capletId: hidden.capletId,
      ...(hidden.error ? { details: hidden.error } : {}),
    })),
  };
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
    return await engine.readDirectResource(
      route.capletId,
      downstreamResourceUri(route.capletId, uri),
    );
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
      operation: "complete",
      ...normalizeCompletionInput(projection.manifest, route.capletId, request.input),
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
    shadowing: "forbid",
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
    shadowing: "forbid",
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
    schemaHash: schemaHash({ input: entry.tool.inputSchema, output: entry.tool.outputSchema }),
    capletId: entry.caplet.server,
    shadowing: "forbid",
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
    schemaHash: null,
    capletId: entry.caplet.server,
    shadowing: "forbid",
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
    schemaHash: null,
    capletId: entry.caplet.server,
    shadowing: "forbid",
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
    shadowing: "forbid",
  };
}

function completionExports(
  snapshot: ExposureSnapshot,
): Array<Omit<AttachCompletionExport, "exportId">> {
  const capletIds = new Set([
    ...snapshot.directPrompts.map((entry) => entry.caplet.server),
    ...snapshot.directResourceTemplates.map((entry) => entry.caplet.server),
  ]);
  return [...capletIds].sort().map((capletId) => ({
    stableId: `completion:${capletId}`,
    kind: "completion",
    name: `${capletId}:complete`,
    title: "Complete",
    description: `MCP completion for ${capletId}.`,
    schemaHash: null,
    capletId,
    shadowing: "forbid",
  }));
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
