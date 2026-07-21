import { createHash, randomBytes } from "node:crypto";
import {
  linkSync,
  lstatSync,
  opendirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, opendir, readFile, rename, rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { hostname, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { CapletsError } from "../errors";
import {
  DEFAULT_ADMIN_BUNDLE_REQUEST_BYTES,
  DEFAULT_ADMIN_BUNDLE_UPLOAD_LIMITS,
  type AdminBundleUploadLimits,
} from "./bundle-contract";

export const DEFAULT_ADMIN_BUNDLE_UPLOAD_STAGING_DIR = join(tmpdir(), "caplets-uploads");
export const DEFAULT_ADMIN_BUNDLE_UPLOAD_CONCURRENCY = 1;
export const DEFAULT_ADMIN_BUNDLE_MAX_STAGED_BYTES = DEFAULT_ADMIN_BUNDLE_REQUEST_BYTES;

const PROCESS_ROOT_PREFIX = "caplets-admin-upload-";
const OWNED_PROCESS_ROOT_PATTERN =
  /^caplets-admin-upload-h([a-f0-9]{16})-p([1-9]\d*)-s(\d+|unknown)-/u;
const LEASED_PROCESS_ROOT_PATTERN =
  /^caplets-admin-upload-h([a-f0-9]{16})-k([a-f0-9]{16}|unknown)-p([1-9]\d*)-s(\d+|unknown)-t([a-f0-9]{32})$/u;
const RESERVATION_PREFIX = ".reservation-";
const RESERVATION_PATTERN = /^\.reservation-([a-f0-9]{32})\.json$/u;
const QUOTA_LOCK = ".quota.lock";
const OWNER_PROBE_PATTERN = /^\.p([a-f0-9]{16}|u)([a-f0-9]{32})$/u;
const RECLAIMED_ROOT_PREFIX = ".caplets-admin-upload-reclaimed-";
const LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const QUOTA_LOCK_WAIT_MS = 1_000;
const QUOTA_LOCK_RETRY_MS = 10;
const PROBE_CONNECT_TIMEOUT_MS = 500;
const MAX_STAGING_SCAN_ENTRIES = 100_000;
const MAX_STAGING_ROOT_ENTRIES = 1_024;
const MAX_UNIX_SOCKET_PATH_BYTES = 107;

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
  #processRoot: string | undefined;
  #owner: ProcessRootOwner | undefined;
  #ownerProbe: OwnedProcessProbe | undefined;
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
    try {
      await this.#reconcileStagingRoot();
    } catch (error) {
      throw stagingError(error, "Caplet Bundle upload staging could not be reconciled.");
    }
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
    await closeOwnedProbe(this.#ownerProbe);
    this.#ownerProbe = undefined;
    try {
      if (processRoot) await rm(processRoot, { recursive: true, force: true });
    } catch (error) {
      throw stagingError(error, "Caplet Bundle upload staging could not be removed.");
    } finally {
      this.#processRoot = undefined;
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
    const processRoot = this.#processRoot;
    const owner = this.#owner;
    if (!processRoot || !owner) {
      throw new AdminBundleUploadStagingError();
    }

    try {
      withQuotaLockSync(this.#stagingRoot, processRoot, owner.token, () => {
        const stagedBytes = stagedUsageSync(this.#stagingRoot, this.#maxAggregateStagedBytes);
        if (stagedBytes > this.#maxAggregateStagedBytes - bytes) {
          throw new AdminBundleUploadCapacityError();
        }
        const reservationPath = join(processRoot, `${RESERVATION_PREFIX}${lease.token}.json`);
        writeJsonAtomicallySync(reservationPath, {
          version: 1,
          token: lease.token,
          bytes,
        });
        lease.reservationPath = reservationPath;
      });
    } catch (error) {
      if (error instanceof CapletsError) throw error;
      throw stagingError(error, "Caplet Bundle upload quota could not be reserved.");
    }
    lease.hasReservation = true;
    lease.reservedBytes = bytes;
  }

  async createRequestDirectory(lease: UploadLease): Promise<string> {
    if (this.#closed || lease.released) throw new AdminBundleUploadCapacityError();
    const processRoot = await this.#getProcessRoot();
    if (this.#closed || lease.released) throw new AdminBundleUploadCapacityError();
    try {
      const requestRoot = await mkdirUniqueRequestRoot(processRoot);
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
      if (requestRemoved && lease.reservationPath) {
        await rm(lease.reservationPath, { force: true });
      }
    } catch (error) {
      throw stagingError(error, "Caplet Bundle upload request staging could not be removed.");
    } finally {
      lease.released = true;
      this.#activeUploads -= 1;
    }
  }

  async #getProcessRoot(): Promise<string> {
    if (this.#closed) throw new AdminBundleUploadCapacityError();
    if (this.#processRoot) return this.#processRoot;
    if (!this.#initializing) {
      this.#initializing = this.#initializeProcessRoot();
    }
    return await this.#initializing;
  }

  async #initializeProcessRoot(): Promise<string> {
    let processRoot: string | undefined;
    let probe: OwnedProcessProbe | undefined;
    try {
      await mkdir(this.#stagingRoot, { recursive: true, mode: 0o700 });
      const owner = await currentProcessOwner();
      probe = await startOwnedProbe(owner, this.#stagingRoot);
      processRoot = await createProcessRoot(this.#stagingRoot, owner);
      this.#owner = owner;
      this.#ownerProbe = probe;
      this.#processRoot = processRoot;
      await this.#reconcileStagingRoot();
      if (this.#closed) {
        throw new AdminBundleUploadCapacityError();
      }
      return processRoot;
    } catch (error) {
      await closeOwnedProbe(probe);
      if (processRoot)
        await rm(processRoot, { recursive: true, force: true }).catch(() => undefined);
      this.#ownerProbe = undefined;
      this.#owner = undefined;
      this.#processRoot = undefined;
      if (error instanceof AdminBundleUploadCapacityError) throw error;
      throw stagingError(error, "Caplet Bundle upload staging could not be initialized.");
    }
  }

  async #reconcileStagingRoot(): Promise<void> {
    const owner = this.#owner;
    if (!owner) return;
    await reclaimAbandonedProcessRoots(this.#stagingRoot, owner);
    await reclaimAbandonedQuotaLock(this.#stagingRoot, owner);
  }
}

type ProcessRootOwner = {
  readonly hostScope: string;
  readonly kernelScope: string | undefined;
  readonly pid: number;
  readonly startId: string | undefined;
  readonly token: string | undefined;
};

type OwnedProcessProbe = {
  readonly server: Server;
  readonly path: string;
};

type ProcessOwnerState = "dead" | "live" | "unknown";

async function currentProcessOwner(): Promise<ProcessRootOwner> {
  const bootId = (await readOptionalText(LINUX_BOOT_ID_PATH))?.trim();
  return {
    hostScope: scopeHash(hostname(), bootId ?? "unknown-boot"),
    kernelScope: bootId ? scopeHash(bootId) : undefined,
    pid: process.pid,
    startId: await readProcessStartId(process.pid),
    token: randomToken(),
  };
}

function scopeHash(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex").slice(0, 16);
}

async function createProcessRoot(stagingRoot: string, owner: ProcessRootOwner): Promise<string> {
  if (!owner.token) throw new AdminBundleUploadStagingError();
  const name =
    `${PROCESS_ROOT_PREFIX}h${owner.hostScope}-k${owner.kernelScope ?? "unknown"}` +
    `-p${owner.pid}-s${owner.startId ?? "unknown"}-t${owner.token}`;
  const root = join(stagingRoot, name);
  try {
    await mkdir(root, { mode: 0o700 });
    await chmod(root, 0o700);
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function mkdirUniqueRequestRoot(processRoot: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const root = join(processRoot, `request-${randomToken()}`);
    try {
      await mkdir(root, { mode: 0o700 });
      await chmod(root, 0o700);
      return root;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  throw new AdminBundleUploadStagingError(
    "A unique upload request staging root could not be created.",
  );
}

async function reclaimAbandonedProcessRoots(
  stagingRoot: string,
  currentOwner: ProcessRootOwner,
): Promise<void> {
  const directory = await opendir(stagingRoot);
  let scannedEntries = 0;
  for await (const entry of directory) {
    scannedEntries += 1;
    if (scannedEntries > MAX_STAGING_ROOT_ENTRIES) {
      throw new AdminBundleUploadStagingError(
        "Caplet Bundle upload staging contains too many roots to reconcile safely.",
      );
    }
    const probe = OWNER_PROBE_PATTERN.exec(entry.name);
    if (probe && entry.isSocket()) {
      if (
        currentOwner.kernelScope &&
        probe[1] === currentOwner.kernelScope &&
        (await probePath(join(stagingRoot, entry.name))) === "dead"
      ) {
        await rm(join(stagingRoot, entry.name), { force: true }).catch(() => undefined);
      }
      continue;
    }
    if (entry.name.startsWith(RECLAIMED_ROOT_PREFIX) && entry.isDirectory()) {
      await rm(join(stagingRoot, entry.name), { recursive: true, force: true }).catch(
        () => undefined,
      );
      continue;
    }
    if (!entry.isDirectory() || !entry.name.startsWith(PROCESS_ROOT_PREFIX)) continue;
    const root = join(stagingRoot, entry.name);
    const owner = processRootOwner(entry.name);
    if (!owner || (owner.token && owner.token === currentOwner.token)) continue;
    const state = await processOwnerState(owner, currentOwner, stagingRoot);
    if (state !== "dead") continue;
    const reclaimed = join(stagingRoot, `${RECLAIMED_ROOT_PREFIX}${randomToken()}`);
    try {
      await rename(root, reclaimed);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      continue;
    }
    await removeOwnerProbePath(owner, stagingRoot);
    await rm(reclaimed, { recursive: true, force: true }).catch(() => undefined);
  }
}

function processRootOwner(name: string): ProcessRootOwner | undefined {
  const leased = LEASED_PROCESS_ROOT_PATTERN.exec(name);
  if (leased) {
    const pid = Number(leased[3]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    return {
      hostScope: leased[1]!,
      kernelScope: leased[2] === "unknown" ? undefined : leased[2],
      pid,
      startId: leased[4] === "unknown" ? undefined : leased[4],
      token: leased[5],
    };
  }
  const legacy = OWNED_PROCESS_ROOT_PATTERN.exec(name);
  if (!legacy) return undefined;
  const pid = Number(legacy[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return {
    hostScope: legacy[1]!,
    kernelScope: undefined,
    pid,
    startId: legacy[3] === "unknown" ? undefined : legacy[3],
    token: undefined,
  };
}

async function processOwnerState(
  owner: ProcessRootOwner,
  currentOwner: ProcessRootOwner,
  stagingRoot: string,
): Promise<ProcessOwnerState> {
  if (owner.token) {
    const probe = await probeOwner(owner, stagingRoot);
    if (probe === "live") return "live";
    if (probe === "unknown") return "unknown";
    if (owner.kernelScope && owner.kernelScope === currentOwner.kernelScope) return "dead";
  }
  if (owner.hostScope !== currentOwner.hostScope) return "unknown";
  const running = processRunningState(owner.pid);
  if (running !== "live") return running;
  if (owner.startId === undefined) {
    return owner.pid === currentOwner.pid && currentOwner.startId === undefined
      ? "live"
      : "unknown";
  }
  const runningStartId = await readProcessStartId(owner.pid);
  if (runningStartId !== undefined) {
    return runningStartId === owner.startId ? "live" : "dead";
  }
  return processRunningState(owner.pid) === "dead" ? "dead" : "unknown";
}

function processRunningState(pid: number): ProcessOwnerState {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "live";
    return "unknown";
  }
}

async function readProcessStartId(pid: number): Promise<string | undefined> {
  const contents = await readOptionalText(`/proc/${pid}/stat`);
  if (!contents) return undefined;
  const commandEnd = contents.lastIndexOf(")");
  if (commandEnd < 0) return undefined;
  const fieldsAfterCommand = contents
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  const startId = fieldsAfterCommand[19];
  return startId && /^\d+$/u.test(startId) ? startId : undefined;
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function startOwnedProbe(
  owner: ProcessRootOwner,
  stagingRoot: string,
): Promise<OwnedProcessProbe> {
  if (!owner.token) throw new AdminBundleUploadStagingError();
  const path = ownerProbePath(owner, stagingRoot);
  if (!path.startsWith("\\\\.\\pipe\\")) await rm(path, { force: true }).catch(() => undefined);
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(path, () => {
        server.off("error", rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    server.close();
    throw error;
  }
  server.unref();
  return { server, path };
}

async function closeOwnedProbe(probe: OwnedProcessProbe | undefined): Promise<void> {
  if (!probe) return;
  await new Promise<void>((resolveClose) => {
    probe.server.close(() => resolveClose());
  });
  if (!probe.path.startsWith("\\\\.\\pipe\\"))
    await rm(probe.path, { force: true }).catch(() => undefined);
}

async function probeOwner(
  owner: ProcessRootOwner,
  stagingRoot: string,
): Promise<ProcessOwnerState> {
  if (!owner.token) return "unknown";
  return await probePath(ownerProbePath(owner, stagingRoot));
}

async function probePath(path: string): Promise<ProcessOwnerState> {
  return await new Promise<ProcessOwnerState>((resolveProbe) => {
    const socket = createConnection({ path });
    let settled = false;
    const finish = (state: ProcessOwnerState): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolveProbe(state);
    };
    const timeout = setTimeout(() => finish("unknown"), PROBE_CONNECT_TIMEOUT_MS);
    timeout.unref();
    socket.once("connect", () => finish("live"));
    socket.once("error", (error) => {
      const code = errorCode(error);
      finish(code === "ENOENT" || code === "ECONNREFUSED" ? "dead" : "unknown");
    });
  });
}

function ownerProbePath(owner: ProcessRootOwner, stagingRoot: string): string {
  if (!owner.token) throw new AdminBundleUploadStagingError();
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\caplets-upload-${scopeHash(stagingRoot)}-${owner.token}`;
  }
  const path = join(stagingRoot, `.p${owner.kernelScope ?? "u"}${owner.token}`);
  if (Buffer.byteLength(path) > MAX_UNIX_SOCKET_PATH_BYTES) {
    throw new AdminBundleUploadStagingError(
      "The Caplet Bundle upload staging path is too long for durable owner leases.",
    );
  }
  return path;
}

async function removeOwnerProbePath(owner: ProcessRootOwner, stagingRoot: string): Promise<void> {
  if (!owner.token) return;
  const path = ownerProbePath(owner, stagingRoot);
  if (!path.startsWith("\\\\.\\pipe\\")) await rm(path, { force: true }).catch(() => undefined);
}

async function reclaimAbandonedQuotaLock(
  stagingRoot: string,
  currentOwner: ProcessRootOwner,
): Promise<void> {
  const lockPath = join(stagingRoot, QUOTA_LOCK);
  const marker = await readOptionalText(lockPath);
  if (!marker) return;
  const lock = parseQuotaLock(marker);
  if (!lock) return;
  const root = join(stagingRoot, lock.rootName);
  if (basename(root) !== lock.rootName) return;
  const owner = processRootOwner(lock.rootName);
  const state = owner ? await processOwnerState(owner, currentOwner, stagingRoot) : "dead";
  if (state !== "dead") return;
  await rm(lockPath, { force: true });
}

function parseQuotaLock(
  contents: string,
): { readonly rootName: string; readonly ownerToken: string } | undefined {
  try {
    const value: unknown = JSON.parse(contents);
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      value.version !== 1 ||
      !("rootName" in value) ||
      typeof value.rootName !== "string" ||
      !value.rootName.startsWith(PROCESS_ROOT_PREFIX) ||
      basename(value.rootName) !== value.rootName ||
      !("ownerToken" in value) ||
      typeof value.ownerToken !== "string" ||
      !/^[a-f0-9]{32}$/u.test(value.ownerToken)
    ) {
      return undefined;
    }
    return { rootName: value.rootName, ownerToken: value.ownerToken };
  } catch {
    return undefined;
  }
}

function withQuotaLockSync<T>(
  stagingRoot: string,
  processRoot: string,
  ownerToken: string | undefined,
  operation: () => T,
): T {
  if (!ownerToken) throw new AdminBundleUploadStagingError();
  const lockPath = join(stagingRoot, QUOTA_LOCK);
  const temporary = join(processRoot, `.quota-lock-${randomToken()}.tmp`);
  writeFileSync(
    temporary,
    JSON.stringify({ version: 1, rootName: basename(processRoot), ownerToken }),
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  const deadline = Date.now() + QUOTA_LOCK_WAIT_MS;
  let lockHeld = false;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    while (true) {
      try {
        linkSync(temporary, lockPath);
        lockHeld = true;
        break;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        if (Date.now() >= deadline) {
          throw new AdminBundleUploadStagingError(
            "Caplet Bundle upload quota coordination is unavailable.",
          );
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, QUOTA_LOCK_RETRY_MS);
      }
    }
    rmSync(temporary, { force: true });
    outcome = { ok: true, value: operation() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  if (lockHeld) {
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  rmSync(temporary, { force: true });
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

type StagingScan = {
  remainingEntries: number;
  readonly ceiling: number;
};

function stagedUsageSync(stagingRoot: string, ceiling: number): number {
  const scan: StagingScan = { remainingEntries: MAX_STAGING_SCAN_ENTRIES, ceiling };
  let total = 0;
  const root = opendirSync(stagingRoot);
  try {
    let entry;
    while ((entry = root.readSync())) {
      consumeScanEntry(scan);
      if (entry.name === QUOTA_LOCK || (entry.isSocket() && OWNER_PROBE_PATTERN.test(entry.name))) {
        continue;
      }
      const path = join(stagingRoot, entry.name);
      const bytes =
        entry.isDirectory() && entry.name.startsWith(PROCESS_ROOT_PREFIX)
          ? processRootUsageSync(path, scan)
          : filesystemBytesSync(path, scan);
      total = checkedByteSum(total, bytes, scan.ceiling);
      if (total >= scan.ceiling) return total;
    }
  } finally {
    root.closeSync();
  }
  return total;
}

function processRootUsageSync(rootPath: string, scan: StagingScan): number {
  let reserved = 0;
  let measured = 0;
  const root = opendirSync(rootPath);
  try {
    let entry;
    while ((entry = root.readSync())) {
      consumeScanEntry(scan);
      const path = join(rootPath, entry.name);
      if (entry.isFile() && RESERVATION_PATTERN.test(entry.name)) {
        const size = lstatSync(path).size;
        const reservation =
          size <= 1_024 ? parseReservation(readFileSync(path, "utf8")) : undefined;
        if (reservation !== undefined) {
          reserved = checkedByteSum(reserved, reservation, scan.ceiling);
        } else {
          measured = checkedByteSum(measured, size, scan.ceiling);
        }
      } else {
        measured = checkedByteSum(measured, filesystemBytesSync(path, scan), scan.ceiling);
      }
      if (reserved >= scan.ceiling || measured >= scan.ceiling) return scan.ceiling;
    }
  } finally {
    root.closeSync();
  }
  return Math.max(reserved, measured);
}

function parseReservation(contents: string): number | undefined {
  try {
    const value: unknown = JSON.parse(contents);
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      value.version !== 1 ||
      !("token" in value) ||
      typeof value.token !== "string" ||
      !/^[a-f0-9]{32}$/u.test(value.token) ||
      !("bytes" in value) ||
      !Number.isSafeInteger(value.bytes) ||
      (value.bytes as number) < 0
    ) {
      return undefined;
    }
    return value.bytes as number;
  } catch {
    return undefined;
  }
}

function filesystemBytesSync(path: string, scan: StagingScan): number {
  const stats = lstatSync(path);
  if (!stats.isDirectory()) return safeFileSize(stats.size);
  let total = 0;
  const directory = opendirSync(path);
  try {
    let entry;
    while ((entry = directory.readSync())) {
      consumeScanEntry(scan);
      total = checkedByteSum(
        total,
        filesystemBytesSync(join(path, entry.name), scan),
        scan.ceiling,
      );
      if (total >= scan.ceiling) return total;
    }
  } finally {
    directory.closeSync();
  }
  return total;
}

function consumeScanEntry(scan: StagingScan): void {
  scan.remainingEntries -= 1;
  if (scan.remainingEntries < 0) {
    throw new AdminBundleUploadStagingError(
      "Caplet Bundle upload staging contains too many entries to account safely.",
    );
  }
}

function safeFileSize(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new AdminBundleUploadStagingError("Caplet Bundle upload staging usage is too large.");
  }
  return bytes;
}

function checkedByteSum(total: number, bytes: number, ceiling: number): number {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(bytes)) {
    throw new AdminBundleUploadStagingError("Caplet Bundle upload staging usage is too large.");
  }
  return Math.min(total + bytes, ceiling);
}

function writeJsonAtomicallySync(path: string, value: unknown): void {
  const temporary = `${path}.${randomToken()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function randomToken(): string {
  return randomBytes(16).toString("hex");
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
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
  reservationPath: string | undefined;

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
    if (!this.#requestRootPromise) {
      this.#requestRootPromise = this.#controller.createRequestDirectory(this).then((root) => {
        this.#requestRoot = root;
        return root;
      });
    }
    return await this.#requestRootPromise;
  }

  async cleanup(): Promise<void> {
    if (!this.#cleanupPromise) {
      this.#cleanupPromise = (async () => {
        await this.#requestRootPromise?.catch(() => undefined);
        await this.#controller.release(this, this.#requestRoot);
      })();
    }
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

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
