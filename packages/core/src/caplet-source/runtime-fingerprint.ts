import { createHash } from "node:crypto";
import { CapletsError } from "../errors";
import {
  loadCapletFilesFromMap,
  type CapletFileConfig,
  type CapletFileSourceMetadata,
} from "../caplet-files-bundle";
import { parseConfig, type CapletConfig, type CapletsConfig } from "../config-runtime";

const FINGERPRINT_VERSION = 1 as const;
const CAPLET_DOMAIN = "caplets.runtime-fingerprint.caplet.v1";
const ARTIFACT_DOMAIN = "caplets.runtime-fingerprint.artifact.v1";
const HOST_DOMAIN = "caplets.runtime-fingerprint.host.v1";
const INPUT_DOMAIN = "caplets.runtime-fingerprint.input.v1";
const NESTED_INPUT_DOMAIN = "caplets.runtime-fingerprint.nested-input.v1";

export type DeclaredInputState =
  | { state: "present"; content: string; privateKey?: string | undefined }
  | { state: "missing"; privateKey?: string | undefined }
  | { state: "unreadable"; privateKey?: string | undefined };

export type DeclaredInputListState =
  | { state: "present"; paths: string[]; privateKey?: string | undefined }
  | { state: "missing"; privateKey?: string | undefined }
  | { state: "unreadable"; privateKey?: string | undefined };

export type DeclaredInputReadContext = {
  runtimeId: string;
  readerScope?: string | undefined;
  privateReference?: string | undefined;
};

export type DeclaredInputReader = {
  read(logicalPath: string, context?: DeclaredInputReadContext): DeclaredInputState;
  list(logicalRoot: string, context?: DeclaredInputReadContext): DeclaredInputListState;
};

export type RuntimeFingerprintProvenance = {
  parentId: string;
  childId?: string | undefined;
  sourcePath: string;
  readerScope?: string | undefined;
};

export type DeclaredInputKind =
  | "openapi"
  | "google-discovery"
  | "graphql-schema"
  | "graphql-operation"
  | "caplet-config"
  | "caplets-root";

export type DeclaredInputSnapshot = {
  kind: DeclaredInputKind;
  logicalPath: string;
  state: "present" | "missing" | "unreadable";
  digest?: string | undefined;
};

type DeclaredInputGraph = {
  inputs: DeclaredInputSnapshot[];
  persistenceEligible: boolean;
};

export type CapletRuntimeFingerprint = {
  fingerprint: string;
  persistenceEligible: boolean;
  declaredInputs: DeclaredInputSnapshot[];
};

export type RuntimeFingerprintSnapshot = {
  version: typeof FINGERPRINT_VERSION;
  caplets: Record<string, CapletRuntimeFingerprint>;
  artifactFingerprint: string;
  hostConfigurationFingerprint: string;
  persistenceEligible: boolean;
};

type FingerprintConfig = CapletsConfig & {
  telemetry?: boolean | undefined;
  serve?:
    | {
        host?: string | undefined;
        port?: number | undefined;
        path?: string | undefined;
        remoteStatePath?: string | undefined;
        upstreamUrl?: string | undefined;
        allowUnauthenticatedHttp?: boolean | undefined;
        trustProxy?: boolean | undefined;
        publicOrigins?: string[] | undefined;
      }
    | undefined;
};

export function createRuntimeFingerprintSnapshot(input: {
  config: FingerprintConfig;
  provenance: Record<string, RuntimeFingerprintProvenance>;
  reader: DeclaredInputReader;
}): RuntimeFingerprintSnapshot {
  return createSnapshot(input, new Set());
}

export function createMemoryDeclaredInputReader(
  files: Record<
    string,
    | string
    | { state: "present"; content: string; privateKey?: string | undefined }
    | { state: "missing" | "unreadable"; privateKey?: string | undefined }
  >,
): DeclaredInputReader {
  const normalized = new Map<string, DeclaredInputState>();
  for (const [path, value] of Object.entries(files)) {
    const logicalPath = normalizeLogicalPath(path);
    if (!logicalPath) {
      throw new CapletsError("CONFIG_INVALID", "Declared input reader received an invalid path");
    }
    normalized.set(
      logicalPath,
      typeof value === "string"
        ? { state: "present", content: value, privateKey: logicalPath }
        : value,
    );
  }
  return {
    read(logicalPath) {
      const normalizedPath = normalizeLogicalPath(logicalPath);
      if (!normalizedPath) return { state: "unreadable" };
      return normalized.get(normalizedPath) ?? { state: "missing", privateKey: normalizedPath };
    },
    list(logicalRoot) {
      const root = normalizeLogicalPath(logicalRoot);
      if (!root) return { state: "unreadable" };
      const prefix = `${root}/`;
      const paths = [...normalized.keys()].filter((path) => path.startsWith(prefix)).sort();
      return paths.length > 0
        ? { state: "present", paths, privateKey: root }
        : { state: "missing", privateKey: root };
    },
  };
}

function createSnapshot(
  input: {
    config: FingerprintConfig;
    provenance: Record<string, RuntimeFingerprintProvenance>;
    reader: DeclaredInputReader;
  },
  traversal: Set<string>,
): RuntimeFingerprintSnapshot {
  const caplets: Record<string, CapletRuntimeFingerprint> = {};
  for (const caplet of allCaplets(input.config).sort((left, right) =>
    left.server.localeCompare(right.server),
  )) {
    const provenance = input.provenance[caplet.server] ?? {
      parentId: caplet.server,
      sourcePath: `${caplet.server}/CAPLET.md`,
    };
    caplets[caplet.server] = fingerprintCaplet(caplet, provenance, input.reader, traversal);
  }

  const artifactFingerprint = domainHash(
    ARTIFACT_DOMAIN,
    Object.fromEntries(
      Object.entries(caplets)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, value]) => [id, value.fingerprint]),
    ),
  );
  const hostOptions = enumeratedHostOptions(input.config);
  const hostConfigurationFingerprint = domainHash(HOST_DOMAIN, {
    caplets: Object.fromEntries(
      Object.entries(caplets)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, value]) => [id, value.fingerprint]),
    ),
    options: transformPaths(hostOptions, []),
  });
  return {
    version: FINGERPRINT_VERSION,
    caplets,
    artifactFingerprint,
    hostConfigurationFingerprint,
    persistenceEligible:
      Object.values(caplets).every((caplet) => caplet.persistenceEligible) &&
      persistenceEligible(hostOptions),
  };
}

function fingerprintCaplet(
  caplet: CapletConfig,
  provenance: RuntimeFingerprintProvenance,
  reader: DeclaredInputReader,
  traversal: Set<string>,
): CapletRuntimeFingerprint {
  const declaredInputGraph = readDeclaredInputs(caplet, provenance.readerScope, reader, traversal);
  const declaredInputs = declaredInputGraph.inputs;
  const semantic = transformPaths(structuredClone(caplet), []);
  return {
    fingerprint: domainHash(CAPLET_DOMAIN, {
      runtimeId: caplet.server,
      source: {
        parentId: provenance.parentId,
        childId: provenance.childId ?? null,
        sourcePath: normalizeLogicalPath(provenance.sourcePath) ?? "CAPLET.md",
      },
      semantic,
      declaredInputs,
    }),
    persistenceEligible: persistenceEligible(caplet) && declaredInputGraph.persistenceEligible,
    declaredInputs,
  };
}

function readDeclaredInputs(
  caplet: CapletConfig,
  readerScope: string | undefined,
  reader: DeclaredInputReader,
  traversal: Set<string>,
): DeclaredInputGraph {
  const references: Array<{ kind: DeclaredInputKind; path: string }> = [];
  if (caplet.backend === "openapi" && caplet.specPath) {
    references.push({ kind: "openapi", path: caplet.specPath });
  } else if (caplet.backend === "googleDiscovery" && caplet.discoveryPath) {
    references.push({ kind: "google-discovery", path: caplet.discoveryPath });
  } else if (caplet.backend === "graphql") {
    if (caplet.schemaPath) references.push({ kind: "graphql-schema", path: caplet.schemaPath });
    for (const operation of Object.values(caplet.operations ?? {})) {
      if (operation.documentPath) {
        references.push({ kind: "graphql-operation", path: operation.documentPath });
      }
    }
  } else if (caplet.backend === "caplets") {
    if (caplet.configPath) references.push({ kind: "caplet-config", path: caplet.configPath });
    if (caplet.capletsRoot) references.push({ kind: "caplets-root", path: caplet.capletsRoot });
  }

  if (caplet.backend === "caplets") {
    return fingerprintNestedCapletSet(caplet, readerScope, references, reader, traversal);
  }
  return {
    inputs: references
      .map(({ kind, path }) =>
        fingerprintOrdinaryInput(caplet.server, readerScope, kind, path, reader),
      )
      .sort(compareDeclaredInputs),
    persistenceEligible: true,
  };
}

function fingerprintOrdinaryInput(
  runtimeId: string,
  readerScope: string | undefined,
  kind: DeclaredInputKind,
  path: string,
  reader: DeclaredInputReader,
): DeclaredInputSnapshot {
  const logicalPath = declaredLogicalPath(path, kind);
  const context = {
    runtimeId,
    readerScope,
    ...(isAbsoluteHostPath(path) ? { privateReference: path } : {}),
  };
  const state = reader.read(logicalPath, context);
  if (state.state !== "present") return { kind, logicalPath, state: state.state };
  return {
    kind,
    logicalPath,
    state: "present",
    digest: domainHash(INPUT_DOMAIN, { kind, content: state.content }),
  };
}

function fingerprintNestedCapletSet(
  caplet: Extract<CapletConfig, { backend: "caplets" }>,
  readerScope: string | undefined,
  references: Array<{ kind: DeclaredInputKind; path: string }>,
  reader: DeclaredInputReader,
  traversal: Set<string>,
): DeclaredInputGraph {
  let configInput: Record<string, unknown> | undefined;
  let capletInput: CapletFileConfig | undefined;
  const nestedProvenance: Record<string, RuntimeFingerprintProvenance> = {};
  const inputs: DeclaredInputSnapshot[] = [];
  const traversalKeys: string[] = [];

  for (const reference of references.sort((left, right) => left.kind.localeCompare(right.kind))) {
    const logicalPath = declaredLogicalPath(reference.path, reference.kind);
    const context = {
      runtimeId: caplet.server,
      readerScope,
      ...(isAbsoluteHostPath(reference.path) ? { privateReference: reference.path } : {}),
    };
    if (reference.kind === "caplet-config") {
      const state = reader.read(logicalPath, context);
      const cycleKey = state.privateKey ?? `config:${logicalPath}`;
      if (state.state !== "present") {
        inputs.push({ kind: reference.kind, logicalPath, state: state.state });
        continue;
      }
      assertNoCycle(cycleKey, traversal);
      traversalKeys.push(cycleKey);
      try {
        const parsed = JSON.parse(state.content) as Record<string, unknown>;
        configInput = normalizeNestedConfigPaths(
          parsed,
          logicalPath.split("/").slice(0, -1).join("/"),
        );
        for (const id of capletIds(configInput)) {
          nestedProvenance[id] = { parentId: id, sourcePath: logicalPath, readerScope };
        }
        inputs.push({ kind: reference.kind, logicalPath, state: "present" });
      } catch (error) {
        if (error instanceof CapletsError) throw error;
        throw new CapletsError("CONFIG_INVALID", `Nested Caplet config ${logicalPath} is invalid`);
      }
      continue;
    }

    const state = reader.list(logicalPath, context);
    const cycleKey = state.privateKey ?? `root:${logicalPath}`;
    if (state.state !== "present") {
      inputs.push({ kind: reference.kind, logicalPath, state: state.state });
      continue;
    }
    assertNoCycle(cycleKey, traversal);
    traversalKeys.push(cycleKey);
    const prefix = `${logicalPath}/`;
    const candidatePaths = effectiveCapletRootPaths(
      state.paths
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length)),
    );
    const fileStates = candidatePaths.map((path) => {
      const sourcePath = `${prefix}${path}`;
      return {
        path,
        state: reader.read(sourcePath, { runtimeId: caplet.server, readerScope }),
      };
    });
    const inaccessible = fileStates.filter(({ state }) => state.state !== "present");
    if (inaccessible.length > 0) {
      inputs.push({
        kind: reference.kind,
        logicalPath,
        state: inaccessible.some(({ state }) => state.state === "unreadable")
          ? "unreadable"
          : "missing",
        digest: domainHash(INPUT_DOMAIN, {
          kind: reference.kind,
          files: inaccessible.map(({ path, state }) => ({ path, state: state.state })),
        }),
      });
      continue;
    }
    const files = fileStates.map(({ path, state }) => ({
      path,
      content: state.state === "present" ? state.content : "",
    }));
    const loaded = loadCapletFilesFromMap({ files });
    if (loaded) {
      capletInput = normalizeNestedConfigPaths(
        loaded.config as Record<string, unknown>,
        logicalPath,
      ) as CapletFileConfig;
      for (const [id, metadata] of Object.entries(loaded.metadata ?? {})) {
        nestedProvenance[id] = nestedSourceProvenance(metadata, logicalPath, readerScope);
      }
      for (const [id, path] of Object.entries(loaded.paths)) {
        nestedProvenance[id] ??= {
          parentId: id,
          sourcePath: logicalJoin(logicalPath, path),
          readerScope,
        };
      }
    }
    inputs.push({ kind: reference.kind, logicalPath, state: "present" });
  }

  if (!configInput && !capletInput) {
    return { inputs: inputs.sort(compareDeclaredInputs), persistenceEligible: true };
  }
  const merged = mergeRuntimeInputs(configInput, capletInput, {
    version: 1,
    defaultSearchLimit: caplet.defaultSearchLimit,
    maxSearchLimit: caplet.maxSearchLimit,
  });
  const config = parseConfig(merged);
  const nested = createSnapshot(
    { config, provenance: nestedProvenance, reader },
    new Set([...traversal, ...traversalKeys]),
  );
  const digest = domainHash(NESTED_INPUT_DOMAIN, {
    artifactFingerprint: nested.artifactFingerprint,
    hostConfigurationFingerprint: nested.hostConfigurationFingerprint,
    runtimeIds: Object.keys(nested.caplets).sort(),
  });
  return {
    inputs: inputs
      .map((input) => (input.state === "present" ? { ...input, digest } : input))
      .sort(compareDeclaredInputs),
    persistenceEligible: nested.persistenceEligible,
  };
}

function assertNoCycle(key: string, traversal: Set<string>): void {
  if (traversal.has(key)) {
    throw new CapletsError("CONFIG_INVALID", "Nested Caplet set cycle detected");
  }
}

function nestedSourceProvenance(
  metadata: CapletFileSourceMetadata,
  root: string,
  readerScope: string | undefined,
): RuntimeFingerprintProvenance {
  return {
    parentId: metadata.parentId,
    ...(metadata.childId ? { childId: metadata.childId } : {}),
    sourcePath: logicalJoin(root, metadata.path),
    readerScope,
  };
}

function transformPaths(value: unknown, path: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) => transformPaths(entry, [...path, String(index)]));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .map(([key, nested]) => {
        const nextPath = [...path, key];
        if (typeof nested === "string" && DECLARED_PATH_KEYS[key]) {
          return [key, canonicalSemanticPath(nested, nextPath.join("."))];
        }
        return [key, transformPaths(nested, nextPath)];
      }),
  );
}

const DECLARED_PATH_KEYS: Record<string, true> = {
  specPath: true,
  discoveryPath: true,
  schemaPath: true,
  documentPath: true,
  configPath: true,
  capletsRoot: true,
};

function canonicalSemanticPath(value: string, label: string): string {
  if (
    isAbsoluteHostPath(value) ||
    hasTemplateReference(value) ||
    /^[a-z][a-z0-9+.-]*:/iu.test(value)
  ) {
    return value;
  }
  const normalized = normalizeLogicalPath(value);
  if (!normalized) {
    throw new CapletsError("CONFIG_INVALID", `Declared input ${label} contains path traversal`);
  }
  return normalized;
}

function declaredLogicalPath(value: string, kind: DeclaredInputKind): string {
  if (isAbsoluteHostPath(value)) return `@absolute/${kind}`;
  const normalized = normalizeLogicalPath(value);
  if (!normalized) {
    throw new CapletsError("CONFIG_INVALID", `Declared ${kind} input contains path traversal`);
  }
  return normalized;
}

function normalizeLogicalPath(value: string): string | undefined {
  const raw = value.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//u.test(raw)) return undefined;
  const output: string[] = [];
  for (const segment of raw.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") return undefined;
    output.push(segment);
  }
  return output.length > 0 ? output.join("/") : undefined;
}

function logicalJoin(base: string, path: string): string {
  const joined = [base, path].filter(Boolean).join("/");
  const normalized = normalizeLogicalPath(joined);
  if (!normalized)
    throw new CapletsError("CONFIG_INVALID", "Declared input contains path traversal");
  return normalized;
}

function normalizeNestedConfigPaths(
  input: Record<string, unknown>,
  base: string,
): Record<string, unknown> {
  const output = structuredClone(input);
  for (const backendKey of [
    "openapiEndpoints",
    "googleDiscoveryApis",
    "graphqlEndpoints",
    "capletSets",
  ]) {
    const entries = output[backendKey];
    if (!isRecord(entries)) continue;
    for (const value of Object.values(entries)) {
      if (!isRecord(value)) continue;
      for (const key of Object.keys(DECLARED_PATH_KEYS)) {
        if (typeof value[key] === "string") value[key] = logicalJoin(base, value[key] as string);
      }
      if (backendKey === "graphqlEndpoints" && isRecord(value.operations)) {
        for (const operation of Object.values(value.operations)) {
          if (isRecord(operation) && typeof operation.documentPath === "string") {
            operation.documentPath = logicalJoin(base, operation.documentPath);
          }
        }
      }
    }
  }
  return output;
}

function effectiveCapletRootPaths(paths: string[]): string[] {
  const directoryIds: Record<string, true> = {};
  for (const path of paths) {
    const parts = path.split("/");
    if (parts.length === 2 && parts[1] === "CAPLET.md") directoryIds[parts[0]!] = true;
  }
  return paths
    .filter((path) => {
      const parts = path.split("/");
      if (parts.length === 2 && parts[1] === "CAPLET.md") return true;
      if (parts.length !== 1 || !path.toLowerCase().endsWith(".md")) return false;
      const id = path.slice(0, path.lastIndexOf("."));
      return !directoryIds[id];
    })
    .sort((left, right) => left.localeCompare(right));
}

function mergeRuntimeInputs(
  ...inputs: Array<Record<string, unknown> | CapletFileConfig | undefined>
): Record<string, unknown> {
  const backendKeys = [
    "mcpServers",
    "openapiEndpoints",
    "googleDiscoveryApis",
    "graphqlEndpoints",
    "httpApis",
    "cliTools",
    "capletSets",
  ];
  let merged: Record<string, unknown> = {};
  for (const input of inputs) {
    if (!input) continue;
    const inputRecord = input as Record<string, unknown>;
    const previous = merged;
    const incomingIds = new Set(
      backendKeys.flatMap((key) =>
        isRecord(inputRecord[key]) ? Object.keys(inputRecord[key]) : [],
      ),
    );
    merged = { ...previous, ...inputRecord };
    for (const key of backendKeys) {
      const retained = Object.fromEntries(
        Object.entries(isRecord(previous[key]) ? previous[key] : {}).filter(
          ([id]) => !incomingIds.has(id),
        ),
      );
      merged[key] = {
        ...retained,
        ...(isRecord(inputRecord[key]) ? inputRecord[key] : {}),
      };
    }
    merged.namespaceAliases = mergeNamespaceAliases(
      previous.namespaceAliases,
      inputRecord.namespaceAliases,
    );
  }
  return merged;
}

function mergeNamespaceAliases(left: unknown, right: unknown): unknown {
  if (!isRecord(left) && !isRecord(right)) return undefined;
  return {
    ...(isRecord(left) ? left : {}),
    ...(isRecord(right) ? right : {}),
    upstreams: {
      ...(isRecord(left) && isRecord(left.upstreams) ? left.upstreams : {}),
      ...(isRecord(right) && isRecord(right.upstreams) ? right.upstreams : {}),
    },
  };
}

function capletIds(input: Record<string, unknown>): string[] {
  return [
    "mcpServers",
    "openapiEndpoints",
    "googleDiscoveryApis",
    "graphqlEndpoints",
    "httpApis",
    "cliTools",
    "capletSets",
  ].flatMap((key) => (isRecord(input[key]) ? Object.keys(input[key]) : []));
}

function allCaplets(config: CapletsConfig): CapletConfig[] {
  return [
    ...Object.values(config.mcpServers),
    ...Object.values(config.openapiEndpoints),
    ...Object.values(config.googleDiscoveryApis),
    ...Object.values(config.graphqlEndpoints),
    ...Object.values(config.httpApis),
    ...Object.values(config.cliTools),
    ...Object.values(config.capletSets),
  ];
}

function enumeratedHostOptions(config: FingerprintConfig): unknown {
  return {
    version: config.version,
    paging: {
      defaultSearchLimit: config.options.defaultSearchLimit,
      maxSearchLimit: config.options.maxSearchLimit,
    },
    exposure: {
      defaultMode: config.options.exposure,
      discoveryTimeoutMs: config.options.exposureDiscoveryTimeoutMs,
      discoveryConcurrency: config.options.exposureDiscoveryConcurrency,
    },
    completion: {
      discoveryTimeoutMs: config.options.completion.discoveryTimeoutMs,
      overallTimeoutMs: config.options.completion.overallTimeoutMs,
      cacheTtlMs: config.options.completion.cacheTtlMs,
      negativeCacheTtlMs: config.options.completion.negativeCacheTtlMs,
    },
    namespaceAliases: {
      local: config.namespaceAliases.local ?? null,
      upstreams: config.namespaceAliases.upstreams,
    },
    telemetry: config.telemetry ?? null,
    serve: {
      host: config.serve?.host ?? null,
      port: config.serve?.port ?? null,
      path: config.serve?.path ?? null,
      remoteStatePath: config.serve?.remoteStatePath ?? null,
      upstreamUrl: config.serve?.upstreamUrl ?? null,
      allowUnauthenticatedHttp: config.serve?.allowUnauthenticatedHttp ?? null,
      trustProxy: config.serve?.trustProxy ?? null,
      publicOrigins: config.serve?.publicOrigins ?? [],
    },
  };
}

function persistenceEligible(value: unknown, path: string[] = []): boolean {
  if (typeof value === "string") {
    if (isSecretCapablePath(path)) return hasTemplateReference(value);
    if (isHostPath(path, value)) return false;
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((entry, index) => persistenceEligible(entry, [...path, String(index)]));
  }
  if (!value || typeof value !== "object") return true;
  return Object.entries(value as Record<string, unknown>).every(([key, nested]) =>
    persistenceEligible(nested, [...path, key]),
  );
}

function isSecretCapablePath(path: string[]): boolean {
  const key = path.at(-1)?.toLowerCase();
  if (!key) return false;
  if (key === "token" || key === "clientsecret") return true;
  if (path.some((segment) => segment.toLowerCase() === "env")) return true;
  if (path.some((segment) => segment.toLowerCase() === "headers")) return true;
  return false;
}

function isHostPath(path: string[], value: string): boolean {
  if (!isAbsoluteHostPath(value)) return false;
  const key = path.at(-1)?.toLowerCase() ?? "";
  if (key === "path" && path.includes("serve")) return false;
  if (key === "path" && path.includes("actions")) return false;
  return (
    key === "cwd" ||
    key === "command" ||
    key.endsWith("path") ||
    path.some((segment) => segment === "args")
  );
}

function hasTemplateReference(value: string): boolean {
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$env:[A-Za-z_][A-Za-z0-9_]*|\$\{vault:[^}]+\}|\$vault:[A-Za-z0-9_-]+/u.test(
    value,
  );
}

function isAbsoluteHostPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value);
}

function compareDeclaredInputs(left: DeclaredInputSnapshot, right: DeclaredInputSnapshot): number {
  return left.logicalPath.localeCompare(right.logicalPath) || left.kind.localeCompare(right.kind);
}

function domainHash(domain: string, value: unknown): string {
  const encodedDomain = new TextEncoder().encode(domain);
  const encodedValue = new TextEncoder().encode(stableEncode(value));
  const hash = createHash("sha256");
  hash.update(`domain:${encodedDomain.byteLength}:`);
  hash.update(encodedDomain);
  hash.update(`payload:${encodedValue.byteLength}:`);
  hash.update(encodedValue);
  return hash.digest("hex");
}

function stableEncode(value: unknown): string {
  if (value === null) return "n";
  if (value === undefined) return "u";
  if (typeof value === "boolean") return value ? "b1" : "b0";
  if (typeof value === "number") {
    const encoded = Object.is(value, -0) ? "-0" : String(value);
    return `d${encoded.length}:${encoded}`;
  }
  if (typeof value === "string") {
    const length = new TextEncoder().encode(value).byteLength;
    return `s${length}:${value}`;
  }
  if (Array.isArray(value)) {
    return `a${value.length}:[${value.map(stableEncode).join("")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `o${entries.length}:{${entries
      .map(([key, nested]) => `${stableEncode(key)}${stableEncode(nested)}`)
      .join("")}}`;
  }
  throw new TypeError(`Unsupported fingerprint value: ${typeof value}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
