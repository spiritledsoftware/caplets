import type { CapletConfig, CapletShadowingPolicy } from "../config";
import {
  resolveNamespaceExposure,
  type NamespaceDiagnostic,
  type NamespaceSourceEntry,
} from "./namespace";
import type { SafeErrorSummary } from "../errors";
import { generatedToolInputJsonSchemaForCaplet } from "../generated-tool-input-schema";
import { capabilityDescription } from "../registry";
import {
  directPromptName,
  directResourceTemplateUri,
  directResourceUri,
  directToolName,
} from "./direct-names";
import type {
  CallableCaplet,
  ExposureSnapshot,
  HiddenCaplet,
  HiddenCapletReason,
} from "./discovery";

export type ExposureProjectionAvailability =
  | { state: "ready" }
  | { state: "unavailable"; reason: string }
  | { state: "stale"; reason: string };

export type ExposureProjectionEntryKind =
  | "progressive-caplet"
  | "code-mode-caplet"
  | "direct-tool"
  | "direct-resource"
  | "direct-resource-template"
  | "direct-prompt"
  | "completion";

export type ExposureProjectionRouteKey = `${ExposureProjectionEntryKind}:${string}`;

export type ExposureProjectionRoute =
  | { kind: "progressive-caplet"; capletId: string }
  | { kind: "code-mode-caplet"; capletId: string }
  | { kind: "direct-tool"; capletId: string; downstreamName: string }
  | { kind: "direct-resource"; capletId: string; downstreamUri: string }
  | { kind: "direct-resource-template"; capletId: string; downstreamUriTemplate: string }
  | { kind: "direct-prompt"; capletId: string; downstreamName: string }
  | { kind: "completion"; capletId: string };

type ExposureProjectionEntryBase<
  Kind extends ExposureProjectionEntryKind,
  Route extends ExposureProjectionRoute,
> = {
  kind: Kind;
  id: string;
  capletId: string;
  title?: string | undefined;
  description?: string | undefined;
  sourceCapletId?: string | undefined;
  shadowing: CapletShadowingPolicy;
  useWhen?: string | undefined;
  avoidWhen?: string | undefined;
  route: Route;
};

export type ExposureProjectionProgressiveCaplet = ExposureProjectionEntryBase<
  "progressive-caplet",
  Extract<ExposureProjectionRoute, { kind: "progressive-caplet" }>
> & {
  backend?: CapletConfig["backend"] | undefined;
  inputSchema?: unknown;
  operationNames?: string[] | undefined;
};

export type ExposureProjectionCodeModeCaplet = ExposureProjectionEntryBase<
  "code-mode-caplet",
  Extract<ExposureProjectionRoute, { kind: "code-mode-caplet" }>
> & {
  backend?: CapletConfig["backend"] | undefined;
};

export type ExposureProjectionDirectTool = ExposureProjectionEntryBase<
  "direct-tool",
  Extract<ExposureProjectionRoute, { kind: "direct-tool" }>
> & {
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
};

export type ExposureProjectionDirectResource = ExposureProjectionEntryBase<
  "direct-resource",
  Extract<ExposureProjectionRoute, { kind: "direct-resource" }>
> & {
  mimeType?: string | undefined;
  size?: number | undefined;
};

export type ExposureProjectionDirectResourceTemplate = ExposureProjectionEntryBase<
  "direct-resource-template",
  Extract<ExposureProjectionRoute, { kind: "direct-resource-template" }>
> & {
  mimeType?: string | undefined;
};

export type ExposureProjectionPromptArgument = {
  name: string;
  description?: string | undefined;
  required?: boolean | undefined;
};

export type ExposureProjectionDirectPrompt = ExposureProjectionEntryBase<
  "direct-prompt",
  Extract<ExposureProjectionRoute, { kind: "direct-prompt" }>
> & {
  inputSchema?: unknown;
  arguments: ExposureProjectionPromptArgument[];
};

export type ExposureProjectionCompletion = ExposureProjectionEntryBase<
  "completion",
  Extract<ExposureProjectionRoute, { kind: "completion" }>
>;

export type ExposureProjectionEntry =
  | ExposureProjectionProgressiveCaplet
  | ExposureProjectionCodeModeCaplet
  | ExposureProjectionDirectTool
  | ExposureProjectionDirectResource
  | ExposureProjectionDirectResourceTemplate
  | ExposureProjectionDirectPrompt
  | ExposureProjectionCompletion;

export type ExposureProjectionHiddenCaplet = {
  capletId: string;
  reason: HiddenCapletReason;
  diagnostic?: SafeErrorSummary | undefined;
};

export type ExposureProjection = {
  availability: ExposureProjectionAvailability;
  entries: ExposureProjectionEntry[];
  hiddenCaplets: ExposureProjectionHiddenCaplet[];
  routes: Map<ExposureProjectionRouteKey, ExposureProjectionRoute>;
};

export function exposureProjectionRouteKey(
  entry: Pick<ExposureProjectionEntry, "kind" | "id">,
): ExposureProjectionRouteKey {
  return `${entry.kind}:${entry.id}`;
}

export function buildExposureProjection(snapshot: ExposureSnapshot): ExposureProjection {
  const entries = snapshot.callableCaplets.flatMap(entriesForCallableCaplet);

  return {
    availability: { state: "ready" },
    entries,
    hiddenCaplets: snapshot.hiddenCaplets.map(hiddenCapletEntry),
    routes: new Map(entries.map((entry) => [exposureProjectionRouteKey(entry), entry.route])),
  };
}

export type ManifestProjectionInput = {
  caplets: ManifestProjectionCaplet[];
  tools: ManifestProjectionTool[];
  resources: ManifestProjectionResource[];
  resourceTemplates: ManifestProjectionResourceTemplate[];
  prompts: ManifestProjectionPrompt[];
  completions: ManifestProjectionCompletion[];
  codeModeCaplets?: ManifestProjectionCodeModeCaplet[] | undefined;
};

type ManifestProjectionBase = {
  capletId: string;
  sourceCapletId?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  shadowing: CapletShadowingPolicy;
  useWhen?: string | undefined;
  avoidWhen?: string | undefined;
};

type ManifestProjectionCaplet = ManifestProjectionBase & {
  kind: "caplet";
  name: string;
};

type ManifestProjectionTool = ManifestProjectionBase & {
  kind: "tool";
  name: string;
  downstreamName: string;
};

type ManifestProjectionResource = ManifestProjectionBase & {
  kind: "resource";
  uri: string;
  downstreamUri: string;
  mimeType?: string | undefined;
  size?: number | undefined;
};

type ManifestProjectionResourceTemplate = ManifestProjectionBase & {
  kind: "resourceTemplate";
  uriTemplate: string;
  downstreamUriTemplate: string;
  mimeType?: string | undefined;
};

type ManifestProjectionPrompt = ManifestProjectionBase & {
  kind: "prompt";
  name: string;
  downstreamName: string;
};

type ManifestProjectionCompletion = ManifestProjectionBase & {
  kind: "completion";
  name?: string | undefined;
};

type ManifestProjectionCodeModeCaplet = ManifestProjectionBase & {
  kind: "caplet";
  name: string;
};

export function buildManifestExposureProjection(
  manifest: ManifestProjectionInput,
): ExposureProjection {
  const entries = [
    ...manifest.caplets.map(manifestProgressiveCapletEntry),
    ...manifest.tools.map(manifestDirectToolEntry),
    ...manifest.resources.map(manifestDirectResourceEntry),
    ...manifest.resourceTemplates.map(manifestDirectResourceTemplateEntry),
    ...manifest.prompts.map(manifestDirectPromptEntry),
    ...manifest.completions.map(manifestCompletionEntry),
    ...(manifest.codeModeCaplets ?? []).map(manifestCodeModeCapletEntry),
  ];
  return {
    availability: { state: "ready" },
    entries,
    hiddenCaplets: [],
    routes: new Map(entries.map((entry) => [exposureProjectionRouteKey(entry), entry.route])),
  };
}

function manifestProgressiveCapletEntry(entry: ManifestProjectionCaplet): ExposureProjectionEntry {
  return {
    kind: "progressive-caplet",
    id: entry.capletId,
    capletId: entry.capletId,
    ...(entry.sourceCapletId ? { sourceCapletId: entry.sourceCapletId } : {}),
    title: entry.title ?? entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema,
    ...(entry.useWhen ? { useWhen: entry.useWhen } : {}),
    ...(entry.avoidWhen ? { avoidWhen: entry.avoidWhen } : {}),
    shadowing: entry.shadowing,
    route: { kind: "progressive-caplet", capletId: entry.capletId },
  };
}

function manifestDirectToolEntry(entry: ManifestProjectionTool): ExposureProjectionEntry {
  return {
    kind: "direct-tool",
    id: entry.name,
    capletId: entry.capletId,
    sourceCapletId: entry.sourceCapletId ?? entry.capletId,
    title: entry.title ?? entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema,
    outputSchema: entry.outputSchema,
    annotations: entry.annotations,
    ...(entry.useWhen ? { useWhen: entry.useWhen } : {}),
    ...(entry.avoidWhen ? { avoidWhen: entry.avoidWhen } : {}),
    shadowing: entry.shadowing,
    route: { kind: "direct-tool", capletId: entry.capletId, downstreamName: entry.downstreamName },
  };
}

function manifestDirectResourceEntry(entry: ManifestProjectionResource): ExposureProjectionEntry {
  return {
    kind: "direct-resource",
    id: entry.uri,
    capletId: entry.capletId,
    ...(entry.sourceCapletId ? { sourceCapletId: entry.sourceCapletId } : {}),
    title: entry.title,
    description: entry.description,
    ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
    ...(typeof entry.size === "number" ? { size: entry.size } : {}),
    ...(entry.useWhen ? { useWhen: entry.useWhen } : {}),
    ...(entry.avoidWhen ? { avoidWhen: entry.avoidWhen } : {}),
    shadowing: entry.shadowing,
    route: {
      kind: "direct-resource",
      capletId: entry.capletId,
      downstreamUri: entry.downstreamUri,
    },
  };
}

function manifestDirectResourceTemplateEntry(
  entry: ManifestProjectionResourceTemplate,
): ExposureProjectionEntry {
  return {
    kind: "direct-resource-template",
    id: entry.uriTemplate,
    capletId: entry.capletId,
    ...(entry.sourceCapletId ? { sourceCapletId: entry.sourceCapletId } : {}),
    title: entry.title,
    description: entry.description,
    ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
    ...(entry.useWhen ? { useWhen: entry.useWhen } : {}),
    ...(entry.avoidWhen ? { avoidWhen: entry.avoidWhen } : {}),
    shadowing: entry.shadowing,
    route: {
      kind: "direct-resource-template",
      capletId: entry.capletId,
      downstreamUriTemplate: entry.downstreamUriTemplate,
    },
  };
}

function manifestDirectPromptEntry(entry: ManifestProjectionPrompt): ExposureProjectionEntry {
  return {
    kind: "direct-prompt",
    id: entry.name,
    capletId: entry.capletId,
    ...(entry.sourceCapletId ? { sourceCapletId: entry.sourceCapletId } : {}),
    title: entry.title ?? entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema,
    arguments: promptArgumentsFromSchema(entry.inputSchema),
    ...(entry.useWhen ? { useWhen: entry.useWhen } : {}),
    ...(entry.avoidWhen ? { avoidWhen: entry.avoidWhen } : {}),
    shadowing: entry.shadowing,
    route: {
      kind: "direct-prompt",
      capletId: entry.capletId,
      downstreamName: entry.downstreamName,
    },
  };
}

function promptArgumentsFromSchema(inputSchema: unknown): ExposureProjectionPromptArgument[] {
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) return [];
  const args = (inputSchema as Record<string, unknown>).arguments;
  if (!Array.isArray(args)) return [];
  return args.flatMap((argument) => {
    if (!argument || typeof argument !== "object" || Array.isArray(argument)) return [];
    const record = argument as Record<string, unknown>;
    if (typeof record.name !== "string") return [];
    return [
      {
        name: record.name,
        ...(typeof record.description === "string" ? { description: record.description } : {}),
        ...(typeof record.required === "boolean" ? { required: record.required } : {}),
      },
    ];
  });
}

function manifestCompletionEntry(entry: ManifestProjectionCompletion): ExposureProjectionEntry {
  return {
    kind: "completion",
    id: entry.name ?? `${entry.capletId}:complete`,
    capletId: entry.capletId,
    ...(entry.sourceCapletId ? { sourceCapletId: entry.sourceCapletId } : {}),
    title: entry.title,
    description: entry.description,
    ...(entry.useWhen ? { useWhen: entry.useWhen } : {}),
    ...(entry.avoidWhen ? { avoidWhen: entry.avoidWhen } : {}),
    shadowing: entry.shadowing,
    route: { kind: "completion", capletId: entry.capletId },
  };
}

function manifestCodeModeCapletEntry(
  entry: ManifestProjectionCodeModeCaplet,
): ExposureProjectionEntry {
  return {
    kind: "code-mode-caplet",
    id: entry.capletId,
    capletId: entry.capletId,
    ...(entry.sourceCapletId ? { sourceCapletId: entry.sourceCapletId } : {}),
    title: entry.title ?? entry.name,
    description: entry.description,
    ...(entry.useWhen ? { useWhen: entry.useWhen } : {}),
    ...(entry.avoidWhen ? { avoidWhen: entry.avoidWhen } : {}),
    shadowing: entry.shadowing,
    route: { kind: "code-mode-caplet", capletId: entry.capletId },
  };
}

function entriesForCallableCaplet(entry: CallableCaplet): ExposureProjectionEntry[] {
  const entries: ExposureProjectionEntry[] = [];
  if (entry.exposure.progressive) entries.push(progressiveCapletEntry(entry));
  if (entry.exposure.codeMode) entries.push(codeModeCapletEntry(entry));
  if (!entry.exposure.direct) return entries;

  entries.push(...entry.tools.map((tool) => directToolEntry(entry, tool)));
  if (entry.caplet.backend !== "mcp") return entries;

  entries.push(...entry.resources.map((resource) => directResourceEntry(entry, resource)));
  entries.push(
    ...entry.resourceTemplates.map((resourceTemplate) =>
      directResourceTemplateEntry(entry, resourceTemplate),
    ),
  );
  entries.push(...entry.prompts.map((prompt) => directPromptEntry(entry, prompt)));
  if (entry.completions && (entry.resourceTemplates.length > 0 || entry.prompts.length > 0)) {
    entries.push(completionEntry(entry));
  }
  return entries;
}

function progressiveCapletEntry(entry: CallableCaplet): ExposureProjectionProgressiveCaplet {
  const capletId = entry.caplet.server;
  const inputSchema = generatedToolInputJsonSchemaForCaplet(entry.caplet);
  return {
    kind: "progressive-caplet",
    id: capletId,
    capletId,
    title: entry.caplet.name,
    description: capabilityDescription(entry.caplet),
    backend: entry.caplet.backend,
    inputSchema,
    operationNames: [...inputSchema.properties.operation.enum],
    ...(entry.caplet.useWhen ? { useWhen: entry.caplet.useWhen } : {}),
    ...(entry.caplet.avoidWhen ? { avoidWhen: entry.caplet.avoidWhen } : {}),
    shadowing: shadowingPolicy(entry.caplet),
    route: { kind: "progressive-caplet", capletId },
  };
}

function codeModeCapletEntry(entry: CallableCaplet): ExposureProjectionCodeModeCaplet {
  const capletId = entry.caplet.server;
  return {
    kind: "code-mode-caplet",
    id: capletId,
    capletId,
    title: entry.caplet.name,
    description: capabilityDescription(entry.caplet),
    backend: entry.caplet.backend,
    ...(entry.caplet.useWhen ? { useWhen: entry.caplet.useWhen } : {}),
    ...(entry.caplet.avoidWhen ? { avoidWhen: entry.caplet.avoidWhen } : {}),
    shadowing: shadowingPolicy(entry.caplet),
    route: { kind: "code-mode-caplet", capletId },
  };
}

function directToolEntry(
  entry: CallableCaplet,
  tool: CallableCaplet["tools"][number],
): ExposureProjectionDirectTool {
  const capletId = entry.caplet.server;
  return {
    kind: "direct-tool",
    id: directToolName(capletId, tool.name),
    capletId,
    title: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    ...(entry.caplet.useWhen ? { useWhen: entry.caplet.useWhen } : {}),
    ...(entry.caplet.avoidWhen ? { avoidWhen: entry.caplet.avoidWhen } : {}),
    shadowing: shadowingPolicy(entry.caplet),
    route: { kind: "direct-tool", capletId, downstreamName: tool.name },
  };
}

function directResourceEntry(
  entry: CallableCaplet,
  resource: CallableCaplet["resources"][number],
): ExposureProjectionDirectResource {
  const capletId = entry.caplet.server;
  return {
    kind: "direct-resource",
    id: directResourceUri(capletId, resource.uri),
    capletId,
    title: resource.name,
    description: resource.description,
    ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
    ...(typeof resource.size === "number" ? { size: resource.size } : {}),
    ...(entry.caplet.useWhen ? { useWhen: entry.caplet.useWhen } : {}),
    ...(entry.caplet.avoidWhen ? { avoidWhen: entry.caplet.avoidWhen } : {}),
    shadowing: shadowingPolicy(entry.caplet),
    route: { kind: "direct-resource", capletId, downstreamUri: resource.uri },
  };
}

function directResourceTemplateEntry(
  entry: CallableCaplet,
  resourceTemplate: CallableCaplet["resourceTemplates"][number],
): ExposureProjectionDirectResourceTemplate {
  const capletId = entry.caplet.server;
  return {
    kind: "direct-resource-template",
    id: directResourceTemplateUri(capletId, resourceTemplate.uriTemplate),
    capletId,
    title: resourceTemplate.name,
    description: resourceTemplate.description,
    ...(resourceTemplate.mimeType ? { mimeType: resourceTemplate.mimeType } : {}),
    ...(entry.caplet.useWhen ? { useWhen: entry.caplet.useWhen } : {}),
    ...(entry.caplet.avoidWhen ? { avoidWhen: entry.caplet.avoidWhen } : {}),
    shadowing: shadowingPolicy(entry.caplet),
    route: {
      kind: "direct-resource-template",
      capletId,
      downstreamUriTemplate: resourceTemplate.uriTemplate,
    },
  };
}

function directPromptEntry(
  entry: CallableCaplet,
  prompt: CallableCaplet["prompts"][number],
): ExposureProjectionDirectPrompt {
  const capletId = entry.caplet.server;
  const args = (prompt.arguments ?? []).map((argument) => ({ ...argument }));
  return {
    kind: "direct-prompt",
    id: directPromptName(capletId, prompt.name),
    capletId,
    title: prompt.name,
    description: prompt.description,
    inputSchema: { arguments: args },
    arguments: args,
    ...(entry.caplet.useWhen ? { useWhen: entry.caplet.useWhen } : {}),
    ...(entry.caplet.avoidWhen ? { avoidWhen: entry.caplet.avoidWhen } : {}),
    shadowing: shadowingPolicy(entry.caplet),
    route: { kind: "direct-prompt", capletId, downstreamName: prompt.name },
  };
}

function completionEntry(entry: CallableCaplet): ExposureProjectionCompletion {
  const capletId = entry.caplet.server;
  return {
    kind: "completion",
    id: `${capletId}:complete`,
    capletId,
    title: "Complete",
    description: `MCP completion for ${capletId}.`,
    ...(entry.caplet.useWhen ? { useWhen: entry.caplet.useWhen } : {}),
    ...(entry.caplet.avoidWhen ? { avoidWhen: entry.caplet.avoidWhen } : {}),
    shadowing: shadowingPolicy(entry.caplet),
    route: { kind: "completion", capletId },
  };
}

function hiddenCapletEntry(hidden: HiddenCaplet): ExposureProjectionHiddenCaplet {
  return {
    capletId: hidden.capletId,
    reason: hidden.reason,
    ...(hidden.error ? { diagnostic: safeDiagnostic(hidden.error) } : {}),
  };
}

function safeDiagnostic(error: SafeErrorSummary): SafeErrorSummary {
  return {
    code: error.code,
    message: sanitizeString(error.message),
    ...(error.details === undefined ? {} : { details: sanitizeDetails(error.details) }),
  };
}

function sanitizeDetails(value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeDetails);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      sensitiveKey(key) ? "[REDACTED]" : sanitizeDetails(nested),
    ]),
  );
}

function sanitizeString(value: string): string {
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(
      /(?:\/Users|\/home)\/[^\s,)]+|[A-Za-z]:[\\/](?:Users|home)[^,\s)]*/g,
      "[REDACTED_PATH]",
    );
}

function sensitiveKey(key: string): boolean {
  return /(?:token|secret|credential|password|path)$/i.test(key);
}

function shadowingPolicy(caplet: { shadowing?: CapletShadowingPolicy | undefined }) {
  return caplet.shadowing ?? "forbid";
}

export type NativeProjectionMergeTool = {
  caplet: string;
  sourceCaplet?: string | undefined;
  shadowing?: CapletShadowingPolicy | undefined;
  codeModeRun?: boolean | undefined;
};

export type NativeProjectionMergeRoute = {
  service: "local" | "remote";
  capletId: string;
};

type NativeProjectionNamespaceRoute = {
  service: "local" | "remote";
  baseId: string;
};

export type NativeProjectionMergeOptions<Tool extends NativeProjectionMergeTool> = {
  remoteTools: Tool[];
  localTools: Tool[];
  remoteCodeModeTools: Tool[];
  localCodeModeTools: Tool[];
  remoteIdentity: string;
  localIdentity: string;
  namespaceAliases: {
    local?: string | undefined;
    upstreams: Record<string, string>;
  };
  renameTool(tool: Tool, visibleBaseId: string): Tool;
};

export type NativeProjectionMergeResult<Tool extends NativeProjectionMergeTool> = {
  remoteTools: Tool[];
  localTools: Tool[];
  remoteCodeModeTools: Tool[];
  localCodeModeTools: Tool[];
  routes: Map<string, NativeProjectionMergeRoute>;
  namespaceDiagnostics: Map<string, NamespaceDiagnostic>;
  suppressedLocalIds: Set<string>;
};

export function resolveNativeProjectionMerge<Tool extends NativeProjectionMergeTool>(
  options: NativeProjectionMergeOptions<Tool>,
): NativeProjectionMergeResult<Tool> {
  const suppressedLocalIds = remoteSuppressedProjectionCapletIds(
    options.remoteTools,
    options.remoteCodeModeTools,
  );
  const localTools = options.localTools.filter(
    (tool) => tool.codeModeRun !== true && !suppressedLocalIds.has(projectionSourceBaseId(tool)),
  );
  const localCodeModeTools = options.localCodeModeTools.filter(
    (tool) => !suppressedLocalIds.has(tool.caplet),
  );
  const remoteTools = options.remoteTools.filter((tool) => tool.codeModeRun !== true);
  const resolved = resolveVisibleProjectionToolIds({
    remoteTools,
    localTools,
    remoteCodeModeTools: options.remoteCodeModeTools,
    localCodeModeTools,
    remoteIdentity: options.remoteIdentity,
    localIdentity: options.localIdentity,
    namespaceAliases: options.namespaceAliases,
    renameTool: options.renameTool,
  });
  return { ...resolved, suppressedLocalIds };
}

function resolveVisibleProjectionToolIds<Tool extends NativeProjectionMergeTool>(options: {
  remoteTools: Tool[];
  localTools: Tool[];
  remoteCodeModeTools: Tool[];
  localCodeModeTools: Tool[];
  remoteIdentity: string;
  localIdentity: string;
  namespaceAliases: { local?: string | undefined; upstreams: Record<string, string> };
  renameTool(tool: Tool, visibleBaseId: string): Tool;
}): Omit<NativeProjectionMergeResult<Tool>, "suppressedLocalIds"> {
  const entries = nativeProjectionNamespaceEntries(
    [
      { service: "remote", tools: [...options.remoteTools, ...options.remoteCodeModeTools] },
      { service: "local", tools: [...options.localTools, ...options.localCodeModeTools] },
    ],
    options,
  );
  const resolution = resolveNamespaceExposure(entries);
  const namespacedRecords = resolution.visibleRecords.filter((record) => record.namespaced);
  const namespacedBaseIds = new Set(namespacedRecords.map((record) => record.baseId));
  const diagnosticBaseIds = new Set(
    resolution.unavailableDiagnostics.map((diagnostic) => diagnostic.requestedId),
  );
  const routes = new Map<string, NativeProjectionMergeRoute>();
  const namespaceDiagnostics = new Map(resolution.suppressedBareIds);
  for (const diagnostic of resolution.unavailableDiagnostics) {
    namespaceDiagnostics.set(diagnostic.requestedId, diagnostic);
  }
  const alternativesByBaseId = new Map<string, Set<string>>();
  const staleIdsByBaseId = new Map<string, Set<string>>();

  const setRoute = (
    visibleCapletId: string,
    route: NativeProjectionMergeRoute,
    overwrite: boolean,
  ) => {
    if (overwrite || !routes.has(visibleCapletId)) routes.set(visibleCapletId, route);
  };
  const rewrite = (service: "local" | "remote", tools: Tool[], overwrite: boolean): Tool[] => {
    const rewritten: Tool[] = [];
    for (const tool of tools) {
      const baseId = projectionSourceBaseId(tool);
      if (diagnosticBaseIds.has(baseId)) continue;
      if (!namespacedBaseIds.has(baseId)) {
        rewritten.push(tool);
        setRoute(tool.caplet, { service, capletId: tool.caplet }, overwrite);
        continue;
      }
      const record = namespacedRecords.find(
        (candidate) => candidate.baseId === baseId && candidate.route.service === service,
      );
      if (!record) continue;
      const visibleTool = options.renameTool(tool, record.id);
      rewritten.push(visibleTool);
      addProjectionMapSetValue(alternativesByBaseId, baseId, visibleTool.caplet);
      if (tool.caplet !== visibleTool.caplet) {
        addProjectionMapSetValue(staleIdsByBaseId, baseId, tool.caplet);
      }
      setRoute(visibleTool.caplet, { service, capletId: tool.caplet }, overwrite);
    }
    return rewritten;
  };

  const remoteTools = rewrite("remote", options.remoteTools, false);
  const localTools = rewrite("local", options.localTools, true);
  const remoteCodeModeTools = rewrite("remote", options.remoteCodeModeTools, false);
  const localCodeModeTools = rewrite("local", options.localCodeModeTools, true);
  for (const [baseId, alternatives] of alternativesByBaseId) {
    const baseDiagnostic = resolution.suppressedBareIds.get(baseId);
    if (!baseDiagnostic) continue;
    const alternativeList = [...alternatives];
    namespaceDiagnostics.set(
      baseId,
      projectionNamespaceDiagnosticWithAlternatives(baseId, baseDiagnostic, alternativeList),
    );
    for (const staleId of staleIdsByBaseId.get(baseId) ?? []) {
      namespaceDiagnostics.set(
        staleId,
        projectionNamespaceDiagnosticWithAlternatives(staleId, baseDiagnostic, alternativeList),
      );
    }
  }

  return {
    remoteTools,
    localTools,
    remoteCodeModeTools,
    localCodeModeTools,
    routes,
    namespaceDiagnostics,
  };
}

function nativeProjectionNamespaceEntries<Tool extends NativeProjectionMergeTool>(
  groups: Array<{ service: "local" | "remote"; tools: Tool[] }>,
  identities: {
    remoteIdentity: string;
    localIdentity: string;
    namespaceAliases: { local?: string | undefined; upstreams: Record<string, string> };
  },
): Array<NamespaceSourceEntry<NativeProjectionNamespaceRoute>> {
  const entries = new Map<string, NamespaceSourceEntry<NativeProjectionNamespaceRoute>>();
  for (const group of groups) {
    const byBaseId = new Map<string, Tool[]>();
    for (const tool of group.tools) {
      const baseId = projectionSourceBaseId(tool);
      byBaseId.set(baseId, [...(byBaseId.get(baseId) ?? []), tool]);
    }
    for (const [baseId, tools] of byBaseId) {
      const service = group.service;
      entries.set(`${service}:${baseId}`, {
        baseId,
        sourceKind: service === "local" ? "local" : "upstream",
        sourceLabel: service === "local" ? "local" : "remote",
        namespaceAlias:
          service === "local"
            ? identities.namespaceAliases.local
            : identities.namespaceAliases.upstreams[identities.remoteIdentity],
        durableSourceIdentity:
          service === "local" ? identities.localIdentity : identities.remoteIdentity,
        shadowing: aggregateProjectionShadowing(tools),
        route: { service, baseId },
      });
    }
  }
  return [...entries.values()];
}

function remoteSuppressedProjectionCapletIds<Tool extends NativeProjectionMergeTool>(
  allRemoteTools: Tool[],
  remoteCodeModeTools: Tool[],
): Set<string> {
  return new Set(
    [
      ...allRemoteTools
        .filter((tool) => tool.codeModeRun !== true && (tool.shadowing ?? "forbid") === "forbid")
        .map(projectionSourceBaseId),
      ...remoteCodeModeTools
        .filter((tool) => (tool.shadowing ?? "forbid") === "forbid")
        .map((tool) => tool.caplet),
    ].filter((caplet) => caplet !== "code_mode"),
  );
}

function aggregateProjectionShadowing<Tool extends NativeProjectionMergeTool>(
  tools: Tool[],
): CapletShadowingPolicy {
  if (tools.some((tool) => (tool.shadowing ?? "forbid") === "forbid")) return "forbid";
  if (tools.some((tool) => tool.shadowing === "namespace")) return "namespace";
  return "allow";
}

function projectionSourceBaseId(tool: NativeProjectionMergeTool): string {
  return tool.sourceCaplet ?? tool.caplet;
}

function addProjectionMapSetValue<Key, Value>(
  map: Map<Key, Set<Value>>,
  key: Key,
  value: Value,
): void {
  let values = map.get(key);
  if (!values) {
    values = new Set();
    map.set(key, values);
  }
  values.add(value);
}

function projectionNamespaceDiagnosticWithAlternatives(
  requestedId: string,
  diagnostic: NamespaceDiagnostic,
  alternatives: string[],
): NamespaceDiagnostic {
  return {
    ...diagnostic,
    requestedId,
    alternatives,
    hint: `Caplet '${requestedId}' is unavailable because namespace shadowing exposes qualified alternatives: ${alternatives.join(", ")}.`,
  };
}
