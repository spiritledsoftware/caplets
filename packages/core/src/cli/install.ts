import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { discoverCapletFiles, loadCapletFilesWithPaths, validateCapletFile } from "../caplet-files";
import type { CapletFileConfig } from "../caplet-files";
import { resolveProjectCapletsRoot } from "../config";
import { SERVER_ID_PATTERN } from "../config/validation";
import { CapletsError, toSafeError } from "../errors";
import type { CatalogIndexingResult } from "../catalog-indexing/payload";
import { catalogIndexingPayloadForLockEntry } from "../catalog-indexing/eligibility";
import {
  catalogAuthRequiredFromFrontmatter,
  catalogIconFromFrontmatter,
  catalogMutatesExternalStateFromFrontmatter,
  catalogProjectBindingRequiredFromFrontmatter,
  catalogSetupRequiredFromFrontmatter,
  catalogStringArrayFromFrontmatter,
  catalogStringFromFrontmatter,
  catalogUsesLocalControlFromFrontmatter,
  catalogWorkflowSummaryFromFrontmatter,
  catalogWorkflowSummaryForBackendFamily,
  createCatalogEntry,
  normalizeCatalogSourceIdentity,
  type CatalogEntry,
  type CatalogEntryChild,
  type CatalogWorkflowSummary,
} from "../catalog";
import {
  readCapletsLockfile,
  validateLockfileDestination,
  writeCapletsLockfile,
  type CapletsLockEntry,
  type CapletsLockSource,
} from "./lockfile";
import type { CurrentHostCatalogOperations } from "../current-host/catalog-operations";
import type {
  CurrentHostOperation,
  CurrentHostOperatorPrincipal,
} from "../current-host/operations";
import type { CliAuthorityContext } from "./auth";

export type InstallableCaplet = {
  id: string;
  source: string;
  destination: string;
  kind: "file" | "directory";
  hash?: string | undefined;
  status?: "installed" | "restored" | "updated" | "noop" | undefined;
  lockfile?: string | undefined;
  catalogIndexing?: CatalogIndexingResult | undefined;
  vaultSetup?: unknown;
};
type CatalogInstallOperation = Extract<CurrentHostOperation, { kind: "catalog_install" }>;
type CatalogUpdateOperation = Extract<CurrentHostOperation, { kind: "catalog_update" }>;

export type CatalogCliResult = {
  installed: InstallableCaplet[];
  setupActions?: unknown[];
  status?: string;
  generation?: unknown;
  committedGeneration?: unknown;
  activation?: string;
  idempotencyKey?: string;
  replayed?: boolean;
  operation?: string;
};

export type InstallCapletsCliOptions = {
  capletIds?: string[];
  destinationRoot?: string;
  force?: boolean;
  lockfilePath?: string | undefined;
  now?: Date | undefined;
  source?: string | undefined;
  entryKey?: string | undefined;
  disableCatalogIndexing?: boolean | undefined;
  expectedGeneration?: CatalogInstallOperation["expectedGeneration"];
  idempotencyKey?: string | undefined;
  authority?: CliAuthorityContext | undefined;
  catalog?: CurrentHostCatalogOperations | undefined;
  principal?: CurrentHostOperatorPrincipal | undefined;
};

export type UpdateCapletsCliOptions = {
  destinationRoot?: string;
  lockfilePath: string;
  force?: boolean;
  allowRiskIncrease?: boolean;
  capletIds?: string[] | undefined;
  now?: Date | undefined;
  disableCatalogIndexing?: boolean | undefined;
  expectedGeneration?: CatalogUpdateOperation["expectedGeneration"];
  idempotencyKey?: string | undefined;
  authority?: CliAuthorityContext | undefined;
  catalog?: CurrentHostCatalogOperations | undefined;
  principal?: CurrentHostOperatorPrincipal | undefined;
};

/**
 * Run an install through the resolved Current Host catalog facade when one is
 * supplied. The shared branch requires a stable catalog identity and never
 * falls back to filesystem installation.
 */
export async function installCapletsForCli(
  repo: string | undefined,
  options: InstallCapletsCliOptions = {},
): Promise<CatalogCliResult> {
  const catalog = options.catalog ?? options.authority?.catalog;
  if (catalog || options.authority) {
    if (!catalog) {
      throw new CapletsError(
        "ASYNC_AUTHORITY_REQUIRED",
        "Shared authority catalog install requires the Current Host catalog facade.",
      );
    }
    const principal = options.principal ?? options.authority?.principal;
    if (!principal) {
      throw new CapletsError(
        "AUTH_FAILED",
        "Shared authority catalog install requires an Operator principal.",
      );
    }
    if (!options.source || !options.entryKey) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Shared authority catalog install requires a stable source and entryKey.",
      );
    }
    const outcome = await catalog.install(principal, {
      kind: "catalog_install",
      source: options.source,
      entryKey: options.entryKey,
      ...(options.capletIds === undefined ? {} : { capletIds: options.capletIds }),
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.disableCatalogIndexing === undefined
        ? {}
        : { disableCatalogIndexing: options.disableCatalogIndexing }),
      ...(options.expectedGeneration === undefined
        ? {}
        : { expectedGeneration: options.expectedGeneration }),
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    });
    return {
      installed: outcome.installed as InstallableCaplet[],
      ...(outcome.setupActions ? { setupActions: outcome.setupActions } : {}),
      ...copyCatalogReceipt(outcome),
    };
  }
  if (!repo) {
    if (!options.lockfilePath) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Install requires a repository or lockfile source.",
      );
    }
    return restoreCapletsFromLockfile({
      ...(options.capletIds === undefined ? {} : { capletIds: options.capletIds }),
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.destinationRoot === undefined
        ? {}
        : { destinationRoot: options.destinationRoot }),
      lockfilePath: options.lockfilePath,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }
  return installCaplets(repo, options);
}

/**
 * Run an update through the resolved Current Host catalog facade when one is
 * supplied. The shared branch performs one authority mutation and never writes
 * a local lockfile or destination.
 */
export async function updateCapletsForCli(
  options: UpdateCapletsCliOptions,
): Promise<CatalogCliResult> {
  const catalog = options.catalog ?? options.authority?.catalog;
  if (catalog || options.authority) {
    if (!catalog) {
      throw new CapletsError(
        "ASYNC_AUTHORITY_REQUIRED",
        "Shared authority catalog update requires the Current Host catalog facade.",
      );
    }
    const principal = options.principal ?? options.authority?.principal;
    if (!principal) {
      throw new CapletsError(
        "AUTH_FAILED",
        "Shared authority catalog update requires an Operator principal.",
      );
    }
    const outcome = await catalog.update(principal, {
      kind: "catalog_update",
      ...(options.capletIds === undefined ? {} : { capletIds: options.capletIds }),
      ...(options.force === undefined ? {} : { force: options.force }),
      ...(options.allowRiskIncrease === undefined
        ? {}
        : { allowRiskIncrease: options.allowRiskIncrease }),
      ...(options.disableCatalogIndexing === undefined
        ? {}
        : { disableCatalogIndexing: options.disableCatalogIndexing }),
      ...(options.expectedGeneration === undefined
        ? {}
        : { expectedGeneration: options.expectedGeneration }),
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    });
    return {
      installed: outcome.installed as InstallableCaplet[],
      ...(outcome.setupActions ? { setupActions: outcome.setupActions } : {}),
      ...copyCatalogReceipt(outcome),
    };
  }
  return updateCapletsFromLockfile(options);
}

function copyCatalogReceipt(
  outcome: Partial<{
    status: string | undefined;
    generation: unknown;
    committedGeneration: unknown;
    activation: string | undefined;
    idempotencyKey: string | undefined;
    replayed: boolean | undefined;
    operation: string | undefined;
  }>,
): Pick<
  CatalogCliResult,
  | "status"
  | "generation"
  | "committedGeneration"
  | "activation"
  | "idempotencyKey"
  | "replayed"
  | "operation"
> {
  return {
    ...(outcome.status === undefined ? {} : { status: outcome.status }),
    ...(outcome.generation === undefined ? {} : { generation: outcome.generation }),
    ...(outcome.committedGeneration === undefined
      ? {}
      : { committedGeneration: outcome.committedGeneration }),
    ...(outcome.activation === undefined ? {} : { activation: outcome.activation }),
    ...(outcome.idempotencyKey === undefined ? {} : { idempotencyKey: outcome.idempotencyKey }),
    ...(outcome.replayed === undefined ? {} : { replayed: outcome.replayed }),
    ...(outcome.operation === undefined ? {} : { operation: outcome.operation }),
  };
}

type InstallPlan = InstallableCaplet & {
  sourcePath: string;
  sourceBoundary: string;
};

type LockedSourceResolution = {
  sourcePath: string;
  repoRoot: string;
  resolvedRevision?: string | undefined;
  cleanup: () => void;
};

export function installCaplets(
  repo: string,
  options: {
    capletIds?: string[];
    destinationRoot?: string;
    force?: boolean;
    lockfilePath?: string | undefined;
    now?: Date | undefined;
  } = {},
): { installed: InstallableCaplet[] } {
  const source = resolveInstallSource(repo);
  try {
    const sourceRoot = join(source.repoRoot, "caplets");
    if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
      throw new CapletsError("CONFIG_NOT_FOUND", `No caplets directory found at ${sourceRoot}`);
    }

    const selectedIds = new Set(options.capletIds ?? []);
    const destinationRoot = options.destinationRoot ?? resolveProjectCapletsRoot();
    const available =
      selectedIds.size === 0
        ? discoverCapletFiles(sourceRoot)
        : discoverSelectedCapletFiles(sourceRoot, selectedIds);
    const selected = available.filter(
      (caplet) => selectedIds.size === 0 || selectedIds.has(caplet.id),
    );
    const missing = [...selectedIds].filter((id) => !available.some((caplet) => caplet.id === id));
    if (missing.length > 0) {
      const childGuidance = selectedChildInstallGuidance(sourceRoot, missing);
      throw new CapletsError(
        "CONFIG_NOT_FOUND",
        childGuidance ?? `Caplet ${missing.join(", ")} not found in ${sourceRoot}`,
      );
    }
    if (selected.length === 0) {
      throw new CapletsError("CONFIG_NOT_FOUND", `No Caplets found in ${sourceRoot}`);
    }
    rejectDuplicateSourceIds(selected);

    for (const caplet of selected) {
      validateCapletFile(caplet.path);
    }
    const plans = preflightInstallCaplets(selected, {
      destinationRoot,
      force: Boolean(options.force),
      repoRoot: source.repoRoot,
      sourceId: source.id,
    });
    const now = options.now ?? new Date();
    const installed: InstallableCaplet[] = [];
    for (const plan of plans) {
      const caplet = installOneCaplet(plan, { force: Boolean(options.force) });
      const installedWithHash = {
        ...caplet,
        hash: hashInstalledArtifact(caplet.destination),
        status: "installed" as const,
        ...(options.lockfilePath ? { lockfile: options.lockfilePath } : {}),
      };
      installed.push(options.lockfilePath ? installedWithHash : caplet);
      if (options.lockfilePath) {
        updateLockfileAfterInstall(options.lockfilePath, [plan], [installedWithHash], {
          source,
          now,
        });
      }
    }
    return { installed };
  } finally {
    source.cleanup();
  }
}

export function restoreCapletsFromLockfile(options: {
  destinationRoot?: string;
  lockfilePath: string;
  force?: boolean;
  capletIds?: string[] | undefined;
  now?: Date | undefined;
}): { installed: InstallableCaplet[] } {
  const destinationRoot = options.destinationRoot ?? resolveProjectCapletsRoot();
  const lockfile = readCapletsLockfile(options.lockfilePath);
  const selectedIds = new Set(options.capletIds ?? []);
  const entries = lockfile.entries.filter(
    (entry) => selectedIds.size === 0 || selectedIds.has(entry.id),
  );
  const missing = [...selectedIds].filter(
    (id) => !lockfile.entries.some((entry) => entry.id === id),
  );
  if (missing.length > 0) {
    throw new CapletsError(
      "CONFIG_NOT_FOUND",
      `Caplet ${missing.join(", ")} not found in lockfile`,
    );
  }
  if (entries.length === 0) {
    throw new CapletsError(
      "CONFIG_NOT_FOUND",
      `No Caplets found in lockfile ${options.lockfilePath}`,
    );
  }

  const nextEntries = new Map(lockfile.entries.map((entry) => [entry.id, entry]));
  const results: InstallableCaplet[] = [];
  for (const entry of entries) {
    const destination = validateLockfileDestination(destinationRoot, entry.destination);
    const existing = lstatIfExists(destination);
    if (existing) {
      const currentHash = hashInstalledArtifact(destination);
      if (currentHash === entry.installedHash) {
        results.push({
          id: entry.id,
          source: lockSourceDisplay(entry.source),
          destination,
          kind: entry.kind,
          hash: currentHash,
          status: "noop",
          lockfile: options.lockfilePath,
        });
        continue;
      }
      if (!options.force) {
        throw new CapletsError(
          "CONFIG_EXISTS",
          `Caplet ${entry.id} has local modifications at ${destination}; pass --force to replace it`,
        );
      }
    }

    const lockedSource = resolveLockedSource(entry.source);
    try {
      const plan: InstallPlan = {
        id: entry.id,
        source: lockSourceDisplay(entry.source),
        sourcePath: lockedSource.sourcePath,
        sourceBoundary: dirname(lockedSource.sourcePath),
        destination,
        kind: entry.kind,
      };
      preflightInstallCaplets(
        [
          {
            id: entry.id,
            path:
              entry.kind === "directory"
                ? join(lockedSource.sourcePath, "CAPLET.md")
                : lockedSource.sourcePath,
          },
        ],
        {
          destinationRoot,
          force: true,
          repoRoot: lockedSource.repoRoot,
          sourceId: lockSourceDisplay(entry.source),
        },
      );
      installOneCaplet(plan, { force: true });
      const hash = hashInstalledArtifact(destination);
      if (hash !== entry.installedHash) {
        nextEntries.set(entry.id, {
          ...entry,
          installedHash: hash,
          updatedAt: (options.now ?? new Date()).toISOString(),
        });
        writeCapletsLockfile(options.lockfilePath, {
          version: 1,
          entries: [...nextEntries.values()],
        });
      }
      results.push({
        id: entry.id,
        source: lockSourceDisplay(entry.source),
        destination,
        kind: entry.kind,
        hash,
        status: "restored",
        lockfile: options.lockfilePath,
      });
    } finally {
      lockedSource.cleanup();
    }
  }
  return { installed: results };
}

export function updateCapletsFromLockfile(options: {
  destinationRoot?: string;
  lockfilePath: string;
  force?: boolean;
  allowRiskIncrease?: boolean;
  capletIds?: string[] | undefined;
  now?: Date | undefined;
}): { installed: InstallableCaplet[] } {
  const destinationRoot = options.destinationRoot ?? resolveProjectCapletsRoot();
  const lockfile = readCapletsLockfile(options.lockfilePath);
  const selectedIds = new Set(options.capletIds ?? []);
  const entries = lockfile.entries.filter(
    (entry) => selectedIds.size === 0 || selectedIds.has(entry.id),
  );
  const missing = [...selectedIds].filter(
    (id) => !lockfile.entries.some((entry) => entry.id === id),
  );
  if (missing.length > 0) {
    throw new CapletsError(
      "CONFIG_NOT_FOUND",
      `Caplet ${missing.join(", ")} not found in lockfile`,
    );
  }
  if (entries.length === 0) {
    throw new CapletsError(
      "CONFIG_NOT_FOUND",
      `No Caplets found in lockfile ${options.lockfilePath}`,
    );
  }

  const allowRiskIncrease = options.allowRiskIncrease ?? options.force ?? false;
  const nextEntries = new Map(lockfile.entries.map((entry) => [entry.id, entry]));
  const results: InstallableCaplet[] = [];
  for (const entry of entries) {
    const destination = validateLockfileDestination(destinationRoot, entry.destination);
    const existing = lstatIfExists(destination);
    if (existing) {
      const currentHash = hashInstalledArtifact(destination);
      if (currentHash !== entry.installedHash && !options.force) {
        throw new CapletsError(
          "CONFIG_EXISTS",
          `Caplet ${entry.id} has local modifications at ${destination}; pass --force to update it`,
        );
      }
    }

    const lockedSource = resolveLockedSource(entry.source, { useResolvedRevision: false });
    try {
      if (!existsSync(lockedSource.sourcePath)) {
        throw new CapletsError("CONFIG_NOT_FOUND", `Locked source for ${entry.id} is unavailable`);
      }
      const nextSource = refreshedLockSource(entry.source, lockedSource);
      const sourceHash =
        entry.kind === "directory"
          ? hashDirectoryCapletInstallSource(
              lockedSource.sourcePath,
              realpathSync(dirname(lockedSource.sourcePath)),
            )
          : hashInstalledArtifact(lockedSource.sourcePath);
      const nextRisk = riskSummaryForSourcePath(lockedSource.sourcePath);
      if (existing && sourceHash === entry.installedHash && !options.force) {
        const sourceChanged = !sameLockSource(entry.source, nextSource);
        const riskChanged = !sameLockRisk(entry.risk, nextRisk);
        if (sourceChanged || riskChanged) {
          nextEntries.set(entry.id, {
            ...entry,
            source: nextSource,
            risk: nextRisk,
            updatedAt: (options.now ?? new Date()).toISOString(),
          });
          writeCapletsLockfile(options.lockfilePath, {
            version: 1,
            entries: [...nextEntries.values()],
          });
        }
        results.push({
          id: entry.id,
          source: lockSourceDisplay(entry.source),
          destination,
          kind: entry.kind,
          hash: entry.installedHash,
          status: "noop",
          lockfile: options.lockfilePath,
        });
        continue;
      }
      if (!allowRiskIncrease && riskIncrease(entry.risk, nextRisk)) {
        throw new CapletsError(
          "REQUEST_INVALID",
          `Caplet ${entry.id} update changes its risk profile; pass --force to update it`,
        );
      }

      const plan: InstallPlan = {
        id: entry.id,
        source: lockSourceDisplay(entry.source),
        sourcePath: lockedSource.sourcePath,
        sourceBoundary: dirname(lockedSource.sourcePath),
        destination,
        kind: entry.kind,
      };
      preflightInstallCaplets(
        [
          {
            id: entry.id,
            path:
              entry.kind === "directory"
                ? join(lockedSource.sourcePath, "CAPLET.md")
                : lockedSource.sourcePath,
          },
        ],
        {
          destinationRoot,
          force: true,
          repoRoot: lockedSource.repoRoot,
          sourceId: lockSourceDisplay(entry.source),
        },
      );
      installOneCaplet(plan, { force: true });
      const hash = hashInstalledArtifact(destination);
      const now = (options.now ?? new Date()).toISOString();
      nextEntries.set(entry.id, {
        ...entry,
        source: nextSource,
        installedHash: hash,
        updatedAt: now,
        risk: nextRisk,
      });
      writeCapletsLockfile(options.lockfilePath, {
        version: 1,
        entries: [...nextEntries.values()],
      });
      results.push({
        id: entry.id,
        source: lockSourceDisplay(entry.source),
        destination,
        kind: entry.kind,
        hash,
        status: "updated",
        lockfile: options.lockfilePath,
      });
    } finally {
      lockedSource.cleanup();
    }
  }
  return { installed: results };
}

export async function indexInstalledCapletsFromLockfile(
  installed: Array<{ id: string; destination?: string | undefined; lockfile?: string | undefined }>,
  options: {
    disableCatalogIndexing?: boolean | undefined;
    endpoint?: string | undefined;
    fetch?: typeof fetch | undefined;
  } = {},
): Promise<Map<string, CatalogIndexingResult>> {
  const byLockfile = new Map<string, Set<string>>();
  if (options.disableCatalogIndexing || process.env.CAPLETS_DISABLE_CATALOG_INDEXING === "1") {
    return new Map(
      installed.map((entry) => [
        entry.id,
        { status: "ineligible", reason: "catalog_indexing_disabled" },
      ]),
    );
  }
  for (const entry of installed) {
    if (!entry.lockfile) continue;
    byLockfile.set(entry.lockfile, (byLockfile.get(entry.lockfile) ?? new Set()).add(entry.id));
  }

  const results = new Map<string, CatalogIndexingResult>();
  for (const [lockfilePath, ids] of byLockfile) {
    let lockfile: ReturnType<typeof readCapletsLockfile>;
    try {
      lockfile = readCapletsLockfile(lockfilePath);
    } catch {
      for (const id of ids) {
        results.set(id, { status: "unavailable", reason: "lockfile_unavailable" });
      }
      continue;
    }
    const destinations = new Map(
      installed
        .filter((candidate) => candidate.lockfile === lockfilePath && candidate.destination)
        .map((candidate) => [candidate.id, candidate.destination!]),
    );
    const indexed = await Promise.all(
      lockfile.entries
        .filter((candidate) => ids.has(candidate.id))
        .map(async (entry) => {
          const payload = catalogIndexingPayloadForLockEntry(entry);
          if ("status" in payload) {
            return [entry.id, payload] as const;
          }
          payload.entry = catalogEntryForInstalledLockEntry(
            entry,
            destinations.get(entry.id),
            payload.sourcePath,
          );
          return [entry.id, await submitCatalogIndexingPayload(payload, options)] as const;
        }),
    );
    for (const [id, result] of indexed) {
      results.set(id, result);
    }
  }
  return results;
}

async function submitCatalogIndexingPayload(
  payload: {
    source: string;
    capletId: string;
    sourcePath: string;
    resolvedRevision?: string | undefined;
    contentHash?: string | undefined;
    entryKey: string;
    entry?: CatalogEntry | undefined;
  },
  options: {
    endpoint?: string | undefined;
    fetch?: typeof fetch | undefined;
  },
): Promise<CatalogIndexingResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    return { status: "unavailable", entryKey: payload.entryKey, reason: "fetch_unavailable" };
  }
  const endpoint =
    options.endpoint ??
    process.env.CAPLETS_CATALOG_INDEX_URL ??
    "https://catalog.caplets.dev/api/v1/catalog/install-signals";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { status: "unavailable", entryKey: payload.entryKey, reason: "indexer_unavailable" };
    }
    const parsed = (await response.json().catch(() => undefined)) as
      | { result?: CatalogIndexingResult }
      | undefined;
    return parsed?.result?.status
      ? { ...parsed.result, entryKey: parsed.result.entryKey ?? payload.entryKey }
      : { status: "accepted", entryKey: payload.entryKey };
  } catch {
    return { status: "unavailable", entryKey: payload.entryKey, reason: "indexer_unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

function catalogEntryForInstalledLockEntry(
  entry: CapletsLockEntry,
  destination: string | undefined,
  sourcePath: string,
): CatalogEntry | undefined {
  if (entry.source.type !== "git" || !destination) return undefined;
  const source = normalizeCatalogSourceIdentity(entry.source.repository);
  if (!source.eligible) return undefined;
  try {
    const capletFile = lstatSync(destination).isDirectory()
      ? join(destination, "CAPLET.md")
      : destination;
    const contentMarkdown = readFileSync(capletFile, "utf8");
    const frontmatter = readCapletFrontmatterFromText(contentMarkdown);
    return createCatalogEntry({
      id: entry.id,
      name: catalogStringFromFrontmatter(frontmatter.name) ?? entry.id,
      description:
        catalogStringFromFrontmatter(frontmatter.description) ?? `Community Caplet ${entry.id}.`,
      source: source.source,
      sourcePath,
      trustLevel: "community",
      resolvedRevision: entry.source.resolvedRevision,
      indexedContentHash: entry.installedHash,
      contentMarkdown,
      icon: catalogIconFromFrontmatter(frontmatter, {
        id: entry.id,
        source: source.source,
        sourcePath,
        trustLevel: "community",
        resolvedRevision: entry.source.resolvedRevision,
      }),
      tags: catalogStringArrayFromFrontmatter(frontmatter.tags),
      useWhen: catalogStringFromFrontmatter(frontmatter.useWhen),
      avoidWhen: catalogStringFromFrontmatter(frontmatter.avoidWhen),
      setupRequired: catalogSetupRequiredFromFrontmatter(frontmatter),
      authRequired: catalogAuthRequiredFromFrontmatter(frontmatter),
      projectBindingRequired: catalogProjectBindingRequiredFromFrontmatter(frontmatter),
      workflow: catalogWorkflowSummaryFromFrontmatter(
        frontmatter,
        workflowSummaryFromRisk(entry.risk),
      ),
      mutatesExternalState: catalogMutatesExternalStateFromFrontmatter(frontmatter),
      localControl: catalogUsesLocalControlFromFrontmatter(frontmatter),
      children: catalogChildrenForInstalledLockEntry(entry, destination),
    });
  } catch {
    return undefined;
  }
}

function catalogChildrenForInstalledLockEntry(
  entry: CapletsLockEntry,
  destination: string,
): CatalogEntryChild[] | undefined {
  try {
    const loaded = loadCapletFilesWithPaths(dirname(destination));
    const children = Object.entries(loaded?.metadata ?? {}).flatMap(([id, metadata]) => {
      if (metadata.parentId !== entry.id || !metadata.childId) {
        return [];
      }
      const config = capletConfigForMetadata(loaded?.config, metadata.backend, id);
      return [
        {
          id,
          childId: metadata.childId,
          name: catalogStringFromFrontmatter(config?.name) ?? metadata.childId,
          backend: metadata.backend,
          workflow: catalogWorkflowSummaryForBackendFamily(metadata.backend) ?? {
            kind: "unknown",
            label: "Unknown" as const,
          },
        },
      ];
    });
    return children.length > 0
      ? children.sort((left, right) => left.id.localeCompare(right.id))
      : undefined;
  } catch {
    return undefined;
  }
}

function capletConfigForMetadata(
  config: CapletFileConfig | undefined,
  backend: string,
  id: string,
): Record<string, unknown> | undefined {
  const mapKey = {
    mcp: "mcpServers",
    openapi: "openapiEndpoints",
    googleDiscovery: "googleDiscoveryApis",
    graphql: "graphqlEndpoints",
    http: "httpApis",
    cli: "cliTools",
    caplets: "capletSets",
  }[backend];
  if (!mapKey) return undefined;
  const backends = config?.[mapKey as keyof NonNullable<typeof config>];
  const value = isRecord(backends) ? backends[id] : undefined;
  return isRecord(value) ? value : undefined;
}

function workflowSummaryFromRisk(risk: CapletsLockEntry["risk"]): CatalogWorkflowSummary {
  return (
    catalogWorkflowSummaryForBackendFamily(risk.backendFamilies[0]) ?? {
      kind: "set",
      label: "Caplet",
    }
  );
}

function refreshedLockSource(
  source: CapletsLockSource,
  lockedSource: LockedSourceResolution,
): CapletsLockSource {
  if (source.type === "git") {
    return {
      ...source,
      ...(lockedSource.resolvedRevision ? { resolvedRevision: lockedSource.resolvedRevision } : {}),
    };
  }
  return {
    ...source,
    ...localGitInfo(lockedSource.repoRoot),
  };
}

function sameLockSource(left: CapletsLockSource, right: CapletsLockSource): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameLockRisk(left: CapletsLockEntry["risk"], right: CapletsLockEntry["risk"]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function discoverSelectedCapletFiles(
  sourceRoot: string,
  selectedIds: Set<string>,
): Array<{ id: string; path: string }> {
  const candidates: Array<{ id: string; path: string }> = [];
  for (const id of selectedIds) {
    if (!SERVER_ID_PATTERN.test(id)) {
      continue;
    }

    const filePath = join(sourceRoot, `${id}.md`);
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      candidates.push({ id, path: filePath });
    }

    const directoryPath = join(sourceRoot, id, "CAPLET.md");
    if (existsSync(directoryPath) && statSync(directoryPath).isFile()) {
      candidates.push({ id, path: directoryPath });
    }
  }
  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}

function selectedChildInstallGuidance(
  sourceRoot: string,
  missingIds: string[],
): string | undefined {
  let loaded: ReturnType<typeof loadCapletFilesWithPaths>;
  try {
    loaded = loadCapletFilesWithPaths(sourceRoot);
  } catch {
    return undefined;
  }
  if (!loaded?.metadata) {
    return undefined;
  }

  const matches = missingIds.flatMap((id) => {
    const metadata = loaded?.metadata?.[id];
    return metadata?.childId
      ? [{ id, parentId: metadata.parentId, childId: metadata.childId }]
      : [];
  });
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length === 1 && missingIds.length === 1) {
    const match = matches[0]!;
    return `Caplet ${match.id} is a runtime child of ${match.parentId}; install parent Caplet ${match.parentId} instead.`;
  }
  const matchedIds = new Set(matches.map((match) => match.id));
  const unmatched = missingIds.filter((id) => !matchedIds.has(id));
  const missingSuffix =
    unmatched.length > 0 ? ` Also not found: ${unmatched.join(", ")} in ${sourceRoot}.` : "";
  return `Caplet child IDs are runtime-only and cannot be installed directly: ${matches
    .map((match) => `${match.id} -> ${match.parentId}`)
    .join(", ")}. Install the parent Caplet ID instead.${missingSuffix}`;
}

function resolveInstallSource(repo: string): {
  id: string;
  repoRoot: string;
  cleanup: () => void;
  sourceKind: "local" | "git";
  repository?: string | undefined;
  resolvedRevision?: string | undefined;
} {
  if (existsSync(repo) && statSync(repo).isDirectory()) {
    return { id: repo, repoRoot: repo, cleanup: () => {}, sourceKind: "local" };
  }

  const normalizedRepo = normalizeGitRepo(repo);
  const installSource = splitInstallSourceRef(normalizedRepo);
  const repoRoot = mkdtempSync(join(tmpdir(), "caplets-install-"));
  try {
    cloneInstallSource(installSource, repoRoot);
    const resolvedRevision = gitRevision(repoRoot);
    return {
      id: installSource.repository,
      repoRoot,
      sourceKind: "git",
      repository: installSource.repository,
      resolvedRevision,
      cleanup: () => removeInstallPath(repoRoot, `temporary install source ${repoRoot}`, true),
    };
  } catch (error) {
    removeInstallPath(repoRoot, `temporary install source ${repoRoot}`, true);
    throw new CapletsError("CONFIG_NOT_FOUND", `Could not clone repo ${repo}`, toSafeError(error));
  }
}

function cloneInstallSource(
  source: { repository: string; ref?: string | undefined },
  repoRoot: string,
): void {
  rejectOptionLikeInstallSourceRef(source.ref);
  if (!source.ref) {
    execFileSync("git", ["clone", "--depth", "1", "--", source.repository, repoRoot], {
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
    return;
  }

  try {
    execFileSync("git", ["init", repoRoot], {
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
    execFileSync("git", ["remote", "add", "origin", source.repository], {
      cwd: repoRoot,
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
    execFileSync("git", ["fetch", "--depth", "1", "origin", source.ref], {
      cwd: repoRoot,
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
    execFileSync("git", ["checkout", "--detach", "FETCH_HEAD"], {
      cwd: repoRoot,
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
  } catch {
    rmSync(repoRoot, { recursive: true, force: true });
    mkdirSync(repoRoot, { recursive: true });
    execFileSync("git", ["clone", "--", source.repository, repoRoot], {
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
    execFileSync("git", ["checkout", "--detach", source.ref], {
      cwd: repoRoot,
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
  }
}

function rejectOptionLikeInstallSourceRef(ref: string | undefined): void {
  if (ref?.startsWith("-")) {
    throw new CapletsError("CONFIG_NOT_FOUND", "Install source refs cannot start with '-'.");
  }
}

function updateLockfileAfterInstall(
  lockfilePath: string,
  plans: InstallPlan[],
  installed: InstallableCaplet[],
  options: {
    source: ReturnType<typeof resolveInstallSource>;
    now: Date;
  },
): void {
  const existing = existsSync(lockfilePath)
    ? readCapletsLockfile(lockfilePath)
    : { version: 1 as const, entries: [] };
  const installedById = new Map(installed.map((caplet) => [caplet.id, caplet]));
  const next = new Map(existing.entries.map((entry) => [entry.id, entry]));
  for (const plan of plans) {
    const caplet = installedById.get(plan.id);
    if (!caplet?.hash) continue;
    const now = options.now.toISOString();
    const previous = next.get(plan.id);
    next.set(plan.id, {
      id: plan.id,
      destination: destinationDisplay(plan, caplet.destination),
      kind: plan.kind,
      source: lockSourceForPlan(plan, options.source),
      installedHash: caplet.hash,
      installedAt: previous?.installedAt ?? now,
      updatedAt: now,
      risk: riskSummaryForSourcePath(plan.sourcePath),
    });
  }
  writeCapletsLockfile(lockfilePath, { version: 1, entries: [...next.values()] });
}

function destinationDisplay(plan: InstallPlan, destination: string): string {
  return plan.kind === "file" ? `${plan.id}.md` : basename(destination);
}

function lockSourceForPlan(
  plan: InstallPlan,
  source: ReturnType<typeof resolveInstallSource>,
): CapletsLockSource {
  const sourcePath = relative(source.repoRoot, plan.sourcePath).replace(/\\/g, "/");
  if (source.sourceKind === "git") {
    return {
      type: "git",
      repository: source.repository ?? source.id,
      path: sourcePath,
      trackedRef: "HEAD",
      resolvedRevision: source.resolvedRevision,
      portability: "portable",
    };
  }
  return {
    type: "local",
    path: plan.sourcePath,
    portability: "non_portable",
    ...localGitInfo(source.repoRoot),
  };
}

function resolveLockedSource(
  source: CapletsLockSource,
  options: { useResolvedRevision?: boolean } = {},
): LockedSourceResolution {
  const useResolvedRevision = options.useResolvedRevision ?? true;
  if (source.type === "local") {
    if (!existsSync(source.path)) {
      throw new CapletsError(
        "CONFIG_NOT_FOUND",
        `Locked local source ${source.path} is unavailable`,
      );
    }
    const repoRoot = inferLocalRepoRoot(source.path);
    return {
      sourcePath: source.path,
      repoRoot,
      resolvedRevision: gitRevision(repoRoot),
      cleanup: () => {},
    };
  }
  const repoRoot = mkdtempSync(join(tmpdir(), "caplets-restore-"));
  try {
    execFileSync("git", ["clone", "--", source.repository, repoRoot], {
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
    if (useResolvedRevision && source.resolvedRevision) {
      execFileSync("git", ["checkout", "--detach", source.resolvedRevision], {
        cwd: repoRoot,
        env: externalGitEnv(),
        stdio: "ignore",
        timeout: 60_000,
      });
    } else if (!useResolvedRevision && source.trackedRef && source.trackedRef !== "HEAD") {
      checkoutTrackedRef(repoRoot, source.trackedRef);
    }
    return {
      sourcePath: join(repoRoot, source.path),
      repoRoot,
      resolvedRevision: gitRevision(repoRoot),
      cleanup: () => removeInstallPath(repoRoot, `temporary restore source ${repoRoot}`, true),
    };
  } catch (error) {
    removeInstallPath(repoRoot, `temporary restore source ${repoRoot}`, true);
    throw new CapletsError(
      "CONFIG_NOT_FOUND",
      `Could not restore locked source ${source.repository}`,
      toSafeError(error),
    );
  }
}

function checkoutTrackedRef(repoRoot: string, trackedRef: string): void {
  try {
    execFileSync("git", ["checkout", "--detach", trackedRef], {
      cwd: repoRoot,
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
  } catch {
    execFileSync("git", ["checkout", "--detach", `origin/${trackedRef}`], {
      cwd: repoRoot,
      env: externalGitEnv(),
      stdio: "ignore",
      timeout: 60_000,
    });
  }
}

function riskSummaryForSourcePath(sourcePath: string): CapletsLockEntry["risk"] {
  const frontmatter = readCapletFrontmatter(sourcePath);
  const backendFamilies = capletBackendFamilies(frontmatter);
  const auth = capletAuth(frontmatter);
  const authScopes = capletAuthScopes(frontmatter);
  const runtime = isRecord(frontmatter.runtime) ? frontmatter.runtime : undefined;
  const projectBindingRequired =
    (isRecord(frontmatter.projectBinding) && frontmatter.projectBinding.required === true) ||
    capletPluralBackends(frontmatter).some(hasProjectBinding);
  const runtimeFeatures = [
    ...(Array.isArray(runtime?.features)
      ? runtime.features.filter((feature): feature is string => typeof feature === "string")
      : []),
    ...capletPluralBackends(frontmatter).flatMap((backend) => runtimeFeaturesForBackend(backend)),
  ];
  const mutating = capletCanMutate(frontmatter);
  const destructive = capletCanDestroy(frontmatter);
  return {
    backendFamilies: backendFamilies.length > 0 ? backendFamilies : ["unknown"],
    safety: derivedSafety({
      backendFamilies,
      auth,
      projectBindingRequired,
      runtimeFeatures,
      mutating,
      destructive,
      frontmatter,
    }),
    projectBindingRequired,
    authScopes: authScopes.length > 0 ? authScopes : undefined,
    runtimeFeatures: runtimeFeatures.length > 0 ? [...new Set(runtimeFeatures)] : undefined,
    mutating,
    destructive,
    bodyHash: hashInstalledArtifact(sourcePath),
  };
}

function riskIncrease(current: CapletsLockEntry["risk"], next: CapletsLockEntry["risk"]): boolean {
  if (current.safety === "unknown" || next.safety === "unknown") return true;
  if (riskRank(next.safety) > riskRank(current.safety)) return true;
  if (!current.projectBindingRequired && next.projectBindingRequired) return true;
  if (!current.mutating && next.mutating) return true;
  if (!current.destructive && next.destructive) return true;
  if (!isSubset(current.authScopes ?? [], next.authScopes ?? [])) return true;
  if (!isSubset(current.runtimeFeatures ?? [], next.runtimeFeatures ?? [])) return true;
  return false;
}

function readCapletFrontmatter(sourcePath: string): Record<string, unknown> {
  const capletFile = lstatSync(sourcePath).isDirectory()
    ? join(sourcePath, "CAPLET.md")
    : sourcePath;
  const text = readFileSync(capletFile, "utf8");
  return readCapletFrontmatterFromText(text);
}

function readCapletFrontmatterFromText(text: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  if (!match) return {};
  const yaml = match[1];
  if (yaml === undefined) return {};
  const parsed = parseYaml(yaml);
  return isRecord(parsed) ? parsed : {};
}

function capletBackendFamilies(frontmatter: Record<string, unknown>): string[] {
  const families: Array<readonly [string, string]> = [
    ["mcp", "mcpServer"],
    ["mcp", "mcpServers"],
    ["openapi", "openapiEndpoint"],
    ["openapi", "openapiEndpoints"],
    ["googleDiscovery", "googleDiscoveryApi"],
    ["googleDiscovery", "googleDiscoveryApis"],
    ["graphql", "graphqlEndpoint"],
    ["graphql", "graphqlEndpoints"],
    ["http", "httpApi"],
    ["http", "httpApis"],
    ["cli", "cliTools"],
    ["caplets", "capletSet"],
    ["caplets", "capletSets"],
  ];
  return [
    ...new Set(
      families.flatMap(([family, key]) => (frontmatter[key] === undefined ? [] : [family])),
    ),
  ];
}

function capletAuth(frontmatter: Record<string, unknown>): Record<string, unknown> | undefined {
  const blocks = capletAuthBlocks(frontmatter);
  return blocks.find((auth) => auth.type !== "none") ?? blocks[0];
}

function capletAuthScopes(frontmatter: Record<string, unknown>): string[] {
  return [
    ...new Set(
      capletAuthBlocks(frontmatter).flatMap((auth) =>
        Array.isArray(auth.scopes)
          ? auth.scopes.filter((scope): scope is string => typeof scope === "string")
          : [],
      ),
    ),
  ];
}

function capletAuthBlocks(frontmatter: Record<string, unknown>): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  if (isRecord(frontmatter.auth)) blocks.push(frontmatter.auth);
  for (const key of [
    "mcpServer",
    "openapiEndpoint",
    "googleDiscoveryApi",
    "graphqlEndpoint",
    "httpApi",
  ]) {
    const backend = frontmatter[key];
    if (isRecord(backend) && isRecord(backend.auth)) blocks.push(backend.auth);
  }
  for (const key of [
    "mcpServers",
    "openapiEndpoints",
    "googleDiscoveryApis",
    "graphqlEndpoints",
    "httpApis",
  ]) {
    for (const backend of capletPluralBackendValues(frontmatter[key])) {
      if (isRecord(backend.auth)) blocks.push(backend.auth);
    }
  }
  return blocks;
}

function derivedSafety(input: {
  backendFamilies: string[];
  auth: Record<string, unknown> | undefined;
  projectBindingRequired: boolean;
  runtimeFeatures: string[];
  mutating: boolean;
  destructive: boolean;
  frontmatter: Record<string, unknown>;
}): CapletsLockEntry["risk"]["safety"] {
  if (
    input.projectBindingRequired ||
    input.runtimeFeatures.length > 0 ||
    input.backendFamilies.includes("cli") ||
    isLocalMcpServer(input.frontmatter)
  ) {
    return "local_control";
  }
  if (
    input.destructive ||
    input.mutating ||
    input.auth !== undefined ||
    input.backendFamilies.some((family) =>
      ["openapi", "googleDiscovery", "graphql", "http"].includes(family),
    )
  ) {
    return "mutating_saas";
  }
  return "standard";
}

function isLocalMcpServer(frontmatter: Record<string, unknown>): boolean {
  const mcpServer = frontmatter.mcpServer;
  return (
    (isRecord(mcpServer) && typeof mcpServer.command === "string") ||
    capletPluralBackendValues(frontmatter.mcpServers).some(
      (server) => typeof server.command === "string",
    )
  );
}

function capletCanMutate(frontmatter: Record<string, unknown>): boolean {
  if (frontmatter.graphqlEndpoint !== undefined || frontmatter.graphqlEndpoints !== undefined) {
    return true;
  }
  if (
    frontmatter.openapiEndpoint !== undefined ||
    frontmatter.googleDiscoveryApi !== undefined ||
    frontmatter.openapiEndpoints !== undefined ||
    frontmatter.googleDiscoveryApis !== undefined
  ) {
    return true;
  }
  const httpApi = frontmatter.httpApi;
  if (isRecord(httpApi) && isRecord(httpApi.actions)) {
    return Object.values(httpApi.actions).some((action) => {
      if (!isRecord(action)) return false;
      return typeof action.method === "string" && action.method.toUpperCase() !== "GET";
    });
  }
  if (isRecord(frontmatter.cliTools) && isRecord(frontmatter.cliTools.actions)) {
    return Object.values(frontmatter.cliTools.actions).some((action) => {
      if (!isRecord(action) || !isRecord(action.annotations)) return true;
      return action.annotations.readOnlyHint !== true;
    });
  }
  for (const httpApi of capletPluralBackendValues(frontmatter.httpApis)) {
    if (isRecord(httpApi.actions)) {
      const mutates = Object.values(httpApi.actions).some((action) => {
        if (!isRecord(action)) return false;
        return typeof action.method === "string" && action.method.toUpperCase() !== "GET";
      });
      if (mutates) return true;
    }
  }
  if (isRecord(frontmatter.cliTools) && !isRecord(frontmatter.cliTools.actions)) {
    return capletPluralBackendValues(frontmatter.cliTools).some((cliTools) => {
      if (!isRecord(cliTools.actions)) return false;
      return Object.values(cliTools.actions).some((action) => {
        if (!isRecord(action) || !isRecord(action.annotations)) return true;
        return action.annotations.readOnlyHint !== true;
      });
    });
  }
  return false;
}

function capletCanDestroy(frontmatter: Record<string, unknown>): boolean {
  const httpApi = frontmatter.httpApi;
  if (isRecord(httpApi) && isRecord(httpApi.actions)) {
    return Object.values(httpApi.actions).some(
      (action) =>
        isRecord(action) &&
        typeof action.method === "string" &&
        action.method.toUpperCase() === "DELETE",
    );
  }
  if (isRecord(frontmatter.cliTools) && isRecord(frontmatter.cliTools.actions)) {
    return Object.values(frontmatter.cliTools.actions).some(
      (action) =>
        isRecord(action) &&
        isRecord(action.annotations) &&
        action.annotations.destructiveHint === true,
    );
  }
  for (const httpApi of capletPluralBackendValues(frontmatter.httpApis)) {
    if (isRecord(httpApi.actions)) {
      const destroys = Object.values(httpApi.actions).some(
        (action) =>
          isRecord(action) &&
          typeof action.method === "string" &&
          action.method.toUpperCase() === "DELETE",
      );
      if (destroys) return true;
    }
  }
  if (isRecord(frontmatter.cliTools) && !isRecord(frontmatter.cliTools.actions)) {
    return capletPluralBackendValues(frontmatter.cliTools).some((cliTools) => {
      if (!isRecord(cliTools.actions)) return false;
      return Object.values(cliTools.actions).some(
        (action) =>
          isRecord(action) &&
          isRecord(action.annotations) &&
          action.annotations.destructiveHint === true,
      );
    });
  }
  return false;
}

function riskRank(value: CapletsLockEntry["risk"]["safety"]): number {
  switch (value) {
    case "standard":
      return 0;
    case "mutating_saas":
      return 1;
    case "local_control":
      return 2;
    case "unknown":
      return 3;
  }
}

function isSubset(previous: string[], next: string[]): boolean {
  const previousValues = new Set(previous);
  return next.every((value) => previousValues.has(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function capletPluralBackendValues(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  return Object.values(value).filter(isRecord);
}

function capletPluralBackends(frontmatter: Record<string, unknown>): Record<string, unknown>[] {
  return [
    ...capletPluralBackendValues(frontmatter.mcpServers),
    ...capletPluralBackendValues(frontmatter.openapiEndpoints),
    ...capletPluralBackendValues(frontmatter.googleDiscoveryApis),
    ...capletPluralBackendValues(frontmatter.graphqlEndpoints),
    ...capletPluralBackendValues(frontmatter.httpApis),
    ...(isRecord(frontmatter.cliTools) && !isRecord(frontmatter.cliTools.actions)
      ? capletPluralBackendValues(frontmatter.cliTools)
      : []),
    ...capletPluralBackendValues(frontmatter.capletSets),
  ];
}

function hasProjectBinding(value: Record<string, unknown>): boolean {
  return isRecord(value.projectBinding) && value.projectBinding.required === true;
}

function runtimeFeaturesForBackend(value: Record<string, unknown>): string[] {
  const runtime = isRecord(value.runtime) ? value.runtime : undefined;
  return Array.isArray(runtime?.features)
    ? runtime.features.filter((feature): feature is string => typeof feature === "string")
    : [];
}

function lockSourceDisplay(source: CapletsLockSource): string {
  return source.type === "git" ? `${source.repository}#${source.path}` : `${source.path}`;
}

function inferLocalRepoRoot(sourcePath: string): string {
  const marker = `${sep}caplets${sep}`;
  const index = sourcePath.lastIndexOf(marker);
  return index === -1 ? dirname(sourcePath) : sourcePath.slice(0, index);
}

function hashInstalledArtifact(path: string): string {
  const hash = createHash("sha256");
  hashPath(path, "", hash);
  return `sha256:${hash.digest("hex")}`;
}

function hashDirectoryCapletInstallSource(path: string, sourceBoundary: string): string {
  const hash = createHash("sha256");
  hashDirectoryCapletInstallPath(path, "", hash, sourceBoundary);
  return `sha256:${hash.digest("hex")}`;
}

function hashPath(path: string, relativePath: string, hash: ReturnType<typeof createHash>): void {
  const stats = lstatSync(path);
  const mode = stats.mode & 0o111 ? "executable" : "plain";
  if (stats.isDirectory()) {
    hash.update(`dir\0${relativePath}\0`);
    for (const entry of readdirSync(path).sort()) {
      hashPath(join(path, entry), relativePath ? `${relativePath}/${entry}` : entry, hash);
    }
    return;
  }
  if (stats.isSymbolicLink()) {
    hash.update(`symlink\0${relativePath}\0${readlinkSync(path)}\0`);
    return;
  }
  hash.update(`file\0${relativePath}\0${mode}\0`);
  hash.update(readFileSync(path));
  hash.update("\0");
}

function hashDirectoryCapletInstallPath(
  path: string,
  relativePath: string,
  hash: ReturnType<typeof createHash>,
  sourceBoundary: string,
  seenDirectories = new Set<string>(),
): void {
  const lstat = lstatSync(path);
  const resolvedPath = lstat.isSymbolicLink()
    ? resolveDirectoryCapletSymlink(path, sourceBoundary)
    : path;
  const stats = statSync(resolvedPath);
  if (stats.isDirectory()) {
    const realDirectory = realpathSync(resolvedPath);
    if (seenDirectories.has(realDirectory)) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Directory Caplet symlink ${path} creates a copy cycle`,
      );
    }
    hash.update(`dir\0${relativePath}\0`);
    const childSeenDirectories = new Set(seenDirectories);
    childSeenDirectories.add(realDirectory);
    for (const entry of readdirSync(resolvedPath).sort()) {
      hashDirectoryCapletInstallPath(
        join(resolvedPath, entry),
        relativePath ? `${relativePath}/${entry}` : entry,
        hash,
        sourceBoundary,
        childSeenDirectories,
      );
    }
    return;
  }
  const mode = stats.mode & 0o111 ? "executable" : "plain";
  hash.update(`file\0${relativePath}\0${mode}\0`);
  hash.update(readFileSync(resolvedPath));
  hash.update("\0");
}

function gitRevision(repoRoot: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: externalGitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
  } catch {
    return undefined;
  }
}

function localGitInfo(repoRoot: string): Partial<Extract<CapletsLockSource, { type: "local" }>> {
  const gitRevisionValue = gitRevision(repoRoot);
  const dirty = gitDirty(repoRoot);
  try {
    const gitRepository = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: externalGitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    return {
      ...(gitRepository ? { gitRepository } : {}),
      ...(gitRevisionValue ? { gitRevision: gitRevisionValue } : {}),
      ...(dirty === undefined ? {} : { dirty }),
    };
  } catch {
    return {
      ...(gitRevisionValue ? { gitRevision: gitRevisionValue } : {}),
      ...(dirty === undefined ? {} : { dirty }),
    };
  }
}

function gitDirty(repoRoot: string): boolean | undefined {
  if (!gitRevision(repoRoot)) return undefined;
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: externalGitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    return status.trim().length > 0;
  } catch {
    return undefined;
  }
}

function externalGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

export function normalizeGitRepo(repo: string): string {
  const source = splitInstallSourceRef(repo);
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(source.repository)) {
    const normalized = source.repository.endsWith(".git")
      ? source.repository.slice(0, -4)
      : source.repository;
    return withInstallSourceRef(`https://github.com/${normalized}.git`, source.ref);
  }
  return repo;
}

function splitInstallSourceRef(repo: string): { repository: string; ref?: string | undefined } {
  const index = repo.lastIndexOf("#");
  if (index <= 0 || index === repo.length - 1) return { repository: repo };
  return { repository: repo.slice(0, index), ref: repo.slice(index + 1) };
}

function withInstallSourceRef(repository: string, ref: string | undefined): string {
  return ref ? `${repository}#${ref}` : repository;
}

function preflightInstallCaplets(
  caplets: Array<{ id: string; path: string }>,
  options: { destinationRoot: string; force: boolean; repoRoot: string; sourceId: string },
): InstallPlan[] {
  const plans = caplets.map((caplet) => installPlan(caplet, options));
  rejectUnsafeInstallParents(options.destinationRoot);
  rejectUnsafeInstallRoot(options.destinationRoot);
  for (const plan of plans) {
    rejectUnsafeInstallParents(plan.destination);
    rejectUnsafeInstallDestination(plan, options.force);
    rejectCrossKindDestinationCollision(plan, options.destinationRoot);
  }

  const writableRoot = nearestExistingParent(options.destinationRoot);
  ensureWritable(writableRoot, `install destination parent ${writableRoot}`);
  for (const plan of plans) {
    const destinationParent = lstatIfExists(plan.destination)
      ? dirname(plan.destination)
      : nearestExistingParent(dirname(plan.destination));
    ensureWritable(destinationParent, `install destination parent ${destinationParent}`);
  }

  makeInstallDirectory(options.destinationRoot);
  return plans;
}

function rejectUnsafeInstallRoot(destinationRoot: string): void {
  const stats = lstatIfExists(destinationRoot);
  if (!stats) {
    return;
  }
  if (stats.isSymbolicLink()) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Install destination ${destinationRoot} already exists and is a symlink`,
    );
  }
  if (!stats.isDirectory()) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Install destination ${destinationRoot} already exists and is not a directory`,
    );
  }
}

function rejectUnsafeInstallParents(path: string): void {
  const parent = dirname(resolve(path));
  const root = parse(parent).root;
  const segments = parent.slice(root.length).split(/[\\/]/).filter(Boolean);
  let current = root;

  for (const segment of segments) {
    current = join(current, segment);
    const stats = lstatIfExists(current);
    if (!stats) {
      return;
    }
    if (stats.isSymbolicLink()) {
      if (isDarwinSystemAliasSymlink(current)) continue;
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Install destination parent ${current} is a symlink; remove it before installing`,
      );
    }
    if (!stats.isDirectory()) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Install destination parent ${current} is not a directory; choose another destination`,
      );
    }
  }
}

function isDarwinSystemAliasSymlink(path: string): boolean {
  if (process.platform !== "darwin") return false;
  if (path !== "/var" && path !== "/tmp") return false;
  try {
    return realpathSync(path) === `/private${path}`;
  } catch {
    return false;
  }
}

function rejectUnsafeInstallDestination(plan: InstallPlan, force: boolean): void {
  const stats = lstatIfExists(plan.destination);
  if (!stats) {
    return;
  }

  rejectSymlinkDestination(plan.id, plan.destination, stats);
  if (plan.kind === "file" && !stats.isFile()) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Cannot install file Caplet ${plan.id}; destination already exists and is not a file at ${plan.destination}`,
    );
  }
  if (plan.kind === "directory" && !stats.isDirectory()) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Cannot install directory Caplet ${plan.id}; destination already exists and is not a directory at ${plan.destination}`,
    );
  }
  if (!force) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Caplet ${plan.id} already exists at ${plan.destination}; pass --force to overwrite it`,
    );
  }
}

function rejectDuplicateSourceIds(caplets: Array<{ id: string; path: string }>): void {
  const byId = new Map<string, string>();
  for (const caplet of caplets) {
    const existing = byId.get(caplet.id);
    if (existing) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Source repo contains multiple Caplets with ID ${caplet.id}: ${existing} and ${caplet.path}`,
      );
    }
    byId.set(caplet.id, caplet.path);
  }
}

function rejectCrossKindDestinationCollision(plan: InstallPlan, destinationRoot: string): void {
  if (plan.kind === "file") {
    const directoryPath = join(destinationRoot, plan.id);
    const directoryCapletPath = join(directoryPath, "CAPLET.md");
    const directoryStats = lstatIfExists(directoryPath);
    const directoryCapletStats = lstatIfExists(directoryCapletPath);
    rejectSymlinkDestination(plan.id, directoryPath, directoryStats);
    rejectSymlinkDestination(plan.id, directoryCapletPath, directoryCapletStats);
    if (directoryStats || directoryCapletStats) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Cannot install file Caplet ${plan.id}; directory Caplet destination already exists at ${directoryPath}`,
      );
    }
    return;
  }

  const filePath = join(destinationRoot, `${plan.id}.md`);
  const fileStats = lstatIfExists(filePath);
  rejectSymlinkDestination(plan.id, filePath, fileStats);
  if (fileStats) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Cannot install directory Caplet ${plan.id}; file Caplet destination already exists at ${filePath}`,
    );
  }
}

function installPlan(
  caplet: { id: string; path: string },
  options: { destinationRoot: string; repoRoot: string; sourceId: string },
): InstallPlan {
  const isDirectory = basename(caplet.path) === "CAPLET.md";
  const sourcePath = isDirectory ? dirname(caplet.path) : caplet.path;
  const sourceBoundary = dirname(sourcePath);
  const sourcePathRelative = relative(options.repoRoot, sourcePath);
  const destination = isDirectory
    ? join(options.destinationRoot, caplet.id)
    : join(options.destinationRoot, `${caplet.id}.md`);

  return {
    id: caplet.id,
    source: `${options.sourceId}#${sourcePathRelative}`,
    sourcePath,
    sourceBoundary,
    destination,
    kind: isDirectory ? "directory" : "file",
  };
}

function installOneCaplet(plan: InstallPlan, options: { force: boolean }): InstallableCaplet {
  const stats = lstatIfExists(plan.destination);
  if (stats) {
    rejectSymlinkDestination(plan.id, plan.destination, stats);
    if (!options.force || (plan.kind === "file" && !stats.isFile())) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Caplet ${plan.id} already exists at ${plan.destination}; pass --force to overwrite it`,
      );
    }
    if (plan.kind === "directory" && !stats.isDirectory()) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Caplet ${plan.id} already exists at ${plan.destination}; pass --force to overwrite it`,
      );
    }
  }

  replaceInstallPath(plan, Boolean(stats));
  return {
    id: plan.id,
    source: plan.source,
    destination: plan.destination,
    kind: plan.kind,
  };
}

function replaceInstallPath(plan: InstallPlan, hasExistingDestination: boolean): void {
  const stagedPath = uniqueSiblingPath(plan.destination, ".tmp");
  const backupPath = uniqueSiblingPath(plan.destination, ".old");
  try {
    copyInstallPath(plan, stagedPath);
    if (!hasExistingDestination) {
      renameSync(stagedPath, plan.destination);
      return;
    }

    renameSync(plan.destination, backupPath);
    try {
      renameSync(stagedPath, plan.destination);
    } catch (error) {
      try {
        renameSync(backupPath, plan.destination);
      } catch (restoreError) {
        throw new CapletsError(
          "CONFIG_INVALID",
          `Could not restore existing Caplet destination ${plan.destination}`,
          toSafeError(restoreError),
        );
      }
      throw error;
    }
    removeInstallPath(backupPath, `previous Caplet destination ${backupPath}`, true);
  } catch (error) {
    removeInstallPath(stagedPath, `staged Caplet destination ${stagedPath}`, true);
    if (error instanceof CapletsError) {
      throw error;
    }
    throw new CapletsError(
      "CONFIG_INVALID",
      `Could not install Caplet ${plan.id} to ${plan.destination}`,
      toSafeError(error),
    );
  }
}

function uniqueSiblingPath(path: string, suffix: string): string {
  const parent = dirname(path);
  const name = basename(path);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = join(parent, `.${name}${suffix}-${process.pid}-${Date.now()}-${attempt}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new CapletsError("CONFIG_EXISTS", `Could not allocate staging path for ${path}`);
}

function rejectSymlinkDestination(id: string, path: string, stats: Stats | undefined): void {
  if (stats?.isSymbolicLink()) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Cannot install Caplet ${id}; destination is a symlink at ${path}`,
    );
  }
}

function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isFsError(error, "ENOENT")) {
      return undefined;
    }
    throw new CapletsError(
      "CONFIG_INVALID",
      `Could not inspect install destination ${path}`,
      toSafeError(error),
    );
  }
}

function ensureWritable(path: string, label: string): void {
  try {
    accessSync(path, constants.W_OK);
  } catch (error) {
    throw new CapletsError("CONFIG_INVALID", `Cannot write to ${label}`, toSafeError(error));
  }
}

function makeInstallDirectory(path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (isFsError(error, "EEXIST")) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Install destination ${path} already exists and is not a directory`,
        toSafeError(error),
      );
    }
    throw new CapletsError(
      "CONFIG_INVALID",
      `Could not create install destination ${path}`,
      toSafeError(error),
    );
  }
}

function removeInstallPath(path: string, label: string, force: boolean): void {
  try {
    rmSync(path, { recursive: true, force });
  } catch (error) {
    throw new CapletsError("CONFIG_INVALID", `Could not remove ${label}`, toSafeError(error));
  }
}

function copyInstallPath(plan: InstallPlan, destination: string): void {
  try {
    if (plan.kind === "directory") {
      copyDirectoryCaplet(plan.sourcePath, destination, realpathSync(plan.sourceBoundary));
      return;
    }

    cpSync(plan.sourcePath, destination, {
      recursive: false,
      force: false,
      errorOnExist: true,
    });
  } catch (error) {
    if (error instanceof CapletsError) {
      throw error;
    }
    if (isFsError(error, "EEXIST") || isFsError(error, "EISDIR")) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        `Caplet ${plan.id} already exists at ${plan.destination}; pass --force to overwrite it`,
        toSafeError(error),
      );
    }
    throw new CapletsError(
      "CONFIG_INVALID",
      `Could not install Caplet ${plan.id} to ${plan.destination}`,
      toSafeError(error),
    );
  }
}

function copyDirectoryCaplet(
  source: string,
  destination: string,
  sourceBoundary: string,
  seenDirectories = new Set<string>(),
): void {
  const lstat = lstatSync(source);
  const resolvedSource = lstat.isSymbolicLink()
    ? resolveDirectoryCapletSymlink(source, sourceBoundary)
    : source;
  const stats = statSync(resolvedSource);
  if (stats.isDirectory()) {
    const realDirectory = realpathSync(resolvedSource);
    if (seenDirectories.has(realDirectory)) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Directory Caplet symlink ${source} creates a copy cycle`,
      );
    }
    const childSeenDirectories = new Set(seenDirectories);
    childSeenDirectories.add(realDirectory);
    mkdirSync(destination);
    for (const entry of readdirSync(resolvedSource)) {
      copyDirectoryCaplet(
        join(resolvedSource, entry),
        join(destination, entry),
        sourceBoundary,
        childSeenDirectories,
      );
    }
    return;
  }

  copyFileSync(resolvedSource, destination);
}

function resolveDirectoryCapletSymlink(source: string, sourceBoundary: string): string {
  const target = readlinkSync(source);
  const targetPath = isAbsolute(target) ? target : resolve(dirname(source), target);
  const resolvedTarget = realpathSync(targetPath);
  if (resolvedTarget !== sourceBoundary && !resolvedTarget.startsWith(`${sourceBoundary}${sep}`)) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Directory Caplet symlink ${source} resolves outside source Caplets boundary`,
    );
  }
  return resolvedTarget;
}

function isFsError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function nearestExistingParent(path: string): string {
  if (lstatIfExists(path)) {
    return path;
  }
  const parent = dirname(path);
  if (parent === path) {
    return parent;
  }
  return nearestExistingParent(parent);
}
