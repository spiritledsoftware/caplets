import { createHash } from "node:crypto";
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { defaultCapletsLockfilePath } from "../config";
import { SERVER_ID_PATTERN } from "../config/validation";
import {
  indexInstalledCapletsFromLockfile,
  installCaplets,
  restoreCapletsFromLockfile,
  updateCapletsFromLockfile,
  type InstallableCaplet,
} from "../cli/install";
import { readCapletsLockfile, writeCapletsLockfile, type CapletsLockEntry } from "../cli/lockfile";
import {
  encodePortableCaplet,
  portableCapletFromCapletDocument,
  type PortableCapletBundleFile,
} from "../control-plane/caplets/portable-codec";
import type { PortableCaplet } from "../control-plane/caplets/model";
import type { ControlPlaneProvenance } from "../control-plane/types";
import { CapletsError } from "../errors";
import {
  currentHostCatalogDetail,
  currentHostCatalogIndex,
  currentHostCatalogInstallSource,
  currentHostCatalogSearch,
  currentHostInstalledCaplets,
  type CurrentHostInstalledCatalogCaplet,
  type CurrentHostSetupAction,
} from "./catalog";
import {
  finalAuthorizeCurrentHostMutation,
  type CurrentHostControlContext,
  type CurrentHostOperation,
  type CurrentHostOperationOutcome,
  type CurrentHostOperatorPrincipal,
  type CurrentHostOperationsDependencies,
} from "./operations";

type CapletsListOperation = Extract<CurrentHostOperation, { kind: "caplets_list" }>;
type CatalogSearchOperation = Extract<CurrentHostOperation, { kind: "catalog_search" }>;
type CatalogIndexOperation = Extract<CurrentHostOperation, { kind: "catalog_index" }>;
type CatalogDetailOperation = Extract<CurrentHostOperation, { kind: "catalog_detail" }>;
type CatalogUpdatesOperation = Extract<CurrentHostOperation, { kind: "catalog_updates" }>;
type CatalogInstallOperation = Extract<CurrentHostOperation, { kind: "catalog_install" }>;
type CatalogUpdateOperation = Extract<CurrentHostOperation, { kind: "catalog_update" }>;
type CapletsListOutcome = Extract<CurrentHostOperationOutcome, { kind: "caplets_list" }>;
type CatalogSearchOutcome = Extract<CurrentHostOperationOutcome, { kind: "catalog_search" }>;
type CatalogIndexOutcome = Extract<CurrentHostOperationOutcome, { kind: "catalog_index" }>;
type CatalogDetailOutcome = Extract<CurrentHostOperationOutcome, { kind: "catalog_detail" }>;
type CatalogUpdatesOutcome = Extract<CurrentHostOperationOutcome, { kind: "catalog_updates" }>;
type CatalogInstallOutcome = Extract<CurrentHostOperationOutcome, { kind: "catalog_install" }>;
type CatalogUpdateOutcome = Extract<CurrentHostOperationOutcome, { kind: "catalog_update" }>;

export type GlobalCatalogArtifact = Readonly<{
  installed: CurrentHostInstalledCatalogCaplet;
  lockEntry: CapletsLockEntry;
  portable: PortableCaplet;
  provenance: ControlPlaneProvenance;
  setupActions: readonly CurrentHostSetupAction[];
}>;

export type PersistGlobalCatalogChangeInput = Readonly<{
  action: "install" | "update";
  principal: CurrentHostOperatorPrincipal;
  source: Readonly<{
    repository?: string | undefined;
    catalogSource?: string | undefined;
    entryKey?: string | undefined;
  }>;
  capletIds?: readonly string[] | undefined;
  force: boolean;
  allowRiskIncrease?: boolean | undefined;
  artifacts: readonly GlobalCatalogArtifact[];
}>;

export type PersistGlobalCatalogChange = (
  input: PersistGlobalCatalogChangeInput,
) => Promise<Readonly<{ installed: CurrentHostInstalledCatalogCaplet[] }>>;

export type LoadGlobalCatalogProvenance = (
  capletIds: readonly string[] | undefined,
) => Promise<readonly CapletsLockEntry[]>;

export type GlobalCatalogPersistenceDependencies = Readonly<{
  loadGlobalCatalogProvenance: LoadGlobalCatalogProvenance;
  persistGlobalCatalogChange: PersistGlobalCatalogChange;
}>;

/** Current Host catalog administration implementation, kept behind the facade. */
export function createCurrentHostCatalogOperations(
  dependencies: CurrentHostOperationsDependencies,
) {
  return {
    capletsList: (_operation: CapletsListOperation): CapletsListOutcome => ({
      kind: "caplets_list",
      caplets: currentHostInstalledCaplets(dependencies.engine.enabledServers(), {
        globalLockfilePath: dependencies.control?.globalLockfilePath,
      }),
    }),
    search: async (operation: CatalogSearchOperation): Promise<CatalogSearchOutcome> => ({
      kind: "catalog_search",
      ...(await currentHostCatalogSearch(operation)),
    }),
    index: async (operation: CatalogIndexOperation): Promise<CatalogIndexOutcome> => ({
      kind: "catalog_index",
      ...(await currentHostCatalogIndex(operation)),
    }),
    detail: async (operation: CatalogDetailOperation): Promise<CatalogDetailOutcome> => ({
      kind: "catalog_detail",
      ...(await currentHostCatalogDetail(operation)),
    }),
    updates: async (_operation: CatalogUpdatesOperation): Promise<CatalogUpdatesOutcome> => {
      const persistence = requireGlobalCatalogPersistence(dependencies);
      const entries = await persistence.loadGlobalCatalogProvenance(undefined);
      return {
        kind: "catalog_updates",
        updates: entries.map((entry) => ({
          id: entry.id,
          status: "locked" as const,
          risk: entry.risk,
        })),
      };
    },
    install: (
      principal: CurrentHostOperatorPrincipal,
      operation: CatalogInstallOperation,
    ): Promise<CatalogInstallOutcome> => catalogInstallOutcome(dependencies, principal, operation),
    update: (
      principal: CurrentHostOperatorPrincipal,
      operation: CatalogUpdateOperation,
    ): Promise<CatalogUpdateOutcome> => catalogUpdateOutcome(dependencies, principal, operation),
  };
}

async function catalogInstallOutcome(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  operation: CatalogInstallOperation,
): Promise<CatalogInstallOutcome> {
  let setupActions: CurrentHostSetupAction[] = [];
  let capletIds = optionalCapletIds(operation.capletIds);
  if (operation.source !== undefined && operation.repo !== undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Catalog install accepts either a source or repository, not both.",
    );
  }
  let repo = operation.repo;
  try {
    const persistence = requireGlobalCatalogPersistence(dependencies);
    if (operation.source !== undefined) {
      if (!operation.entryKey) {
        throw new CapletsError("REQUEST_INVALID", "Catalog install requires a stable entryKey.");
      }
      const detail = await currentHostCatalogDetail({
        source: operation.source,
        entryKey: operation.entryKey,
      });
      const officialInstall =
        operation.source.trim() !== "official" ||
        (detail.entry.installCommand.copyable &&
          detail.entry.installCommand.revisionBound === true &&
          typeof detail.entry.resolvedRevision === "string" &&
          detail.entry.resolvedRevision.length > 0);
      if (
        typeof detail.entry.contentMarkdown !== "string" ||
        detail.entry.contentMarkdown.length === 0 ||
        !officialInstall
      ) {
        throw new CapletsError("REQUEST_INVALID", "Catalog entry is not currently installable.");
      }
      setupActions = detail.setupActions;
      capletIds = [detail.entry.id];
      repo = currentHostCatalogInstallSource(operation.source, detail.entry.resolvedRevision);
    }
    const staged = await stageCatalogInstall(
      dependencies.control,
      persistence,
      repo,
      capletIds,
      operation.force ?? false,
      setupActions,
      principal.clientId,
    );
    try {
      const finalAuthorization = finalAuthorizeCurrentHostMutation(principal);
      if (finalAuthorization instanceof Promise) await finalAuthorization;
      const persisted = await persistence.persistGlobalCatalogChange({
        action: "install",
        principal,
        source: {
          ...(repo === undefined ? {} : { repository: repo }),
          ...(operation.source === undefined ? {} : { catalogSource: operation.source }),
          ...(operation.entryKey === undefined ? {} : { entryKey: operation.entryKey }),
        },
        ...(capletIds === undefined ? {} : { capletIds }),
        force: operation.force ?? false,
        artifacts: staged.artifacts,
      });
      await attachCatalogIndexing(staged.installed, operation.disableCatalogIndexing ?? false);
      const installed = attachPersistedCatalogIndexing(persisted.installed, staged.installed);
      for (const entry of installed) {
        await dependencies.activityLog.append({
          actorClientId: principal.clientId,
          action: "catalog_installed",
          target: { type: "catalog", id: entry.id },
          metadata: { status: entry.status ?? null, kind: entry.kind },
        });
      }
      return { kind: "catalog_install", installed, setupActions };
    } finally {
      staged.cleanup();
    }
  } catch (error) {
    await appendCatalogFailureActivities(dependencies, principal, "catalog_installed", capletIds);
    throw error;
  }
}

async function catalogUpdateOutcome(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  operation: CatalogUpdateOperation,
): Promise<CatalogUpdateOutcome> {
  const capletIds = optionalCapletIds(operation.capletIds);
  try {
    const persistence = requireGlobalCatalogPersistence(dependencies);
    const lockEntries = await persistence.loadGlobalCatalogProvenance(capletIds);
    const staged = stageCatalogUpdate(
      lockEntries,
      capletIds,
      operation.force ?? false,
      operation.allowRiskIncrease,
      principal.clientId,
    );
    try {
      const finalAuthorization = finalAuthorizeCurrentHostMutation(principal);
      if (finalAuthorization instanceof Promise) await finalAuthorization;
      const persisted = await persistence.persistGlobalCatalogChange({
        action: "update",
        principal,
        source: {},
        ...(capletIds === undefined ? {} : { capletIds }),
        force: operation.force ?? false,
        ...(operation.allowRiskIncrease === undefined
          ? {}
          : { allowRiskIncrease: operation.allowRiskIncrease }),
        artifacts: staged.artifacts,
      });
      await attachCatalogIndexing(staged.installed, operation.disableCatalogIndexing ?? false);
      const installed = attachPersistedCatalogIndexing(persisted.installed, staged.installed);
      for (const entry of installed) {
        await dependencies.activityLog.append({
          actorClientId: principal.clientId,
          action: "catalog_updated",
          target: { type: "catalog", id: entry.id },
          metadata: {
            status: entry.status ?? null,
            riskAcknowledged: operation.allowRiskIncrease ?? false,
          },
        });
      }
      return { kind: "catalog_update", installed, setupActions: [] };
    } finally {
      staged.cleanup();
    }
  } catch (error) {
    await appendCatalogFailureActivities(dependencies, principal, "catalog_updated", capletIds);
    throw error;
  }
}

async function appendCatalogFailureActivities(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  action: "catalog_installed" | "catalog_updated",
  capletIds: string[] | undefined,
): Promise<void> {
  for (const id of capletIds && capletIds.length > 0 ? capletIds : ["current-host"]) {
    await appendFailureActivity(dependencies, principal, action, { type: "catalog", id });
  }
}

type StagedGlobalCatalog = Readonly<{
  installed: InstallableCaplet[];
  artifacts: GlobalCatalogArtifact[];
  cleanup(): void;
}>;

async function stageCatalogInstall(
  control: CurrentHostControlContext | undefined,
  persistence: GlobalCatalogPersistenceDependencies,
  repo: string | undefined,
  capletIds: string[] | undefined,
  force: boolean,
  setupActions: readonly CurrentHostSetupAction[],
  actorId: string,
): Promise<StagedGlobalCatalog> {
  const root = mkdtempSync(join(tmpdir(), "caplets-catalog-"));
  const target = {
    destinationRoot: join(root, "caplets"),
    lockfilePath: join(root, "caplets.lock.json"),
  };
  try {
    if (repo === undefined) {
      const persisted = await persistence.loadGlobalCatalogProvenance(capletIds);
      if (persisted.length > 0) {
        writeCapletsLockfile(target.lockfilePath, { version: 1, entries: [...persisted] });
      } else {
        copyFileSync(
          requireControlContext(control, "Catalog restore").globalLockfilePath ??
            defaultCapletsLockfilePath(),
          target.lockfilePath,
        );
      }
    }
    const installed = repo
      ? installCaplets(repo, {
          ...target,
          ...(capletIds === undefined ? {} : { capletIds }),
          force,
        }).installed
      : restoreCapletsFromLockfile({
          ...target,
          ...(capletIds === undefined ? {} : { capletIds }),
          force,
        }).installed;
    return stagedGlobalCatalog(root, target.lockfilePath, installed, setupActions, actorId);
  } catch (error) {
    cleanupStagingRoot(root);
    throw error;
  }
}

function stageCatalogUpdate(
  lockEntries: readonly CapletsLockEntry[],
  capletIds: string[] | undefined,
  force: boolean,
  allowRiskIncrease: boolean | undefined,
  actorId: string,
): StagedGlobalCatalog {
  if (lockEntries.length === 0) {
    throw new CapletsError(
      "CONFIG_NOT_FOUND",
      "No SQL-owned catalog Caplets were found to update.",
    );
  }
  const root = mkdtempSync(join(tmpdir(), "caplets-catalog-"));
  const target = {
    destinationRoot: join(root, "caplets"),
    lockfilePath: join(root, "caplets.lock.json"),
  };
  try {
    writeCapletsLockfile(target.lockfilePath, { version: 1, entries: [...lockEntries] });
    const installed = updateCapletsFromLockfile({
      ...target,
      ...(capletIds === undefined ? {} : { capletIds }),
      force,
      ...(allowRiskIncrease === undefined ? {} : { allowRiskIncrease }),
    }).installed;
    return stagedGlobalCatalog(root, target.lockfilePath, installed, [], actorId);
  } catch (error) {
    cleanupStagingRoot(root);
    throw error;
  }
}

function stagedGlobalCatalog(
  root: string,
  lockfilePath: string,
  installed: InstallableCaplet[],
  setupActions: readonly CurrentHostSetupAction[],
  actorId: string,
): StagedGlobalCatalog {
  const lockEntries = new Map(
    readCapletsLockfile(lockfilePath).entries.map((entry) => [entry.id, entry]),
  );
  const artifacts = installed.map((entry): GlobalCatalogArtifact => {
    const lockEntry = lockEntries.get(entry.id);
    if (!lockEntry) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Staged catalog metadata is missing Caplet ${entry.id}.`,
      );
    }
    const portable = portableArtifact(entry);
    const encoded = encodePortableCaplet(portable);
    const contentHash =
      normalizedHash(lockEntry.installedHash) ?? createHash("sha256").update(encoded).digest("hex");
    const runtimeFingerprint = lockEntry.runtimeFingerprint
      ? normalizedHash(lockEntry.runtimeFingerprint.artifactFingerprint)
      : undefined;
    return {
      installed: {
        id: entry.id,
        source: entry.source,
        destination: lockEntry.destination,
        kind: entry.kind,
        ...(entry.hash === undefined ? {} : { hash: entry.hash }),
        ...(entry.status === undefined ? {} : { status: entry.status }),
      },
      lockEntry,
      portable,
      provenance: {
        id: `catalog:${entry.id}:${contentHash}`,
        sourceKind: lockEntry.source.type,
        source: { ...lockEntry.source },
        contentHash,
        ...(runtimeFingerprint === undefined ? {} : { runtimeFingerprint }),
        ownerId: actorId,
        installedAt: lockEntry.installedAt,
        ...(lockEntry.source.type === "git" && lockEntry.source.resolvedRevision
          ? { resolvedRevision: lockEntry.source.resolvedRevision }
          : {}),
        riskSummary: { ...lockEntry.risk },
      },
      setupActions,
    };
  });
  return {
    installed,
    artifacts,
    cleanup: () => cleanupStagingRoot(root),
  };
}

function cleanupStagingRoot(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // SQL commit state is authoritative; cleanup failure must not relabel it as uncommitted.
  }
}

function portableArtifact(entry: InstallableCaplet): PortableCaplet {
  const entryPath =
    entry.kind === "directory" ? join(entry.destination, "CAPLET.md") : entry.destination;
  const entryStats = lstatSync(entryPath);
  if (!entryStats.isFile()) {
    throw new CapletsError("CONFIG_INVALID", `Staged Caplet ${entry.id} is not a regular file.`);
  }
  return portableCapletFromCapletDocument({
    id: entry.id,
    path: entry.kind === "directory" ? "CAPLET.md" : basename(entry.destination),
    text: readFileSync(entryPath, "utf8"),
    files: entry.kind === "directory" ? portableAssetFiles(entry.destination, entryPath) : [],
  });
}

function portableAssetFiles(root: string, entryPath: string): PortableCapletBundleFile[] {
  const files: PortableCapletBundleFile[] = [];
  const visit = (directory: string): void => {
    for (const child of readdirSync(directory, { withFileTypes: true }).toSorted((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, child.name);
      if (path === entryPath) continue;
      if (child.isDirectory()) {
        visit(path);
        continue;
      }
      if (!child.isFile()) {
        throw new CapletsError("CONFIG_INVALID", "Staged Caplet contains a non-portable file.");
      }
      files.push({
        path: relative(root, path).split(sep).join("/"),
        role: "asset",
        mediaType: "application/octet-stream",
        content: readFileSync(path),
        sourceKind: "file",
      });
    }
  };
  visit(root);
  return files;
}

function normalizedHash(value: string): string | undefined {
  const match = /^(?:sha256:)?([a-f0-9]{64})$/u.exec(value);
  return match?.[1];
}

function attachPersistedCatalogIndexing(
  persisted: CurrentHostInstalledCatalogCaplet[],
  staged: InstallableCaplet[],
): CurrentHostInstalledCatalogCaplet[] {
  const indexing = new Map(staged.map((entry) => [entry.id, entry.catalogIndexing]));
  return persisted.map((entry) => ({
    ...entry,
    ...(indexing.get(entry.id) === undefined ? {} : { catalogIndexing: indexing.get(entry.id) }),
  }));
}

function requireGlobalCatalogPersistence(
  dependencies: Pick<
    CurrentHostOperationsDependencies,
    "loadGlobalCatalogProvenance" | "persistGlobalCatalogChange"
  >,
): GlobalCatalogPersistenceDependencies {
  if (dependencies.loadGlobalCatalogProvenance && dependencies.persistGlobalCatalogChange) {
    return {
      loadGlobalCatalogProvenance: dependencies.loadGlobalCatalogProvenance,
      persistGlobalCatalogChange: dependencies.persistGlobalCatalogChange,
    };
  }
  throw new CapletsError(
    "SERVER_UNAVAILABLE",
    "SQL catalog persistence is unavailable for Current Host administration.",
  );
}

async function attachCatalogIndexing(
  installed: Array<{
    id: string;
    lockfile?: string | undefined;
    catalogIndexing?: unknown;
  }>,
  disableCatalogIndexing: boolean,
): Promise<void> {
  try {
    const indexed = await indexInstalledCapletsFromLockfile(installed, { disableCatalogIndexing });
    for (const entry of installed) entry.catalogIndexing = indexed.get(entry.id);
  } catch {
    for (const entry of installed) {
      entry.catalogIndexing = { status: "unavailable", reason: "indexer_unavailable" };
    }
  }
}

function requireControlContext(
  control: CurrentHostControlContext | undefined,
  purpose: string,
): CurrentHostControlContext {
  if (control) return control;
  throw new CapletsError("SERVER_UNAVAILABLE", `${purpose} require server control context.`);
}

function optionalCapletIds(value: string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  for (const capletId of value) requiredCapletId(capletId);
  return value;
}

function requiredCapletId(value: unknown): string {
  if (typeof value === "string" && SERVER_ID_PATTERN.test(value)) return value;
  throw new CapletsError("REQUEST_INVALID", "Caplet ID is invalid.");
}

async function appendFailureActivity(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  action: "catalog_installed" | "catalog_updated",
  target: { type: "catalog"; id: string },
): Promise<void> {
  await dependencies.activityLog.append({
    actorClientId: principal.clientId,
    action,
    outcome: "failure",
    target,
  });
}
