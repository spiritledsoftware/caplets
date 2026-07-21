import { CapletsError } from "../errors";
import type { CapletInstallationStore } from "../storage/installations";
import type {
  CurrentHostOperation,
  CurrentHostOperationOutcome,
  CurrentHostOperatorPrincipal,
  CurrentHostOperationsDependencies,
} from "./operations";

type PageOperation = Extract<CurrentHostOperation, { kind: "stored_caplet_installations_page" }>;
type ObservationsPageOperation = Extract<
  CurrentHostOperation,
  { kind: "stored_caplet_installation_observations_page" }
>;
type GetOperation = Extract<CurrentHostOperation, { kind: "stored_caplet_installation_get" }>;
type PutOperation = Extract<CurrentHostOperation, { kind: "stored_caplet_installation_put" }>;
type DeleteOperation = Extract<CurrentHostOperation, { kind: "stored_caplet_installation_delete" }>;
type ObserveOperation = Extract<
  CurrentHostOperation,
  { kind: "stored_caplet_installation_observe" }
>;
type StatusOperation = Extract<CurrentHostOperation, { kind: "stored_caplet_installation_status" }>;

type PageOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "stored_caplet_installations_page" }
>;
type ObservationsPageOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "stored_caplet_installation_observations_page" }
>;
type GetOutcome = Extract<CurrentHostOperationOutcome, { kind: "stored_caplet_installation_get" }>;
type PutOutcome = Extract<CurrentHostOperationOutcome, { kind: "stored_caplet_installation_put" }>;
type DeleteOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "stored_caplet_installation_delete" }
>;
type ObserveOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "stored_caplet_installation_observe" }
>;
type StatusOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "stored_caplet_installation_status" }
>;
export interface CurrentHostInstallationOperations {
  page(operation: PageOperation): Promise<PageOutcome>;
  observationsPage(operation: ObservationsPageOperation): Promise<ObservationsPageOutcome>;
  get(operation: GetOperation): Promise<GetOutcome>;
  status(operation: StatusOperation): Promise<StatusOutcome>;
  put(principal: CurrentHostOperatorPrincipal, operation: PutOperation): Promise<PutOutcome>;
  delete(
    principal: CurrentHostOperatorPrincipal,
    operation: DeleteOperation,
  ): Promise<DeleteOutcome>;
  observe(
    principal: CurrentHostOperatorPrincipal,
    operation: ObserveOperation,
  ): Promise<ObserveOutcome>;
}

export function createCurrentHostInstallationOperations(
  dependencies: CurrentHostOperationsDependencies,
): CurrentHostInstallationOperations {
  const requiredInstallations = (): CapletInstallationStore => {
    if (!dependencies.capletInstallations) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Authoritative Caplet Installation storage is unavailable.",
      );
    }
    return dependencies.capletInstallations;
  };

  return {
    page: async (operation: PageOperation): Promise<PageOutcome> => ({
      kind: "stored_caplet_installations_page",
      page: await requiredInstallations().listPage(operation.id, {
        limit: operation.limit,
        sort: operation.sort,
        ...(operation.after === undefined ? {} : { after: operation.after }),
      }),
    }),
    observationsPage: async (
      operation: ObservationsPageOperation,
    ): Promise<ObservationsPageOutcome> => ({
      kind: "stored_caplet_installation_observations_page",
      page: await requiredInstallations().listObservationsPage(operation.id, {
        limit: operation.limit,
        sort: operation.sort,
        ...(operation.after === undefined ? {} : { after: operation.after }),
      }),
    }),
    get: async (operation: GetOperation): Promise<GetOutcome> => {
      const store = requiredInstallations();
      const installation =
        operation.installationKey === undefined
          ? await store.getActive(operation.id)
          : await boundInstallation(store, operation.id, operation.installationKey);
      return installation
        ? { kind: "stored_caplet_installation_get", status: "found", installation }
        : {
            kind: "stored_caplet_installation_get",
            status: "not_found",
            id: operation.id,
            ...(operation.installationKey === undefined
              ? {}
              : { installationKey: operation.installationKey }),
          };
    },
    status: async (operation: StatusOperation): Promise<StatusOutcome> => {
      const store = requiredInstallations();
      const [installations, observations] = await Promise.all([
        store.list(operation.id),
        store.listObservations(operation.id),
      ]);
      return {
        kind: "stored_caplet_installation_status",
        installations,
        observations,
      };
    },
    put: async (
      principal: CurrentHostOperatorPrincipal,
      operation: PutOperation,
    ): Promise<PutOutcome> => {
      const store = requiredInstallations();
      if (operation.createOnly === true) {
        const installation = await store.install({
          capletId: operation.id,
          installationKey: operation.installationKey,
          sourceKind: operation.sourceKind,
          sourceIdentity: operation.sourceIdentity,
          ...(operation.channel === undefined ? {} : { channel: operation.channel }),
          operator: operator(principal),
        });
        await dependencies.activateConfig?.();
        return { kind: "stored_caplet_installation_put", status: "created", installation };
      }
      const detached = await boundInstallation(store, operation.id, operation.installationKey);
      if (!detached) {
        return {
          kind: "stored_caplet_installation_put",
          status: "not_found",
          id: operation.id,
          installationKey: operation.installationKey,
        };
      }
      const installation = await store.replaceDetached({
        capletId: operation.id,
        detachedInstallationKey: operation.installationKey,
        expectedGeneration: operation.expectedGeneration,
        sourceKind: operation.sourceKind,
        sourceIdentity: operation.sourceIdentity,
        ...(operation.channel === undefined ? {} : { channel: operation.channel }),
        operator: operator(principal),
      });
      await dependencies.activateConfig?.();
      return { kind: "stored_caplet_installation_put", status: "replaced", installation };
    },
    delete: async (
      principal: CurrentHostOperatorPrincipal,
      operation: DeleteOperation,
    ): Promise<DeleteOutcome> => {
      const store = requiredInstallations();
      const current = await boundInstallation(store, operation.id, operation.installationKey);
      if (!current) {
        return {
          kind: "stored_caplet_installation_delete",
          status: "not_found",
          id: operation.id,
          installationKey: operation.installationKey,
        };
      }
      const installation = await store.detach({
        capletId: operation.id,
        installationKey: operation.installationKey,
        expectedGeneration: operation.expectedGeneration,
        operator: operator(principal),
      });
      if (!installation || installation.installationKey !== operation.installationKey) {
        throw new CapletsError(
          "INTERNAL_ERROR",
          "Detached Caplet Installation replacement did not match its path key.",
        );
      }
      if (current.status === "active") await dependencies.activateConfig?.();
      return { kind: "stored_caplet_installation_delete", status: "detached", installation };
    },
    observe: async (
      principal: CurrentHostOperatorPrincipal,
      operation: ObserveOperation,
    ): Promise<ObserveOutcome> => {
      const store = requiredInstallations();
      const observation = await store.appendObservation({
        capletId: operation.id,
        expectedGeneration: operation.expectedGeneration,
        status: operation.status,
        ...(operation.resolvedRevision === undefined
          ? {}
          : { resolvedRevision: operation.resolvedRevision }),
        ...(operation.contentHash === undefined ? {} : { contentHash: operation.contentHash }),
        ...(operation.risk === undefined ? {} : { risk: operation.risk }),
        operator: operator(principal),
      });
      const installation = await store.getActive(operation.id);
      if (!installation) {
        throw new CapletsError(
          "INTERNAL_ERROR",
          "Observed Caplet Installation was not found after commit.",
        );
      }
      return { kind: "stored_caplet_installation_observe", observation, installation };
    },
  };
}

async function boundInstallation(
  store: CapletInstallationStore,
  capletId: string,
  installationKey: string,
) {
  const installation = await store.getByKey(installationKey);
  return installation?.capletId === capletId ? installation : undefined;
}

function operator(principal: CurrentHostOperatorPrincipal) {
  return { role: "operator" as const, clientId: principal.clientId };
}
