import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  capletRiskIncreases,
  indexInstalledCapletsFromLockfile,
  installCaplets,
  type InstallableCaplet,
} from "../install";
import {
  readCapletsLockfile,
  type CapletsLockEntry,
  type CapletsLockRiskSummary,
} from "../lockfile";
import { CapletsError } from "../errors";
import type { HostStorage } from "./database";
import type { CapletBundleInputFile, CapletRecordView } from "./caplet-records";
import type { CapletInstallationView, OperatorPrincipal } from "./installations";

export type SqlCatalogInstallInput = {
  storage: HostStorage;
  operator: OperatorPrincipal;
  source: string;
  capletIds?: string[] | undefined;
  force?: boolean | undefined;
  disableCatalogIndexing?: boolean | undefined;
};

export type SqlCatalogUpdateInput = {
  storage: HostStorage;
  operator: OperatorPrincipal;
  capletIds?: string[] | undefined;
  force?: boolean | undefined;
  allowRiskIncrease?: boolean | undefined;
  disableCatalogIndexing?: boolean | undefined;
};

export async function installSqlCatalogCaplets(
  input: SqlCatalogInstallInput,
): Promise<{ installed: InstallableCaplet[] }> {
  return await withStagedCatalog(
    input.source,
    input.capletIds,
    input.disableCatalogIndexing,
    async (stage) => {
      const existing = await Promise.all(
        stage.entries.map(async (entry) => await input.storage.caplets.get(entry.id)),
      );
      const existingCount = existing.filter((record) => record !== undefined).length;
      if (existingCount > 0 && !input.force) {
        const ids = stage.entries
          .filter((_entry, index) => existing[index] !== undefined)
          .map((entry) => entry.id);
        throw new CapletsError(
          "CONFIG_EXISTS",
          `Caplet Record ${ids.join(", ")} already exists; use caplets update --global for tracked installations.`,
        );
      }
      if (existingCount > 0 && existingCount !== stage.entries.length) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "A forced SQL catalog install cannot mix new and existing Caplet Records.",
        );
      }

      let records: CapletRecordView[];
      let statuses: InstallableCaplet["status"][];
      if (existingCount === 0) {
        records = await input.storage.caplets.importBundles(
          stage.entries.map((entry) => {
            const provenance = catalogProvenance(entry, input.source);
            return {
              id: entry.id,
              files: readCapletBundleFiles(stage.installedById.get(entry.id)!.destination).files,
              operator: input.operator,
              sourceRevision: provenance.sourceRevision,
              sourceContentHash: entry.installedHash,
              installation: {
                sourceKind: provenance.sourceKind,
                sourceIdentity: provenance.sourceIdentity,
                ...(provenance.channel ? { channel: provenance.channel } : {}),
                risk: entry.risk,
              },
            };
          }),
        );
        statuses = records.map(() => "installed");
      } else {
        const updated = await applyStagedUpdates({
          storage: input.storage,
          operator: input.operator,
          entries: stage.entries,
          installedById: stage.installedById,
          existing: existing.map((record) => {
            if (!record)
              throw new CapletsError("INTERNAL_ERROR", "Existing Caplet Record disappeared.");
            return record;
          }),
          active: await activeInstallations(
            input.storage,
            stage.entries.map((entry) => entry.id),
          ),
          allowRiskIncrease: true,
        });
        records = updated.records;
        statuses = updated.statuses;
      }
      const catalogIndexing = await catalogIndexingForStage(
        stage.installed,
        stage.disableCatalogIndexing,
      );
      return {
        installed: stage.entries.map((entry, index) =>
          installedView(
            entry,
            records[index]!,
            statuses[index],
            catalogIndexing.get(entry.id),
            catalogProvenance(entry, input.source).sourceIdentity,
          ),
        ),
      };
    },
  );
}

export async function updateSqlCatalogCaplets(
  input: SqlCatalogUpdateInput,
): Promise<{ installed: InstallableCaplet[] }> {
  const records = await input.storage.caplets.list();
  const explicitlySelected = Boolean(input.capletIds && input.capletIds.length > 0);
  const selectedIds = [
    ...new Set(explicitlySelected ? input.capletIds! : records.map((record) => record.id)),
  ];
  const active = await activeInstallations(input.storage, selectedIds, explicitlySelected);
  if (active.length === 0) {
    throw new CapletsError("CONFIG_NOT_FOUND", "No active SQL catalog installations were found.");
  }
  const activeIds = new Set(active.map((installation) => installation.capletId));
  const updateIds = selectedIds.filter((id) => activeIds.has(id));
  const sourceGroups = new Map<string, { source: string; ids: string[] }>();
  for (const installation of active) {
    const key = `${installation.sourceKind}\0${installation.sourceIdentity}`;
    const group = sourceGroups.get(key);
    if (group) group.ids.push(installation.capletId);
    else
      sourceGroups.set(key, { source: installation.sourceIdentity, ids: [installation.capletId] });
  }

  const stagingRoot = mkdtempSync(join(tmpdir(), "caplets-sql-catalog-update-"));
  try {
    const destinationRoot = join(stagingRoot, "caplets");
    const lockfilePath = join(stagingRoot, "caplets-lock.json");
    const stagedInstalled: InstallableCaplet[] = [];
    for (const group of sourceGroups.values()) {
      try {
        stagedInstalled.push(
          ...installCaplets(group.source, {
            capletIds: group.ids,
            destinationRoot,
            lockfilePath,
          }).installed,
        );
      } catch (error) {
        if (error instanceof CapletsError && error.code === "CONFIG_NOT_FOUND") {
          await markSourceUnavailable(input, active, group.ids);
        }
        throw error;
      }
    }
    const lockfile = readCapletsLockfile(lockfilePath);
    const entries = updateIds.map((id) => {
      const entry = lockfile.entries.find((candidate) => candidate.id === id);
      if (!entry)
        throw new CapletsError("CONFIG_NOT_FOUND", `Updated source did not contain ${id}.`);
      return entry;
    });
    const installedById = new Map(stagedInstalled.map((entry) => [entry.id, entry]));
    const recordsById = new Map(records.map((record) => [record.id, record]));
    const existing = entries.map((entry) => {
      const record = recordsById.get(entry.id);
      if (!record)
        throw new CapletsError("CONFIG_NOT_FOUND", `Caplet Record ${entry.id} was not found.`);
      return record;
    });
    const updated = await applyStagedUpdates({
      storage: input.storage,
      operator: input.operator,
      entries,
      installedById,
      existing,
      active,
      allowRiskIncrease: input.allowRiskIncrease ?? input.force ?? false,
    });
    const catalogIndexing = await catalogIndexingForStage(
      stagedInstalled,
      input.disableCatalogIndexing,
    );
    return {
      installed: entries.map((entry, index) =>
        installedView(
          entry,
          updated.records[index]!,
          updated.statuses[index],
          catalogIndexing.get(entry.id),
          active.find((installation) => installation.capletId === entry.id)!.sourceIdentity,
        ),
      ),
    };
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

type StagedCatalog = {
  entries: CapletsLockEntry[];
  installed: InstallableCaplet[];
  installedById: Map<string, InstallableCaplet>;
  disableCatalogIndexing: boolean | undefined;
};

async function withStagedCatalog<T>(
  source: string,
  capletIds: string[] | undefined,
  disableCatalogIndexing: boolean | undefined,
  run: (stage: StagedCatalog) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "caplets-sql-catalog-install-"));
  try {
    const lockfilePath = join(root, "caplets-lock.json");
    const staged = installCaplets(source, {
      ...(capletIds ? { capletIds } : {}),
      destinationRoot: join(root, "caplets"),
      lockfilePath,
    }).installed;
    const lockfile = readCapletsLockfile(lockfilePath);
    return await run({
      entries: lockfile.entries,
      installed: staged,
      installedById: new Map(staged.map((entry) => [entry.id, entry])),
      disableCatalogIndexing,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function catalogIndexingForStage(
  installed: InstallableCaplet[],
  disabled: boolean | undefined,
): Promise<Map<string, InstallableCaplet["catalogIndexing"]>> {
  try {
    return await indexInstalledCapletsFromLockfile(installed, {
      disableCatalogIndexing: disabled ?? false,
    });
  } catch {
    return new Map(
      installed.map((entry) => [
        entry.id,
        { status: "unavailable" as const, reason: "indexer_unavailable" as const },
      ]),
    );
  }
}

async function markSourceUnavailable(
  input: SqlCatalogUpdateInput,
  active: CapletInstallationView[],
  capletIds: string[],
): Promise<void> {
  const selected = new Set(capletIds);
  await Promise.all(
    active
      .filter((installation) => selected.has(installation.capletId))
      .map(async (installation) => {
        await input.storage.installations.appendObservation({
          capletId: installation.capletId,
          expectedGeneration: installation.generation,
          status: "source-unavailable",
          operator: input.operator,
        });
      }),
  );
}

async function activeInstallations(
  storage: HostStorage,
  capletIds: string[],
  requireAll = true,
): Promise<CapletInstallationView[]> {
  const active = await Promise.all(
    capletIds.map(async (id) => ({ id, installation: await storage.installations.getActive(id) })),
  );
  const missing = active.filter(({ installation }) => !installation).map(({ id }) => id);
  if (requireAll && missing.length > 0) {
    throw new CapletsError(
      "CONFIG_NOT_FOUND",
      `Active SQL installation provenance was not found for ${missing.join(", ")}.`,
    );
  }
  return active
    .map(({ installation }) => installation)
    .filter((installation): installation is CapletInstallationView => installation !== undefined);
}

async function applyStagedUpdates(input: {
  storage: HostStorage;
  operator: OperatorPrincipal;
  entries: CapletsLockEntry[];
  installedById: Map<string, InstallableCaplet>;
  existing: CapletRecordView[];
  active: CapletInstallationView[];
  allowRiskIncrease: boolean;
}): Promise<{ records: CapletRecordView[]; statuses: InstallableCaplet["status"][] }> {
  const activeById = new Map(
    input.active.map((installation) => [installation.capletId, installation]),
  );
  const prepared = await Promise.all(
    input.entries.map(async (entry, index) => {
      const record = input.existing[index]!;
      const installation = activeById.get(entry.id);
      if (!installation) {
        throw new CapletsError(
          "CONFIG_NOT_FOUND",
          `Active SQL installation for ${entry.id} was not found.`,
        );
      }
      const staged = input.installedById.get(entry.id);
      if (!staged)
        throw new CapletsError("INTERNAL_ERROR", `Staged Caplet ${entry.id} was not found.`);
      const provenance = catalogProvenance(entry, installation.sourceIdentity);
      if (
        provenance.sourceKind !== installation.sourceKind ||
        provenance.sourceIdentity !== installation.sourceIdentity
      ) {
        throw new CapletsError(
          "REQUEST_INVALID",
          `Caplet ${entry.id} source identity changed; detach and replace its installation explicitly.`,
        );
      }
      const latestObservation = await input.storage.installations.getLatestObservation(entry.id);
      const currentRisk = persistedRisk(latestObservation?.risk, entry.id);
      if (!input.allowRiskIncrease && capletRiskIncreases(currentRisk, entry.risk)) {
        throw new CapletsError(
          "REQUEST_INVALID",
          `Caplet ${entry.id} update changes its risk profile; pass --force to update it.`,
        );
      }
      return {
        entry,
        record,
        installation,
        files: readCapletBundleFiles(staged.destination).files,
        sourceRevision: provenance.sourceRevision,
      };
    }),
  );

  const records: CapletRecordView[] = [];
  const statuses: InstallableCaplet["status"][] = [];
  for (const candidate of prepared) {
    const unchanged =
      candidate.record.currentRevision.sourceContentHash === candidate.entry.installedHash;
    records.push(
      await input.storage.caplets.updateFromSource({
        id: candidate.entry.id,
        files: candidate.files,
        expectedGeneration: candidate.record.headGeneration,
        expectedInstallationGeneration: candidate.installation.generation,
        sourceRevision: candidate.sourceRevision,
        sourceContentHash: candidate.entry.installedHash,
        observationStatus: "current",
        risk: candidate.entry.risk,
        operator: input.operator,
      }),
    );
    statuses.push(unchanged ? "noop" : "updated");
  }
  return { records, statuses };
}

function catalogProvenance(
  entry: CapletsLockEntry,
  localSource: string,
): {
  sourceKind: "git" | "local";
  sourceIdentity: string;
  channel?: string;
  sourceRevision: string;
} {
  if (entry.source.type === "git") {
    return {
      sourceKind: "git",
      sourceIdentity: entry.source.repository,
      ...(entry.source.trackedRef ? { channel: entry.source.trackedRef } : {}),
      sourceRevision: entry.source.resolvedRevision ?? entry.installedHash,
    };
  }
  return {
    sourceKind: "local",
    sourceIdentity: resolve(localSource),
    sourceRevision: entry.source.gitRevision ?? entry.installedHash,
  };
}

function installedView(
  entry: CapletsLockEntry,
  record: CapletRecordView,
  status: InstallableCaplet["status"],
  catalogIndexing: InstallableCaplet["catalogIndexing"],
  sourceIdentity: string,
): InstallableCaplet {
  const source = sourceIdentity;
  return {
    id: entry.id,
    source,
    destination: `sql://caplet-records/${encodeURIComponent(record.id)}`,
    kind: entry.kind,
    hash: entry.installedHash,
    status,
    ...(catalogIndexing ? { catalogIndexing } : {}),
  };
}

function persistedRisk(value: unknown, id: string): CapletsLockRiskSummary {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("backendFamilies" in value) ||
    !Array.isArray(value.backendFamilies) ||
    !value.backendFamilies.every((family) => typeof family === "string") ||
    !("safety" in value) ||
    (value.safety !== "standard" &&
      value.safety !== "mutating_saas" &&
      value.safety !== "local_control" &&
      value.safety !== "unknown") ||
    !("projectBindingRequired" in value) ||
    typeof value.projectBindingRequired !== "boolean" ||
    !("mutating" in value) ||
    typeof value.mutating !== "boolean" ||
    !("destructive" in value) ||
    typeof value.destructive !== "boolean" ||
    ("authScopes" in value &&
      value.authScopes !== undefined &&
      (!Array.isArray(value.authScopes) ||
        !value.authScopes.every((scope) => typeof scope === "string"))) ||
    ("runtimeFeatures" in value &&
      value.runtimeFeatures !== undefined &&
      (!Array.isArray(value.runtimeFeatures) ||
        !value.runtimeFeatures.every((feature) => typeof feature === "string"))) ||
    ("bodyHash" in value && value.bodyHash !== undefined && typeof value.bodyHash !== "string") ||
    ("referenceHash" in value &&
      value.referenceHash !== undefined &&
      typeof value.referenceHash !== "string")
  ) {
    throw new CapletsError("CONFIG_INVALID", `Persisted risk provenance for ${id} is invalid.`);
  }
  return value as CapletsLockRiskSummary;
}

export type CapletBundleFileEntry = {
  path: string;
  sourcePath: string;
  size: number;
  executable: boolean;
};

export function inspectCapletBundleFiles(bundlePath: string): {
  id: string;
  files: CapletBundleFileEntry[];
} {
  const inputPath = resolve(bundlePath);
  if (!existsSync(inputPath)) {
    throw new CapletsError("CONFIG_NOT_FOUND", `Caplet bundle ${bundlePath} was not found.`);
  }
  const inputStats = lstatSync(inputPath);
  if (inputStats.isFile()) {
    const filename = basename(inputPath);
    if (filename !== "CAPLET.md" && extname(filename) !== ".md") {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Caplet bundle file ${bundlePath} must be Markdown.`,
      );
    }
    return {
      id: filename === "CAPLET.md" ? basename(dirname(inputPath)) : basename(filename, ".md"),
      files: [
        {
          path: "CAPLET.md",
          sourcePath: inputPath,
          size: inputStats.size,
          executable: (inputStats.mode & 0o111) !== 0,
        },
      ],
    };
  }
  if (!inputStats.isDirectory()) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Caplet bundle ${bundlePath} must be a directory or regular file.`,
    );
  }
  const root = realpathSync(inputPath);
  const files: CapletBundleFileEntry[] = [];
  collectBundleFiles(root, root, "", files, new Set<string>());
  if (!files.some((file) => file.path === "CAPLET.md")) {
    throw new CapletsError("CONFIG_INVALID", `Caplet bundle ${bundlePath} is missing CAPLET.md.`);
  }
  return { id: basename(root), files };
}

export function readCapletBundleFiles(bundlePath: string): {
  id: string;
  files: CapletBundleInputFile[];
} {
  const bundle = inspectCapletBundleFiles(bundlePath);
  return {
    id: bundle.id,
    files: bundle.files.map((file) => ({
      path: file.path,
      content: readFileSync(file.sourcePath),
      executable: file.executable,
    })),
  };
}

function collectBundleFiles(
  root: string,
  sourcePath: string,
  bundlePath: string,
  files: CapletBundleFileEntry[],
  ancestors: Set<string>,
): void {
  const sourceStats = lstatSync(sourcePath);
  const resolvedPath = sourceStats.isSymbolicLink() ? realpathSync(sourcePath) : sourcePath;
  const resolvedRelative = relative(root, resolvedPath);
  if (
    resolvedRelative === ".." ||
    resolvedRelative.startsWith(`..${sep}`) ||
    isAbsolute(resolvedRelative)
  ) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Caplet bundle symbolic link ${bundlePath || "."} escapes the bundle root.`,
    );
  }
  const stats = sourceStats.isSymbolicLink() ? statSync(resolvedPath) : sourceStats;
  if (stats.isDirectory()) {
    const canonicalPath = realpathSync(resolvedPath);
    if (ancestors.has(canonicalPath)) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Caplet bundle symbolic link cycle at ${bundlePath || "."}.`,
      );
    }
    const childAncestors = new Set(ancestors);
    childAncestors.add(canonicalPath);
    for (const entry of readdirSync(resolvedPath).sort((left, right) =>
      left.localeCompare(right),
    )) {
      collectBundleFiles(
        root,
        join(resolvedPath, entry),
        bundlePath ? `${bundlePath}/${entry}` : entry,
        files,
        childAncestors,
      );
    }
    return;
  }
  if (!stats.isFile()) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Caplet bundle entry ${bundlePath || "."} is not a regular file.`,
    );
  }
  files.push({
    path: bundlePath,
    sourcePath: resolvedPath,
    size: stats.size,
    executable: (stats.mode & 0o111) !== 0,
  });
}
