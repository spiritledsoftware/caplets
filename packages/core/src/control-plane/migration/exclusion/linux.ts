import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { CapletsError } from "../../../errors";
import type {
  LinuxExclusionOptions,
  PlatformExclusionEvidence,
  RelocatedPathIdentity,
} from "../exclusion";

export async function scanLinuxRelocatedHandles(input: {
  sealedBoundaryPath: string;
  identities: readonly RelocatedPathIdentity[];
  mode: "automatic" | "offline";
  options?: LinuxExclusionOptions;
}): Promise<PlatformExclusionEvidence> {
  const fixtureProcRoot = input.options?.procRootForTests;
  if (fixtureProcRoot && process.env.NODE_ENV !== "test") {
    refuse("Linux process fixtures are unavailable outside tests.");
  }
  const procRoot = fixtureProcRoot ?? "/proc";
  const proof = input.options?.proof;
  if (!proof) refuse("Linux process coverage proof is required.");
  if (proof.kind !== input.mode) refuse("Linux exclusion proof does not match migration mode.");

  const boundary = await stat(input.sealedBoundaryPath, { bigint: true }).catch(() => undefined);
  if (!boundary?.isDirectory()) refuse("The relocated legacy boundary is unavailable.");

  const gates: string[] = [];
  if (fixtureProcRoot) {
    gates.push("proc:test-fixture-complete");
  } else {
    if (typeof process.geteuid !== "function" || process.geteuid() !== 0) {
      refuse("Linux whole-host process coverage requires privileged inspection.");
    }
    const selfPidNamespace = await readNamespace(procRoot, "self", "pid");
    const initPidNamespace = await readNamespace(procRoot, "1", "pid");
    const selfMountNamespace = await readNamespace(procRoot, "self", "mnt");
    const initMountNamespace = await readNamespace(procRoot, "1", "mnt");
    const selfStatus = await readFile(join(procRoot, "self", "status"), "utf8").catch(() => {
      refuse("Linux PID namespace ancestry could not be inspected.");
    });
    const initStatus = await readFile(join(procRoot, "1", "status"), "utf8").catch(() => {
      refuse("Linux host init identity could not be inspected.");
    });
    const root = await stat("/", { bigint: true }).catch(() => undefined);
    const initRoot = await stat(join(procRoot, "1", "root"), { bigint: true }).catch(
      () => undefined,
    );
    if (
      initPidNamespace !== selfPidNamespace ||
      initMountNamespace !== selfMountNamespace ||
      !/^NSpid:\s+\d+\s*$/mu.test(selfStatus) ||
      !/^NSpid:\s+1\s*$/mu.test(initStatus) ||
      !root ||
      !initRoot ||
      root.dev !== initRoot.dev ||
      root.ino !== initRoot.ino
    ) {
      refuse("Linux whole-host PID, mount, and root coverage could not be proven.");
    }
    gates.push(
      "pid-namespace:host-init",
      "mount-namespace:host-init",
      "root:host-init",
      "proc:privileged",
    );
    await verifyMountBoundary(
      procRoot,
      input.sealedBoundaryPath,
      String(boundary.dev),
      proof.kind === "automatic",
    );
  }

  if (proof.kind === "automatic") {
    if (fixtureProcRoot) {
      refuse("Automatic migration cannot use test process coverage.");
    }
    gates.push("mount:dedicated-host-observed");
  } else {
    if (!proof.allReplicasStopped) {
      refuse("Offline migration requires confirmation that every legacy replica is stopped.");
    }
    gates.push("offline-replicas:stopped");
  }

  const identities = new Map(
    input.identities.map((identity) => [identityKey(identity.device, identity.inode), identity]),
  );
  const openHandles: Array<{
    pid: number;
    descriptor: string;
    relativePath: string;
    kind: "file" | "directory";
  }> = [];
  const processEntries = await readdir(procRoot, { withFileTypes: true }).catch(() => {
    refuse("Linux process table could not be enumerated.");
  });
  let scannedProcesses = 0;
  let scannedHandles = 0;

  for (const entry of processEntries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    const pid = Number(entry.name);
    const processRoot = join(procRoot, entry.name);
    const descriptors = ["cwd", "root", "exe"];
    const fdRoot = join(processRoot, "fd");
    let fileDescriptors: string[];
    try {
      fileDescriptors = await readdir(fdRoot);
    } catch (error) {
      if (isGone(error)) continue;
      refuse("Linux process descriptor coverage was incomplete.");
    }
    scannedProcesses += 1;
    descriptors.push(...fileDescriptors.map((descriptor) => join("fd", descriptor)));

    for (const descriptor of descriptors) {
      const descriptorPath = join(processRoot, descriptor);
      let metadata;
      try {
        metadata = await stat(descriptorPath, { bigint: true });
      } catch (error) {
        if (isGone(error)) continue;
        refuse("Linux process descriptor inspection was incomplete.");
      }
      scannedHandles += 1;
      const identity = identities.get(identityKey(String(metadata.dev), String(metadata.ino)));
      if (identity) {
        openHandles.push({
          pid,
          descriptor,
          relativePath: identity.relativePath,
          kind: identity.kind,
        });
      }
    }
  }

  if (openHandles.length > 0) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Legacy migration refused because a process still holds the relocated source.",
      {
        processCount: new Set(openHandles.map((handle) => handle.pid)).size,
        handles: openHandles,
      },
    );
  }

  return {
    platform: "linux",
    coverage: "proven",
    gates: [...gates, "proc:complete", "relocated-identities:no-open-handles"],
    scannedProcesses,
    scannedHandles,
  };
}

async function readNamespace(
  procRoot: string,
  process: string,
  namespace: "pid" | "mnt",
): Promise<string> {
  try {
    return await readlink(join(procRoot, process, "ns", namespace));
  } catch {
    refuse("Linux PID namespace identity could not be inspected.");
  }
}

async function verifyMountBoundary(
  procRoot: string,
  sealedBoundaryPath: string,
  boundaryDevice: string,
  requireDedicatedParent: boolean,
): Promise<void> {
  const mountInfo = await readFile(join(procRoot, "self", "mountinfo"), "utf8").catch(() => {
    refuse("Linux mount coverage could not be inspected.");
  });
  const deviceId = deviceIdFromStat(boundaryDevice);
  const sealed = resolve(sealedBoundaryPath);
  const parent = dirname(sealed);
  let deviceMountCount = 0;
  let dedicatedParent = false;
  for (const line of mountInfo.split("\n")) {
    if (!line) continue;
    const fields = line.split(" ");
    if (fields.length < 6) refuse("Linux mount coverage was malformed.");
    const device = fields[2];
    const mountPoint = decodeMountPath(fields[4]!);
    if (device === deviceId) deviceMountCount += 1;
    if (mountPoint === parent && device === deviceId) dedicatedParent = true;
    if (mountPoint.startsWith(`${sealed}${sep}`) || mountPoint === sealed) {
      refuse("The relocated legacy boundary contains a nested or aliased mount.");
    }
  }
  if (deviceMountCount !== 1) {
    refuse("The relocated legacy filesystem has bind-mounted or aliased host access.");
  }
  if (requireDedicatedParent && !dedicatedParent) {
    refuse("Automatic migration requires an observed dedicated host mount boundary.");
  }
}

function decodeMountPath(path: string): string {
  return path.replace(/\\([0-7]{3})/gu, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

function deviceIdFromStat(device: string): string {
  const value = BigInt(device);
  const major = Number(((value >> 8n) & 0xfffn) | ((value >> 32n) & 0xfffff000n));
  const minor = Number((value & 0xffn) | ((value >> 12n) & 0xffffff00n));
  return `${major}:${minor}`;
}

function identityKey(device: string, inode: string): string {
  return `${device}:${inode}`;
}

function isGone(error: unknown): boolean {
  return isNodeError(error, "ENOENT") || isNodeError(error, "ESRCH");
}

function isNodeError(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function refuse(message: string): never {
  throw new CapletsError("REQUEST_INVALID", message);
}
