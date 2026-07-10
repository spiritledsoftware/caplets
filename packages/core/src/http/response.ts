import type { MediaArtifact, MediaArtifactWriter } from "../media/artifacts";
import { createMediaArtifactWriter } from "../media";
import { mediaResultForArtifact, type HttpLikeMediaResult } from "../media/results";
import { CapletsError } from "../errors";
import { DEFAULT_MAX_RESPONSE_BYTES, parseHttpBody } from "./utils";

export type ReadHttpLikeResponseOptions = {
  capletId: string;
  method?: string;
  artifactDir?: string;
  outputPath?: string;
  filename?: string;
  maxInlineBytes?: number;
  maxBytes?: number;
  forceArtifact?: boolean;
  exposeLocalPath?: boolean;
  inspectChunk?: (chunk: Uint8Array) => void;
};

export async function readHttpLikeResponse(
  response: Response,
  options: ReadHttpLikeResponseOptions,
): Promise<HttpLikeMediaResult> {
  const contentType = response.headers.get("content-type") ?? "";
  const mimeType = mimeFromContentType(contentType);
  const maxInlineBytes = options.maxInlineBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const method = options.method?.toUpperCase();
  await rejectOversizedContentLength(response, maxBytes, method);
  if (method === "HEAD") {
    return inlineResponseEnvelope(response, contentType);
  }

  return await readResponseBody(response, options, {
    contentType,
    mimeType,
    maxInlineBytes,
    maxBytes,
    allowInline: !options.forceArtifact && shouldInline(response, mimeType),
  });
}

function inspectResponseBody(contentType: string, bytes: Buffer): unknown {
  return parseHttpBody(contentType, new TextDecoder().decode(bytes));
}

async function readResponseBody(
  response: Response,
  options: ReadHttpLikeResponseOptions,
  settings: {
    contentType: string;
    mimeType: string;
    maxInlineBytes: number;
    maxBytes: number;
    allowInline: boolean;
  },
): Promise<HttpLikeMediaResult> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let writer: MediaArtifactWriter | undefined;
  const inspectChunk = isJsonMime(settings.mimeType) ? options.inspectChunk : undefined;
  try {
    if (!settings.allowInline) {
      writer = await createResponseArtifactWriter(response, options, settings.mimeType);
    }
    while (reader) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      byteLength += value.byteLength;
      if (byteLength > settings.maxBytes) {
        await reader.cancel();
        throw responseExceededLimit(settings.maxBytes);
      }
      if (!writer && byteLength <= settings.maxInlineBytes) {
        chunks.push(value);
        inspectChunk?.(value);
        continue;
      }
      if (!writer) {
        writer = await createResponseArtifactWriter(response, options, settings.mimeType);
        for (const chunk of chunks) {
          await writer.write(chunk);
        }
        chunks.length = 0;
      }
      await writer.write(value);
      inspectChunk?.(value);
    }
    if (writer) {
      return artifactResponseEnvelope(response, settings.contentType, await writer.complete());
    }
    return inlineResponseEnvelope(
      response,
      settings.contentType,
      inspectResponseBody(settings.contentType, Buffer.concat(chunks)),
    );
  } catch (error) {
    await reader?.cancel().catch(() => {});
    await writer?.abort().catch(() => {});
    throw error;
  }
}

async function createResponseArtifactWriter(
  response: Response,
  options: ReadHttpLikeResponseOptions,
  mimeType: string,
): Promise<MediaArtifactWriter> {
  return await createMediaArtifactWriter({
    capletId: options.capletId,
    ...(options.artifactDir ? { rootDir: options.artifactDir } : {}),
    ...(response.ok && options.outputPath ? { outputPath: options.outputPath } : {}),
    ...(options.exposeLocalPath === false ? { exposeLocalPath: false } : {}),
    suggestedFilename:
      options.filename ?? filenameFromContentDisposition(response) ?? "response.bin",
    ...(mimeType ? { mimeType } : {}),
  });
}

async function rejectOversizedContentLength(
  response: Response,
  maxBytes: number,
  method?: string,
): Promise<void> {
  if (method === "HEAD") return;
  const contentLength = response.headers.get("content-length");
  if (!contentLength) return;
  const byteLength = Number.parseInt(contentLength, 10);
  if (Number.isFinite(byteLength) && byteLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw responseExceededLimit(maxBytes);
  }
}

function responseExceededLimit(maxBytes: number): CapletsError {
  return new CapletsError(
    "DOWNSTREAM_PROTOCOL_ERROR",
    `HTTP response exceeded byte limit ${maxBytes}`,
  );
}

function inlineResponseEnvelope(
  response: Response,
  contentType: string,
  body?: unknown,
): HttpLikeMediaResult {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "content-type": contentType,
    },
    kind: "inline",
    ...(body === undefined ? {} : { body }),
  };
}

function artifactResponseEnvelope(
  response: Response,
  contentType: string,
  artifact: MediaArtifact,
): HttpLikeMediaResult {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "content-type": contentType,
    },
    ...mediaResultForArtifact(artifact),
  };
}

function shouldInline(response: Response, mimeType: string): boolean {
  if (isAttachment(response)) {
    return false;
  }
  return mimeType === "" || isJsonMime(mimeType) || mimeType.startsWith("text/");
}

function isJsonMime(mimeType: string): boolean {
  return (
    mimeType === "application/json" || mimeType.endsWith("+json") || mimeType.endsWith("/json")
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

export type { HttpLikeMediaResult };
