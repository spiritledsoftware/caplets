import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AdminBundleUploadAdmissionController,
  AdminBundleUploadCapacityError,
  AdminBundleUploadStagingError,
} from "../src/admin-api/bundle-upload-admission";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Admin Bundle upload process-root ownership", () => {
  it("creates a private process root and removes only that root on close", async () => {
    const stagingRoot = await temporaryDirectory();
    const foreignRoot = join(stagingRoot, "caplets-admin-upload-foreign");
    await mkdir(foreignRoot, { mode: 0o700 });
    await writeFile(join(foreignRoot, "residue"), "leave me");
    const controller = new AdminBundleUploadAdmissionController({ stagingDir: stagingRoot });

    await controller.initialize();
    const [processRootName] = (await readdir(stagingRoot)).filter(
      (entry) => entry.startsWith("caplets-admin-upload-") && entry !== basename(foreignRoot),
    );
    expect(processRootName).toBeDefined();
    expect((await stat(join(stagingRoot, processRootName!))).mode & 0o777).toBe(0o700);

    const lease = await controller.acquire();
    lease.reserveStagedBytes(8);
    const requestRoot = await lease.createRequestDirectory();
    expect(basename(requestRoot)).toMatch(/^request-/u);
    expect((await stat(requestRoot)).mode & 0o777).toBe(0o700);
    await lease.cleanup();
    await controller.close();

    await expect(access(foreignRoot)).resolves.toBeUndefined();
    await expect(readFile(join(foreignRoot, "residue"), "utf8")).resolves.toBe("leave me");
    expect(await readdir(stagingRoot)).toEqual([basename(foreignRoot)]);
  });

  it("does not scan or remove another live process root", async () => {
    const stagingRoot = await temporaryDirectory();
    const first = new AdminBundleUploadAdmissionController({ stagingDir: stagingRoot });
    const second = new AdminBundleUploadAdmissionController({ stagingDir: stagingRoot });

    await first.initialize();
    await second.initialize();
    const roots = await readdir(stagingRoot);
    expect(roots).toHaveLength(2);

    await first.close();
    const [secondRoot] = await readdir(stagingRoot);
    expect(roots).toContain(secondRoot);
    const lease = await second.acquire();
    lease.reserveStagedBytes(8);
    await lease.cleanup();
    await second.close();
    expect(await readdir(stagingRoot)).toEqual([]);
  });

  it("enforces aggregate staged-byte quota within the Host Node", async () => {
    const stagingRoot = await temporaryDirectory();
    const controller = new AdminBundleUploadAdmissionController({
      stagingDir: stagingRoot,
      maxConcurrent: 2,
      maxStagedBytes: 8,
    });
    const first = await controller.acquire();
    const second = await controller.acquire();

    first.reserveStagedBytes(5);
    expect(() => second.reserveStagedBytes(4)).toThrow(AdminBundleUploadCapacityError);
    await first.cleanup();
    expect(() => second.reserveStagedBytes(4)).not.toThrow();

    await second.cleanup();
    await controller.close();
  });

  it("releases concurrency capacity after cleanup", async () => {
    const stagingRoot = await temporaryDirectory();
    const controller = new AdminBundleUploadAdmissionController({
      stagingDir: stagingRoot,
      maxConcurrent: 1,
    });
    const first = await controller.acquire();
    await expect(controller.acquire()).rejects.toBeInstanceOf(AdminBundleUploadCapacityError);
    await first.cleanup();
    const second = await controller.acquire();
    await second.cleanup();
    await controller.close();
  });

  it("rejects a pre-existing symlink before creating ownership artifacts", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "target");
    const stagingRoot = join(parent, "staging");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, stagingRoot, "dir");

    const controller = new AdminBundleUploadAdmissionController({ stagingDir: stagingRoot });
    await expect(controller.initialize()).rejects.toBeInstanceOf(AdminBundleUploadStagingError);
    expect(await readdir(target)).toEqual([]);
  });

  it("rejects a pre-existing staging root with group or other access", async () => {
    const stagingRoot = await temporaryDirectory();
    await chmod(stagingRoot, 0o750);

    const controller = new AdminBundleUploadAdmissionController({ stagingDir: stagingRoot });
    await expect(controller.initialize()).rejects.toBeInstanceOf(AdminBundleUploadStagingError);
    expect(await readdir(stagingRoot)).toEqual([]);
  });

  it("rejects a pre-existing staging root owned by another effective user", async () => {
    const stagingRoot = await temporaryDirectory();
    const effectiveUid = process.geteuid?.();
    if (effectiveUid === undefined) throw new Error("This test requires POSIX ownership metadata.");
    const getEffectiveUid = vi.spyOn(process, "geteuid").mockReturnValue(effectiveUid + 1);
    try {
      const controller = new AdminBundleUploadAdmissionController({ stagingDir: stagingRoot });
      await expect(controller.initialize()).rejects.toBeInstanceOf(AdminBundleUploadStagingError);
      expect(await readdir(stagingRoot)).toEqual([]);
    } finally {
      getEffectiveUid.mockRestore();
    }
  });

  it("reports staging filesystem failures separately from quota contention", async () => {
    const stagingRoot = await temporaryDirectory();
    const stagingFile = join(stagingRoot, "not-a-directory");
    await writeFile(stagingFile, "occupied");
    const controller = new AdminBundleUploadAdmissionController({ stagingDir: stagingFile });

    await expect(controller.initialize()).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
      status: 503,
    });
    await expect(controller.initialize()).rejects.toBeInstanceOf(AdminBundleUploadStagingError);

    const requestController = new AdminBundleUploadAdmissionController({ stagingDir: stagingRoot });
    const lease = await requestController.acquire();
    const [processRoot] = (await readdir(stagingRoot)).filter((entry) =>
      entry.startsWith("caplets-admin-upload-"),
    );
    await rm(join(stagingRoot, processRoot!), { recursive: true, force: true });
    await expect(lease.createRequestDirectory()).rejects.toBeInstanceOf(
      AdminBundleUploadStagingError,
    );
    await lease.cleanup();
    await requestController.close();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "caplets-admin-upload-ownership-test-"));
  directories.push(directory);
  return directory;
}
