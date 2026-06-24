import type { PackageVersionMetadata } from "./version";
import {
  UPDATE_CHECK_ACCEPT_HEADER,
  UPDATE_CHECK_MAX_RESPONSE_BYTES,
  UPDATE_CHECK_PACKAGE_NAME,
  UPDATE_CHECK_REGISTRY_URL,
} from "./state";

export class UpdateRegistryError extends Error {
  constructor(
    message: string,
    readonly reason: "http" | "timeout" | "invalid" | "network" | "too_large" | "error",
  ) {
    super(message);
    this.name = "UpdateRegistryError";
  }
}

export type FetchUpdateMetadataOptions = {
  fetcher?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs: number;
  maxResponseBytes?: number | undefined;
};

export async function fetchPublicCapletsMetadata(
  options: FetchUpdateMetadataOptions,
): Promise<PackageVersionMetadata> {
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetcher(UPDATE_CHECK_REGISTRY_URL, {
      headers: { accept: UPDATE_CHECK_ACCEPT_HEADER },
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      throw new UpdateRegistryError(`registry responded with ${response.status}`, "http");
    }
    const text = await readBoundedText(response, options.maxResponseBytes);
    const parsed = JSON.parse(text) as unknown;
    return parsePackageMetadata(parsed);
  } catch (error) {
    if (error instanceof UpdateRegistryError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new UpdateRegistryError("registry refresh timed out", "timeout");
    }
    if (error instanceof SyntaxError) {
      throw new UpdateRegistryError("registry response was not valid JSON", "invalid");
    }
    throw new UpdateRegistryError("registry refresh failed", "network");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function parsePackageMetadata(value: unknown): PackageVersionMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UpdateRegistryError("registry metadata was not an object", "invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.name !== UPDATE_CHECK_PACKAGE_NAME) {
    throw new UpdateRegistryError("registry metadata package did not match caplets", "invalid");
  }
  if (!record["dist-tags"] || typeof record["dist-tags"] !== "object") {
    throw new UpdateRegistryError("registry metadata did not include dist-tags", "invalid");
  }
  const distTags = Object.fromEntries(
    Object.entries(record["dist-tags"] as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  if (typeof distTags.latest !== "string") {
    throw new UpdateRegistryError("registry metadata did not include dist-tags.latest", "invalid");
  }
  if (!record.versions || typeof record.versions !== "object" || Array.isArray(record.versions)) {
    throw new UpdateRegistryError("registry metadata did not include versions", "invalid");
  }

  const versions = Object.keys(record.versions);
  if (versions.length === 0) {
    throw new UpdateRegistryError("registry metadata included no versions", "invalid");
  }

  return { packageName: UPDATE_CHECK_PACKAGE_NAME, distTags, versions };
}

async function readBoundedText(
  response: Response,
  maxBytes = UPDATE_CHECK_MAX_RESPONSE_BYTES,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new UpdateRegistryError("registry response was too large", "too_large");
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new UpdateRegistryError("registry response was too large", "too_large");
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new UpdateRegistryError("registry response was too large", "too_large");
      }
      chunks.push(value);
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
