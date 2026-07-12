import { createHash, type Hash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { loadCapletFilesFromMap, type CapletFileLoadResult } from "../caplet-files-bundle";
import {
  loadConfigWithSources,
  mergeConfigInputsWithSources,
  parseConfig,
  readConfigInputForComposition,
  type CapletConfig,
  type CapletsConfig,
  type ConfigInput,
  type ConfigInputWithSource,
  type ConfigParseOptions,
  type ConfigSource,
  type ConfigSourceInput,
  type ConfigWithSources,
} from "../config";
import { CapletsError } from "../errors";
import type { AuthorityGeneration } from "./types";
import {
  authorityBundleRecordBundle,
  ContentAddressedBundleCache,
  normalizeBundlePath,
  type AuthorityCapletRecord,
  type MaterializedAuthorityBundle,
} from "./bundle-cache";

export type StagedConfigSource = ConfigInputWithSource & {
  fingerprintPath?: string | undefined;
};

export type AuthoritySnapshot = {
  /** Complete config input for authorities that persist a canonical snapshot. */
  config?: ConfigInput | undefined;
  /** Caplet records keyed by stable authority record ID. */
  caplets?: Record<string, AuthorityCapletRecord> | AuthorityCapletRecord[] | undefined;
  records?: Record<string, AuthorityCapletRecord> | AuthorityCapletRecord[] | undefined;
  [key: string]: unknown;
};

export type AuthorityCompositionInput = {
  authorityId: string;
  generation: AuthorityGeneration<AuthoritySnapshot>;
  bundleCache?: ContentAddressedBundleCache | undefined;
};

export type ComposedRuntimeConfig = ConfigWithSources & {
  authorityGeneration: AuthorityGeneration<AuthoritySnapshot> | null;
  stagedFingerprint: string;
  materializedBundles: MaterializedAuthorityBundle[];
  releaseBundles: () => Promise<void>;
};

export type LegacyCompositionOptions = {
  globalConfigPath?: string | undefined;
  projectConfigPath?: string | undefined;
  vaultResolver?: ConfigParseOptions["vaultResolver"];
};

/**
 * The sole precedence implementation used by filesystem and authority views.
 * Inputs are ordered from lowest to highest precedence, matching legacy global
 * config → global files → project config → project files behavior.
 */
export function composeConfigInputsWithSources(
  inputs: Array<ConfigInputWithSource | undefined>,
  options: { vaultResolver?: LegacyCompositionOptions["vaultResolver"] } = {},
): ConfigWithSources {
  assertAuthorityStagedCollisions(inputs);
  const merged = mergeConfigInputsWithSources(...inputs);
  const config = parseConfig(merged.input, {
    sources: merged.sources,
    vaultResolver: options.vaultResolver,
  });
  return { config, sources: merged.sources, shadows: merged.shadows };
}

/**
 * Compose staged filesystem inputs and a committed authority generation. The
 * authority is deliberately appended last for ordinary IDs, but a duplicate
 * staged ID is rejected rather than silently shadowed.
 */
export async function composeRuntimeConfig(options: {
  staged: StagedConfigSource[];
  authority?: AuthorityCompositionInput | undefined;
  stagedFingerprint?: string | undefined;
  vaultResolver?: LegacyCompositionOptions["vaultResolver"];
}): Promise<ComposedRuntimeConfig> {
  const materializedBundles: MaterializedAuthorityBundle[] = [];
  const authorityInputs: ConfigInputWithSource[] = [];
  try {
    if (options.authority) {
      const snapshot = options.authority.generation.snapshot ?? {};
      if (snapshot.config) {
        authorityInputs.push({
          input: snapshot.config,
          source: authoritySource(
            options.authority.authorityId,
            "snapshot",
            options.authority.generation.id,
          ),
        });
      }
      const records = authorityRecords(snapshot);
      const bundleCache = options.authority.bundleCache;
      for (const [recordId, record] of records) {
        if (record.config) {
          authorityInputs.push({
            input: record.config,
            source: authoritySource(
              options.authority.authorityId,
              recordId,
              options.authority.generation.id,
            ),
          });
          continue;
        }
        const bundle = authorityBundleRecordBundle(record);
        if (!bundle) {
          throw new CapletsError(
            "CONFIG_INVALID",
            `Authority Caplet ${recordId} has neither a config nor an executable bundle`,
          );
        }
        if (!bundleCache) {
          throw new CapletsError("CONFIG_INVALID", "Authority bundle cache is not configured");
        }
        const materialized = await bundleCache.materialize(bundle);
        materializedBundles.push(materialized);
        const loaded = loadMaterializedBundle(materialized);
        if (!loaded) {
          throw new CapletsError(
            `CONFIG_INVALID`,
            `Authority bundle ${recordId} has no Caplet entry`,
          );
        }
        const rebased = rebaseBundleConfig(loaded.config, materialized.root, materialized);
        authorityInputs.push({
          input: rebased,
          source: authoritySource(
            options.authority.authorityId,
            recordId,
            options.authority.generation.id,
          ),
        });
      }
    }

    const composed = composeConfigInputsWithSources([...options.staged, ...authorityInputs], {
      vaultResolver: options.vaultResolver,
    });
    const stagedFingerprint =
      options.stagedFingerprint ?? (await computeStagedFingerprint(options.staged.map(stagedPath)));
    return {
      ...composed,
      authorityGeneration: options.authority?.generation ?? null,
      stagedFingerprint,
      materializedBundles,
      releaseBundles: async () => {
        await Promise.all(materializedBundles.map((bundle) => bundle.release()));
      },
    };
  } catch (error) {
    await Promise.allSettled(materializedBundles.map((bundle) => bundle.release()));
    throw error;
  }
}

/** Preserve the exact legacy source order while exposing one composition path. */
export function composeLegacyFilesystemConfig(
  options: LegacyCompositionOptions = {},
): ConfigWithSources {
  return loadConfigWithSources(options.globalConfigPath, options.projectConfigPath, {
    vaultResolver: options.vaultResolver,
  });
}

/**
 * Load an explicit staged source. Shared authorities call this with only their
 * immutable mount roots; authority-owned global roots are intentionally absent.
 */
export function loadStagedFilesystemSource(options: {
  configPath?: string | undefined;
  capletsRoot?: string | undefined;
  configKind?: Exclude<ConfigSource["kind"], "authority">;
  fileKind?: Exclude<ConfigSource["kind"], "authority">;
}): StagedConfigSource[] {
  const configKind = options.configKind ?? "global-config";
  const fileKind = options.fileKind ?? "global-file";
  const loaded: StagedConfigSource[] = [];
  if (options.configPath) {
    loaded.push({
      input: readConfigInputForComposition(options.configPath),
      source: { kind: configKind, path: options.configPath },
      fingerprintPath: options.configPath,
    });
  }
  if (options.capletsRoot) {
    const result = loadCapletFilesFromFilesystem(options.capletsRoot);
    if (result) {
      loaded.push({
        input: result.config as ConfigInput,
        source: { kind: fileKind, path: result.paths },
        fingerprintPath: options.capletsRoot,
      });
    }
  }
  return loaded;
}

/** Compute a mount-path-independent SHA-256 fingerprint of staged bytes. */
export async function computeStagedFingerprint(paths: string[]): Promise<string> {
  const hash = createHash("sha256");
  const roots = paths.map((path) => resolve(path));
  for (const [index, root] of roots.entries()) {
    const info = await lstat(root).catch((error: unknown) => {
      throw new CapletsError("CONFIG_INVALID", `Staged source ${root} is unavailable`, {
        reason: error instanceof Error ? error.message : String(error),
      });
    });
    hash.update(`root:${index}:${info.isDirectory() ? "directory" : "file"}\0`);
    if (info.isDirectory()) {
      await fingerprintDirectory(root, root, hash);
    } else if (info.isFile()) {
      hash.update(".\0");
      hash.update(await readFile(root));
      hash.update("\0");
    } else {
      throw new CapletsError("CONFIG_INVALID", `Staged source ${root} must be a file or directory`);
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

function authoritySource(
  authorityId: string,
  recordId: string,
  generationId: string,
): ConfigSourceInput {
  return {
    kind: "authority",
    path: `authority://${authorityId}/${encodeURIComponent(recordId)}@${encodeURIComponent(generationId)}`,
    authorityId,
    recordId,
    generationId,
  };
}

export function authorityRecords(
  snapshot: AuthoritySnapshot,
): Array<[string, AuthorityCapletRecord]> {
  const records = snapshot.caplets ?? snapshot.records;
  if (!records) return [];
  if (Array.isArray(records)) {
    return records.map((record) => [record.id, record]);
  }
  return Object.entries(records).map(([id, record]) => [id, { ...record, id: record.id || id }]);
}
function loadMaterializedBundle(
  materialized: MaterializedAuthorityBundle,
): CapletFileLoadResult | undefined {
  const files = materialized.files.map((file) => ({
    path: file.path,
    content: new TextDecoder().decode(file.bytes),
  }));
  return loadCapletFilesFromMap({ files });
}

function rebaseBundleConfig(
  input: ConfigInput,
  materializedRoot: string,
  materialized: MaterializedAuthorityBundle,
): ConfigInput {
  const virtualPaths = new Set(materialized.files.map((file) => file.path));
  const entryPath = relative(materialized.root, materialized.entryPath).replace(/\\/gu, "/");
  const entryDirectory = dirname(entryPath).replace(/\\/gu, "/");
  return rebaseValue(
    input,
    undefined,
    materializedRoot,
    virtualPaths,
    entryDirectory,
  ) as ConfigInput;
}

function rebaseValue(
  value: unknown,
  key: string | undefined,
  root: string,
  virtualPaths: Set<string>,
  entryDirectory: string,
): unknown {
  if (typeof value === "string") {
    if (!isLocalPathKey(key)) return value;
    if (key === "command" && !isRelativeExecutablePath(value)) return value;
    if (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || hasInterpolation(value)) {
      return value;
    }
    const normalized = value === "." ? "" : normalizeBundlePath(value);
    const candidates =
      key === "command" && entryDirectory && normalized
        ? [normalized, normalizeBundlePath(join(entryDirectory, normalized))]
        : [normalized];
    const resolved = candidates.find(
      (candidate) =>
        candidate === "" ||
        virtualPaths.has(candidate) ||
        [...virtualPaths].some((path) => path.startsWith(candidate + "/")),
    );
    if (resolved === undefined) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Authority bundle asset ${normalized || "."} is missing`,
      );
    }
    return resolved === "" ? root : join(root, resolved);
  }
  if (Array.isArray(value)) {
    return value.map((item) => rebaseValue(item, key, root, virtualPaths, entryDirectory));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        rebaseValue(child, childKey, root, virtualPaths, entryDirectory),
      ]),
    );
  }
  return value;
}
function isRelativeExecutablePath(value: string): boolean {
  return (
    !/\s/u.test(value) &&
    (value.startsWith("./") ||
      value.startsWith("../") ||
      value.includes("/") ||
      value.includes("\\"))
  );
}

function isLocalPathKey(key: string | undefined): boolean {
  return (
    key === "specPath" ||
    key === "discoveryPath" ||
    key === "schemaPath" ||
    key === "documentPath" ||
    key === "configPath" ||
    key === "capletsRoot" ||
    key === "cwd" ||
    key === "command"
  );
}

function hasInterpolation(value: string): boolean {
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$env:|\$vault:|\$\{vault:/u.test(value);
}

function stagedPath(source: StagedConfigSource): string {
  if (source.fingerprintPath) return source.fingerprintPath;
  if (typeof source.source.path === "string") return source.source.path;
  return Object.values(source.source.path)[0] ?? "";
}

function assertAuthorityStagedCollisions(inputs: Array<ConfigInputWithSource | undefined>): void {
  const authorityIds = new Set<string>();
  const stagedIds = new Set<string>();
  const authorityRecordsById = new Set<string>();
  const authoritySources = new Map<string, string[]>();
  const stagedSources = new Map<string, string[]>();
  for (const entry of inputs) {
    if (!entry?.input) continue;
    const target = entry.source.kind === "authority" ? authorityIds : stagedIds;
    const sourceMap = entry.source.kind === "authority" ? authoritySources : stagedSources;
    const sourcePath =
      typeof entry.source.path === "string"
        ? entry.source.path
        : Object.values(entry.source.path).join(", ");
    for (const id of configInputIds(entry.input)) {
      if (entry.source.kind === "authority" && authorityRecordsById.has(id)) {
        throw new CapletsError("CONFIG_INVALID", `Duplicate authority Caplet ID ${id}`);
      }
      target.add(id);
      sourceMap.set(id, [...(sourceMap.get(id) ?? []), sourcePath]);
      if (entry.source.kind === "authority") authorityRecordsById.add(id);
    }
  }
  const collisions = [...authorityIds].filter((id) => stagedIds.has(id));
  if (collisions.length > 0) {
    const details = collisions
      .sort()
      .map(
        (id) =>
          `${id} (staged: ${(stagedSources.get(id) ?? []).join(", ")}; authority: ${(authoritySources.get(id) ?? []).join(", ")})`,
      )
      .join("; ");
    throw new CapletsError("CONFIG_INVALID", `Authority/staged Caplet ID collision: ${details}`, {
      collisions,
      stagedSources: Object.fromEntries(collisions.map((id) => [id, stagedSources.get(id) ?? []])),
      authoritySources: Object.fromEntries(
        collisions.map((id) => [id, authoritySources.get(id) ?? []]),
      ),
    });
  }
}

function configInputIds(input: ConfigInput): string[] {
  return [
    ...Object.keys(input.mcpServers ?? {}),
    ...Object.keys(input.openapiEndpoints ?? {}),
    ...Object.keys(input.googleDiscoveryApis ?? {}),
    ...Object.keys(input.graphqlEndpoints ?? {}),
    ...Object.keys(input.httpApis ?? {}),
    ...Object.keys(input.cliTools ?? {}),
    ...Object.keys(input.capletSets ?? {}),
  ];
}

async function fingerprintDirectory(root: string, current: string, hash: Hash): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(current, entry.name);
    const virtual = relative(root, path).replace(/\\/gu, "/");
    if (entry.isSymbolicLink()) {
      throw new CapletsError("CONFIG_INVALID", `Staged source contains symbolic link ${virtual}`);
    }
    if (entry.isDirectory()) {
      hash.update(`d:${virtual}\0`);
      await fingerprintDirectory(root, path, hash);
      continue;
    }
    if (!entry.isFile()) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Staged source contains unsupported entry ${virtual}`,
      );
    }
    hash.update(`f:${virtual}\0`);
    hash.update(await readFile(path));
    hash.update("\0");
  }
}

function loadCapletFilesFromFilesystem(root: string): CapletFileLoadResult | undefined {
  const absoluteRoot = resolve(root);
  const entries = collectFilesSync(absoluteRoot);
  return loadCapletFilesFromMap({ files: entries });
}

function collectFilesSync(root: string): Array<{ path: string; content: string }> {
  const output: Array<{ path: string; content: string }> = [];
  const visit = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new CapletsError("CONFIG_INVALID", `Staged source contains symbolic link ${path}`);
      }
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        output.push({
          path: relative(root, path).replace(/\\/gu, "/"),
          content: readFileSync(path, "utf8"),
        });
      }
    }
  };
  visit(root);
  return output;
}

export async function loadStagedFilesystemSourceAsync(options: {
  configPath?: string | undefined;
  capletsRoot?: string | undefined;
  configKind?: Exclude<ConfigSource["kind"], "authority">;
  fileKind?: Exclude<ConfigSource["kind"], "authority">;
}): Promise<StagedConfigSource[]> {
  const configKind = options.configKind ?? "global-config";
  const fileKind = options.fileKind ?? "global-file";
  const loaded: StagedConfigSource[] = [];
  if (options.configPath) {
    loaded.push({
      input: readConfigInputForComposition(options.configPath),
      source: { kind: configKind, path: options.configPath },
      fingerprintPath: options.configPath,
    });
  }
  if (options.capletsRoot) {
    const files = await collectFiles(options.capletsRoot);
    const result = loadCapletFilesFromMap({ files });
    if (result) {
      loaded.push({
        input: result.config as ConfigInput,
        source: { kind: fileKind, path: result.paths },
        fingerprintPath: options.capletsRoot,
      });
    }
  }
  return loaded;
}

async function collectFiles(root: string): Promise<Array<{ path: string; content: string }>> {
  const absoluteRoot = resolve(root);
  const output: Array<{ path: string; content: string }> = [];
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new CapletsError("CONFIG_INVALID", `Staged source contains symbolic link ${path}`);
      }
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        output.push({
          path: relative(absoluteRoot, path).replace(/\\/gu, "/"),
          content: await readFile(path, "utf8"),
        });
      }
    }
  }
  await visit(absoluteRoot);
  return output;
}

export function capletIds(config: CapletsConfig): string[] {
  return [
    ...Object.keys(config.mcpServers),
    ...Object.keys(config.openapiEndpoints),
    ...Object.keys(config.googleDiscoveryApis ?? {}),
    ...Object.keys(config.graphqlEndpoints),
    ...Object.keys(config.httpApis),
    ...Object.keys(config.cliTools),
    ...Object.keys(config.capletSets),
  ];
}

export function authoritySourceForCaplet(source: ConfigSource, caplet: CapletConfig): ConfigSource {
  return source.kind === "authority"
    ? { ...source, recordId: source.recordId ?? caplet.server }
    : source;
}
