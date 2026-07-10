import { defaultCapletsLockfilePath, resolveCapletsRoot } from "../config";
import { SERVER_ID_PATTERN } from "../config/validation";
import {
  indexInstalledCapletsFromLockfile,
  installCaplets,
  restoreCapletsFromLockfile,
  updateCapletsFromLockfile,
} from "./../cli/install";
import { CapletsError } from "../errors";
import {
  currentHostCatalogDetail,
  currentHostCatalogInstallSource,
  currentHostCatalogSearch,
  currentHostCatalogUpdateReadiness,
  currentHostInstalledCaplets,
  currentHostSetupActionsForInstalled,
} from "./catalog";
import type {
  CurrentHostControlContext,
  CurrentHostOperation,
  CurrentHostOperationOutcome,
  CurrentHostOperatorPrincipal,
  CurrentHostOperationsDependencies,
} from "./operations";

type CapletsListOperation = Extract<CurrentHostOperation, { kind: "caplets_list" }>;
type CatalogSearchOperation = Extract<CurrentHostOperation, { kind: "catalog_search" }>;
type CatalogDetailOperation = Extract<CurrentHostOperation, { kind: "catalog_detail" }>;
type CatalogUpdatesOperation = Extract<CurrentHostOperation, { kind: "catalog_updates" }>;
type CatalogInstallOperation = Extract<CurrentHostOperation, { kind: "catalog_install" }>;
type CatalogUpdateOperation = Extract<CurrentHostOperation, { kind: "catalog_update" }>;
type CapletsListOutcome = Extract<CurrentHostOperationOutcome, { kind: "caplets_list" }>;
type CatalogSearchOutcome = Extract<CurrentHostOperationOutcome, { kind: "catalog_search" }>;
type CatalogDetailOutcome = Extract<CurrentHostOperationOutcome, { kind: "catalog_detail" }>;
type CatalogUpdatesOutcome = Extract<CurrentHostOperationOutcome, { kind: "catalog_updates" }>;
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
    search: (operation: CatalogSearchOperation): CatalogSearchOutcome => ({
      kind: "catalog_search",
      ...currentHostCatalogSearch(operation),
    }),
    detail: (operation: CatalogDetailOperation): CatalogDetailOutcome => ({
      kind: "catalog_detail",
      ...currentHostCatalogDetail(operation),
    }),
    updates: (_operation: CatalogUpdatesOperation): CatalogUpdatesOutcome => ({
      kind: "catalog_updates",
      ...currentHostCatalogUpdateReadiness({
        context: { globalLockfilePath: dependencies.control?.globalLockfilePath },
      }),
    }),
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
  const capletIds = optionalCapletIds(operation.capletIds);
  if (operation.source !== undefined && operation.repo !== undefined) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Catalog install accepts either a source or repository, not both.",
    );
  }
  try {
    const control = requireControlContext(dependencies.control, "Catalog actions");
    const target = globalCatalogTarget(control);
    const repo =
      operation.repo ??
      (operation.source === undefined
        ? undefined
        : currentHostCatalogInstallSource(operation.source));
    const installOptions = {
      ...target,
      ...(capletIds === undefined ? {} : { capletIds }),
      ...(operation.force === undefined ? {} : { force: operation.force }),
    };
    const installed = repo
      ? installCaplets(repo, installOptions).installed
      : restoreCapletsFromLockfile(installOptions).installed;
    await attachCatalogIndexing(installed, operation.disableCatalogIndexing ?? false);
    for (const entry of installed) {
      dependencies.activityLog.append({
        actorClientId: principal.clientId,
        action: "catalog_installed",
        target: { type: "catalog", id: entry.id },
        metadata: { status: entry.status ?? null, kind: entry.kind },
      });
    }
    const catalogSource = operation.source;
    const setupActions =
      catalogSource === undefined
        ? []
        : installed.flatMap((entry) =>
            currentHostSetupActionsForInstalled(catalogSource, entry.id),
          );
    return { kind: "catalog_install", installed, setupActions };
  } catch (error) {
    appendFailureActivity(dependencies, principal, "catalog_installed", {
      type: "catalog",
      id: capletIds?.[0] ?? "current-host",
    });
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
    appendFailureActivity(dependencies, principal, "catalog_updated", {
      type: "catalog",
      id: capletIds?.[0] ?? "current-host",
    });
    throw error;
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
  const indexed = await indexInstalledCapletsFromLockfile(installed, { disableCatalogIndexing });
  for (const entry of installed) entry.catalogIndexing = indexed.get(entry.id);
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
