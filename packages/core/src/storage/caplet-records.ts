import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, join, posix } from "node:path";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { stringify as stringifyYaml } from "yaml";
import { parseCapletFileDocument, type CapletFileFrontmatter } from "../caplet-files-bundle";
import { CapletsError } from "../errors";
import { advancePostgresConfigGeneration, advanceSqliteConfigGeneration } from "./coordination";
import type { AssetObjectStore } from "./asset-store";
import {
  requireOperator,
  type CapletInstallationObservationStatus,
  type OperatorPrincipal,
} from "./installations";
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

export type UpdateCapletBundleInput = ImportCapletBundleInput & {
  expectedGeneration: number;
  detachInstallation?: boolean | undefined;
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
  entries: Array<
    CapletBundleEntryView & {
      payload: Buffer;
      sqlPayload: Buffer | null;
      objectKey: string | null;
      assetWasExisting: boolean;
    }
  >;
};

const MAX_BUNDLE_FILES = 2_048;
const MAX_BUNDLE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_TOTAL_BYTES = 256 * 1024 * 1024;

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
    requireOperator(input.operator);
    const prepared = prepareBundle(input, this.limits);
    await this.prepareAssetStorage([prepared]);
    if (this.database.dialect === "sqlite") {
      importSqlite(this.database.db, prepared);
    } else {
      await importPostgres(this.database.db, prepared);
    }
    const result = await this.get(input.id);
    if (!result)
      throw new CapletsError("INTERNAL_ERROR", `Imported Caplet ${input.id} was not found.`);
    return result;
  }

  async importBundles(inputs: ImportCapletBundleInput[]): Promise<CapletRecordView[]> {
    for (const input of inputs) requireOperator(input.operator);
    const bundles = inputs.map((input) => prepareBundle(input, this.limits));
    await this.prepareAssetStorage(bundles);
    if (this.database.dialect === "sqlite") {
      importManySqlite(this.database.db, bundles);
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
  }
  async prepareBundleAssetsForImport(inputs: ImportCapletBundleInput[]): Promise<void> {
    for (const input of inputs) requireOperator(input.operator);
    await this.prepareAssetStorage(inputs.map((input) => prepareBundle(input, this.limits)));
  }

  importBundlesInTransaction(
    inputs: ImportCapletBundleInput[],
    transaction: HostDatabaseTransaction,
  ): void | Promise<void> {
    for (const input of inputs) requireOperator(input.operator);
    const bundles = inputs.map((input) => prepareBundle(input, this.limits));
    if (bundles.length === 0) return;
    return transaction.dialect === "sqlite"
      ? importManySqliteTransaction(transaction.db, bundles)
      : importManyPostgresTransaction(transaction.db, bundles);
  }

  getInTransaction(
    id: string,
    transaction: HostDatabaseTransaction,
  ): CapletRecordView | undefined | Promise<CapletRecordView | undefined> {
    return transaction.dialect === "sqlite"
      ? getSqlite(transaction.db, id)
      : getPostgres(transaction.db, id);
  }

  async get(id: string): Promise<CapletRecordView | undefined> {
    return this.database.dialect === "sqlite"
      ? getSqlite(this.database.db, id)
      : await getPostgres(this.database.db, id);
  }

  async list(): Promise<CapletRecordView[]> {
    const ids =
      this.database.dialect === "sqlite"
        ? this.database.db
            .select({ id: sqlite.capletRecords.capletId })
            .from(sqlite.capletRecords)
            .orderBy(asc(sqlite.capletRecords.capletId))
            .all()
        : await this.database.db
            .select({ id: postgres.capletRecords.capletId })
            .from(postgres.capletRecords)
            .orderBy(asc(postgres.capletRecords.capletId));
    const records = await Promise.all(ids.map(async ({ id }) => await this.get(id)));
    return records.filter((record): record is CapletRecordView => record !== undefined);
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
        ? this.database.db.select().from(sqlite.capletAssetBlobs).all()
        : await this.database.db.select().from(postgres.capletAssetBlobs);
    const candidates = blobs.filter((blob) => Date.parse(blob.createdAt) <= cutoff);
    const deletedKeys: string[] = [];
    let blobRowsDeleted = 0;
    for (const candidate of candidates) {
      const objectKey =
        this.database.dialect === "sqlite"
          ? deleteUnreferencedSqliteBlob(this.database.db, candidate.hash)
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
          ? this.database.db
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
      const blobs = this.database.db.select({ count: count() }).from(sqlite.capletAssetBlobs).get();
      const entries = this.database.db
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
        ? this.database.db
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
    requireOperator(input.operator);
    const prepared = prepareBundle(input, this.limits);
    await this.prepareAssetStorage([prepared]);
    if (this.database.dialect === "sqlite") {
      updateSqlite(
        this.database.db,
        prepared,
        input.expectedGeneration,
        input.detachInstallation === true,
      );
    } else {
      await updatePostgres(
        this.database.db,
        prepared,
        input.expectedGeneration,
        input.detachInstallation === true,
      );
    }
    const result = await this.get(input.id);
    if (!result)
      throw new CapletsError("INTERNAL_ERROR", `Updated Caplet ${input.id} was not found.`);
    return result;
  }

  async updateFromSource(input: UpdateCapletFromSourceInput): Promise<CapletRecordView> {
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
    const prepared = prepareBundle(input, this.limits);
    await this.prepareAssetStorage([prepared]);
    if (this.database.dialect === "sqlite") {
      updateFromSourceSqlite(this.database.db, prepared, input);
    } else {
      await updateFromSourcePostgres(this.database.db, prepared, input);
    }
    const result = await this.get(input.id);
    if (!result) {
      throw new CapletsError("INTERNAL_ERROR", `Source-updated Caplet ${input.id} was not found.`);
    }
    return result;
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

  async listRevisions(
    id: string,
    operator: OperatorPrincipal,
  ): Promise<Array<{ revisionKey: string; sequence: number; name: string }>> {
    const actor = requireOperator(operator);
    let recordKey: string | undefined;
    let revisions: Array<{ revisionKey: string; sequence: number; name: string }>;
    if (this.database.dialect === "sqlite") {
      const record = this.database.db
        .select({ recordKey: sqlite.capletRecords.recordKey })
        .from(sqlite.capletRecords)
        .where(eq(sqlite.capletRecords.capletId, id))
        .get();
      if (!record) return [];
      recordKey = record.recordKey;
      revisions = this.database.db
        .select({
          revisionKey: sqlite.capletRevisions.revisionKey,
          sequence: sqlite.capletRevisions.sequence,
          name: sqlite.capletRevisions.name,
        })
        .from(sqlite.capletRevisions)
        .where(eq(sqlite.capletRevisions.recordKey, record.recordKey))
        .orderBy(desc(sqlite.capletRevisions.sequence))
        .all();
    } else {
      const [record] = await this.database.db
        .select({ recordKey: postgres.capletRecords.recordKey })
        .from(postgres.capletRecords)
        .where(eq(postgres.capletRecords.capletId, id))
        .limit(1);
      if (!record) return [];
      recordKey = record.recordKey;
      revisions = await this.database.db
        .select({
          revisionKey: postgres.capletRevisions.revisionKey,
          sequence: postgres.capletRevisions.sequence,
          name: postgres.capletRevisions.name,
        })
        .from(postgres.capletRevisions)
        .where(eq(postgres.capletRevisions.recordKey, record.recordKey))
        .orderBy(desc(postgres.capletRevisions.sequence));
    }
    await this.appendOperatorActivity(actor, "caplet.revisions_list", recordKey, {
      capletId: id,
      count: revisions.length,
    });
    return revisions;
  }

  async deleteRevision(input: DeleteCapletRevisionInput): Promise<CapletRecordView | undefined> {
    requireOperator(input.operator);
    if (this.database.dialect === "sqlite") {
      deleteRevisionSqlite(this.database.db, input);
    } else {
      await deleteRevisionPostgres(this.database.db, input);
    }
    return await this.get(input.id);
  }

  async restoreRevision(input: RestoreCapletRevisionInput): Promise<CapletRecordView> {
    requireOperator(input.operator);
    if (this.database.dialect === "sqlite") {
      restoreRevisionSqlite(this.database.db, input);
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
    if (this.database.dialect === "sqlite") renameSqlite(this.database.db, input);
    else await renamePostgres(this.database.db, input);
    const record = await this.get(input.newId);
    if (!record)
      throw new CapletsError("INTERNAL_ERROR", `Renamed Caplet ${input.newId} was not found.`);
    return record;
  }

  async setRetention(input: SetCapletRetentionInput): Promise<CapletRecordView> {
    requireOperator(input.operator);
    validateHistoryLimit(input.historyLimit);
    if (this.database.dialect === "sqlite") setRetentionSqlite(this.database.db, input);
    else await setRetentionPostgres(this.database.db, input);
    const record = await this.get(input.id);
    if (!record) throw new CapletsError("INTERNAL_ERROR", `Caplet ${input.id} was not found.`);
    return record;
  }

  async hardDelete(input: HardDeleteCapletRecordInput): Promise<void> {
    requireOperator(input.operator);
    if (this.database.dialect === "sqlite") hardDeleteSqlite(this.database.db, input);
    else await hardDeletePostgres(this.database.db, input);
  }

  async readBundle(
    id: string,
    options: {
      operator: OperatorPrincipal;
      revisionKey?: string | undefined;
    },
  ): Promise<ReadCapletBundleResult> {
    const actor = requireOperator(options.operator);
    let record = await this.get(id);
    if (!record) throw new CapletsError("CONFIG_INVALID", `Caplet Record ${id} was not found.`);
    if (options.revisionKey) {
      const revision = await getRevisionByKey(this.database, record.recordKey, options.revisionKey);
      if (!revision) {
        throw new CapletsError(
          "CONFIG_INVALID",
          `Caplet Revision ${options.revisionKey} was not found.`,
        );
      }
      record = { ...record, currentRevision: revision };
    }
    const payloads = await this.bundlePayloads(record.currentRevision);
    const files: CapletBundleInputFile[] = [
      {
        path: "CAPLET.md",
        content: Buffer.from(renderCapletDocument(record.currentRevision)),
        executable: false,
      },
    ];
    for (const entry of record.currentRevision.bundle) {
      const content = payloads.get(entry.hash);
      if (!content) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          `Caplet bundle asset ${entry.path} is unavailable.`,
        );
      }
      files.push({ path: entry.path, content, executable: entry.executable });
    }
    await this.appendOperatorActivity(actor, "caplet.bundle_read", record.recordKey, {
      capletId: id,
      revisionKey: record.currentRevision.revisionKey,
    });
    return { record, files };
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
    let record = await this.get(id);
    if (!record) throw new CapletsError("CONFIG_INVALID", `Caplet Record ${id} was not found.`);
    if (options.revisionKey) {
      const revision = await getRevisionByKey(this.database, record.recordKey, options.revisionKey);
      if (!revision) {
        throw new CapletsError(
          "CONFIG_INVALID",
          `Caplet Revision ${options.revisionKey} was not found.`,
        );
      }
      record = { ...record, currentRevision: revision };
    }
    const payloads = await this.bundlePayloads(record.currentRevision);
    const files: CapletBundleInputFile[] = [
      {
        path: "CAPLET.md",
        content: Buffer.from(renderCapletDocument(record.currentRevision)),
        executable: false,
      },
      ...record.currentRevision.bundle.map((entry) => ({
        path: entry.path,
        content: payloads.get(entry.hash)!,
        executable: entry.executable,
      })),
    ];
    materializeCapletBundleFiles(files, destination, options);
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

  private async prepareAssetStorage(bundles: PreparedBundle[]): Promise<void> {
    if (!this.objectStore) return;
    const entries = bundles.flatMap((bundle) => bundle.entries);
    const hashes = [...new Set(entries.map((entry) => entry.hash))];
    if (hashes.length === 0) return;
    const rows =
      this.database.dialect === "sqlite"
        ? this.database.db
            .select()
            .from(sqlite.capletAssetBlobs)
            .where(inArray(sqlite.capletAssetBlobs.hash, hashes))
            .all()
        : await this.database.db
            .select()
            .from(postgres.capletAssetBlobs)
            .where(inArray(postgres.capletAssetBlobs.hash, hashes));
    const existing = new Map(rows.map((row) => [row.hash, row]));
    for (const entry of entries) {
      const row = existing.get(entry.hash);
      if (row) {
        if (row.size !== entry.size || row.verificationStatus !== "verified") {
          throw new CapletsError(
            "INTERNAL_ERROR",
            `Caplet asset ${entry.hash} has invalid stored metadata.`,
          );
        }
        entry.sqlPayload = row.payload ? entry.payload : null;
        entry.objectKey = row.objectKey;
        entry.assetWasExisting = true;
        continue;
      }
      entry.objectKey = await this.objectStore.putVerified(entry.hash, entry.payload);
      entry.sqlPayload = null;
      existing.set(entry.hash, {
        hash: entry.hash,
        size: entry.size,
        payload: null,
        objectKey: entry.objectKey,
        verificationStatus: "verified",
        createdAt: bundles[0]?.now ?? new Date().toISOString(),
      });
    }
  }

  private async bundlePayloads(revision: CapletRevisionView): Promise<Map<string, Buffer>> {
    const hashes = [...new Set(revision.bundle.map((entry) => entry.hash))];
    const expectedSizes = new Map(revision.bundle.map((entry) => [entry.hash, entry.size]));
    if (hashes.length === 0) return new Map();
    const rows =
      this.database.dialect === "sqlite"
        ? this.database.db
            .select()
            .from(sqlite.capletAssetBlobs)
            .where(inArray(sqlite.capletAssetBlobs.hash, hashes))
            .all()
        : await this.database.db
            .select()
            .from(postgres.capletAssetBlobs)
            .where(inArray(postgres.capletAssetBlobs.hash, hashes));
    const payloads = new Map<string, Buffer>();
    for (const row of rows) {
      if (row.verificationStatus !== "verified" || expectedSizes.get(row.hash) !== row.size) {
        throw new CapletsError(
          "INTERNAL_ERROR",
          `Caplet asset ${row.hash} has invalid stored metadata.`,
        );
      }
      let payload: Buffer | undefined;
      if (row.payload) {
        payload = Buffer.from(row.payload);
        const actualHash = createHash("sha256").update(payload).digest("hex");
        if (actualHash !== row.hash || payload.byteLength !== row.size) {
          throw new CapletsError(
            "INTERNAL_ERROR",
            `Caplet asset ${row.hash} failed integrity verification.`,
          );
        }
      } else if (row.objectKey && this.objectStore) {
        payload = await this.objectStore.getVerified(row.objectKey, {
          hash: row.hash,
          size: row.size,
        });
      }
      if (!payload) {
        throw new CapletsError("SERVER_UNAVAILABLE", `Caplet asset ${row.hash} is unavailable.`);
      }
      payloads.set(row.hash, payload);
    }
    for (const hash of hashes) {
      if (!payloads.has(hash)) {
        throw new CapletsError("INTERNAL_ERROR", `Caplet asset ${hash} is missing.`);
      }
    }
    return payloads;
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
  const normalizedFiles: CapletBundleInputFile[] = [];
  const paths = new Set<string>();
  for (const file of files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      !Buffer.isBuffer(file.content) ||
      typeof file.executable !== "boolean"
    ) {
      throw new CapletsError("REQUEST_INVALID", "Caplet bundle contains a malformed file.");
    }
    const path = normalizedBundlePath(file.path);
    if (paths.has(path)) {
      throw new CapletsError("REQUEST_INVALID", `Duplicate Caplet bundle path ${path}.`);
    }
    paths.add(path);
    normalizedFiles.push({ ...file, path });
  }
  if (!paths.has("CAPLET.md")) {
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

function prepareBundle(input: ImportCapletBundleInput, limits: BundleLimits): PreparedBundle {
  if (!/^[A-Za-z0-9_-]+$/u.test(input.id)) {
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

  const paths = new Set<string>();
  let document: CapletBundleInputFile | undefined;
  const assets: CapletBundleInputFile[] = [];
  for (const file of input.files) {
    const path = normalizedBundlePath(file.path);
    if (paths.has(path))
      throw new CapletsError("CONFIG_INVALID", `Duplicate Caplet bundle path ${path}.`);
    paths.add(path);
    if (path === "CAPLET.md") {
      document = { ...file, path };
    } else {
      assets.push({ ...file, path });
    }
  }
  if (assets.length > limits.maxFiles) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Caplet bundle exceeds the ${limits.maxFiles} auxiliary file limit.`,
    );
  }
  let totalBytes = 0;
  for (const file of assets) {
    if (file.content.byteLength > limits.maxFileBytes) {
      throw new CapletsError(
        "REQUEST_INVALID",
        `Caplet bundle file ${file.path} exceeds the ${limits.maxFileBytes} byte limit.`,
      );
    }
    totalBytes += file.content.byteLength;
  }
  if (totalBytes > limits.maxTotalBytes) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `Caplet bundle exceeds the ${limits.maxTotalBytes} auxiliary byte limit.`,
    );
  }
  if (!document) throw new CapletsError("CONFIG_INVALID", "Caplet bundle must contain CAPLET.md.");
  const { frontmatter, body } = parseCapletFileDocument(
    "CAPLET.md",
    document.content.toString("utf8"),
  );
  const projected = projectFrontmatter(frontmatter);
  const entries = assets
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => ({
      path: file.path,
      payload: file.content,
      sqlPayload: file.content,
      objectKey: null,
      hash: createHash("sha256").update(file.content).digest("hex"),
      assetWasExisting: false,
      mediaType: mediaTypeForPath(file.path),
      size: file.content.byteLength,
      executable: file.executable,
    }));
  const contentHash = createHash("sha256")
    .update(
      JSON.stringify({
        frontmatter,
        body,
        entries: entries.map(({ path, hash, mediaType, size, executable }) => ({
          path,
          hash,
          mediaType,
          size,
          executable,
        })),
      }),
    )
    .digest("hex");
  return {
    id: input.id,
    recordKey: randomUUID(),
    revisionKey: randomUUID(),
    now: new Date().toISOString(),
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
  };
}

function normalizedBundlePath(value: string): string {
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (
    !value ||
    value.includes("\0") ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new CapletsError("CONFIG_INVALID", `Invalid Caplet bundle path ${value}.`);
  }
  return normalized;
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

function importSqlite(db: SqliteHostDatabase, bundle: PreparedBundle): void {
  importManySqlite(db, [bundle]);
}

function importManySqlite(db: SqliteHostDatabase, bundles: PreparedBundle[]): void {
  db.transaction((transaction) => importManySqliteTransaction(transaction, bundles));
}

function importManySqliteTransaction(
  transaction: SqliteHostTransaction,
  bundles: PreparedBundle[],
): void {
  for (const bundle of bundles) {
    if (
      transaction
        .select()
        .from(sqlite.capletRecords)
        .where(eq(sqlite.capletRecords.capletId, bundle.id))
        .get()
    ) {
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${bundle.id} already exists.`);
    }
    transaction.insert(sqlite.capletRecords).values(recordValues(bundle)).run();
    transaction.insert(sqlite.capletRevisions).values(revisionValues(bundle)).run();
    if (bundle.tags.length > 0) {
      transaction.insert(sqlite.capletRevisionTags).values(tagValues(bundle)).run();
    }
    if (bundle.backends.length > 0) {
      transaction.insert(sqlite.capletRevisionBackends).values(backendValues(bundle)).run();
    }
    for (const entry of bundle.entries) {
      ensureSqliteBlob(transaction, bundle, entry);
      transaction.insert(sqlite.capletBundleEntries).values(entryValues(bundle, entry)).run();
    }
    transaction
      .update(sqlite.capletRecords)
      .set({ currentRevisionKey: bundle.revisionKey })
      .where(eq(sqlite.capletRecords.recordKey, bundle.recordKey))
      .run();
    insertSqliteInstallation(transaction, bundle);
    transaction
      .insert(sqlite.operatorActivity)
      .values(recordActivityValues(bundle, "caplet.import"))
      .run();
  }
  const generationHash = createHash("sha256")
    .update(bundles.map((bundle) => bundle.contentHash).join("\0"))
    .digest("hex");
  advanceSqliteConfigGeneration(transaction, generationHash, bundles[0]!.actor);
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
    const [existing] = await transaction
      .select()
      .from(postgres.capletRecords)
      .where(eq(postgres.capletRecords.capletId, bundle.id))
      .limit(1);
    if (existing) {
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${bundle.id} already exists.`);
    }
    await transaction.insert(postgres.capletRecords).values(recordValues(bundle));
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

function updateSqlite(
  db: SqliteHostDatabase,
  bundle: PreparedBundle,
  expectedGeneration: number,
  detachInstallation: boolean,
): void {
  db.transaction((transaction) => {
    const record = transaction
      .select()
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.capletId, bundle.id))
      .get();
    if (!record)
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${bundle.id} was not found.`);
    if (record.headGeneration !== expectedGeneration) {
      throw staleGeneration(bundle.id, expectedGeneration, record.headGeneration);
    }
    const activeInstallation = transaction
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
      transaction
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
      transaction
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
    transaction.insert(sqlite.capletRevisions).values(revisionValues(bundle, sequence)).run();
    if (bundle.tags.length > 0) {
      transaction.insert(sqlite.capletRevisionTags).values(tagValues(bundle)).run();
    }
    if (bundle.backends.length > 0) {
      transaction.insert(sqlite.capletRevisionBackends).values(backendValues(bundle)).run();
    }
    for (const entry of bundle.entries) {
      ensureSqliteBlob(transaction, bundle, entry);
      transaction.insert(sqlite.capletBundleEntries).values(entryValues(bundle, entry)).run();
    }
    transaction
      .update(sqlite.capletRecords)
      .set({
        currentRevisionKey: bundle.revisionKey,
        headGeneration: sequence,
        updatedAt: bundle.now,
      })
      .where(eq(sqlite.capletRecords.recordKey, record.recordKey))
      .run();
    const retained = Math.max(1, record.historyLimit ?? 1);
    const revisions = transaction
      .select({ revisionKey: sqlite.capletRevisions.revisionKey })
      .from(sqlite.capletRevisions)
      .where(eq(sqlite.capletRevisions.recordKey, record.recordKey))
      .orderBy(desc(sqlite.capletRevisions.sequence))
      .all();
    const expired = revisions.slice(retained).map((revision) => revision.revisionKey);
    if (expired.length > 0) {
      transaction
        .delete(sqlite.capletRevisions)
        .where(inArray(sqlite.capletRevisions.revisionKey, expired))
        .run();
    }
    insertSqliteInstallation(transaction, bundle);
    transaction
      .insert(sqlite.operatorActivity)
      .values(recordActivityValues(bundle, "caplet.update"))
      .run();
    advanceSqliteConfigGeneration(transaction, bundle.contentHash, bundle.actor);
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

function updateFromSourceSqlite(
  db: SqliteHostDatabase,
  bundle: PreparedBundle,
  input: UpdateCapletFromSourceInput,
): void {
  db.transaction((transaction) => {
    const record = transaction
      .select()
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.capletId, bundle.id))
      .get();
    if (!record)
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${bundle.id} was not found.`);
    if (record.headGeneration !== input.expectedGeneration) {
      throw staleGeneration(bundle.id, input.expectedGeneration, record.headGeneration);
    }
    const installation = transaction
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
    const currentRevision = transaction
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
      transaction.insert(sqlite.capletRevisions).values(revisionValues(bundle, sequence)).run();
      if (bundle.tags.length > 0) {
        transaction.insert(sqlite.capletRevisionTags).values(tagValues(bundle)).run();
      }
      if (bundle.backends.length > 0) {
        transaction.insert(sqlite.capletRevisionBackends).values(backendValues(bundle)).run();
      }
      for (const entry of bundle.entries) {
        ensureSqliteBlob(transaction, bundle, entry);
        transaction.insert(sqlite.capletBundleEntries).values(entryValues(bundle, entry)).run();
      }
      const updatedRecord = transaction
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
      if (updatedRecord.changes !== 1) {
        throw staleGeneration(bundle.id, input.expectedGeneration, record.headGeneration);
      }
      pruneSourceRevisionsSqlite(
        transaction,
        record.recordKey,
        contentChanged ? bundle.revisionKey : record.currentRevisionKey,
        Math.max(1, record.historyLimit ?? 1),
      );
    }

    const latestObservation = transaction
      .select({ observedAt: sqlite.capletInstallationObservations.observedAt })
      .from(sqlite.capletInstallationObservations)
      .where(
        eq(sqlite.capletInstallationObservations.installationKey, installation.installationKey),
      )
      .orderBy(desc(sqlite.capletInstallationObservations.observedAt))
      .limit(1)
      .get();
    const observedAt = sourceObservationTime(bundle.now, latestObservation?.observedAt);
    const updatedInstallation = transaction
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
    if (updatedInstallation.changes !== 1) throw staleInstallationGeneration(bundle.id);
    transaction
      .insert(sqlite.capletInstallationObservations)
      .values(sourceObservationValues(installation.installationKey, input, observedAt))
      .run();
    transaction
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
      advanceSqliteConfigGeneration(transaction, bundle.contentHash, bundle.actor);
  });
}

async function updateFromSourcePostgres(
  db: PostgresHostDatabase,
  bundle: PreparedBundle,
  input: UpdateCapletFromSourceInput,
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
function deleteRevisionSqlite(db: SqliteHostDatabase, input: DeleteCapletRevisionInput): void {
  db.transaction((transaction) => {
    const record = transaction
      .select()
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.capletId, input.id))
      .get();
    if (!record)
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${input.id} was not found.`);
    if (record.headGeneration !== input.expectedGeneration) {
      throw staleGeneration(input.id, input.expectedGeneration, record.headGeneration);
    }
    const revision = transaction
      .select()
      .from(sqlite.capletRevisions)
      .where(eq(sqlite.capletRevisions.revisionKey, input.revisionKey))
      .get();
    if (!revision || revision.recordKey !== record.recordKey) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Caplet Revision ${input.revisionKey} was not found.`,
      );
    }
    transaction
      .delete(sqlite.capletRevisions)
      .where(eq(sqlite.capletRevisions.revisionKey, input.revisionKey))
      .run();
    const activityAt = new Date().toISOString();
    transaction
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
    advanceSqliteConfigGeneration(transaction, input.revisionKey, requireOperator(input.operator));
    const remaining = transaction
      .select({ revisionKey: sqlite.capletRevisions.revisionKey })
      .from(sqlite.capletRevisions)
      .where(eq(sqlite.capletRevisions.recordKey, record.recordKey))
      .orderBy(desc(sqlite.capletRevisions.sequence))
      .all();
    if (remaining.length === 0) {
      transaction
        .delete(sqlite.capletRecords)
        .where(eq(sqlite.capletRecords.recordKey, record.recordKey))
        .run();
      return;
    }
    transaction
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
    if (!record)
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${input.id} was not found.`);
    if (record.headGeneration !== input.expectedGeneration) {
      throw staleGeneration(input.id, input.expectedGeneration, record.headGeneration);
    }
    const [revision] = await transaction
      .select()
      .from(postgres.capletRevisions)
      .where(eq(postgres.capletRevisions.revisionKey, input.revisionKey))
      .limit(1);
    if (!revision || revision.recordKey !== record.recordKey) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Caplet Revision ${input.revisionKey} was not found.`,
      );
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

function restoreRevisionSqlite(db: SqliteHostDatabase, input: RestoreCapletRevisionInput): void {
  db.transaction((transaction) => {
    const record = transaction
      .select()
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.capletId, input.id))
      .get();
    if (!record)
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${input.id} was not found.`);
    if (record.headGeneration !== input.expectedGeneration) {
      throw staleGeneration(input.id, input.expectedGeneration, record.headGeneration);
    }
    const source = transaction
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
      throw new CapletsError(
        "CONFIG_INVALID",
        `Caplet Revision ${input.revisionKey} was not found.`,
      );
    }
    const revisionKey = randomUUID();
    const sequence = record.headGeneration + 1;
    const now = new Date().toISOString();
    transaction
      .insert(sqlite.capletRevisions)
      .values({ ...source, revisionKey, sequence, createdAt: now, actor: input.operator.clientId })
      .run();
    const tags = transaction
      .select()
      .from(sqlite.capletRevisionTags)
      .where(eq(sqlite.capletRevisionTags.revisionKey, source.revisionKey))
      .all();
    if (tags.length > 0) {
      transaction
        .insert(sqlite.capletRevisionTags)
        .values(tags.map((tag) => ({ ...tag, revisionKey })))
        .run();
    }
    const backends = transaction
      .select()
      .from(sqlite.capletRevisionBackends)
      .where(eq(sqlite.capletRevisionBackends.revisionKey, source.revisionKey))
      .all();
    if (backends.length > 0) {
      transaction
        .insert(sqlite.capletRevisionBackends)
        .values(backends.map((backend) => ({ ...backend, revisionKey })))
        .run();
    }
    const entries = transaction
      .select()
      .from(sqlite.capletBundleEntries)
      .where(eq(sqlite.capletBundleEntries.revisionKey, source.revisionKey))
      .all();
    if (entries.length > 0) {
      transaction
        .insert(sqlite.capletBundleEntries)
        .values(entries.map((entry) => ({ ...entry, revisionKey })))
        .run();
    }
    transaction
      .update(sqlite.capletRecords)
      .set({ currentRevisionKey: revisionKey, headGeneration: sequence, updatedAt: now })
      .where(eq(sqlite.capletRecords.recordKey, record.recordKey))
      .run();
    pruneSqliteRevisions(transaction, record.recordKey, Math.max(1, record.historyLimit ?? 1));
    transaction
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
    advanceSqliteConfigGeneration(transaction, source.contentHash, input.operator.clientId);
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
    if (!record)
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${input.id} was not found.`);
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
      throw new CapletsError(
        "CONFIG_INVALID",
        `Caplet Revision ${input.revisionKey} was not found.`,
      );
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

function renameSqlite(db: SqliteHostDatabase, input: RenameCapletRecordInput): void {
  db.transaction((transaction) => {
    const record = transaction
      .select()
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.capletId, input.id))
      .get();
    if (!record)
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${input.id} was not found.`);
    if (record.headGeneration !== input.expectedGeneration) {
      throw staleGeneration(input.id, input.expectedGeneration, record.headGeneration);
    }
    const collision = transaction
      .select({ recordKey: sqlite.capletRecords.recordKey })
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.capletId, input.newId))
      .get();
    if (collision)
      throw new CapletsError("CONFIG_EXISTS", `Caplet Record ${input.newId} already exists.`);
    const now = new Date().toISOString();
    transaction
      .update(sqlite.capletRecords)
      .set({ capletId: input.newId, headGeneration: record.headGeneration + 1, updatedAt: now })
      .where(eq(sqlite.capletRecords.recordKey, record.recordKey))
      .run();
    transaction
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
    advanceSqliteConfigGeneration(
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

function setRetentionSqlite(db: SqliteHostDatabase, input: SetCapletRetentionInput): void {
  db.transaction((transaction) => {
    const record = transaction
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
    transaction
      .update(sqlite.capletRecords)
      .set({
        historyLimit: input.historyLimit,
        headGeneration: record.headGeneration + 1,
        updatedAt: now,
      })
      .where(eq(sqlite.capletRecords.recordKey, record.recordKey))
      .run();
    pruneSqliteRevisions(transaction, record.recordKey, Math.max(1, input.historyLimit ?? 1));
    transaction
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

function hardDeleteSqlite(db: SqliteHostDatabase, input: HardDeleteCapletRecordInput): void {
  db.transaction((transaction) => {
    const record = transaction
      .select()
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.capletId, input.id))
      .get();
    if (!record)
      throw new CapletsError("CONFIG_INVALID", `Caplet Record ${input.id} was not found.`);
    if (record.headGeneration !== input.expectedGeneration) {
      throw staleGeneration(input.id, input.expectedGeneration, record.headGeneration);
    }
    transaction
      .delete(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.recordKey, record.recordKey))
      .run();
    const now = new Date().toISOString();
    transaction
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
    advanceSqliteConfigGeneration(
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

function pruneSqliteRevisions(
  transaction: Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0],
  recordKey: string,
  retained: number,
): void {
  const revisions = transaction
    .select({ revisionKey: sqlite.capletRevisions.revisionKey })
    .from(sqlite.capletRevisions)
    .where(eq(sqlite.capletRevisions.recordKey, recordKey))
    .orderBy(desc(sqlite.capletRevisions.sequence))
    .all();
  const expired = revisions.slice(retained).map((revision) => revision.revisionKey);
  if (expired.length > 0) {
    transaction
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

function pruneSourceRevisionsSqlite(
  transaction: Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0],
  recordKey: string,
  currentRevisionKey: string,
  retained: number,
): void {
  const revisions = transaction
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
    transaction
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
  if (!/^[A-Za-z0-9_-]+$/u.test(id)) {
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
    const record = database.db
      .select()
      .from(sqlite.capletRecords)
      .where(eq(sqlite.capletRecords.recordKey, recordKey))
      .get();
    const revision = database.db
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
    const tags = database.db
      .select()
      .from(sqlite.capletRevisionTags)
      .where(eq(sqlite.capletRevisionTags.revisionKey, revisionKey))
      .orderBy(asc(sqlite.capletRevisionTags.position))
      .all();
    const backends = database.db
      .select()
      .from(sqlite.capletRevisionBackends)
      .where(eq(sqlite.capletRevisionBackends.revisionKey, revisionKey))
      .orderBy(asc(sqlite.capletRevisionBackends.position))
      .all();
    const entries = database.db
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
    database.db.insert(sqlite.operatorActivity).values(values).run();
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

function blobValues(bundle: PreparedBundle, entry: PreparedBundle["entries"][number]) {
  return {
    hash: entry.hash,
    size: entry.size,
    payload: entry.sqlPayload,
    objectKey: entry.objectKey,
    verificationStatus: "verified",
    createdAt: bundle.now,
  };
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

function getSqlite(
  db: SqliteHostDatabase | SqliteHostTransaction,
  id: string,
): CapletRecordView | undefined {
  const row = db
    .select()
    .from(sqlite.capletRecords)
    .where(eq(sqlite.capletRecords.capletId, id))
    .get();
  if (!row?.currentRevisionKey) return undefined;
  const revision = db
    .select()
    .from(sqlite.capletRevisions)
    .where(eq(sqlite.capletRevisions.revisionKey, row.currentRevisionKey))
    .get();
  if (!revision) throw missingCurrentRevision(id);
  const tags = db
    .select()
    .from(sqlite.capletRevisionTags)
    .where(eq(sqlite.capletRevisionTags.revisionKey, revision.revisionKey))
    .orderBy(asc(sqlite.capletRevisionTags.position))
    .all();
  const backends = db
    .select()
    .from(sqlite.capletRevisionBackends)
    .where(eq(sqlite.capletRevisionBackends.revisionKey, revision.revisionKey))
    .orderBy(asc(sqlite.capletRevisionBackends.position))
    .all();
  const entries = db
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

function deleteUnreferencedSqliteBlob(
  db: SqliteHostDatabase,
  hash: string,
): string | null | undefined {
  return db.transaction((transaction) => {
    const blob = transaction
      .select({ objectKey: sqlite.capletAssetBlobs.objectKey })
      .from(sqlite.capletAssetBlobs)
      .where(eq(sqlite.capletAssetBlobs.hash, hash))
      .get();
    if (!blob) return undefined;
    const reference = transaction
      .select({ path: sqlite.capletBundleEntries.path })
      .from(sqlite.capletBundleEntries)
      .where(eq(sqlite.capletBundleEntries.blobHash, hash))
      .limit(1)
      .get();
    if (reference) return undefined;
    transaction.delete(sqlite.capletAssetBlobs).where(eq(sqlite.capletAssetBlobs.hash, hash)).run();
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

function ensureSqliteBlob(
  transaction: Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0],
  bundle: PreparedBundle,
  entry: PreparedBundle["entries"][number],
): void {
  if (entry.assetWasExisting) {
    const row = transaction
      .select({ hash: sqlite.capletAssetBlobs.hash })
      .from(sqlite.capletAssetBlobs)
      .where(eq(sqlite.capletAssetBlobs.hash, entry.hash))
      .get();
    if (!row) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        `Caplet asset ${entry.hash} changed during import; retry the operation.`,
      );
    }
    return;
  }
  transaction
    .insert(sqlite.capletAssetBlobs)
    .values(blobValues(bundle, entry))
    .onConflictDoNothing()
    .run();
}

async function ensurePostgresBlob(
  transaction: Parameters<Parameters<PostgresHostDatabase["transaction"]>[0]>[0],
  bundle: PreparedBundle,
  entry: PreparedBundle["entries"][number],
): Promise<void> {
  if (entry.assetWasExisting) {
    const [row] = await transaction
      .select({ hash: postgres.capletAssetBlobs.hash })
      .from(postgres.capletAssetBlobs)
      .where(eq(postgres.capletAssetBlobs.hash, entry.hash))
      .limit(1);
    if (!row) {
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        `Caplet asset ${entry.hash} changed during import; retry the operation.`,
      );
    }
    return;
  }
  await transaction
    .insert(postgres.capletAssetBlobs)
    .values(blobValues(bundle, entry))
    .onConflictDoNothing();
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
  input: UpdateCapletFromSourceInput,
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
  input: UpdateCapletFromSourceInput,
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

function insertSqliteInstallation(
  transaction: Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0],
  bundle: PreparedBundle,
): void {
  if (!bundle.installation) return;
  transaction
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
  transaction
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
