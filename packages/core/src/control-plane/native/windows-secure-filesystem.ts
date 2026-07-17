import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { CapletsError } from "../../errors";
import { verifyWindowsExclusionHelper, WindowsHelperClient } from "../migration/exclusion/windows";
import type { SecureFilesystemNativeAdapter } from "../secure-state";

export type ProductionWindowsSecureFilesystem = Readonly<{
  expectedServiceSid: string;
  nativeAdapter: SecureFilesystemNativeAdapter;
  verifyWindowsDacl(path: string, expectedServiceSid?: string): Promise<boolean>;
}>;

export async function createWindowsSecureFilesystemAdapter(): Promise<ProductionWindowsSecureFilesystem> {
  const verified = await verifyWindowsExclusionHelper();
  const identityClient = new WindowsHelperClient(verified.helperPath);
  let identity: unknown;
  try {
    identity = await identityClient.request("current-sid", {});
  } finally {
    await identityClient.close().catch(() => undefined);
  }
  if (
    !isRecord(identity) ||
    typeof identity.sid !== "string" ||
    !/^S-(?:\d+-){2,}\d+$/u.test(identity.sid)
  ) {
    throw secureFilesystemError("Windows secure filesystem owner identity is unavailable.");
  }
  const expectedServiceSid = identity.sid;

  const withHeldPath = async <T>(
    path: string,
    kind: "file" | "directory",
    action: () => Promise<T>,
  ): Promise<T> => {
    const client = new WindowsHelperClient(verified.helperPath);
    let held = false;
    try {
      const result = await client.request("hold-path", {
        path: resolve(path),
        kind,
        expectedServiceSid,
      });
      if (
        !isRecord(result) ||
        result.kind !== kind ||
        typeof result.device !== "string" ||
        typeof result.inode !== "string"
      ) {
        throw secureFilesystemError("Windows secure filesystem handle identity is invalid.");
      }
      held = true;
      const value = await action();
      await client.request("release-path", {});
      held = false;
      return value;
    } catch {
      throw secureFilesystemError("Windows secure filesystem operation was refused.");
    } finally {
      if (held) await client.request("release-path", {}).catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  };

  const openHeldPath = async (
    path: string,
    kind: "file" | "directory",
    flags: number,
    mode?: number,
  ): Promise<FileHandle> => {
    const client = new WindowsHelperClient(verified.helperPath);
    let held = false;
    try {
      const result = await client.request("hold-path", {
        path,
        kind,
        expectedServiceSid,
      });
      if (
        !isRecord(result) ||
        result.kind !== kind ||
        typeof result.device !== "string" ||
        typeof result.inode !== "string"
      ) {
        throw secureFilesystemError("Windows secure filesystem handle identity is invalid.");
      }
      held = true;
      const handle = mode === undefined ? await open(path, flags) : await open(path, flags, mode);
      const closeHandle = handle.close.bind(handle);
      let closed = false;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "close") {
            return async () => {
              if (closed) return;
              closed = true;
              let failure: unknown;
              try {
                await closeHandle();
              } catch (error) {
                failure = error;
              }
              try {
                await client.request("release-path", {});
                held = false;
              } catch (error) {
                failure ??= error;
              }
              await client.close().catch((error: unknown) => {
                failure ??= error;
              });
              if (failure) {
                throw secureFilesystemError("Windows secure filesystem handle release failed.");
              }
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    } catch {
      if (held) await client.request("release-path", {}).catch(() => undefined);
      await client.close().catch(() => undefined);
      throw secureFilesystemError("Windows secure filesystem path open was refused.");
    }
  };

  const nativeAdapter: SecureFilesystemNativeAdapter = {
    platform: "win32",
    withPinnedDirectory(path, action) {
      const absolutePath = resolve(path);
      return withHeldPath(absolutePath, "directory", () => action(absolutePath));
    },
    openPinnedPath(path, flags, mode) {
      const absolutePath = resolve(path);
      const kind = (flags & (constants.O_DIRECTORY ?? 0)) !== 0 ? "directory" : "file";
      return openHeldPath(absolutePath, kind, flags, mode);
    },
    async createDirectory(path) {
      const client = new WindowsHelperClient(verified.helperPath);
      try {
        const result = await client.request("create-directory", {
          path: resolve(path),
          expectedServiceSid,
        });
        if (!isRecord(result) || (result.state !== "created" && result.state !== "exists")) {
          throw secureFilesystemError("Windows secure directory creation result is invalid.");
        }
        return result.state;
      } catch {
        throw secureFilesystemError("Windows secure directory creation was refused.");
      } finally {
        await client.close().catch(() => undefined);
      }
    },
    async syncDirectory() {
      // Windows write-through file handles and durable MoveFileEx publication provide the flush boundary.
    },
  };

  return {
    expectedServiceSid,
    nativeAdapter,
    async verifyWindowsDacl(path, requestedSid) {
      if (requestedSid !== expectedServiceSid) return false;
      const client = new WindowsHelperClient(verified.helperPath);
      try {
        const result = await client.request("verify-dacl", {
          path: resolve(path),
          expectedServiceSid,
        });
        return isRecord(result) && result.restricted === true;
      } catch {
        return false;
      } finally {
        await client.close().catch(() => undefined);
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function secureFilesystemError(message: string): CapletsError {
  return new CapletsError("AUTH_FAILED", message);
}
