import type { MediaArtifact } from "../media";
import { CapletsError } from "../errors";
import { writeMediaArtifact } from "../media";
import { DEFAULT_MAX_RESPONSE_BYTES, parseHttpBody } from "./utils";

export type ReadHttpLikeResponseOptions = {
  capletId: string;
  artifactDir?: string;
  outputPath?: string;
  filename?: string;
  maxInlineBytes?: number;
  maxBytes?: number;
};

export async function readHttpLikeResponse(
  response: Response,
  options: ReadHttpLikeResponseOptions,
): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") ?? "";
  const mimeType = mimeFromContentType(contentType);
  const maxInlineBytes = options.maxInlineBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  rejectOversizedContentLength(response, maxBytes);

  if (shouldInline(response, mimeType)) {
    const inline = await readInlineCandidate(response, { maxInlineBytes, maxBytes });
    if (!inline.exceeded) {
      const body = parseHttpBody(contentType, new TextDecoder().decode(inline.bytes));
      return responseEnvelope(response, contentType, body);
    }
    const artifact = await writeResponseArtifact(response, options, mimeType, inline.bytes);
    return responseEnvelope(response, contentType, { artifact });
  }

  const bytes = await readBoundedBytes(response, maxBytes);
  const artifact = await writeResponseArtifact(response, options, mimeType, bytes);
  return responseEnvelope(response, contentType, { artifact });
}

async function readInlineCandidate(
  response: Response,
  options: { maxInlineBytes: number; maxBytes: number },
): Promise<{ bytes: Buffer; exceeded: boolean }> {
  if (!response.body) {
    return { bytes: Buffer.alloc(0), exceeded: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let exceeded = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      bytes += value.byteLength;
      if (bytes > options.maxBytes) {
        await reader.cancel();
        throw responseExceededLimit(options.maxBytes);
      }
      if (bytes > options.maxInlineBytes) exceeded = true;
      chunks.push(value);
    }
  }
  return { bytes: Buffer.concat(chunks), exceeded };
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    return Buffer.alloc(0);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw responseExceededLimit(maxBytes);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

function rejectOversizedContentLength(response: Response, maxBytes: number): void {
  const contentLength = response.headers.get("content-length");
  if (!contentLength) return;
  const byteLength = Number.parseInt(contentLength, 10);
  if (Number.isFinite(byteLength) && byteLength > maxBytes) {
    throw responseExceededLimit(maxBytes);
  }
}

function responseExceededLimit(maxBytes: number): CapletsError {
  return new CapletsError(
    "DOWNSTREAM_PROTOCOL_ERROR",
    `HTTP response exceeded byte limit ${maxBytes}`,
  );
}

async function writeResponseArtifact(
  response: Response,
  options: ReadHttpLikeResponseOptions,
  mimeType: string,
  bytes: Buffer,
): Promise<MediaArtifact> {
  return await writeMediaArtifact({
    capletId: options.capletId,
    ...(options.artifactDir ? { rootDir: options.artifactDir } : {}),
    ...(options.outputPath ? { outputPath: options.outputPath } : {}),
    suggestedFilename:
      options.filename ?? filenameFromContentDisposition(response) ?? "response.bin",
    ...(mimeType ? { mimeType } : {}),
    bytes,
  });
}

function responseEnvelope(
  response: Response,
  contentType: string,
  body?: unknown,
): Record<string, unknown> {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "content-type": contentType,
    },
    ...(body === undefined ? {} : { body }),
  };
}

function shouldInline(response: Response, mimeType: string): boolean {
  if (isAttachment(response)) {
    return false;
  }
  return (
    mimeType === "" ||
    mimeType === "application/json" ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("/json") ||
    mimeType.startsWith("text/")
  );
}

function isAttachment(response: Response): boolean {
  return /\battachment\b/iu.test(response.headers.get("content-disposition") ?? "");
}

function mimeFromContentType(contentType: string): string {
  return contentType.split(";")[0]?.toLowerCase().trim() ?? "";
}

function filenameFromContentDisposition(response: Response): string | undefined {
  const contentDisposition = response.headers.get("content-disposition");
  if (!contentDisposition) {
    return undefined;
  }
  return parseRfc5987Filename(contentDisposition) ?? parseQuotedFilename(contentDisposition);
}

function parseRfc5987Filename(contentDisposition: string): string | undefined {
  const match = /(?:^|;)\s*filename\*=([^;]+)/iu.exec(contentDisposition);
  const value = match?.[1]?.trim();
  if (!value) {
    return undefined;
  }
  const encoded = value.replace(/^UTF-8''/iu, "");
  try {
    return decodeURIComponent(encoded.replace(/^"|"$/gu, ""));
  } catch {
    return encoded;
  }
}

function parseQuotedFilename(contentDisposition: string): string | undefined {
  const quoted = /(?:^|;)\s*filename="([^"]+)"/iu.exec(contentDisposition)?.[1];
  if (quoted) {
    return quoted;
  }
  return /(?:^|;)\s*filename=([^;]+)/iu.exec(contentDisposition)?.[1]?.trim();
}

export type { MediaArtifact };
