import { createHash, randomUUID, type Hash } from "node:crypto";

import { CapletsError } from "../errors";
import { validateBundlePathSet } from "../storage/bundle-path";
import type { ReopenableBundleFileSource } from "../storage/bundle-source";

export type BundleMultipartStream = {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  boundary: string;
};

export function createBundleMultipartStream(
  inputSources: readonly ReopenableBundleFileSource[],
  options: { boundary?: string | undefined } = {},
): BundleMultipartStream {
  if (inputSources.length === 0) {
    throw new CapletsError("REQUEST_INVALID", "A Caplet Bundle must contain files.");
  }
  const boundary = validBoundary(options.boundary ?? `caplets-${randomUUID()}`);
  const paths = validateBundlePathSet(inputSources.map((source) => source.path));
  const sources = inputSources.map((source, index) => validatedSource(source, paths[index]!));
  const manifest = JSON.stringify({
    version: 1,
    files: sources.map(({ path, size, sha256, executable }) => ({
      path,
      size,
      sha256,
      executable,
    })),
  });
  const producer = new MultipartProducer(sources, boundary, manifest);
  return {
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await producer.next();
          if (chunk === undefined) controller.close();
          else controller.enqueue(chunk);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await producer.cancel(reason);
      },
    }),
    contentType: `multipart/mixed; boundary=${boundary}`,
    boundary,
  };
}

class MultipartProducer {
  private state: "manifest" | "source_header" | "source_body" | "done" = "manifest";
  private sourceIndex = 0;
  private reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private hash: Hash | undefined;
  private size = 0;
  private reading = false;
  private cancelled = false;

  constructor(
    private readonly sources: readonly ReopenableBundleFileSource[],
    private readonly boundary: string,
    private readonly manifest: string,
  ) {}

  async next(): Promise<Uint8Array | undefined> {
    if (this.cancelled || this.state === "done") return undefined;
    if (this.state === "manifest") {
      this.state = "source_header";
      return bytes(
        `--${this.boundary}\r\nContent-Disposition: inline; name="manifest"\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${this.manifest}\r\n`,
      );
    }
    if (this.state === "source_header") {
      if (this.sourceIndex >= this.sources.length) {
        this.state = "done";
        return bytes(`--${this.boundary}--\r\n`);
      }
      const source = this.sources[this.sourceIndex]!;
      this.reader = source.open().getReader();
      this.hash = createHash("sha256");
      this.size = 0;
      this.state = "source_body";
      return bytes(
        `--${this.boundary}\r\nContent-Disposition: attachment; name="file"; filename="file-${this.sourceIndex + 1}"\r\nContent-Type: application/octet-stream\r\nContent-Length: ${source.size}\r\n\r\n`,
      );
    }

    const source = this.sources[this.sourceIndex]!;
    try {
      this.reading = true;
      const chunk = await this.reader!.read();
      this.reading = false;
      if (this.cancelled) {
        await this.finishReader(false);
        return undefined;
      }
      if (!chunk.done) {
        if (!(chunk.value instanceof Uint8Array)) throw bundleIntegrityError(source.path);
        this.size += chunk.value.byteLength;
        if (this.size > source.size) throw bundleIntegrityError(source.path);
        this.hash!.update(chunk.value);
        return chunk.value;
      }
      if (this.size !== source.size || this.hash!.digest("hex") !== source.sha256) {
        throw bundleIntegrityError(source.path);
      }
      await this.finishReader(false);
      this.sourceIndex += 1;
      this.state = "source_header";
      return bytes("\r\n");
    } catch (error) {
      this.reading = false;
      await this.finishReader(true);
      throw error;
    }
  }

  async cancel(reason?: unknown): Promise<void> {
    this.cancelled = true;
    const reader = this.reader;
    if (!reader) return;
    await reader.cancel(reason).catch(() => undefined);
    if (!this.reading && this.reader === reader) {
      this.reader = undefined;
      reader.releaseLock();
    }
  }

  private async finishReader(cancel: boolean): Promise<void> {
    const reader = this.reader;
    this.reader = undefined;
    if (!reader) return;
    if (cancel) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function validatedSource(
  source: ReopenableBundleFileSource,
  normalizedPath: string,
): ReopenableBundleFileSource {
  if (
    !Number.isSafeInteger(source.size) ||
    source.size < 0 ||
    !/^[a-f0-9]{64}$/u.test(source.sha256) ||
    typeof source.executable !== "boolean" ||
    typeof source.open !== "function"
  ) {
    throw new CapletsError("REQUEST_INVALID", "Caplet Bundle file metadata is invalid.");
  }
  return { ...source, path: normalizedPath };
}

function validBoundary(value: string): string {
  if (value.length === 0 || value.length > 70 || !/^[A-Za-z0-9'()+_,./:=?-]+$/u.test(value)) {
    throw new CapletsError("REQUEST_INVALID", "Multipart boundary is invalid.");
  }
  return value;
}

function bundleIntegrityError(path: string): CapletsError {
  return new CapletsError(
    "REQUEST_INVALID",
    `Caplet Bundle file ${path} does not match its declared size or hash.`,
  );
}

const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}
