import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { DEFAULT_ARTIFACT_DIR } from "../config/paths";
import { CapletsError } from "../errors";

export type MediaArtifact = {
  uri: string;
  path?: string;
  filename: string;
  mimeType?: string;
  byteLength: number;
  sha256: string;
};

export type WriteMediaArtifactInput = {
  rootDir?: string;
  capletId: string;
  callId?: string;
  suggestedFilename?: string;
  outputPath?: string;
  mimeType?: string;
  bytes: Uint8Array | Buffer;
  exposeLocalPath?: boolean;
};

export type WriteMediaArtifactStreamInput = Omit<WriteMediaArtifactInput, "bytes">;

export type MediaArtifactWriter = {
  write(bytes: Uint8Array): Promise<void>;
  complete(): Promise<MediaArtifact>;
  abort(): Promise<void>;
};

type StoredMediaArtifactMetadata = {
  mimeType?: string;
};

type ParsedArtifactUri = {
  capletId: string;
  callId: string;
  filename: string;
};

const artifactPublicationLocks = new Map<string, Promise<void>>();

async function serializeArtifactPublication<T>(
  target: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = artifactPublicationLocks.get(target) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => gate);
  artifactPublicationLocks.set(target, queued);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release?.();
    if (artifactPublicationLocks.get(target) === queued) {
      artifactPublicationLocks.delete(target);
    }
  }
}

async function removeArtifactBackups(paths: string[], errorMessage: string): Promise<void> {
  let pending = paths;
  for (let attempt = 0; attempt < 2 && pending.length > 0; attempt += 1) {
    const results = await Promise.allSettled(
      pending.map(async (path) => await rm(path, { force: true })),
    );
    pending = results.flatMap((result, index) =>
      result.status === "rejected" ? [pending[index]!] : [],
    );
  }
  if (pending.length > 0) {
    throw new CapletsError("DOWNSTREAM_TOOL_ERROR", errorMessage);
  }
}

async function scavengeArtifactBackups(target: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dirname(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const prefix = `.${basename(target)}.`;
  await removeArtifactBackups(
    entries
      .filter(
        (entry) =>
          entry.startsWith(prefix) &&
          (entry.endsWith(".previous") || entry.endsWith(".previous.caplets.json")),
      )
      .map((entry) => resolve(dirname(target), entry)),
    "Could not remove stale media artifact publication backups",
  );
}

export function artifactUri(capletId: string, callId: string, filename: string): string {
  return `caplets://artifacts/${encodeURIComponent(capletId)}/${encodeURIComponent(
    callId,
  )}/${encodeURIComponent(filename)}`;
}

export async function writeMediaArtifact(input: WriteMediaArtifactInput): Promise<MediaArtifact> {
  const { bytes, ...streamInput } = input;
  const writer = await createMediaArtifactWriter(streamInput);
  try {
    await writer.write(bytes);
    return await writer.complete();
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

export async function createMediaArtifactWriter(
  input: WriteMediaArtifactStreamInput,
): Promise<MediaArtifactWriter> {
  const rootDir = resolve(input.rootDir ?? DEFAULT_ARTIFACT_DIR);
  const capletId = requiredSafePathSegment(input.capletId, "capletId");
  const callId = safePathSegment(input.callId ?? defaultCallId(), "call");
  const filename = safeFilename(
    input.suggestedFilename ?? (input.outputPath ? basename(input.outputPath) : "response.bin"),
  );
  const target = input.outputPath
    ? assertInsideRoot(rootDir, input.outputPath)
    : assertInsideRoot(rootDir, resolve(rootDir, capletId, callId, filename));
  rejectSymlinkPathComponents(rootDir, target, true);
  rejectSymlinkPathComponents(rootDir, artifactMetadataPath(target), true);
  const uriParts = input.outputPath
    ? uriPartsForOutputPath(rootDir, target)
    : { capletId, callId, filename: safeFilename(basename(target)) };
  const stagingId = randomUUID();
  const targetMetadataPath = artifactMetadataPath(target);
  const tempPath = resolve(dirname(target), `.${basename(target)}.${stagingId}.partial`);
  const tempMetadataPath = artifactMetadataPath(tempPath);
  const backupPath = resolve(dirname(target), `.${basename(target)}.${stagingId}.previous`);
  const backupMetadataPath = artifactMetadataPath(backupPath);

  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  rejectSymlinkPathComponents(rootDir, target, true);
  rejectSymlinkPathComponents(rootDir, targetMetadataPath, true);
  const file = await open(tempPath, "wx", 0o600);
  const hash = createHash("sha256");
  let byteLength = 0;
  let closed = false;
  let completed = false;
  let targetBackedUp = false;
  let metadataBackedUp = false;
  let targetPublished = false;
  let metadataPublished = false;

  const closeFile = async (): Promise<void> => {
    if (!closed) {
      closed = true;
      await file.close();
    }
  };

  const removeStaging = async (): Promise<void> => {
    await Promise.all([rm(tempPath, { force: true }), rm(tempMetadataPath, { force: true })]);
  };

  const restorePreviousArtifacts = async (): Promise<void> => {
    if (metadataPublished) {
      await rm(targetMetadataPath, { force: true });
      metadataPublished = false;
    }
    if (targetPublished) {
      await rm(target, { force: true });
      targetPublished = false;
    }
    if (targetBackedUp) {
      await rename(backupPath, target);
      targetBackedUp = false;
    }
    if (metadataBackedUp) {
      await rename(backupMetadataPath, targetMetadataPath);
      metadataBackedUp = false;
    }
    await removeStaging();
  };

  const abort = async (): Promise<void> => {
    if (completed) {
      return;
    }
    await closeFile().catch(() => {});
    await removeStaging();
  };

  return {
    async write(bytes: Uint8Array): Promise<void> {
      if (completed || closed) {
        throw new CapletsError("REQUEST_INVALID", "Media artifact writer is already closed");
      }
      const chunk = Buffer.isBuffer(bytes)
        ? bytes
        : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten === 0) {
          throw new CapletsError("DOWNSTREAM_TOOL_ERROR", "Could not write media artifact");
        }
        offset += bytesWritten;
      }
      hash.update(chunk);
      byteLength += chunk.byteLength;
    },
    async complete(): Promise<MediaArtifact> {
      if (completed || closed) {
        throw new CapletsError("REQUEST_INVALID", "Media artifact writer is already closed");
      }
      await closeFile();
      const digest = hash.digest("hex");
      return await serializeArtifactPublication(target, async () => {
        try {
          await scavengeArtifactBackups(target);
          await chmod(tempPath, 0o600);
          await writeArtifactMetadata(tempPath, input.mimeType ? { mimeType: input.mimeType } : {});
          rejectSymlinkPathComponents(rootDir, target, true);
          rejectSymlinkPathComponents(rootDir, targetMetadataPath, true);
          if (existsSync(target)) {
            await rename(target, backupPath);
            targetBackedUp = true;
          }
          if (existsSync(targetMetadataPath)) {
            await rename(targetMetadataPath, backupMetadataPath);
            metadataBackedUp = true;
          }
          await rename(tempPath, target);
          targetPublished = true;
          if (input.mimeType) {
            await rename(tempMetadataPath, targetMetadataPath);
            metadataPublished = true;
          }
          completed = true;
        } catch (error) {
          try {
            await restorePreviousArtifacts();
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "Could not roll back failed media artifact publication",
            );
          }
          throw error;
        }
        await removeArtifactBackups(
          [backupPath, backupMetadataPath],
          "Media artifact was published but backup cleanup failed",
        );
        return {
          uri: artifactUri(uriParts.capletId, uriParts.callId, uriParts.filename),
          ...(input.exposeLocalPath === false ? {} : { path: target }),
          filename: uriParts.filename,
          ...(input.mimeType ? { mimeType: input.mimeType } : {}),
          byteLength,
          sha256: digest,
        };
      });
    },
    abort,
  };
}

export function resolveMediaArtifact(
  uri: string,
  options: { artifactRoot?: string; maxBytes?: number } = {},
): MediaArtifact {
  const parsed = parseArtifactUri(uri);
  const rootDir = resolve(options.artifactRoot ?? DEFAULT_ARTIFACT_DIR);
  const path = assertInsideRoot(
    rootDir,
    resolve(rootDir, parsed.capletId, parsed.callId, parsed.filename),
  );
  rejectSymlinkPathComponents(rootDir, path, true);
  rejectSymlinkPathComponents(rootDir, artifactMetadataPath(path), true);

  if (!existsSync(path)) {
    throw new CapletsError("REQUEST_INVALID", "Media artifact was not found");
  }

  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new CapletsError("REQUEST_INVALID", "Media artifact must resolve to a file");
  }
  if (options.maxBytes !== undefined && stat.size > options.maxBytes) {
    throw new CapletsError("REQUEST_INVALID", `media exceeds byte limit ${options.maxBytes}`);
  }

  const bytes = readFileSync(path);
  const metadata = readArtifactMetadata(path);
  return {
    uri,
    path,
    filename: parsed.filename,
    ...(metadata?.mimeType ? { mimeType: metadata.mimeType } : {}),
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

function parseArtifactUri(uri: string): ParsedArtifactUri {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new CapletsError("REQUEST_INVALID", "Media artifact URI is invalid");
  }

  if (url.protocol !== "caplets:" || url.hostname !== "artifacts") {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Media artifact URI must start with caplets://artifacts/",
    );
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3) {
    throw new CapletsError("REQUEST_INVALID", "Media artifact URI is missing required parts");
  }

  return {
    capletId: decodeSafePathSegment(parts[0]!, "capletId"),
    callId: decodeSafePathSegment(parts[1]!, "callId"),
    filename: decodeSafeFilename(parts[2]!),
  };
}

function decodeSafePathSegment(value: string, label: string): string {
  const decoded = decodeArtifactUriPart(value);
  const safe = safePathSegment(decoded, "");
  if (!safe || safe !== decoded) {
    throw new CapletsError("REQUEST_INVALID", `Media artifact URI ${label} is invalid`);
  }
  return safe;
}

function decodeSafeFilename(value: string): string {
  const decoded = decodeArtifactUriPart(value);
  const safe = safeFilename(decoded);
  if (safe !== decoded) {
    throw new CapletsError("REQUEST_INVALID", "Media artifact URI filename is invalid");
  }
  return safe;
}

function decodeArtifactUriPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new CapletsError("REQUEST_INVALID", "Media artifact URI contains invalid encoding");
  }
}

function assertInsideRoot(rootDir: string, candidate: string): string {
  if (!isAbsolute(candidate)) {
    throw new CapletsError("REQUEST_INVALID", "Media artifact outputPath must be absolute");
  }

  const resolvedRoot = resolve(rootDir);
  const resolved = resolve(candidate);
  const rel = relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Media artifact outputPath must stay inside the artifact root",
    );
  }
  return resolved;
}

function rejectSymlinkPathComponents(
  rootDir: string,
  target: string,
  includeTarget: boolean,
): void {
  const resolvedRoot = resolve(rootDir);
  rejectSymlinkRoot(resolvedRoot);
  const rel = relative(resolvedRoot, resolve(target));
  const parts = rel.split(/[\\/]+/u).filter(Boolean);
  let current = resolvedRoot;
  const limit = includeTarget ? parts.length : Math.max(0, parts.length - 1);
  for (let index = 0; index < limit; index += 1) {
    current = resolve(current, parts[index]!);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new CapletsError("REQUEST_INVALID", "Media artifact path must not contain symlinks");
      }
    } catch (error) {
      if (error instanceof CapletsError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function rejectSymlinkRoot(rootDir: string): void {
  try {
    if (lstatSync(rootDir).isSymbolicLink()) {
      throw new CapletsError("REQUEST_INVALID", "Media artifact root must not be a symlink");
    }
  } catch (error) {
    if (error instanceof CapletsError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function uriPartsForOutputPath(
  rootDir: string,
  target: string,
): { capletId: string; callId: string; filename: string } {
  const rel = relative(resolve(rootDir), target);
  const parts = rel.split(/[\\/]+/u).filter(Boolean);
  if (parts.length !== 3) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Media artifact outputPath must be under <artifact-root>/<caplet-id>/<call-id>/<filename>",
    );
  }
  return {
    capletId: requireAlreadySafePathSegment(parts[0]!, "capletId"),
    callId: requireAlreadySafePathSegment(parts[1]!, "callId"),
    filename: requireAlreadySafeFilename(parts[2]!),
  };
}

function requiredSafePathSegment(value: string, label: string): string {
  const safe = safePathSegment(value, "");
  if (!safe) {
    throw new CapletsError("REQUEST_INVALID", `Media artifact ${label} is required`);
  }
  return safe;
}

function requireAlreadySafePathSegment(value: string, label: string): string {
  const safe = requiredSafePathSegment(value, label);
  if (safe !== value) {
    throw new CapletsError("REQUEST_INVALID", `Media artifact outputPath ${label} is invalid`);
  }
  return safe;
}

function requireAlreadySafeFilename(value: string): string {
  const safe = safeFilename(value);
  if (safe !== value) {
    throw new CapletsError("REQUEST_INVALID", "Media artifact outputPath filename is invalid");
  }
  return safe;
}

function safePathSegment(value: string, fallback: string): string {
  return safeFilename(value, fallback);
}

function safeFilename(value: string, fallback = "response.bin"): string {
  const name = basename(value)
    .trim()
    .replace(/[^\w.-]+/gu, "_");
  return name && name !== "." && name !== ".." ? name : fallback;
}

function defaultCallId(): string {
  return `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactMetadataPath(path: string): string {
  return `${path}.caplets.json`;
}

async function writeArtifactMetadata(
  path: string,
  metadata: StoredMediaArtifactMetadata,
): Promise<void> {
  const metadataPath = artifactMetadataPath(path);
  if (!metadata.mimeType) {
    await rm(metadataPath, { force: true });
    return;
  }
  await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
  await chmod(metadataPath, 0o600);
}

function readArtifactMetadata(path: string): StoredMediaArtifactMetadata | undefined {
  const metadataPath = artifactMetadataPath(path);
  if (!existsSync(metadataPath)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch {
    throw new CapletsError("REQUEST_INVALID", "Media artifact metadata is invalid");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CapletsError("REQUEST_INVALID", "Media artifact metadata is invalid");
  }

  const value = parsed as Record<string, unknown>;
  return typeof value.mimeType === "string" && value.mimeType ? { mimeType: value.mimeType } : {};
}
