import { constants, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { CapletsError } from "../../errors";
import type { SecureFilesystemNativeAdapter } from "../secure-state";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;
const DESCRIPTOR_ROOT = "/dev/fd";

export function createDarwinSecureFilesystemAdapter(): SecureFilesystemNativeAdapter {
  return {
    platform: "darwin",
    async withPinnedDirectory(path, action) {
      const absolutePath = resolve(path);
      const handle = await openDirectoryChain(absolutePath);
      try {
        const opened = await handle.stat({ bigint: true });
        const before = await lstat(absolutePath, { bigint: true }).catch(() => undefined);
        if (!before || before.isSymbolicLink() || !sameStableDirectory(opened, before)) {
          throw secureFilesystemError("Darwin secure directory identity changed before use.");
        }
        const result = await action(join(DESCRIPTOR_ROOT, String(handle.fd)));
        const final = await handle.stat({ bigint: true });
        const current = await lstat(absolutePath, { bigint: true }).catch(() => undefined);
        if (
          !current ||
          current.isSymbolicLink() ||
          !sameStableDirectory(opened, final) ||
          !sameStableDirectory(final, current)
        ) {
          throw secureFilesystemError("Darwin secure directory identity changed during use.");
        }
        return result;
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
    async openPinnedPath(path, flags, mode) {
      const absolutePath = resolve(path);
      const parent = dirname(absolutePath);
      const parentHandle = await openDirectoryChain(parent);
      let target: FileHandle | undefined;
      try {
        const openedParent = await parentHandle.stat({ bigint: true });
        const descriptorPath = join(
          DESCRIPTOR_ROOT,
          String(parentHandle.fd),
          basename(absolutePath),
        );
        target =
          mode === undefined
            ? await open(descriptorPath, flags)
            : await open(descriptorPath, flags, mode);
        const finalParent = await parentHandle.stat({ bigint: true });
        const currentParent = await lstat(parent, { bigint: true }).catch(() => undefined);
        if (
          !currentParent ||
          currentParent.isSymbolicLink() ||
          !sameStableDirectory(openedParent, finalParent) ||
          !sameStableDirectory(finalParent, currentParent)
        ) {
          throw secureFilesystemError("Darwin secure file parent identity changed during open.");
        }
        const result = target;
        target = undefined;
        return result;
      } finally {
        await target?.close().catch(() => undefined);
        await parentHandle.close().catch(() => undefined);
      }
    },
    async syncDirectory(path) {
      const handle = await openDirectoryChain(resolve(path));
      try {
        await handle.sync();
      } finally {
        await handle.close().catch(() => undefined);
      }
    },
  };
}

async function openDirectoryChain(path: string): Promise<FileHandle> {
  const normalized = resolve(path);
  const root = parse(normalized).root;
  const components = normalized
    .slice(root.length)
    .split(/[\\/]+/u)
    .filter(Boolean);
  let handle = await open(root, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
  try {
    for (const component of components) {
      const next = await open(
        join(DESCRIPTOR_ROOT, String(handle.fd), component),
        constants.O_RDONLY | DIRECTORY | NOFOLLOW,
      );
      const metadata = await next.stat({ bigint: true });
      if (!metadata.isDirectory()) {
        await next.close().catch(() => undefined);
        throw secureFilesystemError("Darwin secure path component is not a no-follow directory.");
      }
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof CapletsError) throw error;
    throw secureFilesystemError(
      "Darwin secure directory path could not be opened without following links.",
    );
  }
}

function sameStableDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function secureFilesystemError(message: string): CapletsError {
  return new CapletsError("REQUEST_INVALID", message);
}
