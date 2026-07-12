import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CapletsError } from "../errors";
import { stableJsonStringify } from "../stable-json";
import {
  MAX_AUTHORITY_GENERATION_BYTES,
  type AuthorityAuxiliaryExport,
  type AuthorityCommitResult,
  type AuthorityExport,
  type AuthorityGeneration,
  type AuthorityGenerationId,
  type AuthorityGenerationIdentity,
  type AuthorityHead,
  type AuthorityHealth,
  type AuthorityMigrationStage,
  type AuthorityMigrationStageContext,
  type AuthorityReceipt,
  type AuthorityRestoreResult,
  type AuxiliaryCommit,
  type AuxiliaryCommitResult,
  type AuxiliaryRead,
  type MaintenanceFence,
  type MaintenanceFenceContext,
  type MaintenanceFenceLease,
  type SemanticCommandEnvelope,
  type WritableAuthority,
} from "./types";
import type { AuthorityCapletRecord } from "./bundle-cache";

export type FilesystemAuthoritySnapshot = {
  caplets: Record<string, AuthorityCapletRecord>;
  [key: string]: unknown;
};

export type FilesystemAuthorityCommand =
  | { kind: "replace_snapshot"; snapshot: FilesystemAuthoritySnapshot }
  | { kind: "create_caplet" | "install_caplet"; record: AuthorityCapletRecord }
  | { kind: "update_caplet"; id: string; record: AuthorityCapletRecord }
  | { kind: "delete_caplet"; id: string }
  | { kind: "set_caplets"; caplets: Record<string, AuthorityCapletRecord> }
  | { snapshot: FilesystemAuthoritySnapshot }
  | FilesystemAuthoritySnapshot;

export type FilesystemAuthorityOptions = {
  root: string;
  authorityId?: string;
  namespace?: string;
  lockTimeoutMs?: number;
  stagedIds?: Iterable<string>;
  retentionCount?: number;
  maintenanceLeaseMs?: number;
  maintenanceRenewIntervalMs?: number;
};

const DEFAULT_AUTHORITY_ID = "filesystem";
const DEFAULT_NAMESPACE = "default";
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_RETENTION_COUNT = 20;
const DEFAULT_MAINTENANCE_LEASE_MS = 15_000;
const DEFAULT_MAINTENANCE_RENEW_INTERVAL_MS = 5_000;
const GENERATION_TEMP_RETENTION_MS = 60_000;

type FilesystemMaintenanceRecord = {
  version: 1;
  authorityId: string;
  namespace: string;
  owner: string;
  token: string;
  deadlineAt: string;
};
type FilesystemMigrationStageToken = {
  version: 1;
  id: string;
  owner: string;
  generationId: string;
  generationDigest: string;
  sequence: number;
  predecessorId: string | null;
  auxiliaryWatermark: string;
};
type FilesystemMigrationExport = Omit<AuthorityExport, "generation"> & {
  generation: AuthorityGeneration<FilesystemAuthoritySnapshot>;
};

type FilesystemMaintenanceState = {
  context: MaintenanceFenceContext;
  token: string;
  lease: MaintenanceFenceLease;
  timer: ReturnType<typeof setInterval>;
  renewing: boolean;
  released: boolean;
};

/**
 * Default local Writable Authority. Generations are immutable directories;
 * HEAD is one atomically replaced pointer whose CAS is serialized by a short
 * lock file. A crashed candidate is never reachable from HEAD and can be
 * removed by cleanup without affecting the active generation.
 */
export class FilesystemAuthority implements WritableAuthority<
  FilesystemAuthoritySnapshot,
  FilesystemAuthorityCommand
> {
  readonly root: string;
  readonly authorityId: string;
  readonly namespace: string;
  readonly schemaVersion = 1;
  private readonly lockTimeoutMs: number;
  private readonly retentionCount: number;
  private readonly stagedIds = new Set<string>();
  private auxiliary: AuxiliaryState = { watermark: 0, sessions: {}, events: [] };
  private readonly maintenanceLeaseMs: number;
  private readonly maintenanceRenewIntervalMs: number;
  private readonly maintenanceLeases = new Map<string, FilesystemMaintenanceState>();
  private auxiliaryLoaded = false;
  private closed = false;
  private initialized = false;

  constructor(options: FilesystemAuthorityOptions | string) {
    const resolved = typeof options === "string" ? { root: options } : options;
    this.root = resolve(resolved.root);
    this.authorityId = resolved.authorityId ?? DEFAULT_AUTHORITY_ID;
    this.namespace = resolved.namespace ?? DEFAULT_NAMESPACE;
    this.lockTimeoutMs = resolved.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.retentionCount = resolved.retentionCount ?? DEFAULT_RETENTION_COUNT;
    this.maintenanceLeaseMs = resolved.maintenanceLeaseMs ?? DEFAULT_MAINTENANCE_LEASE_MS;
    this.maintenanceRenewIntervalMs =
      resolved.maintenanceRenewIntervalMs ??
      Math.min(
        DEFAULT_MAINTENANCE_RENEW_INTERVAL_MS,
        Math.max(1, Math.floor(this.maintenanceLeaseMs / 3)),
      );
    if (
      !Number.isSafeInteger(this.maintenanceLeaseMs) ||
      this.maintenanceLeaseMs < 10 ||
      this.maintenanceLeaseMs > 60_000
    ) {
      throw new CapletsError("CONFIG_INVALID", "Filesystem maintenance lease duration is invalid");
    }
    if (
      !Number.isSafeInteger(this.maintenanceRenewIntervalMs) ||
      this.maintenanceRenewIntervalMs < 1 ||
      this.maintenanceRenewIntervalMs >= this.maintenanceLeaseMs
    ) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Filesystem maintenance renewal interval is invalid",
      );
    }
    if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs <= 0) {
      throw new CapletsError("CONFIG_INVALID", "Filesystem authority lock timeout is invalid");
    }
    if (!Number.isSafeInteger(this.retentionCount) || this.retentionCount < 1) {
      throw new CapletsError("CONFIG_INVALID", "Filesystem authority retention count is invalid");
    }
    for (const id of resolved.stagedIds ?? []) this.stagedIds.add(id);
  }

  get headPath(): string {
    return join(this.root, "HEAD.json");
  }

  get generationsPath(): string {
    return join(this.root, "generations");
  }
  get migrationStagesPath(): string {
    return join(this.root, "migration-stages");
  }

  get auxiliaryPath(): string {
    return join(this.root, "auxiliary.json");
  }
  get maintenancePath(): string {
    return join(this.root, "maintenance.lock");
  }

  maintenanceFence(): MaintenanceFence {
    return {
      acquire: async (context) => await this.acquireMaintenanceFence(context),
      assertReadOnly: async (context) => await this.assertMaintenanceFence(context),
      assertStopped: async (context) => await this.assertMaintenanceFence(context),
      renew: async (lease, context) => await this.renewMaintenanceFence(lease, context),
      release: async (lease, context) => await this.releaseMaintenanceFence(lease, context),
    };
  }

  setStagedIds(ids: Iterable<string>): void {
    this.stagedIds.clear();
    for (const id of ids) this.stagedIds.add(id);
  }

  isCapletIdReserved(id: string): boolean {
    return this.stagedIds.has(id);
  }

  assertCapletIdAvailable(id: string): void {
    if (this.stagedIds.has(id)) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Caplet ID ${id} is reserved by a staged filesystem source`,
        {
          id,
          staged: true,
          authority: false,
        },
      );
    }
  }

  async initialize(): Promise<void> {
    if (this.closed) throw new CapletsError("CONFIG_INVALID", "Filesystem authority is closed");
    if (this.initialized) return;
    await mkdir(this.generationsPath, { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, "receipts"), { recursive: true, mode: 0o700 });
    await mkdir(this.migrationStagesPath, { recursive: true, mode: 0o700 });
    this.initialized = true;
  }

  async readHead(): Promise<AuthorityHead | null> {
    await this.initialize();
    try {
      const parsed = JSON.parse(await readFile(this.headPath, "utf8")) as unknown;
      const head = parseHead(parsed);
      if (head.authorityId !== this.authorityId) {
        throw new CapletsError(
          "CONFIG_INVALID",
          "Filesystem authority head identity does not match",
        );
      }
      const generation = await this.readGeneration(head.id);
      if (
        generation.authorityId !== head.authorityId ||
        generation.id !== head.id ||
        generation.sequence !== head.sequence ||
        generation.predecessorId !== head.predecessorId ||
        generation.digest !== head.digest
      ) {
        throw new CapletsError(
          "CONFIG_INVALID",
          "Filesystem authority head does not match its generation",
        );
      }
      return head;
    } catch (error) {
      if (isMissingFile(error)) return null;
      if (error instanceof CapletsError) throw error;
      throw new CapletsError("CONFIG_INVALID", "Filesystem authority head is invalid");
    }
  }

  async readGeneration(
    id: AuthorityGenerationId,
  ): Promise<AuthorityGeneration<FilesystemAuthoritySnapshot>> {
    await this.initialize();
    const safeId = generationPathId(id);
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readFile(join(this.generationsPath, safeId, "generation.json"), "utf8"),
      );
    } catch (error) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Filesystem authority generation ${id} is unavailable`,
        {
          reason: isMissingFile(error) ? "missing" : "invalid",
        },
      );
    }
    const generation = parseGeneration(parsed);
    if (generation.authorityId !== this.authorityId) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Filesystem authority generation ${id} identity is invalid`,
      );
    }
    const expectedDigest = digestForGeneration(generation);
    if (generation.digest !== expectedDigest) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Filesystem authority generation ${id} digest is invalid`,
      );
    }
    const encodedBytes = Buffer.byteLength(stableJsonStringify(generation), "utf8");
    if (encodedBytes > MAX_AUTHORITY_GENERATION_BYTES) {
      throw new CapletsError("CONFIG_INVALID", "Authority generation exceeds the 64 MiB limit");
    }
    return generation;
  }
  async commit<TResult = unknown>(
    envelope: SemanticCommandEnvelope<FilesystemAuthorityCommand>,
  ): Promise<AuthorityCommitResult<TResult>> {
    await this.initialize();
    this.assertOpen();
    if (envelope.authorityId !== this.authorityId) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Filesystem authority identity does not match command",
      );
    }
    const unlock = await this.acquireLock();
    try {
      await this.assertMaintenanceWriteAllowed();
      await this.loadAuxiliary();
      const activeHead = await this.readHead();
      const receipt = await this.readReceipt<TResult>(envelope);
      if (receipt) return { kind: "replayed", generation: receipt.generation, receipt };
      if (!sameIdentity(activeHead, envelope.expectedGeneration)) {
        return { kind: "conflict", active: activeHead };
      }
      const previous = activeHead ? await this.readGeneration(activeHead.id) : undefined;
      const snapshot = applyCommand(previous?.snapshot ?? { caplets: {} }, envelope.command);
      this.assertCommandIdsAvailable(envelope.command, snapshot);
      const sequence = (activeHead?.sequence ?? 0) + 1;
      const generation: AuthorityGeneration<FilesystemAuthoritySnapshot> = {
        authorityId: this.authorityId,
        id: randomUUID(),
        sequence,
        predecessorId: activeHead?.id ?? null,
        schemaVersion: 1,
        committedAt: new Date().toISOString(),
        provenance: { provider: "filesystem", namespace: this.namespace },
        digest: "",
        snapshot,
      };
      generation.digest = digestForGeneration(generation);
      assertGenerationSize(generation);
      const resultGeneration = identityOf(generation);
      const result: AuthorityReceipt<TResult> = {
        currentHostId: envelope.currentHostId,
        principalId: envelope.principalId,
        idempotencyKey: envelope.idempotencyKey,
        requestDigest: envelope.requestDigest,
        generation: resultGeneration,
        result: commandResult(envelope.command) as TResult,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
      const previousAuxiliary = structuredClone(this.auxiliary);
      let generationPublished = false;
      let auxiliaryPublished = false;
      try {
        // Keep HEAD unreachable until the receipt and auxiliary state are durable.
        await this.publishGenerationFiles(generation);
        generationPublished = true;
        await this.writeReceipt(envelope, result);
        this.nextAuxiliaryWatermark();
        await this.persistAuxiliary();
        auxiliaryPublished = true;
        await this.publishHead(generation);
        return { kind: "committed", generation: resultGeneration, receipt: result };
      } catch (error) {
        this.auxiliary = previousAuxiliary;
        if (auxiliaryPublished) {
          await this.persistAuxiliaryState(previousAuxiliary).catch(() => undefined);
        }
        await this.removeReceipt(envelope).catch(() => undefined);
        if (generationPublished) {
          await rm(join(this.generationsPath, generation.id), {
            recursive: true,
            force: true,
          }).catch(() => undefined);
        }
        throw error;
      }
    } finally {
      await unlock();
    }
  }

  async readAuxiliary(request: AuxiliaryRead): Promise<unknown> {
    await this.initialize();
    await this.loadAuxiliary();
    if (request.kind === "session_touch") {
      return this.auxiliary.sessions[request.sessionId];
    }
    if (request.kind === "security_events") {
      return this.auxiliary.events
        .filter(
          ({ watermark }) =>
            !request.afterWatermark || isWatermarkAfter(watermark, request.afterWatermark),
        )
        .slice(0, request.limit)
        .map(({ event }) => structuredClone(event));
    }
    return undefined;
  }
  async commitAuxiliary(command: AuxiliaryCommit): Promise<AuxiliaryCommitResult> {
    await this.initialize();
    this.assertOpen();
    const unlock = await this.acquireLock();
    try {
      await this.assertMaintenanceWriteAllowed();
      await this.loadAuxiliary();
      if (command.kind === "remove_session_touch") {
        if (!this.auxiliary.sessions[command.sessionId]) {
          return { kind: "unchanged", watermark: String(this.auxiliary.watermark) };
        }
        delete this.auxiliary.sessions[command.sessionId];
        const watermark = this.nextAuxiliaryWatermark();
        await this.persistAuxiliary();
        return { kind: "applied", watermark: String(watermark) };
      }
      if (command.kind === "session_touch") {
        const activeHead = await this.readHead();
        if (!sameIdentity(activeHead, command.expectedGeneration)) return { kind: "conflict" };
        const activeSnapshot = activeHead
          ? (await this.readGeneration(activeHead.id)).snapshot
          : {};
        const existing = this.auxiliary.sessions[command.sessionId];
        if (!semanticSessionExists(activeSnapshot, command.sessionId)) {
          return existing ? { kind: "revoked" } : { kind: "missing" };
        }
        if (!existing) {
          if (command.expectedRevision !== "") return { kind: "missing" };
          const watermark = this.nextAuxiliaryWatermark();
          this.auxiliary.sessions[command.sessionId] = {
            lastUsedAt: command.lastUsedAt,
            revision: String(watermark),
            revoked: false,
          };
          await this.persistAuxiliary();
          return { kind: "applied", watermark: String(watermark) };
        }
        if (existing.revoked === true) return { kind: "revoked" };
        if (existing.revision !== command.expectedRevision) return { kind: "conflict" };
        if (existing.lastUsedAt >= command.lastUsedAt) {
          return { kind: "unchanged", watermark: String(this.auxiliary.watermark) };
        }
        const watermark = this.nextAuxiliaryWatermark();
        this.auxiliary.sessions[command.sessionId] = {
          lastUsedAt: command.lastUsedAt,
          revision: String(watermark),
          revoked: false,
        };
        await this.persistAuxiliary();
        return { kind: "applied", watermark: String(watermark) };
      }
      const watermark = this.nextAuxiliaryWatermark();
      this.auxiliary.events.push({
        watermark: String(watermark),
        event: structuredClone(command.event),
      });
      this.auxiliary.events = this.auxiliary.events.slice(-10_000);
      await this.persistAuxiliary();
      return { kind: "applied", watermark: String(watermark) };
    } finally {
      await unlock();
    }
  }

  async health(): Promise<AuthorityHealth> {
    try {
      const activeGeneration = await this.readHead();
      return {
        provider: "filesystem",
        authorityId: this.authorityId,
        connectivity: "healthy",
        writable: !this.closed,
        activeGeneration: activeGeneration
          ? {
              authorityId: activeGeneration.authorityId,
              id: activeGeneration.id,
              sequence: activeGeneration.sequence,
              predecessorId: activeGeneration.predecessorId,
            }
          : null,
        refresh: "current",
      };
    } catch {
      return {
        provider: "filesystem",
        authorityId: this.authorityId,
        connectivity: "degraded",
        writable: false,
        activeGeneration: null,
        refresh: "failed",
        code: "UNAVAILABLE",
      };
    }
  }

  async exportState(): Promise<AuthorityExport> {
    await this.initialize();
    this.assertOpen();
    const unlock = await this.acquireLock();
    try {
      const head = await this.readHead();
      if (!head)
        throw new CapletsError(
          "CONFIG_INVALID",
          "Filesystem authority has no committed generation",
        );
      const generation = await this.readGeneration(head.id);
      await this.loadAuxiliary();
      const auxiliary = this.exportAuxiliary();
      const receipts = await this.readReceipts(Date.now());
      return {
        generation,
        auxiliaryWatermark: String(this.auxiliary.watermark),
        receipts,
        auxiliary,
      };
    } finally {
      await unlock();
    }
  }

  async restoreState(
    state: AuthorityExport,
  ): Promise<{ generation: AuthorityGenerationIdentity; auxiliaryWatermark: string }> {
    await this.initialize();
    this.assertOpen();
    const unlock = await this.acquireLock();
    try {
      await this.assertMaintenanceWriteAllowed();
      const generation = parseGeneration(state?.generation);
      if (
        generation.authorityId !== this.authorityId ||
        generation.provenance.provider !== "filesystem" ||
        generation.provenance.namespace !== this.namespace
      ) {
        throw new CapletsError(
          "CONFIG_INVALID",
          "Filesystem restore authority identity does not match",
        );
      }
      if (generation.digest !== digestForGeneration(generation)) {
        throw new CapletsError("CONFIG_INVALID", "Filesystem restore generation digest is invalid");
      }
      const auxiliary = parseExportAuxiliary(state.auxiliary, state.auxiliaryWatermark);
      const receipts = parseExportReceipts(state.receipts, generation, Date.now());
      const activeHead = await this.readHead();
      if (
        activeHead &&
        (!sameIdentity(activeHead, identityOf(generation)) ||
          activeHead.digest !== generation.digest)
      ) {
        throw new CapletsError(
          "CONFIG_EXISTS",
          "Filesystem restore would overwrite a non-empty authority",
        );
      }
      await this.publishGenerationFiles(generation);
      await this.persistAuxiliaryState(auxiliary);
      await this.replaceReceipts(receipts);
      await this.publishHead(generation);
      this.auxiliary = auxiliary;
      this.auxiliaryLoaded = true;
      return {
        generation: identityOf(generation),
        auxiliaryWatermark: String(auxiliary.watermark),
      };
    } finally {
      await unlock();
    }
  }

  async stageMigration(
    state: AuthorityExport,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityMigrationStage> {
    await this.initialize();
    this.assertOpen();
    if (!context.owner) {
      throw new CapletsError("CONFIG_INVALID", "Filesystem migration stage owner is required");
    }
    const unlock = await this.acquireLock();
    try {
      await this.assertMaintenanceWriteAllowed();
      const generation = parseGeneration(state?.generation);
      generationPathId(generation.id);
      if (
        generation.authorityId !== this.authorityId ||
        generation.provenance.provider !== "filesystem" ||
        generation.provenance.namespace !== this.namespace ||
        generation.digest !== digestForGeneration(generation)
      ) {
        throw new CapletsError(
          "CONFIG_INVALID",
          "Filesystem migration stage generation identity is invalid",
        );
      }
      const auxiliary = parseExportAuxiliary(state.auxiliary, state.auxiliaryWatermark);
      const receipts = parseExportReceipts(state.receipts, generation, Date.now());
      const activeHead = await this.readHead();
      if (activeHead) {
        throw new CapletsError(
          "CONFIG_EXISTS",
          "Filesystem migration destination is no longer empty",
        );
      }
      const token: FilesystemMigrationStageToken = {
        version: 1,
        id: randomUUID(),
        owner: context.owner,
        generationId: generation.id,
        generationDigest: generation.digest,
        sequence: generation.sequence,
        predecessorId: generation.predecessorId,
        auxiliaryWatermark: String(auxiliary.watermark),
      };
      const stageRoot = join(this.migrationStagesPath, token.id);
      try {
        await mkdir(join(stageRoot, "receipts"), { recursive: true, mode: 0o700 });
        await writeFile(join(stageRoot, "generation.json"), stableJsonStringify(generation), {
          mode: 0o600,
        });
        await writeFile(
          join(stageRoot, "auxiliary.json"),
          stableJsonStringify(
            state.auxiliary ?? {
              watermark: String(auxiliary.watermark),
              sessions: {},
              securityEvents: [],
            },
          ),
          { mode: 0o600 },
        );
        for (const receipt of receipts) {
          const key = receiptKeyForValues(
            receipt.currentHostId,
            receipt.principalId,
            receipt.idempotencyKey,
          );
          await writeFile(
            join(stageRoot, "receipts", `${key}.json`),
            stableJsonStringify(receipt),
            { mode: 0o600 },
          );
        }
      } catch (error) {
        await rm(stageRoot, { recursive: true, force: true });
        throw new CapletsError("CONFIG_INVALID", "Filesystem migration stage publication failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return { token };
    } finally {
      await unlock();
    }
  }

  async readMigrationStage(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityExport> {
    await this.initialize();
    this.assertOpen();
    const unlock = await this.acquireLock();
    try {
      return await this.readMigrationStageFiles(stage, context);
    } finally {
      await unlock();
    }
  }

  async publishMigrationStage(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<AuthorityRestoreResult> {
    await this.initialize();
    this.assertOpen();
    const unlock = await this.acquireLock();
    try {
      await this.assertMaintenanceWriteAllowed();
      const token = parseMigrationStageToken(stage.token, context.owner);
      const activeHead = await this.readHead();
      if (activeHead) {
        if (
          activeHead.id === token.generationId &&
          activeHead.digest === token.generationDigest &&
          activeHead.sequence === token.sequence &&
          activeHead.predecessorId === token.predecessorId
        ) {
          return {
            generation: {
              authorityId: this.authorityId,
              id: token.generationId,
              sequence: token.sequence,
              predecessorId: token.predecessorId,
            },
            auxiliaryWatermark: token.auxiliaryWatermark,
          };
        }
        throw new CapletsError(
          "CONFIG_EXISTS",
          "Filesystem migration destination is no longer empty",
        );
      }
      await this.loadAuxiliary();
      const previousAuxiliary = structuredClone(this.auxiliary);
      const previousReceipts = await this.readReceipts(Date.now());
      const staged = await this.readMigrationStageFiles(stage, context);
      const auxiliary = parseExportAuxiliary(staged.auxiliary, staged.auxiliaryWatermark);
      const receipts = parseExportReceipts(staged.receipts, staged.generation, Date.now());
      let generationPublished = false;
      let headPublished = false;
      try {
        await this.publishGenerationFiles(staged.generation);
        generationPublished = true;
        await this.persistAuxiliaryState(auxiliary);
        await this.replaceReceipts(receipts);
        await this.publishHead(staged.generation);
        headPublished = true;
        this.auxiliary = auxiliary;
        this.auxiliaryLoaded = true;
        await rm(join(this.migrationStagesPath, token.id), { recursive: true, force: true });
        return {
          generation: identityOf(staged.generation),
          auxiliaryWatermark: String(auxiliary.watermark),
        };
      } catch (error) {
        if (headPublished) throw error;
        this.auxiliary = previousAuxiliary;
        await this.persistAuxiliaryState(previousAuxiliary).catch(() => undefined);
        await this.replaceReceipts(previousReceipts).catch(() => undefined);
        if (generationPublished) {
          await rm(join(this.generationsPath, staged.generation.id), {
            recursive: true,
            force: true,
          }).catch(() => undefined);
        }
        throw error;
      }
    } finally {
      await unlock();
    }
  }

  async invalidateMigrationStage(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<void> {
    await this.initialize();
    this.assertOpen();
    const unlock = await this.acquireLock();
    try {
      await this.assertMaintenanceWriteAllowed();
      const token = parseMigrationStageToken(stage.token, context.owner);
      const activeHead = await this.readHead();
      if (
        activeHead &&
        activeHead.id === token.generationId &&
        activeHead.digest === token.generationDigest
      ) {
        return;
      }
      await rm(join(this.migrationStagesPath, token.id), { recursive: true, force: true });
      if (!activeHead) {
        await rm(join(this.generationsPath, token.generationId), {
          recursive: true,
          force: true,
        });
      }
    } finally {
      await unlock();
    }
  }

  async cleanupGenerations(
    options: {
      pinnedIds?: Iterable<string>;
      now?: number;
      retentionCount?: number;
    } = {},
  ): Promise<string[]> {
    await this.initialize();
    // Publication and cleanup share ownership of HEAD.lock. A fresh temp
    // directory is retained as an additional guard for an interrupted owner.
    const unlock = await this.acquireLock();
    try {
      const now = options.now ?? Date.now();
      const head = await this.readHead();
      const pinned = new Set(options.pinnedIds ?? []);
      const keep = new Set<string>(head ? [head.id] : []);
      const candidates: Array<{ id: string; committedAt: number }> = [];
      for (const entry of await readdir(this.generationsPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.includes(".tmp-")) {
          try {
            const metadata = await stat(join(this.generationsPath, entry.name));
            if (metadata.mtimeMs > now - GENERATION_TEMP_RETENTION_MS) continue;
          } catch {
            continue;
          }
          await rm(join(this.generationsPath, entry.name), { recursive: true, force: true });
          continue;
        }
        try {
          const generation = await this.readGeneration(entry.name);
          candidates.push({
            id: generation.id,
            committedAt: Date.parse(generation.committedAt) || 0,
          });
        } catch {
          if (entry.name !== head?.id && !pinned.has(entry.name)) {
            await rm(join(this.generationsPath, entry.name), { recursive: true, force: true });
          }
        }
      }
      candidates.sort((left, right) => right.committedAt - left.committedAt);
      for (const candidate of candidates.slice(0, options.retentionCount ?? this.retentionCount)) {
        keep.add(candidate.id);
      }
      for (const id of pinned) keep.add(id);
      const removed: string[] = [];
      for (const candidate of candidates) {
        if (keep.has(candidate.id)) continue;
        await rm(join(this.generationsPath, candidate.id), { recursive: true, force: true });
        removed.push(candidate.id);
      }
      return removed;
    } finally {
      await unlock();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    for (const state of this.maintenanceLeases.values()) {
      await this.releaseMaintenanceFence(state.lease, state.context);
    }
    this.closed = true;
  }

  private async readMigrationStageFiles(
    stage: AuthorityMigrationStage,
    context: AuthorityMigrationStageContext,
  ): Promise<FilesystemMigrationExport> {
    const token = parseMigrationStageToken(stage.token, context.owner);
    const stageRoot = join(this.migrationStagesPath, token.id);
    let generation: AuthorityGeneration<FilesystemAuthoritySnapshot>;
    let auxiliaryValue: unknown;
    const rawReceipts: unknown[] = [];
    try {
      generation = parseGeneration(
        JSON.parse(await readFile(join(stageRoot, "generation.json"), "utf8")),
      );
      auxiliaryValue = JSON.parse(await readFile(join(stageRoot, "auxiliary.json"), "utf8"));
      for (const entry of await readdir(join(stageRoot, "receipts"), { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        rawReceipts.push(
          JSON.parse(await readFile(join(stageRoot, "receipts", entry.name), "utf8")),
        );
      }
    } catch (error) {
      throw new CapletsError("CONFIG_INVALID", "Filesystem migration stage is unavailable", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (
      generation.authorityId !== this.authorityId ||
      generation.id !== token.generationId ||
      generation.digest !== token.generationDigest ||
      generation.sequence !== token.sequence ||
      generation.predecessorId !== token.predecessorId ||
      generation.digest !== digestForGeneration(generation)
    ) {
      throw new CapletsError("CONFIG_INVALID", "Filesystem migration stage generation is invalid");
    }
    if (!isRecord(auxiliaryValue) || typeof auxiliaryValue.watermark !== "string") {
      throw new CapletsError("CONFIG_INVALID", "Filesystem migration stage auxiliary is invalid");
    }
    const auxiliary = parseExportAuxiliary(auxiliaryValue, auxiliaryValue.watermark);
    const receipts = parseExportReceipts(rawReceipts, generation, Date.now());
    return {
      generation,
      auxiliaryWatermark: String(auxiliary.watermark),
      receipts,
      auxiliary: exportAuxiliaryState(auxiliary),
    };
  }

  private validateMaintenanceContext(context: MaintenanceFenceContext): void {
    if (
      context.authorityId !== this.authorityId ||
      context.namespace !== this.namespace ||
      context.owner.length === 0
    ) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Filesystem maintenance fence identity does not match",
      );
    }
  }

  private maintenanceKey(context: MaintenanceFenceContext): string {
    return `${context.operation}:${context.role}:${context.owner}`;
  }

  private maintenanceHeld(): CapletsError {
    return new CapletsError(
      "SERVER_UNAVAILABLE",
      "Filesystem authority is held by a maintenance owner",
    );
  }

  private async acquireMaintenanceFence(
    context: MaintenanceFenceContext,
  ): Promise<MaintenanceFenceLease> {
    await this.initialize();
    this.assertOpen();
    this.validateMaintenanceContext(context);
    const key = this.maintenanceKey(context);
    const existingLocal = this.maintenanceLeases.get(key);
    if (existingLocal && !existingLocal.released) return existingLocal.lease;
    const unlock = await this.acquireLock();
    try {
      const current = await this.readMaintenanceLease();
      const now = Date.now();
      if (current && Date.parse(current.deadlineAt) > now) throw this.maintenanceHeld();
      if (current) await rm(this.maintenancePath, { force: true });
      const token = randomUUID();
      const record: FilesystemMaintenanceRecord = {
        version: 1,
        authorityId: this.authorityId,
        namespace: this.namespace,
        owner: context.owner,
        token,
        deadlineAt: new Date(now + this.maintenanceLeaseMs).toISOString(),
      };
      await this.writeMaintenanceLease(record);
      const lease: MaintenanceFenceLease = {
        token,
        renew: async () => await this.renewMaintenanceFence({ token }, context),
        release: async () => await this.releaseMaintenanceFence({ token }, context),
      };
      const timer = setInterval(() => {
        void this.renewMaintenanceFence({ token }, context).catch(() => undefined);
      }, this.maintenanceRenewIntervalMs);
      timer.unref?.();
      this.maintenanceLeases.set(key, {
        context,
        token,
        lease,
        timer,
        renewing: false,
        released: false,
      });
      return lease;
    } finally {
      await unlock();
    }
  }

  private async assertMaintenanceFence(context: MaintenanceFenceContext): Promise<void> {
    await this.initialize();
    this.assertOpen();
    this.validateMaintenanceContext(context);
    const unlock = await this.acquireLock();
    try {
      const current = await this.readMaintenanceLease();
      if (!current || Date.parse(current.deadlineAt) <= Date.now()) {
        if (current) await rm(this.maintenancePath, { force: true });
        throw this.maintenanceHeld();
      }
      const local = [...this.maintenanceLeases.values()].find(
        (state) =>
          !state.released && state.context.owner === context.owner && state.token === current.token,
      );
      if (!local) throw this.maintenanceHeld();
    } finally {
      await unlock();
    }
  }

  private async assertMaintenanceWriteAllowed(): Promise<void> {
    const current = await this.readMaintenanceLease();
    if (!current) return;
    if (Date.parse(current.deadlineAt) <= Date.now()) {
      await rm(this.maintenancePath, { force: true });
      for (const state of this.maintenanceLeases.values()) {
        if (state.token === current.token) {
          state.released = true;
          clearInterval(state.timer);
        }
      }
      return;
    }
    const local = [...this.maintenanceLeases.values()].find(
      (state) =>
        !state.released && state.token === current.token && state.context.owner === current.owner,
    );
    if (!local) throw this.maintenanceHeld();
  }

  private async renewMaintenanceFence(
    lease: MaintenanceFenceLease | void,
    context: MaintenanceFenceContext,
  ): Promise<void> {
    await this.initialize();
    this.assertOpen();
    this.validateMaintenanceContext(context);
    const token = lease?.token;
    if (!token)
      throw new CapletsError("CONFIG_INVALID", "Filesystem maintenance lease token is missing");
    const state = [...this.maintenanceLeases.values()].find(
      (candidate) => candidate.token === token && candidate.context.owner === context.owner,
    );
    if (!state || state.released) throw this.maintenanceHeld();
    if (state.renewing) return;
    state.renewing = true;
    try {
      const unlock = await this.acquireLock();
      try {
        const current = await this.readMaintenanceLease();
        if (
          !current ||
          current.token !== token ||
          current.owner !== context.owner ||
          Date.parse(current.deadlineAt) <= Date.now()
        ) {
          state.released = true;
          clearInterval(state.timer);
          throw this.maintenanceHeld();
        }
        await this.writeMaintenanceLease({
          ...current,
          deadlineAt: new Date(Date.now() + this.maintenanceLeaseMs).toISOString(),
        });
      } finally {
        await unlock();
      }
    } finally {
      state.renewing = false;
    }
  }

  private async releaseMaintenanceFence(
    lease: MaintenanceFenceLease | void,
    context: MaintenanceFenceContext,
  ): Promise<void> {
    this.validateMaintenanceContext(context);
    const token = lease?.token;
    if (!token) return;
    const key = this.maintenanceKey(context);
    const state = this.maintenanceLeases.get(key);
    if (!state || state.token !== token || state.context.owner !== context.owner) return;
    if (state && state.token === token) {
      state.released = true;
      clearInterval(state.timer);
      this.maintenanceLeases.delete(key);
    }
    if (this.closed) return;
    const unlock = await this.acquireLock();
    try {
      const current = await this.readMaintenanceLease();
      if (current && current.token === token && current.owner === context.owner) {
        await rm(this.maintenancePath, { force: true });
      }
    } finally {
      await unlock();
    }
  }

  private async readMaintenanceLease(): Promise<FilesystemMaintenanceRecord | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.maintenancePath, "utf8")) as unknown;
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw new CapletsError("CONFIG_INVALID", "Filesystem maintenance lease is invalid");
    }
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      parsed.authorityId !== this.authorityId ||
      parsed.namespace !== this.namespace ||
      typeof parsed.owner !== "string" ||
      parsed.owner.length === 0 ||
      typeof parsed.token !== "string" ||
      parsed.token.length === 0 ||
      typeof parsed.deadlineAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.deadlineAt))
    ) {
      throw new CapletsError("CONFIG_INVALID", "Filesystem maintenance lease is invalid");
    }
    return parsed as unknown as FilesystemMaintenanceRecord;
  }

  private async writeMaintenanceLease(record: FilesystemMaintenanceRecord): Promise<void> {
    const temporary = `${this.maintenancePath}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await rename(temporary, this.maintenancePath);
    } catch {
      await rm(temporary, { force: true });
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        "Filesystem maintenance lease publication failed",
      );
    }
  }

  private async loadAuxiliary(): Promise<void> {
    if (this.auxiliaryLoaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.auxiliaryPath, "utf8")) as unknown;
      this.auxiliary = parseAuxiliaryStorage(parsed);
    } catch (error) {
      if (!isMissingFile(error)) {
        if (error instanceof CapletsError) throw error;
        throw new CapletsError("CONFIG_INVALID", "Filesystem authority auxiliary state is invalid");
      }
    }
    this.auxiliaryLoaded = true;
  }

  private nextAuxiliaryWatermark(): number {
    if (this.auxiliary.watermark >= Number.MAX_SAFE_INTEGER) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Filesystem authority auxiliary watermark exhausted",
      );
    }
    this.auxiliary.watermark += 1;
    return this.auxiliary.watermark;
  }

  private exportAuxiliary(): AuthorityAuxiliaryExport {
    return exportAuxiliaryState(this.auxiliary);
  }

  private async persistAuxiliary(): Promise<void> {
    await this.persistAuxiliaryState(this.auxiliary);
  }

  private async persistAuxiliaryState(state: AuxiliaryState): Promise<void> {
    const temporary = `${this.auxiliaryPath}.tmp-${randomUUID()}`;
    const encoded = stableJsonStringify(state);
    try {
      await writeFile(temporary, encoded, { mode: 0o600 });
      await rename(temporary, this.auxiliaryPath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw new CapletsError(
        "CONFIG_INVALID",
        "Filesystem authority auxiliary publication failed",
        {
          reason: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private async publishGeneration(
    generation: AuthorityGeneration<FilesystemAuthoritySnapshot>,
  ): Promise<void> {
    await this.publishGenerationFiles(generation);
    await this.publishHead(generation);
  }

  private async publishGenerationFiles(
    generation: AuthorityGeneration<FilesystemAuthoritySnapshot>,
  ): Promise<void> {
    const finalDirectory = join(this.generationsPath, generation.id);
    const temporaryDirectory = `${finalDirectory}.tmp-${randomUUID()}`;
    await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(
        join(temporaryDirectory, "generation.json"),
        stableJsonStringify(generation),
        { mode: 0o600 },
      );
      try {
        await rename(temporaryDirectory, finalDirectory);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await rm(temporaryDirectory, { recursive: true, force: true });
        const existing = await this.readGeneration(generation.id);
        if (existing.digest !== generation.digest) {
          throw new CapletsError(
            "CONFIG_INVALID",
            "Filesystem authority generation already exists with a different digest",
          );
        }
      }
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      if (error instanceof CapletsError) throw error;
      throw new CapletsError(
        "CONFIG_INVALID",
        "Filesystem authority generation publication failed",
        {
          reason: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private async publishHead(
    generation: AuthorityGeneration<FilesystemAuthoritySnapshot>,
  ): Promise<void> {
    const temporaryHead = `${this.headPath}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporaryHead, stableJsonStringify(identityHead(generation)), {
        mode: 0o600,
      });
      await rename(temporaryHead, this.headPath);
    } catch (error) {
      await rm(temporaryHead, { force: true });
      throw new CapletsError("CONFIG_INVALID", "Filesystem authority head publication failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    const lockPath = join(this.root, "HEAD.lock");
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        return async () => {
          await handle.close();
          await rm(lockPath, { force: true });
        };
      } catch (error) {
        if (Date.now() >= deadline) {
          throw new CapletsError(
            "CONFIG_INVALID",
            "Filesystem authority lock acquisition timed out",
          );
        }
        await delay(5);
        if (!isAlreadyExists(error)) throw error;
      }
    }
  }

  private async readReceipt<TResult>(
    envelope: SemanticCommandEnvelope<FilesystemAuthorityCommand>,
  ): Promise<AuthorityReceipt<TResult> | undefined> {
    const key = receiptKey(envelope);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(this.root, "receipts", `${key}.json`), "utf8"));
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw new CapletsError("CONFIG_INVALID", "Filesystem authority receipt is invalid");
    }
    const receipt = parseReceipt(parsed, Date.now()) as AuthorityReceipt<TResult>;
    if (receipt.expiresAt && Date.parse(receipt.expiresAt) <= Date.now()) return undefined;
    if (receipt.requestDigest !== envelope.requestDigest) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Idempotency key was reused with a different request payload",
      );
    }
    return receipt;
  }

  private async readReceipts(now: number): Promise<AuthorityReceipt<unknown>[]> {
    const receipts: AuthorityReceipt<unknown>[] = [];
    const seen = new Set<string>();
    for (const entry of await readdir(join(this.root, "receipts"), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(join(this.root, "receipts", entry.name), "utf8"));
      } catch {
        throw new CapletsError("CONFIG_INVALID", "Filesystem authority receipt is invalid");
      }
      const receipt = parseReceipt(parsed, now);
      if (Date.parse(receipt.expiresAt) <= now) continue;
      const key = receiptKeyForValues(
        receipt.currentHostId,
        receipt.principalId,
        receipt.idempotencyKey,
      );
      if (seen.has(key))
        throw new CapletsError(
          "CONFIG_INVALID",
          "Filesystem authority has duplicate receipt records",
        );
      seen.add(key);
      receipts.push(receipt);
    }
    receipts.sort(
      (left, right) =>
        left.currentHostId.localeCompare(right.currentHostId) ||
        left.principalId.localeCompare(right.principalId) ||
        left.idempotencyKey.localeCompare(right.idempotencyKey),
    );
    return receipts;
  }

  private async replaceReceipts(receipts: readonly AuthorityReceipt<unknown>[]): Promise<void> {
    const receiptsPath = join(this.root, "receipts");
    const temporary = `${receiptsPath}.tmp-${randomUUID()}`;
    const previous = `${receiptsPath}.old-${randomUUID()}`;
    let movedPrevious = false;
    let installed = false;
    try {
      await mkdir(temporary, { recursive: true, mode: 0o700 });
      const seen = new Set<string>();
      for (const receipt of receipts) {
        const key = receiptKeyForValues(
          receipt.currentHostId,
          receipt.principalId,
          receipt.idempotencyKey,
        );
        if (seen.has(key))
          throw new CapletsError(
            "CONFIG_INVALID",
            "Filesystem restore contains duplicate receipts",
          );
        seen.add(key);
        await writeFile(join(temporary, `${key}.json`), stableJsonStringify(receipt), {
          mode: 0o600,
        });
      }
      try {
        await rename(receiptsPath, previous);
        movedPrevious = true;
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
      await rename(temporary, receiptsPath);
      installed = true;
      if (movedPrevious) await rm(previous, { recursive: true, force: true });
    } catch (error) {
      if (movedPrevious && !installed) {
        await rename(previous, receiptsPath).catch(() => undefined);
      }
      if (error instanceof CapletsError) throw error;
      throw new CapletsError("CONFIG_INVALID", "Filesystem authority receipt restore failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await rm(temporary, { recursive: true, force: true });
      if (installed && movedPrevious) await rm(previous, { recursive: true, force: true });
    }
  }

  private async writeReceipt<TResult>(
    envelope: SemanticCommandEnvelope<FilesystemAuthorityCommand>,
    receipt: AuthorityReceipt<TResult>,
  ): Promise<void> {
    const target = join(this.root, "receipts", `${receiptKey(envelope)}.json`);
    const temporary = `${target}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, stableJsonStringify(receipt), { mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw new CapletsError("CONFIG_INVALID", "Filesystem authority receipt publication failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  private async removeReceipt(
    envelope: SemanticCommandEnvelope<FilesystemAuthorityCommand>,
  ): Promise<void> {
    await rm(join(this.root, "receipts", `${receiptKey(envelope)}.json`), { force: true });
  }

  private assertCommandIdsAvailable(
    command: FilesystemAuthorityCommand,
    snapshot: FilesystemAuthoritySnapshot,
  ): void {
    for (const id of commandCapletIds(command, snapshot)) this.assertCapletIdAvailable(id);
  }

  private assertOpen(): void {
    if (this.closed) throw new CapletsError("CONFIG_INVALID", "Filesystem authority is closed");
  }
}

export async function createFilesystemAuthority(
  options: FilesystemAuthorityOptions | string,
): Promise<FilesystemAuthority> {
  const authority = new FilesystemAuthority(options);
  await authority.initialize();
  return authority;
}
function commandResult(command: FilesystemAuthorityCommand): unknown {
  const record = command as unknown as Record<string, unknown>;
  if (!Object.hasOwn(record, "result")) return null;
  return record.result === undefined ? null : structuredClone(record.result);
}
function applyCommand(
  previous: FilesystemAuthoritySnapshot,
  command: FilesystemAuthorityCommand,
): FilesystemAuthoritySnapshot {
  if ("kind" in command && command.kind === "set_caplets") {
    return { ...cloneSnapshot(previous), caplets: cloneRecords(command.caplets) };
  }
  if ("kind" in command && command.kind === "replace_snapshot" && nestedSnapshot(command)) {
    return cloneNestedSnapshot(command.snapshot);
  }
  if (nestedSnapshot(command)) {
    return cloneNestedSnapshot(command.snapshot);
  }
  if (isSnapshot(command)) return cloneSnapshot(command);
  if (!("kind" in command)) {
    throw new CapletsError("CONFIG_INVALID", "Filesystem authority command is unsupported");
  }
  if (command.kind === "create_caplet" || command.kind === "install_caplet") {
    const record = command.record;
    if (previous.caplets[record.id])
      throw new CapletsError("CONFIG_INVALID", `Authority Caplet ${record.id} already exists`);
    return { ...cloneSnapshot(previous), caplets: { ...previous.caplets, [record.id]: record } };
  }
  if (command.kind === "update_caplet") {
    if (!previous.caplets[command.id])
      throw new CapletsError("CONFIG_INVALID", `Authority Caplet ${command.id} does not exist`);
    return {
      ...cloneSnapshot(previous),
      caplets: { ...previous.caplets, [command.id]: { ...command.record, id: command.id } },
    };
  }
  if (command.kind === "delete_caplet") {
    const { [command.id]: _removed, ...remaining } = previous.caplets;
    return { ...cloneSnapshot(previous), caplets: remaining };
  }
  throw new CapletsError("CONFIG_INVALID", "Filesystem authority command is unsupported");
}

function commandCapletIds(
  command: FilesystemAuthorityCommand,
  snapshot: FilesystemAuthoritySnapshot,
): string[] {
  if ("kind" in command && command.kind === "set_caplets") return Object.keys(command.caplets);
  if (isSnapshot(command) || !("kind" in command)) {
    return isRecord(snapshot.caplets) ? Object.keys(snapshot.caplets) : [];
  }
  if (command.kind === "create_caplet" || command.kind === "install_caplet")
    return [command.record.id];
  if (command.kind === "update_caplet" || command.kind === "delete_caplet") return [command.id];
  if (nestedSnapshot(command) && isRecord(command.snapshot.caplets)) {
    return Object.keys(command.snapshot.caplets);
  }
  return isRecord(snapshot.caplets) ? Object.keys(snapshot.caplets) : [];
}

function nestedSnapshot(value: unknown): value is { snapshot: Record<string, unknown> } {
  return isRecord(value) && isRecord(value.snapshot);
}

function cloneNestedSnapshot(snapshot: Record<string, unknown>): FilesystemAuthoritySnapshot {
  return structuredClone(snapshot) as FilesystemAuthoritySnapshot;
}

function isSnapshot(value: FilesystemAuthorityCommand): value is FilesystemAuthoritySnapshot {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Object.hasOwn(value, "kind") &&
    Object.hasOwn(value, "caplets")
  );
}

function cloneSnapshot(snapshot: FilesystemAuthoritySnapshot): FilesystemAuthoritySnapshot {
  return structuredClone(snapshot);
}

function cloneRecords(
  records: Record<string, AuthorityCapletRecord>,
): Record<string, AuthorityCapletRecord> {
  return structuredClone(records);
}

function parseHead(value: unknown): AuthorityHead {
  if (
    !isRecord(value) ||
    typeof value.authorityId !== "string" ||
    typeof value.id !== "string" ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    (value.predecessorId !== null && typeof value.predecessorId !== "string") ||
    typeof value.digest !== "string"
  ) {
    throw new CapletsError("CONFIG_INVALID", "Filesystem authority head is invalid");
  }
  return {
    authorityId: value.authorityId,
    id: value.id,
    sequence: value.sequence,
    predecessorId: value.predecessorId,
    digest: value.digest,
  };
}

function parseGeneration(value: unknown): AuthorityGeneration<FilesystemAuthoritySnapshot> {
  if (
    !isRecord(value) ||
    !isRecord(value.snapshot) ||
    !isRecord(value.provenance) ||
    typeof value.authorityId !== "string" ||
    typeof value.id !== "string" ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    (value.predecessorId !== null && typeof value.predecessorId !== "string") ||
    typeof value.schemaVersion !== "number" ||
    !Number.isSafeInteger(value.schemaVersion) ||
    value.schemaVersion < 1 ||
    typeof value.committedAt !== "string" ||
    typeof value.digest !== "string" ||
    value.provenance.provider !== "filesystem" ||
    typeof value.provenance.namespace !== "string"
  ) {
    throw new CapletsError("CONFIG_INVALID", "Filesystem authority generation is invalid");
  }
  return value as unknown as AuthorityGeneration<FilesystemAuthoritySnapshot>;
}

function digestForGeneration(generation: AuthorityGeneration<FilesystemAuthoritySnapshot>): string {
  const payload = {
    authorityId: generation.authorityId,
    id: generation.id,
    sequence: generation.sequence,
    predecessorId: generation.predecessorId,
    schemaVersion: generation.schemaVersion,
    committedAt: generation.committedAt,
    provenance: generation.provenance,
    snapshot: generation.snapshot,
  };
  return `sha256:${createHash("sha256").update(stableJsonStringify(payload)).digest("hex")}`;
}

function identityHead(generation: AuthorityGeneration<FilesystemAuthoritySnapshot>): AuthorityHead {
  return { ...identityOf(generation), digest: generation.digest };
}

function identityOf(
  generation: AuthorityGeneration<FilesystemAuthoritySnapshot>,
): AuthorityGenerationIdentity {
  return {
    authorityId: generation.authorityId,
    id: generation.id,
    sequence: generation.sequence,
    predecessorId: generation.predecessorId,
  };
}

function sameIdentity(
  head: AuthorityHead | null,
  expected: AuthorityGenerationIdentity | null,
): boolean {
  if (!head || !expected) return head === null && expected === null;
  return (
    head.authorityId === expected.authorityId &&
    head.id === expected.id &&
    head.sequence === expected.sequence &&
    head.predecessorId === expected.predecessorId
  );
}

function assertGenerationSize(generation: AuthorityGeneration<FilesystemAuthoritySnapshot>): void {
  if (Buffer.byteLength(stableJsonStringify(generation), "utf8") > MAX_AUTHORITY_GENERATION_BYTES) {
    throw new CapletsError("CONFIG_INVALID", "Authority generation exceeds the 64 MiB limit");
  }
}

function generationPathId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(id))
    throw new CapletsError("CONFIG_INVALID", "Authority generation ID is invalid");
  return id;
}
function parseMigrationStageToken(value: unknown, owner: string): FilesystemMigrationStageToken {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    typeof value.owner !== "string" ||
    value.owner !== owner ||
    typeof value.generationId !== "string" ||
    typeof value.generationDigest !== "string" ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    (value.predecessorId !== null && typeof value.predecessorId !== "string") ||
    typeof value.auxiliaryWatermark !== "string"
  ) {
    throw new CapletsError("CONFIG_INVALID", "Filesystem migration stage token is invalid");
  }
  generationPathId(value.id);
  generationPathId(value.generationId);
  parseExportWatermark(value.auxiliaryWatermark);
  return {
    version: 1,
    id: value.id,
    owner: value.owner,
    generationId: value.generationId,
    generationDigest: value.generationDigest,
    sequence: value.sequence,
    predecessorId: value.predecessorId,
    auxiliaryWatermark: value.auxiliaryWatermark,
  };
}

function receiptKey(envelope: SemanticCommandEnvelope<FilesystemAuthorityCommand>): string {
  return receiptKeyForValues(envelope.currentHostId, envelope.principalId, envelope.idempotencyKey);
}

function receiptKeyForValues(
  currentHostId: string,
  principalId: string,
  idempotencyKey: string,
): string {
  return createHash("sha256")
    .update(`${currentHostId}\0${principalId}\0${idempotencyKey}`)
    .digest("hex");
}
type AuxiliarySession = { lastUsedAt: string; revision: string; revoked: boolean };
type AuxiliaryEvent = { watermark: string; event: unknown };
type AuxiliaryState = {
  watermark: number;
  sessions: Record<string, AuxiliarySession>;
  events: AuxiliaryEvent[];
};
function exportAuxiliaryState(state: AuxiliaryState): AuthorityAuxiliaryExport {
  const securityEvents = state.events.map(({ event }) => structuredClone(event)) as NonNullable<
    AuthorityAuxiliaryExport["securityEvents"]
  >;
  return {
    watermark: String(state.watermark),
    sessions: structuredClone(state.sessions),
    securityEvents,
    securityEventWatermarks: state.events.map(({ watermark }) => watermark),
  };
}

function parseAuxiliaryStorage(rawState: unknown): AuxiliaryState {
  if (!isRecord(rawState) || !isRecord(rawState.sessions) || !Array.isArray(rawState.events)) {
    throw new CapletsError("CONFIG_INVALID", "Filesystem authority auxiliary state is invalid");
  }
  const watermark = parseStoredWatermark(rawState.watermark);
  const sessions: Record<string, AuxiliarySession> = {};
  for (const [sessionId, rawSession] of Object.entries(rawState.sessions)) {
    sessions[sessionId] = parseAuxiliarySession(rawSession);
  }
  const events: AuxiliaryEvent[] = [];
  for (const rawEvent of rawState.events) {
    if (
      !isRecord(rawEvent) ||
      typeof rawEvent.watermark !== "string" ||
      !Object.hasOwn(rawEvent, "event")
    ) {
      throw new CapletsError("CONFIG_INVALID", "Filesystem authority auxiliary event is invalid");
    }
    events.push({ watermark: rawEvent.watermark, event: structuredClone(rawEvent.event) });
  }
  return { watermark, sessions, events };
}

function parseStoredWatermark(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new CapletsError("CONFIG_INVALID", "Filesystem authority auxiliary watermark is invalid");
  }
  return value;
}

function parseExportAuxiliary(value: unknown, watermarkValue: unknown): AuxiliaryState {
  const watermark = parseExportWatermark(watermarkValue);
  if (value === undefined) return { watermark, sessions: {}, events: [] };
  if (!isRecord(value) || value.watermark !== String(watermark)) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Filesystem authority auxiliary export watermark is invalid",
    );
  }
  if (!isRecord(value.sessions) || !Array.isArray(value.securityEvents)) {
    throw new CapletsError("CONFIG_INVALID", "Filesystem authority auxiliary export is invalid");
  }
  const sessions: Record<string, AuxiliarySession> = {};
  for (const [sessionId, session] of Object.entries(value.sessions)) {
    sessions[sessionId] = parseAuxiliarySession(session);
  }
  const cursors = value.securityEventWatermarks;
  if (
    cursors !== undefined &&
    (!Array.isArray(cursors) || cursors.length !== value.securityEvents.length)
  ) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Filesystem authority auxiliary event cursors are invalid",
    );
  }
  const events: AuxiliaryEvent[] = value.securityEvents.map((event, index) => {
    if (!isRecord(event)) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Filesystem authority auxiliary security event is invalid",
      );
    }
    const cursor = cursors?.[index];
    if (cursor !== undefined && typeof cursor !== "string") {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Filesystem authority auxiliary event cursor is invalid",
      );
    }
    return {
      watermark: cursor ?? String(Math.max(1, watermark - value.securityEvents.length + index + 1)),
      event: structuredClone(event),
    };
  });
  return { watermark, sessions, events };
}

function parseExportWatermark(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new CapletsError("CONFIG_INVALID", "Filesystem authority export watermark is invalid");
  }
  const watermark = Number(value);
  if (!Number.isSafeInteger(watermark) || watermark < 0) {
    throw new CapletsError("CONFIG_INVALID", "Filesystem authority export watermark is invalid");
  }
  return watermark;
}

function parseAuxiliarySession(value: unknown): AuxiliarySession {
  if (
    !isRecord(value) ||
    typeof value.lastUsedAt !== "string" ||
    typeof value.revision !== "string" ||
    (value.revoked !== undefined && typeof value.revoked !== "boolean")
  ) {
    throw new CapletsError("CONFIG_INVALID", "Filesystem authority auxiliary session is invalid");
  }
  return {
    lastUsedAt: value.lastUsedAt,
    revision: value.revision,
    revoked: value.revoked ?? false,
  };
}

function parseExportReceipts(
  value: unknown,
  generation: AuthorityGeneration<FilesystemAuthoritySnapshot>,
  now: number,
): AuthorityReceipt<unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new CapletsError("CONFIG_INVALID", "Filesystem authority receipt export is invalid");
  const receipts: AuthorityReceipt<unknown>[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const receipt = parseReceipt(entry, now);
    if (Date.parse(receipt.expiresAt) <= now) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Filesystem authority restore contains an expired receipt",
      );
    }
    if (receipt.generation.authorityId !== generation.authorityId) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Filesystem authority receipt authority does not match the export",
      );
    }
    const key = receiptKeyForValues(
      receipt.currentHostId,
      receipt.principalId,
      receipt.idempotencyKey,
    );
    if (seen.has(key))
      throw new CapletsError(
        "CONFIG_INVALID",
        "Filesystem authority receipt export contains duplicates",
      );
    seen.add(key);
    receipts.push(receipt);
  }
  receipts.sort(
    (left, right) =>
      left.currentHostId.localeCompare(right.currentHostId) ||
      left.principalId.localeCompare(right.principalId) ||
      left.idempotencyKey.localeCompare(right.idempotencyKey),
  );
  return receipts;
}

function parseReceipt(value: unknown, _now: number): AuthorityReceipt<unknown> {
  if (
    !isRecord(value) ||
    typeof value.currentHostId !== "string" ||
    typeof value.principalId !== "string" ||
    typeof value.idempotencyKey !== "string" ||
    typeof value.requestDigest !== "string" ||
    !isRecord(value.generation) ||
    typeof value.generation.authorityId !== "string" ||
    typeof value.generation.id !== "string" ||
    !Number.isSafeInteger(value.generation.sequence) ||
    (value.generation.predecessorId !== null &&
      typeof value.generation.predecessorId !== "string") ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw new CapletsError("CONFIG_INVALID", "Filesystem authority receipt is invalid");
  }
  return {
    currentHostId: value.currentHostId,
    principalId: value.principalId,
    idempotencyKey: value.idempotencyKey,
    requestDigest: value.requestDigest,
    generation: {
      authorityId: value.generation.authorityId,
      id: value.generation.id,
      sequence: value.generation.sequence,
      predecessorId: value.generation.predecessorId,
    },
    result: structuredClone(value.result),
    expiresAt: value.expiresAt,
  };
}

function isWatermarkAfter(current: string, after: string): boolean {
  const currentNumber = Number(current);
  const afterNumber = Number(after);
  if (Number.isSafeInteger(currentNumber) && Number.isSafeInteger(afterNumber)) {
    return currentNumber > afterNumber;
  }
  return current > after;
}

function semanticSessionExists(snapshot: unknown, sessionId: string): boolean {
  if (!isRecord(snapshot)) return false;
  const candidates = [snapshot.dashboardSessions, snapshot.sessions];
  for (const value of candidates) {
    if (Array.isArray(value)) {
      if (value.some((entry) => isActiveSessionEntry(entry, sessionId))) return true;
      continue;
    }
    if (isRecord(value)) {
      if (Array.isArray(value.sessions)) {
        if (value.sessions.some((entry) => isActiveSessionEntry(entry, sessionId))) return true;
        continue;
      }
      const entry = value[sessionId];
      if (entry !== undefined && (!isRecord(entry) || entry.revoked !== true)) return true;
    }
  }
  return false;
}

function isActiveSessionEntry(value: unknown, sessionId: string): boolean {
  return isRecord(value) && value.sessionId === sessionId && value.revoked !== true;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

function delay(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, milliseconds);
  return promise;
}
