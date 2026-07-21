import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { CapletsError } from "../errors";

export type ReopenableBundleFileSource = {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
  open(): ReadableStream<Uint8Array>;
};

export type BufferBundleFileInput = {
  path: string;
  content: Buffer;
  executable: boolean;
};

export type StagedBundleFileInput = {
  path: string;
  stagedPath: string;
  size: number;
  sha256: string;
  executable: boolean;
};

export function bufferBundleFileSource(input: BufferBundleFileInput): ReopenableBundleFileSource {
  const metadata = bundleFileMetadata({
    path: input.path,
    size: input.content.byteLength,
    sha256: createHash("sha256").update(input.content).digest("hex"),
    executable: input.executable,
  });
  return {
    ...metadata,
    open: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new Uint8Array(
              input.content.buffer,
              input.content.byteOffset,
              input.content.byteLength,
            ),
          );
          controller.close();
        },
      }),
  };
}

export function stagedBundleFileSource(input: StagedBundleFileInput): ReopenableBundleFileSource {
  const metadata = bundleFileMetadata(input);
  if (!input.stagedPath) {
    throw new CapletsError("REQUEST_INVALID", "A staged bundle source path is required.");
  }
  return {
    ...metadata,
    open: () => Readable.toWeb(createReadStream(input.stagedPath)) as ReadableStream<Uint8Array>,
  };
}

export async function readVerifiedBundleFile(
  source: ReopenableBundleFileSource,
  options: { maxBytes: number },
): Promise<Buffer> {
  const metadata = bundleFileMetadata(source);
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new CapletsError("REQUEST_INVALID", "The bundle file byte limit is invalid.");
  }
  if (metadata.size > options.maxBytes) {
    throw invalidBundlePayload();
  }

  const reader = source.open().getReader();
  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let bytes = 0;
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        complete = true;
        break;
      }
      if (!(chunk.value instanceof Uint8Array)) {
        throw invalidBundlePayload();
      }
      bytes += chunk.value.byteLength;
      if (bytes > options.maxBytes || bytes > metadata.size) {
        throw invalidBundlePayload();
      }
      const buffer = Buffer.from(
        chunk.value.buffer,
        chunk.value.byteOffset,
        chunk.value.byteLength,
      );
      hash.update(buffer);
      chunks.push(buffer);
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  if (bytes !== metadata.size || hash.digest("hex") !== metadata.sha256) {
    throw invalidBundlePayload();
  }
  return chunks.length === 1 ? Buffer.from(chunks[0]!) : Buffer.concat(chunks, bytes);
}

function bundleFileMetadata(
  input: Pick<ReopenableBundleFileSource, "path" | "size" | "sha256" | "executable">,
): Omit<ReopenableBundleFileSource, "open"> {
  if (
    typeof input.path !== "string" ||
    input.path.length === 0 ||
    !Number.isSafeInteger(input.size) ||
    input.size < 0 ||
    !/^[a-f0-9]{64}$/u.test(input.sha256) ||
    typeof input.executable !== "boolean"
  ) {
    throw new CapletsError("REQUEST_INVALID", "Caplet Bundle file metadata is invalid.");
  }
  return {
    path: input.path,
    size: input.size,
    sha256: input.sha256,
    executable: input.executable,
  };
}

function invalidBundlePayload(): CapletsError {
  return new CapletsError(
    "REQUEST_INVALID",
    "A Caplet Bundle file does not match its declared size or hash.",
  );
}
