import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapletsError } from "../../../errors";
import type {
  AcquireLegacyMigrationExclusionOptions,
  PlatformExclusionEvidence,
  RelocatedPathIdentity,
  WindowsExclusionOptions,
} from "../exclusion";

export const WINDOWS_EXCLUSION_HELPER_PROTOCOL_VERSION = 1;
export const WINDOWS_EXCLUSION_HELPER_ARCHITECTURES = ["win32-x64"] as const;
export type WindowsExclusionHelperArchitecture =
  (typeof WINDOWS_EXCLUSION_HELPER_ARCHITECTURES)[number];

export type WindowsExclusionHelperManifest = {
  version: 1;
  protocolVersion: 1;
  architectures: Record<
    WindowsExclusionHelperArchitecture,
    { file: string; sha256: string; publisher: string }
  >;
};

export type WindowsHelperVerification = {
  helperPath: string;
  architecture: WindowsExclusionHelperArchitecture;
  sha256: string;
  publisher: string;
};

type WindowsSignatureInspector = (path: string) => Promise<{ status: string; publisher?: string }>;
export type WindowsArtifactLocation = {
  architecture?: string;
  manifestPath: string;
  helperPath?: string;
};

export function packagedWindowsExclusionHelperManifestPath(
  moduleUrl: string = import.meta.url,
): string {
  return fileURLToPath(new URL("../../native/windows-exclusion-helper/manifest.json", moduleUrl));
}

export async function verifyWindowsExclusionHelper(): Promise<WindowsHelperVerification> {
  return verifyWindowsExclusionHelperUsing(
    { manifestPath: packagedWindowsExclusionHelperManifestPath() },
    inspectAuthenticodeSignature,
  );
}

export async function verifyWindowsExclusionHelperFixture(
  options: WindowsArtifactLocation & { signatureInspector: WindowsSignatureInspector },
): Promise<WindowsHelperVerification> {
  return verifyWindowsExclusionHelperUsing(options, options.signatureInspector);
}

async function verifyWindowsExclusionHelperUsing(
  options: WindowsArtifactLocation,
  inspectSignature: WindowsSignatureInspector,
): Promise<WindowsHelperVerification> {
  const architecture = windowsArchitecture(options.architecture ?? process.arch);
  const manifestPath = options.manifestPath;
  const manifest = parseManifest(await readFile(manifestPath, "utf8").catch(() => undefined));
  const artifact = manifest.architectures[architecture];
  const helperPath = options.helperPath ?? join(dirname(manifestPath), artifact.file);
  const bytes = await readFile(helperPath).catch(() => {
    refuse("The packaged Windows exclusion helper is absent.");
  });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== artifact.sha256) {
    refuse("The packaged Windows exclusion helper checksum is invalid.");
  }

  const signature = await inspectSignature(helperPath);
  if (signature.status !== "Valid" || !signature.publisher) {
    refuse("The packaged Windows exclusion helper is not validly Authenticode signed.");
  }
  if (signature.publisher !== artifact.publisher) {
    refuse("The packaged Windows exclusion helper publisher is invalid.");
  }
  return { helperPath, architecture, sha256, publisher: signature.publisher };
}

export async function openWindowsExclusionHelper(input: {
  options: AcquireLegacyMigrationExclusionOptions;
  windows: WindowsExclusionOptions;
  artifacts?: WindowsArtifactLocation;
}): Promise<WindowsHelperLease> {
  if (input.windows.proof.kind !== input.options.mode) {
    refuse("Windows exclusion proof does not match the requested migration mode.");
  }
  const verified = input.artifacts
    ? await verifyWindowsExclusionHelperUsing(input.artifacts, inspectAuthenticodeSignature)
    : await verifyWindowsExclusionHelper();
  const helper = new WindowsHelperClient(verified.helperPath);
  try {
    const result = await helper.request("acquire", {
      sourceBoundaryPath: input.options.sourceBoundaryPath,
      mutablePaths: input.options.mutablePaths,
      mode: input.options.mode,
      expectedOwnerSid: input.windows.expectedOwnerSid,
      expectedServices: input.windows.expectedServices,
      allReplicasStopped:
        input.windows.proof.kind === "offline" && input.windows.proof.allReplicasStopped === true,
    });
    const acquired = parseAcquireResult(result);
    return {
      cleanupId: acquired.cleanupId,
      sealedSourcePath: acquired.sealedSourcePath,
      tombstonePaths: acquired.tombstonePaths,
      manifestSha256: acquired.manifestSha256,
      identities: acquired.identities,
      evidence: {
        platform: "win32",
        coverage: "proven",
        gates: [
          "helper:checksum-verified",
          "helper:publisher-verified",
          "restart-manager:no-foreign-processes",
          "service-owner:sid-verified",
          "share-deny:held",
          "declared-services:stopped",
          ...(input.options.mode === "offline" ? ["offline-replicas:stopped"] : []),
        ],
        scannedProcesses: acquired.scannedProcesses,
        scannedHandles: acquired.identities.length,
        helper: {
          architecture: verified.architecture,
          sha256: verified.sha256,
          publisher: verified.publisher,
        },
      },
      verify: async () => parseVerifyResult(await helper.request("verify", {})),
      rollback: async () => {
        await helper.request("rollback", {});
      },
      complete: async () => {
        await helper.request("complete", { protectedRecoveryDurable: true });
      },
      close: async () => helper.close(),
    };
  } catch (error) {
    await helper.close().catch(() => undefined);
    throw error;
  }
}

export type WindowsHelperLease = {
  cleanupId: string;
  sealedSourcePath: string;
  tombstonePaths: readonly string[];
  manifestSha256: string;
  identities: readonly RelocatedPathIdentity[];
  evidence: PlatformExclusionEvidence;
  verify(): Promise<{ manifestSha256: string; evidence: PlatformExclusionEvidence }>;
  rollback(): Promise<void>;
  complete(): Promise<void>;
  close(): Promise<void>;
};

class WindowsHelperClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: unknown) => void;
    }
  >();
  #stdout = "";
  #stderrBytes = 0;
  #closed = false;

  constructor(helperPath: string) {
    this.#child = spawn(helperPath, ["--stdio"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => this.#consume(chunk));
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrBytes += chunk.length;
      if (this.#stderrBytes > 64 * 1024)
        this.#failAll("Windows exclusion helper output overflowed.");
    });
    this.#child.once("error", () => this.#failAll("Windows exclusion helper could not start."));
    this.#child.once("exit", () => this.#failAll("Windows exclusion helper exited early."));
  }

  async request(action: string, payload: unknown): Promise<unknown> {
    if (this.#closed) refuse("Windows exclusion helper session is closed.");
    const id = randomUUID();
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.#pending.set(id, { resolve, reject });
    this.#child.stdin.write(
      `${JSON.stringify({ version: WINDOWS_EXCLUSION_HELPER_PROTOCOL_VERSION, id, action, payload })}\n`,
      (error) => {
        if (!error) return;
        this.#pending.delete(id);
        reject(new CapletsError("REQUEST_INVALID", "Windows exclusion helper request failed."));
      },
    );
    return promise;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    if (this.#child.exitCode !== null) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    const timeout = setTimeout(() => {
      this.#child.kill();
      resolve();
    }, 2_000);
    timeout.unref();
    this.#child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    await promise;
  }

  #consume(chunk: string): void {
    this.#stdout += chunk;
    if (this.#stdout.length > 1024 * 1024) {
      this.#failAll("Windows exclusion helper response overflowed.");
      return;
    }
    let newline = this.#stdout.indexOf("\n");
    while (newline >= 0) {
      const line = this.#stdout.slice(0, newline);
      this.#stdout = this.#stdout.slice(newline + 1);
      this.#consumeLine(line);
      newline = this.#stdout.indexOf("\n");
    }
  }

  #consumeLine(line: string): void {
    let response: unknown;
    try {
      response = JSON.parse(line);
    } catch {
      this.#failAll("Windows exclusion helper returned invalid protocol data.");
      return;
    }
    if (!isRecord(response) || typeof response.id !== "string") {
      this.#failAll("Windows exclusion helper returned invalid protocol data.");
      return;
    }
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    if (response.version !== WINDOWS_EXCLUSION_HELPER_PROTOCOL_VERSION || response.ok !== true) {
      pending.reject(
        new CapletsError("REQUEST_INVALID", "Windows exclusion helper refused migration."),
      );
      return;
    }
    pending.resolve(response.result);
  }

  #failAll(message: string): void {
    for (const pending of this.#pending.values()) {
      pending.reject(new CapletsError("REQUEST_INVALID", message));
    }
    this.#pending.clear();
  }
}

function parseManifest(bytes: string | undefined): WindowsExclusionHelperManifest {
  if (!bytes) refuse("The packaged Windows exclusion helper manifest is absent.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch {
    refuse("The packaged Windows exclusion helper manifest is invalid.");
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    parsed.protocolVersion !== 1 ||
    Object.keys(parsed).sort().join(",") !== "architectures,protocolVersion,version" ||
    !isRecord(parsed.architectures) ||
    Object.keys(parsed.architectures).join(",") !== "win32-x64"
  ) {
    refuse("The packaged Windows exclusion helper manifest is invalid.");
  }
  const artifact = parsed.architectures["win32-x64"];
  if (
    !isRecord(artifact) ||
    Object.keys(artifact).sort().join(",") !== "file,publisher,sha256" ||
    typeof artifact.file !== "string" ||
    !/^[a-zA-Z0-9._-]+\.exe$/u.test(artifact.file) ||
    typeof artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
    typeof artifact.publisher !== "string" ||
    artifact.publisher.length === 0
  ) {
    refuse("The packaged Windows exclusion helper manifest is invalid.");
  }
  return parsed as WindowsExclusionHelperManifest;
}

function parseAcquireResult(value: unknown): {
  cleanupId: string;
  sealedSourcePath: string;
  tombstonePaths: string[];
  manifestSha256: string;
  identities: RelocatedPathIdentity[];
  scannedProcesses: number;
} {
  if (
    !isRecord(value) ||
    typeof value.cleanupId !== "string" ||
    !/^u7-cleanup-[a-f0-9]{48}$/u.test(value.cleanupId) ||
    typeof value.sealedSourcePath !== "string" ||
    !Array.isArray(value.tombstonePaths) ||
    !value.tombstonePaths.every((path) => typeof path === "string") ||
    typeof value.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.manifestSha256) ||
    !Array.isArray(value.identities) ||
    typeof value.scannedProcesses !== "number"
  ) {
    refuse("Windows exclusion helper returned an invalid acquisition result.");
  }
  const identities = value.identities.map(parseIdentity);
  return {
    cleanupId: value.cleanupId,
    sealedSourcePath: value.sealedSourcePath,
    tombstonePaths: value.tombstonePaths,
    manifestSha256: value.manifestSha256,
    identities,
    scannedProcesses: value.scannedProcesses,
  };
}

function parseVerifyResult(value: unknown): {
  manifestSha256: string;
  evidence: PlatformExclusionEvidence;
} {
  if (
    !isRecord(value) ||
    typeof value.manifestSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.manifestSha256)
  ) {
    refuse("Windows exclusion helper returned an invalid verification result.");
  }
  return {
    manifestSha256: value.manifestSha256,
    evidence: {
      platform: "win32",
      coverage: "proven",
      gates: ["restart-manager:final-scan", "share-deny:held", "source:rehashed"],
      scannedProcesses: 0,
      scannedHandles: 0,
    },
  };
}

function parseIdentity(value: unknown): RelocatedPathIdentity {
  if (
    !isRecord(value) ||
    typeof value.relativePath !== "string" ||
    (value.kind !== "file" && value.kind !== "directory") ||
    typeof value.device !== "string" ||
    typeof value.inode !== "string"
  ) {
    refuse("Windows exclusion helper returned an invalid path identity.");
  }
  return {
    relativePath: value.relativePath,
    kind: value.kind,
    device: value.device,
    inode: value.inode,
  };
}

async function inspectAuthenticodeSignature(
  path: string,
): Promise<{ status: string; publisher?: string }> {
  const script =
    "$s=Get-AuthenticodeSignature -LiteralPath $args[0];" +
    "[Console]::Out.Write(($s | Select-Object @{n='Status';e={$_.Status.ToString()}},@{n='Publisher';e={$_.SignerCertificate.Subject}} | ConvertTo-Json -Compress))";
  const child = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, path],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const stdout: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  const { promise, resolve } = Promise.withResolvers<number>();
  child.once("error", () => resolve(1));
  child.once("exit", (code) => resolve(code ?? 1));
  if ((await promise) !== 0) return { status: "Error" };
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(stdout).toString("utf8"));
    if (!isRecord(parsed) || typeof parsed.Status !== "string") return { status: "Error" };
    return {
      status: parsed.Status,
      ...(typeof parsed.Publisher === "string" ? { publisher: parsed.Publisher } : {}),
    };
  } catch {
    return { status: "Error" };
  }
}

function windowsArchitecture(architecture: string): WindowsExclusionHelperArchitecture {
  if (architecture !== "x64") {
    refuse(
      "This package does not declare a Windows exclusion helper for the current architecture.",
    );
  }
  return "win32-x64";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function refuse(message: string): never {
  throw new CapletsError("REQUEST_INVALID", message);
}
