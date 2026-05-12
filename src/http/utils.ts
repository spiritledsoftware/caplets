import { CapletsError } from "../errors.js";

export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export function parseHttpBody(contentType: string, text: string): unknown {
  if (!text) {
    return undefined;
  }
  const mime = contentType.split(";")[0]?.toLowerCase().trim() ?? "";
  if (mime !== "application/json" && !mime.endsWith("+json") && !mime.endsWith("/json")) {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function readLimitedText(
  response: Response,
  options: { maxBytes?: number; errorMessage: string },
): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      bytes += value.byteLength;
      if (bytes > (options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES)) {
        await reader.cancel();
        throw new CapletsError("DOWNSTREAM_PROTOCOL_ERROR", options.errorMessage);
      }
      chunks.push(value);
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
