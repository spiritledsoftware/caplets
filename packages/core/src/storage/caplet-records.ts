import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import { and, asc, count, desc, eq, exists, gt, inArray, lt, or, sql } from "drizzle-orm";
import { stringify as stringifyYaml } from "yaml";
import { parseCapletFileDocument, type CapletFileFrontmatter } from "../caplet-files-bundle";
import { CapletsError } from "../errors";
import { advancePostgresConfigGeneration, advanceSqliteConfigGeneration } from "./coordination";
import type { AssetObjectStore } from "./asset-store";
import {
  bufferBundleFileSource,
  readVerifiedBundleFile,
  readVerifiedBundleFileIntoBuffer,
  writeVerifiedBundleFile,
  type ReopenableBundleFileSource,
} from "./bundle-source";
import { normalizeBundlePath, validateBundlePathSet } from "./bundle-path";
import {
  requireOperator,
  type CapletInstallationObservationStatus,
  type OperatorPrincipal,
} from "./installations";
import { storagePageLimit, type KeysetSortDirection, type StorageKeysetPage } from "./keyset-page";
import * as postgres from "./schema/postgres";
import * as sqlite from "./schema/sqlite";
import type {
  HostDatabase,
  HostDatabaseTransaction,
  PostgresHostDatabase,
  PostgresHostTransaction,
  SqliteHostDatabase,
  SqliteHostTransaction,
} from "./types";

export type CapletBundleInputFile = {
  path: string;
  content: Buffer;
  executable: boolean;
};
export type ReadCapletBundleResult = {
  record: CapletRecordView;
  files: CapletBundleInputFile[];
};
export type ReadCapletBundleSourcesResult = {
  record: CapletRecordView;
  sources: ReopenableBundleFileSource[];
};

export type UpdateCapletBundleInput = ImportCapletBundleInput & {
  expectedGeneration: number;
  detachInstallation?: boolean | undefined;
};
export type UpdateCapletBundleSourcesInput = Omit<UpdateCapletBundleInput, "files"> & {
  sources: ReopenableBundleFileSource[];
};

export type UpdateCapletFromSourceInput = {
  id: string;
  files: CapletBundleInputFile[];
  expectedGeneration: number;
  expectedInstallationGeneration: number;
  sourceRevision: string;
  sourceContentHash: string;
  observationStatus: Exclude<CapletInstallationObservationStatus, "source-unavailable">;
  risk?: Record<string, unknown> | null | undefined;
  operator: OperatorPrincipal;
};
type SourceUpdateMetadata = Omit<UpdateCapletFromSourceInput, "files">;
export type UpdateCapletFromBundleSourcesInput = SourceUpdateMetadata & {
  sources: ReopenableBundleFileSource[];
};

export type DeleteCapletRevisionInput = {
  id: string;
  revisionKey: string;
  expectedGeneration: number;
  operator: OperatorPrincipal;
};

export type RestoreCapletRevisionInput = DeleteCapletRevisionInput;

export type RenameCapletRecordInput = {
  id: string;
  newId: string;
  expectedGeneration: number;
  operator: OperatorPrincipal;
};

export type SetCapletRetentionInput = {
  id: string;
  historyLimit: number | null;
  expectedGeneration: number;
  operator: OperatorPrincipal;
};

export type HardDeleteCapletRecordInput = {
  id: string;
  expectedGeneration: number;
  operator: OperatorPrincipal;
};
export type ImportCapletBundleInput = {
  id: string;
  files: CapletBundleInputFile[];
  operator: OperatorPrincipal;
  historyLimit?: number | undefined;
  sourceRevision?: string | undefined;
  sourceContentHash?: string | undefined;
  installation?:
    | {
        sourceKind: string;
        sourceIdentity: string;
        channel?: string | undefined;
        risk?: Record<string, unknown> | null | undefined;
      }
    | undefined;
};
export type ImportCapletBundleSourcesInput = Omit<ImportCapletBundleInput, "files"> & {
  sources: ReopenableBundleFileSource[];
};

export type CapletBackendView = {
  family: string;
  childId: string | null;
  config: Record<string, unknown>;
};

export type CapletBundleEntryView = {
  path: string;
  hash: string;
  mediaType: string;
  size: number;
  executable: boolean;
};

export type CapletRevisionView = {
  revisionKey: string;
  sequence: number;
  name: string;
  description: string;
  body: string;
  schemaUrl: string | null;
  content: Record<string, unknown>;
  contentHash: string;
  sourceRevision: string | null;
  sourceContentHash: string | null;
  createdAt: string;
  actor: string;
  tags: string[];
  backends: CapletBackendView[];
  bundle: CapletBundleEntryView[];
};

export type CapletRecordView = {
  recordKey: string;
  id: string;
  headGeneration: number;
  historyLimit: number | null;
  createdAt: string;
  updatedAt: string;
  currentRevision: CapletRevisionView;
};
export type CapletRevisionSummaryView = Pick<
  CapletRevisionView,
  "revisionKey" | "sequence" | "name" | "createdAt"
>;
export type CapletRecordSummaryView = Omit<CapletRecordView, "currentRevision"> & {
  currentRevision: CapletRevisionSummaryView;
};
export type CapletRecordPageKey = Pick<CapletRecordView, "updatedAt" | "recordKey">;

export type CapletRecordPageOptions = {
  limit?: number | undefined;
  sort?: KeysetSortDirection | undefined;
  after?: CapletRecordPageKey | undefined;
  source?: string | undefined;
  status?: "active" | "detached" | undefined;
  tag?: string | undefined;
  search?: string | undefined;
};

export type CapletRevisionPageKey = Pick<CapletRevisionView, "createdAt" | "revisionKey">;

export type CapletRevisionPageOptions = {
  limit?: number | undefined;
  sort?: KeysetSortDirection | undefined;
  after?: CapletRevisionPageKey | undefined;
};

export type AssetGarbageCollectionResult = {
  blobRowsDeleted: number;
  objectsDeleted: number;
};

type PreparedBundle = {
  id: string;
  recordKey: string;
  revisionKey: string;
  now: string;
  actor: string;
  historyLimit: number | null;
  name: string;
  description: string;
  body: string;
  schemaUrl: string | null;
  content: Record<string, unknown>;
  contentHash: string;
  sourceRevision: string | null;
  sourceContentHash: string | null;
  installation:
    | {
        installationKey: string;
        sourceKind: string;
        sourceIdentity: string;
        channel: string | null;
        risk: Record<string, unknown> | null;
      }
    | undefined;
  tags: string[];
  backends: CapletBackendView[];
  entries: CapletBundleEntryView[];
  preparedBlobHashes: string[];
};

export const MAX_BUNDLE_FILES = 2_048;
export const MAX_BUNDLE_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_BUNDLE_TOTAL_BYTES = 256 * 1024 * 1024;

type BundleLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

type CapletRecordStoreOptions = {
  objectStore?: AssetObjectStore | undefined;
  limits?:
    | {
        maxFiles?: number | undefined;
        maxFileBytes?: number | undefined;
        maxTotalBytes?: number | undefined;
      }
    | undefined;
};

export class CapletRecordStore {
  private readonly objectStore: AssetObjectStore | undefined;
  private readonly limits: BundleLimits;

  constructor(
    private readonly database: HostDatabase,
    options: CapletRecordStoreOptions = {},
  ) {
    this.objectStore = options.objectStore;
    this.limits = {
      maxFiles: options.limits?.maxFiles ?? MAX_BUNDLE_FILES,
      maxFileBytes: options.limits?.maxFileBytes ?? MAX_BUNDLE_FILE_BYTES,
      maxTotalBytes: options.limits?.maxTotalBytes ?? MAX_BUNDLE_TOTAL_BYTES,
    };
  }

  async importBundle(input: ImportCapletBundleInput): Promise<CapletRecordView> {
    return await this.importBundleSources({
      ...input,
      sources: input.files.map(bufferBundleFileSource),
    });
  }

  async importBundleSources(input: ImportCapletBundleSourcesInput): Promise<CapletRecordView> {
    const [prepared] = await this.prepareBundlesFromSources([input]);
    try {
      if (this.database.dialect === "sqlite") {
        await importSqlite(this.database.db, prepared!);
      } else {
        await importPostgres(this.database.db, prepared!);
      }
      const result = await this.get(input.id);
      if (!result) {
        throw new CapletsError("INTERNAL_ERROR", `Imported Caplet ${input.id} was not found.`);
      }
      return result;
    } catch (error) {
      await this.cleanupPreparedBlobs([prepared!]);
      throw error;
    }
  }

  async importBundles(inputs: ImportCapletBundleInput[]): Promise<CapletRecordView[]> {
    return await this.importBundleSourcesBatch(
      inputs.map((input) => ({
        ...input,
        sources: input.files.map(bufferBundleFileSource),
      })),
    );
  }

  async importBundleSourcesBatch(
    inputs: ImportCapletBundleSourcesInput[],
  ): Promise<CapletRecordView[]> {
    const bundles = await this.prepareBundlesFromSources(inputs);
    try {
      if (this.database.dialect === "sqlite") {
        await importManySqlite(this.database.db, bundles);
      } else {
        await importManyPostgres(this.database.db, bundles);
      }
      const records = await Promise.all(inputs.map(async (input) => await this.get(input.id)));
      return records.map((record, index) => {
        if (!record) {
          throw new CapletsError(
            "INTERNAL_ERROR",
            `Imported Caplet ${inputs[index]!.id} was not found.`,
          );
        }
        return record;
      });
    } catch (error) {
      await this.cleanupPreparedBlobs(bundles);
      throw error;
    }
  }

  async prepareBundleAssetsForImport(inputs: ImportCapletBundleInput[]): Promise<void> {
    await this.prepareBundlesFromSources(
      inputs.map((input) => ({
        ...input,
        sources: input.files.map(bufferBundleFileSource),
      })),
    );
  }

  async importBundlesInTransaction(
    inputs: ImportCapletBundleInput[],
    transaction: HostDatabaseTransaction,
  ): Promise<void | Promise<void>> {
    for (const input of inputs) requireOperator(input.operator);
    const bundles = inputs.map((input) => prepareBufferedBundle(input, this.limits));
    if (bundles.length === 0) return;
    return transaction.dialect === "sqlite"
      ? await importManySqliteTransaction(transaction.db, bundles)
      : importManyPostgresTransaction(transaction.db, bundles);
  }

  async getInTransaction(
    id: string,
    transaction: HostDatabaseTransaction,
  ): Promise<CapletRecordView | undefined | Promise<CapletRecordView | undefined>> {
    return transaction.dialect === "sqlite"
      ? await getSqlite(transaction.db, id)
      : await getPostgres(transaction.db, id);
  }

  async get(id: string): Promise<CapletRecordView | undefined> {
    return this.database.dialect === "sqlite"
      ? await getSqlite(this.database.db, id)
      : await getPostgres(this.database.db, id);
  }

  async listRecordsPage(
    options: CapletRecordPageOptions = {},
  ): Promise<StorageKeysetPage<CapletRecordSummaryView, CapletRecordPageKey>> {
    const normalized = normalizeRecordPageOptions(options);
    return this.database.dialect === "sqlite"
      ? await listRecordsPageSqlite(this.database.db, normalized)
      : await listRecordsPagePostgres(this.database.db, normalized);
  }

  /** Compatibility API for callers that explicitly require every Caplet Record. */
  async list(): Promise<CapletRecordView[]> {
    const items: CapletRecordView[] = [];
    let after: CapletRecordPageKey | undefined;
    do {
      const page = await this.listRecordsPage({ after });
      const records = await Promise.all(page.items.map(async ({ id }) => await this.get(id)));
      items.push(...records.filter((record): record is CapletRecordView => record !== undefined));
      after = page.nextKey;
    } while (after);
    return items;
  }

  async collectAssetGarbage(input: {
    graceMs: number;
    now?: Date | undefined;
  }): Promise<AssetGarbageCollectionResult> {
    if (!Number.isFinite(input.graceMs) || input.graceMs < 0) {
      throw new CapletsError("REQUEST_INVALID", "Asset cleanup grace period must be non-negative.");
    }
    const cutoff = (input.now ?? new Date()).getTime() - input.graceMs;
    const blobs =
      this.database.dialect === "sqlite"
        ? await this.database.db.select().from(sqlite.capletAssetBlobs).all()
        : await this.database.db.select().from(postgres.capletAssetBlobs);
    const candidates = blobs.filter((blob) => Date.parse(blob.createdAt) <= cutoff);
    const deletedKeys: string[] = [];
    let blobRowsDeleted = 0;
    for (const candidate of candidates) {
      const objectKey =
        this.database.dialect === "sqlite"
          ? await deleteUnreferencedSqliteBlob(this.database.db, candidate.hash)
          : await deleteUnreferencedPostgresBlob(this.database.db, candidate.hash);
      if (objectKey === undefined) continue;
      blobRowsDeleted += 1;
      if (objectKey) deletedKeys.push(objectKey);
    }
    let objectsDeleted = 0;
    if (this.objectStore) {
      for (const key of deletedKeys) {
        await this.objectStore.delete(key);
        objectsDeleted += 1;
      }
      const remaining =
        this.database.dialect === "sqlite"
          ? await this.database.db
              .select({ objectKey: sqlite.capletAssetBlobs.objectKey })
              .from(sqlite.capletAssetBlobs)
              .all()
          : await this.database.db
              .select({ objectKey: postgres.capletAssetBlobs.objectKey })
              .from(postgres.capletAssetBlobs);
      const referencedKeys = new Set(
        remaining.flatMap((row) => (row.objectKey ? [row.objectKey] : [])),
      );
      for (const object of await this.objectStore.list()) {
        if (object.modifiedAt.getTime() > cutoff || referencedKeys.has(object.key)) continue;
        await this.objectStore.delete(object.key);
        objectsDeleted += 1;
      }
    }
    return { blobRowsDeleted, objectsDeleted };
  }
  async assetStats(): Promise<{ blobs: number; entries: number }> {
    if (this.database.dialect === "sqlite") {
      const blobs = await this.database.db
        .select({ count: count() })
        .from(sqlite.capletAssetBlobs)
        .get();
      const entries = await this.database.db
        .select({ count: count() })
        .from(sqlite.capletBundleEntries)
        .get();
      return { blobs: blobs?.count ?? 0, entries: entries?.count ?? 0 };
    }
    const [[blobs], [entries]] = await Promise.all([
      this.database.db.select({ count: count() }).from(postgres.capletAssetBlobs),
      this.database.db.select({ count: count() }).from(postgres.capletBundleEntries),
    ]);
    return { blobs: blobs?.count ?? 0, entries: entries?.count ?? 0 };
  }

  async currentAssetHealth(): Promise<{ ready: boolean; affectedRecordIds: string[] }> {
    if (!this.objectStore) return { ready: true, affectedRecordIds: [] };
    const references =
      this.database.dialect === "sqlite"
        ? await this.database.db
            .select({
              recordId: sqlite.capletRecords.capletId,
              entryHash: sqlite.capletBundleEntries.blobHash,
              entrySize: sqlite.capletBundleEntries.size,
              blobHash: sqlite.capletAssetBlobs.hash,
              blobSize: sqlite.capletAssetBlobs.size,
              payload: sqlite.capletAssetBlobs.payload,
              objectKey: sqlite.capletAssetBlobs.objectKey,
              verificationStatus: sqlite.capletAssetBlobs.verificationStatus,
            })
            .from(sqlite.capletRecords)
            .innerJoin(
              sqlite.capletBundleEntries,
              eq(sqlite.capletBundleEntries.revisionKey, sqlite.capletRecords.currentRevisionKey),
            )
            .leftJoin(
              sqlite.capletAssetBlobs,
              eq(sqlite.capletAssetBlobs.hash, sqlite.capletBundleEntries.blobHash),
            )
            .all()
        : await this.database.db
            .select({
              recordId: postgres.capletRecords.capletId,
              entryHash: postgres.capletBundleEntries.blobHash,
              entrySize: postgres.capletBundleEntries.size,
              blobHash: postgres.capletAssetBlobs.hash,
              blobSize: postgres.capletAssetBlobs.size,
              payload: postgres.capletAssetBlobs.payload,
              objectKey: postgres.capletAssetBlobs.objectKey,
              verificationStatus: postgres.capletAssetBlobs.verificationStatus,
            })
            .from(postgres.capletRecords)
            .innerJoin(
              postgres.capletBundleEntries,
              eq(
                postgres.capletBundleEntries.revisionKey,
                postgres.capletRecords.currentRevisionKey,
              ),
            )
            .leftJoin(
              postgres.capletAssetBlobs,
              eq(postgres.capletAssetBlobs.hash, postgres.capletBundleEntries.blobHash),
            );
    const checks = new Map<string, Promise<boolean>>();
    const affectedRecordIds = new Set<string>();
    await Promise.all(
      references.map(async (reference) => {
        if (
          reference.blobHash !== reference.entryHash ||
          reference.blobSize !== reference.entrySize ||
          reference.verificationStatus !== "verified"
        ) {
          affectedRecordIds.add(reference.recordId);
          return;
        }
        let check = checks.get(reference.entryHash);
        if (!check) {
          check = (async () => {
            try {
              if (reference.payload) {
                const payload = Buffer.from(reference.payload);
                return (
                  payload.byteLength === reference.entrySize &&
                  createHash("sha256").update(payload).digest("hex") === reference.entryHash
                );
              }
              if (!reference.objectKey) return false;
              await this.objectStore!.getVerified(reference.objectKey, {
                hash: reference.entryHash,
                size: reference.entrySize,
              });
              return true;
            } catch {
              return false;
            }
          })();
          checks.set(reference.entryHash, check);
        }
        if (!(await check)) affectedRecordIds.add(reference.recordId);
      }),
    );
    const ids = [...affectedRecordIds].sort();
    return { ready: ids.length === 0, affectedRecordIds: ids };
  }

  async updateBundle(input: UpdateCapletBundleInput): Promise<CapletRecordView> {
    return await this.updateBundleSources({
      ...input,
      sources: input.files.map(bufferBundleFileSource),
    });
  }

  async updateBundleSources(input: UpdateCapletBundleSourcesInput): Promise<CapletRecordView> {
    const [prepared] = await this.prepareBundlesFromSources([input]);
    try {
      if (this.database.dialect === "sqlite") {
        await updateSqlite(
          this.database.db,
          prepared!,
          input.expectedGeneration,
          input.detachInstallation === true,
        );
      } else {
        await updatePostgres(
          this.database.db,
          prepared!,
          input.expectedGeneration,
          input.detachInstallation === true,
        );
      }
      const result = await this.get(input.id);
      if (!result) {
        throw new CapletsError("INTERNAL_ERROR", `Updated Caplet ${input.id} was not found.`);
      }
      return result;
    } catch (error) {
      await this.cleanupPreparedBlobs([prepared!]);
      throw error;
    }
  }

  async updateFromSource(input: UpdateCapletFromSourceInput): Promise<CapletRecordView> {
    return await this.updateFromBundleSources({
      ...input,
      sources: input.files.map(bufferBundleFileSource),
    });
  }

  async updateFromBundleSources(
    input: UpdateCapletFromBundleSourcesInput,
  ): Promise<CapletRecordView> {
    requireOperator(input.operator);
    if (
      (input.observationStatus !== "current" && input.observationStatus !== "metadata-only") ||
      !input.sourceRevision.trim() ||
      !input.sourceContentHash.trim() ||
      (input.risk !== undefined &&
        input.risk !== null &&
        (typeof input.risk !== "object" || Array.isArray(input.risk)))
    ) {
      throw new CapletsError("REQUEST_INVALID", "Source update provenance is invalid.");
    }
    const [prepared] = await this.prepareBundlesFromSources([input]);
    try {
      if (this.database.dialect === "sqlite") {
        await updateFromSourceSqlite(this.database.db, prepared!, input);
      } else {
        await updateFromSourcePostgres(this.database.db, prepared!, input);
      }
      const result = await this.get(input.id);
      if (!result) {
        throw new CapletsError(
          "INTERNAL_ERROR",
          `Source-updated Caplet ${input.id} was not found.`,
        );
      }
      return result;
    } catch (error) {
      await this.cleanupPreparedBlobs([prepared!]);
      throw error;
    }
  }

  async getStored(id: string, operator: OperatorPrincipal): Promise<CapletRecordView | undefined> {
    const actor = requireOperator(operator);
    const record = await this.get(id);
    if (record) {
      await this.appendOperatorActivity(actor, "caplet.stored_get", record.recordKey, {
        capletId: id,
      });
    }
    return record;
  }

  async listStored(operator: OperatorPrincipal): Promise<CapletRecordView[]> {
    const actor = requireOperator(operator);
    const records = await this.list();
    await this.appendOperatorActivity(actor, "caplet.stored_list", "all", {
      count: records.length,
    });
    return records;
  }

  async listRevisionsPage(
    id: string,
    operator: OperatorPrincipal,
    options: CapletRevisionPageOptions = {},
  ): Promise<StorageKeysetPage<CapletRevisionSummaryView, CapletRevisionPageKey>> {
    const actor = requireOperator(operator);
    const normalized = normalizeRevisionPageOptions(options);
    const result =
      this.database.dialect === "sqlite"
        ? await listRevisionsPageSqlite(this.database.db, id, normalized)
        : await listRevisionsPagePostgres(this.database.db, id, normalized);
    if (result.recordKey === undefined) throw missingCapletRecord(id);
    await this.appendOperatorActivity(actor, "caplet.revisions_list", result.recordKey, {
      capletId: id,
      count: result.page.items.length,
    });
    return result.page;
  }

  /** Compatibility API for callers that explicitly require every revision summary. */
  async listRevisions(
    id: string,
    operator: OperatorPrincipal,
  ): Promise<Array<{ revisionKey: string; sequence: number; name: string }>> {
    const actor = requireOperator(operator);
    const revisions: CapletRevisionSummaryView[] = [];
    let after: CapletRevisionPageKey | undefined;
    let recordKey: string | undefined;
    do {
      const normalized = normalizeRevisionPageOptions({ after });
      const result =
        this.database.dialect === "sqlite"
          ? await listRevisionsPageSqlite(this.database.db, id, normalized)
          : await listRevisionsPagePostgres(this.database.db, id, normalized);
      recordKey = result.recordKey;
      revisions.push(...result.page.items);
      after = result.page.nextKey;
    } while (after);
    if (recordKey === undefined) throw missingCapletRecord(id);
    await this.appendOperatorActivity(actor, "caplet.revisions_list", recordKey, {
      capletId: id,
      count: revisions.length,
    });
    return revisions.map(({ revisionKey, sequence, name }) => ({ revisionKey, sequence, name }));
  }

  async deleteRevision(input: DeleteCapletRevisionInput): Promise<CapletRecordView | undefined> {
    requireOperator(input.operator);
    if (this.database.dialect === "sqlite") {
      await deleteRevisionSqlite(this.database.db, input);
    } else {
      await deleteRevisionPostgres(this.database.db, input);
    }
    return await this.get(input.id);
  }

  async restoreRevision(input: RestoreCapletRevisionInput): Promise<CapletRecordView> {
    requireOperator(input.operator);
    if (this.database.dialect === "sqlite") {
      await restoreRevisionSqlite(this.database.db, input);
    } else {
      await restoreRevisionPostgres(this.database.db, input);
    }
    const restored = await this.get(input.id);
    if (!restored)
      throw new CapletsError("INTERNAL_ERROR", `Restored Caplet ${input.id} was not found.`);
    return restored;
  }

  async rename(input: RenameCapletRecordInput): Promise<CapletRecordView> {
    requireOperator(input.operator);
    validateCapletRecordId(input.newId);
    if (this.database.dialect === "sqlite") await renameSqlite(this.database.db, input);
    else await renamePostgres(this.database.db, input);
    const record = await this.get(input.newId);
    if (!record)
      throw new CapletsError("INTERNAL_ERROR", `Renamed Caplet ${input.newId} was not found.`);
    return record;
  }

  async setRetention(input: SetCapletRetentionInput): Promise<CapletRecordView> {
    requireOperator(input.operator);
    validateHistoryLimit(input.historyLimit);
    if (this.database.dialect === "sqlite") await setRetentionSqlite(this.database.db, input);
    else await setRetentionPostgres(this.database.db, input);
    const record = await this.get(input.id);
    if (!record) throw new CapletsError("INTERNAL_ERROR", `Caplet ${input.id} was not found.`);
    return record;
  }

  async hardDelete(input: HardDeleteCapletRecordInput): Promise<void> {
    requireOperator(input.operator);
    if (this.database.dialect === "sqlite") await hardDeleteSqlite(this.database.db, input);
    else await hardDeletePostgres(this.database.db, input);
  }

  async readBundle(
    id: string,
    options: {
      operator: OperatorPrincipal;
      revisionKey?: string | undefined;
    },
  ): Promise<ReadCapletBundleResult> {
    const streamed = await this.readBundleSources(id, options);
    const files: CapletBundleInputFile[] = [];
    for (const source of streamed.sources) {
      files.push({
        path: source.path,
        content: await readVerifiedBundleFile(source, { maxBytes: this.limits.maxFileBytes }),
        executable: source.executable,
      });
    }
    return { record: streamed.record, files };
  }

  async readBundleSources(
    id: string,
    options: {
      operator: OperatorPrincipal;
      revisionKey?: string | undefined;
    },
  ): Promise<ReadCapletBundleSourcesResult> {
    const actor = requireOperator(options.operator);
    const result = await this.resolveBundleSources(id, options.revisionKey);
    await this.appendOperatorActivity(actor, "caplet.bundle_read", result.record.recordKey, {
      capletId: id,
      revisionKey: result.record.currentRevision.revisionKey,
    });
    return result;
  }

  async exportBundle(
    id: string,
    destination: string,
    options: {
      operator: OperatorPrincipal;
      replace?: boolean | undefined;
      revisionKey?: string | undefined;
    },
  ): Promise<void> {
    const actor = requireOperator(options.operator);
    await this.materializeRuntimeBundle(id, destination, options);
    const record = await this.get(id);
    if (record) {
      await this.appendOperatorActivity(actor, "caplet.export", record.recordKey, {
        capletId: id,
        revisionKey: options.revisionKey ?? record.currentRevision.revisionKey,
      });
    }
  }

  async materializeRuntimeBundle(
    id: string,
    destination: string,
    options: { replace?: boolean | undefined; revisionKey?: string | undefined } = {},
  ): Promise<void> {
    if (existsSync(destination) && !options.replace) {
      throw new CapletsError(
        "REQUEST_INVALID",
        `Export destination ${destination} already exists.`,
      );
    }
    const bundle = await this.resolveBundleSources(id, options.revisionKey);
    await materializeCapletBundleSources(bundle.sources, destination, {
      ...options,
      maxFileBytes: this.limits.maxFileBytes,
    });
  }

  private async appendOperatorActivity(
    operatorClientId: string,
    action: string,
    targetKey: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await appendOperatorActivity(this.database, {
      operatorClientId,
      action,
      targetKind: "caplet_record",
      targetKey,
      metadata,
    });
  }

  private async prepareBundlesFromSources(
    inputs: ImportCapletBundleSourcesInput[],
  ): Promise<PreparedBundle[]> {
    for (const input of inputs) requireOperator(input.operator);
    const validated = inputs.map((input) => validateBundleSources(input, this.limits));
    const sqliteAssetWriter =
      this.database.dialect === "sqlite" && !this.objectStore
        ? createSqliteAssetBlobWriter(this.database.db, validated)
        : undefined;
    const bundles: PreparedBundle[] = [];
    const pendingHashes: string[] = [];
    try {
      for (const candidate of validated) {
        const preparedHashes: string[] = [];
        const bundle = await prepareBundleFromSources(
          candidate,
          preparedHashes,
          async (source, now) => {
            if (await this.prepareAssetSource(source, now, sqliteAssetWriter)) {
              preparedHashes.push(source.sha256);
              pendingHashes.push(source.sha256);
            }
          },
        );
        bundles.push(bundle);
      }
      return bundles;
    } catch (error) {
      await this.cleanupBlobHashes(pendingHashes);
      throw error;
    }
  }

  private async prepareAssetSource(
    source: ReopenableBundleFileSource,
    createdAt: string,
    sqliteAssetWriter: SqliteAssetBlobWriter | undefined,
  ): Promise<boolean> {
    const existing = await this.assetMetadata(source.sha256);
    if (existing) {
      validateStoredAssetMetadata(existing, source);
      await verifyBundleSource(source);
      return false;
    }

    let objectKey: string | null = null;
    try {
      let inserted: boolean;
      if (sqliteAssetWriter) {
        inserted = await sqliteAssetWriter.insert(source, createdAt);
      } else {
        let payload: Buffer | null = null;
        if (this.objectStore) {
          objectKey = await this.objectStore.putVerifiedStream(
            source.sha256,
            source.size,
            source.open(),
          );
        } else {
          payload = await readVerifiedBundleFile(source, { maxBytes: this.limits.maxFileBytes });
        }
        const values = {
          hash: source.sha256,
          size: source.size,
          payload,
          objectKey,
          verificationStatus: "verified" as const,
          createdAt,
        };
        if (this.database.dialect === "sqlite") {
          inserted =
            (
              await this.database.db
                .insert(sqlite.capletAssetBlobs)
                .values(values)
                .onConflictDoNothing()
                .run()
            ).rowsAffected === 1;
        } else {
          inserted =
            (
              await this.database.db
                .insert(postgres.capletAssetBlobs)
                .values(values)
                .onConflictDoNothing()
                .returning({ hash: postgres.capletAssetBlobs.hash })
            ).length === 1;
        }
      }
      if (inserted) return true;
      if (objectKey && this.objectStore) {
        await this.objectStore.delete(objectKey).catch(() => undefined);
        objectKey = null;
      }
      const winner = await this.assetMetadata(source.sha256);
      if (!winner) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          `Caplet asset ${source.sha256} changed during import; retry the operation.`,
        );
      }
      validateStoredAssetMetadata(winner, source);
      return false;
    } catch (error) {
      if (objectKey && this.objectStore) {
        await this.objectStore.delete(objectKey).catch(() => undefined);
      }
      throw error;
    }
  }

  private async assetMetadata(hash: string): Promise<StoredAssetMetadata | undefined> {
    if (this.database.dialect === "sqlite") {
      return await this.database.db
        .select({
          hash: sqlite.capletAssetBlobs.hash,
          size: sqlite.capletAssetBlobs.size,
          objectKey: sqlite.capletAssetBlobs.objectKey,
          verificationStatus: sqlite.capletAssetBlobs.verificationStatus,
        })
        .from(sqlite.capletAssetBlobs)
        .where(eq(sqlite.capletAssetBlobs.hash, hash))
        .get();
    }
    const [row] = await this.database.db
      .select({
        hash: postgres.capletAssetBlobs.hash,
        size: postgres.capletAssetBlobs.size,
        objectKey: postgres.capletAssetBlobs.objectKey,
        verificationStatus: postgres.capletAssetBlobs.verificationStatus,
      })
      .from(postgres.capletAssetBlobs)
      .where(eq(postgres.capletAssetBlobs.hash, hash))
      .limit(1);
    return row;
  }

  private async cleanupPreparedBlobs(bundles: PreparedBundle[]): Promise<void> {
    await this.cleanupBlobHashes(bundles.flatMap((bundle) => bundle.preparedBlobHashes));
  }

  private async cleanupBlobHashes(hashes: string[]): Promise<void> {
    for (const hash of new Set(hashes)) {
      const objectKey =
        this.database.dialect === "sqlite"
          ? await deleteUnreferencedSqliteBlob(this.database.db, hash)
          : await deleteUnreferencedPostgresBlob(this.database.db, hash);
      if (objectKey && this.objectStore) {
        await this.objectStore.delete(objectKey).catch(() => undefined);
      }
    }
  }

  private async resolveBundleSources(
    id: string,
    revisionKey: string | undefined,
  ): Promise<ReadCapletBundleSourcesResult> {
    let record = await this.get(id);
    if (!record) throw new CapletsError("CONFIG_NOT_FOUND", `Caplet Record ${id} was not found.`);
    if (revisionKey) {
      const revision = await getRevisionByKey(this.database, record.recordKey, revisionKey);
      if (!revision) {
        throw new CapletsError("CONFIG_NOT_FOUND", `Caplet Revision ${revisionKey} was not found.`);
      }
      record = { ...record, currentRevision: revision };
    }
    const document = bufferBundleFileSource({
      path: "CAPLET.md",
      content: Buffer.from(renderCapletDocument(record.currentRevision)),
      executable: false,
    });
    const sources = [
      document,
      ...record.currentRevision.bundle.map(
        (entry): ReopenableBundleFileSource => ({
          path: entry.path,
          size: entry.size,
          sha256: entry.hash,
          executable: entry.executable,
          open: () => deferredReadableStream(async () => await this.storedAssetStream(entry)),
        }),
      ),
    ];
    return { record, sources };
  }

  private async storedAssetStream(
    expected: CapletBundleEntryView,
  ): Promise<ReadableStream<Uint8Array>> {
    const row =
      this.database.dialect === "sqlite"
        ? await this.database.db
            .select()
            .from(sqlite.capletAssetBlobs)
            .where(eq(sqlite.capletAssetBlobs.hash, expected.hash))
            .get()
        : (
            await this.database.db
              .select()
              .from(postgres.capletAssetBlobs)
              .where(eq(postgres.capletAssetBlobs.hash, expected.hash))
              .limit(1)
          )[0];
    if (!row) {
      throw new CapletsError("INTERNAL_ERROR", `Caplet asset ${expected.hash} is missing.`);
    }
    validateStoredAssetMetadata(row, {
      size: expected.size,
      sha256: expected.hash,
    });
    if (row.payload) {
      const payload = Buffer.from(row.payload);
      return verifiedAssetStream(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength),
            );
            controller.close();
          },
        }),
        expected,
      );
    }
    if (row.objectKey && this.objectStore) {
      return await this.objectStore.getVerifiedStream(row.objectKey, {
        hash: expected.hash,
        size: expected.size,
      });
    }
    throw new CapletsError("SERVER_UNAVAILABLE", `Caplet asset ${expected.hash} is unavailable.`);
  }
}

async function materializeCapletBundleSources(
  sources: ReopenableBundleFileSource[],
  destination: string,
  options: { maxFileBytes: number; replace?: boolean | undefined },
): Promise<void> {
  if (existsSync(destination) && !options.replace) {
    throw new CapletsError("REQUEST_INVALID", `Export destination ${destination} already exists.`);
  }
  const normalizedPaths = validateBundlePathSet(sources.map((source) => source.path));
  if (!normalizedPaths.includes("CAPLET.md")) {
    throw new CapletsError("REQUEST_INVALID", "Caplet bundle must contain CAPLET.md.");
  }

  const parent = dirname(destination);
  const staging = join(parent, `.${basename(destination)}.tmp-${randomUUID()}`);
  const backup = join(parent, `.${basename(destination)}.backup-${randomUUID()}`);
  mkdirSync(parent, { recursive: true });
  try {
    mkdirSync(staging, { mode: 0o700 });
    for (let index = 0; index < sources.length; index += 1) {
      const source = sources[index]!;
      const path = join(staging, ...normalizedPaths[index]!.split("/"));
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      await writeVerifiedBundleFile(source, {
        destination: path,
        maxBytes: options.maxFileBytes,
      });
      if (source.executable) chmodSync(path, 0o700);
    }
    if (existsSync(destination)) renameSync(destination, backup);
    renameSync(staging, destination);
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (!existsSync(destination) && existsSync(backup)) renameSync(backup, destination);
    throw error;
  }
}

export function materializeCapletBundleFiles(
  files: CapletBundleInputFile[],
  destination: string,
  options: { replace?: boolean | undefined } = {},
): void {
  if (existsSync(destination) && !options.replace) {
    throw new CapletsError("REQUEST_INVALID", `Export destination ${destination} already exists.`);
  }
  for (const file of files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !Buffer.isBuffer(file.content) ||
      typeof file.executable !== "boolean"
    ) {
      throw new CapletsError("REQUEST_INVALID", "Caplet bundle contains a malformed file.");
    }
  }
  const normalizedPaths = validateBundlePathSet(files.map((file) => file.path));
  const normalizedFiles = files.map((file, index) => ({
    ...file,
    path: normalizedPaths[index]!,
  }));
  if (!normalizedPaths.includes("CAPLET.md")) {
    throw new CapletsError("REQUEST_INVALID", "Caplet bundle must contain CAPLET.md.");
  }

  const parent = dirname(destination);
  const staging = join(parent, `.${basename(destination)}.tmp-${randomUUID()}`);
  const backup = join(parent, `.${basename(destination)}.backup-${randomUUID()}`);
  mkdirSync(parent, { recursive: true });
  try {
    mkdirSync(staging, { mode: 0o700 });
    for (const file of normalizedFiles) {
      const path = join(staging, ...file.path.split("/"));
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, file.content, { mode: file.executable ? 0o700 : 0o600 });
      if (file.executable) chmodSync(path, 0o700);
    }
    if (existsSync(destination)) renameSync(destination, backup);
    renameSync(staging, destination);
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (!existsSync(destination) && existsSync(backup)) renameSync(backup, destination);
    throw error;
  }
}

type ValidatedBundleSources = {
  input: ImportCapletBundleSourcesInput;
  document: ReopenableBundleFileSource;
  assets: ReopenableBundleFileSource[];
};

type SqliteAssetBlobWriter = {
  insert(source: ReopenableBundleFileSource, createdAt: string): Promise<boolean>;
};

function createSqliteAssetBlobWriter(
  database: SqliteHostDatabase,
  bundles: ValidatedBundleSources[],
): SqliteAssetBlobWriter {
  const insert = (hash: string, size: number, payload: Buffer, createdAt: string) =>
    database
      .insert(sqlite.capletAssetBlobs)
      .values({
        hash,
        size,
        payload,
        objectKey: null,
        verificationStatus: "verified",
        createdAt,
      })
      .onConflictDoNothing()
      .run();

  let maxAssetBytes = 0;
  for (const bundle of bundles) {
    for (const asset of bundle.assets) {
      maxAssetBytes = Math.max(maxAssetBytes, asset.size);
    }
  }
  const target = Buffer.allocUnsafe(maxAssetBytes);

  return {
    async insert(source, createdAt) {
      const payload = await readVerifiedBundleFileIntoBuffer(source, {
        maxBytes: target.byteLength,
        target,
      });
      return (await insert(source.sha256, source.size, payload, createdAt)).rowsAffected === 1;
    },
  };
}

type StoredAssetMetadata = {
  hash: string;
  size: number;
  objectKey: string | null;
  verificationStatus: string;
};

function validateBundleSources(
  input: ImportCapletBundleSourcesInput,
  limits: BundleLimits,
): ValidatedBundleSources {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(input.id)) {
    throw new CapletsError("CONFIG_INVALID", `Invalid Caplet ID ${input.id}.`);
  }
  if (
    input.historyLimit !== undefined &&
    (!Number.isInteger(input.historyLimit) || input.historyLimit < 0)
  ) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Caplet history limit must be a non-negative integer.",
    );
  }
  if (
    input.installation?.risk !== undefined &&
    input.installation.risk !== null &&
    (typeof input.installation.risk !== "object" || Array.isArray(input.installation.risk))
  ) {
    throw new CapletsError("REQUEST_INVALID", "Caplet installation risk provenance is invalid.");
  }
  if (!Array.isArray(input.sources)) {
    throw new CapletsError("REQUEST_INVALID", "Caplet Bundle sources are invalid.");
  }
  for (const source of input.sources) {
    if (
      !source ||
      typeof source.path !== "string" ||
      !Number.isSafeInteger(source.size) ||
      source.size < 0 ||
      !/^[a-f0-9]{64}$/u.test(source.sha256) ||
      typeof source.executable !== "boolean" ||
      typeof source.open !== "function"
    ) {
      throw new CapletsError("REQUEST_INVALID", "Caplet Bundle file metadata is invalid.");
    }
  }
  const paths = validateBundlePathSet(input.sources.map((source) => source.path));
  let document: ReopenableBundleFileSource | undefined;
  const assets: ReopenableBundleFileSource[] = [];
  let totalBytes = 0;
  for (let index = 0; index < input.sources.length; index += 1) {
    const original = input.sources[index]!;
    const source: ReopenableBundleFileSource = {
      path: paths[index]!,
      size: original.size,
      sha256: original.sha256,
      executable: original.executable,
      open: () => original.open(),
    };
    if (source.size > limits.maxFileBytes) {
      throw new CapletsError(
        "REQUEST_INVALID",
        `Caplet bundle file ${source.path} exceeds the ${limits.maxFileBytes} byte limit.`,
      );
    }
    if (source.path === "CAPLET.md") {
      document = source;
    } else {
      assets.push(source);
      totalBytes += source.size;
      if (totalBytes > limits.maxTotalBytes) {
        throw new CapletsError(
          "REQUEST_INVALID",
          `Caplet bundle exceeds the ${limits.maxTotalBytes} auxiliary byte limit.`,
        );
      }
    }
  }
  if (assets.length > limits.maxFiles) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Caplet bundle exceeds the ${limits.maxFiles} auxiliary file limit.`,
    );
  }
  if (!document) throw new CapletsError("CONFIG_INVALID", "Caplet bundle must contain CAPLET.md.");
  return { input, document, assets };
}

async function prepareBundleFromSources(
  candidate: ValidatedBundleSources,
  preparedBlobHashes: string[],
  prepareAsset: (source: ReopenableBundleFileSource, now: string) => Promise<void>,
): Promise<PreparedBundle> {
  const document = await readVerifiedBundleFile(candidate.document, {
    maxBytes: candidate.document.size,
  });
  const assets = candidate.assets.sort((left, right) => left.path.localeCompare(right.path));
  const now = new Date().toISOString();
  for (const source of assets) await prepareAsset(source, now);
  return buildPreparedBundle(candidate.input, document, assets, preparedBlobHashes, now);
}

function prepareBufferedBundle(
  input: ImportCapletBundleInput,
  limits: BundleLimits,
): PreparedBundle {
  const candidate = validateBundleSources(
    { ...input, sources: input.files.map(bufferBundleFileSource) },
    limits,
  );
  const documentFile = input.files.find(
    (file) => normalizeBundlePath(file.path) === candidate.document.path,
  );
  if (!documentFile) {
    throw new CapletsError("CONFIG_INVALID", "Caplet bundle must contain CAPLET.md.");
  }
  return buildPreparedBundle(
    candidate.input,
    documentFile.content,
    candidate.assets.sort((left, right) => left.path.localeCompare(right.path)),
    [],
    new Date().toISOString(),
  );
}

function buildPreparedBundle(
  input: ImportCapletBundleSourcesInput,
  document: Buffer,
  assets: ReopenableBundleFileSource[],
  preparedBlobHashes: string[],
  now: string,
): PreparedBundle {
  const { frontmatter, body } = parseCapletFileDocument("CAPLET.md", document.toString("utf8"));
  const projected = projectFrontmatter(frontmatter);
  const entries = assets.map((source) => ({
    path: source.path,
    hash: source.sha256,
    mediaType: mediaTypeForPath(source.path),
    size: source.size,
    executable: source.executable,
  }));
  const contentHash = createHash("sha256")
    .update(
      JSON.stringify({
        frontmatter,
        body,
        entries,
      }),
    )
    .digest("hex");
  return {
    id: input.id,
    recordKey: randomUUID(),
    revisionKey: randomUUID(),
    now,
    actor: requireOperator(input.operator),
    historyLimit: input.historyLimit ?? null,
    name: frontmatter.name,
    description: frontmatter.description,
    body,
    schemaUrl: frontmatter.$schema ?? null,
    content: projected.content,
    contentHash,
    sourceRevision: input.sourceRevision ?? null,
    sourceContentHash: input.sourceContentHash ?? null,
    installation: input.installation
      ? {
          installationKey: randomUUID(),
          sourceKind: input.installation.sourceKind,
          sourceIdentity: input.installation.sourceIdentity,
          channel: input.installation.channel ?? null,
          risk: input.installation.risk ?? null,
        }
      : undefined,
    tags: frontmatter.tags ?? [],
    backends: projected.backends,
    entries,
    preparedBlobHashes,
  };
}

function validateStoredAssetMetadata(
  row: StoredAssetMetadata,
  source: Pick<ReopenableBundleFileSource, "sha256" | "size">,
): void {
  if (
    row.hash !== source.sha256 ||
    row.size !== source.size ||
    row.verificationStatus !== "verified"
  ) {
    throw new CapletsError(
      "INTERNAL_ERROR",
      `Caplet asset ${source.sha256} has invalid stored metadata.`,
    );
  }
}

async function verifyBundleSource(source: ReopenableBundleFileSource): Promise<void> {
  const reader = source.open().getReader();
  const hash = createHash("sha256");
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        complete = true;
        break;
      }
      if (!(chunk.value instanceof Uint8Array)) throw invalidBundleSourcePayload();
      size += chunk.value.byteLength;
      if (size > source.size) throw invalidBundleSourcePayload();
      hash.update(chunk.value);
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (size !== source.size || hash.digest("hex") !== source.sha256) {
    throw invalidBundleSourcePayload();
  }
}

function verifiedAssetStream(
  stream: ReadableStream<Uint8Array>,
  expected: Pick<CapletBundleEntryView, "hash" | "size">,
): ReadableStream<Uint8Array> {
  const hash = createHash("sha256");
  let size = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!(chunk instanceof Uint8Array)) {
          throw new CapletsError("INTERNAL_ERROR", "A stored Caplet asset is malformed.");
        }
        size += chunk.byteLength;
        if (size > expected.size) {
          throw new CapletsError(
            "INTERNAL_ERROR",
            `Caplet asset ${expected.hash} failed integrity verification.`,
          );
        }
        hash.update(chunk);
        controller.enqueue(chunk);
      },
      flush() {
        if (size !== expected.size || hash.digest("hex") !== expected.hash) {
          throw new CapletsError(
            "INTERNAL_ERROR",
            `Caplet asset ${expected.hash} failed integrity verification.`,
          );
        }
      },
    }),
  );
}

function deferredReadableStream(
  load: () => Promise<ReadableStream<Uint8Array>>,
): ReadableStream<Uint8Array> {
  let readerPromise: Promise<ReadableStreamDefaultReader<Uint8Array>> | undefined;
  let cancelled = false;
  let cancellationReason: unknown;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        readerPromise ??= load().then((stream) => stream.getReader());
        const activeReader = await readerPromise;
        if (cancelled) {
          await activeReader.cancel(cancellationReason).catch(() => undefined);
          activeReader.releaseLock();
          return;
        }
        const chunk = await activeReader.read();
        if (chunk.done) {
          activeReader.releaseLock();
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        if (!cancelled) controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      cancellationReason = reason;
      if (readerPromise) {
        const activeReader = await readerPromise.catch(() => undefined);
        await activeReader?.cancel(reason).catch(() => undefined);
        activeReader?.releaseLock();
      }
    },
  });
}

function invalidBundleSourcePayload(): CapletsError {
  return new CapletsError(
    "REQUEST_INVALID",
    "A Caplet Bundle file does not match its declared size or hash.",
  );
}

function projectFrontmatter(frontmatter: CapletFileFrontmatter): {
  content: Record<string, unknown>;
  backends: CapletBackendView[];
} {
  const contentKeys = [
    "exposure",
    "shadowing",
    "setup",
    "projectBinding",
    "runtime",
    "auth",
    "catalog",
  ] as const;
  const content = Object.fromEntries(
    contentKeys.flatMap((key) => (frontmatter[key] === undefined ? [] : [[key, frontmatter[key]]])),
  );
  const backends: CapletBackendView[] = [];
  const singular = [
    ["mcpServer", frontmatter.mcpServer],
    ["openapiEndpoint", frontmatter.openapiEndpoint],
    ["googleDiscoveryApi", frontmatter.googleDiscoveryApi],
    ["graphqlEndpoint", frontmatter.graphqlEndpoint],
    ["httpApi", frontmatter.httpApi],
    ["capletSet", frontmatter.capletSet],
  ] as const;
  for (const [family, config] of singular) {
    if (config) backends.push({ family, childId: null, config });
  }
  if (frontmatter.cliTools && Object.hasOwn(frontmatter.cliTools, "actions")) {
    backends.push({ family: "cliTools", childId: null, config: frontmatter.cliTools });
  }
  const plural = [
    ["mcpServers", frontmatter.mcpServers],
    ["openapiEndpoints", frontmatter.openapiEndpoints],
    ["googleDiscoveryApis", frontmatter.googleDiscoveryApis],
    ["graphqlEndpoints", frontmatter.graphqlEndpoints],
    ["httpApis", frontmatter.httpApis],
    ["capletSets", frontmatter.capletSets],
    [
      "cliTools",
      frontmatter.cliTools && !Object.hasOwn(frontmatter.cliTools, "actions")
        ? (frontmatter.cliTools as Record<string, Record<string, unknown>>)
        : undefined,
    ],
  ] as const;
  for (const [family, configurations] of plural) {
    for (const [childId, config] of Object.entries(configurations ?? {})) {
      backends.push({ family, childId, config });
    }
  }
  return { content, backends };
}

async function importSqlite(db: SqliteHostDatabase, bundle: PreparedBundle): Promise<void> {
  await importManySqlite(db, [bundle]);
}

async function importManySqlite(db: SqliteHostDatabase, bundles: PreparedBundle[]): Promise<void> {
  await db.transaction(
    async (transaction) => await importManySqliteTransaction(transaction, bundles),
  );
}

async function importManySqliteTransaction(
  transaction: SqliteHostTransaction,
  bundles: PreparedBundle[],
): Promise<void> {
  for (const bundle of bundles) {
    const inserted = await transaction
      .insert(sqlite.capletRecords)
      .values(recordValues(bundle))
      .onConflictDoNothing()
      .run();
    if (inserted.rowsAffected !== 1) {
      throw new CapletsError("CONFIG_EXISTS", `Caplet Record ${bundle.id} already exists.`);
    }
    await transaction.insert(sqlite.capletRevisions).values(revisionValues(bundle)).run();
    if (bundle.tags.length > 0) {
      await transaction.insert(sqlite.capletRevisionTags).values(tagValues(bundle)).run();
    }
    if (bundle.backends.length > 0) {
      await transaction.insert(sqlite.capletRevisionBackends).values(backendValues(bundle)).run();
    }
    for (const entry of bundle.entries) {
      await ensureSqliteBlob(transaction, bundle, entry);
      await transaction.insert(sqlite.capletBundleEntries).values(entryValues(bundle, entry)).run();
    }
    await transaction
      .update(sqlite.capletRecords)
      .set({ currentRevisionKey: bundle.revisionKey })
      .where(eq(sqlite.capletRecords.recordKey, bundle.recordKey))
      .run();
    await insertSqliteInstallation(transaction, bundle);
    await transaction
      .insert(sqlite.operatorActivity)
      .values(recordActivityValues(bundle, "caplet.import"))
      .run();
  }
  const generationHash = createHash("sha256")
    .update(bundles.map((bundle) => bundle.contentHash).join("\0"))
    .digest("hex");
  await advanceSqliteConfigGeneration(transaction, generationHash, bundles[0]!.actor);
}

async function importPostgres(db: PostgresHostDatabase, bundle: PreparedBundle): Promise<void> {
  await importManyPostgres(db, [bundle]);
}

async function importManyPostgres(
  db: PostgresHostDatabase,
  bundles: PreparedBundle[],
): Promise<void> {
  await db.transaction(
    async (transaction) => await importManyPostgresTransaction(transaction, bundles),
  );
}

async function importManyPostgresTransaction(
  transaction: PostgresHostTransaction,
  bundles: PreparedBundle[],
): Promise<void> {
  for (const bundle of bundles) {
    const inserted = await transaction
      .insert(postgres.capletRecords)
      .values(recordValues(bundle))
      .onConflictDoNothing()
      .returning({ recordKey: postgres.capletRecords.recordKey });
    if (inserted.length !== 1) {
      throw new CapletsError("CONFIG_EXISTS", `Caplet Record ${bundle.id} already exists.`);
    }
    await transaction.insert(postgres.capletRevisions).values(revisionValues(bundle));
    if (bundle.tags.length > 0) {
      await transaction.insert(postgres.capletRevisionTags).values(tagValues(bundle));
    }
    if (bundle.backends.length > 0) {
      await transaction.insert(postgres.capletRevisionBackends).values(backendValues(bundle));
    }
    for (const entry of bundle.entries) {
      await ensurePostgresBlob(transaction, bundle, entry);
      await transaction.insert(postgres.capletBundleEntries).values(entryValues(bundle, entry));
    }
    await transaction
      .update(postgres.capletRecords)
      .set({ currentRevisionKey: bundle.revisionKey })
      .where(eq(postgres.capletRecords.recordKey, bundle.recordKey));
    await insertPostgresInstallation(transaction, bundle);
    await transaction
      .insert(postgres.operatorActivity)
      .values(recordActivityValues(bundle, "caplet.import"));
  }
  const generationHash = createHash("sha256")
    .update(bundles.map((bundle) => bundle.contentHash).join("\0"))
    .digest("hex");
  await advancePostgresConfigGeneration(transaction, generationHash, bundles[0]!.actor);
}

async function updateSqlite(
  db: SqliteHostDatabase,
  bundle: PreparedBundle,
  expectedGeneration: number,
  detachInstallation: boolean,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const record = await transaction
      .select()
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.capletId, bundle.id))
      .get();
    if (!record)
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${bundle.id} was not found.`);
    if (record.headGeneration !== expectedGeneration) {
      throw staleGeneration(bundle.id, expectedGeneration, record.headGeneration);
    }
    const activeInstallation = await transaction
      .select()
      .from(sqlite.capletInstallations)
      .where(
        and(
          eq(sqlite.capletInstallations.recordKey, record.recordKey),
          eq(sqlite.capletInstallations.status, "active"),
        ),
      )
      .get();
    if (activeInstallation && !detachInstallation) throw trackedInstallation(bundle.id);
    if (activeInstallation) {
      await transaction
        .update(sqlite.capletInstallations)
        .set({
          status: "detached",
          generation: activeInstallation.generation + 1,
          detachedAt: bundle.now,
          detachedBy: bundle.actor,
          updatedAt: bundle.now,
        })
        .where(eq(sqlite.capletInstallations.installationKey, activeInstallation.installationKey))
        .run();
      await transaction
        .insert(sqlite.operatorActivity)
        .values({
          activityKey: randomUUID(),
          operatorClientId: bundle.actor,
          action: "caplet.detach_for_overwrite",
          targetKind: "installation",
          targetKey: activeInstallation.installationKey,
          outcome: "succeeded",
          metadata: { capletId: bundle.id },
          createdAt: bundle.now,
        })
        .run();
    }
    const sequence = record.headGeneration + 1;
    bundle.recordKey = record.recordKey;
    await transaction.insert(sqlite.capletRevisions).values(revisionValues(bundle, sequence)).run();
    if (bundle.tags.length > 0) {
      await transaction.insert(sqlite.capletRevisionTags).values(tagValues(bundle)).run();
    }
    if (bundle.backends.length > 0) {
      await transaction.insert(sqlite.capletRevisionBackends).values(backendValues(bundle)).run();
    }
    for (const entry of bundle.entries) {
      await ensureSqliteBlob(transaction, bundle, entry);
      await transaction.insert(sqlite.capletBundleEntries).values(entryValues(bundle, entry)).run();
    }
    await transaction
      .update(sqlite.capletRecords)
      .set({
        currentRevisionKey: bundle.revisionKey,
        headGeneration: sequence,
        updatedAt: bundle.now,
      })
      .where(eq(sqlite.capletRecords.recordKey, record.recordKey))
      .run();
    const retained = Math.max(1, record.historyLimit ?? 1);
    const revisions = await transaction
      .select({ revisionKey: sqlite.capletRevisions.revisionKey })
      .from(sqlite.capletRevisions)
      .where(eq(sqlite.capletRevisions.recordKey, record.recordKey))
      .orderBy(desc(sqlite.capletRevisions.sequence))
      .all();
    const expired = revisions.slice(retained).map((revision) => revision.revisionKey);
    if (expired.length > 0) {
      await transaction
        .delete(sqlite.capletRevisions)
        .where(inArray(sqlite.capletRevisions.revisionKey, expired))
        .run();
    }
    await insertSqliteInstallation(transaction, bundle);
    await transaction
      .insert(sqlite.operatorActivity)
      .values(recordActivityValues(bundle, "caplet.update"))
      .run();
    await advanceSqliteConfigGeneration(transaction, bundle.contentHash, bundle.actor);
  });
}

async function updatePostgres(
  db: PostgresHostDatabase,
  bundle: PreparedBundle,
  expectedGeneration: number,
  detachInstallation: boolean,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [record] = await transaction
      .select()
      .from(postgres.capletRecords)
      .where(eq(postgres.capletRecords.capletId, bundle.id))
      .for("update")
      .limit(1);
    if (!record)
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${bundle.id} was not found.`);
    if (record.headGeneration !== expectedGeneration) {
      throw staleGeneration(bundle.id, expectedGeneration, record.headGeneration);
    }
    const [activeInstallation] = await transaction
      .select()
      .from(postgres.capletInstallations)
      .where(
        and(
          eq(postgres.capletInstallations.recordKey, record.recordKey),
          eq(postgres.capletInstallations.status, "active"),
        ),
      )
      .for("update")
      .limit(1);
    if (activeInstallation && !detachInstallation) throw trackedInstallation(bundle.id);
    if (activeInstallation) {
      await transaction
        .update(postgres.capletInstallations)
        .set({
          status: "detached",
          generation: activeInstallation.generation + 1,
          detachedAt: bundle.now,
          detachedBy: bundle.actor,
          updatedAt: bundle.now,
        })
        .where(
          eq(postgres.capletInstallations.installationKey, activeInstallation.installationKey),
        );
      await transaction.insert(postgres.operatorActivity).values({
        activityKey: randomUUID(),
        operatorClientId: bundle.actor,
        action: "caplet.detach_for_overwrite",
        targetKind: "installation",
        targetKey: activeInstallation.installationKey,
        outcome: "succeeded",
        metadata: { capletId: bundle.id },
        createdAt: bundle.now,
      });
    }
    const sequence = record.headGeneration + 1;
    bundle.recordKey = record.recordKey;
    await transaction.insert(postgres.capletRevisions).values(revisionValues(bundle, sequence));
    if (bundle.tags.length > 0) {
      await transaction.insert(postgres.capletRevisionTags).values(tagValues(bundle));
    }
    if (bundle.backends.length > 0) {
      await transaction.insert(postgres.capletRevisionBackends).values(backendValues(bundle));
    }
    for (const entry of bundle.entries) {
      await ensurePostgresBlob(transaction, bundle, entry);
      await transaction.insert(postgres.capletBundleEntries).values(entryValues(bundle, entry));
    }
    await transaction
      .update(postgres.capletRecords)
      .set({
        currentRevisionKey: bundle.revisionKey,
        headGeneration: sequence,
        updatedAt: bundle.now,
      })
      .where(eq(postgres.capletRecords.recordKey, record.recordKey));
    const retained = Math.max(1, record.historyLimit ?? 1);
    const revisions = await transaction
      .select({ revisionKey: postgres.capletRevisions.revisionKey })
      .from(postgres.capletRevisions)
      .where(eq(postgres.capletRevisions.recordKey, record.recordKey))
      .orderBy(desc(postgres.capletRevisions.sequence));
    const expired = revisions.slice(retained).map((revision) => revision.revisionKey);
    if (expired.length > 0) {
      await transaction
        .delete(postgres.capletRevisions)
        .where(inArray(postgres.capletRevisions.revisionKey, expired));
    }
    await insertPostgresInstallation(transaction, bundle);
    await transaction
      .insert(postgres.operatorActivity)
      .values(recordActivityValues(bundle, "caplet.update"));
    await advancePostgresConfigGeneration(transaction, bundle.contentHash, bundle.actor);
  });
}

async function updateFromSourceSqlite(
  db: SqliteHostDatabase,
  bundle: PreparedBundle,
  input: SourceUpdateMetadata,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const record = await transaction
      .select()
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.capletId, bundle.id))
      .get();
    if (!record)
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${bundle.id} was not found.`);
    if (record.headGeneration !== input.expectedGeneration) {
      throw staleGeneration(bundle.id, input.expectedGeneration, record.headGeneration);
    }
    const installation = await transaction
      .select()
      .from(sqlite.capletInstallations)
      .where(
        and(
          eq(sqlite.capletInstallations.recordKey, record.recordKey),
          eq(sqlite.capletInstallations.status, "active"),
        ),
      )
      .get();
    if (!installation) throw sourceInstallationRequired(bundle.id);
    if (installation.generation !== input.expectedInstallationGeneration) {
      throw staleInstallationGeneration(bundle.id);
    }
    if (!record.currentRevisionKey) throw missingCurrentRevision(bundle.id);
    const currentRevision = await transaction
      .select({ contentHash: sqlite.capletRevisions.contentHash })
      .from(sqlite.capletRevisions)
      .where(eq(sqlite.capletRevisions.revisionKey, record.currentRevisionKey))
      .get();
    if (!currentRevision) throw missingCurrentRevision(bundle.id);

    const contentChanged = currentRevision.contentHash !== bundle.contentHash;
    const retainProvenanceRevision = !contentChanged && record.historyLimit !== 0;
    const createRevision = contentChanged || retainProvenanceRevision;
    const sequence = record.headGeneration + (createRevision ? 1 : 0);
    bundle.recordKey = record.recordKey;
    if (createRevision) {
      await transaction
        .insert(sqlite.capletRevisions)
        .values(revisionValues(bundle, sequence))
        .run();
      if (bundle.tags.length > 0) {
        await transaction.insert(sqlite.capletRevisionTags).values(tagValues(bundle)).run();
      }
      if (bundle.backends.length > 0) {
        await transaction.insert(sqlite.capletRevisionBackends).values(backendValues(bundle)).run();
      }
      for (const entry of bundle.entries) {
        await ensureSqliteBlob(transaction, bundle, entry);
        await transaction
          .insert(sqlite.capletBundleEntries)
          .values(entryValues(bundle, entry))
          .run();
      }
      const updatedRecord = await transaction
        .update(sqlite.capletRecords)
        .set({
          currentRevisionKey: contentChanged ? bundle.revisionKey : record.currentRevisionKey,
          headGeneration: sequence,
          updatedAt: bundle.now,
        })
        .where(
          and(
            eq(sqlite.capletRecords.recordKey, record.recordKey),
            eq(sqlite.capletRecords.headGeneration, input.expectedGeneration),
          ),
        )
        .run();
      if (updatedRecord.rowsAffected !== 1) {
        throw staleGeneration(bundle.id, input.expectedGeneration, record.headGeneration);
      }
      await pruneSourceRevisionsSqlite(
        transaction,
        record.recordKey,
        contentChanged ? bundle.revisionKey : record.currentRevisionKey,
        Math.max(1, record.historyLimit ?? 1),
      );
    }

    const latestObservation = await transaction
      .select({ observedAt: sqlite.capletInstallationObservations.observedAt })
      .from(sqlite.capletInstallationObservations)
      .where(
        eq(sqlite.capletInstallationObservations.installationKey, installation.installationKey),
      )
      .orderBy(desc(sqlite.capletInstallationObservations.observedAt))
      .limit(1)
      .get();
    const observedAt = sourceObservationTime(bundle.now, latestObservation?.observedAt);
    const updatedInstallation = await transaction
      .update(sqlite.capletInstallations)
      .set({ generation: installation.generation + 1, updatedAt: observedAt })
      .where(
        and(
          eq(sqlite.capletInstallations.installationKey, installation.installationKey),
          eq(sqlite.capletInstallations.generation, input.expectedInstallationGeneration),
          eq(sqlite.capletInstallations.status, "active"),
        ),
      )
      .run();
    if (updatedInstallation.rowsAffected !== 1) throw staleInstallationGeneration(bundle.id);
    await transaction
      .insert(sqlite.capletInstallationObservations)
      .values(sourceObservationValues(installation.installationKey, input, observedAt))
      .run();
    await transaction
      .insert(sqlite.operatorActivity)
      .values(
        sourceUpdateActivity(
          bundle,
          installation.installationKey,
          input,
          contentChanged,
          createRevision,
          observedAt,
        ),
      )
      .run();
    if (contentChanged)
      await advanceSqliteConfigGeneration(transaction, bundle.contentHash, bundle.actor);
  });
}

async function updateFromSourcePostgres(
  db: PostgresHostDatabase,
  bundle: PreparedBundle,
  input: SourceUpdateMetadata,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [record] = await transaction
      .select()
      .from(postgres.capletRecords)
      .where(eq(postgres.capletRecords.capletId, bundle.id))
      .for("update")
      .limit(1);
    if (!record)
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${bundle.id} was not found.`);
    if (record.headGeneration !== input.expectedGeneration) {
      throw staleGeneration(bundle.id, input.expectedGeneration, record.headGeneration);
    }
    const [installation] = await transaction
      .select()
      .from(postgres.capletInstallations)
      .where(
        and(
          eq(postgres.capletInstallations.recordKey, record.recordKey),
          eq(postgres.capletInstallations.status, "active"),
        ),
      )
      .for("update")
      .limit(1);
    if (!installation) throw sourceInstallationRequired(bundle.id);
    if (installation.generation !== input.expectedInstallationGeneration) {
      throw staleInstallationGeneration(bundle.id);
    }
    if (!record.currentRevisionKey) throw missingCurrentRevision(bundle.id);
    const [currentRevision] = await transaction
      .select({ contentHash: postgres.capletRevisions.contentHash })
      .from(postgres.capletRevisions)
      .where(eq(postgres.capletRevisions.revisionKey, record.currentRevisionKey))
      .limit(1);
    if (!currentRevision) throw missingCurrentRevision(bundle.id);

    const contentChanged = currentRevision.contentHash !== bundle.contentHash;
    const retainProvenanceRevision = !contentChanged && record.historyLimit !== 0;
    const createRevision = contentChanged || retainProvenanceRevision;
    const sequence = record.headGeneration + (createRevision ? 1 : 0);
    bundle.recordKey = record.recordKey;
    if (createRevision) {
      await transaction.insert(postgres.capletRevisions).values(revisionValues(bundle, sequence));
      if (bundle.tags.length > 0) {
        await transaction.insert(postgres.capletRevisionTags).values(tagValues(bundle));
      }
      if (bundle.backends.length > 0) {
        await transaction.insert(postgres.capletRevisionBackends).values(backendValues(bundle));
      }
      for (const entry of bundle.entries) {
        await ensurePostgresBlob(transaction, bundle, entry);
        await transaction.insert(postgres.capletBundleEntries).values(entryValues(bundle, entry));
      }
      const [updatedRecord] = await transaction
        .update(postgres.capletRecords)
        .set({
          currentRevisionKey: contentChanged ? bundle.revisionKey : record.currentRevisionKey,
          headGeneration: sequence,
          updatedAt: bundle.now,
        })
        .where(
          and(
            eq(postgres.capletRecords.recordKey, record.recordKey),
            eq(postgres.capletRecords.headGeneration, input.expectedGeneration),
          ),
        )
        .returning({ recordKey: postgres.capletRecords.recordKey });
      if (!updatedRecord) {
        throw staleGeneration(bundle.id, input.expectedGeneration, record.headGeneration);
      }
      await pruneSourceRevisionsPostgres(
        transaction,
        record.recordKey,
        contentChanged ? bundle.revisionKey : record.currentRevisionKey,
        Math.max(1, record.historyLimit ?? 1),
      );
    }

    const [latestObservation] = await transaction
      .select({ observedAt: postgres.capletInstallationObservations.observedAt })
      .from(postgres.capletInstallationObservations)
      .where(
        eq(postgres.capletInstallationObservations.installationKey, installation.installationKey),
      )
      .orderBy(desc(postgres.capletInstallationObservations.observedAt))
      .limit(1);
    const observedAt = sourceObservationTime(bundle.now, latestObservation?.observedAt);
    const [updatedInstallation] = await transaction
      .update(postgres.capletInstallations)
      .set({ generation: installation.generation + 1, updatedAt: observedAt })
      .where(
        and(
          eq(postgres.capletInstallations.installationKey, installation.installationKey),
          eq(postgres.capletInstallations.generation, input.expectedInstallationGeneration),
          eq(postgres.capletInstallations.status, "active"),
        ),
      )
      .returning({ installationKey: postgres.capletInstallations.installationKey });
    if (!updatedInstallation) throw staleInstallationGeneration(bundle.id);
    await transaction
      .insert(postgres.capletInstallationObservations)
      .values(sourceObservationValues(installation.installationKey, input, observedAt));
    await transaction
      .insert(postgres.operatorActivity)
      .values(
        sourceUpdateActivity(
          bundle,
          installation.installationKey,
          input,
          contentChanged,
          createRevision,
          observedAt,
        ),
      );
    if (contentChanged) {
      await advancePostgresConfigGeneration(transaction, bundle.contentHash, bundle.actor);
    }
  });
}
async function deleteRevisionSqlite(
  db: SqliteHostDatabase,
  input: DeleteCapletRevisionInput,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const record = await transaction
      .select()
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.capletId, input.id))
      .get();
    if (!record) throw missingCapletRecord(input.id);
    if (record.headGeneration !== input.expectedGeneration) {
      throw staleGeneration(input.id, input.expectedGeneration, record.headGeneration);
    }
    const revision = await transaction
      .select()
      .from(sqlite.capletRevisions)
      .where(eq(sqlite.capletRevisions.revisionKey, input.revisionKey))
      .get();
    if (!revision || revision.recordKey !== record.recordKey) {
      throw missingCapletRevision(input.revisionKey);
    }
    await transaction
      .delete(sqlite.capletRevisions)
      .where(eq(sqlite.capletRevisions.revisionKey, input.revisionKey))
      .run();
    const activityAt = new Date().toISOString();
    await transaction
      .insert(sqlite.operatorActivity)
      .values({
        activityKey: randomUUID(),
        operatorClientId: requireOperator(input.operator),
        action: "caplet.revision_delete",
        targetKind: "caplet_record",
        targetKey: record.recordKey,
        outcome: "succeeded",
        metadata: { capletId: input.id, revisionKey: input.revisionKey },
        createdAt: activityAt,
      })
      .run();
    await advanceSqliteConfigGeneration(
      transaction,
      input.revisionKey,
      requireOperator(input.operator),
    );
    const remaining = await transaction
      .select({ revisionKey: sqlite.capletRevisions.revisionKey })
      .from(sqlite.capletRevisions)
      .where(eq(sqlite.capletRevisions.recordKey, record.recordKey))
      .orderBy(desc(sqlite.capletRevisions.sequence))
      .all();
    if (remaining.length === 0) {
      await transaction
        .delete(sqlite.capletRecords)
        .where(eq(sqlite.capletRecords.recordKey, record.recordKey))
        .run();
      return;
    }
    await transaction
      .update(sqlite.capletRecords)
      .set({
        currentRevisionKey:
          record.currentRevisionKey === input.revisionKey
            ? remaining[0]!.revisionKey
            : record.currentRevisionKey,
        headGeneration: record.headGeneration + 1,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(sqlite.capletRecords.recordKey, record.recordKey))
      .run();
  });
}

async function deleteRevisionPostgres(
  db: PostgresHostDatabase,
  input: DeleteCapletRevisionInput,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [record] = await transaction
      .select()
      .from(postgres.capletRecords)
      .where(eq(postgres.capletRecords.capletId, input.id))
      .for("update")
      .limit(1);
    if (!record) throw missingCapletRecord(input.id);
    if (record.headGeneration !== input.expectedGeneration) {
      throw staleGeneration(input.id, input.expectedGeneration, record.headGeneration);
    }
    const [revision] = await transaction
      .select()
      .from(postgres.capletRevisions)
      .where(eq(postgres.capletRevisions.revisionKey, input.revisionKey))
      .limit(1);
    if (!revision || revision.recordKey !== record.recordKey) {
      throw missingCapletRevision(input.revisionKey);
    }
    await transaction
      .delete(postgres.capletRevisions)
      .where(eq(postgres.capletRevisions.revisionKey, input.revisionKey));
    const activityAt = new Date().toISOString();
    await transaction.insert(postgres.operatorActivity).values({
      activityKey: randomUUID(),
      operatorClientId: requireOperator(input.operator),
      action: "caplet.revision_delete",
      targetKind: "caplet_record",
      targetKey: record.recordKey,
      outcome: "succeeded",
      metadata: { capletId: input.id, revisionKey: input.revisionKey },
      createdAt: activityAt,
    });
    await advancePostgresConfigGeneration(
      transaction,
      input.revisionKey,
      requireOperator(input.operator),
    );
    const remaining = await transaction
      .select({ revisionKey: postgres.capletRevisions.revisionKey })
      .from(postgres.capletRevisions)
      .where(eq(postgres.capletRevisions.recordKey, record.recordKey))
      .orderBy(desc(postgres.capletRevisions.sequence));
    if (remaining.length === 0) {
      await transaction
        .delete(postgres.capletRecords)
        .where(eq(postgres.capletRecords.recordKey, record.recordKey));
      return;
    }
    await transaction
      .update(postgres.capletRecords)
      .set({
        currentRevisionKey:
          record.currentRevisionKey === input.revisionKey
            ? remaining[0]!.revisionKey
            : record.currentRevisionKey,
        headGeneration: record.headGeneration + 1,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(postgres.capletRecords.recordKey, record.recordKey));
  });
}

async function restoreRevisionSqlite(
  db: SqliteHostDatabase,
  input: RestoreCapletRevisionInput,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const record = await transaction
      .select()
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.capletId, input.id))
      .get();
    if (!record) throw missingCapletRecord(input.id);
    if (record.headGeneration !== input.expectedGeneration) {
      throw staleGeneration(input.id, input.expectedGeneration, record.headGeneration);
    }
    const source = await transaction
      .select()
      .from(sqlite.capletRevisions)
      .where(
        and(
          eq(sqlite.capletRevisions.revisionKey, input.revisionKey),
          eq(sqlite.capletRevisions.recordKey, record.recordKey),
        ),
      )
      .get();
    if (!source) {
      throw missingCapletRevision(input.revisionKey);
    }
    const revisionKey = randomUUID();
    const sequence = record.headGeneration + 1;
    const now = new Date().toISOString();
    await transaction
      .insert(sqlite.capletRevisions)
      .values({ ...source, revisionKey, sequence, createdAt: now, actor: input.operator.clientId })
      .run();
    const tags = await transaction
      .select()
      .from(sqlite.capletRevisionTags)
      .where(eq(sqlite.capletRevisionTags.revisionKey, source.revisionKey))
      .all();
    if (tags.length > 0) {
      await transaction
        .insert(sqlite.capletRevisionTags)
        .values(tags.map((tag) => ({ ...tag, revisionKey })))
        .run();
    }
    const backends = await transaction
      .select()
      .from(sqlite.capletRevisionBackends)
      .where(eq(sqlite.capletRevisionBackends.revisionKey, source.revisionKey))
      .all();
    if (backends.length > 0) {
      await transaction
        .insert(sqlite.capletRevisionBackends)
        .values(backends.map((backend) => ({ ...backend, revisionKey })))
        .run();
    }
    const entries = await transaction
      .select()
      .from(sqlite.capletBundleEntries)
      .where(eq(sqlite.capletBundleEntries.revisionKey, source.revisionKey))
      .all();
    if (entries.length > 0) {
      await transaction
        .insert(sqlite.capletBundleEntries)
        .values(entries.map((entry) => ({ ...entry, revisionKey })))
        .run();
    }
    await transaction
      .update(sqlite.capletRecords)
      .set({ currentRevisionKey: revisionKey, headGeneration: sequence, updatedAt: now })
      .where(eq(sqlite.capletRecords.recordKey, record.recordKey))
      .run();
    await pruneSqliteRevisions(
      transaction,
      record.recordKey,
      Math.max(1, record.historyLimit ?? 1),
    );
    await transaction
      .insert(sqlite.operatorActivity)
      .values({
        activityKey: randomUUID(),
        operatorClientId: input.operator.clientId,
        action: "caplet.revision_restore",
        targetKind: "caplet_record",
        targetKey: record.recordKey,
        outcome: "succeeded",
        metadata: { capletId: input.id, sourceRevisionKey: source.revisionKey, revisionKey },
        createdAt: now,
      })
      .run();
    await advanceSqliteConfigGeneration(transaction, source.contentHash, input.operator.clientId);
  });
}

async function restoreRevisionPostgres(
  db: PostgresHostDatabase,
  input: RestoreCapletRevisionInput,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [record] = await transaction
      .select()
      .from(postgres.capletRecords)
      .where(eq(postgres.capletRecords.capletId, input.id))
      .for("update")
      .limit(1);
    if (!record) throw missingCapletRecord(input.id);
    if (record.headGeneration !== input.expectedGeneration) {
      throw staleGeneration(input.id, input.expectedGeneration, record.headGeneration);
    }
    const [source] = await transaction
      .select()
      .from(postgres.capletRevisions)
      .where(
        and(
          eq(postgres.capletRevisions.revisionKey, input.revisionKey),
          eq(postgres.capletRevisions.recordKey, record.recordKey),
        ),
      )
      .limit(1);
    if (!source) {
      throw missingCapletRevision(input.revisionKey);
    }
    const revisionKey = randomUUID();
    const sequence = record.headGeneration + 1;
    const now = new Date().toISOString();
    await transaction
      .insert(postgres.capletRevisions)
      .values({ ...source, revisionKey, sequence, createdAt: now, actor: input.operator.clientId });
    const [tags, backends, entries] = await Promise.all([
      transaction
        .select()
        .from(postgres.capletRevisionTags)
        .where(eq(postgres.capletRevisionTags.revisionKey, source.revisionKey)),
      transaction
        .select()
        .from(postgres.capletRevisionBackends)
        .where(eq(postgres.capletRevisionBackends.revisionKey, source.revisionKey)),
      transaction
        .select()
        .from(postgres.capletBundleEntries)
        .where(eq(postgres.capletBundleEntries.revisionKey, source.revisionKey)),
    ]);
    if (tags.length > 0) {
      await transaction
        .insert(postgres.capletRevisionTags)
        .values(tags.map((tag) => ({ ...tag, revisionKey })));
    }
    if (backends.length > 0) {
      await transaction
        .insert(postgres.capletRevisionBackends)
        .values(backends.map((backend) => ({ ...backend, revisionKey })));
    }
    if (entries.length > 0) {
      await transaction
        .insert(postgres.capletBundleEntries)
        .values(entries.map((entry) => ({ ...entry, revisionKey })));
    }
    await transaction
      .update(postgres.capletRecords)
      .set({ currentRevisionKey: revisionKey, headGeneration: sequence, updatedAt: now })
      .where(eq(postgres.capletRecords.recordKey, record.recordKey));
    await prunePostgresRevisions(
      transaction,
      record.recordKey,
      Math.max(1, record.historyLimit ?? 1),
    );
    await transaction.insert(postgres.operatorActivity).values({
      activityKey: randomUUID(),
      operatorClientId: input.operator.clientId,
      action: "caplet.revision_restore",
      targetKind: "caplet_record",
      targetKey: record.recordKey,
      outcome: "succeeded",
      metadata: { capletId: input.id, sourceRevisionKey: source.revisionKey, revisionKey },
      createdAt: now,
    });
    await advancePostgresConfigGeneration(transaction, source.contentHash, input.operator.clientId);
  });
}

async function renameSqlite(db: SqliteHostDatabase, input: RenameCapletRecordInput): Promise<void> {
  await db.transaction(async (transaction) => {
    const record = await transaction
      .select()
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.capletId, input.id))
      .get();
    if (!record)
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${input.id} was not found.`);
    if (record.headGeneration !== input.expectedGeneration) {
      throw staleGeneration(input.id, input.expectedGeneration, record.headGeneration);
    }
    const collision = await transaction
      .select({ recordKey: sqlite.capletRecords.recordKey })
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.capletId, input.newId))
      .get();
    if (collision)
      throw new CapletsError("CONFIG_EXISTS", `Caplet Record ${input.newId} already exists.`);
    const now = new Date().toISOString();
    await transaction
      .update(sqlite.capletRecords)
      .set({ capletId: input.newId, headGeneration: record.headGeneration + 1, updatedAt: now })
      .where(eq(sqlite.capletRecords.recordKey, record.recordKey))
      .run();
    await transaction
      .insert(sqlite.operatorActivity)
      .values({
        activityKey: randomUUID(),
        operatorClientId: input.operator.clientId,
        action: "caplet.rename",
        targetKind: "caplet_record",
        targetKey: record.recordKey,
        outcome: "succeeded",
        metadata: { previousCapletId: input.id, capletId: input.newId },
        createdAt: now,
      })
      .run();
    await advanceSqliteConfigGeneration(
      transaction,
      `rename:${record.recordKey}:${input.newId}`,
      input.operator.clientId,
    );
  });
}

async function renamePostgres(
  db: PostgresHostDatabase,
  input: RenameCapletRecordInput,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [record] = await transaction
      .select()
      .from(postgres.capletRecords)
      .where(eq(postgres.capletRecords.capletId, input.id))
      .for("update")
      .limit(1);
    if (!record)
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${input.id} was not found.`);
    if (record.headGeneration !== input.expectedGeneration) {
      throw staleGeneration(input.id, input.expectedGeneration, record.headGeneration);
    }
    const [collision] = await transaction
      .select({ recordKey: postgres.capletRecords.recordKey })
      .from(postgres.capletRecords)
      .where(eq(postgres.capletRecords.capletId, input.newId))
      .limit(1);
    if (collision)
      throw new CapletsError("CONFIG_EXISTS", `Caplet Record ${input.newId} already exists.`);
    const now = new Date().toISOString();
    await transaction
      .update(postgres.capletRecords)
      .set({ capletId: input.newId, headGeneration: record.headGeneration + 1, updatedAt: now })
      .where(eq(postgres.capletRecords.recordKey, record.recordKey));
    await transaction.insert(postgres.operatorActivity).values({
      activityKey: randomUUID(),
      operatorClientId: input.operator.clientId,
      action: "caplet.rename",
      targetKind: "caplet_record",
      targetKey: record.recordKey,
      outcome: "succeeded",
      metadata: { previousCapletId: input.id, capletId: input.newId },
      createdAt: now,
    });
    await advancePostgresConfigGeneration(
      transaction,
      `rename:${record.recordKey}:${input.newId}`,
      input.operator.clientId,
    );
  });
}

async function setRetentionSqlite(
  db: SqliteHostDatabase,
  input: SetCapletRetentionInput,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const record = await transaction
      .select()
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.capletId, input.id))
      .get();
    if (!record)
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${input.id} was not found.`);
    if (record.headGeneration !== input.expectedGeneration) {
      throw staleGeneration(input.id, input.expectedGeneration, record.headGeneration);
    }
    const now = new Date().toISOString();
    await transaction
      .update(sqlite.capletRecords)
      .set({
        historyLimit: input.historyLimit,
        headGeneration: record.headGeneration + 1,
        updatedAt: now,
      })
      .where(eq(sqlite.capletRecords.recordKey, record.recordKey))
      .run();
    await pruneSqliteRevisions(transaction, record.recordKey, Math.max(1, input.historyLimit ?? 1));
    await transaction
      .insert(sqlite.operatorActivity)
      .values({
        activityKey: randomUUID(),
        operatorClientId: input.operator.clientId,
        action: "caplet.retention_set",
        targetKind: "caplet_record",
        targetKey: record.recordKey,
        outcome: "succeeded",
        metadata: { capletId: input.id, historyLimit: input.historyLimit },
        createdAt: now,
      })
      .run();
  });
}

async function setRetentionPostgres(
  db: PostgresHostDatabase,
  input: SetCapletRetentionInput,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [record] = await transaction
      .select()
      .from(postgres.capletRecords)
      .where(eq(postgres.capletRecords.capletId, input.id))
      .for("update")
      .limit(1);
    if (!record)
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${input.id} was not found.`);
    if (record.headGeneration !== input.expectedGeneration) {
      throw staleGeneration(input.id, input.expectedGeneration, record.headGeneration);
    }
    const now = new Date().toISOString();
    await transaction
      .update(postgres.capletRecords)
      .set({
        historyLimit: input.historyLimit,
        headGeneration: record.headGeneration + 1,
        updatedAt: now,
      })
      .where(eq(postgres.capletRecords.recordKey, record.recordKey));
    await prunePostgresRevisions(
      transaction,
      record.recordKey,
      Math.max(1, input.historyLimit ?? 1),
    );
    await transaction.insert(postgres.operatorActivity).values({
      activityKey: randomUUID(),
      operatorClientId: input.operator.clientId,
      action: "caplet.retention_set",
      targetKind: "caplet_record",
      targetKey: record.recordKey,
      outcome: "succeeded",
      metadata: { capletId: input.id, historyLimit: input.historyLimit },
      createdAt: now,
    });
  });
}

async function hardDeleteSqlite(
  db: SqliteHostDatabase,
  input: HardDeleteCapletRecordInput,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const record = await transaction
      .select()
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.capletId, input.id))
      .get();
    if (!record)
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${input.id} was not found.`);
    if (record.headGeneration !== input.expectedGeneration) {
      throw staleGeneration(input.id, input.expectedGeneration, record.headGeneration);
    }
    await transaction
      .delete(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.recordKey, record.recordKey))
      .run();
    const now = new Date().toISOString();
    await transaction
      .insert(sqlite.operatorActivity)
      .values({
        activityKey: randomUUID(),
        operatorClientId: input.operator.clientId,
        action: "caplet.hard_delete",
        targetKind: "caplet_record",
        targetKey: record.recordKey,
        outcome: "succeeded",
        metadata: { capletId: input.id },
        createdAt: now,
      })
      .run();
    await advanceSqliteConfigGeneration(
      transaction,
      `delete:${record.recordKey}`,
      input.operator.clientId,
    );
  });
}

async function hardDeletePostgres(
  db: PostgresHostDatabase,
  input: HardDeleteCapletRecordInput,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [record] = await transaction
      .select()
      .from(postgres.capletRecords)
      .where(eq(postgres.capletRecords.capletId, input.id))
      .for("update")
      .limit(1);
    if (!record)
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${input.id} was not found.`);
    if (record.headGeneration !== input.expectedGeneration) {
      throw staleGeneration(input.id, input.expectedGeneration, record.headGeneration);
    }
    await transaction
      .delete(postgres.capletRecords)
      .where(eq(postgres.capletRecords.recordKey, record.recordKey));
    const now = new Date().toISOString();
    await transaction.insert(postgres.operatorActivity).values({
      activityKey: randomUUID(),
      operatorClientId: input.operator.clientId,
      action: "caplet.hard_delete",
      targetKind: "caplet_record",
      targetKey: record.recordKey,
      outcome: "succeeded",
      metadata: { capletId: input.id },
      createdAt: now,
    });
    await advancePostgresConfigGeneration(
      transaction,
      `delete:${record.recordKey}`,
      input.operator.clientId,
    );
  });
}

async function pruneSqliteRevisions(
  transaction: Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0],
  recordKey: string,
  retained: number,
): Promise<void> {
  const revisions = await transaction
    .select({ revisionKey: sqlite.capletRevisions.revisionKey })
    .from(sqlite.capletRevisions)
    .where(eq(sqlite.capletRevisions.recordKey, recordKey))
    .orderBy(desc(sqlite.capletRevisions.sequence))
    .all();
  const expired = revisions.slice(retained).map((revision) => revision.revisionKey);
  if (expired.length > 0) {
    await transaction
      .delete(sqlite.capletRevisions)
      .where(inArray(sqlite.capletRevisions.revisionKey, expired))
      .run();
  }
}

async function prunePostgresRevisions(
  transaction: Parameters<Parameters<PostgresHostDatabase["transaction"]>[0]>[0],
  recordKey: string,
  retained: number,
): Promise<void> {
  const revisions = await transaction
    .select({ revisionKey: postgres.capletRevisions.revisionKey })
    .from(postgres.capletRevisions)
    .where(eq(postgres.capletRevisions.recordKey, recordKey))
    .orderBy(desc(postgres.capletRevisions.sequence));
  const expired = revisions.slice(retained).map((revision) => revision.revisionKey);
  if (expired.length > 0) {
    await transaction
      .delete(postgres.capletRevisions)
      .where(inArray(postgres.capletRevisions.revisionKey, expired));
  }
}

async function pruneSourceRevisionsSqlite(
  transaction: Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0],
  recordKey: string,
  currentRevisionKey: string,
  retained: number,
): Promise<void> {
  const revisions = await transaction
    .select({ revisionKey: sqlite.capletRevisions.revisionKey })
    .from(sqlite.capletRevisions)
    .where(eq(sqlite.capletRevisions.recordKey, recordKey))
    .orderBy(desc(sqlite.capletRevisions.sequence))
    .all();
  const retainedKeys = new Set<string>([currentRevisionKey]);
  for (const revision of revisions) {
    if (retainedKeys.size >= retained) break;
    retainedKeys.add(revision.revisionKey);
  }
  const expired = revisions
    .filter((revision) => !retainedKeys.has(revision.revisionKey))
    .map((revision) => revision.revisionKey);
  if (expired.length > 0) {
    await transaction
      .delete(sqlite.capletRevisions)
      .where(inArray(sqlite.capletRevisions.revisionKey, expired))
      .run();
  }
}

async function pruneSourceRevisionsPostgres(
  transaction: Parameters<Parameters<PostgresHostDatabase["transaction"]>[0]>[0],
  recordKey: string,
  currentRevisionKey: string,
  retained: number,
): Promise<void> {
  const revisions = await transaction
    .select({ revisionKey: postgres.capletRevisions.revisionKey })
    .from(postgres.capletRevisions)
    .where(eq(postgres.capletRevisions.recordKey, recordKey))
    .orderBy(desc(postgres.capletRevisions.sequence));
  const retainedKeys = new Set<string>([currentRevisionKey]);
  for (const revision of revisions) {
    if (retainedKeys.size >= retained) break;
    retainedKeys.add(revision.revisionKey);
  }
  const expired = revisions
    .filter((revision) => !retainedKeys.has(revision.revisionKey))
    .map((revision) => revision.revisionKey);
  if (expired.length > 0) {
    await transaction
      .delete(postgres.capletRevisions)
      .where(inArray(postgres.capletRevisions.revisionKey, expired));
  }
}

function validateCapletRecordId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(id)) {
    throw new CapletsError("CONFIG_INVALID", `Invalid Caplet ID ${id}.`);
  }
}

function validateHistoryLimit(historyLimit: number | null): void {
  if (historyLimit !== null && (!Number.isInteger(historyLimit) || historyLimit < 0)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Caplet history limit must be a non-negative integer or null.",
    );
  }
}

async function getRevisionByKey(
  database: HostDatabase,
  recordKey: string,
  revisionKey: string,
): Promise<CapletRevisionView | undefined> {
  if (database.dialect === "sqlite") {
    const record = await database.db
      .select()
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.recordKey, recordKey))
      .get();
    const revision = await database.db
      .select()
      .from(sqlite.capletRevisions)
      .where(
        and(
          eq(sqlite.capletRevisions.recordKey, recordKey),
          eq(sqlite.capletRevisions.revisionKey, revisionKey),
        ),
      )
      .get();
    if (!record || !revision) return undefined;
    const tags = await database.db
      .select()
      .from(sqlite.capletRevisionTags)
      .where(eq(sqlite.capletRevisionTags.revisionKey, revisionKey))
      .orderBy(asc(sqlite.capletRevisionTags.position))
      .all();
    const backends = await database.db
      .select()
      .from(sqlite.capletRevisionBackends)
      .where(eq(sqlite.capletRevisionBackends.revisionKey, revisionKey))
      .orderBy(asc(sqlite.capletRevisionBackends.position))
      .all();
    const entries = await database.db
      .select()
      .from(sqlite.capletBundleEntries)
      .where(eq(sqlite.capletBundleEntries.revisionKey, revisionKey))
      .orderBy(asc(sqlite.capletBundleEntries.path))
      .all();
    return recordView(record, revision, tags, backends, entries).currentRevision;
  }
  const [[record], [revision], tags, backends, entries] = await Promise.all([
    database.db
      .select()
      .from(postgres.capletRecords)
      .where(eq(postgres.capletRecords.recordKey, recordKey))
      .limit(1),
    database.db
      .select()
      .from(postgres.capletRevisions)
      .where(
        and(
          eq(postgres.capletRevisions.recordKey, recordKey),
          eq(postgres.capletRevisions.revisionKey, revisionKey),
        ),
      )
      .limit(1),
    database.db
      .select()
      .from(postgres.capletRevisionTags)
      .where(eq(postgres.capletRevisionTags.revisionKey, revisionKey))
      .orderBy(asc(postgres.capletRevisionTags.position)),
    database.db
      .select()
      .from(postgres.capletRevisionBackends)
      .where(eq(postgres.capletRevisionBackends.revisionKey, revisionKey))
      .orderBy(asc(postgres.capletRevisionBackends.position)),
    database.db
      .select()
      .from(postgres.capletBundleEntries)
      .where(eq(postgres.capletBundleEntries.revisionKey, revisionKey))
      .orderBy(asc(postgres.capletBundleEntries.path)),
  ]);
  if (!record || !revision) return undefined;
  return recordView(record, revision, tags, backends, entries).currentRevision;
}

async function appendOperatorActivity(
  database: HostDatabase,
  activity: {
    operatorClientId: string;
    action: string;
    targetKind: string;
    targetKey: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  const values = {
    activityKey: randomUUID(),
    ...activity,
    outcome: "succeeded",
    createdAt: new Date().toISOString(),
  };
  if (database.dialect === "sqlite") {
    await database.db.insert(sqlite.operatorActivity).values(values).run();
  } else {
    await database.db.insert(postgres.operatorActivity).values(values);
  }
}

function recordValues(bundle: PreparedBundle) {
  return {
    recordKey: bundle.recordKey,
    capletId: bundle.id,
    currentRevisionKey: null,
    headGeneration: 1,
    historyLimit: bundle.historyLimit,
    createdAt: bundle.now,
    updatedAt: bundle.now,
  };
}

function revisionValues(bundle: PreparedBundle, sequence = 1) {
  return {
    revisionKey: bundle.revisionKey,
    recordKey: bundle.recordKey,
    sequence,
    name: bundle.name,
    description: bundle.description,
    body: bundle.body,
    schemaUrl: bundle.schemaUrl,
    content: bundle.content,
    contentHash: bundle.contentHash,
    sourceRevision: bundle.sourceRevision,
    sourceContentHash: bundle.sourceContentHash,
    createdAt: bundle.now,
    actor: bundle.actor,
  };
}

function tagValues(bundle: PreparedBundle) {
  return bundle.tags.map((value, position) => ({
    revisionKey: bundle.revisionKey,
    position,
    value,
  }));
}

function backendValues(bundle: PreparedBundle) {
  return bundle.backends.map((backend, position) => ({
    revisionKey: bundle.revisionKey,
    position,
    family: backend.family,
    childId: backend.childId,
    config: backend.config,
  }));
}

function entryValues(bundle: PreparedBundle, entry: PreparedBundle["entries"][number]) {
  return {
    revisionKey: bundle.revisionKey,
    path: entry.path,
    blobHash: entry.hash,
    mediaType: entry.mediaType,
    size: entry.size,
    executable: entry.executable,
  };
}

type NormalizedCapletRevisionPageOptions = {
  limit: number;
  sort: KeysetSortDirection;
  after: CapletRevisionPageKey | undefined;
};

type CapletRevisionPageQueryResult = {
  recordKey?: string | undefined;
  page: StorageKeysetPage<CapletRevisionSummaryView, CapletRevisionPageKey>;
};

function normalizeRevisionPageOptions(
  options: CapletRevisionPageOptions,
): NormalizedCapletRevisionPageOptions {
  if (
    options.after !== undefined &&
    (typeof options.after.createdAt !== "string" ||
      typeof options.after.revisionKey !== "string" ||
      !options.after.createdAt ||
      !options.after.revisionKey)
  ) {
    throw new CapletsError("REQUEST_INVALID", "Caplet revision page key is invalid.");
  }
  return {
    limit: storagePageLimit(options.limit),
    sort: options.sort ?? "desc",
    after: options.after,
  };
}

async function listRevisionsPageSqlite(
  db: SqliteHostDatabase,
  id: string,
  options: NormalizedCapletRevisionPageOptions,
): Promise<CapletRevisionPageQueryResult> {
  const record = await db
    .select({ recordKey: sqlite.capletRecords.recordKey })
    .from(sqlite.capletRecords)
    .where(eq(sqlite.capletRecords.capletId, id))
    .get();
  if (!record) return { page: { items: [] } };
  const rows = await db
    .select({
      revisionKey: sqlite.capletRevisions.revisionKey,
      sequence: sqlite.capletRevisions.sequence,
      name: sqlite.capletRevisions.name,
      createdAt: sqlite.capletRevisions.createdAt,
    })
    .from(sqlite.capletRevisions)
    .where(
      and(
        eq(sqlite.capletRevisions.recordKey, record.recordKey),
        options.after
          ? options.sort === "asc"
            ? or(
                gt(sqlite.capletRevisions.createdAt, options.after.createdAt),
                and(
                  eq(sqlite.capletRevisions.createdAt, options.after.createdAt),
                  gt(sqlite.capletRevisions.revisionKey, options.after.revisionKey),
                ),
              )
            : or(
                lt(sqlite.capletRevisions.createdAt, options.after.createdAt),
                and(
                  eq(sqlite.capletRevisions.createdAt, options.after.createdAt),
                  lt(sqlite.capletRevisions.revisionKey, options.after.revisionKey),
                ),
              )
          : undefined,
      ),
    )
    .orderBy(
      options.sort === "asc"
        ? asc(sqlite.capletRevisions.createdAt)
        : desc(sqlite.capletRevisions.createdAt),
      options.sort === "asc"
        ? asc(sqlite.capletRevisions.revisionKey)
        : desc(sqlite.capletRevisions.revisionKey),
    )
    .limit(options.limit + 1)
    .all();
  return { recordKey: record.recordKey, page: revisionKeysetPage(rows, options.limit) };
}

async function listRevisionsPagePostgres(
  db: PostgresHostDatabase,
  id: string,
  options: NormalizedCapletRevisionPageOptions,
): Promise<CapletRevisionPageQueryResult> {
  const [record] = await db
    .select({ recordKey: postgres.capletRecords.recordKey })
    .from(postgres.capletRecords)
    .where(eq(postgres.capletRecords.capletId, id))
    .limit(1);
  if (!record) return { page: { items: [] } };
  const rows = await db
    .select({
      revisionKey: postgres.capletRevisions.revisionKey,
      sequence: postgres.capletRevisions.sequence,
      name: postgres.capletRevisions.name,
      createdAt: postgres.capletRevisions.createdAt,
    })
    .from(postgres.capletRevisions)
    .where(
      and(
        eq(postgres.capletRevisions.recordKey, record.recordKey),
        options.after
          ? options.sort === "asc"
            ? or(
                gt(postgres.capletRevisions.createdAt, options.after.createdAt),
                and(
                  eq(postgres.capletRevisions.createdAt, options.after.createdAt),
                  gt(postgres.capletRevisions.revisionKey, options.after.revisionKey),
                ),
              )
            : or(
                lt(postgres.capletRevisions.createdAt, options.after.createdAt),
                and(
                  eq(postgres.capletRevisions.createdAt, options.after.createdAt),
                  lt(postgres.capletRevisions.revisionKey, options.after.revisionKey),
                ),
              )
          : undefined,
      ),
    )
    .orderBy(
      options.sort === "asc"
        ? asc(postgres.capletRevisions.createdAt)
        : desc(postgres.capletRevisions.createdAt),
      options.sort === "asc"
        ? asc(postgres.capletRevisions.revisionKey)
        : desc(postgres.capletRevisions.revisionKey),
    )
    .limit(options.limit + 1);
  return { recordKey: record.recordKey, page: revisionKeysetPage(rows, options.limit) };
}

function revisionKeysetPage(
  items: CapletRevisionSummaryView[],
  limit: number,
): StorageKeysetPage<CapletRevisionSummaryView, CapletRevisionPageKey> {
  if (items.length <= limit) return { items };
  items.pop();
  const last = items[items.length - 1]!;
  return {
    items,
    nextKey: { createdAt: last.createdAt, revisionKey: last.revisionKey },
  };
}

type NormalizedCapletRecordPageOptions = {
  limit: number;
  sort: KeysetSortDirection;
  after: CapletRecordPageKey | undefined;
  source: string | undefined;
  status: "active" | "detached" | undefined;
  tag: string | undefined;
  searchPattern: string | undefined;
};

function normalizeRecordPageOptions(
  options: CapletRecordPageOptions,
): NormalizedCapletRecordPageOptions {
  if (
    options.status !== undefined &&
    options.status !== "active" &&
    options.status !== "detached"
  ) {
    throw new CapletsError("REQUEST_INVALID", "Caplet Record status filter is invalid.");
  }
  if (
    options.after !== undefined &&
    (typeof options.after.updatedAt !== "string" ||
      typeof options.after.recordKey !== "string" ||
      !options.after.updatedAt ||
      !options.after.recordKey)
  ) {
    throw new CapletsError("REQUEST_INVALID", "Caplet Record page key is invalid.");
  }
  if (options.sort !== undefined && options.sort !== "asc" && options.sort !== "desc") {
    throw new CapletsError("REQUEST_INVALID", "Caplet Record sort direction is invalid.");
  }
  const search = optionalPageFilter(options.search)?.toLowerCase();
  return {
    limit: storagePageLimit(options.limit),
    sort: options.sort ?? "desc",
    after: options.after,
    source: optionalPageFilter(options.source),
    status: options.status,
    tag: optionalPageFilter(options.tag),
    searchPattern:
      search === undefined
        ? undefined
        : `%${search.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`,
  };
}

function optionalPageFilter(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

async function listRecordsPageSqlite(
  db: SqliteHostDatabase,
  options: NormalizedCapletRecordPageOptions,
): Promise<StorageKeysetPage<CapletRecordSummaryView, CapletRecordPageKey>> {
  const latestInstallation = db
    .select({ installationKey: sqlite.capletInstallations.installationKey })
    .from(sqlite.capletInstallations)
    .where(eq(sqlite.capletInstallations.recordKey, sqlite.capletRecords.recordKey))
    .orderBy(
      desc(sqlite.capletInstallations.updatedAt),
      desc(sqlite.capletInstallations.installationKey),
    )
    .limit(1);
  const installationFilter =
    options.source === undefined && options.status === undefined
      ? undefined
      : exists(
          db
            .select({ installationKey: sqlite.capletInstallations.installationKey })
            .from(sqlite.capletInstallations)
            .where(
              and(
                inArray(sqlite.capletInstallations.installationKey, latestInstallation),
                options.source === undefined
                  ? undefined
                  : eq(sqlite.capletInstallations.sourceKind, options.source),
                options.status === undefined
                  ? undefined
                  : eq(sqlite.capletInstallations.status, options.status),
              ),
            ),
        );
  const tagFilter =
    options.tag === undefined
      ? undefined
      : exists(
          db
            .select({ revisionKey: sqlite.capletRevisionTags.revisionKey })
            .from(sqlite.capletRevisionTags)
            .where(
              and(
                eq(sqlite.capletRevisionTags.revisionKey, sqlite.capletRecords.currentRevisionKey),
                eq(sqlite.capletRevisionTags.value, options.tag),
              ),
            ),
        );
  const searchFilter =
    options.searchPattern === undefined
      ? undefined
      : or(
          sql`lower(${sqlite.capletRecords.capletId}) like ${options.searchPattern} escape '!'`,
          sql`lower(${sqlite.capletRevisions.name}) like ${options.searchPattern} escape '!'`,
          sql`lower(${sqlite.capletRevisions.description}) like ${options.searchPattern} escape '!'`,
        );
  const compare = options.sort === "asc" ? gt : lt;
  const order = options.sort === "asc" ? asc : desc;
  const rows = await db
    .select({
      record: {
        recordKey: sqlite.capletRecords.recordKey,
        capletId: sqlite.capletRecords.capletId,
        headGeneration: sqlite.capletRecords.headGeneration,
        historyLimit: sqlite.capletRecords.historyLimit,
        createdAt: sqlite.capletRecords.createdAt,
        updatedAt: sqlite.capletRecords.updatedAt,
      },
      revision: {
        revisionKey: sqlite.capletRevisions.revisionKey,
        sequence: sqlite.capletRevisions.sequence,
        name: sqlite.capletRevisions.name,
        createdAt: sqlite.capletRevisions.createdAt,
      },
    })
    .from(sqlite.capletRecords)
    .innerJoin(
      sqlite.capletRevisions,
      eq(sqlite.capletRevisions.revisionKey, sqlite.capletRecords.currentRevisionKey),
    )
    .where(
      and(
        options.after
          ? or(
              compare(sqlite.capletRecords.updatedAt, options.after.updatedAt),
              and(
                eq(sqlite.capletRecords.updatedAt, options.after.updatedAt),
                compare(sqlite.capletRecords.recordKey, options.after.recordKey),
              ),
            )
          : undefined,
        installationFilter,
        tagFilter,
        searchFilter,
      ),
    )
    .orderBy(order(sqlite.capletRecords.updatedAt), order(sqlite.capletRecords.recordKey))
    .limit(options.limit + 1)
    .all();
  return recordKeysetPage(rows.map(recordSummaryView), options.limit);
}

async function listRecordsPagePostgres(
  db: PostgresHostDatabase,
  options: NormalizedCapletRecordPageOptions,
): Promise<StorageKeysetPage<CapletRecordSummaryView, CapletRecordPageKey>> {
  const latestInstallation = db
    .select({ installationKey: postgres.capletInstallations.installationKey })
    .from(postgres.capletInstallations)
    .where(eq(postgres.capletInstallations.recordKey, postgres.capletRecords.recordKey))
    .orderBy(
      desc(postgres.capletInstallations.updatedAt),
      desc(postgres.capletInstallations.installationKey),
    )
    .limit(1);
  const installationFilter =
    options.source === undefined && options.status === undefined
      ? undefined
      : exists(
          db
            .select({ installationKey: postgres.capletInstallations.installationKey })
            .from(postgres.capletInstallations)
            .where(
              and(
                inArray(postgres.capletInstallations.installationKey, latestInstallation),
                options.source === undefined
                  ? undefined
                  : eq(postgres.capletInstallations.sourceKind, options.source),
                options.status === undefined
                  ? undefined
                  : eq(postgres.capletInstallations.status, options.status),
              ),
            ),
        );
  const tagFilter =
    options.tag === undefined
      ? undefined
      : exists(
          db
            .select({ revisionKey: postgres.capletRevisionTags.revisionKey })
            .from(postgres.capletRevisionTags)
            .where(
              and(
                eq(
                  postgres.capletRevisionTags.revisionKey,
                  postgres.capletRecords.currentRevisionKey,
                ),
                eq(postgres.capletRevisionTags.value, options.tag),
              ),
            ),
        );
  const searchFilter =
    options.searchPattern === undefined
      ? undefined
      : or(
          sql`lower(${postgres.capletRecords.capletId}) like ${options.searchPattern} escape '!'`,
          sql`lower(${postgres.capletRevisions.name}) like ${options.searchPattern} escape '!'`,
          sql`lower(${postgres.capletRevisions.description}) like ${options.searchPattern} escape '!'`,
        );
  const compare = options.sort === "asc" ? gt : lt;
  const order = options.sort === "asc" ? asc : desc;
  const rows = await db
    .select({
      record: {
        recordKey: postgres.capletRecords.recordKey,
        capletId: postgres.capletRecords.capletId,
        headGeneration: postgres.capletRecords.headGeneration,
        historyLimit: postgres.capletRecords.historyLimit,
        createdAt: postgres.capletRecords.createdAt,
        updatedAt: postgres.capletRecords.updatedAt,
      },
      revision: {
        revisionKey: postgres.capletRevisions.revisionKey,
        sequence: postgres.capletRevisions.sequence,
        name: postgres.capletRevisions.name,
        createdAt: postgres.capletRevisions.createdAt,
      },
    })
    .from(postgres.capletRecords)
    .innerJoin(
      postgres.capletRevisions,
      eq(postgres.capletRevisions.revisionKey, postgres.capletRecords.currentRevisionKey),
    )
    .where(
      and(
        options.after
          ? or(
              compare(postgres.capletRecords.updatedAt, options.after.updatedAt),
              and(
                eq(postgres.capletRecords.updatedAt, options.after.updatedAt),
                compare(postgres.capletRecords.recordKey, options.after.recordKey),
              ),
            )
          : undefined,
        installationFilter,
        tagFilter,
        searchFilter,
      ),
    )
    .orderBy(order(postgres.capletRecords.updatedAt), order(postgres.capletRecords.recordKey))
    .limit(options.limit + 1);
  return recordKeysetPage(rows.map(recordSummaryView), options.limit);
}

type CapletRecordSummaryRow = {
  record: {
    recordKey: string;
    capletId: string;
    headGeneration: number;
    historyLimit: number | null;
    createdAt: string;
    updatedAt: string;
  };
  revision: CapletRevisionSummaryView;
};

function recordSummaryView(row: CapletRecordSummaryRow): CapletRecordSummaryView {
  return {
    recordKey: row.record.recordKey,
    id: row.record.capletId,
    headGeneration: row.record.headGeneration,
    historyLimit: row.record.historyLimit,
    createdAt: row.record.createdAt,
    updatedAt: row.record.updatedAt,
    currentRevision: row.revision,
  };
}

function recordKeysetPage(
  rows: CapletRecordSummaryView[],
  limit: number,
): StorageKeysetPage<CapletRecordSummaryView, CapletRecordPageKey> {
  if (rows.length <= limit) return { items: rows };
  rows.pop();
  const last = rows[rows.length - 1]!;
  return {
    items: rows,
    nextKey: { updatedAt: last.updatedAt, recordKey: last.recordKey },
  };
}

async function getSqlite(
  db: SqliteHostDatabase | SqliteHostTransaction,
  id: string,
): Promise<CapletRecordView | undefined> {
  const row = await db
    .select()
    .from(sqlite.capletRecords)
    .where(eq(sqlite.capletRecords.capletId, id))
    .get();
  if (!row?.currentRevisionKey) return undefined;
  const revision = await db
    .select()
    .from(sqlite.capletRevisions)
    .where(eq(sqlite.capletRevisions.revisionKey, row.currentRevisionKey))
    .get();
  if (!revision) throw missingCurrentRevision(id);
  const tags = await db
    .select()
    .from(sqlite.capletRevisionTags)
    .where(eq(sqlite.capletRevisionTags.revisionKey, revision.revisionKey))
    .orderBy(asc(sqlite.capletRevisionTags.position))
    .all();
  const backends = await db
    .select()
    .from(sqlite.capletRevisionBackends)
    .where(eq(sqlite.capletRevisionBackends.revisionKey, revision.revisionKey))
    .orderBy(asc(sqlite.capletRevisionBackends.position))
    .all();
  const entries = await db
    .select()
    .from(sqlite.capletBundleEntries)
    .where(eq(sqlite.capletBundleEntries.revisionKey, revision.revisionKey))
    .orderBy(asc(sqlite.capletBundleEntries.path))
    .all();
  return recordView(row, revision, tags, backends, entries);
}

async function getPostgres(
  db: PostgresHostDatabase | PostgresHostTransaction,
  id: string,
): Promise<CapletRecordView | undefined> {
  const [row] = await db
    .select()
    .from(postgres.capletRecords)
    .where(eq(postgres.capletRecords.capletId, id))
    .limit(1);
  if (!row?.currentRevisionKey) return undefined;
  const [revision] = await db
    .select()
    .from(postgres.capletRevisions)
    .where(eq(postgres.capletRevisions.revisionKey, row.currentRevisionKey))
    .limit(1);
  if (!revision) throw missingCurrentRevision(id);
  const [tags, backends, entries] = await Promise.all([
    db
      .select()
      .from(postgres.capletRevisionTags)
      .where(eq(postgres.capletRevisionTags.revisionKey, revision.revisionKey))
      .orderBy(asc(postgres.capletRevisionTags.position)),
    db
      .select()
      .from(postgres.capletRevisionBackends)
      .where(eq(postgres.capletRevisionBackends.revisionKey, revision.revisionKey))
      .orderBy(asc(postgres.capletRevisionBackends.position)),
    db
      .select()
      .from(postgres.capletBundleEntries)
      .where(eq(postgres.capletBundleEntries.revisionKey, revision.revisionKey))
      .orderBy(asc(postgres.capletBundleEntries.path)),
  ]);
  return recordView(row, revision, tags, backends, entries);
}

function recordView(
  record: typeof sqlite.capletRecords.$inferSelect,
  revision: typeof sqlite.capletRevisions.$inferSelect,
  tags: Array<typeof sqlite.capletRevisionTags.$inferSelect>,
  backends: Array<typeof sqlite.capletRevisionBackends.$inferSelect>,
  entries: Array<typeof sqlite.capletBundleEntries.$inferSelect>,
): CapletRecordView {
  return {
    recordKey: record.recordKey,
    id: record.capletId,
    headGeneration: record.headGeneration,
    historyLimit: record.historyLimit,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    currentRevision: {
      revisionKey: revision.revisionKey,
      sequence: revision.sequence,
      name: revision.name,
      description: revision.description,
      body: revision.body,
      schemaUrl: revision.schemaUrl,
      content: revision.content,
      contentHash: revision.contentHash,
      sourceRevision: revision.sourceRevision,
      sourceContentHash: revision.sourceContentHash,
      createdAt: revision.createdAt,
      actor: revision.actor,
      tags: tags.map((tag) => tag.value),
      backends: backends.map((backend) => ({
        family: backend.family,
        childId: backend.childId,
        config: backend.config,
      })),
      bundle: entries.map((entry) => ({
        path: entry.path,
        hash: entry.blobHash,
        mediaType: entry.mediaType,
        size: entry.size,
        executable: Boolean(entry.executable),
      })),
    },
  };
}

function renderCapletDocument(revision: CapletRevisionView): string {
  const frontmatter: Record<string, unknown> = {};
  if (revision.schemaUrl) frontmatter.$schema = revision.schemaUrl;
  frontmatter.name = revision.name;
  frontmatter.description = revision.description;
  if (revision.tags.length > 0) frontmatter.tags = revision.tags;
  Object.assign(frontmatter, revision.content);
  for (const backend of revision.backends) {
    if (backend.childId === null) {
      frontmatter[backend.family] = backend.config;
      continue;
    }
    const children = (frontmatter[backend.family] ?? {}) as Record<string, unknown>;
    children[backend.childId] = backend.config;
    frontmatter[backend.family] = children;
  }
  return `---\n${stringifyYaml(frontmatter, { lineWidth: 0 }).trimEnd()}\n---\n${revision.body}`;
}

function mediaTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".json":
      return "application/json";
    case ".md":
      return "text/markdown";
    case ".sh":
      return "text/x-shellscript";
    case ".txt":
    case ".yaml":
    case ".yml":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function missingCurrentRevision(id: string): CapletsError {
  return new CapletsError("INTERNAL_ERROR", `Caplet Record ${id} has a missing current revision.`);
}

function missingCapletRecord(id: string): CapletsError {
  return new CapletsError("CONFIG_NOT_FOUND", `Caplet Record ${id} was not found.`);
}

function missingCapletRevision(revisionKey: string): CapletsError {
  return new CapletsError("CONFIG_NOT_FOUND", `Caplet Revision ${revisionKey} was not found.`);
}

function staleGeneration(
  id: string,
  expectedGeneration: number,
  currentGeneration: number,
): CapletsError {
  return new CapletsError(
    "REQUEST_INVALID",
    `Caplet Record ${id} changed after it was read; reload and retry.`,
    { kind: "stale_generation", expectedGeneration, currentGeneration },
  );
}

async function deleteUnreferencedSqliteBlob(
  db: SqliteHostDatabase,
  hash: string,
): Promise<string | null | undefined> {
  return await db.transaction(async (transaction) => {
    const blob = await transaction
      .select({ objectKey: sqlite.capletAssetBlobs.objectKey })
      .from(sqlite.capletAssetBlobs)
      .where(eq(sqlite.capletAssetBlobs.hash, hash))
      .get();
    if (!blob) return undefined;
    const reference = await transaction
      .select({ path: sqlite.capletBundleEntries.path })
      .from(sqlite.capletBundleEntries)
      .where(eq(sqlite.capletBundleEntries.blobHash, hash))
      .limit(1)
      .get();
    if (reference) return undefined;
    await transaction
      .delete(sqlite.capletAssetBlobs)
      .where(eq(sqlite.capletAssetBlobs.hash, hash))
      .run();
    return blob.objectKey;
  });
}

async function deleteUnreferencedPostgresBlob(
  db: PostgresHostDatabase,
  hash: string,
): Promise<string | null | undefined> {
  return await db.transaction(async (transaction) => {
    const [blob] = await transaction
      .select({ objectKey: postgres.capletAssetBlobs.objectKey })
      .from(postgres.capletAssetBlobs)
      .where(eq(postgres.capletAssetBlobs.hash, hash))
      .for("update")
      .limit(1);
    if (!blob) return undefined;
    const [reference] = await transaction
      .select({ path: postgres.capletBundleEntries.path })
      .from(postgres.capletBundleEntries)
      .where(eq(postgres.capletBundleEntries.blobHash, hash))
      .limit(1);
    if (reference) return undefined;
    await transaction
      .delete(postgres.capletAssetBlobs)
      .where(eq(postgres.capletAssetBlobs.hash, hash));
    return blob.objectKey;
  });
}

async function ensureSqliteBlob(
  transaction: Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0],
  _bundle: PreparedBundle,
  entry: PreparedBundle["entries"][number],
): Promise<void> {
  const row = await transaction
    .select({
      hash: sqlite.capletAssetBlobs.hash,
      size: sqlite.capletAssetBlobs.size,
      verificationStatus: sqlite.capletAssetBlobs.verificationStatus,
    })
    .from(sqlite.capletAssetBlobs)
    .where(eq(sqlite.capletAssetBlobs.hash, entry.hash))
    .get();
  if (!row || row.size !== entry.size || row.verificationStatus !== "verified") {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      `Caplet asset ${entry.hash} changed during import; retry the operation.`,
    );
  }
}

async function ensurePostgresBlob(
  transaction: Parameters<Parameters<PostgresHostDatabase["transaction"]>[0]>[0],
  _bundle: PreparedBundle,
  entry: PreparedBundle["entries"][number],
): Promise<void> {
  const [row] = await transaction
    .select({
      hash: postgres.capletAssetBlobs.hash,
      size: postgres.capletAssetBlobs.size,
      verificationStatus: postgres.capletAssetBlobs.verificationStatus,
    })
    .from(postgres.capletAssetBlobs)
    .where(eq(postgres.capletAssetBlobs.hash, entry.hash))
    .limit(1);
  if (!row || row.size !== entry.size || row.verificationStatus !== "verified") {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      `Caplet asset ${entry.hash} changed during import; retry the operation.`,
    );
  }
}

function trackedInstallation(id: string): CapletsError {
  return new CapletsError(
    "REQUEST_INVALID",
    `Caplet ${id} has a tracked installation; detach it before overwriting the record.`,
    { kind: "tracked_installation" },
  );
}

function sourceInstallationRequired(id: string): CapletsError {
  return new CapletsError(
    "REQUEST_INVALID",
    `Caplet ${id} does not have an active source installation.`,
    { kind: "tracked_installation_required" },
  );
}

function staleInstallationGeneration(id: string): CapletsError {
  return new CapletsError(
    "REQUEST_INVALID",
    `Caplet installation ${id} changed after it was read; reload and retry.`,
    { kind: "stale_generation" },
  );
}

function sourceObservationTime(candidate: string, previous: string | undefined): string {
  const candidateTime = Date.parse(candidate);
  const previousTime = previous === undefined ? Number.NEGATIVE_INFINITY : Date.parse(previous);
  if (
    !Number.isFinite(candidateTime) ||
    (previous !== undefined && !Number.isFinite(previousTime))
  ) {
    throw new CapletsError(
      "INTERNAL_ERROR",
      "Caplet source provenance contains an invalid timestamp.",
    );
  }
  return new Date(Math.max(candidateTime, previousTime + 1)).toISOString();
}

function sourceObservationValues(
  installationKey: string,
  input: SourceUpdateMetadata,
  observedAt: string,
) {
  return {
    observationKey: randomUUID(),
    installationKey,
    resolvedRevision: input.sourceRevision,
    contentHash: input.sourceContentHash,
    risk: input.risk ?? null,
    status: input.observationStatus,
    observedAt,
  };
}

function sourceUpdateActivity(
  bundle: PreparedBundle,
  installationKey: string,
  input: SourceUpdateMetadata,
  contentChanged: boolean,
  revisionCreated: boolean,
  createdAt: string,
) {
  return {
    activityKey: randomUUID(),
    operatorClientId: bundle.actor,
    action: "caplet.source_update",
    targetKind: "caplet_record",
    targetKey: bundle.recordKey,
    outcome: "succeeded",
    metadata: {
      capletId: bundle.id,
      installationKey,
      observationStatus: input.observationStatus,
      contentChanged,
      revisionCreated,
      ...(revisionCreated ? { revisionKey: bundle.revisionKey } : {}),
    },
    createdAt,
  };
}

function recordActivityValues(bundle: PreparedBundle, action: string) {
  return {
    activityKey: randomUUID(),
    operatorClientId: bundle.actor,
    action,
    targetKind: "caplet_record",
    targetKey: bundle.recordKey,
    outcome: "succeeded",
    metadata: { capletId: bundle.id, revisionKey: bundle.revisionKey },
    createdAt: bundle.now,
  };
}

async function insertSqliteInstallation(
  transaction: Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0],
  bundle: PreparedBundle,
): Promise<void> {
  if (!bundle.installation) return;
  await transaction
    .insert(sqlite.capletInstallations)
    .values({
      installationKey: bundle.installation.installationKey,
      recordKey: bundle.recordKey,
      generation: 1,
      status: "active",
      sourceKind: bundle.installation.sourceKind,
      sourceIdentity: bundle.installation.sourceIdentity,
      channel: bundle.installation.channel,
      createdAt: bundle.now,
      updatedAt: bundle.now,
    })
    .run();
  await transaction
    .insert(sqlite.capletInstallationObservations)
    .values({
      observationKey: randomUUID(),
      installationKey: bundle.installation.installationKey,
      resolvedRevision: bundle.sourceRevision,
      contentHash: bundle.sourceContentHash ?? bundle.contentHash,
      risk: bundle.installation.risk,
      status: "current",
      observedAt: bundle.now,
    })
    .run();
}

async function insertPostgresInstallation(
  transaction: Parameters<Parameters<PostgresHostDatabase["transaction"]>[0]>[0],
  bundle: PreparedBundle,
): Promise<void> {
  if (!bundle.installation) return;
  await transaction.insert(postgres.capletInstallations).values({
    installationKey: bundle.installation.installationKey,
    recordKey: bundle.recordKey,
    generation: 1,
    status: "active",
    sourceKind: bundle.installation.sourceKind,
    sourceIdentity: bundle.installation.sourceIdentity,
    channel: bundle.installation.channel,
    createdAt: bundle.now,
    updatedAt: bundle.now,
  });
  await transaction.insert(postgres.capletInstallationObservations).values({
    observationKey: randomUUID(),
    installationKey: bundle.installation.installationKey,
    resolvedRevision: bundle.sourceRevision,
    contentHash: bundle.sourceContentHash ?? bundle.contentHash,
    risk: bundle.installation.risk,
    status: "current",
    observedAt: bundle.now,
  });
}
