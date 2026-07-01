import type { CapletShadowingPolicy } from "../config";
import type { SafeErrorSummary } from "../errors";
import { generatedToolInputJsonSchemaForCaplet } from "../generated-tool-input-schema";
import type {
  CallableCaplet,
  DirectPromptRegistration,
  DirectResourceRegistration,
  DirectResourceTemplateRegistration,
  DirectToolRegistration,
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

export type ExposureProjectionRoute =
  | { kind: "progressive-caplet"; capletId: string }
  | { kind: "code-mode-caplet"; capletId: string }
  | { kind: "direct-tool"; capletId: string; downstreamName: string }
  | { kind: "direct-resource"; capletId: string; downstreamUri: string }
  | { kind: "direct-resource-template"; capletId: string; downstreamUriTemplate: string }
  | { kind: "direct-prompt"; capletId: string; downstreamName: string }
  | { kind: "completion"; capletId: string };

export type ExposureProjectionEntry = {
  kind: ExposureProjectionEntryKind;
  id: string;
  capletId: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  mimeType?: string | undefined;
  size?: number | undefined;
  sourceCapletId?: string | undefined;
  shadowing: CapletShadowingPolicy;
  route: ExposureProjectionRoute;
};

export type ExposureProjectionHiddenCaplet = {
  capletId: string;
  reason: HiddenCapletReason;
  diagnostic?: SafeErrorSummary | undefined;
};

export type ExposureProjection = {
  availability: ExposureProjectionAvailability;
  entries: ExposureProjectionEntry[];
  hiddenCaplets: ExposureProjectionHiddenCaplet[];
  routes: Map<string, ExposureProjectionRoute>;
};

export function buildExposureProjection(snapshot: ExposureSnapshot): ExposureProjection {
  const entries = [
    ...snapshot.progressiveCaplets.map(progressiveCapletEntry),
    ...snapshot.codeModeCaplets.map(codeModeCapletEntry),
    ...snapshot.directTools.map(directToolEntry),
    ...snapshot.directResources.map(directResourceEntry),
    ...snapshot.directResourceTemplates.map(directResourceTemplateEntry),
    ...snapshot.directPrompts.map(directPromptEntry),
    ...completionEntries(snapshot),
  ];

  return {
    availability: { state: "ready" },
    entries,
    hiddenCaplets: snapshot.hiddenCaplets.map(hiddenCapletEntry),
    routes: new Map(entries.map((entry) => [entry.id, entry.route])),
  };
}

function progressiveCapletEntry(entry: CallableCaplet): ExposureProjectionEntry {
  const capletId = entry.caplet.server;
  return {
    kind: "progressive-caplet",
    id: capletId,
    capletId,
    title: entry.caplet.name,
    description: entry.caplet.description,
    inputSchema: generatedToolInputJsonSchemaForCaplet(entry.caplet),
    shadowing: shadowingPolicy(entry.caplet),
    route: { kind: "progressive-caplet", capletId },
  };
}

function codeModeCapletEntry(entry: CallableCaplet): ExposureProjectionEntry {
  const capletId = entry.caplet.server;
  return {
    kind: "code-mode-caplet",
    id: capletId,
    capletId,
    title: entry.caplet.name,
    description: entry.caplet.description,
    shadowing: shadowingPolicy(entry.caplet),
    route: { kind: "code-mode-caplet", capletId },
  };
}

function directToolEntry(entry: DirectToolRegistration): ExposureProjectionEntry {
  return {
    kind: "direct-tool",
    id: entry.name,
    capletId: entry.caplet.server,
    title: entry.tool.name,
    description: entry.tool.description,
    inputSchema: entry.tool.inputSchema,
    outputSchema: entry.tool.outputSchema,
    annotations: entry.tool.annotations,
    shadowing: shadowingPolicy(entry.caplet),
    route: {
      kind: "direct-tool",
      capletId: entry.caplet.server,
      downstreamName: entry.downstreamName,
    },
  };
}

function directResourceEntry(entry: DirectResourceRegistration): ExposureProjectionEntry {
  return {
    kind: "direct-resource",
    id: entry.uri,
    capletId: entry.caplet.server,
    title: entry.resource.name,
    description: entry.resource.description,
    ...(entry.resource.mimeType ? { mimeType: entry.resource.mimeType } : {}),
    ...(typeof entry.resource.size === "number" ? { size: entry.resource.size } : {}),
    shadowing: shadowingPolicy(entry.caplet),
    route: {
      kind: "direct-resource",
      capletId: entry.caplet.server,
      downstreamUri: entry.downstreamUri,
    },
  };
}

function directResourceTemplateEntry(
  entry: DirectResourceTemplateRegistration,
): ExposureProjectionEntry {
  return {
    kind: "direct-resource-template",
    id: entry.uriTemplate,
    capletId: entry.caplet.server,
    title: entry.resourceTemplate.name,
    description: entry.resourceTemplate.description,
    ...(entry.resourceTemplate.mimeType ? { mimeType: entry.resourceTemplate.mimeType } : {}),
    shadowing: shadowingPolicy(entry.caplet),
    route: {
      kind: "direct-resource-template",
      capletId: entry.caplet.server,
      downstreamUriTemplate: entry.downstreamUriTemplate,
    },
  };
}

function directPromptEntry(entry: DirectPromptRegistration): ExposureProjectionEntry {
  const inputSchema = { arguments: entry.prompt.arguments ?? [] };
  return {
    kind: "direct-prompt",
    id: entry.name,
    capletId: entry.caplet.server,
    title: entry.prompt.name,
    description: entry.prompt.description,
    inputSchema,
    shadowing: shadowingPolicy(entry.caplet),
    route: {
      kind: "direct-prompt",
      capletId: entry.caplet.server,
      downstreamName: entry.downstreamName,
    },
  };
}

function completionEntries(snapshot: ExposureSnapshot): ExposureProjectionEntry[] {
  const caplets = new Map(
    [...snapshot.directPrompts, ...snapshot.directResourceTemplates].map((entry) => [
      entry.caplet.server,
      entry.caplet,
    ]),
  );
  return [...caplets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([capletId, caplet]) => ({
      kind: "completion" as const,
      id: `${capletId}:complete`,
      capletId,
      title: "Complete",
      description: `MCP completion for ${capletId}.`,
      shadowing: shadowingPolicy(caplet),
      route: { kind: "completion" as const, capletId },
    }));
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
    .replace(/(?:\/Users|\/home)\/[^\s,)]+/g, "[REDACTED_PATH]");
}

function sensitiveKey(key: string): boolean {
  return /(?:token|secret|credential|password|path)$/i.test(key);
}

function shadowingPolicy(caplet: { shadowing?: CapletShadowingPolicy | undefined }) {
  return caplet.shadowing ?? "forbid";
}
