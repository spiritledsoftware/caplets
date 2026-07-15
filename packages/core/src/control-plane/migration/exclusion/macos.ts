import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { CapletsError } from "../../../errors";
import type {
  MacosExclusionOptions,
  PlatformExclusionEvidence,
  RelocatedPathIdentity,
} from "../exclusion";
const MACOS_LSOF_PATH = "/usr/sbin/lsof";
const MACOS_CODESIGN_PATH = "/usr/bin/codesign";
const MACOS_SUDO_PATH = "/usr/bin/sudo";

export async function scanMacosRelocatedHandles(input: {
  sealedBoundaryPath: string;
  identities: readonly RelocatedPathIdentity[];
  mode: "automatic" | "offline";
  options?: MacosExclusionOptions;
}): Promise<PlatformExclusionEvidence> {
  const options = input.options;
  const proof = options?.proof;
  if (!proof) refuse("macOS process coverage proof is required.");
  if (proof.kind !== input.mode) refuse("macOS exclusion proof does not match migration mode.");
  await verifyReviewedMacosLsof();
  const elevated = typeof process.geteuid === "function" && process.geteuid() !== 0;
  const command = elevated ? MACOS_SUDO_PATH : MACOS_LSOF_PATH;
  const prefix = elevated ? ["-n", MACOS_LSOF_PATH] : [];

  const gates: string[] = [
    "lsof:apple-code-signature-verified",
    "process-scope:whole-host",
    elevated ? "lsof:passwordless-sudo" : "lsof:privileged",
  ];
  if (proof.kind === "automatic") {
    refuse("Automatic macOS migration lacks a package-owned dedicated-volume proof adapter.");
  }
  if (!proof.allReplicasStopped) {
    refuse("Offline migration requires confirmation that every legacy replica is stopped.");
  }
  gates.push("offline-replicas:stopped");

  const version = await runProcess(command, [...prefix, "-v"]);
  if (version.code !== 0 || (!version.stdout && !version.stderr)) {
    refuse("The macOS lsof adapter identity could not be established.");
  }
  const scan = await runProcess(command, [...prefix, "-nP", "-F0pfiD"]);
  if (scan.code !== 0 && scan.code !== 1) {
    refuse("macOS lsof coverage was incomplete.");
  }

  const identities = new Map(
    input.identities.map((identity) => [`${identity.device}:${identity.inode}`, identity]),
  );
  const openHandles: Array<{
    pid: number;
    descriptor: string;
    relativePath: string;
    kind: "file" | "directory";
  }> = [];
  const records = parseLsofRecords(scan.stdout);
  for (const record of records) {
    const identity = identities.get(`${record.device}:${record.inode}`);
    if (identity) {
      openHandles.push({
        pid: record.pid,
        descriptor: record.descriptor,
        relativePath: identity.relativePath,
        kind: identity.kind,
      });
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
    platform: "darwin",
    coverage: "proven",
    gates: [...gates, "lsof:complete", "relocated-identities:no-open-handles"],
    scannedProcesses: new Set(records.map((record) => record.pid)).size,
    scannedHandles: records.length,
  };
}

export type MacosLsofRecord = {
  pid: number;
  descriptor: string;
  device: string;
  inode: string;
};

export function parseLsofRecords(output: string): MacosLsofRecord[] {
  const records: MacosLsofRecord[] = [];
  let pid: number | undefined;
  let descriptor = "unknown";
  let device: string | undefined;
  let inode: string | undefined;
  const flush = () => {
    if (pid !== undefined && Number.isSafeInteger(pid) && device && inode) {
      records.push({ pid, descriptor, device, inode });
    }
    device = undefined;
    inode = undefined;
  };
  for (const field of output.replaceAll("\0", "\n").split("\n")) {
    if (field.length < 2) continue;
    const value = field.slice(1);
    if (field[0] === "p") {
      flush();
      pid = Number(value);
      descriptor = "unknown";
    } else if (field[0] === "f") {
      flush();
      descriptor = value;
    } else if (field[0] === "D") {
      if (!/^(?:0x[0-9a-f]+|\d+)$/iu.test(value)) {
        refuse("macOS lsof returned an invalid device identity.");
      }
      device = BigInt(value).toString();
    } else if (field[0] === "i") {
      if (!/^\d+$/u.test(value)) refuse("macOS lsof returned an invalid inode identity.");
      inode = BigInt(value).toString();
    }
  }
  flush();
  return records;
}

export async function verifyReviewedMacosLsof(): Promise<void> {
  await access(MACOS_LSOF_PATH).catch(() => {
    refuse("The reviewed macOS lsof adapter is unavailable.");
  });
  const verification = await runProcess(MACOS_CODESIGN_PATH, [
    "--verify",
    "--strict",
    MACOS_LSOF_PATH,
  ]);
  const requirement = await runProcess(MACOS_CODESIGN_PATH, ["-d", "-r", "-", MACOS_LSOF_PATH]);
  const identity = `${requirement.stdout}\n${requirement.stderr}`;
  if (
    verification.code !== 0 ||
    requirement.code !== 0 ||
    !/identifier "com\.apple\.lsof"/u.test(identity) ||
    !/anchor apple/u.test(identity)
  ) {
    refuse("The installed macOS lsof adapter is not signed by Apple with the reviewed identity.");
  }
}

async function runProcess(
  command: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= 16 * 1024 * 1024) stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= 16 * 1024 * 1024) stderr.push(chunk);
  });
  const { promise, resolve } = Promise.withResolvers<number>();
  child.once("error", () => resolve(2));
  child.once("exit", (code) => resolve(code ?? 2));
  const code = await promise;
  if (bytes > 16 * 1024 * 1024) refuse("macOS lsof output exceeded the bounded coverage envelope.");
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

function refuse(message: string): never {
  throw new CapletsError("REQUEST_INVALID", message);
}
