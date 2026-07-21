import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  AdminBundleUploadAdmissionController,
  AdminBundleUploadCapacityError,
  AdminBundleUploadStagingError,
} from "../src/admin-api/bundle-upload-admission";

const fixture = fileURLToPath(
  new URL("./fixtures/admin-bundle-upload-crash-child.ts", import.meta.url),
);
const directories: string[] = [];
const children = new Set<ChildProcess>();

const missing = { code: "ENOENT" };

afterEach(async () => {
  await Promise.all([...children].map(async (child) => await stopChild(child)));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Admin Bundle upload process-root ownership", () => {
  it("reclaims a crashed process root after the container hostname changes", async () => {
    const stagingRoot = await temporaryDirectory();
    const abandonedRoot = await createCrashLeftover(stagingRoot, 8);
    const foreignRoot = await renameAsForeignHost(abandonedRoot);
    await expect(access(foreignRoot)).resolves.toBeUndefined();

    const controller = new AdminBundleUploadAdmissionController({
      stagingDir: stagingRoot,
      maxStagedBytes: 8,
    });
    const lease = await controller.acquire();
    expect(() => lease.reserveStagedBytes(8)).not.toThrow();

    await expect(access(foreignRoot)).rejects.toMatchObject(missing);
    expect(
      (await readdir(stagingRoot)).filter((entry) => entry.startsWith("caplets-admin-upload-")),
    ).toHaveLength(1);

    await lease.cleanup();
    await controller.close();
    expect(await readdir(stagingRoot)).toEqual([]);
  }, 15_000);

  it("preserves a foreign live node and aggregates its reserved bytes", async () => {
    const stagingRoot = await temporaryDirectory();
    const liveOwner = await createLiveOwner(stagingRoot, 5);
    const foreignRoot = await renameAsForeignHost(liveOwner.processRoot);

    const controller = new AdminBundleUploadAdmissionController({
      stagingDir: stagingRoot,
      maxConcurrent: 2,
      maxStagedBytes: 8,
    });
    const first = await controller.acquire();
    const second = await controller.acquire();
    expect(() => first.reserveStagedBytes(3)).not.toThrow();
    expect(() => second.reserveStagedBytes(1)).toThrow(AdminBundleUploadCapacityError);
    await expect(access(foreignRoot)).resolves.toBeUndefined();

    await first.cleanup();
    await second.cleanup();
    await controller.close();
    await expect(access(foreignRoot)).resolves.toBeUndefined();

    await stopChild(liveOwner.child);
    const replacement = new AdminBundleUploadAdmissionController({
      stagingDir: stagingRoot,
      maxStagedBytes: 8,
    });
    const replacementLease = await replacement.acquire();
    expect(() => replacementLease.reserveStagedBytes(8)).not.toThrow();
    await expect(access(foreignRoot)).rejects.toMatchObject(missing);
    await replacementLease.cleanup();
    await replacement.close();
    expect(await readdir(stagingRoot)).toEqual([]);
  }, 15_000);

  it("serializes quota reservations made concurrently by separate live processes", async () => {
    const stagingRoot = await temporaryDirectory();
    const contenders = await Promise.all([
      spawnOwner(stagingRoot, 5, "contend"),
      spawnOwner(stagingRoot, 5, "contend"),
    ]);

    const outcomes = await Promise.all(
      contenders.map(async ({ child }) => await reserveContender(child)),
    );
    expect(outcomes.sort()).toEqual(["acquired", "capacity"]);
    for (const contender of contenders) {
      await expect(access(contender.processRoot)).resolves.toBeUndefined();
    }

    await Promise.all(contenders.map(async ({ child }) => await stopChild(child)));
    const replacement = new AdminBundleUploadAdmissionController({
      stagingDir: stagingRoot,
      maxStagedBytes: 8,
    });
    const lease = await replacement.acquire();
    expect(() => lease.reserveStagedBytes(8)).not.toThrow();
    expect(
      (await readdir(stagingRoot)).filter((entry) => entry.startsWith("caplets-admin-upload-")),
    ).toHaveLength(1);
    await lease.cleanup();
    await replacement.close();
    expect(await readdir(stagingRoot)).toEqual([]);
  }, 20_000);

  it("measures a foreign root whose live owner cannot be verified", async () => {
    const stagingRoot = await temporaryDirectory();
    const abandonedRoot = await createCrashLeftover(stagingRoot, 3);
    const foreignRoot = await renameAsForeignKernel(abandonedRoot);

    const controller = new AdminBundleUploadAdmissionController({
      stagingDir: stagingRoot,
      maxConcurrent: 2,
      maxStagedBytes: 8,
    });
    const first = await controller.acquire();
    const second = await controller.acquire();
    expect(() => first.reserveStagedBytes(5)).not.toThrow();
    expect(() => second.reserveStagedBytes(1)).toThrow(AdminBundleUploadCapacityError);
    await expect(access(foreignRoot)).resolves.toBeUndefined();

    await first.cleanup();
    await second.cleanup();
    await controller.close();
    await expect(access(foreignRoot)).resolves.toBeUndefined();
  }, 15_000);

  it("byte-accounts an unverifiable root while allowing the remaining capacity", async () => {
    const stagingRoot = await temporaryDirectory();
    const legacyRoot = join(stagingRoot, "caplets-admin-upload-legacy");
    await mkdir(join(legacyRoot, "request-leftover"), { recursive: true });
    await writeFile(join(legacyRoot, "request-leftover", "staged"), "123");

    const controller = new AdminBundleUploadAdmissionController({
      stagingDir: stagingRoot,
      maxConcurrent: 2,
      maxStagedBytes: 8,
    });
    const first = await controller.acquire();
    const second = await controller.acquire();
    expect(() => first.reserveStagedBytes(5)).not.toThrow();
    expect(() => second.reserveStagedBytes(1)).toThrow(AdminBundleUploadCapacityError);
    await expect(access(legacyRoot)).resolves.toBeUndefined();

    await first.cleanup();
    await second.cleanup();
    await controller.close();
    expect(await readdir(stagingRoot)).toEqual(["caplets-admin-upload-legacy"]);
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

    const requestController = new AdminBundleUploadAdmissionController({
      stagingDir: stagingRoot,
    });
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

async function createCrashLeftover(stagingRoot: string, stagedBytes: number): Promise<string> {
  const owner = await spawnOwner(stagingRoot, stagedBytes, "crash");
  const [code] = (await once(owner.child, "exit")) as [number | null, NodeJS.Signals | null];
  children.delete(owner.child);
  if (code !== 0) throw new Error(`Crash fixture exited with ${String(code)}: ${owner.stderr()}`);
  return owner.processRoot;
}

async function createLiveOwner(
  stagingRoot: string,
  stagedBytes: number,
): Promise<{ child: ChildProcess; processRoot: string }> {
  const owner = await spawnOwner(stagingRoot, stagedBytes, "live");
  return { child: owner.child, processRoot: owner.processRoot };
}

async function spawnOwner(
  stagingRoot: string,
  stagedBytes: number,
  mode: "crash" | "live" | "contend",
): Promise<{
  child: ChildProcess;
  processRoot: string;
  stderr(): string;
}> {
  const child = fork(fixture, [stagingRoot, String(stagedBytes), mode], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.add(child);
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const processRoot = await new Promise<string>((resolve, reject) => {
    child.once("message", (value) => {
      if (
        typeof value === "object" &&
        value !== null &&
        "processRoot" in value &&
        typeof value.processRoot === "string"
      ) {
        resolve(value.processRoot);
      } else {
        reject(new Error("Upload owner fixture returned an invalid process root."));
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (mode !== "crash") {
        reject(new Error(`Live upload owner exited early with ${String(code)}.`));
      }
    });
  });
  return { child, processRoot, stderr: () => stderr };
}

async function reserveContender(child: ChildProcess): Promise<"acquired" | "capacity"> {
  const outcome = new Promise<"acquired" | "capacity">((resolve, reject) => {
    child.once("message", (value) => {
      if (
        typeof value === "object" &&
        value !== null &&
        "reservation" in value &&
        (value.reservation === "acquired" || value.reservation === "capacity")
      ) {
        resolve(value.reservation);
      } else {
        reject(new Error("Upload contender returned an invalid reservation outcome."));
      }
    });
    child.once("error", reject);
  });
  child.send("reserve");
  return await outcome;
}

async function renameAsForeignHost(processRoot: string): Promise<string> {
  const foreignName = basename(processRoot).replace(/-h[a-f0-9]{16}-/u, "-h0000000000000000-");
  if (foreignName === basename(processRoot)) {
    throw new Error("Upload process root does not contain a host identity.");
  }
  const foreignRoot = join(dirname(processRoot), foreignName);
  await rename(processRoot, foreignRoot);
  return foreignRoot;
}

async function renameAsForeignKernel(processRoot: string): Promise<string> {
  const foreignName = basename(processRoot).replace(
    /-h[a-f0-9]{16}-k[a-f0-9]{16}-/u,
    "-h0000000000000000-k0000000000000000-",
  );
  if (foreignName === basename(processRoot)) {
    throw new Error("Upload process root does not contain kernel ownership.");
  }
  const foreignRoot = join(dirname(processRoot), foreignName);
  await rename(processRoot, foreignRoot);
  return foreignRoot;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (!children.delete(child) || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  await exit;
}
