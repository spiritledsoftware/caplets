import type { MediaArtifact } from "./artifacts";

export const MEDIA_ARTIFACT_MAX_BYTES = 100 * 1024 * 1024;
const COMMON_MEDIA_PROPERTY: Record<string, true> = {
  status: true,
  statusText: true,
  headers: true,
  kind: true,
  elapsedMs: true,
};
const FORBIDDEN_INLINE_ARTIFACT_PROPERTY: Record<string, false> = {
  uri: false,
  path: false,
  pathResolution: false,
  filename: false,
  mimeType: false,
  byteLength: false,
  sha256: false,
};

export type MediaArtifactFacts = {
  uri: string;
  filename: string;
  mimeType?: string;
  byteLength: number;
  sha256: string;
};

export type InlineMediaResult = {
  kind: "inline";
  body?: unknown;
  uri?: never;
  path?: never;
  pathResolution?: never;
};

export type LocalArtifactMediaResult = MediaArtifactFacts & {
  kind: "local-artifact";
  path: string;
  pathResolution?: never;
};

export type RemoteReferenceMediaResult = MediaArtifactFacts & {
  kind: "remote-reference";
  path?: never;
  pathResolution?: never;
};

export type MediaResult = InlineMediaResult | LocalArtifactMediaResult | RemoteReferenceMediaResult;

export type HttpLikeMediaResult = {
  status: number;
  statusText: string;
  headers: { "content-type": string };
} & MediaResult;

export function mediaResultForArtifact(
  artifact: MediaArtifact,
): LocalArtifactMediaResult | RemoteReferenceMediaResult {
  const { path, ...facts } = artifact;
  return path ? { kind: "local-artifact", path, ...facts } : { kind: "remote-reference", ...facts };
}

export function httpLikeMediaOutputSchema(
  inlineSchema: Record<string, unknown>,
): Record<string, unknown> {
  const inlineProperties = isRecord(inlineSchema.properties) ? inlineSchema.properties : {};
  const inlineRequired = Array.isArray(inlineSchema.required)
    ? inlineSchema.required.filter((value): value is string => typeof value === "string")
    : [];
  const commonRequired = ["status", "statusText", "headers", "kind"];
  const artifactRequired = [...commonRequired, "uri", "filename", "byteLength", "sha256"];
  const inlineOnlyProperties = Object.fromEntries(
    Object.keys(inlineProperties)
      .filter((name) => !COMMON_MEDIA_PROPERTY[name])
      .map((name) => [name, false] as const),
  );

  return {
    ...inlineSchema,
    type: "object",
    required: commonRequired,
    properties: {
      ...inlineProperties,
      status: inlineProperties.status ?? { type: "number" },
      statusText: inlineProperties.statusText ?? { type: "string" },
      headers: inlineProperties.headers ?? {
        type: "object",
        additionalProperties: false,
        required: ["content-type"],
        properties: { "content-type": { type: "string" } },
      },
      kind: { enum: ["inline", "local-artifact", "remote-reference"] },
      uri: { type: "string" },
      path: { type: "string" },
      filename: { type: "string" },
      mimeType: { type: "string" },
      byteLength: { type: "number" },
      sha256: { type: "string" },
      elapsedMs: { type: "number" },
    },
    oneOf: [
      {
        properties: {
          kind: { const: "inline" },
          ...FORBIDDEN_INLINE_ARTIFACT_PROPERTY,
        },
        required: inlineRequired.includes("kind") ? inlineRequired : [...inlineRequired, "kind"],
      },
      {
        properties: {
          ...inlineOnlyProperties,
          kind: { const: "local-artifact" },
          pathResolution: false,
        },
        required: [...artifactRequired, "path"],
      },
      {
        properties: {
          ...inlineOnlyProperties,
          kind: { const: "remote-reference" },
          path: false,
          pathResolution: false,
        },
        required: artifactRequired,
      },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
