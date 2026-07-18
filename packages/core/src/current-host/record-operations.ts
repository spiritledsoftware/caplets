import { Buffer } from "node:buffer";
import { CapletsError } from "../errors";
import type {
  CurrentHostOperation,
  CurrentHostOperationOutcome,
  CurrentHostOperatorPrincipal,
  CurrentHostOperationsDependencies,
} from "./operations";

type GetOperation = Extract<CurrentHostOperation, { kind: "stored_caplet_get" }>;
type ImportOperation = Extract<CurrentHostOperation, { kind: "stored_caplet_import" }>;
type UpdateOperation = Extract<CurrentHostOperation, { kind: "stored_caplet_update" }>;
type DeleteOperation = Extract<CurrentHostOperation, { kind: "stored_caplet_delete" }>;
type RevisionsOperation = Extract<CurrentHostOperation, { kind: "stored_caplet_revisions" }>;
type RestoreRevisionOperation = Extract<
  CurrentHostOperation,
  { kind: "stored_caplet_restore_revision" }
>;
type DeleteRevisionOperation = Extract<
  CurrentHostOperation,
  { kind: "stored_caplet_delete_revision" }
>;

type ListOutcome = Extract<CurrentHostOperationOutcome, { kind: "stored_caplets_list" }>;
type GetOutcome = Extract<CurrentHostOperationOutcome, { kind: "stored_caplet_get" }>;
type ImportOutcome = Extract<CurrentHostOperationOutcome, { kind: "stored_caplet_import" }>;
type UpdateOutcome = Extract<CurrentHostOperationOutcome, { kind: "stored_caplet_update" }>;
type DeleteOutcome = Extract<CurrentHostOperationOutcome, { kind: "stored_caplet_delete" }>;
type RevisionsOutcome = Extract<CurrentHostOperationOutcome, { kind: "stored_caplet_revisions" }>;
type RestoreRevisionOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "stored_caplet_restore_revision" }
>;
type DeleteRevisionOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "stored_caplet_delete_revision" }
>;

export function createCurrentHostRecordOperations(dependencies: CurrentHostOperationsDependencies) {
  const records = dependencies.capletRecords;
  const requiredRecords = () => {
    if (!records) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Authoritative Caplet Record storage is unavailable.",
      );
    }
    return records;
  };
  const activate = async (): Promise<void> => {
    await dependencies.activateConfig?.();
  };

  return {
    list: async (principal: CurrentHostOperatorPrincipal): Promise<ListOutcome> => ({
      kind: "stored_caplets_list",
      records: await requiredRecords().listStored(operator(principal)),
    }),
    get: async (
      principal: CurrentHostOperatorPrincipal,
      operation: GetOperation,
    ): Promise<GetOutcome> => {
      const bundle = await requiredRecords().readBundle(operation.id, {
        operator: operator(principal),
        ...(operation.revisionKey === undefined ? {} : { revisionKey: operation.revisionKey }),
      });
      const document = bundle.files.find((file) => file.path === "CAPLET.md");
      if (!document) {
        throw new CapletsError("INTERNAL_ERROR", "Stored Caplet bundle has no CAPLET.md document.");
      }
      return {
        kind: "stored_caplet_get",
        record: bundle.record,
        document: document.content.toString("utf8"),
      };
    },
    import: async (
      principal: CurrentHostOperatorPrincipal,
      operation: ImportOperation,
    ): Promise<ImportOutcome> => {
      const record = await requiredRecords().importBundle({
        id: operation.id,
        files: [documentFile(operation.document)],
        operator: operator(principal),
        ...(operation.historyLimit === undefined ? {} : { historyLimit: operation.historyLimit }),
      });
      await activate();
      return { kind: "stored_caplet_import", record };
    },
    update: async (
      principal: CurrentHostOperatorPrincipal,
      operation: UpdateOperation,
    ): Promise<UpdateOutcome> => {
      const store = requiredRecords();
      const current = await store.readBundle(operation.id, { operator: operator(principal) });
      const files = current.files.map((file) =>
        file.path === "CAPLET.md" ? documentFile(operation.document) : file,
      );
      const record = await store.updateBundle({
        id: operation.id,
        files,
        expectedGeneration: operation.expectedGeneration,
        operator: operator(principal),
      });
      await activate();
      return { kind: "stored_caplet_update", record };
    },
    delete: async (
      principal: CurrentHostOperatorPrincipal,
      operation: DeleteOperation,
    ): Promise<DeleteOutcome> => {
      await requiredRecords().hardDelete({
        id: operation.id,
        expectedGeneration: operation.expectedGeneration,
        operator: operator(principal),
      });
      await activate();
      return { kind: "stored_caplet_delete", deleted: true, id: operation.id };
    },
    revisions: async (
      principal: CurrentHostOperatorPrincipal,
      operation: RevisionsOperation,
    ): Promise<RevisionsOutcome> => ({
      kind: "stored_caplet_revisions",
      revisions: await requiredRecords().listRevisions(operation.id, operator(principal)),
    }),
    restoreRevision: async (
      principal: CurrentHostOperatorPrincipal,
      operation: RestoreRevisionOperation,
    ): Promise<RestoreRevisionOutcome> => {
      const record = await requiredRecords().restoreRevision({
        id: operation.id,
        revisionKey: operation.revisionKey,
        expectedGeneration: operation.expectedGeneration,
        operator: operator(principal),
      });
      await activate();
      return { kind: "stored_caplet_restore_revision", record };
    },
    deleteRevision: async (
      principal: CurrentHostOperatorPrincipal,
      operation: DeleteRevisionOperation,
    ): Promise<DeleteRevisionOutcome> => {
      const record = await requiredRecords().deleteRevision({
        id: operation.id,
        revisionKey: operation.revisionKey,
        expectedGeneration: operation.expectedGeneration,
        operator: operator(principal),
      });
      await activate();
      return {
        kind: "stored_caplet_delete_revision",
        ...(record === undefined ? {} : { record }),
      };
    },
  };
}

function operator(principal: CurrentHostOperatorPrincipal) {
  return { role: "operator" as const, clientId: principal.clientId };
}

function documentFile(document: string) {
  return { path: "CAPLET.md", content: Buffer.from(document), executable: false };
}
