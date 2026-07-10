import { httpLikeMediaOutputSchema } from "../media/results";
import { googleDiscoverySchemaToJsonSchema } from "./schema";
import type {
  GoogleDiscoveryDocument,
  GoogleDiscoveryMethod,
  GoogleDiscoveryParameter,
  GoogleDiscoveryResource,
  GoogleDiscoverySchema,
} from "./types";

type GoogleDiscoveryHttpMethod = "get" | "put" | "post" | "delete" | "patch" | "head";
type ParameterLocation = "path" | "query" | "header" | "body" | "media";

export type GoogleDiscoveryOperation = {
  name: string;
  method: GoogleDiscoveryHttpMethod;
  path: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  scopes: string[];
  supportsMediaUpload: boolean;
  supportsMediaDownload: boolean;
  mediaUpload?: {
    accept?: string[];
    maxSize?: string;
  };
  mediaUploadProtocols: Record<string, { path?: string; multipart?: boolean }>;
  parameterOrder: string[];
};

export type DiscoveryOperationsOptions = {
  server: string;
  document: unknown;
  includeOperations?: string[];
  excludeOperations?: string[];
};

type MethodEntry = {
  resourcePath: string[];
  methodKey: string;
  method: GoogleDiscoveryMethod;
};

export function discoveryOperations(
  options: DiscoveryOperationsOptions,
): GoogleDiscoveryOperation[] {
  const document = validateGoogleDiscoveryDocument(options.document);
  const schemas = document.schemas ?? {};
  const operations = collectDocumentMethods(document)
    .map((entry) => operationFromMethod(options.server, document, schemas, entry))
    .filter((operation) => isIncluded(operation.name, options.includeOperations))
    .filter((operation) => !isExcluded(operation.name, options.excludeOperations));

  return operations.sort((left, right) => left.name.localeCompare(right.name));
}

export function googleDiscoveryScopesForOperations(
  operations: GoogleDiscoveryOperation[],
): string[] {
  return [...new Set(operations.flatMap((operation) => operation.scopes))].sort();
}

function validateGoogleDiscoveryDocument(value: unknown): GoogleDiscoveryDocument {
  if (!isRecord(value)) {
    throw new Error("Invalid Google Discovery document: expected an object");
  }
  if (value.kind !== undefined && value.kind !== "discovery#restDescription") {
    throw new Error("Invalid Google Discovery document: expected kind discovery#restDescription");
  }
  if (value.resources !== undefined && !isRecord(value.resources)) {
    throw new Error("Invalid Google Discovery document: expected resources object");
  }
  if (value.methods !== undefined && !isRecord(value.methods)) {
    throw new Error("Invalid Google Discovery document: expected methods object");
  }
  if (!isRecord(value.resources) && !isRecord(value.methods)) {
    throw new Error("Invalid Google Discovery document: expected resources or methods object");
  }
  if (value.schemas !== undefined && !isRecord(value.schemas)) {
    throw new Error("Invalid Google Discovery document: expected schemas object");
  }
  if (value.parameters !== undefined && !isRecord(value.parameters)) {
    throw new Error("Invalid Google Discovery document: expected parameters object");
  }
  return value as GoogleDiscoveryDocument;
}

function collectDocumentMethods(document: GoogleDiscoveryDocument): MethodEntry[] {
  const topLevel = Object.entries(document.methods ?? {})
    .filter((entry): entry is [string, GoogleDiscoveryMethod] => isRecord(entry[1]))
    .map(([methodKey, method]) => ({ resourcePath: [], methodKey, method }));
  return [...topLevel, ...collectMethods(document.resources ?? {})];
}

function collectMethods(
  resources: Record<string, GoogleDiscoveryResource>,
  resourcePath: string[] = [],
): MethodEntry[] {
  const entries: MethodEntry[] = [];
  for (const [resourceName, resource] of Object.entries(resources)) {
    if (!isRecord(resource)) continue;
    const nextPath = [...resourcePath, resourceName];
    for (const [methodKey, method] of Object.entries(resource.methods ?? {})) {
      if (isRecord(method)) {
        entries.push({ resourcePath: nextPath, methodKey, method });
      }
    }
    entries.push(...collectMethods(resource.resources ?? {}, nextPath));
  }
  return entries;
}

function operationFromMethod(
  server: string,
  document: GoogleDiscoveryDocument,
  schemas: Record<string, GoogleDiscoverySchema>,
  entry: MethodEntry,
): GoogleDiscoveryOperation {
  const method = normalizedHttpMethod(entry.method.httpMethod);
  const name = entry.method.id ?? [server, ...entry.resourcePath, entry.methodKey].join(".");
  const scopes = selectGoogleDiscoveryScopes(entry.method.scopes);
  const inputSchema = buildInputSchema(document.parameters ?? {}, entry.method, schemas);
  const bodyOutputSchema = entry.method.response?.$ref
    ? googleDiscoverySchemaToJsonSchema(entry.method.response, schemas)
    : undefined;
  const outputSchema = bodyOutputSchema ? structuredOutputSchema(bodyOutputSchema) : undefined;
  const mediaUpload =
    entry.method.mediaUpload?.accept || entry.method.mediaUpload?.maxSize
      ? {
          ...(entry.method.mediaUpload.accept ? { accept: entry.method.mediaUpload.accept } : {}),
          ...(entry.method.mediaUpload.maxSize
            ? { maxSize: entry.method.mediaUpload.maxSize }
            : {}),
        }
      : undefined;

  return {
    name,
    method,
    path: entry.method.path ?? entry.method.flatPath ?? "",
    ...(entry.method.description
      ? { description: collapseWhitespace(entry.method.description) }
      : {}),
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    readOnlyHint: method === "get" || method === "head",
    destructiveHint: method === "delete" || /\.(delete|emptyTrash)$/u.test(name),
    scopes,
    supportsMediaUpload: entry.method.supportsMediaUpload === true,
    supportsMediaDownload: entry.method.supportsMediaDownload === true,
    ...(mediaUpload ? { mediaUpload } : {}),
    mediaUploadProtocols: mediaUploadProtocols(entry.method),
    parameterOrder: entry.method.parameterOrder ?? [],
  };
}

function mediaUploadProtocols(
  method: GoogleDiscoveryMethod,
): Record<string, { path?: string; multipart?: boolean }> {
  const protocols = { ...method.mediaUpload?.protocols };
  if (!protocols.multipart && protocols.simple?.multipart === true) {
    protocols.multipart = protocols.simple;
  }
  return protocols;
}

function selectGoogleDiscoveryScopes(scopes: string[] | undefined): string[] {
  const unique = [...new Set(scopes ?? [])].sort();
  const preferred = unique.toSorted(compareScopePreference)[0];
  return preferred ? [preferred] : [];
}

function compareScopePreference(left: string, right: string): number {
  const leftRank = scopePreferenceRank(left);
  const rightRank = scopePreferenceRank(right);
  return leftRank - rightRank || right.length - left.length || left.localeCompare(right);
}

function scopePreferenceRank(scope: string): number {
  const suffix = scope.toLowerCase().split("/").pop() ?? scope.toLowerCase();
  const tokens = suffix.split(/[._:-]+/u);
  if (tokens.includes("readonly")) return 0;
  if (tokens.includes("file")) return 1;
  if (tokens.includes("metadata") || tokens.includes("appdata")) return 2;
  if (tokens.includes("read")) return 3;
  if (suffix === "cloud-platform") return 5;
  return 4;
}

function structuredOutputSchema(bodySchema: Record<string, unknown>): Record<string, unknown> {
  return httpLikeMediaOutputSchema({
    type: "object",
    additionalProperties: false,
    required: ["status", "statusText", "headers"],
    properties: {
      status: { type: "number" },
      statusText: { type: "string" },
      headers: {
        type: "object",
        additionalProperties: false,
        required: ["content-type"],
        properties: {
          "content-type": { type: "string" },
        },
      },
      body: bodySchema,
    },
  });
}

function buildInputSchema(
  globalParameters: Record<string, GoogleDiscoveryParameter>,
  method: GoogleDiscoveryMethod,
  schemas: Record<string, GoogleDiscoverySchema>,
): Record<string, unknown> {
  const groups = new Map<ParameterLocation, Record<string, unknown>>();
  const requiredByGroup = new Map<ParameterLocation, string[]>();
  const parameters = { ...globalParameters, ...method.parameters };

  for (const [name, parameter] of Object.entries(parameters)) {
    const location = parameter.location ?? "query";
    const group = groups.get(location) ?? {};
    group[name] = googleDiscoverySchemaToJsonSchema(parameter, schemas);
    groups.set(location, group);
    if (parameter.required === true) {
      const required = requiredByGroup.get(location) ?? [];
      required.push(name);
      requiredByGroup.set(location, required);
    }
  }

  if (method.request?.$ref) {
    groups.set("body", googleDiscoverySchemaToJsonSchema(method.request, schemas));
  }
  if (method.supportsMediaUpload === true) {
    groups.set("media", {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        artifact: { type: "string" },
        dataUrl: { type: "string" },
        mimeType: { type: "string" },
        filename: { type: "string" },
      },
    });
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const location of ["path", "query", "header", "body", "media"] as const) {
    const group = groups.get(location);
    if (!group) continue;
    if ((location === "body" || location === "media") && isJsonSchemaObject(group)) {
      properties[location] = group;
    } else {
      const groupRequired = requiredByGroup.get(location) ?? [];
      properties[location] = {
        type: "object",
        ...(groupRequired.length > 0 ? { required: groupRequired } : {}),
        properties: group,
        additionalProperties: false,
      };
    }
    if (location === "path" || requiredByGroup.has(location)) {
      required.push(location);
    }
  }
  if (method.supportsMediaDownload === true) {
    properties.filename = { type: "string" };
    properties.outputPath = { type: "string" };
  }

  return {
    type: "object",
    ...(required.length > 0 ? { required } : {}),
    properties,
    additionalProperties: false,
  };
}

function normalizedHttpMethod(method: string | undefined): GoogleDiscoveryHttpMethod {
  const normalized = method?.toLowerCase();
  if (
    normalized === "get" ||
    normalized === "put" ||
    normalized === "post" ||
    normalized === "delete" ||
    normalized === "patch" ||
    normalized === "head"
  ) {
    return normalized;
  }
  return "get";
}

function isIncluded(name: string, includeOperations: string[] | undefined): boolean {
  return (
    !includeOperations?.length || includeOperations.some((pattern) => globMatches(pattern, name))
  );
}

function isExcluded(name: string, excludeOperations: string[] | undefined): boolean {
  return excludeOperations?.some((pattern) => globMatches(pattern, name)) === true;
}

function globMatches(pattern: string, name: string): boolean {
  const patternSegments = pattern.split(".");
  const nameSegments = name.split(".");
  if (patternSegments[0] === "*" && patternSegments.length < nameSegments.length) {
    const suffix = patternSegments.slice(1);
    return suffix.every(
      (segment, index) => segment === nameSegments[nameSegments.length - suffix.length + index],
    );
  }
  if (patternSegments.length !== nameSegments.length) return false;
  return patternSegments.every(
    (segment, index) => segment === "*" || segment === nameSegments[index],
  );
}

function isJsonSchemaObject(value: Record<string, unknown>): boolean {
  return value.type === "object" || "properties" in value || "additionalProperties" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
