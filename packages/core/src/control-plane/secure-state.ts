import { constants, type BigIntStats, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  type FileHandle,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { CapletsError } from "../errors";

const OWNER_ONLY_FILE_MODE = 0o600;
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const freshStateRootCapabilities = new WeakSet<SecureStateRoot>();

export type SecureFileMetadata = {
  revision: string;
  device: string;
  inode: string;
  uid?: number | undefined;
  posixMode?: number | undefined;
  windowsDaclRestricted?: boolean | undefined;
  size: number;
};
export type SecureDirectoryMetadata = {
  revision: string;
  device: string;
  inode: string;
};

export type SecureFilesystemOptions = {
  expectedUid?: number | undefined;
  expectedServiceSid?: string | undefined;
  maxBytes?: number | undefined;
  platform?: NodeJS.Platform | undefined;
  verifyWindowsDacl?:
    | ((path: string, expectedServiceSid?: string) => boolean | Promise<boolean>)
    | undefined;
};

export type SecureFileRead = {
  bytes: Buffer;
  metadata: SecureFileMetadata;
};

export type SecureStateRoot = {
  path: string;
  fresh: boolean;
};
export function consumeSecureStateRootFreshness(
  root: SecureStateRoot,
  expectedPath: string,
): boolean {
  if (
    !root.fresh ||
    resolve(root.path) !== resolve(expectedPath) ||
    !freshStateRootCapabilities.delete(root)
  ) {
    return false;
  }
  return true;
}

export async function createOrOpenSecureStateRoot(
  path: string,
  options: SecureFilesystemOptions = {},
): Promise<SecureStateRoot> {
  if (!isAbsolute(path)) throw secureError("Secure state root must be absolute.");
  const absolutePath = resolve(path);
  let fresh = false;
  try {
    await lstat(absolutePath);
  } catch (error) {
    if (!isNotFound(error)) throw secureError("Secure state root could not be inspected.");
    fresh = await createSecureDirectoryChain(absolutePath, options.platform ?? process.platform);
  }
  await assertNoSymlinkComponents(absolutePath);
  await assertSecureStateDirectory(absolutePath, options);
  const result = Object.freeze({ path: absolutePath, fresh });
  if (fresh) freshStateRootCapabilities.add(result);
  return result;
}

export async function ensureSecureStateDirectory(
  path: string,
  options: SecureFilesystemOptions = {},
): Promise<void> {
  if (!isAbsolute(path)) throw secureError("Secure directory must be absolute.");
  const absolutePath = resolve(path);
  const parent = dirname(absolutePath);
  await assertNoSymlinkComponents(parent);
  await withPinnedDirectory(parent, options.platform ?? process.platform, async (pinnedParent) => {
    try {
      await mkdir(join(pinnedParent, basename(absolutePath)), {
        recursive: false,
        mode: OWNER_ONLY_DIRECTORY_MODE,
      });
    } catch (error) {
      if (!isAlreadyExists(error)) throw secureError("Secure directory could not be created.");
    }
  });
  await assertNoSymlinkComponents(absolutePath);
  await assertSecureStateDirectory(absolutePath, options);
}

export async function assertSecureStateDirectory(
  path: string,
  options: SecureFilesystemOptions = {},
): Promise<void> {
  await inspectSecureStateDirectory(path, options);
}
export async function inspectSecureStateDirectory(
  path: string,
  options: SecureFilesystemOptions = {},
): Promise<SecureDirectoryMetadata> {
  await assertNoSymlinkComponents(resolve(path));
  const platform = options.platform ?? process.platform;
  let handle;
  try {
    handle = await openPinnedPath(
      path,
      constants.O_RDONLY | DIRECTORY | NOFOLLOW,
      undefined,
      platform,
    );
  } catch {
    throw secureError("Secure state directory could not be opened without following links.");
  }
  try {
    const file = await handle.stat({ bigint: true });
    if (!file.isDirectory()) throw secureError("Secure state must be a no-follow directory.");
    await validateOwnershipAndPermissions(path, file, true, platform, options);
    const pathIdentity = await lstat(path, { bigint: true }).catch(() => undefined);
    if (!pathIdentity || pathIdentity.isSymbolicLink() || !sameSnapshot(file, pathIdentity)) {
      throw secureError("Secure directory identity changed during inspection.");
    }
    return {
      revision: revisionFor(file),
      device: file.dev.toString(),
      inode: file.ino.toString(),
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
export async function withSecureStateDirectory<T>(
  path: string,
  options: SecureFilesystemOptions,
  action: (pinnedPath: string) => Promise<T>,
): Promise<T> {
  await assertSecureStateDirectory(path, options);
  return withPinnedDirectory(path, options.platform ?? process.platform, action);
}

export async function inspectSecureRegularFile(
  path: string,
  options: SecureFilesystemOptions = {},
): Promise<SecureFileMetadata> {
  await assertNoSymlinkComponents(path);
  const platform = options.platform ?? process.platform;
  let handle;
  try {
    handle = await openPinnedPath(path, constants.O_RDONLY | NOFOLLOW, undefined, platform);
  } catch {
    throw secureError("Secure file must be an existing no-follow regular file.");
  }
  try {
    const file = await handle.stat({ bigint: true });
    validateRegularFile(file);
    await validateOwnershipAndPermissions(path, file, false, platform, options);
    const pathIdentity = await lstat(path, { bigint: true }).catch(() => undefined);
    if (!pathIdentity || pathIdentity.isSymbolicLink() || !sameSnapshot(file, pathIdentity)) {
      throw secureError("Secure file identity changed during inspection.");
    }
    return {
      revision: revisionFor(file),
      device: file.dev.toString(),
      inode: file.ino.toString(),
      ...(platform === "win32"
        ? { windowsDaclRestricted: true }
        : { uid: Number(file.uid), posixMode: Number(file.mode) & 0o777 }),
      size: Number(file.size),
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
export async function withSecureRegularFile<T>(
  path: string,
  options: SecureFilesystemOptions,
  action: (handle: FileHandle, metadata: SecureFileMetadata) => Promise<T>,
): Promise<{ value: T; metadata: SecureFileMetadata }> {
  await assertNoSymlinkComponents(path);
  const platform = options.platform ?? process.platform;
  let handle: FileHandle;
  try {
    handle = await openPinnedPath(path, constants.O_RDONLY | NOFOLLOW, undefined, platform);
  } catch {
    throw secureError("Secure file must be an existing no-follow regular file.");
  }
  try {
    const before = await handle.stat({ bigint: true });
    validateRegularFile(before);
    await validateOwnershipAndPermissions(path, before, false, platform, options);
    const pathBefore = await lstat(path, { bigint: true }).catch(() => undefined);
    if (!pathBefore || pathBefore.isSymbolicLink() || !sameSnapshot(before, pathBefore)) {
      throw secureError("Secure file identity changed before use.");
    }
    const metadata: SecureFileMetadata = {
      revision: revisionFor(before),
      device: before.dev.toString(),
      inode: before.ino.toString(),
      ...(platform === "win32"
        ? { windowsDaclRestricted: true }
        : { uid: Number(before.uid), posixMode: Number(before.mode) & 0o777 }),
      size: Number(before.size),
    };
    const value = await action(handle, metadata);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true }).catch(() => undefined);
    if (
      !pathAfter ||
      pathAfter.isSymbolicLink() ||
      !sameSnapshot(before, after) ||
      !sameSnapshot(after, pathAfter)
    ) {
      throw secureError("Secure file identity changed during use.");
    }
    return { value, metadata };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readBoundedSecureFile(
  path: string,
  options: SecureFilesystemOptions = {},
): Promise<Buffer> {
  return (await readBoundedSecureFileWithMetadata(path, options)).bytes;
}

export async function readSecureFileRange(
  path: string,
  start: number,
  endExclusive: number,
  options: SecureFilesystemOptions = {},
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(endExclusive) ||
    start < 0 ||
    endExclusive <= start
  ) {
    throw secureError("Secure file byte range is invalid.");
  }
  const maxBytes = options.maxBytes ?? 64 * 1024;
  await assertNoSymlinkComponents(path);
  const platform = options.platform ?? process.platform;
  let handle;
  try {
    handle = await openPinnedPath(path, constants.O_RDONLY | NOFOLLOW, undefined, platform);
  } catch {
    throw secureError("Secure file must be an existing no-follow regular file.");
  }
  try {
    const before = await handle.stat({ bigint: true });
    validateRegularFile(before);
    await validateOwnershipAndPermissions(path, before, false, platform, options);
    if (before.size > BigInt(maxBytes)) throw secureError("Secure file exceeds the size limit.");
    if (BigInt(endExclusive) > before.size) {
      throw secureError("Secure file byte range is out of bounds.");
    }
    const length = endExclusive - start;
    const bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const result = await handle.read(bytes, offset, length - offset, start + offset);
      if (result.bytesRead === 0) throw secureError("Secure file changed during range read.");
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const pathIdentity = await lstat(path, { bigint: true }).catch(() => undefined);
    if (
      !sameSnapshot(before, after) ||
      !pathIdentity ||
      pathIdentity.isSymbolicLink() ||
      !sameSnapshot(after, pathIdentity)
    ) {
      throw secureError("Secure file identity changed during range read.");
    }
    return bytes;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readBoundedSecureFileWithMetadata(
  path: string,
  options: SecureFilesystemOptions = {},
): Promise<SecureFileRead> {
  const maxBytes = options.maxBytes ?? 64 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw secureError("Secure file size limit is invalid.");
  }
  await assertNoSymlinkComponents(path);
  const platform = options.platform ?? process.platform;
  let handle;
  try {
    handle = await openPinnedPath(path, constants.O_RDONLY | NOFOLLOW, undefined, platform);
  } catch {
    throw secureError("Secure file must be an existing no-follow regular file.");
  }
  try {
    const before = await handle.stat({ bigint: true });
    validateRegularFile(before);
    await validateOwnershipAndPermissions(path, before, false, platform, options);
    if (before.size > BigInt(maxBytes)) throw secureError("Secure file exceeds the size limit.");
    const size = Number(before.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const result = await handle.read(bytes, offset, size - offset, offset);
      if (result.bytesRead === 0) throw secureError("Secure file changed during read.");
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameSnapshot(before, after)) {
      throw secureError("Secure file changed during read.");
    }
    const pathIdentity = await lstat(path, { bigint: true }).catch(() => undefined);
    if (!pathIdentity || pathIdentity.isSymbolicLink() || !sameSnapshot(after, pathIdentity)) {
      throw secureError("Secure file identity changed during read.");
    }
    return {
      bytes,
      metadata: {
        revision: revisionFor(after),
        device: after.dev.toString(),
        inode: after.ino.toString(),
        ...(platform === "win32"
          ? { windowsDaclRestricted: true }
          : { uid: Number(after.uid), posixMode: Number(after.mode) & 0o777 }),
        size,
      },
    };
  } catch (error) {
    if (error instanceof CapletsError) throw error;
    throw secureError("Secure file could not be read safely.");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function writeSecureFileExclusive(
  path: string,
  bytes: Uint8Array,
  options: SecureFilesystemOptions = {},
): Promise<SecureFileMetadata> {
  const parent = dirname(path);
  await assertSecureStateDirectory(parent, options);
  const platform = options.platform ?? process.platform;
  return withPinnedDirectory(parent, platform, async (pinnedParent) => {
    const target = join(pinnedParent, basename(path));
    const temporary = join(pinnedParent, `.secure-create-${randomBytes(12).toString("hex")}`);
    let handle: FileHandle | undefined;
    let published = false;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
        OWNER_ONLY_FILE_MODE,
      );
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
        offset += result.bytesWritten;
      }
      await handle.sync();
      const temporaryIdentity = await handle.stat({ bigint: true });
      validateRegularFile(temporaryIdentity);
      try {
        await link(temporary, target);
        published = true;
      } catch (error) {
        if (isAlreadyExists(error)) throw secureError("Secure file already exists.");
        throw secureError("Secure file could not be published.");
      }
      const publishedIdentity = await lstat(target, { bigint: true }).catch(() => undefined);
      if (
        !publishedIdentity ||
        publishedIdentity.isSymbolicLink() ||
        !sameIdentity(temporaryIdentity, publishedIdentity)
      ) {
        throw secureError("Secure file identity changed during publication.");
      }
      await validateOwnershipAndPermissions(path, publishedIdentity, false, platform, options);
      await syncDirectory(pinnedParent);
      return {
        revision: revisionFor(publishedIdentity),
        device: publishedIdentity.dev.toString(),
        inode: publishedIdentity.ino.toString(),
        ...(platform === "win32"
          ? { windowsDaclRestricted: true }
          : {
              uid: Number(publishedIdentity.uid),
              posixMode: Number(publishedIdentity.mode) & 0o777,
            }),
        size: Number(publishedIdentity.size),
      };
    } catch (error) {
      if (error instanceof CapletsError) throw error;
      throw secureError("Secure file could not be written atomically.");
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      if (!published) await syncDirectory(pinnedParent).catch(() => undefined);
    }
  });
}

export async function replaceSecureFileAtomically(
  path: string,
  expectedRevision: string,
  bytes: Uint8Array,
  options: SecureFilesystemOptions = {},
): Promise<boolean> {
  const parent = dirname(path);
  await assertSecureStateDirectory(parent, options);
  const platform = options.platform ?? process.platform;
  return withPinnedDirectory(parent, platform, async (pinnedParent) => {
    const lock = join(pinnedParent, `${basename(path)}.lock`);
    const temporary = join(
      pinnedParent,
      `${basename(path)}.tmp-${randomBytes(12).toString("hex")}`,
    );
    let lockHandle: FileHandle | undefined;
    let temporaryHandle: FileHandle | undefined;
    try {
      try {
        lockHandle = await open(
          lock,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
          OWNER_ONLY_FILE_MODE,
        );
        await lockHandle.sync();
      } catch (error) {
        if (isAlreadyExists(error)) return false;
        throw secureError("Secure file replacement lock could not be created.");
      }
      const current = await readBoundedSecureFileWithMetadata(path, options);
      if (current.metadata.revision !== expectedRevision) return false;
      temporaryHandle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
        OWNER_ONLY_FILE_MODE,
      );
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await temporaryHandle.write(
          bytes,
          offset,
          bytes.byteLength - offset,
          offset,
        );
        offset += result.bytesWritten;
      }
      await temporaryHandle.sync();
      const temporaryIdentity = await temporaryHandle.stat({ bigint: true });
      validateRegularFile(temporaryIdentity);
      const rechecked = await readBoundedSecureFileWithMetadata(path, options);
      if (rechecked.metadata.revision !== expectedRevision) return false;
      await rename(temporary, join(pinnedParent, basename(path)));
      await syncDirectory(pinnedParent);
      return true;
    } finally {
      await temporaryHandle?.close().catch(() => undefined);
      await lockHandle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      await rm(lock, { force: true }).catch(() => undefined);
      await syncDirectory(pinnedParent).catch(() => undefined);
    }
  });
}

export async function deleteSecureRegularFile(
  path: string,
  options: SecureFilesystemOptions = {},
): Promise<void> {
  const parent = dirname(path);
  await assertSecureStateDirectory(parent, options);
  const platform = options.platform ?? process.platform;
  await withPinnedDirectory(parent, platform, async (pinnedParent) => {
    const target = join(pinnedParent, basename(path));
    const file = await lstat(target, { bigint: true }).catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw secureError("Secure file could not be inspected for deletion.");
    });
    if (!file) return;
    if (file.isSymbolicLink() || !file.isFile()) {
      throw secureError("Secure deletion requires a no-follow regular file.");
    }
    await validateOwnershipAndPermissions(path, file, false, platform, options);
    try {
      await unlink(target);
    } catch (error) {
      if (!isNotFound(error)) throw secureError("Secure file could not be deleted.");
    }
    await syncDirectory(pinnedParent);
  });
}

export async function writeSecureJsonExclusive(
  path: string,
  value: unknown,
  options: SecureFilesystemOptions = {},
): Promise<SecureFileMetadata> {
  return writeSecureFileExclusive(path, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"), options);
}

export async function chmodOwnerOnly(path: string, directory: boolean): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, directory ? OWNER_ONLY_DIRECTORY_MODE : OWNER_ONLY_FILE_MODE);
  }
}

async function validateOwnershipAndPermissions(
  path: string,
  file: Stats | BigIntStats,
  directory: boolean,
  platform: NodeJS.Platform,
  options: SecureFilesystemOptions,
): Promise<void> {
  if (platform === "win32") {
    if (
      !options.verifyWindowsDacl ||
      !(await options.verifyWindowsDacl(path, options.expectedServiceSid))
    ) {
      throw secureError("Secure state ACL could not be verified as owner-only.");
    }
    return;
  }
  const expectedUid = options.expectedUid ?? process.getuid?.();
  if (expectedUid === undefined || Number(file.uid) !== expectedUid) {
    throw secureError("Secure state has a foreign owner.");
  }
  const mode = Number(file.mode) & 0o777;
  if ((mode & 0o077) !== 0 || (directory ? (mode & 0o700) !== 0o700 : (mode & 0o600) !== 0o600)) {
    throw secureError("Secure state permissions are insecure.");
  }
}

function validateRegularFile(file: BigIntStats): void {
  if (!file.isFile()) throw secureError("Secure state must be a no-follow regular file.");
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.uid === right.uid
  );
}

function revisionFor(file: BigIntStats): string {
  return `${file.dev}:${file.ino}:${file.size}:${file.mtimeNs}`;
}

async function withPinnedDirectory<T>(
  path: string,
  platform: NodeJS.Platform,
  action: (pinnedPath: string) => Promise<T>,
): Promise<T> {
  if (platform === "win32") {
    throw secureError("Windows secure filesystem requires a native handle-relative adapter.");
  }
  if (platform === "darwin") {
    throw secureError("Darwin secure filesystem requires a native openat adapter.");
  }
  const absolutePath = resolve(path);
  let handle: FileHandle | undefined;
  try {
    handle = await openPinnedDirectoryPath(absolutePath, platform);
    const opened = await handle.stat({ bigint: true });
    const currentBefore = await lstat(absolutePath, { bigint: true }).catch(() => undefined);
    if (
      !currentBefore ||
      currentBefore.isSymbolicLink() ||
      !sameStableDirectory(opened, currentBefore)
    ) {
      throw secureError("Secure directory identity changed before operation.");
    }
    const pinnedPath = join("/proc/self/fd", String(handle.fd));
    const value = await action(pinnedPath);
    const final = await handle.stat({ bigint: true });
    const current = await lstat(absolutePath, { bigint: true }).catch(() => undefined);
    if (
      !current ||
      current.isSymbolicLink() ||
      !sameStableDirectory(opened, final) ||
      !sameStableDirectory(final, current)
    ) {
      throw secureError("Secure directory identity changed during operation.");
    }
    return value;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sameStableDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

async function openPinnedPath(
  path: string,
  flags: number,
  mode: number | undefined,
  platform: NodeJS.Platform,
): Promise<FileHandle> {
  if (platform === "win32" && process.platform === "win32") {
    throw secureError("Windows secure filesystem requires a native handle-relative adapter.");
  }
  if (platform === "darwin") {
    throw secureError("Darwin secure filesystem requires a native openat adapter.");
  }
  if (platform === "win32") {
    return mode === undefined ? open(path, flags) : open(path, flags, mode);
  }
  const absolutePath = resolve(path);
  const parent = dirname(absolutePath);
  let parentHandle: FileHandle | undefined;
  let targetHandle: FileHandle | undefined;
  try {
    parentHandle = await openPinnedDirectoryPath(parent, platform);
    const openedParent = await parentHandle.stat({ bigint: true });
    const pinnedPath = join("/proc/self/fd", String(parentHandle.fd), basename(absolutePath));
    targetHandle =
      mode === undefined ? await open(pinnedPath, flags) : await open(pinnedPath, flags, mode);
    const currentParent = await lstat(parent, { bigint: true }).catch(() => undefined);
    const finalParent = await parentHandle.stat({ bigint: true });
    if (
      !currentParent ||
      currentParent.isSymbolicLink() ||
      !sameStableDirectory(openedParent, finalParent) ||
      !sameStableDirectory(finalParent, currentParent)
    ) {
      throw secureError("Secure file parent identity changed during open.");
    }
    const result = targetHandle;
    targetHandle = undefined;
    return result;
  } finally {
    await targetHandle?.close().catch(() => undefined);
    await parentHandle?.close().catch(() => undefined);
  }
}

async function openPinnedDirectoryPath(
  path: string,
  platform: NodeJS.Platform,
): Promise<FileHandle> {
  const normalized = resolve(path);
  const root = parse(normalized).root;
  const components = normalized
    .slice(root.length)
    .split(/[\\/]+/u)
    .filter(Boolean);
  const descriptorRoot = platform === "darwin" ? "/dev/fd" : "/proc/self/fd";
  let handle = await open(root, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    for (const component of components) {
      const next = await open(
        join(descriptorRoot, String(handle.fd), component),
        constants.O_RDONLY | DIRECTORY | NOFOLLOW,
      );
      const file = await next.stat({ bigint: true });
      if (!file.isDirectory()) {
        await next.close().catch(() => undefined);
        throw secureError("Secure path component is not a no-follow directory.");
      }
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof CapletsError) throw error;
    throw secureError("Secure directory path could not be opened without following links.");
  }
}

async function createSecureDirectoryChain(
  path: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  const normalized = resolve(path);
  const root = parse(normalized).root;
  const components = normalized
    .slice(root.length)
    .split(/[\\/]+/u)
    .filter(Boolean);
  let current = root;
  let finalComponentCreated = false;
  for (const [index, component] of components.entries()) {
    const nextPath = join(current, component);
    const existing = await lstat(nextPath).catch((error: unknown) => {
      if (isNotFound(error)) return undefined;
      throw secureError("Secure state path could not be inspected.");
    });
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw secureError("Secure state path contains a non-directory or symlinked component.");
      }
    } else {
      let created = false;
      await withPinnedDirectory(current, platform, async (pinnedParent) => {
        try {
          await mkdir(join(pinnedParent, component), {
            recursive: false,
            mode: OWNER_ONLY_DIRECTORY_MODE,
          });
          created = true;
        } catch (error) {
          if (!isAlreadyExists(error)) {
            throw secureError("Secure state root could not be created.");
          }
        }
      });
      if (index === components.length - 1) finalComponentCreated = created;
    }
    current = nextPath;
  }
  return finalComponentCreated;
}

async function assertNoSymlinkComponents(path: string): Promise<void> {
  const normalized = resolve(path);
  const root = parse(normalized).root;
  const components = normalized
    .slice(root.length)
    .split(/[\\/]+/u)
    .filter(Boolean);
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    const file = await lstat(current).catch(() => undefined);
    if (!file || file.isSymbolicLink()) {
      throw secureError("Secure state path contains an absent or symlinked component.");
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function syncSecureDirectory(
  path: string,
  options: SecureFilesystemOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return;
  await withPinnedDirectory(path, platform, syncDirectory);
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error, "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error, "EEXIST");
}

function isNodeError(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function secureError(message: string): CapletsError {
  return new CapletsError("REQUEST_INVALID", message);
}
