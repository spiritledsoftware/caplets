import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { CapletsError } from "../errors";
import {
  DEFAULT_ADMIN_BUNDLE_REQUEST_BYTES,
  DEFAULT_ADMIN_BUNDLE_UPLOAD_LIMITS,
  type AdminBundleUploadLimits,
} from "./bundle-contract";

export const DEFAULT_ADMIN_BUNDLE_UPLOAD_STAGING_DIR = join(tmpdir(), "caplets-uploads");
export const DEFAULT_ADMIN_BUNDLE_UPLOAD_CONCURRENCY = 1;
export const DEFAULT_ADMIN_BUNDLE_MAX_STAGED_BYTES = DEFAULT_ADMIN_BUNDLE_REQUEST_BYTES;

const PROCESS_ROOT_PREFIX = `caplets-admin-upload-h${randomBytes(8).toString("hex")}-`;
const REQUEST_ROOT_PREFIX = "request-";

export type AdminBundleUploadAdmissionOptions = {
  stagingDir?: string;
  maxConcurrent?: number;
  maxStagedBytes?: number;
  limits?: Readonly<AdminBundleUploadLimits>;
};

export type AdminBundleUploadLease = {
  readonly limits: Readonly<AdminBundleUploadLimits>;
  reserveStagedBytes(bytes: number): void;
  createRequestDirectory(): Promise<string>;
  cleanup(): Promise<void>;
};

export class AdminBundleUploadCapacityError extends CapletsError {
  readonly status = 429;

  constructor() {
    super("UPLOAD_CAPACITY_EXCEEDED", "Caplet Bundle upload capacity is exhausted.", {
      reason: "upload_capacity_exhausted",
    });
    this.name = "AdminBundleUploadCapacityError";
  }
}

export class AdminBundleUploadStagingError extends CapletsError {
  readonly status = 503;

  constructor(message = "Caplet Bundle upload staging is unavailable.") {
    super("SERVER_UNAVAILABLE", message, {
      reason: "upload_staging_unavailable",
    });
    this.name = "AdminBundleUploadStagingError";
  }
}

export class AdminBundleUploadAdmissionController {
  readonly limits: Readonly<AdminBundleUploadLimits>;

  readonly #stagingRoot: string;
  readonly #maxConcurrentUploads: number;
  readonly #maxAggregateStagedBytes: number;
  #activeUploads = 0;
  #reservedStagedBytes = 0;
  #processRoot: string | undefined;
  #initializing: Promise<string> | undefined;
  #closed = false;

  constructor(options: AdminBundleUploadAdmissionOptions = {}) {
    const stagingDir = options.stagingDir ?? DEFAULT_ADMIN_BUNDLE_UPLOAD_STAGING_DIR;
    if (typeof stagingDir !== "string" || stagingDir.length === 0) {
      throw new CapletsError("CONFIG_INVALID", "An upload staging directory is required.");
    }
    this.limits = { ...(options.limits ?? DEFAULT_ADMIN_BUNDLE_UPLOAD_LIMITS) };
    validateLimits(this.limits);
    this.#maxConcurrentUploads = options.maxConcurrent ?? DEFAULT_ADMIN_BUNDLE_UPLOAD_CONCURRENCY;
    this.#maxAggregateStagedBytes = options.maxStagedBytes ?? DEFAULT_ADMIN_BUNDLE_MAX_STAGED_BYTES;
    if (!isPositiveSafeInteger(this.#maxConcurrentUploads)) {
      throw new CapletsError("CONFIG_INVALID", "Upload concurrency must be a positive integer.");
    }
    if (!isPositiveSafeInteger(this.#maxAggregateStagedBytes)) {
      throw new CapletsError(
        "CONFIG_INVALID",
        "Upload aggregate quota must be a positive integer.",
      );
    }
    this.#stagingRoot = resolve(stagingDir);
  }

  async initialize(): Promise<void> {
    await this.#getProcessRoot();
  }

  async acquire(): Promise<AdminBundleUploadLease> {
    await this.#getProcessRoot();
    if (this.#closed || this.#activeUploads >= this.#maxConcurrentUploads) {
      throw new AdminBundleUploadCapacityError();
    }
    this.#activeUploads += 1;
    return new UploadLease(this);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const processRoot = this.#initializing
      ? await this.#initializing.catch(() => undefined)
      : this.#processRoot;
    try {
      if (processRoot) await rm(processRoot, { recursive: true, force: true });
    } catch (error) {
      throw stagingError(error, "Caplet Bundle upload staging could not be removed.");
    } finally {
      this.#processRoot = undefined;
      this.#reservedStagedBytes = 0;
    }
  }

  reserve(lease: UploadLease, bytes: number): void {
    if (this.#closed || lease.released) throw new AdminBundleUploadCapacityError();
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > this.limits.maxDocumentBytes + this.limits.maxTotalFileBytes
    ) {
      throw new CapletsError("REQUEST_INVALID", "The staged upload byte reservation is invalid.");
    }
    if (lease.hasReservation) {
      if (lease.reservedBytes === bytes) return;
      throw new CapletsError("REQUEST_INVALID", "The upload lease already has a byte reservation.");
    }
    if (this.#reservedStagedBytes > this.#maxAggregateStagedBytes - bytes) {
      throw new AdminBundleUploadCapacityError();
    }
    this.#reservedStagedBytes += bytes;
    lease.hasReservation = true;
    lease.reservedBytes = bytes;
  }

  async createRequestDirectory(lease: UploadLease): Promise<string> {
    if (this.#closed || lease.released) throw new AdminBundleUploadCapacityError();
    const processRoot = await this.#getProcessRoot();
    if (this.#closed || lease.released) throw new AdminBundleUploadCapacityError();
    try {
      const requestRoot = await mkdtemp(join(processRoot, REQUEST_ROOT_PREFIX));
      await chmod(requestRoot, 0o700);
      if (this.#closed || lease.released) {
        await rm(requestRoot, { recursive: true, force: true });
        throw new AdminBundleUploadCapacityError();
      }
      return requestRoot;
    } catch (error) {
      if (error instanceof CapletsError) throw error;
      throw stagingError(error, "Caplet Bundle upload request staging could not be created.");
    }
  }

  async release(lease: UploadLease, requestRoot: string | undefined): Promise<void> {
    if (lease.released) return;
    let requestRemoved = requestRoot === undefined;
    try {
      if (requestRoot) {
        await rm(requestRoot, { recursive: true, force: true });
        requestRemoved = true;
      }
    } catch (error) {
      throw stagingError(error, "Caplet Bundle upload request staging could not be removed.");
    } finally {
      if (requestRemoved && lease.hasReservation) {
        this.#reservedStagedBytes = Math.max(0, this.#reservedStagedBytes - lease.reservedBytes);
        lease.hasReservation = false;
      }
      lease.released = true;
      this.#activeUploads -= 1;
    }
  }

  async #getProcessRoot(): Promise<string> {
    if (this.#closed) throw new AdminBundleUploadCapacityError();
    if (this.#processRoot) return this.#processRoot;
    this.#initializing ??= this.#initializeProcessRoot();
    return await this.#initializing;
  }

  async #initializeProcessRoot(): Promise<string> {
    let processRoot: string | undefined;
    try {
      await mkdir(this.#stagingRoot, { recursive: true, mode: 0o700 });
      await assertSecureStagingRoot(this.#stagingRoot);
      processRoot = await mkdtemp(join(this.#stagingRoot, PROCESS_ROOT_PREFIX));
      await chmod(processRoot, 0o700);
      this.#processRoot = processRoot;
      if (this.#closed) throw new AdminBundleUploadCapacityError();
      return processRoot;
    } catch (error) {
      if (processRoot) {
        await rm(processRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      this.#processRoot = undefined;
      if (error instanceof AdminBundleUploadCapacityError) throw error;
      throw stagingError(error, "Caplet Bundle upload staging could not be initialized.");
    }
  }
}

async function assertSecureStagingRoot(stagingRoot: string): Promise<void> {
  const status = await lstat(stagingRoot);
  const effectiveUid = typeof process.geteuid === "function" ? process.geteuid() : undefined;
  if (
    !status.isDirectory() ||
    (effectiveUid !== undefined && status.uid !== effectiveUid) ||
    (process.platform !== "win32" && (status.mode & 0o077) !== 0)
  ) {
    throw new AdminBundleUploadStagingError(
      "Caplet Bundle upload staging must be a private directory owned by the current user.",
    );
  }
}

function randomToken(): string {
  return randomBytes(16).toString("hex");
}

function stagingError(error: unknown, message: string): AdminBundleUploadStagingError {
  return error instanceof AdminBundleUploadStagingError
    ? error
    : new AdminBundleUploadStagingError(message);
}

class UploadLease implements AdminBundleUploadLease {
  readonly limits: Readonly<AdminBundleUploadLimits>;
  readonly token = randomToken();
  reservedBytes = 0;
  hasReservation = false;
  released = false;

  readonly #controller: AdminBundleUploadAdmissionController;
  #requestRoot: string | undefined;
  #requestRootPromise: Promise<string> | undefined;
  #cleanupPromise: Promise<void> | undefined;

  constructor(controller: AdminBundleUploadAdmissionController) {
    this.#controller = controller;
    this.limits = controller.limits;
  }

  reserveStagedBytes(bytes: number): void {
    this.#controller.reserve(this, bytes);
  }

  async createRequestDirectory(): Promise<string> {
    this.#requestRootPromise ??= this.#controller.createRequestDirectory(this).then((root) => {
      this.#requestRoot = root;
      return root;
    });
    return await this.#requestRootPromise;
  }

  async cleanup(): Promise<void> {
    this.#cleanupPromise ??= (async () => {
      await this.#requestRootPromise?.catch(() => undefined);
      await this.#controller.release(this, this.#requestRoot);
    })();
    await this.#cleanupPromise;
  }
}

function validateLimits(limits: Readonly<AdminBundleUploadLimits>): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!isPositiveSafeInteger(value)) {
      throw new CapletsError("CONFIG_INVALID", `Upload limit ${name} must be a positive integer.`);
    }
  }
  if (
    limits.maxFileBytes > limits.maxTotalFileBytes ||
    limits.maxManifestBytes + limits.maxDocumentBytes + limits.maxTotalFileBytes >
      limits.maxRequestBytes
  ) {
    throw new CapletsError("CONFIG_INVALID", "Admin Bundle upload limits are inconsistent.");
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
