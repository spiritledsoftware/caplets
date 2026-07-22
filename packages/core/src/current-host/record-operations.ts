import { Buffer } from "node:buffer";
import { CapletsError } from "../errors";
import {
  MAX_BUNDLE_FILE_BYTES,
  type CapletRecordStore,
  type ReadCapletBundleSourcesResult,
} from "../storage/caplet-records";
import {
  bufferBundleFileSource,
  readVerifiedBundleFile,
  type ReopenableBundleFileSource,
} from "../storage/bundle-source";
import type {
  CurrentHostOperation,
  CurrentHostOperationOutcome,
  CurrentHostOperatorPrincipal,
  CurrentHostOperationsDependencies,
} from "./operations";

type PageOperation = Extract<CurrentHostOperation, { kind: "stored_caplets_page" }>;
type GetOperation = Extract<CurrentHostOperation, { kind: "stored_caplet_get" }>;
type BundleGetOperation = Extract<CurrentHostOperation, { kind: "stored_caplet_bundle_get" }>;
type ImportOperation = Extract<CurrentHostOperation, { kind: "stored_caplet_import" }>;
type BundleImportOperation = Extract<CurrentHostOperation, { kind: "stored_caplet_bundle_import" }>;
type UpdateOperation = Extract<CurrentHostOperation, { kind: "stored_caplet_update" }>;
type BundleUpdateOperation = Extract<CurrentHostOperation, { kind: "stored_caplet_bundle_update" }>;
type DeleteOperation = Extract<CurrentHostOperation, { kind: "stored_caplet_delete" }>;
type RevisionsOperation = Extract<CurrentHostOperation, { kind: "stored_caplet_revisions" }>;
type RevisionsPageOperation = Extract<
  CurrentHostOperation,
  { kind: "stored_caplet_revisions_page" }
>;
type RestoreRevisionOperation = Extract<
  CurrentHostOperation,
  { kind: "stored_caplet_restore_revision" }
>;
type DeleteRevisionOperation = Extract<
  CurrentHostOperation,
  { kind: "stored_caplet_delete_revision" }
>;

type ListOutcome = Extract<CurrentHostOperationOutcome, { kind: "stored_caplets_list" }>;
type PageOutcome = Extract<CurrentHostOperationOutcome, { kind: "stored_caplets_page" }>;
type GetOutcome = Extract<CurrentHostOperationOutcome, { kind: "stored_caplet_get" }>;
type BundleGetOutcome = Extract<CurrentHostOperationOutcome, { kind: "stored_caplet_bundle_get" }>;
type ImportOutcome = Extract<CurrentHostOperationOutcome, { kind: "stored_caplet_import" }>;
type BundleImportOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "stored_caplet_bundle_import" }
>;
type UpdateOutcome = Extract<CurrentHostOperationOutcome, { kind: "stored_caplet_update" }>;
type BundleUpdateOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "stored_caplet_bundle_update" }
>;
type DeleteOutcome = Extract<CurrentHostOperationOutcome, { kind: "stored_caplet_delete" }>;
type RevisionsOutcome = Extract<CurrentHostOperationOutcome, { kind: "stored_caplet_revisions" }>;
type RevisionsPageOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "stored_caplet_revisions_page" }
>;
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
  const requiredRecords = (): CapletRecordStore => {
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
    page: async (operation: PageOperation): Promise<PageOutcome> => ({
      kind: "stored_caplets_page",
      page: await requiredRecords().listRecordsPage({
        limit: operation.limit,
        sort: operation.sort,
        ...(operation.after === undefined ? {} : { after: operation.after }),
        ...(operation.source === undefined ? {} : { source: operation.source }),
        ...(operation.status === undefined ? {} : { status: operation.status }),
        ...(operation.tag === undefined ? {} : { tag: operation.tag }),
        ...(operation.search === undefined ? {} : { search: operation.search }),
      }),
    }),
    get: async (
      principal: CurrentHostOperatorPrincipal,
      operation: GetOperation,
    ): Promise<GetOutcome> => {
      const bundle = await readRecordBundleSources(
        requiredRecords(),
        operation.id,
        principal,
        operation.revisionKey,
      );
      return {
        kind: "stored_caplet_get",
        record: bundle.record,
        document: await readCapletDocument(bundle.sources),
      };
    },
    bundleGet: async (
      principal: CurrentHostOperatorPrincipal,
      operation: BundleGetOperation,
    ): Promise<BundleGetOutcome> => ({
      kind: "stored_caplet_bundle_get",
      ...(await readRecordBundleSources(
        requiredRecords(),
        operation.id,
        principal,
        operation.revisionKey,
      )),
    }),
    import: async (
      principal: CurrentHostOperatorPrincipal,
      operation: ImportOperation,
    ): Promise<ImportOutcome> => {
      const record = await requiredRecords().importBundleSources({
        id: operation.id,
        sources: [documentSource(operation.document)],
        operator: operator(principal),
        ...(operation.historyLimit === undefined ? {} : { historyLimit: operation.historyLimit }),
      });
      await activate();
      return { kind: "stored_caplet_import", record };
    },
    bundleImport: async (
      principal: CurrentHostOperatorPrincipal,
      operation: BundleImportOperation,
    ): Promise<BundleImportOutcome> => {
      const record = await requiredRecords().importBundleSources({
        id: operation.id,
        sources: [...operation.sources],
        operator: operator(principal),
        ...(operation.historyLimit === undefined ? {} : { historyLimit: operation.historyLimit }),
        ...(operation.sourceRevision === undefined
          ? {}
          : { sourceRevision: operation.sourceRevision }),
        ...(operation.sourceContentHash === undefined
          ? {}
          : { sourceContentHash: operation.sourceContentHash }),
        ...(operation.installation === undefined ? {} : { installation: operation.installation }),
      });
      await activate();
      return { kind: "stored_caplet_bundle_import", record };
    },
    update: async (
      principal: CurrentHostOperatorPrincipal,
      operation: UpdateOperation,
    ): Promise<UpdateOutcome> => {
      const patchCount =
        Number(operation.document !== undefined) +
        Number(operation.newId !== undefined) +
        Number(operation.historyLimit !== undefined);
      if (patchCount !== 1) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "A Caplet Record patch must change exactly one field.",
        );
      }
      const store = requiredRecords();
      let record;
      if (operation.document !== undefined) {
        const current = await store.readBundleSources(operation.id, {
          operator: operator(principal),
        });
        if (!current.sources.some((source) => source.path === "CAPLET.md")) {
          throw new CapletsError(
            "INTERNAL_ERROR",
            "Stored Caplet bundle has no CAPLET.md document.",
          );
        }
        record = await store.updateBundleSources({
          id: operation.id,
          sources: current.sources.map((source) =>
            source.path === "CAPLET.md" ? documentSource(operation.document!) : source,
          ),
          expectedGeneration: operation.expectedGeneration,
          operator: operator(principal),
        });
      } else if (operation.newId !== undefined) {
        record = await store.rename({
          id: operation.id,
          newId: operation.newId,
          expectedGeneration: operation.expectedGeneration,
          operator: operator(principal),
        });
      } else {
        record = await store.setRetention({
          id: operation.id,
          historyLimit: operation.historyLimit!,
          expectedGeneration: operation.expectedGeneration,
          operator: operator(principal),
        });
      }
      await activate();
      return { kind: "stored_caplet_update", record };
    },
    bundleUpdate: async (
      principal: CurrentHostOperatorPrincipal,
      operation: BundleUpdateOperation,
    ): Promise<BundleUpdateOutcome> => {
      const record = await requiredRecords().updateBundleSources({
        id: operation.id,
        sources: [...operation.sources],
        expectedGeneration: operation.expectedGeneration,
        operator: operator(principal),
        ...(operation.historyLimit === undefined ? {} : { historyLimit: operation.historyLimit }),
        ...(operation.sourceRevision === undefined
          ? {}
          : { sourceRevision: operation.sourceRevision }),
        ...(operation.sourceContentHash === undefined
          ? {}
          : { sourceContentHash: operation.sourceContentHash }),
        ...(operation.installation === undefined ? {} : { installation: operation.installation }),
        ...(operation.detachInstallation === undefined
          ? {}
          : { detachInstallation: operation.detachInstallation }),
      });
      await activate();
      return { kind: "stored_caplet_bundle_update", record };
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
    revisionsPage: async (
      principal: CurrentHostOperatorPrincipal,
      operation: RevisionsPageOperation,
    ): Promise<RevisionsPageOutcome> => ({
      kind: "stored_caplet_revisions_page",
      page: await requiredRecords().listRevisionsPage(operation.id, operator(principal), {
        limit: operation.limit,
        sort: operation.sort,
        ...(operation.after === undefined ? {} : { after: operation.after }),
      }),
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

async function readRecordBundleSources(
  records: CapletRecordStore,
  id: string,
  principal: CurrentHostOperatorPrincipal,
  revisionKey: string | undefined,
): Promise<ReadCapletBundleSourcesResult> {
  try {
    return await records.readBundleSources(id, {
      operator: operator(principal),
      ...(revisionKey === undefined ? {} : { revisionKey }),
    });
  } catch (error) {
    if (error instanceof CapletsError && error.code === "CONFIG_NOT_FOUND") {
      throw new CapletsError("SERVER_NOT_FOUND", error.message);
    }
    throw error;
  }
}

function documentSource(document: string) {
  return bufferBundleFileSource({
    path: "CAPLET.md",
    content: Buffer.from(document),
    executable: false,
  });
}

async function readCapletDocument(sources: readonly ReopenableBundleFileSource[]): Promise<string> {
  const source = sources.find((candidate) => candidate.path === "CAPLET.md");
  if (!source) {
    throw new CapletsError("INTERNAL_ERROR", "Stored Caplet bundle has no CAPLET.md document.");
  }
  return (await readVerifiedBundleFile(source, { maxBytes: MAX_BUNDLE_FILE_BYTES })).toString(
    "utf8",
  );
}
