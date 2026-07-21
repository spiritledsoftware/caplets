import { defaultCapletsLockfilePath, resolveCapletsRoot } from "../config";
import { SERVER_ID_PATTERN } from "../config/validation";
import {
  indexInstalledCapletsFromLockfile,
  installCaplets,
  restoreCapletsFromLockfile,
  updateCapletsFromLockfile,
} from "../install";
import { CapletsError } from "../errors";
import { installSqlCatalogCaplets, updateSqlCatalogCaplets } from "../storage/catalog-lifecycle";
import {
  storagePageLimit,
  type KeysetSortDirection,
  type StorageKeysetPage,
} from "../storage/keyset-page";
import {
  currentHostCatalogDetail,
  currentHostCatalogIndex,
  currentHostCatalogInstallSource,
  currentHostCatalogSearch,
  currentHostCatalogUpdateReadiness,
  currentHostInstalledCaplets,
  type CurrentHostSetupAction,
} from "./catalog";
import type {
  CurrentHostControlContext,
  CurrentHostOperation,
  CurrentHostOperationOutcome,
  CurrentHostOperatorPrincipal,
  CurrentHostOperationsDependencies,
} from "./operations";

type CapletsListOperation = Extract<CurrentHostOperation, { kind: "caplets_list" }>;
type CapletsPageOperation = Extract<CurrentHostOperation, { kind: "caplets_page" }>;
type CatalogSearchOperation = Extract<CurrentHostOperation, { kind: "catalog_search" }>;
type CatalogIndexOperation = Extract<CurrentHostOperation, { kind: "catalog_index" }>;
type CatalogEntriesPageOperation = Extract<CurrentHostOperation, { kind: "catalog_entries_page" }>;
type CatalogDetailOperation = Extract<CurrentHostOperation, { kind: "catalog_detail" }>;
type CatalogUpdatesOperation = Extract<CurrentHostOperation, { kind: "catalog_updates" }>;
type CatalogUpdateCandidatesPageOperation = Extract<
  CurrentHostOperation,
  { kind: "catalog_update_candidates_page" }
>;
type CatalogInstallOperation = Extract<CurrentHostOperation, { kind: "catalog_install" }>;
type CatalogUpdateOperation = Extract<CurrentHostOperation, { kind: "catalog_update" }>;
type CapletsListOutcome = Extract<CurrentHostOperationOutcome, { kind: "caplets_list" }>;
type CapletsPageOutcome = Extract<CurrentHostOperationOutcome, { kind: "caplets_page" }>;
type CatalogSearchOutcome = Extract<CurrentHostOperationOutcome, { kind: "catalog_search" }>;
type CatalogIndexOutcome = Extract<CurrentHostOperationOutcome, { kind: "catalog_index" }>;
type CatalogEntriesPageOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "catalog_entries_page" }
>;
type CatalogDetailOutcome = Extract<CurrentHostOperationOutcome, { kind: "catalog_detail" }>;
type CatalogUpdatesOutcome = Extract<CurrentHostOperationOutcome, { kind: "catalog_updates" }>;
type CatalogUpdateCandidatesPageOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "catalog_update_candidates_page" }
>;
type CatalogInstallOutcome = Extract<CurrentHostOperationOutcome, { kind: "catalog_install" }>;
type CatalogUpdateOutcome = Extract<CurrentHostOperationOutcome, { kind: "catalog_update" }>;

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
    capletsPage: (operation: CapletsPageOperation): CapletsPageOutcome => {
      const caplets = currentHostInstalledCaplets(dependencies.engine.enabledServers(), {
        globalLockfilePath: dependencies.control?.globalLockfilePath,
      });
      return {
        kind: "caplets_page",
        page: keysetPage(
          caplets,
          operation.limit,
          operation.sort,
          operation.after?.id,
          (item) => item.id,
          (id) => ({ id }),
        ),
      };
    },
    search: async (operation: CatalogSearchOperation): Promise<CatalogSearchOutcome> => ({
      kind: "catalog_search",
      ...(await currentHostCatalogSearch(operation)),
    }),
    entriesPage: async (
      operation: CatalogEntriesPageOperation,
    ): Promise<CatalogEntriesPageOutcome> => {
      const { entries } = await currentHostCatalogIndex({ source: operation.source });
      const query = operation.query?.trim().toLowerCase();
      const filtered = query
        ? entries.filter((entry) =>
            [entry.id, entry.name, entry.description, ...entry.tags]
              .join("\n")
              .toLowerCase()
              .includes(query),
          )
        : entries;
      return {
        kind: "catalog_entries_page",
        page: keysetPage(
          filtered,
          operation.limit,
          operation.sort,
          operation.after?.entryKey,
          (item) => item.entryKey,
          (entryKey) => ({ entryKey }),
        ),
      };
    },
    index: async (operation: CatalogIndexOperation): Promise<CatalogIndexOutcome> => ({
      kind: "catalog_index",
      ...(await currentHostCatalogIndex(operation)),
    }),
    detail: async (operation: CatalogDetailOperation): Promise<CatalogDetailOutcome> => ({
      kind: "catalog_detail",
      ...(await currentHostCatalogDetail(operation)),
    }),
    updates: (_operation: CatalogUpdatesOperation): CatalogUpdatesOutcome => ({
      kind: "catalog_updates",
      ...currentHostCatalogUpdateReadiness({
        context: { globalLockfilePath: dependencies.control?.globalLockfilePath },
      }),
    }),
    updateCandidatesPage: (
      operation: CatalogUpdateCandidatesPageOperation,
    ): CatalogUpdateCandidatesPageOutcome => {
      const { updates } = currentHostCatalogUpdateReadiness({
        context: { globalLockfilePath: dependencies.control?.globalLockfilePath },
      });
      return {
        kind: "catalog_update_candidates_page",
        page: keysetPage(
          updates,
          operation.limit,
          operation.sort,
          operation.after?.id,
          (item) => item.id,
          (id) => ({ id }),
        ),
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
  try {
    let repo = operation.repo;
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
    const installed = dependencies.catalogStorage
      ? await installCatalogRecords(dependencies, principal, repo, capletIds, operation)
      : await installCatalogFiles(dependencies, repo, capletIds, operation);
    await dependencies.activateConfig?.();
    for (const entry of installed) {
      dependencies.activityLog.append({
        actorClientId: principal.clientId,
        action: "catalog_installed",
        target: { type: "catalog", id: entry.id },
        metadata: { status: entry.status ?? null, kind: entry.kind },
      });
    }
    return { kind: "catalog_install", installed, setupActions };
  } catch (error) {
    appendCatalogFailureActivities(dependencies, principal, "catalog_installed", capletIds);
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
    const installed = dependencies.catalogStorage
      ? (
          await updateSqlCatalogCaplets({
            storage: dependencies.catalogStorage,
            operator: operator(principal),
            ...(capletIds === undefined ? {} : { capletIds }),
            ...(operation.force === undefined ? {} : { force: operation.force }),
            ...(operation.allowRiskIncrease === undefined
              ? {}
              : { allowRiskIncrease: operation.allowRiskIncrease }),
            ...(operation.disableCatalogIndexing === undefined
              ? {}
              : { disableCatalogIndexing: operation.disableCatalogIndexing }),
          })
        ).installed
      : await updateCatalogFiles(dependencies, capletIds, operation);
    await dependencies.activateConfig?.();
    for (const entry of installed) {
      dependencies.activityLog.append({
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
  } catch (error) {
    appendCatalogFailureActivities(dependencies, principal, "catalog_updated", capletIds);
    throw error;
  }
}

async function installCatalogRecords(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  source: string | undefined,
  capletIds: string[] | undefined,
  operation: CatalogInstallOperation,
) {
  if (!source) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "SQL catalog install requires a source; tracked SQL installations are updated with catalog update.",
    );
  }
  return (
    await installSqlCatalogCaplets({
      storage: dependencies.catalogStorage!,
      operator: operator(principal),
      source,
      ...(capletIds === undefined ? {} : { capletIds }),
      ...(operation.force === undefined ? {} : { force: operation.force }),
      ...(operation.disableCatalogIndexing === undefined
        ? {}
        : { disableCatalogIndexing: operation.disableCatalogIndexing }),
    })
  ).installed;
}

async function installCatalogFiles(
  dependencies: CurrentHostOperationsDependencies,
  repo: string | undefined,
  capletIds: string[] | undefined,
  operation: CatalogInstallOperation,
) {
  const control = requireControlContext(dependencies.control, "Catalog actions");
  const installOptions = {
    ...globalCatalogTarget(control),
    ...(capletIds === undefined ? {} : { capletIds }),
    ...(operation.force === undefined ? {} : { force: operation.force }),
  };
  const installed = repo
    ? installCaplets(repo, installOptions).installed
    : restoreCapletsFromLockfile(installOptions).installed;
  await attachCatalogIndexing(installed, operation.disableCatalogIndexing ?? false);
  return installed;
}

async function updateCatalogFiles(
  dependencies: CurrentHostOperationsDependencies,
  capletIds: string[] | undefined,
  operation: CatalogUpdateOperation,
) {
  const control = requireControlContext(dependencies.control, "Catalog actions");
  const installed = updateCapletsFromLockfile({
    ...globalCatalogTarget(control),
    ...(capletIds === undefined ? {} : { capletIds }),
    ...(operation.force === undefined ? {} : { force: operation.force }),
    ...(operation.allowRiskIncrease === undefined
      ? {}
      : { allowRiskIncrease: operation.allowRiskIncrease }),
  }).installed;
  await attachCatalogIndexing(installed, operation.disableCatalogIndexing ?? false);
  return installed;
}

function operator(principal: CurrentHostOperatorPrincipal) {
  return { role: "operator" as const, clientId: principal.clientId };
}

function appendCatalogFailureActivities(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  action: "catalog_installed" | "catalog_updated",
  capletIds: string[] | undefined,
): void {
  for (const id of capletIds && capletIds.length > 0 ? capletIds : ["current-host"]) {
    appendFailureActivity(dependencies, principal, action, { type: "catalog", id });
  }
}

function globalCatalogTarget(control: CurrentHostControlContext): {
  destinationRoot: string;
  lockfilePath: string;
} {
  return {
    destinationRoot: control.globalCapletsRoot ?? resolveCapletsRoot(control.configPath),
    lockfilePath: control.globalLockfilePath ?? defaultCapletsLockfilePath(),
  };
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

function appendFailureActivity(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  action: "catalog_installed" | "catalog_updated",
  target: { type: "catalog"; id: string },
): void {
  dependencies.activityLog.append({
    actorClientId: principal.clientId,
    action,
    outcome: "failure",
    target,
  });
}

function keysetPage<Item, Key>(
  items: readonly Item[],
  requestedLimit: number,
  sort: KeysetSortDirection,
  after: string | undefined,
  stableKey: (item: Item) => string,
  pageKey: (value: string) => Key,
): StorageKeysetPage<Item, Key> {
  const limit = storagePageLimit(requestedLimit);
  const direction = sort === "asc" ? 1 : -1;
  const ordered = [...items].sort((left, right) => {
    const leftKey = stableKey(left);
    const rightKey = stableKey(right);
    if (leftKey === rightKey) return 0;
    return direction * (leftKey < rightKey ? -1 : 1);
  });
  const remaining =
    after === undefined
      ? ordered
      : ordered.filter((item) => {
          const key = stableKey(item);
          if (key === after) return false;
          return direction * (key < after ? -1 : 1) > 0;
        });
  const pageItems = remaining.slice(0, limit);
  if (remaining.length <= limit) return { items: pageItems };
  return {
    items: pageItems,
    nextKey: pageKey(stableKey(pageItems[pageItems.length - 1]!)),
  };
}
