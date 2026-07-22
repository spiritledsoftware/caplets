import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

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
  const metadata = validatedBundleFileRead(source, options.maxBytes);
  return await readVerifiedBundleFileContent(source, metadata, Buffer.allocUnsafe(metadata.size));
}

export async function readVerifiedBundleFileIntoBuffer(
  source: ReopenableBundleFileSource,
  options: { maxBytes: number; target: Buffer },
): Promise<Buffer> {
  const metadata = validatedBundleFileRead(source, options.maxBytes);
  if (!Buffer.isBuffer(options.target) || options.target.byteLength < metadata.size) {
    throw invalidBundlePayload();
  }
  return await readVerifiedBundleFileContent(source, metadata, options.target);
}
export async function writeVerifiedBundleFile(
  source: ReopenableBundleFileSource,
  options: { maxBytes: number; destination: string },
): Promise<void> {
  const metadata = validatedBundleFileRead(source, options.maxBytes);
  const hash = createHash("sha256");
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      bytes += chunk.byteLength;
      if (bytes > metadata.size) {
        callback(invalidBundlePayload());
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    source.open(),
    verifier,
    createWriteStream(options.destination, {
      flags: "wx",
      mode: metadata.executable ? 0o700 : 0o600,
    }),
  );
  if (bytes !== metadata.size || hash.digest("hex") !== metadata.sha256) {
    throw invalidBundlePayload();
  }
}

async function readVerifiedBundleFileContent(
  source: ReopenableBundleFileSource,
  metadata: Omit<ReopenableBundleFileSource, "open">,
  target: Buffer,
): Promise<Buffer> {
  const content = target.subarray(0, metadata.size);
  const reader = source.open().getReader();
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
      const nextBytes = bytes + chunk.value.byteLength;
      if (nextBytes > metadata.size) {
        throw invalidBundlePayload();
      }
      hash.update(chunk.value);
      content.set(chunk.value, bytes);
      bytes = nextBytes;
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  if (bytes !== metadata.size || hash.digest("hex") !== metadata.sha256) {
    throw invalidBundlePayload();
  }
  return content;
}

function validatedBundleFileRead(
  source: ReopenableBundleFileSource,
  maxBytes: number,
): Omit<ReopenableBundleFileSource, "open"> {
  const metadata = bundleFileMetadata(source);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new CapletsError("REQUEST_INVALID", "The bundle file byte limit is invalid.");
  }
  if (metadata.size > maxBytes) {
    throw invalidBundlePayload();
  }
  return metadata;
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
