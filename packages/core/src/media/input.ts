import { readFileSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { basename } from "node:path";
import { CapletsError } from "../errors";
import { resolveMediaArtifact } from "./artifacts";

export type MediaInput =
  | { path: string; artifact?: never; dataUrl?: never; filename?: string; mimeType?: string }
  | { artifact: string; path?: never; dataUrl?: never; filename?: string; mimeType?: string }
  | { dataUrl: string; path?: never; artifact?: never; filename?: string; mimeType?: string };

export type ResolvedMediaInput = {
  bytes: Buffer;
  filename: string;
  mimeType?: string;
};

const DEFAULT_MAX_MEDIA_BYTES = 100 * 1024 * 1024;

export async function readMediaInput(
  input: unknown,
  options: { artifactRoot?: string; maxBytes?: number; allowLocalPaths?: boolean } = {},
): Promise<ResolvedMediaInput> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new CapletsError("REQUEST_INVALID", "media must be an object");
  }

  const media = input as Record<string, unknown>;
  const sources = ["path", "artifact", "dataUrl"].filter((key) => typeof media[key] === "string");
  if (sources.length !== 1) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "media must define exactly one of path, artifact, or dataUrl",
    );
  }

  const filename = typeof media.filename === "string" ? media.filename : undefined;
  const mimeType = typeof media.mimeType === "string" ? media.mimeType : undefined;

  if (typeof media.path === "string") {
    if (options.allowLocalPaths === false) {
      throw new CapletsError("REQUEST_INVALID", "media.path is not available in this runtime");
    }
    const stat = statMediaFile(media.path);
    enforceSize(stat.size, options.maxBytes);
    return {
      bytes: readMediaFile(media.path),
      filename: filename ?? basename(media.path),
      ...(mimeType ? { mimeType } : {}),
    };
  }

  if (typeof media.artifact === "string") {
    const artifactOptions: { artifactRoot?: string; maxBytes?: number } = {};
    if (options.artifactRoot !== undefined) artifactOptions.artifactRoot = options.artifactRoot;
    artifactOptions.maxBytes = options.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES;
    const artifact = resolveMediaArtifact(media.artifact, artifactOptions);
    if (!artifact.path) {
      throw new CapletsError("REQUEST_INVALID", "Media artifact cannot be read from this runtime");
    }
    const resolvedMimeType = mimeType ?? artifact.mimeType;
    return {
      bytes: readMediaFile(artifact.path),
      filename: filename ?? artifact.filename,
      ...(resolvedMimeType ? { mimeType: resolvedMimeType } : {}),
    };
  }

  const dataUrlOptions: { filename?: string; mimeType?: string; maxBytes?: number } = {};
  if (filename !== undefined) dataUrlOptions.filename = filename;
  if (mimeType !== undefined) dataUrlOptions.mimeType = mimeType;
  if (options.maxBytes !== undefined) dataUrlOptions.maxBytes = options.maxBytes;
  return readDataUrl(media.dataUrl as string, dataUrlOptions);
}

function readDataUrl(
  dataUrl: string,
  options: { filename?: string; mimeType?: string; maxBytes?: number },
): ResolvedMediaInput {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/u.exec(dataUrl);
  if (!match) {
    throw new CapletsError("REQUEST_INVALID", "media.dataUrl must be a base64 data URL");
  }

  const dataMimeType = match[1];
  const base64 = match[2];
  if (!dataMimeType || !base64 || !isStrictBase64(base64)) {
    throw new CapletsError("REQUEST_INVALID", "media.dataUrl must be a base64 data URL");
  }

  enforceSize(decodedBase64Length(base64), options.maxBytes);
  const bytes = Buffer.from(base64, "base64");
  return {
    bytes,
    filename: options.filename ?? "media.bin",
    mimeType: options.mimeType ?? dataMimeType,
  };
}

function isStrictBase64(value: string): boolean {
  return (
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  );
}

function decodedBase64Length(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function statMediaFile(path: string): Stats {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      throw new CapletsError("REQUEST_INVALID", "media.path must reference a file");
    }
    return stat;
  } catch (error) {
    if (error instanceof CapletsError) throw error;
    throw new CapletsError("REQUEST_INVALID", "media.path could not be read");
  }
}

function readMediaFile(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch {
    throw new CapletsError("REQUEST_INVALID", "media file could not be read");
  }
}

function enforceSize(size: number, maxBytes = DEFAULT_MAX_MEDIA_BYTES): void {
  if (size > maxBytes) {
    throw new CapletsError("REQUEST_INVALID", `media exceeds byte limit ${maxBytes}`);
  }
}
