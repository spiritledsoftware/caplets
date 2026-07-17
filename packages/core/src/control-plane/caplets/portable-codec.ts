import { createHash } from "node:crypto";
import { parseCapletFileDocument } from "../../caplet-files-bundle";
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
const FORBIDDEN_FIELDS: Record<string, true> = {
  secret: true,
  password: true,
  credential: true,
  token: true,
  clientsecret: true,
  apikey: true,
  vaultvalue: true,
  authoritytoken: true,
  databaseurl: true,
  hostpath: true,
  writerfence: true,
  sessiontoken: true,
};
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u;
const INTERPOLATION = /\$\{[^}]+\}|\$env:/iu;

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
export type PortableCapletDocumentInput = {
  id: string;
  path: string;
  text: string;
  files: PortableCapletBundleFile[];
  declaredInputs?: PortableDeclaredInput[];
  references?: PortableReference[];
};

const BACKEND_KIND_BY_SOURCE_FIELD: Record<string, (typeof PORTABLE_BACKEND_KINDS)[number]> = {
  mcpServer: "mcp",
  mcpServers: "mcp",
  openapiEndpoint: "openapi",
  openapiEndpoints: "openapi",
  googleDiscoveryApi: "googleDiscovery",
  googleDiscoveryApis: "googleDiscovery",
  graphqlEndpoint: "graphql",
  graphqlEndpoints: "graphql",
  httpApi: "http",
  httpApis: "http",
  cliTools: "cli",
  capletSet: "caplets",
  capletSets: "caplets",
};

export function portableCapletFromCapletDocument(
  input: PortableCapletDocumentInput,
  limits: PortableCodecLimits = {},
): PortableCaplet {
  const document = parseCapletFileDocument(input.path, input.text);
  const extractedReferences: PortableReference[] = [];
  const sourceFrontmatter = portableSourceValue(
    document.frontmatter,
    "frontmatter",
    extractedReferences,
  );
  if (!isObject(sourceFrontmatter)) throw new Error("Portable source frontmatter is invalid");
  const backendEntries = Object.entries(sourceFrontmatter).filter(
    ([key]) => BACKEND_KIND_BY_SOURCE_FIELD[key],
  );
  const backendKinds = [
    ...new Set(backendEntries.map(([key]) => BACKEND_KIND_BY_SOURCE_FIELD[key]!)),
  ];
  if (backendKinds.length === 0) throw new Error("Portable source has no backend");
  const icon = document.frontmatter.catalog?.icon;
  const catalog = icon
    ? icon.startsWith("https:")
      ? { icon: { type: "external" as const, url: icon } }
      : { icon: { type: "local" as const, path: canonicalPortablePath(icon) } }
    : undefined;
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

export function validatePortableCaplet(
  value: unknown,
  limits: PortableCodecLimits = {},
): asserts value is PortableCaplet {
  if (!isObject(value)) throw new Error("Portable Caplet must be an object");
  assertExactKeys(
    value,
    Object.fromEntries(PORTABLE_CAPLET_TOP_LEVEL_FIELDS.map((key) => [key, true])),
    "portable Caplet",
  );
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
    ![
      "asset",
      "icon",
      "document",
      "openapi",
      "graphql-schema",
      "graphql-operation",
      "config",
    ].includes(raw.role)
  )
    throw new Error("Unsupported portable asset role");
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

function portableSourceValue(
  value: unknown,
  path: string,
  references: PortableReference[],
): PortableJson {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    assertSafeText(value, path);
    return normalizeNewlines(value).normalize("NFC");
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => portableSourceValue(item, `${path}[${index}]`, references));
  }
  if (!isObject(value)) throw new Error(`Unsupported value at ${path}`);
  const result: Record<string, PortableJson> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.replace(/[_-]/gu, "").toLowerCase();
    if (FORBIDDEN_FIELDS[normalizedKey]) {
      const match =
        typeof item === "string"
          ? /^(?:\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$env:([A-Za-z_][A-Za-z0-9_]*))$/u.exec(item)
          : undefined;
      const name = match?.[1] ?? match?.[2];
      if (!name) throw new Error(`Embedded secret field is not portable: ${path}.${key}`);
      references.push({ type: "unresolved-setup", owner: `${path}.${key}`, name });
      continue;
    }
    result[key.normalize("NFC")] = portableSourceValue(item, `${path}.${key}`, references);
  }
  return result;
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
    if (FORBIDDEN_FIELDS[key.replace(/[_-]/gu, "").toLowerCase()])
      throw new Error(`Host security or deployment field is not portable: ${path}.${key}`);
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
  const match = /^172\.(\d{1,3})\./u.exec(host);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: Record<string, true>,
  label: string,
  optional = false,
): void {
  for (const key of Object.keys(value))
    if (!allowed[key]) throw new Error(`Unsupported ${label} field ${key}`);
  if (!optional)
    for (const key of Object.keys(allowed))
      if (!(key in value)) throw new Error(`Missing ${label} field ${key}`);
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
