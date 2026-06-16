import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

type StoredMediaArtifactMetadata = {
  mimeType?: string;
};

type ParsedArtifactUri = {
  capletId: string;
  callId: string;
  filename: string;
};

export function artifactUri(capletId: string, callId: string, filename: string): string {
  return `caplets://artifacts/${encodeURIComponent(capletId)}/${encodeURIComponent(
    callId,
  )}/${encodeURIComponent(filename)}`;
}

export async function writeMediaArtifact(input: WriteMediaArtifactInput): Promise<MediaArtifact> {
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
  const uriParts = input.outputPath
    ? uriPartsForOutputPath(rootDir, target)
    : { capletId, callId, filename: safeFilename(basename(target)) };
  const bytes = Buffer.from(input.bytes);

  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, bytes, { mode: 0o600 });
  chmodSync(target, 0o600);

  const artifactFilename = uriParts.filename;
  writeArtifactMetadata(target, input.mimeType ? { mimeType: input.mimeType } : {});
  return {
    uri: artifactUri(uriParts.capletId, uriParts.callId, artifactFilename),
    ...(input.exposeLocalPath === false ? {} : { path: target }),
    filename: artifactFilename,
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
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

function writeArtifactMetadata(path: string, metadata: StoredMediaArtifactMetadata): void {
  const metadataPath = artifactMetadataPath(path);
  if (!metadata.mimeType) {
    rmSync(metadataPath, { force: true });
    return;
  }
  writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
  chmodSync(metadataPath, 0o600);
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
