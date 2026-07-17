import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { stringify as stringifyYaml } from "yaml";
import { parseCapletFileDocument, type CapletFileFrontmatter } from "../../caplet-files-bundle";
import { isSafeCatalogIconValue } from "../../catalog/icon";
import { stableJsonStringify } from "../../stable-json";
import { CANONICAL_MODEL_VERSION } from "../model";
import {
  PORTABLE_BACKEND_KINDS,
  PORTABLE_CAPLET_TOP_LEVEL_FIELDS,
  PORTABLE_CAPLET_VERSION,
  type PortableAssetRole,
  type PortableCaplet,
  type PortableCapletAsset,
  type PortableDeclaredInput,
  type PortableJson,
  type PortableReference,
} from "./model";

const DEFAULT_MAX_ENVELOPE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ASSET_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILES = 4096;
const PORTABLE_TOP_LEVEL_FIELDS: Record<string, true> = Object.fromEntries(
  PORTABLE_CAPLET_TOP_LEVEL_FIELDS.map((key) => [key, true]),
);
const PORTABLE_ASSET_ROLES: readonly PortableAssetRole[] = [
  "asset",
  "icon",
  "document",
  "openapi",
  "graphql-schema",
  "graphql-operation",
  "config",
];
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u;
const INTERPOLATION = /\$\{[^}]+\}|\$env:/iu;
const PRIVATE_172_HOST = /^172\.(\d{1,3})\./u;

export type PortableCapletBundleFile = {
  path: string;
  role: PortableAssetRole;
  mediaType: string;
  content: Uint8Array;
  sourceKind?: "file" | "symlink" | "hardlink" | "device";
};

export type PortableCapletBundle = {
  entryPath: string;
  frontmatter: {
    id: string;
    name: string;
    description: string;
    backend: { kind: (typeof PORTABLE_BACKEND_KINDS)[number]; config: PortableJson };
    catalog?: PortableCaplet["frontmatter"]["catalog"];
    declaredInputs: PortableDeclaredInput[];
    [key: string]: unknown;
  };
  sourceFrontmatter?: PortableJson;
  body: string;
  files: PortableCapletBundleFile[];
  references: PortableReference[];
};

export type PortableCodecLimits = {
  maxEnvelopeBytes?: number;
  maxAssetBytes?: number;
  maxFiles?: number;
};

export type EncodedPortableCapletArtifact = Readonly<{
  bytes: Uint8Array;
  mimeType: "text/markdown; charset=utf-8" | "application/zip";
  artifactType: "file" | "bundle";
  suggestedName: string;
}>;

type PortableArtifactAssetMetadata = Omit<PortableCapletAsset, "encoding" | "content">;
type PortableArtifactMetadata = Readonly<{
  portableVersion: typeof PORTABLE_CAPLET_VERSION;
  canonicalModelVersion: typeof CANONICAL_MODEL_VERSION;
  id: string;
  sourcePath: string;
  catalog?: PortableCaplet["frontmatter"]["catalog"];
  declaredInputs: PortableDeclaredInput[];
  additionalReferences: PortableReference[];
  assets: PortableArtifactAssetMetadata[];
}>;
export type PortableCapletDocumentInput = {
  id: string;
  path: string;
  text: string;
  files: PortableCapletBundleFile[];
  declaredInputs?: PortableDeclaredInput[];
  references?: PortableReference[];
};

export const PORTABLE_BACKEND_SOURCE_REGISTRY = {
  mcpServer: { kind: "mcp", cardinality: "singular" },
  mcpServers: { kind: "mcp", cardinality: "plural" },
  openapiEndpoint: { kind: "openapi", cardinality: "singular" },
  openapiEndpoints: { kind: "openapi", cardinality: "plural" },
  googleDiscoveryApi: { kind: "googleDiscovery", cardinality: "singular" },
  googleDiscoveryApis: { kind: "googleDiscovery", cardinality: "plural" },
  graphqlEndpoint: { kind: "graphql", cardinality: "singular" },
  graphqlEndpoints: { kind: "graphql", cardinality: "plural" },
  httpApi: { kind: "http", cardinality: "singular" },
  httpApis: { kind: "http", cardinality: "plural" },
  cliTools: { kind: "cli", cardinality: "singular-or-plural" },
  capletSet: { kind: "caplets", cardinality: "singular" },
  capletSets: { kind: "caplets", cardinality: "plural" },
} as const satisfies Record<
  string,
  {
    kind: Exclude<(typeof PORTABLE_BACKEND_KINDS)[number], "mixed">;
    cardinality: "singular" | "plural" | "singular-or-plural";
  }
>;

export type PortableBackendSourceDefinition =
  (typeof PORTABLE_BACKEND_SOURCE_REGISTRY)[keyof typeof PORTABLE_BACKEND_SOURCE_REGISTRY];

export function portableBackendSourceDefinition(
  sourceField: string,
): PortableBackendSourceDefinition | undefined {
  return Object.hasOwn(PORTABLE_BACKEND_SOURCE_REGISTRY, sourceField)
    ? PORTABLE_BACKEND_SOURCE_REGISTRY[sourceField as keyof typeof PORTABLE_BACKEND_SOURCE_REGISTRY]
    : undefined;
}

export function portableCapletFromCapletDocument(
  input: PortableCapletDocumentInput,
  limits: PortableCodecLimits = {},
): PortableCaplet {
  const document = parseCapletFileDocument(input.path, input.text);
  const extractedReferences: PortableReference[] = [];
  const sourceFrontmatter = portableSourceProjection(document.frontmatter, extractedReferences);
  const backendEntries = Object.entries(sourceFrontmatter).filter(([key]) =>
    portableBackendSourceDefinition(key),
  );
  const backendKinds = [
    ...new Set(
      backendEntries.map(([key]) => {
        const definition = portableBackendSourceDefinition(key);
        if (!definition) throw new Error(`Unsupported portable backend field ${key}`);
        return definition.kind;
      }),
    ),
  ];
  if (backendKinds.length === 0) throw new Error("Portable source has no backend");
  const icon = document.frontmatter.catalog?.icon;
  let catalog: PortableCaplet["frontmatter"]["catalog"];
  if (icon) {
    catalog = icon.startsWith("https:")
      ? { icon: { type: "external", url: icon } }
      : { icon: { type: "local", path: canonicalPortablePath(icon) } };
  }
  return portableCapletFromBundle(
    {
      entryPath: input.path,
      frontmatter: {
        id: input.id,
        name: document.frontmatter.name,
        description: document.frontmatter.description,
        backend: {
          kind: backendKinds.length === 1 ? backendKinds[0]! : "mixed",
          config: Object.fromEntries(backendEntries) as PortableJson,
        },
        ...(catalog ? { catalog } : {}),
        declaredInputs: input.declaredInputs ?? [],
      },
      sourceFrontmatter,
      body: document.body,
      files: input.files,
      references: [...(input.references ?? []), ...extractedReferences],
    },
    limits,
  );
}

const FRONTMATTER_FIELDS: Record<string, true> = {
  id: true,
  name: true,
  description: true,
  backend: true,
  catalog: true,
  declaredInputs: true,
};

export function portableCapletFromBundle(
  bundle: PortableCapletBundle,
  limits: PortableCodecLimits = {},
): PortableCaplet {
  assertExactKeys(bundle.frontmatter, FRONTMATTER_FIELDS, "frontmatter", true);
  const entryPath = canonicalPortablePath(bundle.entryPath);
  if (bundle.files.length > (limits.maxFiles ?? DEFAULT_MAX_FILES))
    throw new Error("Portable file count limit exceeded");
  assertSafeText(bundle.body, "body");
  assertIdentifier(bundle.frontmatter.id, "id");
  assertNonEmpty(bundle.frontmatter.name, "name");
  assertNonEmpty(bundle.frontmatter.description, "description");
  if (!PORTABLE_BACKEND_KINDS.includes(bundle.frontmatter.backend.kind))
    throw new Error("Unsupported portable backend kind");
  assertPortableValue(bundle.frontmatter.backend.config, "backend.config");
  const sourceFrontmatter =
    bundle.sourceFrontmatter ?? (bundle.frontmatter as unknown as PortableJson);
  assertPortableValue(sourceFrontmatter, "frontmatter");

  const seen = new Map<string, string>();
  seen.set(collisionKey(entryPath), entryPath);
  const assets = bundle.files
    .map((file) => {
      if (file.sourceKind && file.sourceKind !== "file")
        throw new Error(`Unsafe ${file.sourceKind} portable source`);
      const path = canonicalPortablePath(file.path);
      assertNoCollision(path, seen);
      if (file.content.byteLength > (limits.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES))
        throw new Error(`Portable asset size limit exceeded for ${path}`);
      return assetFromBytes(path, file);
    })
    .sort(comparePath);

  const assetPaths = new Set(assets.map((asset) => asset.path));
  validateBodyLinks(bundle.body, assetPaths);
  const references = bundle.references.map(normalizeReference).sort(compareReference);
  for (const reference of references) {
    if (reference.type === "local" && !assetPaths.has(reference.path))
      throw new Error(`Dangling portable reference ${reference.path}`);
  }
  const declaredInputs = bundle.frontmatter.declaredInputs
    .map((input) => normalizeDeclaredInput(input, assetPaths))
    .sort((left, right) => left.name.localeCompare(right.name));
  const catalog = normalizeCatalog(bundle.frontmatter.catalog, assetPaths);

  const model: PortableCaplet = {
    portableVersion: PORTABLE_CAPLET_VERSION,
    canonicalModelVersion: CANONICAL_MODEL_VERSION,
    id: bundle.frontmatter.id.normalize("NFC"),
    name: normalizeNewlines(bundle.frontmatter.name).normalize("NFC"),
    description: normalizeNewlines(bundle.frontmatter.description).normalize("NFC"),
    sourcePath: entryPath,
    frontmatter: {
      source: normalizePortableValue(sourceFrontmatter),
      backend: {
        kind: bundle.frontmatter.backend.kind,
        config: normalizePortableValue(bundle.frontmatter.backend.config),
      },
      ...(catalog ? { catalog } : {}),
      declaredInputs,
    },
    body: normalizeNewlines(bundle.body).normalize("NFC"),
    assets,
    references,
  };
  assertEnvelopeLimit(model, limits);
  return model;
}

export function encodePortableCaplet(
  model: PortableCaplet,
  limits: PortableCodecLimits = {},
): Uint8Array {
  validatePortableCaplet(model, limits);
  const bytes = new TextEncoder().encode(`${stableJsonStringify(model)}\n`);
  if (bytes.byteLength > (limits.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES))
    throw new Error("Portable envelope size limit exceeded");
  return bytes;
}

export function decodePortableCaplet(
  bytes: Uint8Array,
  limits: PortableCodecLimits = {},
): PortableCaplet {
  if (bytes.byteLength > (limits.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES))
    throw new Error("Portable envelope size limit exceeded");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(
      `Invalid portable envelope: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  validatePortableCaplet(value, limits);
  return value;
}

export function encodePortableCapletArtifact(
  model: PortableCaplet,
  limits: PortableCodecLimits = {},
): EncodedPortableCapletArtifact {
  validatePortableCaplet(model, limits);
  const markdown = encodePortableArtifactMarkdown(model, limits);
  if (model.assets.length === 0) {
    assertArtifactByteLimit(markdown, limits);
    return {
      bytes: markdown,
      mimeType: "text/markdown; charset=utf-8",
      artifactType: "file",
      suggestedName: `${model.id}.md`,
    };
  }
  const root = `${model.id}/`;
  const bytes = encodeStoredZip([
    { path: `${root}CAPLET.md`, content: markdown },
    ...model.assets.map((asset) => ({
      path: `${root}${asset.path}`,
      content: Uint8Array.from(Buffer.from(asset.content, "base64")),
    })),
  ]);
  assertArtifactByteLimit(bytes, limits);
  return {
    bytes,
    mimeType: "application/zip",
    artifactType: "bundle",
    suggestedName: `${model.id}.caplet.zip`,
  };
}

export function decodePortableCapletArtifact(
  bytes: Uint8Array,
  limits: PortableCodecLimits = {},
): PortableCaplet {
  assertArtifactByteLimit(bytes, limits);
  const zip =
    bytes.byteLength >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04;
  return zip
    ? decodePortableZipArtifact(bytes, limits)
    : portableCapletFromArtifactMarkdown(parsePortableArtifactMarkdown(bytes, limits), [], limits);
}

export function validatePortableCaplet(
  value: unknown,
  limits: PortableCodecLimits = {},
): asserts value is PortableCaplet {
  if (!isObject(value)) throw new Error("Portable Caplet must be an object");
  assertExactKeys(value, PORTABLE_TOP_LEVEL_FIELDS, "portable Caplet");
  if (
    value.portableVersion !== PORTABLE_CAPLET_VERSION ||
    value.canonicalModelVersion !== CANONICAL_MODEL_VERSION
  )
    throw new Error("Unsupported portable model version");
  assertIdentifier(value.id, "id");
  assertNonEmpty(value.name, "name");
  assertNonEmpty(value.description, "description");
  const sourcePath = canonicalPortablePath(value.sourcePath);
  if (sourcePath !== value.sourcePath) throw new Error("Portable source path is not canonical");
  assertSafeText(value.body, "body");
  if (normalizeNewlines(value.body).normalize("NFC") !== value.body)
    throw new Error("Portable body is not canonical");
  if (!isObject(value.frontmatter)) throw new Error("Portable frontmatter is invalid");
  assertExactKeys(
    value.frontmatter,
    { source: true, backend: true, catalog: true, declaredInputs: true },
    "portable frontmatter",
    true,
  );
  assertPortableValue(value.frontmatter.source, "frontmatter.source");
  if (
    stableJsonStringify(normalizePortableValue(value.frontmatter.source)) !==
    stableJsonStringify(value.frontmatter.source)
  )
    throw new Error("Portable source frontmatter is not canonical");
  if (!isObject(value.frontmatter.backend)) throw new Error("Portable backend is invalid");
  assertExactKeys(value.frontmatter.backend, { kind: true, config: true }, "portable backend");
  if (
    typeof value.frontmatter.backend.kind !== "string" ||
    !PORTABLE_BACKEND_KINDS.includes(value.frontmatter.backend.kind as never)
  )
    throw new Error("Unsupported portable backend kind");
  assertPortableValue(value.frontmatter.backend.config, "backend.config");
  if (!Array.isArray(value.assets) || value.assets.length > (limits.maxFiles ?? DEFAULT_MAX_FILES))
    throw new Error("Portable file count limit exceeded");
  const seen = new Map<string, string>([[collisionKey(sourcePath), sourcePath]]);
  for (const rawAsset of value.assets) validateAsset(rawAsset, seen, limits);
  if (
    (value.assets as PortableCapletAsset[]).some(
      (asset, index, assets) => index > 0 && assets[index - 1]!.path.localeCompare(asset.path) > 0,
    )
  )
    throw new Error("Portable assets are not canonically ordered");
  const paths = new Set((value.assets as PortableCapletAsset[]).map((asset) => asset.path));
  validateBodyLinks(value.body, paths);
  if (!Array.isArray(value.references)) throw new Error("Portable references must be an array");
  const normalizedReferences = value.references
    .map((rawReference) => {
      const normalized = normalizeReference(rawReference as PortableReference);
      if (normalized.type === "local" && !paths.has(normalized.path))
        throw new Error(`Dangling portable reference ${normalized.path}`);
      return normalized;
    })
    .sort(compareReference);
  if (stableJsonStringify(normalizedReferences) !== stableJsonStringify(value.references))
    throw new Error("Portable references are not canonical");
  if (!Array.isArray(value.frontmatter.declaredInputs))
    throw new Error("Portable declared inputs must be an array");
  const normalizedInputs = value.frontmatter.declaredInputs
    .map((input) => normalizeDeclaredInput(input as PortableDeclaredInput, paths))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (
    stableJsonStringify(normalizedInputs) !== stableJsonStringify(value.frontmatter.declaredInputs)
  )
    throw new Error("Portable declared inputs are not canonical");
  const normalizedCatalog = normalizeCatalog(
    value.frontmatter.catalog as PortableCaplet["frontmatter"]["catalog"],
    paths,
  );
  if (stableJsonStringify(normalizedCatalog) !== stableJsonStringify(value.frontmatter.catalog))
    throw new Error("Portable catalog metadata is not canonical");
  assertEnvelopeLimit(value as unknown as PortableCaplet, limits);
}

export function canonicalPortablePath(value: unknown): string {
  if (typeof value !== "string") throw new Error("Portable path must be a string");
  const candidate = value.trim().replace(/\\/g, "/").replace(/^\.\//u, "").normalize("NFC");
  if (
    !candidate ||
    candidate.startsWith("/") ||
    /^[A-Za-z]:\//u.test(candidate) ||
    INTERPOLATION.test(candidate)
  )
    throw new Error(`Unsafe portable path ${value}`);
  const segments = candidate.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."))
    throw new Error(`Portable path traversal ${value}`);
  return segments.join("/");
}

export function allocatePortablePath(
  desiredPath: string,
  occupiedPaths: readonly string[],
): string {
  const desired = canonicalPortablePath(desiredPath);
  const occupied = new Set(occupiedPaths.map((path) => collisionKey(canonicalPortablePath(path))));
  if (!occupied.has(collisionKey(desired))) return desired;
  const slash = desired.lastIndexOf("/");
  const directory = slash >= 0 ? desired.slice(0, slash + 1) : "";
  const file = slash >= 0 ? desired.slice(slash + 1) : desired;
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const extension = dot > 0 ? file.slice(dot) : "";
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${directory}${stem}-${suffix}${extension}`;
    if (!occupied.has(collisionKey(candidate))) return candidate;
  }
}

function validateAsset(
  raw: unknown,
  seen: Map<string, string>,
  limits: PortableCodecLimits,
): asserts raw is PortableCapletAsset {
  if (!isObject(raw)) throw new Error("Portable asset is invalid");
  assertExactKeys(
    raw,
    {
      path: true,
      role: true,
      mediaType: true,
      encoding: true,
      content: true,
      contentHash: true,
      byteLength: true,
    },
    "portable asset",
  );
  const path = canonicalPortablePath(raw.path);
  if (path !== raw.path) throw new Error("Portable asset path is not canonical");
  assertNoCollision(path, seen);
  if (
    typeof raw.role !== "string" ||
    !PORTABLE_ASSET_ROLES.includes(raw.role as PortableAssetRole)
  ) {
    throw new Error("Unsupported portable asset role");
  }
  assertNonEmpty(raw.mediaType, "asset media type");
  if (raw.encoding !== "base64" || typeof raw.content !== "string")
    throw new Error("Portable asset encoding is invalid");
  const bytes = Uint8Array.from(Buffer.from(raw.content, "base64"));
  if (bytes.byteLength > (limits.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES))
    throw new Error(`Portable asset size limit exceeded for ${path}`);
  if (
    raw.byteLength !== bytes.byteLength ||
    raw.contentHash !== sha256(bytes) ||
    Buffer.from(bytes).toString("base64") !== raw.content
  )
    throw new Error(`Portable asset integrity failure for ${path}`);
}

function assetFromBytes(path: string, file: PortableCapletBundleFile): PortableCapletAsset {
  assertNonEmpty(file.mediaType, "asset media type");
  return {
    path,
    role: file.role,
    mediaType: file.mediaType.toLowerCase(),
    encoding: "base64",
    content: Buffer.from(file.content).toString("base64"),
    contentHash: sha256(file.content),
    byteLength: file.content.byteLength,
  };
}

function normalizeReference(reference: PortableReference): PortableReference {
  if (!isObject(reference) || typeof reference.type !== "string")
    throw new Error("Portable reference is invalid");
  if (reference.type === "local") {
    assertExactKeys(reference, { type: true, owner: true, path: true }, "local reference");
    assertNonEmpty(reference.owner, "reference owner");
    return {
      type: "local",
      owner: reference.owner.normalize("NFC"),
      path: canonicalPortablePath(reference.path),
    };
  }
  if (reference.type === "external") {
    assertExactKeys(reference, { type: true, owner: true, url: true }, "external reference");
    assertNonEmpty(reference.owner, "reference owner");
    return {
      type: "external",
      owner: reference.owner.normalize("NFC"),
      url: safeExternalUrl(reference.url),
    };
  }
  if (reference.type === "unresolved-setup") {
    assertExactKeys(reference, { type: true, owner: true, name: true }, "setup reference");
    assertNonEmpty(reference.owner, "reference owner");
    if (typeof reference.name !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(reference.name))
      throw new Error("Invalid unresolved setup name");
    return {
      type: "unresolved-setup",
      owner: reference.owner.normalize("NFC"),
      name: reference.name,
    };
  }
  throw new Error("Unsupported portable reference type");
}

function normalizeDeclaredInput(
  input: PortableDeclaredInput,
  paths: Set<string>,
): PortableDeclaredInput {
  if (!isObject(input)) throw new Error("Portable declared input is invalid");
  assertExactKeys(input, { name: true, reference: true }, "declared input");
  assertIdentifier(input.name, "declared input name");
  if (!isObject(input.reference) || typeof input.reference.type !== "string")
    throw new Error("Declared input reference is invalid");
  const normalized = normalizeReference({
    ...input.reference,
    owner: `declared-input:${input.name}`,
  } as PortableReference);
  if (normalized.type === "local" && !paths.has(normalized.path))
    throw new Error(`Dangling portable reference ${normalized.path}`);
  const { owner: _owner, ...reference } = normalized;
  return { name: input.name.normalize("NFC"), reference };
}

function normalizeCatalog(
  catalog: PortableCaplet["frontmatter"]["catalog"],
  paths: Set<string>,
): PortableCaplet["frontmatter"]["catalog"] {
  if (catalog === undefined) return undefined;
  if (!isObject(catalog)) throw new Error("Portable catalog metadata is invalid");
  assertExactKeys(
    catalog,
    { displayName: true, summary: true, tags: true, icon: true },
    "catalog metadata",
    true,
  );
  if (catalog.displayName !== undefined)
    assertNonEmpty(catalog.displayName, "catalog display name");
  if (catalog.summary !== undefined) assertNonEmpty(catalog.summary, "catalog summary");
  if (
    catalog.tags !== undefined &&
    (!Array.isArray(catalog.tags) ||
      catalog.tags.some((tag) => typeof tag !== "string" || !tag.trim()))
  )
    throw new Error("Invalid catalog tags");
  if (catalog.icon) {
    if (catalog.icon.type === "local") {
      const path = canonicalPortablePath(catalog.icon.path);
      if (!paths.has(path) || !isSafeCatalogIconValue(path))
        throw new Error("Invalid or dangling catalog icon");
    } else if (catalog.icon.type === "external") {
      if (!isSafeCatalogIconValue(catalog.icon.url))
        throw new Error("Unsafe external catalog icon");
    } else throw new Error("Unsupported catalog icon reference");
  }
  return {
    ...(catalog.displayName
      ? { displayName: normalizeNewlines(catalog.displayName).normalize("NFC") }
      : {}),
    ...(catalog.summary ? { summary: normalizeNewlines(catalog.summary).normalize("NFC") } : {}),
    ...(catalog.tags
      ? { tags: [...new Set(catalog.tags.map((tag) => tag.normalize("NFC")))].sort() }
      : {}),
    ...(catalog.icon?.type === "local"
      ? { icon: { type: "local" as const, path: canonicalPortablePath(catalog.icon.path) } }
      : {}),
    ...(catalog.icon?.type === "external"
      ? { icon: { type: "external" as const, url: catalog.icon.url } }
      : {}),
  };
}

const PORTABLE_COMMON_SOURCE_FIELDS: Record<string, true> = {
  $schema: true,
  name: true,
  description: true,
  tags: true,
  exposure: true,
  shadowing: true,
  setup: true,
  projectBinding: true,
  runtime: true,
  auth: true,
  catalog: true,
};
const PORTABLE_OPAQUE_JSON_FIELDS: Record<string, true> = {
  inputSchema: true,
  outputSchema: true,
  query: true,
  jsonBody: true,
};
const PORTABLE_LITERAL_ACTION_HEADERS: Record<string, true> = {
  accept: true,
  "content-type": true,
};
const SETUP_REFERENCE = /^(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$env:([A-Za-z_][A-Za-z0-9_]*))$/u;

function portableSourceProjection(
  frontmatter: CapletFileFrontmatter,
  references: PortableReference[],
): Record<string, PortableJson> {
  const result: Record<string, PortableJson> = {};
  for (const [key, item] of Object.entries(frontmatter)) {
    if (
      !Object.hasOwn(PORTABLE_COMMON_SOURCE_FIELDS, key) &&
      !portableBackendSourceDefinition(key)
    ) {
      throw new Error(`Unsupported portable source field ${key}`);
    }
    result[key.normalize("NFC")] = portableSchemaValue(item, `frontmatter.${key}`, references);
  }
  return result;
}

function portableSchemaValue(
  value: unknown,
  path: string,
  references: PortableReference[],
): PortableJson {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return portableString(value, path);
  if (Array.isArray(value)) {
    return value.map((item, index) => portableSchemaValue(item, `${path}[${index}]`, references));
  }
  if (!isObject(value)) throw new Error(`Unsupported value at ${path}`);
  const result: Record<string, PortableJson> = {};
  for (const [key, item] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (Object.hasOwn(PORTABLE_OPAQUE_JSON_FIELDS, key)) {
      result[key.normalize("NFC")] = portableJsonValue(item, childPath);
      continue;
    }
    if (key === "env") {
      result[key] = portableCredentialMap(item, childPath, references, false);
      continue;
    }
    if (key === "headers") {
      result[key] = portableCredentialMap(item, childPath, references, !path.endsWith(".auth"));
      continue;
    }
    if ((key === "token" || key === "clientSecret") && path.endsWith(".auth")) {
      result[key] = portableCredentialValue(item, childPath, references);
      continue;
    }
    result[key.normalize("NFC")] = portableSchemaValue(item, childPath, references);
  }
  return result;
}

function portableCredentialMap(
  value: unknown,
  path: string,
  references: PortableReference[],
  allowPublicActionHeaders: boolean,
): PortableJson {
  if (!isObject(value)) throw new Error(`Portable credential map is malformed at ${path}`);
  const result: Record<string, PortableJson> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      allowPublicActionHeaders &&
      Object.hasOwn(PORTABLE_LITERAL_ACTION_HEADERS, key.toLowerCase())
    ) {
      result[key.normalize("NFC")] = portableJsonValue(item, `${path}.${key}`);
      continue;
    }
    result[key.normalize("NFC")] = portableCredentialValue(item, `${path}.${key}`, references);
  }
  return result;
}

function portableCredentialValue(
  value: unknown,
  path: string,
  references: PortableReference[],
): string {
  const match = typeof value === "string" ? SETUP_REFERENCE.exec(value) : undefined;
  const name = match?.[1] ?? match?.[2];
  if (typeof value !== "string" || !name) {
    throw new Error(`Portable credential at ${path} must be an unresolved environment reference`);
  }
  references.push({ type: "unresolved-setup", owner: path, name });
  return portableString(value, path);
}

function portableJsonValue(value: unknown, path: string): PortableJson {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return portableString(value, path);
  if (Array.isArray(value)) {
    return value.map((item, index) => portableJsonValue(item, `${path}[${index}]`));
  }
  if (!isObject(value)) throw new Error(`Unsupported value at ${path}`);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.normalize("NFC"),
      portableJsonValue(item, `${path}.${key}`),
    ]),
  );
}

function portableString(value: string, path: string): string {
  assertSafeText(value, path);
  return normalizeNewlines(value).normalize("NFC");
}

function assertPortableValue(value: unknown, path: string): asserts value is PortableJson {
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    assertSafeText(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPortableValue(item, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) throw new Error(`Unsupported value at ${path}`);
  for (const [key, item] of Object.entries(value)) {
    assertPortableValue(item, `${path}.${key}`);
  }
}

function normalizePortableValue(value: PortableJson): PortableJson {
  if (typeof value === "string") return normalizeNewlines(value).normalize("NFC");
  if (Array.isArray(value)) return value.map(normalizePortableValue);
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key.normalize("NFC"), normalizePortableValue(item as PortableJson)]),
    );
  return value;
}

function assertSafeText(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  if (PRIVATE_KEY.test(value)) throw new Error(`Private key content is not portable at ${path}`);
  if (
    /\b(?:postgres(?:ql)?|file):\/\//iu.test(value) ||
    /(?:^|\s)(?:\/[A-Za-z0-9_.-]+){2,}/u.test(value)
  )
    throw new Error(`Host-specific path or deployment value is not portable at ${path}`);
}

function validateBodyLinks(body: string, assetPaths: Set<string>): void {
  for (const match of body.matchAll(/!?\[.*?\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu)) {
    const target = match[1]!;
    if (target.startsWith("#")) continue;
    if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) {
      safeExternalUrl(target);
      continue;
    }
    const path = canonicalPortablePath(target);
    if (!assetPaths.has(path)) throw new Error(`Dangling portable body reference ${path}`);
  }
}

function safeExternalUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("External URL must be a string");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid external URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || isPrivateHost(url.hostname))
    throw new Error("Unsafe external URL");
  return url.href;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.")
  )
    return true;
  const match = PRIVATE_172_HOST.exec(host);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: Record<string, true>,
  label: string,
  optional = false,
): void {
  for (const key of Object.keys(value))
    if (!Object.hasOwn(allowed, key)) throw new Error(`Unsupported ${label} field ${key}`);
  if (!optional)
    for (const key of Object.keys(allowed))
      if (!Object.hasOwn(value, key)) throw new Error(`Missing ${label} field ${key}`);
}

function assertNoCollision(path: string, seen: Map<string, string>): void {
  const key = collisionKey(path);
  const prior = seen.get(key);
  if (prior) throw new Error(`Portable path collision: ${prior} and ${path}`);
  seen.set(key, path);
}

function collisionKey(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}
function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function comparePath(left: PortableCapletAsset, right: PortableCapletAsset): number {
  return left.path.localeCompare(right.path);
}
function compareReference(left: PortableReference, right: PortableReference): number {
  return stableJsonStringify(left).localeCompare(stableJsonStringify(right));
}
function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be non-empty`);
}
function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value))
    throw new Error(`Invalid ${label}`);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function assertEnvelopeLimit(model: PortableCaplet, limits: PortableCodecLimits): void {
  const size = new TextEncoder().encode(stableJsonStringify(model)).byteLength;
  if (size > (limits.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES))
    throw new Error("Portable envelope size limit exceeded");
}

type PortableArtifactMarkdown = Readonly<{
  metadata: PortableArtifactMetadata;
  sourceText: string;
}>;
type PortableZipEntry = Readonly<{ path: string; content: Uint8Array }>;

const ARTIFACT_METADATA_FIELDS: Record<string, true> = {
  portableVersion: true,
  canonicalModelVersion: true,
  id: true,
  sourcePath: true,
  catalog: true,
  declaredInputs: true,
  additionalReferences: true,
  assets: true,
};
const ARTIFACT_ASSET_METADATA_FIELDS: Record<string, true> = {
  path: true,
  role: true,
  mediaType: true,
  contentHash: true,
  byteLength: true,
};
const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_FILE_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_DIRECTORY_MODE = 0x4000;
const ZIP_SYMLINK_MODE = 0xa000;
const ZIP_TYPE_MASK = 0xf000;
const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  return crc >>> 0;
});

function encodePortableArtifactMarkdown(
  model: PortableCaplet,
  limits: PortableCodecLimits,
): Uint8Array {
  if (!isObject(model.frontmatter.source)) {
    throw new Error("Portable source frontmatter cannot be emitted as a Caplet file");
  }
  const yaml = normalizeNewlines(
    stringifyYaml(model.frontmatter.source, {
      aliasDuplicateObjects: false,
      lineWidth: 0,
      sortMapEntries: true,
    }),
  );
  const sourceText = `---\n${yaml}---\n${model.body}`;
  const files = model.assets.map(portableBundleFileFromAsset);
  const baseline = portableCapletFromCapletDocument(
    {
      id: model.id,
      path: model.sourcePath,
      text: sourceText,
      files,
      declaredInputs: model.frontmatter.declaredInputs,
    },
    limits,
  );
  assertPortableArtifactBaseline(model, baseline);
  const additionalReferences = subtractReferences(model.references, baseline.references);
  const metadata: PortableArtifactMetadata = {
    portableVersion: model.portableVersion,
    canonicalModelVersion: model.canonicalModelVersion,
    id: model.id,
    sourcePath: model.sourcePath,
    ...(model.frontmatter.catalog ? { catalog: model.frontmatter.catalog } : {}),
    declaredInputs: model.frontmatter.declaredInputs,
    additionalReferences,
    assets: model.assets.map(({ encoding: _encoding, content: _content, ...asset }) => asset),
  };
  const canonicalMetadata = stableJsonStringify(metadata);
  const encodedMetadata = Buffer.from(canonicalMetadata).toString("base64url");
  return new TextEncoder().encode(
    sourceText.replace(
      /^---\n([\s\S]*?\n)---\n/u,
      `---\n$1---\n<!-- caplets-portable-v1:${encodedMetadata} -->\n`,
    ),
  );
}

function portableBundleFileFromAsset(asset: PortableCapletAsset): PortableCapletBundleFile {
  return {
    path: asset.path,
    role: asset.role,
    mediaType: asset.mediaType,
    content: Uint8Array.from(Buffer.from(asset.content, "base64")),
    sourceKind: "file",
  };
}

function assertPortableArtifactBaseline(model: PortableCaplet, baseline: PortableCaplet): void {
  for (const [label, actual, expected] of [
    ["name", baseline.name, model.name],
    ["description", baseline.description, model.description],
    ["source path", baseline.sourcePath, model.sourcePath],
    ["source frontmatter", baseline.frontmatter.source, model.frontmatter.source],
    ["backend", baseline.frontmatter.backend, model.frontmatter.backend],
    ["declared inputs", baseline.frontmatter.declaredInputs, model.frontmatter.declaredInputs],
    ["body", baseline.body, model.body],
    ["assets", baseline.assets, model.assets],
    ["catalog icon", baseline.frontmatter.catalog?.icon, model.frontmatter.catalog?.icon],
  ] as const) {
    if (stableJsonStringify(actual) !== stableJsonStringify(expected)) {
      throw new Error(`Portable ${label} cannot be represented by the emitted Caplet artifact`);
    }
  }
}

function subtractReferences(
  references: readonly PortableReference[],
  sourceReferences: readonly PortableReference[],
): PortableReference[] {
  const additional = [...references];
  for (const reference of sourceReferences) {
    const key = stableJsonStringify(reference);
    const index = additional.findIndex((candidate) => stableJsonStringify(candidate) === key);
    if (index < 0) {
      throw new Error(`Portable source setup reference ${reference.owner} is missing`);
    }
    additional.splice(index, 1);
  }
  return additional;
}

function parsePortableArtifactMarkdown(
  bytes: Uint8Array,
  limits: PortableCodecLimits,
): PortableArtifactMarkdown {
  assertArtifactByteLimit(bytes, limits);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(
      `Invalid portable Markdown: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const match = /^---\n[\s\S]*?\n---\n<!-- caplets-portable-v1:([A-Za-z0-9_-]+) -->\n/u.exec(text);
  const encodedMetadata = match?.[1];
  if (!match || !encodedMetadata) {
    throw new Error("Portable Markdown is missing canonical Caplet metadata");
  }
  const metadataBytes = Buffer.from(encodedMetadata, "base64url");
  if (metadataBytes.toString("base64url") !== encodedMetadata) {
    throw new Error("Portable Markdown metadata encoding is invalid");
  }
  let metadata: unknown;
  let metadataText: string;
  try {
    metadataText = new TextDecoder("utf-8", { fatal: true }).decode(metadataBytes);
    metadata = JSON.parse(metadataText);
  } catch (error) {
    throw new Error(
      `Invalid portable Markdown metadata: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (stableJsonStringify(metadata) !== metadataText) {
    throw new Error("Portable Markdown metadata is not canonical");
  }
  assertPortableArtifactMetadata(metadata, limits);
  const commentStart = match[0].lastIndexOf("<!--");
  return {
    metadata,
    sourceText: `${text.slice(0, commentStart)}${text.slice(match[0].length)}`,
  };
}

function assertPortableArtifactMetadata(
  value: unknown,
  limits: PortableCodecLimits,
): asserts value is PortableArtifactMetadata {
  if (!isObject(value)) throw new Error("Portable artifact metadata must be an object");
  assertExactKeys(value, ARTIFACT_METADATA_FIELDS, "portable artifact metadata", true);
  if (
    value.portableVersion !== PORTABLE_CAPLET_VERSION ||
    value.canonicalModelVersion !== CANONICAL_MODEL_VERSION
  ) {
    throw new Error("Unsupported portable artifact metadata version");
  }
  assertIdentifier(value.id, "artifact Caplet id");
  if (canonicalPortablePath(value.sourcePath) !== value.sourcePath) {
    throw new Error("Portable artifact source path is not canonical");
  }
  if (!Array.isArray(value.declaredInputs) || !Array.isArray(value.additionalReferences)) {
    throw new Error("Portable artifact references are malformed");
  }
  if (
    !Array.isArray(value.assets) ||
    value.assets.length > (limits.maxFiles ?? DEFAULT_MAX_FILES)
  ) {
    throw new Error("Portable artifact file count limit exceeded");
  }
  const seen = new Map<string, string>([[collisionKey(value.sourcePath), value.sourcePath]]);
  for (const asset of value.assets) {
    if (!isObject(asset)) throw new Error("Portable artifact asset metadata is malformed");
    assertExactKeys(asset, ARTIFACT_ASSET_METADATA_FIELDS, "portable artifact asset metadata");
    const path = canonicalPortablePath(asset.path);
    if (path !== asset.path) throw new Error("Portable artifact asset path is not canonical");
    assertNoCollision(path, seen);
    if (
      typeof asset.role !== "string" ||
      !PORTABLE_ASSET_ROLES.includes(asset.role as PortableAssetRole)
    ) {
      throw new Error("Unsupported portable artifact asset role");
    }
    assertNonEmpty(asset.mediaType, "portable artifact asset media type");
    if (
      typeof asset.contentHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(asset.contentHash) ||
      !Number.isSafeInteger(asset.byteLength) ||
      (asset.byteLength as number) < 0 ||
      (asset.byteLength as number) > (limits.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES)
    ) {
      throw new Error(`Portable artifact asset integrity metadata is invalid for ${path}`);
    }
  }
}

function portableCapletFromArtifactMarkdown(
  artifact: PortableArtifactMarkdown,
  files: PortableCapletBundleFile[],
  limits: PortableCodecLimits,
): PortableCaplet {
  const { metadata } = artifact;
  if (files.length !== metadata.assets.length) {
    throw new Error("Portable artifact asset manifest does not match its files");
  }
  const baseline = portableCapletFromCapletDocument(
    {
      id: metadata.id,
      path: metadata.sourcePath,
      text: artifact.sourceText,
      files,
      declaredInputs: metadata.declaredInputs,
      references: metadata.additionalReferences,
    },
    limits,
  );
  if (
    stableJsonStringify(baseline.frontmatter.catalog?.icon) !==
    stableJsonStringify(metadata.catalog?.icon)
  ) {
    throw new Error("Portable artifact catalog icon does not match its source frontmatter");
  }
  const portable: PortableCaplet = {
    ...baseline,
    frontmatter: {
      ...baseline.frontmatter,
      ...(metadata.catalog ? { catalog: metadata.catalog } : {}),
    },
  };
  const assetMetadata = portable.assets.map(
    ({ encoding: _encoding, content: _content, ...asset }) => asset,
  );
  if (stableJsonStringify(assetMetadata) !== stableJsonStringify(metadata.assets)) {
    throw new Error("Portable artifact asset manifest integrity check failed");
  }
  validatePortableCaplet(portable, limits);
  return portable;
}

function encodeStoredZip(entries: readonly PortableZipEntry[]): Uint8Array {
  const prepared = entries.map((entry) => {
    const path = canonicalPortablePath(entry.path);
    if (path !== entry.path) throw new Error(`ZIP entry path is not canonical: ${entry.path}`);
    const name = Buffer.from(path);
    if (name.byteLength > 0xffff || entry.content.byteLength > 0xffffffff) {
      throw new Error(`ZIP entry exceeds the portable archive format: ${path}`);
    }
    return { path, name, content: entry.content, crc: crc32(entry.content), offset: 0 };
  });
  const seen = new Map<string, string>();
  for (const entry of prepared) assertNoCollision(entry.path, seen);
  let localBytes = 0;
  let centralBytes = 0;
  for (const entry of prepared) {
    entry.offset = localBytes;
    localBytes += 30 + entry.name.byteLength + entry.content.byteLength;
    centralBytes += 46 + entry.name.byteLength;
  }
  if (
    prepared.length > 0xffff ||
    localBytes > 0xffffffff ||
    centralBytes > 0xffffffff ||
    localBytes + centralBytes > 0xffffffff
  ) {
    throw new Error("Portable ZIP archive exceeds the ZIP32 format");
  }
  const output = Buffer.allocUnsafe(localBytes + centralBytes + 22);
  let cursor = 0;
  for (const entry of prepared) {
    output.writeUInt32LE(ZIP_LOCAL_FILE_HEADER, cursor);
    output.writeUInt16LE(20, cursor + 4);
    output.writeUInt16LE(ZIP_UTF8_FLAG, cursor + 6);
    output.writeUInt16LE(0, cursor + 8);
    output.writeUInt16LE(0, cursor + 10);
    output.writeUInt16LE(0x21, cursor + 12);
    output.writeUInt32LE(entry.crc, cursor + 14);
    output.writeUInt32LE(entry.content.byteLength, cursor + 18);
    output.writeUInt32LE(entry.content.byteLength, cursor + 22);
    output.writeUInt16LE(entry.name.byteLength, cursor + 26);
    output.writeUInt16LE(0, cursor + 28);
    entry.name.copy(output, cursor + 30);
    output.set(entry.content, cursor + 30 + entry.name.byteLength);
    cursor += 30 + entry.name.byteLength + entry.content.byteLength;
  }
  const centralOffset = cursor;
  for (const entry of prepared) {
    output.writeUInt32LE(ZIP_CENTRAL_FILE_HEADER, cursor);
    output.writeUInt16LE(20, cursor + 4);
    output.writeUInt16LE(20, cursor + 6);
    output.writeUInt16LE(ZIP_UTF8_FLAG, cursor + 8);
    output.writeUInt16LE(0, cursor + 10);
    output.writeUInt16LE(0, cursor + 12);
    output.writeUInt16LE(0x21, cursor + 14);
    output.writeUInt32LE(entry.crc, cursor + 16);
    output.writeUInt32LE(entry.content.byteLength, cursor + 20);
    output.writeUInt32LE(entry.content.byteLength, cursor + 24);
    output.writeUInt16LE(entry.name.byteLength, cursor + 28);
    output.writeUInt16LE(0, cursor + 30);
    output.writeUInt16LE(0, cursor + 32);
    output.writeUInt16LE(0, cursor + 34);
    output.writeUInt16LE(0, cursor + 36);
    output.writeUInt32LE(0, cursor + 38);
    output.writeUInt32LE(entry.offset, cursor + 42);
    entry.name.copy(output, cursor + 46);
    cursor += 46 + entry.name.byteLength;
  }
  output.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY, cursor);
  output.writeUInt16LE(0, cursor + 4);
  output.writeUInt16LE(0, cursor + 6);
  output.writeUInt16LE(prepared.length, cursor + 8);
  output.writeUInt16LE(prepared.length, cursor + 10);
  output.writeUInt32LE(centralBytes, cursor + 12);
  output.writeUInt32LE(centralOffset, cursor + 16);
  output.writeUInt16LE(0, cursor + 20);
  return output;
}

function decodePortableZipArtifact(bytes: Uint8Array, limits: PortableCodecLimits): PortableCaplet {
  const entries = decodeZipEntries(bytes, limits);
  const documents = entries.filter(
    (entry) => entry.path === "CAPLET.md" || entry.path.endsWith("/CAPLET.md"),
  );
  if (documents.length !== 1) {
    throw new Error("Portable ZIP must contain exactly one directory Caplet document");
  }
  const document = documents[0]!;
  const artifact = parsePortableArtifactMarkdown(document.content, limits);
  const prefix = document.path.slice(0, -"CAPLET.md".length);
  if (prefix !== `${artifact.metadata.id}/`) {
    throw new Error("Portable ZIP root does not match its Caplet id");
  }
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const expectedPaths = new Set([document.path]);
  const files = artifact.metadata.assets.map((asset) => {
    const archivePath = `${prefix}${asset.path}`;
    expectedPaths.add(archivePath);
    const entry = entryByPath.get(archivePath);
    if (!entry) throw new Error(`Portable ZIP is missing ${asset.path}`);
    return {
      path: asset.path,
      role: asset.role,
      mediaType: asset.mediaType,
      content: entry.content,
      sourceKind: "file" as const,
    };
  });
  if (entries.some((entry) => !expectedPaths.has(entry.path))) {
    throw new Error("Portable ZIP contains files outside its canonical asset manifest");
  }
  return portableCapletFromArtifactMarkdown(artifact, files, limits);
}

function decodeZipEntries(bytes: Uint8Array, limits: PortableCodecLimits): PortableZipEntry[] {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findZipEnd(buffer);
  const disk = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const diskEntries = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount > (limits.maxFiles ?? DEFAULT_MAX_FILES) + 1 ||
    centralOffset + centralSize > endOffset
  ) {
    throw new Error("Portable ZIP central directory is invalid or exceeds limits");
  }
  const entries: PortableZipEntry[] = [];
  const seen = new Map<string, string>();
  let totalUncompressed = 0;
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assertBufferRange(buffer, cursor, 46, "ZIP central directory");
    if (buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_FILE_HEADER) {
      throw new Error("Portable ZIP central directory entry is invalid");
    }
    const versionMadeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const compression = buffer.readUInt16LE(cursor + 10);
    const expectedCrc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const entryLength = 46 + nameLength + extraLength + commentLength;
    assertBufferRange(buffer, cursor, entryLength, "ZIP central directory entry");
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new Error("ZIP64 portable artifacts are not supported");
    }
    if ((flags & 1) !== 0 || (flags & ~(ZIP_UTF8_FLAG | ZIP_DATA_DESCRIPTOR_FLAG)) !== 0) {
      throw new Error("Encrypted or unsupported ZIP entry flags are not portable");
    }
    if (compression !== 0 && compression !== 8) {
      throw new Error("Portable ZIP entries must be stored or deflated");
    }
    const mode = externalAttributes >>> 16;
    const hostSystem = versionMadeBy >>> 8;
    if (hostSystem === 3 && (mode & ZIP_TYPE_MASK) === ZIP_SYMLINK_MODE) {
      throw new Error("Portable ZIP symlink entries are not allowed");
    }
    const rawName = decodeZipName(buffer.subarray(cursor + 46, cursor + 46 + nameLength));
    const isDirectory =
      rawName.endsWith("/") || (hostSystem === 3 && (mode & ZIP_TYPE_MASK) === ZIP_DIRECTORY_MODE);
    const normalizedName = canonicalPortablePath(isDirectory ? rawName.slice(0, -1) : rawName);
    if (`${normalizedName}${isDirectory ? "/" : ""}` !== rawName) {
      throw new Error(`Portable ZIP entry path is not canonical: ${rawName}`);
    }
    if (isDirectory) {
      if (compressedSize !== 0 || uncompressedSize !== 0) {
        throw new Error(`Portable ZIP directory entry contains data: ${rawName}`);
      }
      cursor += entryLength;
      continue;
    }
    assertNoCollision(normalizedName, seen);
    totalUncompressed += uncompressedSize;
    if (
      uncompressedSize > (limits.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES) &&
      !normalizedName.endsWith("/CAPLET.md")
    ) {
      throw new Error(`Portable ZIP asset size limit exceeded for ${normalizedName}`);
    }
    if (totalUncompressed > (limits.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES)) {
      throw new Error("Portable ZIP expanded size limit exceeded");
    }
    assertBufferRange(buffer, localOffset, 30, "ZIP local header");
    if (buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_FILE_HEADER) {
      throw new Error("Portable ZIP local header is invalid");
    }
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localCompression = buffer.readUInt16LE(localOffset + 8);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    assertBufferRange(
      buffer,
      localOffset,
      30 + localNameLength + localExtraLength,
      "ZIP local entry",
    );
    assertBufferRange(buffer, dataOffset, compressedSize, "ZIP entry data");
    const localName = decodeZipName(
      buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength),
    );
    if (
      localFlags !== flags ||
      localCompression !== compression ||
      localName !== rawName ||
      dataOffset + compressedSize > centralOffset
    ) {
      throw new Error(`Portable ZIP local and central metadata disagree for ${rawName}`);
    }
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let content: Uint8Array;
    try {
      content =
        compression === 0
          ? Uint8Array.from(compressed)
          : Uint8Array.from(
              inflateRawSync(compressed, {
                maxOutputLength: Math.max(1, uncompressedSize),
              }),
            );
    } catch (error) {
      throw new Error(
        `Portable ZIP decompression failed for ${rawName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (content.byteLength !== uncompressedSize || crc32(content) !== expectedCrc) {
      throw new Error(`Portable ZIP integrity check failed for ${rawName}`);
    }
    entries.push({ path: normalizedName, content });
    cursor += entryLength;
  }
  if (cursor !== centralOffset + centralSize) {
    throw new Error("Portable ZIP central directory size is inconsistent");
  }
  return entries;
}

function findZipEnd(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.byteLength - 65_557);
  for (let offset = buffer.byteLength - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.byteLength) return offset;
  }
  throw new Error("Portable ZIP end-of-central-directory record is missing");
}

function decodeZipName(bytes: Uint8Array): string {
  try {
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!name || name.includes("\0")) throw new Error("empty or NUL-containing name");
    return name.normalize("NFC");
  } catch (error) {
    throw new Error(
      `Portable ZIP filename is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertBufferRange(buffer: Buffer, offset: number, length: number, label: string): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.byteLength
  ) {
    throw new Error(`${label} exceeds the portable ZIP envelope`);
  }
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function assertArtifactByteLimit(bytes: Uint8Array, limits: PortableCodecLimits): void {
  if (bytes.byteLength > (limits.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES)) {
    throw new Error("Portable artifact envelope size limit exceeded");
  }
}
